# pg_upgrade — Major Version In-Place Upgrade

In-place major-version upgrade of PostgreSQL cluster. Skips full dump/reload by reusing data files. Fast (`--link` mode = seconds for TB-scale) but operationally exacting.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Command Invocation](#command-invocation)
    - [Transfer Modes](#transfer-modes)
    - [--check Mode](#--check-mode)
    - [Prerequisites](#prerequisites)
    - [What Gets Preserved](#what-gets-preserved)
    - [What Does NOT Get Migrated](#what-does-not-get-migrated)
    - [reg* OID-Referencing Types Block Upgrade](#reg-oid-referencing-types-block-upgrade)
    - [Cross-Version + Cross-Platform Rules](#cross-version--cross-platform-rules)
    - [Logical Replication Slot Preservation](#logical-replication-slot-preservation)
    - [Statistics Preservation (PG18+)](#statistics-preservation-pg18)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick this file when:

- Upgrading PostgreSQL cluster from major N to N+M in place.
- Choosing between `--copy` / `--clone` / `--link` / `--swap` (PG18+) transfer modes.
- Running `--check` pre-flight before scheduled maintenance window.
- Auditing what pg_upgrade does NOT migrate (custom GUCs, `archive_command`, `pg_hba.conf`, statistics pre-PG18, replication slots on pre-PG17 sources).
- Planning post-upgrade `ANALYZE` strategy for old + new clusters.
- Inspecting cross-version restrictions (e.g., `reg*` column types blocking upgrade).
- Preserving logical replication slots and subscriptions across upgrade (PG17+ sources only).

Pick different file when:

- Zero-downtime upgrade required → [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) covers logical-replication-based blue/green.
- Logical backup + restore → [`83-backup-pg-dump.md`](./83-backup-pg-dump.md).
- Re-syncing diverged former primary → [`89-pg-rewind.md`](./89-pg-rewind.md).
- DR / cross-region failover runbook → [`90-disaster-recovery.md`](./90-disaster-recovery.md).

## Mental Model

Five rules.

**Rule 1 — pg_upgrade ≠ dump/restore. Reuses data files via OID preservation, not SQL replay.** Old cluster's data directory referenced (in `--copy` mode) or moved into place (in `--link` / `--clone` / `--swap` modes). Catalog schema migrated via `pg_dump` of catalog only. Heap files reused as-is once relfilenode + tablespace + database OIDs preserved (since PG15 — verbatim "Make pg_upgrade preserve tablespace and database OIDs, as well as relation relfilenode numbers")[^pg15-oid]. TB-scale upgrade completes in seconds in `--link` mode.

**Rule 2 — Both clusters must be shut down cleanly before invocation.** Not a hot upgrade. Schedule downtime window. `--check` mode is the only flag that runs against a live old cluster.

**Rule 3 — Statistics reset (pre-PG18) OR preserved (PG18+) — extended statistics never preserved.** Pre-PG18: planner statistics in `pg_statistic` reset, must run `vacuumdb --all --analyze-in-stages` after upgrade or query plans regress for hours/days. PG18+: per-column statistics preserved automatically. Verbatim PG18 release-note: *"Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation."*[^pg18-stats] Operational consequence: PG18+ still requires `vacuumdb --all --analyze-only --analyze-in-stages` for *extended* stats (those created via `CREATE STATISTICS`) and for cumulative-vacuum thresholds.

**Rule 4 — Logical replication slots transferred only when source ≥ PG17.** PG17 introduced slot+subscription migration (Hayato Kuroda et al.). Verbatim docs: *"This only works for old PostgreSQL clusters that are version 17 or later."*[^pg17-slots] Upgrading FROM PG14/15/16 → ANY target = slot state lost, applications must recreate slots + reset subscribers' replication origin manually. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).

**Rule 5 — pg_upgrade does NOT migrate `pg_hba.conf`, custom GUCs, `archive_command`, scheduled jobs, or extension binaries.** All operational configuration outside `$PGDATA/pg_*` system files must be copied manually OR baked into deployment automation. Verify before declaring upgrade complete.

> [!WARNING] PG18 watershed — statistics preserved but NOT extended statistics
> If you upgrade FROM any version TO PG18+: per-column planner statistics survive the upgrade. Extended statistics (`CREATE STATISTICS`) do NOT. Post-upgrade procedure shifts but does not vanish:
>
> 1. Run `vacuumdb --all --analyze-in-stages --missing-stats-only` (PG18+ — generates minimal stats for relations without any, e.g., extended-stats objects).
> 2. Then run `vacuumdb --all --analyze-only` (refreshes cumulative stats for triggering autovacuum/autoanalyze).
>
> Pre-PG18 upgrades (TO PG17 or earlier): full `vacuumdb --all --analyze-in-stages` mandatory. See [Statistics Preservation](#statistics-preservation-pg18) for verbatim docs procedure.

> [!WARNING] pg_upgrade executes arbitrary code from source cluster
> Verbatim docs: *"Upgrading a cluster causes the destination to execute arbitrary code of the source superusers' choice. Ensure that the source superusers are trusted before upgrading."*[^pg-security] Operational: don't run pg_upgrade against untrusted source data dirs. Same trust boundary as restoring untrusted `pg_dump`.

## Decision Matrix

13 rows routing common operational decisions.

| Need | Use | Avoid | Why |
|---|---|---|---|
| Standard upgrade with downtime window OK | `--copy` (default) | n/a | Safest; old cluster remains usable on failure. |
| Fastest upgrade, accept old-cluster-becomes-unusable | `--link` | `--copy` for TB-scale during tight window | Hard-links files; near-instant. Old cluster cannot restart after new cluster starts. |
| Same filesystem + reflink-capable FS (Btrfs/XFS/APFS) | `--clone` | `--link` (if rollback wanted) | Copy-on-write clones; near-instant + old cluster stays intact. |
| PG18+, want potentially fastest mode | `--swap` (PG18+) | older modes | Swaps directories rather than copying/linking/cloning. Verbatim PG18 release-note[^pg18-swap]. |
| Verify upgrade will succeed without committing | `--check` | actual upgrade attempt blind | Read-only pre-flight; can run against live old cluster. |
| Multi-CPU parallel upgrade | `--jobs N` | serial when migrating many databases or large tablespaces | Per-database parallelism. |
| Source ≥ PG17, want to preserve logical slots | upgrade as normal | manually recreating slots after | Slots migrate automatically (PG17+ only)[^pg17-slots]. |
| Source ≤ PG16, want to preserve replication | logical replication blue/green | pg_upgrade for replication continuity | pg_upgrade cannot migrate slots from pre-PG17. Cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md). |
| PG18+ target, skip stats preservation (testing) | `--no-statistics` | running ANALYZE post-upgrade redundantly | Reverts to pre-PG18 behavior. Verbatim docs[^pg18-stats]. |
| Test upgrade procedure | spin disposable host, run `--check` + actual upgrade | running directly on production | Practice the runbook end-to-end. |
| Cross-platform (Linux → Windows etc.) | dump + restore via [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) | pg_upgrade | pg_upgrade requires same architecture + endianness. |
| Reduce post-upgrade ANALYZE time | `vacuumdb --all --analyze-in-stages --jobs=$(nproc)` | single-threaded `ANALYZE` | Parallelizes across databases. |
| Sub-second cutover | logical replication blue/green | pg_upgrade with `--link` | pg_upgrade still requires both clusters stopped. |

Three smell signals — wrong tool for the job:

- **Sub-30-second cutover requirement.** pg_upgrade can't deliver. Route to [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) logical-replication blue/green pattern.
- **Cross-architecture upgrade (x86_64 → arm64, or 32-bit → 64-bit).** pg_upgrade reuses byte layout; must use dump+restore.
- **No backup before pg_upgrade.** `--copy` mode is non-destructive but `--link` / `--clone` / `--swap` can leave the old cluster unrecoverable. Always take a base backup (cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md)) before upgrading.

## Syntax / Mechanics

### Command Invocation

```bash
# Standard form. Both clusters must be stopped.
pg_upgrade \
    --old-datadir=/var/lib/pgsql/16/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-16/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --jobs=8 \
    --link
```

Run as the OS user that owns the data directory (usually `postgres`). Working directory matters — pg_upgrade writes log files under `pg_upgrade_output.d/` (PG15+ — verbatim "Store pg_upgrade's log and temporary files in a subdirectory of the new cluster called `pg_upgrade_output.d`")[^pg15-logdir]. Run from a writable working directory; PG15+ auto-cleans this dir on success.

Required flags:

| Flag | Purpose |
|---|---|
| `--old-datadir` / `-d` | Source cluster `$PGDATA` |
| `--new-datadir` / `-D` | Target cluster `$PGDATA` (must be initdb'd already) |
| `--old-bindir` / `-b` | Source cluster binaries directory |
| `--new-bindir` / `-B` | Target cluster binaries directory |

Optional flags:

| Flag | Purpose | Notes |
|---|---|---|
| `--check` / `-c` | Pre-flight only; no changes | Can run on live source cluster |
| `--link` / `-k` | Hard-link mode | Source becomes unusable post-upgrade |
| `--clone` | Reflink mode | Btrfs/XFS/APFS only; both clusters survive |
| `--copy` | Default | Full byte copy; both clusters survive |
| `--swap` | Directory swap (PG18+)[^pg18-swap] | Potentially fastest |
| `--copy-file-range` | Linux + FreeBSD optimized copy (PG17+, Thomas Munro)[^pg17-cfr] | Falls back to `--copy` elsewhere |
| `--sync-method=fsync|syncfs` | File sync method (PG17+) | `syncfs` faster on Linux |
| `--no-sync` (PG15+, Michael Paquier)[^pg15-nosync] | Skip fsync (testing only) | Never use in production |
| `--no-statistics` (PG18+)[^pg18-stats] | Skip statistics transfer | Reverts to pre-PG18 behavior |
| `--jobs N` / `-j N` | Parallel database migration | One worker per database |
| `--verbose` / `-v` | Verbose logging | Diagnostic |

### Transfer Modes

Four modes (PG18+) — pick by speed vs reversibility trade-off.

| Mode | Speed | Old cluster after | Filesystem constraint | Available since |
|---|---|---|---|---|
| `--copy` (default) | Slow (byte copy) | Intact | Any | All versions |
| `--link` (`-k`) | Near-instant | **Unusable** | Same filesystem for `$PGDATA`; tablespaces + `pg_wal` may differ | All versions |
| `--clone` | Near-instant | Intact | Same filesystem; Btrfs/XFS-with-reflink on Linux ≥4.5, APFS on macOS | PG12+ |
| `--swap` | Potentially fastest | Directories renamed | Same filesystem | PG18+[^pg18-swap] |

Verbatim docs on `--link`: *"Use hard links instead of copying files to the new cluster. Advantages: Much faster upgrade (no file copying), uses less disk space. Disadvantages: Old cluster becomes inaccessible once new cluster starts; requires old and new cluster data directories be in the same file system (tablespaces and `pg_wal` can be on different file systems)."*[^pgupgrade-docs]

Verbatim docs on `--clone`: *"Use efficient file cloning (also known as 'reflinks') instead of copying files to the new cluster. Advantages: Near-instantaneous copying of data files; speed advantages of `--link` while leaving the old cluster untouched. Limitations: Only supported on Linux (kernel 4.5 or later) with Btrfs and XFS (on file systems created with reflink support); macOS with APFS. Requirements: Old and new data directories must be in the same file system."*[^pgupgrade-docs]

> [!NOTE] PostgreSQL 18 `--swap` option
> Verbatim release-note: *"New `--swap` option: Swap directories rather than copy/clone/link files (potentially fastest method)."*[^pg18-swap] Tradeoff: same-filesystem constraint, source dir gets renamed.

### --check Mode

Pre-flight validation without mutation. Verbatim docs: *"The `--check` flag performs cluster compatibility verification without modifying data. Can be used even if the old server is still running. Verifies the two clusters are compatible. Outlines manual adjustments needed after upgrade. Useful with `--link` or `--clone` options to enable mode-specific checks. Old cluster remains unmodified and can be restarted."*[^pgupgrade-docs]

Always run `--check` *before* the maintenance window:

```bash
pg_upgrade \
    --old-datadir=/var/lib/pgsql/16/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-16/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --check
```

Catches:

- Missing extensions in the new cluster (binaries not installed → cross-reference [`69-extensions.md`](./69-extensions.md))
- Columns with disallowed `reg*` OID-referencing types (see below)
- Schema collisions, role mismatches
- Authentication file readability
- Disk-space estimate for non-`--link` modes
- WAL-level / max_replication_slots mismatch when migrating slots (PG17+ source)

Run `--check` against the source cluster while it's still serving traffic. The target cluster must be initdb'd but not running.

### Prerequisites

Both clusters: stopped cleanly via `pg_ctl stop -m fast` or `systemctl stop postgresql-N`. **Verbatim docs: "Stop both servers before running pg_upgrade."**[^pgupgrade-docs]

Same superuser between source and target (typically `postgres` OS user owns both data dirs).

Target cluster: must already be `initdb`'d with compatible settings:

- **Same encoding** (PG ≤15 required; PG16+ pg_upgrade automatically sets new cluster's locale and encoding — verbatim "Have pg_upgrade set the new cluster's locale and encoding (Jeff Davis)")[^pg16-locale].
- **Same `--data-checksums` flag** as source. If source has checksums, target must too. Source without checksums + target with checksums = `--check` fails.
- **Same `--wal-segsize`** if source was initdb'd with non-default segment size.
- **Empty target** (no user data; just system catalog from `initdb`).

Supported upgrade range: source ≥ PG 9.2. Verbatim docs: *"Upgrades from 9.2.X and later to the current major release of PostgreSQL, including snapshot and beta releases."*[^pgupgrade-docs]

### What Gets Preserved

- **Data files** — heaps, indexes, materialized views, sequences, TOAST tables.
- **OIDs** for tablespaces, databases, relations (relfilenode) — PG15+ guaranteed[^pg15-oid].
- **`postgresql.auto.conf`** contents (carried into new cluster's auto.conf).
- **PG17+ source only:** logical replication slots and subscriptions[^pg17-slots]. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).
- **PG18+ target only:** per-column planner statistics (`pg_statistic`)[^pg18-stats]. Extended statistics still not preserved.

### What Does NOT Get Migrated

Operational gap list — verify each:

- **`pg_hba.conf`** — must be copied/recreated on new cluster manually. Cross-reference [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md).
- **`postgresql.conf`** — pg_upgrade does NOT merge. New cluster uses whatever `initdb` produced unless you copy/edit old config first. Custom GUCs not preserved.
- **`pg_ident.conf`** — same as pg_hba.conf.
- **`archive_command` / `archive_library`** — replicate these into new `postgresql.conf` before starting the new cluster, or your WAL archive pipeline breaks silently. Cross-reference [`33-wal.md`](./33-wal.md).
- **Cumulative statistics** (`pg_stat_*` views' counters) — reset to zero.
- **Replication slots from pre-PG17 sources** — must be recreated post-upgrade.
- **Extended statistics** (objects defined via `CREATE STATISTICS`) — recreated automatically but underlying data is reset; rerun `ANALYZE` even on PG18+.
- **`pg_stat_statements` data** — extension catalog migrates but accumulated counters reset. Cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md).
- **Scheduled jobs** (pg_cron, pg_partman maintenance) — recreate via your deployment automation; cron tables migrate as data, but `cron.job_run_details` history resets. Cross-reference [`98-pg-cron.md`](./98-pg-cron.md), [`99-pg-partman.md`](./99-pg-partman.md).

### reg* OID-Referencing Types Block Upgrade

Columns using these `reg*` types fail `--check`:

| Type | Allowed in pg_upgrade? |
|---|---|
| `regcollation` | ❌ No |
| `regconfig` | ❌ No |
| `regdictionary` | ❌ No |
| `regnamespace` | ❌ No |
| `regoper` | ❌ No |
| `regoperator` | ❌ No |
| `regproc` | ❌ No |
| `regprocedure` | ❌ No |
| `regclass` | ✅ Yes |
| `regrole` | ✅ Yes |
| `regtype` | ✅ Yes |

Verbatim docs: *"Cannot Upgrade Columns Using These reg* OID-Referencing System Data Types"*[^pgupgrade-docs] — followed by the eight blocked types above.

Reason: the disallowed types reference catalog objects whose OIDs may renumber across major versions. The three allowed types (`regclass`, `regrole`, `regtype`) reference relation/role/type OIDs that pg_upgrade explicitly preserves.

Workaround: `ALTER TABLE ... ALTER COLUMN ... TYPE text USING col::text` before upgrade, then convert back after. Or use a logical-replication-based upgrade (cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md)).

### Cross-Version + Cross-Platform Rules

| Constraint | Rule |
|---|---|
| Source major version | ≥ PG 9.2 |
| Target major version | Any newer major (e.g., 14 → 18 is one hop) |
| Same architecture | Required (e.g., x86_64 → x86_64; cross-arch not supported) |
| Same endianness | Required |
| Same operating-system family | Required (e.g., Linux → Linux; cross-OS not supported) |
| Same `--data-checksums` setting | Required between source + target |
| Same `--wal-segsize` | Required if non-default |
| Same locale | Required pre-PG16; PG16+ pg_upgrade sets target's locale to match source automatically[^pg16-locale] |
| Same encoding | Same as locale — PG16+ flexibility[^pg16-locale] |

For cross-architecture, cross-OS, or cross-endianness upgrades: dump + restore is the only path. Use logical replication for near-zero downtime (cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md)).

### Logical Replication Slot Preservation

PG17 added logical-slot migration. Two layered rules.

Verbatim PG17 release-note: *"Have pg_upgrade migrate valid logical slots and subscriptions (Hayato Kuroda, Hou Zhijie, Vignesh C, Julien Rouhaud, Shlok Kyal). This allows logical replication to continue quickly after the upgrade. This only works for old PostgreSQL clusters that are version 17 or later."*[^pg17-slots]

Verbatim PG18 docs on standby slot rules: *"If the old primary is prior to version 17.0, then no slots on the primary are copied to the new standby, so all the slots on the old standby must be recreated manually. If the old primary is version 17.0 or later, then only logical slots on the primary are copied to the new standby, but other slots on the old standby are not copied, so must be recreated manually."*[^pg18-slots]

Prerequisites for slot/subscription migration (source ≥ PG17):

- `wal_level=logical` set on new cluster.
- `max_replication_slots` ≥ number of slots in old cluster.
- All output plugins installed in new cluster (same `.so` files).
- All transactions replicated to subscribers before upgrade (no unreplicated work in slot's `restart_lsn`).
- No conflicting slot names on new cluster.
- No permanent slots already present on new cluster.

If any prereq fails → `--check` errors with explicit message naming the slot.

For pre-PG17 sources: slots cannot be migrated. Subscribers must be paused, slot state captured (via `pg_replication_slots`), slots recreated on new cluster with matching `confirmed_flush_lsn`, subscribers reattached. This is operationally fragile — prefer logical-replication-based blue/green upgrade for clusters with critical replication slots.

### Statistics Preservation (PG18+)

PG18 added per-column planner statistics preservation. Operational watershed for upgrade-time outage budget.

Verbatim PG18 release-note: *"Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation."*[^pg18-stats]

Verbatim PG18 post-upgrade procedure: *"Because not all statistics are transferred by `pg_upgrade`, you will be instructed to run commands to regenerate that information at the end of the upgrade. First, use `vacuumdb --all --analyze-in-stages --missing-stats-only` to quickly generate minimal optimizer statistics for relations without any. Then, use `vacuumdb --all --analyze-only` to ensure all relations have updated cumulative statistics for triggering vacuum and analyze."*[^pgupgrade-docs]

Decision table:

| Source version | Target version | Per-column stats preserved? | Extended stats preserved? | Post-upgrade ANALYZE required? |
|---|---|---|---|---|
| Any | ≤ PG17 | ❌ No | ❌ No | Yes — full `vacuumdb --all --analyze-in-stages` |
| Any | PG18+ (default) | ✅ Yes | ❌ No | Reduced — `vacuumdb --all --analyze-in-stages --missing-stats-only` for extended stats + `vacuumdb --all --analyze-only` for cumulative |
| Any | PG18+ with `--no-statistics` | ❌ No | ❌ No | Same as pre-PG18 target |

Cross-reference [`55-statistics-planner.md`](./55-statistics-planner.md) for what's in `pg_statistic` vs `pg_statistic_ext_data`.

### Per-Version Timeline

| Version | pg_upgrade changes |
|---|---|
| PG14 | Removed `analyze_new_cluster` script in favor of `vacuumdb` instructions (Magnus Hagander)[^pg14-analyze]. Warns when dumping postfix operators[^pg14-postfix]. |
| PG15 | **Preserves tablespace + database OIDs + relfilenode numbers** (Shruthi Gowda, Antonin Houska)[^pg15-oid] — operational watershed. Added `--no-sync` (Michael Paquier)[^pg15-nosync]. Logs + temp files moved to `pg_upgrade_output.d/` subdirectory of new cluster, auto-cleaned on success (Justin Pryzby)[^pg15-logdir]. |
| PG16 | Locale + encoding can differ between source and target — pg_upgrade automatically sets the new cluster's locale and encoding (Jeff Davis)[^pg16-locale]. `--copy` flag exposed explicitly (Peter Eisentraut)[^pg16-copy]. |
| PG17 | **Logical replication slots and subscriptions migrated** (Hayato Kuroda et al.)[^pg17-slots] — only when source ≥ PG17. `--copy-file-range` flag (Thomas Munro)[^pg17-cfr]. `--sync-method` parameter for file-sync control. |
| PG18 | **Per-column planner statistics preserved** (Corey Huinker, Jeff Davis, Nathan Bossart)[^pg18-stats]. `--no-statistics` flag. **`--swap` mode** for directory-swap upgrade[^pg18-swap]. Updated docs on standby logical-slot copying behavior tied to old-primary version[^pg18-slots]. |

## Examples / Recipes

### Recipe 1 — Standard upgrade with `--check` pre-flight

Canonical PG16 → PG18 upgrade procedure. Same shape works for any source/target pair within supported range.

```bash
# 1. Install new PostgreSQL binaries (do NOT initdb yet via systemd unit; do it manually).
dnf install -y postgresql18-server postgresql18-contrib

# 2. Stop the old cluster.
systemctl stop postgresql-16

# 3. initdb new cluster with matching settings.
#    Must match: --data-checksums flag, --wal-segsize, locale (pre-PG16).
#    PG16+ pg_upgrade sets target's locale from source.
PGSETUP_INITDB_OPTIONS="--data-checksums" \
    /usr/pgsql-18/bin/postgresql-18-setup initdb

# 4. Copy postgresql.conf customizations + pg_hba.conf BEFORE running pg_upgrade.
#    pg_upgrade does NOT migrate these. Cross-reference the gotchas list.
cp /var/lib/pgsql/16/data/pg_hba.conf /var/lib/pgsql/18/data/pg_hba.conf

# Diff postgresql.conf manually and merge required GUCs:
#   shared_preload_libraries, archive_command/archive_library, wal_level,
#   max_replication_slots, shared_buffers, etc.

# 5. Pre-flight --check.
su - postgres
cd ~  # writable workdir; pg_upgrade_output.d will go here
/usr/pgsql-18/bin/pg_upgrade \
    --old-datadir=/var/lib/pgsql/16/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-16/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --check

# Expected output: "*Clusters are compatible*"
# Any error → fix and re-run --check until clean.

# 6. Actual upgrade (omit --check).
/usr/pgsql-18/bin/pg_upgrade \
    --old-datadir=/var/lib/pgsql/16/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-16/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --jobs=8 \
    --link  # near-instant; old cluster becomes unusable

# 7. Start new cluster.
systemctl start postgresql-18

# 8. Post-upgrade ANALYZE (PG18+ target).
vacuumdb --all --analyze-in-stages --missing-stats-only --jobs=8
vacuumdb --all --analyze-only --jobs=8

# 9. Verify cluster identity.
psql -c "SELECT version();"

# 10. Once new cluster confirmed healthy: clean up old data dir.
# (Only if --link succeeded — old cluster cannot start again anyway.)
# rm -rf /var/lib/pgsql/16/data
```

> [!WARNING] Confirm extension binaries installed in new cluster BEFORE step 5
> If `shared_preload_libraries` includes `pg_stat_statements`, `pgaudit`, `pgvector`, or any other extension, the matching `.so` files MUST be installed in `/usr/pgsql-18/lib/` before pg_upgrade starts. Otherwise `--check` (or the actual upgrade) errors with "could not find extension". Cross-reference [`69-extensions.md`](./69-extensions.md).

### Recipe 2 — `--clone` mode for instant rollback option

Same as Recipe 1 but use `--clone` instead of `--link`. Both clusters survive; old cluster can restart on rollback. Filesystem must support reflinks (Btrfs/XFS-with-reflink on Linux ≥4.5, APFS on macOS).

```bash
/usr/pgsql-18/bin/pg_upgrade \
    --old-datadir=/var/lib/pgsql/16/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-16/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --clone \
    --jobs=8
```

Disk-space cost: minimal at clone time (CoW). Files diverge as writes happen on new cluster.

To verify reflink support before relying on `--clone`:

```bash
# Linux/XFS — confirm reflink=1 was set at mkfs time.
xfs_info /var/lib/pgsql | grep reflink

# Linux/Btrfs — supported by default.
btrfs filesystem df /var/lib/pgsql

# macOS/APFS — supported by default on modern macOS.
diskutil info / | grep "File System"
```

### Recipe 3 — PG18+ `--swap` mode

Verbatim PG18 release-note characterization: "potentially fastest method"[^pg18-swap]. Same-filesystem constraint; source directory gets renamed.

```bash
/usr/pgsql-18/bin/pg_upgrade \
    --old-datadir=/var/lib/pgsql/17/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-17/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --swap \
    --jobs=8
```

Test on staging first — `--swap` is newer than `--link`/`--clone`; verify your monitoring + backup scripts don't reference the old data-dir path.

### Recipe 4 — Source ≥ PG17 with logical-slot preservation

Migrate logical replication slots in the same pg_upgrade. Verify preconditions explicitly.

```bash
# On source PG17 cluster, before stopping:
psql -c "SELECT slot_name, slot_type, plugin, database, active, restart_lsn, confirmed_flush_lsn
         FROM pg_replication_slots
         WHERE slot_type = 'logical';"

# Verify all subscribers caught up to confirmed_flush_lsn.
psql -c "SELECT subname, received_lsn, latest_end_lsn, latest_end_time
         FROM pg_stat_subscription;"

# Stop the source PG17.
systemctl stop postgresql-17

# Initdb PG18 target with matching settings PLUS:
PGSETUP_INITDB_OPTIONS="--data-checksums" \
    /usr/pgsql-18/bin/postgresql-18-setup initdb

# Copy postgresql.conf with the slot-relevant settings:
#   wal_level=logical
#   max_replication_slots >= number of slots on source
#   max_wal_senders >= max_replication_slots + replicas
#   shared_preload_libraries includes all output-plugin libraries
cat >> /var/lib/pgsql/18/data/postgresql.conf <<EOF
wal_level = logical
max_replication_slots = 20
max_wal_senders = 20
shared_preload_libraries = 'pgoutput'
EOF

# Run --check first.
/usr/pgsql-18/bin/pg_upgrade \
    --old-datadir=/var/lib/pgsql/17/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-17/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --check

# If --check passes, run actual upgrade.
/usr/pgsql-18/bin/pg_upgrade \
    --old-datadir=/var/lib/pgsql/17/data \
    --new-datadir=/var/lib/pgsql/18/data \
    --old-bindir=/usr/pgsql-17/bin \
    --new-bindir=/usr/pgsql-18/bin \
    --link \
    --jobs=8

# Start new cluster.
systemctl start postgresql-18

# Verify slots migrated.
psql -c "SELECT slot_name, slot_type, plugin, database, active, restart_lsn, confirmed_flush_lsn
         FROM pg_replication_slots;"

# Subscribers reconnect automatically once they see the slot active.
```

Cross-reference [`75-replication-slots.md`](./75-replication-slots.md) for slot lifecycle.

### Recipe 5 — Pre-PG17 source: manual slot recreation post-upgrade

Source = PG16 or earlier → slots not migrated. Procedure:

```bash
# 1. On source PG16, capture slot state.
psql -At -c "SELECT slot_name, plugin, database, two_phase
             FROM pg_replication_slots WHERE slot_type='logical';" > /tmp/slots.txt

# 2. Stop all subscribers (DROP SUBSCRIPTION on subscriber side, or DISABLE if you want to resume same name).
# On EACH subscriber cluster:
psql -c "ALTER SUBSCRIPTION my_sub DISABLE;"

# 3. Stop source PG16, run pg_upgrade as in Recipe 1.

# 4. After new PG18 cluster starts, recreate slots manually.
# IMPORTANT: confirmed_flush_lsn cannot be restored; subscribers must reseed via copy_data or
# an external mechanism (CDC pipeline snapshot, etc.).
while IFS='|' read -r slot_name plugin database two_phase; do
    psql -d "$database" -c "SELECT pg_create_logical_replication_slot('$slot_name', '$plugin');"
done < /tmp/slots.txt

# 5. On each subscriber, refresh and re-enable.
psql -c "ALTER SUBSCRIPTION my_sub REFRESH PUBLICATION WITH (copy_data = true);"
psql -c "ALTER SUBSCRIPTION my_sub ENABLE;"
```

This loses unreplicated transactions between source-stop and new-slot-creation. For zero-data-loss preservation across pre-PG17 upgrades, use logical-replication blue/green pattern — cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

### Recipe 6 — Inspect pg_upgrade output dir after success

PG15+ writes logs to `pg_upgrade_output.d/` under the new cluster's data dir[^pg15-logdir]. Auto-cleaned on success.

```bash
# During upgrade — watch progress.
tail -f /var/lib/pgsql/18/data/pg_upgrade_output.d/log/pg_upgrade_*.log

# Post-upgrade — directory should be gone on success.
ls /var/lib/pgsql/18/data/ | grep pg_upgrade_output

# If upgrade failed, the dir survives for forensics. Contents:
#   - pg_upgrade_server.log — stdout/stderr of internal server starts
#   - pg_upgrade_utility.log — pg_dump / psql output
#   - pg_upgrade_internal.log — pg_upgrade's own log
#   - dump/ — schema dumps used for replay
ls -la /var/lib/pgsql/18/data/pg_upgrade_output.d/
```

### Recipe 7 — Find `reg*` columns before upgrade

Audit script — run on source cluster before scheduling the upgrade window. Catches the eight blocked `reg*` types.

```sql
SELECT n.nspname AS schema,
       c.relname AS table,
       a.attname AS column,
       t.typname AS type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE t.typname IN (
    'regcollation', 'regconfig', 'regdictionary', 'regnamespace',
    'regoper', 'regoperator', 'regproc', 'regprocedure'
  )
  AND c.relkind IN ('r', 'p')          -- ordinary + partitioned tables
  AND a.attnum > 0                     -- skip system cols
  AND NOT a.attisdropped
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1, 2, 3;
```

Workaround for any rows returned: convert offending column to `text`, upgrade, convert back. Or use logical-replication-based blue/green.

### Recipe 8 — Diff postgresql.conf between old and new

pg_upgrade does NOT migrate `postgresql.conf`. Diff before starting new cluster to catch missing GUCs.

```bash
# Side-by-side diff with explicit-set markers.
diff -u \
    <(grep -v '^#' /var/lib/pgsql/16/data/postgresql.conf | sed '/^$/d' | sort) \
    <(grep -v '^#' /var/lib/pgsql/18/data/postgresql.conf | sed '/^$/d' | sort)

# Capture ALTER SYSTEM-set GUCs (postgresql.auto.conf) from source.
cat /var/lib/pgsql/16/data/postgresql.auto.conf

# In-database introspection — what was overridden from defaults on source?
psql -c "SELECT name, setting, source
         FROM pg_settings
         WHERE source NOT IN ('default', 'override')
         ORDER BY name;"
```

Items typically requiring manual carry-over:

- `shared_preload_libraries` (extensions)
- `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`
- `max_connections`, `max_wal_senders`, `max_replication_slots`
- `wal_level`, `archive_mode`, `archive_command` / `archive_library`
- `synchronous_standby_names`, `hot_standby_feedback`
- `default_transaction_isolation` if non-default
- Logging config: `log_min_duration_statement`, `log_line_prefix`, etc.
- `huge_pages`, `track_io_timing`, `track_wal_io_timing`

Cross-reference [`53-server-configuration.md`](./53-server-configuration.md).

### Recipe 9 — Parallel post-upgrade ANALYZE

Pre-PG18 target — full `ANALYZE` mandatory. PG18+ target — extended stats + cumulative-stats refresh still required. Parallelize to shrink the window.

```bash
# Pre-PG18 target (any older version).
vacuumdb --all --analyze-in-stages --jobs=$(nproc)

# PG18+ target. Step 1: extended stats for relations missing them.
vacuumdb --all --analyze-in-stages --missing-stats-only --jobs=$(nproc)

# PG18+ target. Step 2: refresh cumulative stats for autovacuum triggering.
vacuumdb --all --analyze-only --jobs=$(nproc)
```

`--analyze-in-stages` does three passes with increasing `default_statistics_target` (1 → 10 → default). First pass returns minimal-quality stats fast; subsequent passes refine. Cross-reference [`55-statistics-planner.md`](./55-statistics-planner.md).

### Recipe 10 — pg_upgrade fails on extension `.so` missing

Pattern: `--check` reports `could not find function "pgss_get_top" in file "/usr/pgsql-18/lib/pg_stat_statements.so"` or similar.

Fix:

```bash
# 1. Identify which extension's binary is missing.
psql -At -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"

# 2. Install matching extension package for PG18.
dnf install -y pg_stat_statements_18 pgaudit_18 pgvector_18  # adjust per cluster

# 3. Verify .so files present.
ls /usr/pgsql-18/lib/*.so | grep -E "(pg_stat_statements|pgaudit|pgvector)"

# 4. Re-run --check.
```

Third-party extensions (pgvector, pg_partman, pg_cron, PostGIS, TimescaleDB) require their corresponding packages for the target PG version. Sometimes a third-party extension lags official PG releases — verify availability before scheduling the upgrade. Cross-reference [`69-extensions.md`](./69-extensions.md).

### Recipe 11 — Disk-space estimate before `--copy` mode

`--copy` mode doubles disk usage during upgrade. Verify before scheduling.

```bash
# Source data directory size.
du -sh /var/lib/pgsql/16/data /var/lib/pgsql/16/data/pg_wal

# Free space on target filesystem.
df -h /var/lib/pgsql

# Rule of thumb: need 1.1× source data-dir size free, plus pg_wal.
# pg_upgrade --copy doesn't compress; same byte layout.
```

If disk is tight: use `--link`, `--clone`, or `--swap` (PG18+).

### Recipe 12 — pg_upgrade with `--data-checksums` mismatch

`--check` errors with `old cluster does not use data checksums but the new one does` (or vice versa). pg_upgrade requires the flag to match.

Fix options:

**Option A — re-initdb the target with matching flag.**

```bash
# Source has no checksums; target was initdb'd with --data-checksums.
# Wipe target, re-initdb without checksums.
systemctl stop postgresql-18
rm -rf /var/lib/pgsql/18/data
PGSETUP_INITDB_OPTIONS="" \
    /usr/pgsql-18/bin/postgresql-18-setup initdb
```

**Option B — enable checksums on source first (PG12+, requires cluster offline).**

```bash
# Source must be stopped.
systemctl stop postgresql-16

# Enable checksums in place. Hours-long for TB-scale; verify time budget.
/usr/pgsql-16/bin/pg_checksums --enable -D /var/lib/pgsql/16/data --progress
```

PG18+ enables `--data-checksums` by default at `initdb` — cross-reference [`88-corruption-recovery.md`](./88-corruption-recovery.md). Verify both sides match BEFORE running pg_upgrade.

### Recipe 13 — Rollback after `--link` mode failure

If new cluster fails to start after `--link`, the old cluster's data dir is half-modified (`pg_control` may have been edited). Rollback procedure:

```bash
# 1. DO NOT start the old cluster yet.

# 2. Restore old data dir from base backup OR (if you took a filesystem snapshot before upgrade) revert the snapshot.
# Cross-reference 84-backup-physical-pitr.md and 85-backup-tools.md.

# 3. Restart old cluster on its original port.
systemctl start postgresql-16

# 4. Investigate root cause via pg_upgrade_output.d/ in the failed new cluster.
ls /var/lib/pgsql/18/data/pg_upgrade_output.d/log/

# Common failure modes:
#   - Missing extension .so (Recipe 10)
#   - postgresql.conf has GUC referencing extension not yet loaded (fix conf, retry)
#   - Disk full mid-link (free space, retry)
#   - reg* column type blocking (Recipe 7)
```

For `--copy` mode: old cluster untouched, restart it directly. For `--clone`: same as `--copy` for old cluster.

**Lesson — always have a base backup or filesystem snapshot before pg_upgrade.** Cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).

## Gotchas / Anti-patterns

23 gotchas — pg_upgrade has many silent-failure surfaces.

1. **`pg_hba.conf` does NOT migrate.** Manually copy or recreate. First connection attempt to new cluster fails authentication if forgotten.
2. **`postgresql.conf` does NOT migrate.** Custom GUCs (`shared_preload_libraries`, `shared_buffers`, `archive_command`, etc.) reset to `initdb` defaults. Diff before starting new cluster (Recipe 8).
3. **`archive_command` / `archive_library` resets.** WAL archive pipeline silently breaks. Cross-reference [`33-wal.md`](./33-wal.md).
4. **`--link` mode renders old cluster unusable after first write on new cluster.** See Transfer Modes table above for full behavior. Always take a base backup before `--link`. Cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).
5. **`--check` cannot validate everything.** Catches catalog-level + binary-availability issues but not runtime GUC misconfiguration. Smoke-test new cluster with representative workload after upgrade.
6. **Extension binaries must be installed on new cluster.** Third-party extensions (pgvector, pg_partman, etc.) often lag major PG releases. Verify availability + install matching packages BEFORE running `--check` (Recipe 10).
7. **`shared_preload_libraries` ordering matters.** Extensions like `pg_stat_statements`, `pgaudit`, `auto_explain` must appear in shared_preload_libraries before pg_upgrade starts, or initdb won't load them and `--check` errors. Cross-reference [`69-extensions.md`](./69-extensions.md).
8. **`reg*` OID-referencing types block upgrade.** Eight types blocked (Recipe 7); three allowed (`regclass`, `regrole`, `regtype`). Audit before scheduling.
9. **Statistics reset on pre-PG18 target.** Query plans regress for hours/days after upgrade without `vacuumdb --all --analyze-in-stages`. Build the post-ANALYZE step into the upgrade runbook (Recipe 9).
10. **Extended statistics never preserved — even on PG18+ target.** Run `vacuumdb --all --analyze-in-stages --missing-stats-only` post-upgrade on PG18+. Cross-reference [`55-statistics-planner.md`](./55-statistics-planner.md).
11. **Replication slots from pre-PG17 sources lost.** Subscribers must be paused, slots recreated manually, slot LSNs reseeded (Recipe 5). Plan for downtime + reseed cost on subscriber side. For zero-data-loss preservation, use logical-replication blue/green ([`87-major-version-upgrade.md`](./87-major-version-upgrade.md)).
12. **PG17+ slot migration requires `wal_level=logical` on target.** Slot migration silently skipped if new cluster initialized with `wal_level=replica`. Set explicitly in target's `postgresql.conf` BEFORE `--check`.
13. **`max_replication_slots` must be ≥ slot count on source.** Otherwise `--check` errors. Verify with `SELECT count(*) FROM pg_replication_slots` on source.
14. **Same encoding required pre-PG16.** PG16+ pg_upgrade sets target's encoding to match source automatically[^pg16-locale]. On PG15 target or earlier, target must be initdb'd with the matching `--encoding`.
15. **Same architecture + endianness required, always.** Cross-architecture upgrades require dump+restore. pg_upgrade reuses byte layout from data files; no byte-swap pass.
16. **Same `--data-checksums` flag required.** Cluster created without checksums cannot be pg_upgrade'd to a checksum-enabled target (Recipe 12). Use `pg_checksums --enable` on source (offline) or re-initdb target without checksums.
17. **Same `--wal-segsize` required.** Non-default WAL segment size on source must match target.
18. **Pre-existing data on target cluster blocks upgrade.** Target must be empty (only system catalogs from `initdb`). If you connected and created data → drop, re-initdb, or use a fresh target dir.
19. **`pg_stat_statements` history resets.** Counters in `pg_stat_statements_info` and all `total_*_time` columns return to zero. Cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md).
20. **`pg_cron` job history resets but `cron.job` schedule survives.** Jobs continue executing post-upgrade but `cron.job_run_details` accumulated execution history is gone. Cross-reference [`98-pg-cron.md`](./98-pg-cron.md).
21. **OS user permissions matter.** Run pg_upgrade as the OS user that owns BOTH data dirs (typically `postgres`). Mismatched ownership → permission denied mid-upgrade with potentially corrupted target.
22. **`--swap` (PG18+) renames source directory.** Backup scripts that reference old `$PGDATA` path break silently. Update before relying on `--swap` mode. Verbatim PG18 release-note[^pg18-swap].
23. **Long-running upgrade fails if disk fills.** `--copy` mode doubles disk usage. `--link` / `--clone` / `--swap` need less but `pg_wal` still grows during catalog migration. Pre-check with `df -h /var/lib/pgsql` (Recipe 11).

## See Also

- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — logical backup as upgrade alternative for cross-architecture.
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — base backup before pg_upgrade is mandatory safety net.
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest / Barman / WAL-G production-grade backup before upgrade.
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — zero-downtime blue/green via logical replication.
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged former primary after failover.
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication mechanics for blue/green pattern.
- [`75-replication-slots.md`](./75-replication-slots.md) — slot lifecycle, what PG17+ pg_upgrade preserves.
- [`55-statistics-planner.md`](./55-statistics-planner.md) — what `pg_statistic` vs `pg_statistic_ext_data` contains and how post-upgrade ANALYZE rebuilds them.
- [`53-server-configuration.md`](./53-server-configuration.md) — `postgresql.conf` items to carry across upgrade.
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — `pg_hba.conf` manual copy.
- [`33-wal.md`](./33-wal.md) — `archive_command` / `archive_library` re-establishment post-upgrade.
- [`69-extensions.md`](./69-extensions.md) — extension binary installation matching target PG version.
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `pg_checksums` for enabling checksums to match between source and target.
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — pre-upgrade backup as DR baseline.

## Sources

[^pgupgrade-docs]: PostgreSQL 18 documentation, `pg_upgrade`. Verbatim quotes on transfer modes, `--check` semantics, prerequisites, post-upgrade ANALYZE procedure, supported source range, security warning, and `reg*` type restrictions. https://www.postgresql.org/docs/18/pgupgrade.html

[^pg-security]: PostgreSQL 18 documentation, `pg_upgrade`. Verbatim "Upgrading a cluster causes the destination to execute arbitrary code of the source superusers' choice. Ensure that the source superusers are trusted before upgrading." https://www.postgresql.org/docs/18/pgupgrade.html

[^pg14-analyze]: PostgreSQL 14 release notes. Verbatim "Stop pg_upgrade from creating analyze_new_cluster script (Magnus Hagander). Instead, give comparable vacuumdb instructions." https://www.postgresql.org/docs/16/release-14.html

[^pg14-postfix]: PostgreSQL 14 release notes. Verbatim "pg_dump and pg_upgrade will warn if postfix operators are being dumped." https://www.postgresql.org/docs/16/release-14.html

[^pg15-oid]: PostgreSQL 15 release notes. Verbatim "Make pg_upgrade preserve tablespace and database OIDs, as well as relation relfilenode numbers (Shruthi Gowda, Antonin Houska)." https://www.postgresql.org/docs/16/release-15.html

[^pg15-nosync]: PostgreSQL 15 release notes. Verbatim "Add a --no-sync option to pg_upgrade (Michael Paquier). This is recommended only for testing." https://www.postgresql.org/docs/16/release-15.html

[^pg15-logdir]: PostgreSQL 15 release notes. Verbatim "Store pg_upgrade's log and temporary files in a subdirectory of the new cluster called pg_upgrade_output.d. Previously such files were left in the current directory, requiring manual cleanup. Now they are automatically removed on successful completion of pg_upgrade (Justin Pryzby)." https://www.postgresql.org/docs/16/release-15.html

[^pg16-locale]: PostgreSQL 16 release notes. Verbatim "Have pg_upgrade set the new cluster's locale and encoding (Jeff Davis). This removes the requirement that the new cluster be created with the same locale and encoding settings as the source cluster." https://www.postgresql.org/docs/16/release-16.html

[^pg16-copy]: PostgreSQL 16 release notes. Verbatim "Add pg_upgrade option to specify the default transfer mode (Peter Eisentraut). `--copy` — Copy files to new cluster (default)." https://www.postgresql.org/docs/16/release-16.html

[^pg17-slots]: PostgreSQL 17 release notes. Verbatim "Have pg_upgrade migrate valid logical slots and subscriptions (Hayato Kuroda, Hou Zhijie, Vignesh C, Julien Rouhaud, Shlok Kyal). This allows logical replication to continue quickly after the upgrade. This only works for old PostgreSQL clusters that are version 17 or later." https://www.postgresql.org/docs/17/release-17.html

[^pg17-cfr]: PostgreSQL 17 release notes. Verbatim "Add `--copy-file-range` option to pg_upgrade (Thomas Munro). This provides optimized file copying for Linux and FreeBSD." https://www.postgresql.org/docs/17/release-17.html

[^pg18-stats]: PostgreSQL 18 release notes. Verbatim "Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation." https://www.postgresql.org/docs/18/release-18.html

[^pg18-swap]: PostgreSQL 18 release notes. Verbatim "New `--swap` option: Swap directories rather than copy/clone/link files (potentially fastest method)." https://www.postgresql.org/docs/18/release-18.html

[^pg18-slots]: PostgreSQL 18 documentation, `pg_upgrade`. Verbatim "If the old primary is prior to version 17.0, then no slots on the primary are copied to the new standby, so all the slots on the old standby must be recreated manually. If the old primary is version 17.0 or later, then only logical slots on the primary are copied to the new standby, but other slots on the old standby are not copied, so must be recreated manually." https://www.postgresql.org/docs/18/pgupgrade.html

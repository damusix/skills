# pg_rewind

Re-sync diverged former primary to new primary by copying only changed blocks. Avoids full base backup. Cluster-wide. Destructive on target.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [What pg_rewind Does](#what-pg_rewind-does)
    - [Prerequisites](#prerequisites)
    - [Source Modes: --source-server vs --source-pgdata](#source-modes)
    - [Target Cleanup + Auto Crash Recovery](#target-cleanup)
    - [Timeline Divergence Detection](#timeline-divergence)
    - [WAL Retention Requirement](#wal-retention)
    - [Source-Server Permissions](#source-permissions)
    - [restore_command Integration](#restore-command-integration)
    - [Recovery Configuration After Rewind](#recovery-config)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas / Anti-patterns](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use This Reference

Need: re-attach old primary as standby of new primary after failover. Avoid full `pg_basebackup` because cluster is large (hundreds of GB to TB). Source + target started from same `initdb`. Source running OR cleanly shut down. Target willing to lose its post-divergence writes.

Wrong tool: source + target initdb'd separately (no shared LSN history — use `pg_basebackup`). Cluster < 50 GB (just `pg_basebackup`, no setup pain). Target not diverged (no rewind needed — start as standby directly). Diverged across major version (impossible — see [`86-pg-upgrade.md`](./86-pg-upgrade.md)).

> [!WARNING] pg_rewind DISCARDS data on target
>
> **Target's data files get overwritten with source's content.** Any transactions committed on the old primary AFTER divergence (the split-brain window) are LOST. Always: (1) take byte-level backup of target before running pg_rewind, (2) confirm new primary is authoritative, (3) audit `pg_xlog` / `pg_wal` for unreplicated changes via `pg_waldump` if you suspect split-brain writes. See [`88-corruption-recovery.md`](./88-corruption-recovery.md) for byte-level-backup pattern.

> [!WARNING] PG18 changed initdb to enable data checksums by default
>
> Pre-PG18 clusters need explicit `wal_log_hints=on` at the time divergence occurs. PG18 docs add the parenthetical:
>
> > "pg_rewind requires that the target server either has the wal_log_hints option enabled in postgresql.conf or data checksums enabled when the cluster was initialized with initdb (the default)."
>
> Greg Sabino Mullane, PG18 release note: *"Change initdb to default to enabling checksums."* Carry-forward clusters from PG12-17 still need explicit `wal_log_hints=on` unless `pg_checksums --enable` was run offline.

---

## Mental Model

**Five rules:**

1. **pg_rewind copies only changed blocks back to divergence point.** Not a full base backup. Reads target's WAL since divergence to identify which blocks the target wrote, copies those blocks from source. Unchanged blocks stay. Configuration files + WAL segments copied in full.

2. **Requires `wal_log_hints=on` OR `data_checksums=on` at the time of divergence — not at rewind time.** Hint-bit writes are not normally WAL-logged. pg_rewind needs every block modification to be in WAL so it can identify dirty blocks. Without one of these flags set BEFORE divergence, pg_rewind cannot find the changed blocks. Must use `pg_basebackup` instead. `full_page_writes=on` also required (default on).

3. **Two source modes radically different.** `--source-server` = libpq connection, source must be **running**, target connects + reads source catalog + reads source WAL. `--source-pgdata` = file system path, source must be **cleanly shut down**, no libpq, both directories on same host (or NFS).

4. **Target must be cleanly shut down before rewind.** PG13+ auto-recovers if target is crashed (starts in single-user mode, replays WAL, stops). Pre-PG13 you must `pg_ctl start` + `pg_ctl stop` manually first. After rewind, target stays stopped — start it as standby pointing at source.

5. **Operates on entire data directory atomically.** Not selective — cannot rewind one table or one tablespace. Tablespaces outside `PGDATA` are also rewound. If rewind aborts mid-way, target is unusable — restore from your byte-level backup.

---

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Re-attach diverged former primary | `pg_rewind --source-server` | Avoids full base backup; only changed blocks copied |
| Source is running + accepting connections | `--source-server 'host=new-primary user=rewind dbname=postgres'` | Libpq is the modern + default path |
| Source is offline + locally accessible | `--source-pgdata /var/lib/postgresql/16/source` | No libpq required; both dirs on same host |
| Target is crashed (not clean shutdown) | Default — pg_rewind auto-runs single-user crash recovery (PG13+) | Disable via `--no-ensure-shutdown` if you have run recovery yourself |
| Need WAL segments since divergence | `--restore-target-wal` + populated `restore_command` (PG13+) | Pulls from archive when `pg_wal/` is missing segments |
| Need standby.signal + postgresql.auto.conf written automatically | `--write-recovery-conf` (PG13+) | Replicates pg_basebackup's `-R` behavior |
| Pre-validate without modifying target | `--dry-run` | Reports what would happen, no changes |
| Config files live outside PGDATA | `--config-file /etc/postgres/...` (PG15+) | Tells pg_rewind where to find postgresql.conf for crash recovery |
| Source connection needs database name in recovery config | PG18+ `--source-server 'host=... dbname=app1'` | PG18 records `dbname` in postgresql.auto.conf if specified |
| Cross-architecture / cross-major-version rewind | **Impossible** — use [`86-pg-upgrade.md`](./86-pg-upgrade.md) | Same `initdb` lineage required |
| Source + target initdb'd separately | **Impossible** — use [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) | No shared LSN history |
| Cluster < 50 GB | Just `pg_basebackup` fresh | Setup cost of pg_rewind exceeds rewind savings on small clusters |

**Three smell signals:**

- `wal_log_hints=off` AND `data_checksums=off` on the old primary → pg_rewind cannot run; must rebuild via `pg_basebackup`. Carry-forward configs from PG12-17 commonly hit this.
- pg_rewind fails with `target server needs to use either data checksums or wal_log_hints = on` → see above; cannot retroactively enable for past divergence.
- Old primary held writes during a network partition AFTER failover declared → split-brain. Audit `pg_wal` via `pg_waldump` before rewinding; lost writes may need manual extraction.

---

## Mechanics

### What pg_rewind Does

From PG16/17/18 docs (verbatim):

> "pg_rewind is a tool for synchronizing a PostgreSQL cluster with another copy of the same cluster, after the clusters' timelines have diverged. A typical scenario is to bring an old primary server back online after failover as a standby that follows the new primary."

> "After a successful rewind, the state of the target data directory is analogous to a base backup of the source data directory. Unlike taking a new base backup or using a tool like rsync, pg_rewind does not require comparing or copying unchanged relation blocks in the cluster. Only changed blocks from existing relation files are copied; all other files, including new relation files, configuration files, and WAL segments, are copied in full."

**Five-step algorithm:**

1. **Identify divergence LSN** — scan target's timeline history + WAL backwards from current LSN, find the timeline switch point (the LSN where target + source last shared history).
2. **Read target WAL since divergence** — walk every WAL record from divergence to target's current LSN, collect block-modification list.
3. **Copy changed blocks from source** — for each (relfilenode, block_number) in the modification list, copy that block from source.
4. **Copy auxiliary files** — pg_control, configuration files, pg_clog/pg_xact files, WAL segments needed for next startup.
5. **Update pg_control** — target's pg_control is replaced with the source's plus a minimum recovery point set so target knows it must replay WAL from source on first start.

After rewind, target's data files are byte-equivalent to source's data files **as of source's current LSN**. Target's pg_wal contains source's WAL segments — target replays them on first startup as if it had been a streaming standby all along.

### Prerequisites

Three GUCs at the time of divergence (NOT at the time of rewind):

| GUC | Required value | Default | Notes |
|---|---|---|---|
| `wal_log_hints` | `on` (OR data_checksums on) | `off` | Forces hint-bit writes to be WAL-logged. Restart-only. Pre-PG18 default `off`. |
| `data_checksums` | `on` (OR wal_log_hints on) | `off` pre-PG18, `on` PG18+ | initdb-time only — `pg_checksums --enable` for offline conversion. |
| `full_page_writes` | `on` | `on` | Whole-page WAL on first-after-checkpoint modification. Do NOT disable. |

PG16/17 docs verbatim:

> "pg_rewind requires that the target server either has the wal_log_hints option enabled in postgresql.conf or data checksums enabled when the cluster was initialized with initdb. Neither of these are currently on by default. full_page_writes must also be set to on, but is enabled by default."

PG18 docs verbatim (note the added `(the default)`):

> "pg_rewind requires that the target server either has the wal_log_hints option enabled in postgresql.conf or data checksums enabled when the cluster was initialized with initdb (the default). full_page_writes must also be set to on, but is enabled by default."

> [!NOTE] Cannot retroactively satisfy the requirement
>
> If neither flag was on at the time the target diverged, pg_rewind cannot run for THAT divergence. Even if you enable `wal_log_hints` now, the historical WAL is missing the hint-bit-update records pg_rewind needs. Must rebuild via `pg_basebackup` or restore from byte-level backup.

### Source Modes

Two ways to point pg_rewind at the source. Different operational constraints.

| Mode | Flag | Source state | Setup | Network |
|---|---|---|---|---|
| Libpq | `--source-server 'host=... user=... dbname=...'` | Running + accepting connections | Source role needs `pg_rewind` permissions (see [Source-Server Permissions](#source-permissions)) | TCP connection to source |
| Filesystem | `--source-pgdata /path/to/source/PGDATA` | **Cleanly shut down** (NOT crashed) | Both directories on same host or NFS | Local FS access |

Verbatim from docs:

> "**--source-pgdata**: Specifies the file system path to the data directory of the source server to synchronize the target with. This option requires the source server to be cleanly shut down."

> "**--source-server**: Specifies a libpq connection string to connect to the source PostgreSQL server to synchronize the target with. The connection must be a normal (non-replication) connection with a role having sufficient permissions to execute the functions used by pg_rewind on the source server (see Notes section for details) or a superuser role. This option requires the source server to be running and accepting connections."

**Production default = `--source-server`.** Source is running (it's the new primary). Avoids requiring local FS access from target host.

### Target Cleanup + Auto Crash Recovery

Verbatim from docs:

> "pg_rewind requires that the target server is cleanly shut down before rewinding. By default, if the target server is not shut down cleanly, pg_rewind starts the target server in single-user mode to complete crash recovery first, and stops it."

PG13 introduced this behavior. Pre-PG13 you must:

```bash
pg_ctl -D /var/lib/postgresql/16/main start
pg_ctl -D /var/lib/postgresql/16/main stop -m smart
```

PG13+ pg_rewind does this automatically. Disable via `--no-ensure-shutdown` if you have already run recovery yourself (e.g., during forensics).

PG13 release note (Paul Guo, Jimmy Yih, Ashwin Agrawal):

> "Have pg_rewind automatically run crash recovery before rewinding."

**After rewind completes, target stays stopped.** You start it manually after writing recovery configuration.

### Timeline Divergence

Verbatim from docs:

> "pg_rewind examines the timeline histories of the source and target clusters to determine the point where they diverged, and expects to find WAL in the target cluster's pg_wal directory reaching all the way back to the point of divergence."

**The divergence point** = the LSN at which source and target last shared the same timeline. After a failover, the new primary (source) gets a fresh timeline ID; the old primary (target) keeps its original timeline ID. Both write WAL from the divergence LSN forward, on different timelines.

Inspect timelines:

```sql
-- On either cluster:
SELECT * FROM pg_control_checkpoint();

-- On source (new primary):
SELECT timeline_id, latest_lsn FROM pg_control_recovery();
```

Timeline history files in `pg_wal/`:

```
00000001.history  (timeline 1 — original)
00000002.history  (timeline 2 — created at first failover)
00000003.history  (timeline 3 — created at second failover)
```

PG16 release note (Heikki Linnakangas) corrects a pre-existing edge case:

> "Allow pg_rewind to properly track timeline changes. Previously if pg_rewind was run after a timeline switch but before a checkpoint was issued, it might incorrectly determine that a rewind was unnecessary."

Operational consequence: on PG16+, pg_rewind correctly identifies divergence even immediately after promotion. On pre-PG16, force a checkpoint on the new primary (`CHECKPOINT;`) before running pg_rewind to ensure the timeline-switch WAL record is durable.

### WAL Retention

pg_rewind needs **the target's own WAL** from the divergence point forward, present in `pg_wal/`. If the target rotated out those segments (after a `pg_archivecleanup` run, or via `wal_keep_size` exhaustion), pg_rewind cannot determine which blocks were modified.

Two remedies:

1. **`--restore-target-wal`** (PG13+) — uses target's `restore_command` to fetch archived WAL:

    > "**--restore-target-wal**: Use restore_command defined in the target cluster configuration to retrieve WAL files from the WAL archive if these files are no longer available in the pg_wal directory."

2. **Manually copy** WAL segments back into target's `pg_wal/` from your archive.

PG13 release note (Alexey Kondratov):

> "Allow pg_rewind to use the target cluster's restore_command to retrieve needed WAL. This is enabled using the -c/--restore-target-wal option."

### Source-Server Permissions

When using `--source-server`, the connecting role needs **one of**:

- Superuser, OR
- Membership in `pg_read_all_settings` + `pg_read_all_stats` + `pg_signal_backend`, AND `EXECUTE` on the pg_rewind helper functions

Minimum non-superuser setup on source:

```sql
CREATE ROLE rewind_role LOGIN PASSWORD 'redacted';
GRANT EXECUTE ON FUNCTION pg_ls_dir(text, boolean, boolean) TO rewind_role;
GRANT EXECUTE ON FUNCTION pg_stat_file(text, boolean) TO rewind_role;
GRANT EXECUTE ON FUNCTION pg_read_binary_file(text) TO rewind_role;
GRANT EXECUTE ON FUNCTION pg_read_binary_file(text, bigint, bigint, boolean) TO rewind_role;
```

Add a `pg_hba.conf` line on source allowing this role from target's host. See [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md).

### restore_command Integration

`--restore-target-wal` PG13+ uses the target's `restore_command` (from target's `postgresql.conf`). The `restore_command` must work without a running server — pg_rewind runs it directly. Test by hand:

```bash
# Sample restore_command in target's postgresql.conf:
# restore_command = 'cp /var/archive/%f %p'

# Test manually:
cp /var/archive/0000000200000001000000A0 /tmp/test-fetch
```

If `restore_command` references a shell helper that depends on running-server context (e.g., reads `pg_settings`), pg_rewind fails. Use a self-contained command.

### Recovery Configuration

After rewind, target is byte-equivalent to source. Target must be configured to start as a standby of source.

Manual approach:

```bash
touch /var/lib/postgresql/16/main/standby.signal

cat >> /var/lib/postgresql/16/main/postgresql.auto.conf <<EOF
primary_conninfo = 'host=new-primary port=5432 user=replicator password=...'
primary_slot_name = 'standby_old_primary'
EOF
```

Automatic approach via `--write-recovery-conf` PG13+ (Paul Guo, Jimmy Yih, Ashwin Agrawal):

> "Add an option to pg_rewind to configure standbys. This matches pg_basebackup's --write-recovery-conf option."

Verbatim docs (PG16/17):

> "**--write-recovery-conf**: Create standby.signal and append connection settings to postgresql.auto.conf in the output directory. --source-server is mandatory with this option."

PG18+ adds `dbname` recording (Masahiko Sawada):

> "If pg_rewind's --source-server specifies a database name, use it in --write-recovery-conf output."

Verbatim PG18 docs:

> "**--write-recovery-conf**: Create standby.signal and append connection settings to postgresql.auto.conf in the output directory. The dbname will be recorded only if the dbname was specified explicitly in the connection string or environment variable. --source-server is mandatory with this option."

---

## Per-Version Timeline

| Version | Change |
|---|---|
| PG13 | `--write-recovery-conf` (Paul Guo, Jimmy Yih, Ashwin Agrawal) — *"Add an option to pg_rewind to configure standbys. This matches pg_basebackup's --write-recovery-conf option."* |
| PG13 | `--restore-target-wal` (Alexey Kondratov) — *"Allow pg_rewind to use the target cluster's restore_command to retrieve needed WAL. This is enabled using the -c/--restore-target-wal option."* |
| PG13 | Auto crash recovery (Paul Guo, Jimmy Yih, Ashwin Agrawal) — *"Have pg_rewind automatically run crash recovery before rewinding. This can be disabled by using --no-ensure-shutdown."* |
| PG14 | Standby-as-target supported (Heikki Linnakangas) — *"Allow standby servers to be rewound via pg_rewind."* |
| PG15 | `--config-file` flag (Gunnar Bluth) — *"Add pg_rewind option --config-file to simplify use when server configuration files are stored outside the data directory."* |
| PG16 | Timeline-tracking fix (Heikki Linnakangas) — *"Allow pg_rewind to properly track timeline changes. Previously if pg_rewind was run after a timeline switch but before a checkpoint was issued, it might incorrectly determine that a rewind was unnecessary."* |
| PG17 | `--sync-method` flag (Justin Pryzby, Nathan Bossart) — *"Add the --sync-method parameter to several client applications. The applications are initdb, pg_basebackup, pg_checksums, pg_dump, pg_rewind, and pg_upgrade."* |
| PG18 | `dbname` in `--write-recovery-conf` (Masahiko Sawada) — *"If pg_rewind's --source-server specifies a database name, use it in --write-recovery-conf output."* |
| PG18 | Requirements wording updated to reflect initdb default-on checksums (Greg Sabino Mullane release-note context) |

**Every PG13-PG18 version contributed at least one pg_rewind item.** Tool continues to mature; expect more refinements.

---

## Recipes

### 1. Canonical pg_rewind: re-attach old primary after failover

Scenario: cluster A (old primary) failed over to cluster B (new primary). A is now diverged. Bring A back as a standby of B.

```bash
# ---------------- On A (old primary) ----------------
# Confirm A is stopped, OR let pg_rewind auto-run single-user recovery.
pg_ctl -D /var/lib/postgresql/16/main stop -m fast

# Take byte-level backup BEFORE rewinding (in case of split-brain writes).
cp -a /var/lib/postgresql/16/main /var/backup/main.pre-rewind.$(date +%F)

# Run pg_rewind. Dry-run first.
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server='host=new-primary.internal port=5432 user=rewind_role dbname=postgres' \
  --dry-run \
  --progress

# If dry-run looks good, real run + write standby config:
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server='host=new-primary.internal port=5432 user=rewind_role dbname=postgres' \
  --write-recovery-conf \
  --progress

# Start as standby:
pg_ctl -D /var/lib/postgresql/16/main start
```

Verify it caught up:

```sql
-- On A (formerly old primary, now standby):
SELECT pg_is_in_recovery();        -- t
SELECT pg_last_wal_replay_lsn();   -- advancing
```

### 2. Source offline: --source-pgdata

Source is offline (e.g., archival snapshot mounted locally). No libpq.

```bash
# Source MUST be cleanly shut down. Confirm via pg_controldata:
pg_controldata /var/snapshots/new-primary | grep "Database cluster state"
# Database cluster state:               shut down

pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-pgdata=/var/snapshots/new-primary \
  --dry-run --progress
```

### 3. Verify prerequisites BEFORE failover

Run these on every cluster as part of cluster baseline. Catch missing flags before you need pg_rewind in an outage.

```sql
SHOW wal_log_hints;        -- want: on (unless data_checksums on)
SHOW data_checksums;       -- want: on (PG18 default; pre-PG18 explicit)
SHOW full_page_writes;     -- want: on (default; do NOT disable)
```

If `wal_log_hints=off` AND `data_checksums=off`:

```bash
# Pick wal_log_hints (easier — ALTER SYSTEM + restart) for pre-PG18 clusters:
psql -c "ALTER SYSTEM SET wal_log_hints = on;"
pg_ctl restart   # required — wal_log_hints is restart-only.

# OR enable checksums offline (pg_checksums) — cluster must be stopped:
pg_ctl stop
pg_checksums --enable --pgdata=/var/lib/postgresql/16/main
pg_ctl start
```

See [`88-corruption-recovery.md`](./88-corruption-recovery.md) for full `pg_checksums --enable` procedure.

### 4. Use restore_command for missing WAL segments

Target rotated out some WAL since divergence. Don't rebuild from scratch — use the archive.

```bash
# Confirm restore_command in target's postgresql.conf:
grep restore_command /var/lib/postgresql/16/main/postgresql.conf

# Run pg_rewind with --restore-target-wal:
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server='host=new-primary.internal port=5432 user=rewind_role' \
  --restore-target-wal \
  --progress
```

### 5. Non-superuser source role

Create a least-privilege role on the new primary specifically for pg_rewind.

```sql
-- On source (new primary):
CREATE ROLE rewind_role LOGIN PASSWORD 'redacted';
GRANT EXECUTE ON FUNCTION pg_ls_dir(text, boolean, boolean) TO rewind_role;
GRANT EXECUTE ON FUNCTION pg_stat_file(text, boolean) TO rewind_role;
GRANT EXECUTE ON FUNCTION pg_read_binary_file(text) TO rewind_role;
GRANT EXECUTE ON FUNCTION pg_read_binary_file(text, bigint, bigint, boolean) TO rewind_role;
```

```bash
# On source: edit pg_hba.conf to allow rewind_role from target host:
# host all rewind_role 10.0.0.0/24 scram-sha-256
pg_ctl -D /var/lib/postgresql/16/main reload
```

See [`46-roles-privileges.md`](./46-roles-privileges.md) and [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md).

### 6. Inspect divergence point manually

Before rewinding, confirm the timeline split.

```bash
# On target (old primary, diverged):
pg_controldata /var/lib/postgresql/16/main | grep "Latest checkpoint's TimeLineID"

# On source (new primary):
pg_controldata /var/lib/postgresql/16/source | grep "Latest checkpoint's TimeLineID"
```

If target says `2` and source says `3`, the divergence happened at the timeline-2-to-3 switch. Inspect `0000000{3}.history` on source for the LSN:

```bash
cat /var/lib/postgresql/16/source/pg_wal/00000003.history
# 1   0/1A000060   no recovery target specified
# 2   0/4F000000   no recovery target specified
```

The last line tells you: timeline 3 forked from timeline 2 at LSN `0/4F000000`. Anything target wrote past `0/4F000000` on timeline 2 will be discarded by pg_rewind.

### 7. Audit split-brain WAL before rewinding

You suspect old primary kept accepting writes after failover. Inspect with `pg_waldump` before destroying that WAL.

```bash
# On target (old primary):
# Find the LSN at which target's timeline 2 forked from source's timeline 3 (see Recipe 6).
DIVERGENCE_LSN="0/4F000000"

# Find target's current LSN:
pg_controldata /var/lib/postgresql/16/main | grep "Latest checkpoint location"
# Latest checkpoint location:           0/53000000

# Dump WAL records between divergence + target's tip:
pg_waldump \
  --path=/var/lib/postgresql/16/main/pg_wal \
  --start="$DIVERGENCE_LSN" \
  --end="0/53000000" \
  --timeline=2 \
  | grep -E '(INSERT|UPDATE|DELETE|COMMIT)' \
  > /tmp/lost-writes.txt

wc -l /tmp/lost-writes.txt
```

If non-trivial, extract via `pg_dump` on target BEFORE pg_rewind, save dump file outside `PGDATA`. See [`88-corruption-recovery.md`](./88-corruption-recovery.md) Recipe 9 for the destructive pre-recovery dump pattern.

### 8. PG18 dbname in recovery config

PG18+ records `dbname` in `postgresql.auto.conf` when specified.

```bash
# PG18+:
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server='host=new-primary user=rewind_role dbname=app_primary' \
  --write-recovery-conf

# Resulting postgresql.auto.conf entry:
grep primary_conninfo /var/lib/postgresql/16/main/postgresql.auto.conf
# primary_conninfo = 'user=rewind_role host=new-primary dbname=app_primary'
```

Pre-PG18 the `dbname=` part was stripped. PG18+ keeps it — useful for connection-name attribution in logs.

### 9. PG14+ rewind a standby (not just former primary)

PG14 enabled rewinding **any** diverged node, not just former primaries. Useful when a cascading standby diverged from its upstream.

```bash
# Cascading standby `replica-b` follows `replica-a`. After promoting `replica-a`,
# any other replicas that pointed at the OLD primary are now diverged.
# Rewind them to follow `replica-a` instead.

pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server='host=replica-a.internal user=rewind_role' \
  --write-recovery-conf
```

### 10. Diagnose "no rewind required"

pg_rewind exits 0 saying *"No rewind required."*. This means it identified no timeline divergence. Sanity-check:

```bash
# Confirm the timelines actually diverged.
pg_controldata /var/lib/postgresql/16/main | grep TimeLineID
pg_controldata /var/lib/postgresql/16/source | grep TimeLineID

# If they match (both say "TimeLineID: 2"), target was never promoted —
# you can start it directly as a standby of source, no rewind needed.

# If they differ but pg_rewind says "no rewind required" on pre-PG16:
# Force a checkpoint on source first (PG16 fixed this edge case):
psql -h new-primary -c "CHECKPOINT;"
# Then retry pg_rewind.
```

### 11. Decide pg_rewind vs pg_basebackup-fresh

| Property | pg_rewind | pg_basebackup |
|---|---|---|
| Speed (1 TB cluster, < 100 MB diverged) | seconds-minutes | hours |
| Speed (1 TB cluster, 100 GB diverged) | similar to basebackup | hours |
| Requires `wal_log_hints` OR checksums | yes | no |
| Requires source running | only for `--source-server` | yes |
| Discards target data after divergence | yes | yes (fresh start) |
| Cross-version | no | no (must match major) |
| Setup complexity | medium (role, hba, hints) | low |

**Rule of thumb:** prefer pg_rewind when (cluster > 100 GB) AND (divergence < 10 % of cluster size) AND (prerequisites met). Else use `pg_basebackup`.

### 12. Run pg_rewind from Patroni / cluster manager

Patroni invokes pg_rewind automatically during automatic failover if `use_pg_rewind: true` in the `postgresql` section of `patroni.yml`. See [`79-patroni.md`](./79-patroni.md).

Manual invocation (when Patroni declines to rewind, e.g., wal_log_hints off):

```yaml
# patroni.yml
postgresql:
  use_pg_rewind: true
  remove_data_directory_on_rewind_failure: true   # if rewind fails, fall back to pg_basebackup
  remove_data_directory_on_diverged_timelines: true
  parameters:
    wal_log_hints: 'on'
```

### 13. Dry-run to estimate work

```bash
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server='host=new-primary user=rewind_role' \
  --dry-run \
  --debug \
  2>&1 | tee /tmp/pg-rewind-dry-run.log

# Search for total work estimate:
grep -E "(divergence|chunks|files)" /tmp/pg-rewind-dry-run.log
```

Verbatim docs (`--dry-run`):

> "Do everything except actually modifying the target directory."

---

## Gotchas

1. **`wal_log_hints=off` AND `data_checksums=off` at divergence time → pg_rewind cannot run for that divergence.** Cannot retroactively enable. Must rebuild via `pg_basebackup`. Set `wal_log_hints=on` on every production cluster as a baseline — restart-only GUC.

2. **PG18 default checksums** trips pg_upgrade audits: in-place upgrade from PG12-17 (checksums off by default) to PG18 (checksums on by default) errors with `--no-data-checksums` requirement. See [`86-pg-upgrade.md`](./86-pg-upgrade.md). Does NOT retroactively satisfy pg_rewind for past divergence.

3. **`full_page_writes=off` breaks pg_rewind.** Some operators disable it for performance — disable kills durability AND pg_rewind. Verbatim docs warn against it. See [`33-wal.md`](./33-wal.md) gotcha #8.

4. **Target's WAL since divergence must be present in `pg_wal/` OR fetchable via `restore_command`.** If target ran `pg_archivecleanup` aggressively post-failover, segments may be gone. Use `--restore-target-wal` PG13+.

5. **pg_rewind discards target's post-divergence writes silently.** No warning, no audit. Always: byte-level backup target first via `cp -a`. Optionally extract via `pg_waldump` + `pg_dump` if split-brain suspected.

6. **`--source-pgdata` requires source cleanly shut down.** Crashed-but-not-restarted source = error. Verify via `pg_controldata | grep state` — wants `shut down`, not `in production` or `shut down in recovery`.

7. **Target must be cleanly shut down OR pg_rewind auto-runs single-user recovery (PG13+).** Pre-PG13 you must `pg_ctl start; pg_ctl stop` manually. PG13+ `--no-ensure-shutdown` disables auto-recovery if you've already done it.

8. **Cross-architecture pg_rewind is impossible.** Source + target must be same hardware architecture (x86_64 + x86_64) AND same OS family (Linux + Linux, etc.). Source + target must be same major PG version. Same `initdb` lineage.

9. **pg_rewind does not start the target server.** After successful rewind target stays stopped. You start it as standby, replay source's WAL from `pg_wal/`.

10. **Tablespaces outside `PGDATA` are rewound too.** pg_rewind walks `pg_tblspc` symlinks. Tablespace directories on different filesystems get the same treatment as `PGDATA`. Ensure target's tablespaces exist at the same paths as on source.

11. **Pre-PG16: timeline-tracking edge case.** If pg_rewind runs after promotion but before a checkpoint on new primary, may falsely report "no rewind required." Force `CHECKPOINT;` on source before rewind on pre-PG16. PG16+ fixed (Heikki Linnakangas).

12. **`--restore-target-wal` PG13+ runs `restore_command` directly without a running server.** Command must be self-contained (no `psql` calls, no `SELECT * FROM pg_settings`).

13. **`--write-recovery-conf` PG13+ requires `--source-server`.** Not compatible with `--source-pgdata`. Manual standby.signal + postgresql.auto.conf edits if using filesystem source.

14. **PG18+ records `dbname` in `--write-recovery-conf`** if specified in connection string. Pre-PG18 strips it. Don't omit `dbname` if you want it captured on PG18+ for log attribution.

15. **Source-server role needs SCRAM-SHA-256 + `pg_hba.conf` entry.** Common oversight: role created but `pg_hba.conf` not edited → `FATAL: no pg_hba.conf entry`. Reload after editing.

16. **pg_rewind is atomic per relation block but NOT atomic at the data-directory level.** If killed mid-rewind, target is left in an indeterminate state. Restore from your `cp -a` byte-level backup.

17. **`--dry-run` prints to stdout, does not modify target.** Use to estimate work + permissions before real run.

18. **`pg_basebackup` is preferred for small clusters (< 50 GB) — setup cost of pg_rewind exceeds savings.** pg_rewind shines on TB-scale clusters with small divergence.

19. **`max_replication_slots` + `max_wal_senders` on source need slots for pg_rewind connections.** Default sufficient; tune if running multiple parallel rewinds (rare). See [`75-replication-slots.md`](./75-replication-slots.md).

20. **PG14+ supports rewinding standbys.** Pre-PG14 only former primaries. If using older PG version, plan accordingly.

21. **PG15+ `--config-file` for non-PGDATA postgresql.conf.** Some operators put `postgresql.conf` outside PGDATA (Debian convention `/etc/postgresql/16/main/postgresql.conf`). Pre-PG15 single-user crash-recovery step couldn't find it.

22. **PG17+ `--sync-method`** matches `pg_basebackup --sync-method` for tuning fsync behavior at end of rewind. Default `fsync` for durability — only change if you understand tradeoffs.

23. **pg_rewind does NOT migrate logical replication slots from source to target.** Slots are recreated as part of the rewound directory's catalog state, but their position is set to source's current LSN. If you have failover slots PG17+ (`failover=true`), they sync via the standby slot-sync mechanism, not via pg_rewind. See [`75-replication-slots.md`](./75-replication-slots.md).

---

## See Also

- [`33-wal.md`](./33-wal.md) — WAL fundamentals, `wal_log_hints`, `full_page_writes`, segments, timelines
- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical streaming replication setup
- [`75-replication-slots.md`](./75-replication-slots.md) — slots survive pg_rewind via catalog; logical-slot failover via PG17+ sync
- [`77-standby-failover.md`](./77-standby-failover.md) — `pg_promote()`, timeline switch, controlled switchover
- [`78-ha-architectures.md`](./78-ha-architectures.md) — pg_rewind's role in HA toolchains
- [`79-patroni.md`](./79-patroni.md) — Patroni's `use_pg_rewind` flag + `remove_data_directory_on_rewind_failure` fallback
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — `pg_basebackup` as the fallback when pg_rewind cannot run
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — cross-version impossibility; in-place major-version upgrade alternatives
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — pg_rewind as the recommended rollback path after a failed pg_upgrade or blue/green cutover
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `pg_checksums --enable` offline conversion to satisfy pg_rewind prerequisite; byte-level-backup discipline before destructive tools
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — full DR runbook incorporating pg_rewind for re-attachment phase
- [`46-roles-privileges.md`](./46-roles-privileges.md) — non-superuser source-server role
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — pg_hba.conf entry for rewind connection

---

## Sources

[^1]: PostgreSQL 16 pg_rewind docs — https://www.postgresql.org/docs/16/app-pgrewind.html
[^2]: PostgreSQL 17 pg_rewind docs — https://www.postgresql.org/docs/17/app-pgrewind.html
[^3]: PostgreSQL 18 pg_rewind docs — https://www.postgresql.org/docs/18/app-pgrewind.html
[^4]: PostgreSQL 16 warm-standby + timeline docs — https://www.postgresql.org/docs/16/warm-standby.html
[^5]: PostgreSQL 16 continuous archiving + restore_command — https://www.postgresql.org/docs/16/continuous-archiving.html
[^6]: PostgreSQL 16 runtime-config-wal (wal_log_hints, full_page_writes) — https://www.postgresql.org/docs/16/runtime-config-wal.html
[^7]: PostgreSQL 18 runtime-config-wal — https://www.postgresql.org/docs/18/runtime-config-wal.html
[^8]: PostgreSQL 13 release notes — https://www.postgresql.org/docs/release/13.0/ — Paul Guo, Jimmy Yih, Ashwin Agrawal: *"Add an option to pg_rewind to configure standbys. This matches pg_basebackup's --write-recovery-conf option."* / Alexey Kondratov: *"Allow pg_rewind to use the target cluster's restore_command to retrieve needed WAL. This is enabled using the -c/--restore-target-wal option."* / *"Have pg_rewind automatically run crash recovery before rewinding. This can be disabled by using --no-ensure-shutdown."*
[^9]: PostgreSQL 14 release notes — https://www.postgresql.org/docs/release/14.0/ — Heikki Linnakangas: *"Allow standby servers to be rewound via pg_rewind."*
[^10]: PostgreSQL 15 release notes — https://www.postgresql.org/docs/release/15.0/ — Gunnar Bluth: *"Add pg_rewind option --config-file to simplify use when server configuration files are stored outside the data directory."*
[^11]: PostgreSQL 16 release notes — https://www.postgresql.org/docs/release/16.0/ — Heikki Linnakangas: *"Allow pg_rewind to properly track timeline changes. Previously if pg_rewind was run after a timeline switch but before a checkpoint was issued, it might incorrectly determine that a rewind was unnecessary."*
[^12]: PostgreSQL 17 release notes — https://www.postgresql.org/docs/release/17.0/ — Justin Pryzby, Nathan Bossart: *"Add the --sync-method parameter to several client applications. The applications are initdb, pg_basebackup, pg_checksums, pg_dump, pg_rewind, and pg_upgrade."*
[^13]: PostgreSQL 18 release notes — https://www.postgresql.org/docs/release/18.0/ — Masahiko Sawada: *"If pg_rewind's --source-server specifies a database name, use it in --write-recovery-conf output."* / Greg Sabino Mullane: *"Change initdb to default to enabling checksums."*

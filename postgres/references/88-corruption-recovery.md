# Corruption Detection and Recovery

Data-page checksums, `pg_amcheck` / `amcheck`, `pg_checksums` offline conversion, `zero_damaged_pages`, single-user mode (`postgres --single`), `pg_resetwal` (last-resort), and `pg_dump` as a corruption diagnostic. Covers PG14 → PG18 surface.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Data Checksums](#data-checksums)
    - [`pg_amcheck` and `amcheck`](#pg_amcheck-and-amcheck)
    - [`pg_checksums` Offline Conversion](#pg_checksums-offline-conversion)
    - [`zero_damaged_pages` and `ignore_checksum_failure`](#zero_damaged_pages-and-ignore_checksum_failure)
    - [`ignore_system_indexes`](#ignore_system_indexes)
    - [Single-User Mode (`postgres --single`)](#single-user-mode-postgres---single)
    - [`pg_resetwal` Last-Resort Recovery](#pg_resetwal-last-resort-recovery)
    - [`pg_dump` as Corruption Diagnostic](#pg_dump-as-corruption-diagnostic)
    - [WAL Reliability + Underlying Storage](#wal-reliability--underlying-storage)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick this file when:

- Cluster won't start with errors like `invalid page in block`, `could not read block`, `unexpected zero page at`, `invalid contrecord`.
- `SELECT` against a table returns `ERROR: invalid page in block N of relation base/...`.
- Suspected silent corruption (planner output disagrees with `COUNT(*)`, missing rows after crash, replica mismatch).
- Planning to enable data-page checksums on an existing cluster.
- Running pre-upgrade integrity check before `pg_upgrade` or major-version migration.
- Index-corruption investigation (`bt_index_check` / `bt_index_parent_check` / `verify_heapam` / `gin_index_check` PG18+).
- Last-resort recovery when WAL or `pg_control` is corrupted and the server won't start.

Pick different file when:

- Restoring from backup → [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md), [`85-backup-tools.md`](./85-backup-tools.md), [`90-disaster-recovery.md`](./90-disaster-recovery.md).
- Re-attaching a diverged former primary → [`89-pg-rewind.md`](./89-pg-rewind.md).
- Transaction-ID wraparound emergency → [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).
- VACUUM / autovacuum tuning → [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

## Mental Model

Five rules.

**Rule 1 — Data checksums detect corruption; they do NOT repair it.** When a page checksum mismatch is detected on read, the backend raises an error and aborts the transaction. The detection moves silent disk corruption into a loud, blocking failure — that's the design. Repair requires restoring the affected pages from a backup or replaying WAL. `pg_checksums` enables/disables/verifies cluster-wide; it cannot correct mismatches.

**Rule 2 — Indexes corrupt independently of heap.** Heap bytes can be intact while a B-tree index disagrees with the underlying rows (or vice versa). `amcheck` separates the two checks: `bt_index_check` / `bt_index_parent_check` for B-tree structure, `verify_heapam` (PG14+) for heap pages, `gin_index_check` (PG18+) for GIN. Routine `bt_index_check` runs under `AccessShareLock` — safe on a live primary. `bt_index_parent_check` upgrades to `ShareLock` and blocks writes.

**Rule 3 — `pg_resetwal` is last-resort and destroys data integrity guarantees.** Verbatim docs warning: *"It should be used only as a last resort, when the server will not start due to such corruption. After running this command, it should be possible to start the server, but bear in mind that the database might contain inconsistent data due to partially-committed transactions. You should immediately dump your data, run initdb, and restore."*[^pg-resetwal] Treat the post-`pg_resetwal` cluster as a one-shot dump source, not a production cluster.

**Rule 4 — Single-user mode is for catalog rescue and wraparound emergencies, not interactive debugging.** Verbatim: *"The primary use for this mode is during bootstrapping by initdb. Sometimes it is used for debugging or disaster recovery; note that running a single-user server is not truly suitable for debugging the server, since no realistic interprocess communication and locking will happen."*[^postgres-single] No background processing — no autovacuum, no checkpointer, no replication. Use it for `VACUUM FREEZE` when autovacuum can't start (wraparound), for `REINDEX SYSTEM` when a system catalog index is broken, and as a path into a cluster that won't accept multi-user connections.

**Rule 5 — Test corruption hypothesis with `pg_dump` before invoking destructive tools.** If a `pg_dump` of the entire cluster succeeds, the storage is internally consistent enough for logical extraction — corruption is likely localized. If `pg_dump` fails on a specific table or index, the failure narrows the investigation. Run `pg_dump -Fc --no-blobs --schema-only` first (catalog walk), then `pg_dump -Fc` (full extraction). `pg_dump` reads every visible row through MVCC; it surfaces page-level corruption as it goes.

> [!WARNING] `pg_resetwal` and `zero_damaged_pages` destroy data
> Both tools allow the cluster to keep running by skipping over corrupted bytes — but the bytes they skip are *real rows*. `pg_resetwal` discards uncommitted-but-WAL-only changes (in-flight transactions) and may reuse OIDs from committed-but-not-yet-checkpointed pages. `zero_damaged_pages` zeroes a damaged 8 KB page in memory destroying every tuple on it. Both produce a cluster suitable for one `pg_dump` and one `initdb`+restore, nothing more. Take a `cp -a $PGDATA` byte-level copy BEFORE touching either.

> [!WARNING] PG18: data checksums on by default
> Verbatim PG18 release-note: *"Change initdb to default to enabling checksums. The new initdb option `--no-data-checksums` disables checksums."*[^pg18-checksums-default] Clusters initialized on PG18+ have checksums on out of the box. `pg_upgrade` from a non-checksum cluster onto a PG18+ default-checksum new cluster fails the consistency-check phase — initialize the new cluster with `initdb --no-data-checksums`, then run `pg_checksums --enable` post-upgrade once the cluster is stopped.

## Decision Matrix

13 rows mapping symptom / goal to tool.

| Symptom / goal | Tool / action | Notes |
|---|---|---|
| `ERROR: invalid page in block N` on a query | `amcheck` → identify corrupt index vs heap; restore page from backup. | Cross-reference Recipe 4. |
| Suspect silent corruption (no error yet) | `pg_amcheck --all --jobs=N` weekly. | PG14+. |
| Suspect index corruption only | `SELECT bt_index_check('myidx'::regclass);` | `AccessShareLock` — safe in production. |
| Suspect index structure + parent/child invariants | `SELECT bt_index_parent_check('myidx'::regclass);` | `ShareLock` — blocks writes. |
| Suspect heap corruption | `SELECT * FROM verify_heapam('mytable'::regclass);` | PG14+. Returns one row per corruption. |
| Suspect GIN-index corruption | `SELECT gin_index_check('myidx'::regclass);` | PG18+. |
| Enable checksums on existing cluster | `pg_checksums --enable -D $PGDATA` | Cluster must be **cleanly shut down**. |
| Verify checksums on offline cluster | `pg_checksums --check -D $PGDATA` | Default mode. |
| Cluster will not start, WAL corrupt | `pg_resetwal -D $PGDATA` then dump+restore | Last resort. Take byte-level backup first. |
| Catalog-index corruption blocks startup | `postgres --single` + `REINDEX SYSTEM <db>` | Then restart normally. |
| Wraparound emergency, autovacuum can't run | `postgres --single` + `VACUUM FREEZE` | Cross-reference [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md). |
| Pre-upgrade integrity check | `pg_amcheck --all`, then `pg_dump --schema-only` | Run on a recent base-backup replica, not production. |
| Damaged page on one block, willing to lose rows | `SET zero_damaged_pages = on;` then `VACUUM FULL` table | **Destructive** — last resort before restore from backup. |

Three smell signals — wrong tool for the situation:

- **`pg_resetwal -f` as a first response to a startup error.** Read the log first. Most "won't start" cases are recoverable without resetting WAL (config error, missing tablespace mount, exhausted disk, wraparound).
- **`zero_damaged_pages = on` set cluster-wide as a "safety" default.** This is a one-shot escape hatch, not a configuration. Setting it cluster-wide can mask further corruption and propagate zeroed pages to disk during the next checkpoint.
- **Running `bt_index_parent_check` on every index in production.** Acquires `ShareLock` — blocks writes. Use `bt_index_check` for routine; reserve `--parent-check` / `bt_index_parent_check` for after-the-fact incident investigation on a maintenance window.

## Mechanics

### Data Checksums

Per-page CRC-style checksum on data pages. Detects bit-rot, partial writes that escape `full_page_writes`, and bad RAM / disk I/O. Verbatim docs: *"By default, data pages are not protected by checksums, but this can optionally be enabled for a cluster. When enabled, each data page includes a checksum that is updated when the page is written and verified each time the page is read."*[^checksums-chapter]

**What's protected:**

- Data pages (8 KB blocks of relations, indexes, TOAST, sequences).

**What's NOT protected (separate mechanisms):**

- Internal data structures (clog, multixact, subtransactions). Use CRC-protected WAL.
- Temporary files.
- WAL records themselves — those have CRC-32C per record (separate from page checksums)[^wal-reliability].

**Enabling:**

- At `initdb` time: `initdb --data-checksums` (or `-k`)[^initdb-checksums]. PG18+: on by default; opt out with `--no-data-checksums`[^pg18-checksums-default].
- Offline conversion on existing cluster: `pg_checksums --enable -D $PGDATA` (server stopped)[^pg-checksums].

**Reading the state:**

    SHOW data_checksums;

Or from `pg_controldata` on a stopped cluster: `Data page checksum version: 1` (enabled) vs `0` (disabled).

**Failure observation:** Checksum mismatches are reported to the client and counted in `pg_stat_database.checksum_failures` (and `checksum_last_failure` timestamp).

> [!NOTE] PostgreSQL 12
> `pg_checksums` introduced as offline `--enable` / `--disable` / `--check` utility. Before PG12, the only way to flip checksums was to dump + `initdb -k` + restore.

> [!NOTE] PostgreSQL 18
> Verbatim: *"Change initdb to default to enabling checksums (Greg Sabino Mullane). The new initdb option `--no-data-checksums` disables checksums."*[^pg18-checksums-default] `pg_upgrade` cross-checksum-setting upgrade now requires explicit alignment.

**Performance impact:** Enabling checksums adds CPU work on every page read and write. Verbatim from `initdb` docs: *"Enabling checksums may incur a noticeable performance penalty."*[^initdb-checksums] Modern hardware (post-2018) handles it; benchmark on representative workload if uncertain.

### `pg_amcheck` and `amcheck`

`amcheck` is a contrib extension. `pg_amcheck` is a CLI wrapper (PG14+) that orchestrates `amcheck` calls across many relations in parallel.

**Verbatim PG14 release-note:** *"Add command-line utility pg_amcheck to simplify running contrib/amcheck tests on many relations (Mark Dilger)."*[^pg14-pgamcheck]

**Verbatim PG14 release-note:** *"Allow amcheck to also check heap pages (Mark Dilger). Previously it only checked B-Tree index pages."*[^pg14-verifyheap]

**Install:**

    CREATE EXTENSION amcheck;

**Three core functions (PG14+):**

| Function | Lock | Purpose |
|---|---|---|
| `bt_index_check(index regclass, heapallindexed boolean)` | `AccessShareLock` | Lightweight B-tree structural check. Safe in production. |
| `bt_index_parent_check(index regclass, heapallindexed boolean, rootdescend boolean)` | `ShareLock` | Adds parent/child invariant checks. Blocks writes. Not on hot standby. |
| `verify_heapam(relation regclass, on_error_stop boolean, check_toast boolean, skip text, startblock bigint, endblock bigint)` | `AccessShareLock` | Heap page check — PG14+. Returns one row per corruption: `(blkno, offnum, attnum, msg)`. |

**Verbatim docs on `bt_index_check`:** *"When a routine, lightweight test for corruption is required in a live production environment, using bt_index_check often provides the best trade-off between thoroughness of verification and limiting the impact on application performance and availability."*[^amcheck-docs]

**Verbatim docs on `bt_index_parent_check`:** *"bt_index_parent_check can be thought of as a more thorough variant of bt_index_check: unlike bt_index_check, bt_index_parent_check also checks invariants that span parent/child relationships."*[^amcheck-docs]

**`heapallindexed`:** When true, verifies every visible heap tuple has a matching index entry. Catches index-misses (silent UPDATE-skipping bugs). Slower than structural check alone.

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow amcheck to check sequences (Mark Dilger)."*[^pg15-amcheck-seq] *"Improve amcheck sanity checks for TOAST tables (Mark Dilger)."*[^pg15-amcheck-toast]

> [!NOTE] PostgreSQL 17
> Verbatim: *"Allow amcheck to check for unique constraint violations using new option --checkunique (Anastasia Lubennikova, Pavel Borisov, Maxim Orlov)."*[^pg17-checkunique] Detects unique-index violations where index says "unique" but heap holds duplicate rows.

> [!NOTE] PostgreSQL 18
> Verbatim: *"Add amcheck check function gin_index_check() to verify GIN indexes (Grigory Kryachko, Heikki Linnakangas, Andrey Borodin)."*[^pg18-gin-check] Closes the longstanding GIN-cant-be-checked gap.

**`pg_amcheck` CLI key flags:**

| Flag | Behavior |
|---|---|
| `-a, --all` | All databases, all relations. |
| `-d, --database=PATTERN` | Match databases. |
| `-D, --exclude-database=PATTERN` | Exclude. |
| `-t, --table=PATTERN` | Tables / matviews / sequences. |
| `-i, --index=PATTERN` | Indexes only. |
| `-r, --relation=PATTERN` | Tables OR indexes. |
| `-s, --schema=PATTERN` | Schemas. |
| `-j, --jobs=N` | Parallel connections. |
| `--parent-check` | Use `bt_index_parent_check` (locks heavier). |
| `--rootdescend` | Re-finds tuples via root scan; implies `--parent-check`. |
| `--heapallindexed` | Verify every heap tuple is indexed. |
| `--no-dependent-indexes` | Skip cascade-checking a table's indexes. |
| `--no-dependent-toast` | Skip TOAST table on table check. |
| `--install-missing` | Auto-create the `amcheck` extension. |
| `--checkunique` | PG17+ — verify unique constraints. |
| `-P, --progress` | Progress to stderr. |
| `-v, --verbose` | More output. |

### `pg_checksums` Offline Conversion

Verbatim docs: *"pg_checksums checks, enables or disables data checksums in a PostgreSQL cluster."*[^pg-checksums] *"The server must be shut down cleanly before running pg_checksums."*[^pg-checksums]

| Mode | Behavior |
|---|---|
| `--check` (default) | Verify every page; exit nonzero on first checksum failure. |
| `--enable` | Rewrite every page with its computed checksum, flip cluster-control flag on. |
| `--disable` | Flip cluster-control flag off (no page rewrites). |

**Critical caveats:**

- Cluster MUST be cleanly shut down (`pg_ctl stop -m fast` not `-m immediate`; `pg_controldata` must show `Database cluster state: shut down`).
- `--enable` is time-proportional to data size — every relation page gets read, checksummed, and rewritten. For TB clusters, plan multi-hour offline window.
- Verbatim warning: *"Enabling checksums in a large cluster can potentially take a long time. During this operation, the cluster or other programs that write to the data directory must not be started or else data loss may occur."*[^pg-checksums]
- On replicated clusters: run on each replica separately AFTER stopping replication, then re-sync. Don't enable on the primary while standbys are streaming.

### `zero_damaged_pages` and `ignore_checksum_failure`

Both are developer GUCs — destructive escape hatches.

Verbatim `zero_damaged_pages` docs: *"Detection of a damaged page header normally causes PostgreSQL to report an error, aborting the current transaction. Setting zero_damaged_pages to on causes the system to instead report a warning, zero out the damaged page in memory, and continue processing. This behavior will destroy data, namely all the rows on the damaged page. However, it does allow you to get past the error and retrieve rows from any undamaged pages that might be present in the table."*[^zero-damaged]

Verbatim `ignore_checksum_failure` docs: *"Setting ignore_checksum_failure to on causes the system to ignore the failure (but still report a warning), and continue processing. This behavior may cause crashes, propagate or hide corruption, or other serious problems."*[^ignore-checksum]

**Distinction:**

- `zero_damaged_pages` — fires on **page-header** corruption (the layout-byte sanity check). Zeroes the page in memory; subsequent checkpoint persists the zeroed page to disk.
- `ignore_checksum_failure` — fires only on **checksum** mismatch; only meaningful when data checksums are enabled. Reads the page anyway and lets the backend continue.

**Usage pattern (last-resort, destructive):**

    -- Session-local:
    SET LOCAL zero_damaged_pages = on;
    -- Force the damaged page to be loaded, zeroed, and (eventually) checkpointed:
    VACUUM FULL mytable;       -- or: SELECT * FROM mytable;
    -- IMMEDIATELY pg_dump and restore. The zeroed page is now real.

### `ignore_system_indexes`

Bypasses system-catalog indexes (`pg_class`'s indexes, `pg_attribute`'s, etc.) when reading catalogs. Useful when a system index itself is corrupt and would otherwise block the backend from looking up table metadata.

- **Cannot be changed after session start** — must be set via `-c ignore_system_indexes=on` to `postgres --single` or `postmaster -c ignore_system_indexes=on` at startup.
- Catalog writes still update the (broken) system indexes — eventual `REINDEX SYSTEM <db>` is required to clear the underlying issue.

### Single-User Mode (`postgres --single`)

Verbatim docs: *"The primary use for this mode is during bootstrapping by initdb. Sometimes it is used for debugging or disaster recovery; note that running a single-user server is not truly suitable for debugging the server, since no realistic interprocess communication and locking will happen."*[^postgres-single] *"The single-user mode server does not provide sophisticated line-editing features."*[^postgres-single] *"Single-user mode also does not do any background processing, such as automatic checkpoints or replication."*[^postgres-single] *"This user does not actually have to exist, so the single-user mode can be used to manually recover from certain kinds of accidental damage to the system catalogs."*[^postgres-single]

**Invocation:**

    postgres --single -D /var/lib/postgresql/16/main mydb

Rules:

- `--single` MUST be the **first** argument.
- Database name MUST be the **last** argument (default: current OS user).
- Set `-D` or `PGDATA`.
- Session user gets implicit superuser via uid=1.

**Newline = end of statement** (unlike psql). Two ways to span lines:

- Backslash-continue: end intermediate lines with `\`.
- `-j` flag: switch terminator to `;\n\n` (semicolon, newline, blank line) so multi-line statements parse the way you'd expect from a script.

**Canonical uses:**

- **Wraparound emergency** when autovacuum can't start: `VACUUM FREEZE;` cross-reference [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).
- **System-index corruption:** `REINDEX SYSTEM <dbname>;` then exit and start the multi-user server normally.
- **Catalog manual surgery:** rare; e.g., delete a stuck row from `pg_class` after a crash mid-CREATE.

**Cannot do in single-user mode:**

- Run two psql sessions side-by-side (it's single-process by definition).
- Use `LISTEN` / `NOTIFY` (no IPC).
- Replication — `walsender` doesn't run.
- Connect via TCP — Unix socket only, but `psql` cannot connect either; you talk to the process via its own stdin/stdout.

### `pg_resetwal` Last-Resort Recovery

Verbatim docs: *"clears the write-ahead log (WAL) and optionally resets some other control information stored in the pg_control file. This function is sometimes needed if these files have become corrupted. It should be used only as a last resort, when the server will not start due to such corruption."*[^pg-resetwal]

Verbatim: *"After running this command, it should be possible to start the server, but bear in mind that the database might contain inconsistent data due to partially-committed transactions. You should immediately dump your data, run initdb, and restore. After restore, check for inconsistencies and repair as needed."*[^pg-resetwal]

Verbatim about `-f` / `--force`: *"the recovered database must be treated with even more suspicion than usual: an immediate dump and restore is imperative. Do not execute any data-modifying operations in the database before you dump, as any such action is likely to make the corruption worse."*[^pg-resetwal]

**When it's the right answer:**

- `pg_control` is unreadable or contains a checksum that fails.
- WAL files in `pg_wal/` are missing or truncated at the current segment.
- The server logs `could not locate a valid checkpoint record`.

**When it's NOT the right answer:**

- Cluster ran out of disk and won't start — free space, don't reset WAL.
- Wraparound shutdown — use `postgres --single` + `VACUUM FREEZE`, not `pg_resetwal`.
- `invalid page in block N of relation ...` from one table — that's a relfile issue, not a WAL issue. Use `amcheck` + page surgery + restore from backup.

**Procedure (when truly necessary):**

    # 1. Stop the server. Confirm it's stopped:
    pg_ctl -D $PGDATA stop -m immediate
    pg_controldata $PGDATA | grep "Database cluster state"
    # Expected: "Database cluster state: shut down" — if not, try -m fast first.

    # 2. Take a byte-level backup:
    cp -a $PGDATA /backup/cluster-pre-resetwal-$(date +%F)

    # 3. Dry run — inspect what pg_resetwal would set:
    pg_resetwal -n -D $PGDATA

    # 4. Actually reset (only if dry run looks sane):
    pg_resetwal -D $PGDATA

    # 5. Start the cluster:
    pg_ctl -D $PGDATA start

    # 6. IMMEDIATELY: pg_dumpall > rescue.sql

    # 7. initdb a fresh cluster, restore from rescue.sql.

PG18+ also adds `--char-signedness` to `pg_resetwal` for cross-platform restoration scenarios — verbatim: *"Add pg_resetwal option --char-signedness to change the default char signedness (Masahiko Sawada)."*[^pg18-charsign-resetwal]

### `pg_dump` as Corruption Diagnostic

`pg_dump` reads every row through the executor. If a page is corrupt and the rows on it are visible to the dump snapshot, `pg_dump` either:

- Errors out with `ERROR: invalid page in block N` — narrows the corruption to a specific relation + block, OR
- Successfully extracts every readable row, proving the cluster is logically consistent (no missing rows from visible snapshot's view).

**Three-pass diagnostic:**

    # Pass 1 — fast: catalog walk + schema-only. Detects catalog-side issues.
    pg_dump -d mydb --schema-only -Fc -f /dev/null 2> /tmp/dump-schema.log

    # Pass 2 — full extraction, sequential. Detects heap + index corruption.
    pg_dump -d mydb -Fc -f /dev/null 2> /tmp/dump-full.log

    # Pass 3 — per-table parallel narrows the failing relation:
    pg_dump -d mydb -Fd -j 8 -f /tmp/dump-parallel 2> /tmp/dump-parallel.log

What `pg_dump` does NOT catch:

- Index corruption where heap is fine and index just has wrong entries — `pg_dump` reads heap directly via sequential scan; it never traverses indexes.
- Visibility/MVCC corruption where rows are present but marked invisible.
- Corruption on pages that hold no live visible rows from `pg_dump`'s snapshot view.

That's why `pg_amcheck` (heap + index) is the canonical pre-upgrade audit, not `pg_dump`.

### WAL Reliability + Underlying Storage

Page checksums and `amcheck` detect corruption that's already on disk. Preventing it requires correct WAL durability settings + reliable storage.

**Verbatim docs on full_page_writes:** *"To guard against such failures, PostgreSQL periodically writes full page images to permanent WAL storage before modifying the actual page on disk. By doing this, during crash recovery PostgreSQL can restore partially-written pages from WAL."*[^wal-reliability]

**Verbatim docs on WAL CRC:** *"Each individual record in a WAL file is protected by a CRC-32C (32-bit) check that allows us to tell if record contents are correct. The CRC value is set when we write each WAL record and checked during crash recovery, archive recovery and replication."*[^wal-reliability]

**Don't disable for "performance":**

- `fsync = off` — crash-unsafe; cluster can corrupt on power loss.
- `full_page_writes = off` — only safe on filesystems that guarantee atomic 8 KB writes (ZFS, btrfs with the right options); cross-reference [`33-wal.md`](./33-wal.md).
- `synchronous_commit = off` — loses recent committed transactions on crash but does not corrupt the cluster.

Cross-reference [`33-wal.md`](./33-wal.md) and [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md).

## Per-Version Timeline

| Version | Corruption surface |
|---|---|
| **PG14** | `pg_amcheck` CLI introduced (Mark Dilger)[^pg14-pgamcheck]. `amcheck` extended to check heap pages — `verify_heapam` (Mark Dilger)[^pg14-verifyheap]. |
| **PG15** | `amcheck` extended to sequences (Mark Dilger)[^pg15-amcheck-seq]. `amcheck` improved TOAST sanity checks (Mark Dilger)[^pg15-amcheck-toast]. |
| **PG16** | No direct corruption-recovery surface changes. |
| **PG17** | `amcheck --checkunique` (Anastasia Lubennikova, Pavel Borisov, Maxim Orlov)[^pg17-checkunique] — detect unique-constraint violations where index claims uniqueness but heap has duplicates. |
| **PG18** | `gin_index_check()` (Grigory Kryachko, Heikki Linnakangas, Andrey Borodin)[^pg18-gin-check]. `initdb` defaults to `--data-checksums` (Greg Sabino Mullane)[^pg18-checksums-default]. `pg_resetwal --char-signedness` (Masahiko Sawada)[^pg18-charsign-resetwal]. |

## Examples / Recipes

### Recipe 1 — Routine `pg_amcheck` Weekly Sweep

Production baseline. Runs as a `pg_cron` (or systemd) weekly job. Cross-reference [`98-pg-cron.md`](./98-pg-cron.md).

    pg_amcheck \
        --all \
        --jobs=4 \
        --install-missing \
        --progress \
        --verbose \
        2>&1 | tee /var/log/postgresql/amcheck-$(date +%F).log

    # Exit code 0 = no corruption. Anything else = investigate.
    # Use --parent-check for deep audit only during scheduled windows
    # (it acquires ShareLock and blocks writes on each index).

Alert when log contains the words `corruption`, `inconsistent`, or `invalid`.

### Recipe 2 — Find a Specific Index's Corruption

Production-safe interactive investigation:

    -- AccessShareLock — won't block writes:
    SELECT bt_index_check('public.users_email_idx'::regclass, heapallindexed => true);
    -- If this raises, the index is corrupt OR the heap has rows the index missed.

    -- ShareLock — only if writes can pause:
    SELECT bt_index_parent_check('public.users_email_idx'::regclass,
                                  heapallindexed => true,
                                  rootdescend => true);

Fix path for B-tree:

    REINDEX INDEX CONCURRENTLY public.users_email_idx;

Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md).

### Recipe 3 — Find Heap Corruption Block by Block

    -- PG14+ verify_heapam:
    SELECT * FROM verify_heapam('public.orders'::regclass,
                                 on_error_stop => false,
                                 check_toast    => true);

    -- Returns one row per corruption finding:
    -- blkno | offnum | attnum | msg
    -- ------+--------+--------+-----------------------------------
    --   147 |     12 |      3 | toast value 23456789 not found in toast table
    --   147 |     14 |      0 | invalid lp_off + lp_len combination

For a fast survey of all heap relations in a database:

    SELECT n.nspname, c.relname,
           v.blkno, v.offnum, v.attnum, v.msg
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL verify_heapam(c.oid, on_error_stop => false) v
    WHERE c.relkind IN ('r','m','S')
      AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY n.nspname, c.relname;

### Recipe 4 — Diagnose `invalid page in block N of relation`

Hit during query or VACUUM. Triage:

    -- 1. Identify the relfile from the OID in the error message
    --    (the path looks like `base/16384/24576`):
    SELECT relname, pg_relation_filepath(oid)
    FROM pg_class WHERE oid = 24576;

    -- 2. Determine if it's an index or a heap:
    SELECT relkind FROM pg_class WHERE oid = 24576;
    -- 'r' = heap, 'i' = index, 't' = TOAST table, 'm' = matview.

    -- 3a. If index: drop + recreate (lose nothing):
    REINDEX INDEX CONCURRENTLY corrupt_idx;

    -- 3b. If heap or TOAST: restore the file from a recent base backup
    --     (cross-reference 84-backup-physical-pitr.md), then replay WAL.

    -- 3c. If no backup AND can lose the rows on that page:
    SET LOCAL zero_damaged_pages = on;
    VACUUM FULL corrupt_table;
    -- Zeros the damaged page in memory; next checkpoint persists it.
    -- Dump and restore the whole cluster after this step.

### Recipe 5 — Enable Checksums on an Existing Cluster (Offline)

Cluster moving from `data_checksums = off` to `on`:

    # 1. Stop the cluster cleanly:
    pg_ctl -D $PGDATA stop -m fast

    # 2. Confirm clean shutdown:
    pg_controldata $PGDATA | grep "Database cluster state"
    # Must show "shut down" — not "shut down in recovery" or "in production".

    # 3. Dry-run check (default mode):
    pg_checksums --check -D $PGDATA

    # 4. Enable (rewrites every relation page — time proportional to data size):
    pg_checksums --enable --progress -D $PGDATA

    # 5. Verify the flip happened:
    pg_controldata $PGDATA | grep checksum
    # Expected: "Data page checksum version: 1"

    # 6. Start the cluster:
    pg_ctl -D $PGDATA start

For replicated clusters: do this on a stopped replica first, take a fresh `pg_basebackup` from the new-checksums replica, promote it, then re-sync the rest of the topology. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md).

### Recipe 6 — Single-User Mode for Wraparound Emergency

Database refuses connections, log says `database is not accepting commands to avoid wraparound data loss`. Cross-reference [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

    # 1. Stop the cluster:
    pg_ctl -D $PGDATA stop -m fast

    # 2. Enter single-user mode in the affected database:
    postgres --single -D $PGDATA mydb

    # At the backend > prompt (newline terminates):
    backend> VACUUM FREEZE;

    # 3. After VACUUM completes, Ctrl-D to exit.
    # 4. Start the cluster normally:
    pg_ctl -D $PGDATA start

If multiple databases need freezing, run `postgres --single` once per database.

### Recipe 7 — Single-User Mode for System-Index Corruption

Catalog index corrupt — backend can't look up its own tables.

    # 1. Stop the cluster:
    pg_ctl -D $PGDATA stop -m fast

    # 2. Start single-user with system-indexes ignored:
    postgres --single -D $PGDATA -c ignore_system_indexes=on mydb

    backend> REINDEX SYSTEM mydb;

    # 3. Ctrl-D, restart normally.

`REINDEX SYSTEM` rebuilds every system-catalog index in the database. Repeat in each affected database (and in `template1` if `pg_class` etc. are involved).

### Recipe 8 — `pg_resetwal` Last-Resort

Server won't start; log shows `could not locate a valid checkpoint record`:

    # 1. Confirm the server is stopped (no postmaster pid):
    pg_ctl -D $PGDATA status

    # 2. Byte-level backup of the data directory — ESSENTIAL:
    cp -a $PGDATA /backup/cluster-pre-resetwal-$(date -u +%FT%H%M%SZ)

    # 3. Dry run — see what pg_resetwal would set without writing:
    pg_resetwal -n -D $PGDATA

    # 4. Run for real:
    pg_resetwal -D $PGDATA

    # 5. Start:
    pg_ctl -D $PGDATA start

    # 6. IMMEDIATELY dump (do NOT do any writes first):
    pg_dumpall > /tmp/rescue.sql

    # 7. initdb a fresh cluster on new $PGDATA:
    /usr/lib/postgresql/16/bin/initdb --data-checksums -D /var/lib/postgresql/16/new

    # 8. Restore:
    psql -d postgres -f /tmp/rescue.sql

    # 9. Decommission the old data dir. Run pg_amcheck on the new one
    #    to confirm the restored cluster is clean.

Never write to the post-`pg_resetwal` cluster before dumping — verbatim: *"any such action is likely to make the corruption worse"*[^pg-resetwal].

### Recipe 9 — Recover One Damaged Page (Destructive)

When a single block is damaged, no backup is available, and losing the rows on that page is acceptable:

    -- 1. Confirm the block number from the error:
    --    ERROR: invalid page in block 147 of relation base/16384/24576

    -- 2. Identify the table:
    SELECT relname FROM pg_class WHERE pg_relation_filepath(oid) = 'base/16384/24576';
    -- => 'orders'

    -- 3. Save anything still readable from the table:
    \copy (SELECT * FROM orders) TO '/tmp/orders-survivors.csv' CSV HEADER
    -- This may itself raise on block 147 — capture what comes out before.

    -- 4. Set session-local zero_damaged_pages and force-read:
    SET LOCAL zero_damaged_pages = on;
    VACUUM FULL orders;
    -- The damaged page is zeroed in memory and persisted at next checkpoint.

    -- 5. Force checkpoint to persist the zeroed page (cross-reference 34):
    CHECKPOINT;

    -- 6. Run pg_amcheck on the cluster to confirm only this one
    --    relation lost data, nothing else surfaced:
    \q
    pg_amcheck --all --jobs=4

    -- 7. Plan a logical dump+restore (this cluster has a known-zeroed page).

### Recipe 10 — Pre-Upgrade Integrity Audit

Before `pg_upgrade` or major-version migration. Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md), [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

    # 1. Take a fresh base backup, restore to a disposable host
    #    (don't audit on production directly; lock impact + risk).
    pg_basebackup -h prod -D /tmp/audit -X stream -P

    # 2. Start the disposable cluster on a non-default port.

    # 3. Run pg_amcheck against everything:
    pg_amcheck --all --jobs=$(nproc) --heapallindexed --parent-check --rootdescend \
        --port=5433 2>&1 | tee /tmp/audit.log

    # 4. (PG17+) verify uniqueness:
    pg_amcheck --all --jobs=$(nproc) --checkunique --port=5433

    # 5. Confirm exit 0; otherwise investigate corruption before upgrade.

    # 6. Discard the disposable host.

### Recipe 11 — Monitor `pg_stat_database.checksum_failures`

Cross-reference [`82-monitoring.md`](./82-monitoring.md).

    SELECT datname, checksum_failures, checksum_last_failure
    FROM pg_stat_database
    WHERE checksum_failures > 0;

Wire into Prometheus alert:

    - alert: PostgresChecksumFailure
      expr: pg_stat_database_checksum_failures > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Postgres reported a data-page checksum failure on {{ $labels.datname }}"
        runbook: "See references/88-corruption-recovery.md Recipe 4"

### Recipe 12 — Find Tables Without Primary Key Before `verify_heapam` Hardening

Cross-reference [`74-logical-replication.md`](./74-logical-replication.md), [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).

`verify_heapam` works on any heap, but pre-corruption hardening benefits from PK existence (faster post-incident reconciliation).

    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_constraint p ON p.conrelid = c.oid AND p.contype = 'p'
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND p.oid IS NULL
    ORDER BY pg_total_relation_size(c.oid) DESC;

### Recipe 13 — Diagnose Replica vs Primary Page Mismatch

When checksums on the primary disagree with a streaming replica. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md).

    -- On both nodes, on the suspect table:
    SELECT bt_index_check('public.suspect_idx'::regclass, heapallindexed => true);
    SELECT * FROM verify_heapam('public.suspect'::regclass);

    -- Compare. Mismatch on replica only -> rebuild replica from primary
    --   (pg_basebackup or pg_rewind, see 89-pg-rewind.md).
    -- Mismatch on primary only -> primary disk fault; failover + rebuild old primary.

## Gotchas / Anti-patterns

23 gotchas. Roughly ordered most-leveraged first.

1. **`pg_resetwal` as first response to a startup error.** Read `pg_log/*.log` first. Most "won't start" cases are config errors, missing tablespace mounts, full disk, or wraparound — none need `pg_resetwal`. Verbatim docs: *"It should be used only as a last resort"*[^pg-resetwal].
2. **No byte-level backup before `pg_resetwal` or `zero_damaged_pages`.** Both are destructive. `cp -a $PGDATA /backup/...` first, every time.
3. **`zero_damaged_pages = on` set in `postgresql.conf` cluster-wide.** Session-local only. Cluster-wide masks future corruption and persists zeroed pages on subsequent checkpoint.
4. **`pg_checksums --enable` on a running cluster.** Refuses to start AND would corrupt if it didn't. Verbatim: *"The server must be shut down cleanly before running pg_checksums"*[^pg-checksums].
5. **`pg_checksums --enable` on a primary while standbys stream.** Each standby gets corrupt pages from the primary's not-yet-fully-rewritten state. Always do the conversion on a stopped replica, take a base backup, then re-build the topology.
6. **`bt_index_parent_check` run cluster-wide on a production primary.** Acquires `ShareLock` per index. Schedule for a maintenance window. Use `bt_index_check` for routine.
7. **`bt_index_parent_check` on a hot-standby replica.** Cannot run on standbys — requires writes to update validation state. Use `bt_index_check` on standbys.
8. **Skipping `verify_heapam` because amcheck = "index checker".** Incorrect assumption since PG14 — `verify_heapam` was added to amcheck in PG14 and covers heap pages, TOAST tables, sequences, and matviews, not just B-tree indexes[^pg14-verifyheap].
9. **`pg_amcheck` `--parent-check` + `--rootdescend` on every weekly sweep.** Both elevate locks. Reserve for after-incident audits.
10. **Ignoring `pg_stat_database.checksum_failures`.** Wire it to alerting. Cross-reference [`82-monitoring.md`](./82-monitoring.md).
11. **PG18 default-on checksums breaks `pg_upgrade` from non-checksum cluster.** Verbatim: *"pg_upgrade requires matching cluster checksum settings"*[^pg18-checksums-default]. New cluster needs `initdb --no-data-checksums` first; convert after with `pg_checksums --enable` while stopped.
12. **`single-user` mode used for "interactive debugging".** Verbatim: *"not truly suitable for debugging the server, since no realistic interprocess communication and locking will happen"*[^postgres-single]. No checkpointer, no autovacuum, no logical decoding. Use only for catalog rescue and wraparound.
13. **`postgres --single` with `--single` not first argument.** Refuses to start. `--single` MUST be first; database name MUST be last.
14. **Forgetting newline terminates statements in single-user mode.** Multi-line CREATE TABLE silently parses only the first line. Use `\` line-continuations or pass `-j` to switch to `;\n\n` terminator.
15. **Running `REINDEX SYSTEM` against a multi-user-mode cluster while writes happen.** Locks every system catalog index in turn — writers block. Either do it during a maintenance window OR in single-user mode where contention is trivially zero.
16. **`pg_dump` taken as proof of corruption-freeness.** `pg_dump` reads heap directly via seq-scan; never traverses indexes. Index-only corruption (`bt_index_check` finds it, `pg_dump` doesn't) slips past. Run `pg_amcheck` for the complete picture.
17. **`ignore_checksum_failure = on` left enabled in `postgresql.conf`.** Verbatim: *"This behavior may cause crashes, propagate or hide corruption, or other serious problems"*[^ignore-checksum]. Session-local only; reset immediately.
18. **`ignore_system_indexes = on` left in `postgresql.conf` after the rescue session.** System catalogs perform terribly without their indexes. `REINDEX SYSTEM` and remove the GUC.
19. **`pg_resetwal -f` used to bypass an integrity warning the tool actively raised.** The `-f` flag escalates the warning — verbatim: *"the recovered database must be treated with even more suspicion than usual"*[^pg-resetwal]. Use only when even `pg_control` is unreadable.
20. **Believing a checksum failure means total cluster corruption.** A single checksum mismatch localizes to one 8 KB page. Identify the relfile (Recipe 4) and restore that block or rebuild that one object.
21. **Running `gin_index_check` on pre-PG18 cluster.** Function doesn't exist before PG18[^pg18-gin-check]. For GIN on PG14-17, the only recourse is `REINDEX` on suspicion.
22. **Running `amcheck --checkunique` on pre-PG17 cluster.** Flag added in PG17[^pg17-checkunique]. Pre-PG17, write your own SQL: `SELECT key, count(*) FROM tbl GROUP BY key HAVING count(*) > 1`.
23. **No regular `pg_amcheck` sweep — only checking after a customer reports missing data.** Latency-to-detection becomes weeks. Schedule weekly (Recipe 1) at minimum; daily on storage you don't trust.

## See Also

- [`26-index-maintenance.md`](./26-index-maintenance.md) — REINDEX, CONCURRENTLY rebuild for corrupt indexes
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin/xmax visibility, why `pg_dump` doesn't see every row
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM FREEZE invoked from single-user mode
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — wraparound emergency requiring single-user mode
- [`32-buffer-manager.md`](./32-buffer-manager.md) — how data pages move buffer ↔ disk; relation to checksums
- [`33-wal.md`](./33-wal.md) — WAL durability, full_page_writes, CRC-32C per record
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint persistence of zeroed pages
- [`63-internals-architecture.md`](./63-internals-architecture.md) — postmaster + background workers in single-user mode
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_class`, `pg_attribute` queries that diagnose corruption
- [`69-extensions.md`](./69-extensions.md) — installing `amcheck`
- [`73-streaming-replication.md`](./73-streaming-replication.md) — primary↔replica checksum mismatch diagnosis
- [`82-monitoring.md`](./82-monitoring.md) — `pg_stat_database.checksum_failures` alert
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — pg_dump as diagnostic + extraction
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — restoring individual relfiles from base backup
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest / Barman / WAL-G for per-relation restore
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — pre-upgrade integrity audit
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — upgrade strategies, PG18 default-checksum trap
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged former primary
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR runbook, RPO/RTO
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling the weekly `pg_amcheck` sweep
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed services usually disable `--single` and `pg_resetwal`

## Sources

[^checksums-chapter]: PostgreSQL 16 — Chapter 30.2 Data Checksums — <https://www.postgresql.org/docs/16/checksums.html>. "By default, data pages are not protected by checksums, but this can optionally be enabled for a cluster. When enabled, each data page includes a checksum that is updated when the page is written and verified each time the page is read."

[^initdb-checksums]: PostgreSQL 16 — initdb reference — <https://www.postgresql.org/docs/16/app-initdb.html>. "Use checksums on data pages to help detect corruption by the I/O system that would otherwise be silent. Enabling checksums may incur a noticeable performance penalty."

[^pg-checksums]: PostgreSQL 16 — pg_checksums reference — <https://www.postgresql.org/docs/16/app-pgchecksums.html>. "pg_checksums checks, enables or disables data checksums in a PostgreSQL cluster." "The server must be shut down cleanly before running pg_checksums." "Enabling checksums in a large cluster can potentially take a long time. During this operation, the cluster or other programs that write to the data directory must not be started or else data loss may occur."

[^amcheck-docs]: PostgreSQL 16 — amcheck — <https://www.postgresql.org/docs/16/amcheck.html>. "The amcheck module provides functions that allow you to verify the logical consistency of the structure of relations." "When a routine, lightweight test for corruption is required in a live production environment, using bt_index_check often provides the best trade-off between thoroughness of verification and limiting the impact on application performance and availability." "bt_index_parent_check can be thought of as a more thorough variant of bt_index_check: unlike bt_index_check, bt_index_parent_check also checks invariants that span parent/child relationships."

[^pg-amcheck-docs]: PostgreSQL 16 — pg_amcheck reference — <https://www.postgresql.org/docs/16/app-pgamcheck.html>. "pg_amcheck supports running amcheck's corruption checking functions against one or more databases, with options to select which schemas, tables and indexes to check..." "The extra checks performed against B-Tree indexes when the --parent-check option or the --rootdescend option is specified require relatively strong relation-level locks. These checks are the only checks that will block concurrent data modification from INSERT, UPDATE, and DELETE commands."

[^zero-damaged]: PostgreSQL 16 — runtime-config-developer — <https://www.postgresql.org/docs/16/runtime-config-developer.html>. "Detection of a damaged page header normally causes PostgreSQL to report an error, aborting the current transaction. Setting zero_damaged_pages to on causes the system to instead report a warning, zero out the damaged page in memory, and continue processing. This behavior will destroy data, namely all the rows on the damaged page. However, it does allow you to get past the error and retrieve rows from any undamaged pages that might be present in the table."

[^ignore-checksum]: PostgreSQL 16 — runtime-config-developer. "Setting ignore_checksum_failure to on causes the system to ignore the failure (but still report a warning), and continue processing. This behavior may cause crashes, propagate or hide corruption, or other serious problems."

[^postgres-single]: PostgreSQL 16 — postgres reference — <https://www.postgresql.org/docs/16/app-postgres.html>. "The primary use for this mode is during bootstrapping by initdb. Sometimes it is used for debugging or disaster recovery; note that running a single-user server is not truly suitable for debugging the server, since no realistic interprocess communication and locking will happen." "Single-user mode also does not do any background processing, such as automatic checkpoints or replication." "This user does not actually have to exist, so the single-user mode can be used to manually recover from certain kinds of accidental damage to the system catalogs."

[^pg-resetwal]: PostgreSQL 16 — pg_resetwal reference — <https://www.postgresql.org/docs/16/app-pgresetwal.html>. "pg_resetwal clears the write-ahead log (WAL) and optionally resets some other control information stored in the pg_control file. This function is sometimes needed if these files have become corrupted. It should be used only as a last resort, when the server will not start due to such corruption." "After running this command, it should be possible to start the server, but bear in mind that the database might contain inconsistent data due to partially-committed transactions. You should immediately dump your data, run initdb, and restore. After restore, check for inconsistencies and repair as needed." "the recovered database must be treated with even more suspicion than usual: an immediate dump and restore is imperative. Do not execute any data-modifying operations in the database before you dump, as any such action is likely to make the corruption worse."

[^wal-reliability]: PostgreSQL 16 — WAL reliability — <https://www.postgresql.org/docs/16/wal-reliability.html>. "To guard against such failures, PostgreSQL periodically writes full page images to permanent WAL storage before modifying the actual page on disk. By doing this, during crash recovery PostgreSQL can restore partially-written pages from WAL." "Each individual record in a WAL file is protected by a CRC-32C (32-bit) check that allows us to tell if record contents are correct. The CRC value is set when we write each WAL record and checked during crash recovery, archive recovery and replication."

[^pg14-pgamcheck]: PostgreSQL 14 Release Notes — <https://www.postgresql.org/docs/release/14.0/>. "Add command-line utility pg_amcheck to simplify running contrib/amcheck tests on many relations (Mark Dilger)."

[^pg14-verifyheap]: PostgreSQL 14 Release Notes. "Allow amcheck to also check heap pages (Mark Dilger). Previously it only checked B-Tree index pages."

[^pg15-amcheck-seq]: PostgreSQL 15 Release Notes — <https://www.postgresql.org/docs/release/15.0/>. "Allow amcheck to check sequences (Mark Dilger)."

[^pg15-amcheck-toast]: PostgreSQL 15 Release Notes. "Improve amcheck sanity checks for TOAST tables (Mark Dilger)."

[^pg17-checkunique]: PostgreSQL 17 Release Notes — <https://www.postgresql.org/docs/release/17.0/>. "Allow amcheck to check for unique constraint violations using new option --checkunique (Anastasia Lubennikova, Pavel Borisov, Maxim Orlov)."

[^pg18-gin-check]: PostgreSQL 18 Release Notes — <https://www.postgresql.org/docs/release/18.0/>. "Add amcheck check function gin_index_check() to verify GIN indexes (Grigory Kryachko, Heikki Linnakangas, Andrey Borodin)."

[^pg18-checksums-default]: PostgreSQL 18 Release Notes. "Change initdb to default to enabling checksums (Greg Sabino Mullane). The new initdb option --no-data-checksums disables checksums." Migration note: "pg_upgrade requires matching cluster checksum settings, so this new option can be useful to upgrade non-checksum old clusters."

[^pg18-charsign-resetwal]: PostgreSQL 18 Release Notes. "Add pg_resetwal option --char-signedness to change the default char signedness (Masahiko Sawada)."

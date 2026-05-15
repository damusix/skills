# Write-Ahead Log (WAL)

The Write-Ahead Log is the durability, replication, and recovery substrate of PostgreSQL. Every committed change passes through it before reaching the heap, and every recovery scenario — crash, replica catch-up, point-in-time restore, incremental backup — replays it. Tuning WAL means trading three things against each other: durability, write throughput, and recovery time.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Decision Matrix](#decision-matrix)
    - [WAL Mechanics](#wal-mechanics)
    - [wal_level](#wal_level)
    - [full_page_writes and Torn Pages](#full_page_writes-and-torn-pages)
    - [wal_compression](#wal_compression)
    - [wal_buffers](#wal_buffers)
    - [synchronous_commit](#synchronous_commit)
    - [Group Commit (commit_delay / commit_siblings)](#group-commit-commit_delay--commit_siblings)
    - [Archiving (archive_mode / archive_command / archive_library)](#archiving-archive_mode--archive_command--archive_library)
    - [WAL Retention (wal_keep_size / max_slot_wal_keep_size)](#wal-retention-wal_keep_size--max_slot_wal_keep_size)
    - [WAL Summarization (PG17+)](#wal-summarization-pg17)
    - [pg_waldump](#pg_waldump)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when the question is about: WAL itself (`wal_level`, `full_page_writes`, `wal_compression`, `wal_buffers`, `wal_segment_size`), archiving (`archive_command`, `archive_library`, `archive_timeout`), WAL retention (`wal_keep_size`, `max_slot_wal_keep_size`), WAL inspection (`pg_waldump`, LSN math), `synchronous_commit` levels, WAL summarization for incremental backups (PG17+), or any "why is `pg_wal` huge / why is the standby falling behind / why are checkpoints surprising" symptom.

Adjacent topics live elsewhere: checkpoint timing (`max_wal_size`, `checkpoint_completion_target`) is in [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md), streaming replication setup in [`73-streaming-replication.md`](./73-streaming-replication.md), logical replication in [`74-logical-replication.md`](./74-logical-replication.md), replication slot mechanics in [`75-replication-slots.md`](./75-replication-slots.md), PITR walkthroughs in [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md), and `pg_basebackup` / `pg_combinebackup` in [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).

## Mental Model

Five rules drive every WAL decision.

1. **Write-ahead is a discipline, not a buffer.** The rule from `wal-intro.html` is: *"changes to data files (where tables and indexes reside) must be written only after those changes have been logged, that is, after WAL records describing the changes have been flushed to permanent storage."*[^wal-intro] The page is what guarantees redo on crash; the WAL is what guarantees the page can be reconstructed.

2. **`wal_level` is the dial that decides what the WAL is *for*.** `minimal` writes the minimum needed for crash recovery only — no archiving, no replication. `replica` (the default) writes enough for archiving and physical replication. `logical` adds row-identifier information needed for logical decoding. **You cannot run a base backup on `minimal`.** Cite the GUC reference, not folklore.[^wal-level]

3. **`full_page_writes` protects against torn pages and is on by default.** *"PostgreSQL periodically writes full page images to permanent WAL storage before modifying the actual page on disk. By doing this, during crash recovery PostgreSQL can restore partially-written pages from WAL."*[^fpw] Turning it off is correct **only** on file systems that already prevent partial 8 KB page writes (ZFS, btrfs with appropriate settings) — and even then, most operators leave it on.

4. **`wal_buffers` is a small staging cache, not a tunable performance knob.** Default `-1` = auto-sized to `1/32` of `shared_buffers`, clamped between `64 kB` and one WAL segment (`16 MB`).[^wal-buffers] Manually raising it past the segment size is wasted; the buffer drains every commit.

5. **The cost of a WAL record is variable — and full-page-writes dominate.** A small UPDATE may log ~80 bytes plus the change; the *first* modification of any page after a checkpoint logs the entire 8 KB page. This is why checkpoint frequency and WAL volume are tightly coupled (see [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md)).

## Syntax / Mechanics

### Decision Matrix

| You want to... | Set | Avoid | Why |
|---|---|---|---|
| Run base backups, replicas, or PITR | `wal_level = replica` (default) | `wal_level = minimal` | `minimal` cannot support `pg_basebackup` or replication |
| Run logical replication or CDC | `wal_level = logical` | `replica` | Logical decoding requires row-identifier info in WAL |
| Reduce WAL volume on a write-heavy cluster (PG15+) | `wal_compression = lz4` | `wal_compression = pglz` | `lz4` is faster CPU + better compression on PG15+[^pg15-comp] |
| Bound storage retained for a stuck replica | `max_slot_wal_keep_size = '32GB'` | `max_slot_wal_keep_size = -1` (default) | Default is **unlimited** — slots can fill the disk[^max-slot] |
| Archive WAL to object storage | `archive_library = '<module>'` (PG15+) | shell `archive_command` for high-throughput | Library is faster and avoids fork-per-segment[^pg15-lib] |
| Allow incremental file-system backups (PG17+) | `summarize_wal = on` | nothing — needs the GUC explicitly | Without summarization, `pg_basebackup --incremental` cannot run[^pg17-sum] |
| Maximize write throughput on commit-heavy workload (some data loss tolerance) | `synchronous_commit = off` | `synchronous_commit = on` (default) | Trades durability for ~3-10x commit throughput |
| Force a WAL switch on a low-traffic primary | `archive_timeout = '5min'` | leaving at `0` | Without this, low-traffic clusters can hold one segment open indefinitely |
| Inspect a WAL segment | `pg_waldump -p pg_wal/ 00000001...` | reading the segment file directly | The on-disk format is undocumented; `pg_waldump` is the supported reader |

Three smell signals that WAL configuration is wrong:

- `pg_wal/` grows unboundedly: usually a stuck or abandoned replication slot. Audit `pg_replication_slots` and consider `max_slot_wal_keep_size`.
- Standbys lag in spite of CPU/network headroom: usually `wal_compression` is on with high commit rate on a low-core machine, or `wal_writer_flush_after` is at default and the WAL writer can't keep up with bursts.
- `pg_stat_archiver.failed_count` non-zero: archive script is failing silently. The cluster keeps generating WAL but cannot truncate `pg_wal/` until each segment is archived successfully.

### WAL Mechanics

WAL lives in the `$PGDATA/pg_wal` directory. From `wal-internals.html`: *"WAL files are stored in the directory `pg_wal` under the data directory, as a set of segment files, normally each 16 MB in size (but the size can be changed by altering the `--wal-segsize` initdb option)."*[^wal-int] Segment files are named with three eight-character hex fields: `<timeline>_<log>_<segment>` (e.g., `000000010000000A000000F3` = timeline 1, log 10, segment F3).

The **LSN (Log Sequence Number)** is a 64-bit byte offset into WAL — *"the insert position is described by a Log Sequence Number (LSN) that is a byte offset into the WAL, increasing monotonically with each new record."*[^lsn] LSNs render as two hex words separated by `/` (e.g., `1/A3F00128`). Functions:

```sql
SELECT pg_current_wal_lsn();              -- current insertion point (primary)
SELECT pg_last_wal_replay_lsn();          -- last replayed LSN (standby)
SELECT pg_walfile_name(pg_current_wal_lsn());  -- which segment file is current
SELECT pg_wal_lsn_diff('1/B0000000', '1/A3F00128') AS bytes_between;
```

Each segment is divided into 8 KB pages (the same size as a heap page, by default). WAL records can span pages but never span segments — the boundary between segments is a record boundary.

A WAL record contains:

- A header (XLogRecord): total length, transaction id, prev LSN, resource manager (`rmgr`) ID, info byte, CRC32.
- Per-`rmgr` data describing the change (heap insert, btree split, transaction commit, etc.).
- Optionally, **full page images** of the pages being modified, if this is the first modification after a checkpoint.

> [!NOTE] PostgreSQL 16
> `pg_split_walfile_name()` decomposes a WAL filename into its segment number and timeline ID, useful for monitoring queries.[^pg16-split]

### wal_level

```sql
SHOW wal_level;        -- replica (default)
ALTER SYSTEM SET wal_level = 'logical';  -- requires restart
```

Three values:

| Value | Sufficient for | Notes |
|---|---|---|
| `minimal` | crash recovery only | Cannot run `pg_basebackup`, cannot have replicas, cannot archive WAL. Some operations (CREATE TABLE AS, COPY into a new table within the same transaction) write *less* WAL by skipping the log entirely. |
| `replica` (default) | archiving, physical replication, PITR | The right default for almost every cluster. |
| `logical` | logical decoding, logical replication, output plugins | Includes the data needed to reconstruct row-level changes in logical form. Slightly higher WAL volume than `replica`. |

> [!WARNING] Changing `wal_level` requires a restart
> All `wal_level` changes are restart-only because the on-disk format changes. Bump from `replica` to `logical` *before* you need logical replication; do not wait for the migration window.

### full_page_writes and Torn Pages

Default `on`. When on, the first modification of any 8 KB page after a checkpoint emits a full page image to WAL. From `wal-reliability.html`: *"PostgreSQL periodically writes full page images to permanent WAL storage before modifying the actual page on disk."*[^fpw] This is the only way to recover from a *torn page* — an OS or hardware-level partial write where the 8 KB page was split mid-write across power loss.

**File systems where you can turn it off:**

- ZFS (atomic writes by COW design)
- Other COW file systems with confirmed atomic-write semantics

**Where you cannot turn it off safely:** ext4, xfs, NTFS, every traditional journaled file system.

> [!NOTE] PostgreSQL 18
> Data checksums are now enabled by default at `initdb`.[^pg18-cksum] Hint-bit changes — previously not WAL-logged — are now WAL-logged on new PG18 clusters because checksums require it (see [`27-mvcc-internals.md`](./27-mvcc-internals.md)). The practical consequence: every page's first write after a checkpoint, including hint-bit-only changes, will produce a full page image. WAL volume increases on read-heavy workloads that had been silently dirtying pages from hint-bit updates.

`wal_log_hints` (default `off`) is the older opt-in for the same behavior. `pg_rewind` requires either `wal_log_hints = on` or `data_checksums` to function — see [`89-pg-rewind.md`](./89-pg-rewind.md).

### wal_compression

```sql
ALTER SYSTEM SET wal_compression = 'lz4';  -- SIGHUP, no restart
SELECT pg_reload_conf();
```

Compresses **full page images** only, not the regular WAL record data. Values:

| Value | Available | Notes |
|---|---|---|
| `off` (default) | all versions | No compression |
| `on` | all versions | Alias for `pglz` |
| `pglz` | all versions | Original PostgreSQL LZ |
| `lz4` | PG15+[^pg15-comp] | Faster + better compression than pglz |
| `zstd` | PG15+[^pg15-comp] | Better compression than lz4, more CPU |

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow WAL full page writes to use LZ4 and Zstandard compression (Andrey Borodin, Justin Pryzby). This is controlled by the `wal_compression` server setting."*[^pg15-comp]

The compression target is the FPW, which is the dominant cost on write-heavy workloads. Recipe 5 shows the bench script to measure WAL volume reduction on your cluster.

### wal_buffers

```sql
SHOW wal_buffers;       -- typically 4MB on a 128MB shared_buffers default
```

Default `-1` (auto): *"selects a size equal to 1/32nd (about 3%) of shared_buffers, but not less than `64kB` nor more than the size of one WAL segment, typically `16MB`."*[^wal-buffers] Setting larger than one segment is silently capped.

Set explicitly to `16MB` on machines where `shared_buffers > 512MB` — the auto-sizing caps at one segment, so the explicit setting saves the calculation and makes monitoring more predictable.

### synchronous_commit

| Value | Durability | Latency | Where the data must be when COMMIT returns |
|---|---|---|---|
| `off` | weakest | lowest | In the WAL writer's queue; may be lost on crash within `wal_writer_delay × 3` (~600 ms default) |
| `local` | local-only | low | Flushed to local disk only; standby may not yet have it |
| `remote_write` | medium | medium | Sync standby has *received* WAL (RAM); not yet on standby disk |
| `on` (default) | strong | medium-high | Sync standby has *flushed* WAL to its own disk |
| `remote_apply` | strongest | highest | Sync standby has *replayed* WAL into its database; reads on standby are guaranteed to see this commit |

`local` and `off` apply only to the primary — they bypass the sync-standby wait entirely. `remote_write` / `on` / `remote_apply` are meaningful only when `synchronous_standby_names` is set (see [`73-streaming-replication.md`](./73-streaming-replication.md)).

```sql
-- Per-transaction override:
BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO ingest_buffer SELECT ...;
COMMIT;  -- returns fast; data may be lost on crash
```

### Group Commit (commit_delay / commit_siblings)

When many small transactions commit in close succession, PostgreSQL can group them into a single WAL flush. `commit_delay` is microseconds to wait before flushing in hopes another transaction joins the group; `commit_siblings` is the minimum number of in-flight transactions required before `commit_delay` even applies.

```sql
ALTER SYSTEM SET commit_delay = 100;     -- 100 microseconds
ALTER SYSTEM SET commit_siblings = 10;
```

Defaults `0` and `5` respectively. The kernel-level fsync cost on modern SSDs (~50 μs) makes `commit_delay > 0` rarely worth it on hardware that can sustain high commit rates. Effective on storage where fsync is expensive (network-attached storage, slow journaling).

### Archiving (archive_mode / archive_command / archive_library)

To enable archiving: set `wal_level >= replica`, set `archive_mode = on`, and provide either `archive_command` (shell) **or** `archive_library` (module). On PG16+ these two are mutually exclusive — *"Prevent `archive_library` and `archive_command` from being set at the same time."*[^pg16-mutex]

```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /mnt/archive/%f && cp %p /mnt/archive/%f'
archive_timeout = '5min'
```

`%p` substitutes the path to the WAL segment relative to PGDATA; `%f` is the bare segment filename.

**Safety rule from the docs:** *"Archive commands and libraries should generally be designed to refuse to overwrite any pre-existing archive file."*[^arch-safety] The `test ! -f && cp` pattern enforces this — production deployments should use `pgBackRest`, `Barman`, or `WAL-G`, which handle compression, retention, encryption, and concurrent archiving (see [`85-backup-tools.md`](./85-backup-tools.md)).

> [!NOTE] PostgreSQL 15
> `archive_library` introduced module-based archiving. *"Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."*[^pg15-lib] Library-based archiving avoids the fork-per-segment cost and is much faster at high WAL rates.

`archive_mode = always` makes a standby continue archiving after it is promoted; `archive_mode = on` archives only on the primary. The `always` mode is also required for `pg_backup_stop` to wait on a standby.

```sql
SELECT * FROM pg_stat_archiver;
-- archived_count | last_archived_wal | last_archived_time |
-- failed_count   | last_failed_wal   | last_failed_time   | stats_reset
```

`failed_count` non-zero plus stale `last_archived_time` is the canonical "archiving is broken; WAL is piling up" signal.

### WAL Retention (wal_keep_size / max_slot_wal_keep_size)

Two independent mechanisms prevent `pg_wal/` from being truncated:

- **`wal_keep_size`** (PG13+, replaced `wal_keep_segments`): *"minimum size of past WAL files kept in the `pg_wal` directory."*[^wal-keep] Set this to keep enough WAL for a replica that briefly disconnects. Default `0` (no extra retention beyond what replication slots demand).
- **Replication slots**: a slot's `restart_lsn` is the oldest LSN it might still need. WAL up to that LSN is **never** truncated, regardless of `wal_keep_size`. This is how a stuck slot fills the disk.

> [!NOTE] PostgreSQL 13+
> `max_slot_wal_keep_size` caps how much WAL a slot can retain. *"If `max_slot_wal_keep_size` is -1 (the default), replication slots may retain an unlimited amount of WAL files. Otherwise, if restart_lsn of a replication slot falls behind the current LSN by more than the given size, the standby using the slot may no longer be able to continue replication."*[^max-slot] Setting a finite value sacrifices the replica's ability to catch up in favor of protecting the primary's disk. The replica becomes invalid and must be rebuilt from a base backup.

```sql
SELECT slot_name, active, restart_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS bytes_behind,
       wal_status, safe_wal_size
  FROM pg_replication_slots
 ORDER BY bytes_behind DESC;
```

`wal_status` values: `reserved` (within `max_slot_wal_keep_size`), `extended` (using more than `max_wal_size` but within the slot cap), `unreserved` (about to be invalidated), `lost` (slot is broken, replica must be rebuilt).

### WAL Summarization (PG17+)

> [!NOTE] PostgreSQL 17
> Verbatim: *"Allow the creation of WAL summarization files (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski). These files record the block numbers that have changed within an LSN range and are useful for incremental file system backups. This is controlled by the server variables `summarize_wal` and `wal_summary_keep_time`."*[^pg17-sum]

WAL summarization is the substrate that enables `pg_basebackup --incremental` on PG17+. The walsummarizer background process reads the WAL stream and writes summary files into `$PGDATA/pg_wal/summaries/` recording which blocks changed within each LSN range.

```ini
# postgresql.conf
summarize_wal = on
wal_summary_keep_time = '10 days'   # default
```

Inspection:

```sql
SELECT * FROM pg_available_wal_summaries() ORDER BY end_lsn DESC LIMIT 5;
SELECT * FROM pg_get_wal_summarizer_state();
-- summarized_lsn | pending_lsn | summarizer_pid | summarized_tli
```

Per-block detail:

```sql
SELECT * FROM pg_wal_summary_contents(
    tli => 1, start_lsn => '0/A0000000', end_lsn => '0/B0000000'
);
```

The companion command-line tool is `pg_walsummary`, which dumps summary files in human-readable form. See [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) for the `pg_basebackup --incremental` + `pg_combinebackup` workflow.

### pg_waldump

From `pgwaldump.html`: *"pg_waldump displays the write-ahead log (WAL) and is mainly useful for debugging or educational purposes."*[^pgwaldump]

```bash
# Dump the current segment, with stats
pg_waldump -p $PGDATA/pg_wal --stats=record 00000001000000010000003F

# Decode a range by LSN
pg_waldump --start=1/3F000000 --end=1/40000000 -p $PGDATA/pg_wal

# Filter by resource manager
pg_waldump --rmgr=Heap -p $PGDATA/pg_wal 00000001000000010000003F
pg_waldump --rmgr=list  # show all rmgr names

# Follow a live segment (like tail -f)
pg_waldump -f -p $PGDATA/pg_wal 00000001000000010000003F
```

Common rmgr values: `XLOG`, `Transaction`, `Storage`, `CLOG`, `Database`, `Tablespace`, `MultiXact`, `RelMap`, `Standby`, `Heap2`, `Heap`, `Btree`, `Hash`, `Gin`, `Gist`, `Sequence`, `SPGist`, `BRIN`, `CommitTs`, `ReplicationOrigin`, `Generic`, `LogicalMessage`.

Selected options:

| Option | Effect |
|---|---|
| `-p, --path=DIR` | Directory containing WAL segments |
| `-s, --start=LSN` | Start LSN |
| `-e, --end=LSN` | End LSN |
| `-r, --rmgr=NAME` | Filter by resource manager |
| `-t, --timeline=ID` | Filter by timeline (PG16+ accepts hex) |
| `-z, --stats[=record]` | Per-rmgr or per-record statistics |
| `-f, --follow` | Tail mode |
| `-n, --limit=N` | Stop after N records |

> [!NOTE] PostgreSQL 16
> `pg_waldump --save-fullpage=DIR` extracts full page images from WAL records into individual files. Useful for forensics on corruption (compare the extracted FPW against the current heap page).[^pg16-fpw]

**Gotcha:** *"pg_waldump cannot read WAL files with suffix `.partial`. If those files need to be read, `.partial` suffix needs to be removed from the file name."*[^pgwaldump-partial] `.partial` segments appear in `pg_receivewal` output and on standbys during recovery.

### Per-Version Timeline

| PG | WAL-related changes |
|---|---|
| **14** | `recovery_init_sync_method=syncfs` for faster crash recovery; `checkpoint_completion_target` default raised to `0.9`; `pg_stat_wal` view added; `pg_stat_replication_slots` view added; `restore_command` reloadable on SIGHUP[^pg14-notes] |
| **15** | `wal_compression` gains `lz4` and `zstd`; `archive_library` for module-based archiving; `recovery_prefetch` for I/O parallelism during recovery; checkpointer and bgwriter now run during crash recovery (faster recovery)[^pg15-notes] |
| **16** | `archive_library` and `archive_command` mutually exclusive; `pg_split_walfile_name()` introspection; `pg_waldump --save-fullpage`; hex timelines in `pg_waldump -t`; logical decoding on standbys; `wal_sync_method=fdatasync` on Windows[^pg16-notes] |
| **17** | WAL summarization (`summarize_wal`, `wal_summary_keep_time`); `pg_walsummary` CLI; `pg_available_wal_summaries()`, `pg_wal_summary_contents()`, `pg_get_wal_summarizer_state()`; `pg_basebackup --incremental`; `pg_combinebackup`; streaming I/O improves sequential reads[^pg17-notes] |
| **18** | `data_checksums` default `on` at `initdb`; async I/O subsystem (`io_method`, `io_combine_limit`); WAL I/O activity in `pg_stat_io`; `track_wal_io_timing` moved from `pg_stat_wal` to `pg_stat_io`; `pg_stat_wal` loses `wal_write`/`wal_sync`/`wal_write_time`/`wal_sync_time` columns; `pg_stat_checkpointer` gains `num_done` and `slru_written`; WAL buffer-full count in `EXPLAIN (WAL)` and autovacuum logs[^pg18-notes] |

## Examples / Recipes

### Recipe 1: Baseline WAL configuration (write-heavy OLTP)

```ini
# postgresql.conf
wal_level = replica
synchronous_commit = on
fsync = on
full_page_writes = on
wal_compression = lz4              # PG15+
wal_buffers = 16MB                 # explicit, not -1
wal_writer_delay = 200ms
wal_writer_flush_after = 1MB

# Retention
max_wal_size = 16GB
min_wal_size = 1GB
wal_keep_size = 1GB
max_slot_wal_keep_size = 64GB      # cap stuck-slot disk consumption

# Archiving (via pgBackRest as archive_command)
archive_mode = on
archive_command = 'pgbackrest --stanza=main archive-push %p'
archive_timeout = '5min'

# Group commit (only if storage fsync is expensive)
commit_delay = 0
commit_siblings = 5
```

The `max_slot_wal_keep_size = 64GB` is the single most important production setting beyond the defaults — it bounds how much disk a stuck replica or abandoned slot can consume.

### Recipe 2: Find what's holding WAL on disk

```sql
WITH retention AS (
    SELECT
        pg_current_wal_lsn() AS current_lsn,
        (SELECT setting::bigint FROM pg_settings WHERE name = 'wal_keep_size') * 1024 * 1024 AS keep_size_bytes,
        pg_size_bytes(current_setting('max_slot_wal_keep_size')) AS max_slot_bytes
)
SELECT
    slot_name,
    active,
    wal_status,
    pg_size_pretty(safe_wal_size) AS safe_remaining,
    pg_size_pretty(pg_wal_lsn_diff(retention.current_lsn, restart_lsn)) AS slot_holding_back,
    age(active_pid::text::int)::text AS pid_age,
    restart_lsn
FROM pg_replication_slots, retention
ORDER BY pg_wal_lsn_diff(retention.current_lsn, restart_lsn) DESC;
```

A `wal_status` of `extended` or `unreserved` means the slot is past `max_wal_size` and is racing toward invalidation. `lost` means the slot is already broken.

### Recipe 3: Verify archiving is healthy

```sql
SELECT
    archived_count,
    failed_count,
    last_archived_wal,
    last_archived_time,
    now() - last_archived_time AS since_last_archive,
    last_failed_wal,
    last_failed_time,
    stats_reset
FROM pg_stat_archiver;
```

Alert when `failed_count > 0` AND `last_failed_time > last_archived_time` (failure is recent) OR `since_last_archive > 15 minutes` on a primary that should be generating WAL.

### Recipe 4: Force a WAL switch for testing or rotation

```sql
-- Generate a small write to ensure there's something to switch
INSERT INTO heartbeat (ts) VALUES (now());

SELECT pg_switch_wal();
-- Returns the LSN of the end of the prior segment.

-- Watch the new segment appear
SELECT pg_current_wal_lsn(), pg_walfile_name(pg_current_wal_lsn());
```

Useful in cron when `archive_timeout` is not set and you want a low-traffic primary to flush WAL to archive on a schedule. The PG18 release notes formally added `num_done` to `pg_stat_checkpointer` to track this.

### Recipe 5: Measure wal_compression impact on your cluster

```sql
-- Before: snapshot WAL counters
CREATE TEMP TABLE wal_bench_before AS
SELECT now() AS captured_at, wal_records, wal_fpi, wal_bytes
  FROM pg_stat_wal;

-- ... run a representative write workload (e.g., pgbench -T 60) ...

-- After: snapshot again
CREATE TEMP TABLE wal_bench_after AS
SELECT now() AS captured_at, wal_records, wal_fpi, wal_bytes
  FROM pg_stat_wal;

SELECT
    pg_size_pretty((a.wal_bytes - b.wal_bytes)::bigint) AS bytes_written,
    a.wal_records - b.wal_records AS records,
    a.wal_fpi - b.wal_fpi AS full_pages,
    extract(epoch from a.captured_at - b.captured_at) AS duration_s
  FROM wal_bench_before b, wal_bench_after a;
```

Run once with `wal_compression = off`, once with `wal_compression = lz4`. The `wal_bytes` difference between runs is the compression savings; the `wal_fpi` count is unchanged because FPI count is logical, not physical.

> [!NOTE] PostgreSQL 18
> The columns `wal_write`, `wal_sync`, `wal_write_time`, `wal_sync_time` were removed from `pg_stat_wal`; equivalent data is now in `pg_stat_io` filtered by `object = 'wal'`.[^pg18-statwal]

### Recipe 6: Decode WAL with pg_waldump for forensics

```bash
# Where did this LSN come from?
pg_waldump -p $PGDATA/pg_wal --start=1/3F123456 --end=1/3F123500

# Per-rmgr stats over a one-segment window
pg_waldump --stats -p $PGDATA/pg_wal 0000000100000001000000A0

# Output (typical):
# Type                     N      (%)          Record size  (%)  FPI size  (%)
# ----                  ------    ---          -----------  ---  --------  ---
# XLOG                     ...
# Transaction              ...
# Heap                     ...
# Btree                    ...
```

The `FPI size` column shows how much of WAL volume is full-page-images — typically 60-90% on write-heavy clusters with a 5-minute `checkpoint_timeout`. If this fraction is high, raising `checkpoint_timeout` to 15 or 30 minutes can dramatically cut WAL volume.

### Recipe 7: Schedule WAL summarization for incremental backup (PG17+)

```sql
-- Primary
ALTER SYSTEM SET summarize_wal = on;
ALTER SYSTEM SET wal_summary_keep_time = '14 days';
SELECT pg_reload_conf();

-- Verify the summarizer is running
SELECT * FROM pg_get_wal_summarizer_state();

-- List recent summary files
SELECT tli, start_lsn, end_lsn, size
  FROM pg_available_wal_summaries()
 ORDER BY end_lsn DESC
 LIMIT 10;
```

Once `summarize_wal = on`, `pg_basebackup --incremental=/path/to/prior_manifest` becomes usable. See [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) for the full incremental backup workflow.

### Recipe 8: Per-transaction async commit for high-volume ingest

```sql
-- Bulk loader path: tolerate ~600ms data loss on crash for 3-10x throughput
BEGIN;
SET LOCAL synchronous_commit = off;

COPY events FROM '/data/events.csv' WITH (FORMAT csv);
INSERT INTO event_summary SELECT day, count(*) FROM events GROUP BY day;

COMMIT;
```

The session-level setting (`SET synchronous_commit`) lasts for the session; the `SET LOCAL` form is transaction-scoped and reverts at COMMIT. **Do not** use `synchronous_commit = off` cluster-wide on transactional workloads — the data-loss window is at the *cluster* level, not the connection.

### Recipe 9: LSN math for replication lag

```sql
SELECT
    application_name,
    client_addr,
    state,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)) AS bytes_unsent,
    pg_size_pretty(pg_wal_lsn_diff(sent_lsn, write_lsn)) AS bytes_unwritten,
    pg_size_pretty(pg_wal_lsn_diff(write_lsn, flush_lsn)) AS bytes_unflushed,
    pg_size_pretty(pg_wal_lsn_diff(flush_lsn, replay_lsn)) AS bytes_unreplayed,
    sync_state,
    extract(epoch from (now() - reply_time)) AS reply_age_s
  FROM pg_stat_replication
 ORDER BY bytes_unreplayed DESC NULLS LAST;
```

Four lag stages: sent → written (to OS buffer on standby) → flushed (to standby disk) → replayed (visible to queries on standby). A standby that is lagging on the *replay* side but caught up on flush is usually blocked by a long-running query on the standby (see `hot_standby_feedback` in [`73-streaming-replication.md`](./73-streaming-replication.md)).

### Recipe 10: Reduce WAL volume by raising checkpoint_timeout

```ini
# Before: aggressive checkpoint cadence => high FPI count
checkpoint_timeout = '5min'      # default
max_wal_size = '4GB'

# After: amortize FPI across longer windows
checkpoint_timeout = '30min'
max_wal_size = '16GB'
checkpoint_completion_target = 0.9  # default since PG14
```

The FPI cost on every page is paid once per checkpoint cycle. Doubling `checkpoint_timeout` does not double WAL volume — it cuts it because each modified page is FPI'd half as often. The trade is longer crash-recovery time on restart. See [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) for the full discussion.

### Recipe 11: Identify the LSN of an event by transaction id

```sql
-- Find the LSN of a committed transaction
SELECT pg_xact_commit_timestamp_origin(xid) AS commit_ts,
       pg_xact_status(xid) AS status
  FROM (SELECT 12345::xid AS xid) sub;

-- Find which WAL file contains a given LSN
SELECT pg_walfile_name('1/A3F00128');
-- => 00000001000000010000000A
```

Useful when correlating an application-level event timestamp with WAL contents (e.g., "what did the database write at 14:32 UTC?"). For point-in-time recovery, you typically use `recovery_target_time` rather than `_lsn` — see [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).

### Recipe 12: Audit WAL-related GUCs

```sql
SELECT name, setting, unit, context, source
  FROM pg_settings
 WHERE name LIKE 'wal_%'
    OR name LIKE 'archive_%'
    OR name LIKE 'checkpoint_%'
    OR name LIKE 'max_wal_%'
    OR name LIKE 'min_wal_%'
    OR name LIKE '%sync%commit%'
    OR name LIKE 'fsync'
    OR name = 'synchronous_standby_names'
    OR name = 'max_slot_wal_keep_size'
    OR name = 'summarize_wal'
 ORDER BY name;
```

The `context` column tells you whether each setting requires a restart (`postmaster`), a reload (`sighup`), or can be set per-session (`user`). Audit before any change.

### Recipe 13: Trigger a CHECKPOINT manually (rare; usually wrong)

```sql
CHECKPOINT;
```

> [!WARNING] CHECKPOINT is not for routine use
> *"CHECKPOINT is not intended for use during normal operation."*[^chkpt] It forces an immediate, unthrottled checkpoint regardless of `checkpoint_completion_target`. The only legitimate uses are: forcing WAL drainage before a planned shutdown that needs a specific recovery point, and ensuring everything is flushed before taking a file-system-level snapshot. Calling `CHECKPOINT` in a tight loop is a self-inflicted I/O storm.

> [!NOTE] PostgreSQL 15
> `CHECKPOINT` now respects the `pg_checkpoint` predefined role — non-superusers granted membership can issue it.[^pg15-chkpt-role]

## Gotchas / Anti-patterns

1. **`wal_level = minimal` cannot run base backups.** `pg_basebackup` requires `replica` or higher. If you set `minimal` for "performance" you lose the ability to take physical backups or attach replicas — the cluster will fail when you try.

2. **`fsync = off` is a data-loss switch, not a performance knob.** A crash with `fsync = off` typically requires `pg_resetwal` and a `pg_dump`/restore. Never set this on a cluster you care about — even bulk-loaders should use `synchronous_commit = off` instead.

3. **`max_slot_wal_keep_size = -1` (the default) lets one stuck slot fill the disk.** Set a finite cap on every production cluster. An invalid slot is recoverable (rebuild the replica from a base backup); a full disk is a complete outage.

4. **`archive_command` failures do not retry on a schedule.** PostgreSQL retries the command on every WAL switch — if the command keeps failing, `pg_wal/` grows without bound until the disk fills. Always alert on `pg_stat_archiver.failed_count`.

5. **`archive_command` must not return success unless the segment is durably stored.** A naive `cp %p /archive/%f` returns 0 before the OS has fsynced; on a crash, the segment is half-written and unusable. Use `cp ... && sync ...`, or better, use a battle-tested archive tool (pgBackRest, Barman, WAL-G).

6. **`archive_command` and `archive_library` cannot both be set in PG16+.** *"Prevent `archive_library` and `archive_command` from being set at the same time."*[^pg16-mutex] On pre-PG16, `archive_library` silently overrode `archive_command`; on PG16+ the cluster refuses to start with both.

7. **`wal_keep_size` does not replace slots.** It keeps WAL for *all* replicas regardless of their state. If a replica is offline for longer than `wal_keep_size` worth of WAL, it cannot reconnect without a base backup — *unless* it has a replication slot. Use `wal_keep_size` as a buffer for brief network blips; use slots for permanent replicas.

8. **`synchronous_commit = off` does NOT skip the WAL writer.** It only skips the *commit wait*. The WAL writer still flushes at `wal_writer_delay` (200 ms default). Data is durable within ~600 ms of the WAL writer cycle, not "lost forever."

9. **`full_page_writes = off` is correct only on COW file systems.** On ext4/xfs/NTFS, a power loss during an 8 KB write can leave the page in an inconsistent state that crash recovery cannot detect. The page may pass checksum (silently writing wrong values) or fail with `invalid page in block` errors.

10. **`wal_buffers > 16MB` is silently capped.** The default `-1` auto-sizes to `min(shared_buffers/32, wal_segment_size)`. Setting larger than the segment size is wasted memory.

11. **`pg_switch_wal()` on an idle primary still rotates segments.** The new segment is mostly empty; archived as a full 16 MB. On a low-traffic cluster, this can balloon archive storage. Use `archive_timeout` as the rotation mechanism, not periodic `pg_switch_wal()`.

12. **`wal_segment_size` cannot be changed without re-initdb.** It's set at `initdb` time via `--wal-segsize` and is a permanent property of the cluster. Larger segments (32–64 MB) reduce filesystem metadata pressure but make archive scripts slower per segment.

13. **`recovery_target_lsn` requires exact LSN match.** Off-by-one to a non-record boundary fails with `recovery target lsn X has not been reached`. Use `recovery_target_time` for human-readable targets.

14. **`pg_waldump` cannot read `.partial` segments.** *"pg_waldump cannot read WAL files with suffix `.partial`. If those files need to be read, `.partial` suffix needs to be removed from the file name."*[^pgwaldump-partial] Rename the file before inspecting.

15. **Logical replication slots can hold xmin back.** A logical slot pins the database's `catalog_xmin`, preventing autovacuum from cleaning old catalog tuples. Abandoned logical slots cause silent catalog bloat — see [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 3.

16. **`synchronous_commit = remote_apply` makes COMMIT wait for standby replay.** This guarantees read-your-writes consistency across replicas but adds the standby's apply latency to every commit. Use it deliberately, per-transaction, not as a default.

17. **`archive_timeout` does not skip empty segments.** If `archive_timeout = 5min` and no writes occur, the WAL writer still emits a segment switch — the archive script will see a near-empty 16 MB file every 5 minutes. Heartbeat writes (Recipe 4) are more efficient.

18. **Hint bits and full_page_writes interact.** A read can set hint bits (HEAP_XMIN_COMMITTED / HEAP_XMIN_INVALID) and dirty a page; if it's the first dirty after a checkpoint *and* `full_page_writes = on`, the entire page goes to WAL. On PG18 with data checksums default on, this also true for hint-bit-only changes that previously skipped WAL. Read-heavy workloads on PG18 see more WAL volume than identical workloads on PG17.

19. **`pg_stat_wal` lost columns in PG18.** Monitoring code that reads `wal_write` / `wal_sync` / `wal_write_time` / `wal_sync_time` from `pg_stat_wal` will get column-does-not-exist errors after upgrade.[^pg18-statwal] The equivalent data is in `pg_stat_io` filtered by `object = 'wal'`. Migrate queries before upgrading.

20. **WAL summarization is opt-in.** *"summarize_wal = off"* is the default on PG17. Without it, `pg_basebackup --incremental` will refuse to run with an error about missing summaries. Turn it on at install time, not when you need incremental backups.

21. **`commit_delay` does nothing under `commit_siblings`.** The delay applies only when at least `commit_siblings` (default 5) transactions are already waiting. On a low-concurrency cluster, `commit_delay` has zero effect.

22. **`wal_compression = on` is an alias for `pglz`.** Setting `wal_compression = on` on PG15+ gives you `pglz`, not `lz4`. The string `'on'` does not pick the best compressor — pick the algorithm explicitly.

23. **Hot-standby and FPI interact with vacuum cleanup.** `hot_standby_feedback = on` propagates the standby's xmin back to the primary, preventing the primary from cleaning tuples the standby still needs. This is correct for read-heavy standbys but can cause primary-side bloat invisible from a primary-only monitoring view. See [`73-streaming-replication.md`](./73-streaming-replication.md).

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin/xmax, hint bits, MultiXact, why hint-bit changes matter for FPI volume
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum interaction with WAL retention
- [`32-buffer-manager.md`](./32-buffer-manager.md) — shared_buffers; relationship to wal_buffers
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — `max_wal_size`, `checkpoint_timeout`, `checkpoint_completion_target`; the consumer of WAL retention math
- [`53-server-configuration.md`](./53-server-configuration.md) — `pg_settings`, ALTER SYSTEM, GUC contexts
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_wal`, `pg_stat_archiver`, `pg_stat_replication`, `pg_stat_io` (PG16+)
- [`73-streaming-replication.md`](./73-streaming-replication.md) — `synchronous_standby_names`, `hot_standby_feedback`, primary_conninfo
- [`74-logical-replication.md`](./74-logical-replication.md) — `wal_level = logical`, publications, subscriptions
- [`75-replication-slots.md`](./75-replication-slots.md) — slot semantics, `wal_status`, `safe_wal_size`, invalidation
- [`76-logical-decoding.md`](./76-logical-decoding.md) — output plugins, `pg_logical_slot_get_changes`, REPLICA IDENTITY
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — `pg_basebackup`, `archive_command` in context, PITR walkthrough, incremental backup (PG17+)
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest, Barman, WAL-G as production archive paths
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `pg_resetwal`, data checksums, when to use what
- [`89-pg-rewind.md`](./89-pg-rewind.md) — `wal_log_hints` requirement for pg_rewind

## Sources

[^wal-intro]: PostgreSQL 16 documentation, "Reliability and the Write-Ahead Log: Write-Ahead Logging (WAL)" — verbatim: *"Write-Ahead Logging (WAL) is a standard method for ensuring data integrity. ... changes to data files (where tables and indexes reside) must be written only after those changes have been logged, that is, after WAL records describing the changes have been flushed to permanent storage."* https://www.postgresql.org/docs/16/wal-intro.html

[^wal-int]: PostgreSQL 16, "WAL Internals" — verbatim: *"WAL files are stored in the directory pg_wal under the data directory, as a set of segment files, normally each 16 MB in size (but the size can be changed by altering the --wal-segsize initdb option). Each segment is divided into pages, normally 8 kB each (this size can be changed via the --with-wal-blocksize configure option)."* https://www.postgresql.org/docs/16/wal-internals.html

[^lsn]: PostgreSQL 16, "WAL Internals" — verbatim: *"The insert position is described by a Log Sequence Number (LSN) that is a byte offset into the WAL, increasing monotonically with each new record."* https://www.postgresql.org/docs/16/wal-internals.html

[^wal-level]: PostgreSQL 16, "Server Configuration: Write Ahead Log" — `wal_level` parameter, three values minimal/replica/logical. https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-WAL-LEVEL

[^fpw]: PostgreSQL 16, "Reliability" — verbatim: *"PostgreSQL periodically writes full page images to permanent WAL storage before modifying the actual page on disk. By doing this, during crash recovery PostgreSQL can restore partially-written pages from WAL. If you have file-system software that prevents partial page writes (e.g., ZFS), you can turn off this page imaging by turning off the full_page_writes parameter."* https://www.postgresql.org/docs/16/wal-reliability.html

[^wal-buffers]: PostgreSQL 16, `wal_buffers` GUC — verbatim: *"The default setting of -1 selects a size equal to 1/32nd (about 3%) of shared_buffers, but not less than 64kB nor more than the size of one WAL segment, typically 16MB."* https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-WAL-BUFFERS

[^pg15-comp]: PostgreSQL 15 release notes — verbatim: *"Allow WAL full page writes to use LZ4 and Zstandard compression (Andrey Borodin, Justin Pryzby). This is controlled by the wal_compression server setting."* https://www.postgresql.org/docs/release/15.0/

[^max-slot]: PostgreSQL 16, `max_slot_wal_keep_size` GUC — verbatim: *"If max_slot_wal_keep_size is -1 (the default), replication slots may retain an unlimited amount of WAL files. Otherwise, if restart_lsn of a replication slot falls behind the current LSN by more than the given size, the standby using the slot may no longer be able to continue replication."* https://www.postgresql.org/docs/16/runtime-config-replication.html#GUC-MAX-SLOT-WAL-KEEP-SIZE

[^wal-keep]: PostgreSQL 16, `wal_keep_size` GUC — verbatim: *"minimum size of past WAL files kept in the pg_wal directory."* https://www.postgresql.org/docs/16/runtime-config-replication.html#GUC-WAL-KEEP-SIZE

[^pg15-lib]: PostgreSQL 15 release notes — verbatim: *"Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable archive_library can be set to specify a library to be called for archiving."* https://www.postgresql.org/docs/release/15.0/

[^arch-safety]: PostgreSQL 16, "Continuous Archiving and Point-in-Time Recovery" — verbatim: *"Archive commands and libraries should generally be designed to refuse to overwrite any pre-existing archive file."* https://www.postgresql.org/docs/16/continuous-archiving.html

[^pg17-sum]: PostgreSQL 17 release notes — verbatim: *"Allow the creation of WAL summarization files (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski). These files record the block numbers that have changed within an LSN range and are useful for incremental file system backups. This is controlled by the server variables summarize_wal and wal_summary_keep_time, and introspected with pg_available_wal_summaries(), pg_wal_summary_contents(), and pg_get_wal_summarizer_state()."* https://www.postgresql.org/docs/release/17.0/

[^pgwaldump]: PostgreSQL 16, `pg_waldump` — verbatim: *"pg_waldump displays the write-ahead log (WAL) and is mainly useful for debugging or educational purposes."* https://www.postgresql.org/docs/16/pgwaldump.html

[^pgwaldump-partial]: PostgreSQL 16, `pg_waldump` — verbatim: *"pg_waldump cannot read WAL files with suffix .partial. If those files need to be read, .partial suffix needs to be removed from the file name."* https://www.postgresql.org/docs/16/pgwaldump.html

[^pg16-mutex]: PostgreSQL 16 release notes — verbatim: *"Prevent archive_library and archive_command from being set at the same time (Nathan Bossart). Previously archive_library would override archive_command."* https://www.postgresql.org/docs/release/16.0/

[^pg16-split]: PostgreSQL 16 release notes — verbatim: *"Add function pg_split_walfile_name() to report the segment and timeline values of WAL file names."* https://www.postgresql.org/docs/release/16.0/

[^pg16-fpw]: PostgreSQL 16 release notes — verbatim: *"Add pg_waldump option --save-fullpage to dump full page images."* https://www.postgresql.org/docs/release/16.0/

[^pg14-notes]: PostgreSQL 14 release notes — `recovery_init_sync_method=syncfs`, `checkpoint_completion_target` default to 0.9, `pg_stat_wal` view, `pg_stat_replication_slots` view, reloadable `restore_command`. https://www.postgresql.org/docs/release/14.0/

[^pg15-notes]: PostgreSQL 15 release notes — wal_compression lz4/zstd, archive_library, recovery_prefetch, checkpointer+bgwriter during crash recovery. https://www.postgresql.org/docs/release/15.0/

[^pg16-notes]: PostgreSQL 16 release notes — archive_library/command mutex, pg_split_walfile_name, pg_waldump --save-fullpage, hex timelines, logical decoding on standby. https://www.postgresql.org/docs/release/16.0/

[^pg17-notes]: PostgreSQL 17 release notes — WAL summarization, pg_walsummary, pg_basebackup --incremental, pg_combinebackup, streaming I/O. https://www.postgresql.org/docs/release/17.0/

[^pg18-notes]: PostgreSQL 18 release notes — verbatim: *"Change initdb default to enable data checksums (Greg Sabino Mullane). Checksums can be disabled with the new initdb option --no-data-checksums. pg_upgrade requires matching cluster checksum settings."* Also async I/O subsystem, WAL I/O in pg_stat_io, track_wal_io_timing relocation, pg_stat_wal column removals, pg_stat_checkpointer.num_done and .slru_written, WAL buffer-full in EXPLAIN/autovacuum. https://www.postgresql.org/docs/release/18.0/

[^pg18-cksum]: See `[^pg18-notes]`. Data checksums become the cluster-wide default at initdb time.

[^pg18-statwal]: PostgreSQL 18 release notes — verbatim: *"Remove read/sync columns from pg_stat_wal (Bertrand Drouvot). This removes columns wal_write, wal_sync, wal_write_time, and wal_sync_time."* https://www.postgresql.org/docs/release/18.0/

[^chkpt]: PostgreSQL 16, `CHECKPOINT` command — verbatim: *"CHECKPOINT is not intended for use during normal operation."* https://www.postgresql.org/docs/16/sql-checkpoint.html

[^pg15-chkpt-role]: PostgreSQL 15+, `CHECKPOINT` command — verbatim: *"Only superusers or users with the privileges of the pg_checkpoint role can call CHECKPOINT."* https://www.postgresql.org/docs/16/sql-checkpoint.html

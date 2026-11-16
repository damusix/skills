# Write-Ahead Log (WAL)

Write-Ahead Log (WAL) records changes needed for crash recovery, physical replication, and point-in-time recovery. Logged changes must reach durable WAL before the corresponding data pages reach disk. Temporary and unlogged relation data are exceptions; asynchronous commit can acknowledge a transaction before its WAL is durable.[^wal-intro][^wal-config]

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

3. **Keep `full_page_writes` enabled for crash recovery.** Disabling it requires verified protection against partial PostgreSQL-page writes throughout the storage stack. The manual gives ZFS as an example; a generic copy-on-write filesystem label is not sufficient evidence.[^fpw]

4. **`wal_buffers` stages WAL not yet written to disk.** Automatic sizing with `-1` is capped at one WAL segment, but explicit values are not capped there. Most installations should retain automatic sizing unless measurements justify an override.[^wal-buffers]

5. **The cost of a WAL record is variable — and full-page-writes dominate.** A small UPDATE may log ~80 bytes plus the change; the *first* modification of any page after a checkpoint logs the entire 8 KB page. This is why checkpoint frequency and WAL volume are tightly coupled (see [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md)).

## Syntax / Mechanics

### Decision Matrix

| You want to... | Set | Avoid | Why |
|---|---|---|---|
| Run base backups, replicas, or PITR | `wal_level = replica` (default) | `wal_level = minimal` | `minimal` cannot support `pg_basebackup` or replication |
| Run logical replication or CDC | `wal_level = logical` | `replica` | Logical decoding requires row-identifier info in WAL |
| Reduce full-page-image WAL volume (PG15+) | Benchmark supported `pglz`, `lz4`, or `zstd` | assuming one algorithm always compresses best | Build support and CPU/storage workload determine the tradeoff.[^wal-config] |
| Bound storage retained for a stuck replica | `max_slot_wal_keep_size = '32GB'` | `max_slot_wal_keep_size = -1` (default) | Default is **unlimited** — slots can fill the disk[^max-slot] |
| Archive WAL to object storage | `archive_library = '<module>'` (PG15+) | shell `archive_command` for high-throughput | Library is faster and avoids fork-per-segment[^pg15-lib] |
| Allow incremental file-system backups (PG17+) | `summarize_wal = on` | nothing — needs the GUC explicitly | Without summarization, `pg_basebackup --incremental` cannot run[^pg17-sum] |
| Reduce commit-wait latency for noncritical transactions | `SET LOCAL synchronous_commit = off` | disabling `fsync` | Acknowledged transactions may be lost on crash; benchmark throughput.[^wal-config] |
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
SELECT pg_current_wal_lsn();              -- current WAL write location (primary)
SELECT pg_last_wal_replay_lsn();          -- last replayed LSN (standby)
SELECT pg_walfile_name(pg_current_wal_lsn());  -- which segment file is current
SELECT pg_wal_lsn_diff('1/B0000000', '1/A3F00128') AS bytes_between;
```

Each segment is divided into WAL pages, normally 8 KB. Records can span pages; do not assume record boundaries match page boundaries.[^wal-int]

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

> [!NOTE] PostgreSQL 19
> With `wal_level = replica`, PostgreSQL 19 can automatically enable logical replication when it is needed. The new read-only variable `effective_wal_level` shows the level in effect (also in `pg_controldata` and `pg_control_checkpoint()`): when `wal_level` is `replica` and the system has one or more logical replication slots, `effective_wal_level` shows `logical`.[^pg19-wal-level]

### full_page_writes and Torn Pages

Default `on`. When on, the first modification of any 8 KB page after a checkpoint emits a full page image to WAL. From `wal-reliability.html`: *"PostgreSQL periodically writes full page images to permanent WAL storage before modifying the actual page on disk."*[^fpw] This is the only way to recover from a *torn page* — an OS or hardware-level partial write where the 8 KB page was split mid-write across power loss.

Keep `full_page_writes = on` unless the storage configuration has verified protection against partial PostgreSQL-page writes and the recovery implications have been reviewed. Copy-on-write alone is not a guarantee for every filesystem and device configuration.[^fpw][^wal-config]

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
| `on` | all versions | PG14–18: alias for `pglz`. PG19: selects the first of `zstd`, `lz4`, `pglz` that is available |
| `pglz` | all versions | Original PostgreSQL LZ |
| `lz4` | PG15+[^pg15-comp] | Requires an LZ4-enabled build; benchmark speed and compression |
| `zstd` | PG15+[^pg15-comp] | Requires a Zstandard-enabled build; benchmark CPU cost and compression |

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow WAL full page writes to use LZ4 and Zstandard compression (Andrey Borodin, Justin Pryzby). This is controlled by the `wal_compression` server setting."*[^pg15-comp]

> [!WARNING] PostgreSQL 19
> PostgreSQL 19 changes `wal_compression = on` to use the best WAL compression method available; previously it always used `pglz`. The value `on` now selects the first of `zstd`, `lz4`, `pglz` that is available. The default value is still `off`.[^pg19-wal-compression]

The compression target is the FPW, which is the dominant cost on write-heavy workloads. Recipe 5 shows the bench script to measure WAL volume reduction on your cluster.

### wal_buffers

```sql
SHOW wal_buffers;       -- typically 4MB on a 128MB shared_buffers default
```

Default `-1` selects `shared_buffers / 32`, with an automatic range of 64 kB to one WAL segment. Positive manual settings can exceed one segment; values below 32 kB are treated as 32 kB.[^wal-buffers]

Leave automatic sizing unless measurements such as WAL buffer-full events justify changing it.

### synchronous_commit

| Value | Durability | Latency | Where the data must be when COMMIT returns |
|---|---|---|---|
| `off` | weakest | lowest | In the WAL writer's queue; may be lost on crash within `wal_writer_delay × 3` (~600 ms default) |
| `local` | local-only | low | Flushed to local disk only; standby may not yet have it |
| `remote_write` | local WAL durable; standby OS write complete | medium | Current synchronous standby has written WAL to its filesystem, but it need not survive a standby OS crash |
| `on` (default) | strong | medium-high | Sync standby has *flushed* WAL to its own disk |
| `remote_apply` | local and required standby WAL durable and applied | highest | Current synchronous standby(s) have replayed the commit; new snapshots there can see it, unlike older snapshots or other asynchronous replicas |

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
archive_command = 'pgbackrest --stanza=main archive-push %p'
archive_timeout = '5min'
```

`%p` substitutes the path to the WAL segment relative to PGDATA; `%f` is the bare segment filename.

Configure and test the backup tool's stanza, repository, credentials, and restore path before relying on this example. An archive must not overwrite different existing content and must return success only after durable storage. If identical content is already durably archived, a retry should succeed. A `test ! -f && cp` example is not a complete production archive implementation.[^arch-safety]

> [!NOTE] PostgreSQL 15
> `archive_library` introduced module-based archiving. *"Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."*[^pg15-lib] Library-based archiving avoids the fork-per-segment cost and is much faster at high WAL rates.

`archive_mode = always` archives received or restored WAL while the node is a standby, and generated WAL after promotion. `on` archives during normal primary operation but not standby recovery. On a standby, `pg_backup_stop` waits for archiving only with `always`.[^wal-config]

```sql
SELECT * FROM pg_stat_archiver;
-- archived_count | last_archived_wal | last_archived_time |
-- failed_count   | last_failed_wal   | last_failed_time   | stats_reset
```

`failed_count` non-zero plus stale `last_archived_time` is the canonical "archiving is broken; WAL is piling up" signal.

### WAL Retention (wal_keep_size / max_slot_wal_keep_size)

Two independent mechanisms prevent `pg_wal/` from being truncated:

- **`wal_keep_size`** (PG13+, replaced `wal_keep_segments`): *"minimum size of past WAL files kept in the `pg_wal` directory."*[^wal-keep] Set this to keep enough WAL for a replica that briefly disconnects. Default `0` (no extra retention beyond what replication slots demand).
- **Replication slots**: a slot's `restart_lsn` identifies its oldest required WAL. Slots retain WAL independently of `wal_keep_size`, subject to `max_slot_wal_keep_size` enforcement at checkpoints.

> [!NOTE] PostgreSQL 13+
> `max_slot_wal_keep_size` limits slot retention at checkpoints, not total instantaneous disk use. With `-1` (the default), slots can retain unlimited WAL.[^max-slot] A finite value can allow required WAL to be removed. A physical standby may recover it from a suitable archive; otherwise it needs rebuilding. An invalidated logical slot requires consumer recovery or resynchronization. Choose the limit with the recovery plan, WAL rate, and available space.

```sql
SELECT slot_name, active, restart_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS bytes_behind,
       wal_status, safe_wal_size
  FROM pg_replication_slots
 ORDER BY bytes_behind DESC;
```

`wal_status` values: `reserved` (required WAL is within `max_wal_size`), `extended` (beyond `max_wal_size` but still retained), `unreserved` (the slot no longer guarantees retention; needed files may be removed at the next checkpoint), and `lost` (the slot is unusable). `unreserved` can recover before removal.[^slot-view]

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
-- summarized_tli | summarized_lsn | pending_lsn | summarizer_pid
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
| **19** (RC) | `effective_wal_level` and automatic logical enablement when `wal_level = replica`[^pg19-wal-level]; `wal_compression = on` selects the first available of `zstd`, `lz4`, `pglz`[^pg19-wal-compression]; `WAIT FOR LSN` command[^pg19-wait]; `wal_sender_shutdown_timeout`[^pg19-wait]; `pg_stat_wal` and `pg_stat_get_backend_wal()` report full-page-image bytes[^pg19-wal-fpi] |

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

The example `max_slot_wal_keep_size = 64GB` trades slot retention against consumer recovery. It is not a hard disk-use bound: enforcement occurs at checkpoints, and archiving failures or other retention requirements can keep additional WAL.

### Recipe 2: Find what's holding WAL on disk

```sql
SELECT slot_name, active, active_pid, wal_status,
       pg_size_pretty(safe_wal_size) AS safe_remaining,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       restart_lsn
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

`extended` means required WAL exceeds `max_wal_size`, not that the slot is necessarily near invalidation. Inspect `safe_wal_size` when a finite slot cap is configured. `unreserved` means required WAL is no longer protected by the slot; `lost` means the slot is unusable.[^slot-view]

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

Use this to request archiving of a completed transaction's segment, then verify archive success. `pg_stat_checkpointer` counts checkpoints, not WAL segment switches.

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
SELECT tli, start_lsn, end_lsn
  FROM pg_available_wal_summaries()
 ORDER BY end_lsn DESC
 LIMIT 10;
```

Incremental backups require summaries covering the required interval since the prior backup, not merely an enabled summarizer. Check availability and keep the prior backup chain and manifests. See [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).[^wal-summary-functions]

### Recipe 8: Per-transaction async commit for high-volume ingest

```sql
-- Noncritical ingest: asynchronous commit can lose acknowledged data on crash.
BEGIN;
SET LOCAL synchronous_commit = off;

COPY events FROM '/data/events.csv' WITH (FORMAT csv);
INSERT INTO event_summary SELECT day, count(*) FROM events GROUP BY day;

COMMIT;
```

`SET LOCAL` lasts until transaction end. Asynchronous commit affects the durability guarantee of transactions that commit with it enabled; it does not turn otherwise synchronous transactions into asynchronous ones. Choose it only where loss of acknowledged data is acceptable.[^wal-config]

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
 ORDER BY pg_wal_lsn_diff(flush_lsn, replay_lsn) DESC NULLS LAST;
```

Four lag stages: sent → written (to the standby's OS) → flushed (to durable storage) → replayed (available to fresh snapshots on the standby). Replay lag can reflect recovery conflicts, configured replay delay, paused recovery, or insufficient replay throughput. Inspect standby logs and recovery state before attributing it to a query.

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

Longer checkpoint intervals can reduce repeated full-page images when the same pages are modified across intervals. The reduction is workload-dependent and is not guaranteed to be proportional. Budget disk space and longer crash recovery before raising the settings.

### Recipe 11: Correlate a transaction with WAL

    -- The epoch-bearing xid8 must come from a recorded transaction identifier.
    SELECT pg_xact_status('12345'::xid8);

    -- Requires track_commit_timestamp to have been enabled for this transaction.
    SELECT * FROM pg_xact_commit_timestamp_origin('12345'::xid);

    SELECT pg_walfile_name('1/A3F00128'::pg_lsn);

Neither transaction-status nor commit-timestamp functions return an LSN. To locate a transaction's WAL records, inspect retained WAL using `pg_waldump --xid=<32-bit-xid>` with the appropriate timeline and range. Do not infer an epoch or recovery target from a reused 32-bit XID alone.[^xid-functions]

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
> Manual CHECKPOINT can cause substantial I/O and is not intended for routine application use.[^chkpt] It may reduce recovery time before a correctly coordinated filesystem snapshot, but does not make an ordinary live file copy into a valid backup. Snapshot all volumes consistently or use PostgreSQL's supported base-backup procedure.

> [!NOTE] PostgreSQL 15
> `CHECKPOINT` now respects the `pg_checkpoint` predefined role — non-superusers granted membership can issue it.[^pg15-chkpt-role]

## Gotchas / Anti-patterns

1. **`wal_level = minimal` cannot run base backups.** `pg_basebackup` requires `replica` or higher. If you set `minimal` for "performance" you lose the ability to take physical backups or attach replicas — the cluster will fail when you try.

2. **`fsync = off` can cause unrecoverable corruption after an OS crash or power loss.** Keep it enabled on persistent production clusters. Do not prescribe `pg_resetwal` as an automatic response to a crash; prefer recovery from a valid backup. Asynchronous commit is a separate tradeoff that can lose recent commits without compromising database consistency.[^wal-config]

3. **`max_slot_wal_keep_size = -1` (the default) lets one stuck slot fill the disk.** Set a finite cap on every production cluster. An invalid slot is recoverable (rebuild the replica from a base backup); a full disk is a complete outage.

4. **Failed archive commands are retried periodically.** Repeated failures retain WAL and can fill disk. Monitor recent failures, archive progress, disk use, and server logs; some archiver crashes are not counted in `pg_stat_archiver`.[^arch-safety]

5. **Archive success requires durable, correct content.** Use a tested archive tool or implementation that handles persistence, interrupted copies, retries, and existing-content checks. A plain copy or an unverified `sync` addition is not a complete archival durability protocol.[^arch-safety]

6. **`archive_command` and `archive_library` cannot both be set in PG16+.** *"Prevent `archive_library` and `archive_command` from being set at the same time."*[^pg16-mutex] On pre-PG16, `archive_library` silently overrode `archive_command`; on PG16+ the cluster refuses to start with both.

7. **`wal_keep_size` does not replace slots.** It keeps WAL for *all* replicas regardless of their state. If a replica is offline for longer than `wal_keep_size` worth of WAL, it cannot reconnect without a base backup — *unless* it has a replication slot. Use `wal_keep_size` as a buffer for brief network blips; use slots for permanent replicas.

8. **`synchronous_commit = off` does NOT skip the WAL writer.** It only skips the *commit wait*. The WAL writer still flushes at `wal_writer_delay` (200 ms default). Data is durable within ~600 ms of the WAL writer cycle, not "lost forever."

9. **Do not disable `full_page_writes` based only on a filesystem label.** Verify prevention of partial PostgreSQL-page writes across the complete storage stack; otherwise crash recovery can leave unrecoverable or silent corruption.[^fpw]

10. **Only automatic `wal_buffers` sizing is capped at one segment.** Manual settings can exceed it, although very large values may offer little benefit.[^wal-buffers]

11. **`pg_switch_wal()` does nothing without WAL activity since the last switch.** With activity, forcing early switches can produce mostly empty archived segments that still occupy a full segment.[^wal-admin-functions]

12. **Choose `wal_segment_size` at initialization for normal operations.** Although `pg_resetwal --wal-segsize` can alter it offline, that destructive salvage utility is not a production tuning mechanism. Plan backup/archive compatibility before changing the layout.[^resetwal]

13. **An LSN recovery target is not required to equal a record boundary.** Recovery stops according to WAL record positions and `recovery_target_inclusive`. It fails if recovery ends before reaching the configured target; rehearse the chosen target before relying on it.[^wal-config]

14. **`pg_waldump` cannot read `.partial` segments.** *"pg_waldump cannot read WAL files with suffix `.partial`. If those files need to be read, `.partial` suffix needs to be removed from the file name."*[^pgwaldump-partial] Rename the file before inspecting.

15. **Logical replication slots can hold xmin back.** A logical slot pins the database's `catalog_xmin`, preventing autovacuum from cleaning old catalog tuples. Abandoned logical slots cause silent catalog bloat — see [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 3.

16. **`remote_apply` waits for the current required synchronous standby(s), not every replica.** Reads need a new snapshot on a standby that acknowledged replay. Older snapshots and other asynchronous replicas are not covered.[^wal-config]

    > [!NOTE] PostgreSQL 19
    > PostgreSQL 19 adds `WAIT FOR LSN 'lsn' [ WITH ( MODE 'standby_replay|standby_write|standby_flush|primary_flush', TIMEOUT '...', NO_THROW ) ]`, which waits until a given LSN is reached. The default mode is `standby_replay`. It is an option for read-your-writes on a standby alongside `remote_apply`.[^pg19-wait]

17. **`archive_timeout` switches only when there has been database activity.** It does not create periodic empty archives on a completely idle server. Segments closed early still have the configured segment length.[^wal-config]

18. **Hint-only full-page images depend on checksums or `wal_log_hints`.** A hint-bit-only update is not WAL-logged merely because `full_page_writes` is on. PG18's default-on checksums can increase WAL compared with an older cluster that had both checksums and `wal_log_hints` disabled.[^wal-config]

19. **`pg_stat_wal` lost columns in PG18.** Monitoring code that reads `wal_write` / `wal_sync` / `wal_write_time` / `wal_sync_time` from `pg_stat_wal` will get column-does-not-exist errors after upgrade.[^pg18-statwal] The equivalent data is in `pg_stat_io` filtered by `object = 'wal'`. Migrate queries before upgrading.

20. **WAL summarization is opt-in.** *"summarize_wal = off"* is the default on PG17. Without it, `pg_basebackup --incremental` will refuse to run with an error about missing summaries. Turn it on at install time, not when you need incremental backups.

21. **`commit_siblings` counts other concurrent open transactions, not only commit waiters.** `commit_delay` applies only when that threshold is met and `fsync` is enabled.[^wal-config]

22. **`wal_compression = on` is an alias for `pglz` on PG15–18.** Setting `wal_compression = on` on PG15–18 gives you `pglz`, not `lz4`. The string `'on'` does not pick the best compressor — pick the algorithm explicitly.

    > [!NOTE] PostgreSQL 19
    > On PG19, `wal_compression = on` selects the first of `zstd`, `lz4`, `pglz` that is available, so it no longer means `pglz`.[^pg19-wal-compression]

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

[^pg19-wal-level]: PostgreSQL 19 release notes (RC2), Replication: *"When server variable `wal_level` is `replica`, allow automatic enablement of logical replication when needed"*; read-only `effective_wal_level`. https://www.postgresql.org/docs/19/release-19.html#RELEASE-19-REPLICATION

[^pg19-wal-compression]: PostgreSQL 19 release notes (RC2), Migration: *"Change `wal_compression` equals `on` to use the best WAL compression method available. Previously this always used `pglz`."* Docs: *"The value `on` selects the first of zstd, lz4, pglz that is available. The default value is off."* https://www.postgresql.org/docs/19/release-19.html#RELEASE-19-MIGRATION and https://www.postgresql.org/docs/19/runtime-config-wal.html

[^pg19-wait]: PostgreSQL 19 release notes (RC2), Replication: the `WAIT` command (`WAIT FOR LSN`) and `wal_sender_shutdown_timeout` (by default, senders still wait forever). Command reference: https://www.postgresql.org/docs/19/sql-wait.html . Release notes: https://www.postgresql.org/docs/19/release-19.html#RELEASE-19-REPLICATION

[^pg19-wal-fpi]: PostgreSQL 19 release notes (RC2), Monitoring: `pg_stat_wal` and `pg_stat_get_backend_wal()` report full-page-image bytes. https://www.postgresql.org/docs/19/release-19.html#RELEASE-19-SYSTEM-VIEWS

[^wal-config]: PostgreSQL 16, Write Ahead Log configuration: durability, buffering, archiving, and recovery targets. <https://www.postgresql.org/docs/16/runtime-config-wal.html>

[^slot-view]: PostgreSQL 16, `pg_replication_slots`: WAL retention states and horizon columns. <https://www.postgresql.org/docs/16/view-pg-replication-slots.html>

[^wal-summary-functions]: PostgreSQL 17, WAL Summary Information Functions: result shapes and summary coverage. <https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-WAL-SUMMARY>

[^xid-functions]: PostgreSQL 16, transaction information and commit timestamp functions. <https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-PG-SNAPSHOT>

[^wal-admin-functions]: PostgreSQL 16, backup control functions, including `pg_switch_wal`. <https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-BACKUP>

[^resetwal]: PostgreSQL 16, `pg_resetwal`: last-resort restrictions and `--wal-segsize`. <https://www.postgresql.org/docs/16/app-pgresetwal.html>

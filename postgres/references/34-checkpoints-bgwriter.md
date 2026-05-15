# Checkpoints & Background Writer

A checkpoint is a recovery anchor: the WAL records written before the
checkpoint are no longer required for crash recovery once the checkpoint
has flushed and `fsync`'d every dirty page to permanent storage. The
**checkpointer** process runs them on a schedule; the **background
writer** (bgwriter) is a separate, lower-volume process that flushes
dirty buffers ahead of the clock-sweep replacement code so that
foreground backends do not have to. These two processes share a name in
casual conversation but solve different problems — this file covers the
checkpointer in depth, the bgwriter at the level necessary to
distinguish them, and the operational reality that
**`pg_stat_bgwriter` and `pg_stat_checkpointer` split in PG17**.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — Five Rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [What a checkpoint actually does](#what-a-checkpoint-actually-does)
    - [Triggers: time-based vs WAL-volume vs requested](#triggers-time-based-vs-wal-volume-vs-requested)
    - [Spread checkpoints and `checkpoint_completion_target`](#spread-checkpoints-and-checkpoint_completion_target)
    - [`max_wal_size` and `min_wal_size`](#max_wal_size-and-min_wal_size)
    - [`checkpoint_flush_after` vs `bgwriter_flush_after`](#checkpoint_flush_after-vs-bgwriter_flush_after)
    - [`checkpoint_warning` and the "too frequently" log message](#checkpoint_warning-and-the-too-frequently-log-message)
    - [The `CHECKPOINT` SQL command](#the-checkpoint-sql-command)
    - [Restartpoints (the standby's checkpoint)](#restartpoints-the-standbys-checkpoint)
    - [Background writer mechanics (cross-reference)](#background-writer-mechanics-cross-reference)
    - [pg_stat_bgwriter vs pg_stat_checkpointer (PG17 watershed)](#pg_stat_bgwriter-vs-pg_stat_checkpointer-pg17-watershed)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when you need to:

- Tune `checkpoint_timeout`, `max_wal_size`, or `checkpoint_completion_target` for a write-heavy cluster
- Diagnose why checkpoints are happening "too frequently" (the verbatim log line) or causing I/O spikes
- Understand the operational difference between the checkpointer process and the background writer
- Read `pg_stat_bgwriter` on PG≤16 OR `pg_stat_checkpointer` on PG17+ — including which columns moved at the split
- Decide whether to issue a manual `CHECKPOINT` (almost never — see Recipe 12)
- Read restartpoint metrics on a standby
- Understand the relationship between checkpoint frequency and WAL volume via full-page images (FPI)

This file's twin is [`33-wal.md`](./33-wal.md). The two are deeply linked:
the checkpointer is what cuts off the recovery prefix of the WAL, and
FPI cost is directly amortized over the checkpoint interval. Read both
when tuning write-heavy clusters.

For the bgwriter GUCs themselves (`bgwriter_delay`, `bgwriter_lru_maxpages`,
`bgwriter_lru_multiplier`, `bgwriter_flush_after`) the deep dive is in
[`32-buffer-manager.md`](./32-buffer-manager.md#background-writer); this file
documents the bgwriter at the level required to distinguish it from the
checkpointer and to read the post-PG17 monitoring views correctly.

## Mental Model — Five Rules

1. **A checkpoint is a recovery anchor, not a "save the database" event.** Once the checkpoint completes, every WAL record written *before* the checkpoint's redo pointer is no longer needed for crash recovery. The cluster can in principle recycle that WAL — gated by `min_wal_size`, `wal_keep_size`, replication slots, and archiving status.

2. **Two triggers race; whichever fires first wins.** `checkpoint_timeout` (default 5 minutes) and `max_wal_size` (default 1 GB) are independent ceilings. A high-write cluster will hit `max_wal_size` first; an idle one will hit `checkpoint_timeout`. The mental error is treating only one of them as the active control.

3. **Spread checkpoints are the default on PG14+.** `checkpoint_completion_target = 0.9` means the checkpointer paces itself to finish writing dirty pages at 90% of the way through the interval, then `fsync`'s. *Reducing this value is not recommended* (verbatim docs guidance) — a low target trades steady I/O for a sharper burst.

4. **The bgwriter does NOT prepare for checkpoints.** It writes dirty buffers ahead of the clock-sweep eviction code so backends find clean pages when they need a victim buffer. Checkpoint writes and bgwriter writes are tracked in separate counters and have different rate limits. Tuning the bgwriter does not reduce checkpoint I/O.

5. **Frequent checkpoints multiply WAL volume.** Every page modified for the first time after a checkpoint becomes a full-page image (FPI) in the WAL by default (`full_page_writes = on`). Doubling `checkpoint_timeout` does *not* double WAL volume — it *cuts* it because FPI cost is amortized over a longer window. This is the highest-leverage tuning insight in the file. Cross-reference [`33-wal.md`](./33-wal.md) Rule 5.

## Decision Matrix

| Situation | Action | Avoid | Why |
|---|---|---|---|
| Cluster shows "checkpoints are occurring too frequently" in logs | Raise `max_wal_size`; raise `checkpoint_timeout` to 15–30 min on PG14+ | Cutting `checkpoint_completion_target` | The log message itself recommends raising `max_wal_size` |
| pg_wal disk grows without bound | First check replication slots; then check archive failure; only then raise `min_wal_size` | Setting `max_wal_size` below current WAL volume | `max_wal_size` is a soft limit; slots/archive issues bypass it |
| Crash recovery time is unacceptably long | Lower `checkpoint_timeout` and/or `max_wal_size` | Setting `checkpoint_timeout` below 5 min on an OLTP cluster | Trades faster recovery for higher steady-state I/O and WAL volume |
| Spiky I/O at end of checkpoint interval | Raise `checkpoint_flush_after` (Linux only); confirm `checkpoint_completion_target=0.9` | Lowering completion target | Forced writeback during the write phase reduces the final fsync stall |
| Need to verify a backup is complete | Issue `pg_backup_start()` / `pg_backup_stop()` — they trigger their own checkpoints | Manual `CHECKPOINT` | Manual checkpoint is not the right tool; see Recipe 12 |
| Standby is lagging on apply | Inspect restartpoint stats; raise `max_wal_size` on standby | Forcing `CHECKPOINT` on standby (becomes restartpoint) | Restartpoint follows the same scheduling rules as primary checkpoints |
| Reading checkpoint stats on PG≤16 | Query `pg_stat_bgwriter` (11 columns) | `pg_stat_checkpointer` (doesn't exist) | View was added in PG17 |
| Reading checkpoint stats on PG17+ | Query `pg_stat_checkpointer` (9 cols PG17, 11 cols PG18) | Querying old columns from `pg_stat_bgwriter` (removed) | Five columns moved in PG17; two added in PG18 |
| Confirming a "scheduled vs forced" checkpoint mix | `pg_stat_checkpointer.num_timed` / `num_requested` (PG17+) or `pg_stat_bgwriter.checkpoints_timed` / `checkpoints_req` (PG≤16) | Reading logs only | Counter ratio is the canonical signal |
| Tuning bgwriter to reduce backend writes | See [`32-buffer-manager.md`](./32-buffer-manager.md#background-writer) | Tuning bgwriter to reduce checkpoint volume | Different processes, different work |

Three smell signals you have a checkpoint problem rather than something
else:

- **`checkpoints_req > checkpoints_timed` for hours on end** means `max_wal_size` is undersized for your write rate. Scheduled checkpoints should dominate.
- **Recovery time after `pg_ctl stop -m immediate` is many minutes** means `checkpoint_timeout` and/or `max_wal_size` are too high relative to your durability target.
- **High `pg_stat_io` writer-context write activity but low `pg_stat_checkpointer.buffers_written`** (PG17+) means foreground backends are absorbing the write traffic — see [`32-buffer-manager.md`](./32-buffer-manager.md) Recipe 4 to diagnose.

## Syntax / Mechanics

### What a checkpoint actually does

The verbatim definition from `sql-checkpoint.html`:

> "A checkpoint is a point in the write-ahead log sequence at which all data files have been updated to reflect the information in the log. All data files will be flushed to disk."[^checkpoint-def]

The checkpointer's five steps, in order:

1. **Write a `XLOG_CHECKPOINT_ONLINE` WAL record** with the redo pointer (the LSN at which the checkpoint started — recovery will replay from here on crash).
2. **Scan `shared_buffers` for dirty pages** and write each to disk (still page-cache-resident, not yet fsync'd).
3. **Pace the writes** across `checkpoint_completion_target × checkpoint_timeout` seconds. Optionally forced-writeback (`checkpoint_flush_after`).
4. **`fsync` every file touched** to make the writes durable.
5. **Update `pg_control`** with the new checkpoint location and update `min_recovery_point` for the WAL recycler.

The verbatim from `wal-internals.html`:

> "After a checkpoint has been made and the WAL flushed, the checkpoint's position is saved in the file `pg_control`."[^wal-internals]

> "at the start of recovery, the server first reads `pg_control` and then the checkpoint record; then it performs the REDO operation by scanning forward from the WAL location indicated in the checkpoint record."[^wal-internals]

### Triggers: time-based vs WAL-volume vs requested

The verbatim from `wal-configuration.html`:

> "The server's checkpointer process automatically performs a checkpoint every so often. A checkpoint is begun every checkpoint_timeout seconds, or if max_wal_size is about to be exceeded, whichever comes first."[^wal-config]

Three categories of trigger:

| Trigger | Counter (PG≤16) | Counter (PG17+) | Cause |
|---|---|---|---|
| **Scheduled** | `pg_stat_bgwriter.checkpoints_timed` | `pg_stat_checkpointer.num_timed` | `checkpoint_timeout` elapsed |
| **Requested** | `pg_stat_bgwriter.checkpoints_req` | `pg_stat_checkpointer.num_requested` | `max_wal_size` reached, `CHECKPOINT` SQL command, `pg_backup_start`, shutdown, `CREATE DATABASE` |
| **Skipped (idle)** | (not counted separately) | counted in `num_timed` AND `num_requested`, **but NOT in `num_done` PG18+** | Server was idle since the last checkpoint and there is nothing to flush |

> [!WARNING] PG17 `num_timed` counts skipped checkpoints
> The PG17 `pg_stat_checkpointer.num_timed` column counts both *completed* checkpoints AND scheduled-but-skipped (idle) checkpoints. This is the verbatim docs behavior:[^pg17-numtimed] *"Number of scheduled checkpoints due to timeout. Note that checkpoints may be skipped if the server has been idle since the last one, and this value counts both completed and skipped checkpoints."* The PG18 `num_done` column was added specifically to disambiguate.[^pg18-numdone]

### Spread checkpoints and `checkpoint_completion_target`

The verbatim from `wal-configuration.html`:

> "To avoid flooding the I/O system with a burst of page writes, writing dirty buffers during a checkpoint is spread over a period of time. That period is controlled by `checkpoint_completion_target`, which is given as a fraction of the checkpoint interval (configured by using `checkpoint_timeout`)."[^wal-config]

> "The I/O rate is adjusted so that the checkpoint finishes when the given fraction of `checkpoint_timeout` seconds have elapsed, or before `max_wal_size` is exceeded, whichever is sooner."[^wal-config]

The GUC verbatim from `runtime-config-wal.html`:

> "Specifies the target of checkpoint completion, as a fraction of total time between checkpoints. The default is 0.9, which spreads the checkpoint across almost all of the available interval, providing fairly consistent I/O load while also leaving some time for checkpoint completion overhead. **Reducing this parameter is not recommended** because it causes the checkpoint to complete faster. This results in a higher rate of I/O during the checkpoint followed by a period of less I/O between the checkpoint completion and the next scheduled checkpoint."[^completion-target]

> [!NOTE] PostgreSQL 14
> The default of `checkpoint_completion_target` changed from `0.5` to `0.9`.[^pg14-cct] If your `postgresql.conf` still carries an explicit `0.5` setting from a PG≤13 deployment, remove it on upgrade — the new default is almost certainly what you want.

### `max_wal_size` and `min_wal_size`

The two WAL-volume GUCs work as a band:

- **`min_wal_size`** (default 80 MB): as long as `pg_wal` usage stays under this, *recycle* old WAL files rather than deleting them, so the cluster has segments ready for spikes.
- **`max_wal_size`** (default 1 GB): trigger a checkpoint when WAL written since the last one approaches this size. The cluster will exceed this under load, slot retention, archive failure, or high `wal_keep_size` — it is a *soft* limit.

Verbatim from `runtime-config-wal.html`:

> `max_wal_size`: "Maximum size to let the WAL grow during automatic checkpoints. This is a soft limit; WAL size can exceed `max_wal_size` under special circumstances, such as heavy load, a failing `archive_command` or `archive_library`, or a high `wal_keep_size` setting. ... The default is 1 GB. Increasing this parameter can increase the amount of time needed for crash recovery."[^max-wal-size]

> `min_wal_size`: "As long as WAL disk usage stays below this setting, old WAL files are always recycled for future use at a checkpoint, rather than removed. This can be used to ensure that enough WAL space is reserved to handle spikes in WAL usage, for example when running large batch jobs. ... The default is 80 MB."[^min-wal-size]

Typical OLTP sizing tier:

| Sustained write rate | `max_wal_size` starting point | `checkpoint_timeout` | Notes |
|---|---|---|---|
| < 5 MB/s | 1 GB (default) | 5 min (default) | Default OK |
| 5–50 MB/s | 4–16 GB | 15 min | Reduces checkpoint frequency, cuts FPI volume |
| 50–500 MB/s | 32–128 GB | 30 min | Watch `pg_wal` disk capacity |
| > 500 MB/s | 256 GB+ | 30 min–1h | Verify recovery-time SLO; ensure `pg_wal` is on its own fast volume |

### `checkpoint_flush_after` vs `bgwriter_flush_after`

Both GUCs do "forced writeback" — issue `sync_file_range()` (Linux) to push dirty kernel-page-cache data toward storage incrementally rather than letting it pile up for the final `fsync`. They differ only in **which process** does the writing.

Verbatim from `runtime-config-wal.html`:

> `checkpoint_flush_after`: "Whenever more than this amount of data has been written while performing a checkpoint, attempt to force the OS to issue these writes to the underlying storage. Doing so will limit the amount of dirty data in the kernel's page cache, reducing the likelihood of stalls when an `fsync` is issued at the end of the checkpoint, or when the OS writes data back in larger batches in the background. ... The default is `256kB` on Linux, `0` elsewhere."[^cflush]

Verbatim from `runtime-config-resource.html`:

> `bgwriter_flush_after`: "Whenever more than this amount of data has been written by the background writer, attempt to force the OS to issue these writes to the underlying storage. ... The default is `512kB` on Linux, `0` elsewhere."[^bgflush]

The defaults are *different* (256 kB vs 512 kB) — easy to conflate. Both round to multiples of `BLCKSZ` (typically 8 kB). Set both to `0` to disable forced writeback entirely; valid range is `0` to `2MB`.

### `checkpoint_warning` and the "too frequently" log message

`checkpoint_warning` is the log-trigger sister of `max_wal_size`:

> "Write a message to the server log if checkpoints caused by the filling of WAL segment files happen closer together than this amount of time (which suggests that `max_wal_size` ought to be raised). ... The default is 30 seconds (`30s`). Zero disables the warning. No warnings will be generated if `checkpoint_timeout` is less than `checkpoint_warning`."[^warning]

The log message that fires (typical form):

```
LOG:  checkpoints are occurring too frequently (12 seconds apart)
HINT:  Consider increasing the configuration parameter "max_wal_size".
```

The HINT names `max_wal_size` — not `checkpoint_timeout` — because requested
(WAL-volume-triggered) checkpoints are the ones that fire too frequently.

### The `CHECKPOINT` SQL command

Verbatim from `sql-checkpoint.html`:

> "The `CHECKPOINT` command forces an immediate checkpoint when the command is issued, without waiting for a regular checkpoint scheduled by the system"[^checkpoint-cmd]

> [!WARNING] Almost never use `CHECKPOINT` in production
> The docs are explicit:[^checkpoint-not-routine] *"`CHECKPOINT` is not intended for use during normal operation."* The legitimate use cases are: (a) explicitly testing crash recovery, (b) running a base backup using `pg_dump --no-acl --no-owner` on a stable snapshot, (c) part of a known-good runbook (e.g., before powering off a host). Most operators reach for `CHECKPOINT` for the wrong reasons; the right answer is usually to wait for the next scheduled checkpoint or to raise `max_wal_size`.

> [!NOTE] PostgreSQL 15
> Pre-PG15, `CHECKPOINT` required superuser. PG15 added the `pg_checkpoint` predefined role:[^pg15-role] *"Only superusers or users with the privileges of the `pg_checkpoint` role can call `CHECKPOINT`."*

On a standby, `CHECKPOINT` forces a *restartpoint* rather than a true checkpoint — see the next section.

### Restartpoints (the standby's checkpoint)

A standby cannot create new checkpoints (only the primary writes WAL) but it does perform the analogous flush-and-fsync work after replaying a checkpoint record. This is a **restartpoint**: when the recovery process encounters a checkpoint record in the WAL stream, the standby's checkpointer flushes dirty buffers and updates `pg_control` so a re-restarted standby can begin recovery from there rather than from the start of the archived WAL.

Counters (PG17+ only, via `pg_stat_checkpointer`):

| Column | Meaning |
|---|---|
| `restartpoints_timed` | Restartpoints scheduled by time (including skipped) |
| `restartpoints_req` | Restartpoints requested (including skipped) |
| `restartpoints_done` | Restartpoints actually completed |

Restartpoint sizing follows the same `max_wal_size` / `checkpoint_timeout` rules
on the standby as on the primary — set them appropriately on each.

### Background writer mechanics (cross-reference)

The background writer is a **separate process** from the checkpointer. It
runs continuously, sleeping `bgwriter_delay` (default 200ms) between rounds,
and in each round writes up to `bgwriter_lru_maxpages` (default 100) dirty
buffers ahead of the clock-sweep replacement code so foreground backends
do not have to write their own.

The full algorithm from `runtime-config-resource.html`:

> "The number of dirty buffers written in each round is based on the number of new buffers that have been needed by server processes during recent rounds. The average recent need is multiplied by `bgwriter_lru_multiplier` to arrive at an estimate of the number of buffers that will be needed during the next round. Dirty buffers are written until there are that many clean, reusable buffers available. (However, no more than `bgwriter_lru_maxpages` buffers will be written per round.) Thus, a setting of 1.0 represents a 'just in time' policy of writing exactly the number of buffers predicted to be needed. Larger values provide some cushion against spikes in demand, while smaller values intentionally leave writes to be done by server processes. The default is 2.0."[^bg-mult]

Note that bgwriter writes and checkpointer writes are **disjoint counters**:

| Process | Pre-PG17 counter | PG17+ counter |
|---|---|---|
| Background writer (LRU-driven) | `pg_stat_bgwriter.buffers_clean` | `pg_stat_bgwriter.buffers_clean` (unchanged) |
| Checkpointer (interval-driven) | `pg_stat_bgwriter.buffers_checkpoint` | `pg_stat_checkpointer.buffers_written` |
| Backends (write-when-victim) | `pg_stat_bgwriter.buffers_backend` | **Removed** — use `pg_stat_io` |

Tuning bgwriter reduces backend writes but does **not** reduce checkpoint writes.
For the bgwriter deep dive (per-second-write-ceiling math, sizing, the
`bgwriter_lru_maxpages = 0` "disable" mode), see
[`32-buffer-manager.md`](./32-buffer-manager.md#background-writer).

### `pg_stat_bgwriter` vs `pg_stat_checkpointer` (PG17 watershed)

> [!WARNING] PostgreSQL 17 — view split
> The PG17 release notes contain the most operationally-significant
> monitoring change of recent versions:[^pg17-split]
>
> *"Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."*
>
> Every monitoring query written against `pg_stat_bgwriter` for
> `checkpoints_timed`, `checkpoints_req`, `checkpoint_write_time`,
> `checkpoint_sync_time`, `buffers_checkpoint`, `buffers_backend`, or
> `buffers_backend_fsync` will silently return zero rows on PG17+ because
> the columns are gone (the view exists but is empty of those columns).
> Two columns — `buffers_backend` and `buffers_backend_fsync` — were
> **removed outright** (not moved to `pg_stat_checkpointer`); the docs say:[^pg17-buffers-backend] *"These fields are considered redundant to similar columns in `pg_stat_io`."*

PG16 `pg_stat_bgwriter` (11 columns) and where each went on PG17+:

| PG16 column | PG17+ location |
|---|---|
| `checkpoints_timed` | `pg_stat_checkpointer.num_timed` |
| `checkpoints_req` | `pg_stat_checkpointer.num_requested` |
| `checkpoint_write_time` | `pg_stat_checkpointer.write_time` |
| `checkpoint_sync_time` | `pg_stat_checkpointer.sync_time` |
| `buffers_checkpoint` | `pg_stat_checkpointer.buffers_written` |
| `buffers_clean` | `pg_stat_bgwriter.buffers_clean` (unchanged) |
| `maxwritten_clean` | `pg_stat_bgwriter.maxwritten_clean` (unchanged) |
| `buffers_alloc` | `pg_stat_bgwriter.buffers_alloc` (unchanged) |
| `buffers_backend` | **REMOVED** — use `pg_stat_io` filtered by `backend_type` |
| `buffers_backend_fsync` | **REMOVED** — use `pg_stat_io` |
| `stats_reset` | both views retain their own `stats_reset` |

PG17 `pg_stat_checkpointer` (9 columns):

| Column | Type | Meaning |
|---|---|---|
| `num_timed` | bigint | Scheduled checkpoints due to timeout (counts skipped) |
| `num_requested` | bigint | Requested checkpoints (counts skipped) |
| `restartpoints_timed` | bigint | Scheduled restartpoints (counts skipped) |
| `restartpoints_req` | bigint | Requested restartpoints (counts skipped) |
| `restartpoints_done` | bigint | Restartpoints actually completed |
| `write_time` | double precision | ms spent writing in checkpoints + restartpoints |
| `sync_time` | double precision | ms spent in fsync at end of checkpoint/restartpoint |
| `buffers_written` | bigint | Buffers written during checkpoints + restartpoints |
| `stats_reset` | timestamptz | Last reset |

> [!NOTE] PostgreSQL 18
> Two columns added to `pg_stat_checkpointer`:[^pg18-numdone][^pg18-slru]
>
> - **`num_done`** — *"Number of checkpoints that have been performed"* (excludes skipped checkpoints — the disambiguator for `num_timed`).
> - **`slru_written`** — *"Number of SLRU buffers written during checkpoints and restartpoints."* PG18 also modifies the checkpoint server-log message to report shared-buffer and SLRU-buffer counts separately.
>
> On PG18, the right "actual checkpoint rate" formula is `num_done / interval`, not `num_timed + num_requested / interval` (which double-counts skipped). Recipe 4 uses the right form for each version.

### Per-version timeline

| Version | Change | Quote (verbatim) |
|---|---|---|
| **PG14** | `checkpoint_completion_target` default changed from 0.5 to 0.9 | "Change checkpoint_completion_target default to 0.9 (Stephen Frost). The previous default was 0.5."[^pg14-cct] |
| **PG15** | `log_checkpoints` default changed to `on` | "This changes the default of `log_checkpoints` to `on` and that of `log_autovacuum_min_duration` to 10 minutes."[^pg15-logchk] |
| **PG15** | Checkpointer + bgwriter run during crash recovery | "Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro). This helps to speed up long crash recoveries."[^pg15-crash] |
| **PG15** | `pg_checkpoint` predefined role | (See `sql-checkpoint.html`)[^pg15-role] |
| **PG16** | `log_checkpoints` messages add REDO LSN | "Add checkpoint and `REDO LSN` information to `log_checkpoints` messages (Bharath Rupireddy, Kyotaro Horiguchi)."[^pg16-redo] |
| **PG17** | `pg_stat_checkpointer` view created; relevant cols moved from `pg_stat_bgwriter` | "Create system view `pg_stat_checkpointer` ... Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."[^pg17-split] |
| **PG17** | `buffers_backend` and `buffers_backend_fsync` removed | "Remove `buffers_backend` and `buffers_backend_fsync` from `pg_stat_bgwriter` ... These fields are considered redundant to similar columns in `pg_stat_io`."[^pg17-buffers-backend] |
| **PG17** | Wait events for checkpoint delays | "Add wait events for checkpoint delays (Thomas Munro)."[^pg17-waits] |
| **PG18** | `pg_stat_checkpointer.num_done` column | "Add column `pg_stat_checkpointer.num_done` to report the number of completed checkpoints (Anton A. Melnikov). Columns `num_timed` and `num_requested` count both completed and skipped checkpoints."[^pg18-numdone] |
| **PG18** | `pg_stat_checkpointer.slru_written` column + log-message change | "Add column `pg_stat_checkpointer.slru_written` to report SLRU buffers written (Nitin Jadhav). Also, modify the checkpoint server log message to report separate shared buffer and SLRU buffer values."[^pg18-slru] |
| **PG18** | WAL-buffer-full count in `EXPLAIN (WAL)` and autovacuum logs | "Add full WAL buffer count to `EXPLAIN (WAL)` output (Bertrand Drouvot)." / "Add full WAL buffer count to `VACUUM`/`ANALYZE (VERBOSE)` and autovacuum log output (Bertrand Drouvot)."[^pg18-walbufs] |

## Examples / Recipes

### Recipe 1 — Baseline OLTP checkpoint configuration

For a 64 GB host with 1 TB SSD and sustained 20–50 MB/s WAL volume:

```ini
# postgresql.conf
checkpoint_timeout = 15min          # was 5min default; reduces FPI cost
max_wal_size = 16GB                 # was 1GB default; survives 5-min write bursts
min_wal_size = 2GB                  # keeps segments recycled for spikes
checkpoint_completion_target = 0.9  # PG14+ default; do not lower
checkpoint_warning = 30s            # default; surface unscheduled checkpoints in logs
checkpoint_flush_after = 1MB        # Linux only; smoother end-of-checkpoint fsync
log_checkpoints = on                # PG15+ default; keep on for diagnostics
```

The single most important non-default is `max_wal_size = 16GB` —
the 1 GB default forces checkpoints every few minutes on any non-trivial
write workload, multiplying WAL volume via FPI. Pair with
`pg_wal` on its own fast volume of at least 32 GB.

### Recipe 2 — Diagnose "checkpoints occurring too frequently"

```sql
-- PG≤16
SELECT
    checkpoints_timed,
    checkpoints_req,
    checkpoints_req::numeric /
        NULLIF(checkpoints_timed + checkpoints_req, 0) AS req_fraction,
    checkpoint_write_time / 1000 AS write_time_sec,
    checkpoint_sync_time / 1000 AS sync_time_sec,
    buffers_checkpoint,
    stats_reset
FROM pg_stat_bgwriter;
```

```sql
-- PG17+
SELECT
    num_timed,
    num_requested,
    num_requested::numeric /
        NULLIF(num_timed + num_requested, 0) AS req_fraction,
    write_time / 1000 AS write_time_sec,
    sync_time / 1000 AS sync_time_sec,
    buffers_written,
    stats_reset
FROM pg_stat_checkpointer;
```

Interpretation:

- `req_fraction > 0.2` for hours: `max_wal_size` is undersized. Raise it.
- `sync_time` dominates `write_time`: filesystem `fsync` is the bottleneck. Investigate
  storage I/O capacity; `checkpoint_flush_after` may help on Linux.
- `req_fraction ≈ 0` and `num_timed` rising steadily: healthy. Checkpoints are
  scheduled, not forced.

### Recipe 3 — Compute actual checkpoint interval

Measure the elapsed time since `stats_reset` and divide.

```sql
-- PG17+
SELECT
    now() - stats_reset AS observation_window,
    num_timed + num_requested AS total_checkpoints,
    (extract(epoch from (now() - stats_reset)) /
     GREATEST(num_timed + num_requested, 1))::int AS avg_interval_sec
FROM pg_stat_checkpointer;
```

Compare to `current_setting('checkpoint_timeout')`. If `avg_interval_sec`
is materially smaller, you are checkpoint-volume-driven (raise `max_wal_size`).

### Recipe 4 — PG18+ actual checkpoint rate (excludes skipped)

```sql
-- PG18+
SELECT
    num_done,
    num_timed - num_done AS skipped_timed,
    num_requested - (num_done - (num_timed - num_done)) AS computed_done_requested,
    extract(epoch from (now() - stats_reset)) /
        GREATEST(num_done, 1) AS sec_per_completed_checkpoint
FROM pg_stat_checkpointer;
```

The `sec_per_completed_checkpoint` value is the actually-paid interval
between completed checkpoints. Pre-PG18, you cannot distinguish skipped
from completed in the counters — the value would include idle skips and
appear faster than reality.

### Recipe 5 — Audit checkpoint-related GUCs and their current values

```sql
SELECT name, setting, unit, source, sourcefile, context
FROM pg_settings
WHERE name IN (
    'checkpoint_timeout',
    'max_wal_size',
    'min_wal_size',
    'checkpoint_completion_target',
    'checkpoint_flush_after',
    'checkpoint_warning',
    'log_checkpoints',
    'bgwriter_delay',
    'bgwriter_lru_maxpages',
    'bgwriter_lru_multiplier',
    'bgwriter_flush_after'
)
ORDER BY name;
```

The `context` column tells you which require restart vs reload:

- `postmaster` — restart only (none of these are postmaster-only, but verify)
- `sighup` — reload via `pg_reload_conf()` or `SIGHUP`
- `user` — `SET` (none of these are session-settable)

### Recipe 6 — Force a checkpoint before a planned outage

Legitimate use: minimize crash-recovery time after `pg_ctl stop -m immediate`
or hardware-level power-off. Issue `CHECKPOINT` *just before* stopping the
postmaster.

```sql
-- As superuser or member of pg_checkpoint (PG15+):
CHECKPOINT;
```

Side effect: spike of I/O during the command. Acceptable when the host is
being taken down anyway.

> [!WARNING]
> Do not use `CHECKPOINT` to "speed up" backups, to "force a flush" before reading replication lag, or as a periodic maintenance task. None of those are correct.

### Recipe 7 — Measure FPI cost vs checkpoint interval

Take snapshots of `pg_stat_wal` before and after a representative
workload (e.g., a pgbench run) at two different `checkpoint_timeout`
settings:

```sql
-- Before workload
SELECT wal_records, wal_fpi, wal_bytes, stats_reset FROM pg_stat_wal;

-- ... run workload for N minutes ...

-- After workload
SELECT wal_records, wal_fpi, wal_bytes, stats_reset FROM pg_stat_wal;
```

Compute the FPI fraction:

```
fpi_fraction = wal_fpi_delta / wal_records_delta
fpi_bytes_fraction = (wal_fpi_delta * 8KB) / wal_bytes_delta
```

A healthy OLTP cluster sees FPI by bytes 30–70% of WAL volume. >70%
means your checkpoint interval is too short for the workload's working
set. Cross-reference [`33-wal.md`](./33-wal.md) Recipe 6.

> [!NOTE] PostgreSQL 18
> `pg_stat_wal` lost its `wal_write` / `wal_sync` / `wal_write_time` / `wal_sync_time` columns in PG18 — those moved to `pg_stat_io`. The `wal_records` / `wal_fpi` / `wal_bytes` columns remain.

### Recipe 8 — Monitor checkpoints from the log

With `log_checkpoints = on` (PG15+ default), the server log gets a line per
completed checkpoint:

```
LOG: checkpoint starting: time
LOG: checkpoint complete: wrote 12345 buffers (4.7%); 0 WAL file(s) added,
     0 removed, 23 recycled; write=270.123 s, sync=0.456 s, total=270.598 s;
     sync files=42, longest=0.123 s, average=0.012 s; distance=5432123 kB,
     estimate=5500000 kB
```

Critical fields:

- `wrote ... buffers` and `(N.N%)` — fraction of shared_buffers dirtied
- `write=N s` — time spent in spread-write phase
- `sync=N s` — time spent in final fsync (the spiky part)
- `distance` — WAL bytes since last checkpoint
- `estimate` — projected WAL bytes for next checkpoint (used to pace)

PG16+ adds the REDO LSN to the message.[^pg16-redo] PG18+ adds separate
shared/SLRU buffer counts.[^pg18-slru]

### Recipe 9 — Compute starting `max_wal_size` from observed write rate

If you don't know the right `max_wal_size`, measure the write rate and
size to keep `req_fraction < 0.1`.

```sql
-- PG17+
WITH s AS (
    SELECT
        pg_current_wal_lsn() AS lsn_now,
        now() AS t_now
), prev AS (
    SELECT
        lsn AS lsn_prev,
        t AS t_prev
    FROM (VALUES (pg_current_wal_lsn(), now())) AS x(lsn, t)
)
SELECT 'measure twice 10 min apart, then compute MB/min from lsn diff';
```

The simpler approach: log `pg_current_wal_lsn()` from `cron` at a
fixed cadence and graph the rate. Right-size `max_wal_size` to
`5 × write_rate_per_minute × checkpoint_timeout_minutes` so a
five-minute burst doesn't trip a requested checkpoint.

### Recipe 10 — Identify standbys with restartpoint problems

```sql
-- Run on the STANDBY, PG17+
SELECT
    restartpoints_timed,
    restartpoints_req,
    restartpoints_done,
    (restartpoints_timed + restartpoints_req) - restartpoints_done AS skipped,
    write_time / 1000 AS write_time_sec,
    sync_time / 1000 AS sync_time_sec
FROM pg_stat_checkpointer;
```

If `restartpoints_done` is much smaller than `restartpoints_timed +
restartpoints_req`, many restartpoints are being skipped because the
standby has nothing new to flush — this is healthy on a streaming standby
with low write volume.

### Recipe 11 — Schedule `log_checkpoints` review with pg_cron

> [!NOTE] Placeholder — no runnable SQL
> A checkpoint log parsing recipe (grep + summarize from pg_log_directory) cannot be expressed as a single SQL statement. The pattern — log `log_checkpoints = on` output to your observability stack, then alert on `requested` checkpoint rate — is documented in [`82-monitoring.md`](./82-monitoring.md). A `pg_cron` schedule can trigger an external script, but the in-database SQL body would just be a shell passthrough outside the database engine. This recipe is intentionally left without runnable code; see [`82-monitoring.md`](./82-monitoring.md) and [`98-pg-cron.md`](./98-pg-cron.md) for the full pattern.

### Recipe 12 — Verify the `CHECKPOINT` SQL command is justified

Before issuing `CHECKPOINT` in production, ask:

1. Is the cluster about to be cleanly stopped? — `pg_ctl stop -m fast` already triggers a final checkpoint. Skip the manual one.
2. Is the cluster about to be `kill -9`'d or hardware-power-cycled? — Yes, `CHECKPOINT` first.
3. Are you taking a base backup with `pg_basebackup`? — `pg_basebackup` triggers its own checkpoint (configurable as `--checkpoint=spread` or `--checkpoint=fast`). Skip the manual one.
4. Are you doing exotic recovery work? — Read the runbook again.

Run `CHECKPOINT` only for case (2).

### Recipe 13 — Reset checkpoint stats for clean measurement

Before tuning, reset the counter so the window is unambiguous:

```sql
-- PG17+: resets pg_stat_checkpointer
SELECT pg_stat_reset_shared('checkpointer');

-- All versions: also reset bgwriter
SELECT pg_stat_reset_shared('bgwriter');
```

Wait at least `2 × checkpoint_timeout` to get a meaningful sample.

## Gotchas / Anti-patterns

1. **`pg_stat_bgwriter.checkpoints_timed` does not exist on PG17+.** Queries using the old column return zero rows or error. Use `pg_stat_checkpointer.num_timed` on PG17+.[^pg17-split]
2. **`pg_stat_checkpointer.num_timed` includes skipped (idle) checkpoints on PG17.** Use PG18+ `num_done` for actually-completed.[^pg17-numtimed][^pg18-numdone]
3. **`buffers_backend` removed in PG17.** Replace with a `pg_stat_io` query filtered by `backend_type` and write-context.[^pg17-buffers-backend] See [`32-buffer-manager.md`](./32-buffer-manager.md) Recipe 4.
4. **`max_wal_size` is a soft limit, not a cap.** Slot retention, archive failure, or high `wal_keep_size` will push `pg_wal` above this size. `pg_wal` capacity planning must account for the worst case, not the configured value.[^max-wal-size]
5. **Lowering `checkpoint_completion_target` below 0.9 is almost always wrong.** The docs explicitly say *"Reducing this parameter is not recommended"*.[^completion-target] A lower target trades steady I/O for a sharper burst — and the burst happens to coincide with the next interval's start, which can cascade.
6. **`checkpoint_timeout = 30s` is not a tuning option.** The valid range is 30s to 1 day, but values below ~5 minutes are pathological for OLTP — every modified page becomes FPI within seconds.[^checkpoint-timeout]
7. **`CHECKPOINT` is not idempotent.** It always does the work even if a scheduled checkpoint just completed. The verbatim docs:[^checkpoint-not-routine] *"`CHECKPOINT` is not intended for use during normal operation."*
8. **`log_checkpoints = off` on PG15+ requires explicit configuration.** The default is `on` since PG15.[^pg15-logchk] If you don't see checkpoint log lines on a PG15+ cluster, something has explicitly disabled them.
9. **The bgwriter cannot make a checkpoint go faster.** Tuning `bgwriter_*` parameters changes how backends get clean buffers but has no effect on checkpoint I/O volume or pacing. Different processes.
10. **`buffers_alloc` is demand, not supply.** A reader who confuses `pg_stat_bgwriter.buffers_alloc` (allocations requested) with `pg_stat_checkpointer.buffers_written` (checkpoint output) will misdiagnose every bottleneck. See [`32-buffer-manager.md`](./32-buffer-manager.md) gotcha #8.
11. **Pre-PG14 `checkpoint_completion_target = 0.5` carried forward in configs.** If your `postgresql.conf` was last tuned on PG≤13 and contains an explicit `checkpoint_completion_target = 0.5`, that value is now ~2× the burst it was on PG13. Remove the line to use the PG14+ default 0.9.[^pg14-cct]
12. **`min_wal_size` does not guarantee that many segments will be retained.** It's a recycling threshold: WAL files below this size are recycled rather than deleted at checkpoint. Replication slots, archiving, and `wal_keep_size` interact independently.[^min-wal-size]
13. **`CHECKPOINT` on a standby is a restartpoint, not a checkpoint.** Same SQL command, different semantics on a hot standby.[^checkpoint-cmd] If you need to know the standby has flushed up to a specific LSN, monitor `pg_last_wal_replay_lsn()` and the restartpoint counters.
14. **Skipped checkpoints inflate the `num_timed` counter on PG17.** A cluster that is idle 90% of the time still ticks `num_timed` every `checkpoint_timeout`. The PG18 `num_done` column was added to make this distinguishable.[^pg18-numdone]
15. **`checkpoint_flush_after` and `bgwriter_flush_after` have *different* defaults.** 256 kB and 512 kB respectively on Linux, 0 elsewhere. Operators tuning one and not the other often introduce I/O asymmetry.[^cflush][^bgflush]
16. **`checkpoint_warning` is silent if it's shorter than `checkpoint_timeout`.** The verbatim docs:[^warning] *"No warnings will be generated if `checkpoint_timeout` is less than `checkpoint_warning`."* — but the other direction is silent too: a cluster that scheduled-checkpoints every 30s would never trigger the warning unless the `checkpoint_warning` value were also reduced.
17. **The `CHECKPOINT` permission predates `pg_checkpoint`.** Pre-PG15, only superusers could issue `CHECKPOINT`. PG15 added the `pg_checkpoint` predefined role; granting that role to a monitoring user is preferable to granting superuser.[^pg15-role]
18. **`pg_stat_checkpointer.write_time` and `sync_time` include restartpoint work on a standby.** On a primary they are checkpoint-only. The column descriptions are clear but readers often assume they are per-checkpoint.[^pg17-cp-view]
19. **`pg_stat_checkpointer.buffers_written` on PG17 does not break out SLRU buffers.** On PG18+ the new `slru_written` column splits SLRU from shared-buffer writes.[^pg18-slru]
20. **Crash-recovery time scales with `checkpoint_timeout`, not `max_wal_size`.** The verbatim from the `checkpoint_timeout` docs:[^checkpoint-timeout] *"Increasing this parameter can increase the amount of time needed for crash recovery."* — and similarly for `max_wal_size`. The dominant factor in practice is *time since last checkpoint × per-second write rate*, which the timeout caps.
21. **The PG18 server-log checkpoint message changed format.** Tooling that parses checkpoint log lines (Datadog, Prometheus exporters, custom scripts) must be updated for the shared-vs-SLRU split.[^pg18-slru]
22. **`pg_backup_start()` triggers its own checkpoint.** Manually issuing `CHECKPOINT` immediately before `pg_backup_start()` is redundant work and adds I/O spike for no benefit.
23. **The bgwriter does not write back the WAL itself.** WAL writeback is done by the WAL writer (`wal_writer_*` GUCs) and per-commit `fsync`. Conflating bgwriter and WAL writer is a frequent confusion.

## See Also

- [`32-buffer-manager.md`](./32-buffer-manager.md) — shared_buffers, clock-sweep, bgwriter deep dive
- [`33-wal.md`](./33-wal.md) — WAL format, `wal_level`, `full_page_writes`, archive_command, FPI cost
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — how vacuum interacts with checkpoints (dirties pages, triggers FPI)
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — hint-bit dirtying and its WAL interaction with checkpoints
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC contexts and `ALTER SYSTEM`
- [`54-memory-tuning.md`](./54-memory-tuning.md) — relationship between shared_buffers and checkpoint write volume
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — the full `pg_stat_*` catalog
- [`73-streaming-replication.md`](./73-streaming-replication.md) — standby restartpoints
- [`82-monitoring.md`](./82-monitoring.md) — alert thresholds for checkpoint metrics
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — `pg_basebackup` triggers a checkpoint
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling checkpoint-related maintenance
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version PG feature index

## Sources

[^checkpoint-def]: PostgreSQL 16 `sql-checkpoint.html`: *"A checkpoint is a point in the write-ahead log sequence at which all data files have been updated to reflect the information in the log. All data files will be flushed to disk."* https://www.postgresql.org/docs/16/sql-checkpoint.html

[^checkpoint-cmd]: PostgreSQL 16 `sql-checkpoint.html`: *"The CHECKPOINT command forces an immediate checkpoint when the command is issued, without waiting for a regular checkpoint scheduled by the system ... If executed during recovery, the CHECKPOINT command will force a restartpoint (see Section 30.5) rather than writing a new checkpoint."* https://www.postgresql.org/docs/16/sql-checkpoint.html

[^checkpoint-not-routine]: PostgreSQL 16 `sql-checkpoint.html`: *"CHECKPOINT is not intended for use during normal operation."* https://www.postgresql.org/docs/16/sql-checkpoint.html

[^wal-internals]: PostgreSQL 16 `wal-internals.html`: *"After a checkpoint has been made and the WAL flushed, the checkpoint's position is saved in the file pg_control."* / *"at the start of recovery, the server first reads pg_control and then the checkpoint record; then it performs the REDO operation by scanning forward from the WAL location indicated in the checkpoint record."* https://www.postgresql.org/docs/16/wal-internals.html

[^wal-config]: PostgreSQL 16 `wal-configuration.html`: *"The server's checkpointer process automatically performs a checkpoint every so often. A checkpoint is begun every checkpoint_timeout seconds, or if max_wal_size is about to be exceeded, whichever comes first."* / *"To avoid flooding the I/O system with a burst of page writes, writing dirty buffers during a checkpoint is spread over a period of time. That period is controlled by checkpoint_completion_target, which is given as a fraction of the checkpoint interval (configured by using checkpoint_timeout). The I/O rate is adjusted so that the checkpoint finishes when the given fraction of checkpoint_timeout seconds have elapsed, or before max_wal_size is exceeded, whichever is sooner."* https://www.postgresql.org/docs/16/wal-configuration.html

[^checkpoint-timeout]: PostgreSQL 16 `runtime-config-wal.html`: *"Maximum time between automatic WAL checkpoints. ... The valid range is between 30 seconds and one day. The default is five minutes (5min). Increasing this parameter can increase the amount of time needed for crash recovery."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^completion-target]: PostgreSQL 16 `runtime-config-wal.html`: *"Specifies the target of checkpoint completion, as a fraction of total time between checkpoints. The default is 0.9 ... Reducing this parameter is not recommended because it causes the checkpoint to complete faster. This results in a higher rate of I/O during the checkpoint followed by a period of less I/O between the checkpoint completion and the next scheduled checkpoint."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^cflush]: PostgreSQL 16 `runtime-config-wal.html`, `checkpoint_flush_after`: *"Whenever more than this amount of data has been written while performing a checkpoint, attempt to force the OS to issue these writes to the underlying storage ... The default is 256kB on Linux, 0 elsewhere."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^warning]: PostgreSQL 16 `runtime-config-wal.html`, `checkpoint_warning`: *"Write a message to the server log if checkpoints caused by the filling of WAL segment files happen closer together than this amount of time (which suggests that max_wal_size ought to be raised). ... The default is 30 seconds (30s). Zero disables the warning. No warnings will be generated if checkpoint_timeout is less than checkpoint_warning."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^max-wal-size]: PostgreSQL 16 `runtime-config-wal.html`, `max_wal_size`: *"Maximum size to let the WAL grow during automatic checkpoints. This is a soft limit; WAL size can exceed max_wal_size under special circumstances, such as heavy load, a failing archive_command or archive_library, or a high wal_keep_size setting. ... The default is 1 GB."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^min-wal-size]: PostgreSQL 16 `runtime-config-wal.html`, `min_wal_size`: *"As long as WAL disk usage stays below this setting, old WAL files are always recycled for future use at a checkpoint, rather than removed. ... The default is 80 MB."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^bgflush]: PostgreSQL 16 `runtime-config-resource.html`, `bgwriter_flush_after`: *"Whenever more than this amount of data has been written by the background writer, attempt to force the OS to issue these writes to the underlying storage ... The default is 512kB on Linux, 0 elsewhere."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^bg-mult]: PostgreSQL 16 `runtime-config-resource.html`, `bgwriter_lru_multiplier`: *"The number of dirty buffers written in each round is based on the number of new buffers that have been needed by server processes during recent rounds. The average recent need is multiplied by bgwriter_lru_multiplier to arrive at an estimate of the number of buffers that will be needed during the next round. Dirty buffers are written until there are that many clean, reusable buffers available. (However, no more than bgwriter_lru_maxpages buffers will be written per round.) Thus, a setting of 1.0 represents a 'just in time' policy of writing exactly the number of buffers predicted to be needed. Larger values provide some cushion against spikes in demand, while smaller values intentionally leave writes to be done by server processes. The default is 2.0."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^pg14-cct]: PostgreSQL 14 release notes (E.23.3.1.9 Server Configuration): *"Change checkpoint_completion_target default to 0.9 (Stephen Frost). The previous default was 0.5."* https://www.postgresql.org/docs/release/14.0/

[^pg15-logchk]: PostgreSQL 15 release notes: *"Enable default logging of checkpoints and slow autovacuum operations (Bharath Rupireddy). This changes the default of log_checkpoints to on and that of log_autovacuum_min_duration to 10 minutes. This will cause even an idle server to generate some log output, which might cause problems on resource-constrained servers without log file rotation. These defaults should be changed in such cases."* https://www.postgresql.org/docs/release/15.0/

[^pg15-crash]: PostgreSQL 15 release notes: *"Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro). This helps to speed up long crash recoveries."* https://www.postgresql.org/docs/release/15.0/

[^pg15-role]: PostgreSQL 16 `sql-checkpoint.html`: *"Only superusers or users with the privileges of the pg_checkpoint role can call CHECKPOINT."* (Role added in PG15.) https://www.postgresql.org/docs/16/sql-checkpoint.html

[^pg16-redo]: PostgreSQL 16 release notes: *"Add checkpoint and REDO LSN information to log_checkpoints messages (Bharath Rupireddy, Kyotaro Horiguchi)."* https://www.postgresql.org/docs/release/16.0/

[^pg17-split]: PostgreSQL 17 release notes: *"Create system view pg_stat_checkpointer (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from pg_stat_bgwriter and added to this new system view."* https://www.postgresql.org/docs/release/17.0/

[^pg17-buffers-backend]: PostgreSQL 17 release notes: *"Remove buffers_backend and buffers_backend_fsync from pg_stat_bgwriter (Bharath Rupireddy). These fields are considered redundant to similar columns in pg_stat_io."* https://www.postgresql.org/docs/release/17.0/

[^pg17-waits]: PostgreSQL 17 release notes: *"Add wait events for checkpoint delays (Thomas Munro)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-numtimed]: PostgreSQL 17 `monitoring-stats.html`, `pg_stat_checkpointer.num_timed`: *"Number of scheduled checkpoints due to timeout. Note that checkpoints may be skipped if the server has been idle since the last one, and this value counts both completed and skipped checkpoints."* https://www.postgresql.org/docs/17/monitoring-stats.html

[^pg17-cp-view]: PostgreSQL 17 `monitoring-stats.html`, `pg_stat_checkpointer` view (full column reference). https://www.postgresql.org/docs/17/monitoring-stats.html

[^pg18-numdone]: PostgreSQL 18 release notes: *"Add column pg_stat_checkpointer.num_done to report the number of completed checkpoints (Anton A. Melnikov). Columns num_timed and num_requested count both completed and skipped checkpoints."* https://www.postgresql.org/docs/release/18.0/

[^pg18-slru]: PostgreSQL 18 release notes: *"Add column pg_stat_checkpointer.slru_written to report SLRU buffers written (Nitin Jadhav). Also, modify the checkpoint server log message to report separate shared buffer and SLRU buffer values."* https://www.postgresql.org/docs/release/18.0/

[^pg18-walbufs]: PostgreSQL 18 release notes: *"Add full WAL buffer count to EXPLAIN (WAL) output (Bertrand Drouvot)."* / *"Add full WAL buffer count to VACUUM/ANALYZE (VERBOSE) and autovacuum log output (Bertrand Drouvot)."* https://www.postgresql.org/docs/release/18.0/

# Performance Diagnostics — pg_stat_* Views and Live Inspection

A field guide to PostgreSQL's cumulative statistics system, the per-view catalog, the wait-event taxonomy, and the runnable recipes that diagnose almost every production incident: long-running queries, blocked sessions, bloat, replication lag, I/O bottlenecks, and stalled maintenance operations.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [The Five-Rule Mental Model](#the-five-rule-mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The view-catalog overview](#the-view-catalog-overview)
    - [pg_stat_activity](#pg_stat_activity)
    - [Wait events](#wait-events)
    - [pg_stat_database](#pg_stat_database)
    - [Table and index statistics](#table-and-index-statistics)
    - [pg_stat_io (PG16+)](#pg_stat_io-pg16)
    - [pg_stat_wal (PG14+)](#pg_stat_wal-pg14)
    - [pg_stat_bgwriter and pg_stat_checkpointer](#pg_stat_bgwriter-and-pg_stat_checkpointer)
    - [pg_stat_replication and replication_slots](#pg_stat_replication-and-replication_slots)
    - [pg_stat_subscription and pg_stat_subscription_stats](#pg_stat_subscription-and-pg_stat_subscription_stats)
    - [pg_stat_progress_* family](#pg_stat_progress_-family)
    - [Snapshot semantics and resetting](#snapshot-semantics-and-resetting)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when an operator needs to look at a running cluster and answer "what is happening right now?" or "what has been happening since the last stats reset?" The pg_stat_* catalog is the canonical live-introspection surface. Every other diagnostic file in this skill — locking ([`43-locking.md`](./43-locking.md)), vacuum ([`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)), buffer manager ([`32-buffer-manager.md`](./32-buffer-manager.md)), WAL ([`33-wal.md`](./33-wal.md)), checkpoints ([`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md)), pg_stat_statements ([`57-pg-stat-statements.md`](./57-pg-stat-statements.md)) — references one or more views described here.

This file is the **picker** for which view answers which question. The per-view deep dives live in the related topic files; this is the cross-cutting routing layer.

## The Five-Rule Mental Model

1. **`pg_stat_activity` is the "what's happening right now?" view.** One row per backend (client connection, autovacuum worker, replication walsender, parallel worker, logical-replication apply worker). Filter by `state`, group by `wait_event_type`/`wait_event`, join to `pg_blocking_pids()` to find blocking chains. Every diagnostic walk starts here.

2. **`wait_event_type` and `wait_event` route every "why is this slow?" investigation.** A backend in `state = 'active'` with `wait_event_type IS NULL` is on CPU. With `wait_event_type = 'Lock'` it is blocked on a heavyweight lock (route to [`43-locking.md`](./43-locking.md)). With `wait_event_type = 'IO'` it is waiting on disk (route to [`32-buffer-manager.md`](./32-buffer-manager.md) and [`33-wal.md`](./33-wal.md)). With `wait_event_type = 'LWLock'` it is waiting on an internal lightweight lock (route to the specific lock name).

3. **Cumulative views accumulate since the last reset, not since cluster start.** `pg_stat_database`, `pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_statio_*`, `pg_stat_bgwriter`, `pg_stat_checkpointer`, `pg_stat_io`, `pg_stat_wal` — all carry `stats_reset` columns or rely on `pg_stat_reset_*()`. A rate calculation requires two snapshots; absolute values without a baseline are nearly useless on a long-running cluster.

4. **`pg_stat_progress_*` views show in-flight maintenance operations.** Six progress views as of PG16: `vacuum`, `analyze`, `create_index`, `basebackup`, `copy`, `cluster`. Each has one row per running operation with `phase` plus operation-specific progress columns. **`pg_stat_progress_vacuum` does NOT show `VACUUM FULL`** — that uses `pg_stat_progress_cluster` (because VACUUM FULL is implemented as a CLUSTER-style table rewrite).

5. **The view-catalog has version-introduced columns and version-renamed columns.** PG14 added `pg_stat_wal` + `pg_stat_replication_slots` + `pg_locks.waitstart` + session columns on `pg_stat_database`. PG15 added `pg_stat_subscription_stats`. PG16 added `pg_stat_io` + `last_seq_scan`/`last_idx_scan` columns + `n_tup_newpage_upd`. PG17 split `pg_stat_checkpointer` out of `pg_stat_bgwriter` (and removed `buffers_backend`/`buffers_backend_fsync`), renamed `pg_stat_progress_vacuum.max_dead_tuples` to `max_dead_tuple_bytes`, and renamed `pg_stat_statements.blk_*_time` to `shared_blk_*_time`. PG18 added bytes columns to `pg_stat_io` (and removed `op_bytes`), added WAL rows to `pg_stat_io`, added `pg_stat_get_backend_io()`, added `parallel_workers_to_launch`/`parallel_workers_launched` to `pg_stat_database`, added `num_done` and `slru_written` to `pg_stat_checkpointer`, and added the `pg_aios` async-I/O view.

> [!WARNING] Monitoring queries written for PG16 break on PG17 and PG18
> The PG17 `pg_stat_checkpointer` split, the PG17 `pg_stat_progress_vacuum` column renames, and the PG18 `pg_stat_io.op_bytes` removal all silently produce zero-row or null-column results when an unmodified PG16-era query runs against the newer cluster. Audit your monitoring after any major-version upgrade. See [Gotcha #6](#gotchas--anti-patterns) and the recipes for side-by-side rewrites.

## Decision Matrix

| You want to find / measure | Use this view | Filter / join | Avoid |
|---|---|---|---|
| Currently-running queries | `pg_stat_activity` | `WHERE state = 'active' AND backend_type = 'client backend' ORDER BY query_start` | filtering on `state_change` (it advances even for idle backends) |
| Blocked sessions and their blockers | `pg_stat_activity` + `pg_blocking_pids()` | `LATERAL unnest(pg_blocking_pids(pid))` | guessing from log messages |
| Long-running transactions | `pg_stat_activity` | `WHERE xact_start IS NOT NULL AND xact_start < now() - interval '5 min'` | filtering on `query_start` (a tx may be idle-in-transaction with no current query) |
| Idle-in-transaction sessions | `pg_stat_activity` | `WHERE state = 'idle in transaction' AND state_change < now() - interval '30s'` | killing without checking `pid` for autovacuum or walsender |
| Cache hit ratio per database | `pg_stat_database` | `blks_hit::float / NULLIF(blks_hit + blks_read, 0)` | reading absolute values without `stats_reset` baseline |
| Tables needing autovacuum attention | `pg_stat_user_tables` | `WHERE n_dead_tup > 10000 ORDER BY n_dead_tup::float / NULLIF(n_live_tup, 0) DESC` | hard cutoffs without considering table size |
| Unused indexes | `pg_stat_user_indexes` | `WHERE idx_scan = 0 AND NOT pg_index.indisunique` | dropping without checking replica index usage |
| Table/index buffer hit rate | `pg_statio_user_tables` / `pg_statio_user_indexes` | `heap_blks_hit::float / NULLIF(heap_blks_hit + heap_blks_read, 0)` | conflating "hit rate" with "performance" |
| Per-relation I/O attribution (PG16+) | `pg_stat_io` | `GROUP BY backend_type, context` | pre-PG16 (use pg_stat_bgwriter + pg_statio_*) |
| WAL volume rate (PG14+) | `pg_stat_wal` | two snapshots over time | reading without time delta |
| Long-running VACUUM | `pg_stat_progress_vacuum` JOIN `pg_stat_activity` | `WHERE wait_event_type IS NOT NULL` flags blocking | confusing with VACUUM FULL (use `pg_stat_progress_cluster`) |
| Long-running CREATE INDEX (CONCURRENTLY) | `pg_stat_progress_create_index` | `WHERE phase = 'waiting for writers before build'` flags long-running-tx blocker | reading without `xact_start` join |
| Replication lag per standby | `pg_stat_replication` on primary | `pg_wal_lsn_diff(sent_lsn, replay_lsn)` and the time-lag columns | reading `replay_lag = NULL` as "no lag" (it's NULL on idle replicas) |
| Slot WAL retention | `pg_replication_slots` | `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)` | ignoring abandoned slots that pin disk |
| Subscriber-side conflicts (PG15+) | `pg_stat_subscription_stats` | `WHERE apply_error_count > 0 OR sync_error_count > 0` | pre-PG15 (no view; read from logs) |

**Smell signals.**

- `pg_stat_activity` showing many rows with `state = 'idle in transaction'` and `state_change` more than 30 seconds in the past → applications leaking transactions; set `idle_in_transaction_session_timeout` (cross-reference [`41-transactions.md`](./41-transactions.md)).
- `pg_stat_database.deadlocks` climbing → applications are not ordering locks consistently; route to [`43-locking.md`](./43-locking.md) Recipe 8.
- `pg_stat_user_tables.n_dead_tup` rising but `last_autovacuum IS NULL` (or very old) for hours → autovacuum is being canceled by lock conflicts, or the xmin horizon is held back by a long transaction; route to [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 2.

## Syntax / Mechanics

### The view-catalog overview

PostgreSQL exposes its statistics through a family of system views. The canonical inventory:[^monitoring-chapter]

| Category | Views (PG16 baseline) |
|---|---|
| Activity | `pg_stat_activity`, `pg_stat_ssl`, `pg_stat_gssapi` |
| Database-level | `pg_stat_database`, `pg_stat_database_conflicts` |
| Per-table | `pg_stat_all_tables`, `pg_stat_user_tables`, `pg_stat_sys_tables`, `pg_stat_xact_*_tables` |
| Per-index | `pg_stat_all_indexes`, `pg_stat_user_indexes`, `pg_stat_sys_indexes` |
| Per-function | `pg_stat_user_functions`, `pg_stat_xact_user_functions` |
| I/O per-relation | `pg_statio_all_tables`, `pg_statio_user_tables`, `pg_statio_sys_tables`, `pg_statio_all_indexes`, `pg_statio_user_indexes`, `pg_statio_sys_indexes`, `pg_statio_all_sequences`, `pg_statio_user_sequences`, `pg_statio_sys_sequences` |
| I/O cluster-wide (PG16+) | `pg_stat_io` |
| Background processes | `pg_stat_bgwriter`, `pg_stat_checkpointer` (PG17+), `pg_stat_archiver`, `pg_stat_wal` (PG14+), `pg_stat_slru` |
| Replication | `pg_stat_replication`, `pg_replication_slots`, `pg_stat_replication_slots` (PG14+), `pg_stat_wal_receiver`, `pg_stat_subscription`, `pg_stat_subscription_stats` (PG15+) |
| Progress | `pg_stat_progress_vacuum`, `pg_stat_progress_analyze`, `pg_stat_progress_create_index`, `pg_stat_progress_basebackup`, `pg_stat_progress_copy` (PG14+), `pg_stat_progress_cluster` |
| Extension-provided | `pg_stat_statements` (cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md)) |
| PG18+ | `pg_aios` (async I/O) |

### `pg_stat_activity`

Verbatim docs definition:[^pg-stat-activity] *"The `pg_stat_activity` view will have one row per server process, showing information related to the current activity of that process."*

Key columns (PG16):

| Column | Type | Meaning |
|---|---|---|
| `datid` / `datname` | oid / name | Database OID and name |
| `pid` | integer | Process ID |
| `leader_pid` | integer | If part of a parallel group, PID of the leader; otherwise NULL |
| `usesysid` / `usename` | oid / name | Connected role OID and name |
| `application_name` | text | Client-set `application_name` GUC |
| `client_addr` / `client_hostname` / `client_port` | inet / text / integer | Network identification of the client |
| `backend_start` | timestamptz | When this backend started |
| `xact_start` | timestamptz | When the current transaction started, or NULL if not in a transaction |
| `query_start` | timestamptz | When the current query started, or for `idle`/`idle in transaction` when the previous query ended |
| `state_change` | timestamptz | When the state last changed |
| `wait_event_type` | text | Type of event the backend is waiting on (NULL = not waiting) |
| `wait_event` | text | Specific event name |
| `state` | text | One of `active`, `idle`, `idle in transaction`, `idle in transaction (aborted)`, `fastpath function call`, `disabled` |
| `backend_xid` | xid | Top-level transaction ID, or NULL if no XID assigned yet |
| `backend_xmin` | xid | Backend's `xmin` horizon (cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md)) |
| `query_id` | bigint | Query identifier (PG14+, if `compute_query_id = on` or `auto`) |
| `query` | text | Current query text (or last query if idle) — truncated at `track_activity_query_size` |
| `backend_type` | text | One of `autovacuum launcher`, `autovacuum worker`, `logical replication launcher`, `logical replication worker`, `parallel worker`, `background writer`, `client backend`, `checkpointer`, `archiver`, `startup`, `walreceiver`, `walsender`, `walwriter`, plus extension-defined types |

The verbatim wait-event-vs-state independence rule:[^monitoring-chapter] *"The `wait_event` and `state` columns are independent. If a backend is in the `active` state, it may or may not be `waiting` on some event. If the state is `active` and `wait_event` is non-null, it means that a query is being executed, but is being blocked somewhere in the system."*

### Wait events

Wait events are categorized by `wait_event_type` into nine top-level classes:[^monitoring-chapter]

| Type | What it indicates |
|---|---|
| `Activity` | Server process is idle. This is the wait-event type used by background processes (e.g., the WAL writer, the checkpointer) waiting for activity in their main processing loop. Generally a *good* state — these are not blocking anything. |
| `BufferPin` | Waiting to acquire an exclusive pin on a buffer. Buffer-pin waits can occur if another process is reading data into the buffer or if VACUUM is waiting to clean a buffer. |
| `Client` | Waiting for activity from a client process (e.g., reading from or writing to a socket). |
| `Extension` | Waiting in an extension. Use the specific `wait_event` to disambiguate. |
| `IO` | Waiting for an I/O operation. Common `wait_event` values: `DataFileRead`, `DataFileWrite`, `DataFileFlush`, `WALRead`, `WALWrite`, `WALSync`, `BufFileRead`, `BufFileWrite`, `RelationMapRead`. |
| `IPC` | Waiting for inter-process communication (parallel-query messaging, replication, sinval). |
| `Lock` | Verbatim: *"The server process is waiting for a heavyweight lock. Heavyweight locks, also known as lock manager locks or simply locks, primarily protect SQL-visible objects such as tables."* The specific `wait_event` names the lock type (`relation`, `tuple`, `transactionid`, `virtualxid`, `extend`, `page`, `frozenid`, `object`, `userlock`, `advisory`, `applytransaction` PG16+). Cross-reference [`43-locking.md`](./43-locking.md). |
| `LWLock` | Verbatim: *"The server process is waiting for a lightweight lock. Most such locks protect a particular data structure in shared memory."* The specific `wait_event` names the LWLock (`WALWrite`, `LockManager`, `BufferContent`, `XidGen`, `ProcArray`, etc.). |
| `Timeout` | Waiting for a timeout to expire (statement_timeout, lock_timeout, idle_in_transaction_session_timeout, recovery_apply_delay). |

> [!NOTE] PostgreSQL 17
> *"Add system view `pg_wait_events` that reports wait event types (Bertrand Drouvot). This is useful for adding descriptions to wait events reported in `pg_stat_activity`."*[^pg17-wait-events] Join to it for human-readable descriptions of the cryptic `wait_event` names.

### `pg_stat_database`

One row per database in the cluster. Key columns:[^monitoring-chapter]

| Column | Type | Meaning |
|---|---|---|
| `datid` / `datname` | oid / name | Database identification |
| `numbackends` | integer | Current backend count |
| `xact_commit` / `xact_rollback` | bigint | Lifetime transaction counts |
| `blks_read` / `blks_hit` | bigint | Block reads (from disk or OS cache) and hits (in shared_buffers) |
| `tup_returned` / `tup_fetched` | bigint | Tuples returned by queries / actually fetched (returned > fetched on aggregate-heavy workloads) |
| `tup_inserted` / `tup_updated` / `tup_deleted` | bigint | DML row counts |
| `conflicts` | bigint | Recovery conflicts canceling queries on standbys |
| `temp_files` / `temp_bytes` | bigint | Temp files created (sorts/hashes spilling to disk) |
| `deadlocks` | bigint | Detected deadlocks |
| `checksum_failures` | bigint | Data-page checksum failures (cross-reference [`88-corruption-recovery.md`](./88-corruption-recovery.md)) |
| `blk_read_time` / `blk_write_time` | double precision | I/O time, requires `track_io_timing = on` |
| `session_time` | double precision | Total session wall time (PG14+) |
| `active_time` / `idle_in_transaction_time` | double precision | Time spent in active vs idle-in-tx states (PG14+) |
| `sessions` | bigint | Total established sessions (PG14+) |
| `sessions_abandoned` / `sessions_fatal` / `sessions_killed` | bigint | Session termination causes (PG14+) |
| `parallel_workers_to_launch` / `parallel_workers_launched` | bigint | PG18+: planned vs actually-launched parallel workers (delta = pool saturation) |
| `stats_reset` | timestamptz | When stats were last reset |

> [!NOTE] PostgreSQL 14
> *"Add session statistics to the `pg_stat_database` system view (Laurenz Albe)."*[^pg14-session-stats] The `session_time`, `active_time`, `idle_in_transaction_time`, `sessions`, `sessions_abandoned`, `sessions_fatal`, `sessions_killed` columns were added in PG14.

### Table and index statistics

**Per-table:** `pg_stat_all_tables` (and the `_user_tables` / `_sys_tables` filtered variants). One row per table.

Key columns:

| Column | Type | Meaning |
|---|---|---|
| `relid` / `schemaname` / `relname` | oid / name / name | Identification |
| `seq_scan` / `seq_tup_read` | bigint | Sequential scans and rows returned |
| `idx_scan` / `idx_tup_fetch` | bigint | Index scans and rows fetched via index |
| `n_tup_ins` / `n_tup_upd` / `n_tup_del` | bigint | Row insertion/update/deletion counts |
| `n_tup_hot_upd` | bigint | HOT updates (cross-reference [`30-hot-updates.md`](./30-hot-updates.md)) |
| `n_tup_newpage_upd` | bigint | PG16+: updates that moved the row to a new page |
| `n_live_tup` / `n_dead_tup` | bigint | Approximate live/dead tuple count |
| `n_mod_since_analyze` / `n_ins_since_vacuum` | bigint | Mod/insert counts since last analyze/vacuum (drive autovacuum trigger) |
| `last_vacuum` / `last_autovacuum` / `last_analyze` / `last_autoanalyze` | timestamptz | Last operation timestamps (manual vs autovacuum-initiated) |
| `vacuum_count` / `autovacuum_count` / `analyze_count` / `autoanalyze_count` | bigint | Lifetime counts |
| `last_seq_scan` / `last_idx_scan` | timestamptz | PG16+: most recent scan timestamps (use to find truly-unused indexes vs not-recently-scanned) |

**Per-index:** `pg_stat_all_indexes`. One row per index.

| Column | Meaning |
|---|---|
| `idx_scan` | Number of index scans initiated. **Zero across a representative time window is the canonical "unused index" signal.** |
| `idx_tup_read` | Index entries returned by scans |
| `idx_tup_fetch` | Heap rows fetched by simple index scans (zero for index-only scans without heap fetches) |
| `last_idx_scan` | PG16+: timestamp of most recent scan |

**Per-relation I/O:** `pg_statio_user_tables` / `pg_statio_user_indexes`. Block-level hit/read counters.

| Column | Meaning |
|---|---|
| `heap_blks_read` / `heap_blks_hit` | Heap block reads / hits |
| `idx_blks_read` / `idx_blks_hit` | Index block reads / hits (per-table aggregate) |
| `toast_blks_read` / `toast_blks_hit` | TOAST table block reads / hits (cross-reference [`31-toast.md`](./31-toast.md)) |
| `tidx_blks_read` / `tidx_blks_hit` | TOAST index block reads / hits |

### `pg_stat_io` (PG16+)

> [!NOTE] PostgreSQL 16
> *"Add system view `pg_stat_io` view to track I/O statistics (Melanie Plageman)."*[^pg16-io] This is the modern replacement for `pg_stat_bgwriter.buffers_backend` (which was removed in PG17 per the cross-reference below) and the right place to attribute I/O to backend types and contexts.

`pg_stat_io` decomposes I/O by `(backend_type, context, object)`:

| Column (PG16) | Meaning |
|---|---|
| `backend_type` | `client backend`, `autovacuum worker`, `background writer`, `checkpointer`, `standalone backend`, `startup`, `walsender`, `bgworker`, `wal writer` |
| `context` | `normal`, `vacuum`, `bulkread`, `bulkwrite` (ring-buffer contexts; cross-reference [`32-buffer-manager.md`](./32-buffer-manager.md)) |
| `object` | `relation` or `temp relation` |
| `reads` / `writes` / `writebacks` / `extends` / `hits` / `evictions` / `reuses` / `fsyncs` | Counters per I/O operation |
| `read_time` / `write_time` / `writeback_time` / `extend_time` / `fsync_time` | Aggregate time (requires `track_io_timing = on`) |
| `op_bytes` | PG16-17 only: bytes per I/O operation (always `BLCKSZ` = 8192). **Removed in PG18.** |
| `read_bytes` / `write_bytes` / `extend_bytes` | PG18+ replacement for `op_bytes`-derived volume computations |

> [!NOTE] PostgreSQL 18
> *"Add `pg_stat_io` columns to report I/O activity in bytes (Nazir Bilal Yavuz). The new columns are `read_bytes`, `write_bytes`, and `extend_bytes`. The `op_bytes` column, which always equalled `BLCKSZ`, has been removed."*[^pg18-io-bytes] Also: *"Add WAL I/O activity rows to `pg_stat_io`."*[^pg18-io-wal] And per-backend variant via `pg_stat_get_backend_io()`:[^pg18-backend-io] *"Add per-backend I/O statistics reporting (Bertrand Drouvot). The statistics are accessed via `pg_stat_get_backend_io()`. Per-backend I/O statistics can be cleared via `pg_stat_reset_backend_stats()`."*

### `pg_stat_wal` (PG14+)

> [!NOTE] PostgreSQL 14
> *"Add system view `pg_stat_wal` to report WAL activity (Masahiro Ikeda)."*[^pg14-wal] Pre-PG14 deployments must aggregate `pg_stat_statements.wal_records`/`wal_fpi`/`wal_bytes` or read `pg_current_wal_lsn()` deltas manually.

Columns (PG14-18):

| Column | Meaning |
|---|---|
| `wal_records` | Total WAL records generated |
| `wal_fpi` | Full-page images (one per page-modified-after-checkpoint) |
| `wal_bytes` | Cumulative WAL bytes |
| `wal_buffers_full` | Times WAL buffers were full and a backend had to write WAL synchronously |
| `wal_write` | WAL writes from buffers (pre-PG18; in PG18+ this moved to `pg_stat_io` WAL rows) |
| `wal_sync` | WAL fsyncs (pre-PG18) |
| `wal_write_time` / `wal_sync_time` | Aggregate write/sync time, requires `track_wal_io_timing = on` (pre-PG18) |
| `stats_reset` | Reset timestamp |

> [!WARNING] PG18 removed `wal_write` / `wal_sync` / `wal_write_time` / `wal_sync_time` from `pg_stat_wal`
> These were relocated into `pg_stat_io`'s new WAL rows. Monitoring queries that read these columns directly return NULL on PG18; rewrite to use `pg_stat_io WHERE object IN ('wal') OR backend_type IN ('walwriter','walsender')`. Cross-reference [`33-wal.md`](./33-wal.md).

### `pg_stat_bgwriter` and `pg_stat_checkpointer`

Pre-PG17: a single `pg_stat_bgwriter` view held both the background-writer and checkpointer columns.

> [!WARNING] PG17 split `pg_stat_bgwriter` into two views
> *"Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."*[^pg17-checkpointer] Also: *"Remove `buffers_backend` and `buffers_backend_fsync` from `pg_stat_bgwriter` ... These fields are considered redundant to similar columns in `pg_stat_io`."*[^pg17-bgwriter-removal] Monitoring queries written for PG16 silently return wrong values on PG17+. See [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) for the full column-migration table.

PG17+ `pg_stat_checkpointer` columns: `num_timed`, `num_requested`, `restartpoints_timed`, `restartpoints_req`, `restartpoints_done`, `write_time`, `sync_time`, `buffers_written`, `stats_reset`.

> [!NOTE] PostgreSQL 18
> *"Add column `pg_stat_checkpointer.num_done` to report the number of completed checkpoints."*[^pg18-num-done] Note: `num_timed` and `num_requested` count both completed AND skipped checkpoints; `num_done` counts only completed. The difference (`num_timed - num_done`) is the skipped count. Also: *"Add column `pg_stat_checkpointer.slru_written` to report SLRU buffers written."*[^pg18-slru-written]

### `pg_stat_replication` and `pg_replication_slots`

`pg_stat_replication`: one row per walsender on the primary. Key columns:

| Column | Meaning |
|---|---|
| `pid` | Walsender PID |
| `usename` / `application_name` / `client_addr` | Client identification |
| `state` | `streaming`, `catchup`, `startup`, `backup`, `stopping` |
| `sent_lsn` | LSN of the last WAL byte sent over the wire |
| `write_lsn` | LSN written to the standby's WAL files |
| `flush_lsn` | LSN fsync'd on the standby |
| `replay_lsn` | LSN replayed on the standby |
| `write_lag` / `flush_lag` / `replay_lag` | Time lags as `interval` |
| `sync_state` | `async`, `potential`, `sync`, `quorum` |
| `sync_priority` | Priority for sync replication |
| `reply_time` | Time of last reply from standby |

`pg_replication_slots` (slot-side view): one row per replication slot.

| Column | Meaning |
|---|---|
| `slot_name` / `plugin` / `slot_type` | Identification; `slot_type` is `physical` or `logical` |
| `database` | Database for logical slots; NULL for physical |
| `active` / `active_pid` | Whether currently being read |
| `xmin` / `catalog_xmin` | Oldest XID this slot needs (drives autovacuum xmin horizon — cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md)) |
| `restart_lsn` | Oldest WAL location required |
| `confirmed_flush_lsn` | For logical slots: oldest confirmed-flushed location |
| `wal_status` | PG13+: `reserved`, `extended`, `unreserved`, `lost` |
| `safe_wal_size` | PG13+: WAL bytes before `max_slot_wal_keep_size` causes invalidation |

`pg_stat_replication_slots` (PG14+): per-slot logical-decoding statistics.

> [!NOTE] PostgreSQL 14
> *"Add system view `pg_stat_replication_slots` to report replication slot activity."*[^pg14-replslot-stats] Tracks `spill_txns`, `spill_count`, `spill_bytes`, `stream_txns`, `stream_count`, `stream_bytes`, `total_txns`, `total_bytes`, `stats_reset`.

### `pg_stat_subscription` and `pg_stat_subscription_stats`

`pg_stat_subscription`: one row per logical-replication subscription (and per parallel apply worker on PG16+ where `leader_pid` is non-NULL).

`pg_stat_subscription_stats` (PG15+): error counts per subscription. Columns: `subid`, `subname`, `apply_error_count`, `sync_error_count`, `stats_reset`. PG18 added `confl_*` columns for conflict tracking.

### `pg_stat_progress_*` family

Verbatim docs note:[^progress-reporting] *"Whenever `VACUUM` is running, the `pg_stat_progress_vacuum` view will contain one row for each backend (including autovacuum worker processes) that is currently vacuuming."* The same shape applies to all six progress views.

| View | Triggered by | Key columns |
|---|---|---|
| `pg_stat_progress_vacuum` | `VACUUM` (LAZY only, not FULL) | `pid`, `datid`, `relid`, `phase`, `heap_blks_total`, `heap_blks_scanned`, `heap_blks_vacuumed`, `index_vacuum_count`, `max_dead_tuple_bytes` (PG17+; was `max_dead_tuples`), `dead_tuple_bytes` (PG17+), `num_dead_item_ids` (PG17+; was `num_dead_tuples`), `indexes_total`, `indexes_processed` (PG17+) |
| `pg_stat_progress_analyze` | `ANALYZE` | `pid`, `datid`, `relid`, `phase`, `sample_blks_total`, `sample_blks_scanned`, `ext_stats_total`, `ext_stats_computed`, `child_tables_total`, `child_tables_done`, `current_child_table_relid` |
| `pg_stat_progress_create_index` | `CREATE INDEX [CONCURRENTLY]`, `REINDEX [CONCURRENTLY]` | `pid`, `datid`, `relid`, `index_relid`, `command`, `phase`, `lockers_total`, `lockers_done`, `current_locker_pid`, `blocks_total`, `blocks_done`, `tuples_total`, `tuples_done`, `partitions_total`, `partitions_done` |
| `pg_stat_progress_basebackup` | `pg_basebackup` (active server-side) | `pid`, `phase`, `backup_total`, `backup_streamed`, `tablespaces_total`, `tablespaces_streamed` |
| `pg_stat_progress_copy` | `COPY` (PG14+) | `pid`, `datid`, `relid`, `command`, `type`, `bytes_processed`, `bytes_total`, `tuples_processed`, `tuples_excluded`, `tuples_skipped` (PG17+) |
| `pg_stat_progress_cluster` | `CLUSTER`, `VACUUM FULL` | `pid`, `datid`, `relid`, `command`, `phase`, `cluster_index_relid`, `heap_tuples_scanned`, `heap_tuples_written`, `heap_blks_total`, `heap_blks_scanned`, `index_rebuild_count` |

> [!WARNING] `pg_stat_progress_vacuum` shows only LAZY VACUUM
> VACUUM FULL is implemented as a CLUSTER-style table rewrite, so it appears in `pg_stat_progress_cluster` with `command = 'VACUUM FULL'`, not in `pg_stat_progress_vacuum`. Monitoring queries that join `pg_stat_progress_vacuum` to find "any vacuum" miss FULL operations.

### Snapshot semantics and resetting

Verbatim docs rule:[^monitoring-chapter] *"When a server process is asked to display any of the accumulated statistics, accessed values are cached until the end of its current transaction in the default configuration ... You can invoke `pg_stat_clear_snapshot()` to discard the current transaction's statistics snapshot or cached values."*

In practice:

- **Within a transaction**, every `pg_stat_*` view returns the values from the first read in the transaction. To get fresh data without committing, call `SELECT pg_stat_clear_snapshot();` first.
- **`pg_stat_reset()`** resets all per-database stats (table, index, function counters in the current database). Per-cluster views (`pg_stat_bgwriter`, `pg_stat_checkpointer`, `pg_stat_wal`, `pg_stat_io`, `pg_stat_archiver`) reset independently with `pg_stat_reset_shared(target text)` where `target` is one of `bgwriter`, `checkpointer`, `archiver`, `wal`, `io`.
- **`pg_stat_reset_single_table_counters(relid oid)`** resets one table.
- **`pg_stat_reset_replication_slot(slot_name text)`** resets one logical-decoding slot's `pg_stat_replication_slots` row (PG14+).
- **`pg_stat_reset_subscription_stats(subid oid)`** resets one subscription's error counts (PG15+).
- **`pg_stat_reset_backend_stats(pid integer)`** resets per-backend I/O (PG18+).

Stats persist across clean restart (written to `pg_stat/` directory at shutdown). A crash loses statistics for the current statistics-collector reporting interval — at most a few seconds.

### Per-version timeline

| Version | Changes |
|---|---|
| **PG14** | `pg_stat_wal` view added; `pg_stat_replication_slots` view added; `pg_stat_progress_copy` view added; `pg_locks.waitstart` column added (per row showing when a wait began);[^pg14-waitstart] session-statistics columns added to `pg_stat_database` (`session_time`, `active_time`, `idle_in_transaction_time`, `sessions`, `sessions_abandoned`, `sessions_fatal`, `sessions_killed`); `query_id` column added to `pg_stat_activity` (requires `compute_query_id = on` or `auto`); `idle_session_timeout` GUC added.[^pg14-idle-session] |
| **PG15** | `pg_stat_subscription_stats` view added;[^pg15-subscription-stats] `log_checkpoints` default changed to `on`;[^pg15-log-checkpoints-default] wait events for archive/restore commands added;[^pg15-archive-wait] `jsonlog` format added. |
| **PG16** | `pg_stat_io` view added;[^pg16-io] `last_seq_scan` / `last_idx_scan` columns added to per-table/per-index stats;[^pg16-last-scan] `n_tup_newpage_upd` column added to `pg_stat_*_tables`;[^pg16-newpage] `leader_pid` added to `pg_stat_subscription`;[^pg16-leader-pid] `SpinDelay` wait event added;[^pg16-spindelay] `pg_stat_io` is the recommended replacement for `pg_stat_bgwriter.buffers_backend`. |
| **PG17** | `pg_stat_checkpointer` view created (split from `pg_stat_bgwriter`); `buffers_backend` and `buffers_backend_fsync` removed from `pg_stat_bgwriter`; `pg_stat_progress_vacuum` columns renamed (`max_dead_tuples` → `max_dead_tuple_bytes`, `num_dead_tuples` → `num_dead_item_ids`, new `dead_tuple_bytes`); `indexes_total` and `indexes_processed` columns added to `pg_stat_progress_vacuum`; `pg_stat_statements` column renames (`blk_read_time` → `shared_blk_read_time`); savepoint names replaced with placeholders in `pg_stat_statements`; `pg_wait_events` system view added; `pg_stat_progress_copy.tuples_skipped` column added. |
| **PG18** | `pg_stat_io` adds bytes columns (`read_bytes`, `write_bytes`, `extend_bytes`), removes `op_bytes`; `pg_stat_io` adds WAL rows; `pg_stat_get_backend_io()` added; `pg_stat_reset_backend_stats(pid)` added; `pg_stat_checkpointer.num_done` and `.slru_written` columns added; `pg_stat_database.parallel_workers_to_launch` / `parallel_workers_launched` columns added;[^pg18-parallel] `pg_stat_wal` loses `wal_write`/`wal_sync`/`wal_write_time`/`wal_sync_time` (relocated to `pg_stat_io`); `pg_aios` view added (async I/O subsystem); VACUUM and ANALYZE delay tracking with `track_cost_delay_timing`;[^pg18-cost-delay] `pg_stat_subscription_stats` gains conflict-tracking `confl_*` columns. |

## Examples / Recipes

### Recipe 1: Currently-active queries with wait info

The single most-used diagnostic query. Run it whenever you need to answer "what is the cluster doing right now?"

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    wait_event_type,
    wait_event,
    now() - query_start         AS runtime,
    now() - xact_start          AS xact_age,
    LEFT(query, 80)             AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND state != 'idle'
ORDER BY query_start;
```

Reading the output:

- `state = 'active'` AND `wait_event_type IS NULL` → backend is on CPU.
- `state = 'active'` AND `wait_event_type = 'IO'` → waiting on disk (route to [`32-buffer-manager.md`](./32-buffer-manager.md)).
- `state = 'active'` AND `wait_event_type = 'Lock'` → blocked on a heavyweight lock (route to Recipe 2).
- `state = 'idle in transaction'` → application started a transaction and is sitting on it (cross-reference [`41-transactions.md`](./41-transactions.md) for `idle_in_transaction_session_timeout`).

### Recipe 2: Blocking chain — who is blocking whom?

```sql
SELECT
    blocked.pid                         AS blocked_pid,
    blocked.usename                     AS blocked_user,
    LEFT(blocked.query, 60)             AS blocked_query,
    blocking.pid                        AS blocking_pid,
    blocking.usename                    AS blocking_user,
    blocking.state                      AS blocking_state,
    LEFT(blocking.query, 60)            AS blocking_query,
    now() - blocked.xact_start          AS blocked_xact_age
FROM pg_stat_activity blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocking_pid
JOIN pg_stat_activity blocking ON blocking.pid = blocking_pid
WHERE pg_blocking_pids(blocked.pid) != '{}'
ORDER BY blocked.xact_start;
```

The verbatim docs rule on `pg_blocking_pids`:[^pg-blocking-pids] *"One server process blocks another if it either holds a lock that conflicts with the blocked process's lock request (hard block), or is waiting for a lock that would conflict with the blocked process's lock request and is ahead of it in the wait queue (soft block)."* Both forms appear in the LATERAL output.

Special case from the same docs paragraph: *"when a prepared transaction holds a conflicting lock, it will be represented by a zero process ID."* If the `blocking_pid` is `0`, the blocker is a prepared transaction with no live session — find it via `SELECT * FROM pg_prepared_xacts;`. Cross-reference [`43-locking.md`](./43-locking.md) gotcha #8.

### Recipe 3: Long-running transactions holding xmin back

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    backend_xid,
    backend_xmin,
    age(backend_xmin)         AS xmin_age,
    now() - xact_start        AS xact_age,
    wait_event_type,
    wait_event,
    LEFT(query, 80)           AS query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 20;
```

`age(backend_xmin)` measures how many XIDs have passed since this backend's snapshot was taken. A backend with a very large `xmin_age` is preventing VACUUM from cleaning dead tuples (cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) Rule 5 and [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) gotcha #11). Pair this with parallel checks on `pg_replication_slots` and `pg_prepared_xacts` since those also pin xmin horizon.

### Recipe 4: Cache hit rate per database

```sql
SELECT
    datname,
    blks_hit + blks_read              AS total_block_accesses,
    round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS hit_pct,
    blk_read_time + blk_write_time    AS io_time_ms,
    stats_reset
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY total_block_accesses DESC;
```

Cache hit rates below ~95% on an OLTP workload usually mean shared_buffers is undersized relative to the working set (cross-reference [`32-buffer-manager.md`](./32-buffer-manager.md) and [`54-memory-tuning.md`](./54-memory-tuning.md)). The `blk_read_time` and `blk_write_time` columns require `track_io_timing = on` and are essential for distinguishing "I have a lot of disk reads that are fast" from "I have disk reads that are slow."

### Recipe 5: Find unused indexes (with caveats)

```sql
SELECT
    schemaname || '.' || relname  AS table,
    indexrelname                   AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    last_idx_scan,
    CASE WHEN idx_scan = 0 THEN 'NEVER SCANNED'
         ELSE 'used'
    END AS status
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
WHERE NOT indisunique
  AND NOT indisprimary
  AND pg_relation_size(indexrelid) > 1024 * 1024  -- > 1 MB
ORDER BY idx_scan, pg_relation_size(indexrelid) DESC;
```

> [!WARNING] Three caveats before dropping any index
> 1. **Replicas accumulate independent index-scan counters.** A query on a read replica increments `idx_scan` on the replica, not on the primary. If you only check the primary, you may drop an index a reporting replica relies on. Run this query on every replica before dropping.
> 2. **Unique and PK-backing indexes show `idx_scan = 0`** for tables where lookups go through other paths. The `NOT indisunique AND NOT indisprimary` filter excludes them, but exclusion-constraint-backing indexes and FK-target indexes still need verification.
> 3. **`last_idx_scan` is PG16+ only.** Pre-PG16 you cannot distinguish "never used" from "used last year, hasn't been scanned this week." Reset stats and observe a representative time window.

### Recipe 6: Tables overdue for autovacuum

```sql
SELECT
    schemaname || '.' || relname              AS table,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    n_live_tup,
    n_dead_tup,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 1) AS dead_pct,
    n_mod_since_analyze,
    last_autovacuum,
    last_autoanalyze,
    CASE
        WHEN last_autovacuum IS NULL THEN 'never autovacuumed'
        WHEN last_autovacuum < now() - interval '1 day' THEN 'overdue'
        ELSE 'recent'
    END AS state
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY dead_pct DESC NULLS LAST, n_dead_tup DESC
LIMIT 20;
```

Use this to find the actual victims of broken autovacuum. The decision tree:

- High `dead_pct` AND `last_autovacuum` recent → autovacuum is running but not keeping up; raise per-table `autovacuum_vacuum_scale_factor` aggressiveness or `autovacuum_vacuum_cost_limit` (cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) Recipe 1).
- High `dead_pct` AND `last_autovacuum IS NULL` for hours → autovacuum is being canceled by lock conflicts OR the xmin horizon is pinned (run Recipe 3).
- High `n_dead_tup` AND low `n_live_tup` → likely a recently-truncated or recently-deleted table; not necessarily a problem.

### Recipe 7: Watch a running VACUUM in real time

```sql
SELECT
    p.pid,
    p.datname,
    p.relid::regclass             AS table,
    p.phase,
    pg_size_pretty(p.heap_blks_total::bigint * 8192)   AS heap_total,
    pg_size_pretty(p.heap_blks_scanned::bigint * 8192) AS heap_scanned,
    round(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 1) AS heap_pct,
    p.index_vacuum_count,
    p.indexes_total,                  -- PG17+
    p.indexes_processed,              -- PG17+
    p.dead_tuple_bytes,               -- PG17+
    p.max_dead_tuple_bytes,           -- PG17+ (was max_dead_tuples)
    a.wait_event_type,
    a.wait_event,
    now() - a.query_start             AS runtime
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a ON a.pid = p.pid
ORDER BY a.query_start;
```

Phase interpretation:

- `initializing` — Almost always brief.
- `scanning heap` — The main pass.
- `vacuuming indexes` — Per-index cleanup. If `index_vacuum_count > 1` for one VACUUM run, `maintenance_work_mem` is too small and VACUUM has to scan indexes multiple times to clean accumulated dead tuples.
- `vacuuming heap` / `cleaning up indexes` / `truncating heap` / `performing final cleanup` — Wrap-up phases.

If `wait_event_type = 'Lock'` or `wait_event_type = 'BufferPin'` for a long-running anti-wraparound VACUUM, something is blocking it. Anti-wraparound VACUUM cannot be canceled by `lock_timeout` (cross-reference [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) gotcha #4).

### Recipe 8: Streaming replication lag per standby

```sql
SELECT
    application_name,
    client_addr,
    state,
    sync_state,
    pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) AS lag_bytes,
    write_lag,
    flush_lag,
    replay_lag,
    reply_time,
    now() - reply_time AS time_since_reply
FROM pg_stat_replication
ORDER BY pg_wal_lsn_diff(sent_lsn, replay_lsn) DESC;
```

The verbatim docs note (paraphrased from `pg_stat_replication`): the `*_lag` time columns are NULL when the standby has nothing pending. Reading `replay_lag IS NULL` as "no lag" is correct; reading `replay_lag IS NULL` while `pg_wal_lsn_diff(sent_lsn, replay_lsn) > 0` means the lag exists in bytes but the time has not yet been computed because the standby has not yet ACKed. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md).

### Recipe 9: Slot WAL retention — abandoned slots burning disk

```sql
SELECT
    slot_name,
    slot_type,
    database,
    active,
    active_pid,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retention_bytes,
    wal_status,
    pg_size_pretty(safe_wal_size) AS safe_wal_size,
    age(xmin)         AS xmin_age,
    age(catalog_xmin) AS catalog_xmin_age
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

A slot with `active = false` and a large `retention_bytes` is the canonical "disk filling up" emergency. Drop it with `pg_drop_replication_slot('slot_name')` after confirming the slot is genuinely abandoned (the standby or subscriber it pointed at is gone or will not be returning). The `wal_status` column (PG13+) shows `reserved` (within `wal_keep_size`), `extended` (using slot retention), `unreserved` (close to `max_slot_wal_keep_size`), or `lost` (slot will be invalidated). Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).

### Recipe 10: Sessions waiting on the same lock — identify the head

```sql
SELECT
    a.pid,
    a.usename,
    a.state,
    a.wait_event_type,
    a.wait_event,
    l.locktype,
    l.relation::regclass        AS relation,
    l.mode                      AS lock_mode,
    l.granted,
    now() - a.xact_start        AS xact_age,
    LEFT(a.query, 60)           AS query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype IN ('relation', 'tuple', 'transactionid')
ORDER BY l.relation, l.granted DESC, a.xact_start;
```

This combines lock-level visibility with session-level activity. The first row (`granted = true`) for each `relation` is the holder; subsequent rows (`granted = false`) are the queue. Cross-reference [`43-locking.md`](./43-locking.md) Recipe 1.

### Recipe 11: PG16+ per-relation I/O attribution via pg_stat_io

```sql
-- PG16-17 (op_bytes column exists):
SELECT
    backend_type,
    object,
    context,
    reads, writes, extends, hits,
    pg_size_pretty(reads::bigint * op_bytes)  AS read_volume,
    pg_size_pretty(writes::bigint * op_bytes) AS write_volume,
    evictions, reuses, fsyncs,
    round(read_time::numeric, 1)  AS read_time_ms,
    round(write_time::numeric, 1) AS write_time_ms
FROM pg_stat_io
WHERE reads > 0 OR writes > 0
ORDER BY reads + writes DESC;

-- PG18+ (use new bytes columns):
SELECT
    backend_type,
    object,
    context,
    reads, writes, extends, hits,
    pg_size_pretty(read_bytes)   AS read_volume,
    pg_size_pretty(write_bytes)  AS write_volume,
    pg_size_pretty(extend_bytes) AS extend_volume,
    evictions, reuses, fsyncs
FROM pg_stat_io
WHERE reads > 0 OR writes > 0
ORDER BY read_bytes + write_bytes DESC;
```

Reading the matrix: high `(backend_type = 'client backend', context = 'normal', writes > 0)` means application backends are doing their own dirty-buffer writeback (checkpointer/bgwriter cannot keep up — cross-reference [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md)). High `(backend_type = 'autovacuum worker', context = 'vacuum')` is normal during autovacuum runs. High `(context = 'bulkread')` matches `SELECT *` of large tables and uses the ring buffer.

### Recipe 12: Diagnose temp-file spillage

```sql
SELECT
    datname,
    temp_files,
    pg_size_pretty(temp_bytes)            AS temp_bytes,
    round(temp_bytes::numeric / NULLIF(temp_files, 0)) AS avg_temp_file_bytes,
    stats_reset,
    now() - stats_reset                    AS measurement_period
FROM pg_stat_database
WHERE temp_files > 0
ORDER BY temp_bytes DESC;
```

Non-zero `temp_files` means sorts, hashes, or materialized intermediate results spilled to disk. Route to [`54-memory-tuning.md`](./54-memory-tuning.md) Recipe 5 (work_mem tuning) and [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) Recipe 4 (find which queries are spilling).

### Recipe 13: Killing a backend safely

```sql
-- Soft cancel: ask the backend to abort its current query
SELECT pg_cancel_backend(<pid>);

-- Hard terminate: kill the backend connection (use sparingly)
SELECT pg_terminate_backend(<pid>);
```

> [!WARNING] Special backend types
> Do not `pg_terminate_backend` walsenders or logical-replication apply workers without understanding replication implications — termination drops the connection and may cause the standby/subscriber to re-stream from `restart_lsn`. Identify these by `backend_type` in `pg_stat_activity`. Autovacuum workers can be safely canceled but will be re-scheduled. Cross-reference [`43-locking.md`](./43-locking.md) gotcha #20.

## Gotchas / Anti-patterns

1. **`pg_stat_activity` snapshots are transaction-cached.** Reading the view twice in the same transaction returns identical results. Use `SELECT pg_stat_clear_snapshot();` to discard the snapshot or run each query in autocommit mode (the default in psql).

2. **`state = 'active'` does NOT mean "on CPU."** Active backends can be waiting on `Lock`, `IO`, `LWLock`, `IPC`, etc. Always check `wait_event_type` alongside state.

3. **`query` is truncated.** The default `track_activity_query_size = 1024` bytes. Long queries are clipped silently. Raise the GUC if you regularly diagnose multi-KB queries.

4. **`backend_xid` is NULL for read-only transactions.** A backend that has only executed SELECTs has not acquired a top-level XID. `backend_xmin` may still be non-NULL (it's the snapshot horizon). Use `backend_xmin` for xmin-horizon analysis, not `backend_xid`.

5. **`idx_scan = 0` is NOT proof the index is unused.** It is proof the index has not been scanned since the last `pg_stat_reset()` ON THIS NODE. Replicas track independently. Stats reset on `pg_upgrade`. The `last_idx_scan` column (PG16+) gives a more honest "never used since this column was introduced" signal.

6. **Monitoring queries written for PG≤16 break on PG17+ in three ways:** (a) `pg_stat_bgwriter.buffers_backend` / `buffers_backend_fsync` removed — read `pg_stat_io` instead; (b) `pg_stat_bgwriter.checkpoints_*` columns moved to `pg_stat_checkpointer`; (c) `pg_stat_progress_vacuum.max_dead_tuples` / `num_dead_tuples` renamed to `max_dead_tuple_bytes` / `num_dead_item_ids`. The PG16-era query silently returns NULL or zero from these columns instead of erroring.

7. **`pg_stat_io.op_bytes` was removed in PG18.** Computing volume as `reads * op_bytes` returns NULL on PG18. Use `read_bytes` / `write_bytes` / `extend_bytes` directly.

8. **`pg_stat_progress_vacuum` does NOT show `VACUUM FULL`.** VACUUM FULL is implemented as a CLUSTER and reports through `pg_stat_progress_cluster` with `command = 'VACUUM FULL'`.

9. **`pg_stat_activity` shows logical-replication apply workers as `backend_type = 'logical replication worker'`** but the `query` column may be empty or hold the most recent applied statement. Replication apply progress lives in `pg_stat_subscription`, not in `pg_stat_activity.query`.

10. **`pg_blocking_pids` returns duplicate PIDs for parallel queries.** A single parallel-query leader's blocking set may list the same blocker multiple times (once per parallel worker the leader spawned). The docs verbatim:[^pg-blocking-pids] *"When using parallel queries the result always lists client-visible process IDs (that is, `pg_backend_pid` results) even if the actual lock is held or awaited by a child worker process. As a result of that, there may be duplicated PIDs in the result."*

11. **`pg_blocking_pids` zero PID = prepared transaction.** *"Also note that when a prepared transaction holds a conflicting lock, it will be represented by a zero process ID."* Find via `SELECT * FROM pg_prepared_xacts;`.

12. **Cumulative counters wrap at bigint, eventually.** `pg_stat_database.tup_returned`, `pg_stat_user_tables.seq_tup_read`, `pg_stat_wal.wal_records` are bigints. On extremely-high-traffic clusters, they wrap after years of uptime. A negative `delta = current - prior` between two snapshots is a wraparound signal, not a bug.

13. **`stats_reset` is per-collector-target, not per-view.** Resetting `pg_stat_database` does not reset `pg_stat_user_tables` or `pg_stat_user_indexes`. Each per-database stat target resets together; cross-cluster shared stats (bgwriter, checkpointer, wal, io, archiver) reset independently via `pg_stat_reset_shared(target text)`.

14. **`pg_stat_replication.replay_lag` is NULL on idle standbys.** A standby that has caught up to the primary's LSN and is waiting has `replay_lag = NULL`. Reading this as "no lag" is correct, but it is NOT equivalent to "the standby is healthy" — a stopped standby also has `replay_lag = NULL` because no recent WAL has been streamed.

15. **`pg_stat_progress_create_index` shows `phase = 'waiting for writers before build'` indefinitely if a long transaction is open.** CREATE INDEX CONCURRENTLY's wait-for-writers phase is the most common cause of stuck CIC. Identify the blocker via `current_locker_pid` joined to `pg_stat_activity`. Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md) Recipe 8.

16. **`pg_stat_subscription` does NOT contain error counts.** Subscription errors live in `pg_stat_subscription_stats` (PG15+). On PG14 there is no SQL-visible subscription error counter; read the logs.

17. **`pg_stat_wal.wal_buffers_full > 0` on a busy cluster signals undersized `wal_buffers`.** Cross-reference [`33-wal.md`](./33-wal.md) for `wal_buffers` tuning.

18. **`pg_stat_database.conflicts > 0` only matters on standbys.** On the primary, this is always zero. Recovery conflicts on a standby (a primary VACUUM removed rows that a standby query was using) are normal under load; raise them above zero by setting `hot_standby_feedback = on` (with cost — see [`73-streaming-replication.md`](./73-streaming-replication.md)).

19. **`pg_stat_database.checksum_failures > 0` is an emergency.** This is page-level corruption. Cross-reference [`88-corruption-recovery.md`](./88-corruption-recovery.md). Treat the cluster as compromised until you have isolated the corrupted relation via `pg_amcheck`.

20. **`pg_stat_user_indexes.idx_tup_fetch` is zero for Index Only Scans without heap fetches.** A working index-only-scan plan increments `idx_tup_read` but not `idx_tup_fetch`. Concluding "this index is not returning rows" from `idx_tup_fetch = 0` is wrong; check `idx_scan` and `idx_tup_read` instead.

21. **`pg_stat_progress_basebackup` only shows server-side basebackup operations.** A client-side `pg_basebackup` running in another network namespace does not appear here.

22. **`pg_stat_activity.backend_type = 'client backend'` excludes background workers** but INCLUDES parallel workers (with non-NULL `leader_pid`). Filter `leader_pid IS NULL` to count only true client backends and not double-count parallel groups.

23. **`pg_stat_*` queries themselves perturb the statistics they read.** A monitoring agent that runs Recipe 1 every second adds 60 backends/minute of `state = 'active'` activity to `pg_stat_activity` and increments `xact_commit` on `pg_stat_database` (assuming each query is its own transaction). For very-high-cardinality cluster-wide monitoring, sample at intervals matching your retention granularity rather than continuously.

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — Tuple visibility, xmin/xmax, snapshot construction.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM mechanics, autovacuum tuning, `pg_stat_progress_vacuum` deep dive.
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — XID-horizon analysis, anti-wraparound autovacuum, capacity planning.
- [`32-buffer-manager.md`](./32-buffer-manager.md) — Shared buffers, ring buffers, `pg_stat_io` interpretation.
- [`33-wal.md`](./33-wal.md) — `pg_stat_wal`, WAL volume tuning, PG18 column relocations.
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — `pg_stat_checkpointer` deep dive, PG17 split, PG18 `num_done` and `slru_written`.
- [`41-transactions.md`](./41-transactions.md) — Idle-in-transaction handling, `idle_in_transaction_session_timeout`.
- [`43-locking.md`](./43-locking.md) — Full lock-conflict matrix, `pg_locks` schema, `pg_blocking_pids` deep dive.
- [`44-advisory-locks.md`](./44-advisory-locks.md) — Advisory-lock visibility in `pg_locks` and `pg_stat_activity`.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pg_monitor` predefined role for non-superuser monitoring access.
- [`56-explain.md`](./56-explain.md) — Per-query plan analysis (complements aggregate `pg_stat_*` views).
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — Cross-query aggregate statistics.
- [`59-planner-tuning.md`](./59-planner-tuning.md) — Planner cost GUCs and `enable_*` toggles; wait events from bad plans route here.
- [`73-streaming-replication.md`](./73-streaming-replication.md) — Replication lag interpretation, sync states.
- [`74-logical-replication.md`](./74-logical-replication.md) — Subscription stats, conflict tracking.
- [`75-replication-slots.md`](./75-replication-slots.md) — Slot retention, abandoned-slot diagnosis.
- [`82-monitoring.md`](./82-monitoring.md) — End-to-end monitoring stack (Prometheus exporter, alerting thresholds).
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `checksum_failures` response, `pg_amcheck`.
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — Catalog-exploration recipes and cross-cutting diagnostic playbooks.

## Sources

[^monitoring-chapter]: PostgreSQL 16 documentation, Chapter 28: Monitoring Database Activity. https://www.postgresql.org/docs/16/monitoring-stats.html — verbatim: *"The `wait_event` and `state` columns are independent. If a backend is in the `active` state, it may or may not be `waiting` on some event."* and *"when a server process is asked to display any of the accumulated statistics, accessed values are cached until the end of its current transaction in the default configuration ... You can invoke `pg_stat_clear_snapshot()` to discard the current transaction's statistics snapshot or cached values."*

[^pg-stat-activity]: PostgreSQL 16, `pg_stat_activity` view section. https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW — verbatim: *"The `pg_stat_activity` view will have one row per server process, showing information related to the current activity of that process."*

[^progress-reporting]: PostgreSQL 16, Progress Reporting chapter. https://www.postgresql.org/docs/16/progress-reporting.html — verbatim: *"Whenever `VACUUM` is running, the `pg_stat_progress_vacuum` view will contain one row for each backend (including autovacuum worker processes) that is currently vacuuming."*

[^pg-blocking-pids]: PostgreSQL 16, System Information Functions. https://www.postgresql.org/docs/16/functions-info.html — verbatim: *"One server process blocks another if it either holds a lock that conflicts with the blocked process's lock request (hard block), or is waiting for a lock that would conflict with the blocked process's lock request and is ahead of it in the wait queue (soft block). When using parallel queries the result always lists client-visible process IDs ... there may be duplicated PIDs in the result. Also note that when a prepared transaction holds a conflicting lock, it will be represented by a zero process ID."*

[^pg14-wal]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: *"Add system view `pg_stat_wal` to report WAL activity (Masahiro Ikeda)."*

[^pg14-replslot-stats]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: *"Add system view `pg_stat_replication_slots` to report replication slot activity."*

[^pg14-waitstart]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: *"Add lock wait start time to `pg_locks` (Atsushi Torikoshi)."*

[^pg14-idle-session]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: *"Add server parameter `idle_session_timeout` to close idle sessions. This is similar to `idle_in_transaction_session_timeout` but applies to any idle session."*

[^pg14-session-stats]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: *"Add session statistics to the `pg_stat_database` system view (Laurenz Albe)."*

[^pg15-subscription-stats]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/ — verbatim: *"Add system view `pg_stat_subscription_stats` to report on subscriber activity."*

[^pg15-log-checkpoints-default]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/ — verbatim: *"This changes the default of `log_checkpoints` to `on` and that of `log_autovacuum_min_duration` to 10 minutes. This will cause even an idle server to generate some log output, which can be disabled by setting these parameters to off and -1, respectively."*

[^pg15-archive-wait]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/ — verbatim: *"Add wait events for local shell commands ... used when calling `archive_command`, `archive_cleanup_command`, `restore_command` and `recovery_end_command`."*

[^pg16-io]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: *"Add system view `pg_stat_io` view to track I/O statistics (Melanie Plageman)."*

[^pg16-last-scan]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: *"Record statistics on the last sequential and index scans on tables (Dave Page). The columns `pg_stat_*_tables.last_seq_scan`, `last_idx_scan`, and `pg_stat_*_indexes.last_idx_scan` were added for this purpose."*

[^pg16-newpage]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: *"Record statistics on the occurrence of updated rows moving to new pages (Corey Huinker). The `pg_stat_*_tables` column is `n_tup_newpage_upd`."*

[^pg16-leader-pid]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: *"Column `leader_pid` was added to system view `pg_stat_subscription` to track parallel activity."*

[^pg16-spindelay]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: *"Add wait event `SpinDelay` to report spinlock sleep delays."*

[^pg17-checkpointer]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — verbatim: *"Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."*

[^pg17-bgwriter-removal]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — verbatim: *"Remove `buffers_backend` and `buffers_backend_fsync` from `pg_stat_bgwriter` ... These fields are considered redundant to similar columns in `pg_stat_io`."*

[^pg17-wait-events]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — verbatim: *"Add system view `pg_wait_events` that reports wait event types (Bertrand Drouvot). This is useful for adding descriptions to wait events reported in `pg_stat_activity`."*

[^pg18-io-bytes]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add `pg_stat_io` columns to report I/O activity in bytes (Nazir Bilal Yavuz). The new columns are `read_bytes`, `write_bytes`, and `extend_bytes`. The `op_bytes` column, which always equalled `BLCKSZ`, has been removed."*

[^pg18-io-wal]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add WAL I/O activity rows to `pg_stat_io` ... This includes WAL receiver activity and a wait event for such writes."*

[^pg18-backend-io]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add per-backend I/O statistics reporting (Bertrand Drouvot). The statistics are accessed via `pg_stat_get_backend_io()`. Per-backend I/O statistics can be cleared via `pg_stat_reset_backend_stats()`."*

[^pg18-num-done]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add column `pg_stat_checkpointer.num_done` to report the number of completed checkpoints (Anton A. Melnikov). Columns `num_timed` and `num_requested` count both completed and skipped checkpoints."*

[^pg18-slru-written]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add column `pg_stat_checkpointer.slru_written` to report SLRU buffers written (Nitin Jadhav). Also, modify the checkpoint server log message to report separate shared buffer and SLRU buffer values."*

[^pg18-parallel]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add columns to `pg_stat_database` to report parallel worker activity (Benoit Lobréau). The new columns are `parallel_workers_to_launch` and `parallel_workers_launched`."*

[^pg18-cost-delay]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: *"Add delay time reporting to VACUUM and ANALYZE ... tracking must be enabled with the server variable `track_cost_delay_timing`."*

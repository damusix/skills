# Buffer Manager

PostgreSQL caches every disk page it reads through a fixed-size shared-memory cache called the **buffer pool**. Its size is set by `shared_buffers`, its eviction is **clock-sweep** (not LRU), and its observability surface is the `pg_buffercache` extension plus the `pg_stat_io` and `pg_stat_bgwriter`/`pg_stat_checkpointer` cumulative views. This file is the canonical reference for sizing, eviction, ring-buffer carve-outs, the background writer, and live inspection of the cache.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [shared_buffers](#shared_buffers)
    - [huge_pages](#huge_pages)
    - [temp_buffers (per-backend, not in shared_buffers)](#temp_buffers-per-backend-not-in-shared_buffers)
    - [Clock-sweep eviction](#clock-sweep-eviction)
    - [Buffer pin/unpin](#buffer-pinunpin)
    - [Ring buffers (BufferAccessStrategy)](#ring-buffers-bufferaccessstrategy)
    - [Background writer](#background-writer)
    - [pg_buffercache extension](#pg_buffercache-extension)
    - [pg_stat_bgwriter and pg_stat_checkpointer](#pg_stat_bgwriter-and-pg_stat_checkpointer)
    - [pg_stat_io (PG16+)](#pg_stat_io-pg16)
    - [PG18 async I/O subsystem](#pg18-async-io-subsystem)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when the user asks about:

- Sizing `shared_buffers` or interpreting the 25% rule
- Why bumping `shared_buffers` above ~40% of RAM does not help
- `huge_pages = try / on / off`, `huge_page_size` (PG14+)
- Buffer pins, usage counts, clock-sweep, why "LRU" is the wrong mental model
- Ring buffers for sequential scans, vacuum, `COPY` (`bulkread` / `bulkwrite` / `vacuum` contexts in `pg_stat_io`)
- `BUFFER_USAGE_LIMIT` on VACUUM (PG16+), `vacuum_buffer_usage_limit` GUC
- Background writer parameters: `bgwriter_delay`, `bgwriter_lru_maxpages`, `bgwriter_lru_multiplier`, `bgwriter_flush_after`
- `pg_buffercache` columns, `pg_buffercache_summary()` (PG16+), `pg_buffercache_usage_counts()` (PG16+), `pg_buffercache_evict()` (PG17+)
- `pg_stat_bgwriter` column changes in PG17 (most columns moved to `pg_stat_checkpointer`)
- `pg_stat_io` (PG16+) — `bulkread` / `bulkwrite` / `vacuum` contexts, `evictions`, `reuses`
- PG18 async I/O subsystem (`io_method`, `io_combine_limit`, `pg_aios`)
- `prewarm` patterns, `pg_prewarm` extension

For checkpoint mechanics and `checkpoint_completion_target`, see [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md). For WAL buffers, see [`33-wal.md`](./33-wal.md). For `work_mem` / `maintenance_work_mem`, see [`54-memory-tuning.md`](./54-memory-tuning.md).

## Mental Model

Five rules drive every operational decision about the buffer manager:

1. **`shared_buffers` is a fixed-size cache allocated at server start.** Default is `128MB`[^shared-buffers]. The official guidance is *"a reasonable starting value for `shared_buffers` is 25% of the memory in your system ... it is unlikely that an allocation of more than 40% of RAM to `shared_buffers` will work better than a smaller amount."*[^shared-buffers] The headline reason is that Postgres also relies on the operating system page cache — beyond ~25%, you start fighting the kernel for the same pages.

2. **Eviction is clock-sweep, not LRU.** Every buffer has a `usagecount` in the range 0–5. On access, `usagecount` is incremented (capped at 5); the buffer manager's "clock hand" sweeps the array looking for a buffer with `usagecount = 0` and `pinning_backends = 0` to reuse, decrementing the count on each sweep[^pgbuffercache][^buf-readme]. There is no global access-time order maintained anywhere.

3. **Ring buffers carve a small cache off the main pool to protect it from sequential scans, vacuum, and `COPY`.** Without them, a single `SELECT *` over a 100 GB table would evict every hot page. Visible in `pg_stat_io` as `context = bulkread` / `bulkwrite` / `vacuum`[^pgstatio]. The verbatim docs phrasing: *"an existing buffer in a size-limited ring buffer outside of shared buffers was reused as part of an I/O operation in the `bulkread`, `bulkwrite`, or `vacuum` `context`s."*[^pgstatio]

4. **Dirty pages are written by the checkpointer and the background writer, not by readers.** A backend that reads a dirty page does not write it; if the bgwriter falls behind under sustained write load, backends will write their own buffers (counted in PG16's `pg_stat_bgwriter.buffers_backend`; in PG17+ this counter was removed and the data is in `pg_stat_io`)[^pg17-checkpointer].

5. **`pg_buffercache` lets you inspect the cache live.** It is a contrib extension that exposes the entire buffer descriptor array as a SQL-queryable view, plus aggregate functions (`pg_buffercache_summary()` PG16+, `pg_buffercache_usage_counts()` PG16+, `pg_buffercache_evict()` PG17+)[^pgbuffercache][^pg16-buffercache][^pg17-evict].

## Decision Matrix

| You want to | Use | Avoid | Why |
|---|---|---|---|
| Pick a starting `shared_buffers` on a dedicated DB host | 25% of RAM, capped at ~16 GB on workloads with high churn | `>40%` of RAM | The docs cap their own advice at 40%; beyond that, double-caching with the kernel dominates[^shared-buffers] |
| Avoid TLB pressure on a large `shared_buffers` server | `huge_pages = try` (default) + Linux hugepages reserved | `huge_pages = off` | Smaller page tables, less CPU on memory management[^huge-pages] |
| Throttle a manual `VACUUM` so it doesn't sweep the shared pool | `VACUUM (BUFFER_USAGE_LIMIT '32MB')` (PG16+) | unset `vacuum_buffer_usage_limit` | The default ring-buffer carve-out applies; this raises it for a single command[^pg16-buffer-usage] |
| See what's actually hot in cache right now | `SELECT * FROM pg_buffercache_summary();` (PG16+) | full `pg_buffercache` view | The view materializes one row per buffer — slow on large pools; the summary function is constant-time[^pg16-buffercache] |
| Distribution of usage counts | `SELECT * FROM pg_buffercache_usage_counts();` (PG16+) | hand-rolled `GROUP BY usagecount` over `pg_buffercache` | Function is documented and constant-time[^pg16-buffercache] |
| Eject a specific buffer in testing | `pg_buffercache_evict(<bufferid>)` (PG17+) | restart the server | The PG17+ function does this exactly without disturbing other state[^pg17-evict] |
| Measure I/O by class (relation read, vacuum read, bulk write) | `pg_stat_io` (PG16+) | only `pg_stat_bgwriter` | `pg_stat_io` decomposes by `backend_type × context × object`; `pg_stat_bgwriter` is a global counter[^pg16-pgstatio] |
| Diagnose "is my buffer pool too small" | `buffers_backend > 0.05 × buffers_alloc` (PG≤16) or PG17+ `pg_stat_io.writes` filtered by `backend_type = 'client backend'` | only `cache hit ratio` | Cache hit ratio is a stat without an action; backend-write rate tells you the bgwriter has fallen behind[^pg16-bgwriter] |
| Pre-load hot tables at startup | `pg_prewarm` extension | empty pool + first-query latency | `pg_prewarm` is the canonical mechanism; see [`69-extensions.md`](./69-extensions.md) |
| Enable async I/O on PG18+ | `io_method = worker` (default) or `io_uring` | `io_method = sync` (legacy) | PG18 introduced the async I/O subsystem; the default is `worker`[^pg18-aio] |

**Three smell signals** for a buffer-manager-level problem:

- `pg_stat_bgwriter.buffers_backend` (PG≤16) is a meaningful fraction of `buffers_alloc` — backends are writing because the bgwriter can't keep up, usually a symptom of dirty-page accumulation under sustained write load
- `pg_buffercache_usage_counts()` shows most buffers at `usage_count = 5` and almost nothing at `0` — your working set is larger than `shared_buffers` and every page is being constantly re-accessed; raising `shared_buffers` helps until you hit the 25-40% ceiling
- `pg_stat_io` shows high `evictions` and low `reuses` in `bulkread` context — the bulkread ring buffer isn't being reused (every block evicts a different shared-pool victim); cross-check with sequential scans on tables larger than `shared_buffers / 32` (the ~256 KB ring vs 8 KB page)

## Syntax / Mechanics

### shared_buffers

**Default:** `128MB`. May be capped at server startup by kernel SHMMAX/SHMALL or by `initdb`'s probe[^shared-buffers].

**Verbatim sizing guidance** from the docs:

> *"If you have a dedicated database server with 1GB or more of RAM, a reasonable starting value for `shared_buffers` is 25% of the memory in your system. There are some workloads where even larger settings for `shared_buffers` are effective, but because PostgreSQL also relies on the operating system cache, it is unlikely that an allocation of more than 40% of RAM to `shared_buffers` will work better than a smaller amount."*[^shared-buffers]

**`shared_buffers` can only be set at server start.**[^shared-buffers] Changing it requires editing `postgresql.conf` (or `postgresql.auto.conf` via `ALTER SYSTEM SET`) and restarting.

```sql
-- Inspect the active value
SHOW shared_buffers;

-- Change for next restart
ALTER SYSTEM SET shared_buffers = '16GB';
-- Then restart the server (pg_ctl restart / systemctl restart postgresql)
```

**Practical sizing tiers** for dedicated DB hosts:

| RAM | Starting `shared_buffers` | Ceiling |
|---|---|---|
| 4 GB | 1 GB | 1.6 GB |
| 16 GB | 4 GB | 6.4 GB |
| 64 GB | 16 GB | 24 GB |
| 256 GB | ~32 GB (25% but capped) | rarely beneficial above 32 GB |
| 1 TB | ~64 GB (well below 25%) | the OS cache + NUMA penalties dominate |

The "ceiling rarely above 32 GB on TB-class hosts" rule of thumb is community lore, not docs; it comes from contention on the buffer-manager lock table and clock-sweep cost growing with buffer count.

### huge_pages

**Default:** `try`. Valid values: `try`, `on`, `off`. Set at server start only[^huge-pages].

> *"The use of huge pages results in smaller page tables and less CPU time spent on memory management, increasing performance."*[^huge-pages]

On Linux you must pre-reserve hugepages in the kernel:

```bash
# As root, reserve 8 GB of 2 MB hugepages (4096 pages):
sysctl -w vm.nr_hugepages=4096

# Or persist in /etc/sysctl.d/40-postgres-hugepages.conf:
#   vm.nr_hugepages = 4096
```

> [!NOTE] PostgreSQL 14
> Added `huge_page_size` server parameter to control huge page size on Linux (Odin Ugedal)[^pg14-hugepagesize]. Useful for systems with 1 GB hugepages.

> [!NOTE] PostgreSQL 15
> Added `shared_memory_size` and `shared_memory_size_in_huge_pages` to report the allocated shared memory size and the number of huge pages required (Nathan Bossart)[^pg15-shmsize]. Pre-flight check for hugepage configuration:
>
>     SELECT name, setting, unit FROM pg_settings
>     WHERE name IN ('shared_memory_size', 'shared_memory_size_in_huge_pages');

### temp_buffers (per-backend, not in shared_buffers)

`temp_buffers` is **per-backend**, allocated lazily, and used only for temporary tables[^temp-buffers]. Default `8MB`.

> *"This setting can be changed within individual sessions, but only before the first use of temporary tables within the session; subsequent attempts to change the value will have no effect on that session."*[^temp-buffers]

Read this in two places: it is *not* part of `shared_buffers`, and once a session has touched a temp table the value is frozen for that session.

### Clock-sweep eviction

Postgres uses a clock-sweep algorithm rather than strict LRU. The user-facing docs describe the algorithm only indirectly via the `pg_buffercache.usagecount` column (*"Clock-sweep access count"*[^pgbuffercache]). The canonical reference is `src/backend/storage/buffer/README` in the source tree[^buf-readme].

The mechanics in operational terms:

1. Every buffer descriptor holds a `usage_count` in the range 0–5.
2. On buffer access (the act of pinning a buffer), `usage_count` is incremented, capped at `BM_MAX_USAGE_COUNT = 5`.
3. The buffer manager maintains a single global "sweep position." When a backend needs a free buffer, it advances the sweep one slot at a time. At each slot:
   - If `pinning_backends > 0`, skip (cannot evict a pinned buffer).
   - Else if `usage_count > 0`, decrement and skip.
   - Else (`usage_count = 0` and unpinned), reuse this buffer.
4. The sweep wraps around the entire array; a hot buffer with `usage_count = 5` survives five sweep passes before becoming eligible.

This means the cache has a *coarse* notion of recency — five sweep visits — but does not track per-access timestamps. A buffer accessed once a millisecond and a buffer accessed once a second look identical at `usage_count = 5`.

The freelist (buffers not yet in use, plus buffers explicitly returned to the freelist by certain operations) is consulted first; clock-sweep is the fallback when the freelist is empty.

### Buffer pin/unpin

The user-facing docs do not describe the pin protocol in narrative form. The canonical reference is `src/backend/storage/buffer/README`[^buf-readme] and `src/include/storage/bufmgr.h`. The observable surface from SQL:

- `pg_buffercache.pinning_backends` — number of backends currently pinning the buffer (cannot be evicted while > 0)[^pgbuffercache]
- `pg_buffercache_summary().buffers_pinned` — aggregate count of pinned buffers[^pgbuffercache]

The operational invariants:

- Every buffer access acquires a **pin** (a refcount on the buffer). The pin prevents eviction.
- A pin is held only for the duration of work on the buffer (typically: until a row is read from the page, or until a tuple lock is released). Pins are short-lived.
- A pin is **not** a content lock. Concurrent readers all pin the same buffer simultaneously. Separate buffer **content locks** (shared or exclusive) serialize reads against writes to the same page.

A high `buffers_pinned` count in `pg_buffercache_summary` during steady state usually indicates many concurrent queries scanning the same hot pages — not a problem, just normal contention.

### Ring buffers (BufferAccessStrategy)

When Postgres detects an access pattern that would otherwise destroy the shared pool (a large sequential scan, a vacuum, a `COPY`), it does not use the full pool. It uses a small **ring buffer** — a fixed-size carve-out — that recycles its own buffers as the operation advances.

The user-facing docs describe ring-buffer behavior only via `pg_stat_io.context` and the column definitions:

> *"`bulkread`: Certain large read I/O operations done outside of shared buffers, for example, a sequential scan of a large table. `bulkwrite`: Certain large write I/O operations done outside of shared buffers, such as `COPY`. `vacuum`: I/O operations performed outside of shared buffers while vacuuming and analyzing permanent relations."*[^pgstatio]

> *"`evictions`: ... In `context`s `bulkwrite`, `bulkread`, and `vacuum`, this counts the number of times a block was evicted from shared buffers in order to add the shared buffer to a separate, size-limited ring buffer for use in a bulk I/O operation."*[^pgstatio]

> *"`reuses`: The number of times an existing buffer in a size-limited ring buffer outside of shared buffers was reused as part of an I/O operation in the `bulkread`, `bulkwrite`, or `vacuum` `context`s."*[^pgstatio]

**Ring-buffer sizes** (from `src/backend/storage/buffer/freelist.c`, source-tree authority — not in the user docs)[^buf-readme]:

| Context | Default size | Trigger |
|---|---|---|
| `bulkread` | 256 KB (32 × 8 KB blocks) | Sequential scans of tables larger than `shared_buffers / 4` |
| `bulkwrite` | 16 MB (2048 × 8 KB blocks) | `COPY FROM`, `CREATE TABLE AS`, `CTAS`, large inserts |
| `vacuum` | 256 KB by default, overridable by `BUFFER_USAGE_LIMIT` (PG16+) | Manual or auto VACUUM |

The trigger for `bulkread` is heuristic: only sequential scans whose estimated relation size exceeds `shared_buffers / 4` switch to the ring; smaller scans use the full shared pool.

> [!NOTE] PostgreSQL 16
> Added `BUFFER_USAGE_LIMIT` option to `VACUUM` and `ANALYZE`, the `--buffer-usage-limit` flag to `vacuumdb`, and the `vacuum_buffer_usage_limit` server variable to control the default[^pg16-buffer-usage]. The verbatim release note: *"Allow control of the shared buffer usage by vacuum and analyze (Melanie Plageman). The VACUUM/ANALYZE option is `BUFFER_USAGE_LIMIT`, and the vacuumdb option is `--buffer-usage-limit`. The default value is set by server variable `vacuum_buffer_usage_limit`, which also controls autovacuum."*[^pg16-buffer-usage] Default: `256kB` (PG16), raised to `2MB` (PG17+)[^pg17-bufferusagelimit].
>
>     -- A manual vacuum that gets more cache than the default ring
>     VACUUM (BUFFER_USAGE_LIMIT '32MB', VERBOSE) my_big_table;
>
>     -- Cluster-wide change (also affects autovacuum)
>     ALTER SYSTEM SET vacuum_buffer_usage_limit = '32MB';

> [!WARNING] Cap on `vacuum_buffer_usage_limit`
> *"If the specified size would exceed 1/8 the size of `shared_buffers`, the size is silently capped to that value."*[^vacuum-buffer-usage] On a server with `shared_buffers = 1GB`, the maximum effective `BUFFER_USAGE_LIMIT` is `128MB` — anything higher is silently capped. Cross-check the active limit with `SHOW vacuum_buffer_usage_limit`.

### Background writer

The background writer (bgwriter) writes a small fraction of dirty buffers in the background to keep the buffer pool from filling up with dirty pages. **The bgwriter does not perform checkpoints** — that is the checkpointer's job, covered in [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md).

Four GUCs control it:

| GUC | Default | Description |
|---|---|---|
| `bgwriter_delay` | `200ms` | Sleep between activity rounds. The writer sleeps longer if no dirty buffers are found.[^bgwriter-delay] |
| `bgwriter_lru_maxpages` | `100` | Max buffers written per round. `0` disables background writing entirely (does not affect checkpoints).[^bgwriter-maxpages] |
| `bgwriter_lru_multiplier` | `2.0` | Estimate of how many clean buffers will be needed next round, expressed as a multiple of the recent average need.[^bgwriter-multiplier] |
| `bgwriter_flush_after` | `512kB` (Linux), `0` (elsewhere) | Force `sync_file_range` (or equivalent) after this many bytes are written, to spread dirty-page writeback in the OS page cache.[^bgwriter-flush] |

The verbatim `bgwriter_lru_multiplier` description captures the whole sizing logic:

> *"The number of dirty buffers written in each round is based on the number of new buffers that have been needed by server processes during recent rounds. The average recent need is multiplied by `bgwriter_lru_multiplier` to arrive at an estimate of the number of buffers that will be needed during the next round. Dirty buffers are written until there are that many clean, reusable buffers available. (However, no more than `bgwriter_lru_maxpages` buffers will be written per round.) Thus, a setting of 1.0 represents a 'just in time' policy of writing exactly the number of buffers predicted to be needed. Larger values provide some cushion against spikes in demand, while smaller values intentionally leave writes to be done by server processes."*[^bgwriter-multiplier]

The operational interpretation:

- **`bgwriter_lru_maxpages = 100` per `bgwriter_delay = 200ms` = 500 buffers/sec ≈ 4 MB/sec.** That is the *maximum* the bgwriter will write per second on default settings. On a high-write workload that dirties more than 4 MB/sec sustained, backends will be forced to write their own dirty buffers (visible pre-PG17 as `pg_stat_bgwriter.buffers_backend`).
- **Raising `bgwriter_lru_maxpages` to 1000** (10× default) raises the ceiling to 40 MB/sec. This is a reasonable change on SSDs with sustained write workloads.
- **Lowering `bgwriter_delay` to `50ms`** quadruples the polling frequency. Combined with `bgwriter_lru_maxpages = 1000`, you get up to 160 MB/sec of background writeback.

```sql
-- Aggressive bgwriter on an SSD with sustained write workload
ALTER SYSTEM SET bgwriter_delay = '50ms';
ALTER SYSTEM SET bgwriter_lru_maxpages = 1000;
ALTER SYSTEM SET bgwriter_lru_multiplier = 4.0;
SELECT pg_reload_conf();  -- no restart needed
```

### pg_buffercache extension

`pg_buffercache` is a contrib extension that exposes the buffer descriptor array as a SQL-queryable surface[^pgbuffercache]. It is included with the `postgresql-contrib` package on most distributions and is one of the most useful diagnostic extensions in the ecosystem.

```sql
CREATE EXTENSION pg_buffercache;

-- Permissions:
-- "By default, use is restricted to superusers and roles with privileges
--  of the pg_monitor role. Access may be granted to others using GRANT."[^pgbuffercache]
GRANT pg_monitor TO observability_role;
```

**The `pg_buffercache` view** — one row per buffer in `shared_buffers`. On a 16 GB pool with 8 KB pages this is 2 million rows. Use sparingly:

| Column | Type | Meaning |
|---|---|---|
| `bufferid` | integer | Buffer ID in 1..shared_buffers |
| `relfilenode` | oid | Filenode of the relation |
| `reltablespace` | oid | Tablespace OID |
| `reldatabase` | oid | Database OID |
| `relforknumber` | smallint | Fork number; see `common/relpath.h` |
| `relblocknumber` | bigint | Page number within the relation |
| `isdirty` | boolean | Is the page dirty? |
| `usagecount` | smallint | Clock-sweep access count (0–5) |
| `pinning_backends` | integer | Backends currently pinning the buffer |

> [!NOTE] PostgreSQL 16
> Added two constant-time aggregate functions[^pg16-buffercache]: `pg_buffercache_summary()` returns a single-row summary; `pg_buffercache_usage_counts()` returns one row per usage count (0–5) with the buffer count, dirty count, and pinned count at each.

```sql
-- Constant-time summary (use this in monitoring, not the view)
SELECT * FROM pg_buffercache_summary();
-- buffers_used | buffers_unused | buffers_dirty | buffers_pinned | usagecount_avg
--    1832104   |      215896    |     143002    |       247      |     3.42

SELECT * FROM pg_buffercache_usage_counts();
-- usage_count | buffers | dirty  | pinned
-- 0           |  215896 |     0  |      0
-- 1           |    8412 |  1203  |      0
-- 2           |   42150 |  6712  |      1
-- 3           |  189240 | 21043  |     11
-- 4           |  514302 | 41872  |     38
-- 5           | 1077000 | 72172  |    197
```

> [!NOTE] PostgreSQL 17
> Added `pg_buffercache_evict(bufferid)` for testing[^pg17-evict]. Verbatim: *"Add pg_buffercache function `pg_buffercache_evict()` to allow shared buffer eviction (Palak Chaturvedi, Thomas Munro). This is useful for testing."*

### pg_stat_bgwriter and pg_stat_checkpointer

> [!WARNING] PostgreSQL 17 column moves
> PG17 split `pg_stat_bgwriter` into two views[^pg17-checkpointer]. The verbatim release note: *"Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."* Monitoring queries written for PG≤16 must be rewritten for PG17+.

**PG16 `pg_stat_bgwriter` columns** (11 total)[^monitoring-stats]:

| Column | Where it goes in PG17+ |
|---|---|
| `checkpoints_timed` | `pg_stat_checkpointer.num_timed` |
| `checkpoints_req` | `pg_stat_checkpointer.num_requested` |
| `checkpoint_write_time` | `pg_stat_checkpointer.write_time` |
| `checkpoint_sync_time` | `pg_stat_checkpointer.sync_time` |
| `buffers_checkpoint` | `pg_stat_checkpointer.buffers_written` |
| `buffers_clean` | **kept** in `pg_stat_bgwriter` |
| `maxwritten_clean` | **kept** in `pg_stat_bgwriter` |
| `buffers_backend` | **removed** — data is in `pg_stat_io` (writes by `client backend`) |
| `buffers_backend_fsync` | **removed** — data is in `pg_stat_io` (fsyncs by `client backend`) |
| `buffers_alloc` | **kept** in `pg_stat_bgwriter` |
| `stats_reset` | **kept** in `pg_stat_bgwriter` |

**PG17+ `pg_stat_checkpointer` columns** (9 total)[^pg17-checkpointer]:

| Column | Meaning |
|---|---|
| `num_timed` | Scheduled checkpoints (timeout-triggered; *includes skipped ones*) |
| `num_requested` | Requested checkpoints (executed) |
| `restartpoints_timed` | Restartpoints due to timeout |
| `restartpoints_req` | Requested restartpoints |
| `restartpoints_done` | Restartpoints performed |
| `write_time` | Time spent in checkpoint write phase, ms |
| `sync_time` | Time spent in checkpoint sync phase, ms |
| `buffers_written` | Buffers written by checkpoints + restartpoints |
| `stats_reset` | Last reset timestamp |

The `num_timed` semantics changed: it counts both completed and *skipped* scheduled checkpoints (the server checks the schedule but may skip if idle). Use `num_timed - num_requested` to estimate skipped scheduled checkpoints only in PG≤16; in PG17+ the field already includes skips and is documented as such[^pg17-checkpointer].

### pg_stat_io (PG16+)

> [!NOTE] PostgreSQL 16
> Added `pg_stat_io` to track I/O statistics decomposed by `backend_type × context × object`[^pg16-pgstatio]. Verbatim: *"Add system view `pg_stat_io` view to track I/O statistics (Melanie Plageman)."*

`pg_stat_io` is the single most useful operational view for buffer-manager diagnostics added in the past several releases. Each row aggregates I/O by:

- `backend_type` — `autovacuum worker`, `client backend`, `background writer`, `checkpointer`, `walwriter`, `archiver`, `standalone backend`, `startup`, `walsender`, `walreceiver`, `logical replication launcher`, `logical replication worker`, `parallel worker`, `slotsync worker`
- `object` — `relation` or `temp relation`
- `context` — `normal`, `vacuum`, `bulkread`, `bulkwrite`

The columns track reads, writes, extends, hits, evictions, reuses, writebacks, fsyncs[^pgstatio]:

| Column | What it measures |
|---|---|
| `reads` / `read_time` | Counted in `op_bytes` (8 KB) units. Time in ms. |
| `writes` / `write_time` | Counted in `op_bytes` units. |
| `writebacks` / `writeback_time` | OS-level writeback hints (`sync_file_range` on Linux). |
| `extends` / `extend_time` | Relation extension (new blocks). |
| `op_bytes` | Block size — `BLCKSZ`, usually 8192. |
| `hits` | Shared buffer hits. |
| `evictions` | Buffers evicted. In `bulkread`/`bulkwrite`/`vacuum`, counts buffers moved from shared pool *into* the ring. In `normal`, counts pool-level evictions. |
| `reuses` | Ring-buffer reuses (only meaningful in `bulkread`/`bulkwrite`/`vacuum`). |
| `fsyncs` / `fsync_time` | Only tracked in `normal` context. |

```sql
-- Total bytes read by sequential-scan ring buffers since stats reset
SELECT backend_type,
       reads * op_bytes / 1024 / 1024 AS read_mib,
       reuses,
       evictions
FROM   pg_stat_io
WHERE  context = 'bulkread'
  AND  object = 'relation'
ORDER  BY read_mib DESC;
```

> [!NOTE] PostgreSQL 18
> `pg_stat_io` was significantly extended[^pg18-aio]. New columns `read_bytes`, `write_bytes`, `extend_bytes` report I/O directly in bytes (without the `× op_bytes` multiplication). WAL I/O activity now appears in `pg_stat_io` rows. Per-backend I/O statistics are exposed via `pg_stat_get_backend_io()`.

### PG18 async I/O subsystem

> [!NOTE] PostgreSQL 18 — Async I/O (AIO)
> PG18 introduced an asynchronous I/O subsystem[^pg18-aio]. Verbatim: *"Add an asynchronous I/O subsystem (Andres Freund, Thomas Munro, Nazir Bilal Yavuz, Melanie Plageman). This feature allows backends to queue multiple read requests, which allows for more efficient sequential scans, bitmap heap scans, vacuums, etc. This is enabled by server variable `io_method`, with server variables `io_combine_limit` and `io_max_combine_limit` added to control it. This also enables `effective_io_concurrency` and `maintenance_io_concurrency` values greater than zero for systems without `fadvise()` support. The new system view `pg_aios` shows the file handles being used for asynchronous I/O."*

Three relevant GUCs (defaults verified against PG18 docs[^pg18-aio]):

| GUC | Default | Values | Notes |
|---|---|---|---|
| `io_method` | `worker` | `sync`, `worker`, `io_uring` | `worker` uses helper processes; `io_uring` requires Linux kernel io_uring support |
| `io_workers` | `3` | int | Number of AIO worker processes (only when `io_method = worker`) |
| `io_combine_limit` | `128kB` (16 blocks) | size | Max I/O coalescing per request |

PG18 also raised `effective_io_concurrency` and `maintenance_io_concurrency` defaults to 16[^pg18-aio]: *"Increase server variables `effective_io_concurrency`'s and `maintenance_io_concurrency`'s default values to 16 (Melanie Plageman). This more accurately reflects modern hardware."*

Operational impact:

- Sequential scans, bitmap heap scans, and vacuum gain coalesced async reads; throughput on storage with deep queue depth (NVMe, networked block storage) improves significantly.
- The async path can be inspected via `pg_aios` (file handles in flight for async I/O).
- `pg_stat_io` rows now include `reads` from async I/O (no separate context).

### Per-version timeline

| Version | Buffer-manager-relevant changes |
|---|---|
| PG14 | `huge_page_size` GUC[^pg14-hugepagesize]; analyze pre-fetching via `maintenance_io_concurrency`[^pg14-prefetch]; parallel-seqscan I/O improvements[^pg14-parallel-seqscan]; `vacuum_cost_page_miss` default lowered from 10 to 2[^pg14-cost-page-miss]; `recovery_init_sync_method = syncfs` option[^pg14-syncfs]. |
| PG15 | `shared_memory_size` and `shared_memory_size_in_huge_pages` introspection GUCs[^pg15-shmsize]; checkpointer/bgwriter now run during crash recovery[^pg15-bgwriter-recovery]; `log_checkpoints` default changed to `on`[^pg15-log-checkpoints]; WAL prefetch via `recovery_prefetch`[^pg15-recovery-prefetch]. |
| PG16 | `pg_stat_io` view[^pg16-pgstatio]; `BUFFER_USAGE_LIMIT` for VACUUM/ANALYZE + `vacuum_buffer_usage_limit` GUC[^pg16-buffer-usage] (default `256kB`); `pg_buffercache_summary()` + `pg_buffercache_usage_counts()` functions[^pg16-buffercache]. |
| PG17 | `pg_stat_checkpointer` view; `pg_stat_bgwriter` shrunk to 4 columns[^pg17-checkpointer]; `pg_buffercache_evict()` function[^pg17-evict]; `vacuum_buffer_usage_limit` default raised to `2MB`[^pg17-bufferusagelimit]; new VACUUM memory management (removed 1 GB cap); streaming I/O for sequential reads (precursor to PG18 AIO)[^pg17-streaming]; `io_combine_limit` GUC[^pg17-iocombine]. |
| PG18 | Async I/O subsystem (`io_method`, `io_workers`, `pg_aios`)[^pg18-aio]; `effective_io_concurrency` / `maintenance_io_concurrency` defaults raised to 16; `pg_stat_io` extended with `read_bytes` / `write_bytes` / `extend_bytes`, WAL I/O activity, and per-backend `pg_stat_get_backend_io()`; data checksums enabled by default in `initdb`. |

## Examples / Recipes

### Recipe 1 — baseline sizing on a 64 GB dedicated DB host

```ini
# postgresql.conf

shared_buffers = '16GB'              # 25% of RAM
effective_cache_size = '48GB'        # planner hint: OS cache + shared_buffers
huge_pages = try                     # auto-enables if kernel hugepages are reserved
maintenance_work_mem = '2GB'         # see 54-memory-tuning.md
work_mem = '32MB'                    # per-node, per-query — see 54-memory-tuning.md

# Background writer (modestly aggressive for SSD with steady write workload)
bgwriter_delay = '100ms'
bgwriter_lru_maxpages = 500
bgwriter_lru_multiplier = 4.0
bgwriter_flush_after = '512kB'

# PG16+: cap ring-buffer for autovacuum (raises from default 256kB)
vacuum_buffer_usage_limit = '32MB'   # cluster-wide, also applies to autovacuum
```

Linux hugepage reservation (one-time, via `/etc/sysctl.d/40-postgres-hugepages.conf`):

```ini
# 16 GB of 2 MB hugepages = 8192 pages
# Add ~5% headroom for shared memory areas beyond shared_buffers
vm.nr_hugepages = 8400
```

After reboot, verify:

```sql
SELECT name, setting
FROM   pg_settings
WHERE  name IN ('shared_memory_size', 'shared_memory_size_in_huge_pages');
```

### Recipe 2 — what's actually in cache right now (PG16+)

```sql
-- One-line health snapshot
SELECT * FROM pg_buffercache_summary();

-- Buffer count by usage_count (which working set is hot?)
SELECT * FROM pg_buffercache_usage_counts();

-- Top tables by buffer occupancy
SELECT n.nspname || '.' || c.relname AS relation,
       count(*)                       AS buffers,
       pg_size_pretty(count(*) * 8192) AS cache_size,
       count(*) FILTER (WHERE b.isdirty) AS dirty_buffers,
       round(avg(b.usagecount), 2)    AS avg_usagecount
FROM   pg_buffercache b
JOIN   pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
JOIN   pg_namespace n ON c.relnamespace = n.oid
WHERE  c.relkind IN ('r', 'i', 'm', 't', 'p')
GROUP  BY n.nspname, c.relname
ORDER  BY buffers DESC
LIMIT  20;
```

The `pg_buffercache` view is expensive at scale (one row per buffer). Always wrap it in an aggregation; never `SELECT *` it raw on a multi-gigabyte pool.

### Recipe 3 — diagnose "is bgwriter falling behind?" (PG≤16)

```sql
SELECT  buffers_alloc,
        buffers_backend,
        buffers_clean,
        round(100.0 * buffers_backend / NULLIF(buffers_alloc, 0), 2) AS pct_backend,
        round(100.0 * buffers_clean   / NULLIF(buffers_alloc, 0), 2) AS pct_clean,
        maxwritten_clean,
        stats_reset
FROM    pg_stat_bgwriter;
```

Interpretation:

- `pct_backend > 5%` — backends are writing dirty buffers because the bgwriter can't keep up. Raise `bgwriter_lru_maxpages` (e.g., 500 → 1000), lower `bgwriter_delay` (e.g., 200ms → 100ms), or raise `bgwriter_lru_multiplier` (2.0 → 4.0).
- `maxwritten_clean` growing — the bgwriter is hitting its per-round write cap (`bgwriter_lru_maxpages`). Raise it.
- `pct_clean` very low (e.g., <10%) AND `pct_backend` very low — bgwriter is barely running, possibly because the workload doesn't dirty pages fast enough or the pool is mostly clean.

### Recipe 4 — diagnose "is bgwriter falling behind?" (PG17+)

```sql
-- "Backend" writes have moved to pg_stat_io. This query replaces buffers_backend.
SELECT  backend_type,
        sum(writes)   AS write_count,
        sum(writes) * (SELECT current_setting('block_size')::int) / 1024 / 1024 AS write_mib
FROM    pg_stat_io
WHERE   backend_type IN ('client backend', 'autovacuum worker', 'background writer', 'checkpointer')
GROUP   BY backend_type
ORDER   BY write_count DESC;

-- "Clean" writes still in pg_stat_bgwriter
SELECT  buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
FROM    pg_stat_bgwriter;

-- Checkpoint state in pg_stat_checkpointer
SELECT  num_timed, num_requested, buffers_written, write_time, stats_reset
FROM    pg_stat_checkpointer;
```

### Recipe 5 — per-relation I/O via pg_stat_io (PG16+)

```sql
-- Bulk read traffic by relation kind
SELECT  backend_type,
        context,
        object,
        reads,
        reads * (SELECT current_setting('block_size')::int) / 1024 / 1024 AS read_mib,
        hits,
        evictions,
        reuses
FROM    pg_stat_io
WHERE   reads > 0 OR writes > 0
ORDER   BY reads DESC;
```

The high-`reuses`-low-`evictions` rows in `bulkread` / `bulkwrite` / `vacuum` are healthy: the ring buffer is doing its job, protecting the shared pool. High `evictions` in `normal` context indicates cache pressure.

### Recipe 6 — pre-warm hot tables at startup

```sql
CREATE EXTENSION pg_prewarm;

-- Load a specific table and its indexes into shared_buffers
SELECT pg_prewarm('public.orders');
SELECT pg_prewarm(indexrelid::regclass::text)
FROM   pg_index
WHERE  indrelid = 'public.orders'::regclass;
```

For automatic warm-on-startup, use the `pg_prewarm.autoprewarm` background worker (set `shared_preload_libraries = 'pg_prewarm'` plus `pg_prewarm.autoprewarm = on`). It dumps cache contents on shutdown and restores them on startup. See [`69-extensions.md`](./69-extensions.md).

### Recipe 7 — control a manual VACUUM's cache footprint (PG16+)

```sql
-- Default behavior: VACUUM uses a 2 MB ring (PG17+) or 256 kB ring (PG16)
VACUUM (VERBOSE) my_big_table;

-- Larger ring — more cached pages, faster vacuum, more shared-pool churn
VACUUM (BUFFER_USAGE_LIMIT '64MB', VERBOSE) my_big_table;

-- Unlimited — VACUUM uses any number of shared buffers
VACUUM (BUFFER_USAGE_LIMIT 0, VERBOSE) my_big_table;
```

The `BUFFER_USAGE_LIMIT 0` form is appropriate when you *want* the vacuum to evict cold data to make room for the table you're vacuuming (e.g., a one-off vacuum of a critical table). Combined with `PARALLEL n`, this is the fastest way to vacuum a large table during a maintenance window.

### Recipe 8 — pre-PG17 audit query for backend writes

Captures the operational state before upgrading to PG17 (where `buffers_backend` disappears):

```sql
-- Snapshot pre-upgrade so you have historical baseline
CREATE TABLE perf_audit.pg_stat_bgwriter_snapshot AS
SELECT now() AS captured_at, *
FROM   pg_stat_bgwriter;
```

### Recipe 9 — eject one buffer for repeatable testing (PG17+)

```sql
-- Find the buffer for a specific page of a specific relation
SELECT bufferid
FROM   pg_buffercache
WHERE  relfilenode = pg_relation_filenode('public.events'::regclass)
  AND  relblocknumber = 0;
-- bufferid = 42 (example)

-- Evict it (resets usagecount, marks the slot free)
SELECT pg_buffercache_evict(42);

-- Verify
SELECT * FROM pg_buffercache WHERE bufferid = 42;
```

Useful for cold-cache benchmark setup; not a production tool.

### Recipe 10 — enable AIO on PG18+ for SSD/NVMe workloads

```sql
-- Already the default on PG18 — verify
SELECT name, setting
FROM   pg_settings
WHERE  name IN ('io_method', 'io_workers', 'io_combine_limit',
                'effective_io_concurrency', 'maintenance_io_concurrency');

-- For io_uring on supported kernels:
ALTER SYSTEM SET io_method = 'io_uring';

-- Tune coalescing if your storage has deep queues (NVMe / NVMe-oF / network block)
ALTER SYSTEM SET io_combine_limit = '256kB';

-- After change, restart (io_method is restart-only)
```

Observe AIO inflight via `pg_aios`. Inspect throughput change via `pg_stat_io.reads` / `read_bytes` over a fixed interval before and after.

### Recipe 11 — cache-hit ratio for a single table (operationally rarely useful, included for completeness)

```sql
SELECT  relname,
        heap_blks_hit,
        heap_blks_read,
        round(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 2) AS pct_hit
FROM    pg_statio_user_tables
WHERE   relname = 'orders';
```

Cache-hit ratio is a *statistic*, not an *action*. A 99.9% hit ratio doesn't mean your buffer pool is correctly sized — it can mean the working set is small and any pool would hit 99.9%. Use `pg_buffercache_usage_counts()` (Recipe 2) to know whether `shared_buffers` is the bottleneck.

### Recipe 12 — sustained-write detection

```sql
-- Counters since last reset (or use pg_stat_reset_shared('bgwriter') and measure interval)
SELECT  ROUND(EXTRACT(EPOCH FROM (now() - stats_reset))) AS interval_secs,
        buffers_clean,
        ROUND(buffers_clean::numeric * 8192 / 1024 / 1024 /
              EXTRACT(EPOCH FROM (now() - stats_reset)), 2) AS bgwriter_mib_per_sec
FROM    pg_stat_bgwriter;
```

If `bgwriter_mib_per_sec` is consistently near `bgwriter_lru_maxpages * (1000 / bgwriter_delay_ms) * 8 / 1024` (the per-second write ceiling), the bgwriter is saturated. Raise the limits per Recipe 3.

### Recipe 13 — observe ring buffer activity during a large COPY

```sql
-- Reset just before COPY
SELECT pg_stat_reset_shared('io');

-- (terminal 2)
-- COPY orders FROM '/tmp/orders.csv' WITH CSV HEADER;

-- After COPY completes:
SELECT  context, object, writes, evictions, reuses, extends
FROM    pg_stat_io
WHERE   backend_type = 'client backend'
  AND   (writes > 0 OR extends > 0);
```

A clean COPY shows almost all writes/extends in `context = bulkwrite` with high `reuses` (ring is doing its job) and minimal `evictions` (shared pool is being protected).

## Gotchas / Anti-patterns

1. **`shared_buffers > 40%` of RAM is officially documented as unlikely to help**[^shared-buffers]. Beyond ~25-40%, the kernel page cache and shared_buffers fight over the same physical pages (double-caching), and the buffer-mgr lock table contention rises. Tune downward and use `effective_cache_size` (planner hint) to tell the planner about OS cache.

2. **`shared_buffers` is server-start-only.** Changing it requires `ALTER SYSTEM SET ...` + restart. There is no online path.

3. **Clock-sweep is not LRU.** A buffer with `usagecount = 5` can have been touched once five sweeps ago and is still pinned in the cache. There is no per-access timestamp anywhere.

4. **`pg_buffercache` view is one row per buffer.** On a 16 GB pool that's 2 million rows. Always aggregate (`pg_buffercache_summary` on PG16+, or `count(*) GROUP BY`).

5. **`pg_buffercache_summary` and `_usage_counts` require pg_buffercache extension** (`CREATE EXTENSION pg_buffercache`). On managed services these may be preinstalled but require `GRANT pg_monitor TO ...` to access.

6. **`pg_buffercache_evict()` does not exist before PG17**[^pg17-evict]. Pre-PG17 the only way to evict a specific buffer is server restart.

7. **`pg_stat_bgwriter.buffers_backend` removed in PG17**[^pg17-checkpointer]. Monitoring queries that compute "% writes by backends" must move to `pg_stat_io` with `backend_type = 'client backend'`.

8. **`pg_stat_bgwriter.buffers_alloc` is allocations, not writes.** A high `buffers_alloc` rate is a *demand* metric; the *supply* metrics are `buffers_clean` (bgwriter wrote) and `buffers_backend` (backend wrote, pre-PG17) or `pg_stat_io.writes` filtered by backend (PG17+).

9. **`vacuum_buffer_usage_limit` is silently capped at 1/8 of `shared_buffers`**[^vacuum-buffer-usage]. Setting it to `1GB` on a server with `shared_buffers = 4GB` gives you `512MB` effective. Cross-check with `SHOW vacuum_buffer_usage_limit`.

10. **`BUFFER_USAGE_LIMIT = 0` on `VACUUM` removes the ring entirely** — VACUUM will sweep the shared pool. Use only during maintenance windows on critical tables.

11. **`bgwriter_lru_maxpages = 0` disables the background writer entirely**[^bgwriter-maxpages]. This is rarely correct but can be useful for debugging. *Does not* disable checkpoints.

12. **Hugepages must be reserved by the kernel before Postgres starts.** With `huge_pages = on`, if the kernel hasn't reserved enough, Postgres refuses to start. With `huge_pages = try` (default), Postgres falls back to normal pages silently. Always use PG15+ `shared_memory_size_in_huge_pages` to size your `vm.nr_hugepages`.

13. **`temp_buffers` is per-backend**[^temp-buffers], not shared. A `temp_buffers = 256MB` setting on a 100-connection pool can consume 25 GB of RAM during heavy temp-table use.

14. **`temp_buffers` is frozen for the session after first temp-table use**[^temp-buffers]. Set it in `postgresql.conf` or via `ALTER ROLE ... SET temp_buffers = ...`, not from inside a session that has already created a temp table.

15. **Ring-buffer sizes are not in the user-facing docs.** The 256 KB / 16 MB / 256 KB defaults are from `src/backend/storage/buffer/freelist.c`[^buf-readme] and can change between major versions without release-note callout. Verify against the source for the major version you care about if planning around hard sizes.

16. **`pg_stat_io.op_bytes` is 8192 by default but configurable.** Always multiply by `current_setting('block_size')::int` rather than hardcoding 8192. For PG18+, prefer the new `read_bytes` / `write_bytes` / `extend_bytes` columns which require no multiplication.

17. **`pg_stat_io` does not exist before PG16**[^pg16-pgstatio]. Monitoring queries must guard with a version check or join against `pg_stat_database` for the legacy `blks_hit` / `blks_read` columns.

18. **`pg_stat_checkpointer` did not exist before PG17**[^pg17-checkpointer]. Pre-PG17 monitoring of checkpoint counts queries `pg_stat_bgwriter.checkpoints_timed` / `checkpoints_req`; PG17+ queries `pg_stat_checkpointer.num_timed` / `num_requested`. Note also the semantics: PG17+ `num_timed` includes *skipped* timeout-triggered checkpoints.

19. **`io_method` is restart-only**[^pg18-aio]. Changing `io_method` from `worker` to `io_uring` requires `ALTER SYSTEM SET io_method = 'io_uring'` followed by a server restart.

20. **`pg_aios` shows file handles, not queries**[^pg18-aio]. To map an AIO operation to a query, join against `pg_stat_activity` via `pid` and read the `query` column.

21. **High `usagecount_avg` (close to 5) means the working set is larger than `shared_buffers`.** If `pg_buffercache_usage_counts()` shows almost everything at 4 or 5, your buffers are constantly being re-accessed before clock-sweep can decrement them — raise `shared_buffers` until you see a healthy spread across usage counts.

22. **Cache hit ratio is a misleading metric.** A 99.9% hit ratio can mean "tiny working set, pool overprovisioned" or "perfect cache fit." It can also mean "a few small lookup tables dominate the metric while the actual large-table queries miss." Use `pg_stat_io` and `pg_buffercache` aggregations to make actionable decisions.

23. **Sequential scan on a table smaller than `shared_buffers / 4` does *not* use the ring buffer.** It uses the full shared pool and can evict your hot data. Either keep small tables in dedicated indexes or accept the eviction risk.

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — `BUFFER_USAGE_LIMIT`, `vacuum_buffer_usage_limit`, autovacuum write traffic in `pg_stat_io`
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — wraparound vacuum uses ring buffers and the shared pool; aggressive autovacuum and buffer pressure.
- [`33-wal.md`](./33-wal.md) — `wal_buffers` (separate from `shared_buffers`), WAL writer process
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpointer process, `checkpoint_completion_target`, `max_wal_size`, full checkpointer/`pg_stat_checkpointer` deep dive
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC contexts (postmaster vs sighup), `ALTER SYSTEM`
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `work_mem`, `maintenance_work_mem`, `effective_cache_size`, the full memory budget
- [`56-explain.md`](./56-explain.md) — reading `EXPLAIN (ANALYZE, BUFFERS)` output, `shared hit` / `read` / `dirtied` / `written`
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_io`, `pg_stat_database`, the full monitoring view catalog
- [`63-internals-architecture.md`](./63-internals-architecture.md) — process model (bgwriter, checkpointer, walwriter, walsender), shared memory regions
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_class.relfilenode`, joining `pg_buffercache` to catalogs
- [`69-extensions.md`](./69-extensions.md) — `pg_buffercache`, `pg_prewarm`, `auto_explain`

## Sources

[^shared-buffers]: PostgreSQL 16 docs, *20.4. Resource Consumption* — `shared_buffers`: *"The default is typically 128 megabytes (`128MB`), but might be less if your kernel settings will not support it (as determined during initdb)."*; *"If you have a dedicated database server with 1GB or more of RAM, a reasonable starting value for `shared_buffers` is 25% of the memory in your system. There are some workloads where even larger settings for `shared_buffers` are effective, but because PostgreSQL also relies on the operating system cache, it is unlikely that an allocation of more than 40% of RAM to `shared_buffers` will work better than a smaller amount."*; *"This parameter can only be set at server start."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^huge-pages]: PostgreSQL 16 docs, *20.4.1. Memory* — `huge_pages`: *"Controls whether huge pages are requested for the main shared memory area. Valid values are `try` (the default), `on`, and `off`. This parameter can only be set at server start."*; *"The use of huge pages results in smaller page tables and less CPU time spent on memory management, increasing performance."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^temp-buffers]: PostgreSQL 16 docs, *20.4.1. Memory* — `temp_buffers`: *"Sets the maximum amount of memory used for temporary buffers within each database session. ... The default is eight megabytes (`8MB`)."*; *"This setting can be changed within individual sessions, but only before the first use of temporary tables within the session; subsequent attempts to change the value will have no effect on that session."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^pgbuffercache]: PostgreSQL 16 docs, *F.27. pg_buffercache* — *"The `pg_buffercache` module provides a means for examining what's happening in the shared buffer cache in real time."*; the `pg_buffercache` view columns (`bufferid`, `relfilenode`, `reltablespace`, `reldatabase`, `relforknumber`, `relblocknumber`, `isdirty`, `usagecount` — *"Clock-sweep access count"* — `pinning_backends`); *"By default, use is restricted to superusers and roles with privileges of the `pg_monitor` role. Access may be granted to others using `GRANT`."* https://www.postgresql.org/docs/16/pgbuffercache.html

[^pg16-buffercache]: PostgreSQL 16 release notes — *"Add pg_buffercache function `pg_buffercache_usage_counts()` to report usage totals (Nathan Bossart)"*; *"Add pg_buffercache function `pg_buffercache_summary()` to report summarized buffer statistics (Melih Mutlu)"*. Combined with the PG16 `pg_buffercache` docs, the function signatures are: `pg_buffercache_summary() RETURNS RECORD(buffers_used int4, buffers_unused int4, buffers_dirty int4, buffers_pinned int4, usagecount_avg float8)` and `pg_buffercache_usage_counts() RETURNS SETOF RECORD(usage_count int4, buffers int4, dirty int4, pinned int4)`. https://www.postgresql.org/docs/release/16.0/ and https://www.postgresql.org/docs/16/pgbuffercache.html

[^pg17-evict]: PostgreSQL 17 release notes — *"Add pg_buffercache function `pg_buffercache_evict()` to allow shared buffer eviction (Palak Chaturvedi, Thomas Munro). This is useful for testing."* https://www.postgresql.org/docs/release/17.0/

[^buf-readme]: PostgreSQL source tree, `src/backend/storage/buffer/README` — canonical reference for the buffer manager's clock-sweep algorithm, pin/unpin protocol, content lock conventions, and BufferAccessStrategy (ring buffer) mechanics. The user-facing docs deliberately do not enumerate ring-buffer sizes or describe the pin protocol; both live here. The ring sizes (`bulkread` 256 KB, `bulkwrite` 16 MB, `vacuum` 256 KB by default) come from `src/backend/storage/buffer/freelist.c` (`GetAccessStrategy`). https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/storage/buffer/README and https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/storage/buffer/freelist.c

[^pgstatio]: PostgreSQL 16 docs, *28.2. The Cumulative Statistics System*, Table 28.23 `pg_stat_io` — column definitions including *"`bulkread`: Certain large read I/O operations done outside of shared buffers, for example, a sequential scan of a large table. `bulkwrite`: Certain large write I/O operations done outside of shared buffers, such as `COPY`. `vacuum`: I/O operations performed outside of shared buffers while vacuuming and analyzing permanent relations."*; *"`evictions`: ... In `context`s `bulkwrite`, `bulkread`, and `vacuum`, this counts the number of times a block was evicted from shared buffers in order to add the shared buffer to a separate, size-limited ring buffer for use in a bulk I/O operation."*; *"`reuses`: The number of times an existing buffer in a size-limited ring buffer outside of shared buffers was reused as part of an I/O operation in the `bulkread`, `bulkwrite`, or `vacuum` `context`s."* https://www.postgresql.org/docs/16/monitoring-stats.html

[^pg16-pgstatio]: PostgreSQL 16 release notes — *"Add system view `pg_stat_io` view to track I/O statistics (Melanie Plageman)"*. https://www.postgresql.org/docs/release/16.0/

[^pg16-buffer-usage]: PostgreSQL 16 release notes — *"Allow control of the shared buffer usage by vacuum and analyze (Melanie Plageman). The VACUUM/ANALYZE option is `BUFFER_USAGE_LIMIT`, and the vacuumdb option is `--buffer-usage-limit`. The default value is set by server variable `vacuum_buffer_usage_limit`, which also controls autovacuum."* https://www.postgresql.org/docs/release/16.0/

[^vacuum-buffer-usage]: PostgreSQL 16 docs, *20.4.1. Memory* — `vacuum_buffer_usage_limit`: *"Specifies the size of the Buffer Access Strategy used by the `VACUUM` and `ANALYZE` commands. A setting of `0` will allow the operation to use any number of `shared_buffers`. Otherwise valid sizes range from `128 kB` to `16 GB`. If the specified size would exceed 1/8 the size of `shared_buffers`, the size is silently capped to that value. The default value is `256 kB`."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^pg17-bufferusagelimit]: PostgreSQL 17 release notes — *"Increase default `vacuum_buffer_usage_limit` to 2MB"* (Thomas Munro). https://www.postgresql.org/docs/release/17.0/

[^bgwriter-delay]: PostgreSQL 16 docs, *20.4.5. Background Writer* — `bgwriter_delay`: *"Specifies the delay between activity rounds for the background writer. In each round the writer issues writes for some number of dirty buffers (controllable by the following parameters). It then sleeps for the length of `bgwriter_delay`, and repeats. When there are no dirty buffers in the buffer pool, though, it goes into a longer sleep regardless of `bgwriter_delay`."* Default `200ms`. https://www.postgresql.org/docs/16/runtime-config-resource.html

[^bgwriter-maxpages]: PostgreSQL 16 docs, *20.4.5. Background Writer* — `bgwriter_lru_maxpages`: *"In each round, no more than this many buffers will be written by the background writer. Setting this to zero disables background writing. (Note that checkpoints, which are managed by a separate, dedicated auxiliary process, are unaffected.) The default value is 100 buffers."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^bgwriter-multiplier]: PostgreSQL 16 docs, *20.4.5. Background Writer* — `bgwriter_lru_multiplier`: *"The number of dirty buffers written in each round is based on the number of new buffers that have been needed by server processes during recent rounds. The average recent need is multiplied by `bgwriter_lru_multiplier` to arrive at an estimate of the number of buffers that will be needed during the next round. Dirty buffers are written until there are that many clean, reusable buffers available. (However, no more than `bgwriter_lru_maxpages` buffers will be written per round.) Thus, a setting of 1.0 represents a 'just in time' policy of writing exactly the number of buffers predicted to be needed. Larger values provide some cushion against spikes in demand, while smaller values intentionally leave writes to be done by server processes. The default is 2.0."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^bgwriter-flush]: PostgreSQL 16 docs, *20.4.5. Background Writer* — `bgwriter_flush_after`: *"Whenever more than this amount of data has been written by the background writer, attempt to force the OS to issue these writes to the underlying storage. ... The valid range is between `0`, which disables forced writeback, and `2MB`. The default is `512kB` on Linux, `0` elsewhere."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^monitoring-stats]: PostgreSQL 16 docs, *28.2. The Cumulative Statistics System*, Table 28.24 `pg_stat_bgwriter` — 11 columns including `checkpoints_timed`, `checkpoints_req`, `checkpoint_write_time`, `checkpoint_sync_time`, `buffers_checkpoint`, `buffers_clean`, `maxwritten_clean` (*"Number of times the background writer stopped a cleaning scan because it had written too many buffers"*), `buffers_backend` (*"Number of buffers written directly by a backend"*), `buffers_backend_fsync` (*"Number of times a backend had to execute its own `fsync` call (normally the background writer handles those even when the backend does its own write)"*), `buffers_alloc` (*"Number of buffers allocated"*), `stats_reset`. https://www.postgresql.org/docs/16/monitoring-stats.html

[^pg17-checkpointer]: PostgreSQL 17 release notes — *"Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."* PG17 `pg_stat_checkpointer` columns: `num_timed` (*"Number of scheduled checkpoints due to timeout. Note that checkpoints may be skipped if the server has been idle since the last one, and this value counts both completed and skipped checkpoints"*), `num_requested`, `restartpoints_timed`, `restartpoints_req`, `restartpoints_done`, `write_time`, `sync_time`, `buffers_written`, `stats_reset`. PG17 `pg_stat_bgwriter` retains only `buffers_clean`, `maxwritten_clean`, `buffers_alloc`, `stats_reset`. https://www.postgresql.org/docs/release/17.0/ and https://www.postgresql.org/docs/17/monitoring-stats.html

[^pg16-bgwriter]: PostgreSQL 16 docs, *28.2.4. pg_stat_bgwriter View* — `buffers_backend` is *"Number of buffers written directly by a backend"*. The diagnostic interpretation that a high `buffers_backend` rate signals bgwriter saturation is community knowledge backed by the column's column description and the bgwriter description in section 20.4.5. https://www.postgresql.org/docs/16/monitoring-stats.html and https://www.postgresql.org/docs/16/runtime-config-resource.html

[^pg14-hugepagesize]: PostgreSQL 14 release notes — *"Add server parameter `huge_page_size` to control the size of huge pages used on Linux (Odin Ugedal)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-prefetch]: PostgreSQL 14 release notes — *"Allow analyze to do page prefetching (Stephen Frost) — This is controlled by `maintenance_io_concurrency`."* https://www.postgresql.org/docs/release/14.0/

[^pg14-parallel-seqscan]: PostgreSQL 14 release notes — *"Improve the I/O performance of parallel sequential scans (Thomas Munro, David Rowley) — This was done by allocating blocks in groups to parallel workers."* https://www.postgresql.org/docs/release/14.0/

[^pg14-cost-page-miss]: PostgreSQL 14 release notes — *"Reduce the default value of `vacuum_cost_page_miss` to better reflect current hardware capabilities (Peter Geoghegan)"* (lowered from 10 to 2). https://www.postgresql.org/docs/release/14.0/

[^pg14-syncfs]: PostgreSQL 14 release notes — *"Allow file system sync at the start of crash recovery on Linux (Thomas Munro) ... A new setting, `recovery_init_sync_method=syncfs`, instead syncs each filesystem used by the cluster."* https://www.postgresql.org/docs/release/14.0/

[^pg15-shmsize]: PostgreSQL 15 release notes — *"Add server variable `shared_memory_size` to report the size of allocated shared memory (Nathan Bossart)"*; *"Add server variable `shared_memory_size_in_huge_pages` to report the number of huge memory pages required (Nathan Bossart) — This is only supported on Linux."* https://www.postgresql.org/docs/release/15.0/

[^pg15-bgwriter-recovery]: PostgreSQL 15 release notes — *"Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro) — This helps to speed up long crash recoveries."* https://www.postgresql.org/docs/release/15.0/

[^pg15-log-checkpoints]: PostgreSQL 15 release notes — *"Enable default logging of checkpoints and slow autovacuum operations (Bharath Rupireddy) — This changes the default of `log_checkpoints` to `on` and that of `log_autovacuum_min_duration` to 10 minutes."* https://www.postgresql.org/docs/release/15.0/

[^pg15-recovery-prefetch]: PostgreSQL 15 release notes — *"Allow WAL processing to pre-fetch needed file contents (Thomas Munro) — This is controlled by the server variable `recovery_prefetch`."* https://www.postgresql.org/docs/release/15.0/

[^pg17-streaming]: PostgreSQL 17 release notes overview — *"Various query performance improvements, including for sequential reads using streaming I/O, write throughput under high concurrency, and searches over multiple values in a btree index."* https://www.postgresql.org/docs/release/17.0/

[^pg17-iocombine]: PostgreSQL 17 release notes — *"Allow the grouping of file system reads with the new system variable `io_combine_limit` (Thomas Munro, Andres Freund, Melanie Plageman, Nazir Bilal Yavuz)"*. https://www.postgresql.org/docs/release/17.0/

[^pg18-aio]: PostgreSQL 18 release notes — *"Add an asynchronous I/O subsystem (Andres Freund, Thomas Munro, Nazir Bilal Yavuz, Melanie Plageman). This feature allows backends to queue multiple read requests, which allows for more efficient sequential scans, bitmap heap scans, vacuums, etc. This is enabled by server variable `io_method`, with server variables `io_combine_limit` and `io_max_combine_limit` added to control it. This also enables `effective_io_concurrency` and `maintenance_io_concurrency` values greater than zero for systems without `fadvise()` support. The new system view `pg_aios` shows the file handles being used for asynchronous I/O."*; *"Increase server variables `effective_io_concurrency`'s and `maintenance_io_concurrency`'s default values to 16 (Melanie Plageman). This more accurately reflects modern hardware."*; *"`pg_stat_io` columns expanded to report I/O activity in bytes with new columns: `read_bytes`, `write_bytes`, and `extend_bytes` (Nazir Bilal Yavuz)"*; *"WAL I/O activity rows added to `pg_stat_io` (Nazir Bilal Yavuz, Bertrand Drouvot, Michael Paquier)"*; *"Per-backend I/O statistics via `pg_stat_get_backend_io()` (Bertrand Drouvot)"*. https://www.postgresql.org/docs/release/18.0/

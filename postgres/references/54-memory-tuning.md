# Memory Tuning

How PostgreSQL spends RAM, how much of it each GUC controls, and the per-backend vs shared distinction that drives every sizing decision. Pair this file with [`53-server-configuration.md`](./53-server-configuration.md) (the GUC mechanism) and [`32-buffer-manager.md`](./32-buffer-manager.md) (`shared_buffers` mechanics).


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Decision Matrix](#decision-matrix)
    - [The Two-Pool Model](#the-two-pool-model)
    - [`shared_buffers`](#shared_buffers)
    - [`effective_cache_size`](#effective_cache_size)
    - [`work_mem` and the Per-Node Trap](#work_mem-and-the-per-node-trap)
    - [`hash_mem_multiplier` (PG13+)](#hash_mem_multiplier-pg13)
    - [`maintenance_work_mem` and the PG17 Cap Removal](#maintenance_work_mem-and-the-pg17-cap-removal)
    - [`autovacuum_work_mem`](#autovacuum_work_mem)
    - [`temp_buffers`](#temp_buffers)
    - [`wal_buffers`](#wal_buffers)
    - [`logical_decoding_work_mem` (PG13+)](#logical_decoding_work_mem-pg13)
    - [`vacuum_buffer_usage_limit` (PG16+)](#vacuum_buffer_usage_limit-pg16)
    - [`min_dynamic_shared_memory` (PG14+)](#min_dynamic_shared_memory-pg14)
    - [Shared Memory Introspection (PG15+)](#shared-memory-introspection-pg15)
    - [Linux Huge Pages](#linux-huge-pages)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Open this file when:

- Sizing memory for a new cluster or capacity-planning an existing one.
- Diagnosing OOM kills, `out of memory` errors, or unexpected swap usage.
- Tuning `work_mem` for analytics vs OLTP workloads.
- Configuring huge pages on Linux.
- Upgrading to PG17+ and adjusting `maintenance_work_mem` now that the 1 GB silent cap on VACUUM is gone.
- Adjusting per-role memory budgets via `ALTER ROLE SET work_mem = ...`.

For the buffer-pool mechanics (clock-sweep, ring buffers, pinning) see [`32-buffer-manager.md`](./32-buffer-manager.md). For autovacuum-specific memory considerations see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md). For WAL-buffer mechanics see [`33-wal.md`](./33-wal.md).


## Mental Model

Five rules to keep:

1. **`shared_buffers` is fixed-size shared cache; everything else is per-backend or per-operation.** The docs recommend ~25% of system RAM as a starting value with the verbatim caveat *"it is unlikely that an allocation of more than 40% of RAM to `shared_buffers` will work better than a smaller amount."*[^shbuf-pg16] Server-start-only — context = `postmaster`.

2. **`work_mem` is a per-operation base limit, not a per-query or per-session budget.** A query can have several concurrent sort or hash operations; hash limits use `work_mem × hash_mem_multiplier`, and parallel workers can multiply memory use. Actual allocations depend on the plan and workload.[^workmem]

3. **`maintenance_work_mem` bounds maintenance memory, and PG17 removed VACUUM's 1 GB dead-tuple identifier limit.** On PG16 and earlier, only that identifier collection is capped at 1 GB; the setting is not necessarily reserved in full. Size it for the workload and available memory.[^pg17-mwm]

4. **`effective_cache_size` is a planner hint, not an allocation.** Docs: *"Sets the planner's assumption about the effective size of the disk cache that is available to a single query."*[^ecs] Set it to a realistic estimate of OS page cache + `shared_buffers`. The planner uses it to bias index scans vs sequential scans. No memory is reserved.

5. **`hash_mem_multiplier` defaults to 2.0 since PG15.** Hash operations get `work_mem × hash_mem_multiplier` (= 8 MB by default on PG15+). The asymmetry exists because spilling hashes to temp files is dramatically slower than spilling sorts; giving hashes a larger budget reduces spills.[^pg15-hash] On PG13/PG14 the default was 1.0 — if you upgraded from PG14, the effective work_mem-for-hashes doubled silently.


> [!WARNING] PG18 did NOT change `work_mem` or `shared_buffers` defaults
> A common upgrade question is "did PG18 improve memory tuning?" PG18 added the async I/O subsystem (`io_method`, `io_workers`, `io_combine_limit`, `pg_aios`)[^pg18-aio] and raised `effective_io_concurrency` / `maintenance_io_concurrency` defaults from 1 to 16[^pg18-eio]. The core memory-sizing GUCs (`shared_buffers` default 128 MB, `work_mem` default 4 MB, `maintenance_work_mem` default 64 MB, `hash_mem_multiplier` default 2.0) are unchanged from PG15/PG16/PG17.


## Syntax / Mechanics


### Decision Matrix

| You want to ... | Set / inspect | Avoid | Why |
|---|---|---|---|
| Allocate buffer pool to host RAM | `shared_buffers` = 25 % RAM (server-start) | Setting > 40 % RAM | Verbatim docs: *"unlikely that an allocation of more than 40% of RAM ... will work better."*[^shbuf-pg16] |
| Tell the planner about OS cache | `effective_cache_size` = ~50–70 % RAM | Leaving at default 4 GB | Default is far below reality; planner under-uses indexes |
| Size sorts and hashes for OLTP | `work_mem` = 4–16 MB | Cluster-wide `work_mem` >= 256 MB | Per-node × per-backend × parallel-workers ⇒ blow up |
| Size sorts and hashes for analytics | `ALTER ROLE reporter SET work_mem = '256MB'` | Cluster-wide hike | Per-role override scopes risk to one workload |
| Make hash joins less spill-happy | `hash_mem_multiplier` = 2.0 (default PG15+) or higher | Setting > 4.0 cluster-wide | Hash bias is intentional; raise per-role for analytics |
| Speed manual VACUUM (PG17+) | `SET maintenance_work_mem = '4GB'` inside session | Cluster-wide bump that also affects every CREATE INDEX | PG17 lifted the 1 GB cap for vacuum specifically[^pg17-mwm] |
| Speed CREATE INDEX | `SET maintenance_work_mem = '2GB'` for the session | Permanent cluster-wide raise | One-off ops should be SET LOCAL or SET in the session |
| Size autovacuum workers | Set `autovacuum_work_mem` explicitly | Assuming a high `maintenance_work_mem` has no autovacuum effect | With `-1`, each worker uses the maintenance limit; concurrent workers can multiply memory demand[^mwm-warning] |
| Bound logical decoding memory | `logical_decoding_work_mem` per-walsender | Default 64 MB on busy publishers | Larger value = less disk spill for big transactions |
| Constrain VACUUM's buffer pool footprint | `vacuum_buffer_usage_limit` (PG16+) | Setting `0` (uses all of shared_buffers) | Default protects working set during maintenance |
| Enable huge pages on Linux | `vm.nr_hugepages` via sysctl + `huge_pages = on` | `huge_pages = on` without sysctl reservation | Server fails to start if pages aren't pre-reserved[^kernel] |
| Inspect shared-memory total | PG15+: `SHOW shared_memory_size;` | Manual math from `shared_buffers` × N | Includes WAL buffers + locks + procarray + extension areas[^pg15-shmem] |

**Three smell signals that memory is wrong:**

1. **`temp_files` and `temp_bytes` in `pg_stat_database` are climbing** — sorts/hashes are spilling. Either raise `work_mem` for the offending workload (per-role) or add indexes to remove the sort step.
2. **`SET maintenance_work_mem = '4GB'` produces the same VACUUM duration as `'1GB'` on PG16** — you're seeing the silent 1 GB cap. Upgrade to PG17 or accept the cap.
3. **`OOM-killer` killing the postmaster or backends** — likely `work_mem × max_connections × parallel_workers` exceeds RAM. The kernel doesn't know about Postgres's per-node multiplication.


### The Two-Pool Model

PostgreSQL memory splits into:

- **Shared memory** — allocated once at postmaster start, fixed size, used by all backends. Components: `shared_buffers`, WAL buffers, lock tables, predicate-lock tables, MultiXact / subxid / notify / serializable SLRUs, `min_dynamic_shared_memory` for parallel-query DSM, extension regions.
- **Per-backend (private) memory** — allocated lazily by each backend connection. Components: `work_mem` per sort/hash/aggregate node, `temp_buffers` per session (after first use), `maintenance_work_mem` per maintenance operation, query plans, parser state, libpq buffers, OS stack.

> [!NOTE] PostgreSQL 15: `shared_memory_size` introspection
> Verbatim release-note: *"Add server variable `shared_memory_size` to report the size of allocated shared memory ... Add server variable `shared_memory_size_in_huge_pages` to report the number of huge memory pages required (Linux only)."*[^pg15-shmem] Query with `SHOW shared_memory_size;` — gives you the total without manually summing GUCs.

Capacity planning must account for shared memory, concurrent per-operation allocations, parallel workers and leader participation, autovacuum workers, temporary buffers, other backend memory, and the OS. `work_mem` is allocated as needed; hash operations can use `work_mem × hash_mem_multiplier`. Different plan nodes need not be active simultaneously, and shared parallel operations need not allocate a full copy per process. Model representative worst-case concurrency rather than treating a single multiplication as a hard upper bound.[^workmem]


### `shared_buffers`

Verbatim docs: *"Sets the amount of memory the database server uses for shared memory buffers. The default is typically 128 megabytes (128MB)."*[^shbuf-pg16] Context: `postmaster` (server-start only). Unit: 8 kB blocks (but accepts size suffixes).

Practical-sizing tiers:

| Host RAM | `shared_buffers` starting value | Notes |
|---|---|---|
| 4 GB | 1 GB | Default 128 MB is far too small for any production workload |
| 16 GB | 4 GB | 25 % rule |
| 64 GB | 16 GB | 25 % rule |
| 256 GB | 32–64 GB | Diminishing returns past ~32 GB; community lore (not docs) caps it there |
| 1 TB | 64–128 GB | Same diminishing-returns rule; verify with `pg_buffercache_usage_counts()` (PG16+) |

The 32 GB practical ceiling above is **community lore, not the docs.** The official statement is the 40 % rule. The reason past ~32 GB the wins flatten: at that size you've cached the working set, and additional space caches cold data that the OS would cache anyway.

The 25% figure is a starting point, not a reservation rule. Leave memory for the OS cache, concurrent operations, and other processes, and measure the workload.

> [!WARNING] `shared_buffers` is server-start-only
> Changing requires a restart, not a SIGHUP reload. Plan the change with a maintenance window or rolling-failover plan. Context column in `pg_settings` says `postmaster`.


### `effective_cache_size`

Verbatim docs: *"Sets the planner's assumption about the effective size of the disk cache that is available to a single query."*[^ecs] Default: 4 GB. **No memory is reserved** — it is a planner hint only.

Set this to a realistic estimate of `shared_buffers + free RAM + OS page cache`. On a 64 GB host with 16 GB `shared_buffers`, a starting value of 48 GB is reasonable.

Effect on plans: higher values bias the planner toward **index scans** (it assumes repeat reads will hit cache); lower values bias toward **sequential scans**. The default 4 GB is far below modern realities and routinely produces seq-scan plans where index scans would win.

Context: `user`. Can be set per-session, per-role, per-database.


### `work_mem` and the Per-Node Trap

Verbatim docs: *"Sets the base maximum amount of memory to be used by a query operation (such as a sort or hash table) before writing to temporary disk files. ... Note that for a complex query, several sort or hash operations might be running in parallel; each operation will generally be allowed to use as much memory as this value specifies before it starts to write data into temporary files. Also, several running sessions could be doing such operations concurrently."*[^workmem] Default: 4 MB. Context: `user`.

For example, multiple hash joins, a sort, and a hash aggregate can each consume memory during execution. Hash operations may each use `work_mem × hash_mem_multiplier`, and parallel execution can multiply allocations across processes. Inspect the actual plan and concurrency instead of assuming a fixed number of nodes or a universal upper bound.

> [!WARNING] Setting cluster-wide `work_mem` high is a footgun
> As an illustration, 100 concurrent sessions, three simultaneous sort operations per session, and two participating processes per operation at `work_mem = 256MB` imply about 150 GB of sort budgets. Actual usage can be lower or higher, especially with hash operations. Per-role overrides can scope this risk:
>
>     ALTER ROLE reporter SET work_mem = '256MB';
>     ALTER ROLE webapp SET work_mem = '8MB';
>
> So that only the reporter role (with few connections) gets the large budget.

`work_mem` sizing rule of thumb: start with `(total RAM × 0.25) / max_connections / typical-parallel-workers / 3-or-so-nodes-per-query` and round down. For 64 GB / 200 connections / 2 parallel / 3 nodes → ~13 MB. Most OLTP clusters do well at 4–16 MB.

`temp_files` and `temp_bytes` columns in `pg_stat_database` track spill activity. Rising values mean some queries would benefit from a larger `work_mem`.


### `hash_mem_multiplier` (PG13+)

Verbatim docs: *"Used to compute the maximum amount of memory that hash-based operations can use. The final limit is determined by multiplying `work_mem` by `hash_mem_multiplier`. The default value is 2.0, which makes hash-based operations use twice the usual `work_mem` base amount."*[^hashmem]

> [!NOTE] PostgreSQL 13 introduced `hash_mem_multiplier`
> Default was 1.0 initially.

> [!NOTE] PostgreSQL 15 raised the default to 2.0
> Verbatim release-note: *"Increase `hash_mem_multiplier` default to 2.0 (Peter Geoghegan) ... This allows query hash operations to use more `work_mem` memory than other operations."*[^pg15-hash]

The asymmetry is intentional: hash spills are dramatically slower than sort spills because the spilled data must be replayed multiple times for partitioning. Giving hashes 2× the budget reduces this without making sorts wasteful.

For analytics-heavy workloads, raising `hash_mem_multiplier` per-role to 3.0 or 4.0 is reasonable. Cluster-wide values above 4.0 are rare and should be measured.

Effective limit for a hash node = `work_mem × hash_mem_multiplier`. At default (4 MB × 2.0) = 8 MB.


### `maintenance_work_mem` and the PG17 Cap Removal

Verbatim docs: *"Specifies the maximum amount of memory to be used by maintenance operations, such as `VACUUM`, `CREATE INDEX`, and `ALTER TABLE ADD FOREIGN KEY`."*[^mwm] Default: 64 MB. Context: `user`.

> [!NOTE] PostgreSQL 17 removed the 1 GB silent cap for VACUUM
> Verbatim release-note: *"Additionally, vacuum is no longer silently limited to one gigabyte of memory when `maintenance_work_mem` or `autovacuum_work_mem` are higher."*[^pg17-mwm] Pre-PG17 vacuum's dead-tuple TID array was an array structure capped at 1 GB regardless of `maintenance_work_mem`. PG17's radix-tree TID store (see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)) removed this. `CREATE INDEX` and `ALTER TABLE ADD FOREIGN KEY` never had the cap.

Practical sizing:

| Operation | Recommended setting | Notes |
|---|---|---|
| Cluster-wide default | 64 MB – 256 MB | Conservative because of `autovacuum_max_workers` multiplication |
| One-off CREATE INDEX | 1–4 GB (SET in session) | Index build is bounded by memory; more = fewer external sort passes |
| One-off VACUUM on PG17+ | 4–16 GB (SET in session) | Cap is gone; large vacuums benefit dramatically |
| One-off VACUUM on PG≤16 | Up to 1 GB for dead-tuple identifiers | This limit applies to identifier collection, not an upfront reservation of the setting |
| CREATE INDEX CONCURRENTLY | Same as CREATE INDEX | Memory split between two phases |

> [!WARNING] Autovacuum workers multiply memory demand
> Each concurrent autovacuum worker can allocate up to its applicable maintenance limit, subject to operation-specific limits. With `autovacuum_work_mem = -1`, the applicable setting is `maintenance_work_mem`; set it explicitly to decouple the two.[^mwm-warning]


### `autovacuum_work_mem`

Verbatim docs: *"Specifies the maximum amount of memory to be used by each autovacuum worker process. ... The default value is `-1`, indicating that the value of `maintenance_work_mem` should be used instead."*[^avwm] Default: -1. Context: `sighup`.

The decoupling pattern: set `maintenance_work_mem` to a generous interactive value (1–4 GB) and `autovacuum_work_mem` to a smaller value (256 MB – 1 GB) so that:

- Manual `VACUUM`, `CREATE INDEX`, and FK-validation get the high budget
- Autovacuum workers (which run continuously and concurrently) use the lower budget

```
maintenance_work_mem = 1GB        # for interactive ops
autovacuum_work_mem = 256MB       # for autovacuum workers
autovacuum_max_workers = 3        # default
# Illustrative configured worker budgets: 3 × 256MB = 768MB
```

`autovacuum_work_mem` is `sighup` context — reload picks it up, no restart needed. But existing autovacuum workers keep their old value until they finish.


### `temp_buffers`

Verbatim docs: *"Sets the maximum amount of memory used for temporary buffers within each database session. ... A session will allocate temporary buffers as needed up to the limit given by `temp_buffers`."*[^tempbuf] Default: 8 MB. Context: `user`, but with a quirk.

The quirk: **`temp_buffers` is frozen for a session after the first temp table is accessed.** Verbatim: *"The setting can be changed within individual sessions, but only before the first use of temporary tables within the session; subsequent attempts to change the value will have no effect on that session."* Pattern: `SET temp_buffers = '64MB'` must be issued before the first `CREATE TEMP TABLE` or first reference to one.

`temp_buffers` is private per-session and never goes to disk except as required. Heavy temp-table workloads (e.g., ETL with many `CREATE TEMP TABLE ... AS SELECT`) benefit from `temp_buffers = 64 MB` or more.


### `wal_buffers`

Verbatim docs: *"The amount of shared memory used for WAL data that has not yet been written to disk. The default setting of -1 selects a size equal to 1/32nd (about 3%) of `shared_buffers`, but not less than 64kB nor more than the size of one WAL segment, typically 16MB."*[^walbuf] Default: -1 (auto). Context: `postmaster`.

The auto-sizing is correct for most workloads. The only reason to override is on very write-heavy clusters where `shared_buffers` is huge (≥ 512 MB) — at 1/32, `wal_buffers` is already capped at 16 MB, and that cap is fine. Explicitly setting `wal_buffers = 16MB` makes the value visible and stable across `shared_buffers` changes.

The one-segment cap applies only to automatic sizing. Explicit settings can exceed it; measure whether a larger allocation helps the workload.[^walbuf]

Context = `postmaster`: requires restart.


### `logical_decoding_work_mem` (PG13+)

Verbatim docs: *"Specifies the maximum amount of memory to be used by logical decoding, before some of the decoded changes are written to local disk."*[^ldwm] Default: 64 MB. Context: `user`, settable per-walsender.

Logical decoding buffers transaction changes in memory until either the transaction commits (at which point changes are streamed to the subscriber) or memory pressure forces a spill to disk. Larger values reduce disk spilling for big transactions; smaller values reduce memory commitment on busy publishers.

> [!NOTE] PostgreSQL 14: streaming of in-progress transactions
> Pre-PG14: transactions exceeding `logical_decoding_work_mem` always spilled to disk and were only delivered at commit time. PG14 added streaming via `STREAM_IN_PROGRESS_TRANSACTIONS` option, so changes can be streamed before commit if the subscriber supports it.

For bulk transactions, consider a larger per-logical-decoding budget after measuring spills and concurrent decoding memory use. The setting is a limit, not an upfront reservation.


### `vacuum_buffer_usage_limit` (PG16+)

Verbatim docs: *"Specifies the size of the Buffer Access Strategy used by the `VACUUM` and `ANALYZE` commands. A setting of `0` will allow the operation to use any number of `shared_buffers`. Otherwise valid sizes range from `128 kB` to `16 GB`."*[^vbul] Context: `user`.

| Version | Default |
|---|---|
| PG16 | 256 kB |
| PG17+ | **2 MB**[^pg17-vbul-default] |

> [!NOTE] PostgreSQL 17 raised the default
> Verbatim release-note: *"Increase default `vacuum_buffer_usage_limit` to 2MB (Thomas Munro)."*[^pg17-vbul-default] PG16 readers who carry their config forward without changing this GUC will see different behavior on PG17 even with the same explicit value (because the default-comparison baseline changed for monitoring queries).

The setting controls VACUUM's ring-buffer size so that a big vacuum doesn't sweep `shared_buffers` clean of legitimate working-set pages. Setting `0` disables the ring buffer; vacuum can use any of `shared_buffers`. Per-table override via `VACUUM (BUFFER_USAGE_LIMIT '16MB') tablename;` is available in PG16+.

The PG16 release note: *"Allow control of the shared buffer usage by vacuum and analyze (Melanie Plageman) ... The VACUUM/ANALYZE option is `BUFFER_USAGE_LIMIT`, and the vacuumdb option is `--buffer-usage-limit`. The default value is set by server variable `vacuum_buffer_usage_limit`, which also controls autovacuum."*[^pg16-vbul-intro]


### `min_dynamic_shared_memory` (PG14+)

Verbatim docs: *"Specifies the amount of memory that should be allocated at server startup for use by parallel queries."*[^mindsm] Default: 0. Context: `postmaster`.

> [!NOTE] PostgreSQL 14 introduction
> Verbatim release-note: *"Allow startup allocation of dynamic shared memory (Thomas Munro) ... This is controlled by `min_dynamic_shared_memory`. This allows more use of huge pages."*[^pg14-mindsm]

Most parallel queries allocate small DSM segments via the platform's preferred `dynamic_shared_memory_type` (typically POSIX shm or System V shm). With `min_dynamic_shared_memory > 0`, the postmaster pre-allocates that much memory inside the main shared-memory region, which makes it eligible for huge pages.

Practical setting: zero by default, raise to 256 MB or 512 MB if huge pages are configured AND parallel queries are common AND you want to ensure parallel DSM benefits from huge pages.


### Shared Memory Introspection (PG15+)

PG15 added two read-only GUCs for capacity planning:

| GUC | Reports |
|---|---|
| `shared_memory_size` | Total bytes of shared memory allocated by the postmaster. Includes `shared_buffers`, `wal_buffers`, locks, sinval, procarray, SLRU buffers, extension areas. |
| `shared_memory_size_in_huge_pages` | Number of huge pages required (Linux-only). Use this value for `vm.nr_hugepages` sysctl reservation. |

Query (no superuser needed):

```sql
SHOW shared_memory_size;
SHOW shared_memory_size_in_huge_pages;
```

The pre-flight workflow for huge-pages setup on PG15+:

```bash
# Postgres tells you how many huge pages it needs without starting:
postgres -D /var/lib/postgres/data -C shared_memory_size_in_huge_pages

# Reserve them:
echo 8192 | sudo tee /proc/sys/vm/nr_hugepages
# Or persistently:
echo 'vm.nr_hugepages = 8192' | sudo tee /etc/sysctl.d/40-postgres-hugepages.conf
sudo sysctl --system
```


### Linux Huge Pages

Verbatim from kernel-resources docs: *"Using huge pages reduces overhead when using large contiguous chunks of memory, as PostgreSQL does, particularly when using large values of `shared_buffers`."*[^kernel] Kernel requirement: *"a kernel with `CONFIG_HUGETLBFS=y` and `CONFIG_HUGETLB_PAGE=y`."*

Three settings:

| GUC | Values | Effect |
|---|---|---|
| `huge_pages` | `try` (default), `on`, `off` | `try`: use if available, fall back to normal pages. `on`: refuse to start if not available. `off`: never use. |
| `huge_page_size` | Default `0` (system default) | Override the page size. Most Linux systems support 2 MB (common) and 1 GB pages. Server-start only.[^pg14-hps] |
| `vm.nr_hugepages` | sysctl (kernel) | Number of huge pages reserved at boot. Set via sysctl before starting Postgres if `huge_pages = on`. |

> [!NOTE] PostgreSQL 14 introduced `huge_page_size`
> Verbatim release-note: *"Add server parameter `huge_page_size` to control the size of huge pages used on Linux (Odin Ugedal)."*[^pg14-hps]

> [!WARNING] `huge_pages = on` fails startup if pages aren't pre-reserved
> Verbatim docs: *"Note that with this setting PostgreSQL will fail to start if not enough huge pages are available."*[^kernel] For production: use `try` until you've measured the benefit and confirmed sysctl reservation works correctly.

Transparent huge pages (THP) are different from explicit huge pages. THP is dynamic kernel coalescing and is widely recommended to be disabled (`echo never > /sys/kernel/mm/transparent_hugepage/enabled`) for Postgres because of latency spikes during THP defragmentation. Explicit huge pages (via `vm.nr_hugepages` + `huge_pages = on/try`) are recommended on `shared_buffers > 8 GB`.


### Per-Version Timeline

| Version | Changes | Notes |
|---|---|---|
| **PG13** | `hash_mem_multiplier` introduced (default 1.0)[^pg13-hash]; `maintenance_io_concurrency` for prefetch[^pg13-mio] | Initial multiplier was conservative |
| **PG14** | `huge_page_size` GUC[^pg14-hps]; `min_dynamic_shared_memory`[^pg14-mindsm]; `logical_decoding_work_mem` streaming behavior expanded[^pg14-ld]; ANALYZE can use prefetch[^pg14-ana] | No `work_mem` / `shared_buffers` default changes |
| **PG15** | `shared_memory_size` + `shared_memory_size_in_huge_pages` introspection[^pg15-shmem]; `hash_mem_multiplier` default raised 1.0 → 2.0[^pg15-hash] | Single largest tuning-default change in this range |
| **PG16** | `vacuum_buffer_usage_limit` GUC + `BUFFER_USAGE_LIMIT` VACUUM/ANALYZE option (default 256 kB)[^pg16-vbul-intro]; no `work_mem` / `shared_buffers` / `maintenance_work_mem` changes | |
| **PG17** | `maintenance_work_mem` 1 GB silent cap removed for vacuum[^pg17-mwm]; `vacuum_buffer_usage_limit` default raised 256 kB → 2 MB[^pg17-vbul-default]; `io_combine_limit` GUC[^pg17-io] | The most impactful release for memory-tuning since PG13 |
| **PG18** | Async I/O subsystem (`io_method`, `io_workers`, `io_combine_limit`, `io_max_combine_limit`, `pg_aios`)[^pg18-aio]; `effective_io_concurrency` / `maintenance_io_concurrency` defaults 1 → 16[^pg18-eio]; no `work_mem` / `shared_buffers` / `maintenance_work_mem` changes | Memory-sizing surface unchanged; only I/O parallelism defaults |
| **PG19** (RC) | `io_workers` removed; replaced by `io_min_workers` (2), `io_max_workers` (8), `io_worker_idle_timeout` (1 minute), `io_worker_launch_interval` (100ms)[^pg19-io-workers-54] | Single worker count replaced by min/max settings |


## Examples / Recipes


### Recipe 1: Baseline `postgresql.conf` for a 64 GB OLTP cluster

```ini
# Memory sizing — 64 GB host running a typical OLTP workload
# with ~200 max_connections and ~3 nodes per query on average

# Shared memory (postmaster context, requires restart)
shared_buffers = 16GB                   # 25% of RAM
huge_pages = try                        # Use huge pages if reserved; fall back gracefully
wal_buffers = 16MB                      # Explicit value; auto also picks this here
min_dynamic_shared_memory = 0           # Default; raise if heavy parallel + huge pages

# Planner hint (no allocation; user context)
effective_cache_size = 48GB             # shared_buffers + OS page cache estimate

# Per-backend memory (user context — apply per-role for differentiation)
work_mem = 16MB                         # Per-operation base; hash and parallelism multiply demand
hash_mem_multiplier = 2.0               # Default since PG15; explicit for clarity
temp_buffers = 8MB                      # Default; raise per-session for ETL

# Maintenance memory (user context for manual ops; sighup for autovacuum)
maintenance_work_mem = 1GB              # Generous for interactive CREATE INDEX / VACUUM
autovacuum_work_mem = 256MB             # Decouple from MWM; 3 workers × 256MB = 768MB cap

# Vacuum buffer strategy (PG16+)
vacuum_buffer_usage_limit = 2MB         # PG17+ default; explicit for portability

# Logical decoding (only matters if you run logical replication)
logical_decoding_work_mem = 64MB        # Default; raise on busy publishers

# Connections
max_connections = 200                   # Pair with a pooler in production
```

Pair with per-role overrides (Recipe 5).


### Recipe 2: Pre-flight huge-pages setup on Linux (PG15+)

```bash
# 1. Build the postgresql.conf with your shared_buffers target but DON'T start Postgres yet
# 2. Use the offline -C flag to read shared_memory_size_in_huge_pages

sudo -u postgres /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main \
  -C shared_memory_size_in_huge_pages

# Output: e.g., 8400

# 3. Reserve huge pages persistently (add ~5% buffer for slop):
echo 'vm.nr_hugepages = 8820' | sudo tee /etc/sysctl.d/40-postgres-hugepages.conf
sudo sysctl --system

# 4. Verify the reservation took
grep HugePages /proc/meminfo
# HugePages_Total:    8820
# HugePages_Free:     8820

# 5. Edit postgresql.conf: huge_pages = on
# 6. Restart Postgres
# 7. Verify Postgres is actually using them:
psql -c "SHOW huge_pages_status;"      # PG17+: returns 'on' / 'off' / 'unknown'
grep HugePages_Free /proc/meminfo       # Should drop after Postgres starts
```


### Recipe 3: Per-role `work_mem` differentiation

Continuing the iteration-41/42/46 per-role baseline convention — set tight defaults cluster-wide, generous per-role for analytics:

```sql
-- Tight cluster-wide default (in postgresql.conf):
-- work_mem = 8MB
-- hash_mem_multiplier = 2.0

-- Analytics role: large sorts and hashes welcome
ALTER ROLE reporter SET work_mem = '256MB';
ALTER ROLE reporter SET hash_mem_multiplier = '4.0';

-- Batch / ETL role: very large operations
ALTER ROLE batchjobs SET work_mem = '512MB';
ALTER ROLE batchjobs SET hash_mem_multiplier = '3.0';
ALTER ROLE batchjobs SET maintenance_work_mem = '2GB';

-- Webapp role: tight to protect against runaway queries
ALTER ROLE webapp SET work_mem = '8MB';
-- hash_mem_multiplier inherits default

-- Verify:
SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('reporter', 'batchjobs', 'webapp');
```

Cross-reference: per-role GUCs do **not** propagate across pgBouncer transaction-mode pools (see [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6).


### Recipe 4: One-off `CREATE INDEX` with a session-scoped `SET`

> [!WARNING] `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
> `CREATE INDEX CONCURRENTLY` raises `ERROR 25001: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. Do **not** wrap it in `BEGIN … COMMIT` or use `SET LOCAL` (which requires a transaction). Use a plain session-level `SET` instead, then `RESET` after.

```sql
-- Correct form: session-level SET, no transaction block
SET maintenance_work_mem = '4GB';
CREATE INDEX CONCURRENTLY idx_events_by_user_time
  ON events (user_id, created_at)
  WHERE deleted_at IS NULL;
RESET maintenance_work_mem;
```

The session-level `SET` reverts at disconnect or on explicit `RESET`. The 4 GB budget speeds up the index build significantly when the table is large enough that the default 64 MB would force many external sort passes.

For a regular (non-concurrent) `CREATE INDEX` inside a transaction, `SET LOCAL` is valid:

```sql
BEGIN;
SET LOCAL maintenance_work_mem = '4GB';
CREATE INDEX idx_events_by_user_time
  ON events (user_id, created_at)
  WHERE deleted_at IS NULL;
COMMIT;
```


### Recipe 5: Diagnose `work_mem` spills via `pg_stat_database`

```sql
SELECT
  datname,
  temp_files,
  pg_size_pretty(temp_bytes) AS temp_bytes,
  pg_size_pretty(temp_bytes / NULLIF(temp_files, 0)) AS avg_temp_file_size,
  stats_reset
FROM pg_stat_database
WHERE datname NOT LIKE 'template%'
ORDER BY temp_bytes DESC;
```

Interpretation:

- Zero counters mean no tracked temporary files since the statistics reset, not proof that `work_mem` is adequate.
- Rising counters indicate temporary-file activity, which can have causes other than sort/hash spills. File size alone does not identify a suitable `work_mem`.
- Use per-query statistics and execution plans to identify the operation before tuning.

Per-query spill detection via `EXPLAIN`:

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... FROM big_table ORDER BY some_col;
-- Look for: "Sort Method: external merge  Disk: ..."
-- Or:       "Hash join: ... Batches: 4 ..."  (Batches > 1 means it spilled)
```


### Recipe 6: PG17+ — high-memory VACUUM on a 500 GB table

```sql
-- PG17+ removed the 1 GB cap; this is now actually useful:
SET maintenance_work_mem = '8GB';
SET vacuum_buffer_usage_limit = 0;       -- Disable ring buffer for this one-off
VACUUM (VERBOSE, PARALLEL 4) big_table;
RESET maintenance_work_mem;
RESET vacuum_buffer_usage_limit;
```

PG17 removed the 1 GB dead-tuple-identifier limit.[^pg17-mwm] A larger budget can reduce repeated index passes when identifier storage was the bottleneck; measure the workload. Earlier releases did not reserve the unused portion of a larger setting.


### Recipe 7: Audit memory-related GUCs

```sql
SELECT name, setting, unit, context, source,
       CASE WHEN reset_val = boot_val THEN 'default' ELSE 'overridden' END AS state
FROM pg_settings
WHERE name IN (
  'shared_buffers', 'huge_pages', 'huge_page_size',
  'effective_cache_size',
  'work_mem', 'hash_mem_multiplier',
  'maintenance_work_mem', 'autovacuum_work_mem',
  'temp_buffers', 'wal_buffers',
  'logical_decoding_work_mem',
  'vacuum_buffer_usage_limit',
  'min_dynamic_shared_memory',
  'shared_memory_size', 'shared_memory_size_in_huge_pages'
)
ORDER BY context, name;
```

Cross-reference: [`53-server-configuration.md`](./53-server-configuration.md) for `pg_settings.context` interpretation and [`64-system-catalogs.md`](./64-system-catalogs.md) for `pg_settings` schema.


### Recipe 8: Illustrate a memory sizing scenario

This illustrative calculation assumes standard 8 kB blocks and a hypothetical number of active operations. It is not a worst-case bound:

```sql
WITH cfg AS (
  SELECT
    (SELECT setting::bigint * 8192 FROM pg_settings WHERE name = 'shared_buffers') AS shared_buffers,
    (SELECT setting::bigint * 1024 FROM pg_settings WHERE name = 'work_mem') AS work_mem,
    (SELECT setting::bigint * 1024 FROM pg_settings WHERE name = 'maintenance_work_mem') AS maintenance_work_mem,
    (SELECT setting::bigint FROM pg_settings WHERE name = 'autovacuum_work_mem') AS autovacuum_work_mem_kb,
    (SELECT setting::bigint FROM pg_settings WHERE name = 'max_connections') AS max_connections,
    (SELECT setting::bigint FROM pg_settings WHERE name = 'autovacuum_max_workers') AS av_workers,
    (SELECT setting::numeric FROM pg_settings WHERE name = 'hash_mem_multiplier') AS hash_mult
)
SELECT
  pg_size_pretty(shared_buffers) AS shared_buffers,
  pg_size_pretty(max_connections * work_mem * 3) AS work_mem_typical,
  pg_size_pretty((max_connections * work_mem * 5 * hash_mult)::bigint) AS five_hash_operations,
  pg_size_pretty(av_workers * CASE WHEN autovacuum_work_mem_kb = -1 THEN maintenance_work_mem ELSE autovacuum_work_mem_kb * 1024 END) AS autovacuum_budget,
  pg_size_pretty(
    shared_buffers
    + (max_connections * work_mem * 3)
    + (av_workers * CASE WHEN autovacuum_work_mem_kb = -1 THEN maintenance_work_mem ELSE autovacuum_work_mem_kb * 1024 END)
  ) AS rough_total
FROM cfg;
```

These are illustrative scenarios, not upper bounds. Actual plans, worker participation, hash multipliers, maintenance operations, and concurrent sessions may produce higher or lower usage. The autovacuum term uses `maintenance_work_mem` only when `autovacuum_work_mem = -1`.


### Recipe 9: Inspect shared-memory composition (PG15+)

```sql
-- Total shared memory
SHOW shared_memory_size;
-- e.g., "16412 MB" — includes shared_buffers + WAL buffers + locks + SLRUs + extension areas

-- Pages needed for huge-page sysctl (Linux)
SHOW shared_memory_size_in_huge_pages;
-- e.g., "8206"  — multiply by huge_page_size (default 2 MB) to get total bytes

-- Compare to shared_buffers alone
SHOW shared_buffers;
-- e.g., "16384MB"
-- Difference (~28 MB in this example) = WAL buffers + locks + SLRUs + ProcArray + ...
```


### Recipe 10: Decouple autovacuum memory from `maintenance_work_mem`

```sql
-- Without decoupling: every autovacuum worker uses maintenance_work_mem
-- Default autovacuum_max_workers = 3 × maintenance_work_mem = 1GB = 3GB cluster-wide

-- With decoupling: autovacuum gets a smaller, sighup-reloadable budget
ALTER SYSTEM SET autovacuum_work_mem = '256MB';
SELECT pg_reload_conf();

-- Verify (existing autovacuum workers keep their old value until they finish)
SHOW autovacuum_work_mem;

-- Now maintenance_work_mem can be safely raised for interactive operations:
ALTER SYSTEM SET maintenance_work_mem = '2GB';
SELECT pg_reload_conf();
-- Autovacuum stays at 256MB × 3 = 768MB cap
-- Manual VACUUM / CREATE INDEX in a session gets 2GB
```


### Recipe 11: ETL session with large `temp_buffers`

```sql
-- Open new connection; set temp_buffers BEFORE first temp table reference
SET temp_buffers = '256MB';

CREATE TEMP TABLE staging_orders AS
  SELECT * FROM external_orders_load();

-- Subsequent attempts to change temp_buffers in this session will silently no-op:
SET temp_buffers = '512MB';  -- Returns ERROR or warning; doesn't take effect
```

> [!WARNING] `temp_buffers` is frozen after first temp table
> Verbatim docs: *"subsequent attempts to change the value will have no effect on that session."*[^tempbuf] Set it as the FIRST statement after connecting, before any temp-table activity.


### Recipe 12: Find the queries that need `work_mem`

```sql
-- Requires pg_stat_statements
SELECT
  query,
  calls,
  total_exec_time / 1000 AS total_sec,
  mean_exec_time AS mean_ms,
  rows,
  temp_blks_written * 8192 AS temp_bytes_written,
  pg_size_pretty(temp_blks_written * 8192) AS temp_pretty
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 20;
```

Queries with `temp_blks_written > 0` are spilling. Cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) for the full surface. Decide per-query whether to:

1. Add an index that removes the sort/hash node entirely (best fix).
2. Raise `work_mem` for the role that runs the query (per-role override).
3. Accept the spill (queries that run rarely).


### Recipe 13: PG18 async I/O memory implications

```sql
-- PG18 only
SHOW io_method;                          -- Default: 'worker'
SHOW io_workers;                         -- Default: 3
SHOW io_combine_limit;                   -- Default: 128 kB
SHOW io_max_combine_limit;               -- Default: 128 kB
SHOW effective_io_concurrency;           -- PG18 default: 16 (was 1 in PG17)
SHOW maintenance_io_concurrency;         -- PG18 default: 16 (was 10 in PG17)
```

PG18 async I/O adds memory commitment in two places:

- `io_workers` extra backend processes (PG18 default 3, costs ~10 MB each; the variable is removed in PG19).
- DSM for the I/O queue, scoped within `min_dynamic_shared_memory` or dynamically allocated.

> [!WARNING] PostgreSQL 19
> PostgreSQL 19 removes the server variable `io_workers`. It is replaced by `io_min_workers` (default 2), `io_max_workers` (default 8), `io_worker_idle_timeout` (default 1 minute), and `io_worker_launch_interval` (default 100ms), so `SHOW io_workers` above applies to PG18 only.[^pg19-io-workers-54]

For most workloads the additional memory commitment is negligible (~30 MB). The `effective_io_concurrency` default jump from 1 to 16 changes planner behavior more than memory commitment — index scans become preferred over sequential scans in more cases.[^pg18-eio]


## Gotchas / Anti-patterns

1. **`shared_buffers > 40% of RAM` is officially not recommended.** Verbatim docs: *"unlikely that an allocation of more than 40% of RAM to `shared_buffers` will work better than a smaller amount."*[^shbuf-pg16] The 25% starting rule with measurement is the right approach.

2. **`shared_buffers` is server-start-only.** Context = `postmaster`. Plan changes with maintenance windows.

3. **`work_mem` is a per-operation base limit, not a per-query or per-session budget.** Parallel processes and hash multipliers can increase total use.

4. **A concurrency multiplication is a scenario, not a hard maximum.** Include the leader, active plan operations, hash multipliers, and concurrent workload when assessing memory pressure.

5. **Autovacuum worker limits multiply potential memory demand, not upfront committed RAM.** When `autovacuum_work_mem = -1`, each worker uses `maintenance_work_mem`; set a separate limit if needed.[^mwm-warning]

6. **Pre-PG17 VACUUM limits dead-tuple identifier collection to 1 GB.** A larger setting does not increase that specific collection limit.[^pg17-mwm]

7. **`temp_buffers` is frozen after first temp-table use.** Set it before any temp activity in the session.

8. **`hash_mem_multiplier` default changed in PG15 from 1.0 to 2.0.**[^pg15-hash] Carry-forward configs from PG13/PG14 silently double their effective hash budget on upgrade. Usually a good thing; rarely surprising.

9. **`effective_cache_size = 4 GB` (default) is far below modern reality.** Planner under-uses indexes. Set explicitly to OS-cache + `shared_buffers`.

10. **Only automatic `wal_buffers` sizing is capped at one WAL segment.** A manually specified value can be larger.[^walbuf]

11. **`huge_pages = on` fails startup if sysctl reservation is insufficient.** Use `try` until you've verified the reservation works. The verbatim docs: *"PostgreSQL will fail to start if not enough huge pages are available."*[^kernel]

12. **Transparent huge pages (THP) ≠ explicit huge pages.** THP is widely recommended to be disabled (latency spikes from defragmentation); explicit huge pages via `vm.nr_hugepages` is what you want.

13. **`vacuum_buffer_usage_limit` default changed PG16→PG17** from 256 kB to 2 MB.[^pg17-vbul-default] Configurations that explicitly set 256 kB to "match the default" now diverge.

14. **`vacuum_buffer_usage_limit = 0` allows VACUUM to use any of `shared_buffers`.** This is sometimes useful for one-off vacuums where the table is hot anyway, but as a default it can sweep working-set pages out of the buffer pool.

15. **`logical_decoding_work_mem` applies per logical decoding connection.** Multiple active connections can each consume memory up to their applicable limit; slots alone do not reserve that memory.

16. **`autovacuum_work_mem` context is `sighup`**, but existing autovacuum workers keep their old value until they finish their current vacuum. The new value takes effect for the next worker started.

17. **`min_dynamic_shared_memory = 0` (default) is correct for most clusters.** Only raise if you have huge pages AND heavy parallel query AND want DSM allocations to benefit from huge pages.

18. **OOM-killer doesn't know about `work_mem` multiplication.** Linux's OOM-score calculation uses RSS; Postgres's lazy-allocation model means actual RSS climbs only as queries run. Capacity planning must account for worst case, not steady state.

19. **`SHOW shared_memory_size` is PG15+ only.** Pre-PG15 there is no SQL-visible total — you must compute it manually from `shared_buffers`, `wal_buffers`, and undocumented overheads.

20. **`huge_page_size = 0` (default) uses the system default**, not 0 bytes. PG14+.[^pg14-hps] System default is typically 2 MB on Linux; some configurations support 1 GB pages.

21. **Connection-pooler interaction.** With pgBouncer in transaction mode, per-role GUC settings (via `ALTER ROLE SET work_mem = ...`) may not propagate consistently because backend connections are reused across roles. Cross-reference [`81-pgbouncer.md`](./81-pgbouncer.md) and [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6.

22. **`max_stack_depth` default is 2 MB on most platforms** — the docs warn that setting it higher than the OS-imposed stack limit (typically 8 MB on Linux) can produce SIGSEGV.[^maxstack] Almost never needs tuning.

23. **PG18 `io_workers` are extra processes**, not threads. Each one is a real OS process with its own RSS (~10 MB). Default 3 workers adds ~30 MB cluster-wide.[^pg18-aio]

    > [!NOTE] PostgreSQL 19
    > PostgreSQL 19 replaces `io_workers` with `io_min_workers` and `io_max_workers` (defaults 2 and 8).[^pg19-io-workers-54]


## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum memory budgeting + PG17 cap removal context
- [`32-buffer-manager.md`](./32-buffer-manager.md) — `shared_buffers` mechanics, clock-sweep, ring buffers, `pg_buffercache`
- [`33-wal.md`](./33-wal.md) — `wal_buffers` deeper context
- [`46-roles-privileges.md`](./46-roles-privileges.md) — per-role `ALTER ROLE SET` mechanics
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC contexts, `pg_settings`, `ALTER SYSTEM`
- [`56-explain.md`](./56-explain.md) — reading `EXPLAIN (ANALYZE, BUFFERS)` to find spilling nodes
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — `temp_blks_written` per query for `work_mem` triage
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_database.temp_*` columns
- [`81-pgbouncer.md`](./81-pgbouncer.md) — per-role GUC interaction with transaction-mode pooling


## Sources

[^shbuf-pg16]: PostgreSQL 16 — Resource Consumption / Memory, `shared_buffers`. Verbatim: *"Sets the amount of memory the database server uses for shared memory buffers. ... it is unlikely that an allocation of more than 40% of RAM to `shared_buffers` will work better than a smaller amount."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^workmem]: PostgreSQL 16 — Resource Consumption / Memory, `work_mem`. Verbatim: *"Sets the base maximum amount of memory to be used by a query operation (such as a sort or hash table) before writing to temporary disk files. ... if a sort or hash table exceeds work_mem, it will use temporary files on disk."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^hashmem]: PostgreSQL 16 — Resource Consumption / Memory, `hash_mem_multiplier`. Verbatim: *"Used to compute the maximum amount of memory that hash-based operations can use. The final limit is determined by multiplying `work_mem` by `hash_mem_multiplier`. The default value is 2.0, which makes hash-based operations use twice the usual `work_mem` base amount."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^mwm]: PostgreSQL 16 — Resource Consumption / Memory, `maintenance_work_mem`. Verbatim: *"Specifies the maximum amount of memory to be used by maintenance operations, such as VACUUM, CREATE INDEX, and ALTER TABLE ADD FOREIGN KEY."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^mwm-warning]: PostgreSQL 16 — Resource Consumption / Memory, `maintenance_work_mem`: *"when autovacuum runs, up to autovacuum_max_workers times this memory may be allocated"*; `autovacuum_work_mem` can control the budget separately. https://www.postgresql.org/docs/16/runtime-config-resource.html

[^avwm]: PostgreSQL 16 — Resource Consumption / Memory, `autovacuum_work_mem`. Verbatim: *"Specifies the maximum amount of memory to be used by each autovacuum worker process. ... The default value is `-1`, indicating that the value of `maintenance_work_mem` should be used instead."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^tempbuf]: PostgreSQL 16 — Resource Consumption / Memory, `temp_buffers`. Verbatim: *"Sets the maximum amount of memory used for temporary buffers within each database session. ... The setting can be changed within individual sessions, but only before the first use of temporary tables within the session; subsequent attempts to change the value will have no effect on that session."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^walbuf]: PostgreSQL 16 — Write Ahead Log, `wal_buffers`. Verbatim: *"The amount of shared memory used for WAL data that has not yet been written to disk. The default setting of -1 selects a size equal to 1/32nd (about 3%) of `shared_buffers`, but not less than 64kB nor more than the size of one WAL segment, typically 16MB."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^ldwm]: PostgreSQL 16 — Resource Consumption / Memory, `logical_decoding_work_mem`. Verbatim: *"Specifies the maximum amount of memory to be used by logical decoding, before some of the decoded changes are written to local disk."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^vbul]: PostgreSQL 16 — Resource Consumption / Memory, `vacuum_buffer_usage_limit`. Verbatim: *"Specifies the size of the Buffer Access Strategy used by the `VACUUM` and `ANALYZE` commands. A setting of `0` will allow the operation to use any number of `shared_buffers`. Otherwise valid sizes range from `128 kB` to `16 GB`."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^ecs]: PostgreSQL 16 — Query Planning, `effective_cache_size`. Verbatim: *"Sets the planner's assumption about the effective size of the disk cache that is available to a single query."* https://www.postgresql.org/docs/16/runtime-config-query.html

[^mindsm]: PostgreSQL 16 — Resource Consumption / Memory, `min_dynamic_shared_memory`. Verbatim: *"Specifies the amount of memory that should be allocated at server startup for use by parallel queries."* https://www.postgresql.org/docs/16/runtime-config-resource.html

[^maxstack]: PostgreSQL 16 — Resource Consumption / Memory, `max_stack_depth`. Default 2 MB; setting higher than the kernel-imposed limit can produce SIGSEGV. https://www.postgresql.org/docs/16/runtime-config-resource.html

[^kernel]: PostgreSQL 16 — Managing Kernel Resources / Linux Huge Pages. Verbatim: *"Using huge pages reduces overhead when using large contiguous chunks of memory, as PostgreSQL does, particularly when using large values of `shared_buffers`."* and *"Note that with this setting PostgreSQL will fail to start if not enough huge pages are available."* https://www.postgresql.org/docs/16/kernel-resources.html

[^pg13-hash]: PostgreSQL 13 release notes — `hash_mem_multiplier` introduction (default 1.0). Verbatim: *"Allow hash aggregation to use disk storage for large aggregation result sets (Jeff Davis) ... The hash table will be spilled to disk if it exceeds `work_mem` times `hash_mem_multiplier`."* https://www.postgresql.org/docs/release/13.0/

[^pg13-mio]: PostgreSQL 13 release notes — `maintenance_io_concurrency`. Verbatim: *"Add `maintenance_io_concurrency` parameter to control I/O concurrency for maintenance operations (Thomas Munro)."* https://www.postgresql.org/docs/release/13.0/

[^pg14-hps]: PostgreSQL 14 release notes — `huge_page_size`. Verbatim: *"Add server parameter `huge_page_size` to control the size of huge pages used on Linux (Odin Ugedal)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-mindsm]: PostgreSQL 14 release notes — `min_dynamic_shared_memory`. Verbatim: *"Allow startup allocation of dynamic shared memory (Thomas Munro) ... This is controlled by `min_dynamic_shared_memory`. This allows more use of huge pages."* https://www.postgresql.org/docs/release/14.0/

[^pg14-ld]: PostgreSQL 14 release notes — logical decoding streaming. Verbatim: *"Previously transactions that exceeded `logical_decoding_work_mem` were written to disk until the transaction completed."* https://www.postgresql.org/docs/release/14.0/

[^pg14-ana]: PostgreSQL 14 release notes — ANALYZE prefetch. Verbatim: *"Allow analyze to do page prefetching (Stephen Frost) ... This is controlled by `maintenance_io_concurrency`."* https://www.postgresql.org/docs/release/14.0/

[^pg15-shmem]: PostgreSQL 15 release notes — `shared_memory_size` + `shared_memory_size_in_huge_pages`. Verbatim: *"Add server variable `shared_memory_size` to report the size of allocated shared memory (Nathan Bossart)."* and *"Add server variable `shared_memory_size_in_huge_pages` to report the number of huge memory pages required (Nathan Bossart)."* https://www.postgresql.org/docs/release/15.0/

[^pg15-hash]: PostgreSQL 15 release notes — `hash_mem_multiplier` default raised. Verbatim: *"Increase `hash_mem_multiplier` default to 2.0 (Peter Geoghegan) ... This allows query hash operations to use more `work_mem` memory than other operations."* https://www.postgresql.org/docs/release/15.0/

[^pg16-vbul-intro]: PostgreSQL 16 release notes — `vacuum_buffer_usage_limit`. Verbatim: *"Allow control of the shared buffer usage by vacuum and analyze (Melanie Plageman) ... The VACUUM/ANALYZE option is `BUFFER_USAGE_LIMIT`, and the vacuumdb option is `--buffer-usage-limit`. The default value is set by server variable `vacuum_buffer_usage_limit`, which also controls autovacuum."* https://www.postgresql.org/docs/release/16.0/

[^pg17-mwm]: PostgreSQL 17 release notes — `maintenance_work_mem` 1 GB cap removed for vacuum. Verbatim: *"Additionally, vacuum is no longer silently limited to one gigabyte of memory when `maintenance_work_mem` or `autovacuum_work_mem` are higher."* https://www.postgresql.org/docs/release/17.0/

[^pg17-vbul-default]: PostgreSQL 17 release notes — `vacuum_buffer_usage_limit` default raised. Verbatim: *"Increase default `vacuum_buffer_usage_limit` to 2MB (Thomas Munro)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-io]: PostgreSQL 17 release notes — `io_combine_limit`. Verbatim: *"Allow the grouping of file system reads with the new system variable `io_combine_limit` (Thomas Munro, Andres Freund, Melanie Plageman, Nazir Bilal Yavuz)."* https://www.postgresql.org/docs/release/17.0/

[^pg18-aio]: PostgreSQL 18 release notes — async I/O subsystem. Verbatim: *"Add an asynchronous I/O subsystem ... This is enabled by server variable `io_method`, with server variables `io_combine_limit` and `io_max_combine_limit` added to control it. This also enables `effective_io_concurrency` and `maintenance_io_concurrency` values greater than zero for systems without fadvise() support. The new system view `pg_aios` shows the file handles being used for asynchronous I/O."* https://www.postgresql.org/docs/release/18.0/

[^pg18-eio]: PostgreSQL 18 release notes — `effective_io_concurrency` and `maintenance_io_concurrency` defaults raised to 16. Verbatim: *"Increase server variables `effective_io_concurrency`'s and `maintenance_io_concurrency`'s default values to 16 (Melanie Plageman) ... This more accurately reflects modern hardware."* https://www.postgresql.org/docs/release/18.0/

[^pg19-io-workers-54]: PostgreSQL 19 release notes (RC2), Migration: *"Remove server variable `io_workers`"*; replacement variables and defaults at https://www.postgresql.org/docs/19/runtime-config-resource.html . Release notes: https://www.postgresql.org/docs/19/release-19.html#RELEASE-19-MIGRATION

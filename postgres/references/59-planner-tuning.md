# Planner Tuning

The planner's cost model, memory limits, join-search heuristics, and the `enable_*` toggles. Use this file when the planner picks the wrong plan and you want to know which knob to turn — and which knobs are debugging aids that must not ship to production.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Cost Constants](#cost-constants)
    - [effective_cache_size](#effective_cache_size)
    - [I/O Concurrency](#io-concurrency)
    - [Parallel Cost Constants](#parallel-cost-constants)
    - [Planner Method (`enable_*`) GUCs](#planner-method-enable_-gucs)
    - [Join-Search Limits and GEQO](#join-search-limits-and-geqo)
    - [`plan_cache_mode`](#plan_cache_mode)
    - [`cursor_tuple_fraction`](#cursor_tuple_fraction)
    - [`default_statistics_target` and `constraint_exclusion`](#default_statistics_target-and-constraint_exclusion)
    - [JIT Cost Thresholds](#jit-cost-thresholds)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- `EXPLAIN ANALYZE` shows a row-count or plan-shape problem you've already traced to the cost model (not to missing statistics, not to a missing index).
- You want to set `random_page_cost` for SSD-class storage and need the supporting rationale.
- You're staring at a query that should hash-join but is nested-looping and you want to disable nestloop *temporarily* to confirm the diagnosis.
- You need to size `effective_cache_size` correctly (it is a planner *hint*, not an allocation — see [`54-memory-tuning.md`](./54-memory-tuning.md) Rule 4).
- You hit `join_collapse_limit` on a 12+ table join and need to understand the GEQO threshold.
- You need to know which `enable_*` toggles are new in your PG version so you don't reference a non-existent setting.

> [!WARNING] PG18 did NOT introduce `enable_group_by_reordering`
> PG17 introduced `enable_group_by_reordering`. PG18 introduced two **different** new planner toggles: `enable_distinct_reordering` and `enable_self_join_elimination`. Common planning-note misattribution — verify against release notes directly.

## Mental Model

Five rules. Each names a misconception that frequently produces wrong tuning recommendations.

1. **Cost GUCs are pseudo-cost-units. They are not seconds, not bytes, not pages.** The unit is whatever `seq_page_cost = 1.0` is defined to be. Every other cost constant is implicitly *relative* to a sequential page read. Tuning `random_page_cost = 1.1` says "random I/O is 10% more expensive than sequential" — not "random I/O takes 1.1 ms." [^docs-cost-constants]

2. **`random_page_cost / seq_page_cost` is the index-vs-seqscan dial.** On spinning rust the ratio was 40:1 (defaults preserve a 4:1 ratio because the planner already accounts for the OS page cache via `effective_cache_size`). On NVMe / cloud SSDs the ratio approaches 1:1 — set `random_page_cost = 1.1`. Lowering the ratio makes the planner prefer index scans; raising it makes the planner prefer sequential scans.

3. **`effective_io_concurrency` controls prefetch aggressiveness for bitmap heap scans.** On PG18+ the default is **16** (was 1 prior); on spinning storage drop it back to 1–4. This is not a worker count — it's a `posix_fadvise(POSIX_FADV_WILLNEED)` issue depth.[^pg18-io-concurrency]

4. **`enable_*` GUCs are a debugging tool, not a production fix.** Disabling `enable_nestloop` in `postgresql.conf` is a code smell. Their legitimate use is: (a) inside a `SET LOCAL` block to confirm "if I force a hash join the plan is faster," (b) as a one-line repro on a staging cluster, (c) inside a function with a `SET` clause as a *narrow, justified* workaround. Cluster-wide `enable_nestloop = off` produces queries that succeed today and explode under a different data distribution tomorrow.[^docs-enable]

5. **`default_statistics_target` is the cross-cutting "more samples in `pg_statistic`" knob.** Raise it cluster-wide cautiously (planning time scales with histogram bucket count); raise it per-column on the few skewed columns that drive bad estimates. The per-column form via `ALTER TABLE … ALTER COLUMN … SET STATISTICS N` is almost always what you want. See [`55-statistics-planner.md`](./55-statistics-planner.md).

## Decision Matrix

| You want to                                            | Set                                                                 | Default (PG16)                | Production value                | Avoid                                                                                              |
|--------------------------------------------------------|---------------------------------------------------------------------|-------------------------------|---------------------------------|----------------------------------------------------------------------------------------------------|
| Make planner prefer index scans on SSD-class storage   | `random_page_cost`                                                  | `4.0`                         | `1.1` (NVMe) or `2.0` (cloud SSD) | Setting `0.0` (breaks cost model entirely)                                                         |
| Tell planner about real OS cache size                  | `effective_cache_size`                                              | `4GB`                         | ~75% of system RAM              | Setting `< shared_buffers` (forces seqscan bias)                                                   |
| Increase bitmap-heap-scan prefetch                     | `effective_io_concurrency`                                          | PG18+: `16`; PG≤17: `1`       | `200` SSD, `2` spinning         | Setting on Windows (no-op)                                                                         |
| Increase maintenance prefetch                          | `maintenance_io_concurrency`                                        | PG18+: `16`; PG≤17: `10`      | Match `effective_io_concurrency` | Cluster-wide >256 (kernel saturates)                                                              |
| Debug "why isn't planner using my index"               | `SET LOCAL enable_seqscan = off`                                    | `on`                          | Never set cluster-wide          | Putting in `postgresql.conf`                                                                       |
| Debug "why is this nested loop slow"                   | `SET LOCAL enable_nestloop = off`                                   | `on`                          | Never set cluster-wide          | Cluster-wide override                                                                              |
| Investigate parallel plans                             | `SET parallel_setup_cost = 0`                                       | `1000`                        | Keep default                    | Permanent zero (parallel for trivial queries)                                                      |
| Force planner to enumerate all join orders             | `SET join_collapse_limit = 32; SET from_collapse_limit = 32`        | `8 / 8`                       | Raise per-session for big joins | Cluster-wide > 16 (planning time blows up)                                                         |
| Disable GEQO entirely                                  | `SET geqo = off`                                                    | `on`                          | Off for debugging               | Off cluster-wide on a workload with > 12-table joins                                               |
| Force prepared statement to always re-plan             | `SET plan_cache_mode = force_custom_plan`                           | `auto`                        | Per-session for parameter skew  | Cluster-wide                                                                                       |
| Force prepared statement to always reuse plan          | `SET plan_cache_mode = force_generic_plan`                          | `auto`                        | Per-session for hot point lookups | Without measuring                                                                                 |
| Tell planner cursor will read only first N%            | `SET cursor_tuple_fraction = 0.01`                                  | `0.1`                         | Per-session for paged readers   | Cluster-wide                                                                                       |
| Raise stats sample size cluster-wide                   | `default_statistics_target = 250`                                   | `100`                         | `100` (raise per-column)        | Raising to `10000` cluster-wide (planning slows)                                                   |
| Raise stats sample size for one skewed column          | `ALTER TABLE t ALTER COLUMN c SET STATISTICS 1000`                  | `100`                         | `500–10000` for skewed columns  | Setting `-1` thinking it's "more" (it means "use default")                                          |
| Disable partition pruning for debugging                | `SET enable_partition_pruning = off`                                | `on`                          | Never                           | Production override                                                                                |
| Disable JIT for short queries                          | `SET jit_above_cost = -1` or `SET jit = off`                        | `100000 / on`                 | `-1` if JIT overhead exceeds benefit | Cluster-wide `jit = off` without measurement                                                  |

Three smell signals:

- **You're putting `enable_X = off` in `postgresql.conf`.** The plan that "works" today depends on a data distribution that may shift; the planner picked nestloop *because of its cost model* — make the cost model right, don't disable the operator.
- **You're tuning `random_page_cost` to 0.001.** You're masking missing statistics or a missing index. The cost model is not the lever you want.
- **You set `effective_cache_size = shared_buffers`.** This tells the planner the OS cache is nonexistent, biasing toward seqscans. Set it to the real available cache (OS + shared_buffers, roughly 75% of RAM).

## Syntax / Mechanics

### Cost Constants

These are the pseudo-cost units the planner uses to compare plans. Every cost in `EXPLAIN` output is in these units.[^docs-cost-constants]

| GUC                       | Default  | What it measures                                                                                       |
|---------------------------|----------|--------------------------------------------------------------------------------------------------------|
| `seq_page_cost`           | `1.0`    | Sequentially-fetched disk page. **The unit** — every other cost is relative.                          |
| `random_page_cost`        | `4.0`    | Non-sequentially-fetched disk page. Drives index-vs-seqscan choice.                                    |
| `cpu_tuple_cost`          | `0.01`   | Processing each row during a query.                                                                    |
| `cpu_index_tuple_cost`    | `0.005`  | Processing each index entry during an index scan.                                                      |
| `cpu_operator_cost`       | `0.0025` | Processing each operator or function call.                                                             |
| `parallel_setup_cost`     | `1000`   | Cost of launching parallel workers.                                                                    |
| `parallel_tuple_cost`     | `0.1`    | Cost of transferring one row from worker to leader.                                                    |
| `min_parallel_table_scan_size` | `8MB` | Minimum table size before parallel seqscan is considered.                                          |
| `min_parallel_index_scan_size` | `512kB` | Minimum index scan size before parallel index scan is considered.                                |

The verbatim docs guidance for `random_page_cost`: *"Although the system will let you set `random_page_cost` to less than `seq_page_cost`, it is not physically sensible to do so. However, setting it equal makes sense if the database is entirely cached in RAM, since in that case there is no penalty for touching pages out of sequence."*[^docs-cost-constants]

> [!NOTE] PostgreSQL 18
> `effective_io_concurrency` and `maintenance_io_concurrency` defaults raised from `1` / `10` to **`16`**. Verbatim release-note: *"Increase server variables `effective_io_concurrency`'s and `maintenance_io_concurrency`'s default values to 16 (Melanie Plageman). This more accurately reflects modern hardware."*[^pg18-io-concurrency]

#### Practical SSD-class settings

```sql
-- Cloud-block-storage (gp3 / pd-ssd / premium-ssd):
ALTER SYSTEM SET random_page_cost = 1.1;
ALTER SYSTEM SET effective_io_concurrency = 200;

-- Local NVMe:
ALTER SYSTEM SET random_page_cost = 1.0;
ALTER SYSTEM SET effective_io_concurrency = 200;

-- Spinning rust (rare in 2026):
ALTER SYSTEM SET random_page_cost = 4.0;
ALTER SYSTEM SET effective_io_concurrency = 2;

SELECT pg_reload_conf();
```

Both are `sighup`-context: change takes effect on reload, no restart needed. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) for GUC contexts.

### effective_cache_size

A planner *hint*, not an allocation. It tells the planner how much disk cache is *available* (OS page cache + `shared_buffers`). Lower values bias toward sequential scans; higher values let the planner prefer index scans even when the index is large.

| Default | Recommended |
|---------|-------------|
| `4GB`   | ~75% of system RAM |

```sql
-- 64GB host:
ALTER SYSTEM SET effective_cache_size = '48GB';
```

The default `4GB` is almost certainly too low for any production host. See [`54-memory-tuning.md`](./54-memory-tuning.md) Rule 4 for the no-memory-reserved rule and the cross-reference to host sizing.

### I/O Concurrency

`effective_io_concurrency` controls prefetch (`posix_fadvise(WILLNEED)`) issue depth for bitmap heap scans. `maintenance_io_concurrency` does the same for ANALYZE and other maintenance operations.

| GUC | PG16 default | PG18+ default |
|---|---|---|
| `effective_io_concurrency` | `1` | `16` |
| `maintenance_io_concurrency` | `10` | `16` |

> [!WARNING] Not supported on Windows
> Both default to `0` (off) on Windows builds because `posix_fadvise` is POSIX-only. Setting them is a no-op on Windows.[^docs-resource]

### Parallel Cost Constants

| GUC | Default | Effect |
|---|---|---|
| `parallel_setup_cost` | `1000` | Discourages parallel plans for cheap queries. Lower to test parallel plans. |
| `parallel_tuple_cost` | `0.1` | Cost per row shipped from worker to leader. |
| `min_parallel_table_scan_size` | `8MB` | Below this table size, never parallelize. |
| `min_parallel_index_scan_size` | `512kB` | Below this index scan size, never parallelize. |

These interact with `max_parallel_workers_per_gather` (see [`60-parallel-query.md`](./60-parallel-query.md)) to determine whether a parallel plan is chosen.

### Planner Method (`enable_*`) GUCs

The full catalog. Almost all default to `on`. The exceptions (`enable_partitionwise_*` default `off`) reflect that those plans can multiply memory consumption (each partition gets its own work_mem budget).[^docs-enable]

| GUC                              | Default  | Version | Effect when `off`                                                  |
|----------------------------------|----------|---------|--------------------------------------------------------------------|
| `enable_async_append`            | `on`     | PG14    | Disable async appending of partitioned-table parallel scans         |
| `enable_bitmapscan`              | `on`     | -       | Disable Bitmap Heap Scan plans                                      |
| `enable_distinct_reordering`     | `on`     | **PG18** | Forbid reordering DISTINCT keys to match path's pathkeys           |
| `enable_gathermerge`             | `on`     | -       | Disable Gather Merge atop parallel-ordered plans                    |
| `enable_group_by_reordering`     | `on`     | **PG17** | Forbid reordering GROUP BY keys to match a child plan's order      |
| `enable_hashagg`                 | `on`     | -       | Disable Hash Aggregate                                              |
| `enable_hashjoin`                | `on`     | -       | Disable Hash Join                                                   |
| `enable_incremental_sort`        | `on`     | PG13    | Disable Incremental Sort (partial-sort followed by sort by remaining keys) |
| `enable_indexscan`               | `on`     | -       | Disable Index Scan                                                  |
| `enable_indexonlyscan`           | `on`     | -       | Disable Index Only Scan (forces heap fetch)                         |
| `enable_material`                | `on`     | -       | Disable Materialize node                                            |
| `enable_memoize`                 | `on`     | PG14    | Disable Memoize (cache inner side of nested loop)                   |
| `enable_mergejoin`               | `on`     | -       | Disable Merge Join                                                  |
| `enable_nestloop`                | `on`     | -       | Disable Nested Loop (very aggressive; rare last resort)             |
| `enable_parallel_append`         | `on`     | PG11    | Disable parallel Append (per-partition parallel workers)            |
| `enable_parallel_hash`           | `on`     | PG11    | Disable shared Hash Join build phase                                |
| `enable_partition_pruning`       | `on`     | PG11    | Disable execution-time partition pruning                            |
| `enable_partitionwise_join`      | **`off`** | PG11   | Joining matching partitions of co-partitioned tables                |
| `enable_partitionwise_aggregate` | **`off`** | PG11   | Aggregate per partition then combine                                |
| `enable_presorted_aggregate`     | `on`     | **PG16** | Forbid using pre-sorted input for ORDER BY/DISTINCT inside aggregates |
| `enable_self_join_elimination`   | `on`     | **PG18** | Forbid replacing self-joins with single scans                       |
| `enable_seqscan`                 | `on`     | -       | Disable Seq Scan (the planner uses higher cost, doesn't refuse outright) |
| `enable_sort`                    | `on`     | -       | Disable explicit Sort nodes                                          |
| `enable_tidscan`                 | `on`     | -       | Disable scan-by-ctid                                                |

#### Important behavior

The verbatim docs caveat: *"This is not the recommended way to tune the query optimizer."* For long-term plan-shape stability, fix the cost model or add statistics — don't pin the planner to a method.[^docs-enable]

When set to `off`, the planner doesn't refuse to use that method outright; it adds `disable_cost` (1e10) to the cost. If no other plan exists, the planner will still use the "disabled" method — `enable_seqscan = off` will still seq-scan a table with no index.

> [!NOTE] PostgreSQL 18 — disabled nodes shown in EXPLAIN
> Plans forced by disabling a method now show `Disabled: true` in EXPLAIN output. See [`56-explain.md`](./56-explain.md) Recipe 14.

#### Partitionwise join/aggregate (default `off`)

These default to `off` because they multiply `work_mem` consumption (one budget per partition). Enable per-session when the workload benefits:

```sql
SET enable_partitionwise_join = on;
SET enable_partitionwise_aggregate = on;
```

Cross-reference [`35-partitioning.md`](./35-partitioning.md) for the conditions under which partitionwise plans are eligible.

### Join-Search Limits and GEQO

The planner has two strategies for join-order selection:

1. **Exhaustive dynamic-programming search** (default) — considers every join order. Optimal but cost scales as N! for N tables.
2. **Genetic Query Optimization (GEQO)** — heuristic search. Kicks in when the number of `FROM` items exceeds `geqo_threshold`. Non-deterministic by default (`geqo_seed = 0`), so the same query may produce different plans on different runs.[^docs-genetic]

| GUC | Default | Effect |
|---|---|---|
| `from_collapse_limit` | `8` | Below this many FROM items, subqueries are pulled up into the parent query. |
| `join_collapse_limit` | `8` | Below this many explicit JOINs, the planner reorders them; above, it preserves the textual order. |
| `geqo` | `on` | Enable genetic optimizer for queries above `geqo_threshold`. |
| `geqo_threshold` | `12` | Number of FROM items at which GEQO kicks in. |
| `geqo_effort` | `5` | 1–10. Higher = more time spent searching. |
| `geqo_pool_size` | `0` | `0` = auto-pick from `geqo_effort`. |
| `geqo_generations` | `0` | `0` = auto-pick from `geqo_effort`. |
| `geqo_selection_bias` | `2.00` | 1.5–2.0. Higher = less diversity. |
| `geqo_seed` | `0` | Random seed; `0` means randomize. Set to a constant for reproducibility. |

#### Practical guidance

For OLTP workloads with simple joins (<8 tables): defaults are fine.

For analytics workloads that routinely join 12+ tables, the question is whether the GEQO heuristic produces a plan as good as exhaustive search:

```sql
-- For one specific big-join query in a reporting session:
SET join_collapse_limit = 24;
SET from_collapse_limit = 24;
SET geqo_threshold = 24;
-- Now plan with exhaustive search up to 24 tables, even though
-- planning takes longer.
```

The cost of exhaustive search at 16 tables is on the order of seconds (16! ≈ 2×10¹³ join orderings, pruned aggressively by dynamic programming). Above 20–24 tables the planner's exhaustive search becomes the dominant time cost — GEQO is the only practical option.

> [!WARNING] `geqo_seed = 0` makes plans non-deterministic
> Production queries above `geqo_threshold` may produce *different* plans on different runs unless you pin `geqo_seed` to a constant. Setting a constant seed reproduces the same plan run-to-run but doesn't make GEQO produce the *optimal* plan — only the same heuristic one.[^docs-genetic]

### `plan_cache_mode`

Per-session GUC controlling whether `PREPARE`d statements use generic or custom plans. See [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) for the deep dive.

| Value | Behavior |
|---|---|
| `auto` (default) | Heuristic — use generic if 5+ executions and generic-plan cost is competitive. |
| `force_custom_plan` | Always re-plan with actual parameter values. |
| `force_generic_plan` | Always use the generic plan. |

```sql
-- Per-session override for parameter-skewed queries:
SET LOCAL plan_cache_mode = 'force_custom_plan';
```

### `cursor_tuple_fraction`

Tells the planner how much of a cursor's result set will actually be fetched. Default `0.1` (planner assumes you'll read 10% of rows).

| Value | Effect |
|---|---|
| `0.01` | Optimize for first rows fast (good for paginated readers) |
| `0.1` (default) | Balanced |
| `1.0` | Optimize for fetching the entire result set |

Per-session only — never set cluster-wide.

### `default_statistics_target` and `constraint_exclusion`

| GUC | Default | Effect |
|---|---|---|
| `default_statistics_target` | `100` | Sample size for `ANALYZE`. Number of histogram buckets and MCV entries per column. |
| `constraint_exclusion` | `partition` | Pre-PG10 mechanism; `partition` means apply to inheritance and UNION ALL only. |

`default_statistics_target = 100` is the right default for nearly every workload. Raise per-column on the small number of columns with highly skewed distributions (cross-reference [`55-statistics-planner.md`](./55-statistics-planner.md) Recipe 3):

```sql
ALTER TABLE events ALTER COLUMN status SET STATISTICS 1000;
ANALYZE events (status);
```

`constraint_exclusion` is legacy — used by inheritance-partitioned tables (cross-reference [`36-inheritance.md`](./36-inheritance.md)). Declarative partitioning uses `enable_partition_pruning` instead. Default `partition` means the GUC only applies to inheritance and `UNION ALL` queries, not declarative partitions.[^docs-other]

### JIT Cost Thresholds

JIT compilation kicks in based on total plan cost.

| GUC | Default | Effect |
|---|---|---|
| `jit` | `on` | Enable JIT globally |
| `jit_above_cost` | `100000` | Total plan cost above which JIT is considered |
| `jit_inline_above_cost` | `500000` | Cost above which JIT inlines functions |
| `jit_optimize_above_cost` | `500000` | Cost above which JIT applies more expensive optimizations |

Setting `jit_above_cost = -1` disables JIT without disabling the GUC. Cross-reference [`61-jit-compilation.md`](./61-jit-compilation.md) for JIT cost threshold details. The common production tweak: bump `jit_above_cost` to `1000000` or `-1` if your workload is dominated by short queries where JIT compilation time exceeds the runtime savings.

### Per-Version Timeline

| Version | Planner-tuning changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| PG13    | `enable_incremental_sort` added. `hash_mem_multiplier` introduced (default 1.0).[^pg13-hashmem] OR-clauses estimate using extended stats. Function inlining if function returns a constant. `enable_incremental_sort` defaults `on`.[^pg13-rls]                                                                                                                                                                                                                                                                                                                                                                                                              |
| PG14    | `enable_memoize` added (default `on`).[^pg14-memoize] `vacuum_cost_page_miss` default lowered.[^pg14-vacm] Extended statistics on expressions added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PG15    | `hash_mem_multiplier` default raised 1.0 → 2.0.[^pg15-hashmem] `recursive_worktable_factor` added (default 10.0).[^pg15-rwf] No new `enable_*` GUCs in PG15.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PG16    | `enable_presorted_aggregate` added (default `on`).[^pg16-presorted] Incremental sorts allowed in more cases including DISTINCT.[^pg16-incsort] GIN cost-accuracy improved.[^pg16-gin] Memoize over UNION ALL.[^pg16-memoize-union] Parallel `string_agg`/`array_agg`.[^pg16-parallel-agg]                                                                                                                                                                                                                                                                                                                                                                          |
| PG17    | `enable_group_by_reordering` added (default `on`).[^pg17-gbr] Foreign-data-wrapper tuple cost default raised.[^pg17-fdw] `old_snapshot_threshold` removed.[^pg17-old-snap]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PG18    | `enable_self_join_elimination` added (default `on`).[^pg18-sje] `enable_distinct_reordering` added (default `on`).[^pg18-dr] `effective_io_concurrency` / `maintenance_io_concurrency` defaults raised from `1` / `10` to `16`.[^pg18-io-concurrency] Skip scan for btree indexes (cross-reference [`23-btree-indexes.md`](./23-btree-indexes.md)).[^pg18-skip] `generate_series()` row estimates improved.[^pg18-gs] Functionally-dependent GROUP BY columns eliminated.[^pg18-fd-gb] Hash join + GROUP BY performance/memory.[^pg18-hash] |

> [!NOTE] PG-version-introduced `enable_*` summary
> PG13: `enable_incremental_sort`. PG14: `enable_memoize`, `enable_async_append` (the latter is implicit — was internal pre-PG14). PG16: `enable_presorted_aggregate`. PG17: `enable_group_by_reordering`. PG18: `enable_distinct_reordering`, `enable_self_join_elimination`. **Total enable_* count: PG16 has 21; PG17 has 22; PG18 has 24.**

## Examples / Recipes

### Recipe 1 — Baseline production planner settings for SSD-class storage

```sql
-- Production baseline for a 64 GB cloud-block-storage host running PG16+

-- Cost constants: SSD-class storage
ALTER SYSTEM SET random_page_cost = 1.1;
ALTER SYSTEM SET seq_page_cost = 1.0;             -- explicit (default 1.0)

-- Real cache size (OS page cache + shared_buffers ≈ 48 GB on a 64 GB host)
ALTER SYSTEM SET effective_cache_size = '48GB';

-- I/O prefetch (PG18 defaults are already 16; explicit for clarity)
ALTER SYSTEM SET effective_io_concurrency = 200;       -- bitmap heap scans
ALTER SYSTEM SET maintenance_io_concurrency = 200;     -- ANALYZE prefetch

-- Statistics target (default 100 is fine cluster-wide; raise per-column)
-- ALTER SYSTEM SET default_statistics_target = 100;

-- Reload (these are all sighup-context):
SELECT pg_reload_conf();

-- Verify they took:
SELECT name, setting, source, pending_restart
FROM pg_settings
WHERE name IN ('random_page_cost', 'effective_cache_size',
               'effective_io_concurrency', 'maintenance_io_concurrency')
ORDER BY name;
```

> [!NOTE]
> All four GUCs above are `sighup`-context — no restart needed. See [`53-server-configuration.md`](./53-server-configuration.md) for the seven contexts.

### Recipe 2 — Diagnose: "Why isn't my index being used?"

The canonical debugging walkthrough.

```sql
-- 1. Get the plan with cost numbers
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM events WHERE event_type = 'login';

-- 2. If the planner picked Seq Scan when you expected Index Scan,
--    temporarily disable Seq Scan to see what the alternative would cost:

BEGIN;
  SET LOCAL enable_seqscan = off;
  EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM events WHERE event_type = 'login';
ROLLBACK;

-- 3. Compare costs. If the index plan is cheaper but the planner didn't pick
--    it, your cost constants are wrong (likely random_page_cost too high).
--    If the index plan is genuinely more expensive, the planner was right —
--    investigate the row estimate (cross-reference 56-explain.md Recipe 1).

-- 4. NEVER ship the disable_seqscan setting. Fix the underlying issue:
--    - statistics stale? → ANALYZE
--    - random_page_cost wrong for storage? → ALTER SYSTEM
--    - index column has wrong opclass? → see 22-indexes-overview.md
```

### Recipe 3 — Per-role planner profile for analytics workload

Continue the per-role-baseline pattern from iterations 41/42/46/54/56/57.

```sql
-- For roles running large analytic queries:
ALTER ROLE reporter SET work_mem = '256MB';
ALTER ROLE reporter SET hash_mem_multiplier = 4.0;
ALTER ROLE reporter SET enable_partitionwise_join = on;
ALTER ROLE reporter SET enable_partitionwise_aggregate = on;
ALTER ROLE reporter SET join_collapse_limit = 16;
ALTER ROLE reporter SET from_collapse_limit = 16;
ALTER ROLE reporter SET cursor_tuple_fraction = 1.0;   -- analytics reads everything

-- For OLTP roles, keep defaults:
ALTER ROLE webapp RESET work_mem;
ALTER ROLE webapp RESET hash_mem_multiplier;
ALTER ROLE webapp SET cursor_tuple_fraction = 0.01;    -- paginated readers want first-row-fast
```

Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) for the per-role-defaults pattern and [`81-pgbouncer.md`](./81-pgbouncer.md) for the transaction-mode pooling caveat.

### Recipe 4 — Diagnose: "Same query, different plans run-to-run"

If you have a join of 12+ tables and the plan varies across executions:

```sql
-- 1. Confirm GEQO is responsible:
SHOW geqo;
SHOW geqo_threshold;

-- 2. Pin the GEQO seed for reproducibility in your investigation:
SET geqo_seed = 1.0;

-- 3. Compare plans deterministically:
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;

-- 4. Or disable GEQO and force exhaustive search:
BEGIN;
  SET LOCAL geqo = off;
  SET LOCAL join_collapse_limit = 24;
  SET LOCAL from_collapse_limit = 24;
  EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
ROLLBACK;

-- 5. If exhaustive search finds a much better plan, raise the limits
--    for that session/role. If not, GEQO is doing fine; the variance
--    isn't the bug.
```

### Recipe 5 — Generic vs custom plan diagnosis

Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) Recipe 6.

```sql
-- Prepare and execute six times to trigger generic-plan threshold:
PREPARE q (text) AS
  SELECT count(*) FROM events WHERE event_type = $1;

EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('login');     -- custom plan
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('login');     -- custom plan
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('login');     -- custom plan
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('login');     -- custom plan
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('login');     -- custom plan
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('login');     -- generic plan likely

-- Force custom plan if generic plan is bad for skewed parameters:
SET plan_cache_mode = force_custom_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('rare_value');

-- Force generic plan if custom-plan re-planning cost dominates:
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q ('common_value');
```

The plan-flip diagnosis query (PG14+):

```sql
SELECT query, calls, generic_plan_calls, custom_plan_calls
FROM pg_prepared_statements;
```

### Recipe 6 — Test PG18 self-join elimination

```sql
-- A pattern where self-join elimination kicks in:
CREATE TABLE t (id int PRIMARY KEY, value text);
INSERT INTO t SELECT i, i::text FROM generate_series(1, 10000) i;
ANALYZE t;

-- The redundant self-join:
EXPLAIN (ANALYZE, BUFFERS)
SELECT t1.id, t2.value
FROM t t1
JOIN t t2 ON t1.id = t2.id
WHERE t1.id < 100;

-- On PG18+, this plan eliminates the second scan of t — verbatim
-- "Automatically remove some unnecessary table self-joins". The plan
-- shows only one Index Scan on t.

-- To verify the optimization is what's happening:
SET enable_self_join_elimination = off;
EXPLAIN (ANALYZE, BUFFERS)
SELECT t1.id, t2.value FROM t t1 JOIN t t2 ON t1.id = t2.id WHERE t1.id < 100;
-- Now the plan shows two scans of t.
RESET enable_self_join_elimination;
```

### Recipe 7 — Force a parallel plan for testing

```sql
-- Force the planner to consider parallel plans even for small inputs:
BEGIN;
  SET LOCAL parallel_setup_cost = 0;
  SET LOCAL parallel_tuple_cost = 0;
  SET LOCAL min_parallel_table_scan_size = 0;
  SET LOCAL min_parallel_index_scan_size = 0;
  SET LOCAL max_parallel_workers_per_gather = 4;
  EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
ROLLBACK;
```

This is purely for testing — do not commit. Cross-reference [`60-parallel-query.md`](./60-parallel-query.md).

### Recipe 8 — Find non-default planner settings

```sql
SELECT name, setting, source, short_desc
FROM pg_settings
WHERE category LIKE 'Query Tuning%'
  AND source NOT IN ('default', 'override')
ORDER BY category, name;
```

This is the cluster-state audit for which planner GUCs have been changed from compiled-in defaults. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) Recipe 9.

### Recipe 9 — Inspect what GEQO is doing

```sql
-- Enable verbose planner output for one session:
SET geqo_seed = 0.5;     -- pin the seed for reproducibility
SET log_min_messages = debug2;     -- in development only — extremely verbose
SET log_planner_stats = on;

EXPLAIN (ANALYZE, BUFFERS) SELECT ...;

-- Restore:
RESET log_min_messages;
RESET log_planner_stats;
RESET geqo_seed;
```

The planner-stats output reports how many join orderings were considered. Pre-GEQO threshold queries use dynamic programming and report low numbers; GEQO-eligible queries report a much smaller search space.

### Recipe 10 — Raise statistics target for a skewed column

```sql
-- A column with severe skew (90% one value, 10% spread across 10,000 values):
ALTER TABLE events ALTER COLUMN event_type SET STATISTICS 1000;
ANALYZE events (event_type);

-- Verify:
SELECT attname, attstattarget
FROM pg_attribute
WHERE attrelid = 'events'::regclass AND attname = 'event_type';

-- Inspect the resulting MCV list:
SELECT most_common_vals, most_common_freqs
FROM pg_stats
WHERE tablename = 'events' AND attname = 'event_type';
```

`attstattarget = 1000` means up to 1,000 MCV entries and 1,000 histogram buckets. Useful for highly-skewed columns; wasteful for uniform columns. Cross-reference [`55-statistics-planner.md`](./55-statistics-planner.md).

### Recipe 11 — Audit planner GUCs that changed defaults across versions

```sql
-- Defaults that changed in supported PG majors:
WITH planner_defaults AS (
  SELECT 'random_page_cost'         AS name, '4.0'   AS pg16_default, '4.0'  AS pg18_default, ''            AS note
  UNION ALL SELECT 'effective_io_concurrency',     '1',  '16', 'PG18 raised default to 16'
  UNION ALL SELECT 'maintenance_io_concurrency',   '10', '16', 'PG18 raised default to 16'
  UNION ALL SELECT 'hash_mem_multiplier',          '2.0','2.0','PG15 raised default 1.0 → 2.0'
)
SELECT pd.name, pd.pg16_default, pd.pg18_default, pd.note,
       s.setting AS current_setting,
       s.source
FROM planner_defaults pd
JOIN pg_settings s ON s.name = pd.name
ORDER BY pd.name;
```

Run this on an upgraded cluster to see which carry-forward settings now differ from current-version defaults. Same iteration-34 "PG-version-watershed silently changing behavior" gotcha.

### Recipe 12 — Disable JIT for a short-query workload

```sql
-- Diagnose: does JIT compilation time exceed runtime savings?
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT ...;
-- Look for "JIT:" section showing "Generation Time" — if it dominates,
-- JIT is the wrong tool for this query.

-- Disable JIT for the session:
SET jit = off;
-- or, more granularly, raise the cost threshold:
SET jit_above_cost = 1000000;

-- Test the same query; compare execution time.
```

Cross-reference [`61-jit-compilation.md`](./61-jit-compilation.md).

### Recipe 13 — Test cursor performance for paged readers

```sql
-- Application reads first 100 rows of a large result set:
SET cursor_tuple_fraction = 0.001;   -- plan for "first row fast"

BEGIN;
DECLARE c CURSOR FOR
  SELECT * FROM events ORDER BY created_at DESC;

FETCH 100 FROM c;     -- now uses an Index Scan rather than full sort
CLOSE c;
COMMIT;
```

Set `cursor_tuple_fraction = 0.001` per-session in a paginated-reader connection. Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md).

## Gotchas / Anti-patterns

1. **Setting `random_page_cost < seq_page_cost` is not physically sensible.** The docs explicitly say so. Setting them *equal* makes sense (entire DB in RAM); going lower is masking a different problem.[^docs-cost-constants]

2. **`enable_X = off` in `postgresql.conf` is a cluster-wide footgun.** What works on today's data distribution may produce catastrophic plans tomorrow when row counts shift. Reserve `enable_*` toggles for `SET LOCAL` inside debugging transactions.

3. **`enable_seqscan = off` does not refuse to seq-scan.** It adds a huge cost penalty (`disable_cost = 1e10`); if no other plan exists, the planner still uses seqscan. Same for every other `enable_*` toggle.

4. **`effective_cache_size = 4GB` is the silent default and is almost always wrong.** Set it explicitly. See [`54-memory-tuning.md`](./54-memory-tuning.md) Gotcha #9.

5. **`effective_io_concurrency` is a no-op on Windows.** The setting exists but `posix_fadvise` isn't available.[^docs-resource]

6. **PG18 changed `effective_io_concurrency` and `maintenance_io_concurrency` defaults from 1/10 to 16.** Carry-forward configurations explicitly setting `1`/`10` are now suboptimal — remove the override.[^pg18-io-concurrency]

7. **`enable_group_by_reordering` is PG17, NOT PG18.** Common misattribution. PG18 added `enable_distinct_reordering` and `enable_self_join_elimination` — three different toggles, three different versions.

8. **`recursive_worktable_factor` is PG15, NOT PG17.** Used to estimate the size of the working table in recursive CTEs. Setting it lower than 10.0 produces plans that assume the recursion terminates quickly; setting higher pessimizes.[^pg15-rwf]

9. **`geqo_seed = 0` means non-deterministic plans for queries above `geqo_threshold`.** Two runs of the same query can produce different plans. Pin to a constant value for reproducibility during debugging.[^docs-genetic]

10. **`join_collapse_limit = 1` makes the planner respect textual join order exactly.** A debugging tool, not a production setting. The verbatim docs note: *"if you can find a better plan than the planner can, then set `join_collapse_limit = 1`."*[^docs-other]

11. **Partition-wise joins default `off` because `work_mem` is per-partition.** Enabling cluster-wide with `work_mem = 64MB` and 100 partitions in a join means `64MB × 100 = 6.4 GB` per query. Enable per-session for queries that benefit. Cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) gotcha #4.

12. **`default_statistics_target` cluster-wide affects every ANALYZE.** Raising from 100 to 1000 cluster-wide multiplies ANALYZE time and `pg_statistic` row count by ~10×. Prefer per-column `SET STATISTICS` for the few skewed columns. See [`55-statistics-planner.md`](./55-statistics-planner.md) Gotcha #4.

13. **`constraint_exclusion = on` is legacy.** Default `partition` is correct. Setting `on` cluster-wide applies the legacy mechanism to every query — wastes planning time. Declarative partitioning uses `enable_partition_pruning` (default `on`) instead.

14. **`cursor_tuple_fraction = 1.0` set cluster-wide hurts paginated readers.** Per-session only; pin to `0.01` or lower for paginated workloads, `1.0` for analytics.

15. **`SET random_page_cost = 0.1` does NOT make the planner faster.** It makes the planner *biased toward index plans even when they're not warranted*. The result is more index scans, including some that are slower than the seqscan they replace.

16. **`plan_cache_mode = force_generic_plan` cluster-wide breaks parameter-skewed queries.** Per-session or per-role only.

17. **The cost model has no concept of network/disk latency in milliseconds.** Cost units are pseudo-units. Tuning by "this query takes 2 seconds, so I'll set cost to 2" misunderstands the model.

18. **GEQO above `geqo_threshold = 12` is not deterministic by default.** Operators investigating "why did this query produce a different plan today?" frequently miss that GEQO is the cause.

19. **Disabled-method plans show `Disabled: true` in PG18 EXPLAIN output.** Pre-PG18 there was no marker — operators forgot they had `enable_X = off` set somewhere. Cross-reference [`56-explain.md`](./56-explain.md) Recipe 14.

20. **Bumping `jit_above_cost` to disable JIT is preferable to `jit = off`.** The former leaves the infrastructure available for queries that genuinely benefit; the latter disables everything.

21. **`enable_partitionwise_aggregate` requires GROUP BY on the partition key.** Otherwise no partitionwise plan is eligible regardless of the GUC. Same for partitionwise join.

22. **Carrying forward `random_page_cost = 4.0` (default) on NVMe storage costs 5–10× on index-heavy queries.** This is the single highest-leverage planner change for new clusters on modern storage. The default was set for spinning rust.

23. **The planner does NOT consult `effective_io_concurrency` for plan choice — only for execution-time prefetch.** Setting it high doesn't change plans; it changes how aggressively the executor issues read-ahead for the plan it picked.[^docs-resource]

## See Also

- [`53-server-configuration.md`](./53-server-configuration.md) — GUC mechanism, `pg_settings`, `ALTER SYSTEM`, parameter contexts
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `work_mem`, `effective_cache_size`, `hash_mem_multiplier`, sizing
- [`55-statistics-planner.md`](./55-statistics-planner.md) — `pg_statistic`, `default_statistics_target`, extended stats
- [`56-explain.md`](./56-explain.md) — reading `EXPLAIN ANALYZE` output, BUFFERS, misestimate diagnosis
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — `plan_cache_mode`, generic vs custom plans
- [`23-btree-indexes.md`](./23-btree-indexes.md) — PG18 skip scan
- [`32-buffer-manager.md`](./32-buffer-manager.md) — buffer-pool mechanics, `pg_buffercache`
- [`35-partitioning.md`](./35-partitioning.md) — partitionwise joins, partition pruning
- [`46-roles-privileges.md`](./46-roles-privileges.md) — per-role `ALTER ROLE SET` baseline pattern
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity`, wait events, full pg_stat_* view catalog
- [`60-parallel-query.md`](./60-parallel-query.md) — parallel cost constants, `max_parallel_workers_per_gather`
- [`61-jit-compilation.md`](./61-jit-compilation.md) — JIT cost thresholds, monitoring

## Sources

[^docs-cost-constants]: *PostgreSQL 16: Query Planning § Planner Cost Constants.* https://www.postgresql.org/docs/16/runtime-config-query.html — verbatim: "Although the system will let you set `random_page_cost` to less than `seq_page_cost`, it is not physically sensible to do so. However, setting it equal makes sense if the database is entirely cached in RAM..."

[^docs-enable]: *PostgreSQL 16: Query Planning § Planner Method Configuration.* https://www.postgresql.org/docs/16/runtime-config-query.html — full catalog of all `enable_*` GUCs, defaults, and the verbatim caveat: "This is not the recommended way to tune the query optimizer."

[^docs-genetic]: *PostgreSQL 16: Query Planning § Genetic Query Optimizer.* https://www.postgresql.org/docs/16/runtime-config-query.html — `geqo`, `geqo_threshold`, `geqo_effort`, `geqo_pool_size`, `geqo_generations`, `geqo_selection_bias`, `geqo_seed`.

[^docs-other]: *PostgreSQL 16: Query Planning § Other Planner Options.* https://www.postgresql.org/docs/16/runtime-config-query.html — `default_statistics_target`, `constraint_exclusion`, `cursor_tuple_fraction`, `from_collapse_limit`, `jit`, `join_collapse_limit`, `plan_cache_mode`, `recursive_worktable_factor`.

[^docs-resource]: *PostgreSQL 16: Resource Consumption § Asynchronous Behavior.* https://www.postgresql.org/docs/16/runtime-config-resource.html — `effective_io_concurrency`, `maintenance_io_concurrency` definitions and the Windows-no-op note.

[^pg13-hashmem]: *PostgreSQL 13 Release Notes.* https://www.postgresql.org/docs/release/13.0/ — verbatim: "Allow hash aggregation to use disk storage for large aggregation result sets (Jeff Davis). Previously, hash aggregation was avoided if it was expected to use more than `work_mem` memory. Now, a hash aggregation plan can be chosen despite that. The hash table will be spilled to disk if it exceeds `work_mem` times `hash_mem_multiplier`."

[^pg13-rls]: *PostgreSQL 13 Release Notes.* https://www.postgresql.org/docs/release/13.0/ — verbatim: "Implement incremental sorting (James Coleman, Alexander Korotkov, Tomas Vondra). When sorting requires multiple keys and there is an index on a leading key or keys, the additional keys can be sorted incrementally by using the index ordering."

[^pg14-memoize]: *PostgreSQL 14 Release Notes.* https://www.postgresql.org/docs/release/14.0/ — verbatim: "Add executor method to memoize results from the inner side of a nested-loop join (David Rowley). This is useful if only a small percentage of rows is checked on the inner side. It can be disabled via server parameter `enable_memoize`."

[^pg14-vacm]: *PostgreSQL 14 Release Notes.* https://www.postgresql.org/docs/release/14.0/ — verbatim: "Reduce the default value of `vacuum_cost_page_miss` to better reflect current hardware capabilities (Peter Geoghegan)."

[^pg15-hashmem]: *PostgreSQL 15 Release Notes.* https://www.postgresql.org/docs/release/15.0/ — verbatim: "Increase `hash_mem_multiplier` default to 2.0 (Peter Geoghegan). This allows query hash operations to use more `work_mem` memory than other operations."

[^pg15-rwf]: *PostgreSQL 15 Release Notes.* https://www.postgresql.org/docs/release/15.0/ — verbatim: "Add server variable `recursive_worktable_factor` to allow the user to specify the expected size of the working table of a recursive query (Simon Riggs)."

[^pg16-presorted]: *PostgreSQL 16 Release Notes.* https://www.postgresql.org/docs/release/16.0/ — verbatim: "Add the ability for aggregates having `ORDER BY` or `DISTINCT` to use pre-sorted data (David Rowley). The new server variable `enable_presorted_aggregate` can be used to disable this."

[^pg16-incsort]: *PostgreSQL 16 Release Notes.* https://www.postgresql.org/docs/release/16.0/ — verbatim: "Allow incremental sorts in more cases, including `DISTINCT` (David Rowley)."

[^pg16-gin]: *PostgreSQL 16 Release Notes.* https://www.postgresql.org/docs/release/16.0/ — verbatim: "Improve the accuracy of `GIN` index access optimizer costs (Ronan Dunklau)."

[^pg16-memoize-union]: *PostgreSQL 16 Release Notes.* https://www.postgresql.org/docs/release/16.0/ — verbatim: "Allow memoize atop a `UNION ALL` (Richard Guo)."

[^pg16-parallel-agg]: *PostgreSQL 16 Release Notes.* https://www.postgresql.org/docs/release/16.0/ — verbatim: "Allow aggregate functions `string_agg()` and `array_agg()` to be parallelized (David Rowley)."

[^pg17-gbr]: *PostgreSQL 17 Release Notes.* https://www.postgresql.org/docs/release/17.0/ — verbatim: "Allow `GROUP BY` columns to be internally ordered to match `ORDER BY` (Andrei Lepikhov, Teodor Sigaev). This can be disabled using server variable `enable_group_by_reordering`."

[^pg17-fdw]: *PostgreSQL 17 Release Notes.* https://www.postgresql.org/docs/release/17.0/ — verbatim: "Increase the default foreign data wrapper tuple cost (David Rowley, Umair Shahid). This value is used by the optimizer."

[^pg17-old-snap]: *PostgreSQL 17 Release Notes.* https://www.postgresql.org/docs/release/17.0/ — verbatim: "Remove server variable old_snapshot_threshold (Thomas Munro). This variable allowed vacuum to remove rows that potentially could be still visible to running transactions, causing 'snapshot too old' errors later if accessed."

[^pg18-sje]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Automatically remove some unnecessary table self-joins (Andrey Lepikhov, Alexander Kuzmenkov, Alexander Korotkov, Alena Rybakina). This optimization can be disabled using server variable `enable_self_join_elimination`."

[^pg18-dr]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Allow the keys of `SELECT DISTINCT` to be internally reordered to avoid sorting (Richard Guo). This optimization can be disabled using `enable_distinct_reordering`."

[^pg18-io-concurrency]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Increase server variables `effective_io_concurrency`'s and `maintenance_io_concurrency`'s default values to 16 (Melanie Plageman). This more accurately reflects modern hardware."

[^pg18-skip]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Allow skip scans of btree indexes (Peter Geoghegan). This allows multi-column btree indexes to be used in more cases such as when there are no restrictions on the first or early indexed columns (or there are non-equality ones), and there are useful restrictions on later indexed columns."

[^pg18-gs]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Improve row estimates for `generate_series()` using `numeric` and `timestamp` values (David Rowley, Song Jinzhou)."

[^pg18-fd-gb]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Ignore `GROUP BY` columns that are functionally dependent on other columns (Zhang Mingli, Jian He, David Rowley). If a `GROUP BY` clause includes all columns of a unique index, as well as other columns of the same table, those other columns are redundant and can be dropped from the grouping."

[^pg18-hash]: *PostgreSQL 18 Release Notes.* https://www.postgresql.org/docs/release/18.0/ — verbatim: "Improve the performance and reduce memory usage of hash joins and `GROUP BY` (David Rowley, Jeff Davis). This also improves hash set operations used by `EXCEPT`, and hash lookups of subplan values."

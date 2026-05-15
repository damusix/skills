# Parallel Query

PostgreSQL parallel query execution: parallel-safety markers, worker provisioning, the planner's cost-based decision, parallel plan shapes (Gather, Gather Merge, Parallel Hash Join, Parallel Append, Parallel Index Scan), and the per-version evolution of parallel operations.


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The Five-Rule Mental Model](#the-five-rule-mental-model)
    - [Decision Matrix](#decision-matrix)
    - [Parallel-Safety Markers](#parallel-safety-markers)
    - [Worker Provisioning GUCs](#worker-provisioning-gucs)
    - [Planner Cost GUCs](#planner-cost-gucs)
    - [When Parallel Query Is *Not* Used](#when-parallel-query-is-not-used)
    - [Parallel Plan Nodes](#parallel-plan-nodes)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Load this file when:

- A query is not using parallel workers and you need to know why
- You are marking a `CREATE FUNCTION` body with `PARALLEL SAFE` / `RESTRICTED` / `UNSAFE` and need to know what each means
- You are tuning `max_parallel_workers_per_gather`, `max_parallel_workers`, `max_worker_processes`, or the parallel cost GUCs
- You see `Gather`, `Gather Merge`, `Parallel Seq Scan`, `Parallel Hash Join`, `Parallel Append`, or `Workers Planned` / `Workers Launched` in `EXPLAIN` output and need to interpret it
- You are diagnosing why `Workers Launched < Workers Planned` (the "I asked for 4 workers but only got 2" trap)
- You are debugging parallel plans with `debug_parallel_query` (renamed from `force_parallel_mode` in PG16)
- An operation that you expected to parallelize (`CREATE INDEX`, `VACUUM`, aggregate) is running serially

> [!WARNING] PG16 renamed `force_parallel_mode` → `debug_parallel_query`
> The GUC was **renamed, not removed**. Any postgresql.conf, ALTER ROLE, or session SET that uses the old name will be rejected on PG16+ with `unrecognized configuration parameter`. The GUC moved to the "Developer Options" section because the name reflects its purpose: it's a *debugging tool*, not a production performance knob.[^pg16-rename]


## Syntax / Mechanics


### The Five-Rule Mental Model

PostgreSQL parallel query rests on five rules. Internalize these before reaching for any GUC.

1. **Parallel safety is a function property declared at `CREATE FUNCTION` time** — not a query property. The default is `PARALLEL UNSAFE` and the planner refuses to parallelize any query whose execution might call an unsafe function. The verbatim docs rule: *"All user-defined functions are assumed to be parallel unsafe unless otherwise marked."*[^psafety] Marking a function `PARALLEL SAFE` is a *promise*; if the promise is wrong (the function writes to a table, calls `nextval()`, or modifies session state), parallel execution produces incorrect results or undefined behavior.

2. **Three GUCs cap worker count, and the smallest cap wins.** `max_worker_processes` (default 8, postmaster-restart required) is the cluster-wide background-process pool. `max_parallel_workers` (default 8) caps how many of those can be used for parallel query. `max_parallel_workers_per_gather` (default 2) caps how many a single `Gather` / `Gather Merge` node may launch. The verbatim rule: *"a setting for this value which is higher than max_worker_processes will have no effect, since parallel workers are taken from the pool of worker processes established by that setting."*[^maxworkers]

3. **The planner picks parallel based on cost, not on table size alone.** `min_parallel_table_scan_size` (default 8 MB) and `min_parallel_index_scan_size` (default 512 kB) are the *floor* below which parallel is not considered. Above the floor, `parallel_setup_cost` (default 1000) is the per-query "entry fee" the parallel plan must overcome, and `parallel_tuple_cost` (default 0.1) is the per-tuple shipping cost between workers and leader. A small query that crosses the floor often still chooses a serial plan because the setup cost dominates.

4. **Some operations cannot be parallelized.** Top-level data-modifying operations (`INSERT` / `UPDATE` / `DELETE` / `MERGE`) prevent parallel plans for the entire query, including their subselects. Cursors (`DECLARE CURSOR` / PL/pgSQL `FOR row IN query LOOP`) never use parallel plans. Queries already running inside a parallel worker cannot start another parallel scope. The verbatim rule: *"If a query contains a data-modifying operation either at the top level or within a CTE, no parallel plans for that query will be generated."*[^when-parallel]

5. **The leader can participate or specialize.** `parallel_leader_participation` (default `on`) lets the leader process do work alongside workers — usually correct for query throughput. Set it `off` only when the leader is bottlenecked on coordination (rare) or when you are deliberately measuring worker behavior in isolation.


### Decision Matrix

| You want to... | Set / Check | Default | Production value | Avoid |
|---|---|---|---|---|
| Allow more workers per query | `max_parallel_workers_per_gather` | 2 | 4–8 for analytic clusters | Setting > available CPU cores |
| Increase total parallel capacity | `max_parallel_workers` | 8 | (CPU cores − 1) on dedicated analytics hosts | Setting > `max_worker_processes` |
| Increase background-process pool | `max_worker_processes` | 8 | Same as `max_parallel_workers` + slots for logical workers / pg_cron / etc. | Forgetting this caps everything else |
| Make small queries try parallel | Lower `min_parallel_table_scan_size` | 8MB | Leave alone unless workload is many medium-sized queries | Setting < 1 MB (overhead dominates) |
| Make planner prefer parallel | Lower `parallel_setup_cost` | 1000 | 200–500 on warm caches | Setting < 100 (every trivial query parallelizes) |
| Make planner prefer serial | Raise `parallel_tuple_cost` | 0.1 | Leave alone unless tuple-shipping is a measured bottleneck | Setting too high cluster-wide |
| Force parallel for debugging | `debug_parallel_query = on` (PG16+) or `force_parallel_mode = on` (PG≤15) | off | **Never in production** | Setting in postgresql.conf |
| Run `CREATE INDEX` faster | `max_parallel_maintenance_workers` | 2 | 4–8 for one-off maintenance windows | Setting cluster-wide above what the host can sustain |
| Mark a SQL function parallel-safe | `CREATE FUNCTION ... PARALLEL SAFE` | UNSAFE | Always declare explicitly for new functions | Marking SAFE when the function writes / reads sequences / has side effects |
| Diagnose `Workers Launched < Workers Planned` | Check `max_worker_processes` / `max_parallel_workers` saturation | — | Use `pg_stat_activity` filtered on `backend_type='parallel worker'` | Assuming worker shortage is rare |
| Disable parallel for one query | `SET LOCAL max_parallel_workers_per_gather = 0` | — | Inside a transaction; restore at COMMIT | Permanent ALTER SYSTEM |
| Disable parallel cluster-wide | `max_parallel_workers_per_gather = 0` | — | Only on heavy OLTP clusters where parallel adds latency tail | Generally wrong default |

Three smell signals that a parallel-query configuration is broken:

1. **`Workers Planned` ≫ `Workers Launched` consistently** — the cluster is oversubscribed; raise `max_worker_processes` (and then `max_parallel_workers`) or lower per-query demand
2. **Every query suddenly goes parallel after a setting change** — `parallel_setup_cost` was lowered below the entry barrier for trivial queries; small queries pay setup cost without benefit
3. **CPU is pegged but throughput dropped** — `max_parallel_workers_per_gather × concurrent_queries` exceeds CPU cores; the workers contend with each other


### Parallel-Safety Markers

`CREATE FUNCTION` accepts one of three parallel-safety markers, with `PARALLEL UNSAFE` as the default. The marker is a *contract* the function author makes; the planner trusts it without verification.[^psafety]

| Marker | Meaning | When safe to use |
|---|---|---|
| `PARALLEL UNSAFE` (default) | *"cannot be performed while parallel query is in use, not even in the leader"* | Function writes to tables, calls `nextval()`, modifies GUCs, holds locks, opens cursors, or has any other side effect that depends on a single execution context |
| `PARALLEL RESTRICTED` | *"cannot be performed in a parallel worker, but ... can be performed in the leader while parallel query is in use"* | Function reads session state (`current_user`, temp tables, session-scope GUCs) but does not modify global state; the planner allows parallel plans for sibling subtrees but runs this function only in the leader |
| `PARALLEL SAFE` | *"does not conflict with the use of parallel query"* | Function is deterministic, reads only committed data, makes no writes, calls no parallel-unsafe / parallel-restricted functions, and has no side effects |

A function inherits the strictest parallel-safety of any function it calls. A `PARALLEL SAFE` SQL function that calls a `PARALLEL UNSAFE` function is itself effectively unsafe — the planner walks the call tree.

The verbatim rule on marking accuracy: *"If a function is marked as `PARALLEL SAFE` when it is in reality `PARALLEL UNSAFE`, you may see crashes or wrong results when trying to use the function in a parallel query."*[^psafety]

Built-in functions ship with appropriate markers. To inspect: `SELECT proname, proparallel FROM pg_proc WHERE proparallel <> 's';` returns every user-defined or built-in function that is *not* parallel-safe (`s` = safe, `r` = restricted, `u` = unsafe).


### Worker Provisioning GUCs

Worker counts are bounded by a chain of caps where the smallest wins. All four GUCs default to settings that are conservative for general-purpose clusters but too low for analytics workloads.

| GUC | Default | Context | Effect |
|---|---|---|---|
| `max_worker_processes` | 8 | postmaster | Cluster-wide pool of all background worker slots — parallel workers, logical-replication workers, pg_cron, pg_stat_statements collectors, etc. compete for these slots[^maxworkers] |
| `max_parallel_workers` | 8 | sighup | Of the `max_worker_processes` pool, how many may be used for parallel query at any moment[^maxworkers] |
| `max_parallel_workers_per_gather` | 2 | user | The cap a single `Gather` or `Gather Merge` node may request[^maxworkers] |
| `max_parallel_maintenance_workers` | 2 | user | Per-`CREATE INDEX` / `VACUUM` / `CLUSTER` cap, independent of `max_parallel_workers_per_gather` |

Three operational rules:

1. **`max_worker_processes` is postmaster-restart only.** A SIGHUP reload does not pick up changes; the server must restart. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) for GUC contexts.
2. **`max_parallel_workers > max_worker_processes` is silently ineffective.** No error; the cap is just `min(max_parallel_workers, max_worker_processes − slots-held-by-other-uses)`.
3. **`max_parallel_workers_per_gather = 0` disables parallel query for that scope.** Either session-level (`SET LOCAL`) for one query, role-level (`ALTER ROLE ... SET`) for a tenant, or cluster-wide. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) for per-role defaults.

A baseline analytics-host configuration for a 16-core machine:

```sql
ALTER SYSTEM SET max_worker_processes = 24;          -- 16 parallel + 8 for logical repl / pg_cron / extensions
ALTER SYSTEM SET max_parallel_workers = 16;          -- entire CPU available for parallel
ALTER SYSTEM SET max_parallel_workers_per_gather = 6; -- biggest query can use ~37% of CPU
ALTER SYSTEM SET max_parallel_maintenance_workers = 6; -- one-off CREATE INDEX uses the same budget
-- restart required for max_worker_processes
```


### Planner Cost GUCs

The planner decides parallel by comparing costed plans. Five GUCs drive the comparison.

| GUC | Default | What it controls |
|---|---|---|
| `min_parallel_table_scan_size` | 8MB | Floor: tables smaller than this never get parallel sequential scan considered[^minscan] |
| `min_parallel_index_scan_size` | 512kB | Floor: indexes smaller than this never get parallel index scan considered (also used by parallel VACUUM)[^minscan] |
| `parallel_setup_cost` | 1000 | Entry fee for any parallel plan — modeled as a fixed cost the parallel plan must "earn back" through parallelism[^cost] |
| `parallel_tuple_cost` | 0.1 | Per-tuple shipping cost between workers and leader — penalizes plans that ship many rows[^cost] |
| `parallel_leader_participation` | on | Whether the leader processes rows alongside workers (on) or only coordinates (off) |

The verbatim docs framing: *"`parallel_setup_cost` ... the planner's estimate of the cost of launching parallel worker processes."*[^cost]

The 8 MB / 512 kB defaults are the most-tuned GUCs in this category. On a cluster where mid-sized analytics queries (1–10 GB scans) dominate, leaving them at default is correct. On a cluster where many small "moderate" queries run, lowering `min_parallel_table_scan_size` to 1 MB and `parallel_setup_cost` to 200 makes the planner consider parallel for smaller queries. **Never lower these to dust** — setup overhead dominates below a real threshold.


### When Parallel Query Is *Not* Used

The verbatim rules from `when-can-parallel-query-be-used.html`:[^when-parallel]

1. *"If a query contains a data-modifying operation either at the top level or within a CTE, no parallel plans for that query will be generated."* `INSERT` / `UPDATE` / `DELETE` / `MERGE` at the top level disable parallel; modifying CTEs at any level disable parallel for the whole query.
2. *"A query which is suspended during its execution. In any situation in which the system thinks that partial or incremental execution might occur, no parallel plan is generated. For example, a cursor created using `DECLARE CURSOR` will never use a parallel plan."* PL/pgSQL `FOR row IN SELECT ... LOOP` is rewritten as a cursor and is therefore never parallel.
3. *"A query that runs inside of another query that is already parallel."* No nested parallelism — a parallel-safe function called from a parallel worker runs serially in that worker.
4. The query uses functions marked `PARALLEL RESTRICTED` (forces leader-only) or `PARALLEL UNSAFE` (disables parallel entirely).
5. The transaction isolation level is `SERIALIZABLE` AND the query reads any table whose snapshot semantics require predicate-locking coordination. (Note: PG10+ relaxed this; verify by EXPLAIN if relevant.) Cross-reference [`42-isolation-levels.md`](./42-isolation-levels.md).
6. The query is `SELECT ... FOR UPDATE` / `FOR SHARE` / `FOR NO KEY UPDATE` / `FOR KEY SHARE` at the top level — row-locking is incompatible with parallel plans.
7. The query references a function with side effects on the session (`set_config`, advisory locks acquired during execution, temp-table creation).

> [!NOTE] PostgreSQL 14
> PL/pgSQL `RETURN QUERY` can now execute its query using parallelism — *"Allow plpgsql's `RETURN QUERY` to execute its query using parallelism (Tom Lane)"*.[^pg14-rq] Previously, `RETURN QUERY` ran serially regardless of plan cost.


### Parallel Plan Nodes

The verbatim plan-node rules from `parallel-plans.html`:[^plans]

**Gather and Gather Merge.** Every parallel plan has exactly one `Gather` or `Gather Merge` node at the "parallel boundary." Below the node, the plan runs in parallel workers + optionally the leader; above the node, the plan runs serially in the leader.

- `Gather` returns rows in arbitrary order (whichever worker finishes a tuple first ships it)
- `Gather Merge` returns rows in sorted order, requiring each worker to produce its rows pre-sorted

**Parallel Sequential Scan.** Multiple workers scan disjoint blocks of the same table. Each worker reads `min_parallel_table_scan_size` floor pages or more.

**Parallel Index Scan / Parallel Bitmap Heap Scan.** Workers partition the index leaf pages (parallel index scan) or the heap-block list resulting from a bitmap (parallel bitmap heap scan).

**Parallel Hash Join.** Two variants:
- *Non-parallel hash on parallel-aware outer:* each worker builds its own copy of the hash table from the inner relation
- *Parallel hash:* workers cooperate to build a single shared hash table, then probe in parallel (typically faster for large inners; introduced in PG11)

**Nested Loop.** The verbatim rule: *"the inner side is always non-parallel."* Workers cooperate on outer-side scan but each worker probes the inner serially.

**Merge Join.** The verbatim rule: *"inner side is always a non-parallel plan and therefore executed in full."* Workers must each run a complete inner-side merge against their partition of the outer side.

**Parallel Append.** Workers split across child plans. The verbatim rule: *"the executor will spread out the participating processes as evenly as possible across its child plans."* Contrast with non-parallel `Append` where all workers cooperate on one child at a time. Parallel Append shines when child plans have similar costs; serial Append (within a Gather) shines when one child dominates.

> [!NOTE] PostgreSQL 11
> Parallel Append introduced — *"Allow `Append` operator to execute its children in parallel (Amit Khandekar)"*.[^pg11-pappend] Combined with declarative partitioning, this enables N partitions to be scanned by N workers simultaneously.

**Partial Aggregate / Finalize Aggregate.** Two-stage aggregation: each worker produces a partial state (e.g., `sum` + `count` for an `avg`), the leader (or the post-Gather node) combines partials. This shape is what makes `SELECT COUNT(*)` go parallel on large tables.

EXPLAIN output for a parallel plan looks like:

```
                                       QUERY PLAN
─────────────────────────────────────────────────────────────────────────────────────────
 Finalize Aggregate
   ->  Gather
         Workers Planned: 4
         Workers Launched: 4
         ->  Partial Aggregate
               ->  Parallel Seq Scan on big_events
```

`Workers Planned` is what the planner asked for; `Workers Launched` is what was actually granted. A persistent gap (Launched < Planned) means worker shortage — see Recipe 11 for diagnosis.


### Per-Version Timeline

| PG | Parallel-related changes |
|---|---|
| 14 | `RETURN QUERY` in PL/pgSQL can use parallel plans[^pg14-rq]; async append for parallel-aware foreign scans with `postgres_fdw async_capable=on`[^pg14-async] |
| 15 | `SELECT DISTINCT` can be parallelized[^pg15-distinct]; `postgres_fdw` can issue parallel commits |
| 16 | `force_parallel_mode` renamed to `debug_parallel_query` and moved to developer options[^pg16-rename]; `string_agg()` and `array_agg()` can be parallelized[^pg16-agg]; `FULL` and internal-right `OUTER` hash joins can be parallelized[^pg16-fullhash] |
| 17 | Parallel BRIN index builds[^pg17-brin] (cross-reference [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md)); streaming I/O for sequential reads |
| 18 | Parallel GIN index builds[^pg18-gin] (cross-reference [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)); `parallel_workers_to_launch` and `parallel_workers_launched` columns added to both `pg_stat_database` and `pg_stat_statements`[^pg18-stats] (cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) and [`58-performance-diagnostics.md`](./58-performance-diagnostics.md)) |


## Examples / Recipes


### Recipe 1: Baseline analytics-cluster parallel configuration

For a 16-core dedicated analytics host with 64 GB RAM and a mix of medium-to-large queries (1–100 GB scans):

```ini
# postgresql.conf
max_worker_processes = 24            # 16 parallel + slack for extensions / logical repl / pg_cron
max_parallel_workers = 16
max_parallel_workers_per_gather = 6  # one big query can use ~37% of CPU
max_parallel_maintenance_workers = 6 # one-off CREATE INDEX uses the same budget

# Lower entry barrier for moderate queries (workload-dependent)
parallel_setup_cost = 500            # default 1000 — half the barrier
parallel_tuple_cost = 0.1            # default — leave alone
min_parallel_table_scan_size = 4MB   # default 8MB — let smaller scans go parallel
min_parallel_index_scan_size = 256kB # default 512kB
```

`max_worker_processes` requires a full restart. The others reload on `pg_reload_conf()`.


### Recipe 2: Per-role parallel profile

OLTP-leaning roles should keep low per-query parallelism to preserve concurrency; reporting roles can use more workers per query:

```sql
-- Reporter role — bigger queries, more parallel workers each
ALTER ROLE reporter SET max_parallel_workers_per_gather = 8;
ALTER ROLE reporter SET parallel_setup_cost = 200;

-- Webapp role — keep parallel limited to reduce variance under high concurrency
ALTER ROLE webapp SET max_parallel_workers_per_gather = 2;

-- Batch role — small parallel budget, but high statement_timeout (see 41-transactions.md)
ALTER ROLE batchjobs SET max_parallel_workers_per_gather = 4;
```

Continues the per-role-baseline pattern from [`41-transactions.md`](./41-transactions.md), [`42-isolation-levels.md`](./42-isolation-levels.md), [`46-roles-privileges.md`](./46-roles-privileges.md), [`54-memory-tuning.md`](./54-memory-tuning.md), [`57-pg-stat-statements.md`](./57-pg-stat-statements.md), [`59-planner-tuning.md`](./59-planner-tuning.md).

> [!WARNING] Per-role GUCs and connection poolers
> `ALTER ROLE ... SET` values do NOT propagate across pgBouncer in transaction mode. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6 and [`81-pgbouncer.md`](./81-pgbouncer.md).


### Recipe 3: Mark a user-defined function correctly

Always declare parallel safety explicitly — the default is `UNSAFE`, and an unmarked SQL function will silently disable parallel for every caller.

```sql
-- BAD: defaults to UNSAFE; any query calling this becomes serial
CREATE FUNCTION calc_discount(amount numeric, rate numeric)
RETURNS numeric
AS $$ SELECT amount * (1 - rate) $$
LANGUAGE sql;

-- GOOD: explicit PARALLEL SAFE for a deterministic, side-effect-free function
CREATE OR REPLACE FUNCTION calc_discount(amount numeric, rate numeric)
RETURNS numeric
AS $$ SELECT amount * (1 - rate) $$
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE;

-- Audit which user-defined functions are NOT parallel-safe:
SELECT n.nspname, p.proname,
       CASE p.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted' WHEN 'u' THEN 'unsafe' END AS parallel
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.proparallel <> 's'
ORDER BY n.nspname, p.proname;
```

Cross-reference [`06-functions.md`](./06-functions.md) for volatility (`IMMUTABLE` / `STABLE` / `VOLATILE`) which is orthogonal to parallel safety.


### Recipe 4: Force parallel plan for testing

Use `debug_parallel_query` (PG16+) or `force_parallel_mode` (PG≤15) to verify a parallel plan works correctly — never in production.

```sql
-- PG16+
SET debug_parallel_query = on;

-- PG≤15
SET force_parallel_mode = on;

-- PG≤15 + value 'regress' wraps single-process plans in Gather for testing
SET force_parallel_mode = regress;

-- Then run your query:
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT * FROM big_table WHERE ...;
```

> [!WARNING] Never set debug_parallel_query in postgresql.conf
> The verbatim docs warning: *"`debug_parallel_query` and `force_parallel_mode` may be useful for testing whether parallel execution is occurring, and how parallel queries behave, but they are not intended for production use."* Setting it cluster-wide forces parallel plans even when they are slower — query latency increases and overall throughput drops.[^pg16-rename]


### Recipe 5: Disable parallel for one query

When a specific query runs worse under parallel (memory pressure, lock contention, parameter-skewed plan):

```sql
BEGIN;
SET LOCAL max_parallel_workers_per_gather = 0;
SELECT ...;  -- runs serially
COMMIT;
```

`SET LOCAL` is automatically scoped to the transaction. Use this inside cron-scheduled batch jobs that you want to keep predictable.


### Recipe 6: Diagnose `Workers Launched < Workers Planned`

The most common parallel-query complaint is "the plan says Workers Planned: 4 but Workers Launched: 2."

```sql
-- Check 1: Is max_parallel_workers saturated cluster-wide?
SELECT setting FROM pg_settings WHERE name IN ('max_worker_processes', 'max_parallel_workers');

-- Check 2: Are workers actually busy elsewhere?
SELECT pid, backend_type, query_start, state, query
FROM pg_stat_activity
WHERE backend_type IN ('parallel worker', 'background worker')
ORDER BY query_start;

-- Check 3: Is leader_pid populated? Live parallel workers will show leader_pid pointing at their gather query
SELECT leader_pid, pid, application_name, state, query
FROM pg_stat_activity
WHERE leader_pid IS NOT NULL
ORDER BY leader_pid, pid;
```

The fix is usually to raise `max_worker_processes` (full restart required) AND `max_parallel_workers`, in that order. Cross-reference [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) for the full `pg_stat_activity` surface.


### Recipe 7: Parallel CREATE INDEX

`CREATE INDEX` (B-tree, BRIN PG17+, GIN PG18+) parallelizes if `max_parallel_maintenance_workers > 0` and the index size justifies it. `CREATE INDEX CONCURRENTLY` does **not** parallelize at all.

```sql
-- One-off maintenance window: raise parallel budget temporarily
SET maintenance_work_mem = '4GB';
SET max_parallel_maintenance_workers = 8;

CREATE INDEX big_table_payload_gin ON big_table USING gin (payload jsonb_path_ops);

-- Verify it actually parallelized:
-- Look for "Workers Launched" in EXPLAIN (ANALYZE) of the index build, or check the log
-- with log_min_duration_statement and a verbose maintenance_work_mem allocation message.
```

Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md) for the CONCURRENTLY-cannot-parallelize gotcha, [`23-btree-indexes.md`](./23-btree-indexes.md) for parallel B-tree builds (PG11+), [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for parallel GIN (PG18+), and [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) for parallel BRIN (PG17+).


### Recipe 8: Parallel VACUUM (PG13+)

```sql
-- VACUUM PARALLEL n only applies to index cleanup phase, not the heap scan
VACUUM (PARALLEL 4, VERBOSE) big_table;

-- Cluster-wide default for autovacuum and manual VACUUM
ALTER SYSTEM SET max_parallel_maintenance_workers = 4;
SELECT pg_reload_conf();
```

The number of workers used is `min(PARALLEL n, max_parallel_maintenance_workers, count(indexes-larger-than-min_parallel_index_scan_size))`. Cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the full VACUUM surface.


### Recipe 9: Read EXPLAIN output for a parallel aggregate

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT COUNT(*) FROM big_events;
```

```
 Finalize Aggregate  (cost=... rows=1 width=8) (actual time=... rows=1 loops=1)
   ->  Gather  (cost=... rows=4 width=8) (actual time=... rows=5 loops=1)
         Workers Planned: 4
         Workers Launched: 4
         ->  Partial Aggregate  (cost=... rows=1 width=8) (actual time=... rows=1 loops=5)
               ->  Parallel Seq Scan on big_events  (cost=... rows=... width=0) (actual time=... rows=... loops=5)
```

Reading rules:
- `Partial Aggregate` and `Parallel Seq Scan` show `loops=5` (4 workers + 1 leader, since `parallel_leader_participation = on`)
- Each loop processed `rows / loops` rows on average
- `Gather` returns 5 rows (one partial aggregate per loop) which `Finalize Aggregate` combines into 1
- Cross-reference [`56-explain.md`](./56-explain.md) for the full reading guide

If `Workers Launched = 0`, the leader did all work alone — this happens when the cluster is worker-starved, not a planner decision.


### Recipe 10: Parallel Append for partitioned tables

When querying a partitioned table that scans many partitions, `Parallel Append` lets workers split across partitions instead of cooperating on one at a time.

```sql
-- Enable partition-wise plans for full effect (off by default — see 35-partitioning.md gotcha #13)
SET enable_partitionwise_join = on;
SET enable_partitionwise_aggregate = on;

EXPLAIN (ANALYZE, COSTS off)
SELECT count(*) FROM events_partitioned WHERE occurred_at > now() - interval '7 days';
```

Look for `Parallel Append` (workers split across children) vs `Append` (workers cooperate on one child at a time). Cross-reference [`35-partitioning.md`](./35-partitioning.md).


### Recipe 11: Track parallel utilization over time (PG18+)

```sql
-- PG18+: pg_stat_database tracks parallel-worker activity per database
SELECT datname, parallel_workers_to_launch, parallel_workers_launched,
       parallel_workers_launched::numeric / NULLIF(parallel_workers_to_launch, 0) AS launch_ratio
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY parallel_workers_to_launch DESC;

-- PG18+: pg_stat_statements with parallel columns to find queries with worker shortages
SELECT query, calls, parallel_workers_to_launch, parallel_workers_launched,
       parallel_workers_launched::numeric / NULLIF(parallel_workers_to_launch, 0) AS launch_ratio
FROM pg_stat_statements
WHERE parallel_workers_to_launch > 0
ORDER BY (parallel_workers_to_launch - parallel_workers_launched) DESC
LIMIT 20;
```

A persistent ratio < 0.9 means worker starvation. Pre-PG18, you can only see launch shortage in live `EXPLAIN ANALYZE` output. Cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) and [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).


### Recipe 12: Inspect live parallel workers

```sql
-- Workers in flight, grouped by leader
SELECT leader_pid, count(*) AS workers, max(query_start) AS started
FROM pg_stat_activity
WHERE backend_type = 'parallel worker' AND leader_pid IS NOT NULL
GROUP BY leader_pid
ORDER BY started;

-- Join to find what each leader is doing
SELECT l.pid AS leader_pid, l.query AS leader_query,
       array_agg(w.pid ORDER BY w.pid) AS worker_pids
FROM pg_stat_activity l
JOIN pg_stat_activity w ON w.leader_pid = l.pid
WHERE w.backend_type = 'parallel worker'
GROUP BY l.pid, l.query;
```


### Recipe 13: Test PG18 parallel GIN build

```sql
-- PG18+ enables parallel GIN builds at CREATE INDEX time (NOT for CIC, see gotcha #15)
SET maintenance_work_mem = '4GB';
SET max_parallel_maintenance_workers = 8;

\timing on
CREATE INDEX docs_payload_gin ON docs USING gin (payload);

-- Verify by checking pg_stat_progress_create_index during build:
SELECT pid, phase, blocks_total, blocks_done, tuples_total, tuples_done
FROM pg_stat_progress_create_index;
```

Cross-reference [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for the GIN deep dive and [`26-index-maintenance.md`](./26-index-maintenance.md) for `pg_stat_progress_create_index` columns.


### Recipe 14: Async append for postgres_fdw (PG14+)

When a query touches multiple foreign tables on different remote servers, `postgres_fdw` can run their scans **in parallel** by issuing the remote queries asynchronously. This is distinct from the parallel-workers machinery — no local backend workers are spawned — but it parallelizes the I/O waits.

```sql
-- Step 1: Mark the foreign server as async-capable (default off — must opt in)
ALTER SERVER remote1 OPTIONS (ADD async_capable 'true');
ALTER SERVER remote2 OPTIONS (ADD async_capable 'true');

-- Step 2: Confirm via psql
SELECT srvname, srvoptions FROM pg_foreign_server;

-- Step 3: A UNION ALL across both servers will now issue both remote queries
--         in parallel rather than serially:
EXPLAIN (ANALYZE, VERBOSE)
SELECT * FROM remote1_sales WHERE event_date = current_date
UNION ALL
SELECT * FROM remote2_sales WHERE event_date = current_date;
-- Look for "Async Capable: true" on each Foreign Scan node
```

Continues iteration-66 cross-reference to `70-fdw.md`. The PG14 release-note verbatim: *"Allow a query referencing multiple foreign tables to perform foreign table scans in parallel."*[^pg14-async] Without `async_capable=true` on each server, the scans run serially.


## Gotchas / Anti-patterns

1. **`PARALLEL UNSAFE` is the default for user-defined functions** — and the planner refuses parallel plans for any query that might call an unsafe function. New SQL/PL functions must explicitly declare `PARALLEL SAFE` or every caller silently becomes serial.

2. **Marking `PARALLEL SAFE` when the function has side effects produces wrong results.** The verbatim docs warning: *"you may see crashes or wrong results"*.[^psafety] A `PARALLEL SAFE` function that calls `nextval()`, writes to a table, or uses `SET LOCAL` is a lie to the planner.

3. **`max_parallel_workers > max_worker_processes` is silently ineffective.** The cap is the smaller of the two. Operators set `max_parallel_workers = 32` and wonder why queries top out at 8 workers — the answer is `max_worker_processes = 8` (the default).

4. **`max_worker_processes` requires a full server restart.** SIGHUP reload does not pick up changes. Plan a restart window when raising it.

5. **`max_worker_processes` is shared with logical replication, pg_cron, parallel logical-apply workers, and extensions.** Setting it equal to `max_parallel_workers` starves the other consumers. Reserve at least 4–8 slots for non-parallel-query background workers.

6. **`max_parallel_workers_per_gather = 0` disables parallel query entirely for that scope.** A common "fix" for parallel-related issues that surprises operators later who can't figure out why queries don't parallelize.

7. **PG16 renamed `force_parallel_mode` to `debug_parallel_query`.** Carry-forward postgresql.conf files from PG≤15 produce `unrecognized configuration parameter` errors on PG16+. The new name lives in `runtime-config-developer.html`.[^pg16-rename]

8. **`debug_parallel_query` / `force_parallel_mode` is for testing, not production.** Setting it on cluster-wide forces parallel plans that the planner deliberately rejected — these plans are slower, not faster. The verbatim docs description names it under "Developer Options."

9. **Data-modifying queries cannot parallelize.** `INSERT INTO ... SELECT ...`, `UPDATE ... FROM ...`, `DELETE`, `MERGE`, and CTEs containing any of these disable parallel for the whole query. The workaround for `INSERT INTO ... SELECT large_query` is `COPY` from a parallel-friendly export (cross-reference [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md)) or staging-table-then-INSERT.

10. **Cursors and PL/pgSQL row loops disable parallel.** `DECLARE CURSOR ... SELECT ...`, `FETCH FROM cursor`, and PL/pgSQL `FOR row IN SELECT ... LOOP` all become serial. PL/pgSQL `RETURN QUERY` was the exception added in PG14[^pg14-rq] — use it instead of a `FOR ... LOOP` to retain parallelism.

11. **`SELECT ... FOR UPDATE` (and siblings) disables parallel.** Row-level locking is incompatible with parallel plans. If you need both, split: read the rows in a parallel SELECT, then issue locking statements separately.

12. **The leader is one of the workers.** With `parallel_leader_participation = on` (default), `Workers Launched: 4` means the work is done by 5 processes (4 + leader), not 4. EXPLAIN's `loops=5` reflects this. Turning leader participation off is rare — usually correct only when measuring worker behavior in isolation.

13. **`Workers Launched < Workers Planned` is a sign of worker starvation, not planner bug.** The planner computed how many it wanted; the runtime granted what was available. Diagnose with `pg_stat_activity backend_type='parallel worker'` to find who's holding the slots.

14. **Parallel workers each get their own `work_mem`.** A query with 4 workers + leader running a hash join with `work_mem = 256MB` may consume `5 × 256MB = 1.25 GB` of memory. Cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) gotcha #4.

15. **`CREATE INDEX CONCURRENTLY` does NOT parallelize.** Only the non-CONCURRENTLY form can use parallel workers, and only for B-tree (PG11+), BRIN (PG17+), GIN (PG18+). Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md) gotcha #21.

16. **`pg_stat_activity` shows `leader_pid IS NULL` for the leader and `leader_pid = leader.pid` for workers.** A common mistake is filtering `WHERE leader_pid IS NOT NULL` to find "parallel queries" and missing the leader. To include both: `WHERE backend_type = 'client backend' AND pid IN (SELECT leader_pid FROM pg_stat_activity WHERE leader_pid IS NOT NULL) OR backend_type = 'parallel worker'`.

17. **Parallel hash join builds N copies of the hash table** unless you have `enable_parallel_hash = on` (default since PG11). Without it, each worker re-builds the hash from scratch, wasting memory and CPU.

18. **Parallel `Append` requires children to have similar costs to be a win.** When one partition dominates the query, serial `Append` with all workers on that partition is better. The planner usually picks correctly, but `enable_parallel_append = off` is the debugging escape hatch.

19. **`parallel_setup_cost` lowered to 0 makes trivial queries parallelize.** A `SELECT 1` going through a Gather node is slower than serial. Keep `parallel_setup_cost >= 100` for any production setting.

20. **The first execution of a query may parallelize differently from subsequent executions.** Plan caching with prepared statements interacts with parallel decisions — a generic plan may not parallelize even when custom plans would. Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) for `plan_cache_mode`.

21. **PG18 added `parallel_workers_to_launch` and `parallel_workers_launched` to TWO places:** `pg_stat_database` (cluster-wide aggregate) and `pg_stat_statements` (per-query). Monitoring queries written for one view may miss the other.[^pg18-stats]

22. **Parallel-restricted is rare and easy to miss.** Most built-in functions are either safe or unsafe; only a handful (e.g., functions that access session-scoped temp tables) are restricted. Don't reach for restricted unless you have a specific reason — it forces leader-only execution and prevents the worker side from progressing.

23. **Setting `max_parallel_workers_per_gather` cluster-wide in postgresql.conf affects every connection.** Many teams set it to 4 cluster-wide, then wonder why their concurrent OLTP traffic suddenly degrades — 200 concurrent queries × 4 workers = 800 worker requests on an 8-slot pool. Set it per-role (Recipe 2) or per-session (Recipe 5) instead.

24. **`async_capable=on` is a `postgres_fdw` server-level opt-in, not automatic.** PG14 added the *capability* for foreign-table scans to run asynchronously, but every foreign server must explicitly set `ALTER SERVER ... OPTIONS (ADD async_capable 'true')` to use it.[^pg14-async] Without the option, `UNION ALL` queries across remote tables run serially even on PG14+.

25. **`parallel_leader_participation = off` does NOT free workers for other queries.** It only changes whether the leader does work — the leader process still exists, still runs the plan tree above the Gather node, and still consumes one of the `max_parallel_workers_per_gather` slots conceptually. Turning it off rarely improves throughput; usually it slows the query because one fewer process is processing rows.


## See Also

- [`06-functions.md`](./06-functions.md) — PARALLEL SAFE/RESTRICTED/UNSAFE markers in `CREATE FUNCTION`
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — cursors never parallelize; prepared statement plan caching interaction
- [`23-btree-indexes.md`](./23-btree-indexes.md) — parallel B-tree builds (PG11+)
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — parallel GIN builds (PG18+)
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — parallel BRIN builds (PG17+)
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY` does NOT parallelize
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — `VACUUM (PARALLEL n)` and `max_parallel_maintenance_workers`
- [`35-partitioning.md`](./35-partitioning.md) — Parallel Append + partition-wise plans
- [`41-transactions.md`](./41-transactions.md) — `SET LOCAL` for scoped parallel disable
- [`42-isolation-levels.md`](./42-isolation-levels.md) — SERIALIZABLE interactions with parallel
- [`46-roles-privileges.md`](./46-roles-privileges.md) — per-role `ALTER ROLE SET max_parallel_workers_per_gather`
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC contexts (postmaster vs sighup vs user)
- [`54-memory-tuning.md`](./54-memory-tuning.md) — work_mem multiplication across parallel workers
- [`56-explain.md`](./56-explain.md) — reading Gather / Workers Planned / Workers Launched
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — PG18 `parallel_workers_*` columns
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity.backend_type` and `leader_pid`
- [`59-planner-tuning.md`](./59-planner-tuning.md) — `parallel_setup_cost`, `parallel_tuple_cost`, min_parallel_*
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — parallel-friendly COPY as INSERT alternative
- [`72-extension-development.md`](./72-extension-development.md) — `PARALLEL SAFE/RESTRICTED/UNSAFE` annotation is a primary concern when writing C extensions
- [`81-pgbouncer.md`](./81-pgbouncer.md) — transaction-mode pooling and per-role GUCs


## Sources

[^psafety]: "Parallel Safety" — PostgreSQL 16 documentation. Defines PARALLEL SAFE/RESTRICTED/UNSAFE markers and the rule that "All user-defined functions are assumed to be parallel unsafe unless otherwise marked" plus the explicit warning that incorrect marking "may see crashes or wrong results." https://www.postgresql.org/docs/16/parallel-safety.html

[^maxworkers]: "Resource Consumption — Asynchronous Behavior" — PostgreSQL 16 documentation. Defines `max_worker_processes`, `max_parallel_workers`, `max_parallel_workers_per_gather`, `max_parallel_maintenance_workers`, including the verbatim rule "a setting for this value which is higher than max_worker_processes will have no effect, since parallel workers are taken from the pool of worker processes established by that setting." https://www.postgresql.org/docs/16/runtime-config-resource.html

[^minscan]: "Query Planning" — PostgreSQL 16 documentation. Defines `min_parallel_table_scan_size` (default 8MB) and `min_parallel_index_scan_size` (default 512kB). https://www.postgresql.org/docs/16/runtime-config-query.html

[^cost]: "Query Planning — Planner Cost Constants" — PostgreSQL 16 documentation. Defines `parallel_setup_cost` (1000) and `parallel_tuple_cost` (0.1) with the verbatim "the planner's estimate of the cost of launching parallel worker processes." https://www.postgresql.org/docs/16/runtime-config-query.html

[^when-parallel]: "When Can Parallel Query Be Used?" — PostgreSQL 16 documentation. Contains the verbatim rules: "If a query contains a data-modifying operation either at the top level or within a CTE, no parallel plans for that query will be generated" and "a cursor created using DECLARE CURSOR will never use a parallel plan." https://www.postgresql.org/docs/16/when-can-parallel-query-be-used.html

[^plans]: "Parallel Plans" — PostgreSQL 16 documentation. Documents Gather/Gather Merge, Parallel Sequential Scan, Parallel Index Scan, Parallel Bitmap Heap Scan, Parallel Hash Join (with the "inner side is always non-parallel" rule for Nested Loop and Merge Join), and Parallel Append with verbatim "the executor will spread out the participating processes as evenly as possible across its child plans." https://www.postgresql.org/docs/16/parallel-plans.html

[^pg14-rq]: PG14 release notes verbatim: "Allow plpgsql's RETURN QUERY to execute its query using parallelism (Tom Lane)." https://www.postgresql.org/docs/release/14.0/

[^pg14-async]: PG14 release notes verbatim: "Allow a query referencing multiple foreign tables to perform foreign table scans in parallel (Robert Haas, Kyotaro Horiguchi, Thomas Munro, Etsuro Fujita)." `postgres_fdw` requires `async_capable=on`. https://www.postgresql.org/docs/release/14.0/

[^pg15-distinct]: PG15 release notes verbatim: "Allow SELECT DISTINCT to be parallelized (David Rowley)." https://www.postgresql.org/docs/release/15.0/

[^pg16-rename]: PG16 release notes verbatim: "Rename server variable force_parallel_mode to debug_parallel_query (David Rowley). The new name better reflects the purpose of the setting." The GUC moved to "Developer Options" section. https://www.postgresql.org/docs/release/16.0/

[^pg16-agg]: PG16 release notes verbatim: "Allow aggregate functions string_agg() and array_agg() to be parallelized (David Rowley)." https://www.postgresql.org/docs/release/16.0/

[^pg16-fullhash]: PG16 release notes verbatim: "Allow parallelization of FULL and internal right OUTER hash joins (Melanie Plageman, Thomas Munro)." https://www.postgresql.org/docs/release/16.0/

[^pg17-brin]: PG17 release notes verbatim: "Allow BRIN indexes to be created using parallel workers (Tomas Vondra, Matthias van de Meent)." https://www.postgresql.org/docs/release/17.0/

[^pg18-gin]: PG18 release notes verbatim: "Allow GIN indexes to be created in parallel (Tomas Vondra, Matthias van de Meent)." https://www.postgresql.org/docs/release/18.0/

[^pg18-stats]: PG18 release notes verbatim: "Add pg_stat_statements columns to report parallel activity (Guillaume Lelarge)." Columns `parallel_workers_to_launch` and `parallel_workers_launched` were added to both `pg_stat_database` and `pg_stat_statements`. https://www.postgresql.org/docs/release/18.0/

[^pg11-pappend]: PG11 release notes verbatim: "Allow Append operator to execute its children in parallel (Amit Khandekar)." This enables Parallel Append, used heavily by partitioned-table queries. https://www.postgresql.org/docs/release/11.0/

# EXPLAIN — Plan Inspection and Diagnosis

`EXPLAIN` is the planner's interview surface. `EXPLAIN ANALYZE` is the executor's. Together they answer almost every "why is this query slow?" question, but only if you read them correctly. This file covers the full option surface, every plan node you will encounter in production, and the diagnostic flow from a slow query to a remediation.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Grammar](#grammar)
    - [Options Catalog](#options-catalog)
    - [Plan Node Catalog](#plan-node-catalog)
    - [Reading the Output](#reading-the-output)
    - [BUFFERS Interpretation](#buffers-interpretation)
    - [Diagnosing Row-Count Misestimates](#diagnosing-row-count-misestimates)
    - [auto_explain](#auto_explain)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach here when:

- A query is slower than expected and you need to read its plan.
- The planner's estimated row counts diverge from reality and you need to identify which node is the source.
- You need to decide between `EXPLAIN`, `EXPLAIN ANALYZE`, `EXPLAIN (ANALYZE, BUFFERS)`, `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)`, or `EXPLAIN (GENERIC_PLAN)` for a parameterized query.
- You need to enable `auto_explain` to capture plans for queries already running in production.
- You need to distinguish "the query is doing too much work" (CPU/IO) from "the planner picked the wrong plan" (row-count misestimate, missing extended statistics, stale stats).

If you are looking for *what the cost numbers mean* and how to tune them, see [`59-planner-tuning.md`](./59-planner-tuning.md). If the issue is the statistics behind the plan rather than the plan itself, see [`55-statistics-planner.md`](./55-statistics-planner.md). For per-query tracking of plans across thousands of executions, see [`57-pg-stat-statements.md`](./57-pg-stat-statements.md).

## Mental Model

Five rules drive most diagnostic flows:

1. **`EXPLAIN` shows the planner's cost model; `EXPLAIN ANALYZE` actually runs the query.** Verbatim from the docs: *"Keep in mind that the statement is actually executed when the `ANALYZE` option is used. Although `EXPLAIN` will discard any output that a `SELECT` would return, other side effects of the statement will happen as usual."*[^side-effect] For `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`CREATE TABLE AS`, wrap in `BEGIN; ... ROLLBACK;` to inspect without committing.

2. **Read plans bottom-up.** Plan-tree leaves execute first (scans), parents execute against their children's output (joins, sorts, aggregates), root produces the final result. The indentation in `text` format is the tree structure. Start at the most-indented node (deepest leaf), understand what it produces, then move up one level at a time to its parent. The root node (least indented, printed last) is the final output step. When diagnosing a slow query, find the first node walking bottom-up where `actual rows` diverges significantly from `rows` (estimated) — that node is where the planner's model broke. Everything above it is operating on bad cardinality estimates.

3. **The `rows` value is the number emitted by the node, not scanned.** Verbatim: *"The `rows` value is a little tricky because it is not the number of rows processed or scanned by the plan node, but rather the number emitted by the node. This is often less than the number scanned, as a result of filtering by any `WHERE`-clause conditions that are being applied at the node."*[^rows-emitted] Compare to "Rows Removed by Filter" in `EXPLAIN ANALYZE` output to see what was scanned vs returned.

4. **`actual rows` × 10 ≠ `estimate` rows is the canonical misestimate signal.** A 10×+ divergence at any plan node almost always indicates stale statistics, missing extended statistics for correlated columns, or a planner-blind expression. Track which node first diverges as you walk up the tree — that node's children are correct; the node itself is where the planner's model breaks.

5. **`BUFFERS` is the source of truth for I/O.** Cost numbers are estimates; `buffers shared hit/read/dirtied/written` and `temp read/written` are actual. Always use `EXPLAIN (ANALYZE, BUFFERS)` for performance work. `BUFFERS` is automatic with `ANALYZE` in PG18+[^pg18-buffers-auto] but must be requested explicitly on PG17 and earlier.

### How to Walk a Plan

```
Gather  (cost=1000.0..2340.1 rows=500 width=32) (actual rows=483 loops=1)
  ->  Hash Join  (cost=120.5..1200.3 rows=500 width=32) (actual rows=483 loops=1)
        Hash Cond: (o.user_id = u.id)
        ->  Seq Scan on orders o  (cost=0.0..980.2 rows=10000 width=24) (actual rows=10000 loops=1)
        ->  Hash  (cost=90.0..90.0 rows=2000 width=16) (actual rows=1983 loops=1)
              ->  Index Scan using users_pkey on users u  (cost=0.4..90.0 rows=2000 width=16) (actual rows=1983 loops=1)
```

Reading procedure — always bottom-up:

1. **Deepest leaf first:** `Index Scan on users` — scans the `users` table via primary key, estimated 2000 rows, actual 1983. Estimate good.
2. **Its parent:** `Hash` — materializes the index scan result into a hash table. Fine.
3. **Sibling leaf:** `Seq Scan on orders` — estimated 10000, actual 10000. Fine.
4. **Their parent:** `Hash Join` — joins orders to the hash table. estimated 500, actual 483. Fine.
5. **Root:** `Gather` — collects parallel worker output. Fine.

If the Hash Join had shown `rows=500` estimated vs `actual rows=50000`, that node is the first divergence. Its children were correct, so the misestimate is in the join condition's cardinality model — likely correlated columns or stale statistics on `orders`. Fix: `ANALYZE orders;` and/or `CREATE STATISTICS` for correlated columns.

## Decision Matrix

| You want to … | Use | Avoid | Why |
|---|---|---|---|
| Inspect plan without running the query | `EXPLAIN <stmt>` | `EXPLAIN ANALYZE` for queries with side effects without wrapping in `BEGIN; ... ROLLBACK;` | `ANALYZE` actually executes the statement[^side-effect] |
| Diagnose a slow `SELECT` | `EXPLAIN (ANALYZE, BUFFERS) <stmt>` | bare `EXPLAIN ANALYZE` | Without `BUFFERS` you cannot distinguish cache-hit from disk-read cost |
| Diagnose a slow `SELECT` on PG18+ | `EXPLAIN ANALYZE <stmt>` | redundant `BUFFERS` keyword (still works, harmless) | PG18 includes `BUFFERS` automatically[^pg18-buffers-auto] |
| Verify a parameterized query's generic plan | `EXPLAIN (GENERIC_PLAN) <stmt with $1...>` | `EXPLAIN ANALYZE` (incompatible) | `GENERIC_PLAN` cannot be combined with `ANALYZE`[^generic-plan] |
| See which GUCs are altered from default | `EXPLAIN (SETTINGS) <stmt>` | guessing from query text alone | Captures session-overridden planner GUCs[^settings] |
| Measure WAL emitted by an `INSERT`/`UPDATE`/`DELETE` | `EXPLAIN (ANALYZE, WAL) <stmt>` | `EXPLAIN ANALYZE` alone | WAL counters only with `ANALYZE`[^wal-opt] |
| Measure result-serialization cost on PG17+ | `EXPLAIN (ANALYZE, SERIALIZE TEXT)` | not measuring it | Catches TOAST de-TOAST + datatype output-function cost[^serialize] |
| Measure planner memory consumption PG17+ | `EXPLAIN (MEMORY)` | guessing from heap-usage | Reports planner in-memory structure usage[^memory] |
| Get machine-parseable plan | `EXPLAIN (FORMAT JSON) <stmt>` | text format for tooling | JSON/XML/YAML are structured |
| Capture plans of slow queries already running in prod | enable `auto_explain` | `EXPLAIN ANALYZE`-by-hand-per-query | Background; logs plans of queries exceeding `log_min_duration`[^auto-explain] |
| Estimate true I/O time | enable `track_io_timing` + `EXPLAIN (ANALYZE, BUFFERS)` | bare `BUFFERS` (counts blocks but no time) | `track_io_timing` adds time spent reading/writing to BUFFERS output[^track-io-timing] |
| Compute selectivity error of a join | look at `rows` actual/estimated ratio at the join node, walk up | guessing | The first 10×+ divergence node is the misestimate source |

Three smell signals that something is wrong before you even read the plan:

- `actual rows=N loops=M` where `M × estimated_rows ≠ N`: the planner mis-cardinality-estimated; check pg_stats for the relevant columns.
- `Rows Removed by Filter:` very large fraction of scanned rows: the index or predicate-push-down opportunity is being missed; cross-reference [`22-indexes-overview.md`](./22-indexes-overview.md).
- `Heap Fetches:` non-zero on an Index Only Scan: visibility map is behind; the table needs `VACUUM` more frequently; cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

## Syntax / Mechanics

### Grammar

The PG16 grammar (PG17 and PG18 added `SERIALIZE` and `MEMORY` respectively):

```sql
EXPLAIN [ ( option [, ...] ) ] statement
EXPLAIN [ ANALYZE ] [ VERBOSE ] statement

where option can be one of:

    ANALYZE [ boolean ]
    VERBOSE [ boolean ]
    COSTS [ boolean ]
    SETTINGS [ boolean ]              -- PG12+
    GENERIC_PLAN [ boolean ]          -- PG16+
    BUFFERS [ boolean ]
    SERIALIZE [ { NONE | TEXT | BINARY } ]  -- PG17+
    MEMORY [ boolean ]                -- PG17+
    WAL [ boolean ]                   -- PG13+
    TIMING [ boolean ]
    SUMMARY [ boolean ]
    FORMAT { TEXT | XML | JSON | YAML }
```

The short form (`EXPLAIN [ ANALYZE ] [ VERBOSE ] stmt`) is kept for compatibility but most production usage should use the parenthesized form, which permits arbitrary option ordering and the version-introduced options.

### Options Catalog

| Option | Default | Version | What it does |
|---|---|---|---|
| `ANALYZE` | `false` | all | Actually executes the query and reports real timing/rows[^analyze] |
| `VERBOSE` | `false` | all | Show output columns of each node, schema-qualify table names, show worker details |
| `COSTS` | `true` | all | Show estimated startup/total cost (turn off for diffable plans) |
| `SETTINGS` | `false` | PG12+ | List planner GUCs overridden from default[^settings] |
| `GENERIC_PLAN` | `false` | PG16+ | Generate plan for parameterized statement (`$1`, `$2`, …) without binding values[^generic-plan] |
| `BUFFERS` | `false` (auto with `ANALYZE` in PG18+) | all (PG18 default change) | Block-level I/O accounting[^buffers] |
| `SERIALIZE` | `NONE` | PG17+ | Time spent converting result rows to text/binary wire format[^serialize] |
| `MEMORY` | `false` | PG17+ | Planner memory consumption[^memory] |
| `WAL` | `false` | PG13+ | WAL records, FPI count, bytes generated, buffer-full count (PG18+)[^wal-opt][^pg18-wal] |
| `TIMING` | `true` (only when `ANALYZE`) | all | Per-node wall-clock time. Disable on systems with slow `gettimeofday()`[^timing] |
| `SUMMARY` | depends | all | Planning time + execution time (auto-on with `ANALYZE`, default off without) |
| `FORMAT` | `TEXT` | all | `TEXT`/`XML`/`JSON`/`YAML` — JSON for tooling like pgMustard, depesz.com |

#### ANALYZE

Verbatim from docs: *"Carry out the command and show actual run times and other statistics."*[^analyze] Combine with `BUFFERS`, `WAL`, `SERIALIZE`, `TIMING`, `SUMMARY` to get a full execution picture. The query is *fully executed* — same locks, same triggers, same side effects.

> [!WARNING] `EXPLAIN ANALYZE` is not free
> Per-node timing instrumentation adds overhead via `gettimeofday()` calls. On systems with slow clock sources, the overhead can be 30%+ of execution time and skew totals. Use `TIMING OFF` if you only care about rows and buffers.[^timing]

For mutating statements (`INSERT`/`UPDATE`/`DELETE`/`MERGE`/`CREATE TABLE AS`/`EXECUTE`), wrap in a transaction:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) UPDATE users SET last_seen = now() WHERE id = 42;
ROLLBACK;
```

#### BUFFERS

The single most important diagnostic option. Verbatim docs definition: *"Include information on buffer usage. Specifically, include the number of shared blocks hit, read, dirtied, and written, the number of local blocks hit, read, dirtied, and written, the number of temp blocks read and written, and the time spent reading and writing data file blocks and temporary file blocks (in milliseconds) if `track_io_timing` is enabled."*[^buffers]

Verbatim categorization:

- **Shared blocks** contain data from regular tables and indexes (read through `shared_buffers`).
- **Local blocks** contain data from temporary tables and indexes (per-backend, in `temp_buffers`).
- **Temp blocks** contain short-term working data used in sorts, hashes, Materialize plan nodes (spills to disk through `work_mem` overflow).

The four hit/read/dirtied/written verbs:

- **hit** = block was already in cache; no disk I/O needed.
- **read** = block was fetched from disk (or OS page cache).
- **dirtied** = a previously unmodified block was changed by this query (count of new dirty buffers).
- **written** = a previously-dirtied block was evicted from cache by *this backend* during query processing (backend-write — a separate signal from background-writer activity, see [`32-buffer-manager.md`](./32-buffer-manager.md) and [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md)).

> [!NOTE] PostgreSQL 18
> Per the PG18 release notes: *"Automatically include `BUFFERS` output in `EXPLAIN ANALYZE`."*[^pg18-buffers-auto] On PG≤17 you must request `BUFFERS` explicitly; on PG18+ it is on by default with `ANALYZE`. Old tooling that expects the absence of buffer lines may need updating.

> [!NOTE] PostgreSQL 17
> Per the PG17 release notes: *"Add local I/O block read/write timing statistics to `EXPLAIN`'s `BUFFERS` output."*[^pg17-local-io] Pre-PG17 only shared-block timing was shown.

> [!NOTE] PostgreSQL 15
> Per the PG15 release notes: *"Add `EXPLAIN (BUFFERS)` output for temporary file block I/O."*[^pg15-temp-io] Pre-PG15 the temp-block I/O was not surfaced.

#### SETTINGS (PG12+)

Verbatim docs: *"Include information on configuration parameters. Specifically, include options affecting query planning with value different from the built-in default value."*[^settings] Lists session-or-cluster-overridden planner GUCs at the bottom of the plan output. Critical for reproducing a colleague's plan locally — you cannot reproduce a plan if you do not know they are running with `enable_seqscan = off` or `random_page_cost = 1.1`.

```text
Settings: random_page_cost = '1.1', work_mem = '64MB'
```

Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) for GUC mechanics and [`59-planner-tuning.md`](./59-planner-tuning.md) for which GUCs to tune.

#### GENERIC_PLAN (PG16+)

Verbatim docs: *"Allow the statement to contain parameter placeholders like `$1`, and generate a generic plan that does not depend on the values of those parameters. ... This parameter cannot be used together with `ANALYZE`."*[^generic-plan] The headline use case: you have a prepared statement that performs well for some bind values and badly for others, and you want to see what the generic plan looks like without binding actual parameters. Pre-PG16 this required hacks (forcing `force_generic_plan` or executing the prepared statement six times).

```sql
EXPLAIN (GENERIC_PLAN) SELECT * FROM orders WHERE customer_id = $1 AND status = $2;
```

Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) for prepared-statement generic vs custom plan mechanics.

#### WAL (PG13+)

Verbatim docs: *"Include information on WAL record generation. Specifically, include the number of records, number of full page images (fpi) and the amount of WAL generated in bytes."*[^wal-opt] Requires `ANALYZE`.

> [!NOTE] PostgreSQL 18
> PG18 expands `WAL` output to include WAL-buffer-full count: *"Include information on WAL record generation. Specifically, include the number of records, number of full page images (fpi), the amount of WAL generated in bytes and the number of times the WAL buffers became full."*[^pg18-wal] Non-zero `buffers full` indicates `wal_buffers` is undersized for the write rate.

```sql
EXPLAIN (ANALYZE, WAL) INSERT INTO events SELECT * FROM staging;
-- WAL: records=10532 fpi=82 bytes=1234567 buffers full=0
```

Cross-reference [`33-wal.md`](./33-wal.md) for WAL volume tuning, FPI cost, and the checkpoint-interval interaction.

#### SERIALIZE (PG17+)

Verbatim docs: *"Include information on the cost of _serializing_ the query's output data, that is converting it to text or binary format to send to the client. This can be a significant part of the time required for regular execution of the query, if the datatype output functions are expensive or if TOASTed values must be fetched from out-of-line storage."*[^serialize]

Three modes: `NONE` (default), `TEXT`, `BINARY`. Requires `ANALYZE`. Catches the "de-TOAST cost is hidden" trap from [`31-toast.md`](./31-toast.md) where `SELECT *` on a wide JSONB column appears fast in `EXPLAIN ANALYZE` because the planner never actually fetched the out-of-line chunks.

```sql
EXPLAIN (ANALYZE, BUFFERS, SERIALIZE TEXT) SELECT * FROM events WHERE id = 42;
-- Serialization: time=120.123 ms  output=15234kB  format=text
```

#### MEMORY (PG17+)

Verbatim docs: *"Include information on memory consumption by the query planning phase. Specifically, include the precise amount of storage used by planner in-memory structures, as well as total memory considering allocation overhead."*[^memory]

Used to diagnose planning-phase memory pressure (rare in OLTP, common with many-partition tables or extreme join counts).

```sql
EXPLAIN (MEMORY) SELECT * FROM very_partitioned_table WHERE ts BETWEEN ... AND ...;
-- Planning: Memory: used=2048kB  allocated=8192kB
```

#### FORMAT

Four formats: `TEXT` (default, human-readable), `JSON`, `XML`, `YAML`. JSON is the format every plan-visualizer tool (depesz.com, pgMustard, pev2) expects.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE customer_id = 42;
```

### Plan Node Catalog

The set of plan operators you will encounter in production[^plan-tree]:

| Node | What it does | Common triggers |
|---|---|---|
| `Seq Scan` | Read the heap from start to end | No index covers the predicate; predicate matches large fraction of table |
| `Index Scan` | Use index to find rows, then fetch from heap | Index covers predicate; selective filter |
| `Index Only Scan` | Use index alone; consult visibility map; skip heap if all-visible | Index covers all output columns AND visibility map is up to date |
| `Bitmap Index Scan` + `Bitmap Heap Scan` | Build bitmap of TIDs from index(es), then fetch heap pages in physical order | Predicate touches medium fraction of table; multiple indexes ANDed/ORed |
| `Tid Scan` | Direct lookup by `ctid` | `WHERE ctid = '(0,1)'` |
| `Nested Loop` | For each outer row, find matching inner rows (per-row inner scan) | Selective outer; indexed inner; small N |
| `Hash Join` | Build hash on smaller side, probe with larger | Equi-join; both sides large enough; planner has memory |
| `Merge Join` | Both inputs sorted on join key, merge in order | Pre-sorted inputs or sort is cheaper than hash |
| `Sort` | Order rows | `ORDER BY`, `GROUP BY` without hash, merge join input not pre-sorted |
| `Incremental Sort` | Sort within groups of pre-sorted prefix | Partial sort order from index |
| `HashAggregate` | Build hash on grouping keys | `GROUP BY`, `DISTINCT`, `SELECT DISTINCT` |
| `GroupAggregate` | Aggregate over pre-sorted input | Input already sorted on `GROUP BY` |
| `MixedAggregate` | Multiple aggregation strategies in one node | `GROUPING SETS`, `ROLLUP`, `CUBE` |
| `Materialize` | Buffer child output for repeated reads | Inner side of nested loop reused across outer rows |
| `Memoize` | Cache lookups from previous nested-loop iterations[^memoize] | PG14+: small fraction of inner rows actually distinct |
| `Gather` | Coordinate parallel workers, return rows in any order | Parallel-safe plan; multiple workers requested |
| `Gather Merge` | Coordinate parallel workers, preserve sort order | Parallel-safe + sorted output needed |
| `Append` | Union output of multiple plan trees | `UNION ALL`, partitioned-table scans |
| `Merge Append` | Append preserving sort order | Sorted children + needed sorted output |
| `Subquery Scan` | Wrap a subquery's output | Correlated/derived tables |
| `Function Scan` | Read rows from a set-returning function | `SELECT FROM unnest(...)`, `generate_series` |
| `Values Scan` | Inline `VALUES (...)` rows | `VALUES (...)` in `FROM` |
| `CTE Scan` | Read materialized CTE output | `WITH` clause with `MATERIALIZED` (or pre-PG12 default) |
| `WorkTable Scan` / `Recursive Union` | Recursive CTE iteration | `WITH RECURSIVE` |
| `WindowAgg` | Window-function evaluation | `OVER (...)` |
| `LockRows` | Acquire row-level locks | `SELECT FOR UPDATE/SHARE/...` |
| `Limit` | Stop after N rows | `LIMIT N` |
| `Result` | Single-row producer / projection | Function call only, `SELECT 1` |
| `Unique` | Remove duplicates from sorted input | Some `DISTINCT` paths |
| `SetOp` | Set operations | `INTERSECT`, `EXCEPT` |
| `ModifyTable` | Perform `INSERT`/`UPDATE`/`DELETE`/`MERGE` | Top of any mutating plan |
| `Foreign Scan` | Read from a foreign table | `postgres_fdw`, `file_fdw`, others; see [`70-fdw.md`](./70-fdw.md) |
| `Custom Scan` | Extension-provided node | Citus, TimescaleDB, etc. |

> [!NOTE] PostgreSQL 14
> Per the PG14 release notes: *"Add executor method to memoize results from the inner side of a nested-loop join. This is useful if only a small percentage of rows is checked on the inner side. It can be disabled via server parameter `enable_memoize`."*[^memoize] `Memoize` appears in plans where the planner expects high cache hit rate on the inner side of a parameterized nested loop. Look for the `Cache Key:` and `Hits: N  Misses: N  Evictions: N  Overflows: N` lines.

> [!NOTE] PostgreSQL 18
> Per the PG18 release notes: *"Indicate disabled nodes in `EXPLAIN ANALYZE` output."*[^pg18-disabled] When a node was forced into the plan despite a disabled enable_* GUC (because it was the only viable plan), PG18 marks it explicitly. Pre-PG18 you had to infer this from cost numbers. Also: *"Add details about window function arguments to `EXPLAIN` output"*[^pg18-window-args] and *"In `EXPLAIN ANALYZE`, report the number of index lookups used per index scan node."*[^pg18-index-lookups]

### Reading the Output

A canonical plan:

```text
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
SELECT u.email, count(*)
FROM users u JOIN orders o ON o.user_id = u.id
WHERE o.created_at >= now() - interval '7 days'
GROUP BY u.email
ORDER BY count(*) DESC
LIMIT 10;
                                                                       QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=12345.67..12345.69 rows=10 width=40) (actual time=234.567..234.572 rows=10 loops=1)
   Buffers: shared hit=8421 read=234
   ->  Sort  (cost=12345.67..12378.91 rows=13298 width=40) (actual time=234.566..234.568 rows=10 loops=1)
         Sort Key: (count(*)) DESC
         Sort Method: top-N heapsort  Memory: 26kB
         Buffers: shared hit=8421 read=234
         ->  HashAggregate  (cost=11567.89..11700.86 rows=13298 width=40) (actual time=230.123..232.011 rows=12876 loops=1)
               Group Key: u.email
               Batches: 1  Memory Usage: 2049kB
               Buffers: shared hit=8421 read=234
               ->  Hash Join  (cost=234.56..10987.23 rows=116132 width=32) (actual time=12.345..210.567 rows=115234 loops=1)
                     Hash Cond: (o.user_id = u.id)
                     Buffers: shared hit=8421 read=234
                     ->  Index Scan using orders_created_at_idx on orders o
                          (cost=0.42..9876.12 rows=116132 width=8) (actual time=0.034..145.123 rows=115234 loops=1)
                           Index Cond: (created_at >= (now() - '7 days'::interval))
                           Buffers: shared hit=4321 read=89
                     ->  Hash  (cost=200.00..200.00 rows=10000 width=32) (actual time=12.234..12.235 rows=10000 loops=1)
                           Buckets: 16384  Batches: 1  Memory Usage: 1024kB
                           Buffers: shared hit=4100 read=145
                           ->  Seq Scan on users u
                                (cost=0.00..200.00 rows=10000 width=32) (actual time=0.012..6.234 rows=10000 loops=1)
                                 Buffers: shared hit=4100 read=145
 Settings: random_page_cost = '1.1', work_mem = '64MB'
 Planning Time: 0.123 ms
 Execution Time: 234.612 ms
```

Read from the leaves:

1. `Seq Scan on users u` and `Index Scan using orders_created_at_idx on orders o` execute first. Each emits rows up to its parent.
2. `Hash` builds the in-memory hash table on `users` (10K rows, 1MB, single batch — good).
3. `Hash Join` probes with `orders` rows, joining on `user_id = u.id`.
4. `HashAggregate` groups by email; emits 12,876 distinct emails.
5. `Sort` ordered the group counts; `Sort Method: top-N heapsort` means only the top 10 were kept in memory — efficient.
6. `Limit` cuts off at 10 rows.

Verbatim from docs on `loops`: *"In some query plans, it is possible for a subplan node to be executed more than once. For example, the inner index scan will be executed once per outer row in the above nested-loop plan. In such cases, the `loops` value reports the total number of executions of the node, and the actual time and rows values shown are averages per-execution."*[^loops] To get the *total* rows emitted by an inner node, multiply `rows × loops`.

Verbatim on rows-removed: *"The 'Rows Removed' line only appears when at least one scanned row, or potential join pair in the case of a join node, is rejected by the filter condition."*[^rows-removed] Two flavors:

- `Rows Removed by Filter:` — predicate that runs on the heap-tuple level (because the index returned a candidate row that did not pass the `WHERE` clause).
- `Rows Removed by Join Filter:` — same but for join conditions that ran after the index-or-hash key match.

A large `Rows Removed by Filter:` value relative to `rows actual` is the classic "your index is selective on column A but the actual filter is on column A+B" signal — add a multi-column or partial index.

### BUFFERS Interpretation

Worked example:

```text
Buffers: shared hit=8421 read=234 dirtied=0 written=0
         local hit=0 read=0 dirtied=0 written=0
         temp read=512 written=512
```

Interpretation:

- **8421 shared hits + 234 shared reads** — the query read 8655 blocks, of which 234 (2.7%) had to come from disk/OS cache. Cache hit rate is excellent.
- **0 dirtied/written** — pure read query.
- **512 temp read + 512 temp written** — a sort or hash spilled `512 × 8KB = 4MB` to disk and read it back. The corresponding node likely had `work_mem` set too low. Cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md).

Three patterns to recognize:

1. **`shared read` dominates `shared hit`** → working set exceeds `shared_buffers`, page cache, or both. Time to scale memory or rewrite the query.
2. **`temp read/written` non-zero on a `Sort` or `Hash`** → `work_mem` is too small for this query. Raise per-session (`SET work_mem = '256MB'`) or per-role (`ALTER ROLE reporter SET work_mem = '512MB'`); never raise cluster-wide on a connection-heavy server — cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) gotcha #4.
3. **`written` non-zero on a SELECT** → backend was forced to write a dirty buffer to make room. Indicates checkpointer or bgwriter is falling behind. Cross-reference [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md).

> [!NOTE] PostgreSQL 16+ I/O timing alternative
> If you enable `track_io_timing`[^track-io-timing], the `BUFFERS` output also includes `I/O Timings: shared/local read=N.NNN ms write=N.NNN ms` and `I/O Timings: temp read=N.NNN ms write=N.NNN ms`. Beware the overhead warning on slow-clock systems; verify with `pg_test_timing` before enabling cluster-wide.

### Diagnosing Row-Count Misestimates

The canonical diagnostic flow for "the planner picked a bad plan":

1. Run `EXPLAIN (ANALYZE, BUFFERS)`.
2. Find the lowest node where `(estimated rows) × (actual loops)` diverges from `(actual rows) × (actual loops)` by 10× or more.
3. That node's *inputs* are correctly estimated; the *node itself* (or its predicate) is where the planner's model breaks.

Common root causes:

| Symptom at the misestimating node | Root cause | Fix |
|---|---|---|
| Single-column predicate on indexed column | Stale stats; data-type mismatch | `ANALYZE table`; cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md) |
| `WHERE a = 'X' AND b = 'Y'` underestimates | Per-column stats assume independence | `CREATE STATISTICS ... ON a, b FROM table; ANALYZE table;` — cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md) Recipe 4 |
| `WHERE lower(email) = ...` underestimates | No expression statistics | PG14+: `CREATE STATISTICS ... ON (lower(email)) FROM users` OR functional index |
| `JOIN` cardinality wrong | Skewed `n_distinct`; cross-table correlation invisible to planner | Manual `n_distinct` override OR no fix — planner has no cross-table stats; cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md) gotcha #14 |
| Estimated rows = 1 on an actually-large output | `LIMIT 1` collapses with bad estimate | Force-materialize with CTE or rewrite |
| Estimates fine when run as literal, terrible when prepared | Generic-plan vs custom-plan flip | `EXPLAIN (GENERIC_PLAN)` to inspect, `SET plan_cache_mode = force_custom_plan` per-session — cross-ref [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) |
| Estimates wildly wrong on partition root | Autovacuum doesn't ANALYZE the parent | Manual `ANALYZE partitioned_table` (parent only); cross-ref [`35-partitioning.md`](./35-partitioning.md) gotcha #9 |

### auto_explain

Verbatim from docs: *"The `auto_explain` module provides a means for logging execution plans of slow statements automatically, without having to run `EXPLAIN` by hand. This is especially helpful for tracking down un-optimized queries in large applications."*[^auto-explain]

Load via `shared_preload_libraries`:

```ini
shared_preload_libraries = 'auto_explain'
session_preload_libraries = 'auto_explain'  # alternative for per-session
```

11-row option catalog (`auto_explain.*`):

| Option | Default | What it does |
|---|---|---|
| `log_min_duration` | `-1` (off) | Log plans for statements exceeding N ms; `0` logs every statement |
| `log_analyze` | `off` | Equivalent to `EXPLAIN (ANALYZE)`; **adds overhead** |
| `log_buffers` | `off` | Equivalent to `EXPLAIN (BUFFERS)` |
| `log_wal` | `off` | Equivalent to `EXPLAIN (WAL)` (PG13+) |
| `log_timing` | `on` | Per-node timing when `log_analyze=on`; turn off on slow-clock systems |
| `log_triggers` | `off` | Show trigger execution times |
| `log_verbose` | `off` | Equivalent to `EXPLAIN (VERBOSE)` |
| `log_settings` | `off` | List overridden GUCs (PG12+) |
| `log_format` | `text` | `text` / `xml` / `json` / `yaml` |
| `log_nested_statements` | `off` | Log function-internal statements |
| `sample_rate` | `1.0` | Fraction of statements to consider |

> [!WARNING] `log_analyze = on` is expensive
> Setting `auto_explain.log_analyze = on` instruments every qualifying query with per-node timing — same overhead as running `EXPLAIN ANALYZE` by hand. For high-QPS clusters, combine with `sample_rate = 0.05` to capture 5% of slow queries rather than every one.

> [!NOTE] PostgreSQL 16
> Per the PG16 release notes: *"Allow auto_explain to log values passed to parameterized statements ... Logging is controlled by `auto_explain.log_parameter_max_length`; by default query parameters will be logged with no length restriction."*[^pg16-auto-explain-params] Set a finite `log_parameter_max_length` to avoid logging huge JSON parameter blobs.

Baseline production configuration:

```ini
shared_preload_libraries = 'auto_explain,pg_stat_statements'

auto_explain.log_min_duration = '500ms'
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_wal = on
auto_explain.log_timing = on        # turn off if pg_test_timing > 100ns
auto_explain.log_format = 'json'
auto_explain.log_settings = on
auto_explain.sample_rate = 0.1      # 10% of qualifying statements
auto_explain.log_parameter_max_length = 1024
```

### Per-Version Timeline

| Version | EXPLAIN-related changes |
|---|---|
| PG12 | `SETTINGS` option introduced: *"Add EXPLAIN option SETTINGS to output non-default optimizer settings (Tomas Vondra). This output can also be obtained when using auto_explain by setting `auto_explain.log_settings`."*[^pg12-settings-rel] |
| PG13 | `WAL` option introduced: *"Allow EXPLAIN, auto_explain, autovacuum, and pg_stat_statements to track WAL usage statistics (Kirill Bychik, Julien Rouhaud)."*[^pg13-wal-rel] |
| PG14 | `Memoize` plan node: *"Add executor method to memoize results from the inner side of a nested-loop join (David Rowley)."*[^memoize] Also: *"Fix EXPLAIN CREATE TABLE AS and EXPLAIN CREATE MATERIALIZED VIEW to honor IF NOT EXISTS."*[^pg14-iif-not-exists] |
| PG15 | *"Add `EXPLAIN (BUFFERS)` output for temporary file block I/O (Masahiko Sawada)."*[^pg15-temp-io] Also: *"When EXPLAIN references the session's temporary object schema, refer to it as `pg_temp` (Amul Sul)."*[^pg15-pgtemp] |
| PG16 | `GENERIC_PLAN` option: *"Add EXPLAIN option GENERIC_PLAN to display the generic plan for a parameterized query (Laurenz Albe)."*[^generic-plan-rel] Plus *"Allow memoize atop a UNION ALL"*[^pg16-memoize-union] and the auto_explain parameter-logging admonition above. |
| PG17 | `SERIALIZE` option: *"Add EXPLAIN option SERIALIZE to report the cost of converting data for network transmission (Stepan Rutz, Matthias van de Meent)."*[^serialize-rel] `MEMORY` option: *"Allow EXPLAIN to report optimizer memory usage (Ashutosh Bapat). The option is called MEMORY."*[^memory-rel] Plus *"Add local I/O block read/write timing statistics to EXPLAIN's BUFFERS output (Nazir Bilal Yavuz)."*[^pg17-local-io] Plus *"Improve EXPLAIN's display of SubPlan nodes and output parameters (Tom Lane, Dean Rasheed)."*[^pg17-subplan] Plus *"Add JIT deform_counter details to EXPLAIN (Dmitry Dolgov)."*[^pg17-jit] |
| PG18 | `BUFFERS` is automatic with `ANALYZE`: *"Automatically include BUFFERS output in EXPLAIN ANALYZE (Guillaume Lelarge, David Rowley)."*[^pg18-buffers-auto] Plus *"Add full WAL buffer count to EXPLAIN (WAL) output (Bertrand Drouvot)."*[^pg18-wal] Plus *"In EXPLAIN ANALYZE, report the number of index lookups used per index scan node (Peter Geoghegan)."*[^pg18-index-lookups] Plus *"Modify EXPLAIN to output fractional row counts."*[^pg18-frac-rows] Plus *"Add memory and disk usage details to Material, Window Aggregate, and common table expression nodes to EXPLAIN output."*[^pg18-mem-disk] Plus *"Add details about window function arguments to EXPLAIN output (Tom Lane)."*[^pg18-window-args] Plus *"Add Parallel Bitmap Heap Scan worker cache statistics to EXPLAIN ANALYZE."*[^pg18-parallel-bitmap] Plus *"Indicate disabled nodes in EXPLAIN ANALYZE output."*[^pg18-disabled] |

> [!NOTE] FORMAT JSON/YAML/XML stability
> Across PG14, PG15, PG16, PG17, and PG18, no release-note items change the `FORMAT` enum or alter the structural shape of JSON/YAML/XML output. New fields are *added* with new options (e.g., PG18's `Disabled: true` indicator), but existing fields remain stable. Plan-visualizer tooling (depesz.com, pgMustard, pev2) generally handles new-version output by ignoring unknown fields.

## Examples / Recipes

### Recipe 1: Diagnose a slow query end-to-end

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
SELECT u.email, count(*)
FROM users u JOIN orders o ON o.user_id = u.id
WHERE o.created_at >= now() - interval '7 days'
GROUP BY u.email
ORDER BY count(*) DESC
LIMIT 10;
```

Checklist for the output:

1. Walk leaves-to-root.
2. At each node, compare `rows actual` vs `rows estimated`. Flag any 10×+ divergence.
3. In `BUFFERS` lines, look for `read` dominating `hit` (working-set > cache), `temp read/written` (spill), `dirtied/written` on a SELECT (write-back pressure).
4. In `Sort Method:`, look for `external merge` (spilled) vs `top-N heapsort` (in-memory).
5. In `HashAggregate`, look for `Batches: > 1` (spilled to disk).
6. Bottom of plan: `Settings:` lists overridden planner GUCs. `Planning Time:` should be small (<5% of execution time); if not, the plan cache may be churning — cross-ref [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md).

### Recipe 2: EXPLAIN ANALYZE on a mutating statement without side effects

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL)
UPDATE users SET last_seen = now() WHERE id = ANY (ARRAY[1,2,3,4,5]);
ROLLBACK;
```

`ROLLBACK` reverts the actual modification. The WAL records reported are accurate measurements of what the operation would generate if committed. Same pattern works for `INSERT`/`DELETE`/`MERGE`/`CREATE TABLE AS`.

### Recipe 3: Verify a parameterized query's generic plan (PG16+)

```sql
EXPLAIN (GENERIC_PLAN)
SELECT * FROM orders
WHERE customer_id = $1 AND status = $2 AND created_at >= $3;
```

If the generic plan picks `Seq Scan` but custom plans for specific bind values pick `Index Scan`, the application is on the unhappy side of the generic-vs-custom-plan switch. Mitigations:

- `SET plan_cache_mode = force_custom_plan` for the session/role using this query.
- Restructure the predicate to be more selective.
- Add `pg_hint_plan` (third-party extension) for surgical hints.

### Recipe 4: Pre-PG16 alternative — peek at generic plan via PREPARE

```sql
PREPARE qry(int, text, timestamptz) AS
  SELECT * FROM orders WHERE customer_id = $1 AND status = $2 AND created_at >= $3;

-- After 5 executions, PG considers the generic plan:
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');  -- 6th, may now use generic plan

-- Or force generic plan immediately:
SET plan_cache_mode = force_generic_plan;
EXPLAIN EXECUTE qry(42, 'open', now() - interval '7 days');
```

Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) Recipe 4.

### Recipe 5: Detect Index Only Scan with stale visibility map

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM events WHERE created_at >= '2026-05-01';
--                                                      QUERY PLAN
-- Index Only Scan using events_created_at_idx on events ...
--   Index Cond: (created_at >= '2026-05-01'::date)
--   Heap Fetches: 4732
```

`Heap Fetches: > 0` means the visibility map is not up to date for the scanned index range — pages had to be visited despite the index covering all output columns. Remediation:

```sql
VACUUM (VERBOSE, ANALYZE) events;
```

Re-run the `EXPLAIN ANALYZE`; `Heap Fetches:` should drop to 0 (or near 0). Cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) and [`22-indexes-overview.md`](./22-indexes-overview.md) gotcha #12.

### Recipe 6: Detect a Sort spilling to disk

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT user_id, sum(amount) FROM transactions
WHERE created_at >= '2026-05-01'
GROUP BY user_id ORDER BY sum(amount) DESC;
--                                                  QUERY PLAN
-- Sort  (cost=... rows=124356 width=12) (actual time=2345.6..2890.1 rows=124356 loops=1)
--   Sort Key: (sum(amount)) DESC
--   Sort Method: external merge  Disk: 5832kB    -- <-- SPILL!
--   Buffers: shared hit=8421 temp read=729 written=729
```

`Sort Method: external merge` means `work_mem` was insufficient. Fix per-session:

```sql
SET work_mem = '128MB';
EXPLAIN (ANALYZE, BUFFERS) SELECT user_id, sum(amount) FROM transactions ...;
-- Sort Method: quicksort  Memory: 9876kB    -- in-memory
```

For a recurring batch query, set per-role: `ALTER ROLE reporter SET work_mem = '256MB'`. Cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) Recipe 3.

### Recipe 7: Detect HashAggregate batches

```text
HashAggregate  (cost=... rows=10000000 width=12) (actual time=... rows=8923456 loops=1)
  Group Key: user_id
  Batches: 4  Memory Usage: 65537kB  Disk Usage: 142336kB
```

`Batches: > 1` indicates the hash table spilled. Same fix as Sort: raise `work_mem`, or use `hash_mem_multiplier` (PG13+, default `2.0` since PG15 per [`54-memory-tuning.md`](./54-memory-tuning.md) Rule 5) to give hashes more memory than sorts. The asymmetric defaults exist because hash spills cost dramatically more than sort spills.

### Recipe 8: Measure serialization cost on a wide JSONB column (PG17+)

```sql
EXPLAIN (ANALYZE, BUFFERS, SERIALIZE TEXT)
SELECT id, payload FROM events WHERE id = 42;
--                                            QUERY PLAN
-- Index Scan ... rows=1 ... actual time=0.034..0.035
--   Buffers: shared hit=4
-- Serialization: time=120.123 ms  output=15234kB  format=text
-- Planning Time: 0.123 ms
-- Execution Time: 0.567 ms
```

The query execution took 0.567 ms but serializing one TOASTed JSONB to text took 120 ms. The hot fix is to project only the keys you need:

```sql
SELECT id, payload->>'event_type' AS event_type FROM events WHERE id = 42;
```

Cross-reference [`31-toast.md`](./31-toast.md) recipe 9 (hot-scalar-hoist).

### Recipe 9: Reading parallel-query output

```text
Gather  (cost=... rows=8 width=12) (actual time=234..234 rows=8 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  Buffers: shared hit=12345 read=234
  ->  Partial HashAggregate  (cost=... rows=4) (actual rows=4 loops=3)
        Group Key: user_id
        Buffers: shared hit=12345 read=234
        Worker 0:  actual time=210..212 rows=3
        Worker 1:  actual time=215..217 rows=3
        ->  Parallel Seq Scan on big_table  (cost=... rows=4166666) (actual rows=3333333 loops=3)
              Buffers: shared hit=12345 read=234
```

Notes:

- `Workers Planned: 2` + `Workers Launched: 2` — both workers started. If `Launched < Planned`, the system was at `max_parallel_workers` saturation; cross-reference [`60-parallel-query.md`](./60-parallel-query.md).
- `loops=3` — 2 workers + 1 leader, each ran the partial scan once.
- `actual rows` per worker is the per-worker count; total across workers is roughly `rows × loops`.

### Recipe 10: Find the misestimating node in a complex join

For a 5-table join where the actual time is 30s but cost suggests it should be 100ms:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT u.email, count(*)
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN categories c ON c.id = p.category_id
WHERE c.name = 'electronics' AND o.created_at >= now() - '7 days'::interval
GROUP BY u.email;
```

Walk each join node bottom-to-top. The lowest node with `rows estimated=100` but `rows actual=1000000` is the source. Common pattern: a filter on `c.name = 'electronics'` returns 50 categories estimated → 1 actual; later joins explode because the planner expects fewer products. Fix:

1. `CREATE STATISTICS ON name FROM categories;` — useless, statistics already include name.
2. Inspect with `SELECT * FROM pg_stats WHERE tablename='categories' AND attname='name';` — is `most_common_vals` populated? Is `n_distinct` reasonable?
3. If `categories` is small (<1000 rows), raise `default_statistics_target` for that column: `ALTER TABLE categories ALTER COLUMN name SET STATISTICS 1000;` then `ANALYZE categories;`

### Recipe 11: Use JSON format for machine-readable plans

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM orders WHERE customer_id = 42;
```

Pipe into `explain.depesz.com`, pgMustard, or `pev2` for visualization. The JSON shape is stable across PG14–18 (new fields appear with new options but existing fields are not renamed or removed).

### Recipe 12: Enable auto_explain for a slow-query audit

```ini
# postgresql.conf
shared_preload_libraries = 'auto_explain,pg_stat_statements'

auto_explain.log_min_duration = '500ms'
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_wal = on
auto_explain.log_format = 'json'
auto_explain.log_settings = on
auto_explain.sample_rate = 0.1
auto_explain.log_parameter_max_length = 1024
```

Restart required (shared_preload_libraries is postmaster-context). After restart, every statement exceeding 500 ms gets its full plan logged in JSON, with parameter values truncated at 1024 chars and 10% sampling. Cross-reference [`51-pgaudit.md`](./51-pgaudit.md) for the log-shipping infrastructure.

### Recipe 13: Inspect parallel-aware plans before changing parallelism settings

Before raising `max_parallel_workers_per_gather` cluster-wide, verify a representative query benefits:

```sql
SET max_parallel_workers_per_gather = 4;
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM large_table WHERE ts BETWEEN ... AND ...;
RESET max_parallel_workers_per_gather;
```

Compare `Execution Time` and `Workers Launched` for `2`, `4`, `8`. The marginal speedup typically diminishes past 4 workers due to coordinator overhead and I/O bottlenecks.

### Recipe 14: Identify a disabled-node-forced plan (PG18+)

```text
Seq Scan on large_table  Disabled: true
  ...
```

PG18 marks plan nodes that were forced into the plan despite a relevant `enable_*` GUC being off (because they were the only viable option). On pre-PG18 you had to infer this from cost numbers ballooning by `disable_cost` (typically `1e10`). Cross-reference [`59-planner-tuning.md`](./59-planner-tuning.md) for the right way to use `enable_*` GUCs.

## Gotchas / Anti-patterns

1. **`EXPLAIN ANALYZE` actually executes the query.**[^side-effect] `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`CREATE TABLE AS` without `BEGIN; ... ROLLBACK;` will modify your data. The docs even quote the workaround verbatim.

2. **`EXPLAIN` (no `ANALYZE`) shows estimates only.** A query with cost = 0.42..1.23 may take an hour. Always run `EXPLAIN ANALYZE` for performance work.

3. **Per-node timing has overhead.** `TIMING OFF` is the right setting when you only care about rows and buffers. Verbatim docs: *"The overhead of repeatedly reading the system clock can slow down the query significantly on some systems, so it may be useful to set this parameter to `FALSE` when only actual row counts, and not exact times, are needed."*[^timing]

4. **`rows actual` × `loops` is the total, not `rows actual`.** Verbatim: *"In such cases, the `loops` value reports the total number of executions of the node, and the actual time and rows values shown are averages per-execution."*[^loops] For nested-loop inner scans, multiply.

5. **`Rows Removed by Filter:` very large vs `rows actual` is the missing-index signal.** Cross-reference [`22-indexes-overview.md`](./22-indexes-overview.md) for the index-decision matrix.

6. **`Heap Fetches: > 0` on an Index Only Scan means visibility map is stale.** The index has all the columns but the planner cannot trust the all-visible bits. `VACUUM` the table; cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

7. **`Sort Method: external merge` means `work_mem` is too small for this query.** Raise per-session, not cluster-wide; cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) gotcha #4.

8. **`Batches: > 1` on HashAggregate / Hash Join means hash table spilled.** Same fix as Sort. Use `hash_mem_multiplier` PG13+ to break the symmetric work_mem assumption (default 2.0 since PG15).

9. **`written` non-zero on a SELECT means the backend wrote a dirty buffer.** Indicates checkpointer/bgwriter pressure; cross-reference [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md).

10. **`GENERIC_PLAN` cannot be combined with `ANALYZE`.**[^generic-plan] Trying to do so raises an error. Use `force_generic_plan` GUC + `EXPLAIN ANALYZE EXECUTE` instead.

11. **`WAL` requires `ANALYZE`.**[^wal-opt] Same for `SERIALIZE` and `TIMING`.

12. **`auto_explain.log_analyze=on` adds per-query overhead.** Use `sample_rate < 1.0` in production. Verbatim from docs: *"In case of nested statements, either all will be explained or none."*

13. **Plan output is verbose; the *first* misestimating node is what matters.** Walk leaves-up. The first node where actual ≠ estimate is the root cause; nodes above it are downstream symptoms.

14. **`EXPLAIN ANALYZE` on a transaction-mode pgBouncer connection does not see session GUCs from other transactions.** If your `SET work_mem` happened in a prior transaction, the next pooled query may not have it. Cross-reference [`81-pgbouncer.md`](./81-pgbouncer.md).

15. **JSON format output is large.** A complex query's JSON plan can be 10s of KB. Use `text` format unless you are piping into a tool.

16. **`SETTINGS` does not show *all* overridden GUCs**, only ones affecting query planning. Verbatim: *"Specifically, include options affecting query planning with value different from the built-in default value."*[^settings] Memory and connection GUCs are NOT shown.

17. **`Buffers:` numbers are per-node *cumulative including children*.** Verbatim docs: *"The number of blocks shown for an upper-level node includes those used by all its child nodes."*[^buffers] To compute a node's own buffer cost, subtract child counts.

18. **`COSTS` defaults to ON.** For test-suite plan-diffing, disable it: `EXPLAIN (COSTS OFF) ...`. This keeps the plan shape stable across statistics drift.

19. **Plans with `loops` count from one outer-side row can be misleading.** A `rows=1 loops=1000000` inner-side index scan that takes 10 μs each is actually 10 seconds in aggregate — `actual time=0.010..0.010` looks fast per loop but the total is `time × loops`.

20. **PG18 changes the default `BUFFERS` behavior**[^pg18-buffers-auto]. Old test fixtures and plan-snapshots that expected the absence of `Buffers:` lines will see them. Update test fixtures.

21. **`Memoize` (PG14+) cache miss rate matters.** A `Memoize` node with 90%+ misses is doing extra work for no benefit. Check `Hits: H  Misses: M` ratio; if low, set `enable_memoize = off` for this session.

22. **`SERIALIZE TEXT` does not include network transmission cost.**[^serialize] It measures conversion-to-wire-format only. For a true end-to-end query latency picture, also measure on the client side.

23. **PG15 introduced two minor EXPLAIN changes that may break log-grep tooling.** Temporary-table block I/O appears in `BUFFERS` output[^pg15-temp-io], and the session's temp schema renders as `pg_temp` instead of the per-session schema name[^pg15-pgtemp]. Audit any regex matching schema-qualified temp-table names.

## See Also

- [`55-statistics-planner.md`](./55-statistics-planner.md) — what feeds the estimates the planner builds plans from
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — cross-query tracking; complements `auto_explain`
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — full `pg_stat_*` view catalog including `pg_stat_io`, `pg_stat_wal`
- [`59-planner-tuning.md`](./59-planner-tuning.md) — cost GUCs (`random_page_cost`, `seq_page_cost`, `cpu_tuple_cost`) and `enable_*` toggles
- [`60-parallel-query.md`](./60-parallel-query.md) — parallel-safety markers, `max_parallel_*` GUCs, parallel-aware plan nodes
- [`61-jit-compilation.md`](./61-jit-compilation.md) — JIT-related EXPLAIN output (`Functions: N  Inlining: ...`)
- [`22-indexes-overview.md`](./22-indexes-overview.md) — decision matrix for index choice when plan reveals a missing index
- [`23-btree-indexes.md`](./23-btree-indexes.md), [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md), [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — per-index-type deep dives
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — visibility-map maintenance for Index Only Scan
- [`30-hot-updates.md`](./30-hot-updates.md) — HOT chain interaction with index plans
- [`31-toast.md`](./31-toast.md) — de-TOAST cost surfaced by `SERIALIZE`
- [`33-wal.md`](./33-wal.md) — WAL-volume tuning informed by `EXPLAIN (WAL)` output
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — `Buffers: written` interpretation
- [`41-transactions.md`](./41-transactions.md) — `BEGIN; EXPLAIN ANALYZE; ROLLBACK;` pattern
- [`43-locking.md`](./43-locking.md) — `LockRows` plan node interpretation
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `work_mem` and `hash_mem_multiplier` for spill remediation
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — generic vs custom plan switch
- [`51-pgaudit.md`](./51-pgaudit.md) — log shipping for `auto_explain` output
- [`81-pgbouncer.md`](./81-pgbouncer.md) — transaction-mode interaction with `SET work_mem`
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — Slow Query Investigation recipe; EXPLAIN is the primary diagnostic step

## Sources

[^side-effect]: PostgreSQL 16 docs, `EXPLAIN`: *"Keep in mind that the statement is actually executed when the ANALYZE option is used. Although EXPLAIN will discard any output that a SELECT would return, other side effects of the statement will happen as usual. If you wish to use EXPLAIN ANALYZE on an INSERT, UPDATE, DELETE, MERGE, CREATE TABLE AS, or EXECUTE statement without letting the command affect your data, use this approach: BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;"* https://www.postgresql.org/docs/16/sql-explain.html

[^analyze]: PostgreSQL 16 docs, `EXPLAIN` option ANALYZE: *"Carry out the command and show actual run times and other statistics. This parameter defaults to FALSE."* https://www.postgresql.org/docs/16/sql-explain.html

[^buffers]: PostgreSQL 16 docs, `EXPLAIN` option BUFFERS: *"Include information on buffer usage. Specifically, include the number of shared blocks hit, read, dirtied, and written, the number of local blocks hit, read, dirtied, and written, the number of temp blocks read and written, and the time spent reading and writing data file blocks and temporary file blocks (in milliseconds) if track_io_timing is enabled. A hit means that a read was avoided because the block was found already in cache when needed. Shared blocks contain data from regular tables and indexes; local blocks contain data from temporary tables and indexes; while temporary blocks contain short-term working data used in sorts, hashes, Materialize plan nodes, and similar cases. The number of blocks dirtied indicates the number of previously unmodified blocks that were changed by this query; while the number of blocks written indicates the number of previously-dirtied blocks evicted from cache by this backend during query processing. The number of blocks shown for an upper-level node includes those used by all its child nodes. In text format, only non-zero values are printed. This parameter defaults to FALSE."* https://www.postgresql.org/docs/16/sql-explain.html

[^settings]: PostgreSQL 16 docs, `EXPLAIN` option SETTINGS: *"Include information on configuration parameters. Specifically, include options affecting query planning with value different from the built-in default value. This parameter defaults to FALSE."* https://www.postgresql.org/docs/16/sql-explain.html

[^generic-plan]: PostgreSQL 16 docs, `EXPLAIN` option GENERIC_PLAN: *"Allow the statement to contain parameter placeholders like $1, and generate a generic plan that does not depend on the values of those parameters. See PREPARE for details about generic plans and the types of statement that support parameters. This parameter cannot be used together with ANALYZE. It defaults to FALSE."* https://www.postgresql.org/docs/16/sql-explain.html

[^wal-opt]: PostgreSQL 16 docs, `EXPLAIN` option WAL: *"Include information on WAL record generation. Specifically, include the number of records, number of full page images (fpi) and the amount of WAL generated in bytes. In text format, only non-zero values are printed. This parameter may only be used when ANALYZE is also enabled. It defaults to FALSE."* https://www.postgresql.org/docs/16/sql-explain.html

[^timing]: PostgreSQL 16 docs, `EXPLAIN` option TIMING: *"Include actual startup time and time spent in each node in the output. The overhead of repeatedly reading the system clock can slow down the query significantly on some systems, so it may be useful to set this parameter to FALSE when only actual row counts, and not exact times, are needed. Run time of the entire statement is always measured, even when node-level timing is turned off with this option. This parameter may only be used when ANALYZE is also enabled. It defaults to TRUE."* https://www.postgresql.org/docs/16/sql-explain.html

[^serialize]: PostgreSQL 17 docs, `EXPLAIN` option SERIALIZE: *"Include information on the cost of serializing the query's output data, that is converting it to text or binary format to send to the client. This can be a significant part of the time required for regular execution of the query, if the datatype output functions are expensive or if TOASTed values must be fetched from out-of-line storage. EXPLAIN's default behavior, SERIALIZE NONE, does not perform these conversions. If SERIALIZE TEXT or SERIALIZE BINARY is specified, the appropriate conversions are performed, and the time spent doing so is measured (unless TIMING OFF is specified). If the BUFFERS option is also specified, then any buffer accesses involved in the conversions are counted too. In no case, however, will EXPLAIN actually send the resulting data to the client; hence network transmission costs cannot be investigated this way. Serialization may only be enabled when ANALYZE is also enabled. If SERIALIZE is written without an argument, TEXT is assumed."* https://www.postgresql.org/docs/17/sql-explain.html

[^memory]: PostgreSQL 18 docs, `EXPLAIN` option MEMORY: *"Include information on memory consumption by the query planning phase. Specifically, include the precise amount of storage used by planner in-memory structures, as well as total memory considering allocation overhead. This parameter defaults to FALSE."* https://www.postgresql.org/docs/18/sql-explain.html

[^rows-emitted]: PostgreSQL 16 docs, Using EXPLAIN: *"The rows value is a little tricky because it is not the number of rows processed or scanned by the plan node, but rather the number emitted by the node. This is often less than the number scanned, as a result of filtering by any WHERE-clause conditions that are being applied at the node. Ideally the top-level rows estimate will approximate the number of rows actually returned, updated, or deleted by the query."* https://www.postgresql.org/docs/16/using-explain.html

[^loops]: PostgreSQL 16 docs, Using EXPLAIN: *"In some query plans, it is possible for a subplan node to be executed more than once. For example, the inner index scan will be executed once per outer row in the above nested-loop plan. In such cases, the loops value reports the total number of executions of the node, and the actual time and rows values shown are averages per-execution."* https://www.postgresql.org/docs/16/using-explain.html

[^rows-removed]: PostgreSQL 16 docs, Using EXPLAIN: *"The 'Rows Removed' line only appears when at least one scanned row, or potential join pair in the case of a join node, is rejected by the filter condition."* https://www.postgresql.org/docs/16/using-explain.html

[^plan-tree]: PostgreSQL 16 docs, Using EXPLAIN: *"The structure of a query plan is a tree of plan nodes. Nodes at the bottom level of the tree are scan nodes: they return raw rows from a table. There are different types of scan nodes for different table access methods: sequential scans, index scans, and bitmap index scans."* https://www.postgresql.org/docs/16/using-explain.html

[^auto-explain]: PostgreSQL 16 docs, `auto_explain`: *"The auto_explain module provides a means for logging execution plans of slow statements automatically, without having to run EXPLAIN by hand. This is especially helpful for tracking down un-optimized queries in large applications."* https://www.postgresql.org/docs/16/auto-explain.html

[^track-io-timing]: PostgreSQL 16 docs, `track_io_timing`: *"Enables timing of database I/O calls. This parameter is off by default, as it will repeatedly query the operating system for the current time, which may cause significant overhead on some platforms. You can use the pg_test_timing tool to measure the overhead of timing on your system. I/O timing information is displayed in pg_stat_database, pg_stat_io, in the output of EXPLAIN when the BUFFERS option is used, in the output of VACUUM when the VERBOSE option is used, by autovacuum for auto-vacuums and auto-analyzes, when log_autovacuum_min_duration is set and by pg_stat_statements. Only superusers and users with the appropriate SET privilege can change this setting."* https://www.postgresql.org/docs/16/runtime-config-statistics.html

[^pg12-settings-rel]: PostgreSQL 12 release notes: *"Add EXPLAIN option SETTINGS to output non-default optimizer settings (Tomas Vondra). This output can also be obtained when using auto_explain by setting auto_explain.log_settings."* https://www.postgresql.org/docs/release/12.0/

[^pg13-wal-rel]: PostgreSQL 13 release notes: *"Allow EXPLAIN, auto_explain, autovacuum, and pg_stat_statements to track WAL usage statistics (Kirill Bychik, Julien Rouhaud)."* https://www.postgresql.org/docs/release/13.0/

[^memoize]: PostgreSQL 14 release notes: *"Add executor method to memoize results from the inner side of a nested-loop join (David Rowley). This is useful if only a small percentage of rows is checked on the inner side. It can be disabled via server parameter enable_memoize."* https://www.postgresql.org/docs/release/14.0/

[^pg14-iif-not-exists]: PostgreSQL 14 release notes: *"Fix EXPLAIN CREATE TABLE AS and EXPLAIN CREATE MATERIALIZED VIEW to honor IF NOT EXISTS (Bharath Rupireddy). Previously, if the object already existed, EXPLAIN would fail."* https://www.postgresql.org/docs/release/14.0/

[^pg15-temp-io]: PostgreSQL 15 release notes: *"Add EXPLAIN (BUFFERS) output for temporary file block I/O (Masahiko Sawada)."* https://www.postgresql.org/docs/release/15.0/

[^pg15-pgtemp]: PostgreSQL 15 release notes: *"When EXPLAIN references the session's temporary object schema, refer to it as pg_temp (Amul Sul). Previously the actual schema name was reported, leading to inconsistencies across sessions."* https://www.postgresql.org/docs/release/15.0/

[^generic-plan-rel]: PostgreSQL 16 release notes: *"Add EXPLAIN option GENERIC_PLAN to display the generic plan for a parameterized query (Laurenz Albe)."* https://www.postgresql.org/docs/release/16.0/

[^pg16-memoize-union]: PostgreSQL 16 release notes: *"Allow memoize atop a UNION ALL (Richard Guo)."* https://www.postgresql.org/docs/release/16.0/

[^pg16-auto-explain-params]: PostgreSQL 16 release notes: *"Allow auto_explain to log values passed to parameterized statements (Dagfinn Ilmari Mannsåker). This affects queries using server-side PREPARE/EXECUTE and client-side parse/bind. Logging is controlled by auto_explain.log_parameter_max_length; by default query parameters will be logged with no length restriction."* https://www.postgresql.org/docs/release/16.0/

[^serialize-rel]: PostgreSQL 17 release notes: *"Add EXPLAIN option SERIALIZE to report the cost of converting data for network transmission (Stepan Rutz, Matthias van de Meent)."* https://www.postgresql.org/docs/release/17.0/

[^memory-rel]: PostgreSQL 17 release notes: *"Allow EXPLAIN to report optimizer memory usage (Ashutosh Bapat). The option is called MEMORY."* https://www.postgresql.org/docs/release/17.0/

[^pg17-local-io]: PostgreSQL 17 release notes: *"Add local I/O block read/write timing statistics to EXPLAIN's BUFFERS output (Nazir Bilal Yavuz)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-subplan]: PostgreSQL 17 release notes: *"Improve EXPLAIN's display of SubPlan nodes and output parameters (Tom Lane, Dean Rasheed)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-jit]: PostgreSQL 17 release notes: *"Add JIT deform_counter details to EXPLAIN (Dmitry Dolgov)."* https://www.postgresql.org/docs/release/17.0/

[^pg18-buffers-auto]: PostgreSQL 18 release notes: *"Automatically include BUFFERS output in EXPLAIN ANALYZE (Guillaume Lelarge, David Rowley)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-wal]: PostgreSQL 18 release notes: *"Add full WAL buffer count to EXPLAIN (WAL) output (Bertrand Drouvot)."* — also reflected in PG18 sql-explain.html WAL option: *"the number of times the WAL buffers became full."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/sql-explain.html

[^pg18-index-lookups]: PostgreSQL 18 release notes: *"In EXPLAIN ANALYZE, report the number of index lookups used per index scan node (Peter Geoghegan)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-frac-rows]: PostgreSQL 18 release notes: *"Modify EXPLAIN to output fractional row counts (Ibrar Ahmed, Ilia Evdokimov, Robert Haas)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-mem-disk]: PostgreSQL 18 release notes: *"Add memory and disk usage details to Material, Window Aggregate, and common table expression nodes to EXPLAIN output (David Rowley, Tatsuo Ishii)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-window-args]: PostgreSQL 18 release notes: *"Add details about window function arguments to EXPLAIN output (Tom Lane)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-parallel-bitmap]: PostgreSQL 18 release notes: *"Add Parallel Bitmap Heap Scan worker cache statistics to EXPLAIN ANALYZE (David Geier, Heikki Linnakangas, Donghang Lin, Alena Rybakina, David Rowley)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-disabled]: PostgreSQL 18 release notes: *"Indicate disabled nodes in EXPLAIN ANALYZE output (Robert Haas, David Rowley, Laurenz Albe)."* https://www.postgresql.org/docs/release/18.0/

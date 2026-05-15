# pg_stat_statements — Per-Query Workload Statistics

`pg_stat_statements` is the canonical contrib extension for **per-query** aggregated execution and I/O statistics. Where `pg_stat_activity` shows *what is running right now* and `EXPLAIN ANALYZE` shows *one execution* of one statement, `pg_stat_statements` shows *which query patterns dominate the cluster's workload over time*. It is the single most-leveraged observability tool a working DBA can install.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Installation](#installation)
    - [The pg_stat_statements View](#the-pg_stat_statements-view)
    - [The pg_stat_statements_info View](#the-pg_stat_statements_info-view)
    - [queryid and Normalization](#queryid-and-normalization)
    - [compute_query_id and pg_stat_activity.query_id](#compute_query_id-and-pg_stat_activityquery_id)
    - [Configuration GUCs](#configuration-gucs)
    - [Reset Functions](#reset-functions)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach here when:

- You need to find the queries consuming the most cumulative time on a cluster.
- You need to attribute I/O, WAL volume, JIT cost, or temp-file usage to specific queries.
- You are tuning `pg_stat_statements.max`, `track`, `track_planning`, or `track_utility`.
- You are upgrading PG versions and need to know whether `queryid` values, column names, or the reset function signature changed.
- You need to combine `pg_stat_statements.queryid` with `pg_stat_activity.query_id` or `EXPLAIN VERBOSE`'s query identifier to correlate aggregate stats with a live or planned execution.

If your question is *interpret one specific slow query's plan*, see [`56-explain.md`](./56-explain.md). If the question is *what is happening right now*, see [`58-performance-diagnostics.md`](./58-performance-diagnostics.md). If the question is *which planner GUCs to tune for the workload these stats reveal*, see [`59-planner-tuning.md`](./59-planner-tuning.md).

## Mental Model

Five rules drive almost every interaction with `pg_stat_statements`:

1. **It is an extension and requires `shared_preload_libraries`.** Setting the GUC, restarting the server, then `CREATE EXTENSION pg_stat_statements` in the target database is the canonical sequence. The verbatim docs requirement: *"The module must be loaded by adding `pg_stat_statements` to `shared_preload_libraries` in `postgresql.conf`, because it requires additional shared memory. This means that a server restart is needed to add or remove the module."*[^load] `ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'` alone is not enough — without the restart no statistics are collected.

2. **Queries are normalized by a post-parse-analysis jumble.** Constants are stripped and replaced with placeholders (`$1`, `$2`, …) so `SELECT * FROM t WHERE id = 5` and `SELECT * FROM t WHERE id = 47` collapse to one row keyed by a single `queryid`. The verbatim rule: *"Since the `queryid` hash value is computed on the post-parse-analysis representation of the queries, the opposite is also possible: queries with identical texts might appear as separate entries, if they have different meanings as a result of factors such as different `search_path` settings."*[^queryid-search-path] Plus: *"it is not safe to assume that `queryid` will be stable across major versions of PostgreSQL."*[^queryid-unstable]

3. **The view is bounded by `pg_stat_statements.max` (default `5000`) and evicts least-frequently-executed entries.** Verbatim: *"If more distinct statements than that are observed, information about the least-executed statements is discarded."*[^max] The `dealloc` counter in `pg_stat_statements_info` rises every time an entry is discarded; non-zero `dealloc` means your buffer is too small for your workload.

4. **`track_planning` is `off` by default.** The plan-time columns (`plans`, `total_plan_time`, `min/max/mean/stddev_plan_time`) exist in PG13+ but report zero unless `pg_stat_statements.track_planning = on`. Verbatim warning: *"Enabling this parameter may incur a noticeable performance penalty, especially when statements with identical query structure are executed by many concurrent connections which compete to update a small number of `pg_stat_statements` entries."*[^track-planning]

5. **`save = on` (default) persists across clean shutdown; `pg_stat_statements_reset()` does not survive restart unless saved.** Verbatim: *"`pg_stat_statements.save` specifies whether to save statement statistics across server shutdowns. If it is `off` then statistics are not saved at shutdown nor reloaded at server start. The default value is `on`."*[^save] Note: a *crash* (not a clean stop) loses all stats regardless of `save`. After `pg_upgrade` the queryid hash is not portable and stats start from zero on the new cluster.

> [!WARNING] queryid changes silently across major versions
> A query that has queryid `-1234567890123` on PG16 will have a *different* queryid on PG17 even with identical text. Dashboards that pin to a queryid (Datadog, Grafana, pganalyze) must be rebuilt after `pg_upgrade`. Re-attribute by `query` text or `regexp_replace(query, '\$\d+', '?', 'g')`. The verbatim docs quote *"it is not safe to assume that `queryid` will be stable across major versions of PostgreSQL"*[^queryid-unstable] is the headline upgrade-time misconception-defeater.

## Decision Matrix

| You want to … | Order by / filter | Avoid | Why |
|---|---|---|---|
| Find queries consuming most cumulative time | `ORDER BY total_exec_time DESC` | `ORDER BY mean_exec_time DESC` | Mean misses high-frequency moderate-cost queries that dominate aggregate load |
| Find p99-tail outliers | `ORDER BY max_exec_time DESC` filter `calls > 100` | `mean_exec_time` alone | `mean` averages out tail latency; `max_exec_time` shows the worst single execution |
| Find queries spilling to temp files | `WHERE temp_blks_written > 0 ORDER BY temp_blks_written DESC` | guessing from `work_mem` | Temp-block I/O is the direct evidence of `work_mem` undersizing — cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) Recipe 5 |
| Find queries emitting most WAL | `ORDER BY wal_bytes DESC` filter `wal_records > 0` | guessing from `INSERT/UPDATE/DELETE` text | `wal_bytes` is the direct measurement; surfaces hot indexed columns and HOT failures — cross-reference [`30-hot-updates.md`](./30-hot-updates.md) |
| Find queries doing most disk reads | `ORDER BY shared_blks_read DESC` | `shared_blks_hit` alone | `_read` is buffer misses (disk); `_hit` is buffer hits (cache) — `_read` reveals working-set vs `shared_buffers` mismatch |
| Find queries where planning dominates execution | `WHERE total_plan_time > total_exec_time AND track_planning=on` | tracking planning by default | `track_planning=off` by default; turn on only when investigating planning overhead, cross-reference Recipe 8 |
| Diagnose dealloc pressure | `SELECT dealloc FROM pg_stat_statements_info` | guessing `max` setting | Non-zero `dealloc` means buffer too small; raise `pg_stat_statements.max` and restart |
| Find JIT-impacted queries (PG15+) | `WHERE jit_functions > 0 ORDER BY jit_generation_time DESC` | global JIT-off as the first fix | JIT columns are per-query; identify the offenders before disabling cluster-wide — cross-reference [`61-jit-compilation.md`](./61-jit-compilation.md) |
| Reset stats for one query without resetting all | `pg_stat_statements_reset(userid=0, dbid=0, queryid=<id>)` | `pg_stat_statements_reset()` no-args | Three-arg form is per-query; no-args resets everything |
| Reset only minmax tails (PG17+) | `pg_stat_statements_reset(0, 0, 0, true)` | full reset to clear outliers | `minmax_only=true` PG17+ clears just `min/max_plan_time` and `min/max_exec_time`[^reset-minmax] |
| Correlate aggregate stats with a running query | join `pg_stat_activity.query_id = pg_stat_statements.queryid` | matching by SQL text | `compute_query_id = auto` (default) populates `pg_stat_activity.query_id` when pg_stat_statements loaded[^compute-query-id] |
| Compare before/after a deployment | snapshot, change, compare deltas via `stats_since` columns (PG17+) | full reset between deploys | PG17+ `stats_since` lets you compute deltas without resetting[^pg17-stats-since] |

Three smell signals to act on before any deep query analysis:

- **`pg_stat_statements_info.dealloc > 0`** — buffer is evicting; raise `pg_stat_statements.max` (default 5000 is undersized for any cluster with thousands of distinct queries from ORMs or framework code).
- **`track_planning = off` AND you are investigating slow planning** — turn on, wait a few minutes, then re-query. Plan-time columns are zero until `track_planning = on`.
- **One queryid has `calls = 1` and dominates `total_exec_time`** — likely a one-off `pg_dump` or `REINDEX` or `VACUUM FULL` that should be filtered out of dashboards via `WHERE calls > <threshold>`.

## Syntax / Mechanics

### Installation

Three-step sequence with explicit restart:

```sql
-- 1. Add to shared_preload_libraries (postgresql.conf or ALTER SYSTEM)
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';

-- 2. Restart cluster (pg_reload_conf() does NOT suffice — postmaster context)
--    pg_ctl restart  OR  systemctl restart postgresql

-- 3. Per-database: register the extension
CREATE EXTENSION pg_stat_statements;
```

Verify installation:

```sql
SELECT name, setting FROM pg_settings WHERE name = 'shared_preload_libraries';
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
SELECT count(*) FROM pg_stat_statements;  -- should return a number, not error
```

Verbatim docs note on access: *"For security reasons, only superusers and roles with privileges of the `pg_read_all_stats` role are allowed to see the SQL text and `queryid` of queries executed by other users. Other users can see the statistics, however, if the view has been installed in their database."*[^read-all-stats]

Non-superusers reading the view see their own query text + queryids; other users' rows have `query = '<insufficient privilege>'`. Grant `pg_read_all_stats` to monitoring roles — cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) Recipe 8.

> [!NOTE] PostgreSQL 13
> `pg_stat_statements.track_planning` GUC, the `plans` / `total_plan_time` / `min_plan_time` / `max_plan_time` / `mean_plan_time` / `stddev_plan_time` columns, and the `wal_records` / `wal_fpi` / `wal_bytes` WAL counters all landed in PG13. The PG13 release notes wording: *"Allow EXPLAIN, auto_explain, autovacuum, and pg_stat_statements to track WAL usage statistics"*[^pg13-wal] establishes the WAL columns.

### The pg_stat_statements View

The view exposes one row per (userid, dbid, queryid, toplevel) combination. PG16 column catalog (42 columns) — version-introduced annotations inline:

| Column | Type | What it is |
|---|---|---|
| `userid` | `oid` | OID of the user who executed the statement |
| `dbid` | `oid` | OID of the database in which the statement was executed |
| `toplevel` | `bool` | Whether the call was top-level (vs nested in a function) — **PG14+**[^pg14-toplevel] |
| `queryid` | `bigint` | Hash code identifying the normalized statement |
| `query` | `text` | Representative text of the normalized statement |
| `plans` | `bigint` | Number of times the statement was planned (zero unless `track_planning=on`) — **PG13+** |
| `total_plan_time` | `double precision` | Total time spent planning, in ms — PG13+ |
| `min_plan_time` | `double precision` | Minimum planning time, in ms — PG13+ |
| `max_plan_time` | `double precision` | Maximum planning time, in ms — PG13+ |
| `mean_plan_time` | `double precision` | Mean planning time, in ms — PG13+ |
| `stddev_plan_time` | `double precision` | Standard deviation of planning time, in ms — PG13+ |
| `calls` | `bigint` | Number of times the statement was executed |
| `total_exec_time` | `double precision` | Total time spent executing, in ms |
| `min_exec_time` | `double precision` | Minimum execution time, in ms |
| `max_exec_time` | `double precision` | Maximum execution time, in ms |
| `mean_exec_time` | `double precision` | Mean execution time, in ms |
| `stddev_exec_time` | `double precision` | Standard deviation of execution time, in ms |
| `rows` | `bigint` | Total number of rows retrieved or affected |
| `shared_blks_hit` | `bigint` | Total shared-buffer block hits |
| `shared_blks_read` | `bigint` | Total shared-buffer block reads (i.e., disk reads) |
| `shared_blks_dirtied` | `bigint` | Total shared blocks dirtied |
| `shared_blks_written` | `bigint` | Total shared blocks written (e.g., by backend due to full buffers) |
| `local_blks_hit` | `bigint` | Local block hits (temp tables/indexes) |
| `local_blks_read` | `bigint` | Local block reads |
| `local_blks_dirtied` | `bigint` | Local blocks dirtied |
| `local_blks_written` | `bigint` | Local blocks written |
| `temp_blks_read` | `bigint` | Temp file blocks read (work_mem spills) |
| `temp_blks_written` | `bigint` | Temp file blocks written |
| `blk_read_time` | `double precision` | Time spent reading from shared blocks (renamed `shared_blk_read_time` in **PG17+**)[^pg17-renames] |
| `blk_write_time` | `double precision` | Time spent writing shared blocks (renamed `shared_blk_write_time` in **PG17+**) |
| `temp_blk_read_time` | `double precision` | Time spent reading temp blocks — **PG15+**[^pg15-tempblk] |
| `temp_blk_write_time` | `double precision` | Time spent writing temp blocks — PG15+ |
| `wal_records` | `bigint` | WAL records emitted — PG13+ |
| `wal_fpi` | `bigint` | Full-page images written — PG13+ |
| `wal_bytes` | `numeric` | Bytes of WAL emitted — PG13+ |
| `jit_functions` | `bigint` | Number of JIT-compiled functions — **PG15+**[^pg15-jit] |
| `jit_generation_time` | `double precision` | Total time spent generating JIT code, ms — PG15+ |
| `jit_inlining_count` | `bigint` | Number of times inlining was performed — PG15+ |
| `jit_inlining_time` | `double precision` | Total inlining time, ms — PG15+ |
| `jit_optimization_count` | `bigint` | Number of times optimization was performed — PG15+ |
| `jit_optimization_time` | `double precision` | Total optimization time, ms — PG15+ |
| `jit_emission_count` | `bigint` | Number of times JIT emission ran — PG15+ |
| `jit_emission_time` | `double precision` | Total emission time, ms — PG15+ |

> [!NOTE] PostgreSQL 17
> Three significant column changes. (1) `blk_read_time` → `shared_blk_read_time` and `blk_write_time` → `shared_blk_write_time` (verbatim release note: *"Rename pg_stat_statements columns `blk_read_time` and `blk_write_time` to `shared_blk_read_time` and `shared_blk_write_time`"*[^pg17-renames]). (2) New columns `local_blk_read_time` and `local_blk_write_time` (verbatim: *"Add pg_stat_statements columns to report local block I/O timings"*[^pg17-local-time]). (3) New columns `stats_since` and `minmax_stats_since` for delta computation (verbatim: *"Add pg_stat_statements columns `stats_since` and `minmax_stats_since` to show last-reset times"*[^pg17-stats-since]). (4) New `jit_deform_count` and `jit_deform_time` columns (verbatim: *"Add JIT deform_counter details to pg_stat_statements"*[^pg17-jit-deform]). Monitoring queries written for PG16 must be rewritten — any `blk_read_time` reference returns "column does not exist" on PG17+.

> [!NOTE] PostgreSQL 18
> Two new columns: `parallel_workers_to_launch` and `parallel_workers_launched` (verbatim: *"Add pg_stat_statements columns to report parallel activity"*[^pg18-parallel]), plus `wal_buffers_full` (verbatim: *"Add pg_stat_statements.wal_buffers_full to report full WAL buffers"*[^pg18-wal-buffers-full]). Plus three normalization additions: (a) `CREATE TABLE AS` and `DECLARE` queries are now tracked and assigned queryids (verbatim: *"Allow the queries of CREATE TABLE AS and DECLARE to be tracked by pg_stat_statements"*[^pg18-ctas-declare]); (b) `SET` statement values parameterized (verbatim: *"Allow the parameterization of SET values in pg_stat_statements"*[^pg18-set]).

### The pg_stat_statements_info View

Single-row view exposing meta-statistics about the extension itself:

| Column | Type | What it is |
|---|---|---|
| `dealloc` | `bigint` | Number of times least-executed entries have been evicted because `pg_stat_statements.max` was exceeded[^dealloc-quote] |
| `stats_reset` | `timestamp with time zone` | When all stats were last reset (via `pg_stat_statements_reset()` no-args) |

`dealloc` is the canonical capacity-pressure signal. If it grows over a period of normal operations, your buffer is too small. Verbatim docs: *"Total number of times pg_stat_statements entries about the least-executed statements were deallocated because more distinct statements than `pg_stat_statements.max` were observed."*[^dealloc-quote]

### queryid and Normalization

The `queryid` is a 64-bit signed hash computed on the post-parse-analysis tree of a query. Constants are folded out; `WHERE id = 5` and `WHERE id = 47` produce identical queryids. The representative `query` text shown stores `$1`, `$2`, … placeholders.

Two rules that surprise operators:

**Search path affects queryid.** Same SQL text with different `search_path` produces different queryids because the planner resolves table names through the path, and the resolved OIDs feed the jumble. Verbatim: *"queries with identical texts might appear as separate entries, if they have different meanings as a result of factors such as different `search_path` settings."*[^queryid-search-path] The corollary: standardizing `search_path` across application roles reduces query-entry sprawl.

**Architecture and platform affect queryid.** Verbatim: *"The hashing process is also sensitive to differences in machine architecture and other facets of the platform."*[^queryid-arch] Two replicas built from the same base backup will hash identically; a cross-architecture replica (extremely rare in practice) may not.

**Pre-PG17 caveats normalized only in PG17+:**

| Statement form | Pre-PG17 behavior | PG17+ behavior |
|---|---|---|
| `SAVEPOINT my_sp_001` | Each savepoint name → different row | Names replaced with placeholders[^pg17-savepoint] |
| `PREPARE TRANSACTION 'gid-abc'` | Each GID → different row | GIDs replaced with placeholders[^pg17-gid] |
| `CALL my_proc(1, 2)` | Inline constants tracked separately | Parameters normalized to placeholders[^pg17-call] |
| `DEALLOCATE my_prep_stmt` | Each name → different row | Names normalized[^pg17-dealloc-stmt] |

The cumulative effect on PG≤16 clusters running OLTP frameworks (every web request often issues a `SAVEPOINT`+`RELEASE SAVEPOINT` pair) is that thousands of `SAVEPOINT s_<uuid>` rows fill the buffer and evict the queries that matter. On PG17+ these collapse to two rows total.

### compute_query_id and pg_stat_activity.query_id

The queryid hash function was moved from pg_stat_statements into core in PG14. The GUC `compute_query_id` (PG14+) controls in-core hashing:

| Value | Behavior |
|---|---|
| `off` | No queryid computation |
| `on` | Always compute queryid in core |
| `auto` (default) | Compute when an extension like `pg_stat_statements` requests it[^compute-query-id] |
| `regress` | Same as `auto`, but EXPLAIN does not show the id (for regression testing) |

When `compute_query_id = auto` and `pg_stat_statements` is loaded, the queryid is available in three additional places:

- `pg_stat_activity.query_id` — the queryid of the currently-running statement for each backend
- `EXPLAIN VERBOSE` output — the queryid is included for the EXPLAINed statement
- `log_line_prefix` — `%Q` emits the queryid into log lines

This enables the canonical "what is this slow query doing right now AND historically?" join — see Recipe 10.

> [!NOTE] PostgreSQL 14
> Verbatim from release notes: *"Move pg_stat_statements query hash computation to the core server (Julien Rouhaud)"* and the introduction of `compute_query_id` (default `auto`). The `pg_stat_activity.query_id` column is also PG14+. Pre-PG14 clusters can correlate only via SQL text.

> [!NOTE] PostgreSQL 16
> auto_explain's `log_verbose` mode now honors `compute_query_id` (verbatim: *"Have auto_explain's `log_verbose` mode honor the value of `compute_query_id`"*). Previously the queryid was missing from auto_explain output even when `compute_query_id` was on. Combined with auto_explain enabled in production (cross-reference [`56-explain.md`](./56-explain.md) Recipe 12), this gives full plan-text capture keyed by the same queryid as `pg_stat_statements`.

### Configuration GUCs

Six tunables; defaults are usually correct except `max` for high-cardinality workloads:

| GUC | Default | Context | What it controls |
|---|---|---|---|
| `pg_stat_statements.max` | `5000` | postmaster | Maximum tracked entries[^max] |
| `pg_stat_statements.track` | `top` | superuser | `none` / `top` / `all` — nested statement tracking[^track] |
| `pg_stat_statements.track_utility` | `on` | superuser | Track non-DML statements (DDL, CREATE, DROP, SAVEPOINT, etc.)[^track-utility] |
| `pg_stat_statements.track_planning` | `off` | superuser | Track planning time (perf overhead)[^track-planning] |
| `pg_stat_statements.save` | `on` | postmaster | Persist stats across clean shutdown[^save] |

The verbatim docs descriptions:

- `track`: *"Specify `top` to track top-level statements (those issued directly by clients), `all` to also track nested statements (such as statements invoked within functions), or `none` to disable statement statistics collection. The default value is `top`."*[^track]
- `track_utility`: *"Utility commands are all those other than `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `MERGE`. The default value is `on`."*[^track-utility]
- `track_planning`: *"Enabling this parameter may incur a noticeable performance penalty, especially when statements with identical query structure are executed by many concurrent connections which compete to update a small number of `pg_stat_statements` entries."*[^track-planning]
- `save`: *"If it is `off` then statistics are not saved at shutdown nor reloaded at server start."*[^save]

### Reset Functions

Three reset paths, with version-specific signatures:

```sql
-- PG≤16 signature
pg_stat_statements_reset(userid Oid, dbid Oid, queryid bigint) RETURNS void

-- PG17+ signature
pg_stat_statements_reset(
    userid Oid,
    dbid Oid,
    queryid bigint,
    minmax_only boolean DEFAULT false
) RETURNS timestamp with time zone
```

Verbatim PG17 description of `minmax_only`: *"When `minmax_only` is `true` only the values of minimum and maximum planning and execution time will be reset (i.e. `min_plan_time`, `max_plan_time`, `min_exec_time` and `max_exec_time` fields). The default value for `minmax_only` parameter is `false`."*[^reset-minmax]

Behavior:

- `pg_stat_statements_reset()` (no args) — reset everything; on PG17+ returns the reset timestamp
- `pg_stat_statements_reset(0, 0, 0)` — same as no args (zero is the wildcard)
- `pg_stat_statements_reset(0, 0, <queryid>)` — reset stats for one query across all users + databases
- `pg_stat_statements_reset(<userid>, 0, 0)` — reset stats for one user
- `pg_stat_statements_reset(0, <dbid>, 0)` — reset stats for one database
- `pg_stat_statements_reset(0, 0, 0, true)` — PG17+ only: reset only minmax columns (preserves total/calls/etc.)

Default permissions: superuser-only. Verbatim: *"By default, this function can only be executed by superusers. Access may be granted to others using `GRANT`."*[^reset-grant]

### Per-Version Timeline

| Version | Changes |
|---|---|
| **PG13** | `track_planning` GUC + `plans` / `*_plan_time` columns. WAL counters: `wal_records`, `wal_fpi`, `wal_bytes`. |
| **PG14** | Move queryid hashing to core via `compute_query_id`. New `toplevel` column[^pg14-toplevel]. `pg_stat_statements_info` view introduced (with `dealloc` and `stats_reset`). Row counts for utility commands. Queryid now exposed in `pg_stat_activity.query_id`, EXPLAIN VERBOSE, `log_line_prefix` `%Q`. |
| **PG15** | JIT counters added (`jit_functions`, `jit_generation_time`, `jit_inlining_count`, `jit_inlining_time`, `jit_optimization_count`, `jit_optimization_time`, `jit_emission_count`, `jit_emission_time`)[^pg15-jit]. Temp-block timing: `temp_blk_read_time`, `temp_blk_write_time`[^pg15-tempblk]. |
| **PG16** | Constants in utility commands now normalized (e.g., `CLUSTER my_table USING $1`). Extended-query-protocol row counts corrected. auto_explain `log_verbose` honors `compute_query_id`. |
| **PG17** | `blk_read_time` → `shared_blk_read_time` (rename)[^pg17-renames]. Local-block timing: `local_blk_read_time`, `local_blk_write_time`[^pg17-local-time]. Delta columns: `stats_since`, `minmax_stats_since`[^pg17-stats-since]. JIT deform: `jit_deform_count`, `jit_deform_time`[^pg17-jit-deform]. Reset function gains `minmax_only` boolean + `timestamptz` return[^reset-minmax]. SAVEPOINT names[^pg17-savepoint], 2PC GIDs[^pg17-gid], CALL parameters[^pg17-call], DEALLOCATE names[^pg17-dealloc-stmt] all normalized. |
| **PG18** | Parallel-worker columns: `parallel_workers_to_launch`, `parallel_workers_launched`[^pg18-parallel]. WAL buffers: `wal_buffers_full`[^pg18-wal-buffers-full]. Track `CREATE TABLE AS` and `DECLARE`[^pg18-ctas-declare]. `SET` statement values parameterized[^pg18-set]. |

## Examples / Recipes

### Recipe 1: Install and verify (baseline)

The canonical three-step install with verification:

```sql
-- Step 1: edit postgresql.conf or:
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
-- Optional tuning for moderate-to-busy clusters:
ALTER SYSTEM SET pg_stat_statements.max = 10000;
ALTER SYSTEM SET track_io_timing = on;  -- so blk_*_time columns populate

-- Step 2: restart cluster (NOT just pg_reload_conf)
-- pg_ctl -D $PGDATA restart -m fast

-- Step 3: per-database
CREATE EXTENSION pg_stat_statements;

-- Verify
SELECT name, setting FROM pg_settings WHERE name IN (
    'shared_preload_libraries', 'compute_query_id', 'track_io_timing',
    'pg_stat_statements.max', 'pg_stat_statements.track',
    'pg_stat_statements.track_planning', 'pg_stat_statements.save'
);

SELECT count(*) AS entries FROM pg_stat_statements;
SELECT * FROM pg_stat_statements_info;  -- dealloc=0, stats_reset=<install time>
```

### Recipe 2: Top 10 queries by cumulative time

The single most useful pg_stat_statements query:

```sql
SELECT
    userid::regrole AS user,
    (total_exec_time / 1000)::int AS total_sec,
    calls,
    (mean_exec_time)::numeric(10, 2) AS mean_ms,
    rows,
    100 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0)
        AS cache_hit_pct,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE userid::regrole::text NOT IN ('postgres', 'pg_monitor')  -- filter admin
ORDER BY total_exec_time DESC
LIMIT 10;
```

`total_exec_time DESC` reveals the queries that *cost the cluster the most*, not the slowest single execution. A query called 10M times at 1ms each (10000 sec total) outranks a query called once at 5000 sec.

### Recipe 3: Top 10 queries by tail latency

For p99-style worst-case investigation:

```sql
SELECT
    queryid,
    calls,
    (mean_exec_time)::numeric(10, 2) AS mean_ms,
    (max_exec_time)::numeric(10, 2) AS max_ms,
    (max_exec_time / mean_exec_time)::numeric(10, 1) AS max_over_mean,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE calls > 100  -- ignore one-offs
  AND max_exec_time > 1000  -- focus on >1s outliers
ORDER BY max_exec_time DESC
LIMIT 10;
```

`max_over_mean` greater than 10× often points at parameter-skew issues: the generic plan is OK for 99% of values but disastrous for 1%. Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) on `plan_cache_mode`.

### Recipe 4: Queries spilling to temp files

`work_mem` undersizing manifests here:

```sql
SELECT
    queryid,
    calls,
    (mean_exec_time)::numeric(10, 2) AS mean_ms,
    pg_size_pretty(temp_blks_read::bigint * 8192) AS temp_read,
    pg_size_pretty(temp_blks_written::bigint * 8192) AS temp_written,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 20;
```

Any non-zero `temp_blks_written` indicates a sort, hash, or CTE materialize that exceeded `work_mem`. Three remediations in priority order: (1) raise `work_mem` per-role for the offending workload (cross-reference [`54-memory-tuning.md`](./54-memory-tuning.md) Recipe 3), (2) raise `hash_mem_multiplier` (PG13+) if Hash nodes dominate, (3) add an index that lets the planner avoid the sort/hash entirely.

### Recipe 5: Queries emitting most WAL

Targets write-amplification hot spots:

```sql
SELECT
    queryid,
    calls,
    pg_size_pretty(wal_bytes::bigint) AS total_wal,
    pg_size_pretty((wal_bytes / nullif(calls, 0))::bigint) AS wal_per_call,
    wal_fpi,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE wal_bytes > 0
ORDER BY wal_bytes DESC
LIMIT 20;
```

High `wal_fpi` per call indicates full-page images dominate — usually means a HOT-update failure on a hot indexed column (cross-reference [`30-hot-updates.md`](./30-hot-updates.md)) or checkpoints too frequent (cross-reference [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md)). On PG18+, additionally check `wal_buffers_full` to detect WAL writer pressure.

### Recipe 6: Per-query cache-hit profile

Identifies queries with poor working-set residency:

```sql
SELECT
    queryid,
    calls,
    shared_blks_hit + shared_blks_read AS total_blks,
    round(100.0 * shared_blks_hit /
          nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
    pg_size_pretty(shared_blks_read::bigint * 8192) AS disk_read,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE shared_blks_hit + shared_blks_read > 1000  -- meaningful volume
ORDER BY shared_blks_read DESC
LIMIT 20;
```

`hit_pct < 95%` on a high-volume query is a working-set-vs-`shared_buffers` mismatch; raise `shared_buffers` if RAM is available (cross-reference [`32-buffer-manager.md`](./32-buffer-manager.md) Recipe 1) or add an index that reduces the scan footprint.

### Recipe 7: JIT-impacted queries (PG15+)

JIT is a default-on PG12+ feature whose default thresholds (`jit_above_cost = 100000`) are appropriate for analytics but may waste cycles on short OLTP queries:

```sql
SELECT
    queryid,
    calls,
    jit_functions,
    (jit_generation_time + jit_inlining_time +
     jit_optimization_time + jit_emission_time)::numeric(10, 2) AS jit_total_ms,
    (total_exec_time)::numeric(10, 2) AS exec_total_ms,
    round(100.0 * (jit_generation_time + jit_inlining_time +
                   jit_optimization_time + jit_emission_time) /
          nullif(total_exec_time, 0), 1) AS jit_pct,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE jit_functions > 0
ORDER BY jit_total_ms DESC
LIMIT 20;
```

`jit_pct > 20%` means JIT compilation cost is a meaningful fraction of total time — raise `jit_above_cost` cluster-wide or `SET LOCAL jit = off` per-session for the affected queries. Cross-reference [`61-jit-compilation.md`](./61-jit-compilation.md).

### Recipe 8: Planning-dominates-execution detection (track_planning=on)

Requires `pg_stat_statements.track_planning = on`. Identifies prepared-statement misuse and generic-vs-custom plan flips:

```sql
-- One-time enable (requires reload; or include in ALTER SYSTEM)
ALTER SYSTEM SET pg_stat_statements.track_planning = on;
SELECT pg_reload_conf();

-- After a sample period
SELECT
    queryid,
    calls,
    (mean_plan_time)::numeric(10, 2) AS mean_plan_ms,
    (mean_exec_time)::numeric(10, 2) AS mean_exec_ms,
    round(mean_plan_time / nullif(mean_exec_time, 0), 1) AS plan_over_exec,
    substr(query, 1, 100) AS query
FROM pg_stat_statements
WHERE plans > 100
  AND mean_plan_time > mean_exec_time  -- planning dominates
ORDER BY total_plan_time DESC
LIMIT 20;
```

`mean_plan_time > mean_exec_time` on a frequently-called query is the signature of "the application opens a new connection and re-plans the same SQL every call." The fix is either prepared statements (where the planning is amortized) or a connection pooler that retains plans (cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) and [`81-pgbouncer.md`](./81-pgbouncer.md)). Always turn `track_planning` off again after diagnosis — the verbatim performance penalty quote applies.

### Recipe 9: Reset only minmax tails (PG17+)

Sometimes you want to clear outlier max-times without losing cumulative totals — e.g., after a one-time slow query that distorts the dashboard:

```sql
-- PG17+ only
SELECT pg_stat_statements_reset(0, 0, 0, true) AS reset_time;
-- Returns: timestamptz of the reset

-- For a single query
SELECT pg_stat_statements_reset(0, 0, <queryid>, true);
```

After the call, `min_exec_time`, `max_exec_time`, `min_plan_time`, `max_plan_time` are reset; `calls`, `total_exec_time`, `mean_exec_time`, etc. are preserved. Pre-PG17 there is no way to do this — the only option is a full reset.

### Recipe 10: Correlate aggregate stats with a running query

The canonical "this query is hung right now AND it's the slow one in the dashboard" join:

```sql
SELECT
    a.pid,
    a.state,
    a.wait_event_type,
    a.wait_event,
    (now() - a.query_start)::interval AS running_for,
    s.calls,
    (s.mean_exec_time)::numeric(10, 2) AS historical_mean_ms,
    (s.max_exec_time)::numeric(10, 2) AS historical_max_ms,
    a.query
FROM pg_stat_activity a
LEFT JOIN pg_stat_statements s ON s.queryid = a.query_id
WHERE a.state = 'active'
  AND a.pid != pg_backend_pid()
  AND a.query_start < now() - interval '10 seconds'
ORDER BY a.query_start ASC;
```

Requires `compute_query_id = auto` (default) or `on`, and `pg_stat_statements` loaded. The `LEFT JOIN` accommodates queries new enough that they don't yet appear in `pg_stat_statements`. Cross-reference [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) for the full `pg_stat_activity` surface.

### Recipe 11: Audit dealloc pressure

Detects buffer-undersizing operationally:

```sql
SELECT
    dealloc,
    stats_reset,
    age(now(), stats_reset) AS time_since_reset,
    (dealloc::numeric / nullif(extract(epoch FROM age(now(), stats_reset)), 0) * 3600)
        ::numeric(10, 2) AS dealloc_per_hour,
    (SELECT count(*) FROM pg_stat_statements) AS entries,
    current_setting('pg_stat_statements.max')::int AS max_entries
FROM pg_stat_statements_info;
```

Interpretation tiers:

- `dealloc_per_hour = 0` — buffer adequately sized
- `dealloc_per_hour < 10` — minor pressure, fine
- `dealloc_per_hour 10–1000` — buffer undersized by ~2×; raise `pg_stat_statements.max` to 10000 or 20000
- `dealloc_per_hour > 1000` — severe pressure; raise `max` to 50000 + investigate whether `track_utility = on` is needed (turning it off may be cleaner than raising max indefinitely)

### Recipe 12: Track query stability across deployments (PG17+)

Pre-PG17 the only delta computation is "snapshot, wait, diff" with two separate snapshots. PG17+ adds per-row `stats_since` and `minmax_stats_since` so you can compute deltas without locking:

```sql
-- PG17+ delta-without-reset pattern
WITH baseline AS (
    SELECT queryid, query, calls, total_exec_time, stats_since
    FROM pg_stat_statements
)
SELECT
    queryid,
    calls - lag(calls) OVER (PARTITION BY queryid ORDER BY stats_since)
        AS calls_delta,
    total_exec_time - lag(total_exec_time) OVER (PARTITION BY queryid ORDER BY stats_since)
        AS exec_time_delta,
    substr(query, 1, 100) AS query
FROM baseline
WHERE stats_since > now() - interval '1 hour'
ORDER BY exec_time_delta DESC NULLS LAST
LIMIT 20;
```

Pre-PG17 alternative: capture a snapshot before the deploy:

```sql
CREATE TABLE pss_baseline AS
SELECT queryid, calls, total_exec_time, total_plan_time,
       shared_blks_hit, shared_blks_read, wal_bytes,
       now() AS captured_at
FROM pg_stat_statements;

-- After the deploy + sample period
SELECT
    s.queryid,
    s.calls - coalesce(b.calls, 0) AS calls_delta,
    s.total_exec_time - coalesce(b.total_exec_time, 0) AS exec_delta,
    substr(s.query, 1, 100) AS query
FROM pg_stat_statements s
LEFT JOIN pss_baseline b ON b.queryid = s.queryid
ORDER BY (s.total_exec_time - coalesce(b.total_exec_time, 0)) DESC
LIMIT 20;
```

### Recipe 13: Find regressed queries after deploy

A specific cut of Recipe 12 — comparing two snapshots to find queries whose mean execution time got *worse*:

```sql
-- Snapshot A (before deploy): saved to pss_before
-- Snapshot B (after deploy + bake time): from pg_stat_statements now

WITH delta AS (
    SELECT
        s.queryid,
        s.calls - b.calls AS new_calls,
        s.total_exec_time - b.total_exec_time AS new_exec_time,
        (s.total_exec_time - b.total_exec_time) /
            nullif(s.calls - b.calls, 0) AS new_mean_ms,
        b.total_exec_time / nullif(b.calls, 0) AS old_mean_ms,
        s.query
    FROM pg_stat_statements s
    JOIN pss_before b ON b.queryid = s.queryid
    WHERE s.calls > b.calls + 100  -- only queries called many times in the window
)
SELECT
    queryid,
    new_calls,
    old_mean_ms::numeric(10, 2) AS before_ms,
    new_mean_ms::numeric(10, 2) AS after_ms,
    round((new_mean_ms / nullif(old_mean_ms, 0)), 2) AS slowdown_ratio,
    substr(query, 1, 100) AS query
FROM delta
WHERE new_mean_ms > old_mean_ms * 1.5  -- 50%+ slower
ORDER BY slowdown_ratio DESC
LIMIT 20;
```

Couple this with `auto_explain` capture during the same window to grab the plan of the regressed query — cross-reference [`56-explain.md`](./56-explain.md) Recipe 12.

## Gotchas / Anti-patterns

1. **`shared_preload_libraries` requires server restart.** `ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'` then `pg_reload_conf()` does NOT load the extension. The `pending_restart` flag will be set in `pg_settings`. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) gotcha #4.

2. **`queryid` is not stable across major versions.** Verbatim docs warning[^queryid-unstable]. Dashboards pinned to queryid break on `pg_upgrade`. Re-attribute via `query` text or regenerate dashboards using the new queryid space.

3. **`track_planning = off` by default; plan-time columns are zero until enabled.** A common debugging frustration: querying `mean_plan_time` and getting all zeros even though the user expected planning data. Enable explicitly, wait for traffic, then query.

4. **`pg_stat_statements.max = 5000` is too small for OLTP fleets.** A web application with ORM-generated SQL routinely produces tens of thousands of distinct queryids. `dealloc` in `pg_stat_statements_info` is the diagnostic; raise to 10000–50000.

5. **`queryid` is sensitive to `search_path`.** Two roles running the same SQL with different `search_path` see different queryids[^queryid-search-path]. Standardize search_path via `ALTER ROLE app SET search_path = …` to consolidate.

6. **`queryid` is sensitive to schema-qualified names.** `SELECT * FROM users` vs `SELECT * FROM public.users` are different queryids even with `search_path = public`. Pick a convention and stick to it.

7. **Non-superuser sees stats but not query text.** Verbatim: query text replaced with `<insufficient privilege>` for queries of other users[^read-all-stats]. Grant `pg_read_all_stats` to monitoring roles.

8. **`blk_read_time` / `blk_write_time` renamed in PG17.** Verbatim release-note[^pg17-renames]. Any pre-PG17 dashboard or extension querying `blk_read_time` returns "column does not exist" error on PG17+; use `shared_blk_read_time` and the new `local_blk_read_time` instead.

9. **JIT columns are PG15+, not PG14.** A frequent planning-note error. Verbatim PG15 release note: *"Add JIT counters to pg_stat_statements"*[^pg15-jit]. PG14 docs do not list these columns; queries SELECT'ing them on PG14 error out.

10. **`jit_deform_count` / `jit_deform_time` are PG17+, not PG18.** Another common version misattribution. Verbatim PG17: *"Add JIT deform_counter details to pg_stat_statements"*[^pg17-jit-deform].

11. **`wal_records` / `wal_fpi` / `wal_bytes` are PG13+, not PG14.** Present in PG14 docs but introduced earlier. Be specific about minimum-version requirements in monitoring tooling.

12. **`track_utility = on` (default) means SAVEPOINT, BEGIN, COMMIT count toward `max`.** On busy OLTP clusters, framework-generated `SAVEPOINT s_<uuid>` statements (pre-PG17 each name = distinct queryid) can dominate the buffer entirely. Two fixes: (a) upgrade to PG17+ (names normalized), or (b) `pg_stat_statements.track_utility = off` (cleaner but loses DDL visibility).

13. **Pre-PG17 each SAVEPOINT name is a separate row.** PG17+ replaces names with placeholders[^pg17-savepoint]. Pre-PG17 clusters running PgBouncer-with-server-side-savepoints accumulate thousands of `SAVEPOINT <random_name>` entries.

14. **Pre-PG17 each PREPARE TRANSACTION GID is a separate row.** PG17+ normalizes[^pg17-gid]. Distributed-transaction-heavy workloads (XA, 2PC over postgres_fdw) suffer here on PG≤16.

15. **Pre-PG17 each CALL with literal arguments is a separate row.** PG17+ normalizes parameters[^pg17-call].

16. **PG≤17 does NOT track `CREATE TABLE AS` or `DECLARE`.** PG18+ tracks both with queryids[^pg18-ctas-declare]. On pre-PG18 clusters these statements are invisible to pg_stat_statements regardless of `track_utility`.

17. **PG≤17 does NOT parameterize `SET` values.** Different `SET work_mem = '256MB'` and `SET work_mem = '512MB'` calls have distinct queryids on PG≤17. PG18+ normalizes[^pg18-set].

18. **`pg_stat_statements_reset()` returns `void` pre-PG17, `timestamptz` PG17+.** Tooling that captures the return value breaks across the upgrade. Verbatim PG17 signature change[^reset-minmax].

19. **`pg_stat_statements_reset` requires superuser by default.** Verbatim: *"By default, this function can only be executed by superusers."*[^reset-grant] Grant explicitly: `GRANT EXECUTE ON FUNCTION pg_stat_statements_reset(oid, oid, bigint) TO ops_user;` — note that the signature changed in PG17, grant the correct one.

20. **`compute_query_id = auto` is on by default ONLY when an extension requests it.** A cluster with `pg_stat_statements` not loaded has `compute_query_id = auto` but `pg_stat_activity.query_id` is always NULL. Setting `compute_query_id = on` forces computation regardless of extensions.

21. **`save = on` (default) persists only across clean shutdown.** A crash, `SIGKILL`, or OOM-killer event loses all stats. The verbatim docs say "saved across server shutdowns" — server-crash is not a shutdown[^save].

22. **Stats lost on `pg_upgrade`.** Verbatim: queryid not stable across majors[^queryid-unstable]. After upgrade the file is regenerated empty; do not rely on long-term historical comparisons.

23. **Pre-parameterized application queries already use placeholders.** A query sent through libpq with bind parameters (`PREPARE foo AS SELECT * FROM t WHERE id = $1; EXECUTE foo(5)`) is *already* parameterized; pg_stat_statements stores it as-is. Two clients sending the same `EXECUTE foo(5)` and `EXECUTE foo(47)` collapse to one row. Different from the literal-substitution behavior — same end state, different mechanism.

## See Also

- [`56-explain.md`](./56-explain.md) — per-execution plan inspection; pair with auto_explain to capture plan text per queryid
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity`, wait events, `pg_stat_io` (PG16+)
- [`55-statistics-planner.md`](./55-statistics-planner.md) — when bad plan choice is caused by stale or missing statistics, not by GUCs
- [`59-planner-tuning.md`](./59-planner-tuning.md) — cost GUCs and `enable_*` knobs informed by pg_stat_statements findings
- [`30-hot-updates.md`](./30-hot-updates.md) — high `wal_fpi` per call hints at HOT failures
- [`32-buffer-manager.md`](./32-buffer-manager.md) — low cache-hit% from Recipe 6 informs `shared_buffers` sizing
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — high `wal_fpi` cluster-wide also points to checkpoint frequency
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pg_read_all_stats` for non-superuser monitoring
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries` is postmaster context, requires restart
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `work_mem` undersizing diagnosed via `temp_blks_written`
- [`60-parallel-query.md`](./60-parallel-query.md) — PG18+ `parallel_workers_launched` column
- [`61-jit-compilation.md`](./61-jit-compilation.md) — JIT cost tuning informed by Recipe 7
- [`69-extensions.md`](./69-extensions.md) — extension loading mechanics
- [`81-pgbouncer.md`](./81-pgbouncer.md) — transaction-pooling interaction with prepared statements and queryid stability
- [`82-monitoring.md`](./82-monitoring.md) — postgres_exporter, log_min_duration_statement, full monitoring stack
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — prepared-statement plan caching and queryid behavior with `EXECUTE`
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — queryid hash reset on major-version upgrade

## Sources

[^load]: PG16 pg_stat_statements docs — "Installation" section. https://www.postgresql.org/docs/16/pgstatstatements.html

[^queryid-search-path]: PG16 pg_stat_statements docs — "queries with identical texts might appear as separate entries, if they have different meanings as a result of factors such as different `search_path` settings." https://www.postgresql.org/docs/16/pgstatstatements.html

[^queryid-unstable]: PG16 pg_stat_statements docs — "Furthermore, it is not safe to assume that `queryid` will be stable across major versions of PostgreSQL." https://www.postgresql.org/docs/16/pgstatstatements.html

[^queryid-arch]: PG16 pg_stat_statements docs — "The hashing process is also sensitive to differences in machine architecture and other facets of the platform." https://www.postgresql.org/docs/16/pgstatstatements.html

[^max]: PG16 pg_stat_statements docs — "`pg_stat_statements.max` is the maximum number of statements tracked by the module ... If more distinct statements than that are observed, information about the least-executed statements is discarded ... The default value is 5000." https://www.postgresql.org/docs/16/pgstatstatements.html

[^track]: PG16 pg_stat_statements docs — "Specify `top` to track top-level statements ... `all` to also track nested statements ... or `none` to disable statement statistics collection. The default value is `top`." https://www.postgresql.org/docs/16/pgstatstatements.html

[^track-utility]: PG16 pg_stat_statements docs — "Utility commands are all those other than `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `MERGE`. The default value is `on`." https://www.postgresql.org/docs/16/pgstatstatements.html

[^track-planning]: PG16 pg_stat_statements docs — "Enabling this parameter may incur a noticeable performance penalty, especially when statements with identical query structure are executed by many concurrent connections which compete to update a small number of `pg_stat_statements` entries. The default value is `off`." https://www.postgresql.org/docs/16/pgstatstatements.html

[^save]: PG16 pg_stat_statements docs — "`pg_stat_statements.save` specifies whether to save statement statistics across server shutdowns ... The default value is `on`." https://www.postgresql.org/docs/16/pgstatstatements.html

[^read-all-stats]: PG16 pg_stat_statements docs — "For security reasons, only superusers and roles with privileges of the `pg_read_all_stats` role are allowed to see the SQL text and `queryid` of queries executed by other users." https://www.postgresql.org/docs/16/pgstatstatements.html

[^reset-grant]: PG16 pg_stat_statements docs — "By default, this function can only be executed by superusers. Access may be granted to others using `GRANT`." https://www.postgresql.org/docs/16/pgstatstatements.html

[^reset-minmax]: PG17 pg_stat_statements docs — "When `minmax_only` is `true` only the values of minimum and maximum planning and execution time will be reset (i.e. `min_plan_time`, `max_plan_time`, `min_exec_time` and `max_exec_time` fields). The default value for `minmax_only` parameter is `false`." https://www.postgresql.org/docs/17/pgstatstatements.html

[^dealloc-quote]: PG16 pg_stat_statements docs — "Total number of times pg_stat_statements entries about the least-executed statements were deallocated because more distinct statements than `pg_stat_statements.max` were observed." https://www.postgresql.org/docs/16/pgstatstatements.html

[^compute-query-id]: PG16 runtime-config-statistics — "Valid values are `off` (always disabled), `on` (always enabled), `auto`, which lets modules such as pg_stat_statements automatically enable it ... The default is `auto`." https://www.postgresql.org/docs/16/runtime-config-statistics.html

[^pg13-wal]: PG13 release notes — "Allow EXPLAIN, auto_explain, autovacuum, and pg_stat_statements to track WAL usage statistics." https://www.postgresql.org/docs/release/13.0/

[^pg14-toplevel]: PG14 release notes — "Cause pg_stat_statements to track top and nested statements separately (Julien Rouhaud). Use the new toplevel column to distinguish them." https://www.postgresql.org/docs/release/14.0/

[^pg15-jit]: PG15 release notes — "Add JIT counters to pg_stat_statements (Magnus Hagander)." https://www.postgresql.org/docs/release/15.0/

[^pg15-tempblk]: PG15 release notes — "Add counters for temporary file block I/O" (the `temp_blk_read_time` / `temp_blk_write_time` columns of pg_stat_statements). https://www.postgresql.org/docs/release/15.0/

[^pg17-renames]: PG17 release notes — "Rename pg_stat_statements columns `blk_read_time` and `blk_write_time` to `shared_blk_read_time` and `shared_blk_write_time`." https://www.postgresql.org/docs/release/17.0/

[^pg17-local-time]: PG17 release notes — "Add pg_stat_statements columns to report local block I/O timings." https://www.postgresql.org/docs/release/17.0/

[^pg17-stats-since]: PG17 release notes — "Add pg_stat_statements columns `stats_since` and `minmax_stats_since` to show last-reset times." https://www.postgresql.org/docs/release/17.0/

[^pg17-jit-deform]: PG17 release notes — "Add JIT deform_counter details to pg_stat_statements." https://www.postgresql.org/docs/release/17.0/

[^pg17-savepoint]: PG17 release notes — "Replace savepoint names stored in pg_stat_statements with placeholders (Greg Sabino Mullane). This greatly reduces the number of entries needed to record `SAVEPOINT`, `RELEASE SAVEPOINT`, and `ROLLBACK TO SAVEPOINT` commands." https://www.postgresql.org/docs/release/17.0/

[^pg17-gid]: PG17 release notes — "Replace the two-phase commit GIDs stored in pg_stat_statements with placeholders (Michael Paquier). This greatly reduces the number of entries needed to record `PREPARE TRANSACTION`, `COMMIT PREPARED`, and `ROLLBACK PREPARED`." https://www.postgresql.org/docs/release/17.0/

[^pg17-call]: PG17 release notes — "Replace `CALL` arguments stored in pg_stat_statements with placeholders." https://www.postgresql.org/docs/release/17.0/

[^pg17-dealloc-stmt]: PG17 release notes — "Track DEALLOCATE statements in pg_stat_statements with placeholders for the prepared-statement names." https://www.postgresql.org/docs/release/17.0/

[^pg18-parallel]: PG18 release notes — "Add pg_stat_statements columns to report parallel activity (Guillaume Lelarge). The new columns are `parallel_workers_to_launch` and `parallel_workers_launched`." https://www.postgresql.org/docs/18/release-18.html

[^pg18-wal-buffers-full]: PG18 release notes — "Add pg_stat_statements.wal_buffers_full to report full WAL buffers (Bertrand Drouvot)." https://www.postgresql.org/docs/18/release-18.html

[^pg18-ctas-declare]: PG18 release notes — "Allow the queries of `CREATE TABLE AS` and `DECLARE` to be tracked by pg_stat_statements (Anthonin Bonnefoy). They are also now assigned query ids." https://www.postgresql.org/docs/18/release-18.html

[^pg18-set]: PG18 release notes — "Allow the parameterization of `SET` values in pg_stat_statements (Greg Sabino Mullane, Michael Paquier). This reduces the bloat caused by `SET` statements with differing constants." https://www.postgresql.org/docs/18/release-18.html

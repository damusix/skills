# JIT Compilation

PostgreSQL JIT (Just-In-Time) compilation: LLVM-based dynamic compilation of expression evaluation and tuple deforming, the three cost-threshold GUCs that drive the plan-time JIT decision, the four-phase JIT pipeline (generation / inlining / optimization / emission), and the per-version evolution of JIT instrumentation in `EXPLAIN` and `pg_stat_statements`.


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The Five-Rule Mental Model](#the-five-rule-mental-model)
    - [Decision Matrix](#decision-matrix)
    - [What JIT Compiles](#what-jit-compiles)
    - [The JIT Decision Flow](#the-jit-decision-flow)
    - [JIT Configuration GUCs](#jit-configuration-gucs)
    - [Reading EXPLAIN JIT Output](#reading-explain-jit-output)
    - [pg_stat_statements JIT Counters](#pg_stat_statements-jit-counters)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Load this file when:

- A short OLTP query has unexpectedly high planning + execution time and you suspect JIT compilation overhead
- An analytical query shows `JIT:` lines in `EXPLAIN ANALYZE` and you need to interpret the four-phase timing breakdown
- You are tuning `jit_above_cost`, `jit_inline_above_cost`, or `jit_optimize_above_cost` for your workload
- You want to disable JIT for one query / one role / one transaction without disabling it cluster-wide
- You upgrade to PG17 or PG18 and the LLVM library version requirement bumps
- You are reading the JIT columns in `pg_stat_statements` (PG15+) and want to know what `jit_deform_count` means (PG17+)
- A query plan shows `JIT: Functions: N`, `Generation: Xms`, `Inlining: Yms`, etc., and you need to know which phases dominate cost
- You see `SHOW jit_provider;` returning `llvmjit` (or empty) and need to know whether the build supports JIT

> [!WARNING] JIT was introduced in PG11 and defaulted ON in PG12 — not PG12 introduced
> A common misconception attributes "JIT introduction" to PG12. **PG11** added JIT (default `off`); **PG12** flipped the default to `on`. Verbatim PG11 release-note quote: *"Add Just-in-Time (JIT) compilation of some parts of query plans to improve execution speed (Andres Freund). This feature requires LLVM to be available. It is not currently enabled by default, even in builds that support it."*[^pg11-jit] Verbatim PG12 release-note quote: *"Enable Just-in-Time (JIT) compilation by default, if the server has been built with support for it (Andres Freund)."*[^pg12-default]

> [!WARNING] PostgreSQL 19
> PostgreSQL 19 changes `jit` to be disabled by default; the documented default is `off`. The release notes state that this change requires sites that run many large analytical queries to enable JIT manually (for example `ALTER SYSTEM SET jit = on;` or per role). The "on by default since PG12" statements in this file hold for PG12–18.[^pg19-jit-default]

> [!WARNING] LLVM version floor rises with each major
> LLVM JIT support must be built with a compatible LLVM version. PG17 requires LLVM 10+[^pg17-llvm10]; PG18 requires LLVM 14+[^pg18-llvm14]. Verify the new PostgreSQL package and its provider dependencies before upgrading. `jit_provider` is a configuration value, not an availability test.


## Syntax / Mechanics


### The Five-Rule Mental Model

PostgreSQL's JIT engine rests on five rules. Each rule names a misconception that surfaces in production tuning conversations.

1. **LLVM JIT is opt-in at build time; `jit` defaults on in PG12–18 and off in PG19.** `pg_jit_available()` returns true only when JIT is enabled and a provider is available in the current backend. A false result does not by itself identify why JIT is unavailable.[^pg-jit-available]

2. **JIT cost decisions are made when the plan is built.** A cached generic plan retains those decisions until replanning; a custom plan is generated for a particular execution. The `jit` switch itself also has an execution-time effect.[^jit-decision]

3. **JIT compiles expression evaluation and tuple deforming — not the plan itself.** It does not rewrite the plan tree; it generates LLVM IR for the inner loop of each scan / filter / aggregate. Verbatim: *"Currently PostgreSQL's JIT implementation has support for accelerating expression evaluation and tuple deforming. Several other operations could be accelerated in the future."*[^jit-reason] The win is mostly on long analytical queries that touch many tuples and evaluate many expressions per tuple. A short OLTP query that processes 10 rows sees the compilation overhead but no real benefit.

4. **JIT cost overhead is amortized per-query, not per-row.** A query that processes 10 million rows and spends 50ms on JIT generation + 100ms on inlining + 100ms on optimization may save 5 seconds on execution. A query that processes 100 rows pays the same 250ms compilation cost and saves milliseconds. The cost-threshold defaults (`jit_above_cost = 100000`) are deliberately conservative to avoid the latter case, but high-frequency OLTP workloads where the planner cost happens to exceed 100000 (for example a complex WHERE clause on a large but well-indexed table) can suffer measurably from JIT overhead with no compensating speedup.

5. **`pg_stat_statements` is the operational truth source for JIT impact.** Since PG15, the view exposes eight JIT counters per normalized statement (`jit_functions`, `jit_generation_time`, `jit_inlining_count`, `jit_inlining_time`, `jit_optimization_count`, `jit_optimization_time`, `jit_emission_count`, `jit_emission_time`).[^pg15-jit-pss] Since PG17, two additional columns (`jit_deform_count`, `jit_deform_time`) split out the tuple-deforming portion that was previously bundled into `jit_generation_time`.[^pg17-deform-pss] To find queries paying JIT cost without measurable benefit: order by `jit_generation_time + jit_inlining_time + jit_optimization_time + jit_emission_time` descending, divide by `calls`, and compare to `mean_exec_time`.


### Decision Matrix

| You want to... | Set / Check | Default | Production value | Avoid |
|---|---|---|---|---|
| Disable JIT cluster-wide | `jit = off` | on | Set if **every** query is OLTP-style and JIT cost > savings | Reflexively disabling without measurement |
| Disable JIT for one query | `SET LOCAL jit = off;` inside `BEGIN`/`COMMIT` | — | Inside a transaction; restore at COMMIT | Permanent `ALTER SYSTEM SET jit = off` |
| Disable JIT for one role | `ALTER ROLE webapp SET jit = off;` | — | Per-role baseline for OLTP-only roles | Cluster-wide disable when only one workload class needs it |
| Raise the JIT entry threshold | `jit_above_cost` | 100000 | 500000+ for OLTP-heavy clusters with occasional analytics | Setting to 0 (forces JIT for every query) |
| Disable JIT entirely without `jit = off` | Set all three cost GUCs to `-1` | — | Useful when `jit = on` is required by other tooling | Setting cost GUCs to very high numbers (less clear than `-1`) |
| Keep JIT generation, disable inlining | `jit_inline_above_cost = -1` | 500000 | Reduces JIT overhead on medium-cost queries | Disabling inlining cluster-wide when long queries benefit |
| Keep JIT, disable expensive optimization | `jit_optimize_above_cost = -1` | 500000 | Cuts optimization time on borderline queries | Disabling for analytical workloads where it pays back |
| Force JIT for testing | `SET jit_above_cost = 0;` plus `SET jit = on;` | — | Diagnostic only, never in production | Setting `jit_above_cost = 0` in postgresql.conf |
| Inspect JIT phase cost for one query | `EXPLAIN (ANALYZE, VERBOSE, BUFFERS) SELECT ...` | — | The `JIT:` section reports Functions count and per-phase timing | Running on a non-warm cache (timing is misleading) |
| Identify JIT-paying queries cluster-wide | Query `pg_stat_statements.jit_*` columns | — | PG15+; PG17+ adds `jit_deform_*` | Filtering by `mean_exec_time` alone misses high-frequency low-mean queries |
| Check whether JIT is available in this build | `SELECT pg_jit_available();` | — | Must return `t` before tuning JIT | Assuming JIT is available because `jit = on` |
| Inspect configured JIT provider | `SHOW jit_provider;` | `llvmjit` | This is a configured library name, not a loaded-provider test | Inferring availability from the name |

Three smell signals that JIT is hurting more than helping:

1. **High `jit_*_time` totals on queries with `calls > 10000` and `mean_exec_time < 10 ms`** — JIT compilation overhead exceeds savings on each call. Raise `jit_above_cost` or disable JIT for the calling role.
2. **JIT generation accounts for a large fraction of execution time.** Compare representative executions with JIT enabled and disabled before changing thresholds.
3. **Frequently executed queries accumulate high JIT time.** Inspect the `pg_stat_statements` counters and compare with a controlled no-JIT run.


### What JIT Compiles

JIT compiles two specific operations into native code via LLVM. It does **not** rewrite plans, choose different join orders, or speed up disk I/O. The verbatim docs catalog:

| Operation | What it accelerates | Controlled by |
|---|---|---|
| **Expression evaluation** | *"used to evaluate `WHERE` clauses, target lists, aggregates and projections. It can be accelerated by generating code specific to each case."*[^jit-reason] | `jit_expressions` (default `on`) |
| **Tuple deforming** | *"the process of transforming an on-disk tuple ... into its in-memory representation. It can be accelerated by creating a function specific to the table layout and the number of columns to be extracted."*[^jit-reason] | `jit_tuple_deforming` (default `on`) |
| **Inlining** | *"can inline the bodies of small functions into the expressions using them. That allows a significant percentage of the overhead to be optimized away."*[^jit-reason] | `jit_inline_above_cost` (default 500000) |
| **Optimization** | *"LLVM has support for optimizing generated code. Some of the optimizations are cheap enough to be performed whenever JIT is used, while others are only beneficial for longer-running queries."*[^jit-reason] | `jit_optimize_above_cost` (default 500000) |

Operations JIT does **not** accelerate:

- The plan itself (join order, scan choice, aggregation strategy) — that's the planner's job
- Disk I/O (which dominates many real queries — see `32-buffer-manager.md`)
- Network round-trips
- Index scans' B-tree traversal (the descent code is already optimized C)
- Sort algorithms (already specialized C)
- Hash-join build and probe (already specialized C)
- TOAST de-TOASTing (see `31-toast.md`)
- Function calls into PL/pgSQL, PL/Python, etc. (the SPI layer is not JIT-compiled)


### The JIT Decision Flow

The JIT decision is **per-query, at plan time**, and is independent for each phase. The flow:

```
Planner computes total_cost
    │
    ├── total_cost < jit_above_cost (100000)?
    │     └── No JIT for this query
    │
    ├── total_cost >= jit_above_cost?
    │     └── JIT compilation enabled
    │         │
    │         ├── total_cost >= jit_inline_above_cost (500000)?
    │         │     └── Yes: inline small functions and operators
    │         │
    │         └── total_cost >= jit_optimize_above_cost (500000)?
    │               └── Yes: apply expensive LLVM optimizations
```

The verbatim docs version: *"To determine whether JIT compilation should be used, the total estimated cost of a query ... is used. The estimated cost of the query will be compared with the setting of jit_above_cost. If the cost is higher, JIT compilation will be performed. Two further decisions are then needed. Firstly, if the estimated cost is more than the setting of jit_inline_above_cost, short functions and operators used in the query will be inlined. Secondly, if the estimated cost is more than the setting of jit_optimize_above_cost, expensive optimizations are applied to improve the generated code."*[^jit-decision]

> [!WARNING] Cached plans and JIT settings
> JIT cost thresholds are evaluated when a plan is built. SQL `PREPARE` parses and rewrites the statement; planning occurs at `EXECUTE`, and PostgreSQL may choose custom or cached generic plans. A cached generic plan retains its cost-based JIT decisions until replanned. Setting `jit = off` also disables JIT at execution time, independently of those decisions. See [PREPARE](https://www.postgresql.org/docs/16/sql-prepare.html) and [When to JIT](https://www.postgresql.org/docs/16/jit-decision.html).

To disable JIT for any individual phase, set its cost GUC to `-1`. Setting `jit_above_cost = -1` disables JIT entirely (without setting `jit = off`).[^cost-gucs]


### JIT Configuration GUCs

| GUC | Default | Description | Context |
|---|---|---|---|
| `jit` | `on` (PG12–18); `off` (PG19) | *"Determines whether JIT compilation may be used by PostgreSQL, if available."*[^jit-config] Setting `off` disables JIT regardless of cost. | user |
| `jit_provider` | `llvmjit` | *"This variable is the name of the JIT provider library to be used."*[^jit-provider] Only the built-in `llvmjit` is shipped. | postmaster |
| `jit_above_cost` | `100000` | Query-cost threshold for JIT compilation. `-1` disables.[^cost-gucs] | user |
| `jit_inline_above_cost` | `500000` | Query-cost threshold for inlining. `-1` disables inlining. Must be `>= jit_above_cost` to be meaningful.[^cost-gucs] | user |
| `jit_optimize_above_cost` | `500000` | Query-cost threshold for expensive optimization. `-1` disables. Should not exceed `jit_inline_above_cost`.[^cost-gucs] | user |
| `jit_expressions` | `on` | Whether expressions are JIT-compiled when JIT is active.[^jit-dev] | user |
| `jit_tuple_deforming` | `on` | Whether tuple deforming is JIT-compiled when JIT is active.[^jit-dev] | user |
| `jit_debugging_support` | `off` | Generate debugging info for the JIT-compiled functions (for `gdb` / `perf`). Postmaster-only.[^jit-dev] | postmaster |
| `jit_dump_bitcode` | `off` | Write LLVM bitcode for each JITted module to the data directory.[^jit-dev] | superuser |
| `jit_profiling_support` | `off` | Emit profile data for `perf`-like profilers. Postmaster-only.[^jit-dev] | postmaster |

The `jit_debugging_support`, `jit_dump_bitcode`, and `jit_profiling_support` GUCs are JIT-developer / kernel-profiler tools. The two operationally important developer GUCs are `jit_expressions` and `jit_tuple_deforming` — turning either off (while keeping `jit = on`) disables that one piece of JIT but leaves the rest. This is useful when one of the two is suspected of producing incorrect results or unusual overhead.

> [!NOTE] `jit_provider` is postmaster-restart only
> Changing `jit_provider` requires a full server restart — it cannot be SIGHUP-reloaded. In practice the only provider is `llvmjit`, so this is rarely changed.[^jit-provider]


### Reading EXPLAIN JIT Output

When `EXPLAIN (ANALYZE)` or `EXPLAIN (VERBOSE)` runs a query that JIT-compiles, the bottom of the plan includes a `JIT:` section. The format is **not formally documented in the user-facing docs** — its structure is inferred from output and release notes. A canonical example:

```
                              QUERY PLAN
-----------------------------------------------------------------------
 Aggregate  (cost=512345.00..512345.01 rows=1 width=8) (actual time=...)
   ...
 Planning Time: 0.245 ms
 JIT:
   Functions: 27
   Options: Inlining true, Optimization true, Expressions true, Deforming true
   Timing: Generation 4.731 ms (Deform 1.205 ms), Inlining 18.412 ms,
           Optimization 73.219 ms, Emission 41.998 ms, Total 138.360 ms
 Execution Time: 2153.422 ms
```

How to read each field:

- **Functions: N** — the number of distinct LLVM functions emitted for this query. Higher counts mean wider plans (more scans, more expressions to compile separately).
- **Options:** four booleans listing which JIT components were actually used:
    - `Inlining` true if `total_cost >= jit_inline_above_cost`
    - `Optimization` true if `total_cost >= jit_optimize_above_cost`
    - `Expressions` true unless `jit_expressions = off`
    - `Deforming` true unless `jit_tuple_deforming = off`
- **Timing:** five phases of JIT compilation, each in milliseconds:
    - **Generation** — building LLVM IR from the plan tree
    - **Deform** (PG17+ split out) — the tuple-deforming portion of Generation; verbatim PG17 release-note: *"Add JIT deform_counter details to EXPLAIN (Dmitry Dolgov)"*[^pg17-deform-explain]
    - **Inlining** — pulling small function bodies into the generated IR (if `Inlining true`)
    - **Optimization** — applying LLVM optimization passes (if `Optimization true`)
    - **Emission** — compiling IR to native code and loading it
    - **Total** — sum of the above

Compare JIT time with total execution time, which includes JIT work. A large fraction suggests testing with JIT disabled, but only a representative comparison can establish whether compilation pays for itself.

A second important read: if `Inlining` and `Optimization` together account for most of the JIT time and `Functions` is small (< 10), the inlining/optimization is over-eager — raising `jit_inline_above_cost` and `jit_optimize_above_cost` (or setting them to `-1`) cuts JIT time while keeping basic expression compilation. This is the canonical knob for *narrow* JIT control without disabling JIT outright.


### pg_stat_statements JIT Counters

Since PG15, `pg_stat_statements` reports per-statement JIT cost across the cluster, making it possible to find queries paying JIT cost over their lifetime — not just in a one-off `EXPLAIN ANALYZE`. See `57-pg-stat-statements.md` for setup; the JIT-specific columns:

| Column | Introduced | Description |
|---|---|---|
| `jit_functions` | PG15 | Number of LLVM functions JIT-compiled across all calls to this statement[^pg15-jit-pss] |
| `jit_generation_time` | PG15 | Total ms spent generating LLVM IR (Generation phase) |
| `jit_inlining_count` | PG15 | Number of times inlining was performed |
| `jit_inlining_time` | PG15 | Total ms spent inlining |
| `jit_optimization_count` | PG15 | Number of times optimization was performed |
| `jit_optimization_time` | PG15 | Total ms spent optimizing |
| `jit_emission_count` | PG15 | Number of times code was emitted |
| `jit_emission_time` | PG15 | Total ms spent emitting native code |
| `jit_deform_count` | PG17 | Number of times tuple-deforming was JIT-compiled[^pg17-deform-pss] |
| `jit_deform_time` | PG17 | Total ms spent compiling deforming functions[^pg17-deform-pss] |

> [!NOTE] PG17 added `jit_deform_*` to pg_stat_statements
> Verbatim PG17 release-note: *"Add JIT deform_counter details to pg_stat_statements (Dmitry Dolgov)."*[^pg17-deform-pss] On PG15-PG16, the deforming compilation time is bundled inside `jit_generation_time` and cannot be isolated. To diagnose deform overhead specifically, you need PG17+.

Cluster-wide audit query for highest JIT overhead:

```sql
SELECT
    pss.queryid,
    LEFT(query, 80) AS query_preview,
    calls,
    ROUND(mean_exec_time::numeric, 2) AS mean_exec_ms,
    ROUND((jit_generation_time + jit_inlining_time + jit_optimization_time
           + jit_emission_time)::numeric / calls, 2) AS mean_jit_ms,
    jit_functions / calls AS funcs_per_call
FROM pg_stat_statements pss
WHERE jit_functions > 0
ORDER BY (jit_generation_time + jit_inlining_time + jit_optimization_time
          + jit_emission_time) DESC
LIMIT 20;
```

This surfaces the queries the cluster has spent the most cumulative JIT time on. Queries where `mean_jit_ms` is a large fraction of `mean_exec_ms` are candidates for JIT-disable.


### Per-Version Timeline

| PG version | JIT changes (verbatim release-note quotes where available) |
|---|---|
| **PG11** | JIT introduced. Verbatim: *"Add Just-in-Time (JIT) compilation of some parts of query plans to improve execution speed (Andres Freund). This feature requires LLVM to be available. It is not currently enabled by default, even in builds that support it."*[^pg11-jit] |
| **PG12** | JIT default flipped on. Verbatim: *"Enable Just-in-Time (JIT) compilation by default, if the server has been built with support for it (Andres Freund)."*[^pg12-default] |
| **PG13** | **Zero** JIT-specific release-note items confirmed by direct fetch. |
| **PG14** | One JIT item: LLVM 12 support added. Verbatim: *"Add support for LLVM version 12 (Andres Freund)."*[^pg14-llvm12] No new JIT features. |
| **PG15** | One JIT item: pg_stat_statements JIT counters added (8 columns). Verbatim: *"Add JIT counters to pg_stat_statements (Magnus Hagander)."*[^pg15-jit-pss] |
| **PG16** | **Zero** JIT-specific release-note items confirmed by direct fetch. |
| **PG17** | Three JIT items: (1) `deform_counter` in `EXPLAIN` output; (2) `jit_deform_count` / `jit_deform_time` in `pg_stat_statements`; (3) LLVM 10+ required. Verbatim quotes: *"Add JIT deform_counter details to EXPLAIN"*[^pg17-deform-explain], *"Add JIT deform_counter details to pg_stat_statements"*[^pg17-deform-pss], *"Require LLVM version 10 or later"*[^pg17-llvm10]. |
| **PG18** | One JIT item: LLVM 14+ required. Verbatim: *"If LLVM is enabled, require version 14 or later (Thomas Munro)."*[^pg18-llvm14] **No new JIT features.** |
| **PG19** (RC) | **`jit` default changes from `on` to `off`.** Verbatim: *"Change [JIT] to be disabled by default... This change requires sites that are doing many large analytical queries to manually enable JIT."*[^pg19-jit-default] |

The JIT subsystem has been **structurally stable** since PG12. PG13 and PG16 had zero JIT release-note items. PG14 and PG18 only bumped the LLVM build requirement. The two substantive end-user JIT additions in the PG14-PG18 range are PG15's `pg_stat_statements` counters and PG17's deform-counter split (which appears in two places: `EXPLAIN` output and `pg_stat_statements`).

> [!NOTE] PG13 and PG16 had zero JIT changes
> Both versions are JIT-stable: nothing in their release notes touches JIT. If a tutorial or blog claims "PG13 improved JIT" or "PG16 disables JIT during recovery," verify directly against the release notes — neither claim is in the official notes.


## Examples / Recipes


### Recipe 1: Disable JIT for an OLTP role

The single most common JIT operational change. Set on a per-role basis so the cluster-wide default still applies to analytic roles.

```sql
ALTER ROLE webapp SET jit = off;
ALTER ROLE api    SET jit = off;
-- Verify:
SELECT rolname, rolconfig
FROM pg_roles
WHERE rolname IN ('webapp', 'api');
```

Cross-references `46-roles-privileges.md` (per-role baseline pattern) and `53-server-configuration.md` (GUC precedence — per-role overrides cluster-wide). Note that per-role GUCs **do not propagate across pgBouncer transaction-mode pools** (`81-pgbouncer.md` gotcha #6) — set on the cluster instead if your pooling strategy doesn't propagate session GUCs.


### Recipe 2: Disable JIT for one transaction without affecting the session

```sql
BEGIN;
SET LOCAL jit = off;
SELECT ...;  -- this query won't JIT
COMMIT;     -- the LOCAL setting is discarded
```

`SET LOCAL` is scoped to the current transaction. Outside a transaction it issues a warning and is a no-op (see `41-transactions.md` gotcha #3).


### Recipe 3: Disable just inlining and optimization, keep basic JIT

The most surgical JIT-cost reduction: keep expression compilation, drop the expensive phases.

```sql
ALTER ROLE webapp SET jit_inline_above_cost = -1;
ALTER ROLE webapp SET jit_optimize_above_cost = -1;
-- jit_above_cost is unchanged; basic JIT still happens for high-cost queries
```

Useful when basic expression-level JIT is measurably faster on some queries (long aggregations) but the inlining + optimization phases account for most of the JIT time without proportional benefit. Confirm with `EXPLAIN ANALYZE`: the `JIT:` section should show `Options: Inlining false, Optimization false` for affected queries.


### Recipe 4: Force JIT for one query (diagnostic only)

```sql
SET jit_above_cost = 0;
SET jit_inline_above_cost = 0;
SET jit_optimize_above_cost = 0;
EXPLAIN (ANALYZE, VERBOSE, BUFFERS)
SELECT count(*) FROM events WHERE ...;
-- Inspect the JIT: section to see the full pipeline timing
RESET jit_above_cost;
RESET jit_inline_above_cost;
RESET jit_optimize_above_cost;
```

This forces all three JIT phases for every query in the session. Useful for measuring whether a workload would benefit from JIT. **Never ship `jit_above_cost = 0` to production** — every trivial query pays the compilation cost.


### Recipe 5: Verify JIT is actually available in this build

```sql
SELECT pg_jit_available();          -- true when enabled and a provider is available
SHOW jit;
SHOW jit_provider;                  -- configured provider name, normally llvmjit
```

On managed services, `pg_jit_available()` may return false even though `jit = on` — the binary is shipped without LLVM. Verify before tuning.


### Recipe 6: Find JIT-paying queries cluster-wide

Requires `pg_stat_statements` (PG15+ for JIT columns).

```sql
SELECT
    LEFT(regexp_replace(query, '\s+', ' ', 'g'), 80) AS query_preview,
    calls,
    ROUND(mean_exec_time::numeric, 2) AS mean_exec_ms,
    jit_functions,
    ROUND((jit_generation_time + jit_inlining_time + jit_optimization_time
           + jit_emission_time)::numeric / NULLIF(calls, 0), 2) AS jit_ms_per_call,
    ROUND(100.0 * (jit_generation_time + jit_inlining_time + jit_optimization_time
           + jit_emission_time) / NULLIF(total_exec_time, 0), 1) AS jit_pct_of_exec
FROM pg_stat_statements
WHERE jit_functions > 0
ORDER BY (jit_generation_time + jit_inlining_time + jit_optimization_time
          + jit_emission_time) DESC
LIMIT 20;
```

`jit_pct_of_exec > 50` flags queries where JIT compilation dominates the execution time — strong candidates for JIT-disable.


### Recipe 7: PG17+ — find queries paying deform overhead specifically

```sql
SELECT
    LEFT(query, 80),
    calls,
    ROUND(jit_deform_time::numeric / NULLIF(calls, 0), 2) AS mean_deform_ms,
    ROUND(jit_generation_time::numeric / NULLIF(calls, 0), 2) AS mean_gen_ms,
    ROUND(100.0 * jit_deform_time / NULLIF(jit_generation_time, 0), 1) AS deform_pct
FROM pg_stat_statements
WHERE jit_functions > 0 AND jit_deform_count > 0
ORDER BY jit_deform_time DESC
LIMIT 20;
```

PG17 split tuple-deforming compilation out of `jit_generation_time` into `jit_deform_time`. If a query has high `deform_pct`, the cost is in compiling deform functions specifically — relevant when the table has many columns and the query reads only a few.


### Recipe 8: Diagnose "every query is slow" after a major version upgrade

After `pg_upgrade` to PG17 or PG18, if queries are slower than expected:

```sql
-- Check JIT is actually working
SELECT pg_jit_available();

-- If false, the new LLVM minimum may not be met
-- PG17 needs LLVM 10+; PG18 needs LLVM 14+
-- Check the server log for "could not load JIT provider"
```

If `pg_jit_available()` returns false, check `jit`, the installed PostgreSQL JIT provider package, compatible LLVM runtime dependencies, and server logs. A provider load error can require fixing the installation; installing an arbitrary LLVM development package is not sufficient.


### Recipe 9: Configure JIT cost thresholds for an analytic workload

For OLAP clusters where most queries are large analytic aggregates and JIT consistently pays back:

```conf
# postgresql.conf for an analytic-heavy cluster
jit = on
jit_above_cost = 100000           # default, leave alone
jit_inline_above_cost = 500000    # default, leave alone
jit_optimize_above_cost = 500000  # default, leave alone
```

These defaults work well when the cluster runs analytic queries with planner costs in the millions. Tune `jit_above_cost` upward only if `pg_stat_statements` shows JIT overhead exceeding savings on lower-cost queries.


### Recipe 10: Configure JIT for an OLTP cluster with occasional analytics

```sql
-- Cluster-wide: disable JIT outright
ALTER SYSTEM SET jit = off;
SELECT pg_reload_conf();

-- For the role that runs reports:
ALTER ROLE reporter SET jit = on;
ALTER ROLE reporter SET jit_above_cost = 100000;
```

Continues iteration-46 / iteration-54 / iteration-57 / iteration-59 per-role-baseline pattern. The default OLTP role sees zero JIT; the reporter role gets full JIT.


### Recipe 11: Audit which roles override JIT settings

```sql
SELECT
    r.rolname,
    s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
WHERE EXISTS (
    SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'jit%'
)
UNION ALL
SELECT
    rolname,
    rolconfig
FROM pg_roles
WHERE EXISTS (
    SELECT 1 FROM unnest(rolconfig) c WHERE c LIKE 'jit%'
)
ORDER BY 1;
```

Surfaces every role with any `jit*` setting in its `rolconfig` or per-database overrides. Useful to audit "why does this role get JIT and that one not" without scanning every role's settings manually.


### Recipe 12: Detect JIT compilation as a wait event

JIT compilation is CPU work, not a dedicated `pg_stat_activity` wait event. A NULL wait event does not identify which code is running:

```sql
SELECT pid, state, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE state = 'active' AND backend_type = 'client backend';
```

A backend stuck in JIT compilation is typically distinguished by long-running `state = 'active'` with no waiting and very high CPU. The diagnostic for "is this backend in JIT?" without source-level instrumentation is: `EXPLAIN ANALYZE` of the offending query shows a large `JIT:` section.


### Recipe 13: Capture JIT timing in server logs via auto_explain

For production diagnosis without running `EXPLAIN ANALYZE` manually, configure `auto_explain` to log slow queries with their JIT timing.

```conf
# postgresql.conf
shared_preload_libraries = 'auto_explain'  # requires restart
auto_explain.log_min_duration = '1s'        # log queries slower than 1 second
auto_explain.log_analyze = on               # include actual row counts and timing
auto_explain.log_verbose = on               # include JIT: section
auto_explain.log_format = 'json'            # structured log shipping
```

Each slow query now appears in the server log with its full `JIT:` section, including per-phase timing. Pair with log shipping (`51-pgaudit.md` Recipe 7) for cluster-wide JIT-cost analysis without intrusive instrumentation.


### Recipe 14: JIT and prepared-statement plan caching

Prepared statements can use custom plans planned per execution or a cached generic plan. To compare a new threshold with a freshly built plan in a diagnostic session:

```sql
-- In a diagnostic session, discard cached plans without deallocating statements:
DISCARD PLANS;
SET jit_above_cost = 50000;
PREPARE q(int) AS SELECT count(*) FROM big WHERE x > $1;
EXPLAIN (ANALYZE, VERBOSE) EXECUTE q(100);
-- The JIT section now reflects the new threshold
```

For PL/pgSQL: `DISCARD PLANS;` flushes the per-session plan cache used by embedded SQL inside PL/pgSQL functions. See `08-plpgsql.md` and `13-cursors-and-prepares.md` for plan-cache details.


### Recipe 15: Check JIT provider after a major upgrade

PG18 builds with LLVM require LLVM 14+. Install the PostgreSQL distribution's matching JIT provider and runtime dependencies; package names and supported versions vary by distribution.

```sql
SHOW jit;
SHOW jit_provider;
SELECT pg_jit_available();
```

After a major or LLVM upgrade, check `jit`, provider availability, package compatibility, and server logs. Do not infer availability from `SHOW jit_provider`.


## Gotchas / Anti-patterns

1. **JIT introduced in PG11, not PG12.** PG11 added JIT (default `off`); PG12 flipped the default to `on`. A common operator-folklore claim is "JIT is a PG12 feature" — accurate only for the default-on behavior, not the feature introduction.

2. **`jit = on` does not mean JIT is happening.** Three things must be true: (a) the binary was built with `--with-llvm`; (b) `pg_jit_available()` returns `true`; (c) the query's planner cost crosses `jit_above_cost`. Check all three before assuming a slow query is using JIT.

3. **Setting `jit_above_cost = 0` forces JIT for every query.** This is a debugging tool, never a production setting. Even trivial single-row lookups will pay the compilation cost.

4. **JIT cost thresholds are evaluated at planning time.** Prepared statements may use freshly planned custom plans or cached generic plans; SQL `PREPARE` itself does not necessarily build the execution plan. `jit = off` also acts at execution time. Use `DISCARD PLANS` or reprepare the specific statement when a fresh plan is needed.

5. **`jit_inline_above_cost` and `jit_optimize_above_cost` are independent of `jit_above_cost`.** Setting `jit_above_cost = 100000` and `jit_inline_above_cost = 50000` is meaningful — the docs note *"It is not meaningful to set this to less than jit_above_cost"* — but the GUC system does not reject it. The inline threshold simply has no effect below `jit_above_cost` because JIT itself doesn't fire.

6. **`-1` disables; very high values do not cleanly disable.** To turn off a JIT phase, use `-1` (the documented sentinel). Setting `jit_above_cost = 999999999` *also* effectively disables JIT for any reasonable query but the intent is less clear and a single high-cost query could still cross it.

7. **PG14 and PG18 only bumped LLVM build requirements** — they have **zero** new JIT features. If a tutorial claims a PG14 or PG18 JIT improvement, the only such change is the LLVM minimum version (12 and 14, respectively).

8. **PG13 and PG16 had zero JIT release-note items.** No improvements, no regressions, no feature additions. If you read that "PG13 made JIT faster" or "PG16 added a JIT mode," it's not in the release notes.

9. **JIT does not parallelize.** A `Parallel Seq Scan` followed by `Gather` may JIT-compile in each parallel worker independently, multiplying the compilation cost by `Workers Launched`. See `60-parallel-query.md` for parallel workers. To avoid this, disable JIT for the role, or raise `max_parallel_workers_per_gather` thresholds higher than the JIT thresholds.

10. **`jit_dump_bitcode = on` writes bitcode to the data directory.** Each JIT-compiled module produces a `.bc` file in `$PGDATA/jit/`. On a high-volume cluster this fills the data directory rapidly. This GUC is a debugging tool — never leave it on in production.

11. **`jit_debugging_support = on` and `jit_profiling_support = on` are postmaster-only.** They cannot be SIGHUP-reloaded. Enabling them requires a full server restart.

12. **JIT compilation is in-process, not cached across backends.** Each backend that runs a query compiles its own copy of the JIT functions. JIT is *not* shared across processes via shared memory. Two backends running the same query both pay the full compilation cost (and the cost is visible in each backend's `EXPLAIN ANALYZE` independently).

13. **JIT compilation uses backend memory.** Account for concurrent JIT compilation when sizing the workload; do not assume compiled code for every previously executed query remains resident indefinitely.

14. **`pg_stat_statements.jit_*` columns are PG15+**. On PG14 and earlier, the only way to measure JIT cost is `EXPLAIN ANALYZE` per query.

15. **`jit_deform_count` and `jit_deform_time` are PG17+**. On PG15-PG16, deforming time is folded into `jit_generation_time` and cannot be isolated.

16. **EXPLAIN JIT output format is not formally documented.** The `JIT: Functions: N / Options: ... / Timing: ...` section format is described only in release notes (when a field was added) and in the source. The `Deform` sub-field of `Generation` is PG17+ only.

17. **`jit_expressions = off` and `jit_tuple_deforming = off` defeat the two main JIT use cases.** Setting both `off` makes `jit = on` effectively no-op (other than process startup cost). Use these GUCs only for debugging suspected JIT correctness issues.

18. **JIT and `SET ROLE` interaction is non-obvious.** `SET ROLE` does not re-apply per-role GUCs (see `46-roles-privileges.md` gotcha #6). If `ALTER ROLE webapp SET jit = off` is set and a session does `SET ROLE webapp`, the session still uses the original `jit` setting it had before the `SET ROLE`. To apply per-role JIT settings, the *initial login role* must be the one with the override.

19. **JIT and PgBouncer transaction-mode pooling silently bypass per-role JIT settings.** When PgBouncer reuses a server backend across transactions, per-role GUCs set via `ALTER ROLE` may not propagate. See `81-pgbouncer.md` for the transaction-mode-incompatibility list.

20. **JIT does not accelerate I/O.** A query that is bottlenecked on disk read time (high `Buffers: shared read=` in `EXPLAIN (BUFFERS)`) will not be faster with JIT. JIT helps CPU-bound queries. See `32-buffer-manager.md` for I/O diagnosis.

21. **A cached plan does not imply cached generated machine code.** JIT compilation can be paid again on execution of a prepared plan; measure repeated executions rather than assuming preparation amortizes compilation.

22. **The default `jit_above_cost = 100000` is conservative.** It is roughly the cost of scanning ~1 GB of table or running a moderately complex aggregate. Most short OLTP queries do not cross this threshold and therefore do not pay JIT cost. If your OLTP queries cross it (large WHERE expressions, many CASE branches, complex projections), the threshold likely needs raising for that workload.

23. **`SHOW jit_provider` reports a configured provider name.** It does not establish that JIT is enabled or available; check `pg_jit_available()` in the relevant session.


## See Also

- `56-explain.md` — reading `EXPLAIN (ANALYZE, VERBOSE)` output, including the `JIT:` section
- `57-pg-stat-statements.md` — full `pg_stat_statements` reference including the JIT columns
- `59-planner-tuning.md` — cost GUCs that affect the JIT decision (planner cost model)
- `60-parallel-query.md` — JIT cost multiplied per parallel worker
- `46-roles-privileges.md` — per-role GUC overrides via `ALTER ROLE SET`
- `53-server-configuration.md` — GUC precedence rules and contexts
- `41-transactions.md` — `SET LOCAL` semantics inside a transaction
- `13-cursors-and-prepares.md` — custom and generic prepared plans and replanning
- `54-memory-tuning.md` — JIT modules live in per-backend memory (not shared)
- `32-buffer-manager.md` — JIT does not accelerate I/O
- `31-toast.md` — TOAST de-TOASTing not accelerated by JIT (referenced in What JIT Compiles)
- `08-plpgsql.md` — plan-cache mechanics for PL/pgSQL embedded SQL (Recipe 14)
- `51-pgaudit.md` — log shipping for production JIT-cost analysis (Recipe 13)


## Sources

[^pg11-jit]: PostgreSQL 11.0 release notes — *"Add Just-in-Time (JIT) compilation of some parts of query plans to improve execution speed (Andres Freund). This feature requires LLVM to be available. It is not currently enabled by default, even in builds that support it."* https://www.postgresql.org/docs/release/11.0/

[^pg12-default]: PostgreSQL 12.0 release notes — *"Enable Just-in-Time (JIT) compilation by default, if the server has been built with support for it (Andres Freund). Note that this support is not built by default, but has to be selected explicitly while configuring the build."* https://www.postgresql.org/docs/release/12.0/

[^pg14-llvm12]: PostgreSQL 14.0 release notes — *"Add support for LLVM version 12 (Andres Freund)."* https://www.postgresql.org/docs/release/14.0/

[^pg15-jit-pss]: PostgreSQL 15.0 release notes — *"Add JIT counters to pg_stat_statements (Magnus Hagander)."* The columns added: `jit_functions`, `jit_generation_time`, `jit_inlining_count`, `jit_inlining_time`, `jit_optimization_count`, `jit_optimization_time`, `jit_emission_count`, `jit_emission_time`. https://www.postgresql.org/docs/release/15.0/

[^pg17-deform-explain]: PostgreSQL 17.0 release notes — *"Add JIT deform_counter details to EXPLAIN (Dmitry Dolgov)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-deform-pss]: PostgreSQL 17.0 release notes — *"Add JIT deform_counter details to pg_stat_statements (Dmitry Dolgov)."* Adds `jit_deform_count` and `jit_deform_time` columns. https://www.postgresql.org/docs/release/17.0/

[^pg17-llvm10]: PostgreSQL 17.0 release notes — *"Require LLVM version 10 or later (Thomas Munro)."* https://www.postgresql.org/docs/release/17.0/

[^pg18-llvm14]: PostgreSQL 18.0 release notes — *"If LLVM is enabled, require version 14 or later (Thomas Munro)."* https://www.postgresql.org/docs/release/18.0/

[^jit-reason]: PostgreSQL 16 documentation, "What is JIT compilation?" — *"Currently PostgreSQL's JIT implementation has support for accelerating expression evaluation and tuple deforming. ... Expression evaluation is used to evaluate `WHERE` clauses, target lists, aggregates and projections. It can be accelerated by generating code specific to each case. Tuple deforming is the process of transforming an on-disk tuple ... into its in-memory representation. ... To reduce that overhead, JIT compilation can inline the bodies of small functions into the expressions using them. ... LLVM has support for optimizing generated code."* https://www.postgresql.org/docs/16/jit-reason.html

[^jit-decision]: PostgreSQL 16 documentation, "When to JIT?" — *"To determine whether JIT compilation should be used, the total estimated cost of a query ... is used. The estimated cost of the query will be compared with the setting of jit_above_cost. If the cost is higher, JIT compilation will be performed. Two further decisions are then needed. Firstly, if the estimated cost is more than the setting of jit_inline_above_cost, short functions and operators used in the query will be inlined. Secondly, if the estimated cost is more than the setting of jit_optimize_above_cost, expensive optimizations are applied to improve the generated code. ... These cost-based decisions will be made at plan time, not execution time. This means that when prepared statements are in use, and a generic plan is used (see PREPARE), the values of the configuration parameters in effect at prepare time control the decisions, not the settings at execution time."* https://www.postgresql.org/docs/16/jit-decision.html

[^jit-config]: PostgreSQL 16 documentation, runtime-config-query.html — `jit`: *"Determines whether JIT compilation may be used by PostgreSQL, if available (see Chapter 32). The default is `on`."* https://www.postgresql.org/docs/16/runtime-config-query.html

[^jit-provider]: PostgreSQL 16 documentation, runtime-config-client.html — `jit_provider`: *"This variable is the name of the JIT provider library to be used (see Section 32.4.2). The default is `llvmjit`. This parameter can only be set at server start."* https://www.postgresql.org/docs/16/runtime-config-client.html

[^cost-gucs]: PostgreSQL 16 documentation, runtime-config-query.html — `jit_above_cost`: *"Sets the query cost above which JIT compilation is activated, if enabled ... Setting this to `-1` disables JIT compilation. The default is `100000`."* `jit_inline_above_cost`: *"Sets the query cost above which JIT compilation attempts to inline functions and operators ... It is not meaningful to set this to less than `jit_above_cost`. Setting this to `-1` disables inlining. The default is `500000`."* `jit_optimize_above_cost`: *"Sets the query cost above which JIT compilation applies expensive optimizations ... it is unlikely to be beneficial to set it to more than `jit_inline_above_cost`. Setting this to `-1` disables expensive optimizations. The default is `500000`."* https://www.postgresql.org/docs/16/runtime-config-query.html

[^jit-dev]: PostgreSQL 16 documentation, runtime-config-developer.html — `jit_debugging_support` (default off), `jit_dump_bitcode` (default off), `jit_expressions` (default on, *"Determines whether expressions are JIT compiled, when JIT compilation is activated."*), `jit_profiling_support` (default off), `jit_tuple_deforming` (default on, *"Determines whether tuple deforming is JIT compiled, when JIT compilation is activated."*). https://www.postgresql.org/docs/16/runtime-config-developer.html

[^pg-jit-available]: PostgreSQL 16 documentation, `pg_jit_available()` function — returns `boolean` indicating whether JIT compilation support is available in the current backend. Reference: jit.html chapter and functions-info.html. https://www.postgresql.org/docs/16/jit.html

[^pg19-jit-default]: PostgreSQL 19 release notes (RC2), Migration: *"Change [JIT] to be disabled by default... This change requires sites that are doing many large analytical queries to manually enable JIT."* https://www.postgresql.org/docs/19/release-19.html#RELEASE-19-MIGRATION ; docs: *"jit (boolean)... The default is off."* https://www.postgresql.org/docs/19/runtime-config-query.html

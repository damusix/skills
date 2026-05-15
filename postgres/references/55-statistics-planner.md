# Planner Statistics & ANALYZE

PostgreSQL's cost-based planner depends on statistics about table contents to pick a good plan. This file covers how those statistics are collected, stored, used, and tuned — including extended (multi-column) statistics introduced in PG10 and PG18's headline pg_upgrade improvement.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [What ANALYZE collects](#what-analyze-collects)
    - [pg_statistic and pg_stats](#pg_statistic-and-pg_stats)
    - [How the planner uses statistics](#how-the-planner-uses-statistics)
    - [ANALYZE command](#analyze-command)
    - [default_statistics_target and per-column overrides](#default_statistics_target-and-per-column-overrides)
    - [Extended statistics: CREATE STATISTICS](#extended-statistics-create-statistics)
    - [ALTER / DROP STATISTICS](#alter--drop-statistics)
    - [Autovacuum and ANALYZE](#autovacuum-and-analyze)
    - [pg_upgrade interaction (PG18+)](#pg_upgrade-interaction-pg18)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when the user asks about: planner statistics, `pg_statistic`, `pg_stats`, `pg_stats_ext`, `pg_stats_ext_exprs`, `ANALYZE`, `default_statistics_target`, per-column statistics target, extended statistics, `CREATE STATISTICS`, ndistinct / dependencies / MCV statistics, multivariate statistics, autovacuum ANALYZE, or "why is the planner picking a bad plan?"

> [!WARNING] PG18 preserves planner stats through pg_upgrade — NOT PG17
> A widely-quoted "PG17 keeps stats across pg_upgrade" claim is **wrong**. PG17 pg_upgrade docs still say *"Because optimizer statistics are not transferred by `pg_upgrade`, you will be instructed to run a command to regenerate that information at the end of the upgrade."*[^pg16-pgupgrade] [^pg17-pgupgrade] The preservation feature landed in **PG18** with the verbatim release-note: *"Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation."*[^pg18-pgupgrade-stats] On PG≤17 you still need `vacuumdb --analyze-in-stages` after every major-version upgrade; on PG18+ you do not — except for extended statistics, which must be re-collected manually even on PG18.

## Mental Model

Five rules that govern everything else:

1. **Planner statistics live in `pg_statistic` (per-column) and `pg_statistic_ext_data` (extended).** Read them through the `pg_stats`, `pg_stats_ext`, and `pg_stats_ext_exprs` views.[^pg-stats-view] [^pg-stats-ext-view] [^pg-stats-ext-exprs-view] The raw catalogs are deliberately access-restricted because `most_common_vals` can leak data values that the role couldn't otherwise SELECT.

2. **`ANALYZE` samples the table and writes statistics; the planner consults them.** *"Entries in `pg_statistic` are updated by the `ANALYZE` and `VACUUM ANALYZE` commands, and are always approximate even when freshly updated."*[^planner-stats] Autovacuum's analyze phase is the steady-state mechanism — manual `ANALYZE` is for one-off recalculation after big data changes.

3. **`default_statistics_target = 100` controls sample size.** *"Larger values increase the time needed to do `ANALYZE`, but might improve the quality of the planner's estimates."*[^runtime-config-query] Raise it per-column for skewed data, not cluster-wide. Range is 1 to 10000.

4. **Extended statistics (PG10+) handle correlations the per-column model misses.** Per-column statistics assume column-independence; when columns are correlated (`(state, country)`, `(day_of_week, is_weekend)`, etc.) the planner under-estimates filter selectivity unless you `CREATE STATISTICS`. Three kinds since PG12: `ndistinct`, `dependencies`, `mcv`.[^pg10-extstats] [^pg12-mcv]

5. **Sampled, not complete.** Even at `default_statistics_target = 10000` (max), ANALYZE samples up to 30 × target rows = 300,000 rows per relation. For a 100M-row table this is 0.3%. The planner's estimates are inherently approximate; perfection isn't an option.

## Decision Matrix

When the planner picks a bad plan, work down this list:

| Symptom | Diagnostic | Fix |
|---|---|---|
| EXPLAIN ANALYZE shows actual rows 10×+ off estimate on a single column | `\d+ table` shows column had recent ANALYZE? `SELECT last_analyze FROM pg_stat_user_tables` | Run `ANALYZE table_name`; if recent, raise per-column SET STATISTICS |
| Estimate off on a WHERE with several AND-ed conditions on the same table | Check `pg_stats_ext` for relevant extended statistics | `CREATE STATISTICS ... (dependencies, mcv) ON (col_a, col_b) FROM table` |
| Estimate off on a WHERE involving expression like `lower(email)` | Per-column stats don't apply to expressions | Either expression index OR `CREATE STATISTICS ... ON (lower(email)) FROM table` (PG14+) |
| Bad estimate on a JOIN's join-key cardinality | n_distinct for the join column wrong? | Set `n_distinct` manually with `ALTER TABLE ... ALTER COLUMN ... SET (n_distinct = -0.5)` |
| Estimate off for `WHERE col = $1` parameterized query | Generic plan chose poorly with average selectivity | Force `plan_cache_mode = force_custom_plan` or rewrite (cross-reference 13-cursors-and-prepares.md) |
| Estimate off on a large bulk-loaded table | Autovacuum hasn't analyzed yet | Run `ANALYZE` manually after bulk loads |
| Planner stats look identical to default_statistics_target=1 sample | `default_statistics_target` set per-column to a low value? | Check `pg_attribute.attstattarget`; reset or raise |
| All planner stats missing after pg_upgrade on PG≤17 | pg_upgrade doesn't transfer stats | `vacuumdb --all --analyze-in-stages` |
| Estimate off but stats look correct | Cross-table correlation? | No fix — planner has no cross-table statistics; rewrite query |
| Want to check planner is using extended stats | `EXPLAIN` doesn't reveal which extended-stats object was used | `pg_stats_ext` shows when last analyzed; toggle on/off via `ALTER STATISTICS ... SET STATISTICS 0` |

Three smell signals — drop into a diagnostic session if you see these:

- **`last_analyze IS NULL` AND `last_autoanalyze IS NULL` in `pg_stat_user_tables`** for a non-trivial table. The planner is operating blind for that table.
- **`pg_stats.n_distinct = 1.0`** for what you know is a high-cardinality column. ANALYZE sampling missed it because the sample size is too small relative to cardinality — raise `SET STATISTICS` per-column.
- **`reltuples = 0` or wildly off `pg_class.relpages × tuple_size`** in `pg_class`. Stats are not just missing — they're wrong. Run `VACUUM ANALYZE`.

## Syntax / Mechanics

### What ANALYZE collects

For each column, ANALYZE writes to `pg_statistic`:

| Statistic | What it is | How the planner uses it |
|---|---|---|
| `null_frac` | Fraction of rows that are NULL | `WHERE col IS NULL` selectivity |
| `avg_width` | Average byte width | Memory cost estimates (work_mem, joins, sorts) |
| `n_distinct` | Number of distinct non-null values (>0) or fraction of total (-1.0 to 0) | JOIN cardinality, GROUP BY estimates, IN-list selectivity |
| `most_common_vals` (MCV) | Array of most common values up to `statistics_target` entries | `WHERE col = 'x'` selectivity when x is in MCV |
| `most_common_freqs` | Frequencies parallel to most_common_vals | Selectivity numerator for MCV hits |
| `histogram_bounds` | Equal-frequency bucket boundaries for non-MCV values | Range selectivity (`<`, `>`, `BETWEEN`) for non-MCV values |
| `correlation` | Statistical correlation between physical row order and logical column order | Index-scan vs seq-scan cost (high correlation → index scan is cheaper) |
| `most_common_elems` / `freqs` | For array columns | `@>`, `<@`, `&&` selectivity |
| `elem_count_histogram` | For array columns | Array-length distribution |

> [!NOTE] PostgreSQL 17
> Range-type histogram columns were added to `pg_stats`: `range_length_histogram`, `range_empty_frac`, `range_bounds_histogram`. These let the planner estimate selectivity for range-overlap operators on range-type columns.[^pg17-pg-stats-range]

ANALYZE samples up to `30 × statistics_target` rows per relation (so 3,000 rows at the default target of 100, or 300,000 at the max of 10,000) — the sample is large enough to keep statistics-collection time bounded but small enough that estimates remain inherently approximate, especially `n_distinct` on high-cardinality columns.

### pg_statistic and pg_stats

`pg_statistic` is the raw catalog; `pg_stats` is the user-facing view that filters out columns the calling role can't see (so MCV values from a table the role can't SELECT are not leaked).

```sql
-- pg_stats view definition (paraphrased)
SELECT
  schemaname, tablename, attname,
  null_frac, avg_width, n_distinct,
  most_common_vals, most_common_freqs,
  histogram_bounds, correlation,
  ...
FROM pg_statistic s
JOIN pg_class c ON s.starelid = c.oid
...
WHERE has_column_privilege(c.oid, a.attnum, 'select');
```

*"The view `pg_stats` provides access to the information stored in the `pg_statistic` catalog."*[^pg-stats-view]

Per-column query examples are in the Recipes section.

### How the planner uses statistics

For a predicate `WHERE col OP value` the planner asks: what fraction of rows will pass this filter? The fraction (selectivity) × `pg_class.reltuples` = the row estimate that propagates up the plan tree.

The planner consults statistics in this priority order:

1. **MCV hit.** If `value` is in `most_common_vals`, selectivity is the corresponding frequency. This is the most accurate path.

2. **Histogram lookup.** For range predicates and non-MCV equality, the planner uses `histogram_bounds` (an equal-frequency bucket layout) to estimate the fraction of rows in the matching range.

3. **n_distinct fallback.** For equality on non-MCV values: selectivity ≈ `(1 - sum(most_common_freqs)) / (n_distinct - n_mcv)`. Distinct-value uniform-distribution assumption inside the non-MCV bucket.

4. **Hardcoded defaults.** If statistics are missing entirely, the planner uses fixed defaults (`DEFAULT_EQ_SEL = 0.005`, `DEFAULT_RANGE_INEQ_SEL = 0.3333`). These are the same defaults you'd get with no ANALYZE ever — almost always wrong by orders of magnitude.

For multi-column predicates like `WHERE a = 'x' AND b = 'y'`, the per-column model **assumes statistical independence**: combined selectivity = `sel(a='x') × sel(b='y')`. This is the rule that breaks for correlated columns and is the entire reason extended statistics exist.

### ANALYZE command

```
ANALYZE [ ( option [, ...] ) ] [ table_and_columns [, ...] ]

where option is:
    VERBOSE [ boolean ]
    SKIP_LOCKED [ boolean ]
    BUFFER_USAGE_LIMIT size  -- PG16+
```

*"ANALYZE collects statistics about the contents of tables in the database, and stores the results in the pg_statistic system catalog."*[^sql-analyze]

Operational rules:

- **`ANALYZE` with no table argument analyzes every table in the current database.** Common manual recipe but expensive on big clusters — use `vacuumdb --analyze --jobs=N` for parallelism instead.
- **`ANALYZE table_name (col1, col2)`** analyzes only the named columns. Useful after backfilling a single column.
- **`ANALYZE` is non-blocking.** Takes `ShareUpdateExclusiveLock`, same as autovacuum — doesn't block readers or writers, but conflicts with concurrent `VACUUM` (full) and DDL.
- **`SKIP_LOCKED` (PG12+)** skips relations where the lock can't be acquired immediately — useful in cron jobs.
- **`BUFFER_USAGE_LIMIT` (PG16+)** caps the buffer-cache footprint of the analyze scan. Default uses a small ring buffer like vacuum. Cross-reference 32-buffer-manager.md.
- **`ANALYZE` does NOT update `pg_class.reltuples` and `pg_class.relpages`** alone — `VACUUM` does that. ANALYZE estimates `reltuples` from its sample but VACUUM has the authoritative count. Always run a full `VACUUM ANALYZE` once on a freshly-loaded large table.

### default_statistics_target and per-column overrides

The GUC `default_statistics_target` (default 100, range 1-10000) sets the sample size and number of MCV/histogram entries:

```sql
-- Cluster-wide default
ALTER SYSTEM SET default_statistics_target = 100;
SELECT pg_reload_conf();

-- Per-database
ALTER DATABASE warehouse SET default_statistics_target = 500;

-- Per-role
ALTER ROLE analytics_user SET default_statistics_target = 500;

-- Per-column (most-targeted, recommended for skewed data)
ALTER TABLE events ALTER COLUMN event_type SET STATISTICS 1000;
```

*"on a column-by-column basis by setting the per-column statistics target with `ALTER TABLE ... ALTER COLUMN ... SET STATISTICS`."*[^sql-analyze]

The per-column override is the workhorse for skewed-distribution columns. Use it instead of raising the cluster default — raising the default makes ANALYZE much slower across every table for marginal benefit.

> [!NOTE] PostgreSQL 17
> `pg_attribute.attstattarget` and `pg_statistic_ext.stxstattarget` now use NULL to represent "use the default" — previously a sentinel value -1.[^pg17-attstattarget] Migrating monitoring queries that filtered for `attstattarget = -1` to find unaltered columns: the new shape is `attstattarget IS NULL`.

To restore the default on a specific column:

```sql
ALTER TABLE events ALTER COLUMN event_type SET STATISTICS DEFAULT;
-- or on PG≤16:
ALTER TABLE events ALTER COLUMN event_type SET STATISTICS -1;
```

### Extended statistics: CREATE STATISTICS

Per-column statistics assume columns are independent. Extended statistics (PG10+) capture correlations explicitly:

```
CREATE STATISTICS [ IF NOT EXISTS ] statistics_name
    [ ( statistics_kind [, ... ] ) ]
    ON { column_name | ( expression ) } , { column_name | ( expression ) } [, ...]
    FROM table_name
```

*"CREATE STATISTICS will create a new extended statistics object tracking data about the specified table, foreign table or materialized view."*[^sql-createstatistics]

Three statistics kinds (since PG12; PG10 introduced ndistinct + dependencies, PG12 added mcv):

| Kind | What it captures | When to use |
|---|---|---|
| `ndistinct` | `n_distinct` for the group of columns combined | GROUP BY on multiple columns where the columns are correlated (`(state, city)`) |
| `dependencies` | Functional dependency `(col_a → col_b)` strengths | Filters that constrain multiple correlated columns (`WHERE state = 'CA' AND country = 'US'`) |
| `mcv` | Multi-column most-common-values (PG12+) | When values like `(brand, model)` form skewed pairs that the independent-column model would miss |

If you omit the `(statistics_kind, ...)` list, all kinds are computed.

> [!NOTE] PostgreSQL 14
> *"Allow extended statistics on expressions (Tomas Vondra). This allows statistics on a group of expressions and columns, rather than only columns like previously. System view `pg_stats_ext_exprs` reports such statistics."*[^pg14-extstats-exprs] Before PG14 you could only `CREATE STATISTICS ... ON (col_a, col_b)`; PG14+ accepts `ON (lower(email), country)` — making extended statistics applicable to common query patterns that mix expressions and columns.

> [!NOTE] PostgreSQL 15
> *"Allow extended statistics to record statistics for a parent with all its children (Tomas Vondra, Justin Pryzby). Regular statistics already tracked parent and parent-plus-all-children statistics separately."*[^pg15-extstats-parent] Operational impact: extended statistics on a partitioned-table parent now reflect the union of children automatically, instead of being effectively empty.

Worked examples in the Recipes section.

### ALTER / DROP STATISTICS

```sql
-- Rename
ALTER STATISTICS events_state_city RENAME TO events_geography;

-- Change schema
ALTER STATISTICS events_geography SET SCHEMA analytics;

-- Change owner
ALTER STATISTICS events_geography OWNER TO analytics_owner;

-- Change statistics target (sample size for this object)
ALTER STATISTICS events_geography SET STATISTICS 1000;
ALTER STATISTICS events_geography SET STATISTICS DEFAULT;  -- back to default

-- Drop
DROP STATISTICS events_geography;
DROP STATISTICS IF EXISTS events_geography;
```

`ALTER STATISTICS ... SET STATISTICS 0` is the canonical way to disable an extended statistics object without dropping it — useful for benchmarking whether the object is helping a particular query.

### Autovacuum and ANALYZE

Autovacuum runs ANALYZE separately from VACUUM, triggered by:

```
analyze_threshold = autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × reltuples
```

With defaults (`autovacuum_analyze_threshold = 50`, `autovacuum_analyze_scale_factor = 0.1`):

| reltuples | Analyze triggers after |
|---|---|
| 1,000 | 150 changed rows |
| 100,000 | 10,050 changed rows |
| 10,000,000 | 1,000,050 changed rows |
| 100,000,000 | 10,000,050 changed rows |

The 10% default scale factor is **too lazy for tables with skewed data** — a 100M-row table waits for 10M changes before re-analyzing. For analytics tables where a small fraction of writes shifts the data distribution dramatically, set per-table scale factor lower:

```sql
ALTER TABLE events SET (autovacuum_analyze_scale_factor = 0.01);  -- 1% instead of 10%
```

Per-table overrides cross-reference 28-vacuum-autovacuum.md.

### pg_upgrade interaction (PG18+)

> [!NOTE] PostgreSQL 18
> pg_upgrade now preserves per-relation and per-column optimizer statistics by default. Verbatim release-note: *"Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation."*[^pg18-pgupgrade-stats] Pair of constraints to remember: (1) **extended statistics are explicitly excluded** — you must re-run `ANALYZE` on tables with `CREATE STATISTICS` objects after pg_upgrade; (2) the `--no-statistics` flag exists for the rare case where you want the old "no stats transferred" behavior, e.g., if statistics in the old cluster are known to be wrong and you want a fresh sample.

PG18 also adds four functions for explicit statistics manipulation:

```sql
-- PG18+
pg_restore_relation_stats(...)
pg_restore_attribute_stats(...)
pg_clear_relation_stats(relid)
pg_clear_attribute_stats(relid, attnum)
```

Verbatim release-note: *"Add functions to modify per-relation and per-column optimizer statistics (Corey Huinker). The functions are `pg_restore_relation_stats()`, `pg_restore_attribute_stats()`, `pg_clear_relation_stats()`, and `pg_clear_attribute_stats()`."*[^pg18-stats-functions]

Operational use cases:
- Reproduce a production plan in dev by exporting stats from prod and restoring in dev (no need to copy data).
- Clear stats before an experiment to force a fresh sample.
- Inject deliberately-wrong stats to test planner robustness.

On PG≤17 the post-upgrade rite remains:

```bash
vacuumdb --all --analyze-in-stages --jobs=8
```

The `--analyze-in-stages` flag runs ANALYZE in three passes with progressively higher targets, producing usable statistics quickly then refining.

### Per-version timeline

| Version | Changes |
|---|---|
| **PG10** | Extended statistics introduced via `CREATE STATISTICS` (ndistinct + dependencies)[^pg10-extstats] |
| **PG11** | Parenthesized statistics-kind syntax (`CREATE STATISTICS ... (ndistinct)`); unparenthesized deprecated[^sql-analyze] |
| **PG12** | MCV multi-column extended statistics added[^pg12-mcv] |
| **PG13** | No headline changes to the planner-statistics surface |
| **PG14** | Extended statistics on expressions; `pg_stats_ext_exprs` view added; extended statistics used for OR-clause estimation[^pg14-extstats-exprs] |
| **PG15** | Extended statistics record parent+children separately[^pg15-extstats-parent] |
| **PG16** | No direct planner-statistics changes; `pg_stat_io` view added (orthogonal); planner improvements in other areas |
| **PG17** | Range-type histogram columns added to `pg_stats`[^pg17-pg-stats-range]; `pg_attribute.attstattarget` and `pg_statistic_ext.stxstattarget` use NULL not -1 to represent default[^pg17-attstattarget] |
| **PG18** | pg_upgrade preserves per-column optimizer statistics (NOT extended)[^pg18-pgupgrade-stats]; four new functions for explicit stats manipulation[^pg18-stats-functions]; `--no-statistics` flag for pg_upgrade |

## Examples / Recipes

### Recipe 1: Find tables with stale or missing statistics

```sql
SELECT
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    last_analyze,
    last_autoanalyze,
    GREATEST(last_analyze, last_autoanalyze) AS most_recent_analyze,
    CASE
        WHEN GREATEST(last_analyze, last_autoanalyze) IS NULL
            THEN 'NEVER ANALYZED'
        WHEN GREATEST(last_analyze, last_autoanalyze) < now() - interval '7 days'
            THEN 'STALE'
        ELSE 'OK'
    END AS state
FROM pg_stat_user_tables
WHERE n_live_tup > 1000  -- ignore tiny tables
ORDER BY most_recent_analyze NULLS FIRST;
```

Use this as the first diagnostic step when the planner picks a bad plan. Any "NEVER ANALYZED" entry is a planner-blindness candidate.

### Recipe 2: Inspect column statistics for a specific column

```sql
SELECT
    schemaname, tablename, attname,
    null_frac,
    avg_width,
    n_distinct,
    array_length(most_common_vals, 1) AS n_mcv,
    most_common_vals[1:5] AS top_5_values,
    most_common_freqs[1:5] AS top_5_freqs,
    array_length(histogram_bounds, 1) AS histogram_buckets,
    correlation
FROM pg_stats
WHERE schemaname = 'public'
  AND tablename = 'events'
  AND attname = 'event_type';
```

Three things to look for: `n_distinct` matches your intuition; `most_common_vals` covers the values you actually query; `correlation` is close to 1.0 or -1.0 if the column should be index-friendly.

### Recipe 3: Raise per-column statistics target for a skewed column

```sql
-- Default target = 100, sampling 30,000 rows on this table
SHOW default_statistics_target;
SELECT attname, attstattarget
FROM pg_attribute
WHERE attrelid = 'events'::regclass AND attname = 'event_type';

-- Raise to 1000 (samples 300,000 rows for this column)
ALTER TABLE events ALTER COLUMN event_type SET STATISTICS 1000;

-- Re-collect with the new target
ANALYZE events;

-- Verify
SELECT attname, attstattarget
FROM pg_attribute
WHERE attrelid = 'events'::regclass AND attname = 'event_type';
```

The change takes effect on the next ANALYZE — existing statistics are unchanged. Don't forget to ANALYZE.

### Recipe 4: Multi-column extended statistics for correlated columns

```sql
-- Two columns that are heavily correlated: every San Francisco user has country='US'
CREATE STATISTICS events_state_country
    ON state, country
    FROM events;

ANALYZE events;

-- Verify it was created and analyzed
SELECT
    stxname,
    stxkeys,
    last_analyze AS last_analyzed
FROM pg_statistic_ext s
JOIN pg_stat_user_tables t ON s.stxrelid = t.relid
WHERE stxname = 'events_state_country';
```

Before this statistic, `WHERE state = 'CA' AND country = 'US'` was estimated as `sel(state) × sel(country)` — way too low because almost every state-equals-CA row also has country-equals-US. After, the planner uses the actual joint distribution.

### Recipe 5: Extended statistics on an expression (PG14+)

```sql
-- The query: WHERE lower(email) = $1
-- Per-column stats on `email` don't help — they're for the raw value, not the lowered one
CREATE STATISTICS users_email_lower
    ON (lower(email))
    FROM users;

ANALYZE users;

-- Inspect via pg_stats_ext_exprs
SELECT * FROM pg_stats_ext_exprs WHERE statistics_name = 'users_email_lower';
```

Alternative is a functional index `CREATE INDEX ON users (lower(email))` which provides BOTH lookup acceleration AND statistics for the expression. Use the index unless you don't want the storage cost.

### Recipe 6: Find tables that would benefit from extended statistics

```sql
-- Tables where filters routinely involve multiple columns AND there's significant cardinality
WITH multi_col_filters AS (
    SELECT
        s.tablename,
        count(*) FILTER (WHERE n_distinct < 100) AS low_card_cols,
        count(*) FILTER (WHERE n_distinct >= 100) AS high_card_cols
    FROM pg_stats s
    JOIN pg_class c ON c.relname = s.tablename
    WHERE c.relkind = 'r' AND s.schemaname NOT IN ('pg_catalog', 'information_schema')
    GROUP BY s.tablename
    HAVING count(*) > 5
)
SELECT tablename, low_card_cols, high_card_cols
FROM multi_col_filters
WHERE low_card_cols >= 2
ORDER BY low_card_cols DESC;
```

This is a heuristic — tables with several low-cardinality columns are most likely to suffer from the independent-column assumption. Combine with EXPLAIN diagnostics on actual slow queries to identify which column pairs to target.

### Recipe 7: Manually override n_distinct for a difficult column

```sql
-- Imagine: column user_id with ~10M distinct values, but ANALYZE sampled only 30,000 rows
-- and reports n_distinct = 28,000 (which is wrong - the actual distinct count is much higher)
SELECT attname, n_distinct FROM pg_stats WHERE tablename = 'events' AND attname = 'user_id';
-- n_distinct: 28000

-- Tell the planner: this column has 10M distinct values (positive integer = exact count)
ALTER TABLE events ALTER COLUMN user_id SET (n_distinct = 10000000);

-- Or as a fraction of total rows (-1.0 to 0)
-- -0.5 means: distinct values = 0.5 × reltuples (i.e., each value appears on average 2 rows)
ALTER TABLE events ALTER COLUMN user_id SET (n_distinct = -0.9);

-- Force ANALYZE to re-read the override
ANALYZE events;
```

This is an escape hatch for the case where ANALYZE's sample-based estimation is structurally wrong (e.g., uniformly distributed high-cardinality columns). The override sticks across ANALYZEs.

### Recipe 8: Find columns with suspicious n_distinct estimates

```sql
-- Columns where n_distinct = -1.0 means "every value is unique" (e.g., PK columns)
-- Check that holds for what you think are unique columns
SELECT
    schemaname, tablename, attname, n_distinct,
    CASE
        WHEN n_distinct = -1 THEN 'all unique (PK or unique col)'
        WHEN n_distinct < 0 THEN format('estimated %s%% distinct', round(abs(n_distinct)*100,1))
        WHEN n_distinct = 0 THEN 'unknown / not analyzed'
        ELSE format('exactly %s distinct values', n_distinct::int)
    END AS interpretation
FROM pg_stats
WHERE schemaname = 'public'
  AND n_distinct = -1  -- "all unique"
  AND tablename IN ('orders', 'users', 'events')  -- expected
ORDER BY tablename, attname;
```

If a column you expect to have repeats shows `n_distinct = -1`, ANALYZE saw no duplicates in its sample — meaning either the column really is unique or your sample is too small.

### Recipe 9: Schedule per-table ANALYZE for hot tables

```sql
-- For a high-write table where the 10% default scale factor is too lazy
ALTER TABLE events SET (
    autovacuum_analyze_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.005  -- 0.5% instead of default 10%
);

-- Verify
SELECT relname, reloptions
FROM pg_class
WHERE relname = 'events';
```

Cross-reference `28-vacuum-autovacuum.md` for the full per-table tuning surface.

### Recipe 10: After-bulk-load ANALYZE recipe

```sql
-- After a large COPY or INSERT...SELECT into a previously-empty (or much smaller) table:
\timing on
VACUUM ANALYZE events;  -- VACUUM updates reltuples + visibility map; ANALYZE writes stats
\timing off

-- Verify reltuples is now accurate
SELECT relname, reltuples, n_live_tup
FROM pg_stat_user_tables JOIN pg_class USING (relname)
WHERE relname = 'events';
```

After a bulk load, the autovacuum-triggered ANALYZE won't fire until enough updates accumulate. Run `VACUUM ANALYZE` manually so the planner has accurate stats for the queries that immediately follow.

### Recipe 11: Post-pg_upgrade ANALYZE (PG≤17)

```bash
# After pg_upgrade on PG14 → PG15, PG15 → PG16, PG16 → PG17
vacuumdb --all --analyze-in-stages --jobs=$(nproc)

# Three-stage: low statistics target first (fast), then progressively higher
# Without --analyze-in-stages, the planner has zero stats until full ANALYZE completes
```

On PG≤17 this is mandatory post-upgrade. On PG18+ it's optional — only needed for tables with extended statistics, which pg_upgrade does NOT preserve.

### Recipe 12: PG18+ stats export-and-restore between clusters

```sql
-- On the source cluster (production), export the relation-level stats for a table
SELECT pg_get_relation_stats('events'::regclass);
-- Returns a serialized representation

-- On the destination cluster (dev), restore it
SELECT pg_restore_relation_stats(
    relation => 'events'::regclass,
    relpages => 1234567,
    reltuples => 9876543210
    -- ... other parameters
);

-- Or clear stats first if you want a fresh sample
SELECT pg_clear_relation_stats('events'::regclass);
ANALYZE events;
```

This is the PG18+ workflow for reproducing a production plan in dev without copying data. The actual call signatures of the `pg_restore_relation_stats()` and `pg_restore_attribute_stats()` functions are stable in PG18; verify against `\df pg_restore_relation_stats` on your cluster.

### Recipe 13: Audit extended statistics objects

```sql
SELECT
    n.nspname AS schema,
    c.relname AS table_name,
    s.stxname AS stats_object,
    s.stxkeys AS column_indexes,
    pg_catalog.pg_get_statisticsobjdef_columns(s.oid) AS columns,
    s.stxkind AS kinds,  -- 'd'=dependencies, 'f'=ndistinct, 'm'=mcv, 'e'=expressions
    sd.last_analyze
FROM pg_statistic_ext s
JOIN pg_class c ON c.oid = s.stxrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables sd ON sd.relid = c.oid
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, s.stxname;
```

Use this on inherited schemas to inventory existing extended-stats objects, identify which kinds are configured, and spot stale objects.

## Gotchas / Anti-patterns

1. **pg_upgrade does NOT preserve stats on PG≤17.** Verbatim PG17 docs: *"Because optimizer statistics are not transferred by `pg_upgrade`, you will be instructed to run a command to regenerate that information at the end of the upgrade."*[^pg17-pgupgrade] Run `vacuumdb --analyze-in-stages` after every major upgrade. On PG18+ pg_upgrade DOES preserve per-column stats but still NOT extended stats — re-run ANALYZE manually on tables with `CREATE STATISTICS` objects.

2. **`ANALYZE` is sample-based and inherently approximate.** Even at `default_statistics_target = 10000`, the sample is 300,000 rows per relation. For a billion-row table this is 0.03%. The `n_distinct` for high-cardinality columns will be wildly off; use the `ALTER TABLE ... ALTER COLUMN ... SET (n_distinct = ...)` override.

3. **Per-column statistics assume column independence.** `WHERE a = 'x' AND b = 'y'` selectivity is calculated as `sel(a) × sel(b)`, which is wrong when columns are correlated. Use extended statistics with `dependencies` and/or `mcv` kinds.

4. **`default_statistics_target` cluster-wide changes affect every ANALYZE.** Raising it from 100 → 1000 makes ANALYZE 10× slower (sample size grows linearly) on every table. Use per-column overrides instead.

5. **`SET STATISTICS 0` on a column disables statistics collection.** Useful for write-only audit columns where the planner never needs stats. But `0` means "no MCV or histogram" — only the basic null_frac, avg_width, n_distinct get collected.

6. **Extended statistics on expressions did not exist before PG14.** Before PG14, `CREATE STATISTICS ... ON (lower(email), country) FROM users` errored. The workaround was a functional index — which also provides stats but adds storage cost.

7. **`pg_stats` view filters MCV/histogram by SELECT privilege.** A role that can't SELECT a column will see NULL in `most_common_vals` and `histogram_bounds` for that column. This is a security feature, not a bug — the underlying `pg_statistic` catalog requires the role to have privileges on each column it wants to inspect statistics for.

8. **Statistics-target sampling for extended statistics is per-statistics-object, not per-column.** `ALTER STATISTICS ... SET STATISTICS N` overrides the sample size for THIS extended-statistics object. The per-column targets on the underlying columns are independent and govern only the per-column `pg_statistic` rows.

9. **`reltuples` and `relpages` get accurate values from VACUUM, not ANALYZE.** ANALYZE estimates `reltuples` from its sample (extrapolation) but VACUUM has the exact count after scanning every page. After a major data change, `VACUUM ANALYZE` (not just ANALYZE) gives the planner the most accurate inputs.

10. **Autovacuum's analyze trigger uses a 10% scale factor by default.** On a 100M-row table, this means autovacuum waits for 10M+ row changes before re-analyzing. For analytics tables or any table where the data distribution shifts faster than that, set a smaller per-table scale factor (e.g., `autovacuum_analyze_scale_factor = 0.01`).

11. **`STATISTICS` keyword vs `STATISTICS` GUC.** `ALTER TABLE ... ALTER COLUMN ... SET STATISTICS N` is per-column statistics TARGET (integer 0-10000 or -1/DEFAULT for "use default_statistics_target"). The `default_statistics_target` GUC is the global default. These look similar but are different objects.

12. **`stxstattarget` and `attstattarget` represent "use default" differently in PG≤16 vs PG17+.** In PG≤16, the sentinel was -1; in PG17+, it's NULL.[^pg17-attstattarget] Monitoring queries written for PG≤16 with `WHERE attstattarget = -1` will not find unaltered columns on PG17+.

13. **Functional indexes provide statistics on the expression too.** `CREATE INDEX ON users (lower(email))` is equivalent (for planner purposes) to extended statistics on `(lower(email))` PLUS an actual index. Almost always the index is what you want.

14. **The planner has NO cross-table statistics.** Even extended statistics are per-table. Cross-table correlations (e.g., orders.user_id heavily favoring users from a specific country) cannot be captured; the planner estimates JOIN cardinality based on per-table n_distinct and the column-independence assumption.

15. **MCV (most_common_vals) selectivity is much more accurate than histogram-bucket selectivity.** A column with `n_distinct = 50000` and `default_statistics_target = 100` captures only the top 100 MCV values; the other 49,900 distinct values fall into the histogram buckets. If your query routinely filters on one of those 49,900 values, the histogram-based estimate is poor — raise the per-column statistics target to capture more MCV entries.

16. **ANALYZE without `VERBOSE` is silent.** It returns no output. Use `ANALYZE VERBOSE table_name` to see the rows-scanned count and sample-size details — useful when debugging "why didn't ANALYZE help?"

17. **Extended statistics on partitioned tables only got accurate behavior in PG15.**[^pg15-extstats-parent] Before PG15, extended statistics on a partitioned-table parent recorded parent-only data (empty if the parent is the routing-only kind). On PG15+ it tracks parent-plus-all-children. Re-create old extended-stats objects after upgrading to PG15.

18. **`pg_stat_user_tables.last_analyze` is updated only by MANUAL ANALYZE; `last_autoanalyze` by autovacuum.** Read both columns when checking statistics freshness. Don't filter on `last_analyze IS NULL` alone — the table may have been analyzed only by autovacuum.

19. **`pg_statistic` is not replicated through logical replication.** It IS replicated by physical streaming replication (it's a regular catalog table). On logical-replication subscribers, you must run ANALYZE on the subscriber side after data starts flowing — the publisher's stats don't help.

20. **MCV extended stats has a stats-size limit.** The `mcv` extended statistics kind captures up to `default_statistics_target` MCV entries. For column groups with very high joint cardinality, MCV may not help; in that case, look at `ndistinct` and/or `dependencies` instead.

21. **`CREATE STATISTICS` does NOT auto-include statistics_kinds you didn't specify.** Writing `CREATE STATISTICS s ON (a, b) FROM t` builds all three default kinds. Writing `CREATE STATISTICS s (ndistinct) ON (a, b) FROM t` builds ONLY ndistinct — no dependencies, no mcv. Be explicit when you want a specific kind.

22. **`DROP STATISTICS` does NOT cascade to dependent views.** Extended statistics objects don't have dependents in the normal sense — they're inputs to the planner, not referenced by queries. Drop them anytime; the worst case is the planner reverts to per-column statistics.

23. **PG18 `pg_upgrade --no-statistics` reverts to the PG≤17 behavior of dropping stats.** Use it only when you specifically want the destination cluster to start with fresh ANALYZE. Otherwise prefer the new default (statistics preserved) — it eliminates the largest source of post-upgrade query-plan regression.

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum architecture, ANALYZE trigger thresholds, per-table tuning
- [`53-server-configuration.md`](./53-server-configuration.md) — `default_statistics_target` GUC mechanics, per-database/per-role overrides
- [`54-memory-tuning.md`](./54-memory-tuning.md) — work_mem sizing depends on planner row estimates
- [`56-explain.md`](./56-explain.md) — reading row-estimate vs actual-rows in EXPLAIN ANALYZE output
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — finding queries with bad estimates via mean_exec_time + rows
- [`59-planner-tuning.md`](./59-planner-tuning.md) — the cost GUCs (random_page_cost, etc.) that interact with statistics
- [`64-system-catalogs.md`](./64-system-catalogs.md) — pg_statistic / pg_statistic_ext / pg_statistic_ext_data schema
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — post-COPY ANALYZE pattern
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — generic vs custom plan decisions; statistics quality drives which plan wins
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — routing slow-query investigations; stale statistics are a primary cause
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — the PG18 stats-preservation upgrade workflow

## Sources

[^planner-stats]: PostgreSQL 16 documentation, "Statistics Used by the Planner". https://www.postgresql.org/docs/16/planner-stats.html — *"Entries in `pg_statistic` are updated by the `ANALYZE` and `VACUUM ANALYZE` commands, and are always approximate even when freshly updated."*

[^pg-stats-view]: PostgreSQL 16 documentation, "pg_stats" system view. https://www.postgresql.org/docs/16/view-pg-stats.html — *"The view `pg_stats` provides access to the information stored in the `pg_statistic` catalog."*

[^pg-stats-ext-view]: PostgreSQL 16 documentation, "pg_stats_ext" system view. https://www.postgresql.org/docs/16/view-pg-stats-ext.html — *"The view `pg_stats_ext` provides access to information about each extended statistics object in the database, combining information stored in the `pg_statistic_ext` and `pg_statistic_ext_data` catalogs."*

[^pg-stats-ext-exprs-view]: PostgreSQL 16 documentation, "pg_stats_ext_exprs" system view. https://www.postgresql.org/docs/16/view-pg-stats-ext-exprs.html — *"The view `pg_stats_ext_exprs` provides access to information about all expressions included in extended statistics objects."*

[^sql-analyze]: PostgreSQL 16 documentation, ANALYZE command reference. https://www.postgresql.org/docs/16/sql-analyze.html — *"ANALYZE collects statistics about the contents of tables in the database, and stores the results in the pg_statistic system catalog."*; *"on a column-by-column basis by setting the per-column statistics target with `ALTER TABLE ... ALTER COLUMN ... SET STATISTICS`."*

[^sql-createstatistics]: PostgreSQL 16 documentation, CREATE STATISTICS command reference. https://www.postgresql.org/docs/16/sql-createstatistics.html — *"CREATE STATISTICS will create a new extended statistics object tracking data about the specified table, foreign table or materialized view."*

[^runtime-config-query]: PostgreSQL 16 documentation, query-planning GUCs. https://www.postgresql.org/docs/16/runtime-config-query.html — *"Sets the default statistics target for table columns without a column-specific target set via `ALTER TABLE SET STATISTICS`. Larger values increase the time needed to do `ANALYZE`, but might improve the quality of the planner's estimates. The default is 100."*

[^pg10-extstats]: PostgreSQL 10 release notes, Section E.24.3.1.4 Optimizer. https://www.postgresql.org/docs/release/10/ — *"Add multi-column optimizer statistics to compute the correlation ratio and number of distinct values (Tomas Vondra, David Rowley, Álvaro Herrera). New commands are `CREATE STATISTICS`, `ALTER STATISTICS`, and `DROP STATISTICS`. This feature is helpful in estimating query memory usage and when combining the statistics from individual columns."*

[^pg12-mcv]: PostgreSQL 12 release notes, Section E.23.3.1.3 Optimizer. https://www.postgresql.org/docs/release/12.0/ — *"Multi-column most-common-value (MCV) statistics can be defined via `CREATE STATISTICS`, to support better plans for queries that test several non-uniformly-distributed columns (Tomas Vondra)"*

[^pg14-extstats-exprs]: PostgreSQL 14 release notes, Section E.23.3.1.4 Optimizer. https://www.postgresql.org/docs/release/14.0/ — *"Allow extended statistics on expressions (Tomas Vondra). This allows statistics on a group of expressions and columns, rather than only columns like previously. System view `pg_stats_ext_exprs` reports such statistics."*

[^pg15-extstats-parent]: PostgreSQL 15 release notes, Section E.18.3.1.3 Optimizer. https://www.postgresql.org/docs/release/15.0/ — *"Allow extended statistics to record statistics for a parent with all its children (Tomas Vondra, Justin Pryzby). Regular statistics already tracked parent and parent-plus-all-children statistics separately."*

[^pg17-pg-stats-range]: PostgreSQL 17 release notes, planner-stats changes. https://www.postgresql.org/docs/release/17.0/ — range-type histogram columns added to `pg_stats`: `range_length_histogram`, `range_empty_frac`, `range_bounds_histogram`.

[^pg17-attstattarget]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — `pg_attribute.attstattarget` and `pg_statistic_ext.stxstattarget` use NULL to represent the default value; previously a sentinel of -1.

[^pg18-pgupgrade-stats]: PostgreSQL 18 release notes, Section E.4.3.7.2 pg_upgrade. https://www.postgresql.org/docs/release/18.0/ — *"Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation."*

[^pg18-stats-functions]: PostgreSQL 18 release notes, Section E.4.3.2 Utility Commands. https://www.postgresql.org/docs/release/18.0/ — *"Add functions to modify per-relation and per-column optimizer statistics (Corey Huinker). The functions are `pg_restore_relation_stats()`, `pg_restore_attribute_stats()`, `pg_clear_relation_stats()`, and `pg_clear_attribute_stats()`."*

[^pg16-pgupgrade]: PostgreSQL 16 documentation, pg_upgrade reference. https://www.postgresql.org/docs/16/pgupgrade.html — *"Because optimizer statistics are not transferred by `pg_upgrade`, you will be instructed to run a command to regenerate that information at the end of the upgrade."*

[^pg17-pgupgrade]: PostgreSQL 17 documentation, pg_upgrade reference. https://www.postgresql.org/docs/17/pgupgrade.html — *"Because optimizer statistics are not transferred by `pg_upgrade`, you will be instructed to run a command to regenerate that information at the end of the upgrade."* — (this language is unchanged from PG16; preservation lands in PG18, not PG17)

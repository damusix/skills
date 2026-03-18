# 28 — Statistics

<!-- TOC -->
- [When to Use This Reference](#when-to-use-this-reference)
- [Statistics Overview](#statistics-overview)
- [How Statistics Are Created](#how-statistics-are-created)
- [Histogram Structure](#histogram-structure)
- [DBCC SHOW_STATISTICS Output Interpretation](#dbcc-show_statistics-output-interpretation)
- [Auto-Update Thresholds](#auto-update-thresholds)
- [Dynamic Statistics Threshold (2016+)](#dynamic-statistics-threshold-2016)
- [Ascending Key Problem](#ascending-key-problem)
- [UPDATE STATISTICS Options](#update-statistics-options)
- [Filtered Statistics](#filtered-statistics)
- [Multi-Column Statistics](#multi-column-statistics)
- [STATISTICS_INCREMENTAL](#statistics_incremental)
- [Cardinality Estimator (CE) Versions](#cardinality-estimator-ce-versions)
- [Statistics and Index Maintenance](#statistics-and-index-maintenance)
- [Common Patterns](#common-patterns)
- [Metadata Queries](#metadata-queries)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)
<!-- /TOC -->

---

## When to Use This Reference

Load this file when the user asks about:
- Stale statistics causing bad query plans or incorrect row estimates
- Auto-update statistics behavior and thresholds
- DBCC SHOW_STATISTICS interpretation
- Histograms, RANGE_HI_KEY, EQ_ROWS, AVG_RANGE_ROWS
- Ascending key / new data distribution problem
- UPDATE STATISTICS options (FULLSCAN, SAMPLE, ROWCOUNT, PAGECOUNT)
- Filtered statistics for partial table statistics
- Multi-column statistics and density vectors
- STATISTICS_INCREMENTAL for partitioned tables
- Cardinality estimation errors and plan regression

---

## Statistics Overview

Statistics are metadata objects that describe the **data distribution** of one or more columns. The query optimizer uses statistics to estimate the number of rows that will satisfy a predicate (cardinality estimation), which drives plan choices: whether to seek vs. scan, which join algorithm to use, how large a memory grant to allocate.

Each statistics object contains:
1. **Header** — when updated, row count, sampled rows, steps
2. **Density vector** — all-density for each column prefix (for multi-column stats)
3. **Histogram** — up to 200 steps describing value distribution for the leading column

Statistics are created:
- Automatically on index creation (always)
- Automatically on query columns when `AUTO_CREATE_STATISTICS` is ON (default)
- Manually via `CREATE STATISTICS` or `UPDATE STATISTICS`

```sql
-- Check auto-statistics settings
SELECT
    name,
    is_auto_create_stats_on,
    is_auto_update_stats_on,
    is_auto_update_stats_async_on
FROM sys.databases
WHERE name = DB_NAME();
```

> [!WARNING] AUTO_UPDATE_STATS_ASYNC
> Async stats update means the optimizer uses stale stats for the current query
> and schedules an update in the background. This can cause repeated bad plans
> until the update completes. Enable async only if you prefer consistent response
> times over accurate plans for the triggering query.

---

## How Statistics Are Created

**Automatic statistics** (AUTO_CREATE_STATISTICS = ON):
- Created when a query references a column in a predicate (WHERE, JOIN, GROUP BY, ORDER BY) and no statistics exist for that column
- Created as single-column statistics
- Named `_WA_Sys_<column_hash>_<table_id_hex>`

**Index statistics** — created automatically when an index is built; statistics name = index name; leading key column drives the histogram.

**Manual creation:**

```sql
-- Single column
CREATE STATISTICS stat_OrderDate
ON dbo.Orders (OrderDate);

-- Multi-column
CREATE STATISTICS stat_CustomerStatus
ON dbo.Orders (CustomerID, Status);

-- With specific sample rate
CREATE STATISTICS stat_OrderDate_Full
ON dbo.Orders (OrderDate)
WITH FULLSCAN;

-- Filtered (partial table)
CREATE STATISTICS stat_OrderDate_Active
ON dbo.Orders (OrderDate)
WHERE Status = 'Active';
```

---

## Histogram Structure

The histogram covers **only the leading column** of a statistics object. It has up to **200 steps**. Each step (row) in the histogram represents a range:

| Column | Description |
|--------|-------------|
| `RANGE_HI_KEY` | Upper bound value of the histogram step |
| `EQ_ROWS` | Estimated number of rows equal to `RANGE_HI_KEY` |
| `RANGE_ROWS` | Estimated number of rows between the previous `RANGE_HI_KEY` and this one (exclusive) |
| `DISTINCT_RANGE_ROWS` | Estimated distinct values in the range (not counting `RANGE_HI_KEY` itself) |
| `AVG_RANGE_ROWS` | `RANGE_ROWS / DISTINCT_RANGE_ROWS` — avg rows per distinct value in the range |

**How the optimizer uses it:**
- Predicate `col = @value`: if `@value` matches a `RANGE_HI_KEY`, use `EQ_ROWS`; otherwise use `AVG_RANGE_ROWS` from the enclosing step
- Predicate `col BETWEEN @lo AND @hi`: sum `EQ_ROWS` and `RANGE_ROWS` across spanned steps (with partial interpolation at boundaries)
- If `@value` is outside the histogram range (ascending key problem), the CE falls back to density-based estimates — often wildly wrong

**200-step limit implication:** For a table with millions of distinct values, each histogram step covers a wide range. `AVG_RANGE_ROWS` becomes an average over a large range and can be very inaccurate for skewed distributions.

---

## DBCC SHOW_STATISTICS Output Interpretation

```sql
-- Full output (header + density vector + histogram)
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate');

-- Or specify statistics name explicitly
DBCC SHOW_STATISTICS ('dbo.Orders', 'stat_OrderDate');

-- Show only histogram
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;

-- Show only density vector
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH DENSITY_VECTOR;

-- Show only header
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH STAT_HEADER;
```

**Header fields:**
| Field | Meaning |
|-------|---------|
| `Name` | Statistics object name |
| `Updated` | Datetime of last update |
| `Rows` | Row count at last update |
| `Rows Sampled` | Rows actually read (may be < Rows for sampled update) |
| `Steps` | Histogram step count (max 200) |
| `Density` | 1 / distinct values for leading column (deprecated in favor of density vector) |
| `Average key length` | Avg bytes in key columns |
| `String Index` | Whether a string summary index exists |
| `Filter Expression` | For filtered statistics |
| `Unfiltered Rows` | Total rows regardless of filter |

**Density vector:**
- Row per column prefix: `(col1)`, `(col1, col2)`, etc.
- `All density` = `1 / distinct values` for that prefix
- Selectivity = `All density × table row count`
- Low density (close to 0) = high selectivity; high density (close to 1) = low selectivity / poor candidate for index seek

**Reading the histogram:**
```sql
-- Look for histogram holes (large range between steps covering skewed data)
-- Look for steps where AVG_RANGE_ROWS >> EQ_ROWS (high within-step skew)
-- Look for max RANGE_HI_KEY vs actual max value (ascending key gap)
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;

SELECT MAX(OrderDate) FROM dbo.Orders;
-- If max > last histogram RANGE_HI_KEY, ascending key problem is present
```

---

## Auto-Update Thresholds

SQL Server auto-updates statistics when a **modification counter** exceeds a threshold. The counter (`rowmodctr` or the newer `modification_counter`) increments on INSERT, UPDATE, DELETE, and MERGE for each affected row (updates count as 1 delete + 1 insert for stats purposes).

**Legacy threshold (pre-2016, compat < 130):**

| Table type | Threshold to trigger auto-update |
|-----------|----------------------------------|
| Empty table | First INSERT (any rows) |
| Table with < 500 rows | 500 modifications |
| Table with ≥ 500 rows | `500 + 20% of row count` |

**Problem:** On a 10-million-row table, 20% = 2 million modifications required before auto-update fires. By that point, statistics may be badly stale.

**Check current modification counts:**

```sql
SELECT
    OBJECT_NAME(s.object_id)           AS table_name,
    s.name                              AS stats_name,
    sp.last_updated,
    sp.rows,
    sp.rows_sampled,
    sp.modification_counter,
    CAST(100.0 * sp.modification_counter / NULLIF(sp.rows, 0) AS DECIMAL(5,2))
                                        AS pct_modified
FROM sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id = OBJECT_ID('dbo.Orders')
ORDER BY sp.modification_counter DESC;
```

---

## Dynamic Statistics Threshold (2016+)

> [!NOTE] SQL Server 2016 / Compatibility Level 130
> Trace flag 2371 (which enabled dynamic threshold in earlier versions) is superseded
> by compatibility level 130+, where dynamic threshold is ON by default.

**Dynamic threshold formula:**
```
threshold = SQRT(1000 × current_row_count)
```

Examples:
| Row count | Old threshold (20%) | Dynamic threshold |
|-----------|--------------------|--------------------|
| 10,000 | 2,000 | ~3,162 |
| 100,000 | 20,000 | ~10,000 |
| 1,000,000 | 200,000 | ~31,623 |
| 10,000,000 | 2,000,000 | ~100,000 |
| 100,000,000 | 20,000,000 | ~316,228 |

For large tables the dynamic threshold fires **much sooner** than the legacy 20% rule, significantly reducing the window of stale statistics.

**To check which CE/threshold behavior is active:**
```sql
SELECT compatibility_level FROM sys.databases WHERE name = DB_NAME();
-- 130+ = dynamic threshold enabled
```

---

## Ascending Key Problem

**Symptom:** Queries filtering on a date/timestamp/identity column for recent values produce dramatically overestimated or underestimated row counts, causing bad plans.

**Root cause:** Statistics are updated only when the modification threshold is crossed. In the meantime, new rows are inserted with values *beyond* the histogram's `RANGE_HI_KEY` maximum. The CE has no histogram data for these values and falls back to a fixed fraction of the density estimate — often 1 row or a tiny fraction of actual rows.

**Diagnosis:**
```sql
-- Compare histogram max to actual max
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;
-- Note the max RANGE_HI_KEY

SELECT MAX(OrderDate) AS actual_max FROM dbo.Orders;
-- If actual_max >> RANGE_HI_KEY, ascending key problem is present

-- Confirm via estimated vs actual in execution plan
-- Look for large discrepancy on the date column predicate
```

**Workarounds (in order of preference):**

1. **Increase update frequency** — use a maintenance job with `UPDATE STATISTICS ... WITH FULLSCAN` or Ola Hallengren's `IndexOptimize` job.

2. **Trace flag 2389/2390** (pre-2016) — marks the leading column as "ascending key" so the CE applies a higher estimate for out-of-range values. Not needed at compat 130+ with CE 120+ which has built-in ascending key heuristics.

3. **STATISTICS_INCREMENTAL** (2014+, partitioned tables) — update only the newest partition's statistics, avoiding a full-table scan.

4. **Filtered statistics** — create a statistics object covering only recent data (requires maintenance to keep the filter relevant).

5. **Query hints** — `OPTION (USE HINT ('ASSUME_MIN_SELECTIVITY_FOR_FILTER_ESTIMATES'))` or `OPTIMIZE FOR` as a last resort.

```sql
-- Force a full statistics update on the problematic index/column
UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate WITH FULLSCAN;

-- Or update all statistics on the table
UPDATE STATISTICS dbo.Orders WITH FULLSCAN;
```

---

## UPDATE STATISTICS Options

```sql
-- Syntax
UPDATE STATISTICS table_or_view [ index_or_stats_name ]
    [ WITH
        { FULLSCAN [ , PERSIST_SAMPLE_PERCENT = { ON | OFF } ]
        | SAMPLE n { PERCENT | ROWS }
        | RESAMPLE
        | ROWCOUNT = n, PAGECOUNT = n
        | NORECOMPUTE
        | INCREMENTAL = { ON | OFF }
        | MAXDOP = n   -- 2022+
        }
    ]
```

| Option | Description | When to use |
|--------|-------------|-------------|
| `FULLSCAN` | Read every row; most accurate | After bulk load, ascending key fix, initial setup |
| `SAMPLE n PERCENT` | Read n% of rows | Balance between speed and accuracy on very large tables |
| `SAMPLE n ROWS` | Read exactly n rows | Rarely needed; use PERCENT instead |
| `RESAMPLE` | Use same sample rate as last update | Consistent behavior in maintenance jobs |
| `ROWCOUNT = n, PAGECOUNT = n` | Inject fake row/page counts without updating histogram | Rarely: forcing optimizer to treat table as larger/smaller for testing |
| `NORECOMPUTE` | Disable auto-update for this stats object after manual update | Use with caution — breaks auto-maintenance |
| `INCREMENTAL = ON` | Partition-level update (requires STATISTICS_INCREMENTAL setup) | Partitioned tables; see section below |
| `PERSIST_SAMPLE_PERCENT = ON` | Remember the FULLSCAN or SAMPLE rate for future auto-updates | 2016+; prevents auto-update from downgrading to default sampling |

> [!NOTE] SQL Server 2022
> `MAXDOP = n` option added to `UPDATE STATISTICS` — allows controlling parallelism
> during stats update without changing the instance-level MAXDOP.

> [!NOTE] SQL Server 2016 / Compatibility Level 130
> `PERSIST_SAMPLE_PERCENT = ON` persists the explicit sample rate for subsequent
> auto-updates on that statistics object, so a FULLSCAN doesn't revert to default
> sampling on the next auto-update.

**Update all statistics on a table:**
```sql
-- All statistics (index + auto-created column stats)
UPDATE STATISTICS dbo.Orders WITH FULLSCAN;

-- All statistics in a database (maintenance pattern)
EXEC sp_updatestats;
-- Note: sp_updatestats only updates stats with modification_counter > 0
-- It uses default sampling, not FULLSCAN — may not fix ascending key
```

---

## Filtered Statistics

Filtered statistics cover a subset of rows defined by a WHERE predicate. The optimizer uses them when a query's WHERE clause matches (or implies) the filter.

**When to create filtered statistics:**
- Table has heavily skewed value distribution (e.g., 95% of orders are `Status = 'Completed'`, 5% are `Status = 'Active'`)
- Queries almost always filter on a specific value or range
- Ascending key problem on recent data only

```sql
-- Filtered statistics for active orders only
CREATE STATISTICS stat_Orders_Active_Date
ON dbo.Orders (OrderDate)
WHERE Status = 'Active'
WITH FULLSCAN;

-- For recent data (ascending key workaround — requires periodic maintenance)
CREATE STATISTICS stat_Orders_Recent
ON dbo.Orders (OrderDate)
WHERE OrderDate >= '2024-01-01'
WITH FULLSCAN;
```

**Optimizer match rules:**
- The query's WHERE clause must **imply** the statistics filter — not just overlap
- Parameterized queries may not match filtered stats if the optimizer can't prove the parameter satisfies the filter at compile time
- Filtered statistics on a column with filtered indexes often complement each other

**Maintaining filtered statistics:**
- Auto-update respects the filter — modification_counter counts only filtered rows
- If the filter covers a moving time window, the filter definition must be recreated periodically (DROP + CREATE — cannot ALTER the filter)

---

## Multi-Column Statistics

Statistics on multiple columns capture **correlation** between columns and provide density vectors for column prefixes.

```sql
-- Two-column statistics
CREATE STATISTICS stat_CustomerStatus
ON dbo.Orders (CustomerID, Status)
WITH FULLSCAN;
```

**Density vector for multi-column stats:**
- Row 1: density for `(CustomerID)` alone — same as single-column stats
- Row 2: density for `(CustomerID, Status)` — captures joint selectivity

**When multi-column stats help:**
- Queries with `WHERE CustomerID = @id AND Status = @status` — optimizer can use joint density instead of multiplying individual selectivities (which assumes independence, usually wrong)
- Column ordering matters: put the most selective / equality-predicate column first

**Limitation:** The histogram covers only the leading column. If the second column drives the range predicate, a separate single-column stats object is better.

```sql
-- Check if correlated columns exist without multi-column stats
-- (Look for columns that are always queried together in plan cache)
SELECT
    qs.total_logical_reads,
    SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset
            WHEN -1 THEN DATALENGTH(st.text)
            ELSE qs.statement_end_offset
          END - qs.statement_start_offset)/2)+1) AS query_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
ORDER BY qs.total_logical_reads DESC;
```

---

## STATISTICS_INCREMENTAL

> [!NOTE] SQL Server 2014 / Compatibility Level 120
> `STATISTICS_INCREMENTAL` requires partitioned tables with `STATISTICS_INCREMENTAL = ON`
> set at the statistics level. Requires the `STATISTICS_INCREMENTAL` option.

Incremental statistics maintain per-partition statistics metadata, allowing updates to target **only changed partitions** — critical for large partitioned tables where a full FULLSCAN is prohibitively expensive.

**Setup:**
```sql
-- Enable when creating the index (statistics created with index inherit this)
CREATE INDEX IX_Orders_OrderDate ON dbo.Orders (OrderDate)
WITH (STATISTICS_INCREMENTAL = ON);

-- Or create standalone incremental statistics
CREATE STATISTICS stat_Orders_Inc
ON dbo.Orders (OrderDate)
WITH FULLSCAN, INCREMENTAL = ON;
```

**Updating only the newest partition:**
```sql
-- Update statistics for partition 12 only (e.g., after loading December data)
UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate
WITH RESAMPLE ON PARTITIONS (12);

-- Or use partition function to identify partition number
DECLARE @partition_num INT;
SELECT @partition_num = $PARTITION.PF_OrderDate('2024-12-01');

UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate
WITH RESAMPLE ON PARTITIONS (@partition_num);
```

**How the optimizer uses incremental stats:**
- The histogram is synthesized from per-partition component histograms
- Each partition's component histogram has up to 200 steps
- The merged histogram seen by the optimizer has up to 200 steps total (may lose resolution when merging many partitions)

**Limitation:** Incremental stats do **not** improve cardinality estimation for queries that span multiple partitions — the merged histogram has reduced resolution. They are primarily a **maintenance efficiency feature**, not a plan quality feature.

```sql
-- Check which stats are incremental
SELECT
    OBJECT_NAME(s.object_id) AS table_name,
    s.name                    AS stats_name,
    s.is_incremental
FROM sys.stats s
WHERE s.object_id = OBJECT_ID('dbo.Orders')
  AND s.is_incremental = 1;
```

---

## Cardinality Estimator (CE) Versions

The cardinality estimator version affects how histograms are used and how multi-predicate selectivity is calculated.

| CE Version | Compat Level | Default for | Key behavioral changes |
|-----------|-------------|-------------|----------------------|
| CE 70 | 70 | SQL Server 7.0 | Original CE |
| CE 120 | 120 | SQL Server 2014 | Rewritten; better multi-predicate, ascending key heuristics |
| CE 130 | 130 | SQL Server 2016 | Dynamic threshold, incremental updates |
| CE 140 | 140 | SQL Server 2017 | IQP interleaved execution, memory grant feedback |
| CE 150 | 150 | SQL Server 2019 | Batch mode on rowstore, table variable deferred compilation |
| CE 160 | 160 | SQL Server 2022 | DOP feedback, CE feedback, PSPO |

> [!WARNING] CE version change on upgrade
> Upgrading compatibility level changes the CE. Plans that were good under the old CE
> may regress. Test with Query Store's plan forcing to revert individual queries.

**Force old CE for a specific query:**
```sql
-- Use legacy CE 70 for this query
SELECT * FROM dbo.Orders WHERE OrderDate > '2024-01-01'
OPTION (USE HINT ('FORCE_LEGACY_CARDINALITY_ESTIMATION'));

-- Or force CE 120
OPTION (USE HINT ('ENABLE_QUERY_OPTIMIZER_HOTFIXES'));
```

**Verify CE version in use:**
```sql
-- From execution plan XML: look for CardinalityEstimationModelVersion attribute
SELECT qp.query_plan
FROM sys.dm_exec_cached_plans cp
CROSS APPLY sys.dm_exec_query_plan(cp.plan_handle) qp
WHERE qp.query_plan.value('(//*[@StatementId])[1]/@CardinalityEstimationModelVersion',
    'INT') < 120;  -- find queries using legacy CE
```

---

## Statistics and Index Maintenance

**INDEX REBUILD vs statistics:**
- `ALTER INDEX ... REBUILD` updates statistics with FULLSCAN (reads all rows)
- `ALTER INDEX ... REORGANIZE` does **not** update statistics
- After a rebuild, auto-update statistics won't fire until the modification threshold is crossed again

**Recommendation:** Use a maintenance strategy (e.g., Ola Hallengren's `IndexOptimize`) that handles both index defragmentation and statistics updates independently — don't rely on rebuilds as your stats update mechanism.

```sql
-- Rebuild updates stats; reorganize does not
ALTER INDEX IX_Orders_OrderDate ON dbo.Orders REBUILD;
-- Equivalent to UPDATE STATISTICS with FULLSCAN for that index

ALTER INDEX IX_Orders_OrderDate ON dbo.Orders REORGANIZE;
-- Stats remain untouched
```

**After bulk loads:**
```sql
-- Always update statistics after significant bulk load
BULK INSERT dbo.Orders FROM '\\server\share\orders.csv'
WITH (FIRSTROW = 2, FIELDTERMINATOR = ',', ROWTERMINATOR = '\n', TABLOCK);

-- Then update stats
UPDATE STATISTICS dbo.Orders WITH FULLSCAN;
-- Or just the relevant index
UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate WITH FULLSCAN;
```

---

## Common Patterns

**Identify most stale statistics:**
```sql
SELECT TOP 20
    OBJECT_SCHEMA_NAME(s.object_id) + '.' + OBJECT_NAME(s.object_id) AS table_name,
    s.name          AS stats_name,
    sp.last_updated,
    sp.rows,
    sp.modification_counter,
    CAST(100.0 * sp.modification_counter / NULLIF(sp.rows, 0) AS DECIMAL(5,2)) AS pct_modified,
    sp.rows_sampled,
    CAST(100.0 * sp.rows_sampled / NULLIF(sp.rows, 0) AS DECIMAL(5,2))         AS sample_pct
FROM sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id > 100   -- exclude system tables
ORDER BY sp.modification_counter DESC;
```

**Check if ascending key problem exists:**
```sql
-- For each index, compare histogram max to actual max
SELECT
    OBJECT_NAME(s.object_id)    AS table_name,
    s.name                       AS stats_name,
    sp.last_updated,
    sp.rows,
    sp.modification_counter
FROM sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id = OBJECT_ID('dbo.Orders')
  AND s.name LIKE 'IX_%';

-- Then inspect histogram for the suspicious index
DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;
```

**Force stats update for all tables in database:**
```sql
-- sp_updatestats: only updates stats where modification_counter > 0
-- Uses default sampling (not FULLSCAN)
EXEC sp_updatestats;

-- For FULLSCAN on all user tables:
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'UPDATE STATISTICS ' +
    QUOTENAME(SCHEMA_NAME(schema_id)) + '.' + QUOTENAME(name) +
    ' WITH FULLSCAN;' + CHAR(10)
FROM sys.tables
WHERE is_ms_shipped = 0;
EXEC sp_executesql @sql;
```

**Diagnose bad cardinality estimate from a plan:**
```sql
-- Capture estimated vs actual row counts from recent plans
SELECT TOP 20
    qs.execution_count,
    qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
    SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset
            WHEN -1 THEN DATALENGTH(st.text)
            ELSE qs.statement_end_offset END
          - qs.statement_start_offset)/2)+1) AS query_text,
    qp.query_plan
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE qs.total_logical_reads / qs.execution_count > 10000
ORDER BY qs.total_logical_reads DESC;
```

---

## Metadata Queries

**All statistics on a table:**
```sql
SELECT
    s.stats_id,
    s.name                  AS stats_name,
    s.auto_created,
    s.user_created,
    s.is_incremental,
    s.filter_definition,
    sp.last_updated,
    sp.rows,
    sp.rows_sampled,
    sp.steps,
    sp.unfiltered_rows,
    sp.modification_counter,
    STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY sc.stats_column_id)
                             AS columns
FROM sys.stats s
INNER JOIN sys.stats_columns sc ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id
INNER JOIN sys.columns c        ON c.object_id = sc.object_id AND c.column_id = sc.column_id
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id = OBJECT_ID('dbo.Orders')
GROUP BY s.stats_id, s.name, s.auto_created, s.user_created, s.is_incremental,
         s.filter_definition, sp.last_updated, sp.rows, sp.rows_sampled,
         sp.steps, sp.unfiltered_rows, sp.modification_counter
ORDER BY s.stats_id;
```

**Statistics not updated in 7 days:**
```sql
SELECT
    OBJECT_SCHEMA_NAME(s.object_id) + '.' + OBJECT_NAME(s.object_id) AS table_name,
    s.name                  AS stats_name,
    sp.last_updated,
    sp.rows,
    sp.modification_counter
FROM sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE sp.last_updated < DATEADD(DAY, -7, GETDATE())
  AND s.object_id > 100
ORDER BY sp.last_updated ASC;
```

**Auto-created statistics (candidates for review):**
```sql
SELECT
    OBJECT_SCHEMA_NAME(s.object_id) + '.' + OBJECT_NAME(s.object_id) AS table_name,
    s.name AS stats_name,
    sp.last_updated,
    sp.rows,
    sp.modification_counter,
    c.name AS column_name
FROM sys.stats s
INNER JOIN sys.stats_columns sc ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id
INNER JOIN sys.columns c        ON c.object_id = sc.object_id AND c.column_id = sc.column_id
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.auto_created = 1
  AND s.object_id > 100
ORDER BY sp.modification_counter DESC;
```

**Incremental statistics per partition:**
```sql
-- Requires sys.dm_db_incremental_stats_properties (2014+)
SELECT
    OBJECT_NAME(s.object_id) AS table_name,
    s.name                   AS stats_name,
    isp.partition_number,
    isp.last_updated,
    isp.rows,
    isp.modification_counter
FROM sys.stats s
CROSS APPLY sys.dm_db_incremental_stats_properties(s.object_id, s.stats_id) isp
WHERE s.object_id = OBJECT_ID('dbo.Orders')
ORDER BY isp.partition_number;
```

---

## Gotchas

1. **Auto-update fires at the end of the triggering query** — the query that trips the modification threshold runs with stale stats and possibly a bad plan. Auto-update happens *after* that query completes.

2. **NORECOMPUTE disables auto-updates permanently** — if you use `UPDATE STATISTICS ... WITH NORECOMPUTE` (or `sp_autostats 'OFF'`), SQL Server will never auto-update that stats object again. Always remove NORECOMPUTE after one-off manual updates.

3. **sp_updatestats uses sampling, not FULLSCAN** — it's faster but won't fix ascending key problems. Use `UPDATE STATISTICS ... WITH FULLSCAN` for problem tables.

4. **Rebuilding an index also updates its statistics** — but doesn't update auto-created column-level statistics. You may need to update both.

5. **Filtered statistics don't help if the predicate doesn't match at compile time** — parameterized queries with `WHERE Status = @status` won't use filtered stats for `Status = 'Active'` unless the optimizer can prove at compile time that `@status = 'Active'`.

6. **200-step histogram limit is the same regardless of table size** — a 1-billion-row table and a 1,000-row table both get at most 200 histogram steps. Bucket width grows proportionally with table size.

7. **Statistics update during index rebuild is FULLSCAN, not sampled** — good for accuracy, but a large index rebuild triggers a full stats read as a side effect, which is expected.

8. **STATISTICS_INCREMENTAL doesn't improve plan quality for cross-partition queries** — the merged histogram has reduced resolution. It is purely a maintenance performance optimization.

9. **Dropping and recreating a table drops all statistics** — including manually created ones. `TRUNCATE TABLE` retains statistics structure but resets modification counters.

10. **Statistics names with auto-generated names (`_WA_Sys_...`) are not stable across environments** — don't reference them by name in scripts. Use `sys.stats` to find by column name.

11. **CE feedback (2022+) in Query Store can silently override histogram-based estimates** — if a plan has repeatedly seen a cardinality mismatch, the CE may apply a learned correction. This is good, but can make debugging confusing. Check `sys.query_store_plan_feedback` for active corrections.

12. **`UPDATE STATISTICS` without specifying a stats name updates all statistics on the table** — intended behavior, but can be slow on wide tables with many indexes. Be explicit in maintenance windows.

---

## See Also

- [`references/29-query-plans.md`](29-query-plans.md) — reading estimated vs actual row counts in execution plans
- [`references/30-query-store.md`](30-query-store.md) — CE feedback, plan regression tracking, forced plans
- [`references/31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — memory grant feedback, DOP feedback, how IQP uses statistics
- [`references/10-partitioning.md`](10-partitioning.md) — STATISTICS_INCREMENTAL in context of partition switching
- [`references/08-indexes.md`](08-indexes.md) — index rebuild vs reorganize and stats impact
- [`references/32-performance-diagnostics.md`](32-performance-diagnostics.md) — missing index DMVs, wait stats, sp_Blitz

---

## Sources

[^1]: [SQL Server Index and Statistics Maintenance](https://ola.hallengren.com/sql-server-index-and-statistics-maintenance.html) — Ola Hallengren's IndexOptimize solution for automated index defragmentation and statistics maintenance
[^2]: [DBCC SHOW_STATISTICS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-show-statistics-transact-sql) — reference for DBCC SHOW_STATISTICS syntax, result set columns (header, density vector, histogram), and permissions
[^3]: [Statistics - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/statistics/statistics) — comprehensive reference covering statistics creation, auto-update thresholds, dynamic threshold at compatibility level 130, filtered statistics, and incremental statistics
[^4]: [sys.dm_db_stats_properties (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-stats-properties-transact-sql) — DMV reference for querying statistics metadata including last_updated, rows, rows_sampled, and modification_counter
[^5]: [sys.dm_db_incremental_stats_properties (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-incremental-stats-properties-transact-sql) — DMV reference for querying per-partition incremental statistics properties
[^6]: [How Bad Statistics Cause Bad SQL Server Query Performance](https://www.brentozar.com/archive/2020/11/how-bad-statistics-cause-bad-sql-server-query-performance/) — Brent Ozar explains how stale or inaccurate statistics lead to poor query plans and performance problems
[^7]: [Statistics on Ascending Columns](https://www.red-gate.com/simple-talk/databases/sql-server/database-administration-sql-server/statistics-on-ascending-columns/) — Fabiano Amorim (Simple Talk, 2011) explains the ascending key problem, how SQL Server brands statistics columns as ascending, and how trace flags 2389/2390 trigger auto quick-corrected statistics for out-of-histogram values
[^8]: [UPDATE STATISTICS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/update-statistics-transact-sql) — full syntax reference for UPDATE STATISTICS including FULLSCAN, SAMPLE, RESAMPLE, NORECOMPUTE, INCREMENTAL, PERSIST_SAMPLE_PERCENT, and MAXDOP options
[^9]: [Cardinality Estimation Feedback](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-cardinality-estimation-feedback) — covers CE feedback in Query Store (SQL Server 2022+), including correlation, join containment, and row goal scenarios tracked via sys.query_store_plan_feedback

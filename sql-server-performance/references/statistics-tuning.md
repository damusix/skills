# Statistics Tuning


How SQL Server uses statistics for cardinality estimation, why they go stale, and how to fix them.

## Table of Contents


- [How Statistics Drive Plans](#how-statistics-drive-plans)
- [Histogram Structure](#histogram-structure)
- [Reading DBCC SHOW_STATISTICS](#reading-dbcc-show_statistics)
- [Auto-Update Thresholds](#auto-update-thresholds)
- [The Ascending Key Problem](#the-ascending-key-problem)
- [UPDATE STATISTICS Options](#update-statistics-options)
- [Filtered Statistics](#filtered-statistics)
- [Multi-Column Statistics](#multi-column-statistics)
- [Statistics and Index Maintenance](#statistics-and-index-maintenance)
- [See Also](#see-also)
- [Sources](#sources)

---

## How Statistics Drive Plans


Every statistics object describes the distribution of values in one or more columns. The query optimizer uses statistics to estimate how many rows will satisfy a predicate — the **cardinality estimate**. Cardinality estimates drive:

- **Join algorithm selection** — Nested Loops vs Hash Match vs Merge Join
- **Memory grant sizing** — how much RAM to reserve for sort and hash operations
- **Index selection** — whether a seek + key lookup will be cheaper than a clustered scan
- **Parallelism decisions** — whether parallel plan overhead is justified

Wrong estimates lead to wrong plans. A query that is fast in development (small data, fresh statistics) can be catastrophically slow in production (large data, stale statistics, ascending key problem).

Statistics are created:
- Automatically on index creation (statistic name = index name)
- Automatically on query predicates when `AUTO_CREATE_STATISTICS` is ON (default)
- Manually via `CREATE STATISTICS` or `UPDATE STATISTICS`

    -- Verify auto-create and auto-update are enabled
    SELECT name,
           is_auto_create_stats_on,
           is_auto_update_stats_on,
           is_auto_update_stats_async_on
    FROM sys.databases WHERE name = DB_NAME();

`AUTO_UPDATE_STATS_ASYNC = ON` updates statistics in the background — the current query uses stale statistics and schedules a refresh. This gives consistent latency but means repeated bad plans until the async update completes. On OLTP systems, prefer synchronous update (`ASYNC = OFF`) so each plan compiles with fresh statistics.

---

## Histogram Structure


The histogram covers **only the leading column** of a statistics object and has up to **200 steps**.

| Column | Meaning |
|---|---|
| `RANGE_HI_KEY` | Upper bound value of this step |
| `EQ_ROWS` | Estimated rows equal to `RANGE_HI_KEY` |
| `RANGE_ROWS` | Estimated rows between the previous and current `RANGE_HI_KEY` |
| `DISTINCT_RANGE_ROWS` | Distinct values in the range (not counting `RANGE_HI_KEY`) |
| `AVG_RANGE_ROWS` | `RANGE_ROWS / DISTINCT_RANGE_ROWS` — average rows per value in the range |

**How the optimizer uses the histogram:**
- `WHERE col = @val`: if `@val` matches a `RANGE_HI_KEY`, use `EQ_ROWS`. If `@val` falls between two steps, use `AVG_RANGE_ROWS` from the containing step.
- `WHERE col BETWEEN @lo AND @hi`: sum `EQ_ROWS` and `RANGE_ROWS` across spanned steps.
- `WHERE col = @val` and `@val` is beyond the histogram's maximum `RANGE_HI_KEY` (the ascending key problem): the CE falls back to a fraction of the density estimate — often 1 row.

**200-step limit:** for a table with millions of distinct values, each step covers a wide range. `AVG_RANGE_ROWS` becomes an average over a large span and will be wrong for any skewed distribution within that range.

---

## Reading DBCC SHOW_STATISTICS


    -- Full output: header + density vector + histogram
    DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate');

    -- Histogram only
    DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;

    -- Header only (age and row count)
    DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH STAT_HEADER;

**Key header fields:**

| Field | What to look for |
|---|---|
| `Updated` | How old are the statistics? Hours or days ago = likely fresh; weeks or months = stale |
| `Rows` | Row count at last update — does it match current row count? |
| `Rows Sampled` | Sampled rows — if much less than Rows, accuracy may be limited for skewed data |
| `Steps` | At 200, the histogram is fully packed — additional distinct values fall into averaged steps |
| `Filter Expression` | For filtered statistics — confirm the filter matches your queries |

**Diagnosing ascending key problem from histogram:**

    -- 1. Get the last histogram step's RANGE_HI_KEY
    DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;
    -- Note the max RANGE_HI_KEY value

    -- 2. Compare to actual table maximum
    SELECT MAX(OrderDate) AS actual_max FROM dbo.Orders;

    -- If actual_max >> max RANGE_HI_KEY: ascending key problem is present
    -- All recent inserts fall outside the histogram; CE uses density estimate (often 1 row)

---

## Auto-Update Thresholds


SQL Server auto-updates statistics when a modification counter exceeds a threshold.

**Legacy threshold** (pre-compat 130, or compat 130+ with flag 2371 — now obsolete):

| Table state | Modification threshold |
|---|---|
| Empty table | Any insert |
| < 500 rows | 500 modifications |
| ≥ 500 rows | 500 + 20% of row count |

Problem: on a 10-million-row table, 20% = 2 million modifications before auto-update fires. Statistics can be severely stale for days on a busy table.

**Dynamic threshold** (compat 130+, SQL Server 2016+):

At compat 130+, SQL Server uses whichever threshold fires first — the legacy formula or the dynamic formula:

    threshold = MIN(500 + 0.20 × n,  SQRT(1000 × n))

For tables above ~25,000 rows, `SQRT(1000 × n)` is smaller than `500 + 0.20 × n`, so the dynamic threshold fires sooner. For small tables the legacy formula still controls.

| Row count | Legacy (500 + 20%) | Dynamic SQRT(1000 × n) | Effective threshold |
|---|---|---|---|
| 100,000 | 20,500 | ~10,000 | **~10,000** |
| 1,000,000 | 200,500 | ~31,623 | **~31,623** |
| 10,000,000 | 2,000,500 | ~100,000 | **~100,000** |
| 100,000,000 | 20,000,500 | ~316,228 | **~316,228** |

The dynamic threshold fires **much sooner** on large tables — 20× improvement at 10M rows. Upgrade to compatibility level 130 (SQL Server 2016) or higher to get this behavior automatically — no trace flags needed.

    -- Check current compatibility level
    SELECT name, compatibility_level FROM sys.databases WHERE name = DB_NAME();
    -- 130+ = dynamic threshold is active

**Check modification counters:**

    SELECT OBJECT_NAME(s.object_id) AS table_name,
           s.name                    AS stats_name,
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

---

## The Ascending Key Problem


Queries filtering on a date, timestamp, or IDENTITY column for recent data are the most common victim of stale statistics.

**Root cause:** statistics are updated when the modification threshold fires. Between updates, new rows are inserted with values beyond the histogram's maximum `RANGE_HI_KEY`. The CE has no histogram data for these values and falls back to a fraction of the density estimate — often estimating 1 row when millions exist.

**Symptom in execution plan:** estimated rows = 1 on a date-column predicate returning thousands of actual rows. This causes the wrong join algorithm (Nested Loops instead of Hash Match) and an insufficient memory grant (causing hash/sort spills).

**Fix options in order of preference:**

**1. More frequent statistics updates** — schedule `UPDATE STATISTICS ... WITH FULLSCAN` on rapidly-growing tables. Tools like Ola Hallengren's IndexOptimize can update only stale statistics automatically.

    UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate WITH FULLSCAN;

**2. STATISTICS_INCREMENTAL** (SQL Server 2014+) — for partitioned tables, update only the newest partition's statistics without scanning the whole table.

Incremental statistics must be enabled at index or statistics creation time — `UPDATE STATISTICS ... WITH INCREMENTAL = ON` **does not enable the feature** on an existing non-incremental statistics object; it raises error 9111. Enable at creation:

    -- Enable incremental stats when creating the index
    CREATE NONCLUSTERED INDEX IX_Orders_OrderDate
        ON dbo.Orders (OrderDate)
        WITH (STATISTICS_INCREMENTAL = ON);

    -- Or enable on an existing statistics object by recreating it
    CREATE STATISTICS stat_Orders_OrderDate
    ON dbo.Orders (OrderDate)
    WITH (INCREMENTAL = ON);

Once incremental statistics are enabled, update only specific partitions:

    -- Update only partitions with high modification counters
    UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate
    WITH RESAMPLE ON PARTITIONS (12, 13);

**3. Filtered statistics for recent data:**

    -- Create a stats object covering only recent rows
    CREATE STATISTICS stat_Orders_Recent_Date
    ON dbo.Orders (OrderDate)
    WHERE OrderDate >= '2024-01-01';
    -- Must be maintained/recreated as "recent" changes

**4. Compat level 130+ with dynamic threshold** — fires before the ascending key gap grows large.

---

## UPDATE STATISTICS Options


    -- Basic syntax
    UPDATE STATISTICS table_name [ stats_name ]
    WITH { FULLSCAN | SAMPLE n PERCENT | RESAMPLE | INCREMENTAL = ON }

| Option | Description | When to use |
|---|---|---|
| `FULLSCAN` | Read every row — most accurate | After bulk load, ascending key fix, initial setup |
| `SAMPLE n PERCENT` | Read n% of rows | Balance speed vs accuracy on very large tables |
| `RESAMPLE` | Use same sample rate as last update | Consistent behavior in maintenance jobs |
| `INCREMENTAL = ON` | Partition-level update | Partitioned tables with rapidly-growing partitions |
| `PERSIST_SAMPLE_PERCENT = ON` | Remember the FULLSCAN rate for future auto-updates | 2016+: prevents auto-update from reverting to default sampling |
| `NORECOMPUTE` | Disable auto-update for this stats object | Rarely — breaks automatic freshness |

    -- Update all statistics on a table with FULLSCAN
    UPDATE STATISTICS dbo.Orders WITH FULLSCAN;

    -- Update all statistics in a database (sp_updatestats only updates changed stats,
    -- uses default sampling — may not fix ascending key problem)
    EXEC sp_updatestats;

    -- Persist the FULLSCAN rate so auto-updates do not revert to sampling
    UPDATE STATISTICS dbo.Orders IX_Orders_OrderDate
    WITH FULLSCAN, PERSIST_SAMPLE_PERCENT = ON;

---

## Filtered Statistics


Filtered statistics cover a subset of rows defined by a WHERE clause. The optimizer uses them when a query predicate is compatible with the filter.

**When to create filtered statistics:**

- Table has heavily skewed value distribution (95% of rows have `Status = 'Completed'`; 5% are `Status = 'Active'`)
- Queries almost always filter on one specific value or range
- Ascending key problem on recent data only

    -- Statistics covering only active orders
    CREATE STATISTICS stat_Orders_Active_Date
    ON dbo.Orders (OrderDate)
    WHERE Status = 'Active';

    -- Statistics covering the current year (useful for ascending key on date)
    CREATE STATISTICS stat_Orders_2025_Date
    ON dbo.Orders (OrderDate)
    WHERE OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01';

The optimizer uses filtered statistics when the query WHERE clause is compatible — it must include the filter predicate or a logically equivalent/stronger predicate. A query without `WHERE Status = 'Active'` will not use the filtered statistics above.

    -- Check all statistics on a table including filters
    SELECT s.name, s.filter_definition, sp.last_updated, sp.rows, sp.modification_counter
    FROM sys.stats s
    CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
    WHERE s.object_id = OBJECT_ID('dbo.Orders')
    ORDER BY sp.last_updated DESC;

---

## Multi-Column Statistics


By default, the optimizer assumes predicate columns are statistically independent. For a query with `WHERE Status = 'Active' AND Region = 'West'`, the optimizer multiplies the individual selectivities:

    estimated_rows = total_rows × P(Status = 'Active') × P(Region = 'West')

If Status and Region are correlated (Active orders are disproportionately in West), this underestimates the result set — wrong join algorithm, insufficient memory grant.

**Fix:** create multi-column statistics so the optimizer sees the joint distribution:

    CREATE STATISTICS stat_Orders_Status_Region
    ON dbo.Orders (Status, Region);

The density vector in multi-column statistics captures combined selectivity. The optimizer uses it when the query references a prefix of the statistics columns (`Status` alone, or `Status + Region` together).

    -- Check density vectors
    DBCC SHOW_STATISTICS ('dbo.Orders', 'stat_Orders_Status_Region') WITH DENSITY_VECTOR;
    -- Low All density = high selectivity = good index candidate

---

## Statistics and Index Maintenance


**REBUILD updates statistics** — an index rebuild (`ALTER INDEX ... REBUILD`) updates statistics with the equivalent of FULLSCAN. This is a side benefit of scheduled index maintenance.

**REORGANIZE does not update statistics** — run `UPDATE STATISTICS` separately after a reorganize if statistics are stale:

    ALTER INDEX IX_Orders_CustomerID ON dbo.Orders REORGANIZE;
    UPDATE STATISTICS dbo.Orders IX_Orders_CustomerID WITH FULLSCAN;

**Statistics and plan cache invalidation** — when statistics are updated, the plans compiled against those statistics are invalidated and recompiled on next execution. This is expected behavior. If you observe a wave of recompilations after a statistics update job, that is the optimizer rebuilding stale plans — it typically settles within a few minutes.

**Statistics freshness monitoring in a maintenance job:**

    -- Find statistics not updated in the last 24 hours with > 1% modifications
    SELECT OBJECT_NAME(s.object_id) AS table_name,
           s.name                    AS stats_name,
           sp.last_updated,
           sp.modification_counter,
           sp.rows,
           CAST(100.0 * sp.modification_counter / NULLIF(sp.rows, 0) AS DECIMAL(5,2))
               AS pct_modified
    FROM sys.stats s
    CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
    WHERE sp.modification_counter > sp.rows * 0.01
      AND sp.last_updated < DATEADD(HOUR, -24, GETDATE())
      AND OBJECT_NAME(s.object_id) NOT LIKE 'sys%'
    ORDER BY pct_modified DESC;

---

## See Also


- [execution-plans.md](execution-plans.md) — cardinality estimation in plans, estimated vs actual rows
- [index-strategy.md](index-strategy.md) — index rebuilds and their effect on statistics
- [wait-stats.md](wait-stats.md) — RESOURCE_SEMAPHORE from under-sized memory grants
- [batch-operations.md](batch-operations.md) — updating statistics after bulk loads

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [Statistics - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/statistics/statistics) — Full reference on statistics histograms, auto-update thresholds (legacy 20% rule vs dynamic threshold at compat 130+), ascending key problem, filtered statistics, and multi-column statistics for correlated predicates.
[^2]: [DBCC SHOW_STATISTICS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-show-statistics-transact-sql) — Documents STAT_HEADER, DENSITY_VECTOR, and HISTOGRAM result sets including RANGE_HI_KEY, EQ_ROWS, RANGE_ROWS, DISTINCT_RANGE_ROWS, and AVG_RANGE_ROWS column definitions.
[^3]: [UPDATE STATISTICS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/update-statistics-transact-sql) — Syntax reference for FULLSCAN, SAMPLE, RESAMPLE, PERSIST_SAMPLE_PERCENT, and INCREMENTAL options, including which combinations are valid and when each is appropriate.
[^4]: [sys.dm_db_stats_properties (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-stats-properties-transact-sql) — Reference for last_updated, rows, rows_sampled, modification_counter, and persisted_sample_percent columns used in freshness monitoring queries.
[^5]: [Cardinality Estimation (SQL Server)](https://learn.microsoft.com/en-us/sql/relational-databases/performance/cardinality-estimation-sql-server) — Explains how CE versions use histogram data, the independence vs correlation assumptions for multi-predicate queries, and how the ascending-key problem was partially addressed in CE120+.
[^6]: [Monitor Performance by Using the Query Store](https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store) — Shows how to use Query Store to detect plan regressions caused by stale statistics and compare query performance before and after statistics updates.
[^7]: [Maintain Indexes Optimally to Improve Performance and Reduce Resource Utilization](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/reorganize-and-rebuild-indexes) — Explains that index REBUILD performs a FULLSCAN-equivalent statistics update and recommends trying explicit statistics updates before rebuilding indexes.
[^8]: [SQL Server Index and Statistics Maintenance](https://ola.hallengren.com/sql-server-index-and-statistics-maintenance.html) — Ola Hallengren's solution covering automated statistics maintenance including sample-rate overrides and INCREMENTAL statistics support for partitioned tables.

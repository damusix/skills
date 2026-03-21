---
name: sql-bi-reporting
description: "Use when writing T-SQL for business intelligence, analytics, or reporting. Includes building summary reports with GROUPING SETS, ROLLUP, and CUBE, writing time-series queries with date bucketing, creating pivot/unpivot transformations, generating tally/numbers tables for gap-filling, building running totals and moving averages with window functions, writing year-over-year comparisons, designing materialized views for dashboards, or producing CSV/JSON exports from SQL Server."
---

# SQL BI & Reporting


Patterns for writing analytical T-SQL queries — aggregations, time series, pivots, gap analysis, and data export. These patterns extract meaning from data for dashboards, reports, and human decision-making.

## When to Use

- Writing summary reports with subtotals across multiple dimensions
- Building time-series queries (bucketing, gap filling, moving averages)
- Pivoting row data into columns or unpivoting columns into rows
- Generating date ranges or number sequences (tally tables)
- Solving gaps-and-islands problems (consecutive ranges, session analysis)
- Exporting query results as JSON, XML, or CSV
- Writing queries optimized for Power BI DirectQuery or SSRS
- Year-over-year, cohort, or funnel analysis

**When NOT to use:** application schema design (table design, naming conventions, access control), query performance tuning (execution plans, index tuning, wait stats), or ETL pipeline design.

## Multi-Level Aggregation

Three operators produce subtotals from a single GROUP BY — choose based on your needs:

| Operator | Produces | Use when |
|----------|----------|----------|
| `ROLLUP(A, B, C)` | (A,B,C), (A,B), (A), () | Columns form a hierarchy (year > quarter > month) |
| `CUBE(A, B)` | All 2^n combinations | Need every cross-dimensional combination |
| `GROUPING SETS(...)` | Exactly what you list | Need specific subtotals, not a formula |

    -- Hierarchical subtotals: year > quarter > grand total
    SELECT
        YEAR(OrderDate)              AS OrderYear,
        DATEPART(quarter, OrderDate) AS OrderQtr,
        SUM(TotalAmount)             AS Revenue
    FROM Sales.Orders
    GROUP BY ROLLUP(
        YEAR(OrderDate),
        DATEPART(quarter, OrderDate)
    )
    ORDER BY OrderYear, OrderQtr;

Use `GROUPING(col)` to distinguish subtotal NULLs from real NULLs — returns 1 for subtotal rows, 0 for data rows.

**Full reference:** [Aggregation Patterns](references/aggregation-patterns.md) — GROUPING_ID, conditional aggregation, HAVING vs WHERE, COUNT semantics with NULLs.

## Window Functions

Window functions compute values across related rows without collapsing the result. They are the analytical workhorse — replacing self-joins, correlated subqueries, and cursors.

### Quick Reference

| Category | Functions | Frame needed? |
|----------|-----------|--------------|
| Ranking | `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE` | No |
| Offset | `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE` | Yes for LAST_VALUE |
| Aggregate | `SUM`, `AVG`, `COUNT`, `MIN`, `MAX` | Yes for running/sliding |

### Running total

    SELECT
        OrderDate,
        TotalAmount,
        SUM(TotalAmount) OVER (
            ORDER BY OrderDate
            ROWS UNBOUNDED PRECEDING
        ) AS RunningTotal
    FROM Sales.Orders;

Always specify `ROWS` explicitly. The default frame (when ORDER BY is present but no frame is specified) is `RANGE UNBOUNDED PRECEDING` — this includes ties, produces different results, and is slower.

### Moving average

    -- 7-day moving average
    AVG(DailyRevenue) OVER (
        ORDER BY OrderDate
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS MovingAvg7Day

### Period-over-period comparison

    -- Year-over-year monthly revenue (offset 12 for monthly data)
    LAG(Revenue, 12) OVER (ORDER BY OrderYear, OrderMonth) AS PriorYearRevenue

### Greatest-N-per-group

    -- Most recent order per customer
    WITH Ranked AS (
        SELECT *,
            ROW_NUMBER() OVER (
                PARTITION BY CustomerID
                ORDER BY OrderDate DESC
            ) AS RN
        FROM Sales.Orders
    )
    SELECT * FROM Ranked WHERE RN = 1;

### Named WINDOW clause (2022+)

When multiple window functions share the same partition and order, avoid repetition:

    SELECT
        OrderID,
        ROW_NUMBER() OVER Win           AS RowNum,
        SUM(TotalAmount) OVER Win       AS RunningTotal,
        LAG(TotalAmount) OVER Win       AS PrevAmount
    FROM Sales.Orders
    WINDOW Win AS (PARTITION BY CustomerID ORDER BY OrderDate);

## Date Math Patterns

### Bucketing

| Need | SQL Server 2022+ | Pre-2022 |
|------|-------------------|----------|
| Truncate to day | `DATETRUNC(day, col)` | `CAST(col AS DATE)` |
| Truncate to month | `DATETRUNC(month, col)` | `DATEFROMPARTS(YEAR(col), MONTH(col), 1)` |
| 15-minute buckets | `DATE_BUCKET(minute, 15, col)` | `DATEADD(minute, DATEDIFF(minute, 0, col)/15*15, 0)` |
| Custom week start | `DATE_BUCKET(week, 1, col, @origin)` | Manual DATEADD/DATEDIFF calculation |

### SARGable date filters

    -- GOOD: index seek
    WHERE OrderDate >= '2024-01-01' AND OrderDate < '2025-01-01'

    -- BAD: index scan (function on column)
    WHERE YEAR(OrderDate) = 2024

### Gap filling

LEFT JOIN from a continuous date spine (tally table or calendar table) to your sparse data. ISNULL replaces NULL with zero for missing dates:

    SELECT
        C.FullDate,
        ISNULL(SUM(O.TotalAmount), 0) AS Revenue
    FROM dbo.Calendar C
    LEFT JOIN Sales.Orders O ON CAST(O.OrderDate AS DATE) = C.FullDate
    WHERE C.Year = 2024
    GROUP BY C.FullDate
    ORDER BY C.FullDate;

**Full reference:** [Time Series](references/time-series.md) — calendar table design, fiscal calendars, cohort analysis, temporal table AS OF queries, moving averages.

## Tally Tables

Generate number sequences with zero I/O using the stacking CTE pattern:

    WITH
        L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
        L1 AS (SELECT 1 AS c FROM L0 CROSS JOIN L0 AS B),
        L2 AS (SELECT 1 AS c FROM L1 CROSS JOIN L1 AS B),
        L3 AS (SELECT 1 AS c FROM L2 CROSS JOIN L2 AS B),
        L4 AS (SELECT 1 AS c FROM L3 CROSS JOIN L3 AS B),
        Nums AS (
            SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS N
            FROM L4
        )
    SELECT N FROM Nums WHERE N <= @Count;

On SQL Server 2022+, use `GENERATE_SERIES(1, @Count)` for simpler syntax. Do not use recursive CTEs for number generation — they are row-by-row and 10-50x slower.

**Full reference:** [Tally Tables](references/tally-tables.md) — inline function wrapper, date range generation, gap filling, string splitting, permanent vs inline tradeoffs.

## Pivot & Unpivot

**Static PIVOT** (known columns):

    SELECT ProductName, [Q1], [Q2], [Q3], [Q4]
    FROM (...) AS Src
    PIVOT (SUM(Revenue) FOR Qtr IN ([Q1],[Q2],[Q3],[Q4])) AS Pvt;

**Dynamic PIVOT** (runtime columns): build with STRING_AGG + QUOTENAME + sp_executesql. QUOTENAME prevents SQL injection.

**Unpivot:** use CROSS APPLY VALUES instead of the UNPIVOT operator. UNPIVOT silently drops NULL rows; CROSS APPLY VALUES preserves them.

    CROSS APPLY (
        VALUES ('Q1', S.Q1), ('Q2', S.Q2), ('Q3', S.Q3), ('Q4', S.Q4)
    ) AS Q(Quarter, Revenue)

**Full reference:** [Pivot & Unpivot](references/pivot-unpivot.md) — dynamic PIVOT pattern, multi-column unpivot, conditional aggregation alternative.

## Gaps and Islands

Detecting consecutive sequences (islands) and breaks (gaps) in ordered data.

**Island detection** — the ROW_NUMBER difference technique:

    -- GroupKey is constant within each consecutive run
    DATEADD(day,
        -ROW_NUMBER() OVER (PARTITION BY SensorID ORDER BY ReadingDate),
        ReadingDate
    ) AS GroupKey

Group by GroupKey to find each island's start, end, and length.

**Gap detection** — LEAD to find the next value, then check for breaks:

    LEAD(OrderDay) OVER (ORDER BY OrderDay) AS NextDay
    -- Gap exists when NextDay - OrderDay > 1

**Full reference:** [Gaps and Islands](references/gaps-and-islands.md) — session analysis, status change tracking, date-based vs sequence-based patterns.

## Data Export

| Format | T-SQL | Notes |
|--------|-------|-------|
| JSON | `FOR JSON PATH` | Dot-notation aliases control nesting |
| XML | `FOR XML PATH` | Only when downstream requires XML (SOAP, EDI) |
| CSV column | `STRING_AGG(col, ',')` | WITHIN GROUP for ordering (2017+) |
| Bulk file | BCP / BULK INSERT | TABLOCK for columnstore direct-path |

**Full reference:** [Export Patterns](references/export-patterns.md) — FOR JSON nesting, JSON_OBJECT (2022+), Power BI DirectQuery optimization, BCP parameters.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Default window frame with ORDER BY (RANGE, not ROWS) | Always specify `ROWS BETWEEN ...` explicitly |
| Using RANGE for moving averages (includes ties) | Use `ROWS BETWEEN N PRECEDING AND CURRENT ROW` |
| YEAR(col) = 2024 in WHERE (kills seeks) | Range predicate: `col >= '2024-01-01' AND col < '2025-01-01'` |
| COUNT(column) when you want total rows | `COUNT(*)` includes NULLs; `COUNT(col)` excludes them |
| AVG ignoring NULL semantics | AVG uses COUNT(col) as denominator — use ISNULL(col, 0) if NULLs mean zero |
| UNPIVOT dropping NULL rows | Use CROSS APPLY VALUES to preserve NULLs |
| NOT IN with nullable subquery | Use NOT EXISTS — NOT IN silently returns nothing when subquery contains NULL |
| Recursive CTE for number generation | Use the stacking CTE pattern — set-based and 10-50x faster |
| FOR JSON AUTO in production | Use FOR JSON PATH — AUTO changes shape when aliases change |
| HAVING for non-aggregate filters | Move to WHERE — it filters before grouping, which is cheaper |
| FORMAT for date truncation | FORMAT is CLR-backed (10-50x slower) — use DATETRUNC (2022+) or DATEADD/DATEDIFF |
| LAST_VALUE without explicit frame | Default frame ends at CURRENT ROW — use `ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING` |
| LAG with fixed offset on sparse data | If periods are missing, LAG(val, 12) skips to the wrong year — use a self-join |

## Reference Files

| File | Topics |
|------|--------|
| [Aggregation Patterns](references/aggregation-patterns.md) | GROUPING SETS, ROLLUP, CUBE, conditional aggregation, HAVING vs WHERE, COUNT with NULLs |
| [Time Series](references/time-series.md) | Date bucketing, DATETRUNC, DATE_BUCKET, calendar tables, gap filling, YoY/MoM, moving averages, fiscal calendars, cohort analysis, temporal AS OF |
| [Tally Tables](references/tally-tables.md) | Stacking CTE pattern, GENERATE_SERIES, date ranges, gap filling, inline vs permanent |
| [Pivot & Unpivot](references/pivot-unpivot.md) | Static PIVOT, dynamic PIVOT with QUOTENAME, CROSS APPLY VALUES unpivot, multi-column unpivot |
| [Gaps and Islands](references/gaps-and-islands.md) | ROW_NUMBER difference, LAG/LEAD gaps, session analysis, status tracking, consecutive ranges |
| [Export Patterns](references/export-patterns.md) | FOR JSON, FOR XML, STRING_AGG, BCP/BULK INSERT, Power BI DirectQuery |

# Tally Tables


Generating number sequences and date ranges with zero I/O. The tally table (also called a numbers table) is the set-based alternative to loops and recursive CTEs for producing row sequences.

## Table of Contents

- [The Stacking CTE Pattern](#the-stacking-cte-pattern)
- [GENERATE_SERIES (2022+)](#generate_series-2022)
- [Date Range Generation](#date-range-generation)
- [Gap Filling](#gap-filling)
- [String Splitting (Pre-2016)](#string-splitting-pre-2016)
- [Inline vs Permanent Tally Table](#inline-vs-permanent-tally-table)
- [Why Not Recursive CTEs](#why-not-recursive-ctes)
- [Common Mistakes](#common-mistakes)
- [See Also](#see-also)

---

## The Stacking CTE Pattern


The standard technique for generating N rows with no table access[^1]. Cross-joins double the row count at each level — 4 levels produce 2^16 = 65,536 rows, 5 levels produce 2^32 = over 4 billion.

    -- Generate numbers 1 through N
    WITH
        L0 AS (SELECT 1 AS c UNION ALL SELECT 1),           -- 2 rows
        L1 AS (SELECT 1 AS c FROM L0 CROSS JOIN L0 AS B),   -- 4 rows
        L2 AS (SELECT 1 AS c FROM L1 CROSS JOIN L1 AS B),   -- 16 rows
        L3 AS (SELECT 1 AS c FROM L2 CROSS JOIN L2 AS B),   -- 256 rows
        L4 AS (SELECT 1 AS c FROM L3 CROSS JOIN L3 AS B),   -- 65,536 rows
        Nums AS (
            SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS N
            FROM L4
        )
    SELECT N
    FROM Nums
    WHERE N <= 1000;   -- limit to what you actually need

**Key properties:**
- **Zero I/O** — no table reads. The optimizer generates the rows in memory.
- **Set-based** — the entire result is produced as a single rowset, not row by row.
- **ORDER BY (SELECT NULL)** — tells the optimizer we do not care about order for ROW_NUMBER assignment. This avoids an unnecessary sort.
- **Filter with WHERE N <= @Count** — the optimizer is smart enough to stop generating rows beyond the filter.

### Reusable inline function

Wrap the pattern in an inline table-valued function for reuse[^6]:

    CREATE OR ALTER FUNCTION dbo.GetNums (@Count BIGINT)
    RETURNS TABLE
    AS RETURN
        WITH
            L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
            L1 AS (SELECT 1 AS c FROM L0 CROSS JOIN L0 AS B),
            L2 AS (SELECT 1 AS c FROM L1 CROSS JOIN L1 AS B),
            L3 AS (SELECT 1 AS c FROM L2 CROSS JOIN L2 AS B),
            L4 AS (SELECT 1 AS c FROM L3 CROSS JOIN L3 AS B),
            L5 AS (SELECT 1 AS c FROM L4 CROSS JOIN L4 AS B),
            Nums AS (
                SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS N
                FROM L5
            )
        SELECT N FROM Nums WHERE N <= @Count;

Usage:

    -- 365 rows for a year of dates
    SELECT N FROM dbo.GetNums(365);

    -- Generate sequence starting at 0
    SELECT N - 1 AS ZeroBased FROM dbo.GetNums(100);

---

## GENERATE_SERIES (2022+)


SQL Server 2022 introduced GENERATE_SERIES[^3] for integer and numeric ranges. It is simpler than the stacking CTE for basic number generation.

    -- Integers 1 through 10
    SELECT value FROM GENERATE_SERIES(1, 10);

    -- Even numbers 2 through 20
    SELECT value FROM GENERATE_SERIES(2, 20, 2);

    -- Countdown
    SELECT value FROM GENERATE_SERIES(10, 1, -1);

    -- Decimal steps
    SELECT value FROM GENERATE_SERIES(0.0, 1.0, 0.1);

**GENERATE_SERIES does not support date types directly.** For date ranges, combine with DATEADD:

    -- Generate dates for January 2024
    SELECT DATEADD(day, value, '2024-01-01') AS DateValue
    FROM GENERATE_SERIES(0, 30);

**When to prefer the stacking CTE:** on SQL Server 2019 and earlier (GENERATE_SERIES is 2022+ only), or when you need more than simple arithmetic sequences.

---

## Date Range Generation


The most common tally table application[^5]. Generate a continuous date spine for joining against sparse data.

    -- Date spine for a full year
    DECLARE @StartDate DATE = '2024-01-01';
    DECLARE @EndDate   DATE = '2024-12-31';

    WITH
        L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
        L1 AS (SELECT 1 AS c FROM L0 CROSS JOIN L0 AS B),
        L2 AS (SELECT 1 AS c FROM L1 CROSS JOIN L1 AS B),
        L3 AS (SELECT 1 AS c FROM L2 CROSS JOIN L2 AS B),
        L4 AS (SELECT 1 AS c FROM L3 CROSS JOIN L3 AS B),
        Nums AS (
            SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS N
            FROM L4
        )
    SELECT
        DATEADD(day, N, @StartDate) AS CalendarDate
    FROM Nums
    WHERE N <= DATEDIFF(day, @StartDate, @EndDate);

### With GENERATE_SERIES (2022+)

    SELECT DATEADD(day, value, @StartDate) AS CalendarDate
    FROM GENERATE_SERIES(0, DATEDIFF(day, @StartDate, @EndDate));

### Recursive CTE alternative (not recommended for large ranges)

    WITH DateSpine AS (
        SELECT @StartDate AS CalendarDate
        UNION ALL
        SELECT DATEADD(day, 1, CalendarDate)
        FROM DateSpine
        WHERE CalendarDate < @EndDate
    )
    SELECT CalendarDate FROM DateSpine
    OPTION (MAXRECURSION 400);

This works but is row-by-row (RBAR) internally and requires MAXRECURSION for ranges over 100 days. Use the stacking CTE or GENERATE_SERIES instead.

---

## Gap Filling


Join a continuous date spine to sparse data to expose dates with no activity. This is essential for time-series charts that need zero values instead of missing points.

    -- Daily revenue with zero-fill for days with no orders
    WITH
        L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
        L1 AS (SELECT 1 AS c FROM L0 CROSS JOIN L0 AS B),
        L2 AS (SELECT 1 AS c FROM L1 CROSS JOIN L1 AS B),
        L3 AS (SELECT 1 AS c FROM L2 CROSS JOIN L2 AS B),
        L4 AS (SELECT 1 AS c FROM L3 CROSS JOIN L3 AS B),
        Nums AS (
            SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS N
            FROM L4
        ),
        DateSpine AS (
            SELECT DATEADD(day, N, '2024-01-01') AS CalendarDate
            FROM Nums
            WHERE N <= DATEDIFF(day, '2024-01-01', '2024-12-31')
        )
    SELECT
        D.CalendarDate,
        ISNULL(SUM(O.TotalAmount), 0) AS DailyRevenue,
        COUNT(O.OrderID)              AS OrderCount
    FROM DateSpine D
    LEFT JOIN Sales.Orders O
        ON CAST(O.OrderDate AS DATE) = D.CalendarDate
    GROUP BY D.CalendarDate
    ORDER BY D.CalendarDate;

**The pattern:** LEFT JOIN from the complete spine to the sparse data. ISNULL (or COALESCE) replaces NULL with zero for dates with no matching rows.

### Gap filling with a permanent calendar table

If you gap-fill frequently, a permanent calendar table is more efficient than regenerating the spine each time. See [Time Series — Calendar Tables](time-series.md#calendar-tables) for the design pattern.

---

## String Splitting (Pre-2016)


Before STRING_SPLIT (SQL Server 2016), tally tables were the set-based way to split delimited strings. Each number in the sequence identifies a character position; CHARINDEX locates delimiters.

    -- Split a comma-delimited string using a tally table
    DECLARE @List NVARCHAR(MAX) = N'Alice,Bob,Carol,Dave';

    WITH
        L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
        L1 AS (SELECT 1 AS c FROM L0 CROSS JOIN L0 AS B),
        L2 AS (SELECT 1 AS c FROM L1 CROSS JOIN L1 AS B),
        L3 AS (SELECT 1 AS c FROM L2 CROSS JOIN L2 AS B),
        Nums AS (
            SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS N
            FROM L3
        )
    SELECT
        SUBSTRING(
            @List,
            N,
            ISNULL(
                NULLIF(CHARINDEX(',', @List, N), 0) - N,
                LEN(@List) - N + 1
            )
        ) AS Value
    FROM Nums
    WHERE N <= LEN(@List)
      AND (N = 1 OR SUBSTRING(@List, N - 1, 1) = ',');

**On SQL Server 2016+, use STRING_SPLIT.** On SQL Server 2022+, use STRING_SPLIT with the ordinal parameter for ordered output. The tally-based splitter is a legacy pattern.

---

## Inline vs Permanent Tally Table


### Inline (CTE-based)

- No storage cost
- No maintenance
- Zero I/O — rows generated in memory
- Suitable for ad-hoc queries and functions

### Permanent (physical table)

    -- Create a permanent numbers table
    CREATE TABLE dbo.Numbers (N INT NOT NULL PRIMARY KEY CLUSTERED);

    -- Seed using the stacking CTE pattern
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
    INSERT INTO dbo.Numbers (N)
    SELECT N FROM Nums WHERE N <= 65536;

Benefits of a permanent table:
- The optimizer knows the exact row count (accurate cardinality estimates)
- Can be indexed for complex join patterns
- Simpler queries — no CTE preamble

**When to choose permanent:** the numbers table is used frequently across many queries, or the optimizer needs accurate statistics for cost-based decisions. For one-off reporting queries, inline CTEs are sufficient.

---

## Why Not Recursive CTEs


Recursive CTEs for number generation are Row-By-Agonizing-Row (RBAR)[^4]. Each recursion step adds one row, with context switching between iterations.

    -- SLOW: recursive CTE generates 1000 rows one at a time
    WITH Nums AS (
        SELECT 1 AS N
        UNION ALL
        SELECT N + 1 FROM Nums WHERE N < 1000
    )
    SELECT N FROM Nums
    OPTION (MAXRECURSION 1000);

The stacking CTE pattern produces the same 1000 rows as a single set operation — no recursion, no per-row overhead, no MAXRECURSION worries (the 100-row default limit does not apply because there is no recursion).

**Performance comparison:** for generating 100,000 rows, the stacking CTE is typically 10-50x faster than a recursive CTE[^2], depending on hardware. The gap widens with larger row counts.

Recursive CTEs are the right tool for hierarchical traversal (org charts, bill of materials) where each level depends on the previous. They are the wrong tool for generating flat sequences.

---

## Common Mistakes


| Mistake | Fix |
|---------|-----|
| Using recursive CTE for number generation | Use the stacking CTE pattern — it is set-based and faster |
| Forgetting WHERE N <= @Count on the tally CTE | Without a limit, the CTE generates its full capacity (65K or 4B rows) |
| Using ORDER BY (SELECT 1) instead of (SELECT NULL) | Both work, but (SELECT NULL) is the convention and avoids confusion with actual ordering |
| Generating dates with a WHILE loop | Use DATEADD with a tally CTE or GENERATE_SERIES |
| MAXRECURSION errors with recursive date spines | Switch to the stacking CTE pattern — no recursion limit applies |
| Not considering a permanent tally table for heavy use | If the pattern appears in many queries, a physical Numbers table gives the optimizer better statistics |

---

## See Also


- [Time Series](time-series.md) — calendar tables and gap-filling patterns that use tally-generated date ranges
- [Gaps and Islands](gaps-and-islands.md) — detecting missing values in sequences
- [Aggregation Patterns](aggregation-patterns.md) — summarizing data over tally-generated ranges

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.


[^1]: [Number Series Challenge — SQLPerformance.com](https://sqlperformance.com/2020/12/t-sql-queries/number-series-challenge) — Itzik Ben-Gan's analysis of number generation techniques including the stacking CTE pattern and performance comparisons
[^2]: [Number Series Solutions Part 1 — SQLPerformance.com](https://sqlperformance.com/2021/01/t-sql-queries/number-series-solutions-1) — detailed solutions and benchmarks for the number series challenge; demonstrates optimization techniques for cascading CTE-based number generation
[^3]: [GENERATE_SERIES (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/generate-series-transact-sql) — GENERATE_SERIES for integer and numeric ranges (SQL Server 2022+); date series require combining with DATEADD
[^4]: [Hidden RBAR: Counting with Recursive CTEs — SQLServerCentral](https://www.sqlservercentral.com/articles/hidden-rbar-counting-with-recursive-ctes) — Jeff Moden's analysis of why recursive CTEs for number generation are row-by-row (RBAR) despite appearing set-based
[^5]: [Tally Tables in T-SQL — SQLServerCentral](https://www.sqlservercentral.com/blogs/tally-tables-in-t-sql) — overview of tally tables including creation methods and string splitting applications
[^6]: [T-SQL Fundamentals, 4th Edition](https://www.microsoftpressstore.com/store/t-sql-fundamentals-9780138102104) — Itzik Ben-Gan (Microsoft Press, 2023, ISBN 978-0138102104); covers CTE-based number generation and GENERATE_SERIES

# Gaps and Islands


Detecting consecutive sequences (islands) and breaks between them (gaps) in ordered data[^1]. These patterns solve session analysis, streak detection, consecutive date ranges, and status change tracking.

## Table of Contents

- [The Core Problem](#the-core-problem)
- [Island Detection: ROW_NUMBER Difference](#island-detection-row_number-difference)
- [Island Detection: LAG Comparison](#island-detection-lag-comparison)
- [Gap Detection: LAG/LEAD](#gap-detection-laglead)
- [Date-Based Islands](#date-based-islands)
- [Sequence-Based Islands](#sequence-based-islands)
- [Session Analysis](#session-analysis)
- [Status Change Tracking](#status-change-tracking)
- [Common Mistakes](#common-mistakes)
- [See Also](#see-also)

---

## The Core Problem


Given ordered data, identify:
- **Islands** — consecutive runs where a condition holds (e.g., consecutive days with sales, consecutive months of activity, consecutive readings above a threshold)
- **Gaps** — breaks between islands (e.g., days with no sales, missing sequence numbers, periods of inactivity)

The key insight: in a consecutive sequence, the difference between the value and its row number is constant[^5]. When the sequence breaks, the difference changes.

---

## Island Detection: ROW_NUMBER Difference


The classic technique[^1]. For each row, compute the difference between the data value and a ROW_NUMBER. Within a consecutive island, this difference is constant. Group by the difference to identify each island.

    -- Find consecutive date ranges with sensor readings
    WITH Grouped AS (
        SELECT
            SensorID,
            ReadingDate,
            DATEADD(day,
                -ROW_NUMBER() OVER (
                    PARTITION BY SensorID
                    ORDER BY ReadingDate
                ),
                ReadingDate
            ) AS GroupKey
        FROM Sensors.DailyReadings
    )
    SELECT
        SensorID,
        MIN(ReadingDate) AS IslandStart,
        MAX(ReadingDate) AS IslandEnd,
        COUNT(*)         AS ConsecutiveDays
    FROM Grouped
    GROUP BY SensorID, GroupKey
    ORDER BY SensorID, IslandStart;

**How it works step by step:**

Consider dates 2024-01-01, 2024-01-02, 2024-01-03, 2024-01-05, 2024-01-06:

| ReadingDate | ROW_NUMBER | Date - RowNum | Island? |
|------------|------------|---------------|---------|
| 2024-01-01 | 1 | 2023-12-31 | Island 1 |
| 2024-01-02 | 2 | 2023-12-31 | Island 1 |
| 2024-01-03 | 3 | 2023-12-31 | Island 1 |
| 2024-01-05 | 4 | 2024-01-01 | Island 2 |
| 2024-01-06 | 5 | 2024-01-01 | Island 2 |

The first three rows share the same GroupKey (2023-12-31), forming one island. After the gap on Jan 4, the GroupKey shifts to 2024-01-01, starting a new island.

### With integer sequences

For integer sequences (order numbers, ticket IDs), subtract ROW_NUMBER directly:

    WITH Grouped AS (
        SELECT
            SequenceNo,
            SequenceNo - ROW_NUMBER() OVER (ORDER BY SequenceNo) AS GroupKey
        FROM Production.CompletedSteps
    )
    SELECT
        MIN(SequenceNo) AS RangeStart,
        MAX(SequenceNo) AS RangeEnd,
        COUNT(*)        AS RangeLength
    FROM Grouped
    GROUP BY GroupKey
    ORDER BY RangeStart;

---

## Island Detection: LAG Comparison


An alternative that uses LAG to detect where islands begin, then assigns island IDs with a running sum[^2].

    WITH Boundaries AS (
        SELECT
            SensorID,
            ReadingDate,
            CASE
                WHEN DATEADD(day, -1, ReadingDate) =
                     LAG(ReadingDate) OVER (
                         PARTITION BY SensorID
                         ORDER BY ReadingDate
                     )
                THEN 0
                ELSE 1
            END AS IsNewIsland
        FROM Sensors.DailyReadings
    ),
    Islands AS (
        SELECT
            SensorID,
            ReadingDate,
            SUM(IsNewIsland) OVER (
                PARTITION BY SensorID
                ORDER BY ReadingDate
                ROWS UNBOUNDED PRECEDING
            ) AS IslandID
        FROM Boundaries
    )
    SELECT
        SensorID,
        IslandID,
        MIN(ReadingDate) AS IslandStart,
        MAX(ReadingDate) AS IslandEnd,
        COUNT(*)         AS ConsecutiveDays
    FROM Islands
    GROUP BY SensorID, IslandID
    ORDER BY SensorID, IslandStart;

**When to prefer LAG over ROW_NUMBER:** when the definition of "consecutive" is not simply +1. For example, consecutive business days (skipping weekends), or consecutive values within a tolerance range. LAG gives you full control over the adjacency test.

---

## Gap Detection: LAG/LEAD


Find the breaks between consecutive values using LEAD to look ahead.

    -- Find gaps in daily order data
    WITH OrderDates AS (
        SELECT DISTINCT CAST(OrderDate AS DATE) AS OrderDay
        FROM Sales.Orders
        WHERE OrderDate >= '2024-01-01'
          AND OrderDate <  '2025-01-01'
    )
Window functions cannot appear in WHERE[^4]. A naive attempt like this will fail:

    -- INVALID: window functions are not allowed in WHERE
    SELECT OrderDay
    FROM OrderDates
    WHERE LEAD(OrderDay) OVER (ORDER BY OrderDay) - OrderDay > 1;

Wrap the window function in a CTE or subquery first:

    WITH OrderDates AS (
        SELECT DISTINCT CAST(OrderDate AS DATE) AS OrderDay
        FROM Sales.Orders
        WHERE OrderDate >= '2024-01-01'
          AND OrderDate <  '2025-01-01'
    ),
    WithNext AS (
        SELECT
            OrderDay,
            LEAD(OrderDay) OVER (ORDER BY OrderDay) AS NextDay
        FROM OrderDates
    )
    SELECT
        OrderDay    AS LastDayBeforeGap,
        NextDay     AS FirstDayAfterGap,
        DATEDIFF(day, OrderDay, NextDay) - 1 AS GapDays
    FROM WithNext
    WHERE DATEDIFF(day, OrderDay, NextDay) > 1
    ORDER BY OrderDay;

### Gap detection in integer sequences

    WITH WithNext AS (
        SELECT
            InvoiceNo,
            LEAD(InvoiceNo) OVER (ORDER BY InvoiceNo) AS NextInvoiceNo
        FROM Billing.Invoices
    )
    SELECT
        InvoiceNo      AS LastBeforeGap,
        NextInvoiceNo  AS FirstAfterGap,
        NextInvoiceNo - InvoiceNo - 1 AS MissingCount
    FROM WithNext
    WHERE NextInvoiceNo - InvoiceNo > 1
    ORDER BY InvoiceNo;

---

## Date-Based Islands


Find consecutive date ranges where a condition holds. This is the most common reporting use case — active subscription periods, consecutive days of inventory, streaks.

    -- Customer purchase streaks: consecutive months with at least one order
    WITH MonthlyActivity AS (
        SELECT DISTINCT
            CustomerID,
            DATEFROMPARTS(YEAR(OrderDate), MONTH(OrderDate), 1) AS ActivityMonth
        FROM Sales.Orders
    ),
    Grouped AS (
        SELECT
            CustomerID,
            ActivityMonth,
            DATEADD(month,
                -ROW_NUMBER() OVER (
                    PARTITION BY CustomerID
                    ORDER BY ActivityMonth
                ),
                ActivityMonth
            ) AS GroupKey
        FROM MonthlyActivity
    )
    SELECT
        CustomerID,
        MIN(ActivityMonth) AS StreakStart,
        MAX(ActivityMonth) AS StreakEnd,
        COUNT(*)           AS ConsecutiveMonths
    FROM Grouped
    GROUP BY CustomerID, GroupKey
    HAVING COUNT(*) >= 3    -- only streaks of 3+ months
    ORDER BY ConsecutiveMonths DESC;

---

## Sequence-Based Islands


Find consecutive ranges in numbered sequences (batch IDs, ticket numbers, version numbers).

    -- Find ranges of consecutive completed batch numbers
    WITH Grouped AS (
        SELECT
            BatchNo,
            BatchNo - ROW_NUMBER() OVER (ORDER BY BatchNo) AS GroupKey
        FROM Manufacturing.Batches
        WHERE Status = 'Complete'
    )
    SELECT
        MIN(BatchNo) AS RangeStart,
        MAX(BatchNo) AS RangeEnd,
        MAX(BatchNo) - MIN(BatchNo) + 1 AS RangeSize
    FROM Grouped
    GROUP BY GroupKey
    ORDER BY RangeStart;

### Display as ranges

    -- Output: "1-5, 8-12, 15, 20-22"
    WITH Grouped AS (
        SELECT
            BatchNo,
            BatchNo - ROW_NUMBER() OVER (ORDER BY BatchNo) AS GroupKey
        FROM Manufacturing.Batches
        WHERE Status = 'Complete'
    ),
    Ranges AS (
        SELECT
            MIN(BatchNo) AS RangeStart,
            MAX(BatchNo) AS RangeEnd
        FROM Grouped
        GROUP BY GroupKey
    )
    SELECT STRING_AGG(
        CASE
            WHEN RangeStart = RangeEnd
            THEN CAST(RangeStart AS VARCHAR)
            ELSE CAST(RangeStart AS VARCHAR) + '-' + CAST(RangeEnd AS VARCHAR)
        END,
        ', '
    ) WITHIN GROUP (ORDER BY RangeStart) AS CompletedRanges
    FROM Ranges;

---

## Session Analysis


Identify user sessions by grouping events that are close together in time[^3]. Events more than N minutes apart belong to different sessions.

    -- Web analytics: group page views into sessions (30-minute timeout)
    WITH EventBoundaries AS (
        SELECT
            UserID,
            EventTime,
            CASE
                WHEN DATEDIFF(minute,
                    LAG(EventTime) OVER (
                        PARTITION BY UserID
                        ORDER BY EventTime
                    ),
                    EventTime
                ) > 30
                OR LAG(EventTime) OVER (
                    PARTITION BY UserID
                    ORDER BY EventTime
                ) IS NULL
                THEN 1
                ELSE 0
            END AS IsNewSession
        FROM WebAnalytics.PageViews
    ),
    SessionIDs AS (
        SELECT
            UserID,
            EventTime,
            SUM(IsNewSession) OVER (
                PARTITION BY UserID
                ORDER BY EventTime
                ROWS UNBOUNDED PRECEDING
            ) AS SessionNo
        FROM EventBoundaries
    )
    SELECT
        UserID,
        SessionNo,
        MIN(EventTime) AS SessionStart,
        MAX(EventTime) AS SessionEnd,
        DATEDIFF(minute, MIN(EventTime), MAX(EventTime)) AS DurationMinutes,
        COUNT(*)       AS PageViews
    FROM SessionIDs
    GROUP BY UserID, SessionNo
    ORDER BY UserID, SessionNo;

---

## Status Change Tracking


Find periods when an entity was in each status — useful for SLA reporting and time-in-state analysis.

    -- How long was each order in each status?
    WITH StatusPeriods AS (
        SELECT
            OrderID,
            Status,
            ChangedAt AS PeriodStart,
            LEAD(ChangedAt) OVER (
                PARTITION BY OrderID
                ORDER BY ChangedAt
            ) AS PeriodEnd
        FROM Sales.OrderStatusHistory
    )
    SELECT
        OrderID,
        Status,
        PeriodStart,
        ISNULL(PeriodEnd, SYSUTCDATETIME()) AS PeriodEnd,
        DATEDIFF(minute, PeriodStart,
            ISNULL(PeriodEnd, SYSUTCDATETIME())
        ) AS MinutesInStatus
    FROM StatusPeriods
    ORDER BY OrderID, PeriodStart;

The last status for each order has PeriodEnd = NULL (no subsequent change). ISNULL substitutes the current time, meaning the order is still in that status.

---

## Common Mistakes


| Mistake | Fix |
|---------|-----|
| Forgetting PARTITION BY when multiple entities share the same sequence | Always partition by the entity identifier (CustomerID, SensorID) |
| Using ROW_NUMBER difference for non-unit gaps (e.g., business days) | Use LAG comparison with custom adjacency logic |
| Filtering on window function results in WHERE | Wrap in a CTE or subquery — window functions cannot appear in WHERE |
| Not handling the first row (LAG returns NULL) | Use IS NULL check to mark the first row as a new island |
| Assuming ordered results without ORDER BY | Always specify ORDER BY in the outer query — window function ORDER BY only affects the window, not the result order |

---

## See Also


- [Tally Tables](tally-tables.md) — generating date ranges and number sequences used in gap-filling
- [Time Series](time-series.md) — gap filling with calendar tables and moving averages
- [Aggregation Patterns](aggregation-patterns.md) — summarizing island and gap data with GROUP BY

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.


[^1]: [Introduction to Gaps and Islands Analysis — Red Gate Simple Talk](https://www.red-gate.com/simple-talk/databases/sql-server/t-sql-programming-sql-server/introduction-to-gaps-and-islands-analysis/) — comprehensive introduction to the ROW_NUMBER difference technique and LAG/LEAD gap detection
[^2]: [Efficient Solutions to Gaps and Islands Challenges — Red Gate Simple Talk](https://www.red-gate.com/simple-talk/databases/sql-server/t-sql-programming-sql-server/efficient-solutions-to-gaps-and-islands-challenges/) — performance-focused solutions for gaps and islands problems in T-SQL
[^3]: [T-SQL: Gaps and Islands Problem — Microsoft TechNet](https://learn.microsoft.com/en-us/archive/technet-wiki/18399.t-sql-gaps-and-islands-problem) — Microsoft TechNet wiki article covering the classic gaps and islands techniques
[^4]: [OVER Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-over-clause-transact-sql) — OVER clause syntax for partitioning, ordering, and framing; demonstrates ROW_NUMBER and SUM OVER directly (LAG/LEAD documented on their own pages)
[^5]: [T-SQL Querying](https://www.microsoftpressstore.com/store/t-sql-querying-9780735685048) — Itzik Ben-Gan, Adam Machanic, Dejan Sarka, Kevin Farlee (Microsoft Press, 2015, ISBN 978-0735685048); gaps and islands section in Chapter 4 (Grouping, Pivoting, and Windowing) with multiple solution approaches

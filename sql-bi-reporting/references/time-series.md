# Time Series


Date bucketing, calendar tables, gap filling, period-over-period comparisons, moving averages, fiscal calendars, and temporal table queries for point-in-time reporting.

## Table of Contents

- [Date Bucketing](#date-bucketing)
- [DATE_BUCKET (2022+)](#date_bucket-2022)
- [Calendar Tables](#calendar-tables)
- [Gap Filling](#gap-filling)
- [Year-over-Year and Period Comparisons](#year-over-year-and-period-comparisons)
- [Moving Averages](#moving-averages)
- [Cumulative Totals](#cumulative-totals)
- [Fiscal Calendars](#fiscal-calendars)
- [Cohort Analysis](#cohort-analysis)
- [Temporal Table Queries (AS OF)](#temporal-table-queries-as-of)
- [Common Mistakes](#common-mistakes)
- [See Also](#see-also)

---

## Date Bucketing


Truncate timestamps to a fixed interval for time-series aggregation. The pattern uses DATEADD/DATEDIFF to snap a datetime to the nearest bucket boundary.

### DATETRUNC (2022+)

SQL Server 2022 added DATETRUNC[^2] for simple truncation to natural boundaries:

    DATETRUNC(hour, EventTime)      -- truncate to hour
    DATETRUNC(day, EventTime)       -- truncate to day
    DATETRUNC(month, EventTime)     -- truncate to month start
    DATETRUNC(quarter, EventTime)   -- truncate to quarter start
    DATETRUNC(year, EventTime)      -- truncate to year start

DATETRUNC is cleaner than the DATEADD/DATEDIFF pattern for standard boundaries. Use DATE_BUCKET for arbitrary intervals (15 minutes, 4 hours). Use the DATEADD/DATEDIFF pattern on pre-2022 servers.

### The DATEADD/DATEDIFF trick (pre-2022)[^3][^4]

    -- Truncate to hour
    DATEADD(hour, DATEDIFF(hour, 0, EventTime), 0)

    -- Truncate to day (remove time component)
    CAST(EventTime AS DATE)

    -- Truncate to month start
    DATEFROMPARTS(YEAR(EventTime), MONTH(EventTime), 1)

    -- Truncate to quarter start
    DATEFROMPARTS(YEAR(EventTime),
        (DATEPART(quarter, EventTime) - 1) * 3 + 1, 1)

    -- Truncate to year start
    DATEFROMPARTS(YEAR(EventTime), 1, 1)

**How it works:** DATEDIFF counts the number of interval boundaries crossed between a fixed origin (0 = 1900-01-01) and the target datetime. DATEADD adds that count back from the origin, producing a datetime aligned to the boundary.[^7]

### Arbitrary intervals

For intervals that do not align with standard dateparts (5 minutes, 15 minutes, 4 hours):

    -- 5-minute buckets
    DATEADD(minute,
        DATEDIFF(minute, 0, EventTime) / 5 * 5,
        0
    )

    -- 15-minute buckets
    DATEADD(minute,
        DATEDIFF(minute, 0, EventTime) / 15 * 15,
        0
    )

    -- 4-hour buckets
    DATEADD(hour,
        DATEDIFF(hour, 0, EventTime) / 4 * 4,
        0
    )

### Practical example

    -- Sensor readings aggregated to 15-minute intervals
    SELECT
        DATEADD(minute,
            DATEDIFF(minute, 0, ReadingTime) / 15 * 15,
            0
        ) AS Bucket,
        AVG(Temperature)  AS AvgTemp,
        MIN(Temperature)  AS MinTemp,
        MAX(Temperature)  AS MaxTemp,
        COUNT(*)          AS ReadingCount
    FROM Sensors.Readings
    WHERE ReadingTime >= '2024-06-01'
      AND ReadingTime <  '2024-06-02'
    GROUP BY DATEADD(minute,
        DATEDIFF(minute, 0, ReadingTime) / 15 * 15,
        0
    )
    ORDER BY Bucket;

---

## DATE_BUCKET (2022+)


SQL Server 2022 introduced DATE_BUCKET[^1] as a cleaner syntax for the DATEADD/DATEDIFF bucketing pattern.

    -- 15-minute buckets
    SELECT
        DATE_BUCKET(minute, 15, ReadingTime) AS Bucket,
        AVG(Temperature) AS AvgTemp
    FROM Sensors.Readings
    GROUP BY DATE_BUCKET(minute, 15, ReadingTime)
    ORDER BY Bucket;

    -- Weekly buckets starting on Monday
    SELECT
        DATE_BUCKET(week, 1, OrderDate, '2024-01-01') AS WeekStart,
        SUM(TotalAmount) AS WeeklyRevenue
    FROM Sales.Orders
    GROUP BY DATE_BUCKET(week, 1, OrderDate, '2024-01-01')
    ORDER BY WeekStart;

Syntax: `DATE_BUCKET(datepart, number, date [, origin])`

The optional origin parameter sets the anchor point for bucket alignment. Without it, buckets align to 1900-01-01 00:00:00.

**Availability:** SQL Server 2022 and Azure SQL Database.[^8] Use the DATEADD/DATEDIFF pattern on earlier versions.

---

## Calendar Tables


A permanent date dimension table provides human-readable attributes (day name, month name, fiscal period, holiday flags) and acts as a backbone for gap-filling and joins.[^9]

### Design

    CREATE TABLE dbo.Calendar (
        DateKey       INT           NOT NULL PRIMARY KEY,   -- YYYYMMDD
        FullDate      DATE          NOT NULL UNIQUE,
        Year          SMALLINT      NOT NULL,
        Quarter       TINYINT       NOT NULL,
        Month         TINYINT       NOT NULL,
        MonthName     VARCHAR(10)   NOT NULL,
        Day           TINYINT       NOT NULL,
        DayOfWeek     TINYINT       NOT NULL,   -- 1=Monday, 7=Sunday
        DayName       VARCHAR(10)   NOT NULL,
        WeekOfYear    TINYINT       NOT NULL,
        ISOWeek       TINYINT       NOT NULL,
        IsWeekend     BIT           NOT NULL,
        IsHoliday     BIT           NOT NULL DEFAULT 0,
        HolidayName   VARCHAR(50)   NULL,
        FiscalYear    SMALLINT      NOT NULL,
        FiscalQuarter TINYINT       NOT NULL,
        FiscalMonth   TINYINT       NOT NULL
    );

### Seeding with a tally table

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
        Dates AS (
            SELECT DATEADD(day, N, '2020-01-01') AS D
            FROM Nums
            WHERE N <= DATEDIFF(day, '2020-01-01', '2030-12-31')
        )
    INSERT INTO dbo.Calendar (
        DateKey, FullDate, Year, Quarter, Month, MonthName,
        Day, DayOfWeek, DayName, WeekOfYear, ISOWeek,
        IsWeekend, FiscalYear, FiscalQuarter, FiscalMonth
    )
    SELECT
        YEAR(D) * 10000 + MONTH(D) * 100 + DAY(D),
        D,
        YEAR(D),
        DATEPART(quarter, D),
        MONTH(D),
        DATENAME(month, D),
        DAY(D),
        (DATEPART(weekday, D) + @@DATEFIRST + 5) % 7 + 1,  -- Monday=1
        DATENAME(weekday, D),
        DATEPART(week, D),
        DATEPART(iso_week, D),
        CASE WHEN (DATEPART(weekday, D) + @@DATEFIRST + 5) % 7 + 1 >= 6
             THEN 1 ELSE 0 END,
        -- Fiscal year starting July 1
        CASE WHEN MONTH(D) >= 7
             THEN YEAR(D) + 1 ELSE YEAR(D) END,
        CASE WHEN MONTH(D) >= 7
             THEN (MONTH(D) - 7) / 3 + 1
             ELSE (MONTH(D) + 5) / 3 + 1 END,
        CASE WHEN MONTH(D) >= 7
             THEN MONTH(D) - 6 ELSE MONTH(D) + 6 END
    FROM Dates;

### Joining to the calendar

    -- Monthly revenue with month names for display
    SELECT
        C.Year,
        C.MonthName,
        SUM(O.TotalAmount) AS Revenue
    FROM dbo.Calendar C
    LEFT JOIN Sales.Orders O
        ON O.OrderDate >= C.FullDate
       AND O.OrderDate <  DATEADD(day, 1, C.FullDate)
    WHERE C.Year = 2024
    GROUP BY C.Year, C.Month, C.MonthName
    ORDER BY C.Month;

### Business days calculation

    -- Count business days between two dates
    SELECT COUNT(*) AS BusinessDays
    FROM dbo.Calendar
    WHERE FullDate >= '2024-01-15'
      AND FullDate <  '2024-02-15'
      AND IsWeekend = 0
      AND IsHoliday = 0;

---

## Gap Filling


LEFT JOIN from a complete time spine to sparse data, substituting zero or NULL for missing periods.

    -- Daily revenue with zero-fill
    SELECT
        C.FullDate,
        ISNULL(SUM(O.TotalAmount), 0) AS DailyRevenue,
        COUNT(O.OrderID)              AS OrderCount
    FROM dbo.Calendar C
    LEFT JOIN Sales.Orders O
        ON O.OrderDate >= C.FullDate
       AND O.OrderDate <  DATEADD(day, 1, C.FullDate)
    WHERE C.FullDate >= '2024-01-01'
      AND C.FullDate <  '2025-01-01'
    GROUP BY C.FullDate
    ORDER BY C.FullDate;

Without the calendar table, days with no orders would simply be missing from the result. The LEFT JOIN ensures every date appears, and ISNULL converts the missing aggregation to zero.

For gap filling without a permanent calendar table, generate the spine inline. See [Tally Tables — Gap Filling](tally-tables.md#gap-filling).

---

## Year-over-Year and Period Comparisons


### YoY with LAG

    -- Monthly revenue with prior year comparison
    WITH MonthlyRevenue AS (
        SELECT
            YEAR(OrderDate)  AS OrderYear,
            MONTH(OrderDate) AS OrderMonth,
            SUM(TotalAmount) AS Revenue
        FROM Sales.Orders
        GROUP BY YEAR(OrderDate), MONTH(OrderDate)
    )
    SELECT
        OrderYear,
        OrderMonth,
        Revenue,
        LAG(Revenue, 12) OVER (ORDER BY OrderYear, OrderMonth) AS PriorYearRevenue,
        Revenue - LAG(Revenue, 12) OVER (ORDER BY OrderYear, OrderMonth) AS YoYChange,
        CASE
            WHEN LAG(Revenue, 12) OVER (ORDER BY OrderYear, OrderMonth) > 0
            THEN (Revenue - LAG(Revenue, 12) OVER (ORDER BY OrderYear, OrderMonth))
                 * 100.0 / LAG(Revenue, 12) OVER (ORDER BY OrderYear, OrderMonth)
        END AS YoYPctChange
    FROM MonthlyRevenue
    ORDER BY OrderYear, OrderMonth;

LAG with offset 12 reaches back 12 rows — since the data is monthly, that is one year. This avoids a self-join.[^10]

### YoY with self-join (when LAG offset is unreliable)

When there are gaps in the monthly data (some months may have no rows), LAG by a fixed offset is incorrect. Use a self-join instead:

    WITH MonthlyRevenue AS (
        SELECT
            YEAR(OrderDate)  AS OrderYear,
            MONTH(OrderDate) AS OrderMonth,
            SUM(TotalAmount) AS Revenue
        FROM Sales.Orders
        GROUP BY YEAR(OrderDate), MONTH(OrderDate)
    )
    SELECT
        Cur.OrderYear,
        Cur.OrderMonth,
        Cur.Revenue                AS CurrentRevenue,
        Prev.Revenue               AS PriorYearRevenue,
        Cur.Revenue - Prev.Revenue AS YoYChange
    FROM MonthlyRevenue Cur
    LEFT JOIN MonthlyRevenue Prev
        ON Prev.OrderYear  = Cur.OrderYear - 1
       AND Prev.OrderMonth = Cur.OrderMonth
    ORDER BY Cur.OrderYear, Cur.OrderMonth;

### Month-over-month

    LAG(Revenue, 1) OVER (ORDER BY OrderYear, OrderMonth)

Same pattern with offset 1 instead of 12.

---

## Moving Averages


Sliding window aggregation for smoothing noisy time-series data.

    -- 7-day moving average of daily revenue
    SELECT
        OrderDate,
        DailyRevenue,
        AVG(DailyRevenue) OVER (
            ORDER BY OrderDate
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS MovingAvg7Day,
        SUM(DailyRevenue) OVER (
            ORDER BY OrderDate
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS Rolling7DayTotal
    FROM (
        SELECT
            CAST(OrderDate AS DATE) AS OrderDate,
            SUM(TotalAmount)        AS DailyRevenue
        FROM Sales.Orders
        GROUP BY CAST(OrderDate AS DATE)
    ) AS Daily
    ORDER BY OrderDate;

**ROWS vs RANGE:** always use ROWS for moving averages.[^5] RANGE includes all ties (rows with the same ORDER BY value), which inflates the window on days with duplicate values. ROWS counts exactly N physical rows.

**Frame spec:** `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` includes the current row plus the 6 rows before it — a 7-row window. For a 30-day average, use `ROWS BETWEEN 29 PRECEDING AND CURRENT ROW`.

### Centered moving average

    -- Smoothing that looks both forward and backward
    AVG(DailyRevenue) OVER (
        ORDER BY OrderDate
        ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
    ) AS CenteredAvg7Day

This is a 7-day centered average (3 days before, current day, 3 days after). Useful for trend analysis where you do not need real-time responsiveness.

---

## Cumulative Totals


Running sums that grow from the start of a period.

    -- Year-to-date revenue by month
    WITH MonthlyRevenue AS (
        SELECT
            DATEFROMPARTS(YEAR(OrderDate), MONTH(OrderDate), 1) AS MonthStart,
            SUM(TotalAmount) AS Revenue
        FROM Sales.Orders
        WHERE YEAR(OrderDate) = 2024
        GROUP BY YEAR(OrderDate), MONTH(OrderDate)
    )
    SELECT
        MonthStart,
        Revenue,
        SUM(Revenue) OVER (
            ORDER BY MonthStart
            ROWS UNBOUNDED PRECEDING
        ) AS YTDRevenue
    FROM MonthlyRevenue
    ORDER BY MonthStart;

For YTD within fiscal years, add PARTITION BY FiscalYear:

    SUM(Revenue) OVER (
        PARTITION BY FiscalYear
        ORDER BY MonthStart
        ROWS UNBOUNDED PRECEDING
    ) AS FiscalYTDRevenue

---

## Fiscal Calendars


Organizations with non-calendar fiscal years (starting in July, October, etc.) need custom period calculations. A calendar table is the cleanest approach.

### Fiscal year starting July 1

    -- Compute fiscal year and quarter from a date
    SELECT
        OrderDate,
        CASE WHEN MONTH(OrderDate) >= 7
             THEN YEAR(OrderDate) + 1
             ELSE YEAR(OrderDate)
        END AS FiscalYear,
        CASE WHEN MONTH(OrderDate) >= 7
             THEN (MONTH(OrderDate) - 7) / 3 + 1
             ELSE (MONTH(OrderDate) + 5) / 3 + 1
        END AS FiscalQuarter
    FROM Sales.Orders;

### 4-4-5 retail calendar

Retail calendars divide each quarter into periods of 4 weeks, 4 weeks, and 5 weeks. These cannot be computed with simple date math — use a calendar table with a FiscalPeriod column seeded for your specific pattern.

### Using the calendar table

    -- Quarterly revenue by fiscal year
    SELECT
        C.FiscalYear,
        C.FiscalQuarter,
        SUM(O.TotalAmount) AS Revenue
    FROM dbo.Calendar C
    JOIN Sales.Orders O
        ON O.OrderDate >= C.FullDate
       AND O.OrderDate <  DATEADD(day, 1, C.FullDate)
    GROUP BY C.FiscalYear, C.FiscalQuarter
    ORDER BY C.FiscalYear, C.FiscalQuarter;

---

## Cohort Analysis


Group users by their signup (or first purchase) period, then track their behavior over subsequent periods.

    -- Monthly retention by signup cohort
    WITH FirstPurchase AS (
        SELECT
            CustomerID,
            DATEFROMPARTS(
                YEAR(MIN(OrderDate)),
                MONTH(MIN(OrderDate)), 1
            ) AS CohortMonth
        FROM Sales.Orders
        GROUP BY CustomerID
    ),
    Activity AS (
        SELECT
            F.CustomerID,
            F.CohortMonth,
            DATEDIFF(month, F.CohortMonth,
                DATEFROMPARTS(YEAR(O.OrderDate), MONTH(O.OrderDate), 1)
            ) AS MonthsSinceFirst
        FROM FirstPurchase F
        JOIN Sales.Orders O ON O.CustomerID = F.CustomerID
    )
    SELECT
        CohortMonth,
        MonthsSinceFirst,
        COUNT(DISTINCT CustomerID) AS ActiveCustomers
    FROM Activity
    GROUP BY CohortMonth, MonthsSinceFirst
    ORDER BY CohortMonth, MonthsSinceFirst;

This produces a cohort retention matrix: rows are signup months, columns are months since signup, values are active customer counts.

---

## Temporal Table Queries (AS OF)


SQL Server temporal tables (system-versioned, 2016+) provide built-in point-in-time queries.[^6] Use them for historical snapshots in reports.

### Point-in-time snapshot

    -- What did the product catalog look like on 2024-06-15 at noon UTC?
    SELECT ProductID, ProductName, ListPrice
    FROM Production.Products
    FOR SYSTEM_TIME AS OF '2024-06-15T12:00:00'
    ORDER BY ProductID;

### All versions of a record

    -- Full price history for a product
    SELECT ProductID, ProductName, ListPrice, ValidFrom, ValidTo
    FROM Production.Products
    FOR SYSTEM_TIME ALL
    WHERE ProductID = 42
    ORDER BY ValidFrom;

### Historical join — prices at time of order

    -- What was the product price when each order was placed?
    SELECT
        O.OrderID,
        O.OrderDate,
        P.ProductName,
        P.ListPrice AS PriceAtOrderTime
    FROM Sales.Orders O
    CROSS APPLY (
        SELECT ProductName, ListPrice
        FROM Production.Products
        FOR SYSTEM_TIME AS OF O.OrderDate
        WHERE ProductID = O.ProductID
    ) P;

**Times are UTC.** FOR SYSTEM_TIME values are always interpreted as UTC regardless of session settings. Convert local times with AT TIME ZONE before passing to AS OF.

**AS OF queries both current and history tables** transparently. A row that existed at the requested point in time is returned whether it is still current or has been archived to the history table.

---

## Common Mistakes


| Mistake | Fix |
|---------|-----|
| Using RANGE instead of ROWS for moving averages | RANGE includes ties, inflating the window. Use ROWS for physical row count. |
| LAG with fixed offset on sparse data | If months are missing, LAG(value, 12) does not reach the correct year. Use a self-join on year/month. |
| Forgetting ISNULL on LEFT JOIN aggregations | LEFT JOIN to calendar table produces NULL for missing dates. Wrap in ISNULL(SUM(...), 0). |
| Using bucketing expressions in WHERE | Neither DATEADD/DATEDIFF nor CAST wrapping the column is SARGable. Filter with a range predicate on the raw column: `col >= @BucketStart AND col < @BucketEnd`. |
| Using FORMAT for date truncation | FORMAT is CLR-backed and 10-50x slower than DATEADD/DATEDIFF. Use it only for display formatting. |
| Forgetting that temporal table times are UTC | Convert local times to UTC before using in FOR SYSTEM_TIME AS OF. |
| Missing the default window frame | When ORDER BY is present without an explicit frame, the default is RANGE UNBOUNDED PRECEDING — slower and produces different results with ties. Always specify ROWS explicitly. |

---

## See Also


- [Tally Tables](tally-tables.md) — generating date spines without a permanent calendar table
- [Gaps and Islands](gaps-and-islands.md) — detecting missing dates and consecutive ranges
- [Aggregation Patterns](aggregation-patterns.md) — ROLLUP for hierarchical time-period subtotals
- [Export Patterns](export-patterns.md) — serializing time-series data for dashboards

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.


[^1]: [DATE_BUCKET (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/date-bucket-transact-sql) — DATE_BUCKET function for arbitrary-width time bucketing with optional origin parameter (SQL Server 2022+)
[^2]: [DATETRUNC (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/datetrunc-transact-sql) — DATETRUNC function for truncating datetime values to natural boundaries (SQL Server 2022+)
[^3]: [DATEADD (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/dateadd-transact-sql) — date arithmetic function used in the classic DATEADD/DATEDIFF bucketing pattern
[^4]: [DATEDIFF (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-transact-sql) — counts date boundary crossings; combined with DATEADD for date truncation on pre-2022 servers
[^5]: [OVER Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-over-clause-transact-sql) — window frame specification (ROWS/RANGE BETWEEN) for running totals and moving averages
[^6]: [Temporal Tables - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables) — FOR SYSTEM_TIME clause (AS OF, BETWEEN, ALL) for point-in-time reporting on system-versioned tables
[^7]: [Bucketizing Date and Time Data — SQLPerformance.com](https://sqlperformance.com/2021/08/t-sql-queries/bucketizing-date-and-time-data) — Itzik Ben-Gan's analysis of DATEADD/DATEDIFF truncation patterns and their correctness
[^8]: [DATE_BUCKET and DATETRUNC Improve Time-Based Grouping — SQLPerformance.com](https://sqlperformance.com/2022/10/t-sql-queries/date-bucket-datetrunc-improve-time-based-grouping) — execution plan comparison of DATE_BUCKET, DATETRUNC, and legacy DATEADD/DATEDIFF patterns showing optimizer advantages
[^9]: [Creating a Date Dimension or Calendar Table in SQL Server — MSSQLTips](https://www.mssqltips.com/sqlservertip/4054/creating-a-date-dimension-or-calendar-table-in-sql-server/) — date dimension table design with seeding patterns for BI reporting
[^10]: [T-SQL Fundamentals, 4th Edition](https://www.microsoftpressstore.com/store/t-sql-fundamentals-9780138102104) — Itzik Ben-Gan (Microsoft Press, 2023, ISBN 978-0138102104); covers date truncation patterns, window functions, and LAG/LEAD for period comparisons

# Feature Engineering in T-SQL


Patterns for computing the features a model trains on — turning raw application rows into numeric inputs. Each section shows the SQL pattern, explains what ML concept it serves, and flags data leakage risks where they apply.

## Table of Contents

1. [Numeric Features](#numeric-features)
2. [Categorical Encoding](#categorical-encoding)
3. [Temporal Features](#temporal-features)
4. [RFM Pattern](#rfm-pattern)
5. [Rolling Window Features](#rolling-window-features)
6. [Lag Features](#lag-features)
7. [Interaction Features](#interaction-features)
8. [Text Signal Features](#text-signal-features)
9. [See Also](#see-also)

---

## Numeric Features


Raw numeric columns often go straight into a model, but derived forms are frequently more useful.

### Raw value

    SELECT
        CustomerId,
        TotalOrderValue,
        NumOrders,
        AccountAgeDays
    FROM CustomerSummary;

### Log transform

Log transforms compress right-skewed distributions (e.g., revenue, count of events). Models that assume linearity benefit from this.

    SELECT
        CustomerId,
        LOG(TotalOrderValue + 1)    AS LogRevenue,    -- +1 avoids log(0)
        LOG(NumOrders + 1)          AS LogOrderCount
    FROM CustomerSummary;

`LOG` in T-SQL is the natural log. Use `LOG(x, 10)` for log base 10 (two-argument form available since SQL Server 2012). The `+1` offset handles zero values — omit it only when you can guarantee no zeros.

### Ratio and difference

    SELECT
        CustomerId,
        TotalOrderValue,
        NumOrders,
        -- Revenue per order (safe divide: NULLIF avoids divide-by-zero)
        TotalOrderValue / NULLIF(NumOrders, 0)                      AS AvgOrderValue, -- [^11]
        -- Month-over-month revenue change
        CurrentMonthRevenue - PriorMonthRevenue                     AS RevenueDelta,
        -- Percentage change (produces NULL when prior month = 0)
        (CurrentMonthRevenue - PriorMonthRevenue)
            / NULLIF(PriorMonthRevenue, 0) * 100.0                  AS RevenuePctChange
    FROM CustomerMonthly;

### Z-score normalization

Standardizes a feature to mean=0, stdev=1 — useful when the model is sensitive to feature scale (logistic regression, SVM, neural networks). Uses aggregate window functions (`AVG`, `STDEV`) with `OVER ()`. [^1]

    SELECT
        CustomerId,
        TotalOrderValue,
        -- Global z-score
        (TotalOrderValue - AVG(TotalOrderValue) OVER ())
            / NULLIF(STDEV(TotalOrderValue) OVER (), 0)             AS Revenue_ZScore,
        -- Group-level z-score (within category)
        (TotalOrderValue - AVG(TotalOrderValue) OVER (PARTITION BY Category))
            / NULLIF(STDEV(TotalOrderValue) OVER (PARTITION BY Category), 0)
                                                                    AS Revenue_ZScore_ByCategory
    FROM CustomerSummary;

> **Data leakage warning:** If you compute AVG and STDEV over the entire dataset and then split into train/test, the test set's z-score incorporates training data statistics. Compute these statistics only over the training partition, then apply to the test set. See [data-leakage.md](data-leakage.md#train-test-leakage).

### Min-max scaling

Rescales a feature to a fixed range (typically 0–1). Preferred over z-score when the feature has hard bounds or when the model expects bounded inputs (neural networks with sigmoid outputs).

    SELECT
        CustomerId,
        TotalOrderValue,
        -- Min-max scale to [0, 1]
        (TotalOrderValue - MIN(TotalOrderValue) OVER ())
            / NULLIF(MAX(TotalOrderValue) OVER () - MIN(TotalOrderValue) OVER (), 0)
                                                                    AS Revenue_MinMax
    FROM CustomerSummary;

> **Data leakage warning:** Same as z-score — MIN and MAX must be computed from training rows only and applied to both partitions.

---

## Categorical Encoding


SQL stores categories as strings or foreign key integers. Models need numbers. Three encoding strategies cover most situations.

### One-hot encoding (CASE expressions)

Best for low-cardinality categoricals (< ~20 distinct values). Creates one binary column per category.

    SELECT
        ProductId,
        ProductName,
        Category,
        -- One column per category value
        CASE WHEN Category = 'Electronics'  THEN 1 ELSE 0 END  AS Cat_Electronics,
        CASE WHEN Category = 'Apparel'      THEN 1 ELSE 0 END  AS Cat_Apparel,
        CASE WHEN Category = 'Home'         THEN 1 ELSE 0 END  AS Cat_Home,
        CASE WHEN Category = 'Sports'       THEN 1 ELSE 0 END  AS Cat_Sports
        -- NULLs in Category produce 0 in all indicator columns
        -- Add CASE WHEN Category IS NULL THEN 1 ELSE 0 END AS Cat_Missing
    FROM Products;

One-hot is also expressible with `PIVOT` for dynamic column generation (requires dynamic SQL when categories are not known at compile time). The `CASE` approach is preferred for static, known categories — it is readable and produces a predictable schema.

**What pandas sees:**

    df = pd.read_sql("SELECT ...", conn)
    # df already has Cat_Electronics, Cat_Apparel, etc. as integer columns

### Ordinal encoding (DENSE_RANK)

Assigns an integer rank to each unique value. Suitable for tree-based models (XGBoost, LightGBM) which can learn the order, and for categorical features that have a natural order (e.g., severity levels).

    SELECT
        OrderId,
        Region,
        -- Ordinal code starting from 1
        DENSE_RANK() OVER (ORDER BY Region) AS RegionOrdinal
    FROM Orders;

`DENSE_RANK` gives the same integer to ties and does not skip — e.g., (1, 1, 2, 3). `ROW_NUMBER` gives unique integers but breaks ties arbitrarily; use it only when ties are impossible or irrelevant. [^3]

> **Warning:** The ordinal values assigned by `DENSE_RANK` change when new categories appear in the data. Store the mapping (category → integer) in a reference table if you need to apply the same encoding at inference time.

### Frequency encoding

Replaces each category with its frequency in the training data. Useful for high-cardinality categoricals.

    SELECT
        OrderId,
        CustomerId,
        -- Raw frequency count
        COUNT(*) OVER (PARTITION BY Region)                             AS Region_Count,
        -- Frequency as proportion of total
        COUNT(*) OVER (PARTITION BY Region) * 1.0
            / COUNT(*) OVER ()                                          AS Region_Freq
    FROM Orders;

> **Data leakage warning:** Frequency must be computed only on training rows. If the full dataset is used to compute `COUNT(*) OVER (PARTITION BY Region)`, test rows contribute to the denominator. Materialize the training-set frequency in a temp table and join it to both train and test rows:

    -- Step 1: compute frequency on training rows only
    SELECT Region, COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS Freq
    INTO #RegionFreq
    FROM Orders
    WHERE SplitLabel = 'train'
    GROUP BY Region;

    -- Step 2: join frequency to all rows
    SELECT o.*, COALESCE(f.Freq, 0) AS Region_Freq
    FROM Orders o
    LEFT JOIN #RegionFreq f ON f.Region = o.Region;

---

## Temporal Features


Temporal features encode time information as numbers. The key rule: **all temporal features must be computed relative to a fixed snapshot date** — never relative to `GETDATE()` in a stored feature table, because `GETDATE()` changes every time the query runs.

    DECLARE @SnapshotDate DATE = '2024-06-01';   -- fixed as of training date

### Recency

How long ago did the entity last do something? Lower recency = more recent.

    SELECT
        CustomerId,
        MAX(OrderDate)                                                  AS LastOrderDate,
        DATEDIFF(DAY, MAX(OrderDate), @SnapshotDate)                    AS DaysSinceLastOrder, -- [^7]
        DATEDIFF(MONTH, MAX(OrderDate), @SnapshotDate)                  AS MonthsSinceLastOrder
    FROM Orders
    WHERE OrderDate < @SnapshotDate                                     -- never use future orders
    GROUP BY CustomerId;

> **Data leakage warning:** The `WHERE OrderDate < @SnapshotDate` filter is not optional. Without it, orders placed after the snapshot date are included, and recency becomes a future feature.

### Frequency

How many times did the entity act within a window?

    SELECT
        CustomerId,
        COUNT(*)                                                        AS TotalOrders,
        COUNT(CASE WHEN OrderDate >= DATEADD(DAY, -30, @SnapshotDate)
                    AND OrderDate < @SnapshotDate
                   THEN 1 END)                                          AS Orders_Last30Days,
        COUNT(CASE WHEN OrderDate >= DATEADD(DAY, -90, @SnapshotDate)
                    AND OrderDate < @SnapshotDate
                   THEN 1 END)                                          AS Orders_Last90Days
    FROM Orders
    WHERE OrderDate < @SnapshotDate
    GROUP BY CustomerId;

### Duration

How long between two events? Useful for session length, churn prediction, customer tenure.

    SELECT
        CustomerId,
        MIN(OrderDate)                                                  AS FirstOrderDate,
        MAX(OrderDate)                                                  AS LastOrderDate,
        DATEDIFF(DAY, MIN(OrderDate), MAX(OrderDate))                   AS DaysBetweenFirstAndLast,
        DATEDIFF(DAY, MIN(OrderDate), @SnapshotDate)                    AS CustomerTenureDays
    FROM Orders
    WHERE OrderDate < @SnapshotDate
    GROUP BY CustomerId;

### Calendar features

Day-of-week and month can be meaningful signals (e.g., purchases spike on weekends).

    SELECT
        OrderId,
        OrderDate,
        DATEPART(WEEKDAY, OrderDate)    AS DayOfWeek,     -- 1=Sunday, 7=Saturday (@@DATEFIRST-dependent)
        DATEPART(MONTH, OrderDate)      AS MonthOfYear,
        DATEPART(QUARTER, OrderDate)    AS Quarter,
        DATEPART(HOUR, OrderTime)       AS HourOfDay,
        -- Binary: is it a weekend?
        CASE WHEN DATEPART(WEEKDAY, OrderDate) IN (1, 7)
             THEN 1 ELSE 0 END          AS IsWeekend
    FROM Orders;

> Note: `DATEPART(WEEKDAY, ...)` is affected by `@@DATEFIRST`. Use `DATENAME(WEEKDAY, date)` for a string or set `@@DATEFIRST 1` for ISO weeks (Monday=1).

### Truncated date features (SQL Server 2022+)

`DATETRUNC` cleanly rounds a timestamp down to a given precision — useful for grouping events by hour, day, or month without the verbose `DATEADD(DATEDIFF(...))` pattern. [^8]

    SELECT
        OrderId,
        OrderTime,
        DATETRUNC(HOUR, OrderTime)      AS OrderHour,
        DATETRUNC(DAY, OrderTime)       AS OrderDay,
        DATETRUNC(MONTH, OrderTime)     AS OrderMonth
    FROM Orders;

---

## RFM Pattern


RFM (Recency, Frequency, Monetary) is a standard customer feature set used in churn and lifetime value models. [^12] It computes three scores per customer and combines them.

    DECLARE @SnapshotDate DATE = '2024-06-01';

    WITH RFM AS (
        SELECT
            CustomerId,
            -- Recency: days since last order (lower = more recent)
            DATEDIFF(DAY, MAX(OrderDate), @SnapshotDate)    AS Recency,
            -- Frequency: number of orders
            COUNT(*)                                        AS Frequency,
            -- Monetary: total spend
            SUM(OrderAmount)                                AS Monetary
        FROM Orders
        WHERE OrderDate < @SnapshotDate
        GROUP BY CustomerId
    ),
    RFMScored AS (
        SELECT
            CustomerId,
            Recency,
            Frequency,
            Monetary,
            -- Quintile scores: 5 = best, 1 = worst
            -- Recency: lower days = more recent = better, so ORDER BY DESC
            -- puts high recency (least recent) in bucket 1 (worst)
            NTILE(5) OVER (ORDER BY Recency DESC)       AS R_Score,
            NTILE(5) OVER (ORDER BY Frequency DESC)     AS F_Score,
            NTILE(5) OVER (ORDER BY Monetary DESC)      AS M_Score
        FROM RFM
    )
    SELECT
        CustomerId,
        Recency,
        Frequency,
        Monetary,
        R_Score,
        F_Score,
        M_Score,
        -- Combined score (simple sum; weights can be tuned)
        R_Score + F_Score + M_Score                     AS RFM_Total,
        -- Segment string for interpretability
        CAST(R_Score AS VARCHAR) + CAST(F_Score AS VARCHAR) + CAST(M_Score AS VARCHAR) AS RFM_Segment
    FROM RFMScored;

**What pandas sees:**

    df = pd.read_sql("SELECT ...", conn)
    # Features: Recency, Frequency, Monetary, R_Score, F_Score, M_Score, RFM_Total
    # RFM_Segment is interpretability label, not a model input

> `NTILE(5)` distributes rows into 5 equal buckets. If the row count is not divisible by 5, the first `(count % 5)` buckets get one extra row. See [mssql-server: 02-syntax-dql.md](../../mssql-server/references/02-syntax-dql.md) for NTILE behavior on ties.

---

## Rolling Window Features


Rolling windows aggregate the recent past for each entity at each point in time. They are the bread and butter of time-series feature engineering.

**Always use `ROWS BETWEEN`, not `RANGE BETWEEN`.** `RANGE` includes all rows with the same ORDER BY value in the frame boundary — for timestamp-ordered data with duplicates, this inflates counts silently. `ROWS` counts physical rows, which is always what you want here. [^1]

    SELECT
        CustomerId,
        OrderDate,
        OrderAmount,
        -- 7-day rolling sum (current day + 6 preceding)
        SUM(OrderAmount) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        )                                                   AS Revenue_7Day,
        -- 30-day rolling count of orders
        COUNT(*) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        )                                                   AS OrderCount_30Day,
        -- 90-day rolling average order value
        AVG(OrderAmount) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN 89 PRECEDING AND CURRENT ROW
        )                                                   AS AvgOrderValue_90Day
    FROM Orders
    WHERE OrderDate < @SnapshotDate;

> **Data leakage warning:** `ORDER BY OrderDate` with `CURRENT ROW` as the upper frame bound is safe — it looks at the current and past rows. Never use `ROWS BETWEEN n PRECEDING AND n FOLLOWING` for training features; `n FOLLOWING` looks into the future.

### SQL Server 2022: WINDOW clause for reuse

When multiple rolling features share the same partition and order, the WINDOW clause eliminates repetition: [^2]

    SELECT
        CustomerId,
        OrderDate,
        SUM(OrderAmount)    OVER w  AS Revenue_7Day,
        COUNT(*)            OVER w  AS OrderCount_7Day,
        AVG(OrderAmount)    OVER w  AS AvgValue_7Day
    FROM Orders
    WINDOW w AS (
        PARTITION BY CustomerId
        ORDER BY OrderDate
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    );

### Volatility features (windowed STDEV)

Rolling standard deviation measures how much a value fluctuates over a window. Common in financial models and anomaly detection.

    SELECT
        CustomerId,
        OrderDate,
        OrderAmount,
        STDEV(OrderAmount) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        )                                                   AS AmountVolatility_30Day
    FROM Orders
    WHERE OrderDate < @SnapshotDate;

### FIRST_VALUE and LAST_VALUE

Useful for features like "first product purchased" or "most recent category."

    SELECT
        CustomerId,
        OrderDate,
        FIRST_VALUE(ProductCategory) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )                                                   AS FirstCategory,
        LAST_VALUE(ProductCategory) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
        )                                                   AS LastCategory
    FROM Orders
    WHERE OrderDate < @SnapshotDate;

> **Gotcha:** `LAST_VALUE` without an explicit frame uses the default frame (`RANGE ... CURRENT ROW`) and returns the current row's value — not the partition's last. Always specify `ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING`. [^6]

### DATE_BUCKET for calendar-aligned aggregations (SQL Server 2022+)

    SELECT                                                          -- [^9]
        DATE_BUCKET(WEEK, 1, OrderDate)     AS WeekStart,
        SUM(OrderAmount)                    AS WeeklyRevenue,
        COUNT(*)                            AS WeeklyOrders
    FROM Orders
    WHERE OrderDate < @SnapshotDate
    GROUP BY DATE_BUCKET(WEEK, 1, OrderDate)
    ORDER BY WeekStart;

---

## Lag Features


Lag features capture the value of a column at a prior time step. They are the primary way to give a model awareness of trends and momentum.

    SELECT
        CustomerId,
        OrderDate,
        OrderAmount,
        -- Previous order amount (offset = 1)
        LAG(OrderAmount, 1) OVER (
            PARTITION BY CustomerId ORDER BY OrderDate
        )                                                   AS PrevOrderAmount,
        -- Order amount two periods ago
        LAG(OrderAmount, 2) OVER (
            PARTITION BY CustomerId ORDER BY OrderDate
        )                                                   AS OrderAmount_2Lag,
        -- Delta from previous order
        OrderAmount - LAG(OrderAmount, 1) OVER (
            PARTITION BY CustomerId ORDER BY OrderDate
        )                                                   AS AmountDelta,
        -- Days since previous order
        DATEDIFF(DAY,
            LAG(OrderDate, 1) OVER (PARTITION BY CustomerId ORDER BY OrderDate),
            OrderDate
        )                                                   AS DaysSincePrevOrder
    FROM Orders
    WHERE OrderDate < @SnapshotDate;

`LAG(col, offset, default)` returns `default` (or NULL if not specified) when there is no prior row. [^4] Always check whether NULL lags are meaningful or need imputation for your model.

> **Data leakage warning:** `LAG` looks backward — safe by definition. `LEAD` looks forward — never use LEAD for training features; it reads future values. See [data-leakage.md](data-leakage.md#temporal-leakage).

**Multi-horizon lag features** (common for demand forecasting):

    SELECT
        ProductId,
        SalesDate,
        UnitsSold,
        LAG(UnitsSold, 1)  OVER (PARTITION BY ProductId ORDER BY SalesDate) AS Units_Lag1,
        LAG(UnitsSold, 7)  OVER (PARTITION BY ProductId ORDER BY SalesDate) AS Units_Lag7,
        LAG(UnitsSold, 14) OVER (PARTITION BY ProductId ORDER BY SalesDate) AS Units_Lag14,
        LAG(UnitsSold, 28) OVER (PARTITION BY ProductId ORDER BY SalesDate) AS Units_Lag28
    FROM DailySales
    WHERE SalesDate < @SnapshotDate;

---

## Interaction Features


Interaction features capture combinations of two or more other features. Computed directly in SQL as expressions.

    SELECT
        CustomerId,
        OrderDate,
        OrderAmount,
        ProductCategory,
        -- Numeric interaction: revenue × frequency (engagement score)
        TotalRevenue * NumOrders                            AS Revenue_x_Frequency,
        -- Conditional interaction: revenue in a specific category
        CASE WHEN ProductCategory = 'Electronics'
             THEN OrderAmount ELSE 0 END                    AS ElectronicsRevenue,
        -- Cross feature: tenure bucket × loyalty tier
        TenureBucket * LoyaltyTierOrdinal                  AS Tenure_x_Loyalty,
        -- CROSS APPLY for complex per-row feature derived from a subquery
        ca.MaxEventGap
    FROM CustomerSummary cs
    CROSS APPLY (
        SELECT MAX(DATEDIFF(DAY, prev_dt, OrderDate)) AS MaxEventGap
        FROM (
            SELECT OrderDate,
                   LAG(OrderDate) OVER (
                       PARTITION BY CustomerId ORDER BY OrderDate
                   ) AS prev_dt
            FROM Orders o
            WHERE o.CustomerId = cs.CustomerId
              AND o.OrderDate < @SnapshotDate
        ) t
    ) ca;

> `CROSS APPLY` invokes the subquery once per outer row. Use `OUTER APPLY` when some customers have no orders and you want to preserve those rows (with NULL for the feature). See [mssql-server: 02-syntax-dql.md](../../mssql-server/references/02-syntax-dql.md) for APPLY semantics.

---

## Text Signal Features


For columns that are free-text strings (product descriptions, notes, usernames), basic SQL functions extract signals without full NLP.

    SELECT
        ProductId,
        Description,
        -- Length is often a signal on its own
        LEN(Description)                                        AS DescriptionLength,
        -- Keyword presence (binary)
        CASE WHEN CHARINDEX('sale', LOWER(Description)) > 0
             THEN 1 ELSE 0 END                                  AS HasKeyword_Sale,
        CASE WHEN CHARINDEX('new', LOWER(Description)) > 0
             THEN 1 ELSE 0 END                                  AS HasKeyword_New,
        -- Count of spaces as proxy for word count
        LEN(LTRIM(RTRIM(Description)))
            - LEN(REPLACE(Description, ' ', '')) + 1            AS ApproxWordCount,
        -- Contains a number?
        CASE WHEN PATINDEX('%[0-9]%', Description) > 0
             THEN 1 ELSE 0 END                                  AS ContainsNumber,
        -- Starts with specific prefix (common in SKU patterns)
        CASE WHEN LEFT(Description, 4) = 'PRO-'
             THEN 1 ELSE 0 END                                  AS IsPremiumLine
    FROM Products;

`CHARINDEX` follows the database collation. [^10] Most SQL Server databases use case-insensitive (CI) collations, in which case `CHARINDEX('sale', Description)` matches 'Sale', 'SALE', etc. without `LOWER()`. If your database uses a case-sensitive (CS) collation, wrap in `LOWER()` to normalize, or apply an explicit CI collation: `CHARINDEX('sale', Description COLLATE Latin1_General_CI_AS)`.

---

## See Also

- [sampling-splitting.md](sampling-splitting.md) — splitting the feature table into train/test sets
- [null-imputation.md](null-imputation.md) — handling NULLs in the feature columns above
- [data-leakage.md](data-leakage.md) — how temporal features leak and how to prevent it
- [mssql-server: 02-syntax-dql.md](../../mssql-server/references/02-syntax-dql.md) — window functions, APPLY, NTILE
- [mssql-server: 51-2022-features.md](../../mssql-server/references/51-2022-features.md) — WINDOW clause, DATE_BUCKET, GENERATE_SERIES

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [OVER Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-over-clause-transact-sql) — defines partitioning, ordering, and frame (ROWS/RANGE) for window functions including SUM, AVG, COUNT, LAG, LEAD
[^2]: [WINDOW Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-window-transact-sql) — SQL Server 2022 named window definitions, reducing duplication when multiple functions share the same frame
[^3]: [Ranking Functions (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/ranking-functions-transact-sql) — overview of ROW_NUMBER, RANK, DENSE_RANK, and NTILE with behavior on ties
[^4]: [LAG (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/lag-transact-sql) — LAG syntax including offset, default value, and IGNORE NULLS (2022+)
[^5]: [FIRST_VALUE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/first-value-transact-sql) — returns the first value in an ordered window frame; supports IGNORE NULLS in 2022+
[^6]: [LAST_VALUE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/last-value-transact-sql) — returns the last value in the window frame; requires explicit ROWS BETWEEN to avoid the default frame trap
[^7]: [DATEDIFF (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-transact-sql) — returns the count of datepart boundaries crossed between two dates
[^8]: [DATETRUNC (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/datetrunc-transact-sql) — SQL Server 2022; truncates a date/time value to the specified precision
[^9]: [DATE_BUCKET (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/date-bucket-transact-sql) — SQL Server 2022; groups dates into fixed-width time buckets with optional origin
[^10]: [CHARINDEX (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/charindex-transact-sql) — string position search; case sensitivity follows the input collation
[^11]: [NULLIF (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/nullif-transact-sql) — returns NULL when two expressions are equal; used for safe division via NULLIF(denominator, 0)
[^12]: [RFM (market research) - Wikipedia](https://en.wikipedia.org/wiki/RFM_%28market_research%29) — origin and methodology of Recency, Frequency, Monetary customer segmentation

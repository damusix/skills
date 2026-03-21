# Data Leakage in SQL Feature Pipelines


Data leakage is when information that would not be available at prediction time is used to build training features or select the training set. [^5] It is the #1 cause of models that appear to perform well in evaluation but fail in production.

Leakage always starts in SQL. The queries that build the training dataset are where the contamination happens. This file describes the common forms of leakage and the SQL patterns that prevent them.

## Table of Contents

1. [What Data Leakage Is](#what-data-leakage-is)
2. [Temporal Leakage](#temporal-leakage)
3. [Target Leakage](#target-leakage)
4. [Train/Test Leakage](#traintest-leakage)
5. [Prevention Patterns](#prevention-patterns)
6. [SQL Patterns That Accidentally Leak](#sql-patterns-that-accidentally-leak)
7. [See Also](#see-also)

---

## What Data Leakage Is


A model predicts something (the target) using information that is available when the prediction is made. Leakage occurs when the training dataset contains information derived from:

1. **The future** (temporal leakage) — the feature reflects events that happened after the prediction point.
2. **The label itself** (target leakage) — the feature is derived from or correlated with the outcome variable.
3. **The test set** (train/test leakage) — statistics used to construct training features were computed using test-set rows.

All three forms of leakage produce the same symptom: training and evaluation metrics look great, but production performance is poor. The gap between evaluation AUC and production AUC is diagnostic.

---

## Temporal Leakage


Temporal leakage is the most common and most insidious form. [^6] It happens when a feature is computed using events that had not yet occurred at the time the prediction would have been made.

### Example: the unbounded recency feature

    -- WRONG: uses all history, including future events relative to the label date
    SELECT
        CustomerId,
        MAX(OrderDate)                              AS LastOrderDate,
        DATEDIFF(DAY, MAX(OrderDate), GETDATE())    AS DaysSinceLastOrder
    FROM Orders
    GROUP BY CustomerId;

If you are predicting churn as of `2023-06-01`, a customer who placed an order on `2023-09-01` would show `DaysSinceLastOrder = -92`. The model learns that negative recency predicts non-churn — correctly for training, but impossible to reproduce in production.

**Fix:**

    DECLARE @SnapshotDate DATE = '2023-06-01';

    SELECT
        CustomerId,
        MAX(OrderDate)                                  AS LastOrderDate,
        DATEDIFF(DAY, MAX(OrderDate), @SnapshotDate)    AS DaysSinceLastOrder
    FROM Orders
    WHERE OrderDate < @SnapshotDate    -- never look past the snapshot date
    GROUP BY CustomerId;

### Example: LEAD in training features

    -- WRONG: LEAD reads the next row — a future event
    SELECT
        CustomerId,
        OrderDate,
        OrderAmount,
        LEAD(OrderDate, 1) OVER (PARTITION BY CustomerId ORDER BY OrderDate) AS NextOrderDate
    FROM Orders;

`NextOrderDate` is the date of the order placed after this one. At prediction time, the model does not know when the customer will next order — that is often what you are trying to predict. Including it as a feature leaks the answer.

**Fix:** Only use `LAG` for backward-looking features in training data. [^4]

### Example: Rolling window without a date bound

    -- WRONG: window function without WHERE; includes future rows
    SELECT
        CustomerId,
        OrderDate,
        SUM(OrderAmount) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS Revenue_7Day
    FROM Orders;

If this query runs after `@SnapshotDate`, rows after that date are present in the table and will appear in the window for rows near the boundary. [^3] A row on `@SnapshotDate - 2` may have rows from `@SnapshotDate + 4` in its 7-row window.

**Fix:**

    SELECT
        CustomerId,
        OrderDate,
        SUM(OrderAmount) OVER (
            PARTITION BY CustomerId
            ORDER BY OrderDate
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS Revenue_7Day
    FROM Orders
    WHERE OrderDate < @SnapshotDate;    -- exclude all rows after the snapshot date

### Temporal tables and point-in-time features

SQL Server system-versioned temporal tables let you query the state of any table as of a historical moment. [^1] [^2] Use them to build features from the version of reference data that existed at the snapshot date — not its current version.

    DECLARE @SnapshotDate DATETIME2 = '2023-06-01T00:00:00';

    -- The product price as it was on the snapshot date (not today's price)
    SELECT p.ProductId, p.Price
    FROM dbo.ProductPricing FOR SYSTEM_TIME AS OF @SnapshotDate AS p;

Without `FOR SYSTEM_TIME AS OF`, you get the current price. If prices changed after the snapshot date, the feature uses incorrect values — a form of temporal leakage. See [mssql-server: 17-temporal-tables.md](../../mssql-server/references/17-temporal-tables.md) for temporal table syntax.

---

## Target Leakage


Target leakage occurs when a feature is derived from the label variable or a variable that could only have been computed with knowledge of the label.

### Example: including a consequence of the outcome

Predicting whether a customer will churn in the next 30 days:

    -- WRONG: CancellationDate is set when the customer cancels
    -- If the customer churned, CancellationDate is non-NULL during the training window
    SELECT
        CustomerId,
        CancellationDate,                                   -- leaks: directly encodes the label
        DATEDIFF(DAY, CancellationDate, @SnapshotDate)      AS DaysSinceCancellation,
        CASE WHEN CancellationDate IS NULL THEN 0 ELSE 1 END AS Churned   -- this is the label
    FROM Customers;

`CancellationDate` is non-NULL only for customers who churned. Including it as a feature tells the model the answer. Even `DaysSinceCancellation` leaks — it is only computable for churned customers.

**Fix:** Only include features that were observable before the prediction point and do not encode the outcome.

### Example: aggregate derived from events that define the label

Predicting whether an order will be returned:

    -- WRONG: CountOfPriorReturns is computed from the returns table
    -- but if you include the return event being labeled, the model learns tautologies
    SELECT
        OrderId,
        COUNT(r.ReturnId) OVER (PARTITION BY o.CustomerId) AS TotalReturns,  -- leaks if return for this order is included
        CASE WHEN r.ReturnId IS NOT NULL THEN 1 ELSE 0 END AS IsReturned
    FROM Orders o
    LEFT JOIN Returns r ON r.OrderId = o.OrderId;

If `TotalReturns` counts all returns including the current order, it is 1 for returned orders and 0 for non-returned orders — i.e., it equals the label.

**Fix:** Count prior returns only, excluding the current order:

    SELECT
        o.OrderId,
        COUNT(r.ReturnId) AS PriorReturns   -- only returns before this order
    FROM Orders o
    LEFT JOIN Returns r
        ON r.CustomerId = o.CustomerId
       AND r.ReturnDate < o.OrderDate       -- strictly before this order
    GROUP BY o.OrderId;

---

## Train/Test Leakage


Train/test leakage occurs when statistics computed across the entire dataset (before the train/test split) are used as features. The test set influences the feature values seen in the training set.

### Example: global z-score computed on full dataset

    -- WRONG: AVG and STDEV include test-set rows
    SELECT
        CustomerId,
        Revenue,
        (Revenue - AVG(Revenue) OVER ()) / NULLIF(STDEV(Revenue) OVER (), 0) AS Revenue_ZScore,
        Split
    FROM FeatureTable;

If 20% of the rows are in the test set, the mean and stdev reflect all rows. A training-set feature is normalized using test-set statistics. At inference time, you must normalize using only training-set statistics — so training and inference are inconsistent.

**Fix:** Compute statistics from training rows only, then apply:

    -- Step 1: compute statistics from training rows
    SELECT
        AVG(Revenue)    AS TrainMean,
        STDEV(Revenue)  AS TrainStdev
    INTO #ImputeStats
    FROM FeatureTable
    WHERE Split = 'train';

    -- Step 2: apply to all rows
    SELECT
        f.CustomerId,
        f.Revenue,
        (f.Revenue - s.TrainMean) / NULLIF(s.TrainStdev, 0) AS Revenue_ZScore,
        f.Split
    FROM FeatureTable f
    CROSS JOIN #ImputeStats s;

### Example: frequency encoding on full dataset

    -- WRONG: frequency of each region uses all rows including test
    SELECT
        OrderId,
        Region,
        COUNT(*) OVER (PARTITION BY Region) * 1.0 / COUNT(*) OVER () AS Region_Freq
    FROM Orders;

**Fix:** Compute frequency from training rows only and join to all rows:

    SELECT Region, COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS Freq
    INTO #RegionFreq
    FROM Orders
    WHERE Split = 'train'
    GROUP BY Region;

    SELECT o.*, COALESCE(f.Freq, 0) AS Region_Freq
    FROM Orders o
    LEFT JOIN #RegionFreq f ON f.Region = o.Region;

---

## Prevention Patterns


### Pattern 1: the snapshot date variable

Declare a single `@SnapshotDate` variable at the top of every feature query. All date comparisons, recency calculations, and rolling windows reference it. Never use `GETDATE()` or `SYSDATETIME()` directly in feature logic.

    DECLARE @SnapshotDate DATE = '2023-06-01';

    -- Every WHERE clause that touches event dates uses this variable
    WHERE OrderDate < @SnapshotDate

    -- Every DATEDIFF uses this as the endpoint
    DATEDIFF(DAY, MAX(OrderDate), @SnapshotDate)

### Pattern 2: the training window boundary

Keep all feature computation strictly inside the training window:

    DECLARE @SnapshotDate DATE = '2023-06-01';
    DECLARE @TrainStart   DATE = '2022-01-01';   -- how far back to look

    SELECT CustomerId, SUM(OrderAmount) AS TotalRevenue
    FROM Orders
    WHERE OrderDate >= @TrainStart
      AND OrderDate <  @SnapshotDate   -- upper bound is always strictly before snapshot
    GROUP BY CustomerId;

### Pattern 3: entity-level feature tables with explicit timestamps

Store features with the snapshot date they were computed at. Never overwrite — append with the new date. This makes leakage auditable: you can inspect exactly what data was used to build the features for each training run.

    INSERT INTO dbo.CustomerFeatureStore (CustomerId, SnapshotDate, Revenue_7Day, ...)
    SELECT CustomerId, @SnapshotDate, ...
    FROM ...
    WHERE OrderDate < @SnapshotDate;

### Pattern 4: split before computing statistics

Always create the `Split` column first (using HASHBYTES or time-based split), then compute imputation statistics, encoding statistics, and normalization statistics from training rows only.

    -- WRONG order
    -- 1. Compute z-score (uses all rows)
    -- 2. Split into train/test

    -- CORRECT order
    -- 1. Assign split label (HASHBYTES or date-based)
    -- 2. Compute statistics on WHERE Split = 'train' rows only
    -- 3. Apply statistics to all rows

---

## SQL Patterns That Accidentally Leak

| SQL pattern | What leaks | Fix |
|---|---|---|
| `WHERE OrderDate <= GETDATE()` in a feature table refresh | Features computed at refresh time include events after the training snapshot | Replace with `WHERE OrderDate < @SnapshotDate` |
| `LEAD(value, 1) OVER (...)` as a feature | The next event — future data | Use only `LAG` for training features |
| `JOIN Events ON e.Date >= o.Date` without an upper bound | All future events join to each order row | Add `AND e.Date < @SnapshotDate` |
| `AVG(col) OVER ()` before splitting | Test-set values shift the mean | Compute `AVG` on `WHERE Split = 'train'` rows only |
| `COUNT(*) OVER (PARTITION BY label_col)` | Label information in the feature value | Compute only over non-label columns |
| `ROW_NUMBER() OVER (ORDER BY label_col DESC)` | Rows at top are the positive class | Use ordering by date or entity key, not by the label |
| `FOR SYSTEM_TIME ALL` without a date filter | All versions including future updates | Use `FOR SYSTEM_TIME AS OF @SnapshotDate` |
| Forward fill without `WHERE EventDate < @SnapshotDate` | Future readings propagate backward | Filter the CTE input to rows before the snapshot |
| Joining to a dimension table at its current state | Dimension values change over time; current state may reflect post-snapshot updates | Use temporal table AS OF or a slowly changing dimension |
| `TABLESAMPLE` combined with any window function | Page-level sample interacts unpredictably with window partitions | Materialize the sample first, then apply windows |

---

## See Also

- [feature-engineering.md](feature-engineering.md) — how each feature type relates to temporal leakage risk
- [sampling-splitting.md](sampling-splitting.md) — time-based splitting to prevent cross-boundary leakage
- [null-imputation.md](null-imputation.md) — imputing on training rows only
- [mssql-server: 17-temporal-tables.md](../../mssql-server/references/17-temporal-tables.md) — FOR SYSTEM_TIME AS OF for point-in-time features
- [mssql-server: 02-syntax-dql.md](../../mssql-server/references/02-syntax-dql.md) — window function framing (ROWS vs RANGE, LAG vs LEAD)

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [Temporal Tables - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables) — system-versioned temporal tables, period columns, and history table architecture
[^2]: [Querying Data in a System-Versioned Temporal Table - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/querying-data-in-a-system-versioned-temporal-table) — FOR SYSTEM_TIME AS OF, BETWEEN, CONTAINED IN subclauses for point-in-time feature snapshots
[^3]: [OVER Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-over-clause-transact-sql) — window frame semantics (ROWS vs RANGE, PRECEDING vs FOLLOWING) critical for understanding how rolling features can leak
[^4]: [LAG (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/lag-transact-sql) — backward-looking offset function (safe for training); contrast with LEAD which looks forward (leaks)
[^5]: [What is Data Leakage in Machine Learning? | IBM](https://www.ibm.com/think/topics/data-leakage-machine-learning) — overview of data leakage types, symptoms (train-production performance gap), and prevention strategies
[^6]: [Preventing Data Leakage in Feature Engineering | dotData](https://dotdata.com/blog/preventing-data-leakage-in-feature-engineering-strategies-and-solutions/) — feature engineering-specific leakage patterns including temporal, target, and preprocessing leakage with prevention strategies

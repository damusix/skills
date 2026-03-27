# Sampling and Train/Test Splitting in T-SQL


Patterns for selecting a representative sample from SQL Server and dividing it into reproducible train, validation, and test partitions.

## Table of Contents

1. [TABLESAMPLE — Percentage-Based Sampling](#tablesample)
2. [HASHBYTES-Based Deterministic Splitting](#hashbytes-based-deterministic-splitting)
3. [NTILE for K-Fold Cross-Validation](#ntile-for-k-fold-cross-validation)
4. [Stratified Sampling](#stratified-sampling)
5. [Time-Based Splitting](#time-based-splitting)
6. [Downsampling and Upsampling](#downsampling-and-upsampling)
7. [See Also](#see-also)

---

## TABLESAMPLE


`TABLESAMPLE` returns an approximate percentage of rows by sampling data pages, not individual rows. [^1] [^5] It is fast on large tables because it avoids a full scan.

    -- Approximately 10% of rows
    SELECT *
    FROM Orders TABLESAMPLE (10 PERCENT);

    -- REPEATABLE: same seed returns the same sample (for a given data state)
    SELECT *
    FROM Orders TABLESAMPLE (10 PERCENT) REPEATABLE (42);

### Limitations

- The percentage is approximate — page-level sampling means you may get 8% or 12%, not exactly 10%.
- `REPEATABLE (seed)` reproduces the same sample only if the underlying data and page layout have not changed. A rebuild, reorg, or any INSERT/DELETE can shift which pages are sampled.
- `TABLESAMPLE` cannot be used on views, CTEs, or derived tables — only on base tables.
- Not suitable for stratified sampling or deterministic entity-level splits.

**Use TABLESAMPLE for:** quick exploratory samples during development where exact reproducibility is not required.

**Use HASHBYTES splits for:** training datasets where you need the same entity (customer, product) to always land in the same partition across runs.

---

## HASHBYTES-Based Deterministic Splitting


This is the recommended approach for production train/test splits. `HASHBYTES('SHA2_256', key)` produces a deterministic, well-distributed hash of an entity key. [^2] Taking the hash modulo N assigns each entity to a stable bucket regardless of when or how the query runs.

    SELECT
        CustomerId,
        OrderDate,
        OrderAmount,
        -- Assign to train (80%) or test (20%) deterministically
        CASE
            WHEN ABS(CAST(
                     CAST(HASHBYTES('SHA2_256', CAST(CustomerId AS NVARCHAR(20)))
                          AS BINARY(8)) AS BIGINT)) % 10 < 8
                 THEN 'train'
            ELSE 'test'
        END AS Split
    FROM Orders;

**How the hash-to-int conversion works:**

1. `CAST(CustomerId AS NVARCHAR(20))` — converts the key to a consistent string representation.
2. `HASHBYTES('SHA2_256', ...)` — produces a deterministic 32-byte (`VARBINARY(32)`) hash. SHA2_256 is well-distributed; MD5 and SHA1 are cryptographically broken and should not be used for new code.
3. `CAST(... AS BINARY(8))` — truncates the hash to 8 bytes. SQL Server truncates binary-to-binary conversions, keeping a subset of bytes. Since SHA2_256 is uniformly distributed across all bytes, the subset provides good bucket distribution regardless of which end is kept.
4. `CAST(... AS BIGINT)` — interprets those 8 bytes as a 64-bit integer. A BIGINT is exactly 8 bytes, so this conversion is always safe.
5. `ABS(...)` — makes the value non-negative before modulo.
6. `% 10` — maps to buckets 0–9.

> **Edge case:** `ABS()` on BIGINT overflows when the value is exactly `-9223372036854775808` (the minimum BIGINT, which has no positive equivalent). This is a 1-in-2^63 chance per row but will crash a production pipeline when it hits. To guard against it, use modulo before ABS: `(CAST(... AS BIGINT) % 10 + 10) % 10` — this avoids ABS entirely and handles negative modulo results correctly.

### Train / test / validation (70 / 15 / 15)

    SELECT
        CustomerId,
        CASE
            WHEN ABS(CAST(CAST(HASHBYTES('SHA2_256', CAST(CustomerId AS NVARCHAR(20)))
                               AS BINARY(8)) AS BIGINT)) % 20 < 14  THEN 'train'       -- 0-13 = 70%
            WHEN ABS(CAST(CAST(HASHBYTES('SHA2_256', CAST(CustomerId AS NVARCHAR(20)))
                               AS BINARY(8)) AS BIGINT)) % 20 < 17  THEN 'validation'  -- 14-16 = 15%
            ELSE 'test'                                                                 -- 17-19 = 15%
        END AS Split
    FROM Customers;

**Why not `CHECKSUM` or `RAND()`?**

- `CHECKSUM(col)` has poor distribution for small integer keys (sequential IDs cluster together) and differs between SQL Server versions.
- `RAND()` is non-deterministic — each call produces a different value, so the same customer lands in different buckets on different runs.
- `HASHBYTES('SHA2_256', ...)` is deterministic, well-distributed, and consistent across SQL Server versions and instances.

> **Gotcha:** `HASHBYTES('SHA2_256', NULL)` returns NULL. If the entity key can be NULL, those rows will have NULL for Split and be excluded from both train and test. Filter them out explicitly or handle them as a separate class.

**What pandas sees:**

    df = pd.read_sql("SELECT ...", conn)
    train = df[df['Split'] == 'train']
    test  = df[df['Split'] == 'test']

---

## NTILE for K-Fold Cross-Validation


`NTILE(k)` divides rows into k approximately equal buckets. [^3] Use it to assign fold numbers for cross-validation.

    SELECT
        CustomerId,
        OrderAmount,
        -- 5-fold cross-validation assignment
        NTILE(5) OVER (ORDER BY CustomerId)     AS FoldId
    FROM CustomerFeatures;

To use fold `i` as the validation fold and the rest as training:

    -- In the ML framework / Python (pseudo-code):
    -- for fold in range(1, 6):
    --     train = df[df['FoldId'] != fold]
    --     val   = df[df['FoldId'] == fold]

**Gotcha:** `NTILE(5)` ordered by `CustomerId` assigns folds deterministically only if the ORDER BY is deterministic. If `CustomerId` has ties (it shouldn't for a primary key), add a tiebreaker. Also, `NTILE` with a non-random ORDER BY may produce folds that are not representative samples — use with a random-looking key or shuffle first.

**Shuffle before NTILE using HASHBYTES:**

    SELECT
        CustomerId,
        NTILE(5) OVER (
            ORDER BY HASHBYTES('SHA2_256', CAST(CustomerId AS NVARCHAR(20)))
        ) AS FoldId
    FROM CustomerFeatures;

This produces folds that appear randomly shuffled but are deterministic across runs.

---

## Stratified Sampling


Stratified sampling ensures that each class (label value) is represented in the sample proportionally to its frequency in the full dataset. Critical when class imbalance exists.

    -- Assign a row number within each class
    WITH Stratified AS (
        SELECT
            CustomerId,
            Label,
            ROW_NUMBER() OVER (
                PARTITION BY Label
                ORDER BY HASHBYTES('SHA2_256', CAST(CustomerId AS NVARCHAR(20)))
            ) AS RowWithinClass,
            COUNT(*) OVER (PARTITION BY Label) AS ClassSize
        FROM CustomerFeatures
    )
    -- Keep the first 80% of rows within each class
    SELECT CustomerId, Label, 'train' AS Split
    FROM Stratified
    WHERE RowWithinClass <= CAST(ClassSize * 0.8 AS INT)

    UNION ALL

    SELECT CustomerId, Label, 'test' AS Split
    FROM Stratified
    WHERE RowWithinClass > CAST(ClassSize * 0.8 AS INT);

**What this produces:** Each label class contributes 80% of its rows to train and 20% to test, so the class distribution is preserved in both partitions.

---

## Time-Based Splitting


For any dataset with a temporal dimension — user behavior, transactions, sensor readings, financial data — you **must** use a time-based split, not a random split.

A random split allows the model to train on rows from the future relative to some test rows, which inflates evaluation metrics and produces models that fail in production.

    DECLARE @TrainEnd DATE = '2023-12-31';
    DECLARE @TestStart DATE = '2024-01-01';

    SELECT
        CustomerId,
        OrderDate,
        -- Features...
        CASE
            WHEN OrderDate <= @TrainEnd  THEN 'train'
            WHEN OrderDate >= @TestStart THEN 'test'
            -- Gap period between train end and test start can be used as a buffer
            -- to prevent leakage from near-boundary rows
        END AS Split
    FROM Orders
    WHERE OrderDate <= @TestStart;   -- exclude future rows entirely

To exclude the gap period, wrap in a CTE or derived table and filter on the computed alias:

    WITH Labeled AS (
        SELECT
            CustomerId,
            OrderDate,
            CASE
                WHEN OrderDate <= @TrainEnd  THEN 'train'
                WHEN OrderDate >= @TestStart THEN 'test'
            END AS Split
        FROM Orders
        WHERE OrderDate <= @TestStart
    )
    SELECT * FROM Labeled
    WHERE Split IS NOT NULL;   -- exclude gap period rows

**Why the gap matters:** If your features include rolling windows (e.g., 30-day prior revenue), a row at `2024-01-01` in the test set will look back at rows from December 2023, which are in the training set. The rolling window itself does not leak — but if you compute any statistics (e.g., global mean) on a combined dataset, those statistics would. The gap provides a clean boundary.

### Walk-forward validation (time-series cross-validation)

Standard k-fold cross-validation is invalid for temporal data because fold 3 may precede fold 1 in time. Use walk-forward (expanding window) validation instead:

    -- Generate fold boundaries for walk-forward validation
    WITH Folds AS (
        SELECT value AS FoldNum,
               DATEADD(MONTH, value * 3, '2022-01-01')      AS TrainEnd,
               DATEADD(MONTH, value * 3 + 3, '2022-01-01')  AS TestStart,
               DATEADD(MONTH, value * 3 + 6, '2022-01-01')  AS TestEnd
        FROM GENERATE_SERIES(0, 3)   -- SQL Server 2022+ [^4]; use recursive CTE on older versions
    )
    SELECT f.FoldNum, o.OrderDate, o.CustomerId,
           CASE WHEN o.OrderDate < f.TrainEnd  THEN 'train' ELSE 'test' END AS Split
    FROM Orders o
    CROSS JOIN Folds f
    WHERE o.OrderDate >= '2022-01-01'
      AND o.OrderDate < f.TestEnd
      AND NOT (o.OrderDate >= f.TrainEnd AND o.OrderDate < f.TestStart)  -- exclude gap
    ORDER BY f.FoldNum, o.OrderDate;

> **Data leakage warning:** Any feature that aggregates across the full time range must be computed per-fold within the training window. A global average computed once and applied to all folds allows test-period data to influence training features.

---

## Downsampling and Upsampling


Many classification problems have imbalanced classes — far more negatives than positives (e.g., fraud detection, churn prediction). Sampling strategies in SQL help address this before training.

### Downsample the majority class

    DECLARE @DownsampleRatio FLOAT = 0.1;  -- keep 10% of majority class

    -- Keep all minority class rows
    SELECT CustomerId, Label FROM CustomerFeatures WHERE Label = 1

    UNION ALL

    -- Keep a random (but deterministic) subset of majority class rows
    SELECT CustomerId, Label
    FROM CustomerFeatures
    WHERE Label = 0
      AND ABS(CAST(CAST(HASHBYTES('SHA2_256', CAST(CustomerId AS NVARCHAR(20)))
                        AS BINARY(8)) AS BIGINT)) % 100
          < CAST(@DownsampleRatio * 100 AS INT);

### Upsample the minority class (duplication)

Upsampling by duplication is simplest but adds no new information — the model sees repeated rows. It works best for ensemble methods (bagging) where repeated rows affect different trees.

    DECLARE @UpsampleFactor INT = 5;  -- repeat minority class 5x

    -- Majority class: keep all
    SELECT CustomerId, Label FROM CustomerFeatures WHERE Label = 0

    UNION ALL

    -- Minority class: repeat N times using CROSS JOIN with a number series
    SELECT c.CustomerId, c.Label
    FROM CustomerFeatures c
    CROSS JOIN (SELECT value FROM GENERATE_SERIES(1, @UpsampleFactor)) n  -- SQL Server 2022+
    WHERE c.Label = 1;

    -- Pre-2022: replace GENERATE_SERIES with a recursive CTE or a small reference table

> **Warning:** Upsample only the training set. If you upsample before splitting, duplicate rows from the minority class can appear in both train and test, which inflates recall metrics.

---

## See Also

- [feature-engineering.md](feature-engineering.md) — computing the features that go into these splits
- [data-leakage.md](data-leakage.md) — why random splits fail for temporal data
- [null-imputation.md](null-imputation.md) — imputing NULLs after splitting (impute on train, apply to test)

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [FROM Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql) — TABLESAMPLE clause syntax, REPEATABLE seed, page-level sampling behavior, and limitations (views, CTEs not supported)
[^2]: [HASHBYTES (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/hashbytes-transact-sql) — supported algorithms (SHA2_256, SHA2_512); MD5 and SHA1 deprecated since SQL Server 2016; returns VARBINARY
[^3]: [Ranking Functions (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/ranking-functions-transact-sql) — NTILE bucket distribution behavior when row count is not evenly divisible
[^4]: [GENERATE_SERIES (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/generate-series-transact-sql) — SQL Server 2022; generates integer/numeric series; requires compat level 160
[^5]: [Limiting Result Sets by Using TABLESAMPLE | Microsoft Learn](https://learn.microsoft.com/en-us/previous-versions/sql/sql-server-2008-r2/ms189108%28v=sql.105%29) — detailed TABLESAMPLE semantics including page-level granularity and reproducibility conditions

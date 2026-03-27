# NULL Imputation in T-SQL


Strategies for handling NULLs in feature columns before training. SQL Server's three-valued logic means NULLs affect aggregations in ways that surprise data scientists coming from pandas.

## Table of Contents

1. [Why NULLs Matter for ML](#why-nulls-matter-for-ml)
2. [NULL Behavior in Aggregations](#null-behavior-in-aggregations)
3. [Constant Fill](#constant-fill)
4. [Mean Imputation](#mean-imputation)
5. [Median Imputation](#median-imputation)
6. [Mode Imputation](#mode-imputation)
7. [Forward Fill](#forward-fill)
8. [NULL Indicator Features](#null-indicator-features)
9. [Choosing a Strategy](#choosing-a-strategy)
10. [See Also](#see-also)

---

## Why NULLs Matter for ML


Most ML frameworks (scikit-learn, XGBoost, PyTorch) cannot train on `NaN`/`None` values in feature columns without explicit handling. Pandas represents SQL NULLs as `NaN` for numeric columns and `None` for object columns. If you return NULL from SQL:

- `sklearn` estimators raise `ValueError: Input X contains NaN`.
- `XGBoost` handles NaN natively — it automatically learns the optimal split direction for missing values at each tree node. [^6] No configuration required, but the learned direction may not match your domain intent.
- Neural network frameworks will propagate NaN through gradients and produce `nan` loss immediately.

Imputing in SQL before export is preferable to imputing in Python because:
- The imputation logic is version-controlled alongside the feature query.
- Imputation statistics (mean, median, mode) computed from training rows can be materialized in SQL and reused at inference time.
- Large datasets are faster to transform in the database than to load into memory for Python-side imputation.

---

## NULL Behavior in Aggregations


SQL Server aggregate functions ignore NULLs — except `COUNT(*)`:

    CREATE TABLE #Ex (Amount DECIMAL(10,2) NULL);
    INSERT #Ex VALUES (100), (200), (NULL), (NULL), (300);

    SELECT
        COUNT(*)        AS AllRows,         -- 5
        COUNT(Amount)   AS NonNullRows,     -- 3
        SUM(Amount)     AS Total,           -- 600 (NULLs ignored)
        AVG(Amount)     AS Average,         -- 200 = 600/3  (NOT 120 = 600/5)
        MIN(Amount)     AS Minimum,         -- 100
        MAX(Amount)     AS Maximum          -- 300
    FROM #Ex;

**The AVG trap:** `AVG(Amount)` divides by the count of non-NULL values (3), not the total row count (5). If NULL means "the amount is unknown but non-zero", AVG gives the correct mean of known values. If NULL means "zero", use `AVG(COALESCE(Amount, 0))` to get 120.

This distinction matters enormously for feature quality. Know what NULL means in your domain before choosing an imputation strategy.


---

## Constant Fill


Replace NULL with a fixed value. The simplest strategy. Appropriate when:
- NULL means "not applicable" and the constant value is a natural sentinel (e.g., 0 for event count, 'Unknown' for category).
- The model is tree-based and can learn to split on the sentinel value separately.

    SELECT
        CustomerId,
        COALESCE(NumOrders, 0)          AS NumOrders,           -- missing = no orders
        COALESCE(LastCategory, 'None')  AS LastCategory,        -- missing = no category
        COALESCE(AccountScore, -1)      AS AccountScore         -- -1 = sentinel for missing
    FROM CustomerFeatures;

Use `COALESCE` (ANSI standard, accepts multiple arguments) rather than `ISNULL` (SQL Server extension, two arguments only). [^1] [^2] `COALESCE` also has better compatibility if you ever port the query.

> `ISNULL` silently truncates the replacement value to the length of the first argument. `ISNULL(CAST(NULL AS VARCHAR(5)), 'toolong')` returns `'toolon'`. Prefer `COALESCE` to avoid this gotcha.

---

## Mean Imputation


Replace NULL with the arithmetic mean. Appropriate for normally distributed features without extreme outliers. Preserves the column mean but reduces variance and distorts correlation structure.

### Global mean

    SELECT
        CustomerId,
        SessionDuration,
        COALESCE(
            SessionDuration,
            AVG(SessionDuration) OVER ()    -- mean of non-NULL rows
        ) AS SessionDuration_Imputed
    FROM UserSessions;

### Group-level mean (preferred when group structure exists)

Group-level imputation is more accurate when different groups have very different means — e.g., imputing purchase amount for mobile users with the mobile average rather than the global average.

    SELECT
        CustomerId,
        Platform,
        PurchaseAmount,
        COALESCE(
            PurchaseAmount,
            AVG(PurchaseAmount) OVER (PARTITION BY Platform)    -- mean within platform
        ) AS PurchaseAmount_Imputed
    FROM UserPurchases;

> **Data leakage warning:** `AVG(col) OVER ()` computed over the full dataset incorporates test-set values into the imputed mean. Compute the mean only from training rows, store it in a temp table, and join to both train and test:

    -- Step 1: compute mean from training rows only
    SELECT AVG(SessionDuration) AS GlobalMean
    INTO #ImputeStats
    FROM UserSessions
    WHERE Split = 'train';

    -- Step 2: apply to all rows
    SELECT s.*, COALESCE(s.SessionDuration, i.GlobalMean) AS SessionDuration_Imputed
    FROM UserSessions s
    CROSS JOIN #ImputeStats i;

---

## Median Imputation


Replace NULL with the median. More robust than mean for skewed distributions (e.g., revenue, session length). The median is less affected by outliers.

`PERCENTILE_CONT(0.5)` computes the continuous median — interpolating between adjacent values when the row count is even. `PERCENTILE_DISC(0.5)` returns the nearest actual value in the dataset.

### Global median

    SELECT
        CustomerId,
        OrderAmount,
        COALESCE(
            OrderAmount,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY OrderAmount) OVER ()
        ) AS OrderAmount_Imputed
    FROM Orders;

### Group-level median

    SELECT
        CustomerId,
        Category,
        OrderAmount,
        COALESCE(
            OrderAmount,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY OrderAmount)
                OVER (PARTITION BY Category)
        ) AS OrderAmount_Imputed
    FROM Orders;

`PERCENTILE_CONT` and `PERCENTILE_DISC` are available since SQL Server 2012. [^3] The `WITHIN GROUP (ORDER BY col)` clause is required — this is an ordered-set aggregate function, not a standard window function.

> **Data leakage warning:** Same as mean imputation — compute the median only from training rows and apply separately.

---

## Mode Imputation


Replace NULL with the most frequent (modal) value. Appropriate for categorical features and discrete numeric features.

    WITH ModeCTE AS (
        SELECT
            LastCategory,
            COUNT(*) AS Freq,
            ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS Rnk
        FROM CustomerFeatures
        WHERE LastCategory IS NOT NULL
          AND Split = 'train'     -- compute mode from training rows only
        GROUP BY LastCategory
    ),
    ModeValue AS (
        SELECT LastCategory AS ModeCategory
        FROM ModeCTE
        WHERE Rnk = 1
    )
    SELECT
        cf.CustomerId,
        COALESCE(cf.LastCategory, m.ModeCategory) AS LastCategory_Imputed
    FROM CustomerFeatures cf
    CROSS JOIN ModeValue m;

If there are ties for the most frequent value, `ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC)` picks one arbitrarily. To break ties deterministically, add a secondary sort: `ORDER BY COUNT(*) DESC, LastCategory ASC`.

### Group-level mode

    WITH GroupMode AS (
        SELECT
            Platform,
            LastCategory,
            ROW_NUMBER() OVER (
                PARTITION BY Platform
                ORDER BY COUNT(*) DESC, LastCategory ASC    -- tiebreak by alphabetic order
            ) AS Rnk
        FROM CustomerFeatures
        WHERE LastCategory IS NOT NULL
          AND Split = 'train'
        GROUP BY Platform, LastCategory
    )
    SELECT
        cf.CustomerId,
        cf.Platform,
        COALESCE(cf.LastCategory, gm.LastCategory) AS LastCategory_Imputed
    FROM CustomerFeatures cf
    LEFT JOIN GroupMode gm
        ON gm.Platform = cf.Platform
       AND gm.Rnk = 1;

---

## Forward Fill


Forward fill (last observation carried forward, LOCF) propagates the last non-NULL value in a time-ordered sequence. Appropriate for sensor readings, prices, or any time series where a NULL means "no change since the last known value."

**SQL Server 2022+** supports `LAG(col, 1) IGNORE NULLS OVER (...)`, which makes forward fill trivial: [^4]

    SELECT
        SensorId,
        ReadingTime,
        Temperature,
        LAG(Temperature, 1) IGNORE NULLS OVER (
            PARTITION BY SensorId ORDER BY ReadingTime
        ) AS Temperature_FFill
    FROM SensorReadings
    WHERE ReadingTime < @SnapshotDate;

Note that `IGNORE NULLS` returns the most recent non-NULL *prior* row. If the current row is non-NULL, `LAG` still returns the prior row. To keep the current value when non-NULL and fill only NULLs, wrap it:

    COALESCE(
        Temperature,
        LAG(Temperature, 1) IGNORE NULLS OVER (
            PARTITION BY SensorId ORDER BY ReadingTime
        )
    ) AS Temperature_FFill

**On SQL Server 2019 and earlier**, `IGNORE NULLS` is not available. Use the two-step window technique instead: [^5]

    WITH Groups AS (
        SELECT
            SensorId,
            ReadingTime,
            Temperature,
            -- COUNT on a nullable column counts only non-NULL rows
            -- This creates a monotonically increasing group number within each sensor
            -- that increments only when a new non-NULL value appears
            COUNT(Temperature) OVER (
                PARTITION BY SensorId
                ORDER BY ReadingTime
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS FillGroup
        FROM SensorReadings
        WHERE ReadingTime < @SnapshotDate
    )
    SELECT
        SensorId,
        ReadingTime,
        Temperature,
        -- Within each fill group, MAX returns the one non-NULL temperature
        -- and propagates it to all NULL rows in the same group
        MAX(Temperature) OVER (
            PARTITION BY SensorId, FillGroup
        ) AS Temperature_FFill
    FROM Groups;

**How the fill group trick works:**

- `COUNT(Temperature) OVER (...ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` counts only non-NULL Temperature values up to and including the current row.
- When a row has NULL Temperature, the count stays the same as the previous non-NULL row — so all NULLs following a non-NULL value share the same `FillGroup`.
- `MAX(Temperature) OVER (PARTITION BY SensorId, FillGroup)` picks up the single non-NULL value in the group and fills it into all other rows in that group.

> **Warning:** Always `PARTITION BY` the entity (`SensorId` above). Without it, the last non-NULL value from one sensor bleeds forward into rows belonging to a different sensor.

**What pandas sees after a correct forward fill:**

    df = pd.read_sql("SELECT SensorId, ReadingTime, Temperature_FFill", conn)
    # No NaN values in Temperature_FFill except where the very first rows per sensor are NULL

---

## NULL Indicator Features


Before imputing, add a binary column flagging whether the original value was NULL. This allows the model to learn that missingness itself is a signal — for example, customers who never set a preference may behave differently from those who set and then cleared one.

    SELECT
        CustomerId,
        PhoneNumber,
        LastLoginDate,
        ReferralSource,
        -- Imputed values
        COALESCE(PhoneNumber,    'Unknown')  AS PhoneNumber_Imputed,
        COALESCE(LastLoginDate,  @SnapshotDate) AS LastLoginDate_Imputed,
        COALESCE(ReferralSource, 'Direct')   AS ReferralSource_Imputed,
        -- NULL indicators (1 = was missing, 0 = was present)
        CASE WHEN PhoneNumber    IS NULL THEN 1 ELSE 0 END  AS PhoneNumber_Missing,
        CASE WHEN LastLoginDate  IS NULL THEN 1 ELSE 0 END  AS LastLoginDate_Missing,
        CASE WHEN ReferralSource IS NULL THEN 1 ELSE 0 END  AS ReferralSource_Missing
    FROM CustomerFeatures;

Add a NULL indicator whenever:
- Missingness is non-random (MAR or MNAR rather than MCAR in stats terminology)
- The column has significant NULL rates (> 5%)
- You suspect the reason for missingness is itself informative

---

## Choosing a Strategy

| Strategy | When to use | Watch out for |
|---|---|---|
| Constant fill (0, -1) | Counts, flags, categoricals where "missing" = "zero" or "none" | Sentinel values can confuse distance-based models |
| Constant fill ('Unknown') | Low-cardinality categoricals | Model must handle an extra category at inference |
| Mean | Normally distributed numeric, < 10% missing | Outliers inflate the mean; reduces variance |
| Median | Skewed numeric (revenue, durations) | More expensive to compute; may not match test distribution |
| Mode | Categorical | Multiple modes require a tiebreaker rule |
| Forward fill | Time-ordered sequences (sensor, price, status) | Requires ordering; crosses entity boundaries without PARTITION BY |
| NULL indicator | Any high-NULL column where missingness has meaning | Doubles column count; adds little if missingness is truly random |

All strategies share one rule: **compute imputation statistics from training rows only, then apply those statistics to test rows.** Imputing before splitting lets test-set values influence what gets imputed into training rows — a subtle but real form of data leakage.

---

## See Also

- [feature-engineering.md](feature-engineering.md) — features that may contain NULLs
- [data-leakage.md](data-leakage.md) — how imputation causes train/test leakage
- [sampling-splitting.md](sampling-splitting.md) — splitting before imputation

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [COALESCE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/coalesce-transact-sql) — returns first non-NULL expression; result type follows data type precedence; expanded to CASE internally
[^2]: [ISNULL (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/isnull-transact-sql) — replaces NULL with a specified value; result type matches first argument (may silently truncate replacement)
[^3]: [PERCENTILE_CONT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/percentile-cont-transact-sql) — continuous percentile with interpolation; requires WITHIN GROUP (ORDER BY); supports OVER (PARTITION BY)
[^4]: [LAG (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/lag-transact-sql) — offset access to prior rows; IGNORE NULLS available in SQL Server 2022+ for forward-fill scenarios
[^5]: [Four ways to forward-fill values in T-SQL](https://www.andrewvillazon.com/forward-fill-values-t-sql/) — Andrew Villazon; covers the COUNT/MAX fill-group technique and alternatives for pre-2022 SQL Server
[^6]: [XGBoost FAQ — Missing Values](https://xgboost.readthedocs.io/en/stable/faq.html) — XGBoost handles NaN natively by learning the optimal split direction for missing values at each tree node; no explicit configuration required

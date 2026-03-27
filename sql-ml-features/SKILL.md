---
name: sql-ml-features
description: "Use when preparing data for machine learning from SQL Server — feature engineering in T-SQL, building training/test datasets, statistical aggregations for ML pipelines, sampling strategies, data normalization and encoding in SQL, writing queries that feed pandas or scikit-learn, exporting to Parquet or CSV for model training, or when a data scientist asks for a 'feature table' or 'training set' from a SQL Server database."
---

# SQL for Machine Learning


Patterns for extracting ML-ready features from SQL Server — turning normalized relational data into the wide, denormalized, NULL-free datasets that models consume.

## When to Use

- Building a feature table or training dataset from application data
- Feature engineering in T-SQL (rolling aggregations, lag features, RFM scoring)
- Encoding categorical variables (one-hot, ordinal, frequency encoding)
- Handling NULLs for ML (imputation strategies in SQL)
- Sampling and train/test splitting from SQL Server
- Exporting large datasets to CSV, Parquet, or pandas
- Preventing data leakage in temporal feature queries
- Writing queries that feed scikit-learn, XGBoost, or PyTorch pipelines

**When NOT to use:** application schema design (table design, naming conventions, access control), query performance tuning (execution plans, index tuning, wait stats), BI dashboards and summary reports (GROUPING SETS, pivot tables, dashboard queries), or running R/Python inside SQL Server (SQL Server ML Services).

## Feature Table Build Workflow

Follow these steps in order. Each step has a validation checkpoint.

1. **Set snapshot date** — Anchor all features to a fixed `@SnapshotDate`. Never use `GETDATE()` inside feature queries.
   - _Validate:_ `SELECT @SnapshotDate` returns the intended date.

2. **Build base entity table** — `SELECT DISTINCT` the entity key into a temp table `#Base`. One row per entity, primary key only — no features yet.
    ```sql
    SELECT DISTINCT CustomerId
    INTO #Base
    FROM Customers
    WHERE SignupDate < @SnapshotDate;
    ```
   - _Validate:_ `SELECT COUNT(*), COUNT(DISTINCT CustomerId) FROM #Base` — counts must match (no duplicates).

3. **Join features with temporal bounds** — LEFT JOIN each feature set to `#Base`. Bound every join with `AND EventDate <= @SnapshotDate`.
    ```sql
    SELECT b.CustomerId,
           DATEDIFF(DAY, f.LastOrder, @SnapshotDate) AS Recency,
           f.OrderCount AS Frequency
    FROM #Base b
    LEFT JOIN FeatureCTE f ON f.CustomerId = b.CustomerId;
    ```
   - _Validate:_ Row count equals `#Base` row count. No feature references dates after `@SnapshotDate`.

4. **Impute NULLs** — Replace every NULL with an explicit value. Use `COALESCE` with mean, median, zero, or a sentinel depending on the column semantics.
   - _Validate:_ `SELECT SUM(CASE WHEN col IS NULL THEN 1 ELSE 0 END) FROM FeatureTable` returns 0 for every column.

5. **Encode categoricals** — One-hot, ordinal, or frequency encode all non-numeric columns.
   - _Validate:_ `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'FeatureTable'` — all columns are numeric types (`int`, `float`, `decimal`, `bit`).

6. **Split train/test** — Use hash-based split for cross-sectional data or cutoff-date split for time series.
   - _Validate:_ `SELECT SplitLabel, COUNT(*) FROM FeatureTable GROUP BY SplitLabel` — verify expected proportions (e.g., 80/20).

7. **Export** — BCP, `pandas.read_sql`, or `FOR JSON` depending on the consumer.

## Feature Engineering Taxonomy

| Category | Examples | T-SQL tools |
|---|---|---|
| Numeric | Raw values, `LOG(col + 1)` for skewed, ratios, z-scores | `LOG(col + 1)`, `SQRT`, window `AVG`/`STDEV` |
| Categorical | One-hot encoding, ordinal, frequency | `CASE`, `PIVOT`, `DENSE_RANK`, COUNT ratios |
| Temporal | Recency, duration, day-of-week | `DATEDIFF`, `DATEPART`, `DATENAME` |
| Rolling window | 7-day sum, 30-day average | `SUM/AVG OVER (ROWS BETWEEN ...)` |
| Lag / offset | Previous value, delta from prior | `LAG`, `LEAD` |
| Interaction | Product, ratio of two features | Computed expressions in SELECT |
| Text signals | Length, keyword presence | `LEN`, `CHARINDEX`, `PATINDEX` |
| Missingness | Is this value missing? | `CASE WHEN col IS NULL THEN 1 ELSE 0 END` |

## Quick Reference: SQL Pattern → ML Concept

| ML concept | T-SQL pattern |
|---|---|
| Recency feature | `DATEDIFF(DAY, LastEventDate, @SnapshotDate)` |
| Frequency feature | `COUNT(*) OVER (PARTITION BY entity ORDER BY dt ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)` |
| Rolling 7-day revenue | `SUM(Amount) OVER (ORDER BY OrderDate ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)` |
| Lag feature (t-1) | `LAG(Amount, 1) OVER (PARTITION BY CustomerId ORDER BY OrderDate)` |
| One-hot encode | `CASE WHEN Category = 'A' THEN 1 ELSE 0 END AS Category_A` |
| Ordinal encode | `DENSE_RANK() OVER (ORDER BY Category)` |
| Frequency encode | `COUNT(*) OVER (PARTITION BY Category) * 1.0 / COUNT(*) OVER ()` |
| Log transform | `LOG(Amount + 1)` — the `+1` offset handles zero values; omit only when zeros are impossible |
| Quantile bucket | `NTILE(10) OVER (ORDER BY Score)` |
| Row hash for split | 5-step chain: (1) `CAST(Id AS NVARCHAR(20))` → (2) `HASHBYTES('SHA2_256', ...)` → (3) `CAST(... AS BINARY(8))` → (4) `CAST(... AS BIGINT)` → (5) `ABS(...) % 10` |
| Mean imputation | `COALESCE(col, AVG(col) OVER ())` |
| Median imputation | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col) OVER ()` |
| NULL indicator | `CASE WHEN col IS NULL THEN 1 ELSE 0 END AS col_is_missing` |
| Min-max scaling | `(col - MIN(col) OVER ()) / NULLIF(MAX(col) OVER () - MIN(col) OVER (), 0)` |
| Date bucketing | `DATE_BUCKET(WEEK, 1, EventDate)` (SQL Server 2022+) |
| Date truncation | `DATETRUNC(MONTH, EventDate)` (SQL Server 2022+) |
| First value in series | `FIRST_VALUE(col) OVER (PARTITION BY entity ORDER BY dt ROWS UNBOUNDED PRECEDING)` |
| Rolling volatility | `STDEV(col) OVER (PARTITION BY entity ORDER BY dt ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)` |

## Common Mistakes

| Mistake | What goes wrong | Fix |
|---|---|---|
| Using `AVG(col)` without understanding NULL exclusion | AVG divides by non-NULL count, not row count — mean is inflated when NULLs represent zeros | Use `AVG(COALESCE(col, 0))` when NULLs mean zero |
| Rolling window with `RANGE` instead of `ROWS` | Tied timestamps include extra rows, producing different counts per row | Always use `ROWS BETWEEN n PRECEDING AND CURRENT ROW` |
| Joining to future events in feature query | Leaks information that wasn't available at prediction time | Bound all joins with `AND EventDate <= @SnapshotDate` |
| Computing global statistics before the train/test split | Mean and variance incorporate test data into training features | Compute statistics only over training rows |
| Using `LAG` without checking temporal order | LAG requires `ORDER BY` — missing it gives non-deterministic offsets | Always include `PARTITION BY entity ORDER BY timestamp` |
| Forward-filling sensor NULLs across entity boundaries | PARTITION BY is missing, so last value bleeds across entities | Always `PARTITION BY entity_id` in forward-fill window |
| HASHBYTES on `NULL` key | `HASHBYTES(algo, NULL)` returns NULL — entity lands in no split | Exclude or handle NULL keys before splitting |
| UNPIVOT for categorical to indicator columns | `UNPIVOT` silently drops NULL values | Use `CROSS APPLY VALUES` to preserve NULLs as zeros |
| Random split for time-series data | Test set leaks future patterns into training window | Use a cutoff date for time-series train/test split |
| Including the label column in lag features | `LAG(label)` leaks ground truth about adjacent rows | Exclude any derivative of the target from feature set |

## Reference Files

- [Feature Engineering](references/feature-engineering.md) — numeric, categorical, temporal, rolling windows, lag, RFM, text
- [Sampling and Splitting](references/sampling-splitting.md) — TABLESAMPLE, hash-based splits, NTILE k-fold, stratified, time-based
- [NULL Imputation](references/null-imputation.md) — mean/median/mode/forward-fill/constant, missingness indicators
- [Export Patterns](references/export-patterns.md) — BCP, pandas.read_sql, chunked reads, FOR JSON, Parquet, feature stores
- [Data Leakage](references/data-leakage.md) — temporal, target, train/test leakage; prevention patterns in SQL

# Intelligent Query Processing (IQP)

SQL Server's adaptive query execution framework that automatically improves performance without code changes.

## Table of Contents

- [When to Use](#when-to-use)
- [IQP Feature Matrix by Version](#iqp-feature-matrix-by-version)
- [Memory Grant Feedback](#memory-grant-feedback)
  - [Batch Mode MGF (2017+)](#batch-mode-mgf-2017)
  - [Row Mode MGF (2019+)](#row-mode-mgf-2019)
  - [Percentile MGF (2022+)](#percentile-mgf-2022)
  - [MGF Persistence (2022+)](#mgf-persistence-2022)
- [Batch Mode on Rowstore (2019+)](#batch-mode-on-rowstore-2019)
- [Interleaved Execution for mTVF (2017+)](#interleaved-execution-for-mtvf-2017)
- [Approximate Count Distinct (2019+)](#approximate-count-distinct-2019)
- [Table Variable Deferred Compilation (2019+)](#table-variable-deferred-compilation-2019)
- [Scalar UDF Inlining (2019+)](#scalar-udf-inlining-2019)
- [DOP Feedback (2022+)](#dop-feedback-2022)
- [CE Feedback (2022+)](#ce-feedback-2022)
- [Parameter Sensitive Plan Optimization (2022+)](#parameter-sensitive-plan-optimization-2022)
- [How to Verify IQP Is Active](#how-to-verify-iqp-is-active)
- [Disabling IQP Features](#disabling-iqp-features)
- [IQP and Query Store](#iqp-and-query-store)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use

IQP features are **on by default** at the appropriate compatibility level — you generally do not enable them manually. The primary actions are:

- Upgrade the database compatibility level to access newer IQP features
- Monitor Query Store to confirm features are firing (or to diagnose regressions)
- Selectively disable features that cause regressions using hints or trace flags
- Verify features are active when queries still exhibit known IQP-addressable problems

IQP is **not** a substitute for proper indexing, statistics maintenance, or query rewrites. It improves adaptive behavior at runtime; it cannot overcome fundamentally broken query designs.

---

## IQP Feature Matrix by Version

| Feature | Min Compat Level | SQL Server Version | Description |
|---|---|---|---|
| Adaptive Joins | 140 | 2017 | Switch between Nested Loop and Hash Join at runtime |
| Batch Mode Memory Grant Feedback | 140 | 2017 | Adjust memory grants for columnstore queries across executions |
| Interleaved Execution (mTVF) | 140 | 2017 | Use actual row count from mTVF before compiling rest of plan |
| Table Variable Deferred Compilation | 150 | 2019 | Use actual table variable rowcount at runtime compile |
| Batch Mode on Rowstore | 150 | 2019 | Use batch mode execution without columnstore index |
| Scalar UDF Inlining | 150 | 2019 | Inline eligible scalar UDFs as derived tables |
| Approximate Count Distinct | 150 | 2019 | `APPROX_COUNT_DISTINCT` using HyperLogLog |
| Row Mode Memory Grant Feedback | 150 | 2019 | Extend MGF to row-mode (non-columnstore) operators |
| Memory Grant Feedback Percentile | 160 | 2022 | Use percentile-based grant sizing for stability |
| Memory Grant Feedback Persistence | 160 | 2022 | Persist MGF adjustments to Query Store |
| DOP Feedback | 160 | 2022 | Reduce DOP for parallel queries that don't benefit |
| CE Feedback | 160 | 2022 | Adjust CE model assumptions per query using QS |
| Parameter Sensitive Plan Optimization (PSPO) | 160 | 2022 | Multiple plan variants for skewed parameter distributions |
| Optimized Plan Forcing | 160 | 2022 | Store and reuse forced plan compilation artifacts |
| Cardinality Estimation (CE) model 160 | 160 | 2022 | Default CE model updated from 150 |

> [!NOTE] SQL Server 2022
> Compatibility level 160 unlocks the most adaptive features: percentile MGF, DOP feedback, CE feedback, PSPO, and optimized plan forcing. All require `ALTER DATABASE [db] SET COMPATIBILITY_LEVEL = 160`.

> [!NOTE] SQL Server 2025
> Additional IQP features are expected in SQL Server 2025. Consult release notes when available as some features may be preview at GA.

---

## Memory Grant Feedback

Memory grants are the memory SQL Server reserves before executing a query for sort and hash operations. Over-granting wastes buffer pool; under-granting causes spills to tempdb.

### Batch Mode MGF (2017+)

**Compatibility level 140.** Applies to queries with columnstore indexes or batch mode operators.

- On first execution: initial grant based on estimated rows
- On second+ execution: grant is adjusted based on actual memory used
- Grant can be **reduced** (over-grant detected) or **increased** (spill detected)
- Feedback is stored in the plan cache entry; lost when plan is evicted
- If grant oscillates between two values, MGF is disabled for that query

```sql
-- Check if MGF fired for recent queries
SELECT  q.query_id,
        p.plan_id,
        rs.avg_query_max_used_memory,
        rs.last_query_max_used_memory,
        p.query_plan
FROM    sys.query_store_plan         AS p
JOIN    sys.query_store_query        AS q  ON q.query_id = p.query_id
JOIN    sys.query_store_runtime_stats AS rs ON rs.plan_id = p.plan_id
WHERE   p.query_plan LIKE '%MemoryGrantFeedbackAdjusted%'
ORDER BY rs.last_execution_time DESC;
```

### Row Mode MGF (2019+)

**Compatibility level 150.** Extends memory grant feedback to row-mode operators (Sort, Hash Match without columnstore).

Same feedback loop as batch mode MGF. Most OLTP queries on heap/B-tree tables benefit from this.

### Percentile MGF (2022+)

**Compatibility level 160.** Replaces simple feedback with a percentile-based algorithm.

**Problem with prior MGF:** A single execution with an unusual parameter causes MGF to reduce the grant permanently, leading to spills on all future executions with normal parameters.

**Percentile solution:** Maintains a histogram of memory usage across recent executions. The grant is set to a high percentile (e.g., 70th or 85th percentile) rather than the last execution's value, giving stability without large over-grants.

```sql
-- Check percentile MGF state in Query Store
SELECT  q.query_id,
        pf.plan_feedback_id,
        pf.feature_desc,
        pf.feedback_data,
        pf.state_desc
FROM    sys.query_store_plan_feedback AS pf
JOIN    sys.query_store_plan         AS p  ON p.plan_id = pf.plan_id
JOIN    sys.query_store_query        AS q  ON q.query_id = p.query_id
WHERE   pf.feature_desc = 'MemoryGrantFeedback';
```

### MGF Persistence (2022+)

**Compatibility level 160.** Prior to 2022, MGF data lived only in the plan cache and was lost on plan eviction or server restart.

In 2022, MGF adjustments are persisted to Query Store (`sys.query_store_plan_feedback`), so feedback survives restarts and plan evictions.

```sql
-- Disable MGF persistence for a specific query
EXEC sys.sp_query_store_set_hints
    @query_id = 42,
    @query_hints = N'OPTION(DISABLE_TSQL_SCALAR_UDF_INLINING)';
-- (use DISABLE_OPTIMIZED_PLAN_FORCING or relevant hint for MGF)

-- Disable percentile mode instance-wide (use only for regression)
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERCENTILE = OFF;

-- Disable persistence instance-wide
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERSISTENCE = OFF;
```

---

## Batch Mode on Rowstore (2019+)

**Compatibility level 150.** Allows the query processor to use batch mode execution for hash joins and aggregates **without a columnstore index**.

Batch mode processes ~900 rows at a time rather than one row at a time, reducing CPU overhead significantly for analytical queries on traditional B-tree indexes.

**Optimizer decides:** The optimizer automatically chooses batch mode when it estimates the batch-mode path is cheaper. It does not always activate — typically requires larger row counts and aggregate/join-heavy patterns.

```sql
-- Verify batch mode is active (look for Actual Execution Mode = Batch in plan XML)
SELECT  qs.sql_text,
        TRY_CAST(qp.query_plan AS XML).value(
            '(//RelOp/@EstimatedExecutionMode)[1]',
            'NVARCHAR(20)') AS estimated_mode
FROM    sys.dm_exec_query_stats  AS qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) AS qp
WHERE   st.text LIKE '%YourQueryKeyword%';
```

**When batch mode on rowstore does NOT activate:**
- Small row counts (optimizer prefers row mode for small tables)
- Scalar UDFs in the query (unless UDF inlining applies)
- Queries that are already fast enough that the cost model prefers row mode
- Queries with certain unsupported operators

```sql
-- Force batch mode on rowstore for testing
SELECT  SalesOrderID,
        SUM(LineTotal) AS Total
FROM    Sales.SalesOrderDetail
OPTION (USE HINT('DISALLOW_BATCH_MODE'));  -- disable it

-- Disable batch mode on rowstore for a database
ALTER DATABASE SCOPED CONFIGURATION SET BATCH_MODE_ON_ROWSTORE = OFF;
```

> [!WARNING] Regression risk
> Batch mode on rowstore can occasionally produce slower plans for queries the optimizer mis-estimates. If a query regresses after upgrading compat level to 150, check whether batch mode is the cause.

---

## Interleaved Execution for mTVF (2017+)

**Compatibility level 140.** Before 2017, multi-statement TVF (mTVF) row count estimates were always 100 rows (or 1 row in older versions), leading to severely under-provisioned downstream plans.

**Interleaved execution** pauses compilation at the mTVF invocation, executes the mTVF, observes the actual row count returned, and then **resumes compilation** for the rest of the query using the real cardinality.

```sql
-- Example: mTVF whose actual rows differ wildly from 100
SELECT  c.CustomerID,
        c.AccountNumber,
        f.OrderTotal
FROM    Sales.Customer AS c
CROSS APPLY dbo.fn_GetCustomerOrders(c.CustomerID) AS f  -- mTVF
WHERE   f.OrderTotal > 1000;

-- Verify interleaved execution in the plan
-- Look for: ContainsInterleavedExecutionCandidates="true" in XML
SELECT  qs.plan_handle,
        TRY_CAST(qp.query_plan AS XML).value(
            '(//@ContainsInterleavedExecutionCandidates)[1]',
            'NVARCHAR(5)') AS interleaved
FROM    sys.dm_exec_query_stats    AS qs
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) AS qp
WHERE   TRY_CAST(qp.query_plan AS XML).value(
            '(//@ContainsInterleavedExecutionCandidates)[1]',
            'NVARCHAR(5)') = 'true';
```

**Interleaved execution only applies to mTVFs**, not inline TVFs (which are expanded inline before compilation) and not scalar UDFs. See also: [07-functions.md](07-functions.md) for the mTVF vs iTVF comparison.

```sql
-- Disable interleaved execution for a specific query
SELECT * FROM dbo.MyMTVF(1)
OPTION (USE HINT('DISABLE_INTERLEAVED_EXECUTION_TVF'));

-- Disable database-wide
ALTER DATABASE SCOPED CONFIGURATION SET INTERLEAVED_EXECUTION_TVF = OFF;
```

---

## Approximate Count Distinct (2019+)

**Compatibility level 150.** `APPROX_COUNT_DISTINCT` uses the HyperLogLog algorithm to return an approximate distinct count with up to ~2% error rate, but at a fraction of the memory and CPU of `COUNT(DISTINCT col)`.

```sql
-- Exact: can require large memory grant for DISTINCT sort/hash
SELECT COUNT(DISTINCT CustomerID) FROM Sales.SalesOrderHeader;

-- Approximate: much faster for large data sets
SELECT APPROX_COUNT_DISTINCT(CustomerID) FROM Sales.SalesOrderHeader;

-- Useful for dashboards, cardinality estimation, analytics pipelines
-- where exact count is not required
SELECT  YEAR(OrderDate)          AS OrderYear,
        APPROX_COUNT_DISTINCT(CustomerID) AS ApproxUniqueCustomers
FROM    Sales.SalesOrderHeader
GROUP BY YEAR(OrderDate)
ORDER BY OrderYear;
```

**When to use:** Large fact tables where `COUNT(DISTINCT)` causes memory spills or significant sort overhead. Error rate is guaranteed at ≤2% with 97% probability.

**When NOT to use:** Billing reconciliation, audit counts, or any context where exact results are required.

---

## Table Variable Deferred Compilation (2019+)

**Compatibility level 150.** Before 2019, table variables always had a cardinality estimate of 1 row at compile time, regardless of actual content — causing seriously wrong plans when they contained many rows.

**Deferred compilation** defers compilation of statements that reference table variables until after the table variable is populated, using the **actual row count** as the estimate.

```sql
DECLARE @Orders TABLE (
    OrderID   INT,
    Total     MONEY,
    OrderDate DATE
);

INSERT INTO @Orders
SELECT SalesOrderID, SubTotal, OrderDate
FROM   Sales.SalesOrderHeader
WHERE  OrderDate >= '2023-01-01';  -- may return millions of rows

-- With deferred compilation (compat 150), this uses actual row count
SELECT  o.OrderID, o.Total
FROM    @Orders AS o
JOIN    Sales.SalesOrderDetail AS d ON d.SalesOrderID = o.OrderID
WHERE   o.Total > 5000
ORDER BY o.Total DESC;
```

> [!NOTE] SQL Server 2019
> Deferred compilation applies per-statement: each statement referencing the table variable gets its own compilation that uses the then-current row count. A statement that runs when the table variable is empty still gets estimate = 0.

```sql
-- Disable for a specific query
SELECT * FROM @t AS t
OPTION (USE HINT('DISABLE_DEFERRED_COMPILATION_TV'));

-- Disable database-wide
ALTER DATABASE SCOPED CONFIGURATION SET DEFERRED_COMPILATION_TV = OFF;
```

See also: [34-tempdb.md](34-tempdb.md) for temp table vs table variable performance discussion.

---

## Scalar UDF Inlining (2019+)

**Compatibility level 150.** Eligible scalar UDFs are transformed into equivalent subquery expressions (derived tables) at compile time, allowing the optimizer to reason about them, apply predicates early, and use set-based execution.

Without inlining, scalar UDFs are called once per row in a serial loop, preventing parallelism and batching.

```sql
-- Scalar UDF example
CREATE OR ALTER FUNCTION dbo.fn_GetCustomerCategory(@CustomerID INT)
RETURNS NVARCHAR(20)
WITH SCHEMABINDING
AS
BEGIN
    DECLARE @Category NVARCHAR(20);
    SELECT @Category = Category
    FROM   dbo.CustomerSegments
    WHERE  CustomerID = @CustomerID;
    RETURN @Category;
END;

-- With inlining (compat 150), the function is expanded inline:
-- roughly equivalent to: CROSS APPLY (SELECT Category FROM dbo.CustomerSegments WHERE CustomerID = c.CustomerID) AS cs
SELECT c.CustomerID, dbo.fn_GetCustomerCategory(c.CustomerID) AS Category
FROM   Sales.Customer AS c;
```

**Eligibility requirements (a function must satisfy ALL):**
- Returns a scalar value (single column, single row)
- Contains only a `RETURN` statement with a single `SELECT`
- No multiple statements, no local variables
- No EXECUTE
- No recursive calls
- No CLR
- No OUTPUT parameters
- No `ROWSET`-returning calls
- No `sys.*` or `INFORMATION_SCHEMA.*` access that produces rowsets
- No `TOP`, `OFFSET...FETCH` in the UDF SELECT (in certain cases)
- No aggregates with DISTINCT in the UDF (in older 2019 builds)

```sql
-- Check if a UDF is inlineable
SELECT name, is_inlineable
FROM   sys.sql_modules
WHERE  object_id = OBJECT_ID('dbo.fn_GetCustomerCategory');

-- Disable inlining for a specific UDF (useful during regression investigation)
ALTER FUNCTION dbo.fn_GetCustomerCategory(@CustomerID INT)
RETURNS NVARCHAR(20)
WITH SCHEMABINDING, INLINE = OFF
AS
...

-- Disable inlining for a specific query
SELECT dbo.fn_GetCustomerCategory(CustomerID)
FROM   Sales.Customer
OPTION (USE HINT('DISABLE_TSQL_SCALAR_UDF_INLINING'));

-- Disable database-wide
ALTER DATABASE SCOPED CONFIGURATION SET TSQL_SCALAR_UDF_INLINING = OFF;
```

> [!WARNING] Inlining changes behavior
> Some UDFs rely on serial row-by-row semantics (e.g., INSERT into a log table per row). Inlining may change execution semantics. Test thoroughly before relying on inlining for UDFs with side effects.

See also: [07-functions.md](07-functions.md) for full scalar UDF inlining reference with eligibility table.

---

## DOP Feedback (2022+)

**Compatibility level 160.** Automatically reduces the degree of parallelism (DOP) for queries where parallelism provides little benefit (high worker skew, short parallel execution, excessive synchronization overhead).

DOP feedback works through **Query Store**:
- SQL Server profiles parallel query executions
- If it detects that a lower DOP achieves similar performance with less CPU overhead, it records a DOP hint in `sys.query_store_plan_feedback`
- The reduced DOP is applied on subsequent executions
- If the reduced DOP causes performance degradation, it reverts

```sql
-- Check DOP feedback state
SELECT  q.query_id,
        pf.plan_feedback_id,
        pf.feature_desc,
        pf.feedback_data,
        pf.state_desc
FROM    sys.query_store_plan_feedback AS pf
JOIN    sys.query_store_plan         AS p  ON p.plan_id = pf.plan_id
JOIN    sys.query_store_query        AS q  ON q.query_id = p.query_id
WHERE   pf.feature_desc = 'DopFeedback';

-- Disable DOP feedback database-wide
ALTER DATABASE SCOPED CONFIGURATION SET DOP_FEEDBACK = OFF;
```

> [!NOTE] SQL Server 2022
> DOP feedback requires Query Store to be enabled (`READ_WRITE` mode). Without Query Store, DOP feedback cannot persist its adjustments.

**When DOP feedback helps:**
- Queries with high `CXPACKET`/`CXCONSUMER` wait stats
- Short queries that are parallelized unnecessarily
- Queries with high worker skew (one thread does most of the work)

**When DOP feedback does NOT help:**
- Queries that genuinely benefit from parallelism (large scans, big aggregations)
- Queries already running at DOP 1

---

## CE Feedback (2022+)

**Compatibility level 160.** The cardinality estimator can detect when its assumptions produce consistently poor estimates, and automatically adjust its model assumptions for a specific query.

CE feedback works through **Query Store**:
- SQL Server compares estimated vs actual rows across executions
- If a specific CE assumption (e.g., correlation, containment, join) is consistently wrong, it records a feedback hint
- Hints are stored in `sys.query_store_query_hints`
- On future compilations, the hint adjusts the CE model

```sql
-- Check CE feedback hints
SELECT  q.query_id,
        qh.query_hint_id,
        qh.query_hint_text,
        qh.source_desc
FROM    sys.query_store_query_hints AS qh
JOIN    sys.query_store_query       AS q ON q.query_id = qh.query_id
WHERE   qh.source_desc = 'CE_FEEDBACK';

-- Disable CE feedback database-wide
ALTER DATABASE SCOPED CONFIGURATION SET CE_FEEDBACK = OFF;
```

CE feedback is a **last resort** mechanism — it should not replace proper statistics maintenance or query fixes. If CE feedback is firing extensively, investigate statistics quality first.

See also: [30-query-store.md](30-query-store.md) for CE feedback monitoring.

---

## Parameter Sensitive Plan Optimization (2022+)

**Compatibility level 160.** PSPO addresses the parameter sniffing problem where a single cached plan is suboptimal for some parameter values.

**How it works:**
1. SQL Server identifies "high-value skew" predicates in WHERE clauses
2. Compiles **multiple plan variants** (called "dispatcher" + "variant" plans) for different parameter ranges
3. At execution time, the dispatcher selects the appropriate variant based on actual parameter value
4. Each variant plan is cached and managed independently in Query Store

```sql
-- Example: skewed CustomerID distribution
CREATE PROCEDURE dbo.GetOrdersByCustomer @CustomerID INT
AS
SELECT  o.SalesOrderID,
        o.OrderDate,
        o.SubTotal
FROM    Sales.SalesOrderHeader AS o
WHERE   o.CustomerID = @CustomerID;
GO

-- With PSPO (compat 160), SQL Server may compile:
-- Variant 1: CustomerID values with few rows → Index Seek + Nested Loops
-- Variant 2: CustomerID values with many rows → Index Scan + Hash Join
-- The dispatcher plan routes at runtime based on @CustomerID

-- Check for PSPO plan variants in Query Store
SELECT  q.query_id,
        p.plan_id,
        p.plan_type,
        p.plan_type_desc,
        p.is_forced_plan
FROM    sys.query_store_plan  AS p
JOIN    sys.query_store_query AS q ON q.query_id = p.query_id
WHERE   p.plan_type <> 1  -- exclude regular plans (1 = compiled plan)
ORDER BY q.query_id, p.plan_type;
```

**Plan type values:**
| plan_type | plan_type_desc | Description |
|---|---|---|
| 1 | Compiled Plan | Regular cached plan |
| 2 | Dispatcher Plan | PSPO routing plan |
| 3 | Query Variant Plan | PSPO variant plan |

```sql
-- Disable PSPO for a specific query (use Query Store hint)
EXEC sys.sp_query_store_set_hints
    @query_id   = 42,
    @query_hints = N'OPTION(DISABLE_PARAMETER_SNIFFING)';

-- Disable PSPO database-wide
ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SENSITIVE_PLAN_OPTIMIZATION = OFF;
```

> [!NOTE] SQL Server 2022
> PSPO is not a complete solution for all parameter sniffing problems. It fires only when the optimizer detects high-value skew during initial compilation. Queries without obvious skew patterns still benefit from manual approaches like `OPTION(RECOMPILE)` or multiple procedures.

See also: [06-stored-procedures.md](06-stored-procedures.md) for broader parameter sniffing mitigation strategies.

---

## How to Verify IQP Is Active

### 1. Check compatibility level

```sql
SELECT name, compatibility_level
FROM   sys.databases
WHERE  name = DB_NAME();
```

### 2. Check database-scoped configurations

```sql
SELECT name, value, value_for_secondary, description
FROM   sys.database_scoped_configurations
WHERE  name IN (
    'BATCH_MODE_ON_ROWSTORE',
    'DEFERRED_COMPILATION_TV',
    'TSQL_SCALAR_UDF_INLINING',
    'INTERLEAVED_EXECUTION_TVF',
    'MEMORY_GRANT_FEEDBACK_PERCENTILE',
    'MEMORY_GRANT_FEEDBACK_PERSISTENCE',
    'DOP_FEEDBACK',
    'CE_FEEDBACK',
    'PARAMETER_SENSITIVE_PLAN_OPTIMIZATION'
);
-- value = 1 means enabled (NULL = inherits instance default = ON)
```

### 3. Verify in actual execution plan

Use SSMS: **Query → Include Actual Execution Plan** then check these XML attributes:

```sql
-- Capture actual plan XML
SELECT  qs.sql_handle, qs.plan_handle,
        TRY_CAST(qp.query_plan AS XML) AS plan_xml
FROM    sys.dm_exec_query_stats  AS qs
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) AS qp
WHERE   qs.sql_handle = 0x...;  -- from your query

-- Key XML attributes to look for:
-- BatchModeOnRowStoreUsed="true"
-- ContainsInterleavedExecutionCandidates="true"
-- MemoryGrantFeedbackAdjusted="YesAdjusting" | "NoSpilling" | "NoFirstExecution"
-- IsAdaptiveJoin="true"
-- ScalarUDFInlined="true" (on Compute Scalar operator)
```

### 4. Check Query Store for feedback features (2022+)

```sql
-- All active IQP feedback entries
SELECT  q.query_id,
        q.query_hash,
        pf.feature_desc,
        pf.state_desc,
        pf.feedback_data
FROM    sys.query_store_plan_feedback AS pf
JOIN    sys.query_store_plan         AS p ON p.plan_id = pf.plan_id
JOIN    sys.query_store_query        AS q ON q.query_id = p.query_id
ORDER BY pf.feature_desc, q.query_id;
```

---

## Disabling IQP Features

Always prefer targeted disabling (per-query hints) over database-wide disabling.

### Per-query hints (preferred)

```sql
OPTION (USE HINT('DISABLE_BATCH_MODE_ON_ROWSTORE'))
OPTION (USE HINT('DISABLE_INTERLEAVED_EXECUTION_TVF'))
OPTION (USE HINT('DISABLE_TSQL_SCALAR_UDF_INLINING'))
OPTION (USE HINT('DISABLE_DEFERRED_COMPILATION_TV'))
OPTION (USE HINT('DISABLE_PARAMETER_SNIFFING'))        -- affects PSPO
OPTION (RECOMPILE)                                     -- forces fresh plan, bypasses feedback
```

### Query Store hints (per-query, persistent)

```sql
EXEC sys.sp_query_store_set_hints
    @query_id    = 42,
    @query_hints = N'OPTION(USE HINT(''DISABLE_TSQL_SCALAR_UDF_INLINING''))';
```

### Database-scoped configuration (affects all queries in database)

```sql
ALTER DATABASE SCOPED CONFIGURATION SET BATCH_MODE_ON_ROWSTORE               = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET DEFERRED_COMPILATION_TV               = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET TSQL_SCALAR_UDF_INLINING              = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET INTERLEAVED_EXECUTION_TVF             = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERCENTILE      = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERSISTENCE     = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET DOP_FEEDBACK                          = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET CE_FEEDBACK                           = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SENSITIVE_PLAN_OPTIMIZATION = OFF;
```

### Trace flags (instance-wide — use only for emergencies)

| Trace Flag | Effect |
|---|---|
| TF 4135 | Disable batch mode on rowstore |
| TF 9481 | Force CE 70 (disables all modern CE) |
| TF 9488 | Disable interleaved execution |
| TF 11032 | Disable scalar UDF inlining |

```sql
-- Enable temporarily for current session
DBCC TRACEON(11032, -1);
-- Disable
DBCC TRACEOFF(11032, -1);
```

---

## IQP and Query Store

Most 2022 IQP features (percentile MGF, DOP feedback, CE feedback, MGF persistence, optimized plan forcing) require **Query Store to be enabled and in READ_WRITE mode**.

```sql
-- Ensure Query Store is enabled for IQP 2022+ features
ALTER DATABASE [YourDatabase] SET QUERY_STORE = ON;
ALTER DATABASE [YourDatabase] SET QUERY_STORE (OPERATION_MODE = READ_WRITE);

-- Verify
SELECT name, desired_state_desc, actual_state_desc, readonly_reason
FROM   sys.databases
WHERE  name = DB_NAME();
```

If `actual_state_desc = 'READ_ONLY'`, Query Store went full — increase its size or clear stale data:

```sql
ALTER DATABASE [YourDatabase] SET QUERY_STORE (MAX_STORAGE_SIZE_MB = 2048);
-- or
ALTER DATABASE [YourDatabase] SET QUERY_STORE CLEAR;  -- nuclear option
```

See also: [30-query-store.md](30-query-store.md) for full Query Store configuration reference.

---

## Gotchas

1. **Compatibility level upgrade is required.** IQP features do not backport. Upgrading SQL Server binaries without upgrading the compat level provides no IQP benefit.

2. **MGF can oscillate and disable itself.** If a query alternates between spilling and not spilling across executions, SQL Server detects the oscillation and stops applying MGF for that plan. Subsequent behavior reverts to the original grant.

3. **Batch mode on rowstore is not always applied.** The optimizer weighs the cost of batch-mode setup against the row count. For small tables or small result sets, it will not activate even at compat 150.

4. **Scalar UDF inlining can change semantics.** UDFs with side effects, non-determinism, or relying on statement-level isolation are unsafe to inline. Always verify behavior after upgrading compat level.

5. **Interleaved execution adds overhead for mTVFs called with few rows.** The one-time materialization cost is paid even when the mTVF returns a small result set where the old estimate of 100 rows would have been fine.

6. **Table variable deferred compilation does not eliminate the need for temp tables.** If a table variable is populated and then modified before the referencing statement, the deferred compilation still uses the row count at first reference — which may already be wrong.

7. **PSPO requires compat 160, not just SQL Server 2022.** A database upgraded to SQL Server 2022 but still at compat 150 does not get PSPO.

8. **DOP feedback and CE feedback require Query Store in READ_WRITE.** If Query Store goes read-only (fills up), feedback stops accumulating and old feedback may become stale.

9. **IQP features interact with plan forcing.** If a plan is forced in Query Store, feedback features (MGF, DOP, CE) may still apply to the forced plan. Use `OPTION(RECOMPILE)` to bypass both.

10. **Adaptive joins can switch between executions.** An adaptive join may use Nested Loops on some executions and Hash Match on others, depending on actual row counts. This can make performance appear inconsistent when it is actually working correctly.

11. **IQP does not fix bad indexing.** A query missing a critical index that causes 10 million row scans will not become fast through IQP. Always verify execution plans and indexing first.

12. **Upgrading compat level can cause regressions.** Each compat level upgrade changes the default CE model and enables new optimizer behaviors. Regression-test workloads before committing the compat level change in production. Use Query Store's "Regressed Queries" report to identify problems.

---

## See Also

- [28-statistics.md](28-statistics.md) — Statistics quality is the foundation IQP builds on; fix statistics before relying on IQP
- [29-query-plans.md](29-query-plans.md) — How to read execution plans and verify IQP XML attributes
- [30-query-store.md](30-query-store.md) — Query Store architecture, monitoring, and IQP feedback views
- [06-stored-procedures.md](06-stored-procedures.md) — Parameter sniffing mitigations beyond PSPO
- [07-functions.md](07-functions.md) — Scalar UDF inlining eligibility details
- [34-tempdb.md](34-tempdb.md) — Temp table vs table variable performance tradeoffs
- [53-migration-compatibility.md](53-migration-compatibility.md) — Compat level upgrade checklist

---

## Sources

[^1]: [Intelligent Query Processing in SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing) — IQP feature matrix and compatibility level requirements for all IQP features across SQL Server versions
[^2]: [Memory Grant Feedback - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-memory-grant-feedback) — covers batch mode, row mode, percentile, and persistence modes of memory grant feedback
[^3]: [Memory Grant Feedback - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-memory-grant-feedback) — percentile and persistence mode memory grant feedback introduced in SQL Server 2022, including Query Store integration
[^4]: [Intelligent Query Processing Details - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — in-depth coverage of batch mode on rowstore, interleaved execution, scalar UDF inlining, table variable deferred compilation, and approximate query processing
[^5]: [Intelligent Query Processing Details - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — interleaved execution for multi-statement TVFs, including eligibility requirements and overhead considerations
[^6]: [Intelligent Query Processing Details - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — table variable deferred compilation, how actual row counts replace the fixed one-row estimate at compile time
[^7]: [Intelligent Query Processing Details - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — scalar UDF inlining, eligibility requirements, and how UDFs are transformed into relational expressions
[^8]: [APPROX_COUNT_DISTINCT (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/approx-count-distinct-transact-sql) — T-SQL reference for the HyperLogLog-based approximate distinct count aggregate function
[^9]: [Degree of parallelism (DOP) feedback - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-degree-parallelism-feedback) — DOP feedback implementation, Query Store integration, and configuration for SQL Server 2022+
[^10]: [Cardinality Estimation Feedback - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-cardinality-estimation-feedback) — CE feedback scenarios (correlation, join containment, row goal), persistence, and known issues
[^11]: [Parameter Sensitive Plan Optimization - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/parameter-sensitive-plan-optimization) — PSPO dispatcher plan and query variant mechanism for addressing parameter sniffing with skewed data distributions
[^12]: [sys.query_store_plan_feedback (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-plan-feedback) — catalog view columns and state descriptions for memory grant, CE, and DOP feedback stored in Query Store
[^13]: [PSPO: How SQL Server 2022 Tries to Fix Parameter Sniffing](https://www.brentozar.com/archive/2022/08/pspo-how-sql-server-2022-tries-to-fix-parameter-sniffing/) — Brent Ozar's analysis of Parameter Sensitive Plan Optimization in SQL Server 2022, including limitations and monitoring challenges
[^14]: [A Little About Intelligent Query Processing Limitations in SQL Server](https://erikdarling.com/a-little-about-intelligent-query-processing-limitations-in-sql-server/) — Erik Darling (2024) demonstrates scenarios where IQP features (batch mode on rowstore, adaptive joins, scalar UDF inlining) fail to activate due to preconditions and limitations

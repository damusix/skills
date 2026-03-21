# Execution Plans


How to read SQL Server execution plans, identify the operators that cost the most, and diagnose cardinality estimation failures.

## Table of Contents


- [Capturing Plans](#capturing-plans)
- [SET STATISTICS IO and TIME](#set-statistics-io-and-time)
- [Estimated vs Actual Plans](#estimated-vs-actual-plans)
- [Key Operators](#key-operators)
- [Warning Signs](#warning-signs)
- [Cardinality Estimation](#cardinality-estimation)
- [Intelligent Query Processing](#intelligent-query-processing)
- [Plan Cache Analysis](#plan-cache-analysis)
- [Query Store for Plan Regression](#query-store-for-plan-regression)
- [See Also](#see-also)
- [Sources](#sources)

---

## Capturing Plans


**Graphical plan (SSMS):**
- `Ctrl+L` — estimated plan (query does not run)
- `Ctrl+M` — toggle actual plan mode (run the query to see actual)
- `Ctrl+Shift+Q` — live query statistics (real-time row counts)

**Via T-SQL (retrieve from cache after running the query):**

    -- Run the query, then pull its plan from cache
    SELECT TOP 1
        qp.query_plan,
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 200) AS stmt
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
    ORDER BY qs.last_execution_time DESC;

`SET STATISTICS XML ON` also produces plan XML as a result set column, but it outputs the plan for every statement in the batch and is less ergonomic for interactive use than SSMS graphical plans.

Always capture the **actual** plan when diagnosing a slow query — estimated plans do not show actual row counts, memory grants used, or spill events.

---

## SET STATISTICS IO and TIME


Always run this alongside a slow query. Logical reads are the primary measure of I/O cost.

    SET STATISTICS IO ON;
    SET STATISTICS TIME ON;
    GO

    SELECT o.OrderID, o.TotalAmt
    FROM   dbo.Orders o
    WHERE  o.CustomerID = 42;
    GO

    SET STATISTICS IO OFF;
    SET STATISTICS TIME OFF;

Sample output:

    Table 'Orders'. Scan count 1, logical reads 689,
    physical reads 0, read-ahead reads 0.

    SQL Server Execution Times:
       CPU time = 16 ms,  elapsed time = 14 ms.

| Field | Meaning | What to look for |
|---|---|---|
| `logical reads` | Pages read from buffer pool (8 KB each) | Primary cost metric; high = scan or key lookups |
| `physical reads` | Pages fetched from disk | High = cold cache or missing indexes |
| `scan count > 1` | Table scanned multiple times | Inner table of a Nested Loops join — costly at scale |
| CPU time | Milliseconds of CPU | CPU ≈ elapsed = CPU-bound; elapsed >> CPU = waiting (I/O, locks) |

To convert logical reads to approximate MB: `logical_reads × 8 / 1024`.

---

## Estimated vs Actual Plans


| Aspect | Estimated | Actual |
|---|---|---|
| Query executes | No | Yes |
| Shows row estimates | Yes | Yes |
| Shows actual rows | No | Yes |
| Shows spills | No | Yes (warning triangle) |
| Memory grant | Estimated | Actual granted and used |

The most important comparison: **estimated rows vs actual rows** on each operator. A 10× discrepancy is a cardinality estimation problem. A 100× discrepancy is a serious one — wrong join algorithm, wrong memory grant, wrong parallelism decision.

Plans read **right-to-left, top-to-bottom** — data flows left toward the root (SELECT) operator. Arrow thickness scales with estimated row count.

---

## Key Operators


### Scan vs Seek

A **seek** traverses the B-tree to a specific key range — O(log n). A **scan** reads all leaf pages — O(n). Seeks are preferred for OLTP point lookups; scans are sometimes appropriate for large result sets or small tables.

| Operator | Good or bad? | Fix when bad |
|---|---|---|
| Clustered Index Seek | Good | — |
| Nonclustered Index Seek | Good | Check for Key Lookup following it |
| Clustered Index Scan | Investigate | Non-SARGable predicate or intentional large read |
| Table Scan | Always investigate | Missing clustered index |
| Nonclustered Index Scan | Investigate | Non-selective predicate or index intersection |

### Key Lookup

A Key Lookup means the nonclustered index satisfied the seek predicate but lacked columns needed for the SELECT list. SQL Server navigates the clustered B-tree (typically 2–4 page reads depending on tree height) for each row found.

    -- Before: IX_Orders_CustomerID causes Key Lookup for OrderDate, TotalAmt
    CREATE NONCLUSTERED INDEX IX_Orders_CustomerID
        ON dbo.Orders (CustomerID);

    -- After: covering index eliminates the Key Lookup
    CREATE NONCLUSTERED INDEX IX_Orders_CustomerID_Covering
        ON dbo.Orders (CustomerID)
        INCLUDE (OrderDate, TotalAmt, Status);

At 1,000 rows: the Key Lookup alone costs thousands of logical reads (B-tree height × row count). The cost scales linearly — the optimizer switches to a clustered scan once enough rows are expected (typically 0.5–2% of the table).

**Find Key Lookups in the plan cache:**

    SELECT TOP 20
        qs.total_logical_reads / qs.execution_count AS avg_reads,
        qs.execution_count,
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 200) AS stmt,
        qp.query_plan
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
    WHERE CAST(qp.query_plan AS NVARCHAR(MAX)) LIKE '%KeyLookup%'
    ORDER BY avg_reads DESC;

### Join Operators

| Algorithm | Best when | Memory grant |
|---|---|---|
| **Nested Loops** | Small outer, large inner with index seek | None |
| **Hash Match** | Large unsorted inputs, no useful index | Yes — can spill |
| **Merge Join** | Both inputs already sorted | None if sorted |

Wrong join algorithm is a common symptom of cardinality estimation failure. When the optimizer underestimates rows, it may choose Nested Loops where Hash Match would be better — and the plan runs orders of magnitude slower than expected.

**Hash Match spills to tempdb** when the memory grant is too small (estimated rows << actual rows). The yellow warning triangle appears on the Hash Match operator. Fix the statistics rather than the join algorithm.

    -- Detect queries with hash/sort spills (requires SQL Server 2016 SP1+)
    SELECT TOP 20
        qs.total_spills / qs.execution_count AS avg_spills,
        qs.execution_count,
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 200) AS stmt
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.total_spills > 0
    ORDER BY avg_spills DESC;

### Sort and Spool

**Sort** is a blocking operator — it must consume all input before producing output. It requires a memory grant. When that grant is too small, the sort spills to tempdb.

**Index Spool** means SQL Server built a temporary index during query execution because a permanent index was missing. The query works but pays index-creation cost on every execution. Identify the missing index and create it permanently.

**Table Spool** caches intermediate results in tempdb for reuse — often caused by correlated subqueries or the Halloween problem in DML. Consider rewriting the query with a CTE or temp table.

### Parallelism

Parallel plans distribute work across multiple threads. The overhead (~50ms setup) makes them net-negative for queries completing in under 100ms. Use `OPTION (MAXDOP 1)` to force serial execution when parallelism is counterproductive.

**CXPACKET** wait type means threads are waiting for their slowest sibling — classic sign of parallel plan with skewed work distribution. Reduce MAXDOP or fix the skewed distribution.

---

## Warning Signs


| Warning (yellow triangle) | Meaning | Fix |
|---|---|---|
| Implicit conversion | Type mismatch forces column conversion; kills seeks | Match parameter types to column types |
| Missing index | Optimizer detected a beneficial missing index | Evaluate and create if justified |
| No join predicate | Cartesian product — missing ON clause | Add the join condition |
| Memory grant warning | Spill likely due to underestimated grant | Fix statistics; check IQP memory grant feedback |
| Residual I/O | Rows read from storage > rows returned | Add a predicate to the index key |

**Detecting implicit conversions from cache:**

    SELECT TOP 20
        qs.total_logical_reads / qs.execution_count AS avg_reads,
        SUBSTRING(st.text, 1, 200) AS query_text
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
    WHERE CAST(qp.query_plan AS NVARCHAR(MAX)) LIKE '%PlanAffectingConvert%'
    ORDER BY avg_reads DESC;

---

## Cardinality Estimation


Cardinality estimation (CE) predicts how many rows each operator will return. Wrong estimates cause wrong join algorithms, wrong memory grants, and wrong serial/parallel decisions.

**CE version by compatibility level** — upgrading compatibility level changes CE behavior. A regression after a compat level upgrade is often CE-related:

| SQL Server version | Compat level | CE version |
|---|---|---|
| 2012 and earlier | 110 and below | CE70 (legacy) |
| 2014 | 120 | CE120 |
| 2016 | 130 | CE130 |
| 2017 | 140 | CE140 |
| 2019 | 150 | CE150 |
| 2022 | 160 | CE160 |

**Force legacy CE** when a compat upgrade causes regressions:

    -- Session-level (test a specific query)
    SELECT ... OPTION (USE HINT ('FORCE_LEGACY_CARDINALITY_ESTIMATION'));

    -- Database-level (diagnose all regressions, then remove once queries are fixed)
    ALTER DATABASE SCOPED CONFIGURATION SET LEGACY_CARDINALITY_ESTIMATION = ON;

**CE failure causes:**

| Cause | Symptom | Fix |
|---|---|---|
| Stale statistics | Estimated << actual rows | `UPDATE STATISTICS ... WITH FULLSCAN` |
| Ascending key | New dates past histogram max → 1 row estimate | `UPDATE STATISTICS FULLSCAN`; incremental stats |
| Multi-predicate independence | Product of individual selectivities underestimates | Multi-column statistics |
| Parameter sniffing | Plan built for atypical first-run parameter | `OPTIMIZE FOR UNKNOWN` or `OPTION (RECOMPILE)` |
| Table variable (pre-2019) | Always estimates 1 row | Compat level 150 for deferred compilation; or temp table |
| CE version change after upgrade | Regression on complex queries | Test with `FORCE_LEGACY_CARDINALITY_ESTIMATION`; fix the query |

**Diagnose in the plan:** hover over any operator in SSMS to see Estimated Number of Rows vs Actual Number of Rows. A 10× difference warrants investigation. A 100× difference is the root cause.

---

## Intelligent Query Processing


Intelligent Query Processing (IQP) is a family of features introduced in SQL Server 2017–2022 that allow the optimizer to learn from execution and self-correct. Most features require a specific compatibility level and Query Store.

| Feature | Min compat | What it does |
|---|---|---|
| Adaptive Joins | 140 | Chooses Nested Loops vs Hash Match at runtime based on actual row count |
| Batch Mode on Rowstore | 150 | Applies columnstore-style batch processing to rowstore queries |
| Table Variable Deferred Compilation | 150 | Defers compilation until table variable is populated (fixes 1-row estimate) |
| Row-Mode Memory Grant Feedback (MGHF) | 150 (2019) | Adjusts memory grants for sort/hash operators on subsequent executions |
| DOP Feedback | 160 | Automatically lowers MAXDOP for queries that don't benefit from parallelism |
| CE Feedback | 160 | Corrects cardinality estimate assumptions on repeated executions |
| Parameter-Sensitive Plan Optimization (PSPO) | 160 | Maintains multiple plan variants for queries with skewed parameter distributions |

**Check which IQP features are active:**

    -- Database compatibility level
    SELECT name, compatibility_level FROM sys.databases WHERE name = DB_NAME();

    -- Table variable deferred compilation (compat 150+)
    SELECT name, value FROM sys.database_scoped_configurations
    WHERE name = 'DEFERRED_COMPILATION_TV';

    -- Memory grant feedback persisted plans (visible in Query Store)
    SELECT qsp.plan_id, qsp.query_plan_hash,
           qsp.is_feedback_adjusted_grant    -- 2019+
    FROM sys.query_store_plan qsp
    WHERE qsp.is_feedback_adjusted_grant = 1;

**Memory Grant Feedback in practice:** after a sort or hash spill, MGHF stores the adjusted grant in Query Store and uses it on the next execution. Check whether spills are resolved by looking at `sys.query_store_plan.is_feedback_adjusted_grant`. If spills persist despite MGHF, the statistics themselves are stale — fix the statistics rather than relying on feedback.

**Adaptive Joins:** appear in execution plans as an "Adaptive Join" operator. The actual join algorithm (Nested Loops or Hash Match) is chosen at runtime. This is a plan shape change — if you see it in a plan and the query is slow, check whether the row-count threshold is being crossed inconsistently, which indicates unstable statistics.

**Disable specific IQP features when they cause problems:**

    -- Disable adaptive joins for a specific query
    SELECT ... OPTION (USE HINT ('DISABLE_BATCH_MODE_ADAPTIVE_JOINS'));

    -- Disable MGHF for a specific query
    SELECT ... OPTION (USE HINT ('DISABLE_QUERY_PLAN_FEEDBACK'));

    -- Disable table variable deferred compilation database-wide
    ALTER DATABASE SCOPED CONFIGURATION SET DEFERRED_COMPILATION_TV = OFF;

---

## Plan Cache Analysis


    -- Most expensive queries by average logical reads
    SELECT TOP 20
        qs.total_logical_reads / qs.execution_count AS avg_reads,
        qs.execution_count,
        qs.total_worker_time / qs.execution_count / 1000 AS avg_cpu_ms,
        SUBSTRING(st.text,
            (qs.statement_start_offset/2)+1,
            ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
              ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS stmt,
        DB_NAME(st.dbid) AS db_name
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    ORDER BY avg_reads DESC;

    -- Single-use ad-hoc plans bloating cache
    SELECT COUNT(*) AS single_use_plans,
           SUM(CAST(size_in_bytes AS BIGINT)) / 1024 / 1024 AS MB_wasted
    FROM sys.dm_exec_cached_plans
    WHERE usecounts = 1
      AND objtype = 'Adhoc';

A high count of single-use plans indicates unparameterized ad-hoc queries. Enable forced parameterization or use `sp_executesql` with parameters.

**Cost percentages are optimizer estimates, not measured time.** A 5% operator can dominate actual wall-clock time. Always validate with `STATISTICS IO/TIME` or actual row counts.

---

## Query Store for Plan Regression


Query Store persists plan and performance history across restarts — the primary tool for "this query used to be fast." It is not enabled by default on SQL Server 2016–2019 on-premises instances.

**Enable and configure Query Store:**

    -- Enable with recommended settings
    ALTER DATABASE YourDatabase SET QUERY_STORE = ON;
    ALTER DATABASE YourDatabase SET QUERY_STORE (
        OPERATION_MODE            = READ_WRITE,
        DATA_FLUSH_INTERVAL_SECONDS = 900,       -- flush to disk every 15 min
        QUERY_CAPTURE_MODE        = AUTO,         -- ignore insignificant queries
        MAX_STORAGE_SIZE_MB       = 1024,
        SIZE_BASED_CLEANUP_MODE   = AUTO,
        WAIT_STATS_CAPTURE_MODE   = ON            -- required for sys.query_store_wait_stats
    );

    -- Check current state (ReadOnly means Query Store is full)
    SELECT actual_state_desc, current_storage_size_mb, max_storage_size_mb
    FROM sys.database_query_store_options;

    -- Force cleanup if full (do not do this in production without understanding the data loss)
    ALTER DATABASE YourDatabase SET QUERY_STORE CLEAR;

**Find regressions — queries where the current plan is significantly slower than the historical best:**

    -- Best plan per query (correct: rank by avg_duration per plan_id)
    WITH BestPlan AS (
        SELECT qsq.query_id, qsp.plan_id,
               MIN(qsrs.avg_duration) AS best_us,
               ROW_NUMBER() OVER (
                   PARTITION BY qsq.query_id
                   ORDER BY MIN(qsrs.avg_duration)
               ) AS rn
        FROM sys.query_store_query         qsq
        JOIN sys.query_store_plan          qsp  ON qsp.query_id = qsq.query_id
        JOIN sys.query_store_runtime_stats qsrs ON qsrs.plan_id = qsp.plan_id
        GROUP BY qsq.query_id, qsp.plan_id
    ),
    RecentPlan AS (
        SELECT qsq.query_id, qsp.plan_id,
               AVG(qsrs.avg_duration) AS recent_us
        FROM sys.query_store_query               qsq
        JOIN sys.query_store_plan                qsp  ON qsp.query_id               = qsq.query_id
        JOIN sys.query_store_runtime_stats       qsrs ON qsrs.plan_id               = qsp.plan_id
        JOIN sys.query_store_runtime_stats_interval qsrsi
             ON qsrsi.runtime_stats_interval_id = qsrs.runtime_stats_interval_id
        WHERE qsrsi.start_time >= DATEADD(HOUR, -4, GETUTCDATE())
        GROUP BY qsq.query_id, qsp.plan_id
    )
    SELECT r.query_id,
           b.plan_id          AS best_plan_id,
           r.plan_id          AS current_plan_id,
           b.best_us / 1000.0 AS best_ms,
           r.recent_us / 1000.0 AS current_ms,
           r.recent_us * 1.0 / NULLIF(b.best_us, 0) AS regression_ratio
    FROM RecentPlan r
    JOIN BestPlan   b ON b.query_id = r.query_id AND b.rn = 1
    WHERE r.recent_us > b.best_us * 1.5
    ORDER BY regression_ratio DESC;

**Force a good plan:**

    -- Force the best historical plan (get plan_id from the query above)
    EXEC sys.sp_query_store_force_plan @query_id = 42, @plan_id = 7;

    -- Monitor: forced plans fail if underlying schema changes
    SELECT qsp.plan_id, qsp.force_failure_count, qsp.last_force_failure_reason_desc
    FROM sys.query_store_plan qsp
    WHERE qsp.is_forced_plan = 1;

**SQL Server 2022 — Parameter-Sensitive Plan Optimization (PSPO, compat 160):** Query Store can automatically maintain multiple plan variants for queries with skewed parameter distributions. Requires `QUERY_CAPTURE_MODE = AUTO` and Query Store enabled.

---

## See Also


- [index-strategy.md](index-strategy.md) — key lookup elimination, covering indexes, index design
- [statistics-tuning.md](statistics-tuning.md) — cardinality estimation root causes, histogram interpretation
- [wait-stats.md](wait-stats.md) — correlating plan symptoms to resource bottlenecks
- [locking-blocking.md](locking-blocking.md) — lock waits showing in elapsed time vs CPU time
- [batch-operations.md](batch-operations.md) — DML plan behavior for large operations

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [Execution Plan Overview - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/execution-plans) — Official overview of how SQL Server builds query execution plans, covering estimated vs actual plans and operator selection.
[^2]: [sys.dm_exec_query_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-stats-transact-sql) — Full column reference for the plan-cache DMV used to surface top queries by CPU, I/O, and elapsed time.
[^3]: [sys.dm_exec_cached_plans (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-cached-plans-transact-sql) — Reference for the plan-cache DMV that exposes cached compiled plans, use counts, and memory consumption.
[^4]: [Monitor Performance by Using the Query Store](https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store) — Covers Query Store catalog views, plan regression detection, plan forcing workflow, and WAIT_STATS_CAPTURE_MODE.
[^5]: [sp_query_store_force_plan (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-query-store-force-plan-transact-sql) — Reference for the procedure used to pin a specific plan from Query Store to prevent regression.
[^6]: [Cardinality Estimation (SQL Server)](https://learn.microsoft.com/en-us/sql/relational-databases/performance/cardinality-estimation-sql-server) — Explains CE model versions CE70 through CE160, the four original CE assumptions, and compatibility-level–based switching.
[^7]: [Intelligent Query Processing in SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing) — Definitive feature table for IQP: Adaptive Joins, Memory Grant Feedback, Batch Mode on Rowstore, Table Variable Deferred Compilation, DOP Feedback, CE Feedback, and PSPO with required compatibility levels.
[^8]: [sys.query_store_wait_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql) — Column reference and wait-category mapping for per-query wait stats in Query Store (SQL Server 2017+).

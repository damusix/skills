# 29 — Query Plans

## Table of Contents

1. [When to Use This Reference](#when-to-use)
2. [SHOWPLAN and Statistics Commands](#showplan-and-statistics-commands)
3. [SET STATISTICS IO and TIME](#set-statistics-io-and-time)
4. [Estimated vs Actual Plans](#estimated-vs-actual-plans)
5. [Plan Operators Reference](#plan-operators-reference)
   - [Scan Operators](#scan-operators)
   - [Seek Operators](#seek-operators)
   - [Key Lookup / RID Lookup](#key-lookup--rid-lookup)
   - [Join Operators](#join-operators)
   - [Aggregation Operators](#aggregation-operators)
   - [Sort and Spool Operators](#sort-and-spool-operators)
   - [Parallelism Operators](#parallelism-operators)
   - [Other Common Operators](#other-common-operators)
6. [Reading Cost Percentages](#reading-cost-percentages)
7. [Plan Warnings](#plan-warnings)
8. [Cardinality Estimation Failures](#cardinality-estimation-failures)
9. [Live Query Statistics](#live-query-statistics)
10. [Plan Forcing with USE PLAN](#plan-forcing-with-use-plan)
11. [Reading Plans from the Cache](#reading-plans-from-the-cache)
12. [XML Plan Internals](#xml-plan-internals)
13. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
14. [See Also](#see-also)
15. [Sources](#sources)

---

## When to Use

Load this file when the user asks about:
- Execution plans, query plans, graphical plans, actual/estimated plans
- `SET STATISTICS IO`, `SET STATISTICS TIME`, `SHOWPLAN`
- Specific plan operators: Seek, Scan, Key Lookup, Hash Join, Merge Join, Nested Loops, Sort, Spool, Parallelism
- "Why is my query slow?", plan warnings, fat arrows, spills, implicit conversions in plans
- `Live Query Statistics`, plan forcing, `USE PLAN` hint
- Reading plans from `sys.dm_exec_query_plan`, `sys.dm_exec_cached_plans`

---

## SHOWPLAN and Statistics Commands

### Displaying Plans

```sql
-- Show estimated plan as text (legacy, avoid)
SET SHOWPLAN_ALL ON;
GO
SELECT * FROM Sales.SalesOrderHeader WHERE CustomerID = 1;
GO
SET SHOWPLAN_ALL OFF;
GO

-- Show estimated plan as XML (use this for automation/parsing)
SET SHOWPLAN_XML ON;
GO
SELECT * FROM Sales.SalesOrderHeader WHERE CustomerID = 1;
GO
SET SHOWPLAN_XML OFF;
GO

-- Show actual plan as XML (query executes)
SET STATISTICS XML ON;
GO
SELECT * FROM Sales.SalesOrderHeader WHERE CustomerID = 1;
GO
SET STATISTICS XML OFF;
GO

-- SSMS shortcuts:
-- Ctrl+L  = estimated plan (graphical)
-- Ctrl+M  = include actual plan toggle (run query to see actual)
-- Ctrl+K  = live query statistics
```

### SHOWPLAN permissions

```sql
-- Requires SHOWPLAN permission on all referenced objects
-- Or sysadmin / db_owner membership
GRANT SHOWPLAN TO [username];
```

---

## SET STATISTICS IO and TIME

### Enabling

```sql
SET STATISTICS IO ON;
SET STATISTICS TIME ON;
GO

SELECT soh.SalesOrderID, soh.TotalDue
FROM   Sales.SalesOrderHeader soh
WHERE  soh.OrderDate >= '2014-01-01';
GO

SET STATISTICS IO OFF;
SET STATISTICS TIME OFF;
```

### Sample output and how to read it

```
SQL Server parse and compile time:
   CPU time = 0 ms, elapsed time = 12 ms.

SQL Server Execution Times:
   CPU time = 16 ms,  elapsed time = 14 ms.

Table 'SalesOrderHeader'. Scan count 1, logical reads 689,
physical reads 0, page server reads 0,
read-ahead reads 0, page server read-ahead reads 0,
lob logical reads 0, lob physical reads 0, lob read-ahead reads 0.
```

| Field | Meaning | What to look for |
|---|---|---|
| `logical reads` | Pages read from buffer pool (8 KB each) | Primary measure of I/O cost; multiply by 8 for KB |
| `physical reads` | Pages read from disk (not in buffer) | High = cold cache or missing indexes |
| `read-ahead reads` | Pre-fetched pages (async prefetch) | Normal during scans |
| `scan count` | Number of times the table/index was scanned | >1 = nested loop outer table being looped |
| CPU time | Milliseconds of CPU | High vs elapsed = CPU bottleneck |
| elapsed time | Wall-clock milliseconds | High vs CPU = waiting (I/O, locks, etc.) |

> [!NOTE] Diagnostic baseline
> Run `DBCC DROPCLEANBUFFERS` (in dev/test only) before benchmarking to get consistent cold-cache physical reads. In production, compare logical reads only.

```sql
-- Convert logical reads to approximate MB
-- 689 logical reads × 8 KB = 5.5 MB scanned
SELECT 689 * 8.0 / 1024 AS MB_Scanned;
```

---

## Estimated vs Actual Plans

| Aspect | Estimated Plan | Actual Plan |
|---|---|---|
| Query executes | No | Yes |
| Shows row estimates | Yes | Yes (both estimated and actual) |
| Shows actual rows | No | Yes |
| Shows actual executions | No | Yes |
| Memory grant | Estimated | Actual granted + used |
| Warnings | Compile-time only | Compile + runtime (spills, conversions) |
| When to use | Quick check before running expensive query | Diagnosing actual behavior |

### Key comparison: estimated vs actual rows

A large discrepancy between estimated and actual rows is the primary signal of a cardinality estimation problem:

```sql
-- In SSMS: hover over any operator in the actual plan
-- "Estimated Number of Rows" vs "Actual Number of Rows"
-- 10× difference = CE problem
-- 100× difference = serious CE problem (bad statistics, parameter sniffing, etc.)
```

---

## Plan Operators Reference

### Scan Operators

| Operator | Icon | Meaning |
|---|---|---|
| **Table Scan** | Table icon | Full heap scan (no clustered index). Always investigate. |
| **Clustered Index Scan** | CI icon | Scans all rows of the clustered index (= full table read). May be OK for small tables or returning >~30% of rows. |
| **Index Scan** | NCI icon | Scans entire nonclustered index. |

> [!WARNING] Table Scan
> A Table Scan means no clustered index exists. For large tables, this is almost always a performance problem. Create a clustered index or investigate why the heap is being scanned.

```sql
-- Detect table scans against large tables
SELECT  qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
        qs.execution_count,
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
            ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
              ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS query_text
FROM    sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE   qs.total_logical_reads / qs.execution_count > 10000
ORDER BY avg_logical_reads DESC;
```

### Seek Operators

| Operator | Description |
|---|---|
| **Clustered Index Seek** | Navigates B-tree to specific rows. Best-case for OLTP point lookups. |
| **Index Seek** | Navigates nonclustered index B-tree. Efficient for selective queries. |

A seek requires a **SARGable** predicate (Search ARGument able):

```sql
-- SARGable: uses seek
WHERE CustomerID = 42
WHERE OrderDate >= '2023-01-01' AND OrderDate < '2024-01-01'
WHERE LastName = 'Smith'

-- NOT SARGable: forces scan
WHERE YEAR(OrderDate) = 2023          -- function wraps column
WHERE CustomerID + 0 = 42            -- expression on column
WHERE CAST(CustomerID AS VARCHAR) = '42'  -- implicit/explicit conversion
WHERE LEFT(LastName, 1) = 'S'        -- function wraps column (use LIKE 'S%' instead)
```

### Key Lookup / RID Lookup

**Key Lookup**: nonclustered index satisfied the seek predicate but needed additional columns → SQL Server goes back to the clustered index (by the clustered key) to fetch those columns. Each row requires an extra B-tree navigation.

**RID Lookup**: same as Key Lookup but against a heap (uses Row ID instead of clustered key).

```
Nonclustered Index Seek → Key Lookup (nested loop)
```

This is expensive at scale:
- Each lookup = ~3 I/O operations (root + intermediate + leaf of CI)
- 1,000 key lookups = ~3,000 logical reads

**Fix**: add needed columns to the nonclustered index as INCLUDE columns.

```sql
-- Before: causes Key Lookup for TotalDue
CREATE INDEX IX_SOH_OrderDate ON Sales.SalesOrderHeader (OrderDate);

-- After: covering index
CREATE INDEX IX_SOH_OrderDate_Covering
    ON Sales.SalesOrderHeader (OrderDate)
    INCLUDE (CustomerID, TotalDue);

-- Detect Key Lookups in plan cache
SELECT  TOP 20
        qs.total_logical_reads / qs.execution_count AS avg_reads,
        qs.execution_count,
        qp.query_plan
FROM    sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE   CAST(qp.query_plan AS NVARCHAR(MAX)) LIKE '%Key Lookup%'
ORDER BY avg_reads DESC;
```

### Join Operators

Three physical join algorithms; the optimizer chooses based on row counts, sort order, and available indexes:

| Algorithm | Best when | Cost characteristic | Supports |
|---|---|---|---|
| **Nested Loops** | Small outer input, large inner with index seek | O(outer × log inner) | All join types |
| **Hash Match** | Large unsorted inputs, no useful index | O(n + m), build + probe phase | Equi-joins only |
| **Merge Join** | Both inputs sorted (index order or explicit Sort) | O(n + m) linear | Equi-joins + some non-equi |

```
Nested Loops: good for OLTP, bad for large analytical joins
Hash Match:   memory grant required; spills to tempdb if insufficient
Merge Join:   "free" if inputs already sorted; pay Sort cost otherwise
```

> [!WARNING] Hash Match memory
> Hash Match requires a memory grant proportional to the build input. If the optimizer underestimates rows, the grant will be too small and the hash will **spill to tempdb**, potentially causing 10–100× slowdown. Look for the yellow warning triangle on Hash Match operators.

```sql
-- Check for hash spills
SELECT  qs.sql_handle,
        qs.total_spills / qs.execution_count AS avg_spills,
        qs.total_rows / qs.execution_count AS avg_rows
FROM    sys.dm_exec_query_stats qs
WHERE   qs.total_spills > 0
ORDER BY avg_spills DESC;
```

**Force join algorithms** (use sparingly, prefer fixing statistics):

```sql
SELECT  a.col1, b.col2
FROM    TableA AS a
INNER LOOP JOIN TableB AS b ON a.ID = b.ID;  -- force Nested Loops

INNER HASH JOIN  -- force Hash Match
INNER MERGE JOIN -- force Merge Join
```

### Aggregation Operators

| Operator | When | Notes |
|---|---|---|
| **Stream Aggregate** | Input already sorted by GROUP BY key | O(n), no memory grant needed |
| **Hash Aggregate** | Input not sorted | Requires memory grant; can spill |
| **Distinct Sort** | DISTINCT without index | Expensive; often avoidable |

```sql
-- Stream Aggregate is cheapest: ensure GROUP BY columns are leading index keys
-- Hash Aggregate: acceptable for large aggregations; watch for spills

-- Force stream aggregate by pre-sorting:
SELECT  CustomerID, SUM(TotalDue)
FROM    Sales.SalesOrderHeader
GROUP BY CustomerID
OPTION (ORDER GROUP);   -- hint to prefer stream aggregate (undocumented but effective)
```

### Sort and Spool Operators

**Sort**: explicit sort when input order doesn't match required order (ORDER BY, Merge Join input, Stream Aggregate). Has blocking behavior (must consume all input before producing output).

```sql
-- Sort is blocking and requires memory grant
-- Signal: look for Sort with high cost % in estimated plan
-- Fix: create/modify index that produces the right order
```

**Spool operators**:

| Spool type | Meaning |
|---|---|
| **Table Spool** | Caches intermediate results in tempdb for re-use (often for correlated subqueries) |
| **Index Spool** | Builds a temporary index in tempdb on-the-fly — indicates missing index |
| **Row Count Spool** | Optimization to avoid re-executing subtree just for row count |
| **Window Spool** | Used for window functions with ROWS/RANGE framing |
| **Eager Spool** | Reads all input before producing output (Halloween protection or INSERT/UPDATE/DELETE self-reference) |

> [!WARNING] Index Spool
> An Index Spool is SQL Server building a temporary index on the fly because a permanent index is missing. The query works but pays the cost of index creation on every execution. Add the appropriate permanent index to eliminate it.

### Parallelism Operators

| Operator | Role |
|---|---|
| **Parallelism (Gather Streams)** | Combines results from multiple threads into one serial stream |
| **Parallelism (Distribute Streams)** | Splits rows from serial stream to multiple parallel threads |
| **Parallelism (Repartition Streams)** | Redistributes rows between parallel threads (hash-based) |

> [!NOTE] Parallel plan overhead
> Parallel plans have setup cost (~50ms). For queries returning in <100ms, the overhead may exceed the benefit. The `OPTION (MAXDOP 1)` hint forces serial execution.

```sql
-- Force serial execution
SELECT * FROM BigTable OPTION (MAXDOP 1);

-- Check current MAXDOP
SELECT value_in_use FROM sys.configurations WHERE name = 'max degree of parallelism';
```

### Other Common Operators

| Operator | Description |
|---|---|
| **Filter** | Row-by-row filter not pushed to an index. Indicates a residual predicate after a seek. |
| **Compute Scalar** | Evaluates an expression for each row. Scalar UDFs appear as Compute Scalar — if not inlined, each invocation executes the UDF body here. |
| **Top** | Implements TOP/FETCH NEXT. With a nested loop, enables early termination optimization. |
| **Constant Scan** | No table access. Used for `SELECT 1` or subqueries that return fixed values. |
| **Assert** | Checks a constraint (FK, CHECK, UNIQUE). Appears during DML. |
| **Clustered Index Insert/Update/Delete** | DML operations on the clustered index. |
| **Bitmap** | Optimization for parallel hash join; filters probe side before hash probe. |
| **Adaptive Join** | SQL Server 2017+: chooses between Nested Loops and Hash at runtime based on actual rows. |

> [!NOTE] SQL Server 2017 — Adaptive Joins
> Adaptive Join delays the choice between Nested Loops and Hash Match until after the build input rows are known. Useful when row estimates are unreliable.

---

## Reading Cost Percentages

Cost percentages in graphical plans are **optimizer estimates, not measured times**. They represent the optimizer's model of relative CPU + I/O cost across operators.

Key rules:
1. **Cost % sums to 100% for the batch** — not per-query in a multi-statement batch
2. **High cost % on a scan** is a starting point, not a verdict — a 60% scan on 1,000 rows may be fine
3. **Actual plans override estimates** — compare estimated vs actual rows at each operator
4. **Fat arrow = many rows** — thick connector arrows indicate large row counts between operators

```
Reading order: right-to-left, top-to-bottom (data flows left to root operator)
Each arrow thickness scales with estimated row count
```

> [!WARNING] Cost % on parallel plans
> In parallel plans, cost % is calculated per-thread, so numbers appear lower than reality. Compare total logical reads from `STATISTICS IO` instead.

---

## Plan Warnings

SQL Server surfaces warnings as yellow triangles on operators in the graphical plan. Check in XML: `<Warnings>` element.

| Warning | Meaning | Fix |
|---|---|---|
| **No join predicate** | Cartesian join — missing ON clause | Add the JOIN condition |
| **Implicit conversion** | Type mismatch forces column conversion, killing seeks | Match data types in predicates |
| **Missing index** | Optimizer detected a potentially useful index | Evaluate and create if cost/benefit justified |
| **Memory grant warning** | Estimated memory insufficient; spill likely | Fix statistics; add OPTION(MIN_GRANT_PERCENT) |
| **Residual I/O** | Rows read from storage > rows returned (predicate not pushed to index) | Cover the predicate with an index |
| **Unmatched indexes** | USE INDEX hint referenced nonexistent index | Fix the hint |
| **Statistics out of date** | Very old statistics detected | `UPDATE STATISTICS` |

### Implicit conversion warning

```sql
-- This causes a Compute Scalar + implicit conversion warning:
SELECT * FROM Customers WHERE CustomerID = '12345';
-- CustomerID is INT; '12345' is VARCHAR → converts the column, not the param
-- Result: cannot seek, forces scan

-- Fix: use the correct type
SELECT * FROM Customers WHERE CustomerID = 12345;

-- Or: fix the stored procedure parameter type
CREATE PROC GetCustomer @ID INT   -- not VARCHAR
```

### Detecting implicit conversions from cache

```sql
SELECT  TOP 20
        qs.total_logical_reads / qs.execution_count AS avg_reads,
        CAST(qp.query_plan AS NVARCHAR(MAX)) AS plan_xml,
        SUBSTRING(st.text, 1, 200) AS query_text
FROM    sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE   CAST(qp.query_plan AS NVARCHAR(MAX)) LIKE '%PlanAffectingConvert%'
   OR   CAST(qp.query_plan AS NVARCHAR(MAX)) LIKE '%CONVERT_IMPLICIT%'
ORDER BY avg_reads DESC;
```

---

## Cardinality Estimation Failures

Cardinality estimation (CE) predicts how many rows each operator will return. Failures cause bad plan choices (wrong join algorithm, insufficient memory grants, serial vs parallel decisions).

### Common causes

| Cause | Symptom | Fix |
|---|---|---|
| Stale statistics | Estimated ≪ Actual rows | `UPDATE STATISTICS` with `FULLSCAN` |
| Ascending key (new data past histogram) | Estimated 1 row for recent dates | Filtered stats, TF 2371, `STATISTICS_INCREMENTAL` (see `28-statistics.md`) |
| Multi-predicate independence assumption | Estimated rows = product of individual selectivities | Multi-column statistics, filtered statistics |
| Parameter sniffing | Plan optimized for sniffed value, bad for other values | `OPTION(RECOMPILE)`, `OPTIMIZE FOR UNKNOWN`, PSPO (see `30-query-store.md`) |
| CE version mismatch | Unexpected behavior after compat level change | Test with `USE HINT('FORCE_LEGACY_CARDINALITY_ESTIMATION')` |
| Table variable (pre-2019) | Always estimates 1 row | Temp table, or 2019+ IQP deferred compilation |

```sql
-- Check estimated vs actual rows in cached plans (simplified)
-- Best done visually in SSMS actual plan

-- Force legacy CE (compat level 70) for a single query
SELECT * FROM T WHERE col = @val OPTION (USE HINT('FORCE_LEGACY_CARDINALITY_ESTIMATION'));

-- Force new CE (2014+)
SELECT * FROM T WHERE col = @val OPTION (USE HINT('ENABLE_QUERY_OPTIMIZER_HOTFIXES'));
```

---

## Live Query Statistics

Live Query Statistics shows an in-progress actual plan with real-time row counts flowing through each operator.

```sql
-- Enable in SSMS: Query menu → Include Live Query Statistics
-- Or: Ctrl+Shift+Q

-- Useful for:
-- Long-running queries where you want to know where time is being spent
-- Identifying whether a Sort/Hash is blocking
-- Watching row counts grow to validate estimates
```

> [!NOTE]
> Live Query Statistics adds ~5–10% overhead. Do not enable by default in production.

---

## Plan Forcing with USE PLAN

Force a specific plan XML on a query (last resort — prefer fixing root cause):

```sql
-- Step 1: capture the good plan XML from cache or SSMS
DECLARE @plan_xml XML;
SELECT  @plan_xml = qp.query_plan
FROM    sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE   qs.sql_handle = <known_handle>;

-- Step 2: force it via hint (paste plan XML inline or use Query Store)
SELECT col1, col2
FROM   BigTable
WHERE  col1 = @param
OPTION (USE PLAN N'<ShowPlanXML xmlns=...> ... </ShowPlanXML>');
```

> [!WARNING] USE PLAN brittleness
> Forced plans break if the underlying schema changes (index dropped, stats updated in a way that invalidates the plan). Prefer Query Store plan forcing (`sp_query_store_force_plan`) — it degrades gracefully and is easier to manage. See `30-query-store.md`.

```sql
-- Query Store plan forcing (preferred)
-- Find query_id and plan_id in Query Store views, then:
EXEC sys.sp_query_store_force_plan @query_id = 42, @plan_id = 7;
```

---

## Reading Plans from the Cache

```sql
-- Find plans for a specific query text fragment
SELECT  qs.execution_count,
        qs.total_logical_reads,
        qs.total_worker_time / 1000 AS total_cpu_ms,
        qs.total_elapsed_time / 1000 AS total_elapsed_ms,
        SUBSTRING(st.text,
            (qs.statement_start_offset/2)+1,
            ((CASE qs.statement_end_offset
              WHEN -1 THEN DATALENGTH(st.text)
              ELSE qs.statement_end_offset END
              - qs.statement_start_offset)/2)+1) AS statement_text,
        qp.query_plan
FROM    sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE   st.text LIKE '%SalesOrderHeader%'
ORDER BY qs.total_logical_reads DESC;

-- Find most expensive queries by CPU
SELECT  TOP 20
        qs.total_worker_time / qs.execution_count AS avg_cpu_us,
        qs.execution_count,
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 200) AS stmt,
        qp.query_plan
FROM    sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
ORDER BY avg_cpu_us DESC;

-- Single-use plans (not parameterized — cache bloat)
SELECT  COUNT(*) AS single_use_plan_count,
        SUM(CAST(size_in_bytes AS BIGINT)) / 1024 / 1024 AS MB_wasted
FROM    sys.dm_exec_cached_plans
WHERE   usecounts = 1
  AND   objtype = 'Adhoc';
```

---

## XML Plan Internals

When parsing plans programmatically, the key XML elements:

```xml
<ShowPlanXML>
  <BatchSequence>
    <Batch>
      <Statements>
        <StmtSimple StatementEstRows="..." StatementSubTreeCost="...">
          <QueryPlan>
            <Warnings>
              <PlanAffectingConvert ... />
              <SpillToTempDb SpillLevel="1" />
              <NoJoinPredicate />
            </Warnings>
            <RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Inner Join"
                   EstimateRows="..." EstimateCPU="..." EstimateIO="...">
              <RunTimeInformation>
                <RunTimeCountersPerThread ActualRows="..." ActualExecutions="..." />
              </RunTimeInformation>
              ...
            </RelOp>
          </QueryPlan>
        </StmtSimple>
      </Statements>
    </Batch>
  </BatchSequence>
</ShowPlanXML>
```

```sql
-- Extract operator list from a cached plan XML
DECLARE @plan XML = (
    SELECT TOP 1 qp.query_plan
    FROM sys.dm_exec_cached_plans cp
    CROSS APPLY sys.dm_exec_query_plan(cp.plan_handle) qp
    WHERE cp.objtype = 'Proc'
    -- add filter
);

SELECT  n.value('@PhysicalOp', 'VARCHAR(50)') AS PhysicalOp,
        n.value('@EstimateRows', 'FLOAT')      AS EstimateRows,
        n.value('@EstimateCPU', 'FLOAT')       AS EstimateCPU,
        n.value('@EstimateIO', 'FLOAT')        AS EstimateIO
FROM    @plan.nodes('//RelOp') AS t(n)
ORDER BY EstimateCPU + EstimateIO DESC;
```

---

## Gotchas / Anti-patterns

1. **Trusting cost percentages as measured time.** They are optimizer estimates. A 5% operator can dominate actual wall time. Always use `STATISTICS IO/TIME` or actual execution plans to measure.

2. **Fixing plans without fixing root causes.** Forcing a plan with `USE PLAN` or Query Store doesn't fix bad statistics or missing indexes — it masks the problem until the forced plan becomes invalid.

3. **Ignoring spills.** Hash Match and Sort spills to tempdb are silent in `STATISTICS IO` output (they appear under tempdb's logical reads, not the query table). Check `sys.dm_exec_query_stats.total_spills` and look for warnings in actual plans.

4. **Comparing estimated plans across servers.** Estimated cost depends on row count estimates and server settings. A "lower-cost" plan on a dev server (small data) may be worse in production (full data).

5. **Over-indexing to eliminate scans.** Every index is a DML overhead. A scan on a 10,000-row table is almost always fine. Target scans on large tables (>1M rows) with high execution frequency.

6. **Ignoring `scan count > 1`.** `scan count` in `STATISTICS IO` greater than 1 for an inner table indicates a Nested Loops join where the inner side is re-scanned for each outer row. This is normal for small inner tables but catastrophic for large ones.

7. **Reading plans for ad-hoc queries with different parameters.** Cached plan statistics accumulate across all executions regardless of parameter values. A plan cached for `@ID = 1` (1 row) will look cheap even if it runs badly for `@ID = NULL` (1 million rows).

8. **Missing that Key Lookups are nested loops.** The Key Lookup operator always has a Nested Loops parent. The combined cost scales with the number of rows being looked up. At >1,000 rows, the lookup dominates.

9. **Relying on graphical plan for parallel query analysis.** For parallel queries, use `SET STATISTICS XML ON` and inspect the XML directly; the graphical plan hides per-thread detail.

10. **Forgetting that SHOWPLAN doesn't execute the query.** With `SET SHOWPLAN_XML ON`, the query does NOT run — so you won't see actual row counts, memory grants, or spills. For those, you need `SET STATISTICS XML ON` (actual plan).

11. **Live Query Statistics overhead in production.** Even `STATISTICS IO` adds measurable overhead for high-frequency queries. Benchmark overhead before enabling in production.

12. **Misreading `ActualExecutions` in actual plans.** For operators inside loops, `ActualExecutions` counts how many times the operator ran across all loop iterations. Divide `ActualRows` by `ActualExecutions` to get rows per execution.

---

## See Also

- [`28-statistics.md`](28-statistics.md) — histogram internals, ascending key problem, CE versions
- [`30-query-store.md`](30-query-store.md) — Query Store plan forcing, regressed query detection
- [`31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — Adaptive Joins, memory grant feedback, interleaved execution
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — wait stats, missing index DMVs, query hints reference
- [`08-indexes.md`](08-indexes.md) — index design, covering indexes, key lookup elimination
- [`13-transactions-locking.md`](13-transactions-locking.md) — lock waits showing up in elapsed time vs CPU

---

## Sources

[^1]: [SET STATISTICS IO (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-io-transact-sql) — reference for the SET STATISTICS IO command, output fields (logical reads, physical reads, scan count), and permissions
[^2]: [SET SHOWPLAN_XML (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql) — reference for SET SHOWPLAN_XML, which returns estimated execution plans as XML without executing the query
[^3]: [Display an Actual Execution Plan](https://learn.microsoft.com/en-us/sql/relational-databases/performance/display-an-actual-execution-plan) — how to generate actual graphical execution plans in SSMS, including runtime information and warnings
[^4]: [Logical and Physical Showplan Operator Reference](https://learn.microsoft.com/en-us/sql/relational-databases/showplan-logical-and-physical-operators-reference) — complete reference for all logical and physical plan operators used in XML and graphical showplans
[^5]: [Fundamentals of Query Tuning](https://www.brentozar.com/training/fundamentals-of-query-tuning/) — Brent Ozar's training course covering how to read execution plans, identify common anti-patterns, and diagnose cardinality estimation problems
[^6]: [Query Plan Analysis First Steps](https://www.sqlskills.com/blogs/paul/query-plan-analysis-first-steps/) — Paul Randal (SQLskills) on the most common first steps when analyzing poorly performing query plans, including scans, key lookups, sorts, joins, and parallelism
[^7]: [T-SQL Querying](https://www.microsoftpressstore.com/store/t-sql-querying-9780735685048) — Itzik Ben-Gan, Adam Machanic, Dejan Sarka, Kevin Farlee (Microsoft Press, 2015, ISBN 978-0735685048) — authoritative reference on query tuning, operator selection, and window function plan patterns
[^8]: [Live Query Statistics](https://learn.microsoft.com/en-us/sql/relational-databases/performance/live-query-statistics) — how to view real-time execution plan progress and operator-level runtime statistics for an active query in SSMS
[^9]: [Monitor Performance by Using the Query Store](https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store) — Query Store overview including plan forcing, regressed query detection, and wait statistics

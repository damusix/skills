---
name: sql-server-performance
description: "Use when diagnosing slow T-SQL queries, tuning indexes, reading execution plans, fixing parameter sniffing, optimizing batch operations, reducing transaction log bloat, troubleshooting locking and blocking, configuring tempdb, or when a query that used to be fast is now slow. Also use when writing high-throughput INSERT/UPDATE/DELETE operations, implementing minimal logging, designing covering indexes, or analyzing wait statistics."
---

# SQL Server Performance


A methodology for diagnosing and fixing T-SQL performance problems. This skill covers the runtime side — making queries fast, understanding why they're slow, and writing high-throughput operations.

## When to Use


- A query that used to be fast is now slow
- Reading execution plans to find bottlenecks
- Choosing between index strategies (clustered, covering, filtered)
- Diagnosing locking, blocking, or deadlocks
- Writing bulk INSERT/UPDATE/DELETE that won't bloat the transaction log
- Fixing parameter sniffing in stored procedures
- Deciding between temp tables and table variables
- Analyzing wait statistics to identify resource bottlenecks

**When NOT to use:** application schema design (table design, naming conventions, access control), backup/restore strategies, high availability configuration, or replication setup.

## Diagnostic Flowchart


When a query is slow, follow this sequence — each step narrows the cause before moving to the next.

**Step 1 — Get the actual execution plan**

    SET STATISTICS IO ON;
    SET STATISTICS TIME ON;
    -- Then run the query with Ctrl+M (Include Actual Plan) in SSMS

Look for:
- **Key Lookup** — nonclustered index seek followed by a clustered lookup per row. At 1,000+ rows this dominates. Fix: add missing SELECT columns to the NCI INCLUDE list.
- **Fat arrows** (thick connectors) between operators — estimated rows ≪ actual rows. This is a cardinality estimation failure. Fix: update statistics, check for parameter sniffing.
- **Yellow warning triangle** on Hash Match — the memory grant was too small; the hash spilled to tempdb. Fix: update statistics so the grant is sized correctly.
- **Table Scan on a large table** — no clustered index or a non-SARGable predicate forced it. Fix: add a clustered index or rewrite the predicate.
- **Index Spool** — SQL Server built a temporary index on the fly. Fix: create the permanent index.

**Step 2 — Check wait statistics**

    -- Step 1: snapshot before the problem window
    SELECT wait_type, wait_time_ms INTO #w FROM sys.dm_os_wait_stats;
    -- ...wait 60 seconds or through the slow period...
    -- Step 2: delta shows what consumed wait time during the window
    SELECT c.wait_type, c.wait_time_ms - b.wait_time_ms AS delta_ms
    FROM sys.dm_os_wait_stats c JOIN #w b ON b.wait_type = c.wait_type
    WHERE c.wait_time_ms > b.wait_time_ms
      AND c.wait_type NOT IN ('SLEEP_TASK','LAZYWRITER_SLEEP','WAITFOR','CXCONSUMER')
    ORDER BY delta_ms DESC;
    DROP TABLE #w;

| Dominant wait | Likely cause |
|---|---|
| `LCK_M_*` | Blocking/locking — see [locking-blocking.md](references/locking-blocking.md) |
| `PAGEIOLATCH_SH` | Missing index or cold buffer pool |
| `CXPACKET` | Parallelism imbalance or MAXDOP too high |
| `RESOURCE_SEMAPHORE` | Memory grant starvation — hash/sort spills |
| `WRITELOG` | Transaction log I/O bottleneck |
| `SOS_SCHEDULER_YIELD` | CPU saturation |

See [wait-stats.md](references/wait-stats.md) for the full methodology and DMV queries.

**Step 3 — Evaluate indexes**

    -- Top missing index recommendations (resets on restart — act promptly)
    SELECT TOP 10
        d.statement                 AS [Table],
        d.equality_columns,
        d.inequality_columns,
        d.included_columns,
        ROUND(s.avg_total_user_cost * s.avg_user_impact
              * (s.user_seeks + s.user_scans), 0) AS estimated_improvement
    FROM sys.dm_db_missing_index_groups g
    JOIN sys.dm_db_missing_index_group_stats s
        ON g.index_group_handle = s.group_handle
    JOIN sys.dm_db_missing_index_details d
        ON g.index_handle = d.index_handle
    WHERE d.database_id = DB_ID()
    ORDER BY estimated_improvement DESC;

See [index-strategy.md](references/index-strategy.md) for clustered key selection, covering indexes, and over-indexing tradeoffs.

**Step 4 — Check statistics freshness**

    -- Compare histogram max to actual max (ascending key problem)
    DBCC SHOW_STATISTICS ('dbo.Orders', 'IX_Orders_OrderDate') WITH HISTOGRAM;
    SELECT MAX(OrderDate) AS actual_max FROM dbo.Orders;
    -- If actual_max > last RANGE_HI_KEY, statistics are stale for recent rows

    -- Check modification counter
    SELECT s.name, sp.last_updated, sp.modification_counter,
           CAST(100.0 * sp.modification_counter / NULLIF(sp.rows, 0) AS DECIMAL(5,2))
               AS pct_modified
    FROM sys.stats s
    CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
    WHERE s.object_id = OBJECT_ID('dbo.Orders');

See [statistics-tuning.md](references/statistics-tuning.md) for histogram interpretation and update strategies.

**Step 5 — Diagnose parameter sniffing**

    -- Multiple plans for the same proc = sniffing instability
    SELECT qsq.query_id, COUNT(DISTINCT qsp.plan_id) AS plan_count,
           qsqt.query_sql_text
    FROM sys.query_store_query       qsq
    JOIN sys.query_store_plan        qsp  ON qsp.query_id      = qsq.query_id
    JOIN sys.query_store_query_text  qsqt ON qsqt.query_text_id = qsq.query_text_id
    GROUP BY qsq.query_id, qsqt.query_sql_text
    HAVING COUNT(DISTINCT qsp.plan_id) > 3
    ORDER BY plan_count DESC;

See the Parameter Sniffing section below and [execution-plans.md](references/execution-plans.md).

## Index Strategy


A table should have one well-chosen clustered index and targeted covering nonclustered indexes for secondary access patterns. Every index has a write penalty — keep OLTP tables at 3–5 nonclustered indexes total.

**Clustered index selection — choose a key that is:**
- **Narrow** — the clustered key is copied into every nonclustered index leaf row. An `INT` (4 bytes) vs `UNIQUEIDENTIFIER` (16 bytes) multiplies across all indexes and millions of rows.
- **Ever-increasing** — random inserts cause 50/50 page splits and severe fragmentation. Use `INT IDENTITY`, `BIGINT IDENTITY`, or `NEWSEQUENTIALID()`.
- **Unique** — SQL Server silently appends a 4-byte uniquifier to duplicate values, bloating the index.
- **Static** — updating the clustered key physically moves the row and cascades updates to every nonclustered index.

**Nonclustered index column ordering:**
1. Equality predicates first (`col = @val`)
2. Range predicates next (`col BETWEEN`, `col > @val`)
3. ORDER BY columns last (sort is free if they follow equality columns in the index)

**Covering indexes** eliminate Key Lookups — add SELECT-only columns to INCLUDE:

    -- Before: every row causes a Key Lookup back to the clustered index
    CREATE NONCLUSTERED INDEX IX_Orders_CustomerID
        ON dbo.Orders (CustomerID);

    -- After: covering index — no Key Lookup
    CREATE NONCLUSTERED INDEX IX_Orders_CustomerID_Covering
        ON dbo.Orders (CustomerID)
        INCLUDE (OrderDate, Status, TotalAmt);

**Filtered indexes** cover a subset of rows — lower maintenance cost, higher selectivity:

    -- Index only active orders — much smaller than a full-table NCI
    CREATE NONCLUSTERED INDEX IX_Orders_Active
        ON dbo.Orders (CustomerID, OrderDate)
        INCLUDE (Status)
        WHERE Status = 1;

    -- Unique constraint on nullable external key (NULLs excluded)
    CREATE UNIQUE NONCLUSTERED INDEX UX_Orders_ExternalRef
        ON dbo.Orders (ExternalRef)
        WHERE ExternalRef IS NOT NULL;

For fragmentation thresholds, fill factor guidance, and missing index DMV usage, see [index-strategy.md](references/index-strategy.md).

## SARGability


A predicate is **SARGable** when the optimizer can use an index seek instead of scanning every row. The rule: never wrap the filtered column in a function or expression.

| Non-SARGable (forces scan) | SARGable alternative |
|---|---|
| `WHERE YEAR(OrderDate) = 2025` | `WHERE OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01'` |
| `WHERE ISNULL(col, '') = @Val` | Ensure column is NOT NULL; use `WHERE col = @Val` |
| `WHERE col LIKE '%search'` | Use trailing wildcard: `WHERE col LIKE 'search%'` |
| `WHERE DATEDIFF(day, col, GETDATE()) < 30` | `WHERE col > DATEADD(day, -30, GETDATE())` |
| `WHERE CAST(col AS VARCHAR) = '42'` | Fix parameter type to match column type |
| `WHERE LEFT(LastName, 3) = 'Smi'` | `WHERE LastName LIKE 'Smi%'` |
| `WHERE col + 0 = @Val` | `WHERE col = @Val` (never put arithmetic on the column) |

An implicit type conversion has the same effect as a function — it forces the optimizer to convert every row. Match parameter types exactly to column types. Look for `PlanAffectingConvert` warnings in execution plan XML.

## Parameter Sniffing


SQL Server compiles a stored procedure plan on first execution using the actual parameter values passed at that moment. That plan is cached and reused — even for future calls with different parameters. This is beneficial 90% of the time; it hurts when the data distribution is skewed and the sniffed values are atypical.

**Ranked strategies (use in order):**

**1. OPTIMIZE FOR UNKNOWN** — stable plan using average distribution statistics. Preferred when many different parameter values are possible and no single value dominates:

    CREATE PROCEDURE dbo.GetOrders_ut
        @CustomerID INT
    AS
    BEGIN
        SET NOCOUNT ON;
        SELECT OrderID, OrderDate, TotalAmt
        FROM   dbo.Orders
        WHERE  CustomerID = @CustomerID
        OPTION (OPTIMIZE FOR (@CustomerID UNKNOWN));
    END;

**2. OPTION (RECOMPILE)** — forces a fresh plan per execution, embedding the actual parameter value. The optimizer finds the optimal plan every time but pays CPU compilation cost on every call. Use for infrequent but highly variable procedures (nightly reports, admin tools):

    SELECT OrderID, OrderDate, TotalAmt
    FROM   dbo.Orders
    WHERE  CustomerID = @CustomerID
    OPTION (RECOMPILE);   -- statement-level, not WITH RECOMPILE on the proc

**3. Local variable copy — avoid.** Assigning `@CustomerID` to a local variable defeats sniffing, but also defeats the benefit of sniffing on the common case. `OPTIMIZE FOR UNKNOWN` achieves the same statistical behavior with explicit, documented intent.

    -- BAD: defeats sniffing entirely, even when sniffing would help
    DECLARE @CID INT = @CustomerID;
    SELECT ... WHERE CustomerID = @CID;

On SQL Server 2022 (compatibility level 160) with Query Store enabled, Parameter-Sensitive Plan Optimization (PSPO) can automatically maintain multiple plan variants for skewed distributions. It is not a substitute for the above strategies on 2019 and earlier.

## Temp Tables vs Table Variables


| Dimension | Temp Table (`#t`) | Table Variable (`@t`) | CTE |
|---|---|---|---|
| Statistics | Yes — auto-created | No (1 row pre-2019; deferred 2019+) | None |
| Index support | All types | PRIMARY KEY, UNIQUE only | No |
| Parallelism | Yes | Yes | Yes |
| Recompile trigger | On schema/stats change | Rarely | No |
| Survives ROLLBACK | No — dropped | Yes — contents persist | No |
| Scope | Session + called procs | Current batch only | Current statement |
| TempDB caching | Yes — inside procedures | Same | No |

**Decision rules:**

- Use a **temp table** when rows exceed a few hundred, you need an index on the intermediate result, or you need accurate cardinality estimates for downstream joins.
- Use a **table variable** when the set is small and well-bounded (1–100 rows), you want to avoid recompile triggers, or you need the data to survive a ROLLBACK (e.g., audit log inserted before work begins).
- Use a **CTE** when the result is referenced exactly once — CTEs are not materialized; each reference re-executes the subquery. A CTE referenced twice scans the source twice.

**SQL Server 2019 table variable deferred compilation** (compatibility level 150+): the optimizer defers compilation of statements using table variables until after the table variable is populated, using the actual row count. This largely eliminates the "1 row" estimate problem on 2019+ environments. Temp tables still have the edge for column-level statistics and indexes on non-key columns.

    -- Verify deferred compilation is active (compat 150+)
    SELECT name, value FROM sys.database_scoped_configurations
    WHERE name = 'DEFERRED_COMPILATION_TV';

## Common Mistakes


| Mistake | Fix |
|---|---|
| Non-SARGable WHERE clause | Never wrap the filtered column in a function — apply functions to parameters |
| Key Lookup on high-row-count query | Add needed SELECT columns to the NCI INCLUDE list |
| Using NOLOCK for "read performance" | Enable RCSI instead — consistent reads, no shared lock overhead |
| Fixing sniffing with local variable copy | Use `OPTIMIZE FOR UNKNOWN` or statement-level `OPTION (RECOMPILE)` |
| Ignoring fill factor on random-key tables | Set 70–80% fill factor; rebuild on schedule |
| Blindly creating missing index suggestions | Evaluate write penalty and overlap with existing indexes |
| Rebuilding all indexes regardless of fragmentation | Skip tables < 1,000 pages; skip indexes < 5% fragmented |
| Auto-update statistics never firing on large tables | Upgrade to compat 130+ for dynamic threshold: `MIN(500 + 0.20×n, SQRT(1000×n))` — fires ~20× sooner on large tables |
| Table variable cardinality fixed at 1 row | Upgrade to compat 150 for deferred compilation |
| Hash/sort spills to tempdb | Fix statistics so memory grant is sized correctly; row-mode MGF (2019+) auto-adjusts |
| NOLOCK as a deadlock fix | Deadlocks need lock ordering or RCSI — NOLOCK does not prevent them |
| Single large DELETE bloating the log | Chunk with `DELETE TOP (5000)` in a WHILE loop |

## Reference Files


- [execution-plans.md](references/execution-plans.md) — reading plans, key operators, cardinality estimation, CE version map, Intelligent Query Processing (IQP), Query Store configuration and regression detection
- [index-strategy.md](references/index-strategy.md) — clustered key selection, covering indexes, filtered indexes, fragmentation, missing index DMVs
- [wait-stats.md](references/wait-stats.md) — top wait types, DMV queries, baseline methodology, resource correlation, TempDB configuration, max server memory
- [locking-blocking.md](references/locking-blocking.md) — isolation levels, RCSI, lock escalation, deadlocks, NOLOCK dangers
- [batch-operations.md](references/batch-operations.md) — chunked DML, minimal logging, partition switching, log management
- [statistics-tuning.md](references/statistics-tuning.md) — histogram interpretation, auto-update thresholds, ascending key problem, incremental statistics, filtered statistics

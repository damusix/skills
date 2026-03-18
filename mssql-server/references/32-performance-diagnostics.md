# 32 — Performance Diagnostics

Comprehensive reference for diagnosing SQL Server performance issues: query hints, wait statistics, missing index DMVs, plan cache analysis, and first-responder scripts.

## Table of Contents

1. [When to Use This Reference](#when-to-use-this-reference)
2. [Wait Statistics Overview](#wait-statistics-overview)
3. [Wait Stats Reference Table](#wait-stats-reference-table)
4. [Collecting a Wait Stats Baseline](#collecting-a-wait-stats-baseline)
5. [Query Hints Reference](#query-hints-reference)
6. [Missing Index DMVs](#missing-index-dmvs)
7. [Plan Cache Analysis](#plan-cache-analysis)
8. [sys.dm_exec_query_stats](#sysdm_exec_query_stats)
9. [sys.dm_os_wait_stats Baseline Pattern](#sysdm_os_wait_stats-baseline-pattern)
10. [Identify Top Queries by Resource](#identify-top-queries-by-resource)
11. [sp_Blitz Family](#sp_blitz-family)
12. [Resource Governor Diagnostics](#resource-governor-diagnostics)
13. [Memory Diagnostics](#memory-diagnostics)
14. [I/O Diagnostics](#io-diagnostics)
15. [CPU Diagnostics](#cpu-diagnostics)
16. [Blocking and Deadlock Diagnostics](#blocking-and-deadlock-diagnostics)
17. [TempDB Diagnostics](#tempdb-diagnostics)
18. [Diagnostic Query Cookbook](#diagnostic-query-cookbook)
19. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
20. [See Also](#see-also)
21. [Sources](#sources)

---

## When to Use This Reference

Load this file when:
- A query or workload is slow and you need to identify root causes
- You need to choose or validate a query hint
- You want to find the most expensive queries in the plan cache
- You need to interpret wait statistics
- You want to use sp_Blitz/sp_BlitzCache/sp_BlitzFirst/sp_BlitzIndex
- You need to identify missing indexes or plan cache bloat
- You're establishing a performance baseline before/after a change

See also:
- [`29-query-plans.md`](29-query-plans.md) — reading execution plans
- [`30-query-store.md`](30-query-store.md) — Query Store for plan regression detection
- [`31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — IQP features
- [`13-transactions-locking.md`](13-transactions-locking.md) — blocking and locking
- [`34-tempdb.md`](34-tempdb.md) — tempdb contention
- [`33-extended-events.md`](33-extended-events.md) — XE session capture

---

## Wait Statistics Overview

**Key principle:** SQL Server threads that cannot make progress must wait. Every wait is recorded in `sys.dm_os_wait_stats`. Identifying the dominant wait type tells you *what kind* of bottleneck you have — before you look at individual queries.

### How waits work

1. Thread requests a resource
2. Resource is unavailable → thread enters a wait queue
3. When resource becomes available → thread returns to runnable queue
4. Wait duration recorded: `waiting_tasks_count`, `wait_time_ms`, `signal_wait_time_ms`

**Signal wait** = time on runnable queue waiting for a CPU slot. High signal waits relative to total wait = CPU pressure.

### Reading cumulative waits

`sys.dm_os_wait_stats` accumulates since last restart (or since `DBCC SQLPERF('sys.dm_os_wait_stats', CLEAR)`). Always compare a delta between two snapshots, not raw totals.

---

## Wait Stats Reference Table

| Wait Type | Category | Diagnosis |
|-----------|----------|-----------|
| **CXPACKET** | Parallelism | Threads waiting for slower parallel sibling. Check: skewed work distribution, MAXDOP too high, bad cardinality estimates. Split: CXPACKET + CXCONSUMER (consumer always a passenger). |
| **CXCONSUMER** | Parallelism (benign) | Consumer thread waiting for producer. Paired with CXPACKET. Reduce CXPACKET, CXCONSUMER follows. |
| **LCK_M_\*** | Locking | Lock waits. LCK_M_S=shared, LCK_M_X=exclusive, LCK_M_U=update, LCK_M_IX=intent exclusive. Investigate blocking chains. |
| **PAGEIOLATCH_SH/EX/UP** | I/O | Data pages being read from disk into buffer pool. Disk I/O bottleneck or working set too large for memory. |
| **WRITELOG** | Log I/O | Transaction log writes. Latency on log disk. Separate log from data files. SSD recommended for log. |
| **ASYNC_NETWORK_IO** | Network/client | Server waiting for client to consume results. Slow application, row-by-row fetch pattern, or network saturation. |
| **OLEDB** | Linked server | Linked server queries. Common cause: slow OLTP linked to slow remote. Consider OPENQUERY instead. |
| **SOS_SCHEDULER_YIELD** | CPU | Thread voluntarily yielded CPU but re-queued immediately. CPU contention. |
| **RESOURCE_SEMAPHORE** | Memory grant | Query waiting for memory grant (sort/hash). Reduce max server memory grant with `max_grant_percent`. |
| **RESOURCE_SEMAPHORE_QUERY_COMPILE** | Compilation memory | Too many concurrent compilations competing for memory. |
| **BROKER_TO_FLUSH** | Service Broker | Benign background. Exclude from analysis. |
| **SQLTRACE_BUFFER_FLUSH** | Tracing | Benign background from SQL Trace. Exclude. |
| **SLEEP_TASK** | Background | Benign system background. Exclude. |
| **LAZYWRITER_SLEEP** | Background | Benign lazy writer idle. Exclude. |
| **CHECKPOINT_QUEUE** | Background | Checkpoint worker idle. Benign unless high — could mean I/O saturation. |
| **DBMIRROR_EVENTS_QUEUE** | Mirroring/AG | Benign when idle. |
| **HADR_WORK_QUEUE** | Always On AG | Background AG worker. Benign unless high in AG environment. |
| **HADR_SYNC_COMMIT** | Always On AG synchronous | Primary waiting for secondary ACK. Indicates secondary latency in synchronous mode. |
| **PAGELATCH_EX/SH/UP** | In-memory latch contention | Latch on in-memory data structure (not I/O). Classic symptom: tempdb PFS/GAM/SGAM, or hot page on user table (sequential inserts on clustered key). |
| **LATCH_EX/SH** | Memory latches | In-memory latch contention. Often compilation structures or buffer pool metadata. |
| **DBCC_OBJECT_METADATA** | DBCC | DBCC CHECKDB running. |
| **FT_IFTS_SCHEDULER_IDLE_WAIT** | Full-Text | FTS worker idle. Benign. |
| **WAIT_XTP_OFFLINE_CKPT_NEW_LOG** | In-Memory OLTP | In-Memory OLTP checkpoint. Benign unless dominant. |
| **XTP_PREEMPTIVE_TASK** | In-Memory OLTP | Background. Benign. |
| **THREADPOOL** | Worker thread exhaustion | Max worker threads exhausted. Queries queued for a thread. Immediate danger signal. |
| **TRACEWRITE** | Profiler/Trace overhead | Server-side trace active. Overhead from capturing events. Switch to XE. |
| **SOSHOST_INTERNAL_YIELD** | CLR | CLR code yielding. CLR methods in heavy use. |
| **EXECSYNC** | Parallel plan serial zone | Parallel plan executing a serial zone (index scan with OUTPUT clause, etc). |

### Benign waits to exclude from analysis

```sql
-- Standard exclusion list for wait stats analysis
WHERE wait_type NOT IN (
    'SLEEP_TASK', 'SLEEP_SYSTEMTASK', 'SLEEP_DBSTARTUP',
    'SLEEP_DCOMSTARTUP', 'SLEEP_MASTERMDREADY',
    'SLEEP_MASTERUPGRADED', 'SLEEP_MSDBSTARTUP',
    'SLEEP_TEMPDBSTARTUP', 'SLEEP_MASTERSTART',
    'SLEEP_MASTERSTARTED',
    'WAITFOR',
    'LAZYWRITER_SLEEP',
    'SQLTRACE_BUFFER_FLUSH',
    'SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
    'CHECKPOINT_QUEUE',
    'BROKER_TO_FLUSH',
    'BROKER_TASK_STOP',
    'BROKER_EVENTHANDLER',
    'DISPATCHER_QUEUE_SEMAPHORE',
    'FT_IFTS_SCHEDULER_IDLE_WAIT',
    'XE_DISPATCHER_WAIT',
    'XE_TIMER_EVENT',
    'DBMIRROR_EVENTS_QUEUE',
    'HADR_WORK_QUEUE',
    'CLR_AUTO_EVENT',
    'CLR_MANUAL_EVENT',
    'CXCONSUMER',
    'SP_SERVER_DIAGNOSTICS_SLEEP',
    'RESOURCE_QUEUE',
    'SERVER_IDLE_CHECK',
    'REQUEST_FOR_DEADLOCK_SEARCH',
    'LOGMGR_QUEUE',
    'ONDEMAND_TASK_QUEUE',
    'KSOURCE_WAKEUP',
    'SQLTRACE_WAIT_ENTRIES'
)
AND wait_type NOT LIKE 'SLEEP_%'
AND wait_type NOT LIKE 'HADR_%'       -- remove this if diagnosing AG issues
AND wait_type NOT LIKE 'DBMIRROR_%'
```

---

## Collecting a Wait Stats Baseline

Capture a delta over a representative workload period (15 min minimum, ideally the busiest window):

```sql
-- Step 1: snapshot
SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    max_wait_time_ms,
    signal_wait_time_ms,
    GETDATE() AS snapshot_time
INTO #wait_baseline
FROM sys.dm_os_wait_stats
WHERE wait_type NOT IN (
    'SLEEP_TASK','LAZYWRITER_SLEEP','SQLTRACE_BUFFER_FLUSH',
    'CHECKPOINT_QUEUE','BROKER_TO_FLUSH','BROKER_TASK_STOP',
    'WAITFOR','DISPATCHER_QUEUE_SEMAPHORE','XE_DISPATCHER_WAIT',
    'XE_TIMER_EVENT','CXCONSUMER'
);

-- ... wait for representative window ...

-- Step 2: delta
SELECT
    c.wait_type,
    c.waiting_tasks_count - b.waiting_tasks_count       AS delta_tasks,
    c.wait_time_ms - b.wait_time_ms                     AS delta_wait_ms,
    c.signal_wait_time_ms - b.signal_wait_time_ms       AS delta_signal_ms,
    CAST(100.0 * (c.wait_time_ms - b.wait_time_ms) /
        NULLIF(SUM(c.wait_time_ms - b.wait_time_ms)
            OVER (), 0) AS DECIMAL(5,2))                AS pct_of_total
FROM sys.dm_os_wait_stats c
JOIN #wait_baseline b ON b.wait_type = c.wait_type
WHERE c.wait_time_ms > b.wait_time_ms
ORDER BY delta_wait_ms DESC;
```

---

## Query Hints Reference

Hints override the optimizer. Use sparingly — they become maintenance debt. Prefer fixing statistics or schema issues first.

### OPTION clause hints (query-level)

```sql
-- Recompile plan for this execution (clears param sniffing effect)
SELECT * FROM Orders WHERE CustomerID = @id
OPTION (RECOMPILE);

-- Cap parallelism for this query
SELECT * FROM BigTable
OPTION (MAXDOP 4);

-- Force serial execution
SELECT * FROM BigTable
OPTION (MAXDOP 1);

-- Optimize for a specific parameter value
EXEC SearchOrders @status = 'Active'
-- Inside proc:
OPTION (OPTIMIZE FOR (@status = 'Active'));

-- Optimize as if parameter is unknown (avoids sniffing, may get worse plan)
OPTION (OPTIMIZE FOR UNKNOWN);

-- Tell optimizer row count for a specific table in the query
-- (2014+, useful when statistics are wrong)
SELECT * FROM Orders o JOIN Customers c ON o.CustID = c.ID
OPTION (USE HINT ('FORCE_LEGACY_CARDINALITY_ESTIMATION'));

-- Force specific CE version
OPTION (USE HINT ('QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_110')); -- CE 70
OPTION (USE HINT ('QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_120')); -- CE 120
OPTION (USE HINT ('FORCE_DEFAULT_CARDINALITY_ESTIMATION'));    -- current db compat

-- Disable specific IQP features
OPTION (USE HINT ('DISABLE_INTERLEAVED_EXECUTION_TVF'));
OPTION (USE HINT ('DISABLE_TSQL_SCALAR_UDF_INLINING'));
OPTION (USE HINT ('ALLOW_BATCH_MODE'));         -- force batch mode on rowstore
OPTION (USE HINT ('DISALLOW_BATCH_MODE'));      -- force row mode
OPTION (USE HINT ('DISABLE_BATCH_MODE_MEMORY_GRANT_FEEDBACK'));

-- Keep plan in cache longer (non-recompilable)
OPTION (KEEPFIXED PLAN);

-- Hash and merge join hints
OPTION (HASH JOIN);       -- force hash join algorithm
OPTION (MERGE JOIN);      -- force merge join
OPTION (LOOP JOIN);       -- force nested loops

-- Force index (table-level hint, not OPTION clause)
SELECT * FROM Orders WITH (INDEX(IX_Orders_CustomerID))
WHERE CustomerID = 5;

-- Force seek / force scan
SELECT * FROM Orders WITH (FORCESEEK)  -- forbid table scan
WHERE CustomerID = 5;

SELECT * FROM Orders WITH (FORCESCAN)  -- forbid index seek
WHERE Status = 'Pending';

-- NOEXPAND (force indexed view usage on Standard Edition)
SELECT * FROM dbo.vw_SalesSummary WITH (NOEXPAND);

-- FAST N (return first N rows ASAP, reduces sort/hash memory)
SELECT TOP 100 * FROM BigTable
OPTION (FAST 100);

-- Min/max grant (2012+)
OPTION (MIN_GRANT_PERCENT = 5);    -- minimum 5% of max grant
OPTION (MAX_GRANT_PERCENT = 25);   -- cap at 25%
```

### Table hints (inside FROM clause)

```sql
-- Isolation level overrides
FROM Orders WITH (NOLOCK)          -- READ UNCOMMITTED (dirty reads)
FROM Orders WITH (READPAST)        -- skip locked rows
FROM Orders WITH (UPDLOCK)         -- take update locks (prevent deadlock in read-then-write)
FROM Orders WITH (HOLDLOCK)        -- SERIALIZABLE granularity
FROM Orders WITH (ROWLOCK)         -- hint row-level locking
FROM Orders WITH (PAGLOCK)         -- hint page-level locking
FROM Orders WITH (TABLOCK)         -- hint table-level shared lock
FROM Orders WITH (TABLOCKX)        -- hint table-level exclusive lock
FROM Orders WITH (XLOCK)           -- exclusive locks for duration of transaction

-- NOWAIT: fail immediately if lock can't be acquired (instead of waiting)
FROM Orders WITH (NOWAIT)

-- READCOMMITTEDLOCK: force locking read even when RCSI is enabled
FROM Orders WITH (READCOMMITTEDLOCK)
```

> [!WARNING]
> **Avoid NOLOCK in production OLTP.** NOLOCK can return phantom rows, duplicate rows, or completely incorrect results due to page splits during a scan. It is not simply "read without waiting" — it bypasses all read consistency guarantees. Use SNAPSHOT isolation instead for non-blocking consistent reads.

> [!WARNING]
> **Table hints override session isolation level.** If your session is in SNAPSHOT isolation, WITH (NOLOCK) still takes you to READ UNCOMMITTED, not snapshot semantics.

### Hint interaction with Query Store

Query Store plan forcing is generally preferred over USE PLAN or hints. If you must use a hint, consider using `sp_query_store_set_hints` (2022+) to apply it via QS rather than modifying the query text.

```sql
-- Apply hint via Query Store (2022+, avoids touching app code)
EXEC sys.sp_query_store_set_hints
    @query_id = 1234,
    @query_hints = N'OPTION(MAXDOP 1, RECOMPILE)';

-- Remove QS hint
EXEC sys.sp_query_store_clear_hints @query_id = 1234;

-- View current QS hints
SELECT * FROM sys.query_store_query_hints;
```

> [!NOTE] SQL Server 2022
> `sp_query_store_set_hints` requires compatibility level 140+ and Query Store in READ_WRITE mode.

---

## Missing Index DMVs

The optimizer records index recommendations during query compilation and execution. These DMVs reset on restart and do not persist.

```sql
-- Top missing index recommendations by estimated impact
SELECT TOP 20
    ROUND(s.avg_total_user_cost * s.avg_user_impact * (s.user_seeks + s.user_scans), 0)
                                        AS estimated_improvement,
    s.avg_total_user_cost               AS avg_cost_without_index,
    s.avg_user_impact                   AS pct_improvement,
    s.user_seeks,
    s.user_scans,
    s.last_user_seek,
    d.equality_columns,
    d.inequality_columns,
    d.included_columns,
    d.statement                         AS [table],
    'CREATE NONCLUSTERED INDEX IX_'
        + OBJECT_NAME(d.object_id, d.database_id)
        + '_missing'
        + CAST(d.index_handle AS VARCHAR(10))
        + ' ON ' + d.statement
        + ' (' + ISNULL(d.equality_columns, '')
        + CASE WHEN d.equality_columns IS NOT NULL
               AND d.inequality_columns IS NOT NULL THEN ', ' ELSE '' END
        + ISNULL(d.inequality_columns, '')
        + ')'
        + ISNULL(' INCLUDE (' + d.included_columns + ')', '')
        AS create_statement
FROM sys.dm_db_missing_index_groups g
JOIN sys.dm_db_missing_index_group_stats s
    ON g.index_group_handle = s.group_handle
JOIN sys.dm_db_missing_index_details d
    ON g.index_handle = d.index_handle
WHERE d.database_id = DB_ID()
ORDER BY estimated_improvement DESC;
```

> [!WARNING]
> **Do not blindly create missing index suggestions.** The DMVs do not account for:
> - Duplicate indexes (may already be covered by an existing index with a different column order)
> - Write overhead (every index slows INSERT/UPDATE/DELETE)
> - Other queries that might be harmed by the new index
> - Index selectivity — suggestions may not actually help if cardinality is wrong
>
> Use these as leads, not orders. Validate with execution plan before creating.

```sql
-- Check if suggestion overlaps with an existing index
SELECT
    ix.name AS existing_index,
    STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS key_columns
FROM sys.indexes ix
JOIN sys.index_columns ic ON ix.object_id = ic.object_id AND ix.index_id = ic.index_id
JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
WHERE ix.object_id = OBJECT_ID('dbo.Orders')
  AND ic.is_included_column = 0
GROUP BY ix.name
ORDER BY ix.name;
```

---

## Plan Cache Analysis

The plan cache stores compiled plans. Analyzing it reveals expensive queries, parameter sniffing victims, and cache bloat.

### Top queries by cumulative CPU

```sql
SELECT TOP 20
    qs.total_worker_time / 1000          AS total_cpu_ms,
    qs.total_worker_time / qs.execution_count / 1000
                                         AS avg_cpu_ms,
    qs.execution_count,
    qs.total_elapsed_time / 1000         AS total_elapsed_ms,
    qs.total_logical_reads,
    qs.total_logical_reads / qs.execution_count
                                         AS avg_logical_reads,
    SUBSTRING(st.text,
        (qs.statement_start_offset / 2) + 1,
        ((CASE qs.statement_end_offset
            WHEN -1 THEN DATALENGTH(st.text)
            ELSE qs.statement_end_offset END
          - qs.statement_start_offset) / 2) + 1) AS statement_text,
    DB_NAME(st.dbid)                     AS database_name,
    qp.query_plan
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE st.dbid = DB_ID()
ORDER BY total_cpu_ms DESC;
```

### Top queries by total logical reads

```sql
SELECT TOP 20
    qs.total_logical_reads,
    qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
    qs.execution_count,
    qs.total_worker_time / qs.execution_count / 1000 AS avg_cpu_ms,
    SUBSTRING(st.text,
        (qs.statement_start_offset / 2) + 1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1)
        AS statement_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.dbid = DB_ID()
ORDER BY total_logical_reads DESC;
```

### Single-use plans (cache bloat from ad hoc queries)

```sql
-- Each row = unique plan used only once = wasted cache memory
SELECT TOP 50
    usecounts,
    size_in_bytes / 1024     AS size_kb,
    objtype,
    SUBSTRING(text, 1, 200)  AS query_text
FROM sys.dm_exec_cached_plans cp
CROSS APPLY sys.dm_exec_sql_text(cp.plan_handle)
WHERE usecounts = 1
  AND objtype = 'Adhoc'
ORDER BY size_in_bytes DESC;

-- Total wasted memory on single-use plans
SELECT
    SUM(size_in_bytes) / 1024 / 1024 AS wasted_mb,
    COUNT(*)                         AS plan_count
FROM sys.dm_exec_cached_plans
WHERE usecounts = 1
  AND objtype = 'Adhoc';
```

> [!NOTE]
> Enable `optimize for ad hoc workloads` to store only a stub on first execution. Reduces single-use plan bloat significantly on OLTP workloads.
> ```sql
> EXEC sp_configure 'optimize for ad hoc workloads', 1;
> RECONFIGURE;
> ```

### Plans with implicit conversion warnings

```sql
-- Find cached plans with implicit conversion warnings in XML
SELECT TOP 20
    st.text,
    qp.query_plan
FROM sys.dm_exec_cached_plans cp
CROSS APPLY sys.dm_exec_sql_text(cp.plan_handle) st
CROSS APPLY sys.dm_exec_query_plan(cp.plan_handle) qp
WHERE CAST(qp.query_plan AS NVARCHAR(MAX))
    LIKE '%PlanAffectingConvert%';
```

### Plans with missing index warnings

```sql
SELECT TOP 20
    st.text,
    CAST(qp.query_plan AS NVARCHAR(MAX)) AS plan_xml_text
FROM sys.dm_exec_cached_plans cp
CROSS APPLY sys.dm_exec_sql_text(cp.plan_handle) st
CROSS APPLY sys.dm_exec_query_plan(cp.plan_handle) qp
WHERE CAST(qp.query_plan AS NVARCHAR(MAX))
    LIKE '%MissingIndexes%'
  AND st.dbid = DB_ID();
```

---

## sys.dm_exec_query_stats

Full column reference for the most useful plan cache DMV:

| Column | Type | Description |
|--------|------|-------------|
| `sql_handle` | varbinary | Key to `sys.dm_exec_sql_text` |
| `plan_handle` | varbinary | Key to `sys.dm_exec_query_plan` |
| `execution_count` | bigint | Times plan has been executed since cached |
| `total_worker_time` | bigint | Cumulative CPU time in microseconds |
| `total_elapsed_time` | bigint | Cumulative wall clock time in microseconds |
| `total_logical_reads` | bigint | Cumulative logical reads (buffer pool hits + misses) |
| `total_physical_reads` | bigint | Cumulative physical reads (disk I/O) |
| `total_logical_writes` | bigint | Cumulative logical writes (dirty pages) |
| `min_worker_time` | bigint | Minimum CPU time for a single execution |
| `max_worker_time` | bigint | Maximum CPU time for a single execution |
| `min_elapsed_time` | bigint | Minimum elapsed for a single execution |
| `max_elapsed_time` | bigint | Maximum elapsed for a single execution |
| `min_logical_reads` | bigint | Min logical reads per execution |
| `max_logical_reads` | bigint | Max logical reads per execution |
| `total_rows` | bigint | Rows returned across all executions |
| `total_grant_kb` | bigint | Total memory granted in KB (2012+) |
| `total_used_grant_kb` | bigint | Total memory actually used (2012+) |
| `total_ideal_grant_kb` | bigint | Memory that would have been ideal (2016+) |
| `last_execution_time` | datetime | Timestamp of most recent execution |
| `creation_time` | datetime | When plan was compiled and cached |
| `statement_start_offset` | int | Byte offset of statement within batch |
| `statement_end_offset` | int | End byte offset (-1 = end of batch) |

> [!NOTE]
> All time columns are in **microseconds** (divide by 1,000 for milliseconds, 1,000,000 for seconds).

> [!NOTE]
> `total_rows` counts rows flowing out of the plan's root operator — for stored procedures it is the rows for the last statement only in some cases. Use with caution for multi-statement procedures.

---

## sys.dm_os_wait_stats Baseline Pattern

```sql
-- Persistent wait stats tracking using a table
CREATE TABLE dbo.WaitStatsHistory (
    SnapshotID    INT IDENTITY(1,1) PRIMARY KEY,
    SnapshotTime  DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    WaitType      NVARCHAR(60) NOT NULL,
    WaitTasksCount BIGINT NOT NULL,
    WaitTimeMs    BIGINT NOT NULL,
    MaxWaitTimeMs BIGINT NOT NULL,
    SignalWaitMs  BIGINT NOT NULL
);

-- Insert current snapshot
INSERT INTO dbo.WaitStatsHistory
    (WaitType, WaitTasksCount, WaitTimeMs, MaxWaitTimeMs, SignalWaitMs)
SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    max_wait_time_ms,
    signal_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type NOT IN (
    'SLEEP_TASK','LAZYWRITER_SLEEP','SQLTRACE_BUFFER_FLUSH',
    'CHECKPOINT_QUEUE','BROKER_TO_FLUSH','BROKER_TASK_STOP',
    'WAITFOR','DISPATCHER_QUEUE_SEMAPHORE','XE_DISPATCHER_WAIT',
    'XE_TIMER_EVENT','CXCONSUMER','CLR_AUTO_EVENT','CLR_MANUAL_EVENT',
    'REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE'
)
AND wait_time_ms > 0;

-- Compare two snapshots
DECLARE @snap1 INT = 1, @snap2 INT = 2;   -- adjust IDs

SELECT
    a.WaitType,
    b.WaitTimeMs - a.WaitTimeMs             AS delta_wait_ms,
    b.WaitTasksCount - a.WaitTasksCount     AS delta_tasks,
    CAST(100.0 * (b.WaitTimeMs - a.WaitTimeMs)
        / NULLIF(SUM(b.WaitTimeMs - a.WaitTimeMs) OVER (), 0)
        AS DECIMAL(5,2))                    AS pct
FROM dbo.WaitStatsHistory a
JOIN dbo.WaitStatsHistory b
    ON a.WaitType = b.WaitType
    AND a.SnapshotID = @snap1
    AND b.SnapshotID = @snap2
WHERE b.WaitTimeMs > a.WaitTimeMs
ORDER BY delta_wait_ms DESC;
```

---

## Identify Top Queries by Resource

### Currently executing queries with wait info

```sql
SELECT
    r.session_id,
    r.status,
    r.wait_type,
    r.wait_time / 1000.0            AS wait_sec,
    r.cpu_time / 1000.0             AS cpu_sec,
    r.total_elapsed_time / 1000.0   AS elapsed_sec,
    r.logical_reads,
    r.writes,
    r.blocking_session_id,
    DB_NAME(r.database_id)          AS db_name,
    SUBSTRING(st.text,
        (r.statement_start_offset / 2) + 1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1)
        AS current_statement,
    r.percent_complete,
    r.estimated_completion_time / 1000.0 AS est_remaining_sec
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
WHERE r.session_id <> @@SPID
ORDER BY r.total_elapsed_time DESC;
```

### Session-level resource usage

```sql
SELECT
    s.session_id,
    s.login_name,
    s.status,
    s.cpu_time / 1000.0         AS cpu_sec,
    s.memory_usage * 8          AS memory_kb,
    s.total_elapsed_time / 1000 AS elapsed_sec,
    s.logical_reads,
    s.reads                     AS physical_reads,
    s.writes,
    s.last_request_start_time,
    c.net_transport,
    c.client_net_address,
    DB_NAME(s.database_id)      AS db_name
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_connections c ON s.session_id = c.session_id
WHERE s.is_user_process = 1
  AND s.session_id <> @@SPID
ORDER BY s.cpu_time DESC;
```

---

## sp_Blitz Family

The sp_Blitz family (Brent Ozar Unlimited, open source at [brentozar.com/blitz](https://www.brentozar.com/blitz/)) are the standard first-responder tools for SQL Server diagnostics. Install from GitHub into a utility database.

> [!NOTE]
> These are community tools, not Microsoft-shipped. They require installation. Source: [github.com/BrentOzarULTD/SQL-Server-First-Responder-Kit](https://github.com/BrentOzarULTD/SQL-Server-First-Responder-Kit) — verified open-source repository.

### sp_Blitz — instance health check

```sql
-- Full server health check: configuration issues, deferred maintenance, security problems
EXEC sp_Blitz;

-- Check only specific database
EXEC sp_Blitz @DatabaseName = 'YourDB';

-- Quick mode (skip checks that take >30 seconds)
EXEC sp_Blitz @CheckUserDatabaseObjects = 0;

-- Output to table for tracking over time
EXEC sp_Blitz @OutputDatabaseName = 'DBA', @OutputSchemaName = 'dbo',
              @OutputTableName = 'BlitzResults';
```

Key findings sp_Blitz detects:
- `optimize for ad hoc workloads` not enabled
- Auto-grow events in the last 24 hours
- Databases with no recent backup
- MAXDOP set to 0 on multi-socket servers
- Max server memory not configured (default unlimited)
- Databases in SIMPLE recovery on production servers
- Old compatibility levels
- Enabled trace flags

### sp_BlitzFirst — what's hurting right now

```sql
-- 5-second snapshot of what the instance is waiting on right now
EXEC sp_BlitzFirst;

-- 60-second sampling window (better signal)
EXEC sp_BlitzFirst @Seconds = 60;

-- Include expert mode (more detail)
EXEC sp_BlitzFirst @ExpertMode = 1;

-- Show currently executing queries
EXEC sp_BlitzFirst @ShowSleepingSPIDs = 0;
```

sp_BlitzFirst surfaces: top wait types in the sampling window, currently running long queries, blocking, memory pressure, TempDB spills.

### sp_BlitzCache — find expensive queries

```sql
-- Top 10 by CPU
EXEC sp_BlitzCache @SortOrder = 'cpu';

-- Top 10 by logical reads
EXEC sp_BlitzCache @SortOrder = 'reads';

-- Top 10 by duration
EXEC sp_BlitzCache @SortOrder = 'duration';

-- Top 10 by executions
EXEC sp_BlitzCache @SortOrder = 'executions';

-- Focus on one database
EXEC sp_BlitzCache @DatabaseName = 'YourDB', @SortOrder = 'cpu';

-- Check for warnings (implicit conversions, missing indexes, spills)
EXEC sp_BlitzCache @SortOrder = 'cpu', @ExpertMode = 1;
```

sp_BlitzCache also shows: plan age, memory grant waste, plan warnings, single-use plans.

### sp_BlitzIndex — index analysis

```sql
-- Missing, duplicate, and unused indexes in a database
EXEC sp_BlitzIndex @DatabaseName = 'YourDB';

-- Focus on a specific table
EXEC sp_BlitzIndex @DatabaseName = 'YourDB', @SchemaName = 'dbo',
                   @TableName = 'Orders';

-- Overlapping index detection
EXEC sp_BlitzIndex @Mode = 2, @DatabaseName = 'YourDB';

-- Diagnose a specific table's indexes
EXEC sp_BlitzIndex @Mode = 4, @DatabaseName = 'YourDB',
                   @SchemaName = 'dbo', @TableName = 'Orders';
```

sp_BlitzIndex flags: duplicate indexes, missing indexes, unused indexes (zero seeks in DMV lifetime), indexes with many columns, indexes never used for seeks (only scans), forwarded record piles.

### sp_BlitzLock — deadlock analysis

```sql
-- Analyze deadlocks from system_health XE session (last 4 hours default)
EXEC sp_BlitzLock;

-- Extend lookback window
EXEC sp_BlitzLock @StartDate = '2026-03-17 00:00', @EndDate = '2026-03-17 06:00';

-- Filter to specific database
EXEC sp_BlitzLock @DatabaseName = 'YourDB';
```

---

## Resource Governor Diagnostics

```sql
-- Current resource pool utilization
SELECT
    rp.name                         AS pool_name,
    rp.min_cpu_percent,
    rp.max_cpu_percent,
    rp.min_memory_percent,
    rp.max_memory_percent,
    rs.total_cpu_usage_ms / 1000.0  AS cpu_sec,
    rs.active_sessions_count,
    rs.active_requests_count,
    rs.queued_request_count,
    rs.total_queued_request_count,
    rs.out_of_memory_failure_count
FROM sys.resource_governor_resource_pools rp
JOIN sys.dm_resource_governor_resource_pools rs
    ON rp.pool_id = rs.pool_id;

-- Workload group utilization
SELECT
    wg.name                         AS group_name,
    rp.name                         AS pool_name,
    ws.total_request_count,
    ws.active_request_count,
    ws.queued_request_count,
    ws.total_cpu_usage_ms / 1000.0  AS cpu_sec,
    ws.total_lock_wait_time_ms,
    ws.total_query_optimization_count
FROM sys.resource_governor_workload_groups wg
JOIN sys.resource_governor_resource_pools rp
    ON wg.pool_id = rp.pool_id
JOIN sys.dm_resource_governor_workload_groups ws
    ON wg.group_id = ws.group_id;
```

---

## Memory Diagnostics

```sql
-- Buffer pool usage by database
SELECT
    DB_NAME(database_id)            AS db_name,
    COUNT(*) * 8 / 1024             AS cached_mb,
    SUM(CAST(is_modified AS INT)) * 8 / 1024 AS dirty_mb
FROM sys.dm_os_buffer_descriptors
WHERE database_id > 4   -- exclude system databases
GROUP BY database_id
ORDER BY cached_mb DESC;

-- Total memory usage breakdown
SELECT
    type,
    SUM(pages_kb) / 1024            AS used_mb
FROM sys.dm_os_memory_clerks
GROUP BY type
ORDER BY used_mb DESC;

-- Memory pressure signals
SELECT
    physical_memory_in_use_kb / 1024    AS physical_mb,
    locked_page_allocations_kb / 1024   AS locked_pages_mb,
    virtual_address_space_reserved_kb / 1024 AS vas_reserved_mb,
    page_fault_count,
    memory_utilization_percentage
FROM sys.dm_os_process_memory;

-- Plan cache memory
SELECT
    objtype,
    COUNT(*)                        AS plan_count,
    SUM(size_in_bytes) / 1024 / 1024 AS size_mb,
    SUM(usecounts)                  AS total_use_count
FROM sys.dm_exec_cached_plans
GROUP BY objtype
ORDER BY size_mb DESC;

-- RESOURCE_SEMAPHORE: queries waiting for memory grants
SELECT
    resource_semaphore_id,
    total_memory_kb / 1024          AS total_mb,
    available_memory_kb / 1024      AS available_mb,
    granted_memory_kb / 1024        AS granted_mb,
    used_memory_kb / 1024           AS used_mb,
    target_memory_kb / 1024         AS target_mb,
    max_target_memory_kb / 1024     AS max_target_mb,
    waiter_count
FROM sys.dm_exec_query_resource_semaphores;
```

---

## I/O Diagnostics

```sql
-- Virtual file stats: I/O latency per database file
SELECT
    DB_NAME(vfs.database_id)            AS db_name,
    mf.physical_name,
    mf.type_desc,
    vfs.io_stall_read_ms /
        NULLIF(vfs.num_of_reads, 0)     AS avg_read_ms,
    vfs.io_stall_write_ms /
        NULLIF(vfs.num_of_writes, 0)    AS avg_write_ms,
    vfs.io_stall /
        NULLIF(vfs.num_of_reads + vfs.num_of_writes, 0)
                                        AS avg_io_ms,
    vfs.num_of_reads,
    vfs.num_of_writes,
    vfs.num_of_bytes_read / 1024 / 1024  AS mb_read,
    vfs.num_of_bytes_written / 1024 / 1024 AS mb_written,
    vfs.size_on_disk_bytes / 1024 / 1024  AS size_mb
FROM sys.dm_io_virtual_file_stats(NULL, NULL) vfs
JOIN sys.master_files mf
    ON vfs.database_id = mf.database_id
    AND vfs.file_id = mf.file_id
ORDER BY avg_io_ms DESC;
```

Latency thresholds (rough guidance):
| Latency | Rating |
|---------|--------|
| < 1 ms | Excellent (NVMe/in-memory) |
| 1–5 ms | Good (SSD) |
| 5–20 ms | Acceptable (SSD with load) |
| 20–50 ms | Concerning |
| > 50 ms | Problem — investigate storage |

---

## CPU Diagnostics

```sql
-- CPU usage by session (current snapshot)
SELECT TOP 20
    s.session_id,
    s.login_name,
    s.cpu_time / 1000.0             AS cpu_sec,
    s.total_elapsed_time / 1000.0   AS elapsed_sec,
    s.logical_reads,
    DB_NAME(s.database_id)          AS db_name,
    s.last_request_start_time,
    SUBSTRING(st.text, 1, 200)      AS last_query
FROM sys.dm_exec_sessions s
CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) st
WHERE s.is_user_process = 1
ORDER BY s.cpu_time DESC;

-- Scheduler utilization (core-level load)
SELECT
    scheduler_id,
    cpu_id,
    is_online,
    is_idle,
    current_tasks_count,
    runnable_tasks_count,   -- queue depth: >1 sustained = CPU pressure
    work_queue_count,
    pending_disk_io_count,
    context_switches_count
FROM sys.dm_os_schedulers
WHERE status = 'VISIBLE ONLINE'
ORDER BY scheduler_id;
```

High `runnable_tasks_count` (>1 sustained across schedulers) = CPU saturation. Address by: reducing MAXDOP, adding CPUs, reducing query CPU consumption.

---

## Blocking and Deadlock Diagnostics

### Current blocking tree

```sql
-- Full blocking chain showing the head blocker
WITH BlockingChain AS (
    SELECT
        r.session_id,
        r.blocking_session_id,
        r.wait_type,
        r.wait_time / 1000.0    AS wait_sec,
        r.status,
        DB_NAME(r.database_id)  AS db_name,
        SUBSTRING(st.text,
            (r.statement_start_offset / 2) + 1,
            ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
              ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1)
            AS current_sql,
        0                       AS depth
    FROM sys.dm_exec_requests r
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
    WHERE r.blocking_session_id > 0
      AND r.blocking_session_id NOT IN (
          SELECT session_id FROM sys.dm_exec_requests WHERE blocking_session_id > 0
      )
    UNION ALL
    SELECT
        r.session_id,
        r.blocking_session_id,
        r.wait_type,
        r.wait_time / 1000.0,
        r.status,
        DB_NAME(r.database_id),
        SUBSTRING(st.text,
            (r.statement_start_offset / 2) + 1,
            ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
              ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1),
        bc.depth + 1
    FROM sys.dm_exec_requests r
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
    JOIN BlockingChain bc ON r.blocking_session_id = bc.session_id
)
SELECT * FROM BlockingChain ORDER BY depth, blocking_session_id;
```

### Deadlock information from system_health

```sql
-- Recent deadlocks from system_health XE session ring buffer
SELECT
    xdr.value('@timestamp', 'datetime2')    AS deadlock_time,
    xdr.query('.')                          AS deadlock_graph
FROM (
    SELECT CAST(target_data AS XML) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON t.event_session_address = s.address
    WHERE s.name = 'system_health'
      AND t.target_name = 'ring_buffer'
) AS data
CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]')
    AS XEventData(xdr)
ORDER BY deadlock_time DESC;
```

See [`33-extended-events.md`](33-extended-events.md) for setting up a dedicated deadlock capture session.

---

## TempDB Diagnostics

```sql
-- TempDB allocation contention (PFS/GAM/SGAM latch waits)
SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    max_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type LIKE 'PAGELATCH%'
  AND wait_time_ms > 0
ORDER BY wait_time_ms DESC;

-- Version store size in tempdb
SELECT
    reserved_page_count * 8 / 1024  AS version_store_mb,
    reserved_space_kb / 1024        AS reserved_mb
FROM sys.dm_db_file_space_usage
WHERE database_id = 2;  -- tempdb

-- Temp object usage (who is creating big temp tables)
SELECT
    t.session_id,
    SUM(t.user_object_reserved_page_count) * 8 AS user_object_kb,
    SUM(t.internal_object_reserved_page_count) * 8 AS internal_object_kb,
    SUM(t.version_store_reserved_page_count) * 8 AS version_store_kb
FROM sys.dm_db_task_space_usage t
GROUP BY t.session_id
ORDER BY user_object_kb + internal_object_kb DESC;
```

See [`34-tempdb.md`](34-tempdb.md) for tempdb file configuration, memory-optimized metadata, and contention resolution.

---

## Diagnostic Query Cookbook

### Find queries with the most memory grant waste

```sql
SELECT TOP 20
    qs.total_grant_kb / 1024             AS total_granted_mb,
    qs.total_used_grant_kb / 1024        AS total_used_mb,
    CAST(100.0 * qs.total_used_grant_kb / NULLIF(qs.total_grant_kb,0) AS DECIMAL(5,1))
                                         AS pct_used,
    qs.execution_count,
    SUBSTRING(st.text,
        (qs.statement_start_offset / 2) + 1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1)
        AS statement_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE qs.total_grant_kb > 0
  AND st.dbid = DB_ID()
ORDER BY total_granted_mb DESC;
```

### Find queries with the worst row estimate accuracy

```sql
-- Requires Query Store enabled (see 30-query-store.md)
SELECT TOP 20
    qsq.query_id,
    SUBSTRING(qst.query_sql_text, 1, 200)   AS sql_text,
    qsrs.avg_rowcount                        AS avg_actual_rows,
    -- estimated rows are in query plan XML
    qsp.plan_id,
    qsrs.count_executions
FROM sys.query_store_query qsq
JOIN sys.query_store_query_text qst ON qsq.query_text_id = qst.query_text_id
JOIN sys.query_store_plan qsp ON qsq.query_id = qsp.query_id
JOIN sys.query_store_runtime_stats qsrs ON qsp.plan_id = qsrs.plan_id
ORDER BY qsrs.count_executions DESC;
```

### Find stale plan cache entries (recompile candidates)

```sql
-- Plans with very high max/min ratio (parameter sniffing victims)
SELECT TOP 20
    qs.execution_count,
    qs.max_worker_time / 1000           AS max_cpu_ms,
    qs.min_worker_time / 1000           AS min_cpu_ms,
    qs.max_worker_time / NULLIF(qs.min_worker_time, 0)
                                        AS max_min_ratio,
    qs.max_logical_reads,
    qs.min_logical_reads,
    SUBSTRING(st.text,
        (qs.statement_start_offset / 2) + 1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1)
        AS statement_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.dbid = DB_ID()
  AND qs.execution_count > 10
  AND qs.min_worker_time > 0
ORDER BY max_min_ratio DESC;
```

---

## Gotchas / Anti-patterns

1. **Using NOLOCK as a performance fix.** NOLOCK does not eliminate waits — it skips lock *acquisition*. The underlying I/O cost is the same. If PAGEIOLATCH waits are the problem, NOLOCK doesn't help. If LCK_M_S waits are the problem, fix the blocking instead.

2. **Clearing wait stats to "reset" before a test.** `DBCC SQLPERF('sys.dm_os_wait_stats', CLEAR)` resets all cumulative counters instance-wide. Safe in isolation testing environments, but never run on shared production systems.

3. **Trusting wait stats during index rebuild.** REBUILD operations generate a lot of PAGEIOLATCH and WRITELOG waits. If a maintenance window was running during your capture window, your baseline will be polluted.

4. **Over-using OPTION (RECOMPILE).** Effective for parameter sniffing, but every execution compiles fresh — there's CPU overhead per call. For frequently-called procs (>100/sec), the compilation overhead may exceed the sniffing problem. Profile before applying.

5. **Missing index DMV suggestions on hot tables.** The DMV records *every* suggestion — including those for table scans on tiny tables where a full scan is fine. Always filter by `estimated_improvement` and validate against actual query volume before creating.

6. **Comparing plan cache stats after a FREEPROCCACHE.** After `DBCC FREEPROCCACHE`, all plans are evicted. The DMV counters reset to zero. Never run FREEPROCCACHE on production to "see what happens" — it causes a compilation storm.

7. **Forgetting that wait stats are cumulative from restart.** A server that restarts daily has 8-hour-old wait stats. A server that hasn't restarted in 6 months has highly diluted averages. Always collect a delta, not absolutes.

8. **Interpreting CXPACKET waits incorrectly.** CXPACKET alone doesn't mean parallelism is bad. It means threads are waiting for each other. Look at whether work is evenly distributed — skewed CXPACKET with one slow thread is a cardinality problem, not a MAXDOP problem.

9. **Applying query hints to views.** Hints on a view reference sometimes don't propagate correctly into the view's base query. Always verify the resulting plan matches your intent.

10. **sp_BlitzCache sorting by "executions" to find hot procs.** High execution count is noise unless paired with per-execution cost. Sort by CPU or reads first; executions is context only.

11. **Chasing every sp_Blitz finding.** sp_Blitz surfaces dozens of findings. Not all are critical. Findings are sorted by Priority — address Priority 1-20 first. Some findings (like "last backup was 23 hours ago" on a test server) are acceptable by design.

12. **Diagnosing ASYNC_NETWORK_IO as a network problem.** Most ASYNC_NETWORK_IO wait is the application not consuming rows fast enough, not physical network saturation. Profile the application's fetch pattern first.

---

## See Also

- [`29-query-plans.md`](29-query-plans.md) — reading and interpreting execution plans
- [`30-query-store.md`](30-query-store.md) — Query Store for regression detection
- [`31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — IQP and adaptive features
- [`13-transactions-locking.md`](13-transactions-locking.md) — isolation levels and lock types
- [`33-extended-events.md`](33-extended-events.md) — capturing events for diagnostics
- [`34-tempdb.md`](34-tempdb.md) — tempdb sizing and contention
- [`49-configuration-tuning.md`](49-configuration-tuning.md) — sp_configure, MAXDOP, memory

---

## Sources

[^1]: [SQL Server First Responder Kit](https://github.com/BrentOzarULTD/SQL-Server-First-Responder-Kit) — open-source repository containing sp_Blitz, sp_BlitzCache, sp_BlitzFirst, sp_BlitzIndex, and related diagnostic stored procedures
[^2]: [sp_Blitz®: Free SQL Server Health Check Script by Brent Ozar](https://www.brentozar.com/blitz/) — documentation and download page for the sp_Blitz health check script
[^3]: [SQL Server Wait Statistics: Tell me where it hurts](https://www.sqlskills.com/blogs/paul/wait-statistics-or-please-tell-me-where-it-hurts/) — Paul Randal's canonical methodology for wait statistics analysis, including benign wait exclusion list and delta-snapshot approach
[^4]: [sys.dm_exec_query_stats (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-stats-transact-sql) — reference for the DMV that returns aggregate performance statistics for cached query plans
[^5]: [sys.dm_os_wait_stats (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-os-wait-stats-transact-sql) — reference for the DMV that returns information about all waits encountered by executing threads
[^6]: [sys.dm_db_missing_index_details (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-missing-index-details-transact-sql) — reference for the DMV that returns detailed information about missing indexes
[^7]: [Query Hints (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query) — complete reference for OPTION clause query hints that override optimizer decisions
[^8]: [sys.sp_query_store_set_hints (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sys-sp-query-store-set-hints-transact-sql) — reference for the stored procedure that creates or updates Query Store hints for a query without changing application code (SQL Server 2022+)
[^9]: [Server Configuration: optimize for ad hoc workloads - SQL Server](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/optimize-for-ad-hoc-workloads-server-configuration-option) — documentation for the server option that reduces plan cache bloat from single-use ad hoc batches
[^10]: Itzik Ben-Gan — T-SQL Querying (Microsoft Press) — wait stats interpretation and query tuning methodology

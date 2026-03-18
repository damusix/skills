# 34 — TempDB: Architecture, Sizing, and Contention

## Table of Contents

1. [When to Use This Reference](#when-to-use)
2. [TempDB Architecture Overview](#architecture)
3. [What Lives in TempDB](#what-lives)
4. [Allocation Latch Contention](#allocation-latch)
5. [Sizing Rules and File Count](#sizing-rules)
6. [Memory-Optimized TempDB Metadata](#memory-optimized-metadata)
7. [Temp Tables vs Table Variables vs CTEs](#temp-vs-table-var)
8. [Version Store and Row Versioning Impact](#version-store)
9. [Monitoring TempDB Contention](#monitoring)
10. [TempDB in Azure SQL](#azure-sql)
11. [TempDB and Always On](#always-on)
12. [Configuration and Maintenance](#configuration)
13. [Metadata Queries](#metadata-queries)
14. [Common Patterns](#patterns)
15. [Gotchas](#gotchas)
16. [See Also](#see-also)
17. [Sources](#sources)

---

## When to Use This Reference <a name="when-to-use"></a>

Load this file when the user asks about:
- TempDB latch contention (`PAGELATCH_EX` / `PAGELATCH_SH` on `2:1:1`, `2:1:2`, `2:1:3`)
- How many TempDB files to create
- Temp tables vs table variables vs CTEs performance
- Version store growth (RCSI / Snapshot Isolation)
- TempDB sizing and monitoring
- `memory-optimized tempdb metadata` (SQL Server 2019+)
- TempDB in containers or Azure SQL

---

## TempDB Architecture Overview <a name="architecture"></a>

TempDB is a **global, shared, single-instance system database** that is recreated from scratch every time SQL Server starts. It cannot be backed up or restored — its contents are always ephemeral.

### Key characteristics

| Property | Value |
|---|---|
| Database ID | 2 (always) |
| Recovery model | Simple (always — cannot change) |
| Recreated on | Every SQL Server service restart |
| Shared by | All databases on the instance |
| Scope of objects | Session-local (# temp tables), global (## tables), permanent until drop |

### Internal structure

TempDB contains three categories of pages:

1. **Allocation bitmaps** — GAM (Global Allocation Map), SGAM (Shared Global Allocation Map), PFS (Page Free Space) pages track which extents/pages are free or mixed
2. **User objects** — temp tables (`#`, `##`), table variables, indexes on temp tables, spills
3. **Internal objects** — sort runs, hash table build input, cursor storage, LOB materialisation, XML variable storage, Service Broker, version store

The critical insight: **allocation bitmaps are shared across all sessions**. Every object creation acquires a latch on the relevant bitmap page. Under high concurrency this becomes the bottleneck.

---

## What Lives in TempDB <a name="what-lives"></a>

| Category | Examples |
|---|---|
| User temp tables | `CREATE TABLE #foo`, `SELECT INTO #foo` |
| Global temp tables | `##GlobalFoo` — visible to all sessions until creator disconnects |
| Table variables | `DECLARE @t TABLE (...)` |
| Index spills | Sort/Hash spills when memory grant is exhausted |
| Row version store | RCSI, Snapshot Isolation, triggers with OUTPUT, MARS, online index builds |
| Online index rebuild | Intermediate pages during `REBUILD ... ONLINE` |
| DBCC | CHECKDB with ESTIMATEONLY uses TempDB for internal structures |
| Statistics | Some in-memory statistics operations |
| Service Broker | Internal queue work tables |
| Cursors (STATIC) | Full snapshot of cursor result set |

---

## Allocation Latch Contention <a name="allocation-latch"></a>

### Root cause

When many concurrent sessions create or drop temp objects, they all compete to update the same **GAM/SGAM/PFS pages** in TempDB data files. These are:

- Page `2:1:1` — PFS (Page Free Space) for the first 8,088 pages
- Page `2:1:2` — GAM (Global Allocation Map) — tracks uniform extents
- Page `2:1:3` — SGAM (Shared Global Allocation Map) — tracks mixed extents

The contention shows up as `PAGELATCH_EX` or `PAGELATCH_SH` wait types with resource names like `2:1:1`.

> [!NOTE] The "latch" in `PAGELATCH_EX` is a **buffer pool page latch** protecting the in-memory page — this is **not** an I/O latch (`PAGEIOLATCH_*`). The fix is more files, not faster disks.

### How multiple files fix it

SQL Server uses a **proportional fill algorithm** — it distributes object allocation across all TempDB data files proportionally to their free space. More equally-sized files = fewer sessions competing for the same bitmap page.

Each file has its own set of GAM/SGAM/PFS pages, so contention is divided across files.

### Identifying the problem

```sql
-- Look for PAGELATCH_EX/SH waits on TempDB pages
SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    resource_description
FROM sys.dm_os_wait_stats
WHERE wait_type LIKE 'PAGELATCH%'
ORDER BY wait_time_ms DESC;

-- Cross-reference resource_description to identify TempDB
-- Resource format: DatabaseId:FileId:PageId
-- TempDB = database_id 2

-- Check currently waiting requests
SELECT
    r.session_id,
    r.wait_type,
    r.wait_resource,
    r.wait_time,
    t.text AS sql_text
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.wait_type LIKE 'PAGELATCH%'
  AND r.wait_resource LIKE '2:%';
```

---

## Sizing Rules and File Count <a name="sizing-rules"></a>

### File count formula

Microsoft's guidance (revised with SQL Server 2016 improvements):

| Logical CPU count | Recommended TempDB files |
|---|---|
| ≤ 8 cores | 1 file per core (equal to core count) |
| > 8 cores | Start with 8, add in groups of 4 if contention persists |
| Very high concurrency | More files reduce contention but add management overhead; 16 is usually the ceiling |

> [!NOTE] SQL Server 2016 introduced improved PFS page latch contention reduction using a round-robin allocation hint, making the file count formula less aggressive than the old "1 per core" rule. However, multiple equally-sized files is still the correct approach.

### File size rules

- All data files **must be equal size**. Proportional fill uses file size as the weight; unequal files defeat the distribution.
- **Disable autogrowth differences**: set all files to the same initial size and the same autogrowth increment.
- Pre-size TempDB to avoid runtime autogrowth events (which serialize under a lock).
- A common starting point: size TempDB to the largest known workspace need during peak hours, divided across files.

### Recommended configuration

```sql
-- Check current TempDB file configuration
SELECT
    name,
    physical_name,
    size * 8 / 1024 AS size_mb,
    growth,
    is_percent_growth,
    max_size
FROM tempdb.sys.database_files
WHERE type = 0;  -- data files only

-- Alter files to equal size (example: 4 files at 4 GB each)
-- Run this for each file; adjust paths as needed
ALTER DATABASE tempdb
MODIFY FILE (NAME = 'tempdev', SIZE = 4096 MB, FILEGROWTH = 512 MB);

ALTER DATABASE tempdb
ADD FILE (NAME = 'tempdev2', FILENAME = 'D:\tempdb\tempdev2.ndf', SIZE = 4096 MB, FILEGROWTH = 512 MB);
ALTER DATABASE tempdb
ADD FILE (NAME = 'tempdev3', FILENAME = 'D:\tempdb\tempdev3.ndf', SIZE = 4096 MB, FILEGROWTH = 512 MB);
ALTER DATABASE tempdb
ADD FILE (NAME = 'tempdev4', FILENAME = 'D:\tempdb\tempdev4.ndf', SIZE = 4096 MB, FILEGROWTH = 512 MB);
```

> [!WARNING] TempDB file count and initial size changes survive restarts because they are stored in master — but you cannot reduce file count (SQL Server cannot remove data files from TempDB while running). Restarts are required for size changes to take effect in some configurations. Use `mssql-conf` or SQL Server Configuration Manager to set startup parameters.

### Log file

TempDB has only one log file. Frequent autogrowth events on the log file indicate:
- Long-running transactions that aren't committing
- Version store accumulation (RCSI/SI — see [Version Store](#version-store))
- Bulk operations without checkpoints

---

## Memory-Optimized TempDB Metadata <a name="memory-optimized-metadata"></a>

> [!NOTE] SQL Server 2019

SQL Server 2019 introduced **memory-optimized TempDB metadata**, which moves the internal system tables that track temp object allocation into In-Memory OLTP structures. This eliminates latch contention on those system objects entirely for many workloads.

### Enable

```sql
-- Check current state
SELECT SERVERPROPERTY('IsTempDbMetadataMemoryOptimized');

-- Enable (requires restart)
ALTER SERVER CONFIGURATION SET MEMORY_OPTIMIZED TEMPDB_METADATA = ON;

-- Verify after restart
SELECT SERVERPROPERTY('IsTempDbMetadataMemoryOptimized');
-- Returns 1 when active
```

### What it eliminates

The following system tables are moved to memory-optimized structures:
- `sys.sysobjvalues`
- `sys.sysschobjs`
- `sys.sysallocunits`
- `sys.sysfiles1`
- `sys.syshobtcolumns`
- `sys.syshobts`
- `sys.sysidxstats`

### Limitations

- Requires in-memory OLTP component installed (it's included in default install, but the feature must be enabled on the instance)
- Requires restart after enabling
- Does not help with row versioning/version store contention — that is a separate issue
- Does not eliminate all TempDB latch contention — external allocation pages (GAM/PFS for user temp object pages) still exist

### When it helps most

- Highly concurrent OLTP workloads with many concurrent temp table creates/drops
- Workloads where `PAGELATCH_EX` / `PAGELATCH_SH` on `2:1:1` family is the dominant wait
- When adding more files has already been done and contention persists

---

## Temp Tables vs Table Variables vs CTEs <a name="temp-vs-table-var"></a>

This is one of the most frequently misunderstood performance topics.

### Comparison table

| Dimension | Temp Table (`#t`) | Table Variable (`@t`) | CTE |
|---|---|---|---|
| Storage location | TempDB | TempDB (usually) | None — re-evaluated inline |
| Statistics | Yes (auto-created) | No (fixed cardinality estimate) | None — uses source statistics |
| Cardinality estimate | From statistics | Fixed: 1 row (pre-2019) or deferred (2019+) | Depends on the source tables |
| Index support | Yes (all index types) | Limited (inline PRIMARY KEY, UNIQUE only) | No |
| Parallelism | Yes | Yes | Yes |
| Transaction scope | Survives COMMIT/ROLLBACK of outer transaction | Same as temp table — contents rolled back | N/A |
| DDL rollback | Table dropped on rollback of CREATE | Table dropped on rollback | N/A |
| Scope | Current proc + called procs | Current batch only | Current statement only |
| Recompile trigger | Column changes, statistics updates | Rarely | N/A |
| INSERT logging | Minimal (SELECT INTO from base tables, under Simple/Bulk-Logged) | Same as temp table | N/A |

### Practical guidance

**Use a temp table when:**
- Row count will be > a few hundred (statistics matter for plan accuracy)
- You need an index on the temp data
- You need to read the data multiple times in different queries
- You need the result to be available across procedure calls

**Use a table variable when:**
- Row count is small and known (1–100 rows), statistics won't help anyway
- You want to avoid recompile triggers
- You need the result to survive a ROLLBACK (table variable contents are NOT rolled back)
- You need to pass the result as a TVP

**Use a CTE when:**
- The result is only referenced once (CTEs are not materialized — they re-execute per reference)
- You need recursive traversal
- Readability matters more than physical control of the intermediate result

> [!WARNING] A common myth is that "table variables are stored in memory." They are stored in TempDB exactly like temp tables, but they do not generate statistics. The real difference is cardinality estimation, not storage.

### Table variable deferred compilation (2019+, compat 150+)

> [!NOTE] SQL Server 2019

With database compatibility level 150+, SQL Server defers the compilation of statements using table variables until the table variable has been populated. This allows the optimizer to use the actual row count for cardinality estimation, largely eliminating the "1 row" estimate problem.

```sql
-- Verify deferred compilation is active
SELECT name, value
FROM sys.database_scoped_configurations
WHERE name = 'DEFERRED_COMPILATION_TV';
-- Default is ON for compat 150+

-- Disable if causing regressions
ALTER DATABASE SCOPED CONFIGURATION SET DEFERRED_COMPILATION_TV = OFF;
```

### Temp table caching

SQL Server **caches temp tables in stored procedures** to avoid repeated object creation overhead. Conditions for caching:
- The temp table is created inside a stored procedure (not an ad hoc batch)
- The object name and structure have not changed
- The procedure has not been recompiled since last execution

When a cached temp table is reused, a truncate-equivalent happens silently, and the structure is reused without going through full allocation. This makes temp tables inside stored procedures much cheaper than perceived.

---

## Version Store and Row Versioning Impact <a name="version-store"></a>

The version store is located in TempDB and is used by:

| Feature | When versions are generated |
|---|---|
| RCSI (`READ_COMMITTED_SNAPSHOT ON`) | Every `UPDATE`/`DELETE` on tables in that database |
| Snapshot Isolation (`ALLOW_SNAPSHOT_ISOLATION ON`) | During snapshot transactions |
| Triggers with `OUTPUT INTO` | During trigger execution |
| MARS (Multiple Active Result Sets) | Open result sets across batches |
| Online index operations | During the index rebuild |
| Accelerated Database Recovery (2019+) | PVS in user database, but version store in TempDB still used |

### Version store structure

Each row version is stored as a copy of the before-image with a **14-byte version tag** appended. Versions are chained:

```
Current row → version 3 → version 2 → version 1
              (in version store)
```

Versions are cleaned up by a background **version cleanup** process once no active transaction needs them.

### Monitoring version store size

```sql
-- Current version store size and cleanup rate
SELECT
    reserved_page_count * 8.0 / 1024 AS version_store_mb,
    reserved_extent_count,
    elapsed_time_seconds,
    rows_returned,
    cleanup_version
FROM sys.dm_tran_version_store_space_usage;

-- Active snapshot transactions holding old versions
SELECT
    transaction_id,
    elapsed_time_seconds,
    transaction_sequence_num,
    is_snapshot,
    session_id
FROM sys.dm_tran_active_snapshot_database_transactions
ORDER BY elapsed_time_seconds DESC;

-- How much of the version store does each database contribute?
SELECT
    database_name,
    reserved_space_kb / 1024.0 AS reserved_mb,
    reserved_space_kb / 1024.0 / 1024.0 AS reserved_gb
FROM sys.dm_tran_version_store_space_usage
ORDER BY reserved_space_kb DESC;
```

### Common version store growth problems

| Cause | Symptom | Fix |
|---|---|---|
| Long-running snapshot/RCSI transaction | Single old `transaction_sequence_num` holds all cleanup | Find and kill the session; fix the application |
| Abandoned open transactions | `elapsed_time_seconds` grows indefinitely | Detect via `sys.dm_exec_sessions` — `open_transaction_count > 0` |
| High UPDATE/DELETE rate without RCSI | Rapid version store growth | Review whether RCSI is needed; tune the workload |
| Blocking on cleanup thread | Version store grows faster than cleanup can keep up | Typically caused by the above; fix the root cause |

---

## Monitoring TempDB Contention <a name="monitoring"></a>

### Latch contention dashboard

```sql
-- Top latch waits by total wait time (last reset or restart)
SELECT TOP 20
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    max_wait_time_ms,
    CASE
        WHEN wait_type LIKE 'PAGELATCH%' THEN 'Potential TempDB contention — check resource_description'
        WHEN wait_type LIKE 'PAGEIOLATCH%' THEN 'I/O-related — check disk'
        ELSE ''
    END AS diagnosis
FROM sys.dm_os_wait_stats
WHERE wait_type LIKE '%LATCH%'
ORDER BY wait_time_ms DESC;
```

### TempDB space usage

```sql
-- Overall TempDB space usage by category
SELECT
    SUM(user_object_reserved_page_count) * 8 AS user_objects_kb,
    SUM(internal_object_reserved_page_count) * 8 AS internal_objects_kb,
    SUM(version_store_reserved_page_count) * 8 AS version_store_kb,
    SUM(unallocated_extent_page_count) * 8 AS free_space_kb,
    SUM(mixed_extent_page_count) * 8 AS mixed_extents_kb
FROM sys.dm_db_file_space_usage
WHERE database_id = 2;

-- Per-session TempDB usage (who is using the most space?)
SELECT TOP 20
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    t.user_objects_alloc_page_count * 8 AS user_obj_kb,
    t.internal_objects_alloc_page_count * 8 AS internal_obj_kb,
    t.user_objects_alloc_page_count * 8
        + t.internal_objects_alloc_page_count * 8 AS total_kb
FROM sys.dm_db_session_space_usage t
JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id
WHERE t.user_objects_alloc_page_count + t.internal_objects_alloc_page_count > 0
ORDER BY total_kb DESC;

-- Per-task (request-level) TempDB usage
SELECT TOP 10
    r.session_id,
    r.request_id,
    t.user_objects_alloc_page_count * 8 AS user_obj_kb,
    t.internal_objects_alloc_page_count * 8 AS internal_obj_kb,
    q.text AS sql_text
FROM sys.dm_db_task_space_usage t
JOIN sys.dm_exec_requests r
    ON t.session_id = r.session_id AND t.request_id = r.request_id
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) q
ORDER BY (t.user_objects_alloc_page_count + t.internal_objects_alloc_page_count) DESC;
```

### File-level space monitoring

```sql
-- TempDB file sizes and free space
SELECT
    name,
    physical_name,
    size * 8 / 1024 AS size_mb,
    FILEPROPERTY(name, 'SpaceUsed') * 8 / 1024 AS used_mb,
    (size - FILEPROPERTY(name, 'SpaceUsed')) * 8 / 1024 AS free_mb
FROM tempdb.sys.database_files
WHERE type = 0;
```

---

## TempDB in Azure SQL <a name="azure-sql"></a>

### Azure SQL Database

- TempDB is shared per **elastic pool** or per **single database** depending on tier
- File count is managed automatically by Azure — you cannot add files
- Latch contention is typically managed at the platform level
- Memory-optimized metadata is enabled by default on newer service objectives
- Version store is in the **user database** for Azure SQL (Accelerated Database Recovery moves version store to the user DB's PVS)
- `sys.dm_db_file_space_usage` still works to check usage
- You cannot run `ALTER DATABASE tempdb`

### Azure SQL Managed Instance

- Behaves more like on-premises SQL Server
- You can configure TempDB file count via Azure portal or with SQL commands during provisioning
- Memory-optimized metadata follows the same rules as on-premises SQL 2019+

### Azure SQL Hyperscale

- Uses a dedicated TempDB service; latency characteristics differ from standard
- Local SSD-backed TempDB per compute node

---

## TempDB and Always On <a name="always-on"></a>

TempDB is **not replicated** to secondary replicas — each node in an AG has its own TempDB. This has important implications:

- Readable secondary queries that spill to TempDB use the **secondary's TempDB** — size it appropriately
- Version store for RCSI queries on the secondary is in the **secondary's TempDB**
- Online index operations that use TempDB use the node where they run
- After failover, TempDB is recreated from scratch on the new primary on the next restart — all temp objects from before the failover are gone (which is expected behavior)

---

## Configuration and Maintenance <a name="configuration"></a>

### Startup parameters (mssql-conf on Linux)

```bash
# Set TempDB file count and size via mssql-conf
mssql-conf set sqlagent.errorlogfile /var/opt/mssql/log/sqlagent.out
mssql-conf set tempdb.numberoffiles 8
mssql-conf set tempdb.filegrowth 256
mssql-conf set tempdb.maxsize 0   # 0 = unlimited
mssql-conf set tempdb.filesize 4096  # MB
```

### Model database TempDB settings

SQL Server derives some TempDB file defaults from the `model` database at startup. However, file count and path are controlled by startup parameters and the last-known TempDB configuration stored in master.

### Preventing TempDB from growing unbounded

```sql
-- Set max size on TempDB files to prevent runaway growth
-- (also set alert on low disk space — do not rely on max size alone)
ALTER DATABASE tempdb
MODIFY FILE (NAME = 'tempdev', MAXSIZE = 10240 MB);

-- Set up an alert using SQL Server Agent for low disk space
-- Or use a monitoring tool (see 50-sql-server-agent.md)
```

### Cannot shrink TempDB files that are in use

```sql
-- Shrink TempDB data file (only works if space is truly free)
USE tempdb;
DBCC SHRINKFILE (tempdev, 1024);  -- target size in MB

-- Check why shrink is not working — active version store or temp objects
SELECT * FROM sys.dm_db_file_space_usage WHERE database_id = 2;
```

> [!WARNING] DBCC SHRINKFILE on TempDB causes **significant fragmentation** of internal allocation structures and is not recommended in production. The only safe approach to reduce TempDB file size is to restart SQL Server with a smaller initial file size configured.

---

## Metadata Queries <a name="metadata-queries"></a>

```sql
-- List all TempDB files
SELECT name, type_desc, physical_name,
       size * 8 / 1024 AS size_mb,
       growth,
       is_percent_growth
FROM tempdb.sys.database_files;

-- Temp objects currently in TempDB (user-visible)
SELECT
    name,
    object_id,
    type_desc,
    create_date
FROM tempdb.sys.objects
WHERE is_ms_shipped = 0
ORDER BY create_date DESC;

-- Active version store transactions (what's preventing version cleanup?)
SELECT
    s.session_id,
    s.login_name,
    s.open_transaction_count,
    t.elapsed_time_seconds,
    t.transaction_sequence_num,
    t.is_snapshot
FROM sys.dm_tran_active_snapshot_database_transactions t
LEFT JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id
ORDER BY t.elapsed_time_seconds DESC;

-- Check if memory-optimized TempDB metadata is enabled
SELECT SERVERPROPERTY('IsTempDbMetadataMemoryOptimized') AS is_memory_optimized;

-- PFS/GAM/SGAM latch waits — the TempDB contention signature
SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    max_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type IN ('PAGELATCH_EX', 'PAGELATCH_SH', 'PAGELATCH_UP')
ORDER BY wait_time_ms DESC;
```

---

## Common Patterns <a name="patterns"></a>

### Pattern 1: Safe temp table in a stored procedure

```sql
CREATE OR ALTER PROCEDURE dbo.usp_ProcessOrders
    @DateFrom DATE,
    @DateTo   DATE
AS
BEGIN
    SET NOCOUNT ON;

    -- Temp table: statistics created, indexes supported
    CREATE TABLE #staging (
        OrderID   INT          NOT NULL,
        OrderDate DATE         NOT NULL,
        TotalAmt  DECIMAL(9,2) NOT NULL,
        INDEX ix_staging_date (OrderDate)
    );

    INSERT INTO #staging (OrderID, OrderDate, TotalAmt)
    SELECT o.OrderID, o.OrderDate, o.TotalAmt
    FROM dbo.Orders o
    WHERE o.OrderDate BETWEEN @DateFrom AND @DateTo;

    -- Further processing using #staging
    SELECT * FROM #staging WHERE TotalAmt > 1000;
END;
```

### Pattern 2: Detecting and killing version store blocker

```sql
-- Find the session holding the oldest snapshot transaction
SELECT TOP 1
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    t.elapsed_time_seconds,
    t.transaction_sequence_num
FROM sys.dm_tran_active_snapshot_database_transactions t
JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id
ORDER BY t.elapsed_time_seconds DESC;

-- If confirmed: KILL <session_id>
```

### Pattern 3: Measuring spill to TempDB via XE

```sql
-- Create a session to catch hash/sort spills (see 33-extended-events.md)
CREATE EVENT SESSION [TempDB_Spills] ON SERVER
ADD EVENT sqlserver.hash_warning,
ADD EVENT sqlserver.sort_warning
ADD TARGET package0.ring_buffer (SET max_memory = 51200)
WITH (MAX_DISPATCH_LATENCY = 5 SECONDS);

ALTER EVENT SESSION [TempDB_Spills] ON SERVER STATE = START;

-- Read spill events
SELECT
    CAST(target_data AS XML).query('
        //RingBufferTarget/event[@name="hash_warning" or @name="sort_warning"]
    ') AS spill_events
FROM sys.dm_xe_session_targets t
JOIN sys.dm_xe_sessions s ON t.event_session_address = s.address
WHERE s.name = 'TempDB_Spills';
```

### Pattern 4: TempDB usage alert via SQL Agent

```sql
-- Check TempDB free space percentage and alert if below threshold
-- (Run as SQL Agent job every 5 minutes)
DECLARE @free_pct FLOAT;
SELECT @free_pct =
    100.0 * SUM(unallocated_extent_page_count)
    / NULLIF(SUM(total_page_count), 0)
FROM sys.dm_db_file_space_usage
WHERE database_id = 2;

IF @free_pct < 20
BEGIN
    EXEC msdb.dbo.sp_send_dbmail
        @profile_name = 'DBA Alerts',
        @recipients   = 'dba@example.com',
        @subject      = 'TempDB low space',
        @body         = 'TempDB free space is below 20%.';
END;
```

---

## Gotchas <a name="gotchas"></a>

1. **PAGELATCH ≠ disk I/O problem.** `PAGELATCH_EX` on TempDB is a concurrency problem, not a storage performance problem. Adding faster disks will not fix it. Add equally-sized data files.

2. **Unequal file sizes defeat proportional fill.** If one TempDB file is 8 GB and another is 1 GB, almost all allocations go to the 8 GB file. All files must be the same size.

3. **Table variables are not always in memory.** They live in TempDB just like temp tables. The difference is statistics, not location.

4. **CTE re-execution.** A CTE referenced twice in a query executes twice. If it reads from a base table, that scan happens twice. Use a temp table to materialize when the CTE is expensive and referenced multiple times. See `references/04-ctes.md`.

5. **Version store holds TempDB space until cleanup.** Even if you commit all your transactions, the version store is not immediately released — background cleanup runs asynchronously. Long-running snapshot transactions on any database on the instance delay cleanup for the entire instance.

6. **TempDB objects do not survive restart.** Global temp tables (`##`) and regular temp tables are all dropped on restart. Do not rely on them for cross-session persistence beyond a running instance.

7. **Temp table caching only works inside stored procedures.** Temp tables created in ad hoc batches are not cached and incur full creation overhead every time.

8. **SHRINKFILE degrades TempDB allocation structures.** Shrinking causes extent fragmentation in the allocation bitmaps, worsening future latch contention. Avoid it except in emergencies.

9. **Memory-optimized TempDB metadata requires a restart.** Enabling it with `ALTER SERVER CONFIGURATION` takes effect only after the next SQL Server service restart.

10. **Online index operations use TempDB.** Large online index rebuilds can consume significant TempDB space. Plan and monitor accordingly, especially on busy instances.

11. **Readable secondary TempDB is separate.** Queries on an AG secondary that spill to TempDB use the secondary's own TempDB. Size both primary and secondary TempDB appropriately if you use readable secondaries.

12. **`#temp` tables in dynamic SQL share session scope.** A temp table created inside `sp_executesql` is visible in the calling scope. This is by design (TempDB temp tables are session-scoped) but can be surprising.

---

## See Also <a name="see-also"></a>

- `references/13-transactions-locking.md` — RCSI, Snapshot Isolation, version store background
- `references/18-in-memory-oltp.md` — memory-optimized tables do not use TempDB
- `references/29-query-plans.md` — detecting hash/sort spills in plans
- `references/33-extended-events.md` — capturing spill events with XE sessions
- `references/31-intelligent-query-processing.md` — memory grant feedback reduces spills

---

## Sources

[^1]: [tempdb Database - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/databases/tempdb-database) — Microsoft Learn reference covering TempDB architecture, physical properties, file configuration, performance optimization, and Azure SQL behavior
[^2]: [tempdb Database - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/databases/tempdb-database#memory-optimized-tempdb-metadata) — Section on memory-optimized TempDB metadata (SQL Server 2019+), including enabling, limitations, and resource pool binding
[^3]: [sys.dm_db_file_space_usage (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-file-space-usage-transact-sql) — DMV reference for monitoring per-file space usage in TempDB (user objects, internal objects, version store, free space)
[^4]: [sys.dm_db_session_space_usage (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-session-space-usage-transact-sql) — DMV reference for tracking TempDB page allocations and deallocations per session
[^5]: [Recommendations to reduce allocation contention - SQL Server](https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/performance/recommendations-reduce-allocation-contention) — Microsoft CSS guidance on diagnosing and resolving PAGELATCH contention in TempDB, including file count and sizing recommendations
[^6]: [Only One TempDB Data File - Brent Ozar Unlimited®](https://www.brentozar.com/blitz/tempdb-data-files/) — Brent Ozar's explanation of TempDB multiple data files, proportional fill algorithm, GAM/SGAM/PFS latch contention, and practical remediation steps
[^7]: [A SQL Server DBA myth a day: (12/30) tempdb should always have one data file per processor core](https://www.sqlskills.com/blogs/paul/a-sql-server-dba-myth-a-day-1230-tempdb-should-always-have-one-data-file-per-processor-core/) — Paul Randal's analysis of TempDB allocation page latch contention, file sizing nuances, and why the "one file per core" rule is a myth
[^8]: [tempdb Database - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/databases/tempdb-database#capacity-planning-for-tempdb-in-sql-server) — Capacity planning section of the TempDB reference covering workload analysis, autogrowth configuration, and sizing methodology

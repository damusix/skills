# 35 — DBCC Commands Reference

Comprehensive reference for DBCC (Database Console Commands) in SQL Server — integrity checks,
cache management, maintenance, and diagnostics.

---

## Table of Contents

1. [When to Use](#when-to-use)
2. [DBCC CHECKDB](#dbcc-checkdb)
3. [DBCC CHECKTABLE](#dbcc-checktable)
4. [DBCC CHECKALLOC](#dbcc-checkalloc)
5. [DBCC CHECKCATALOG](#dbcc-checkcatalog)
6. [DBCC CHECKFILEGROUP](#dbcc-checkfilegroup)
7. [DBCC FREEPROCCACHE](#dbcc-freeproccache)
8. [DBCC DROPCLEANBUFFERS](#dbcc-dropcleanbuffers)
9. [DBCC SHRINKFILE and SHRINKDATABASE](#dbcc-shrinkfile-and-shrinkdatabase)
10. [DBCC UPDATEUSAGE](#dbcc-updateusage)
11. [DBCC INPUTBUFFER](#dbcc-inputbuffer)
12. [DBCC OPENTRAN](#dbcc-opentran)
13. [DBCC SQLPERF](#dbcc-sqlperf)
14. [DBCC SHOW_STATISTICS](#dbcc-show_statistics)
15. [DBCC SHOWCONTIG (Deprecated)](#dbcc-showcontig-deprecated)
16. [DBCC TRACEON / TRACEOFF / TRACESTATUS](#dbcc-traceon--traceoff--tracestatus)
17. [DBCC PAGE (Undocumented)](#dbcc-page-undocumented)
18. [DBCC IND / DBCC EXTENTINFO (Undocumented)](#dbcc-ind--dbcc-extentinfo-undocumented)
19. [DBCC MEMORYSTATUS](#dbcc-memorystatus)
20. [DBCC USEROPTIONS](#dbcc-useroptions)
21. [DBCC CHECKIDENT](#dbcc-checkident)
22. [DBCC CLONEDATABASE](#dbcc-clonedatabase)
23. [Quick Reference Table](#quick-reference-table)
24. [Gotchas / Anti-Patterns](#gotchas--anti-patterns)
25. [See Also](#see-also)
26. [Sources](#sources)

---

## When to Use

| Scenario | Command |
|----------|---------|
| Database integrity check (scheduled maintenance) | `DBCC CHECKDB` |
| Check a single suspect table | `DBCC CHECKTABLE` |
| Clear plan cache after index changes | `DBCC FREEPROCCACHE` |
| Cold-cache benchmark testing | `DBCC DROPCLEANBUFFERS` |
| Shrink a log file after log backup | `DBCC SHRINKFILE` |
| Row/page count discrepancies in sys.partitions | `DBCC UPDATEUSAGE` |
| See what a session is running | `DBCC INPUTBUFFER` |
| Find oldest open transaction | `DBCC OPENTRAN` |
| Log space usage by database | `DBCC SQLPERF(LOGSPACE)` |
| Inspect statistics histogram | `DBCC SHOW_STATISTICS` |
| Check identity value and reseed | `DBCC CHECKIDENT` |
| Clone schema+stats for testing (no data) | `DBCC CLONEDATABASE` |
| Enable/disable trace flag | `DBCC TRACEON` / `DBCC TRACEOFF` |

---

## DBCC CHECKDB

Checks the logical and physical integrity of all objects in a database. The most important maintenance DBCC command.

### Basic Syntax

```sql
-- Minimal / fastest — checks physical page structure only
DBCC CHECKDB (N'MyDatabase') WITH PHYSICAL_ONLY;

-- Full integrity check (default)
DBCC CHECKDB (N'MyDatabase');

-- Full check with no informational messages
DBCC CHECKDB (N'MyDatabase') WITH NO_INFOMSGS;

-- Full check with extended logical checks
DBCC CHECKDB (N'MyDatabase') WITH EXTENDED_LOGICAL_CHECKS;

-- Estimate how long a check will take (2014+)
DBCC CHECKDB (N'MyDatabase') WITH ESTIMATEONLY;
```

### Repair Options (Last Resort)

```sql
-- Repair without data loss (can only fix minor allocation errors)
DBCC CHECKDB (N'MyDatabase', REPAIR_REBUILD);

-- Repair with possible data loss (removes corrupt pages)
DBCC CHECKDB (N'MyDatabase', REPAIR_ALLOW_DATA_LOSS);
```

> [!WARNING] Repair
> REPAIR_ALLOW_DATA_LOSS **deletes rows** to fix corruption. The database must be in SINGLE_USER mode first. Always try restore from backup before using repair. Document what was lost.

```sql
-- Put in single-user mode before repair
ALTER DATABASE MyDatabase SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
DBCC CHECKDB (N'MyDatabase', REPAIR_ALLOW_DATA_LOSS);
ALTER DATABASE MyDatabase SET MULTI_USER;
```

### PHYSICAL_ONLY vs Full Check Trade-offs

| Aspect | PHYSICAL_ONLY | Full Check |
|--------|---------------|------------|
| Duration | Much faster (often 10–100×) | Slow on large databases |
| CPU/IO overhead | Lower | Higher |
| What it finds | Torn pages, checksum failures, structural corruption | Above + logical consistency (FK, sys table cross-references) |
| Missed problems | Logical corruption (row data inconsistencies) | Nothing — it's comprehensive |
| Recommended frequency | Nightly or weekly | Monthly or on restore verification |
| Extended logical checks | Not applicable | Can add (expensive, checks indexed views/XML) |

**Recommendation:** Run `PHYSICAL_ONLY` frequently (nightly or weekly) on large databases where full checks take too long. Run the full check monthly or after restore. Run full check on backup copy to avoid production I/O.

### Running CHECKDB Against a Backup Copy

The best practice for large databases:

```sql
-- 1. Restore database from backup to secondary server (NORECOVERY optional)
RESTORE DATABASE MyDatabase_Test
  FROM DISK = N'\\backup\MyDatabase_full.bak'
  WITH MOVE 'MyDatabase_Data' TO 'D:\MSSQL\MyDatabase_Test.mdf',
       MOVE 'MyDatabase_Log'  TO 'D:\MSSQL\MyDatabase_Test.ldf',
       RECOVERY, REPLACE;

-- 2. Run full CHECKDB against the restored copy
DBCC CHECKDB (N'MyDatabase_Test') WITH NO_INFOMSGS;

-- 3. Drop the test database
DROP DATABASE MyDatabase_Test;
```

Or use a database snapshot for zero-overhead integrity check:

```sql
-- Create snapshot
CREATE DATABASE MyDatabase_snap ON
  (NAME = MyDatabase_Data,
   FILENAME = 'D:\Snapshots\MyDatabase_snap.ss')
AS SNAPSHOT OF MyDatabase;

-- Run CHECKDB against snapshot (reads from original data pages on demand)
DBCC CHECKDB (N'MyDatabase_snap') WITH NO_INFOMSGS;

-- Drop snapshot
DROP DATABASE MyDatabase_snap;
```

### Output Interpretation

CHECKDB reports errors with error number, severity, state, and description:

```
Msg 8978, Level 16, State 1
Table error: Object ID 123456. Page (1:12345) is missing a reference
from previous page (1:12344). Possible chain linkage problem.
```

- **Level 16**: User errors (most integrity errors) — can survive, check data integrity
- **Level 17+**: Resource errors — serious
- Errors starting with `8906`–`8978` are page/row allocation errors
- Errors starting with `2500`–`2537` are cross-table consistency errors

### Monitoring CHECKDB Progress

```sql
-- Check CHECKDB progress via sys.dm_exec_requests
SELECT
    session_id,
    command,
    percent_complete,
    estimated_completion_time / 1000.0 / 60 AS est_minutes_remaining,
    wait_type,
    wait_time / 1000.0 AS wait_seconds
FROM sys.dm_exec_requests
WHERE command LIKE '%CHECKDB%'
   OR command LIKE '%CHECKTABLE%';
```

### Last Known CHECKDB Time

```sql
-- Find when CHECKDB last ran successfully per database
SELECT
    name,
    DATABASEPROPERTYEX(name, 'LastGoodCheckDbTime') AS LastGoodCheckDbTime
FROM sys.databases
WHERE state_desc = 'ONLINE'
ORDER BY DATABASEPROPERTYEX(name, 'LastGoodCheckDbTime');
```

---

## DBCC CHECKTABLE

Checks integrity of a single table (or indexed view). Faster than CHECKDB when you suspect a specific object.

```sql
-- Check a table
DBCC CHECKTABLE (N'Sales.Orders');

-- Physical only (much faster)
DBCC CHECKTABLE (N'Sales.Orders') WITH PHYSICAL_ONLY;

-- No informational messages
DBCC CHECKTABLE (N'Sales.Orders') WITH NO_INFOMSGS;

-- Check at a specific DBCC_SNAPSHOT point (snapshot isolation)
-- Avoids blocking — reads committed data without SCH-S locks
DBCC CHECKTABLE (N'Sales.Orders') WITH TABLOCK;  -- forces table lock
```

---

## DBCC CHECKALLOC

Checks allocation consistency of all pages in a database (without checking row contents). Faster than CHECKDB but only finds allocation-level corruption.

```sql
DBCC CHECKALLOC (N'MyDatabase') WITH NO_INFOMSGS;
```

Covered by CHECKDB — use standalone when you only want allocation checks quickly.

---

## DBCC CHECKCATALOG

Checks consistency of system catalog tables (verifies cross-references between sys.objects, sys.columns, etc.).

```sql
DBCC CHECKCATALOG (N'MyDatabase') WITH NO_INFOMSGS;
```

Also covered by full CHECKDB.

---

## DBCC CHECKFILEGROUP

Checks integrity of all tables in a specific filegroup. Useful for databases using PIECEMEAL restores where only some filegroups are online.

```sql
-- Check a named filegroup
DBCC CHECKFILEGROUP (N'SECONDARY') WITH NO_INFOMSGS;

-- Check primary filegroup
DBCC CHECKFILEGROUP (1) WITH NO_INFOMSGS;

-- Get filegroup IDs
SELECT data_space_id, name FROM sys.filegroups;
```

---

## DBCC FREEPROCCACHE

Clears compiled execution plans from the plan cache. Forces recompilation of all queries on next execution.

```sql
-- Clear ALL plans from ALL databases (affects entire instance)
DBCC FREEPROCCACHE;

-- Clear plans for a specific plan handle
DECLARE @plan_handle VARBINARY(64);
SELECT @plan_handle = plan_handle
FROM sys.dm_exec_cached_plans
CROSS APPLY sys.dm_exec_sql_text(plan_handle)
WHERE text LIKE '%SearchForThisQuery%';

DBCC FREEPROCCACHE (@plan_handle);

-- Clear plans for a specific SQL handle (removes all plans for a query)
DBCC FREEPROCCACHE (@sql_handle);

-- For a specific database only — use Resource Governor pool approach
-- (no built-in "free cache for one database" command)
```

> [!WARNING] Production Use
> `DBCC FREEPROCCACHE` without arguments clears the **entire instance plan cache**. All queries will experience recompilation overhead simultaneously, which can cause a CPU spike and latency burst. Use the `@plan_handle` form in production to clear only one plan.

### When to Use

- After updating statistics or creating new indexes: SQL Server automatically invalidates stale plans for the affected objects (usually). Manual cache clearing is rarely needed.
- After major schema changes: when you want to force plan recompilation
- Benchmarking: clear cache between runs to ensure fair plan comparison
- Troubleshooting parameter sniffing: force a new plan for a bad-sniffed plan

```sql
-- Find the plan handle for a specific cached query
SELECT
    qs.plan_handle,
    qs.sql_handle,
    qs.execution_count,
    qs.total_worker_time,
    SUBSTRING(qt.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(qt.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS statement_text,
    qp.query_plan
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE qt.text LIKE N'%OrdersByCustomer%'
ORDER BY qs.total_worker_time DESC;
```

---

## DBCC DROPCLEANBUFFERS

Removes all clean (unmodified) data pages from the buffer pool. Forces subsequent queries to read from disk.

```sql
-- Clear the buffer pool (flushes dirty pages first via CHECKPOINT)
CHECKPOINT;          -- flush dirty pages to disk
DBCC DROPCLEANBUFFERS;  -- then remove all clean pages
```

> [!WARNING] Development / Benchmark Use Only
> `DBCC DROPCLEANBUFFERS` is for benchmarking and testing only. Never run in production as a performance fix — it will cause every query to do physical I/O, which could make production performance catastrophically worse until the buffer pool warms up.

### Benchmarking Pattern

```sql
-- Standard benchmark pattern: cold cache test
CHECKPOINT;
DBCC DROPCLEANBUFFERS;
DBCC FREEPROCCACHE;

-- Run your query here
SET STATISTICS IO, TIME ON;
SELECT ... FROM ...;
SET STATISTICS IO, TIME OFF;
```

---

## DBCC SHRINKFILE and SHRINKDATABASE

Reduces the physical size of a data or log file. Almost always a bad idea on data files.

```sql
-- Shrink a specific file (by file name)
DBCC SHRINKFILE (N'MyDatabase_Log', 256);  -- shrink to 256 MB target

-- Shrink a file by file ID
SELECT file_id, name, size/128 AS size_mb FROM sys.database_files;
DBCC SHRINKFILE (2, 512);  -- file_id 2, target 512 MB

-- Truncate only (remove empty space at end of file — less destructive)
DBCC SHRINKFILE (N'MyDatabase_Data', TRUNCATEONLY);

-- Shrink entire database (shrinks all files — almost always wrong)
DBCC SHRINKDATABASE (N'MyDatabase', 10);  -- 10% free space target
```

### Why SHRINKFILE Is (Almost) Always Wrong

| Problem | Explanation |
|---------|-------------|
| Index fragmentation | Shrink moves pages around, fragmenting every index. You'll need to rebuild all indexes after. |
| Immediate regrowth | If you shrink a data file that needs to grow again, auto-growth events add I/O stall overhead repeatedly. |
| Fragmented VLFs | Log file shrink creates many small VLFs (virtual log files), hurting log write performance. |
| Cyclic pattern | Shrink → auto-grow → shrink → auto-grow wastes cycles and fragments the file. |

### When SHRINKFILE Is Legitimate

- **Log file** after a one-time large operation (bulk load, large index rebuild) where the log grew temporarily and will not grow again soon
- **Pre-sized data file** that was accidentally sized too large before any data was loaded
- Recovering space after a large DROP TABLE / TRUNCATE (rare — usually better to let it be)

### Best Practice Instead of Shrink

```sql
-- Set auto-grow to a sensible size to avoid many small growths
ALTER DATABASE MyDatabase
MODIFY FILE (NAME = N'MyDatabase_Data', FILEGROWTH = 512MB);

-- Pre-size files correctly initially
ALTER DATABASE MyDatabase
MODIFY FILE (NAME = N'MyDatabase_Data', SIZE = 20480MB);
```

### Shrinking Log Files Correctly

```sql
-- 1. Verify log is not in use (check VLF status)
DBCC LOGINFO;  -- look for status=2 VLFs (active)

-- 2. Back up the log to free VLFs
BACKUP LOG MyDatabase TO DISK = N'NUL';  -- NUL = discard (dev only)

-- 3. Check log_reuse_wait_desc to understand why log can't shrink
SELECT name, log_reuse_wait_desc FROM sys.databases WHERE name = 'MyDatabase';

-- 4. Shrink (if log_reuse_wait_desc = NOTHING or LOG_BACKUP)
DBCC SHRINKFILE (N'MyDatabase_Log', 256);
```

Log reuse wait reasons that prevent shrink:
- `LOG_BACKUP` — need a log backup first
- `REPLICATION` — replication is not caught up
- `DATABASE_MIRRORING` / `AVAILABILITY_REPLICA` — secondary is behind
- `ACTIVE_TRANSACTION` — long-running open transaction
- `ACTIVE_BACKUP_OR_RESTORE` — backup in progress

---

## DBCC UPDATEUSAGE

Corrects row count and page count inaccuracies in `sys.partitions` and `sys.allocation_units`. Run when `sp_spaceused` or catalog view counts look wrong.

```sql
-- Correct entire database
DBCC UPDATEUSAGE (N'MyDatabase') WITH NO_INFOMSGS;

-- Correct a specific table
DBCC UPDATEUSAGE (N'MyDatabase', N'Sales.Orders') WITH NO_INFOMSGS;

-- Correct a specific index on a table
DBCC UPDATEUSAGE (N'MyDatabase', N'Sales.Orders', 1) WITH NO_INFOMSGS;
-- (third argument is index_id from sys.indexes)
```

Inaccuracies can occur after interrupted bulk operations, direct page manipulation (rare), or certain upgrade scenarios.

---

## DBCC INPUTBUFFER

Returns the last T-SQL statement sent by a session. Useful for identifying what a blocking or long-running session is executing.

```sql
-- See what session 72 is doing
DBCC INPUTBUFFER (72);

-- Modern equivalent (more columns, no DBCC)
SELECT
    r.session_id,
    r.status,
    r.blocking_session_id,
    r.wait_type,
    r.wait_time / 1000.0 AS wait_sec,
    SUBSTRING(t.text, (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text)
          ELSE r.statement_end_offset END - r.statement_start_offset)/2)+1) AS current_statement,
    t.text AS full_batch
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id = 72;
```

Prefer the DMV approach for automated scripts. `DBCC INPUTBUFFER` is useful in interactive sessions without permission to query DMVs.

---

## DBCC OPENTRAN

Finds the oldest active transaction in the current database. Critical for diagnosing log file growth that won't stop.

```sql
-- Check current database
DBCC OPENTRAN;

-- Check a specific database
DBCC OPENTRAN (N'MyDatabase');

-- More detail with DMVs (preferred)
SELECT
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    at.transaction_begin_time,
    DATEDIFF(MINUTE, at.transaction_begin_time, GETDATE()) AS age_minutes,
    at.transaction_type,
    at.transaction_state
FROM sys.dm_tran_active_transactions at
JOIN sys.dm_tran_session_transactions st ON at.transaction_id = st.transaction_id
JOIN sys.dm_exec_sessions s ON st.session_id = s.session_id
ORDER BY at.transaction_begin_time ASC;
```

---

## DBCC SQLPERF

Reports log space usage statistics for all databases.

```sql
-- Log file space usage for all databases
DBCC SQLPERF (LOGSPACE);
-- Returns: Database Name, Log Size (MB), Log Space Used (%), Status

-- Reset wait statistics (use only in baseline capture scenarios)
DBCC SQLPERF ('sys.dm_os_wait_stats', CLEAR);

-- Reset latch statistics
DBCC SQLPERF ('sys.dm_os_latch_stats', CLEAR);
```

> [!WARNING] Clearing Wait Stats in Production
> `DBCC SQLPERF('sys.dm_os_wait_stats', CLEAR)` resets cumulative counters that may be used by monitoring tools or performance baseline scripts. Only clear during controlled benchmarking windows, not during normal production operation.

---

## DBCC SHOW_STATISTICS

Returns statistics header, density vector, and histogram for a specific statistics object. Covered in depth in `28-statistics.md`.

```sql
-- Show all three result sets
DBCC SHOW_STATISTICS ('Sales.Orders', 'IX_Orders_CustomerID');

-- Show specific parts
DBCC SHOW_STATISTICS ('Sales.Orders', 'IX_Orders_CustomerID')
    WITH STAT_HEADER;         -- metadata only

DBCC SHOW_STATISTICS ('Sales.Orders', 'IX_Orders_CustomerID')
    WITH DENSITY_VECTOR;      -- column prefix densities

DBCC SHOW_STATISTICS ('Sales.Orders', 'IX_Orders_CustomerID')
    WITH HISTOGRAM;           -- 200-step selectivity histogram
```

---

## DBCC SHOWCONTIG (Deprecated)

> [!WARNING] Deprecated
> `DBCC SHOWCONTIG` was deprecated in SQL Server 2005 and removed in SQL Server 2012. Use `sys.dm_db_index_physical_stats` instead.

```sql
-- Modern replacement
SELECT
    OBJECT_NAME(ips.object_id) AS table_name,
    i.name AS index_name,
    ips.index_type_desc,
    ips.avg_fragmentation_in_percent,
    ips.page_count,
    ips.avg_page_space_used_in_percent
FROM sys.dm_db_index_physical_stats(
    DB_ID(), NULL, NULL, NULL, 'LIMITED'  -- or 'SAMPLED' / 'DETAILED'
) ips
JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id
WHERE ips.avg_fragmentation_in_percent > 5
  AND ips.page_count > 1000
ORDER BY ips.avg_fragmentation_in_percent DESC;
```

---

## DBCC TRACEON / TRACEOFF / TRACESTATUS

Enable, disable, or check the status of trace flags.

```sql
-- Enable trace flag for current session only
DBCC TRACEON (4199);

-- Enable trace flag globally (all sessions)
DBCC TRACEON (4199, -1);

-- Enable multiple trace flags globally
DBCC TRACEON (1117, 1118, -1);

-- Disable a trace flag globally
DBCC TRACEOFF (4199, -1);

-- Check status of specific trace flags
DBCC TRACESTATUS (4199, 1117, 1118);

-- Check status of all enabled trace flags
DBCC TRACESTATUS (-1);
```

### Common Trace Flags Reference

| Trace Flag | Purpose | Version | Notes |
|------------|---------|---------|-------|
| 1117 | Auto-grow all files in filegroup equally | Pre-2016 | Default in 2016+ via `AUTOGROW_ALL_FILES` |
| 1118 | Allocate full extents instead of mixed extents | Pre-2016 | Default in 2016+ for user DBs |
| 1204 | Deadlock info output to error log (XML format — use XE instead) | All | [!WARNING] Deprecated — use XE deadlock session |
| 1222 | Deadlock info in XML format to error log (use XE instead) | All | [!WARNING] Deprecated |
| 2371 | Dynamic auto-stats update threshold | Pre-2016, compat 110 | Built-in since compat 130 (2016+) |
| 3226 | Suppress successful backup messages in error log | All | Useful on busy log-shipping servers |
| 4136 | Disable parameter sniffing | 2008+ | USE HINT ('DISABLE_PARAMETER_SNIFFING') preferred |
| 4199 | Enable query optimizer fixes | Pre-2016 | Default in compat 140+ |
| 7412 | Lightweight execution statistics profiling | 2016 SP1+ | Low-overhead query execution stats |
| 9481 | Force CE 70 (SQL Server 7.0 CE) | 2014+ | USE HINT ('FORCE_LEGACY_CARDINALITY_ESTIMATION') preferred |
| 9488 | Force legacy stat behavior with CE 70 | 2014+ | |

> [!NOTE] SQL Server 2016+
> Trace flags 1117 and 1118 are now the default behavior for user databases. Setting them explicitly is not needed and has no effect on user databases (still applies to tempdb in some configurations).

> [!NOTE] SQL Server 2016+ (compat 130)
> Trace flag 2371 (dynamic auto-stats threshold) is enabled by default when compat level ≥ 130. Do not enable for databases already at compat 130+.

Persist trace flags across restarts by adding them to the SQL Server startup parameters: `-T4199` in SQL Server Configuration Manager under Startup Parameters.

---

## DBCC PAGE (Undocumented)

Reads and displays the raw contents of a specific data or index page. Useful for low-level corruption diagnosis.

```sql
-- Enable trace flag 3604 to direct output to client (required)
DBCC TRACEON (3604);

-- Read a page: (database_id, file_id, page_id, print_option)
-- print_option: 0=header, 1=header+data, 2=header+data+row offsets, 3=header+each row
DBCC PAGE (MyDatabase, 1, 1234, 3);

-- Turn off after use
DBCC TRACEOFF (3604);
```

> [!WARNING] Undocumented
> `DBCC PAGE` is undocumented and unsupported. Output format can change between versions. Use only for diagnosis, never in production scripts.

---

## DBCC IND / DBCC EXTENTINFO (Undocumented)

```sql
-- DBCC IND: List all pages for an object
-- (database, object_name_or_id, index_id: -1=all)
DBCC TRACEON (3604);
DBCC IND (MyDatabase, 'Sales.Orders', -1);

-- DBCC EXTENTINFO: Extent-level allocation info
DBCC EXTENTINFO (MyDatabase, 'Sales.Orders', -1);
DBCC TRACEOFF (3604);
```

> [!WARNING] Undocumented
> Both commands are undocumented and unsupported. Use `sys.dm_db_database_page_allocations` (SQL Server 2012+) as the documented alternative.

```sql
-- Documented alternative (2012+)
SELECT *
FROM sys.dm_db_database_page_allocations(
    DB_ID('MyDatabase'),
    OBJECT_ID('Sales.Orders'),
    NULL,   -- index_id (NULL = all)
    NULL,   -- partition_id (NULL = all)
    'DETAILED'
);
```

---

## DBCC MEMORYSTATUS

Displays a detailed snapshot of SQL Server memory usage by component.

```sql
DBCC MEMORYSTATUS;
```

Returns multiple result sets covering: overall memory, buffer pool pages, memory clerks, memory nodes, query memory objects, small memory objects, user connections memory, and aggregate memory.

For most diagnostics, `sys.dm_os_memory_clerks` and `sys.dm_os_sys_info` provide the same data in queryable form:

```sql
-- Top memory consumers by clerk
SELECT
    type AS clerk_type,
    SUM(pages_kb) / 1024.0 AS memory_mb
FROM sys.dm_os_memory_clerks
GROUP BY type
ORDER BY memory_mb DESC;
```

---

## DBCC USEROPTIONS

Displays the SET options active for the current connection. Useful for debugging plan cache misses caused by SET option mismatches.

```sql
DBCC USEROPTIONS;
```

Relevant for plan caching: two queries with identical text but different SET options (e.g., `ANSI_NULLS`, `QUOTED_IDENTIFIER`, `ARITHABORT`) get **separate cache entries**. This is a common cause of plan cache bloat.

```sql
-- Verify your connection's SET options match application connections
-- Application connections via ODBC/JDBC typically have ARITHABORT = OFF
-- SSMS has ARITHABORT = ON
-- This means SSMS executes with a different plan than the app
```

---

## DBCC CHECKIDENT

Checks and optionally reseeds the identity value for a table.

```sql
-- Check current identity value (does not change anything)
DBCC CHECKIDENT ('Sales.Orders', NORESEED);

-- Reseed to a specific value
DBCC CHECKIDENT ('Sales.Orders', RESEED, 10000);

-- Let SQL Server correct identity if it's wrong (auto-correct)
-- Sets seed to max(identity_col) in the table
DBCC CHECKIDENT ('Sales.Orders', RESEED);
```

### When Identity Gets Out of Sync

After `DELETE` + `INSERT` with explicit identity values (`SET IDENTITY_INSERT ON`), or after a restore, the identity seed may be behind the actual max value. This causes duplicate key errors on the next insert.

```sql
-- Detect: current seed < max existing value
SELECT IDENT_CURRENT('Sales.Orders') AS current_seed,
       MAX(OrderID) AS max_existing
FROM Sales.Orders;

-- Fix:
DBCC CHECKIDENT ('Sales.Orders', RESEED);
```

---

## DBCC CLONEDATABASE

Creates a schema-only + statistics copy of a database. Used to reproduce query optimizer behavior in a safe environment without copying data.

```sql
-- Create a clone (SQL Server 2014 SP2+)
DBCC CLONEDATABASE (N'MyDatabase', N'MyDatabase_Clone');

-- The clone contains:
--   - All schema objects (tables, indexes, views, procs, functions)
--   - All statistics (histograms, density vectors)
--   - No data rows
--   - No logins mapped (orphaned users)
```

> [!NOTE] SQL Server 2014 SP2+
> `DBCC CLONEDATABASE` was introduced in SQL Server 2014 SP2. [^4]

### Common Use Cases

1. **Send to Microsoft Support**: share optimizer behavior without data (PII-free)
2. **Test query plan behavior**: reproduce production plans in dev without copying data
3. **Benchmark statistics impact**: test statistics update strategies

The clone database is created with `READ_ONLY` and `RESTRICTED_USER` access by default. To use it:

```sql
ALTER DATABASE MyDatabase_Clone SET READ_WRITE WITH NO_WAIT;
ALTER DATABASE MyDatabase_Clone SET MULTI_USER WITH NO_WAIT;
```

---

## Quick Reference Table

| Command | Requires sysadmin | Production safe | Output to client | Notes |
|---------|------------------|-----------------|------------------|-------|
| `CHECKDB` | Yes (or db_owner) | Yes (read-heavy) | Yes | Schedule during off-hours for large DBs |
| `CHECKTABLE` | Yes | Yes | Yes | Faster than CHECKDB |
| `CHECKALLOC` | Yes | Yes | Yes | Subset of CHECKDB |
| `CHECKCATALOG` | Yes | Yes | Yes | Subset of CHECKDB |
| `FREEPROCCACHE` | Yes | Use @plan_handle | No | Avoid global clear in production |
| `DROPCLEANBUFFERS` | Yes | **No** | No | Dev/benchmark only |
| `SHRINKFILE` | Yes (db_owner) | Rarely | No | Causes fragmentation; last resort |
| `UPDATEUSAGE` | Yes | Yes | No | Fix sys.partitions inaccuracies |
| `INPUTBUFFER` | No (any login) | Yes | Yes | Requires `VIEW SERVER STATE` |
| `OPENTRAN` | No | Yes | Yes | Diagnose log growth |
| `SQLPERF(LOGSPACE)` | No | Yes | Yes | Log space usage |
| `SQLPERF(CLEAR)` | Yes | Caution | No | Resets wait stats counters |
| `SHOW_STATISTICS` | No | Yes | Yes | |
| `CHECKIDENT` | Yes (db_owner) | Yes | No | Fix identity seed after restore |
| `CLONEDATABASE` | Yes | Yes | No | Schema+stats clone, no data |
| `TRACEON/TRACEOFF` | Yes | Caution | No | Affects entire instance with `-1` |
| `MEMORYSTATUS` | Yes | Yes | Yes | Use DMVs for automation |
| `USEROPTIONS` | No | Yes | Yes | Debug plan cache SET mismatches |
| `PAGE` | Yes | Yes (read only) | Yes (needs TF 3604) | Undocumented |

---

## Gotchas / Anti-Patterns

1. **Running CHECKDB on production during peak hours.** CHECKDB is I/O intensive. Run against a database snapshot or a restored copy, or schedule during off-peak windows with `PHYSICAL_ONLY` during the week and full check on weekends.

2. **Using `DBCC FREEPROCCACHE` without a plan handle.** Clears the entire plan cache for the whole instance. Every query recompiles simultaneously, causing a CPU spike. Use `DBCC FREEPROCCACHE (@plan_handle)` to target only the problematic plan.

3. **Shrinking data files regularly.** SHRINKFILE causes severe index fragmentation. After shrinking, you must rebuild all indexes, which often ends up taking longer than the space saved. Instead, pre-size files correctly.

4. **Shrinking the log file without a log backup first.** The log cannot be shrunk past the oldest active VLF. Always check `log_reuse_wait_desc` in `sys.databases` and take a log backup before attempting SHRINKFILE on the log.

5. **Running `DBCC CHECKDB` with `REPAIR_ALLOW_DATA_LOSS` as a first response to corruption.** This deletes rows. Always restore from backup if possible. Use repair only as a last resort when no backup exists.

6. **Not checking `DATABASEPROPERTYEX(name, 'LastGoodCheckDbTime')`** for all databases. Many environments let months pass without a successful CHECKDB, only discovering corruption when a restore is needed.

7. **Assuming `DBCC DROPCLEANBUFFERS` simulates real cold cache accurately.** It removes clean pages but not all buffer pool state. Read-ahead buffers and other caches may still warm subsequent queries.

8. **Using trace flags 1117/1118 on SQL Server 2016+.** These are default for user databases. Explicitly enabling them has no effect on user databases but adds startup parameter noise. Check version before adding.

9. **`DBCC LOGINFO` VLF count.** After many log shrink/grow cycles, log files can accumulate thousands of tiny VLFs, degrading log write performance. Use `DBCC LOGINFO` to check VLF count; if > 1000, back up the log, shrink it once, and pre-grow it to the correct size.

```sql
-- Count VLFs per database
CREATE TABLE #vlfinfo (
    RecoveryUnitID INT, FileID INT, FileSize BIGINT,
    StartOffset BIGINT, FSeqNo BIGINT, [Status] INT,
    Parity INT, CreateLSN NUMERIC(25,0)
);
INSERT #vlfinfo EXEC ('DBCC LOGINFO WITH NO_INFOMSGS');
SELECT COUNT(*) AS vlf_count FROM #vlfinfo;
DROP TABLE #vlfinfo;
```

10. **Running `DBCC SQLPERF('sys.dm_os_wait_stats', CLEAR)` while monitoring is active.** This resets the counters that monitoring tools use for delta calculations, producing incorrect wait stats for the monitoring period.

11. **Relying on `DBCC INPUTBUFFER` for automated blocking detection.** It requires elevated permissions and returns the last input buffer, not necessarily the current statement. Use `sys.dm_exec_requests` with `sys.dm_exec_sql_text` for automation.

12. **`DBCC CLONEDATABASE` not copying data.** If you restore the clone to a developer machine expecting data for testing, it will be empty. It's only useful for optimizer/statistics investigations.

---

## See Also

- [`28-statistics.md`](28-statistics.md) — DBCC SHOW_STATISTICS detail
- [`29-query-plans.md`](29-query-plans.md) — FREEPROCCACHE in plan cache analysis
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — DROPCLEANBUFFERS in benchmarking, SQLPERF wait stats
- [`34-tempdb.md`](34-tempdb.md) — SHRINKFILE on tempdb
- [`44-backup-restore.md`](44-backup-restore.md) — CHECKDB against backup, database snapshots for CHECKDB
- [`49-configuration-tuning.md`](49-configuration-tuning.md) — trace flags reference

---

## Sources

[^1]: [DBCC CHECKDB (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-checkdb-transact-sql) — official reference for DBCC CHECKDB syntax, options, repair modes, and behavior
[^2]: [DBCC SHRINKFILE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-shrinkfile-transact-sql) — official reference for DBCC SHRINKFILE syntax, arguments, and best practices
[^3]: [DBCC FREEPROCCACHE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-freeproccache-transact-sql) — official reference for DBCC FREEPROCCACHE including plan handle and resource pool scope
[^4]: [DBCC CLONEDATABASE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-clonedatabase-transact-sql) — official reference documenting DBCC CLONEDATABASE, introduced in SQL Server 2014 SP2, for schema-only database cloning
[^5]: [Trace Flags (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-traceon-trace-flags-transact-sql) — comprehensive trace flag reference including DBCC TRACEON, TRACEOFF, and TRACESTATUS
[^6]: [CHECKDB From Every Angle: Consistency Checking Options for a VLDB - Paul S. Randal](https://www.sqlskills.com/blogs/paul/checkdb-from-every-angle-consistency-checking-options-for-a-vldb/) — Paul Randal (SQLskills) on CHECKDB internals, running against backup copies, and consistency checking strategies for large databases
[^7]: [Stop Shrinking Your Database Files. Seriously. Now. - Brent Ozar Unlimited®](https://www.brentozar.com/archive/2009/08/stop-shrinking-your-database-files-seriously-now/) — Brent Ozar on why shrinking data files causes fragmentation and should be avoided
[^8]: [SQL Server 2012: sys.dm_db_database_page_allocations | Microsoft Learn](https://learn.microsoft.com/en-us/archive/technet-wiki/13110.sql-server-2012-sys-dm-db-database-page-allocations) — overview of sys.dm_db_database_page_allocations, the documented alternative to DBCC IND for page allocation inspection
[^9]: [DBCC UPDATEUSAGE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-updateusage-transact-sql) — official reference for DBCC UPDATEUSAGE, correcting row and page count inaccuracies in catalog views
[^10]: [DBCC CHECKIDENT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-checkident-transact-sql) — official reference for DBCC CHECKIDENT, checking and reseeding identity column values

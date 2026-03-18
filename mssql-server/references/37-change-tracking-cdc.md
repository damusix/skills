# 37 — Change Tracking and Change Data Capture

## Table of Contents
1. [When to Use](#when-to-use)
2. [CT vs CDC Comparison Table](#ct-vs-cdc-comparison-table)
3. [Change Tracking (CT)](#change-tracking-ct)
   - [Setup](#ct-setup)
   - [Consumer Query Pattern](#ct-consumer-query-pattern)
   - [CHANGETABLE Functions](#changetable-functions)
   - [Retention and Cleanup](#ct-retention-and-cleanup)
4. [Change Data Capture (CDC)](#change-data-capture-cdc)
   - [Setup](#cdc-setup)
   - [Capture Instances](#capture-instances)
   - [Consumer Query Patterns](#cdc-consumer-query-patterns)
   - [LSN-Based Navigation](#lsn-based-navigation)
   - [CDC Agent Jobs](#cdc-agent-jobs)
   - [CDC Cleanup](#cdc-cleanup)
5. [ETL Use Cases](#etl-use-cases)
6. [CDC Capture Instance Management](#cdc-capture-instance-management)
7. [CT and CDC Together](#ct-and-cdc-together)
8. [Monitoring](#monitoring)
9. [Azure SQL Differences](#azure-sql-differences)
10. [Always On Considerations](#always-on-considerations)
11. [Metadata Queries](#metadata-queries)
12. [Gotchas](#gotchas)
13. [See Also](#see-also)
14. [Sources](#sources)

---

## When to Use

| Use Case | Recommended Mechanism |
|---|---|
| Incremental ETL — you need to know *what* changed, not *how* | **Change Tracking (CT)** |
| Incremental ETL — you need the *before and after* values | **CDC** |
| Sync two tables / detect deletes for downstream | **CT** |
| Audit log with column-level before/after values | **CDC** |
| High-frequency polling with low overhead | **CT** |
| Replaying a stream of changes in order | **CDC** |
| Temporal table time-travel queries | Neither (use temporal tables — `references/17-temporal-tables.md`) |
| Full audit with who/when | SQL Server Audit (`references/38-auditing.md`) |

**Rule of thumb:** Use CT when you only need to detect that a row changed. Use CDC when you need to know what the row looked like before and after every change. CDC has significantly higher overhead.

---

## CT vs CDC Comparison Table

| Dimension | Change Tracking (CT) | Change Data Capture (CDC) |
|---|---|---|
| **Introduced** | SQL Server 2008 | SQL Server 2008 |
| **What it stores** | Primary keys + operation type (I/U/D) | Full before/after row images per change |
| **Granularity** | Row level only | Row level; column-level mask available |
| **Ordering** | By `SYN_VERSION` (monotonic per DB) | By LSN (log sequence number) |
| **Multiple changes to same row** | Collapsed into one net change | All changes preserved individually |
| **Storage location** | Internal change tables in `sys` schema | `cdc` schema tables in user database |
| **Overhead** | Low — small internal tables | Medium-High — full row images in log |
| **Before values** | Not available | Available via `__$operation = 3` (before update) |
| **Retention** | Configurable in days | Configurable in days per capture instance |
| **Consumer model** | Pull via `CHANGETABLE()` with anchor version | Pull via `cdc.fn_cdc_get_all_changes_*` or `net_changes` |
| **Schema change handling** | Manual — re-enable after column add/drop | Capture instance tied to snapshot; add new capture instance |
| **Requires SQL Agent** | No | Yes (capture + cleanup jobs) |
| **Works on In-Memory OLTP** | No | No |
| **Works with Always On** | Yes (secondary readable) | Yes (with proper log reader setup) |
| **Azure SQL Database** | Yes | Yes (no Agent — background process) |
| **Works with TDE** | Yes | Yes |
| **Works with row compression** | Yes | Yes |

---

## Change Tracking (CT)

### CT Setup

#### Step 1: Enable on the database

```sql
-- Enable CT at the database level
-- RETENTION: minimum days to keep change information
-- AUTO_CLEANUP: whether SQL Server automatically removes old changes
ALTER DATABASE AdventureWorks2022
SET CHANGE_TRACKING = ON
(
    CHANGE_RETENTION = 3 DAYS,   -- keep at least 3 days of changes
    AUTO_CLEANUP = ON             -- default ON; set OFF only if you manage cleanup manually
);
```

#### Step 2: Enable on each table

```sql
-- Enable CT on a table
-- TRACK_COLUMNS_UPDATED: records which columns changed (adds overhead; default OFF)
ALTER TABLE Sales.SalesOrderHeader
ENABLE CHANGE_TRACKING
WITH (TRACK_COLUMNS_UPDATED = ON);

-- Verify
SELECT name, is_track_columns_updated_on
FROM sys.change_tracking_tables;
```

#### Step 3: Get the initial anchor version

```sql
-- Get current version — use this as your initial sync baseline
-- Store this in your ETL metadata table
DECLARE @last_sync_version BIGINT = CHANGE_TRACKING_CURRENT_VERSION();
SELECT @last_sync_version;
-- Returns: e.g., 0 on a fresh database (after first change it increments)
```

#### Disabling CT

```sql
-- Disable on table first, then database
ALTER TABLE Sales.SalesOrderHeader DISABLE CHANGE_TRACKING;
ALTER DATABASE AdventureWorks2022 SET CHANGE_TRACKING = OFF;
```

### CT Consumer Query Pattern

This is the canonical incremental ETL pattern:

```sql
-- Step 1: Get the current version (snapshot it at start of ETL window)
DECLARE @sync_version BIGINT = CHANGE_TRACKING_CURRENT_VERSION();

-- Step 2: Query changes since last sync
-- @last_sync_version is loaded from your ETL metadata store
DECLARE @last_sync_version BIGINT = 12345; -- stored from prior run

SELECT
    ct.SalesOrderID,
    ct.SYS_CHANGE_OPERATION,   -- 'I' = Insert, 'U' = Update, 'D' = Delete
    ct.SYS_CHANGE_VERSION,
    ct.SYS_CHANGE_COLUMNS,     -- NULL unless TRACK_COLUMNS_UPDATED = ON
    ct.SYS_CHANGE_CONTEXT,
    soh.OrderDate,
    soh.TotalDue
    -- NOTE: for 'D' rows, soh.* columns will be NULL (row is gone)
FROM
    CHANGETABLE(CHANGES Sales.SalesOrderHeader, @last_sync_version) AS ct
    LEFT JOIN Sales.SalesOrderHeader AS soh
        ON ct.SalesOrderID = soh.SalesOrderID
ORDER BY ct.SYS_CHANGE_VERSION;

-- Step 3: After ETL completes successfully, save @sync_version to metadata store
-- IMPORTANT: save the version you captured at START, not after the query runs
```

**Key points:**
- Always LEFT JOIN — deleted rows won't exist in the source table
- `SYS_CHANGE_OPERATION`: `I` (insert), `U` (update), `D` (delete)
- Save `@sync_version` (captured before processing), not `CHANGE_TRACKING_CURRENT_VERSION()` after
- If ETL fails mid-run, re-use `@last_sync_version` (idempotent by design)

### CHANGETABLE Functions

```sql
-- CHANGETABLE(CHANGES ...) — all changes since a version
SELECT * FROM CHANGETABLE(CHANGES Sales.SalesOrderHeader, @last_version) AS ct;

-- CHANGETABLE(VERSION ...) — get the version for specific primary keys
-- Useful for single-row freshness checks
SELECT ct.*
FROM (VALUES (1001), (1002)) AS keys(SalesOrderID)
CROSS APPLY CHANGETABLE(VERSION Sales.SalesOrderHeader,
    (SalesOrderID), (keys.SalesOrderID)) AS ct;

-- Check if a row was changed since a specific version
SELECT
    SalesOrderID,
    SYS_CHANGE_VERSION,
    CASE WHEN SYS_CHANGE_VERSION > @checkpoint THEN 'Changed' ELSE 'Current' END AS status
FROM CHANGETABLE(VERSION Sales.SalesOrderHeader, (SalesOrderID), (43001)) AS ct;

-- CHANGE_TRACKING_IS_COLUMN_IN_MASK — check if specific column changed
-- Only works if TRACK_COLUMNS_UPDATED = ON
DECLARE @col_ordinal INT = COLUMNPROPERTY(
    OBJECT_ID('Sales.SalesOrderHeader'), 'TotalDue', 'ColumnId');

SELECT
    ct.SalesOrderID,
    CHANGE_TRACKING_IS_COLUMN_IN_MASK(@col_ordinal, ct.SYS_CHANGE_COLUMNS) AS total_due_changed
FROM CHANGETABLE(CHANGES Sales.SalesOrderHeader, @last_sync_version) AS ct
WHERE ct.SYS_CHANGE_OPERATION = 'U';
```

### CT Retention and Cleanup

```sql
-- Check current retention
SELECT retention_period, retention_period_units_desc, auto_cleanup
FROM sys.change_tracking_databases;

-- Check minimum valid version (older versions are gone)
SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('Sales.SalesOrderHeader'));
-- If @last_sync_version < this value, you must do a full resync

-- ETL guard: validate anchor before using it
DECLARE @min_valid BIGINT =
    CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('Sales.SalesOrderHeader'));
IF @last_sync_version < @min_valid
BEGIN
    RAISERROR('CT version expired. Full resync required.', 16, 1);
    RETURN;
END;

-- Change retention at any time
ALTER DATABASE AdventureWorks2022
SET CHANGE_TRACKING (CHANGE_RETENTION = 7 DAYS);
```

> [!WARNING] Retention Expiry
> If your ETL is delayed longer than `CHANGE_RETENTION`, the minimum valid version advances past your anchor and `CHANGETABLE()` will raise an error. Always validate with `CHANGE_TRACKING_MIN_VALID_VERSION()` before consuming changes and have a full-resync fallback path.

---

## Change Data Capture (CDC)

### CDC Setup

#### Prerequisites
- SQL Server Agent must be running (captures changes via log reader)
- Database recovery model must be FULL or BULK_LOGGED (simple recovery = CDC cannot run)
- Requires db_owner or sysadmin for setup

#### Step 1: Enable CDC on the database

```sql
USE AdventureWorks2022;
GO
EXEC sys.sp_cdc_enable_db;

-- Verify
SELECT name, is_cdc_enabled FROM sys.databases WHERE name = 'AdventureWorks2022';
```

#### Step 2: Enable CDC on a table (creates a capture instance)

```sql
EXEC sys.sp_cdc_enable_table
    @source_schema    = N'Sales',
    @source_name      = N'SalesOrderHeader',
    @role_name        = N'cdc_reader',       -- gating role; NULL = no role gating
    @capture_instance = N'Sales_SalesOrderHeader',  -- optional; auto-named if omitted
    @supports_net_changes = 1,               -- enable net-change function
    @captured_column_list = NULL;            -- NULL = all columns; or comma-separated list

-- Verify capture instance
SELECT * FROM cdc.change_tables;
```

After enabling, CDC creates:
- A change table: `cdc.Sales_SalesOrderHeader_CT`
- A function for all changes: `cdc.fn_cdc_get_all_changes_Sales_SalesOrderHeader()`
- A function for net changes (if enabled): `cdc.fn_cdc_get_net_changes_Sales_SalesOrderHeader()`

#### Disable CDC

```sql
-- Disable on table
EXEC sys.sp_cdc_disable_table
    @source_schema    = N'Sales',
    @source_name      = N'SalesOrderHeader',
    @capture_instance = N'Sales_SalesOrderHeader';

-- Disable on database (removes all capture instances and cdc schema objects)
EXEC sys.sp_cdc_disable_db;
```

### Capture Instances

Each enabled table can have **up to 2 capture instances** at the same time. This is used for schema migrations (see [CDC Capture Instance Management](#cdc-capture-instance-management)).

```sql
-- List all capture instances
SELECT
    capture_instance,
    source_schema,
    source_table,
    start_lsn,
    supports_net_changes,
    captured_column_list
FROM cdc.change_tables;

-- List columns captured in a specific instance
SELECT column_name, column_ordinal, is_computed
FROM cdc.captured_columns
WHERE object_id = OBJECT_ID('cdc.Sales_SalesOrderHeader_CT');
```

### CDC Consumer Query Patterns

CDC functions require LSN (Log Sequence Number) boundaries, not timestamps or versions.

```sql
-- Step 1: Get LSN boundaries
DECLARE @from_lsn BINARY(10) = sys.fn_cdc_get_min_lsn('Sales_SalesOrderHeader');
DECLARE @to_lsn   BINARY(10) = sys.fn_cdc_get_max_lsn();

-- Or, if resuming from a checkpoint:
-- Convert your stored LSN (or use a timestamp-to-LSN helper)
DECLARE @checkpoint_lsn BINARY(10) = 0x000000290000010C0004; -- stored from prior run

-- Step 2a: Get all changes (including intermediate states for updated rows)
SELECT
    __$start_lsn,        -- LSN where the change was captured
    __$end_lsn,          -- always NULL (reserved)
    __$seqval,           -- sequence within a transaction
    __$operation,        -- 1=Delete, 2=Insert, 3=Before Update, 4=After Update
    __$update_mask,      -- bit mask of which columns changed (for updates)
    SalesOrderID,
    OrderDate,
    TotalDue
FROM cdc.fn_cdc_get_all_changes_Sales_SalesOrderHeader(
    @from_lsn,
    @to_lsn,
    N'all'               -- 'all' or 'all update old' (includes before-update rows)
)
ORDER BY __$start_lsn, __$seqval;

-- __$operation values:
-- 1 = DELETE (before image)
-- 2 = INSERT (after image)
-- 3 = UPDATE before image (only with 'all update old')
-- 4 = UPDATE after image

-- Step 2b: Net changes — only the final state of each row after all changes
-- Requires @supports_net_changes = 1 during sp_cdc_enable_table
SELECT
    __$start_lsn,
    __$operation,        -- 1=Delete, 2=Insert, 4=Update (net operation)
    __$update_mask,
    SalesOrderID,
    OrderDate,
    TotalDue
FROM cdc.fn_cdc_get_net_changes_Sales_SalesOrderHeader(
    @from_lsn,
    @to_lsn,
    N'all'
)
ORDER BY __$start_lsn;
```

### LSN-Based Navigation

```sql
-- Convert LSN boundaries from timestamps
-- Useful when you checkpoint by time not LSN
DECLARE @from_lsn BINARY(10) = sys.fn_cdc_map_time_to_lsn(
    'smallest greater than or equal',
    '2026-03-17 00:00:00');
DECLARE @to_lsn BINARY(10) = sys.fn_cdc_map_time_to_lsn(
    'largest less than or equal',
    '2026-03-17 23:59:59');

-- Convert LSN back to time (for display/debugging)
SELECT sys.fn_cdc_map_lsn_to_time(@from_lsn) AS change_time;

-- Increment LSN by 1 (move past a captured LSN for next window start)
-- Avoids re-processing the last-seen LSN
DECLARE @next_from_lsn BINARY(10) = sys.fn_cdc_increment_lsn(@to_lsn);

-- Check if a LSN is within the valid CDC range
DECLARE @min_lsn BINARY(10) = sys.fn_cdc_get_min_lsn('Sales_SalesOrderHeader');
IF @from_lsn < @min_lsn
BEGIN
    RAISERROR('CDC LSN window expired. Full resync required.', 16, 1);
    RETURN;
END;
```

### CDC Agent Jobs

CDC relies on two SQL Server Agent jobs per database:

| Job | Name Pattern | Purpose |
|---|---|---|
| **Capture** | `cdc.AdventureWorks2022_capture` | Reads transaction log, writes to CDC change tables |
| **Cleanup** | `cdc.AdventureWorks2022_cleanup` | Removes CDC rows older than retention period |

```sql
-- Check job status
SELECT
    j.name,
    j.enabled,
    jh.run_date, jh.run_time, jh.run_duration,
    jh.message
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobhistory jh ON j.job_id = jh.job_id
WHERE j.name LIKE 'cdc.%'
ORDER BY jh.run_date DESC, jh.run_time DESC;

-- Check if capture job is running
SELECT
    j.name,
    ja.start_execution_date,
    ja.last_executed_step_date
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobactivity ja ON j.job_id = ja.job_id
WHERE j.name LIKE 'cdc.%_capture'
  AND ja.start_execution_date IS NOT NULL
  AND ja.stop_execution_date IS NULL;

-- Manually start capture (useful for dev/test)
EXEC sys.sp_cdc_start_job @job_type = N'capture';
EXEC sys.sp_cdc_stop_job  @job_type = N'capture';

-- Configure capture job polling interval and max duration
EXEC sys.sp_cdc_change_job
    @job_type = N'capture',
    @pollinginterval = 5,    -- seconds between log scan iterations (default: 5)
    @maxtrans = 500,          -- max transactions per scan cycle
    @maxscans = 10;           -- max scan cycles per capture session
```

### CDC Cleanup

```sql
-- Default retention is 3 days
-- Check current cleanup configuration
EXEC sys.sp_cdc_help_jobs;

-- Change retention period for cleanup job
EXEC sys.sp_cdc_change_job
    @job_type = N'cleanup',
    @retention = 10080;      -- minutes; 10080 = 7 days (default is 4320 = 3 days)

-- Manual cleanup (useful for testing or immediate space reclamation)
EXEC sys.sp_cdc_cleanup_change_table
    @capture_instance = N'Sales_SalesOrderHeader',
    @low_water_mark    = 0x00,  -- NULL or 0x00 to use configured retention
    @threshold         = 5000;  -- max rows to delete per call (default: 5000)
```

---

## ETL Use Cases

### Incremental Load with CT (recommended for most ETL)

```sql
-- Metadata table pattern
CREATE TABLE etl.CTCheckpoints (
    table_name       NVARCHAR(261) PRIMARY KEY,
    last_sync_version BIGINT       NOT NULL,
    last_sync_time   DATETIME2    NOT NULL
);

-- ETL procedure
CREATE OR ALTER PROCEDURE etl.usp_IncrementalLoad_SalesOrderHeader
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @last_sync_version BIGINT;
    DECLARE @current_version   BIGINT = CHANGE_TRACKING_CURRENT_VERSION();
    DECLARE @min_valid_version BIGINT =
        CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('Sales.SalesOrderHeader'));

    -- Load last checkpoint
    SELECT @last_sync_version = last_sync_version
    FROM etl.CTCheckpoints
    WHERE table_name = 'Sales.SalesOrderHeader';

    -- First run: do full load
    IF @last_sync_version IS NULL
    BEGIN
        INSERT INTO warehouse.SalesOrderHeader
        SELECT * FROM Sales.SalesOrderHeader;

        INSERT INTO etl.CTCheckpoints VALUES
            ('Sales.SalesOrderHeader', @current_version, SYSDATETIME());
        RETURN;
    END;

    -- Guard: version expired
    IF @last_sync_version < @min_valid_version
        RAISERROR('CT version expired. Full resync required for Sales.SalesOrderHeader.', 16, 1);

    BEGIN TRANSACTION;

    -- Process deletes
    DELETE w
    FROM warehouse.SalesOrderHeader w
    WHERE EXISTS (
        SELECT 1 FROM CHANGETABLE(CHANGES Sales.SalesOrderHeader, @last_sync_version) ct
        WHERE ct.SalesOrderID = w.SalesOrderID
          AND ct.SYS_CHANGE_OPERATION = 'D'
    );

    -- Process inserts and updates (upsert)
    MERGE warehouse.SalesOrderHeader AS tgt
    USING (
        SELECT soh.*
        FROM CHANGETABLE(CHANGES Sales.SalesOrderHeader, @last_sync_version) ct
        JOIN Sales.SalesOrderHeader soh ON ct.SalesOrderID = soh.SalesOrderID
        WHERE ct.SYS_CHANGE_OPERATION IN ('I', 'U')
    ) AS src ON tgt.SalesOrderID = src.SalesOrderID
    WHEN MATCHED THEN UPDATE SET
        tgt.OrderDate = src.OrderDate,
        tgt.TotalDue  = src.TotalDue
    WHEN NOT MATCHED THEN INSERT VALUES (src.SalesOrderID, src.OrderDate, src.TotalDue);

    -- Save checkpoint
    UPDATE etl.CTCheckpoints
    SET last_sync_version = @current_version,
        last_sync_time    = SYSDATETIME()
    WHERE table_name = 'Sales.SalesOrderHeader';

    COMMIT;
END;
```

### CDC-Based Audit Trail

```sql
-- Build a human-readable change log from CDC
CREATE OR ALTER PROCEDURE audit.usp_GetChangeHistory
    @table_name      NVARCHAR(261),
    @from_time       DATETIME2,
    @to_time         DATETIME2
AS
BEGIN
    DECLARE @capture_instance NVARCHAR(255) =
        REPLACE(@table_name, '.', '_');
    DECLARE @from_lsn BINARY(10) =
        sys.fn_cdc_map_time_to_lsn('smallest greater than or equal', @from_time);
    DECLARE @to_lsn BINARY(10) =
        sys.fn_cdc_map_time_to_lsn('largest less than or equal', @to_time);

    -- Dynamic: use cdc.fn_cdc_get_all_changes_* for the specific instance
    -- This example is hardcoded to one table for clarity
    SELECT
        sys.fn_cdc_map_lsn_to_time(c.__$start_lsn) AS change_time,
        CASE c.__$operation
            WHEN 1 THEN 'DELETE'
            WHEN 2 THEN 'INSERT'
            WHEN 3 THEN 'UPDATE (before)'
            WHEN 4 THEN 'UPDATE (after)'
        END AS operation,
        c.SalesOrderID,
        c.OrderDate,
        c.TotalDue
    FROM cdc.fn_cdc_get_all_changes_Sales_SalesOrderHeader(
        @from_lsn, @to_lsn, 'all update old')  AS c
    ORDER BY c.__$start_lsn, c.__$seqval, c.__$operation;
END;
```

---

## CDC Capture Instance Management

CDC ties a capture instance to the table's schema at enable time. When you add or drop columns, you must manage capture instances manually — there is no automatic schema sync.

```sql
-- Scenario: adding a new column to a CDC-enabled table

-- Step 1: Add column to source table
ALTER TABLE Sales.SalesOrderHeader ADD ShipDate DATE NULL;

-- Step 2: Create a NEW capture instance that includes the new column
EXEC sys.sp_cdc_enable_table
    @source_schema    = N'Sales',
    @source_name      = N'SalesOrderHeader',
    @role_name        = N'cdc_reader',
    @capture_instance = N'Sales_SalesOrderHeader_v2',  -- new name
    @supports_net_changes = 1;

-- Now BOTH instances exist and are capturing changes in parallel
-- Old instance: does NOT include ShipDate
-- New instance: includes ShipDate

-- Step 3: Consumers migrate to the new instance's functions
-- Old functions still work until you drop the old instance

-- Step 4: Once all consumers have migrated, drop the old instance
EXEC sys.sp_cdc_disable_table
    @source_schema    = N'Sales',
    @source_name      = N'SalesOrderHeader',
    @capture_instance = N'Sales_SalesOrderHeader';  -- old instance

-- Note: 2-instance limit means you cannot have more than 2 active at once
```

> [!NOTE]
> The 2-capture-instance limit means you have exactly one "slot" for migration. If you need to do a second migration before consumers have migrated off instance v1, you will block until you drop one.

---

## CT and CDC Together

Some teams run both on the same table — CT for fast ETL (low overhead, net changes) and CDC for the audit trail (full history). This is supported; they are independent mechanisms and don't interfere.

```sql
-- Enable both on the same table
ALTER TABLE Sales.SalesOrderHeader ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);
EXEC sys.sp_cdc_enable_table
    @source_schema = N'Sales', @source_name = N'SalesOrderHeader',
    @role_name = NULL, @supports_net_changes = 1;
```

Overhead is additive — CT adds lightweight row tracking; CDC adds log reading and full row image storage.

---

## Monitoring

### Change Tracking Monitoring

```sql
-- Check CT database configuration
SELECT
    db_name(database_id) AS database_name,
    is_auto_cleanup_on,
    retention_period,
    retention_period_units_desc
FROM sys.change_tracking_databases;

-- Check CT-enabled tables
SELECT
    OBJECT_SCHEMA_NAME(object_id) + '.' + OBJECT_NAME(object_id) AS table_name,
    is_track_columns_updated_on,
    min_valid_version,
    begin_version,
    cleanup_version
FROM sys.change_tracking_tables;

-- Check if any anchor is dangerously close to expiring
SELECT
    OBJECT_SCHEMA_NAME(object_id) + '.' + OBJECT_NAME(object_id) AS table_name,
    min_valid_version,
    CHANGE_TRACKING_CURRENT_VERSION() - min_valid_version AS version_window
FROM sys.change_tracking_tables;
```

### CDC Monitoring

```sql
-- Check CDC lag (how far behind the capture job is)
SELECT
    ct.source_schema + '.' + ct.source_table AS table_name,
    ct.capture_instance,
    sys.fn_cdc_map_lsn_to_time(ct.start_lsn) AS capture_started_at,
    sys.fn_cdc_map_lsn_to_time(sys.fn_cdc_get_max_lsn()) AS current_max_lsn_time,
    DATEDIFF(MINUTE,
        sys.fn_cdc_map_lsn_to_time(ct.start_lsn),
        sys.fn_cdc_map_lsn_to_time(sys.fn_cdc_get_max_lsn())
    ) AS lag_minutes
FROM cdc.change_tables ct;

-- CDC change table row counts (space usage)
SELECT
    ct.capture_instance,
    ct.source_schema + '.' + ct.source_table AS source_table,
    p.rows AS row_count,
    SUM(a.total_pages) * 8 / 1024 AS total_size_mb
FROM cdc.change_tables ct
JOIN sys.tables t ON t.name = ct.capture_instance + '_CT'
    AND SCHEMA_NAME(t.schema_id) = 'cdc'
JOIN sys.partitions p ON p.object_id = t.object_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
GROUP BY ct.capture_instance, ct.source_schema, ct.source_table, p.rows;

-- CDC errors from SQL Agent job history
SELECT TOP 20
    j.name AS job_name,
    jh.step_name,
    jh.run_date,
    jh.run_time,
    jh.message
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobhistory jh ON j.job_id = jh.job_id
WHERE j.name LIKE 'cdc.%'
  AND jh.run_status = 0  -- 0 = failed
ORDER BY jh.run_date DESC, jh.run_time DESC;
```

---

## Azure SQL Differences

| Feature | On-Prem | Azure SQL Database |
|---|---|---|
| **CT** | Full support | Full support |
| **CDC** | Requires SQL Agent running | No SQL Agent needed — background process handles capture |
| **CDC setup** | Same T-SQL (`sp_cdc_enable_db`) | Same T-SQL |
| **CDC capture jobs** | `sys.sp_cdc_start_job` / `stop_job` | Not applicable — cannot control background process |
| **CDC cleanup** | Cleanup job controls retention | Configured via `sys.sp_cdc_change_job` but executed by background process |
| **CDC on Hyperscale** | N/A | CDC supported; log reader uses replicated log |
| **CT retention** | ALTER DATABASE | ALTER DATABASE |

> [!NOTE] Azure SQL Database
> On Azure SQL Database, CDC capture is managed by Azure's background infrastructure. The SQL Agent jobs appear in `msdb` but are stubs — don't try to manage them as you would on-prem. Polling interval and retention are still configurable via `sys.sp_cdc_change_job`.

---

## Always On Considerations

### Change Tracking with Always On

- CT change tables are in-memory structures; they do **not** replicate to secondaries
- Readable secondaries: `CHANGETABLE()` queries work, but the version store on the secondary may be slightly behind the primary
- After AG failover, the new primary resumes CT from the last committed version — no data loss, no resync needed

### CDC with Always On

- CDC change tables **do replicate** to secondaries (they are regular user tables)
- The capture job runs on the **primary replica only**
- After failover, the capture job must be started on the new primary:

```sql
-- Run on new primary after AG failover
EXEC sys.sp_cdc_start_job @job_type = N'capture';
```

> [!WARNING] CDC After Failover
> CDC capture jobs do not automatically restart after an AG failover. You must monitor for failover events (using an AG health alert or XE session) and start the capture job on the new primary. Otherwise, CDC change tables will stop growing and consumers will silently fall behind. [^9]

---

## Metadata Queries

```sql
-- ===== CHANGE TRACKING =====

-- All CT-enabled databases on the instance
SELECT db_name(database_id), retention_period, retention_period_units_desc, is_auto_cleanup_on
FROM sys.change_tracking_databases;

-- All CT-enabled tables in current database
SELECT OBJECT_SCHEMA_NAME(object_id) + '.' + OBJECT_NAME(object_id) AS table_name,
       is_track_columns_updated_on,
       min_valid_version,
       CHANGE_TRACKING_CURRENT_VERSION() AS current_version
FROM sys.change_tracking_tables;

-- ===== CDC =====

-- Is CDC enabled on this database?
SELECT is_cdc_enabled FROM sys.databases WHERE name = DB_NAME();

-- All CDC capture instances
SELECT
    capture_instance,
    source_schema,
    source_table,
    sys.fn_cdc_map_lsn_to_time(start_lsn) AS started_at,
    supports_net_changes,
    has_drop_pending
FROM cdc.change_tables;

-- Columns captured per instance
SELECT
    cc.capture_instance,
    cc.column_name,
    cc.column_type,
    cc.column_ordinal
FROM cdc.captured_columns cc
ORDER BY cc.capture_instance, cc.column_ordinal;

-- CDC index on change tables (useful for troubleshooting)
SELECT
    OBJECT_NAME(i.object_id) AS change_table,
    i.name AS index_name,
    i.type_desc
FROM sys.indexes i
WHERE OBJECT_SCHEMA_NAME(i.object_id) = 'cdc';
```

---

## Gotchas

1. **CT version window expiry** — If your ETL runs late and the retention window passes, you must do a full resync. Always validate `CHANGE_TRACKING_MIN_VALID_VERSION()` before consuming.

2. **CDC does not capture `TRUNCATE TABLE`** — TRUNCATE is a minimally logged DDL operation; CDC cannot see it. Rows deleted by TRUNCATE will silently disappear from the source without a delete record in the CDC change table.

3. **CT collapses multiple updates** — If a row is updated 5 times between ETL runs, CT shows only one change. Use CDC if the intermediate states matter.

4. **CDC with BULK INSERT / BCP minimal logging** — Minimally logged bulk imports require that the target table is not being replicated; since CDC uses the same log reader infrastructure as transactional replication, bulk operations on CDC-enabled tables are fully logged under any recovery model. If CDC is disabled and re-enabled around bulk loads, test carefully to ensure no changes are missed. [^10]

5. **2-capture-instance limit** — You cannot have more than 2 capture instances per table. Schema migration requires careful sequencing (create new → migrate consumers → drop old). Attempting a third `sp_cdc_enable_table` while two active instances exist will fail.

6. **CDC agent job latency** — The capture job polls the log every `@pollinginterval` seconds (default: 5). High-throughput tables with large transactions can lag further. Monitor capture lag in production.

7. **CT and DDL** — Adding or dropping columns while CT is enabled requires no special steps; CT tracks PK + operation only, not column values. Re-enabling CT is not required for DDL changes.

8. **CDC and DDL** — Adding columns to a CDC-enabled table does NOT automatically update the capture instance. The old capture instance continues capturing only the original columns. See [Capture Instance Management](#cdc-capture-instance-management).

9. **In-Memory OLTP (Hekaton) compatibility** — Neither CT nor CDC supports memory-optimized tables. Attempting to enable CT or CDC on a memory-optimized table raises an error.

10. **CT with `NOCOUNT OFF`** — `SET NOCOUNT OFF` in a session or procedure that modifies CT-enabled tables adds extra result set round-trips; use `SET NOCOUNT ON` in ETL procedures for performance.

11. **CDC change table lock contention** — CDC writes to `cdc.*_CT` tables; heavy workloads can cause lock contention between the capture job and consumer queries. Use `READPAST` or separate read replicas for consumers when possible.

12. **Snapshot isolation and CT** — CT is version-consistent under RCSI/Snapshot isolation. `CHANGETABLE()` is safe to call inside a snapshot transaction. CDC consumers are also safe with snapshot isolation.

---

## See Also

- `references/13-transactions-locking.md` — isolation levels, RCSI, row versioning
- `references/17-temporal-tables.md` — system-versioned history for time-travel queries
- `references/38-auditing.md` — SQL Server Audit for compliance-grade logging
- `references/44-backup-restore.md` — backup strategy (CDC requires FULL recovery model)
- `references/43-high-availability.md` — Always On AG failover and CDC restart

---

## Sources

[^1]: [About Change Tracking - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/track-changes/about-change-tracking-sql-server) — overview of Change Tracking, how it works, one-way and two-way synchronization patterns, and cleanup behavior
[^2]: [What is change data capture (CDC)? - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/track-changes/about-change-data-capture-sql-server) — overview of CDC architecture, capture instances, change tables, validity intervals, Agent jobs, and interoperability notes
[^3]: [cdc.fn_cdc_get_all_changes_&lt;capture_instance&gt; (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/cdc-fn-cdc-get-all-changes-capture-instance-transact-sql) — reference for the CDC table-valued function that returns all changes within a specified LSN range
[^4]: [CHANGETABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/changetable-transact-sql) — reference for the CHANGETABLE function used to query Change Tracking data (CHANGES and VERSION forms)
[^5]: [Change Data Capture (CDC) With Azure SQL Database](https://learn.microsoft.com/en-us/azure/azure-sql/database/change-data-capture-overview) — CDC on Azure SQL Database including the background scheduler, limitations, performance considerations, and differences from on-premises SQL Server
[^6]: [Performance Tuning SQL Server Change Tracking - Brent Ozar Unlimited®](https://www.brentozar.com/archive/2014/06/performance-tuning-sql-server-change-tracking/) — Kendra Little on Change Tracking internals, cleanup operations, performance tuning, and comparison notes with CDC
[^7]: [sys.sp_cdc_enable_table (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sys-sp-cdc-enable-table-transact-sql) — reference for the stored procedure that enables CDC on a table and creates capture instances
[^8]: [sys.sp_cdc_change_job (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sys-sp-cdc-change-job-transact-sql) — reference for the stored procedure that modifies CDC capture and cleanup job configuration parameters
[^9]: [Replication, Change Tracking, Change Data Capture & Availability Groups - SQL Server Always On](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/replicate-track-change-data-capture-always-on-availability) — documents that CDC capture jobs must be manually created on the new primary after AG failover using sp_cdc_add_job
[^10]: [Prerequisites for Minimal Logging in Bulk Import - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/import-export/prerequisites-for-minimal-logging-in-bulk-import) — documents that minimal logging requires the target table is not being replicated, and that BULK INSERT is fully logged when transactional replication is enabled

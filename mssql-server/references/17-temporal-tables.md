# 17 — Temporal Tables (System-Versioned)

System-versioned temporal tables automatically track full row history with engine-enforced period columns. Use them for audit trails, point-in-time reporting, slowly changing dimensions, and regulatory compliance without custom triggers or shadow tables.

## Table of Contents

- [When to Use](#when-to-use)
- [Architecture](#architecture)
- [Creating Temporal Tables](#creating-temporal-tables)
- [Converting an Existing Table](#converting-an-existing-table)
- [Time-Travel Queries (FOR SYSTEM_TIME)](#time-travel-queries-for-system_time)
- [DML on Temporal Tables](#dml-on-temporal-tables)
- [Altering Temporal Tables](#altering-temporal-tables)
- [History Table Internals](#history-table-internals)
- [Retention Policy](#retention-policy)
- [Stretch and Partitioning Strategies](#stretch-and-partitioning-strategies)
- [Temporal in Azure SQL](#temporal-in-azure-sql)
- [Metadata Queries](#metadata-queries)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use

**Use temporal tables when you need:**
- Row-level change history without application code (triggers, shadow tables)
- Point-in-time queries: "what did the record look like on date X?"
- Audit compliance with engine-enforced, tamper-evident history
- Slowly changing dimension (SCD Type 2) data with native time-travel syntax

**Prefer alternatives when:**
- You need statement-level or transaction-level granularity beyond what `datetime2(7)` provides (use CDC or audit tables instead)
- You need to capture the *user* who made the change (temporal only captures when — use auditing triggers or SQL Server Audit for who)
- The table receives millions of updates per second and history table growth is unacceptable

> [!NOTE] SQL Server 2016
> System-versioned temporal tables require SQL Server 2016 (compat level 130+) or Azure SQL Database.

---

## Architecture

```
Current Table (dbo.Employee)
┌────────────────────────────────────────────────────┐
│ EmployeeId  Name     Salary  ValidFrom    ValidTo   │
│ 1           Alice    80000   2024-01-01   9999-...  │
└────────────────────────────────────────────────────┘
         │ UPDATE Salary = 90000
         ▼
Current Table                    History Table (dbo.EmployeeHistory)
┌──────────────────────────────┐  ┌────────────────────────────────────────────────────┐
│ 1  Alice  90000  2025-03-01  │  │ 1  Alice  80000  2024-01-01  2025-03-01            │
└──────────────────────────────┘  └────────────────────────────────────────────────────┘
```

**Key facts:**
- Two `datetime2(7)` columns define the **system-time period**: `ValidFrom` (row start, inclusive) and `ValidTo` (row end, exclusive)
- On INSERT: `ValidFrom = current UTC time`, `ValidTo = 9999-12-31 23:59:59.9999999`
- On UPDATE: old row copied to history with `ValidTo = current UTC time`; current row gets new `ValidFrom`
- On DELETE: old row copied to history; removed from current table
- History is stored in UTC regardless of session time zone

---

## Creating Temporal Tables

### Minimal syntax

```sql
CREATE TABLE dbo.Employee
(
    EmployeeId  INT            NOT NULL PRIMARY KEY,
    Name        NVARCHAR(100)  NOT NULL,
    Department  NVARCHAR(50)   NOT NULL,
    Salary      DECIMAL(18,2)  NOT NULL,
    -- Period columns: generated always, hidden optional
    ValidFrom   datetime2(7)   GENERATED ALWAYS AS ROW START NOT NULL,
    ValidTo     datetime2(7)   GENERATED ALWAYS AS ROW END   NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)
)
WITH (SYSTEM_VERSIONING = ON);
```

SQL Server auto-generates the history table as `dbo.Employee_History` (name based on current table).

### Explicit history table name (recommended)

```sql
CREATE TABLE dbo.Employee
(
    EmployeeId  INT            NOT NULL PRIMARY KEY,
    Name        NVARCHAR(100)  NOT NULL,
    Department  NVARCHAR(50)   NOT NULL,
    Salary      DECIMAL(18,2)  NOT NULL,
    ValidFrom   datetime2(7)   GENERATED ALWAYS AS ROW START NOT NULL,
    ValidTo     datetime2(7)   GENERATED ALWAYS AS ROW END   NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)
)
WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.EmployeeHistory));
```

Always specify the history table name — it makes schema management predictable and prevents surprises during schema compare.

### Hidden period columns (reduces SELECT * noise)

```sql
ValidFrom  datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
ValidTo    datetime2(7) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
```

`HIDDEN` columns do not appear in `SELECT *` but are still queryable by name. Useful for application compatibility.

### Default values for existing rows (conversion)

When enabling versioning on an existing table, SQL Server sets `ValidFrom = '0001-01-01'` and `ValidTo = '9999-12-31'` for all pre-existing rows unless you control it with `DATA_CONSISTENCY_CHECK`.

---

## Converting an Existing Table

Three-step process to enable system versioning on a live table without downtime:

```sql
-- Step 1: Add period columns (allow NULL initially for population)
ALTER TABLE dbo.Employee
ADD ValidFrom datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL
        DEFAULT '2000-01-01 00:00:00.0000000',
    ValidTo   datetime2(7) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL
        DEFAULT '9999-12-31 23:59:59.9999999';

-- Step 2: Create the period
ALTER TABLE dbo.Employee
ADD PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo);

-- Step 3: Enable system versioning (creates history table automatically)
ALTER TABLE dbo.Employee
SET (SYSTEM_VERSIONING = ON (
    HISTORY_TABLE = dbo.EmployeeHistory,
    DATA_CONSISTENCY_CHECK = ON  -- verifies ValidFrom < ValidTo for all rows
));
```

`DATA_CONSISTENCY_CHECK = ON` (the default) runs a full table scan — on large tables, consider scheduling during low-traffic windows.

### Pre-populating history before conversion

If you have existing audit data in another table, you can populate the history table manually before enabling versioning:

```sql
-- Create history table with same schema (no PK, no period, no system versioning)
CREATE TABLE dbo.EmployeeHistory
(
    EmployeeId  INT            NOT NULL,
    Name        NVARCHAR(100)  NOT NULL,
    Department  NVARCHAR(50)   NOT NULL,
    Salary      DECIMAL(18,2)  NOT NULL,
    ValidFrom   datetime2(7)   NOT NULL,
    ValidTo     datetime2(7)   NOT NULL
);

-- Populate from legacy audit table
INSERT INTO dbo.EmployeeHistory (EmployeeId, Name, Department, Salary, ValidFrom, ValidTo)
SELECT EmployeeId, Name, Department, Salary, ChangedAt, LeadChangedAt
FROM   dbo.LegacyAudit;

-- Enable versioning — links to pre-populated history table
ALTER TABLE dbo.Employee
SET (SYSTEM_VERSIONING = ON (
    HISTORY_TABLE = dbo.EmployeeHistory,
    DATA_CONSISTENCY_CHECK = ON
));
```

---

## Time-Travel Queries (FOR SYSTEM_TIME)

All temporal queries use the `FOR SYSTEM_TIME` clause. Times are always interpreted as **UTC**.

### AS OF — single point in time

```sql
-- What did employee 1 look like on 2024-06-15 at noon UTC?
SELECT *
FROM   dbo.Employee FOR SYSTEM_TIME AS OF '2024-06-15T12:00:00'
WHERE  EmployeeId = 1;
```

Returns the row where `ValidFrom <= '2024-06-15T12:00:00' < ValidTo`. Returns the current row if no historical row matches (i.e., if the record was the same at that point).

### BETWEEN — all versions active within a range (inclusive on both ends)

```sql
-- All versions of employee 1 that were active at any point in 2024
SELECT EmployeeId, Name, Salary, ValidFrom, ValidTo
FROM   dbo.Employee FOR SYSTEM_TIME BETWEEN '2024-01-01' AND '2025-01-01'
WHERE  EmployeeId = 1
ORDER  BY ValidFrom;
```

`BETWEEN start AND end` returns rows where `ValidFrom <= end AND ValidTo > start` (overlap semantics, but uses inclusive start and end — edge: a row that ended exactly at `start` is not returned).

### FROM ... TO — half-open interval (exclusive on both ends)

```sql
-- Rows whose period overlapped (ValidFrom < end AND ValidTo > start)
SELECT *
FROM   dbo.Employee FOR SYSTEM_TIME FROM '2024-01-01' TO '2025-01-01'
WHERE  EmployeeId = 1;
```

`FROM ... TO` excludes rows that started exactly at `TO` or ended exactly at `FROM`. More precise than `BETWEEN` for sliding window queries.

### CONTAINED IN — rows fully within the range

```sql
-- Only rows whose entire lifetime falls within 2024
SELECT *
FROM   dbo.Employee FOR SYSTEM_TIME CONTAINED IN ('2024-01-01', '2025-01-01')
WHERE  EmployeeId = 1;
```

`CONTAINED IN (start, end)` returns rows where `ValidFrom >= start AND ValidTo <= end`. Use this for "show me everything that changed and completed within this window."

### ALL — current table + full history (UNION ALL semantics)

```sql
-- Every version ever, including current
SELECT EmployeeId, Name, Salary, ValidFrom, ValidTo,
       CASE WHEN ValidTo = '9999-12-31 23:59:59.9999999' THEN 'CURRENT' ELSE 'HISTORY' END AS RowStatus
FROM   dbo.Employee FOR SYSTEM_TIME ALL
WHERE  EmployeeId = 1
ORDER  BY ValidFrom;
```

### Joining temporal tables across time

```sql
-- What was each employee's department name at the time of their salary change?
SELECT e.EmployeeId, e.Name, e.Salary, d.DepartmentName, e.ValidFrom
FROM   dbo.Employee    FOR SYSTEM_TIME ALL e
JOIN   dbo.Department  FOR SYSTEM_TIME AS OF e.ValidFrom d
         ON d.DepartmentId = e.DepartmentId
ORDER  BY e.EmployeeId, e.ValidFrom;
```

Joining two temporal tables at the same historical point is a key power feature.

### Counting changes over time (change audit report)

```sql
-- How many times did each employee's salary change in 2024?
SELECT   EmployeeId, COUNT(*) AS SalaryChanges
FROM     dbo.Employee FOR SYSTEM_TIME CONTAINED IN ('2024-01-01', '2025-01-01')
WHERE    ValidFrom > '0001-01-01'  -- exclude pre-conversion placeholder rows
GROUP BY EmployeeId
HAVING   COUNT(*) > 0;
```

---

## DML on Temporal Tables

DML on the current table behaves normally; the engine handles history transparently.

```sql
-- INSERT: ValidFrom = SYSUTCDATETIME(), ValidTo = max datetime2
INSERT INTO dbo.Employee (EmployeeId, Name, Department, Salary)
VALUES (42, 'Bob', 'Engineering', 75000);

-- UPDATE: old row archived with ValidTo = now; new row starts with ValidFrom = now
UPDATE dbo.Employee SET Salary = 80000 WHERE EmployeeId = 42;

-- DELETE: row archived with ValidTo = now; removed from current table
DELETE FROM dbo.Employee WHERE EmployeeId = 42;
```

**You cannot directly INSERT/UPDATE/DELETE the history table** while system versioning is active. You must disable versioning first (see [Altering Temporal Tables](#altering-temporal-tables)).

### Bulk loading with period suppression (data migration)

During migration, you may need to supply historical `ValidFrom`/`ValidTo` values:

```sql
-- Temporarily disable versioning to allow manual history inserts
ALTER TABLE dbo.Employee SET (SYSTEM_VERSIONING = OFF);

-- Insert current rows and historical rows with exact timestamps
INSERT INTO dbo.Employee (EmployeeId, Name, Department, Salary, ValidFrom, ValidTo)
VALUES (1, 'Alice', 'HR', 80000, '2020-01-01', '9999-12-31 23:59:59.9999999');

INSERT INTO dbo.EmployeeHistory (EmployeeId, Name, Department, Salary, ValidFrom, ValidTo)
VALUES (1, 'Alice', 'HR', 70000, '2018-06-01', '2020-01-01');

-- Re-enable versioning
ALTER TABLE dbo.Employee SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.EmployeeHistory));
```

---

## Altering Temporal Tables

### Adding a column

```sql
-- Must add to current table (propagates to history automatically in SQL 2017+)
ALTER TABLE dbo.Employee ADD MiddleName NVARCHAR(50) NULL;
```

> [!NOTE] SQL Server 2017
> In SQL Server 2016, adding a nullable column required disabling versioning first. In 2017+, online column addition works without disabling versioning.

### Dropping a column

```sql
-- Step 1: Disable versioning (history table becomes a regular table)
ALTER TABLE dbo.Employee SET (SYSTEM_VERSIONING = OFF);

-- Step 2: Drop from both tables
ALTER TABLE dbo.Employee        DROP COLUMN MiddleName;
ALTER TABLE dbo.EmployeeHistory DROP COLUMN MiddleName;

-- Step 3: Re-enable
ALTER TABLE dbo.Employee SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.EmployeeHistory));
```

### Removing system versioning entirely

```sql
ALTER TABLE dbo.Employee SET (SYSTEM_VERSIONING = OFF);
-- History table now exists as a standalone table; does NOT get dropped automatically
-- Drop it explicitly if desired:
DROP TABLE dbo.EmployeeHistory;
-- Remove the period
ALTER TABLE dbo.Employee DROP PERIOD FOR SYSTEM_TIME;
-- Drop period columns
ALTER TABLE dbo.Employee DROP COLUMN ValidFrom, DROP COLUMN ValidTo;
```

---

## History Table Internals

The history table created automatically by SQL Server has:
- Same column definitions as the current table (no PK, no unique indexes enforced)
- A clustered index on `(ValidTo, ValidFrom)` by default — this is optimal for `AS OF` queries
- No foreign keys, triggers, check constraints, or computed columns
- No system versioning of its own (it's a regular heap + index)

### History table index strategy

The default `(ValidTo, ValidFrom)` clustered index is optimal for `AS OF` because it allows a seek to rows where `ValidFrom <= @point < ValidTo`.

For queries dominated by entity-level history (`FOR SYSTEM_TIME ALL WHERE EmployeeId = ?`), add:

```sql
CREATE INDEX IX_EmployeeHistory_EmployeeId_ValidFrom
ON dbo.EmployeeHistory (EmployeeId, ValidFrom, ValidTo)
INCLUDE (Name, Salary, Department);
```

For range-of-time queries across many entities, the default index is usually sufficient. [^4]

---

## Retention Policy

> [!NOTE] SQL Server 2017
> History retention policy requires SQL Server 2017 (compat level 130+) or Azure SQL Database. It was back-ported from Azure SQL.

Without retention, the history table grows forever. Enable retention to auto-purge old history:

```sql
-- Step 1: Enable retention at database level (one-time)
ALTER DATABASE CURRENT SET TEMPORAL_HISTORY_RETENTION ON;

-- Step 2: Set retention on the table
ALTER TABLE dbo.Employee
SET (SYSTEM_VERSIONING = ON (
    HISTORY_TABLE        = dbo.EmployeeHistory,
    HISTORY_RETENTION_PERIOD = 1 YEAR
));
```

Valid units: `DAY`, `WEEK`, `MONTH`, `YEAR`. Use `INFINITE` to disable retention explicitly.

### Retention cleanup mechanics

- A background task runs periodically (approximately every hour) and deletes rows from the history table where `ValidTo < SYSUTCDATETIME() - retention_period`
- Cleanup is done in batches of 10,000 rows to avoid long-running transactions [^3]
- The cleanup uses the `(ValidTo, ValidFrom)` clustered index on the history table for efficiency
- Verify retention setting: `SELECT history_retention_period, history_retention_period_unit_desc FROM sys.tables WHERE temporal_type = 2`

### Viewing and changing retention

```sql
SELECT
    t.name                              AS TableName,
    t.history_retention_period,
    t.history_retention_period_unit_desc
FROM sys.tables t
WHERE t.temporal_type = 2;  -- 2 = system-versioned

-- Change retention period
ALTER TABLE dbo.Employee
SET (SYSTEM_VERSIONING = ON (HISTORY_RETENTION_PERIOD = 6 MONTH));

-- Disable retention for this table only
ALTER TABLE dbo.Employee
SET (SYSTEM_VERSIONING = ON (HISTORY_RETENTION_PERIOD = INFINITE));
```

---

## Stretch and Partitioning Strategies

### Partitioning the history table

For very large history tables, partition by `ValidTo` to align with the retention window:

```sql
-- Disable versioning temporarily
ALTER TABLE dbo.Employee SET (SYSTEM_VERSIONING = OFF);

-- Create partition function and scheme on ValidTo
CREATE PARTITION FUNCTION pf_HistoryValidTo (datetime2(7))
AS RANGE RIGHT FOR VALUES (
    '2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01'
);

CREATE PARTITION SCHEME ps_HistoryValidTo
AS PARTITION pf_HistoryValidTo ALL TO ([PRIMARY]);

-- Rebuild clustered index on partition scheme
CREATE CLUSTERED INDEX CX_EmployeeHistory_ValidTo_ValidFrom
ON dbo.EmployeeHistory (ValidTo, ValidFrom)
WITH (DROP_EXISTING = ON)
ON ps_HistoryValidTo (ValidTo);

-- Re-enable versioning
ALTER TABLE dbo.Employee
SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.EmployeeHistory));
```

This allows efficient partition switching to archive old history to cold storage.

### Page compression on history table

History rows are write-once, so compression is safe and recommended:

```sql
ALTER TABLE dbo.EmployeeHistory REBUILD WITH (DATA_COMPRESSION = PAGE);
```

---

## Temporal in Azure SQL

Most temporal features work identically in Azure SQL Database and Azure SQL Managed Instance.

**Differences in Azure SQL:**
- Retention policy is available (was introduced there before on-prem)
- Stretch Database to cold Azure Blob storage for history was deprecated — use partition switching + external tables instead [^1]
- Azure SQL supports ledger tables as an alternative for tamper-evident history (see `22-ledger-tables.md`)
- In Azure SQL serverless, the background cleanup task may be delayed during auto-pause periods

> [!WARNING] Deprecated
> Stretch Database (for offloading temporal history to Azure) was deprecated in SQL Server 2022 and Azure SQL. Use partition switching or tiered storage patterns instead. [^2]

---

## Metadata Queries

### List all temporal tables and their history tables

```sql
SELECT
    t.name                          AS CurrentTable,
    SCHEMA_NAME(t.schema_id)        AS TableSchema,
    h.name                          AS HistoryTable,
    SCHEMA_NAME(h.schema_id)        AS HistorySchema,
    t.temporal_type_desc,
    t.history_retention_period,
    t.history_retention_period_unit_desc
FROM sys.tables t
JOIN sys.tables h ON h.object_id = t.history_table_id
WHERE t.temporal_type = 2  -- SYSTEM_VERSIONED_TEMPORAL_TABLE
ORDER BY t.name;
```

### Inspect period columns

```sql
SELECT
    c.name                    AS ColumnName,
    c.generated_always_type_desc,
    c.is_hidden,
    tp.name                   AS DataType,
    c.max_length
FROM sys.columns c
JOIN sys.types   tp ON tp.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.Employee')
  AND c.generated_always_type > 0
ORDER BY c.column_id;
```

### Estimate history table size

```sql
SELECT
    OBJECT_NAME(i.object_id)                                 AS TableName,
    SUM(a.total_pages) * 8 / 1024                            AS TotalMB,
    SUM(a.used_pages)  * 8 / 1024                            AS UsedMB,
    SUM(p.rows)                                              AS RowCount
FROM sys.indexes i
JOIN sys.partitions p ON p.object_id = i.object_id AND p.index_id = i.index_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE i.object_id = OBJECT_ID('dbo.EmployeeHistory')
GROUP BY i.object_id;
```

---

## Gotchas / Anti-patterns

1. **Times are UTC — session timezone doesn't matter.** `ValidFrom`/`ValidTo` are always UTC. If your application stores local times, conversions in `AS OF` queries are your responsibility. Use `AT TIME ZONE` to convert: `WHERE ValidFrom AT TIME ZONE 'Eastern Standard Time' > @localTime`.

2. **`AS OF` on the current table includes history rows.** `FOR SYSTEM_TIME AS OF` queries both the current table and the history table transparently. It does NOT just query the history table — a row current at `@point` returns from the current table if it's still active.

3. **Cannot UPDATE or DELETE from the history table directly.** While system versioning is ON, the history table is locked for DML. You must `SET (SYSTEM_VERSIONING = OFF)` first. This is intentional for tamper-evidence.

4. **Period columns cannot be explicitly set by user INSERT/UPDATE.** The engine ignores any value you provide for `ValidFrom`/`ValidTo` columns in regular DML (they're `GENERATED ALWAYS`). To supply custom timestamps, disable versioning first.

5. **`DATA_CONSISTENCY_CHECK = ON` does a full table scan.** When enabling versioning on large existing tables, schedule this during low-traffic windows. The check verifies `ValidFrom < ValidTo` for every row.

6. **History rows are NOT covered by the current table's indexes.** Index seeks on the current table don't help history-only scans. Add indexes directly on the history table for frequent temporal queries.

7. **Cascading FK deletes cause temporal DELETE to archive the row.** The deleted row ends up in history; it is not "truly deleted" from the database. If compliance requires purging personal data (GDPR right to erasure), you must disable versioning and manually delete from both tables, then re-enable.

8. **TRUNCATE TABLE is blocked on temporal tables.** You cannot truncate a table with system versioning enabled. Disable versioning first or use batched DELETE.

9. **Retention period is best-effort, not real-time.** The cleanup background task runs approximately hourly. Data older than the retention period may persist for up to a few hours. Do not rely on retention for real-time data expiry.

10. **`CONTAINED IN` requires both endpoints to be before `9999-12-31`.** Because current rows have `ValidTo = '9999-12-31 23:59:59.9999999'`, a `CONTAINED IN` query will never return current rows (their `ValidTo` > any reasonable `end` value). Use `FOR SYSTEM_TIME ALL` or `BETWEEN` if you want current rows included.

11. **No support for user-defined temporal types or application-time period tables in the same syntax.** SQL Server 2022 does not support application-time (bitemporal) tables natively — that's ISO SQL 2011 syntax not yet implemented. Simulate with a second pair of date columns and manual queries. [^5]

---

## See Also

- [`13-transactions-locking.md`](13-transactions-locking.md) — MVCC and snapshot isolation, which temporal tables interact with during `AS OF` queries
- [`12-custom-defaults-rules.md`](12-custom-defaults-rules.md) — constraints on temporal tables (CHECK constraints allowed, FK from history tables not allowed)
- [`22-ledger-tables.md`](22-ledger-tables.md) — ledger tables as an alternative for tamper-evident history (2022+)
- [`10-partitioning.md`](10-partitioning.md) — partitioning the history table for lifecycle management
- [`36-data-compression.md`](36-data-compression.md) — compressing history tables (PAGE compression is safe for write-once history)
- [`37-change-tracking-cdc.md`](37-change-tracking-cdc.md) — CDC and Change Tracking as alternatives when you need change deltas rather than full row history

---

## Sources

[^1]: [Deprecated Database Engine Features in SQL Server 2022](https://learn.microsoft.com/en-us/sql/database-engine/deprecated-database-engine-features-in-sql-server-2022) — Official Microsoft announcement listing Stretch Database as deprecated in SQL Server 2022 (16.x) and Azure SQL Database.
[^2]: [Temporal Tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables) — Core temporal table documentation covering system-versioned table concepts, `FOR SYSTEM_TIME` clause syntax, period columns, and history table behavior.
[^3]: [Manage historical data in system-versioned temporal tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/manage-retention-of-historical-data-in-system-versioned-temporal-tables) — Covers `HISTORY_RETENTION_PERIOD` syntax, background cleanup mechanics (batch size, scheduling), table partitioning for history, and custom cleanup scripts.
[^4]: [SQL Server 2016 Temporal Table Query Plan Behaviour](https://sqlperformance.com/2016/06/sql-server-2016/temporal-table-query-plan-behaviour) — Rob Farley on SQLPerformance.com; covers history table index strategy and query plan behavior for temporal table queries.
[^5]: [Temporal Tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables) — Microsoft's temporal table documentation covers only system-versioned temporal tables (transaction-time); application-time period tables and bitemporal tables as defined in [ISO SQL:2011](https://en.wikipedia.org/wiki/SQL:2011) are not implemented in any SQL Server version through 2022.

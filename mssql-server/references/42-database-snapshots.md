# 42 — Database Snapshots

## Table of Contents

1. [When to Use](#when-to-use)
2. [How Database Snapshots Work](#how-database-snapshots-work)
3. [Creating a Database Snapshot](#creating-a-database-snapshot)
4. [Querying a Snapshot](#querying-a-snapshot)
5. [DBCC CHECKDB Against a Snapshot](#dbcc-checkdb-against-a-snapshot)
6. [Reverting a Database to a Snapshot](#reverting-a-database-to-a-snapshot)
7. [Dropping a Snapshot](#dropping-a-snapshot)
8. [Snapshot Size Growth](#snapshot-size-growth)
9. [Snapshots and Always On](#snapshots-and-always-on)
10. [Snapshots vs Backup/Restore vs CDC vs Temporal Tables](#snapshots-vs-backuprestore-vs-cdc-vs-temporal-tables)
11. [Monitoring Snapshots](#monitoring-snapshots)
12. [Common Patterns](#common-patterns)
13. [Limitations](#limitations)
14. [Gotchas](#gotchas)
15. [See Also](#see-also)
16. [Sources](#sources)

---

## When to Use

Use database snapshots for:

| Scenario | Snapshot role |
|---|---|
| Pre-upgrade or pre-migration safety net | Take snapshot → apply change → revert if needed |
| Consistent point-in-time reporting copy | Readers query snapshot; OLTP continues on source |
| Fast dev/test environment reset | Reset to known-good state in seconds (no restore) |
| Offline CHECKDB without impacting production | `DBCC CHECKDB` runs against snapshot, not source |
| Rapid undo for batch jobs or schema changes | Revert after bad deployment instead of running undo scripts |

**Do not use** snapshots as a backup strategy — they are dependent on the source database and are destroyed if the source is lost or dropped.

---

## How Database Snapshots Work

A snapshot is a **read-only, point-in-time copy** of a database that uses **copy-on-write (CoW)** sparse files on NTFS.

### Copy-on-write mechanics

1. At creation time the snapshot files are **zero-byte sparse files** — they consume almost no disk space.
2. When a page in the source database is first modified after the snapshot was taken, the **original (pre-modification) page** is written to the snapshot sparse file before the source page is updated.
3. Subsequent modifications to the same page are **not** copied again (the snapshot already has the original).
4. When a snapshot reader needs a page:
   - If the page is in the snapshot sparse file → read from snapshot.
   - If not → read from the source database (the source still has the unchanged page).

This means:
- Snapshot creation is **near-instant** regardless of database size.
- Read I/O from the snapshot goes to the source database for unmodified pages.
- Snapshot size grows proportionally to how many source pages change after creation.

### Requirements

- NTFS (or ReFS on Windows) volumes — sparse files are an NTFS feature.
- Source database must be **online**.
- SQL Server must have write access to the snapshot file path.
- Source database files and snapshot files must be on the **same volume** or accessible to the same SQL Server instance.

> [!WARNING] Linux limitation
> Sparse files require an underlying filesystem that supports them (ext4, XFS, Btrfs). SQL Server on Linux supports database snapshots but the filesystem must support sparse files. NTFS is not available on Linux; ext4 and XFS both support sparse files. Verify with `lsattr` or `stat --file-system`.

---

## Creating a Database Snapshot

```sql
-- Minimal syntax: one sparse file per source data file
CREATE DATABASE AdventureWorks_SS_20260317
ON
(
    NAME = AdventureWorks_Data,          -- logical file name from source
    FILENAME = 'D:\Snapshots\AW_SS_20260317.ss'  -- snapshot sparse file path
)
AS SNAPSHOT OF AdventureWorks;
GO
```

For a multi-file database, you must specify **one snapshot file per source data file** (not log files — snapshots do not include log files):

```sql
-- Multi-file database snapshot
CREATE DATABASE AdventureWorks_SS_20260317
ON
(
    NAME = AdventureWorks_Data,
    FILENAME = 'D:\Snapshots\AW_data_SS.ss'
),
(
    NAME = AdventureWorks_FG2,
    FILENAME = 'D:\Snapshots\AW_fg2_SS.ss'
)
AS SNAPSHOT OF AdventureWorks;
GO
```

Get the logical file names for a database:

```sql
SELECT name, physical_name, type_desc
FROM sys.master_files
WHERE database_id = DB_ID('AdventureWorks')
  AND type = 0;  -- data files only (type=1 is log)
```

### Naming convention recommendation

Include the source database name, date, and optionally a tag:

```
<SourceDB>_SS_<YYYYMMDD>[_<tag>]
```

Example: `AdventureWorks_SS_20260317_preupgrade`

---

## Querying a Snapshot

```sql
-- Connect to the snapshot directly
USE AdventureWorks_SS_20260317;
GO

SELECT TOP 10 * FROM Sales.SalesOrderHeader
ORDER BY OrderDate DESC;
```

Or use a four-part name / USE statement and redirect:

```sql
-- From a different database context, specify the snapshot DB name
SELECT COUNT(*) FROM AdventureWorks_SS_20260317.Sales.SalesOrderHeader;
```

Snapshots are **read-only**. Any DML (INSERT/UPDATE/DELETE) or DDL will fail:

```
Msg 3906, Level 16: Failed to update database "AdventureWorks_SS_20260317"
because the database is read-only.
```

### Using snapshots for consistent reporting

Instead of querying a busy OLTP database, point a report to the snapshot. Snapshot reads never block writers on the source and writers never block snapshot reads:

```sql
-- In the report connection string, use the snapshot database name:
-- Server=.;Database=AdventureWorks_SS_20260317;Trusted_Connection=Yes;
```

> [!NOTE] SQL Server 2022
> Snapshots work with contained Availability Groups. See [43-high-availability.md](43-high-availability.md) for contained AG details.

---

## DBCC CHECKDB Against a Snapshot

SQL Server automatically creates an internal snapshot when you run `DBCC CHECKDB` against an online database — but that internal snapshot is destroyed when CHECKDB finishes and cannot be reused.

Running CHECKDB against a **user-created snapshot** avoids creating a second internal snapshot and lets you re-run CHECKDB as many times as needed against the same consistent point-in-time view:

```sql
-- Run CHECKDB against a named snapshot
DBCC CHECKDB (AdventureWorks_SS_20260317) WITH NO_INFOMSGS, ALL_ERRORMSGS;
```

Benefits:
- No I/O impact on source database (CHECKDB reads from snapshot sparse files + source for unchanged pages)
- Can run during peak hours without impacting writes
- Can re-run multiple times without recreating the snapshot

> [!WARNING] Snapshot for CHECKDB only — do not defer snapshots too long
> If the snapshot is old, many pages will have changed in the source and the snapshot file will be large. CHECKDB reads the snapshot's version of each page, so a stale snapshot reflects old data. For integrity checking, create a fresh snapshot before running CHECKDB.

---

## Reverting a Database to a Snapshot

**Reverting** rolls the source database back to exactly the state it was in when the snapshot was taken. This is **destructive and irreversible** — all changes to the source since the snapshot was taken are lost.

```sql
-- Prerequisites:
-- 1. Only ONE snapshot of this database may exist when reverting
-- 2. Source database must have no other connections (switch to SINGLE_USER)
-- 3. SQL Server Agent or scheduled jobs should be stopped if they touch the DB

USE master;
GO

-- Kick all connections
ALTER DATABASE AdventureWorks SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
GO

-- Revert
RESTORE DATABASE AdventureWorks FROM DATABASE_SNAPSHOT = 'AdventureWorks_SS_20260317';
GO

-- Re-open
ALTER DATABASE AdventureWorks SET MULTI_USER;
GO
```

### What happens during revert

- SQL Server copies snapshot pages back into the source database.
- The transaction log is **rebuilt** — log backups taken after the snapshot are invalidated.
- The revert time is proportional to how many pages have changed since the snapshot was taken (only changed pages need to be copied back).
- If the database is in the full recovery model, you must take a **new full backup** after reverting — the log chain is broken.

> [!WARNING] Single snapshot required
> If multiple snapshots exist for the same source database, `RESTORE DATABASE ... FROM DATABASE_SNAPSHOT` will fail with:
> `Msg 3137: The database cannot be reverted. Either the primary or the snapshot names are improper, or there is more than one snapshot for the primary database.`
> Drop all other snapshots first.

> [!WARNING] Log chain broken after revert
> After reverting, the database log backup chain is broken. Take a full backup immediately before re-enabling any differential or log backup jobs.

---

## Dropping a Snapshot

```sql
-- Snapshots are dropped like any database
DROP DATABASE AdventureWorks_SS_20260317;
GO
```

When the source database is dropped, all its snapshots are also dropped automatically.

Snapshots **cannot** be detached, backed up, or restored. They can only be created and dropped.

---

## Snapshot Size Growth

Snapshot disk usage grows as source pages are modified. Monitor with:

```sql
-- Snapshot sparse file sizes (disk used vs allocated)
SELECT
    DB_NAME(database_id)                         AS snapshot_name,
    name                                         AS logical_file,
    physical_name,
    size * 8 / 1024                              AS allocated_mb,
    FILEPROPERTY(name, 'SpaceUsed') * 8 / 1024  AS used_mb
FROM sys.master_files
WHERE database_id IN (
    SELECT database_id FROM sys.databases WHERE source_database_id IS NOT NULL
);
```

For a simpler view using DMVs:

```sql
-- All snapshots with their source DB
SELECT
    s.name                              AS snapshot_db,
    d.name                              AS source_db,
    s.create_date,
    s.state_desc
FROM sys.databases s
JOIN sys.databases d ON s.source_database_id = d.database_id;
```

### Growth characteristics

| Source activity | Snapshot growth |
|---|---|
| Low write rate (mostly reads) | Slow growth; snapshot stays small |
| High write rate (OLTP) | Rapid growth; snapshot can reach source DB size |
| Bulk loads, index rebuilds | Very fast growth; can exhaust disk quickly |
| Full table rewrite (UPDATE all rows) | Snapshot grows to roughly source data size |

**Rule of thumb:** For a busy OLTP database, plan for snapshot sparse files to potentially reach 50–100% of source data size if the snapshot lives for more than a few hours. For short-lived pre-deployment snapshots (minutes), growth is typically < 5%.

---

## Snapshots and Always On

### Availability Group databases

- Snapshots can be created on the **primary replica** only.
- Snapshots cannot be created on secondary replicas (read-only secondaries).
- If the primary fails over, snapshots on the old primary are **not** transferred to the new primary.
- Reverting on an AG database requires removing the database from the AG first:

```sql
-- Remove from AG before revert
ALTER AVAILABILITY GROUP [MyAG] REMOVE DATABASE AdventureWorks;
GO

-- Perform revert (as shown above)

-- Re-add to AG after revert (requires full backup + restore on each secondary)
ALTER AVAILABILITY GROUP [MyAG] ADD DATABASE AdventureWorks;
GO
```

> [!WARNING] AG and revert
> Reverting an AG database requires rejoining all secondaries — effectively a full database re-seeding. For large databases this is very disruptive. Use snapshots as a safety net only when you expect a very low probability of needing to revert.

---

## Snapshots vs Backup/Restore vs CDC vs Temporal Tables

| Capability | Snapshot | Backup/Restore | CDC | Temporal Table |
|---|---|---|---|---|
| Creation speed | Near-instant | Proportional to DB size | Continuous | Always active |
| Recovery granularity | Full DB to snapshot point | Any point in log chain | Table-level, row-level changes | Per-row, any point in time |
| Space cost | Sparse (grows with changes) | Full copy | Change log only | History table (rows) |
| Reads source on unchanged pages | Yes (I/O dependency) | No (independent copy) | N/A | N/A |
| Survives source database loss | No | Yes | Partial (change log survives) | No (in same DB) |
| Revert / undo capability | Full DB revert to snapshot point | Restore to any point | Replay changes | Query history; manual undo |
| Row-level time travel | No | No | Yes (by LSN) | Yes (by AS OF) |
| Azure SQL Database support | No | Yes | Yes | Yes |
| Azure SQL Managed Instance | Yes | Yes | Yes | Yes |
| On-prem SQL Server | Yes | Yes | Yes | Yes |
| Use for compliance auditing | No (not tamper-evident) | No | Partial | Partial |

**Decision rule:**
- Use snapshot for pre-deployment safety nets, consistent reporting, or fast CHECKDB runs.
- Use backup/restore for disaster recovery and point-in-time recovery.
- Use CDC or temporal tables for row-level change tracking and audit.

---

## Monitoring Snapshots

### List all snapshots on the instance

```sql
SELECT
    s.name                              AS snapshot_name,
    d.name                              AS source_db,
    s.create_date,
    s.state_desc,
    s.is_read_only,
    s.snapshot_isolation_state_desc
FROM sys.databases s
LEFT JOIN sys.databases d ON s.source_database_id = d.database_id
WHERE s.source_database_id IS NOT NULL
ORDER BY s.create_date;
```

### Snapshot file sizes

```sql
SELECT
    DB_NAME(mf.database_id)             AS snapshot_db,
    mf.name                             AS logical_file,
    mf.physical_name,
    mf.size * 8 / 1024                  AS size_mb,
    mf.max_size,
    mf.growth
FROM sys.master_files mf
JOIN sys.databases d ON mf.database_id = d.database_id
WHERE d.source_database_id IS NOT NULL
ORDER BY DB_NAME(mf.database_id), mf.file_id;
```

### Check how many snapshots exist per source database

```sql
SELECT
    d.name                              AS source_db,
    COUNT(s.database_id)                AS snapshot_count,
    MIN(s.create_date)                  AS oldest_snapshot,
    MAX(s.create_date)                  AS newest_snapshot
FROM sys.databases d
LEFT JOIN sys.databases s ON s.source_database_id = d.database_id
WHERE s.source_database_id IS NOT NULL
GROUP BY d.name
ORDER BY d.name;
```

---

## Common Patterns

### Pre-deployment safety net

```sql
-- 1. Take snapshot before applying changes
CREATE DATABASE AppDB_SS_preupgrade
ON (NAME = AppDB_Data, FILENAME = 'D:\Snapshots\AppDB_preupgrade.ss')
AS SNAPSHOT OF AppDB;
GO

-- 2. Apply schema changes / data migrations
USE AppDB;
-- ... run upgrade scripts ...

-- 3a. If upgrade succeeded: drop snapshot
DROP DATABASE AppDB_SS_preupgrade;

-- 3b. If upgrade failed: revert
ALTER DATABASE AppDB SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE AppDB FROM DATABASE_SNAPSHOT = 'AppDB_SS_preupgrade';
ALTER DATABASE AppDB SET MULTI_USER;
DROP DATABASE AppDB_SS_preupgrade;  -- must drop after revert
```

### Consistent reporting copy (daily refresh)

```sql
-- Run via SQL Agent daily job
DECLARE @snap_name NVARCHAR(128) = 'ReportDB_SS_' + CONVERT(CHAR(8), GETDATE(), 112);
DECLARE @file_path NVARCHAR(512) = 'D:\Snapshots\ReportDB_' + CONVERT(CHAR(8), GETDATE(), 112) + '.ss';
DECLARE @sql NVARCHAR(MAX);

-- Drop yesterday's snapshot (find by naming convention)
SELECT @sql = 'DROP DATABASE ' + QUOTENAME(name)
FROM sys.databases
WHERE source_database_id = DB_ID('ReportDB')
  AND name <> @snap_name;

IF @sql IS NOT NULL EXEC sp_executesql @sql;

-- Create today's snapshot
SET @sql = N'CREATE DATABASE ' + QUOTENAME(@snap_name)
    + N' ON (NAME = ReportDB_Data, FILENAME = ''' + @file_path + N''')'
    + N' AS SNAPSHOT OF ReportDB;';
EXEC sp_executesql @sql;
```

Point the reporting tool at the snapshot database instead of the OLTP source.

### Fast dev environment reset

```sql
-- Once: take a snapshot of a known-good dev database
CREATE DATABASE DevDB_SS_clean
ON (NAME = DevDB_Data, FILENAME = 'D:\Snapshots\DevDB_clean.ss')
AS SNAPSHOT OF DevDB;
GO

-- After each dev session: reset to clean state
ALTER DATABASE DevDB SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE DevDB FROM DATABASE_SNAPSHOT = 'DevDB_SS_clean';
ALTER DATABASE DevDB SET MULTI_USER;
```

> [!NOTE] Snapshot lifespan for dev reset
> The "clean" snapshot grows over time as the dev database accumulates changes. For an active dev database, the snapshot may grow very large if kept for weeks. Drop and recreate the snapshot periodically (e.g., after each sprint reset) to keep disk usage manageable.

### CHECKDB without production I/O

```sql
-- Create snapshot at a low-traffic time
CREATE DATABASE AdventureWorks_SS_checkdb
ON (NAME = AdventureWorks_Data, FILENAME = 'D:\Snapshots\AW_checkdb.ss')
AS SNAPSHOT OF AdventureWorks;
GO

-- Run CHECKDB against the snapshot — reads go to snapshot, not source
DBCC CHECKDB (AdventureWorks_SS_checkdb) WITH NO_INFOMSGS, ALL_ERRORMSGS;
GO

-- Drop when done
DROP DATABASE AdventureWorks_SS_checkdb;
GO
```

---

## Limitations

| Limitation | Detail |
|---|---|
| Read-only | No DML or DDL against the snapshot |
| NTFS/supported FS required | Sparse files need NTFS on Windows, ext4/XFS on Linux |
| No backup of snapshots | `BACKUP DATABASE` against a snapshot fails |
| No detach/attach | Cannot detach a snapshot |
| No log files | Snapshots do not include transaction log |
| Maximum one revert source | Only one snapshot can exist at revert time |
| Primary replica only (AG) | Cannot create on readable secondaries |
| No Azure SQL Database | Not supported (Azure SQL Managed Instance: yes) |
| Source dependency | Snapshot fails if source database is unavailable |
| FILESTREAM databases | Not supported if source has FILESTREAM filegroups |
| Memory-optimized filegroups | Not supported if source has In-Memory OLTP data |
| Mirroring (deprecated) | Source database in a mirroring partnership supports snapshots only on the principal |
| Full-text indexes | Included in snapshot but cannot be updated |

> [!WARNING] Azure SQL Database
> Database snapshots are not available in Azure SQL Database (the PaaS offering). Use Azure SQL Database's built-in geo-redundant backups, point-in-time restore, or temporal tables instead. Azure SQL Managed Instance supports snapshots.

---

## Gotchas

1. **Snapshots grow silently.** A snapshot on a busy OLTP database can consume hundreds of GBs within hours. Monitor disk space and set alerts; there is no automatic size limit — the snapshot will exhaust all available disk space and then fail with I/O errors on the source database if the volume fills up.

2. **A full volume kills both source and snapshot.** If the snapshot sparse file and the source database files share a volume and that volume fills up, the source database will throw I/O errors. Put snapshot files on a **separate volume** from source data files.

3. **Reverting breaks the log backup chain.** After `RESTORE DATABASE ... FROM DATABASE_SNAPSHOT`, the LSN chain is invalid. Take a full backup immediately before re-enabling log backup jobs.

4. **Only one snapshot at revert time.** You must drop all other snapshots of the source before reverting. Plan your snapshot naming convention so you can identify which snapshots to clean up.

5. **FILESTREAM and In-Memory OLTP are unsupported.** `CREATE DATABASE ... AS SNAPSHOT OF` will fail with an error if the source has FILESTREAM or memory-optimized filegroups. This is a hard limitation — there is no workaround.

6. **No cross-instance snapshots.** A snapshot must reside on the same SQL Server instance as the source. You cannot use a snapshot as a remote read-only copy on a different server.

7. **CHECKDB auto-snapshot vs user snapshot.** When `DBCC CHECKDB` runs against the source database (not a named snapshot), SQL Server creates an internal snapshot internally. If there is insufficient disk space for the internal snapshot, CHECKDB falls back to locking-based consistency checks — potentially blocking writers. Pre-creating a user snapshot and targeting it gives you control over timing and disk usage.

8. **Snapshot create_date is in UTC server time.** Use `GETUTCDATE()` in snapshot naming scripts, or account for timezone when correlating snapshot creation times with application logs.

9. **sys.databases.source_database_id is the key.** This column is NULL for regular databases and non-NULL for snapshots. Filter on it in all queries that need to distinguish snapshots from regular databases.

10. **Snapshot read I/O depends on source database.** Snapshot readers may need to read unmodified pages from the source database. If the source database is offline or in a suspect state, snapshot reads of unmodified pages will fail. This is unlike a backup/restore copy which is fully independent.

11. **No statistics updates on snapshot.** Query plans against a snapshot are based on the snapshot's statistics (copied from the source at snapshot creation time). Old or stale statistics are not updated since the snapshot is read-only.

12. **Snapshots are not encrypted independently.** If TDE is enabled on the source, the snapshot inherits TDE. The snapshot uses the same DEK as the source — there is no way to apply different encryption to a snapshot.

---

## See Also

- [13-transactions-locking.md](13-transactions-locking.md) — snapshot isolation (SI) vs database snapshots (different features with similar names)
- [35-dbcc-commands.md](35-dbcc-commands.md) — DBCC CHECKDB internals and running against snapshots
- [43-high-availability.md](43-high-availability.md) — Always On AG and snapshot interaction
- [44-backup-restore.md](44-backup-restore.md) — backup strategy vs snapshot for recovery
- [17-temporal-tables.md](17-temporal-tables.md) — row-level time-travel alternative to snapshots

---

## Sources

[^1]: [Create a Database Snapshot (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/databases/create-a-database-snapshot-transact-sql) — covers `CREATE DATABASE ... AS SNAPSHOT OF` syntax, prerequisites, naming conventions, and sparse file mechanics
[^2]: [Revert a Database to a Database Snapshot - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/databases/revert-a-database-to-a-database-snapshot) — covers `RESTORE DATABASE FROM DATABASE_SNAPSHOT`, single-snapshot requirement, log chain implications, and AG constraints
[^3]: [Database Snapshots (SQL Server) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/databases/database-snapshots-sql-server) — overview of snapshot mechanics, limitations (FILESTREAM, memory-optimized filegroups, Azure SQL Database), disk space, and offline filegroups
[^4]: [DBCC CHECKDB (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-checkdb-transact-sql) — covers DBCC CHECKDB behavior with internal and user-created database snapshots, including sparse file creation and fallback locking

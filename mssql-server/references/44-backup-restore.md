# 44 — Backup and Restore

## Table of Contents

1. [When to Use This Reference](#1-when-to-use-this-reference)
2. [Backup Types Overview](#2-backup-types-overview)
3. [BACKUP Syntax](#3-backup-syntax)
4. [Backup Chain and Recovery Models](#4-backup-chain-and-recovery-models)
5. [Transaction Log Backups](#5-transaction-log-backups)
6. [Differential Backups](#6-differential-backups)
7. [COPY_ONLY Backups](#7-copy_only-backups)
8. [Backup to Multiple Files and Striping](#8-backup-to-multiple-files-and-striping)
9. [Backup Encryption](#9-backup-encryption)
10. [S3-Compatible Object Storage (2022+)](#10-s3-compatible-object-storage-2022)
11. [Backup to Azure Blob Storage](#11-backup-to-azure-blob-storage)
12. [RESTORE Syntax](#12-restore-syntax)
13. [RESTORE WITH NORECOVERY vs RECOVERY vs STANDBY](#13-restore-with-norecovery-vs-recovery-vs-standby)
14. [Point-in-Time Restore](#14-point-in-time-restore)
15. [Tail-Log Backup](#15-tail-log-backup)
16. [Piecemeal Restore](#16-piecemeal-restore)
17. [DBCC CHECKDB Against a Backup](#17-dbcc-checkdb-against-a-backup)
18. [Backup Verification (RESTORE VERIFYONLY)](#18-backup-verification-restore-verifyonly)
19. [Backup Compression](#19-backup-compression)
20. [Backup Metadata Queries](#20-backup-metadata-queries)
21. [Ola Hallengren Maintenance Solution](#21-ola-hallengren-maintenance-solution)
22. [Azure SQL Backup Differences](#22-azure-sql-backup-differences)
23. [Common Patterns and Runbooks](#23-common-patterns-and-runbooks)
24. [Gotchas and Anti-Patterns](#24-gotchas-and-anti-patterns)
25. [See Also](#25-see-also)
26. [Sources](#26-sources)

---

## 1. When to Use This Reference

Use this file when working with:

- `BACKUP DATABASE` / `BACKUP LOG` syntax
- Full / differential / transaction log backup chains
- Backup encryption, backup compression, striped backups
- `RESTORE DATABASE` / `RESTORE LOG` workflows
- Point-in-time recovery (PITR)
- Tail-log backup before failover
- S3-compatible object storage backups (SQL Server 2022+)
- Azure Blob Storage backups (URL backups)
- Verifying backup integrity (`RESTORE VERIFYONLY`, `DBCC CHECKDB` on a restored copy)
- Backup metadata queries against `msdb`

---

## 2. Backup Types Overview

| Backup Type | T-SQL Keyword | Requires FULL Recovery | Description |
|---|---|---|---|
| Full | `BACKUP DATABASE` | No | Complete copy of all data pages + active log tail |
| Differential | `BACKUP DATABASE ... DIFFERENTIAL` | No | All extents changed since last **full** backup |
| Transaction log | `BACKUP LOG` | Yes (FULL or BULK_LOGGED) | Log records since last log backup; truncates backed-up VLFs |
| File/filegroup | `BACKUP DATABASE ... FILE=` | No (see piecemeal) | Subset of data files |
| Partial | `BACKUP DATABASE ... READ_WRITE_FILEGROUPS` | No | All read-write filegroups only |
| Copy-only | `BACKUP DATABASE/LOG ... WITH COPY_ONLY` | No | Doesn't disturb the differential base or log chain |
| Tail-log | `BACKUP LOG ... WITH NORECOVERY` | Yes | Last logs before an unplanned restore |

**Recovery models summary:**

| Model | Log Backups | Log Truncation | Point-in-Time Restore | Typical Use |
|---|---|---|---|---|
| SIMPLE | Not possible | Checkpoint | No (full + diff only) | Dev, non-critical |
| FULL | Required to truncate | Log backup | Yes | Production |
| BULK_LOGGED | Required | Log backup | No for bulk-logged intervals | Bulk ETL loads |

> [!WARNING] Deprecated
> The `BULK_LOGGED` model protects you during large imports but prevents PITR for any interval that includes minimally logged operations. Switch back to FULL immediately after the bulk load and take a log backup.

---

## 3. BACKUP Syntax

### Full database backup

```sql
-- Minimum viable backup
BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AdventureWorks2022_full.bak'
WITH
    COMPRESSION,
    CHECKSUM,           -- validates each page; detects torn pages at backup time
    STATS = 10;         -- progress every 10%
```

### Differential backup

```sql
BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AdventureWorks2022_diff.bak'
WITH
    DIFFERENTIAL,
    COMPRESSION,
    CHECKSUM,
    STATS = 10;
```

### Transaction log backup

```sql
BACKUP LOG AdventureWorks2022
TO DISK = 'D:\Backups\AdventureWorks2022_log_20260317_0100.bak'
WITH
    COMPRESSION,
    CHECKSUM,
    STATS = 10;
```

### Multiple backup files (init vs noinit)

```sql
-- Default is NOINIT — appends to file. INIT overwrites.
BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AW_full.bak'
WITH COMPRESSION, CHECKSUM, INIT;   -- recommended: always use INIT for scheduled jobs

-- NOINIT appends: one file may hold many backups (a "backup family set").
-- Requires RESTORE HEADERONLY to enumerate them.
```

---

## 4. Backup Chain and Recovery Models

A **backup chain** is the set of full + differential + log backups needed to reach a target recovery point:

```
Full (Sunday)
  ├─ Diff (Monday)
  ├─ Diff (Tuesday)   ← restore this if recovering to Wednesday midnight
  └─ Log every 15 min (Mon–Wed)
```

**Rules:**
- A differential is based on the most recent **full backup** only (not another diff).
- Each log backup covers records since the **previous log backup** (or since the full if no log backup has been taken).
- Restoring a diff means you need: the full, then **only that diff** (not all intermediate diffs), then all logs taken after that diff.
- Switching from SIMPLE to FULL does **not** start the log chain — you must take a full backup first, then the first log backup after that starts the chain.

### Verify current recovery model

```sql
SELECT name, recovery_model_desc, log_reuse_wait_desc
FROM sys.databases
WHERE name = 'AdventureWorks2022';
```

`log_reuse_wait_desc` of `LOG_BACKUP` means logs cannot be truncated until a log backup is taken.

---

## 5. Transaction Log Backups

Log backups are **mandatory** in FULL recovery model to prevent log file growth.

```sql
-- Minimal log backup (scheduled job, e.g., every 15 minutes)
BACKUP LOG AdventureWorks2022
TO DISK = 'D:\LogBackups\AW_log_'
        + REPLACE(CONVERT(VARCHAR(20), GETDATE(), 120), ':', '') + '.bak'
WITH COMPRESSION, CHECKSUM, INIT;
```

> [!WARNING] SIMPLE recovery trap
> Running `BACKUP LOG` against a SIMPLE-mode database raises error 4214. If you think you're in FULL but log growth is unchecked, check `log_reuse_wait_desc` — if it says `CHECKPOINT` you are in SIMPLE.

### Tail-log backup (before intentional restore)

See [Section 15](#15-tail-log-backup).

### Log chain continuity

Each log backup header records `first_lsn` and `last_lsn`. A gap in LSN continuity means the chain is broken — RESTORE will fail with error 4326. Common causes:

- Accidental `BACKUP LOG ... WITH NO_LOG` (removed in SQL 2012; historical issue)
- Switching to SIMPLE mode and back without taking a full backup after returning to FULL
- Backup taken on different server without accounting for LSNs

---

## 6. Differential Backups

A differential backup records all **dirty extents** since the **differential base** (the last full backup). The differential base LSN is stored in `msdb.dbo.backupset.differential_base_lsn`.

### Size grows across the week

```
Monday diff:   only Monday's changes (small)
Tuesday diff:  Monday + Tuesday changes (medium)
Wednesday diff: Monday + Tuesday + Wednesday changes (larger)
```

Each successive diff is larger unless you take a new full backup to reset the base.

### Restore sequence with a differential

```sql
-- Step 1: restore full, do not recover yet
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_full.bak'
WITH NORECOVERY, REPLACE, STATS = 10;

-- Step 2: restore the most recent differential, do not recover
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_diff_tuesday.bak'
WITH NORECOVERY, STATS = 10;

-- Step 3: restore each log backup in sequence
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log_20260317_0000.bak'
WITH NORECOVERY;

-- ... repeat for each log ...

-- Step 4: recover the database
RESTORE DATABASE AdventureWorks2022 WITH RECOVERY;
```

---

## 7. COPY_ONLY Backups

A `COPY_ONLY` full backup does **not** reset the differential base LSN. A `COPY_ONLY` log backup does **not** truncate the log or break the log chain.

Use cases:
- Developer needs a production copy without disturbing scheduled backups
- Pre-deployment safety snapshot (see also: [database snapshots](42-database-snapshots.md))
- Backup for migration to a new server

```sql
BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AW_copy_only.bak'
WITH COPY_ONLY, COMPRESSION, CHECKSUM;

-- Copy-only log (does not affect log chain position)
BACKUP LOG AdventureWorks2022
TO DISK = 'D:\Backups\AW_log_copy_only.bak'
WITH COPY_ONLY, COMPRESSION, CHECKSUM;
```

---

## 8. Backup to Multiple Files and Striping

Striping splits a backup across multiple files written in parallel — improves throughput when disk or network I/O is the bottleneck:

```sql
-- Stripe backup across 4 files
BACKUP DATABASE AdventureWorks2022
TO
    DISK = 'D:\Backups\AW_stripe1.bak',
    DISK = 'E:\Backups\AW_stripe2.bak',
    DISK = 'F:\Backups\AW_stripe3.bak',
    DISK = 'G:\Backups\AW_stripe4.bak'
WITH COMPRESSION, CHECKSUM, INIT, STATS = 10;

-- Restore must reference ALL stripe files
RESTORE DATABASE AdventureWorks2022
FROM
    DISK = 'D:\Backups\AW_stripe1.bak',
    DISK = 'E:\Backups\AW_stripe2.bak',
    DISK = 'F:\Backups\AW_stripe3.bak',
    DISK = 'G:\Backups\AW_stripe4.bak'
WITH NORECOVERY, STATS = 10;
```

> [!NOTE]
> All stripe files must be present and intact to restore. Losing any one stripe file makes the entire backup set unrestorable. Mirror the stripe set (`MIRROR TO`) if individual file loss is a risk.

---

## 9. Backup Encryption

Backup encryption requires a **certificate** or **asymmetric key** in the `master` database (or a service-managed key for cloud backups). It is independent of TDE — a non-TDE database can have encrypted backups.

```sql
-- Step 1: create a master key in master if not present
USE master;
CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'StrongPassw0rd!';

-- Step 2: create a certificate for backup encryption
CREATE CERTIFICATE BackupEncryptCert
WITH SUBJECT = 'Backup Encryption Certificate',
     EXPIRY_DATE = '2030-01-01';

-- Step 3: back up the certificate (CRITICAL — without this you cannot restore)
BACKUP CERTIFICATE BackupEncryptCert
TO FILE = 'D:\Certs\BackupEncryptCert.cer'
WITH PRIVATE KEY (
    FILE = 'D:\Certs\BackupEncryptCert.pvk',
    ENCRYPTION BY PASSWORD = 'CertKeyPassw0rd!'
);

-- Step 4: encrypted backup
BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AW_encrypted.bak'
WITH
    COMPRESSION,
    CHECKSUM,
    ENCRYPTION (
        ALGORITHM = AES_256,
        SERVER CERTIFICATE = BackupEncryptCert
    );
```

> [!WARNING]
> The certificate used to encrypt a backup **must be restored to the target server before the database can be restored**. If you lose the certificate, the backup is permanently unreadable. Store certificate backups offsite and separately from the database backup.

---

## 10. S3-Compatible Object Storage (2022+)

> [!NOTE] SQL Server 2022
> SQL Server 2022 adds native backup/restore to S3-compatible object storage (MinIO, AWS S3, Pure FlashBlade, etc.) via the `S3` connector. No Azure dependency required.

```sql
-- Step 1: create a credential with S3 access key
CREATE CREDENTIAL [s3://my-bucket-endpoint/backups]
WITH
    IDENTITY = 'S3 Access Key',
    SECRET = 'ACCESSKEYID:SECRETACCESSKEY';  -- colon-delimited

-- Step 2: backup to S3 URL
BACKUP DATABASE AdventureWorks2022
TO URL = 's3://my-s3-host:9000/sql-backups/AW_full.bak'
WITH
    COMPRESSION,
    CHECKSUM,
    ENCRYPTION (ALGORITHM = AES_256, SERVER CERTIFICATE = BackupEncryptCert),
    STATS = 10;

-- Step 3: restore from S3
RESTORE DATABASE AdventureWorks2022
FROM URL = 's3://my-s3-host:9000/sql-backups/AW_full.bak'
WITH
    MOVE 'AdventureWorks2022' TO 'D:\Data\AW.mdf',
    MOVE 'AdventureWorks2022_log' TO 'D:\Log\AW_log.ldf',
    RECOVERY, STATS = 10;
```

**S3 requirements:**
- TLS/HTTPS on the S3 endpoint (or `WITH NO_CHECKSUM` + no encryption for plain HTTP — not recommended for production)
- Max object size per stripe part is 200 MB; SQL Server automatically stripes large backups into parts
- Credential name must exactly match the URL prefix (case-sensitive)

---

## 11. Backup to Azure Blob Storage

Backup to Azure Blob uses a **SAS token credential** or a **storage account key credential**:

```sql
-- Using a Shared Access Signature (recommended)
CREATE CREDENTIAL [https://mystorageacct.blob.core.windows.net/sql-backups]
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
     SECRET = 'sv=2023-...&sig=...';  -- SAS token without leading '?'

BACKUP DATABASE AdventureWorks2022
TO URL = 'https://mystorageacct.blob.core.windows.net/sql-backups/AW_full.bak'
WITH COMPRESSION, CHECKSUM, STATS = 10;
```

**Managed backup (automated):**

```sql
-- Enable Azure Blob managed backup (SQL Server 2014+)
EXEC msdb.managed_backup.sp_backup_config_basic
    @database_name = 'AdventureWorks2022',
    @container_url = 'https://mystorageacct.blob.core.windows.net/sql-backups',
    @retention_days = 30;
```

---

## 12. RESTORE Syntax

### File/path inspection before restoring

```sql
-- Inspect backup header (backup sets in file)
RESTORE HEADERONLY FROM DISK = 'D:\Backups\AW_full.bak';

-- Inspect file list (logical and physical file names)
RESTORE FILELISTONLY FROM DISK = 'D:\Backups\AW_full.bak';

-- Inspect backup label (media set info)
RESTORE LABELONLY FROM DISK = 'D:\Backups\AW_full.bak';
```

### Full restore with file move

```sql
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_full.bak'
WITH
    MOVE 'AdventureWorks2022'     TO 'D:\Data\AW2022.mdf',
    MOVE 'AdventureWorks2022_log' TO 'E:\Log\AW2022_log.ldf',
    REPLACE,        -- overwrite existing database
    RECOVERY,       -- bring online immediately (use NORECOVERY if applying more backups)
    STATS = 10;
```

### Restoring a specific backup set from a multi-set file

```sql
-- Backup set 3 in a NOINIT file
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\multi_backups.bak'
WITH FILE = 3, NORECOVERY, STATS = 10;
```

---

## 13. RESTORE WITH NORECOVERY vs RECOVERY vs STANDBY

| Option | Database State After | Apply More Backups? | User Connections? | Use Case |
|---|---|---|---|---|
| `RECOVERY` | Online | No | Yes | Final step; bring database online |
| `NORECOVERY` | Restoring | Yes | No | Intermediate step; more backups to apply |
| `STANDBY = 'undo.bak'` | Standby (read-only) | Yes (after taking offline) | Read-only only | Log shipping warm standby; check data between log restores |

```sql
-- STANDBY: allows read queries between log restores
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log_0100.bak'
WITH STANDBY = 'D:\Standby\AW_undo.bak';

-- Query the standby database here...

-- Apply next log (must be in restoring state first — STANDBY handles this automatically)
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log_0115.bak'
WITH STANDBY = 'D:\Standby\AW_undo.bak';

-- Final recovery
RESTORE DATABASE AdventureWorks2022 WITH RECOVERY;
```

> [!NOTE]
> The `STANDBY` undo file (`AW_undo.bak`) holds rolled-back uncommitted transactions. It must not be deleted between log restores. Its size grows with the active transaction volume at log restore time.

---

## 14. Point-in-Time Restore

PITR requires: FULL recovery model, a complete backup chain (full + optional diff + logs), and the target time falling within a backed-up log interval.

```sql
-- Full restore chain to a specific point in time (e.g., just before an accidental delete)

-- 1. Restore full backup
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_full_20260316.bak'
WITH NORECOVERY, MOVE 'AdventureWorks2022' TO 'D:\Data\AW.mdf',
     MOVE 'AdventureWorks2022_log' TO 'E:\Log\AW.ldf', REPLACE;

-- 2. Restore differential (skip if none between full and target)
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_diff_20260316_2200.bak'
WITH NORECOVERY;

-- 3. Restore log backups, stopping at the target time on the last one
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log_20260317_0000.bak'
WITH NORECOVERY;

RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log_20260317_0015.bak'
WITH NORECOVERY;

-- Target time: stop at 00:23:10 on March 17
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log_20260317_0030.bak'
WITH STOPAT = '2026-03-17T00:23:10', RECOVERY;
```

**STOPAT behavior:**
- RESTORE stops applying log records at the specified time and recovers the database
- If the target time is before the first LSN in the log backup, the restore fails — you need an earlier backup
- Times are in the server's local timezone unless you use `STOPATMARK` with an LSN

### LSN-based PITR

```sql
-- Stop at a specific LSN (more precise than time)
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log.bak'
WITH STOPATMARK = 'lsn:0000000025000000100000001',
     RECOVERY;
```

---

## 15. Tail-Log Backup

A tail-log backup captures log records that have not yet been backed up, preserving transactions written since the last log backup. Required before:

- Failing over to a secondary in a log shipping setup
- Performing a manual restore over a live database when you want to minimize data loss

```sql
-- Tail-log backup: WITH NORECOVERY takes the source database offline
-- and prevents new transactions during the restore process
BACKUP LOG AdventureWorks2022
TO DISK = 'D:\LogBackups\AW_taillog.bak'
WITH NORECOVERY,  -- database goes into restoring state after this
     COMPRESSION,
     CHECKSUM,
     STATS = 5;

-- If the database is inaccessible (corruption, disk failure), use NO_TRUNCATE
BACKUP LOG AdventureWorks2022
TO DISK = 'D:\LogBackups\AW_taillog.bak'
WITH NO_TRUNCATE,  -- backs up log even if data files are inaccessible
     COMPRESSION,
     CHECKSUM;
```

> [!WARNING]
> `WITH NORECOVERY` in a tail-log backup takes the **source database offline**. Use this only when you are committed to the restore. If you need a tail-log backup without taking the source offline (e.g., for AG failover setup), use `WITH NO_TRUNCATE` instead.

---

## 16. Piecemeal Restore

Piecemeal restore allows bringing a database partially online by restoring filegroups individually. The PRIMARY filegroup must be restored first.

```sql
-- Step 1: restore primary filegroup first
RESTORE DATABASE AdventureWorks2022
FILEGROUP = 'PRIMARY'
FROM DISK = 'D:\Backups\AW_full.bak'
WITH PARTIAL, NORECOVERY;

-- Step 2: restore and recover primary (database is partially online)
RESTORE DATABASE AdventureWorks2022 WITH RECOVERY;

-- Step 3: restore secondary filegroups online (database remains accessible)
RESTORE DATABASE AdventureWorks2022
FILEGROUP = 'FG_Historical'
FROM DISK = 'D:\Backups\AW_full.bak'
WITH NORECOVERY;

RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_log.bak'
WITH RECOVERY;
```

Piecemeal restore is most useful for very large databases where RTO must be minimized — users can access the primary filegroup while history filegroups restore in the background.

---

## 17. DBCC CHECKDB Against a Backup

The safest way to verify a backup's integrity is to **restore it to a test server or database snapshot and run CHECKDB**. This detects both:

1. Backup file corruption (caught by `RESTORE VERIFYONLY` with `CHECKSUM` — see next section)
2. Logical data corruption that made it into the backup

```sql
-- Restore backup to a temporary database
RESTORE DATABASE AdventureWorks2022_CheckCopy
FROM DISK = 'D:\Backups\AW_full.bak'
WITH
    MOVE 'AdventureWorks2022'     TO 'D:\Data\AW_check.mdf',
    MOVE 'AdventureWorks2022_log' TO 'E:\Log\AW_check_log.ldf',
    RECOVERY;

-- Run CHECKDB — use PHYSICAL_ONLY for speed, full check for thoroughness
DBCC CHECKDB (AdventureWorks2022_CheckCopy) WITH NO_INFOMSGS, ALL_ERRORMSGS;

-- Drop the check copy when done
DROP DATABASE AdventureWorks2022_CheckCopy;
```

Run this process weekly (at minimum) using an offsite or DR server to avoid production I/O impact. See [35-dbcc-commands.md](35-dbcc-commands.md) for full CHECKDB reference.

---

## 18. Backup Verification (RESTORE VERIFYONLY)

`RESTORE VERIFYONLY` reads the backup file and verifies the header and (if backed up with CHECKSUM) each page checksum. It does **not** restore the database.

```sql
-- Verify backup integrity (reads entire file)
RESTORE VERIFYONLY
FROM DISK = 'D:\Backups\AW_full.bak'
WITH CHECKSUM;   -- validates page checksums if backup was taken WITH CHECKSUM
```

**What VERIFYONLY catches:**
- Truncated backup file
- Bad block on backup media
- Header corruption
- Page checksum failures (only if backup was written `WITH CHECKSUM`)

**What VERIFYONLY does NOT catch:**
- Logical corruption (corrupted data that has valid checksums)
- Missing files from a striped backup set
- Corruption that existed in the source database before backup

> [!WARNING]
> `RESTORE VERIFYONLY` is not a substitute for periodically doing a full test restore and CHECKDB. It only validates the backup file itself, not the data quality inside it.

---

## 19. Backup Compression

Backup compression is enabled at the server level or per-statement:

```sql
-- Enable compression by default (SQL Server 2008+ Enterprise; 2008 R2+ Standard)
EXEC sp_configure 'backup compression default', 1;
RECONFIGURE;

-- Per-backup override
BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AW.bak'
WITH COMPRESSION;           -- explicit compression

BACKUP DATABASE AdventureWorks2022
TO DISK = 'D:\Backups\AW_nocomp.bak'
WITH NO_COMPRESSION;        -- explicit no compression (overrides default)
```

**Compression rationale:**
- Typical SQL Server data compresses 3:1 to 10:1 with backup compression
- Backup compression and TDE interact poorly — TDE-encrypted pages are effectively random bytes and compress minimally. Consider encrypting the backup file instead of (or in addition to) TDE
- CPU overhead is moderate (10–20% extra CPU); usually worth it on I/O-bound systems

> [!NOTE] SQL Server 2022
> Backup compression now supports an integrated encryption option via `ENCRYPTION (ALGORITHM = AES_256, ...)` in the same `BACKUP` statement, replacing the separate step of encrypting after compression.

---

## 20. Backup Metadata Queries

### Last successful backup per database

```sql
SELECT
    d.name                              AS database_name,
    d.recovery_model_desc,
    MAX(CASE WHEN bs.type = 'D' THEN bs.backup_finish_date END) AS last_full,
    MAX(CASE WHEN bs.type = 'I' THEN bs.backup_finish_date END) AS last_diff,
    MAX(CASE WHEN bs.type = 'L' THEN bs.backup_finish_date END) AS last_log
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset bs
    ON bs.database_name = d.name
    AND bs.backup_finish_date > DATEADD(DAY, -7, GETDATE())
WHERE d.database_id > 4   -- exclude system databases
GROUP BY d.name, d.recovery_model_desc
ORDER BY last_full DESC;
```

### Databases with no recent full backup (alert query)

```sql
SELECT d.name AS database_name, d.recovery_model_desc,
       MAX(bs.backup_finish_date) AS last_full_backup
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset bs
    ON bs.database_name = d.name AND bs.type = 'D'
WHERE d.database_id > 4
  AND d.state_desc = 'ONLINE'
GROUP BY d.name, d.recovery_model_desc
HAVING MAX(bs.backup_finish_date) < DATEADD(DAY, -1, GETDATE())
   OR  MAX(bs.backup_finish_date) IS NULL
ORDER BY last_full_backup ASC;
```

### Backup history with sizes and durations

```sql
SELECT TOP 100
    bs.database_name,
    bs.type,
    bs.backup_start_date,
    bs.backup_finish_date,
    DATEDIFF(SECOND, bs.backup_start_date, bs.backup_finish_date) AS duration_sec,
    CAST(bs.backup_size / 1024.0 / 1024.0 AS DECIMAL(10,2))          AS backup_size_mb,
    CAST(bs.compressed_backup_size / 1024.0 / 1024.0 AS DECIMAL(10,2)) AS compressed_mb,
    bmf.physical_device_name
FROM msdb.dbo.backupset bs
JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
WHERE bs.database_name = 'AdventureWorks2022'
ORDER BY bs.backup_start_date DESC;
```

### Find the restore sequence for a target time

```sql
-- Find which backups are needed to restore to a specific time
DECLARE @TargetDB   NVARCHAR(128) = 'AdventureWorks2022';
DECLARE @TargetTime DATETIME      = '2026-03-17T00:23:10';

-- Last full before target time
SELECT TOP 1 bs.backup_set_id, bs.type, bs.backup_start_date,
             bs.backup_finish_date, bmf.physical_device_name
FROM msdb.dbo.backupset bs
JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
WHERE bs.database_name = @TargetDB
  AND bs.type = 'D'
  AND bs.backup_finish_date <= @TargetTime
ORDER BY bs.backup_finish_date DESC;
```

---

## 21. Ola Hallengren Maintenance Solution

The [Ola Hallengren SQL Server Maintenance Solution](https://ola.hallengren.com) is the de-facto standard for scheduling backups via SQL Agent. It supports:

- Full / differential / log backups with configurable retention
- Backup verification (RESTORE VERIFYONLY) as a separate step
- Backup to disk, URL (Azure), or network share
- Compression and encryption parameters
- Output logging

```sql
-- Example: full backup of all user databases
EXECUTE dbo.DatabaseBackup
    @Databases = 'USER_DATABASES',
    @Directory = 'D:\Backups',
    @BackupType = 'FULL',
    @Compress = 'Y',
    @CheckSum = 'Y',
    @CleanupTime = 72;   -- remove files older than 72 hours

-- Log backup
EXECUTE dbo.DatabaseBackup
    @Databases = 'USER_DATABASES',
    @Directory = 'D:\LogBackups',
    @BackupType = 'LOG',
    @Compress = 'Y',
    @CheckSum = 'Y',
    @CleanupTime = 24;
```

---

## 22. Azure SQL Backup Differences

| Feature | Azure SQL Database | Azure SQL Managed Instance | SQL Server on-prem |
|---|---|---|---|
| Backup control | Automatic (Microsoft managed) | Semi-automatic + manual | Fully manual |
| Full backup frequency | Weekly | Weekly | Scheduled by DBA |
| Differential frequency | Every 12–24 hours | Every 12 hours | Scheduled by DBA |
| Log backup frequency | Every 5–10 minutes | Every 5–15 minutes | Scheduled by DBA |
| PITR retention | 1–35 days (configurable) | 0–35 days | Depends on storage |
| Long-term retention (LTR) | Yes (Azure Blob, up to 10 years) | Yes | Manual archive |
| BACKUP DATABASE T-SQL | Not supported | Supported | Supported |
| `RESTORE DATABASE` T-SQL | Not supported (use portal/PowerShell) | Supported | Supported |
| Backup encryption | Transparent (managed) | Transparent + manual | Manual (cert/key) |
| Copy-only backup | Not supported directly | Supported | Supported |

> [!NOTE] Azure SQL Database
> You cannot run `BACKUP DATABASE` or `RESTORE DATABASE` on Azure SQL Database. PITR and geo-restore are performed through the Azure portal, Azure CLI, or PowerShell. Export to BACPAC (`sqlpackage /Action:Export`) is the closest equivalent for logical backups.

---

## 23. Common Patterns and Runbooks

### Pattern 1: Scripted full restore with point-in-time recovery

```sql
-- Identify latest full + differential + logs covering target time
-- (query msdb as shown in Section 20, then build the restore chain)

RESTORE DATABASE AdventureWorks2022_Recovered
FROM DISK = 'D:\Backups\AW_full_20260316.bak'
WITH
    MOVE 'AdventureWorks2022' TO 'D:\Data\AW_recovered.mdf',
    MOVE 'AdventureWorks2022_log' TO 'E:\Log\AW_recovered.ldf',
    NORECOVERY, REPLACE, STATS = 10;

RESTORE DATABASE AdventureWorks2022_Recovered
FROM DISK = 'D:\Backups\AW_diff_20260316.bak'
WITH NORECOVERY, STATS = 10;

-- Apply logs up to (but not including) last one
RESTORE LOG AdventureWorks2022_Recovered
FROM DISK = 'D:\LogBackups\AW_log_0000.bak'
WITH NORECOVERY;

-- Apply last log with STOPAT
RESTORE LOG AdventureWorks2022_Recovered
FROM DISK = 'D:\LogBackups\AW_log_0015.bak'
WITH STOPAT = '2026-03-17T00:23:10', RECOVERY;
```

### Pattern 2: Test restore script (run weekly to validate backups)

```sql
-- Run on a non-production server or with a different database name
RESTORE DATABASE AdventureWorks2022_Test
FROM DISK = 'D:\Backups\AW_full_latest.bak'
WITH
    MOVE 'AdventureWorks2022' TO 'D:\TestData\AW_test.mdf',
    MOVE 'AdventureWorks2022_log' TO 'D:\TestLog\AW_test.ldf',
    RECOVERY, REPLACE, STATS = 10;

-- Verify data integrity
DBCC CHECKDB (AdventureWorks2022_Test) WITH NO_INFOMSGS, ALL_ERRORMSGS;

-- Check row counts against known-good values
SELECT COUNT(*) FROM AdventureWorks2022_Test.Person.Person;

-- Clean up
DROP DATABASE AdventureWorks2022_Test;

-- Log result to a monitoring table
INSERT INTO DBA.dbo.BackupTestResults (TestDate, DatabaseName, Result)
VALUES (GETDATE(), 'AdventureWorks2022', 'PASS');
```

### Pattern 3: Emergency restore from corrupted database

```sql
-- 1. Take tail-log backup if log files accessible
BACKUP LOG AdventureWorks2022
TO DISK = 'D:\LogBackups\AW_emergency_taillog.bak'
WITH NO_TRUNCATE, COMPRESSION, CHECKSUM;

-- 2. Restore full (last known good)
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_full_latest.bak'
WITH NORECOVERY, REPLACE;

-- 3. Apply latest differential
RESTORE DATABASE AdventureWorks2022
FROM DISK = 'D:\Backups\AW_diff_latest.bak'
WITH NORECOVERY;

-- 4. Apply all transaction log backups in order
-- (query msdb to enumerate them, then RESTORE LOG each)

-- 5. Apply tail-log backup
RESTORE LOG AdventureWorks2022
FROM DISK = 'D:\LogBackups\AW_emergency_taillog.bak'
WITH NORECOVERY;

-- 6. Recover
RESTORE DATABASE AdventureWorks2022 WITH RECOVERY;
```

### Pattern 4: Backup health monitoring query

```sql
-- Alert if any FULL recovery database has no log backup in last 60 minutes
SELECT d.name, d.recovery_model_desc,
       MAX(bs.backup_finish_date) AS last_log_backup,
       DATEDIFF(MINUTE, MAX(bs.backup_finish_date), GETDATE()) AS minutes_since_log
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset bs
    ON bs.database_name = d.name AND bs.type = 'L'
WHERE d.recovery_model_desc = 'FULL'
  AND d.database_id > 4
  AND d.state_desc = 'ONLINE'
GROUP BY d.name, d.recovery_model_desc
HAVING MAX(bs.backup_finish_date) < DATEADD(MINUTE, -60, GETDATE())
   OR  MAX(bs.backup_finish_date) IS NULL;
```

---

## 24. Gotchas and Anti-Patterns

1. **No CHECKSUM on backups.** Without `WITH CHECKSUM`, backup corruption may go undetected until a restore attempt. Always use `WITH CHECKSUM`.

2. **Never testing restores.** A backup that cannot be restored is not a backup. Test restores weekly; test DBCC CHECKDB on the restored copy monthly.

3. **Storing backups on the same volume as data files.** Disk failure that corrupts data files will likely also destroy backups. Store backups on a separate physical volume, NAS, or object storage.

4. **INIT vs NOINIT confusion.** `NOINIT` (default) appends to a file. File size grows indefinitely until the file is explicitly overwritten or deleted. Use `INIT` for production scheduled jobs unless you intentionally stack multiple backup sets per file.

5. **Forgot to back up the encryption certificate.** If you use backup encryption and lose the certificate, every encrypted backup is unrestorable. Back up the certificate immediately after creation, store it offsite, and document the private key password.

6. **Shrinking log file after taking a log backup and then not taking a new full.** After a log shrink, the LSN sequence is intact but the log file metadata shifts. The backup chain is valid but the first log applied after the shrink may be larger than expected due to VLF fragmentation. Avoid shrinking log files (see [35-dbcc-commands.md](35-dbcc-commands.md)).

7. **Assuming RESTORE VERIFYONLY is enough.** VERIFYONLY checks the backup file integrity, not the data. It won't catch data corruption that was present in the source database when the backup was taken.

8. **Missing tail-log backup before restore.** Restoring over a live database without first capturing the tail-log means losing all transactions since the last scheduled log backup. Always take a tail-log backup before an intentional restore.

9. **Forgetting REPLACE on restore.** If the target database already exists, `RESTORE DATABASE ... FROM ... WITH NORECOVERY` will fail with error 3154 unless `REPLACE` is specified. `REPLACE` is destructive — the existing database is overwritten.

10. **Restoring to a database with a different name without MOVE.** If the backup's logical file names conflict with files already on disk, the restore fails. Always use `RESTORE FILELISTONLY` first to identify logical file names, then specify `MOVE` for each.

11. **Log chain break from SIMPLE→FULL transition without a new full backup.** Changing the recovery model to FULL starts recording log records, but log backups cannot start the chain until after a full (or differential) backup is taken under FULL recovery. Take a full backup immediately after switching to FULL.

12. **S3 credential name case sensitivity.** The `CREATE CREDENTIAL` name must exactly match the URL prefix used in `BACKUP ... TO URL`. A trailing slash mismatch or case difference will cause the backup to fail with "no credential found."

---

## 25. See Also

- [35-dbcc-commands.md](35-dbcc-commands.md) — CHECKDB reference including running against restored copies
- [42-database-snapshots.md](42-database-snapshots.md) — Pre-change snapshots as a fast alternative to restore for short windows
- [43-high-availability.md](43-high-availability.md) — AG log chain and log shipping interactions with backup strategy
- [16-security-encryption.md](16-security-encryption.md) — TDE and Always Encrypted, which affect backup encryption behavior
- [49-configuration-tuning.md](49-configuration-tuning.md) — Backup compression default sp_configure setting

---

## Sources

[^1]: [SQL Server Backup, Integrity Check, Index and Statistics Maintenance](https://ola.hallengren.com) — Ola Hallengren's free maintenance solution; de-facto standard for scheduling SQL Server backups via SQL Agent
[^2]: [BACKUP (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/backup-transact-sql) — full T-SQL reference for the BACKUP statement including all WITH options, syntax, and examples
[^3]: [RESTORE (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-transact-sql) — full T-SQL reference for RESTORE statements including NORECOVERY, RECOVERY, STANDBY, STOPAT, and all WITH options
[^4]: [Back up and Restore of SQL Server Databases - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/back-up-and-restore-of-sql-server-databases) — conceptual overview of SQL Server backup and restore strategies, recovery models, and best practices
[^5]: [SQL Server back up to URL for S3-compatible object storage - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/sql-server-backup-to-url-s3-compatible-object-storage) — requirements and examples for backing up and restoring to S3-compatible object storage (SQL Server 2022+)
[^6]: [Back up and restore: System databases - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/back-up-and-restore-of-system-databases-sql-server) — guidance on backing up and restoring master, model, msdb, and other system databases
[^7]: [DBA Training Plan 2: Backups (And More Importantly, Restores)](https://www.brentozar.com/archive/2019/07/dba-training-plan-2-backups-and-more-importantly-restores/) — Brent Ozar's practical guide covering backup strategies, restore procedures with NORECOVERY, and why restores matter more than backups
[^8]: [Important Change to VLF Creation Algorithm in SQL Server 2014](https://www.sqlskills.com/blogs/paul/important-change-vlf-creation-algorithm-sql-server-2014/) — Paul Randal on VLF creation internals, the SQL Server 2014 algorithm improvement, and how excessive VLFs affect backups, restores, log clearing, and crash recovery

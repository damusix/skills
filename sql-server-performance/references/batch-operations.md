# Batch Operations


Patterns for writing high-throughput INSERT, UPDATE, and DELETE operations that do not bloat the transaction log or block other workloads.

## Table of Contents


- [Chunked DML](#chunked-dml)
- [Minimal Logging](#minimal-logging)
- [Partition Switching](#partition-switching)
- [Transaction Log Management](#transaction-log-management)
- [BULK INSERT Optimization](#bulk-insert-optimization)
- [See Also](#see-also)
- [Sources](#sources)

---

## Chunked DML


Any operation affecting more than ~10,000 rows should be broken into chunks. A single large UPDATE or DELETE:
- Generates a single large transaction — log space is reserved for the entire operation
- May escalate row locks to a table lock, blocking all readers and writers
- Blocks rollback for minutes if cancelled

The fix: `DELETE TOP (N)` or `UPDATE TOP (N)` in a WHILE loop. Each iteration is its own autocommitted transaction (one log record per iteration, not one for the whole table).

    -- Chunked DELETE pattern
    DECLARE @RowsAffected INT = 1;

    WHILE @RowsAffected > 0
    BEGIN
        DELETE TOP (5000) FROM dbo.AuditLog
        WHERE  LoggedAt < DATEADD(day, -90, SYSDATETIME());

        SET @RowsAffected = @@ROWCOUNT;
        -- Optional: yield to other workloads between iterations
        -- WAITFOR DELAY '00:00:00.100';
    END;

    -- Chunked UPDATE pattern
    DECLARE @Rows INT = 1;

    WHILE @Rows > 0
    BEGIN
        UPDATE TOP (5000) dbo.Notification
        SET    [Status] = 'Cancelled'
        WHERE  [Status] = 'Pending'
          AND  ScheduledFor < DATEADD(day, -30, SYSDATETIME());

        SET @Rows = @@ROWCOUNT;
    END;

**Choosing chunk size:**
- Start at 5,000 rows — large enough for efficiency, small enough to avoid lock escalation (SQL Server escalates when a single statement acquires ≥ 5,000 locks on one object)
- If the table has many indexes, reduce chunk size proportionally — each modified row acquires one lock per index, so a table with 5 NCIs effectively hits the threshold at ~1,000 rows
- Monitor `WRITELOG` wait times to determine if log I/O is the bottleneck; reduce chunk size if needed

**Explicit transaction for atomicity-within-chunks:**

When each chunk must either fully commit or fully roll back (e.g., paired INSERT + DELETE):

    DECLARE @Rows INT = 1;

    WHILE @Rows > 0
    BEGIN
        BEGIN TRANSACTION;
            INSERT INTO dbo.OrderArchive (OrderID, CustomerID, TotalAmt, OrderDate)
            SELECT TOP (5000) OrderID, CustomerID, TotalAmt, OrderDate
            FROM   dbo.Orders
            WHERE  OrderDate < DATEADD(year, -7, SYSDATETIME());

            SET @Rows = @@ROWCOUNT;

            DELETE dbo.Orders
            WHERE  OrderID IN (
                SELECT TOP (5000) OrderID
                FROM   dbo.Orders
                WHERE  OrderDate < DATEADD(year, -7, SYSDATETIME())
            );
        COMMIT;
    END;

Without an explicit transaction, each statement is its own autocommit — if the server restarts mid-loop, you may have orphaned rows in the archive table without the corresponding delete, or vice versa. The explicit transaction guarantees atomicity per chunk.

---

## Minimal Logging


Under `SIMPLE` or `BULK_LOGGED` recovery models, certain bulk operations can use minimal logging — recording only extent allocations rather than individual row changes. This dramatically reduces log write volume and speeds up bulk loads.

**Minimal logging conditions for INSERT...SELECT or SELECT INTO:**

| Condition | Required? |
|---|---|
| Recovery model = SIMPLE or BULK_LOGGED | Yes — minimal logging never applies under FULL |
| `TABLOCK` hint on the target table | Required for non-empty heap or clustered index under pre-2016 |
| Target has no nonclustered indexes | Required unless using an empty clustered index (SQL Server 2016+) |
| Target is empty OR a heap OR has only a clustered index | See 2016+ note below |

**SQL Server 2016+:** an empty heap or empty clustered index with nonclustered indexes can still qualify for minimal logging when `TABLOCK` is used, as long as the table was empty at the start of the INSERT. Nonclustered index entries are still fully logged.

    -- Minimal logging: empty staging table + SIMPLE recovery + TABLOCK
    INSERT INTO dbo.StagingFact WITH (TABLOCK)
    SELECT FactID, ProductID, SaleDate, Amount
    FROM   dbo.SourceFact
    WHERE  SaleDate >= '2025-01-01';

    -- SELECT INTO also qualifies (creates the table + inserts)
    SELECT FactID, ProductID, SaleDate, Amount
    INTO   dbo.StagingFact
    FROM   dbo.SourceFact
    WHERE  SaleDate >= '2025-01-01';

**Verify minimal logging is active:**

After the operation, check the transaction log for the extent allocation records rather than individual row inserts. Under full logging, you'll see one log record per row; under minimal logging, you'll see one per extent (8 pages).

    -- Check recovery model
    SELECT name, recovery_model_desc FROM sys.databases WHERE name = DB_NAME();

**Switching recovery model for a bulk load** — only appropriate when you can accept losing the ability to restore to a point in time during the bulk window:

    -- Before bulk load
    ALTER DATABASE YourDatabase SET RECOVERY BULK_LOGGED;

    -- ... bulk operation ...

    -- After bulk load: switch back and take a full or log backup
    ALTER DATABASE YourDatabase SET RECOVERY FULL;
    BACKUP LOG YourDatabase TO DISK = '\\backupserver\YourDatabase_post_bulk.trn';

Under BULK_LOGGED recovery, the transaction log backup after the bulk operation captures the extents that were minimally logged. Do not skip the log backup — without it you cannot restore to any point in time after the bulk load.

---

## Partition Switching


Partition switching is the fastest way to move large amounts of data in or out of a table — it is a metadata-only operation taking milliseconds regardless of data volume.

**Use cases:**
- Archive old data from a production table without a long-running DELETE
- Load new data into a staging table and swap it in atomically
- Replace a partition's data (truncate + reload without TRUNCATE on the main table)

**How it works:** SQL Server moves a partition from one table to another by updating the partition metadata. No data pages move. Both tables must have identical structure, constraints, and filegroup placement.

    -- Step 1: Create a staging table with identical structure
    CREATE TABLE dbo.OrdersArchive_2023 (
        OrderID    INT           NOT NULL,
        CustomerID INT           NOT NULL,
        OrderDate  DATETIME2     NOT NULL,
        TotalAmt   DECIMAL(12,2) NOT NULL,
        -- identical constraints, indexes, and compression as dbo.Orders partition 1
        CONSTRAINT PK_OrdersArchive_2023 PRIMARY KEY CLUSTERED (OrderID)
    ) ON [PRIMARY];

    -- Step 2: Switch partition 1 (oldest) out of the main table into the archive
    ALTER TABLE dbo.Orders
        SWITCH PARTITION 1 TO dbo.OrdersArchive_2023;
    -- Completes in milliseconds; no rows are copied

    -- Step 3: The archive table now holds all 2023 data; truncate or DROP it
    TRUNCATE TABLE dbo.OrdersArchive_2023;

**Partition elimination for queries:** the optimizer uses the partition function to exclude partitions that cannot contain matching rows:

    -- Only scans partition(s) covering 2025 data
    SELECT * FROM dbo.Orders
    WHERE  OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01';

    -- Verify elimination in the actual execution plan:
    -- Look for "Actual Partition Count" < total partition count on the scan operator

---

## Transaction Log Management


High-throughput DML generates high log volume. The log is a write-ahead, sequential append — its performance depends on log disk latency (single-threaded append; no parallelism benefit).

**WRITELOG wait type** is the signal that log I/O is the bottleneck. The fix is a faster log disk — NVME SSD dedicated to the log file — not chunking (chunking helps with lock escalation and log space, not latency).

**Log space vs log latency:**
- Log space is controlled by recovery model, backup frequency, and VLF count
- Log latency is controlled by disk speed — separate the log from data files on dedicated storage

    -- Check log space usage
    SELECT name, log_size_mb = size * 8 / 1024,
           log_used_mb = FILEPROPERTY(name, 'SpaceUsed') * 8 / 1024,
           recovery_model_desc
    FROM sys.databases
    WHERE name = DB_NAME();

    -- Check VLF count (Virtual Log Files) — high VLF count slows recovery and log writes
    -- Ideal: < 100 VLFs; > 1,000 is problematic
    DBCC LOGINFO;  -- classic; SQL Server 2016 SP2+ can also query sys.dm_db_log_info for a filterable result set

**Reducing log volume during bulk loads:**
- Use BULK_LOGGED recovery model (see Minimal Logging above)
- Use `TRUNCATE TABLE` instead of `DELETE FROM table` — TRUNCATE is minimally logged regardless of recovery model for heap tables, and generates only deallocations for partitioned tables
- Batch large DELETEs and UPDATEs (see Chunked DML above)

    -- TRUNCATE vs DELETE comparison
    -- DELETE FROM dbo.StagingLoad;         -- row-by-row log entries; slow; rollbackable
    -- TRUNCATE TABLE dbo.StagingLoad;      -- extent deallocations only; fast; also rollbackable

`TRUNCATE TABLE` is transactional and can be rolled back, but it generates far fewer log records than DELETE. Use TRUNCATE when you want to clear all rows; use chunked DELETE when you need a WHERE clause.

**Autogrowth events:** each autogrowth of the log file is a synchronizing event that pauses all log writes. Pre-size the log file large enough to avoid autogrowth during peak operations:

    -- Set log file to 10 GB with 500 MB autogrowth
    ALTER DATABASE YourDatabase
    MODIFY FILE (NAME = 'YourDatabase_log', SIZE = 10240 MB, FILEGROWTH = 512 MB);

---

## BULK INSERT Optimization


`BULK INSERT` (or `bcp`) is the fastest way to load external data into SQL Server.

    BULK INSERT dbo.StagingLoad
    FROM 'D:\data\load_file.csv'
    WITH (
        FIELDTERMINATOR = ',',
        ROWTERMINATOR   = '\n',
        FIRSTROW        = 2,         -- skip header
        BATCHSIZE       = 10000,     -- rows per batch (= one log checkpoint per batch)
        TABLOCK,                     -- acquire table lock; enables minimal logging
        MAXERRORS       = 0          -- fail on any error
    );

**BULK INSERT with minimal logging** requires:
- `TABLOCK` hint — forces a table-level lock and signals bulk-load path
- Recovery model = SIMPLE or BULK_LOGGED
- Target with no nonclustered indexes OR an empty clustered index (SQL Server 2016+)

**`BATCHSIZE` controls commit frequency:** each batch is committed separately. A BATCHSIZE of 0 (default) loads the entire file in one transaction — fast but uses more log space and cannot be restarted mid-load. A BATCHSIZE of 10,000 commits every 10,000 rows — restartable at the last committed batch position.

**After bulk load, update statistics:**

    -- Bulk loads do not automatically update statistics
    UPDATE STATISTICS dbo.StagingLoad WITH FULLSCAN;

---

## See Also


- [locking-blocking.md](locking-blocking.md) — lock escalation from large DML, TABLOCK behavior
- [index-strategy.md](index-strategy.md) — minimal logging requirements and nonclustered indexes
- [wait-stats.md](wait-stats.md) — WRITELOG wait type for log I/O bottleneck diagnosis
- [statistics-tuning.md](statistics-tuning.md) — updating statistics after bulk loads

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [Transaction Locking and Row Versioning Guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) — Documents the 5,000-lock-per-statement escalation threshold, LOCK_ESCALATION options, and how chunked DML keeps row counts below escalation thresholds.
[^2]: [Prerequisites for Minimal Logging in Bulk Import](https://learn.microsoft.com/en-us/sql/relational-databases/import-export/prerequisites-for-minimal-logging-in-bulk-import) — Official conditions for minimal logging: SIMPLE or BULK_LOGGED recovery model, TABLOCK hint, and empty clustered index (first batch only).
[^3]: [BULK INSERT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/bulk-insert-transact-sql) — Full syntax reference for BULK INSERT including BATCHSIZE, TABLOCK, FIELDTERMINATOR, ROWTERMINATOR, and MAXERRORS options.
[^4]: [Partitioned Tables and Indexes](https://learn.microsoft.com/en-us/sql/relational-databases/partitions/partitioned-tables-and-indexes) — Covers partition switching (metadata-only ALTER TABLE...SWITCH completing in milliseconds), partition elimination for queries, and filegroup placement requirements.
[^5]: [SQL Server Transaction Log Architecture and Management Guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-log-architecture-and-management-guide) — Covers VLF proliferation from frequent small autogrowths, write-ahead logging (WRITELOG), and how log truncation interacts with recovery model.
[^6]: [sys.dm_db_log_info (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-log-info-transact-sql) — Reference for the replacement of DBCC LOGINFO (SQL Server 2016 SP2+) used to count VLFs and assess log health after bulk operations.
[^7]: [Maintain Indexes Optimally to Improve Performance and Reduce Resource Utilization](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/reorganize-and-rebuild-indexes) — Covers statistics updates during index rebuild (equivalent to FULLSCAN), relevant after large batch loads to refresh cardinality estimates.
[^8]: [SQL Server Index and Statistics Maintenance](https://ola.hallengren.com/sql-server-index-and-statistics-maintenance.html) — Ola Hallengren's maintenance solution with guidance on handling statistics updates and index maintenance following bulk data loads.

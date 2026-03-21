# Locking and Blocking


Isolation levels, lock mechanics, RCSI, deadlocks, and how to diagnose and resolve contention in SQL Server.

## Table of Contents


- [Isolation Levels](#isolation-levels)
- [Read Committed Snapshot Isolation (RCSI)](#read-committed-snapshot-isolation-rcsi)
- [Lock Modes](#lock-modes)
- [Lock Escalation](#lock-escalation)
- [Lock Hints](#lock-hints)
- [Deadlocks](#deadlocks)
- [Diagnosing Blocking](#diagnosing-blocking)
- [NOLOCK Dangers](#nolock-dangers)
- [See Also](#see-also)
- [Sources](#sources)

---

## Isolation Levels


SQL Server supports five ANSI isolation levels plus the non-standard SNAPSHOT level.

| Level | Dirty read | Non-repeatable read | Phantom | Implementation | Notes |
|---|---|---|---|---|---|
| `READ UNCOMMITTED` | Yes | Yes | Yes | No shared locks | Never safe for financial data |
| `READ COMMITTED` | No | Yes | Yes | S locks released after read | **Default** in SQL Server |
| `REPEATABLE READ` | No | No | Yes | S locks held until commit | High contention; rarely used |
| `SERIALIZABLE` | No | No | No | Key-range locks | Prevents phantom inserts; severe blocking |
| `SNAPSHOT` | No | No | No | Row versioning from tempdb | Transaction-scoped consistent view |
| `READ COMMITTED SNAPSHOT` | No | Yes | Yes | Row versioning; no S locks | RCSI — database-level option |

**Setting the isolation level:**

    -- Session-level (affects all subsequent queries)
    SET TRANSACTION ISOLATION LEVEL READ COMMITTED;    -- default
    SET TRANSACTION ISOLATION LEVEL SNAPSHOT;          -- requires database option

    -- Query-level override via table hint
    SELECT * FROM dbo.Orders WITH (NOLOCK);            -- READ UNCOMMITTED
    SELECT * FROM dbo.Orders WITH (HOLDLOCK);          -- SERIALIZABLE

**Choosing between RCSI and SNAPSHOT:**

| Scenario | Recommendation |
|---|---|
| Mixed OLTP — readers and writers on the same tables | RCSI — eliminates reader/writer blocking transparently |
| Long-running reports alongside OLTP writes | SNAPSHOT — transaction-scoped consistent view without blocking |
| Financial: two writers cannot conflict | Pessimistic (`UPDLOCK + SERIALIZABLE`) or SNAPSHOT with conflict handling |
| Azure SQL Database | RCSI is always on; SNAPSHOT is optional |

---

## Read Committed Snapshot Isolation (RCSI)


RCSI is the most impactful performance change you can make to a read-heavy OLTP database. It replaces shared locks on reads with row versioning from tempdb, so readers and writers never block each other. Writers still block writers.

**How it works:**
1. On every UPDATE or DELETE, SQL Server copies the old row version to the tempdb version store.
2. Readers under READ COMMITTED read the version store instead of waiting for exclusive locks.
3. The version store cleanup task purges old versions once no active reader needs them.

**Enable RCSI:**

    -- Check current state
    SELECT name, is_read_committed_snapshot_on
    FROM sys.databases WHERE name = DB_NAME();

    -- Enable (briefly requires single-user access during the switch)
    ALTER DATABASE YourDatabase SET READ_COMMITTED_SNAPSHOT ON
    WITH ROLLBACK IMMEDIATE;

No application changes are needed — queries using the default READ COMMITTED isolation level automatically benefit.

**RCSI cost:** tempdb version store grows during peak write activity. Each updated row adds a 14-byte version header and stores the before-image in tempdb. Monitor version store size:

    -- sys.dm_tran_version_store_space_usage columns: database_id, reserved_page_count, reserved_space_kb
    SELECT DB_NAME(database_id)              AS db_name,
           reserved_page_count * 8.0 / 1024 AS version_store_mb
    FROM sys.dm_tran_version_store_space_usage
    ORDER BY reserved_page_count DESC;

    -- Session holding version store open (oldest snapshot transaction)
    SELECT TOP 5
        s.session_id, s.login_name,
        t.elapsed_time_seconds,
        t.transaction_sequence_num
    FROM sys.dm_tran_active_snapshot_database_transactions t
    JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id
    ORDER BY t.elapsed_time_seconds DESC;

A long-running snapshot transaction prevents version cleanup. Find and kill the blocking session; then investigate why the application held a transaction open for so long.

---

## Lock Modes


| Mode | Acquired by | Blocks |
|---|---|---|
| Shared (S) | SELECT under pessimistic isolation | X locks |
| Update (U) | UPDATE before modifying | U and X locks |
| Exclusive (X) | INSERT, UPDATE, DELETE during modification | All other locks |
| Schema Stability (Sch-S) | SELECT compilation | Schema modification only |
| Schema Modification (Sch-M) | DDL (ALTER TABLE, CREATE INDEX) | All locks |
| Bulk Update (BU) | BULK INSERT with TABLOCK | Other BU locks |
| Key-Range | SERIALIZABLE range scans | Prevents phantom inserts in range |

**Intent locks** (IS, IX, SIX) are acquired at the table and page level before acquiring row-level locks. They allow efficient compatibility checking without scanning all child locks. IX+IX is compatible — two writers on different rows in the same table can proceed simultaneously.

---

## Lock Escalation


SQL Server escalates many fine-grained row/page locks to a single table lock when a **single T-SQL statement** acquires ≥ 5,000 locks on one object, or when lock memory exceeds approximately 24% of the buffer pool. A table-level exclusive lock blocks all readers and writers on the table.

Escalation checks fire every 1,250 locks acquired by a statement. The 5,000 threshold applies per statement, not per transaction — multiple statements can each hold fewer than 5,000 locks without triggering escalation, even if the transaction total exceeds 5,000.

**Escalation causes widespread blocking** during bulk DML — a large UPDATE or DELETE that escalates from row locks to a table lock will block all other sessions accessing that table.

**Fix:** batch large DML into chunks to stay under the 5,000-lock threshold per statement (see [batch-operations.md](batch-operations.md)).

    -- Check current escalation setting
    SELECT name, lock_escalation_desc FROM sys.tables WHERE name = 'Orders';

    -- Escalate to partition first, then table (helps partitioned tables)
    ALTER TABLE dbo.Orders SET (LOCK_ESCALATION = AUTO);

    -- Detect lock escalation via Extended Events
    CREATE EVENT SESSION [LockEscalation] ON SERVER
    ADD EVENT sqlserver.lock_escalation (
        ACTION (sqlserver.sql_text, sqlserver.session_id)
        WHERE sqlserver.database_name = N'YourDatabase'
    )
    ADD TARGET package0.ring_buffer;
    GO
    ALTER EVENT SESSION [LockEscalation] ON SERVER STATE = START;

---

## Lock Hints


Lock hints override the session isolation level for a specific table reference. Use deliberately, not defensively.

| Hint | Effect | When to use |
|---|---|---|
| `NOLOCK` | Read uncommitted — no shared locks | Rarely; see NOLOCK Dangers below |
| `UPDLOCK` | U lock instead of S on read | Prevent S→X conversion deadlocks in read-then-update patterns |
| `HOLDLOCK` | SERIALIZABLE — key-range locks | Prevent phantom inserts in a check-then-insert pattern |
| `READPAST` | Skip locked rows instead of waiting | Queue consumers — concurrent workers claim different rows |
| `ROWLOCK` | Force row-level lock granularity | Hint; SQL Server may escalate anyway |
| `TABLOCK` | Table-level shared lock | Bulk operations needing minimal logging |
| `TABLOCKX` | Table-level exclusive lock | Rare; ensures no concurrent access |

**Concurrent queue consumer pattern:**

    -- Atomic queue pop — skips rows locked by other consumers
    BEGIN TRANSACTION;
        UPDATE TOP (1) dbo.WorkQueue
        SET    Status = 'Processing', StartedAt = SYSDATETIME()
        OUTPUT DELETED.WorkItemID, DELETED.Payload
        WHERE  Status = 'Pending'
          AND  ScheduledFor <= SYSDATETIME()
        ORDER BY QueuedAt;  -- requires workaround; see below
    COMMIT;

    -- More portable pattern using READPAST + UPDLOCK
    DECLARE @ItemID INT;
    BEGIN TRANSACTION;
        SELECT TOP (1) @ItemID = WorkItemID
        FROM   dbo.WorkQueue WITH (READPAST, ROWLOCK, UPDLOCK)
        WHERE  Status = 'Pending'
          AND  ScheduledFor <= SYSDATETIME()
        ORDER BY QueuedAt;

        IF @ItemID IS NOT NULL
            UPDATE dbo.WorkQueue
            SET    Status = 'Processing', StartedAt = SYSDATETIME()
            WHERE  WorkItemID = @ItemID;
    COMMIT;

**Preventing phantom inserts (check-then-insert):**

    BEGIN TRANSACTION;
        -- UPDLOCK prevents other sessions from acquiring S lock
        -- HOLDLOCK (= SERIALIZABLE) holds a range lock preventing phantom inserts
        IF NOT EXISTS (
            SELECT 1 FROM dbo.Customer WITH (UPDLOCK, HOLDLOCK)
            WHERE  Email = @Email
        )
        BEGIN
            INSERT INTO dbo.Customer (Email, ...) VALUES (@Email, ...);
        END
    COMMIT;

---

## Deadlocks


A deadlock occurs when two sessions each hold a lock the other needs. SQL Server's deadlock monitor runs every 5 seconds, detects cycles, and kills the session with the smallest rollback cost (the **deadlock victim**, which receives error 1205).

**Classic deadlock:**

    -- Session A: holds X on Orders row 1, wants X on Accounts row 1
    -- Session B: holds X on Accounts row 1, wants X on Orders row 1
    -- → SQL Server kills one session

**Prevention strategies:**

**1. Consistent lock ordering** — always access tables in the same order across all transactions:

    -- Bad: A locks Orders then Accounts; B locks Accounts then Orders → deadlock
    -- Good: both sessions always lock Orders → Accounts
    BEGIN TRANSACTION;
        UPDATE dbo.Orders  SET Status = 'Processing' WHERE OrderID = @id;
        UPDATE dbo.Accounts SET Balance = Balance - @amt WHERE AccountID = @acct;
    COMMIT;

**2. UPDLOCK on reads** — prevents the S→X conversion deadlock where two sessions both read with S lock and both try to promote to X:

    -- Deadlock-prone: Session A and B both acquire S, both promote to X → deadlock
    SELECT Qty FROM dbo.Inventory WHERE ProductID = @pid;
    UPDATE dbo.Inventory SET Qty = Qty - 1 WHERE ProductID = @pid;

    -- Fixed: UPDLOCK prevents the second S lock from being granted
    BEGIN TRANSACTION;
        SELECT Qty FROM dbo.Inventory WITH (UPDLOCK, ROWLOCK) WHERE ProductID = @pid;
        UPDATE dbo.Inventory SET Qty = Qty - 1 WHERE ProductID = @pid;
    COMMIT;

**3. RCSI** — eliminates most reader/writer deadlocks because readers no longer acquire S locks.

**4. Shorter transactions** — the shorter a transaction, the less time it holds locks and the smaller the deadlock window.

**Detecting deadlocks** — the `system_health` Extended Events session captures deadlock graphs automatically:

    SELECT TOP 10
        xdr.value('@timestamp', 'datetime2')  AS deadlock_time,
        xdr.query('.')                          AS deadlock_graph_xml
    FROM (
        SELECT CAST(target_data AS XML) AS target_data
        FROM sys.dm_xe_session_targets t
        JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
        WHERE s.name = 'system_health'
          AND t.target_name = 'ring_buffer'
    ) AS d
    CROSS APPLY target_data.nodes(
        '//RingBufferTarget/event[@name="xml_deadlock_report"]'
    ) AS XEventData(xdr)
    ORDER BY deadlock_time DESC;

For historical deadlock data (survives ring buffer rotation), read from the `system_health` XEL files in the SQL Server error log directory.

**Application-side deadlock handling:** always code for error 1205. Catch it, wait briefly, and retry the transaction. Deadlocks are expected under concurrency — they should be handled, not just logged.

---

## Diagnosing Blocking


Blocking differs from deadlocks — it is a single chain where one session waits indefinitely for another to release a lock.

    -- Current blocking chains
    SELECT  r.session_id      AS blocked_session,
            r.blocking_session_id,
            r.wait_type,
            r.wait_time / 1000.0  AS wait_sec,
            r.wait_resource,
            SUBSTRING(st.text, (r.statement_start_offset/2)+1, 200) AS blocked_stmt,
            s.open_transaction_count,
            s.login_name,
            s.program_name
    FROM sys.dm_exec_requests r
    JOIN sys.dm_exec_sessions  s ON s.session_id = r.session_id
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
    WHERE r.blocking_session_id > 0
    ORDER BY r.wait_time DESC;

    -- What is the blocking session doing?
    SELECT s.session_id, s.status,
           s.open_transaction_count,
           SUBSTRING(st.text, 1, 200) AS current_or_last_stmt
    FROM sys.dm_exec_sessions s
    LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
    OUTER APPLY sys.dm_exec_sql_text(
        ISNULL(r.sql_handle, s.last_request_sql_handle)) st
    WHERE s.session_id = @blocking_session_id;

Common causes of long blocking chains:
- Long-running explicit transactions that were never committed (forgotten `COMMIT`)
- Application-side row-by-row processing inside a transaction
- Implicit transactions (`SET IMPLICIT_TRANSACTIONS ON`) left open

**Set a lock timeout** so applications fail predictably rather than waiting indefinitely:

    SET LOCK_TIMEOUT 5000;  -- fail after 5 seconds (milliseconds)

---

## NOLOCK Dangers


`WITH (NOLOCK)` / `READ UNCOMMITTED` is not "reading without waiting" — it bypasses all read consistency guarantees and can produce:

- **Rows returned twice** — the scan reads the same row twice when a page split moves it
- **Rows skipped** — the scan misses rows that moved to a different page during the scan
- **Torn reads** — partial rows at 8,060-byte boundaries under certain conditions
- **Uncommitted data** — data from transactions that were later rolled back

The performance benefit is also often overstated. Under RCSI, reads acquire no shared locks and produce consistent results. Replace NOLOCK with RCSI:

    -- Instead of: SELECT * FROM dbo.Orders WITH (NOLOCK)
    -- Enable RCSI once at the database level:
    ALTER DATABASE YourDatabase SET READ_COMMITTED_SNAPSHOT ON;
    -- Then the default READ COMMITTED reads from version store — no S locks, consistent results
    SELECT * FROM dbo.Orders;

The only legitimate use of NOLOCK is for rough row-count estimates or dashboard queries where approximate correctness is explicitly acceptable and documented.

---

## See Also


- [wait-stats.md](wait-stats.md) — LCK_M_* wait types and blocking identification
- [batch-operations.md](batch-operations.md) — chunked DML to avoid lock escalation
- [execution-plans.md](execution-plans.md) — lock waits appearing as elapsed time >> CPU time
- [statistics-tuning.md](statistics-tuning.md) — stale statistics causing bad plans that hold locks longer

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [Transaction Locking and Row Versioning Guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) — Comprehensive reference covering all lock modes (S/U/X/IS/IX/Sch-S/Sch-M), isolation levels including RCSI, lock escalation (≥5,000 locks per statement), LOCK_ESCALATION=AUTO, and lock hints.
[^2]: [sys.dm_exec_requests (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-requests-transact-sql) — Reference for blocking_session_id, wait_type, wait_resource, and transaction_isolation_level columns used to diagnose live blocking chains.
[^3]: [Use the system_health Session](https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/use-the-system-health-session) — Documents the built-in Extended Events session that automatically captures deadlock graphs and long lock waits without additional configuration.
[^4]: [sys.dm_tran_version_store_space_usage (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-tran-version-store-space-usage) — Column reference (database_id, reserved_page_count, reserved_space_kb) for monitoring version store growth when RCSI or snapshot isolation is enabled.
[^5]: [sys.dm_tran_active_snapshot_database_transactions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-tran-active-snapshot-database-transactions-transact-sql) — Reference for elapsed_time_seconds and transaction_sequence_num used to identify long-running snapshot transactions preventing version store cleanup.
[^6]: [Partitioned Tables and Indexes](https://learn.microsoft.com/en-us/sql/relational-databases/partitions/partitioned-tables-and-indexes) — Explains LOCK_ESCALATION = AUTO to allow partition-level escalation instead of table-level, reducing contention on partitioned tables.
[^7]: [sys.dm_os_wait_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-os-wait-stats-transact-sql) — Documents LCK_M_* wait types that signal lock contention and how to isolate them from benign background waits.
[^8]: [sys.query_store_wait_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql) — Wait-category mapping showing how LCK_M_* maps to the "Lock" category in Query Store for per-query lock-wait attribution.

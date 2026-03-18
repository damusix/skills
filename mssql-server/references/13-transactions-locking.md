# 13 — Transactions, Locking, and Concurrency

Comprehensive reference for SQL Server transaction management, isolation levels, MVCC via row versioning, lock mechanics, deadlock handling, and concurrency tuning.

---

## Table of Contents

1. [When to Use This Reference](#when-to-use-this-reference)
2. [Transaction Fundamentals](#transaction-fundamentals)
3. [Isolation Levels](#isolation-levels)
4. [MVCC and Row Versioning](#mvcc-and-row-versioning)
5. [READ_COMMITTED_SNAPSHOT vs ALLOW_SNAPSHOT_ISOLATION](#read_committed_snapshot-vs-allow_snapshot_isolation)
6. [Optimistic vs Pessimistic Concurrency](#optimistic-vs-pessimistic-concurrency)
7. [Lock Architecture](#lock-architecture)
8. [Lock Modes](#lock-modes)
9. [Lock Escalation](#lock-escalation)
10. [Lock Hints](#lock-hints)
11. [LOCK_TIMEOUT](#lock_timeout)
12. [Deadlocks](#deadlocks)
13. [Monitoring Locks and Blocking](#monitoring-locks-and-blocking)
14. [Common Concurrency Patterns](#common-concurrency-patterns)
15. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
16. [See Also](#see-also)
17. [Sources](#sources)

---

## When to Use This Reference

Load this file when the user asks about:

- Transaction syntax (`BEGIN TRAN`, `COMMIT`, `ROLLBACK`, `SAVE TRANSACTION`)
- Isolation levels (`READ COMMITTED`, `SERIALIZABLE`, `SNAPSHOT`, etc.)
- Blocking, deadlocks, lock waits, LOCK_TIMEOUT
- `NOLOCK`, `UPDLOCK`, `HOLDLOCK`, `TABLOCK` hints
- `READ_COMMITTED_SNAPSHOT` (RCSI) or `ALLOW_SNAPSHOT_ISOLATION` (SI) database settings
- Row versioning, version store, tempdb pressure from versioning
- `@@TRANCOUNT`, `XACT_STATE()`, nested transactions
- Lock escalation, HOB locks, lock granularity
- Long-running transactions blocking readers or writers
- Optimistic vs pessimistic concurrency trade-offs

---

## Transaction Fundamentals

### Autocommit vs Explicit Transactions

SQL Server runs in **autocommit mode** by default — every statement is its own transaction unless you explicitly group statements.

```sql
-- Autocommit: each statement commits immediately
INSERT INTO Orders (CustomerID, Amount) VALUES (1, 100.00);

-- Explicit transaction
BEGIN TRANSACTION;
    UPDATE Accounts SET Balance = Balance - 100 WHERE AccountID = 1;
    UPDATE Accounts SET Balance = Balance + 100 WHERE AccountID = 2;
COMMIT TRANSACTION;

-- Rollback on error
BEGIN TRANSACTION;
    UPDATE Inventory SET Quantity = Quantity - 1 WHERE ProductID = 42;
    IF @@ROWCOUNT = 0
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Product not found', 16, 1);
        RETURN;
    END
COMMIT TRANSACTION;
```

### @@TRANCOUNT and Nesting

`@@TRANCOUNT` counts nested `BEGIN TRANSACTION` calls. **Only the outermost `COMMIT` actually commits.** An inner `ROLLBACK` rolls back the entire transaction, not just the inner scope — this is a critical gotcha.

```sql
BEGIN TRANSACTION;           -- @@TRANCOUNT = 1
    BEGIN TRANSACTION;       -- @@TRANCOUNT = 2
        -- Do work
    COMMIT TRANSACTION;      -- @@TRANCOUNT = 1  (does NOT commit)
COMMIT TRANSACTION;          -- @@TRANCOUNT = 0  (actually commits)

-- Dangerous: inner ROLLBACK kills the whole thing
BEGIN TRANSACTION;           -- @@TRANCOUNT = 1
    BEGIN TRANSACTION;       -- @@TRANCOUNT = 2
        ROLLBACK TRANSACTION;-- @@TRANCOUNT = 0  (EVERYTHING rolled back!)
-- Now: COMMIT would error — no open transaction
```

> [!WARNING] Nested ROLLBACK behavior
> An inner `ROLLBACK` without a savepoint rolls back ALL work to the outermost transaction boundary, ignoring nesting level. There is no "rollback just the inner transaction" without savepoints.

### SAVE TRANSACTION (Savepoints)

Savepoints allow partial rollback within a transaction without discarding all work:

```sql
BEGIN TRANSACTION;
    INSERT INTO AuditLog (Event) VALUES ('start');

    SAVE TRANSACTION step1;   -- mark savepoint

    BEGIN TRY
        DELETE FROM Orders WHERE CustomerID = 99;
        IF @@ROWCOUNT > 1000
        BEGIN
            ROLLBACK TRANSACTION step1;  -- rolls back only to savepoint
            -- @@TRANCOUNT remains 1 — outer transaction still open
        END
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION step1;
        -- log error, continue outer transaction
    END CATCH

    INSERT INTO AuditLog (Event) VALUES ('end');
COMMIT TRANSACTION;
```

Savepoint rollback does **not** reduce `@@TRANCOUNT`. The outer transaction remains open and committable.

### XACT_STATE()

Preferred over `@@TRANCOUNT` inside `CATCH` blocks because it distinguishes a committable transaction from a doomed (uncommittable) one:

| `XACT_STATE()` | Meaning |
|---|---|
| `1` | Active, committable transaction |
| `0` | No open transaction |
| `-1` | Doomed transaction — must `ROLLBACK`, cannot `COMMIT` |

```sql
BEGIN TRY
    BEGIN TRANSACTION;
    -- ... work ...
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() = -1
        ROLLBACK TRANSACTION;    -- doomed, must rollback
    ELSE IF XACT_STATE() = 1
        ROLLBACK TRANSACTION;    -- committable but we choose to rollback
    -- XACT_STATE() = 0: no transaction, nothing to rollback

    THROW;
END CATCH
```

> [!NOTE]
> `SET XACT_ABORT ON` causes any run-time error to doom the transaction and sets `XACT_STATE()` to -1. Always use `XACT_ABORT ON` in stored procedures — see [`06-stored-procedures.md`](06-stored-procedures.md).

### Implicit Transactions

`SET IMPLICIT_TRANSACTIONS ON` starts a transaction automatically before DML/DDL if none is open. This mode is rarely useful and frequently causes forgotten open transactions. **Avoid it** unless integrating with ODBC drivers that rely on it.

---

## Isolation Levels

SQL Server supports five isolation levels defined by ANSI SQL, plus the non-standard `SNAPSHOT` level added by Microsoft. Each level prevents different concurrency phenomena.

### Phenomena Definitions

| Phenomenon | Description |
|---|---|
| **Dirty read** | Read uncommitted data from another transaction that may roll back |
| **Non-repeatable read** | Re-reading the same row returns different data because another transaction updated/deleted it |
| **Phantom read** | Re-running a range query returns different rows because another transaction inserted/deleted rows |
| **Lost update** | Two transactions read same value, both update it; second update silently overwrites first |

### Isolation Level Comparison Table

| Isolation Level | Dirty Read | Non-Repeatable | Phantom | Lost Update | Implementation | Notes |
|---|---|---|---|---|---|---|
| `READ UNCOMMITTED` | Possible | Possible | Possible | Possible | No shared locks acquired | Fastest; never safe for financial data |
| `READ COMMITTED` | No | Possible | Possible | Possible | Shared locks released immediately after read | **Default** in SQL Server |
| `REPEATABLE READ` | No | No | Possible | No | Shared locks held until transaction ends | Rarely used; high contention |
| `SERIALIZABLE` | No | No | No | No | Range locks (key-range locks) acquired | Highest isolation; severe blocking |
| `SNAPSHOT` | No | No | No | No | Row versioning from tempdb version store | Statement or transaction snapshot; see below |
| `READ COMMITTED SNAPSHOT` | No | Possible | Possible | Possible | Row versioning; statement-level snapshot | Database-level option; drops shared locks |

### Setting Isolation Level

```sql
-- Session-level (affects all subsequent queries in session)
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;    -- default
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;  -- no shared locks
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;          -- requires database option

-- Query-level via table hint (overrides session level for that table)
SELECT * FROM Orders WITH (NOLOCK);           -- READ UNCOMMITTED
SELECT * FROM Orders WITH (HOLDLOCK);         -- SERIALIZABLE
SELECT * FROM Orders WITH (UPDLOCK, ROWLOCK); -- UPDATE lock, row granularity
```

### READ UNCOMMITTED — Use with Extreme Caution

Reads uncommitted data. Technically eliminates lock contention on reads but can return data that was never persisted:

```sql
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
-- or equivalently:
SELECT * FROM LargeTable WITH (NOLOCK);
```

> [!WARNING] NOLOCK / READ UNCOMMITTED risks
> Can return: rows twice, rows that don't exist, partial rows (torn reads on 8060-byte row boundary), rows that were never committed. Do not use for financial calculations, aggregation correctness, or anything requiring data integrity. The performance benefit is often overstated — consider RCSI instead.

---

## MVCC and Row Versioning

SQL Server implements **Multi-Version Concurrency Control (MVCC)** not in the buffer pool like PostgreSQL, but through a dedicated **version store in tempdb**.

### How Row Versioning Works

When row versioning is enabled (via RCSI or SI database options):

1. **Before any update/delete**, SQL Server copies the old row version to the **version store** in `tempdb` (database `tempdb`, internal object `_RowVersioning$`).
2. The old version includes a **14-byte header** added to each row in user tables: an 8-byte transaction sequence number (XSN) and a pointer to the previous version.
3. Readers at SNAPSHOT isolation walk the version chain to find the row as it appeared at their transaction start time.
4. The **version store cleanup** task (background thread) purges versions no longer needed by any active snapshot transaction.

### Version Store Structure

```sql
-- Monitor version store usage
SELECT
    DB_NAME(database_id)            AS db_name,
    reserved_page_count * 8.0 / 1024 AS reserved_mb,
    used_page_count * 8.0 / 1024   AS used_mb
FROM sys.dm_db_file_space_usage
WHERE database_id = 2;  -- tempdb

-- Current version store contents (aggregate)
SELECT
    transaction_sequence_num,
    version_sequence_num,
    database_id,
    rowset_guid,
    command_id,
    is_prepared,
    needs_rollback
FROM sys.dm_tran_version_store
ORDER BY transaction_sequence_num;  -- can be large; limit in prod

-- Active snapshot transactions holding version store open
SELECT
    t.transaction_id,
    t.transaction_sequence_num,
    t.commit_sequence_num,
    t.is_snapshot,
    s.session_id,
    s.open_transaction_count,
    s.last_request_start_time
FROM sys.dm_tran_active_snapshot_database_transactions t
JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id;
```

### Row Version Chain

Each updated row has a 14-byte version pointer prepended to the row header, forming a linked list back to the oldest required version. Long-running snapshot transactions force SQL Server to maintain a long version chain — this is why OLTP under high update rates can cause tempdb growth and version store cleanup pressure.

> [!WARNING] tempdb pressure from version store
> A single long-running snapshot transaction can prevent version store cleanup, causing tempdb to grow unboundedly. Monitor `sys.dm_tran_active_snapshot_database_transactions` and alert on transactions older than a threshold (e.g., 5 minutes for OLTP, 30 minutes for reporting).

---

## READ_COMMITTED_SNAPSHOT vs ALLOW_SNAPSHOT_ISOLATION

These are two separate database-level settings that both enable row versioning but behave differently. **They are not mutually exclusive** — both can be on.

### READ_COMMITTED_SNAPSHOT (RCSI)

- **Database option:** `ALTER DATABASE mydb SET READ_COMMITTED_SNAPSHOT ON;`
- **Effect:** Changes the *default* `READ COMMITTED` isolation level from pessimistic (shared locks) to optimistic (row versioning). **No application changes required.**
- **Snapshot point:** Statement-level — each statement sees data as of statement start, not transaction start.
- **Writers still block writers** — only reader/writer contention is eliminated.
- **Recommended:** Yes, for most OLTP workloads. It is the default in Azure SQL Database.

```sql
-- Check current setting
SELECT name, is_read_committed_snapshot_on
FROM sys.databases
WHERE name = DB_NAME();

-- Enable (requires exclusive access briefly)
-- Best run during maintenance window with no other connections
ALTER DATABASE AdventureWorks SET READ_COMMITTED_SNAPSHOT ON
WITH ROLLBACK IMMEDIATE;
```

> [!NOTE] Azure SQL Database
> `READ_COMMITTED_SNAPSHOT` is **ON by default** in Azure SQL Database and cannot be disabled. Applications expecting blocking behavior under READ COMMITTED must be retested.

### ALLOW_SNAPSHOT_ISOLATION (SI)

- **Database option:** `ALTER DATABASE mydb SET ALLOW_SNAPSHOT_ISOLATION ON;`
- **Effect:** Enables the `SNAPSHOT` isolation level as an option sessions can opt into. Does **not** change default READ COMMITTED behavior.
- **Snapshot point:** Transaction-level — the entire transaction sees a consistent snapshot of data as of transaction start time.
- **Update conflict detection:** Snapshot transactions detect write-write conflicts at commit time and receive error 3960 if another transaction modified the same row since the snapshot was taken.
- **Use case:** Long-running read transactions (reports) that need transaction-consistent reads without blocking writers.

```sql
ALTER DATABASE AdventureWorks SET ALLOW_SNAPSHOT_ISOLATION ON;

-- Session opts into snapshot isolation
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
BEGIN TRANSACTION;
    -- Sees consistent snapshot from BEGIN TRANSACTION
    SELECT SUM(Amount) FROM Orders WHERE OrderDate >= '2024-01-01';
    -- ... more reads, all consistent to same point in time
COMMIT TRANSACTION;
```

### Comparison Table

| Attribute | RCSI | SI |
|---|---|---|
| Session opt-in required | No (transparent) | Yes (`SET TRANSACTION ISOLATION LEVEL SNAPSHOT`) |
| Snapshot point | Per-statement | Per-transaction |
| Prevents non-repeatable reads | No | Yes |
| Prevents phantom reads | No | Yes |
| Update conflict error possible | No | Yes (error 3960) |
| tempdb version store enabled | Yes | Yes |
| Best for | OLTP read/write mix | Long-running consistent reads |

---

## Optimistic vs Pessimistic Concurrency

### Pessimistic Concurrency (default READ COMMITTED)

Assumes conflicts are likely. Acquires shared locks before reading, blocking writers. Writers acquire exclusive locks, blocking readers.

- **Pro:** Readers always see committed data; simple mental model.
- **Con:** Reader/writer blocking; hot rows become serialization bottlenecks.

### Optimistic Concurrency (RCSI / SI)

Assumes conflicts are rare. Readers read from version store without acquiring shared locks; writers don't block readers.

- **Pro:** No reader/writer blocking; far better throughput on read-heavy workloads.
- **Con:** tempdb pressure from version store; update conflicts possible under SI; long-running transactions cause version store bloat.

### When to Choose Each

| Scenario | Recommendation |
|---|---|
| Mixed OLTP (reads + writes) | RCSI — enables optimistic reads transparently |
| Long consistent reports alongside OLTP writes | SI — transaction-scoped snapshot |
| Financial: two writers cannot both update same row | Pessimistic (`UPDLOCK`+`SERIALIZABLE`) or SI with conflict handling |
| Archive/audit table, mostly inserts | Pessimistic fine; RCSI still beneficial |
| Azure SQL / modern SQL Server default | RCSI already on; SI optional |

---

## Lock Architecture

### Lock Granularity Hierarchy

SQL Server acquires locks at different granularities. Coarser locks are cheaper (fewer lock manager entries) but block more:

```
Database
  └── Schema
        └── Table (TAB)
              └── Extent (EXT)
                    └── Page (PAG)
                          └── Key (KEY) — index rows
                          └── RID — heap row
```

### Intent Locks

Before acquiring a row or page lock, SQL Server acquires an **intent lock** at the table (and page) level. Intent locks allow efficient compatibility checking without scanning all child locks.

| Lock | Abbreviation | Meaning |
|---|---|---|
| Intent Shared | IS | Will acquire S locks at finer granularity |
| Intent Exclusive | IX | Will acquire X locks at finer granularity |
| Shared with Intent Exclusive | SIX | Holds S on table, acquiring X on pages/rows |
| Intent Update | IU | Internal; will convert to IX |
| Shared with Intent Update | SIU | Internal conversion state |

### Lock Compatibility Matrix (simplified)

| Held → / Requested ↓ | IS | S | U | IX | X |
|---|---|---|---|---|---|
| **IS** | ✓ | ✓ | ✓ | ✓ | ✗ |
| **S** | ✓ | ✓ | ✓ | ✗ | ✗ |
| **U** | ✓ | ✓ | ✗ | ✗ | ✗ |
| **IX** | ✓ | ✗ | ✗ | ✓ | ✗ |
| **X** | ✗ | ✗ | ✗ | ✗ | ✗ |

Key insight: **IX + IX is compatible** (two writers updating different rows in the same table can both proceed).

---

## Lock Modes

| Mode | Symbol | Acquired by | Blocks |
|---|---|---|---|
| Shared | S | `SELECT` under pessimistic isolation | X locks |
| Update | U | `UPDATE` before modifying; `SELECT ... FOR UPDATE` emulated via hints | U and X locks |
| Exclusive | X | `INSERT`, `UPDATE`, `DELETE` during modification | All other locks |
| Schema Stability | Sch-S | `SELECT` compilation | Sch-M only |
| Schema Modification | Sch-M | DDL (`ALTER TABLE`, `CREATE INDEX`) | All locks |
| Bulk Update | BU | `BULK INSERT` with `TABLOCK` | Other BU locks; allows parallelism |
| Key-Range | RangeS-S, RangeS-U, RangeI-N, RangeX-X | `SERIALIZABLE` range scans | Prevents phantoms |

### Key-Range Locks (SERIALIZABLE)

Under `SERIALIZABLE`, SQL Server acquires key-range locks to prevent phantom inserts:

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRANSACTION;
    SELECT * FROM Orders WHERE CustomerID BETWEEN 100 AND 200;
    -- SQL Server holds a RangeS-S lock on the key range [100, 200]
    -- Any INSERT into this range by another transaction is blocked
    -- until this transaction commits or rolls back
COMMIT;
```

Range locks are why `SERIALIZABLE` dramatically reduces concurrency on range scans. Prefer `SNAPSHOT` isolation for consistent reads without range locks.

---

## Lock Escalation

SQL Server escalates many fine-grained locks to a coarser table lock to reduce lock manager memory overhead.

### Escalation Thresholds

- **Default:** Escalates when a transaction holds **≥ 5,000 locks** on a single object, or when total lock memory exceeds 40% of the buffer pool.
- **Per-partition escalation** (2008+): `ALTER TABLE t SET (LOCK_ESCALATION = AUTO)` escalates to partition-level first, then table — helps partitioned tables with concurrent operations.
- **Disable escalation:** `ALTER TABLE t SET (LOCK_ESCALATION = DISABLE)` — prevents table-level escalation entirely (use carefully; lock manager overhead can grow).

```sql
-- View current escalation setting
SELECT name, lock_escalation_desc
FROM sys.tables
WHERE name = 'Orders';

-- Change escalation mode
ALTER TABLE Orders SET (LOCK_ESCALATION = AUTO);    -- partition-first
ALTER TABLE Orders SET (LOCK_ESCALATION = DISABLE); -- never escalate
ALTER TABLE Orders SET (LOCK_ESCALATION = TABLE);   -- default behavior
```

### Detecting Lock Escalation

```sql
-- Extended Events session to capture lock escalation
CREATE EVENT SESSION [LockEscalation] ON SERVER
ADD EVENT sqlserver.lock_escalation(
    ACTION(sqlserver.sql_text, sqlserver.session_id)
    WHERE sqlserver.database_name = N'AdventureWorks'
)
ADD TARGET package0.ring_buffer;
GO
ALTER EVENT SESSION [LockEscalation] ON SERVER STATE = START;
```

> [!WARNING] Lock escalation and blocking
> Table-level exclusive lock escalation blocks all other sessions accessing the table — including reads under pessimistic isolation. If a bulk `UPDATE` or `DELETE` escalates, it can cause widespread blocking. Batch large DML operations (see [`03-syntax-dml.md`](03-syntax-dml.md)) to stay under the escalation threshold.

---

## Lock Hints

Lock hints override the session isolation level for a specific table reference. Use sparingly and deliberately.

### Complete Hint Reference

| Hint | Effect | Typical Use |
|---|---|---|
| `NOLOCK` | No shared locks (= READ UNCOMMITTED) | Dirty reads; avoid for correctness |
| `READUNCOMMITTED` | Alias for NOLOCK | Same as above |
| `READCOMMITTED` | Forces READ COMMITTED for this table | Override stricter session isolation |
| `REPEATABLEREAD` | Holds S locks until transaction end | Prevent non-repeatable reads on this table |
| `HOLDLOCK` | Alias for SERIALIZABLE | Prevent phantoms; often used with UPDLOCK |
| `SERIALIZABLE` | Key-range locks; prevents phantoms | Prevent concurrent inserts in range |
| `UPDLOCK` | Acquires U lock instead of S on read | Prepare for update; prevents deadlocks in read-then-update |
| `XLOCK` | Acquires X lock on read | Rare; ensures exclusive access immediately |
| `TABLOCK` | Table-level shared or exclusive lock | Bulk operations; forces escalation |
| `TABLOCKX` | Table-level exclusive lock | Exclusive table access; blocks everything |
| `PAGLOCK` | Page-level lock granularity | Force page locking (vs row) |
| `ROWLOCK` | Row-level lock granularity | Force row locking (vs page/table) |
| `READPAST` | Skip locked rows | Queue-style table consumers |

### Common Patterns

```sql
-- Anti-deadlock: always use UPDLOCK when reading to update
BEGIN TRANSACTION;
    SELECT Balance FROM Accounts WITH (UPDLOCK, ROWLOCK)
    WHERE AccountID = 1;
    -- No other session can acquire UPDLOCK or X on this row
    UPDATE Accounts SET Balance = Balance - 100 WHERE AccountID = 1;
COMMIT;

-- Queue consumer: skip rows locked by other readers
SELECT TOP(1) *
FROM WorkQueue WITH (READPAST, ROWLOCK, UPDLOCK)
WHERE Processed = 0
ORDER BY QueuedAt;

-- Prevent phantom inserts during a check-then-insert pattern
BEGIN TRANSACTION;
    IF NOT EXISTS (SELECT 1 FROM Users WITH (UPDLOCK, HOLDLOCK) WHERE Email = 'a@b.com')
    BEGIN
        INSERT INTO Users (Email) VALUES ('a@b.com');
    END
COMMIT;
-- HOLDLOCK holds the range lock preventing concurrent inserts
```

### NOLOCK Alternative: RCSI

Most production uses of `NOLOCK` can be replaced by enabling `READ_COMMITTED_SNAPSHOT` at the database level:

```sql
-- Instead of: SELECT * FROM Orders WITH (NOLOCK)
-- Enable RCSI once:
ALTER DATABASE AdventureWorks SET READ_COMMITTED_SNAPSHOT ON;
-- Then queries under default READ COMMITTED read from version store, no shared locks
SELECT * FROM Orders;  -- now reads without shared locks, sees only committed data
```

---

## LOCK_TIMEOUT

`SET LOCK_TIMEOUT` controls how long a session waits for a lock before receiving error 1222:

```sql
SET LOCK_TIMEOUT 5000;  -- wait max 5 seconds (milliseconds)
-- 0 = fail immediately if lock not available
-- -1 = wait indefinitely (default)

BEGIN TRY
    SELECT * FROM Orders WITH (UPDLOCK, ROWLOCK) WHERE OrderID = 1;
EXCEPT
-- Alternatively handle in CATCH:
END TRY
BEGIN CATCH
    IF ERROR_NUMBER() = 1222  -- Lock request timeout
        PRINT 'Could not acquire lock within timeout';
    ELSE
        THROW;
END CATCH
```

> [!NOTE]
> `LOCK_TIMEOUT` is session-scoped. There is no database-level default. Applications should always set an explicit timeout rather than waiting indefinitely, which can cause silent connection pool exhaustion.

---

## Deadlocks

A deadlock occurs when two (or more) sessions each hold a lock the other needs, creating a circular wait. SQL Server's deadlock monitor (runs every 5 seconds by default) detects cycles and kills the session with the smallest rollback cost (the **deadlock victim**).

### Classic Deadlock Pattern

```
Session A: X lock on Table1 row 1 → waiting for X lock on Table2 row 1
Session B: X lock on Table2 row 1 → waiting for X lock on Table1 row 1
→ Deadlock: SQL Server kills one session
```

### Deadlock Error

Deadlock victims receive error **1205**: `Transaction (Process ID N) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.`

### Prevention Strategies

**1. Consistent lock ordering** — always access tables in the same order:

```sql
-- Dangerous: Session A locks Orders then Accounts; Session B locks Accounts then Orders
-- Safe: Both sessions always lock in same order: Orders → Accounts
BEGIN TRANSACTION;
    UPDATE Orders SET Status = 'processing' WHERE OrderID = @id;
    UPDATE Accounts SET Balance = Balance - @amount WHERE AccountID = @acct;
COMMIT;
```

**2. UPDLOCK on reads** — avoid S-lock → X-lock conversion:

```sql
-- Deadlock-prone: Session A and B both acquire S lock, both try to promote to X
SELECT qty FROM Inventory WHERE ProductID = @pid;
UPDATE Inventory SET qty = qty - 1 WHERE ProductID = @pid;

-- Safe: Acquire U lock on read, convert to X on update
SELECT qty FROM Inventory WITH (UPDLOCK, ROWLOCK) WHERE ProductID = @pid;
UPDATE Inventory SET qty = qty - 1 WHERE ProductID = @pid;
```

**3. Shorter transactions** — minimize time locks are held:

```sql
-- Pre-compute values before beginning transaction
DECLARE @newTotal DECIMAL(18,2) = dbo.ComputeNewTotal(@orderID);

BEGIN TRANSACTION;
    UPDATE Orders SET Total = @newTotal WHERE OrderID = @orderID;
COMMIT;
```

**4. SNAPSHOT isolation** — readers never block writers; eliminates most reader-writer deadlocks.

**5. Application retry logic** — deadlocks are normal under high concurrency; applications must handle error 1205 with exponential backoff retry:

```sql
-- T-SQL retry pattern in stored procedure
DECLARE @retries INT = 0;
retry:
BEGIN TRY
    BEGIN TRANSACTION;
    -- ... work ...
    COMMIT;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    IF ERROR_NUMBER() = 1205 AND @retries < 3
    BEGIN
        SET @retries += 1;
        WAITFOR DELAY '00:00:00.100';  -- 100ms backoff
        GOTO retry;
    END
    THROW;
END CATCH
```

### Capturing Deadlock Graphs

```sql
-- System health session (always running) captures deadlocks automatically
-- Read deadlock graph from system_health XE session:
SELECT
    xdr.value('@timestamp', 'datetime2') AS DeadlockTime,
    xdr.query('.') AS DeadlockGraph
FROM (
    SELECT CAST(target_data AS XML) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = 'system_health'
      AND t.target_name = 'ring_buffer'
) AS data
CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS XEventData(xdr)
ORDER BY DeadlockTime DESC;
```

---

## Monitoring Locks and Blocking

### Current Blocking Chains

```sql
-- Who is blocking whom (simple)
SELECT
    r.session_id,
    r.blocking_session_id,
    r.wait_type,
    r.wait_time / 1000.0    AS wait_seconds,
    r.status,
    SUBSTRING(t.text, (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text)
          ELSE r.statement_end_offset END - r.statement_start_offset)/2)+1
    ) AS current_statement,
    s.login_name,
    s.host_name,
    s.program_name
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.blocking_session_id > 0;

-- Full blocking chain including the head blocker
WITH BlockingChain AS (
    SELECT
        session_id,
        blocking_session_id,
        wait_type,
        wait_time,
        CAST(session_id AS VARCHAR(MAX)) AS chain
    FROM sys.dm_exec_requests
    WHERE blocking_session_id > 0

    UNION ALL

    SELECT
        r.session_id,
        r.blocking_session_id,
        r.wait_type,
        r.wait_time,
        bc.chain + ' → ' + CAST(r.session_id AS VARCHAR(10))
    FROM sys.dm_exec_requests r
    JOIN BlockingChain bc ON r.session_id = bc.blocking_session_id
)
SELECT * FROM BlockingChain;
```

### Current Locks

```sql
-- Active locks on a specific database
SELECT
    l.resource_type,
    l.resource_description,
    l.resource_associated_entity_id,
    l.request_mode,
    l.request_status,
    l.request_session_id,
    OBJECT_NAME(p.object_id)    AS object_name
FROM sys.dm_tran_locks l
LEFT JOIN sys.partitions p
    ON l.resource_associated_entity_id = p.hobt_id
WHERE l.resource_database_id = DB_ID()
ORDER BY l.request_session_id, l.resource_type;
```

### Wait Stats for Lock Contention

```sql
-- Top wait types (snapshot since server restart)
SELECT TOP 20
    wait_type,
    wait_time_ms / 1000.0           AS wait_seconds,
    max_wait_time_ms / 1000.0       AS max_wait_seconds,
    waiting_tasks_count,
    CAST(100.0 * wait_time_ms / SUM(wait_time_ms) OVER () AS DECIMAL(5,2)) AS pct
FROM sys.dm_os_wait_stats
WHERE wait_type NOT IN (
    -- Benign waits (incomplete list; use sp_BlitzFirst for full exclusion list)
    'SLEEP_TASK','SQLTRACE_BUFFER_FLUSH','WAITFOR','LAZYWRITER_SLEEP',
    'BROKER_TO_FLUSH','CLR_AUTO_EVENT','DISPATCHER_QUEUE_SEMAPHORE',
    'FT_IFTS_SCHEDULER_IDLE_WAIT','HADR_FILESTREAM_IOMGR_IOCOMPLETION',
    'HADR_WORK_QUEUE','HADR_CLUSAPI_CALL','HADR_TIMER_TASK',
    'REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE','SERVER_IDLE_CHECK',
    'SLEEP_DBSTARTUP','SLEEP_DCOMSTARTUP','SLEEP_MASTERDBREADY',
    'SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED','SLEEP_MSDBSTARTUP',
    'SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP','SNI_HTTP_ACCEPT',
    'SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
    'WAIT_XTP_OFFLINE_CKPT_NEW_LOG','XE_DISPATCHER_WAIT','XE_TIMER_EVENT',
    'BROKER_EVENTHANDLER','CHECKPOINT_QUEUE','DBMIRROR_EVENTS_QUEUE',
    'SQLTRACE_WAIT_ENTRIES','WAIT_XTP_CKPT_CLOSE'
)
ORDER BY wait_time_ms DESC;
```

Key lock-related wait types:

| Wait Type | Meaning |
|---|---|
| `LCK_M_X` | Waiting for exclusive lock |
| `LCK_M_S` | Waiting for shared lock |
| `LCK_M_U` | Waiting for update lock |
| `LCK_M_IX` | Waiting for intent exclusive |
| `LCK_M_IS` | Waiting for intent shared |
| `LCK_M_SCH_M` | Waiting for schema modification lock (DDL vs DML) |
| `LCK_M_RIn_X` | Waiting for insert key-range exclusive (SERIALIZABLE) |
| `PAGELATCH_EX` | In-memory page latch (not disk I/O) — tempdb hotspot |

---

## Common Concurrency Patterns

### Optimistic Concurrency with rowversion

Detect and reject concurrent updates without holding locks:

```sql
-- Table with rowversion column
CREATE TABLE Products (
    ProductID   INT PRIMARY KEY,
    Name        NVARCHAR(100),
    Price       DECIMAL(10,2),
    RowVer      ROWVERSION  -- auto-updated on every modification
);

-- Application reads row and stores RowVer
-- Later, update only if no one else modified it:
UPDATE Products
SET Price = @newPrice
WHERE ProductID = @id
  AND RowVer = @capturedRowVer;   -- compare stored version

IF @@ROWCOUNT = 0
    THROW 50001, 'Record was modified by another user. Please refresh and retry.', 1;
```

### Serializable Upsert (no MERGE race condition)

```sql
BEGIN TRANSACTION;
    SELECT 1 FROM Configs WITH (UPDLOCK, HOLDLOCK)
    WHERE ConfigKey = @key;

    IF @@ROWCOUNT = 0
        INSERT INTO Configs (ConfigKey, ConfigValue) VALUES (@key, @value);
    ELSE
        UPDATE Configs SET ConfigValue = @value WHERE ConfigKey = @key;
COMMIT;
```

### Table-as-Queue with READPAST

Efficient queue consumer without blocking other consumers:

```sql
-- Consumer: dequeue one item at a time
DECLARE @id INT;
BEGIN TRANSACTION;
    SELECT TOP(1) @id = MessageID
    FROM MessageQueue WITH (UPDLOCK, ROWLOCK, READPAST)
    WHERE ProcessedAt IS NULL
    ORDER BY QueuedAt;

    IF @id IS NOT NULL
    BEGIN
        UPDATE MessageQueue SET ProcessedAt = SYSDATETIME()
        WHERE MessageID = @id;
        COMMIT;
        -- process message
    END
    ELSE
        ROLLBACK;
```

### Long-running Read with SNAPSHOT

```sql
-- Enable once at database level:
ALTER DATABASE Reporting SET ALLOW_SNAPSHOT_ISOLATION ON;

-- Reporting session:
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
BEGIN TRANSACTION;
    -- All reads see a consistent snapshot from this point
    SELECT * FROM Orders WHERE OrderDate >= '2024-01-01';
    SELECT * FROM OrderLines WHERE OrderDate >= '2024-01-01';
    -- Both queries see same committed state even if writers modify rows between them
COMMIT;
```

---

## Gotchas / Anti-patterns

1. **Forgotten open transactions.** `BEGIN TRANSACTION` without `COMMIT`/`ROLLBACK` keeps locks held indefinitely. Always use `TRY/CATCH` with `XACT_STATE()` checks. Monitor with `sys.dm_exec_sessions` (`open_transaction_count > 0`).

2. **NOLOCK everywhere is not "safe" — it's a different kind of wrong.** Dirty reads, torn pages, and double-reading moving rows are real production bugs. Enable RCSI instead.

3. **Inner ROLLBACK destroys the outer transaction.** In nested `BEGIN TRAN`/`COMMIT` patterns, a `ROLLBACK` always goes all the way back to the outermost transaction. Use savepoints for partial rollback.

4. **Implicit transactions left open by client rollback.** If a client disconnects without rolling back, SQL Server rolls back the transaction — but if the client app catches exceptions and swallows them, the transaction can remain open. Set `SET LOCK_TIMEOUT` and monitor for orphaned transactions.

5. **Isolation level is session-state, not connection string.** A connection pool may reuse a connection whose isolation level was changed by a previous caller. Explicitly set isolation level at the top of each stored procedure or application unit of work if this matters.

6. **SERIALIZABLE range locks slow down inserts, not just reads.** Under `SERIALIZABLE`, a range scan acquires key-range locks that block inserts into the scanned range. Use `SNAPSHOT` for consistent reads instead.

7. **Version store grows until the oldest active snapshot transaction commits.** A snapshot transaction that starts a long report and then is abandoned (app crash, client disconnect) keeps the version store from cleaning up. Set `LOCK_TIMEOUT` and application-level query timeouts.

8. **Lock escalation during batch DML.** Updating > 5,000 rows in a single statement triggers lock escalation to table-level X lock, blocking all other access. Batch large updates (500–2,000 rows per batch) to stay under threshold.

9. **UPDATE with implicit S→X promotion causes deadlocks.** Reading a row with a shared lock and then updating it allows two sessions to both acquire S, then both try to promote to X — deadlock. Always read with `UPDLOCK` if you plan to update.

10. **HOLDLOCK ≠ ROWLOCK.** `HOLDLOCK` means "hold this lock until transaction end" (= SERIALIZABLE behavior) but says nothing about granularity. Combine `WITH (UPDLOCK, ROWLOCK, HOLDLOCK)` to get row-level update locks held to end of transaction.

---

## See Also

- [`03-syntax-dml.md`](03-syntax-dml.md) — batching large DML to avoid lock escalation
- [`06-stored-procedures.md`](06-stored-procedures.md) — XACT_ABORT, EXECUTE AS context
- [`14-error-handling.md`](14-error-handling.md) — TRY/CATCH, XACT_STATE(), savepoints
- [`34-tempdb.md`](34-tempdb.md) — version store sizing, tempdb contention
- [`33-extended-events.md`](33-extended-events.md) — deadlock graph capture, blocking detection
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — wait stats, sp_BlitzFirst

---

## Sources

[^1]: [SET TRANSACTION ISOLATION LEVEL (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-transaction-isolation-level-transact-sql) — transaction isolation level syntax and behavior for all levels
[^2]: [Transaction locking and row versioning guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) — row versioning-based isolation levels and MVCC internals
[^3]: [sys.dm_tran_locks (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-tran-locks-transact-sql) — DMV for querying currently active lock manager resources
[^4]: [sys.dm_tran_active_snapshot_database_transactions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-tran-active-snapshot-database-transactions-transact-sql) — DMV for active snapshot transactions and version store usage
[^5]: [Transaction locking and row versioning guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) — comprehensive locking and row versioning reference including lock compatibility, escalation, and deadlocks
[^6]: [A SQL Server DBA myth a day: (23/30) lock escalation](https://www.sqlskills.com/blogs/paul/a-sql-server-dba-myth-a-day-2330-lock-escalation/) — Paul Randal debunks the row-to-page-to-table escalation myth, explains the 5000-lock threshold, trace flags 1211/1224, and per-table LOCK_ESCALATION options (TABLE/AUTO/DISABLE) introduced in SQL Server 2008
[^7]: [NOLOCK Is Bad And You Probably Shouldn't Use It](https://www.brentozar.com/archive/2021/11/nolock-is-bad-and-you-probably-shouldnt-use-it/) — why NOLOCK causes wrong results beyond dirty reads, and alternatives like RCSI
[^8]: [The SNAPSHOT Isolation Level](https://sqlperformance.com/2014/06/sql-performance/the-snapshot-isolation-level) — Paul White on SNAPSHOT isolation internals, row versioning mechanics, write skew vulnerabilities, and conflict detection behavior
[^9]: [Deadlocks guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-deadlocks-guide) — deadlock detection, analysis, prevention strategies, and deadlock graph interpretation
[^10]: [ALTER DATABASE SET options (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options) — database-level options including ALLOW_SNAPSHOT_ISOLATION and READ_COMMITTED_SNAPSHOT

# 18 — In-Memory OLTP (Hekaton)

SQL Server's In-Memory OLTP engine (code-named Hekaton) stores tables entirely
in memory with an optimistic, lock-free concurrency model. It eliminates latch
contention on shared data structures and enables natively compiled stored
procedures that execute as machine code. Used correctly it can reduce latency by
10×–30× for high-concurrency insert/update workloads; used incorrectly it adds
operational complexity with minimal gain.

---

## Table of Contents

1. [When to Use](#when-to-use)
2. [Architecture Overview](#architecture-overview)
3. [Enabling In-Memory OLTP](#enabling-in-memory-oltp)
4. [Memory-Optimized Tables](#memory-optimized-tables)
5. [Hash Indexes](#hash-indexes)
6. [Range Indexes (Bw-Tree)](#range-indexes-bw-tree)
7. [Natively Compiled Stored Procedures](#natively-compiled-stored-procedures)
8. [Durability Options](#durability-options)
9. [Transactions and Concurrency](#transactions-and-concurrency)
10. [Supported vs Unsupported Features](#supported-vs-unsupported-features)
11. [Interoperability with Disk-Based Tables](#interoperability-with-disk-based-tables)
12. [Migration Patterns](#migration-patterns)
13. [Monitoring and Diagnostics](#monitoring-and-diagnostics)
14. [Maintenance](#maintenance)
15. [Gotchas / Anti-Patterns](#gotchas--anti-patterns)
16. [See Also](#see-also)
17. [Sources](#sources)

---

## When to Use

**Good fit:**

- High-concurrency point lookups and inserts on narrow, well-defined tables
  (session state, shopping carts, leaderboards, queue tables, rate-limit
  counters)
- Latch contention on allocation pages (GAM/SGAM/PFS) in tempdb or user
  databases — in-memory tables have no page allocation
- Hot tables with frequent single-row updates and no long-running transactions
- Natively compiled procs for business-critical short, repeatable operations

**Poor fit:**

- Large tables (> available RAM); In-Memory OLTP has no paging — the whole
  table must fit in memory
- Ad-hoc analytical queries or full table scans (no columnstore indexes on
  memory-optimized tables in most editions [^1])
- Tables with many unsupported features (see below) that would require
  rewriting surrounding code
- Heavy schema churn — ALTER TABLE on memory-optimized tables is limited and
  often requires offline rebuild

> [!NOTE] SQL Server 2014
> In-Memory OLTP was introduced in SQL Server 2014. Features have expanded
> significantly through 2016, 2017, 2019, and 2022.

---

## Architecture Overview

```
Memory-Optimized Table
┌─────────────────────────────────────────────────────┐
│  Version store (multi-version rows in memory)       │
│  No pages, no latches, no buffer pool               │
│  Lock-free: optimistic concurrency (MVCC)           │
│  Indexes: hash (bucket array) or Bw-Tree (range)    │
│  Checkpoint pairs: delta + data files on disk       │
└─────────────────────────────────────────────────────┘
         │
         │ (persisted, async)
         ▼
Checkpoint Files (FILESTREAM container)
  - Data file: rows committed before checkpoint
  - Delta file: rows deleted since last data file
```

**Key architectural properties:**

| Property | In-Memory OLTP | Disk-Based Table |
|---|---|---|
| Storage | Memory (version store) | Buffer pool → disk |
| Concurrency | Lock-free MVCC | Lock-based + MVCC |
| Latch contention | None | Yes (page latches) |
| Row versions | In-memory linked list | Version store in tempdb |
| Transaction log | Writes still go to log | Same |
| Durability | Full or SCHEMA_ONLY | Full |
| Index types | Hash, Bw-Tree | B-tree, Columnstore |
| Row size limit | 8,060 bytes (off-row since 2016) | 8,060 on-row + off-row |

> [!NOTE] SQL Server 2016
> Off-row storage for LOB columns in memory-optimized tables was introduced in
> 2016, removing the previous 8,060-byte hard limit on total row size.

---

## Enabling In-Memory OLTP

### Step 1 — Add a MEMORY_OPTIMIZED_DATA filegroup

```sql
-- Add a memory-optimized filegroup (one per database; required)
ALTER DATABASE [YourDB]
ADD FILEGROUP [YourDB_MemOpt]
CONTAINS MEMORY_OPTIMIZED_DATA;

-- Add a container (OS folder) to the filegroup
ALTER DATABASE [YourDB]
ADD FILE (
    NAME = 'YourDB_MemOpt_Container',
    FILENAME = 'C:\SQLData\YourDB_MemOpt'  -- must be a folder path, not a file
)
TO FILEGROUP [YourDB_MemOpt];
```

### Step 2 — Verify

```sql
SELECT  fg.name                  AS filegroup_name,
        fg.type_desc,
        f.physical_name
FROM    sys.filegroups fg
JOIN    sys.database_files f
          ON  f.data_space_id = fg.data_space_id
WHERE   fg.type = 'FX';  -- FX = MEMORY_OPTIMIZED_DATA
```

---

## Memory-Optimized Tables

```sql
CREATE TABLE dbo.SessionState
(
    SessionId     UNIQUEIDENTIFIER NOT NULL,
    UserId        INT              NOT NULL,
    CreatedUtc    DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    ExpiresUtc    DATETIME2(3)     NOT NULL,
    StateData     VARBINARY(MAX)   NULL,

    -- Every memory-optimized table must have a primary key
    CONSTRAINT PK_SessionState PRIMARY KEY NONCLUSTERED HASH
        (SessionId) WITH (BUCKET_COUNT = 131072),  -- must be power of 2

    -- Optional additional index
    INDEX IX_SessionState_Expires NONCLUSTERED (ExpiresUtc)
)
WITH (MEMORY_OPTIMIZED = ON, DURABILITY = SCHEMA_AND_DATA);
```

**Required clauses:**

| Clause | Values | Notes |
|---|---|---|
| `MEMORY_OPTIMIZED` | `ON` | Mandatory |
| `DURABILITY` | `SCHEMA_AND_DATA` \| `SCHEMA_ONLY` | See [Durability Options](#durability-options) |
| Primary key | Must exist | No PK → DDL error |
| Index declaration | Inline only | Cannot `CREATE INDEX` separately after creation |

> [!WARNING] Deprecated
> `DURABILITY = SCHEMA_ONLY` tables lose all rows on server restart. They are
> still supported in SQL Server 2022 but consider them "volatile cache" tables
> only — not a replacement for proper caching layers.

---

## Hash Indexes

Hash indexes provide O(1) point lookup by exact equality on the index key. They
are **useless for range queries and ORDER BY**.

```sql
-- Declare inline with NONCLUSTERED HASH
INDEX IX_Hash_UserId NONCLUSTERED HASH (UserId)
WITH (BUCKET_COUNT = 65536)
```

### Choosing BUCKET_COUNT

`BUCKET_COUNT` must be a **power of 2**. The engine does not resize it; choosing
wrong means either wasted memory (too large) or heavy chain collisions (too
small).

| Heuristic | Guidance |
|---|---|
| Starting point | 1× to 2× the expected number of distinct key values |
| Max useful size | 2× distinct values — above that, empty buckets waste memory |
| Min useful size | 0.5× distinct values — below that, average chain > 2, scans degrade |
| After data grows | Must offline-rebuild table to change BUCKET_COUNT |

```sql
-- Check chain length distribution after load
SELECT  total_bucket_count,
        empty_bucket_count,
        avg_chain_length,
        max_chain_length
FROM    sys.dm_db_xtp_hash_index_stats s
JOIN    sys.indexes i
          ON  i.object_id = s.object_id
          AND i.index_id  = s.index_id
WHERE   OBJECT_NAME(s.object_id) = 'SessionState';
```

Healthy distribution: `avg_chain_length` ≤ 2, `empty_bucket_count` ≥ 33% of
`total_bucket_count`. If `avg_chain_length` > 5, double the `BUCKET_COUNT`.

---

## Range Indexes (Bw-Tree)

`NONCLUSTERED` indexes on memory-optimized tables use the Bw-Tree (Blink-tree
variant) — a lock-free B-tree that supports range queries, ORDER BY, and
inequality predicates.

```sql
-- Range index — supports >=, <=, BETWEEN, ORDER BY
INDEX IX_Range_ExpiresUtc NONCLUSTERED (ExpiresUtc ASC)
```

| Use case | Index type |
|---|---|
| Exact equality lookup (PK, unique id) | Hash |
| Range scan, `<`, `>`, `BETWEEN` | Bw-Tree (NONCLUSTERED) |
| ORDER BY without SORT operator | Bw-Tree |
| Covering index (included columns) | Not supported — use key columns only [^2] |

> [!NOTE] SQL Server 2019
> Non-clustered columnstore indexes on memory-optimized tables are supported in
> SQL Server 2019+ Enterprise Edition, enabling real-time analytics
> (HTAP) on Hekaton tables. [^3]

---

## Natively Compiled Stored Procedures

Natively compiled procedures are compiled to machine code (DLL) at creation
time. They execute without SQL/T-SQL interpreter overhead, enabling sub-
millisecond latency for simple OLTP operations.

```sql
CREATE OR ALTER PROCEDURE dbo.usp_UpsertSession
    @SessionId  UNIQUEIDENTIFIER,
    @UserId     INT,
    @ExpiresUtc DATETIME2(3),
    @StateData  VARBINARY(MAX)
WITH NATIVE_COMPILATION, SCHEMABINDING
AS
BEGIN ATOMIC
WITH (TRANSACTION ISOLATION LEVEL = SNAPSHOT, LANGUAGE = N'us_english')

    -- MERGE is not supported in natively compiled procs
    -- Use DELETE + INSERT pattern for upsert
    DELETE FROM dbo.SessionState WHERE SessionId = @SessionId;

    INSERT INTO dbo.SessionState
        (SessionId, UserId, ExpiresUtc, StateData)
    VALUES
        (@SessionId, @UserId, @ExpiresUtc, @StateData);

END;
```

### Required clauses

| Clause | Required | Notes |
|---|---|---|
| `WITH NATIVE_COMPILATION` | Yes | Triggers compile-to-DLL at CREATE |
| `SCHEMABINDING` | Yes | Objects cannot be altered while proc exists |
| `BEGIN ATOMIC ... END` | Yes | Implicit transaction; ROLLBACK on error |
| `TRANSACTION ISOLATION LEVEL` | Yes (in ATOMIC block) | Must specify explicitly |
| `LANGUAGE` | Yes (in ATOMIC block) | Sets date format etc. |

### BEGIN ATOMIC semantics

- `BEGIN ATOMIC` declares an implicit transaction — no `BEGIN TRAN` needed or
  allowed
- On any error inside the block, the entire ATOMIC block rolls back
- Cannot nest ATOMIC blocks
- `SAVE TRANSACTION` not supported inside ATOMIC blocks

### Isolation levels available in natively compiled procs

| Level | Notes |
|---|---|
| `SNAPSHOT` | Default recommendation; no latch/lock contention |
| `REPEATABLE READ` | Prevents phantom reads; higher abort rate |
| `SERIALIZABLE` | Highest isolation; most write-write conflicts |

---

## Durability Options

| DURABILITY | Rows survive restart? | Log writes | Use case |
|---|---|---|---|
| `SCHEMA_AND_DATA` | Yes | Full log records | Persistent data |
| `SCHEMA_ONLY` | No — lost on restart | No row-level logging | Pure in-memory cache, rate limiting, temp staging |

```sql
-- SCHEMA_ONLY: session cache (rows intentionally volatile)
CREATE TABLE dbo.RateLimitCounters
(
    ClientId   INT      NOT NULL,
    WindowEnd  DATETIME2 NOT NULL,
    HitCount   INT      NOT NULL,
    CONSTRAINT PK_RateLimit PRIMARY KEY NONCLUSTERED HASH
        (ClientId) WITH (BUCKET_COUNT = 8192)
)
WITH (MEMORY_OPTIMIZED = ON, DURABILITY = SCHEMA_ONLY);
```

**SCHEMA_AND_DATA checkpoint mechanics:**

- Pairs of data/delta files written to the MEMORY_OPTIMIZED_DATA filegroup
  container
- Checkpoint is triggered by log growth thresholds (not on a timer like regular
  checkpoints)
- Recovery: SQL Server replays data/delta checkpoint file pairs, then any
  uncommitted log records — startup can be slow for large in-memory tables [^4]
- Recovery time is proportional to the volume of unflushed data and log records

---

## Transactions and Concurrency

In-Memory OLTP uses optimistic multi-version concurrency — no locks, no
latches. Conflicts are detected at commit time.

### Validation at commit

The engine validates each transaction at commit for three conflict types:

| Conflict | Description | Error |
|---|---|---|
| Write-write | Two transactions updated the same row | 41302 |
| Phantom | A serializable read is invalidated by another commit | 41325 |
| Commit dependency | A transaction read a row written by an uncommitted transaction that later rolled back | 41301 |

All three require **retry logic** in the calling application or T-SQL wrapper.

```sql
-- Retry wrapper for natively compiled proc calls
DECLARE @retry INT = 0;
WHILE @retry < 5
BEGIN
    BEGIN TRY
        EXEC dbo.usp_UpsertSession
            @SessionId  = @sid,
            @UserId     = @uid,
            @ExpiresUtc = @exp,
            @StateData  = @data;
        BREAK; -- success
    END TRY
    BEGIN CATCH
        IF ERROR_NUMBER() IN (41302, 41305, 41325, 41301, 1205)
        BEGIN
            SET @retry += 1;
            IF @retry >= 5 THROW; -- rethrow after 5 attempts
        END
        ELSE THROW; -- non-retryable error
    END CATCH
END
```

### Cross-container transactions

A single T-SQL transaction can span both memory-optimized and disk-based tables,
but with restrictions:

- Memory-optimized table side uses SNAPSHOT isolation regardless of the session
  isolation level setting
- Disk-based table side uses the normal session isolation level
- Interaction can cause surprising behavior — read the disk-based table with
  SNAPSHOT isolation explicitly when mixing

---

## Supported vs Unsupported Features

### Memory-optimized tables

| Feature | Supported |
|---|---|
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` | Yes |
| `MERGE` | No (use DELETE + INSERT) |
| `TRUNCATE TABLE` | Yes (2016+) |
| Triggers | No |
| Foreign keys | No |
| Computed columns | No (2014–2016); Yes with limitations (2017+) |
| `CHECK` constraints | Yes (2014+) |
| `DEFAULT` constraints | Yes |
| `UNIQUE` constraints | Yes |
| LOB columns (MAX) | Yes (off-row since 2016) |
| Sparse columns | No |
| Columnstore indexes | Yes (Enterprise, 2019+) |
| Replication | No (subscriber only via workaround) |
| Change Tracking | No |
| CDC | No |
| Stretch Database | No (deprecated) |
| Parallel plans | No (memory-optimized scans are serial) |
| `ALTER TABLE ADD COLUMN` | Limited (see below) |

> [!NOTE] SQL Server 2017
> Computed columns on memory-optimized tables were added in 2017 with
> restrictions: persisted computed columns only, no system functions like
> GETDATE(). [^5]

### ALTER TABLE on memory-optimized tables

| Operation | Online? | Notes |
|---|---|---|
| Add nullable column with DEFAULT | Yes | No table rebuild |
| Add NOT NULL column | No | Requires offline rebuild |
| Drop column | No | Requires offline rebuild |
| Add index | No | Indexes are inline at CREATE; must rebuild table |
| Rename column | No | Requires offline rebuild |
| Change data type | No | Drop + recreate |

**Offline rebuild pattern:**

```sql
-- 1. Create new table with desired schema
-- 2. Insert data from old table
-- 3. Rename tables (or drop old + rename new)
--    Must disable any procs/views that reference the table first (SCHEMABINDING)

-- Example: rename-swap
EXEC sp_rename 'dbo.SessionState',     'SessionState_old';
EXEC sp_rename 'dbo.SessionState_new', 'SessionState';
```

### Natively compiled stored procedures — unsupported T-SQL

| Feature | Unsupported in Natively Compiled Procs |
|---|---|
| `RAISERROR` | Use `THROW` instead |
| `SAVE TRANSACTION` | Not supported |
| `@@TRANCOUNT` | Not available |
| `TRY/CATCH` | Not supported inside `BEGIN ATOMIC` |
| `CURSOR` | Not supported |
| `EXEC` (dynamic SQL) | Not supported |
| `MERGE` | Not supported |
| Temp tables | Not supported (use table variables with memory-optimized type) |
| Subqueries | Limited support; some forms unsupported pre-2019 |
| Outer joins | Supported from 2016+ |
| Aggregates in subqueries | Supported from 2016+ |

> [!NOTE] SQL Server 2019
> Many T-SQL constructs previously unsupported in natively compiled procs were
> added in 2019 under the Hekaton "surface area expansion" initiative, including
> `SELECT DISTINCT`, `UNION/UNION ALL`, `ORDER BY` with aggregates, and
> additional string functions. [^6]

---

## Interoperability with Disk-Based Tables

```sql
-- Interpreted T-SQL proc accessing both table types
-- (not natively compiled, but still benefits from lock-free access to IM table)
CREATE OR ALTER PROCEDURE dbo.usp_CreateOrder
    @UserId     INT,
    @SessionId  UNIQUEIDENTIFIER,
    @Amount     DECIMAL(18,2)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    -- Memory-optimized table — lock-free, uses SNAPSHOT isolation
    DELETE FROM dbo.SessionState WHERE SessionId = @SessionId;

    -- Disk-based table — normal locking
    INSERT INTO dbo.Orders (UserId, Amount, CreatedUtc)
    VALUES (@UserId, @Amount, SYSUTCDATETIME());

    COMMIT;
END;
```

**Rules for cross-container transactions:**

1. If an interpreted transaction touches a memory-optimized table with
   `REPEATABLE READ` or `SERIALIZABLE` session isolation, SQL Server
   automatically uses SNAPSHOT on the IM table side
2. You can specify isolation hints on memory-optimized tables:
   `WITH (SNAPSHOT)`, `WITH (REPEATABLEREAD)`, `WITH (SERIALIZABLE)` — but not
   `NOLOCK`, `UPDLOCK`, `ROWLOCK`, or `HOLDLOCK` (row-level hints are irrelevant
   for lock-free tables)
3. `READUNCOMMITTED` / `NOLOCK` on a memory-optimized table is silently treated
   as SNAPSHOT — there are no dirty reads because the engine always shows
   committed rows

---

## Migration Patterns

### Assessment — AMR tool

Use the **In-Memory OLTP Migration Assessment** tool (included in SSMS) or query
DMVs to find candidate tables:

```sql
-- Tables with high contention — potential IM OLTP candidates
SELECT  TOP 20
        OBJECT_NAME(s.object_id) AS table_name,
        s.row_lock_wait_count,
        s.row_lock_wait_in_ms,
        s.page_lock_wait_count,
        s.page_lock_wait_in_ms
FROM    sys.dm_db_index_operational_stats(DB_ID(), NULL, NULL, NULL) s
ORDER BY s.row_lock_wait_in_ms DESC;
```

### Checklist for migrating a disk-based table to memory-optimized

1. **Identify blockers** — foreign keys, triggers, unsupported data types
   (geography, xml, sql_variant, computed columns pre-2017)
2. **Remove or re-implement blockers** — move FK enforcement to application or
   a separate disk-based "integrity" table
3. **Choose BUCKET_COUNT** for hash indexes based on expected distinct values
4. **Choose DURABILITY** — `SCHEMA_AND_DATA` unless the table is purely volatile
5. **Estimate memory footprint** — use `sys.dm_db_xtp_table_memory_stats`
6. **Plan for retry logic** — write-write conflicts will happen under load
7. **Update Statistics** — IM OLTP tables use their own statistics mechanism
8. **Monitor post-migration** using `sys.dm_db_xtp_*` DMVs

### Memory footprint estimation

```sql
-- After creating and loading the table
SELECT  OBJECT_NAME(object_id)   AS table_name,
        memory_allocated_for_table_kb,
        memory_used_by_table_kb,
        memory_allocated_for_indexes_kb,
        memory_used_by_indexes_kb
FROM    sys.dm_db_xtp_table_memory_stats
WHERE   object_id > 0
ORDER BY memory_used_by_table_kb DESC;
```

Rule of thumb for initial sizing: actual row data + version rows (up to 2× for
active update workloads) + hash index buckets (BUCKET_COUNT × 8 bytes per
bucket).

---

## Monitoring and Diagnostics

### Key DMVs

| DMV | Purpose |
|---|---|
| `sys.dm_db_xtp_table_memory_stats` | Per-table memory usage |
| `sys.dm_db_xtp_hash_index_stats` | Hash index chain lengths |
| `sys.dm_db_xtp_index_stats` | Index operation counts (scans, seeks, etc.) |
| `sys.dm_xtp_system_memory_consumers` | Hekaton system memory breakdown |
| `sys.dm_db_xtp_object_stats` | Row-level operations (inserts, updates, deletes, aborts) |
| `sys.dm_db_xtp_transactions` | Active IM OLTP transactions |
| `sys.dm_xtp_gc_stats` | Garbage collection stats |

```sql
-- Transaction conflict / abort rates
SELECT  OBJECT_NAME(object_id) AS table_name,
        row_insert_attempts,
        row_insert_failures,
        row_update_attempts,
        row_update_failures,
        row_delete_attempts,
        row_delete_failures
FROM    sys.dm_db_xtp_object_stats
WHERE   object_id > 0
ORDER BY row_update_failures DESC;
```

```sql
-- Garbage collector pressure
SELECT  current_version_record_count,
        sweep_expired_rows_removed,
        sweep_expired_index_entries_removed
FROM    sys.dm_xtp_gc_stats;
```

### Performance Monitor counters (PerfMon)

| Counter object | Counter | Healthy signal |
|---|---|---|
| SQL Server: XTP Storage | Checkpoints Issued | Low and stable |
| SQL Server: XTP Transactions | Transactions Aborted/sec | Near zero for good schema design |
| SQL Server: XTP Transactions | Transaction Validation Failures/sec | Near zero |
| SQL Server: XTP Cursors | Expired rows touched/sec | Low |
| SQL Server: Memory Manager | Memory grants outstanding | — |

---

## Maintenance

### Garbage collection

The IM OLTP engine has a background garbage collector that reclaims memory from
old row versions. It runs automatically. If you see `current_version_record_count`
growing without bound, check for:

- Long-running transactions that are pinning old versions (query
  `sys.dm_db_xtp_transactions` for `transaction_begin_lsn`)
- High update rate generating versions faster than GC removes them

### Checkpoint file management

```sql
-- Monitor checkpoint file usage
SELECT  state_desc,
        COUNT(*)        AS file_count,
        SUM(file_size_in_bytes) / 1048576.0 AS total_mb
FROM    sys.dm_db_xtp_checkpoint_files
GROUP BY state_desc;
```

Checkpoint files accumulate over time; SQL Server merges them automatically
based on a merge policy. If they grow unbounded:

1. Ensure recovery model is FULL and log backups are current
2. Run `CHECKPOINT` to flush dirty pages (triggers merge evaluation)
3. Check for orphaned checkpoint files from failed operations

### Rebuilding memory-optimized tables

There is no `ALTER INDEX ... REBUILD` for IM OLTP indexes. To defragment:

```sql
-- The only way to rebuild IM OLTP indexes is to rebuild the table
-- Use offline rename-swap approach (see ALTER TABLE section above)
-- Or: for Bw-Tree indexes, fragmentation is self-healing (merge cascades)
```

---

## Gotchas / Anti-Patterns

1. **BUCKET_COUNT wrong at creation** — The engine does not auto-resize hash
   index buckets. Monitor `avg_chain_length` after load and before go-live.
   Rebuilding the table offline to fix BUCKET_COUNT is painful in production.

2. **No retry logic** — Write-write conflicts (error 41302) are normal under
   concurrent load. Any application or proc that modifies IM OLTP tables must
   implement retry. Without it, one busy transaction will cause cascading
   failures.

3. **Memory pressure kills the instance** — Unlike the buffer pool, IM OLTP
   memory is not automatically trimmed under pressure. If you load more data
   than the max server memory allows, the engine will return out-of-memory
   errors (41805). Set `max server memory` conservatively and leave headroom.

4. **Durability = SCHEMA_ONLY is invisible** — Tables exist after CREATE but all
   rows are silently lost on any server restart, including planned failover to an
   AG secondary. Document `SCHEMA_ONLY` tables explicitly in runbooks.

5. **Recovery time with large tables** — A 50 GB IM OLTP table can take
   30+ minutes to recover at startup. This affects RTO calculations. [^4]

6. **No parallel plans** — Memory-optimized table scans always execute serially.
   If your workload needs parallel scans (large range queries), IM OLTP is the
   wrong tool.

7. **Cross-container isolation surprises** — A disk-based transaction reading a
   memory-optimized table sees the state as of that transaction's begin time
   (SNAPSHOT). If you're expecting READ COMMITTED semantics (see latest committed
   row), you will be surprised.

8. **Natively compiled procs are DLL files** — They live in the file system
   under the MEMORY_OPTIMIZED_DATA container. Dropping and recreating the proc
   deletes and recreates the DLL. There is no "ALTER" — `CREATE OR ALTER` recompiles
   the whole proc.

9. **Statistics are not auto-updated the same way** — IM OLTP statistics use a
   separate mechanism. Run `UPDATE STATISTICS` manually after bulk loads; the
   standard auto-update threshold does not apply. [^7]

10. **CDC and Change Tracking not supported** — If downstream consumers depend
    on CDC or CT for incremental ETL, you cannot simply migrate those source
    tables to IM OLTP. Use table-as-queue patterns or Service Broker instead, or
    keep the source table on disk and use IM OLTP only for the hot OLTP layer.

> [!NOTE] SQL Server 2022
> SQL Server 2022 improved In-Memory OLTP memory management for large-memory
> servers but did not expand the T-SQL surface area for natively compiled
> modules. [^8]

---

## See Also

- [`08-indexes.md`](08-indexes.md) — disk-based index fundamentals
- [`09-columnstore-indexes.md`](09-columnstore-indexes.md) — columnstore on
  memory-optimized tables (HTAP pattern)
- [`13-transactions-locking.md`](13-transactions-locking.md) — isolation levels,
  MVCC, lock escalation
- [`34-tempdb.md`](34-tempdb.md) — latch contention (the problem IM OLTP solves
  for high-contention scenarios)
- [`14-error-handling.md`](14-error-handling.md) — error handling patterns,
  THROW vs RAISERROR (natively compiled procs require THROW)
- [`49-configuration-tuning.md`](49-configuration-tuning.md) — max server memory
  configuration (critical for IM OLTP sizing)

---

## Sources

[^1]: [Indexes for Memory-Optimized Tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/indexes-for-memory-optimized-tables) — covers hash and nonclustered (Bw-Tree) index types, syntax, and behavior for memory-optimized tables including columnstore index support
[^2]: [Indexes for Memory-Optimized Tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/indexes-for-memory-optimized-tables) — documents that memory-optimized indexes do not support INCLUDE columns; all index key columns must be declared inline at CREATE TABLE
[^3]: [Get started with columnstore for real-time operational analytics - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/get-started-with-columnstore-for-real-time-operational-analytics) — covers the HTAP pattern combining In-Memory OLTP tables with columnstore indexes for real-time operational analytics
[^4]: [Restore and recovery of memory-optimized tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/restore-and-recovery-of-memory-optimized-tables) — documents recovery phases and factors that affect load time for memory-optimized tables at startup, including I/O bandwidth and data volume
[^5]: [What's New in SQL Server 2017](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2017) — documents In-Memory enhancements including computed column support for memory-optimized tables; see also [Migrating Computed Columns](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/migrating-computed-columns) for workaround patterns and restrictions.
[^6]: [Features for natively compiled T-SQL modules - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/supported-features-for-natively-compiled-t-sql-modules) — lists T-SQL surface area supported in natively compiled procs including expansions added in SQL Server 2016 and 2017 (SELECT DISTINCT, UNION/UNION ALL, JOINs, string functions)
[^7]: [Statistics for Memory-Optimized Tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/statistics-for-memory-optimized-tables) — documents that automatic statistics update for memory-optimized tables requires compatibility level 130+, and that natively compiled procs require manual recompile after statistics updates
[^8]: [What's New in SQL Server 2022](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2022) — documents In-Memory OLTP improvement as memory management for large-memory servers; no natively compiled proc surface area expansions were added in SQL Server 2022.

# 27 — Cursors

## Table of Contents

1. [When to Use](#when-to-use)
2. [Cursor Types](#cursor-types)
3. [Cursor Scope: LOCAL vs GLOBAL](#cursor-scope-local-vs-global)
4. [Cursor Lifecycle](#cursor-lifecycle)
5. [FAST_FORWARD (Recommended Default)](#fast_forward-recommended-default)
6. [STATIC Cursors](#static-cursors)
7. [KEYSET Cursors](#keyset-cursors)
8. [DYNAMIC Cursors](#dynamic-cursors)
9. [FORWARD_ONLY vs SCROLL](#forward_only-vs-scroll)
10. [Cursor Options Reference Table](#cursor-options-reference-table)
11. [SET-Based Alternatives](#set-based-alternatives)
12. [When Cursors Are Legitimate](#when-cursors-are-legitimate)
13. [Performance Cost](#performance-cost)
14. [Nested Cursors](#nested-cursors)
15. [Cursor Metadata and Monitoring](#cursor-metadata-and-monitoring)
16. [Common Patterns](#common-patterns)
17. [Gotchas / Anti-Patterns](#gotchas--anti-patterns)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

**Default answer: don't.** SQL Server is optimized for set-based operations. Cursors serialize processing, disable batch execution, and scale linearly with row count. Most cursor use cases have a superior set-based equivalent.

**Consider a cursor only when:**

| Scenario | Why cursor may be acceptable |
|---|---|
| Row-by-row administrative tasks (DBCC, BACKUP per database) | No set-based equivalent exists |
| Calling a stored procedure once per row where the proc cannot accept a set | Can't batch-parameterize the proc call |
| Generating complex sequential output where order is intrinsic | Report generation driven by cursor state |
| Hierarchical tree traversal where recursive CTE is inadequate | Deep or irregular trees with side-effect operations |
| DBA maintenance scripts (rebuild only fragmented indexes) | Each object needs its own DDL statement |

**Never use a cursor to:** replace a JOIN, perform row-by-row aggregation, implement MERGE logic, or apply the same UPDATE to all rows.

---

## Cursor Types

SQL Server supports four cursor population models (implementation types):

| Type | Population | Sees Changes | Isolation | Memory | Scroll |
|---|---|---|---|---|---|
| **STATIC** | Full copy into tempdb at OPEN | No | Snapshot at open | High | Yes |
| **KEYSET** | Key set into tempdb at OPEN | Updates to non-key cols | Membership frozen | Medium | Yes |
| **DYNAMIC** | No population — reads live data | All inserts/updates/deletes | Like dirty read | Low | Yes (but ORDER unreliable) |
| **FAST_FORWARD** | Forward-only read-ahead | No | READ COMMITTED | Very low | No |

> [!NOTE] Default behavior
> If you omit the type keyword, SQL Server chooses the cheapest type that satisfies your options — which is usually FAST_FORWARD for simple forward-only cursors. Always specify the type explicitly to avoid surprises.

---

## Cursor Scope: LOCAL vs GLOBAL

```sql
-- LOCAL: visible only within current batch/proc/trigger
DECLARE my_cursor CURSOR LOCAL FAST_FORWARD FOR ...

-- GLOBAL: visible to any batch in the connection until connection closes
DECLARE my_cursor CURSOR GLOBAL FAST_FORWARD FOR ...
```

**Always use LOCAL.** Global cursors persist across batch boundaries, cause name conflicts, and are a common source of "cursor already exists" errors.

The server-level default is controlled by `sp_configure 'default to local cursor'`. On most instances this is OFF (global default), but you should always be explicit.

```sql
-- Check current default
SELECT name, value_in_use
FROM sys.configurations
WHERE name = 'default to local cursor';
```

---

## Cursor Lifecycle

Every cursor follows a strict lifecycle:

```sql
-- 1. Declare
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT col1, col2
    FROM dbo.SomeTable
    WHERE condition = 1
    ORDER BY col1;

-- 2. Open (populates STATIC/KEYSET into tempdb, or positions DYNAMIC/FAST_FORWARD)
OPEN cur;

-- 3. Fetch first row
FETCH NEXT FROM cur INTO @col1, @col2;

-- 4. Process loop
WHILE @@FETCH_STATUS = 0
BEGIN
    -- do work with @col1, @col2

    FETCH NEXT FROM cur INTO @col1, @col2;
END;

-- 5. Close (releases row set, but cursor structure stays in scope)
CLOSE cur;

-- 6. Deallocate (releases the cursor data structure and name)
DEALLOCATE cur;
```

**@@FETCH_STATUS values:**

| Value | Meaning |
|---|---|
| 0 | Row successfully fetched |
| -1 | Fetch failed (beyond end, or error) |
| -2 | Row fetched was deleted (KEYSET cursors only) |
| -9 | Cursor not open |

> [!WARNING] Missing DEALLOCATE
> CLOSE alone does not free the cursor name or resources. Always pair CLOSE with DEALLOCATE. In stored procedures, use TRY/CATCH with CLOSE/DEALLOCATE in the CATCH block and check `CURSOR_STATUS()` first.

---

## FAST_FORWARD (Recommended Default)

FAST_FORWARD is the best-performing cursor type for sequential read workloads:

```sql
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT database_id, name
    FROM sys.databases
    WHERE state_desc = 'ONLINE'
    ORDER BY name;

DECLARE @db_id INT, @db_name SYSNAME;

OPEN cur;
FETCH NEXT FROM cur INTO @db_id, @db_name;

WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT N'Processing: ' + @db_name;
    -- EXEC some_proc @db_id; etc.

    FETCH NEXT FROM cur INTO @db_id, @db_name;
END;

CLOSE cur;
DEALLOCATE cur;
```

**FAST_FORWARD is equivalent to `FORWARD_ONLY READ_ONLY OPTIMISTIC`.** It uses a read-ahead optimization internally. You cannot FETCH PRIOR, FIRST, LAST, or ABSOLUTE with this type.

---

## STATIC Cursors

STATIC copies the entire result set into a work table in tempdb at OPEN time. Subsequent fetches read from the copy, not the base table.

```sql
DECLARE cur CURSOR LOCAL STATIC FOR
    SELECT employee_id, salary
    FROM dbo.Employees
    ORDER BY employee_id;
```

**Use STATIC when:**
- You need scrollable access (FETCH PRIOR, FIRST, LAST, ABSOLUTE n, RELATIVE n)
- You want an isolated snapshot of data that cannot change during cursor processing
- The result set is small (tempdb cost is acceptable)

**Avoid STATIC when:**
- The result set is large — the full copy goes into tempdb, impacting tempdb I/O and version store

```sql
-- Scroll backwards example
FETCH PRIOR FROM cur INTO @col1;
FETCH FIRST FROM cur INTO @col1;
FETCH ABSOLUTE 5 FROM cur INTO @col1;   -- go to row 5
FETCH RELATIVE -2 FROM cur INTO @col1; -- go back 2 rows
```

---

## KEYSET Cursors

KEYSET copies only the keys of the qualifying rows into tempdb at OPEN time. Non-key column values are read from the base table on each fetch.

```sql
DECLARE cur CURSOR LOCAL KEYSET FOR
    SELECT order_id, customer_id, order_date
    FROM dbo.Orders
    WHERE status = 'PENDING'
    ORDER BY order_date;
```

**Behavior:**
- Rows inserted into the base table after OPEN are **not visible**
- Rows deleted from the base table return `@@FETCH_STATUS = -2` (row was deleted)
- Non-key column updates **are visible** (fetches current values from the base table)
- Requires a unique index on the base table (falls back to STATIC if none exists)

**Rarely needed.** The partial-visibility semantics (sees updates but not inserts/deletes) are confusing and usually unintentional. Prefer STATIC for snapshots or FAST_FORWARD for streaming.

---

## DYNAMIC Cursors

DYNAMIC reads directly from the base tables on every fetch — no tempdb population:

```sql
DECLARE cur CURSOR LOCAL DYNAMIC FOR
    SELECT order_id, status
    FROM dbo.Orders
    WHERE created_date > '2024-01-01';
-- ORDER BY is effectively ignored for DYNAMIC -- ordering is unstable
```

**DYNAMIC cursors see all changes** (inserts, updates, deletes) to qualifying rows during cursor processing. This creates non-deterministic behavior: rows can appear, disappear, or change values mid-loop.

> [!WARNING] DYNAMIC cursor ORDER BY is unreliable
> SQL Server may ignore or be unable to honor ORDER BY for DYNAMIC cursors. Never rely on ordering with DYNAMIC cursors — use STATIC or FAST_FORWARD instead.

**Avoid DYNAMIC in application code.** The only legitimate use case is administrative scripts where you explicitly want to see live metadata changes (e.g., iterating sys.databases while databases may be coming online/offline).

---

## FORWARD_ONLY vs SCROLL

`FORWARD_ONLY` restricts the cursor to `FETCH NEXT` only. `SCROLL` enables all fetch directions.

```sql
-- FORWARD_ONLY (default for most types)
DECLARE cur CURSOR LOCAL FORWARD_ONLY READ_ONLY FOR
    SELECT col FROM dbo.T;

-- SCROLL (required for FETCH PRIOR, FIRST, LAST, ABSOLUTE, RELATIVE)
DECLARE cur CURSOR LOCAL SCROLL STATIC FOR
    SELECT col FROM dbo.T ORDER BY col;
```

**SCROLL requires STATIC or KEYSET** to be meaningful. DYNAMIC SCROLL exists but has unreliable ordering. FAST_FORWARD implies FORWARD_ONLY — you cannot combine FAST_FORWARD with SCROLL.

---

## Cursor Options Reference Table

| Keyword | Effect | Compatible with |
|---|---|---|
| `LOCAL` | Visible only in current scope | All types |
| `GLOBAL` | Connection-scoped; persists across batches | All types |
| `FORWARD_ONLY` | Only FETCH NEXT allowed | All types |
| `SCROLL` | All FETCH directions allowed | STATIC, KEYSET, DYNAMIC |
| `STATIC` | Full snapshot in tempdb | Any scroll/forward |
| `KEYSET` | Key snapshot in tempdb | Any scroll/forward |
| `DYNAMIC` | No snapshot; live reads | Any scroll/forward |
| `FAST_FORWARD` | Optimized forward-only read-only | Forward only |
| `READ_ONLY` | No positioned UPDATE/DELETE | All types |
| `SCROLL_LOCKS` | S lock on each row during fetch | KEYSET, STATIC |
| `OPTIMISTIC` | OCC — checks for updates before positioned update | KEYSET, STATIC |

**Recommended combination:** `LOCAL FAST_FORWARD` for most use cases. `LOCAL SCROLL STATIC` when bidirectional scrolling is required.

---

## SET-Based Alternatives

Before writing a cursor, exhaust these alternatives:

### 1. UPDATE with JOIN / FROM clause
```sql
-- Cursor anti-pattern: update each row based on derived value
-- Set-based alternative:
UPDATE e
SET    e.bonus = e.salary * r.bonus_pct
FROM   dbo.Employees AS e
JOIN   dbo.BonusRates AS r ON r.grade = e.grade;
```

### 2. Window functions for running totals
```sql
-- Running total without cursor
SELECT order_id,
       amount,
       SUM(amount) OVER (ORDER BY order_date ROWS UNBOUNDED PRECEDING) AS running_total
FROM   dbo.Orders;
```

### 3. Recursive CTE for hierarchies
```sql
-- Hierarchy traversal without cursor
WITH hier AS (
    SELECT employee_id, manager_id, 0 AS depth
    FROM   dbo.Employees
    WHERE  manager_id IS NULL  -- root
    UNION ALL
    SELECT e.employee_id, e.manager_id, h.depth + 1
    FROM   dbo.Employees AS e
    JOIN   hier AS h ON h.employee_id = e.manager_id
)
SELECT * FROM hier
OPTION (MAXRECURSION 100);
```

### 4. Batch processing with WHILE loop
```sql
-- Row-by-row DELETE can become batch DELETE
DECLARE @batch INT = 5000;
WHILE 1 = 1
BEGIN
    DELETE TOP (@batch) FROM dbo.AuditLog
    WHERE created_date < DATEADD(YEAR, -7, GETDATE());

    IF @@ROWCOUNT < @batch BREAK;
    WAITFOR DELAY '00:00:01'; -- optional throttle
END;
```

### 5. STRING_AGG for string concatenation
```sql
-- Replaces "FOR XML PATH" cursor-style concatenation
SELECT department_id,
       STRING_AGG(last_name, ', ') WITHIN GROUP (ORDER BY last_name) AS members
FROM   dbo.Employees
GROUP  BY department_id;
```

### 6. CROSS APPLY for per-row derived values
```sql
-- Calling a TVF per row without a cursor
SELECT c.customer_id, t.total_orders, t.last_order_date
FROM   dbo.Customers AS c
CROSS  APPLY dbo.GetCustomerStats(c.customer_id) AS t;
```

---

## When Cursors Are Legitimate

The following scenarios genuinely justify cursor use:

### 1. Administrative iteration (DBCC, BACKUP, DDL per object)

```sql
-- Rebuild only indexes with >30% fragmentation
DECLARE @sql NVARCHAR(500);
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT QUOTENAME(DB_NAME()) + '.'
         + QUOTENAME(OBJECT_SCHEMA_NAME(i.object_id)) + '.'
         + QUOTENAME(OBJECT_NAME(i.object_id)) + '.'
         + QUOTENAME(i.name) AS full_name
    FROM   sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') AS s
    JOIN   sys.indexes AS i ON i.object_id = s.object_id AND i.index_id = s.index_id
    WHERE  s.avg_fragmentation_in_percent > 30
    AND    s.page_count > 1000
    AND    i.index_id > 0;

OPEN cur;
FETCH NEXT FROM cur INTO @sql;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC (N'ALTER INDEX ' + @sql + N' REBUILD WITH (ONLINE = ON)');
    FETCH NEXT FROM cur INTO @sql;
END;
CLOSE cur; DEALLOCATE cur;
```

### 2. Per-database operations

```sql
DECLARE @db SYSNAME;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT name FROM sys.databases
    WHERE state_desc = 'ONLINE'
    AND   name NOT IN ('master','model','msdb','tempdb');

OPEN cur;
FETCH NEXT FROM cur INTO @db;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC sp_executesql
        N'USE [' + @db + N']; EXEC sp_updatestats;';
    FETCH NEXT FROM cur INTO @db;
END;
CLOSE cur; DEALLOCATE cur;
```

### 3. Calling stored procedures that cannot accept set input

```sql
-- When a legacy proc takes one row at a time and cannot be changed
DECLARE @id INT, @status TINYINT;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT record_id, status FROM dbo.Staging WHERE processed = 0;

OPEN cur;
FETCH NEXT FROM cur INTO @id, @status;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC dbo.LegacyProcessRecord @record_id = @id, @status = @status;
    FETCH NEXT FROM cur INTO @id, @status;
END;
CLOSE cur; DEALLOCATE cur;
```

---

## Performance Cost

Cursors have multiple layers of overhead compared to set-based operations:

| Cost Component | Description |
|---|---|
| **Context switching** | Each FETCH is a round-trip to the storage engine |
| **Row-mode execution** | No batch mode; no vectorized processing |
| **Log overhead** | STATIC/KEYSET: work table in tempdb generates log records |
| **Lock acquisition** | Per-row lock/unlock cycle (vs set-based batch locking) |
| **Plan caching** | Cursor plans may not cache as efficiently |
| **Linear scalability** | Cost grows O(n) with row count; set-based often sub-linear |

**Rough rule of thumb:** A cursor processing 100,000 rows may take 10–100× longer than an equivalent set-based query. The gap is larger for write operations (UPDATE/DELETE) than reads.

**Minimizing cursor cost:**
- Use `FAST_FORWARD` — it optimizes the read path
- Use `READ_ONLY` when not doing positioned updates
- Keep the SELECT list narrow
- Avoid cursor operations inside explicit transactions unless necessary
- Pre-filter aggressively in the cursor SELECT to minimize rows fetched

---

## Nested Cursors

Nested cursors (cursor inside cursor loop) multiply the overhead:

```sql
-- This pattern is almost always replaceable with a JOIN
DECLARE outer_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT dept_id FROM dbo.Departments;

DECLARE @dept_id INT, @emp_id INT;
DECLARE inner_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT employee_id FROM dbo.Employees WHERE department_id = @dept_id;

OPEN outer_cur;
FETCH NEXT FROM outer_cur INTO @dept_id;
WHILE @@FETCH_STATUS = 0
BEGIN
    -- Each inner cursor OPEN is a full scan of Employees
    OPEN inner_cur;
    FETCH NEXT FROM inner_cur INTO @emp_id;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- work
        FETCH NEXT FROM inner_cur INTO @emp_id;
    END;
    CLOSE inner_cur;  -- close but don't DEALLOCATE here (reused)

    FETCH NEXT FROM outer_cur INTO @dept_id;
END;
CLOSE outer_cur; DEALLOCATE outer_cur;
DEALLOCATE inner_cur;
```

> [!WARNING] Nested cursors scale as O(n × m)
> If the outer cursor has 500 rows and the inner cursor processes 200 rows per iteration, that's 100,000 row operations — always replace nested cursors with a single JOIN query.

---

## Cursor Metadata and Monitoring

```sql
-- Active cursors in current session
SELECT cursor_name, cursor_rows, fetch_status,
       column_count, row_count, cursor_type,
       concurrency, scrollable, open_status, worker_time
FROM   sys.dm_exec_cursors(@@SPID);

-- Cursors across all sessions
SELECT ec.session_id, c.cursor_name, c.cursor_type,
       c.open_status, c.row_count, c.fetch_status
FROM   sys.dm_exec_cursors(0) AS c
JOIN   sys.dm_exec_sessions AS ec ON ec.session_id = c.session_id
WHERE  ec.is_user_process = 1;

-- Check if a cursor is open before closing (safe pattern in error handling)
IF CURSOR_STATUS('local', 'cur') >= 0
BEGIN
    CLOSE cur;
END;
IF CURSOR_STATUS('local', 'cur') >= -1
BEGIN
    DEALLOCATE cur;
END;
```

**CURSOR_STATUS return values:**

| Value | Meaning |
|---|---|
| 1 | Cursor is open and populated |
| 0 | Cursor is open but has no rows |
| -1 | Cursor is closed |
| -2 | Not applicable (FAST_FORWARD always returns -1 when closed) |
| -3 | Cursor does not exist |

---

## Common Patterns

### Safe cursor with TRY/CATCH cleanup

```sql
CREATE OR ALTER PROCEDURE dbo.ProcessPendingOrders
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @order_id INT;
    DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
        SELECT order_id FROM dbo.Orders
        WHERE status = 'PENDING'
        ORDER BY created_date;

    BEGIN TRY
        OPEN cur;
        FETCH NEXT FROM cur INTO @order_id;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            EXEC dbo.ProcessOrder @order_id = @order_id;
            FETCH NEXT FROM cur INTO @order_id;
        END;

        CLOSE cur;
        DEALLOCATE cur;
    END TRY
    BEGIN CATCH
        IF CURSOR_STATUS('local', 'cur') >= 0  CLOSE cur;
        IF CURSOR_STATUS('local', 'cur') >= -1 DEALLOCATE cur;

        THROW;
    END CATCH;
END;
```

### Cursor with transaction batching

```sql
-- Commit in batches to avoid long-running transactions
DECLARE @batch_size INT = 1000, @count INT = 0;
DECLARE @id INT;

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT record_id FROM dbo.LargeTable WHERE needs_migration = 1;

BEGIN TRANSACTION;
OPEN cur;
FETCH NEXT FROM cur INTO @id;

WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC dbo.MigrateRecord @id;
    SET @count += 1;

    IF @count % @batch_size = 0
    BEGIN
        COMMIT TRANSACTION;
        BEGIN TRANSACTION;
    END;

    FETCH NEXT FROM cur INTO @id;
END;

COMMIT TRANSACTION;
CLOSE cur;
DEALLOCATE cur;
```

### Positioned UPDATE (rare, advanced)

```sql
-- Use SCROLL_LOCKS to guarantee the row can be updated at cursor position
DECLARE cur CURSOR LOCAL SCROLL SCROLL_LOCKS FOR
    SELECT order_id, total FROM dbo.Orders WHERE status = 'OPEN';

DECLARE @id INT, @total MONEY;

OPEN cur;
FETCH NEXT FROM cur INTO @id, @total;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF @total > 10000
        UPDATE dbo.Orders SET status = 'REVIEW' WHERE CURRENT OF cur;

    FETCH NEXT FROM cur INTO @id, @total;
END;
CLOSE cur; DEALLOCATE cur;
```

> [!NOTE] WHERE CURRENT OF
> `WHERE CURRENT OF cursor_name` updates/deletes the row at the current cursor position. Requires SCROLL_LOCKS or OPTIMISTIC concurrency. Rarely needed — a direct UPDATE with the key value is simpler and more transparent.

---

## Gotchas / Anti-Patterns

1. **Forgetting DEALLOCATE**: CLOSE releases the result set but the cursor name remains reserved. Calling DECLARE again gives "cursor already exists" error. Always DEALLOCATE.

2. **Using GLOBAL cursor scope**: A global cursor left open by one batch blocks the same name in subsequent batches on the same connection. Use LOCAL always.

3. **No ORDER BY with DYNAMIC cursors**: The row order is non-deterministic. If order matters, use STATIC or FAST_FORWARD with explicit ORDER BY.

4. **STATIC cursor and tempdb pressure**: A STATIC cursor on a million-row result set copies all rows to tempdb. Check `sys.dm_exec_cursors` for `row_count` if tempdb I/O spikes.

5. **Cursor inside a loop (WHILE + cursor)**: Avoid re-declaring a cursor inside a WHILE loop. Move the DECLARE outside and CLOSE/re-OPEN inside to avoid repeated plan compilation.

6. **Forgetting to check @@FETCH_STATUS before first use**: `@@FETCH_STATUS` is -9 before any FETCH — always fetch first, then check in the WHILE condition.

7. **Using DYNAMIC when you want a snapshot**: If rows are being inserted or deleted from the source table during cursor processing, DYNAMIC will silently skip or double-process rows. Use STATIC for isolation.

8. **Cursor in a trigger**: Cursors in triggers process one row at a time but triggers in SQL Server fire once per statement (not per row). The inserted/deleted tables may contain multiple rows. Using a cursor inside a trigger to process them individually is an anti-pattern — use set-based logic against inserted/deleted.

9. **Not handling @@FETCH_STATUS = -2 for KEYSET**: If using a KEYSET cursor and a row is deleted from the underlying table mid-iteration, @@FETCH_STATUS returns -2, not 0. Your WHILE loop must handle this to avoid infinite loops.

10. **Re-using cursor variable after DEALLOCATE**: After DEALLOCATE, the cursor name is gone. The local variable holding the cursor handle is now invalid. Re-declare fresh.

11. **Cursor variable syntax (alternative declaration)**: SQL Server supports cursor variables but they are less commonly known and can cause confusion about scope:
    ```sql
    DECLARE @cur CURSOR;
    SET @cur = CURSOR LOCAL FAST_FORWARD FOR SELECT id FROM dbo.T;
    OPEN @cur;
    FETCH NEXT FROM @cur INTO @id;
    ```
    Cursor variables follow variable scoping rules (not cursor name scoping). Both approaches work; use whichever is consistent with your codebase.

12. **Performance profiling ignores cursor overhead**: When using `SET STATISTICS IO TIME ON`, the per-row logical reads for cursor fetches appear per-fetch in the messages — they don't aggregate into a single plan cost. Use `sys.dm_exec_cursors` to see total row counts and timing.

---

## See Also

- [`02-syntax-dql.md`](02-syntax-dql.md) — set-based SELECT patterns (CROSS APPLY, window functions) that replace cursor logic
- [`04-ctes.md`](04-ctes.md) — recursive CTEs as cursor alternatives for hierarchical data
- [`34-tempdb.md`](34-tempdb.md) — tempdb pressure from STATIC/KEYSET cursors
- [`13-transactions-locking.md`](13-transactions-locking.md) — cursor locking behavior (SCROLL_LOCKS, OPTIMISTIC)
- [`39-triggers.md`](39-triggers.md) — why cursors in triggers are wrong

---

## Sources

[^1]: Erland Sommarskog, ["Don't Use Cursors or Why You Maybe Should Use a Cursor After All"](https://www.sommarskog.se/) — presentation (SQL Friday #79, 2022) covering why set-based statements outperform cursors, when loops are genuinely appropriate, and proper cursor implementation patterns
[^2]: [Cursors (SQL Server) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/cursors) — conceptual overview of cursor types (STATIC, KEYSET, DYNAMIC, FAST_FORWARD) and cursor implementations in SQL Server
[^3]: [DECLARE CURSOR (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/declare-cursor-transact-sql) — full syntax reference for DECLARE CURSOR including LOCAL/GLOBAL, FORWARD_ONLY/SCROLL, and concurrency options
[^4]: [FETCH (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/fetch-transact-sql) — @@FETCH_STATUS values and all scroll direction options (NEXT, PRIOR, FIRST, LAST, ABSOLUTE, RELATIVE)
[^5]: [CURSOR_STATUS (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/cursor-status-transact-sql) — return value table for CURSOR_STATUS and usage in safe close/deallocate patterns
[^6]: [sys.dm_exec_cursors (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-cursors-transact-sql) — DMV columns and usage for monitoring active cursors across sessions

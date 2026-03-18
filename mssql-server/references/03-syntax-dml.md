# DML: INSERT, UPDATE, DELETE, MERGE, OUTPUT

## Table of Contents

1. [When to Use This File](#when-to-use)
2. [INSERT](#insert)
   - [INSERT … VALUES](#insert-values)
   - [INSERT … SELECT](#insert-select)
   - [INSERT … EXEC](#insert-exec)
   - [Bulk / Minimal Logging](#bulk-minimal-logging)
3. [UPDATE](#update)
   - [Basic UPDATE](#basic-update)
   - [UPDATE with JOIN](#update-with-join)
   - [UPDATE with CTE](#update-with-cte)
   - [UPDATE … TOP](#update-top)
4. [DELETE](#delete)
   - [Basic DELETE](#basic-delete)
   - [DELETE with JOIN](#delete-with-join)
   - [TRUNCATE vs DELETE](#truncate-vs-delete)
5. [OUTPUT Clause](#output-clause)
   - [Capturing Changed Rows](#capturing-changed-rows)
   - [OUTPUT … INTO](#output-into)
   - [Chained OUTPUT (INSERT … OUTPUT … INTO)](#chained-output)
6. [MERGE](#merge)
   - [Basic MERGE Syntax](#basic-merge-syntax)
   - [MERGE with OUTPUT](#merge-with-output)
   - [MERGE Gotchas](#merge-gotchas)
   - [Upsert Alternatives](#upsert-alternatives)
7. [Upsert Patterns](#upsert-patterns)
   - [MERGE Upsert](#merge-upsert)
   - [IF EXISTS / UPDATE … ELSE INSERT](#if-exists-pattern)
   - [INSERT … ON CONFLICT Equivalent (none)](#no-on-conflict)
8. [Gotchas / Anti-patterns](#gotchas)
9. [See Also](#see-also)
10. [Sources](#sources)

---

## When to Use {#when-to-use}

Load this file whenever the user asks about:
- Inserting, updating, or deleting rows (single-row or batch)
- The `OUTPUT` clause for capturing row changes, audit trails, or chained inserts
- `MERGE` statement usage, race conditions, or the `WHEN MATCHED / NOT MATCHED` clauses
- Upsert patterns (insert-or-update semantics)
- `TRUNCATE TABLE` vs `DELETE` trade-offs
- Minimal logging conditions for bulk INSERT

---

## INSERT

### INSERT … VALUES {#insert-values}

```sql
-- Single row
INSERT INTO dbo.Orders (CustomerID, OrderDate, Amount)
VALUES (42, GETDATE(), 199.99);

-- Multi-row (SQL Server 2008+, max 1000 value rows per statement)
INSERT INTO dbo.Orders (CustomerID, OrderDate, Amount)
VALUES
    (1, '2024-01-01', 100.00),
    (2, '2024-01-02', 200.00),
    (3, '2024-01-03', 300.00);
```

> [!NOTE] IDENTITY
> `IDENTITY` columns are populated automatically. To insert an explicit value, wrap in `SET IDENTITY_INSERT dbo.Orders ON` / `OFF`. Only one table per session can have this enabled at a time.

```sql
SET IDENTITY_INSERT dbo.Orders ON;
INSERT INTO dbo.Orders (OrderID, CustomerID, OrderDate, Amount)
VALUES (9999, 1, GETDATE(), 0.00);
SET IDENTITY_INSERT dbo.Orders OFF;
```

---

### INSERT … SELECT {#insert-select}

```sql
INSERT INTO dbo.OrdersArchive (OrderID, CustomerID, OrderDate, Amount)
SELECT OrderID, CustomerID, OrderDate, Amount
FROM   dbo.Orders
WHERE  OrderDate < '2023-01-01';
```

**Best practices:**
- Always list target columns explicitly — column order in the table may change
- Use `TOP (n)` to batch large inserts and reduce log pressure:
  ```sql
  WHILE 1 = 1
  BEGIN
      INSERT TOP (10000) INTO dbo.OrdersArchive
          SELECT OrderID, CustomerID, OrderDate, Amount
          FROM   dbo.Orders
          WHERE  OrderDate < '2023-01-01'
            AND  OrderID NOT IN (SELECT OrderID FROM dbo.OrdersArchive);

      IF @@ROWCOUNT < 10000 BREAK;
  END
  ```

---

### INSERT … EXEC {#insert-exec}

```sql
CREATE TABLE #ProcResults (SomeColumn INT, AnotherColumn NVARCHAR(100));

INSERT INTO #ProcResults
EXEC dbo.usp_GetSomeData @Param = 'value';
```

**Gotcha:** `INSERT … EXEC` cannot be nested — if `usp_GetSomeData` itself uses `INSERT … EXEC`, the outer call fails with:

> *An INSERT EXEC statement cannot be nested.*

Workaround: use a temp table or table-valued parameter inside the proc, or refactor to an inline TVF.

---

### Bulk / Minimal Logging {#bulk-minimal-logging}

Minimal logging (write extent-level info to log rather than row-level) dramatically reduces log I/O for large inserts. Conditions required (all must be true)[^1]:

| Condition | Requirement |
|---|---|
| Recovery model | `SIMPLE` or `BULK_LOGGED` |
| Target table | Has no non-clustered indexes **OR** empty table with clustered index |
| `TABLOCK` hint | Must be specified on INSERT SELECT or BULK INSERT |
| Trace flag | None needed since SQL Server 2016 for qualifying inserts |

```sql
-- Minimal-log bulk insert into a heap or empty clustered table
INSERT INTO dbo.StagingTable WITH (TABLOCK)
SELECT * FROM dbo.SourceTable;
```

> [!NOTE] SQL Server 2016+
> The engine automatically qualifies INSERT INTO … SELECT for minimal logging into an empty clustered index table under `BULK_LOGGED` recovery without `TABLOCK` on versions 2016+, but `TABLOCK` is still required under `SIMPLE` recovery for non-empty tables. [^1]

---

## UPDATE

### Basic UPDATE {#basic-update}

```sql
UPDATE dbo.Orders
SET    Amount = Amount * 1.1,
       ModifiedDate = GETDATE()
WHERE  CustomerID = 42;

SELECT @@ROWCOUNT AS RowsAffected;
```

---

### UPDATE with JOIN {#update-with-join}

SQL Server allows updating via a join by using a CTE or the FROM clause:

```sql
-- FROM clause style (proprietary T-SQL extension)
UPDATE o
SET    o.CustomerName = c.FullName
FROM   dbo.Orders AS o
JOIN   dbo.Customers AS c ON c.CustomerID = o.CustomerID
WHERE  o.ModifiedDate IS NULL;
```

> [!WARNING] Non-deterministic UPDATE with FROM + JOIN
> If the JOIN produces multiple matching rows for a single target row, SQL Server updates that row with **one arbitrarily chosen** source row. There is no error or warning. Always ensure the join is deterministic (1:1 relationship to target) or use a CTE with `ROW_NUMBER()` to resolve duplicates first.

---

### UPDATE with CTE {#update-with-cte}

CTEs can wrap the target and are often clearer than `FROM`:

```sql
WITH Deduped AS (
    SELECT OrderID,
           ROW_NUMBER() OVER (PARTITION BY CustomerID ORDER BY OrderDate DESC) AS rn
    FROM   dbo.Orders
)
UPDATE Deduped
SET    ???   -- can only update base table columns via CTE
-- Wait: can't add a new column via CTE, but can update existing ones:

WITH LatestOrders AS (
    SELECT o.OrderID, c.Region
    FROM   dbo.Orders o
    JOIN   dbo.Customers c ON c.CustomerID = o.CustomerID
)
UPDATE LatestOrders
SET    Region = Region + '-UPDATED';
```

**Caution:** Updatable CTEs only work when SQL Server can unambiguously map the CTE back to a single base table. Joins in the CTE make it non-updatable unless only one table's columns are being changed.

---

### UPDATE … TOP {#update-top}

```sql
-- Process in chunks to avoid large lock escalation
WHILE 1 = 1
BEGIN
    UPDATE TOP (5000) dbo.Orders
    SET    ProcessedFlag = 1
    WHERE  ProcessedFlag = 0;

    IF @@ROWCOUNT = 0 BREAK;
    WAITFOR DELAY '00:00:00.010';   -- yield to other sessions briefly
END
```

> [!WARNING] TOP without ORDER BY is non-deterministic
> `UPDATE TOP (n)` processes an arbitrary set of rows — there is no guarantee which rows are chosen. If order matters, use a CTE with `ROW_NUMBER()` to select the specific rows first.

---

## DELETE

### Basic DELETE {#basic-delete}

```sql
DELETE FROM dbo.Orders
WHERE  OrderDate < '2020-01-01';

-- Batched delete to avoid lock escalation and log bloat
WHILE 1 = 1
BEGIN
    DELETE TOP (5000) FROM dbo.Orders
    WHERE  OrderDate < '2020-01-01';

    IF @@ROWCOUNT = 0 BREAK;
END
```

---

### DELETE with JOIN {#delete-with-join}

```sql
-- Delete orders whose customers have been deactivated
DELETE o
FROM   dbo.Orders AS o
JOIN   dbo.Customers AS c ON c.CustomerID = o.CustomerID
WHERE  c.IsActive = 0;
```

Or equivalently:

```sql
DELETE FROM dbo.Orders
WHERE  CustomerID IN (
    SELECT CustomerID FROM dbo.Customers WHERE IsActive = 0
);
```

The join form is usually more efficient because the optimizer can use a join strategy directly rather than an IN list subquery.

---

### TRUNCATE vs DELETE {#truncate-vs-delete}

| Feature | TRUNCATE | DELETE |
|---|---|---|
| Removes all rows | Yes (always) | Configurable via WHERE |
| WHERE clause | Not supported | Supported |
| Logging | Minimal (deallocates pages) | Row-level (full logging) |
| Fires DML triggers | No | Yes |
| Resets IDENTITY | Yes | No (use `DBCC CHECKIDENT`) |
| Requires permissions | `ALTER TABLE` | `DELETE` |
| Can be rolled back | Yes (inside explicit tx) | Yes |
| Works with FK constraints | No (FK to table must be disabled) | Yes (FK violations raise error) |
| Partition-aware | Yes (specific partition) | Yes (via WHERE) |

```sql
-- Truncate a single partition (SQL Server 2016+)
TRUNCATE TABLE dbo.Orders
WITH (PARTITIONS (1, 3, 5));
```

> [!NOTE] SQL Server 2016
> Partition-level TRUNCATE was introduced in SQL Server 2016. [^2]

---

## OUTPUT Clause

The `OUTPUT` clause lets you capture the before (`DELETED`) and after (`INSERTED`) images of rows affected by any DML statement.

### Capturing Changed Rows {#capturing-changed-rows}

```sql
-- Capture what was deleted
DELETE FROM dbo.Orders
OUTPUT DELETED.OrderID, DELETED.CustomerID, DELETED.Amount, GETDATE() AS DeletedAt
WHERE  OrderDate < '2020-01-01';
```

```sql
-- Capture inserted IDENTITY values
INSERT INTO dbo.Orders (CustomerID, OrderDate, Amount)
OUTPUT INSERTED.OrderID, INSERTED.CustomerID
VALUES (1, GETDATE(), 100.00);
```

```sql
-- Capture old and new values on UPDATE
UPDATE dbo.Orders
SET    Amount = Amount * 1.1
OUTPUT DELETED.Amount AS OldAmount,
       INSERTED.Amount AS NewAmount,
       INSERTED.OrderID
WHERE  CustomerID = 42;
```

---

### OUTPUT … INTO {#output-into}

Redirect captured rows into a table or table variable instead of returning them to the client:

```sql
DECLARE @Deleted TABLE (
    OrderID    INT,
    CustomerID INT,
    Amount     DECIMAL(10,2),
    DeletedAt  DATETIME2
);

DELETE FROM dbo.Orders
OUTPUT DELETED.OrderID, DELETED.CustomerID, DELETED.Amount, GETDATE()
INTO   @Deleted (OrderID, CustomerID, Amount, DeletedAt)
WHERE  OrderDate < '2020-01-01';

-- Now log the deletions
INSERT INTO dbo.OrdersAuditLog
SELECT OrderID, CustomerID, Amount, DeletedAt, 'DELETE' AS Action
FROM   @Deleted;
```

---

### Chained OUTPUT (INSERT … OUTPUT … INTO) {#chained-output}

Use OUTPUT to pipe inserted rows into a second table in one atomic statement — useful for audit tables or mapping tables:

```sql
DECLARE @NewOrders TABLE (
    NewOrderID INT,
    OldOrderID INT
);

INSERT INTO dbo.Orders (CustomerID, OrderDate, Amount)
OUTPUT INSERTED.OrderID,
       src.OriginalOrderID    -- from the source using a FROM clause
INTO   @NewOrders (NewOrderID, OldOrderID)
SELECT s.CustomerID, s.OrderDate, s.Amount
FROM   dbo.OrdersStaging AS s;
```

> [!WARNING] OUTPUT … FROM clause restriction
> The `FROM` clause in `INSERT … OUTPUT` cannot reference the source table directly in the OUTPUT list in all older versions. Use a CTE or derived table if you need source-side columns alongside INSERTED columns. [^6]

---

## MERGE

### Basic MERGE Syntax {#basic-merge-syntax}

`MERGE` combines INSERT, UPDATE, and DELETE into one statement keyed on a match condition between a **target** and a **source**.

```sql
MERGE dbo.Orders AS target
USING (
    SELECT CustomerID, OrderDate, Amount
    FROM   dbo.OrdersStaging
) AS source
ON (target.CustomerID = source.CustomerID
    AND target.OrderDate = source.OrderDate)
WHEN MATCHED THEN
    UPDATE SET target.Amount = source.Amount
WHEN NOT MATCHED BY TARGET THEN
    INSERT (CustomerID, OrderDate, Amount)
    VALUES (source.CustomerID, source.OrderDate, source.Amount)
WHEN NOT MATCHED BY SOURCE THEN
    DELETE;
```

**Clauses:**
- `WHEN MATCHED` — target row has a match in source (can filter with AND condition)
- `WHEN NOT MATCHED [BY TARGET]` — source row has no match in target → INSERT
- `WHEN NOT MATCHED BY SOURCE` — target row has no match in source → typically DELETE

Multiple `WHEN MATCHED` clauses are allowed (each with a different AND condition). The first clause whose condition is met wins.

---

### MERGE with OUTPUT {#merge-with-output}

```sql
DECLARE @MergeResults TABLE (
    Action     NVARCHAR(10),
    OrderID    INT,
    CustomerID INT
);

MERGE dbo.Orders AS target
USING dbo.OrdersStaging AS source
ON (target.CustomerID = source.CustomerID AND target.OrderDate = source.OrderDate)
WHEN MATCHED THEN
    UPDATE SET target.Amount = source.Amount
WHEN NOT MATCHED BY TARGET THEN
    INSERT (CustomerID, OrderDate, Amount)
    VALUES (source.CustomerID, source.OrderDate, source.Amount)
OUTPUT $action,               -- 'INSERT', 'UPDATE', or 'DELETE'
       INSERTED.OrderID,
       INSERTED.CustomerID
INTO   @MergeResults (Action, OrderID, CustomerID);
```

`$action` is a special MERGE-only token returning `'INSERT'`, `'UPDATE'`, or `'DELETE'` for each affected row.

---

### MERGE Gotchas {#merge-gotchas}

**1. Race conditions under concurrent workloads**

`MERGE` is not atomic in the sense of preventing concurrent insert races. Under default `READ COMMITTED` isolation, two sessions can both pass the "NOT MATCHED" check simultaneously and both attempt an INSERT, causing a duplicate key violation or phantom insert. Mitigation options:

```sql
-- Option A: serializable + retry logic
BEGIN TRAN;
MERGE dbo.Orders WITH (HOLDLOCK) AS target
USING ...
```

The `WITH (HOLDLOCK)` hint (equivalent to `SERIALIZABLE` on the MERGE target scan) prevents phantoms by holding range locks during the MERGE. [^3]

**2. Multiple matches — non-deterministic UPDATE**

If the source has duplicate rows matching a single target row, the MERGE raises:

> *The MERGE statement attempted to UPDATE or DELETE the same row more than once.*

Pre-deduplicate the source:

```sql
MERGE dbo.Orders AS target
USING (
    SELECT CustomerID, OrderDate, Amount,
           ROW_NUMBER() OVER (PARTITION BY CustomerID, OrderDate ORDER BY (SELECT NULL)) AS rn
    FROM   dbo.OrdersStaging
) AS source
ON source.rn = 1   -- only one source row per key
   AND target.CustomerID = source.CustomerID
   AND target.OrderDate = source.OrderDate
...
```

**3. MERGE bugs in older versions**

SQL Server has had numerous MERGE-related bugs logged. Paul White documented several incorrect results and cardinality estimation failures.[^4] For correctness-critical upserts on older versions, consider the `IF EXISTS` pattern instead.

**4. Extra logging vs. separate statements**

MERGE can sometimes generate more log writes than separate `UPDATE` + `INSERT` statements because it scans the target once but may lock more aggressively. For very high-throughput upserts, benchmark both approaches.

**5. MERGE and IDENTITY / triggers**

- `INSTEAD OF` triggers on the target table make `MERGE` fail.
- `OUTPUT` on a MERGE statement cannot reference columns from the source (only `INSERTED` / `DELETED`).

---

### Upsert Alternatives {#upsert-alternatives}

---

## Upsert Patterns

### MERGE Upsert {#merge-upsert}

See the MERGE section above. Add `WITH (HOLDLOCK)` for concurrency safety:

```sql
MERGE dbo.Orders WITH (HOLDLOCK) AS target
USING (SELECT @CustomerID AS CustomerID, @OrderDate AS OrderDate, @Amount AS Amount) AS source
ON (target.CustomerID = source.CustomerID AND target.OrderDate = source.OrderDate)
WHEN MATCHED THEN
    UPDATE SET target.Amount = source.Amount
WHEN NOT MATCHED THEN
    INSERT (CustomerID, OrderDate, Amount)
    VALUES (source.CustomerID, source.OrderDate, source.Amount);
```

---

### IF EXISTS / UPDATE … ELSE INSERT {#if-exists-pattern}

The "update first, insert if nothing updated" pattern avoids some MERGE bugs and is clearer in stored procedures:

```sql
BEGIN TRAN;

UPDATE dbo.Orders WITH (UPDLOCK, SERIALIZABLE)
SET    Amount = @Amount
WHERE  CustomerID = @CustomerID
  AND  OrderDate  = @OrderDate;

IF @@ROWCOUNT = 0
BEGIN
    INSERT INTO dbo.Orders (CustomerID, OrderDate, Amount)
    VALUES (@CustomerID, @OrderDate, @Amount);
END

COMMIT;
```

`UPDLOCK` acquires an update lock on the scanned rows (prevents other sessions from taking shared locks that would later conflict), and `SERIALIZABLE` prevents phantom inserts between the check and the write. This pattern is safe under concurrency. [^5]

**Alternative — UPDATE first, then conditional INSERT:**

```sql
-- Slightly higher lock acquisition but avoids explicit IF
INSERT INTO dbo.Orders (CustomerID, OrderDate, Amount)
SELECT @CustomerID, @OrderDate, @Amount
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.Orders WITH (UPDLOCK, SERIALIZABLE)
    WHERE CustomerID = @CustomerID AND OrderDate = @OrderDate
);

IF @@ROWCOUNT = 0
BEGIN
    UPDATE dbo.Orders
    SET    Amount = @Amount
    WHERE  CustomerID = @CustomerID AND OrderDate = @OrderDate;
END
```

---

### No ON CONFLICT Equivalent {#no-on-conflict}

SQL Server has no `INSERT … ON CONFLICT DO UPDATE` (PostgreSQL syntax) or `INSERT … ON DUPLICATE KEY UPDATE` (MySQL syntax). Use MERGE or the IF EXISTS pattern described above.

---

## Gotchas / Anti-patterns {#gotchas}

**1. UPDATE with no WHERE clause**

Accidentally updating all rows is a common and costly mistake. Always double-check:

```sql
-- WRONG — updates every row in the table
UPDATE dbo.Orders SET Amount = 0;

-- RIGHT
UPDATE dbo.Orders SET Amount = 0 WHERE OrderID = 12345;
```

Mitigation: run the equivalent `SELECT COUNT(*)` with the same WHERE clause before executing UPDATE in production.

**2. DELETE with subquery and NOT IN including NULLs**

```sql
-- DANGEROUS — if subquery returns any NULL, entire NOT IN evaluates to unknown → 0 rows deleted
DELETE FROM dbo.Orders
WHERE CustomerID NOT IN (SELECT CustomerID FROM dbo.Customers);
-- If any Customers.CustomerID is NULL, this deletes nothing silently

-- SAFE alternative
DELETE FROM dbo.Orders
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.Customers c
    WHERE  c.CustomerID = dbo.Orders.CustomerID
);
```

**3. TRUNCATE resets IDENTITY — may break FK children**

If you have a parent table with IDENTITY that has child table rows, TRUNCATE fails (FK constraint). And even if you disable the FK first, truncating resets the IDENTITY counter, so new inserts may collide with existing child FK references.

**4. OUTPUT into table variable doesn't fire triggers**

The OUTPUT INTO clause writes to a table variable or temp table directly — no INSERT trigger fires on the destination. This is intentional and usually desired, but be aware if the destination table has triggers expected to run.

**5. MERGE performance: prefer MERGE for multi-DML batches, not single rows**

MERGE overhead per row is higher than a single UPDATE or INSERT. For single-row upserts in OLTP, the `IF EXISTS` pattern (or optimistic update-first) is typically faster.

**6. Implicit row-by-row processing**

Some code uses a cursor or `WHILE` loop for DML where a single set-based statement would work. Set-based is almost always faster and produces less log I/O. Only use row-by-row when each row's logic depends on the previous row (running totals, etc.) and window functions won't suffice.

**7. @@ROWCOUNT after multi-statement batches**

`@@ROWCOUNT` reflects only the most recently completed statement. If you have error handling between the DML and the `@@ROWCOUNT` check, insert an intermediate save:

```sql
UPDATE dbo.Orders SET Amount = Amount * 1.1 WHERE CustomerID = @CID;
DECLARE @rc INT = @@ROWCOUNT;   -- capture immediately
-- ... other code ...
IF @rc = 0 RAISERROR('No rows updated', 16, 1);
```

---

## See Also {#see-also}

- [`04-ctes.md`](04-ctes.md) — CTEs used in UPDATE/DELETE/MERGE sources
- [`13-transactions-locking.md`](13-transactions-locking.md) — isolation levels and lock hints for safe upserts
- [`14-error-handling.md`](14-error-handling.md) — TRY/CATCH around DML
- [`25-null-handling.md`](25-null-handling.md) — NULL traps in NOT IN subqueries
- [`47-cli-bulk-operations.md`](47-cli-bulk-operations.md) — BULK INSERT, bcp for large-volume inserts

---

## Sources

[^1]: [Prerequisites for Minimal Logging in Bulk Import](https://learn.microsoft.com/en-us/sql/relational-databases/import-export/prerequisites-for-minimal-logging-in-bulk-import) — covers table, index, recovery model, and TABLOCK conditions required for minimal logging of INSERT SELECT and bulk import operations
[^2]: [TRUNCATE TABLE (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/truncate-table-transact-sql) — official reference for TRUNCATE TABLE syntax including the WITH PARTITIONS clause introduced in SQL Server 2016
[^3]: [UPSERT Race Condition With MERGE](https://weblogs.sqlteam.com/dang/2009/01/31/upsert-race-condition-with-merge/) — Dan Guzman demonstrates MERGE concurrency race conditions and proves that HOLDLOCK is required to prevent duplicate key violations under concurrent workloads
[^4]: [MERGE Bug with Filtered Indexes](https://www.sql.kiwi/2012/12/merge-bug-with-filtered-indexes.html) — Paul White documents a class of MERGE correctness bugs affecting filtered unique indexes, with additional MERGE bugs catalogued on the same blog
[^5]: [Please stop using this UPSERT anti-pattern](https://sqlperformance.com/2020/09/locking/upsert-anti-pattern) — Aaron Bertrand explains safe upsert patterns using UPDLOCK and SERIALIZABLE hints and why the naive IF EXISTS check is not concurrency-safe
[^6]: [OUTPUT Clause (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) — documents OUTPUT INTO restrictions including the rule that OUTPUT INTO is not supported in INSERT statements containing a dml_table_source clause, preventing direct source-table column references

# 14 — Error Handling

Structured TRY/CATCH, THROW, RAISERROR, savepoints, nested transactions, and production-grade error patterns for SQL Server 2022+.

---

## Table of Contents

1. [When to Use](#when-to-use)
2. [TRY/CATCH Architecture](#trycatch-architecture)
3. [Error Functions](#error-functions)
4. [THROW vs RAISERROR](#throw-vs-raiserror)
5. [Re-raising Errors](#re-raising-errors)
6. [Nested Transactions and @@TRANCOUNT](#nested-transactions-and-trancount)
7. [XACT_ABORT](#xact_abort)
8. [XACT_STATE in CATCH Blocks](#xact_state-in-catch-blocks)
9. [SAVE TRANSACTION (Savepoints)](#save-transaction-savepoints)
10. [Structured Error Pattern (Production Template)](#structured-error-pattern-production-template)
11. [Custom Error Messages (sp_addmessage)](#custom-error-messages-sp_addmessage)
12. [Error Severity Reference](#error-severity-reference)
13. [Errors That Cannot Be Caught](#errors-that-cannot-be-caught)
14. [Logging Errors to a Table](#logging-errors-to-a-table)
15. [Error Handling in Dynamic SQL](#error-handling-in-dynamic-sql)
16. [Error Handling in Natively Compiled Procs](#error-handling-in-natively-compiled-procs)
17. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

Load this file when the question involves:
- TRY/CATCH block structure or placement
- THROW vs RAISERROR syntax or semantics
- Re-raising errors while preserving original error number/message
- Nested transaction rollback confusion (inner rollback kills outer)
- XACT_ABORT and unhandled errors leaving open transactions
- Savepoints (SAVE TRANSACTION) for partial rollback
- @@TRANCOUNT vs XACT_STATE() in CATCH blocks
- Custom error messages (sys.messages, sp_addmessage)
- Error severity levels and their effects
- Errors that bypass TRY/CATCH (severity 20+, attention events)

---

## TRY/CATCH Architecture

```sql
BEGIN TRY
    -- statements
END TRY
BEGIN CATCH
    -- error handling
END CATCH;
```

**Key rules:**
- CATCH executes only when an error occurs inside the TRY block at the *same* nesting level or called objects.
- A CATCH block can itself have a nested TRY/CATCH.
- CATCH does **not** re-execute the failed statement. Execution resumes after END CATCH.
- `RETURN` inside CATCH exits the current procedure; control passes to the caller's CATCH if one exists.

```sql
-- Basic pattern with transaction
BEGIN TRY
    BEGIN TRANSACTION;

    INSERT INTO Orders (CustomerID, Amount) VALUES (1, 250.00);
    UPDATE Inventory SET Qty = Qty - 1 WHERE ProductID = 42;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;

    THROW;  -- re-raise to caller
END CATCH;
```

---

## Error Functions

These functions are **only valid inside a CATCH block**. They return NULL if called outside CATCH.

| Function | Returns |
|---|---|
| `ERROR_NUMBER()` | Error number (same as `sys.messages.message_id`) |
| `ERROR_SEVERITY()` | Severity level (1–25) |
| `ERROR_STATE()` | State code (for disambiguation within same error number) |
| `ERROR_PROCEDURE()` | Name of procedure/trigger where error occurred; NULL if batch |
| `ERROR_LINE()` | Line number where error occurred |
| `ERROR_MESSAGE()` | Full error message text |

```sql
BEGIN CATCH
    SELECT
        ERROR_NUMBER()    AS ErrorNumber,
        ERROR_SEVERITY()  AS Severity,
        ERROR_STATE()     AS State,
        ERROR_PROCEDURE() AS Procedure_,
        ERROR_LINE()      AS Line,
        ERROR_MESSAGE()   AS Message;
END CATCH;
```

> [!WARNING] Deprecated
> `@@ERROR` is the pre-2005 mechanism. It resets to 0 after **every** statement, making it unreliable without immediate capture. Prefer TRY/CATCH + error functions. `@@ERROR` is still supported but error-prone.

---

## THROW vs RAISERROR

### THROW (SQL Server 2012+, preferred)

```sql
-- Raise a new error
THROW 50001, 'Order amount cannot be negative.', 1;

-- Re-raise current error (no arguments — only valid inside CATCH)
THROW;
```

**THROW characteristics:**
- Severity is always **16** for user-thrown errors (cannot override).
- Always terminates the current batch after the error (like severity 16 errors).
- Bare `THROW;` preserves the original `ERROR_NUMBER()`, `ERROR_MESSAGE()`, severity, and state — the closest thing SQL Server has to a true re-raise.
- Does **not** require `WITH NOWAIT` for immediate client notification.
- Requires a semicolon before `THROW` if it follows a statement without one (see gotchas).

### RAISERROR (legacy, still supported)

```sql
-- Inline message
RAISERROR('Order amount %d is invalid for customer %s.', 16, 1, @Amount, @CustomerName);

-- From sys.messages
RAISERROR(50001, 16, 1);

-- WITH LOG writes to Windows Application Event Log + SQL error log
RAISERROR('Critical failure.', 17, 1) WITH LOG;

-- WITH NOWAIT flushes message to client immediately (useful in long batches)
RAISERROR('Processing batch %d of %d...', 0, 1, @BatchNum, @TotalBatches) WITH NOWAIT;
```

**RAISERROR characteristics:**
- Supports severity 0–25; severities 19–25 require sysadmin.
- Severity 0–10: informational (does not trigger CATCH).
- Severity 11–16: user errors (triggers CATCH).
- Severity 17–18: resource/internal errors (triggers CATCH).
- Severity 19–25: fatal/severe (see [Errors That Cannot Be Caught](#errors-that-cannot-be-caught)).
- Supports `printf`-style format specifiers (`%s`, `%d`, `%i`, `%o`, `%u`, `%x`, `%X`, `%e`, `%E`, `%f`, `%g`, `%G`). Max message length 2047 characters.
- `WITH LOG` required for severities 19+.

### Comparison Table

| Aspect | `THROW` | `RAISERROR` |
|---|---|---|
| Version | 2012+ | All versions |
| Severity control | Fixed 16 for new errors | 0–25 |
| Bare re-raise | Yes (`THROW;`) | No equivalent |
| Format specifiers | No | Yes |
| Batch continuation | Never (always terminates) | Depends on severity |
| `WITH LOG` support | No | Yes |
| `WITH NOWAIT` | No | Yes |
| Preferred for new code | **Yes** | No — legacy |

---

## Re-raising Errors

The canonical re-raise pattern using THROW (preserves original error number):

```sql
BEGIN TRY
    EXEC dbo.SomeProc;
END TRY
BEGIN CATCH
    -- Log, compensate, etc., then re-raise:
    THROW;
END CATCH;
```

Re-raise with RAISERROR (loses original error number — use only if you need format strings or pre-2012 compat):

```sql
BEGIN CATCH
    DECLARE @msg  NVARCHAR(2048) = ERROR_MESSAGE();
    DECLARE @sev  INT            = ERROR_SEVERITY();
    DECLARE @sta  INT            = ERROR_STATE();
    RAISERROR(@msg, @sev, @sta);
END CATCH;
```

> [!WARNING] Deprecated
> The RAISERROR re-raise above wraps the original message in a new error with a *different* error number (usually 50000 when using a string literal). Callers checking `ERROR_NUMBER()` will see 50000 instead of the original. Use `THROW;` (bare) for true re-raise when on 2012+.

---

## Nested Transactions and @@TRANCOUNT

SQL Server uses a **flat transaction model** — nested `BEGIN TRANSACTION` increments `@@TRANCOUNT`, but only the outermost `COMMIT` actually commits. An inner `ROLLBACK` rolls back **all** work to the outermost `BEGIN TRANSACTION`, regardless of nesting depth.

```sql
-- @@TRANCOUNT after each statement
BEGIN TRANSACTION;         -- @@TRANCOUNT = 1
    BEGIN TRANSACTION;     -- @@TRANCOUNT = 2 (savepoint only)
        INSERT INTO T ...;
    ROLLBACK TRANSACTION;  -- @@TRANCOUNT = 0 ← KILLS THE OUTER TRANSACTION
COMMIT TRANSACTION;        -- Error 3902: cannot commit - no active transaction
```

> [!WARNING]
> An inner `ROLLBACK TRANSACTION` (without a savepoint name) **always** rolls back to the outermost BEGIN TRANSACTION and sets `@@TRANCOUNT = 0`. This is the single most common nested-transaction bug.

**Correct inner rollback pattern — use savepoints:**

```sql
BEGIN TRANSACTION;                    -- @@TRANCOUNT = 1
    SAVE TRANSACTION inner_save;      -- does NOT increment @@TRANCOUNT
    BEGIN TRY
        INSERT INTO T ...;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION inner_save;  -- rolls back to savepoint only
        -- @@TRANCOUNT is still 1
    END CATCH;
COMMIT TRANSACTION;                   -- @@TRANCOUNT = 0, commits
```

**Checking @@TRANCOUNT in CATCH:**

```sql
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;
    THROW;
END CATCH;
```

Never call `COMMIT` in a CATCH block unless you explicitly want to commit partial work — that is almost always wrong.

---

## XACT_ABORT

`SET XACT_ABORT ON` causes SQL Server to automatically roll back the current transaction and terminate the batch when any statement raises a run-time error (severity 11+).

```sql
SET XACT_ABORT ON;

BEGIN TRANSACTION;
    UPDATE Orders SET Status = 'Shipped' WHERE OrderID = @id;
    -- If UPDATE fails, transaction is auto-rolled-back; batch terminates
    UPDATE Inventory SET Qty = Qty - 1 WHERE ProductID = @pid;
COMMIT TRANSACTION;
```

**XACT_ABORT behavior summary:**

| Condition | Without XACT_ABORT | With XACT_ABORT |
|---|---|---|
| Statement-level error | Statement rolls back; batch continues | Batch terminates; transaction rolls back |
| Compile error | Batch terminates | Batch terminates |
| Inside TRY block | CATCH executes | CATCH executes (but transaction is doomed) |
| @@TRANCOUNT after error in TRY | ≥ 1 (transaction still open) | 0 (already rolled back) |

> [!NOTE] Best Practice
> Always use `SET XACT_ABORT ON` in stored procedures that perform DML. Without it, a procedure can return to the caller with an open, uncommitted transaction — a resource leak that causes blocking. The correct pattern is `XACT_ABORT ON` + TRY/CATCH + check `XACT_STATE()` in CATCH.

---

## XACT_STATE in CATCH Blocks

`XACT_STATE()` is more reliable than `@@TRANCOUNT` in a CATCH block when `XACT_ABORT` may be ON:

| `XACT_STATE()` | Meaning |
|---|---|
| `1` | Active, committable transaction |
| `-1` | Active, **uncommittable** (doomed) transaction — must ROLLBACK |
| `0` | No active transaction |

```sql
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;
    -- DML work
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() = -1
        ROLLBACK TRANSACTION;        -- doomed: must roll back
    ELSE IF XACT_STATE() = 1
        ROLLBACK TRANSACTION;        -- active but errored: roll back

    -- XACT_STATE() = 0 means nothing to roll back

    THROW;
END CATCH;
```

When `XACT_ABORT ON` is set and an error fires inside TRY, by the time CATCH executes, `XACT_STATE()` is already `-1` (the engine has doomed the transaction). You cannot commit it; you must roll it back.

---

## SAVE TRANSACTION (Savepoints)

Savepoints allow partial rollback within a transaction without destroying the outer transaction.

```sql
BEGIN TRANSACTION;

-- Some work that succeeds
INSERT INTO AuditLog (Event) VALUES ('Order started');

SAVE TRANSACTION before_items;   -- mark partial rollback point

BEGIN TRY
    INSERT INTO OrderItems (OrderID, ProductID, Qty) VALUES (1, 42, 3);
    -- If this fails, roll back only the OrderItems insert
END TRY
BEGIN CATCH
    ROLLBACK TRANSACTION before_items;  -- back to savepoint; @@TRANCOUNT unchanged
    INSERT INTO AuditLog (Event) VALUES ('Items insert failed, retrying');
END CATCH;

COMMIT TRANSACTION;               -- commits AuditLog rows; OrderItems row may or may not exist
```

**Savepoint rules:**
- `SAVE TRANSACTION <name>` does **not** increment `@@TRANCOUNT`.
- `ROLLBACK TRANSACTION <name>` rolls back to the savepoint but does **not** decrement `@@TRANCOUNT`.
- `ROLLBACK TRANSACTION` (no name) always rolls back to the start and sets `@@TRANCOUNT = 0`.
- Savepoint names are case-insensitive and limited to 32 characters.
- Duplicate savepoint names are allowed — `ROLLBACK` uses the **most recently created** savepoint with that name.

---

## Structured Error Pattern (Production Template)

This template handles: `XACT_ABORT`, nested transaction safety, error logging, and clean re-raise.

```sql
CREATE OR ALTER PROCEDURE dbo.ProcessOrder
    @OrderID INT
AS
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    -- Validate
    IF NOT EXISTS (SELECT 1 FROM Orders WHERE OrderID = @OrderID)
        THROW 50010, 'Order not found.', 1;

    -- Business logic
    UPDATE Orders
       SET Status      = 'Processing',
           ProcessedAt = SYSDATETIME()
     WHERE OrderID = @OrderID;

    -- Call sub-procedure (it also uses SET XACT_ABORT ON + TRY/CATCH)
    EXEC dbo.ReserveInventory @OrderID = @OrderID;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    -- Transaction cleanup
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;

    -- Log error (using a separate connection or autonomous transaction isn't available in T-SQL
    -- so log after rollback to avoid the log row being rolled back too)
    INSERT INTO dbo.ErrorLog
        (ErrorTime, ErrorProc, ErrorLine, ErrorNumber, ErrorMsg, ErrorSeverity, ErrorState)
    VALUES
        (SYSDATETIME(), ERROR_PROCEDURE(), ERROR_LINE(),
         ERROR_NUMBER(), ERROR_MESSAGE(), ERROR_SEVERITY(), ERROR_STATE());

    -- Re-raise to caller
    THROW;
END CATCH;
GO
```

> [!NOTE]
> The error log INSERT happens **after** ROLLBACK. If you insert into the error log inside the TRY block or before ROLLBACK, the log row will be rolled back along with the main transaction. Always log after rolling back.

---

## Custom Error Messages (sp_addmessage)

User-defined messages use numbers ≥ 50001. They are stored in `sys.messages`.

```sql
-- Add a custom message
EXEC sp_addmessage
    @msgnum   = 50001,
    @severity = 16,
    @msgtext  = N'Order %d for customer %s exceeds credit limit of %m.',
    @lang     = 'us_english',
    @replace  = 'replace';   -- idempotent: replace if exists

-- Use in RAISERROR
RAISERROR(50001, 16, 1, @OrderID, @CustomerName, @CreditLimit);

-- Drop when no longer needed
EXEC sp_dropmessage @msgnum = 50001;
```

Preferred alternative: use THROW with inline strings (no catalog lookup needed), reserving sp_addmessage for multi-language environments or when multiple procs raise the same error with consistent numbering.

**Query custom messages:**
```sql
SELECT message_id, severity, [text]
FROM sys.messages
WHERE message_id >= 50000
  AND language_id = 1033   -- us_english
ORDER BY message_id;
```

---

## Error Severity Reference

| Severity | Category | Behavior |
|---|---|---|
| 0–10 | Informational | Does not trigger CATCH; returned as result set messages |
| 11–16 | User errors | Triggers CATCH; transaction not automatically rolled back |
| 17 | Resource errors | Insufficient resources (memory, locks); triggers CATCH |
| 18 | Nonfatal internal error | Triggers CATCH |
| 19 | Nonfatal resource error | Requires sysadmin; requires `WITH LOG`; triggers CATCH |
| 20–24 | Fatal errors | **Cannot be caught** by TRY/CATCH; terminates connection |
| 25 | Fatal system error | Terminates connection; may require server restart |

> [!WARNING]
> Severities 20–25 are connection-terminating. TRY/CATCH does not intercept them. Handle these at the application layer.

---

## Errors That Cannot Be Caught

Even with TRY/CATCH, some error conditions bypass the CATCH block entirely:

| Condition | Why |
|---|---|
| Compile errors (syntax errors, deferred name resolution) | Fail before execution; entire batch is rejected |
| Severity 20–25 errors | Terminate the connection |
| Attention events (client cancel, query timeout) | Interrupt execution path |
| `KILL` by another session | Terminates connection |
| Stack overflow (> 32 levels deep) | Connection-terminating |
| Arithmetic overflow with `SET ARITHABORT ON` | Depends: can be caught if severity ≤ 19 |

> [!NOTE]
> Deferred name resolution means a procedure referencing a non-existent table compiles successfully (the table is assumed to exist later). The error fires at runtime, so it **is** catchable. But a syntax error in the batch itself is not.

---

## Logging Errors to a Table

```sql
-- Error log table
CREATE TABLE dbo.ErrorLog (
    ErrorID       INT           NOT NULL IDENTITY(1,1) CONSTRAINT PK_ErrorLog PRIMARY KEY,
    ErrorTime     DATETIME2(3)  NOT NULL DEFAULT SYSDATETIME(),
    ErrorProc     NVARCHAR(256) NULL,
    ErrorLine     INT           NULL,
    ErrorNumber   INT           NOT NULL,
    ErrorSeverity INT           NOT NULL,
    ErrorState    INT           NOT NULL,
    ErrorMsg      NVARCHAR(4000) NOT NULL,
    SessionID     INT           NOT NULL DEFAULT @@SPID,
    LoginName     NVARCHAR(256) NOT NULL DEFAULT SYSTEM_USER
);

-- Reusable logging procedure
CREATE OR ALTER PROCEDURE dbo.LogError
AS
SET NOCOUNT ON;
INSERT INTO dbo.ErrorLog
    (ErrorProc, ErrorLine, ErrorNumber, ErrorSeverity, ErrorState, ErrorMsg)
VALUES
    (ERROR_PROCEDURE(), ERROR_LINE(), ERROR_NUMBER(),
     ERROR_SEVERITY(), ERROR_STATE(), ERROR_MESSAGE());
GO

-- Usage in CATCH (after ROLLBACK)
BEGIN CATCH
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;

    EXEC dbo.LogError;   -- runs in its own implicit transaction

    THROW;
END CATCH;
```

> [!NOTE]
> Because `dbo.LogError` is called after `ROLLBACK TRANSACTION`, the INSERT is not wrapped in the outer transaction — it commits independently. This is the correct pattern. If you call it before rolling back, the log row is lost when the transaction rolls back.

---

## Error Handling in Dynamic SQL

Errors inside `sp_executesql` or `EXEC(@sql)` are caught by the *calling* scope's CATCH block.

```sql
BEGIN TRY
    EXEC sp_executesql N'SELECT 1/0';   -- divide by zero
END TRY
BEGIN CATCH
    -- ERROR_NUMBER() = 8134 (divide by zero) — caught here
    SELECT ERROR_NUMBER(), ERROR_MESSAGE();
END CATCH;
```

When `XACT_ABORT ON` is set in the *outer* scope, an error in the dynamic SQL batch also dooms the outer transaction. If you want to isolate dynamic SQL errors, set `XACT_ABORT OFF` inside the dynamic batch (but this is rarely the right choice).

```sql
-- Isolated dynamic SQL with its own error handling
EXEC sp_executesql
    N'BEGIN TRY
          SET XACT_ABORT ON;
          -- risky work
      END TRY
      BEGIN CATCH
          THROW;
      END CATCH;';
```

---

## Error Handling in Natively Compiled Procs

Natively compiled stored procedures (In-Memory OLTP) support TRY/CATCH with restrictions:

```sql
CREATE PROCEDURE dbo.NativeProc
    @OrderID INT
WITH NATIVE_COMPILATION, SCHEMABINDING, EXECUTE AS OWNER
AS
BEGIN ATOMIC WITH (TRANSACTION ISOLATION LEVEL = SNAPSHOT, LANGUAGE = N'us_english')
    BEGIN TRY
        UPDATE dbo.MemOptOrders SET Status = 1 WHERE OrderID = @OrderID;
    END TRY
    BEGIN CATCH
        THROW;   -- re-raise is supported
    END CATCH;
END;
GO
```

**Restrictions in natively compiled procs:**
- `RAISERROR` is **not supported** — use `THROW` only.[^1]
- `SAVE TRANSACTION` is not supported.
- `@@TRANCOUNT` is not accessible; use `XACT_STATE()`.
- Nested TRY/CATCH is supported.
- `BEGIN ATOMIC` always starts a new transaction — no outer transaction join possible.

---

## Gotchas / Anti-patterns

1. **Semicolon before THROW.** `THROW` requires a statement terminator before it. `INSERT ...; THROW` is fine, but `INSERT ... THROW` without a semicolon is a syntax error. Many developers hit this in scripts. Always end the prior statement with `;`.

2. **Catching without re-raising silently swallows errors.** A CATCH block that logs and returns normally hides failures from callers. Always THROW (or at minimum propagate a non-zero return value) unless you have an explicit design reason to absorb the error.

3. **Logging before ROLLBACK loses the log row.** If you INSERT into an error log table while the transaction is still active, that INSERT is rolled back with everything else. Log **after** `ROLLBACK TRANSACTION`.

4. **XACT_ABORT OFF + nested procs = open transactions.** If a called procedure uses `SET XACT_ABORT OFF` (the default), encounters an error, and returns without rolling back, the caller inherits an open transaction with `@@TRANCOUNT > 0`. Always use `XACT_ABORT ON` in DML procedures.

5. **Checking @@TRANCOUNT instead of XACT_STATE() in CATCH.** With `XACT_ABORT ON`, the engine may have already rolled back the transaction by the time CATCH fires. `@@TRANCOUNT` could be 0, but you'd still try to rollback, causing error 3903. Check `XACT_STATE() <> 0` instead.

6. **RAISERROR severity 0–10 does not trigger CATCH.** `RAISERROR('msg', 10, 1)` is informational and passes through TRY without entering CATCH. If you want CATCH to fire, use severity ≥ 11.

7. **Compile-time errors bypass TRY/CATCH.** A missing column or table reference that's caught at compile time (direct reference) fails before the TRY block executes. The fix is to move such references inside a nested procedure or dynamic SQL so that the error is deferred to runtime.

8. **THROW without arguments is only valid inside CATCH.** `THROW;` (bare) outside a CATCH block raises error 11000 ("THROW statement was used with no arguments outside a CATCH block").

9. **Transactions survive procedure scope boundaries.** A procedure can return with `@@TRANCOUNT > 0` if COMMIT or ROLLBACK is omitted. The caller sees an orphaned transaction. Use a guard pattern: `IF @@TRANCOUNT <> @InitialTranCount ROLLBACK` at procedure exit.

10. **SET XACT_ABORT applies per session, not per batch.** If a connection pool reuses sessions, XACT_ABORT state from a previous execution may persist. Always SET XACT_ABORT ON at the start of procedures rather than relying on a connection-level default.

---

## See Also

- [`13-transactions-locking.md`](13-transactions-locking.md) — XACT_ABORT, isolation levels, @@TRANCOUNT nesting rules
- [`06-stored-procedures.md`](06-stored-procedures.md) — procedure-level error handling, EXECUTE AS
- [`18-in-memory-oltp.md`](18-in-memory-oltp.md) — natively compiled proc restrictions
- [`23-dynamic-sql.md`](23-dynamic-sql.md) — error propagation in sp_executesql

---

## Sources

[^1]: [THROW (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/throw-transact-sql) — THROW syntax, bare re-raise, and RAISERROR incompatibility in natively compiled procs
[^2]: [TRY...CATCH (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/try-catch-transact-sql) — error function availability, severity behavior, and conditions that bypass CATCH
[^3]: [RAISERROR (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/raiserror-transact-sql) — severity table, format specifiers, WITH LOG / WITH NOWAIT
[^4]: [XACT_STATE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/xact-state-transact-sql) — return values (-1, 0, 1) and behavior with XACT_ABORT
[^5]: [SAVE TRANSACTION (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/save-transaction-transact-sql) — savepoint semantics and @@TRANCOUNT behavior
[^6]: [Error Handling in SQL Server – a Background](https://www.sommarskog.se/error-handling-I.html) — comprehensive analysis of TRY/CATCH, THROW vs RAISERROR, and nested transaction patterns by Erland Sommarskog
[^7]: [Error Handling Quiz Week: Making a Turkey Sandwich with XACT_ABORT](https://www.brentozar.com/archive/2022/01/error-handling-quiz-week-making-a-turkey-sandwich-with-xact_abort/) — Brent Ozar demonstrates practical XACT_ABORT ON patterns in stored procedures, showing how it ensures transactions roll back completely on error

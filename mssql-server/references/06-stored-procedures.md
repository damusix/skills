# Stored Procedures Reference

## Table of Contents

1. [When to Use](#when-to-use)
2. [Basic Syntax](#basic-syntax)
3. [Parameters](#parameters)
   - [Input Parameters](#input-parameters)
   - [Output Parameters](#output-parameters)
   - [Return Values](#return-values)
   - [Table-Valued Parameters (TVPs)](#table-valued-parameters-tvps)
   - [Default Parameter Values](#default-parameter-values)
4. [Execution Context (EXECUTE AS)](#execution-context-execute-as)
5. [Parameter Sniffing](#parameter-sniffing)
   - [What It Is](#what-it-is)
   - [When It Hurts](#when-it-hurts)
   - [Mitigation Strategies](#mitigation-strategies)
6. [Recompilation Strategies](#recompilation-strategies)
7. [Result Sets and Metadata](#result-sets-and-metadata)
8. [Nesting, Recursion, and Scope](#nesting-recursion-and-scope)
9. [Error Handling in Procedures](#error-handling-in-procedures)
10. [System Stored Procedures and Extended Procedures](#system-stored-procedures-and-extended-procedures)
11. [Gotchas / Anti-Patterns](#gotchas--anti-patterns)
12. [See Also](#see-also)
13. [Sources](#sources)

---

## When to Use

Stored procedures are the right tool when you need:

- **Encapsulated logic** behind a stable API that clients call (isolates schema changes from application code)
- **Security boundary**: GRANT EXECUTE on a proc without exposing underlying tables (ownership chaining)
- **Batch/ETL operations**: multi-step transactions with error handling, temp tables, cursor loops
- **Performance-sensitive workloads** that benefit from cached plans (but see param sniffing caveats)
- **DDL automation**: maintenance scripts, dynamic index rebuilds, deployment routines
- **Output contracts**: integration points where the result-set shape is contractual

Prefer **inline TVFs** over procedures when the caller needs to compose/filter the result (procs can't be joined; TVFs can). Prefer **application-layer logic** when the logic is complex, stateful, or hard to test in T-SQL.

---

## Basic Syntax

```sql
-- Create
CREATE PROCEDURE dbo.usp_GetOrder
    @OrderId   INT,
    @CustomerId INT = NULL          -- optional param with default
AS
BEGIN
    SET NOCOUNT ON;                 -- suppress "N rows affected" messages

    SELECT o.OrderId, o.OrderDate, o.TotalAmount
    FROM   dbo.Orders o
    WHERE  o.OrderId    = @OrderId
      AND  (@CustomerId IS NULL OR o.CustomerId = @CustomerId);
END;
GO

-- Alter (preserves permissions)
ALTER PROCEDURE dbo.usp_GetOrder
    @OrderId INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM dbo.Orders WHERE OrderId = @OrderId;
END;
GO

-- Drop
DROP PROCEDURE IF EXISTS dbo.usp_GetOrder;  -- IF EXISTS: SQL Server 2016+

-- Execute
EXEC dbo.usp_GetOrder @OrderId = 42;
EXEC dbo.usp_GetOrder 42;                   -- positional (fragile — avoid)
```

> [!NOTE] SQL Server 2016+
> `DROP PROCEDURE IF EXISTS` avoids the older `IF OBJECT_ID(...) IS NOT NULL` boilerplate.

Always use **named parameter syntax** (`@Param = value`) in EXEC calls. Positional calls break silently if the procedure signature ever changes.

---

## Parameters

### Input Parameters

```sql
CREATE PROCEDURE dbo.usp_SearchProducts
    @CategoryId   INT,
    @MinPrice     DECIMAL(10,2) = 0,
    @MaxPrice     DECIMAL(10,2) = NULL,
    @SearchTerm   NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT p.ProductId, p.Name, p.Price
    FROM   dbo.Products p
    WHERE  p.CategoryId = @CategoryId
      AND  p.Price      >= @MinPrice
      AND  (@MaxPrice  IS NULL OR p.Price <= @MaxPrice)
      AND  (@SearchTerm IS NULL OR p.Name LIKE N'%' + @SearchTerm + N'%');
END;
```

**Parameter data types**: always specify the exact type and length. Never use bare `VARCHAR` (defaults to `VARCHAR(1)` in parameter declarations — a silent truncation trap).

### Output Parameters

```sql
CREATE PROCEDURE dbo.usp_InsertCustomer
    @Name        NVARCHAR(200),
    @Email       NVARCHAR(200),
    @CustomerId  INT OUTPUT          -- caller receives the new PK
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.Customers (Name, Email)
    VALUES (@Name, @Email);

    SET @CustomerId = SCOPE_IDENTITY();
END;
GO

-- Caller
DECLARE @NewId INT;
EXEC dbo.usp_InsertCustomer
    @Name       = N'Alice',
    @Email      = N'alice@example.com',
    @CustomerId = @NewId OUTPUT;

SELECT @NewId AS NewCustomerId;
```

Use `SCOPE_IDENTITY()` — **not** `@@IDENTITY` — to retrieve the last inserted identity value. `@@IDENTITY` fires across triggers and can return wrong values. [^1]

### Return Values

```sql
CREATE PROCEDURE dbo.usp_CheckStock
    @ProductId INT,
    @Qty       INT
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1 FROM dbo.Inventory
        WHERE ProductId = @ProductId AND QuantityOnHand >= @Qty
    )
        RETURN 0;   -- success / in stock
    ELSE
        RETURN 1;   -- insufficient stock
END;
GO

-- Caller
DECLARE @rc INT;
EXEC @rc = dbo.usp_CheckStock @ProductId = 7, @Qty = 10;
IF @rc <> 0
    PRINT 'Out of stock';
```

**Convention**: use return value = 0 for success, non-zero for error codes. Do not use return values to pass data (that is what OUTPUT params or result sets are for). SQL Server itself uses negative return values for system procedures (e.g., `-1` = object not found).

### Table-Valued Parameters (TVPs)

TVPs let callers pass a set of rows into a procedure, replacing the older comma-separated string anti-pattern.

```sql
-- 1. Create the type (once, per database)
CREATE TYPE dbo.OrderLineType AS TABLE (
    ProductId   INT           NOT NULL,
    Quantity    INT           NOT NULL,
    UnitPrice   DECIMAL(10,2) NOT NULL
);
GO

-- 2. Use it in a procedure (must be READONLY)
CREATE PROCEDURE dbo.usp_InsertOrderLines
    @OrderId    INT,
    @Lines      dbo.OrderLineType READONLY
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.OrderLines (OrderId, ProductId, Quantity, UnitPrice)
    SELECT @OrderId, ProductId, Quantity, UnitPrice
    FROM   @Lines;
END;
GO

-- 3. Call from T-SQL
DECLARE @lines dbo.OrderLineType;
INSERT INTO @lines VALUES (1, 5, 9.99), (3, 2, 4.50);
EXEC dbo.usp_InsertOrderLines @OrderId = 100, @Lines = @lines;
```

**TVP notes:**
- TVP parameters must be declared `READONLY` — no DML inside the proc on the TVP.
- A TVP is a table variable; statistics are not maintained, and the optimizer assumes 1 row unless the actual row count triggers deferred compilation (SQL Server 2019+ with IQP table variable deferred compilation). [^2]
- The table type must exist in the same database as the procedure.
- From ADO.NET, pass as `SqlDbType.Structured` with a `DataTable` or `IEnumerable<SqlDataRecord>`.

> [!NOTE] SQL Server 2019+
> Table variable deferred compilation (part of IQP) allows the optimizer to use actual row counts for TVPs at first execution. No code change required; enable via database compatibility level 150+.

### Default Parameter Values

```sql
CREATE PROCEDURE dbo.usp_Paginate
    @PageNumber INT = 1,
    @PageSize   INT = 20
AS
BEGIN
    SET NOCOUNT ON;
    SELECT *
    FROM   dbo.Products
    ORDER  BY ProductId
    OFFSET (@PageNumber - 1) * @PageSize ROWS
    FETCH  NEXT @PageSize ROWS ONLY;
END;
```

To use a default, the caller must pass `DEFAULT` explicitly or omit the argument (only works if it's the last positional param or named params are used):

```sql
EXEC dbo.usp_Paginate;                        -- both defaults
EXEC dbo.usp_Paginate @PageSize = 50;         -- PageNumber defaults to 1
EXEC dbo.usp_Paginate DEFAULT, 50;            -- positional with DEFAULT keyword
```

---

## Execution Context (EXECUTE AS)

`EXECUTE AS` changes the security context inside the procedure. Options:

| Clause | Runs as | Use case |
|--------|---------|----------|
| `EXECUTE AS CALLER` | Calling user | Default; least surprise |
| `EXECUTE AS OWNER` | Proc owner (usually `dbo`) | Ownership chaining across schemas/databases |
| `EXECUTE AS SELF` | User who **created** the proc | Embedding creator privileges |
| `EXECUTE AS 'user_name'` | Named database user | Fine-grained fixed identity |

### Option Comparison Table

| Option | Effective Principal | Ownership Chaining | Crosses Database Boundary | Crosses Linked Server | Audit Trail Shows | Best For |
|--------|--------------------|--------------------|---------------------------|-----------------------|-------------------|----------|
| `CALLER` (default) | Calling user's identity | Yes — chains through owned objects | Yes — caller's login follows naturally | Yes — caller's credentials pass through | Original caller | Standard procs; no privilege elevation needed |
| `OWNER` | Schema/object owner at execution time | Yes — chains through owned objects | No — resets at DB boundary | No | Object owner | Maintenance procs needing elevated rights within one database |
| `SELF` | User who ran `CREATE PROCEDURE` | Yes — chains through owned objects | No — resets at DB boundary | No | Creator's identity | Fixed-identity access; creator embedded in proc definition |
| `'user_name'` | Named database principal | No — breaks ownership chain | No — requires `TRUSTWORTHY` or cert-based auth for cross-DB | No | Named user | Delegated access scoped to a specific user's exact permissions |

```sql
-- Allow low-privilege users to run maintenance without DBA rights
CREATE PROCEDURE dbo.usp_RebuildIndex
    @TableName SYSNAME
WITH EXECUTE AS OWNER      -- runs with dbo rights
AS
BEGIN
    SET NOCOUNT ON;
    -- Dynamic SQL here inherits EXECUTE AS OWNER context
    DECLARE @sql NVARCHAR(1000) =
        N'ALTER INDEX ALL ON ' + QUOTENAME(@TableName) + N' REBUILD;';
    EXEC sp_executesql @sql;
END;
```

### Named-User Example: `WITH EXECUTE AS 'user_name'`

**Scenario**: a low-privilege app account (`AppUser`) needs to call a proc that reads from a restricted audit table (`dbo.AuditLog`), which only `AuditReader` has SELECT on. Rather than granting `AppUser` direct access to `AuditLog`, bind the proc to `AuditReader`'s identity.

```sql
-- Step 1: ensure AuditReader exists as a database principal
CREATE USER AuditReader WITHOUT LOGIN;  -- database-only user; no server login needed

-- Step 2: grant AuditReader the rights the proc needs
GRANT SELECT ON dbo.AuditLog TO AuditReader;

-- Step 3: create the proc bound to AuditReader
CREATE PROCEDURE dbo.usp_GetAuditEvents
    @StartDate DATETIME2,
    @EndDate   DATETIME2
WITH EXECUTE AS 'AuditReader'
AS
BEGIN
    SET NOCOUNT ON;

    -- Inside the proc, show what each identity function returns:
    -- ORIGINAL_LOGIN() = the server login of the actual caller (e.g., 'DOMAIN\appservice')
    -- SUSER_SNAME()    = current server principal = same as ORIGINAL_LOGIN() here
    --                    (EXECUTE AS 'user' maps to a DB principal, not a server login)
    -- USER_NAME()      = current database user = 'AuditReader'
    SELECT
        ORIGINAL_LOGIN()          AS ActualLogin,      -- e.g., DOMAIN\appservice
        SUSER_SNAME()             AS ServerPrincipal,  -- e.g., DOMAIN\appservice
        USER_NAME()               AS DBUser,           -- AuditReader
        EventTime, EventType, AffectedObject, ChangedBy
    FROM dbo.AuditLog
    WHERE EventTime BETWEEN @StartDate AND @EndDate
    ORDER BY EventTime DESC;
END;
GO

-- Step 4: grant AppUser EXECUTE on the proc (NOT on AuditLog)
GRANT EXECUTE ON dbo.usp_GetAuditEvents TO AppUser;

-- Caller (AppUser) runs the proc; inside it runs as AuditReader
EXEC dbo.usp_GetAuditEvents
    @StartDate = '2026-01-01',
    @EndDate   = '2026-03-18';
```

**Identity functions inside `EXECUTE AS 'user_name'`:**

| Function | Returns | Notes |
|----------|---------|-------|
| `USER_NAME()` | `'AuditReader'` | The impersonated DB principal |
| `ORIGINAL_LOGIN()` | `'DOMAIN\appservice'` | The real server login; never changes during impersonation |
| `SUSER_SNAME()` | `'DOMAIN\appservice'` | Same as ORIGINAL_LOGIN here — `EXECUTE AS user` doesn't switch the server login |
| `SYSTEM_USER` | `'DOMAIN\appservice'` | Server-level login; unaffected by DB-level impersonation |

> [!WARNING]
> `EXECUTE AS 'user'` context does NOT cross linked server or cross-database boundaries unless a certificate-based login or impersonation chain is explicitly configured. The context is dropped at the boundary. [^3]

### Gotcha: Named-User Prerequisites

`EXECUTE AS 'user_name'` has several requirements that silently break when not met:

1. **The user must be a database principal** — `EXECUTE AS` resolves the name against `sys.database_principals`. If the user is dropped or renamed, the proc fails at runtime with error 15517 ("Cannot execute as the database principal because the principal does not exist...").
2. **`WITHOUT LOGIN` users can only be impersonated within the same database** — for cross-database impersonation via `TRUSTWORTHY`, the named user must map to a server login, and `TRUSTWORTHY` must be ON for the calling database.
3. **Certificate-based alternative**: to avoid `TRUSTWORTHY`, sign the procedure with a certificate, create a login from that certificate in the target database, and grant the login the needed permissions — more secure but requires more setup. [^3]
4. **Audit implications**: `ORIGINAL_LOGIN()` always reveals the true caller — use this in audit queries inside the proc to preserve traceability.

**Best practice**: prefer `EXECUTE AS OWNER` combined with schema ownership to avoid naming a specific user (which breaks when that user is dropped). Use `EXECUTE AS 'user_name'` only when you need a specific, stable, narrow permission set that cannot be modeled through ownership. Use `WITH SCHEMABINDING` on views, not procedures — procedures do not support SCHEMABINDING.

---

## Parameter Sniffing

### What It Is

When SQL Server first compiles a stored procedure, it **sniffs** (reads) the actual runtime parameter values and builds a plan optimized for those values. That compiled plan is cached. Future executions reuse the cached plan — even if called with very different parameter values.

```sql
-- First call: @CustomerId = 1 (has 50,000 orders → scan plan cached)
EXEC dbo.usp_GetOrders @CustomerId = 1;

-- Second call: @CustomerId = 99999 (has 1 order → forced to use scan plan)
EXEC dbo.usp_GetOrders @CustomerId = 99999;
```

### When It Hurts

Parameter sniffing is **beneficial 90% of the time** — cached plans avoid recompilation overhead. It hurts when:

1. **Skewed data**: one value has millions of rows, another has 5; a single plan can't serve both well.
2. **First execution at startup with an atypical value**: e.g., a monthly report with a very wide date range compiles the plan first, then all small daily lookups get the scan plan.
3. **Plan cache pollution after a recompile** with a bad value.

### Mitigation Strategies

**Strategy 1 — OPTION (RECOMPILE) on the statement** (not the whole proc):

```sql
CREATE PROCEDURE dbo.usp_GetOrders
    @CustomerId INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM dbo.Orders
    WHERE CustomerId = @CustomerId
    OPTION (RECOMPILE);          -- recompiles only this statement each call
END;
```

`OPTION (RECOMPILE)` causes statement-level recompilation at every execution, embedding the actual parameter value. Ideal when:
- The proc is called infrequently but with highly variable parameters.
- Compile time is negligible vs execution time.

**Strategy 2 — OPTIMIZE FOR UNKNOWN** (stable but potentially non-optimal plan):

```sql
SELECT * FROM dbo.Orders
WHERE CustomerId = @CustomerId
OPTION (OPTIMIZE FOR (@CustomerId UNKNOWN));
```

Forces the optimizer to use average selectivity estimates rather than the sniffed value. Prevents bad-sniff plans but may underperform good-sniff plans.

**Strategy 3 — OPTIMIZE FOR (specific value)**:

```sql
OPTION (OPTIMIZE FOR (@CustomerId = 1));
```

Forces compilation as if `@CustomerId = 1`. Use when the "typical" case is well known.

**Strategy 4 — Local variable copy** (old-school workaround — avoid):

```sql
DECLARE @cid INT = @CustomerId;
SELECT * FROM dbo.Orders WHERE CustomerId = @cid;
```

Local variables defeat sniffing — the optimizer uses average statistics. Side effect: you lose the benefit of sniffing even on the common case. **Do not use as a general pattern**; use `OPTIMIZE FOR UNKNOWN` instead, which is explicit about intent. [^4]

**Strategy 5 — Multiple procedure variants**:

```sql
-- Separate procs for the known skewed cases
IF @CustomerId IN (1, 2, 3)     -- known high-volume customers
    EXEC dbo.usp_GetOrders_Scan @CustomerId;
ELSE
    EXEC dbo.usp_GetOrders_Seek @CustomerId;
```

Extreme measure; only justified for highly critical hotspot queries.

**Strategy 6 — WITH RECOMPILE on the procedure** (nuclear option):

```sql
CREATE PROCEDURE dbo.usp_GetOrders
    @CustomerId INT
WITH RECOMPILE
AS ...
```

Recompiles the **entire procedure** on every call. Almost never the right choice — use statement-level `OPTION (RECOMPILE)` instead.

> [!NOTE] SQL Server 2022+
> Parameter-Sensitive Plan Optimization (PSPO) in Query Store can automatically maintain multiple plans for the same proc/query, picking the best based on runtime parameter values. Enable by setting Query Store to `READ_WRITE` and database compatibility level 160+. [^5]

---

## Recompilation Strategies

Beyond parameter sniffing, a procedure recompiles when:

| Trigger | Description |
|---------|-------------|
| Schema change | Underlying table/view altered |
| Statistics update | Stats refreshed on referenced objects |
| `SET` option change | Different session `SET ANSI_NULLS`, etc. |
| `WITH RECOMPILE` | Explicit proc-level flag |
| `OPTION (RECOMPILE)` | Statement-level hint |
| `sp_recompile` | Marks a specific object for next-execution recompile |
| `DBCC FREEPROCCACHE` | Clears the entire plan cache |

```sql
-- Force recompile of a single proc on its next execution
EXEC sp_recompile 'dbo.usp_GetOrders';

-- Force recompile of all procs referencing a table on their next execution
EXEC sp_recompile 'dbo.Orders';
```

---

## Result Sets and Metadata

### Returning Multiple Result Sets

```sql
CREATE PROCEDURE dbo.usp_OrderSummary
    @OrderId INT
AS
BEGIN
    SET NOCOUNT ON;

    -- Result set 1: header
    SELECT OrderId, OrderDate, CustomerId, TotalAmount
    FROM   dbo.Orders
    WHERE  OrderId = @OrderId;

    -- Result set 2: lines
    SELECT ProductId, Quantity, UnitPrice
    FROM   dbo.OrderLines
    WHERE  OrderId = @OrderId;
END;
```

Callers must consume result sets in order. ADO.NET uses `SqlDataReader.NextResult()`.

### WITH RESULT SETS (explicit contract)

```sql
EXEC dbo.usp_OrderSummary @OrderId = 1
WITH RESULT SETS (
    (
        OrderId    INT          NOT NULL,
        OrderDate  DATETIME2    NOT NULL,
        CustomerId INT          NOT NULL,
        Total      DECIMAL(12,2) NOT NULL
    ),
    (
        ProductId  INT          NOT NULL,
        Qty        INT          NOT NULL,
        UnitPrice  DECIMAL(10,2) NOT NULL
    )
);
```

`WITH RESULT SETS` documents the contract and renames columns without touching the procedure. Useful when calling from SSIS, linked servers, or cross-database calls where metadata is consumed programmatically.

---

## Nesting, Recursion, and Scope

- SQL Server supports up to **32 levels of procedure nesting** (`@@NESTLEVEL`). [^6]
- Each nested procedure executes in the **caller's transaction context** (same @@TRANCOUNT).
- Temp tables (`#temp`) created in a caller procedure are **visible** to called procedures. Table variables are **not** visible across procedure boundaries.
- Recursive stored procedures are permitted but limited by the 32-level nesting cap. Prefer recursive CTEs for set-based recursion.

```sql
-- Check nesting depth
CREATE PROCEDURE dbo.usp_Inner AS
BEGIN
    SELECT @@NESTLEVEL AS NestLevel;
END;

CREATE PROCEDURE dbo.usp_Outer AS
BEGIN
    SELECT @@NESTLEVEL AS NestLevel;
    EXEC dbo.usp_Inner;
END;

EXEC dbo.usp_Outer;
-- Returns: 1, then 2
```

---

## Error Handling in Procedures

```sql
CREATE PROCEDURE dbo.usp_TransferFunds
    @FromAccountId INT,
    @ToAccountId   INT,
    @Amount        DECIMAL(18,2)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;      -- auto-rollback on runtime error

    BEGIN TRANSACTION;

    BEGIN TRY
        UPDATE dbo.Accounts
        SET    Balance = Balance - @Amount
        WHERE  AccountId = @FromAccountId;

        IF @@ROWCOUNT = 0
            THROW 50001, 'Source account not found.', 1;

        UPDATE dbo.Accounts
        SET    Balance = Balance + @Amount
        WHERE  AccountId = @ToAccountId;

        IF @@ROWCOUNT = 0
            THROW 50002, 'Destination account not found.', 1;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        THROW;  -- re-raise to caller
    END CATCH;
END;
```

See [`14-error-handling.md`](./14-error-handling.md) for the full `TRY/CATCH/THROW` reference, savepoints, and `XACT_ABORT` interaction.

---

## System Stored Procedures and Extended Procedures

Commonly used system procedures:

| Procedure | Purpose |
|-----------|---------|
| `sp_executesql` | Parameterized dynamic SQL — always prefer over `EXEC(@sql)` |
| `sp_recompile` | Mark proc/table for next-exec recompile |
| `sp_help` | Object metadata summary |
| `sp_helptext` | View proc definition text (use `sys.sql_modules` instead) |
| `sp_depends` | Deprecated; use `sys.sql_expression_dependencies` |
| `sp_rename` | Rename objects (use with caution — does not update references) |
| `sp_addmessage` | Add user-defined error messages to `sys.messages` |
| `sp_send_dbmail` | Send email (requires Database Mail setup) |
| `sp_configure` | View/set server configuration options |
| `xp_cmdshell` | Execute OS commands (disabled by default; security risk) |

> [!WARNING] Deprecated
> `sp_helptext` is not deprecated but `sp_depends` is — last supported in SQL Server 2012. Use `sys.sql_expression_dependencies` for dependency tracking.

**Viewing procedure text:**

```sql
-- Best: shows current definition including SET options
SELECT definition
FROM   sys.sql_modules
WHERE  object_id = OBJECT_ID('dbo.usp_GetOrders');

-- Alt: works on encrypted procs only if you have VIEW DEFINITION
EXEC sp_helptext 'dbo.usp_GetOrders';
```

**Listing procedures in a database:**

```sql
SELECT
    SCHEMA_NAME(schema_id)  AS SchemaName,
    name                    AS ProcName,
    create_date,
    modify_date,
    is_auto_executed        -- Service Broker activation procs
FROM sys.procedures
ORDER BY SchemaName, ProcName;
```

---

## Gotchas / Anti-Patterns

### 1. Missing SET NOCOUNT ON
Every procedure should begin with `SET NOCOUNT ON`. Without it, each DML statement sends a "N rows affected" message over the network. In tight loops or batch procs, this adds measurable overhead and can confuse ADO.NET `ExecuteNonQuery()` row count checks.

### 2. SELECT * in Stored Procedures
`SELECT *` inside a proc captures the column list at **compile time** (metadata is cached). If you add a column to the underlying table, the proc returns the old column set until you run `EXEC sp_recompile` or `ALTER PROCEDURE`. Always list columns explicitly.

### 3. Bare VARCHAR / NVARCHAR Parameters
```sql
-- WRONG: @Name defaults to VARCHAR(1)
CREATE PROCEDURE dbo.usp_Find @Name VARCHAR AS ...

-- CORRECT
CREATE PROCEDURE dbo.usp_Find @Name VARCHAR(200) AS ...
```

### 4. Using @@ROWCOUNT After Error Checks
`@@ROWCOUNT` is reset by **any** statement, including `IF` and `SELECT`. Capture it immediately:

```sql
UPDATE dbo.Orders SET Status = 'Shipped' WHERE OrderId = @Id;
DECLARE @affected INT = @@ROWCOUNT;   -- capture before any other statement
IF @affected = 0
    THROW 50010, 'Order not found', 1;
```

### 5. Implicit Transaction Leaks
If `XACT_ABORT OFF` (the default) and an error occurs mid-transaction without a `CATCH` block, the transaction stays open. Always use `SET XACT_ABORT ON` in procedures that run DML, or ensure a `CATCH` block with `ROLLBACK`. [^7]

### 6. sp_executesql Plan Reuse Requires Exact SQL Text
Plan reuse for `sp_executesql` requires identical SQL string and parameter declarations. Even whitespace differences cause new plan compilations.

```sql
-- These are different queries in the plan cache:
EXEC sp_executesql N'SELECT * FROM dbo.Orders WHERE Id=@id', N'@id INT', @id=1;
EXEC sp_executesql N'SELECT * FROM dbo.Orders WHERE Id = @id', N'@id INT', @id=1;
```

### 7. Ownership Chaining Breaks with Dynamic SQL
`EXECUTE AS OWNER` grants the procedure owner's context — but **only through the static execution path**. When the proc calls `EXEC sp_executesql`, the ownership chain is broken and the execution context must have explicit permission on the dynamic objects. [^3]

### 8. Procedure Name Prefix sp_
Never name user procedures with the `sp_` prefix. SQL Server searches `master` first for `sp_` procs. If a system proc with the same name is added in a future version, yours is hidden. Use `usp_`, `p_`, or no prefix with a schema qualifier. [^8]

### 9. NOT EXISTS vs NOT IN with NULLs in Parameter Lists
See `03-syntax-dml.md` for the NULL-in-NOT-IN problem. The same applies inside procedures: never pass a nullable list and use `NOT IN` without handling NULLs.

### 10. Parameter Sniffing in Infrequently-Called Procs
If a procedure is rarely called and compiled at an atypical parameter value (e.g., an end-of-month rollup run at 3 AM with a year's date range), the resulting scan plan stays cached and hurts normal daytime lookups. Address with `OPTION (RECOMPILE)` on the problematic statement, or separate the two workloads into different procedures.

---

## See Also

- [`04-ctes.md`](./04-ctes.md) — CTE alternatives to temp table patterns inside procs
- [`07-functions.md`](./07-functions.md) — TVFs vs procedures for composable queries
- [`13-transactions-locking.md`](./13-transactions-locking.md) — isolation levels and locking inside proc transactions
- [`14-error-handling.md`](./14-error-handling.md) — full TRY/CATCH/THROW/savepoint reference
- [`15-principals-permissions.md`](./15-principals-permissions.md) — EXECUTE AS, ownership chaining, GRANT on procedures
- [`23-dynamic-sql.md`](./23-dynamic-sql.md) — safe sp_executesql patterns, injection prevention
- [`30-query-store.md`](./30-query-store.md) — forced plans and PSPO for parameter sniffing
- [`32-performance-diagnostics.md`](./32-performance-diagnostics.md) — plan cache DMVs, OPTION hints

---

## Sources

[^1]: [SCOPE_IDENTITY (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/scope-identity-transact-sql) — explains the difference between SCOPE_IDENTITY() and @@IDENTITY, including trigger scope behavior that causes @@IDENTITY to return wrong values
[^2]: [Intelligent Query Processing Details - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — covers table variable deferred compilation (SQL Server 2019+, compatibility level 150+) and other IQP features
[^3]: [EXECUTE AS Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/execute-as-clause-transact-sql) — covers all EXECUTE AS options, ownership chaining rules, and cross-database/linked-server boundary limitations
[^4]: [The Elephant and the Mouse, or, Parameter Sniffing in SQL Server](https://www.brentozar.com/archive/2013/06/the-elephant-and-the-mouse-or-parameter-sniffing-in-sql-server/) — Brent Ozar explains parameter sniffing, why local variable workarounds defeat sniffing, and when to use OPTION (RECOMPILE)
[^5]: [Parameter Sensitive Plan Optimization - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/performance/parameter-sensitive-plan-optimization) — covers PSPO in SQL Server 2022+, which automatically maintains multiple cached plans per parameterized query based on runtime parameter values
[^6]: [@@NESTLEVEL (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/nestlevel-transact-sql) — documents the @@NESTLEVEL function and states the 32-level maximum nesting limit for stored procedure calls
[^7]: [SET XACT_ABORT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-xact-abort-transact-sql) — explains how SET XACT_ABORT ON causes automatic rollback on runtime errors, preventing implicit transaction leaks
[^8]: [Stored Procedures (Database Engine) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/stored-procedures/stored-procedures-database-engine) — Microsoft documentation explicitly stating not to use the sp_ prefix for user-defined procedures, as system procedures use that prefix and SQL Server searches the sys schema first

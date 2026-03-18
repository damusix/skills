# 07 — Functions: Scalar, Inline TVF, Multi-Statement TVF, System Functions, Inlining

## Table of Contents

1. [When to Use](#when-to-use)
2. [Function Types Overview](#function-types-overview)
3. [Scalar User-Defined Functions](#scalar-user-defined-functions)
4. [Scalar UDF Inlining (2019+)](#scalar-udf-inlining-2019)
5. [Inline Table-Valued Functions](#inline-table-valued-functions)
6. [Multi-Statement Table-Valued Functions](#multi-statement-table-valued-functions)
7. [iTVF vs mTVF Performance](#itvf-vs-mtvf-performance)
8. [Determinism and SCHEMABINDING](#determinism-and-schemabinding)
9. [Aggregate Functions (CLR)](#aggregate-functions-clr)
10. [System Function Reference](#system-function-reference)
11. [Window Functions in Functions](#window-functions-in-functions)
12. [Dropping and Altering Functions](#dropping-and-altering-functions)
13. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
14. [See Also](#see-also)
15. [Sources](#sources)

---

## When to Use

Load this file when the user asks about:

- Creating or modifying scalar UDFs, inline TVFs, or multi-statement TVFs
- Whether a UDF will be inlined by the optimizer (2019+)
- Performance of user-defined functions in queries
- Determinism rules for functions used in computed columns or indexes
- Choosing between a function, stored procedure, or view
- `RETURNS TABLE`, `RETURNS @t TABLE`, `RETURNS scalar_type`
- System function behavior: `GETDATE()`, `SYSDATETIME()`, `NEWID()`, `@@IDENTITY`, `SCOPE_IDENTITY()`, `IDENT_CURRENT()`

**Decision guide: Function vs. Stored Procedure vs. View**

| Need | Use |
|---|---|
| Return a scalar value to use inline in a query | Scalar UDF (or computed column) |
| Return a result set you can JOIN to | Inline TVF (strongly preferred) |
| Return a result set after procedural logic | Multi-statement TVF (with caution) |
| Execute side effects (INSERT/UPDATE/DELETE) | Stored procedure — functions cannot have side effects[^1] |
| Reuse a filtered/joined SELECT | View |
| Parameterized view (filter changes per call) | Inline TVF |

---

## Function Types Overview

```
User-Defined Functions (UDFs)
├── Scalar          -- Returns a single value; can be used anywhere an expression fits
│   ├── May be inlined by optimizer (2019+, with restrictions)
│   └── If not inlined: row-by-row execution, no stats, black box to optimizer
├── Inline TVF      -- Returns TABLE; single SELECT; full optimizer visibility
│   └── Think of it as a parameterized view
└── Multi-statement TVF (mTVF)
    ├── Returns @table_variable TABLE
    ├── Populated via procedural logic (IF, WHILE, multi-step)
    └── Optimizer sees fixed cardinality estimate (1 row pre-2017; interleaved 2017+)
```

---

## Scalar User-Defined Functions

### Basic syntax

```sql
CREATE OR ALTER FUNCTION dbo.fn_TaxAmount
(
    @amount    DECIMAL(18, 2),
    @tax_rate  DECIMAL(5, 4)  -- e.g. 0.0875 for 8.75%
)
RETURNS DECIMAL(18, 2)
WITH SCHEMABINDING         -- recommended; enables determinism if function is deterministic
AS
BEGIN
    RETURN @amount * @tax_rate;
END;
GO

-- Usage
SELECT
    order_id,
    subtotal,
    dbo.fn_TaxAmount(subtotal, 0.0875) AS tax
FROM dbo.Orders;
```

> [!WARNING]
> `CREATE OR ALTER` requires SQL Server 2016+. Use `DROP FUNCTION IF EXISTS` + `CREATE` on earlier versions.

### Calling conventions

```sql
-- Scalar UDF in SELECT list
SELECT dbo.fn_TaxAmount(100.00, 0.10);          -- must qualify with schema name

-- Scalar UDF in WHERE clause (kills sargability if applied to an indexed column)
SELECT * FROM dbo.Orders WHERE dbo.fn_TaxAmount(subtotal, 0.10) > 5.00;
-- Better: compute the threshold, filter on raw column
SELECT * FROM dbo.Orders WHERE subtotal > 5.00 / 0.10;

-- Scalar UDF as computed column default
ALTER TABLE dbo.Orders
    ADD tax_amount AS dbo.fn_TaxAmount(subtotal, 0.0875);
-- Persisted computed column (requires DETERMINISTIC + PRECISE)
ALTER TABLE dbo.Orders
    ADD tax_amount AS dbo.fn_TaxAmount(subtotal, 0.0875) PERSISTED;
```

### Output parameters: not supported in scalar UDFs

Scalar UDFs return one value only. For multiple outputs, use an inline TVF and SELECT one row, or use a stored procedure with OUTPUT params.

---

## Scalar UDF Inlining (2019+)

> [!NOTE] SQL Server 2019
> Scalar UDF Inlining (part of Intelligent Query Processing) automatically converts eligible scalar UDFs into equivalent relational expressions (sub-queries or CTEs), allowing the optimizer to push predicates, estimate cardinality, and build parallel plans. No code changes required.[^2]

### Requirements for inlining eligibility

All of the following must hold:

| Requirement | Detail |
|---|---|
| Database compatibility level | **≥ 150** (SQL Server 2019) |
| No `EXECUTE AS` clause | `WITH EXECUTE AS` disables inlining |
| No `RETURNS NULL ON NULL INPUT` | That option disables inlining |
| Single RETURN statement | Multiple RETURN paths (IF...RETURN, RETURN in loops) prevent inlining |
| No external access | No `EXTERNAL_ACCESS` or `UNSAFE` permission set |
| No table variables (read) | Reading from a table variable inside the UDF disables inlining |
| No recursive calls | Recursive scalar UDFs are not inlined |
| No side-effecting operators | `PRINT`, `RAND()` with no seed, `NEWID()` disqualify |
| No `TRY/CATCH` | TRY/CATCH blocks prevent inlining |

### Verify inlining status

```sql
-- Check if a function is marked as inlineable
SELECT
    o.name,
    m.is_inlineable,
    m.inline_type
FROM sys.sql_modules m
JOIN sys.objects o ON o.object_id = m.object_id
WHERE o.type = 'FN'
  AND o.name = 'fn_TaxAmount';
```

> `is_inlineable = 1` means the function is eligible. Confirm inlining actually happened by checking the execution plan — an inlined function will NOT show a "User Defined Function" operator.

### Opt out of inlining per-function

```sql
CREATE OR ALTER FUNCTION dbo.fn_NoInline (@x INT)
RETURNS INT
WITH INLINE = OFF          -- explicit opt-out
AS
BEGIN
    RETURN @x * 2;
END;
```

### Opt out per-query

```sql
SELECT dbo.fn_TaxAmount(subtotal, 0.10) FROM dbo.Orders
OPTION (USE HINT('DISABLE_TSQL_SCALAR_UDF_INLINING'));
```

---

## Inline Table-Valued Functions

An inline TVF is a parameterized view — one `SELECT` statement in the body, no `BEGIN/END`. The optimizer expands it inline into the calling query exactly like a view, with full access to statistics and row estimates.

```sql
CREATE OR ALTER FUNCTION dbo.fn_OrdersByCustomer
(
    @customer_id INT,
    @start_date  DATE,
    @end_date    DATE
)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
(
    SELECT
        o.order_id,
        o.order_date,
        o.total_amount,
        c.customer_name
    FROM dbo.Orders o
    JOIN dbo.Customers c ON c.customer_id = o.customer_id
    WHERE o.customer_id  = @customer_id
      AND o.order_date  >= @start_date
      AND o.order_date  <  DATEADD(DAY, 1, @end_date)
);
GO

-- Usage
SELECT * FROM dbo.fn_OrdersByCustomer(42, '2024-01-01', '2024-12-31');

-- CROSS APPLY pattern (lateral join — one call per outer row)
SELECT
    c.customer_id,
    c.customer_name,
    recent.order_id,
    recent.total_amount
FROM dbo.Customers c
CROSS APPLY dbo.fn_OrdersByCustomer(c.customer_id, '2024-01-01', '2024-12-31') AS recent;
```

**Key properties:**
- No `BEGIN/END`, no `RETURN @table`
- Body is a single `RETURN (SELECT ...)` — but that SELECT can be arbitrarily complex: CTEs, subqueries, UNION, etc.
- Optimizer sees through it completely — indexes on the underlying tables are used normally
- Supports `SCHEMABINDING`
- Can be used with `CROSS APPLY` / `OUTER APPLY`
- **This is almost always what you want** when you need a parameterized query returning rows

---

## Multi-Statement Table-Valued Functions

An mTVF declares a return table variable, populates it with procedural logic, and returns it. Use sparingly — optimizer limitations are severe without interleaved execution.

```sql
CREATE OR ALTER FUNCTION dbo.fn_CustomerSummary
(
    @min_orders INT
)
RETURNS @result TABLE
(
    customer_id    INT          NOT NULL,
    customer_name  NVARCHAR(100) NOT NULL,
    order_count    INT          NOT NULL,
    total_spent    DECIMAL(18, 2) NOT NULL,
    PRIMARY KEY (customer_id)
)
AS
BEGIN
    INSERT INTO @result (customer_id, customer_name, order_count, total_spent)
    SELECT
        c.customer_id,
        c.customer_name,
        COUNT(o.order_id),
        SUM(o.total_amount)
    FROM dbo.Customers c
    JOIN dbo.Orders o ON o.customer_id = c.customer_id
    GROUP BY c.customer_id, c.customer_name
    HAVING COUNT(o.order_id) >= @min_orders;

    -- Post-processing step that would be hard in a single SELECT
    UPDATE @result
    SET order_count = order_count + 1    -- hypothetical adjustment
    WHERE total_spent > 10000;

    RETURN;
END;
GO

-- Usage
SELECT * FROM dbo.fn_CustomerSummary(5);
```

### Interleaved Execution for mTVFs (2017+)

> [!NOTE] SQL Server 2017
> With database compatibility level ≥ 140, the optimizer uses **interleaved execution** for mTVFs: it actually executes the function at compile time to get the real cardinality, then compiles the rest of the plan with that information. This eliminates the "1 row estimate" problem for mTVFs that were a major source of bad plans.[^3]

```sql
-- Verify interleaved execution was used:
-- Look for "IsInterleavedExecuted=1" attribute on the TVF operator in an actual XML plan.
```

---

## iTVF vs mTVF Performance

| Property | Inline TVF | Multi-statement TVF |
|---|---|---|
| Body structure | Single SELECT | Procedural (multi-step) |
| Optimizer visibility | Full (expanded inline) | Black box (returns table variable) |
| Cardinality estimate (pre-2017) | Accurate from stats | Fixed at 1 row |
| Cardinality estimate (2017+, compat 140+) | Accurate | Interleaved execution (actual rows) |
| Parallel plans | Yes | No (table variable prohibits parallelism in many cases) |
| Can use indexes on return table | N/A (no materialization) | Yes (declare PK/indexes on @result) |
| `SCHEMABINDING` | Yes | Yes |
| Supports DML inside body | No | Yes (INSERT/UPDATE/DELETE against @result only) |
| Best for | Parameterized views, CROSS APPLY patterns | Multi-step ETL transforms, when procedural logic is genuinely needed |

**Rule of thumb:** Default to inline TVF. Use mTVF only when procedural logic is genuinely required, and confirm interleaved execution is active (compat ≥ 140).

---

## Determinism and SCHEMABINDING

### Determinism rules

A function is **deterministic** if it always returns the same result given the same inputs and the same database state. Determinism matters for:

- **Persisted computed columns** — must be deterministic AND precise
- **Indexed computed columns** — same requirement
- **Partition functions** — bound columns must be deterministic

| Condition | Result |
|---|---|
| References non-deterministic system functions (`GETDATE`, `RAND`, `NEWID`, `NEWSEQUENTIALID`) | Non-deterministic |
| Accesses any table | Non-deterministic by default (even with same inputs, table could change) |
| Pure computation on input params, no table access, no non-deterministic functions | Deterministic |
| `WITH SCHEMABINDING` + pure computation | Deterministic AND optimizer can verify it |

```sql
-- Check determinism of a function
SELECT
    o.name,
    m.is_deterministic,
    m.uses_database_collation,
    m.is_inlineable
FROM sys.sql_modules m
JOIN sys.objects o ON o.object_id = m.object_id
WHERE o.type IN ('FN', 'IF', 'TF')
  AND o.name = 'fn_TaxAmount';
```

### SCHEMABINDING for functions

`WITH SCHEMABINDING` prevents the underlying tables/views from being modified in incompatible ways while the function depends on them. It also:

- Enables the optimizer to verify determinism (required for persisted computed columns)
- Enables indexed views that reference the function

```sql
CREATE OR ALTER FUNCTION dbo.fn_FullName
(
    @first NVARCHAR(50),
    @last  NVARCHAR(50)
)
RETURNS NVARCHAR(101)
WITH SCHEMABINDING   -- pure computation, no table access → deterministic
AS
BEGIN
    RETURN LTRIM(RTRIM(@first)) + N' ' + LTRIM(RTRIM(@last));
END;
GO
```

> [!WARNING]
> A function with `SCHEMABINDING` that references tables will block `DROP TABLE`, `ALTER TABLE` (adding/removing referenced columns), and `DROP COLUMN` on those tables until the function is dropped or altered.

---

## Aggregate Functions (CLR)

T-SQL does not natively support user-defined aggregate functions (UDAFs) outside of CLR. For most needs, use `STRING_AGG` (2017+), `XMLAGG`-style patterns, or window functions.

```sql
-- Built-in: STRING_AGG as replacement for STUFF+FOR XML PATH
SELECT
    customer_id,
    STRING_AGG(product_name, ', ') WITHIN GROUP (ORDER BY product_name) AS products
FROM dbo.OrderItems
GROUP BY customer_id;
```

> [!NOTE] SQL Server 2017
> `STRING_AGG` eliminates the need for the legacy `STUFF(...FOR XML PATH(''))` aggregation hack for most use cases. `STRING_AGG` respects `NULL` values by ignoring them (consistent with other aggregates).

CLR UDAFs are available but introduce maintenance burden; cover them only if the user specifically asks.

---

## System Function Reference

### Identity and sequence functions

```sql
-- @@IDENTITY      : Last identity value inserted in current session, ANY table
-- SCOPE_IDENTITY(): Last identity value in current scope (proc/trigger/function)
-- IDENT_CURRENT('table'): Last identity value inserted into named table by ANY session

-- Safe pattern: always use SCOPE_IDENTITY()
INSERT INTO dbo.Orders (customer_id, order_date) VALUES (1, GETDATE());
DECLARE @new_id INT = SCOPE_IDENTITY();

-- @@IDENTITY gotcha: fires AFTER a trigger that also inserts into a table with IDENTITY
-- → @@IDENTITY returns the trigger's identity, not the base table's
-- → SCOPE_IDENTITY() returns the base table's identity (correct)
```

> [!WARNING]
> Never use `@@IDENTITY` in production code. It is scope-unaware and trigger-unaware. Use `SCOPE_IDENTITY()` for the current scope, or `OUTPUT INSERTED.id` for bulk operations.

### Date/time functions

| Function | Precision | Timezone aware | Notes |
|---|---|---|---|
| `GETDATE()` | datetime (3.33ms) | No | Legacy; avoid for new code |
| `GETUTCDATE()` | datetime | UTC only | Legacy |
| `SYSDATETIME()` | datetime2(7) (100ns) | No | Preferred for high precision |
| `SYSDATETIMEOFFSET()` | datetimeoffset(7) | Yes | Includes offset |
| `SYSUTCDATETIME()` | datetime2(7) | UTC only | Preferred for UTC storage |
| `CURRENT_TIMESTAMP` | datetime | No | ANSI SQL; equivalent to `GETDATE()` |

```sql
-- AT TIME ZONE (2016+): convert datetime to datetimeoffset
SELECT SYSDATETIME() AT TIME ZONE 'Eastern Standard Time';
-- Convert between zones
SELECT SYSDATETIMEOFFSET() AT TIME ZONE 'UTC' AT TIME ZONE 'Pacific Standard Time';
```

> [!NOTE] SQL Server 2016
> `AT TIME ZONE` uses the Windows time zone database. On Linux, the `tzdata` package must be installed and `mssql-conf set time zone` must be set correctly.

### NULL-related functions

```sql
ISNULL(@val, default_val)        -- SQL Server-specific; returns same type as first arg
COALESCE(@a, @b, @c)             -- ANSI SQL; returns first non-NULL; type determined by highest precedence
NULLIF(@a, @b)                   -- returns NULL if @a = @b, else @a

-- ISNULL vs COALESCE type precedence trap:
DECLARE @x VARCHAR(3) = 'abc';
SELECT ISNULL(@x, 'default')     -- returns VARCHAR(3) → 'abc' (fits)
SELECT COALESCE(@x, 'default')   -- returns VARCHAR(7) due to type resolution
-- This matters when feeding result into a typed column or function
```

### Math functions

```sql
ABS(-5)                          -- 5
CEILING(4.1)                     -- 5
FLOOR(4.9)                       -- 4
ROUND(4.567, 2)                  -- 4.570
ROUND(4.567, 2, 1)               -- 4.560  (third arg=1: truncate, not round)
POWER(2, 10)                     -- 1024.0 (returns FLOAT unless base is INT)
SQRT(16.0)                       -- 4.0
LOG(100, 10)                     -- 2.0 (log base 10)
LOG(EXP(1))                      -- 1.0 (natural log)
PI()                             -- 3.14159265358979
SIGN(-7)                         -- -1
RAND()                           -- non-deterministic float [0,1)
RAND(42)                         -- seeded (but RAND(seed) only reseeds once per query)
```

### String functions

```sql
LEN('hello ')                    -- 5 (ignores trailing spaces)
DATALENGTH(N'hello ')            -- 12 (bytes; nvarchar uses 2 bytes/char + trailing space)
CHARINDEX('lo', 'hello')         -- 4 (1-based)
PATINDEX('%[0-9]%', 'abc3def')   -- 4
SUBSTRING('hello', 2, 3)         -- 'ell'
LEFT('hello', 3)                 -- 'hel'
RIGHT('hello', 3)                -- 'llo'
LTRIM('  hi ')                   -- 'hi '
RTRIM('  hi ')                   -- '  hi'
TRIM('  hi  ')                   -- 'hi'  (2017+; also trims specific chars: TRIM('x' FROM 'xhix'))
UPPER('hello')                   -- 'HELLO'
LOWER('HELLO')                   -- 'hello'
REPLACE('abcabc', 'a', 'X')      -- 'XbcXbc'
STUFF('hello', 2, 3, 'XY')       -- 'hXYo'  (delete 3 chars at pos 2, insert 'XY')
CONCAT('a', NULL, 'b')           -- 'ab'  (NULL-safe concatenation)
CONCAT_WS(', ', 'a', NULL, 'b')  -- 'a, b'  (2017+; skips NULLs)
FORMAT(1234567.89, 'N2', 'en-US')-- '1,234,567.89'  (culture-aware; CLR-backed, slow)
STRING_SPLIT('a,b,c', ',')       -- rowset: value column ('a','b','c')
```

> [!NOTE] SQL Server 2022
> `STRING_SPLIT` gains an `enable_ordinal` parameter (third argument = 1) to return an `ordinal` column reflecting position. In 2017–2019 the order of rows from `STRING_SPLIT` is not guaranteed.[^4]

```sql
-- 2022+: ordinal column
SELECT value, ordinal
FROM STRING_SPLIT('a,b,c', ',', 1)
ORDER BY ordinal;
```

### Conversion functions

```sql
CAST('2024-01-15' AS DATE)
CONVERT(VARCHAR(10), GETDATE(), 120)    -- ISO 8601: '2024-01-15'
TRY_CAST('abc' AS INT)                  -- returns NULL on failure (safe)
TRY_CONVERT(INT, 'abc')                 -- returns NULL on failure (safe)
TRY_PARSE('January 15 2024' AS DATE USING 'en-US')  -- culture-aware parse

-- PARSE is CLR-backed and slower than CONVERT; use only when culture parsing is needed
```

> [!WARNING]
> Never use implicit conversion between `VARCHAR` and `NVARCHAR` in JOINs or WHERE clauses. An implicit convert on an indexed column prevents index seeks. Always cast explicitly, and prefer storing data in the correct type to avoid the conversion entirely.

---

## Window Functions in Functions

Inline TVFs can use window functions freely. Scalar UDFs cannot directly use window functions (window functions require a rowset context). This is a common reason developers reach for mTVFs when an iTVF would work.

```sql
-- Correct: window function inside an inline TVF
CREATE OR ALTER FUNCTION dbo.fn_RankedOrders (@customer_id INT)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
(
    SELECT
        order_id,
        order_date,
        total_amount,
        ROW_NUMBER() OVER (ORDER BY order_date DESC) AS rn
    FROM dbo.Orders
    WHERE customer_id = @customer_id
);
GO

-- Get the most recent order per customer using CROSS APPLY
SELECT c.customer_id, c.customer_name, r.order_id, r.total_amount
FROM dbo.Customers c
CROSS APPLY (
    SELECT TOP (1) order_id, total_amount
    FROM dbo.fn_RankedOrders(c.customer_id)
    ORDER BY rn
) r;
```

---

## Dropping and Altering Functions

```sql
-- Drop if exists (2016+)
DROP FUNCTION IF EXISTS dbo.fn_TaxAmount;

-- Create or alter (2016+; preferred over DROP + CREATE)
CREATE OR ALTER FUNCTION dbo.fn_TaxAmount (...) ...

-- Pre-2016: drop and recreate pattern
IF OBJECT_ID(N'dbo.fn_TaxAmount', N'FN') IS NOT NULL
    DROP FUNCTION dbo.fn_TaxAmount;
GO
CREATE FUNCTION dbo.fn_TaxAmount ...
GO

-- List all functions in a database
SELECT
    o.name,
    o.type_desc,        -- SQL_SCALAR_FUNCTION, SQL_INLINE_TABLE_VALUED_FUNCTION, SQL_TABLE_VALUED_FUNCTION
    o.create_date,
    o.modify_date,
    m.is_deterministic,
    m.is_inlineable
FROM sys.objects o
JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE o.type IN ('FN', 'IF', 'TF')
ORDER BY o.name;

-- View function definition
SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.fn_TaxAmount'));
-- or
EXEC sp_helptext 'dbo.fn_TaxAmount';
```

---

## Gotchas / Anti-patterns

### 1. Scalar UDFs in WHERE clauses on large tables (pre-2019 or non-inlineable)

The optimizer cannot push a non-inlineable scalar UDF into an index seek. It executes row-by-row after the scan.

```sql
-- Bad: 10M row table scan, UDF called 10M times
SELECT * FROM dbo.BigTable WHERE dbo.fn_SlowUDF(col) = 1;

-- Fix option 1: Inline the logic
SELECT * FROM dbo.BigTable WHERE (col * 0.0875) > 5.00;

-- Fix option 2: Persisted computed column + index
ALTER TABLE dbo.BigTable ADD computed_val AS dbo.fn_DetUDF(col) PERSISTED;
CREATE INDEX IX_BigTable_computed ON dbo.BigTable (computed_val);
```

### 2. Non-deterministic functions preventing persisted computed columns

```sql
-- Will fail: GETDATE() is non-deterministic
ALTER TABLE dbo.T ADD created_at AS GETDATE() PERSISTED;
-- Error: Computed column 'created_at' in table 'T' cannot be persisted because the column is non-deterministic.

-- Fix: Use a DEFAULT constraint instead
ALTER TABLE dbo.T ADD created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME();
```

### 3. Multi-statement TVF blocking parallelism

An mTVF returns a table variable, and table variables historically forced serial plans. Even with interleaved execution (2017+), the outer query containing an mTVF may not parallelize.

```sql
-- If parallelism is critical, convert to inline TVF or materialize into a temp table
-- and then join/apply against the temp table inside a stored procedure.
```

### 4. SCHEMABINDING on functions that call other functions

If `fn_A` calls `fn_B`, and both have `SCHEMABINDING`, dropping or altering `fn_B` will fail because `fn_A` depends on it. Plan your drop/alter order carefully.

```sql
-- Check dependencies before altering
SELECT
    OBJECT_NAME(referencing_id) AS depends_on_this,
    OBJECT_NAME(referenced_id)  AS function_to_change
FROM sys.sql_expression_dependencies
WHERE referenced_id = OBJECT_ID('dbo.fn_B');
```

### 5. @@IDENTITY vs SCOPE_IDENTITY() vs OUTPUT

See [System Function Reference — Identity](#system-function-reference) above. Never use `@@IDENTITY`. For sets of rows, use `OUTPUT INSERTED.id INTO @ids` instead of `SCOPE_IDENTITY()`.

### 6. FORMAT() is slow — avoid in high-volume queries

`FORMAT()` is CLR-backed. For high-volume formatting use `CONVERT` with a style code instead:

```sql
-- Slow:
SELECT FORMAT(GETDATE(), 'yyyy-MM-dd')
-- Fast:
SELECT CONVERT(VARCHAR(10), GETDATE(), 120)
```

### 7. Scalar UDF in GROUP BY or ORDER BY

Non-inlineable scalar UDFs in GROUP BY force a serial, row-by-row evaluation before grouping, with no index utilization. Move the computation to a CTE or subquery where possible.

### 8. Function names with schema omitted

Always qualify UDF calls with the schema: `dbo.fn_Name(...)`. An unqualified call causes a recompile every time because SQL Server must resolve the schema at runtime.

### 9. Nesting depth

Functions count toward SQL Server's nesting depth limit of 32 levels (same as stored procedures). Deeply nested function calls can hit this limit. Check `@@NESTLEVEL` inside a function if debugging.

### 10. Error handling inside functions

Functions cannot contain `TRY/CATCH` blocks or `RAISERROR`/`THROW`. If the function errors, it raises the error to the calling batch. Handle errors in the calling stored procedure.

---

## See Also

- [`04-ctes.md`](04-ctes.md) — CTEs vs inline TVFs for complex queries
- [`05-views.md`](05-views.md) — Indexed views and SCHEMABINDING (same determinism rules)
- [`06-stored-procedures.md`](06-stored-procedures.md) — When to use a proc instead of a function
- [`31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — Full IQP feature matrix including scalar UDF inlining and interleaved execution
- [`28-statistics.md`](28-statistics.md) — Why cardinality estimates matter for mTVF performance
- [`29-query-plans.md`](29-query-plans.md) — How to read plans to identify non-inlined UDFs and mTVF estimates

---

## Sources

[^1]: [CREATE FUNCTION (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-function-transact-sql) — covers function syntax, side-effect restrictions (DML against base tables is prohibited; only local table variable modifications are allowed), and determinism/SCHEMABINDING rules
[^2]: [Intelligent Query Processing Details - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — covers scalar UDF inlining introduced in SQL Server 2019 (compatibility level 150), eligibility requirements, and how the optimizer transforms eligible UDFs into relational expressions
[^3]: [Intelligent Query Processing Details - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — covers interleaved execution for multi-statement TVFs introduced in SQL Server 2017 (compatibility level 140), including how the optimizer materializes the MSTVF at compile time to obtain accurate cardinality estimates
[^4]: [STRING_SPLIT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/string-split-transact-sql) — covers the `enable_ordinal` third argument (value of 1 enables the `ordinal` output column) available in SQL Server 2022 and Azure SQL Database

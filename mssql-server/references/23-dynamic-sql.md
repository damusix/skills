# 23 — Dynamic SQL

> Load this file when the user asks about dynamic SQL, sp_executesql, building queries at runtime,
> SQL injection prevention, dynamic WHERE clauses, dynamic ORDER BY, dynamic PIVOT, or debugging
> dynamically generated T-SQL.

---

## Table of Contents

1. [When to Use Dynamic SQL](#1-when-to-use-dynamic-sql)
2. [sp_executesql vs EXEC](#2-sp_executesql-vs-exec)
3. [Parameterization](#3-parameterization)
4. [SQL Injection Prevention](#4-sql-injection-prevention)
5. [Dynamic WHERE Clauses](#5-dynamic-where-clauses)
6. [Dynamic ORDER BY](#6-dynamic-order-by)
7. [Dynamic Column Lists](#7-dynamic-column-lists)
8. [Dynamic PIVOT](#8-dynamic-pivot)
9. [Dynamic DDL](#9-dynamic-ddl)
10. [Scope and Variable Visibility](#10-scope-and-variable-visibility)
11. [Plan Caching Behavior](#11-plan-caching-behavior)
12. [Debugging Tips](#12-debugging-tips)
13. [Security Context](#13-security-context)
14. [Dynamic SQL in Stored Procedures](#14-dynamic-sql-in-stored-procedures)
15. [Output Parameters](#15-output-parameters)
16. [Metadata Queries (Dynamic)](#16-metadata-queries-dynamic)
17. [Gotchas / Anti-patterns](#17-gotchas--anti-patterns)
18. [See Also](#18-see-also)
19. [Sources](#sources)

---

## 1. When to Use Dynamic SQL

Dynamic SQL is appropriate when **the structure of the query itself** must vary at runtime — when parameterization alone cannot express the variation.

**Legitimate use cases:**

| Use Case | Example |
|---|---|
| Dynamic column list | PIVOT with runtime column set |
| Dynamic table/schema name | Sharded tables, multi-tenant schemas |
| Dynamic ORDER BY | User-selectable sort column |
| Optional filter predicates | "Search everything" UI with optional fields |
| Dynamic DDL | Schema migration scripts, partition management |
| Dynamic index/statistics maintenance | Ola Hallengren-style maintenance scripts |
| Cross-database queries with variable db name | Reporting across tenant databases |

**Do NOT use dynamic SQL when:**
- You just want to avoid writing out all the JOIN branches — use static SQL with CASE expressions or EXISTS subqueries
- The variation is in a value, not structure — parameterize it instead
- You're in a natively compiled proc — dynamic SQL is not supported there
- You need a predictable, cacheable execution plan for a hot path

---

## 2. sp_executesql vs EXEC

**Always prefer `sp_executesql` over `EXEC(@sql)`** for any dynamic SQL that takes parameters.

```sql
-- BAD: plan is not reusable, injection risk
DECLARE @sql NVARCHAR(MAX);
SET @sql = 'SELECT * FROM Orders WHERE CustomerID = ' + CAST(@custId AS NVARCHAR(10));
EXEC(@sql);

-- GOOD: parameterized, plan-cacheable, injection-safe
DECLARE @sql NVARCHAR(MAX);
DECLARE @params NVARCHAR(MAX);

SET @sql = N'SELECT * FROM Orders WHERE CustomerID = @CustId';
SET @params = N'@CustId INT';

EXEC sp_executesql @sql, @params, @CustId = @custId;
```

### sp_executesql signature

```sql
sp_executesql
    @stmt       NVARCHAR(MAX),           -- the SQL batch (must be NVARCHAR)
    @params     NVARCHAR(MAX),           -- comma-separated parameter declarations
    [ @param1 = value1, ... ]            -- actual parameter values
```

- `@stmt` and `@params` must be `NVARCHAR`, not `VARCHAR` — Unicode is required
- Parameters in `@params` use the same declaration syntax as stored procedure parameters
- Parameter names in `@stmt` must match parameter names in `@params` (case-insensitive)

### EXEC(@sql) is acceptable only for:
- DDL statements (CREATE TABLE, DROP INDEX) — these cannot be parameterized anyway
- Dynamic SQL where no user input is incorporated
- One-off ad hoc scripts where plan reuse doesn't matter

---

## 3. Parameterization

Think of `sp_executesql` parameters as stored procedure parameters — they are type-safe and injection-safe.

```sql
-- Multi-parameter example
DECLARE @sql    NVARCHAR(MAX);
DECLARE @params NVARCHAR(MAX);
DECLARE @StartDate DATE    = '2024-01-01';
DECLARE @EndDate   DATE    = '2024-12-31';
DECLARE @Status    TINYINT = 1;

SET @sql = N'
    SELECT OrderID, CustomerID, OrderDate, TotalAmount
    FROM   dbo.Orders
    WHERE  OrderDate BETWEEN @StartDate AND @EndDate
      AND  StatusID  = @Status
    ORDER BY OrderDate DESC;
';

SET @params = N'@StartDate DATE, @EndDate DATE, @Status TINYINT';

EXEC sp_executesql @sql, @params,
    @StartDate = @StartDate,
    @EndDate   = @EndDate,
    @Status    = @Status;
```

**What parameterization prevents:**
- SQL injection via string values
- Type coercion errors
- Plan pollution (same statement shape reuses plan)

**What parameterization cannot do:**
- Substitute object names (table, column, schema, index names)
- Control SQL keywords (ASC/DESC, JOIN type)
- Provide a dynamic IN list — use a table-valued parameter or STRING_SPLIT instead

---

## 4. SQL Injection Prevention

### The golden rule

**Never concatenate user-supplied input directly into SQL strings.** Always either parameterize it or validate it against a whitelist.

### Injection via string values → use parameters

```sql
-- VULNERABLE: user controls @Name
SET @sql = N'SELECT * FROM Users WHERE Name = ''' + @Name + '''';

-- SAFE: @Name is a parameter
SET @sql = N'SELECT * FROM Users WHERE Name = @Name';
EXEC sp_executesql @sql, N'@Name NVARCHAR(100)', @Name = @Name;
```

### Injection via object names → use QUOTENAME()

When the dynamic part is a schema, table, column, or index name, use `QUOTENAME()` to bracket it safely:

```sql
DECLARE @TableName  NVARCHAR(128) = 'Orders';
DECLARE @SchemaName NVARCHAR(128) = 'dbo';
DECLARE @sql        NVARCHAR(MAX);

-- QUOTENAME wraps in [] and escapes embedded ] characters
SET @sql = N'SELECT COUNT(*) FROM '
         + QUOTENAME(@SchemaName)
         + N'.'
         + QUOTENAME(@TableName);

EXEC sp_executesql @sql;
```

`QUOTENAME` protects against names like `Orders; DROP TABLE Users--` by escaping them as `[Orders; DROP TABLE Users--]`, which SQL Server then treats as a (probably invalid) identifier rather than executable SQL.

> [!WARNING] QUOTENAME truncates at 128 characters
> `QUOTENAME(@name)` returns NULL if `@name` exceeds 128 characters. Always validate length before calling it:
> ```sql
> IF LEN(@TableName) > 128
>     THROW 50001, 'Table name too long.', 1;
> ```

### Injection via keywords → use a whitelist

Keywords like column names for ORDER BY cannot be parameterized or QUOTENAME'd effectively. Use an explicit whitelist:

```sql
DECLARE @SortCol NVARCHAR(50) = 'OrderDate';  -- user input

-- Whitelist validation
SET @SortCol = CASE @SortCol
    WHEN 'OrderDate'   THEN 'OrderDate'
    WHEN 'TotalAmount' THEN 'TotalAmount'
    WHEN 'CustomerID'  THEN 'CustomerID'
    ELSE 'OrderDate'   -- safe default
END;

SET @sql = N'SELECT * FROM dbo.Orders ORDER BY ' + QUOTENAME(@SortCol);
EXEC sp_executesql @sql;
```

Never skip the whitelist for ORDER BY — a user could inject `(SELECT TOP 1 password FROM Users)`.

### Injection via numeric values

Even numeric parameters can be attacked if you concatenate instead of parameterize:

```sql
-- VULNERABLE: '1 OR 1=1' passes an INT cast but '1; DROP TABLE Users--' causes chaos
SET @sql = 'SELECT * FROM Orders WHERE ID = ' + CAST(@id AS VARCHAR);

-- SAFE: parameter is typed INT — SQL Server enforces the type
SET @sql = N'SELECT * FROM Orders WHERE ID = @id';
EXEC sp_executesql @sql, N'@id INT', @id = @id;
```

---

## 5. Dynamic WHERE Clauses

The most common dynamic SQL use case: building a WHERE clause where some filters are optional.

### Pattern: build only the conditions needed

```sql
CREATE OR ALTER PROCEDURE dbo.SearchOrders
    @CustomerID  INT           = NULL,
    @StartDate   DATE          = NULL,
    @EndDate     DATE          = NULL,
    @StatusID    TINYINT       = NULL,
    @MinAmount   DECIMAL(18,2) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @sql    NVARCHAR(MAX) = N'
        SELECT OrderID, CustomerID, OrderDate, TotalAmount, StatusID
        FROM   dbo.Orders
        WHERE  1 = 1
    ';
    DECLARE @params NVARCHAR(MAX) = N'
        @CustomerID  INT,
        @StartDate   DATE,
        @EndDate     DATE,
        @StatusID    TINYINT,
        @MinAmount   DECIMAL(18,2)
    ';

    IF @CustomerID IS NOT NULL
        SET @sql += N' AND CustomerID = @CustomerID';

    IF @StartDate IS NOT NULL
        SET @sql += N' AND OrderDate >= @StartDate';

    IF @EndDate IS NOT NULL
        SET @sql += N' AND OrderDate < DATEADD(DAY, 1, @EndDate)';

    IF @StatusID IS NOT NULL
        SET @sql += N' AND StatusID = @StatusID';

    IF @MinAmount IS NOT NULL
        SET @sql += N' AND TotalAmount >= @MinAmount';

    SET @sql += N' ORDER BY OrderDate DESC;';

    EXEC sp_executesql @sql, @params,
        @CustomerID = @CustomerID,
        @StartDate  = @StartDate,
        @EndDate    = @EndDate,
        @StatusID   = @StatusID,
        @MinAmount  = @MinAmount;
END;
```

**Why `WHERE 1 = 1`?** It gives a safe anchor so all subsequent conditions can start with `AND`, avoiding the need to track whether a `WHERE` keyword has been added. SQL Server optimizes it away — it adds zero cost.

### Anti-pattern: catch-all query (avoid for performance)

```sql
-- AVOID: this is a "catch-all" query — the optimizer cannot build a good plan
SELECT * FROM dbo.Orders
WHERE  (@CustomerID IS NULL OR CustomerID = @CustomerID)
  AND  (@StartDate  IS NULL OR OrderDate >= @StartDate);
```

The catch-all pattern produces a single cached plan that works for all parameter combinations but usually scans the table. The dynamic SQL approach produces multiple plans (one per combination of active filters), each of which can use the optimal index.

> [!NOTE] SQL Server 2022
> Parameter-Sensitive Plan Optimization (PSPO) can mitigate catch-all query performance for some simple cases, but the dynamic SQL approach remains more reliable for complex multi-filter procedures. See `references/30-query-store.md`.

### Dynamic IN list

You cannot parameterize a variable-length IN list. Options:

```sql
-- Option 1: STRING_SPLIT (2016+, ordinal 2022+)
DECLARE @ids NVARCHAR(MAX) = '1,2,3,4,5';

SET @sql = N'
    SELECT o.*
    FROM   dbo.Orders o
    JOIN   STRING_SPLIT(@ids, '','') s ON o.CustomerID = TRY_CAST(s.value AS INT)
';
EXEC sp_executesql @sql, N'@ids NVARCHAR(MAX)', @ids = @ids;

-- Option 2: Table-valued parameter (requires CREATE TYPE)
-- See references/11-custom-data-types.md for TVP setup

-- Option 3: Temp table (load it before the dynamic query)
INSERT INTO #FilterIDs (ID) VALUES (1),(2),(3),(4),(5);
SET @sql = N'SELECT o.* FROM dbo.Orders o JOIN #FilterIDs f ON o.CustomerID = f.ID';
EXEC sp_executesql @sql;
-- Temp tables created before EXEC are visible inside the dynamic batch
```

---

## 6. Dynamic ORDER BY

Order direction (ASC/DESC) and column selection cannot be parameterized.

```sql
CREATE OR ALTER PROCEDURE dbo.GetOrders
    @SortColumn    NVARCHAR(50) = 'OrderDate',
    @SortDirection NVARCHAR(4)  = 'DESC',
    @PageNumber    INT          = 1,
    @PageSize      INT          = 20
AS
BEGIN
    SET NOCOUNT ON;

    -- Whitelist column names
    SET @SortColumn = CASE @SortColumn
        WHEN 'OrderDate'   THEN 'OrderDate'
        WHEN 'TotalAmount' THEN 'TotalAmount'
        WHEN 'CustomerID'  THEN 'CustomerID'
        WHEN 'OrderID'     THEN 'OrderID'
        ELSE 'OrderDate'
    END;

    -- Whitelist direction
    SET @SortDirection = CASE UPPER(@SortDirection)
        WHEN 'ASC'  THEN 'ASC'
        WHEN 'DESC' THEN 'DESC'
        ELSE 'DESC'
    END;

    DECLARE @sql    NVARCHAR(MAX);
    DECLARE @params NVARCHAR(MAX) = N'@PageNumber INT, @PageSize INT';
    DECLARE @Offset INT = (@PageNumber - 1) * @PageSize;

    SET @sql = N'
        SELECT OrderID, CustomerID, OrderDate, TotalAmount
        FROM   dbo.Orders
        ORDER BY ' + QUOTENAME(@SortColumn) + N' ' + @SortDirection + N'
        OFFSET @PageNumber * @PageSize - @PageSize ROWS
        FETCH  NEXT @PageSize ROWS ONLY;
    ';

    -- Simpler: compute offset outside
    SET @sql = N'
        SELECT OrderID, CustomerID, OrderDate, TotalAmount
        FROM   dbo.Orders
        ORDER BY ' + QUOTENAME(@SortColumn) + N' ' + @SortDirection + N'
        OFFSET ' + CAST(@Offset AS NVARCHAR(10)) + N' ROWS
        FETCH  NEXT ' + CAST(@PageSize AS NVARCHAR(10)) + N' ROWS ONLY;
    ';

    EXEC sp_executesql @sql;
END;
```

> [!WARNING]
> Do not put OFFSET/FETCH values as concatenated user input without bounds checking. Always cast to INT first and validate the range.

---

## 7. Dynamic Column Lists

Useful for multi-tenant schemas, reporting tools, or sparse column scenarios.

```sql
DECLARE @Columns NVARCHAR(MAX);
DECLARE @sql     NVARCHAR(MAX);

-- Build verified column list from sys.columns (safe — no user input)
SELECT @Columns = STRING_AGG(QUOTENAME(c.name), N', ')
                  WITHIN GROUP (ORDER BY c.column_id)
FROM   sys.columns c
JOIN   sys.tables  t ON t.object_id = c.object_id
WHERE  t.name       = 'Orders'
  AND  t.schema_id  = SCHEMA_ID('dbo')
  AND  c.name      <> 'InternalAuditFlag';  -- exclude sensitive columns

SET @sql = N'SELECT ' + @Columns + N' FROM dbo.Orders;';
EXEC sp_executesql @sql;
```

**Key point:** the column list is sourced from `sys.columns`, not user input, so there is no injection risk. Any user-specified column names must still be validated against this list.

---

## 8. Dynamic PIVOT

PIVOT requires the list of pivot values to be known at compile time. For runtime values, use dynamic SQL.

```sql
-- Pivot monthly sales: columns are determined at runtime
DECLARE @Months  NVARCHAR(MAX);
DECLARE @sql     NVARCHAR(MAX);

-- Build the column list from actual data
SELECT @Months = STRING_AGG(QUOTENAME(MonthLabel), N', ')
                 WITHIN GROUP (ORDER BY MonthStart)
FROM (
    SELECT DISTINCT
        FORMAT(OrderDate, 'yyyy-MM') AS MonthLabel,
        DATEFROMPARTS(YEAR(OrderDate), MONTH(OrderDate), 1) AS MonthStart
    FROM dbo.Orders
    WHERE OrderDate >= DATEADD(YEAR, -1, GETDATE())
) m;

SET @sql = N'
    SELECT CustomerID, ' + @Months + N'
    FROM (
        SELECT CustomerID,
               FORMAT(OrderDate, ''yyyy-MM'') AS MonthLabel,
               TotalAmount
        FROM   dbo.Orders
        WHERE  OrderDate >= DATEADD(YEAR, -1, GETDATE())
    ) src
    PIVOT (
        SUM(TotalAmount)
        FOR MonthLabel IN (' + @Months + N')
    ) pvt
    ORDER BY CustomerID;
';

EXEC sp_executesql @sql;
```

**Pattern notes:**
- Single quotes inside NVARCHAR strings must be doubled: `''''yyyy-MM''''`
- The pivot column list (`@Months`) is derived from `sys.*` or aggregated data, not raw user input
- Always add a NULL-safe check: if `@Months` is NULL (no rows), skip or return an empty result set

---

## 9. Dynamic DDL

DDL operations cannot be parameterized — they must be string-concatenated. Restrict to trusted inputs only.

```sql
-- Dynamic index rebuild (maintenance script pattern)
DECLARE @IndexSQL NVARCHAR(MAX) = N'';

SELECT @IndexSQL += N'
    ALTER INDEX ' + QUOTENAME(i.name) + N'
    ON ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name) + N'
    REBUILD WITH (ONLINE = ON, MAXDOP = 4);
'
FROM sys.indexes i
JOIN sys.tables  t ON t.object_id = i.object_id
JOIN sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
    ON  ips.object_id = i.object_id
    AND ips.index_id  = i.index_id
WHERE ips.avg_fragmentation_in_percent > 30
  AND i.index_id > 0
  AND i.is_disabled = 0;

-- Review before executing
PRINT @IndexSQL;
-- EXEC sp_executesql @IndexSQL;
```

**Partition management with dynamic DDL:**

```sql
-- Add a new monthly partition dynamically
DECLARE @NextMonth  DATE          = DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()) + 1, 1);
DECLARE @BoundaryVal NVARCHAR(20) = CONVERT(NVARCHAR(20), @NextMonth, 23);  -- 'YYYY-MM-DD'
DECLARE @sql         NVARCHAR(MAX);

SET @sql = N'ALTER PARTITION FUNCTION pf_Monthly() SPLIT RANGE (''' + @BoundaryVal + N''');';
EXEC sp_executesql @sql;
```

---

## 10. Scope and Variable Visibility

Dynamic SQL executes in its own scope. Local variables and temp tables have different visibility rules.

### Variables are NOT visible inside EXEC/@sql

```sql
DECLARE @x INT = 42;

-- FAILS: @x is not visible inside the dynamic batch
EXEC sp_executesql N'SELECT @x';

-- CORRECT: pass as parameter
EXEC sp_executesql N'SELECT @x', N'@x INT', @x = @x;

-- OR: embed the value (only for trusted/typed values)
EXEC sp_executesql N'SELECT ' + CAST(@x AS NVARCHAR(10));
```

### Temp tables ARE visible inside EXEC

```sql
CREATE TABLE #Results (ID INT, Value NVARCHAR(100));

-- Temp table created before EXEC is visible inside the dynamic batch
EXEC sp_executesql N'INSERT INTO #Results VALUES (1, ''hello'')';

SELECT * FROM #Results;  -- returns (1, 'hello')
DROP TABLE #Results;
```

This is the standard pattern for returning complex results from dynamic SQL — insert into a temp table inside the dynamic batch, then select from it after EXEC.

### Table variables are NOT visible inside EXEC

```sql
DECLARE @t TABLE (ID INT);

-- FAILS: table variable is not accessible in the dynamic batch scope
EXEC sp_executesql N'INSERT INTO @t VALUES (1)';
```

Use a temp table instead when you need to share data with a dynamic SQL batch.

---

## 11. Plan Caching Behavior

### sp_executesql plans are cached by statement text

SQL Server caches plans for `sp_executesql` based on the normalized statement text plus the parameter list. Two calls with different parameter values but the same statement text will reuse the same cached plan.

```sql
-- These two calls share ONE cached plan
EXEC sp_executesql N'SELECT * FROM dbo.Orders WHERE CustomerID = @id',
                   N'@id INT', @id = 1;

EXEC sp_executesql N'SELECT * FROM dbo.Orders WHERE CustomerID = @id',
                   N'@id INT', @id = 9999;
```

### EXEC(@sql) plans are cached but rarely reused

Plans from `EXEC(@sql)` are cached as "single-use" plans, contributing to plan cache bloat. Each distinct string value produces a separate cache entry.

```sql
-- "Optimize for ad hoc workloads" reduces single-use plan bloat
EXEC sp_configure 'optimize for ad hoc workloads', 1;
RECONFIGURE;
-- Only stubs are cached on first execution; full plan cached on second
```

See `references/32-performance-diagnostics.md` for plan cache monitoring queries.

### Forcing recompile for parameter-sensitive dynamic SQL

```sql
-- Add OPTION (RECOMPILE) inside the dynamic string
SET @sql = N'
    SELECT * FROM dbo.Orders WHERE CustomerID = @id
    OPTION (RECOMPILE)
';
EXEC sp_executesql @sql, N'@id INT', @id = @id;
```

Use `OPTION (RECOMPILE)` inside the dynamic string (not outside EXEC) when the query is highly parameter-sensitive and plan reuse would be harmful.

---

## 12. Debugging Tips

### Print the generated SQL before executing

Always build a debug path for complex dynamic SQL:

```sql
DECLARE @Debug BIT = 0;  -- set to 1 during development

IF @Debug = 1
    PRINT @sql;
ELSE
    EXEC sp_executesql @sql, @params, ...;
```

`PRINT` truncates at 8,000 characters. For longer SQL:

```sql
-- Print in 4000-char chunks (PRINT limit is actually 8191 but NVARCHAR(MAX) needs chunking)
DECLARE @pos INT = 1;
WHILE @pos <= LEN(@sql)
BEGIN
    PRINT SUBSTRING(@sql, @pos, 4000);
    SET @pos += 4000;
END;
```

### Use RAISERROR for immediate flush

```sql
RAISERROR(@sql, 0, 1) WITH NOWAIT;  -- flushes output immediately, useful in SSMS
```

### Capture the generated SQL in a log table

```sql
INSERT INTO dbo.DynamicSQLLog (ProcedureName, GeneratedSQL, ExecutedAt, ExecutedBy)
VALUES (OBJECT_NAME(@@PROCID), @sql, SYSDATETIME(), SUSER_SNAME());
```

### Test with a known good value first

When developing complex dynamic SQL, hardcode one parameter value, print the result, paste it into a query window, and verify it runs correctly before making it fully dynamic.

### sys.dm_exec_sql_text for ad hoc inspection

```sql
-- Find recent dynamic SQL in plan cache
SELECT qs.execution_count,
       qs.total_logical_reads,
       SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1,
                 ((CASE qs.statement_end_offset
                       WHEN -1 THEN DATALENGTH(st.text)
                       ELSE qs.statement_end_offset
                   END - qs.statement_start_offset) / 2) + 1) AS statement_text
FROM   sys.dm_exec_query_stats qs
CROSS  APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE  st.text LIKE '%sp_executesql%'
ORDER  BY qs.total_logical_reads DESC;
```

---

## 13. Security Context

### Ownership chaining does NOT apply to dynamic SQL

In a stored procedure, if the proc owner and table owner match, the caller needs only EXECUTE permission on the proc. But if the proc uses dynamic SQL, ownership chaining breaks:

```sql
-- Proc owned by dbo; table owned by dbo — ownership chain intact for static SQL
-- But inside EXEC or sp_executesql, the caller ALSO needs SELECT on the table
```

**Mitigation:** Grant SELECT on the required tables to the caller, or use `EXECUTE AS` on the proc.

### EXECUTE AS and dynamic SQL

Dynamic SQL inherits the EXECUTE AS context of its calling module:

```sql
CREATE PROCEDURE dbo.GetData
    WITH EXECUTE AS 'AppUser'
AS
    EXEC sp_executesql N'SELECT * FROM dbo.SensitiveTable';
    -- Runs as 'AppUser' — AppUser needs SELECT on SensitiveTable
```

> [!WARNING]
> `EXECUTE AS` context does NOT cross linked server calls or cross-database calls in dynamic SQL. See `references/15-principals-permissions.md`.

### Module signing as an alternative

Sign the stored procedure with a certificate and grant permissions to the certificate-derived login. This preserves ownership chaining without `EXECUTE AS` impersonation. See `references/16-security-encryption.md`.

---

## 14. Dynamic SQL in Stored Procedures

Key integration patterns:

### Return a result set from dynamic SQL

```sql
-- The dynamic SELECT just streams results back to the caller
CREATE PROCEDURE dbo.FlexSearch @filter NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql NVARCHAR(MAX) = N'SELECT OrderID, OrderDate FROM dbo.Orders WHERE 1=1';
    DECLARE @params NVARCHAR(MAX) = N'@filter NVARCHAR(100)';

    IF @filter IS NOT NULL
        SET @sql += N' AND OrderDescription LIKE ''%'' + @filter + ''%''';

    EXEC sp_executesql @sql, @params, @filter = @filter;
END;
```

### Capture a scalar result

```sql
DECLARE @Count INT;
EXEC sp_executesql
    N'SELECT @Count = COUNT(*) FROM dbo.Orders WHERE StatusID = @status',
    N'@Count INT OUTPUT, @status TINYINT',
    @Count  = @Count  OUTPUT,
    @status = 1;

SELECT @Count;  -- populated after EXEC
```

### INSERT...EXEC pattern

```sql
CREATE TABLE #Results (OrderID INT, TotalAmount DECIMAL(18,2));

INSERT INTO #Results
EXEC sp_executesql N'SELECT OrderID, TotalAmount FROM dbo.Orders WHERE StatusID = 1';

SELECT SUM(TotalAmount) FROM #Results;
```

> [!WARNING]
> `INSERT...EXEC` cannot be nested — if the calling procedure also uses `INSERT...EXEC`, this will fail with error 8164. Use temp tables or table-valued parameters to pass results instead.

---

## 15. Output Parameters

`sp_executesql` supports OUTPUT parameters, enabling dynamic SQL to return scalar values without a result set.

```sql
DECLARE @sql        NVARCHAR(MAX);
DECLARE @params     NVARCHAR(MAX);
DECLARE @MaxSale    DECIMAL(18,2);
DECLARE @AvgSale    DECIMAL(18,2);
DECLARE @TableName  NVARCHAR(128) = 'Orders';  -- from config, not user input

SET @sql = N'
    SELECT @MaxSale = MAX(TotalAmount),
           @AvgSale = AVG(TotalAmount)
    FROM   ' + QUOTENAME(@TableName);

SET @params = N'@MaxSale DECIMAL(18,2) OUTPUT, @AvgSale DECIMAL(18,2) OUTPUT';

EXEC sp_executesql @sql, @params,
    @MaxSale = @MaxSale OUTPUT,
    @AvgSale = @AvgSale OUTPUT;

SELECT @MaxSale AS MaxSale, @AvgSale AS AvgSale;
```

---

## 16. Metadata Queries (Dynamic)

A common legitimate use of dynamic SQL: iterate across databases or schemas using catalog views.

```sql
-- Count rows in a given table across all user databases
DECLARE @TableName NVARCHAR(128) = 'Orders';
DECLARE @sql       NVARCHAR(MAX) = N'';
DECLARE @results   TABLE (DatabaseName SYSNAME, RowCount BIGINT);

SELECT @sql += N'
    INSERT INTO @results
    SELECT DB_NAME() AS DatabaseName, COUNT_BIG(*) AS RowCount
    FROM   ' + QUOTENAME(name) + N'.dbo.' + QUOTENAME(@TableName) + N'
    WHERE  OBJECT_ID(''' + QUOTENAME(name) + N'.dbo.' + QUOTENAME(@TableName) + N''') IS NOT NULL;
'
FROM sys.databases
WHERE state_desc = 'ONLINE'
  AND name NOT IN ('master','model','msdb','tempdb');

-- Note: @results table variable is not visible in dynamic batch
-- Use a temp table instead
CREATE TABLE #CrossDbResults (DatabaseName SYSNAME, RowCount BIGINT);

-- Rebuild using temp table
SET @sql = N'';
SELECT @sql += N'
    IF OBJECT_ID(''' + QUOTENAME(name) + N'.dbo.' + QUOTENAME(@TableName) + N''') IS NOT NULL
    BEGIN
        INSERT INTO #CrossDbResults
        SELECT ''' + REPLACE(name, '''', '''''') + N''', COUNT_BIG(*)
        FROM   ' + QUOTENAME(name) + N'.dbo.' + QUOTENAME(@TableName) + N';
    END
'
FROM sys.databases
WHERE state_desc = 'ONLINE'
  AND name NOT IN ('master','model','msdb','tempdb');

EXEC sp_executesql @sql;
SELECT * FROM #CrossDbResults ORDER BY RowCount DESC;
DROP TABLE #CrossDbResults;
```

---

## 17. Gotchas / Anti-patterns

1. **VARCHAR instead of NVARCHAR for @sql**
   `sp_executesql` requires `NVARCHAR`. Passing `VARCHAR` causes implicit conversion, can silently truncate Unicode characters, and may fail on some collations.

2. **String truncation of NVARCHAR(MAX)**
   `SET @sql = @sql + @fragment` is fine, but `PRINT @sql` only shows the first 8,191 characters. Use the chunked PRINT loop shown in the Debugging section to see the full string.

3. **Forgetting OUTPUT keyword on both sides**
   ```sql
   -- WRONG: @result declared as OUTPUT in params but not marked OUTPUT in call
   EXEC sp_executesql @sql, N'@result INT OUTPUT', @result = @result;
   -- vs
   EXEC sp_executesql @sql, N'@result INT OUTPUT', @result = @result OUTPUT;  -- CORRECT
   ```

4. **Table variable not visible in dynamic batch**
   Always use a `#temp` table when you need to share data between the caller and a dynamic SQL batch.

5. **Nested INSERT...EXEC**
   If your proc uses `INSERT...EXEC` and the called proc also uses dynamic SQL with `INSERT...EXEC`, it will fail with error 8164. This is a hard limit — restructure with temp tables.

6. **Dynamic SQL defeats SCHEMABINDING**
   Functions and views with `SCHEMABINDING` cannot call or reference dynamic SQL. Don't try to work around it — redesign as a stored procedure or static view.

7. **QUOTENAME returns NULL on long names**
   If `@name` > 128 characters, `QUOTENAME` returns NULL, and your concatenated SQL becomes silently NULL. Always validate length before calling QUOTENAME.

8. **Plan cache pollution from EXEC(@sql) with literals**
   Every distinct string produces its own cache entry. Use `sp_executesql` with parameters, or enable "optimize for ad hoc workloads" to at least reduce full-plan caching on first execution.

9. **sp_ prefix on dynamic proc names**
   If you dynamically execute `EXEC sp_myproc`, SQL Server first looks in `master` before the current database. Avoid the `sp_` prefix on custom procs. See `references/06-stored-procedures.md`.

10. **Dynamic SQL inside functions is forbidden**
    You cannot use `EXEC` or `sp_executesql` inside a user-defined function (scalar, iTVF, or mTVF). If you need dynamic SQL, it must be in a stored procedure.

11. **Concatenating NULL produces NULL**
    ```sql
    DECLARE @filter NVARCHAR(100) = NULL;
    DECLARE @sql NVARCHAR(MAX) = N'SELECT * FROM dbo.Orders WHERE Name = ' + @filter;
    -- @sql is now NULL — EXEC sp_executesql NULL will fail silently or with error 8144
    ```
    Always use `ISNULL(@fragment, N'')` when conditionally appending to @sql, or build the string with explicit NULL checks.

12. **Missing semicolons in multi-statement dynamic SQL**
    Forgetting semicolons between statements in a multi-statement dynamic batch causes parse errors. Each statement should end with a semicolon when concatenating.

---

## 18. See Also

- [`references/06-stored-procedures.md`](06-stored-procedures.md) — EXECUTE AS, param sniffing, proc design
- [`references/11-custom-data-types.md`](11-custom-data-types.md) — Table-valued parameters as alternative to dynamic IN lists
- [`references/13-transactions-locking.md`](13-transactions-locking.md) — Transaction scope inside dynamic SQL
- [`references/14-error-handling.md`](14-error-handling.md) — TRY/CATCH around EXEC
- [`references/15-principals-permissions.md`](15-principals-permissions.md) — Ownership chaining and dynamic SQL
- [`references/29-query-plans.md`](29-query-plans.md) — Reading plans from dynamic SQL, plan forcing
- [`references/30-query-store.md`](30-query-store.md) — PSPO, plan forcing for dynamic SQL
- [`references/32-performance-diagnostics.md`](32-performance-diagnostics.md) — Plan cache analysis, ad hoc workloads setting
- [`references/35-dbcc-commands.md`](35-dbcc-commands.md) — FREEPROCCACHE for clearing dynamic SQL plans

---

## Sources

[^1]: [sp_executesql (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-executesql-transact-sql) — executing parameterized dynamic SQL with plan reuse
[^2]: [QUOTENAME (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/quotename-transact-sql) — safely delimiting identifiers in dynamic SQL to prevent injection
[^3]: [Defensive Database Programming with SQL Server](https://www.amazon.com/Defensive-Database-Programming-SQL-Server/dp/1906434492) — Alex Kuznetsov (Red Gate Books, 2010, ISBN 978-1906434496) — defensive T-SQL patterns including dynamic SQL safety
[^4]: [The Curse and Blessings of Dynamic SQL](https://sommarskog.se/dynamic_sql.html) — Erland Sommarskog's authoritative guide on dynamic SQL patterns and injection prevention
[^5]: [Dynamic Search Conditions in T-SQL](https://sommarskog.se/dyn-search.html) — Erland Sommarskog's canonical reference for optional/dynamic WHERE patterns with performance analysis
[^6]: [Server Configuration: optimize for ad hoc workloads](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/optimize-for-ad-hoc-workloads-server-configuration-option) — reducing plan cache bloat from single-use dynamic SQL plans
[^7]: [INSERT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/insert-transact-sql) — INSERT...EXEC syntax for capturing dynamic SQL result sets
[^8]: [SQL Injection](https://learn.microsoft.com/en-us/sql/relational-databases/security/sql-injection) — Microsoft reference on SQL injection attack patterns and prevention techniques
[^9]: [EXECUTE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/execute-transact-sql) — EXEC statement syntax, context switching, and pass-through command execution

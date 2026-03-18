# Views Reference — SQL Server 2022

## Table of Contents

1. [When to Use Views](#when-to-use-views)
2. [Standard Views](#standard-views)
   - [CREATE VIEW syntax](#create-view-syntax)
   - [WITH CHECK OPTION](#with-check-option)
   - [Updateable views](#updateable-views)
   - [SCHEMABINDING](#schemabinding)
3. [Indexed Views (Materialized Views)](#indexed-views)
   - [Requirements and restrictions](#requirements-and-restrictions)
   - [Creating a clustered index on a view](#creating-a-clustered-index-on-a-view)
   - [Query optimizer matching](#query-optimizer-matching)
   - [NOEXPAND hint](#noexpand-hint)
   - [Maintaining indexed views](#maintaining-indexed-views)
4. [Partitioned Views](#partitioned-views)
   - [Local partitioned views](#local-partitioned-views)
   - [Distributed partitioned views](#distributed-partitioned-views)
   - [Partition elimination requirements](#partition-elimination-requirements)
5. [System Views and Catalog Views](#system-views-and-catalog-views)
6. [Gotchas and Anti-patterns](#gotchas-and-anti-patterns)
7. [See Also](#see-also)
8. [Sources](#sources)

---

## When to Use Views

| Scenario | Recommended? | Notes |
|---|---|---|
| Simplify complex joins for app layer | Yes | Hides complexity; no performance cost vs raw query |
| Row/column security (limited) | Yes (limited) | Prefer RLS for serious security; see [16-security-encryption.md](16-security-encryption.md) |
| Logical name stability over schema changes | Yes | Decouple apps from physical schema evolution |
| Pre-aggregate frequently queried totals | Use **indexed view** | Standard view re-executes on every query |
| Cross-table reporting with GROUP BY | Use **indexed view** | Materialized aggregates avoid repeated scans |
| Horizontal partitioning across member tables | Use **partitioned view** | See [Partitioned Views](#partitioned-views) |
| Replacing a table for legacy compatibility | Yes | Can wrap UNION or reshaping logic |
| Recursive traversal or set operations | No | Views cannot reference themselves; use CTEs or [recursive CTEs](04-ctes.md) |

---

## Standard Views

### CREATE VIEW syntax

```sql
-- Minimal form
CREATE VIEW Sales.OrderSummary
AS
    SELECT
        o.OrderID,
        o.CustomerID,
        c.CustomerName,
        o.OrderDate,
        SUM(od.Qty * od.UnitPrice) AS TotalAmount
    FROM Sales.Orders         AS o
    JOIN Sales.OrderDetails   AS od ON od.OrderID = o.OrderID
    JOIN Sales.Customers      AS c  ON c.CustomerID = o.CustomerID
    GROUP BY o.OrderID, o.CustomerID, c.CustomerName, o.OrderDate;
GO

-- ALTER to modify
ALTER VIEW Sales.OrderSummary
AS
    -- revised query here
GO

-- Drop
DROP VIEW IF EXISTS Sales.OrderSummary;  -- IF EXISTS: SQL Server 2016+
```

**Column aliases** — always name computed columns explicitly:

```sql
CREATE VIEW dbo.ProductMargin
AS
    SELECT
        ProductID,
        ProductName,
        ListPrice - StandardCost  AS Margin,   -- explicit alias required
        (ListPrice - StandardCost) / NULLIF(ListPrice, 0) AS MarginPct
    FROM Production.Product;
```

> [!WARNING]
> Unnamed computed columns (`SELECT a + b FROM ...`) are valid in a view definition but give the column no name, which breaks downstream code that references column names. Always alias computed expressions.

**WITH ENCRYPTION** — obfuscates the view definition in `sys.sql_modules`. Useful for protecting proprietary logic but complicates debugging and source control:

```sql
CREATE VIEW dbo.SensitiveCalc
WITH ENCRYPTION
AS
    SELECT ...;
```

> [!WARNING]
> `WITH ENCRYPTION` prevents `sp_helptext` and scripting tools from recovering the definition. If the original script is lost, the view definition is unrecoverable without third-party tools.

---

### WITH CHECK OPTION

Prevents DML through the view from creating rows that would no longer be visible through that view:

```sql
CREATE VIEW Sales.ActiveCustomers
AS
    SELECT CustomerID, CustomerName, IsActive
    FROM Sales.Customers
    WHERE IsActive = 1
WITH CHECK OPTION;

-- This INSERT would be blocked — the new row has IsActive = 0, which the view wouldn't show:
INSERT INTO Sales.ActiveCustomers (CustomerID, CustomerName, IsActive)
VALUES (999, 'Ghost Corp', 0);
-- Msg 550, The attempted insert or update failed because the target view either specifies WITH CHECK OPTION...
```

---

### Updateable Views

A view is updateable (INSERT/UPDATE/DELETE) without triggers when:

1. References exactly **one base table** in the DML operation
2. No `DISTINCT`, `GROUP BY`, `HAVING`, `UNION`, `TOP`, aggregate functions, or subqueries in the SELECT list
3. All `NOT NULL` columns without defaults in the base table are included in the view

```sql
-- Updateable — passes all conditions:
CREATE VIEW HR.ActiveEmployees
AS
    SELECT EmployeeID, FirstName, LastName, DepartmentID
    FROM HR.Employees
    WHERE IsActive = 1;

-- Valid UPDATE through the view:
UPDATE HR.ActiveEmployees
SET DepartmentID = 5
WHERE EmployeeID = 101;

-- Valid DELETE through the view:
DELETE FROM HR.ActiveEmployees WHERE EmployeeID = 101;
```

For complex views that don't meet these criteria, use `INSTEAD OF` triggers — see [39-triggers.md](39-triggers.md).

---

### SCHEMABINDING

`WITH SCHEMABINDING` binds the view to the schema of referenced objects, preventing any structural change that would break the view:

```sql
CREATE VIEW dbo.ProductCatalog
WITH SCHEMABINDING
AS
    SELECT
        p.ProductID,
        p.ProductName,
        c.CategoryName
    FROM dbo.Products     AS p   -- must use two-part names: schema.object
    JOIN dbo.Categories   AS c ON c.CategoryID = p.CategoryID;
```

**Requirements with SCHEMABINDING:**
- All referenced objects must use `schema.object` two-part names (no bare table names, no synonyms)
- Cannot use `SELECT *` — all columns must be explicitly named
- Referenced objects cannot be dropped or have their schema altered while the binding exists

**Why use it even when you don't need an indexed view:**

```sql
-- Without SCHEMABINDING: this succeeds silently, breaking the view
ALTER TABLE dbo.Products DROP COLUMN ProductName;  -- view now returns error at query time

-- With SCHEMABINDING: this fails fast with a clear error
ALTER TABLE dbo.Products DROP COLUMN ProductName;
-- Msg 5074, The object 'ProductCatalog' is dependent on column 'ProductName'.
```

> [!NOTE] Best practice
> Apply `WITH SCHEMABINDING` to all production views. The fast-fail behavior catches schema-drift bugs at DDL time rather than at query runtime.

---

## Indexed Views

An **indexed view** (also called a *materialized view*) stores the result set of the view definition on disk as a clustered index. This eliminates re-execution cost for expensive aggregations and joins.

### Requirements and Restrictions [^1]

The view definition **must** meet all of the following:

| Requirement | Detail |
|---|---|
| `WITH SCHEMABINDING` | Mandatory |
| Deterministic expressions only | No `GETDATE()`, `NEWID()`, `RAND()`, etc. |
| Two-part names for all objects | `dbo.Table`, not `Table` |
| No outer joins, `UNION`, `INTERSECT`, `EXCEPT` | Only inner joins and cross joins |
| No subqueries or CTEs | Flatten the query |
| No `SELECT *` | All columns explicitly listed |
| No `TOP`, `OFFSET/FETCH`, `DISTINCT` | |
| `COUNT_BIG(*)` required when `GROUP BY` used | `COUNT(*)` is not allowed — use `COUNT_BIG(*)` |
| `SUM()` on a nullable column requires `COUNT_BIG(expr)` too | Needed to correctly handle NULLs during incremental updates |
| No derived tables, sub-selects | Flatten to direct references |
| All aggregated columns must be in the view | You can add nonclustered indexes later over more columns |
| Database options: `ANSI_NULLS=ON`, `ANSI_PADDING=ON`, `ANSI_WARNINGS=ON`, `ARITHABORT=ON`, `CONCAT_NULL_YIELDS_NULL=ON`, `QUOTED_IDENTIFIER=ON`, `NUMERIC_ROUNDABORT=OFF` | Check with `DBCC USEROPTIONS` |

> [!NOTE] Azure SQL
> Azure SQL Database and Azure SQL Managed Instance support indexed views with the same restrictions.

### Creating a Clustered Index on a View

```sql
-- Step 1: Create the view with SCHEMABINDING
CREATE VIEW Sales.DailySalesByProduct
WITH SCHEMABINDING
AS
    SELECT
        CAST(o.OrderDate AS date)   AS SaleDate,
        od.ProductID,
        SUM(od.Qty * od.UnitPrice)  AS TotalSales,
        COUNT_BIG(*)                AS OrderLineCount   -- required with GROUP BY
    FROM dbo.Orders         AS o
    JOIN dbo.OrderDetails   AS od ON od.OrderID = o.OrderID
    GROUP BY CAST(o.OrderDate AS date), od.ProductID;
GO

-- Step 2: Create unique clustered index — this materializes the view
CREATE UNIQUE CLUSTERED INDEX CIX_DailySalesByProduct
ON Sales.DailySalesByProduct (SaleDate, ProductID);
GO

-- Step 3: Add nonclustered indexes for additional access patterns
CREATE NONCLUSTERED INDEX IX_DailySalesByProduct_Product
ON Sales.DailySalesByProduct (ProductID)
INCLUDE (TotalSales);
```

The view is now physically stored and automatically kept in sync by SQL Server on every INSERT/UPDATE/DELETE to the base tables.

---

### Query Optimizer Matching

The optimizer can automatically match queries against indexed views **in Enterprise Edition** without any hint:

```sql
-- This query references the base tables...
SELECT
    CAST(OrderDate AS date) AS SaleDate,
    ProductID,
    SUM(Qty * UnitPrice)    AS TotalSales
FROM dbo.Orders AS o
JOIN dbo.OrderDetails AS od ON od.OrderID = o.OrderID
GROUP BY CAST(OrderDate AS date), ProductID;

-- ...and the optimizer may choose the indexed view instead if it's cheaper.
-- Look for "Sales.DailySalesByProduct" in the execution plan.
```

> [!WARNING]
> **Enterprise Edition only**: Automatic view matching works only in Enterprise (and Developer) editions. Standard and Express editions will scan the view every time unless you use `WITH (NOEXPAND)`.

---

### NOEXPAND Hint

Forces the optimizer to use the indexed view's stored data in **all** editions:

```sql
-- Explicit reference to the view + NOEXPAND forces materialized scan/seek
SELECT SaleDate, ProductID, TotalSales
FROM Sales.DailySalesByProduct WITH (NOEXPAND)
WHERE SaleDate >= '2024-01-01';
```

**Always use `NOEXPAND` in Standard Edition**, and consider it even in Enterprise when you want deterministic plan behavior regardless of statistics.

---

### Maintaining Indexed Views

Indexed views are maintained automatically — SQL Server updates the view's clustered index on every base-table DML. This means:

- **High write overhead**: Every INSERT/UPDATE/DELETE to base tables pays the cost of maintaining the indexed view. Measure the write penalty before deploying.
- **Multiple indexed views multiply the cost**: Each indexed view over the same base table is updated independently.
- **Rebuilding**: Same syntax as a regular index:

```sql
ALTER INDEX CIX_DailySalesByProduct
ON Sales.DailySalesByProduct
REBUILD WITH (ONLINE = ON);   -- ONLINE requires Enterprise Edition
```

**Check indexed view fragmentation:**

```sql
SELECT
    OBJECT_NAME(i.object_id)  AS ViewName,
    i.name                    AS IndexName,
    s.avg_fragmentation_in_percent,
    s.page_count
FROM sys.dm_db_index_physical_stats(DB_ID(), OBJECT_ID('Sales.DailySalesByProduct'), NULL, NULL, 'LIMITED') AS s
JOIN sys.indexes AS i ON i.object_id = s.object_id AND i.index_id = s.index_id;
```

---

## Partitioned Views

A partitioned view is a UNION ALL over multiple **member tables**, each containing a non-overlapping partition of the full dataset. The optimizer can eliminate member tables from query plans using CHECK constraints on the partition column.

### Local Partitioned Views

All member tables reside in the **same database**:

```sql
-- Member tables: one per year, each with a CHECK constraint
CREATE TABLE Orders_2022 (
    OrderID   int           NOT NULL,
    OrderYear smallint      NOT NULL CONSTRAINT CK_Orders2022_Year CHECK (OrderYear = 2022),
    -- other columns
    CONSTRAINT PK_Orders2022 PRIMARY KEY (OrderID, OrderYear)
);

CREATE TABLE Orders_2023 (
    OrderID   int           NOT NULL,
    OrderYear smallint      NOT NULL CONSTRAINT CK_Orders2023_Year CHECK (OrderYear = 2023),
    CONSTRAINT PK_Orders2023 PRIMARY KEY (OrderID, OrderYear)
);

CREATE TABLE Orders_2024 (
    OrderID   int           NOT NULL,
    OrderYear smallint      NOT NULL CONSTRAINT CK_Orders2024_Year CHECK (OrderYear = 2024),
    CONSTRAINT PK_Orders2024 PRIMARY KEY (OrderID, OrderYear)
);

-- Partitioned view
CREATE VIEW dbo.Orders
AS
    SELECT * FROM dbo.Orders_2022
    UNION ALL
    SELECT * FROM dbo.Orders_2023
    UNION ALL
    SELECT * FROM dbo.Orders_2024;
```

**Query with partition elimination:**

```sql
-- Only Orders_2023 is accessed — optimizer uses CHECK constraints to eliminate others
SELECT OrderID, OrderYear
FROM dbo.Orders
WHERE OrderYear = 2023;
```

Verify elimination in the execution plan: only one of the member tables should appear as an Index Seek/Scan, not all three.

---

### Distributed Partitioned Views

Member tables reside on **different servers** connected via linked servers. Each server hosts one slice of the data and publishes a partitioned view:

```sql
-- On Server1 (owns 2022–2023 data):
CREATE VIEW dbo.Orders
AS
    SELECT * FROM dbo.Orders_2022
    UNION ALL
    SELECT * FROM dbo.Orders_2023
    UNION ALL
    SELECT * FROM Server2.SalesDB.dbo.Orders_2024;   -- remote member
```

> [!WARNING]
> Distributed partitioned views are rarely used today. Prefer table partitioning (see [10-partitioning.md](10-partitioning.md)) or Always On readable secondaries for scale-out reads. DPVs require DTC for distributed transactions and add significant complexity.

---

### Partition Elimination Requirements

For the optimizer to eliminate member tables, ALL of these must hold:

1. Each member table has a `CHECK` constraint on the partition column (e.g., `CHECK (OrderYear = 2022)`)
2. Constraints must be **trusted** — verify with:
   ```sql
   SELECT name, is_not_trusted
   FROM sys.check_constraints
   WHERE parent_object_id = OBJECT_ID('dbo.Orders_2022');
   -- is_not_trusted = 0 means trusted (good)
   ```
3. The partition column in the WHERE clause matches the CHECK constraint expression exactly (no function wrapping)
4. Each member table primary key must include the partition column
5. Column definitions (name, type, nullability, collation) must be identical across all member tables

**Rebuild a broken trusted constraint:**

```sql
-- Constraint is untrusted (is_not_trusted = 1) — re-check it:
ALTER TABLE dbo.Orders_2022
WITH CHECK CHECK CONSTRAINT CK_Orders2022_Year;
```

---

## System Views and Catalog Views

Key system views for introspecting view definitions and dependencies:

```sql
-- List all views in the current database
SELECT
    SCHEMA_NAME(schema_id)  AS SchemaName,
    name                    AS ViewName,
    is_schema_bound,        -- 1 = WITH SCHEMABINDING
    with_check_option,
    create_date,
    modify_date
FROM sys.views
ORDER BY SchemaName, ViewName;

-- Get view definition (not encrypted views)
SELECT OBJECT_DEFINITION(OBJECT_ID('Sales.OrderSummary'));
-- or:
EXEC sp_helptext 'Sales.OrderSummary';

-- Find all indexed views (have a clustered index)
SELECT
    v.name AS ViewName,
    i.name AS IndexName,
    i.type_desc
FROM sys.views AS v
JOIN sys.indexes AS i ON i.object_id = v.object_id AND i.type = 1  -- clustered
ORDER BY v.name;

-- Check dependencies — what objects does this view reference?
SELECT
    OBJECT_NAME(referencing_id)  AS ViewName,
    referenced_schema_name,
    referenced_entity_name,
    referenced_minor_name        -- column name, if column-level dep
FROM sys.sql_expression_dependencies
WHERE referencing_id = OBJECT_ID('Sales.OrderSummary');

-- Reverse: what views reference this table?
SELECT
    OBJECT_NAME(referencing_id) AS DependentView
FROM sys.sql_expression_dependencies
WHERE referenced_id = OBJECT_ID('Sales.Orders');
```

---

## Gotchas and Anti-patterns

### 1. Views are not a security boundary without additional controls

```sql
-- If a user has SELECT on the view, they can still see all columns returned by the view.
-- Use column-level DENY or RLS predicates for true column/row security.
-- See references/16-security-encryption.md for RLS.
```

### 2. SELECT * in views silently breaks after ALTER TABLE

```sql
CREATE VIEW dbo.EmployeeFull AS SELECT * FROM dbo.Employees;

ALTER TABLE dbo.Employees ADD Salary money;

-- The view still returns the OLD column list until refreshed:
EXEC sp_refreshview 'dbo.EmployeeFull';
-- Or: run ALTER VIEW to recompile
```

Always list columns explicitly. If `SELECT *` is unavoidable, run `sp_refreshview` or `ALTER VIEW` after any base-table schema change.

### 3. Nesting views accumulates performance debt

```sql
-- ViewC references ViewB which references ViewA which has a 5-table join.
-- All joins execute on every query of ViewC. There is no caching.
-- Flatten nested views into a single view or indexed view when nesting causes plan complexity.
```

### 4. Indexed view maintenance on hot write paths

An indexed view on a high-insert table pays the maintenance cost on every INSERT. Measure with:

```sql
SET STATISTICS IO ON;
-- Run your INSERT workload
-- Look for logical reads on the indexed view's clustered index name
```

Consider dropping the indexed view and using a scheduled refresh (via a staging table + swap) if write latency is unacceptable.

### 5. WITH CHECK OPTION does not validate existing data

`WITH CHECK OPTION` only checks **new or modified rows** inserted/updated through the view. Existing rows that fail the WHERE predicate are not flagged.

### 6. Ownership chaining with views across schemas

When a view in schema A references a table in schema B, and the user has permission on the view but not the table:
- **Same owner**: SQL Server skips the table permission check (ownership chaining applies).
- **Different owners**: SQL Server checks table permissions — the user must have SELECT on the base table too.

This is often surprising. Use consistent ownership (all objects owned by `dbo`) to keep ownership chaining predictable. See [15-principals-permissions.md](15-principals-permissions.md).

### 7. Indexed view aggregates must include COUNT_BIG(*)

```sql
-- Wrong — will fail to create clustered index:
CREATE VIEW dbo.BadAgg WITH SCHEMABINDING AS
    SELECT ProductID, SUM(Qty) AS TotalQty
    FROM dbo.OrderDetails GROUP BY ProductID;

-- Right:
CREATE VIEW dbo.GoodAgg WITH SCHEMABINDING AS
    SELECT ProductID, SUM(Qty) AS TotalQty, COUNT_BIG(*) AS RowCount
    FROM dbo.OrderDetails GROUP BY ProductID;
```

`COUNT_BIG(*)` is mandatory when using `GROUP BY`. SQL Server uses it internally to correctly compute averages and handle deletes/updates.

### 8. Indexed views and non-deterministic functions

```sql
-- GETDATE() is non-deterministic — will fail at index creation time:
CREATE VIEW dbo.BadIndexed WITH SCHEMABINDING AS
    SELECT ProductID, DATEDIFF(day, CreateDate, GETDATE()) AS AgeDays
    FROM dbo.Products;
-- Cannot create index — GETDATE() is non-deterministic
```

Use computed columns with `PERSISTED` on the base table if you need a materialized derived column based on a snapshot time.

---

## See Also

- [04-ctes.md](04-ctes.md) — CTEs as alternatives to derived tables inside view definitions
- [10-partitioning.md](10-partitioning.md) — Table partitioning as a modern alternative to partitioned views
- [08-indexes.md](08-indexes.md) — Index fill factor, fragmentation, rebuild/reorganize thresholds
- [15-principals-permissions.md](15-principals-permissions.md) — Ownership chaining, GRANT on views vs base tables
- [16-security-encryption.md](16-security-encryption.md) — Row-Level Security as the preferred security alternative to security views
- [39-triggers.md](39-triggers.md) — INSTEAD OF triggers for updateable complex views

---

## Sources

[^1]: [Create Indexed Views - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/views/create-indexed-views) — requirements, SET options, determinism rules, and step-by-step guide for creating a unique clustered index on a view

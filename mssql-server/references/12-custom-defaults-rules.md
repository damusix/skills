# 12 — Custom Defaults, Rules, and Constraints

Comprehensive reference for SQL Server constraint types, DEFAULT definitions, legacy RULE/DEFAULT objects, cascading referential actions, and patterns for enforcing data integrity at the database layer.

---

## Table of Contents

1. [When to Use](#1-when-to-use)
2. [Constraint Types Overview](#2-constraint-types-overview)
3. [DEFAULT Constraints](#3-default-constraints)
4. [CHECK Constraints](#4-check-constraints)
5. [UNIQUE Constraints](#5-unique-constraints)
6. [PRIMARY KEY Constraints](#6-primary-key-constraints)
7. [FOREIGN KEY Constraints and Cascades](#7-foreign-key-constraints-and-cascades)
8. [Legacy RULE and DEFAULT Objects](#8-legacy-rule-and-default-objects)
9. [Constraint Metadata and Inspection](#9-constraint-metadata-and-inspection)
10. [Deferred Constraint Equivalents](#10-deferred-constraint-equivalents)
11. [Constraint Patterns and Best Practices](#11-constraint-patterns-and-best-practices)
12. [Functional Constraints](#12-functional-constraints)
13. [Cross-Table, Cross-Schema, and Cross-Database Constraints](#13-cross-table-cross-schema-and-cross-database-constraints)
14. [Gotchas / Anti-patterns](#14-gotchas--anti-patterns)
15. [See Also](#15-see-also)
16. [Sources](#16-sources)

---

## 1. When to Use

Enforce data integrity at the **database layer** when:
- Application-layer validation may be bypassed (bulk loads, direct SQL, multiple apps sharing one DB)
- You need audit-proof guarantees (compliance, financial data)
- You want the query optimizer to use constraint metadata for plan optimization (CHECK constraints enable partition elimination; NOT NULL enables tighter cardinality estimates)

Prefer constraints over triggers for simple integrity rules — constraints are:
- Declarative and self-documenting
- Enforced by the storage engine before any trigger fires
- Visible to the optimizer
- Faster (no row-by-row logic)

---

## 2. Constraint Types Overview

| Constraint | Keyword | Scope | Optimizer uses? |
|---|---|---|---|
| NOT NULL | column definition | Single column | Yes — non-nullable col gets tighter CE |
| DEFAULT | `DEFAULT` | Single column | No |
| CHECK | `CHECK` | Column or table | Yes — elimination, contradiction detection |
| UNIQUE | `UNIQUE` | 1–16 columns | Yes — enables merge join, FK target |
| PRIMARY KEY | `PRIMARY KEY` | 1–16 columns | Yes — clustered or nonclustered index |
| FOREIGN KEY | `REFERENCES` | 1–16 columns | Yes — FK trusted = join elimination possible |

All constraints can be named or anonymous. **Always name constraints** — anonymous names are system-generated (e.g., `UQ__Orders__3213E83F4A3D3B41`) and fragile across environments.

---

## 3. DEFAULT Constraints

### Inline definition

```sql
CREATE TABLE dbo.Orders
(
    OrderId     INT           NOT NULL IDENTITY(1,1),
    OrderDate   DATE          NOT NULL CONSTRAINT df_Orders_OrderDate DEFAULT (CAST(GETDATE() AS DATE)),
    Status      NVARCHAR(20)  NOT NULL CONSTRAINT df_Orders_Status    DEFAULT (N'Pending'),
    CreatedUtc  DATETIME2(7)  NOT NULL CONSTRAINT df_Orders_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    IsDeleted   BIT           NOT NULL CONSTRAINT df_Orders_IsDeleted  DEFAULT (0),
    Metadata    NVARCHAR(MAX)     NULL CONSTRAINT df_Orders_Metadata   DEFAULT (N'{}')
);
```

### Adding to an existing column

```sql
ALTER TABLE dbo.Orders
    ADD CONSTRAINT df_Orders_Priority DEFAULT (0) FOR Priority;
```

### Dropping

```sql
ALTER TABLE dbo.Orders DROP CONSTRAINT df_Orders_Priority;
```

### DEFAULT with a function

```sql
-- Sequence-based default (alternative to IDENTITY)
CREATE SEQUENCE dbo.seq_InvoiceNumber START WITH 1000 INCREMENT BY 1;

CREATE TABLE dbo.Invoices
(
    InvoiceNumber INT NOT NULL
        CONSTRAINT df_Invoices_InvoiceNumber DEFAULT (NEXT VALUE FOR dbo.seq_InvoiceNumber),
    ...
);
```

> [!WARNING] `NEWID()` as a DEFAULT
> Using `DEFAULT (NEWID())` on a clustered key causes page splits on every insert because GUIDs are random. Use `NEWSEQUENTIALID()` instead — it generates monotonically increasing GUIDs within a server restart window. `NEWSEQUENTIALID()` can **only** be used as a column default, not in ad hoc queries.[^2]

```sql
-- Correct pattern for GUID PK with clustered index
CREATE TABLE dbo.Widget
(
    WidgetId    UNIQUEIDENTIFIER NOT NULL
                    CONSTRAINT pk_Widget PRIMARY KEY CLUSTERED
                    CONSTRAINT df_Widget_WidgetId DEFAULT (NEWSEQUENTIALID()),
    ...
);
```

### Behavior notes

- DEFAULT fires only on INSERT when the column is not listed or the keyword `DEFAULT` is used in the VALUES list.
- Explicit `NULL` overrides a DEFAULT — it does not trigger the default expression.
- DEFAULT is **not** retroactive — existing rows are unaffected when a default is added.
- Adding a NOT NULL column with a DEFAULT to a table in SQL Server 2012+ is a metadata-only operation if the table has no rows, and an online metadata-only change from SQL Server 2022 for many cases [^1].

---

## 4. CHECK Constraints

### Basic CHECK

```sql
CREATE TABLE dbo.Product
(
    ProductId   INT          NOT NULL,
    UnitPrice   MONEY        NOT NULL CONSTRAINT ck_Product_UnitPrice   CHECK (UnitPrice >= 0),
    Quantity    INT          NOT NULL CONSTRAINT ck_Product_Quantity    CHECK (Quantity BETWEEN 0 AND 10000),
    Status      CHAR(1)      NOT NULL CONSTRAINT ck_Product_Status      CHECK (Status IN ('A', 'I', 'D')),
    EndDate     DATE             NULL,
    StartDate   DATE         NOT NULL,
    CONSTRAINT ck_Product_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate)
);
```

### Multi-column CHECK (table-level)

```sql
ALTER TABLE dbo.Shipment
    ADD CONSTRAINT ck_Shipment_Dates
        CHECK (ShippedDate IS NULL OR ShippedDate >= OrderDate);
```

### CHECK with scalar UDF (use with caution)

```sql
CREATE FUNCTION dbo.fn_IsValidPostcode(@code NVARCHAR(10))
RETURNS BIT
WITH SCHEMABINDING
AS
BEGIN
    RETURN CASE WHEN @code LIKE '[A-Z][A-Z0-9][0-9] [0-9][A-Z][A-Z]' THEN 1 ELSE 0 END;
END;
GO

ALTER TABLE dbo.Address
    ADD CONSTRAINT ck_Address_Postcode
        CHECK (dbo.fn_IsValidPostcode(Postcode) = 1);
```

> [!WARNING] UDF in CHECK constraint
> A CHECK constraint that calls a scalar UDF executes the UDF **for every row evaluated**, including during scans. Non-inlineable UDFs kill parallelism. Prefer a pure T-SQL expression or an indexed computed column where possible.

### Disabling and enabling constraints

```sql
-- Disable without dropping (useful for bulk loads)
ALTER TABLE dbo.Product NOCHECK CONSTRAINT ck_Product_UnitPrice;

-- Re-enable — WITH CHECK re-validates all existing rows
ALTER TABLE dbo.Product WITH CHECK CHECK CONSTRAINT ck_Product_UnitPrice;

-- Re-enable — WITH NOCHECK skips re-validation (constraint is UNTRUSTED)
ALTER TABLE dbo.Product WITH NOCHECK CHECK CONSTRAINT ck_Product_UnitPrice;
```

> [!WARNING] Untrusted constraints
> `WITH NOCHECK CHECK CONSTRAINT` marks the constraint as `is_not_trusted = 1` in `sys.check_constraints`. The optimizer will **not** use an untrusted CHECK constraint for partition elimination or contradiction detection. Always use `WITH CHECK CHECK CONSTRAINT` after bulk loads unless you have a specific reason not to.

```sql
-- Find untrusted constraints
SELECT
    OBJECT_SCHEMA_NAME(parent_object_id) AS schema_name,
    OBJECT_NAME(parent_object_id)        AS table_name,
    name                                 AS constraint_name,
    type_desc
FROM sys.check_constraints
WHERE is_not_trusted = 1
UNION ALL
SELECT
    OBJECT_SCHEMA_NAME(parent_object_id),
    OBJECT_NAME(parent_object_id),
    name,
    type_desc
FROM sys.foreign_keys
WHERE is_not_trusted = 1;
```

### Optimizer use of CHECK constraints

The query optimizer uses trusted CHECK constraints for:
1. **Partition elimination** — `CHECK (RegionId = 3)` on a partitioned view partition table eliminates that table from queries where the predicate contradicts
2. **Contradiction detection** — a predicate that contradicts a trusted CHECK makes a subtree yield 0 rows; the optimizer can eliminate it
3. **Join simplification** — a trusted FK allows join elimination when only FK columns are projected

---

## 5. UNIQUE Constraints

```sql
CREATE TABLE dbo.Employee
(
    EmployeeId  INT          NOT NULL CONSTRAINT pk_Employee PRIMARY KEY,
    NationalId  NVARCHAR(20) NOT NULL CONSTRAINT uq_Employee_NationalId UNIQUE,
    Email       NVARCHAR(254)    NULL CONSTRAINT uq_Employee_Email      UNIQUE
);
```

### Multi-column UNIQUE

```sql
ALTER TABLE dbo.OrderLine
    ADD CONSTRAINT uq_OrderLine_OrderProduct UNIQUE (OrderId, ProductId);
```

### UNIQUE vs UNIQUE INDEX

A UNIQUE constraint and a `CREATE UNIQUE INDEX` produce the same underlying B-tree index. Prefer `UNIQUE` constraints at table-definition time (self-documenting); prefer `CREATE UNIQUE INDEX` when you need additional index options (INCLUDE columns, filter predicate, fillfactor, partition scheme).

```sql
-- Filtered unique index — enforces uniqueness only for active rows
CREATE UNIQUE INDEX uix_Employee_Email_Active
    ON dbo.Employee (Email)
    WHERE IsDeleted = 0;
```

### NULLs in UNIQUE constraints

SQL Server treats each NULL as **distinct** — a UNIQUE constraint (and a unique index) allows multiple NULLs in the same column. This differs from ANSI SQL's requirement that NULL = NULL for uniqueness purposes.

> [!NOTE] SQL Server 2022
> `IS [NOT] DISTINCT FROM` predicate — while this doesn't change UNIQUE constraint behavior, it provides NULL-safe equality comparisons in WHERE clauses. UNIQUE still allows multiple NULLs.

---

## 6. PRIMARY KEY Constraints

```sql
CREATE TABLE dbo.Category
(
    CategoryId  INT         NOT NULL CONSTRAINT pk_Category PRIMARY KEY CLUSTERED,
    Name        NVARCHAR(100) NOT NULL
);

-- Composite PK
CREATE TABLE dbo.ProductCategory
(
    ProductId   INT NOT NULL,
    CategoryId  INT NOT NULL,
    CONSTRAINT pk_ProductCategory PRIMARY KEY CLUSTERED (ProductId, CategoryId)
);
```

### PK options

```sql
-- Nonclustered PK (when you want a different column as the clustered index)
CREATE TABLE dbo.FactSale
(
    SaleId      BIGINT          NOT NULL CONSTRAINT pk_FactSale PRIMARY KEY NONCLUSTERED,
    SaleDateKey INT             NOT NULL,   -- clustered index will be on this
    ...
    INDEX cix_FactSale_Date CLUSTERED (SaleDateKey, SaleId)
);
```

### Modifying a PK

SQL Server does not support `ALTER TABLE ... ALTER CONSTRAINT`. To change a PK:
1. Drop all FKs referencing it
2. `ALTER TABLE ... DROP CONSTRAINT pk_OldName`
3. `ALTER TABLE ... ADD CONSTRAINT pk_NewName PRIMARY KEY ...`
4. Re-create FKs

---

## 7. FOREIGN KEY Constraints and Cascades

### Basic FK

```sql
CREATE TABLE dbo.Order
(
    OrderId     INT NOT NULL CONSTRAINT pk_Order PRIMARY KEY,
    CustomerId  INT NOT NULL
        CONSTRAINT fk_Order_Customer
            REFERENCES dbo.Customer (CustomerId)
);
```

### Cascade actions

| Action | ON DELETE | ON UPDATE | Behavior |
|---|---|---|---|
| `NO ACTION` (default) | Raises error if referenced row exists | Raises error if referenced row exists | Error surfaced after all triggers fire |
| `RESTRICT` | Same as NO ACTION | Same as NO ACTION | ANSI equivalent; not a distinct SQL Server option |
| `CASCADE` | Deletes child rows | Updates FK column in child rows | Transitive |
| `SET NULL` | Sets FK column to NULL | Sets FK column to NULL | Requires column is NULLable |
| `SET DEFAULT` | Sets FK column to its DEFAULT | Sets FK column to its DEFAULT | Requires DEFAULT exists on FK column |

```sql
-- Cascade delete: deleting an Order also deletes its OrderLines
CREATE TABLE dbo.OrderLine
(
    OrderLineId INT NOT NULL CONSTRAINT pk_OrderLine PRIMARY KEY,
    OrderId     INT NOT NULL
        CONSTRAINT fk_OrderLine_Order
            REFERENCES dbo.Order (OrderId)
            ON DELETE CASCADE
            ON UPDATE NO ACTION,
    ProductId   INT NOT NULL
        CONSTRAINT fk_OrderLine_Product
            REFERENCES dbo.Product (ProductId)
            ON DELETE NO ACTION
            ON UPDATE NO ACTION
);
```

> [!WARNING] Cascading cycles
> SQL Server rejects cascade paths that could loop. If `TableA → TableB → TableA` (directly or transitively) with CASCADE, `CREATE TABLE` fails:
> `Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths.`
> Resolution: use `NO ACTION` on one leg and handle deletion explicitly with a trigger or stored procedure.

> [!WARNING] CASCADE DELETE and performance
> Cascading deletes issue individual `DELETE` statements per child table row, not set-based bulk deletes. On high-cardinality child tables this is slow. For bulk data removal, disable FK constraints, bulk delete, re-enable with `WITH CHECK`.

### Multi-column FK

```sql
ALTER TABLE dbo.Shipment
    ADD CONSTRAINT fk_Shipment_OrderProduct
        FOREIGN KEY (OrderId, ProductId)
        REFERENCES dbo.OrderLine (OrderId, ProductId);
```

### Deferring FK checks (SQL Server limitation)

SQL Server does **not** support `DEFERRABLE` constraints (unlike PostgreSQL). FK violations are checked as each statement completes, not at COMMIT. See [Section 10](#10-deferred-constraint-equivalents) for workarounds.

### FK and optimizer join elimination

When:
1. The FK is trusted (`is_not_trusted = 0`, `is_disabled = 0`)
2. The join columns are not nullable in the child table
3. The query projects no columns from the parent table

…the optimizer can eliminate the join to the parent table entirely because the FK guarantees every child row has a matching parent.[^3]

```sql
-- Parent join is eliminated if FK is trusted and no parent columns needed
SELECT ol.OrderId, ol.ProductId, ol.Quantity
FROM dbo.OrderLine AS ol
    INNER JOIN dbo.Order AS o ON ol.OrderId = o.OrderId;
-- If trusted FK exists and o.* not projected, optimizer may eliminate dbo.Order scan
```

---

## 8. Legacy RULE and DEFAULT Objects

> [!WARNING] Deprecated
> `CREATE RULE` and `CREATE DEFAULT` (bound objects) are deprecated since SQL Server 2008 and removed in a future version. Use `CHECK` constraints and `DEFAULT` constraints instead. Do not use these in new code.

### What they were

- **RULE object**: A named, reusable validation expression bound to columns or UDTs via `sp_bindrule`. Predates CHECK constraints.
- **DEFAULT object**: A named, reusable default expression bound to columns or UDTs via `sp_bindefault`. Predates DEFAULT constraints.

### Detection and migration

```sql
-- Find existing RULE objects
SELECT name, type_desc, OBJECT_DEFINITION(object_id) AS definition
FROM sys.objects
WHERE type = 'R';   -- type = 'R' for rules

-- Find existing DEFAULT objects
SELECT name, type_desc, OBJECT_DEFINITION(object_id) AS definition
FROM sys.objects
WHERE type = 'D' AND parent_object_id = 0;  -- parent_object_id = 0 means standalone default

-- Find columns bound to rules
SELECT
    OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
    OBJECT_NAME(c.object_id)        AS table_name,
    c.name                          AS column_name,
    OBJECT_NAME(c.rule_object_id)   AS rule_name
FROM sys.columns AS c
WHERE c.rule_object_id <> 0;

-- Find columns bound to default objects
SELECT
    OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
    OBJECT_NAME(c.object_id)        AS table_name,
    c.name                          AS column_name,
    OBJECT_NAME(c.default_object_id) AS default_name
FROM sys.columns AS c
WHERE c.default_object_id <> 0
  AND NOT EXISTS (
      SELECT 1 FROM sys.default_constraints dc
      WHERE dc.object_id = c.default_object_id
  );
```

### Migration pattern

```sql
-- Unbind rule from column
EXEC sp_unbindrule 'dbo.Orders.Status';

-- Drop rule object
DROP RULE dbo.rule_StatusValues;

-- Replace with CHECK constraint
ALTER TABLE dbo.Orders
    ADD CONSTRAINT ck_Orders_Status CHECK (Status IN ('Pending', 'Shipped', 'Cancelled'));

-- Unbind default object
EXEC sp_unbindefault 'dbo.Orders.Status';

-- Drop default object
DROP DEFAULT dbo.df_object_StatusDefault;

-- Replace with DEFAULT constraint
ALTER TABLE dbo.Orders
    ADD CONSTRAINT df_Orders_Status DEFAULT ('Pending') FOR Status;
```

---

## 9. Constraint Metadata and Inspection

### sys.* views for constraints

```sql
-- All constraints on a table with their definitions
SELECT
    c.name                          AS constraint_name,
    c.type_desc                     AS constraint_type,
    c.is_disabled,
    c.is_not_trusted,
    c.is_not_for_replication,
    OBJECT_DEFINITION(c.object_id)  AS definition
FROM sys.objects AS c
WHERE c.parent_object_id = OBJECT_ID('dbo.Orders')
  AND c.type IN ('C', 'D', 'F', 'PK', 'UQ')
ORDER BY c.type, c.name;

-- FK columns mapping
SELECT
    fk.name                                     AS fk_name,
    OBJECT_SCHEMA_NAME(fk.parent_object_id)     AS parent_schema,
    OBJECT_NAME(fk.parent_object_id)            AS parent_table,
    pc.name                                     AS parent_column,
    OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema,
    OBJECT_NAME(fk.referenced_object_id)        AS ref_table,
    rc.name                                     AS ref_column,
    fk.delete_referential_action_desc,
    fk.update_referential_action_desc,
    fk.is_disabled,
    fk.is_not_trusted
FROM sys.foreign_keys AS fk
    JOIN sys.foreign_key_columns AS fkc
        ON fk.object_id = fkc.constraint_object_id
    JOIN sys.columns AS pc
        ON pc.object_id = fkc.parent_object_id
       AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns AS rc
        ON rc.object_id = fkc.referenced_object_id
       AND rc.column_id = fkc.referenced_column_id
ORDER BY fk.name, fkc.constraint_column_id;

-- DEFAULT constraints with their columns
SELECT
    dc.name         AS constraint_name,
    c.name          AS column_name,
    dc.definition   AS default_expression
FROM sys.default_constraints AS dc
    JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID('dbo.Orders');
```

### INFORMATION_SCHEMA equivalent

```sql
SELECT *
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Orders';

SELECT *
FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS;

SELECT *
FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS;
```

> [!WARNING] INFORMATION_SCHEMA coverage
> `INFORMATION_SCHEMA` does not expose `is_not_trusted` or `is_disabled`. Use `sys.*` views for full constraint state.

---

## 10. Deferred Constraint Equivalents

SQL Server does not support `DEFERRABLE INITIALLY DEFERRED` constraints. All constraints are checked immediately after each DML statement (not at COMMIT). Workarounds:

### Pattern 1: Disable/re-enable around batch loads

```sql
BEGIN TRANSACTION;

-- Disable FKs for bulk load
ALTER TABLE dbo.OrderLine NOCHECK CONSTRAINT ALL;

-- Bulk load
BULK INSERT dbo.OrderLine FROM 'C:\data\lines.csv' WITH (FIRSTROW=2, FIELDTERMINATOR=',');

-- Re-enable WITH CHECK (validates all rows)
ALTER TABLE dbo.OrderLine WITH CHECK CHECK CONSTRAINT ALL;

COMMIT;
```

### Pattern 2: Staging table + validated swap

For parent–child circular references (rare, but legitimately needed in some schemas):

```sql
-- Step 1: Insert parent with placeholder FK value (NULL or 0 sentinel)
INSERT INTO dbo.Employee (EmployeeId, Name, ManagerId)
VALUES (1, 'CEO', NULL);   -- ManagerId is nullable for root

-- Step 2: Insert children
INSERT INTO dbo.Employee (EmployeeId, Name, ManagerId)
VALUES (2, 'VP', 1);

-- No deferred constraint needed when the root allows NULL FK
```

### Pattern 3: Trigger-based deferred enforcement

When you absolutely need deferred semantics (e.g., a row must reference another row inserted in the same batch):

```sql
-- Disable the FK
ALTER TABLE dbo.Node NOCHECK CONSTRAINT fk_Node_Parent;

-- Create an AFTER INSERT, UPDATE trigger that validates the FK at statement end
CREATE TRIGGER trg_Node_CheckParentFK
ON dbo.Node
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        WHERE i.ParentNodeId IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM dbo.Node AS n
              WHERE n.NodeId = i.ParentNodeId
          )
    )
    BEGIN
        THROW 50001, 'FK violation: ParentNodeId does not exist.', 1;
    END;
END;
```

> Triggers fire **after** the full statement, so self-referencing inserts within a single multi-row VALUES clause can satisfy the constraint even without explicit deferred semantics, as long as the referenced rows are part of the same statement's result.

### Pattern 4: Ordered insert procedure

The cleanest approach for known circular-reference bootstrapping scenarios:

```sql
CREATE PROCEDURE dbo.usp_InsertEmployeeHierarchy
    @Employees dbo.tvp_EmployeeList READONLY   -- table-valued param
AS
BEGIN
    -- Insert root nodes first (ManagerId IS NULL)
    INSERT INTO dbo.Employee (EmployeeId, Name, ManagerId)
    SELECT EmployeeId, Name, ManagerId
    FROM @Employees
    WHERE ManagerId IS NULL;

    -- Insert next level, repeat as needed
    -- For deep hierarchies, use a loop or recursive CTE to layer inserts
END;
```

---

## 11. Constraint Patterns and Best Practices

### Naming convention

```
pk_<Table>                          -- primary key
uq_<Table>_<Columns>                -- unique
fk_<ChildTable>_<ParentTable>       -- foreign key
ck_<Table>_<Rule>                   -- check
df_<Table>_<Column>                 -- default
ix_<Table>_<Columns>                -- nonclustered index (not a constraint, but consistent naming)
```

### Enforcing state machines via CHECK

```sql
-- Only allow valid order status transitions using a table of valid transitions
-- Simpler approach: enumerate valid values
ALTER TABLE dbo.Order
    ADD CONSTRAINT ck_Order_Status
        CHECK (Status IN ('Draft', 'Submitted', 'Processing', 'Shipped', 'Delivered', 'Cancelled'));

-- For transition enforcement, use an INSTEAD OF trigger or stored procedure —
-- CHECK constraints see only the new state, not the previous state
```

### CHECK constraint for email format

```sql
ALTER TABLE dbo.Contact
    ADD CONSTRAINT ck_Contact_Email
        CHECK (Email LIKE '%_@_%.__%');
-- This is a reasonable approximation; it is not RFC 5321 compliant
-- For strict validation, use a scalar UDF (with the performance caveat noted above)
```

### Soft delete pattern with FK and filtered index

```sql
-- Allow FK to a soft-deleted row (FKs don't enforce IsDeleted)
-- Enforce that active rows reference active parents via a trigger instead
-- Filtered UNIQUE to prevent duplicate active records:
CREATE UNIQUE INDEX uix_Product_Sku_Active
    ON dbo.Product (Sku)
    WHERE IsDeleted = 0;
```

### Cascade vs application-managed delete

| Scenario | Recommendation |
|---|---|
| Child rows are meaningless without parent (order lines without order) | `ON DELETE CASCADE` |
| Child rows should be retained (audit log, historical data) | `ON DELETE NO ACTION`; handle in application |
| Child FK column should become NULL on parent delete | `ON DELETE SET NULL` |
| Many child tables, high volume | Explicit batch delete in stored proc; avoid cascade overhead |

### Constraint-based partition elimination (partitioned views)

```sql
-- Each partition table must have a trusted CHECK constraint on the partition column
CREATE TABLE dbo.Orders_2023
(
    OrderId   INT  NOT NULL,
    OrderYear INT  NOT NULL CONSTRAINT ck_Orders_2023_Year CHECK (OrderYear = 2023),
    ...
    CONSTRAINT pk_Orders_2023 PRIMARY KEY (OrderId, OrderYear)
);

CREATE TABLE dbo.Orders_2024
(
    OrderId   INT  NOT NULL,
    OrderYear INT  NOT NULL CONSTRAINT ck_Orders_2024_Year CHECK (OrderYear = 2024),
    ...
    CONSTRAINT pk_Orders_2024 PRIMARY KEY (OrderId, OrderYear)
);

CREATE VIEW dbo.Orders AS
    SELECT * FROM dbo.Orders_2023
    UNION ALL
    SELECT * FROM dbo.Orders_2024;
-- WHERE OrderYear = 2023 will touch only Orders_2023
-- Requires constraints to be TRUSTED
```

---

## 12. Functional Constraints

### CHECK Constraints that Call Scalar UDFs

SQL Server allows a CHECK constraint to call a scalar UDF to express logic that cannot be written as a pure T-SQL expression:

```sql
CREATE FUNCTION dbo.fn_IsValidEmail(@email NVARCHAR(254))
RETURNS BIT
WITH SCHEMABINDING
AS
BEGIN
    RETURN CASE
        WHEN @email LIKE '%_@_%.__%'
         AND @email NOT LIKE '%[ ,;]%'
        THEN 1
        ELSE 0
    END;
END;
GO

ALTER TABLE dbo.Contact
    ADD CONSTRAINT ck_Contact_Email
        CHECK (dbo.fn_IsValidEmail(Email) = 1);
```

> [!WARNING] UDF CHECK constraints and parallelism
> A scalar UDF in a CHECK constraint is **never inlined** when used in constraint evaluation context — the optimizer treats it as a black box, forcing serial execution for any query that touches the constrained column during modification. Prefer pure T-SQL expressions. If the logic is complex enough to require a UDF, isolate it in a trigger so the UDF cost is paid only on writes, not on reads.

**Schema stability requirement:** The UDF must be created with `SCHEMABINDING` to prevent it from being dropped while bound to a constraint. Without `SCHEMABINDING`, the UDF can be dropped while the constraint still references it — the constraint then silently evaluates to UNKNOWN (allowing all values through) rather than raising an error.[^6]

### Computed Column Constraints

A computed column is an expression evaluated from other columns in the same row. It can be used as a constraint target (UNIQUE, PRIMARY KEY, index) when it is deterministic.

```sql
CREATE TABLE dbo.Product
(
    ProductId   INT             NOT NULL CONSTRAINT pk_Product PRIMARY KEY,
    ListPrice   MONEY           NOT NULL,
    Discount    DECIMAL(5,4)    NOT NULL,
    -- Persisted computed column: value stored, not recalculated on every read
    NetPrice    AS (ListPrice * (1 - Discount)) PERSISTED NOT NULL,
    -- Non-persisted: recalculated on every read (default)
    TaxAmount   AS (ListPrice * 0.20)
);
```

**Persisted vs non-persisted:**

| Property | Persisted | Non-Persisted |
|---|---|---|
| Storage | Occupies column storage | No storage cost |
| Read cost | Single column read | Recalculated each access |
| Can be indexed | Yes | No (must be persisted first) |
| Can be NOT NULL | Yes | No |
| Determinism requirement | Yes | Yes |

**Determinism requirement:** A computed column can only be persisted (and indexed) if every function in its expression is deterministic and precise. `GETDATE()`, `RAND()`, `NEWID()` are non-deterministic — columns using them cannot be persisted.

```sql
-- Check whether a computed column can be persisted
SELECT
    c.name,
    c.is_computed,
    c.is_persisted,
    cc.definition,
    COLUMNPROPERTY(c.object_id, c.name, 'IsDeterministic') AS is_deterministic
FROM sys.columns AS c
    JOIN sys.computed_columns AS cc
        ON cc.object_id = c.object_id AND cc.column_id = c.column_id
WHERE c.object_id = OBJECT_ID('dbo.Product');
```

### Indexed Computed Columns (SQL Server's Functional Index Equivalent)

SQL Server does not have Oracle-style function-based indexes (`CREATE INDEX ON t (UPPER(col))`). The equivalent pattern uses an indexed persisted computed column:

```sql
-- Goal: case-insensitive unique email lookup without full-table scan
ALTER TABLE dbo.Employee
    ADD EmailUpper AS (UPPER(Email)) PERSISTED;

CREATE UNIQUE INDEX uix_Employee_EmailUpper
    ON dbo.Employee (EmailUpper);
```

The optimizer will use `uix_Employee_EmailUpper` for queries with predicates like `WHERE UPPER(Email) = UPPER(@input)` — it recognizes that `UPPER(Email)` matches the computed column definition and substitutes the index.

**Requirements for indexing a computed column:**
1. Column must be `PERSISTED`
2. Expression must be deterministic and precise
3. Session options `ANSI_NULLS ON` and `QUOTED_IDENTIFIER ON` must be set at index-creation time (and will be required at query time for the optimizer to use the index)
4. The owning table must not have `ALLOW_ROW_LOCKS = OFF` or `ALLOW_PAGE_LOCKS = OFF`

**Example: indexing a JSON sub-path (SQL Server 2016+)**

```sql
ALTER TABLE dbo.Event
    ADD EventType AS (JSON_VALUE(Payload, '$.type')) PERSISTED;

CREATE INDEX ix_Event_EventType ON dbo.Event (EventType);

-- This seek uses the index:
SELECT * FROM dbo.Event WHERE JSON_VALUE(Payload, '$.type') = 'purchase';
```

> [!NOTE] SQL Server 2022
> `JSON_VALUE` became deterministic for persisted computed column purposes when used with a constant path literal, enabling the pattern above. Verify with `COLUMNPROPERTY(..., 'IsDeterministic')` after adding the column.

---

## 13. Cross-Table, Cross-Schema, and Cross-Database Constraints

### Cross-Table Constraints (within the same database)

Standard FOREIGN KEY constraints enforce referential integrity across tables in the same database. See [Section 7](#7-foreign-key-constraints-and-cascades) for full FK syntax and cascade options.

**Trigger-based referential integrity** is needed when FKs cannot express the required rule:

- **Polymorphic associations** — a child row can reference one of several parent tables based on a type discriminator column (FKs require a single referenced table)
- **Conditional references** — an FK should only be enforced when another column has a certain value
- **Self-referencing hierarchies** where the root node needs a sentinel value that would violate the FK

```sql
-- Polymorphic association: Attachment can belong to Order OR Invoice
CREATE TABLE dbo.Attachment
(
    AttachmentId    INT NOT NULL CONSTRAINT pk_Attachment PRIMARY KEY,
    OwnerType       CHAR(1) NOT NULL,   -- 'O' = Order, 'I' = Invoice
    OwnerId         INT NOT NULL,
    FilePath        NVARCHAR(500) NOT NULL
);

-- Cannot use FK here; enforce with a trigger
CREATE TRIGGER trg_Attachment_ValidateOwner
ON dbo.Attachment
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1 FROM inserted AS i
        WHERE i.OwnerType = 'O'
          AND NOT EXISTS (SELECT 1 FROM dbo.[Order] WHERE OrderId = i.OwnerId)
    )
    OR EXISTS (
        SELECT 1 FROM inserted AS i
        WHERE i.OwnerType = 'I'
          AND NOT EXISTS (SELECT 1 FROM dbo.Invoice WHERE InvoiceId = i.OwnerId)
    )
    BEGIN
        THROW 50010, 'Attachment.OwnerId does not exist in the referenced table.', 1;
    END;
END;
```

### Cross-Schema Constraints (within the same database)

FOREIGN KEY and CHECK constraints work across schemas within a single database. Use fully qualified `Schema.Table` references:

```sql
-- FK from billing schema to crm schema
ALTER TABLE billing.Invoice
    ADD CONSTRAINT fk_Invoice_Customer
        FOREIGN KEY (CustomerId)
        REFERENCES crm.Customer (CustomerId);

-- CHECK constraint referencing a schema-qualified UDF
ALTER TABLE billing.Invoice
    ADD CONSTRAINT ck_Invoice_Status
        CHECK (billing.fn_IsValidInvoiceStatus(Status) = 1);
```

**Schema ownership and permissions:** Creating a cross-schema FK requires:
- `ALTER` permission on the child table (the table being altered)
- `REFERENCES` permission on the referenced column(s) in the parent table (or the parent table itself)
- The referenced column must be a PK or UNIQUE constraint target

```sql
-- Grant REFERENCES on the parent table to allow FK creation
GRANT REFERENCES ON crm.Customer (CustomerId) TO BillingSchemaOwner;
```

### Cross-Database Constraints

> [!WARNING] No native cross-database FKs
> **SQL Server does not support cross-database FOREIGN KEY constraints.** `REFERENCES OtherDB.dbo.Table` is a syntax error at constraint-creation time. This is a hard platform limitation — there is no configuration to enable it.

**Workaround 1: AFTER trigger (most common)**

```sql
-- In SubscriptionDB: enforce that SubscriptionDB.dbo.Subscription.CustomerId
-- exists in CustomerDB.dbo.Customer
USE SubscriptionDB;
GO

CREATE TRIGGER trg_Subscription_ValidateCustomer
ON dbo.Subscription
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1 FROM inserted AS i
        WHERE NOT EXISTS (
            SELECT 1
            FROM CustomerDB.dbo.Customer AS c
            WHERE c.CustomerId = i.CustomerId
        )
    )
    BEGIN
        THROW 50020, 'CustomerId does not exist in CustomerDB.', 1;
    END;
END;
```

> [!WARNING] Cross-database trigger fragility
> If `CustomerDB` is offline, in single-user mode, or being restored, the trigger above will **fail on every insert/update** to `Subscription` — not silently allow the data through, but actively block writes. Design application retry logic and monitoring around this dependency. Also note: the trigger does NOT enforce referential integrity on deletes in `CustomerDB` — deleting a customer in `CustomerDB` does not cascade to `SubscriptionDB`.

**Workaround 2: Service Broker (async validation)**

Use Service Broker to send a validation message to the target database asynchronously. This is appropriate when:
- The cross-database dependency is best-effort (eventual consistency acceptable)
- Write throughput is a priority
- The target database is on a different server instance

The trade-off: validation is not immediate, so there is a window during which invalid data can exist in the child table.

**Workaround 3: Application-layer enforcement**

Enforce the constraint in the application's data access layer before issuing the INSERT/UPDATE. This is the simplest approach but:
- Bypassed by any direct SQL access (ad hoc queries, other apps, bulk loads)
- Requires read from both databases in the same application request
- Not visible to the query optimizer

**Workaround 4: CHECK constraint + linked server (validation only)**

```sql
-- Create a linked server pointing to CustomerDB (can be same instance, different DB)
-- Then use a UDF that queries via linked server:
CREATE FUNCTION dbo.fn_CustomerExists(@customerId INT)
RETURNS BIT
AS
BEGIN
    DECLARE @exists BIT = 0;
    IF EXISTS (
        SELECT 1
        FROM [LinkedServerName].[CustomerDB].dbo.Customer
        WHERE CustomerId = @customerId
    )
        SET @exists = 1;
    RETURN @exists;
END;
GO

ALTER TABLE dbo.Subscription
    ADD CONSTRAINT ck_Subscription_CustomerExists
        CHECK (dbo.fn_CustomerExists(CustomerId) = 1);
```

> [!WARNING] Linked server CHECK constraint limitations
> This validates on INSERT/UPDATE but **does not enforce on DELETE in the referenced database**. If a customer is deleted from `CustomerDB`, existing `Subscription` rows are not detected or cleaned up. Additionally, linked server failures cause every write to `Subscription` to fail. This pattern is fragile — prefer the trigger approach or application-layer enforcement for production use.

---

## 14. Gotchas / Anti-patterns

1. **Anonymous constraint names.** System-generated names like `UQ__Orders__3213E83F` differ between environments, making scripted drops and deployments brittle. Always supply explicit names.

2. **`WITH NOCHECK` leaves constraints untrusted.** Disabling and re-enabling with `WITH NOCHECK CHECK CONSTRAINT` is tempting for speed, but the optimizer silently stops using untrusted constraints for elimination. Run the untrusted-constraint query (Section 4) as part of post-load validation.

3. **Cascade cycles.** SQL Server raises an error at table creation time if it detects a cascade cycle. The error is sometimes unclear about which path is the problem — draw the FK graph and look for cycles including multi-hop paths.

4. **CHECK constraints are not evaluated on NULLs the way you expect.** `CHECK (UnitPrice > 0)` evaluates to UNKNOWN (not FALSE) when `UnitPrice IS NULL`, so NULL is allowed through. Add `UnitPrice IS NOT NULL` to the constraint or make the column NOT NULL.

5. **DEFAULT does not fire on explicit NULL.** `INSERT INTO t (col) VALUES (NULL)` bypasses the DEFAULT and stores NULL. The DEFAULT only fires when the column is omitted from the column list or the keyword `DEFAULT` is used.

6. **NEWID() in DEFAULT causes fragmentation.** Use `NEWSEQUENTIALID()` for GUID PKs. See Section 3.

7. **FK columns without an index.** SQL Server does not automatically create an index on the FK column in the child table (unlike MySQL InnoDB).[^4] Without an index, DELETE on the parent table causes a full scan of the child table. Add a nonclustered index on every FK column.

8. **TRUNCATE TABLE ignores FK constraints differently.** `TRUNCATE TABLE` is blocked if *any* FK references the table, even if those FK tables are empty.[^5] Use `DELETE` or disable FKs if you must truncate a referenced table.

9. **Disabling vs dropping constraints.** `ALTER TABLE ... NOCHECK CONSTRAINT` disables enforcement but keeps the constraint in metadata. `ALTER TABLE ... DROP CONSTRAINT` removes it. After a bulk load, re-enable with `WITH CHECK`. Dropping and re-creating is slower and loses the constraint name if you are not careful.

10. **`ON DELETE SET DEFAULT` trap.** If the FK column has no DEFAULT defined, `ON DELETE SET DEFAULT` will fail at runtime (not at constraint creation). Always verify the DEFAULT exists before using this cascade action.

11. **UDF-based CHECK constraints block parallelism.** Any non-inlineable scalar UDF in a CHECK constraint forces serial plan execution for queries that touch the constrained table during modification. The constraint evaluation calls the UDF row-by-row. If you need complex validation logic, use a trigger instead — the UDF cost is then isolated to write operations and does not affect read parallelism.

12. **Cross-database trigger workarounds silently break when the target database is offline.** If `CustomerDB` goes offline while a trigger in `SubscriptionDB` depends on it, every write to `Subscription` fails with a linked-database error. Plan for this: add error handling in the trigger (or a CATCH block) to log the failure and alert, rather than blocking all writes indefinitely.

13. **Computed column indexes require `ANSI_NULLS ON` and `QUOTED_IDENTIFIER ON`.** These session options must be `ON` when the computed column index is created, and the optimizer will not use the index for a query if these options are `OFF` in the connection's session. Many older ODBC and OLE DB drivers default these to `OFF`. Verify with `SELECT SESSIONPROPERTY('ANSI_NULLS'), SESSIONPROPERTY('QUOTED_IDENTIFIER')` before creating computed column indexes.

---

## 15. See Also

- [`references/01-syntax-ddl.md`](01-syntax-ddl.md) — `CREATE TABLE`, `ALTER TABLE` DDL syntax
- [`references/05-views.md`](05-views.md) — partitioned views using CHECK constraint partition elimination
- [`references/10-partitioning.md`](10-partitioning.md) — table partitioning and STATISTICS_INCREMENTAL
- [`references/11-custom-data-types.md`](11-custom-data-types.md) — alias types, table types, UDTs
- [`references/13-transactions-locking.md`](13-transactions-locking.md) — how FK checks interact with isolation levels and locking

---

## Sources

[^1]: [ALTER TABLE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) — documents adding NOT NULL columns with DEFAULT values as a metadata-only operation in SQL Server 2012 Enterprise and later
[^2]: [NEWSEQUENTIALID (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/newsequentialid-transact-sql) — documents that NEWSEQUENTIALID() can only be used in DEFAULT constraints on table columns, not in ad hoc queries
[^3]: [Disable Foreign Key Constraints with INSERT and UPDATE Statements - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/disable-foreign-key-constraints-with-insert-and-update-statements) — documents that trusted foreign keys allow the query optimizer to simplify execution plans (including join elimination) based on constraint assumptions; untrusted keys (is_not_trusted = 1) prevent these optimizations
[^4]: [Primary and foreign key constraints - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints) — explicitly states that creating a foreign key constraint does not automatically create a corresponding index on the FK column
[^5]: [TRUNCATE TABLE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/truncate-table-transact-sql) — documents that TRUNCATE TABLE cannot be used on tables referenced by a FOREIGN KEY constraint
[^6]: [CREATE FUNCTION (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-function-transact-sql) — documents that SCHEMABINDING prevents underlying objects from being modified or dropped while the function references them; without SCHEMABINDING, a UDF bound to a CHECK constraint can be dropped, leaving the constraint in an undefined evaluation state

# 01 — DDL Syntax Reference: CREATE, ALTER, DROP

> Covers SQL Server 2016 through 2025. Azure SQL Database and Azure SQL Managed Instance differences are called out explicitly.

## Table of Contents

- [Tables](#tables)
  - [CREATE TABLE](#create-table)
  - [Column Constraints Inline](#column-constraints-inline)
  - [Table Constraints](#table-constraints)
  - [ALTER TABLE](#alter-table)
  - [DROP TABLE](#drop-table)
- [Schemas](#schemas)
  - [CREATE SCHEMA](#create-schema)
  - [ALTER SCHEMA (Transfer Objects)](#alter-schema-transfer-objects)
  - [DROP SCHEMA](#drop-schema)
- [Sequences](#sequences)
  - [CREATE SEQUENCE](#create-sequence)
  - [NEXT VALUE FOR](#next-value-for)
  - [ALTER SEQUENCE](#alter-sequence)
  - [Sequence vs IDENTITY — When to Use Which](#sequence-vs-identity--when-to-use-which)
- [Synonyms](#synonyms)
  - [CREATE SYNONYM](#create-synonym)
  - [DROP SYNONYM](#drop-synonym)
  - [Synonym Gotchas](#synonym-gotchas)
- [IDENTITY vs SEQUENCE Comparison Table](#identity-vs-sequence-comparison-table)
- [Database-Level DDL](#database-level-ddl)
  - [CREATE DATABASE](#create-database)
  - [ALTER DATABASE](#alter-database)
- [Gotchas & Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

---

## Tables

### CREATE TABLE

```sql
-- Minimal table
CREATE TABLE dbo.Orders (
    OrderID   INT           NOT NULL,
    CustomerID INT          NOT NULL,
    OrderDate  DATETIME2(3) NOT NULL CONSTRAINT DF_Orders_OrderDate DEFAULT SYSUTCDATETIME(),
    Status     NVARCHAR(20) NOT NULL,
    TotalAmount DECIMAL(18,4) NULL,
    CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderID ASC)
);
```

**Name every constraint.** Unnamed constraints get system-generated names (e.g., `__c00000000_...`) that differ between environments, making schema comparisons and ALTER scripts painful.

```sql
-- Table with explicit filegroup, compression, and ROWGUIDCOL
CREATE TABLE dbo.Documents (
    DocumentID  UNIQUEIDENTIFIER NOT NULL ROWGUIDCOL
                    CONSTRAINT DF_Documents_ID DEFAULT NEWSEQUENTIALID(),
    Title       NVARCHAR(400)    NOT NULL,
    Body        NVARCHAR(MAX)    NULL,
    CreatedAt   DATETIME2(0)     NOT NULL CONSTRAINT DF_Documents_Created DEFAULT SYSUTCDATETIME(),
    RowVersion  ROWVERSION       NOT NULL,   -- auto-updated 8-byte binary; NOT NULL but never specified on INSERT
    CONSTRAINT PK_Documents PRIMARY KEY CLUSTERED (DocumentID)
) ON [PRIMARY]
  WITH (DATA_COMPRESSION = PAGE);
```

> [!NOTE] SQL Server 2022
> `DATA_COMPRESSION = XML` is available for XML columns — see `references/36-data-compression.md`.

### Column Constraints Inline

| Constraint | Syntax example |
|---|---|
| NOT NULL / NULL | `Qty INT NOT NULL` |
| DEFAULT | `Price DECIMAL(18,4) NOT NULL CONSTRAINT DF_T_Price DEFAULT 0` |
| CHECK | `Status NVARCHAR(20) NOT NULL CONSTRAINT CK_T_Status CHECK (Status IN ('Open','Closed','Pending'))` |
| UNIQUE | `Email NVARCHAR(254) NOT NULL CONSTRAINT UQ_Users_Email UNIQUE` |
| PRIMARY KEY | `ID INT NOT NULL CONSTRAINT PK_T PRIMARY KEY` |
| FOREIGN KEY (inline) | `CustID INT NOT NULL CONSTRAINT FK_Orders_Cust REFERENCES dbo.Customers(CustomerID)` |
| IDENTITY | `ID INT NOT NULL IDENTITY(1,1)` |

### Table Constraints

Specify table-level constraints when you need **composite keys or composite FKs**:

```sql
CREATE TABLE dbo.OrderItems (
    OrderID    INT NOT NULL,
    LineNumber  INT NOT NULL,
    ProductID   INT NOT NULL,
    Qty         INT NOT NULL CONSTRAINT CK_OrderItems_Qty CHECK (Qty > 0),
    UnitPrice   DECIMAL(18,4) NOT NULL,
    CONSTRAINT PK_OrderItems PRIMARY KEY CLUSTERED (OrderID, LineNumber),
    CONSTRAINT FK_OrderItems_Orders  FOREIGN KEY (OrderID)   REFERENCES dbo.Orders(OrderID)   ON DELETE CASCADE,
    CONSTRAINT FK_OrderItems_Product FOREIGN KEY (ProductID) REFERENCES dbo.Products(ProductID) ON DELETE NO ACTION
);
```

**ON DELETE / ON UPDATE options:**

| Option | Behaviour |
|---|---|
| `NO ACTION` (default) | Error if referencing rows exist |
| `CASCADE` | Propagates DELETE/UPDATE to child rows |
| `SET NULL` | Sets FK column(s) to NULL in child rows |
| `SET DEFAULT` | Sets FK column(s) to their DEFAULT in child rows |

> [!WARNING] Deprecated
> `SET DEFAULT` and `SET NULL` require the default/NULL value to satisfy any further constraints on the child column. Circular cascade paths (two tables that cascade to each other) raise error 1785 and are rejected. Use triggers if you truly need them — but avoid it.

### ALTER TABLE

```sql
-- Add a column (nullable columns are instantaneous on 2012+; NOT NULL with default also fast via metadata-only)
ALTER TABLE dbo.Orders ADD ShipDate DATETIME2(0) NULL;

-- Add NOT NULL column with a default — metadata-only since SQL Server 2012
ALTER TABLE dbo.Orders
    ADD IsArchived BIT NOT NULL CONSTRAINT DF_Orders_IsArchived DEFAULT 0;

-- Add a constraint
ALTER TABLE dbo.Orders
    ADD CONSTRAINT CK_Orders_Status CHECK (Status IN ('New','Processing','Shipped','Cancelled'));

-- Drop a constraint (must name it — always name constraints!)
ALTER TABLE dbo.Orders DROP CONSTRAINT CK_Orders_Status;

-- Alter a column type — rewrites the column; can be slow on large tables
ALTER TABLE dbo.Orders ALTER COLUMN Status NVARCHAR(30) NOT NULL;

-- Drop a column — marks column as dropped; space only reclaimed on heap rebuild or REORGANIZE
ALTER TABLE dbo.Orders DROP COLUMN ShipDate;

-- Enable / disable a constraint (NOCHECK skips existing rows; CHECK WITH CHECK validates all rows)
ALTER TABLE dbo.Orders NOCHECK CONSTRAINT FK_Orders_Cust;
ALTER TABLE dbo.Orders WITH CHECK CHECK CONSTRAINT FK_Orders_Cust;
```

> [!NOTE] SQL Server 2022
> `ALTER TABLE ... ALTER COLUMN` for changing `NULL` to `NOT NULL` is now a metadata-only operation when the column has no NULLs (previously always rewrote the table). [^1]

**Adding a NOT NULL column without a default** still requires a table rewrite on all versions — don't do it on large tables in production without a maintenance window or an online operation strategy (stage as nullable → backfill → add constraint → make NOT NULL).

### DROP TABLE

```sql
-- Safe drop pattern
IF OBJECT_ID(N'dbo.Orders', N'U') IS NOT NULL
    DROP TABLE dbo.Orders;

-- SQL Server 2016+ preferred syntax
DROP TABLE IF EXISTS dbo.Orders;

-- Drop multiple tables in one statement (2016+)
DROP TABLE IF EXISTS dbo.OrderItems, dbo.Orders;   -- drop child before parent (FK order matters)
```

---

## Schemas

Schemas are the primary namespace-isolation mechanism. **Default schema = `dbo`** unless changed for a user.

### CREATE SCHEMA

```sql
-- Schema ownership defaults to the issuing user or can be specified
CREATE SCHEMA sales AUTHORIZATION dbo;
CREATE SCHEMA reporting AUTHORIZATION dbo;

-- Create table in that schema immediately inside the same batch
-- (CREATE SCHEMA must be the only statement in the batch or use a workaround)
-- Pattern: create schema first, then create objects in subsequent batches.
```

> [!WARNING] Deprecated
> `CREATE SCHEMA ... CREATE TABLE ...` inline syntax (creating objects inside the CREATE SCHEMA statement) still compiles but is confusing and non-standard. Create objects separately after the schema exists.

### ALTER SCHEMA (Transfer Objects)

```sql
-- Move a table from dbo to reporting schema
ALTER SCHEMA reporting TRANSFER dbo.SalesSummary;

-- Move a procedure
ALTER SCHEMA sales TRANSFER dbo.usp_PlaceOrder;
```

Transferring an object **does not** update four-part names or EXECUTE permission assignments referencing the old schema — update those manually.

### DROP SCHEMA

```sql
DROP SCHEMA IF EXISTS reporting;   -- fails if schema still contains objects
```

---

## Sequences

Sequences are **schema-bound number generators** independent of any table — unlike IDENTITY which is tied to a single column.

### CREATE SEQUENCE

```sql
-- Basic integer sequence
CREATE SEQUENCE dbo.OrderNumberSeq
    AS INT
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    MAXVALUE 2147483647
    CYCLE        -- wraps around; omit NO CYCLE for strict monotonic
    CACHE 50;    -- pre-allocates 50 values in memory; survives restarts with a gap of up to 50

-- Globally unique order number with prefix room (use BIGINT for safety)
CREATE SEQUENCE dbo.InvoiceSeq
    AS BIGINT
    START WITH 100000
    INCREMENT BY 1
    NO CYCLE
    CACHE 20;
```

**CACHE vs NO CACHE:** `CACHE N` reduces latch contention on high-throughput inserts by only persisting every Nth value to the system catalog. After a server restart you may skip up to `N` values. `NO CACHE` writes every allocation to disk — high contention on busy sequences.

### NEXT VALUE FOR

```sql
-- Get next value
DECLARE @next BIGINT = NEXT VALUE FOR dbo.InvoiceSeq;

-- Use in INSERT
INSERT INTO dbo.Invoices (InvoiceID, CustomerID, InvoiceDate)
VALUES (NEXT VALUE FOR dbo.InvoiceSeq, 42, SYSUTCDATETIME());

-- Use in DEFAULT constraint
ALTER TABLE dbo.Invoices
    ADD CONSTRAINT DF_Invoices_ID DEFAULT (NEXT VALUE FOR dbo.InvoiceSeq) FOR InvoiceID;

-- Generate a range atomically (sp_sequence_get_range)
DECLARE @first SQL_VARIANT, @last SQL_VARIANT, @count BIGINT = 100;
EXEC sys.sp_sequence_get_range
    @sequence_name     = N'dbo.InvoiceSeq',
    @range_size        = @count,
    @range_first_value = @first OUTPUT,
    @range_last_value  = @last  OUTPUT;
-- Use @first through @last for batch inserts
```

### ALTER SEQUENCE

```sql
-- Restart sequence (useful in test environments)
ALTER SEQUENCE dbo.OrderNumberSeq RESTART WITH 1;

-- Change cache size
ALTER SEQUENCE dbo.OrderNumberSeq CACHE 100;

-- Extend max value
ALTER SEQUENCE dbo.OrderNumberSeq MAXVALUE 9999999999;
```

### Sequence vs IDENTITY — When to Use Which

| Scenario | Use |
|---|---|
| Simple auto-increment PK on one table | `IDENTITY` — simpler, less overhead |
| Same sequence shared across multiple tables | `SEQUENCE` — single counter, no conflicts |
| Need the value **before** the INSERT (e.g. to set FK in child rows) | `SEQUENCE` — call `NEXT VALUE FOR` then INSERT |
| Batch allocation (1 call → N contiguous values) | `SEQUENCE` via `sp_sequence_get_range` |
| Need to reset in tests without truncating the table | `SEQUENCE` with `RESTART WITH` |
| Replication (IDENTITY can conflict on merge) | `SEQUENCE` with node-partitioned ranges |

---

## Synonyms

A synonym is an alias for any database object — table, view, procedure, function, or even objects on linked servers. Synonyms add an **indirection layer** that lets you rename or relocate objects without changing application code.

### CREATE SYNONYM

```sql
-- Alias a table in another database (cross-database without four-part names in queries)
CREATE SYNONYM dbo.ArchivedOrders FOR ArchiveDB.dbo.Orders;

-- Alias a linked-server table
CREATE SYNONYM dbo.RemoteInventory FOR [LinkedSrv].[WarehouseDB].[dbo].[Inventory];

-- Alias a procedure to hide the schema
CREATE SYNONYM dbo.GetCustomer FOR dbo.usp_GetCustomerByID;
```

Synonyms are **schema-bound by name only** — SQL Server does not verify the target exists at creation time. A missing target only errors at query time.

### DROP SYNONYM

```sql
DROP SYNONYM IF EXISTS dbo.ArchivedOrders;
```

### Synonym Gotchas

- **No column metadata.** Tools like SSMS, SSDT, and IntelliSense cannot resolve synonym columns without executing the query.
- **Statistics.** The optimizer cannot use statistics on the underlying table through a synonym in older versions — always test plans.
- **Permissions.** GRANT on the synonym does not propagate to the underlying object; you must grant on both.
- **DDL events.** `DROP TABLE` on the underlying object does **not** automatically drop the synonym.
- **SCHEMABINDING not supported.** Views or functions that reference a synonym cannot be schema-bound.

---

## IDENTITY vs SEQUENCE Comparison Table

| Feature | `IDENTITY` | `SEQUENCE` |
|---|---|---|
| Scope | Single column in one table | Schema object, any number of tables |
| Pre-insert value retrieval | Not possible (use `SCOPE_IDENTITY()` after) | `NEXT VALUE FOR` before insert |
| Batch allocation | Not possible | `sp_sequence_get_range` |
| Restart without truncate | Not possible | `ALTER SEQUENCE RESTART WITH` |
| Cycle support | No | `CYCLE` option |
| Replication-safe by design | No (IDENTITY conflict on merge) | Yes (partition ranges) |
| Overhead | Minimal | Slightly higher (catalog update every CACHE values) |
| Reset portability | `DBCC CHECKIDENT` | `ALTER SEQUENCE` |

---

## Database-Level DDL

### CREATE DATABASE

```sql
-- Minimal
CREATE DATABASE SalesApp;

-- Full specification
CREATE DATABASE SalesApp
ON PRIMARY (
    NAME = SalesApp_data,
    FILENAME = 'D:\MSSQL\DATA\SalesApp.mdf',
    SIZE = 256MB,
    MAXSIZE = UNLIMITED,
    FILEGROWTH = 64MB
),
FILEGROUP SalesApp_readonly READ_ONLY (
    NAME = SalesApp_ro,
    FILENAME = 'E:\MSSQL\RO\SalesApp_ro.ndf',
    SIZE = 64MB
)
LOG ON (
    NAME = SalesApp_log,
    FILENAME = 'L:\MSSQL\LOG\SalesApp.ldf',
    SIZE = 64MB,
    MAXSIZE = 4GB,
    FILEGROWTH = 64MB
)
COLLATE Latin1_General_CI_AS;
```

> [!NOTE] SQL Server 2022
> `CREATE DATABASE` now supports the `CONTAINED = PARTIAL` option for contained databases natively (no sp_configure needed; the feature was already available but the contained AG 2022 enhancement makes this more prominent). See `references/53-migration-compatibility.md`.

### ALTER DATABASE

```sql
-- Change recovery model
ALTER DATABASE SalesApp SET RECOVERY FULL;

-- Enable Read-Committed Snapshot Isolation (RCSI) — reduces blocking
-- Requires brief SCH-M lock; users are briefly disconnected on busy systems
ALTER DATABASE SalesApp SET READ_COMMITTED_SNAPSHOT ON;

-- Set compatibility level
ALTER DATABASE SalesApp SET COMPATIBILITY_LEVEL = 160;  -- SQL Server 2022

-- Enable Query Store
ALTER DATABASE SalesApp SET QUERY_STORE = ON (
    OPERATION_MODE = READ_WRITE,
    MAX_STORAGE_SIZE_MB = 1000,
    QUERY_CAPTURE_MODE = AUTO
);

-- Add a secondary filegroup and file
ALTER DATABASE SalesApp
ADD FILEGROUP SalesApp_archive;

ALTER DATABASE SalesApp
ADD FILE (
    NAME = SalesApp_archive_1,
    FILENAME = 'D:\MSSQL\ARCHIVE\SalesApp_ar1.ndf',
    SIZE = 512MB,
    FILEGROWTH = 256MB
) TO FILEGROUP SalesApp_archive;

-- Rename database (requires exclusive access)
ALTER DATABASE SalesApp MODIFY NAME = SalesApp_v2;
```

---

## Gotchas & Anti-patterns

### 1. Unnamed constraints multiply chaos

```sql
-- BAD — system-generated name
ALTER TABLE dbo.Orders ADD TaxRate DECIMAL(5,2) NOT NULL DEFAULT 0;

-- GOOD — named
ALTER TABLE dbo.Orders ADD TaxRate DECIMAL(5,2) NOT NULL
    CONSTRAINT DF_Orders_TaxRate DEFAULT 0;
```

### 2. NEWID() as a clustered PK key causes fragmentation

`UNIQUEIDENTIFIER` with `NEWID()` as a clustered PK produces ~99% logical fragmentation. Use `NEWSEQUENTIALID()` (SQL Server 2005+) for clustered keys, or use an `INT IDENTITY` with a separate `UNIQUEIDENTIFIER` column for external use.

```sql
-- BAD
ID UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY CLUSTERED

-- GOOD
ID UNIQUEIDENTIFIER NOT NULL ROWGUIDCOL DEFAULT NEWSEQUENTIALID() PRIMARY KEY CLUSTERED
-- OR better: INT IDENTITY PK (clustered) + UNIQUEIDENTIFIER (nonclustered UNIQUE) for external reference
```

### 3. Wide clustered indexes waste page space

Every nonclustered index includes the clustered index key as the row locator. An 8-byte `BIGINT` PK wastes far less than a 16-byte GUID or a multi-column composite clustered key — see `references/08-indexes.md` for the full analysis.

### 4. DROP TABLE vs TRUNCATE for DEV resets

`DROP TABLE IF EXISTS` removes all dependent objects (constraints, triggers, statistics). `TRUNCATE TABLE` is faster for clearing data — it's minimally logged and resets `IDENTITY`. Use the right tool:

```sql
-- Dev: clear data fast
TRUNCATE TABLE dbo.StagingLoad;

-- Dev: rebuild schema from scratch
DROP TABLE IF EXISTS dbo.StagingLoad;
CREATE TABLE dbo.StagingLoad ( ... );
```

### 5. ALTER COLUMN rewrites on large tables

`ALTER COLUMN` to change data type, precision, or NULL-ability (with exceptions noted above) locks the table and rewrites all rows. For tables > a few GB, use the **expand-copy-swap** pattern:

1. Add a new nullable column with the new type.
2. Backfill in batches.
3. Add a NOT NULL constraint with `WITH NOCHECK` first, then `WITH CHECK CHECK` to validate.
4. Rename old column, rename new column. (Two `sp_rename` calls — brief schema lock only.)

### 6. Schema transfer breaks cached plans

After `ALTER SCHEMA ... TRANSFER`, stored procedures that reference the old name keep failing until their plans are recompiled. Run `EXEC sp_recompile 'schema.objectname'` or `DBCC FREEPROCCACHE` (avoid on production — too broad; use `sys.dm_exec_cached_plans` to target specific plans).

### 7. Sequence CACHE gaps on restart

If the server crashes while 50 values are cached (e.g., cache = 50, last persisted = 1000, current runtime = 1037), next values after restart start at 1051 — gaps of up to 50. This is expected behavior. If gap-free sequences are a business requirement, use `NO CACHE` (and accept the latch contention) or IDENTITY.

---

## See Also

- [`references/08-indexes.md`](08-indexes.md) — clustered vs nonclustered, wide key gotchas
- [`references/10-partitioning.md`](10-partitioning.md) — partition functions and schemes (CREATE PARTITION FUNCTION)
- [`references/12-custom-defaults-rules.md`](12-custom-defaults-rules.md) — CHECK, DEFAULT, UNIQUE patterns
- [`references/13-transactions-locking.md`](13-transactions-locking.md) — ALTER TABLE lock behavior
- [`references/17-temporal-tables.md`](17-temporal-tables.md) — system-versioned temporal table DDL
- [`references/53-migration-compatibility.md`](53-migration-compatibility.md) — compatibility levels and deprecated DDL

---

## Sources

[^1]: [ALTER TABLE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) — covers metadata-only NOT NULL column change behavior introduced in SQL Server 2022, online ADD NOT NULL column operations, and all ALTER TABLE syntax options

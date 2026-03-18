# 26 — Collation

## Table of Contents

1. [When to Use This Reference](#1-when-to-use-this-reference)
2. [Collation Concepts](#2-collation-concepts)
3. [Collation Naming Conventions](#3-collation-naming-conventions)
4. [Sensitivity Attributes](#4-sensitivity-attributes)
5. [Collation Levels](#5-collation-levels)
6. [Choosing a Collation](#6-choosing-a-collation)
7. [COLLATE Clause in Queries](#7-collate-clause-in-queries)
8. [JOIN Conflicts Between Databases](#8-join-conflicts-between-databases)
9. [Temp Table Collation Mismatch](#9-temp-table-collation-mismatch)
10. [Changing Database Collation](#10-changing-database-collation)
11. [Azure SQL Collation Defaults](#11-azure-sql-collation-defaults)
12. [Collation and Indexes](#12-collation-and-indexes)
13. [Metadata Queries](#13-metadata-queries)
14. [Gotchas / Anti-Patterns](#14-gotchas--anti-patterns)
15. [See Also](#15-see-also)
16. [Sources](#sources)

---

## 1. When to Use This Reference

Load this file when the user asks about:

- Case-insensitive or case-sensitive comparisons
- `Collation conflict` errors on JOINs or `UNION`
- Sorting differences between environments (dev vs prod, Azure vs on-prem)
- Accent sensitivity, kana sensitivity, width sensitivity
- Temp table collation bugs (`#temp` table column defaults to `tempdb` collation)
- Changing a database's default collation after creation
- Collation of system databases (`master`, `model`, `tempdb`)
- `COLLATE DATABASE_DEFAULT` pattern
- `_BIN` vs `_BIN2` collations for Always Encrypted or binary sort
- UTF-8 collations (SQL Server 2019+)

---

## 2. Collation Concepts

A **collation** defines:

| Aspect | Meaning |
|---|---|
| **Character repertoire** | Which characters are supported (e.g., Latin, Unicode) |
| **Code page** | For non-Unicode (`char`/`varchar`), the 8-bit encoding used |
| **Sort order** | Dictionary, binary, or binary-2 |
| **Comparison rules** | Case, accent, kana, width, variation-selector sensitivity |

Collation applies to:
- `char`, `varchar` — single-byte, code-page-dependent
- `nchar`, `nvarchar` — Unicode (UCS-2 / UTF-16); collation controls sort/compare, not storage
- `text`, `ntext` — deprecated; inherit column collation

Collation does **not** apply to `int`, `datetime`, or other non-character types.

---

## 3. Collation Naming Conventions

```
SQL_Latin1_General_CP1_CI_AS
│   │             │    │  │
│   │             │    │  └── AS = Accent Sensitive
│   │             │    └───── CI = Case Insensitive
│   │             └────────── CP1 = Code Page 1252
│   └──────────────────────── Latin1_General = locale/language
└──────────────────────────── SQL_ prefix = SQL Server legacy collation
```

### Windows vs SQL Server collations

| Prefix | Type | Notes |
|---|---|---|
| `SQL_` | SQL Server legacy | Older sort rules; different from Windows OS sort; avoid for new objects |
| *(no prefix)* | Windows collation | Aligns with Windows NLS; recommended for most use cases |

**Prefer Windows collations** (e.g., `Latin1_General_CI_AS`) over `SQL_` collations for new databases. SQL legacy collations sort `char`/`varchar` differently from `nchar`/`nvarchar`, which causes subtle JOIN inconsistencies.

### Common collations quick reference

| Collation | CI/CS | AI/AS | Notes |
|---|---|---|---|
| `SQL_Latin1_General_CP1_CI_AS` | CI | AS | SQL Server install default (US); legacy |
| `Latin1_General_CI_AS` | CI | AS | Windows equivalent; preferred |
| `Latin1_General_CS_AS` | CS | AS | Case-sensitive variant |
| `Latin1_General_CI_AI` | CI | AI | Case and accent insensitive |
| `Latin1_General_BIN` | N/A | N/A | Binary sort (deprecated in favor of BIN2) |
| `Latin1_General_BIN2` | N/A | N/A | Byte-by-byte Unicode code point sort; required for Always Encrypted deterministic |
| `Latin1_General_100_CI_AS_SC` | CI | AS | Supplementary characters support (SC) |
| `Latin1_General_100_CI_AS_SC_UTF8` | CI | AS | UTF-8 storage (2019+) |
| `Japanese_CI_AS` | CI | AS | Japanese locale; kana insensitive by default |
| `Japanese_CS_AS_KS_WS` | CS | AS | Kana and width sensitive |

> [!NOTE] SQL Server 2019
> UTF-8 collations (`_UTF8` suffix) allow `varchar`/`char` to store full Unicode using UTF-8 encoding. This reduces storage for ASCII-heavy data compared to `nvarchar`. Requires SQL Server 2019+. [^6]

---

## 4. Sensitivity Attributes

| Suffix | Attribute | Meaning |
|---|---|---|
| `_CI` | Case Insensitive | `'A' = 'a'` |
| `_CS` | Case Sensitive | `'A' <> 'a'` |
| `_AI` | Accent Insensitive | `'e' = 'é'` |
| `_AS` | Accent Sensitive | `'e' <> 'é'` |
| `_KI` | Kana Insensitive | Hiragana = Katakana |
| `_KS` | Kana Sensitive | Hiragana ≠ Katakana |
| `_WI` | Width Insensitive | Half-width = Full-width (Japanese) |
| `_WS` | Width Sensitive | Half-width ≠ Full-width |
| `_VSI` | Variation Selector Insensitive | Base char = char + variation selector |
| `_VSS` | Variation Selector Sensitive | (2017+ for Japanese collations) |
| `_SC` | Supplementary Characters | Surrogate pair support (emoji, rare Unicode) |
| `_BIN` | Binary sort | Legacy byte-by-byte per char; use BIN2 instead |
| `_BIN2` | Binary-2 sort | Byte-by-byte on code point; deterministic, fastest comparison |
| `_UTF8` | UTF-8 encoding | `varchar`/`char` stored as UTF-8 (2019+) |

### Checking what a collation supports

```sql
-- All collations and their properties
SELECT  name,
        description,
        COLLATIONPROPERTY(name, 'CodePage')       AS code_page,
        COLLATIONPROPERTY(name, 'LCID')           AS lcid,
        COLLATIONPROPERTY(name, 'ComparisonStyle') AS comparison_style
FROM    sys.fn_helpcollations()
WHERE   name LIKE 'Latin1%'
ORDER BY name;

-- Check a specific collation's properties
SELECT  COLLATIONPROPERTY('Latin1_General_CI_AS', 'CodePage')        AS code_page,   -- 1252
        COLLATIONPROPERTY('Latin1_General_CI_AS', 'LCID')            AS lcid,        -- 1033
        COLLATIONPROPERTY('Latin1_General_CI_AS', 'ComparisonStyle') AS style;       -- 196609
```

---

## 5. Collation Levels

Collation is applied and inherited in a hierarchy:

```
Server (instance default)
  └── Database (default for new objects)
        └── Column (explicit or inherited from database)
              └── Expression (COLLATE clause overrides)
```

### Server collation

Set at install time. Controls:
- System database (`master`, `model`, `tempdb`) collations
- System object name comparisons
- The collation of `#temp` table columns that inherit from `tempdb`

```sql
-- Check server collation
SELECT SERVERPROPERTY('Collation') AS server_collation;
```

> [!WARNING] Changing server collation post-install is complex and risky — requires rebuilding system databases. Avoid if at all possible.

### Database collation

Controls the default collation for new columns and the collation of `varchar`/`nvarchar` literals in queries against that database.

```sql
-- Check database collation
SELECT name, collation_name
FROM   sys.databases
WHERE  name = DB_NAME();

-- Set at create time
CREATE DATABASE Inventory
    COLLATE Latin1_General_CI_AS;

-- Change existing (see Section 10 for full workflow)
ALTER DATABASE Inventory
    COLLATE Latin1_General_CS_AS;
```

### Column collation

Overrides the database default for a specific column.

```sql
CREATE TABLE dbo.Products (
    ProductID   int           NOT NULL PRIMARY KEY,
    ProductCode varchar(20)   COLLATE Latin1_General_CS_AS NOT NULL,  -- case-sensitive SKU
    ProductName nvarchar(200) NOT NULL                                 -- inherits DB collation
);

-- Add column with explicit collation
ALTER TABLE dbo.Products
ADD InternalRef varchar(10) COLLATE Latin1_General_BIN2 NOT NULL
    DEFAULT '';
```

---

## 6. Choosing a Collation

### General guidance

| Scenario | Recommended collation | Reason |
|---|---|---|
| US English, case-insensitive (most common) | `Latin1_General_CI_AS` | Windows collation, predictable |
| Case-sensitive login names / codes | `Latin1_General_CS_AS` or `_BIN2` | Strict equality |
| Always Encrypted deterministic | `Latin1_General_BIN2` | Required by AE |
| Multi-language (Western European) | `Latin1_General_100_CI_AS_SC` | SC for emoji/supplementary chars |
| Japanese text | `Japanese_CI_AS` | Correct kana/width defaults |
| UTF-8 storage optimization (2019+) | `Latin1_General_100_CI_AS_SC_UTF8` | Saves storage for ASCII-heavy Unicode |
| Legacy SQL Server default (do not use for new DBs) | `SQL_Latin1_General_CP1_CI_AS` | Only keep for compatibility |

### Avoid `_BIN` (legacy binary)

`_BIN` applies binary sort only to the last character of each `varchar` value; the preceding characters use a dictionary sort. This is confusing and not truly binary. Always use `_BIN2` when you need binary-order comparison.

---

## 7. COLLATE Clause in Queries

Override the collation at expression or column level in any query:

```sql
-- Make a CI column comparison CS for this query only
SELECT *
FROM   dbo.Users
WHERE  Username = 'Admin' COLLATE Latin1_General_CS_AS;

-- Case-insensitive search on a CS column
SELECT *
FROM   dbo.Products
WHERE  ProductCode = 'ABC-001' COLLATE Latin1_General_CI_AS;

-- Accent-insensitive search
SELECT *
FROM   dbo.Customers
WHERE  LastName = 'Müller' COLLATE Latin1_General_CI_AI;
```

### COLLATE in ORDER BY

```sql
-- Sort by collation different from column's collation
SELECT ProductName
FROM   dbo.Products
ORDER BY ProductName COLLATE Latin1_General_CS_AS;
```

### COLLATE DATABASE_DEFAULT

When you need a column or expression to use the **current database's collation** dynamically (e.g., in a stored proc that might run in different databases):

```sql
-- Safe cross-database temp table comparison (see Section 9)
SELECT t.Name
FROM   #TempResults t
JOIN   dbo.Reference r
    ON t.Name COLLATE DATABASE_DEFAULT = r.Name;
```

---

## 8. JOIN Conflicts Between Databases

When joining columns from two databases with different collations, SQL Server raises:

```
Msg 468, Level 16: Cannot resolve the collation conflict between
"Latin1_General_CS_AS" and "Latin1_General_CI_AS" in the equal to operation.
```

### Fix: explicit COLLATE on one side

```sql
-- Join across databases with different collations
SELECT  a.CustomerID,
        b.OrderID
FROM    DBa.dbo.Customers a
JOIN    DBb.dbo.Orders    b
    ON  a.CustomerCode = b.CustomerCode COLLATE Latin1_General_CI_AS;
```

Apply the `COLLATE` clause to the side with the **less restrictive** collation, or pick a shared target collation. Applying it to the right-hand side is conventional but either works.

> [!WARNING]
> Adding `COLLATE` in a `JOIN` predicate can prevent index seeks on the collated expression — the optimizer may not be able to use an index whose key was built with a different collation. Test execution plans after adding explicit collation.

### UNION across databases

```sql
-- Fix UNION collation conflict
SELECT Name COLLATE Latin1_General_CI_AS FROM DBa.dbo.People
UNION ALL
SELECT Name COLLATE Latin1_General_CI_AS FROM DBb.dbo.People;
```

---

## 9. Temp Table Collation Mismatch

This is one of the most common collation bugs in production code.

### The problem

Columns in `#temp` tables without explicit `COLLATE` inherit the **server collation** (via `tempdb`). If your database collation differs from the server collation, comparisons silently change behavior or raise errors.

```sql
-- tempdb collation: SQL_Latin1_General_CP1_CI_AS  (server default)
-- UserDB collation: Latin1_General_CS_AS           (explicitly set)

CREATE TABLE #Results (Name varchar(100));          -- inherits tempdb/server CI_AS
INSERT #Results SELECT Name FROM dbo.Users;

-- This comparison is CS because dbo.Users.Name is CS,
-- but #Results.Name is CI — may silently return wrong results
SELECT * FROM #Results WHERE Name = 'admin';
```

### Fix: always declare explicit collations on temp table string columns, or use `DATABASE_DEFAULT`

```sql
-- Option A: explicit collation matching your database
CREATE TABLE #Results (
    Name varchar(100) COLLATE Latin1_General_CS_AS NOT NULL
);

-- Option B: COLLATE DATABASE_DEFAULT — resolves to the
--           database that executes the CREATE TABLE statement
CREATE TABLE #Results (
    Name varchar(100) COLLATE DATABASE_DEFAULT NOT NULL
);
```

> [!NOTE]
> `COLLATE DATABASE_DEFAULT` is the safest portable option — it resolves to whatever the current database's collation is at execution time, avoiding hard-coded collation names.

### Table variables

Table variables are created in the user's database context (not `tempdb`), so they inherit the **database collation** by default. The mismatch problem is less common with table variables, but explicit collation is still good practice.

---

## 10. Changing Database Collation

`ALTER DATABASE ... COLLATE` changes the **default collation** for new objects, but does **not** change existing columns.

```sql
-- Step 1: change the database default
ALTER DATABASE Inventory
    COLLATE Latin1_General_CI_AS;

-- Step 2 (manual): rebuild existing varchar/nvarchar columns
-- For each column that should use the new collation:
ALTER TABLE dbo.Products
ALTER COLUMN ProductName nvarchar(200) COLLATE Latin1_General_CI_AS NOT NULL;
```

### Checklist for changing existing column collation

1. Script all indexes and constraints on the column (they'll be dropped implicitly)
2. Drop non-clustered indexes and constraints on the column
3. `ALTER TABLE ... ALTER COLUMN ... COLLATE <new>`
4. Re-create indexes and constraints
5. Check for dependent views, computed columns, and schema-bound objects — these must be dropped and re-created

```sql
-- Find all varchar/nvarchar columns not using the new target collation
SELECT  OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
        OBJECT_NAME(c.object_id)        AS table_name,
        c.name                          AS column_name,
        c.collation_name
FROM    sys.columns c
WHERE   c.collation_name IS NOT NULL            -- only character columns
  AND   c.collation_name <> 'Latin1_General_CI_AS'
  AND   OBJECTPROPERTY(c.object_id, 'IsUserTable') = 1
ORDER BY schema_name, table_name, column_name;
```

> [!WARNING]
> Changing column collation is an **offline schema change** — it rebuilds the column in the table. On large tables, plan for a maintenance window or use online schema change tools (e.g., `sp_rename`-swap approach).

---

## 11. Azure SQL Collation Defaults

| Scenario | Default collation | Notes |
|---|---|---|
| New Azure SQL Database (Portal) | `SQL_Latin1_General_CP1_CI_AS` | Same as on-prem install default |
| Serverless database | Same as elastic pool / template | Inherited |
| Contained database (recommended) | Set explicitly at CREATE time | Cannot be changed after creation |
| Azure SQL Managed Instance | Set at instance creation | Cannot be changed post-creation |

> [!NOTE] Azure SQL
> For Azure SQL Database, the collation can be set when creating the database with `CREATE DATABASE ... COLLATE`. After creation, `ALTER DATABASE ... COLLATE` is **not supported** for user databases on Azure SQL Database (Hyperscale and others). Plan the collation before provisioning.

```sql
-- Azure SQL: set collation at create time
CREATE DATABASE MyAppDB
    COLLATE Latin1_General_100_CI_AS_SC;
```

For **Azure SQL Managed Instance**, the instance-level collation is set at provisioning and cannot be changed. Individual database collations can differ from the instance collation.

---

## 12. Collation and Indexes

### Index keys and collation

An index on a character column is built using that column's collation. If you apply `COLLATE` in a query predicate to override the column's collation, SQL Server **cannot use the index** for a seek — the index was built with different comparison semantics.

```sql
-- Index on ProductCode is Latin1_General_CS_AS
-- This CANNOT use the index as a seek:
SELECT * FROM dbo.Products
WHERE  ProductCode = 'abc-001' COLLATE Latin1_General_CI_AS;
-- Results in an Index Scan (or Table Scan) — must compare every row

-- This CAN use the index:
SELECT * FROM dbo.Products
WHERE  ProductCode = 'abc-001';  -- uses column's native collation
```

### Computed columns and collation

A computed column expression inherits the collation of its inputs. If you want to index a computed column that involves a `COLLATE` override, the expression must be deterministic *and* the `COLLATE` must be to the same or a compatible collation.

```sql
-- Create computed column for case-insensitive lookup on CS column
ALTER TABLE dbo.Products
ADD ProductCodeCI AS (ProductCode COLLATE Latin1_General_CI_AS) PERSISTED;

CREATE INDEX IX_Products_CodeCI ON dbo.Products (ProductCodeCI);

-- Now this can use the index:
SELECT * FROM dbo.Products
WHERE  ProductCodeCI = 'abc-001';  -- matches computed column expression
```

### Filtered indexes and collation

Filtered index `WHERE` predicates use the column's collation. A predicate like `WHERE Status = 'active'` on a CS column will only filter `'active'` (not `'Active'`).

---

## 13. Metadata Queries

```sql
-- Server collation
SELECT SERVERPROPERTY('Collation') AS server_collation;

-- All database collations
SELECT  name,
        collation_name,
        compatibility_level
FROM    sys.databases
ORDER BY name;

-- All character columns and their collations in current database
SELECT  OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
        OBJECT_NAME(c.object_id)        AS table_name,
        c.name                          AS column_name,
        c.collation_name,
        t.name                          AS data_type,
        c.max_length
FROM    sys.columns c
JOIN    sys.types   t ON t.system_type_id = c.system_type_id
                      AND t.user_type_id  = c.system_type_id  -- exclude UDTs here; adjust if needed
WHERE   c.collation_name IS NOT NULL
ORDER BY schema_name, table_name, column_name;

-- Find columns with non-default collation
DECLARE @db_collation sysname = CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS sysname);
SELECT  OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
        OBJECT_NAME(c.object_id)        AS table_name,
        c.name                          AS column_name,
        c.collation_name
FROM    sys.columns c
WHERE   c.collation_name IS NOT NULL
  AND   c.collation_name <> @db_collation
  AND   OBJECTPROPERTY(c.object_id, 'IsUserTable') = 1
ORDER BY schema_name, table_name;

-- Find all collation names available on this instance
SELECT  name,
        description
FROM    sys.fn_helpcollations()
ORDER BY name;

-- tempdb collation (source of temp table inheritance)
SELECT collation_name FROM sys.databases WHERE name = 'tempdb';

-- Check current database's collation
SELECT DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS current_db_collation;
```

---

## 14. Gotchas / Anti-Patterns

### 1. `SQL_Latin1_General_CP1_CI_AS` mismatch with `Latin1_General_CI_AS`

These two collations look equivalent but sort `varchar` data differently for characters outside ASCII. They **will** cause `Msg 468` collation conflicts when joining. Pick one and stick with it. Prefer the Windows collation (no `SQL_` prefix) for new databases.

### 2. Temp table string columns inherit `tempdb` collation

See Section 9. Always use `COLLATE DATABASE_DEFAULT` or an explicit collation on `#temp` table string columns. Failing to do so is a common source of hard-to-diagnose bugs, especially after restoring to a different server.

### 3. COLLATE in JOIN predicate kills index seeks

Applying `COLLATE` to a column reference in a `WHERE` or `JOIN` prevents the optimizer from using indexes built on that column. Use computed + persisted columns instead for frequently queried alternative-collation lookups.

### 4. Always Encrypted requires `_BIN2` collation

Always Encrypted requires string column (`varchar`, `char`, etc.) collations to be binary-code point (`_BIN2`). Forgetting this causes AE setup failures or runtime errors. [^9]

### 5. UTF-8 collation storage trade-off

`_UTF8` collations store `varchar` as UTF-8. ASCII characters (0–127) take 1 byte (same as code page 1252). Characters U+0080–U+07FF take 2 bytes; U+0800+ take 3 bytes. This is more efficient than `nvarchar` (2 bytes/char) for ASCII-dominant data but can be *larger* for CJK-heavy text. Profile before migrating. [^6]

### 6. `ALTER DATABASE ... COLLATE` does NOT change existing columns

Developers often believe changing the database collation retroactively fixes all columns. It only affects new columns created afterward. Existing columns must be altered individually (see Section 10).

### 7. Supplementary character handling (`_SC`)

Without `_SC`, surrogate pairs (emoji, rare Unicode, e.g., U+10000–U+10FFFF) are treated as two separate characters. `LEN(N'😀')` returns 2 without `_SC`, 1 with `_SC`. String functions (`SUBSTRING`, `LEFT`, `RIGHT`, `LEN`, `CHARINDEX`) all behave differently. [^1]

### 8. `ORDER BY` with CI collation sorts `'A'` and `'a'` together — order between them is undefined

With a case-insensitive collation, `ORDER BY Name` will put `'Alice'` before `'alice'` or `'ALICE'` — but which exact order is not guaranteed. Add a secondary `ORDER BY Name COLLATE Latin1_General_BIN2` if you need a deterministic tie-break.

### 9. `LIKE` patterns are collation-aware

`LIKE 'A%'` on a CI column matches `'Alice'` and `'alice'`. On a CS column it matches only `'Alice%'`. Wildcard behavior (especially `[A-Z]`) is also collation-dependent — `[A-Z]` on a CI collation may include accented letters between A and Z in the locale's sort order.

### 10. Changing column collation drops and re-creates the column internally

This is a data-movement operation. For large tables it can cause significant blocking and log growth. Consider using `ONLINE` options where available, or offline maintenance windows.

### 11. `COLLATE DATABASE_DEFAULT` in stored procedures is resolved at parse time in some contexts

In dynamic SQL or cross-database calls, `DATABASE_DEFAULT` resolves to the database where the statement **executes**, which may differ from the database where the stored procedure was created. This is usually what you want but can be surprising.

### 12. Linked server queries and collation

Remote queries via linked servers return data with the remote server's collation. If the remote server uses a different collation, implicit collation conflicts arise in local JOINs. Always test collation behavior when federating data across linked servers.

---

## 15. See Also

- [`references/25-null-handling.md`](25-null-handling.md) — NULL behavior in comparisons (distinct from collation issues)
- [`references/16-security-encryption.md`](16-security-encryption.md) — Always Encrypted `_BIN2` collation requirement
- [`references/34-tempdb.md`](34-tempdb.md) — tempdb sizing and collation inheritance
- [`references/45-linked-servers.md`](45-linked-servers.md) — cross-server collation conflicts
- [`references/53-migration-compatibility.md`](53-migration-compatibility.md) — collation considerations during upgrades

---

## Sources

[^1]: [Collation and Unicode Support - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/collations/collation-and-unicode-support) — comprehensive reference covering collation concepts, naming conventions, sensitivity attributes, supplementary characters, and BIN2 binary sort
[^2]: [Set or change the database collation - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/collations/set-or-change-the-database-collation) — how to set collation at CREATE DATABASE time and change it with ALTER DATABASE, including limitations on Azure SQL Database
[^3]: [Set or Change the Column Collation - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/collations/set-or-change-the-column-collation) — how to override database collation at the column level, including COLLATE DATABASE_DEFAULT for temp tables
[^4]: [sys.fn_helpcollations (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-helpcollations-transact-sql) — system function that returns all supported collation names and descriptions
[^5]: [COLLATE (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/collations) — syntax and usage of the COLLATE clause at database, column, and expression levels
[^6]: [Collation and Unicode Support - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/collations/collation-and-unicode-support) — UTF-8 collations introduced in SQL Server 2019: storage behaviour, trade-offs, and compatibility level requirements
[^7]: [Collation Mismatch - Brent Ozar Unlimited®](https://www.brentozar.com/blitz/database-server-collation-mismatch/) — sp_Blitz check explaining database-vs-server collation mismatches and their impact on temp tables and cross-database joins
[^8]: [Changing Database Collation and dealing with TempDB Objects](https://www.sqlskills.com/blogs/kimberly/changing-database-collation-and-dealing-with-tempdb-objects/) — Kimberly L. Tripp (sqlskills.com, 2006); demonstrates the `COLLATE DATABASE_DEFAULT` pattern for temp tables when database and tempdb collations differ
[^9]: [Always Encrypted - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-database-engine) — documents that Always Encrypted does not support string columns with collations other than binary-code point (`_BIN2`) collations

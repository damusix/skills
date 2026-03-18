# 08 — Indexes

## Table of Contents

1. [When to Use This Reference](#1-when-to-use-this-reference)
2. [Index Fundamentals](#2-index-fundamentals)
3. [Clustered Indexes](#3-clustered-indexes)
4. [Nonclustered Indexes](#4-nonclustered-indexes)
5. [Clustered vs Nonclustered: Head-to-Head Comparison](#5-clustered-vs-nonclustered-head-to-head-comparison)
6. [Heaps](#6-heaps)
7. [Covering Indexes and INCLUDE Columns](#7-covering-indexes-and-include-columns)
8. [Filtered Indexes](#8-filtered-indexes)
9. [Index Design Patterns](#9-index-design-patterns)
10. [Fill Factor and Page Splits](#10-fill-factor-and-page-splits)
11. [Fragmentation: Rebuild vs Reorganize](#11-fragmentation-rebuild-vs-reorganize)
12. [Missing Index DMVs](#12-missing-index-dmvs)
13. [Index Maintenance Best Practices](#13-index-maintenance-best-practices)
14. [Gotchas / Anti-Patterns](#14-gotchas--anti-patterns)
15. [See Also](#15-see-also)
16. [Sources](#sources)

---

## 1. When to Use This Reference

Load this file when the user asks about:

- Choosing between clustered and nonclustered indexes
- INCLUDE columns, covering indexes, key lookups
- Heaps, forwarded records, RID lookups
- Filtered indexes, index design strategies
- Fill factor, page splits, fragmentation
- Rebuild vs. reorganize — thresholds and scheduling
- Wide clustered key problems, index intersection
- Missing index recommendations from DMVs or execution plans

---

## 2. Index Fundamentals

SQL Server indexes use a **B-tree** structure (for rowstore) with a root page, intermediate level pages, and leaf pages.

| Component | Description |
|-----------|-------------|
| Root page | Entry point; SQL Server reads this to find the intermediate/leaf page holding a key |
| Intermediate pages | Interior nodes of the B-tree; point to child pages |
| Leaf pages | Bottom of the B-tree; contain either data rows (clustered) or pointers (nonclustered) |

**Index depth** = number of B-tree levels. For a table with 1 billion rows, clustered index depth is typically 4–5 levels; the optimizer reads exactly that many pages per seek — not the whole table.

### How SQL Server finds rows

1. **Index seek** — traverses the B-tree to a specific key range. O(log n). Preferred.
2. **Index scan** — reads all leaf pages. O(n). Sometimes unavoidable (large range or no predicate).
3. **Key lookup** — seek on nonclustered index leaf, then follow the clustered key back to the base row (or RID for heaps) to fetch non-index columns. Each lookup is a separate single-row seek.

---

## 3. Clustered Indexes

The **clustered index IS the table**. Leaf pages contain the actual data rows ordered by the clustered key. A table can have exactly one clustered index.

```sql
-- Create table with clustered index on primary key (default)
CREATE TABLE dbo.Orders (
    OrderID     int         NOT NULL IDENTITY(1,1),
    CustomerID  int         NOT NULL,
    OrderDate   datetime2   NOT NULL,
    Status      tinyint     NOT NULL DEFAULT 1,
    CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderID)
);

-- Explicitly named clustered index on a non-PK column
CREATE TABLE dbo.OrderLines (
    OrderLineID int         NOT NULL IDENTITY(1,1),
    OrderID     int         NOT NULL,
    ProductID   int         NOT NULL,
    Qty         smallint    NOT NULL,
    CONSTRAINT PK_OrderLines PRIMARY KEY NONCLUSTERED (OrderLineID)
);
CREATE CLUSTERED INDEX CIX_OrderLines_OrderID
    ON dbo.OrderLines (OrderID);
```

### Clustered key selection criteria

| Property | Why it matters |
|----------|---------------|
| **Narrow** | The clustered key is copied into every nonclustered index leaf row. A 4-byte `int` adds 4 bytes per NCI row; a 20-byte natural key multiplies that across all indexes |
| **Ever-increasing** | Random inserts (e.g., `newid()` as clustered key) cause 50% page splits and fragmentation. `IDENTITY`, `SEQUENCE`, or `newsequentialid()` avoids this |
| **Unique** | SQL Server adds a 4-byte uniquifier to duplicate clustered key values silently, increasing row size |
| **Static** | Clustered key updates physically move the row (delete + insert); also cascades to update every NCI that holds the key |

### Wide clustered key problems

- Each nonclustered index stores a copy of the clustered key in its leaf rows as the **row locator**.
- A `uniqueidentifier` (16 bytes) clustered key vs. `int` (4 bytes) makes every NCI 12 bytes wider per row.
- For a table with 10 NCIs and 100M rows: `(16-4) × 10 × 100,000,000 = 12 GB` extra index storage.

> [!WARNING] Anti-pattern
> Using `NEWID()` (random GUID) as a clustered index key causes near-constant page splits and severe fragmentation. Replace with `NEWSEQUENTIALID()` or use `int`/`bigint` IDENTITY instead.

---

## 4. Nonclustered Indexes

Nonclustered indexes have their own B-tree structure. Leaf pages contain:
- The **index key columns** (in key order)
- A **row locator**: the clustered key (if a clustered index exists) or an 8-byte RID (heap page:slot)
- **INCLUDE columns** (non-key, stored only at leaf level)

```sql
-- Basic nonclustered index
CREATE NONCLUSTERED INDEX IX_Orders_CustomerID
    ON dbo.Orders (CustomerID);

-- Composite key, DESC ordering
CREATE NONCLUSTERED INDEX IX_Orders_CustomerID_OrderDate
    ON dbo.Orders (CustomerID ASC, OrderDate DESC);

-- With INCLUDE columns (covering — see section 7)
CREATE NONCLUSTERED INDEX IX_Orders_CustomerID_Covering
    ON dbo.Orders (CustomerID)
    INCLUDE (OrderDate, Status);

-- Unique nonclustered
CREATE UNIQUE NONCLUSTERED INDEX UX_Orders_ExternalRef
    ON dbo.Orders (ExternalRef)
    WHERE ExternalRef IS NOT NULL;   -- filtered unique
```

### How many nonclustered indexes?

Rules of thumb:
- OLTP tables: **3–5 indexes** total before write overhead becomes significant.
- OLAP/read-heavy tables: more indexes are acceptable.
- Each NCI is updated on every `INSERT`, `UPDATE` (if any index column changes), and `DELETE`. At 20+ indexes, inserts on high-volume tables can become write-bound.

---

## 5. Clustered vs Nonclustered: Head-to-Head Comparison

### Side-by-side comparison

| Property | Clustered Index | Nonclustered Index |
|---|---|---|
| **Physical structure** | Leaf level **is** the data pages; rows stored in key order | Leaf level holds index key + row locator (clustered key or RID); separate B-tree from the data |
| **B-tree depth** | Typically deeper for large tables (data rows are wider, more pages per level) | Typically shallower (narrower rows at each level) |
| **Seek behavior** | Clustered Index Seek returns data directly from leaf pages | Nonclustered Index Seek finds the leaf row, then requires a **Key Lookup** to fetch non-covered columns from the clustered index |
| **Scan behavior** | Clustered Index Scan = full table scan (every data page) | Nonclustered Index Scan reads only the smaller NCI structure; cheaper than clustered scan when NCI is narrow and selective |
| **Wide key cost** | Wide clustered key bloats every NCI leaf row (NCI stores the CK as its row locator) | Wide NCI key bloats only that specific index |
| **Maximum per table** | **1** — only one clustered index allowed | **999** nonclustered indexes per table |
| **Uniqueness** | If not declared UNIQUE, SQL Server silently appends a 4-byte **uniquifier** to duplicate key values | Must be declared UNIQUE explicitly; otherwise duplicates are allowed |
| **Impact on other NCIs** | The clustered key is embedded in every NCI leaf row as the row locator — changing or widening the CK cascades cost to all NCIs | Changing an NCI key only affects that index |
| **INSERT cost** | Inserts must place row in correct sorted position (page splits on random keys) | Inserts append a new leaf entry in the NCI's sorted order (separate structure) |
| **UPDATE cost** | Updating CK columns = physical row move (delete + insert) | Updating NCI key columns = NCI leaf entry delete + insert (no row move if CK unchanged) |

### Decision guide

**Choose clustered on a column when:**

- Queries frequently do **range scans** on the key (e.g., `WHERE OrderDate BETWEEN … AND …`): the clustered index stores rows physically contiguous, so a range read is sequential I/O.
- The column is used in `ORDER BY` frequently and you want to avoid explicit sorts in execution plans.
- You want the narrowest possible row locator in all NCIs (e.g., a 4-byte `int IDENTITY` is the canonical choice).
- The workload is **read-heavy with range predicates** — sequential clustered reads outperform NCI seek + key lookup chains for large result sets.

**Choose nonclustered on a column when:**

- You need a **point lookup** (equality seek) on a non-CK column and can make the index covering with `INCLUDE` columns — avoids a key lookup entirely.
- The column has **high selectivity** but is rarely used for range queries (e.g., `EmailAddress`, `ExternalOrderRef`).
- You need **multiple access paths** — you can have 999 NCIs; use them for different query patterns.
- The column is updated frequently — updating an NCI key is cheaper than updating the CK (which moves the row).
- You want a **filtered index** on a subset of rows — clustered indexes cannot be filtered.

**Rule of thumb:** One well-chosen clustered index on the primary access pattern + targeted covering NCIs for secondary patterns. If you find yourself needing a key lookup on every query, add the missing columns to the NCI's `INCLUDE` list.

### Execution plan example: Clustered Seek vs NCI Seek + Key Lookup

```sql
-- Setup
CREATE TABLE dbo.Customers (
    CustomerID   int           NOT NULL IDENTITY(1,1),
    Email        varchar(200)  NOT NULL,
    FirstName    nvarchar(50)  NOT NULL,
    LastName     nvarchar(50)  NOT NULL,
    CreatedAt    datetime2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_Customers PRIMARY KEY CLUSTERED (CustomerID)
);
CREATE NONCLUSTERED INDEX IX_Customers_Email
    ON dbo.Customers (Email);

-- ── Scenario A: Query by CustomerID (clustered key) ──────────────────────────
SET STATISTICS IO ON;

SELECT CustomerID, Email, FirstName, LastName, CreatedAt
FROM dbo.Customers
WHERE CustomerID = 42;
-- Plan: Clustered Index Seek (CustomerID = 42)
--   → leaf page IS the data row, all columns returned directly
-- STATISTICS IO: logical reads = 2–3 (root + leaf)

-- ── Scenario B: Query by Email (nonclustered key), no covering columns ────────
SELECT CustomerID, Email, FirstName, LastName, CreatedAt
FROM dbo.Customers
WHERE Email = 'alice@example.com';
-- Plan: Index Seek (IX_Customers_Email) → Key Lookup (Clustered) for FirstName, LastName, CreatedAt
--   → 2 seeks: one in the NCI, one in the clustered index
-- STATISTICS IO: logical reads = 4–6 (NCI root+leaf + CI root+leaf per row found)

-- ── Scenario C: Eliminate the key lookup with INCLUDE ─────────────────────────
DROP INDEX IX_Customers_Email ON dbo.Customers;
CREATE NONCLUSTERED INDEX IX_Customers_Email_Covering
    ON dbo.Customers (Email)
    INCLUDE (FirstName, LastName, CreatedAt);

SELECT CustomerID, Email, FirstName, LastName, CreatedAt
FROM dbo.Customers
WHERE Email = 'alice@example.com';
-- Plan: Index Seek (IX_Customers_Email_Covering) — no Key Lookup
-- STATISTICS IO: logical reads = 2–3 (NCI root + leaf only)

SET STATISTICS IO OFF;
```

**Representative `STATISTICS IO` output comparison** (1M-row table, 1 matching row):

| Scenario | Logical Reads | Notes |
|---|---|---|
| Clustered Index Seek (CK lookup) | 3 | Root → intermediate → leaf (= data row) |
| NCI Seek + Key Lookup (1 row) | 6 | NCI root→leaf (3) + CI root→leaf (3) |
| NCI Seek + Key Lookup (1,000 rows) | ~3,003 | 3 for NCI scan + 3 per row for CI lookup — scales linearly |
| Covering NCI Seek (1,000 rows) | ~15 | NCI range scan, no per-row lookups |

> The key insight: a nonclustered seek + key lookup is fine for **single-row or very low cardinality** lookups. Once the number of matching rows grows, the lookup overhead dominates. The crossover point (where the optimizer switches to a clustered scan) depends on row count and table size — typically 0.5–2% of table rows. [^5]

---

## 6. Heaps

A **heap** is a table without a clustered index. Rows are stored unordered. Each row has an 8-byte **Row ID (RID)** = file:page:slot.

```sql
-- Heap: no clustered index
CREATE TABLE dbo.StagingLoad (
    RowNum      bigint      NOT NULL IDENTITY(1,1),
    RawData     nvarchar(4000) NULL,
    LoadedAt    datetime2   NOT NULL DEFAULT SYSUTCDATETIME()
);
-- Note: no CLUSTERED index created
```

### Forwarded records

When a variable-length row grows (e.g., `UPDATE` expanding a `varchar`) and no longer fits on its original page, SQL Server:
1. Moves the row to a new page.
2. Leaves a **forwarding stub** (14 bytes) at the original slot pointing to the new location.
3. Any nonclustered index still points to the original RID → SQL Server follows the forward pointer automatically.

**Cost:** each heap access via NCI now requires **2 page reads** instead of 1. Forwarded records accumulate silently.

```sql
-- Detect forwarded records
SELECT
    object_name(ps.object_id)   AS TableName,
    ps.forwarded_record_count,
    ps.page_count,
    ps.record_count
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, 0, NULL, 'DETAILED') ps
WHERE ps.index_id = 0   -- 0 = heap
  AND ps.forwarded_record_count > 0;

-- Fix: rebuild the heap
ALTER TABLE dbo.StagingLoad REBUILD;
```

### When heaps are appropriate

| Use case | Reason |
|----------|--------|
| Staging / ETL landing tables with BULK INSERT | Clustered index would slow bulk loads; TABLOCK hint enables minimal logging on heap |
| Append-only queues with OUTPUT on DELETE (see `40-service-broker-queuing.md`) | SELECT + DELETE pattern on a small range; no ordering benefit |
| Never for OLTP production tables with range queries | Scans are always full-table on a heap |

> [!WARNING] Anti-pattern
> Heaps with UPDATE-heavy workloads accumulate forwarded records that silently degrade query performance. Add a clustered index or run `ALTER TABLE ... REBUILD` regularly.

---

## 7. Covering Indexes and INCLUDE Columns

A **covering index** satisfies a query entirely from the index without a key lookup back to the base table.

```sql
-- Query: find all orders for a customer with status and date
SELECT CustomerID, OrderDate, Status
FROM dbo.Orders
WHERE CustomerID = 42;

-- Without covering index: NCI seek on CustomerID + key lookup per row for OrderDate, Status
-- With covering index: single seek, no lookup
CREATE NONCLUSTERED INDEX IX_Orders_CustomerID_Covering
    ON dbo.Orders (CustomerID)
    INCLUDE (OrderDate, Status);
```

### Key columns vs INCLUDE columns

| | Key columns | INCLUDE columns |
|-|-------------|-----------------|
| Stored at | All B-tree levels | Leaf level only |
| Can be used for | Seek predicates, ORDER BY, range scans | Output only (SELECT list, no predicate) |
| Max size | 900 bytes (non-XML/spatial) | 1,700 bytes total leaf row size |
| Max count | 16 key columns | Up to 1,023 INCLUDE columns |

**Rule:** Put columns in the key only if they appear in WHERE/JOIN/ORDER BY. Everything else that needs to be in the SELECT goes in INCLUDE.

### Key lookup elimination

A **key lookup** appears in execution plans when a nonclustered index seek is followed by a clustered key lookup to fetch missing columns. One lookup per row found — with 10,000 matching rows, that's 10,000 singleton clustered index seeks.

```sql
-- Identify key lookups in plan cache
SELECT
    qs.execution_count,
    qs.total_logical_reads / qs.execution_count AS avg_reads,
    SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS query_text,
    qp.query_plan
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE CAST(qp.query_plan AS nvarchar(max)) LIKE '%KeyLookup%'
ORDER BY qs.total_logical_reads DESC;
```

---

## 8. Filtered Indexes

A **filtered index** covers only a subset of rows matching a predicate. Smaller index → less storage, less maintenance overhead, higher selectivity per byte.

```sql
-- Only index active orders (status = 1)
CREATE NONCLUSTERED INDEX IX_Orders_Active
    ON dbo.Orders (CustomerID, OrderDate)
    INCLUDE (Status)
    WHERE Status = 1;

-- Unique constraint on non-NULL external reference
CREATE UNIQUE NONCLUSTERED INDEX UX_Orders_ExternalRef
    ON dbo.Orders (ExternalRef)
    WHERE ExternalRef IS NOT NULL;

-- Index sparse column (NULL values excluded by filter)
CREATE NONCLUSTERED INDEX IX_Events_ErrorCode
    ON dbo.EventLog (ErrorCode)
    WHERE ErrorCode IS NOT NULL;
```

### Filtered index requirements

- Filter predicate must be a simple comparison, `IS NULL`, or `IS NOT NULL`. No functions.
- The query `WHERE` clause must be **compatible** with the filter predicate. SQL Server will not use a filtered index if the query doesn't include the filter condition (or a superset).
- `ALLOW_ROW_LOCKS = ON`, `ALLOW_PAGE_LOCKS = ON` must be on (defaults).
- Cannot be used for queries with `OR` that span inside/outside the filter.

> [!WARNING] Parameterized queries
> A filtered index on `WHERE Status = 1` will not be used by a parameterized query `WHERE Status = @status` unless `OPTION (RECOMPILE)` is added or the index is rebuilt with an explicit plan guide. The optimizer cannot guarantee @status will always equal 1. [^1]

---

## 9. Index Design Patterns

### The SARGable predicate rule

An index is useful only if the predicate is **SARGable** (Search ARGument-able): the column is on the left, no function wraps the column.

```sql
-- NOT SARGable (function wraps column — full scan)
SELECT * FROM dbo.Orders WHERE YEAR(OrderDate) = 2024;
SELECT * FROM dbo.Orders WHERE LEFT(LastName, 3) = 'Smi';
SELECT * FROM dbo.Orders WHERE CONVERT(varchar, OrderID) = '42';

-- SARGable equivalents
SELECT * FROM dbo.Orders WHERE OrderDate >= '2024-01-01' AND OrderDate < '2025-01-01';
SELECT * FROM dbo.Orders WHERE LastName LIKE 'Smi%';
SELECT * FROM dbo.Orders WHERE OrderID = 42;
```

### Composite index column ordering

1. **Equality predicates first** (columns with `=` in WHERE)
2. **Range predicates last** (columns with `>`, `<`, `BETWEEN`, `LIKE 'x%'`)
3. **ORDER BY columns** — if they follow equality columns in the index, sorting is free

```sql
-- Query: WHERE CustomerID = 5 AND OrderDate BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY OrderDate
-- Optimal index: (CustomerID, OrderDate)
-- CustomerID = equality → first; OrderDate = range + sort → second
CREATE NONCLUSTERED INDEX IX_Orders_Customer_Date
    ON dbo.Orders (CustomerID, OrderDate);
```

### Index intersection (rare, often bad)

SQL Server can sometimes intersect two nonclustered indexes with a hash join, but this is almost always worse than a single well-designed covering index. If you see index intersection in execution plans, redesign the index.

### Duplicate and redundant indexes

```sql
-- Find duplicate/redundant indexes (same leading key columns)
SELECT
    t.name AS TableName,
    i1.name AS Index1,
    i2.name AS Index2,
    i1.index_id AS ID1,
    i2.index_id AS ID2
FROM sys.indexes i1
JOIN sys.indexes i2
    ON i1.object_id = i2.object_id
    AND i1.index_id < i2.index_id
JOIN sys.index_columns ic1
    ON i1.object_id = ic1.object_id AND i1.index_id = ic1.index_id
    AND ic1.index_column_id = 1
JOIN sys.index_columns ic2
    ON i2.object_id = ic2.object_id AND i2.index_id = ic2.index_id
    AND ic2.index_column_id = 1
JOIN sys.tables t ON i1.object_id = t.object_id
WHERE ic1.column_id = ic2.column_id
  AND i1.type > 0 AND i2.type > 0
ORDER BY t.name, i1.name;
```

---

## 10. Fill Factor and Page Splits

**Fill factor** controls how full leaf pages are when the index is rebuilt. A fill factor of 80 means 80% used, 20% free for future inserts.

```sql
-- Set fill factor at index creation
CREATE NONCLUSTERED INDEX IX_Orders_CustomerID
    ON dbo.Orders (CustomerID)
    WITH (FILLFACTOR = 80);

-- Set fill factor on rebuild
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
    REBUILD WITH (FILLFACTOR = 80, ONLINE = ON);

-- Check current fill factor for all indexes on a table
SELECT
    i.name,
    i.fill_factor,
    i.type_desc
FROM sys.indexes i
WHERE i.object_id = OBJECT_ID('dbo.Orders')
  AND i.type > 0;
```

### Page split types

| Type | When | Cost |
|------|------|------|
| **50/50 split** | Insert into middle of a full page (random key inserts) | High: creates a new page, moves ~half the rows, logs both operations |
| **90/10 split** | Insert at end of last page (monotonically increasing key) | Low: creates a new page, moves very little |

**Fill factor guidance:**

| Scenario | Recommended fill factor |
|----------|------------------------|
| Read-only/archival table | 100 (no free space needed) |
| Monotonically increasing clustered key (IDENTITY) | 100 on clustered, 90 on NCIs |
| Random inserts into existing range (natural key) | 70–80 |
| High-update heap or NCI with frequent splits | 70–75 |

> [!WARNING] Fill factor is not maintained
> Fill factor applies only when the index is created or rebuilt. After the rebuild, pages fill up naturally as rows are inserted. Fragmentation will grow until the next rebuild. Fill factor is **not a runtime setting** — it just sets the initial density.

### Detecting page splits

```sql
-- Extended Events session to capture page splits (use sparingly — high volume event)
CREATE EVENT SESSION [PageSplits] ON SERVER
ADD EVENT sqlserver.page_split (
    WHERE sqlserver.database_id = DB_ID()
)
ADD TARGET package0.ring_buffer
WITH (MAX_DISPATCH_LATENCY = 5 SECONDS);

-- Alternatively, track via sys.dm_db_index_operational_stats
SELECT
    object_name(ios.object_id) AS TableName,
    i.name AS IndexName,
    ios.leaf_allocation_count       AS LeafPageAllocations,
    ios.nonleaf_allocation_count    AS NonLeafPageAllocations
FROM sys.dm_db_index_operational_stats(DB_ID(), NULL, NULL, NULL) ios
JOIN sys.indexes i ON ios.object_id = i.object_id AND ios.index_id = i.index_id
WHERE ios.leaf_allocation_count > 1000
ORDER BY ios.leaf_allocation_count DESC;
```

---

## 11. Fragmentation: Rebuild vs Reorganize

```sql
-- Check fragmentation (use LIMITED for large tables; DETAILED for accurate but slow)
SELECT
    OBJECT_NAME(ps.object_id)          AS TableName,
    i.name                             AS IndexName,
    ps.index_type_desc,
    ps.avg_fragmentation_in_percent,
    ps.page_count,
    ps.avg_page_space_used_in_percent
FROM sys.dm_db_index_physical_stats(
        DB_ID(), NULL, NULL, NULL, 'LIMITED') ps
JOIN sys.indexes i
    ON ps.object_id = i.object_id
    AND ps.index_id = i.index_id
WHERE ps.page_count > 128   -- skip tiny indexes
ORDER BY ps.avg_fragmentation_in_percent DESC;
```

### Decision thresholds

| Fragmentation | Page count | Action |
|---------------|-----------|--------|
| < 5% | Any | Ignore |
| 5–30% | > 1,000 pages | `ALTER INDEX ... REORGANIZE` |
| > 30% | > 1,000 pages | `ALTER INDEX ... REBUILD` |
| Any | < 1,000 pages | Ignore (fragmentation cost < fix cost) |

> [!NOTE] These thresholds are guidelines, not absolutes. Ola Hallengren's IndexOptimize script [^2] implements a more nuanced strategy based on fragmentation, page count, and whether the index is used.

### REORGANIZE

- **Online**: no blocking, can be interrupted and resumed.
- Compacts leaf pages in-place; does **not** defragment upper B-tree levels.
- Does not update fill factor to the stored value.
- Resets fragmentation stats in `sys.dm_db_index_physical_stats` only after it finishes.

```sql
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders REORGANIZE;

-- All indexes on a table
ALTER INDEX ALL ON dbo.Orders REORGANIZE;
```

### REBUILD

- **Offline by default**; `ONLINE = ON` available on Enterprise (table remains accessible but slower during operation).
- Drops and recreates the index from scratch.
- Applies fill factor.
- Updates statistics automatically (equivalent to `FULLSCAN` of the index pages).
- Resets LOB/row-overflow page chains.

```sql
-- Offline rebuild
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders REBUILD;

-- Online rebuild (Enterprise Edition)
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
    REBUILD WITH (ONLINE = ON, FILLFACTOR = 85);

-- Resumable rebuild (2017+, Enterprise)
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
    REBUILD WITH (ONLINE = ON, RESUMABLE = ON, MAX_DURATION = 60 MINUTES);

-- Resume if interrupted
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders RESUME;

-- Abort resumable rebuild
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders ABORT;
```

> [!NOTE] SQL Server 2017
> Resumable online index rebuild was introduced in SQL Server 2017. Allows long rebuilds to be paused and resumed, reducing maintenance window requirements. [^3]

> [!NOTE] SQL Server 2019
> Online index create (not just rebuild) became resumable in 2019. [^4]

### Statistics update during rebuild

`ALTER INDEX ... REBUILD` automatically updates statistics for that index with a full scan. If you schedule `UPDATE STATISTICS` separately after a rebuild, you're doing redundant work. Reorganize does **not** update statistics — schedule `UPDATE STATISTICS` after REORGANIZE.

---

## 12. Missing Index DMVs

SQL Server records indexes the query optimizer "wished" existed during plan compilation.

```sql
-- Top missing indexes by estimated benefit
SELECT TOP 25
    mid.statement                               AS TableName,
    mid.equality_columns,
    mid.inequality_columns,
    mid.included_columns,
    migs.unique_compiles,
    migs.user_seeks,
    migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks + migs.user_scans)
                                                AS IndexBenefit,
    migs.avg_user_impact                        AS AvgImpactPct,
    'CREATE NONCLUSTERED INDEX IX_' +
        REPLACE(REPLACE(mid.statement, '[', ''), ']', '') +
        '_Missing_' + CAST(mid.index_handle AS varchar) +
        ' ON ' + mid.statement + ' (' +
        ISNULL(mid.equality_columns, '') +
        CASE WHEN mid.equality_columns IS NOT NULL AND mid.inequality_columns IS NOT NULL THEN ',' ELSE '' END +
        ISNULL(mid.inequality_columns, '') + ')' +
        ISNULL(' INCLUDE (' + mid.included_columns + ')', '') AS CreateStatement
FROM sys.dm_db_missing_index_details mid
JOIN sys.dm_db_missing_index_groups mig ON mid.index_handle = mig.index_handle
JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle
WHERE mid.database_id = DB_ID()
ORDER BY IndexBenefit DESC;
```

> [!WARNING] Missing index DMV caveats
> - The optimizer generates one missing index recommendation per query, per table. It does not consolidate overlapping suggestions.
> - Suggestions reset on service restart.
> - **Never blindly create every suggested index.** Evaluate combinations: two suggestions may be satisfied by one well-designed index. Blind creation leads to index bloat.
> - The impact percentage is the optimizer's estimate for that specific query, not a global benefit prediction.

### Unused indexes

```sql
-- Find indexes with zero or low seeks/scans since last restart
SELECT
    OBJECT_NAME(i.object_id)    AS TableName,
    i.name                      AS IndexName,
    i.type_desc,
    ISNULL(us.user_seeks, 0)    AS UserSeeks,
    ISNULL(us.user_scans, 0)    AS UserScans,
    ISNULL(us.user_lookups, 0)  AS UserLookups,
    ISNULL(us.user_updates, 0)  AS UserUpdates,
    i.is_primary_key,
    i.is_unique_constraint
FROM sys.indexes i
LEFT JOIN sys.dm_db_index_usage_stats us
    ON i.object_id = us.object_id
    AND i.index_id = us.index_id
    AND us.database_id = DB_ID()
WHERE OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1
  AND i.type > 0
  AND ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) + ISNULL(us.user_lookups, 0) = 0
  AND i.is_primary_key = 0
  AND i.is_unique_constraint = 0
ORDER BY ISNULL(us.user_updates, 0) DESC;  -- most expensive unused first
```

> [!WARNING] Index usage stats reset
> `sys.dm_db_index_usage_stats` resets on SQL Server restart and on database detach/attach. Before dropping an index based on zero reads, verify the instance has been running long enough to represent a typical workload (at least a full business cycle).

---

## 13. Index Maintenance Best Practices

### Recommended: Ola Hallengren's IndexOptimize

The de facto standard maintenance solution. Handles fragmentation thresholds, statistics updates, LOB fragmentation, online/offline decision, and logging — in one stored procedure call.

```sql
-- Example: maintain all indexes in a database
EXEC dbo.IndexOptimize
    @Databases = 'USER_DATABASES',
    @FragmentationLow = NULL,              -- ignore low fragmentation
    @FragmentationMedium = 'INDEX_REORGANIZE',
    @FragmentationHigh = 'INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE',
    @FragmentationLevel1 = 5,
    @FragmentationLevel2 = 30,
    @PageCountLevel = 1000,
    @UpdateStatistics = 'ALL',
    @OnlyModifiedStatistics = 'Y',
    @LogToTable = 'Y';
```

[^2]

### Adaptive maintenance scripts

For environments without Ola's scripts, here is a minimal adaptive maintenance loop:

```sql
DECLARE @sql nvarchar(500);
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT
        'ALTER INDEX ' + QUOTENAME(i.name) +
        ' ON ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + '.' + QUOTENAME(t.name) +
        CASE WHEN ps.avg_fragmentation_in_percent > 30
             THEN ' REBUILD WITH (ONLINE = ON)'
             ELSE ' REORGANIZE'
        END
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ps
    JOIN sys.indexes i ON ps.object_id = i.object_id AND ps.index_id = i.index_id
    JOIN sys.tables t ON i.object_id = t.object_id
    WHERE ps.avg_fragmentation_in_percent >= 5
      AND ps.page_count > 1000
      AND i.type > 0;

OPEN cur;
FETCH NEXT FROM cur INTO @sql;
WHILE @@FETCH_STATUS = 0
BEGIN
    EXEC (@sql);
    FETCH NEXT FROM cur INTO @sql;
END
CLOSE cur; DEALLOCATE cur;
```

### Partition-level operations

On partitioned indexes, rebuild or reorganize a single partition instead of the whole table:

```sql
ALTER INDEX IX_Sales_Date ON dbo.Sales
    REBUILD PARTITION = 12
    WITH (ONLINE = ON);
```

See `references/10-partitioning.md` for partition scheme details.

---

## 14. Gotchas / Anti-Patterns

### 1. Over-indexing

Each additional index adds write overhead to every `INSERT`, `UPDATE`, and `DELETE`. On a table receiving 10,000 inserts/second with 15 indexes, every insert touches 15 B-trees. Monitor `sys.dm_db_index_operational_stats` for `leaf_insert_count`, `leaf_delete_count`, and `leaf_update_count` to quantify write overhead.

### 2. Key lookups hiding behind low-read queries

A query with `user_seeks = 1,000,000` and a key lookup per seek is performing 2,000,000 page reads. Plans with key lookups look cheap when rows found is small, but expensive when it scales. Always check the **estimated rows** vs actual rows in the lookup operator.

### 3. Implicit conversion kills seeks

```sql
-- Table: CustomerCode varchar(20)
-- Query: WHERE CustomerCode = N'ABC'   (N prefix = nvarchar literal)
-- SQL Server must convert every varchar row to nvarchar to compare → scan
-- Fix: use 'ABC' (varchar literal) or CONVERT(varchar, N'ABC')
```

Implicit conversions from `varchar` columns to `nvarchar` predicates cause full scans even with an index. Always match literal types to column types.

### 4. Statistics out of date after bulk load

After bulk-loading millions of rows into a table, auto-update statistics may not fire immediately (threshold: 20% of rows + 500 changed). Manually run `UPDATE STATISTICS` after large loads.

```sql
UPDATE STATISTICS dbo.Orders WITH FULLSCAN;
```

### 5. Heaps accumulating forwarded records silently

Monitor with `sys.dm_db_index_physical_stats` on `index_id = 0`. Schedule `ALTER TABLE ... REBUILD` for high-update heaps used in staging patterns.

### 6. Disabling vs dropping indexes

```sql
-- DISABLE: index definition retained, not usable, not maintained on DML
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders DISABLE;

-- Re-enable (must REBUILD to re-enable a nonclustered index)
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders REBUILD;

-- DROP: removes index entirely
DROP INDEX IX_Orders_CustomerID ON dbo.Orders;
```

Disabling a clustered index makes the table **inaccessible** (all data hidden). Disabling a nonclustered index just stops maintaining it. Disabled NCIs still consume metadata but not storage for reads.

### 7. Online rebuild not available on all editions

`ONLINE = ON` requires **Enterprise Edition** (or Developer Edition for testing). On Standard Edition, `ALTER INDEX ... REBUILD` takes a Schema Modification (Sch-M) lock, blocking all queries.

### 8. Covering index doesn't cover ORDER BY

If the query is `ORDER BY Status` but Status is only an INCLUDE column (not a key column), the optimizer cannot use the index for sort elimination. Move sort columns into the key if ORDER BY satisfaction is needed.

### 9. Filtered index not used with OPTION (RECOMPILE) still fails

If the optimizer sees a parameterized query and can't prove the filter matches, it skips the filtered index regardless of `OPTION (RECOMPILE)`. Test using a literal value to confirm the filtered index is used, then determine why the parameterized path doesn't match.

### 10. Index on computed column requires PERSISTED or determinism

A nonclustered index on a non-persisted computed column requires the expression to be deterministic and precise. Use `ALTER TABLE ... ADD col AS (expr) PERSISTED` to persist the value and enable indexing on non-deterministic-ish expressions.

```sql
ALTER TABLE dbo.Orders
    ADD OrderYear AS YEAR(OrderDate) PERSISTED;

CREATE NONCLUSTERED INDEX IX_Orders_Year ON dbo.Orders (OrderYear);
```

---

## 15. See Also

- `references/02-syntax-dql.md` — Seek vs scan in execution plans, sargability rules
- `references/09-columnstore-indexes.md` — Columnstore indexes for analytics workloads
- `references/10-partitioning.md` — Partition-aligned indexes, switching
- `references/28-statistics.md` — Histogram interpretation, ascending key problem
- `references/29-query-plans.md` — Key lookup operator, index seek/scan operators, plan warnings
- `references/32-performance-diagnostics.md` — Missing index DMVs, unused index DMVs, sp_BlitzIndex

---

## Sources

[^1]: [Create Filtered Indexes - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/create-filtered-indexes) — covers filtered index design requirements including query predicate compatibility rules for parameterized queries
[^2]: [SQL Server Index and Statistics Maintenance](https://ola.hallengren.com/sql-server-index-and-statistics-maintenance.html) — Ola Hallengren's free open-source IndexOptimize stored procedure for automated index and statistics maintenance
[^3]: [What's New in SQL Server 2017](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2017) — documents resumable online index rebuild introduced in SQL Server 2017
[^4]: [What's New in SQL Server 2019](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2019) — documents resumable online rowstore index build (create) introduced in SQL Server 2019
[^5]: [The Tipping Point Query Answers — Kimberly L. Tripp](https://www.sqlskills.com/blogs/kimberly/the-tipping-point-query-answers/) — defines the tipping point where the optimizer switches from nonclustered index seek plus key lookup to a clustered index scan, typically around 25–33% of the table's page count

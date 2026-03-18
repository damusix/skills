# Columnstore Indexes

## Table of Contents

1. [When to Use](#when-to-use)
2. [Architecture Overview](#architecture-overview)
3. [Clustered Columnstore Indexes (CCI)](#clustered-columnstore-indexes)
4. [Nonclustered Columnstore Indexes (NCCI)](#nonclustered-columnstore-indexes)
5. [Delta Stores and Tuple Mover](#delta-stores-and-tuple-mover)
6. [Rowgroup Management](#rowgroup-management)
7. [Segment Elimination](#segment-elimination)
8. [Batch Mode Processing](#batch-mode-processing)
9. [Analytics Patterns](#analytics-patterns)
10. [DML and Update Strategies](#dml-and-update-strategies)
11. [Maintenance](#maintenance)
12. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
13. [See Also](#see-also)
14. [Sources](#sources)

---

## When to Use

Columnstore indexes are the right choice when:

- **Analytics / OLAP workloads**: aggregations, GROUP BY, range scans over large fact tables, star-schema joins
- **Data warehousing**: tables with millions to billions of rows where row-by-row access is rare
- **Mixed workload (HTAP)**: nonclustered columnstore on an OLTP table for reporting without full table copies
- **Real-time operational analytics**: real-time aggregation over a transactional table without an ETL pipeline

Avoid columnstore when:

- Workload is mostly single-row lookups (OLTP primary key access)
- Table is very small (< ~100K rows) — overhead outweighs compression benefit
- Many small, frequent updates to individual rows (though delta stores mitigate this)
- Queries never aggregate or group — they return all columns for individual rows

---

## Architecture Overview

Traditional rowstore stores all columns for a row together (row-major order). Columnstore stores each column separately (column-major order), compressed per column segment.

```
Rowstore (B-tree leaf page):
  [col1, col2, col3, col4] row 1
  [col1, col2, col3, col4] row 2
  ...

Columnstore rowgroup:
  segment for col1: [val1, val1, val1, val2, ...]  ← high compression (similar values)
  segment for col2: [val2, val2, val3, val3, ...]
  ...
```

Key structural units:

| Unit | Description |
|---|---|
| **Row group** | Group of ~1,048,576 rows compressed together (max row group size) |
| **Column segment** | Compressed data for one column within one row group |
| **Delta store** | B-tree rowstore that receives new inserts until full (< 1,048,576 rows) |
| **Delete bitmap** | Marks logically deleted rows; actual removal happens at tuple mover or rebuild |
| **Tuple mover** | Background process that compresses closed delta stores into compressed row groups |

> [!NOTE] SQL Server 2016
> `sys.dm_db_column_store_row_group_physical_stats` DMV added — prefer this over the older `sys.column_store_row_groups` for physical details.

---

## Clustered Columnstore Indexes

A **clustered columnstore index (CCI)** is the primary storage structure for the table. The table has no separate heap or B-tree — the CCI **is** the table.

```sql
-- Create a table with CCI as primary storage
CREATE TABLE dbo.FactSales
(
    SaleID       INT           NOT NULL,
    ProductID    INT           NOT NULL,
    CustomerID   INT           NOT NULL,
    SaleDate     DATE          NOT NULL,
    Quantity     INT           NOT NULL,
    UnitPrice    DECIMAL(10,2) NOT NULL,
    TotalAmount  DECIMAL(12,2) NOT NULL
)
WITH (DATA_COMPRESSION = COLUMNSTORE);  -- explicit; CCI implies columnstore compression

CREATE CLUSTERED COLUMNSTORE INDEX CCI_FactSales
ON dbo.FactSales;

-- Or combined:
CREATE TABLE dbo.FactSales2
(
    SaleID    INT  NOT NULL,
    SaleDate  DATE NOT NULL,
    Amount    DECIMAL(12,2) NOT NULL,
    INDEX CCI_FactSales2 CLUSTERED COLUMNSTORE
);
```

Convert an existing heap or clustered B-tree to CCI:

```sql
-- Drop existing clustered index and replace with CCI
-- (This rebuilds the entire table — schedule appropriately)
CREATE CLUSTERED COLUMNSTORE INDEX CCI_MyTable
ON dbo.MyTable
WITH (DROP_EXISTING = ON, ONLINE = ON);  -- ONLINE requires Enterprise
```

> [!NOTE] SQL Server 2022
> `ONLINE = ON` for columnstore operations is more robust. Resumable columnstore index operations added.

### CCI with B-tree nonclustered indexes

You can add nonclustered B-tree indexes to a CCI table for point-lookup performance:

```sql
-- CCI table with an added B-tree index for point lookups
CREATE CLUSTERED COLUMNSTORE INDEX CCI_FactSales ON dbo.FactSales;

CREATE NONCLUSTERED INDEX IX_FactSales_SaleID
ON dbo.FactSales (SaleID);  -- for single-row lookups by primary key
```

The optimizer chooses between the CCI (for range/aggregate queries) and the B-tree (for point lookups).

---

## Nonclustered Columnstore Indexes

A **nonclustered columnstore index (NCCI)** sits alongside the existing rowstore (heap or clustered B-tree). The base table structure is unchanged.

```sql
-- Add a read-only analytics index to an OLTP table
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders_Analytics
ON dbo.Orders (OrderDate, CustomerID, ProductID, Quantity, TotalAmount)
WHERE OrderDate >= '2020-01-01';  -- optional filtered NCCI
```

An NCCI on an updateable table is **read-only by default until SQL Server 2016**. From SQL Server 2016+, NCCI supports DML on the base table (inserts/updates/deletes automatically maintain the NCCI).

> [!NOTE] SQL Server 2016
> Updateable NCCI on disk-based tables. Before 2016, DML on a table with an NCCI was blocked unless the NCCI was disabled.

### NCCI column selection

Include only columns the analytics queries actually access. Narrower NCCIs compress better and use less memory during scans:

```sql
-- Good: analytics columns only
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders
ON dbo.Orders (OrderDate, RegionID, ProductID, Revenue, Cost);

-- Wasteful: includes all 40 columns — hurts compression, increases memory
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders_Wide
ON dbo.Orders;  -- all columns = heap-like, defeats the purpose
```

---

## Delta Stores and Tuple Mover

### Delta store lifecycle

```
INSERT (< 1,048,576 rows threshold)
         │
         ▼
  ┌─────────────┐
  │  Delta store │  (open B-tree rowstore, not yet compressed)
  │  (OPEN state)│
  └──────┬──────┘
         │ delta store fills to ~1M rows or REORGANIZE/REBUILD triggered
         ▼
  ┌─────────────┐
  │  Delta store │
  │ (CLOSED state)│  ← ready for compression but still B-tree
  └──────┬──────┘
         │ tuple mover background thread (runs ~5-min intervals)
         ▼
  ┌──────────────────────┐
  │  Compressed row group │  ← column segments, dictionary, bitmaps
  │  (COMPRESSED state)  │
  └──────────────────────┘
```

A CLOSED delta store is still in rowstore format — queries must scan it as rowstore. This can hurt performance during heavy insert workloads before the tuple mover catches up.

### Forcing delta store compression

```sql
-- REORGANIZE compresses all CLOSED delta stores immediately (no full rebuild)
ALTER INDEX CCI_FactSales ON dbo.FactSales REORGANIZE
WITH (COMPRESS_ALL_ROW_GROUPS = ON);
```

> [!NOTE] SQL Server 2016
> `COMPRESS_ALL_ROW_GROUPS = ON` option added to `ALTER INDEX ... REORGANIZE`.

### Monitoring delta stores

```sql
SELECT
    OBJECT_NAME(i.object_id)     AS table_name,
    i.name                        AS index_name,
    rg.state_description,
    rg.total_rows,
    rg.deleted_rows,
    rg.size_in_bytes
FROM sys.dm_db_column_store_row_group_physical_stats rg
JOIN sys.indexes i ON rg.object_id = i.object_id AND rg.index_id = i.index_id
WHERE OBJECT_NAME(i.object_id) = 'FactSales'
ORDER BY rg.row_group_id;
```

State values:

| State | Meaning |
|---|---|
| `OPEN` | Delta store accepting inserts |
| `CLOSED` | Delta store full, awaiting tuple mover |
| `COMPRESSED` | Compressed column segments |
| `TOMBSTONE` | Being removed after rebuild |
| `PRE_COMPRESSED` | In-flight transition (rare) |

---

## Rowgroup Management

### Optimal row group size

A full row group has ~1,048,576 rows. Partially full row groups compress worse and require more rowgroups to be scanned:

```sql
-- Detect suboptimal (trim) row groups
SELECT
    OBJECT_NAME(object_id) AS table_name,
    index_id,
    state_description,
    total_rows,
    deleted_rows,
    (total_rows - deleted_rows) AS live_rows,
    size_in_bytes / 1024.0 / 1024.0 AS size_mb,
    CASE
        WHEN state_description = 'COMPRESSED' AND total_rows < 900000
        THEN 'SUBOPTIMAL - consider REBUILD'
        ELSE 'OK'
    END AS assessment
FROM sys.dm_db_column_store_row_group_physical_stats
WHERE OBJECT_NAME(object_id) = 'FactSales'
ORDER BY row_group_id;
```

**Common causes of small row groups:**
- Bulk inserts smaller than 1M rows per batch
- Frequent `COMPRESS_ALL_ROW_GROUPS` on tables with low insert volume
- Partition-aligned inserts where each partition fills independently

### Bulk loading for optimal row groups

Batch sizes ≥ 102,400 rows bypass the delta store and go directly to compressed row groups (bulk import path):

```sql
-- Minimum 102,400 rows per batch for direct-path compression
BULK INSERT dbo.FactSales
FROM 'C:\data\sales.csv'
WITH (
    BATCHSIZE = 1048576,  -- 1M rows → full row groups
    TABLOCK,              -- required for minimal logging + direct path
    DATAFILETYPE = 'char',
    FIELDTERMINATOR = ',',
    ROWTERMINATOR = '\n'
);

-- Or via INSERT ... SELECT with TABLOCK
INSERT INTO dbo.FactSales WITH (TABLOCK)
SELECT * FROM dbo.FactSales_Staging;  -- must be > 102,400 rows per insert
```

> [!NOTE]
> `TABLOCK` is required for direct-path (bulk) loading into columnstore. Without it, inserts go through delta stores regardless of batch size.

---

## Segment Elimination

Segment elimination is the columnstore equivalent of index seek — the engine skips entire column segments (and their row groups) based on min/max metadata stored per segment.

### How it works

```
Compressed row group #1: OrderDate segment min=2020-01-01, max=2020-03-31
Compressed row group #2: OrderDate segment min=2020-04-01, max=2020-06-30
Compressed row group #3: OrderDate segment min=2020-07-01, max=2020-09-30

Query: WHERE OrderDate BETWEEN '2020-04-15' AND '2020-06-15'
→ Only row group #2 is scanned. Row groups #1 and #3 are eliminated.
```

Segment elimination works for: `=`, `>`, `>=`, `<`, `<=`, `BETWEEN`, `IN` (constant list), and `IS NULL`.

### Maximizing segment elimination

Load data in **sorted order** on the most frequently filtered column:

```sql
-- Load in date order to maximize segment elimination on OrderDate
INSERT INTO dbo.FactSales WITH (TABLOCK)
SELECT *
FROM dbo.FactSales_Staging
ORDER BY OrderDate;  -- sort before insert

-- Or use REORGANIZE after load to re-sort within row groups (partial help)
ALTER INDEX CCI_FactSales ON dbo.FactSales REORGANIZE
WITH (COMPRESS_ALL_ROW_GROUPS = ON);
```

> [!NOTE] SQL Server 2022
> **Columnstore ordered CCI** (`ORDER` clause on `CREATE CLUSTERED COLUMNSTORE INDEX`) is available, similar to Azure Synapse. This preserves sort order across row groups for maximal segment elimination.[^1]

```sql
-- 2022+ ordered CCI (if available in your build)
CREATE CLUSTERED COLUMNSTORE INDEX CCI_FactSales
ON dbo.FactSales
ORDER (SaleDate);
```

### Checking segment elimination in execution plan

Look for `Columnstore Index Scan` with `Segments Read` < total `Segments` in the actual execution plan (requires SSMS or Extended Events to see segment-level stats):

```sql
-- DMV: segment statistics per object
SELECT
    OBJECT_NAME(s.object_id) AS table_name,
    s.column_id,
    c.name AS column_name,
    s.segment_id,
    s.min_data_id,
    s.max_data_id,
    s.row_count,
    s.on_disk_size
FROM sys.column_store_segments s
JOIN sys.columns c ON c.object_id = s.object_id AND c.column_id = s.column_id
WHERE OBJECT_NAME(s.object_id) = 'FactSales'
ORDER BY s.column_id, s.segment_id;
```

---

## Batch Mode Processing

### Row mode vs batch mode

Traditional rowstore execution processes one row at a time through each operator (row mode). Columnstore enables **batch mode**, which processes 64–900 rows per CPU vector operation.

| Mode | Rows per operation | CPU usage | Best for |
|---|---|---|---|
| Row mode | 1 | Higher | OLTP point lookups |
| Batch mode | 64–900 | Lower (SIMD) | Aggregations, large scans |

Batch mode operators (when eligible): Hash Join, Sort, Aggregate, Filter, Compute Scalar, Window Aggregate.

### Batch mode eligibility

An operator switches to batch mode when:
1. At least one input comes from a columnstore index (CCI or NCCI)
2. Compatibility level ≥ 130 (SQL Server 2016)
3. The operator type supports batch mode

> [!NOTE] SQL Server 2019
> **Batch mode on rowstore** (IQP feature): batch mode can activate for rowstore tables even without a columnstore index, when the optimizer estimates it's beneficial (compat level 150+).[^2]

### Verifying batch mode in execution plan

In SSMS, hover over any operator in the actual execution plan. Look for:
- `Actual Execution Mode: Batch` (good for analytics)
- `Actual Execution Mode: Row` (fallback, investigate why)

Common reasons batch mode doesn't activate:
- Compat level < 130
- Outer query forces row mode (e.g., scalar UDF in SELECT list — see `07-functions.md`)
- Operator type doesn't support batch mode (e.g., key lookup)
- Trace flag 9453 (disables batch mode, used for testing)

---

## Analytics Patterns

### Star-schema join pattern

```sql
-- Typical star-schema query — designed to leverage columnstore
SELECT
    d.CalendarYear,
    p.ProductCategory,
    r.RegionName,
    SUM(f.Quantity)    AS TotalUnits,
    SUM(f.TotalAmount) AS TotalRevenue,
    AVG(f.UnitPrice)   AS AvgPrice
FROM dbo.FactSales f
JOIN dbo.DimDate    d ON f.SaleDateKey = d.DateKey
JOIN dbo.DimProduct p ON f.ProductID   = p.ProductID
JOIN dbo.DimRegion  r ON f.RegionID    = r.RegionID
WHERE d.CalendarYear BETWEEN 2021 AND 2023
  AND p.ProductCategory = 'Electronics'
GROUP BY d.CalendarYear, p.ProductCategory, r.RegionName
ORDER BY d.CalendarYear, TotalRevenue DESC;
```

Best practices for columnstore-friendly analytics queries:
- Filter on the CCI's most selective columns early (drives segment elimination)
- Avoid `SELECT *` — only project needed columns (column pruning reduces I/O)
- Avoid scalar UDFs in the SELECT list (forces row mode)
- Minimize DISTINCT on high-cardinality columns (forces large hash aggregation)

### Running totals with window functions (batch mode aware)

```sql
-- Window aggregate — can use batch mode in 2019+
SELECT
    SaleDate,
    TotalAmount,
    SUM(TotalAmount) OVER (
        ORDER BY SaleDate
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS RunningTotal
FROM dbo.FactSales
WHERE SaleDate >= '2023-01-01';
```

> [!NOTE] SQL Server 2019
> Window aggregate operator in batch mode (`ROWS BETWEEN` framing) added in 2019 for compat level 150+.

### HTAP: Real-time analytics on OLTP table

```sql
-- NCCI on OLTP table for real-time analytics
-- Base table: clustered B-tree on OrderID (OLTP access pattern)
-- NCCI: analytics columns only

CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders_Analytics
ON dbo.Orders (OrderDate, CustomerID, ProductID, Quantity, TotalAmount, Status);

-- OLTP query — uses clustered B-tree
SELECT OrderID, CustomerID, Status
FROM dbo.Orders
WHERE OrderID = 12345678;

-- Analytics query — optimizer chooses NCCI
SELECT
    YEAR(OrderDate) AS OrderYear,
    MONTH(OrderDate) AS OrderMonth,
    SUM(TotalAmount) AS Revenue
FROM dbo.Orders
WHERE Status = 'Completed'
GROUP BY YEAR(OrderDate), MONTH(OrderDate);
```

---

## DML and Update Strategies

### How DML interacts with CCI

- **INSERT**: small batches go to delta store (B-tree); large batches (≥ 102,400 rows with TABLOCK) go directly to compressed rowgroups
- **DELETE**: rows are marked in the delete bitmap; not immediately removed from compressed segments
- **UPDATE**: implemented as DELETE + INSERT (logical) — old row added to delete bitmap, new row inserted into delta store

This means heavy UPDATE/DELETE workloads accumulate deleted rows in compressed segments, wasting space and requiring more rows scanned:

```sql
-- Check delete ratio
SELECT
    OBJECT_NAME(object_id) AS table_name,
    index_id,
    state_description,
    total_rows,
    deleted_rows,
    CAST(deleted_rows * 100.0 / NULLIF(total_rows, 0) AS DECIMAL(5,1)) AS pct_deleted
FROM sys.dm_db_column_store_row_group_physical_stats
WHERE OBJECT_NAME(object_id) = 'FactSales'
  AND state_description = 'COMPRESSED'
ORDER BY pct_deleted DESC;
```

**Threshold**: Consider rebuilding when average delete ratio exceeds ~20%.

### Partition switching for efficient loads

The sliding window pattern for columnstore fact tables:

```sql
-- Step 1: Prepare staging table with same structure + CCI
CREATE TABLE dbo.FactSales_Staging
(
    SaleID      INT  NOT NULL,
    SaleDate    DATE NOT NULL,
    Amount      DECIMAL(12,2) NOT NULL,
    INDEX CCI_Staging CLUSTERED COLUMNSTORE
);

-- Step 2: Load and compress staging data (full row groups)
INSERT INTO dbo.FactSales_Staging WITH (TABLOCK)
SELECT * FROM dbo.FactSales_Raw_Load
ORDER BY SaleDate;  -- sort for segment elimination

ALTER INDEX CCI_Staging ON dbo.FactSales_Staging
REORGANIZE WITH (COMPRESS_ALL_ROW_GROUPS = ON);

-- Step 3: Switch partition into main table
ALTER TABLE dbo.FactSales_Staging
SWITCH TO dbo.FactSales PARTITION @NewPartitionNumber;
```

See `references/10-partitioning.md` for full partition switching setup.

---

## Maintenance

### REBUILD vs REORGANIZE for columnstore

| Operation | Effect | Locking | Notes |
|---|---|---|---|
| `REBUILD` | Recreates all row groups, removes all deleted rows, re-sorts data | Table lock (row-lock with ONLINE=ON) | Full defragmentation; expensive |
| `REORGANIZE` | Compresses CLOSED delta stores; merges small rowgroups | Row-level, minimal blocking | Faster, doesn't remove deleted rows from compressed segments |
| `REORGANIZE WITH (COMPRESS_ALL_ROW_GROUPS = ON)` | Forces OPEN delta stores to close and compress | Same as REORGANIZE | Use after bulk loads |

```sql
-- Light maintenance: compress delta stores after incremental load
ALTER INDEX CCI_FactSales ON dbo.FactSales REORGANIZE
WITH (COMPRESS_ALL_ROW_GROUPS = ON);

-- Heavy maintenance: full rebuild (monthly or when >20% deleted rows)
ALTER INDEX CCI_FactSales ON dbo.FactSales REBUILD
WITH (ONLINE = ON, MAXDOP = 4);  -- ONLINE requires Enterprise
```

> [!NOTE] SQL Server 2017
> Resumable index rebuild (`RESUMABLE = ON`) available for clustered indexes. Columnstore resumable rebuild support is limited — check your specific build.

### Statistics on columnstore tables

CCI automatically maintains column statistics. The `REBUILD` operation also updates statistics. `REORGANIZE` does **not** update statistics.

After a REORGANIZE-only maintenance window:

```sql
-- Manually update statistics after REORGANIZE
UPDATE STATISTICS dbo.FactSales WITH FULLSCAN;
```

### Columnstore compression vs ROW/PAGE

Columnstore compression is separate from ROW/PAGE compression and generally achieves higher compression ratios:

```sql
-- Estimate columnstore compression savings
EXEC sp_estimate_data_compression_savings
    @schema_name = 'dbo',
    @object_name = 'FactSales',
    @index_id = NULL,
    @partition_number = NULL,
    @data_compression = 'COLUMNSTORE';

-- Also check COLUMNSTORE_ARCHIVE for rarely accessed cold data
EXEC sp_estimate_data_compression_savings
    @schema_name = 'dbo',
    @object_name = 'FactSales',
    @index_id = NULL,
    @partition_number = NULL,
    @data_compression = 'COLUMNSTORE_ARCHIVE';
```

`COLUMNSTORE_ARCHIVE` applies additional CPU-intensive compression (LZ + Xpress) for cold partitions at the cost of higher scan CPU:

```sql
-- Apply archive compression to old partitions
ALTER INDEX CCI_FactSales ON dbo.FactSales REBUILD
PARTITION = 1  -- old/cold partition
WITH (DATA_COMPRESSION = COLUMNSTORE_ARCHIVE);
```

---

## Gotchas / Anti-patterns

### 1. Columnstore on small tables

The optimizer may choose rowstore operators even with a CCI on small tables. Below ~100K rows, the overhead of delta stores and row group scanning can exceed rowstore B-tree performance. Columnstore shines at millions of rows.

### 2. Single-row lookups against CCI

```sql
-- Bad: CCI table, single-row lookup — full row group must be decompressed
SELECT * FROM dbo.FactSales WHERE SaleID = 12345678;

-- Better: Add a nonclustered B-tree index for point lookup
CREATE NONCLUSTERED INDEX IX_FactSales_SaleID ON dbo.FactSales (SaleID);
-- Optimizer will use the B-tree index for this query
```

### 3. Delta store scan performance degradation

Heavy insert workloads create many OPEN/CLOSED delta stores. Queries must scan delta stores as rowstore (row mode), potentially negating batch mode benefits. Monitor with `sys.dm_db_column_store_row_group_physical_stats` and run REORGANIZE after major loads.

### 4. LOB columns not supported in CCI

Columnstore does not support columns of type `VARCHAR(MAX)`, `NVARCHAR(MAX)`, `VARBINARY(MAX)`, `XML`, `TEXT`, `NTEXT`, `IMAGE`, `ROWVERSION`, `SQL_VARIANT`, `CLR types`, or `FILESTREAM`. If your table has these, you cannot create a CCI; use NCCI with only the non-LOB analytics columns.

```sql
-- This will FAIL if dbo.Orders has a Notes VARCHAR(MAX) column
CREATE CLUSTERED COLUMNSTORE INDEX CCI_Orders ON dbo.Orders;
-- Error: Column 'Notes' has a data type that cannot participate in a columnstore index.

-- Workaround: NCCI on non-LOB columns only
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Orders
ON dbo.Orders (OrderDate, CustomerID, Amount, Quantity);
-- Omit Notes column
```

### 5. Scalar UDF kills batch mode

A scalar UDF anywhere in the query (SELECT list, WHERE, JOIN) forces the entire query tree into row mode:

```sql
-- Bad: scalar UDF in SELECT list forces row mode
SELECT dbo.FormatCurrency(TotalAmount), SaleDate  -- row mode, slow
FROM dbo.FactSales;

-- Good: inline the logic or use an iTVF
SELECT FORMAT(TotalAmount, 'C', 'en-US'), SaleDate  -- batch mode eligible
FROM dbo.FactSales;
```

Exception: scalar UDF inlining (SQL Server 2019+) may resolve this — check `sys.sql_modules.is_inlineable`. See `references/07-functions.md`.

### 6. Memory grant sizing for columnstore

Columnstore operations (especially sort + bulk load into row groups) require large memory grants. Under memory pressure, these spill to tempdb and degrade to row mode. Monitor with:

```sql
SELECT
    session_id,
    granted_memory_kb,
    used_memory_kb,
    ideal_memory_kb,
    is_small,
    query_cost
FROM sys.dm_exec_query_memory_grants
WHERE session_id = @@SPID;
```

### 7. NOLOCK hints with columnstore

`WITH (NOLOCK)` on a CCI table does not reduce locking overhead (CCI uses row versioning, not lock-based isolation for scans). The hint is ignored for CCI scans but can cause issues with delta stores. Prefer `READ_COMMITTED_SNAPSHOT` isolation at the database level.

### 8. NOT IN / NOT EXISTS patterns defeat segment elimination

```sql
-- Segment elimination works for direct predicates
WHERE SaleDate >= '2023-01-01'           -- ✓ segment elimination

-- Segment elimination does NOT help with negation
WHERE SaleID NOT IN (SELECT SaleID FROM dbo.Returns)  -- ✗ full scan
```

### 9. Partitioned columnstore and STATISTICS_INCREMENTAL

For partitioned CCI tables, use `STATISTICS_INCREMENTAL = ON` to update statistics per partition rather than full-table scans:

```sql
-- Enable incremental stats on CCI fact table
CREATE STATISTICS ST_FactSales_SaleDate
ON dbo.FactSales (SaleDate)
WITH INCREMENTAL = ON;

-- Update only the latest partition
UPDATE STATISTICS dbo.FactSales ST_FactSales_SaleDate
WITH RESAMPLE ON PARTITIONS (24);  -- only partition 24
```

### 10. Columnstore on In-Memory OLTP tables

> [!NOTE] SQL Server 2016
> Nonclustered columnstore indexes on memory-optimized (Hekaton) tables are supported from SQL Server 2016+. See `references/18-in-memory-oltp.md` for memory-optimized table constraints.

---

## See Also

- [`references/08-indexes.md`](08-indexes.md) — B-tree index internals, fill factor, fragmentation
- [`references/10-partitioning.md`](10-partitioning.md) — Partition switching with columnstore, sliding window pattern
- [`references/18-in-memory-oltp.md`](18-in-memory-oltp.md) — Columnstore on memory-optimized tables
- [`references/28-statistics.md`](28-statistics.md) — Statistics maintenance, STATISTICS_INCREMENTAL
- [`references/29-query-plans.md`](29-query-plans.md) — Reading batch mode vs row mode in execution plans
- [`references/31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — Batch mode on rowstore (2019+), memory grant feedback
- [`references/36-data-compression.md`](36-data-compression.md) — COLUMNSTORE_ARCHIVE compression, sp_estimate_data_compression_savings

---

## Sources

[^1]: [Columnstore indexes: Overview - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/columnstore-indexes-overview) — architecture concepts, rowgroup/delta store lifecycle, ordered CCI availability by platform
[^2]: [Intelligent Query Processing Details - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details) — batch mode on rowstore (compat level 150+), IQP feature details

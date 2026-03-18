# 36 — Data Compression

## Table of Contents

1. [When to Use](#when-to-use)
2. [Compression Overview](#compression-overview)
3. [ROW Compression](#row-compression)
4. [PAGE Compression](#page-compression)
5. [COLUMNSTORE Compression](#columnstore-compression)
6. [COLUMNSTORE_ARCHIVE Compression](#columnstore_archive-compression)
7. [Unicode Compression](#unicode-compression)
8. [Estimating Savings](#estimating-savings)
9. [Applying Compression](#applying-compression)
10. [Online vs Offline Rebuild](#online-vs-offline-rebuild)
11. [Compression on Indexes](#compression-on-indexes)
12. [Compression and Backup Size](#compression-and-backup-size)
13. [Compression and CPU Trade-off](#compression-and-cpu-trade-off)
14. [Partitioned Tables](#partitioned-tables)
15. [Metadata Queries](#metadata-queries)
16. [Common Patterns](#common-patterns)
17. [Gotchas](#gotchas)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

Apply data compression when:

- Storage cost matters (SAN/cloud disk is expensive or limited)
- Buffer pool pressure is present — compressed pages mean more data fits in RAM, reducing I/O
- CPU headroom exists — compression trades CPU for I/O; CPU-bound workloads may regress
- Tables have low-cardinality columns, repeating strings, or sparse numeric data (PAGE especially effective)
- Cold historical partitions exist — COLUMNSTORE_ARCHIVE for rarely-accessed data

Do **not** apply compression when:
- CPU is already saturated (e.g., reporting server under heavy analytical load)
- Tables are tiny (< a few hundred MB) — compression overhead is not worth the rebuild
- Data is already dense with high-entropy values (random GUIDs, already-encrypted columns)

---

## Compression Overview

| Type | Algorithm | Savings typical | CPU cost | Use case |
|---|---|---|---|---|
| `NONE` | — | 0% | none | baseline |
| `ROW` | Fixed → variable-length storage, removes trailing zeros/spaces | 20–40% | low | OLTP tables with fixed-width columns, variable data |
| `PAGE` | ROW + prefix/dictionary compression at page level | 40–70% | medium | moderate OLTP, read-heavy tables |
| `COLUMNSTORE` | Column segment encoding (RLE, value encoding, etc.) | 5×–10× vs heap | varies | columnstore indexes only |
| `COLUMNSTORE_ARCHIVE` | Aggressive XPRESS compression on top of COLUMNSTORE | 2×–4× additional | high on access | cold partitions, archival |

Compression setting is stored **per object** (heap, clustered index, individual nonclustered index) and **per partition** for partitioned objects.

---

## ROW Compression

ROW compression stores fixed-length data types (INT, CHAR, DATETIME, etc.) using the minimum bytes required, just like variable-length types do.

**What ROW compression does:**
- `INT` column holding value `5` is stored in 1 byte instead of 4
- `CHAR(100)` column holding `'ABC'` is stored as 3 bytes instead of 100
- Trailing zeros in numerics removed
- NULL bitmap optimized — fixed overhead columns no longer reserve full space for NULLs

**What ROW compression does not do:**
- No cross-row deduplication
- No prefix/dictionary compression
- No change to actual data type metadata

```sql
-- Apply ROW compression to a heap or clustered index
ALTER TABLE dbo.Orders
REBUILD WITH (DATA_COMPRESSION = ROW);

-- Apply to a nonclustered index by index name
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
REBUILD WITH (DATA_COMPRESSION = ROW);

-- Apply to a nonclustered index by index_id
ALTER TABLE dbo.Orders
REBUILD PARTITION = ALL
WITH (DATA_COMPRESSION = ROW);
```

> [!NOTE] SQL Server 2008
> ROW and PAGE compression were introduced in SQL Server 2008. Available in Enterprise and Developer editions only in older versions; available in Standard edition since SQL Server 2016 SP1.

---

## PAGE Compression

PAGE compression applies ROW compression first, then two additional steps:

1. **Prefix compression** — for each column, finds the longest common byte prefix among values on a page, stores it once in a header, replaces occurrences with a reference
2. **Dictionary compression** — scans the entire page for repeated byte sequences, stores them in a dictionary, replaces occurrences with 2-byte references

PAGE compression is applied per data page. If a page does not achieve at least the same size as an uncompressed page, it is left uncompressed (mixed pages are possible within a single object).

```sql
-- Apply PAGE compression
ALTER TABLE dbo.OrderHistory
REBUILD WITH (DATA_COMPRESSION = PAGE);

-- Check current compression settings
SELECT
    i.name         AS index_name,
    p.data_compression_desc,
    p.partition_number,
    p.rows
FROM sys.partitions p
JOIN sys.indexes i ON i.object_id = p.object_id AND i.index_id = p.index_id
WHERE p.object_id = OBJECT_ID('dbo.OrderHistory')
ORDER BY p.partition_number;
```

**PAGE vs ROW guidance:**

| Scenario | Recommendation |
|---|---|
| Many NULLs, short strings, repeated values | PAGE — dictionary compression pays off |
| Randomly ordered data (GUIDs, hashes) | ROW — PAGE prefix/dict finds little to compress |
| Tables mostly accessed via point seeks | ROW — CPU cost of PAGE decryption per seek |
| Sequential scans, reporting tables | PAGE — amortizes decompression cost over many rows |
| Already highly normalized, low cardinality FKs | PAGE — FK columns compress well with dictionary |

---

## COLUMNSTORE Compression

Columnstore compression is **only valid for columnstore indexes** (CCI and NCCI) — it cannot be applied to rowstore heaps or B-tree indexes.

Within a columnstore index, the engine selects among several encoding algorithms per column segment:

- **Value encoding** — store delta from minimum value using minimum bit width
- **Run-length encoding (RLE)** — store (value, count) pairs for sorted/repeated data
- **Dictionary encoding** — store a value dictionary + integer references (like PAGE but per column)
- **Bit-packing** — pack multiple small values into a single integer word

The encoding chosen is determined at compression time (when the delta store is compressed by the tuple mover). You cannot choose the algorithm — the optimizer selects the best one per segment.

```sql
-- Create a clustered columnstore index (default COLUMNSTORE compression)
CREATE CLUSTERED COLUMNSTORE INDEX CCI_FactSales
ON dbo.FactSales;

-- Create an NCCI with COLUMNSTORE compression (explicit, default)
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_FactSales_Analytics
ON dbo.FactSales (OrderDate, ProductID, Qty, Amount)
WITH (DATA_COMPRESSION = COLUMNSTORE);
```

See `references/09-columnstore-indexes.md` for full columnstore architecture.

---

## COLUMNSTORE_ARCHIVE Compression

COLUMNSTORE_ARCHIVE applies additional XPRESS (LZ) compression on top of normal columnstore encoding. It significantly increases compression but at the cost of higher decompression CPU overhead.

**Target use case:** cold partitions that are rarely queried — historical archives, compliance retention tables.

```sql
-- Apply COLUMNSTORE_ARCHIVE to a single partition (partition 1 = oldest)
ALTER TABLE dbo.FactSales
REBUILD PARTITION = 1
WITH (DATA_COMPRESSION = COLUMNSTORE_ARCHIVE);

-- Apply to all partitions of a columnstore index
ALTER TABLE dbo.FactSales
REBUILD PARTITION = ALL
WITH (DATA_COMPRESSION = COLUMNSTORE_ARCHIVE);

-- Revert to normal COLUMNSTORE for a partition that becomes "warm"
ALTER TABLE dbo.FactSales
REBUILD PARTITION = 12
WITH (DATA_COMPRESSION = COLUMNSTORE);
```

> [!NOTE] SQL Server 2014
> COLUMNSTORE_ARCHIVE was introduced in SQL Server 2014.

**Typical additional savings over COLUMNSTORE:** 2×–4× depending on data entropy. A 100 GB partition at COLUMNSTORE may compress to 25 GB at COLUMNSTORE_ARCHIVE.

---

## Unicode Compression

SQL Server automatically applies standard compression (SC) to `NCHAR` and `NVARCHAR` columns when ROW or PAGE compression is enabled. This uses the Standard Compression Scheme for Unicode (SCSU) to reduce storage for ASCII-range Unicode characters from 2 bytes to 1 byte.

**Effect:** `NVARCHAR(100)` storing ASCII text compresses to the same size as `VARCHAR(100)`. This is a significant win for databases that use `NVARCHAR` everywhere for Unicode readiness but store mostly ASCII data.

You do not need to configure Unicode compression separately — it activates automatically under ROW or PAGE compression.

---

## Estimating Savings

Use `sp_estimate_data_compression_savings` before committing to a compression change. It samples the table and projects compressed size without modifying data.

```sql
-- Estimate ROW compression savings
EXEC sp_estimate_data_compression_savings
    @schema_name = 'dbo',
    @object_name = 'Orders',
    @index_id    = NULL,    -- NULL = all indexes
    @partition_number = NULL, -- NULL = all partitions
    @data_compression = 'ROW';

-- Estimate PAGE compression savings
EXEC sp_estimate_data_compression_savings
    @schema_name = 'dbo',
    @object_name = 'Orders',
    @index_id    = NULL,
    @partition_number = NULL,
    @data_compression = 'PAGE';
```

**Output columns:**

| Column | Meaning |
|---|---|
| `object_name` | Table name |
| `schema_name` | Schema |
| `index_id` | 0 = heap, 1 = clustered, 2+ = nonclustered |
| `partition_number` | Partition (1 if not partitioned) |
| `size_with_current_compression_setting_KB` | Current size |
| `size_with_requested_compression_setting_KB` | Projected size |
| `sample_size_with_current_compression_setting_KB` | Sample used |
| `sample_size_with_requested_compression_setting_KB` | Projected sample |

**Important caveats:**
- Uses a statistical sample (not full scan) — results are estimates, not guarantees
- Actual compression ratio can differ based on data distribution not in the sample
- Does not account for CPU overhead of decompression at query time
- Running the proc does not modify the table

```sql
-- Run estimation for all user tables and collect results
DECLARE @results TABLE (
    object_name     SYSNAME,
    schema_name     SYSNAME,
    index_id        INT,
    partition_number INT,
    current_size_KB BIGINT,
    page_size_KB    BIGINT,
    row_size_KB     BIGINT
);

DECLARE @schema SYSNAME, @obj SYSNAME;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT s.name, t.name
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE t.is_ms_shipped = 0;

OPEN cur;
FETCH NEXT FROM cur INTO @schema, @obj;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- PAGE estimate
    INSERT INTO @results (object_name, schema_name, index_id, partition_number, current_size_KB, page_size_KB, row_size_KB)
    SELECT object_name, schema_name, index_id, partition_number,
           size_with_current_compression_setting_KB,
           size_with_requested_compression_setting_KB,
           NULL
    FROM OPENROWSET(
        'SQLNCLI', 'Server=.;Trusted_Connection=yes;',
        'EXEC sp_estimate_data_compression_savings ''' + @schema + ''', ''' + @obj + ''', NULL, NULL, ''PAGE'''
    ) -- Note: OPENROWSET approach is complex; prefer direct EXEC in a loop with temp table
    ;
    FETCH NEXT FROM cur INTO @schema, @obj;
END
CLOSE cur; DEALLOCATE cur;
-- Simpler: run sp_estimate_data_compression_savings per table individually
```

> [!NOTE]
> For large environments, script the estimation loop using a temp table and EXEC with INSERT...EXEC per table.

---

## Applying Compression

Compression is applied (or changed) by rebuilding the object. This rewrites all data pages with the new encoding.

```sql
-- Heap: compress/decompress with ALTER TABLE REBUILD
ALTER TABLE dbo.Orders
REBUILD WITH (DATA_COMPRESSION = PAGE);

-- Clustered index (index_id = 1): same syntax
ALTER TABLE dbo.Orders
REBUILD WITH (DATA_COMPRESSION = PAGE);

-- Specific nonclustered index by name
ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
REBUILD WITH (DATA_COMPRESSION = PAGE);

-- All indexes on a table at once
ALTER TABLE dbo.Orders
REBUILD PARTITION = ALL
WITH (DATA_COMPRESSION = PAGE);

-- Remove compression
ALTER TABLE dbo.Orders
REBUILD WITH (DATA_COMPRESSION = NONE);
```

**Compression does not automatically apply to nonclustered indexes** when you compress the clustered index or heap. Each index must be set independently (or via `REBUILD PARTITION = ALL`).

---

## Online vs Offline Rebuild

The `ONLINE = ON` option allows compression changes without blocking concurrent DML.

```sql
-- Online rebuild with compression change (Enterprise edition)
ALTER TABLE dbo.Orders
REBUILD WITH (
    DATA_COMPRESSION = PAGE,
    ONLINE = ON
);

-- Online with wait policy (2014+)
ALTER TABLE dbo.Orders
REBUILD WITH (
    DATA_COMPRESSION = PAGE,
    ONLINE = ON (WAIT_AT_LOW_PRIORITY (MAX_DURATION = 5 MINUTES, ABORT_AFTER_WAIT = SELF))
);

-- Resumable online rebuild (2017+)
ALTER TABLE dbo.Orders
REBUILD WITH (
    DATA_COMPRESSION = PAGE,
    ONLINE = ON,
    RESUMABLE = ON,
    MAX_DURATION = 60  -- minutes per session
);
```

**Online vs offline comparison:**

| Dimension | ONLINE = ON | ONLINE = OFF (default) |
|---|---|---|
| DML blocking | None during rebuild | SCH-M at start and end only |
| Temp space needed | ~1.25× table size (old + new) | ~1× table size |
| Duration | Slightly longer (versioning overhead) | Faster |
| Edition requirement | Enterprise (or Developer) | All editions |
| Resumable | Yes (2017+) | No |

> [!NOTE] SQL Server 2016 SP1
> Online index rebuild is available in Standard edition starting with SQL Server 2016 SP1.

> [!WARNING] Deprecated
> `MAXDOP = 1` during rebuild forces single-threaded operation. Use `MAXDOP = 0` (default) for maximum parallelism or tune with Resource Governor.

---

## Compression on Indexes

Each index (clustered, nonclustered, XML, spatial, columnstore) has its own compression setting. Changing the compression on the heap or clustered index does **not** propagate to nonclustered indexes.

**Recommended approach for an OLTP table with multiple indexes:**

```sql
-- Step 1: Estimate savings for each index
EXEC sp_estimate_data_compression_savings 'dbo', 'Orders', 0, NULL, 'PAGE'; -- heap
EXEC sp_estimate_data_compression_savings 'dbo', 'Orders', 1, NULL, 'PAGE'; -- CI
EXEC sp_estimate_data_compression_savings 'dbo', 'Orders', 2, NULL, 'PAGE'; -- NCI 1
EXEC sp_estimate_data_compression_savings 'dbo', 'Orders', 3, NULL, 'PAGE'; -- NCI 2

-- Step 2: Decide per-index (some NCI covering indexes may not compress well)

-- Step 3: Apply per-index with ONLINE = ON
ALTER INDEX PK_Orders ON dbo.Orders
    REBUILD WITH (DATA_COMPRESSION = PAGE, ONLINE = ON);

ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
    REBUILD WITH (DATA_COMPRESSION = ROW, ONLINE = ON);

ALTER INDEX IX_Orders_Date ON dbo.Orders
    REBUILD WITH (DATA_COMPRESSION = PAGE, ONLINE = ON);
```

**Consideration for NCI covering indexes:**
- NCIs with few columns and high-entropy data (GUIDs, hashes, datetimes) compress poorly
- NCIs with repeated FK column values compress well under PAGE

---

## Compression and Backup Size

Compressed tables reduce backup file size because backup compression operates on the already-compressed data pages. However, the relationship is not multiplicative:

- ROW/PAGE compressed tables: backup compression sees less redundancy, may not compress backup file further
- Uncompressed tables: backup compression often achieves 4×–10× reduction on typical OLTP data
- For already-compressed data: backup compression overhead with minimal benefit

**Practical guidance:**
- Use `BACKUP ... WITH COMPRESSION` regardless of table compression — it is almost always a net win on uncompressed data and adds minimal overhead on already-compressed data
- Do not expect `data compression + backup compression = multiplicative saving`
- PAGE compressed databases often have backup files only 10–20% smaller than ROW compressed databases

```sql
-- Backup with compression (applies to all pages including compressed ones)
BACKUP DATABASE AdventureWorks2022
TO DISK = N'C:\Backups\AW2022.bak'
WITH COMPRESSION, STATS = 10;
```

---

## Compression and CPU Trade-off

Every read of a compressed page requires CPU decompression. Every write of a new/modified row requires CPU compression. The trade-off:

**When compression helps performance (net win):**
- I/O-bound workloads — more data fits in buffer pool, fewer physical reads
- Table/index scans — decompression cost amortized across many rows per I/O
- Insufficient RAM — buffer pool hit rate increases with compressed pages

**When compression hurts performance (net loss):**
- CPU-bound workloads — decompression overhead compounds
- High-frequency point lookups — each seek decompresses a page for 1 row
- OLTP write-heavy tables — compression on every INSERT/UPDATE

**Measuring the trade-off:**

```sql
-- Measure logical reads before and after compression using SET STATISTICS IO
SET STATISTICS IO ON;
SET STATISTICS TIME ON;

SELECT COUNT(*) FROM dbo.Orders WHERE OrderDate >= '2023-01-01';

SET STATISTICS IO OFF;
SET STATISTICS TIME OFF;

-- Also check CPU waits and SOS_SCHEDULER_YIELD in wait stats after applying compression
SELECT wait_type, waiting_tasks_count, wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type IN ('SOS_SCHEDULER_YIELD', 'CXPACKET', 'CXCONSUMER')
ORDER BY wait_time_ms DESC;
```

---

## Partitioned Tables

Compression can be applied per partition, enabling a tiered storage strategy:

```sql
-- Apply different compression per partition (sliding window pattern)
-- Partition 1 (oldest) = COLUMNSTORE_ARCHIVE
-- Partitions 2-11 (historical) = PAGE
-- Partition 12 (current) = ROW (writes are frequent)

ALTER TABLE dbo.FactSales REBUILD PARTITION = 1
    WITH (DATA_COMPRESSION = COLUMNSTORE_ARCHIVE);

ALTER TABLE dbo.FactSales REBUILD PARTITION = 2
    WITH (DATA_COMPRESSION = PAGE);
-- ... repeat for 3-11

ALTER TABLE dbo.FactSales REBUILD PARTITION = 12
    WITH (DATA_COMPRESSION = ROW);
```

**Sliding window with compression promotion:**
When a new partition is added and the current partition becomes historical:

```sql
-- New month becomes partition 12 (ROW)
-- Previous partition 12 demoted to PAGE
ALTER TABLE dbo.FactSales REBUILD PARTITION = 11
    WITH (DATA_COMPRESSION = PAGE);

-- Oldest partition promoted to COLUMNSTORE_ARCHIVE (if columnstore)
-- or archived/removed via SWITCH
```

For partitioned tables, `sp_estimate_data_compression_savings` accepts a specific `@partition_number`:

```sql
EXEC sp_estimate_data_compression_savings 'dbo', 'FactSales', 1, 1, 'PAGE';
```

---

## Metadata Queries

```sql
-- All compression settings for all objects in the database
SELECT
    SCHEMA_NAME(o.schema_id)    AS schema_name,
    o.name                      AS object_name,
    i.name                      AS index_name,
    i.type_desc                 AS index_type,
    p.partition_number,
    p.data_compression_desc,
    p.rows,
    SUM(a.total_pages) * 8 / 1024 AS total_MB,
    SUM(a.used_pages)  * 8 / 1024 AS used_MB
FROM sys.partitions p
JOIN sys.objects o ON o.object_id = p.object_id
JOIN sys.indexes i ON i.object_id = p.object_id AND i.index_id = p.index_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE o.is_ms_shipped = 0
  AND o.type = 'U'
GROUP BY
    SCHEMA_NAME(o.schema_id), o.name,
    i.name, i.type_desc,
    p.partition_number, p.data_compression_desc, p.rows
ORDER BY total_MB DESC;

-- Tables with no compression (candidates for compression)
SELECT
    SCHEMA_NAME(o.schema_id) AS schema_name,
    o.name                   AS table_name,
    SUM(a.total_pages) * 8 / 1024 AS total_MB
FROM sys.partitions p
JOIN sys.objects o ON o.object_id = p.object_id
JOIN sys.indexes i ON i.object_id = p.object_id AND i.index_id = p.index_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE o.is_ms_shipped = 0
  AND o.type = 'U'
  AND p.data_compression_desc = 'NONE'
GROUP BY SCHEMA_NAME(o.schema_id), o.name
HAVING SUM(a.total_pages) * 8 / 1024 > 100  -- > 100 MB, worth evaluating
ORDER BY total_MB DESC;

-- Show compressed vs uncompressed breakdown
SELECT
    data_compression_desc,
    COUNT(DISTINCT p.object_id) AS object_count,
    SUM(p.rows) AS total_rows,
    SUM(a.total_pages) * 8 / 1024 AS total_MB
FROM sys.partitions p
JOIN sys.objects o ON o.object_id = p.object_id
JOIN sys.indexes i ON i.object_id = p.object_id AND i.index_id = p.index_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE o.is_ms_shipped = 0 AND o.type = 'U'
GROUP BY data_compression_desc
ORDER BY total_MB DESC;
```

---

## Common Patterns

### Pattern 1: OLTP table with hot/cold partitions

```sql
-- Hot partition (current month) = ROW: fast writes, light compression
ALTER TABLE dbo.Orders REBUILD PARTITION = 12
    WITH (DATA_COMPRESSION = ROW);

-- Warm partitions (last 12 months) = PAGE: good read compression, acceptable write cost
ALTER TABLE dbo.Orders REBUILD PARTITION = 1  -- replace with correct partition range
    WITH (DATA_COMPRESSION = PAGE);
```

### Pattern 2: Read-heavy reporting table

```sql
-- Full PAGE compression on all indexes
ALTER TABLE dbo.ReportingOrders
    REBUILD WITH (DATA_COMPRESSION = PAGE);

-- Also compress all nonclustered indexes
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER INDEX ' + QUOTENAME(i.name)
    + N' ON ' + QUOTENAME(SCHEMA_NAME(o.schema_id)) + N'.' + QUOTENAME(o.name)
    + N' REBUILD WITH (DATA_COMPRESSION = PAGE, ONLINE = ON);' + CHAR(10)
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
WHERE o.name = 'ReportingOrders'
  AND i.type > 1  -- nonclustered only
  AND i.is_disabled = 0;
EXEC sp_executesql @sql;
```

### Pattern 3: Evaluate before applying

```sql
-- Collect estimates for all user tables > 500 MB
CREATE TABLE #compression_estimates (
    object_name     SYSNAME,
    schema_name     SYSNAME,
    index_id        INT,
    partition_number INT,
    current_size_KB BIGINT,
    requested_size_KB BIGINT,
    sample_current_KB BIGINT,
    sample_requested_KB BIGINT
);

DECLARE @schema SYSNAME, @obj SYSNAME;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT SCHEMA_NAME(o.schema_id), o.name
    FROM sys.objects o
    JOIN sys.partitions p ON p.object_id = o.object_id
    JOIN sys.allocation_units a ON a.container_id = p.partition_id
    WHERE o.is_ms_shipped = 0 AND o.type = 'U'
    GROUP BY SCHEMA_NAME(o.schema_id), o.name
    HAVING SUM(a.total_pages) * 8 / 1024 > 500;

OPEN cur;
FETCH NEXT FROM cur INTO @schema, @obj;
WHILE @@FETCH_STATUS = 0
BEGIN
    INSERT INTO #compression_estimates
    EXEC sp_estimate_data_compression_savings @schema, @obj, NULL, NULL, 'PAGE';
    FETCH NEXT FROM cur INTO @schema, @obj;
END
CLOSE cur; DEALLOCATE cur;

SELECT *,
    CAST(100.0 * (current_size_KB - requested_size_KB) / NULLIF(current_size_KB, 0) AS DECIMAL(5,1))
        AS savings_pct
FROM #compression_estimates
WHERE index_id <= 1  -- heap or clustered only for summary
ORDER BY current_size_KB DESC;
```

### Pattern 4: Ola Hallengren integration

Ola Hallengren's `IndexOptimize` stored procedure supports compression parameters:

```sql
EXEC dbo.IndexOptimize
    @Databases = 'AdventureWorks2022',
    @FragmentationLow  = NULL,
    @FragmentationMedium = 'INDEX_REORGANIZE,INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE',
    @FragmentationHigh = 'INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE',
    @Compress = 'Y',
    @DataCompression = 'PAGE';  -- applies PAGE if current setting is NONE
```

[^1]

---

## Gotchas

1. **Compression applies to indexes independently.** `ALTER TABLE ... REBUILD` compresses the heap or clustered index; nonclustered indexes keep their old setting. Use `REBUILD PARTITION = ALL` or alter each index separately.

2. **sp_estimate_data_compression_savings is a sample, not a guarantee.** Small tables or tables with unusual data distributions can have estimates significantly off. Always verify with a test partition before committing to full production compression.

3. **PAGE compression is not always better than ROW.** For tables with point-lookup OLTP patterns, the extra decompression work of PAGE vs ROW can measurably increase CPU with minimal additional I/O savings.

4. **Backup compression and data compression are independent.** Having PAGE-compressed tables does not mean backups are smaller — backup compression (`BACKUP ... WITH COMPRESSION`) applies its own algorithm separately.

5. **`ONLINE = ON` requires Enterprise (or Standard 2016 SP1+).** Offline rebuilds take a SCH-M lock for the entire duration on Standard edition in older versions, blocking all access.

6. **ROW/PAGE compression cannot be applied to columnstore indexes.** Columnstore objects only accept `COLUMNSTORE` or `COLUMNSTORE_ARCHIVE`.

7. **COLUMNSTORE_ARCHIVE slows queries significantly.** It is designed for cold data. Applying it to frequently accessed data will hurt query performance noticeably. Monitor with `sys.dm_db_index_usage_stats` before applying.

8. **Compression change does not cascade to statistics.** After a rebuild with compression, statistics are updated as a side effect of the rebuild. However, filtered statistics or manual statistics may need separate updating.

9. **Memory-optimized tables (Hekaton) do not support ROW or PAGE compression.** Use natively compiled stored procedures for other performance gains.

10. **Mixed partition compression is valid but complex.** A table can have partition 1 at PAGE and partition 2 at ROW. When the query plan chooses a partition, the engine handles decompression transparently, but mixed compression makes capacity planning harder.

11. **Sparse columns interact with compression.** Sparse columns already store NULLs without page space, but ROW/PAGE compression can still be applied to the rest of the row. The two features are complementary.

12. **Compression rebuild generates transaction log.** Large table rebuilds create significant log activity. Schedule during off-peak hours or in stages (partition by partition) if log disk is limited.

---

## See Also

- `references/08-indexes.md` — index rebuild vs reorganize, fill factor, fragmentation
- `references/09-columnstore-indexes.md` — columnstore architecture, COLUMNSTORE/COLUMNSTORE_ARCHIVE in context
- `references/10-partitioning.md` — per-partition compression, sliding window pattern
- `references/34-tempdb.md` — temp tables and compression (temp tables can be compressed)
- `references/44-backup-restore.md` — backup compression with `BACKUP ... WITH COMPRESSION`
- `references/35-dbcc-commands.md` — DBCC SHOWCONTIG (deprecated), monitoring page density post-compression

---

## Sources

[^1]: [SQL Server Index and Statistics Maintenance](https://ola.hallengren.com/sql-server-index-and-statistics-maintenance.html) — Ola Hallengren's IndexOptimize procedure, including the `@DataCompression` parameter for applying compression during index maintenance
[^2]: [sp_estimate_data_compression_savings (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-estimate-data-compression-savings-transact-sql) — T-SQL reference for the stored procedure that estimates space savings before applying compression
[^3]: [Row compression implementation - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/data-compression/row-compression-implementation) — internals of ROW compression: how fixed-length types are stored using variable-length format, per-type storage impact
[^4]: [Data compression - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/data-compression/data-compression) — overview of ROW, PAGE, COLUMNSTORE, and COLUMNSTORE_ARCHIVE compression, including prefix/dictionary compression details and partitioned table considerations
[^5]: [Columnstore indexes: Overview - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/columnstore-indexes-overview) — columnstore index architecture, compression, and COLUMNSTORE_ARCHIVE archival compression
[^6]: [Editions and Supported Features - SQL Server 2016](https://learn.microsoft.com/en-us/sql/sql-server/editions-and-components-of-sql-server-2016) — feature matrix confirming data compression availability in Standard edition via SQL Server 2016 SP1 Common Programmability Surface Area
[^7]: [Unicode compression implementation - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/data-compression/unicode-compression-implementation) — details of SCSU-based Unicode compression for NCHAR/NVARCHAR columns under ROW or PAGE compression

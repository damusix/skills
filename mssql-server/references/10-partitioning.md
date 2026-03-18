# Table Partitioning

## Table of Contents

1. [When to Use](#when-to-use)
2. [Partitioning Architecture](#partitioning-architecture)
3. [Partition Functions](#partition-functions)
4. [Partition Schemes](#partition-schemes)
5. [Creating Partitioned Tables and Indexes](#creating-partitioned-tables-and-indexes)
6. [Partition Switching (Sliding Window)](#partition-switching-sliding-window)
7. [Aligned Indexes](#aligned-indexes)
8. [Partition Elimination](#partition-elimination)
9. [STATISTICS_INCREMENTAL](#statistics_incremental)
10. [Managing Partitions](#managing-partitions)
11. [Querying Partition Metadata](#querying-partition-metadata)
12. [Partitioned Views vs Table Partitioning](#partitioned-views-vs-table-partitioning)
13. [Azure SQL Considerations](#azure-sql-considerations)
14. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
15. [See Also](#see-also)
16. [Sources](#sources)

---

## When to Use

Partition a table when **one or more** of the following apply:

| Scenario | Why partitioning helps |
|---|---|
| Rolling window data (logs, events, sales) | Fast partition switch OUT for archival; switch IN for pre-staged loads |
| Table is very large (100M+ rows) AND queries filter on the partition key | Partition elimination reduces I/O dramatically |
| Regular bulk loads of dated data | Load into a staging table, then switch IN atomically |
| Differential backups / filegroup-level backup strategy | Each partition on its own filegroup enables filegroup backup |
| Mixed hot/cold data access patterns | Hot partitions on fast storage, cold on cheaper storage |

**Do not partition a table just because it is large.** If queries do not filter on the partition key, you get the overhead without the benefit. A well-designed index often outperforms partitioning for OLTP tables.

> [!NOTE] Partition count limits
> SQL Server supports up to 15,000 partitions per table (raised from 1,000 prior to SQL Server 2012). More than a few hundred partitions is unusual and adds metadata overhead.

---

## Partitioning Architecture

```
Partition Function
  │  defines boundary values and range direction
  │
  └─► Partition Scheme
        │  maps partition numbers → filegroups
        │
        └─► Table / Index
              │  references the scheme and specifies the partition column
```

**Key concepts:**

| Term | Definition |
|---|---|
| **Partition function** | Defines how rows are split based on boundary values of a column. Lives at the database level. |
| **Partition scheme** | Maps each partition number to a filegroup. References a partition function. Lives at the database level. |
| **Partition column** | The column in the table/index that the function evaluates. Must be a single column. |
| **Boundary value** | A value in the partition function. N boundary values → N+1 partitions. |
| **RANGE LEFT / RANGE RIGHT** | Controls which partition a boundary value itself belongs to. |

### RANGE LEFT vs RANGE RIGHT

```
Boundary values: (20231231, 20240331)

RANGE LEFT:  partition 1 = col <= 20231231
             partition 2 = col >  20231231 AND col <= 20240331
             partition 3 = col >  20240331

RANGE RIGHT: partition 1 = col <  20231231
             partition 2 = col >= 20231231 AND col <  20240340
             partition 3 = col >= 20240331
```

**Convention:** Use `RANGE RIGHT` for date-based sliding windows. The boundary value is the start of the new partition, which maps naturally to "January 1 starts Q1".

---

## Partition Functions

```sql
-- Monthly partitioning on an integer YYYYMM key
CREATE PARTITION FUNCTION pf_monthly (int)
AS RANGE RIGHT
FOR VALUES (
    202301, 202302, 202303, 202304,
    202305, 202306, 202307, 202308,
    202309, 202310, 202311, 202312,
    202401
);
-- Creates 15 partitions: one catch-all left of 202301, 12 monthly, one right of 202312

-- Date-based partition function
CREATE PARTITION FUNCTION pf_daily (date)
AS RANGE RIGHT
FOR VALUES (
    '2024-01-01', '2024-02-01', '2024-03-01',
    '2024-04-01', '2024-05-01', '2024-06-01'
);

-- Drop a partition function (must have no schemes using it)
DROP PARTITION FUNCTION pf_monthly;

-- View current boundary values
SELECT
    pf.name,
    prv.boundary_id,
    prv.value,
    CASE pf.boundary_value_on_right
        WHEN 1 THEN 'RANGE RIGHT'
        ELSE 'RANGE LEFT'
    END AS range_type
FROM sys.partition_functions pf
JOIN sys.partition_range_values prv ON pf.function_id = prv.function_id
WHERE pf.name = 'pf_monthly'
ORDER BY prv.boundary_id;
```

---

## Partition Schemes

```sql
-- Map all partitions to the same filegroup (simplest)
CREATE PARTITION SCHEME ps_monthly
AS PARTITION pf_monthly
ALL TO ([PRIMARY]);

-- Map partitions to different filegroups (enables filegroup backup strategy)
CREATE PARTITION SCHEME ps_monthly_fg
AS PARTITION pf_monthly
TO (
    fg_archive,   -- partition 1 (before 202301)
    fg_2023_01,   -- partition 2 (202301)
    fg_2023_02,   -- partition 3 (202302)
    -- ... one entry per partition
    fg_current    -- must include one extra for NEXT USED
);

-- Mark a filegroup as "next used" for SPLIT (required before adding a boundary)
ALTER PARTITION SCHEME ps_monthly
NEXT USED [PRIMARY];

-- Drop a scheme (must have no tables/indexes using it)
DROP PARTITION SCHEME ps_monthly;
```

> [!NOTE] NEXT USED
> Before calling `ALTER PARTITION FUNCTION ... SPLIT RANGE`, you must set `NEXT USED` on the scheme. The new partition created by the split will land on that filegroup.

---

## Creating Partitioned Tables and Indexes

### Partitioned heap

```sql
CREATE TABLE dbo.SalesEvents (
    EventID     bigint       NOT NULL,
    EventDate   date         NOT NULL,
    CustomerID  int          NOT NULL,
    Amount      money        NOT NULL,
    Payload     nvarchar(500) NULL
)
ON ps_monthly (EventDate);  -- reference the scheme, not a filegroup
```

### Partitioned clustered index

```sql
CREATE TABLE dbo.SalesEvents (
    EventID     bigint NOT NULL,
    EventDate   date   NOT NULL,
    CustomerID  int    NOT NULL,
    Amount      money  NOT NULL
);

-- Partition column MUST be part of the clustered index key
CREATE CLUSTERED INDEX cx_SalesEvents
ON dbo.SalesEvents (EventDate, EventID)
ON ps_monthly (EventDate);
```

> [!WARNING]
> If the partition column is not in the clustered index key, the table can still be partitioned — but partition elimination only works when the partition key appears in the query predicate, and the optimizer needs it in the index to enable efficient pruning. Best practice: include the partition column in the clustered index key.

### Partitioned nonclustered index (aligned)

```sql
-- Aligned index: uses the same partition scheme as the table
CREATE NONCLUSTERED INDEX ix_SalesEvents_CustomerID
ON dbo.SalesEvents (CustomerID)
INCLUDE (Amount)
ON ps_monthly (EventDate);   -- same function, same column
```

An aligned index is required for partition switching. See [Aligned Indexes](#aligned-indexes).

---

## Partition Switching (Sliding Window)

Partition switching is a **metadata-only operation** — no data moves. It is near-instantaneous even for billions of rows.

### Full sliding window workflow

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Add a new empty partition for the incoming month
-- ─────────────────────────────────────────────────────────────────────────────
ALTER PARTITION SCHEME ps_monthly NEXT USED [PRIMARY];

ALTER PARTITION FUNCTION pf_monthly ()
SPLIT RANGE (202402);   -- adds boundary; new partition for 202402 and beyond

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Stage the new month's data into a separate table (identical schema)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE dbo.SalesEvents_Stage (
    EventID     bigint NOT NULL,
    EventDate   date   NOT NULL,
    CustomerID  int    NOT NULL,
    Amount      money  NOT NULL
)
ON [PRIMARY];

-- Load data into staging table
INSERT INTO dbo.SalesEvents_Stage
SELECT EventID, EventDate, CustomerID, Amount
FROM SomeSource
WHERE EventDate >= '2024-02-01' AND EventDate < '2024-03-01';

-- Rebuild or create required indexes on staging table
CREATE CLUSTERED INDEX cx_Stage
ON dbo.SalesEvents_Stage (EventDate, EventID)
ON [PRIMARY];

-- Verify no data falls outside the target partition range (required for switch)
-- This CHECK constraint tells the optimizer the data is in range
ALTER TABLE dbo.SalesEvents_Stage
ADD CONSTRAINT chk_Stage_Date
CHECK (EventDate >= '2024-02-01' AND EventDate < '2024-03-01');

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Switch IN — move staging table into the target partition
-- ─────────────────────────────────────────────────────────────────────────────
-- $PARTITION.pf_monthly('2024-02-01') returns the partition number = 14
DECLARE @partition_num int = $PARTITION.pf_monthly(CAST('2024-02-01' AS date));

ALTER TABLE dbo.SalesEvents_Stage
SWITCH TO dbo.SalesEvents PARTITION @partition_num;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Archive old partition — switch OUT to an archive table
-- ─────────────────────────────────────────────────────────────────────────────
-- Archive table must exist on the filegroup the partition currently lives on
CREATE TABLE dbo.SalesEvents_Archive_202301
ON [PRIMARY]
AS SELECT TOP 0 * FROM dbo.SalesEvents;

CREATE CLUSTERED INDEX cx_Archive ON dbo.SalesEvents_Archive_202301
(EventDate, EventID) ON [PRIMARY];

ALTER TABLE dbo.SalesEvents
SWITCH PARTITION $PARTITION.pf_monthly(CAST('2023-01-15' AS date))
TO dbo.SalesEvents_Archive_202301;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Merge the now-empty boundary to remove the old partition
-- ─────────────────────────────────────────────────────────────────────────────
ALTER PARTITION FUNCTION pf_monthly ()
MERGE RANGE (202301);   -- merges partition 2 (202301) into partition 1; partition 1 must be empty
```

### Switch requirements checklist

| Requirement | Notes |
|---|---|
| Source and target table schemas must match | Exactly: column names, types, nullability, computed columns, constraints |
| All indexes must be aligned | Same partition function and column; or no indexes at all |
| Source partition must be on the same filegroup as the target | For SWITCH OUT: source table partition → archive table on same FG |
| Source partition must be empty (for SWITCH IN) | All rows in the source table land in the destination partition |
| CHECK constraint required on staging table | Optimizer must be able to prove no rows fall outside the target partition |
| No foreign keys on the table | FK constraints block partition switching |

> [!NOTE] Online partition switch (2014+)
> `ALTER TABLE ... SWITCH PARTITION N TO ... WITH (WAIT_AT_LOW_PRIORITY (MAX_DURATION = 5, ABORT_AFTER_WAIT = SELF))` allows the switch to wait for blocking transactions with a low-priority lock, then abort itself (or kill blockers) after the timeout.

---

## Aligned Indexes

An index is **aligned** when it is partitioned on the same partition function and column as its base table. This is required for partition switching and enables partition elimination on index scans.

```sql
-- Aligned: uses the same function (pf_monthly) and column (EventDate)
CREATE NONCLUSTERED INDEX ix_aligned
ON dbo.SalesEvents (CustomerID)
ON ps_monthly (EventDate);

-- Non-aligned: sits on a single filegroup
CREATE NONCLUSTERED INDEX ix_nonaligned
ON dbo.SalesEvents (CustomerID)
ON [PRIMARY];
```

**When non-aligned indexes are acceptable:**
- Read-heavy tables where partition switching is never needed
- You need an index on a column that is NOT the partition key and the table is never switched

**Non-aligned index cost:** Each `SWITCH` operation will fail with an error if any non-aligned index exists on the table. You must drop non-aligned indexes before switching, then recreate them.

---

## Partition Elimination

The optimizer prunes partitions when the query predicate includes the partition column with a sargable condition.

```sql
-- Partition elimination occurs: optimizer evaluates $PARTITION.pf_monthly(EventDate)
-- and skips partitions outside the range
SELECT CustomerID, SUM(Amount)
FROM dbo.SalesEvents
WHERE EventDate >= '2024-01-01' AND EventDate < '2024-02-01'
GROUP BY CustomerID;
```

### Verifying elimination in the execution plan

In the actual execution plan, right-click the table scan/seek operator → Properties:

- **Actual Partition Count**: partitions actually accessed
- **Actual Partitions Accessed**: list of partition numbers (e.g., `{3}`)

Or use:
```sql
SET STATISTICS IO ON;
-- Look for "table 'SalesEvents'. Scan count N" — if N = 1, only one partition touched
```

### When elimination fails

| Cause | Symptom | Fix |
|---|---|---|
| Predicate uses a function on the partition column | `WHERE YEAR(EventDate) = 2024` — function wraps the column | Rewrite: `WHERE EventDate >= '2024-01-01' AND EventDate < '2025-01-01'` |
| Implicit type conversion | `WHERE EventDate = '20240101'` (varchar vs date) | Use typed literals; ensure column type matches parameter type |
| Variable not constant at compile time | `WHERE EventDate > @start` with a variable | Usually still works; the optimizer may defer evaluation but typically still eliminates at runtime |
| JOIN between two partitioned tables on different functions | Full scan of both | Partition both tables on the same function/boundaries |
| Dynamic SQL without typed parameters | Plan compiled without the specific predicate values | Use `sp_executesql` with typed parameters |

---

## STATISTICS_INCREMENTAL

> [!NOTE] SQL Server 2014+
> `STATISTICS_INCREMENTAL = ON` causes statistics to be maintained per partition instead of globally. Updating stats for one partition does not require scanning the whole table.

```sql
-- Enable incremental statistics at table creation
CREATE TABLE dbo.SalesEvents (
    EventID   bigint NOT NULL,
    EventDate date   NOT NULL
)
ON ps_monthly (EventDate);

CREATE STATISTICS st_EventDate ON dbo.SalesEvents (EventDate)
WITH INCREMENTAL = ON;

-- Enable on an existing statistics object
UPDATE STATISTICS dbo.SalesEvents (st_EventDate)
WITH INCREMENTAL = ON;

-- Auto-update statistics incremental setting
ALTER TABLE dbo.SalesEvents
SET (INCREMENTAL_STATS = ON);  -- auto_update_statistics fires per partition

-- Force a single-partition stats update (partition 3 only)
UPDATE STATISTICS dbo.SalesEvents (st_EventDate)
WITH RESAMPLE ON PARTITIONS (3);
```

**Benefits:**
- After a partition switch IN, only the new partition's stats need updating
- Avoids full-table scan for large tables where most partitions are static

**Limitation:** The optimizer uses per-partition histograms for cardinality estimation when incremental stats are present, but **the global (merged) histogram is used for cross-partition queries**. Incremental stats do not benefit queries that span partitions.

---

## Managing Partitions

### Add a new partition (SPLIT)

```sql
-- Must set NEXT USED on the scheme before splitting
ALTER PARTITION SCHEME ps_monthly NEXT USED [PRIMARY];

-- Add boundary for 202403; creates new right-most partition
ALTER PARTITION FUNCTION pf_monthly ()
SPLIT RANGE (202403);
```

> [!WARNING] SPLIT on non-empty partition
> If the partition being split contains data, SQL Server must move rows from the original partition into the two new partitions. This is a data movement operation and requires an SCH-M lock, blocking all access. For this reason: always SPLIT before loading data into the new partition, keeping the partition empty at split time.

### Remove a partition (MERGE)

```sql
-- The partition being removed must be EMPTY before merging
-- Merge boundary 202301: partitions 1 and 2 combine into one
ALTER PARTITION FUNCTION pf_monthly ()
MERGE RANGE (202301);
```

Same warning applies: merging two non-empty partitions causes data movement and takes an SCH-M lock.

### Move a partition to a different filegroup

There is no direct "move partition filegroup" command. The approach:

1. Create a new index with a new partition scheme pointing to the desired filegroup
2. DROP the old index

```sql
-- Create new scheme with the desired filegroup mapping
CREATE PARTITION SCHEME ps_monthly_new
AS PARTITION pf_monthly
TO (fg_cold, fg_cold, [PRIMARY], [PRIMARY], ...);  -- old partitions to cold storage

-- Rebuild clustered index onto the new scheme (rewrites data into new FGs)
CREATE CLUSTERED INDEX cx_SalesEvents
ON dbo.SalesEvents (EventDate, EventID)
WITH (DROP_EXISTING = ON)
ON ps_monthly_new (EventDate);
```

---

## Querying Partition Metadata

### Partition row counts and sizes

```sql
SELECT
    p.partition_number,
    p.rows,
    prv.value                            AS boundary_value,
    SUM(a.total_pages) * 8 / 1024.0     AS total_mb,
    SUM(a.used_pages)  * 8 / 1024.0     AS used_mb,
    fg.name                             AS filegroup_name
FROM sys.partitions p
JOIN sys.tables t ON p.object_id = t.object_id
JOIN sys.indexes i ON p.object_id = i.object_id AND p.index_id = i.index_id
JOIN sys.allocation_units a ON p.partition_id = a.container_id
JOIN sys.partition_schemes ps ON i.data_space_id = ps.data_space_id
JOIN sys.partition_functions pf ON ps.function_id = pf.function_id
LEFT JOIN sys.partition_range_values prv
    ON pf.function_id = prv.function_id
    AND p.partition_number = prv.boundary_id + CASE pf.boundary_value_on_right WHEN 1 THEN 1 ELSE 0 END
JOIN sys.destination_data_spaces dds
    ON ps.data_space_id = dds.partition_scheme_id
    AND p.partition_number = dds.destination_id
JOIN sys.filegroups fg ON dds.data_space_id = fg.data_space_id
WHERE t.name = 'SalesEvents'
  AND i.index_id <= 1  -- clustered or heap only
ORDER BY p.partition_number;
```

### Determine which partition a value belongs to

```sql
SELECT $PARTITION.pf_monthly(202403);  -- returns 15 (or whatever partition number)
```

### Check if indexes are aligned

```sql
SELECT
    t.name   AS table_name,
    i.name   AS index_name,
    i.type_desc,
    ps.name  AS partition_scheme,
    pf.name  AS partition_function,
    c.name   AS partition_column,
    CASE WHEN i.data_space_id = base_i.data_space_id THEN 'ALIGNED' ELSE 'NOT ALIGNED' END AS alignment
FROM sys.tables t
JOIN sys.indexes i ON t.object_id = i.object_id
JOIN sys.indexes base_i ON t.object_id = base_i.object_id AND base_i.index_id <= 1
LEFT JOIN sys.partition_schemes ps ON i.data_space_id = ps.data_space_id
LEFT JOIN sys.partition_functions pf ON ps.function_id = pf.function_id
LEFT JOIN sys.index_columns ic ON i.object_id = ic.object_id
    AND i.index_id = ic.index_id AND ic.partition_ordinal > 0
LEFT JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
WHERE t.name = 'SalesEvents'
ORDER BY i.index_id;
```

---

## Partitioned Views vs Table Partitioning

Both partition data across physical storage, but they work very differently:

| Feature | Table Partitioning | Partitioned Views |
|---|---|---|
| Data structure | Single table, one catalog object | Multiple tables, one view |
| Partition elimination | Automatic (optimizer-driven) | Via CHECK constraints on base tables |
| DML through the view | N/A (DML on the table) | Possible if base table constraints are trusted |
| Switching | Metadata-only ALTER TABLE SWITCH | Swap base tables; DDL operations required |
| Distributed storage | No (all on one instance) | Yes (linked servers for distributed views) |
| Index alignment requirement | Required for switch | N/A |
| Ease of adding partitions | SPLIT + SWITCH | CREATE TABLE + ALTER VIEW |
| Recommendation | Preferred for most workloads | Use for distributed partitioning across servers |

See `05-views.md` for partitioned view details.

---

## Azure SQL Considerations

- **Azure SQL Database**: Table partitioning is fully supported. However, filegroups are not user-controlled — all data is stored in a single managed filegroup. Specifying filegroups in CREATE/ALTER statements is accepted but has no effect. Backup-per-filegroup strategies do not apply.
- **Azure SQL Managed Instance**: Filegroups are supported. Partitioning behavior matches on-premises SQL Server.
- **Elastic pools**: Partitioning within a single database works normally. Cross-database distributed partitioned views are limited by elastic query (external tables) rather than linked servers.

---

## Gotchas / Anti-patterns

1. **Partitioning does not replace indexes.** If your query filters on `CustomerID` and the table is partitioned on `EventDate`, the partition column isn't in the predicate — you get no elimination. You still need an index on `CustomerID`.

2. **Non-aligned indexes block partition switching.** All nonclustered indexes must be on the same partition scheme as the clustered index. Check alignment before scheduling a switch window.

3. **SPLIT on a non-empty partition causes data movement.** Always split before data arrives, not after. Schedule boundary additions as part of the pre-load process.

4. **MERGE on non-empty partitions causes data movement.** Switch out data to an archive table first, verify the partition is empty (`SELECT COUNT(*) FROM tbl WHERE $PARTITION.fn(col) = N`), then merge.

5. **Missing CHECK constraint on staging table.** Without it, the switch fails: `ALTER TABLE SWITCH statement failed. Check constraints or partition function of source table 'dbo.Stage' allows values that are not allowed by check constraints or partition function on target table 'dbo.SalesEvents'.`

6. **Partition column type mismatch.** If the partition function is defined on `int` but the table column is `bigint`, the partition column implicitly converts — this can prevent elimination and may cause unexpected partition assignments.

7. **Foreign key constraints block switching.** Drop FK constraints referencing the table (or on the table) before switching. This is a common oversight in tightly normalized schemas.

8. **$PARTITION function is 1-based, not 0-based.** Partition 1 is always the leftmost (below all boundaries). Off-by-one errors in partition number calculations are common.

9. **Statistics go stale after SWITCH IN.** After switching a staging table into the main table, the statistics for that partition are stale (they came from the staging table and reflect its sample). Update statistics on the affected partition or the whole table after switching.

10. **Querying `sys.partitions` for row count is eventually consistent.** Row counts in `sys.partitions` are not real-time — they reflect the last statistics update or index rebuild. Use `WITH (NOLOCK)` queries or `DBCC UPDATEUSAGE` for the most current counts if needed.

---

## See Also

- [`08-indexes.md`](08-indexes.md) — index design; aligned index requirements
- [`09-columnstore-indexes.md`](09-columnstore-indexes.md) — columnstore partitioning; bulk-load path optimization
- [`05-views.md`](05-views.md) — partitioned views
- [`28-statistics.md`](28-statistics.md) — STATISTICS_INCREMENTAL; incremental stats update
- [`36-data-compression.md`](36-data-compression.md) — per-partition compression settings
- [`44-backup-restore.md`](44-backup-restore.md) — filegroup backup strategy

---

## Sources

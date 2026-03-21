# Index Strategy


Designing, maintaining, and diagnosing B-tree indexes in SQL Server. Covers clustered key selection, covering indexes, filtered indexes, fragmentation, and the cost of over-indexing.

**Scope:** this file covers B-tree (rowstore) indexes only. Columnstore indexes (clustered and nonclustered) are outside this skill's scope — they have distinct maintenance requirements, delta store behavior, and interact differently with the query optimizer.

## Table of Contents


- [Clustered Index Selection](#clustered-index-selection)
- [Nonclustered Index Design](#nonclustered-index-design)
- [Covering Indexes and INCLUDE Columns](#covering-indexes-and-include-columns)
- [Filtered Indexes](#filtered-indexes)
- [SARGability and Composite Key Ordering](#sargability-and-composite-key-ordering)
- [Over-Indexing](#over-indexing)
- [Fill Factor and Page Splits](#fill-factor-and-page-splits)
- [Fragmentation: Rebuild vs Reorganize](#fragmentation-rebuild-vs-reorganize)
- [Missing Index DMVs](#missing-index-dmvs)
- [Index Usage Statistics](#index-usage-statistics)
- [See Also](#see-also)
- [Sources](#sources)

---

## Clustered Index Selection


The clustered index IS the table — leaf pages store the actual rows in clustered key order. Every nonclustered index stores a copy of the clustered key in its leaf rows as the row locator. A bad clustered key choice cascades to every other index.

**Four properties of a good clustered key:**

**Narrow** — the clustered key is copied into every nonclustered index leaf row. A `UNIQUEIDENTIFIER` (16 bytes) vs `INT` (4 bytes) adds 12 bytes per NCI row. With 10 NCIs and 100 million rows, that is 12 GB of extra index storage.

**Ever-increasing** — random inserts cause 50/50 page splits: SQL Server must split a full leaf page and move half its rows to a new page, logging both operations. Monotonically increasing keys (IDENTITY, SEQUENCE) produce cheap 90/10 splits — only the last page needs space reserved.

**Unique** — SQL Server silently appends a 4-byte uniquifier to duplicate clustered key values. This increases row size and adds overhead to every NCI lookup.

**Static** — updating the clustered key physically moves the row (delete the old position + insert at the new position) and cascades to update the row locator in every NCI.

    -- Good: narrow, unique, ever-increasing
    CREATE TABLE dbo.Orders (
        OrderID    INT           NOT NULL IDENTITY(1,1),
        CustomerID INT           NOT NULL,
        OrderDate  DATETIME2     NOT NULL,
        TotalAmt   DECIMAL(12,2) NOT NULL,
        CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderID)
    );

    -- Bad: wide GUID clustered key — avoid for OLTP
    -- CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderGUID)
    -- Use NEWSEQUENTIALID() if a GUID is required as the clustered key

**When the clustered index is not the primary key:**

Queries that do heavy range scans on a non-PK column benefit from clustering on that column instead. Declare the PK as NONCLUSTERED and create a separate CLUSTERED index:

    CREATE TABLE dbo.EventLog (
        EventID    BIGINT        NOT NULL IDENTITY(1,1),
        OccurredAt DATETIME2     NOT NULL,
        EventType  TINYINT       NOT NULL,
        Payload    NVARCHAR(MAX) NULL,
        CONSTRAINT PK_EventLog PRIMARY KEY NONCLUSTERED (EventID)
    );
    CREATE CLUSTERED INDEX CIX_EventLog_OccurredAt
        ON dbo.EventLog (OccurredAt);
    -- Range scans by date are now sequential reads; point lookups by EventID use the NCI

---

## Nonclustered Index Design


Nonclustered indexes have their own B-tree. Leaf pages contain the index key columns, the row locator (clustered key or RID), and any INCLUDE columns.

**How many NCIs is too many?** OLTP tables with high INSERT/UPDATE/DELETE volume become write-bound above 5–7 NCIs. Each index is updated on every INSERT and on every UPDATE touching any key or INCLUDE column. Measure, do not guess.

    -- Check write overhead per index
    SELECT OBJECT_NAME(ios.object_id)   AS TableName,
           i.name                        AS IndexName,
           ios.leaf_insert_count,
           ios.leaf_update_count,
           ios.leaf_delete_count,
           ios.leaf_insert_count + ios.leaf_update_count + ios.leaf_delete_count
               AS total_writes
    FROM sys.dm_db_index_operational_stats(DB_ID(), NULL, NULL, NULL) ios
    JOIN sys.indexes i ON ios.object_id = i.object_id AND ios.index_id = i.index_id
    WHERE OBJECT_NAME(ios.object_id) = 'Orders'
    ORDER BY total_writes DESC;

---

## Covering Indexes and INCLUDE Columns


A **covering index** satisfies a query entirely from the index — no Key Lookup back to the clustered index.

**Why Key Lookups are expensive at scale:**
- Each lookup traverses the clustered B-tree (typically 2–4 page reads depending on tree height) per row
- 1,000 rows with a Key Lookup = thousands of extra logical reads; the cost scales linearly with row count
- The optimizer switches from NCI seek + lookup to a clustered scan once enough rows are expected (typically 0.5–2% of the table)

**Rule:** put columns in the index key only if they appear in WHERE/JOIN/ORDER BY. Everything else goes in INCLUDE.

    -- Identifies the query access pattern first
    -- Query: WHERE CustomerID = @cid ORDER BY OrderDate — SELECT OrderID, TotalAmt
    -- Key columns: CustomerID (equality), OrderDate (range + sort)
    -- INCLUDE columns: OrderID (in SELECT), TotalAmt (in SELECT)

    CREATE NONCLUSTERED INDEX IX_Orders_CustomerID_Date_Covering
        ON dbo.Orders (CustomerID, OrderDate)
        INCLUDE (TotalAmt);
    -- OrderID is already in the index via the clustered key (row locator)

    -- Detect Key Lookups in plan cache
    SELECT TOP 20
        qs.total_logical_reads / qs.execution_count AS avg_reads,
        qs.execution_count,
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 200) AS stmt
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
    WHERE CAST(qp.query_plan AS NVARCHAR(MAX)) LIKE '%KeyLookup%'
    ORDER BY avg_reads DESC;

**INCLUDE column limits:** key columns have a 900-byte limit (16 key columns max). INCLUDE columns are leaf-only — they do not count toward the key limit. The total leaf row size limit is 1,700 bytes. In practice, INCLUDE columns can hold most data types including large ones.

---

## Filtered Indexes


A filtered index covers only the rows matching a WHERE predicate. The index is smaller, cheaper to maintain, and more selective per byte than a full-table NCI.

    -- Index only pending work items — 1% of rows instead of 100%
    CREATE NONCLUSTERED INDEX IX_WorkQueue_Pending
        ON dbo.WorkQueue (ScheduledFor, QueuedAt)
        INCLUDE (WorkItemID, AttemptNum)
        WHERE Status = 'Pending';

    -- Partial unique constraint — allow multiple NULLs but no duplicate values
    CREATE UNIQUE NONCLUSTERED INDEX UX_Customer_ExternalID
        ON dbo.Customer (ExternalID)
        WHERE ExternalID IS NOT NULL;

    -- Sparse error column — only non-NULL errors need indexing
    CREATE NONCLUSTERED INDEX IX_EventLog_ErrorCode
        ON dbo.EventLog (ErrorCode)
        WHERE ErrorCode IS NOT NULL;

**Requirements for the optimizer to use a filtered index:**
- The query WHERE clause must include the filter predicate (or a logically stronger version of it)
- For parameterized queries, this often means `OPTION (RECOMPILE)` is needed — the optimizer cannot guarantee `WHERE Status = @status` always equals `'Pending'` at compile time unless the value is embedded
- Filter predicate must be a simple comparison, `IS NULL`, or `IS NOT NULL` — no functions

---

## SARGability and Composite Key Ordering


A predicate is SARGable when the optimizer can use an index seek. Anything that wraps the column in a function, expression, or implicit conversion kills seeks.

    -- NOT SARGable — full scan even with an index on OrderDate
    WHERE YEAR(OrderDate) = 2025
    WHERE DATEDIFF(day, OrderDate, GETDATE()) < 30
    WHERE CAST(CustomerID AS VARCHAR) = '42'

    -- SARGable equivalents
    WHERE OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01'
    WHERE OrderDate > DATEADD(day, -30, GETDATE())
    WHERE CustomerID = 42

**Composite key ordering rule:** equality predicates come first, range predicates last, ORDER BY columns after equality predicates (for free sorting).

    -- Query: WHERE CustomerID = @cid AND Status = @status AND OrderDate > @since
    -- CustomerID = equality, Status = equality, OrderDate = range
    -- Optimal key: (CustomerID, Status, OrderDate)
    CREATE NONCLUSTERED INDEX IX_Orders_Customer_Status_Date
        ON dbo.Orders (CustomerID, Status, OrderDate)
        INCLUDE (TotalAmt);

A range column in the middle of a composite key blocks seeks on all subsequent columns. Place equality columns before ranges.

---

## Over-Indexing


Every nonclustered index is maintained on every INSERT, on every UPDATE touching its key or INCLUDE columns, and on every DELETE. The write penalty compounds.

**Find unused indexes** (index usage stats reset on restart):

    SELECT OBJECT_NAME(i.object_id) AS TableName,
           i.name                    AS IndexName,
           i.type_desc,
           us.user_seeks,
           us.user_scans,
           us.user_lookups,
           us.user_updates,
           us.last_user_seek,
           us.last_user_scan
    FROM sys.indexes i
    LEFT JOIN sys.dm_db_index_usage_stats us
        ON us.object_id = i.object_id
        AND us.index_id = i.index_id
        AND us.database_id = DB_ID()
    WHERE OBJECT_NAME(i.object_id) = 'Orders'
      AND i.index_id > 1   -- exclude clustered
    ORDER BY ISNULL(us.user_seeks + us.user_scans + us.user_lookups, 0) ASC;

An index with `user_updates` in the millions and `user_seeks = 0` is pure overhead — evaluate dropping it. Do not drop an index based on a single server restart; wait for representative workload data (at minimum one full business cycle).

**Find duplicate indexes** (same leading column):

    SELECT t.name AS TableName, i1.name AS Index1, i2.name AS Index2
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
      AND i1.type > 0 AND i2.type > 0;

---

## Fill Factor and Page Splits


Fill factor sets how full leaf pages are when an index is built or rebuilt. A fill factor of 80 leaves 20% free space for inserts into that page.

| Scenario | Recommended fill factor |
|---|---|
| Read-only or archival table | 100 — no free space needed |
| Monotonically increasing clustered key (IDENTITY) | 100 on clustered, 90–95 on NCIs |
| Random inserts into existing key range (natural keys) | 70–80 |
| High-update heap or NCI with frequent mid-page inserts | 70–75 |

Fill factor applies only at rebuild time. Pages fill up naturally afterward — fragmentation grows until the next rebuild.

    -- Set fill factor during rebuild
    ALTER INDEX IX_Orders_CustomerID ON dbo.Orders
        REBUILD WITH (FILLFACTOR = 80, ONLINE = ON);

---

## Fragmentation: Rebuild vs Reorganize


| Fragmentation | Page count | Action |
|---|---|---|
| < 5% | Any | Ignore |
| 5–30% | > 1,000 pages | `ALTER INDEX ... REORGANIZE` |
| > 30% | > 1,000 pages | `ALTER INDEX ... REBUILD` |
| Any | < 1,000 pages | Ignore — fragmentation cost < fix cost |

    -- Check fragmentation (LIMITED mode: fast estimate; DETAILED: accurate but slower)
    SELECT OBJECT_NAME(ps.object_id)      AS TableName,
           i.name                          AS IndexName,
           ps.avg_fragmentation_in_percent,
           ps.page_count
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ps
    JOIN sys.indexes i
        ON ps.object_id = i.object_id
        AND ps.index_id = i.index_id
    WHERE ps.page_count > 128
    ORDER BY ps.avg_fragmentation_in_percent DESC;

    -- REORGANIZE: online, compacts leaf pages in place
    ALTER INDEX IX_Orders_CustomerID ON dbo.Orders REORGANIZE;

    -- REBUILD: offline by default, full defragmentation + statistics update
    ALTER INDEX IX_Orders_CustomerID ON dbo.Orders REBUILD WITH (ONLINE = ON);

    -- Rebuild all indexes on a table
    ALTER INDEX ALL ON dbo.Orders REBUILD WITH (ONLINE = ON);

REBUILD also updates statistics with the equivalent of `FULLSCAN`. REORGANIZE does not update statistics — run `UPDATE STATISTICS` separately after a reorganize if statistics are stale.

---

## Missing Index DMVs


The optimizer records missing index recommendations during query compilation. These DMVs reset on SQL Server restart — collect them before reboots.

    SELECT TOP 20
        d.statement                  AS [Table],
        d.equality_columns,
        d.inequality_columns,
        d.included_columns,
        ROUND(s.avg_total_user_cost * s.avg_user_impact
              * (s.user_seeks + s.user_scans), 0)  AS estimated_improvement,
        s.user_seeks,
        s.user_scans,
        s.last_user_seek
    FROM sys.dm_db_missing_index_groups g
    JOIN sys.dm_db_missing_index_group_stats s
        ON g.index_group_handle = s.group_handle
    JOIN sys.dm_db_missing_index_details d
        ON g.index_handle = d.index_handle
    WHERE d.database_id = DB_ID()
    ORDER BY estimated_improvement DESC;

**Do not blindly create every suggestion.** The DMVs do not account for:
- Overlap with existing indexes that have a different column order
- Write overhead on INSERT/UPDATE/DELETE
- Impact on other queries
- Index selectivity — a suggestion on a low-selectivity column may not actually help

Always validate a suggestion against the actual execution plan before creating.

---

## Index Usage Statistics


    -- Reads vs writes: identify indexes that are write-only overhead
    SELECT OBJECT_NAME(i.object_id) AS TableName,
           i.name                    AS IndexName,
           ISNULL(us.user_seeks, 0)  AS seeks,
           ISNULL(us.user_scans, 0)  AS scans,
           ISNULL(us.user_lookups, 0) AS lookups,
           ISNULL(us.user_updates, 0) AS writes,
           ISNULL(us.last_user_seek, us.last_user_scan) AS last_read
    FROM sys.indexes i
    LEFT JOIN sys.dm_db_index_usage_stats us
        ON us.object_id = i.object_id
        AND us.index_id = i.index_id
        AND us.database_id = DB_ID()
    WHERE i.type_desc = 'NONCLUSTERED'
      AND OBJECT_NAME(i.object_id) NOT LIKE 'sys%'
    ORDER BY ISNULL(us.user_seeks + us.user_scans + us.user_lookups, 0) ASC,
             ISNULL(us.user_updates, 0) DESC;

---

## See Also


- [execution-plans.md](execution-plans.md) — Key Lookup diagnosis, NCI seek vs scan in plans
- [statistics-tuning.md](statistics-tuning.md) — statistics and cardinality estimation
- [wait-stats.md](wait-stats.md) — PAGEIOLATCH waits indicating I/O from missing indexes
- [batch-operations.md](batch-operations.md) — minimal logging conditions that affect clustered index behavior

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [Clustered and Nonclustered Indexes Described](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/clustered-and-nonclustered-indexes-described) — Explains the B-tree structure, row locators, and the relationship between clustered key and nonclustered index pointers.
[^2]: [Create Indexes with Included Columns](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/create-indexes-with-included-columns) — Covers adding nonkey columns to nonclustered indexes to create covering indexes, including design recommendations and key-size limits.
[^3]: [Create Filtered Indexes](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/create-filtered-indexes) — Filtered index design, when to use them for sparse or well-defined subsets, and reduced maintenance cost vs full-table indexes.
[^4]: [Maintain Indexes Optimally to Improve Performance and Reduce Resource Utilization](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/reorganize-and-rebuild-indexes) — Official guidance on fragmentation thresholds, reorganize vs rebuild decision, and fill factor impact.
[^5]: [sys.dm_db_index_physical_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-index-physical-stats-transact-sql) — DMV reference for avg_fragmentation_in_percent and page density, with the 5%/30% threshold recommendations.
[^6]: [sys.dm_db_missing_index_details (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-missing-index-details-transact-sql) — Reference for the missing-index DMV family (details, groups, group_stats), covering equality/inequality/included-column recommendations and their limitations.
[^7]: [Specify Fill Factor for an Index](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/specify-fill-factor-for-an-index) — Explains page splits, how fill factor reserves space on leaf pages, and performance trade-offs of non-default fill factors.
[^8]: [SQL Server Index and Statistics Maintenance](https://ola.hallengren.com/sql-server-index-and-statistics-maintenance.html) — Ola Hallengren's canonical maintenance solution documenting FragmentationLevel1 (5%) and FragmentationLevel2 (30%) thresholds for REORGANIZE vs REBUILD decisions.

# SQL Server 2022 — New Features Reference

SQL Server 2022 (16.x, RTM November 2022) is the first release with deep Azure
integration, bringing features previously limited to the cloud on-premises.
This file covers every major new capability, the T-SQL syntax changes, engine
improvements, and operational differences from SQL Server 2019.

---

## Table of Contents

1. [When to Use This File](#when-to-use-this-file)
2. [Release and Compatibility Level](#release-and-compatibility-level)
3. [Ledger Tables](#ledger-tables)
4. [S3-Compatible Object Storage for Backup and PolyBase](#s3-compatible-object-storage)
5. [Contained Availability Groups](#contained-availability-groups)
6. [T-SQL Language Enhancements](#tsql-language-enhancements)
   - IS [NOT] DISTINCT FROM
   - GREATEST / LEAST
   - DATE_BUCKET
   - STRING_SPLIT Ordinal Column
   - TRIM with Character Set
   - GENERATE_SERIES
   - JSON_OBJECT / JSON_ARRAY / JSON_PATH_EXISTS
   - DATETRUNC
   - WINDOW Clause
7. [Intelligent Query Processing Enhancements](#iqp-enhancements)
   - DOP Feedback
   - CE Feedback
   - Memory Grant Feedback Percentile and Persistence
   - Parameter-Sensitive Plan Optimization (PSPO)
8. [Query Store Improvements](#query-store-improvements)
9. [XML Compression](#xml-compression)
10. [Accelerated Database Recovery (ADR) Improvements](#adr-improvements)
11. [PolyBase S3 and OPENROWSET Enhancements](#polybase-openrowset)
12. [Azure Arc Integration](#azure-arc-integration)
13. [Security Enhancements](#security-enhancements)
14. [Replication and AG Improvements](#replication-ag-improvements)
15. [sys.dm_* DMV Changes](#dmv-changes)
16. [Deprecated and Removed Features](#deprecated-removed)
17. [Azure SQL Comparison](#azure-sql-comparison)
18. [Upgrade Checklist: 2019 → 2022](#upgrade-checklist)
19. [Gotchas](#gotchas)
20. [See Also](#see-also)
21. [Sources](#sources)

---

## When to Use This File

Load this file when the user asks about:
- What is new in SQL Server 2022
- Whether a specific 2022 feature is available on-prem or only in Azure SQL
- T-SQL functions added in SQL Server 2022
- IQP enhancements and how they differ from SQL Server 2019
- Ledger tables, contained AGs, S3 backup, or Azure Arc
- Compatibility level 160 behavior changes

---

## Release and Compatibility Level

| Property | Value |
|---|---|
| Product version | 16.0.x |
| Default compatibility level | 160 |
| Supported compat levels | 90, 100, 110, 120, 130, 140, 150, 160 |
| Support lifecycle (Mainstream) | 2028-01-11 |
| Support lifecycle (Extended) | 2033-01-11 |

Many SQL Server 2022 features are **compatibility-level independent** (they
work regardless of compat level). The IQP features (DOP feedback, CE feedback,
PSPO, MGF percentile/persistence) require `COMPATIBILITY_LEVEL = 160`.

```sql
-- Check your current compat level
SELECT name, compatibility_level
FROM sys.databases
WHERE name = DB_NAME();

-- Upgrade to 160 (test first!)
ALTER DATABASE YourDatabase
SET COMPATIBILITY_LEVEL = 160;
```

> [!WARNING] Compatibility level upgrade
> Raising compat level can change cardinality estimator behavior and IQP
> features. Always test with Query Store plan forcing in place before
> upgrading production. See `references/53-migration-compatibility.md`.

---

## Ledger Tables

Ledger tables provide cryptographic tamper evidence for database rows. See
`references/22-ledger-tables.md` for the full reference; this section
summarizes what is new in 2022.

**What SQL Server 2022 added:**
- Both append-only and updatable ledger tables (both existed in Azure SQL
  before 2022 on-prem release)
- `sp_verify_database_ledger` — verify hash chain integrity
- `sp_generate_database_ledger_digest` — generate a JSON digest for
  off-database custody
- Azure Confidential Ledger (ACL) integration for TEE-backed immutability

```sql
-- Append-only ledger table (SQL Server 2022+)
CREATE TABLE dbo.AuditEvents (
    EventId      INT IDENTITY PRIMARY KEY,
    EventType    NVARCHAR(50) NOT NULL,
    Principal    SYSNAME DEFAULT SUSER_SNAME(),
    EventTime    DATETIME2 DEFAULT SYSUTCDATETIME(),
    Payload      NVARCHAR(MAX)
)
WITH (LEDGER = ON (APPEND_ONLY = ON));

-- Verify the hash chain
EXECUTE sp_verify_database_ledger;
```

> [!NOTE] SQL Server 2022
> Ledger was available in Azure SQL Database since 2021. SQL Server 2022 is the
> first on-premises release.

---

## S3-Compatible Object Storage

SQL Server 2022 can read and write S3-compatible object storage for backups,
PolyBase external tables, and OPENROWSET queries. This includes AWS S3, MinIO,
NetApp StorageGRID, Pure Storage FlashBlade, and any S3-API-compatible store.

### S3 Backup

```sql
-- Step 1: Create a credential for S3 access
-- SECRET format: 'accessKeyId:secretAccessKey'  (colon separator)
CREATE CREDENTIAL [s3://my-bucket.s3.amazonaws.com/backups]
WITH IDENTITY = 'S3 Access Key',
     SECRET    = 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

-- Step 2: Back up to S3
BACKUP DATABASE AdventureWorks2022
TO URL = 's3://my-bucket.s3.amazonaws.com/backups/AdventureWorks2022.bak'
WITH COMPRESSION, STATS = 10;

-- Striped backup across multiple URLs
BACKUP DATABASE AdventureWorks2022
TO URL = 's3://my-bucket.s3.amazonaws.com/backups/AW_1.bak',
   URL = 's3://my-bucket.s3.amazonaws.com/backups/AW_2.bak',
   URL = 's3://my-bucket.s3.amazonaws.com/backups/AW_3.bak'
WITH COMPRESSION, STATS = 10;

-- Restore from S3
RESTORE DATABASE AdventureWorks2022
FROM URL = 's3://my-bucket.s3.amazonaws.com/backups/AdventureWorks2022.bak'
WITH STATS = 10;
```

> [!WARNING] Credential format
> The SECRET for S3 credentials uses `accessKeyId:secretAccessKey` with a
> literal colon separator. This differs from Azure Blob Storage credentials
> and is a frequent source of errors.

> [!NOTE] SQL Server 2022
> S3-compatible object storage support is new in SQL Server 2022. Azure Blob
> Storage backup (via `https://` URL) was available since SQL Server 2012.

See `references/44-backup-restore.md` for full BACKUP/RESTORE syntax and
`references/46-polybase-external-tables.md` for S3 PolyBase usage.

---

## Contained Availability Groups

A **contained AG** stores AG-scoped objects (logins, SQL Agent jobs, linked
servers) inside the availability group itself, making them portable across
replicas without manual synchronization.

```sql
-- Create a contained AG
CREATE AVAILABILITY GROUP [ContainedAG]
WITH (
    CLUSTER_TYPE = WSFC,
    DB_FAILOVER = ON,
    CONTAINED     -- <-- the key keyword
)
FOR DATABASE [YourDatabase]
REPLICA ON
    N'Node1' WITH (
        ENDPOINT_URL = 'TCP://node1.domain.com:5022',
        AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
        FAILOVER_MODE = AUTOMATIC,
        SEEDING_MODE = AUTOMATIC
    ),
    N'Node2' WITH (
        ENDPOINT_URL = 'TCP://node2.domain.com:5022',
        AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
        FAILOVER_MODE = AUTOMATIC,
        SEEDING_MODE = AUTOMATIC
    );
```

**What the contained AG replicates:**
- SQL logins (`master..syslogins` scoped to the AG)
- SQL Server Agent jobs
- Linked server definitions
- Custom error messages

**What the contained AG does NOT replicate:**
- Windows logins (replicated via AD, not the AG)
- Server-level configuration (sp_configure settings)
- Databases outside the AG

```sql
-- Create a login inside the contained AG context
-- Must be connected to the AG's contained context
ALTER AVAILABILITY GROUP [ContainedAG]
    ADD DATABASE ContainedDB;

-- Check what is contained
SELECT * FROM sys.dm_hadr_contained_instances;
```

> [!NOTE] SQL Server 2022
> Contained AGs are new in SQL Server 2022. On SQL Server 2019, logins and
> Agent jobs must be manually kept in sync across replicas.

> [!WARNING] Limitations
> - Contained AGs do not support distributed AGs
> - Not available on Linux Pacemaker clusters (WSFC only at RTM)
> - Jobs inside the contained AG run on the current primary only

See `references/43-high-availability.md` for full AG architecture reference.

---

## T-SQL Language Enhancements

### IS [NOT] DISTINCT FROM

Null-safe equality comparison. Unlike `=`, it treats two NULLs as equal.

```sql
-- Old way (verbose and fragile)
WHERE (a = b) OR (a IS NULL AND b IS NULL)

-- SQL Server 2022 way
WHERE a IS NOT DISTINCT FROM b   -- TRUE when both NULL, or both equal

-- NULL-safe JOIN
SELECT a.*, b.*
FROM TableA a
JOIN TableB b ON a.key IS NOT DISTINCT FROM b.key;
```

Truth table:

| a | b | a = b | a IS NOT DISTINCT FROM b |
|---|---|---|---|
| 1 | 1 | TRUE | TRUE |
| 1 | 2 | FALSE | FALSE |
| 1 | NULL | UNKNOWN | FALSE |
| NULL | NULL | UNKNOWN | TRUE |

> [!NOTE] SQL Server 2022
> `IS [NOT] DISTINCT FROM` is new in SQL Server 2022. Compat level 160 is
> not required — works at any compat level on a 2022 instance.

---

### GREATEST / LEAST

Return the maximum or minimum value from a list of expressions, ignoring NULLs
unless all inputs are NULL.

```sql
-- Greatest of three columns
SELECT GREATEST(col1, col2, col3) AS MaxOfThree
FROM MyTable;

-- Useful for clamping values
SELECT GREATEST(0, LEAST(100, score)) AS ClampedScore
FROM Scores;

-- NULL behavior: NULLs are ignored unless all are NULL
SELECT GREATEST(1, NULL, 3);    -- Returns 3
SELECT GREATEST(NULL, NULL);    -- Returns NULL
```

> [!NOTE] SQL Server 2022
> `GREATEST` and `LEAST` are new in SQL Server 2022. Previous workarounds
> used `CASE` expressions or `VALUES`-based subqueries.

---

### DATE_BUCKET

Groups dates into fixed-width time buckets. Useful for time-series
aggregations.

```sql
-- 15-minute buckets
SELECT
    DATE_BUCKET(MINUTE, 15, OrderTime) AS Bucket,
    COUNT(*) AS OrderCount,
    SUM(Amount) AS TotalAmount
FROM Orders
WHERE OrderTime >= '2024-01-01'
GROUP BY DATE_BUCKET(MINUTE, 15, OrderTime)
ORDER BY Bucket;

-- Week-based bucketing with explicit origin
-- Default origin is 1900-01-01 (a Monday)
SELECT DATE_BUCKET(WEEK, 1, CAST('2024-03-15' AS DATE));
-- Returns 2024-03-11 (Monday of the week)

-- Custom origin to align weeks to Sunday
SELECT DATE_BUCKET(WEEK, 1, CAST('2024-03-15' AS DATE), CAST('2024-03-10' AS DATE));
```

Syntax:
```sql
DATE_BUCKET ( datePart, number, date [, origin ] )
```

Supported `datePart` values: `MICROSECOND`, `MILLISECOND`, `SECOND`,
`MINUTE`, `HOUR`, `DAY`, `WEEK`, `MONTH`, `QUARTER`, `YEAR`.

> [!NOTE] SQL Server 2022
> `DATE_BUCKET` is new in SQL Server 2022. It was available in Azure Synapse
> Analytics before 2022.

---

### STRING_SPLIT Ordinal Column

`STRING_SPLIT` now returns an optional `ordinal` column indicating position
within the input string. Requires `enable_ordinal = 1`.

```sql
-- Without ordinal (2016+ behavior)
SELECT value FROM STRING_SPLIT('a,b,c', ',');

-- With ordinal (2022+)
SELECT value, ordinal
FROM STRING_SPLIT('a,b,c', ',', 1)   -- third arg = enable_ordinal
ORDER BY ordinal;
-- a  1
-- b  2
-- c  3

-- Reconstruct ordered CSV from a table
SELECT STRING_AGG(value, ',') WITHIN GROUP (ORDER BY ordinal)
FROM STRING_SPLIT(@csv, ',', 1);
```

> [!NOTE] SQL Server 2022
> The `ordinal` output column and the third `enable_ordinal` parameter are
> new in SQL Server 2022. The two-argument form remains unchanged.

> [!WARNING] Ordering without ordinal
> On SQL Server 2016–2019, `STRING_SPLIT` does not guarantee order. If you
> need positional order, upgrade to 2022 or use a numbers table approach.

---

### TRIM with Character Set

`TRIM` can now strip a specified set of characters (not just a string) from
both ends. This backfills a long-standing gap vs other SQL dialects.

```sql
-- Remove leading and trailing spaces (unchanged from 2017)
SELECT TRIM('  hello  ');     -- 'hello'

-- Remove specific characters from both ends (2022+)
SELECT TRIM('.,! ' FROM '...hello world!!!');  -- 'hello world'

-- LEADING / TRAILING direction specifiers (2022+)
SELECT TRIM(LEADING  '0' FROM '0001234');  -- '1234'
SELECT TRIM(TRAILING '/' FROM '/path/');   -- '/path'
```

> [!NOTE] SQL Server 2022
> Character-set stripping and `LEADING`/`TRAILING` specifiers are new in
> SQL Server 2022. On 2017–2019, `TRIM` removes only spaces/tabs.

---

### GENERATE_SERIES

Returns a table of integers (or numeric values) in a range with a step.
Replaces recursive CTE number generators.

```sql
-- Integers 1 through 10
SELECT value FROM GENERATE_SERIES(1, 10);

-- Even numbers 0 through 20
SELECT value FROM GENERATE_SERIES(0, 20, 2);

-- Generate a date spine (one row per day)
SELECT DATEADD(DAY, value - 1, '2024-01-01') AS dt
FROM GENERATE_SERIES(1, 365);

-- Use in aggregation
SELECT SUM(value) FROM GENERATE_SERIES(1, 100);  -- 5050
```

> [!NOTE] SQL Server 2022
> `GENERATE_SERIES` is new in SQL Server 2022. Requires compat level 160.

```sql
-- Verify compat level requirement
SELECT compatibility_level
FROM sys.databases
WHERE name = DB_NAME();
-- Must be 160 for GENERATE_SERIES
```

---

### JSON_OBJECT / JSON_ARRAY / JSON_PATH_EXISTS

Three new JSON constructor/predicate functions.

```sql
-- JSON_OBJECT: construct a JSON object from key-value pairs
SELECT JSON_OBJECT('name' : FirstName, 'age' : Age, 'dept' : Department)
FROM Employees;
-- {"name":"Alice","age":30,"dept":"Engineering"}

-- NULL ON NULL vs ABSENT ON NULL behavior
SELECT JSON_OBJECT(
    'name' : FirstName,
    'phone' : Phone NULL ON NULL    -- includes "phone":null
);

SELECT JSON_OBJECT(
    'name' : FirstName,
    'phone' : Phone ABSENT ON NULL  -- omits "phone" key entirely when NULL
);

-- JSON_ARRAY: construct a JSON array
SELECT JSON_ARRAY(1, 'two', NULL, GETDATE() NULL ON NULL);
-- [1,"two",null,"2024-03-15T10:30:00"]

-- JSON_PATH_EXISTS: test whether a path exists without extracting a value
-- Distinguishes "path missing" from "path exists but is null"
SELECT
    JSON_VALUE(doc, '$.phone')    AS PhoneValue,       -- NULL for both cases
    JSON_PATH_EXISTS(doc, '$.phone') AS PhoneExists    -- 0 or 1
FROM Documents;
```

> [!NOTE] SQL Server 2022
> `JSON_OBJECT`, `JSON_ARRAY`, and `JSON_PATH_EXISTS` are new in SQL Server
> 2022. See `references/19-json-xml.md` for the full JSON reference.

---

### DATETRUNC

Truncates a date/time value to the specified precision. Cleaner than the
`DATEADD(DATEPART, DATEDIFF(...))` hack.

```sql
-- Truncate to month start
SELECT DATETRUNC(MONTH, '2024-03-15 14:30:00');
-- 2024-03-01 00:00:00.000

-- Truncate to hour
SELECT DATETRUNC(HOUR, SYSDATETIME());

-- Use in GROUP BY for time-series
SELECT
    DATETRUNC(DAY, OrderTime) AS OrderDay,
    COUNT(*) AS Orders,
    SUM(Amount) AS Revenue
FROM Orders
GROUP BY DATETRUNC(DAY, OrderTime)
ORDER BY OrderDay;
```

Supported parts: `MICROSECOND`, `MILLISECOND`, `SECOND`, `MINUTE`, `HOUR`,
`DAY`, `WEEK`, `ISO_WEEK`, `DAYOFYEAR`, `MONTH`, `QUARTER`, `YEAR`.

> [!NOTE] SQL Server 2022
> `DATETRUNC` is new in SQL Server 2022.

> [!WARNING] WEEK truncation
> `DATETRUNC(WEEK, ...)` is affected by `@@DATEFIRST`. For ISO week behavior
> use `ISO_WEEK`.

---

### WINDOW Clause

The `WINDOW` clause names reusable window frame definitions, reducing
duplication when the same window specification is used in multiple functions.

```sql
-- Without WINDOW clause (repetitive)
SELECT
    OrderId,
    Amount,
    SUM(Amount)   OVER (PARTITION BY CustomerId ORDER BY OrderDate
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RunningTotal,
    AVG(Amount)   OVER (PARTITION BY CustomerId ORDER BY OrderDate
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RunningAvg,
    COUNT(*)      OVER (PARTITION BY CustomerId ORDER BY OrderDate
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RunningCount
FROM Orders;

-- With WINDOW clause (SQL Server 2022+)
SELECT
    OrderId,
    Amount,
    SUM(Amount)  OVER w AS RunningTotal,
    AVG(Amount)  OVER w AS RunningAvg,
    COUNT(*)     OVER w AS RunningCount
FROM Orders
WINDOW w AS (
    PARTITION BY CustomerId
    ORDER BY OrderDate
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
);

-- Multiple named windows
SELECT
    OrderId, Amount,
    ROW_NUMBER() OVER win_partition AS RowNum,
    SUM(Amount)  OVER win_running  AS RunningTotal
FROM Orders
WINDOW
    win_partition AS (PARTITION BY CustomerId),
    win_running   AS (PARTITION BY CustomerId ORDER BY OrderDate
                      ROWS UNBOUNDED PRECEDING);
```

> [!NOTE] SQL Server 2022
> The `WINDOW` clause is new in SQL Server 2022. It is a readability
> improvement only — there is no performance difference vs inline window specs.

---

## IQP Enhancements

SQL Server 2022 adds four new Intelligent Query Processing features, all
requiring compatibility level 160. See `references/31-intelligent-query-processing.md`
for the complete IQP reference.

### DOP Feedback

The query optimizer learns the optimal degree of parallelism for recurring
queries, reducing `CXPACKET`/`CXCONSUMER` waits caused by over-parallelization.

- Requires Query Store in `READ_WRITE` mode
- Persists DOP recommendations in `sys.query_store_plan_feedback`
- Applies automatically after enough executions (typically 3–5)

```sql
-- Check DOP feedback in action
SELECT
    qsq.query_id,
    qsp.plan_id,
    qspf.feature_desc,
    qspf.feedback_data,
    qspf.state_desc
FROM sys.query_store_plan_feedback qspf
JOIN sys.query_store_plan  qsp ON qsp.plan_id  = qspf.plan_id
JOIN sys.query_store_query qsq ON qsq.query_id = qsp.query_id
WHERE qspf.feature_desc = 'DopFeedback';

-- Disable DOP feedback for a specific database
ALTER DATABASE SCOPED CONFIGURATION SET DOP_FEEDBACK = OFF;

-- Disable for a specific query via Query Store hint
EXEC sys.sp_query_store_set_hints
    @query_id = 42,
    @query_hints = N'OPTION(DISABLE_TSQL_SCALAR_UDF_INLINING, USE HINT(''DISABLE_DOP_FEEDBACK''))';
```

### CE Feedback

The CE (cardinality estimator) identifies queries where its assumptions were
wrong and adjusts future estimates.

- Works with CE 160 (compat level 160)
- Targets specific join-containment assumption errors
- Not a substitute for keeping statistics current

```sql
-- Check CE feedback
SELECT
    qsq.query_id,
    qspf.feature_desc,
    qspf.feedback_data
FROM sys.query_store_plan_feedback qspf
JOIN sys.query_store_plan  qsp ON qsp.plan_id  = qspf.plan_id
JOIN sys.query_store_query qsq ON qsq.query_id = qsp.query_id
WHERE qspf.feature_desc = 'CeFeedback';

-- Disable CE feedback
ALTER DATABASE SCOPED CONFIGURATION SET CE_FEEDBACK = OFF;
```

### Memory Grant Feedback — Percentile and Persistence

SQL Server 2022 adds two modes on top of batch/row MGF from 2017/2019:

- **Percentile mode**: uses historical grant percentile (P70 by default) instead
  of just the last execution's feedback, reducing oscillation
- **Persistence mode**: stores grant feedback in Query Store so it survives
  server restarts

```sql
-- Disable percentile mode (reverts to 2019 last-value behavior)
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERCENTILE = OFF;

-- Disable persistence (feedback lost on restart)
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERSISTENCE = OFF;

-- Check persisted grant feedback
SELECT
    qsq.query_id,
    qspf.feature_desc,
    qspf.feedback_data
FROM sys.query_store_plan_feedback qspf
JOIN sys.query_store_plan  qsp ON qsp.plan_id  = qspf.plan_id
JOIN sys.query_store_query qsq ON qsq.query_id = qsp.query_id
WHERE qspf.feature_desc = 'MemoryGrantFeedback';
```

### Parameter-Sensitive Plan Optimization (PSPO)

PSPO automatically creates multiple compiled plans (variants) for a single
statement when the optimizer detects that different parameter values would
benefit from different plans. See `references/30-query-store.md` for full
PSPO details.

```sql
-- Check whether PSPO is active on a query
SELECT
    qsq.query_id,
    qsp.plan_id,
    qsp.plan_type_desc     -- 'Dispatcher' or 'Compiled Plan Variant'
FROM sys.query_store_plan qsp
JOIN sys.query_store_query qsq ON qsq.query_id = qsp.query_id
WHERE qsp.plan_type_desc <> 'Compiled Plan';

-- Disable PSPO database-wide
ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SENSITIVE_PLAN_OPTIMIZATION = OFF;
```

> [!NOTE] SQL Server 2022 + Compat 160
> All four IQP features above require `COMPATIBILITY_LEVEL = 160`.

---

## Query Store Improvements

SQL Server 2022 Query Store changes:

| Change | Details |
|---|---|
| On by default | New databases created on SQL Server 2022 have QS enabled by default (was off by default on 2019) |
| Read replicas | Query Store now collects data on readable AG secondaries |
| `sys.query_store_plan_feedback` | New DMV for DOP/CE/MGF feedback visibility |
| Hints API | `sp_query_store_set_hints` allows applying OPTION() hints without changing query text |
| Auto-tuning | Query Store auto-tuning (force last good plan) works with the new feedback mechanisms |

```sql
-- Verify QS is on (default for new DBs in 2022)
SELECT actual_state_desc, desired_state_desc, readonly_reason
FROM sys.database_query_store_options;

-- Apply a hint to a query without changing its text
EXEC sys.sp_query_store_set_hints
    @query_id   = 101,
    @query_hints = N'OPTION(RECOMPILE, MAXDOP 4)';

-- Query hints currently applied
SELECT qsq.query_id, qsqh.query_hint_id, qsqh.query_hints
FROM sys.query_store_query_hints qsqh
JOIN sys.query_store_query       qsq ON qsq.query_id = qsqh.query_id;
```

---

## XML Compression

SQL Server 2022 adds storage compression for `xml` columns and XML indexes.

```sql
-- Create a table with XML compression
CREATE TABLE dbo.Documents (
    DocId   INT PRIMARY KEY,
    DocXml  XML
)
WITH (XML_COMPRESSION = ON);

-- Alter an existing table to enable XML compression
ALTER TABLE dbo.Documents
REBUILD WITH (XML_COMPRESSION = ON);

-- Create a primary XML index with compression
CREATE PRIMARY XML INDEX pxi_Documents_DocXml
ON dbo.Documents(DocXml)
WITH (XML_COMPRESSION = ON);

-- Check XML compression state
SELECT
    t.name AS TableName,
    p.data_compression_desc,
    p.xml_compression
FROM sys.partitions p
JOIN sys.tables     t ON t.object_id = p.object_id
WHERE t.name = 'Documents';
```

> [!NOTE] SQL Server 2022
> XML compression is new in SQL Server 2022. It uses a separate flag
> (`xml_compression`) independent of the row/page compression setting.
> Typical savings: 20–60% for XML-heavy workloads.

---

## ADR Improvements

**Accelerated Database Recovery** (introduced in SQL Server 2019) was improved
in SQL Server 2022:

| Area | 2019 | 2022 |
|---|---|---|
| Persistent Version Store (PVS) | In TempDB | Moved to user database (reduces TempDB pressure) |
| ADR cleaner | Single-threaded | Multi-threaded (faster PVS cleanup) |
| Version store size | Can grow unbounded | `sys.dm_tran_persistent_version_store_stats` has better visibility |
| Abort operations | Must fully abort | Secondary truncation of log possible |

```sql
-- Enable ADR (off by default on-prem)
ALTER DATABASE YourDatabase
SET ACCELERATED_DATABASE_RECOVERY = ON;

-- Check PVS size and cleanup stats
SELECT
    pvss.persistent_version_store_size_kb / 1024.0 AS PVS_MB,
    pvss.online_index_version_store_size_kb / 1024.0 AS OnlineIndexPVS_MB,
    pvss.current_abort_version_cleaner_start_time,
    pvss.oldest_transaction_begin_time
FROM sys.dm_tran_persistent_version_store_stats pvss;
```

> [!WARNING] ADR and TempDB
> On SQL Server 2019, ADR's PVS lived in TempDB. On SQL Server 2022, it moves
> to the user database. If you upgrade a database that had ADR enabled on 2019,
> the PVS migrates automatically but the initial migration can cause a brief
> spike in user DB log activity.

---

## PolyBase and OPENROWSET Enhancements

SQL Server 2022 extends PolyBase and OPENROWSET for S3 and delta format support.

```sql
-- OPENROWSET against S3 (no external table required)
SELECT *
FROM OPENROWSET(
    BULK 's3://mybucket/data/orders/*.parquet',
    FORMAT = 'PARQUET'
) AS orders;

-- Parquet file directly from S3
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 's3://mybucket/data/sales/2024/',
    FORMAT = 'CSV',
    FIELDTERMINATOR = ',',
    ROWTERMINATOR = '0x0a',
    FIRSTROW = 2
) WITH (
    OrderId   INT,
    OrderDate DATE,
    Amount    DECIMAL(18,2)
) AS sales;
```

**New formats and connectors in 2022:**
- Parquet files on S3 or Azure Blob (`FORMAT = 'PARQUET'`)
- Delta Lake tables (preview, requires Azure Arc)
- Oracle, Teradata, MongoDB connectors still require PolyBase scale-out

See `references/46-polybase-external-tables.md` for the full PolyBase reference.

---

## Azure Arc Integration

SQL Server 2022 is the first on-premises version designed for **Azure Arc**
integration, enabling cloud-based management of on-premises instances.

**What Azure Arc enables for SQL Server 2022:**

| Feature | Requires Arc | Description |
|---|---|---|
| Microsoft Defender for SQL | Yes | Cloud-based threat detection |
| Microsoft Purview governance | Yes | Data catalog and classification |
| Pay-as-you-go licensing | Yes | Billed per core-hour via Azure subscription |
| Automatic updates | Yes | Azure Update Manager integration |
| Performance dashboards | Yes | Azure Monitor workbooks for SQL Server |
| Best Practices Assessment | Yes | Scheduled health checks |

```sql
-- Check if instance is Arc-connected
SELECT *
FROM sys.dm_server_registry
WHERE registry_key LIKE '%ArcSqlExtension%';
```

> [!NOTE] SQL Server 2022
> Azure Arc integration does not change T-SQL behavior. It is an out-of-band
> management plane. You can run SQL Server 2022 fully on-premises without
> registering with Arc.

---

## Security Enhancements

### Granular UNMASK Permission (DDM)

Dynamic Data Masking previously required `UNMASK` at the database level.
SQL Server 2022 adds granular column/schema/table-level UNMASK grants.

```sql
-- Grant UNMASK on a specific column only
GRANT UNMASK ON dbo.Customers(CreditCardNumber) TO [ReportingUser];

-- Grant UNMASK on all columns in a schema
GRANT UNMASK ON SCHEMA::HumanResources TO [HRAdmin];

-- Grant full database UNMASK (legacy, still works)
GRANT UNMASK TO [DataOwner];

-- Test masking behavior
EXECUTE AS USER = 'ReportingUser';
SELECT CreditCardNumber FROM dbo.Customers;   -- Unmasked
SELECT SSN FROM dbo.Employees;                 -- Still masked
REVERT;
```

> [!NOTE] SQL Server 2022
> Granular UNMASK is new in SQL Server 2022. On 2019, UNMASK was
> database-level only.

### Ledger and Tamper Evidence

Covered in [Ledger Tables](#ledger-tables) above.

### Other Security Changes

- **Transparent Data Encryption**: S3 backup encryption integrated with TDE
  certificate (see `references/44-backup-restore.md`)
- **Always Encrypted enclaves**: Improvements to attestation with VBS enclaves
  on Windows Server 2022

---

## Replication and AG Improvements

### Contained AG

Covered in [Contained Availability Groups](#contained-availability-groups).

### AG Improvements

| Feature | Details |
|---|---|
| Contained AG | Login/job portability within the AG |
| Distributed AG improvements | Automatic seeding improvements |
| Multiple subnet listener | Listener now supports multiple subnets without IP resource |

```sql
-- Multiple-subnet listener (2022 syntax)
ALTER AVAILABILITY GROUP [MyAG]
ADD LISTENER 'myaglistener' (
    WITH DHCP ON ('10.0.0.0/24', '10.1.0.0/24')
);
```

---

## DMV Changes

New and changed DMVs in SQL Server 2022:

| DMV | What Is New |
|---|---|
| `sys.query_store_plan_feedback` | IQP feedback (DOP, CE, MGF) |
| `sys.query_store_query_hints` | Applied Query Store hints |
| `sys.dm_tran_persistent_version_store_stats` | ADR PVS monitoring |
| `sys.dm_hadr_contained_instances` | Contained AG contained objects |
| `sys.dm_server_services` | Added `arc_status` column |
| `sys.partitions` | Added `xml_compression` column |

```sql
-- Key new columns added to existing DMVs

-- sys.partitions — XML compression
SELECT
    OBJECT_NAME(object_id) AS TableName,
    data_compression_desc,
    xml_compression
FROM sys.partitions
WHERE object_id = OBJECT_ID('dbo.Documents');

-- sys.query_store_plan_feedback — all feedback types
SELECT
    plan_id, feature_desc, state_desc, feedback_data, create_time
FROM sys.query_store_plan_feedback
ORDER BY create_time DESC;
```

---

## Deprecated and Removed Features

Features deprecated or removed in SQL Server 2022:

| Feature | Status | Replacement |
|---|---|---|
| PolyBase scale-out groups | Removed in 2022 | Not replaced; use single-node PolyBase |
| `sp_addextendedproc` | Deprecated | CLR stored procedures |
| `DBCC SHOWCONTIG` | Deprecated (was deprecated in 2005) | `sys.dm_db_index_physical_stats` |
| Non-Unicode data types in FTS | Deprecated | Unicode columns |
| Stretch Database | Deprecated in 2022 | Azure Data Factory, ADX |
| ActiveX scripting in SQL Agent | Removed | PowerShell or CmdExec job steps |
| Database Mirroring | Deprecated (since 2012) | Always On AG |

> [!WARNING] Stretch Database Deprecated
> Stretch Database was deprecated in SQL Server 2022 and will be removed in a
> future version. Migrate cold data to Azure using Azure Data Factory or
> Azure Data Explorer.

> [!WARNING] PolyBase Scale-Out Groups Removed
> PolyBase scale-out groups were removed in SQL Server 2022. If your 2019
> deployment used scale-out groups for parallel query across multiple nodes,
> this functionality is no longer available. Single-node PolyBase remains.

---

## Azure SQL Comparison

Features that were available in Azure SQL before appearing in SQL Server 2022:

| Feature | Azure SQL DB | Azure SQL MI | SQL Server 2022 |
|---|---|---|---|
| Ledger tables | 2021 | 2021 | Yes |
| GENERATE_SERIES | 2022 | 2022 | Yes |
| JSON_OBJECT/JSON_ARRAY | 2022 | 2022 | Yes |
| IS DISTINCT FROM | 2022 | 2022 | Yes |
| GREATEST / LEAST | 2022 | 2022 | Yes |
| DOP Feedback | Automatic Tuning | Preview | Yes (compat 160) |
| CE Feedback | Preview | Preview | Yes (compat 160) |
| PSPO | 2021 | 2021 | Yes (compat 160) |
| Contained AG | N/A | N/A | Yes (on-prem) |
| S3 backup | No | No | Yes (on-prem) |
| ADR | Default ON | Default ON | Optional (off by default) |
| QS on by default | Always | Always | New databases only |

Features in Azure SQL but **not** in SQL Server 2022:
- Serverless compute tier
- Hyperscale architecture
- Automatic index management
- Azure Arc integration (SQL Server 2022 supports connecting to Arc; Azure SQL is natively Azure)

---

## Upgrade Checklist: 2019 → 2022

Before upgrading, review these items:

```
Pre-upgrade:
[ ] Run sys.dm_os_host_info to confirm OS compatibility (Windows Server 2016+ or RHEL/Ubuntu 2022-supported)
[ ] Check for use of PolyBase scale-out groups (removed in 2022)
[ ] Check for use of Stretch Database (deprecated)
[ ] Check for ActiveX SQL Agent job steps (removed)
[ ] Enable Query Store and collect baseline on SQL Server 2019
[ ] Force plans for top 20 queries using Query Store before upgrade

Post-upgrade (leave at compat 150 initially):
[ ] Verify all services start
[ ] Run sp_Blitz for health check
[ ] Compare wait stats against baseline
[ ] Run workload for ≥ 1 business cycle

Compat level upgrade (150 → 160):
[ ] Read release notes for CE 160 changes
[ ] Enable for non-production first
[ ] Monitor Query Store for plan regressions (threshold: +50% duration)
[ ] Force old plans for any regressed queries
[ ] Roll forward once stable for ≥ 1 business cycle

New features to consider enabling:
[ ] ADR (ALTER DATABASE ... SET ACCELERATED_DATABASE_RECOVERY = ON) for long transactions
[ ] Query Store on new databases (now default; enable for migrated DBs)
[ ] XML compression on xml-heavy tables
[ ] GENERATE_SERIES to replace recursive CTE number generators
[ ] DATE_BUCKET / DATETRUNC for time-series simplification
[ ] IS NOT DISTINCT FROM for null-safe comparisons
```

See `references/53-migration-compatibility.md` for the full compatibility
level migration reference.

---

## Gotchas

1. **GENERATE_SERIES requires compat 160.** Unlike most 2022 T-SQL functions,
   `GENERATE_SERIES` requires `COMPATIBILITY_LEVEL = 160`. Running it at compat
   150 on a SQL 2022 instance raises an error.

2. **S3 credential uses colon separator.** The `SECRET` for S3 credentials
   is `'accessKeyId:secretAccessKey'`. Forgetting the colon or swapping with
   the Azure Blob SAS format produces authentication errors that look like
   access-denied errors.

3. **Contained AG does not replicate server-level sp_configure.** If your
   workload depends on non-default settings (MAXDOP, max server memory), you
   must configure those on every replica independently. The contained AG only
   replicates logins, jobs, linked servers, and custom error messages.

4. **PSPO creates multiple plan cache entries.** A single query can have a
   Dispatcher plan plus N variant plans. Tools that count plans-per-query
   may show unexpected numbers. Query Store's `plan_type_desc` column
   distinguishes them.

5. **DOP Feedback requires Query Store in READ_WRITE.** If QS is in
   READ_ONLY mode, DOP Feedback silently does nothing. Check
   `sys.database_query_store_options.actual_state_desc`.

6. **ADR PVS moved to user DB.** If upgrading a database that had ADR enabled
   on SQL Server 2019, the PVS moves from TempDB to the user database. User DB
   transaction log may temporarily grow during the first few minutes after attach.

7. **XML compression is separate from row/page compression.** `WITH (DATA_COMPRESSION = PAGE)` and `WITH (XML_COMPRESSION = ON)` are independent options. You can have both.

8. **WINDOW clause is a readability feature only.** There is no execution
   plan difference between a named `WINDOW` and an inline window spec. If you
   see no performance improvement, that is expected.

9. **GREATEST/LEAST differ from ISNULL/COALESCE in NULL behavior.** `GREATEST(1, NULL, 3)` returns 3 (NULLs ignored unless all NULL). `COALESCE(NULL, 1, 3)` returns 1 (first non-NULL). These are fundamentally different operations.

10. **DATE_BUCKET default origin is 1900-01-01 (a Monday).** For weekly
    bucketing, the default aligns to Monday. Use the `origin` parameter to
    change alignment (e.g., use `1900-01-07` for Sunday-aligned weeks).

11. **QS on by default only for new databases.** Existing databases migrated
    or upgraded to SQL Server 2022 do not automatically get Query Store
    enabled. You must `ALTER DATABASE ... SET QUERY_STORE = ON` manually.

12. **Stretch Database is deprecated — do not add new tables.** If you have
    existing Stretch tables, they continue to work in SQL Server 2022, but
    plan your migration now. The feature will be removed in a future release.

---

## See Also

- `references/22-ledger-tables.md` — Full ledger tables reference
- `references/31-intelligent-query-processing.md` — Full IQP reference including DOP/CE feedback
- `references/30-query-store.md` — Query Store and PSPO reference
- `references/43-high-availability.md` — Contained AG and full HA reference
- `references/44-backup-restore.md` — S3 backup syntax and restore patterns
- `references/46-polybase-external-tables.md` — Full PolyBase/S3 OPENROWSET reference
- `references/52-2025-features.md` — SQL Server 2025 features
- `references/53-migration-compatibility.md` — Compat level upgrade strategy

---

## Sources

[^1]: [SQL Server 2022 Release Notes](https://learn.microsoft.com/en-us/sql/sql-server/sql-server-2022-release-notes) — known issues, limitations, and build number information for SQL Server 2022 (16.x)
[^2]: [What's New in SQL Server 2022](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2022) — comprehensive overview of all new features and enhancements introduced in SQL Server 2022 (16.x)
[^3]: [DATE_BUCKET (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/date-bucket-transact-sql) — syntax, arguments, return types, and examples for the DATE_BUCKET time-series bucketing function
[^4]: [GENERATE_SERIES (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/generate-series-transact-sql) — syntax, arguments, and examples for the GENERATE_SERIES set-returning function; notes compat level 160 requirement
[^5]: [IS [NOT] DISTINCT FROM (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/is-distinct-from-transact-sql) — syntax, NULL-safe comparison semantics, and examples for IS [NOT] DISTINCT FROM
[^6]: [Ledger Overview](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-overview) — overview of ledger table architecture, append-only vs. updatable ledger tables, and cryptographic tamper-evidence capabilities
[^7]: [What Is a Contained Availability Group?](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/contained-availability-groups-overview) — overview of contained AG architecture, contained system databases, supported objects, and limitations
[^8]: [SQL Server back up to URL for S3-compatible object storage](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/sql-server-backup-to-url-s3-compatible-object-storage) — concepts, requirements, credential format, and supported BACKUP/RESTORE options for S3-compatible object storage
[^9]: [Intelligent Query Processing](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing) — full IQP feature family reference including compatibility level requirements for DOP feedback, CE feedback, PSPO, and memory grant feedback
[^10]: [Degree of parallelism (DOP) feedback](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-degree-parallelism-feedback) — detailed reference for DOP feedback behavior, Query Store persistence, extended events, and configuration options
[^11]: [What's New in SQL Server 2022](https://www.brentozar.com/archive/2021/11/whats-new-in-sql-server-2022/) — Brent Ozar's community commentary on SQL Server 2022 features including managed instance failover, Azure Synapse Link, ledger tables, and parameter-sensitive plan optimization
[^12]: [SQL Server 2022](https://learn.microsoft.com/en-us/lifecycle/products/sql-server-2022) — Microsoft Lifecycle page for SQL Server 2022 with mainstream and extended support end dates

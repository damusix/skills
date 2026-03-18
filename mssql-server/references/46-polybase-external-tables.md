# PolyBase and External Tables

## Table of Contents

1. [When to Use](#when-to-use)
2. [PolyBase Architecture Overview](#polybase-architecture-overview)
3. [PolyBase Versions and Editions](#polybase-versions-and-editions)
4. [Installing and Enabling PolyBase](#installing-and-enabling-polybase)
5. [External Data Sources](#external-data-sources)
6. [External File Formats](#external-file-formats)
7. [External Tables](#external-tables)
8. [OPENROWSET for Ad-Hoc Queries](#openrowset-for-ad-hoc-queries)
9. [S3-Compatible Object Storage](#s3-compatible-object-storage)
10. [Azure Blob Storage](#azure-blob-storage)
11. [Hadoop / HDFS](#hadoop--hdfs)
12. [Oracle, Teradata, MongoDB, ODBC Sources](#oracle-teradata-mongodb-odbc-sources)
13. [Predicate Pushdown](#predicate-pushdown)
14. [Statistics on External Tables](#statistics-on-external-tables)
15. [Data Virtualization vs Data Import](#data-virtualization-vs-data-import)
16. [PolyBase Scale-Out Groups](#polybase-scale-out-groups)
17. [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)
18. [Azure SQL and Synapse Differences](#azure-sql-and-synapse-differences)
19. [Metadata Queries](#metadata-queries)
20. [Common Patterns](#common-patterns)
21. [Gotchas](#gotchas)
22. [See Also](#see-also)
23. [Sources](#sources)

---

## When to Use

Use PolyBase when you need to:
- **Query external data in-place** without importing it (data virtualization)
- **Load data into SQL Server** from flat files, cloud storage, or other databases using external tables instead of BULK INSERT
- **Federate queries** across SQL Server and a RDBMS (Oracle, Teradata, MongoDB) without linked servers
- **Export data** to external storage (INSERT INTO external table for S3/Azure Blob)
- **Access parquet/CSV/JSON/ORC files** stored on S3-compatible storage, Azure Blob, ADLS Gen2, or HDFS

**Prefer linked servers when:** you need real-time transactional federation to another SQL Server instance — PolyBase is optimized for analytical/bulk patterns.

**Prefer BULK INSERT when:** you need simple, well-understood CSV/format-file loading from a network share or local path, and don't need data virtualization.

---

## PolyBase Architecture Overview

```
┌─────────────────────────────────────────┐
│           SQL Server Engine             │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  Query Plan  │  │  PolyBase DMS   │  │  ← Data Movement Service
│  │  (pushdown?) │  │  (data xfer)    │  │
│  └──────┬───────┘  └────────┬────────┘  │
└─────────┼───────────────────┼───────────┘
          │ SQL               │ data
          ▼                   ▼
  ┌───────────────┐   ┌───────────────┐
  │ PolyBase      │   │ External      │
  │ Engine        │   │ Storage       │
  │ (pushdown     │   │ (S3, Azure    │
  │  queries)     │   │  Blob, HDFS,  │
  └───────────────┘   │  Oracle, etc) │
                      └───────────────┘
```

**Key components:**

| Component | Role |
|---|---|
| SQL Engine | Parses query, builds plan, decides pushdown |
| PolyBase Engine | Translates SQL to external system queries |
| Data Movement Service (DMS) | Transfers data between external source and SQL Server |
| External Data Source | The remote storage or RDBMS |
| External File Format | How to parse files (delimiter, encoding, row terminator) |
| External Table | Schema definition mapped to external data |

> [!NOTE] SQL Server 2022
> PolyBase in 2022 adds S3-compatible object storage support, improved parquet handling, and `OPENROWSET` enhancements without requiring full PolyBase installation in some scenarios.

---

## PolyBase Versions and Editions

| Feature | 2016 | 2019 | 2022 |
|---|---|---|---|
| Hadoop / HDFS | ✓ | ✓ | ✓ |
| Azure Blob Storage | ✓ | ✓ | ✓ |
| SQL Server (ODBC) | — | ✓ | ✓ |
| Oracle | — | ✓ | ✓ |
| Teradata | — | ✓ | ✓ |
| MongoDB | — | ✓ | ✓ |
| S3-compatible storage | — | — | ✓ |
| Scale-out groups | ✓ (on-prem) | ✓ (on-prem) | ✓ (on-prem) |
| Edition requirement | Enterprise | All editions (2019+) | All editions |

> [!WARNING] Deprecated
> PolyBase scale-out groups (head + compute nodes for Hadoop federation) are deprecated as of SQL Server 2022. Use single-node PolyBase with direct S3/Azure Blob connectivity instead. Scale-out groups were removed from SQL Server 2025.

---

## Installing and Enabling PolyBase

### Installation

PolyBase is a separate feature component installed via SQL Server Setup:
1. In SQL Server Setup, check **PolyBase Query Service for External Data**
2. Optionally check **Java Runtime** if using Hadoop/HDFS connectors

### Enable via sp_configure

```sql
-- Check if PolyBase is installed
SELECT SERVERPROPERTY('IsPolyBaseInstalled');  -- 1 = yes

-- Enable PolyBase
EXEC sp_configure 'polybase enabled', 1;
RECONFIGURE;

-- Verify
SELECT name, value_in_use
FROM sys.configurations
WHERE name = 'polybase enabled';
```

### Service accounts

PolyBase runs two services: `MSSQLPolyBase` and `MSSQLLaunchpad`. Both need network access to external sources. On Windows, these run as the SQL Server service account by default.

### Java for Hadoop

For HDFS connectivity, install a compatible JRE and set the `JAVA_HOME` environment variable before starting PolyBase services. SQL Server 2019+ bundles the Zulu JRE for convenience.

---

## External Data Sources

### Syntax

```sql
CREATE EXTERNAL DATA SOURCE <name>
WITH (
    TYPE = { HADOOP | BLOB_STORAGE | RDBMS | GENERIC },
    LOCATION = '<protocol>://<host>:<port>[/<path>]'
    [, CREDENTIAL = <database_scoped_credential>]
    [, CONNECTION_OPTIONS = '<key>=<value>[; ...]']  -- for RDBMS types
    [, PUSHDOWN = { ON | OFF }]
    [, SHARD_MAP_MANAGER_DATABASE_NAME = '<db>']      -- elastic query
    [, DATABASE_NAME = '<db>']                         -- RDBMS
);
```

### S3-compatible (SQL Server 2022+)

```sql
-- Create credential for S3
CREATE DATABASE SCOPED CREDENTIAL S3Credential
WITH IDENTITY = 'S3 Access Key',
     SECRET = 'accessKeyId:secretAccessKey';
-- Note: format is literally 'accessKeyId:secretAccessKey' concatenated with colon

CREATE EXTERNAL DATA SOURCE MyS3
WITH (
    TYPE = BLOB_STORAGE,
    LOCATION = 's3://<bucket-endpoint>',  -- e.g., s3://my-minio-host:9000
    CREDENTIAL = S3Credential
);
```

### Azure Blob Storage

```sql
-- For Azure Blob (WASBS / HTTPS)
CREATE DATABASE SCOPED CREDENTIAL AzureBlobCred
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
     SECRET = '<SAS token without leading ?>';

CREATE EXTERNAL DATA SOURCE MyAzureBlob
WITH (
    TYPE = BLOB_STORAGE,
    LOCATION = 'wasbs://<container>@<account>.blob.core.windows.net',
    CREDENTIAL = AzureBlobCred
);

-- Or using HTTPS URL style
CREATE EXTERNAL DATA SOURCE MyAzureBlobHTTPS
WITH (
    TYPE = BLOB_STORAGE,
    LOCATION = 'https://<account>.blob.core.windows.net/<container>',
    CREDENTIAL = AzureBlobCred
);
```

### RDBMS (Oracle, SQL Server, Teradata, MongoDB)

```sql
-- SQL Server to SQL Server (replaces linked server for analytics)
CREATE DATABASE SCOPED CREDENTIAL RemoteSQLCred
WITH IDENTITY = 'remoteuser',
     SECRET = 'password';

CREATE EXTERNAL DATA SOURCE RemoteSQLServer
WITH (
    TYPE = RDBMS,
    LOCATION = 'sqlserver://remote-server-name',
    DATABASE_NAME = 'RemoteDB',
    CREDENTIAL = RemoteSQLCred
);

-- Oracle
CREATE EXTERNAL DATA SOURCE OracleSource
WITH (
    TYPE = RDBMS,
    LOCATION = 'oracle://oracle-host:1521',
    DATABASE_NAME = 'ORCL',
    CREDENTIAL = OracleCred
);
```

---

## External File Formats

```sql
-- Delimited text (CSV)
CREATE EXTERNAL FILE FORMAT CsvFormat
WITH (
    FORMAT_TYPE = DELIMITEDTEXT,
    FORMAT_OPTIONS (
        FIELD_TERMINATOR = ',',
        STRING_DELIMITER = '"',
        FIRST_ROW = 2,              -- skip header row
        USE_TYPE_DEFAULT = TRUE,    -- use column default for nulls
        ENCODING = 'UTF8'           -- UTF8 or UTF16
    ),
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.GzipCodec'
    -- Supported compression: GzipCodec, DefaultCodec (deflate)
);

-- Parquet
CREATE EXTERNAL FILE FORMAT ParquetFormat
WITH (
    FORMAT_TYPE = PARQUET,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
    -- or GzipCodec; Snappy is default for Parquet in most tooling
);

-- ORC
CREATE EXTERNAL FILE FORMAT OrcFormat
WITH (
    FORMAT_TYPE = ORC,
    DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec'
);

-- Delta format (SQL Server 2022 preview, check current GA status)
-- Note: Delta Lake support via Parquet reading of Delta tables is available
-- through OPENROWSET in Azure Synapse; on-prem support varies
```

**Format type capabilities:**

| Format | Predicate pushdown | Column pruning | Compression | Schema enforcement |
|---|---|---|---|---|
| DELIMITEDTEXT | Limited | No (reads all cols) | gzip/deflate | No |
| PARQUET | Good | Yes | Snappy/gzip/none | Schema in file |
| ORC | Good | Yes | Snappy/zlib/none | Schema in file |

---

## External Tables

```sql
-- External table over CSV files
CREATE EXTERNAL TABLE dbo.SalesExternal (
    SaleDate    DATE             NOT NULL,
    ProductId   INT              NOT NULL,
    Quantity    INT              NOT NULL,
    Amount      DECIMAL(10, 2)   NOT NULL,
    Region      NVARCHAR(50)     NULL
)
WITH (
    DATA_SOURCE = MyS3,
    LOCATION = '/data/sales/',           -- directory; reads all files within
    FILE_FORMAT = CsvFormat,
    REJECT_TYPE = PERCENTAGE,            -- PERCENTAGE or VALUE
    REJECT_VALUE = 5,                    -- reject if >5% rows are bad
    REJECT_SAMPLE_VALUE = 1000           -- sample this many rows to compute %
);

-- External table over Parquet files
CREATE EXTERNAL TABLE dbo.EventsExternal (
    EventId     BIGINT,
    EventType   VARCHAR(100),
    EventTime   DATETIME2(3),
    Payload     NVARCHAR(MAX)
)
WITH (
    DATA_SOURCE = MyS3,
    LOCATION = '/data/events/year=2024/',
    FILE_FORMAT = ParquetFormat
);

-- External table to RDBMS (Oracle/SQL Server)
CREATE EXTERNAL TABLE dbo.RemoteOrders (
    OrderId     INT,
    CustomerId  INT,
    OrderDate   DATE,
    Total       DECIMAL(12, 2)
)
WITH (
    DATA_SOURCE = OracleSource,
    LOCATION = 'SCHEMA.ORDERS'           -- remote schema.table or just table
);
```

### LOCATION syntax rules

| Source | LOCATION examples |
|---|---|
| S3/Azure Blob directory | `/prefix/path/` — trailing slash means directory |
| S3/Azure Blob file | `/prefix/path/file.parquet` — specific file |
| Parquet partition directory | `/data/events/year=2024/` — Hive-style partitions |
| RDBMS | `schema.tablename` or just `tablename` |
| HDFS | `/hdfs/path/` |

### Rejected rows

```sql
-- Check rejection details after a query
SELECT * FROM sys.dm_exec_external_work;

-- Rows are written to a rejection table in the external location:
-- <location>/_rejections/<query-guid>/<timestamp>.txt
```

---

## OPENROWSET for Ad-Hoc Queries

`OPENROWSET` with PolyBase lets you query external files without creating an external table. Best for one-off exploratory queries.

### CSV via OPENROWSET BULK (traditional, no PolyBase required)

```sql
-- Read a single CSV file from a network share (traditional BULK provider)
SELECT *
FROM OPENROWSET(
    BULK 'C:\data\sales.csv',
    FORMATFILE = 'C:\data\sales.fmt',
    FIRSTROW = 2
) AS t;
```

### OPENROWSET with PolyBase connectivity (2022+)

> [!NOTE] SQL Server 2022
> SQL Server 2022 enables `OPENROWSET` to read directly from S3-compatible storage and Azure Blob without creating formal external table objects. The `CREDENTIAL` argument accepts a database-scoped credential.

```sql
-- Ad-hoc query against S3 parquet file (2022+)
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 's3://<endpoint>/bucket/path/file.parquet',
    FORMAT = 'PARQUET',
    CREDENTIAL = (
        IDENTITY = 'S3 Access Key',
        SECRET = 'accessKeyId:secretAccessKey'
    )
) AS t;

-- Read all parquet files in a directory
SELECT *
FROM OPENROWSET(
    BULK 's3://<endpoint>/bucket/path/*.parquet',
    FORMAT = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'S3 Access Key', SECRET = '...')
) AS t;

-- CSV with explicit schema (WITH clause)
SELECT *
FROM OPENROWSET(
    BULK 's3://<endpoint>/bucket/data.csv',
    FORMAT = 'CSV',
    FIRSTROW = 2,
    FIELDTERMINATOR = ',',
    ROWTERMINATOR = '0x0a',
    CREDENTIAL = (IDENTITY = 'S3 Access Key', SECRET = '...')
) WITH (
    Col1 INT,
    Col2 VARCHAR(100),
    Col3 DECIMAL(10,2)
) AS t;
```

---

## S3-Compatible Object Storage

> [!NOTE] SQL Server 2022
> Native S3 connector added in SQL Server 2022. Works with AWS S3, MinIO, Pure Storage FlashBlade, NetApp StorageGRID, Cloudflare R2, and other S3-API-compatible systems.

### Credential format

```sql
-- The SECRET must be 'accessKeyId:secretAccessKey' — note the colon separator
CREATE DATABASE SCOPED CREDENTIAL MyS3Cred
WITH IDENTITY = 'S3 Access Key',
     SECRET = 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

-- For HTTPS endpoint (when S3 uses custom domain with TLS)
CREATE EXTERNAL DATA SOURCE MyMinIO
WITH (
    TYPE = BLOB_STORAGE,
    LOCATION = 's3://<minio-host>:9000',   -- HTTP; use https:// for TLS
    CREDENTIAL = MyS3Cred
);
```

### Exporting data to S3

```sql
-- PolyBase enables writing to S3 via INSERT INTO external table
INSERT INTO dbo.ArchiveExternal    -- external table pointing to S3
SELECT *
FROM dbo.Orders
WHERE OrderDate < '2023-01-01';
-- Creates files in the S3 location; file naming is engine-controlled
```

### Backup to S3 (separate from PolyBase)

```sql
-- SQL Server 2022 backup to S3 uses a DIFFERENT credential format
-- (see 44-backup-restore.md for the backup-specific S3 syntax)
-- PolyBase S3 and backup S3 use different credential structures
```

---

## Azure Blob Storage

```sql
-- Using Managed Identity (Azure SQL MI / Azure VM with managed identity)
CREATE DATABASE SCOPED CREDENTIAL MIBlobCred
WITH IDENTITY = 'Managed Identity';

CREATE EXTERNAL DATA SOURCE AzureBlobMI
WITH (
    TYPE = BLOB_STORAGE,
    LOCATION = 'https://<account>.blob.core.windows.net/<container>',
    CREDENTIAL = MIBlobCred
);

-- Using SAS token
CREATE DATABASE SCOPED CREDENTIAL SASCred
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
     SECRET = 'sv=2021-06-08&ss=b&srt=co&sp=rwdlacuptfx&...';
     -- Note: no leading '?' character in the SAS token
```

---

## Hadoop / HDFS

```sql
CREATE EXTERNAL DATA SOURCE HadoopCluster
WITH (
    TYPE = HADOOP,
    LOCATION = 'hdfs://<namenode>:8020'
    -- No credential needed for Kerberos-secured clusters in some configs;
    -- for unsecured HDFS, no credential required
);

-- For Kerberos-secured Hadoop: configure krb5.conf and keytab separately
-- via PolyBase configuration files (not via T-SQL credentials)
```

> [!WARNING] Deprecated
> Hadoop connector scale-out groups are deprecated in SQL Server 2022. Single-node PolyBase with direct Hadoop connectivity still works for 2022, but plan to migrate to S3-based data lakes for new architectures.

---

## Oracle, Teradata, MongoDB, ODBC Sources

> [!NOTE] SQL Server 2019
> Generic RDBMS connector (TYPE = RDBMS and TYPE = GENERIC) introduced in SQL Server 2019 for Oracle, Teradata, MongoDB, and any ODBC-compatible source.

### Oracle

```sql
-- Requires Oracle OLE DB or ODBC driver on SQL Server host
CREATE DATABASE SCOPED CREDENTIAL OracleCred
WITH IDENTITY = 'oracleuser',
     SECRET = 'oraclepassword';

CREATE EXTERNAL DATA SOURCE OracleDB
WITH (
    TYPE = RDBMS,
    LOCATION = 'oracle://oracle-host:1521',
    DATABASE_NAME = 'ORCLPDB1',    -- PDB name or SID
    CREDENTIAL = OracleCred
);

CREATE EXTERNAL TABLE dbo.OracleCustomers (
    CustomerId   INT,
    CustomerName NVARCHAR(200),
    Country      VARCHAR(50)
)
WITH (
    DATA_SOURCE = OracleDB,
    LOCATION = 'ORASCHEMA.CUSTOMERS'
);

SELECT * FROM dbo.OracleCustomers WHERE Country = 'US';
```

### MongoDB

```sql
CREATE EXTERNAL DATA SOURCE MongoDB
WITH (
    TYPE = GENERIC,
    LOCATION = 'mongodb://mongo-host:27017',
    CONNECTION_OPTIONS = 'Database=mydb',
    CREDENTIAL = MongoCred
);

-- MongoDB external tables are read-only; schema must be defined
-- JSON fields are flattened; nested documents need explicit mapping
CREATE EXTERNAL TABLE dbo.MongoEvents (
    _id        NVARCHAR(50),
    eventType  VARCHAR(100),
    createdAt  DATETIME2
)
WITH (
    DATA_SOURCE = MongoDB,
    LOCATION = 'events'      -- collection name
);
```

### ODBC (generic)

```sql
-- TYPE = GENERIC with ODBC driver
CREATE DATABASE SCOPED CREDENTIAL ODBCCred
WITH IDENTITY = 'dbuser', SECRET = 'dbpassword';

CREATE EXTERNAL DATA SOURCE MySQLSource
WITH (
    TYPE = GENERIC,
    LOCATION = 'odbc://mysql-host:3306',
    CONNECTION_OPTIONS = 'Driver={MySQL ODBC 8.0 Unicode Driver};
                          Database=mydb',
    CREDENTIAL = ODBCCred,
    PUSHDOWN = ON
);
```

---

## Predicate Pushdown

Predicate pushdown means SQL Server sends filter conditions to the external source rather than pulling all data and filtering locally. This is the primary performance mechanism for external tables.

### How it works

When the optimizer builds a plan for an external table query, it examines predicates and decides which can be "pushed down":
1. Simple equality and range predicates on column values
2. Column projections (only retrieving needed columns — parquet/ORC)
3. Aggregates (SUM, COUNT) may or may not push depending on connector

The plan shows a **Remote Query** or **External Select** operator containing the pushed predicate.

### How to verify pushdown

```sql
-- Enable actual execution plan, then:
SELECT SaleDate, SUM(Amount) AS Total
FROM dbo.SalesExternal
WHERE Region = 'North'
  AND SaleDate >= '2024-01-01'
GROUP BY SaleDate;

-- In the plan, look for External Select or Remote Query operator
-- The operator text shows what SQL/predicate was sent to the remote source
```

### When pushdown fails

| Scenario | Why pushdown fails | Fix |
|---|---|---|
| Non-sargable predicate | `WHERE YEAR(SaleDate) = 2024` | Rewrite to range: `SaleDate >= '2024-01-01'` |
| CAST on column | `WHERE CAST(Amount AS INT) > 100` | Avoid function on column |
| Collation mismatch | String compare requires collation conversion | Match collations or use explicit COLLATE |
| Connector limitation | MongoDB doesn't push all predicates | Filter locally after pull |
| PUSHDOWN = OFF | Explicitly disabled on data source | Enable if performance permits |

### Force pushdown behavior

```sql
-- Disable pushdown at data source level (rarely useful)
ALTER EXTERNAL DATA SOURCE MyS3 SET PUSHDOWN = OFF;

-- Enable per-query (override data source default)
SELECT * FROM dbo.SalesExternal
WITH (PUSHDOWN = ON)
WHERE Region = 'North';
-- Note: table hint syntax for PUSHDOWN is not universally supported;
-- rely on data source setting and optimizer decision
```

---

## Statistics on External Tables

The optimizer treats external tables as having no statistics by default, leading to poor row estimates and potentially bad join strategies.

### Create statistics manually

```sql
-- Create statistics on an external table column
CREATE STATISTICS stat_region
ON dbo.SalesExternal (Region);

-- Note: SQL Server samples the external data to build the histogram
-- This reads actual data from S3/blob — can be slow for large files
CREATE STATISTICS stat_saledate
ON dbo.SalesExternal (SaleDate)
WITH FULLSCAN;   -- reads all data; use SAMPLE N ROWS for large sources

-- Multi-column statistics
CREATE STATISTICS stat_region_date
ON dbo.SalesExternal (Region, SaleDate);
```

### Verify statistics

```sql
DBCC SHOW_STATISTICS ('dbo.SalesExternal', 'stat_region');
```

### Manual statistics update

```sql
UPDATE STATISTICS dbo.SalesExternal;
-- Auto-update does NOT apply to external tables
-- You must manually update statistics after data changes in the external source
```

**Best practice:** Create statistics on all columns used in WHERE clauses and JOIN predicates for external tables. The cost of sampling once is worth the improved plan quality for repeated queries.

---

## Data Virtualization vs Data Import

| Approach | When to use | Trade-off |
|---|---|---|
| **External table (virtualization)** | Data lives naturally in cloud storage; you want to avoid duplication; data is too large to import | Slower per-query (network I/O each time); no local indexes |
| **CTAS / SELECT INTO** | You need fast repeated queries; data doesn't change often | Data copied to SQL Server; requires storage; staleness risk |
| **Staged import** | Regular batch loads (daily/hourly ETL) | Classic ETL pattern; combine with BULK INSERT or bcp |

### Import via SELECT INTO (CTAS equivalent)

```sql
-- Pull data from S3 into a local table
SELECT *
INTO dbo.SalesLocal
FROM dbo.SalesExternal
WHERE SaleDate >= '2024-01-01';

-- Or via INSERT with TABLOCK for minimal logging
INSERT INTO dbo.SalesLocal WITH (TABLOCK)
SELECT *
FROM dbo.SalesExternal
WHERE SaleDate >= '2024-01-01';
```

---

## PolyBase Scale-Out Groups

> [!WARNING] Deprecated
> Scale-out groups are deprecated in SQL Server 2022 and removed in SQL Server 2025. The following is for maintaining existing 2019 deployments.

Scale-out groups add compute nodes to parallelize data movement:

```sql
-- On the head node:
EXEC sp_polybase_join_group
    @head_node_machine_name = 'HEAD-NODE',
    @dms_control_channel_membershipport = 16450,
    @worker_data_movement_services_port = 16451;
```

For new deployments, use single-node PolyBase with direct object storage connectivity instead.

---

## Monitoring and Troubleshooting

### Active PolyBase requests

```sql
-- Currently running external queries
SELECT
    r.session_id,
    r.status,
    r.start_time,
    r.command,
    r.total_elapsed_time / 1000.0 AS elapsed_sec,
    t.text AS query_text
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.command LIKE '%External%'
   OR r.wait_type LIKE '%EXTERNAL%';

-- External work (data movement stats)
SELECT *
FROM sys.dm_exec_external_work;
```

### Data movement stats

```sql
SELECT
    execution_id,
    step_index,
    operation_type,
    distribution_type,
    status,
    rows_processed,
    bytes_processed,
    start_time,
    end_time,
    error_id
FROM sys.dm_exec_dms_workers;
```

### Error log

```sql
-- PolyBase errors appear in SQL Server error log
EXEC sp_readerrorlog 0, 1, 'PolyBase';

-- DMS service log (Windows):
-- %ProgramFiles%\Microsoft SQL Server\<instance>\MSSQL\Log\PolyBase\
```

### Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `Msg 46530: External tables not supported` | PolyBase not enabled | `sp_configure 'polybase enabled', 1` |
| `Msg 16543: Connection refused` | External source unreachable | Check firewall, DNS, credential |
| `Msg 7320: Cannot execute the query` | Predicate cannot be pushed | Check query for non-sargable expressions |
| `HdfsBridge::recordReaderFillBuffer - Unexpected error` | Schema mismatch | Verify column types match file schema |
| `Access Denied (S3 403)` | Credential wrong or IAM policy | Recheck access key ID and secret |
| Reject threshold exceeded | Bad data in files | Increase `REJECT_VALUE` or fix source files |

---

## Azure SQL and Synapse Differences

| Feature | Azure SQL Database | Azure SQL MI | SQL Server 2022 | Azure Synapse |
|---|---|---|---|---|
| External tables (BLOB_STORAGE) | Yes (via elastic query) | Yes | Yes | Yes (built-in) |
| External tables (RDBMS/Oracle) | Elastic query only | Yes | Yes | No |
| S3 connector | No | No | Yes | No |
| OPENROWSET (Parquet/CSV) | Limited | Limited | Yes (2022) | Yes (serverless SQL) |
| Scale-out | No | No | Deprecated | Built-in MPP |
| Predicate pushdown to Blob | Partial | Partial | Yes | Yes |

**Azure SQL Database elastic query:** A legacy feature for cross-database queries in Azure SQL that uses external tables and data sources. Functional but not recommended for new designs — use Azure Synapse Analytics or Azure Data Factory instead.

**Azure Synapse Analytics:** Has native, highly optimized support for Parquet/CSV on Azure Data Lake Storage Gen2 via serverless SQL pools. If your primary workload is analytics over cloud storage, Synapse is better-suited than SQL Server PolyBase.

---

## Metadata Queries

```sql
-- List all external data sources
SELECT
    name,
    type_desc,
    location,
    credential_id,
    pushdown
FROM sys.external_data_sources;

-- List all external file formats
SELECT
    name,
    format_type,
    field_terminator,
    string_delimiter,
    first_row,
    data_compression
FROM sys.external_file_formats;

-- List all external tables with their data source
SELECT
    t.name AS table_name,
    s.name AS schema_name,
    eds.name AS data_source_name,
    t.location,
    t.reject_type,
    t.reject_value
FROM sys.external_tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.external_data_sources eds ON t.data_source_id = eds.data_source_id;

-- Statistics on external tables
SELECT
    t.name AS table_name,
    s.name AS stat_name,
    s.auto_created,
    s.user_created,
    sp.last_updated,
    sp.rows,
    sp.rows_sampled
FROM sys.stats s
JOIN sys.external_tables t ON s.object_id = t.object_id
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp;

-- Database-scoped credentials
SELECT
    name,
    credential_identity,
    create_date,
    modify_date
FROM sys.database_scoped_credentials;
```

---

## Common Patterns

### Pattern 1: Daily data load from S3 into local staging table

```sql
-- Assumes external table dbo.RawSalesExternal exists over S3 path
-- Run as a daily SQL Agent job

DECLARE @cutoff DATE = DATEADD(DAY, -1, CAST(GETDATE() AS DATE));

TRUNCATE TABLE dbo.SalesStaging;

INSERT INTO dbo.SalesStaging WITH (TABLOCK)
SELECT
    SaleDate,
    ProductId,
    Quantity,
    Amount,
    Region
FROM dbo.RawSalesExternal
WHERE SaleDate = @cutoff;

-- Then merge into production table
MERGE dbo.SalesFact AS tgt
USING dbo.SalesStaging AS src
    ON tgt.SaleDate = src.SaleDate AND tgt.ProductId = src.ProductId
WHEN MATCHED THEN
    UPDATE SET tgt.Quantity = src.Quantity, tgt.Amount = src.Amount
WHEN NOT MATCHED BY TARGET THEN
    INSERT (SaleDate, ProductId, Quantity, Amount, Region)
    VALUES (src.SaleDate, src.ProductId, src.Quantity, src.Amount, src.Region);
```

### Pattern 2: Ad-hoc analytics on S3 parquet without external table

```sql
-- One-off query — no external table setup needed (SQL Server 2022+)
SELECT
    Region,
    SUM(Amount) AS TotalSales,
    COUNT(*) AS NumOrders
FROM OPENROWSET(
    BULK 's3://my-endpoint/sales-data/year=2024/*.parquet',
    FORMAT = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'S3 Access Key', SECRET = 'key:secret')
) WITH (
    Region   VARCHAR(50),
    Amount   DECIMAL(10,2)
) AS t
GROUP BY Region
ORDER BY TotalSales DESC;
```

### Pattern 3: Export SQL Server data to S3

```sql
-- Create an external table pointing to a write location
CREATE EXTERNAL TABLE dbo.ArchiveExport2023 (
    OrderId   INT,
    OrderDate DATE,
    Total     DECIMAL(12,2),
    Region    VARCHAR(50)
)
WITH (
    DATA_SOURCE = MyS3,
    LOCATION = '/archive/orders/2023/',
    FILE_FORMAT = ParquetFormat
);

-- Export data
INSERT INTO dbo.ArchiveExport2023
SELECT OrderId, OrderDate, Total, Region
FROM dbo.Orders
WHERE YEAR(OrderDate) = 2023;
-- Files are created in S3 with engine-chosen names
```

### Pattern 4: Cross-database federation (RDBMS connector)

```sql
-- Query Oracle data from SQL Server with a local join
SELECT
    lo.OrderId,
    lo.OrderDate,
    oc.CustomerName,
    oc.Country
FROM dbo.LocalOrders lo
JOIN dbo.OracleCustomers oc   -- external table over Oracle
    ON lo.CustomerId = oc.CustomerId
WHERE lo.OrderDate >= '2024-01-01'
  AND oc.Country = 'US';
-- Optimizer will push the Country = 'US' filter to Oracle
-- OrderDate filter applies locally after join
```

---

## Gotchas

1. **PolyBase must be enabled explicitly.** `sp_configure 'polybase enabled', 1; RECONFIGURE` is required even after installation. Forgetting this produces `Msg 46530`.

2. **Database-scoped credentials are per-database.** You must create the credential in the same database as the external data source and external table. Moving the database requires recreating credentials (passwords are not backed up).

3. **S3 credential format is unusual.** The `SECRET` must be `'accessKeyId:secretAccessKey'` — not just the secret key. The colon separator is required.

4. **SAS tokens must not have a leading `?`.** When creating Azure Blob credentials, the `SECRET` must start with `sv=...`, not `?sv=...`.

5. **Auto-statistics update does not apply to external tables.** You must manually run `UPDATE STATISTICS` after the external data changes. Stale statistics lead to bad cardinality estimates and slow plans.

6. **REJECT_TYPE = PERCENTAGE requires REJECT_SAMPLE_VALUE.** Without a sample size, SQL Server cannot compute the percentage. Omitting `REJECT_SAMPLE_VALUE` causes an error.

7. **Predicate pushdown is not guaranteed.** Functions on columns, collation mismatches, and connector limitations prevent pushdown. Always check the execution plan's Remote Query operator to see what was pushed.

8. **External tables are read-only by default for most connectors.** Only BLOB_STORAGE data sources (S3, Azure Blob) support INSERT via external tables. RDBMS external tables are read-only in most configurations.

9. **LOCATION must match the actual path exactly.** S3 paths are case-sensitive. A mismatched path returns no rows (not an error) for some connectors.

10. **PolyBase services must be running.** `MSSQLPolyBase` and `MSSQLLaunchpad` services must be started. External table queries fail with timeout or connection errors if these services are stopped.

11. **Parquet schema must match the external table definition.** If the Parquet file has column name or type mismatches, you get runtime errors. Use `OPENROWSET` without a WITH clause first to discover the file schema.

12. **Scale-out groups require all nodes to have PolyBase installed.** For 2019 deployments only; don't use in 2022.

---

## See Also

- [`44-backup-restore.md`](44-backup-restore.md) — S3 backup syntax (different credential format from PolyBase)
- [`47-cli-bulk-operations.md`](47-cli-bulk-operations.md) — BULK INSERT, OPENROWSET BULK, bcp for file-based imports
- [`45-linked-servers.md`](45-linked-servers.md) — linked servers for OLTP cross-server federation
- [`16-security-encryption.md`](16-security-encryption.md) — database-scoped credentials and TDE
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — execution plan analysis for external queries

---

## Sources

[^1]: [Introducing Data Virtualization with PolyBase - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/polybase/polybase-guide) — overview of PolyBase architecture, supported connectors, and supported SQL Server versions
[^2]: [CREATE EXTERNAL DATA SOURCE (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-external-data-source-transact-sql) — full syntax and options for defining external data sources including S3, Azure Blob, RDBMS, and HADOOP types
[^3]: [CREATE EXTERNAL TABLE (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-external-table-transact-sql) — syntax, arguments, permissions, and examples for creating external tables over Hadoop, Azure Blob Storage, ADLS, and RDBMS sources
[^4]: [CREATE EXTERNAL FILE FORMAT (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-external-file-format-transact-sql) — defines file format objects for delimited text, Parquet, ORC, and Delta used by external tables
[^5]: [OPENROWSET (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/openrowset-transact-sql) — ad-hoc external data access including BULK provider for querying files on object storage in SQL Server 2022
[^6]: [Access External Data: S3-Compatible Object Storage - PolyBase - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/polybase/polybase-configure-s3-compatible) — configuring PolyBase to query S3-compatible object storage with basic authentication and STS pass-through authorization
[^7]: [Access external data: Oracle - PolyBase - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/polybase/polybase-configure-oracle) — configuring PolyBase RDBMS connector for Oracle external data sources introduced in SQL Server 2019
[^8]: [sys.external_tables (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-external-tables-transact-sql) — catalog view columns for external tables including location, reject settings, and data source references

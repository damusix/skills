# 53 — Migration & Compatibility

## Table of Contents

1. [When to Use](#when-to-use)
2. [Compatibility Level Overview](#compatibility-level-overview)
3. [Compatibility Level Table (100–170)](#compatibility-level-table)
4. [Cardinality Estimator (CE) Changes by Level](#cardinality-estimator-changes)
5. [Optimizer Changes by Level](#optimizer-changes-by-level)
6. [Contained Databases](#contained-databases)
7. [Deprecated Features by Version](#deprecated-features-by-version)
8. [Removed Features](#removed-features)
9. [Breaking Changes](#breaking-changes)
10. [Upgrade Checklist](#upgrade-checklist)
11. [Compatibility Level Testing Strategy](#compat-level-testing-strategy)
12. [Database Migration Assistant (DMA) and Azure Migrate](#dma-and-azure-migrate)
13. [Cross-Version Gotchas](#cross-version-gotchas)
14. [Azure SQL Migration Considerations](#azure-sql-migration)
15. [Metadata Queries](#metadata-queries)
16. [Common Patterns](#common-patterns)
17. [Gotchas](#gotchas)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

Load this reference when:
- Upgrading SQL Server from one version to another (e.g., 2016 → 2022)
- Migrating a database to Azure SQL Database or Managed Instance
- Evaluating whether to raise the compatibility level of an existing database
- Assessing deprecated or removed feature impact before an upgrade
- Investigating query regressions after a version or compat level change
- Planning a phased migration strategy

---

## Compatibility Level Overview

Every SQL Server database has a **compatibility level** (`sys.databases.compatibility_level`) that is independent of the server version. The engine version determines what features are *available*; the compatibility level controls how the *query optimizer* and certain T-SQL behaviors work.

**Key rules:**
- A database can run at any compat level from 100 up to the server's maximum level.
- Raising the compat level exposes new optimizer behaviors and IQP features — but can cause query plan regressions.
- Lowering the compat level is supported and non-destructive (for that session; no DDL changes).
- Azure SQL Database and Managed Instance have their own compat level ranges.

```sql
-- Check current compat level
SELECT name, compatibility_level FROM sys.databases ORDER BY name;

-- Change compat level
ALTER DATABASE [MyDB] SET COMPATIBILITY_LEVEL = 160;
```

> [!WARNING] Deprecated
> Compat levels below 110 (SQL Server 2012) are deprecated in SQL Server 2022 and may be removed in a future release.

---

## Compatibility Level Table

| Compat Level | SQL Server Version | Azure SQL DB | Azure SQL MI | Key Optimizer / T-SQL Changes |
|---|---|---|---|---|
| 100 | 2008 / 2008 R2 | No | No | Legacy CE (70 model), no row-version based reads by default |
| 110 | 2012 | No | No | CE 110, table variable deferred compilation NOT active, no OFFSET/FETCH |
| 120 | 2014 | No | No | CE 120 (new cardinality estimator), improved multi-statement TVF estimates |
| 130 | 2016 | Yes | Yes | CE 130, dynamic statistics threshold (`SQRT(1000 × rows)`), batch mode on disk-based tables eligible, `STRING_SPLIT`, `OPENJSON` |
| 140 | 2017 | Yes | Yes | CE 140, adaptive joins, interleaved execution for mTVFs, batch mode memory grant feedback, `STRING_AGG`, `CONCAT_WS`, `TRIM` |
| 150 | 2019 | Yes | Yes | CE 150, scalar UDF inlining, table variable deferred compilation, batch mode on rowstore, approximate count distinct, `APPROX_COUNT_DISTINCT` |
| 160 | 2022 | Yes | Yes | CE 160, DOP feedback, CE feedback, MGF percentile + persistence, PSPO, `GENERATE_SERIES`, `IS [NOT] DISTINCT FROM`, `GREATEST`/`LEAST`, `DATE_BUCKET`, `DATETRUNC`, `JSON_OBJECT`/`JSON_ARRAY`/`JSON_PATH_EXISTS`, `WINDOW` clause, `STRING_SPLIT` ordinal |
| 170 | 2025 | Preview | Preview | CE 170, Optimized Locking by default (RCSI required), `CURRENT_DATE`, `PRODUCT()`, `BASE64_ENCODE`/`DECODE`, `REGEXP_*`, `||` operator, `VECTOR` type, native JSON type, `AI_GENERATE_*` |

> [!NOTE] SQL Server 2022
> Compat level 160 is the default for new databases on SQL Server 2022.

> [!NOTE] SQL Server 2025
> Compat level 170 is the default for new databases on SQL Server 2025. Optimized Locking requires compat 160+ and RCSI enabled.

---

## Cardinality Estimator Changes

The CE version is tied to the compatibility level. Understanding CE changes is critical for diagnosing query plan regressions after upgrades.

### CE 70 (compat ≤ 80)
- Single-table density-only estimates
- Multi-join estimates: base-table row count ÷ join selectivity (very rough)
- Fixed 30% selectivity for range predicates without histograms

### CE 120 (compat 120, SQL Server 2014) — Major rewrite
- Per-column density vectors instead of table density
- Better multi-column correlation estimates
- Multi-join estimation changed (causes most post-2014 regressions)
- Containment assumption: default changed for ranges crossing histogram boundaries

### CE 130–140 (compat 130–140)
- Incremental improvements to multi-predicate estimates
- Interleaved execution feedback incorporated at compat 140

### CE 150 (compat 150, SQL Server 2019)
- Interleaved execution for mTVF cardinalities
- Scalar UDF inlining changes estimates for inlined expressions

### CE 160 (compat 160, SQL Server 2022)
- CE Feedback: engine detects join containment assumption failures and patches them via Query Store
- DOP Feedback: adjusts degree of parallelism based on observed wait stats
- Persisted MGF: memory grant corrections stored in Query Store between restarts

### Forcing the old CE
```sql
-- Per-query: force legacy CE 70
SELECT * FROM dbo.Orders WHERE OrderDate > '2024-01-01'
OPTION (USE HINT('FORCE_LEGACY_CARDINALITY_ESTIMATION'));

-- Per-database: use legacy CE for all queries
ALTER DATABASE SCOPED CONFIGURATION SET LEGACY_CARDINALITY_ESTIMATION = ON;

-- Per-query: force specific CE version
OPTION (USE HINT('QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_120'));
-- Valid values: 70, 80, 90, 100, 110, 120, 130, 140, 150, 160
```

---

## Optimizer Changes by Level

Beyond the CE, each compat level enables optimizer features that can change plan shapes.

### Compat 130 (SQL Server 2016)
- **Dynamic statistics threshold**: auto-update fires at `SQRT(1000 × table_rows)` instead of fixed 20% — critical for large tables
- **Batch mode**: columnstore queries eligible even on disk tables (limited)
- **Trivial plan**: improved detection

### Compat 140 (SQL Server 2017)
- **Adaptive joins**: optimizer can switch between nested loops and hash join after first execution
- **Interleaved execution**: mTVFs estimated at actual cardinality using first-execution feedback
- **Batch mode memory grant feedback**: over/under grants corrected on subsequent executions

### Compat 150 (SQL Server 2019)
- **Batch mode on rowstore**: regular B-tree tables eligible for batch mode without any columnstore index
- **Scalar UDF inlining**: eligible scalar UDFs expanded inline (eliminates per-row invocation)
- **Table variable deferred compilation**: `DECLARE @t TABLE` estimated from actual cardinality at first use
- **Approximate query processing**: `APPROX_COUNT_DISTINCT` uses HyperLogLog (~2% error, much faster)

### Compat 160 (SQL Server 2022)
- **DOP Feedback**: engine measures CXPACKET/CXCONSUMER waits and lowers DOP for subsequent runs
- **CE Feedback**: engine detects join assumption violations and patches estimate via QS hints
- **MGF Percentile**: memory grant feedback uses percentile of recent grants (not just last grant)
- **MGF Persistence**: corrections survive server restart (stored in Query Store)
- **PSPO (Parameter-Sensitive Plan Optimization)**: multiple variant plans for parameter-sniff-prone queries

### Compat 170 (SQL Server 2025)
- **Optimized Locking**: TID-based locking reduces contention on RCSI workloads (enabled by default, requires compat 160+)
- **DOP Feedback on by default**: auto-enabled at compat 160+ in 2025
- **sp_executesql compilation serialization**: prevents wasted parallel compilations

---

## Contained Databases

Contained databases reduce dependencies on the server-level context, improving portability.

### Containment levels

| Level | Description |
|---|---|
| `NONE` | Default — no containment |
| `PARTIAL` | Partial containment: contained users, some features restricted |
| `FULL` | Full containment: not available in on-premises SQL Server (Azure SQL only) |

### Partial containment

```sql
-- Enable at server level first
EXEC sp_configure 'contained database authentication', 1;
RECONFIGURE;

-- Enable on a database
ALTER DATABASE [MyDB] SET CONTAINMENT = PARTIAL;

-- Create a contained user (no login required)
USE [MyDB];
CREATE USER alice WITH PASSWORD = 'Str0ng!Passw0rd';

-- Check containment
SELECT name, containment_desc FROM sys.databases;
```

### What partial containment provides
- **Contained users**: password + user stored together in the database. No server-level login needed. Can be moved to another server and connect immediately.
- **Session-level collation**: uses database collation for temp tables (eliminates temp table collation mismatch)
- **Portable**: database attach/restore + user authentication works without recreating logins

### Partial containment limitations

| Feature | Availability |
|---|---|
| Linked servers | Not from contained context |
| `EXECUTE AS LOGIN` | Not in contained context |
| Extended stored procedures | Restricted |
| Service Broker cross-database | Restricted |
| SQL Server Agent | Not directly — logins still required for Agent |
| DDL triggers at server level | Not accessible |
| Cross-database queries | Work but break portability (cross-DB is "uncontained") |
| sp_configure | Still server-level |

```sql
-- Find uncontained features in a database before enabling containment
SELECT * FROM sys.dm_db_uncontained_entities;
```

> [!WARNING] Deprecated
> Full containment is only available in Azure SQL. Partial containment has limited adoption on-premises and some features interact poorly with it.

---

## Deprecated Features by Version

### Deprecated in SQL Server 2022 (removed in a future version)

| Feature | Replacement |
|---|---|
| Compat levels 80–100 | Upgrade to 110+ |
| `DBCC SHOW_STATISTICS` with non-current compat (specific behaviors) | Standard usage still works |
| Old-style outer join syntax (`*=`, `=*`) | ANSI JOIN syntax |
| `!<`, `!>` comparison operators | `>=`, `<=` |
| PolyBase scale-out groups | Single-node PolyBase or ADF |
| `sp_setapprole` without `@encrypt` parameter | Use explicit `@encrypt = 'odbc'` |
| `TEXTPTR()`, `READTEXT`, `WRITETEXT`, `UPDATETEXT` | `VARCHAR(MAX)`, `NVARCHAR(MAX)` |
| Non-ANSI `SET` options in some contexts | ANSI options |

```sql
-- Check for deprecated feature usage on your instance
SELECT * FROM sys.dm_os_performance_counters
WHERE counter_name = 'Deprecated feature use'
ORDER BY cntr_value DESC;

-- Also track specific deprecated features:
SELECT * FROM sys.dm_exec_plan_attributes(NULL)  -- for plan-level
-- Better: enable the 'Deprecation Announcement' and 'Deprecation Final Support' trace events
-- via Extended Events
```

### Deprecated in SQL Server 2019

| Feature | Replacement |
|---|---|
| `BACKUP LOG ... WITH NO_LOG` | Just don't back up the log (not a supported operation) |
| Stretch Database | Azure Synapse Link, ADF |
| SQL Server R Services (in-database) | ML Services |
| Old `sp_addlogin`, `sp_adduser`, `sp_grantlogin` | `CREATE LOGIN`, `CREATE USER` |
| `TEXT`, `NTEXT`, `IMAGE` data types | `VARCHAR(MAX)`, `NVARCHAR(MAX)`, `VARBINARY(MAX)` |

### Deprecated in SQL Server 2016/2017

| Feature | Replacement |
|---|---|
| `DBCC SHOWCONTIG` | `sys.dm_db_index_physical_stats` |
| `sp_dboption` | `ALTER DATABASE` |
| `sp_dropalias` | N/A (alias logins removed) |
| `DBCC PINTABLE`/`UNPINTABLE` | No direct replacement (buffer pool management removed) |
| `SQL_AltDiction_*` collations | BIN2 collations |

---

## Removed Features

These features are completely gone and will break if used:

### Removed in SQL Server 2022

| Feature | Last Version | Notes |
|---|---|---|
| PolyBase scale-out groups | 2019 | Single-node PolyBase still available |
| Stretch Database | 2022 RTM (deprecated → removed in 2025) | Use Azure Synapse Link |
| `Web` edition | 2019 | Standard or Developer edition |
| ActiveX (COM) SQL Agent job steps | 2019 | CmdExec or PowerShell steps |
| Database Mirroring | 2022 removed from feature list | Always On AG |

> [!NOTE] SQL Server 2025
> Web edition is completely discontinued in 2025. Workloads must use Standard or Developer editions.

### Removed in SQL Server 2019

| Feature | Last Version | Notes |
|---|---|---|
| Database mirroring (configuration) | 2019 | SSMS still shows, but officially removed |
| `DBCC DBREINDEX` | 2008 (kept working until 2014) | `ALTER INDEX ... REBUILD` |

### Removed in SQL Server 2016

| Feature | Notes |
|---|---|
| `syscomments`, `sysobjects` compatibility views (deprecated 2005–2012) | Use `sys.sql_modules`, `sys.objects` |
| `sp_db_vardecimal_storage_format` | ROW compression supersedes this |

---

## Breaking Changes

Changes that silently alter behavior without an error (the most dangerous kind):

### CE 120 regression patterns (upgrading to 2014 compat)
- **Multi-join estimates**: the new CE counts join selectivity differently. Queries with 3+ joins and uneven row count distributions can go from fast nested loops to slow hash joins.
- **Containment assumption**: affects predicates on ranges crossing a histogram step boundary. New CE uses "simple containment" for some and "base containment" for others — can over- or under-estimate.

**Detection**:
```sql
-- Find queries with significant plan regressions after compat upgrade
-- (Run before and after, compare with Query Store)
SELECT TOP 20
    qt.query_sql_text,
    qs.avg_worker_time / 1000 AS avg_cpu_ms,
    qs.execution_count,
    qp.query_plan
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan qp ON q.query_id = qp.query_id
JOIN sys.query_store_runtime_stats rs ON qp.plan_id = rs.plan_id
JOIN sys.query_store_runtime_stats_interval qs
    ON rs.runtime_stats_interval_id = qs.runtime_stats_interval_id
WHERE qs.end_time > DATEADD(HOUR, -24, GETUTCDATE())
ORDER BY avg_worker_time DESC;
```

### String comparison changes
- `NCHAR`/`NVARCHAR` comparison behavior can change with collation changes introduced in 2019+ (supplementary character collations)

### `ANSI_NULLS` and `QUOTED_IDENTIFIER` defaults
- Databases created on newer servers inherit different defaults. Modules compiled with the wrong SET options get cached with the wrong hash → duplicate plan cache entries.

### Implicit conversion changes
- The optimizer's treatment of implicit conversions (e.g., `VARCHAR` column vs `NVARCHAR` parameter) can change behavior; always use matching data types.

---

## Upgrade Checklist

### Pre-upgrade assessment

```sql
-- 1. Check current SQL Server version
SELECT @@VERSION;
SELECT SERVERPROPERTY('ProductVersion') AS Version,
       SERVERPROPERTY('ProductLevel') AS Level,
       SERVERPROPERTY('Edition') AS Edition;

-- 2. List all database compat levels
SELECT name, compatibility_level, state_desc, recovery_model_desc
FROM sys.databases
ORDER BY compatibility_level;

-- 3. Check for deprecated feature usage
SELECT
    instance_name,
    cntr_value AS use_count
FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%Deprecated Features%'
  AND cntr_value > 0
ORDER BY cntr_value DESC;

-- 4. Find old-style joins (* = syntax) — needs manual review
-- (no automated detection; use SolarWinds Plan Explorer or DMA)

-- 5. TEXT/NTEXT/IMAGE usage
SELECT SCHEMA_NAME(t.schema_id) AS [schema],
       t.name AS table_name,
       c.name AS column_name,
       ty.name AS type_name
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE ty.name IN ('text','ntext','image')
ORDER BY [schema], table_name, column_name;

-- 6. Check for linked server dependencies
SELECT name, product, provider, data_source
FROM sys.servers
WHERE is_linked = 1;

-- 7. Uncontained entities (if considering containment)
USE [MyDB];
SELECT * FROM sys.dm_db_uncontained_entities;
```

### Pre-upgrade steps

1. **Run DMA (Database Migration Assistant)** on the source database against the target version — generates a compatibility report
2. **Run `DBCC CHECKDB`** on every database before the upgrade — fix corruption first
3. **Back up all databases** including `master`, `msdb`, `model`
4. **Document all server-level objects**: logins, linked servers, sp_configure values, startup procedures, SQL Agent jobs
5. **Export all SQL Agent jobs** to scripts
6. **Note all startup trace flags** (`DBCC TRACESTATUS(-1)`)
7. **Record baseline performance**: wait stats snapshot, top 50 queries by CPU from `sys.dm_exec_query_stats`

### Post-upgrade steps (at old compat level)

1. Verify all databases are online and `DBCC CHECKDB` passes
2. Test critical workloads — at this stage, the engine is new but optimizer behavior is the old level
3. Check `sys.dm_os_ring_buffers` for errors
4. Verify SQL Agent jobs are running
5. Verify linked servers connect

### Compat level upgrade steps

1. **Enable Query Store before raising compat level** — this is critical for regression detection
   ```sql
   ALTER DATABASE [MyDB] SET QUERY_STORE = ON;
   ALTER DATABASE [MyDB] SET QUERY_STORE (
       OPERATION_MODE = READ_WRITE,
       CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 30),
       MAX_STORAGE_SIZE_MB = 1024
   );
   ```

2. **Raise compat level on a test database first**, then prod during low-traffic window
   ```sql
   ALTER DATABASE [MyDB] SET COMPATIBILITY_LEVEL = 160;
   ```

3. **Monitor for 2–4 weeks** using Query Store's "Regressed Queries" report

4. **Force old plans for regressions** using Query Store plan forcing while you fix root causes
   ```sql
   EXEC sys.sp_query_store_force_plan @query_id = 42, @plan_id = 17;
   ```

5. **If widespread regression**: roll back compat level (safe — no data change)
   ```sql
   ALTER DATABASE [MyDB] SET COMPATIBILITY_LEVEL = 150; -- previous level
   ```

---

## Compat Level Testing Strategy

### The recommended "Query Store" upgrade workflow

This is the Microsoft-recommended approach for minimizing risk when raising the compatibility level:

```
Step 1: Stay on old compat level, but upgrade the server binary
Step 2: Enable Query Store on the database
Step 3: Collect baseline: 1–2 weeks of Query Store data at old compat level
Step 4: Raise compat level during maintenance window
Step 5: Monitor Query Store "Regressed Queries" report
Step 6: Force old plan for any regressed query while root-cause fixing
Step 7: After 4+ weeks with no forced plans, compat upgrade is complete
```

### Workload categories for regression testing

| Category | What to test |
|---|---|
| OLTP hot paths | Top 10 queries by execution frequency |
| Reporting queries | Long-running analytical queries (most CE-sensitive) |
| Batch jobs | ETL procedures, Agent jobs |
| Ad hoc queries | Developer queries (harder to capture) |
| Stored procedures | Parameter sniffing sensitive procs |

### Identifying the most CE-sensitive queries

```sql
-- Queries with highest row estimate error (CE failure candidates)
SELECT TOP 20
    qs.query_id,
    qt.query_sql_text,
    rs.avg_rowcount / NULLIF(rs.last_rowcount, 0) AS estimate_vs_actual_ratio
FROM sys.query_store_query_text qt
JOIN sys.query_store_query qs ON qt.query_text_id = qs.query_text_id
JOIN sys.query_store_plan p ON qs.query_id = p.query_id
JOIN sys.query_store_runtime_stats rs ON p.plan_id = rs.plan_id
WHERE rs.last_rowcount > 0
  AND ABS(rs.avg_rowcount - rs.last_rowcount) / NULLIF(rs.last_rowcount, 0) > 0.5
ORDER BY estimate_vs_actual_ratio DESC;
```

### USE HINT for targeted CE override (zero schema change)

```sql
-- Force legacy CE for specific query without changing compat level
SELECT o.OrderID, c.CustomerName
FROM dbo.Orders o
JOIN dbo.Customers c ON o.CustomerID = c.CustomerID
WHERE o.OrderDate > '2024-01-01'
OPTION (USE HINT('FORCE_LEGACY_CARDINALITY_ESTIMATION'));

-- Or force specific compat level CE:
OPTION (USE HINT('QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_150'));
```

---

## Database Migration Assistant (DMA) and Azure Migrate

### DMA (on-premises upgrades)

**What DMA does:**
- Detects breaking changes, deprecated features, removed features
- Assesses feature parity for Azure SQL migration
- Recommends target SKU for Azure SQL (based on workload assessment)
- Generates migration report

**What DMA does NOT do:**
- Actually migrate data (use BACPAC, bcp, or Azure Database Migration Service)
- Fix performance regressions
- Test query plans at target compat level

### Azure Database Migration Service

For large migrations to Azure SQL:

```
1. Run DMA assessment → fix blockers
2. Use Azure Database Migration Service (DMS) for online migration
   - Online: minimal downtime (continuous log replay)
   - Offline: takes database offline, restores to target
3. Azure Migrate for full server assessment (includes right-sizing)
```

---

## Cross-Version Gotchas

### Restore a newer-version backup to an older server

**This is not supported.** A backup from SQL Server 2022 cannot be restored to SQL Server 2019 or earlier. The only way is to export data (BCP, BACPAC, linked server SELECT INTO).

```
SQL Server 2022 backup → SQL Server 2022 restore ✓
SQL Server 2022 backup → SQL Server 2019 restore ✗ (error)
SQL Server 2019 backup → SQL Server 2022 restore ✓ (upgrading is fine)
```

### Compat level does NOT backport features

Raising compat level unlocks optimizer behaviors and certain T-SQL syntax (e.g., `GENERATE_SERIES` requires compat 160). But it does NOT backport features to older server binaries. If you run SQL Server 2019 at compat 160, you get 2019 engine features only.

### Stats-related regression: the ascending key problem

After upgrade, if auto-update statistics fires for the first time at a higher sample rate (because the table was under-sampled at old compat), you may get a plan change. This is usually beneficial, but can cause unexpected plan changes in the first week after upgrade.

### SET options and plan cache

After upgrade, verify `sys.dm_exec_sessions` default SET options match your application's expectations. Mismatched `ARITHABORT`/`ANSI_NULLS` settings create duplicate plan cache entries.

```sql
SELECT DISTINCT
    s.program_name,
    s.set_options
FROM sys.dm_exec_sessions s
WHERE s.is_user_process = 1;
```

### CLR assembly security changes (2017+)

SQL Server 2017 introduced "CLR strict security" — all CLR assemblies must be signed or the database must have `TRUSTWORTHY ON`. This breaks existing CLR assemblies that were loaded as UNSAFE without a certificate.

```sql
-- Check for assemblies that may break
SELECT a.name, a.permission_set_desc, a.is_user_defined
FROM sys.assemblies a
WHERE a.is_user_defined = 1
  AND a.permission_set_desc IN ('EXTERNAL_ACCESS','UNSAFE');

-- Fix: sign the assembly OR enable trustworthy (not recommended):
ALTER DATABASE [MyDB] SET TRUSTWORTHY ON;

-- Better fix: sign with a certificate
-- CREATE CERTIFICATE ... FROM EXECUTABLE FILE = '...';
-- CREATE LOGIN ... FROM CERTIFICATE ...;
-- GRANT UNSAFE ASSEMBLY TO ...;
```

---

## Azure SQL Migration Considerations

### Feature parity gaps (Azure SQL Database)

| Feature | Azure SQL DB | Azure SQL MI | Notes |
|---|---|---|---|
| SQL Agent | No (use Elastic Jobs) | Yes | |
| Linked servers | No | Yes (limited) | |
| Database mail | No | Yes | |
| CLR (strict security) | No (SAFE only) | Yes | |
| Service Broker | Intra-DB only | Yes | |
| Change Data Capture | Yes | Yes | No SQL Agent on DB — background thread |
| Replication | As subscriber only | As publisher + subscriber | |
| PolyBase | No | Limited | |
| `xp_cmdshell` | No | No | |
| TDE | Auto-managed | Auto-managed | Customer-managed keys optional |
| Always Encrypted | Yes | Yes | |
| Full-Text Search | Yes | Yes | |
| In-Memory OLTP | Yes (some tiers) | Yes | |
| `BULK INSERT` from local file | No (URL only) | No (URL only) | Use ADF or `bcp` from client |
| Cross-database queries | No (same server) | Yes (same MI) | |
| Backup/RESTORE | Automated (no T-SQL BACKUP) | T-SQL BACKUP to URL | |
| `tempdb` customization | No | No | |

### Compat level on Azure SQL Database

Azure SQL Database always runs on the latest engine. The default compat level for new databases is 150 (as of mid-2024) but supports up to 160. Check Microsoft Learn for the current default as it updates.

```sql
-- Check compat level on Azure SQL
SELECT compatibility_level FROM sys.databases WHERE name = DB_NAME();
```

### Common blockers for Azure SQL migration

1. **`xp_cmdshell`** — remove all usage; replace with external orchestration (ADF, Logic Apps, Azure Functions)
2. **Linked servers** — rewrite as OPENROWSET or application-layer joins
3. **Windows auth** — Azure AD auth, SQL auth, or Managed Identity
4. **SQL Agent jobs** — migrate to Elastic Jobs (Azure SQL DB) or use native Agent (MI)
5. **CLR UNSAFE assemblies** — not allowed on Azure SQL DB
6. **Three/four-part cross-database names** — not available on Azure SQL DB (different databases = different servers)
7. **`RESTORE` / `BACKUP` to local paths** — must use URL-based backup (or none on Azure SQL DB)
8. **Service accounts needing Windows auth** — must use SQL auth or Managed Identity

---

## Metadata Queries

```sql
-- Database compat levels and options
SELECT
    name,
    compatibility_level,
    recovery_model_desc,
    state_desc,
    containment_desc,
    is_query_store_on,
    is_cdc_enabled,
    is_change_tracking_on,
    snapshot_isolation_state_desc,
    is_read_committed_snapshot_on
FROM sys.databases
ORDER BY name;

-- SQL Server version and build
SELECT
    @@SERVERNAME AS server_name,
    @@VERSION AS full_version,
    SERVERPROPERTY('ProductVersion') AS product_version,
    SERVERPROPERTY('ProductLevel') AS product_level,
    SERVERPROPERTY('ProductUpdateLevel') AS cumulative_update,
    SERVERPROPERTY('Edition') AS edition,
    SERVERPROPERTY('EngineEdition') AS engine_edition;
    -- EngineEdition: 1=Personal, 2=Standard, 3=Enterprise, 4=Express, 5=Azure SQL DB, 8=Azure SQL MI

-- Deprecated feature usage (live counter)
SELECT
    instance_name AS feature_name,
    cntr_value AS use_count
FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%Deprecated Features%'
  AND cntr_value > 0
ORDER BY cntr_value DESC;

-- TEXT/NTEXT/IMAGE columns (deprecated types)
SELECT
    SCHEMA_NAME(t.schema_id) AS [schema],
    t.name AS table_name,
    c.name AS column_name,
    ty.name AS type_name
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE ty.name IN ('text', 'ntext', 'image')
ORDER BY [schema], table_name;

-- Non-ANSI join syntax check (run from SSMS — manual code review required)
-- Check sys.sql_modules for old-style * = or = * joins:
SELECT
    OBJECT_SCHEMA_NAME(sm.object_id) AS [schema],
    OBJECT_NAME(sm.object_id) AS object_name,
    OBJECTPROPERTYEX(sm.object_id, 'BaseType') AS object_type
FROM sys.sql_modules sm
WHERE sm.definition LIKE '%*=%' OR sm.definition LIKE '%=*%';

-- Databases NOT using Query Store (upgrade risk)
SELECT name, is_query_store_on
FROM sys.databases
WHERE is_query_store_on = 0
  AND name NOT IN ('master', 'tempdb', 'model', 'msdb');

-- Current database scoped configs
SELECT name, value, value_for_secondary, is_value_default
FROM sys.database_scoped_configurations
ORDER BY name;

-- Contained database entities (what would break portability)
USE [MyDB];
SELECT entity_type, statement, feature_name, feature_type_name
FROM sys.dm_db_uncontained_entities
ORDER BY entity_type, feature_name;
```

---

## Common Patterns

### Pattern 1: Safe compat level upgrade with Query Store guardrails

```sql
-- Step 1: Enable Query Store and collect baseline
ALTER DATABASE [MyDB] SET QUERY_STORE = ON;
ALTER DATABASE [MyDB] SET QUERY_STORE (
    OPERATION_MODE = READ_WRITE,
    QUERY_CAPTURE_MODE = AUTO,
    MAX_STORAGE_SIZE_MB = 2048,
    CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 60),
    INTERVAL_LENGTH_MINUTES = 15
);

-- Step 2: Wait 1–2 weeks to collect baseline data at current compat level

-- Step 3: Raise compat level
ALTER DATABASE [MyDB] SET COMPATIBILITY_LEVEL = 160;

-- Step 4: Monitor for regressions (run weekly after upgrade)
SELECT TOP 20
    q.query_id,
    qt.query_sql_text,
    p.plan_id,
    rs.avg_duration / 1000 AS avg_ms,
    rs.execution_count,
    p.force_failure_count
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan p ON q.query_id = p.query_id
JOIN sys.query_store_runtime_stats rs ON p.plan_id = rs.plan_id
JOIN sys.query_store_runtime_stats_interval rsi
    ON rs.runtime_stats_interval_id = rsi.runtime_stats_interval_id
WHERE rsi.end_time > DATEADD(DAY, -7, GETUTCDATE())
ORDER BY rs.avg_duration DESC;

-- Step 5: Force plan for any regressed query
EXEC sys.sp_query_store_force_plan @query_id = 42, @plan_id = 17;
```

### Pattern 2: Batch compat level upgrade across multiple databases

```sql
-- Generate ALTER DATABASE statements for all user databases at old compat level
SELECT
    'ALTER DATABASE [' + name + '] SET COMPATIBILITY_LEVEL = 160;' AS upgrade_sql
FROM sys.databases
WHERE compatibility_level < 160
  AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
  AND state_desc = 'ONLINE';
```

### Pattern 3: Finding and fixing TEXT/NTEXT/IMAGE columns

```sql
-- Generate ALTER TABLE scripts to migrate TEXT → VARCHAR(MAX)
SELECT
    'ALTER TABLE [' + SCHEMA_NAME(t.schema_id) + '].[' + t.name + '] '
    + 'ALTER COLUMN [' + c.name + '] '
    + CASE ty.name
        WHEN 'text'   THEN 'VARCHAR(MAX)'
        WHEN 'ntext'  THEN 'NVARCHAR(MAX)'
        WHEN 'image'  THEN 'VARBINARY(MAX)'
      END
    + CASE WHEN c.is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END
    + ';' AS alter_sql
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE ty.name IN ('text', 'ntext', 'image')
ORDER BY SCHEMA_NAME(t.schema_id), t.name, c.name;
```

### Pattern 4: Document server config before upgrade

```sql
-- Export sp_configure values to a result set for documentation
EXEC sp_configure;

-- Server-level logins to script
SELECT
    'CREATE LOGIN [' + name + '] WITH PASSWORD = ''<reset_required>'','
    + ' DEFAULT_DATABASE = [' + default_database_name + ']'
    + ', CHECK_POLICY = ' + CASE CONVERT(INT, is_policy_checked) WHEN 1 THEN 'ON' ELSE 'OFF' END
    + ';' AS create_login_sql
FROM sys.server_principals
WHERE type_desc = 'SQL_LOGIN'
  AND is_disabled = 0
  AND name NOT LIKE '##%'
  AND name NOT IN ('sa');
```

---

## Gotchas

1. **Compat level is per-database, not per-server.** After upgrading the server binary, databases stay at their old compat level until you explicitly change it. New databases get the server's default compat level (which matches the version).

2. **You cannot restore a SQL Server 2022 backup to SQL Server 2019** — period. Plan your rollback strategy before upgrading: keep a full backup accessible, not just a VM snapshot.

3. **Raising compat level does NOT automatically update statistics or rebuild indexes.** Run `sp_updatestats` and check index fragmentation separately.

4. **CE 120 (compat 120) introduced the highest-impact regression risk.** Most post-upgrade plan regressions reported in the community are from upgrading to CE 120 (SQL 2014 compat). If skipping from 2012 to 2022, you're absorbing four CE generations at once.

5. **Query Store "regressed queries" report only shows regressions since the last plan change** — it doesn't compare to pre-upgrade. Set up a manual baseline by exporting `sys.query_store_runtime_stats` to a table before raising compat level.

6. **CLR assemblies require re-signing after upgrading if using EXTERNAL_ACCESS or UNSAFE** — SQL Server 2017+ CLR strict security breaks unsigned assemblies. Test this before upgrade.

7. **`DBCC CHECKDB` behavior changes slightly between versions.** Run CHECKDB on the old version *before* upgrade — not after — to establish a clean baseline.

8. **Linked server providers may need reinstalling** after a major version upgrade. OLE DB provider registration is machine-specific.

9. **SQL Agent job steps using `CmdExec` and PowerShell** may break if the new server has different path/environment settings. Audit all job steps before upgrade.

10. **Azure SQL Database compat level is updated by Microsoft** at regular intervals. A database running fine at compat 150 may be auto-updated to 160 by the platform. Opt-out is available per database but not guaranteed long-term.

11. **Partial containment does not protect against collation mismatches from linked servers** or cross-database queries — only temp table collation uses database collation.

12. **`@@VERSION` returns the server binary version, not the compat level.** They are independent. An old compat level on a new server means old optimizer, new engine features.

---

## See Also

- [`references/30-query-store.md`](30-query-store.md) — Query Store configuration, regressed query detection, plan forcing
- [`references/31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — IQP features by compat level
- [`references/28-statistics.md`](28-statistics.md) — Statistics update behavior after upgrade
- [`references/29-query-plans.md`](29-query-plans.md) — Execution plan reading for regression analysis
- [`references/51-2022-features.md`](51-2022-features.md) — SQL Server 2022 new features overview
- [`references/52-2025-features.md`](52-2025-features.md) — SQL Server 2025 new features overview
- [`references/54-linux-containers.md`](54-linux-containers.md) — SQL Server on Linux / container migration

---

## Sources

[^1]: [ALTER DATABASE Compatibility Level (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level) — reference for compatibility level values, supported ranges, and ALTER DATABASE syntax
[^2]: [Change the Database Compatibility Level and Use the Query Store - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/database-engine/install-windows/change-the-database-compatibility-mode-and-use-the-query-store) — Microsoft-recommended workflow for raising compatibility level safely using Query Store as a regression guardrail
[^3]: [Deprecated Database Engine Features - SQL Server 2022 | Microsoft Learn](https://learn.microsoft.com/en-us/sql/database-engine/deprecated-database-engine-features-in-sql-server-2022) — list of deprecated database engine features in SQL Server 2022 and guidance on replacements
[^4]: [Contained Databases - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/databases/contained-databases) — concepts, benefits, limitations, and configuration of partially and fully contained databases
[^5]: [Discontinued Database Engine Functionality - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/database-engine/discontinued-database-engine-functionality-in-sql-server) — features removed from the SQL Server database engine across versions including 2016, 2019, and 2022
[^6]: [Overview of Data Migration Assistant (SQL Server) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/previous-versions/sql/dma/dma-overview) — overview of DMA capabilities for assessing compatibility issues and migrating to SQL Server or Azure SQL (tool retired July 2025)
[^7]: [How to Go Live on a New Version of SQL Server (Like 2025 or 2022) - Brent Ozar Unlimited®](https://www.brentozar.com/archive/2023/04/how-to-go-live-on-sql-server-2022/) — practical guide for going live on a new SQL Server version using a Query Store baseline and phased compatibility level upgrades
[^8]: [A Little About: Old vs New Cardinality Estimators In SQL Server | Darling Data](https://erikdarling.com/a-little-about-old-vs-new-cardinality-estimators-in-sql-server/) — comparison of legacy vs. new cardinality estimators and scenarios where CE changes cause plan regressions

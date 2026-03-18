# SQL Server Configuration & Tuning Reference

A complete reference for `sp_configure`, server memory, MAXDOP, parallelism thresholds,
Resource Governor, NUMA topology, and trace flags — with opinionated guidance on safe
defaults and when to deviate.

---

## Table of Contents

1. [When to Use This Reference](#when-to-use-this-reference)
2. [sp_configure Overview](#sp_configure-overview)
3. [sp_configure Cheat Sheet](#sp_configure-cheat-sheet)
4. [Max Server Memory Calculation](#max-server-memory-calculation)
5. [MAXDOP Formula](#maxdop-formula)
6. [Cost Threshold for Parallelism](#cost-threshold-for-parallelism)
7. [Lightweight Pooling / Fiber Mode](#lightweight-pooling--fiber-mode)
8. [Locked Pages in Memory (LPIM)](#locked-pages-in-memory-lpim)
9. [Optimize for Ad Hoc Workloads](#optimize-for-ad-hoc-workloads)
10. [Backup Compression Default](#backup-compression-default)
11. [Database Mail and CLR](#database-mail-and-clr)
12. [Remote Connections and Protocols](#remote-connections-and-protocols)
13. [Resource Governor](#resource-governor)
14. [Database-Scoped Configurations](#database-scoped-configurations)
15. [NUMA Topology and Affinity](#numa-topology-and-affinity)
16. [Trace Flags Reference](#trace-flags-reference)
17. [Monitoring Configuration State](#monitoring-configuration-state)
18. [Azure SQL Considerations](#azure-sql-considerations)
19. [Common Patterns](#common-patterns)
20. [Gotchas](#gotchas)
21. [See Also](#see-also)
22. [Sources](#sources)

---

## When to Use This Reference

Load this file when:
- Sizing a new SQL Server instance (memory, MAXDOP, parallelism)
- Auditing or hardening an existing server configuration
- Troubleshooting parallel query runaway, memory pressure, or plan cache bloat
- Setting up Resource Governor workload isolation
- Researching a specific `sp_configure` option
- Enabling or disabling a feature via trace flag or database-scoped config

---

## sp_configure Overview

`sp_configure` manages server-level settings. Two categories exist:

| Category | Description | Show Advanced? |
|---|---|---|
| Basic | Safe defaults, low-risk changes | No |
| Advanced | Potentially dangerous settings | `SHOW ADVANCED OPTIONS = 1` required |

### Workflow

```sql
-- 1. Enable advanced options (required for most settings)
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;

-- 2. Change a setting
EXEC sp_configure 'max server memory (MB)', 24576;
RECONFIGURE WITH OVERRIDE;  -- OVERRIDE only needed for settings that warn

-- 3. Verify change
SELECT name, value, value_in_use, minimum, maximum, description
FROM sys.configurations
WHERE name = 'max server memory (MB)';

-- 4. Most settings take effect immediately; a few require restart
-- Check is_dynamic: 1 = immediate, 0 = requires restart
SELECT name, is_dynamic, is_advanced
FROM sys.configurations
ORDER BY name;
```

`RECONFIGURE` validates and applies settings that are `is_dynamic = 1`.
`RECONFIGURE WITH OVERRIDE` bypasses range validation — use only for settings documented to need it.

---

## sp_configure Cheat Sheet

All important options with recommended values. Options marked **Requires restart** have `is_dynamic = 0`.

### Memory

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `max server memory (MB)` | 2147483647 | See formula below | **Must set.** Default is unlimited |
| `min server memory (MB)` | 0 | 0 | Leave at 0; setting > 0 pins memory pages |
| `max worker threads` | 0 | 0 | 0 = auto-calculated; change only if advised |
| `memory model` | N/A | LPIM if high-memory server | Via Windows policy, not sp_configure |

### Parallelism

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `max degree of parallelism` | 0 | See formula below | 0 = all CPUs; almost never the right setting |
| `cost threshold for parallelism` | 5 | 40–50 | Default of 5 is far too low for modern hardware |
| `max worker threads` | 0 | 0 | See memory section |

### Query Execution

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `optimize for ad hoc workloads` | 0 | 1 | Always enable; reduces single-use plan cache bloat |
| `priority boost` | 0 | 0 | **Leave at 0.** Setting to 1 causes instability |
| `lightweight pooling` | 0 | 0 | **Leave at 0.** Fiber mode deprecated and harmful |
| `query governor cost limit` | 0 | 0 | 0 = no limit; use Resource Governor instead |
| `query wait (s)` | -1 | -1 | -1 = auto (25× CPU time); rarely needs changing |

### I/O

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `backup compression default` | 0 | 1 | Enable compression by default; override per-job |
| `backup checksum default` | 0 | 1 | **(2014+)** Catch silent corruption at backup time |

> [!NOTE] SQL Server 2014
> `backup checksum default` was added in SQL Server 2014. Enable it — it has negligible overhead and catches media corruption.

### Features

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `clr enabled` | 0 | As needed | Required for CLR objects |
| `clr strict security` | 1 | 1 | **(2017+)** Do not disable without strong reason |
| `Ole Automation Procedures` | 0 | 0 | Avoid; enables sp_OACreate COM automation |
| `xp_cmdshell` | 0 | 0 | **Security risk.** Enable only when required, with a proxy account |
| `Ad Hoc Distributed Queries` | 0 | 0 | Required for OPENROWSET/OPENDATASOURCE; enable only if needed |
| `Database Mail XPs` | 0 | 1 if using mail | Required for sp_send_dbmail |
| `show advanced options` | 0 | 0 after use | Reset to 0 when done configuring |

### Network

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `remote access` | 1 | 1 | Controls linked servers and remote queries |
| `remote query timeout (s)` | 600 | 600 | 0 = infinite; watch for hung cross-server queries |
| `remote login timeout (s)` | 10 | 10 | Seconds to wait for remote server login |
| `network packet size (B)` | 4096 | 4096 | Larger (8192+) only for bulk transfer workloads |

### Locks and Connections

| Option | Default | Recommended | Notes |
|---|---|---|---|
| `locks` | 0 | 0 | 0 = auto; fixed value causes runaway lock table |
| `open objects` | 0 | 0 | 0 = auto; leave alone |
| `max connections` | 0 | 0 | 0 = max allowed by OS; rarely needs limiting |
| `fill factor (%)` | 0 | 0 | 0 = 100% fill; per-index settings are better |

---

## Max Server Memory Calculation

SQL Server's memory manager does not properly account for OS and other process needs
when `max server memory` is left at the unlimited default. The OS will page memory
under memory pressure, causing severe performance degradation.

### Formula

```
Reserved for OS = MAX(10% of total RAM, minimum floor)
```

| Total RAM | Reserve for OS | Reserve floor |
|---|---|---|
| ≤ 4 GB | 1 GB | — |
| 4–16 GB | 1–2 GB | — |
| 16–64 GB | 2–4 GB | 4 GB |
| 64–256 GB | 4–8 GB | 8 GB |
| 256 GB+ | 8–16 GB | 16 GB |

Additionally, reserve memory for:
- **SQL Agent**: ~100–200 MB
- **SSIS**: 500 MB–2 GB depending on packages
- **Antivirus/monitoring agents**: 200–500 MB
- **Other services on the host**: whatever they need

### Practical T-SQL Calculation

```sql
-- Query current physical memory and suggest max server memory
DECLARE @TotalPhysGB DECIMAL(10,2);
SELECT @TotalPhysGB = physical_memory_kb / 1024.0 / 1024.0
FROM sys.dm_os_sys_info;

DECLARE @OsReserveGB DECIMAL(10,2) =
    CASE
        WHEN @TotalPhysGB <= 4   THEN 1.0
        WHEN @TotalPhysGB <= 16  THEN 2.0
        WHEN @TotalPhysGB <= 64  THEN 4.0
        WHEN @TotalPhysGB <= 256 THEN 8.0
        ELSE 16.0
    END;

SELECT
    @TotalPhysGB                                 AS total_ram_gb,
    @OsReserveGB                                 AS os_reserve_gb,
    @TotalPhysGB - @OsReserveGB                  AS suggested_max_server_memory_gb,
    (@TotalPhysGB - @OsReserveGB) * 1024         AS suggested_max_server_memory_mb;
```

### Apply the Setting

```sql
-- Example: 32 GB server, reserve 4 GB for OS
-- max server memory = 28 GB = 28672 MB
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;

EXEC sp_configure 'max server memory (MB)', 28672;
RECONFIGURE;
```

> [!WARNING]
> On Availability Group secondary replicas configured as readable secondaries,
> consider leaving extra memory headroom — readable secondaries maintain their
> own version store in tempdb which can balloon under heavy read workloads.

### LPIM Interaction

If Locked Pages in Memory (LPIM) is enabled (recommended for large-memory servers),
SQL Server will ignore the OS `max server memory` signal and hold all allocated memory.
Set `max server memory` correctly regardless — LPIM only changes when the OS can
forcibly reclaim pages, not whether the limit is respected.

---

## MAXDOP Formula

MAXDOP (max degree of parallelism) controls the maximum number of processor threads
used for a single parallel query execution.

**Default of 0 means "use all CPUs".** This is almost never the right setting
because a single runaway parallel query can consume all CPU, starving other queries.

### Recommended Formula

```
Per NUMA node: MAXDOP ≤ number of logical CPUs per NUMA node

Global MAXDOP:
  - ≤ 8 logical CPUs total:  MAXDOP = 0 (all CPUs)
  - 8–16 logical CPUs:       MAXDOP = 8
  - > 16 logical CPUs:       MAXDOP = logical CPUs per NUMA node (max 16)
  - Hyperthreading enabled:  Consider halving the per-node value
```

> [!NOTE] SQL Server 2019
> The Azure SQL best practice and Microsoft's own documentation now recommends:
> - OLTP workloads: MAXDOP = 4–8 as a starting point
> - OLAP/reporting: MAXDOP = half the logical CPU count (cap at 16)
> - Mixed workloads: MAXDOP = 4–8, use Resource Governor to override per workload

### Calculate MAXDOP Based on NUMA Topology

```sql
-- Determine NUMA topology and suggest MAXDOP
SELECT
    numa_node_id,
    COUNT(*) AS logical_cpus_per_node
FROM sys.dm_os_schedulers
WHERE scheduler_id < 255
  AND status = 'VISIBLE ONLINE'
GROUP BY numa_node_id
ORDER BY numa_node_id;

-- Also check current MAXDOP
SELECT name, value_in_use
FROM sys.configurations
WHERE name = 'max degree of parallelism';
```

### Apply

```sql
-- Example: 4-core server with no NUMA, set MAXDOP = 4
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;

EXEC sp_configure 'max degree of parallelism', 4;
RECONFIGURE;
```

### Per-Query and Per-Database Override

```sql
-- Override per-query
SELECT * FROM Orders WITH (INDEX = IX_OrderDate)
OPTION (MAXDOP 1);  -- force serial

-- Override at database level (SQL Server 2016+)
ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 2;
ALTER DATABASE SCOPED CONFIGURATION FOR SECONDARY SET MAXDOP = 1;

-- Override in Resource Governor (see Resource Governor section)
```

> [!NOTE] SQL Server 2016
> `ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP` was introduced in SQL Server 2016.
> Use it to tune per-database without changing global settings.

---

## Cost Threshold for Parallelism

The default value of `5` was set in the 1990s for hardware of that era. Modern CPUs
execute a "cost 5" query in microseconds. A threshold of 5 means almost every query
attempts to go parallel, which:
- Wastes parallel thread reservation overhead on trivial queries
- Increases context switching
- Causes CXPACKET/CXCONSUMER wait accumulation that looks alarming but is spurious

### Recommended Value: 40–50

A value of 40–50 is a practical starting point for modern OLTP systems. Some shops
run 25 for mixed OLTP/OLAP. Pure OLAP warehouses can go higher (75–100).

The right value is workload-specific. Use this diagnostic to find queries near the boundary:

```sql
-- Queries in cache near current threshold where parallelism might flip
SELECT TOP 50
    qs.total_worker_time / qs.execution_count  AS avg_cpu_microseconds,
    qs.total_elapsed_time / qs.execution_count AS avg_duration_microseconds,
    qs.execution_count,
    qp.query_plan,
    SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS query_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
WHERE qs.total_worker_time / qs.execution_count BETWEEN 5000 AND 100000  -- 5ms–100ms CPU
ORDER BY qs.execution_count DESC;
```

### Apply

```sql
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;

EXEC sp_configure 'cost threshold for parallelism', 50;
RECONFIGURE;
```

---

## Lightweight Pooling / Fiber Mode

```sql
-- DO NOT ENABLE
EXEC sp_configure 'lightweight pooling', 0;  -- 0 = thread mode (correct)
```

Fiber mode (lightweight pooling = 1) switches SQL Server to use Windows fibers
instead of threads. Originally intended for specific Itanium workloads that no longer
exist. Has known issues with CLR, extended stored procedures, and some features.

> [!WARNING] Deprecated
> Fiber mode is deprecated as of SQL Server 2017 and removed in SQL Server 2022.
> Enabling it on any version where it exists is not recommended. There is no modern
> workload where it helps.

---

## Locked Pages in Memory (LPIM)

LPIM allows SQL Server to lock physical pages in memory so the OS cannot page them out.
Without LPIM, memory pressure from other processes can cause SQL Server pages to be
paged to disk — catastrophic for performance.

LPIM is controlled by Windows User Rights, not `sp_configure`:
- Grant `Lock pages in memory` to the SQL Server service account
- Requires restart to take effect

### Should You Enable LPIM?

| Scenario | Recommendation |
|---|---|
| Dedicated SQL Server with ≥ 32 GB RAM | Yes, enable LPIM |
| SQL Server sharing a host with other services | Yes, but set max server memory carefully |
| Small dev/test instance | Not required |
| Azure SQL / SQL MI | Not applicable (managed by platform) |

### Verify LPIM is Active

```sql
SELECT locked_page_allocations_kb
FROM sys.dm_os_process_memory;
-- Non-zero means LPIM is active and pages are locked
```

> [!NOTE]
> LPIM without correct `max server memory` is dangerous: SQL Server will consume
> all RAM and never release it, starving the OS. Set both together.

---

## Optimize for Ad Hoc Workloads

```sql
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;

EXEC sp_configure 'optimize for ad hoc workloads', 1;
RECONFIGURE;
```

When enabled, SQL Server stores only a small stub in plan cache on first execution
of an ad-hoc batch. The full plan is stored on second execution (when it's proven
to be reused). This prevents single-use plans from filling the plan cache with
plans that will never be reused.

**Enable this on every instance, always.** There is no downside. The overhead of the
stub is negligible; the savings on busy OLTP systems with ORMs generating varied SQL
can be dramatic (plan cache from 2 GB to 200 MB is common).

```sql
-- Before enabling: check how much of plan cache is single-use
SELECT
    objtype,
    COUNT(*) AS plan_count,
    SUM(size_in_bytes) / 1024 / 1024 AS size_mb,
    SUM(CAST(usecounts AS BIGINT)) AS total_uses
FROM sys.dm_exec_cached_plans
GROUP BY objtype
ORDER BY size_mb DESC;

-- More detail: what % are used only once
SELECT
    COUNT(*) AS total_plans,
    SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END) AS single_use_plans,
    CAST(SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END) AS FLOAT)
        / COUNT(*) * 100 AS pct_single_use
FROM sys.dm_exec_cached_plans
WHERE objtype = 'Adhoc';
```

---

## Backup Compression Default

```sql
EXEC sp_configure 'backup compression default', 1;
RECONFIGURE;
```

Enables compression for all backups by default (SQL Server 2008+, Standard Edition+).
Typically reduces backup size by 50–70% for transaction-heavy OLTP data. Adds CPU
overhead during backup (~5–15% depending on data compressibility).

Individual backup jobs can still override:
```sql
BACKUP DATABASE MyDB TO DISK = '...'
WITH COMPRESSION;    -- override to force compression

BACKUP DATABASE MyDB TO DISK = '...'
WITH NO_COMPRESSION; -- override to disable compression
```

> [!NOTE] SQL Server 2014
> `backup checksum default` (also added in 2014) validates backup integrity during
> the backup operation. Enable it alongside backup compression:
> ```sql
> EXEC sp_configure 'backup checksum default', 1;
> RECONFIGURE;
> ```

---

## Database Mail and CLR

```sql
-- Enable Database Mail
EXEC sp_configure 'Database Mail XPs', 1;
RECONFIGURE;

-- Enable CLR (required for CLR objects)
EXEC sp_configure 'clr enabled', 1;
RECONFIGURE;

-- CLR strict security (2017+) - do not disable
-- Requires SAFE/EXTERNAL_ACCESS assemblies to be signed
-- Even with clr strict security = 1, use certificate signing rather than TRUSTWORTHY
EXEC sp_configure 'clr strict security', 1;
RECONFIGURE;
```

> [!NOTE] SQL Server 2017
> `clr strict security = 1` is the default in SQL Server 2017+. It requires all
> CLR assemblies (even SAFE) to be authorized by a login with UNSAFE ASSEMBLY permission,
> backed by a server certificate or asymmetric key. Do not set to 0 — use the certificate
> signing approach instead for any CLR objects you deploy.

---

## Remote Connections and Protocols

```sql
-- Ad hoc distributed queries (OPENROWSET/OPENDATASOURCE)
EXEC sp_configure 'Ad Hoc Distributed Queries', 1;
RECONFIGURE;

-- Ole Automation (sp_OACreate) - avoid
EXEC sp_configure 'Ole Automation Procedures', 0;  -- keep disabled

-- xp_cmdshell - use only with proxy account, disable when not in use
EXEC sp_configure 'xp_cmdshell', 1;
RECONFIGURE;
-- Note: always configure a proxy account for xp_cmdshell (sp_xp_cmdshell_proxy_account)
-- Otherwise it runs as the SQL Server service account
```

---

## Resource Governor

Resource Governor limits CPU and memory resources for specific workloads, preventing
runaway queries from starving other workloads.

### Architecture

```
External Pool (2016+, for R/Python external scripts)
     ↑
Internal Pool (SQL Server itself)
     ↑
[Pool 1] OLTP       [Pool 2] Reporting    [default pool]
     ↑                    ↑
[WG: web-apps]    [WG: reports]    [default workload group]
     ↑
[Classifier Function] → routes incoming sessions to workload groups
```

### Classifier Function

The classifier function is a T-SQL scalar function in the `master` database that
returns a workload group name. Called on every new connection. **Must be fast** —
it runs in every login path.

```sql
-- Step 1: Create resource pools
CREATE RESOURCE POOL OltpPool
WITH (
    MIN_CPU_PERCENT = 10,      -- guaranteed minimum CPU %
    MAX_CPU_PERCENT = 80,      -- hard cap: cannot exceed this
    MIN_MEMORY_PERCENT = 5,    -- reserved memory % (from pool budget)
    MAX_MEMORY_PERCENT = 70    -- max memory from SQL Server's budget
);

CREATE RESOURCE POOL ReportPool
WITH (
    MIN_CPU_PERCENT = 0,
    MAX_CPU_PERCENT = 40,
    MIN_MEMORY_PERCENT = 0,
    MAX_MEMORY_PERCENT = 40
);

-- Step 2: Create workload groups
CREATE WORKLOAD GROUP OltpGroup
WITH (
    IMPORTANCE = HIGH,
    MAX_DOP = 4,
    GROUP_MAX_REQUESTS = 200    -- concurrent request limit; 0 = unlimited
)
USING OltpPool;

CREATE WORKLOAD GROUP ReportGroup
WITH (
    IMPORTANCE = LOW,
    MAX_DOP = 8,
    REQUEST_MAX_CPU_TIME_SEC = 300,   -- kill query after 5 minutes CPU time
    REQUEST_MAX_MEMORY_GRANT_PERCENT = 25
)
USING ReportPool;

-- Step 3: Create classifier function
CREATE FUNCTION dbo.rg_classifier()
RETURNS sysname
WITH SCHEMABINDING
AS
BEGIN
    DECLARE @wg sysname = 'default';

    -- Route by application name
    IF APP_NAME() LIKE '%ReportServer%'
        SET @wg = 'ReportGroup';
    ELSE IF APP_NAME() IN ('MyWebApp', 'MobileAPI')
        SET @wg = 'OltpGroup';

    -- Route by login
    IF SUSER_SNAME() = 'etl_service_account'
        SET @wg = 'OltpGroup';

    RETURN @wg;
END;
GO

-- Step 4: Register classifier function
ALTER RESOURCE GOVERNOR
WITH (CLASSIFIER_FUNCTION = dbo.rg_classifier);

-- Step 5: Activate all changes
ALTER RESOURCE GOVERNOR RECONFIGURE;
```

### External Resource Pools (2016+ for R/Python)

```sql
CREATE EXTERNAL RESOURCE POOL DataSciencePool
WITH (
    MAX_CPU_PERCENT = 20,
    MAX_MEMORY_PERCENT = 20,
    MAX_PROCESSES = 4
);

ALTER EXTERNAL RESOURCE POOL [default]
WITH (MAX_CPU_PERCENT = 10);

ALTER RESOURCE GOVERNOR RECONFIGURE;
```

### Monitoring Resource Governor

```sql
-- Current pool statistics
SELECT
    pool_id, name,
    min_cpu_percent, max_cpu_percent,
    min_memory_percent, max_memory_percent,
    used_memory_kb, target_memory_kb,
    active_worker_count
FROM sys.dm_resource_governor_resource_pools;

-- Workload group statistics
SELECT
    g.name AS workload_group,
    p.name AS resource_pool,
    g.total_request_count,
    g.total_cpu_usage_ms,
    g.request_count,
    g.active_worker_count,
    g.total_queued_request_count
FROM sys.dm_resource_governor_workload_groups g
JOIN sys.dm_resource_governor_resource_pools p
    ON g.pool_id = p.pool_id;

-- Which sessions are in which workload group
SELECT
    s.session_id, s.login_name, s.program_name,
    g.name AS workload_group,
    p.name AS resource_pool,
    r.status, r.cpu_time, r.memory_usage * 8 AS memory_kb
FROM sys.dm_exec_sessions s
JOIN sys.dm_resource_governor_workload_groups g
    ON s.group_id = g.group_id
JOIN sys.dm_resource_governor_resource_pools p
    ON g.pool_id = p.pool_id
LEFT JOIN sys.dm_exec_requests r
    ON s.session_id = r.session_id
WHERE s.is_user_process = 1;
```

### Resource Governor vs MAXDOP vs Query Hints

| Mechanism | Scope | Granularity | Runtime impact |
|---|---|---|---|
| Global MAXDOP | Server | All queries | No per-query overhead |
| Database scoped MAXDOP | Database | All queries in DB | No per-query overhead |
| OPTION (MAXDOP N) | Query | Individual query | None |
| Resource Governor MAX_DOP | Workload group | Workload classification | Classifier runs at login |
| REQUEST_MAX_CPU_TIME_SEC | Workload group | Long query kill | Enforced by RG thread |

---

## Database-Scoped Configurations

Introduced in SQL Server 2016, `ALTER DATABASE SCOPED CONFIGURATION` controls
per-database behavior that previously required instance-level changes or query hints.

```sql
-- View current database-scoped settings
SELECT name, value, value_for_secondary
FROM sys.database_scoped_configurations
ORDER BY name;

-- Common configurations
ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 4;
ALTER DATABASE SCOPED CONFIGURATION FOR SECONDARY SET MAXDOP = 2;

-- Legacy cardinality estimator for one database (all other DBs use new CE)
ALTER DATABASE SCOPED CONFIGURATION SET LEGACY_CARDINALITY_ESTIMATION = ON;

-- Disable parameter sniffing for this database
ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = OFF;  -- use with caution

-- Disable Query Store hints for this database
ALTER DATABASE SCOPED CONFIGURATION SET QUERY_STORE_QUERY_HINTS = OFF;

-- Accelerated database recovery (2019+ Enterprise)
ALTER DATABASE MyDB SET ACCELERATED_DATABASE_RECOVERY = ON;

-- Batch mode on rowstore (enable or disable IQP feature)
ALTER DATABASE SCOPED CONFIGURATION SET BATCH_MODE_ON_ROWSTORE = OFF;

-- DOP feedback (2022+)
ALTER DATABASE SCOPED CONFIGURATION SET DOP_FEEDBACK = ON;

-- CE feedback (2022+)
ALTER DATABASE SCOPED CONFIGURATION SET CE_FEEDBACK = ON;
```

> [!NOTE] SQL Server 2016
> Database-scoped configurations were introduced in SQL Server 2016 (compat level 130+).
> They allow per-database tuning without affecting other databases — prefer them
> over instance-level trace flags whenever possible.

### Key Database-Scoped Settings Reference

| Setting | Default | When to change |
|---|---|---|
| `MAXDOP` | 0 (inherits global) | Per-database tuning |
| `LEGACY_CARDINALITY_ESTIMATION` | OFF | After compat upgrade regression |
| `PARAMETER_SNIFFING` | ON | **Rarely** — causes "average plan" problem |
| `QUERY_OPTIMIZER_HOTFIXES` | OFF | Enable to get QO fixes without compat change |
| `ACCELERATED_DATABASE_RECOVERY` | OFF | Enable for fast recovery/version store in user DB |
| `PAUSED_RESUMABLE_INDEX_ABORT_DURATION_MINUTES` | 1 day | For long index builds |
| `DOP_FEEDBACK` | OFF in 2022 | Enable if IQP is on and QS is READ_WRITE |
| `CE_FEEDBACK` | OFF in 2022 | Enable if IQP is on and QS is READ_WRITE |

---

## NUMA Topology and Affinity

Modern servers have multiple NUMA (Non-Uniform Memory Access) nodes. Optimal SQL
Server configuration respects NUMA boundaries.

### Key Principles

1. **SQL Server auto-detects NUMA** and creates scheduler sets per node
2. Memory allocations prefer local NUMA node (lower latency)
3. Soft NUMA (2016+) can partition logical CPUs into smaller nodes to reduce hot-spot
   contention on high-CPU-count servers

### View NUMA Topology

```sql
-- NUMA nodes
SELECT node_id, node_state_desc, memory_node_id,
       processor_group, cpu_count
FROM sys.dm_os_nodes
WHERE node_state_desc != 'ONLINE DAC';

-- Schedulers per node
SELECT scheduler_id, cpu_id, status, is_online, parent_node_id
FROM sys.dm_os_schedulers
WHERE scheduler_id < 255
ORDER BY parent_node_id, scheduler_id;

-- Memory per NUMA node
SELECT memory_node_id,
       virtual_address_space_reserved_kb / 1024 AS reserved_mb,
       virtual_address_space_committed_kb / 1024 AS committed_mb,
       locked_page_allocations_kb / 1024 AS locked_mb
FROM sys.dm_os_memory_nodes
WHERE memory_node_id < 64;  -- exclude internal nodes
```

### Soft NUMA (2016+)

```sql
-- Soft NUMA auto-configuration (2016+, ON by default for servers > 8 cores)
-- Check current state
SELECT name, value_in_use
FROM sys.configurations
WHERE name = 'automatic soft-NUMA disabled';
-- 0 = auto soft-NUMA enabled (recommended)
-- 1 = disabled

-- Set MAXDOP = logical CPUs per soft-NUMA node for best parallelism control
```

### CPU Affinity

CPU/IO affinity masks are rarely needed. Windows scheduler handles CPU allocation
efficiently for most workloads. Only configure affinity when:
- Running multiple SQL Server instances on one host (split CPUs between instances)
- Isolating specific CPUs for OS use on very large servers

```sql
-- Affinity mask is bitmask of CPUs SQL Server can use
-- Use SQL Server Configuration Manager (GUI) for large CPU counts
-- Only T-SQL for <= 64 CPUs:
EXEC sp_configure 'affinity mask', 255;  -- CPUs 0-7 only (binary 11111111)
RECONFIGURE;
```

---

## Trace Flags Reference

Trace flags modify SQL Server behavior, typically for diagnostics or enabling/disabling
specific features. They should be documented when applied and reviewed at each upgrade.

> [!NOTE]
> Many trace flags that were required in older versions are now default behavior
> in SQL Server 2016+ or are superseded by database-scoped configurations.
> Always verify whether a trace flag still applies to your version.

### Startup Trace Flags

Apply startup flags via SQL Server Configuration Manager → SQL Server Service →
Startup Parameters, or via SQLSERVR.EXE -T flag.

```sql
-- View active trace flags
DBCC TRACESTATUS(-1);  -- all globally active flags

-- Enable trace flag globally (session)
DBCC TRACEON(4199, -1);   -- -1 means global scope

-- Disable trace flag globally
DBCC TRACEOFF(4199, -1);
```

### Important Trace Flags

| Flag | Effect | Version Notes |
|---|---|---|
| **1117** | Grow all files in filegroup uniformly when one hits autogrowth | Default in 2016+ for tempdb; no longer needed for tempdb on 2016+ |
| **1118** | Force uniform extent allocations (reduces SGAM/GAM contention) | Default in 2016+; no longer needed |
| **1204** | Deadlock participants (less detail than 1222) | Use XE `xml_deadlock_report` instead |
| **1222** | Deadlock details in XML format in error log | Prefer XE system_health or XE deadlock session |
| **2371** | Dynamic statistics threshold (SQRT formula) on SQL Server 2012–2014 | Default in 2016+ at compat 130; not needed on 2016+ |
| **3226** | Suppress "BACKUP DATABASE successfully processed" messages in error log | Useful for log backup noise; safe to enable |
| **4136** | Disable parameter sniffing; every query plan uses "average" row estimate | Alternative to OPTIMIZE FOR UNKNOWN; use with extreme caution |
| **4199** | Enable all QO fixes from CUs/SPs that are gated behind the flag | Consider `QUERY_OPTIMIZER_HOTFIXES` database-scoped setting instead |
| **7412** | Enable lightweight query profiling infrastructure | Default ON in 2019+; not needed |
| **8048** | Force NUMA CPU-level partitioning of memory objects (NUMA hot-spot fix) | Only for 16+ core NUMA servers on older versions; rarely needed |
| **9481** | Force legacy CE (70) regardless of compat level | Prefer `LEGACY_CARDINALITY_ESTIMATION` database-scoped setting |
| **9488** | Reverts specific CE 2014 change (multi-statement TVF estimates) | Very specific; only if this exact regression is confirmed |
| **9567** | Enable parallel plan for AG seeding | 2016+ only; improves initial AG sync speed |
| **10316** | Create additional indexes on internal temporal history staging table | Only if temporal table queries are slow on history table joins |
| **11023** | Use last known good plan (experimental) | SQL Server 2022+; use Query Store forced plans instead |

### Safe Default Trace Flags

For most production instances, the only trace flag worth enabling at startup is:
- **3226** — suppress successful backup messages (noise reduction)

Everything else should be handled via database-scoped configuration or resolved
at root cause rather than suppressed with a flag.

---

## Monitoring Configuration State

### Full Configuration Audit

```sql
-- All non-default configurations
SELECT
    name,
    value,
    value_in_use,
    minimum,
    maximum,
    description,
    is_dynamic,
    is_advanced
FROM sys.configurations
WHERE value != value_in_use  -- pending restart required
   OR (value != 0 AND name IN (
       'optimize for ad hoc workloads',
       'backup compression default',
       'backup checksum default',
       'max server memory (MB)',
       'max degree of parallelism',
       'cost threshold for parallelism'
   ))
ORDER BY name;
```

### Pending Restart Configuration

```sql
-- Settings changed but not yet in use (requires restart)
SELECT name, value AS configured_value, value_in_use AS current_value
FROM sys.configurations
WHERE value <> value_in_use
ORDER BY name;
```

### Resource Governor Classifier

```sql
-- Current RG classifier function
SELECT classifier_function_id, is_enabled
FROM sys.resource_governor_configuration;

-- Full RG topology
SELECT
    p.name AS pool,
    g.name AS workload_group,
    g.importance,
    g.max_dop,
    g.request_max_cpu_time_sec,
    g.request_max_memory_grant_percent,
    p.min_cpu_percent, p.max_cpu_percent,
    p.min_memory_percent, p.max_memory_percent
FROM sys.resource_governor_workload_groups g
JOIN sys.resource_governor_resource_pools p
    ON g.pool_id = p.pool_id
ORDER BY p.name, g.name;
```

### Memory State

```sql
-- Memory grant pending (queries waiting for memory)
SELECT * FROM sys.dm_exec_query_resource_semaphores;

-- Buffer pool usage by database
SELECT
    DB_NAME(database_id) AS db_name,
    COUNT(*) * 8 / 1024 AS buffer_pool_mb,
    COUNT(*) AS page_count
FROM sys.dm_os_buffer_descriptors
WHERE database_id > 4
GROUP BY database_id
ORDER BY page_count DESC;

-- Current memory clerks (top consumers)
SELECT TOP 20
    type,
    name,
    memory_node_id,
    pages_kb / 1024 AS mb_allocated
FROM sys.dm_os_memory_clerks
ORDER BY pages_kb DESC;

-- LPIM and page fault rates
SELECT
    physical_memory_in_use_kb / 1024 AS phys_mem_in_use_mb,
    locked_page_allocations_kb / 1024 AS lpim_locked_mb,
    page_fault_count
FROM sys.dm_os_process_memory;
```

---

## Azure SQL Considerations

| Setting | Azure SQL Database | Azure SQL Managed Instance |
|---|---|---|
| `max server memory` | Managed by platform | Managed by platform |
| `max degree of parallelism` | Available via db-scoped config | Available globally and via db-scoped |
| `cost threshold for parallelism` | Not exposed | Exposed via sp_configure |
| Resource Governor | Not available | Available |
| Trace flags | Limited set via DBCC TRACEON | Broader support |
| LPIM | Not applicable | Not applicable |
| Soft NUMA | Not applicable | Managed by platform |
| `optimize for ad hoc workloads` | Always on | Available |
| `backup compression default` | Managed backups, no manual backup | Available |

For Azure SQL Database, use `ALTER DATABASE SCOPED CONFIGURATION` for per-database
tuning — it is the primary configuration surface available.

---

## Common Patterns

### Initial Server Configuration Checklist

```sql
-- Recommended initial configuration for a new SQL Server instance
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;

-- 1. Memory: adjust MB value based on RAM calculation above
EXEC sp_configure 'max server memory (MB)', 28672;  -- example: 28 GB on 32 GB server

-- 2. MAXDOP: adjust based on CPU topology
EXEC sp_configure 'max degree of parallelism', 8;   -- example: 8-core server

-- 3. Parallelism threshold
EXEC sp_configure 'cost threshold for parallelism', 50;

-- 4. Plan cache efficiency
EXEC sp_configure 'optimize for ad hoc workloads', 1;

-- 5. Backup quality
EXEC sp_configure 'backup compression default', 1;
EXEC sp_configure 'backup checksum default', 1;

-- 6. Reduce error log noise
DBCC TRACEON(3226, -1);

RECONFIGURE;
EXEC sp_configure 'show advanced options', 0;
RECONFIGURE;
```

### Resource Governor for Reporting Isolation

```sql
-- Prevent report queries from taking > 50% CPU
CREATE RESOURCE POOL ReportPool
WITH (MAX_CPU_PERCENT = 50, MAX_MEMORY_PERCENT = 40);

CREATE WORKLOAD GROUP ReportGroup
WITH (
    IMPORTANCE = LOW,
    MAX_DOP = 4,
    REQUEST_MAX_CPU_TIME_SEC = 120  -- kill any report query running > 2 min CPU
)
USING ReportPool;

CREATE FUNCTION dbo.rg_classifier()
RETURNS sysname WITH SCHEMABINDING
AS
BEGIN
    IF APP_NAME() LIKE '%SSRS%' OR APP_NAME() LIKE '%ReportServer%'
        RETURN 'ReportGroup';
    RETURN 'default';
END;
GO

ALTER RESOURCE GOVERNOR WITH (CLASSIFIER_FUNCTION = dbo.rg_classifier);
ALTER RESOURCE GOVERNOR RECONFIGURE;
```

### Configuration Drift Detection

```sql
-- Compare running config against expected values
DECLARE @expected TABLE (name sysname, expected_value sql_variant);
INSERT @expected VALUES
    ('max server memory (MB)', 28672),
    ('max degree of parallelism', 8),
    ('cost threshold for parallelism', 50),
    ('optimize for ad hoc workloads', 1),
    ('backup compression default', 1);

SELECT
    e.name,
    e.expected_value,
    c.value_in_use AS current_value,
    CASE WHEN e.expected_value = c.value_in_use THEN 'OK' ELSE 'DRIFT' END AS status
FROM @expected e
JOIN sys.configurations c ON c.name = e.name;
```

---

## Gotchas

1. **Never set `max server memory` to unlimited on a shared host.** The OS will page
   SQL Server memory, making the server perform as if running on disk.

2. **`priority boost = 1` is a trap.** Setting SQL Server to high priority starves the
   OS's own threads (network stack, disk I/O). It was removed from Books Online
   recommendations in SQL Server 2005 and causes instability — never enable it.

3. **`RECONFIGURE WITH OVERRIDE` is not a magic incantation.** It bypasses range
   validation but does not bypass logical errors. Use it only for the handful of settings
   documented to require it (e.g., `fill factor = 0`).

4. **Changing MAXDOP does not re-plan cached plans.** Existing cached plans were
   compiled with the old MAXDOP. Run `DBCC FREEPROCCACHE` (with caution) or wait
   for natural plan expiry.

5. **`cost threshold for parallelism` affects plan cache invalidation.** Raising it
   from 5 to 50 means previously-parallel cached plans won't change until they're
   recompiled. Flush cache after changing this setting.

6. **Resource Governor classifier function must always return a valid workload group.**
   If it returns NULL or a non-existent group name, the session goes to the default
   workload group. Test the classifier before enabling Resource Governor.

7. **Resource Governor changes require `ALTER RESOURCE GOVERNOR RECONFIGURE`.**
   `CREATE/ALTER RESOURCE POOL` changes are staged; `RECONFIGURE` makes them live.
   Sessions already connected keep their old classification — only new connections
   are affected.

8. **Trace flags survive restarts only if added to startup parameters.** `DBCC TRACEON`
   sets the flag for the current instance lifetime but is lost on restart unless
   added to the startup parameters in Configuration Manager.

9. **`sp_configure` changes are binary — no per-database override for some settings.**
   Settings like `xp_cmdshell` and `clr enabled` are instance-wide. Plan your feature
   toggles accordingly.

10. **Database-scoped `PARAMETER_SNIFFING = OFF` is dangerous.** It forces the optimizer
    to use average cardinality estimates for all parameterized queries — the "average
    plan problem". Use Query Store forced plans or OPTIMIZE FOR UNKNOWN hints for
    specific sniffing victims instead.

11. **`max worker threads = 0` auto-calculates, but the formula can be insufficient
    on systems with thousands of concurrent connections.** If you see high `THREADPOOL`
    waits, increasing this value (e.g., to 2000–4000) may help — but investigate the
    root cause (connection pooling issues, long-running queries) first.

12. **`min server memory` > 0 prevents SQL Server from releasing memory to the OS.**
    This is almost never the right setting. Leave it at 0.

---

## See Also

- [`references/32-performance-diagnostics.md`](32-performance-diagnostics.md) — wait stats, sp_Blitz, query hints
- [`references/31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — IQP features and database-scoped configs
- [`references/34-tempdb.md`](34-tempdb.md) — tempdb sizing, memory-optimized metadata
- [`references/30-query-store.md`](30-query-store.md) — plan forcing, DOP/CE feedback
- [`references/48-database-mail.md`](48-database-mail.md) — Database Mail XPs config
- [`references/43-high-availability.md`](43-high-availability.md) — AG readable secondary memory considerations

---

## Sources

[^1]: [Server Configuration Options - SQL Server, Azure SQL Managed Instance](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/server-configuration-options-sql-server) — complete reference for all sp_configure options, default values, and restart requirements
[^2]: [Resource Governor - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/resource-governor/resource-governor) — overview of Resource Governor architecture, resource pools, workload groups, and classifier functions
[^3]: [ALTER DATABASE SCOPED CONFIGURATION (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-scoped-configuration-transact-sql) — syntax and options for per-database configuration settings introduced in SQL Server 2016
[^4]: [Trace Flags (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-traceon-trace-flags-transact-sql) — reference for all documented trace flags, their effects, and applicable SQL Server versions
[^5]: [sp_Blitz® – Free SQL Server Health Check Script](https://www.brentozar.com/blitz/) — Brent Ozar sp_Blitz checks on priority boost, MAXDOP, and max server memory best practices
[^6]: [Enable the Lock Pages in Memory Option (Windows) - SQL Server](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/enable-the-lock-pages-in-memory-option-windows) — steps to grant the Lock Pages in Memory Windows privilege to the SQL Server service account
[^7]: [Soft-NUMA (SQL Server) - SQL Server](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/soft-numa-sql-server) — explains automatic and manual soft-NUMA configuration and NUMA topology in SQL Server
[^8]: [Five SQL Server Settings to Change](https://www.brentozar.com/archive/2013/09/five-sql-server-settings-to-change/) — Brent Ozar discussion on cost threshold for parallelism and other important server settings to tune

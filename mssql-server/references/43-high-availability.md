# 43 — High Availability: Always On AG, Log Shipping, FCI

## Table of Contents

1. [When to Use](#when-to-use)
2. [HA Technology Comparison](#ha-technology-comparison)
3. [Always On Availability Groups — Architecture](#always-on-availability-groups--architecture)
4. [AG Quorum and WSFC](#ag-quorum-and-wsfc)
5. [Creating an AG (T-SQL)](#creating-an-ag-t-sql)
6. [AG Listener](#ag-listener)
7. [Readable Secondary Routing](#readable-secondary-routing)
8. [Synchronous vs Asynchronous Replicas](#synchronous-vs-asynchronous-replicas)
9. [Automatic vs Manual Failover](#automatic-vs-manual-failover)
10. [Distributed Availability Groups (2016+)](#distributed-availability-groups-2016)
11. [Contained Availability Groups (2022+)](#contained-availability-groups-2022)
12. [AG and TempDB](#ag-and-tempdb)
13. [AG and Non-Replicated Objects](#ag-and-non-replicated-objects)
14. [Log Shipping](#log-shipping)
15. [Failover Cluster Instances (FCI)](#failover-cluster-instances-fci)
16. [FCI vs AG Comparison](#fci-vs-ag-comparison)
17. [AG Monitoring and DMVs](#ag-monitoring-and-dmvs)
18. [Common Failure Patterns](#common-failure-patterns)
19. [Always On on Linux (2017+)](#always-on-on-linux-2017)
20. [Azure SQL Managed Instance AG](#azure-sql-managed-instance-ag)
21. [Gotchas](#gotchas)
22. [See Also](#see-also)
23. [Sources](#sources)

---

## When to Use

| Goal | Recommended Technology |
|---|---|
| Zero-data-loss automatic failover, same datacenter | Synchronous AG (2+ replicas) |
| Disaster recovery across datacenters | Async AG replica or distributed AG |
| Read scale-out (reports, analytics) | Readable secondary replica |
| Shared-storage cluster (instance-level HA) | FCI |
| Simple DR with delayed restore option | Log shipping |
| Cross-region AG without WSFC | Basic AG (Standard Edition) or Distributed AG |
| Self-contained AG (no logins migration issue) | Contained AG (2022+) |

**Key rule:** AG protects databases; FCI protects the instance. They are complementary and often combined (FCI nodes as AG replicas).

---

## HA Technology Comparison

| Feature | Always On AG | FCI | Log Shipping | Database Mirroring |
|---|---|---|---|---|
| Scope | Database | Instance | Database | Database |
| Shared storage required | No | Yes | No | No |
| Automatic failover | Yes (sync) | Yes | No | Yes (principal+witness) |
| Readable standby | Yes | No | Read-only (STANDBY) | No (unless snapshot) |
| Multiple secondaries | Yes (up to 8) | No (one active) | Yes | No (one mirror) |
| Licensing | Enterprise/Standard | Enterprise/Standard | All editions | Deprecated |
| Log truncation | All replicas must receive | N/A | After backup | After ack |
| Upgrade path | Rolling | Requires downtime | N/A | N/A |

> [!WARNING] Deprecated
> Database Mirroring was deprecated in SQL Server 2012 and removed in SQL Server 2022 (Enterprise), though it may still exist in Standard. Use Always On AG instead.

---

## Always On Availability Groups — Architecture

```
┌───────────────────────────────────────────────┐
│  Windows Server Failover Cluster (WSFC)       │
│  ┌─────────────────┐   ┌─────────────────┐   │
│  │  Primary Replica │   │ Secondary Replica│   │
│  │  Node1\SQL01    │   │  Node2\SQL01    │   │
│  │  [READ/WRITE]   │   │  [READ-ONLY]    │   │
│  └────────┬────────┘   └────────▲────────┘   │
│           │  Redo log stream    │             │
│           └─────────────────────┘             │
│                                               │
│  AG Listener: AGListener (Virtual IP)         │
└───────────────────────────────────────────────┘
```

**Core concepts:**
- **Availability Group** — named container for one or more databases, replicated as a unit
- **Primary replica** — the read-write instance; receives all DML
- **Secondary replica** — receives and applies redo log; can be readable (Enterprise) or not
- **Availability replica** — a SQL Server instance participating in the AG
- **AG listener** — virtual network name (VNN) + IP that clients connect to; routes to primary or readable secondary
- **Endpoint** — database mirroring endpoint used for AG log transport (`CREATE ENDPOINT ... FOR DATABASE_MIRRORING`)
- **HADR log capture thread** — on primary: reads log and sends to secondary
- **HADR redo thread** — on secondary: applies log records

---

## AG Quorum and WSFC

Always On AGs require a Windows Server Failover Cluster for automatic failover on Windows. The cluster uses a quorum model to prevent split-brain.

**Quorum modes:**

| Mode | Votes | Description |
|---|---|---|
| Node Majority | Each node = 1 vote | Works with odd number of nodes |
| Node and Disk Majority | Nodes + disk witness | Disk witness = 1 vote (shared storage) |
| Node and File Share Majority | Nodes + file share witness | Preferred for even-node clusters; witness can be in Azure |
| No Majority (Disk Only) | Disk = all votes | Legacy; avoid |

**Best practice for 2-node clusters:** Use Node and File Share Majority (Azure file share witness or on-prem SMB share). Without a witness a 2-node cluster loses quorum when either node fails.

```sql
-- Check cluster quorum state from SQL
SELECT cluster_name, quorum_type_desc, quorum_state_desc
FROM sys.dm_hadr_cluster;
```

> [!NOTE] SQL Server 2022
> Contained Availability Groups include their own AAG metadata in the AG itself, reducing WSFC dependency for SQL Server objects (logins, agent jobs, etc.).

---

## Creating an AG (T-SQL)

### Step 1 — Enable AG on each instance

```sql
-- Run on each replica node (requires restart)
-- Or use SQL Server Configuration Manager → SQL Server service → AlwaysOn tab
EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
-- Enable via: SQL Server Configuration Manager > SQL Server Services > Properties > Always On tab
```

### Step 2 — Create mirroring endpoint on each replica

```sql
-- Run on PRIMARY and each SECONDARY
CREATE ENDPOINT [Hadr_endpoint]
    STATE = STARTED
    AS TCP (LISTENER_PORT = 5022, LISTENER_IP = ALL)
    FOR DATABASE_MIRRORING (
        ROLE = ALL,
        AUTHENTICATION = WINDOWS NEGOTIATE,
        ENCRYPTION = REQUIRED ALGORITHM AES
    );
GO

-- Grant connect to the SQL Server service account (domain account or certificate)
GRANT CONNECT ON ENDPOINT::[Hadr_endpoint] TO [DOMAIN\SQLServiceAccount];
```

### Step 3 — Back up and restore databases (no recovery) on secondary

```sql
-- On PRIMARY
BACKUP DATABASE [SalesDB] TO DISK = '\\FileShare\SalesDB.bak' WITH INIT;
BACKUP LOG [SalesDB] TO DISK = '\\FileShare\SalesDB_log.bak' WITH INIT;

-- On SECONDARY
RESTORE DATABASE [SalesDB] FROM DISK = '\\FileShare\SalesDB.bak'
    WITH NORECOVERY, MOVE 'SalesDB' TO 'D:\Data\SalesDB.mdf',
         MOVE 'SalesDB_log' TO 'L:\Log\SalesDB_ldf.ldf';
RESTORE LOG [SalesDB] FROM DISK = '\\FileShare\SalesDB_log.bak'
    WITH NORECOVERY;
```

### Step 4 — Create the Availability Group (on primary)

```sql
CREATE AVAILABILITY GROUP [AG_Sales]
    WITH (
        AUTOMATED_BACKUP_PREFERENCE = SECONDARY,
        DB_FAILOVER = ON,           -- failover if any DB goes offline
        DTC_SUPPORT = NONE,         -- change to PER_DB if you need DTC
        CLUSTER_TYPE = WSFC         -- NONE for read-scale, EXTERNAL for Linux Pacemaker
    )
    FOR DATABASE [SalesDB], [OrdersDB]
    REPLICA ON
        N'Node1\SQL01' WITH (
            ENDPOINT_URL = N'TCP://node1.domain.com:5022',
            AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
            FAILOVER_MODE = AUTOMATIC,
            SEEDING_MODE = MANUAL,       -- or AUTOMATIC (2016+)
            SECONDARY_ROLE (ALLOW_CONNECTIONS = READ_ONLY, READ_ONLY_ROUTING_URL = N'TCP://node1.domain.com:1433')
        ),
        N'Node2\SQL01' WITH (
            ENDPOINT_URL = N'TCP://node2.domain.com:5022',
            AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
            FAILOVER_MODE = AUTOMATIC,
            SEEDING_MODE = MANUAL,
            SECONDARY_ROLE (ALLOW_CONNECTIONS = READ_ONLY, READ_ONLY_ROUTING_URL = N'TCP://node2.domain.com:1433')
        );
```

### Step 5 — Join secondary to AG (on each secondary)

```sql
-- On SECONDARY
ALTER AVAILABILITY GROUP [AG_Sales] JOIN;

-- If manual seeding (Step 3 above), also:
ALTER DATABASE [SalesDB] SET HADR AVAILABILITY GROUP = [AG_Sales];
ALTER DATABASE [OrdersDB] SET HADR AVAILABILITY GROUP = [AG_Sales];
```

### Step 6 — Create listener

```sql
-- On PRIMARY
ALTER AVAILABILITY GROUP [AG_Sales]
ADD LISTENER N'AGListener' (
    WITH IP ((N'10.0.0.100', N'255.255.255.0')),
    PORT = 1433
);
```

---

## AG Listener

The listener is a virtual network name (VNN) that clients use regardless of which node is primary. After failover, DNS or the WSFC redirects connections to the new primary.

**Connection string pattern:**

```
Server=AGListener,1433;Database=SalesDB;
MultiSubnetFailover=True;    -- REQUIRED for fast failover detection
ApplicationIntent=ReadOnly;  -- Route to readable secondary
```

> [!WARNING]
> Always include `MultiSubnetFailover=True` in connection strings to listeners. Without it, TCP connection timeout detection (typically 15–21 seconds) applies before the driver tries the next IP, causing unnecessary failover delay.

**Listener metadata:**

```sql
SELECT ag.name AS ag_name,
       listener_id, dns_name, port, ip_configuration_string_from_cluster
FROM sys.availability_group_listeners agl
JOIN sys.availability_groups ag ON ag.group_id = agl.group_id;
```

---

## Readable Secondary Routing

Read-only routing lets the AG listener redirect `ApplicationIntent=ReadOnly` connections to a readable secondary.

### Configure read-only routing (on primary)

```sql
-- Set routing URL on each replica (run on PRIMARY)
ALTER AVAILABILITY GROUP [AG_Sales]
MODIFY REPLICA ON N'Node1\SQL01' WITH (
    PRIMARY_ROLE (READ_ONLY_ROUTING_LIST = ('Node2\SQL01', 'Node1\SQL01'))
);
ALTER AVAILABILITY GROUP [AG_Sales]
MODIFY REPLICA ON N'Node2\SQL01' WITH (
    PRIMARY_ROLE (READ_ONLY_ROUTING_LIST = ('Node1\SQL01', 'Node2\SQL01'))
);
```

The list is ordered (first available secondary is chosen). Use a nested list for load balancing:

```sql
-- SQL Server 2016+: balanced routing
READ_ONLY_ROUTING_LIST = (('Node2\SQL01', 'Node3\SQL01'), 'Node1\SQL01')
-- Node2 and Node3 are tried round-robin; Node1 is fallback
```

### Verify routing is working

```sql
-- On readable secondary, confirm ApplicationIntent
SELECT session_id, client_interface_name, program_name, host_name,
       is_read_committed_snapshot_on    -- should be 1 for readable workloads
FROM sys.dm_exec_sessions
WHERE session_id = @@SPID;
```

> [!WARNING]
> Readable secondaries require `READ_COMMITTED_SNAPSHOT` or `ALLOW_SNAPSHOT_ISOLATION` — without one of these, readers block redo thread. Verify `is_read_committed_snapshot_on = 1` on secondary databases.

---

## Synchronous vs Asynchronous Replicas

| | Synchronous | Asynchronous |
|---|---|---|
| Data loss on failover | Zero (guaranteed) | Potential (async lag) |
| Commit impact | Primary waits for secondary ack | Primary does not wait |
| Automatic failover | Supported | Not supported (manual only) |
| Network tolerance | Sensitive (high RTT hurts throughput) | Tolerant of high latency |
| Use case | Same datacenter, zero RPO required | DR site, cross-region |
| Max synchronous replicas | 3 synchronous (Enterprise) | Up to 8 total replicas |

**Mixed mode:** Typical production setup is 2 synchronous replicas in primary DC (auto-failover) + 1–2 async replicas in DR DC.

```sql
-- Add async DR replica
ALTER AVAILABILITY GROUP [AG_Sales] ADD REPLICA ON N'DRNode\SQL01' WITH (
    ENDPOINT_URL = N'TCP://drnode.domain.com:5022',
    AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
    FAILOVER_MODE = MANUAL,
    SEEDING_MODE = AUTOMATIC
);
```

---

## Automatic vs Manual Failover

**Conditions for automatic failover (all must be true):**
1. Replica is configured `FAILOVER_MODE = AUTOMATIC`
2. Replica is in synchronous-commit mode and synchronized
3. WSFC quorum exists
4. Health detection: `DB_FAILOVER = ON` (any DB offline triggers) or default (SQL Server service failure only)
5. No user-initiated action is blocking

**Perform manual failover:**

```sql
-- Planned failover (no data loss, replica must be synchronized)
-- Run ON THE TARGET SECONDARY you want to become primary
ALTER AVAILABILITY GROUP [AG_Sales] FAILOVER;

-- Forced failover with potential data loss (DR scenario)
-- Run on the target secondary
ALTER AVAILABILITY GROUP [AG_Sales] FORCE_FAILOVER_ALLOW_DATA_LOSS;
```

> [!WARNING]
> `FORCE_FAILOVER_ALLOW_DATA_LOSS` can result in data loss for async replicas. After a forced failover, the old primary becomes a secondary and may need manual intervention (RESUME DATA MOVEMENT). Always take a log backup on the old primary first if accessible.

**Health policy configuration:**

```sql
ALTER AVAILABILITY GROUP [AG_Sales] SET (
    HEALTH_CHECK_TIMEOUT = 30000,           -- ms before failover starts
    FAILURE_CONDITION_LEVEL = 3             -- 1=server down, 2=no sys proc, 3=orphaned locks, 4=spinlock, 5=heap
);
```

---

## Distributed Availability Groups (2016+)

A Distributed AG spans two independent AGs, each with its own WSFC (or no cluster). Useful for multi-datacenter configurations without a stretched cluster.

```
AG1 (primary cluster)          AG2 (DR cluster)
  Primary ──── Secondary         Primary ──── Secondary
       │                             ▲
       └─────────────────────────────┘
         Distributed AG (async log)
```

```sql
-- On AG1 PRIMARY: create the distributed AG
CREATE AVAILABILITY GROUP [DAG_Sales]
    WITH (DISTRIBUTED)
    AVAILABILITY GROUP ON
        'AG_Sales' WITH (
            LISTENER_URL = N'TCP://AGListener.domain.com:5022',
            AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
            FAILOVER_MODE = MANUAL,
            SEEDING_MODE = AUTOMATIC
        ),
        'AG_Sales_DR' WITH (
            LISTENER_URL = N'TCP://DRListener.domain.com:5022',
            AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
            FAILOVER_MODE = MANUAL,
            SEEDING_MODE = AUTOMATIC
        );

-- On AG2 PRIMARY: join the distributed AG
ALTER AVAILABILITY GROUP [DAG_Sales] JOIN
    AVAILABILITY GROUP ON
        'AG_Sales' WITH (
            LISTENER_URL = N'TCP://AGListener.domain.com:5022',
            AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
            FAILOVER_MODE = MANUAL,
            SEEDING_MODE = AUTOMATIC
        ),
        'AG_Sales_DR' WITH (
            LISTENER_URL = N'TCP://DRListener.domain.com:5022',
            AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
            FAILOVER_MODE = MANUAL,
            SEEDING_MODE = AUTOMATIC
        );
```

**Distributed AG gotchas:**
- Transport is between AG listeners, not directly between replicas
- Both AGs must exist before creating the distributed AG
- Failover requires promoting AG2 to global primary (two-step process)
- No listener-level read routing across the distributed AG — clients must connect directly to AG2 listener after failover

---

## Contained Availability Groups (2022+)

> [!NOTE] SQL Server 2022
> Contained AGs store SQL Server logins, SQL Agent jobs, and linked servers inside the AG itself (replicated to all replicas), eliminating the need to manually sync these objects after failover.

```sql
-- Create a contained AG
CREATE AVAILABILITY GROUP [AG_Contained]
    WITH (
        CLUSTER_TYPE = WSFC,
        CONTAINED,          -- enable contained AG
        REUSE_SYSTEM_DATABASES = YES   -- reuse if already exist on secondary
    )
    FOR DATABASE [AppDB]
    REPLICA ON
        N'Node1\SQL01' WITH (...),
        N'Node2\SQL01' WITH (...);
```

**What is contained:**
- SQL Server logins and passwords
- SQL Server Agent jobs
- Linked server definitions

**What is NOT contained:**
- Windows logins (managed by AD)
- Server-level configuration (sp_configure settings)
- Certificates not associated with AG keys
- Trace flags

**Contained AG system databases:** Each contained AG has its own `master` and `msdb` within the AG. These are replicated and fail over with the AG.

---

## AG and TempDB

TempDB is **not replicated** in an AG. Each replica has its own TempDB. Important implications:

- After failover, all TempDB objects (temp tables, table variables, global temp tables) are lost — applications must handle reconnection and re-creation
- Readable secondaries need their own TempDB sized appropriately for the read workload (version store for RCSI on readable secondary databases)
- Global temp objects (`##GlobalTemp`) are not visible across replicas
- If secondary readable workloads generate significant version store (RCSI for read consistency), size TempDB accordingly on every replica

```sql
-- Check version store size on secondary
SELECT SUM(version_store_reserved_page_count) * 8.0 / 1024 AS VersionStoreMB
FROM sys.dm_db_file_space_usage;  -- run on TempDB
```

---

## AG and Non-Replicated Objects

The following objects are **NOT** replicated by the AG and must be manually maintained on each replica:

| Object | Mitigation |
|---|---|
| SQL Server logins (SQL auth) | Manual sync, or use Contained AG (2022+) |
| Server-level configuration | sp_configure must be run on each node |
| Linked servers | Manual creation, or Contained AG |
| SQL Agent jobs | Manual or use Contained AG |
| SSIS packages (SSISDB) | Separate HA strategy |
| SSRS databases (ReportServer) | Separate HA strategy |
| Certificates/endpoints | Must exist on all replicas before joining |
| Backup device definitions | Manual |
| DTC configuration | Per-node |

**Login sync workaround (pre-2022):**

```sql
-- Generate login scripts with hashed passwords (run on primary)
SELECT 'CREATE LOGIN [' + name + '] WITH PASSWORD = ' +
       CONVERT(NVARCHAR(MAX), password_hash, 1) +
       ' HASHED, SID = ' + CONVERT(NVARCHAR(MAX), sid, 1) + ';'
FROM sys.sql_logins
WHERE name NOT IN ('sa', '##MS_PolicyEventProcessingLogin##', '##MS_PolicyTsqlExecutionLogin##')
  AND is_disabled = 0;
```

---

## Log Shipping

Log shipping continuously copies transaction log backups from a primary to one or more secondaries. No WSFC required.

**Components:**
- **Backup job** — runs on primary, backs up log to share
- **Copy job** — runs on secondary, copies files from share
- **Restore job** — runs on secondary, restores copied files (NORECOVERY or STANDBY)
- **Monitor server** — optional; tracks history and raises alerts on delay

```sql
-- Enable log shipping on primary (simplified; wizard is easier for initial setup)
EXEC master.dbo.sp_add_log_shipping_primary_database
    @database = N'SalesDB',
    @backup_directory = N'\\FileShare\LogShipping\Primary',
    @backup_share = N'\\FileShare\LogShipping\Primary',
    @backup_job_name = N'LSBackup_SalesDB',
    @backup_threshold = 60,           -- alert if no backup in 60 min
    @threshold_alert_enabled = 1,
    @history_retention_period = 5760; -- 4 days in minutes

-- Initialize secondary: full backup + restore with NORECOVERY, then:
EXEC master.dbo.sp_add_log_shipping_secondary_database
    @secondary_database = N'SalesDB',
    @primary_server = N'Node1\SQL01',
    @primary_database = N'SalesDB',
    @restore_delay = 0,
    @restore_all = 1,
    @restore_mode = 0,         -- 0 = NORECOVERY, 1 = STANDBY
    @disconnect_users = 0,
    @block_size = 512,
    @buffer_count = 10,
    @max_transfer_size = 0,
    @threshold = 45,
    @history_retention_period = 5760;
```

**STANDBY mode:** Restores with `WITH STANDBY = 'standby_file.BAK'` — secondary is read-only between restores. Users must disconnect during the restore window. Suitable for reporting replicas when AG is not available.

**Failover procedure:**
1. Stop backup job on primary
2. Copy and restore all pending log files with `NORECOVERY`
3. Restore with `WITH RECOVERY` to bring secondary online
4. Point clients to secondary
5. No automatic reconnection — requires DNS change or connection string update

**Log shipping monitoring:**

```sql
-- On monitor or primary
SELECT primary_database, last_backup_date, last_backup_file,
       backup_threshold, time_since_last_backup
FROM msdb.dbo.log_shipping_monitor_primary;

SELECT secondary_server, secondary_database, last_restored_date,
       restore_threshold, time_since_last_restore
FROM msdb.dbo.log_shipping_monitor_secondary;
```

---

## Failover Cluster Instances (FCI)

An FCI is a SQL Server instance that can fail over between cluster nodes. All nodes share the same storage (SAN or Storage Spaces Direct).

**Architecture:**
- Shared disk (SAN LUN or S2D cluster volume) holds all data/log files
- SQL Server is a clustered resource — runs on one node at a time
- Failover moves the IP, network name, and disk ownership to another node
- No data replication — the same files are accessed by whichever node is active

**Key differences from AG:**
- FCI protects the instance, not individual databases
- No readable secondary (only one node is active at a time)
- Storage must be shared across all FCI nodes
- Client reconnects to the same virtual network name after failover
- Faster failover for instance-level failures (OS crash, service crash)

**Common pattern — FCI + AG:**
```
FCI Node A ─┐                         ┌─ FCI Node C
             ├─ FCI Instance SQL01 ──AG─┤
FCI Node B ─┘                         └─ FCI Node D
                (Primary)                (Secondary)
```
Each AG replica is itself an FCI, providing both node-level HA (FCI) and database-level HA (AG).

---

## FCI vs AG Comparison

| | FCI | AG |
|---|---|---|
| Protects | Instance | Selected databases |
| Shared storage | Required | Not required |
| Readable secondary | No | Yes (Enterprise) |
| Data movement | None (shared disk) | Log stream replication |
| Failover type | Instance failover | Database failover |
| RPO | Zero (same data) | Zero (synchronous) or near-zero (async) |
| RTO | ~30–60 seconds | ~20–30 seconds |
| Multiple standby targets | No | Yes (up to 8) |
| Geo-DR | No (shared storage) | Yes (async replica) |

---

## AG Monitoring and DMVs

### AG health overview

```sql
SELECT ag.name AS ag_name,
       ar.replica_server_name,
       ars.role_desc,
       ars.operational_state_desc,
       ars.connected_state_desc,
       ars.synchronization_health_desc,
       ars.last_connect_error_description
FROM sys.dm_hadr_availability_replica_states ars
JOIN sys.availability_replicas ar ON ar.replica_id = ars.replica_id
JOIN sys.availability_groups ag ON ag.group_id = ar.group_id
ORDER BY ag.name, ars.role_desc;
```

### Database-level synchronization state

```sql
SELECT ag.name AS ag_name,
       adc.database_name,
       drs.synchronization_state_desc,
       drs.synchronization_health_desc,
       drs.log_send_queue_size,          -- KB not yet sent to secondary
       drs.log_send_rate,                -- KB/sec current send rate
       drs.redo_queue_size,              -- KB not yet applied on secondary
       drs.redo_rate,                    -- KB/sec redo rate on secondary
       drs.last_commit_time
FROM sys.dm_hadr_database_replica_states drs
JOIN sys.availability_databases_cluster adc ON adc.group_database_id = drs.group_database_id
JOIN sys.availability_groups ag ON ag.group_id = drs.group_id
ORDER BY drs.log_send_queue_size DESC;
```

### Estimated data loss and recovery time

```sql
SELECT ar.replica_server_name,
       adc.database_name,
       drs.log_send_queue_size AS unsent_log_kb,
       drs.redo_queue_size AS unapplied_log_kb,
       CASE WHEN drs.log_send_rate > 0
            THEN drs.log_send_queue_size / drs.log_send_rate
            ELSE NULL END AS estimated_send_seconds,
       CASE WHEN drs.redo_rate > 0
            THEN drs.redo_queue_size / drs.redo_rate
            ELSE NULL END AS estimated_redo_seconds
FROM sys.dm_hadr_database_replica_states drs
JOIN sys.availability_databases_cluster adc ON adc.group_database_id = drs.group_database_id
JOIN sys.availability_replicas ar ON ar.replica_id = drs.replica_id;
```

### Listener state

```sql
SELECT ag.name AS ag_name,
       agl.dns_name AS listener_name,
       agl.port,
       agla.ip_address,
       agla.ip_subnet_mask,
       agla.network_subnet_ip,
       agla.state_desc
FROM sys.availability_group_listener_ip_addresses agla
JOIN sys.availability_group_listeners agl ON agl.listener_id = agla.listener_id
JOIN sys.availability_groups ag ON ag.group_id = agl.group_id;
```

### Check AG status from cluster perspective

```sql
SELECT cluster_name, quorum_type_desc, quorum_state_desc
FROM sys.dm_hadr_cluster;

SELECT member_name, member_type_desc, member_state_desc, number_of_quorum_votes
FROM sys.dm_hadr_cluster_members;
```

---

## Common Failure Patterns

| Symptom | Likely Cause | Fix |
|---|---|---|
| Secondary shows NOT SYNCHRONIZING | Network partition, endpoint misconfiguration | Check endpoint state, firewall port 5022, `sys.dm_hadr_availability_replica_states.last_connect_error_description` |
| Log send queue growing | Secondary can't keep up with primary log rate | Check redo rate on secondary; reduce workload or upgrade I/O |
| AG went to RESOLVING state | Quorum lost or all synchronous replicas failed | Restore quorum or force failover |
| Readable secondary blocking primary | Version store cleanup lag | Check `sys.dm_tran_active_snapshot_database_transactions`; kill oldest secondary reader |
| Automatic failover didn't occur | DB_FAILOVER not enabled, or lease timeout too short | Check `sys.availability_groups.db_failover`, `health_check_timeout` |
| Post-failover: login failures | SQL logins not synced | Sync logins or use Contained AG (2022+) |
| Backup job failing on secondary | `AUTOMATED_BACKUP_PREFERENCE` not configured | Set preference and update backup jobs to check `sys.fn_hadr_backup_is_preferred_replica()` |
| Redo thread slow | Too many LOB/BLOB columns, large updates | Consider reducing update batch sizes; check `sys.dm_hadr_database_replica_states.redo_rate` |

### Backup on preferred replica check

```sql
-- Include this check in backup jobs to only run on preferred replica
IF sys.fn_hadr_backup_is_preferred_replica('SalesDB') = 0
BEGIN
    RAISERROR('Not the preferred backup replica. Skipping.', 10, 1) WITH NOWAIT;
    RETURN;
END
```

---

## Always On on Linux (2017+)

> [!NOTE] SQL Server 2017
> Always On AGs are supported on Linux. Linux AGs use an external cluster manager (Pacemaker) instead of WSFC.

**Key differences on Linux:**

| | Windows (WSFC) | Linux (Pacemaker) |
|---|---|---|
| Cluster manager | WSFC | Pacemaker + Corosync |
| Cluster type | WSFC | EXTERNAL or NONE |
| Automatic failover | WSFC-managed | Pacemaker-managed |
| Quorum | WSFC quorum | Corosync quorum |
| Witness | File share or disk | Corosync QDEVICE |
| Listener | WSFC VNN | Pacemaker IP resource |
| Read-scale only (no HA) | CLUSTER_TYPE = NONE | CLUSTER_TYPE = NONE |

```sql
-- Linux AG with Pacemaker
CREATE AVAILABILITY GROUP [AG_Linux]
    WITH (
        CLUSTER_TYPE = EXTERNAL,   -- Pacemaker manages failover
        DB_FAILOVER = ON,
        DTC_SUPPORT = NONE
    )
    FOR DATABASE [AppDB]
    REPLICA ON
        N'linuxnode1' WITH (
            ENDPOINT_URL = N'TCP://linuxnode1:5022',
            AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
            FAILOVER_MODE = EXTERNAL,   -- Pacemaker initiates
            SEEDING_MODE = AUTOMATIC
        ),
        N'linuxnode2' WITH (
            ENDPOINT_URL = N'TCP://linuxnode2:5022',
            AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
            FAILOVER_MODE = EXTERNAL,
            SEEDING_MODE = AUTOMATIC
        );
```

**Read-scale AG (no cluster, no automatic failover):**

```sql
CREATE AVAILABILITY GROUP [AG_ReadScale]
    WITH (CLUSTER_TYPE = NONE)
    FOR DATABASE [ReportsDB]
    REPLICA ON ...;
-- Manual failover only; no WSFC or Pacemaker required
```

---

## Azure SQL Managed Instance AG

> [!NOTE] Azure SQL Managed Instance
> Managed Instance supports AG as both primary and secondary since 2022. Distributed AGs enable cross-instance or hybrid (on-prem to MI) replication.

```sql
-- Link from on-prem AG to Managed Instance (hybrid DR)
-- Requires matching AG name, endpoint certificates, and distributed AG
-- Configuration is primarily done through Azure Portal or ARM templates
-- T-SQL setup follows the same distributed AG pattern as on-prem
```

**Business Continuity Group (BCG):** Azure SQL Managed Instance has a built-in "Business Continuity Group" feature that wraps AG in a managed experience for cross-region DR — no WSFC required.

---

## Gotchas

1. **Endpoint certificate mismatch** — If SQL Server service accounts differ between nodes, Windows Negotiate authentication fails. Use certificates in the endpoint (`AUTHENTICATION = CERTIFICATE`) for cross-domain or workgroup scenarios.

2. **Log truncation blocked by secondary** — The primary log cannot be truncated until the secondary has received (synchronous) or just until backed up (async). If the secondary disconnects, the primary log grows. Monitor `log_reuse_wait_desc = AVAILABILITY_REPLICA`.

3. **DB_FAILOVER = OFF by default** — With the default setting, AG only fails over if the SQL Server service dies, not if individual databases go offline. Enable `DB_FAILOVER = ON` for proper database-level health monitoring.

4. **Three synchronous replicas maximum** — Enterprise supports 8 total replicas but only 3 can be synchronous. Plan DR topology accordingly.

5. **Automatic seeding (2016+) requires enough tempdb space** — When `SEEDING_MODE = AUTOMATIC`, the engine streams a VDI backup to the secondary. Ensure the primary has sufficient VDI threads and the secondary has storage ready.

6. **Readable secondary snapshot isolation** — Queries on readable secondaries are automatically mapped to snapshot isolation regardless of the database's `READ_COMMITTED_SNAPSHOT` setting. [^9] However, readable secondaries generate row versions in **tempdb**, so size tempdb on every replica for the read workload's version store. Long-running reads on secondaries can also block ghost record cleanup on the primary.

7. **Failover does not move the listener by default during quorum loss** — If WSFC loses quorum but the primary SQL Server is healthy, automatic failover will not occur. You may need `FORCE_FAILOVER_ALLOW_DATA_LOSS` from a secondary.

8. **Distributed AG performance** — The DAG uses asynchronous commit between the two AGs, so the secondary AG's primary will always lag. There is no synchronous mode across a distributed AG. RPO > 0 is unavoidable.

9. **Log shipping and AG conflict** — If you use log shipping on AG databases, `AUTOMATED_BACKUP_PREFERENCE` must be set correctly, and log backups must be taken on a replica (not just the primary) to avoid log chain breaks for log shipping.

10. **Listener requires WSFC DNS** — The AG listener relies on WSFC to manage the virtual IP. Without a properly configured WSFC cluster network, listener failover will not work. Test listener failover separately from AG failover.

11. **Certificate synchronization on contained AG** — Certificates used for backup encryption or module signing that are stored in the `master` database inside the contained AG replicate fine. Server-level certificates in the non-contained `master` still need manual sync.

12. **Forced failover recovery** — After `FORCE_FAILOVER_ALLOW_DATA_LOSS`, the old primary may have transactions not on the new primary. Resume data movement carefully; the old primary will roll back uncommitted transactions and become a secondary. Validate data consistency before redirecting workloads.

---

## See Also

- `42-database-snapshots.md` — Snapshot reads don't flow to AG secondaries
- `44-backup-restore.md` — Backup with `sys.fn_hadr_backup_is_preferred_replica`, log chain management
- `13-transactions-locking.md` — RCSI/SI required on readable secondaries
- `54-linux-containers.md` — Pacemaker-based AG on Linux
- `53-migration-compatibility.md` — Rolling upgrade with AGs

---

## Sources

[^1]: [What is an Always On Availability Group?](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/overview-of-always-on-availability-groups-sql-server) — Overview of Always On AG concepts, architecture, availability modes, failover types, and benefits
[^2]: [Create an availability group with Transact-SQL (T-SQL)](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/create-an-availability-group-transact-sql) — Step-by-step T-SQL procedure for creating and configuring an availability group including endpoints, replicas, and secondary databases
[^3]: [Configure read-only routing for an availability group](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/configure-read-only-routing-for-an-availability-group-sql-server) — How to configure read-only routing URLs and routing lists so ApplicationIntent=ReadOnly connections are directed to readable secondaries
[^4]: [What is a distributed availability group?](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/distributed-availability-groups) — Architecture and configuration of distributed AGs spanning two independent availability groups across separate WSFCs
[^5]: [What Is a Contained Availability Group?](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/contained-availability-groups-overview) — Overview of contained AGs (SQL Server 2022+) that replicate logins, Agent jobs, and linked servers within the AG itself
[^6]: [About Log Shipping (SQL Server)](https://learn.microsoft.com/en-us/sql/database-engine/log-shipping/about-log-shipping-sql-server) — Log shipping architecture, components (backup/copy/restore/alert jobs), and configuration overview
[^7]: [Always On Failover Cluster Instances](https://learn.microsoft.com/en-us/sql/sql-server/failover-clusters/windows/always-on-failover-cluster-instances-sql-server) — FCI architecture, WSFC resource groups, shared storage requirements, and failover behavior
[^8]: [Availability Groups for SQL Server on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-availability-group-overview) — Characteristics of Always On AGs on Linux, Pacemaker clustering, cluster types (EXTERNAL/NONE), and differences from WSFC-based AGs
[^9]: [Offload workload to secondary availability group replica](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/active-secondaries-readable-secondary-replicas-always-on-availability-groups) — readable secondary architecture: automatic snapshot isolation mapping, tempdb version store and statistics, ghost record cleanup impact, and capacity planning considerations
[^10]: [sys.dm_hadr_database_replica_states (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-hadr-database-replica-states-transact-sql) — DMV reference covering synchronization state, log send queue, redo queue, and lag metrics for AG database replicas

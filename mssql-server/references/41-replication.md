# SQL Server Replication

## Table of Contents

1. [When to Use](#when-to-use)
2. [Replication Types Overview](#replication-types-overview)
3. [Publisher / Distributor / Subscriber Model](#publisher--distributor--subscriber-model)
4. [Snapshot Replication](#snapshot-replication)
5. [Transactional Replication](#transactional-replication)
6. [Merge Replication](#merge-replication)
7. [Replication Agents](#replication-agents)
8. [Setting Up Transactional Replication (T-SQL)](#setting-up-transactional-replication-t-sql)
9. [Articles and Filters](#articles-and-filters)
10. [Subscriptions: Push vs Pull](#subscriptions-push-vs-pull)
11. [Replication vs CDC vs Always On Readable Secondary](#replication-vs-cdc-vs-always-on-readable-secondary)
12. [Monitoring Replication](#monitoring-replication)
13. [Common Failure Modes](#common-failure-modes)
14. [Peer-to-Peer Transactional Replication](#peer-to-peer-transactional-replication)
15. [Schema Changes on Published Tables](#schema-changes-on-published-tables)
16. [Replication and Always On AGs](#replication-and-always-on-ags)
17. [Azure SQL and Replication](#azure-sql-and-replication)
18. [Removing Replication](#removing-replication)
19. [Metadata Queries](#metadata-queries)
20. [Gotchas](#gotchas)
21. [See Also](#see-also)
22. [Sources](#sources)

---

## When to Use

**Use replication when you need:**
- Real-time or near-real-time data distribution to multiple databases (e.g., branch offices, read scale-out)
- One-way data movement to a reporting or analytics subscriber without full AG licensing
- Bidirectional synchronization between disconnected or occasionally connected sites (merge)
- Distributing a subset of data (row/column filters) rather than whole databases

**Do not use replication when:**
- High availability is the primary goal — use Always On AGs instead
- You need transactional consistency guarantees across subscriber and publisher — replication is eventual
- The workload has very high DDL churn — schema changes require careful replication management
- Azure SQL Database is the publisher — only SQL Managed Instance supports publisher role; Azure SQL DB can only be a subscriber

---

## Replication Types Overview

| Type | Latency | Conflict | Best for |
|------|---------|----------|----------|
| **Snapshot** | Minutes to hours | No conflict model | Reference data, initial seeding, small tables refreshed periodically |
| **Transactional** | Sub-second to seconds | Publisher wins (unidirectional) | High-throughput OLTP distribution, reporting subscriber |
| **Merge** | Seconds to hours | Configurable resolution | Mobile/occasionally connected clients, bidirectional multi-master |
| **Peer-to-Peer (P2P)** | Sub-second to seconds | Conflict detection only (no resolution) | Multi-datacenter active-active with conflict avoidance |

**Transactional replication is the most common choice** for SQL Server shops distributing OLTP data to reporting subscribers. Snapshot is the seeding mechanism for transactional replication and works alone for small, infrequently changed tables. Merge replication has largely been supplanted by modern sync frameworks for mobile scenarios.

---

## Publisher / Distributor / Subscriber Model

```
Publisher DB          Distributor DB           Subscriber DB(s)
┌──────────────┐      ┌─────────────────┐      ┌──────────────┐
│  Published   │ Log  │  distribution   │      │  Subscribed  │
│  tables      │─────▶│  database       │─────▶│  tables      │
│  (articles)  │Reader│  (msrepl_trans  │ Dist │              │
└──────────────┘      │   + msrepl_cmds)│Agent └──────────────┘
                      └─────────────────┘
```

- **Publisher**: Source database with the tables to replicate. Uses the transaction log as the change feed (transactional) or generates a snapshot.
- **Distributor**: Holds the `distribution` database — a work queue of changes. Can co-reside on the publisher (local distributor) or be a separate server (remote distributor). Remote distributor is preferred for high-volume workloads.
- **Subscriber**: Destination database receiving changes. Can be SQL Server, Oracle, or Azure SQL.
- **Publication**: Named collection of articles from a publisher.
- **Article**: A replicated object (table, view, stored proc, indexed view) with optional row/column filters.
- **Subscription**: A subscriber's claim to a publication. Push subscriptions are driven from distributor; pull subscriptions are driven from subscriber.

---

## Snapshot Replication

Snapshot replication copies the complete state of published articles at scheduled intervals. It does not use the transaction log — the Snapshot Agent bulk copies data to snapshot files, then the Distribution Agent applies them.

**Workflow:**
1. Snapshot Agent generates `.sch` schema and `.bcp` data files to the snapshot share.
2. Distribution Agent connects to subscriber and applies the snapshot (truncates destination, bulk loads).
3. Repeat on the configured schedule.

**Use cases:**
- Reference/lookup tables that change infrequently (pricing, zip codes)
- Initial snapshot for transactional replication setup
- Reporting copies that can tolerate periodic full refreshes

**Limitations:**
- Entire table (or filtered subset) is re-applied each time — not incremental
- Large tables mean long subscription outage windows during refresh
- Snapshot files must be accessible to both Snapshot Agent and subscriber

---

## Transactional Replication

Transactional replication reads the transaction log on the publisher continuously and delivers committed transactions to subscribers, typically with sub-second to seconds of latency.

**Data flow:**
1. **Log Reader Agent** reads the publisher's transaction log and inserts replicated commands into the `distribution` database.
2. **Distribution Agent** reads from the `distribution` database and applies commands to the subscriber using parameterized stored procedures (the default delivery mechanism — fast and auditable).

**Key properties:**
- Schema-first: subscriber table must exist with compatible schema before replication starts (created by snapshot or manually)
- Commands delivered as INSERT/UPDATE/DELETE calls to auto-generated procs (`sp_MSins_`, `sp_MSupd_`, `sp_MSdel_`)
- All replication is within a transaction context at the subscriber; subscriber can query while replication applies changes
- Log Reader holds open the oldest unread LSN — this prevents log truncation until changes are delivered to distribution

> [!WARNING] Log growth risk
> If the Log Reader Agent falls behind or is stopped, the publisher's transaction log cannot be truncated. Monitor `log_reuse_wait_desc = REPLICATION` in `sys.databases`.

**Immediate updating / queued updating subscriptions**: Legacy features, rarely used, effectively deprecated in favor of P2P replication or merge.

---

## Merge Replication

Merge replication allows changes at both publisher and subscriber to be synchronized bidirectionally. It uses **rowguid** columns on every article table to track changes.

**Key properties:**
- Adds a `rowguid uniqueidentifier ROWGUIDCOL` column to every published table (if not present — a schema intrusion)
- Change tracking via `MSmerge_contents`, `MSmerge_tombstone`, and `MSmerge_genhistory` system tables
- Conflict resolution: built-in resolvers (column-level, min/max, priority, last-write-wins) or custom COM resolvers
- Supports **dynamic row filters** using `HOST_NAME()` / `SUSER_SNAME()` for per-subscriber data partitioning

**Agents:**
- **Snapshot Agent** generates initial snapshot
- **Merge Agent** runs at subscriber (pull) or distributor (push) and performs bidirectional sync

> [!WARNING] Deprecated trajectory
> Merge replication is functionally complete but no longer receiving new investment. For bidirectional sync scenarios, evaluate Azure SQL Data Sync or application-layer sync instead.

---

## Replication Agents

| Agent | Runs at | Role | Applicable types |
|-------|---------|------|-----------------|
| Snapshot Agent | Distributor | Generates schema + data snapshot files | Snapshot, Transactional (initial), Merge |
| Log Reader Agent | Distributor | Reads publisher log, writes to distribution DB | Transactional |
| Distribution Agent | Distributor (push) or Subscriber (pull) | Applies changes from distribution DB to subscriber | Snapshot, Transactional |
| Merge Agent | Distributor (push) or Subscriber (pull) | Bidirectional sync | Merge |
| Queue Reader Agent | Distributor | Handles queued updating subscriptions | Transactional (queued updating) |
| Replication Monitor | SSMS/msdb | Monitoring only | All |

All agents run as SQL Agent jobs. Check `msdb.dbo.sysjobs` filtered by job name pattern `%repl%` or use Replication Monitor.

---

## Setting Up Transactional Replication (T-SQL)

Below is a minimal T-SQL setup for a same-server publisher + local distributor + push subscriber. In production, replace `[local]` with a remote distributor server.

```sql
-- 1. Configure the distributor (run on distributor server, here same as publisher)
USE master;
EXEC sp_adddistributor
    @distributor = @@SERVERNAME,
    @password    = 'DistributorPassword!1';

EXEC sp_adddistributiondb
    @database             = 'distribution',
    @data_folder          = 'C:\SQLData',
    @log_folder           = 'C:\SQLLogs',
    @log_file_size        = 2,
    @min_distretention    = 0,
    @max_distretention    = 72,   -- hours; increase for high latency subscribers
    @history_retention    = 48,
    @deletebatchsize_xact = 5000,
    @deletebatchsize_cmd  = 2000;

-- 2. Register the publisher with the distributor
EXEC sp_adddistpublisher
    @publisher          = @@SERVERNAME,
    @distribution_db    = 'distribution',
    @security_mode      = 1,         -- Windows auth for agent connections
    @working_directory  = '\\ServerName\ReplSnap\';

-- 3. Enable the publishing database
USE [YourPublisherDB];
EXEC sp_replicationdboption
    @dbname      = 'YourPublisherDB',
    @optname     = 'publish',
    @value       = 'true';

-- 4. Add a publication
EXEC sp_addpublication
    @publication                = 'MyPublication',
    @description                = 'Transactional publication',
    @sync_method                = 'concurrent',      -- uses BCP with open cursor
    @retention                  = 336,               -- hours subscription can be inactive
    @allow_push                 = 'true',
    @allow_pull                 = 'true',
    @allow_anonymous            = 'false',
    @enabled_for_internet       = 'false',
    @snapshot_in_defaultfolder  = 'true',
    @compress_snapshot          = 'false',
    @repl_freq                  = 'continuous',
    @status                     = 'active',
    @independent_agent          = 'true',
    @immediate_sync             = 'false',
    @allow_sync_tran            = 'false',
    @autogen_sync_procs         = 'true',
    @allow_queued_tran          = 'false',
    @allow_dts                  = 'false',
    @replicate_ddl              = 1;                 -- replicate DDL changes

-- 5. Add a Log Reader Agent job
EXEC sp_addlogreader_agent
    @publisher_security_mode = 1;   -- Windows auth

-- 6. Add articles (one per table)
EXEC sp_addarticle
    @publication     = 'MyPublication',
    @article         = 'Orders',
    @source_owner    = 'dbo',
    @source_object   = 'Orders',
    @type            = 'logbased',
    @description     = NULL,
    @creation_script = NULL,
    @pre_creation_cmd = 'drop',     -- drop existing table at subscriber, recreate
    @schema_option   = 0x000000000803509F,
    @identityrangemanagementoption = 'manual',
    @destination_table = 'Orders',
    @destination_owner = 'dbo',
    @vertical_partition = 'false';

-- 7. Generate initial snapshot
EXEC sp_startpublication_snapshot
    @publication = 'MyPublication';

-- 8. Add a push subscription
EXEC sp_addsubscription
    @publication         = 'MyPublication',
    @subscriber          = 'SubscriberServerName',
    @destination_db      = 'YourSubscriberDB',
    @subscription_type   = 'Push',
    @sync_type           = 'automatic',      -- apply snapshot on first run
    @article             = 'all',
    @update_mode         = 'read only';

-- 9. Add the Distribution Agent job for this push subscription
EXEC sp_addpushsubscription_agent
    @publication             = 'MyPublication',
    @subscriber              = 'SubscriberServerName',
    @subscriber_db           = 'YourSubscriberDB',
    @subscriber_security_mode = 1,
    @frequency_type          = 64,    -- continuous
    @frequency_interval      = 0,
    @frequency_subday_type   = 4,
    @frequency_subday_interval = 5;
```

> [!NOTE] SQL Server 2022
> The `@publisher_login` / `@publisher_password` parameters can be replaced with service account Windows auth (`@security_mode = 1`) which is recommended. Always use Windows auth or a dedicated SQL login with minimal permissions — avoid `sa`.

---

## Articles and Filters

### Row filters (horizontal partitioning)
```sql
-- Static row filter: only replicate orders for region 'West'
EXEC sp_addarticle
    @publication    = 'MyPublication',
    @article        = 'Orders',
    @source_object  = 'Orders',
    @filter_clause  = N'Region = ''West''';

-- After adding the filter, add the filter proc
EXEC sp_articlefilter
    @publication    = 'MyPublication',
    @article        = 'Orders',
    @filter_name    = 'FLTR_Orders',
    @filter_clause  = N'Region = ''West''';

EXEC sp_articleview
    @publication    = 'MyPublication',
    @article        = 'Orders';
```

### Column filters (vertical partitioning)
```sql
-- Exclude sensitive columns (e.g., CreditCardNumber)
EXEC sp_articlecolumn
    @publication = 'MyPublication',
    @article     = 'Customers',
    @column      = 'CreditCardNumber',
    @operation   = 'drop';   -- 'add' to re-include
```

**Rules:**
- The primary key column(s) can never be filtered out
- Column filters cause replication to use `sp_replcmds` text-based format instead of the faster binary format — avoid if possible

---

## Subscriptions: Push vs Pull

| Aspect | Push | Pull |
|--------|------|------|
| Distribution Agent runs at | Distributor | Subscriber |
| Scheduling | Always-running (continuous) | Subscriber controls schedule |
| Central management | Easier | Harder |
| Network load | Outbound from distributor | Subscriber initiates |
| Common use | Internal server-to-server | Remote / occasionally connected subscribers |
| DMZ / firewall | Distributor must reach subscriber | Subscriber reaches out (easier through NAT) |

For always-connected subscribers on the same network, **push is preferred** — continuous mode gives lower latency and simpler monitoring.

---

## Replication vs CDC vs Always On Readable Secondary

| Capability | Transactional Replication | CDC | AG Readable Secondary |
|-----------|--------------------------|-----|-----------------------|
| Data movement | To separate database/server | Same server, change tables | Same data, different replica |
| Latency | Sub-second to seconds | Near real-time (log-based) | Near real-time (log apply) |
| Subscriber can query live | Yes (separate DB) | Yes (change tables) | Yes (read queries on secondary) |
| Subset of data | Yes (row/column filters) | Table-level granularity | No — full database copy |
| Bidirectional | P2P only | No | No |
| Requires AG license | No | No | Yes (Enterprise for readable secondary) |
| Cross-server | Yes | No (same server) | Yes |
| Schema changes | Managed with `replicate_ddl` | Requires re-enabling | Automatic |
| Conflict handling | Publisher wins | N/A | N/A |
| Azure SQL DB support | Subscriber only | Yes | N/A (Hyperscale HA replicas) |

**Decision rule:**
- Need a separate copy on a different server → replication or log shipping
- Need a read scale-out copy of the full database → AG readable secondary
- Need change data for ETL (what changed since last run) → CDC
- Need near-real-time HA → AG

---

## Monitoring Replication

### Replication Monitor (GUI)
Right-click the replication folder in SSMS or use `exec sp_replmonitorhelppublication` to open. Shows latency, agent history, subscription expiry.

### Key system tables and views

```sql
-- Undistributed commands (backlog in distribution DB)
USE distribution;
SELECT TOP 20
    a.publisher_db,
    a.publication,
    a.subscriber_db,
    a.subscriber,
    b.undistrib_cmds,
    b.dist_db_name
FROM   MSdistribution_status b
JOIN   MSsubscriptions a ON b.agent_id = a.agent_id
ORDER BY b.undistrib_cmds DESC;

-- Replication latency tracer tokens (insert a token, measure delivery time)
EXEC sp_posttracertoken
    @publication = 'MyPublication';

-- Check tracer token delivery time
EXEC sp_helptracertokens
    @publication = 'MyPublication';

-- Log reader status
SELECT * FROM MSlogreader_agents;

-- Distribution agent history (last 50 runs)
SELECT TOP 50
    a.name,
    h.start_time,
    h.time,
    h.duration,
    h.delivered_transactions,
    h.delivered_commands,
    h.delivery_rate,
    h.error_id,
    h.comments
FROM   MSdistribution_history h
JOIN   MSdistribution_agents  a ON h.agent_id = a.id
ORDER BY h.time DESC;

-- Check subscriptions status
SELECT
    srv.srvname        AS subscriber,
    sub.dest_db,
    pub.publication,
    sub.status,        -- 0=inactive, 1=subscribed, 2=active
    sub.sync_type,
    sub.nosync_type
FROM   MSsubscriptions sub
JOIN   MSarticles       art ON sub.artid = art.artid
JOIN   MSpublications   pub ON art.pubid = pub.pubid
JOIN   master.sys.servers srv ON sub.srvid = srv.srvid;
```

### Log growth monitoring (most common emergency)
```sql
-- Check if log is held by replication on publisher
SELECT
    name,
    log_reuse_wait,
    log_reuse_wait_desc,
    log_size_mb     = log_size_mb,
    log_used_mb     = log_used_mb,
    log_used_pct    = CAST(log_used_mb * 100.0 / NULLIF(log_size_mb,0) AS decimal(5,1))
FROM sys.databases
CROSS APPLY (
    SELECT
        CAST(FILEPROPERTY(name,'SpaceUsed')/128.0 AS decimal(10,1)) AS log_used_mb,
        CAST(size/128.0 AS decimal(10,1)) AS log_size_mb
    FROM sys.master_files
    WHERE database_id = sys.databases.database_id AND type = 1
) f
WHERE log_reuse_wait_desc = 'REPLICATION';
```

---

## Common Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| Log Reader not running | Publisher log grows; `log_reuse_wait_desc = REPLICATION` | Start Log Reader Agent job; fix underlying error in agent history |
| Snapshot share inaccessible | Distribution Agent fails on first sync | Verify UNC path, permissions for agent service account |
| Schema mismatch | Distribution Agent error: column count or type mismatch | Check subscriber schema; run `sp_refreshsubscriptions` or re-initialize |
| Subscription expiry | Error 21074: subscription expired | Re-initialize with snapshot or increase `@retention` on publication |
| Deadlock on subscriber | Distribution Agent retry loop | Ensure replication procs don't conflict with user workload; increase `@pollinginterval` |
| Distributor full | `distribution` database out of space | Increase max size; raise `@max_distretention`; investigate stalled subscribers |
| Duplicate key at subscriber | Error 2627 on Distribution Agent | Check for out-of-band inserts at subscriber; re-initialize or manually fix the row |
| Log Reader latency spike | Undistributed commands climb | Publisher under heavy DML load; scale up distributor or reduce replication frequency |

---

## Peer-to-Peer Transactional Replication

P2P replication (Enterprise Edition) allows multiple nodes to be both publishers and subscribers, making all nodes writable.

> [!NOTE] SQL Server 2019+
> P2P replication added **conflict detection** (not resolution) — conflicts are detected and the transaction is blocked/rolled back. This means you must architect to avoid conflicts (partition writes by node, use sequences with different seeds, etc.).

```sql
-- Enable P2P on a publication
EXEC sp_changepublication
    @publication       = 'MyPublication',
    @property          = 'allow_initialize_from_backup',
    @value             = 'true';

-- Check P2P topology
SELECT * FROM MSpeer_topologyrequest;
SELECT * FROM MSpeer_topologyresponse;
```

**P2P requirements:**
- Enterprise Edition
- All nodes must have identical schema
- No identity columns (use sequences with non-overlapping ranges, or `NEWSEQUENTIALID()`)
- Conflict detection requires `@p2p_conflictdetection = 'true'` — raises error on conflict, you must have retry logic
- All nodes must be at the same compat level and replication version

---

## Schema Changes on Published Tables

When `@replicate_ddl = 1` (the default), most DDL changes to published articles are automatically replicated. However, some DDL operations require manual steps.

```sql
-- Add a nullable column (replicated automatically with replicate_ddl=1)
ALTER TABLE dbo.Orders ADD ShippingNotes NVARCHAR(500) NULL;

-- After the DDL replicates, verify the article schema is refreshed
EXEC sp_refresharticleview
    @publication = 'MyPublication',
    @article     = 'Orders';
```

**DDL operations that require re-initialization (cannot be auto-replicated):**
- Adding a NOT NULL column without a default
- Dropping a column that is part of a row filter
- Renaming a column or table (`sp_rename` does not replicate)
- Adding a primary key (if the article had none)

**Safe workflow for risky DDL:**
1. Disable the Distribution Agent (let distribution queue build up — short window)
2. Apply DDL at publisher
3. Apply identical DDL at subscriber(s) manually
4. Re-enable the Distribution Agent

---

## Replication and Always On AGs

When the publisher database is in an AG, the Log Reader Agent must know to read from the primary replica (it follows the AG listener automatically after SQL 2012 SP2+).

```sql
-- Redirect the distributor to use the AG listener for the publisher
EXEC sys.sp_redirect_publisher
    @original_publisher  = 'OriginalPublisherNode1',
    @publisher_db        = 'YourPublisherDB',
    @redirected_publisher = 'AGListenerName';   -- DNS name of the AG listener

-- Verify redirect
SELECT * FROM sys.dm_repl_articles; -- check source
SELECT * FROM distribution.dbo.MSdistribution_agents;
```

**Key considerations:**
- After AG failover, `sp_redirect_publisher` must point to the new primary (or the listener handles it automatically if already set)
- Run `sp_MSrepl_check_publisher_connection` to verify connectivity after failover
- Distribution database should **not** be in the same AG as the publisher — it's an operational dependency that shouldn't fail over with the application
- If the subscriber is also in an AG, configure `@subscriber` as the AG listener name

---

## Azure SQL and Replication

| Scenario | Supported |
|----------|-----------|
| Azure SQL Database as **publisher** | No |
| Azure SQL Managed Instance as **publisher** | Yes (full transactional replication support) |
| Azure SQL Database as **subscriber** | Yes (push subscription from on-prem publisher) |
| Azure SQL MI as **distributor** | Yes |
| Merge replication to Azure SQL DB | No |

```sql
-- Create a push subscription to Azure SQL Database from an on-prem publisher
EXEC sp_addsubscription
    @publication       = 'MyPublication',
    @subscriber        = 'yourserver.database.windows.net',
    @destination_db    = 'YourAzureSQLDB',
    @subscription_type = 'Push',
    @sync_type         = 'automatic';

EXEC sp_addpushsubscription_agent
    @publication              = 'MyPublication',
    @subscriber               = 'yourserver.database.windows.net',
    @subscriber_db            = 'YourAzureSQLDB',
    @subscriber_security_mode = 0,      -- SQL auth required for Azure SQL DB
    @subscriber_login         = 'repl_user',
    @subscriber_password      = 'StrongPassword!1';
```

---

## Removing Replication

Remove in reverse order: subscriptions first, then articles, then publication, then distribution configuration.

```sql
-- 1. Remove push subscription
EXEC sp_dropsubscription
    @publication = 'MyPublication',
    @article     = 'all',
    @subscriber  = 'SubscriberServerName';

-- 2. Drop the publication
EXEC sp_droppublication
    @publication = 'MyPublication';

-- 3. Disable publishing on the database
EXEC sp_replicationdboption
    @dbname  = 'YourPublisherDB',
    @optname = 'publish',
    @value   = 'false';

-- 4. Remove the distributor (if no other publishers)
EXEC sp_dropdistributiondb
    @database = 'distribution';

EXEC sp_dropdistributor
    @no_checks = 1;   -- use only if you're sure nothing else uses this distributor
```

> [!WARNING] Nuclear option
> If replication is in a broken state and normal cleanup fails, use:
> ```sql
> EXEC sp_removedbreplication @dbname = 'YourPublisherDB';
> ```
> This removes ALL replication metadata from the database. Use only as a last resort — it does not clean up the distribution database or subscriber metadata.

---

## Metadata Queries

```sql
-- List all publications on this server
SELECT * FROM sys.publications;   -- publisher DB context
SELECT * FROM distribution.dbo.MSpublications;

-- List all articles for a publication
SELECT
    art.article,
    art.source_object,
    art.destination_object,
    art.filter,
    art.filter_clause,
    art.status
FROM distribution.dbo.MSarticles art
JOIN distribution.dbo.MSpublications pub ON art.pubid = pub.pubid
WHERE pub.publication = 'MyPublication';

-- List all subscriptions and their status
SELECT
    srv.srvname AS subscriber,
    sub.dest_db,
    pub.publication,
    CASE sub.status
        WHEN 0 THEN 'inactive'
        WHEN 1 THEN 'subscribed'
        WHEN 2 THEN 'active'
    END AS status,
    sub.subscription_type
FROM distribution.dbo.MSsubscriptions sub
JOIN distribution.dbo.MSarticles       art ON sub.artid = art.artid
JOIN distribution.dbo.MSpublications   pub ON art.pubid = pub.pubid
JOIN master.sys.servers                srv ON sub.srvid = srv.srvid;

-- Check undistributed command count per subscriber (replication latency proxy)
SELECT
    a.subscriber,
    a.subscriber_db,
    a.publication,
    b.undistrib_cmds,
    b.avgdelay
FROM distribution.dbo.MSdistribution_status  b
JOIN distribution.dbo.MSsubscriptions         a ON b.agent_id = a.agent_id
ORDER BY b.undistrib_cmds DESC;

-- Replication agent job names
SELECT
    j.name AS job_name,
    j.enabled,
    ja.last_run_date,
    ja.last_run_time,
    ja.last_run_outcome
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobactivity ja ON j.job_id = ja.job_id
WHERE j.name LIKE '%repl%'
  AND ja.session_id = (SELECT MAX(session_id) FROM msdb.dbo.sysjobactivity);

-- Check if replicate_ddl is on
SELECT
    publication,
    replicate_ddl,
    retention,
    allow_push,
    allow_pull
FROM distribution.dbo.MSpublications;

-- Tracer token latency history
SELECT
    tt.tracer_id,
    tt.publisher_commit,
    th.subscriber,
    th.subscriber_commit,
    DATEDIFF(ms, tt.publisher_commit, th.subscriber_commit) AS latency_ms
FROM distribution.dbo.MSpublisher_tokens tt
LEFT JOIN distribution.dbo.MSsubscriber_info si ON 1=1
JOIN distribution.dbo.MStransactions_history th ON tt.tracer_id = th.tracer_id
ORDER BY tt.publisher_commit DESC;
```

---

## Gotchas

1. **Log truncation held by Log Reader.** If the Log Reader Agent stops (or lags), the publisher transaction log cannot be truncated at the oldest unreplicated LSN. Monitor `log_reuse_wait_desc` and agent status together. An unmonitored publication can grow the log to capacity overnight.

2. **`replicate_ddl` doesn't cover everything.** `sp_rename`, partition-related DDL, and full-text index DDL do not replicate even with `replicate_ddl = 1`. Treat these as manual operations.

3. **IDENTITY range management.** When replicating tables with `IDENTITY` columns, SQL Server manages non-overlapping identity ranges at publisher vs subscriber. If ranges run out, inserts at the subscriber fail. Monitor with `sp_showpendingchanges` and `MSreplication_objects`.

4. **Subscription expiry is silent until it's a problem.** The default `@retention` is 336 hours (14 days). A subscriber that is inactive (e.g., a dev box) for more than 14 days becomes expired and must be re-initialized. Increase retention for non-critical subscribers, but a higher value means the distribution database retains more data.

5. **Snapshot share permissions.** The Snapshot Agent service account needs Write access to the snapshot share; the Distribution Agent service account needs Read access. When agents run as different accounts (common in production), this is a frequent setup failure.

6. **Subscriber cannot have FK constraints pointing to un-replicated tables.** If you replicate a child table but not the parent, FK constraints at the subscriber will block the Distribution Agent. Either replicate both tables (and order them correctly) or disable FK constraints at the subscriber.

7. **Filtered articles and joins.** If you use a row filter that references a join filter (`sp_addmergefilter` / join filter in transactional via `sp_articleview`), all joined tables must also be articles in the same publication.

8. **P2P conflict detection doesn't resolve.** When a conflict is detected in P2P replication, the transaction is marked in error and the agent stops. You must resolve it manually (delete the conflicting row on one side, restart the agent). Unlike merge replication, there is no automatic conflict resolution.

9. **Replication and TDE.** If the publisher database uses TDE, the distribution database does not need TDE — the changes are stored in plain text in the distribution database. This can be a compliance concern; protect the distributor accordingly.

10. **`sp_removedbreplication` as emergency exit.** This stored procedure removes all replication metadata from the calling database context but does NOT clean up the distribution database. Run it on both publisher and subscriber databases, then manually clean up `distribution..MSarticles`, `MSsubscriptions`, etc., or drop and recreate the distribution database.

11. **Replication monitor lag metric is based on tracer tokens.** The latency displayed in Replication Monitor is only updated when a tracer token is inserted. By default, tokens are inserted every 5 minutes. Instant high latency is an estimate; use `sp_posttracertoken` manually for accurate measurement.

12. **Adding a publication recompiles the Log Reader.** The Log Reader Agent scans the transaction log looking for marked transactions. Adding or removing articles forces a restart of the Log Reader, which causes a brief gap in delivery. Coordinate with low-traffic windows.

---

## See Also

- [`43-high-availability.md`](43-high-availability.md) — Always On AGs as an alternative to replication for HA/DR
- [`37-change-tracking-cdc.md`](37-change-tracking-cdc.md) — CDC for change data capture without replication overhead
- [`40-service-broker-queuing.md`](40-service-broker-queuing.md) — SSB for async messaging within/across databases
- [`44-backup-restore.md`](44-backup-restore.md) — initializing replication from backup (`sync_type = 'initialize with backup'`)
- [`50-sql-server-agent.md`](50-sql-server-agent.md) — SQL Agent jobs that drive replication agents

---

## Sources

[^1]: [Transactional Replication - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/replication/transactional/transactional-replication) — overview of how transactional replication works, its agents, and supported topologies
[^2]: [sp_addpublication (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-addpublication-transact-sql) — reference for all parameters of sp_addpublication including sync_method, retention, replicate_ddl, and P2P options
[^3]: [sp_addarticle (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-addarticle-transact-sql) — reference for adding articles to a publication, covering schema options, filter clauses, identity range management, and article types
[^4]: [Peer-to-Peer Transactional Replication - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/replication/transactional/peer-to-peer-transactional-replication) — architecture, requirements, conflict detection, and maintenance considerations for P2P replication topologies
[^5]: [Configure Replication With Availability Groups - SQL Server Always On](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/configure-replication-for-always-on-availability-groups-sql-server) — step-by-step guide for configuring SQL Server replication with Always On availability groups including sp_redirect_publisher usage
[^6]: [sp_redirect_publisher (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-redirect-publisher-transact-sql) — redirects a publisher/database pair to an AG listener name for replication failover support
[^7]: [Replication to Azure SQL Database - Azure SQL Database](https://learn.microsoft.com/en-us/azure/azure-sql/database/replication-to-sql-database) — supported configurations, version requirements, and limitations for using Azure SQL Database as a push subscriber
[^8]: [sp_removedbreplication (T-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-removedbreplication-transact-sql) — removes all replication objects from a database; last-resort cleanup procedure when normal removal methods fail
[^9]: [Scary SQL Surprises: Crouching Tiger, Hidden Replication - Brent Ozar Unlimited](https://www.brentozar.com/archive/2012/08/scary-sql-surprises-crouching-tiger-hidden-replication/) — covers the log growth anti-pattern where dormant or improperly torn-down replication metadata blocks transaction log truncation

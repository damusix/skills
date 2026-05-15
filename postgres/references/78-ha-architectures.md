# 78. HA Architectures

PostgreSQL high-availability pattern catalog. Cluster-manager responsibilities (leader election, fencing, watchdog). Split-brain prevention. DCS choice. RTO/RPO trade-offs per pattern. Why no in-core failover orchestration.

> [!WARNING] PostgreSQL ships NO in-core failover orchestration.
>
> Core PG provides streaming replication, replication slots, `pg_promote()`, `pg_rewind`, and `synchronous_standby_names`. It does NOT provide leader election, fencing, automatic failover, or split-brain prevention. Every HA cluster bolts these on via an external cluster manager (Patroni, repmgr, pg_auto_failover, Stolon, or a Kubernetes operator). Decision is which tool, not whether to use one.

## Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Cluster-Manager Responsibilities](#cluster-manager-responsibilities)
- [Split-Brain Prevention](#split-brain-prevention)
- [DCS Choices](#dcs-choices)
- [Pattern Catalog](#pattern-catalog)
- [RTO and RPO per Pattern](#rto-and-rpo-per-pattern)
- [Per-Version HA Surface](#per-version-ha-surface)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick HA tool. Compare patterns. Plan RTO/RPO budget. Understand cluster-manager responsibilities before choosing operator. Diagnose split-brain. Decide DCS (etcd vs Consul vs ZooKeeper vs Kubernetes API).

For mechanics behind HA: [`73-streaming-replication.md`](./73-streaming-replication.md) (WAL ship), [`75-replication-slots.md`](./75-replication-slots.md) (slot lifecycle), [`77-standby-failover.md`](./77-standby-failover.md) (`pg_promote()` + hot standby query rules + `pg_rewind`).

For Patroni deep dive: [`79-patroni.md`](./79-patroni.md).

For DR (regional + recovery from backup): [`90-disaster-recovery.md`](./90-disaster-recovery.md).

## Mental Model

Five rules:

1. **HA is built EXTERNALLY.** Core PG = streaming replication primitives + `pg_promote()` + replication slots + `pg_rewind`. Cluster manager = leader election + fencing + automatic failover + reconfiguration. No in-core orchestration ever[^pg-ha-chapter].
2. **Cluster manager needs four things:** leader election (who's primary), fencing (kill or isolate diverged primary), watchdog (detect dead leader fast), promotion (run `pg_promote()` + reconfigure replicas + redirect traffic).
3. **Distributed Consensus Store (DCS) is the source of truth.** Patroni / pg_auto_failover / Stolon use etcd / Consul / ZooKeeper / Kubernetes API as the consensus layer. Without DCS quorum, no safe failover.
4. **Split-brain is preventable; not avoidable by hope.** Fencing (STONITH, replication-slot drops, network isolation), quorum (odd-node DCS), witness nodes, and synchronous replication each defend against a specific split-brain shape. Combine multiple.
5. **RTO and RPO are independent dials.** RTO = time-to-recovery. RPO = data-loss tolerance. Synchronous replication shrinks RPO at the cost of write latency + write availability when sync standby unreachable. Pick the worst-case both your tolerance and your budget allow.

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Self-managed bare-metal/VM | Patroni + etcd | Manual `pg_ctl promote` scripts | Patroni handles fencing, leader election, watchdog. Manual scripts produce split-brain. |
| Self-managed VM, light footprint | repmgr | Patroni for 2-node | repmgr's `repmgrd` daemon handles failover without DCS overhead. Patroni minimum quorum = 3 DCS nodes. |
| Kubernetes-native | CloudNativePG (CNPG) operator | Bare Patroni on K8s | CNPG uses K8s API as DCS, integrates StatefulSet + PVC + Service + backup CRDs. Patroni on K8s works but duplicates K8s primitives. |
| Citus distributed | Citus + pg_auto_failover OR CNPG | Patroni without integration | pg_auto_failover designed for multi-node coordinator + worker shards |
| Multi-cluster federation | DR pattern, NOT HA | Single cluster-manager spanning regions | HA = single-region tight latency. DR = cross-region async + manual decision. See [`90-disaster-recovery.md`](./90-disaster-recovery.md). |
| Zero-downtime maintenance | Patroni `switchover` or CNPG `cnpg promote` | Stop-then-failover | Controlled switchover loses 0 transactions (synchronous_commit=on). Failover loses uncommitted in-flight. |
| RPO = 0 across two nodes | `synchronous_standby_names = 'FIRST 1 (s1)'` + Patroni `synchronous_mode = on` | Async replication for primary OLTP | Cluster manager will refuse to promote a standby that wasn't sync. See [`73-streaming-replication.md`](./73-streaming-replication.md) Rule 3. |
| Quorum sync across 3 AZs | `synchronous_standby_names = 'ANY 1 (s1, s2)'` | `FIRST` mode for AZ failure | `ANY` accepts any 1-of-2 ack; survives single-AZ loss without blocking writes. |
| New cluster, no tooling selected | Patroni (bare metal/VM) OR CloudNativePG (K8s) | Stolon | Stolon appears unmaintained — last release Sept 2021, caps at PG15[^stolon]. Avoid for new deployments. |
| Logical replication-based HA | Use streaming replication + sync standby instead | Logical replication for failover | Logical: DDL not replicated, sequences not synced, conflicts block apply worker. See [`74-logical-replication.md`](./74-logical-replication.md) Gotcha #1. |
| Existing repmgr deployment, want richer features | Patroni (migrate when convenient) | Force migration | repmgr remains supported. EDB owns it. Works fine. Migrate when DCS infrastructure already in place. |

Three smell signals you reached for HA wrong:

- **Failover script runs `pg_ctl promote` from cron without DCS coordination** — split-brain on next network partition. Use a cluster manager.
- **HA cluster spans regions with `synchronous_commit = on` to remote** — write latency = RTT to remote region. Either drop sync OR keep HA inside one region + DR cross-region.
- **Three-node DCS cluster running on the same VM as PG primary** — DCS quorum dies when primary VM dies. DCS quorum must live on separate failure domain.

## Cluster-Manager Responsibilities

Every HA tool implements these four. Differences are in WHO does each + which DCS backs the state.

### Leader Election

One primary at a time. All cluster-managers use DCS for this. Pattern:

1. Each node attempts to claim "leader" key in DCS with TTL.
2. Only one node wins (atomic CAS).
3. Leader periodically renews TTL.
4. If leader fails to renew (process died, network partition, disk hung), TTL expires, leader key released.
5. Other nodes race to claim leader. One wins. Promotion procedure runs.

> [!NOTE] DCS quorum determines who's leader, not PG itself.
>
> Even if a PG instance is up + accepting writes, if its node lost the DCS race or lost network to DCS quorum, the cluster manager will demote it. PG instance is not the source of truth; DCS is.

### Fencing

Goal: ensure old primary cannot accept writes after a new primary is promoted. Without fencing → split-brain.

Three common mechanisms:

- **STONITH** (Shoot The Other Node In The Head): hardware power-cycle or hypervisor-level VM kill. Strongest guarantee.
- **Replication slot drop**: cluster manager drops the old primary's incoming-from-new-primary slot. Old primary blocks on `synchronous_standby_names` if it's still configured for sync, OR diverges on writes that never replicate.
- **Resource fencing**: cluster manager flips network policy / firewall / load-balancer to block old primary from clients.

Patroni's default: watchdog + DCS-leadership-loss demotion. Will issue `pg_ctl stop -m fast` on old primary when it discovers it lost leadership. STONITH optional via external hook[^patroni-watchdog].

CNPG: relies on Kubernetes pod deletion + StatefulSet ordering. Pod-level fencing[^cnpg-failure-modes].

repmgr: BYO STONITH or rely on `repmgrd` to demote via SSH if reachable.

### Watchdog

How fast can the cluster manager detect a dead primary?

- **Patroni**: TTL on leader key in DCS, default 30s. Heartbeat every `loop_wait` (default 10s)[^patroni-config].
- **pg_auto_failover**: monitor node polls every 5s. Failover triggers after `--node-replication-timeout` (default 30s).
- **repmgr**: `repmgrd` daemon, polling interval configurable. Default 10s.
- **CNPG**: K8s liveness probe + `replication.standby.failover.minHealthyReplicas` configurable. K8s default probe = 10s.

Trade-off: shorter TTL = faster failover but more false positives (network blips trigger unnecessary failover).

### Promotion

When DCS hands new node leader status, cluster manager:

1. Runs `pg_promote()` or `pg_ctl promote` on the new primary.
2. Reconfigures remaining replicas to follow new primary via `primary_conninfo`.
3. Triggers `pg_rewind` on old primary (if it returns) before re-attaching.
4. Updates external service-discovery (HAProxy backend list, K8s Service endpoint, DNS).
5. Drops or releases obsolete replication slots.

## Split-Brain Prevention

Split-brain = two PG instances both accepting writes. Worst possible outcome — diverged data, irreconcilable.

Defenses, ordered by strength:

| Defense | What it does | Cost |
|---|---|---|
| STONITH | Power-cycle old primary | Requires hardware/hypervisor integration |
| `synchronous_commit = remote_apply` + DCS quorum | Old primary can't commit if sync standby unreachable | Write latency increases; write availability drops when sync standby down |
| Watchdog timer | Kernel-level reboot if cluster manager hangs | Requires `softdog` or hardware watchdog kernel module |
| Replication slot fencing | Old primary blocks because slot is gone | Doesn't help reads or writes that finish before slot drop |
| Network-level fencing | Firewall / load-balancer blocks old primary | Depends on external infrastructure |
| Witness node | Tie-breaker quorum for 2-node setups | Adds infrastructure |

> [!WARNING] Two-node clusters without a witness or quorum are unsafe.
>
> If a 2-node cluster partitions, both nodes see the other as "down" and both may attempt to promote. With no third opinion, both win. Add a witness (third DCS node, or pg_auto_failover monitor) before trusting any 2-node HA setup.

### Watchdog Hardware Integration

Linux `softdog` kernel module + Patroni's `watchdog.mode = required` config: if Patroni hangs (Python process stuck, disk hang), the kernel reboots the node after the watchdog timer expires (default 5s). Prevents zombie-primary scenarios where the cluster manager is alive enough to keep the leader key but the database is wedged[^patroni-watchdog].

## DCS Choices

| DCS | Strengths | Weaknesses | Best for |
|---|---|---|---|
| **etcd** | Lightweight, fast, designed for K8s + Patroni. Raft consensus. | Small data only (< 8GB total). Ops effort to keep healthy. | Bare metal Patroni, K8s clusters |
| **Consul** | Service discovery + DCS in one. K/V API + DNS + health checks. | Heavier than etcd. License changed to BUSL in 2024 (HashiCorp). | Environments already running Consul |
| **ZooKeeper** | Mature, stable, well-known. | Java VM overhead. Configuration complexity. | Existing Hadoop/Kafka shops |
| **Kubernetes API** | No extra service to run. Native to K8s. | Slower than etcd (rate-limited K8s API). Couples HA to K8s control-plane health. | CloudNativePG, K8s-native deployments |

> [!NOTE] DCS quorum must live in a failure domain separate from the data nodes.
>
> A 3-node DCS cluster running on the same 3 VMs as the PG nodes provides zero protection: any failure mode that kills 2 PG nodes also kills 2 DCS nodes → quorum lost → cluster manager freezes. Run DCS on dedicated nodes OR a different cloud region/AZ from the PG primary.

DCS node count: always odd (3, 5, 7). Reason: split-brain on even-numbered clusters when partition is exactly half-half. 3 nodes tolerate 1 failure. 5 nodes tolerate 2.

## Pattern Catalog

### Pattern 1: Streaming Replication + Manual Failover

Simplest. Two or three PG nodes with streaming replication. No cluster manager. Failover = human runs `pg_ctl promote` + updates app config.

**When appropriate:** dev/staging. Low-volume read-mostly workloads where minutes of downtime is fine. Educational setups.

**RTO:** human-detection time + 1-2 min to reconfigure. Realistic: 15-60 min.
**RPO:** depends on `synchronous_commit`. Async: seconds-to-minutes of in-flight transactions lost.

**Risks:** split-brain if multiple admins panic-promote. Slow detection (humans aren't watching at 03:00).

> [!WARNING] Manual failover without a cluster manager is not suitable for production workloads with availability SLAs. Use an automated cluster manager (Patroni, repmgrd, pg_auto_failover) for production.

### Pattern 2: repmgr

Replication manager from 2ndQuadrant (now EDB). Adds a daemon (`repmgrd`) for automatic failover. DCS-less — uses the PG cluster itself to coordinate via a `repmgr` extension.

**Strengths:** simple. Lightweight. No DCS infrastructure required. Production-proven for many years[^repmgr].
**Weaknesses:** less aggressive feature evolution than Patroni. 2-node setups need careful witness configuration.

**RTO:** ~30-60s with `repmgrd` configured aggressively.
**RPO:** depends on `synchronous_standby_names`.

**Best for:** existing repmgr deployments. Smaller shops with bare-metal/VM infrastructure where adding etcd is friction.

### Pattern 3: Patroni + DCS

The de facto standard for self-managed Postgres HA. Python daemon on each PG node + external DCS for leader election. Mature, large community, used everywhere from Zalando (original authors) to GitLab to thousands of self-hosted clusters.

**Strengths:** flexible DCS backend (etcd, Consul, ZooKeeper, K8s API). REST API for operations. Dynamic configuration via DCS K/V. Watchdog support. Excellent integration with HAProxy + pgBouncer.
**Weaknesses:** requires DCS infrastructure (etcd cluster). YAML config has a learning curve.

**RTO:** 10-30s typical (watchdog TTL).
**RPO:** depends on `synchronous_standby_names` + Patroni's `synchronous_mode`.

**Best for:** the default modern self-managed answer.

Deep dive: [`79-patroni.md`](./79-patroni.md).

### Pattern 4: pg_auto_failover

Microsoft-sponsored (originally Citus Data) cluster manager. Different architecture: a dedicated **monitor** node holds the cluster state. Data nodes connect to the monitor and follow its instructions.

**Strengths:** simple model. Designed for Citus distributed clusters. Coordinator + workers each get HA. Smaller operational surface than Patroni.
**Weaknesses:** smaller community than Patroni. Monitor node itself is single-point-of-failure (configure HA for the monitor too).

**RTO:** ~30s default.
**RPO:** depends on sync mode.

**Best for:** Citus deployments. Microsoft-shop preference.

### Pattern 5: Stolon

Sorint.lab's cloud-native HA solution. Sentinel + Keeper + Proxy three-component architecture.

> [!WARNING] Stolon appears unmaintained.
>
> Last release v0.17.0 was September 2021. Supported PG versions cap at 15. No PG16/17/18 support upstream[^stolon]. For new deployments, avoid. For existing Stolon clusters, plan migration to Patroni or CloudNativePG.

### Pattern 6: Kubernetes Operators

K8s operators bundle HA + backup + scaling + monitoring as Custom Resources. The operator runs in K8s and reconciles the desired state of PG clusters defined as CRDs.

Three actively-maintained operators:

| Operator | Project | Strengths | Notes |
|---|---|---|---|
| CloudNativePG (CNPG) | cloudnative-pg.io | CNCF-incubated, no Patroni dependency, native K8s primitives, declarative backup via Barman, supports PG13-18 | Recommended for new K8s deployments. v1.29 stable at planning time[^cnpg]. |
| Zalando postgres-operator | github.com/zalando/postgres-operator | Original Patroni-on-K8s, large user base, supports PG13-17 | Bundles Patroni internally. v1.15.1 at planning time[^zalando-pg-op]. |
| Crunchy Data PGO | github.com/CrunchyData/postgres-operator | Commercial backing from Crunchy, mature, deep backup integration | Now at v6.0.1 (Feb 2026)[^crunchy-pgo]. |

**Strengths of operator pattern overall:** declarative CRD model fits GitOps. Operators handle PVC management, Service updates, secret rotation, scheduled backup, monitoring integration. K8s native.

**Weaknesses:** couples HA to K8s control-plane health. K8s API as DCS is slower than dedicated etcd. Storage strategy (StorageClass, ReadWriteOnce PVC) becomes critical.

**RTO:** 20-60s (K8s probe interval + pod restart).
**RPO:** depends on sync mode + storage replication.

**Best for:** organizations already running K8s for the rest of their stack.

### Pattern Summary

| Pattern | Failover automation | DCS required | Fencing | Best for |
|---|---|---|---|---|
| Manual | No | No | No | Dev only |
| repmgr | Yes (`repmgrd`) | No | BYO STONITH | Bare metal/VM, lightweight |
| Patroni | Yes | Yes (etcd/Consul/ZK/K8s API) | Watchdog + STONITH hooks | Default modern choice for self-managed |
| pg_auto_failover | Yes (monitor node) | No (monitor IS the DCS) | Monitor-driven | Citus shops, Microsoft preference |
| Stolon | Yes | Yes (etcd/Consul) | Sentinel | Avoid for new deployments (unmaintained) |
| K8s operators (CNPG/Zalando/PGO) | Yes | K8s API | Pod fencing | K8s-native shops |

## RTO and RPO per Pattern

RTO = recovery time objective (downtime budget). RPO = recovery point objective (data-loss budget).

| Configuration | Realistic RTO | Realistic RPO | Notes |
|---|---|---|---|
| Async streaming + manual failover | 15-60 min | seconds-to-minutes | Human-in-the-loop |
| Async streaming + repmgr | 30-60s | 1-30s | Lost in-flight async-replicated tx |
| Async streaming + Patroni | 10-30s | 1-10s | TTL-driven failover |
| Sync (`FIRST 1`) + Patroni | 10-30s | 0 (if sync standby healthy) | Writes block when sync standby unreachable |
| Quorum sync (`ANY 1 of N`) + Patroni | 10-30s | 0 (survives single-node loss without blocking writes) | Best RPO/availability balance |
| K8s operator (CNPG) | 20-60s | depends on sync mode | Pod restart adds latency |
| Cross-region async (DR, not HA) | 5-30 min | 1-5 min | Not for automatic failover; see [`90-disaster-recovery.md`](./90-disaster-recovery.md) |

> [!NOTE] RPO = 0 is expensive.
>
> `synchronous_commit = on` + `synchronous_standby_names = 'FIRST 1 (s1)'` gives RPO = 0 — but EVERY write blocks waiting for s1 to ack. If s1 is unreachable, ALL writes block until either s1 returns OR cluster manager swaps in another standby. Plan for unhealthy-sync-standby behavior explicitly. The verbatim docs warning: writes block when sync standby is gone[^sync-standby].

## Per-Version HA Surface

PG14-18 release-note items affecting HA architectures. Specific features documented in their own files; this section catalogs the surface to know which versions enable which HA patterns.

### PG14

- `pg_stat_replication_slots` view (verbatim "Add system view `pg_stat_replication_slots` to report replication slot activity (Masahiko Sawada, Amit Kapila, Vignesh C)"). Cluster managers can monitor slot lag without sampling.
- `log_recovery_conflict_waits` (verbatim "Add server parameter `log_recovery_conflict_waits` to report long recovery conflict wait times"). Helps diagnose standby query cancellation.
- `recovery_init_sync_method=syncfs` (verbatim "Allow file system sync at the start of crash recovery on Linux"). Faster post-failover startup on many-file clusters.
- `in_hot_standby` GUC (verbatim "Add new read-only server parameter `in_hot_standby`"). Cluster managers can detect standby status without `pg_is_in_recovery()` race conditions.

### PG15

- `pg_basebackup` LZ4/Zstandard compression (verbatim "Add support for LZ4 and Zstandard compression of server-side base backups (Jeevan Ladhe, Robert Haas)"). Faster reseed of replicas.
- Checkpointer + bgwriter during crash recovery (verbatim "Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro). This helps to speed up long crash recoveries").
- `recovery_prefetch` (verbatim "Allow WAL processing to pre-fetch needed file contents"). Reduces replica replay lag.
- `archive_library` (verbatim "Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands"). Cleaner integration with pgBackRest/Barman/WAL-G.

### PG16

- Logical decoding on standbys (verbatim "Allow logical decoding on standbys (Bertrand Drouvot, Andres Freund, Amit Khandekar)"). Enables CDC from a replica without primary load.
- `promote_trigger_file` REMOVED (verbatim "Remove server variable `promote_trigger_file` (Simon Riggs). This was used to promote a standby to primary, but is now more easily accomplished with `pg_ctl promote` or `pg_promote()`"). Failover scripts that relied on writing a trigger file silently no-op on PG16+. Operational watershed for cluster managers.

### PG17

- `pg_createsubscriber` CLI (verbatim "Add application `pg_createsubscriber` to create a logical replica from a physical standby server (Euler Taveira)"). Useful for cross-major-version migration without long dump/restore.
- Failover of logical slots (verbatim "Enable the failover of logical slots (Hou Zhijie, Shveta Malik, Ajin Cherian)") + `sync_replication_slots` GUC + `synchronized_standby_slots` GUC + `pg_sync_replication_slots()` function. Logical subscribers survive primary failover for the first time.
- `pg_basebackup --incremental` + `pg_combinebackup` (verbatim "Add support for incremental file system backup (Robert Haas, Jakub Wartak, Tomas Vondra)"). Reduces backup window for large HA clusters.
- `pg_replication_slots.invalidation_reason` + `inactive_since` columns. Cluster managers can diagnose slot health.

### PG18

- `idle_replication_slot_timeout` (verbatim "Allow inactive replication slots to be automatically invalidated using server variable `idle_replication_slot_timeout` (Nisha Moond, Bharath Rupireddy)"). Prevents abandoned-slot disk fill (the #1 production incident — see [`75-replication-slots.md`](./75-replication-slots.md)).
- `pg_rewind --source-server dbname` (verbatim "If pg_rewind's --source-server specifies a database name, use it in --write-recovery-conf output (Masahiko Sawada)"). Cluster managers' rewind step less likely to produce a misconfigured `primary_conninfo`.
- HA chapter renumbered from chapter 27 (PG16) to chapter 26 (PG18). URLs by major version, not chapter number.

## Recipes

### Recipe 1: Pick a Pattern

Decision tree:

```
Running on Kubernetes?
├── Yes → CloudNativePG (CNPG) operator
└── No → Bare metal or VM?
        ├── Existing repmgr deployment? → keep repmgr
        ├── Running Citus? → pg_auto_failover
        └── Otherwise → Patroni + etcd
```

### Recipe 2: Minimum 3-Node Patroni Cluster

Three PG nodes. Three etcd nodes (separate hosts). Patroni on each PG node.

```yaml
# /etc/patroni/patroni.yml on PG node 1
scope: pg-prod
name: pg01
namespace: /pg/

restapi:
  listen: 10.0.0.11:8008
  connect_address: 10.0.0.11:8008

etcd:
  hosts: 10.0.1.10:2379,10.0.1.11:2379,10.0.1.12:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    synchronous_mode: on
    synchronous_node_count: 1
    postgresql:
      use_pg_rewind: true
      parameters:
        max_connections: 200
        shared_buffers: 8GB
        wal_level: replica
        max_wal_senders: 10
        max_replication_slots: 10
        wal_log_hints: on            # required for pg_rewind
        synchronous_commit: on
        synchronous_standby_names: 'ANY 1 (pg02, pg03)'

postgresql:
  listen: 10.0.0.11:5432
  connect_address: 10.0.0.11:5432
  data_dir: /var/lib/postgresql/16/main
  authentication:
    replication:
      username: replicator
      password: ${REPLICATION_PASSWORD}
    superuser:
      username: postgres
      password: ${SUPERUSER_PASSWORD}

watchdog:
  mode: required        # require kernel watchdog
  device: /dev/watchdog
  safety_margin: 5
```

Critical settings:

- `wal_log_hints: on` — required for `pg_rewind` to re-attach old primary[^pg-rewind].
- `synchronous_mode: on` + `synchronous_standby_names = 'ANY 1 (...)'` — quorum sync for RPO = 0 surviving single-node loss.
- `maximum_lag_on_failover: 1048576` (1 MB) — Patroni refuses to promote a standby that's more than 1 MB behind. Tune for your throughput.
- `watchdog.mode: required` — kernel reboots node if Patroni hangs.

### Recipe 3: CloudNativePG Cluster

```yaml
# CNPG Cluster resource
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-prod
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:16.4
  primaryUpdateStrategy: unsupervised
  postgresql:
    parameters:
      shared_buffers: "8GB"
      max_connections: "200"
      wal_log_hints: "on"
    synchronous:
      method: any
      number: 1
  bootstrap:
    initdb:
      database: app
      owner: app
  storage:
    size: 100Gi
    storageClass: fast-ssd
  monitoring:
    enablePodMonitor: true
  backup:
    barmanObjectStore:
      destinationPath: "s3://my-pg-backups/prod"
      s3Credentials:
        accessKeyId:
          name: backup-creds
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-creds
          key: SECRET_ACCESS_KEY
```

CNPG handles: leader election (K8s API as DCS), pod fencing (StatefulSet ordering), Service updates (`-rw` for primary, `-ro` for replicas, `-r` for any), backup scheduling (Barman), monitoring (Prometheus scrape).

### Recipe 4: Detect Split-Brain

Two PG instances both running with `pg_is_in_recovery() = false` is the canonical signal.

```sql
-- Run from outside the cluster against each node
SELECT
    inet_server_addr() AS node_ip,
    pg_is_in_recovery() AS is_replica,
    pg_last_wal_replay_lsn() AS replay_lsn,
    pg_current_wal_lsn() AS write_lsn,    -- non-null only on primary
    current_timestamp;
```

Two nodes with `is_replica = false` simultaneously = split-brain. Immediate action: stop the older-WAL-position one. Plan for data divergence reconciliation manually.

### Recipe 5: Controlled Switchover (Patroni)

Zero-loss promotion of standby to primary, demoting old primary cleanly:

```bash
# From any Patroni node with REST API access
$ patronictl -c /etc/patroni/patroni.yml switchover \
    --master pg01 \
    --candidate pg02 \
    --scheduled now

# Patroni will:
# 1. Stop new transactions on pg01
# 2. Wait for replication lag to reach 0
# 3. Stop pg01 cleanly
# 4. Promote pg02 via pg_promote()
# 5. Reconfigure pg01 + pg03 to follow pg02
# 6. Run pg_rewind on pg01 if needed
# 7. Update HAProxy/Service endpoints via Patroni REST callbacks
```

Use for planned maintenance (OS upgrade, kernel patching, PG minor upgrade). Zero data loss; downtime in seconds, not minutes.

### Recipe 6: Detect Patroni-vs-PG Disagreement

Sometimes Patroni says one node is leader but PG itself disagrees. Audit:

```bash
# Compare DCS state to PG state
patronictl -c /etc/patroni/patroni.yml list

# Expected output (healthy):
# +---------+--------+---------+--------+---------+-----+-----------+
# | Member  | Host   | Role    | State  | TL      | Lag | Pending   |
# +---------+--------+---------+--------+---------+-----+-----------+
# | pg01    | ...    | Leader  | runn.. | 7       |     |           |
# | pg02    | ...    | Replica | runn.. | 7       | 0   |           |
# | pg03    | ...    | Replica | runn.. | 7       | 0   |           |
# +---------+--------+---------+--------+---------+-----+-----------+

# On each PG node directly:
psql -c "SELECT pg_is_in_recovery();"
# Leader returns 'f', Replicas return 't'.

# If Patroni shows pg01 as Leader but pg_is_in_recovery() returns 't' on pg01:
# Disagreement. Patroni state and PG state diverged.
# Action: check Patroni logs, possibly run `patronictl reinit pg01`.
```

### Recipe 7: Witness Node for 2-Node Setup

If only 2 PG nodes available, add a small VM running ONLY etcd or Consul. Provides quorum without running PG.

```
# Witness host: small VM, 2 vCPU, 4 GB RAM
# Run only etcd, no PostgreSQL.
# DCS quorum = 3 (2 PG nodes + 1 witness)
# Survives loss of 1 PG node OR the witness, but not both.
```

Patroni reads from DCS. If pg01 + witness can talk but pg02 cannot reach DCS quorum, pg02 demotes itself. No split-brain.

### Recipe 8: Configure HAProxy for Read/Write Routing

```
# /etc/haproxy/haproxy.cfg
listen pg-primary
    bind *:5000
    option httpchk GET /primary       # Patroni REST API health check
    http-check expect status 200
    default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
    server pg01 10.0.0.11:5432 check port 8008
    server pg02 10.0.0.12:5432 check port 8008
    server pg03 10.0.0.13:5432 check port 8008

listen pg-replicas
    bind *:5001
    balance roundrobin
    option httpchk GET /replica
    http-check expect status 200
    default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
    server pg01 10.0.0.11:5432 check port 8008
    server pg02 10.0.0.12:5432 check port 8008
    server pg03 10.0.0.13:5432 check port 8008
```

Patroni's REST API at port 8008:
- `GET /primary` → 200 if this node is primary, else 503.
- `GET /replica` → 200 if this node is replica, else 503.
- `GET /sync` → 200 if this node is synchronous replica.

HAProxy routes app writes to whichever node responds 200 on `/primary` — automatically follows failover.

### Recipe 9: Quorum Sync Across Three AZs

Three nodes, one per AZ. Survive single-AZ loss without RPO > 0:

```
synchronous_standby_names = 'ANY 1 (pg-az-a, pg-az-b, pg-az-c)'
synchronous_commit = on
```

Primary commits only after receiving ack from any 1 of the 3 standbys. Single AZ outage = remaining 2 nodes maintain sync. Two simultaneous AZ outages = writes block (RPO=0 maintained, RTO suffers).

`FIRST 1 (...)` mode also works but is asymmetric — only the first-named standby satisfies sync. AZ ordering matters. Prefer `ANY` for symmetric multi-AZ.

### Recipe 10: Disable Failover for Planned Work

```bash
# Disable automatic failover before kernel upgrade on a replica:
patronictl -c /etc/patroni/patroni.yml pause

# Patroni stops monitoring — leader stays leader regardless.
# Do maintenance on replicas:
ssh pg02 'sudo apt upgrade -y && sudo reboot'

# After maintenance:
patronictl -c /etc/patroni/patroni.yml resume
```

`pause` mode prevents Patroni from promoting if the leader briefly disappears. Use during planned maintenance windows.

### Recipe 11: Migrate from repmgr to Patroni

Roughly:

1. Set up etcd cluster (3 nodes minimum) on separate hosts.
2. Install Patroni on each PG node.
3. Configure Patroni `patroni.yml` to point at existing PG cluster (use the existing data directory).
4. Stop `repmgrd` on all nodes.
5. Drop the `repmgr` schema/database (Patroni doesn't need it).
6. Start Patroni one node at a time, beginning with the existing primary (Patroni will recognize it as the leader and write that to DCS).
7. Verify with `patronictl list`.
8. Update HAProxy / service discovery to use Patroni REST API health checks instead of repmgr.

Zero downtime if done carefully. Test in staging first.

### Recipe 12: Failover-Slot Setup for HA Logical Replication (PG17+)

Logical subscribers can survive primary failover starting PG17:

```sql
-- On primary
ALTER SYSTEM SET synchronized_standby_slots = 'pg02_slot, pg03_slot';
SELECT pg_reload_conf();

-- Create logical slot with failover=true
SELECT pg_create_logical_replication_slot('my_sub_slot', 'pgoutput', false, true, true);
                                          --                                 ^      ^
                                          --                            failover  twophase

-- On each physical standby
ALTER SYSTEM SET sync_replication_slots = on;
ALTER SYSTEM SET hot_standby_feedback = on;
SELECT pg_reload_conf();
```

After failover, the new primary already has `my_sub_slot` synchronized via `pg_sync_replication_slots()`. Subscriber reconnects to the new primary with zero data loss. See [`75-replication-slots.md`](./75-replication-slots.md) Recipe 7 for full failover-slot setup.

### Recipe 13: DR Drill Procedure

HA is one-region tight-coupling. DR is cross-region. Quarterly drill suggested:

1. Take a base backup from prod primary to a DR-region object store.
2. Restore to a fresh DR-region cluster.
3. Verify schema + row counts match prod.
4. Simulate region failure: stop prod primary, document RTO.
5. Promote DR cluster as the new primary.
6. Repoint a canary application to DR.
7. Verify reads + writes.
8. Document failback procedure (rebuild old prod region as DR for new prod).

Full DR runbook lives in [`90-disaster-recovery.md`](./90-disaster-recovery.md).

## Gotchas

1. **PostgreSQL has no in-core failover.** Every HA setup uses an external cluster manager. Skipping the cluster manager → split-brain on first network event.

2. **Two-node clusters without a witness are unsafe.** Network partition → both nodes attempt to promote → split-brain. Add a third DCS node (witness only — no PG).

3. **DCS quorum on the same hosts as PG defeats DCS.** Run etcd/Consul on separate hosts or AZs from data nodes.

4. **`promote_trigger_file` removed in PG16.** Failover scripts that wrote a trigger file silently no-op on PG16+. Replace with `pg_ctl promote` or `pg_promote()`. Cross-reference [`77-standby-failover.md`](./77-standby-failover.md) gotcha #1.

5. **`synchronous_commit = remote_apply` blocks writes when sync standby is unreachable.** Without `synchronous_standby_names = ''` fallback OR a cluster manager that can demote/swap, all writes hang. Plan for sync-standby-down explicitly.

6. **`synchronous_standby_names = ''` (empty) is NOT "no sync standby."** It means "synchronous replication disabled." If you want sync replication to a single specific standby, name it explicitly. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) Gotcha #3.

7. **`pg_rewind` requires `wal_log_hints = on` OR `data_checksums = on`** at the time the divergence happened. Cannot enable retroactively. Bake into cluster bootstrap. Cross-reference [`77-standby-failover.md`](./77-standby-failover.md) Gotcha #5.

8. **Watchdog not configured → zombie primaries.** Kernel-level watchdog (Linux `softdog`) prevents a hung Patroni process from keeping the leader key forever. Required for production.

9. **HAProxy with TCP-level health checks doesn't detect primary/replica role.** Use Patroni REST API at port 8008 with HTTP health checks (`/primary`, `/replica`, `/sync`) for correct routing.

10. **`maximum_lag_on_failover` defaults to 1 MB in Patroni.** A standby more than 1 MB behind WON'T be promoted. On high-throughput clusters, raise to several MB to avoid "no eligible standby" failover failures.

11. **K8s pod restart latency is the floor for K8s operator RTO.** Even with aggressive probes, K8s scheduler + kubelet + image pull adds 10-20s minimum. Bare-metal Patroni typically faster.

12. **Replication slots survive failover, but failover slots are PG17+.** Pre-PG17, subscribers/standbys connecting via a slot must recreate the slot after primary failover, losing data in the gap. Use failover slots (PG17+) or accept the gap.

13. **DCS data drift.** etcd / Consul state can grow unbounded. Configure compaction. Monitor DCS health. Plan for DCS quorum loss recovery (worst case: rebuild cluster from `pg_basebackup`).

14. **CNPG redirects `/documentation/current/` → `/docs/<version>/`.** Cite versioned URLs (e.g., `cloudnative-pg.io/docs/1.29/`), not `/current/`. Same with all other tool docs — pin to a version.

15. **Stolon is unmaintained.** Last release September 2021, caps at PG15. Migrate existing deployments to Patroni or CloudNativePG.

16. **Crunchy PGO v6 vs v5 are incompatible CRDs.** Upgrading v5 → v6 requires migration. Plan accordingly.

17. **PG18 renumbered the HA chapter from 27 to 26.** Cite by major version (`docs/18/high-availability.html`), not chapter number.

18. **HA tools do NOT back up data.** They handle failover, not durability. You still need pgBackRest / Barman / WAL-G for PITR. See [`85-backup-tools.md`](./85-backup-tools.md).

19. **`pg_promote()` requires `pg_promote` predefined role or superuser on PG12+** [^pg-promote]. Cluster managers run as superuser-equivalent role; verify on bootstrap.

20. **HAProxy + connection pooler (pgBouncer) chain is two failover layers.** Configure both to fail over together. pgBouncer's `server_check_query` should detect primary role changes.

21. **Cross-region HA is NOT a thing.** Cross-region latency (typically 10-100ms) makes synchronous replication impractical. Cross-region = DR pattern with manual decision, not HA pattern with automatic failover.

22. **Logical replication is NOT a substitute for streaming replication for HA.** DDL not replicated, sequences not synced, conflicts block apply worker. Use streaming + cluster manager for HA. Logical replication is for cross-version migration, CDC, or selective table replication.

23. **PG14, PG15, PG16, PG17, PG18 all added HA-relevant features.** No version skips an HA item. Verify against verbatim release notes when claiming "this version supports X" rather than relying on planning-note hypotheses.

## See Also

- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical streaming setup, `synchronous_commit` levels, `synchronous_standby_names` syntaxes.
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication for cross-version + CDC, why NOT for HA.
- [`75-replication-slots.md`](./75-replication-slots.md) — slot mechanics, abandoned-slot disk fill, PG17 failover slots.
- [`76-logical-decoding.md`](./76-logical-decoding.md) — output-plugin author surface.
- [`77-standby-failover.md`](./77-standby-failover.md) — `pg_promote()`, hot standby query rules, `pg_rewind` mechanics.
- [`79-patroni.md`](./79-patroni.md) — Patroni configuration deep dive.
- [`80-connection-pooling.md`](./80-connection-pooling.md) — pgBouncer + HAProxy integration patterns.
- [`81-pgbouncer.md`](./81-pgbouncer.md) — pool-mode interactions with failover.
- [`82-monitoring.md`](./82-monitoring.md) — replication-lag alerting.
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — backup is orthogonal to HA.
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest/Barman/WAL-G capabilities.
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged former primary deep dive.
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — cross-region DR planning, RTO/RPO frameworks.
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — CNPG / Zalando / Crunchy operator deep dive.
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — what managed providers remove.

## Sources

[^pg-ha-chapter]: PostgreSQL 16 documentation, "Chapter 27. High Availability, Load Balancing, and Replication". https://www.postgresql.org/docs/16/high-availability.html — Names the in-core mechanisms (streaming replication, replication slots, hot standby) but does not include automatic failover. PG18 renumbered to chapter 26 at https://www.postgresql.org/docs/18/high-availability.html.

[^stolon]: Stolon GitHub repository: https://github.com/sorintlab/stolon — last release v0.17.0 published September 2021. Supported PostgreSQL versions cap at 15. No support for PG16/17/18.

[^patroni-watchdog]: Patroni documentation, "Patroni configuration". https://patroni.readthedocs.io/en/latest/patroni_configuration.html — Section on `watchdog.mode` describes `required` mode reboots the node via Linux `softdog` if Patroni hangs. The verbatim docs page is "Patroni configuration" at the URL above.

[^cnpg-failure-modes]: CloudNativePG documentation 1.29, "Failure Modes". https://cloudnative-pg.io/docs/1.29/failure_modes/ — Describes pod-level fencing via StatefulSet, K8s API as DCS, and Service endpoint reconfiguration.

[^patroni-config]: Patroni documentation, "Patroni configuration". https://patroni.readthedocs.io/en/latest/patroni_configuration.html — `ttl` defaults to 30 seconds, `loop_wait` defaults to 10 seconds.

[^repmgr]: repmgr documentation, version 5.5.0. https://repmgr.org/docs/current/index.html — Active project under EDB. Supports PG13–18.

[^cnpg]: CloudNativePG project: https://cloudnative-pg.io/ — Note: canonical domain is `cloudnative-pg.io` (with hyphen). The non-hyphenated `cloudnativepg.io` redirects. v1.29 stable at time of writing. CNCF incubated project.

[^zalando-pg-op]: Zalando postgres-operator. https://github.com/zalando/postgres-operator — Bundles Patroni internally. Supports PG13-17. v1.15.1 released December 2025.

[^crunchy-pgo]: Crunchy Data PGO (Postgres Operator). https://github.com/CrunchyData/postgres-operator — Now at v6.0.1 (Feb 2026). v5 documentation at https://access.crunchydata.com/documentation/postgres-operator/v5/.

[^sync-standby]: PostgreSQL 16 documentation, `synchronous_commit` GUC at https://www.postgresql.org/docs/16/runtime-config-wal.html — Verbatim: "When set to `remote_apply`, commits will wait until replies from the current synchronous standby(s) indicate they have received the commit record of the transaction and applied it, so that it has become visible to queries on the standby(s)." If no sync standby is available, writes block.

[^pg-rewind]: PostgreSQL 16 documentation, `pg_rewind` at https://www.postgresql.org/docs/16/app-pgrewind.html — Verbatim: "The target server must allow `wal_log_hints` to be enabled, or have `data_checksums` enabled." This is a prerequisite that cannot be enabled retroactively for past WAL.

[^pg-promote]: PostgreSQL 16 documentation, `pg_promote()` function in `functions-admin.html`. https://www.postgresql.org/docs/16/functions-admin.html — Verbatim: "By default, only superusers and members of the `pg_promote` role can call this function." Cluster managers must run as a role with this privilege.

### Tool documentation

- Patroni: https://patroni.readthedocs.io/en/latest/
- Patroni REST API: https://patroni.readthedocs.io/en/latest/rest_api.html
- Patroni dynamic configuration: https://patroni.readthedocs.io/en/latest/dynamic_configuration.html
- repmgr: https://www.repmgr.org/ and https://repmgr.org/docs/current/index.html
- pg_auto_failover: https://github.com/citusdata/pg_auto_failover
- Stolon (unmaintained): https://github.com/sorintlab/stolon
- CloudNativePG: https://cloudnative-pg.io/ and https://cloudnative-pg.io/docs/1.29/
- Zalando postgres-operator: https://github.com/zalando/postgres-operator
- Crunchy Data PGO: https://github.com/CrunchyData/postgres-operator and https://access.crunchydata.com/documentation/postgres-operator/v5/

### DCS documentation

- etcd: https://etcd.io/docs/
- Consul: https://developer.hashicorp.com/consul/docs/
- ZooKeeper: https://zookeeper.apache.org/doc/current/

### PG release-note primary sources

- PG14: https://www.postgresql.org/docs/release/14.0/
- PG15: https://www.postgresql.org/docs/release/15.0/
- PG16: https://www.postgresql.org/docs/release/16.0/
- PG17: https://www.postgresql.org/docs/release/17.0/
- PG18: https://www.postgresql.org/docs/release/18.0/

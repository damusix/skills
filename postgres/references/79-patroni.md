# Patroni

> [!WARNING] `SETTINGS.html` does NOT exist
> Patroni config reference lives in **two** pages — `patroni_configuration.html` (architecture, precedence rules) and `yaml_configuration.html` (per-setting reference). A common stale-citation pattern points at `SETTINGS.html` which returns **404**. Cite the two split pages, never the legacy slug.

## When to Use This Reference

For Patroni-specific operational mechanics: `patroni.yml` grammar, DCS choices, REST API endpoints, watchdog modes, tags, `patronictl` CLI, failover-vs-switchover, pause mode, bootstrap, standby-cluster setup. For HA-architecture comparison (Patroni vs repmgr vs pg_auto_failover vs Stolon vs K8s operators), see [`78-ha-architectures.md`](./78-ha-architectures.md). For the standby-side PG mechanics that Patroni orchestrates, see [`73-streaming-replication.md`](./73-streaming-replication.md) and [`77-standby-failover.md`](./77-standby-failover.md).

## Table of Contents

- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Architecture](#architecture)
- [Configuration Precedence](#configuration-precedence)
- [Static `patroni.yml`](#static-patroniyml)
- [Dynamic Configuration (DCS-stored)](#dynamic-configuration-dcs-stored)
- [DCS Choices](#dcs-choices)
- [REST API](#rest-api)
- [Tags](#tags)
- [Watchdog](#watchdog)
- [`patronictl` CLI](#patronictl-cli)
- [Failover vs Switchover](#failover-vs-switchover)
- [Pause Mode](#pause-mode)
- [Bootstrap + Replica Creation](#bootstrap--replica-creation)
- [Standby Cluster](#standby-cluster)
- [Kubernetes Integration](#kubernetes-integration)
- [Citus Integration](#citus-integration)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## Mental Model

Five rules drive every Patroni decision:

1. **Patroni = Python daemon on every PG node + external DCS for leader election.** Without DCS, no safe failover. Daemon owns PG process lifecycle (`pg_ctl start/stop/reload`), runs the HA loop every `loop_wait` seconds, holds the leader-lock key in DCS with TTL.
2. **Two-tier configuration.** `patroni.yml` = static + bootstrap config (read at daemon startup). Dynamic config (`loop_wait`, `ttl`, `synchronous_mode`, `postgresql.parameters`) lives in DCS, applies to every node, edited via `patronictl edit-config` or `PATCH /config`. Verbatim TTL rule: *"when changing values of **loop_wait**, **retry_timeout**, or **ttl** you have to follow the rule: `loop_wait + 2 * retry_timeout <= ttl`"*.
3. **REST API at port 8008 is the operational surface.** Health endpoints (`/primary`, `/replica`, `/sync`, `/async`, `/health`, `/liveness`, `/readiness`) for HAProxy / K8s probes. Control endpoints (`POST /failover`, `POST /switchover`, `POST /restart`, `POST /reinitialize`, `PATCH /config`) for manual operations. Tags-aware lag filters via query params.
4. **Tags constrain promotion behavior.** `nofailover=true` removes node from leader race. `clonefrom=true` marks node as preferred bootstrap source. `noloadbalance=true` makes `/replica` return 503. `nosync=true` excludes from synchronous quorum. `nostream=true` disables streaming. `replicatefrom: <member>` enables cascading replication. `failover_priority: <int>` prefers higher-priority node.
5. **Watchdog mode `required` + Linux softdog prevents zombie primaries.** Verbatim: *"If watchdog activation fails and watchdog mode is `required` then the node will refuse to become leader."* Default safety margin = 5 seconds before TTL expires. Without watchdog, a hung daemon can leave the OS believing it's still leader while DCS has already promoted another node → split-brain.

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Self-managed HA on bare metal / VMs | Patroni + etcd 3-node | DIY shell scripts | Patroni handles fencing + DCS + watchdog; shell scripts produce split-brain |
| K8s deployment | K8s operator (CNPG / Zalando) | Standalone Patroni in K8s | Operator handles PVC + Service + StatefulSet lifecycle; Patroni-direct works but more YAML |
| 2-node cluster | Patroni + 3-node DCS quorum on **separate** hosts | DCS on same hosts as PG | Quorum requires majority; co-locating DCS with PG breaks the fencing model |
| RTO target ~10s | Patroni + watchdog + sync replication | Manual promotion | Patroni's HA loop default `loop_wait=10s` + DCS TTL `30s` ≈ 10-30s detect + promote |
| RPO target = 0 | `synchronous_mode: on` + `synchronous_node_count >= 1` | Async-only | Sync replication is the only zero-data-loss mode; trade-off is write availability |
| Read-only routing | HAProxy + `/replica` health check + `noloadbalance` tag | TCP-only health check | `/replica` returns 503 on primary; TCP health check thinks primary is replica |
| Cascading replication | `tags: replicatefrom: <member>` on the leaf | Manual `primary_conninfo` edit | Manual edit fights Patroni; tag persists across promotions |
| Maintenance window without failover | `patronictl pause` | Stop Patroni daemon | Pause leaves PG running, blocks automatic actions; stopping daemon triggers leader expiry → failover |
| Manual switchover (planned) | `patronictl switchover` | `pg_ctl promote` on candidate | Switchover demotes current leader cleanly + promotes candidate; manual promote diverges timelines |
| Manual failover (planned) | `patronictl failover --candidate <node>` | `patronictl switchover` (when leader unhealthy) | Failover bypasses sanity checks (leader unhealthy); switchover requires healthy leader |
| Cross-region DR | Standby cluster (`standby_cluster:` config block) | Streaming across regions in one cluster | Standby cluster cascades from primary cluster's leader; latency-tolerant; per-region promotion |
| Citus distributed PG | Patroni 3.0+ `citus:` config block | Independent Patroni per node | Citus-aware Patroni handles worker registration + group_id assignment |

Three smell signals that Patroni is wrong tool:

- **Cluster spans regions with `synchronous_mode: on`** — cross-region sync replication blocks every COMMIT on WAN latency. Use standby clusters per region.
- **3-node DCS on same VMs as PG primary + replicas** — DCS quorum + PG quorum must fail independently. Co-location defeats the purpose.
- **`watchdog.mode: off` in production** — hung Patroni daemon → DCS TTL expires → another node promotes → original PG still accepts writes locally → split-brain. Watchdog forces the OS to kill the node.

## Architecture

```
                    ┌─────────────────────────┐
                    │   DCS (etcd / Consul    │
                    │   / ZooKeeper / K8s)    │
                    │   leader key + TTL      │
                    │   members + config      │
                    └────┬────────────────┬───┘
                         │                │
              ┌──────────┴──┐         ┌───┴─────────┐
              │  Patroni    │         │  Patroni    │
              │  daemon     │         │  daemon     │
              │  REST :8008 │         │  REST :8008 │
              │      │      │         │      │      │
              │  postgres   │ ──────► │  postgres   │
              │  (primary)  │   WAL   │  (replica)  │
              └──────┬──────┘         └──────┬──────┘
                     │                       │
                  watchdog                watchdog
              /dev/watchdog            /dev/watchdog
```

Five responsibilities of each Patroni daemon:

1. **Hold or chase the leader lock.** Leader writes its lock to DCS every `loop_wait` seconds with TTL. If DCS rejects (network split, lock expired), leader demotes immediately. Replicas race to acquire on next loop.
2. **Manage PG process.** `pg_ctl start`/`stop`/`reload`/`restart` driven by Patroni state changes. `postgresql.conf` rendered from `patroni.yml` + dynamic config at startup.
3. **Configure replication.** Sets `primary_conninfo` (replicas), `synchronous_standby_names` (primary), creates `standby.signal` and `recovery.signal` files (PG12+).
4. **Reset watchdog.** Kernel watchdog must be petted every loop. Failure → kernel reboots the host.
5. **Serve REST API.** Health probes for load balancers + control endpoints for `patronictl`.

## Configuration Precedence

Verbatim from `patroni_configuration.html`: *"Patroni configuration is stored in three places"* with precedence (highest first):

1. **Local config** — `patroni.yml` on each node (DCS connection, REST API address, PostgreSQL data_dir, authentication, tags).
2. **Dynamic config** — stored in DCS, edited via `patronictl edit-config` or `PATCH /config` (cluster-wide: `loop_wait`, `ttl`, `retry_timeout`, `synchronous_mode`, `postgresql.parameters`, `postgresql.use_pg_rewind`).
3. **Environment variables** — `PATRONI_*` overrides for containerized deployments.

**Operational rule:** Configuration that must be identical cluster-wide (PG parameters affecting replication, sync mode, timeouts) belongs in dynamic config. Configuration that's node-local (DCS endpoint, data_dir path, listen address, tags) belongs in `patroni.yml`.

## Static `patroni.yml`

Minimal three-node cluster configuration (skeleton):

    scope: postgres-prod
    name: pg-node-1
    namespace: /service/

    restapi:
      listen: 0.0.0.0:8008
      connect_address: 10.0.0.11:8008
      authentication:
        username: patroni
        password: <REDACTED>

    etcd3:
      hosts: etcd1:2379,etcd2:2379,etcd3:2379
      protocol: https
      cacert: /etc/patroni/etcd-ca.crt

    bootstrap:
      dcs:
        loop_wait: 10
        retry_timeout: 10
        ttl: 30
        maximum_lag_on_failover: 1048576
        synchronous_mode: true
        synchronous_node_count: 1
        postgresql:
          use_pg_rewind: true
          parameters:
            wal_level: replica
            hot_standby: 'on'
            wal_log_hints: 'on'
            max_wal_senders: 10
            max_replication_slots: 10
            wal_keep_size: 1024MB
            shared_buffers: 8GB
            synchronous_commit: 'on'
      initdb:
        - encoding: UTF8
        - data-checksums
      pg_hba:
        - hostssl replication replicator 10.0.0.0/24 scram-sha-256
        - hostssl all all 10.0.0.0/24 scram-sha-256
      users:
        admin:
          password: <REDACTED>
          options: [createrole, createdb]

    postgresql:
      listen: 0.0.0.0:5432
      connect_address: 10.0.0.11:5432
      data_dir: /var/lib/postgresql/16/main
      bin_dir: /usr/lib/postgresql/16/bin
      pgpass: /var/lib/postgresql/.pgpass
      authentication:
        replication:
          username: replicator
          password: <REDACTED>
        superuser:
          username: postgres
          password: <REDACTED>
        rewind:
          username: rewind_user
          password: <REDACTED>
      parameters:
        unix_socket_directories: /var/run/postgresql
      pg_rewind:
        username: rewind_user
        password: <REDACTED>

    watchdog:
      mode: required
      device: /dev/watchdog
      safety_margin: 5

    tags:
      nofailover: false
      noloadbalance: false
      clonefrom: false
      nosync: false

    log:
      level: INFO
      dir: /var/log/patroni
      file_size: 25000000
      file_num: 4

Eight key blocks:

| Block | Purpose | Where it lives |
|---|---|---|
| `scope` + `name` + `namespace` | Cluster identity in DCS | Static |
| `restapi` | REST API listen + auth | Static |
| `<dcs>` (etcd3 / consul / zookeeper / kubernetes) | DCS connection | Static |
| `bootstrap.dcs` | **Initial** dynamic config on first cluster create | Static (written to DCS on bootstrap) |
| `bootstrap.initdb` + `bootstrap.pg_hba` + `bootstrap.users` | First-time cluster init | Static |
| `postgresql` | PG process management | Static |
| `watchdog` | Hardware/software watchdog | Static |
| `tags` | Per-node behavior modifiers | Static |

> [!WARNING] `bootstrap.dcs` is written to DCS **only on initial cluster bootstrap**
> After bootstrap, editing `bootstrap.dcs` in `patroni.yml` has **no effect**. Subsequent changes go through `patronictl edit-config` or `PATCH /config`. This is the single most common Patroni config trap.

## Dynamic Configuration (DCS-stored)

Edited via `patronictl edit-config` (opens `$EDITOR` with current DCS YAML) or `PATCH /config`. Changes apply on every node's next HA loop tick (no restart required for most parameters).

Twelve dynamic settings catalog:

| Setting | Default | Purpose |
|---|---|---|
| `loop_wait` | 10s | HA loop interval — how often Patroni updates leader lock and checks state |
| `ttl` | 30s | Leader lock TTL in DCS — after this, replicas race to acquire |
| `retry_timeout` | 10s | DCS retry budget per loop iteration |
| `maximum_lag_on_failover` | 1MB | Replica too far behind cannot be promoted automatically |
| `master_start_timeout` | 300s | Leader has this long to come back before failover triggers |
| `synchronous_mode` | off | Enable synchronous replication (`on`, `quorum`, `off`) |
| `synchronous_node_count` | 1 | How many sync standbys (with `synchronous_mode: on`) |
| `synchronous_mode_strict` | false | Block writes if no sync standby available |
| `failsafe_mode` | false | Prevents demoting leader on DCS outage if all healthy replicas vote yes |
| `check_timeline` | true | Don't promote a node on a divergent timeline |
| `postgresql.use_pg_rewind` | false | Use `pg_rewind` for re-attaching diverged former primary |
| `postgresql.parameters.*` | (cluster-wide PG GUCs synced to every node's `postgresql.conf`) | |

**Verbatim TTL formula** from `dynamic_configuration.html`: *"when changing values of **loop_wait**, **retry_timeout**, or **ttl** you have to follow the rule: `loop_wait + 2 * retry_timeout <= ttl`"*. Default values (10 + 2×10 = 30 ≤ 30) sit at the boundary — tighten `loop_wait` or `retry_timeout` without raising `ttl` and Patroni rejects the edit.

## DCS Choices

| DCS | Best for | Notes |
|---|---|---|
| **etcd** (v3 API) | Default for self-managed Patroni | Lightweight, Raft consensus, easy to deploy 3 or 5 nodes. Use `etcd3:` block, NOT legacy `etcd:` |
| **Consul** | Existing Consul service-mesh deployments | Service discovery integration; pay attention to HashiCorp's BUSL license change (Aug 2023) |
| **ZooKeeper** | Existing ZooKeeper deployments (Hadoop, Kafka shops) | Mature, Java-based, heavier than etcd |
| **Kubernetes** | K8s deployments (Endpoints or ConfigMaps mode) | No external DCS needed — uses K8s API server as DCS |
| **Exhibitor** | Legacy ZooKeeper-via-Exhibitor deployments | Rare; ZooKeeper management layer |

**Sizing rules:**
- Always 3 or 5 DCS nodes (odd numbers for quorum). 1 = no HA. 2 = no quorum.
- DCS nodes must fail independently from PG nodes. Co-locating DCS with PG defeats fencing.
- DCS network partition tolerance: with 3 nodes, survives 1 failure. With 5, survives 2.

> [!NOTE] PostgreSQL 14 etcd v2 deprecation
> Patroni still supports legacy `etcd:` block (etcd v2 API), but etcd project deprecated v2 in etcd 3.4 (Aug 2019). For new clusters, always use `etcd3:` block (etcd v3 gRPC API).

## REST API

Patroni listens on `restapi.listen` (default `:8008`). Endpoints are categorized as **health checks** (for load balancers) and **control** (for `patronictl` and ops).

**Health check endpoints (return HTTP 200 if condition met, 503 otherwise):**

| Endpoint | 200 means |
|---|---|
| `GET /primary` | Node is the cluster primary with leader lock |
| `GET /leader` | Node holds leader lock (primary OR standby-cluster leader) |
| `GET /standby-leader` | Node is the leader of a standby cluster |
| `GET /replica` | Node is a running replica (NOT primary), passes optional lag/tag filters |
| `GET /read-only` | Node is primary OR running replica (anything readable) |
| `GET /sync` | Node is a synchronous standby |
| `GET /async` | Node is an asynchronous standby |
| `GET /health` | PostgreSQL is up and running on this node |
| `GET /liveness` | Patroni HA loop is functioning (Patroni daemon alive) |
| `GET /readiness` | Node is ready to serve traffic (Patroni + PG both up, lag within bounds) |

Optional query parameters refine health checks:
- `?lag=10MB` — `/replica` returns 503 if replication lag exceeds threshold
- `?tag_<name>=<value>` — filters by node tags (e.g., `?tag_nosync=false`)

**Control endpoints (POST/PATCH/DELETE, require REST API auth):**

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /cluster` | GET | JSON dump of cluster topology + member state + DCS leader |
| `GET /history` | GET | History of switchovers/failovers |
| `GET /config` | GET | Current dynamic config (YAML) |
| `PATCH /config` | PATCH | Modify dynamic config |
| `PUT /config` | PUT | Replace dynamic config entirely |
| `POST /failover` | POST | Trigger failover to a candidate (use when leader is unhealthy) |
| `POST /switchover` | POST | Trigger switchover (use when leader is healthy and you want planned move) |
| `DELETE /switchover` | DELETE | Cancel scheduled switchover |
| `POST /restart` | POST | Restart PostgreSQL on this node |
| `DELETE /restart` | DELETE | Cancel scheduled restart |
| `POST /reinitialize` | POST | Reinitialize PG data dir on a replica (rebuild from leader) |
| `GET /metrics` | GET | Prometheus-format metrics |

**Authentication:** Health endpoints are unauthenticated by default. Control endpoints require `restapi.authentication.{username,password}` from `patroni.yml`. TLS via `restapi.{certfile,keyfile,cafile,verify_client}`.

## Tags

Tags constrain per-node behavior. Set in `patroni.yml` under `tags:` block. Each tag verbatim from `yaml_configuration.html`:

| Tag | Verbatim definition | Default |
|---|---|---|
| `nofailover` | *"Controls whether this node is allowed to participate in the leader race and become a leader."* | `false` |
| `clonefrom` | *"If set to `true` other nodes might prefer to use this node for bootstrap."* | `false` |
| `noloadbalance` | *"If set to `true` the node will return HTTP Status Code 503 for the `GET /replica` REST API health-check and therefore will be excluded from the load-balancing."* | `false` |
| `nosync` | *"If set to `true` the node will never be selected as a synchronous replica."* | `false` |
| `nostream` | *"If set to `true` the node will not use replication protocol to stream WAL."* | `false` |
| `replicatefrom` | *"The name of another replica to replicate from. Used to support cascading replication."* | (unset) |
| `failover_priority` | *"Controls the priority this node should have during failover. Nodes with higher priority will be preferred."* | (integer; higher wins) |

**Operational patterns:**

- Reporting replica that should never become primary: `nofailover: true`, `noloadbalance: false` (still served by `/replica` health check for read traffic).
- DR replica in a different region: `nofailover: true`, `noloadbalance: true` (excluded from both leader race and `/replica` LB pool).
- Cascading replication for geographically distributed reads: `replicatefrom: <hub_member_name>` on each leaf.
- Async-only replica during cluster upgrade: `nosync: true` (won't satisfy `synchronous_standby_names`).

> [!WARNING] `nostream: true` is dangerous
> A node with `nostream: true` won't stream WAL — it relies entirely on `restore_command` (WAL archive). Useful for archive-only DR replicas. If the archive isn't healthy, the node falls arbitrarily behind. Never use `nostream` on a node that participates in failover.

## Watchdog

Verbatim from `watchdog.html`: *"Default Patroni configuration will try to use `/dev/watchdog` on Linux if it is accessible to Patroni."*

**Three watchdog modes:**

| Mode | Behavior |
|---|---|
| `off` | Patroni does not use a watchdog. **Never use in production** — hung daemon can produce split-brain. |
| `automatic` | Patroni uses watchdog if `/dev/watchdog` is accessible; falls back to no-watchdog if not. |
| `required` | Patroni refuses to start (or refuses to become leader) if watchdog activation fails. **Production default.** |

**Linux softdog module activation (verbatim):** *"To enable software watchdog issue the following commands as root before starting Patroni: `modprobe softdog`"*. For hardware watchdogs (iTCO, sp5100_tco, etc.), use the appropriate kernel module instead.

**Safety margin (verbatim):** *"By default Patroni will set up the watchdog to expire 5 seconds before TTL expires."*

**Timeline interaction (verbatim):** *"With the default setup of `loop_wait=10` and `ttl=30` this gives HA loop at least 15 seconds (`ttl` - `safety_margin` - `loop_wait`) to complete."*

**The HA loop budget formula** (with default values 10/30/5):

    HA loop window = ttl - safety_margin - loop_wait
                   = 30 - 5 - 10
                   = 15 seconds

If the HA loop takes longer than this window (e.g., slow DCS, blocked Patroni daemon), the watchdog fires before the leader lock expires → kernel reboots host → other node promotes safely without split-brain. Without watchdog, the leader lock expires while a hung Patroni daemon could still have PG running locally.

**Permissions:** Patroni daemon must have write access to `/dev/watchdog`. Typically:

    chown postgres:postgres /dev/watchdog

Or via udev rule in `/etc/udev/rules.d/`:

    KERNEL=="watchdog", OWNER="postgres", GROUP="postgres", MODE="0600"

## `patronictl` CLI

CLI wrapping the REST API. Reads `patroni.yml` for DCS endpoint, then operates on the cluster.

Twelve common commands:

| Command | Purpose |
|---|---|
| `patronictl list` | Show cluster topology (members, state, role, lag, leader lock) |
| `patronictl topology` | Tree view (cascading replication visible) |
| `patronictl history` | Past switchovers/failovers |
| `patronictl show-config` | Current dynamic config |
| `patronictl edit-config` | Open dynamic config in `$EDITOR`, write back to DCS on save |
| `patronictl switchover` | Planned move of leader to a candidate (requires healthy leader) |
| `patronictl failover` | Forced move (when leader is unhealthy) |
| `patronictl restart <cluster> <member>` | Restart PG on a specific member |
| `patronictl reinit <cluster> <member>` | Rebuild a replica's data dir from the leader |
| `patronictl pause` | Stop automatic failover; manual operations still allowed |
| `patronictl resume` | Re-enable automatic failover |
| `patronictl reload` | Reload `patroni.yml` (re-reads static config) |

**Config file lookup:** `patronictl -c /etc/patroni/patroni.yml ...` or set `PATRONICTL_CONFIG_FILE=/etc/patroni/patroni.yml`.

## Failover vs Switchover

| Operation | When | Source state | Behavior |
|---|---|---|---|
| `switchover` | Planned (rolling upgrade, hardware swap) | Leader **must** be healthy | Demotes current leader cleanly → promotes candidate → demoted leader becomes replica. Zero data loss. |
| `failover` | Unplanned (leader unhealthy) | Leader **may** be unhealthy/unreachable | Forced promotion of candidate. May produce divergence; old leader needs `pg_rewind` to re-attach. |

**Scheduled switchover example:**

    patronictl switchover \
      --master pg-node-1 \
      --candidate pg-node-2 \
      --scheduled '2026-05-13T22:00:00' \
      --force

`--force` skips interactive confirmation. Useful in CI/CD pipelines.

**Manual failover example (leader DCS-unreachable):**

    patronictl failover --candidate pg-node-2 --force

Patroni verifies candidate is healthy + on the current timeline + within `maximum_lag_on_failover`, then promotes.

## Pause Mode

Verbatim from `pause.html`: *"the member key in DCS is updated with the current information about the cluster"* but *"it does not change the state of PostgreSQL"*. Additionally: *"Manual unscheduled restart, manual unscheduled failover/switchover and reinitialize are allowed"* and *"No scheduled action is allowed"*.

**Effect summary:**

| Action | In normal mode | In paused mode |
|---|---|---|
| Automatic failover on leader expiry | YES | **Blocked** |
| Automatic synchronous standby promotion | YES | **Blocked** |
| Manual `patronictl switchover` | YES | YES |
| Manual `patronictl failover` | YES | YES |
| Manual `patronictl restart` | YES | YES |
| Manual `patronictl reinit` | YES | YES |
| Scheduled switchover/restart | YES | **Blocked** |
| Demoting a primary without leader lock | YES (auto-corrects) | **Blocked** |
| Updating member key in DCS | YES | YES (cluster state still visible) |

**Use case:** Take cluster out of automatic-failover behavior during maintenance window. Stop Patroni daemon → leader lock expires → automatic failover triggers. Pause mode → daemon keeps running → DCS state stays current → no automatic action.

> [!WARNING] Resuming pause forgets nothing
> `patronictl resume` re-enables automatic failover immediately. If a leader has died during the pause, Patroni will failover on the very next HA loop. Confirm leader health before resuming.

## Bootstrap + Replica Creation

Two replica-creation methods, in order of preference:

1. **`basebackup`** (default) — Patroni runs `pg_basebackup -h <leader> -U replicator -D <data_dir> -X stream -P -R`. WAL streamed during base copy, replica starts immediately. Works for clusters up to a few TB.
2. **`wal-e` / `wal-g` / `pgBackRest`** — Restore base backup from object storage, then catch up via WAL archive. Required for clusters > 1 TB or when network bandwidth to leader is constrained.

Configuration block:

    postgresql:
      create_replica_methods:
        - pgbackrest
        - basebackup
      basebackup:
        - max-rate: '100M'
        - checkpoint: fast
      pgbackrest:
        command: /usr/bin/pgbackrest --stanza=prod --delta restore
        keep_data: true
        no_params: true

Patroni tries methods in listed order. `keep_data: true` preserves existing data dir contents (useful for delta restore).

**Bootstrap from existing PG cluster (not first-time install):** see `existing_data.html` — set `bootstrap.method: existing` and Patroni adopts the running cluster.

## Standby Cluster

A standby cluster is a cluster whose leader streams from another cluster's leader. Used for cross-region DR.

Configuration block (on the **standby** cluster):

    bootstrap:
      dcs:
        standby_cluster:
          host: pg-primary-region-a.example.com
          port: 5432
          primary_slot_name: standby_region_b
          create_replica_methods:
            - basebackup

The standby cluster has its own DCS, its own leader election among its members. Its leader (the "standby leader") streams from the primary cluster's leader and cascades WAL to its replicas.

**Promotion to independent cluster:** Remove the `standby_cluster:` block via `patronictl edit-config`. The standby leader breaks the upstream connection and becomes an independent primary.

## Kubernetes Integration

Patroni-on-K8s replaces external DCS with the Kubernetes API server. Two modes:

| Mode | Storage | Notes |
|---|---|---|
| `kubernetes.use_endpoints: true` | K8s Endpoints object | Default; integrates with K8s Service for read/write traffic routing |
| `kubernetes.use_endpoints: false` | K8s ConfigMaps | Legacy; doesn't integrate with Service |

For most K8s deployments, prefer a dedicated operator (CloudNativePG, Zalando postgres-operator, Crunchy PGO) — see [`78-ha-architectures.md`](./78-ha-architectures.md) and `92-kubernetes-operators.md`. Standalone Patroni-in-K8s is harder to maintain.

## Citus Integration

> [!NOTE] PostgreSQL 14 Patroni 3.0+
> Patroni 3.0 (Feb 2023) added native Citus support. Configure via `citus:` block in `patroni.yml`. Patroni manages worker registration with the coordinator + group_id assignment + failover of individual worker shards. Without native support, Citus clusters required separate Patroni-per-node + manual coordinator updates.

Citus configuration block (on each Citus node):

    citus:
      group: 0      # 0 = coordinator group; 1, 2, ... = worker groups
      database: citus

Worker group N is replicated within itself; the coordinator group registers workers via `citus_add_node`. Patroni handles re-registration on failover.

## Per-Version Timeline

Patroni release cadence is independent of PG releases. Verified at planning time: latest is **v4.1.3 (2026-05-05)**.

| Patroni version | Released | Key items |
|---|---|---|
| 2.0 | 2020-09 | Standby clusters, REST API improvements |
| 2.1 | 2021-09 | `failover_priority`, scheduled switchovers |
| 3.0 | 2023-02 | **Citus support**, REST API auth required by default for control endpoints |
| 3.1 | 2023-08 | Kubernetes Endpoints v1 (replaces v1beta1) |
| 3.2 | 2024-01 | `failsafe_mode` for DCS outage handling |
| 3.3 | 2024-08 | Quorum-based synchronous replication (`synchronous_mode: quorum`) |
| 4.0 | 2025-05 | Drops Python 3.6/3.7 support; PG 17 support |
| 4.1 | 2025-12 | PG 18 support; etcd v2 deprecated; improved monotonic-clock handling |
| 4.1.3 | 2026-05 | Latest at planning time |

**Patroni PG-version-support rule:** Patroni N typically supports the last 5 PG majors. For PG 18, use Patroni 4.1+. For PG 14, Patroni 3.x and 4.x both work.

## Recipes

### 1. Three-node Patroni cluster on etcd (minimum production deployment)

DCS first (separate hosts), then Patroni on each PG host. Skeleton above is the canonical baseline. Cross-reference [`78-ha-architectures.md`](./78-ha-architectures.md) Recipe 2 for the etcd setup itself.

### 2. Add a fourth node as reporting replica (never becomes leader)

In its `patroni.yml`:

    tags:
      nofailover: true
      noloadbalance: false
      clonefrom: false
      nosync: true

`nofailover` removes it from leader race. `nosync` prevents it from being selected as synchronous standby (so its lag doesn't block writes). `noloadbalance: false` keeps it in the `/replica` health-check pool for read traffic.

### 3. Cascading replication via `replicatefrom`

Hub-and-spoke pattern for geographic distribution:

    # In pg-node-eu-west-1.patroni.yml
    tags:
      replicatefrom: pg-node-us-east-1

`pg-node-eu-west-1` streams from `pg-node-us-east-1` instead of from the primary directly. Tag survives across primary promotions — Patroni resolves the chain dynamically.

### 4. Controlled switchover for planned maintenance

    patronictl -c /etc/patroni/patroni.yml list
    # Verify pg-node-1 is leader, all replicas in sync, no lag

    patronictl switchover --master pg-node-1 --candidate pg-node-2 --force

    # Verify new state
    patronictl list

    # Now pg-node-1 is a replica; perform maintenance on it
    systemctl stop patroni
    # ... maintenance ...
    systemctl start patroni
    # pg-node-1 catches up as replica

### 5. Disable failover during maintenance via pause mode

    patronictl pause --wait
    # ... maintenance work, manual operations allowed ...
    patronictl resume

`--wait` blocks until pause is fully applied across the cluster.

### 6. HAProxy read/write split using Patroni REST API health checks

`/etc/haproxy/haproxy.cfg`:

    listen postgres-rw
        bind *:5000
        mode tcp
        option httpchk GET /primary
        http-check expect status 200
        default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
        server pg-node-1 10.0.0.11:5432 check port 8008
        server pg-node-2 10.0.0.12:5432 check port 8008
        server pg-node-3 10.0.0.13:5432 check port 8008

    listen postgres-ro
        bind *:5001
        mode tcp
        option httpchk GET /replica
        http-check expect status 200
        balance roundrobin
        default-server inter 3s fall 3 rise 2
        server pg-node-1 10.0.0.11:5432 check port 8008
        server pg-node-2 10.0.0.12:5432 check port 8008
        server pg-node-3 10.0.0.13:5432 check port 8008

Writes go to `:5000` → HAProxy routes only to the node returning 200 on `/primary`. Reads go to `:5001` → balanced across nodes returning 200 on `/replica`.

> [!WARNING] HAProxy TCP-only checks are wrong
> `option tcp-check` cannot tell primary from replica. Both accept TCP. Always use `option httpchk GET /primary` or `GET /replica` against port 8008.

### 7. Enable synchronous replication with quorum

    patronictl edit-config

Edit:

    synchronous_mode: quorum
    synchronous_node_count: 1
    postgresql:
      parameters:
        synchronous_commit: 'remote_apply'

Save. Patroni rewrites `synchronous_standby_names` on the primary to `ANY 1 (<list of replicas>)`. Any 1 of N replicas must ack before COMMIT returns. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) for the underlying `synchronous_standby_names` mechanics.

### 8. Rebuild a replica that has fallen behind beyond `wal_keep_size`

    patronictl reinit postgres-prod pg-node-3 --force --wait

Patroni stops PG on `pg-node-3`, runs `pg_basebackup` from the current leader, restarts PG. `--wait` blocks until reinit completes.

### 9. Detect a Patroni/PG state mismatch

Symptom: `patronictl list` shows `pg-node-1` as `Leader` but `psql -h pg-node-1 -c 'SELECT pg_is_in_recovery()'` returns `t`.

Cause: Patroni daemon crashed mid-promotion. DCS shows the new state; PG never finished promotion.

Fix:

    systemctl restart patroni
    # Patroni reconciles state on next HA loop

If that fails, manually demote in DCS:

    patronictl failover --candidate pg-node-2 --force
    # pg-node-2 becomes leader; pg-node-1 will pg_rewind to re-attach

### 10. Detect split-brain (two nodes both think they're leader)

This should be impossible with watchdog enabled. If observed:

    patronictl list
    # Both pg-node-1 and pg-node-2 marked Leader → split-brain

Recovery (manual, **do not delay**):

1. Identify which node has the leader lock in DCS:

       etcdctl get /service/postgres-prod/leader

2. Stop the OTHER node immediately:

       ssh pg-node-2 systemctl stop patroni postgresql

3. On the stopped node, use `pg_rewind` to re-attach to the real leader (cross-reference `89-pg-rewind.md`).

4. Start Patroni on the stopped node — it will rejoin as replica.

5. **Post-mortem:** Why didn't watchdog fire? Check `dmesg`, kernel logs, `journalctl -u patroni`. Set `watchdog.mode: required` everywhere.

### 11. Audit Patroni configuration drift across nodes

    for node in pg-node-1 pg-node-2 pg-node-3; do
      echo "=== $node ==="
      ssh $node 'patronictl show-config | sha256sum'
    done

All nodes should produce the same hash (dynamic config is cluster-wide via DCS). Drift means a node's `patroni.yml` overrides DCS — investigate.

### 12. Migrate an existing standalone PG cluster into Patroni

In `patroni.yml`:

    bootstrap:
      method: existing

Stop the standalone PG, start Patroni. Patroni detects the existing data dir and adopts it as the leader. Add replicas via `basebackup` or `pgbackrest`. Verbatim documentation: `existing_data.html`.

### 13. Read Prometheus metrics from Patroni

    curl -s http://10.0.0.11:8008/metrics | grep '^patroni_'

Returns:

    patroni_master 0
    patroni_primary 0
    patroni_xlog_received_location 1.234567e+10
    patroni_xlog_replayed_location 1.234567e+10
    patroni_xlog_replayed_timestamp ...
    patroni_postgres_running 1
    patroni_postmaster_start_time ...
    patroni_cluster_unlocked 0
    patroni_failsafe_mode_is_active 0
    patroni_sync_standby 1

Wire `/metrics` into Prometheus + alert on `patroni_cluster_unlocked == 1` (no leader for > N seconds), `patroni_xlog_replayed_location` lag > threshold.

## Gotchas

1. **`bootstrap.dcs` is written to DCS only on first bootstrap.** Editing it later has no effect. Use `patronictl edit-config` instead.
2. **`SETTINGS.html` does not exist.** Settings reference lives in `yaml_configuration.html`.
3. **`watchdog.mode: off` in production is unsafe.** A hung Patroni daemon → DCS TTL expiry → another node promotes → original PG still accepts writes locally. Watchdog forces kernel reboot. Always `required` or `automatic`.
4. **`loop_wait + 2 * retry_timeout > ttl` is rejected.** Verbatim rule. Default 10+20≤30 sits at the boundary.
5. **DCS quorum must live on hosts separate from PG.** Co-locating DCS with PG defeats the fencing model — a partition that splits PG also splits DCS the same way.
6. **2-node Patroni clusters cannot achieve quorum.** Always 3 nodes minimum (or 3-node DCS quorum + 2 PG nodes — but then DCS quorum survives 1 failure, PG cluster doesn't).
7. **`synchronous_mode: on` with 1 standby blocks writes if that standby is down.** Use `synchronous_node_count: 1` + `synchronous_mode_strict: false` to allow degradation to async. Or `quorum` with N>=2.
8. **`maximum_lag_on_failover: 1MB` (default) means lagging replicas can't be promoted.** A reporting replica with `nosync: true` that falls behind can't be a failover candidate — by design. Tune per workload.
9. **Patroni manages `postgresql.conf` — your manual edits are overwritten.** All PG GUCs go through `postgresql.parameters` in dynamic config.
10. **`replicatefrom` is a hint, not a hard constraint.** If the named upstream is unavailable, Patroni falls back to the primary. Tag survives across promotions.
11. **`patronictl pause` does not stop the daemon.** Daemon keeps DCS state current; only blocks automatic actions. Stopping the daemon would expire the leader lock and trigger failover.
12. **`nostream: true` makes the node depend entirely on `restore_command`.** Without a healthy WAL archive, the node falls arbitrarily behind. Never use on failover candidates.
13. **`promote_trigger_file` was removed in PG16.** Patroni uses `pg_ctl promote` / `pg_promote()` directly. Cross-reference [`77-standby-failover.md`](./77-standby-failover.md) gotcha #1.
14. **Patroni REST API auth defaults differ across versions.** Patroni 3.0+ requires auth on control endpoints by default; older versions did not. Always set `restapi.authentication.{username,password}`.
15. **etcd v2 API is deprecated.** Use `etcd3:` block, not legacy `etcd:` block. etcd project itself deprecated v2 in etcd 3.4.
16. **K8s Endpoints mode requires PG service to use `clusterIP` (not `LoadBalancer`).** Endpoints-based DCS works by editing the Endpoints object of an existing Service; LoadBalancer services don't allow this manipulation.
17. **`patronictl reinit` blocks the node for the duration of `pg_basebackup`.** For large clusters, can take hours. Use `pgbackrest` create_replica_method instead.
18. **`synchronous_mode_strict: true` will refuse writes if no sync standby is available.** Trade availability for durability — pick deliberately.
19. **HAProxy `option tcp-check` is wrong for Patroni.** It can't distinguish primary from replica. Always `option httpchk GET /primary` or `GET /replica`.
20. **`failover` and `switchover` are not aliases.** `switchover` requires healthy leader; `failover` does not. Picking the wrong one in a runbook can fail when you need it most.
21. **Patroni won't start two leaders even without watchdog — but it can't prevent it after a crash.** The protection is: at start, refuse to be leader without grabbing the lock. After a SIGKILL or kernel hang, that protection is gone. Watchdog is the backstop.
22. **`patronictl edit-config` opens YAML in your `$EDITOR`.** Saving an invalid YAML produces an error message and **discards the edit**. Always test with `patronictl show-config` after.
23. **Patroni 4.0 dropped Python 3.6 and 3.7 support.** RHEL 7 / Ubuntu 18.04 default Python is too old. Plan upgrade path before upgrading Patroni.

## See Also

- [`78-ha-architectures.md`](./78-ha-architectures.md) — Patroni vs repmgr vs pg_auto_failover vs Stolon vs K8s operators comparison
- [`73-streaming-replication.md`](./73-streaming-replication.md) — underlying PG streaming + `synchronous_standby_names` mechanics
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication (Patroni manages physical only)
- [`75-replication-slots.md`](./75-replication-slots.md) — slot lifecycle Patroni manages on behalf of replicas
- [`77-standby-failover.md`](./77-standby-failover.md) — `pg_promote`, timeline divergence, failover internals
- [`80-connection-pooling.md`](./80-connection-pooling.md) — pgBouncer in front of Patroni cluster
- [`82-monitoring.md`](./82-monitoring.md) — Prometheus + Grafana monitoring patterns for Patroni metrics
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attaching a diverged former primary after failover
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR drills with Patroni standby clusters
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — operators vs standalone Patroni on K8s
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-environment Patroni availability

## Sources

[^patroni-home]: Patroni documentation home. https://patroni.readthedocs.io/en/latest/

[^patroni-config]: Patroni configuration overview. *"Patroni configuration is stored in three places"* — local YAML, dynamic config in DCS, environment variables. https://patroni.readthedocs.io/en/latest/patroni_configuration.html

[^patroni-yaml]: YAML configuration reference (per-setting). https://patroni.readthedocs.io/en/latest/yaml_configuration.html

[^patroni-dynamic]: Dynamic configuration settings. Verbatim TTL rule: *"when changing values of **loop_wait**, **retry_timeout**, or **ttl** you have to follow the rule: `loop_wait + 2 * retry_timeout <= ttl`"*. https://patroni.readthedocs.io/en/latest/dynamic_configuration.html

[^patroni-rest]: REST API endpoints catalog. https://patroni.readthedocs.io/en/latest/rest_api.html

[^patroni-watchdog]: Watchdog modes (off/automatic/required) + softdog Linux kernel module + safety_margin. Verbatim: *"If watchdog activation fails and watchdog mode is `required` then the node will refuse to become leader."* and *"By default Patroni will set up the watchdog to expire 5 seconds before TTL expires."* https://patroni.readthedocs.io/en/latest/watchdog.html

[^patroni-pause]: Pause mode behavior. Verbatim: *"the member key in DCS is updated with the current information about the cluster"* but *"it does not change the state of PostgreSQL"*. https://patroni.readthedocs.io/en/latest/pause.html

[^patroni-replica-bootstrap]: Replica bootstrap methods (basebackup, wal-e, wal-g, pgBackRest). https://patroni.readthedocs.io/en/latest/replica_bootstrap.html

[^patroni-existing]: Bootstrapping Patroni on an existing PG cluster. https://patroni.readthedocs.io/en/latest/existing_data.html

[^patroni-kubernetes]: Kubernetes integration (Endpoints + ConfigMaps modes). https://patroni.readthedocs.io/en/latest/kubernetes.html

[^patroni-citus]: Citus integration. https://patroni.readthedocs.io/en/latest/citus.html

[^patroni-standby-cluster]: Standby cluster configuration for cross-region DR. https://patroni.readthedocs.io/en/latest/standby_cluster.html

[^patroni-security]: DCS and REST API security. https://patroni.readthedocs.io/en/latest/security.html

[^patroni-releases]: Patroni release notes. Latest: v4.1.3 (2026-05-05). https://patroni.readthedocs.io/en/latest/releases.html

[^patroni-github]: Patroni source. https://github.com/zalando/patroni

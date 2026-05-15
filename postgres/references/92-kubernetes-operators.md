# 92 — Kubernetes Operators for PostgreSQL

PostgreSQL on Kubernetes via operator pattern. Three canonical operators: **CloudNativePG (CNPG)**, **Zalando postgres-operator**, **Crunchy PGO**. Why raw `StatefulSet` is not enough. Custom Resource shape per operator. PVC + storage class. Operator-vs-Patroni trade-offs. For single-host Docker patterns, see [`91-docker-postgres.md`](./91-docker-postgres.md). For raw Patroni on VMs, see [`79-patroni.md`](./79-patroni.md). For HA architecture catalog, see [`78-ha-architectures.md`](./78-ha-architectures.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Why StatefulSet Alone Is Not Enough](#why-statefulset-alone-is-not-enough)
    - [Operator Comparison](#operator-comparison)
    - [CloudNativePG](#cloudnativepg)
    - [Zalando postgres-operator](#zalando-postgres-operator)
    - [Crunchy PGO](#crunchy-pgo)
    - [Storage Class and PVC Strategy](#storage-class-and-pvc-strategy)
    - [Backup Integration](#backup-integration)
    - [Connection Pooling](#connection-pooling)
    - [Cross-Region and Cross-Cluster](#cross-region-and-cross-cluster)
    - [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use when running PostgreSQL on Kubernetes (any distribution — vanilla, OpenShift, EKS, GKE, AKS, Tanzu, on-prem). Operators are the **only** production-grade pattern on K8s — raw `StatefulSet` provides stable identity + storage, nothing else (no failover, no backup, no leader election).

For **single-host** Docker dev/CI use [`91-docker-postgres.md`](./91-docker-postgres.md). For **bare-metal / VM** clusters use [`79-patroni.md`](./79-patroni.md). For **provider-agnostic HA patterns** see [`78-ha-architectures.md`](./78-ha-architectures.md).

## Mental Model

Five rules.

1. **PG on K8s needs an operator — NOT raw `StatefulSet`.** `StatefulSet`[^k8s-statefulset] gives stable pod identity (`pod-0`, `pod-1`), stable PVCs (preserved on rescheduling), ordered rolling updates. It does NOT give: leader election, automatic failover, backup, point-in-time recovery, replica bootstrap, lifecycle management. Operators close every one of those gaps via Custom Resources.

2. **Three canonical operators dominate.** **CloudNativePG (CNPG)** (Apache 2.0, CNCF Sandbox, EDB-origin community-driven, declarative `Cluster` CRD, does NOT use `StatefulSet`), **Zalando postgres-operator** (MIT, Patroni-based internally, `postgresql` CRD, used at Zalando scale), **Crunchy PGO** (Apache 2.0, `PostgresCluster` CRD, pgBackRest-integrated). All three open-source, production-ready. Pick by feature fit, team K8s expertise, and license posture.

3. **Operators manage the full lifecycle declaratively.** Bootstrap from scratch / from `pg_basebackup` / from logical replication / from existing PVC. Failover (in-K8s). In-place minor + major version upgrades. Scaling (add/remove replicas). Backups (scheduled, on-demand, PITR). Restore. Connection pooling. Monitoring exporter. **Everything as YAML CRs** — no imperative scripts.

4. **Storage class + PVC choice dominates performance.** K8s `PersistentVolume`[^k8s-pv] is abstract; the underlying storage class matters: cloud block storage (gp3, Premium SSD, PD-SSD) vs locally-attached NVMe vs Ceph RBD vs ZFS. Block storage = portable, slower, replicated by provider. Local NVMe = fastest, no automatic failover (must replicate at PG level). Replication relies on PG streaming replication anyway — local storage + N replicas common pattern.

5. **For cross-region DR, layer PG streaming replication on top.** Operators handle **intra-cluster** failover automatically. **Cross-cluster** / **cross-region** failover is NOT automated by any of the three — CNPG explicitly states[^cnpg-architecture]: "CloudNativePG cannot perform any cross-cluster automated failover, as it does not have authority beyond a single Kubernetes cluster." Cross-region = configure replica cluster pointing at primary cluster's WAL archive (object storage); promote manually or via your own automation.

> [!WARNING] StatefulSet alone is NOT a Postgres HA solution
> A naked `StatefulSet` with a Postgres image gives you one pod. Add a second replica via `replicas: 2` and you get two **independent** Postgres servers writing to two independent PVCs — no replication, no failover, no shared identity. Operators are the layer that makes K8s + Postgres work.

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Production PG on K8s | Pick an operator (CNPG / Zalando / Crunchy) | Failover, backup, monitoring as CRs |
| Cloud-native default, declarative, minimal moving parts | CloudNativePG | Apache 2.0, no Patroni, CR-driven, growing CNCF Sandbox project |
| Patroni knowledge already in-house, mature track record | Zalando postgres-operator | MIT, Patroni-based, used at Zalando production scale |
| pgBackRest as canonical backup, OpenShift focus | Crunchy PGO | Apache 2.0, pgBackRest-first, broad K8s distro testing |
| Bootstrap from existing cluster | All three: `initdb` / `recovery` / `pg_basebackup` source modes | Specify in `Cluster.spec.bootstrap` (CNPG) / `clone` block (Zalando) / `dataSource` (Crunchy) |
| Replica cluster in another region | All three: replica cluster reading from primary's WAL archive | Object-storage-backed; manual promotion |
| Connection pooling | CNPG `Pooler` CR / Zalando `enableConnectionPooler: true` / Crunchy `proxy.pgBouncer` | All three integrate pgBouncer (see [`81-pgbouncer.md`](./81-pgbouncer.md)) |
| Scheduled backups | CNPG `ScheduledBackup` / Zalando `enableLogicalBackup: true` + `logical_backup_schedule` / Crunchy `backups.pgbackrest.repos[].schedules` | All cron-based |
| PITR | CNPG `Cluster.spec.bootstrap.recovery.recoveryTarget` / Zalando WAL-E/WAL-G from S3 / Crunchy pgBackRest `dataSource.postgresCluster` | Object storage WAL archive required |
| Major version upgrade in-place | CNPG `Cluster.spec.imageName: postgres:18` + `imageCatalogRef` / Zalando `postgresql.spec.postgresql.version: "18"` / Crunchy `PostgresCluster.spec.postgresVersion: 18` | Operator orchestrates `pg_upgrade` |
| Pod anti-affinity for HA | All three accept `affinity` / `nodeAffinity` / topology spread in spec | Avoid two replicas on same node |
| Read-only / monitoring user | CNPG `Cluster.spec.managed.roles` / Zalando `users` block / Crunchy `users` block | Declarative role management |
| Monitoring | All three ship a Prometheus exporter sidecar / built-in | Scrape `metrics` endpoint |

Smell signals — running PG on K8s via raw `StatefulSet` + manual `pg_basebackup` scripts (re-implementing what every operator already does); choosing operator A then bolting on Patroni externally (operators ARE the cluster manager); single-replica `Cluster` in production (no failover possible — set `instances: 3` minimum).

## Mechanics

### Why StatefulSet Alone Is Not Enough

`StatefulSet` semantics[^k8s-statefulset]:

| Feature | StatefulSet | Operator |
|---|---|---|
| Stable pod name (`name-0`, `name-1`) | ✅ | ✅ (via internal StatefulSets or direct PVC management) |
| Stable PVC per replica | ✅ | ✅ |
| Ordered rolling update | ✅ | ✅ (operators add health-aware gating) |
| Automatic failover | ❌ | ✅ |
| Backup (full / WAL / incremental) | ❌ | ✅ |
| Point-in-time recovery | ❌ | ✅ |
| Replica bootstrap (`pg_basebackup` to new pod) | ❌ | ✅ |
| Leader election | ❌ | ✅ |
| In-place major upgrade | ❌ | ✅ |
| Read/write Service routing to current primary | ❌ | ✅ |
| Connection pooler integration | ❌ | ✅ |

Two replicas via `replicas: 2` on a `StatefulSet` produces two **independent** Postgres servers. To make them a cluster, something must: (1) decide which is primary, (2) bootstrap the replica via `pg_basebackup`, (3) configure streaming replication, (4) update K8s Service endpoints on failover. Operators do all four. **There is no "build my own" path that ends up smaller than just running an operator.**

Notably, CNPG explicitly does NOT use StatefulSets — it manages PVCs directly per pod[^cnpg-architecture]. Zalando and Crunchy do use StatefulSets internally as one piece of their reconciliation machinery.

### Operator Comparison

Three-way feature table at planning time (2026-05-14). **Verify before adopting** — feature surfaces evolve.

| Property | CloudNativePG | Zalando postgres-operator | Crunchy PGO |
|---|---|---|---|
| Latest release | v1.29.1 (May 2026)[^cnpg-github] | v1.15.1 (Dec 2025)[^zalando-github] | v6.0.1 (Feb 2026)[^crunchy-github] |
| License | Apache 2.0 | MIT | Apache 2.0 |
| CNCF status | Sandbox (joined 2025)[^cnpg-home] | None (open source, vendor-neutral via Zalando) | None (Crunchy Data commercial backing) |
| Patroni-based | ❌ (custom controller) | ✅ (Patroni internally) | ❌ (custom controller) |
| Uses StatefulSet | ❌ (manages PVCs directly) | ✅ | ✅ |
| Primary CRD | `Cluster` (`postgresql.cnpg.io`) | `postgresql` (`acid.zalan.do`) | `PostgresCluster` (`postgres-operator.crunchydata.com`) |
| Supported PG majors (latest release) | 13-18 | 13-17 stable, 14+ for PG18 | per-release; verify |
| Backup tool | Barman Cloud + pgBackRest (PG14+ via `Plugin` CR) | WAL-G, WAL-E, pg_dump | pgBackRest |
| Connection pooler | `Pooler` CR (PgBouncer) | `enableConnectionPooler: true` (PgBouncer) | `proxy.pgBouncer` (PgBouncer) |
| In-place major upgrade | ✅ (`imageName` change triggers) | ✅ (`majorVersionUpgradeMode`) | ✅ (annotation + `postgresVersion` bump) |
| Cross-region replica cluster | ✅ (replica cluster spec) | ✅ (standby cluster from WAL archive) | ✅ (`dataSource` + `standby: true`) |
| Cross-cluster automated failover | ❌ (manual)[^cnpg-architecture] | ❌ | ❌ |
| Declarative roles/databases | `managed.roles` + `Database` CR | `users` + `databases` blocks | `users` + `databases` blocks |
| Built-in monitoring | Prometheus exporter, JSON logging | Sidecar exporter | pgMonitor (Prometheus + Grafana) |

> [!NOTE] CNCF Sandbox vs Incubated vs Graduated
> CNCF project lifecycle: **Sandbox** (early, experimental, no governance guarantees) → **Incubated** (vetted, growing adoption) → **Graduated** (proven, mature, stable governance). CNPG is at **Sandbox** as of the planning date. Common misreporting calls it "incubated" — verify on the CNCF landscape before citing.

### CloudNativePG

**Architecture.** Custom controller (Go) running as a Deployment. Reconciles `Cluster` CRs into a set of Pods + PVCs + Services + Secrets + ConfigMaps. **Does not use StatefulSets** — manages PVCs directly per pod, which gives finer-grained control over pod replacement and storage lifecycle.

**Minimal `Cluster` CR.** Skeleton example based on CNPG docs[^cnpg-docs]:

    apiVersion: postgresql.cnpg.io/v1
    kind: Cluster
    metadata:
      name: appdb
      namespace: prod
    spec:
      instances: 3
      imageName: ghcr.io/cloudnative-pg/postgresql:17.9
      primaryUpdateStrategy: unsupervised
      storage:
        size: 100Gi
        storageClass: gp3
      postgresql:
        parameters:
          shared_buffers: "2GB"
          effective_cache_size: "6GB"
          max_connections: "200"
        pg_hba:
          - hostssl all all 10.0.0.0/8 scram-sha-256
      bootstrap:
        initdb:
          database: app
          owner: app
      backup:
        retentionPolicy: "30d"
        barmanObjectStore:
          destinationPath: s3://my-backup-bucket/appdb
          s3Credentials:
            accessKeyId:
              name: backup-credentials
              key: ACCESS_KEY_ID
            secretAccessKey:
              name: backup-credentials
              key: SECRET_ACCESS_KEY
          wal:
            compression: gzip
      monitoring:
        enablePodMonitor: true

**Key CR types (`postgresql.cnpg.io/v1`):**

| CR | Purpose |
|---|---|
| `Cluster` | The cluster itself — instances, storage, PostgreSQL config, bootstrap, backup, monitoring |
| `Backup` | One-off backup of a `Cluster` |
| `ScheduledBackup` | Cron-scheduled `Backup` |
| `Pooler` | PgBouncer in front of a `Cluster` (rw / ro / r endpoints) |
| `Database` | Declaratively manage a database within a `Cluster` |
| `Publication` | Logical replication publication |
| `Subscription` | Logical replication subscription |
| `ImageCatalog` / `ClusterImageCatalog` | Centralize image references for in-place major upgrades |

**Failover.** CNPG controller watches pod health + replication lag via the `cnpg` instance manager sidecar process running in each Postgres pod. On primary failure, controller picks the most-advanced replica (lowest lag), promotes it via `pg_promote()`[^cnpg-architecture], updates the `cluster-name-rw` Service to point at the new primary. Failover typically completes in **10-30 seconds** depending on streaming-replication lag at failure time.

**In-place major upgrade.** Bump `Cluster.spec.imageName` from `postgresql:17.9` to `postgresql:18.0`. Controller orchestrates: stop replicas, run `pg_upgrade --link` on primary's PVC contents in a temporary pod (or `pg_upgrade --copy` for safety), rebuild replicas via `pg_basebackup`. Cross-reference: [`86-pg-upgrade.md`](./86-pg-upgrade.md) for `pg_upgrade` mechanics.

**Read/write routing.** Three Services created automatically: `cluster-name-rw` (writes — current primary), `cluster-name-ro` (read replicas — round-robin among healthy standbys), `cluster-name-r` (any healthy member, round-robin).

### Zalando postgres-operator

**Architecture.** Custom controller (Go, derived from Spilo project) reconciles `postgresql` CRs into StatefulSets running **Spilo** images. Spilo bundles Postgres + Patroni + a few helpers. Patroni handles leader election + failover internally; the operator manages the K8s lifecycle (Spilo image upgrades, PVC resize, service routing, role/database CR-driven management). Verbatim Zalando README[^zalando-github]: "delivers an easy to run highly-available PostgreSQL clusters on Kubernetes (K8s) powered by Patroni."

**Minimal `postgresql` CR.** Skeleton based on Zalando docs[^zalando-readthedocs]:

    apiVersion: acid.zalan.do/v1
    kind: postgresql
    metadata:
      name: acid-appdb
      namespace: prod
    spec:
      teamId: appteam
      volume:
        size: 100Gi
        storageClass: gp3
      numberOfInstances: 3
      users:
        app:
          - superuser
          - createdb
        readonly: []
      databases:
        app: app
      postgresql:
        version: "17"
        parameters:
          shared_buffers: "2GB"
          max_connections: "200"
      patroni:
        ttl: 30
        loop_wait: 10
        retry_timeout: 10
        synchronous_mode: false
      enableConnectionPooler: true
      connectionPooler:
        numberOfInstances: 2
        mode: transaction
        schema: pooler
        user: pooler
      enableLogicalBackup: true
      logicalBackupSchedule: "30 02 * * 1"
      additionalVolumes:
        - name: logs
          mountPath: /home/postgres/pgdata/pgroot/data/log
          volumeSource:
            emptyDir: {}

**Naming convention.** Cluster name = `{team-prefix}-{name}` enforced by the operator's `team_api_role_configuration` (e.g., `acid-appdb` where `acid` is the team prefix). The team prefix can be set via operator config.

**Failover.** Patroni-based. Patroni daemons running inside each Spilo pod hold a leader lock in the DCS (operator typically configures K8s API as DCS — no external etcd needed). On leader loss, Patroni runs leader election, promotes the new primary. Operator updates K8s Service endpoints. See [`79-patroni.md`](./79-patroni.md) for Patroni mechanics; the same logic runs inside Spilo.

**Major version upgrade.** Set `spec.postgresql.version: "18"`. Operator's `majorVersionUpgradeMode` controls behavior: `off` (refuse upgrade), `manual` (operator-initiated only via annotation), `full` (automatic). Cross-reference: [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

**Read/write routing.** Services: `acid-appdb` (writes — current primary, single endpoint), `acid-appdb-repl` (read replicas).

### Crunchy PGO

**Architecture.** Custom controller (Go) reconciles `PostgresCluster` CRs into StatefulSets. Each replica runs a `database` container + `pgbackrest` sidecar + `replication-cert-copy` init container. Backup canonical via pgBackRest. Cross-reference: [`85-backup-tools.md`](./85-backup-tools.md).

**Minimal `PostgresCluster` CR.** Skeleton based on Crunchy PGO docs[^crunchy-docs]:

    apiVersion: postgres-operator.crunchydata.com/v1beta1
    kind: PostgresCluster
    metadata:
      name: appdb
      namespace: prod
    spec:
      postgresVersion: 17
      instances:
        - name: instance1
          replicas: 3
          dataVolumeClaimSpec:
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 100Gi
            storageClassName: gp3
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                - labelSelector:
                    matchLabels:
                      postgres-operator.crunchydata.com/cluster: appdb
                  topologyKey: kubernetes.io/hostname
      backups:
        pgbackrest:
          image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbackrest:ubi8-2.x
          repos:
            - name: repo1
              s3:
                bucket: my-backup-bucket
                endpoint: s3.amazonaws.com
                region: us-east-1
              schedules:
                full: "0 1 * * 0"
                differential: "0 1 * * 1-6"
                incremental: "0 */4 * * *"
      proxy:
        pgBouncer:
          image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbouncer:ubi8-1.x
          replicas: 2
          config:
            global:
              pool_mode: transaction
              max_client_conn: "200"
      users:
        - name: app
          databases:
            - app
          options: "SUPERUSER"

**Failover.** Custom controller-driven. PGO watches pod health + replication lag, promotes the most-advanced replica on primary failure.

**Major version upgrade.** Add the `postgres-operator.crunchydata.com/pgupgrade` annotation, change `spec.postgresVersion`. PGO runs `pg_upgrade` orchestration. Cross-reference: [`86-pg-upgrade.md`](./86-pg-upgrade.md).

**Backup canonical via pgBackRest.** Configure `backups.pgbackrest.repos[]` for one or more repos (local PVC, S3, GCS, Azure Blob). Schedules cron-based. PITR via `dataSource.postgresCluster` with target time/LSN.

**Read/write routing.** Services: `appdb-primary` (writes), `appdb-replicas` (read replicas).

### Storage Class and PVC Strategy

K8s PVCs[^k8s-pv] are bound to underlying PersistentVolumes via a `storageClassName`. Storage class choice affects performance, durability, and failover behavior.

| Storage type | Examples | IOPS | Replication | When to pick |
|---|---|---|---|---|
| Cloud block (general) | AWS gp3, GCP pd-balanced, Azure Standard SSD | 3000-16000 | Provider-replicated (3x within zone) | Default for most workloads; survives node failure via reattach |
| Cloud block (premium) | AWS io2, GCP pd-extreme, Azure Premium SSD v2 | up to 256k+ | Same | High-IOPS OLTP; expensive |
| Local NVMe | `local-path-provisioner`, `local-static-provisioner` | 100k-1M+ | None (node-local) | Highest perf, **must** replicate at PG level; lose node = lose PV |
| Network FS | Ceph RBD, Longhorn, OpenEBS | varies | Distributed | On-prem clusters without cloud block storage |
| NFS | NetApp, EFS | low IOPS, high latency | Provider-replicated | **Avoid for Postgres heap files** — fsync semantics often broken |

> [!WARNING] NFS + Postgres = data loss risk
> Many NFS implementations don't honor `fsync()` correctly. Postgres relies on `fsync()` for crash recovery. **Do not use NFS for `$PGDATA`.** Use block storage or local NVMe. Object storage (S3-compatible) is fine for **WAL archive** + **backups** — not for live data files.

**Resize.** Most cloud block storage classes support online PVC resize (CSI `VolumeExpansion: true`). All three operators support this — change the storage size in the CR, operator triggers PVC expansion, no pod restart needed on modern CSI drivers.

**Local NVMe topology.** Each replica MUST be on a different node (use `podAntiAffinity` with `topologyKey: kubernetes.io/hostname`). Loss of node = loss of one replica's PV = operator rebuilds that replica via `pg_basebackup` from the primary onto a new PV.

### Backup Integration

Each operator has a canonical backup tool:

| Operator | Backup tool | Storage targets | Schedule mechanism |
|---|---|---|---|
| CNPG | Barman Cloud + pgBackRest (via Plugin CR, PG14+) | S3-compatible, Azure Blob, GCS | `ScheduledBackup` CR (cron) |
| Zalando | WAL-G, WAL-E, `pg_dump` | S3-compatible, Azure Blob, GCS | `logicalBackupSchedule` (cron) |
| Crunchy | pgBackRest | S3-compatible, Azure Blob, GCS, local PVC | `backups.pgbackrest.repos[].schedules` (cron) |

All three support **continuous WAL archiving** + **point-in-time recovery**. Cross-reference: [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) for PITR mechanics, [`85-backup-tools.md`](./85-backup-tools.md) for backup tool comparison, [`90-disaster-recovery.md`](./90-disaster-recovery.md) for DR drills.

### Connection Pooling

All three operators integrate PgBouncer (see [`81-pgbouncer.md`](./81-pgbouncer.md) for PgBouncer-specific guidance):

| Operator | Pooler resource | Default mode | Where it sits |
|---|---|---|---|
| CNPG | `Pooler` CR (separate object) | `session` (CNPG default — verify) | Independent Deployment in front of `Cluster` |
| Zalando | `enableConnectionPooler: true` in `postgresql` CR | `transaction` | Sidecar Deployment per cluster |
| Crunchy | `proxy.pgBouncer` in `PostgresCluster` CR | `session` (default; override via `config.global.pool_mode`) | Separate Deployment with TLS |

Connection pooler typically runs as a separate Deployment (2-4 replicas behind a Service). Postgres-side cluster size and pool-mode interaction: see [`80-connection-pooling.md`](./80-connection-pooling.md).

### Cross-Region and Cross-Cluster

**No operator provides automated cross-cluster failover.** CNPG explicit quote[^cnpg-architecture]: "CloudNativePG cannot perform any cross-cluster automated failover, as it does not have authority beyond a single Kubernetes cluster." Same logic applies to Zalando + Crunchy.

**Manual cross-region DR pattern**:

1. Primary cluster in region A writes to object storage (S3/GCS/Azure Blob) WAL archive.
2. Standby cluster in region B configured to consume that WAL archive — boots as **replica cluster** (read-only, continuously replays archived WAL).
3. On region A disaster: stop primary cluster (or accept it's lost), promote region B standby via operator CR change (CNPG `replica.enabled: false`; Zalando standby cluster reconfig; Crunchy `standby: false`).
4. Update DNS / external load balancer to point at region B.
5. Re-create region A as new standby once it's available.

Cross-reference: [`90-disaster-recovery.md`](./90-disaster-recovery.md) for full DR runbook patterns.

### Per-Version Timeline

K8s operators evolve independently of PostgreSQL. Postgres major releases that affect operator behavior:

| PG version | Operator-relevant items | Verbatim release-note quote |
|---|---|---|
| **PG14** | Operators using shell `archive_command` keep working; no operator-relevant PG14-specific archive changes | — |
| **PG15** | Server-side compression `pg_basebackup --compress`; `archive_library` introduced[^pg15-release-archive_library] | "Allow custom WAL resource managers (Jeff Davis). This allows extensions to manage their own WAL records." |
| **PG16** | `archive_command` + `archive_library` mutually exclusive[^pg16-release-archive_mutex]; affects operators with both set | "Disallow setting `archive_command` and `archive_library` at the same time (Nathan Bossart)." |
| **PG17** | `pg_basebackup --incremental` + `pg_combinebackup`[^pg17-release-incremental]; logical slot failover[^pg17-release-slot-failover] | "Allow incremental file system backups (Robert Haas, Jakub Wartak, Tomas Vondra). pg_basebackup --incremental backs up files modified since a previous backup." |
| **PG18** | Data checksums default-on at `initdb`[^pg18-release-checksums]; `idle_replication_slot_timeout`; default-on `data_checksums` affects `pg_upgrade` paths from non-checksum source clusters | "Change initdb to default to enabling checksums (Greg Sabino Mullane). The --no-data-checksums option turns checksums off." |

**Operator releases bring PG-major support over time.** Zalando v1.15.1 supports PG13-17 stable + PG18 starting from 14+[^zalando-github]. CNPG v1.29.1 supports PG13-18[^cnpg-github]. Crunchy v6.0.1 — check release notes per major[^crunchy-github]. **Always verify the operator release supports your target PG major BEFORE upgrading.**

## Recipes

1. **Bootstrap CNPG cluster on EKS.** Install operator via Helm chart (`helm repo add cnpg https://cloudnative-pg.github.io/charts; helm install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace`). Apply minimal `Cluster` CR from CNPG section above. Verify with `kubectl cnpg status appdb -n prod`. Cross-reference: [`91-docker-postgres.md`](./91-docker-postgres.md) for single-host comparison.

2. **Scheduled backup to S3 with CNPG `ScheduledBackup`.**

        apiVersion: postgresql.cnpg.io/v1
        kind: ScheduledBackup
        metadata:
          name: appdb-nightly
          namespace: prod
        spec:
          schedule: "0 0 2 * * *"  # every day at 02:00 UTC (cron with seconds field)
          cluster:
            name: appdb
          backupOwnerReference: self
          immediate: false

    Cross-reference: [`85-backup-tools.md`](./85-backup-tools.md) for Barman vs pgBackRest vs WAL-G trade-offs.

3. **Pod anti-affinity for HA.** Force every replica onto a different node. Required for local NVMe; recommended even for cloud block.

        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    cnpg.io/cluster: appdb
                topologyKey: kubernetes.io/hostname

4. **Replica cluster across regions (CNPG).** Primary in `us-east-1`, replica in `us-west-2`. Both clusters share an S3 bucket for WAL archive.

        apiVersion: postgresql.cnpg.io/v1
        kind: Cluster
        metadata:
          name: appdb
          namespace: prod
        spec:
          instances: 3
          imageName: ghcr.io/cloudnative-pg/postgresql:17.9
          storage:
            size: 100Gi
            storageClass: gp3
          replica:
            enabled: true
            source: appdb-primary
          bootstrap:
            recovery:
              source: appdb-primary
          externalClusters:
            - name: appdb-primary
              barmanObjectStore:
                destinationPath: s3://my-bucket/appdb
                s3Credentials:
                  accessKeyId:
                    name: backup-credentials
                    key: ACCESS_KEY_ID
                  secretAccessKey:
                    name: backup-credentials
                    key: SECRET_ACCESS_KEY

    Manual promotion on region A failure: `kubectl patch cluster appdb -p '{"spec":{"replica":{"enabled":false}}}'`.

5. **Major version upgrade (CNPG).** Edit `spec.imageName: ghcr.io/cloudnative-pg/postgresql:18.0` (was `:17.9`). Operator runs `pg_upgrade`. Watch with `kubectl cnpg status appdb -n prod` and `kubectl get pods -n prod -w`. Cross-reference: [`86-pg-upgrade.md`](./86-pg-upgrade.md) for `pg_upgrade` prerequisites + [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) for strategy comparison.

6. **Online PVC resize.** Edit `spec.storage.size: 200Gi` (was `100Gi`). Storage class must support `VolumeExpansion: true`. Verify with `kubectl get pvc -n prod`.

7. **Custom `postgresql.conf` via CR.** All three operators accept `parameters` in spec. CNPG example:

        spec:
          postgresql:
            parameters:
              shared_buffers: "4GB"
              effective_cache_size: "12GB"
              work_mem: "32MB"
              max_connections: "200"
              random_page_cost: "1.1"
              checkpoint_completion_target: "0.9"

    Operator restarts pods rolling-style to pick up changes that require restart. Cross-reference: [`53-server-configuration.md`](./53-server-configuration.md) + [`54-memory-tuning.md`](./54-memory-tuning.md).

8. **Read/write split via Services.** Application writes to `appdb-rw` (single endpoint, current primary). Reporting / read-only workload to `appdb-ro` (round-robin across replicas). DNS-resolvable inside the namespace as `appdb-rw.prod.svc.cluster.local`.

9. **Connection pooler in front of cluster (CNPG `Pooler` CR).**

        apiVersion: postgresql.cnpg.io/v1
        kind: Pooler
        metadata:
          name: appdb-pooler-rw
          namespace: prod
        spec:
          cluster:
            name: appdb
          instances: 3
          type: rw
          pgbouncer:
            poolMode: transaction
            parameters:
              max_client_conn: "1000"
              default_pool_size: "20"

    Cross-reference: [`81-pgbouncer.md`](./81-pgbouncer.md) for pool-mode trade-offs.

10. **Declarative roles + databases (CNPG `managed` block).** Operator reconciles role state automatically:

        spec:
          managed:
            roles:
              - name: app
                ensure: present
                login: true
                superuser: false
                connectionLimit: 50
                passwordSecret:
                  name: app-password

11. **Monitor via Prometheus.** All three ship a `metrics` Service / `PodMonitor`. CNPG: `monitoring.enablePodMonitor: true`. Zalando: built-in exporter, `kubectl port-forward svc/acid-appdb-svc 8008:8008` to verify. Crunchy: pgMonitor stack ships Grafana dashboards. Cross-reference: [`82-monitoring.md`](./82-monitoring.md).

12. **Debug a failover.** `kubectl cnpg status appdb` (CNPG) / `patronictl -c /home/postgres/postgres.yml list` inside a Spilo pod (Zalando) / `kubectl describe postgrescluster appdb` (Crunchy). All three show current primary, replication lag, instance state. Cross-reference: [`77-standby-failover.md`](./77-standby-failover.md) for the underlying PG mechanism.

13. **Pre-upgrade audit on K8s.** Use `kubectl exec` into a primary pod, run pre-upgrade checks: `vacuumdb --all --analyze-in-stages`, `pg_amcheck`, extension inventory. Cross-reference: [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) Recipe 2 for the canonical audit script.

## Gotchas

1. **`StatefulSet` alone is NOT a PG cluster.** Two replicas without an operator = two independent servers, not a cluster. **Use an operator** — there is no shortcut.

2. **Cross-cluster failover is NOT automated by any of the three.** Operators handle intra-K8s-cluster failover. Region failure requires manual promotion. Plan DR runbook accordingly[^cnpg-architecture]. See [`90-disaster-recovery.md`](./90-disaster-recovery.md).

3. **NFS for `$PGDATA` is a data-loss risk.** `fsync()` semantics often broken on NFS implementations. **Use block storage or local NVMe.** Object storage is fine for WAL archive + backups, not live data.

4. **Storage class without `VolumeExpansion: true`** = no online resize. PVC stuck at initial size; need PV migration to grow. Pick a CSI driver that supports expansion.

5. **Operator version must support target PG major BEFORE upgrade.** Zalando v1.15.1 supports PG13-17 stable + PG18 from 14+[^zalando-github]. Bumping `postgresVersion` past what the operator supports = stuck cluster.

6. **PG18 default-on data checksums break `pg_upgrade` from non-checksum source[^pg18-release-checksums].** Pre-PG18 clusters created with default settings have checksums OFF. Upgrading to PG18 via `pg_upgrade` fails unless the new cluster is also initialized with `--no-data-checksums`. Cross-reference: [`86-pg-upgrade.md`](./86-pg-upgrade.md) + [`88-corruption-recovery.md`](./88-corruption-recovery.md).

7. **CNPG `Cluster.spec.instances: 1` = no failover possible.** Set `instances: 3` minimum for production HA.

8. **Pod anti-affinity not set = two replicas on same node = single node failure kills two replicas.** Always set `podAntiAffinity` with `topologyKey: kubernetes.io/hostname`. Operators ship reasonable defaults but verify in CR.

9. **CNPG does NOT use StatefulSets[^cnpg-architecture].** Standard K8s troubleshooting playbooks that assume `kubectl get sts` will not find CNPG pods that way. Use `kubectl get cluster` + `kubectl cnpg status` + `kubectl get pods -l cnpg.io/cluster=appdb`.

10. **Zalando team prefix enforced in cluster name.** `acid-appdb` not `appdb`. Configurable via operator config but ignoring this convention = operator refuses to reconcile the CR.

11. **Crunchy PGO v5 → v6 incompatible CRDs.** Migration from v5.x to v6.x requires CR transformation. Read upgrade notes[^crunchy-docs] before bumping operator version.

12. **PgBouncer transaction mode + per-role GUCs[^pg-bouncer-transaction-mode-gucs].** `SET statement_timeout` issued by one client persists into the next client's transaction in transaction mode pool. Use `SET LOCAL` or per-role `ALTER ROLE … SET`. Cross-reference: [`81-pgbouncer.md`](./81-pgbouncer.md) gotcha #3 + [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6.

13. **Cluster CRDs not garbage-collected on operator uninstall by default.** Deleting the operator Deployment does NOT delete `Cluster` CRs or their PVCs. Cleanup requires explicit `kubectl delete cluster appdb` (deletes pods + Service) then `kubectl delete pvc -l cnpg.io/cluster=appdb` (deletes data).

14. **Operator logs vs PG logs.** `kubectl logs deploy/cnpg-controller-manager -n cnpg-system` = operator reconciliation. `kubectl logs appdb-1 -c postgres -n prod` = PG server log. Failover problems usually visible in operator logs; query problems in PG logs. Cross-reference: [`82-monitoring.md`](./82-monitoring.md).

15. **Backup retention vs WAL retention misunderstanding.** Setting `retentionPolicy: 7d` deletes base backups older than 7 days; WAL retention is separate (controlled by `wal_keep_size` or `archive_timeout` on PG side, and by the backup tool's WAL pruning). Test PITR target window weekly. Cross-reference: [`85-backup-tools.md`](./85-backup-tools.md) gotcha #9.

16. **CNPG `Pooler` does NOT inherit `Cluster` connection limits.** `Pooler.spec.pgbouncer.parameters.max_client_conn` is separate from `Cluster.spec.postgresql.parameters.max_connections`. Math: `max_client_conn` × pooler instances must accommodate worst-case client load; `default_pool_size` × pooler instances must be ≤ Postgres `max_connections` × cluster instances.

17. **`Cluster.spec.imageName` change triggers rolling restart on every parameter change requiring restart.** Some parameters (`shared_buffers`, `wal_buffers`, `max_connections`) require restart. Operator waits for replica catch-up, fails over primary, restarts old primary as new replica. Plan maintenance windows.

18. **Logical replication slots created via psql do NOT survive operator reconciliation.** Use the operator's declarative slot management (CNPG `Subscription` CR + PG17 logical slot failover[^pg17-release-slot-failover]) to ensure slots persist across pod rescheduling. Cross-reference: [`75-replication-slots.md`](./75-replication-slots.md).

19. **K8s API as DCS (Zalando default) tied to cluster availability.** Patroni leader election runs through the K8s API server[^zalando-readthedocs]. K8s API outage = no failover decisions made (cluster keeps current primary). Tolerable for short API outages; not for region-level events.

20. **Local NVMe + replica loss = full `pg_basebackup` to rebuild.** Losing a node with local NVMe storage destroys that replica's PV. Operator schedules a new pod on a different node + bootstraps via `pg_basebackup` from primary. For TB-scale data this can take hours; consider mixed storage strategy (one replica on block, others on NVMe).

21. **Operator upgrades may require Kubernetes minimum version.** CNPG v1.29.x targets K8s 1.27+; Crunchy v6.0.x targets K8s 1.22-1.26+[^crunchy-github]. Skipping K8s upgrades = stuck on old operator = no PG18 support.

22. **CRD changes during operator upgrade may need `helm upgrade --skip-crds` + manual `kubectl apply -f crds.yaml`.** Helm by default does not upgrade CRDs after install. Each operator's upgrade docs state the path; follow them precisely.

23. **Single-replica `Cluster` in production = no failover possible AND no backup target replica.** Three replicas is the minimum-viable production count: one primary + two replicas (one quorum, one read).

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum behavior on K8s replicas
- [`46-roles-privileges.md`](./46-roles-privileges.md) — operator-managed roles vs declarative role CRs
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — pg_hba.conf via operator spec
- [`49-tls-ssl.md`](./49-tls-ssl.md) — TLS cert management (cert-manager integration)
- [`53-server-configuration.md`](./53-server-configuration.md) — postgresql.conf via CR
- [`54-memory-tuning.md`](./54-memory-tuning.md) — shared_buffers + work_mem on K8s pods
- [`73-streaming-replication.md`](./73-streaming-replication.md) — replication mechanics under operators
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication CRs (CNPG Publication/Subscription)
- [`75-replication-slots.md`](./75-replication-slots.md) — slot management on K8s
- [`77-standby-failover.md`](./77-standby-failover.md) — `pg_promote` mechanics inside operators
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA pattern catalog
- [`79-patroni.md`](./79-patroni.md) — Patroni inside Zalando/Spilo
- [`80-connection-pooling.md`](./80-connection-pooling.md) — pool sizing on K8s
- [`81-pgbouncer.md`](./81-pgbouncer.md) — PgBouncer specifics
- [`82-monitoring.md`](./82-monitoring.md) — Prometheus + Grafana stack
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — PITR mechanics
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest / Barman / WAL-G
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — pg_upgrade in operator workflows
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — major version upgrade strategies
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — pg_amcheck on K8s pods
- [`89-pg-rewind.md`](./89-pg-rewind.md) — post-failover re-attachment
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — cross-region DR runbook
- [`91-docker-postgres.md`](./91-docker-postgres.md) — single-host Docker (contrast)
- [`96-timescaledb.md`](./96-timescaledb.md) — TimescaleDB inside K8s operators
- [`97-citus.md`](./97-citus.md) — Citus cluster managed by CloudNativePG or Crunchy
- [`98-pg-cron.md`](./98-pg-cron.md) — operator-managed scheduled backups vs pg_cron
- [`99-pg-partman.md`](./99-pg-partman.md) — operator-managed pg_partman extension lifecycle
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version operator-relevant PG items (checksums, slot failover, pg_basebackup incremental)
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — K8s operator vs managed service trade-offs

## Sources

[^k8s-statefulset]: Kubernetes documentation, "StatefulSets". https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/ — confirms stable network identity + stable PVC + ordered rolling update; no application-level lifecycle management.

[^k8s-pv]: Kubernetes documentation, "Persistent Volumes". https://kubernetes.io/docs/concepts/storage/persistent-volumes/ — PV/PVC abstraction, storage classes, `VolumeExpansion: true` capability flag.

[^cnpg-home]: CloudNativePG project home. https://cloudnative-pg.io/ — Apache 2.0, CNCF Sandbox project (verified at planning time), EDB-origin community-driven.

[^cnpg-docs]: CloudNativePG documentation. https://cloudnative-pg.io/documentation/current/ (redirects to `/docs/devel/` at planning time) — `Cluster` CR reference, bootstrap options, backup configuration, monitoring.

[^cnpg-architecture]: CloudNativePG architecture documentation. https://cloudnative-pg.io/documentation/current/architecture/ — verbatim quote on cross-cluster failover: "CloudNativePG cannot perform any cross-cluster automated failover, as it does not have authority beyond a single Kubernetes cluster."

[^cnpg-github]: CloudNativePG GitHub repository. https://github.com/cloudnative-pg/cloudnative-pg — v1.29.1 (May 8, 2026), supported PG majors 13-18, CR types (Cluster, Backup, ScheduledBackup, Database, ImageCatalog, ClusterImageCatalog, Pooler, Publication, Subscription).

[^zalando-github]: Zalando postgres-operator GitHub. https://github.com/zalando/postgres-operator — v1.15.1 (December 18, 2025), MIT license, verbatim: "delivers an easy to run highly-available PostgreSQL clusters on Kubernetes (K8s) powered by Patroni." Supported PG majors 13-17 stable + 14+ for PG18.

[^zalando-readthedocs]: Zalando postgres-operator documentation. https://postgres-operator.readthedocs.io/en/latest/ — `postgresql` CR reference, 15 configuration parameter groups, Spilo image, K8s-API-as-DCS.

[^crunchy-github]: Crunchy Data postgres-operator GitHub. https://github.com/CrunchyData/postgres-operator — v6.0.1 (February 26, 2026), Apache 2.0 license, `PostgresCluster` CRD, pgBackRest integration, OpenShift 4.8-4.13 tested.

[^crunchy-docs]: Crunchy PGO v5 documentation hub. https://access.crunchydata.com/documentation/postgres-operator/v5/ — CR reference; v6.0.x docs path differs, verify against current release notes.

[^pg15-release-archive_library]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/15/release-15.html — `archive_library` introduction (Nathan Bossart): "Allow archiving via loadable modules (Nathan Bossart). Archiving no longer needs to be done via shell."

[^pg16-release-archive_mutex]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/16/release-16.html — verbatim quote: "Disallow setting `archive_command` and `archive_library` at the same time (Nathan Bossart)."

[^pg17-release-incremental]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/17/release-17.html — verbatim quote: "Allow incremental file system backups (Robert Haas, Jakub Wartak, Tomas Vondra). pg_basebackup --incremental backs up files modified since a previous backup."

[^pg17-release-slot-failover]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/17/release-17.html — logical replication slot failover (Hou Zhijie, Shveta Malik, Ajin Cherian): "Allow synchronization of logical replication slots on physical standbys so logical replication can be resumed on a failover."

[^pg18-release-checksums]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/18/release-18.html — verbatim quote: "Change initdb to default to enabling checksums (Greg Sabino Mullane). The --no-data-checksums option turns checksums off."

[^pg-bouncer-transaction-mode-gucs]: PgBouncer documentation, "Pooling modes" + per-role GUC interactions. https://www.pgbouncer.org/features.html — transaction-mode pool reuses server connections across clients, breaking session-state expectations including `SET` without `LOCAL`.

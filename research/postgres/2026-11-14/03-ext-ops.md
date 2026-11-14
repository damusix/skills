# Operational tooling: changes since 2026-05-14

Research date: 2026-11-14. Primary sources only (GitHub releases, upstream docs, docker-library, postgresql.org). Line numbers refer to `postgres/references/` in the `postgres-update` worktree.

Context that affects every section: PostgreSQL 19 is NOT generally available as of 2026-11-14. The postgresql.org front page lists "2026-11-12 - PostgreSQL 19 Rc 2, 18.7, 17.12, 16.16, 15.20 and 14.25 Released" (https://www.postgresql.org/). PostgreSQL 14 final release date is November 12, 2026, and 14.25 is the last minor (https://www.postgresql.org/support/versioning/).

## Summary table

| Tool | Our version | Upstream latest + date | Changed | PG19 supported |
|---|---|---|---|---|
| PgBouncer | 1.25.2 (2026-05-08) | 1.26.1 (2026-10-14); 1.26.0 (2026-09-23) | yes | unknown (1.26 changelog mentions only PG14+ and PG18+ behavior) |
| Patroni | 4.1.3 (2026-05-05) | 4.1.5 (2026-08-12); 4.0.11 and 3.3.11 backports same day | yes | no released version; unreleased master docs add `pg_hosts` "PostgreSQL 19+ only" |
| pgBackRest | 2.58.0 (file says "Jan 2025", real date 2026-01-19) | 2.60.0 (2026-10-18) | yes | yes (2.59.0 "PostgreSQL 19 Support", 2026-07-20; 2.59.2 adds 19beta4) |
| Barman | 3.18.0 (2026-03-12) | 3.20.1 (2026-09-29) | yes | unknown (no release note mentions PG19) |
| WAL-G | 3.0.8 (2026-01-21) | 3.0.9 (2026-08-20) | yes (minor) | unknown (release notes silent; master docs say CI on PG 14-18) |
| CloudNativePG | 1.29.1 (2026-05-08) | 1.30.1 (2026-09-23); 1.29.3 same day | yes | no (supported 14-18); 1.30 enables `pg_upgrade` to PG19+ with Image Volume extensions |
| Zalando postgres-operator | 1.15.1 (2025-12-18) | 2.0.3 (2026-10-02); major release 2.0.0 (2026-07-27) | yes (breaking) | no (v2 adds PG18, drops PG13) |
| Crunchy PGO | 6.0.1 (2026-02-26) | 6.0.3 (tag 2026-08-20, no GitHub release object); 6.0.2 is latest GitHub release (2026-06-02) | yes | no (PG 14-18) |
| Official Docker image | 17.9 / PG 14-18, alpine3.22/3.23 | 18.7, 17.12, 16.16, 15.20, 14.25; `19rc2` tags present; alpine3.24 | yes | RC only (`19rc2`), not GA |
| pgaudit | 18.0 (2025-09-24) | 18.0 stable; `19rc1` pre-release (2026-10-27) | yes (PG19 branch) | pre-release only |
| pg_repack | not stated | 1.5.3 (tag 2025-10-26); unreleased master commits through 2026-11-13 | minor | master docs list 9.5-19; released 1.5.3 docs list up to 18 |
| pg_squeeze | not stated | 1.9.4 (2026-07-29) | yes | yes (1.9.3, 2026-06-19) |
| postgres_exporter | 0.19.1 (2026-02-25) | 0.20.1 (2026-07-08); 0.20.0 (2026-06-29) | yes (breaking) | unknown (README: CI tested 13-18) |

## PgBouncer

### Findings

**What**: Two releases after 1.25.2.

1.26.0 (2026-09-23, "Ignore all previous search_path"):
- Security: CVE-2026-19888 (SCRAM client-final-message without nonce crashes PgBouncer, present since 1.11.0), CVE-2026-6668 (packet buffer integer overflow hang, pre-auth with default `max_packet_size`), CVE-2026-6669 (unbounded SCRAM iteration count from server; now capped at 1000000).
- New default: all parameters PostgreSQL reports by default are tracked. `search_path` (PG18+) and `default_transaction_read_only` (PG14+) are now tracked by default, so `SET search_path` in transaction pooling no longer leaks to other clients.
- New settings: `pool_idle_timeout` (disabled by default; removing a pool also loses its stats), `login_notify_message`; `query_wait_timeout` is now configurable per user and per database.
- New stat: `client_login_count` in `SHOW STATS`. New ParameterStatus messages on login: `pgbouncer.version`, `pgbouncer.pool_mode`, `pgbouncer.max_prepared_statements`.
- REMOVED: online restart (`-R`, takeover), plus the `SHOW FDS` and `SUSPEND` admin commands. Replacement is rolling restarts with `so_reuseport` (https://www.pgbouncer.org/usage.html#shutdown-wait_for_clients).
- Other: max password length raised to 65535 bytes; `COPY` now works outside an explicit transaction in transaction pooling; disconnect reasons now read `evicted for max_db_connections` / `evicted for pool_size` / `evicted for max_user_connections`; C11 compiler required; meson build support.

1.26.1 (2026-10-14, "Only startup once"):
- Security: CVE-2026-107350 (second StartupMessage during SCRAM auth lets a user whose password you know log in as any other SCRAM user, including admins; affects 1.17.0 through 1.26.0), CVE-2026-107349 (empty option name such as `-c=` spins a CPU core when `ignore_startup_parameters` is non-empty and lacks `options`; 1.20.0 through 1.26.0), CVE-2026-107348 (buffer overflow hang when `max_packet_size` >= 2147483649; 1.21.0 through 1.26.0).
- Fix: `ignore_startup_parameters` now takes precedence over tracked parameters. Release note says "various bugs were reported around tracking of `search_path`... will be addressed in a later release"; adding `search_path` to `ignore_startup_parameters` restores 1.25 behavior.

**Where found**: https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_26_0 ; https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_26_1 ; https://www.pgbouncer.org/changelog.html ; https://www.pgbouncer.org/config.html (`pool_idle_timeout`, `client_tls13_ciphers` present).

**Affects**: `81-pgbouncer.md` lines 107, 320, 326, 790-800 (Recipe 11 SUSPEND/socket-passing online restart), 906 (footnote lists `SUSPEND`); 547-560 timeline and 925 ("latest at write time"); 884 (CVE list).

**Action**: update. Remove or rewrite SUSPEND and Recipe 11 (feature removed in 1.26.0). Add 1.26.0 and 1.26.1 to the timeline. Add a gotcha for `search_path` tracking and `ignore_startup_parameters` precedence. Add `pool_idle_timeout`, `login_notify_message`, per-user/db `query_wait_timeout`, `client_login_count`. Update latest to 1.26.1.

### Corrections to pre-existing claims (not new upstream change)

- Line 48 and 378 (and footnote 907): "`max_prepared_statements` default is 200 since pgBouncer 1.21". Wrong. 1.21.0 introduced the feature with a non-zero value needed to enable it; the default became 200 in 1.24.0 (2025-01-10): "Enable prepared statement support by default, `max_prepared_statements` is now set to 200 by default." Source: https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_24_0 and https://www.pgbouncer.org/changelog.html (1.21.0 text says "you need to change the new `max_prepared_statements` setting to a non-zero value").
- Line 235: `client_tls_tls13_ciphers`. Real name is `client_tls13_ciphers` (and `server_tls13_ciphers`). Source: https://www.pgbouncer.org/config.html ; 1.25.0 release notes.
- Line 416: "PG18 client-side direct TLS startup". Direct TLS was introduced in PostgreSQL 17; 1.25.0 notes: "client-side direct TLS connections. This allows clients to using the faster TLS connection setup that was introduced in PostgreSQL 17. PgBouncer cannot (yet) connect to PostgreSQL servers using this faster connection setup." Source: https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_25_0
- Line 554 timeline says 1.24.0 added `client_idle_timeout`: matches 1.24.0 notes. Line 556 for 1.25.0 omits `transaction_timeout`, `query_wait_notify`, health check query default changed to empty query; informational.

## Patroni

### Findings

**What**: Releases after 4.1.3: 4.1.4 (2026-07-07) and 4.1.5 (2026-08-12), plus backports 4.0.9-4.0.11 and 3.3.10-3.3.11.
- 4.1.5: compatibility with PG 14.24, 15.19, 16.15, 17.11, 18.6 (new `output_plugin_libraries` GUC restricting logical decoding output plugins); `--validate-config` fixes for `thread_stack_size` and `synchronous_mode: quorum`.
- 4.1.4: `patroni_postgres_timeline` metric type changed from counter to gauge; Patroni-managed replication slots with `wal_status=lost` are now dropped and recreated; `pg_stat_statements.track` forced to `none` for the monitoring query; watchdog no longer stopped before client backends exit; `NOTIFY_SOCKET` checked before importing `systemd`.
- 4.1.2 (2026-04-21) and 4.1.1 (2026-04-08), also after our PG-support text: `notify-reload` systemd unit type, `thread_pool_size` and `restapi.thread_pool_size`, Python 3.14 compatibility, Etcd authentication changes for etcd 3.6.9 / 3.5.28 / 3.4.42 security releases (topology reads and lease keepalive now need auth), `basebackup` server-side `compress` allowed.
- 4.1.0 (2025-09-23) features absent from our file: `patronictl demote-cluster` / `promote-cluster`, `sync_priority` tag, `restapi.server_tokens`, `kubernetes.bootstrap_labels`, receive/replay LSN and lag in `/cluster` and `patronictl list`, `cluster_type` on permanent slots, `--print` for `--validate-config`.
- 4.0.0 (2024-08-29) breaking "master" to "primary" rename: K8s `role` label default is `primary` (override via `kubernetes.leader_label_value` / `standby_leader_label_value`), REST API returns `primary`, `patroni_master` metric removed, `patronictl --master` removed, `bootstrap.users` removed. Quorum-based synchronous replication is a 4.0.0 feature.
- Not in any release as of 4.1.5 (exists on `master`, 127 commits ahead of v4.1.5 on 2026-11-13): role-specific `parameters_primary/replica/standby_leader`, `pg_hba_primary/...`, `pg_hosts` ("PostgreSQL 19+ only"), `manage_synchronized_standby_slots` ("PostgreSQL 17+ only"), `primary_race_backoff`. Confirmed absent from tag v4.1.5 docs.
- Config naming: `primary_start_timeout` and `primary_stop_timeout` are the documented names; `master_start_timeout` / `master_stop_timeout` still work as backward-compatible aliases (`patroni/global_config.py` at v4.1.5).

**Where found**: https://patroni.readthedocs.io/en/latest/releases.html ; https://raw.githubusercontent.com/patroni/patroni/master/docs/releases.rst ; https://github.com/patroni/patroni/releases (v4.1.5) ; https://raw.githubusercontent.com/patroni/patroni/v4.1.5/patroni/global_config.py ; https://raw.githubusercontent.com/patroni/patroni/master/docs/dynamic_configuration.rst (unreleased keys).

**Affects**: `79-patroni.md` lines 226 (`master_start_timeout`), 494 and 756 (latest "v4.1.3"), 496-508 (timeline, several wrong dates), 508 (PG-version rule), 703-704, 712 (Python claim).

**Action**: update. Fix timeline dates (see stale-claims table), add 4.1.x notes, rename to `primary_start_timeout`, add 4.0.0 breaking changes, add `demote-cluster`/`promote-cluster`. Do not document master-only keys as released.

## pgBackRest

### Findings

**What**: 2.59.0 (2026-07-20), 2.59.1 (2026-08-17), 2.59.2 (2026-09-27), 2.59.3 (2026-10-04), 2.60.0 (2026-10-18).
- 2.59.0: PostgreSQL 19beta2 support (2.59.1 beta3, 2.59.2 beta4). BREAKING: "only the restore command may be run as root by default. Use `allow-root` to run other commands as root". New options: `archive-expire-before`, `archive-push-batch-size`. S3 Outposts and S3 process authentication, configurable S3 STS endpoint, Azure batch delete, systemd notify integration (new optional libsystemd dependency), per-repo backup progress in `info`, C11 minimum.
- 2.59.3: security fix, weak encryption subkeys/salts could be generated if reading system random data failed (https://pgbackrest.org/news.html#weak-encryption). Relevant to the encryption-at-rest row.
- 2.60.0: BREAKING: restore now errors if any restored file has an invalid page checksum; `expire` refuses to expire if the oldest retained backup would contain checksum errors (this also blocks WAL archive expiry). New option `checksum-page-error=n` restores warn-only behavior. GCS Workload Identity Federation; object-store prefetch for multi-file/range reads; OpenSSL 4 support.
- Supported PG range: pgBackRest 2.49 removed 9.3 (2023-11-27); nothing in 2.59 / 2.60 removes PG 14.
- PG18 support first shipped in 2.55.0 on 2025-04-21 ("Verification Improvements and PostgreSQL 18 Support"), not April 2024.
- Block incremental backup is 2.45 (beta, 2023-03-20) / 2.46 (GA, 2023-05-22), requires `repo-block` plus `repo-bundle`. Not 2.32 (2.32 = "Repository Commands", 2021-02-08).

**Where found**: https://github.com/pgbackrest/pgbackrest/releases (tags release/2.59.0 ... release/2.60.0, release/2.55.0, release/2.46) ; https://pgbackrest.org/release.html ; https://pgbackrest.org/ ("v2.60.0 is the current stable release").

**Affects**: `85-backup-tools.md` lines 85 (version and "Jan 2025"), 87, 90, 197, 213, 522, 920, 970; line 475 and ~513 (`archive_library`, see Not verified).

**Action**: update. New "pgBackRest 2.59/2.60 breaking changes" gotcha (allow-root, checksum-page-error). Update PG support to include PG19 (2.59+).

## Barman

### Findings

**What**: 3.19.0 (2026-05-20), 3.19.1 (2026-05-26), 3.20.0 (2026-08-27), 3.20.1 (2026-09-29).
- 3.19.0: restore from cloud storage for `backup_method = local-to-cloud` or `postgres` via the standard `barman restore`; new `barman cloud-wal-restore` command usable as `restore_command` with parallel fetching; new `barman export-backup` and `barman import-backup` (tarball).
- 3.20.0: BREAKING: Barman requires Python 3.12 or later. New `barman-wal-archive --parallel N` with `--prefetch-cache-dir`; S3 SSE-C (`--sse-customer-key`, server param `aws_sse_customer_key`); GCS multipart/parallel uploads; `barman check-archived-wal-range`; `barman receive-wal --stop` deprecated in favor of `barman terminate-process <server> receive-wal`; `barman-cloud-backup --keepalive-interval` (default 60 s); S3 access-point ARN destinations; `barman-cloud-wal-restore` exits 2 on network failure.
- 3.20.1: CVE-2026-93853 (privilege escalation that could delete unrelated cloud snapshots via a tampered `backup.info`); `barman-cloud-wal-restore` now prefers complete WAL over `.partial`.

**Where found**: https://github.com/EnterpriseDB/barman/releases (tags release/3.19.0, 3.19.1, 3.20.0, 3.20.1) ; https://docs.pgbarman.org/release/3.20.1/ .

**Affects**: `85-backup-tools.md` lines 85, 232 (docs URL 3.18.0), 315 and 333 (cloud variant described as backup-only, "without local catalog"; restore from cloud is new in 3.19.0), 324, 476 ("Not as of 3.18.0"), 956, 976.

**Action**: update version, add cloud restore and Python 3.12 requirement, note the `archive_library` row is still "not native" (nothing found in 3.19/3.20 notes; see Not verified).

## WAL-G

### Findings

**What**: v3.0.9 (2026-08-20), only release after 3.0.8. Highlights for PostgreSQL: "Support for PG15 base backup protocol", timeline switch check, `system_identifier` converted to uint64; general: new env var `AZURE_BLOB_STORE_API_VERSION`, retry on S3 HTTP 409/499, new metric `walg_s3_upload_time`, new `wal-g st stat` command. libsodium 1.0.22.
- On `master` docs (not tied to a release): a `walg_archive` PostgreSQL extension (https://github.com/wal-g/walg_archive) targeting PG15+ via the `archive_library` GUC; CI runs on PostgreSQL 14-18. Our file says WAL-G has no native `archive_library` support (line 477, "Not natively").

**Where found**: https://github.com/wal-g/wal-g/releases/tag/v3.0.9 ; https://raw.githubusercontent.com/wal-g/wal-g/master/docs/PostgreSQL.md (lines ~605-611, ~779).

**Affects**: `85-backup-tools.md` lines 85, 87 ("9.6 -> 18"), 477, 920, 978.

**Action**: update version; add `walg_archive` extension note (state it is documented on master, repo separate from the WAL-G releases).

## CloudNativePG

### Findings

**What**: 1.30.0 (2026-06-29) and 1.30.1 (2026-09-23); 1.29.2 (2026-06-29) and 1.29.3 (2026-09-23).
- Supported versions (1.30.0 notes): Kubernetes 1.36, 1.35, 1.34; PostgreSQL 18, 17, 16, 15, 14; default image 18.4 (1.30.1: 18.6-system-trixie); "PostgreSQL 14 support ends on November 12, 2026". 1.29.0 notes list the same PG range (14-18) and Kubernetes 1.35, 1.34, 1.33. PG13 is not supported in 1.29.x either (supported-releases doc: "Starting from November 13, 2025, Postgres 13 is no longer supported").
- 1.30.0 features: `.spec.primaryLease` (Kubernetes `Lease` as promotion mutex), new `DatabaseRole` CRD (`databaseRoleReclaimPolicy` `retain`/`delete`, optional `clientCertificate` for `cert` auth), `Pooler` `spec.pgbouncer.imageCatalogRef` plus `status.phase`, `Pooler` metrics TLS (`.spec.monitoring.tls.enabled`), `Cluster` scale subresource selector (VPA/HPA), `pg_upgrade` in-place major upgrade to PG19+ for clusters using Image Volume extensions, instance serial reuse (`status.latestGeneratedNode` deprecated).
- 1.30.0 behavior/security changes: operator SCRAM-SHA-256-encodes cleartext role passwords (opt out per Secret with annotation `cnpg.io/passwordPassthrough: "enabled"`; CVE-2026-55765); `search_path` pinned on operator connections (CVE-2026-55769); authenticated operator-to-instance-manager calls (GHSA-7qwx-x8ff-3px9, not backported); `cluster` reference now immutable on `Database`, `Pooler`, `Publication`, `Subscription`, `ScheduledBackup`.
- Native (in-tree) Barman Cloud (`barmanObjectStore`) is deprecated in favor of the Barman Cloud Plugin. 1.30.0 notes say removal moved to 1.31.0; the current supported-releases page says "1.31 is the last minor release that ships with native Barman Cloud support. It is removed starting from 1.32.0."
- 1.30.1: `auth_user` allowed in `spec.pgbouncer.parameters`; `restoreAdditionalCommandArgs` for in-tree Barman recoveries.

**Where found**: https://github.com/cloudnative-pg/cloudnative-pg/releases/tag/v1.30.0 ; .../v1.30.1 ; .../v1.29.0 ; https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/docs/src/supported_releases.md (table: 1.30.x supports K8s 1.34-1.36 and PG 14-18; 1.29.x K8s 1.33-1.35 and PG 14-18).

**Affects**: `92-kubernetes-operators.md` lines 99, 105 ("13-18"), 371 ("PG13-18"), 537 ("K8s 1.27+"), 587; lines 148, 424 and 635-674 use in-tree `barmanObjectStore` (deprecated; line 106/327 mention Plugin CR).

**Action**: update versions and support matrix; flag `barmanObjectStore` as deprecated with the plugin path as primary; add `DatabaseRole`, primary lease, password SCRAM behavior.

## Zalando postgres-operator

### Findings

**What**: v2.0.0 (2026-07-27), v2.0.1 (2026-07-29), v2.0.2 (2026-08-20), v2.0.3 (2026-10-02). v2.0.0 has a type-mismatch bug in the OperatorConfiguration CRD (its own notes: see v2.0.1); use 2.0.1 or newer. v2.0.1 is the real feature release.
- New: PostgreSQL 18 support, NodePort service type, TopologySpreadConstraint, configurable liveness probe, IRSA support, global maintenance windows (can be disabled), `envFrom`, standby `primary slot name`, CRD manifests generated from Go structs, Helm charts published to ghcr.io.
- Breaking (v2.0.1): dropped PostgreSQL 13 support; `kubernetes_use_configmaps` default is now `true` (endpoints are deprecated from K8s 1.33); password encryption defaults to `scram-sha-256` (forces a rolling update); dropped `enable_ebs_gp3_migration*`, `enable_crd_validation`, manifest fields `useLoadBalancer`, `replicaLoadBalancer`, `pod_priority_class_name`, `init_containers`; dropped kubectl-pg plugin. Migration guide: https://raw.githubusercontent.com/zalando/postgres-operator/master/docs/migrate.md
- v2.0.2: Go module path now `/v2` (breaking for library users).
- v2.0.3: pooler connections default to `scram-sha-256`; anyone relying on `md5` for pooler connections must set `password_encryption: md5`.
- Default Spilo image per release notes: `ghcr.io/zalando/spilo-17:4.1-p2`. The migrate.md text on master says `spilo-18:4.1-p2`; the two primary sources disagree (see Not verified).

**Where found**: https://github.com/zalando/postgres-operator/releases/tag/v2.0.0 ; .../v2.0.1 ; .../v2.0.2 ; .../v2.0.3.

**Affects**: `92-kubernetes-operators.md` lines 99 (v1.15.1), 105 ("13-17 stable, 14+ for PG18"), 371, 505, 589, and any Zalando YAML relying on endpoints or md5.

**Action**: update version, PG range (14-18 implied by dropping 13 and adding 18), add v1 to v2 migration warning.

## Crunchy PGO

### Findings

**What**: GitHub releases: v6.0.2 (2026-06-02) is the latest release object. Tag v6.0.3 exists (commit 2026-08-20) and the 6.0.x release notes document 6.0.3, but no GitHub release object was published for it.
- Component versions (6.0.x release notes): 6.0.3 ships Postgres 18.6, pgBackRest 2.59.0, PgBouncer 1.25, Patroni 4.1.4, pgAdmin 9.17, Postgres Exporter 0.19.1; also pgaudit 17.1 and pgvector 0.8.6. 6.0.2 pins PgBouncer 1.25.2.
- Supported platforms (6.0.x): Kubernetes 1.32-36, OpenShift 4.16-22, Postgres 14-18. 5.8.x: Kubernetes 1.30-36, OpenShift 4.14-22, PG 14-18.
- 6.0.0 (2025-12-08): `PostgresCluster` v1 CRD is available (v1beta1 still accepted; upgrade guide linked from the release notes). Breaking: max 50 PgBouncer config settings, max 16 InstanceSets in v1, pgAdmin 4.30 deployments not possible with v1 (use the `PgAdmin` API), Postgres log directory now outside the data directory by default. `AutoGrowVolumes` feature gate enabled by default. Helm installer is OCI-only.

**Where found**: https://access.crunchydata.com/documentation/postgres-operator/6.0/releases/6.0.x ; https://access.crunchydata.com/documentation/postgres-operator/6.0/overview/supported-platforms ; https://github.com/CrunchyData/postgres-operator/releases (v6.0.2) ; tag v6.0.3.

**Affects**: `92-kubernetes-operators.md` lines 99, 243 (`apiVersion: ...v1beta1`, still valid but v1 now exists), 371, 537 ("Crunchy v6.0.x targets K8s 1.22-1.26+" is wrong), 593 ("OpenShift 4.8-4.13").

**Action**: update version, K8s and OpenShift ranges; mention `v1` CRD.

## Official Docker image

### Findings

**What**: Current tag list from https://raw.githubusercontent.com/docker-library/official-images/master/library/postgres (read 2026-11-14):
- `19rc2` / `19rc2-trixie` / `19rc2-bookworm` / `19rc2-alpine3.24` / `19rc2-alpine3.23` exist. No `19` or `19.x` tag. PG19 is not GA (see top of report). A release candidate is not a production tag.
- `latest` = `18.7`, `18`, `18-trixie`, `trixie` (so `latest` is PG18, Debian trixie). Majors published: 19rc2, 18.7, 17.12, 16.16, 15.20, 14.25.
- Debian default is `trixie` (`postgres:18` and `postgres:17` are trixie, not bookworm). `bookworm` variants are still published for 14-19.
- Alpine variants are now `alpine3.24` (default `alpine`) and `alpine3.23`; `alpine3.22` is no longer published.
- PGDATA change in 18+: `ENV PGDATA /var/lib/postgresql/18/docker` and `VOLUME /var/lib/postgresql` (https://raw.githubusercontent.com/docker-library/postgres/master/18/trixie/Dockerfile, line 189 comment: "in 18+, PGDATA has changed to match the pg_ctlcluster standard directory structure, and the VOLUME has moved from /var/lib/postgresql/data to /var/lib/postgresql"). Same for 19 (`/var/lib/postgresql/19/docker`). PG14-17 keep `PGDATA=/var/lib/postgresql/data` and `VOLUME /var/lib/postgresql/data` (17/trixie Dockerfile).
- Practical effect: mounting a volume at `/var/lib/postgresql/data` on a 18+ image no longer persists the cluster (data lives under `/var/lib/postgresql/18/docker`); mount at `/var/lib/postgresql` instead.

**Affects**: `91-docker-postgres.md` line 33 ("`bookworm`/`trixie` default", "`alpine3.22`/`alpine3.23`", "Currently 5 majors published (14..18)"), 48, 51, 52 (`postgres:17` = bookworm), 70-73 (variant table), 91 (`PGDATA` default `/var/lib/postgresql/data` for all versions), 114-123 and 170-220 (volume mounts at `/var/lib/postgresql/data`, fine for 17 but wrong for 18), 575-583 (Recipe 11 uses `postgres:18-bookworm` with `pgdata:/var/lib/postgresql/data`, which will not persist data), 642, 686, 77/371/415/562/632 (pinned `17.9`; current 17.12).

**Action**: update. New section on the 18+ PGDATA / VOLUME change (including `pg_upgrade --link` implication of the versioned directory), fix Recipe 11, update variant table to trixie default and alpine3.24, add a 19rc2 note.

## pgaudit

### Findings

**What**: No new stable release since 18.0 (2025-09-24). Pre-release `19rc1` (2026-10-27) adds "PostgreSQL 19 support". Fixes in 19rc1 include: only audit a statement's own permission check, do not audit non-enforcing permission checks, report rows affected by COPY with `pgaudit.log_rows`, do not log inserted/updated columns against the SELECT grant, memory leak when logging functions and query parameters.
- README difference 18.0 to 19rc1: adds "Audit logging is best-effort and not transactional", with the explanation that committed transactions may lack entries and rolled-back statements may still be logged. The settings list (`pgaudit.*`) is identical to our file's list; no new GUCs.
- README 18.0 says "PostgreSQL 13 or greater"; 19rc1 says "PostgreSQL 14 or greater" and drops the `v1.5.X` (PG13) line. `REL_19_STABLE` branch exists.

**Where found**: https://github.com/pgaudit/pgaudit/releases/tag/19rc1 ; https://raw.githubusercontent.com/pgaudit/pgaudit/19rc1/README.md ; https://raw.githubusercontent.com/pgaudit/pgaudit/18.0/README.md.

**Affects**: `51-pgaudit.md` lines 238-251 (compat matrix: no `19.X` row), 609 and 614 (footnotes "latest 18.0").

**Action**: new row `19.X` (pre-release 19rc1); add the best-effort / non-transactional caveat. No config change.

## pg_repack and pg_squeeze

### Findings

**pg_repack**: latest tag `ver_1.5.3` (commit 2025-10-26; no GitHub release object). 1.5.3: cleanup of temp indexes on error with `--only-indexes`; full-table repack takes SHARE UPDATE EXCLUSIVE instead of ACCESS SHARE on the target; fixes subtransaction cache overflow. 1.5.2 (2024-12-16): non-superusers can now run pg_repack; `--error-on-invalid-index` is the default. 1.5.1 added PG17 support and `--apply-count`.
- Unreleased on `master` (as of 2026-11-13): PG19 support (PR #483, README lists "9.5 ... 18, 19"), `PG_MODULE_MAGIC_EXT` for PG18+, removal of `SECURITY DEFINER` from `repack_trigger()` (2026-10-27), schema-qualified names and pinned `search_path` in the SQL and client (2026-11-13), cancel in-progress index builds on SIGINT with `--jobs` (#489). These look like a security hardening series; no release yet, so there is no fixed version to recommend.
- Related PG19 development: PostgreSQL 19 documents a core `REPACK [ ( option [, ...] ) ] [ table_and_columns [ USING INDEX [ index_name ] ] ]` command with a `CONCURRENTLY` option, "rewrite a table to reclaim disk space" (https://www.postgresql.org/docs/19/sql-repack.html, RC docs). This is a candidate "see also" in the online-reorg section once PG19 is GA.

**pg_squeeze**: 1.9.0 (2025-08-04) PG18 support; 1.9.1 (2025-09-15) fixes missing SQL extension version bump (1.9.0 shipped without bumping, so `ALTER EXTENSION pg_squeeze UPDATE` matters); 1.9.2 (2026-06-19) security fix, index functions no longer run as superuser (now run as table owner) and search path restricted to `pg_catalog, pg_temp`, plus fix for identity indexes with `INCLUDE` columns; 1.9.3 (2026-06-19) supports PG19 and removes PG13; 1.9.4 (2026-07-29) properly quotes schema/table names (arbitrary SQL via `squeeze.worker_role` before). 1.8.0 (2025-01-24) fixed a data-corruption bug in `squeeze.squeeze_table()` when concurrent DDL ran.

**Where found**: https://raw.githubusercontent.com/reorg/pg_repack/master/doc/pg_repack.rst ("Releases" section) ; https://github.com/reorg/pg_repack/commits/master ; https://github.com/cybertec-postgresql/pg_squeeze/releases (REL1_9_0 ... REL1_9_4).

**Affects**: `26-index-maintenance.md` lines 356 and 734 ("requires superuser" for pg_repack; stale since 1.5.2) ; 332-397 (no version information at all, so security releases and PG support are undocumented); 736 (`wal_level = logical`: still true per pg_squeeze README line 42).

**Action**: update (small). Fix superuser claim, add minimum safe versions (pg_squeeze >= 1.9.2 for the privilege escalation fix and >= 1.9.4 for quoting; pg_repack unreleased fixes noted), add the PG19 `REPACK` pointer.

## postgres_exporter

### Findings

**What**: 0.20.0 (2026-06-29) and 0.20.1 (2026-07-08). 0.20.0 contains breaking changes:
- Collector `replication_slot` renamed to `replication_slots`: `--collector.replication_slot` becomes `--collector.replication_slots`.
- Metrics renamed from `pg_replication_slot_*` to `pg_replication_slots_*` (`..._slot_current_wal_lsn`, `..._slot_confirmed_flush_lsn`, `..._slot_is_active`, `..._safe_wal_size_bytes`, `..._wal_status`).
- `--disable-settings-metrics` flag and `PG_EXPORTER_DISABLE_SETTINGS_METRICS` removed; use `--no-collector.settings`.
- `settings`, `stat_activity`, `stat_archiver`, `stat_replication`, `replication_slots` are now standalone collectors: they no longer honor `--metric-prefix`, no longer carry `constantLabels`, and are no longer disabled by `--disable-default-metrics`.
- Container images now published to GHCR.
- 0.20.1: fixes `stat_replication` "slot_name does not exist" error.
- README at v0.20.1: `extend.query-path` (custom `queries.yaml`) is DEPRECATED, as are `auto-discover-databases`, `constantLabels`, `exclude-databases`, `include-databases`; README recommends built-in collectors, or sql_exporter for generic SQL. Default-enabled collectors per README: `database`, `locks`, `replication`, `replication_slots`, `settings`, `stat_activity`, `stat_archiver`, `stat_bgwriter`, `stat_database`, `stat_progress_vacuum`, `stat_replication`, `stat_user_tables`, `statio_user_tables`, `wal`. Default-disabled: `stat_checkpointer`, `stat_statements`, `database_wraparound`, `long_running_transactions`, `postmaster`, `process_idle`, `stat_activity_autovacuum`, `stat_wal_receiver`, `statio_user_indexes`, `xlog_location`.
- "CI Tested PostgreSQL versions: 13, 14, 15, 16, 17, 18."
- 0.19.x (after our 0.19.1 footnote) is covered; Crunchy 6.0.3 ships Postgres Exporter 0.19.1.

**Where found**: https://github.com/prometheus-community/postgres_exporter/releases/tag/v0.20.0 ; .../v0.20.1 ; https://raw.githubusercontent.com/prometheus-community/postgres_exporter/v0.20.1/README.md.

**Affects**: `82-monitoring.md` lines 58 ("v0.19+"), 93 and 878 (v0.19.1), 108-125 (collector table: `replication_slot` renamed; `stat_checkpointer` is default-disabled, not default for PG17+; missing newer collectors), 127-152 and 397-410 and 540-570 and 697 (custom `queries.yaml` via `--extend.query-path`, now deprecated), 835 (cardinality gotcha; still applicable).

**Action**: update. Rename collector and metric prefix, add 0.20 breaking-change callout and alert-rule migration, mark `queries.yaml` approach as deprecated, fix the default-collector table.

## Stale claims in our skill

| file:line | current text | corrected fact | source |
|---|---|---|---|
| 81-pgbouncer.md:48, 378, 907 | `max_prepared_statements` default 200 "since pgBouncer 1.21" | Default became 200 in 1.24.0 (2025-01-10); 1.21 required setting it non-zero | https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_24_0 |
| 81-pgbouncer.md:235 | `client_tls_tls13_ciphers` | `client_tls13_ciphers` (and `server_tls13_ciphers`) | https://www.pgbouncer.org/config.html |
| 81-pgbouncer.md:416 | "PG18 client-side direct TLS startup" | Direct TLS startup is a PostgreSQL 17 feature; PgBouncer 1.25+ accepts it from clients only, cannot yet use it to servers | https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_25_0 |
| 81-pgbouncer.md:107, 320, 326, 790-800, 906 | `SUSPEND`, online restart, socket-passing Recipe 11 | `-R` online restart, `SHOW FDS`, `SUSPEND` removed in 1.26.0; use `so_reuseport` rolling restarts | https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_26_0 |
| 81-pgbouncer.md:558-560, 925 | "Latest at write time = 1.25.2" | 1.26.1 (2026-10-14) | https://github.com/pgbouncer/pgbouncer/releases |
| 79-patroni.md:494, 506, 756 | latest "v4.1.3 (2026-05-05)" | 4.1.5 (2026-08-12) | https://github.com/patroni/patroni/releases |
| 79-patroni.md:503 | 3.3 "2024-08", quorum-based sync replication | 3.3.0 released 2024-04-04; quorum-based failover is 4.0.0 (2024-08-29) | https://raw.githubusercontent.com/patroni/patroni/master/docs/releases.rst |
| 79-patroni.md:502 | 3.2 "2024-01", `failsafe_mode` | 3.2.0 released 2023-10-25; DCS failsafe mode was introduced in 3.0.0 (2023-01-30) | same |
| 79-patroni.md:504 | 4.0 "2025-05", "Drops Python 3.6/3.7", PG17 support | 4.0.0 released 2024-08-29 (PG17 beta3 compat, "master" to "primary" breaking rename); Python 3.7 floor was announced in 3.0.0 notes; no 4.0 note drops Python versions | same |
| 79-patroni.md:505 | 4.1 "2025-12", PG18 support, etcd v2 deprecated, monotonic-clock handling | 4.1.0 released 2025-09-23; PG18 RC1 support landed in 4.0.7 (2025-09-22); the 4.1.0 notes list no etcd v2 deprecation | same |
| 79-patroni.md:712 | "Patroni 4.0 dropped Python 3.6 and 3.7 support" | Not in 4.0.0 release notes; see Not verified | same |
| 79-patroni.md:226 | `master_start_timeout` | Documented name is `primary_start_timeout`; `master_start_timeout` kept as alias | https://raw.githubusercontent.com/patroni/patroni/v4.1.5/patroni/global_config.py |
| 85-backup-tools.md:85, 970 | pgBackRest "2.58.0 (Jan 2025)" | 2.58.0 released 2026-01-19; latest is 2.60.0 (2026-10-18) | https://github.com/pgbackrest/pgbackrest/releases |
| 85-backup-tools.md:90, 197 | block-level incremental "since 2.32" | 2.45 (beta, 2023-03-20) / 2.46 (GA, 2023-05-22); needs `repo-block` + `repo-bundle` | https://github.com/pgbackrest/pgbackrest/releases/tag/release/2.46 |
| 85-backup-tools.md:213, 522 | "PG18: experimental support since pgBackRest 2.55 (April 2024)" | 2.55.0 released 2025-04-21 | https://github.com/pgbackrest/pgbackrest/releases/tag/release/2.55.0 |
| 85-backup-tools.md:87, 920 | PG support "9.4 -> 18" / "PG18 experimental" | PG19 supported from 2.59.0; 9.3 removed in 2.49, so 9.4 floor claim unchanged but PG19 missing | https://github.com/pgbackrest/pgbackrest/releases/tag/release/2.59.0 |
| 85-backup-tools.md:85, 232, 956, 976 | Barman 3.18.0 | 3.20.1 (2026-09-29); 3.20.0 requires Python 3.12+ | https://github.com/EnterpriseDB/barman/releases |
| 85-backup-tools.md:85, 978 | WAL-G 3.0.8 | 3.0.9 (2026-08-20) | https://github.com/wal-g/wal-g/releases |
| 85-backup-tools.md:477 | WAL-G `archive_library` "Not natively" | master docs describe the `walg_archive` extension for PG15+ | https://raw.githubusercontent.com/wal-g/wal-g/master/docs/PostgreSQL.md |
| 92-kubernetes-operators.md:99, 105, 371, 587 | CNPG "v1.29.1", supported PG "13-18" | 1.30.1 latest; supported PG 14-18 (14 ends 2026-11-12); PG13 unsupported since 2025-11-13 | https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/docs/src/supported_releases.md |
| 92-kubernetes-operators.md:537 | "CNPG v1.29.x targets K8s 1.27+" | 1.29.x: K8s 1.33-1.35; 1.30.x: K8s 1.34-1.36 | same |
| 92-kubernetes-operators.md:99, 105, 371, 505, 589 | Zalando "v1.15.1", "PG13-17 stable, PG18 from 14+" | v2.0.3 latest; v2 dropped PG13, added PG18; default scram-sha-256, configmaps instead of endpoints | https://github.com/zalando/postgres-operator/releases/tag/v2.0.1 |
| 92-kubernetes-operators.md:99, 537, 593 | Crunchy "v6.0.1", "K8s 1.22-1.26+", "OpenShift 4.8-4.13" | 6.0.3 in release notes (tag 2026-08-20); K8s 1.32-36, OpenShift 4.16-22, PG 14-18 | https://access.crunchydata.com/documentation/postgres-operator/6.0/overview/supported-platforms |
| 91-docker-postgres.md:33, 52, 70-73 | Debian default `bookworm`; `postgres:17` = bookworm; `alpine3.22`/`alpine3.23` | Default Debian is trixie; Alpine tags are alpine3.24 and alpine3.23 | https://raw.githubusercontent.com/docker-library/official-images/master/library/postgres |
| 91-docker-postgres.md:91, 575-583 | `PGDATA` default `/var/lib/postgresql/data`; PG18 recipe mounts `pgdata:/var/lib/postgresql/data` | 18+: `PGDATA=/var/lib/postgresql/18/docker`, `VOLUME /var/lib/postgresql`; mount `/var/lib/postgresql` | https://raw.githubusercontent.com/docker-library/postgres/master/18/trixie/Dockerfile |
| 91-docker-postgres.md:33 | "Currently 5 majors published (14..18)" | 19rc2 tags exist; no `19` GA tag | https://raw.githubusercontent.com/docker-library/official-images/master/library/postgres |
| 51-pgaudit.md:244, 609, 614 | pgaudit 18.0 latest, no PG19 row | `19rc1` pre-release (2026-10-27) adds PG19 support | https://github.com/pgaudit/pgaudit/releases/tag/19rc1 |
| 26-index-maintenance.md:356, 734 | pg_repack "requires superuser" | Non-superuser runs allowed since 1.5.2 (2024-12-16) | https://raw.githubusercontent.com/reorg/pg_repack/master/doc/pg_repack.rst |
| 82-monitoring.md:58, 93, 878 | postgres_exporter v0.19.1 | 0.20.1 (2026-07-08) | https://github.com/prometheus-community/postgres_exporter/releases |
| 82-monitoring.md:108-125 | collector `replication_slot`; `stat_checkpointer` PG17+ default | Renamed `replication_slots` (0.20.0); `stat_checkpointer` default disabled | https://raw.githubusercontent.com/prometheus-community/postgres_exporter/v0.20.1/README.md |
| 82-monitoring.md:152, 410, 543, 568, 697 | custom metrics via `--extend.query-path` / `queries.yaml` | Flag is DEPRECATED in favor of built-in collectors | same README |

## Not verified

- PostgreSQL 19 support for PgBouncer, Barman, WAL-G, and postgres_exporter: no release note or README states it. PgBouncer 1.26.0 only references PG14+ and PG18+. Do not claim support either way.
- Patroni PG19 release status: only unreleased master documents `pg_hosts` for PG19+. Whether 4.1.5 runs on PG19 is not stated by the 4.1.5 notes (its compatibility line stops at 18.6).
- Patroni "4.0 dropped Python 3.6/3.7" (our line 712): the 3.0.0 notes say "Upcoming release will drop support of Python versions older than 3.7" and the 3.0.2 note says it "dropped support of Python older than 3.6", and `setup.py` on master still lists 3.6 and 3.7 classifiers. I could not confirm any Python drop in 4.0.0; I did not fetch `python_requires`.
- Patroni 3.0 "REST API auth required by default for control endpoints" (our line 500) and 3.1 "Kubernetes Endpoints v1 (replaces v1beta1)" (line 501): not found in the release notes I searched; not confirmed or refuted.
- Patroni etcd v2 status: no release note says "deprecated" in 4.1.0; `docs/yaml_configuration.rst` marks only Raft as "(deprecated)". Not verified whether `etcd:` (v2) is formally deprecated.
- pgBackRest `archive_library` (our lines 475 and ~513, "supported since 2.42", `archive_library = 'pgbackrest-archive-push'`): I found zero occurrences of `archive_library` in https://pgbackrest.org/release.html. I found no primary source for a pgBackRest loadable archive module; treat the claim as unsupported until a source is found. I did not search the pgBackRest user guide.
- pgBackRest "standby backup since 2.32" (line 100): not located in release notes; `backup-standby` is documented, but the introducing release was not checked.
- Barman "Standby backup since 2.4", "PG 9.4 -> 18" (lines 87, 100): not checked; Barman docs did not expose a supported-versions statement in the pages I fetched.
- WAL-G "PG 9.6 -> 18" and "PostgreSQL 3.x for PG18" claims (lines 87, 920): not confirmed; only the master docs line "PostgreSQL 14-18" for CI.
- `walg_archive` extension: described on WAL-G master docs only; I did not check whether it is released or its stability.
- Zalando default Spilo image: the v2.0.x release bodies say `spilo-17:4.1-p2`; `docs/migrate.md` on master says `spilo-18:4.1-p2`. I could not tell which is correct for 2.0.3.
- Crunchy PGO v6.0.3 publication date: only the tag commit date (2026-08-20) is known; there is no GitHub release object, and the docs page gives no date.
- pg_repack 1.5.3 release date: only the tag commit date (2025-10-26) is known (no GitHub release object). The unreleased master commits (SECURITY DEFINER removal, search_path pinning) are not described upstream as CVEs; I did not look for advisories.
- Whether PG 19 GA will include `REPACK` unchanged: the RC docs describe it; RC2 is not final.
- Barman and CloudNativePG disagree in plan wording on in-tree Barman Cloud removal (1.30.0 notes: removed in 1.31.0; supported-releases doc on `main`: shipped through 1.31, removed from 1.32.0). I cite the later doc as current.

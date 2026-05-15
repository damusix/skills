# Backup Tools — pgBackRest, Barman, WAL-G

Production-grade backup tooling that wraps `pg_basebackup` + WAL archiving with retention, parallelism, encryption, verification, and multi-cloud object-storage targets.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Tool Comparison](#tool-comparison)
- [pgBackRest](#pgbackrest)
- [Barman](#barman)
- [WAL-G](#wal-g)
- [Cross-Tool Operational Patterns](#cross-tool-operational-patterns)
- [Per-Version PostgreSQL Surface](#per-version-postgresql-surface)
- [Recipes](#recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick this file when:

- Deploying production backup for self-hosted PostgreSQL.
- Comparing pgBackRest vs Barman vs WAL-G capabilities.
- Configuring multi-cloud object-storage backup targets (S3, GCS, Azure Blob).
- Setting up parallel + incremental + compressed + encrypted backups.
- Designing retention policies (count-based, time-based, archival).
- Pairing backup-tool output with [`82-monitoring.md`](./82-monitoring.md) alerting.
- Choosing between tool-native incremental and PG17+ `pg_basebackup --incremental` (cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md)).

Pick a different file when:

- Need raw `pg_basebackup` + `archive_command` mechanics → [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).
- Need logical-backup (`pg_dump` / `pg_restore`) → [`83-backup-pg-dump.md`](./83-backup-pg-dump.md).
- Need pg_upgrade or major-version upgrade → [`86-pg-upgrade.md`](./86-pg-upgrade.md) / [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).
- DR planning + cross-region failover runbook → [`90-disaster-recovery.md`](./90-disaster-recovery.md).

## Mental Model

Five rules.

**Rule 1 — Production-grade backup ≠ `pg_basebackup` alone.** Raw `pg_basebackup` does the bytes-from-running-cluster part. Production needs: retention enforcement, parallel transfer, compression, encryption, multi-target replication, archive verification, integrity checks, monitoring hooks. The three canonical tools (pgBackRest, Barman, WAL-G) wrap `pg_basebackup` and `archive_command`/`archive_library` with that operational layer.

**Rule 2 — Three canonical open-source tools.** pgBackRest (MIT, original author David Steele), Barman (GPLv3, EnterpriseDB-maintained), WAL-G (Apache 2.0, originally Citus/Microsoft, now multi-vendor). All three are actively maintained as of 2025-2026. Each has distinct strengths — see [Tool Comparison](#tool-comparison).

**Rule 3 — Each provides full + incremental + parallel + encrypted backup with object-storage targets.** No tool requires you to choose between features. All three support full + incremental, parallel transfer, compression (lz4/zstd/zlib), encryption at rest, and at least S3/Azure/GCS as remote repositories. Differences are in *defaults*, *operational ergonomics*, and *advanced features* (block-level incremental, async WAL archive, multi-tenant repo).

**Rule 4 — Feature differences matter for the failure-mode you care about.** pgBackRest block-level incremental + parallel restore = fastest big-cluster restore. Barman streaming replication + rsync = strong for centralized multi-cluster backup. WAL-G cloud-native push model + LZ4 default + small footprint = popular for K8s/container deployments. Pick on workload + ops model, not "best tool."

**Rule 5 — Backup-tool failure modes are silent — must monitor.** Common failures: stuck WAL archive (`pg_stat_archiver.failed_count > 0`), retention misconfiguration (backups expire too fast), encryption-key loss (backup undecryptable), verify never run (backup is corrupt and you don't know). Pair every deployment with [`82-monitoring.md`](./82-monitoring.md) alerts on archive failure, last-good-backup age, and verify-status.

> [!WARNING] None of these tools replace `pg_dump` for cross-version or cross-architecture
> All three are *physical* backup tools — they ship bytes. Cannot restore to a different PG major version or different CPU architecture. For those scenarios use `pg_dump` ([`83-backup-pg-dump.md`](./83-backup-pg-dump.md)) or logical replication ([`74-logical-replication.md`](./74-logical-replication.md)).

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Smallest-RPO PITR for big OLTP cluster | pgBackRest (block-level incremental + async archive-push) | `pg_basebackup` alone | Block-level deltas + parallel restore win on TB scale |
| Centralized backup for 10+ clusters | Barman | WAL-G | Barman strong at multi-cluster catalog + ssh-based collection |
| K8s / container deployment with S3 backend | WAL-G | Barman | WAL-G smallest binary, push model, no ssh required |
| Multi-cloud (S3 + Azure + GCS) target | WAL-G or pgBackRest | Barman | Both have first-class multi-cloud; Barman is rsync-first |
| Encryption with KMS | WAL-G (libsodium / SSE-KMS) or pgBackRest (AES-256) | Barman (limited) | WAL-G has best KMS story |
| Want to use `pg_basebackup --incremental` (PG17+) | `pg_basebackup` + `pg_combinebackup` directly (cross-reference 84) | Any backup tool | Tools have their own incremental mechanisms predating PG17 |
| Need parallel restore | pgBackRest | Barman, WAL-G | pgBackRest restore-side parallelism is mature |
| Need backup-from-standby | All three | (none) | All support; configure per docs |
| Need scheduled backup with retention | All three with cron | (none) | Schedule via `pg_cron` (cross-reference 98), systemd timer, or external scheduler |
| Need to roll your own | `pg_basebackup` + `archive_command` | All three | Only do this if you have a strong reason — see Recipe 12 |

Three smell signals:

- **Building your own backup script around `pg_dump | gzip > backup.sql.gz` for a production database** — that's a logical export, not a backup. Cross-reference [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) gotcha #25 (pg_dump does NOT dump WAL/bytes).
- **`archive_command` does not retry on failure** — server logs `archive command failed` but no alert fires. Means no alerting on `pg_stat_archiver.failed_count` (cross-reference [`82-monitoring.md`](./82-monitoring.md) Recipe 4).
- **Backups stored on the same host as primary** — cluster fails, backups gone. Off-host (preferably off-region) destination mandatory.

## Tool Comparison

Three-tool matrix. All facts verified against tool docs at planning time (Jan 2026).

| Property | pgBackRest | Barman | WAL-G |
|---|---|---|---|
| License | MIT | GPL 3.0 | Apache 2.0 |
| Latest stable (Jan 2026) | 2.58.0 (Jan 2025) | 3.18.0 (Mar 2026) | 3.0.8 (Jan 2026) |
| Primary language | C + Perl wrappers | Python | Go |
| PG versions supported | 9.4 → 18 (incl. experimental PG18 in 2.55+) | 9.4 → 18 | 9.6 → 18 |
| Repository model | Multi-tier (local + remote) | Server-side catalog | Object-storage-first |
| Backup model | Push (from PG host) | Pull (rsync over ssh) OR streaming (pg_basebackup) | Push (from PG host) |
| Block-level incremental | Yes (since 2.32) | Limited (relies on rsync) | Delta (file-level) |
| Parallel backup | Yes (`process-max`) | Yes (`parallel_jobs`) | Yes (`WALG_UPLOAD_CONCURRENCY`) |
| Parallel restore | Yes | Yes (file-level) | Yes |
| Compression | gz / lz4 / zstd / bz2 (configurable per stanza) | gz / bz2 / xz / pigz / pbzip2 | lz4 (default) / lzma / zstd / brotli |
| Encryption at rest | AES-256-CBC (built-in) | Filesystem-level or pre-encrypt | libsodium / OpenPGP / SSE / SSE-KMS / CSE-KMS |
| TLS in transit | Yes | Via ssh | Yes |
| S3 / GCS / Azure | Yes (all three native) | S3 (cloud_storage_provider) | Yes (all three, plus Alibaba OSS, OpenStack Swift) |
| WAL archival | `archive_command = 'pgbackrest archive-push %p'` or `archive_library` | `archive_command = 'barman-wal-archive ...'` or streaming | `archive_command = 'wal-g wal-push %p'` |
| Restore command | `restore_command = 'pgbackrest archive-get %f %p'` | `restore_command = 'barman-wal-restore ...'` | `restore_command = 'wal-g wal-fetch %f %p'` |
| PITR target | time / xid / name / lsn / immediate | time / xid / name / lsn | time / lsn / immediate |
| Standby backup | Yes (since 2.32; reduces primary I/O) | Yes (since 2.4) | Yes |
| Verify / integrity | `pgbackrest check` + `pgbackrest verify` (page-checksum scan) | `barman check` + `barman verify-backup` | `wal-g backup-verify` |
| Retention policy | count + time + archive-retention | count + time + redundancy | count + days (per backup type) |
| Schedule mechanism | external (cron, systemd, pg_cron) | external | external |
| K8s operator integration | CloudNativePG native | barman-cloud sidecar | WAL-G in CNPG sidecar pattern |
| pgBackRest-native + cluster manager | Patroni + pgBackRest = common pair | repmgr + Barman = common pair | Patroni + WAL-G = common in K8s |

## pgBackRest

Author: David Steele. License: MIT. Site: https://pgbackrest.org/.

### Design

C-based backup-and-restore tool focused on operational simplicity + reliability. Push model from PG host to repository (local filesystem or S3/GCS/Azure). Multi-repository support (write to two repos for redundancy). Async archive-push thread pool keeps WAL archival from blocking primary.

### Configuration model

Single config file: `/etc/pgbackrest/pgbackrest.conf` (and optional `/etc/pgbackrest/conf.d/*.conf` includes). Organized by *stanza* — one stanza per database cluster.

```ini
# /etc/pgbackrest/pgbackrest.conf

[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
repo1-retention-diff=7
repo1-retention-archive=14
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<long-passphrase-from-vault>

# Second repo to S3 (off-site)
repo2-type=s3
repo2-path=/pgbackrest
repo2-s3-bucket=mycompany-pg-backups
repo2-s3-region=us-east-1
repo2-s3-endpoint=s3.amazonaws.com
repo2-s3-key=<access-key>
repo2-s3-key-secret=<secret-key>
repo2-retention-full=8
repo2-retention-archive=30

process-max=8
compress-type=zstd
compress-level=6
log-level-console=info
log-level-file=detail
start-fast=y
archive-async=y
spool-path=/var/spool/pgbackrest

[main]
pg1-path=/var/lib/postgresql/16/main
pg1-port=5432
pg1-user=postgres
```

Primary `postgresql.conf`:

```conf
archive_mode = on
archive_command = 'pgbackrest --stanza=main archive-push %p'
# OR (PG15+ preferred) archive_library = 'pgbackrest-archive-push'
```

### Operational commands

```bash
# Initialize stanza (once)
sudo -u postgres pgbackrest --stanza=main stanza-create

# Full backup
sudo -u postgres pgbackrest --stanza=main --type=full backup

# Differential backup (since last full)
sudo -u postgres pgbackrest --stanza=main --type=diff backup

# Incremental backup (block-level since last backup of any type)
sudo -u postgres pgbackrest --stanza=main --type=incr backup

# Inspect repo
pgbackrest --stanza=main info

# Verify all backups in repo (integrity scan)
pgbackrest --stanza=main verify

# Restore latest full to /var/lib/postgresql/16/main
sudo -u postgres pgbackrest --stanza=main --delta restore

# Point-in-time restore
sudo -u postgres pgbackrest --stanza=main \
    --type=time --target='2026-05-13 12:00:00 UTC' \
    --target-action=promote \
    restore
```

### Incremental backup mechanism

pgBackRest performs **block-level** incremental backup since version 2.32. Each backup tracks per-file modification timestamps + checksums to identify changed blocks. Restore reconstructs from full + diff/incr chain. No dependency on PG17+ `pg_basebackup --incremental`.

### Multi-repository (redundancy)

Configure `repo1-*` and `repo2-*`. Each backup goes to all configured repos. Retention applies per-repo. Object storage repos can have different retention than local.

### Restore-side parallelism

`pgbackrest restore --process-max=16` parallelizes file copy + decompression. Cuts restore time on big clusters dramatically.

### Notable PG-version interaction

- PG10+: required.
- PG12+: full PITR via standby.signal + recovery_target_* GUCs.
- PG15+: can use `archive_library = 'pgbackrest-archive-push'` instead of shell `archive_command`. Reduces overhead.
- PG17+: pgBackRest has *its own* incremental mechanism; does NOT use `pg_basebackup --incremental`.
- PG18: experimental support since pgBackRest 2.55 (April 2024).

### Strengths

- Mature block-level incremental.
- Parallel backup AND parallel restore.
- Async WAL archive thread pool.
- Page-checksum verification (`verify` command).
- Multi-repo (local + cloud at once).
- CloudNativePG operator native integration.

### Weaknesses

- C codebase; harder to extend than Python/Go.
- Single-process model per stanza (cannot back up multiple stanzas in parallel from same `pgbackrest` invocation; can run multiple invocations).
- No native scheduling — relies on cron / pg_cron / systemd / K8s CronJob.

## Barman

Author: EnterpriseDB (formerly 2ndQuadrant). License: GPL 3.0. Site: https://pgbarman.org/. Docs: https://docs.pgbarman.org/release/3.18.0/.

### Design

Python-based centralized backup manager. Pull model — Barman host SSHs to each PG host, copies WAL + base backups. Strong fit for backing up *many* PG clusters from a single centralized Barman server with full catalog. Modern versions also support streaming replication (replacing rsync) and barman-cloud for direct-to-object-storage.

### Configuration model

One global file + one file per backed-up cluster.

```ini
# /etc/barman.conf

[barman]
barman_user = barman
configuration_files_directory = /etc/barman.d
barman_home = /var/lib/barman
log_file = /var/log/barman/barman.log
compression = gzip
parallel_jobs = 4
backup_method = rsync
reuse_backup = link
minimum_redundancy = 2
retention_policy = RECOVERY WINDOW OF 14 DAYS
retention_policy_mode = auto
```

```ini
# /etc/barman.d/prod-main.conf

[prod-main]
description =  "Production PG 16 cluster"
ssh_command = ssh postgres@pg-primary.example.com
conninfo = host=pg-primary.example.com user=barman dbname=postgres
backup_method = postgres
streaming_archiver = on
slot_name = barman
streaming_conninfo = host=pg-primary.example.com user=streaming_barman
archiver = on
backup_options = concurrent_backup
```

Primary `postgresql.conf`:

```conf
archive_mode = on
archive_command = 'barman-wal-archive barman-host prod-main %p'
# Plus a replication slot for streaming WAL
max_wal_senders = 10
max_replication_slots = 10
wal_level = replica
```

### Operational commands

```bash
# Test config + connectivity
barman check prod-main

# Force backup
barman backup prod-main

# Inspect catalog
barman list-backup prod-main
barman show-backup prod-main latest

# Recovery (to a different host)
barman recover --target-time "2026-05-13 12:00:00" \
    --remote-ssh-command "ssh postgres@pg-recover.example.com" \
    prod-main latest /var/lib/postgresql/16/main

# Cron / systemd to run hourly catalog maintenance
barman cron
```

### Incremental backup

Barman incremental works via:

1. **rsync `--link-dest` (file-level)** — hard-links unchanged files from previous backup. Storage-efficient.
2. **Streaming backup** (since 2.0) — uses `pg_basebackup` directly instead of rsync.
3. **Block-level incremental** is **not** as deep as pgBackRest; rsync operates on whole files.

Barman 3.x added **cloud_storage_provider** for direct-to-S3 backup (`barman-cloud-backup`) without local catalog.

### Retention policy

`retention_policy = REDUNDANCY 4` (keep 4 most recent) OR `retention_policy = RECOVERY WINDOW OF 14 DAYS` (keep enough backups to support PITR up to 14 days back).

### Notable PG-version interaction

- Supports PG 9.4 → 18.
- PG15+: `archive_library` not natively supported by Barman as of 3.18.0; continue using `archive_command = 'barman-wal-archive ...'`. Verify against current docs.
- PG17+: pg_basebackup --incremental is NOT used by Barman; Barman uses its own rsync-based incremental.

### Strengths

- Centralized catalog for many clusters.
- SSH-based pull model means no agent on PG host.
- Rich retention policy syntax.
- Strong recovery semantics + reporting.
- Cloud variant (`barman-cloud-backup`) for object-storage-only deployment.

### Weaknesses

- File-level (not block-level) rsync incremental.
- Requires SSH connectivity from Barman host to each PG host.
- Encryption is filesystem-level or pre-stage; no built-in repo encryption (unlike pgBackRest AES or WAL-G libsodium).
- Single-language stack (Python) imposes some perf ceiling on very large clusters.

## WAL-G

Author: Originally Citus (now Microsoft); maintained by community + Yandex + others. License: Apache 2.0. Repo: https://github.com/wal-g/wal-g. Docs: https://wal-g.readthedocs.io/.

### Design

Go-based push-mode backup-and-archive tool optimized for object-storage targets (S3, GCS, Azure, Alibaba OSS, OpenStack Swift, file system). Small binary, no agent on backup side — push from PG host directly to object storage. Popular in K8s + cloud-native deployments.

### Configuration model

Environment variables (typical) or YAML config file.

```bash
# /etc/wal-g/wal-g.env (sourced by systemd unit or shell)
export WALG_S3_PREFIX="s3://mycompany-pg-backups/prod-main"
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export WALG_COMPRESSION_METHOD="lz4"
export WALG_DELTA_MAX_STEPS=7
export WALG_DELTA_ORIGIN="LATEST"
export WALG_UPLOAD_CONCURRENCY=16
export WALG_DOWNLOAD_CONCURRENCY=16
export WALG_LIBSODIUM_KEY=<long-base64-secret-from-vault>
export PGHOST=/var/run/postgresql
export PGUSER=postgres
```

Primary `postgresql.conf`:

```conf
archive_mode = on
archive_command = 'envdir /etc/wal-g/env wal-g wal-push %p'
restore_command = 'envdir /etc/wal-g/env wal-g wal-fetch %f %p'
```

### Operational commands

```bash
# Full backup (push to S3)
sudo -u postgres envdir /etc/wal-g/env wal-g backup-push /var/lib/postgresql/16/main

# Delta backup (since last LATEST backup)
WALG_DELTA_MAX_STEPS=7 wal-g backup-push /var/lib/postgresql/16/main

# List backups
wal-g backup-list

# Restore latest backup to fresh PGDATA
wal-g backup-fetch /var/lib/postgresql/16/main LATEST

# Verify backup
wal-g backup-verify LATEST

# Delete old backups (retention)
wal-g delete retain FULL 3 --confirm
```

### Delta (incremental) backup

WAL-G supports *delta backups* — each backup records only files changed since the previous backup. `WALG_DELTA_MAX_STEPS` controls the maximum chain length before forcing a full. Delta is **file-level** like Barman, not block-level like pgBackRest.

### Encryption

WAL-G supports multiple encryption strategies:

- `WALG_LIBSODIUM_KEY` — symmetric libsodium encryption at the WAL-G client side.
- `WALG_PGP_KEY_PATH` — OpenPGP encryption.
- `WALG_S3_SSE` — server-side encryption (S3 manages keys).
- `WALG_S3_SSE_KMS_ID` — server-side encryption with AWS KMS.
- `WALG_CSE_KMS_ID` — client-side encryption with KMS-issued keys.

### Notable PG-version interaction

- Supports PG 9.6 → 18.
- PG15+: can use `archive_library` patterns but most deployments still use shell `archive_command`.
- PG17+: WAL-G has its own delta mechanism; does NOT use `pg_basebackup --incremental`.

### Strengths

- Small Go binary, easy to deploy.
- Native multi-cloud object-storage support.
- KMS-based encryption (server-side + client-side).
- Pairs naturally with Patroni + K8s operators (CNPG sidecar pattern).
- Low memory footprint.
- Also supports MySQL, MongoDB, Redis, FoundationDB (multi-engine).

### Weaknesses

- File-level (not block-level) incremental.
- No centralized catalog UI (unlike Barman); rely on cloud-storage console + `backup-list`.
- Restore parallelism less mature than pgBackRest's.
- Documentation more scattered than pgBackRest's.

## Cross-Tool Operational Patterns

Patterns that apply to all three.

### Scheduled backups

None of the three tools have built-in scheduling. Pick one:

- **cron**: `0 2 * * 0 /usr/bin/pgbackrest --stanza=main --type=full backup` (Sunday 2am full; daily diff/incr in separate entries).
- **systemd timer**: `pgbackrest-full.service` + `pgbackrest-full.timer`.
- **pg_cron** (cross-reference [`98-pg-cron.md`](./98-pg-cron.md)): in-database cron via SQL. Works if backup-tool command is wrapped in a SECURITY DEFINER function that can call `pg_catalog.pg_terminate_backend(0)` (a hack) or via `LOAD 'cron'` calling external script. Less common in production.
- **K8s CronJob**: `apiVersion: batch/v1, kind: CronJob`. Standard pattern in CNPG / Zalando operator deployments.

### Verification

Run *integrity verification* separately from *test-restore*. The two catch different failures:

- **Integrity verification** (`pgbackrest verify`, `barman verify-backup`, `wal-g backup-verify`): reads every page checksum. Catches bit-rot, corrupted blocks, missing files in repo.
- **Test-restore**: actually restore to a disposable host. Catches mis-configured `pg_hba.conf`, wrong `archive_command`, broken WAL chain, encryption-key drift. Only a successful test-restore proves the backup is usable.

Schedule weekly verify + monthly test-restore. Alert if either fails (cross-reference [`82-monitoring.md`](./82-monitoring.md)).

### Retention strategy

Two-axis decision: **time** (how far back to PITR) + **count** (how many full backups to keep).

| Use case | Retention |
|---|---|
| OLTP, 14-day RPO target | 2 full + 14 days WAL |
| Compliance-driven 90-day retention | 4 full + 90 days WAL |
| Cost-constrained, low-RPO-tolerance | 1 full + 7 days WAL |
| Multi-region DR | Replicate to second repo with longer retention |

### WAL archival mode — `archive_command` vs `archive_library` (PG15+)

PG15+ adds `archive_library`: load WAL archival as a shared library called from PG instead of shell. Lower overhead, no process fork per WAL segment.

| Tool | `archive_command` support | `archive_library` support |
|---|---|---|
| pgBackRest | Yes (default) | Yes (since 2.42) |
| Barman | Yes (default) | Not as of 3.18.0 |
| WAL-G | Yes (default) | Not natively |

> [!WARNING] PG16: `archive_command` and `archive_library` mutually exclusive
> Verbatim from PG16 release notes: *"Prevent `archive_library` and `archive_command` from being set at the same time (Nathan Bossart). Previously `archive_library` would override `archive_command`."* If both are set on PG16+, server fails to start. Use exactly one.

### Backup from standby

All three support backup from a standby. Reduces I/O load on primary.

- pgBackRest: set `backup-standby = y` in stanza config.
- Barman: native via `backup_options = concurrent_backup`.
- WAL-G: connect to standby; ensure replication is current.

Caveat: a stale standby means a stale backup. Verify `pg_stat_replication.replay_lag` near zero before initiating standby backup.

### Encryption key management

All three support encryption at rest. Key management is on you.

- Never store encryption keys in `postgresql.conf`, in the tool's config file alongside the data, or in the same object-storage bucket as the backups.
- Use HashiCorp Vault / AWS KMS / GCP KMS / Azure Key Vault to deliver keys to the backup process at runtime.
- Test the decryption path. Encrypted-but-can't-decrypt backups = no backup.

### Backup-tool monitoring

Pair with [`82-monitoring.md`](./82-monitoring.md). Alert on:

- `pg_stat_archiver.failed_count > 0` (WAL archive broken)
- `pg_stat_archiver.last_archived_wal` older than 1h (archive lag)
- Last successful backup older than expected (count `barman list-backup` / `pgbackrest info` output and emit metric)
- Backup repository size growing unbounded (retention misconfigured)
- Backup verify failed in last 7 days
- Test-restore failed in last 30 days

## Per-Version PostgreSQL Surface

| PG version | Backup-tool-relevant change |
|---|---|
| **PG14** | `recovery_init_sync_method=syncfs` reduces fsync time on Linux during restore. `pg_stat_wal` view added. |
| **PG15** | `archive_library` GUC introduced. Verbatim: *"Allow archiving via loadable modules (Nathan Bossart). The new server variable `archive_library` can be set to specify a library to be called for archiving."* pgBackRest 2.42+ supports it. |
| **PG15** | `pg_basebackup --target=server` server-side backup target. Server-side LZ4/Zstd compression in `pg_basebackup`. |
| **PG16** | `archive_library` and `archive_command` mutually exclusive — server fails to start if both set. Verbatim: *"Prevent `archive_library` and `archive_command` from being set at the same time (Nathan Bossart)."* |
| **PG16** | `pg_basebackup` fix for tablespaces in `$PGDATA`. |
| **PG17** | `pg_basebackup --incremental` introduced. Verbatim: *"Add support for incremental file system backup (Robert Haas, Jakub Wartak, Tomas Vondra). Incremental backups can be created using `pg_basebackup`'s new `--incremental` option."* `pg_combinebackup` for combining chains. WAL summarization (`summarize_wal` GUC, `pg_walsummary` tool). |
| **PG17** | None of pgBackRest/Barman/WAL-G *use* `pg_basebackup --incremental` as of late 2026 — all three have their own established incremental mechanisms. Use core tool if you want PG17+ native incremental. |
| **PG18** | `pg_combinebackup -k / --link` hard-link mode. `pg_verifybackup` tar support. Experimental support in pgBackRest 2.55+. |

## Recipes

### Recipe 1 — Baseline pgBackRest production setup with S3 off-site

Single primary, local + S3 dual-repo, daily incremental + weekly full, 14-day retention.

```ini
# /etc/pgbackrest/pgbackrest.conf
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
repo1-retention-diff=7
repo1-retention-archive=14
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<from-vault>

repo2-type=s3
repo2-path=/pgbackrest
repo2-s3-bucket=mycompany-pg-backups
repo2-s3-region=us-east-1
repo2-s3-endpoint=s3.amazonaws.com
repo2-s3-key=<from-vault>
repo2-s3-key-secret=<from-vault>
repo2-retention-full=8
repo2-retention-archive=30
repo2-cipher-type=aes-256-cbc
repo2-cipher-pass=<from-vault>

process-max=8
compress-type=zstd
compress-level=6
log-level-console=info
log-level-file=detail
start-fast=y
archive-async=y
spool-path=/var/spool/pgbackrest

[main]
pg1-path=/var/lib/postgresql/16/main
pg1-port=5432
pg1-user=postgres
```

```conf
# postgresql.conf addition
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --stanza=main archive-push %p'
max_wal_senders = 10
```

Init + first backup:

```bash
sudo -u postgres pgbackrest --stanza=main stanza-create
sudo -u postgres pgbackrest --stanza=main --type=full backup
sudo -u postgres pgbackrest --stanza=main info
```

Cron (Sunday 2am full, daily 2am incremental):

```cron
0 2 * * 0 postgres /usr/bin/pgbackrest --stanza=main --type=full backup
0 2 * * 1-6 postgres /usr/bin/pgbackrest --stanza=main --type=incr backup
0 4 * * * postgres /usr/bin/pgbackrest --stanza=main check
0 5 * * 0 postgres /usr/bin/pgbackrest --stanza=main verify
```

### Recipe 2 — Barman centralized backup for 10 clusters

Single Barman host backs up 10 PG primaries.

```ini
# /etc/barman.conf
[barman]
barman_user = barman
barman_home = /var/lib/barman
log_file = /var/log/barman/barman.log
compression = gzip
parallel_jobs = 4
backup_method = postgres
streaming_archiver = on
retention_policy_mode = auto
retention_policy = RECOVERY WINDOW OF 14 DAYS
minimum_redundancy = 2
```

```ini
# /etc/barman.d/prod-main.conf  (one file per cluster)
[prod-main]
description = "Production PG 16 cluster"
conninfo = host=pg-prod-main user=barman dbname=postgres
streaming_conninfo = host=pg-prod-main user=streaming_barman
backup_method = postgres
streaming_archiver = on
slot_name = barman_prod_main
```

Repeat the per-cluster file for each of the 10 clusters.

```bash
# Check all clusters
barman check all

# Daily backup of all clusters
0 2 * * * barman /usr/bin/barman backup all

# Hourly catalog maintenance (retention enforcement, WAL housekeeping)
*/15 * * * * barman /usr/bin/barman cron
```

### Recipe 3 — CloudNativePG with barman-cloud backup (K8s native)

CloudNativePG operator has first-class backup integration via barman-cloud. Sample Cluster CR using the native barman-cloud S3 backup:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: prod-main
  namespace: pg
spec:
  instances: 3
  postgresql:
    parameters:
      max_wal_senders: "10"
      archive_mode: "on"
      archive_command: "wal-g wal-push %p"
  bootstrap:
    initdb:
      database: app
      owner: app_user
  backup:
    barmanObjectStore:
      destinationPath: "s3://mycompany-pg-backups/prod-main"
      s3Credentials:
        accessKeyId:
          name: backup-creds
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-creds
          key: SECRET_ACCESS_KEY
      wal:
        compression: lz4
      data:
        compression: lz4
        encryption: AES256
    retentionPolicy: "30d"
```

(Note: CNPG natively uses *barman-cloud*, not WAL-G binary, despite the YAML being similar. For WAL-G specifically, deploy as a sidecar container with shared volume mount of `PGDATA` and configure `archive_command` to invoke the sidecar's `wal-g`.)

### Recipe 4 — Restore to specific point in time (pgBackRest)

```bash
# Stop PG
sudo systemctl stop postgresql@16-main

# Wipe data dir
sudo -u postgres rm -rf /var/lib/postgresql/16/main/*

# Restore with PITR target
sudo -u postgres pgbackrest --stanza=main \
    --type=time \
    --target='2026-05-13 12:00:00 UTC' \
    --target-action=pause \
    restore

# Start PG (it will be in recovery, paused at target)
sudo systemctl start postgresql@16-main

# Verify state of data
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"
sudo -u postgres psql -c "SELECT count(*) FROM orders WHERE created_at > '2026-05-13';"

# If data correct, promote
sudo -u postgres psql -c "SELECT pg_wal_replay_resume();"
sudo -u postgres psql -c "SELECT pg_promote();"
```

Same pattern works for Barman (`barman recover --target-time`) and WAL-G (`wal-g backup-fetch` + `restore_command`).

### Recipe 5 — Verify backup is restorable (weekly disposable-host pattern)

```bash
#!/bin/bash
# /usr/local/bin/pg-restore-drill.sh
set -euo pipefail

DRILL_HOST=pg-restore-drill.internal
STANZA=main

# 1. Wipe disposable host
ssh root@${DRILL_HOST} 'systemctl stop postgresql@16-main && rm -rf /var/lib/postgresql/16/main/*'

# 2. Restore from latest
ssh postgres@${DRILL_HOST} "pgbackrest --stanza=${STANZA} --type=immediate restore"

# 3. Start PG
ssh root@${DRILL_HOST} 'systemctl start postgresql@16-main'

# 4. Wait for recovery to finish
sleep 30

# 5. Verify
RESULT=$(ssh postgres@${DRILL_HOST} 'psql -tAc "SELECT 'OK' WHERE NOT pg_is_in_recovery();"')
if [ "$RESULT" != "OK" ]; then
    echo "RESTORE FAILED — alert oncall"
    exit 1
fi

# 6. Smoke test
ssh postgres@${DRILL_HOST} 'psql -c "SELECT count(*) FROM critical_table;"'

echo "Restore drill OK"
```

Run weekly via cron. Alert on failure. Cross-reference [`90-disaster-recovery.md`](./90-disaster-recovery.md) for full DR drill procedure.

### Recipe 6 — Migrate from `archive_command` (shell) to `archive_library` PG15+ with pgBackRest

```bash
# Pre-check version
psql -c "SHOW server_version_num;"  # expect >= 150000

# Verify pgBackRest version supports archive_library
pgbackrest --version  # expect >= 2.42
```

```sql
-- Replace archive_command with archive_library
-- Do NOT set both — PG16+ refuses to start
ALTER SYSTEM SET archive_command = '';
ALTER SYSTEM SET archive_library = 'pgbackrest-archive-push';
SELECT pg_reload_conf();
SHOW archive_library;
SHOW archive_command;  -- should be empty
```

Trigger a WAL switch and verify archival:

```sql
SELECT pg_switch_wal();
SELECT pg_stat_archiver();
-- last_archived_wal should advance; failed_count should be 0
```

### Recipe 7 — Inspect what's in the repo

```bash
# pgBackRest
pgbackrest --stanza=main info
# Output: full count, diff count, incr count, repo size, archive range

# Barman
barman list-backup prod-main
barman show-backup prod-main 20260513T020000  # specific backup details
barman show-server prod-main

# WAL-G
wal-g backup-list
wal-g wal-show
```

### Recipe 8 — Force a full backup ahead of schedule

```bash
# pgBackRest
pgbackrest --stanza=main --type=full backup

# Barman
barman backup prod-main

# WAL-G
wal-g backup-push /var/lib/postgresql/16/main
```

### Recipe 9 — Monitor archive_command failure

```sql
-- Run periodically; alert on failed_count > 0 or last_failed_time recent
SELECT
    archived_count,
    last_archived_wal,
    last_archived_time,
    failed_count,
    last_failed_wal,
    last_failed_time,
    EXTRACT(EPOCH FROM now() - last_archived_time) AS seconds_since_last_archive
FROM pg_stat_archiver;
```

Alert thresholds:

- `failed_count > 0` → warning (a single transient failure is fine; sustained means broken)
- `last_failed_time` within the last hour → warning
- `seconds_since_last_archive > 600` AND there is write traffic → critical (archive backed up)

Cross-reference [`82-monitoring.md`](./82-monitoring.md) Recipe 4 for full Prometheus alert rule.

### Recipe 10 — Encryption-key rotation

For pgBackRest:

```bash
# Old key in repo1-cipher-pass; need to re-encrypt with new key
# Cannot rotate in place — generate new repo with new key, copy data, swap

# 1. Create repo2 with new key
# 2. pgbackrest --stanza=main info  → confirm both repos active
# 3. Wait one full retention cycle for new repo to have all backups
# 4. Remove old repo, rename new repo
```

WAL-G + libsodium:

```bash
# Generate new key
WALG_LIBSODIUM_KEY_NEW=$(openssl rand -base64 32)

# Re-encrypt requires fresh backup with new key; old backups are still readable
# with old key (keep both keys until old backups expire from retention)
```

Barman: encryption is typically filesystem-level (LUKS, ZFS) or via pre-stage encrypt; rotation = standard filesystem-rotate procedure.

### Recipe 11 — Backup repo size growth — diagnose retention misconfiguration

```bash
# pgBackRest
pgbackrest --stanza=main info | grep size
du -sh /var/lib/pgbackrest

# Check retention policy effective vs intended
grep retention /etc/pgbackrest/pgbackrest.conf

# If repo grows unbounded:
# 1. Confirm retention policy is set per repo (repo1-retention-full, repo2-retention-full)
# 2. Confirm there is enough archive-retention to clean WAL
# 3. Manual cleanup: pgbackrest --stanza=main --type=full expire (forces retention apply)
```

### Recipe 12 — Why NOT to roll your own (and when you might)

Don't roll your own unless:

- You have unusual storage constraints (cold-archive tier with hour-long retrieval).
- You need a bespoke encryption scheme tied to internal HSM.
- You are running PG at a scale where pgBackRest/Barman/WAL-G have provable limitations (rare).

Even in those cases, prefer to *extend* an existing tool (write a custom `archive_command` wrapper) rather than build full backup machinery. The three tools have accumulated years of edge-case handling that hand-rolled scripts always miss.

Common hand-roll failure modes:

- No retry on archive_command failure → archive lag → disk fills.
- No durable fsync after copy → reboot loses last few segments.
- No checksum verification → corrupted backups undetected for months.
- No retention enforcement → backups expire faster than expected OR never.
- No encryption → compliance violation.
- No test-restore → first time you try to restore, you find out it doesn't work.

### Recipe 13 — Pair backup tool with pg_cron for scheduled verification

Schedule weekly `verify` from inside PG via [`98-pg-cron.md`](./98-pg-cron.md):

```sql
-- Wrap external command in a SECURITY DEFINER function (or use cron.schedule + shell command)
SELECT cron.schedule(
    'pgbackrest-weekly-verify',
    '0 4 * * 0',  -- Sunday 4am
    $$SELECT pg_catalog.notify('pgbackrest_verify', 'now');$$
);
```

Then have an external listener (systemd unit listening on the NOTIFY channel) trigger `pgbackrest verify`. Cross-reference [`45-listen-notify.md`](./45-listen-notify.md) for the notify-broadcast pattern.

(In practice most teams use systemd timer or K8s CronJob, not pg_cron, for tool invocation — pg_cron is awkward for shell-out work. Listed here for completeness.)

## Gotchas / Anti-patterns

1. **`archive_command` failure does not retry automatically.** If `pgbackrest archive-push` fails (S3 down, disk full, network blip), PG retries forever but does NOT alert. Monitor `pg_stat_archiver.failed_count`. Cross-reference [`82-monitoring.md`](./82-monitoring.md) Recipe 4.
2. **PG16+: `archive_library` and `archive_command` mutually exclusive.** Server refuses to start with both set. If migrating from one to the other, `ALTER SYSTEM SET archive_command = ''` first.
3. **`archive_command = 'cp %p /archive/%f'` is unsafe.** No fsync, no retry, no verification. Even for non-production, this loses data on power loss. Use a tool.
4. **Backups stored on the same host as primary = no backup.** Always replicate off-host. Ideally off-region.
5. **No test-restore = no backup.** Verify integrity weekly; do a full test-restore monthly.
6. **Encryption key in same bucket as encrypted data = no encryption.** Store keys in Vault/KMS, not next to backups.
7. **Retention policy interaction with PITR window.** If retention drops WAL older than the oldest full backup, you cannot PITR back to the start of the oldest full. Always set `repo*-retention-archive` to at least the retention window of the oldest backup you intend to PITR from.
8. **WAL summarization (PG17+) is opt-in.** `summarize_wal = on` must be set BEFORE you want incremental backups via `pg_basebackup --incremental`. None of pgBackRest/Barman/WAL-G use this feature as of 2026 — they have their own mechanisms.
9. **Cross-version restore is impossible.** Physical backups cannot be restored to a different PG major. For that, use `pg_dump` ([`83-backup-pg-dump.md`](./83-backup-pg-dump.md)) or logical replication ([`74-logical-replication.md`](./74-logical-replication.md)) for the upgrade path.
10. **Cross-architecture restore is impossible.** x86_64 backup will not restore on aarch64. For that, use `pg_dump`.
11. **Backup from standby with `replay_lag > 0` produces a stale-data backup.** Check `pg_stat_replication.replay_lag` is zero before initiating standby backup, or accept that the backup reflects the replay-lag-old state.
12. **pgBackRest stanza name should be stable for the life of the cluster.** Renaming a stanza requires re-initialization. Pick a name like `main` or `prod-cluster-name` and stick with it.
13. **Barman ssh keys must be passwordless and rotated.** Document the rotation. Barman cannot prompt for a password mid-cron.
14. **WAL-G env vars are not encrypted at rest in `/etc/wal-g/wal-g.env`.** Use systemd `EnvironmentFile=` with file mode 0600, or fetch from Vault on service start.
15. **K8s operators (CNPG) abstract a lot of this away.** If you're using CNPG/Zalando, configure backups via the CR, not by SSHing into pods to invoke `pgbackrest` directly. Direct invocation may conflict with operator-managed state.
16. **None of these tools use `pg_basebackup --incremental` (PG17+) yet.** Each has its own incremental mechanism. If you specifically want core PG17+ incremental, use `pg_basebackup --incremental` + `pg_combinebackup` directly (cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md)).
17. **Tool version compatibility with PG major.** pgBackRest 2.55+ for PG18 experimental, Barman 3.x for PG14+, WAL-G 3.x for PG18. Verify before deploying.
18. **Pull-model (Barman) requires SSH connectivity at backup time.** Network partition between Barman host and PG host = backup fails silently if not alerted.
19. **Push-model (pgBackRest, WAL-G) requires outbound network from PG host.** In locked-down environments this can be blocked. Open egress to backup target before deployment.
20. **Restore performance is rarely tested.** A 5-hour restore is fine if you tested it. Untested 5-hour restore is a 24-hour outage. Time your restores.
21. **Multi-cloud backup ≠ multi-region resilience.** Putting backups in S3 us-east-1 alone, with the primary also in us-east-1, doesn't protect against region failure. Replicate to a different region.
22. **`expire` in pgBackRest does not delete on first run — it only enforces policy.** Set `repo1-retention-*` correctly first; existing backups are subject to policy on next `expire` invocation (run via `--type=full backup` or explicit `expire`).
23. **Backup-tool log files grow.** Configure log rotation. pgBackRest writes to `/var/log/pgbackrest/`; Barman writes to `/var/log/barman/`; WAL-G writes to stdout/stderr (capture via systemd journal).

## See Also

- [`33-wal.md`](./33-wal.md) — WAL mechanics, archive_command vs archive_library, wal_level
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpointer interaction with backup
- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical replication primary/standby setup
- [`75-replication-slots.md`](./75-replication-slots.md) — slot retention math + invalidation
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA + backup integration patterns
- [`79-patroni.md`](./79-patroni.md) — Patroni clusters typically pair with pgBackRest or WAL-G
- [`82-monitoring.md`](./82-monitoring.md) — pg_stat_archiver + archive-lag + backup-age alerting
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — logical-backup contrast (cross-version + cross-arch)
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — raw `pg_basebackup` + `archive_command` + PITR mechanics
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — in-place major upgrade
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — upgrade strategy comparison
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — post-restore integrity verification with `pg_amcheck` + `amcheck`
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged former primary
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — full DR runbook + drill procedure
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — CNPG / Zalando / Crunchy operator backup integration
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling in-database
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-environment backup availability

## Sources

- pgBackRest project home + user guide: <https://pgbackrest.org/>[^pgbackrest-home]
- pgBackRest configuration reference: <https://pgbackrest.org/configuration.html>[^pgbackrest-config]
- pgBackRest command reference: <https://pgbackrest.org/command.html>[^pgbackrest-command]
- pgBackRest releases (GitHub): <https://github.com/pgbackrest/pgbackrest/releases>[^pgbackrest-releases]
- pgBackRest source: <https://github.com/pgbackrest/pgbackrest>[^pgbackrest-source]
- Barman project home: <https://pgbarman.org/>[^barman-home]
- Barman 3.18.0 docs: <https://docs.pgbarman.org/release/3.18.0/>[^barman-docs]
- Barman source + releases: <https://github.com/EnterpriseDB/barman>[^barman-source]
- WAL-G source + releases: <https://github.com/wal-g/wal-g>[^walg-source]
- WAL-G docs: <https://wal-g.readthedocs.io/>[^walg-docs]
- PostgreSQL 16 backup chapter: <https://www.postgresql.org/docs/16/backup.html>[^pg16-backup]
- PostgreSQL 16 continuous archiving: <https://www.postgresql.org/docs/16/continuous-archiving.html>[^pg16-archive]
- PostgreSQL 17 pg_basebackup (with `--incremental`): <https://www.postgresql.org/docs/17/app-pgbasebackup.html>[^pg17-basebackup]
- PostgreSQL 18 pg_basebackup: <https://www.postgresql.org/docs/18/app-pgbasebackup.html>[^pg18-basebackup]
- PG15 release notes (`archive_library`): <https://www.postgresql.org/docs/release/15.0/>[^pg15-notes]
- PG16 release notes (`archive_library` and `archive_command` mutex): <https://www.postgresql.org/docs/release/16.0/>[^pg16-notes]
- PG17 release notes (`pg_basebackup --incremental`, `pg_combinebackup`, WAL summarization): <https://www.postgresql.org/docs/release/17.0/>[^pg17-notes]
- PG18 release notes: <https://www.postgresql.org/docs/release/18.0/>[^pg18-notes]
- CloudNativePG (mentions barman-cloud + WAL archival): <https://cloudnative-pg.io/>[^cnpg]

[^pgbackrest-home]: pgBackRest project home page. MIT license, version 2.58.0 (Jan 2025).
[^pgbackrest-config]: pgBackRest configuration reference — all stanza options.
[^pgbackrest-command]: pgBackRest command reference — backup, restore, info, verify, expire.
[^pgbackrest-releases]: pgBackRest releases on GitHub — verified active development (3 releases July 2024 → Jan 2025).
[^pgbackrest-source]: pgBackRest source repository.
[^barman-home]: Barman project home page. GPLv3, EnterpriseDB-maintained.
[^barman-docs]: Barman 3.18.0 release docs. Released March 2026.
[^barman-source]: Barman GitHub repository.
[^walg-source]: WAL-G GitHub repository. Apache 2.0. Version 3.0.8 (Jan 2026). Multi-engine (PG, MySQL, MongoDB, Redis, FoundationDB).
[^walg-docs]: WAL-G documentation on ReadTheDocs.
[^pg16-backup]: PostgreSQL 16 official Backup and Restore chapter.
[^pg16-archive]: PostgreSQL 16 Continuous Archiving and PITR chapter.
[^pg17-basebackup]: PG17 `pg_basebackup` adds `--incremental` and references `pg_combinebackup`.
[^pg18-basebackup]: PG18 `pg_basebackup` — incremental refinements.
[^pg15-notes]: Verbatim PG15 release note: "Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."
[^pg16-notes]: Verbatim PG16 release note: "Prevent `archive_library` and `archive_command` from being set at the same time (Nathan Bossart). Previously `archive_library` would override `archive_command`."
[^pg17-notes]: Verbatim PG17 release notes for incremental backup: "Add support for incremental file system backup (Robert Haas, Jakub Wartak, Tomas Vondra). Incremental backups can be created using `pg_basebackup`'s new `--incremental` option." Plus: "The new application `pg_combinebackup` allows manipulation of base and incremental file system backups." Plus WAL summarization: "Allow the creation of WAL summarization files (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski). These files record the block numbers that have changed within an LSN range and are useful for incremental file system backups."
[^pg18-notes]: PG18 release notes — pg_combinebackup `--link` mode, pg_verifybackup tar support.
[^cnpg]: CloudNativePG operator home — uses barman-cloud for native backup; WAL-G also commonly used via sidecar.

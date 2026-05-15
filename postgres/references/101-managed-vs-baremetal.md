# Managed Postgres vs Bare-Metal / Self-Hosted

Categorical comparison: what managed-Postgres environments universally take away from you, what bare-metal / self-hosted gives back, what middle-ground (K8s operators) offers, and how to write application code that survives migration in any direction. **Provider-neutral throughout** — this file describes classes of limitation, not specific providers, and recommends no provider over any other.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Three-Tier Hosting Model](#three-tier-hosting-model)
- [Capability Inventory](#capability-inventory)
    - [Universally Removed on Managed PaaS](#universally-removed-on-managed-paas)
    - [Sometimes Available on Managed PaaS](#sometimes-available-on-managed-paas)
    - [Provided Only by Managed PaaS](#provided-only-by-managed-paas)
- [Per-Capability Detail](#per-capability-detail)
- [Application Portability Rules](#application-portability-rules)
- [Cost Model](#cost-model)
- [Migration Direction](#migration-direction)
- [Recipes](#recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use when:

- Choosing hosting model for new cluster (managed PaaS / K8s operator / bare-metal)
- Auditing an existing application for portability across hosting models
- Diagnosing a feature that "works locally but fails in production" (often = managed-PaaS allowlist)
- Estimating operational cost vs feature cost for hosting decision
- Planning migration in or out of a managed environment

Do NOT use when:

- Need K8s operator specifics → [92-kubernetes-operators.md](./92-kubernetes-operators.md)
- Need Docker single-host patterns → [91-docker-postgres.md](./91-docker-postgres.md)
- Need HA architecture catalog → [78-ha-architectures.md](./78-ha-architectures.md)
- Need PG version lifecycle / EOL info → [100-pg-versions-features.md](./100-pg-versions-features.md)
- Want provider comparison or recommendation → not here, ever. This file is categorical.

## Mental Model

Five rules:

1. **"Managed Postgres" is a class, not a brand.** Refers to any hosted service where the vendor controls postmaster lifecycle, `shared_preload_libraries`, the filesystem, OS-level config, and most superuser-only operations. Multiple vendors exist; their capability sets overlap but differ. **Always verify against the specific vendor's docs** — do not assume.

2. **Three hosting tiers, three trade-off profiles.** Bare-metal/self-hosted (full control, full ops burden) ↔ K8s operator (declarative lifecycle, you own the cluster) ↔ Managed PaaS (vendor owns lifecycle, you own SQL). Capability and ops-cost move in opposite directions across the tiers.

3. **What managed PaaS removes is roughly stable across vendors.** Superuser, server-side filesystem access, custom C extension installation outside an allowlist, direct `postgresql.conf` editing, `shared_preload_libraries` mutation, manual replication slot/WAL control, OS-level kernel tunables. **What it adds (vendor-managed failover, backups, patching) is roughly stable too.**

4. **The decision is workload-driven, not loyalty-driven.** Pick managed when ops cost > feature cost (small team, standard workload, time-sensitive). Pick bare-metal when feature need > ops cost (need a non-allowlisted extension, need raw OS-level perf, regulatory constraint). Pick K8s operator when you want declarative lifecycle without losing capabilities.

5. **Application portability is achievable, not free.** Code that avoids server-side file ops, custom extensions outside the common allowlist, `COPY FROM '/server/path'`, and `pg_read_server_files`-style privileges runs equally well across all three tiers. Code that depends on those features locks you to bare-metal or K8s operator.

## Decision Matrix

| Situation | Pick |
|---|---|
| Small team, OLTP workload, standard schema | Managed PaaS (ops cost dominates) |
| Need bleeding-edge PG major within weeks of GA | Bare-metal or K8s operator (managed PaaS lags 3-12 months) |
| Need non-allowlisted extension (e.g., custom domain-specific FDW) | Bare-metal or K8s operator |
| Need server-side `COPY FROM` from local disk | Bare-metal or K8s operator (managed disables `pg_read_server_files`) |
| Need to install a `shared_preload_libraries` value outside vendor list | Bare-metal or K8s operator |
| Regulatory: data must stay in vendor-uncertified DC | Bare-metal or K8s operator on owned hardware |
| Need declarative lifecycle + cluster ownership | K8s operator (CNPG, Zalando, Crunchy) |
| Need vendor SLA + automatic failover + scheduled backups out of the box | Managed PaaS |
| Want to test pgBouncer, Patroni, or pg_repack patterns on your own infra | Bare-metal or K8s operator |
| Need PITR with arbitrary recovery target | Bare-metal or K8s operator (managed often restricts target granularity) |
| Need root access for `strace`, `perf`, `pg_top` style observability | Bare-metal or K8s-operator with pod-exec |
| Need to run multiple Postgres major versions side-by-side | Bare-metal or K8s operator |
| Standard ORM-driven CRUD with stock extensions (pgcrypto, citext, uuid-ossp) | Managed PaaS works |
| Existing in-house DBA team, predictable workload | Bare-metal cheaper at scale |

Three smell signals:

- **"It works on my laptop but fails on staging."** Often means a feature your local PG allows (custom extension, server-side file path, untrusted PL) is blocked in the managed environment. Diagnose by checking `shared_preload_libraries`, installed extension allowlist, and predefined-role membership before deeper debugging.
- **"We picked managed for cost reasons and now we can't add the extension we need."** Capability constraints are stickier than cost. Audit your roadmap's extension dependencies before locking into a tier.
- **"Migrating to managed should be easy — it's just Postgres."** True for SQL, false for everything around SQL (init scripts, server-side `COPY`, custom auth methods, replication slots managed by hand, `archive_command`).

## Three-Tier Hosting Model

| Tier | What you own | What vendor / operator owns | When to pick |
|---|---|---|---|
| **Bare-metal / self-hosted** | Hardware + OS + Postgres binaries + config + lifecycle + backup + monitoring | Nothing | Full control needed; have ops staff; non-standard requirements |
| **K8s operator-managed** | K8s cluster + storage classes + cluster CR + app state | Operator handles failover + backup + minor-patch via CR; you can `exec` into pods | Want declarative lifecycle + cluster-level control; have K8s expertise |
| **Managed PaaS (vendor-hosted)** | SQL + connection strings + IAM | Postmaster lifecycle + filesystem + OS + most superuser ops + backups + failover + minor patches | Standard workload; small team; ops-cost dominant |

> [!NOTE] K8s operator is a real middle ground
> A K8s operator (CNPG / Zalando / Crunchy) keeps you in control of the Postgres cluster — you can still `exec` into pods, edit `postgresql.conf` via the cluster CR, install any extension, raise `shared_preload_libraries`. The operator only automates failover + backup + scaling. **It does NOT remove capabilities.** See [92-kubernetes-operators.md](./92-kubernetes-operators.md).

## Capability Inventory

### Universally Removed on Managed PaaS

These are almost always blocked across managed-PaaS vendors. **If your code or runbook needs any of them, managed PaaS is the wrong tier.**

| Capability | Why blocked | Workaround |
|---|---|---|
| `SUPERUSER` role attribute | Vendor reserves it for fleet ops | Use `pg_read_all_data` / `pg_write_all_data` / `pg_monitor` / `pg_maintain` predefined roles; see [46](./46-roles-privileges.md) |
| `pg_read_server_files` / `pg_write_server_files` predefined roles | Filesystem isolation | Use client-side `\copy` instead of server-side `COPY FROM '/path'`; see [66](./66-bulk-operations-copy.md) |
| `pg_execute_server_program` predefined role | Process isolation | Run programs on app host, pipe output via `\copy FROM PROGRAM` (client side) |
| Direct edits to `postgresql.conf` | Vendor manages config templates | Use parameter-group API (vendor-specific) for the GUC subset they expose |
| Arbitrary `shared_preload_libraries` | Loads non-vetted C code in postmaster | Vendor exposes allowlist; non-allowlisted libraries unavailable |
| `CREATE EXTENSION` for non-allowlisted extensions | Vendor controls binary supply chain | Stick to vendor's extension allowlist (usually pgvector, PostGIS, pg_stat_statements, pgcrypto, citext, etc.) |
| Untrusted procedural languages (`plpython3u`, `plperlu`) | Untrusted = arbitrary OS access | Trusted PLs only (`plpgsql`, `plperl`, `pltcl`); see [09](./09-procedural-languages.md) |
| `archive_command` arbitrary shell | Vendor controls backup pipeline | Vendor's managed backup is the replacement; you can't substitute your own |
| Manual `restore_command` / PITR target file | Vendor controls WAL archive | Use vendor's PITR API (usually time-target only, no LSN or named restore point) |
| Manual replication slot lifecycle (`pg_create_logical_replication_slot`, `pg_drop_replication_slot`) on cluster's own primary | Slots can pin WAL and break failover | Some vendors expose limited slot mgmt; verify; see [75](./75-replication-slots.md) |
| Direct `pg_hba.conf` edits | Authentication policy is vendor-managed | Configure via vendor's IAM / firewall API |
| Custom auth methods (LDAP, GSSAPI, PAM, RADIUS) | Implementation requires postmaster config | Vendor typically offers IAM-bridged auth (cloud-IAM or SCRAM only) |
| OS-level kernel tunables (huge pages, `vm.overcommit_memory`, `vm.nr_hugepages`) | Not a Postgres surface | Not available in managed PaaS by definition |
| `pg_resetwal` / single-user mode (`postgres --single`) | Last-resort recovery requires shell access | Vendor handles disaster recovery; you cannot |
| Direct access to `pg_wal/`, `pg_xact/`, `base/` directories | Filesystem isolation | Use SQL surface only |
| `COPY ... TO PROGRAM` / `COPY ... FROM PROGRAM` (server-side) | Process isolation | Use client-side `\copy ... FROM PROGRAM` |
| `lo_import` / `lo_export` (file-system large objects) | Filesystem isolation | Use `bytea` or client-side LO API; see [71](./71-large-objects.md) |
| `CREATE TABLESPACE` with arbitrary location | Filesystem isolation | Default tablespace only; see [62](./62-tablespaces.md) |
| Building C extensions in-place (PGXS toolchain on server) | No shell + no compiler | Bare-metal or K8s operator only; see [72](./72-extension-development.md) |

### Sometimes Available on Managed PaaS

Vendor-dependent. **Always verify against vendor docs before designing around.**

| Capability | Variability |
|---|---|
| Logical replication subscriber (managed cluster pulls from external) | Some vendors allow; some require allowlisting source IP |
| Logical replication publisher (managed cluster emits to external) | Often allowed but may require explicit feature flag |
| Custom certificates / TLS termination | Some vendors let you upload CA; others use their own cert chain |
| pgBouncer in front of managed cluster | Some vendors bundle; some require you to deploy separately |
| Specific extension versions (e.g., pgvector 0.8.x vs 0.5.x) | Lag varies; check vendor extension catalog |
| Specific PG major versions (e.g., PG18 within months of GA) | Lag varies 3-12 months across vendors |
| Read replicas in different regions | Available on most, but pricing and limits differ |
| Cross-account / cross-project replication | Network-policy-dependent |
| Custom backup retention (>30 days, etc.) | Tier-dependent |
| Failover trigger (manual fail-over via API) | Most expose; mechanism differs |
| WAL-level streaming subscription (Debezium, etc.) | Often allowed if logical replication is enabled |
| HA topology choice (sync vs async, quorum size) | Vendor-defaulted; some allow tuning |
| Connection limit override (`max_connections`) | Tier-bound (often correlated to instance size) |
| `wal_level=logical` (for CDC) | Often opt-in via parameter group |
| `pg_dump` against managed cluster | Almost always allowed; check egress costs |

### Provided Only by Managed PaaS

What you give up control over on the other tiers — but get for free on managed:

| Capability | Implication |
|---|---|
| Automatic minor patch application | Vendor handles 14.22→15.17→... within a major. On bare-metal, you orchestrate. |
| Vendor-managed failover with SLA | Defined RTO commitment. You don't run Patroni / etcd. |
| Scheduled automated backups | Vendor backs up to vendor storage. You don't run pgBackRest / Barman / WAL-G. |
| Out-of-band PITR | Vendor catalog of recovery points. Granularity varies. |
| Monitoring dashboards + alerting | Pre-built CPU / connection / replication-lag dashboards. |
| Network-level isolation (VPC / private link) | Easy to wire to other vendor services. |
| Storage auto-scaling | Disk grows transparently. No manual `LVM extend` / `xfs_growfs`. |
| Compliance certifications (SOC 2, ISO 27001, HIPAA, PCI etc.) | Provided as part of the service. |

> [!WARNING] What you give up by relying on these
> Vendor-managed = vendor-opaque. You cannot inspect the failover mechanism, the backup tooling, or the patch process beyond what the API surfaces. **For most workloads, this is acceptable.** For workloads where you need to verify or modify any of those mechanisms, it's not.

## Per-Capability Detail

### Superuser equivalent

`SUPERUSER` is gone on managed PaaS. Vendor exposes a primary "admin" role that has `CREATEROLE`, `CREATEDB`, and ownership of created objects — but **not** `SUPERUSER`. This blocks:

- Direct catalog mutation (e.g., `UPDATE pg_class SET ...`)
- `COPY ... FROM '/server/path'` (server-side file ops)
- `CREATE EXTENSION` of any non-trusted, non-allowlisted extension
- `CREATE LANGUAGE` for untrusted languages
- `ALTER SYSTEM` of restricted GUCs
- Reading server-side files via `pg_read_server_files` etc.

PG14+ predefined roles fill many use cases — `pg_read_all_data` / `pg_write_all_data` / `pg_monitor` / PG17+ `pg_maintain`. See [46](./46-roles-privileges.md).

### `shared_preload_libraries`

The most common single blocker. Many extensions require loading at postmaster startup:

- `pg_stat_statements` — usually allowlisted, but check
- `auto_explain` — sometimes allowlisted
- `pgaudit` — often available
- `pg_cron` — sometimes preinstalled; sometimes not allowed
- `pg_partman_bgw` — rarely allowed (extension itself fine; background worker often blocked)
- TimescaleDB — vendor-dependent (some bundle it; others don't)
- Citus — Microsoft-managed only by Microsoft; bare-metal otherwise
- Custom in-house extension — bare-metal or K8s operator only

Verify before designing: `SHOW shared_preload_libraries;` on the managed cluster shows what's loaded. The vendor's parameter-group docs show what's *allowed*.

### Extension allowlist

Each vendor maintains an allowlist. **Roughly common across vendors:** `pgcrypto`, `citext`, `uuid-ossp`, `pg_stat_statements`, `pg_trgm`, `btree_gin`, `btree_gist`, `hstore`, `intarray`, `pgaudit`, `postgis`, `pgvector`, `tablefunc`. **Sometimes common:** `pg_cron`, `pg_partman`, `auto_explain`, `pageinspect`, `pgstattuple`, `amcheck`, `pg_visibility`, `pg_buffercache`, `pg_prewarm`, `postgres_fdw`, `file_fdw`. **Almost never on managed:** Custom in-house C extensions, `pg_tde` (encryption-at-rest extensions are vendor-area), `pg_squeeze`, distribution-specific extensions like Citus on non-Citus vendors.

Audit your codebase's `CREATE EXTENSION` calls against the target vendor's catalog before committing.

### Authentication

Managed PaaS exposes a subset of [pg_hba.conf](./48-authentication-pg-hba.md) auth methods:

- `scram-sha-256` (password) — always
- Vendor-IAM bridge (e.g., cloud-IAM tokens) — typically
- TLS / client certificates — sometimes

**Blocked:** LDAP, GSSAPI, PAM, RADIUS, ident, peer, trust. If your auth design depends on any of those, you're on bare-metal or K8s operator.

### Server-side `COPY`

`COPY ... FROM '/server/path'` requires `pg_read_server_files` (or superuser). Blocked on managed PaaS. **Replace with client-side `\copy`** via psql or libpq — content streams over the network, vendor-side filesystem stays inaccessible. See [66](./66-bulk-operations-copy.md). Performance is slightly worse (network bandwidth becomes the bottleneck), but the SQL is functionally identical.

### `archive_command` and PITR

Managed vendors implement their own WAL archiving pipeline. You cannot substitute `archive_command` or `archive_library`. PITR is exposed via vendor API with **time-target only granularity** (e.g., "restore to 2026-05-14T03:14:00Z"). Bare-metal gives you `recovery_target_time` / `recovery_target_xid` / `recovery_target_lsn` / `recovery_target_name`. See [84](./84-backup-physical-pitr.md) and [90](./90-disaster-recovery.md).

> [!WARNING] PITR granularity differs
> Vendor PITR usually rounds to the nearest 5-30 second WAL-archive boundary. For sub-second recovery target (`recovery_target_xid` to undo specific transaction), bare-metal is required.

### Replication slots

Logical replication slots require `wal_level=logical`. On managed PaaS:

- Setting `wal_level=logical` is often opt-in via parameter group (requires restart)
- Creating slots may require specific role (often allowed on managed PaaS for the admin role)
- **Slots can pin WAL on the primary indefinitely if the consumer falls behind**. Managed vendors mitigate this by setting `max_slot_wal_keep_size` aggressively (sometimes invisibly to you). On bare-metal, you control the budget. See [75](./75-replication-slots.md).

### TLS / certificates

Managed PaaS terminates TLS at the connection endpoint. Your client sends `sslmode=require` (or `verify-full` against the vendor's CA chain). Custom certs may be uploadable; check vendor docs. **You cannot disable TLS** on most managed PaaS by design.

### Backup tooling

`pg_dump` works against managed PaaS (vendor allows the SELECT-and-stream pattern). Restore via `pg_restore` also works for logical backups. **What you cannot do** is run pgBackRest / Barman / WAL-G against the managed cluster as the *source* of physical backups — you don't have filesystem access to do so. See [85](./85-backup-tools.md).

### Failover and HA

Managed PaaS handles failover automatically and exposes a manual-trigger API. **You cannot inspect the mechanism** (no `pg_stat_replication` cluster-wide view of all standbys, no Patroni DCS, no etcd state). For HA-design transparency, bare-metal or K8s operator. See [78](./78-ha-architectures.md), [79](./79-patroni.md), [92](./92-kubernetes-operators.md).

## Application Portability Rules

To write Postgres application code that runs equally well on bare-metal, K8s operator, and managed PaaS:

1. **No server-side file paths.** Never use `COPY ... FROM '/path'`. Use `\copy` (client side) or stream via libpq `COPY` protocol.
2. **No `pg_read_server_files` / `pg_write_server_files` / `pg_execute_server_program` privileges.** These are vendor-specific.
3. **No untrusted procedural languages.** Stick to `plpgsql`, trusted `plperl`, trusted `pltcl`. Never `plpython3u` or `plperlu`. See [09](./09-procedural-languages.md).
4. **No `lo_import` / `lo_export`.** Use bytea columns or client-driven large-object loading. See [71](./71-large-objects.md).
5. **No `CREATE TABLESPACE` with arbitrary location.** Stick to default tablespace (the managed default IS the only tablespace on most vendors).
6. **No `SUPERUSER` dependency.** Build all code paths for non-superuser execution. Use `pg_read_all_data` / `pg_write_all_data` / `pg_monitor` / `pg_maintain` predefined roles.
7. **Stick to the common extension allowlist intersection** unless you've explicitly chosen bare-metal: pgcrypto, citext, uuid-ossp, pg_stat_statements, pg_trgm, btree_gin, btree_gist, hstore, intarray, pgaudit, postgis, pgvector, tablefunc, postgres_fdw, file_fdw. **Avoid:** pg_cron (often blocked), pg_partman_bgw (background worker often blocked), pg_squeeze, custom C extensions.
8. **No `ALTER SYSTEM` of restricted GUCs.** Use SET LOCAL for per-transaction overrides. For per-role overrides, use `ALTER ROLE ... SET`; see [53](./53-server-configuration.md).
9. **No `pg_hba.conf` edits in your code.** Vendor manages this.
10. **Use parameterized `archive_command`-free PITR.** Don't assume custom `archive_command` is reachable. PITR is via vendor API or pg_basebackup against bare-metal.
11. **Treat `wal_level` as opt-in.** Test that logical replication consumer code works when the source is on managed PaaS with `wal_level=logical` correctly set.
12. **Use `pg_dump` for logical backups, not pg_basebackup.** Bare-metal and K8s operator allow both; managed PaaS often allows only `pg_dump`-driven extraction.

> [!NOTE] Portable feature set ≈ standard PG SQL + common extensions
> The intersection of "what works on managed PaaS" and "what works on bare-metal" is the practical "portable PG." If you stay inside it, migration in either direction is mostly a connection-string change plus extension version verification.

## Cost Model

A simple decision framework for ops-cost vs feature-cost:

```
ops_cost = (cost_of_failed_failover * P_failover) +
           (cost_of_lost_backup * P_backup_failure) +
           (cost_of_minor_upgrade_downtime * upgrades_per_year) +
           (cost_of_monitoring_setup + ongoing_monitoring_burden) +
           (cost_of_HA_design + Patroni_or_operator_skill_investment)

feature_cost = (cost_of_workaround_for_missing_feature * features_used) +
               (cost_of_vendor_lock_in_if_blocked) +
               (cost_of_PG_major_lag_if_3-12_months_behind)
```

**Rule of thumb:** if your team has < 1 dedicated DBA-FTE and your workload uses only the common-extension intersection, ops_cost > feature_cost and managed PaaS wins. If you have 2+ DBA-FTEs, custom extensions, or sub-second-RPO requirements, feature_cost > ops_cost and bare-metal or K8s operator wins.

> [!NOTE] K8s operator is often the right middle ground
> Modern K8s operators (CNPG, Zalando, Crunchy) collapse much of the ops_cost (failover, backup, scaling, minor-patch) without removing capabilities. If you already have a K8s platform team, this is frequently the best of both. See [92](./92-kubernetes-operators.md).

## Migration Direction

### Bare-metal → Managed PaaS

1. **Audit extensions.** Run `SELECT extname FROM pg_extension;` and verify every extension is on the target vendor's allowlist at a compatible version.
2. **Audit `shared_preload_libraries`.** Same audit; verify every preload library is supported.
3. **Audit roles for superuser dependencies.** Replace `SUPERUSER` with predefined roles (`pg_read_all_data` etc.). Code review for `pg_read_server_files`, `lo_import`, server-side `COPY FROM '/path'`.
4. **Audit auth.** If using LDAP/GSSAPI/PAM, plan migration to SCRAM + vendor-IAM bridge.
5. **Audit replication slots and `wal_level=logical` consumers.** Cluster-on-managed-PaaS replication endpoints may differ.
6. **Migrate via `pg_dump | pg_restore`** (medium clusters) or **logical replication** (zero-downtime). See [87](./87-major-version-upgrade.md) for the strategy table. `pg_upgrade --link` does NOT work across hosting boundaries (target cluster is on the vendor's storage; you can't `--link` across).
7. **Update connection strings** including `sslmode=verify-full` and the vendor's CA chain if required.
8. **Re-verify HA, backup, monitoring** are configured (or accept vendor defaults).

### Managed PaaS → Bare-metal / K8s operator

1. **Get a `pg_dump`** of the managed cluster as source of truth.
2. **Provision new bare-metal / operator-managed cluster** at compatible PG major.
3. **Install needed extensions** (you now can install whatever you want).
4. **Restore with `pg_restore --jobs=N`** for parallel restore.
5. **Set up `archive_command` / `archive_library` + pgBackRest / Barman / WAL-G**. See [85](./85-backup-tools.md).
6. **Set up Patroni or operator + monitoring + alerting**.
7. **Cut over via DNS / connection-string change + final delta-sync via logical replication** if zero-downtime needed.
8. **Decommission managed cluster** after parallel-run period (typically 1-2 weeks).

### Managed PaaS → Different Managed PaaS

1. **Extension version compatibility** — each vendor's allowlist and version pins differ.
2. **`pg_dump | pg_restore` or logical replication** across vendor boundaries.
3. **Auth bridge** — IAM tokens are vendor-specific; SCRAM + password is the portable lowest common denominator.
4. **TLS / CA chain** — each vendor terminates TLS differently.

## Recipes

### 1. Pre-deployment portability audit

Run before promoting a code change to production:

```sql
-- 1. Extensions installed (verify against target vendor's allowlist)
SELECT extname, extversion FROM pg_extension ORDER BY extname;

-- 2. shared_preload_libraries (verify each is allowed)
SHOW shared_preload_libraries;

-- 3. Procedural languages installed (untrusted are not portable)
SELECT lanname, lanpltrusted FROM pg_language WHERE lanispl;

-- 4. Roles with SUPERUSER attribute (must be 0 in portable code)
SELECT rolname FROM pg_roles WHERE rolsuper AND rolname NOT LIKE 'pg_%';

-- 5. Tablespaces beyond pg_default and pg_global (rarely portable)
SELECT spcname FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global');

-- 6. Foreign servers (check vendor allows pertinent FDW)
SELECT srvname, srvtype, srvfdw FROM pg_foreign_server;

-- 7. Tables using LO type (lo_import/export blocked on managed)
SELECT n.nspname, c.relname, a.attname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE t.typname = 'oid' AND c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');
```

### 2. Find non-portable code patterns in your codebase

Grep migration files / source repo:

```bash
# Server-side COPY (blocks managed PaaS)
grep -rni "copy.*from '/" migrations/ src/

# lo_import / lo_export (blocks managed)
grep -rni "lo_import\|lo_export" migrations/ src/

# plpython3u, plperlu (untrusted PLs)
grep -rni "plpython3u\|plperlu" migrations/ src/

# Server-side archive_command / restore_command
grep -rni "archive_command\|restore_command" migrations/ src/

# CREATE TABLESPACE (most managed disallow)
grep -rni "create tablespace" migrations/ src/

# pg_read_server_files dependency
grep -rni "pg_read_server_files\|pg_write_server_files\|pg_execute_server_program" migrations/ src/

# CREATE LANGUAGE (only relevant for non-trusted)
grep -rni "create language.*plpython\|create language.*plperlu" migrations/ src/
```

### 3. Verify capability-equivalence after migration

After moving (in either direction), run a smoke test:

```sql
-- (A) Extensions
SELECT extname FROM pg_extension ORDER BY extname;
-- Expected: same list, possibly different versions

-- (B) Privileges
SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname IN ('app_user', 'app_owner')  -- adjust per your roles
ORDER BY rolname;

-- (C) Replication slots (if you have them)
SELECT slot_name, slot_type, active, restart_lsn, confirmed_flush_lsn
FROM pg_replication_slots;

-- (D) GUC overrides
SELECT name, setting, source FROM pg_settings WHERE source NOT IN ('default', 'override');

-- (E) Table counts (smoke test)
SELECT schemaname, count(*) AS table_count
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
GROUP BY schemaname ORDER BY schemaname;
```

### 4. Use predefined roles instead of SUPERUSER

When migrating off bare-metal where code assumed superuser, replace with predefined roles:

```sql
-- BAD (assumes SUPERUSER):
GRANT ALL ON ALL TABLES IN SCHEMA app TO app_admin;
ALTER ROLE app_admin SUPERUSER;

-- GOOD (portable):
GRANT pg_read_all_data TO app_admin;
GRANT pg_write_all_data TO app_admin;
GRANT pg_monitor TO app_admin;
GRANT pg_maintain TO app_admin;  -- PG17+ only; pre-PG17 grant explicit VACUUM/ANALYZE/REINDEX/REFRESH MV/CLUSTER permissions on schemas
```

See [46](./46-roles-privileges.md) for predefined-role catalog and [55](./55-statistics-planner.md) for analyze permissions.

### 5. Replace server-side COPY with client-side

```bash
# BAD (server-side, blocks managed):
psql -c "COPY events FROM '/data/events.csv' CSV HEADER"

# GOOD (client-side, portable):
psql -c "\\copy events FROM '/data/events.csv' CSV HEADER"

# GOOD (libpq COPY protocol, portable):
cat /data/events.csv | psql -c "COPY events FROM STDIN CSV HEADER"
```

The latter two stream content over the libpq connection; no server-side filesystem access required. See [66](./66-bulk-operations-copy.md).

### 6. Configure cluster-level alerting that survives the tier

Metrics that work the same on bare-metal and managed:

- Cache hit ratio: `pg_stat_database.blks_hit / (blks_hit + blks_read)`
- Active connection count: `pg_stat_activity` count
- Long-running transactions: `now() - xact_start > '5 minutes'`
- Replication lag (if applicable): `pg_stat_replication.replay_lag`

See [82](./82-monitoring.md). Avoid alerting on metrics that only exist on bare-metal (e.g., per-second WAL I/O at the OS level).

### 7. Test PG major upgrade on a disposable clone

On bare-metal / K8s operator, you can test against an exact production clone via `pg_basebackup` + `pg_upgrade`. On managed PaaS, you must use the vendor's "snapshot + restore to new major" workflow. Either way:

1. Create disposable clone at PG (N+1).
2. Run your full integration test suite.
3. Check `pg_amcheck`, `pg_stat_statements` regression, application-level smoke tests.
4. Roll forward when confident.

See [86](./86-pg-upgrade.md) and [87](./87-major-version-upgrade.md).

### 8. Replicate from bare-metal to managed (or vice versa) for migration

Logical replication crosses tier boundaries cleanly:

```sql
-- On source (publisher):
ALTER SYSTEM SET wal_level = 'logical';
SELECT pg_reload_conf();  -- May require restart on first set
CREATE PUBLICATION migrate_pub FOR ALL TABLES;

-- On target (subscriber):
CREATE SUBSCRIPTION migrate_sub
  CONNECTION 'host=source.example.com port=5432 dbname=app user=replica_user password=...'
  PUBLICATION migrate_pub;
```

See [74](./74-logical-replication.md). Works across bare-metal ↔ K8s operator ↔ managed-PaaS boundaries as long as the source `wal_level=logical` is set. Verify the managed vendor allows it (most do; some require explicit opt-in).

### 9. Audit which features your code requires

```bash
# Inventory dependencies your code relies on:
- Required extensions (intersection with target vendor's allowlist)
- Required GUCs not in vendor's parameter-group surface
- Authentication methods used
- Role attributes required
- Replication slots needed
- WAL-archive interaction
```

Build this list once per project; check against any target tier before committing to it.

### 10. Plan a vendor-PaaS exit (operational hygiene)

If on managed PaaS, periodically verify you could leave:

1. Confirm you can run a full `pg_dump` of the cluster.
2. Confirm `wal_level=logical` is achievable on the vendor (for zero-downtime exit).
3. Maintain external monitoring (not just the vendor's dashboard) so you have observability post-migration.
4. Keep DDL in version control (Flyway / Alembic / Liquibase migrations) so you can rebuild schema anywhere.

## Gotchas / Anti-patterns

1. **Picking managed PaaS without checking the extension allowlist.** The most common late-discovery friction. Audit before committing.

2. **Assuming superuser is available.** Code that needs `SUPERUSER` is non-portable. Refactor with predefined roles.

3. **Using `COPY FROM '/server/path'` in migrations.** Universally blocked on managed. Use `\copy` (client-side) or `COPY FROM STDIN`.

4. **Using untrusted PLs (`plpython3u`, `plperlu`).** Almost always blocked. Refactor to `plpgsql` or trusted variants.

5. **Hard-coding `shared_preload_libraries` requirements.** Many extensions need a postmaster-load step. Check vendor allowlist before relying on `pg_cron`, `pg_partman_bgw`, etc.

6. **Assuming `archive_command` is yours to define.** Managed vendors own the WAL archive pipeline.

7. **Designing for sub-second PITR on managed PaaS.** Vendor PITR is usually time-target with 5-30 second granularity. For LSN or `recovery_target_xid`, bare-metal required.

8. **Relying on LDAP, GSSAPI, PAM, or RADIUS auth.** Managed PaaS supports SCRAM + (sometimes) cloud-IAM bridge only.

9. **Building C extensions in-place.** Bare-metal or K8s operator only.

10. **Provisioning a single bare-metal server with no replica / no backup.** "Bare-metal" doesn't mean "no HA." You take on the full ops burden; see [78](./78-ha-architectures.md) and [90](./90-disaster-recovery.md).

11. **Expecting a K8s operator to behave like managed PaaS.** Operators automate failover + backup, but you still own the cluster lifecycle, the K8s cluster, and the storage class. See [92](./92-kubernetes-operators.md).

12. **Forgetting that managed PaaS lags on PG major releases.** Vendor support for PG18 often arrives 3-12 months after the September GA. If you need the new major immediately, bare-metal or K8s operator.

13. **Using `lo_import` / `lo_export` in application code.** Blocked on managed. Use bytea or client-side LO API. See [71](./71-large-objects.md).

14. **Setting `max_connections` very high on bare-metal "because you can."** Connection-storm symptoms appear regardless of tier. Use a connection pooler (pgBouncer). See [80](./80-connection-pooling.md), [81](./81-pgbouncer.md).

15. **Thinking "managed = no DBA needed."** Managed handles infrastructure; you still need someone who reads `pg_stat_statements`, tunes `work_mem`, designs indexes, runs `EXPLAIN ANALYZE`, plans `VACUUM` budgets. SQL ops don't go away.

16. **Hard-coding GUCs in code that the vendor doesn't expose.** Use `SHOW` to check before relying on `SET`.

17. **Assuming logical-replication slots are unlimited on managed PaaS.** Vendor often caps `max_replication_slots` per instance class. Check.

18. **Forgetting that `pg_dump` requires `SELECT` on all tables for the dump role.** Even on managed, the dump role needs broad read access (or `pg_read_all_data`). See [83](./83-backup-pg-dump.md).

19. **Believing tablespace placement is portable.** Tablespaces with non-default location are bare-metal-only. Don't design schemas that depend on tablespace separation. See [62](./62-tablespaces.md).

20. **Using `pg_terminate_backend` or `pg_cancel_backend` from application code.** Often blocked or restricted on managed. Use connection timeouts (`statement_timeout`, `idle_in_transaction_session_timeout`) instead. See [41](./41-transactions.md).

21. **Assuming `pg_resetwal` is available.** Last-resort recovery tool. Blocked on managed (vendor handles disaster). On bare-metal, dangerous but available. See [88](./88-corruption-recovery.md).

22. **Designing for "I can edit `pg_hba.conf` to debug auth issues."** On managed, auth is via vendor API. Debug auth issues via the vendor's IAM / firewall UI, not by editing files.

23. **Not testing vendor lock-out.** Quarterly, verify your team can perform a full restore from `pg_dump` to a separate cluster (any tier). This is the canonical "are we trapped?" exercise.

## See Also

- [91-docker-postgres.md](./91-docker-postgres.md) — Single-host Docker patterns (sits between bare-metal and K8s operator)
- [92-kubernetes-operators.md](./92-kubernetes-operators.md) — K8s operators (the middle-ground tier)
- [78-ha-architectures.md](./78-ha-architectures.md) — HA patterns you can implement on each tier
- [79-patroni.md](./79-patroni.md) — Patroni (bare-metal / K8s-operator HA)
- [80-connection-pooling.md](./80-connection-pooling.md) — Pooling decisions, tier-independent
- [81-pgbouncer.md](./81-pgbouncer.md) — pgBouncer (deploy-anywhere)
- [82-monitoring.md](./82-monitoring.md) — Tier-portable monitoring metrics
- [83-backup-pg-dump.md](./83-backup-pg-dump.md) — Logical backup (portable across tiers)
- [84-backup-physical-pitr.md](./84-backup-physical-pitr.md) — Physical backup + PITR (bare-metal / K8s operator)
- [85-backup-tools.md](./85-backup-tools.md) — pgBackRest / Barman / WAL-G (bare-metal / K8s operator)
- [86-pg-upgrade.md](./86-pg-upgrade.md) — Bare-metal in-place upgrade
- [87-major-version-upgrade.md](./87-major-version-upgrade.md) — Upgrade strategies across tiers
- [46-roles-privileges.md](./46-roles-privileges.md) — Predefined roles (the portable SUPERUSER alternative)
- [48-authentication-pg-hba.md](./48-authentication-pg-hba.md) — Auth methods that work on each tier
- [66-bulk-operations-copy.md](./66-bulk-operations-copy.md) — Client-side `\copy` (the portable bulk-load)
- [69-extensions.md](./69-extensions.md) — Extension catalog (verify allowlist on each tier)
- [71-large-objects.md](./71-large-objects.md) — `bytea` vs LO (LO blocked on managed)
- [74-logical-replication.md](./74-logical-replication.md) — Logical replication (crosses tier boundaries)
- [75-replication-slots.md](./75-replication-slots.md) — Slot management (vendor-restricted on managed)
- [95-postgis.md](./95-postgis.md) — PostGIS as a canonical extension allowlist example across managed tiers
- [96-timescaledb.md](./96-timescaledb.md) — TimescaleDB TSL license + allowlist position across managed providers
- [97-citus.md](./97-citus.md) — Citus availability and `shared_preload_libraries` requirements on managed tiers
- [98-pg-cron.md](./98-pg-cron.md) — pg_cron `shared_preload_libraries` requirement and vendor allowlist portability
- [99-pg-partman.md](./99-pg-partman.md) — pg_partman_bgw rarely allowed on managed; use pg_cron + run_maintenance_proc instead
- [100-pg-versions-features.md](./100-pg-versions-features.md) — Major-version lifecycle; vendor lag
- [102-skill-cookbook.md](./102-skill-cookbook.md) — Cross-tier operational recipes including portability audit

## Sources

This file is a categorical synthesis rather than a docs-cite-heavy reference. The Postgres documentation pages below are the canonical authority for each capability discussed; specific vendor behaviors must be verified against each vendor's own documentation.

[^1]: PostgreSQL Documentation, "Predefined Roles." https://www.postgresql.org/docs/16/predefined-roles.html (verified 2026-05-14). Source of the `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program`, `pg_read_all_data`, `pg_write_all_data`, `pg_monitor`, `pg_maintain` (PG17+) predefined-role catalog discussed throughout.

[^2]: PostgreSQL Documentation, "Role Attributes." https://www.postgresql.org/docs/16/role-attributes.html (verified 2026-05-14). Source of `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS` attribute semantics.

[^3]: PostgreSQL Documentation, "Authentication Methods." https://www.postgresql.org/docs/16/auth-methods.html (verified 2026-05-14). Source of the auth-method catalog (scram-sha-256, md5, peer, trust, cert, ldap, gss, sspi, ident, pam, radius) discussed in the auth section.

[^4]: PostgreSQL Documentation, "Server Configuration." https://www.postgresql.org/docs/16/runtime-config.html (verified 2026-05-14). Source of the parameter-context model (`internal`, `postmaster`, `sighup`, `superuser-backend`, `backend`, `superuser`, `user`) that determines what's mutable post-startup.

[^5]: PostgreSQL Documentation, "Continuous Archiving and Point-in-Time Recovery." https://www.postgresql.org/docs/16/continuous-archiving.html (verified 2026-05-14). Source of the `archive_command` / `archive_library` / `restore_command` discussion.

[^6]: PostgreSQL Documentation, "Streaming Replication." https://www.postgresql.org/docs/16/warm-standby.html#STREAMING-REPLICATION (verified 2026-05-14). Source of replication-slot semantics referenced in the slots discussion.

[^7]: PostgreSQL Documentation, "Logical Replication." https://www.postgresql.org/docs/16/logical-replication.html (verified 2026-05-14). Source of `wal_level=logical`, `CREATE PUBLICATION` / `CREATE SUBSCRIPTION` semantics for cross-tier migration recipes.

[^8]: PostgreSQL Documentation, "COPY." https://www.postgresql.org/docs/16/sql-copy.html (verified 2026-05-14). Source of the server-side vs client-side `COPY` distinction; verbatim: "COPY with a file name instructs the PostgreSQL server to directly read from or write to a file."

[^9]: PostgreSQL Documentation, "Extensions." https://www.postgresql.org/docs/16/external-extensions.html (verified 2026-05-14). Source of the extension installation model and the trusted-extension flag (PG13+) referenced in the allowlist discussion.

[^10]: PostgreSQL Documentation, "Procedural Languages." https://www.postgresql.org/docs/16/xplang.html (verified 2026-05-14). Source of the trusted-vs-untrusted PL distinction underpinning the `plpython3u` / `plperlu` portability concern.

[^11]: PostgreSQL Documentation, "Large Objects." https://www.postgresql.org/docs/16/largeobjects.html (verified 2026-05-14). Source of `lo_import` / `lo_export` server-side semantics that fail on managed PaaS.

[^12]: PostgreSQL Documentation, "Tablespaces." https://www.postgresql.org/docs/16/manage-ag-tablespaces.html (verified 2026-05-14). Source of the `CREATE TABLESPACE LOCATION` filesystem requirement that conflicts with managed PaaS isolation.

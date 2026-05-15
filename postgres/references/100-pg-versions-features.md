# PostgreSQL Versions and Features

Major-version release cadence, support policy, and headline features per PG14 / PG15 / PG16 / PG17 / PG18. **This file covers WHAT changed in each major.** For HOW to upgrade between majors, see [87-major-version-upgrade.md](./87-major-version-upgrade.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Release Cadence and Versioning](#release-cadence-and-versioning)
- [Support Policy and EOL Calendar](#support-policy-and-eol-calendar)
- [Per-Version Headline Features](#per-version-headline-features)
    - [PostgreSQL 14 (2021-09-30, EOL 2026-11-12)](#postgresql-14-2021-09-30-eol-2026-11-12)
    - [PostgreSQL 15 (2022-10-13, EOL 2027-11-11)](#postgresql-15-2022-10-13-eol-2027-11-11)
    - [PostgreSQL 16 (2023-09-14, EOL 2028-11-09)](#postgresql-16-2023-09-14-eol-2028-11-09)
    - [PostgreSQL 17 (2024-09-26, EOL 2029-11-08)](#postgresql-17-2024-09-26-eol-2029-11-08)
    - [PostgreSQL 18 (2025-09-25, EOL 2030-11-14)](#postgresql-18-2025-09-25-eol-2030-11-14)
- [Theme-Crosscut Tables](#theme-crosscut-tables)
- [Recipes](#recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use when:

- Picking a target major version for new cluster or planned upgrade
- Checking whether running branch still supported
- Looking up which release introduced specific feature
- Auditing technical-debt risk against EOL calendar

Do NOT use when:

- Need upgrade procedure → [87-major-version-upgrade.md](./87-major-version-upgrade.md)
- Need pg_upgrade mechanics → [86-pg-upgrade.md](./86-pg-upgrade.md)
- Need DR planning → [90-disaster-recovery.md](./90-disaster-recovery.md)
- Need backup-format compatibility → [83-backup-pg-dump.md](./83-backup-pg-dump.md)

## Mental Model

Five rules:

1. **Annual major release in October.** PGDG ships new major roughly every September-October. Verbatim from /support/versioning/: "The PostgreSQL Global Development Group releases a new major version containing new features about once a year."[^1]

2. **5-year support policy per major, EOL'd in November of fifth year.** Verbatim: "The PostgreSQL Global Development Group supports a major version for 5 years after its initial release."[^1] Branch dies on second Thursday of November (the regular minor-release day for that month).

3. **Versioning since PG10 = single integer for major.** Verbatim: "Starting with PostgreSQL 10, a major version is indicated by increasing the first part of the version, e.g. 10 to 11."[^1] Pre-PG10 used 9.x.y three-part numbering (9.6 → 10 was the cutover). Minor releases are now PATCH only (e.g., 17.9 = 9th patch of major 17).

4. **At any time, five majors are supported.** PG14, 15, 16, 17, 18 as of today (2026-05-14). PG13 EOL'd 2025-11-13 (six months ago). PG14 EOLs in November 2026 (six months away). Always at least one EOL deadline within rolling 12-month window.

5. **Headline-features lists are NOT exhaustive.** Each major has hundreds of changes. The "press release" 5-7 items are surface markers — for behavior changes that affect existing queries, read the full release notes via [/docs/N/release-N.html](https://www.postgresql.org/docs/16/release-16.html).

## Decision Matrix

| Situation | Action |
|---|---|
| New cluster, fresh start | Use **PG18** (current, supported through 2030-11) |
| Greenfield but conservative | Use **PG17** (one year of patches, supported through 2029-11) |
| Existing PG13 cluster | **Migrate now** — already EOL since 2025-11-13 (no security patches) |
| Existing PG14 cluster | **Plan upgrade now** — EOL 2026-11-12, ~6 months remaining |
| Existing PG15 cluster | Plan upgrade within 18 months — EOL 2027-11-11 |
| Audit which extensions support target major | See [86-pg-upgrade.md](./86-pg-upgrade.md) preflight |
| Cross-check feature introduced in version | Use [Theme-Crosscut Tables](#theme-crosscut-tables) below |
| Look up patch-level fix | See [/support/versioning/](https://www.postgresql.org/support/versioning/) "Current Minor" column |
| Distinguish feature-add from behavior-change | Read full release notes (Incompatibilities section first) |
| Plan against vendor extension version-pinning | See per-extension files 93-99 + [87-major-version-upgrade.md](./87-major-version-upgrade.md) |
| Estimate technical-debt-burndown deadline | See [Support Policy and EOL Calendar](#support-policy-and-eol-calendar) |

Three smell signals:

- **Running an EOL'd version in production.** No security patches. Audit cluster's `SHOW server_version` against EOL table; PG13 and below are dead.
- **"Feature X requires upgrade" claim without version cite.** Verify against release notes — false-confidence about feature availability is a long-tail hazard.
- **Extension version not checked before pg_upgrade.** Third-party extension may not yet support new PG major — see [87 gotcha #8](./87-major-version-upgrade.md#gotchas--anti-patterns).

## Release Cadence and Versioning

> [!NOTE] Cadence is annual, in October
> Each major typically released second or third week of October. PG18 went GA 2025-09-25 (earlier than usual). PG14 was 2021-09-30. PG15 was 2022-10-13. PG16 was 2023-09-14. PG17 was 2024-09-26.[^1]

Minor releases happen on **second Thursday of every February, May, August, and November**. EOL date for each major = minor release of November of fifth year. Example: PG14's last minor release will be 2026-11-12 (the November 2026 quarterly minor).

Pre-PG10 versioning (9.x and earlier): major number = `9.X`, minor = `Y`. Example: 9.6.24. **PG9.6 was the last release with this scheme.**

PG10+ versioning: major = `N`, minor = `N.M`. Example: 17.9 = major 17, ninth minor (patch) release of that major. No 9.6-style three-part version exists post-PG10.

`SHOW server_version_num` returns major+minor packed integer:
- PG14.22 → `140022`
- PG15.17 → `150017`
- PG16.13 → `160013`
- PG17.9 → `170009`
- PG18.3 → `180003`

Useful for version-conditional SQL: `WHEN current_setting('server_version_num')::int >= 170000`.

## Support Policy and EOL Calendar

> [!WARNING] PG13 already EOL — PG14 EOL in ~6 months
> Per /support/versioning/ as of 2026-05-14: PG13 EOL'd 2025-11-13. PG14 EOLs 2026-11-12 (about six months away). PG15, 16, 17, 18 currently supported.

Verbatim policy quote: "The PostgreSQL Global Development Group supports a major version for 5 years after its initial release."[^1]

| Major | Current Minor | Supported | First Release | Final Release (EOL) |
|---|---|---|---|---|
| 18 | 18.3 | **Yes** | 2025-09-25 | 2030-11-14 |
| 17 | 17.9 | **Yes** | 2024-09-26 | 2029-11-08 |
| 16 | 16.13 | **Yes** | 2023-09-14 | 2028-11-09 |
| 15 | 15.17 | **Yes** | 2022-10-13 | 2027-11-11 |
| 14 | 14.22 | **Yes** | 2021-09-30 | 2026-11-12 |
| 13 | 13.23 | No | 2020-09-24 | 2025-11-13 (past) |
| 12 | 12.22 | No | 2019-10-03 | 2024-11-21 (past) |
| 11 | 11.22 | No | 2018-10-18 | 2023-11-09 (past) |
| 10 | 10.23 | No | 2017-10-05 | 2022-11-10 (past) |

After EOL date, branch receives NO further updates — no security fixes, no bug fixes. Verbatim: "While we will not stop you from running an unsupported version, we strongly recommend that you do not. Once a release is unsupported, you are at risk for unfixed issues, including data corruption and security holes."[^1]

Most recent quarterly minor release: 2026-02-26 (delivered 18.3 / 17.9 / 16.13 / 15.17 / 14.22). Next: 2026-05 (second Thursday of May).

## Per-Version Headline Features

Quoted from upstream release notes overview. Lists are illustrative, NOT exhaustive — full release notes contain hundreds of changes per major.

### PostgreSQL 14 (2021-09-30, EOL 2026-11-12)

**Major performance + ergonomics release.** Heavy work on B-tree bloat, parallel query, partitioning, logical replication.

- **OUT parameters in stored procedures** — procedures can return values via OUT/INOUT parameters. See [07-procedures.md](./07-procedures.md).
- **SQL-standard CTE SEARCH and CYCLE clauses** — recursive CTEs can declare search order and cycle detection inline. See [04-ctes.md](./04-ctes.md).
- **Generalized subscripting** — `jsonb`, `hstore`, custom types can use `[]` syntax. See [17-json-jsonb.md](./17-json-jsonb.md) and [21-hstore.md](./21-hstore.md).
- **Multirange types** — non-contiguous ranges (`int4multirange`, `tstzmultirange`, etc.). See [15-data-types-custom.md](./15-data-types-custom.md).
- **B-tree bottom-up index deletion** — reduces index bloat from update-heavy workloads.
- **Parallel REINDEX**, parallel logical-replication initial sync improvements.
- **`predefined roles` expansion** — `pg_read_all_data` and `pg_write_all_data` added.
- **`recovery_init_sync_method=syncfs` GUC** — faster crash recovery on Linux.
- **`idle_session_timeout` GUC** — kill idle sessions (different from idle-in-transaction).

### PostgreSQL 15 (2022-10-13, EOL 2027-11-11)

**SQL/JSON + replication + sort performance.** First version with native `MERGE` command.

- **SQL-standard `MERGE` command** — upsert-or-delete in one statement. See [03-syntax-dml.md](./03-syntax-dml.md).
- **Row filters and column lists in logical-replication publications** — `CREATE PUBLICATION ... FOR TABLE t WHERE (...)` / `(col1, col2)`. See [74-logical-replication.md](./74-logical-replication.md).
- **Zstandard (zstd) compression** — WAL compression and server-side pg_basebackup compression. See [33-wal.md](./33-wal.md) and [84-backup-physical-pitr.md](./84-backup-physical-pitr.md).
- **Structured JSON server logs** — `log_destination=jsonlog`. See [82-monitoring.md](./82-monitoring.md).
- **Sort performance improvements** — both in-memory and external-merge sort got faster.
- **`security_invoker` views** — view executes as caller, not owner. See [05-views.md](./05-views.md).
- **`pg_basebackup --target`** — write backup directly to remote target (server-side, client-side, blackhole).
- **`UNIQUE NULLS NOT DISTINCT`** — treat NULL as duplicate for uniqueness checks. See [37-constraints.md](./37-constraints.md).
- **`ICU` collation provider** can now be cluster-wide (introduced in PG10 per-database).
- **PUBLIC schema CREATE revoked from PUBLIC** — new clusters require explicit `GRANT CREATE ON SCHEMA public TO ...`. See [46-roles-privileges.md gotcha #3](./46-roles-privileges.md#gotchas--anti-patterns).

### PostgreSQL 16 (2023-09-14, EOL 2028-11-09)

**Logical replication maturity + observability.** First version with `pg_stat_io` view.

- **Parallel FULL and right-OUTER hash joins** — planner can parallelize previously-serial join shapes.
- **Logical replication from standby** — subscriber can subscribe to a physical standby's published tables. See [74-logical-replication.md](./74-logical-replication.md).
- **Parallel apply of large transactions on subscriber** — `streaming=parallel` opt-in. See [74 admonition](./74-logical-replication.md).
- **`pg_stat_io` view** — per-relation, per-context, per-backend-type I/O statistics. See [58-performance-diagnostics.md](./58-performance-diagnostics.md) and [32-buffer-manager.md](./32-buffer-manager.md).
- **SQL/JSON constructors** — `JSON_ARRAY()`, `JSON_OBJECT()`, `JSON_ARRAYAGG()`, `JSON_OBJECTAGG()`. See [17-json-jsonb.md](./17-json-jsonb.md).
- **Page-freezing during normal vacuum** — `VACUUM` opportunistically freezes pages while it's already touching them. See [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md).
- **`pg_hba.conf` and `pg_ident.conf` include directives** — `include_dir`, `include_if_exists`. See [48-authentication-pg-hba.md](./48-authentication-pg-hba.md).
- **`pg_hba.conf` regex matching** on database and user columns.
- **CREATEROLE narrowed** — non-superuser with CREATEROLE can no longer trivially grant SUPERUSER or BYPASSRLS to other roles. See [46-roles-privileges.md](./46-roles-privileges.md).
- **HOT updates with BRIN-only indexed column** — PG16 relaxes the HOT-disabled rule for BRIN-only updates. See [30-hot-updates.md](./30-hot-updates.md).
- **`ALTER SYSTEM`-grantable parameters** — non-superuser can ALTER SYSTEM specific GUCs via `GRANT ... ON PARAMETER`. See [53-server-configuration.md](./53-server-configuration.md).

### PostgreSQL 17 (2024-09-26, EOL 2029-11-08)

**Vacuum memory + SQL/JSON completion + streaming I/O.** Major upgrade-experience overhaul.

- **New VACUUM memory management** — removes the silent 1GB cap on `maintenance_work_mem` and `autovacuum_work_mem`. Vacuum on very large tables now scales with available RAM. See [54-memory-tuning.md gotcha #6](./54-memory-tuning.md) and [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md).
- **`JSON_TABLE()`** — convert JSON to relational table on the fly. SQL/JSON `JSON_EXISTS()`, `JSON_QUERY()`, `JSON_VALUE()` constructors complete the SQL/JSON spec coverage. See [17-json-jsonb.md](./17-json-jsonb.md).
- **Streaming I/O for sequential reads** — sequential scans now use a streaming-read API, faster on high-latency storage. Foundation for PG18 AIO. See [32-buffer-manager.md](./32-buffer-manager.md).
- **Multi-value B-tree index search** — `WHERE col IN (a, b, c)` can now use a single index descent per value batch.
- **`pg_createsubscriber` CLI** — convert a physical replica to a logical-replication subscriber without re-bootstrapping. See [74-logical-replication.md](./74-logical-replication.md) and [77-standby-failover.md](./77-standby-failover.md).
- **Logical replication slots preserved through `pg_upgrade`** — major-upgrade no longer requires re-creating subscriptions. See [86-pg-upgrade.md](./86-pg-upgrade.md).
- **Logical-slot failover via standby sync** — `failover=true` on slot creation + `synchronized_standby_slots` + `sync_replication_slots`. See [75-replication-slots.md](./75-replication-slots.md).
- **`sslnegotiation=direct`** — TLS handshake without prior CLEARTEXT round-trip via ALPN. See [49-tls-ssl.md](./49-tls-ssl.md).
- **`pg_basebackup --incremental`** + `pg_combinebackup` — incremental + synthetic-full backups. See [84-backup-physical-pitr.md](./84-backup-physical-pitr.md).
- **`COPY ... ON_ERROR ignore`** — skip rows with parse errors instead of failing whole copy. See [66-bulk-operations-copy.md](./66-bulk-operations-copy.md).
- **`MERGE ... RETURNING`** + `merge_action()` function.
- **`MAINTAIN` privilege** + `pg_maintain` role — non-superuser can VACUUM, ANALYZE, REINDEX, REFRESH MATERIALIZED VIEW. See [46-roles-privileges.md](./46-roles-privileges.md).
- **`pg_stat_checkpointer` view** — checkpoint stats split from `pg_stat_bgwriter`. See [34-checkpoints-bgwriter.md](./34-checkpoints-bgwriter.md) and [58 headline WARNING](./58-performance-diagnostics.md).
- **`transaction_timeout` GUC** — kill any transaction (including idle-in-tx and in-progress queries) after threshold. See [41-transactions.md](./41-transactions.md).
- **`old_snapshot_threshold` GUC removed** — old mechanism for forcing snapshot expiration retired. See [27-mvcc-internals.md](./27-mvcc-internals.md).

### PostgreSQL 18 (2025-09-25, EOL 2030-11-14)

**Asynchronous I/O + pg_upgrade preserves stats + skip scan.** Biggest perf release in years.

- **Asynchronous I/O subsystem** — `io_method` GUC (default `worker`, opt-in `io_uring` on Linux). Up to 3x faster on read-heavy workloads (seq scans, bitmap heap scans, vacuum). New `pg_aios` view. See [32-buffer-manager.md](./32-buffer-manager.md).
- **`pg_upgrade` preserves optimizer statistics** — no more cluster-wide `vacuumdb --analyze-in-stages` post-upgrade for PG17→18 jumps. Extended stats still NOT preserved. See [55-statistics-planner.md headline](./55-statistics-planner.md) and [86-pg-upgrade.md](./86-pg-upgrade.md).
- **B-tree skip scan** — multicolumn index can answer queries that don't filter on the leading column. See [23-btree-indexes.md](./23-btree-indexes.md).
- **`uuidv7()` in core** — time-ordered UUIDs without extension. See [18-uuid-numeric-money.md](./18-uuid-numeric-money.md).
- **Virtual generated columns as default** — new generated columns are VIRTUAL unless declared STORED. PG14-17 had STORED-only. See [01-syntax-ddl.md](./01-syntax-ddl.md).
- **OAuth 2.0 authentication method** — first new auth method since SCRAM. Requires validator library. See [48-authentication-pg-hba.md](./48-authentication-pg-hba.md).
- **`RETURNING OLD ... NEW ...`** — INSERT/UPDATE/DELETE/MERGE can return both old and new rows in one statement. See [03-syntax-dml.md](./03-syntax-dml.md).
- **Temporal constraints `WITHOUT OVERLAPS`** — PRIMARY KEY / UNIQUE / FK can declare time-range-non-overlap semantics. See [37-constraints.md](./37-constraints.md) and [38-foreign-keys-deep.md](./38-foreign-keys-deep.md).
- **`PG_UNICODE_FAST` collation provider + `casefold()` function** — Unicode-correct case folding. LIKE on nondeterministic collations now works. See [65-collations-encoding.md](./65-collations-encoding.md).
- **Parallel GIN index builds**. See [24-gin-gist-indexes.md](./24-gin-gist-indexes.md).
- **Data checksums on by default** — `initdb` enables them unless `--no-data-checksums`. Affects pg_upgrade from pre-PG18 non-checksum clusters. See [88-corruption-recovery.md](./88-corruption-recovery.md) and [33-wal.md](./33-wal.md).
- **`idle_replication_slot_timeout` GUC** — auto-invalidate slots idle past threshold. See [75-replication-slots.md](./75-replication-slots.md).
- **`pg_stat_io` extended with bytes columns and WAL rows**. New `pg_stat_get_backend_io()` per-backend function. See [58-performance-diagnostics.md](./58-performance-diagnostics.md).
- **`pg_stat_checkpointer.num_done` and `slru_written`** — distinguish completed-from-skipped checkpoints.
- **AFTER triggers fire as queue-time role, not commit-time role.** Silent semantic change. See [39-triggers.md headline WARNING](./39-triggers.md).
- **`promote_trigger_file` removed** (was deprecated since PG12, removed in PG16) — only `pg_promote()` and `pg_ctl promote` work.

## Theme-Crosscut Tables

Use these to find which version introduced a feature in a given area.

### Replication and HA

| Feature | Version |
|---|---|
| Logical replication | PG10 |
| Streaming replication slot WAL bound (`max_slot_wal_keep_size`) | PG13 |
| Row filters + column lists in publications | PG15 |
| Logical replication from standby | PG16 |
| Parallel apply (`streaming=parallel`) | PG16 |
| `pg_createsubscriber` | PG17 |
| Logical slot survives `pg_upgrade` | PG17 |
| Logical slot failover (`failover=true` + `sync_replication_slots`) | PG17 |
| `idle_replication_slot_timeout` | PG18 |

### Backup and recovery

| Feature | Version |
|---|---|
| `recovery.conf` removed (use `standby.signal` / `recovery.signal` + GUCs) | PG12 |
| `pg_basebackup --target` (server-side write) | PG15 |
| Server-side zstd / lz4 compression | PG15 |
| `archive_library` GUC alternative to `archive_command` | PG15 |
| `pg_basebackup --incremental` + `pg_combinebackup` | PG17 |
| `pg_basebackup --target=server` direct write | PG15 |
| `pg_dump --filter` rule file | PG17 |
| `pg_dump --on-conflict-do-nothing` | PG17 |
| `pg_verifybackup --format=tar` | PG18 |

### Performance and planner

| Feature | Version |
|---|---|
| B-tree bottom-up index deletion | PG14 |
| Memoize plan node | PG14 |
| `enable_memoize` GUC | PG14 |
| `enable_presorted_aggregate` | PG16 |
| Multi-value B-tree index search (IN-list) | PG17 |
| Streaming I/O for sequential reads | PG17 |
| Asynchronous I/O subsystem | PG18 |
| B-tree skip scan | PG18 |
| Parallel GIN index builds | PG18 |
| Parallel BRIN index builds | PG17 |
| `pg_upgrade` preserves optimizer stats | PG18 |

### SQL surface

| Feature | Version |
|---|---|
| `MERGE` command | PG15 |
| SQL/JSON constructors (`JSON_ARRAY`, `JSON_OBJECT`, etc.) | PG16 |
| SQL/JSON `JSON_TABLE`, `JSON_EXISTS`, `JSON_QUERY`, `JSON_VALUE` | PG17 |
| `MERGE ... RETURNING` + `merge_action()` | PG17 |
| `RETURNING OLD ... NEW ...` | PG18 |
| Multirange types | PG14 |
| Generalized subscripting (`jsonb[k]`) | PG14 |
| `UNIQUE NULLS NOT DISTINCT` | PG15 |
| Temporal constraints (`WITHOUT OVERLAPS`) | PG18 |
| Virtual generated columns as default | PG18 |
| CTE `SEARCH` and `CYCLE` clauses | PG14 |

### Security and auth

| Feature | Version |
|---|---|
| `pg_read_all_data` / `pg_write_all_data` predefined roles | PG14 |
| `security_invoker` views | PG15 |
| `MAINTAIN` privilege + `pg_maintain` role | PG17 |
| `sslnegotiation=direct` (ALPN) | PG17 |
| `pg_hba.conf` regex + include directives | PG16 |
| `ALTER SYSTEM`-grantable parameters | PG15 |
| OAuth 2.0 auth method | PG18 |
| Data checksums on by default | PG18 |

### Observability

| Feature | Version |
|---|---|
| `pg_stat_io` view | PG16 |
| `pg_stat_checkpointer` view (split from `pg_stat_bgwriter`) | PG17 |
| `log_destination=jsonlog` | PG15 |
| `pg_stat_wal` columns relocated to `pg_stat_io` | PG18 |
| `pg_aios` view (async I/O state) | PG18 |
| `pg_get_backend_io()` per-backend function | PG18 |
| `pg_stat_checkpointer.num_done` (distinguishes completed from skipped) | PG18 |

### Configuration

| Feature | Version |
|---|---|
| `idle_session_timeout` GUC | PG14 |
| `transaction_timeout` GUC | PG17 |
| `idle_replication_slot_timeout` GUC | PG18 |
| `recovery_init_sync_method=syncfs` | PG14 |
| `wal_compression=lz4` and `zstd` | PG15 |
| `archive_library` GUC | PG15 |
| `io_method` GUC (AIO) | PG18 |

## Recipes

### Recipe 1: Check current cluster version and upgrade urgency

```sql
SELECT
    current_setting('server_version') AS version_string,
    current_setting('server_version_num')::int AS version_num,
    CASE
        WHEN current_setting('server_version_num')::int < 140000
            THEN 'EOL — upgrade immediately'
        WHEN current_setting('server_version_num')::int < 150000
            THEN 'EOL November 2026 — plan upgrade'
        WHEN current_setting('server_version_num')::int < 160000
            THEN 'EOL November 2027'
        WHEN current_setting('server_version_num')::int < 170000
            THEN 'EOL November 2028'
        WHEN current_setting('server_version_num')::int < 180000
            THEN 'EOL November 2029'
        ELSE 'EOL November 2030'
    END AS support_window;
```

### Recipe 2: Pick target major for a planned upgrade

| Want | Pick |
|---|---|
| Maximum stability, want patches for 5 years | **PG18** (newest GA, 5 years patches ahead) |
| Conservative, prefer year of patches accumulated | **PG17** |
| Already running PG17, no AIO need yet | **Stay on PG17** until extension matrix supports PG18 |
| Running PG14, planning 2-major jump | **PG17** is safer than PG18 — well-vetted, extension compatibility wide |
| Need PG18-only feature (uuidv7, AIO, temporal FK, RETURNING OLD/NEW) | **PG18** |

### Recipe 3: Audit cluster-wide for EOL'd installations

If you run multiple clusters:

```bash
for host in db1 db2 db3 db4 db5; do
    version=$(psql -h $host -At -c "SHOW server_version_num")
    if [ "$version" -lt 140000 ]; then
        echo "$host: EOL ($version)"
    fi
done
```

### Recipe 4: Conditional SQL based on server version

```sql
DO $$
BEGIN
    IF current_setting('server_version_num')::int >= 180000 THEN
        EXECUTE 'CREATE TABLE event (
            id uuid PRIMARY KEY DEFAULT uuidv7(),
            payload jsonb NOT NULL
        )';
    ELSIF current_setting('server_version_num')::int >= 130000 THEN
        EXECUTE 'CREATE TABLE event (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            payload jsonb NOT NULL
        )';
    ELSE
        RAISE EXCEPTION 'PostgreSQL 13+ required';
    END IF;
END $$;
```

### Recipe 5: Check whether a feature is available before using it

```sql
-- Is RETURNING OLD/NEW supported? (PG18+)
SELECT current_setting('server_version_num')::int >= 180000 AS has_returning_old_new;

-- Is JSON_TABLE() available? (PG17+)
SELECT current_setting('server_version_num')::int >= 170000 AS has_json_table;

-- Is MERGE supported? (PG15+)
SELECT current_setting('server_version_num')::int >= 150000 AS has_merge;
```

### Recipe 6: Audit installed extensions for major-upgrade readiness

```sql
SELECT
    e.extname,
    e.extversion AS installed,
    av.version AS available
FROM pg_extension e
LEFT JOIN pg_available_extension_versions av
    ON av.name = e.extname AND av.installed
ORDER BY e.extname;
```

After loading the new binaries on the target cluster, compare against `pg_available_extension_versions` for the new install — any extension lacking a compatible version is a blocker. See [86-pg-upgrade.md](./86-pg-upgrade.md).

### Recipe 7: Time-budget your EOL deadline

Given that the support policy is 5 years from initial release:

- **EOL date is fixed at install time** — does NOT slip if patches are still flowing.
- Plan upgrade for **at least 6 months before EOL** (gives time for test cluster, dry-run, rollback plan).
- Plan upgrade for **at least 12 months before EOL** if you depend on third-party extensions (vendor lag is real).

For example, today (2026-05-14) you should already have a PG14→PG17 or PG14→PG18 plan in motion (PG14 EOL is 2026-11-12).

### Recipe 8: Diff-the-release-notes pre-upgrade

Skim incompatibilities section in target version's release notes:

- PG14: https://www.postgresql.org/docs/14/release-14.html
- PG15: https://www.postgresql.org/docs/15/release-15.html
- PG16: https://www.postgresql.org/docs/16/release-16.html
- PG17: https://www.postgresql.org/docs/17/release-17.html
- PG18: https://www.postgresql.org/docs/18/release-18.html

For multi-major jumps (e.g., PG14 → PG18), read EVERY intermediate release notes file, NOT just the target's. Each major has its own incompatibilities section.

### Recipe 9: Subscribe to security-update notifications

`pgsql-announce` mailing list: https://www.postgresql.org/list/pgsql-announce/

Plus CVE feed: https://www.postgresql.org/support/security/

### Recipe 10: Verify your minor-version patch level is current

```sql
SELECT current_setting('server_version') AS minor;
```

Compare against current minor in the EOL table (or fetch from https://www.postgresql.org/support/versioning/). If you're more than 6 months behind on minor patches, schedule a rolling restart to apply.

### Recipe 11: Audit which features your codebase depends on

Grep your migrations and application SQL for version-gated features:

```bash
grep -rE 'MERGE|JSON_TABLE|RETURNING OLD|RETURNING NEW|WITHOUT OVERLAPS|uuidv7|casefold' migrations/
```

Each hit pins your minimum supported PG version per the Theme-Crosscut tables above.

### Recipe 12: Distinguish feature-add from behavior-change

Release notes have three sections:

1. **Migration to Version N** — incompatibilities and behavior changes. **READ THIS FIRST** before upgrading.
2. **Changes** — new features, organized by area.
3. **Acknowledgments** — credit roll.

Examples of behavior changes that bit users:

- PG15 removed PUBLIC's CREATE privilege on the `public` schema. New clusters need explicit grant.
- PG17 split `pg_stat_bgwriter` into `pg_stat_bgwriter` + `pg_stat_checkpointer`. Monitoring queries break.
- PG18 changed AFTER-trigger role binding from commit-time role to queue-time role. Audit triggers may misattribute writes.
- PG18 enabled data checksums by default. `pg_upgrade` from non-checksum cluster is blocked.

### Recipe 13: Find out when a specific feature shipped

If unsure when feature X arrived:

1. Search release notes for keyword (use site:postgresql.org/docs/*/release in Google).
2. Or check git log: `git log --oneline --grep='<feature>' postgres/` on a local clone of the source.
3. Or use the Theme-Crosscut tables above.

## Gotchas / Anti-patterns

1. **Running PG13 or older in production.** PG13 EOL'd 2025-11-13. No security patches. Migrate now.

2. **Running PG14 in 2026-Q2 without an upgrade plan.** PG14 EOLs 2026-11-12 — 6 months away.

3. **Assuming `9.x` versioning is current.** PG10 changed to single-integer-major in 2017. If a tutorial or library docs say "`SHOW server_version` returns 9.6.X for the X.Y minor of major 9.6," they are pre-2017.

4. **Treating `server_version_num` as patch-numbering aware.** `version_num` packs major + minor only. For exact build (e.g., compile flags, OS package version), check `SELECT version()`.

5. **Mixing minor releases across HA cluster.** Patroni / repmgr / streaming-replication clusters must run **identical** minor versions on primary and standbys. A minor-skew can cause failover failures and WAL incompatibility. See [78-ha-architectures.md](./78-ha-architectures.md).

6. **Believing the "current" alias in docs URLs.** `/docs/current/` moves with every major release. Cite specific majors: `/docs/16/`, `/docs/17/`, `/docs/18/`.

7. **Treating release notes as exhaustive.** A major has hundreds of changes. The "press release" 5-7 items are headlines, not the full picture. Multi-major jumps require reading EVERY intermediate release notes file.

8. **Skipping the Incompatibilities section.** Each release-notes file leads with "Migration to Version N." This is the section that breaks production. Read it first.

9. **Carrying forward old planner cost defaults.** PG-version upgrades sometimes change default GUCs (e.g., PG13 lowered `vacuum_cost_page_miss` from 10 to 2; PG14 raised `checkpoint_completion_target` from 0.5 to 0.9; PG18 raised `effective_io_concurrency` from 1 to 16). If your `postgresql.conf` overrides these to the old values, you're carrying forward stale tuning. See [53-server-configuration.md](./53-server-configuration.md) and [54-memory-tuning.md](./54-memory-tuning.md).

10. **Believing extensions move at the same cadence.** pgvector, PostGIS, TimescaleDB, Citus, pg_cron, pg_partman all have their own release schedules. A new PG major doesn't mean a compatible extension version exists yet. See files 93-99 + [86-pg-upgrade.md](./86-pg-upgrade.md) preflight.

11. **Confusing "PG18 feature X" with "available everywhere."** Managed-Postgres providers may lag by months on offering new PG majors. See [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md).

12. **Not knowing where your cluster sits in the EOL window.** Run `SHOW server_version_num` regularly; alert if you're within 6 months of EOL.

13. **Trusting the marketing post over the release notes.** "PG18 is N% faster!" benchmarks are workload-specific. Read what specifically changed in the planner / executor / storage layer to see if your workload is affected.

14. **Ignoring the second-Thursday-of-November rule.** That's the date your branch dies. PG14 dies 2026-11-12. PG15 dies 2027-11-11. Mark the calendar.

15. **`SELECT version()` is verbose, `SHOW server_version` is concise.** Use `version()` for compile-flag / OS-package context; use `server_version_num` for SQL-level version checks.

16. **Reading only the headline-features list and skipping the bug-fix section.** Minor releases (e.g., 18.3 vs 18.0) often fix correctness bugs that affect specific workloads. Skim the patch notes when you upgrade minors.

17. **Believing pre-release tarballs are stable.** "PG18-devel" or "PG18 beta" are not production. Wait for GA — September of release year for that major.

18. **Forgetting that the major release goes GA in October but support starts on that date.** PG18 GA was 2025-09-25. The 5-year clock started then, NOT when you installed.

19. **Treating "supported" as "secure."** A supported version receives patches, but you must actually apply the patches. A PG17 cluster running 17.0 from 2024-09 is missing 17.9's accumulated fixes. See Recipe 10.

20. **Cherry-picking features without checking the GUC defaults.** PG18 turns on data checksums by default at `initdb` time. PG18 turns on AIO with `io_method=worker` by default. Defaults that change between majors are silent behavior shifts. See [88-corruption-recovery.md](./88-corruption-recovery.md) and [32-buffer-manager.md](./32-buffer-manager.md).

21. **Confusing `pg_upgrade` major-version-only behavior.** `pg_upgrade` jumps any-major-to-any-newer-major in one run. You don't need PG14→15→16→17→18 chain — PG14→18 in one run works. See [86-pg-upgrade.md](./86-pg-upgrade.md).

22. **Assuming a feature shipped in major N is in minor (N-1).x.** Features land in majors only. A bug fix may backport to older majors via minor releases; a new feature never does.

23. **Counting on EOL extensions.** A PG13 EOL'd 2025-11-13 means the core engine. But upstream PG extensions (pgvector, PostGIS, etc.) may EOL their PG13 builds at different times — sometimes earlier. Re-audit per-extension.

## See Also

- [86-pg-upgrade.md](./86-pg-upgrade.md) — `pg_upgrade` mechanics for in-place major upgrade
- [87-major-version-upgrade.md](./87-major-version-upgrade.md) — Strategy comparison (pg_upgrade vs logical replication vs dump/restore)
- [90-disaster-recovery.md](./90-disaster-recovery.md) — DR including EOL-version risk
- [91-docker-postgres.md](./91-docker-postgres.md) — Per-version `initdb` changes (PG16 `-c GUC=value`; PG18 checksums default-on) affect container workflows
- [92-kubernetes-operators.md](./92-kubernetes-operators.md) — Per-version operator-relevant PG items (slot failover PG17; checksums PG18; `pg_basebackup --incremental` PG17)
- [93-pg-trgm.md](./93-pg-trgm.md) — PG18 collation-provider change requires REINDEX of trigram indexes
- [94-pgvector.md](./94-pgvector.md) — pgvector evolves on its own cadence; PG14-18 release notes contain zero pgvector items
- [95-postgis.md](./95-postgis.md) — PostGIS evolves on its own cadence; PG14-18 release notes contain zero PostGIS items
- [96-timescaledb.md](./96-timescaledb.md) — TimescaleDB evolves on its own cadence; PG14-18 release notes contain zero TimescaleDB items
- [97-citus.md](./97-citus.md) — Citus evolves on its own cadence; PG14-18 release notes contain zero Citus items
- [98-pg-cron.md](./98-pg-cron.md) — pg_cron evolves on its own cadence; PG14-18 release notes contain zero pg_cron items
- [99-pg-partman.md](./99-pg-partman.md) — pg_partman requires PG14+; evolves on its own cadence; PG14-18 release notes contain zero pg_partman items
- [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md) — Provider lag for new majors
- [102-skill-cookbook.md](./102-skill-cookbook.md) — Recipe 6 Major Version Upgrade Playbook; version strategy decision tree
- [53-server-configuration.md](./53-server-configuration.md) — GUC defaults that shifted across majors
- [54-memory-tuning.md](./54-memory-tuning.md) — Memory-GUC defaults that shifted (PG14 / PG15 / PG17 / PG18)
- [69-extensions.md](./69-extensions.md) — Extension version pinning across upgrades
- [82-monitoring.md](./82-monitoring.md) — Monitoring views that changed (PG16 `pg_stat_io`; PG17 `pg_stat_checkpointer` split; PG18 `pg_stat_io` extension)
- [46-roles-privileges.md](./46-roles-privileges.md) — Predefined roles added per major (PG14 `pg_read_all_data`; PG15 CREATEROLE narrowed; PG17 `pg_maintain`)
- [88-corruption-recovery.md](./88-corruption-recovery.md) — PG18 data-checksums-by-default impact
- [73-streaming-replication.md](./73-streaming-replication.md) and [74-logical-replication.md](./74-logical-replication.md) — replication-feature timelines

## Sources

[^1]: PostgreSQL Global Development Group, "Versioning Policy." https://www.postgresql.org/support/versioning/ (verified 2026-05-14). Source of: 5-year support quote, annual-release-cadence quote, PG10+ single-integer-major-versioning quote, and the canonical EOL table for PG10 through PG18.

[^2]: PostgreSQL 14 Release Notes. https://www.postgresql.org/docs/14/release-14.html (verified 2026-05-14). Headline features: OUT parameters in procedures; CTE SEARCH/CYCLE clauses; generalized subscripting; multirange types; B-tree bottom-up index deletion.

[^3]: PostgreSQL 15 Release Notes. https://www.postgresql.org/docs/15/release-15.html (verified 2026-05-14). Headline features: MERGE; row-filter and column-list publications; zstd compression; structured JSON server-log output; sort performance improvements; UNIQUE NULLS NOT DISTINCT; security_invoker views; PUBLIC schema CREATE revoked.

[^4]: PostgreSQL 16 Release Notes. https://www.postgresql.org/docs/16/release-16.html (verified 2026-05-14). Headline features: parallel FULL / right-OUTER hash joins; logical replication from standby + parallel apply; pg_stat_io; SQL/JSON constructors; opportunistic page freezing during vacuum; pg_hba.conf regex + include directives; CREATEROLE narrowing.

[^5]: PostgreSQL 17 Release Notes. https://www.postgresql.org/docs/17/release-17.html (verified 2026-05-14). Headline features: VACUUM memory-management rewrite (1GB cap removed); JSON_TABLE + SQL/JSON completion; streaming I/O for sequential reads; multi-value B-tree index search; pg_createsubscriber; logical slots preserved through pg_upgrade; logical-slot failover; sslnegotiation=direct; pg_basebackup --incremental + pg_combinebackup; COPY ON_ERROR ignore; MAINTAIN privilege + pg_maintain role; pg_stat_checkpointer view; transaction_timeout GUC; old_snapshot_threshold removed.

[^6]: PostgreSQL 18 Release Notes. https://www.postgresql.org/docs/18/release-18.html (verified 2026-05-14). Headline features: asynchronous I/O subsystem + io_method GUC + pg_aios view; pg_upgrade preserves optimizer statistics; B-tree skip scan; uuidv7() in core; virtual generated columns as default; OAuth 2.0 authentication; RETURNING OLD ... NEW ... clause; temporal constraints (WITHOUT OVERLAPS); PG_UNICODE_FAST + casefold(); parallel GIN index builds; data checksums on by default at initdb; idle_replication_slot_timeout; pg_stat_io extended; pg_stat_checkpointer.num_done; AFTER triggers fire as queue-time role; promote_trigger_file removed.

[^7]: "PostgreSQL 18 Released" announcement. https://www.postgresql.org/about/news/postgresql-18-released-3142/ (verified 2026-05-14). Source of release-summary quotes including AIO subsystem and uuidv7() callouts.

[^8]: PostgreSQL Release Notes index. https://www.postgresql.org/docs/release/ (verified 2026-05-14). Source of most-recent-minor-release confirmation (2026-02-26 delivered 18.3 / 17.9 / 16.13 / 15.17 / 14.22).

[^9]: PostgreSQL Security Information. https://www.postgresql.org/support/security/ (verified 2026-05-14). Source of CVE feed and pgsql-announce subscription pointer.

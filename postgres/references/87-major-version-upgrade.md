# Major-Version Upgrade Strategies

How to choose between `pg_dump`/restore, `pg_upgrade`, logical replication blue/green, and `pg_createsubscriber` (PG17+) for major-version upgrades. Covers downtime trade-offs, version compatibility, client driver/ABI considerations, extension version pinning.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Strategies](#strategies)
    - [Strategy A — pg_dump + pg_restore](#strategy-a--pg_dump--pg_restore)
    - [Strategy B — pg_upgrade In-Place](#strategy-b--pg_upgrade-in-place)
    - [Strategy C — Logical Replication Blue/Green](#strategy-c--logical-replication-bluegreen)
    - [Strategy D — pg_createsubscriber (PG17+)](#strategy-d--pg_createsubscriber-pg17)
- [Version Compatibility](#version-compatibility)
    - [Support Lifecycle](#support-lifecycle)
    - [Cross-Version Tooling](#cross-version-tooling)
    - [Client Driver and ABI Compatibility](#client-driver-and-abi-compatibility)
    - [Wire Protocol Versioning](#wire-protocol-versioning)
- [Extension Version Pinning](#extension-version-pinning)
- [Per-Version Upgrade Timeline](#per-version-upgrade-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick this file when:

- Choosing upgrade method for production cluster (downtime budget vs operational complexity).
- Planning blue/green cutover via logical replication.
- Evaluating `pg_createsubscriber` (PG17+) for converting physical standby into logical-replication subscriber for upgrade.
- Auditing extension compatibility before upgrade (binary compatibility, version pinning).
- Planning client-driver / libpq update across upgrade.
- Reasoning about how PG14 → PG18 jumps differ from single-major hops.

Pick different file when:

- Deep dive on `pg_upgrade` mechanics (transfer modes, prerequisites, OID preservation) → [`86-pg-upgrade.md`](./86-pg-upgrade.md).
- Logical backup details (`pg_dump` flags, `pg_restore` parallelism) → [`83-backup-pg-dump.md`](./83-backup-pg-dump.md).
- Logical replication mechanics (CREATE PUBLICATION/SUBSCRIPTION, conflict handling) → [`74-logical-replication.md`](./74-logical-replication.md).
- Standby promotion / failover mechanics → [`77-standby-failover.md`](./77-standby-failover.md).
- Extension catalog (which extensions widely used) → [`69-extensions.md`](./69-extensions.md).

## Mental Model

Five rules.

**Rule 1 — Pick strategy by downtime budget, not by familiarity.** Four strategies span downtime spectrum:

- **`pg_dump` + restore**: hours to days (proportional to data size). Simplest, most portable.
- **`pg_upgrade --copy`**: minutes to ~1 hour for moderate clusters. Doubles disk during copy.
- **`pg_upgrade --link`/`--clone`/`--swap`**: seconds to minutes regardless of size. Old cluster cannot be restarted (link/swap modes).
- **Logical replication blue/green** (manual or via `pg_createsubscriber` PG17+): seconds of cutover (just connection-string flip). Hours-to-days of catch-up replication runtime.

**Rule 2 — Cross-version constraints differ per strategy.** `pg_dump` works across any pair where target ≥ source (newer `pg_dump` reads older server). `pg_upgrade` works any source ≥ PG9.2 (since PG15) → any newer or equal target. Logical replication works between adjacent or skipping majors as long as both sides support `wal_level = logical`. Same-architecture rule applies to `pg_upgrade` only — others are byte-format-independent.

**Rule 3 — Extensions are the single biggest upgrade hazard.** Every C extension needs a build for the new PG major (different ABI). Verify extension availability on target cluster BEFORE upgrade. `pg_upgrade --check` flags missing extensions. Logical replication doesn't replicate DDL — schema (including extensions) must be re-created on target manually before catching up data.

**Rule 4 — Client drivers and applications usually upgrade transparently — but not always.** libpq is forward-and-backward compatible across PG14-18 (and well beyond). Most language drivers (psycopg2/3, JDBC, pg-promise, asyncpg) follow the same pattern. Edge cases: SCRAM-SHA-256 requirement when upgrading from MD5-only-installations; channel binding default flips; deprecated wire-protocol-v2 removed in PG14[^pg14-protov2]. Test against new server before cutover.

**Rule 5 — Test the upgrade procedure end-to-end on a disposable replica before doing it for real.** `pg_upgrade --check` is necessary but not sufficient — exercises only catalog-compatibility checks, not application behavior or extension functionality. Standard pre-production drill: take a recent backup, restore to disposable host running new version, run application test suite + smoke tests, time the upgrade window. Repeat until reproducible.

> [!WARNING] PG13 already EOL (Nov 2025); PG14 EOL Nov 2026
> The PostgreSQL Global Development Group supports each major for 5 years from initial release. As of 2026-05-14:
>
> - **PG13: EOL November 13, 2025** — already past end-of-life. No further security/bug fixes from upstream. Anything still on PG13 should be on a written upgrade plan TODAY.
> - **PG14: EOL November 12, 2026** — ~6 months remain. Plan upgrade NOW.
> - **PG15: EOL November 11, 2027.**
> - **PG16: EOL November 9, 2028.**
> - **PG17: EOL November 8, 2029.**
> - **PG18: EOL November 14, 2030.**[^lifecycle]

> [!WARNING] PG18 changes that block in-place upgrades from older clusters
> PG18 introduced two breaking changes that surface as `pg_upgrade --check` failures:
>
> 1. **PK/FK collation determinism rule.** Verbatim PG18 release-note: *"Require primary/foreign key relationships to use either deterministic collations or the same nondeterministic collations (Peter Eisentraut). [...] The restore of a pg_dump, also used by pg_upgrade, will fail if these requirements are not met."*[^pg18-collation] Audit `pg_collation` + `pg_constraint` for PK/FK columns using mixed-determinism collations BEFORE upgrade.
> 2. **Char signedness.** Verbatim: *"Add option `--set-char-signedness` to pg_upgrade ... allows clusters created on a CPU architecture with a different char signedness to be upgraded."*[^pg18-charsign] Most x86_64 platforms use signed char (Linux); some (ARM Linux, Power) historically used unsigned. Cross-arch carry-forward needs the flag.

## Decision Matrix

13 rows mapping operational scenario → strategy.

| Scenario | Strategy | Downtime | Notes |
|---|---|---|---|
| Small cluster (<100 GB), simple schema, downtime OK | `pg_dump -Fd \| pg_restore -j N` | 30 min – 4 h | Most portable; cross-architecture safe; PG version flexible. |
| Medium cluster (100 GB – 1 TB), 30 min downtime budget | `pg_upgrade --link` or `--clone` | 5–30 min | See [`86-pg-upgrade.md`](./86-pg-upgrade.md). |
| Large cluster (TB+), <5 min downtime | logical replication blue/green | 1–5 min cutover | Hours/days of pre-cutover catchup. Manual conflict handling. |
| Large cluster (TB+), <1 min downtime, source ≥ PG17 physical standby | `pg_createsubscriber` (PG17+) | <1 min cutover | Converts physical standby → logical subscriber. |
| Cross-architecture (x86_64 → arm64) | `pg_dump`/restore OR logical replication | proportional to data | `pg_upgrade` doesn't work cross-arch. |
| Cross-platform (Linux → Windows) | `pg_dump`/restore | proportional to data | Same constraint. |
| Cross-encoding (e.g., LATIN1 → UTF8) | `pg_dump`/restore | proportional to data | `pg_upgrade` keeps source encoding (PG15 partial relaxation). |
| Skip multiple majors (PG13 → PG18) | Any except logical replication | proportional | `pg_upgrade` supports any source PG9.2+ since PG15. Test extension compat. |
| Source already EOL (PG13 today) | upgrade fast, any strategy | depends | Don't run unsupported versions in production. |
| Tight maintenance-window calendar | `pg_upgrade --link` + `--swap` (PG18+) | seconds | Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md). |
| Application requires near-zero downtime | logical replication blue/green | seconds (cutover only) | Plan rollback path. |
| Need to test new version while keeping old in production | logical replication, source unchanged | n/a | Old cluster keeps serving until cutover. |
| Cluster has logical replication subscribers | source must be PG17+ for slot migration | n/a | Otherwise route to manual blue/green. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md). |

Three smell signals — wrong strategy:

- **Hours-of-downtime budget assumed for `pg_dump` of 5TB cluster.** Switch to `pg_upgrade --link` or logical replication.
- **Logical replication chosen for 50GB cluster with 8-hour maintenance window.** Overkill — `pg_upgrade --copy` wins on simplicity.
- **`pg_upgrade` chosen between machines.** Doesn't work — `pg_upgrade` requires same machine. Use `pg_dump`+restore or set up streaming replication first then upgrade in place.

## Strategies

### Strategy A — pg_dump + pg_restore

The most portable, most flexible, and slowest method. Logical extraction + replay.

**When to use:**

- Small clusters (`pg_dump` time + `pg_restore` time fits the downtime window).
- Cross-architecture or cross-platform migration (Linux ↔ Windows, x86_64 ↔ arm64).
- Cross-encoding migration (LATIN1 → UTF8).
- Migrating between cloud providers or moving on-premises ↔ cloud.
- Selective migration (only certain tables/schemas).

**Procedure (canonical):**

    # On source cluster (current version):
    pg_dumpall --globals-only > globals.sql
    pg_dump -Fd -j 4 -d production -f /backup/production-dump

    # Verify dump:
    pg_restore --list /backup/production-dump | head -20

    # On target cluster (new version, fresh initdb):
    psql -f globals.sql postgres
    createdb -O appowner production
    pg_restore -d production -j 8 --section=pre-data /backup/production-dump
    pg_restore -d production -j 8 --section=data /backup/production-dump
    pg_restore -d production -j 8 --section=post-data /backup/production-dump

    # Run vacuumdb after restore:
    vacuumdb --all --analyze-in-stages --jobs=8

**Trade-offs:**

- Pros: simplest, most portable, transparent. Cross-version (newer `pg_dump` reads older server), cross-architecture, cross-encoding, cross-collation.
- Cons: proportional to data size. Holds snapshot on source for the dump duration (delays VACUUM / wraparound progression). Cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md).

Cross-reference [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) for full `pg_dump` mechanics including parallel directory format, section split (`pre-data`/`data`/`post-data`), and selective dump.

### Strategy B — pg_upgrade In-Place

Reuses data files via OID + relfilenode preservation. Fast (TB-scale in seconds with `--link`) but operationally exacting.

**When to use:**

- Same-machine, same-architecture upgrade.
- Downtime budget ≥ minutes (varies by mode + cluster size).
- Want to keep operational state (tablespaces, table sizes, OIDs) intact.

**Procedure (canonical, abbreviated — see [`86-pg-upgrade.md`](./86-pg-upgrade.md) for full):**

    # 1. Install new PostgreSQL (e.g., PG18) alongside old.
    # 2. initdb new cluster with same locale/encoding (PG16+ relaxes this[^pg16-locale]).
    # 3. Stop both clusters cleanly.
    # 4. Pre-flight check (read-only, can run against running source):
    /usr/lib/postgresql/18/bin/pg_upgrade \
        --old-datadir=/var/lib/postgresql/16/main \
        --new-datadir=/var/lib/postgresql/18/main \
        --old-bindir=/usr/lib/postgresql/16/bin \
        --new-bindir=/usr/lib/postgresql/18/bin \
        --check
    # 5. Stop old, run upgrade:
    pg_ctlcluster 16 main stop
    pg_ctlcluster 18 main stop
    /usr/lib/postgresql/18/bin/pg_upgrade --link --jobs=4 \
        --old-datadir=... --new-datadir=...
    # 6. Start new cluster, run vacuumdb (ANALYZE):
    pg_ctlcluster 18 main start
    vacuumdb --all --analyze-in-stages --jobs=$(nproc)

**Trade-offs:**

- Pros: dramatically faster than dump/restore. Preserves OIDs (PG15+), planner stats (PG18+), logical replication slots (PG17+ source).
- Cons: same-architecture only. `--link` mode makes old cluster unrecoverable. Doesn't migrate `postgresql.conf`, `pg_hba.conf`, `archive_command`, scheduled jobs.

Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md) for transfer modes, prerequisites, security notes.

### Strategy C — Logical Replication Blue/Green

Run new-version cluster in parallel as logical replication subscriber. Cutover = seconds (connection-string flip). Pre-cutover = hours/days of replication lag.

**When to use:**

- TB-scale clusters where dump/restore time is unacceptable.
- Sub-minute cutover requirement.
- Want to test new version under load before committing.
- Need to run old + new clusters in parallel for safety.

**Procedure (canonical 9-step):**

    # 1. Provision new cluster (e.g., PG18) with same hardware/storage class as source.
    # 2. Install ALL extensions on new cluster matching source (binary compat, version pinning):
    psql -h source -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
    # Then on target, for each: CREATE EXTENSION ... VERSION '...';

    # 3. Replicate schema (DDL — NOT replicated by logical replication):
    pg_dump -Fc --schema-only -h source production | pg_restore -d production -h target

    # 4. Adjust source for logical replication:
    # postgresql.conf: wal_level = logical, max_replication_slots = N, max_wal_senders = N
    # pg_hba.conf: allow target to connect with REPLICATION privilege
    pg_ctl reload

    # 5. CREATE PUBLICATION on source (FOR ALL TABLES is canonical):
    psql -h source -d production -c "CREATE PUBLICATION upgrade_pub FOR ALL TABLES;"

    # 6. CREATE SUBSCRIPTION on target:
    psql -h target -d production -c "
      CREATE SUBSCRIPTION upgrade_sub
        CONNECTION 'host=source port=5432 dbname=production user=replicator'
        PUBLICATION upgrade_pub
        WITH (copy_data = true, create_slot = true);
    "

    # 7. Wait for initial COPY to complete + steady-state catchup:
    psql -h target -d production -c "
      SELECT subname, srrelid::regclass, srsubstate, srsublsn
      FROM pg_subscription s JOIN pg_subscription_rel sr ON s.oid = sr.srsubid;
    "
    # srsubstate = 'r' (ready) means table is fully synced + streaming.

    # 8. Cutover (during downtime window):
    # 8a. Pause writes on source (application-side, e.g., set read-only mode).
    # 8b. Wait for pg_subscription_rel all 'r' AND pg_stat_subscription replay caught up:
    psql -h target -d production -c "
      SELECT pid, application_name, state, pg_wal_lsn_diff(latest_end_lsn, pg_last_wal_replay_lsn())
      FROM pg_stat_subscription;
    "
    # 8c. Sync sequences (logical replication doesn't replicate sequences):
    psql -h source -t -c "
      SELECT format('SELECT setval(%L, %s);', schemaname||'.'||sequencename, last_value)
      FROM pg_sequences;
    " | psql -h target -d production
    # 8d. Flip application connection strings to target.

    # 9. Cleanup:
    psql -h target -c "DROP SUBSCRIPTION upgrade_sub;"
    psql -h source -c "DROP PUBLICATION upgrade_pub;"

**Trade-offs:**

- Pros: minutes-of-cutover regardless of cluster size. Old cluster remains live until flip — easy rollback. Cross-architecture, cross-platform, cross-encoding all OK (logical replication is byte-format-independent).
- Cons: DDL not replicated (schema must be migrated manually). Sequences not replicated (manual sync at cutover). Conflicts on subscriber halt apply worker. Large objects not replicated. Operational complexity high.

Cross-reference [`74-logical-replication.md`](./74-logical-replication.md) for replication mechanics, conflict handling, REPLICA IDENTITY rules.

### Strategy D — pg_createsubscriber (PG17+)

PG17 introduced `pg_createsubscriber` — converts a running physical standby into a logical-replication subscriber in seconds. Verbatim PG17 release-note: *"Add application pg_createsubscriber to create a logical replica from a physical standby server (Euler Taveira)."*[^pg17-createsub]

**When to use:**

- Source cluster is PG17 or later AND has a physical standby.
- Need fastest possible blue/green cutover (<1 min, no data-copy phase).
- Want to leverage existing standby instead of bootstrapping a new subscriber from scratch.

**Procedure (canonical):**

    # Prerequisites:
    # - Source cluster (primary) PG17+
    # - Physical standby of that source already running, fully caught up
    # - Standby has been running with: wal_level = logical, max_replication_slots > 0
    # - Schema already in place (logical replication requires it)

    # 1. Stop the standby (offline, since the conversion is offline):
    pg_ctl -D /var/lib/postgresql/17/standby stop

    # 2. Run pg_createsubscriber:
    pg_createsubscriber \
        --pgdata=/var/lib/postgresql/17/standby \
        --publisher-server="host=primary port=5432 dbname=production user=replicator" \
        --subscriber-server="host=standby port=5432 dbname=production user=replicator" \
        --database=production \
        --verbose

    # 3. Start the converted subscriber:
    pg_ctl -D /var/lib/postgresql/17/standby start

    # 4. Verify subscription is active:
    psql -h standby -c "SELECT * FROM pg_stat_subscription;"

    # 5. Cutover: same as Strategy C step 8.

**PG18 enhancements:**

PG18 added significant `pg_createsubscriber` flags. Verbatim PG18 release-note: *"Add pg_createsubscriber options `--all`, `--clean`, `--enable-two-phase` (Shubham Khanna)."*[^pg18-createsub] Operational consequences:

- `--all` converts ALL databases (not just one).
- `--clean` removes pre-existing subscriptions on the standby before converting.
- `--enable-two-phase` enables two-phase commit decoding on the new subscription.

**Trade-offs:**

- Pros: fastest possible logical-replication subscriber bootstrap (no `COPY` phase — physical standby already has data). Source must be PG17+.
- Cons: PG17+ source only. Cannot be undone (the physical standby becomes a subscriber, no rollback path back to physical standby without re-bootstrapping).

> [!WARNING] pg_createsubscriber cannot be undone
> Once `pg_createsubscriber` runs, the standby is no longer a physical standby. If you abort the cutover, the converted subscriber must be either kept running as a logical subscriber (and a new physical standby provisioned) or destroyed and re-built. Always have a backup of the standby's `$PGDATA` before running `pg_createsubscriber`. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md) for slot inspection.

## Version Compatibility

### Support Lifecycle

PostgreSQL Global Development Group (PGDG) supports each major version for **5 years from initial release**[^lifecycle]. After EOL, no security fixes, no bug fixes from upstream. Distros and managed providers may extend support but not always.

| Version | Released | EOL date | Status (2026-05-14) |
|---|---|---|---|
| PG13 | September 24, 2020 | November 13, 2025 | **EOL — upgrade now** |
| PG14 | September 30, 2021 | November 12, 2026 | **6 months remaining** |
| PG15 | October 13, 2022 | November 11, 2027 | Supported |
| PG16 | September 14, 2023 | November 9, 2028 | Supported |
| PG17 | September 26, 2024 | November 8, 2029 | Supported |
| PG18 | September 25, 2025 | November 14, 2030 | Current |

**Operational consequences:**

- Plan upgrades on a 4-year cadence to stay within support window with margin for skipping a release.
- EOL versions in production = compliance risk (PCI-DSS, SOC2, HIPAA all require supported software stacks).
- Skipping multiple majors at once (e.g., PG13 → PG18) is supported but increases risk surface — test extensions, planner regressions, deprecated GUC removals carefully.

### Cross-Version Tooling

Three rules govern which tool can do what across versions.

**Rule 1 — Newer client tools can target older servers.** `pg_dump` / `pg_restore` / `psql` / `pg_basebackup` from version N can connect to any server back to PG9.2 (since PG15). Always use the **newer** tool when crossing versions. Verbatim PG15 release-note: *"Limit support of pg_upgrade to old servers running PostgreSQL 9.2 or later (Tom Lane)."*[^pg15-floor]

**Rule 2 — Older client tools talking to newer servers may break on new types/syntax.** Don't pin client tools to old PG version when server upgrades. Especially relevant for `pg_dump` — PG14 `pg_dump` doesn't know how to serialize PG18 features (virtual generated columns, temporal constraints, NOT ENFORCED, etc.).

**Rule 3 — `pg_upgrade` accepts any source ≥ PG9.2 → any newer-or-equal target.** Cross-major jumps work in one shot. PG13 → PG18 is supported.

### Client Driver and ABI Compatibility

**libpq is forward-and-backward compatible across PG14–18.** Applications using libpq (psycopg2/3, JDBC pg-driver-bundled, asyncpg, node-postgres) typically don't need driver updates for major-version upgrades.

Edge cases:

- **SCRAM-SHA-256 only**: if upgrading from a cluster where some roles still have MD5 password hashes, and you've set `password_encryption = scram-sha-256` on the target, those roles cannot authenticate until passwords are reset. Cross-reference [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md).
- **Channel binding**: PG14+ libpq supports `channel_binding=require` for SCRAM-with-tls-server-end-point. Older servers + newer clients with `channel_binding=require` will fail authentication.
- **Wire protocol v2 removed in PG14.** Verbatim release-note: *"Remove server and libpq support for the version 2 wire protocol (Heikki Linnakangas). It was last used as the default in PostgreSQL 7.3 (released in 2002)."*[^pg14-protov2] Affects only ancient client libraries.

**Test the application driver against the new server before cutover.** Run integration tests, smoke tests, and any custom protocol-handling code paths.

### Wire Protocol Versioning

PostgreSQL has used wire protocol version 3.0 since PG7.4 (2003). PG18 added protocol 3.2 (256-bit cancel keys + new feature negotiation). Verbatim PG18 release-note: *"Increase the size of the cancel-request key (Jelte Fennema-Nio, Heikki Linnakangas) [...] this is only possible when the server and client support wire protocol version 3.2, introduced in this release."*[^pg18-proto32]

Operational impact:

- Old client + new server: works (protocol negotiates down to 3.0).
- New client + old server: works (protocol negotiates down to 3.0).
- Cancel-key size: shorter (32-bit) when one side is < PG18.

Most applications never directly touch wire-protocol versioning. Driver maintainers handle it. Inspect via `PQfullProtocolVersion()` (PG18+) if needed.

## Extension Version Pinning

Extensions are the single biggest upgrade hazard. Three pre-flight checks mandatory before upgrade.

**Check 1 — Inventory installed extensions on source:**

    SELECT
      e.extname,
      e.extversion AS installed_version,
      n.nspname AS schema,
      e.extrelocatable
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    ORDER BY extname;

**Check 2 — Verify each extension has a binary build for the target PG major.** For widely-used extensions (pg_stat_statements, pgcrypto, pg_trgm, btree_gin, pgvector, PostGIS, pg_partman, pg_cron, pgaudit, postgres_fdw): packaged with PG itself or have official builds for every supported major. Less-common extensions (pg_repack, pg_squeeze, pglogical, third-party FDWs): verify before upgrade.

For the target host:

    SELECT name, default_version, installed_version, comment
    FROM pg_available_extensions
    ORDER BY name;

If a needed extension does not appear in `pg_available_extensions` on the target, the binary is not installed. Either install the package OR change strategy.

**Check 3 — Plan extension version updates.** New PG majors often require extension updates (especially for PostGIS, TimescaleDB, pgvector). Three patterns:

- **Lock-step**: extension version must match PG major exactly (e.g., PostGIS 3.x with PG14, PostGIS 3.4+ with PG16+). Upgrade extension AS PART OF the upgrade procedure.
- **Forward-compatible**: extension version on source still works on target. Run `ALTER EXTENSION foo UPDATE` on target after upgrade if newer version available.
- **Independent**: extension is forward and backward compatible across PG majors. No action needed.

For `pg_upgrade`: run `--check` AFTER installing all extension binaries on the target — it explicitly checks for missing extensions.

For logical replication blue/green: install extensions on target manually before creating subscription. Schema migration (Strategy C step 3) creates extension dependencies if they exist on source.

> [!WARNING] PostGIS upgrade dance
> PostGIS upgrades are notorious. Recommended sequence: (1) on target, install `postgis` package matching PG major; (2) `CREATE EXTENSION postgis VERSION 'X.Y.Z'` matching source's version; (3) data restore / replication; (4) AFTER restore complete, `SELECT postgis_extensions_upgrade();` to upgrade in place. Cross-reference [`95-postgis.md`](./95-postgis.md).

> [!WARNING] TimescaleDB upgrade dance
> TimescaleDB requires its tooling-specific upgrade sequence. The `timescaledb-tune` script + `tsdb` extension version must align with PG major. Cross-reference [`96-timescaledb.md`](./96-timescaledb.md).

## Per-Version Upgrade Timeline

What changed in each major regarding upgrade tooling.

| Version | Upgrade-relevant changes |
|---|---|
| **PG14** | `analyze_new_cluster` script removed (use `vacuumdb` instead) (Magnus Hagander)[^pg14-analyze]. Wire protocol v2 dropped (Heikki Linnakangas)[^pg14-protov2]. |
| **PG15** | `pg_upgrade` source floor: PG9.2+ (Tom Lane)[^pg15-floor]. OID + relfilenode preservation (Shruthi Gowda, Antonin Houska)[^pg15-oid]. `pg_upgrade_output.d` log subdir (Justin Pryzby)[^pg15-output]. `--no-sync` flag added. |
| **PG16** | `pg_upgrade` accepts different locale/encoding on target (Jeff Davis)[^pg16-locale]. Explicit `--copy` flag (Peter Eisentraut)[^pg16-copyflag]. |
| **PG17** | `pg_createsubscriber` introduced (Euler Taveira)[^pg17-createsub]. `pg_upgrade` migrates valid logical slots and subscriptions when source ≥ PG17 (Hayato Kuroda et al.)[^pg17-slots]. `--copy-file-range` flag for `pg_upgrade` (Thomas Munro)[^pg17-cfr]. `--sync-method` added across `initdb`/`pg_basebackup`/`pg_checksums`/`pg_dump`/`pg_rewind`/`pg_upgrade` (Justin Pryzby, Nathan Bossart)[^pg17-sync]. |
| **PG18** | Statistics preservation (Corey Huinker, Jeff Davis, Nathan Bossart)[^pg18-stats]. `--swap` mode (Nathan Bossart)[^pg18-swap]. Parallel database checks via `--jobs` (Nathan Bossart)[^pg18-jobs]. `--set-char-signedness` (Masahiko Sawada)[^pg18-charsign]. `--no-data-checksums` (initdb defaults to checksums, helps upgrade non-checksum old clusters) (Greg Sabino Mullane)[^pg18-checksums]. PK/FK collation determinism rule[^pg18-collation]. `pg_createsubscriber` flags `--all`, `--clean`, `--enable-two-phase` (Shubham Khanna)[^pg18-createsub]. Wire protocol 3.2 + 256-bit cancel keys (Jelte Fennema-Nio, Heikki Linnakangas)[^pg18-proto32]. |

## Examples / Recipes

### Recipe 1 — Choose Strategy via Decision Tree

Quick decision tree:

    Is source PG13 or later AND target PG14 or later?
    ├── No → use pg_dump+restore (Strategy A) only.
    └── Yes:
        ├── Cluster < 50 GB AND downtime budget > 1 h?
        │   └── Strategy A (pg_dump+restore) — simplest.
        ├── Cluster 50 GB – 5 TB AND downtime budget 5–60 min?
        │   ├── Same architecture → Strategy B (pg_upgrade --link/--clone).
        │   └── Cross-arch → Strategy A.
        ├── Cluster > 5 TB AND downtime budget < 5 min?
        │   ├── Source ≥ PG17 with physical standby → Strategy D (pg_createsubscriber).
        │   └── Otherwise → Strategy C (logical replication blue/green).
        └── Need to test new version under load before committing?
            └── Strategy C or D.

### Recipe 2 — Pre-Upgrade Audit Script

Run before any upgrade strategy:

    -- Extensions installed
    SELECT extname, extversion, extrelocatable, extnamespace::regnamespace
    FROM pg_extension ORDER BY extname;

    -- Tables without primary keys (REPLICA IDENTITY hazard for logical replication)
    SELECT n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = c.oid AND contype = 'p'
      )
    ORDER BY n.nspname, c.relname;

    -- Logical replication slots (blocker if pre-PG17 source)
    SELECT slot_name, plugin, slot_type, database, active, restart_lsn, confirmed_flush_lsn
    FROM pg_replication_slots;

    -- Active prepared transactions (blocker for pg_upgrade)
    SELECT * FROM pg_prepared_xacts;

    -- Tables using user-defined types (potential problem during dump/restore)
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
           t.typname AS type
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_type t ON a.atttypid = t.oid
    WHERE a.attnum > 0 AND NOT a.attisdropped
      AND t.typtype = 'd'  -- domains
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schema, table;

    -- Sequences (must be re-synced after logical replication cutover)
    SELECT schemaname, sequencename, last_value
    FROM pg_sequences
    ORDER BY schemaname, sequencename;

### Recipe 3 — Logical Replication Blue/Green Step-by-Step

Full canonical procedure (Strategy C expanded):

    # 1. Provision target cluster (PG18) on new hardware.
    initdb -D /var/lib/postgresql/18/main --locale=C.UTF-8 --encoding=UTF8 --data-checksums
    # Set: wal_level = logical, max_replication_slots = 50, max_wal_senders = 50, max_logical_replication_workers = 16

    # 2. Install extensions matching source:
    psql -h source -At -c "
      SELECT format('CREATE EXTENSION IF NOT EXISTS %I VERSION %L;', extname, extversion)
      FROM pg_extension
      WHERE extname NOT IN ('plpgsql');
    " | psql -h target -d production

    # 3. Migrate schema only (NO data):
    pg_dump -Fc --schema-only -h source production | pg_restore -h target -d production
    # Verify: psql -h target -c "\dt" shows all expected tables.

    # 4. Verify all tables have REPLICA IDENTITY (PK or USING INDEX):
    psql -h source -d production -c "
      SELECT n.nspname, c.relname, c.relreplident
      FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relreplident = 'd'  -- DEFAULT requires PK
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c.oid AND contype = 'p');
    "
    # Any rows = tables that will silently lose UPDATE/DELETE replication. Fix before continuing.

    # 5. On source: create replication user + grant + adjust pg_hba:
    psql -h source -c "
      CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'strong_password';
      GRANT USAGE ON SCHEMA public TO replicator;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO replicator;
    "
    # Add to pg_hba.conf: hostssl production replicator <target-ip>/32 scram-sha-256
    pg_ctl reload

    # 6. CREATE PUBLICATION on source:
    psql -h source -d production -c "CREATE PUBLICATION upgrade_pub FOR ALL TABLES;"

    # 7. CREATE SUBSCRIPTION on target:
    psql -h target -d production -c "
      CREATE SUBSCRIPTION upgrade_sub
        CONNECTION 'host=source port=5432 dbname=production user=replicator sslmode=require'
        PUBLICATION upgrade_pub
        WITH (copy_data = true, create_slot = true, slot_name = 'upgrade_sub_slot');
    "

    # 8. Monitor catchup (loop until all tables 'r' state):
    psql -h target -c "
      SELECT srsubstate, count(*) FROM pg_subscription_rel GROUP BY srsubstate;
    "
    # 'd' = data being copied, 'f' = finished initial copy, 's' = synced, 'r' = ready (streaming).

    # 9. Cutover (downtime starts):
    # 9a. Application: enter read-only mode (e.g., set RDS read-replica or feature flag).
    # 9b. Wait for source flush (no more writes coming):
    psql -h source -c "SELECT pg_current_wal_lsn();"
    # 9c. Wait for target replay to catch up to that LSN:
    psql -h target -c "SELECT pid, latest_end_lsn, pg_current_wal_lsn() FROM pg_stat_subscription;"
    # When latest_end_lsn matches the source LSN from 9b, you're caught up.

    # 9d. Sync sequences (SQL emits SELECT setval()... statements):
    psql -h source -d production -At -c "
      SELECT format('SELECT setval(%L, %s, true);',
                    schemaname||'.'||sequencename, last_value)
      FROM pg_sequences;
    " | psql -h target -d production

    # 9e. Re-verify all tables in 'r' state (Step 8) one last time.

    # 9f. Flip application connection strings to target.
    # Test critical paths immediately.

    # 10. Cleanup (after grace period to confirm new cluster is stable):
    psql -h target -c "DROP SUBSCRIPTION upgrade_sub;"
    psql -h source -c "DROP PUBLICATION upgrade_pub;"
    # Decommission old cluster after backup retained.

### Recipe 4 — pg_createsubscriber for PG17+ Source

Fastest blue/green cutover for source ≥ PG17 with existing physical standby:

    # Prerequisites verified on source primary:
    # - PG17+
    # - At least one physical standby running, fully caught up
    # - Standby has wal_level = logical
    # - Schema already in place on standby (it's a physical replica)

    # Verify standby state:
    psql -h standby -At -c "SELECT pg_is_in_recovery();"  # expect 't'

    # Stop the standby for the conversion (offline operation):
    pg_ctlcluster 17 standby stop

    # Run pg_createsubscriber:
    pg_createsubscriber \
        --pgdata=/var/lib/postgresql/17/standby \
        --publisher-server="host=primary port=5432 dbname=production user=replicator" \
        --subscriber-server="host=standby port=5432 dbname=production user=replicator" \
        --database=production \
        --verbose

    # Start the new logical-replication subscriber:
    pg_ctlcluster 17 standby start

    # Verify subscription is streaming:
    psql -h standby -c "SELECT subname, subenabled, subconninfo FROM pg_subscription;"
    psql -h standby -c "SELECT * FROM pg_stat_subscription;"

    # Cutover: same as Recipe 3 step 9.

PG18 enhancement — convert all databases at once with `--all`:

    # PG18+:
    pg_createsubscriber --all --pgdata=... --publisher-server=... --subscriber-server=...

### Recipe 5 — Test Upgrade on Disposable Replica

Standard pre-production drill:

    # 1. Take a recent base backup of production:
    pg_basebackup -h prod -D /tmp/test-restore -X stream -P

    # 2. Spin up disposable host with new PG version installed.
    # 3. Restore + start as new-version cluster:
    /usr/lib/postgresql/18/bin/initdb -D /tmp/upgrade-target
    /usr/lib/postgresql/18/bin/pg_upgrade --check \
        --old-datadir=/tmp/test-restore \
        --new-datadir=/tmp/upgrade-target \
        --old-bindir=/usr/lib/postgresql/16/bin \
        --new-bindir=/usr/lib/postgresql/18/bin

    # If --check passes, run actual upgrade:
    /usr/lib/postgresql/18/bin/pg_upgrade --link --jobs=4 \
        --old-datadir=/tmp/test-restore \
        --new-datadir=/tmp/upgrade-target \
        --old-bindir=/usr/lib/postgresql/16/bin \
        --new-bindir=/usr/lib/postgresql/18/bin

    # 4. Run application test suite against the upgraded cluster.
    # 5. Time the upgrade duration. Plan production window with 2x buffer.
    # 6. Discard test cluster.
    # 7. Repeat until upgrade procedure is reproducible end-to-end.

### Recipe 6 — Rollback Plan for Each Strategy

| Strategy | Rollback method |
|---|---|
| A (`pg_dump`+restore) | Old cluster untouched. Just point applications back. |
| B (`pg_upgrade --copy`) | Old cluster intact in `--old-datadir`. Stop new, start old. |
| B (`pg_upgrade --link`/`--clone`/`--swap`) | **No rollback** — old data files modified or moved. Restore from base backup. |
| C (logical replication) | Old cluster still serving until cutover. After cutover: re-flip connection strings, drop subscription on old (if reverse-direction was set up). |
| D (pg_createsubscriber) | **No rollback for the standby conversion** — physical standby gone. But source primary still serving. Re-flip applications back to source primary. |

**Always have a base backup before any upgrade strategy.** Cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).

### Recipe 7 — Audit Extension Compatibility Across Versions

Pre-flight: which extensions installed on source, are they available on target?

    -- On source:
    \copy (SELECT extname, extversion FROM pg_extension ORDER BY extname) TO '/tmp/source_extensions.csv' CSV HEADER

    -- On target:
    \copy (SELECT name, default_version FROM pg_available_extensions ORDER BY name) TO '/tmp/target_available.csv' CSV HEADER

    # Diff the two:
    join -t, -1 1 -2 1 \
      <(sort -t, -k1,1 /tmp/source_extensions.csv) \
      <(sort -t, -k1,1 /tmp/target_available.csv) > /tmp/joined.csv
    # Anything in source NOT in joined.csv = missing extension on target.

### Recipe 8 — Force ANALYZE on Target Cluster

Required after `pg_upgrade` (pre-PG18) and `pg_dump`+restore. Recommended for safety after PG18+ pg_upgrade for extended statistics:

    # Pre-PG18 target:
    vacuumdb --all --analyze-in-stages --jobs=$(nproc)

    # PG18+ target (faster: only fill missing stats):
    vacuumdb --all --analyze-in-stages --missing-stats-only --jobs=$(nproc)

The `--analyze-in-stages` mode runs three passes with progressively higher statistics targets (1, 10, default), making the cluster usable for queries quickly while improving stats over the next minutes.

## Gotchas / Anti-patterns

23 gotchas. Roughly ordered most-leveraged first.

1. **`pg_dump`+restore time is proportional to data size — including indexes.** A 1 TB cluster with heavy indexing can take 6–12 hours to restore. Don't budget based on data-export time alone.
2. **Logical replication does NOT replicate DDL.** Schema must be migrated manually. Forgetting this = subscription fails on first DDL change.
3. **Logical replication does NOT replicate sequences.** Manual sync at cutover required (Recipe 3 step 9d).
4. **Logical replication does NOT replicate large objects.** If application uses `lo_*` API, blue/green won't migrate them. Cross-reference [`71-large-objects.md`](./71-large-objects.md).
5. **Logical replication apply worker BLOCKS on conflict.** PK violation, FK violation, missing row for UPDATE — apply worker stops. Cross-reference [`74-logical-replication.md`](./74-logical-replication.md).
6. **`pg_upgrade --link` mode makes old cluster unrecoverable** once new cluster starts. Always have a backup. Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md) gotcha #2.
7. **Extension binaries must be installed on target BEFORE upgrade.** Otherwise `pg_upgrade --check` fails. For logical replication: subscription creation fails if a referenced extension type is missing.
8. **PG13 is already EOL** (Nov 2025). Running PG13 in production is unsupported.
9. **PG14 EOL Nov 2026** — only ~6 months remain (as of 2026-05-14). Plan now.
10. **`pg_createsubscriber` cannot be undone.** Take a base backup of the standby first. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).
11. **`pg_upgrade` requires same machine, same architecture.** Doesn't work for x86_64 → arm64 or Linux → Windows.
12. **PG18 PK/FK collation rule breaks upgrades** when columns use mixed-determinism collations[^pg18-collation]. Audit before upgrade.
13. **`pg_upgrade` doesn't migrate `pg_hba.conf`, `postgresql.conf`, `archive_command`, scheduled jobs.** Re-create on target.
14. **Logical replication source cluster must have `wal_level = logical`** — requires restart. Plan a separate maintenance window for this if not already set.
15. **REPLICA IDENTITY DEFAULT + table without primary key = silent UPDATE/DELETE drop** for logical replication. Audit before upgrade. Cross-reference [`74-logical-replication.md`](./74-logical-replication.md) gotcha #4.
16. **Newer `pg_dump` connecting to older server is OK; older `pg_dump` connecting to newer server is NOT.** Always use the newer client tool when crossing versions.
17. **Cross-encoding migration must use `pg_dump`+restore.** `pg_upgrade` mostly preserves source encoding (PG16+ relaxed locale but encoding still strict).
18. **Cross-collation migration is risky.** PG18 PK/FK collation rule applies. ICU + libc differences can change sort order silently.
19. **`pg_upgrade --check` doesn't catch all issues.** Run actual upgrade on disposable replica before production.
20. **PG18 default initdb checksums** mean upgrading from a non-checksum cluster requires `--no-data-checksums` flag on new cluster init[^pg18-checksums].
21. **Wire protocol v2 removed in PG14**[^pg14-protov2]. Affects only clients using the pre-PG7.4 protocol; any driver built in the last two decades uses v3.
22. **PostGIS, TimescaleDB, pgvector require their own upgrade dance.** Read each extension's upgrade docs.
23. **Skipping multiple majors (PG13 → PG18) = bigger surface for plan regressions.** Test critical queries with EXPLAIN against a copy of production before cutover. Cross-reference [`56-explain.md`](./56-explain.md).

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — pg_dump holds snapshot, blocks VACUUM
- [`46-roles-privileges.md`](./46-roles-privileges.md) — REPLICATION role attribute
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — pg_hba.conf for replication user; SCRAM-SHA-256 migration
- [`49-tls-ssl.md`](./49-tls-ssl.md) — channel binding, sslmode for replication connections
- [`53-server-configuration.md`](./53-server-configuration.md) — postgresql.conf, ALTER SYSTEM
- [`56-explain.md`](./56-explain.md) — verify query plans on target before cutover
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — pre-and-post-upgrade query timing comparison
- [`69-extensions.md`](./69-extensions.md) — extension catalog and version pinning
- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical replication baseline
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication mechanics + conflict handling
- [`75-replication-slots.md`](./75-replication-slots.md) — slot mechanics, slot migration in PG17+
- [`77-standby-failover.md`](./77-standby-failover.md) — standby promotion procedure
- [`79-patroni.md`](./79-patroni.md) — HA cluster manager — orchestrates replication during upgrade
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — pg_dump full reference
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — base backup before upgrade
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — pg_upgrade deep dive
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — data_checksums, pg_amcheck for pre-upgrade integrity check
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged former primary
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR planning around upgrade windows
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — operator-managed major-version upgrade
- [`95-postgis.md`](./95-postgis.md) — PostGIS upgrade procedure
- [`96-timescaledb.md`](./96-timescaledb.md) — TimescaleDB upgrade procedure
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-major-version highlight features
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-environment upgrade constraints

## Sources

[^lifecycle]: PostgreSQL Versioning Policy — <https://www.postgresql.org/support/versioning/>. "PostgreSQL Global Development Group supports a major version for 5 years from its initial release."

[^pg18-stats]: PostgreSQL 18 Release Notes — <https://www.postgresql.org/docs/release/18.0/>. "Allow pg_upgrade to preserve optimizer statistics (Corey Huinker, Jeff Davis, Nathan Bossart). Extended statistics are not preserved. Also add pg_upgrade option `--no-statistics` to disable statistics preservation."

[^pg18-swap]: PostgreSQL 18 Release Notes. "Add pg_upgrade option `--swap` to swap directories rather than copy, clone, or link files (Nathan Bossart). This mode is potentially the fastest."

[^pg18-jobs]: PostgreSQL 18 Release Notes. "Allow pg_upgrade to process database checks in parallel (Nathan Bossart). This is controlled by the existing `--jobs` option."

[^pg18-charsign]: PostgreSQL 18 Release Notes. "Add option `--set-char-signedness` to pg_upgrade (Masahiko Sawada). This allows clusters created on a CPU architecture with a different char signedness to be upgraded."

[^pg18-checksums]: PostgreSQL 18 Release Notes. "Change initdb default to enable data checksums (Greg Sabino Mullane). Note that pg_upgrade requires matching cluster checksum settings, so this new option [`--no-data-checksums`] can be useful to upgrade non-checksum old clusters."

[^pg18-collation]: PostgreSQL 18 Release Notes. "Require primary/foreign key relationships to use either deterministic collations or the same nondeterministic collations (Peter Eisentraut). The restore of a pg_dump, also used by pg_upgrade, will fail if these requirements are not met."

[^pg18-createsub]: PostgreSQL 18 Release Notes. "Add pg_createsubscriber options `--all`, `--clean`, `--enable-two-phase` (Shubham Khanna)."

[^pg18-proto32]: PostgreSQL 18 Release Notes. "Increase the size of the cancel-request key (Jelte Fennema-Nio, Heikki Linnakangas). [...] this is only possible when the server and client support wire protocol version 3.2, introduced in this release."

[^pg17-createsub]: PostgreSQL 17 Release Notes — <https://www.postgresql.org/docs/release/17.0/>. "Add application pg_createsubscriber to create a logical replica from a physical standby server (Euler Taveira)."

[^pg17-slots]: PostgreSQL 17 Release Notes. "Have pg_upgrade migrate valid logical slots and subscriptions (Hayato Kuroda, Hou Zhijie, Vignesh C, Julien Rouhaud, Shlok Kyal). This only works for old PostgreSQL clusters that are version 17 or later."

[^pg17-cfr]: PostgreSQL 17 Release Notes. "Allow pg_upgrade to use `--copy-file-range` for file copying (Thomas Munro)."

[^pg17-sync]: PostgreSQL 17 Release Notes. "Add `--sync-method` option to initdb, pg_basebackup, pg_checksums, pg_dump, pg_rewind, pg_upgrade (Justin Pryzby, Nathan Bossart)."

[^pg16-locale]: PostgreSQL 16 Release Notes — <https://www.postgresql.org/docs/release/16.0/>. "Have pg_upgrade set the new cluster's locale and encoding to match the old cluster (Jeff Davis). This removes the requirement that the new cluster be created with the same locale and encoding settings."

[^pg16-copyflag]: PostgreSQL 16 Release Notes. "Add a `--copy` option to pg_upgrade (Peter Eisentraut). This is the default behavior, but the option is available for explicitness."

[^pg15-floor]: PostgreSQL 15 Release Notes — <https://www.postgresql.org/docs/release/15.0/>. "Limit support of pg_upgrade to old servers running PostgreSQL 9.2 or later (Tom Lane)."

[^pg15-oid]: PostgreSQL 15 Release Notes. "Make pg_upgrade preserve tablespace and database OIDs, as well as relation relfilenode numbers (Shruthi Gowda, Antonin Houska)."

[^pg15-output]: PostgreSQL 15 Release Notes. "Have pg_upgrade create a log subdirectory `pg_upgrade_output.d` (Justin Pryzby). It is automatically removed on successful completion."

[^pg14-analyze]: PostgreSQL 14 Release Notes — <https://www.postgresql.org/docs/release/14.0/>. "Stop pg_upgrade from creating analyze_new_cluster script (Magnus Hagander). Instead, give comparable vacuumdb instructions."

[^pg14-protov2]: PostgreSQL 14 Release Notes. "Remove server and libpq support for the version 2 wire protocol (Heikki Linnakangas). It was last used as the default in PostgreSQL 7.3 (released in 2002)."

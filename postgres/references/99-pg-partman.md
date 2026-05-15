# pg_partman — Automated Partition Management

External extension that automates partition lifecycle for PostgreSQL declarative partitioning. Pre-creates future partitions, drops or detaches old ones per retention policy, optionally moves data out of default partition into proper child tables.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Installation](#installation)
- [create_parent](#create_parent--register-a-partition-set)
- [run_maintenance](#run_maintenance--the-workhorse)
- [part_config Catalog](#part_config--the-state-table)
- [Retention](#retention--drop-detach-or-archive-old-partitions)
- [Template Table](#template-table--inherit-indexes-and-constraints)
- [Sub-Partitioning](#sub-partitioning)
- [partition_data and undo_partition](#partition_data_proc--undo_partition_proc)
- [Integration with pg_cron](#integration-with-pg_cron)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use This Reference

You are operating partitioned tables — time-series, multi-tenant by tenant_id, or any range / list partitioning — and need automation for:

- pre-creating future partitions before writes hit them,
- dropping or detaching old partitions per retention policy,
- moving data out of the default partition when bounds were extended too late,
- declaring child tables that automatically inherit indexes / constraints / privileges from a template,
- handling sub-partitioning (year → month).

If you are still on native inheritance partitioning (pre-PG10), see [36-inheritance.md](./36-inheritance.md). If you have not yet partitioned, see [35-partitioning.md](./35-partitioning.md) for declarative syntax first.

> [!WARNING] pg_partman 5.x is a hard break from 4.x — different API, different catalog, no in-place upgrade path
> pg_partman v5.0.0 (2023-09-28) removed trigger-based partitioning entirely and dropped `time-static` / `time-dynamic` / `id-static` / `id-dynamic` partition types. Only PG declarative partitioning is supported. Many function parameters renamed; `part_config` columns reshuffled. Migration is via `doc/migrate_to_declarative.md` + `doc/pg_partman_5.0.0_upgrade.md` — not `ALTER EXTENSION ... UPDATE`. Any tutorial older than late-2023 likely references v4 syntax that no longer exists.[^1][^2]

> [!WARNING] pg_partman 5.x requires PostgreSQL >= 14
> Verbatim README: "Requirement: PostgreSQL >= 14"[^1]. PG12 / PG13 are not supported by v5.x — stay on partman 4.7.x if stuck on those, then migrate Postgres major first.

## Mental Model

Five rules:

1. **partman automates declarative partitioning — it is not a partitioning engine.** PG provides `PARTITION BY RANGE / LIST / HASH` ([35-partitioning.md](./35-partitioning.md)). partman pre-creates children, drops old ones, moves orphan data. Without partman you write a cron script doing the same calls by hand.

2. **`partman.create_parent()` registers a parent table in `partman.part_config`.** Parameters specify control column, interval, partition type (`range` or `list`), premake count, automatic-maintenance flag, optional template table. After registration, `run_maintenance()` reads `part_config` and acts.

3. **`run_maintenance_proc()` is a procedure not a function — it commits between partition sets.** Long maintenance run on many sets won't hold one giant transaction. `run_maintenance()` (function) exists for compatibility but cannot commit. Canonical scheduling pattern is `CALL partman.run_maintenance_proc()` from `pg_cron` ([98-pg-cron.md](./98-pg-cron.md)).

4. **Retention is opt-in and asymmetric — drop versus detach versus move-to-schema.** `retention_keep_table = false` drops the table; `true` (default) detaches it leaving it queryable in the same schema. `retention_schema` overrides both — table is reattached-detached-and-moved into named archive schema. No automatic export to object storage.

5. **Template table pattern is one-shot at child creation, not retroactive.** Indexes, constraints, REPLICA IDENTITY, unlogged flag, autovacuum overrides, toast options defined on the template apply to NEW children created after the template was set. Existing children are not back-filled — you ALTER them by hand.

## Decision Matrix

| Use case | Approach |
|---|---|
| Append-only time-series (events, logs, telemetry) | `partman.create_parent(..., p_type := 'range', p_interval := '1 day')` + retention + pg_cron schedule for `run_maintenance_proc()` |
| Multi-tenant by integer ID range | `p_type := 'range', p_interval := '100000'` over the ID column |
| Multi-tenant by tenant_id list | v5.1+ `p_type := 'list'` for single-value integer LIST |
| Hash partitioning (e.g. tenant_id-hash) | pg_partman does NOT support hash — manage hash partitions manually or via Citus ([97-citus.md](./97-citus.md)) |
| Year-then-month sub-partitioning | `partman.create_sub_parent()` |
| Pre-create 30 days of future partitions | `p_premake := 30` (default `4`) |
| Pull data from default partition into proper children | `partman.partition_data_proc()` (PROCEDURE — commits between batches) |
| Reverse a partitioned table back to a single heap | `partman.undo_partition_proc()` |
| Apply indexes / GRANT to future children | Set up template table, register via `p_template_table` |
| Retro-fix existing children with new indexes | Manual `CREATE INDEX CONCURRENTLY` on each leaf — partman does NOT propagate template changes backward |
| Drop old partitions silently in production | Set `retention` + `retention_keep_table = false` in `part_config` |
| Detach old partitions but keep queryable | Set `retention` + `retention_keep_table = true` (default) |
| Move old partitions to archive schema | Set `retention` + `retention_schema = 'archive'` |
| Schedule maintenance every hour | `cron.schedule('partman', '@hourly', $$CALL partman.run_maintenance_proc()$$)` cross-ref [98](./98-pg-cron.md) |
| Schedule for a single partition set only | `partman.run_maintenance(p_parent_table := 'public.events')` |
| Diagnose "why did partman not create the next partition" | Inspect `partman.part_config` + run `run_maintenance(p_jobmon := true)` + read `partman.run_maintenance_jobmon` table |

Three smell signals:

- **Default partition fills up over time** — premake too low, maintenance not running, or `automatic_maintenance` set to `off`. Default-partition data should be near-zero in healthy steady state.
- **`run_maintenance_proc` runs against thousands of partition sets in one cron tick** — split into multiple `part_config` rows + multiple cron schedules, or use `maintenance_order` (v5.1+).
- **Template table changes not reflected on existing partitions** — by design. Template applies to NEW children only.

## Installation

```sql
-- Requires shared_preload_libraries entry NOT needed (unlike pg_cron / pg_stat_statements).
-- pg_partman is a SQL-side + plpgsql extension. Just CREATE EXTENSION.

-- Optional: dedicated schema for partman objects.
CREATE SCHEMA partman;
CREATE EXTENSION pg_partman WITH SCHEMA partman;

-- Verify.
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_partman';
```

> [!NOTE] Superuser requirement removed in v5.2.0
> v5.2.0 (2024-11-22) removed the superuser requirement for `CREATE EXTENSION pg_partman`. Earlier versions required superuser at install time. The `partman` role used at runtime can be a non-superuser with sufficient grants on the partitioned tables.[^2]

Most managed providers either preinstall pg_partman or expose it via their extension allowlist. Self-hosted: install the OS package (`postgresql-NN-partman`) or build from source per [99-pg-partman.md repository INSTALL.md][^1].

## `create_parent` — register a partition set

Full v5.4+ signature:[^3]

```sql
partman.create_parent(
    p_parent_table          text,                   -- 'schema.table' fully qualified
    p_control               text,                   -- column controlling partitioning (timestamp, integer)
    p_interval              text,                   -- e.g. '1 day', '1 month', '100000', 'P1D'
    p_type                  text    DEFAULT 'range',-- 'range' | 'list' (v5.1+)
    p_epoch                 text    DEFAULT 'none', -- 'none' | 'seconds' | 'milliseconds' | 'microseconds' (v5.2+) | 'nanoseconds' for integer epoch storing time
    p_premake               int     DEFAULT 4,      -- count of future partitions to pre-create
    p_start_partition       text    DEFAULT NULL,   -- first partition bound; auto-derives from now() if NULL
    p_default_table         boolean DEFAULT true,   -- create DEFAULT partition (v5.2 removed this column from part_config but kept as create_parent arg)
    p_automatic_maintenance text    DEFAULT 'on',   -- 'on' | 'off' — controls whether run_maintenance() touches this set
    p_constraint_cols       text[]  DEFAULT NULL,   -- columns to apply min/max constraints for constraint-exclusion
    p_template_table        text    DEFAULT NULL,   -- 'schema.template_table'
    p_jobmon                boolean DEFAULT true,   -- log to partman.run_maintenance_jobmon
    p_date_trunc_interval   text    DEFAULT NULL    -- e.g. 'day' to truncate bounds
) RETURNS boolean
```

> [!NOTE] PostgreSQL 5.4.0 added `create_partition()` alias
> v5.4.0 (2026-01-05) renamed `create_parent()` to `create_partition()` for naming consistency with `undo_partition()`. The old name is retained for backward compatibility — both forms work.[^2]

Canonical time-range registration:

```sql
-- Step 1: create the parent (PARTITION BY RANGE must already exist).
CREATE TABLE public.events (
    event_id   bigint       NOT NULL,
    occurred_at timestamptz NOT NULL,
    tenant_id  int          NOT NULL,
    payload    jsonb        NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (occurred_at);

-- Step 2: register with partman.
SELECT partman.create_parent(
    p_parent_table  := 'public.events',
    p_control       := 'occurred_at',
    p_interval      := '1 day',
    p_premake       := 7,
    p_type          := 'range'
);

-- Verify.
SELECT parent_table, control, partition_interval, partition_type, premake, automatic_maintenance
FROM partman.part_config
WHERE parent_table = 'public.events';

-- Inspect created children.
SELECT inhrelid::regclass AS child
FROM pg_inherits
WHERE inhparent = 'public.events'::regclass
ORDER BY 1;
```

After this call, partman has created `events_p2026_05_07`, `events_p2026_05_08`, ..., `events_p2026_05_14`, `events_default` and registered them under the parent.

List partitioning (v5.1+) over integer tenant_id:

```sql
CREATE TABLE public.events_by_tenant (
    event_id   bigint NOT NULL,
    tenant_id  int    NOT NULL,
    payload    jsonb  NOT NULL
) PARTITION BY LIST (tenant_id);

SELECT partman.create_parent(
    p_parent_table := 'public.events_by_tenant',
    p_control      := 'tenant_id',
    p_interval     := '1',
    p_type         := 'list'
);
```

## `run_maintenance` — the workhorse

Two forms, different transaction semantics:[^3]

| Form | Transaction | When to use |
|---|---|---|
| `partman.run_maintenance(p_parent_table text DEFAULT NULL, p_analyze boolean DEFAULT false, p_jobmon boolean DEFAULT true)` | Function — one transaction for entire call | Ad-hoc, single set, manual invocation |
| `partman.run_maintenance_proc(p_wait int DEFAULT 0, p_analyze boolean DEFAULT NULL, p_jobmon boolean DEFAULT true)` | Procedure — commits between partition sets | Scheduled invocation via pg_cron, many partition sets |

For each registered partition set with `automatic_maintenance = 'on'`:

1. Pre-create future partitions based on `premake` and current control-column value.
2. Drop or detach partitions older than `retention` (if `retention` is set).
3. Optionally `ANALYZE` newly attached children (if `p_analyze := true`).

```sql
-- One-shot maintenance for a single set.
SELECT partman.run_maintenance(p_parent_table := 'public.events');

-- Scheduled batch maintenance for all sets (cron-friendly).
CALL partman.run_maintenance_proc();

-- With analyze + delay between sets (delay reduces lock pressure).
CALL partman.run_maintenance_proc(p_wait := 30, p_analyze := true);
```

> [!NOTE] PostgreSQL 5.1.0 added `maintenance_order`
> v5.1.0 (2024-04-02) added `maintenance_order int` + `maintenance_last_run timestamptz` columns to `part_config`. `maintenance_order` controls execution priority when many sets are configured — smaller integer runs earlier. NULL means default ordering.[^2]

## `part_config` — the state table

Read this to see what is configured; modify it to change behavior (avoid editing during a maintenance run). Columns (v5.4+):[^3]

| Column | Meaning |
|---|---|
| `parent_table` | `schema.table` — primary key |
| `control` | Column used for partitioning |
| `partition_interval` | e.g. `'1 day'`, `'1 month'`, `'100000'` |
| `partition_type` | `range` or `list` (v5.0+); pre-v5 had `time-static` / `time-dynamic` / `id-static` / `id-dynamic` — all removed in v5.0 |
| `premake` | Future partitions pre-created (default 4) |
| `automatic_maintenance` | `on` / `off` — whether `run_maintenance()` touches this set |
| `template_table` | Optional template-table reference |
| `retention` | Interval (time) or bigint (integer) for keep-window; NULL = keep all |
| `retention_schema` | If set, move expired partitions to this schema; overrides `retention_keep_table` |
| `retention_keep_index` | Boolean — drop or keep indexes on detached children |
| `retention_keep_table` | Boolean (default true) — detach vs drop |
| `epoch` | `none` / `seconds` / `milliseconds` / `microseconds` (v5.2+) / `nanoseconds` — for integer epoch columns storing time |
| `constraint_cols` | Columns to maintain min/max CHECK constraints on for constraint-exclusion |
| `optimize_constraint` | Number of partitions back to maintain constraint |
| `infinite_time_partitions` | If true, premake bounded by partition_interval not by data presence |
| `datetime_string` | Suffix format for child table names (e.g. `YYYY_MM_DD`) |
| `jobmon` | Log to `partman.run_maintenance_jobmon` |
| `sub_partition_set_full` | Used for sub-partitioning |
| `undo_in_progress` | Flag set by `undo_partition_proc()` |
| `inherit_privileges` | Whether new children inherit parent privileges automatically |
| `constraint_valid` | Whether to mark constraint VALID immediately (vs NOT VALID + later VALIDATE) |
| `subscription_refresh` | List of subscription names to refresh after partition changes (logical replication) |
| `ignore_default_data` | If true, do not consider default partition during maintenance |
| `maintenance_order` (v5.1+) | Ordering priority |
| `retention_keep_publication` (v5.1+) | Whether to keep publication membership on detached partitions |
| `maintenance_last_run` (v5.1+) | Timestamp of last successful run |

To pause maintenance for a single set:

```sql
UPDATE partman.part_config
SET automatic_maintenance = 'off'
WHERE parent_table = 'public.events';
```

## Retention — drop, detach, or archive old partitions

Three behaviors, controlled by three columns:[^3]

| `retention` | `retention_schema` | `retention_keep_table` | Effect on expired partitions |
|---|---|---|---|
| `NULL` | any | any | No retention enforced — keep everything |
| set | `NULL` | `true` (default) | DETACH from parent, leave in current schema |
| set | `NULL` | `false` | DETACH + DROP TABLE |
| set | `'archive'` | any | DETACH + ALTER ... SET SCHEMA archive |

```sql
-- Keep 90 days of events, drop older.
UPDATE partman.part_config
SET retention            = '90 days',
    retention_keep_table = false
WHERE parent_table = 'public.events';

-- Keep 90 days, move older to archive schema.
CREATE SCHEMA IF NOT EXISTS archive;
UPDATE partman.part_config
SET retention            = '90 days',
    retention_schema     = 'archive',
    retention_keep_table = true
WHERE parent_table = 'public.events';
```

> [!WARNING] retention_keep_table=false is irreversible
> Once `run_maintenance()` drops a partition, the data is gone. Pair with logical archive (cron `COPY` to S3, or use `retention_schema` to move to detached archive schema where you control further lifecycle). The detach + move path is the safer default for compliance workloads.

## Template table — inherit indexes and constraints

PG declarative partitioning does NOT propagate every property from parent to children. Indexes on parent propagate as INVALID until attached; PRIMARY KEY must include partition key; UNIQUE must include partition key; foreign keys, REPLICA IDENTITY, unlogged flag, autovacuum overrides, toast options — none of these propagate.

partman's template-table mechanism fills the gap. You create a separate table (not under the parent) with the desired properties, then register it as `p_template_table` in `create_parent()`. Each NEW child created by partman inherits from the template at creation time.

```sql
-- Step 1: create the template (NOT a child of events).
CREATE TABLE partman.events_template (LIKE public.events);

-- Step 2: add properties you want propagated to new children.
ALTER TABLE partman.events_template REPLICA IDENTITY FULL;
CREATE INDEX events_template_tenant_idx ON partman.events_template(tenant_id);
CREATE INDEX events_template_payload_gin ON partman.events_template USING GIN (payload);

-- Step 3: register with partman.
SELECT partman.create_parent(
    p_parent_table  := 'public.events',
    p_control       := 'occurred_at',
    p_interval      := '1 day',
    p_premake       := 7,
    p_template_table := 'partman.events_template'
);

-- Or, if create_parent was already called:
UPDATE partman.part_config
SET template_table = 'partman.events_template'
WHERE parent_table = 'public.events';
```

> [!WARNING] Template is one-shot at child creation
> Properties on the template apply to children created AFTER the template was registered. Existing children are not back-filled. To retro-fit, you must `CREATE INDEX CONCURRENTLY` / `ALTER TABLE` each existing leaf by hand. Same applies to any later template change.[^4]

## Sub-partitioning

`partman.create_sub_parent()` (v5.4.0 alias `create_sub_partition()`) registers a sub-level. Useful for year-then-month or tenant-then-month patterns. Same parameter shape as `create_parent()` with the top-parent as first arg.

```sql
-- Year-level parent.
CREATE TABLE public.events (
    event_id    bigint NOT NULL,
    occurred_at timestamptz NOT NULL
) PARTITION BY RANGE (occurred_at);

SELECT partman.create_parent(
    p_parent_table := 'public.events',
    p_control      := 'occurred_at',
    p_interval     := '1 year'
);

-- Sub-partition each year by month.
SELECT partman.create_sub_parent(
    p_top_parent    := 'public.events',
    p_control       := 'occurred_at',
    p_interval      := '1 month'
);
```

After this call, partman creates yearly children + monthly grandchildren on each yearly child. Read `partman.part_config_sub` to inspect sub-config rows.

## `partition_data_proc` + `undo_partition_proc`

Two background-job procedures for bulk data movement:[^3]

`partition_data_proc()` — pull rows out of the DEFAULT partition into the proper child partitions. Use when bounds were extended too late and the default accumulated rows that belong elsewhere. Commits between batches so a long migration does not hold one giant transaction.

```sql
-- Move all data out of events_default into proper child partitions.
CALL partman.partition_data_proc(
    p_parent_table   := 'public.events',
    p_loop_count     := 100,    -- batches per call
    p_interval       := '1 day',-- batch size in partition_interval units
    p_lock_wait      := 5,      -- seconds to wait for lock
    p_lock_wait_tries := 10,
    p_wait           := 1       -- seconds between batches
);
```

`undo_partition_proc()` — reverse a partitioned table back to a single heap. Useful for major refactors or repartitioning under a different key. Aware: this is destructive in the sense it removes the partition structure — be sure of intent.

```sql
CALL partman.undo_partition_proc(
    p_parent_table  := 'public.events',
    p_target_table  := 'public.events_undone',
    p_loop_count    := 100,
    p_keep_table    := true,   -- keep child tables after data move
    p_drop_cascade  := false
);
```

## Integration with pg_cron

Canonical pattern is to schedule `run_maintenance_proc()` from pg_cron ([98-pg-cron.md](./98-pg-cron.md)):

```sql
-- Hourly maintenance covering all configured partition sets.
SELECT cron.schedule(
    'partman-maintenance',
    '@hourly',
    $$CALL partman.run_maintenance_proc()$$
);

-- Verify.
SELECT jobid, schedule, command FROM cron.job WHERE jobname = 'partman-maintenance';
```

> [!NOTE] pg_cron installs only in one database per cluster
> pg_cron may only be installed in the database named by the `cron.database_name` GUC (default `postgres`). To schedule partman maintenance for a partition set living in a different database, use `cron.schedule_in_database()` from the pg_cron database, passing the target database name. See [98-pg-cron.md gotcha #3](./98-pg-cron.md).

> [!NOTE] partman + HA failover
> pg_cron + partman both run on the primary only. After a failover, the new primary has the same `partman.part_config` (replicated via physical replication) AND the same `cron.job` rows. Maintenance resumes automatically on the new primary. If using logical replication, `partman.part_config` is NOT replicated by default — re-create on the subscriber side. See [77-standby-failover.md](./77-standby-failover.md).

## Per-Version Timeline

pg_partman is wholly external. **All five PG major release notes (PG14 / PG15 / PG16 / PG17 / PG18) contain ZERO `pg_partman` items.** All meaningful changes happen in pg_partman's own release cadence.

| Version | Released | Highlights |
|---|---|---|
| 4.7.x | 2021–2023 | Last v4 series. Supported trigger-based + declarative partitioning. `time-static` / `time-dynamic` / `id-static` / `id-dynamic` types. Stay on this branch if on PG12 / PG13. |
| **5.0.0** | 2023-09-28 | **Major break.** Removed trigger-based partitioning entirely. Only declarative supported. Dropped `time-*` and `id-*` types — only `range`. Parameters renamed; `part_config` columns reshuffled. Migration via `doc/migrate_to_declarative.md` + `doc/pg_partman_5.0.0_upgrade.md`. **Privileges NOT preserved across upgrade — re-grant.** |
| 5.1.0 | 2024-04-02 | LIST partitioning for single-value integers. `maintenance_order` + `maintenance_last_run` columns added to `part_config`. REPLICA IDENTITY auto-inherits from template. Experimental numeric-column range partitioning. |
| 5.2.0 | 2024-11-22 | UUIDv7 + custom-encoded methods for time-based partitioning. Microsecond epoch precision. **Superuser requirement removed.** `default_table` column removed from `part_config` (kept as `create_parent()` arg). Control column may be NULL (with care). |
| 5.3.0 | 2025-10-09 | New `partition_data_async()` for smaller batched moves out of default partition (time-based only). `p_ignored_columns` support. UUID partitioning support in `partition_data_time()` / `_proc()`. |
| 5.4.0 | 2026-01-05 | Renamed `create_parent()` → `create_partition()` + `create_sub_parent()` → `create_sub_partition()` (old names retained). New `config_cleanup()` strips pg_partman state while leaving partitioned table intact. `p_ignore_infinity` parameter for default-table handling. |
| 5.4.3 | 2026-03-05 | Latest stable at planning time. Toast inheritance from template; fixes 5.4.2 control-file version-mismatch bug. |

> [!NOTE] All five PG majors contain ZERO pg_partman release-note items
> Verified at planning time across PG14 / PG15 / PG16 / PG17 / PG18 release notes. Any version-specific behavior change comes from pg_partman's own release cadence, not from PG. If a tutorial claims "PG18 introduced partman feature X" — verify against [pg_partman CHANGELOG.txt][^2] directly.

## Recipes

### 1. Baseline append-only events with daily partitions + 90-day retention + pg_cron

```sql
-- Schema.
CREATE TABLE public.events (
    event_id    bigserial    NOT NULL,
    occurred_at timestamptz  NOT NULL DEFAULT now(),
    tenant_id   int          NOT NULL,
    event_type  text         NOT NULL,
    payload     jsonb        NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Template for indexes that should apply to every new partition.
CREATE TABLE partman.events_template (LIKE public.events);
CREATE INDEX events_template_tenant_idx ON partman.events_template (tenant_id);
CREATE INDEX events_template_payload_gin ON partman.events_template USING GIN (payload);

-- Register with partman.
SELECT partman.create_parent(
    p_parent_table   := 'public.events',
    p_control        := 'occurred_at',
    p_interval       := '1 day',
    p_premake        := 14,
    p_template_table := 'partman.events_template'
);

-- 90-day retention with drop.
UPDATE partman.part_config
SET retention            = '90 days',
    retention_keep_table = false
WHERE parent_table = 'public.events';

-- Schedule hourly maintenance.
SELECT cron.schedule(
    'partman-maintenance',
    '@hourly',
    $$CALL partman.run_maintenance_proc()$$
);
```

### 2. Move data out of default partition

Bounds were extended too late. Default partition accumulated 50M rows that belong in proper children.

```sql
-- Inspect default-partition size first.
SELECT pg_size_pretty(pg_relation_size('public.events_default'));

-- Move rows in batches, commit between, avoid one big transaction.
CALL partman.partition_data_proc(
    p_parent_table    := 'public.events',
    p_loop_count      := 100,
    p_interval        := '1 day',
    p_lock_wait       := 5,
    p_lock_wait_tries := 10,
    p_wait            := 1
);

-- Verify.
SELECT pg_size_pretty(pg_relation_size('public.events_default'));
```

### 3. Add a new index to every existing partition (template does NOT back-fill)

Template registers index on FUTURE partitions. Existing partitions stay un-indexed unless you walk them by hand. Use `CREATE INDEX CONCURRENTLY` then attach to the parent index ([26-index-maintenance.md](./26-index-maintenance.md)).

```sql
-- Step 1: add to template so future children get it.
CREATE INDEX events_template_event_type_idx
    ON partman.events_template (event_type);

-- Step 2: walk existing leaves with CIC.
DO $$
DECLARE
    leaf regclass;
BEGIN
    FOR leaf IN
        SELECT inhrelid::regclass
        FROM pg_inherits
        WHERE inhparent = 'public.events'::regclass
    LOOP
        EXECUTE format(
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %s (event_type)',
            'idx_events_event_type_' || regexp_replace(leaf::text, '^.*_p', ''),
            leaf
        );
    END LOOP;
END;
$$;

-- Step 3: create the parent-level index referencing leaves.
-- (PG12+ creates parent index INVALID until all leaves attached)
CREATE INDEX events_event_type_idx ON ONLY public.events (event_type);

-- Step 4: attach each leaf index to the parent.
DO $$
DECLARE
    leaf regclass;
    leaf_idx text;
BEGIN
    FOR leaf, leaf_idx IN
        SELECT inhrelid::regclass,
               'idx_events_event_type_' || regexp_replace(inhrelid::regclass::text, '^.*_p', '')
        FROM pg_inherits
        WHERE inhparent = 'public.events'::regclass
    LOOP
        EXECUTE format(
            'ALTER INDEX %I ATTACH PARTITION %I',
            'events_event_type_idx',
            leaf_idx
        );
    END LOOP;
END;
$$;
```

### 4. Pause maintenance for one set (planned outage)

```sql
UPDATE partman.part_config
SET automatic_maintenance = 'off'
WHERE parent_table = 'public.events';

-- ... maintenance window ...

UPDATE partman.part_config
SET automatic_maintenance = 'on'
WHERE parent_table = 'public.events';

-- Catch up.
SELECT partman.run_maintenance(p_parent_table := 'public.events');
```

### 5. Archive to schema instead of drop

```sql
CREATE SCHEMA IF NOT EXISTS archive;

UPDATE partman.part_config
SET retention            = '90 days',
    retention_schema     = 'archive',
    retention_keep_table = true
WHERE parent_table = 'public.events';

-- Verify after next run.
CALL partman.run_maintenance_proc();
SELECT relnamespace::regnamespace AS schema, relname
FROM pg_class
WHERE relkind = 'r'
  AND relname LIKE 'events_p%'
ORDER BY 1, 2;
```

### 6. Sub-partition year → month

```sql
CREATE TABLE public.events (
    event_id    bigint      NOT NULL,
    occurred_at timestamptz NOT NULL
) PARTITION BY RANGE (occurred_at);

-- Top level: yearly.
SELECT partman.create_parent(
    p_parent_table := 'public.events',
    p_control      := 'occurred_at',
    p_interval     := '1 year',
    p_premake      := 2
);

-- Sub level: monthly under each year.
SELECT partman.create_sub_parent(
    p_top_parent := 'public.events',
    p_control    := 'occurred_at',
    p_interval   := '1 month',
    p_premake    := 3
);

-- Inspect sub-config.
SELECT * FROM partman.part_config_sub;
```

### 7. Audit all partition sets cluster-wide

```sql
SELECT
    pc.parent_table,
    pc.control,
    pc.partition_interval,
    pc.partition_type,
    pc.premake,
    pc.retention,
    pc.automatic_maintenance,
    pc.maintenance_last_run,
    COUNT(i.inhrelid) AS leaf_count,
    pg_size_pretty(SUM(pg_relation_size(i.inhrelid))) AS total_size
FROM partman.part_config pc
LEFT JOIN pg_inherits i ON i.inhparent = pc.parent_table::regclass
GROUP BY pc.parent_table, pc.control, pc.partition_interval, pc.partition_type,
         pc.premake, pc.retention, pc.automatic_maintenance, pc.maintenance_last_run
ORDER BY total_size DESC;
```

### 8. Diagnose "why isn't partman creating the next partition"

```sql
-- Step 1: is automatic_maintenance on?
SELECT parent_table, automatic_maintenance, maintenance_last_run
FROM partman.part_config
WHERE parent_table = 'public.events';

-- Step 2: is the cron job running?
SELECT * FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'partman-maintenance')
ORDER BY start_time DESC LIMIT 5;

-- Step 3: run maintenance manually with jobmon enabled and read the log.
SELECT partman.run_maintenance(
    p_parent_table := 'public.events',
    p_jobmon       := true
);

-- Step 4: read jobmon table.
SELECT * FROM partman.run_maintenance_jobmon
WHERE parent_table = 'public.events'
ORDER BY started_at DESC LIMIT 10;
```

### 9. Migrate from inheritance-partitioning to declarative-partitioning (pre-v5 → v5)

If still on partman 4.x with trigger-based partitioning, follow the official migration docs: `doc/migrate_to_declarative.md` and `doc/pg_partman_5.0.0_upgrade.md` in the repo. High-level shape:

1. Stop writes (or write-through to a logical replication subscriber).
2. Create new declarative-partitioned parent.
3. Backfill data from old children via `INSERT INTO new_parent SELECT * FROM old_child` per child (or `partition_data_proc()` for batch-safe variant).
4. Cut over application to new parent.
5. Drop old inheritance tree.

### 10. UUIDv7 time-based partitioning (v5.2+)

```sql
-- Requires PG18+ for in-core uuidv7() or pgcrypto for gen_random_uuid().
-- pg_partman v5.2+ recognizes UUIDv7 as time-ordered.

CREATE TABLE public.events (
    event_id    uuid        NOT NULL DEFAULT uuidv7(),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    payload     jsonb       NOT NULL
) PARTITION BY RANGE (event_id);

-- partman extracts the timestamp from UUIDv7.
SELECT partman.create_parent(
    p_parent_table := 'public.events',
    p_control      := 'event_id',
    p_interval     := '1 day',
    p_premake      := 7,
    p_type         := 'range'
);
```

### 11. Reverse a partitioned table back to a single heap

```sql
-- One-shot consolidation of all partitions into a target table.
CREATE TABLE public.events_consolidated (LIKE public.events INCLUDING ALL);

CALL partman.undo_partition_proc(
    p_parent_table  := 'public.events',
    p_target_table  := 'public.events_consolidated',
    p_loop_count    := 100,
    p_wait          := 1,
    p_keep_table    := false  -- drop child tables after data move
);
```

### 12. Configure partman to refresh logical replication subscription on partition changes

When the partitioned table is published / subscribed, attaching or detaching partitions changes the publication membership. partman can auto-call `ALTER SUBSCRIPTION ... REFRESH PUBLICATION` after maintenance.

```sql
-- On the subscriber side (where partman lives mirroring the publisher's partition structure).
UPDATE partman.part_config
SET subscription_refresh = ARRAY['my_subscription']
WHERE parent_table = 'public.events';
```

### 13. Cleanup partman state without dropping the partitioned table (v5.4+)

```sql
-- v5.4.0 added config_cleanup() to remove partman state cleanly.
SELECT partman.config_cleanup(p_parent_table := 'public.events');

-- After this, public.events still exists as a declarative-partitioned table
-- with its current children, but partman no longer manages it.
```

## Gotchas

1. **v5 is a hard break from v4 — no in-place `ALTER EXTENSION UPDATE` path.** Migration is via `doc/migrate_to_declarative.md` + `doc/pg_partman_5.0.0_upgrade.md`. Most older tutorials reference v4 trigger-based syntax that no longer exists.

2. **pg_partman 5.x requires PG14 minimum.** Verbatim README: "Requirement: PostgreSQL >= 14". PG12 / PG13 require staying on partman 4.7.x.

3. **No HASH partitioning support.** partman manages `range` and `list` (v5.1+) only. Hash-partitioned tables must be created and maintained manually, or use Citus ([97-citus.md](./97-citus.md)).

4. **Template table changes are NOT retroactive.** Indexes / constraints / REPLICA IDENTITY added to template apply to NEW children only. Existing children stay un-indexed — walk them with `CREATE INDEX CONCURRENTLY` per Recipe 3.

5. **`retention_keep_table = false` drops the table irreversibly.** Once `run_maintenance()` drops a partition, data is gone. Pair with logical archive (cron `COPY` to S3) or use `retention_schema` for safer detach + move pattern.

6. **`run_maintenance` (function) holds one giant transaction; `run_maintenance_proc` (procedure) commits between sets.** Use the proc form from pg_cron. Use the function form only for one-shot manual invocations on a single set.

7. **`automatic_maintenance = 'off'` silently disables maintenance for a set.** Read it explicitly when diagnosing "why aren't future partitions being created."

8. **`maintenance_last_run` only populates if `p_jobmon = true`** (or v5.1+ updates it regardless — verify per version). If maintenance appears to run but `maintenance_last_run` stays NULL, jobmon is likely disabled.

9. **`premake` too low + maintenance not running = writes hit DEFAULT partition.** Default partition should be near-empty in healthy steady state. Investigate if it grows.

10. **PRIMARY KEY on partitioned table must include the partition key column.** PG declarative-partitioning rule, not partman-specific. For time-partitioned tables, PK must be `(id, occurred_at)` not `(id)` alone. UNIQUE constraints likewise. See [35-partitioning.md gotcha #1](./35-partitioning.md).

11. **Foreign keys referencing a partitioned parent only work from PG12+.** Foreign keys FROM a partitioned table also need each leaf to have a matching covering index. See [38-foreign-keys-deep.md](./38-foreign-keys-deep.md).

12. **partman.part_config is NOT replicated by logical replication.** Physical replication ships the catalog as-is. For logical-replication topologies, re-create `part_config` on the subscriber side and run maintenance independently.

13. **`partition_data_proc` is time-based-partition-only for `partition_data_async` (v5.3+).** For non-time partitioning, use `partition_data_proc()` synchronously.

14. **Privileges on partman objects are NOT preserved across the v4 → v5 upgrade.** Re-grant after migration.

15. **`p_interval` must be a valid PostgreSQL `interval` value** for time-based partitioning. v5.0 removed the shortcut strings (`weekly`, `monthly`, etc.) — use `'1 week'` / `'1 month'` instead.

16. **`p_epoch` is required when control column is an integer storing epoch.** Without `p_epoch := 'seconds'` (or `milliseconds` / `microseconds`), partman treats the integer column as a plain numeric range, not a time range.

17. **`infinite_time_partitions = true` pre-creates partitions regardless of data presence.** Useful for tables that may have gaps in incoming data; default `false` is data-driven (only pre-create if there is data approaching the bound).

18. **`p_constraint_cols` adds CHECK constraints for non-key columns to enable constraint exclusion**, useful pre-PG10. Mostly obsolete with PG declarative pruning; only enable if specific queries benefit.

19. **Sub-partitioning multiplies leaf count.** Year-then-month for 5 years = 60 leaves. Year-then-day-of-year = 1825 leaves. Each leaf has its own catalog row, autovacuum target, planner-time cost. Cap depth at 2 levels in practice.

20. **`undo_partition_proc()` is destructive to the partition structure.** It moves data into a single target table and (optionally) drops the children. There is no `redo_partition_proc()` — re-running `create_parent()` requires a fresh partitioned table.

21. **`automatic_maintenance = 'on'` is meaningless without a scheduled call to `run_maintenance_proc()`.** partman does not have its own scheduler — relies on pg_cron, a background worker config, or an external orchestrator.

22. **partman objects (`part_config`, `run_maintenance_jobmon`) live in the schema where the extension was installed.** `CREATE EXTENSION pg_partman WITH SCHEMA partman` is the canonical placement. Querying `part_config` without schema-qualifying requires `partman` in `search_path`.

23. **PG14 / PG15 / PG16 / PG17 / PG18 release notes contain ZERO pg_partman items.** Verified at planning time. Tutorials claiming "PG N added partman feature X" must be verified against `pg_partman/CHANGELOG.txt` directly — feature timeline belongs to partman, not PG.

## See Also

- [26-index-maintenance.md](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY` + attach pattern for retroactive index propagation
- [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md) — autovacuum tuning for high-cardinality partition sets
- [35-partitioning.md](./35-partitioning.md) — declarative partitioning syntax + DEFAULT partition rules
- [36-inheritance.md](./36-inheritance.md) — legacy inheritance-partitioning (the pre-v5 partman target)
- [38-foreign-keys-deep.md](./38-foreign-keys-deep.md) — FK indexing requirements per leaf
- [46-roles-privileges.md](./46-roles-privileges.md) — `ALTER DEFAULT PRIVILEGES IN SCHEMA` for new partitions
- [73-streaming-replication.md](./73-streaming-replication.md) — physical replication preserves `part_config`
- [74-logical-replication.md](./74-logical-replication.md) — `subscription_refresh` interaction with partman
- [77-standby-failover.md](./77-standby-failover.md) — partman + cron resume on new primary after failover
- [83-backup-pg-dump.md](./83-backup-pg-dump.md) — `--table` + pattern matching with partitioned tables
- [86-pg-upgrade.md](./86-pg-upgrade.md) — pg_partman binary must exist on target cluster before pg_upgrade
- [92-kubernetes-operators.md](./92-kubernetes-operators.md) — operator-managed partman extension
- [96-timescaledb.md](./96-timescaledb.md) — TimescaleDB as alternative for time-based partitioning automation; 96's Decision Matrix cites 99 as the native-partitioning alternative
- [98-pg-cron.md](./98-pg-cron.md) — canonical scheduler for `run_maintenance_proc()`
- [100-pg-versions-features.md](./100-pg-versions-features.md) — PG14 minimum requirement and version-gated features affecting partman behavior
- [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md) — pg_partman in managed-Postgres allowlists
- [102-skill-cookbook.md](./102-skill-cookbook.md) — Recipe 10 Partition Rotation Automation centers on pg_partman

## Sources

[^1]: pg_partman README — https://github.com/pgpartman/pg_partman (PG14+ requirement, license, install)
[^2]: pg_partman CHANGELOG.txt — https://github.com/pgpartman/pg_partman/blob/master/CHANGELOG.txt (per-version timeline 4.x → 5.4.3)
[^3]: pg_partman docs — https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman.md (function signatures, `part_config` columns, parameters)
[^4]: pg_partman howto — https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman_howto.md (template-table pattern, sub-partitioning)
[^5]: pg_partman 5.0.0 upgrade doc — https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman_5.0.0_upgrade.md (v4 → v5 migration steps)
[^6]: pg_partman migrate-to-declarative — https://github.com/pgpartman/pg_partman/blob/master/doc/migrate_to_declarative.md (inheritance → declarative migration)
[^7]: PG 14 release notes — https://www.postgresql.org/docs/14/release-14.html (verified ZERO pg_partman items)
[^8]: PG 15 release notes — https://www.postgresql.org/docs/15/release-15.html (verified ZERO pg_partman items)
[^9]: PG 16 release notes — https://www.postgresql.org/docs/16/release-16.html (verified ZERO pg_partman items)
[^10]: PG 17 release notes — https://www.postgresql.org/docs/17/release-17.html (verified ZERO pg_partman items)
[^11]: PG 18 release notes — https://www.postgresql.org/docs/18/release-18.html (verified ZERO pg_partman items)

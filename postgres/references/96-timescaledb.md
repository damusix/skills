# TimescaleDB

TimescaleDB = open-source time-series extension for PostgreSQL. Adds **hypertables** (automatic time-based partitioning), **hypercore** columnar compression (90%+ typical), **continuous aggregates** (incrementally-materialized views), **data retention policies**, and an in-database **job scheduler**. Maintained by Tiger Data (renamed from Timescale Inc.). Wholly external extension — versioned independently of PostgreSQL.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [License Model](#license-model)
  - [Hypertables](#hypertables)
  - [Hypercore (Columnar Compression)](#hypercore-columnar-compression)
  - [Continuous Aggregates](#continuous-aggregates)
  - [Data Retention](#data-retention)
  - [Job Scheduler](#job-scheduler)
  - [Hypertable vs Native Partitioning](#hypertable-vs-native-partitioning)
  - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

When working with time-series, event, or IoT workloads in Postgres — sensor readings, metrics, financial ticks, user-action events. For native declarative partitioning (which TimescaleDB hypertables sit conceptually on top of), see [`35-partitioning.md`](./35-partitioning.md). For scheduling outside TimescaleDB see [`98-pg-cron.md`](./98-pg-cron.md). For automated partition lifecycle without TimescaleDB see [`99-pg-partman.md`](./99-pg-partman.md). For vector search see [`94-pgvector.md`](./94-pgvector.md). For Citus (distributed Postgres, different problem) see [`97-citus.md`](./97-citus.md).

## Mental Model

Five rules:

1. **TimescaleDB is THE time-series extension for Postgres.** Wholly external, versioned independently (latest stable **v2.27.0** at planning time, released 2026-05-12). Supports PG **15-18** at v2.27.0. PG14 already dropped. **PG15 last-supported in June 2026 release** per official deprecation notice. **Zero TimescaleDB items in PG14/15/16/17/18 release notes** — TimescaleDB evolves on its own cadence.

2. **Hypertable = automatically-chunked Postgres table.** `SELECT create_hypertable('events', by_range('ts'))` (or the modern `CREATE TABLE ... WITH (tsdb.hypertable, ...)` declarative form added in v2.20+) takes a regular table + a time column, transparently partitions it into **chunks** (child tables) bucketed by time. Inserts route automatically to the right chunk. Most SQL works unchanged. Chunks are real Postgres tables — visible in `_timescaledb_internal` schema.

3. **Hypercore is columnar compression (90%+ typical).** Per-chunk: rows convert to columnar segments, segmented by a `segmentby` column (the equality-filter dimension) and ordered by an `orderby` column (the range-scan dimension). Compressed chunks are read-only by default; INSERTs into a compressed chunk are slow path. Newer **hypercore** APIs (`add_columnstore_policy`) supersede classic compression (`add_compression_policy`) since **v2.18.0** — old APIs still supported, no migration required.

4. **Continuous aggregates = incrementally-maintained materialized views.** `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) AS SELECT time_bucket(...) FROM hypertable GROUP BY bucket`. Background job refreshes only changed time buckets — far cheaper than `REFRESH MATERIALIZED VIEW`. **Real-time aggregation DISABLED by default since v2.13** — must opt back in via `timescaledb.materialized_only = false`.

5. **Retention drops whole chunks not rows.** `add_retention_policy('events', INTERVAL '90 days')` runs background job that `DROP TABLE`s expired chunks. **Orders of magnitude faster than `DELETE FROM ... WHERE ts < now() - INTERVAL '90 days'`** — no row scan, no VACUUM amplification, no autovacuum lag. Combine with continuous aggregates for downsampling pattern (raw 90 days + hourly rollups forever).

> [!WARNING] TimescaleDB is NOT in core PostgreSQL
> External extension. `shared_preload_libraries = 'timescaledb'` + restart + `CREATE EXTENSION timescaledb`. Background workers + scheduler require preload. Most managed providers offer it but with version lag — verify your provider's available TimescaleDB version against your PG major. PG14/15/16/17/18 release notes contain ZERO TimescaleDB items — version TimescaleDB by its own version, not by PG major.

> [!WARNING] License is split — DBaaS prohibition on TSL parts
> Repository root = Apache 2.0. `/tsl/` directory = **Timescale License (TSL)** — explicitly prohibits using TSL code to provide "time-sharing services or database-as-a-service" without Tiger Data agreement. Compression, continuous aggregates, hypercore, retention policies all live under TSL. **Self-host = fine. Resell as managed DB = not fine.** Read `LICENSE-TIMESCALE` before commercializing.

## Decision Matrix

| Use case | Tool | Rationale |
|---|---|---|
| Append-mostly time-series < 100 GB | Native partitioning + pg_partman + pg_cron | No external extension; less operational surface |
| Append-mostly time-series ≥ 100 GB with mixed workload | Hypertable + retention + hypercore | Chunk pruning + columnar compression cut storage 10× and accelerate range scans |
| Frequent rollups (1h / 1d aggregates) over time-series | Continuous aggregate | Incremental refresh dramatically cheaper than scheduled `REFRESH MATERIALIZED VIEW` |
| Want vector embeddings alongside time-series | pgvector + hypertable | Composable — hypertable for storage, pgvector for similarity (cross-ref [94](./94-pgvector.md)) |
| Need sharding across nodes | Citus, not TimescaleDB | TimescaleDB single-node only since v2.14 (multi-node deprecated) |
| Need ON UPDATE triggers on compressed data | Don't compress that chunk yet | Compressed chunks have severe UPDATE restrictions |
| Need cross-database scheduled jobs | pg_cron, not timescaledb jobs | TimescaleDB scheduler runs per-database |
| Need real-time SUMs that include uncommitted-recent data | `timescaledb.materialized_only = false` | Re-enables real-time aggregation (default OFF since v2.13) |
| Want to migrate from native partitioning to hypertable | `create_hypertable(..., migrate_data => true)` | One-shot conversion; expect ACCESS EXCLUSIVE lock |
| Need ALTER on compressed chunk | Decompress → ALTER → recompress | Or use newer hypercore which relaxes some restrictions |
| Need GIST/GIN indexes on hypertable | Yes — same as regular tables | Indexes propagate to chunks automatically |
| Need RLS on chunks | Not in columnstore | "ROW LEVEL SECURITY is not supported on chunks in the columnstore" per hypercore docs |

Smell signals:

- **`DELETE FROM events WHERE ts < now() - INTERVAL '90 days'` in cron** — wrong tool. Use `add_retention_policy` to drop chunks.
- **`REFRESH MATERIALIZED VIEW` in cron over a hypertable** — wrong tool. Use continuous aggregate.
- **Compressed chunk + heavy UPDATEs on old data** — wrong shape. Time-series should be append-only or recent-only mutations.

## Syntax / Mechanics

### License Model

Two-license split, enforced by directory:

| Component | Location | License |
|---|---|---|
| Core extension framework | repo root, most files | **Apache 2.0** |
| Compression / hypercore | `/tsl/` | **Timescale License (TSL)** |
| Continuous aggregates | `/tsl/` | TSL |
| Data retention policies | `/tsl/` | TSL |
| Hypertables (basic create / insert / query) | mostly Apache 2.0 | Apache 2.0 |
| Multi-node (deprecated v2.14+) | was TSL | TSL |

TSL terms (from `LICENSE-TIMESCALE`):

- Cannot use TSL code to provide "time-sharing services or **database-as-a-service**" — the DBaaS clause
- Distribution must be unmodified binary
- Cannot sublicense (except to affiliates / contractors)
- "Customers of Value Added Products must be contractually and technically prevented from using Timescale Data Definition Interfaces" — i.e., can't expose `CREATE/ALTER/DROP` on TSL features to your customers

Practical reading: self-host = fine. Resell as your-branded managed DB = not fine. Always read `LICENSE-TIMESCALE` for current text.

### Hypertables

**Modern declarative syntax (v2.20+):**

```sql
CREATE TABLE conditions (
    time        TIMESTAMPTZ NOT NULL,
    device_id   INTEGER     NOT NULL,
    temperature DOUBLE PRECISION,
    humidity    DOUBLE PRECISION
) WITH (
    tsdb.hypertable,
    tsdb.partition_column = 'time',
    tsdb.chunk_interval = '1 day'
);
```

**Classic function syntax (still supported):**

```sql
CREATE TABLE conditions (
    time        TIMESTAMPTZ NOT NULL,
    device_id   INTEGER     NOT NULL,
    temperature DOUBLE PRECISION,
    humidity    DOUBLE PRECISION
);

SELECT create_hypertable('conditions', by_range('time', INTERVAL '1 day'));
```

**Full `create_hypertable()` signature (v2.13+ generalized form):**

```
create_hypertable(
    relation                REGCLASS,
    dimension               DIMENSION_INFO,
    migrate_data            BOOLEAN DEFAULT FALSE,
    if_not_exists           BOOLEAN DEFAULT FALSE,
    create_default_indexes  BOOLEAN DEFAULT TRUE
) RETURNS (hypertable_id INTEGER, created BOOLEAN)
```

Dimensions:

- `by_range(column, [interval])` — time-based chunking (most common)
- `by_hash(column, num_partitions)` — hash-based space partitioning
- Add more dimensions via `add_dimension()` after creation

**Restrictions:**

- Time column **must** be `NOT NULL`
- Cannot run on tables already partitioned via declarative partitioning or inheritance
- `migrate_data => true` takes ACCESS EXCLUSIVE during the migration scan
- Default indexes (one on time, one composite on space + time if multi-dim) auto-created unless `create_default_indexes => false`

**Inspect chunks:**

```sql
-- chunk inventory for a hypertable
SELECT
    show_chunks('conditions') AS chunk_name;

-- size + row counts per chunk
SELECT
    chunk_schema,
    chunk_name,
    pg_size_pretty(total_bytes) AS size,
    range_start, range_end
FROM chunks_detailed_size('conditions');

-- hypertable summary
SELECT * FROM hypertable_size('conditions');
```

### Hypercore (Columnar Compression)

**Concept:** Each chunk converts from row-oriented heap to columnar layout. Rows grouped into segments by `segmentby` column (typical: tenant_id, device_id), ordered within each segment by `orderby` (typical: time DESC). 90%+ compression typical on metrics workloads.

**Modern hypercore API (v2.18+, recommended):**

```sql
-- enable columnstore on the hypertable
ALTER TABLE conditions SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby = 'device_id',
    timescaledb.orderby = 'time DESC'
);

-- add automatic policy to convert chunks older than 7 days
SELECT add_columnstore_policy('conditions', INTERVAL '7 days');

-- manually convert a specific chunk
CALL convert_to_columnstore('_timescaledb_internal._hyper_1_42_chunk');

-- convert back (rare — usually for ALTER then re-convert)
CALL convert_to_rowstore('_timescaledb_internal._hyper_1_42_chunk');
```

**Classic compression API (v2.17.x and earlier, still supported per `add_compression_policy` docs):**

```sql
ALTER TABLE conditions SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('conditions', INTERVAL '7 days');
```

> [!NOTE] TimescaleDB v2.18.0
> `add_compression_policy()` is **deprecated** — superseded by `add_columnstore_policy()`. Classic compression APIs remain supported; verbatim docs note: "compression APIs are still supported, you do not need to migrate to the hypercore APIs."

**Inspect compression / hypercore state:**

```sql
-- per-chunk compression / columnstore status
SELECT * FROM chunk_columnstore_stats('conditions');

-- per-hypertable rollup
SELECT * FROM hypertable_columnstore_stats('conditions');

-- view settings
SELECT * FROM timescaledb_information.chunk_columnstore_settings
WHERE hypertable_name = 'conditions';
```

**Hypercore version-gating (verbatim from docs):**

- v2.23.0+ — automatic timestamp partitioning
- v2.20.0 – v2.22.1 — requires explicit `add_columnstore_policy()` call
- v2.19.3 and below — manual conversion via classic `add_compression_policy()`

**Restrictions on compressed / columnstore chunks:**

- `UPDATE` / `DELETE` slow path — row must be decompressed in-place
- Some `ALTER TABLE` operations blocked on compressed chunks (must decompress, alter, recompress)
- **ROW LEVEL SECURITY not supported on chunks in the columnstore** (verbatim)
- Foreign keys to compressed chunks have caveats — see hypercore docs

### Continuous Aggregates

**Concept:** A materialized view defined on a hypertable, automatically refreshed **incrementally** by a background job. Only new time buckets (or invalidated buckets when raw data changes) get re-aggregated.

**Create:**

```sql
CREATE MATERIALIZED VIEW conditions_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    device_id,
    AVG(temperature) AS avg_temp,
    MAX(temperature) AS max_temp,
    MIN(temperature) AS min_temp
FROM conditions
GROUP BY bucket, device_id
WITH NO DATA;
```

`WITH NO DATA` defers initial materialization. Use `WITH DATA` (default) to populate immediately — may take long on large hypertables.

**WITH options (verbatim from `create_materialized_view` docs):**

| Option | Type | Default |
|---|---|---|
| `timescaledb.continuous` | BOOLEAN | required |
| `timescaledb.chunk_interval` | INTERVAL | "10x the original hypertable" |
| `timescaledb.create_group_indexes` | BOOLEAN | TRUE |
| `timescaledb.materialized_only` | BOOLEAN | **TRUE** (real-time aggregation OFF) |

**Refresh policy:**

```sql
SELECT add_continuous_aggregate_policy(
    'conditions_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes'
);
```

Refreshes buckets between `[now() - 3 hours, now() - 1 hour]` every 30 minutes. `end_offset` exists to avoid refreshing in-progress buckets.

**Full `add_continuous_aggregate_policy()` signature:**

```
add_continuous_aggregate_policy(
    continuous_aggregate         REGCLASS,
    start_offset                 INTERVAL,
    end_offset                   INTERVAL,
    schedule_interval            INTERVAL,
    if_not_exists                BOOLEAN DEFAULT FALSE,
    initial_start                TIMESTAMPTZ,
    timezone                     TEXT,
    include_tiered_data          BOOLEAN,
    buckets_per_batch            INTEGER,
    max_batches_per_execution    INTEGER,
    refresh_newest_first         BOOLEAN
) RETURNS INTEGER  -- job_id
```

**Real-time aggregation (default OFF since v2.13):**

```sql
-- opt in: query union-of-materialized + raw-recent
ALTER MATERIALIZED VIEW conditions_hourly
SET (timescaledb.materialized_only = false);
```

When `materialized_only = false`, queries against the cagg union the materialized data with a real-time aggregation over the unrefreshed window — fresh data but slower queries.

**Manual refresh:**

```sql
CALL refresh_continuous_aggregate(
    'conditions_hourly',
    start_window => '2026-05-01'::timestamptz,
    end_window   => '2026-05-14'::timestamptz
);
```

**Hierarchical aggregates (cagg-on-cagg):**

```sql
-- daily rollup built on the hourly rollup
CREATE MATERIALIZED VIEW conditions_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', bucket) AS bucket_day,
    device_id,
    AVG(avg_temp) AS avg_temp
FROM conditions_hourly
GROUP BY bucket_day, device_id;
```

Recursive rollups are cheap because the cagg engine only re-aggregates changed input buckets.

### Data Retention

**Concept:** Drop entire chunks older than threshold via background job. Whole-table `DROP` — no row scan, no autovacuum aftermath.

**Add policy:**

```sql
SELECT add_retention_policy('conditions', INTERVAL '90 days');
```

Background job runs daily by default, drops chunks whose `range_end < now() - 90 days`.

**Full `add_retention_policy()` signature:**

```
add_retention_policy(
    relation             REGCLASS,
    drop_after           INTERVAL | INTEGER,
    if_not_exists        BOOLEAN,
    schedule_interval    INTERVAL,
    initial_start        TIMESTAMPTZ,
    timezone             TEXT,
    drop_created_before  INTERVAL
) RETURNS INTEGER  -- job_id
```

Restrictions (verbatim):

- "Only one retention policy may exist per hypertable"
- `drop_created_before` "Not supported for continuous aggregates yet"
- For integer time columns must set `integer_now_func` so the policy knows current value
- Must specify either `drop_after` OR `drop_created_before` (mutually exclusive)

**Manual chunk drop:**

```sql
SELECT drop_chunks(
    'conditions',
    older_than => INTERVAL '180 days'
);
```

`drop_chunks()` returns TEXT for each dropped chunk: `_timescaledb_internal._hyper_X_Y_chunk`.

**Retention + continuous aggregate downsampling pattern:**

```sql
-- raw events: keep 30 days
SELECT add_retention_policy('conditions', INTERVAL '30 days');

-- hourly rollup: keep 2 years
SELECT add_retention_policy('conditions_hourly', INTERVAL '2 years');

-- daily rollup: keep forever (no policy)
```

Per verbatim docs: "By combining retention policies with continuous aggregates, you can downsample your data and keep useful summaries of it instead." This is the canonical TimescaleDB pattern — raw recent + aggregated historical.

### Job Scheduler

**Concept:** Built-in cron-like scheduler running as Postgres background workers. Used internally for compression / retention / cagg refresh policies. Also exposed for user jobs.

**Add custom job:**

```sql
CREATE OR REPLACE PROCEDURE my_maintenance(job_id INT, config JSONB) AS $$
BEGIN
    -- arbitrary maintenance work
    REFRESH MATERIALIZED VIEW CONCURRENTLY some_view;
END;
$$ LANGUAGE plpgsql;

SELECT add_job(
    'my_maintenance',
    schedule_interval => INTERVAL '1 hour'
);
```

**Full `add_job()` signature:**

```
add_job(
    proc              REGPROC,
    schedule_interval INTERVAL DEFAULT '24 hours',
    config            JSONB,
    initial_start     TIMESTAMPTZ,
    scheduled         BOOLEAN DEFAULT TRUE,
    check_config      REGPROC,
    fixed_schedule    BOOLEAN DEFAULT TRUE,
    timezone          TEXT,
    job_name          TEXT
) RETURNS INTEGER  -- job_id
```

**Inspect jobs:**

```sql
-- all scheduled jobs (user + internal)
SELECT job_id, application_name, schedule_interval, scheduled, next_start
FROM timescaledb_information.jobs;

-- recent runs + outcomes
SELECT job_id, last_run_started_at, last_run_status, last_run_duration
FROM timescaledb_information.job_stats
ORDER BY last_run_started_at DESC;

-- run history (success / failure detail)
SELECT * FROM timescaledb_information.job_errors
ORDER BY finish_time DESC LIMIT 10;
```

**Modify / disable / delete:**

```sql
SELECT alter_job(<job_id>, scheduled => false);  -- pause
SELECT alter_job(<job_id>, schedule_interval => INTERVAL '15 minutes');
CALL run_job(<job_id>);                          -- fire immediately
SELECT delete_job(<job_id>);                     -- remove
```

`run_job()` is a stored procedure — must use `CALL`, not `SELECT`.

**Per-database scheduler:** Each database has its own scheduler. To run jobs in a database you must `CREATE EXTENSION timescaledb` there. **No cross-database scheduling** — use [`pg_cron`](./98-pg-cron.md) for that.

### Hypertable vs Native Partitioning

| Property | Hypertable | Native partitioning |
|---|---|---|
| Time-bucket chunking | Automatic via `chunk_interval` | Manual `CREATE TABLE ... PARTITION OF` per partition |
| Partition creation | Automatic on first INSERT into new bucket | Must pre-create or use [`pg_partman`](./99-pg-partman.md) |
| Partition pruning | Yes (built-in plus chunk exclusion) | Yes (declarative pruning, PG12+) |
| Compression | Hypercore (columnar) per-chunk | Per-table only (no built-in columnar) |
| Continuous aggregates | First-class | Manual `REFRESH MATERIALIZED VIEW` |
| Retention | `add_retention_policy()` | Manual `DROP TABLE` or pg_partman retention |
| Scheduler | Built-in jobs | pg_cron or external |
| Operational overhead | Extension to install + maintain | Core Postgres only |
| License | Apache 2.0 + TSL split | All Apache 2.0 |

**Decision:** under ~100 GB and append-only with simple retention — native + pg_partman + pg_cron sufficient. Above that or with rollups + compression needs — TimescaleDB pays for itself.

### Per-Version Timeline

**TimescaleDB releases (the canonical timeline — PG14/15/16/17/18 release notes contain ZERO TimescaleDB items):**

| TimescaleDB version | Date | Highlights |
|---|---|---|
| 2.13 | 2023-11 | Generalized `create_hypertable()` API with `dimension DIMENSION_INFO`; real-time aggregation **disabled by default** |
| 2.14 | 2024-01 | Multi-node deprecated; single-node focus |
| 2.17 | 2024-09 | PG15+ `enable_merge_on_cagg_refresh` |
| 2.18 | 2024-11 | **Hypercore introduced**; `add_compression_policy` deprecated in favor of `add_columnstore_policy` |
| 2.19 | 2025-01 | Last version supporting manual hypercore conversion path only |
| 2.20 | 2025-02 | `CREATE TABLE ... WITH (tsdb.hypertable, ...)` declarative syntax; automatic `add_columnstore_policy` |
| 2.23 | 2025-07 | Hypercore automatic timestamp partitioning |
| 2.26 | 2026-03 | PG18 support added |
| 2.27.0 | 2026-05-12 | Latest stable at planning time. Supports PG **15, 16, 17, 18**. PG14 already dropped |
| Next (June 2026) | 2026-06 | Per official notice: "last version with support for PostgreSQL 15" |

PostgreSQL release notes: **PG14, PG15, PG16, PG17, PG18** all contain ZERO TimescaleDB items. TimescaleDB is wholly external.

> [!WARNING] PG15 support ends with the June 2026 TimescaleDB release
> Tiger Data has announced: "the upcoming TimescaleDB release in June 2026 will officially be the last version with support for PostgreSQL 15." If you're on PG15 + TimescaleDB and plan to stay on the latest extension version, schedule a PG16+ upgrade. Cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) for upgrade strategy.

## Examples / Recipes

**1 — Baseline hypertable with retention + columnar compression**

```sql
-- 1. extension + table
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE metrics (
    time       TIMESTAMPTZ      NOT NULL,
    device_id  INTEGER          NOT NULL,
    metric     TEXT             NOT NULL,
    value      DOUBLE PRECISION NOT NULL
);

-- 2. hypertable, 1-day chunks
SELECT create_hypertable('metrics', by_range('time', INTERVAL '1 day'));

-- 3. enable columnstore + segmentby for typical query shape
ALTER TABLE metrics SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby = 'device_id',
    timescaledb.orderby = 'time DESC'
);

-- 4. compress chunks older than 7 days
SELECT add_columnstore_policy('metrics', INTERVAL '7 days');

-- 5. drop chunks older than 90 days
SELECT add_retention_policy('metrics', INTERVAL '90 days');

-- 6. verify policies
SELECT job_id, application_name, schedule_interval, scheduled
FROM timescaledb_information.jobs
WHERE hypertable_name = 'metrics';
```

**2 — Hourly + daily continuous aggregate (downsampling pattern)**

```sql
-- hourly rollup, real-time aggregation OFF (default since v2.13)
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    device_id,
    metric,
    AVG(value)  AS avg_value,
    MAX(value)  AS max_value,
    MIN(value)  AS min_value,
    COUNT(*)    AS sample_count
FROM metrics
GROUP BY bucket, device_id, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset      => INTERVAL '6 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');

-- daily rollup built on hourly
CREATE MATERIALIZED VIEW metrics_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', bucket) AS day,
    device_id,
    metric,
    AVG(avg_value) AS avg_value,
    MAX(max_value) AS max_value,
    MIN(min_value) AS min_value
FROM metrics_hourly
GROUP BY day, device_id, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_daily',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');

-- retention: keep raw 30d, hourly 2y, daily forever
SELECT add_retention_policy('metrics',        INTERVAL '30 days');
SELECT add_retention_policy('metrics_hourly', INTERVAL '2 years');
-- (no retention on metrics_daily — keep forever)
```

**3 — Enable real-time aggregation for live dashboards**

```sql
ALTER MATERIALIZED VIEW metrics_hourly
SET (timescaledb.materialized_only = false);

-- now queries include both materialized + raw-recent
SELECT bucket, AVG(avg_value)
FROM metrics_hourly
WHERE bucket > now() - INTERVAL '6 hours'
GROUP BY bucket
ORDER BY bucket;
```

Trade-off: queries slower (must do real-time agg over unrefreshed window) but reflect very recent inserts.

**4 — Migrate existing time-series table to hypertable**

```sql
-- existing table with ~50M rows, ts column already indexed
-- the migrate_data flag rewrites data into chunks
SELECT create_hypertable(
    'events',
    by_range('ts', INTERVAL '1 day'),
    migrate_data => true
);
```

Takes ACCESS EXCLUSIVE during migration. For large tables consider:

- Chunked migration via dump-reload into a fresh hypertable
- Or use logical replication target as fresh hypertable (cross-ref [`74-logical-replication.md`](./74-logical-replication.md))

**5 — Audit + inspect every hypertable in cluster**

```sql
SELECT
    hypertable_schema || '.' || hypertable_name AS hypertable,
    pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) AS total,
    num_chunks,
    compression_enabled
FROM timescaledb_information.hypertables;

-- per-chunk size + compression state for one hypertable
SELECT
    chunk_name,
    pg_size_pretty(before_compression_total_bytes) AS uncompressed,
    pg_size_pretty(after_compression_total_bytes)  AS compressed,
    ROUND(100.0 * (1 - after_compression_total_bytes::numeric / NULLIF(before_compression_total_bytes, 0)), 1) AS compression_pct
FROM chunk_compression_stats('metrics')
ORDER BY chunk_name;
```

**6 — Manually compress / decompress a specific chunk**

```sql
-- find the chunk
SELECT show_chunks('metrics', older_than => INTERVAL '7 days');

-- modern hypercore API
CALL convert_to_columnstore('_timescaledb_internal._hyper_1_42_chunk');

-- emergency UPDATE on old data: decompress, edit, recompress
CALL convert_to_rowstore('_timescaledb_internal._hyper_1_42_chunk');
UPDATE metrics SET value = 99 WHERE time = '2026-01-15' AND device_id = 7;
CALL convert_to_columnstore('_timescaledb_internal._hyper_1_42_chunk');
```

**7 — Custom maintenance job via scheduler**

```sql
CREATE OR REPLACE PROCEDURE refresh_summaries(job_id INT, config JSONB) AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY non_timescale_summary;
END;
$$ LANGUAGE plpgsql;

-- run every 4 hours
SELECT add_job('refresh_summaries', schedule_interval => INTERVAL '4 hours');

-- inspect
SELECT job_id, last_run_started_at, last_run_status, last_run_duration
FROM timescaledb_information.job_stats
WHERE application_name LIKE '%refresh_summaries%';
```

**8 — Pause all maintenance during a release window**

```sql
-- pause every TimescaleDB job
UPDATE _timescaledb_config.bgw_job SET scheduled = false;

-- ... run release ...

-- resume
UPDATE _timescaledb_config.bgw_job SET scheduled = true;
```

Or per-job: `SELECT alter_job(<id>, scheduled => false);`

**9 — Inspect cagg refresh state + stale buckets**

```sql
-- cagg metadata
SELECT
    view_name,
    materialization_hypertable_schema || '.' || materialization_hypertable_name AS materialization_table,
    materialized_only,
    finalized
FROM timescaledb_information.continuous_aggregates;

-- check what windows have been refreshed
SELECT
    view_name,
    completed_threshold,
    invalidation_threshold
FROM _timescaledb_catalog.continuous_aggs_invalidation_threshold
JOIN timescaledb_information.continuous_aggregates USING (mat_hypertable_id);
```

**10 — Bound chunk count for memory pressure**

```sql
-- count chunks per hypertable
SELECT hypertable_name, COUNT(*) AS chunk_count
FROM timescaledb_information.chunks
GROUP BY hypertable_name
ORDER BY chunk_count DESC;
```

Too many chunks (thousands) → planner overhead. Tune `chunk_interval` larger. Rule of thumb: aim for chunks of 25-100% of `shared_buffers` so the most-recent chunk fits in cache.

**11 — pre-PG-upgrade audit: extension binary on target cluster**

```sh
# on the new cluster's host
psql -c "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'timescaledb';"

# verify in shared_preload_libraries on new cluster
psql -c "SHOW shared_preload_libraries;"

# read pg_upgrade timescaledb-specific notes (often required pre-upgrade steps)
# see https://docs.tigerdata.com (latest pg_upgrade guidance)
```

Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md) — TimescaleDB requires same major version on both clusters and may require specific pg_upgrade steps that change between versions.

**12 — Diagnose slow job execution**

```sql
-- jobs with longest recent run
SELECT
    job_id, application_name,
    last_run_duration,
    last_run_status
FROM timescaledb_information.job_stats
WHERE last_run_duration IS NOT NULL
ORDER BY last_run_duration DESC
LIMIT 10;

-- error history
SELECT job_id, finish_time, sqlerrcode, err_message
FROM timescaledb_information.job_errors
ORDER BY finish_time DESC LIMIT 20;
```

Long-running cagg refresh → split into smaller `buckets_per_batch`. Long retention → too many chunks at once, drop manually via `drop_chunks` in batches.

**13 — Convert from native partitioning to hypertable**

```sql
-- starting point: events table with declarative partitioning by week
-- cannot create_hypertable on declaratively-partitioned table — must rebuild

-- 1. create fresh hypertable
CREATE TABLE events_new (LIKE events INCLUDING ALL);
SELECT create_hypertable('events_new', by_range('ts', INTERVAL '1 day'));

-- 2. copy data
INSERT INTO events_new SELECT * FROM events;

-- 3. swap names (brief ACCESS EXCLUSIVE)
BEGIN;
ALTER TABLE events RENAME TO events_old;
ALTER TABLE events_new RENAME TO events;
COMMIT;

-- 4. drop old after verification
DROP TABLE events_old;
```

Use logical replication for zero-downtime variant (cross-ref [`74-logical-replication.md`](./74-logical-replication.md)).

## Gotchas / Anti-patterns

1. **`DELETE FROM hypertable WHERE ts < ...` for retention** — wrong tool. Triggers full row scan + autovacuum amplification. Use `add_retention_policy()` or `drop_chunks()` to drop whole chunks.

2. **`REFRESH MATERIALIZED VIEW` on a continuous aggregate** — doesn't work. The cagg is materialized incrementally. Use `CALL refresh_continuous_aggregate(...)` or rely on the refresh policy.

3. **Real-time aggregation expectation (default OFF since v2.13)** — code written against pre-2.13 TimescaleDB will see stale-cagg data after upgrade. Either accept materialized-only behavior or `ALTER MATERIALIZED VIEW ... SET (timescaledb.materialized_only = false)`.

4. **`add_compression_policy` on v2.18+ deprecated but silently still works** — old code keeps running. Migrate to `add_columnstore_policy` opportunistically. Docs explicit: classic APIs not going away.

5. **ROW LEVEL SECURITY on columnstore chunks not supported** (verbatim from hypercore docs). RLS on the parent hypertable applies only to row-store chunks. Forces a choice: RLS or columnstore, not both.

6. **PG14 dropped, PG15 deprecated** — TimescaleDB v2.27.0 supports PG15-18; PG15 support ends with June 2026 release. Plan PG16+ upgrade before that window.

7. **`UPDATE` / `DELETE` on compressed chunk is slow path** — must decompress affected rows in place. Time-series workload should be append-only or recent-only mutations.

8. **`create_hypertable(migrate_data => true)` takes ACCESS EXCLUSIVE** for the full migration scan. Bad for large existing tables on hot systems. Use logical replication or chunked dump/load for zero-downtime variant.

9. **Per-database scheduler, not per-cluster** — TimescaleDB jobs run in the database where you ran `CREATE EXTENSION`. Cross-database scheduling not supported; use [`pg_cron`](./98-pg-cron.md).

10. **Scheduler runs on the writable primary only** — at HA failover, the new primary's scheduler picks up. If your failover process doesn't re-enable `shared_preload_libraries = 'timescaledb'` on the standby, jobs simply don't run. Cross-reference [`90-disaster-recovery.md`](./90-disaster-recovery.md).

11. **Chunk count explosion → planner overhead** — too-small `chunk_interval` produces thousands of chunks. Planner has to consider each for partition pruning. Aim for 100s not 1000s. Rule of thumb: chunk size 25-100% of `shared_buffers`.

12. **`integer_now_func` required for integer time columns** — retention + caggs on hypertables with INTEGER time column need a function that returns "current time" as INTEGER. Failure to set produces silently-broken retention.

13. **Only one retention policy per hypertable** (verbatim from docs). Cannot have two with different drop_after values.

14. **`drop_created_before` not supported for continuous aggregates yet** (verbatim from docs). Caggs only support `drop_after`.

15. **`hypertable_name` argument is REGCLASS — schema-qualified or in search_path** — bare `'metrics'` resolves via search_path. Cross-schema scripts should use schema-qualified form: `'reporting.metrics'::regclass`.

16. **Compressed chunk + ALTER TABLE blocked for many DDLs** — must decompress chunk, alter, recompress. Add columns / drop columns on a heavily-compressed hypertable is operationally expensive.

17. **Hypercore newer than UPDATE-friendly classic compression in some ways** — hypercore relaxes some restrictions but doesn't eliminate them. Verify against your TimescaleDB version's hypercore restrictions list.

18. **Cagg-on-cagg invalidation propagates** — invalidating a raw chunk invalidates the hourly cagg's affected buckets, which invalidates the daily cagg's affected buckets. Three levels of refresh per write to ancient data.

19. **TimescaleDB version must match across replication primary + standby** — physical streaming replication requires byte-identical extension binaries. Logical replication doesn't (since logical applies SQL).

20. **`CREATE EXTENSION timescaledb` requires superuser** in most setups — extensions modifying system catalogs need superuser. Managed providers may require contacting support for upgrade.

21. **`shared_preload_libraries = 'timescaledb'` requires server restart** — not a reload. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) gotcha #4.

22. **License-DBaaS clause** — running TimescaleDB-with-TSL-features as your-branded managed Postgres is contractually prohibited without Tiger Data agreement. Self-hosting and using internally is fine.

23. **Distributed hypertables (multi-node) deprecated in v2.14** — if you need sharding across nodes, use [`97-citus.md`](./97-citus.md) instead. TimescaleDB is single-node only going forward.

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM on hypertables (each chunk vacuums independently)
- [`33-wal.md`](./33-wal.md) — WAL pressure from time-series inserts
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint tuning for write-heavy workloads
- [`35-partitioning.md`](./35-partitioning.md) — native declarative partitioning, the alternative without TimescaleDB
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries` mechanics
- [`54-memory-tuning.md`](./54-memory-tuning.md) — chunk-size sizing relative to `shared_buffers`
- [`56-explain.md`](./56-explain.md) — reading plans with chunk exclusion
- [`69-extensions.md`](./69-extensions.md) — CREATE EXTENSION + version management
- [`74-logical-replication.md`](./74-logical-replication.md) — zero-downtime hypertable migration
- [`82-monitoring.md`](./82-monitoring.md) — Prometheus exporter integration
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — pg_upgrade with extensions on target cluster
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — PG15-to-PG16+ migration deadline
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — scheduler behavior at failover
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — TimescaleDB inside operators
- [`94-pgvector.md`](./94-pgvector.md) — vector embeddings alongside time-series
- [`95-postgis.md`](./95-postgis.md) — geospatial + time-series IoT overlap (GPS tracks, sensor locations)
- [`97-citus.md`](./97-citus.md) — sharded Postgres (different problem, not interchangeable)
- [`98-pg-cron.md`](./98-pg-cron.md) — cross-database scheduling
- [`99-pg-partman.md`](./99-pg-partman.md) — partition lifecycle without TimescaleDB
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version context; TimescaleDB evolves on its own cadence outside PG14-18 release notes
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — extension allowlist concerns

## Sources

[^1]: timescale/timescaledb GitHub repo (README + release index). Retrieved 2026-05-14. <https://github.com/timescale/timescaledb>
[^2]: Tiger Data documentation home. Retrieved 2026-05-14. <https://docs.tigerdata.com/>
[^3]: Hypertables overview. Retrieved 2026-05-14. <https://docs.tigerdata.com/use-timescale/latest/hypertables/>
[^4]: Compression overview (now redirects to GitHub markdown source). Retrieved 2026-05-14. <https://docs.tigerdata.com/use-timescale/latest/compression/>
[^5]: Continuous aggregates overview. Retrieved 2026-05-14. <https://docs.tigerdata.com/use-timescale/latest/continuous-aggregates/>
[^6]: Data retention overview. Retrieved 2026-05-14. <https://docs.tigerdata.com/use-timescale/latest/data-retention/>
[^7]: TimescaleDB releases page (v2.27.0, 2026-05-12). Retrieved 2026-05-14. <https://github.com/timescale/timescaledb/releases>
[^8]: Timescale License (TSL) text — DBaaS prohibition + value-added-product clause. Retrieved 2026-05-14. <https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE>
[^9]: Apache 2.0 license (core / community parts). Retrieved 2026-05-14. <https://github.com/timescale/timescaledb/blob/main/LICENSE-APACHE>
[^10]: `create_hypertable` function reference (v2.13+ generalized form). Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/hypertable/create_hypertable>
[^11]: `drop_chunks` function reference. Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks>
[^12]: `add_retention_policy` function reference. Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/data-retention/add_retention_policy>
[^13]: `add_compression_policy` function reference (deprecated v2.18+, still supported). Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/compression/add_compression_policy>
[^14]: `add_continuous_aggregate_policy` function reference. Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_continuous_aggregate_policy>
[^15]: Hypercore API index — version-gating per release. Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/hypercore>
[^16]: Jobs-automation API (renamed from `jobs`). Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/jobs-automation>
[^17]: `create_materialized_view` (continuous aggregate creation). Retrieved 2026-05-14. <https://www.tigerdata.com/docs/api/latest/continuous-aggregates/create_materialized_view>
[^18]: PostgreSQL 14 release notes — verified zero TimescaleDB items. Retrieved 2026-05-14. <https://www.postgresql.org/docs/14/release-14.html>
[^19]: PostgreSQL 15 release notes — verified zero TimescaleDB items. Retrieved 2026-05-14. <https://www.postgresql.org/docs/15/release-15.html>
[^20]: PostgreSQL 16 release notes — verified zero TimescaleDB items. Retrieved 2026-05-14. <https://www.postgresql.org/docs/16/release-16.html>
[^21]: PostgreSQL 17 release notes — verified zero TimescaleDB items. Retrieved 2026-05-14. <https://www.postgresql.org/docs/17/release-17.html>
[^22]: PostgreSQL 18 release notes — verified zero TimescaleDB items. Retrieved 2026-05-14. <https://www.postgresql.org/docs/18/release-18.html>

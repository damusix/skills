# Monitoring

Comprehensive monitoring stack for PostgreSQL: Prometheus + `postgres_exporter` + `pgbouncer_exporter` + Grafana, key metrics by four-tier framework (workload / efficiency / saturation / capacity), log-based metrics via `auto_explain` + structured logging, alerting thresholds + sampling strategies. Covers PostgreSQL 14-18 with explicit version-introduced view + column annotations.

> [!WARNING] PG17 + PG18 silently break PG16-era monitoring queries
> Three discrete upgrade traps: (1) **PG17 split `pg_stat_bgwriter` → `pg_stat_checkpointer`** — `buffers_backend` + `buffers_backend_fsync` removed; queries return NULL silently. (2) **PG17 renamed `pg_stat_progress_vacuum` columns** — `max_dead_tuples` → `max_dead_tuple_bytes`, `num_dead_tuples` → `num_dead_item_ids`. (3) **PG18 removed `pg_stat_io.op_bytes`** (always equaled `BLCKSZ`) — replaced with `read_bytes` / `write_bytes` / `extend_bytes`. Plus PG18 relocated WAL I/O timing from `pg_stat_wal` to `pg_stat_io` (removed `wal_write` / `wal_sync` / `wal_write_time` / `wal_sync_time` columns). Audit dashboards before upgrade.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — Five Rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Four-Tier Monitoring Framework](#four-tier-monitoring-framework)
    - [Monitoring Stack Catalog](#monitoring-stack-catalog)
    - [postgres_exporter](#postgres_exporter)
    - [pgbouncer_exporter](#pgbouncer_exporter)
    - [Log-Based Metrics](#log-based-metrics)
    - [auto_explain](#auto_explain)
    - [pg_stat_* View Inventory](#pg_stat_-view-inventory)
    - [Alerting Thresholds](#alerting-thresholds)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick this file when:

- Building Prometheus + Grafana monitoring stack for PostgreSQL fleet
- Choosing between `postgres_exporter` / `pgwatch` / `pgmonitor` / `pgmetrics` / `pg_activity` / `pganalyze`
- Configuring `pgbouncer_exporter` to scrape pgBouncer console
- Setting alerting thresholds per workload tier
- Auditing existing monitoring queries before PG14 → PG18 upgrade
- Designing log-based metrics complementing counter-based `pg_stat_*` views
- Tuning `auto_explain` for production slow-query capture

For per-view deep dives see [`58-performance-diagnostics.md`](./58-performance-diagnostics.md). For pg_stat_statements specifics see [`57-pg-stat-statements.md`](./57-pg-stat-statements.md). For pgBouncer console commands see [`81-pgbouncer.md`](./81-pgbouncer.md).

## Mental Model — Five Rules

1. **Four-tier framework — workload / efficiency / saturation / capacity.** Workload = QPS, transaction mix, query latency distribution. Efficiency = cache hit ratio, plan quality, autovacuum effectiveness. Saturation = connections, CPU, I/O wait, lock waits, replication lag. Capacity = disk usage, WAL retention, partition count, slot retention. Each tier needs separate dashboards + separate alert thresholds.

2. **`postgres_exporter` is canonical Prometheus exporter.** Supplements `pg_stat_*` views with derived metrics (cache hit ratio computed as `blks_hit / (blks_hit + blks_read)`, replication lag bytes, table bloat estimates). Supports custom queries via `queries.yaml` for workload-specific metrics. Default-enabled collectors: database, locks, replication, replication_slot, stat_bgwriter, stat_database, stat_progress_vacuum, stat_user_tables, statio_user_tables, wal[^postgres-exporter].

3. **`pgbouncer_exporter` consumes pgBouncer console.** Translates `SHOW STATS` / `SHOW POOLS` / `SHOW CONFIG` / `SHOW DATABASES` / `SHOW LISTS` to Prometheus metrics. Pool saturation = `cl_waiting > 0 sustained` + `maxwait > 5s` — cross-reference [`81-pgbouncer.md`](./81-pgbouncer.md) Recipe 4.

4. **Log-based metrics complement counter-based.** Counters miss: slow-query rate distribution, deadlock count, autovacuum cancellations, connection-rejected count, error-rate by SQLSTATE. Ship Postgres logs to Loki / Elasticsearch / Splunk + extract metrics via log parsing. `log_destination = jsonlog` (PG15+) makes parsing tractable.

5. **Alerting thresholds workload-specific, not universal.** "Good" cache hit ratio depends on working-set-vs-RAM ratio. OLTP cluster with 95% hit = warning; analytics cluster with 95% hit = healthy. Same metric different thresholds. Set thresholds per role (webapp / reporter / batchjobs) or per database, not cluster-wide.

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Prometheus exporter for PostgreSQL | `postgres_exporter` v0.19+ (prometheus-community) | Per-cloud-provider exporters | Canonical, well-maintained, vendor-agnostic |
| Prometheus exporter for pgBouncer | `pgbouncer_exporter` v0.11+ | Custom scrapers of pgBouncer console | Same project family, consistent metric naming |
| One-shot snapshot for diagnostics | `pgmetrics` (350+ metrics, single binary, no extension required) | Cron-curling exporter | Designed for ad-hoc scripting / troubleshooting[^pgmetrics] |
| Real-time `top`-style CLI | `pg_activity` (Dalibo, htop-style) | Hand-rolled `watch pg_stat_activity` | Per-query, per-DB filtering, keyboard navigation[^pg_activity] |
| Full monitoring stack (exporter + dashboards + alerts) | `pgwatch` v5+ (Cybertec, agentless) OR `pgmonitor` v5+ (Crunchy/Snowflake) | Hand-rolled Prometheus + Grafana from scratch | Ship-with-dashboards, opinionated alert rules[^pgwatch][^pgmonitor] |
| Log-based slow-query capture | `auto_explain` (in-core) | Application-side query log scraping | Server-side captures actual production plans + parameters[^auto-explain] |
| Vendor-managed monitoring SaaS | Provider-agnostic — pick what fits | Provider-locked monitoring | Skill stays neutral; evaluate by ops requirements |
| Structured Postgres logs for ingestion | `log_destination = 'stderr,jsonlog'` PG15+ | CSV format alone | JSON parsable by Loki / Splunk / Elasticsearch without regex |
| Per-query observability | `pg_stat_statements` + auto_explain | `pg_stat_activity` polling | Stat_statements normalizes queries; activity gives one-shot snapshot |
| Replication lag alerting | Prometheus rule on `pg_replication_slot_wal_*` + `pg_stat_replication.replay_lag` | Cron polling lag query | Threshold-based alerting needs sliding window |
| Capacity tracking — disk / WAL / slot retention | `pg_database_size` + `pg_replication_slots` + `pg_wal` directory size | DBA inbox via cron email | Trend lines + projections beat one-shot snapshots |

**Three smell signals:**

1. Cardinality explosion in Prometheus — `pg_stat_statements`-per-queryid metrics with 10k+ unique queries = exporter scrape time > 30s, breaks Prometheus rule eval. Sample top-N by `total_exec_time` instead.
2. Cache hit ratio alert firing constantly — threshold wrong for workload. Reporting cluster with 100GB working set on 32GB RAM cannot hit 99% — alert mis-set, not "broken" cluster.
3. Pagerduty floods for `idle_in_transaction` — symptom is real (cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) Gotcha #2) but **noise filter via `state_change > 1 minute`** instead of any-idle-in-tx triggers.

## Syntax / Mechanics

### Four-Tier Monitoring Framework

Each tier collects different metrics with different sample rates + alert horizons. Dashboards organized by tier prevent the "100-graph wall" anti-pattern.

| Tier | What it measures | Source views | Sample rate | Alert horizon |
|---|---|---|---|---|
| **Workload** | QPS, query mix, transaction rate, p50/p95/p99 latency | `pg_stat_statements`, `pg_stat_database`, `pg_stat_user_tables` | 15s-60s | Hours |
| **Efficiency** | Cache hit ratio, autovacuum effectiveness, plan quality, JIT compilation overhead | `pg_statio_user_tables`, `pg_stat_user_tables`, `pg_stat_statements`, `pg_stat_wal` | 60s | Hours-days |
| **Saturation** | Connection pool waits, CPU, I/O wait, lock waits, replication lag, autovacuum lag, deadlocks | `pg_stat_activity`, `pg_locks`, `pg_stat_replication`, `pg_stat_io`, OS metrics | 5s-15s | Minutes |
| **Capacity** | Disk usage, WAL retention, slot retention, partition count, XID wraparound risk, max_connections headroom | `pg_database_size`, `pg_replication_slots`, `pg_database.datfrozenxid`, disk metrics | 1min-5min | Days-weeks |

### Monitoring Stack Catalog

| Tool | Type | Latest version | Maintained by | Notes |
|---|---|---|---|---|
| **postgres_exporter** | Prometheus exporter (server-side daemon) | v0.19.1 (2026-02-25) | prometheus-community | Canonical PG → Prometheus[^postgres-exporter] |
| **pgbouncer_exporter** | Prometheus exporter for pgBouncer console | v0.11.0+ | prometheus-community | Scrapes `SHOW STATS` / `SHOW POOLS`[^pgbouncer-exporter] |
| **pgwatch** | Full monitoring stack (collector + dashboards) | v5.2.0 (2026-05-04) | Cybertec | Agentless, Grafana dashboards included, supports many backends[^pgwatch] |
| **pgmonitor** | Full monitoring stack (Prometheus + Grafana + alert rules) | v5.3.0 (2025-07-10) | Crunchy Data (now Snowflake)[^pgmonitor-copyright] | Opinionated dashboards + alert rules, copyright transferred 2025-2026[^pgmonitor] |
| **pgmetrics** | One-shot snapshot tool | v1.19.0 (2026-01-18) | RapidLoop | Single binary, 350+ metrics, text/JSON/CSV output, no PG extension needed[^pgmetrics] |
| **pg_activity** | Real-time `top`-style CLI | v3.6.1 (2025-06-03) | Dalibo | Htop-style query monitoring, per-query filtering[^pg_activity] |
| **auto_explain** | In-core slow-query logger | Built-in | PostgreSQL project | Server-side EXPLAIN plan capture for slow queries[^auto-explain] |
| **pganalyze** | Vendor SaaS — query plans + log insights + index advisor | N/A | pganalyze.com | Log-based metrics require syslog export[^pganalyze] |

> [!NOTE] PostgreSQL 15
> `pgwatch` versioning naming has progressed beyond the planning-note "pgwatch3" assumption — current is **v5.2.0**. Cite by URL not chapter version.

> [!NOTE] PostgreSQL 18+
> Percona Toolkit (`pt-pg-summary`) does NOT exist — Percona Toolkit is MySQL-focused. Do not reference for PG diagnostics; use `pgmetrics` or `pg_activity` instead.

### postgres_exporter

Canonical Prometheus exporter. Connects to PG cluster via libpq, scrapes `pg_stat_*` views, exposes `/metrics` endpoint for Prometheus pull. Run as sidecar (one exporter per PG cluster) or centralized (one exporter polls many clusters via `DATA_SOURCE_NAME` env).

**Default-enabled collectors:**

| Collector | Source view(s) | Why default |
|---|---|---|
| `database` | `pg_database_size` per database | Capacity-tier baseline |
| `locks` | `pg_locks` counts by mode | Saturation-tier baseline |
| `replication` | `pg_stat_replication`, `pg_stat_wal_receiver` | Saturation + capacity |
| `replication_slot` | `pg_replication_slots` | Capacity — WAL retention |
| `stat_bgwriter` (PG≤16) / `stat_checkpointer` (PG17+) | bgwriter + checkpointer stats | Efficiency — write pressure |
| `stat_database` | `pg_stat_database` | Workload + efficiency |
| `stat_progress_vacuum` | `pg_stat_progress_vacuum` | Saturation — vacuum-in-flight |
| `stat_user_tables` | `pg_stat_user_tables` | Workload + efficiency per-table |
| `statio_user_tables` | `pg_statio_user_tables` | Efficiency — cache hit per-table |
| `wal` | `pg_stat_wal` | Workload + capacity |

**Custom queries via `queries.yaml`** for metrics not exposed by default. Example for tracking longest-running transaction:

```yaml
# /etc/postgres_exporter/queries.yaml
pg_long_transactions:
  query: |
    SELECT
      EXTRACT(EPOCH FROM (now() - xact_start))::bigint AS duration_seconds,
      state,
      backend_type
    FROM pg_stat_activity
    WHERE xact_start IS NOT NULL
      AND backend_type = 'client backend'
    ORDER BY xact_start
    LIMIT 1
  metrics:
    - duration_seconds:
        usage: GAUGE
        description: "Longest-running transaction duration in seconds"
    - state:
        usage: LABEL
    - backend_type:
        usage: LABEL
```

Run as: `postgres_exporter --extend.query-path=/etc/postgres_exporter/queries.yaml`[^postgres-exporter-custom].

**Auth pattern (production):** dedicated monitoring role with `pg_monitor` predefined role grant.

```sql
CREATE ROLE postgres_exporter LOGIN PASSWORD '...';
GRANT pg_monitor TO postgres_exporter;
-- pg_monitor includes pg_read_all_settings + pg_read_all_stats + pg_stat_scan_tables
```

Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) Recipe 8 for `pg_monitor` predefined role.

### pgbouncer_exporter

Separate exporter for pgBouncer. Connects to pgBouncer's admin console (`pgbouncer` virtual database) via libpq, scrapes `SHOW STATS` / `SHOW POOLS` / `SHOW CONFIG` / `SHOW DATABASES` / `SHOW LISTS`. Cross-reference [`81-pgbouncer.md`](./81-pgbouncer.md) Console Commands H2.

**Key metrics exposed:**

| Prometheus metric | Source pgBouncer column | Tier | Alert when |
|---|---|---|---|
| `pgbouncer_show_pools_cl_active` | `SHOW POOLS.cl_active` | Workload | — |
| `pgbouncer_show_pools_cl_waiting` | `SHOW POOLS.cl_waiting` | Saturation | `> 0 for 1m` |
| `pgbouncer_show_pools_sv_active` | `SHOW POOLS.sv_active` | Saturation | Approaching `default_pool_size` |
| `pgbouncer_show_pools_maxwait_seconds` | `SHOW POOLS.maxwait` | Saturation | `> 5` |
| `pgbouncer_show_stats_total_xact_count` | `SHOW STATS.total_xact_count` | Workload | Derive TPS via rate() |
| `pgbouncer_show_stats_avg_query_time_us` | `SHOW STATS.avg_query_time` | Efficiency | Workload-specific |

Auth: pgBouncer console requires user listed in `admin_users` or `stats_users` in `pgbouncer.ini`. Create dedicated read-only `stats_users` user for exporter — never give `admin_users` (can run `PAUSE` / `KILL`).

### Log-Based Metrics

Counter-based `pg_stat_*` views miss several operationally-critical signals:

| Signal | Source | Why counter-based misses it |
|---|---|---|
| Slow-query rate distribution | `log_min_duration_statement` | Counters give cumulative, not distribution |
| Deadlock count + parties | `log_lock_waits` + deadlock log line | `pg_locks` is snapshot; deadlock resolved before snapshot |
| Autovacuum cancellation count | autovacuum log entries | Cancellations not in `pg_stat_user_tables` |
| Connection-rejected count + reason | `log_connections` + auth failures | `pg_stat_database.session_*` (PG14+) miss reject reasons |
| Error rate by SQLSTATE | `log_error_verbosity = verbose` | No counter for failed queries |
| Replication-conflict cancellations on standby | `log_recovery_conflict_waits` (PG14+) | `pg_stat_database_conflicts` has counts only |
| Long-running planning vs execution split | `auto_explain.log_min_duration` + `track_planning` | `pg_stat_statements` aggregates only |

**Recommended production logging baseline:**

```ini
# postgresql.conf
logging_collector = on
log_destination = 'stderr,jsonlog'   # PG15+ jsonlog; pre-PG15 use 'stderr,csvlog'
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H.log'
log_rotation_age = 1d
log_rotation_size = 1GB
log_truncate_on_rotation = on

log_line_prefix = '%m [%p] %q%u@%d/%a '   # %L PG18+ adds client IP
log_min_messages = WARNING
log_min_error_statement = ERROR
log_min_duration_statement = 500ms        # Slow-query threshold; tune per workload
log_connections = on
log_disconnections = on
log_lock_waits = on
log_temp_files = 0                        # Log all temp file creations
log_autovacuum_min_duration = '10min'     # PG15+ default already 10min

# PG14+
log_recovery_conflict_waits = on          # Standby query cancellation diagnostics

# PG18+
log_lock_failures = on                    # NOWAIT lock acquisition failures
```

Ship logs to immutable store (S3 with object lock / Azure Blob / GCS with retention) for compliance + forensics. Cross-reference [`51-pgaudit.md`](./51-pgaudit.md) Recipe 7 for the canonical log-shipping pattern.

### auto_explain

In-core module that automatically EXPLAINs slow queries. Loads via `shared_preload_libraries` (postmaster restart) OR per-session `LOAD 'auto_explain'`. Production use: postmaster preload.

```ini
# postgresql.conf
shared_preload_libraries = 'pg_stat_statements, auto_explain'

auto_explain.log_min_duration = '1s'              # Plans for queries >1s
auto_explain.log_analyze = on                     # Include actual row counts
auto_explain.log_buffers = on                     # Buffer accounting
auto_explain.log_timing = on                      # Per-node timing (expensive)
auto_explain.log_verbose = on                     # Include output columns
auto_explain.log_format = 'json'                  # Structured for parsing
auto_explain.log_nested_statements = on           # Include SQL inside functions
auto_explain.sample_rate = 1.0                    # 1.0 = log every slow query
auto_explain.log_parameter_max_length = 4096      # PG16+ — capture bind values
```

> [!WARNING] auto_explain.log_analyze overhead
> Setting `log_analyze = on` makes Postgres execute `EXPLAIN ANALYZE` for slow queries — adds per-row timing instrumentation. On busy OLTP clusters this can add 5-10% latency to logged queries. Mitigate via `sample_rate = 0.1` (log 10% of slow queries) on high-QPS workloads.

Cross-reference [`56-explain.md`](./56-explain.md) for plan interpretation + [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) for aggregate query stats.

### pg_stat_* View Inventory

Quick-reference catalog with PG-version-introduced annotations. Deep dive lives in [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

| View | Type | First in | Purpose |
|---|---|---|---|
| `pg_stat_activity` | Live (1 row per backend) | PG9.x | Current activity, wait events |
| `pg_stat_database` | Cumulative (1 row per DB) | PG9.x | DB-wide counters; PG14+ session stats[^pg14-session-stats] |
| `pg_stat_user_tables` | Cumulative per table | PG9.x | Seq/idx scans, dead tuples, autovac time |
| `pg_stat_user_indexes` | Cumulative per index | PG9.x | idx_scan, idx_tup_read |
| `pg_statio_user_tables` | Cumulative per table | PG9.x | Cache hit / miss per relation |
| `pg_stat_bgwriter` | Cumulative cluster-wide | PG9.x | Bgwriter activity; PG17 split — see below |
| `pg_stat_checkpointer` | Cumulative cluster-wide | **PG17+**[^pg17-checkpointer] | Split from `pg_stat_bgwriter`; `buffers_backend`/`buffers_backend_fsync` removed |
| `pg_stat_archiver` | Cumulative cluster-wide | PG9.4 | WAL archiving success/failure counts |
| `pg_stat_replication` | Live per walsender | PG9.4 | Streaming replication lag |
| `pg_stat_wal_receiver` | Live (1 row on standby) | PG9.6 | Standby walreceiver state |
| `pg_replication_slots` | Live per slot | PG9.4 | Slot retention; PG13+ `wal_status`, PG17+ `invalidation_reason`/`inactive_since` |
| `pg_stat_wal` | Cumulative cluster-wide | **PG14+**[^pg14-wal] | WAL emission counters; PG18 removed timing cols (moved to pg_stat_io) |
| `pg_stat_replication_slots` | Cumulative per slot | **PG14+**[^pg14-rep-slots] | Logical decoding stats per slot |
| `pg_stat_progress_vacuum` | Live (vacuum-in-progress) | PG9.6 | VACUUM phase + progress; PG17 column renames |
| `pg_stat_progress_create_index` | Live | PG12+ | CREATE INDEX progress |
| `pg_stat_progress_basebackup` | Live | PG13+ | pg_basebackup progress |
| `pg_stat_progress_copy` | Live | **PG14+**[^pg14-progress-copy] | COPY progress |
| `pg_stat_progress_cluster` | Live | PG12+ | CLUSTER + VACUUM FULL progress |
| `pg_stat_progress_analyze` | Live | PG13+ | ANALYZE progress |
| `pg_stat_io` | Cumulative by backend_type × context × object | **PG16+**[^pg16-io] | Unified I/O; PG18 replaced `op_bytes` with bytes columns + added WAL rows |
| `pg_stat_subscription_stats` | Cumulative per subscription | **PG15+**[^pg15-sub-stats] | Logical replication conflict + error counts |
| `pg_backend_memory_contexts` | Live per session | PG14+ | Memory context inspection; PG18 schema changes |
| `pg_wait_events` | Static catalog | **PG17+**[^pg17-wait-events] | Wait event descriptions for `pg_stat_activity.wait_event` |
| `pg_aios` | Live | **PG18+**[^pg18-aios] | Async I/O subsystem in-flight operations |
| `pg_locks` | Live | PG9.x | Lock holders + waiters; PG14+ `waitstart` column |
| `pg_stat_ssl` | Live per backend | PG9.5 | SSL/TLS connection info |
| `pg_stat_gssapi` | Live per backend | PG12+ | GSSAPI connection info |

> [!NOTE] PostgreSQL 17
> `pg_stat_checkpointer` view created. Columns `buffers_backend` + `buffers_backend_fsync` **removed** from `pg_stat_bgwriter` because "These fields are considered redundant to similar columns in pg_stat_io"[^pg17-checkpointer]. Monitoring queries for buffer write distribution must use `pg_stat_io` filtered by `backend_type = 'client backend'`.

> [!NOTE] PostgreSQL 18
> `pg_stat_io`: `op_bytes` column removed (always equaled `BLCKSZ`). New columns: `read_bytes`, `write_bytes`, `extend_bytes`. WAL rows added — WAL receiver + WAL write wait events now visible in `pg_stat_io`. Plus `pg_stat_get_backend_io()` for per-backend stats; `pg_stat_reset_backend_stats(pid)` to clear them.

### Alerting Thresholds

No universal threshold — set per workload. Below = starting points for OLTP web-app cluster; reporting / batch / mixed clusters need different values.

**Tier 1 — Capacity (slow alerts, days-weeks horizon):**

| Metric | Threshold | Severity |
|---|---|---|
| Disk usage % | > 75% | Warning |
| Disk usage % | > 90% | Critical |
| `pg_database.datfrozenxid` age | > 1.5B | Warning |
| `pg_database.datfrozenxid` age | > 1.8B | Critical |
| Replication slot retention | > 32GB | Warning |
| `wal_status = 'lost'` | Any | Critical |
| `max_connections` headroom | < 20% | Warning |
| Active replication slots | > `max_replication_slots × 0.8` | Warning |

**Tier 2 — Saturation (fast alerts, minutes horizon):**

| Metric | Threshold | Severity |
|---|---|---|
| `pg_stat_replication.replay_lag` | > 30s | Warning |
| `pg_stat_replication.replay_lag` | > 5min | Critical |
| `pg_stat_activity` blocked queries | > 5 | Warning |
| Connection count | > `max_connections × 0.75` | Warning |
| `pg_locks` `granted = false` count | > 10 for 1min | Warning |
| `idle_in_transaction` sessions | > 1min duration | Warning |
| Deadlock rate (log-derived) | > 1/min | Warning |
| Replication slot `wal_status` | `'unreserved'` | Warning |

**Tier 3 — Efficiency (hours-days horizon):**

| Metric | Threshold | Severity |
|---|---|---|
| Cache hit ratio | < 95% (OLTP) / < 90% (analytics) | Warning |
| Autovacuum overdue tables (dead/live > 20%) | > 10 tables | Warning |
| `pg_stat_user_tables.last_autovacuum` IS NULL on hot table | Any | Warning |
| `pg_stat_database.deadlocks` rate | > 0 sustained | Warning |
| `pg_stat_database.temp_files` rate | > 10/min | Warning |
| `pg_stat_wal.wal_buffers_full` rate (PG14+) | > 0 sustained | Warning |

**Tier 4 — Workload (hours horizon):**

| Metric | Threshold | Severity |
|---|---|---|
| QPS deviation from baseline | > 50% above OR below | Warning |
| p99 query latency | > workload SLA × 1.5 | Warning |
| Error rate by SQLSTATE | > 1% of total queries | Warning |
| Slow-query count (log-based) | > workload-specific rate | Warning |

### Per-Version Timeline

| Version | Monitoring additions |
|---|---|
| **PG14** | `pg_stat_wal` view[^pg14-wal]; `pg_stat_replication_slots` view[^pg14-rep-slots]; `pg_stat_progress_copy` view[^pg14-progress-copy]; `pg_locks.waitstart` column; session statistics added to `pg_stat_database` (`session_time`, `active_time`, `idle_in_transaction_time`, `sessions`, `sessions_abandoned`, `sessions_fatal`, `sessions_killed`)[^pg14-session-stats]; `pg_backend_memory_contexts` view; `query_id` now visible in `pg_stat_activity` + EXPLAIN VERBOSE + log_line_prefix `%Q` |
| **PG15** | `log_destination = jsonlog` added[^pg15-jsonlog]; `log_checkpoints` default changed to `on` (idle servers now log)[^pg15-log-checkpoints]; `log_autovacuum_min_duration` default changed to `10min`; `pg_stat_subscription_stats` view added[^pg15-sub-stats]; cumulative statistics moved to shared memory (eliminated separate stats collector process)[^pg15-stats-shmem]; `log_startup_progress_interval` GUC added |
| **PG16** | `pg_stat_io` view added[^pg16-io]; `last_seq_scan` + `last_idx_scan` columns added to `pg_stat_*_tables` / `pg_stat_*_indexes`; `n_tup_newpage_upd` column tracks rows updated to new pages; `pg_stat_get_backend_subxact()` function for subxact cache; `pg_buffercache_usage_counts()` + `pg_buffercache_summary()` functions; `pg_stat_subscription.leader_pid` column; `SpinDelay` + `DSMAllocate` + `LogicalParallelApply*` wait events added; `BUFFER_USAGE_LIMIT` option added to VACUUM/ANALYZE + `vacuum_buffer_usage_limit` GUC; `log_checkpoints` messages now include REDO LSN |
| **PG17** | **`pg_stat_checkpointer` view split from `pg_stat_bgwriter`**[^pg17-checkpointer] — `buffers_backend` + `buffers_backend_fsync` REMOVED from `pg_stat_bgwriter`; `pg_wait_events` system view added[^pg17-wait-events]; `pg_stat_progress_vacuum` column renames (`max_dead_tuples` → `max_dead_tuple_bytes`, `num_dead_tuples` → `num_dead_item_ids`, new `dead_tuple_bytes` + `indexes_total` + `indexes_processed`); `pg_stat_reset_shared('slru')` for SLRU stats; `pg_stat_statements` new columns (`local_blk_read_time`, `local_blk_write_time`, `stats_since`, `minmax_stats_since`, JIT `deform_counter` details); `pg_replication_slots` new columns (`invalidation_reason`, `inactive_since`); SLRU customization GUCs (`commit_timestamp_buffers` etc.); `pg_stat_progress_copy.tuples_skipped` column |
| **PG18** | `pg_aios` view added[^pg18-aios] (async I/O subsystem); **`pg_stat_io.op_bytes` REMOVED** — replaced with `read_bytes` + `write_bytes` + `extend_bytes`; WAL I/O rows added to `pg_stat_io`; `pg_stat_get_backend_io()` per-backend variant added; `pg_stat_reset_backend_stats(pid)` function added; `pg_stat_get_backend_wal()` added; `pg_stat_checkpointer` new columns `num_done` + `slru_written` (disambiguates skipped checkpoints + splits SLRU writes); `pg_stat_database` new columns `parallel_workers_to_launch` + `parallel_workers_launched`; `pg_stat_all_tables` variants gain `total_vacuum_time` / `total_autovacuum_time` / `total_analyze_time` / `total_autoanalyze_time`; `pg_stat_statements` new columns `parallel_workers_to_launch` + `parallel_workers_launched` + `wal_buffers_full`; **`pg_stat_wal` REMOVED columns** (`wal_write`, `wal_sync`, `wal_write_time`, `wal_sync_time` — relocated to `pg_stat_io`); `track_wal_io_timing` now controls timing in `pg_stat_io`; `pg_backend_memory_contexts` schema changes (`parent` removed, `path` + `type` added, `level` now one-based); VACUUM/ANALYZE delay-time tracking via `track_cost_delay_timing` |

## Examples / Recipes

### Recipe 1 — Production monitoring stack baseline

End-to-end: PG cluster → postgres_exporter → Prometheus → Grafana + Alertmanager. Three-config-block.

**Step 1 — PG cluster `postgresql.conf`:**

```ini
# Enable monitoring extensions + structured logging
shared_preload_libraries = 'pg_stat_statements, auto_explain'

# Cumulative statistics — needed for postgres_exporter
track_activities = on
track_counts = on
track_io_timing = on            # Per-relation I/O timing (small overhead)
track_wal_io_timing = on        # PG14+ WAL timing
track_functions = pl            # Function call counts
track_commit_timestamp = on     # Useful for replication forensics

# Slow-query capture
log_min_duration_statement = 500ms
auto_explain.log_min_duration = 1s
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_format = json
auto_explain.sample_rate = 1.0

# Structured logging
log_destination = 'stderr,jsonlog'
logging_collector = on
log_line_prefix = '%m [%p] %q%u@%d/%a '
log_connections = on
log_disconnections = on
log_lock_waits = on
log_autovacuum_min_duration = '10min'
```

**Step 2 — Monitoring role:**

```sql
CREATE ROLE postgres_exporter LOGIN PASSWORD 'secret';
GRANT pg_monitor TO postgres_exporter;
-- pg_hba.conf:
-- host all postgres_exporter 10.0.0.0/8 scram-sha-256
```

**Step 3 — `postgres_exporter` systemd unit:**

```ini
# /etc/systemd/system/postgres_exporter.service
[Unit]
Description=Prometheus PostgreSQL Exporter
After=network.target

[Service]
User=postgres
Environment="DATA_SOURCE_NAME=postgresql://postgres_exporter:secret@localhost:5432/postgres?sslmode=require"
ExecStart=/usr/local/bin/postgres_exporter \
  --web.listen-address=:9187 \
  --extend.query-path=/etc/postgres_exporter/queries.yaml
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Step 4 — Prometheus scrape config:**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: postgres
    scrape_interval: 30s
    static_configs:
      - targets: ['pg-prod-1:9187', 'pg-prod-2:9187']
        labels:
          environment: production
          role: primary
```

**Step 5 — Verify:**

```bash
curl -s http://pg-prod-1:9187/metrics | grep -E '^pg_up|pg_postmaster|pg_stat_database_xact_commit'
```

### Recipe 2 — Cache-hit-ratio alert rule

Per-database cache hit, computed from `pg_stat_database`. Alert when sustained below threshold.

```yaml
# /etc/prometheus/rules/postgres.yml
groups:
- name: postgres_efficiency
  rules:
  - alert: PostgresCacheHitRatioLow
    expr: |
      (
        rate(pg_stat_database_blks_hit{datname!~"template.*|postgres"}[5m])
        /
        (rate(pg_stat_database_blks_hit{datname!~"template.*|postgres"}[5m])
         + rate(pg_stat_database_blks_read{datname!~"template.*|postgres"}[5m]))
      ) < 0.90
    for: 15m
    labels:
      severity: warning
      tier: efficiency
    annotations:
      summary: "Cache hit ratio < 90% on {{ $labels.datname }} for 15m"
      description: "Working set likely exceeds shared_buffers. Check pg_stat_io for buffer reads."
```

### Recipe 3 — pgBouncer pool exhaustion alert

```yaml
- alert: PgBouncerPoolSaturated
  expr: pgbouncer_pools_client_waiting > 0
  for: 1m
  labels:
    severity: warning
    tier: saturation
  annotations:
    summary: "pgBouncer clients waiting for server connection (database={{ $labels.database }})"
    description: "cl_waiting > 0 sustained. Raise default_pool_size or investigate long-running queries."

- alert: PgBouncerMaxWaitHigh
  expr: pgbouncer_pools_maxwait_seconds > 5
  for: 2m
  labels:
    severity: critical
    tier: saturation
  annotations:
    summary: "pgBouncer maxwait > 5s (database={{ $labels.database }})"
    description: "Longest client wait exceeds SLA. Check server-side query latency + pool size."
```

### Recipe 4 — Replication lag alert

```yaml
- alert: PostgresReplicationLagHigh
  expr: pg_replication_lag_seconds > 30
  for: 2m
  labels:
    severity: warning
    tier: saturation
  annotations:
    summary: "Standby {{ $labels.application_name }} replay lag > 30s"

- alert: PostgresReplicationSlotInactive
  expr: pg_replication_slots_active{slot_type="physical"} == 0
  for: 5m
  labels:
    severity: warning
    tier: capacity
  annotations:
    summary: "Replication slot {{ $labels.slot_name }} inactive for 5m"
    description: "Inactive slot retains WAL indefinitely without max_slot_wal_keep_size. Check wal_status."

- alert: PostgresReplicationSlotLost
  expr: pg_replication_slots_wal_status{wal_status="lost"} == 1
  labels:
    severity: critical
    tier: capacity
  annotations:
    summary: "Replication slot {{ $labels.slot_name }} status=lost — CANNOT RESUME"
```

### Recipe 5 — XID wraparound capacity alert

```yaml
- alert: PostgresXIDWraparoundApproaching
  expr: pg_database_xid_age_to_wraparound < 500000000
  for: 1h
  labels:
    severity: warning
    tier: capacity
  annotations:
    summary: "Database {{ $labels.datname }} < 500M transactions to wraparound"

- alert: PostgresXIDWraparoundCritical
  expr: pg_database_xid_age_to_wraparound < 100000000
  for: 5m
  labels:
    severity: critical
    tier: capacity
  annotations:
    summary: "Database {{ $labels.datname }} < 100M transactions to wraparound — EMERGENCY"
```

Custom queries for `pg_database_xid_age_to_wraparound` (not built-in to postgres_exporter):

```yaml
# /etc/postgres_exporter/queries.yaml
pg_database_xid_age:
  query: |
    SELECT
      datname,
      age(datfrozenxid) AS xid_age,
      2147483647 - age(datfrozenxid) AS xid_age_to_wraparound
    FROM pg_database
    WHERE datallowconn = true
  metrics:
    - datname:
        usage: LABEL
    - xid_age:
        usage: GAUGE
        description: "Age in transactions of oldest XID in database"
    - xid_age_to_wraparound:
        usage: GAUGE
        description: "Transactions remaining until wraparound"
```

### Recipe 6 — Long-running transaction detector

Identifies sessions holding `xmin` horizon back (autovacuum cannot clean their dead tuples). Cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 2.

```yaml
# queries.yaml
pg_long_xact:
  query: |
    SELECT
      COALESCE(EXTRACT(EPOCH FROM (now() - xact_start))::bigint, 0) AS duration_seconds,
      state,
      COALESCE(application_name, 'unknown') AS application_name
    FROM pg_stat_activity
    WHERE xact_start IS NOT NULL
      AND backend_type = 'client backend'
      AND state != 'idle'
    ORDER BY xact_start
    LIMIT 1
  metrics:
    - duration_seconds:
        usage: GAUGE
    - state:
        usage: LABEL
    - application_name:
        usage: LABEL
```

```yaml
# rules
- alert: PostgresLongTransaction
  expr: pg_long_xact_duration_seconds > 300
  for: 1m
  labels:
    severity: warning
    tier: saturation
  annotations:
    summary: "Transaction running > 5 min ({{ $labels.application_name }})"
    description: "Long transactions block autovacuum. Consider idle_in_transaction_session_timeout."
```

### Recipe 7 — Autovacuum overdue tables audit

Tracks tables with high dead-tuple ratio where autovacuum has not run recently.

```yaml
pg_autovac_overdue:
  query: |
    SELECT
      schemaname,
      relname,
      n_dead_tup,
      n_live_tup,
      CASE WHEN n_live_tup > 0
        THEN (n_dead_tup::float / n_live_tup)::float
        ELSE 0
      END AS dead_pct,
      COALESCE(EXTRACT(EPOCH FROM (now() - last_autovacuum)), 999999) AS last_autovac_seconds_ago
    FROM pg_stat_user_tables
    WHERE n_live_tup > 1000
      AND (n_dead_tup::float / GREATEST(n_live_tup, 1)) > 0.20
  metrics:
    - schemaname: { usage: LABEL }
    - relname: { usage: LABEL }
    - n_dead_tup: { usage: GAUGE }
    - dead_pct: { usage: GAUGE }
    - last_autovac_seconds_ago: { usage: GAUGE }
```

### Recipe 8 — Detect monitoring queries that break on PG17/PG18 upgrade

Pre-upgrade audit of dashboards + alert rules referencing removed columns.

```bash
# Search dashboards + alert rules for PG17-removed columns
grep -r -E 'buffers_backend|buffers_backend_fsync|max_dead_tuples|num_dead_tuples' \
  /etc/prometheus/rules/ /var/lib/grafana/dashboards/

# Search for PG18-removed pg_stat_io.op_bytes + pg_stat_wal timing columns
grep -r -E 'pg_stat_io.*op_bytes|wal_write_time|wal_sync_time' \
  /etc/prometheus/rules/ /var/lib/grafana/dashboards/

# Search for PG18-removed pg_backend_memory_contexts.parent
grep -r 'pg_backend_memory_contexts.*parent' \
  /etc/prometheus/rules/ /var/lib/grafana/dashboards/
```

Update queries before upgrading cluster to PG17/PG18 or dashboards return NULL silently.

### Recipe 9 — `pg_activity` for incident response

Real-time `top`-style query monitoring during incidents. Better than `watch` over `pg_stat_activity` because it filters per-DB + can kill backends interactively.

```bash
# Install
apt install pg-activity     # Debian/Ubuntu
yum install pg-activity     # RHEL/Rocky

# Run
pg_activity -h pg-prod-1 -U postgres -d production

# Keyboard shortcuts (in TUI):
# - F1/F2/F3: switch views (running queries / waiting / blocking)
# - C: change refresh rate
# - K: kill selected backend
# - F: filter by database
# - / : search by query text
```

### Recipe 10 — `pgmetrics` one-shot snapshot

Single-binary tool collecting 350+ metrics. Useful for: pre-deploy baseline, post-incident forensics, sharing cluster state with vendor support.

```bash
# Install (release binary from https://github.com/rapidloop/pgmetrics)
curl -sL https://github.com/rapidloop/pgmetrics/releases/latest/download/pgmetrics_linux_amd64.tar.gz \
  | tar xz

# Run
./pgmetrics -h pg-prod-1 -U postgres -p 5432 -f text   # human-readable
./pgmetrics -h pg-prod-1 -U postgres -p 5432 -f json   # machine-readable
./pgmetrics -h pg-prod-1 -U postgres -p 5432 -f csv    # spreadsheet-friendly

# Common flags:
# --statements N    : Top N from pg_stat_statements
# --schema PATTERN  : Filter to schema
# --no-pgbouncer    : Skip pgBouncer probing
# --connect=NAME    : Use libpq service file entry
```

### Recipe 11 — Top-N query by execution time (workload tier)

Combine `pg_stat_statements` with Grafana for query-level workload view. Cardinality concern: 10k+ unique queries break Prometheus. Sample top-50 instead.

```yaml
# queries.yaml — top-50 only, runs every 60s
pg_top_queries:
  query: |
    SELECT
      queryid::text,
      LEFT(query, 100) AS query_sample,
      calls,
      total_exec_time / 1000 AS total_exec_seconds,
      mean_exec_time AS mean_exec_ms,
      rows
    FROM pg_stat_statements
    WHERE queryid IS NOT NULL
    ORDER BY total_exec_time DESC
    LIMIT 50
  metrics:
    - queryid: { usage: LABEL }
    - query_sample: { usage: LABEL }
    - calls: { usage: COUNTER }
    - total_exec_seconds: { usage: COUNTER }
    - mean_exec_ms: { usage: GAUGE }
    - rows: { usage: COUNTER }
```

### Recipe 12 — Log-based deadlock rate metric

Postgres logs deadlock detection to server log. Extract count via log-shipping pipeline (Loki / Promtail / vector).

```yaml
# promtail-config.yaml — Loki log shipper
scrape_configs:
- job_name: postgres
  static_configs:
  - targets: [localhost]
    labels:
      job: postgres
      __path__: /var/lib/postgresql/16/main/log/*.log
  pipeline_stages:
  - json:
      expressions:
        message: message
        sqlstate: sqlstate
        timestamp: timestamp
  - regex:
      source: message
      expression: 'deadlock detected'
  - labels:
      deadlock_detected:
  - metrics:
      postgres_deadlock_count:
        type: Counter
        description: "Deadlocks detected in PostgreSQL log"
        prefix: postgres_
        source: deadlock_detected
        config:
          action: inc
```

```yaml
# Alert
- alert: PostgresDeadlockRateHigh
  expr: rate(postgres_deadlock_count[5m]) > 0.0167   # > 1 per minute
  labels:
    severity: warning
    tier: saturation
  annotations:
    summary: "Deadlock rate > 1/min"
    description: "Application is producing lock ordering bugs. See log for participants."
```

### Recipe 13 — Pre-deploy baseline + post-deploy regression check

Capture pre-deploy `pg_stat_statements` snapshot; after deploy, find regressions.

```sql
-- Pre-deploy: capture baseline (~5 minutes before deploy)
CREATE TABLE deploy_baseline AS
SELECT
  queryid,
  query,
  calls AS pre_calls,
  total_exec_time AS pre_total_ms,
  mean_exec_time AS pre_mean_ms,
  now() AS captured_at
FROM pg_stat_statements
WHERE calls > 100;

-- Post-deploy (15 minutes after): find regressions
WITH current AS (
  SELECT queryid, calls, total_exec_time, mean_exec_time
  FROM pg_stat_statements
),
deltas AS (
  SELECT
    b.queryid,
    LEFT(b.query, 80) AS query_sample,
    c.calls - b.pre_calls AS new_calls,
    (c.mean_exec_time - b.pre_mean_ms) AS mean_change_ms,
    (c.mean_exec_time / NULLIF(b.pre_mean_ms, 0))::numeric(10,2) AS slowdown_ratio
  FROM deploy_baseline b
  JOIN current c ON c.queryid = b.queryid
  WHERE c.calls > b.pre_calls + 10
)
SELECT *
FROM deltas
WHERE slowdown_ratio > 1.5
  AND mean_change_ms > 10
ORDER BY mean_change_ms DESC
LIMIT 20;
```

Cross-reference [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) Recipe 13.

## Gotchas / Anti-patterns

1. **Monitoring queries break silently on PG17 upgrade.** `pg_stat_bgwriter.buffers_backend` returns NULL after PG17 because column moved to `pg_stat_io`. Same for `buffers_backend_fsync`. **Audit dashboards via Recipe 8 BEFORE upgrading.**

2. **PG18 removes `pg_stat_io.op_bytes`.** Queries using `op_bytes` to compute total bytes return NULL. Replace with `read_bytes` + `write_bytes` + `extend_bytes` columns.

3. **PG18 relocates `pg_stat_wal` timing columns to `pg_stat_io`.** `wal_write_time` / `wal_sync_time` / `wal_write` / `wal_sync` columns REMOVED from `pg_stat_wal`. Find WAL I/O timing in `pg_stat_io` rows where `backend_type LIKE 'wal%'`.

4. **PG17 renames `pg_stat_progress_vacuum` columns.** `max_dead_tuples` → `max_dead_tuple_bytes` (now in bytes, not tuples!); `num_dead_tuples` → `num_dead_item_ids`. Old queries return NULL.

5. **`pg_stat_statements` cardinality explosion in Prometheus.** A cluster with 10k+ distinct `queryid`s exported as Prometheus labels = scrape time > 30s, Prometheus rule eval fails. **Sample top-N by `total_exec_time` instead** (Recipe 11).

6. **PG15 `log_checkpoints` default flipped from `off` to `on`.** Verbatim release-note caveat: "This will cause even an idle server to generate some log output"[^pg15-log-checkpoints]. Resource-constrained clusters need explicit `log_checkpoints = off` post-upgrade.

7. **`auto_explain.log_analyze = on` adds 5-10% latency on busy OLTP.** Mitigate via `sample_rate = 0.1` to log 10% of slow queries.

8. **`pg_monitor` predefined role grants seeing query text from all roles.** A user-level role granted `pg_monitor` can read other users' queries via `pg_stat_activity`. Lock down `pg_monitor` to dedicated monitoring service accounts only.

9. **Cache hit ratio threshold is workload-specific.** OLTP cluster with hot small working set in shared_buffers can achieve 99%; analytics cluster with 100GB working set on 32GB RAM cannot exceed ~70-80%. Set threshold per role / per database, not cluster-wide.

10. **`idle_in_transaction` alerts page constantly.** Symptom is real (cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) Gotcha #2) but filter by `state_change > 1 minute` to reduce noise. Short-lived idle-in-tx is application normal; long-lived is the bug.

11. **`pg_stat_replication.replay_lag` returns NULL on idle standby.** Standby with no replication traffic since last query reports NULL — not zero. Alert rule must `OR pg_replication_slot_wal_lag_bytes > X` to cover idle gap.

12. **`pg_replication_slots.active = false` is normal during failover but indefinite slot retention fills disk.** Alert on `active = false for > 5 minutes` + `pg_wal_lsn_diff(...) > max_slot_wal_keep_size_threshold`.

13. **postgres_exporter cardinality bloats with `pg_stat_user_tables` on partition-heavy schemas.** Cluster with 10k partitions = 10k per-table rows × N metrics = exporter slow. Filter via `pg_class` join or limit to parent tables only.

14. **`pgmonitor` copyright transferred 2025-2026.** Crunchy Data (2017-2025) → Snowflake (2025-2026). Project still active; cite GitHub URL not the .io domain (which returned ECONNREFUSED at planning time).

15. **Percona Toolkit (`pt-pg-summary`) is MySQL-focused.** No PostgreSQL diagnostics in Percona Toolkit. Use `pgmetrics` or `pg_activity` instead.

16. **`pg_stat_statements_reset()` returns `void` pre-PG17, `timestamptz` PG17+.** Scripts comparing return-value need version conditional. Plus PG17 added `minmax_only` boolean 4th argument for reset signature.

17. **Counter views accumulate from cluster start (or last reset).** Single-point query gives lifetime value. Always use `rate()` / `irate()` in Prometheus for derived metrics like QPS or cache-hit ratio.

18. **`track_io_timing = on` overhead.** Some platforms (older kernels, Windows) have slow `clock_gettime()` — `track_io_timing` can add 5-15% CPU. Test on staging before enabling cluster-wide. PG14+ `pg_test_timing` measures the overhead.

19. **`log_min_duration_statement = 0` logs every query.** Catastrophic on high-QPS clusters (10MB/sec log volume not unusual). Use `auto_explain.log_min_duration` instead with `sample_rate` for production.

20. **`pg_stat_database.session_*` columns (PG14+) don't track pgBouncer-pooled connections accurately.** pgBouncer transaction-mode shares server connections across many client sessions — `sessions` counter undercounts client sessions.

21. **Stats collector process removed in PG15.** Old runbooks referencing the stats collector process (PG≤14) are obsolete. Cumulative stats now in shared memory[^pg15-stats-shmem].

22. **`pg_stat_io` `op_bytes` column equaled `BLCKSZ` until PG18 removed it.** PG16/17 queries multiplying counts by `op_bytes` produced correct byte totals; PG18 queries must use the explicit `read_bytes` / `write_bytes` / `extend_bytes` columns.

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin horizon blockers; idle_in_transaction cost
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum monitoring + tuning
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — XID wraparound alerts
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pg_monitor` predefined role
- [`51-pgaudit.md`](./51-pgaudit.md) — audit log shipping pattern
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC mechanism + `pg_settings`
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `shared_buffers` and cache-hit thresholds
- [`56-explain.md`](./56-explain.md) — EXPLAIN output for `auto_explain` plans
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — query-level workload metrics
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — full `pg_stat_*` view reference
- [`73-streaming-replication.md`](./73-streaming-replication.md) — replication lag alerting
- [`75-replication-slots.md`](./75-replication-slots.md) — slot retention monitoring
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA-pattern alerting requirements
- [`79-patroni.md`](./79-patroni.md) — Patroni `/metrics` endpoint integration
- [`81-pgbouncer.md`](./81-pgbouncer.md) — pgBouncer console + `pgbouncer_exporter`
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — backup completion monitoring
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `checksum_failures` alert interpretation + amcheck verification
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-env monitoring constraints

## Sources

[^postgres-exporter]: "postgres_exporter" — Prometheus Community PostgreSQL exporter (v0.19.1, February 2026). Default-enabled collectors documented in README. https://github.com/prometheus-community/postgres_exporter
[^postgres-exporter-custom]: Custom queries flag: `--extend.query-path` accepts YAML file with custom SQL → metric definitions. README documents the YAML schema. https://github.com/prometheus-community/postgres_exporter#flags
[^pgbouncer-exporter]: "pgbouncer_exporter" — Prometheus exporter for pgBouncer (v0.11.0+). Supports pgBouncer 1.8+. Scrapes SHOW STATS / SHOW POOLS / SHOW CONFIG. https://github.com/prometheus-community/pgbouncer_exporter
[^pgwatch]: "pgwatch" — Cybertec open-source PostgreSQL monitoring (v5.2.0, May 2026). Agentless collector + Grafana dashboards. https://github.com/cybertec-postgresql/pgwatch
[^pgmonitor]: "pgMonitor" — Crunchy Data / Snowflake open-source monitoring stack (v5.3.0, July 2025). Copyright transferred 2025-2026 from Crunchy Data Solutions to Snowflake Inc. https://github.com/CrunchyData/pgmonitor
[^pgmonitor-copyright]: pgmonitor GitHub repo README explicitly notes "Copyright (c) 2017-2025 Crunchy Data Solutions, Inc. Copyright (c) 2025-2026 Snowflake, Inc." reflecting Crunchy → Snowflake acquisition.
[^pgmetrics]: "pgmetrics" — RapidLoop one-shot snapshot tool (v1.19.0, January 2026). Collects 350+ metrics; zero dependencies; no PG extension required. https://pgmetrics.io/
[^pg_activity]: "pg_activity" — Dalibo `top`-like CLI (v3.6.1, June 2025). Real-time PostgreSQL activity monitoring. https://github.com/dalibo/pg_activity
[^auto-explain]: PostgreSQL 16 docs F.4: "The auto_explain module provides a means for logging execution plans of slow statements automatically." https://www.postgresql.org/docs/16/auto-explain.html
[^pganalyze]: "Log Insights continuously monitors your Postgres error log for unexpected events. ... Log Insights is only available if your database provider exports Postgres logs via syslog." pganalyze docs. https://pganalyze.com/docs/
[^pg14-wal]: PG14 release notes: "Add system view `pg_stat_wal` to track WAL activity (Masahiro Ikeda)." https://www.postgresql.org/docs/release/14.0/
[^pg14-rep-slots]: PG14 release notes: "Add system view `pg_stat_replication_slots` to report replication slot activity (Masahiko Sawada, Amit Kapila, Vignesh C)." https://www.postgresql.org/docs/release/14.0/
[^pg14-progress-copy]: PG14 release notes: "Add system view `pg_stat_progress_copy` to report `COPY` progress (Josef Šimánek, Matthias van de Meent)." https://www.postgresql.org/docs/release/14.0/
[^pg14-session-stats]: PG14 release notes: "Add columns to `pg_stat_database` to report session statistics (Laurenz Albe). New columns include `session_time`, `active_time`, `idle_in_transaction_time`, `sessions`, `sessions_abandoned`, `sessions_fatal`, and `sessions_killed`." https://www.postgresql.org/docs/release/14.0/
[^pg15-jsonlog]: PG15 release notes: "Allow PostgreSQL logs to be output in JSON format (Sehrope Sarkuni, Michael Paquier). This is enabled with the new server variable setting `log_destination = jsonlog`." https://www.postgresql.org/docs/release/15.0/
[^pg15-log-checkpoints]: PG15 release notes: "Enable `log_checkpoints` and `log_autovacuum_min_duration` by default (Bharath Rupireddy). The previous defaults were off and -1, respectively. This will cause even an idle server to generate some log output, which might require log adjustments." https://www.postgresql.org/docs/release/15.0/
[^pg15-sub-stats]: PG15 release notes: "Add system view `pg_stat_subscription_stats` to report on subscriber activity (Masahiko Sawada). Function `pg_stat_reset_subscription_stats()` allows resetting these statistics counters." https://www.postgresql.org/docs/release/15.0/
[^pg15-stats-shmem]: PG15 release notes: "Store cumulative statistics system data in shared memory (Kyotaro Horiguchi, Andres Freund, Melanie Plageman). Previously this data was sent to the statistics collector process via UDP packets, and could be read by sessions by reading files written out by the statistics collector. There is no longer a separate statistics collector process." https://www.postgresql.org/docs/release/15.0/
[^pg16-io]: PG16 release notes: "Create system view `pg_stat_io` to track block I/O statistics (Melanie Plageman)." https://www.postgresql.org/docs/release/16.0/
[^pg17-checkpointer]: PG17 release notes: "Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view." https://www.postgresql.org/docs/release/17.0/
[^pg17-wait-events]: PG17 release notes: "Add system view `pg_wait_events` that reports wait event types (Bertrand Drouvot). This is useful for adding descriptions to wait events reported in `pg_stat_activity`." https://www.postgresql.org/docs/release/17.0/
[^pg18-aios]: PG18 release notes: "Add an asynchronous I/O subsystem (Andres Freund, Thomas Munro, Nazir Bilal Yavuz, Melanie Plageman). ... new system view `pg_aios` shows the file handles being used for asynchronous I/O." https://www.postgresql.org/docs/release/18.0/

Additional canonical references:

- PostgreSQL 16 monitoring chapter: https://www.postgresql.org/docs/16/monitoring.html
- PostgreSQL 16 cumulative statistics: https://www.postgresql.org/docs/16/monitoring-stats.html
- PostgreSQL 16 logging GUCs: https://www.postgresql.org/docs/16/runtime-config-logging.html
- PostgreSQL 16 `pg_stat_activity` columns: https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW
- PostgreSQL 16/17/18 release notes: https://www.postgresql.org/docs/release/16.0/ https://www.postgresql.org/docs/release/17.0/ https://www.postgresql.org/docs/release/18.0/
- pgBouncer console commands: https://www.pgbouncer.org/usage.html

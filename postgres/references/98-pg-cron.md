# pg_cron

pg_cron = canonical in-database cron-style scheduler for PostgreSQL. Maintained by Citus Data (now Microsoft) but Apache-2.0 + provider-agnostic. Adds **`cron.schedule()` / `cron.schedule_in_database()` / `cron.unschedule()` / `cron.alter_job()`** functions + **`cron.job` + `cron.job_run_details`** catalog tables. Wholly external extension — versioned independently of PostgreSQL.[^1]

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [Installation](#installation)
  - [Cron Syntax](#cron-syntax)
  - [cron.schedule + Variants](#cronschedule--variants)
  - [cron.unschedule](#cronunschedule)
  - [cron.alter_job](#cronalter_job)
  - [Catalog Tables](#catalog-tables)
  - [Cross-Database Scheduling](#cross-database-scheduling)
  - [Execution Model](#execution-model)
  - [HA / Failover](#ha--failover)
  - [Configuration GUCs](#configuration-gucs)
  - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

When you need scheduled work **inside Postgres** without external cron / systemd timers / Airflow / K8s CronJob. Canonical use cases: nightly `VACUUM ANALYZE`, weekly `REFRESH MATERIALIZED VIEW CONCURRENTLY`, daily partition rotation, periodic stats reset, hourly aggregate refresh, scheduled `pg_partman` maintenance. For partition lifecycle automation see [`99-pg-partman.md`](./99-pg-partman.md). For TimescaleDB jobs see [`96-timescaledb.md`](./96-timescaledb.md). For Patroni-cluster job re-attachment after failover see [`79-patroni.md`](./79-patroni.md).

## Mental Model

Five rules:

1. **pg_cron is wholly external — not in core.** Latest stable **v1.6.7** released 2025-09-04. v1.6.6 (same day) added PG18 support. Apache-2.0 throughout. Repo `citusdata/pg_cron`. **Zero pg_cron items in PG14/15/16/17/18 release notes** — versioned independently of PostgreSQL.[^1][^2][^3]

2. **Single-database installation, multi-database execution.** Verbatim README: `"pg_cron may only be installed to one database in a cluster. If you need to run jobs in multiple databases, use cron.schedule_in_database()."` Schema lives in the database named by `cron.database_name` GUC (default `postgres`). All `cron.job` rows live there; jobs targeting other databases dispatch via `schedule_in_database()`.[^1]

3. **Background worker on the primary, silent on standby.** `shared_preload_libraries = 'pg_cron'` starts a background worker at postmaster start. Verbatim: `"Note that pg_cron does not run any jobs as a long a server is in hot standby mode, but it automatically starts when the server is promoted."` (sic — README typo preserved). After Patroni / failover promotes a standby, jobs resume **from the new primary's `cron.job` rows** — which must already match the old primary's.[^1]

4. **Standard 5-field cron syntax + a `[1-59] seconds` extension.** Five space-separated fields: minute / hour / day-of-month / month / day-of-week. Plus `*` wildcard, `,` list, `-` range, `/` step, and (since v1.6.0) `$` for last-day-of-month. Verbatim: `"to use [1-59] seconds to schedule a job based on an interval. Note, you cannot use seconds with the other time units."` So `'30 seconds'` is legal but `'30 seconds * * * *'` is not.[^1]

5. **Two execution modes — fork-process (default) vs `cron.use_background_workers`.** Default mode forks a new backend per scheduled execution (libpq connect, full process startup). Background-worker mode uses persistent `bgworker` slots — verbatim: `"the number of concurrent jobs is limited by the max_worker_processes setting, so you may need to raise that."` Background-worker mode is faster for sub-minute intervals but competes with parallel workers + autovacuum + logical replication for the `max_worker_processes` budget.[^1]

> [!WARNING] pg_cron is NOT in core PostgreSQL
> External extension. Requires `shared_preload_libraries = 'pg_cron'` + restart + `CREATE EXTENSION pg_cron` in the database named by `cron.database_name`. Most managed providers either preinstall it or block it entirely — verify before depending on it. Self-host: `apt install postgresql-17-cron` / `yum install pg_cron_17` / build from source. PG14/15/16/17/18 release notes contain **zero** pg_cron items — track upstream `citusdata/pg_cron/releases` for version timeline.

> [!WARNING] Time zone defaults to GMT, not your server time
> Verbatim README: `"Previously pg_cron could only use GMT time, but now you can adapt your time by setting cron.timezone in postgresql.conf."` Default is **GMT** (not UTC, not your server's `TimeZone` GUC). A nightly `'0 2 * * *'` job runs at **02:00 GMT** — which may be 21:00 / 19:00 / 03:00 / 11:00 local time depending on where you are. Set `cron.timezone = 'UTC'` (or your operational time zone) explicitly in `postgresql.conf`.

## Decision Matrix

| Use case | Tool / pattern | Rationale |
|---|---|---|
| Nightly `VACUUM ANALYZE` on hot table | `cron.schedule('vacuum-events', '0 3 * * *', 'VACUUM ANALYZE events')` | Standard cron expression, runs at 03:00 in `cron.timezone` |
| Sub-minute periodic task | `cron.schedule('refresh-cache', '30 seconds', 'CALL refresh_cache_proc()')` | `[1-59] seconds` form — only valid alone, not combined with other fields |
| Refresh materialized view concurrently | `cron.schedule('mv-refresh', '*/15 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY my_mv')` | CONCURRENTLY needs unique index on mv — see [`05-views.md`](./05-views.md) |
| Job in different database | `cron.schedule_in_database('partman', '0 1 * * *', 'CALL partman.run_maintenance_proc()', 'app_db')` | Dispatch to `app_db` from the `postgres` database where pg_cron lives |
| Job as different role | `cron.schedule_in_database('audit', '0 4 * * *', 'CALL daily_audit()', 'app_db', 'audit_role')` | `username` parameter — must be granted to scheduler |
| Disable a job temporarily | `UPDATE cron.job SET active = false WHERE jobname = 'foo'` or `cron.alter_job(jobid, active := false)` | Don't `unschedule` if you'll re-enable later — preserves history |
| Last day of month | `cron.schedule('eom', '0 23 $ * *', 'CALL eom_close()')` | `$` requires v1.6.0+ |
| Schedule based on interval not absolute time | `'30 seconds'` form for sub-minute, otherwise standard cron | pg_cron does not support `@every 5m` — use `*/5 * * * *` |
| Run job once at a specific time | Schedule + `cron.alter_job(active := false)` after first run | pg_cron is recurring-only; one-shot needs cleanup |
| Inspect why a job failed | `SELECT * FROM cron.job_run_details WHERE jobid = X ORDER BY start_time DESC LIMIT 10` | `status` + `return_message` columns |
| Background-worker mode for high-frequency jobs | `cron.use_background_workers = on` + bump `max_worker_processes` | Fork mode adds ~5-50ms libpq connect latency per execution |
| Multi-tenant per-database scheduling | `cron.schedule_in_database()` from one central pg_cron install | Cannot install pg_cron into multiple databases — single install dispatches everywhere |
| HA failover restart | Nothing — auto-resumes on promotion | But verify `cron.job` rows replicated to standby (they are if pg_cron in the streaming-replicated `postgres` DB by default) |

Smell signals:

- **`cron.job_run_details` growing unbounded** — never pruned by default. Schedule a self-pruning job (Recipe 11) or `cron.log_run = off` to disable logging entirely.
- **Jobs not running after failover** — Patroni promoted but `pg_cron` not in `shared_preload_libraries` on the new primary, OR `cron.database_name` mismatch between nodes.
- **Sub-second drift between scheduled time and actual `start_time`** — fork mode under load. Switch to `cron.use_background_workers = on`.

## Syntax / Mechanics

### Installation

Three steps. All required.

```sql
-- 1. postgresql.conf
shared_preload_libraries = 'pg_cron'   -- comma-separated if other libs
cron.database_name = 'postgres'        -- DB where extension installs (default)
cron.timezone = 'UTC'                  -- explicit time zone (default is GMT)
```

```bash
# 2. Restart (shared_preload_libraries is postmaster-context, restart only)
sudo systemctl restart postgresql
```

```sql
-- 3. Install extension into the database named by cron.database_name
\c postgres
CREATE EXTENSION pg_cron;

-- Verify
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_cron';
--  extname  | extversion
-- ----------+------------
--  pg_cron  | 1.6
```

> [!NOTE] PostgreSQL 18
> v1.6.6 added PG18 support. v1.6.5 fixed a leap-year scheduling bug. v1.6.7 (current) fixes GCC compile errors. **Use v1.6.5 or later** in production.

`pg_read_server_files` / `pg_write_server_files` are **not** required — pg_cron runs SQL only, not shell. (For shell commands you'd use `system()` from PL/Python or call a PL/pgSQL function that uses `pg_execute_server_program`-style mechanism, neither of which pg_cron itself provides.)

### Cron Syntax

Standard 5-field cron expression:

```
 ┌─────────── minute     (0 - 59)
 │ ┌───────── hour       (0 - 23)
 │ │ ┌─────── day-of-month (1 - 31, or $ for last day v1.6.0+)
 │ │ │ ┌───── month      (1 - 12, or names jan-dec)
 │ │ │ │ ┌─── day-of-week (0 - 6, Sunday = 0 or 7, or names sun-sat)
 │ │ │ │ │
 * * * * *
```

Operators:

| Operator | Meaning | Example |
|---|---|---|
| `*` | every value | `* * * * *` (every minute) |
| `,` | list | `0,15,30,45 * * * *` (every 15 min) |
| `-` | range | `0 9-17 * * 1-5` (hourly 9am-5pm, Mon-Fri) |
| `/` | step | `*/5 * * * *` (every 5 min) |
| `$` | last day of month (v1.6.0+) | `0 23 $ * *` (23:00 last day of month) |

**Interval-only form** (v1.5.0+):

```
'30 seconds'    -- every 30 seconds
'1 second'      -- every 1 second (high overhead — use background workers)
```

Verbatim restriction: `"you cannot use seconds with the other time units."` So `'30 seconds * * * *'` is **invalid**.

Common patterns:

| Schedule | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Top of every hour |
| `0 3 * * *` | 03:00 daily |
| `0 3 * * 0` | 03:00 every Sunday |
| `0 3 1 * *` | 03:00 first day of month |
| `0 23 $ * *` | 23:00 last day of month |
| `30 seconds` | Every 30 seconds |
| `0 2 * * 1-5` | 02:00 weekdays only |

### cron.schedule + Variants

Full signatures (verbatim from `citusdata/pg_cron` README):

```sql
-- Anonymous job (jobname = NULL, identified by jobid only)
CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
RETURNS bigint;

-- Named job (recommended — easier to manage)
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint;

-- Cross-database, cross-role
CREATE OR REPLACE FUNCTION cron.schedule_in_database(
  job_name text,
  schedule text,
  command text,
  database text,
  username text DEFAULT NULL::text,
  active boolean DEFAULT true)
RETURNS bigint;
```

Returns `jobid` (bigint). Insert + identify in one step:

```sql
SELECT cron.schedule('vacuum-events', '0 3 * * *', 'VACUUM ANALYZE events');
--  schedule
-- ----------
--         42
```

Multiple jobs with the same `job_name` **replace** each other — `cron.schedule()` is idempotent on `job_name`. So redeploying the same migration script doesn't duplicate jobs.

### cron.unschedule

```sql
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean;
CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean;
```

Removes the row from `cron.job`. Returns `true` on success, `false` if not found.

```sql
SELECT cron.unschedule('vacuum-events');
SELECT cron.unschedule(42);
```

`cron.job_run_details` rows for the deleted job **stay** — pg_cron does not cascade. Prune separately.

### cron.alter_job

```sql
CREATE OR REPLACE FUNCTION cron.alter_job(
  job_id bigint,
  schedule text DEFAULT NULL::text,
  command text DEFAULT NULL::text,
  database text DEFAULT NULL::text,
  username text DEFAULT NULL::text,
  active boolean DEFAULT NULL::boolean)
RETURNS void;
```

NULL means "don't change". Common uses:

```sql
-- Pause without losing history
SELECT cron.alter_job(42, active := false);

-- Change schedule without re-creating
SELECT cron.alter_job(42, schedule := '*/30 * * * *');

-- Switch the SQL command
SELECT cron.alter_job(42, command := 'VACUUM ANALYZE events_partition_2026_06');
```

### Catalog Tables

Two tables, both in schema `cron`:

**`cron.job`** — one row per scheduled job:

| Column | Type | Notes |
|---|---|---|
| `jobid` | `bigint` | PK; auto-assigned by `cron.schedule()` |
| `schedule` | `text` | Cron expression |
| `command` | `text` | SQL to execute |
| `nodename` | `text` | Default `'localhost'` (Citus integration leftover) |
| `nodeport` | `int` | Default `5432` |
| `database` | `text` | Database to connect to |
| `username` | `text` | Role to run as |
| `active` | `boolean` | `true` = scheduler picks up |
| `jobname` | `text` | NULL for anonymous jobs |

Filtered by **Row-Level Security** so non-superuser roles see only their own jobs.

**`cron.job_run_details`** — one row per execution:

| Column | Type | Notes |
|---|---|---|
| `jobid` | `bigint` | FK to `cron.job` (not enforced — survives `unschedule`) |
| `runid` | `bigint` | Unique per execution |
| `job_pid` | `int` | Backend / bgworker PID |
| `database` | `text` | Effective database |
| `username` | `text` | Effective role |
| `command` | `text` | SQL text (snapshot at execution start) |
| `status` | `text` | `'starting'` / `'running'` / `'sending'` / `'connecting'` / `'succeeded'` / `'failed'` |
| `return_message` | `text` | Error text on failure, row count on success |
| `start_time` | `timestamptz` | When scheduler dispatched |
| `end_time` | `timestamptz` | When job exited |

Disable logging entirely with `cron.log_run = off` (postgresql.conf, restart). Disable error logging only with `cron.log_min_messages = LOG`.

### Cross-Database Scheduling

The pg_cron extension lives in **one database only** (the one named by `cron.database_name`). To schedule jobs that target other databases:

```sql
-- From the database where pg_cron is installed (e.g. 'postgres')
\c postgres

SELECT cron.schedule_in_database(
  'partman-app',                              -- job_name
  '0 1 * * *',                                -- schedule
  'CALL partman.run_maintenance_proc()',      -- command
  'app_db',                                   -- target database
  'partman_role'                              -- run as this role
);
```

Internally pg_cron's bgworker connects to `app_db` as `partman_role` via libpq for each execution.

### Execution Model

Two modes:

**Fork mode (default)** — for each scheduled execution, pg_cron forks a new backend, libpq-connects, runs the SQL, exits. ~5-50ms startup overhead per job. Bounded by `max_connections`.

**Background-worker mode** — `cron.use_background_workers = on` (postgresql.conf, restart). Persistent `bgworker` slots. Verbatim: `"the number of concurrent jobs is limited by the max_worker_processes setting, so you may need to raise that."` Faster for sub-minute schedules. Competes with parallel-query workers (`max_parallel_workers`), autovacuum workers (`autovacuum_max_workers`), logical-replication apply workers, and other extensions for the `max_worker_processes` budget — see [`63-internals-architecture.md`](./63-internals-architecture.md).

Concurrent job cap: `cron.max_running_jobs` (default 32). Beyond this, scheduler queues + runs as slots free up.

### HA / Failover

Verbatim README: `"Note that pg_cron does not run any jobs as a long a server is in hot standby mode, but it automatically starts when the server is promoted."`

Operational consequences:

1. **`cron.job` rows must be on the new primary at promotion time.** If `pg_cron` is installed in the streaming-replicated `postgres` database (default), rows replicate via physical replication automatically. **Logical replication** does NOT replicate the `cron.*` tables unless explicitly added to a publication.
2. **`shared_preload_libraries = 'pg_cron'` must be in the new primary's `postgresql.conf`.** Patroni / CloudNativePG normally template the same config to all nodes — verify.
3. **No job-state transfer.** Mid-execution jobs on the old primary are killed (the standby was not running them). The next scheduled fire on the new primary starts fresh.
4. **`cron.job_run_details` history may diverge.** Old primary's history not on standby unless replicated. Treat history as best-effort, not authoritative audit log.
5. **No "leader-election" mechanism.** If you somehow have two primaries (split-brain — see [`78-ha-architectures.md`](./78-ha-architectures.md)), both run jobs. pg_cron itself has no fencing.

### Configuration GUCs

| GUC | Default | Context | Notes |
|---|---|---|---|
| `cron.database_name` | `postgres` | postmaster | DB where extension installs + `cron.job` lives |
| `cron.timezone` | `GMT` | sighup | **Default is GMT, not UTC, not server-local** — always set explicitly |
| `cron.use_background_workers` | `off` | postmaster | Use bgworker slots instead of forking; restart required |
| `cron.max_running_jobs` | `32` | postmaster | Concurrent execution cap |
| `cron.log_run` | `on` | sighup | Whether to write to `cron.job_run_details` |
| `cron.log_statement` | `on` | sighup | Whether to log the SQL itself |
| `cron.log_min_messages` | `WARNING` | sighup | Bgworker log level |
| `cron.host` | `localhost` | sighup | Where the worker connects (Citus-coordinator scenarios) |
| `cron.launch_active_jobs` | `on` | sighup | v1.6.0+; set off to pause all without unscheduling |

> [!NOTE] PostgreSQL 18
> No PG18-specific GUCs — pg_cron is wholly external. The PG18 `idle_replication_slot_timeout` does not affect pg_cron (cross-reference [`75-replication-slots.md`](./75-replication-slots.md)).

### Per-Version Timeline

pg_cron versions track their own cadence — **not** PG major versions.

| pg_cron | Date | Highlights |
|---|---|---|
| v1.6.7 | 2025-09-04 | Fix GCC compile errors (latest stable at planning time) |
| v1.6.6 | 2025-09-04 | **PG18 support**; stop log spam; crash fix for unavailable jobs; FreeBSD 14.3 |
| v1.6.5 | 2024-12-12 | **Leap-year scheduling fix**; superuser check before adding job to CronJobHash |
| v1.6.4 | 2024-08-09 | `CachedCronJobRelationId` invalidation fix |
| v1.6.3 | 2024-07-23 | **Off-by-1 day-of-month fix**; deadlock prevention in launcher |
| v1.6.2 | 2023-10-20 | Off-by-1 day-of-month (partial fix — v1.6.3 needed) |
| v1.6.1 | 2023-09-28 | Scheduler restart-if-cancelled |
| v1.6.0 | 2023-08-29 | `cron.launch_active_jobs` GUC; PG16 support; **last-day-of-month `$` syntax** |
| v1.5.0 | 2023-02-07 | `[1-59] seconds` interval form; `cron.timezone` GUC |
| v1.4.x | 2021-2022 | PG14 / PG15 support |
| v1.3.x | 2020-2021 | PG13 support |

**PG14/15/16/17/18 release notes contain ZERO pg_cron items** — the extension is wholly external. Track upstream releases at `https://github.com/citusdata/pg_cron/releases`.

> [!WARNING] Versions before v1.6.5 have known scheduling bugs
> v1.6.5 fixed a **leap-year bug** that caused jobs to skip Feb 29 schedules. v1.6.3 fixed an **off-by-1 day-of-month** bug that caused first-of-month jobs to fire on the second. v1.6.0 added `$` for last-day-of-month — pre-v1.6.0 you had to write `0 23 28-31 * *` plus a guard. **Upgrade to v1.6.5+ for production**, ideally v1.6.6+ if on PG18.

## Examples / Recipes

### Recipe 1 — Production install + verify

postgresql.conf:

```
shared_preload_libraries = 'pg_cron'
cron.database_name = 'postgres'
cron.timezone = 'UTC'
cron.use_background_workers = on
cron.max_running_jobs = 64
cron.log_run = on
```

Restart, then:

```sql
\c postgres
CREATE EXTENSION pg_cron;
GRANT USAGE ON SCHEMA cron TO app_role;

SELECT extversion FROM pg_extension WHERE extname = 'pg_cron';
SELECT name, setting FROM pg_settings WHERE name LIKE 'cron.%';
```

### Recipe 2 — Nightly VACUUM ANALYZE on hot table

```sql
SELECT cron.schedule(
  'vacuum-events-nightly',
  '0 3 * * *',                              -- 03:00 in cron.timezone
  'VACUUM ANALYZE events'
);
```

For partitioned tables, vacuum hot partition only, not the parent (cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) Recipe 4 + [`35-partitioning.md`](./35-partitioning.md)):

```sql
SELECT cron.schedule(
  'vacuum-events-recent',
  '0 3 * * *',
  $$VACUUM (ANALYZE, PARALLEL 4) events_2026_05$$
);
```

### Recipe 3 — Refresh materialized view concurrently

```sql
-- Prerequisite: matview has unique index for CONCURRENTLY (cross-reference 05-views.md)
CREATE UNIQUE INDEX ON daily_metrics (metric_date);

SELECT cron.schedule(
  'mv-daily-metrics',
  '*/15 * * * *',                           -- every 15 minutes
  'REFRESH MATERIALIZED VIEW CONCURRENTLY daily_metrics'
);
```

### Recipe 4 — Cross-database job dispatching to pg_partman

```sql
-- pg_cron lives in 'postgres' DB; pg_partman lives in 'app_db'
\c postgres

SELECT cron.schedule_in_database(
  'partman-maintenance',
  '0 1 * * *',                              -- 01:00 daily
  $$CALL partman.run_maintenance_proc(p_jobmon := false)$$,
  'app_db',                                 -- target database
  'partman_role'                            -- run as this role
);
```

Verify (cross-reference [`99-pg-partman.md`](./99-pg-partman.md)):

```sql
SELECT jobid, jobname, database, username, active
FROM cron.job
WHERE jobname = 'partman-maintenance';
```

### Recipe 5 — Last day of month closing job

```sql
-- v1.6.0+ supports $ for last day
SELECT cron.schedule(
  'eom-close',
  '0 23 $ * *',                             -- 23:00 last day of month
  'CALL eom_close_books()'
);

-- Pre-v1.6.0 fallback (don't use if v1.6.0+ available)
SELECT cron.schedule(
  'eom-close-legacy',
  '0 23 28-31 * *',
  $$DO $body$
    BEGIN
      IF (CURRENT_DATE + 1)::date::text NOT LIKE (date_trunc('month', CURRENT_DATE) + interval '1 month')::date::text THEN
        RETURN;  -- not the last day, skip
      END IF;
      CALL eom_close_books();
    END
  $body$$$
);
```

### Recipe 6 — Sub-minute high-frequency job

```sql
-- Background-worker mode required for sub-minute (fork overhead too high)
ALTER SYSTEM SET cron.use_background_workers = on;
ALTER SYSTEM SET max_worker_processes = 32;          -- raise from default 8
-- restart required for both

SELECT cron.schedule(
  'cache-refresh',
  '30 seconds',                             -- every 30 seconds
  'CALL refresh_hot_cache()'
);
```

Verify the bgworker is dispatched, not a fork:

```sql
SELECT pid, backend_type, state, query
FROM pg_stat_activity
WHERE backend_type = 'background worker'
  AND application_name LIKE 'pg_cron%';
```

### Recipe 7 — Pause a job without losing history

```sql
-- Find the jobid
SELECT jobid FROM cron.job WHERE jobname = 'expensive-report';
--  jobid
-- -------
--      7

-- Pause
SELECT cron.alter_job(7, active := false);

-- Resume later
SELECT cron.alter_job(7, active := true);
```

Compare to `cron.unschedule()` which deletes the row + loses your `cron.job_run_details` history association.

### Recipe 8 — Diagnose why a job failed

```sql
SELECT
  start_time,
  end_time,
  end_time - start_time AS duration,
  status,
  return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'mv-daily-metrics')
ORDER BY start_time DESC
LIMIT 20;
```

Common failure shapes:

| `status` | `return_message` includes | Cause / fix |
|---|---|---|
| `failed` | `permission denied for relation X` | `username` lacks grant — fix grant or change username via `cron.alter_job` |
| `failed` | `canceling statement due to lock timeout` | Job blocked on lock (cross-reference [`43-locking.md`](./43-locking.md)) — add `SET lock_timeout` |
| `failed` | `connection terminated` | Failover happened mid-execution — check `pg_stat_activity` |
| `succeeded` (but slow) | `VACUUM` / `REFRESH MATERIALIZED VIEW` rows | Tune the underlying query, not pg_cron |
| `failed` | `another command is already in progress` | Job overran — use `cron.max_running_jobs` per-job or check overlap |

### Recipe 9 — Self-pruning job_run_details

```sql
-- Prevent unbounded growth — keep 30 days
SELECT cron.schedule(
  'prune-cron-history',
  '0 4 * * *',                              -- 04:00 daily
  $$DELETE FROM cron.job_run_details
    WHERE end_time < now() - interval '30 days'$$
);
```

Or disable logging entirely:

```
cron.log_run = off                          -- postgresql.conf, sighup
```

### Recipe 10 — Audit all jobs on the cluster

```sql
-- All jobs across all databases (pg_cron lives in one DB but dispatches everywhere)
SELECT
  j.jobid,
  j.jobname,
  j.schedule,
  j.database,
  j.username,
  j.active,
  COUNT(d.runid) FILTER (WHERE d.start_time > now() - interval '24 hours') AS runs_24h,
  COUNT(d.runid) FILTER (WHERE d.status = 'failed' AND d.start_time > now() - interval '24 hours') AS failures_24h,
  MAX(d.start_time) AS last_start
FROM cron.job j
LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
GROUP BY j.jobid
ORDER BY j.jobid;
```

### Recipe 11 — Rotate a partition + reindex (combined recipe)

```sql
-- Single-script recipe: drop oldest partition + create next month
SELECT cron.schedule_in_database(
  'rotate-events-partition',
  '0 2 1 * *',                              -- 02:00 first of month
  $$
    DO $body$
    DECLARE
      old_partition text := 'events_' || to_char(now() - interval '13 months', 'YYYY_MM');
      new_partition text := 'events_' || to_char(now() + interval '1 month', 'YYYY_MM');
      new_start date := date_trunc('month', now() + interval '1 month')::date;
      new_end date := date_trunc('month', now() + interval '2 months')::date;
    BEGIN
      EXECUTE format('DROP TABLE IF EXISTS %I', old_partition);
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
        new_partition, new_start, new_end
      );
    END
    $body$;
  $$,
  'app_db',
  'app_owner'
);
```

For declarative-partition lifecycle, prefer `pg_partman` + `cron.schedule_in_database()` (cross-reference [`99-pg-partman.md`](./99-pg-partman.md) Recipe 1).

### Recipe 12 — HA failover post-flight check

After Patroni / CloudNativePG promotes a standby:

```bash
# On the new primary
psql -c "SHOW shared_preload_libraries"
# Must include pg_cron

psql -c "SELECT count(*) FROM cron.job WHERE active = true"
# Must match pre-failover count

psql -c "SELECT pid, application_name FROM pg_stat_activity WHERE backend_type = 'background worker' AND application_name = 'pg_cron launcher'"
# pg_cron launcher should be running

# Wait for next scheduled job, then verify it ran
psql -c "SELECT jobid, status, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5"
```

Cross-reference [`79-patroni.md`](./79-patroni.md) for promotion + standby-failover sequence.

### Recipe 13 — Disable all jobs cluster-wide for maintenance

```sql
-- Soft-disable: pause all jobs without removing
ALTER SYSTEM SET cron.launch_active_jobs = off;
SELECT pg_reload_conf();
-- jobs in cron.job stay; scheduler skips all firings

-- Re-enable
ALTER SYSTEM SET cron.launch_active_jobs = on;
SELECT pg_reload_conf();
```

Or per-job:

```sql
UPDATE cron.job SET active = false;         -- pause all
UPDATE cron.job SET active = true;          -- resume all
```

## Gotchas / Anti-patterns

1. **`shared_preload_libraries` requires server restart.** `pg_cron` cannot be installed via `CREATE EXTENSION` alone — postmaster must already have loaded the library at startup. `ALTER SYSTEM SET shared_preload_libraries = 'pg_cron'` then `pg_reload_conf()` does **not** take effect — a full `pg_ctl restart` is required (cross-reference [`53-server-configuration.md`](./53-server-configuration.md) gotcha #4).

2. **`cron.timezone` defaults to GMT, not UTC, not local.** A `'0 2 * * *'` job in default config runs at 02:00 GMT, which may be 21:00 / 19:00 / 03:00 / 11:00 in your local zone depending on DST. Always set `cron.timezone` explicitly in postgresql.conf.

3. **pg_cron may only be installed in ONE database per cluster.** `CREATE EXTENSION pg_cron` in two databases gives the second one a confused half-install. Use `cron.schedule_in_database()` for cross-database dispatch.

4. **`cron.job_run_details` grows unbounded by default.** No automatic pruning. Self-prune via Recipe 9 or set `cron.log_run = off`. On busy clusters this table can hit GBs/day.

5. **HA failover skips in-flight jobs.** A job mid-execution on the old primary is killed when the new primary promotes. The next scheduled fire starts fresh from the new primary's `cron.job` rows. No checkpoint / resume — design jobs to be idempotent.

6. **`cron.use_background_workers` competes with autovacuum and parallel queries for `max_worker_processes`.** Default `max_worker_processes = 8` includes autovacuum (default 3) + parallel-query workers + logical-replication apply workers + extensions. Bump to 32-64 when enabling bgworker mode (cross-reference [`63-internals-architecture.md`](./63-internals-architecture.md)).

7. **`[interval] seconds` form cannot be combined with other cron fields.** `'30 seconds * * * *'` is invalid — must be just `'30 seconds'`. The two syntaxes are mutually exclusive.

8. **`$` (last-day-of-month) requires v1.6.0+.** Pre-v1.6.0 you have to use `28-31` + an in-script guard checking `EXTRACT(DAY FROM CURRENT_DATE + 1) = 1`.

9. **Versions before v1.6.5 have known scheduling bugs.** v1.6.5 fixed leap-year (Feb 29 schedules silently skipped). v1.6.3 fixed off-by-1 day-of-month (first-of-month jobs ran on the second). Upgrade to v1.6.5+ minimum, v1.6.6+ for PG18.

10. **`cron.job` rows must replicate to standbys.** Default install in the `postgres` database — physical streaming replication carries the rows automatically. **Logical replication does NOT replicate the `cron.*` schema** unless explicitly added to a publication (cross-reference [`74-logical-replication.md`](./74-logical-replication.md)).

11. **Jobs run as the `username` recorded in `cron.job`.** If you `cron.schedule()` without specifying username, it uses the role that called `cron.schedule()`. Schedule-time role ≠ runtime role — verify via `SELECT username FROM cron.job WHERE jobid = X`.

12. **`SECURITY DEFINER` functions don't help with cross-database jobs.** `cron.schedule_in_database()` connects via libpq with the specified `username` — that role must exist in the target database with the necessary grants. Cannot wrap in a `SECURITY DEFINER` function in the source database to elevate.

13. **`cron.unschedule()` does not cascade to `cron.job_run_details`.** History rows stay (the FK is not enforced). Re-using the same `jobname` later may produce confusing history queries — filter by `jobid` not `jobname`.

14. **`cron.schedule()` is idempotent on `jobname`.** Re-running `cron.schedule('foo', schedule, command)` with the same `jobname` **replaces** the existing job, doesn't create a duplicate. This is intentional for migration scripts but can surprise.

15. **Anonymous jobs (no `jobname`) cannot be deduplicated.** Calling `cron.schedule(schedule, command)` twice creates two jobs both running the same SQL. Always use the named form.

16. **`cron.alter_job()` cannot change `jobname`.** Drop + re-add to rename.

17. **`pg_dump` does NOT dump `cron.job` rows by default.** They live in a contrib extension's tables — captured by `pg_dump --extension pg_cron` or `pg_dumpall --globals-only` does NOT include them. Restoring to a new cluster requires re-running `cron.schedule()` calls (cross-reference [`83-backup-pg-dump.md`](./83-backup-pg-dump.md)).

18. **No `@every 5m` / `@hourly` / `@daily` shortcut macros** like Vixie cron. pg_cron only accepts the 5-field standard syntax + the `[N] seconds` form. `@daily` errors.

19. **Concurrent execution cap is per-job-class, not per-job.** `cron.max_running_jobs = 32` means total concurrent jobs across all definitions. Two `* * * * *` jobs that each take 90 seconds will queue, not parallelize, beyond the cap.

20. **No "run job once" mechanism.** pg_cron is recurring-only. Workarounds: schedule + `cron.alter_job(active := false)` from the job itself after first run, or use `cron.unschedule()` from the job body (which deletes the row before the function returns — works but feels unsafe).

21. **Background-worker mode under heavy load can deadlock with logical-replication apply workers** (rare). Both compete for the same `max_worker_processes` budget. Bump generously and monitor `pg_stat_activity` for `backend_type = 'background worker'` saturation.

22. **`cron.timezone` change requires reload, not restart.** `ALTER SYSTEM SET cron.timezone = 'America/New_York'; SELECT pg_reload_conf();` works — but jobs already mid-execution use the old value until they end.

23. **`cron.host = 'localhost'` is a Citus-coordinator leftover.** On a standalone cluster, leaving it alone is fine. In a Citus cluster, see [`97-citus.md`](./97-citus.md) for the multi-node scheduler pattern.

## See Also

- [`05-views.md`](./05-views.md) — `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires unique index
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — scheduled VACUUM + autovacuum interaction
- [`35-partitioning.md`](./35-partitioning.md) — partition rotation patterns
- [`43-locking.md`](./43-locking.md) — `lock_timeout` for scheduled DDL
- [`46-roles-privileges.md`](./46-roles-privileges.md) — role grants for `username` parameter
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries` postmaster context
- [`56-explain.md`](./56-explain.md) — diagnose slow scheduled queries
- [`63-internals-architecture.md`](./63-internals-architecture.md) — `max_worker_processes` budget
- [`69-extensions.md`](./69-extensions.md) — `CREATE EXTENSION` mechanics
- [`74-logical-replication.md`](./74-logical-replication.md) — `cron.*` not replicated by default
- [`75-replication-slots.md`](./75-replication-slots.md) — slot-related scheduled audits
- [`77-standby-failover.md`](./77-standby-failover.md) — promotion mechanics
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA pattern catalog
- [`79-patroni.md`](./79-patroni.md) — Patroni-managed HA + post-failover checks
- [`82-monitoring.md`](./82-monitoring.md) — monitoring scheduled-job failures
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — pg_dump + extension data
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — operator-managed scheduled backups vs pg_cron
- [`96-timescaledb.md`](./96-timescaledb.md) — TimescaleDB built-in per-database scheduler as the main alternative to pg_cron
- [`97-citus.md`](./97-citus.md) — pg_cron in Citus coordinator setup
- [`99-pg-partman.md`](./99-pg-partman.md) — pg_cron + pg_partman canonical pairing
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version context; pg_cron evolves on its own cadence outside PG14-18 release notes
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — `shared_preload_libraries` requirement and vendor allowlist portability for pg_cron

## Sources

[^1]: pg_cron README — `https://github.com/citusdata/pg_cron/blob/main/README.md` — function signatures, cron syntax, configuration GUCs, HA behavior, single-database-per-cluster restriction. Verbatim quotes preserved including the typo `"as a long a server is in hot standby"`.

[^2]: pg_cron releases page — `https://github.com/citusdata/pg_cron/releases` — version timeline. Latest **v1.6.7** released 2025-09-04 (GCC fix). v1.6.6 (same day) added PG18 support. v1.6.5 (2024-12-12) fixed leap-year scheduling bug.

[^3]: pg_cron CHANGELOG — `https://github.com/citusdata/pg_cron/blob/main/CHANGELOG.md` — per-version notes including off-by-1 day-of-month fix in v1.6.3, last-day-of-month `$` syntax in v1.6.0, `[1-59] seconds` form + `cron.timezone` GUC in v1.5.0.

[^4]: PG14 release notes — `https://www.postgresql.org/docs/release/14.0/` — verified zero pg_cron items.

[^5]: PG15 release notes — `https://www.postgresql.org/docs/release/15.0/` — verified zero pg_cron items.

[^6]: PG16 release notes — `https://www.postgresql.org/docs/release/16.0/` — verified zero pg_cron items.

[^7]: PG17 release notes — `https://www.postgresql.org/docs/release/17.0/` — verified zero pg_cron items.

[^8]: PG18 release notes — `https://www.postgresql.org/docs/release/18.0/` — verified zero pg_cron items.

[^9]: pg_cron repo home — `https://github.com/citusdata/pg_cron` — Apache-2.0 license, Citus / Microsoft maintained, provider-agnostic.

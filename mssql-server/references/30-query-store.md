# 30 — Query Store

## Table of Contents

1. [When to Use](#when-to-use)
2. [Enabling and Configuring](#enabling-and-configuring)
3. [Query Store Internals](#query-store-internals)
4. [Core sys.query_store_* Views](#core-sysquery_store_-views)
5. [Finding Regressed Queries](#finding-regressed-queries)
6. [Forcing Plans](#forcing-plans)
7. [Plan Variants and Multiple Plans per Query](#plan-variants-and-multiple-plans-per-query)
8. [Parameter-Sensitive Plan Optimization (PSPO)](#parameter-sensitive-plan-optimization-pspo)
9. [Wait Stats Integration](#wait-stats-integration)
10. [Cardinality Estimation Feedback](#cardinality-estimation-feedback)
11. [Memory Grant Feedback Persistence](#memory-grant-feedback-persistence)
12. [Custom Capture Policies](#custom-capture-policies)
13. [Query Store in Azure SQL](#query-store-in-azure-sql)
14. [Clearing Stale Data](#clearing-stale-data)
15. [Maintenance and Sizing](#maintenance-and-sizing)
16. [Common Query Patterns](#common-query-patterns)
17. [Gotchas](#gotchas)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

Load this file when the user asks about:
- Query Store: enabling, configuring, reading, or querying
- Plan regression identification and forced plans
- Parameter-sensitive plan optimization (PSPO)
- Wait stats per query (not just instance-level)
- CE feedback, memory grant feedback persistence
- Azure SQL Query Store differences
- `sys.query_store_*` views

---

## Enabling and Configuring

### Enable on a database

```sql
ALTER DATABASE YourDatabase
SET QUERY_STORE = ON
    (
      OPERATION_MODE          = READ_WRITE,
      CLEANUP_POLICY          = (STALE_QUERY_THRESHOLD_DAYS = 30),
      DATA_FLUSH_INTERVAL_SECONDS = 900,          -- flush to disk every 15 min
      INTERVAL_LENGTH_MINUTES = 60,               -- aggregation interval
      MAX_STORAGE_SIZE_MB     = 1000,
      QUERY_CAPTURE_MODE      = AUTO,             -- or ALL / CUSTOM / NONE
      SIZE_BASED_CLEANUP_MODE = AUTO,
      MAX_PLANS_PER_QUERY     = 200,
      WAIT_STATS_CAPTURE_MODE = ON               -- 2017+
    );
```

> [!NOTE] SQL Server 2019
> `QUERY_CAPTURE_MODE = CUSTOM` and fine-grained capture policies were added in SQL Server 2019.

> [!NOTE] SQL Server 2022
> Query Store is enabled **by default** for newly created databases in SQL Server 2022 (compat level 160). It remains off by default for databases restored/upgraded from earlier versions until explicitly enabled.

### Key options explained

| Option | Default | Guidance |
|--------|---------|----------|
| `OPERATION_MODE` | `READ_WRITE` | Set to `READ_ONLY` to preserve data during troubleshooting without losing it; `OFF` disables capture |
| `CLEANUP_POLICY` | 30 days | Extend to 90 days for trend analysis; reduce to 7 days on storage-constrained systems |
| `DATA_FLUSH_INTERVAL_SECONDS` | 900 (15 min) | Data lives in memory until flushed; crash between flushes loses that window |
| `INTERVAL_LENGTH_MINUTES` | 60 | Smaller = more granular timeline but more storage; 15 min is good for high-churn workloads |
| `MAX_STORAGE_SIZE_MB` | 100 (on-prem default) | Set 500–2000 MB for production. When full, mode switches to `READ_ONLY` |
| `QUERY_CAPTURE_MODE` | `AUTO` | `AUTO` filters one-off queries by execution count/CPU; `ALL` captures everything (noisy) |
| `MAX_PLANS_PER_QUERY` | 200 | Prevent single recompile-happy query from filling storage |
| `WAIT_STATS_CAPTURE_MODE` | `ON` | Keep ON — per-query wait stats are invaluable for diagnosis |

### Check current configuration

```sql
SELECT name, is_query_store_on,
       actual_state_desc,
       desired_state_desc,
       current_storage_size_mb,
       max_storage_size_mb,
       query_capture_mode_desc,
       size_based_cleanup_mode_desc,
       stale_query_threshold_days,
       wait_stats_capture_mode_desc
FROM sys.databases
WHERE name = DB_NAME();
```

---

## Query Store Internals

Query Store captures data at three levels:

```
┌──────────────────────────────────────────────────────────┐
│  sys.query_store_query_text   (unique SQL text + hash)   │
│    └─► sys.query_store_query  (parameterized query hash) │
│           └─► sys.query_store_plan  (one row per plan)   │
│                  └─► sys.query_store_runtime_stats        │
│                         (aggregated per interval)         │
│                  └─► sys.query_store_wait_stats           │
│                         (wait categories per interval)    │
└──────────────────────────────────────────────────────────┘
```

**Data flow:**
1. Query compiles → entry in `query_store_query_text` and `query_store_plan`
2. Query executes → runtime stats buffered in memory
3. Every `DATA_FLUSH_INTERVAL_SECONDS` → flushed to on-disk tables inside the database (not tempdb)
4. Every `INTERVAL_LENGTH_MINUTES` → aggregated into `query_store_runtime_stats`

**Storage location:** Query Store data lives in the user database itself (special internal filegroup). It survives detach/attach and backup/restore.

---

## Core sys.query_store_* Views

| View | Key Columns | Purpose |
|------|------------|---------|
| `sys.query_store_query_text` | `query_text_id`, `query_sql_text`, `query_hash` | Raw SQL text |
| `sys.query_store_query` | `query_id`, `query_text_id`, `query_hash`, `object_id` | One row per logical query |
| `sys.query_store_plan` | `plan_id`, `query_id`, `query_plan` (XML), `is_forced_plan` | One row per plan variant |
| `sys.query_store_runtime_stats` | `plan_id`, `runtime_stats_interval_id`, `avg_duration`, `avg_logical_io_reads`, `count_executions` | Aggregated execution metrics |
| `sys.query_store_runtime_stats_interval` | `runtime_stats_interval_id`, `start_time`, `end_time` | Time intervals |
| `sys.query_store_wait_stats` | `plan_id`, `wait_category`, `total_query_wait_time_ms` | Per-plan wait breakdown |
| `sys.query_store_context_settings` | `context_settings_id`, `set_options`, `language_id` | SET options at capture time |

### Quick lookup: find a query by text

```sql
SELECT qsq.query_id, qsqt.query_sql_text,
       qsp.plan_id, qsp.is_forced_plan,
       qsp.query_plan
FROM sys.query_store_query_text  qsqt
JOIN sys.query_store_query       qsq  ON qsq.query_text_id = qsqt.query_text_id
JOIN sys.query_store_plan        qsp  ON qsp.query_id      = qsq.query_id
WHERE qsqt.query_sql_text LIKE N'%OrderDetails%';
```

---

## Finding Regressed Queries

### Top 20 queries by average duration (last 24 hours)

```sql
SELECT TOP 20
    qsqt.query_sql_text,
    qsq.query_id,
    qsp.plan_id,
    qsrs.avg_duration          / 1000.0 AS avg_duration_ms,
    qsrs.max_duration          / 1000.0 AS max_duration_ms,
    qsrs.avg_logical_io_reads,
    qsrs.avg_cpu_time          / 1000.0 AS avg_cpu_ms,
    qsrs.count_executions,
    qsrsi.start_time,
    qsrsi.end_time
FROM sys.query_store_query_text          qsqt
JOIN sys.query_store_query               qsq  ON qsq.query_text_id          = qsqt.query_text_id
JOIN sys.query_store_plan                qsp  ON qsp.query_id               = qsq.query_id
JOIN sys.query_store_runtime_stats       qsrs ON qsrs.plan_id               = qsp.plan_id
JOIN sys.query_store_runtime_stats_interval qsrsi ON qsrsi.runtime_stats_interval_id = qsrs.runtime_stats_interval_id
WHERE qsrsi.start_time >= DATEADD(HOUR, -24, GETUTCDATE())
ORDER BY qsrs.avg_duration DESC;
```

> [!NOTE]
> All `duration` and `cpu_time` values in `query_store_runtime_stats` are in **microseconds**. Divide by 1000 for milliseconds.

### Detect plan regression: query that got worse after a plan change

```sql
-- Queries where the current plan is slower than the best historical plan
WITH best_plan AS (
    SELECT qsq.query_id,
           MIN(qsrs.avg_duration) AS best_avg_duration_us,
           MIN(qsrs.plan_id)      AS best_plan_id          -- tie-break to a plan_id
    FROM sys.query_store_query         qsq
    JOIN sys.query_store_plan          qsp  ON qsp.query_id = qsq.query_id
    JOIN sys.query_store_runtime_stats qsrs ON qsrs.plan_id = qsp.plan_id
    GROUP BY qsq.query_id
),
recent_plan AS (
    SELECT qsq.query_id,
           qsp.plan_id,
           AVG(qsrs.avg_duration) AS recent_avg_duration_us
    FROM sys.query_store_query               qsq
    JOIN sys.query_store_plan                qsp  ON qsp.query_id               = qsq.query_id
    JOIN sys.query_store_runtime_stats       qsrs ON qsrs.plan_id               = qsp.plan_id
    JOIN sys.query_store_runtime_stats_interval qsrsi
         ON qsrsi.runtime_stats_interval_id = qsrs.runtime_stats_interval_id
    WHERE qsrsi.start_time >= DATEADD(HOUR, -4, GETUTCDATE())
    GROUP BY qsq.query_id, qsp.plan_id
)
SELECT  r.query_id,
        r.plan_id                            AS current_plan_id,
        b.best_plan_id,
        r.recent_avg_duration_us / 1000.0   AS current_avg_ms,
        b.best_avg_duration_us   / 1000.0   AS best_avg_ms,
        r.recent_avg_duration_us * 1.0
          / NULLIF(b.best_avg_duration_us,0) AS regression_ratio
FROM recent_plan r
JOIN best_plan   b ON b.query_id = r.query_id
WHERE r.recent_avg_duration_us > b.best_avg_duration_us * 1.5  -- 50% worse
ORDER BY regression_ratio DESC;
```

---

## Forcing Plans

### Force a specific plan

```sql
-- Force plan_id 42 for query_id 7
EXEC sys.sp_query_store_force_plan
    @query_id = 7,
    @plan_id  = 42;
```

### Unforce a plan

```sql
EXEC sys.sp_query_store_unforce_plan
    @query_id = 7,
    @plan_id  = 42;
```

### Check all forced plans

```sql
SELECT qsq.query_id,
       qsp.plan_id,
       qsp.force_failure_count,
       qsp.last_force_failure_reason_desc,
       qsqt.query_sql_text
FROM sys.query_store_plan        qsp
JOIN sys.query_store_query       qsq  ON qsq.query_id     = qsp.query_id
JOIN sys.query_store_query_text  qsqt ON qsqt.query_text_id = qsq.query_text_id
WHERE qsp.is_forced_plan = 1;
```

> [!WARNING]
> Forced plans can fail silently if the plan becomes invalid (e.g., an index it references is dropped). When forcing fails, SQL Server falls back to a new plan — `force_failure_count` increments and `last_force_failure_reason_desc` is populated. Monitor this column.

**Plan forcing vs USE PLAN hint:**
- Query Store plan forcing survives restarts, survives plan cache flushes, is operator-undoable
- `USE PLAN` hint requires modifying the query text or using a plan guide — prefer Query Store forcing

**Prefer Query Store forcing over manual plan guides for production.** Only use `USE PLAN` when you need to force a plan that Query Store hasn't captured yet.

---

## Plan Variants and Multiple Plans per Query

A single `query_id` can have multiple `plan_id` rows — each represents a distinct compiled plan. Common causes:
- Parameter sniffing (different first-run parameters → different plans)
- SET option changes (e.g., `ARITHABORT` ON vs OFF — ADO.NET vs SSMS default)
- Schema changes triggering recompile
- Statistics updates

```sql
-- Show all plans for a query with their avg duration
SELECT qsp.plan_id,
       qsp.is_forced_plan,
       qsp.engine_version,
       qsp.compatibility_level,
       AVG(qsrs.avg_duration) / 1000.0 AS avg_duration_ms,
       SUM(qsrs.count_executions)       AS total_executions
FROM sys.query_store_plan          qsp
JOIN sys.query_store_runtime_stats qsrs ON qsrs.plan_id = qsp.plan_id
WHERE qsp.query_id = 7
GROUP BY qsp.plan_id, qsp.is_forced_plan, qsp.engine_version, qsp.compatibility_level
ORDER BY avg_duration_ms;
```

---

## Parameter-Sensitive Plan Optimization (PSPO)

> [!NOTE] SQL Server 2022
> PSPO is a 2022+ feature (compat level 160 required). It is an Intelligent Query Processing (IQP) feature.

**Problem it solves:** A single query with a wide cardinality range (e.g., `WHERE OrderStatusId = @status` where status 1 has 1M rows and status 9 has 10 rows) gets one cached plan that is wrong for most parameter values.

**How PSPO works:**
1. The optimizer detects that a parameter spans multiple "plan dispatcher" ranges
2. It creates a **dispatcher plan** that routes to one of N **variant plans** based on the actual runtime value
3. Each variant plan is optimized for that parameter range (e.g., scan for large ranges, seek for small)

```sql
-- Verify PSPO is active for a query (look for PlanVariant attribute in plan XML)
SELECT qsp.query_plan
FROM sys.query_store_plan  qsp
JOIN sys.query_store_query qsq ON qsq.query_id = qsp.query_id
WHERE qsq.query_id = @query_id
  AND qsp.plan_type_desc = 'Dispatcher';
```

**PSPO plan types in Query Store:**

| `plan_type_desc` | Meaning |
|-----------------|---------|
| `Compiled Plan` | Normal plan (PSPO not active for this query) |
| `Dispatcher` | PSPO dispatcher plan — routes to variants |
| `Compiled Plan Stub` | Variant plan shell |

**Disable PSPO for a specific query:**

```sql
SELECT ... OPTION (USE HINT ('DISABLE_OPTIMIZED_PLAN_FORCING'));
-- or at database level:
ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SENSITIVE_PLAN_OPTIMIZATION = OFF;
```

---

## Wait Stats Integration

> [!NOTE] SQL Server 2017
> Per-query wait stats via `sys.query_store_wait_stats` require SQL Server 2017+ and `WAIT_STATS_CAPTURE_MODE = ON`.

```sql
-- Top wait categories for a specific query
SELECT qsws.wait_category_desc,
       SUM(qsws.total_query_wait_time_ms)  AS total_wait_ms,
       SUM(qsws.avg_query_wait_time_ms)    AS avg_wait_ms,
       COUNT(*)                             AS sample_count
FROM sys.query_store_wait_stats            qsws
JOIN sys.query_store_runtime_stats_interval qsrsi
     ON qsrsi.runtime_stats_interval_id = qsws.runtime_stats_interval_id
WHERE qsws.plan_id = @plan_id
  AND qsrsi.start_time >= DATEADD(HOUR, -24, GETUTCDATE())
GROUP BY qsws.wait_category_desc
ORDER BY total_wait_ms DESC;
```

**Key wait categories:**

| Category | Likely cause |
|----------|-------------|
| `CPU` | High CPU / bad plan, missing index |
| `Lock` | Lock contention, blocking |
| `Latch` | Tempdb allocation contention (see 34-tempdb.md) |
| `Buffer IO` | Physical reads, missing indexes, buffer pool pressure |
| `Network IO` | Large result sets, slow client |
| `Parallelism` | CXPACKET/CXCONSUMER — DOP or parallel plan issue |
| `Memory` | Memory grant spills to tempdb |
| `Log IO` | Heavy write workload, log on slow disk |

Unlike `sys.dm_os_wait_stats` (instance-level, resets on restart), Query Store wait stats are **per plan per interval** and persist across restarts — invaluable for trend analysis.

---

## Cardinality Estimation Feedback

> [!NOTE] SQL Server 2022
> CE feedback is a 2022+ IQP feature (compat level 160 required).

**How it works:**
1. Optimizer estimates cardinality for a plan
2. At runtime, actual row counts are compared to estimates
3. If estimates are consistently wrong, the optimizer adjusts the model assumptions for that query
4. The adjusted model is persisted in Query Store

**Verify CE feedback is active:**

```sql
SELECT qsqh.query_hint_id,
       qsqh.query_id,
       qsqh.query_hint_text,
       qsqh.source_desc
FROM sys.query_store_query_hints qsqh
WHERE qsqh.source_desc = 'CE Feedback';
```

**Disable CE feedback (database level):**

```sql
ALTER DATABASE SCOPED CONFIGURATION SET CE_FEEDBACK = OFF;
```

---

## Memory Grant Feedback Persistence

> [!NOTE] SQL Server 2022
> Persistent memory grant feedback (MGF) stores feedback in Query Store across restarts. Row-mode MGF requires SQL Server 2019+. Batch-mode MGF requires SQL Server 2017+. Percentile MGF (2022) is more stable than row-by-row adjustment.

**Without persistence (pre-2022):** MGF adjustments live only in plan cache — lost on restart or cache eviction.

**With persistence (2022+):** Adjustments are stored in `sys.query_store_plan_feedback`.

```sql
SELECT qspf.plan_id,
       qspf.feature_desc,
       qspf.feedback_data,
       qspf.state_desc
FROM sys.query_store_plan_feedback qspf
WHERE qspf.feature_desc = 'Memory Grant';
```

**Disable persistent MGF:**

```sql
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERCENTILE = OFF;
ALTER DATABASE SCOPED CONFIGURATION SET MEMORY_GRANT_FEEDBACK_PERSISTENCE = OFF;
```

---

## Custom Capture Policies

> [!NOTE] SQL Server 2019
> `QUERY_CAPTURE_MODE = CUSTOM` with fine-grained thresholds requires SQL Server 2019+ (compat level 150+).

```sql
ALTER DATABASE YourDatabase
SET QUERY_STORE = ON
    (
      QUERY_CAPTURE_MODE = CUSTOM,
      QUERY_CAPTURE_POLICY = (
          STALE_CAPTURE_POLICY_THRESHOLD = 24 HOURS,
          EXECUTION_COUNT  = 30,              -- min executions before capture
          TOTAL_COMPILE_CPU_TIME_MS = 1000,   -- min compile CPU
          TOTAL_EXECUTION_CPU_TIME_MS = 5000  -- min execution CPU
      )
    );
```

**When to use `AUTO` vs `CUSTOM` vs `ALL`:**

| Mode | Use case |
|------|----------|
| `AUTO` | Default; filters noise well; start here |
| `ALL` | Short-term capture during active investigation; very high storage use |
| `CUSTOM` | Fine-tune thresholds when `AUTO` misses important low-frequency queries |
| `NONE` | Stop new captures but keep existing data (e.g., read-only troubleshooting) |

---

## Query Store in Azure SQL

Azure SQL Database and Azure SQL Managed Instance have Query Store enabled by default and cannot disable it (for Azure SQL Database). Key differences:

| Feature | On-Prem (2022) | Azure SQL Database | Azure SQL MI |
|---------|---------------|-------------------|--------------|
| Enabled by default | New DBs only | Always on | Always on |
| Can disable | Yes | No | Yes |
| PSPO | Yes (compat 160) | Yes | Yes |
| CE feedback | Yes (compat 160) | Yes | Yes |
| Automatic tuning | No | Yes (auto force plan) | Partial |
| Automatic plan correction | No | Yes | No |
| `MAX_STORAGE_SIZE_MB` default | 100 | 100 (scales with service tier) | 100 |

**Azure SQL automatic tuning** uses Query Store as its data source. It can automatically force plans when regressions are detected and automatically unforce if the forced plan also regresses:

```sql
-- Check automatic tuning recommendations
SELECT name, reason, score, JSON_VALUE(details, '$.implementationDetails.script') AS fix_script
FROM sys.dm_db_tuning_recommendations
ORDER BY score DESC;
```

---

## Clearing Stale Data

### Remove a specific query and all its data

```sql
-- Remove query (cascades to plans and runtime stats)
EXEC sys.sp_query_store_remove_query @query_id = 7;
```

### Remove a specific plan

```sql
EXEC sys.sp_query_store_remove_plan @plan_id = 42;
```

### Reset runtime statistics (keep plans, clear stats)

```sql
-- Reset for all queries
EXEC sys.sp_query_store_reset_exec_stats;

-- Reset for a specific plan
EXEC sys.sp_query_store_reset_exec_stats @plan_id = 42;
```

### Flush in-memory data to disk (useful before investigation)

```sql
EXEC sys.sp_query_store_flush_db;
```

### Complete purge (nuclear option)

```sql
ALTER DATABASE YourDatabase SET QUERY_STORE CLEAR ALL;
```

> [!WARNING]
> `QUERY_STORE CLEAR ALL` destroys all Query Store data including forced plans. Do not run in production without confirming with stakeholders.

---

## Maintenance and Sizing

### Estimate current size

```sql
SELECT current_storage_size_mb,
       max_storage_size_mb,
       CAST(current_storage_size_mb * 100.0 / max_storage_size_mb AS DECIMAL(5,1)) AS pct_full,
       actual_state_desc,
       readonly_reason
FROM sys.databases
WHERE name = DB_NAME();
```

**`readonly_reason` values when `actual_state_desc = READ_ONLY`:**

| `readonly_reason` | Meaning |
|------------------|---------|
| 0 | Not read-only |
| 2 | Size limit reached |
| 4 | Internal error |
| 8 | `OPERATION_MODE = READ_ONLY` set manually |
| 65536 | Cleanup couldn't keep up |

When Query Store goes read-only due to size, new query data is **silently discarded**. Monitor `pct_full` and alert above 80%.

### Automatic cleanup

Query Store auto-removes data older than `STALE_QUERY_THRESHOLD_DAYS` and, when `SIZE_BASED_CLEANUP_MODE = AUTO`, aggressively purges oldest data when near capacity. Auto-cleanup runs in the background and does not require manual intervention, but **check it's actually running** via `actual_state_desc`.

### Sizing guidance

| Workload | Recommended `MAX_STORAGE_SIZE_MB` |
|----------|----------------------------------|
| Dev/test | 100–200 |
| Small OLTP | 500 |
| Medium OLTP | 1000–2000 |
| High-churn OLTP | 2000–5000 |
| DWH (low query variety) | 200–500 |

Increase `MAX_STORAGE_SIZE_MB` if you need longer retention or are using `ALL` capture mode.

---

## Common Query Patterns

### Top 10 queries by total CPU (last hour)

```sql
SELECT TOP 10
    qsqt.query_sql_text,
    qsq.query_id,
    SUM(qsrs.count_executions)              AS total_executions,
    SUM(qsrs.avg_cpu_time * qsrs.count_executions) / 1e6 AS total_cpu_sec,
    AVG(qsrs.avg_cpu_time) / 1000.0         AS avg_cpu_ms
FROM sys.query_store_query_text          qsqt
JOIN sys.query_store_query               qsq  ON qsq.query_text_id          = qsqt.query_text_id
JOIN sys.query_store_plan                qsp  ON qsp.query_id               = qsq.query_id
JOIN sys.query_store_runtime_stats       qsrs ON qsrs.plan_id               = qsp.plan_id
JOIN sys.query_store_runtime_stats_interval qsrsi
     ON qsrsi.runtime_stats_interval_id = qsrs.runtime_stats_interval_id
WHERE qsrsi.start_time >= DATEADD(HOUR, -1, GETUTCDATE())
GROUP BY qsqt.query_sql_text, qsq.query_id
ORDER BY total_cpu_sec DESC;
```

### Queries with the most plan variations (plan instability signal)

```sql
SELECT qsq.query_id,
       COUNT(DISTINCT qsp.plan_id) AS plan_count,
       qsqt.query_sql_text
FROM sys.query_store_query       qsq
JOIN sys.query_store_plan        qsp  ON qsp.query_id     = qsq.query_id
JOIN sys.query_store_query_text  qsqt ON qsqt.query_text_id = qsq.query_text_id
GROUP BY qsq.query_id, qsqt.query_sql_text
HAVING COUNT(DISTINCT qsp.plan_id) > 3
ORDER BY plan_count DESC;
```

### Queries with implicit conversion warnings in their plans

```sql
SELECT qsq.query_id,
       qsp.plan_id,
       qsqt.query_sql_text
FROM sys.query_store_plan        qsp
JOIN sys.query_store_query       qsq  ON qsq.query_id     = qsp.query_id
JOIN sys.query_store_query_text  qsqt ON qsqt.query_text_id = qsq.query_text_id
WHERE CAST(qsp.query_plan AS NVARCHAR(MAX))
      LIKE '%<PlanAffectingConvert%ConvertIssue="ImplicitConvert"%';
```

### Queries associated with a specific stored procedure

```sql
SELECT qsq.query_id,
       qsp.plan_id,
       qsqt.query_sql_text,
       OBJECT_NAME(qsq.object_id) AS proc_name
FROM sys.query_store_query      qsq
JOIN sys.query_store_plan       qsp  ON qsp.query_id     = qsq.query_id
JOIN sys.query_store_query_text qsqt ON qsqt.query_text_id = qsq.query_text_id
WHERE qsq.object_id = OBJECT_ID('dbo.usp_GetOrders');
```

---

## Gotchas

1. **Query Store data is in microseconds.** `avg_duration`, `avg_cpu_time`, `total_query_wait_time_ms` — duration/cpu are microseconds, wait_time is milliseconds. Divide by 1000 for ms or 1e6 for seconds.

2. **`QUERY_CAPTURE_MODE = AUTO` may miss important queries.** Queries that run infrequently but are critical (e.g., nightly reports, once-a-day jobs) may not meet `AUTO`'s execution-count threshold. Use `CUSTOM` or `ALL` capture mode during investigation windows, then revert.

3. **Query Store goes read-only silently when full.** New query data is silently dropped. You won't see an error — queries just stop appearing. Always monitor `current_storage_size_mb` vs `max_storage_size_mb`.

4. **Forced plan fails silently.** If a forced plan can't be applied (missing index, statistics changed), SQL Server compiles a new plan and increments `force_failure_count`. The query still runs — but not with your intended plan. Always check `last_force_failure_reason_desc` after forcing a plan.

5. **SET options affect which plan is reused.** ADO.NET sets `ARITHABORT OFF` by default while SSMS sets it ON. These create separate `query_hash` values, so the same query text may appear as multiple rows in Query Store with different context settings. This is a common source of "why does SSMS run fast but the app is slow?"

6. **`query_sql_text` may be parameterized or literal depending on autoparameterization.** Simple queries get autoparameterized by SQL Server — the stored text may show `@p0` instead of your literal value. Don't rely on text pattern matching for exact identification — use `query_id` once found.

7. **PSPO requires compat level 160.** Even on SQL Server 2022, databases at compat 150 or lower will not get PSPO. After upgrading SQL Server version, you must also update compat level for new IQP features.

8. **Query Store on secondaries is read-only.** In an AG, Query Store writes happen only on the primary. Readable secondaries show Query Store data but it reflects primary captures only.

9. **`sp_query_store_flush_db` can cause a brief spike.** Flushing forces all buffered data to disk synchronously. Run it during off-peak hours before starting an investigation session.

10. **Clearing stale data with `STALE_QUERY_THRESHOLD_DAYS` affects forced plans.** If a query hasn't executed in N days and is cleaned up, its forced plan is also removed. On seasonal workloads, increase the threshold or re-force plans after cleanup.

11. **Wait stats categories are coarser than `sys.dm_os_wait_stats`.** Query Store aggregates waits into ~20 categories; fine-grained wait type diagnosis still requires Extended Events or the instance-level DMV.

12. **Query Store data survives database moves.** When you backup/restore or detach/attach a database, all Query Store data (including forced plans) comes along. This is usually desirable but can surprise you when restoring a production backup to dev — you inherit all forced plans.

---

## See Also

- [`29-query-plans.md`](29-query-plans.md) — reading execution plans, SHOWPLAN, STATISTICS IO
- [`31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — IQP feature matrix, MGF, CE feedback, DOP feedback
- [`28-statistics.md`](28-statistics.md) — statistics and cardinality estimation
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — wait stats, sp_BlitzCache, DMVs
- [`06-stored-procedures.md`](06-stored-procedures.md) — parameter sniffing mitigation

---

## Sources

[^1]: [Monitor Performance by Using the Query Store](https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store) — official Microsoft Learn reference covering Query Store architecture, enabling, configuration options, catalog views, and usage scenarios
[^2]: [Parameter Sensitive Plan Optimization](https://learn.microsoft.com/en-us/sql/relational-databases/performance/parameter-sensitive-plan-optimization) — documents PSPO dispatcher plans, query variants, plan_type_desc values, and Query Store integration for SQL Server 2022+
[^3]: [Cardinality Estimation Feedback](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-cardinality-estimation-feedback) — covers CE feedback implementation, persistence in Query Store, and the CE_FEEDBACK database scoped configuration for SQL Server 2022+
[^4]: [SQL Server Query Store](https://www.brentozar.com/archive/2014/11/sql-server-query-store/) — Brent Ozar's community reference on Query Store usage and performance tuning
[^5]: [SQL Server 2022 Parameter Sensitive Plan Optimization: Sometimes There's Nothing To Fix](https://erikdarling.com/sql-server-2022-parameter-sensitive-plan-optimization-sometimes-theres-nothing-to-fix/) — Erik Darling's analysis of PSPO limitations and cases where plan variants do not help
[^6]: [Automatic Tuning Overview](https://learn.microsoft.com/en-us/azure/azure-sql/database/automatic-tuning-overview) — covers automatic tuning in Azure SQL Database and Managed Instance, including FORCE LAST GOOD PLAN and Query Store as the data source
[^7]: [Memory Grant Feedback](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-memory-grant-feedback) — covers batch mode, row mode, and percentile/persistence memory grant feedback including the SQL Server 2022 Query Store persistence feature via sys.query_store_plan_feedback

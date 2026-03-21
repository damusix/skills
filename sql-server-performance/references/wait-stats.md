# Wait Statistics


Wait statistics identify what resources SQL Server threads are waiting for. Start every performance investigation here — waits tell you the *category* of bottleneck before you look at individual queries.

## Table of Contents


- [How Waits Work](#how-waits-work)
- [Baseline Methodology](#baseline-methodology)
- [Wait Type Reference](#wait-type-reference)
- [Benign Waits to Exclude](#benign-waits-to-exclude)
- [Resource Correlation](#resource-correlation)
- [TempDB Configuration](#tempdb-configuration)
- [Per-Query Wait Stats via Query Store](#per-query-wait-stats-via-query-store)
- [See Also](#see-also)
- [Sources](#sources)

---

## How Waits Work


When a SQL Server thread cannot make progress, it enters a wait queue until the resource becomes available. Every wait is recorded in `sys.dm_os_wait_stats`:

- `waiting_tasks_count` — number of times this wait type occurred
- `wait_time_ms` — total time spent waiting, including signal wait
- `signal_wait_time_ms` — time on the runnable queue waiting for a CPU slot

**Signal wait interpretation:** if signal wait is a high fraction of total wait time, the server is CPU-saturated — threads are ready to run but cannot get a CPU slot. If signal wait is low, threads are blocked on external resources (I/O, locks, network).

`sys.dm_os_wait_stats` accumulates since the last service restart or since `DBCC SQLPERF('sys.dm_os_wait_stats', CLEAR)`. Always compare a **delta** between two snapshots taken across a representative workload window — never act on raw cumulative totals.

---

## Baseline Methodology


Capture a delta over 15–60 minutes of representative load (ideally the peak window):

    -- Step 1: Snapshot before the workload window
    SELECT wait_type,
           waiting_tasks_count,
           wait_time_ms,
           signal_wait_time_ms,
           GETDATE() AS snapshot_time
    INTO #WaitBaseline
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT IN (
        'SLEEP_TASK','SLEEP_SYSTEMTASK','LAZYWRITER_SLEEP',
        'SQLTRACE_BUFFER_FLUSH','CHECKPOINT_QUEUE',
        'BROKER_TO_FLUSH','BROKER_TASK_STOP',
        'WAITFOR','DISPATCHER_QUEUE_SEMAPHORE',
        'XE_DISPATCHER_WAIT','XE_TIMER_EVENT','CXCONSUMER'
    );

    -- ... wait for the representative window ...

    -- Step 2: Delta — shows what consumed wait time during the window
    SELECT
        c.wait_type,
        c.waiting_tasks_count - b.waiting_tasks_count       AS delta_tasks,
        c.wait_time_ms - b.wait_time_ms                     AS delta_wait_ms,
        c.signal_wait_time_ms - b.signal_wait_time_ms       AS delta_signal_ms,
        CAST(100.0 * (c.wait_time_ms - b.wait_time_ms)
            / NULLIF(SUM(c.wait_time_ms - b.wait_time_ms) OVER (), 0)
            AS DECIMAL(5,2))                                 AS pct_of_total
    FROM sys.dm_os_wait_stats c
    JOIN #WaitBaseline b ON b.wait_type = c.wait_type
    WHERE c.wait_time_ms > b.wait_time_ms
    ORDER BY delta_wait_ms DESC;

    DROP TABLE #WaitBaseline;

The output ranks wait types by total time consumed. The top 2–3 wait types almost always point to the bottleneck category.

---

## Wait Type Reference


### Parallelism

| Wait type | Meaning | Fix |
|---|---|---|
| `CXPACKET` | Thread waiting for its slowest parallel sibling | Reduce MAXDOP; fix skewed data distribution; fix bad cardinality estimates that force unnecessary parallelism |
| `CXCONSUMER` | Consumer thread waiting for producer — always paired with CXPACKET | Reduce CXPACKET; CXCONSUMER follows |

CXPACKET alone is not an action item — it is the normal cost of running parallel plans. `CXCONSUMER` was split out from CXPACKET in SQL Server 2016 SP2 / 2017 CU3 to represent idle consumer threads. High CXPACKET combined with high signal waits indicates CPU saturation driving parallel skew. High CXPACKET with low signal waits is usually benign parallel query execution. Reduce MAXDOP or fix the data distribution when CXPACKET is a consistently dominant wait with long average wait times.

### Locking

| Wait type | Meaning | Fix |
|---|---|---|
| `LCK_M_S` | Shared lock wait | Reader blocked by a writer; consider RCSI |
| `LCK_M_X` | Exclusive lock wait | Writer blocked by another writer; review transaction length |
| `LCK_M_U` | Update lock wait | Read-then-update pattern; use UPDLOCK to prevent S→X conversion deadlocks |
| `LCK_M_IX` | Intent exclusive wait | Table-level lock contention from many row updates |

Any dominant `LCK_M_*` wait means locking contention. See [locking-blocking.md](locking-blocking.md) for isolation levels, RCSI, and deadlock analysis.

### I/O

| Wait type | Meaning | Fix |
|---|---|---|
| `PAGEIOLATCH_SH` | Data page being fetched from disk into buffer pool | Missing index; working set too large for available RAM; cold cache |
| `PAGEIOLATCH_EX` | Exclusive latch on a page being read from disk | Typically the same as PAGEIOLATCH_SH; also can indicate contention on allocation pages in tempdb |
| `PAGELATCH_EX` | In-memory latch contention (no I/O) | tempdb GAM/PFS/SGAM contention from concurrent temp object creation — add equally-sized tempdb files |
| `WRITELOG` | Transaction log write latency | Log disk is too slow; separate log and data files; SSD for log |

`PAGELATCH_*` (no IO) is an in-memory contention problem, not a disk problem. Adding faster disks will not fix it. `PAGEIOLATCH_*` (with IO) is a disk read problem.

### CPU and Memory

| Wait type | Meaning | Fix |
|---|---|---|
| `SOS_SCHEDULER_YIELD` | Thread voluntarily yielded CPU and re-queued immediately | CPU saturation; reduce query cost |
| `RESOURCE_SEMAPHORE` | Query waiting for memory grant (sort/hash needs memory) | Fix statistics so grants are sized correctly; row-mode MGF (2019+) auto-adjusts; also check `max server memory` — if set too high, OS memory pressure reduces the buffer pool available for grants |
| `RESOURCE_SEMAPHORE_QUERY_COMPILE` | Too many concurrent compilations | Excessive recompilation (OPTION (RECOMPILE) overuse); ad-hoc query plan churn |
| `THREADPOOL` | Max worker threads exhausted — queries queued for a thread | Immediate danger signal; increase max worker threads or reduce query concurrency |

### Network

| Wait type | Meaning | Fix |
|---|---|---|
| `ASYNC_NETWORK_IO` | Server finished producing rows but client hasn't consumed them | Client-side row buffering; reduce result set size; check network bandwidth |
| `OLEDB` | Linked server query waiting for remote response | Replace with OPENQUERY; consider ETL to local tables instead |

### Log and Checkpoint

| Wait type | Meaning | Fix |
|---|---|---|
| `WRITELOG` | Transaction log write not yet flushed | Log disk latency; confirm log is on dedicated SSD |
| `CHECKPOINT_QUEUE` | Checkpoint worker waiting for dirty pages | Usually benign; high values may indicate I/O saturation |

---

## Benign Waits to Exclude


These wait types are normal SQL Server background activity. Excluding them shows the waits that reflect actual workload contention:

    WHERE wait_type NOT IN (
        'SLEEP_TASK', 'SLEEP_SYSTEMTASK', 'SLEEP_DBSTARTUP',
        'SLEEP_DCOMSTARTUP', 'SLEEP_MASTERMDREADY', 'SLEEP_MASTERUPGRADED',
        'SLEEP_MSDBSTARTUP', 'SLEEP_TEMPDBSTARTUP', 'SLEEP_MASTERSTART',
        'WAITFOR',
        'LAZYWRITER_SLEEP',
        'SQLTRACE_BUFFER_FLUSH', 'SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
        'CHECKPOINT_QUEUE',
        'BROKER_TO_FLUSH', 'BROKER_TASK_STOP', 'BROKER_EVENTHANDLER',
        'DISPATCHER_QUEUE_SEMAPHORE',
        'FT_IFTS_SCHEDULER_IDLE_WAIT',
        'XE_DISPATCHER_WAIT', 'XE_TIMER_EVENT',
        'CXCONSUMER',                    -- always pair with CXPACKET
        'SP_SERVER_DIAGNOSTICS_SLEEP',
        'RESOURCE_QUEUE', 'SERVER_IDLE_CHECK',
        'REQUEST_FOR_DEADLOCK_SEARCH',
        'LOGMGR_QUEUE', 'ONDEMAND_TASK_QUEUE', 'KSOURCE_WAKEUP',
        'SQLTRACE_WAIT_ENTRIES',
        'DBMIRROR_EVENTS_QUEUE'
    )
    AND wait_type NOT LIKE 'SLEEP_%'
    AND wait_type NOT LIKE 'HADR_%'     -- remove if diagnosing AG issues

---

## Resource Correlation


Match dominant wait types to the underlying resource bottleneck:

| Dominant waits | Resource | Investigation |
|---|---|---|
| `PAGEIOLATCH_SH`, `PAGEIOLATCH_EX` | Disk I/O | Missing indexes; working set > RAM; I/O subsystem throughput |
| `WRITELOG` | Log disk | Log file placement; log disk IOPS; batch size |
| `CXPACKET` (high signal wait) | CPU | Reduce query parallelism; fix cardinality |
| `SOS_SCHEDULER_YIELD` | CPU | Reduce CPU-intensive queries; add CPUs |
| `LCK_M_*` | Lock contention | Isolation level; RCSI; deadlock patterns |
| `RESOURCE_SEMAPHORE` | Memory | Fix statistics; memory grant feedback |
| `PAGELATCH_EX` on `2:1:*` | tempdb allocation | Add equally-sized tempdb files |
| `ASYNC_NETWORK_IO` | Network / client | Reduce result sets; fix client buffering |

**Checking current active waits** (live view, not cumulative):

    SELECT r.session_id,
           r.wait_type,
           r.wait_time / 1000.0      AS wait_sec,
           r.wait_resource,
           SUBSTRING(st.text, (r.statement_start_offset/2)+1, 200) AS stmt
    FROM sys.dm_exec_requests r
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
    WHERE r.wait_type IS NOT NULL
      AND r.session_id > 50   -- exclude system sessions
    ORDER BY r.wait_time DESC;

---

## TempDB Configuration

`PAGELATCH_EX` waits on pages like `2:1:1` (tempdb file 1, page 1) indicate contention on tempdb allocation bitmap pages (GAM, SGAM, PFS). The fix is equally-sized tempdb data files so SQL Server's proportional fill algorithm distributes allocations across files, eliminating the single-page bottleneck.

**Number of tempdb data files:**
- SQL Server 2016+ setup recommends 1 file per logical processor core, capped at 8
- All data files must be identical in initial size and autogrowth settings
- Equally-sized files enable proportional fill without trace flags

**Note:** Trace flags 1117 (uniform autogrowth) and 1118 (uniform extent allocation) are **obsolete** as of SQL Server 2016 — this behavior is now the default for tempdb. Do not add them to SQL Server 2016+ startup parameters.

    -- Check current tempdb file sizes (all should match)
    SELECT name, type_desc,
           size * 8 / 1024      AS size_mb,
           growth * 8 / 1024    AS growth_mb,
           is_percent_growth
    FROM tempdb.sys.database_files
    ORDER BY type_desc, file_id;

    -- Equalize sizes (run for each file that is smaller)
    ALTER DATABASE tempdb
    MODIFY FILE (NAME = 'tempdev2', SIZE = 4096 MB, FILEGROWTH = 512 MB);

**Max server memory:** `RESOURCE_SEMAPHORE` waits can persist if `max server memory` is set too high, leaving insufficient RAM for the OS and causing Windows to page SQL Server memory. Rule of thumb: reserve 10% or 4 GB (whichever is larger) for the OS; set `max server memory` to the remainder.

    -- Check current setting
    SELECT name, value_in_use FROM sys.configurations
    WHERE name IN ('max server memory (MB)', 'min server memory (MB)');

    -- Set appropriately (example: 28 GB on a 32 GB server)
    EXEC sp_configure 'max server memory (MB)', 28672;
    RECONFIGURE;

---

## Per-Query Wait Stats via Query Store


Instance-level `sys.dm_os_wait_stats` shows what the whole server is waiting on. Query Store (SQL Server 2017+) shows wait categories **per individual query plan** — invaluable for finding which specific query is responsible.

    -- Wait breakdown for a specific plan (requires WAIT_STATS_CAPTURE_MODE = ON)
    SELECT qsws.wait_category_desc,
           SUM(qsws.total_query_wait_time_ms)  AS total_wait_ms,
           AVG(qsws.avg_query_wait_time_ms)    AS avg_wait_ms
    FROM sys.query_store_wait_stats           qsws
    JOIN sys.query_store_runtime_stats_interval qsrsi
        ON qsrsi.runtime_stats_interval_id = qsws.runtime_stats_interval_id
    WHERE qsws.plan_id = @plan_id
      AND qsrsi.start_time >= DATEADD(HOUR, -24, GETUTCDATE())
    GROUP BY qsws.wait_category_desc
    ORDER BY total_wait_ms DESC;

    -- Top 10 queries by lock wait time (last 24 hours)
    SELECT TOP 10
        qsqt.query_sql_text,
        SUM(qsws.total_query_wait_time_ms) AS lock_wait_ms
    FROM sys.query_store_query_text          qsqt
    JOIN sys.query_store_query               qsq  ON qsq.query_text_id          = qsqt.query_text_id
    JOIN sys.query_store_plan                qsp  ON qsp.query_id               = qsq.query_id
    JOIN sys.query_store_wait_stats          qsws ON qsws.plan_id               = qsp.plan_id
    JOIN sys.query_store_runtime_stats_interval qsrsi
         ON qsrsi.runtime_stats_interval_id = qsws.runtime_stats_interval_id
    WHERE qsws.wait_category_desc = 'Lock'
      AND qsrsi.start_time >= DATEADD(HOUR, -24, GETUTCDATE())
    GROUP BY qsqt.query_sql_text
    ORDER BY lock_wait_ms DESC;

Query Store wait stats persist across restarts; `sys.dm_os_wait_stats` does not. Use Query Store for trend analysis over days or weeks.

---

## See Also


- [locking-blocking.md](locking-blocking.md) — diagnosing and resolving LCK_M_* waits
- [execution-plans.md](execution-plans.md) — PAGEIOLATCH and RESOURCE_SEMAPHORE symptoms in plans
- [index-strategy.md](index-strategy.md) — missing indexes causing PAGEIOLATCH_SH
- [statistics-tuning.md](statistics-tuning.md) — stale statistics causing RESOURCE_SEMAPHORE grants
- [batch-operations.md](batch-operations.md) — WRITELOG reduction through chunked DML and minimal logging

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [sys.dm_os_wait_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-os-wait-stats-transact-sql) — Complete wait-type reference including CXPACKET, CXCONSUMER, PAGEIOLATCH_*, PAGELATCH_*, LCK_M_*, WRITELOG, RESOURCE_SEMAPHORE, and SOS_SCHEDULER_YIELD.
[^2]: [SQL Server Wait Statistics: Tell Me Where It Hurts](https://www.sqlskills.com/blogs/paul/wait-statistics-or-please-tell-me-where-it-hurts/) — Paul Randal's (SQLskills) canonical post on the delta methodology for sys.dm_os_wait_stats, the benign-wait exclusion list, and interpreting signal wait ratios.
[^3]: [sys.dm_exec_requests (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-requests-transact-sql) — Reference for wait_type, wait_time, wait_resource, and blocking_session_id used during live wait and blocking analysis.
[^4]: [sys.query_store_wait_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql) — Column reference and wait-category mapping for per-query wait stats in Query Store (SQL Server 2017+), including how to enable WAIT_STATS_CAPTURE_MODE.
[^5]: [sys.dm_tran_version_store_space_usage (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-tran-version-store-space-usage) — Reference for the DMV columns (database_id, reserved_page_count, reserved_space_kb) used to monitor RCSI/snapshot version store growth.
[^6]: [SQL Server Transaction Log Architecture and Management Guide](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-log-architecture-and-management-guide) — Covers VLF architecture, autogrowth-driven VLF proliferation, and how VLF count contributes to WRITELOG latency and recovery time.
[^7]: [sys.dm_db_log_info (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-log-info-transact-sql) — Reference for the DMV (SQL Server 2016 SP2+) that replaces DBCC LOGINFO for VLF count and log health diagnosis.
[^8]: [Server Memory Configuration Options](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/server-memory-server-configuration-options) — Documents max server memory and min server memory settings, NUMA-aware configuration, and how improper sizing causes OS memory pressure leading to RESOURCE_SEMAPHORE waits.

# 33 — Extended Events (XE)

## Table of Contents
1. [When to Use](#when-to-use)
2. [XE vs SQL Profiler](#xe-vs-sql-profiler)
3. [Architecture Overview](#architecture-overview)
4. [Creating XE Sessions](#creating-xe-sessions)
5. [Common Events Reference](#common-events-reference)
6. [Targets](#targets)
7. [Predicate Filtering](#predicate-filtering)
8. [Session Management](#session-management)
9. [Common Session Templates](#common-session-templates)
   - [Blocking Detection](#blocking-detection)
   - [Deadlock Graph Capture](#deadlock-graph-capture)
   - [Long-Running Queries](#long-running-queries)
   - [Query Compilation Overhead](#query-compilation-overhead)
   - [Login Failures](#login-failures)
10. [Reading XE Data](#reading-xe-data)
11. [Ring Buffer Target](#ring-buffer-target)
12. [Event File Target](#event-file-target)
13. [sys.dm_xe_* DMVs](#sysdm_xe-dmvs)
14. [system_health Session](#system_health-session)
15. [Metadata Queries](#metadata-queries)
16. [Gotchas](#gotchas)
17. [See Also](#see-also)
18. [Sources](#sources)

---

## When to Use

Use Extended Events when you need to:
- Capture deadlock graphs without enabling Trace Flag 1222
- Monitor blocking chains in real time or historically
- Audit specific query patterns, logins, or error events
- Profile query performance (duration, CPU, reads) for specific databases or workloads
- Replace SQL Profiler traces (Profiler is deprecated)
- Investigate wait stats at the individual query level
- Capture query compilation and recompilation events

**Do not use XE** for real-time display of every query on a busy server — the overhead of high-frequency events with no filtering is significant. Always add predicates.

---

## XE vs SQL Profiler

| Dimension | Extended Events | SQL Profiler / Trace |
|---|---|---|
| Overhead | Low (event-based, async) | High (synchronous, all sessions) |
| Deprecation status | **Current** | **Deprecated** — removed in a future version |
| Minimum event granularity | Sub-millisecond | ~1ms |
| Filtering | Server-side predicates (very efficient) | Client-side (data still crosses kernel boundary) |
| Targets | Ring buffer, file, histogram, pair_matching, etc. | File, table, screen |
| Deadlock capture | Native `xml_deadlock_report` event | TF 1222 or `locks:deadlock graph` |
| Memory usage | Configurable, bounded | Can be unbounded |
| Cross-server | No | Yes (with distributed replay) |
| Programmatic access | `sys.fn_xe_file_target_read_file`, DMVs | `fn_trace_gettable` |
| GUI | SSMS XE Live Data viewer | SQL Profiler (deprecated) |

> [!WARNING] Deprecated
> SQL Profiler and `sp_trace_*` stored procedures are deprecated as of SQL Server 2012 and will be removed in a future release. Migrate all traces to Extended Events.

---

## Architecture Overview

```
Package (sqlserver, sqlos, SecAudit)
  └── Event (e.g., sql_statement_completed)
        ├── Actions (data columns appended to every event: sql_text, plan_handle, etc.)
        ├── Predicates (server-side filter: WHERE clause on event fields)
        └── Target (where data goes: ring_buffer, event_file, histogram, etc.)
```

**Key concepts:**

| Term | Meaning |
|---|---|
| **Package** | Namespace for events, actions, targets, predicates (e.g., `sqlserver`, `sqlos`) |
| **Event** | Something that happened (e.g., `sql_statement_completed`, `xml_deadlock_report`) |
| **Action** | Data appended to an event at fire time (e.g., `sql_text`, `session_id`) |
| **Predicate** | Server-side filter applied before event is collected (reduces overhead) |
| **Target** | Asynchronous consumer of events (ring buffer, file, histogram, etc.) |
| **Session** | Named container grouping events + targets + options |

Data flows: event fires → predicates evaluated → if pass, actions collected → event dispatched to target buffer (async) → target writes to storage.

---

## Creating XE Sessions

### Minimal session skeleton

```sql
CREATE EVENT SESSION [session_name] ON SERVER
ADD EVENT sqlserver.event_name
(
    ACTION
    (
        sqlserver.sql_text,
        sqlserver.session_id,
        sqlserver.database_name
    )
    WHERE
    (
        sqlserver.database_name = N'YourDatabase'
        AND duration > 1000000  -- microseconds (1 second)
    )
)
ADD TARGET package0.ring_buffer
(
    SET max_memory = 51200  -- KB (50 MB)
)
WITH
(
    MAX_DISPATCH_LATENCY = 5 SECONDS,
    MAX_EVENT_SIZE       = 0,       -- 0 = use MAX_MEMORY
    MEMORY_PARTITION_MODE = NONE,
    TRACK_CAUSALITY      = OFF,
    STARTUP_STATE        = OFF      -- ON = auto-start at SQL startup
);

-- Start the session
ALTER EVENT SESSION [session_name] ON SERVER STATE = START;
```

### Session options reference

| Option | Default | Notes |
|---|---|---|
| `MAX_MEMORY` | 4 MB | Per-session dispatch buffer size |
| `MAX_DISPATCH_LATENCY` | 30 SECONDS | How long events stay in buffer before dispatch to target |
| `MEMORY_PARTITION_MODE` | NONE | PER_NODE or PER_CPU reduces contention on high-core machines |
| `TRACK_CAUSALITY` | OFF | Adds activity ID + sequence for cross-event correlation |
| `STARTUP_STATE` | OFF | ON survives service restarts |
| `MAX_EVENT_SIZE` | 0 | Maximum size of a single event; 0 means MAX_MEMORY |

---

## Common Events Reference

### Query execution
| Event | Description |
|---|---|
| `sqlserver.sql_statement_completed` | T-SQL statement finished (per-statement, high volume) |
| `sqlserver.sql_batch_completed` | Entire batch finished |
| `sqlserver.rpc_completed` | RPC call (sp_executesql, proc execution) finished |
| `sqlserver.sql_statement_starting` | Statement starting |
| `sqlserver.module_end` | Stored procedure / function / trigger finished |

### Compilation
| Event | Description |
|---|---|
| `sqlserver.sql_statement_recompile` | Statement recompilation (check `recompile_cause`) |
| `sqlserver.query_pre_execution_showplan` | Estimated plan (before execution) |
| `sqlserver.query_post_execution_showplan` | Actual plan (after execution, high overhead) |
| `sqlserver.query_post_compilation_showplan` | Plan after compilation |

### Locking and blocking
| Event | Description |
|---|---|
| `sqlserver.xml_deadlock_report` | Complete deadlock graph in XML |
| `sqlserver.lock_acquired` | Every lock acquired (very high volume — always filter) |
| `sqlserver.lock_released` | Every lock released (very high volume) |
| `sqlos.wait_info` | Individual wait events (extremely high volume — always filter) |
| `sqlos.wait_info_external` | External waits (network, I/O) |

### Errors and warnings
| Event | Description |
|---|---|
| `sqlserver.error_reported` | SQL error messages |
| `sqlserver.attention` | Client disconnect / query cancellation |

### Login / security
| Event | Description |
|---|---|
| `sqlserver.login` | Client login (high volume on busy servers) |
| `sqlserver.logout` | Client logout |
| `sqlserver.failed_login` | Failed login attempt |

### Memory and I/O
| Event | Description |
|---|---|
| `sqlserver.sort_warning` | Sort spill to tempdb |
| `sqlserver.hash_warning` | Hash join/aggregate spill |
| `sqlserver.exchange_spill` | Parallelism exchange spill |
| `sqlserver.missing_column_statistics` | Query used without usable stats |

---

## Targets

### package0.ring_buffer
- Stores events in memory as XML
- Fast, no I/O overhead
- **Data is lost on session stop or SQL Server restart**
- Best for interactive diagnosis and short-duration captures

```sql
ADD TARGET package0.ring_buffer
(SET max_memory = 51200)  -- KB
```

### package0.event_file
- Writes events to `.xel` files on disk (or Azure Blob)
- Durable across restarts
- Files auto-roll at `max_file_size`; old files auto-purged at `max_rollover_files`

```sql
ADD TARGET package0.event_file
(
    SET filename          = N'D:\XELogs\my_session.xel',
        max_file_size     = 100,    -- MB per file
        max_rollover_files = 5       -- keep 5 files max
)
```

### package0.histogram
- Aggregates event count by a single field
- Zero-copy: only stores counts, not raw events
- Best for "how many times did X happen per database/login"

```sql
ADD TARGET package0.histogram
(
    SET filtering_event_name = N'sqlserver.error_reported',
        source_type = 0,           -- 0=event field, 1=action
        source      = N'error_number'
)
```

### package0.pair_matching
- Matches begin/end events to find unmatched (long-running or incomplete) operations
- Useful for finding open transactions, leaked connections

### package0.synchronous_bucketizer / asynchronous_bucketizer
- Bucket-based aggregation; less common than histogram

### package0.etw_classic_sync_target
- Writes to Windows ETW; rarely used for SQL diagnostics

---

## Predicate Filtering

Predicates are the most important performance control in XE. Always filter to the minimum necessary scope.

### Common predicates

```sql
-- Filter by database
WHERE (sqlserver.database_name = N'MyDatabase')

-- Filter by duration (microseconds)
WHERE (duration >= 1000000)        -- >= 1 second

-- Filter by session
WHERE (sqlserver.session_id = 55)

-- Filter by error number
WHERE (error_number = 1205)        -- deadlock

-- Exclude system sessions
WHERE (sqlserver.is_system = 0)

-- Compound: duration AND database
WHERE (
    sqlserver.database_name = N'MyDatabase'
    AND duration >= 500000          -- >= 0.5 seconds
    AND sqlserver.is_system = 0
)
```

### Predicate types

| Type | Example | Notes |
|---|---|---|
| Event field | `duration > 1000000` | Field on the event itself |
| Action predicate | `sqlserver.database_name = N'X'` | Pre-defined action predicates |
| Comparators | `=`, `<>`, `>`, `>=`, `<`, `<=`, `LIKE` | LIKE uses `%` wildcard |
| Logical | `AND`, `OR`, `NOT` | No short-circuit guarantee; AND is preferred over OR |
| Global predicates | `sqlserver.is_system`, `sqlserver.is_null` | Package-level comparators |

> [!NOTE]
> Predicates are evaluated **before** actions are collected. A predicate that rejects an event costs almost nothing. Collecting `sql_text` action then filtering in application code is expensive — push filters into the XE predicate.

---

## Session Management

```sql
-- Start a session
ALTER EVENT SESSION [session_name] ON SERVER STATE = START;

-- Stop a session
ALTER EVENT SESSION [session_name] ON SERVER STATE = STOP;

-- Drop a session
DROP EVENT SESSION [session_name] ON SERVER;

-- Modify a running session (limited changes allowed while running)
ALTER EVENT SESSION [session_name] ON SERVER
    DROP EVENT sqlserver.sql_statement_completed;

ALTER EVENT SESSION [session_name] ON SERVER
    ADD EVENT sqlserver.rpc_completed
    (WHERE (duration > 500000));

-- View all sessions and their state
SELECT name, event_session_id
FROM sys.dm_xe_sessions;
```

---

## Common Session Templates

### Blocking Detection

Captures blocking chains. The `blocked_process_report` event requires enabling the blocked process threshold first.

```sql
-- Enable blocked process threshold (seconds)
EXEC sp_configure 'blocked process threshold (s)', 5;
RECONFIGURE;

CREATE EVENT SESSION [BlockingCapture] ON SERVER
ADD EVENT sqlserver.blocked_process_report
(
    ACTION
    (
        sqlserver.sql_text,
        sqlserver.database_name,
        sqlserver.session_id,
        sqlserver.client_app_name,
        sqlserver.client_hostname
    )
)
ADD TARGET package0.ring_buffer
(SET max_memory = 51200)
WITH
(
    MAX_DISPATCH_LATENCY = 5 SECONDS,
    STARTUP_STATE        = ON
);

ALTER EVENT SESSION [BlockingCapture] ON SERVER STATE = START;
```

Read blocking data:
```sql
SELECT
    xdr.value('@monitorLoop', 'int')       AS monitor_loop,
    xdr.value('blocked-process-report[1]/blocked-process[1]/process[1]/@spid', 'int') AS blocked_spid,
    xdr.value('blocked-process-report[1]/blocked-process[1]/process[1]/@waittime', 'bigint') AS wait_ms,
    xdr.value('blocked-process-report[1]/blocked-process[1]/process[1]/inputbuf[1]', 'nvarchar(max)') AS blocked_sql,
    xdr.value('blocked-process-report[1]/blocking-process[1]/process[1]/@spid', 'int') AS blocking_spid,
    xdr.value('blocked-process-report[1]/blocking-process[1]/process[1]/inputbuf[1]', 'nvarchar(max)') AS blocking_sql
FROM
(
    SELECT CAST(target_data AS XML) AS target_data
    FROM sys.dm_xe_session_targets st
    JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
    WHERE s.name = 'BlockingCapture'
      AND st.target_name = 'ring_buffer'
) AS data
CROSS APPLY target_data.nodes('//RingBufferTarget/event/data/value/blocked-process-report') AS XEventData(xdr);
```

### Deadlock Graph Capture

The `system_health` session captures deadlocks automatically (see [system_health Session](#system_health-session)). To create a dedicated session:

```sql
CREATE EVENT SESSION [DeadlockCapture] ON SERVER
ADD EVENT sqlserver.xml_deadlock_report
ADD TARGET package0.event_file
(
    SET filename          = N'D:\XELogs\deadlocks.xel',
        max_file_size     = 50,
        max_rollover_files = 10
)
WITH
(
    MAX_DISPATCH_LATENCY = 5 SECONDS,
    STARTUP_STATE        = ON
);

ALTER EVENT SESSION [DeadlockCapture] ON SERVER STATE = START;
```

Read deadlocks from file:
```sql
SELECT
    event_data.value('(event/@timestamp)[1]', 'datetime2')       AS deadlock_time,
    event_data.query('(event/data/value/deadlock)[1]')            AS deadlock_graph
FROM
(
    SELECT CAST(event_data AS XML) AS event_data
    FROM sys.fn_xe_file_target_read_file(
        N'D:\XELogs\deadlocks*.xel', NULL, NULL, NULL
    )
) AS t;
```

Read deadlocks from `system_health`:
```sql
SELECT
    xdr.value('@timestamp', 'datetime2')            AS deadlock_time,
    xdr.query('.')                                  AS deadlock_graph_xml
FROM
(
    SELECT CAST(target_data AS XML) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = 'system_health'
      AND t.target_name = 'ring_buffer'
) AS data
CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS XEventData(xdr)
ORDER BY deadlock_time DESC;
```

### Long-Running Queries

```sql
CREATE EVENT SESSION [LongQueries] ON SERVER
ADD EVENT sqlserver.sql_statement_completed
(
    ACTION
    (
        sqlserver.sql_text,
        sqlserver.plan_handle,
        sqlserver.database_name,
        sqlserver.session_id,
        sqlserver.client_app_name,
        sqlserver.username
    )
    WHERE
    (
        duration >= 3000000          -- >= 3 seconds (microseconds)
        AND sqlserver.is_system = 0
        AND sqlserver.database_name <> N'master'
    )
),
ADD EVENT sqlserver.rpc_completed
(
    ACTION
    (
        sqlserver.sql_text,
        sqlserver.plan_handle,
        sqlserver.database_name,
        sqlserver.session_id,
        sqlserver.client_app_name
    )
    WHERE
    (
        duration >= 3000000
        AND sqlserver.is_system = 0
    )
)
ADD TARGET package0.event_file
(
    SET filename          = N'D:\XELogs\LongQueries.xel',
        max_file_size     = 200,
        max_rollover_files = 5
)
WITH (MAX_DISPATCH_LATENCY = 15 SECONDS, STARTUP_STATE = ON);

ALTER EVENT SESSION [LongQueries] ON SERVER STATE = START;
```

Read long-running query data:
```sql
SELECT
    DATEADD(HOUR, DATEDIFF(HOUR, GETUTCDATE(), GETDATE()),
        event_data.value('(event/@timestamp)[1]', 'datetime2')) AS event_time_local,
    event_data.value('(event/data[@name="duration"]/value)[1]', 'bigint') / 1000 AS duration_ms,
    event_data.value('(event/data[@name="cpu_time"]/value)[1]', 'bigint') / 1000 AS cpu_ms,
    event_data.value('(event/data[@name="logical_reads"]/value)[1]', 'bigint') AS logical_reads,
    event_data.value('(event/action[@name="database_name"]/value)[1]', 'nvarchar(128)') AS database_name,
    event_data.value('(event/action[@name="sql_text"]/value)[1]', 'nvarchar(max)')      AS sql_text,
    event_data.value('(event/action[@name="client_app_name"]/value)[1]', 'nvarchar(128)') AS app_name
FROM
(
    SELECT CAST(event_data AS XML) AS event_data
    FROM sys.fn_xe_file_target_read_file(
        N'D:\XELogs\LongQueries*.xel', NULL, NULL, NULL
    )
) AS t
ORDER BY duration_ms DESC;
```

### Query Compilation Overhead

Use when you suspect excessive compilation/recompilation is consuming CPU.

```sql
CREATE EVENT SESSION [RecompileCapture] ON SERVER
ADD EVENT sqlserver.sql_statement_recompile
(
    ACTION
    (
        sqlserver.sql_text,
        sqlserver.database_name,
        sqlserver.session_id,
        sqlserver.plan_handle
    )
    WHERE
    (
        sqlserver.database_name = N'YourDatabase'
        AND sqlserver.is_system = 0
    )
)
ADD TARGET package0.ring_buffer
(SET max_memory = 51200)
WITH (MAX_DISPATCH_LATENCY = 5 SECONDS, STARTUP_STATE = OFF);

ALTER EVENT SESSION [RecompileCapture] ON SERVER STATE = START;
```

The `recompile_cause` field (integer) identifies why recompilation occurred:
| Value | Cause |
|---|---|
| 1 | Schema changed |
| 2 | Statistics changed |
| 3 | Deferred compile |
| 4 | Set option changed |
| 5 | Temp table changed |
| 6 | Remote rowset changed |
| 8 | Query notification environment changed |
| 9 | Partition view changed |
| 10 | Cursor options changed |
| 11 | With recompile option |
| 12 | Parameterized plan flushed |
| 13 | Stale plan (execute semantics changed) |

### Login Failures

```sql
CREATE EVENT SESSION [FailedLogins] ON SERVER
ADD EVENT sqlserver.failed_login
(
    ACTION
    (
        sqlserver.client_app_name,
        sqlserver.client_hostname,
        sqlserver.server_instance_name,
        sqlserver.username
    )
)
ADD TARGET package0.ring_buffer
(SET max_memory = 10240)
WITH (STARTUP_STATE = ON);

ALTER EVENT SESSION [FailedLogins] ON SERVER STATE = START;
```

---

## Reading XE Data

### From ring_buffer

```sql
SELECT
    event_data.value('(event/@name)[1]',      'nvarchar(128)') AS event_name,
    event_data.value('(event/@timestamp)[1]',  'datetime2')    AS event_time,
    event_data.value('(event/data[@name="duration"]/value)[1]', 'bigint') AS duration_us,
    event_data.value('(event/action[@name="sql_text"]/value)[1]', 'nvarchar(max)') AS sql_text,
    event_data.value('(event/action[@name="database_name"]/value)[1]', 'nvarchar(128)') AS db_name
FROM
(
    SELECT CAST(target_data AS XML) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions       s ON s.address = t.event_session_address
    WHERE s.name    = 'LongQueries'
      AND t.target_name = 'ring_buffer'
) AS data
CROSS APPLY target_data.nodes('//RingBufferTarget/event') AS XEventData(event_data)
ORDER BY event_time DESC;
```

### From event_file

```sql
-- sys.fn_xe_file_target_read_file(path, metadata_file, initial_file_name, initial_offset)
-- Use wildcards to read all rolled files

SELECT
    event_data,
    file_name,
    file_offset
FROM sys.fn_xe_file_target_read_file(
    N'D:\XELogs\LongQueries*.xel',  -- path with wildcard
    NULL,                             -- metadata file (usually NULL)
    NULL,                             -- start file name (NULL = oldest)
    NULL                              -- start offset (NULL = beginning)
)
ORDER BY file_name, file_offset;     -- preserves chronological order within each file
```

> [!NOTE]
> `sys.fn_xe_file_target_read_file` returns `event_data` as `nvarchar(max)`. Cast to `XML` for XQuery parsing. On very large files, CAST can be expensive — consider reading in batches using `initial_file_name` and `initial_offset`.

### Incremental reads (polling pattern)

```sql
DECLARE @last_file   NVARCHAR(260) = NULL;
DECLARE @last_offset BIGINT        = NULL;

-- On first poll, these are NULL (reads from beginning)
-- On subsequent polls, pass in values from previous run to read only new events

SELECT TOP 1
    @last_file   = file_name,
    @last_offset = file_offset
FROM sys.fn_xe_file_target_read_file(
    N'D:\XELogs\LongQueries*.xel', NULL, @last_file, @last_offset
)
ORDER BY file_name DESC, file_offset DESC;
```

---

## Ring Buffer Target

- Events stored in XML in server memory
- When full, oldest events are **overwritten** (circular buffer)
- Data disappears when session is stopped or SQL restarts
- Best for: interactive diagnosis, short-duration captures, low-volume events

```sql
-- Check ring buffer fullness
SELECT
    s.name                                                          AS session_name,
    t.target_name,
    CAST(t.target_data AS XML).value(
        '(RingBufferTarget/@eventCount)[1]', 'int')                AS event_count,
    CAST(t.target_data AS XML).value(
        '(RingBufferTarget/@memoryUsed)[1]', 'bigint')             AS memory_used_bytes
FROM sys.dm_xe_session_targets t
JOIN sys.dm_xe_sessions         s ON s.address = t.event_session_address
WHERE t.target_name = 'ring_buffer';
```

---

## Event File Target

- Writes to `.xel` binary files (not XML text — but readable via `fn_xe_file_target_read_file`)
- Survives session stop and SQL restart
- Auto-rollover: when `max_file_size` reached, creates a new file with timestamp suffix
- Auto-purge: when `max_rollover_files` reached, oldest file is deleted
- For Azure: use a UNC path or Azure Blob storage path (2019+)

```sql
-- Writing to Azure Blob (2019+)
ADD TARGET package0.event_file
(
    SET filename = N'https://mystorageacct.blob.core.windows.net/xelogs/session.xel'
)
```

> [!NOTE] SQL Server 2019
> Writing XE event files directly to Azure Blob Storage is supported from SQL Server 2019 onward using an Azure Storage credential.

---

## sys.dm_xe_* DMVs

| DMV | Purpose |
|---|---|
| `sys.dm_xe_sessions` | Active XE sessions (name, address, state, pending event count) |
| `sys.dm_xe_session_events` | Events added to each active session |
| `sys.dm_xe_session_event_actions` | Actions collected per event per session |
| `sys.dm_xe_session_targets` | Targets and their current data / statistics |
| `sys.dm_xe_session_object_columns` | Configuration of each event/target |
| `sys.dm_xe_packages` | Available packages |
| `sys.dm_xe_objects` | All events, actions, targets, predicates in all packages |
| `sys.dm_xe_object_columns` | Fields available on each event |
| `sys.dm_xe_map_values` | Lookup table for integer-coded fields (e.g., lock_mode, wait_type) |

### Useful metadata queries

```sql
-- Find all events that contain "deadlock" in name or description
SELECT o.name, o.description, o.package_guid
FROM sys.dm_xe_objects o
WHERE o.object_type = 'event'
  AND (o.name LIKE '%deadlock%' OR o.description LIKE '%deadlock%');

-- Find all fields available on an event
SELECT c.name, c.type_name, c.description
FROM sys.dm_xe_object_columns c
JOIN sys.dm_xe_objects         o ON o.name = c.object_name
WHERE o.name = 'sql_statement_completed'
ORDER BY c.column_type;  -- 'data' = event field; 'action' = attached action

-- Decode integer values (e.g., recompile_cause)
SELECT map_value, map_key
FROM sys.dm_xe_map_values
WHERE name = 'statement_recompile_cause'
ORDER BY map_key;
```

---

## system_health Session

SQL Server automatically runs the `system_health` session at all times. It captures:
- Deadlock graphs (`xml_deadlock_report`)
- Non-yielding schedulers
- Memory broker events
- Connectivity errors
- Security errors (SQL Server logins)
- Wait info for waits > 15 seconds
- sp_server_diagnostics output

It writes to **both** a ring buffer and event files (in the SQL Server error log directory).

```sql
-- Find system_health XEL files
SELECT
    path + '\system_health*.xel' AS file_path
FROM sys.dm_os_server_diagnostics_log_configurations;

-- Recent deadlocks from system_health ring buffer
SELECT TOP 10
    xdr.value('@timestamp', 'datetime2')   AS deadlock_time,
    xdr.query('.')                          AS deadlock_xml
FROM
(
    SELECT CAST(target_data AS XML) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = 'system_health'
      AND t.target_name = 'ring_buffer'
) AS d
CROSS APPLY target_data.nodes(
    '//RingBufferTarget/event[@name="xml_deadlock_report"]'
) AS XEventData(xdr)
ORDER BY deadlock_time DESC;

-- Read system_health from file (more history)
SELECT
    CAST(event_data AS XML).value(
        '(event/@timestamp)[1]', 'datetime2') AS event_time,
    CAST(event_data AS XML).value(
        '(event/@name)[1]', 'nvarchar(128)')  AS event_name,
    CAST(event_data AS XML)                    AS event_xml
FROM sys.fn_xe_file_target_read_file(
    (SELECT path + '\system_health*.xel'
     FROM sys.dm_os_server_diagnostics_log_configurations),
    NULL, NULL, NULL
)
WHERE CAST(event_data AS XML).value('(event/@name)[1]', 'nvarchar(128)')
      IN ('xml_deadlock_report', 'error_reported', 'wait_info')
ORDER BY event_time DESC;
```

---

## Metadata Queries

### List all XE sessions and their state

```sql
SELECT
    s.name                AS session_name,
    s.event_session_id,
    s.pending_buffers,
    s.total_regular_buffers,
    s.total_large_buffers,
    CASE WHEN s.create_time IS NOT NULL THEN 'RUNNING' ELSE 'STOPPED' END AS state
FROM sys.dm_xe_sessions s;
```

### List events and actions in a session

```sql
SELECT
    s.name         AS session_name,
    e.name         AS event_name,
    a.name         AS action_name
FROM sys.dm_xe_sessions           s
JOIN sys.dm_xe_session_events     e ON e.event_session_address = s.address
JOIN sys.dm_xe_session_event_actions a ON a.event_session_address = e.event_session_address
                                       AND a.event_name = e.name
WHERE s.name = 'LongQueries'
ORDER BY e.name, a.name;
```

### Check for persisted (stored in master) XE sessions

```sql
-- Persisted session definitions (CREATE EVENT SESSION without ON SERVER → persisted in master)
SELECT name, event_session_id, startup_state
FROM sys.server_event_sessions;

-- vs active (running) sessions
SELECT name FROM sys.dm_xe_sessions;
```

---

## Gotchas

1. **No predicates = high overhead.** An `sql_statement_completed` event with no predicate on a busy server will collect every statement from every session. Always filter on `database_name`, `duration`, or `is_system` at minimum.

2. **Duration is in microseconds, not milliseconds.** `duration >= 1000000` means ≥ 1 second. A common mistake is writing `1000` (1 millisecond) and generating enormous volumes of events.

3. **ring_buffer data is lost on session stop.** If you stop a session with `STATE = STOP`, the ring buffer is cleared. Use `event_file` for any data you need to retain across restarts or analysis sessions.

4. **Timestamps in XE are UTC.** Event timestamps stored in XE are always UTC regardless of server time zone. Convert with `DATEADD(HOUR, DATEDIFF(HOUR, GETUTCDATE(), GETDATE()), event_time)` for local display.

5. **`query_post_execution_showplan` is very expensive.** Collecting actual query plans for every statement has significant overhead even with predicates, because plan generation itself takes work. Use sparingly — only for specific problematic queries. Prefer `plan_handle` action + `sys.dm_exec_query_plan()` lookup instead.

6. **`system_health` ring buffer is bounded and will lose old events.** On a busy server with many deadlocks, the ring buffer may not retain history for more than a few minutes. Read from `system_health*.xel` files for historical data.

7. **XEL files are binary, not plain XML.** You cannot read them with a text editor or `OPENROWSET BULK`. Use `sys.fn_xe_file_target_read_file` or the SSMS XE viewer.

8. **SSMS XE Live Data viewer adds overhead.** The Live Data viewer in SSMS polls the session continuously. It is fine for interactive diagnosis but should not be left running overnight on production.

9. **`STARTUP_STATE = ON` sessions survive failover on AGs.** The session definition is stored in the primary's `master` database and will auto-start on the new primary after failover. Verify this is the desired behavior — for secondary-only workloads, the session might generate unexpected events post-failover.

10. **Predicate actions are evaluated before collecting other actions.** If your predicate references `sqlserver.database_name`, this predicate is evaluated first (cheaply, from internal metadata). If the predicate rejects the event, `sql_text` is never collected. Ordering matters for performance.

11. **Cannot use XE for compliance auditing.** XE sessions can be stopped by sysadmin. For SOX/HIPAA/PCI-DSS audit trails, use `CREATE SERVER AUDIT` (see `38-auditing.md`), which has tamper-evidence guarantees.

12. **`blocked_process_report` requires `blocked process threshold` > 0.** By default this option is 0 (disabled), so the event never fires. You must run `EXEC sp_configure 'blocked process threshold (s)', 5; RECONFIGURE;` first.

---

## See Also

- [`29-query-plans.md`](29-query-plans.md) — Plan operators, key lookup, spill warnings
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — Wait stats, plan cache, sp_Blitz
- [`13-transactions-locking.md`](13-transactions-locking.md) — Deadlock detection, lock escalation
- [`38-auditing.md`](38-auditing.md) — SQL Server Audit for compliance (vs XE for diagnostics)

---

## Sources

[^1]: [Extended Events Overview - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/extended-events) — overview of the XE architecture, concepts, catalog views, DMVs, and permissions
[^2]: [sys.fn_xe_file_target_read_file (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-xe-file-target-read-file-transact-sql) — reference for reading XEL event file targets, including syntax, arguments, and Azure Blob examples
[^3]: [sys.dm_xe_sessions (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-xe-sessions-transact-sql) — DMV reference for active Extended Events sessions and their buffer/memory statistics
[^4]: [Blocked Process Report Event Class - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/event-classes/blocked-process-report-event-class) — describes the blocked_process_report event and the blocked process threshold configuration option
[^5]: [Extended Events - Brent Ozar Unlimited](https://www.brentozar.com/extended-events/) — community resource covering use cases, session examples, and deadlock/wait capture with Extended Events
[^6]: [SQL Server Extended Events — SQLskills.com (Jonathan Kehayias)](https://www.sqlskills.com/blogs/jonathan/category/extended-events/) — authoritative community blog series on XE internals, performance impact, and advanced usage patterns
[^7]: [Use the system_health session - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/use-the-system-health-session) — describes the built-in system_health XE session, what it captures, and how to query its ring buffer and event file targets

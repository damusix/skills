# SQL Server Agent

SQL Server Agent is the built-in job scheduler and automation engine for SQL Server. It runs as a Windows service (`SQLSERVERAGENT`) and handles scheduled jobs, event-driven alerts, operator notifications, and multi-server administration. Almost everything in production SQL Server operations — backups, index maintenance, statistics updates, monitoring — relies on SQL Server Agent.

## Table of Contents

1. [When to Use](#when-to-use)
2. [Architecture Overview](#architecture-overview)
3. [Job Concepts](#job-concepts)
4. [Creating Jobs with T-SQL](#creating-jobs-with-t-sql)
5. [Job Step Types](#job-step-types)
6. [Step Success/Failure Routing](#step-successfailure-routing)
7. [Schedules](#schedules)
8. [Alerts](#alerts)
9. [Operators](#operators)
10. [Proxies and Credentials](#proxies-and-credentials)
11. [Multi-Server Administration](#multi-server-administration)
12. [msdb Tables Reference](#msdb-tables-reference)
13. [Job History Queries](#job-history-queries)
14. [Monitoring Agent Health](#monitoring-agent-health)
15. [Error Handling Between Steps](#error-handling-between-steps)
16. [Azure SQL Considerations](#azure-sql-considerations)
17. [Common Patterns](#common-patterns)
18. [Gotchas](#gotchas)
19. [See Also](#see-also)
20. [Sources](#sources)

---

## When to Use

SQL Server Agent is the right tool for:

- **Scheduled maintenance** — backups, index rebuilds, statistics updates, DBCC CHECKDB
- **ETL orchestration** — driving SSIS packages, running T-SQL data loads on a schedule
- **Alerting** — responding to error numbers, severity levels, or performance conditions
- **Operator notification** — emailing DBAs on job failure or threshold breach
- **Cleanup jobs** — purging old data, truncating log tables, archiving history
- **Multi-server administration** — distributing jobs from a master server to target servers

Use SSIS, Azure Data Factory, or an external scheduler (Airflow, Quartz) when you need complex dependencies, parallel step execution, or cross-platform scheduling. Agent is excellent for SQL-centric, sequential automation.

---

## Architecture Overview

```
SQL Server Agent Service (SQLSERVERAGENT)
│
├── Jobs ─────── Steps (T-SQL, SSIS, PowerShell, CmdExec, …)
│                └── Schedules (one-time, recurring, on-startup, on-idle)
│
├── Alerts ────── Error number / Severity / Performance condition / WMI event
│                └── → Response: run job, notify operators
│
├── Operators ─── Email / Net Send (deprecated) / Pager (deprecated)
│
└── Proxies ────── Credential-backed Windows identity for non-sysadmin steps
```

Agent stores all metadata in `msdb` — jobs, history, schedules, alerts, operators, and proxies all live there.

Agent runs as a Windows service and must be running for any automation to work. Agent is separate from the SQL Server service itself — a SQL Server instance can be up while Agent is down.

> [!WARNING] Azure SQL Database
> SQL Server Agent is **not available** on Azure SQL Database. Use Elastic Jobs or Azure Automation instead. SQL Managed Instance **does** support Agent with full T-SQL compatibility.

---

## Job Concepts

| Concept | Description |
|---|---|
| **Job** | Named container for one or more steps + one or more schedules |
| **Step** | A single unit of work: a T-SQL batch, SSIS package, shell command, etc. |
| **Schedule** | When the job runs: one-time, recurring (cron-like), on startup, on idle |
| **Alert** | Event trigger: SQL error, severity, performance counter, WMI |
| **Operator** | Named person/group to notify (email address etc.) |
| **Proxy** | Windows credential used by non-sysadmin job steps to run under a specific identity |
| **Job category** | Optional grouping label stored in `msdb.dbo.syscategories` |

A job can have multiple schedules. A schedule can be shared across multiple jobs. Steps can branch: on success go to step N, on failure go to step M, or quit with success/failure.

---

## Creating Jobs with T-SQL

Complete example: a nightly index maintenance job.

```sql
USE msdb;
GO

-- 1. Create the job
EXEC sp_add_job
    @job_name        = N'Nightly Index Maintenance',
    @description     = N'Rebuild/reorganize fragmented indexes using Ola Hallengren IndexOptimize',
    @category_name   = N'Database Maintenance',
    @owner_login_name = N'sa',            -- or a service account login
    @enabled         = 1,
    @notify_level_email   = 2,            -- 1=success, 2=failure, 3=always
    @notify_email_operator_name = N'DBA Team';

-- 2. Add a step
EXEC sp_add_jobstep
    @job_name        = N'Nightly Index Maintenance',
    @step_name       = N'Run IndexOptimize',
    @step_id         = 1,
    @subsystem       = N'TSQL',
    @command         = N'EXEC master.dbo.IndexOptimize
                            @Databases = ''USER_DATABASES'',
                            @FragmentationLow  = NULL,
                            @FragmentationMedium = ''INDEX_REORGANIZE'',
                            @FragmentationHigh   = ''INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE'',
                            @FragmentationLevel1 = 5,
                            @FragmentationLevel2 = 30,
                            @LogToTable = ''Y'';',
    @database_name   = N'master',
    @on_success_action = 1,              -- 1=quit with success
    @on_fail_action    = 2,              -- 2=quit with failure
    @retry_attempts  = 0,
    @retry_interval  = 0;

-- 3. Add a schedule (every night at 02:00)
EXEC sp_add_schedule
    @schedule_name   = N'Nightly 2AM',
    @freq_type       = 4,                -- 4=daily
    @freq_interval   = 1,               -- every 1 day
    @active_start_time = 020000;         -- 02:00:00 (HHMMSS integer)

-- 4. Attach the schedule to the job
EXEC sp_attach_schedule
    @job_name        = N'Nightly Index Maintenance',
    @schedule_name   = N'Nightly 2AM';

-- 5. Target the local server
EXEC sp_add_jobserver
    @job_name        = N'Nightly Index Maintenance',
    @server_name     = N'(LOCAL)';
GO
```

Run a job immediately (for testing):

```sql
EXEC msdb.dbo.sp_start_job @job_name = N'Nightly Index Maintenance';
```

Stop a running job:

```sql
EXEC msdb.dbo.sp_stop_job @job_name = N'Nightly Index Maintenance';
```

Delete a job:

```sql
EXEC msdb.dbo.sp_delete_job @job_name = N'Nightly Index Maintenance';
```

---

## Job Step Types

The `@subsystem` parameter controls what runs in each step.

| Subsystem | Value | Description | Notes |
|---|---|---|---|
| T-SQL | `TSQL` | T-SQL batch | Runs under job owner or proxy; `@database_name` sets USE context |
| SSIS | `SSIS` | SQL Server Integration Services package | Requires SSIS installed; use proxy for non-sysadmin |
| PowerShell | `PowerShell` | PowerShell script | Agent runs 32-bit PowerShell by default on older versions |
| CmdExec | `CmdExec` | Windows command shell (`cmd.exe`) | Requires proxy for non-sysadmin steps |
| ActiveX Script | `ActiveScripting` | VBScript / JScript | **Deprecated** — removed in SQL Server 2016 |
| Analysis Services Command | `ANALYSISCOMMAND` | XMLA against SSAS | Requires SSAS |
| Analysis Services Query | `ANALYSISQUERY` | MDX against SSAS | Requires SSAS |
| Replication Distributor | `DISTRIBUTION` | Replication distribution agent | Internal use |
| Replication Log Reader | `LOGREADER` | Replication log reader agent | Internal use |
| Replication Merge | `MERGE` | Replication merge agent | Internal use |
| Replication Queue Reader | `QUEUEREADER` | Replication queue reader | Internal use |
| Replication Snapshot | `SNAPSHOT` | Replication snapshot agent | Internal use |

> [!WARNING] ActiveX Script subsystem
> Removed in SQL Server 2016. Migrate to PowerShell or CmdExec + scripts.

### T-SQL step behavior

- Runs under the job owner's security context by default
- `@database_name` sets the initial `USE` context — defaults to `msdb` if unset, which is almost never correct
- `@@ERROR` and `RAISERROR` do **not** cause a step failure unless they result in an unhandled error with severity ≥ 11
- Use `IF @@ERROR <> 0 RAISERROR(...)` or `SET XACT_ABORT ON` + `TRY/CATCH` with `THROW` to propagate failures reliably

### PowerShell step behavior

- Agent spawns a child PowerShell process
- The PowerShell module `SQLPS` is auto-imported (older versions); on newer SQL Server the `SqlServer` module must be imported explicitly
- Exit code 0 = success; any other exit = failure
- `$LASTEXITCODE` and `exit 1` control step outcome

### CmdExec step behavior

- Requires a proxy (credential-backed Windows account) if the job owner is not a sysadmin
- Exit code 0 = success; non-zero = failure
- Use for calling `sqlcmd`, `bcp`, `.bat` files, Python scripts, etc.

---

## Step Success/Failure Routing

Each step has independent success and failure actions:

| `@on_success_action` / `@on_fail_action` value | Meaning |
|---|---|
| `1` | Quit the job reporting success |
| `2` | Quit the job reporting failure |
| `3` | Go to the next step |
| `4` | Go to step N (set `@on_success_step_id` / `@on_fail_step_id`) |

Example multi-step job with conditional branching:

```sql
-- Step 1: Extract
EXEC sp_add_jobstep
    @job_name            = N'ETL Pipeline',
    @step_name           = N'Extract',
    @step_id             = 1,
    @subsystem           = N'TSQL',
    @command             = N'EXEC dbo.usp_Extract;',
    @database_name       = N'Staging',
    @on_success_action   = 3,            -- go to next step
    @on_fail_action      = 4,            -- go to step 3 (cleanup)
    @on_fail_step_id     = 3;

-- Step 2: Load
EXEC sp_add_jobstep
    @job_name            = N'ETL Pipeline',
    @step_name           = N'Load',
    @step_id             = 2,
    @subsystem           = N'TSQL',
    @command             = N'EXEC dbo.usp_Load;',
    @database_name       = N'DWH',
    @on_success_action   = 1,            -- quit success
    @on_fail_action      = 4,            -- go to step 3 (cleanup)
    @on_fail_step_id     = 3;

-- Step 3: Cleanup / rollback (always runs on failure path)
EXEC sp_add_jobstep
    @job_name            = N'ETL Pipeline',
    @step_name           = N'Cleanup on Failure',
    @step_id             = 3,
    @subsystem           = N'TSQL',
    @command             = N'EXEC dbo.usp_CleanupStagingOnFailure;',
    @database_name       = N'Staging',
    @on_success_action   = 2,            -- quit failure (so job is marked failed)
    @on_fail_action      = 2;
```

---

## Schedules

### `@freq_type` values

| Value | Meaning |
|---|---|
| `1` | One time only |
| `4` | Daily |
| `8` | Weekly |
| `16` | Monthly |
| `32` | Monthly, relative (e.g., "first Monday") |
| `64` | When Agent starts |
| `128` | When CPU is idle |

### `@freq_interval` semantics by freq_type

| `@freq_type` | `@freq_interval` meaning |
|---|---|
| 4 (daily) | Every N days (1 = every day) |
| 8 (weekly) | Bitmask: 1=Sun, 2=Mon, 4=Tue, 8=Wed, 16=Thu, 32=Fri, 64=Sat; combine with `|` |
| 16 (monthly) | Day of month (1–31) |
| 32 (monthly relative) | 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri, 7=Sat, 8=Day, 9=Weekday, 10=Weekend day |

### Intraday frequency

For jobs running every N minutes/hours within a window:

```sql
EXEC sp_add_schedule
    @schedule_name        = N'Every 15 min business hours',
    @freq_type            = 4,              -- daily
    @freq_interval        = 1,
    @freq_subday_type     = 4,              -- 4=minutes, 8=hours
    @freq_subday_interval = 15,
    @active_start_time    = 080000,         -- 08:00:00
    @active_end_time      = 180000;         -- 18:00:00
```

`@freq_subday_type` values: `1` = once (no subday), `2` = seconds, `4` = minutes, `8` = hours.

### Shared schedules

Schedules can be detached and attached independently:

```sql
-- Detach a schedule from a job (schedule still exists)
EXEC sp_detach_schedule
    @job_name       = N'Some Job',
    @schedule_name  = N'Nightly 2AM';

-- Delete a schedule only if no jobs use it
EXEC sp_delete_schedule
    @schedule_name  = N'Nightly 2AM',
    @keep_unused_schedules = 0;
```

---

## Alerts

Alerts fire in response to events. They can run a job, notify operators, or both.

### Alert types

| `@event_category_name` / mechanism | Trigger |
|---|---|
| SQL Server error alert | Specific error number occurs in the SQL error log |
| SQL Server event alert | Error of a given severity (e.g., all severity 16) |
| SQL Server performance condition | PerfMon counter crosses a threshold |
| WMI event | WMI event query fires |

### Error number alert

```sql
EXEC msdb.dbo.sp_add_alert
    @name                  = N'Alert: Error 823 (I/O Error)',
    @message_id            = 823,          -- specific error number
    @severity              = 0,            -- 0 = use message_id, not severity
    @enabled               = 1,
    @delay_between_responses = 900,        -- 15 min minimum between firings (seconds)
    @notification_message  = N'Disk I/O error 823 detected',
    @job_name              = N'',          -- optionally run a job
    @raise_snmp_trap       = 0;
```

### Severity alert (catch all at a given severity)

```sql
EXEC msdb.dbo.sp_add_alert
    @name                  = N'Alert: Severity 16-19',
    @message_id            = 0,            -- 0 = use severity, not message_id
    @severity              = 16,           -- fires on severity 16 OR HIGHER up to 18
    @enabled               = 1,
    @delay_between_responses = 300;
```

> [!NOTE]
> Severities 20–25 are fatal and terminate the connection. They are still alertable but you need `WITH LOG` on the error for Agent to see it.

### Performance condition alert

```sql
EXEC msdb.dbo.sp_add_alert
    @name               = N'Alert: Low PLE',
    @message_id         = 0,
    @severity           = 0,
    @enabled            = 1,
    @performance_condition = N'SQLServer:Buffer Manager|Page life expectancy||<|300',
    -- format: object|counter|instance|comparator|value
    @delay_between_responses = 300;
```

Common performance condition alert targets:

| Object | Counter | Threshold |
|---|---|---|
| `SQLServer:Buffer Manager` | `Page life expectancy` | `< 300` |
| `SQLServer:SQL Statistics` | `Batch Requests/sec` | `> 5000` |
| `SQLServer:General Statistics` | `Processes blocked` | `> 5` |
| `SQLServer:Locks` | `Lock Waits/sec` | `> 100` |
| `SQLServer:Memory Manager` | `Memory Grants Pending` | `> 0` |

### Connecting an alert to an operator

```sql
EXEC msdb.dbo.sp_add_notification
    @alert_name     = N'Alert: Error 823 (I/O Error)',
    @operator_name  = N'DBA Team',
    @notification_method = 1;   -- 1=email, 2=pager, 4=net send; combine as bitmask
```

---

## Operators

Operators are named recipients for notifications. Email is the only practical notification method in modern SQL Server (pager/net send are effectively deprecated).

```sql
-- Requires Database Mail to be configured first
EXEC msdb.dbo.sp_add_operator
    @name                         = N'DBA Team',
    @enabled                      = 1,
    @email_address                = N'dba-team@company.com',
    @weekday_pager_start_time     = 090000,   -- ignored if no pager configured
    @weekday_pager_end_time       = 180000,
    @pager_days                   = 62;       -- Mon-Fri bitmask (2+4+8+16+32)

-- Set a "fail-safe" operator: notified if Agent can't contact normal operators
EXEC msdb.dbo.sp_update_agent_parameter
    @param_name  = N'FailSafeOperator',
    @param_value = N'DBA Team';
```

Delete an operator:

```sql
EXEC msdb.dbo.sp_delete_operator @name = N'DBA Team';
```

---

## Proxies and Credentials

By default, T-SQL steps run as the job owner. For CmdExec, SSIS, and PowerShell steps, non-sysadmin owners need a proxy.

A proxy maps a Windows credential (stored in `sys.credentials`) to a set of subsystems and grants specific principals access to use it.

```sql
-- 1. Create a Windows credential
CREATE CREDENTIAL [CORP\svc-sqlagent]
    WITH IDENTITY = N'CORP\svc-sqlagent',
    SECRET = N'<windows-password>';

-- 2. Create a proxy backed by that credential
EXEC msdb.dbo.sp_add_proxy
    @proxy_name        = N'SSIS Proxy',
    @credential_name   = N'CORP\svc-sqlagent',
    @enabled           = 1;

-- 3. Grant the proxy permission to a subsystem
EXEC msdb.dbo.sp_grant_proxy_to_subsystem
    @proxy_name    = N'SSIS Proxy',
    @subsystem_id  = 11;   -- 11=SSIS; see subsystem IDs below

-- 4. Grant a login the right to use the proxy
EXEC msdb.dbo.sp_grant_login_to_proxy
    @login_name  = N'CORP\developer1',
    @proxy_name  = N'SSIS Proxy';
```

### Subsystem IDs

| ID | Subsystem |
|---|---|
| 1 | ActiveX Script (deprecated) |
| 2 | CmdExec |
| 3 | Distribution (Replication) |
| 4 | Snapshot (Replication) |
| 5 | Log Reader (Replication) |
| 6 | Merge (Replication) |
| 7 | Queue Reader (Replication) |
| 8 | Analysis Services Command |
| 9 | Analysis Services Query |
| 11 | SSIS |
| 12 | PowerShell |

### Security model

- `sysadmin` members can run any step as any identity, no proxy required
- Non-sysadmin job owners run T-SQL steps under their own login
- Non-sysadmin owners using CmdExec/SSIS/PowerShell **must** use a proxy; Agent will fail the step otherwise
- The Windows account backing the credential needs appropriate permissions on the OS (file system, network shares, etc.)

---

## Multi-Server Administration

Multi-Server Administration (MSX/TSX) lets you manage jobs centrally from a Master Server (MSX) and push them to Target Servers (TSX).

```sql
-- On the master server: make it an MSX
EXEC msdb.dbo.sp_msx_set_account @credential_name = N'MSX Credential';

-- On a target server: enlist it in the MSX
EXEC msdb.dbo.sp_msx_enlist
    @msx_server_name  = N'SQLMASTERSVR',
    @location         = N'Datacenter East';

-- On the master: create a multi-server job (targets all enlisted servers)
EXEC msdb.dbo.sp_add_jobserver
    @job_name    = N'Nightly Backups',
    @server_name = N'ALL';  -- sends to all enlisted target servers
```

> [!NOTE]
> MSX/TSX is a legacy feature. For large environments, consider Ola Hallengren's scripts with a central management server, or third-party tools (DBA MultiTool, dbatools) for distributed job management.

---

## msdb Tables Reference

| Table | Contents |
|---|---|
| `msdb.dbo.sysjobs` | Job definitions (name, enabled, description, owner) |
| `msdb.dbo.sysjobsteps` | Step definitions (command, subsystem, database, retry settings) |
| `msdb.dbo.sysjobschedules` | Link table between jobs and schedules |
| `msdb.dbo.sysschedules` | Schedule definitions (freq_type, freq_interval, active times) |
| `msdb.dbo.sysjobhistory` | Execution history (run_status, run_duration, message) |
| `msdb.dbo.sysjobactivity` | Real-time job activity (start_execution_date, stop_execution_date) |
| `msdb.dbo.sysalerts` | Alert definitions |
| `msdb.dbo.sysoperators` | Operator definitions |
| `msdb.dbo.sysnotifications` | Alert → operator notification links |
| `msdb.dbo.sysproxies` | Proxy definitions |
| `msdb.dbo.syscredentials` | Credential-to-proxy mapping |
| `msdb.dbo.sysjobservers` | Job-to-server assignment (for multi-server) |
| `msdb.dbo.syscategories` | Job/alert/operator categories |

---

## Job History Queries

### Recent job runs with outcome

```sql
SELECT
    j.name                                                AS job_name,
    h.step_id,
    h.step_name,
    CASE h.run_status
        WHEN 0 THEN 'Failed'
        WHEN 1 THEN 'Succeeded'
        WHEN 2 THEN 'Retry'
        WHEN 3 THEN 'Cancelled'
        WHEN 4 THEN 'Running'
    END                                                   AS status,
    -- Convert YYYYMMDD + HHMMSS integers to a datetime
    CONVERT(datetime,
        STUFF(STUFF(CAST(h.run_date AS varchar(8)), 7, 0, '-'), 5, 0, '-')
        + ' '
        + STUFF(STUFF(RIGHT('000000' + CAST(h.run_time AS varchar(6)), 6), 5, 0, ':'), 3, 0, ':')
    )                                                     AS run_start,
    -- run_duration is HHMMSS integer
    (h.run_duration / 10000 * 3600)
    + ((h.run_duration % 10000) / 100 * 60)
    + (h.run_duration % 100)                              AS duration_seconds,
    LEFT(h.message, 500)                                  AS message
FROM msdb.dbo.sysjobhistory  h
JOIN msdb.dbo.sysjobs        j ON j.job_id = h.job_id
WHERE h.run_date >= CONVERT(int, CONVERT(varchar(8), DATEADD(day, -7, GETDATE()), 112))
ORDER BY h.run_date DESC, h.run_time DESC;
```

### Jobs that failed in the last 24 hours

```sql
SELECT
    j.name        AS job_name,
    h.step_name,
    CONVERT(datetime,
        STUFF(STUFF(CAST(h.run_date AS varchar(8)), 7, 0, '-'), 5, 0, '-')
        + ' '
        + STUFF(STUFF(RIGHT('000000' + CAST(h.run_time AS varchar(6)), 6), 5, 0, ':'), 3, 0, ':')
    )             AS run_start,
    LEFT(h.message, 500) AS failure_message
FROM msdb.dbo.sysjobhistory  h
JOIN msdb.dbo.sysjobs        j  ON j.job_id = h.job_id
WHERE h.run_status = 0               -- failed
  AND h.step_id   > 0               -- exclude job-level summary row (step_id=0)
  AND h.run_date  >= CONVERT(int, CONVERT(varchar(8), DATEADD(hour, -24, GETDATE()), 112))
ORDER BY h.run_date DESC, h.run_time DESC;
```

### Currently running jobs

```sql
SELECT
    j.name           AS job_name,
    a.start_execution_date,
    DATEDIFF(second, a.start_execution_date, GETDATE()) AS running_seconds,
    ja.last_executed_step_id,
    ja.last_executed_step_date
FROM msdb.dbo.sysjobactivity  a
JOIN msdb.dbo.sysjobs          j  ON j.job_id = a.job_id
LEFT JOIN (
    SELECT job_id, last_executed_step_id = step_id,
           last_executed_step_date = MAX(run_requested_date)
    FROM msdb.dbo.sysjobhistory
    GROUP BY job_id, step_id
) ja ON ja.job_id = j.job_id
WHERE a.session_id = (
    SELECT MAX(session_id) FROM msdb.dbo.syssessions
)
  AND a.start_execution_date IS NOT NULL
  AND a.stop_execution_date  IS NULL;
```

### Job schedule summary

```sql
SELECT
    j.name           AS job_name,
    j.enabled,
    s.name           AS schedule_name,
    s.enabled        AS schedule_enabled,
    CASE s.freq_type
        WHEN 1   THEN 'One time'
        WHEN 4   THEN 'Daily every ' + CAST(s.freq_interval AS varchar) + ' day(s)'
        WHEN 8   THEN 'Weekly'
        WHEN 16  THEN 'Monthly day ' + CAST(s.freq_interval AS varchar)
        WHEN 32  THEN 'Monthly relative'
        WHEN 64  THEN 'Agent start'
        WHEN 128 THEN 'CPU idle'
    END              AS frequency,
    s.active_start_time
FROM msdb.dbo.sysjobs           j
JOIN msdb.dbo.sysjobschedules   js ON js.job_id = j.job_id
JOIN msdb.dbo.sysschedules      s  ON s.schedule_id = js.schedule_id
ORDER BY j.name;
```

### Last outcome per job (one row per job)

```sql
WITH LastRun AS (
    SELECT job_id,
           run_status,
           run_date,
           run_time,
           message,
           ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY run_date DESC, run_time DESC) AS rn
    FROM msdb.dbo.sysjobhistory
    WHERE step_id = 0   -- job-level summary only
)
SELECT
    j.name         AS job_name,
    j.enabled,
    CASE lr.run_status
        WHEN 0 THEN 'Failed'
        WHEN 1 THEN 'Succeeded'
        WHEN 2 THEN 'Retry'
        WHEN 3 THEN 'Cancelled'
        ELSE        'Unknown'
    END            AS last_status,
    CONVERT(datetime,
        STUFF(STUFF(CAST(lr.run_date AS varchar(8)), 7, 0, '-'), 5, 0, '-')
        + ' '
        + STUFF(STUFF(RIGHT('000000' + CAST(lr.run_time AS varchar(6)), 6), 5, 0, ':'), 3, 0, ':')
    )              AS last_run,
    LEFT(lr.message, 200) AS message
FROM msdb.dbo.sysjobs j
LEFT JOIN LastRun      lr ON lr.job_id = j.job_id AND lr.rn = 1
WHERE j.enabled = 1
ORDER BY j.name;
```

---

## Monitoring Agent Health

### Check if Agent is running (from T-SQL)

```sql
-- If this returns a row, Agent is running
SELECT *
FROM sys.dm_server_services
WHERE servicename LIKE N'SQL Server Agent%';
```

### View Agent error log

```sql
EXEC msdb.dbo.sp_cycle_agent_errorlog;   -- rotate the log (new log file)

-- Read Agent error log (no T-SQL equivalent — read from filesystem or SSMS)
-- Log path: same directory as SQL Server error log, named SQLAGENT.OUT (plus numbered rollover files)
```

### Alert history

```sql
SELECT
    a.name          AS alert_name,
    a.occurrence_count,
    a.last_occurrence_date,
    a.last_occurrence_time,
    a.last_response_date,
    a.last_response_time
FROM msdb.dbo.sysalerts a
ORDER BY a.last_occurrence_date DESC, a.last_occurrence_time DESC;
```

### Job history retention

Agent history is finite — old rows are purged when the count exceeds the limit.

```sql
-- View current history settings
EXEC msdb.dbo.sp_get_composite_job_info;

-- Change history limits (max rows per job and overall)
EXEC msdb.dbo.sp_set_sqlagent_properties
    @jobhistory_max_rows           = 100000,  -- default: 1000 total
    @jobhistory_max_rows_per_job   = 1000;    -- default: 100 per job
```

> [!WARNING]
> Default history limits (1000 total / 100 per job) are far too low for production. Increase them immediately or use a custom job history table.

---

## Error Handling Between Steps

SQL Server Agent has limited awareness of T-SQL errors inside steps. These patterns make step failure detection reliable:

### Pattern 1: XACT_ABORT + TRY/CATCH with THROW

```sql
SET XACT_ABORT ON;
BEGIN TRY
    BEGIN TRANSACTION;
    -- ... work ...
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;   -- re-raise: non-zero exit → step fails
END CATCH;
```

### Pattern 2: Explicit RAISERROR with severity >= 11

Any unhandled error with severity 11–25 causes the step to fail:

```sql
IF NOT EXISTS (SELECT 1 FROM dbo.SomeTable WHERE ...)
BEGIN
    RAISERROR('Prerequisite check failed: no rows found in SomeTable', 16, 1);
    RETURN;
END;
```

### Pattern 3: Return value from a stored procedure

Agent does not inspect stored procedure return values automatically. Wrap calls:

```sql
DECLARE @rc int;
EXEC @rc = dbo.usp_SomeProc;
IF @rc <> 0
    RAISERROR('usp_SomeProc failed with return code %d', 16, 1, @rc);
```

### Pattern 4: Multi-step with cleanup step

Use step routing (see [Step Success/Failure Routing](#step-successfailure-routing)) to route failures to a cleanup step that logs the error and returns exit code 2 (fail) so the job is marked failed.

---

## Azure SQL Considerations

| Feature | Azure SQL Database | Azure SQL Managed Instance |
|---|---|---|
| SQL Server Agent | **Not available** | Full support |
| T-SQL job management (`sp_add_job`) | Not available | Same as on-prem |
| Elastic Jobs | GA — use instead of Agent | Not needed |
| Azure Automation | Can call Azure SQL | Can call MI |
| WMI alerts | Not available | Available |
| Performance condition alerts | Not available | Available |
| Database Mail | Not available on DB | Available on MI |

### Elastic Jobs (Azure SQL Database replacement)

```sql
-- Create elastic job agent (done once per resource group in Azure Portal or ARM)
-- Then use elastic jobs T-SQL (different stored procs than Agent):
EXEC jobs.sp_add_job @job_name = N'Nightly Maintenance';
EXEC jobs.sp_add_jobstep
    @job_name         = N'Nightly Maintenance',
    @command          = N'UPDATE STATISTICS dbo.Orders;',
    @target_group_name = N'All Prod Databases';
EXEC jobs.sp_start_job @job_name = N'Nightly Maintenance';
```

---

## Common Patterns

### Job failure email notification procedure

```sql
CREATE OR ALTER PROCEDURE dbo.usp_NotifyJobFailure
    @JobName     nvarchar(128),
    @StepName    nvarchar(128),
    @ErrorMsg    nvarchar(2048)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @body nvarchar(4000);
    SET @body = N'<h3>Job Failure Alert</h3>'
              + N'<b>Server:</b> ' + @@SERVERNAME + N'<br>'
              + N'<b>Job:</b> '    + @JobName + N'<br>'
              + N'<b>Step:</b> '   + @StepName + N'<br>'
              + N'<b>Time:</b> '   + CONVERT(varchar(25), GETDATE(), 120) + N'<br>'
              + N'<b>Error:</b> '  + @ErrorMsg;

    EXEC msdb.dbo.sp_send_dbmail
        @profile_name  = N'Default',
        @recipients    = N'dba-team@company.com',
        @subject       = N'SQL Agent Job Failed: ' + @JobName,
        @body          = @body,
        @body_format   = N'HTML';
END;
```

### Disable all jobs matching a pattern (maintenance window)

```sql
-- Disable all backup jobs during migration
UPDATE msdb.dbo.sysjobs
SET enabled = 0
WHERE name LIKE N'%Backup%';

-- Re-enable afterwards
UPDATE msdb.dbo.sysjobs
SET enabled = 1
WHERE name LIKE N'%Backup%';
```

> [!WARNING]
> Direct table updates to `msdb` are generally unsupported. Prefer `sp_update_job @enabled = 0` for single jobs. For bulk operations, consider a cursor over `sp_update_job` or use `dbatools` (`Disable-DbaAgentJob`).

### Audit job changes with DDL trigger

```sql
CREATE TRIGGER trg_AuditJobChanges
ON DATABASE
FOR DDL_DATABASE_LEVEL_EVENTS
AS
BEGIN
    -- Agent changes fire through msdb stored procedures, not DDL events
    -- Use the sysjobs_view change_date column instead:
    -- SELECT * FROM msdb.dbo.sysjobs ORDER BY date_modified DESC
END;
```

Agent job changes do not fire DDL triggers. Track changes using `sysjobs.date_modified` or `sp_help_jobhistory`.

### Check job exists before creating

```sql
IF NOT EXISTS (
    SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'My Job'
)
BEGIN
    EXEC msdb.dbo.sp_add_job @job_name = N'My Job', ...;
END;
```

### List jobs owned by a specific login

```sql
SELECT
    j.name,
    j.enabled,
    SUSER_SNAME(j.owner_sid) AS owner
FROM msdb.dbo.sysjobs j
WHERE SUSER_SNAME(j.owner_sid) = N'CORP\svc-account'
ORDER BY j.name;
```

### Transfer jobs between servers with dbatools (PowerShell)

```powershell
# Copy all Agent jobs from one server to another
Copy-DbaAgentJob -Source SQLOLD -Destination SQLNEW

# Export all jobs to JSON files for source control
Export-DbaAgentJob -SqlInstance SQLPROD -Path C:\AgentJobs\
```

---

## Gotchas

1. **Agent must be running** — SQL Server can be up while Agent is stopped. Jobs will silently not run. Set Agent to Automatic start in Windows Services.

2. **Default history limits are tiny** — 1000 total rows / 100 per job means active servers lose history within hours. Increase with `sp_set_sqlagent_properties`.

3. **Job owner SID mismatch after restore** — When msdb is restored to a new server, job owner SIDs may not match logins. Run `EXEC msdb.dbo.sp_update_job @job_name = ..., @owner_login_name = ...` to re-map owners.

4. **`@database_name` defaults to `msdb`** — If you omit `@database_name` in `sp_add_jobstep`, T-SQL steps run in the context of `msdb`, not your application database. Always specify it.

5. **T-SQL step failures require severity ≥ 11** — A `PRINT` statement or `RAISERROR` with severity ≤ 10 does not fail a step. You must raise with severity 11 or higher, or the step succeeds even when your business logic detected an error.

6. **SSIS steps require matching bitness** — If the SSIS package uses 32-bit drivers, you may need the 32-bit runtime. SQL Server Agent runs 64-bit by default. Configure the step to use 32-bit via the package properties.

7. **Non-sysadmin owners of CmdExec/SSIS steps need a proxy** — Without a proxy, Agent will fail the step with "Access is denied". Sysadmin members bypass this requirement — which is why Agent service accounts are often (dangerously) sysadmin.

8. **Alerts don't fire for `PRINT` output** — Alerts fire on errors written to the SQL Server error log. Only errors raised with `WITH LOG` or severity ≥ 17 go to the error log automatically. Use `RAISERROR(...) WITH LOG` to guarantee alert firing.

9. **`delay_between_responses` is critical for noisy alerts** — Without a delay, a flooding error can generate thousands of emails per hour. Set `@delay_between_responses` to at least 300 seconds (5 min) for most alerts.

10. **Run-time of `run_duration` is HHMMSS integer** — `run_duration = 10230` means 1 hour, 2 minutes, 30 seconds — not 10,230 seconds. Use the conversion formula in the queries above.

11. **Multi-server jobs: target server must be enlisted first** — Sending a job to `N'ALL'` only reaches currently enlisted target servers. New servers added later need the job pushed to them explicitly.

12. **Job steps run in their own SPID** — There is no implicit transaction across steps. Each step starts fresh. If step 1 creates a temp table and step 2 needs it, use a real table (permanent or `##global_temp`), not `#local_temp`.

---

## See Also

- [`48-database-mail.md`](48-database-mail.md) — Required for email notifications from alerts and jobs
- [`49-configuration-tuning.md`](49-configuration-tuning.md) — sp_configure, Resource Governor (for throttling Agent workloads)
- [`44-backup-restore.md`](44-backup-restore.md) — Ola Hallengren backup jobs (the most common Agent job pattern)
- [`38-auditing.md`](38-auditing.md) — SQL Server Audit (alternative/complement to Agent-driven alerts)

---

## Sources

[^1]: [SQL Server Backup, Integrity Check, Index and Statistics Maintenance](https://ola.hallengren.com) — Ola Hallengren's free SQL Server maintenance solution covering backups, integrity checks, and index/statistics optimization
[^2]: [dbatools | SQL Server automation with PowerShell](https://dbatools.io) — free open-source PowerShell module with 700+ commands for SQL Server automation, including job copy and export
[^3]: [SQL Server Agent](https://learn.microsoft.com/en-us/ssms/agent/sql-server-agent) — Microsoft Learn overview of SQL Server Agent: jobs, schedules, alerts, operators, proxies, and security model
[^4]: [sp_add_job (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-add-job-transact-sql) — T-SQL reference for sp_add_job, covering all parameters, permissions, and usage examples
[^5]: [Elastic Jobs Overview - Azure SQL Database](https://learn.microsoft.com/en-us/azure/azure-sql/database/elastic-jobs-overview) — overview of Azure Elastic Jobs as the SQL Server Agent replacement for Azure SQL Database

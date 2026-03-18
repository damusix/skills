# 48 — Database Mail

## Table of Contents
1. [When to Use](#when-to-use)
2. [Architecture Overview](#architecture-overview)
3. [Enabling Database Mail](#enabling-database-mail)
4. [Mail Accounts](#mail-accounts)
5. [Mail Profiles](#mail-profiles)
6. [Sending Mail](#sending-mail)
7. [sp_send_dbmail Parameters](#sp_send_dbmail-parameters)
8. [HTML Mail](#html-mail)
9. [Attachments and Query Results](#attachments-and-query-results)
10. [Testing and Troubleshooting](#testing-and-troubleshooting)
11. [SQL Server Agent Integration](#sql-server-agent-integration)
12. [Operators and Alerts](#operators-and-alerts)
13. [Monitoring the Mail Queue](#monitoring-the-mail-queue)
14. [Security and Permissions](#security-and-permissions)
15. [Configuration Options](#configuration-options)
16. [Azure SQL Considerations](#azure-sql-considerations)
17. [Metadata Queries](#metadata-queries)
18. [Common Patterns](#common-patterns)
19. [Gotchas](#gotchas)
20. [See Also](#see-also)
21. [Sources](#sources)

---

## When to Use

Database Mail is the standard mechanism for sending email from SQL Server, replacing the deprecated SQL Mail (MAPI-based). Use it for:

- SQL Server Agent job failure/success notifications
- Alerting operators on error conditions or threshold breaches
- Sending query results (reports) on a schedule via Agent jobs
- Application-level email notifications triggered by T-SQL procedures
- DBA operational alerts (long blocking, disk space, backup failures)

**Do not use** Database Mail for high-volume transactional email (rate-limited by SMTP relay, no bounce handling, no template engine). For bulk or transactional email at application scale, use an external service (SendGrid, SES, etc.) and call it from the application layer.

---

## Architecture Overview

Database Mail runs as an **external host process** (`DatabaseMail.exe`) outside the SQL Server engine process. This isolation means a mail sending failure cannot crash SQL Server.

```
SQL Server engine
│
├── msdb.dbo.sysmail_* tables  ← queue and log storage
│
└── DatabaseMail.exe (external process)
        │
        └── SMTP server  →  recipient
```

Key design points:
- Mail is queued in `msdb` tables asynchronously; `sp_send_dbmail` returns immediately
- The external mailer process polls the queue and delivers mail via SMTP
- All sent mail, retries, and errors are logged in `msdb`
- Service Broker queues internally transport messages between the engine and external process
- Multiple accounts per profile with failover priority

---

## Enabling Database Mail

Database Mail is disabled by default. Enable via `sp_configure`:

```sql
-- Enable the 'Database Mail XPs' advanced option
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;
EXEC sp_configure 'Database Mail XPs', 1;
RECONFIGURE;
```

Or use the Database Mail Configuration Wizard in SSMS (Management → Database Mail → Configure Database Mail).

Verify it is enabled:
```sql
SELECT name, value_in_use
FROM sys.configurations
WHERE name = 'Database Mail XPs';
-- value_in_use = 1  → enabled
```

---

## Mail Accounts

A **mail account** represents one SMTP sender configuration (server, port, credentials, from address). Accounts are stored in `msdb`.

```sql
EXEC msdb.dbo.sysmail_add_account_sp
    @account_name        = 'PrimaryMailAccount',
    @description         = 'Primary SMTP relay via internal mail server',
    @email_address       = 'sqlserver@company.com',
    @display_name        = 'SQL Server Notifications',
    @replyto_address     = 'dba-team@company.com',   -- optional reply-to
    @mailserver_name     = 'smtp.company.com',
    @port                = 587,
    @enable_ssl          = 1,
    @username            = 'sqlserver@company.com',  -- omit for anonymous relay
    @password            = 'SecureP@ssword!';         -- omit for anonymous relay
```

**Account parameters:**

| Parameter | Notes |
|---|---|
| `@mailserver_name` | SMTP host (FQDN or IP) |
| `@port` | 25 (SMTP), 587 (STARTTLS), 465 (SSL) |
| `@enable_ssl` | 1 for TLS/SSL, 0 for plain text |
| `@username` / `@password` | For authenticated SMTP; omit for anonymous relay (common inside corporate networks) |
| `@email_address` | From address; must be allowed by your SMTP relay |
| `@display_name` | Friendly name shown in email client |

Modify an existing account:
```sql
EXEC msdb.dbo.sysmail_update_account_sp
    @account_name    = 'PrimaryMailAccount',
    @mailserver_name = 'smtp-new.company.com',
    @port            = 587;
```

Delete an account (must not be in use by a profile):
```sql
EXEC msdb.dbo.sysmail_delete_account_sp
    @account_name = 'PrimaryMailAccount';
```

---

## Mail Profiles

A **profile** is a named collection of accounts with priority ordering. SQL Server picks accounts in priority order, failing over to the next on error.

```sql
-- Create the profile
EXEC msdb.dbo.sysmail_add_profile_sp
    @profile_name = 'DBAProfile',
    @description  = 'Default profile for DBA notifications';

-- Add primary account (sequence_number = 1 = highest priority)
EXEC msdb.dbo.sysmail_add_profileaccount_sp
    @profile_name    = 'DBAProfile',
    @account_name    = 'PrimaryMailAccount',
    @sequence_number = 1;

-- Add fallback account
EXEC msdb.dbo.sysmail_add_profileaccount_sp
    @profile_name    = 'DBAProfile',
    @account_name    = 'BackupMailAccount',
    @sequence_number = 2;
```

**Set a default public profile** (used when no profile is specified in `sp_send_dbmail`):

```sql
EXEC msdb.dbo.sysmail_add_principalprofile_sp
    @profile_name  = 'DBAProfile',
    @principal_name = 'public',   -- all database users in msdb
    @is_default    = 1;
```

Grant a specific database user access to a profile:
```sql
EXEC msdb.dbo.sysmail_add_principalprofile_sp
    @profile_name   = 'DBAProfile',
    @principal_name = 'AppLoginUser',
    @is_default     = 0;
```

---

## Sending Mail

### Minimal send

```sql
EXEC msdb.dbo.sp_send_dbmail
    @recipients  = 'dba@company.com',
    @subject     = 'Test from SQL Server',
    @body        = 'This is a plain text message.';
```

### Multiple recipients

Separate addresses with semicolons:
```sql
EXEC msdb.dbo.sp_send_dbmail
    @recipients   = 'alice@company.com;bob@company.com',
    @copy_recipients  = 'manager@company.com',
    @blind_copy_recipients = 'audit@company.com',
    @subject      = 'Monthly report',
    @body         = 'See attached.';
```

### Specifying a profile explicitly

```sql
EXEC msdb.dbo.sp_send_dbmail
    @profile_name = 'DBAProfile',
    @recipients   = 'dba@company.com',
    @subject      = 'Alert',
    @body         = 'Explicit profile used.';
```

---

## sp_send_dbmail Parameters

Full reference:

| Parameter | Type | Notes |
|---|---|---|
| `@profile_name` | sysname | If omitted, uses the default profile for the calling principal |
| `@recipients` | varchar(MAX) | Semicolon-separated TO addresses; required |
| `@copy_recipients` | varchar(MAX) | CC addresses |
| `@blind_copy_recipients` | varchar(MAX) | BCC addresses |
| `@from_address` | varchar(MAX) | Override the account's from address (must be permitted by SMTP relay) |
| `@reply_to` | varchar(MAX) | Override reply-to address |
| `@subject` | nvarchar(255) | Subject line |
| `@body` | nvarchar(MAX) | Message body (plain text or HTML) |
| `@body_format` | varchar(20) | `'TEXT'` (default) or `'HTML'` |
| `@importance` | varchar(6) | `'Low'`, `'Normal'` (default), `'High'` |
| `@sensitivity` | varchar(12) | `'Normal'`, `'Personal'`, `'Private'`, `'Confidential'` |
| `@file_attachments` | nvarchar(MAX) | Semicolon-separated file paths (server-side) |
| `@query` | nvarchar(MAX) | T-SQL query whose results are included in body or attached as file |
| `@execute_query_database` | sysname | Database context for `@query` |
| `@attach_query_result_as_file` | bit | 0 = include in body (default), 1 = attach as file |
| `@query_attachment_filename` | nvarchar(260) | Filename for attached query results |
| `@query_result_header` | bit | 1 = include column headers (default), 0 = omit |
| `@query_result_width` | int | Column width for text formatting (default 256) |
| `@query_result_separator` | char(1) | Column separator (default tab `\t`) |
| `@exclude_query_output` | bit | 1 = suppress messages/rowcounts from query |
| `@append_query_error` | bit | 1 = include query errors in body; 0 = fail silently |
| `@query_no_truncate` | bit | 1 = do not truncate large column values |
| `@query_result_no_padding` | bit | 1 = remove right-padding from columns (2012+) |
| `@mailitem_id` | int OUTPUT | Assigned mail item ID for tracking |

---

## HTML Mail

Set `@body_format = 'HTML'` and supply HTML in `@body`. The mail client renders it.

```sql
DECLARE @html_body NVARCHAR(MAX);

SET @html_body = N'
<html>
<head>
  <style>
    body  { font-family: Arial, sans-serif; font-size: 12px; }
    table { border-collapse: collapse; width: 100%; }
    th    { background-color: #003366; color: white; padding: 6px; text-align: left; }
    td    { border: 1px solid #cccccc; padding: 4px; }
    tr:nth-child(even) { background-color: #f2f2f2; }
  </style>
</head>
<body>
  <h2>Index Fragmentation Alert</h2>
  <p>The following indexes exceed 30% fragmentation as of '
    + CONVERT(varchar, GETDATE(), 120) + N':</p>
  <table>
    <tr><th>Database</th><th>Table</th><th>Index</th><th>Fragmentation %</th></tr>';

-- Append rows from a query
SELECT @html_body = @html_body + N'
    <tr>
      <td>' + DB_NAME() + N'</td>
      <td>' + OBJECT_NAME(ips.object_id) + N'</td>
      <td>' + i.name + N'</td>
      <td>' + CAST(CAST(ips.avg_fragmentation_in_percent AS INT) AS varchar) + N'%</td>
    </tr>'
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
JOIN sys.indexes i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
WHERE ips.avg_fragmentation_in_percent > 30
  AND ips.page_count > 1000;

SET @html_body = @html_body + N'
  </table>
</body>
</html>';

EXEC msdb.dbo.sp_send_dbmail
    @profile_name = 'DBAProfile',
    @recipients   = 'dba@company.com',
    @subject      = 'Index Fragmentation Alert',
    @body         = @html_body,
    @body_format  = 'HTML';
```

> [!WARNING]
> HTML support depends on the recipient's mail client. Inline CSS is more reliable than `<style>` blocks for HTML email compatibility. Test with actual mail clients.

---

## Attachments and Query Results

### Include query results in the body

```sql
EXEC msdb.dbo.sp_send_dbmail
    @profile_name             = 'DBAProfile',
    @recipients               = 'dba@company.com',
    @subject                  = 'Top 10 Queries by CPU',
    @body                     = 'Top queries by total CPU:',
    @query                    = N'
        SELECT TOP 10
            SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
                ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
                  ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS query_text,
            qs.total_worker_time / 1000 AS total_cpu_ms,
            qs.execution_count,
            qs.total_worker_time / qs.execution_count / 1000 AS avg_cpu_ms
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
        ORDER BY qs.total_worker_time DESC;',
    @execute_query_database   = 'master',
    @query_result_separator   = N',',
    @query_no_truncate        = 1;
```

### Attach query results as a CSV file

```sql
EXEC msdb.dbo.sp_send_dbmail
    @profile_name                 = 'DBAProfile',
    @recipients                   = 'reports@company.com',
    @subject                      = 'Daily Sales Report',
    @body                         = 'See attached CSV.',
    @query                        = N'SELECT * FROM dbo.DailySalesReport;',
    @execute_query_database       = 'SalesDB',
    @attach_query_result_as_file  = 1,
    @query_attachment_filename    = 'DailySales.csv',
    @query_result_separator       = N',',
    @query_result_header          = 1,
    @query_no_truncate            = 1,
    @query_result_no_padding      = 1;
```

### Attach a server-side file

```sql
EXEC msdb.dbo.sp_send_dbmail
    @profile_name    = 'DBAProfile',
    @recipients      = 'dba@company.com',
    @subject         = 'Error Log',
    @body            = 'Today''s SQL Server error log attached.',
    @file_attachments = N'D:\SQLLogs\ERRORLOG';
```

> [!WARNING]
> `@file_attachments` paths are read from the **SQL Server service account's** file system perspective, not the client. The file must be accessible to the SQL Server service account. There is a configurable maximum attachment size (default 1 MB — see [Configuration Options](#configuration-options)).

---

## Testing and Troubleshooting

### Send a test message

```sql
EXEC msdb.dbo.sp_send_dbmail
    @profile_name = 'DBAProfile',
    @recipients   = 'youremail@company.com',
    @subject      = 'Database Mail Test',
    @body         = 'If you receive this, Database Mail is working.';
```

### Check mail status immediately

```sql
-- View recent mail items
SELECT TOP 20
    mailitem_id,
    profile_name,
    recipients,
    subject,
    sent_status,   -- 'sent', 'failed', 'unsent', 'retrying'
    sent_date,
    last_mod_date
FROM msdb.dbo.sysmail_allitems
ORDER BY mailitem_id DESC;
```

### View error log for failed messages

```sql
SELECT TOP 50
    log_id,
    event_type,    -- 'success', 'warning', 'error', 'informational'
    log_date,
    description,
    process_id,
    mailitem_id,
    account_id,
    last_mod_date
FROM msdb.dbo.sysmail_event_log
WHERE event_type IN ('error', 'warning')
ORDER BY log_id DESC;
```

### Check mail queue status

```sql
-- Unsent or retrying items
SELECT mailitem_id, recipients, subject, sent_status, last_mod_date
FROM msdb.dbo.sysmail_unsentitems
ORDER BY mailitem_id DESC;

-- Failed items
SELECT mailitem_id, recipients, subject, sent_status, sent_date
FROM msdb.dbo.sysmail_faileditems
ORDER BY mailitem_id DESC;
```

### Restart the Database Mail external process

If mail is stuck in the queue after fixing an SMTP issue:

```sql
-- Stop the external mail process
EXEC msdb.dbo.sysmail_stop_sp;

-- Restart it
EXEC msdb.dbo.sysmail_start_sp;
```

> [!NOTE]
> `sysmail_stop_sp` stops the external process but does not clear the queue. Queued messages will be delivered when the process restarts.

### Verify Service Broker is enabled in msdb

Database Mail depends on Service Broker in `msdb`. If SSB is disabled, mail will not be delivered:

```sql
SELECT name, is_broker_enabled
FROM sys.databases
WHERE name = 'msdb';
-- is_broker_enabled must be 1
```

If disabled:
```sql
-- WARNING: Briefly takes msdb offline. Do this in a maintenance window.
ALTER DATABASE msdb SET ENABLE_BROKER WITH ROLLBACK IMMEDIATE;
```

---

## SQL Server Agent Integration

### Configure Agent to use Database Mail

In SQL Server Agent properties (SSMS: SQL Server Agent → Properties → Alert System):

```sql
-- Via T-SQL (stored in msdb registry-equivalent)
EXEC msdb.dbo.sp_set_sqlagent_properties
    @email_save_in_sent_folder = 1;

-- Configure via SSMS: SQL Server Agent → Properties → Alert System
-- Set: Mail Session → Mail System = Database Mail
--                   → Mail Profile = DBAProfile
```

Or in T-SQL against `msdb`:
```sql
USE msdb;
-- The Agent reads its mail profile from the registry; configure via SSMS
-- or update the 'AlertMailSession' value in Agent's configuration.
```

> [!NOTE]
> After changing the Agent mail profile, restart SQL Server Agent for changes to take effect.

### Notify an operator from a job step (T-SQL)

```sql
-- In a job step, send a notification if a condition is met:
IF (SELECT COUNT(*) FROM dbo.ErrorLog WHERE LogDate > DATEADD(HOUR, -1, GETDATE())) > 0
BEGIN
    EXEC msdb.dbo.sp_send_dbmail
        @profile_name = 'DBAProfile',
        @recipients   = 'dba@company.com',
        @subject      = 'Recent errors detected',
        @body         = 'Check dbo.ErrorLog for errors in the past hour.';
END
```

---

## Operators and Alerts

### Create an operator

An **operator** is a named email/pager/net send destination for Agent notifications:

```sql
EXEC msdb.dbo.sp_add_operator
    @name                   = 'DBATeam',
    @enabled                = 1,
    @email_address          = 'dba-team@company.com',
    @weekday_pager_start_time = 080000,   -- HHMMSS
    @weekday_pager_end_time   = 200000,
    @pager_days               = 62;       -- bitmask: 62 = Mon-Fri
```

Modify an operator:
```sql
EXEC msdb.dbo.sp_update_operator
    @name          = 'DBATeam',
    @email_address = 'new-dba-team@company.com';
```

### Create an alert

Alerts trigger when SQL Server raises an error of a given severity or number, or when a performance counter threshold is crossed.

```sql
-- Alert on severity 19+ errors (resource errors)
EXEC msdb.dbo.sp_add_alert
    @name               = 'Severity 19+ Alert',
    @severity           = 19,
    @enabled            = 1,
    @delay_between_responses = 60,   -- seconds between repeated firings
    @notification_message = 'Check SQL Server error log immediately.';

-- Notify the DBATeam operator by email
EXEC msdb.dbo.sp_add_notification
    @alert_name     = 'Severity 19+ Alert',
    @operator_name  = 'DBATeam',
    @notification_method = 1;  -- 1=email, 2=pager, 4=net send; bitmask

-- Alert on a specific error number
EXEC msdb.dbo.sp_add_alert
    @name             = '1105 Filegroup Full',
    @message_id       = 1105,
    @enabled          = 1,
    @delay_between_responses = 300;

EXEC msdb.dbo.sp_add_notification
    @alert_name          = '1105 Filegroup Full',
    @operator_name       = 'DBATeam',
    @notification_method = 1;
```

**Alert types:**

| `@alert_type` | Use |
|---|---|
| 1 (SQL Server Event) | Fires on error number or severity (most common) |
| 2 (SQL Server Performance Condition) | PerfMon counter threshold |
| 3 (WMI Event) | WMI query result |

### Alert on performance condition

```sql
-- Alert when available memory drops below 100 MB
EXEC msdb.dbo.sp_add_alert
    @name                        = 'Low Memory Alert',
    @alert_type                  = 2,
    @performance_condition       = N'SQLServer:Memory Manager|Available MBytes|<|100',
    @enabled                     = 1,
    @delay_between_responses     = 300;

EXEC msdb.dbo.sp_add_notification
    @alert_name          = 'Low Memory Alert',
    @operator_name       = 'DBATeam',
    @notification_method = 1;
```

### Add notifications to an existing job

```sql
-- Notify on job failure
EXEC msdb.dbo.sp_update_job
    @job_name               = 'Nightly Backup',
    @notify_level_email     = 2,   -- 1=success, 2=failure, 3=both
    @notify_email_operator_name = 'DBATeam';
```

---

## Monitoring the Mail Queue

### Service Broker queue monitoring for Database Mail

```sql
-- Check if the SSB queue for Database Mail is backed up
SELECT
    q.name,
    q.activation_enabled,
    q.receive_enabled,
    q.enqueue_enabled,
    SUM(CASE WHEN m.message_type_name IS NOT NULL THEN 1 ELSE 0 END) AS queued_messages
FROM sys.service_queues q
LEFT JOIN sys.transmission_queue m
    ON m.to_service_name = 'InternalMailService'
WHERE q.name IN ('ExternalMailQueue', 'InternalMailQueue')
GROUP BY q.name, q.activation_enabled, q.receive_enabled, q.enqueue_enabled;
```

### Mail item counts by status

```sql
SELECT sent_status, COUNT(*) AS item_count
FROM msdb.dbo.sysmail_allitems
GROUP BY sent_status;
```

### Recent mail activity with error details

```sql
SELECT
    a.mailitem_id,
    a.recipients,
    a.subject,
    a.sent_status,
    a.sent_date,
    el.event_type,
    el.description AS error_detail
FROM msdb.dbo.sysmail_allitems a
LEFT JOIN msdb.dbo.sysmail_event_log el
    ON el.mailitem_id = a.mailitem_id
   AND el.event_type = 'error'
WHERE a.sent_date > DATEADD(DAY, -7, GETDATE())
ORDER BY a.mailitem_id DESC;
```

---

## Security and Permissions

### Who can send mail

By default, only members of the **sysadmin** fixed server role and users with access to a Database Mail profile can send mail. Grant access to a profile explicitly:

```sql
-- Grant a database user in msdb access to a profile
USE msdb;
EXEC msdb.dbo.sysmail_add_principalprofile_sp
    @profile_name   = 'DBAProfile',
    @principal_name = 'AppUser',   -- msdb database principal
    @is_default     = 0;
```

For application users who are not msdb principals, use EXECUTE AS or a signing certificate to grant limited `sp_send_dbmail` access:

```sql
-- Grant EXECUTE permission on sp_send_dbmail in msdb
USE msdb;
GRANT EXECUTE ON msdb.dbo.sp_send_dbmail TO [AppUser];
```

### DatabaseMailUserRole

Members of the `DatabaseMailUserRole` fixed database role in `msdb` can send mail using any profile they have been granted access to:

```sql
USE msdb;
ALTER ROLE DatabaseMailUserRole ADD MEMBER [AppUser];
```

---

## Configuration Options

View and change Database Mail configuration parameters via `sysmail_configure_sp`:

```sql
-- View all current settings
EXEC msdb.dbo.sysmail_help_configure_sp;
```

Key settings:

| Parameter | Default | Notes |
|---|---|---|
| `AccountRetryAttempts` | 1 | Number of retry attempts per account on failure |
| `AccountRetryDelay` | 60 | Seconds between retry attempts |
| `DatabaseMailExeMinimumLifeTime` | 600 | Seconds the external process stays alive when idle |
| `DefaultAttachmentEncoding` | MIME | Attachment encoding: `MIME` or `UUEncoding` |
| `LoggingLevel` | 2 | 1=normal, 2=extended (default), 3=verbose |
| `MaxFileSize` | 1000000 | Maximum attachment size in bytes (default ~1 MB) |
| `ProhibitedExtensions` | exe,dll,vbs,js | File extensions blocked as attachments |

Change a setting:
```sql
EXEC msdb.dbo.sysmail_configure_sp
    @parameter_name  = 'MaxFileSize',
    @parameter_value = '5000000';   -- 5 MB

EXEC msdb.dbo.sysmail_configure_sp
    @parameter_name  = 'AccountRetryAttempts',
    @parameter_value = '3';
```

---

## Azure SQL Considerations

| Feature | Azure SQL Database | Azure SQL Managed Instance | On-Premises |
|---|---|---|---|
| Database Mail available | No | Yes (with limitations) | Yes |
| `sp_send_dbmail` | Not available | Available | Available |
| SQL Agent + operators | No (use Elastic Jobs) | Yes | Yes |
| Alternative for notifications | Logic Apps, Azure Functions, application layer | Database Mail | Database Mail |

> [!NOTE] Azure SQL Managed Instance
> Database Mail is supported on Managed Instance. Configure it the same way as on-premises. The Managed Instance uses public SMTP relay (port 25 is blocked; use port 587/465). Network Security Group rules must allow outbound SMTP to the relay.

For Azure SQL Database, implement email notifications through external services:
- Azure Logic Apps triggered by SQL event (via App Service, Azure Function, or scheduled query)
- Application-level exception handlers calling SendGrid/SES/etc.
- Azure Monitor alerts with action groups (for infrastructure-level events)

---

## Metadata Queries

### List all profiles

```sql
SELECT profile_id, name, description, last_mod_date
FROM msdb.dbo.sysmail_profile
ORDER BY name;
```

### List accounts and their profile memberships

```sql
SELECT
    p.name AS profile_name,
    a.name AS account_name,
    a.email_address,
    a.mailserver_name,
    a.port,
    a.enable_ssl,
    pa.sequence_number
FROM msdb.dbo.sysmail_profileaccount pa
JOIN msdb.dbo.sysmail_profile p ON p.profile_id = pa.profile_id
JOIN msdb.dbo.sysmail_account a ON a.account_id = pa.account_id
ORDER BY p.name, pa.sequence_number;
```

### List all operators

```sql
SELECT
    name,
    enabled,
    email_address,
    pager_address,
    weekday_pager_start_time,
    weekday_pager_end_time
FROM msdb.dbo.sysoperators
ORDER BY name;
```

### List all alerts with notifications

```sql
SELECT
    a.name AS alert_name,
    a.enabled,
    a.message_id,
    a.severity,
    a.performance_condition,
    a.delay_between_responses,
    o.name AS operator_name,
    n.notification_method
FROM msdb.dbo.sysalerts a
JOIN msdb.dbo.sysnotifications n ON n.alert_id = a.id
JOIN msdb.dbo.sysoperators o ON o.id = n.operator_id
ORDER BY a.name;
```

### Mail delivery statistics (last 30 days)

```sql
SELECT
    CAST(sent_date AS DATE)  AS send_date,
    sent_status,
    COUNT(*)                 AS item_count,
    SUM(file_size)           AS total_bytes_sent
FROM msdb.dbo.sysmail_allitems
WHERE sent_date > DATEADD(DAY, -30, GETDATE())
GROUP BY CAST(sent_date AS DATE), sent_status
ORDER BY send_date DESC, sent_status;
```

### Find which jobs notify which operators

```sql
SELECT
    j.name AS job_name,
    j.notify_level_email,
    o.name AS operator_name,
    o.email_address
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysoperators o
    ON o.id = j.notify_email_operator_id
WHERE j.notify_level_email > 0
ORDER BY j.name;
```

### Check Database Mail is running

```sql
SELECT status_desc
FROM sys.dm_broker_activated_tasks
WHERE database_id = DB_ID('msdb');

-- Or check the mail event log for recent activity
SELECT TOP 5 log_date, event_type, description
FROM msdb.dbo.sysmail_event_log
ORDER BY log_id DESC;
```

---

## Common Patterns

### Pattern 1 — Job failure notification procedure

```sql
CREATE OR ALTER PROCEDURE dbo.SendJobFailureAlert
    @job_name   sysname,
    @error_msg  nvarchar(4000) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @subject nvarchar(255) = N'SQL Agent Job FAILED: ' + @job_name;
    DECLARE @body    nvarchar(MAX);

    SET @body = N'Job Name  : ' + @job_name + CHAR(13) + CHAR(10)
              + N'Server    : ' + @@SERVERNAME + CHAR(13) + CHAR(10)
              + N'Time      : ' + CONVERT(varchar, GETDATE(), 121) + CHAR(13) + CHAR(10)
              + ISNULL(N'Error     : ' + @error_msg, N'(no error detail provided)');

    EXEC msdb.dbo.sp_send_dbmail
        @profile_name = 'DBAProfile',
        @recipients   = 'dba@company.com',
        @subject      = @subject,
        @body         = @body;
END;
GO
```

Call from a job step on failure:
```sql
EXEC dbo.SendJobFailureAlert @job_name = N'Nightly ETL', @error_msg = N'Step 3 failed.';
```

### Pattern 2 — Disk space alert

```sql
-- Run as an Agent job step (e.g., every 30 minutes)
DECLARE @threshold_gb INT = 20;
DECLARE @body NVARCHAR(MAX) = N'';
DECLARE @has_alerts BIT = 0;

-- Collect low-disk volumes
SELECT @body = @body
    + N'  Volume: ' + volume_mount_point
    + N'  Available: ' + CAST(available_bytes / 1073741824 AS varchar) + N' GB'
    + CHAR(13) + CHAR(10)
FROM sys.dm_os_volume_stats(DB_ID('master'), 1)
WHERE available_bytes / 1073741824 < @threshold_gb;

IF LEN(@body) > 0
BEGIN
    EXEC msdb.dbo.sp_send_dbmail
        @profile_name = 'DBAProfile',
        @recipients   = 'dba@company.com',
        @subject      = N'LOW DISK SPACE on ' + @@SERVERNAME,
        @body         = N'Low disk space detected:' + CHAR(13) + CHAR(10) + @body;
END
```

### Pattern 3 — Long-running query alert

```sql
-- Detect queries running longer than @threshold_minutes
DECLARE @threshold_minutes INT = 30;
DECLARE @body NVARCHAR(MAX);

SET @body = N'<html><body><table border="1"><tr><th>SPID</th><th>Login</th>'
          + N'<th>Database</th><th>Duration (min)</th><th>Query (first 200 chars)</th></tr>';

SELECT @body = @body + N'<tr><td>' + CAST(r.session_id AS varchar)
    + N'</td><td>' + s.login_name
    + N'</td><td>' + DB_NAME(r.database_id)
    + N'</td><td>' + CAST(DATEDIFF(MINUTE, r.start_time, GETDATE()) AS varchar)
    + N'</td><td>' + LEFT(REPLACE(REPLACE(st.text, '<', '&lt;'), '>', '&gt;'), 200)
    + N'</td></tr>'
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
WHERE DATEDIFF(MINUTE, r.start_time, GETDATE()) > @threshold_minutes
  AND r.session_id <> @@SPID
  AND s.is_user_process = 1;

SET @body = @body + N'</table></body></html>';

IF @body NOT LIKE '%<tr><td>%'   -- no data rows = nothing to send
    RETURN;

EXEC msdb.dbo.sp_send_dbmail
    @profile_name = 'DBAProfile',
    @recipients   = 'dba@company.com',
    @subject      = N'Long-running queries on ' + @@SERVERNAME,
    @body         = @body,
    @body_format  = N'HTML';
```

### Pattern 4 — Daily database backup status report

```sql
-- Send a summary of last night's backup outcomes
EXEC msdb.dbo.sp_send_dbmail
    @profile_name           = 'DBAProfile',
    @recipients             = 'dba@company.com',
    @subject                = N'Backup Status Report — ' + CONVERT(varchar, GETDATE(), 23),
    @body                   = N'Backup status for all user databases:',
    @query                  = N'
        SELECT
            d.name AS database_name,
            MAX(CASE b.type WHEN ''D'' THEN b.backup_finish_date END) AS last_full,
            MAX(CASE b.type WHEN ''I'' THEN b.backup_finish_date END) AS last_diff,
            MAX(CASE b.type WHEN ''L'' THEN b.backup_finish_date END) AS last_log,
            CASE
                WHEN MAX(CASE b.type WHEN ''D'' THEN b.backup_finish_date END) IS NULL
                THEN ''NEVER BACKED UP''
                WHEN MAX(CASE b.type WHEN ''D'' THEN b.backup_finish_date END)
                     < DATEADD(DAY, -1, GETDATE())
                THEN ''OVERDUE''
                ELSE ''OK''
            END AS status
        FROM sys.databases d
        LEFT JOIN msdb.dbo.backupset b
            ON b.database_name = d.name
           AND b.backup_finish_date > DATEADD(DAY, -2, GETDATE())
        WHERE d.database_id > 4   -- user databases only
          AND d.state_desc = ''ONLINE''
        GROUP BY d.name
        ORDER BY d.name;',
    @execute_query_database = 'master',
    @query_result_header    = 1,
    @query_result_separator = N'|',
    @query_no_truncate      = 1;
```

---

## Gotchas

1. **`sp_send_dbmail` is asynchronous.** It queues the message and returns immediately. A success return does not mean the mail was delivered — check `sysmail_allitems.sent_status`.

2. **Service Broker must be enabled in msdb.** Database Mail uses SSB internally. If SSB is disabled (e.g., after a restore of `msdb`), mail will queue but never send. Check `is_broker_enabled` in `sys.databases`.

3. **SMTP relay restrictions.** Corporate SMTP relays often restrict the allowed From address. The `@email_address` on the account must be whitelisted by the relay, or mail will bounce silently from the relay perspective but appear sent in `sysmail_allitems`.

4. **Attachment paths are server-side.** `@file_attachments` reads from the **SQL Server service account's** file system. Paths must be accessible to that account. UNC paths work if the service account has network access.

5. **Default profile scoping.** The public default profile (`@principal_name = 'public'`) is the fallback for any msdb user. If no profile is set as public default and `@profile_name` is omitted in `sp_send_dbmail`, the call fails with "The profile name is not valid."

6. **Large result sets via `@query`.** Results embedded in the body are formatted as fixed-width text. For large datasets, use `@attach_query_result_as_file = 1` instead of embedding in the body.

7. **`@query` runs under the SQL Server Agent service account context, not the caller.** If the query references objects the Agent service account cannot read, it will fail. Use `@execute_query_database` and ensure permissions.

8. **HTML escaping in dynamic bodies.** When building HTML bodies dynamically, escape `<`, `>`, `&` in user-supplied or data-driven content to prevent rendering issues: `REPLACE(val, '<', '&lt;')`.

9. **`@delay_between_responses` on alerts.** Without a delay, a high-frequency error can flood the operator with hundreds of emails. Always set a delay (e.g., 300 seconds) for production alerts.

10. **Mail history is kept indefinitely by default.** `sysmail_allitems` grows forever unless you purge it. Add a maintenance job:
    ```sql
    EXEC msdb.dbo.sysmail_delete_mailitems_sp
        @sent_before = DATEADD(DAY, -90, GETDATE()),
        @sent_status = 'sent';
    ```

11. **Restart required after Agent mail profile change.** Changing the Agent's mail profile in Agent Properties requires an Agent service restart to take effect.

12. **`ProhibitedExtensions` defaults block `.exe`, `.dll`, `.vbs`, `.js`.** Attempting to attach these will fail silently (mail queued, then fails during processing). Verify with `sysmail_event_log`.

---

## See Also

- [`references/50-sql-server-agent.md`](50-sql-server-agent.md) — Job steps, schedules, and Agent notification configuration
- [`references/38-auditing.md`](38-auditing.md) — SQL Server Audit for compliance; consider whether audit events should trigger mail alerts
- [`references/33-extended-events.md`](33-extended-events.md) — XE sessions for detecting the conditions that trigger mail alerts
- [`references/49-configuration-tuning.md`](49-configuration-tuning.md) — `sp_configure` options including Database Mail XPs

---

## Sources

[^1]: [Configure Database Mail](https://learn.microsoft.com/en-us/sql/relational-databases/database-mail/configure-database-mail) — how to enable and configure Database Mail using the wizard or T-SQL, including accounts, profiles, and system parameters
[^2]: [sp_send_dbmail (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-send-dbmail-transact-sql) — full parameter reference for the stored procedure that queues email messages via Database Mail
[^3]: [Database Mail Configuration Objects](https://learn.microsoft.com/en-us/sql/relational-databases/database-mail/database-mail-configuration-objects) — reference for Database Mail accounts, profiles, security, and configuration stored procedures
[^4]: [Operators](https://learn.microsoft.com/en-us/sql/ssms/agent/operators) — SQL Server Agent operators: named notification targets (email, pager, net send) used for alert and job notifications
[^5]: [Alerts](https://learn.microsoft.com/en-us/sql/ssms/agent/alerts) — SQL Server Agent alerts: event-driven notifications based on error numbers, severity levels, performance conditions, or WMI events

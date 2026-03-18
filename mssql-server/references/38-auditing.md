# SQL Server Audit

Comprehensive reference for SQL Server Audit: server and database audit specifications, action groups, audit destinations, reading audit logs, compliance mapping, and comparison with Extended Events for compliance use cases.

## Table of Contents

1. [When to Use](#when-to-use)
2. [Audit Architecture Overview](#audit-architecture-overview)
3. [CREATE SERVER AUDIT](#create-server-audit)
4. [Server Audit Specifications](#server-audit-specifications)
5. [Database Audit Specifications](#database-audit-specifications)
6. [Action Groups Reference](#action-groups-reference)
7. [Object-Level Auditing](#object-level-auditing)
8. [Audit Destinations](#audit-destinations)
9. [Reading Audit Logs](#reading-audit-logs)
10. [Managing Audits](#managing-audits)
11. [Compliance Mapping](#compliance-mapping)
12. [Audit vs Extended Events](#audit-vs-extended-events)
13. [Filtering Audit Records](#filtering-audit-records)
14. [Azure SQL Auditing](#azure-sql-auditing)
15. [Metadata Queries](#metadata-queries)
16. [Common Patterns](#common-patterns)
17. [Gotchas](#gotchas)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

Use SQL Server Audit when you need:

- **Regulatory compliance** — SOX, HIPAA, PCI-DSS, GDPR require auditable proof of data access and modification
- **Failed login tracking** — detect brute-force attempts and unauthorized access
- **Privileged operation logging** — capture DDL changes, permission grants, backup/restore, `EXECUTE AS`
- **Data access auditing** — track SELECT, INSERT, UPDATE, DELETE on sensitive tables
- **Schema change history** — record who altered or dropped objects and when
- **Non-repudiation** — tamper-evident log backed by hash chaining in file-based audits

SQL Server Audit is the **preferred mechanism for compliance auditing** over `fn_trace_gettable` (deprecated) and Extended Events (more flexible but harder to query for compliance reports). XE is better for performance diagnostics; SQL Audit is better for accountability trails.

---

## Audit Architecture Overview

SQL Server Audit works via a three-layer hierarchy:

```
SERVER AUDIT          ← defines the destination (file, Windows event log, App log)
  └── SERVER AUDIT SPECIFICATION    ← captures server-level events (logins, AG, DB operations)
  └── DATABASE AUDIT SPECIFICATION  ← captures database-level events (DML, DDL, schema access)
```

Key concepts:

| Term | Description |
|---|---|
| **Server Audit** | The audit object — defines destination, queue size, failure behavior |
| **Server Audit Specification** | Binds action groups to a Server Audit; server-scope events only |
| **Database Audit Specification** | Binds action groups and/or specific objects to a Server Audit; database-scope |
| **Action Group** | A named set of audit events (e.g., `FAILED_LOGIN_GROUP`) |
| **Audit Action** | A specific operation on a specific object (e.g., SELECT on dbo.Customers) |
| **Audit Queue** | In-memory buffer between event source and destination; configurable size |

One Server Audit can be used by multiple specifications. A database can have one Database Audit Specification per Server Audit.

---

## CREATE SERVER AUDIT

```sql
-- File-based audit (most common for compliance)
CREATE SERVER AUDIT ComplianceAudit
TO FILE
(
    FILEPATH = N'C:\SQLAudit\',          -- must exist and be writable by SQL service account
    MAXSIZE = 100 MB,                    -- per-file size before rolling; 0 = unlimited
    MAX_ROLLOVER_FILES = 50,             -- number of files to keep; UNLIMITED = keep all
    RESERVE_DISK_SPACE = OFF             -- ON pre-allocates full MAXSIZE immediately
)
WITH
(
    QUEUE_DELAY = 1000,                  -- ms; 0 = synchronous (guaranteed but slower)
    ON_FAILURE = CONTINUE,              -- CONTINUE | SHUTDOWN | FAIL_OPERATION
    AUDIT_GUID = 'a1b2c3d4-e5f6-...'    -- optional; useful for AG failover correlation
)
WHERE ([action_id] = 'SL'               -- optional server-side predicate filter
    OR [action_id] = 'IN');
GO

ALTER SERVER AUDIT ComplianceAudit WITH (STATE = ON);
GO
```

### Destination Options

| Destination | Syntax | Notes |
|---|---|---|
| File | `TO FILE (FILEPATH = N'...')` | Most common; binary `.sqlaudit` files; tamper-evident hash chain |
| Windows Security log | `TO APPLICATION_LOG` | Requires Windows permissions; `AUDIT_SUCCESS`/`AUDIT_FAILURE` events |
| Windows Application log | `TO SECURITY_LOG` | Requires "Generate security audits" privilege for SQL service account |
| `URL` (Azure) | `TO URL = N'...'` | Azure SQL / Azure Arc only; writes to Azure Storage |

### ON_FAILURE Behavior

| Value | Behavior | Use When |
|---|---|---|
| `CONTINUE` | Audit failures are silently dropped | Dev/non-critical — never for compliance |
| `SHUTDOWN` | SQL Server shuts down if audit can't write | Strict compliance; disk full = outage |
| `FAIL_OPERATION` | The audited operation is rejected | Compliance without full shutdown risk |

> [!WARNING] QUEUE_DELAY = 0
> Synchronous auditing (QUEUE_DELAY = 0) guarantees no audit record is lost but adds latency to every audited operation. Use QUEUE_DELAY = 1000 (1 second) for most workloads; drop to 0 only if regulations require guaranteed delivery.

---

## Server Audit Specifications

Server Audit Specifications capture **server-scope events**: logins, server configuration, database creation, backup/restore, `EXECUTE AS`, linked server usage, etc.

```sql
CREATE SERVER AUDIT SPECIFICATION ServerLoginAuditSpec
FOR SERVER AUDIT ComplianceAudit
ADD (FAILED_LOGIN_GROUP),
ADD (SUCCESSFUL_LOGIN_GROUP),
ADD (LOGOUT_GROUP),
ADD (SERVER_ROLE_MEMBER_CHANGE_GROUP),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP),
ADD (SCHEMA_OBJECT_CHANGE_GROUP),
ADD (BACKUP_RESTORE_GROUP),
ADD (DBCC_GROUP),
ADD (SERVER_PERMISSION_CHANGE_GROUP),
ADD (SERVER_PRINCIPAL_CHANGE_GROUP)
WITH (STATE = ON);
GO
```

> [!NOTE]
> A server can have at most **one Server Audit Specification per Server Audit**. To capture different event sets to different destinations, create multiple Server Audits.

---

## Database Audit Specifications

Database Audit Specifications capture **database-scope events**: DML, DDL, schema object access, role membership changes within the database. They must be created inside the target database.

```sql
USE SensitiveDB;
GO

CREATE DATABASE AUDIT SPECIFICATION SensitiveDataAuditSpec
FOR SERVER AUDIT ComplianceAudit
ADD (SELECT ON OBJECT::dbo.Customers BY PUBLIC),       -- object-level: any principal
ADD (INSERT ON OBJECT::dbo.Customers BY PUBLIC),
ADD (UPDATE ON OBJECT::dbo.Customers BY PUBLIC),
ADD (DELETE ON OBJECT::dbo.Customers BY PUBLIC),
ADD (EXECUTE ON OBJECT::dbo.usp_GetCustomer BY PUBLIC),
ADD (DATABASE_OBJECT_CHANGE_GROUP),                    -- DDL changes within this DB
ADD (DATABASE_PERMISSION_CHANGE_GROUP),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP),
ADD (USER_CHANGE_PASSWORD_GROUP)
WITH (STATE = ON);
GO
```

> [!NOTE]
> A database can have **one Database Audit Specification per Server Audit**. To audit different sets of tables to different destinations, create additional Server Audits.

---

## Action Groups Reference

### Server-Level Action Groups (for Server Audit Specifications)

| Action Group | What It Captures |
|---|---|
| `FAILED_LOGIN_GROUP` | Failed login attempts (wrong password, account locked) |
| `SUCCESSFUL_LOGIN_GROUP` | All successful logins |
| `LOGOUT_GROUP` | Session logouts |
| `SERVER_ROLE_MEMBER_CHANGE_GROUP` | Adding/removing members from server roles |
| `DATABASE_ROLE_MEMBER_CHANGE_GROUP` | Role membership changes in any database |
| `SERVER_PERMISSION_CHANGE_GROUP` | GRANT/DENY/REVOKE at server level |
| `SERVER_PRINCIPAL_CHANGE_GROUP` | CREATE/ALTER/DROP LOGIN |
| `DATABASE_CHANGE_GROUP` | CREATE/ALTER/DROP DATABASE |
| `DATABASE_OBJECT_CHANGE_GROUP` | DDL inside databases (all databases) |
| `BACKUP_RESTORE_GROUP` | BACKUP and RESTORE operations |
| `DBCC_GROUP` | DBCC command execution |
| `SCHEMA_OBJECT_CHANGE_GROUP` | CREATE/ALTER/DROP schema objects |
| `AUDIT_CHANGE_GROUP` | Changes to audit objects themselves |
| `SERVER_OBJECT_CHANGE_GROUP` | CREATE/ALTER/DROP server objects (triggers, endpoints) |
| `SERVER_STATE_CHANGE_GROUP` | SQL Server service start/stop |
| `EXECUTE_AS_GROUP` | EXECUTE AS context switches |
| `LINKED_SERVER_GROUP` | Linked server usage |
| `SERVER_OPERATION_GROUP` | Server operation events (memory, locks, delayed durability) |
| `TRACE_CHANGE_GROUP` | SQL Trace changes (use alongside XE for migration) |

### Database-Level Action Groups (for Database Audit Specifications)

| Action Group | What It Captures |
|---|---|
| `DATABASE_OBJECT_CHANGE_GROUP` | DDL within this database |
| `DATABASE_OBJECT_PERMISSION_CHANGE_GROUP` | GRANT/DENY/REVOKE on objects |
| `DATABASE_PERMISSION_CHANGE_GROUP` | GRANT/DENY/REVOKE at DB level |
| `DATABASE_PRINCIPAL_CHANGE_GROUP` | CREATE/ALTER/DROP USER/ROLE |
| `DATABASE_ROLE_MEMBER_CHANGE_GROUP` | Role membership within this database |
| `USER_CHANGE_PASSWORD_GROUP` | Password changes for contained users |
| `SCHEMA_OBJECT_CHANGE_GROUP` | DDL on schema objects within this database |
| `SCHEMA_OBJECT_PERMISSION_CHANGE_GROUP` | Permissions on schema objects |
| `DATABASE_OBJECT_ACCESS_GROUP` | Any access to database objects (very high volume) |
| `APPLICATION_ROLE_CHANGE_PASSWORD_GROUP` | Application role password changes |

### DML Action Types (for object-level auditing)

Use these as `action_id` in object-level specifications:

| Action | Description |
|---|---|
| `SELECT` | Read access |
| `INSERT` | Row insertions |
| `UPDATE` | Row modifications |
| `DELETE` | Row deletions |
| `EXECUTE` | Stored procedure / function execution |
| `RECEIVE` | Service Broker RECEIVE |
| `REFERENCES` | FK or computed column reference |

---

## Object-Level Auditing

Object-level audit actions capture specific operations on specific objects by specific principals. The `BY PUBLIC` clause audits all principals.

```sql
-- Audit all access to a table by any user
ADD (SELECT ON OBJECT::dbo.CreditCardNumbers BY PUBLIC)

-- Audit access only by a specific user
ADD (UPDATE ON OBJECT::dbo.SalaryData BY [DOMAIN\john.smith])

-- Audit execute on a stored procedure
ADD (EXECUTE ON OBJECT::dbo.usp_ProcessPayment BY PUBLIC)

-- Audit access to an entire schema (captures all objects in schema)
ADD (SELECT ON SCHEMA::Finance BY PUBLIC)
```

> [!NOTE]
> Schema-level auditing captures all current and future objects in the schema — useful for broad coverage without enumerating every table.

---

## Audit Destinations

### File Destination

`.sqlaudit` files are binary XEL-format (same as Extended Events event files). Each file contains a hash chain for tamper detection.

```sql
CREATE SERVER AUDIT FileAudit
TO FILE
(
    FILEPATH = N'D:\Audit\',
    MAXSIZE = 200 MB,
    MAX_ROLLOVER_FILES = 100,
    RESERVE_DISK_SPACE = OFF
)
WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE);
```

**Guidance:**
- Place audit files on a **separate drive** from data and log files — a full data drive should not prevent audit writes
- Use `MAX_ROLLOVER_FILES = UNLIMITED` for compliance if you need to retain all records (manage archival externally)
- Backup and archive `.sqlaudit` files to long-term storage; SQL Server does not age them out automatically beyond `MAX_ROLLOVER_FILES`

### Windows Application Log Destination

```sql
CREATE SERVER AUDIT AppLogAudit
TO APPLICATION_LOG
WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE);
```

The SQL Server service account needs **local security policy** "Generate security audits" right (or be in the local Administrators group). Events appear in Windows Event Viewer → Windows Logs → Application.

### Windows Security Log Destination

```sql
CREATE SERVER AUDIT SecLogAudit
TO SECURITY_LOG
WITH (QUEUE_DELAY = 0, ON_FAILURE = SHUTDOWN);
```

Requires "Generate security audits" local security policy right assigned to the SQL Server service account. This is a stronger control — the Security log is harder to tamper with than the Application log.

---

## Reading Audit Logs

### File-Based Audit Logs

```sql
-- Read all records from current file set
SELECT
    event_time,
    action_id,
    succeeded,
    server_principal_name,
    database_name,
    schema_name,
    object_name,
    statement,
    additional_information,
    session_id,
    client_ip,
    application_name,
    server_instance_name,
    file_name,
    audit_file_offset
FROM sys.fn_get_audit_file
(
    N'D:\Audit\ComplianceAudit_*.sqlaudit',  -- wildcard to include all rolled files
    DEFAULT,
    DEFAULT
)
ORDER BY event_time;
```

```sql
-- Read audit records for failed logins in the last 24 hours
SELECT
    event_time,
    action_id,
    server_principal_name,
    client_ip,
    application_name,
    additional_information
FROM sys.fn_get_audit_file(N'D:\Audit\*.sqlaudit', DEFAULT, DEFAULT)
WHERE action_id = 'LGIF'   -- LGIF = Login Failed
  AND event_time >= DATEADD(HOUR, -24, GETUTCDATE())
ORDER BY event_time DESC;
```

```sql
-- Read from a specific offset (incremental polling pattern)
DECLARE @file_name NVARCHAR(260) = N'D:\Audit\ComplianceAudit_0_132000000000000000.sqlaudit';
DECLARE @offset BIGINT = 0;

SELECT *
FROM sys.fn_get_audit_file(@file_name, DEFAULT, @offset)
ORDER BY audit_file_offset;
```

### Key Columns in Audit Output

| Column | Description |
|---|---|
| `event_time` | UTC timestamp of the event |
| `action_id` | 2-4 character code (see action groups; use `sys.dm_audit_actions` to decode) |
| `succeeded` | 1 = operation succeeded, 0 = operation failed/denied |
| `server_principal_name` | Login name at server scope |
| `database_principal_name` | User name at database scope |
| `object_name` | Audited object (table, procedure, etc.) |
| `statement` | T-SQL statement text (may be truncated; use `additional_information` for full text) |
| `additional_information` | XML with extra detail for complex events |
| `client_ip` | Client IP address (NULL if using shared memory or named pipes) |
| `application_name` | Application name from connection string |
| `session_id` | SPID |
| `server_instance_name` | Instance name (useful in multi-server environments) |
| `file_name` | Source `.sqlaudit` file path |
| `audit_file_offset` | Byte offset in file (use for incremental reads) |

### Decoding `action_id` Values

```sql
-- Map action_id codes to human-readable names
SELECT action_id, name, class_desc
FROM sys.dm_audit_actions
WHERE name LIKE '%LOGIN%'
ORDER BY name;

-- Common action_id codes:
-- CNAU = Create Server Audit
-- LGIF = Login Failed
-- LGIS = Login Succeeded
-- LGO  = Logout
-- SL   = SELECT
-- IN   = INSERT
-- UP   = UPDATE
-- DL   = DELETE
-- EX   = EXECUTE
-- AL   = ALTER
-- CR   = CREATE
-- DR   = DROP
-- GRNT = GRANT
-- DENY = DENY
-- RVKE = REVOKE
```

---

## Managing Audits

### Enable and Disable

```sql
-- Enable
ALTER SERVER AUDIT ComplianceAudit WITH (STATE = ON);
ALTER SERVER AUDIT SPECIFICATION ServerLoginAuditSpec WITH (STATE = ON);

-- Disable (must disable spec before changing audit)
ALTER SERVER AUDIT SPECIFICATION ServerLoginAuditSpec WITH (STATE = OFF);
ALTER DATABASE AUDIT SPECIFICATION SensitiveDataAuditSpec WITH (STATE = OFF);
ALTER SERVER AUDIT ComplianceAudit WITH (STATE = OFF);
```

> [!WARNING]
> You cannot modify an audit specification while it is enabled. Always set STATE = OFF first.

### Modify an Audit Specification

```sql
ALTER SERVER AUDIT SPECIFICATION ServerLoginAuditSpec
WITH (STATE = OFF);
GO

ALTER SERVER AUDIT SPECIFICATION ServerLoginAuditSpec
ADD (EXECUTE_AS_GROUP),
DROP (LOGOUT_GROUP);
GO

ALTER SERVER AUDIT SPECIFICATION ServerLoginAuditSpec
WITH (STATE = ON);
GO
```

### Drop an Audit

```sql
-- Must disable and drop specs before dropping the audit object
ALTER DATABASE AUDIT SPECIFICATION SensitiveDataAuditSpec WITH (STATE = OFF);
DROP DATABASE AUDIT SPECIFICATION SensitiveDataAuditSpec;

ALTER SERVER AUDIT SPECIFICATION ServerLoginAuditSpec WITH (STATE = OFF);
DROP SERVER AUDIT SPECIFICATION ServerLoginAuditSpec;

ALTER SERVER AUDIT ComplianceAudit WITH (STATE = OFF);
DROP SERVER AUDIT ComplianceAudit;
```

---

## Compliance Mapping

### SOX (Sarbanes-Oxley)

SOX requires access controls and audit trails for financial reporting systems. Key SQL Server Audit action groups for SOX:

| Requirement | Action Group / Action |
|---|---|
| User access to financial data | `SELECT`, `UPDATE`, `DELETE` on financial tables |
| Failed login attempts | `FAILED_LOGIN_GROUP` |
| Privilege escalation | `SERVER_ROLE_MEMBER_CHANGE_GROUP`, `DATABASE_ROLE_MEMBER_CHANGE_GROUP` |
| Schema/DDL changes | `DATABASE_OBJECT_CHANGE_GROUP`, `SCHEMA_OBJECT_CHANGE_GROUP` |
| Backup and restore operations | `BACKUP_RESTORE_GROUP` |
| DBCC usage | `DBCC_GROUP` |
| Security permission changes | `SERVER_PERMISSION_CHANGE_GROUP`, `DATABASE_PERMISSION_CHANGE_GROUP` |

```sql
CREATE DATABASE AUDIT SPECIFICATION SOX_FinancialDB
FOR SERVER AUDIT ComplianceAudit
ADD (SELECT   ON SCHEMA::Finance BY PUBLIC),
ADD (INSERT   ON SCHEMA::Finance BY PUBLIC),
ADD (UPDATE   ON SCHEMA::Finance BY PUBLIC),
ADD (DELETE   ON SCHEMA::Finance BY PUBLIC),
ADD (DATABASE_OBJECT_CHANGE_GROUP),
ADD (DATABASE_PERMISSION_CHANGE_GROUP),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP)
WITH (STATE = ON);
```

### HIPAA (Health Insurance Portability and Accountability Act)

HIPAA requires audit controls for PHI (Protected Health Information) access. Key requirements:

| Requirement | SQL Audit Approach |
|---|---|
| Login/logout of PHI systems | `SUCCESSFUL_LOGIN_GROUP`, `LOGOUT_GROUP`, `FAILED_LOGIN_GROUP` |
| PHI data access | Object-level SELECT/UPDATE/DELETE on PHI tables |
| Emergency access override | `EXECUTE_AS_GROUP` |
| Security incident response | `FAILED_LOGIN_GROUP`, security log integration |
| Workforce access controls | `DATABASE_ROLE_MEMBER_CHANGE_GROUP` |

```sql
CREATE DATABASE AUDIT SPECIFICATION HIPAA_PHI_Access
FOR SERVER AUDIT ComplianceAudit
ADD (SELECT ON OBJECT::dbo.PatientRecords BY PUBLIC),
ADD (SELECT ON OBJECT::dbo.DiagnosisCodes BY PUBLIC),
ADD (UPDATE ON OBJECT::dbo.PatientRecords BY PUBLIC),
ADD (DELETE ON OBJECT::dbo.PatientRecords BY PUBLIC),
ADD (EXECUTE ON OBJECT::dbo.usp_GetPatientData BY PUBLIC),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP),
ADD (USER_CHANGE_PASSWORD_GROUP)
WITH (STATE = ON);
```

### PCI-DSS (Payment Card Industry Data Security Standard)

PCI-DSS v4.0 Requirement 10 mandates audit trails for cardholder data environment (CDE) access. [^8]

| PCI-DSS Req | Action Groups |
|---|---|
| 10.2.1: User access to cardholder data | `SELECT/INSERT/UPDATE/DELETE` on CDE tables |
| 10.2.2: Privileged user actions | `SERVER_ROLE_MEMBER_CHANGE_GROUP`, `EXECUTE_AS_GROUP` |
| 10.2.3: Invalid access attempts | `FAILED_LOGIN_GROUP` |
| 10.2.4: Use of identification/auth mechanisms | `SUCCESSFUL_LOGIN_GROUP`, `USER_CHANGE_PASSWORD_GROUP` |
| 10.2.5: Changes to audit mechanisms | `AUDIT_CHANGE_GROUP` |
| 10.2.7: Creation/deletion of objects | `DATABASE_OBJECT_CHANGE_GROUP` |
| 10.3: Protect audit trails | File-based audit, WORM storage, separate drive |
| 10.5: Retain audit logs ≥ 12 months | `MAX_ROLLOVER_FILES = UNLIMITED` + archival |

```sql
-- PCI-DSS: Enable AUDIT_CHANGE_GROUP to detect tampering with audit config
CREATE SERVER AUDIT SPECIFICATION PCI_ServerSpec
FOR SERVER AUDIT ComplianceAudit
ADD (FAILED_LOGIN_GROUP),
ADD (SUCCESSFUL_LOGIN_GROUP),
ADD (SERVER_ROLE_MEMBER_CHANGE_GROUP),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP),
ADD (BACKUP_RESTORE_GROUP),
ADD (AUDIT_CHANGE_GROUP),            -- critical: captures anyone disabling audit
ADD (SERVER_PERMISSION_CHANGE_GROUP)
WITH (STATE = ON);
```

> [!NOTE]
> Always include `AUDIT_CHANGE_GROUP` in your server audit specification. This captures any attempt to disable or modify the audit itself — a fundamental anti-tamper requirement for PCI-DSS and SOX.

---

## Audit vs Extended Events

| Aspect | SQL Server Audit | Extended Events |
|---|---|---|
| **Primary use case** | Compliance, accountability, non-repudiation | Performance diagnostics, debugging, tracing |
| **Tamper evidence** | Yes — file-based audit has hash chain | No — XEL files have no hash chain |
| **Compliance status** | Accepted by auditors (SOX, HIPAA, PCI-DSS) | Not accepted as audit evidence in most frameworks |
| **Querying** | `sys.fn_get_audit_file()` — relational | XQuery on XML; `sys.fn_xe_file_target_read_file()` |
| **Granularity** | Action group level or per-object | Event level (very granular, per field filtering) |
| **Filtering** | Server-side WHERE predicate | Rich predicate on any field |
| **Overhead** | Low (async queue by default) | Very low with good predicates |
| **Azure SQL** | Supported (to Blob/Log Analytics) | Supported (to ring buffer/event file) |
| **Setup complexity** | Moderate | Higher (more configuration options) |
| **Blocked by ON_FAILURE** | Optionally yes (FAIL_OPERATION) | No — XE loss is silent |

**Decision rule:** If your auditor will ask to see the logs, use SQL Server Audit. If you're diagnosing a query performance issue, use Extended Events.

For **compliance + performance**, run both: SQL Audit for accountability records, XE for performance data.

---

## Filtering Audit Records

SQL Server Audit supports server-side predicate filtering to reduce noise before events reach the queue:

```sql
CREATE SERVER AUDIT FilteredLoginAudit
TO FILE (FILEPATH = N'C:\Audit\')
WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE)
WHERE ([action_id] = 'LGIF'        -- Failed logins only
    OR [succeeded] = 0);           -- Any failed operation
```

### Filterable Fields

| Field | Type | Description |
|---|---|---|
| `action_id` | `char(4)` | Action code (use `sys.dm_audit_actions`) |
| `additional_information` | `nvarchar(max)` | XML additional info |
| `application_name` | `nvarchar(128)` | Client application name |
| `database_name` | `nvarchar(128)` | Database name |
| `object_name` | `nvarchar(128)` | Object being audited |
| `server_principal_name` | `nvarchar(128)` | Login name |
| `session_id` | `smallint` | Session SPID |
| `succeeded` | `bit` | Operation success |
| `statement` | `nvarchar(4000)` | T-SQL statement |

```sql
-- Filter: only capture events on a specific database
WHERE ([database_name] = N'ProductionDB');

-- Filter: exclude monitoring users from audit noise
WHERE ([server_principal_name] NOT IN (N'monitoring_login', N'sa'));

-- Filter: capture all failures
WHERE ([succeeded] = 0);
```

> [!WARNING] Filtering and Compliance
> If you filter out events to reduce noise, document the filter and its justification. Auditors may ask why certain events are absent from the log. Exclusions for service accounts and monitoring logins are generally acceptable; exclusions for specific users or tables are not.

---

## Azure SQL Auditing

Azure SQL Database and Azure SQL Managed Instance have their own auditing model built on top of SQL Server Audit concepts.

### Azure SQL Database

```sql
-- Enabled at the server level (applies to all databases) via Azure Portal or:
-- ALTER DATABASE ... SET AUDIT_ENABLED = ON / OFF is not the right approach;
-- Azure SQL auditing is configured through ARM/PowerShell/CLI, not T-SQL.

-- Reading audit logs from Azure Blob Storage:
SELECT *
FROM sys.fn_get_audit_file
(
    'https://yourstorageaccount.blob.core.windows.net/sqldbauditlogs/yourserver/yourdb/SqlDbAuditing_ServerAudit/*.xel',
    DEFAULT,
    DEFAULT
)
ORDER BY event_time DESC;
```

### Key Azure SQL Differences

| Feature | On-Premises | Azure SQL Database | Azure SQL Managed Instance |
|---|---|---|---|
| Audit destination | File, Win Event Log, Security Log | Azure Blob Storage, Log Analytics, Event Hub | File, Azure Blob, Log Analytics |
| Configuration | T-SQL `CREATE SERVER AUDIT` | Portal/ARM/PowerShell | Both T-SQL and Portal |
| Server-level audit | Yes | Yes (server policy via Portal) | Yes (T-SQL) |
| Database-level audit | Yes | Yes (overrides server) | Yes |
| `sys.fn_get_audit_file` | File path | Blob SAS URL | File path or Blob URL |
| Default audit state | Off | Recommended ON via Defender for SQL | Configurable |

> [!NOTE] Azure SQL Database
> In Azure SQL Database, auditing is controlled through the Portal/REST API/PowerShell. The T-SQL `CREATE SERVER AUDIT` approach works for Azure SQL Managed Instance but not Azure SQL Database. Use `sys.fn_get_audit_file` with the blob storage URL to read records.

---

## Metadata Queries

```sql
-- List all server audits and their state
SELECT
    a.name                  AS audit_name,
    a.type_desc             AS destination,
    a.log_file_path,
    a.log_file_name,
    a.queue_delay,
    a.on_failure_desc,
    a.is_state_enabled,
    a.audit_guid
FROM sys.server_audits a
ORDER BY a.name;

-- List server audit specifications and which audit they use
SELECT
    s.name              AS spec_name,
    a.name              AS audit_name,
    s.is_state_enabled
FROM sys.server_audit_specifications s
JOIN sys.server_audits a ON s.audit_guid = a.audit_guid;

-- List server audit specification details (which action groups are included)
SELECT
    s.name          AS spec_name,
    d.audit_action_name,
    d.class_desc,
    d.is_group
FROM sys.server_audit_specifications s
JOIN sys.server_audit_specification_details d ON s.server_specification_id = d.server_specification_id
ORDER BY s.name, d.audit_action_name;

-- List database audit specifications in current database
SELECT
    s.name                  AS spec_name,
    a.name                  AS audit_name,
    s.is_state_enabled
FROM sys.database_audit_specifications s
JOIN sys.server_audits a ON s.audit_guid = a.audit_guid;

-- List database audit spec details (object-level + action groups)
SELECT
    s.name              AS spec_name,
    d.audit_action_name,
    d.class_desc,
    OBJECT_NAME(d.major_id) AS object_name,
    USER_NAME(d.audited_principal_id) AS principal_name,
    d.is_group,
    d.containing_object_class_desc
FROM sys.database_audit_specifications s
JOIN sys.database_audit_specification_details d ON s.database_specification_id = d.database_specification_id
ORDER BY s.name, d.audit_action_name;

-- Show all available audit action groups
SELECT name, action_id, class_desc, is_group
FROM sys.dm_audit_actions
WHERE is_group = 1
ORDER BY name;

-- Show all available audit action types (non-group)
SELECT name, action_id, class_desc
FROM sys.dm_audit_actions
WHERE is_group = 0
ORDER BY name;

-- Check audit file size and recent activity
SELECT
    audit_file_path,
    audit_file_size,
    create_time,
    event_count
FROM sys.dm_audit_file_metadata
WHERE audit_file_path LIKE N'D:\Audit\%'
ORDER BY create_time DESC;
```

---

## Common Patterns

### Pattern 1: Minimal Compliance Audit (SOX baseline)

```sql
-- Step 1: Create the audit
CREATE SERVER AUDIT SOX_Audit
TO FILE (FILEPATH = N'E:\SQLAudit\SOX\', MAXSIZE = 500 MB, MAX_ROLLOVER_FILES = 100)
WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE);
ALTER SERVER AUDIT SOX_Audit WITH (STATE = ON);

-- Step 2: Server-level events
CREATE SERVER AUDIT SPECIFICATION SOX_ServerSpec
FOR SERVER AUDIT SOX_Audit
ADD (FAILED_LOGIN_GROUP),
ADD (SUCCESSFUL_LOGIN_GROUP),
ADD (SERVER_ROLE_MEMBER_CHANGE_GROUP),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP),
ADD (SERVER_PERMISSION_CHANGE_GROUP),
ADD (AUDIT_CHANGE_GROUP),
ADD (BACKUP_RESTORE_GROUP)
WITH (STATE = ON);

-- Step 3: Per-database for each financial DB
USE FinancialDB;
GO
CREATE DATABASE AUDIT SPECIFICATION SOX_FinancialDB
FOR SERVER AUDIT SOX_Audit
ADD (SELECT   ON SCHEMA::Accounting BY PUBLIC),
ADD (INSERT   ON SCHEMA::Accounting BY PUBLIC),
ADD (UPDATE   ON SCHEMA::Accounting BY PUBLIC),
ADD (DELETE   ON SCHEMA::Accounting BY PUBLIC),
ADD (DATABASE_OBJECT_CHANGE_GROUP),
ADD (DATABASE_ROLE_MEMBER_CHANGE_GROUP)
WITH (STATE = ON);
```

### Pattern 2: Suspicious Activity Report

```sql
-- Failed logins in the last hour, grouped by IP
SELECT
    client_ip,
    server_principal_name,
    COUNT(*) AS failed_attempts,
    MIN(event_time) AS first_attempt,
    MAX(event_time) AS last_attempt
FROM sys.fn_get_audit_file(N'E:\SQLAudit\SOX\*.sqlaudit', DEFAULT, DEFAULT)
WHERE action_id = 'LGIF'
  AND event_time >= DATEADD(HOUR, -1, GETUTCDATE())
GROUP BY client_ip, server_principal_name
HAVING COUNT(*) >= 5              -- threshold for brute-force detection
ORDER BY failed_attempts DESC;
```

### Pattern 3: Data Access Report for a Specific User

```sql
-- All actions by a specific user in the last 7 days
SELECT
    event_time,
    action_id,
    database_name,
    schema_name,
    object_name,
    succeeded,
    statement,
    client_ip,
    application_name
FROM sys.fn_get_audit_file(N'E:\SQLAudit\SOX\*.sqlaudit', DEFAULT, DEFAULT)
WHERE server_principal_name = N'DOMAIN\suspect_user'
  AND event_time >= DATEADD(DAY, -7, GETUTCDATE())
ORDER BY event_time DESC;
```

### Pattern 4: Incremental Audit Log Processing

```sql
-- Table to track last processed position
CREATE TABLE dbo.AuditCheckpoint
(
    audit_name      NVARCHAR(128) NOT NULL,
    last_file       NVARCHAR(260) NULL,
    last_offset     BIGINT        NOT NULL DEFAULT 0,
    processed_at    DATETIME2     NOT NULL DEFAULT SYSDATETIME()
);

-- Incremental read from last checkpoint
DECLARE @last_file   NVARCHAR(260);
DECLARE @last_offset BIGINT;

SELECT @last_file = last_file, @last_offset = last_offset
FROM dbo.AuditCheckpoint
WHERE audit_name = N'SOX_Audit';

-- Read new records only
SELECT *
FROM sys.fn_get_audit_file(
    COALESCE(@last_file, N'E:\SQLAudit\SOX\*.sqlaudit'),
    DEFAULT,
    COALESCE(@last_offset, 0)
)
ORDER BY event_time;

-- After processing, update checkpoint to last record
-- UPDATE dbo.AuditCheckpoint SET last_file = @new_file, last_offset = @new_offset ...
```

### Pattern 5: Alert on Audit Specification Disabled

```sql
-- Use SQL Agent alert or XE session to watch for AUDIT_CHANGE events
-- Or query the audit log for recent AUDIT_CHANGE_GROUP events:
SELECT event_time, server_principal_name, statement, additional_information
FROM sys.fn_get_audit_file(N'E:\SQLAudit\SOX\*.sqlaudit', DEFAULT, DEFAULT)
WHERE action_id IN ('CNAU', 'ALAU', 'DRAU', 'CNSP', 'ALSP', 'DRSP')  -- audit create/alter/drop events
ORDER BY event_time DESC;
```

---

## Gotchas

1. **Audit directory must exist before CREATE SERVER AUDIT.** SQL Server does not create the directory. If the path is missing, `CREATE SERVER AUDIT` fails immediately.

2. **Disable specification before modifying it.** `ALTER SERVER AUDIT SPECIFICATION` while `STATE = ON` throws error 33233. Always `STATE = OFF` first, modify, then `STATE = ON`.

3. **One specification per server audit per scope.** One database can have at most one `DATABASE AUDIT SPECIFICATION` per `SERVER AUDIT`. If you need to write different database events to different destinations, create a second `SERVER AUDIT` with a different destination.

4. **ON_FAILURE = SHUTDOWN can cause outages.** If audit files fill the disk, SQL Server shuts down. Monitor audit disk space aggressively when using `SHUTDOWN`. In most cases, `FAIL_OPERATION` provides better availability while maintaining compliance guarantees.

5. **AUDIT_CHANGE_GROUP is not retroactive.** If someone disables the audit and re-enables it, the events during the disabled window are gone. That gap in the audit log is itself evidence — but only if you're looking for it. Configure monitoring around audit state.

6. **sys.fn_get_audit_file is synchronous and can be slow.** Reading large audit files is a table scan of binary data. Index your audit archive tables or process incrementally. For real-time monitoring, ship audit files to a SIEM (Splunk, Sentinel, Elastic) rather than querying with `fn_get_audit_file`.

7. **event_time is UTC.** All audit event timestamps are in UTC. Convert to local time with `AT TIME ZONE` when presenting to business users.

8. **`statement` column is truncated at 4000 characters.** Long T-SQL statements are truncated. For stored procedure calls, `object_name` gives you the proc name; check `additional_information` XML for parameter details.

9. **SQL Server restart re-enables audits that were enabled at shutdown.** If you disable an audit manually (for maintenance), it stays disabled through restart. If it was enabled at restart, it comes back up automatically — controlled by the audit's persistent state in the master database.

10. **Audit file hash chain detects file tampering but not deletion.** Deleting a `.sqlaudit` file leaves a gap in the sequence number chain — detectable by monitoring for missing sequence numbers. File hash chaining only catches byte-level modification of existing files.

11. **`DATABASE_OBJECT_ACCESS_GROUP` is extremely high volume.** This group fires on every access to any database object. Do not add it unless you have a specific compliance requirement and have sized your audit storage for 10-100× normal record volume. Prefer object-level auditing on specific sensitive tables.

12. **Always On: audits are local to the instance.** Audit specifications are stored in the primary's master database and replicated via AG to secondaries. However, actual audit records written on the primary are NOT replicated to secondary instances. Each instance (primary/secondary) writes its own audit records. For readable secondary workloads, ensure a database audit specification exists on the secondary after failover.

---

## See Also

- [`references/33-extended-events.md`](33-extended-events.md) — XE sessions for performance diagnostics (complement to SQL Audit)
- [`references/15-principals-permissions.md`](15-principals-permissions.md) — server principals, roles, GRANT/DENY/REVOKE
- [`references/16-security-encryption.md`](16-security-encryption.md) — RLS, TDE, Always Encrypted
- [`references/43-high-availability.md`](43-high-availability.md) — Always On AG and audit considerations
- [`references/13-transactions-locking.md`](13-transactions-locking.md) — session context and EXECUTE AS

---

## Sources

[^1]: [SQL Server Audit (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/auditing/sql-server-audit-database-engine) — overview of the SQL Server Audit feature, architecture, components, permissions, and catalog views
[^2]: [CREATE SERVER AUDIT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-server-audit-transact-sql) — full syntax reference for CREATE SERVER AUDIT including destination options, QUEUE_DELAY, ON_FAILURE, and predicate filtering
[^3]: [CREATE SERVER AUDIT SPECIFICATION (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-server-audit-specification-transact-sql) — syntax and usage for creating server audit specifications bound to a server audit
[^4]: [CREATE DATABASE AUDIT SPECIFICATION (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-audit-specification-transact-sql) — syntax and examples for creating database audit specifications with object-level and action group auditing
[^5]: [sys.fn_get_audit_file (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-get-audit-file-transact-sql) — reference for reading audit records from .sqlaudit files and Azure Blob Storage, including all output columns
[^6]: [SQL Server Audit Action Groups and Actions](https://learn.microsoft.com/en-us/sql/relational-databases/security/auditing/sql-server-audit-action-groups-and-actions) — complete reference for all server-level and database-level audit action groups and individual audit actions
[^7]: [Auditing for Azure SQL Database and Azure Synapse Analytics](https://learn.microsoft.com/en-us/azure/azure-sql/database/auditing-overview) — Azure SQL Database auditing configuration, destinations (Blob Storage, Log Analytics, Event Hubs), and limitations
[^8]: [PCI DSS Document Library](https://www.pcisecuritystandards.org/document_library/) — PCI Security Standards Council official document library; PCI DSS v4.0 Requirement 10 covers audit log requirements for cardholder data environments including log content (10.2), protection (10.3), review (10.4), retention (10.5), and time synchronization (10.6)

# 15 — Principals & Permissions

## Table of Contents

1. [When to use this reference](#1-when-to-use-this-reference)
2. [Principal hierarchy overview](#2-principal-hierarchy-overview)
3. [sys.server_principals vs sys.database_principals](#3-sysserver_principals-vs-sysdatabase_principals)
4. [Logins (server-level principals)](#4-logins-server-level-principals)
5. [Users (database-level principals)](#5-users-database-level-principals)
6. [Fixed server roles](#6-fixed-server-roles)
7. [Fixed database roles](#7-fixed-database-roles)
8. [Custom roles](#8-custom-roles)
9. [Application roles](#9-application-roles)
10. [GRANT / DENY / REVOKE decision matrix](#10-grant--deny--revoke-decision-matrix)
11. [Permission inheritance chain](#11-permission-inheritance-chain)
12. [Ownership chaining](#12-ownership-chaining)
13. [Cross-database permissions](#13-cross-database-permissions)
14. [EXECUTE AS](#14-execute-as)
15. [Schema-level security](#15-schema-level-security)
16. [Metadata queries](#16-metadata-queries)
17. [Auditing permission changes](#17-auditing-permission-changes)
18. [Gotchas / Anti-patterns](#18-gotchas--anti-patterns)
19. [See also](#19-see-also)
20. [Sources](#sources)

---

## 1. When to use this reference

Load this file when the user asks about:

- Creating logins and users, mapping logins to database users
- `sys.server_principals`, `sys.database_principals`, `sys.database_permissions`
- `GRANT`, `DENY`, `REVOKE` and the difference between them
- Fixed server roles (`sysadmin`, `securityadmin`, …) or fixed database roles (`db_owner`, `db_datareader`, …)
- Custom database roles or application roles
- Ownership chaining and cross-database permission chains
- `EXECUTE AS` context switching
- Schema-level vs object-level vs server-level permissions

---

## 2. Principal hierarchy overview

```
SQL Server Instance
├── Server Principals  (stored in master, surfaced in sys.server_principals)
│   ├── Logins (SQL Login, Windows Login, Windows Group, Certificate, Asymmetric Key)
│   └── Server Roles (fixed + user-defined since 2012)
└── Database
    ├── Database Principals  (per-database, surfaced in sys.database_principals)
    │   ├── Users (mapped to login, contained, certificate, no-login, Windows)
    │   ├── Database Roles (fixed + custom)
    │   └── Application Roles
    └── Securables
        ├── Server-scope  (logins, endpoints, server objects)
        ├── Database-scope (schemas, certificates, assemblies, full-text catalogs)
        └── Schema-scope  (tables, views, procs, functions, types, …)
```

**Key rule:** A login lives at the server level; a user lives inside a database. A login is linked to at most one user per database via `SID` matching. Contained database users (2012+) break this coupling — they authenticate directly at the database and have no server-level login.

---

## 3. sys.server_principals vs sys.database_principals

### sys.server_principals (master-scoped; visible server-wide)

| Column | Type | Notes |
|---|---|---|
| `principal_id` | int | Auto-assigned server-scope ID |
| `name` | sysname | Login name (e.g., `DOMAIN\user`, `mylogin`) |
| `sid` | varbinary(85) | Security identifier — links to `sys.database_principals.sid` |
| `type` | char(1) | `S`=SQL login, `U`=Win login, `G`=Win group, `R`=server role, `C`=cert, `K`=asym key |
| `type_desc` | nvarchar(60) | Human-readable type |
| `is_disabled` | bit | 1 = login disabled |
| `default_database_name` | sysname | Default database at connect time |
| `default_language_name` | sysname | |
| `credential_id` | int | NULL unless credential mapped |
| `owning_principal_id` | int | For server roles: owner |
| `is_fixed_role` | bit | 1 for built-in server roles |
| `create_date` | datetime | |
| `modify_date` | datetime | |

```sql
-- All enabled SQL logins
SELECT name, type_desc, default_database_name, create_date
FROM sys.server_principals
WHERE type IN ('S','U','G')
  AND is_disabled = 0
ORDER BY name;

-- Members of a fixed server role
SELECT sp.name AS member, spr.name AS role
FROM sys.server_role_members srm
JOIN sys.server_principals sp  ON sp.principal_id  = srm.member_principal_id
JOIN sys.server_principals spr ON spr.principal_id = srm.role_principal_id
ORDER BY spr.name, sp.name;
```

### sys.database_principals (per-database)

| Column | Type | Notes |
|---|---|---|
| `principal_id` | int | Database-scope ID (1 = `dbo`) |
| `name` | sysname | User/role name |
| `sid` | varbinary(85) | Matches `sys.server_principals.sid` for mapped users; NULL for roles |
| `type` | char(1) | `S`=SQL user, `U`=Win user, `G`=Win group, `R`=database role, `A`=app role, `C`=cert, `K`=asym key, `E`=external user (AAD), `X`=external group |
| `type_desc` | nvarchar(60) | |
| `default_schema_name` | sysname | Schema used when no schema qualifier is provided |
| `owning_principal_id` | int | For schemas owned by this principal |
| `is_fixed_role` | bit | 1 for built-in database roles |
| `authentication_type` | int | 0=none, 1=instance, 2=database (contained), 3=Windows, 4=AAD |
| `default_language_name` | sysname | |
| `create_date` | datetime | |
| `modify_date` | datetime | |

```sql
-- All non-system users in current database with their mapped login
SELECT
    dp.name         AS db_user,
    dp.type_desc,
    dp.default_schema_name,
    sp.name         AS login_name,
    sp.type_desc    AS login_type,
    sp.is_disabled  AS login_disabled
FROM sys.database_principals dp
LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
WHERE dp.type NOT IN ('R','A')  -- exclude roles and app roles
  AND dp.principal_id > 4        -- exclude system principals
ORDER BY dp.name;
```

### SID linkage — the key relationship

```sql
-- Find orphaned users (no matching login)
SELECT name AS orphaned_user
FROM sys.database_principals
WHERE type IN ('S','U','G')
  AND authentication_type = 1  -- instance-authenticated
  AND sid NOT IN (
      SELECT sid FROM sys.server_principals
  )
  AND principal_id > 4;

-- Fix: remap an orphaned user to its login
ALTER USER [myuser] WITH LOGIN = [mylogin];
-- Or drop and recreate:
DROP USER [myuser];
CREATE USER [myuser] FOR LOGIN [mylogin];
```

---

## 4. Logins (server-level principals)

### SQL Login

```sql
-- Create SQL login
CREATE LOGIN myapp_login
    WITH PASSWORD = 'Str0ng!Pass#',
         DEFAULT_DATABASE = MyDB,
         CHECK_POLICY = ON,      -- enforces Windows password policy
         CHECK_EXPIRATION = ON;  -- enforces password expiration

-- Disable / enable
ALTER LOGIN myapp_login DISABLE;
ALTER LOGIN myapp_login ENABLE;

-- Change password
ALTER LOGIN myapp_login WITH PASSWORD = 'New!Pass#'
    OLD_PASSWORD = 'Str0ng!Pass#';  -- non-sysadmin must supply old password

-- Unlock after failed attempts
ALTER LOGIN myapp_login WITH PASSWORD = 'Str0ng!Pass#' UNLOCK;

-- Drop
DROP LOGIN myapp_login;
```

> [!WARNING] Deprecated
> `sp_addlogin` / `sp_droplogin` — deprecated since SQL Server 2005. Use `CREATE LOGIN` / `DROP LOGIN`.

### Windows Login / Group

```sql
CREATE LOGIN [DOMAIN\myuser]    FROM WINDOWS WITH DEFAULT_DATABASE = MyDB;
CREATE LOGIN [DOMAIN\MyAppGrp] FROM WINDOWS;

-- Windows logins authenticate via Kerberos/NTLM; CHECK_POLICY does not apply
```

### Certificate / Asymmetric Key Login (for module signing)

```sql
-- Used for ownership chaining across databases or for signed modules
CREATE CERTIFICATE cert_for_proc
    ENCRYPTION BY PASSWORD = 'CertPass!'
    WITH SUBJECT = 'Module signing cert',
         EXPIRY_DATE = '2030-01-01';

CREATE LOGIN cert_login FROM CERTIFICATE cert_for_proc;
```

---

## 5. Users (database-level principals)

```sql
-- Standard: mapped to a login
USE MyDB;
CREATE USER myapp_user FOR LOGIN myapp_login
    WITH DEFAULT_SCHEMA = app;

-- No-login user (for module signing, cannot connect)
CREATE USER signing_user WITHOUT LOGIN;

-- Contained database user (authenticates at DB level, no server login needed)
CREATE USER contained_user
    WITH PASSWORD = 'Str0ng!Pass#',
         DEFAULT_SCHEMA = dbo;

-- Windows user directly in database
CREATE USER [DOMAIN\myuser] FOR LOGIN [DOMAIN\myuser];

-- Guest account (disabled by default in new DBs — keep it disabled)
-- REVOKE CONNECT FROM guest;  -- removes CONNECT permission, effectively disabling
```

> [!NOTE] SQL Server 2012
> Contained database users were introduced. They authenticate directly against the database. The database must have `CONTAINMENT = PARTIAL` set.

```sql
-- Enable partial containment
ALTER DATABASE MyDB SET CONTAINMENT = PARTIAL;
```

**Contained users trade-off:**

| | Mapped user | Contained user |
|---|---|---|
| Login required | Yes | No |
| Portable across instances | No (must recreate login) | Yes (backup/restore preserves) |
| Cross-database access | Via login | Cannot access other databases |
| Password in master | Yes | No |
| Azure SQL compatible | Partial | Yes (recommended) |

---

## 6. Fixed server roles

| Role | Effective permission |
|---|---|
| `sysadmin` | Full control of the instance; bypasses all permission checks |
| `serveradmin` | Configure server-wide settings; SHUTDOWN |
| `securityadmin` | Manage logins, passwords, GRANT/REVOKE server permissions |
| `processadmin` | KILL any process |
| `setupadmin` | Manage linked servers and startup procs |
| `bulkadmin` | Execute `BULK INSERT` |
| `diskadmin` | Manage disk files (rarely used) |
| `dbcreator` | Create, alter, drop, restore any database |
| `public` | Baseline permissions every login has; cannot be dropped |

> [!WARNING]
> Never add application service accounts to `sysadmin`. A compromised app account with `sysadmin` gives full instance control. Use `db_owner` at most, and prefer custom roles.

```sql
-- Add login to server role
ALTER SERVER ROLE sysadmin ADD MEMBER mylogin;

-- Remove
ALTER SERVER ROLE sysadmin DROP MEMBER mylogin;

-- User-defined server roles (2012+)
CREATE SERVER ROLE readonly_servers;
GRANT VIEW ANY DATABASE TO readonly_servers;
ALTER SERVER ROLE readonly_servers ADD MEMBER mylogin;
```

> [!NOTE] SQL Server 2012
> User-defined server roles were introduced, allowing least-privilege server-scope roles.

---

## 7. Fixed database roles

| Role | Effective permission |
|---|---|
| `db_owner` | Full database control; can drop the database |
| `db_securityadmin` | Manage role membership and permissions (cannot affect db_owner) |
| `db_accessadmin` | Add/remove users |
| `db_backupoperator` | BACKUP DATABASE / LOG |
| `db_ddladmin` | CREATE, ALTER, DROP any object (no SELECT/DML) |
| `db_datawriter` | INSERT, UPDATE, DELETE on all user tables |
| `db_datareader` | SELECT on all user tables |
| `db_denydatawriter` | Cannot INSERT/UPDATE/DELETE — overrides `db_datawriter` |
| `db_denydatareader` | Cannot SELECT — overrides `db_datareader` |
| `public` | Baseline permissions for every database user |

```sql
-- Add user to role
ALTER ROLE db_datareader ADD MEMBER myapp_user;

-- Remove
ALTER ROLE db_datareader DROP MEMBER myapp_user;

-- View role membership
SELECT dp.name AS member, r.name AS role
FROM sys.database_role_members drm
JOIN sys.database_principals dp ON dp.principal_id = drm.member_principal_id
JOIN sys.database_principals r  ON r.principal_id  = drm.role_principal_id
ORDER BY r.name, dp.name;
```

---

## 8. Custom roles

Prefer custom roles over granting permissions directly to users. Direct grants are hard to audit and don't scale.

```sql
-- Create role
CREATE ROLE app_reader;
CREATE ROLE app_writer;
CREATE ROLE app_exec;

-- Grant permissions to role
GRANT SELECT ON SCHEMA::app TO app_reader;
GRANT INSERT, UPDATE, DELETE ON SCHEMA::app TO app_writer;
GRANT EXECUTE ON SCHEMA::app TO app_exec;

-- Assign users to roles
ALTER ROLE app_reader ADD MEMBER user1;
ALTER ROLE app_writer ADD MEMBER user2;
ALTER ROLE app_exec   ADD MEMBER user1;
ALTER ROLE app_exec   ADD MEMBER user2;

-- Effective permissions query
SELECT
    dp.name         AS principal,
    dp.type_desc,
    o.name          AS object_name,
    o.type_desc     AS object_type,
    p.permission_name,
    p.state_desc
FROM sys.database_permissions p
JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
LEFT JOIN sys.objects o          ON o.object_id     = p.major_id
WHERE dp.name = 'app_reader'
ORDER BY o.name, p.permission_name;
```

---

## 9. Application roles

Application roles are activated by the application at runtime using a password. They replace the user's current permission context with the role's permissions for the duration of the session.

```sql
-- Create
CREATE APPLICATION ROLE myapp_role
    WITH PASSWORD = 'AppRole!Pass#',
         DEFAULT_SCHEMA = dbo;

GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::app TO myapp_role;

-- Activate from application (T-SQL)
EXEC sp_setapprole 'myapp_role', 'AppRole!Pass#';
-- After this call the session has ONLY myapp_role permissions — the original user context is gone

-- Deactivate using cookie (save cookie before activation)
DECLARE @cookie varbinary(8000);
EXEC sp_setapprole 'myapp_role', 'AppRole!Pass#',
    @fCreateCookie = true,
    @cookie = @cookie OUTPUT;

-- … do work …

EXEC sp_unsetapprole @cookie;
-- Session reverts to original user context
```

**When to use application roles:**
- Legacy apps that use a single shared SQL login; the app role limits what that login can do
- You want the DB to enforce permissions regardless of which user is connecting (the app always activates the role)
- Not recommended for new designs — use service accounts with minimal custom roles instead

---

## 10. GRANT / DENY / REVOKE decision matrix

| Operation | Effect | Inheritable? | Overrides |
|---|---|---|---|
| `GRANT perm TO principal` | Explicitly allow | Yes, via role membership | — |
| `DENY perm TO principal` | Explicitly forbid | Yes (DENY propagates down) | Overrides any GRANT including via role |
| `REVOKE perm FROM principal` | Remove prior explicit GRANT or DENY | — | Does not re-enable if DENY exists from another path |

**Precedence rule:** DENY always wins over GRANT, regardless of path. A user who is in a role with `GRANT SELECT` but also has an explicit `DENY SELECT` (or is in another role with DENY) cannot SELECT.

```sql
-- Grant SELECT on a table
GRANT SELECT ON dbo.Orders TO myapp_user;

-- Grant EXECUTE on a procedure
GRANT EXECUTE ON dbo.usp_GetOrders TO app_exec;

-- Grant at schema level (applies to all objects in schema, now and future)
GRANT SELECT ON SCHEMA::reporting TO app_reader;

-- Grant database-scope permission
GRANT VIEW DATABASE STATE TO monitoring_user;

-- Grant server-scope permission
GRANT VIEW SERVER STATE TO monitoring_login;

-- Deny overrides grant — this user cannot SELECT even if in a role with GRANT
DENY SELECT ON dbo.SensitiveTable TO restricted_user;

-- Revoke removes a previous GRANT or DENY
REVOKE SELECT ON dbo.Orders FROM myapp_user;

-- WITH GRANT OPTION: lets the grantee re-grant to others
GRANT SELECT ON dbo.Orders TO power_user WITH GRANT OPTION;

-- Revoke the grant option only (does not revoke SELECT itself)
REVOKE GRANT OPTION FOR SELECT ON dbo.Orders FROM power_user CASCADE;
```

### Common permission names

| Scope | Permission | Notes |
|---|---|---|
| Object | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `EXECUTE`, `REFERENCES`, `VIEW DEFINITION` | |
| Schema | `CONTROL`, `ALTER`, `EXECUTE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `VIEW DEFINITION` | |
| Database | `CONNECT`, `VIEW DATABASE STATE`, `CREATE TABLE`, `CREATE PROC`, `BACKUP DATABASE`, `ALTER ANY USER`, `CONTROL` | |
| Server | `VIEW SERVER STATE`, `ALTER ANY DATABASE`, `ALTER ANY LOGIN`, `CONTROL SERVER` | |

---

## 11. Permission inheritance chain

Effective permission is the union of all granted permissions minus any DENY in any path.

```
CONTROL SERVER
    └── ALTER ANY DATABASE
        └── CONTROL DATABASE  (db_owner implied)
            └── CONTROL SCHEMA
                └── SELECT on Table
```

SQL Server resolves effective permissions in this order:
1. Check if principal is `sysadmin` → grant everything
2. Check if principal has `CONTROL SERVER` → grant everything
3. Check all explicit DENY at any level (server → database → schema → object) → deny wins
4. Check all explicit GRANT (server → database → schema → object → role membership)
5. Check `public` role

```sql
-- Check effective permissions for current user
SELECT * FROM fn_my_permissions(NULL, 'DATABASE');
SELECT * FROM fn_my_permissions('dbo.Orders', 'OBJECT');

-- Check effective permissions for another principal
EXECUTE AS USER = 'myapp_user';
SELECT * FROM fn_my_permissions('dbo.Orders', 'OBJECT');
REVERT;

-- Full permission graph for a user (including via roles)
WITH perms AS (
    SELECT
        dp.name         AS principal,
        p.class_desc,
        OBJECT_NAME(p.major_id) AS object_name,
        p.permission_name,
        p.state_desc
    FROM sys.database_permissions p
    JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
    WHERE dp.name = 'myapp_user'
    UNION ALL
    -- Permissions via role membership
    SELECT
        dp.name,
        p.class_desc,
        OBJECT_NAME(p.major_id),
        p.permission_name,
        p.state_desc
    FROM sys.database_permissions p
    JOIN sys.database_principals role_dp ON role_dp.principal_id = p.grantee_principal_id
    JOIN sys.database_role_members drm   ON drm.role_principal_id = role_dp.principal_id
    JOIN sys.database_principals dp      ON dp.principal_id       = drm.member_principal_id
    WHERE dp.name = 'myapp_user'
)
SELECT DISTINCT * FROM perms
ORDER BY class_desc, object_name, permission_name;
```

---

## 12. Ownership chaining

When a user executes a stored procedure, SQL Server checks the user's EXECUTE permission on the procedure, but does **not** check permissions on objects the procedure accesses — as long as the procedure and those objects share the same owner.

```sql
-- Setup: both proc and table owned by dbo
CREATE TABLE dbo.SensitiveData (id int, secret nvarchar(100));

CREATE PROCEDURE dbo.usp_GetSensitiveData
AS
    SELECT id, secret FROM dbo.SensitiveData;  -- same owner = chain is unbroken
GO

-- Grant EXECUTE on proc only; no SELECT on table needed
GRANT EXECUTE ON dbo.usp_GetSensitiveData TO limited_user;
-- limited_user can call the proc and read the data despite no direct SELECT grant
```

**Chain breaks when:**
- The owner changes (the procedure is owned by `user_a` but the table is owned by `user_b`)
- The object is in a different database (cross-database chaining requires `TRUSTWORTHY` or certificate-based security)
- Dynamic SQL is used inside the procedure — ownership chain does not apply to dynamically constructed SQL

```sql
-- Broken chain example
CREATE TABLE user_b.PrivateTable (id int);  -- owned by user_b
CREATE PROCEDURE dbo.usp_BrokenChain
AS
    SELECT * FROM user_b.PrivateTable;  -- SQL Server checks caller's permissions here
GO
-- limited_user needs explicit SELECT on user_b.PrivateTable
```

**Best practice:** Keep all objects within a schema owned by `dbo`. Create the schema with `AUTHORIZATION dbo`.

```sql
CREATE SCHEMA app AUTHORIZATION dbo;
```

---

## 13. Cross-database permissions

### Within the same instance

Option 1 — **Login-based access** (most common): the user's login must be mapped to a user in the target database.

```sql
USE TargetDB;
CREATE USER myapp_user FOR LOGIN myapp_login;
GRANT SELECT ON SCHEMA::dbo TO myapp_user;
```

Option 2 — **Cross-database ownership chaining**: works when both databases share the same owner (usually `sa`) and `TRUSTWORTHY` is OFF, but only if the chain is unbroken. Enabled per-database:

```sql
ALTER DATABASE SourceDB  SET DB_CHAINING ON;
ALTER DATABASE TargetDB  SET DB_CHAINING ON;
```

> [!WARNING]
> `DB_CHAINING ON` is a security risk. It allows unintended cross-database elevation. Prefer certificate-based signing or explicit grants.

Option 3 — **Certificate / asymmetric key signing** (recommended for cross-DB stored procs):

```sql
-- In SourceDB: sign the procedure
ADD SIGNATURE TO dbo.usp_CrossDbProc
    BY CERTIFICATE cert_for_proc WITH PASSWORD = 'CertPass!';

-- In TargetDB: create user from same cert (copy cert without private key)
CREATE CERTIFICATE cert_for_proc
    FROM BINARY = <same_cert_binary>;  -- export/import without private key
CREATE USER cert_user FROM CERTIFICATE cert_for_proc;
GRANT SELECT ON dbo.TargetTable TO cert_user;
```

### TRUSTWORTHY database property

`TRUSTWORTHY ON` allows the database owner to access server-level resources as if they have the owner's server permissions. This is required for CLR assemblies with `EXTERNAL_ACCESS` or `UNSAFE` permission sets when not using certificate signing.

```sql
ALTER DATABASE MyDB SET TRUSTWORTHY ON;

-- Check which databases have TRUSTWORTHY on
SELECT name, is_trustworthy_on FROM sys.databases WHERE is_trustworthy_on = 1;
```

> [!WARNING]
> Never enable `TRUSTWORTHY` on databases you don't fully control. If the `dbo` of that database is `sa` and the database is `TRUSTWORTHY`, any db_owner can escalate to `sysadmin`. Use certificate signing instead.

---

## 14. EXECUTE AS

`EXECUTE AS` switches the execution context. It is available at the session level, module (proc/function/trigger) level, and batch level.

### Session-level context switch

```sql
-- Switch to a named user
EXECUTE AS USER = 'myapp_user';
SELECT CURRENT_USER;   -- myapp_user
SELECT SYSTEM_USER;    -- still the original login

-- Revert to original context
REVERT;

-- Switch to login context
EXECUTE AS LOGIN = 'mylogin';
REVERT;
```

### Module-level EXECUTE AS

```sql
CREATE PROCEDURE dbo.usp_AuditedAction
    WITH EXECUTE AS OWNER   -- proc runs with owner's permissions, not caller's
AS
    INSERT INTO dbo.AuditLog (action, performed_by, ts)
    VALUES ('SomeAction', ORIGINAL_LOGIN(), SYSDATETIME());
GO

-- Options:
-- EXECUTE AS CALLER (default) — caller's permissions apply
-- EXECUTE AS OWNER            — proc owner's permissions apply; ownership chaining
-- EXECUTE AS SELF             — creator's permissions at create time (risky for dynamic SQL)
-- EXECUTE AS 'specific_user'  — specific named user's permissions
```

### Context functions

| Function | Returns |
|---|---|
| `USER_NAME()` / `CURRENT_USER` | Current database user (may be impersonated) |
| `SYSTEM_USER` | Original login (not affected by EXECUTE AS USER) |
| `ORIGINAL_LOGIN()` | Login that originally connected (never changes) |
| `SUSER_SNAME()` | Server-level login name for current context |
| `IS_MEMBER('role')` | 1 if current user is in the specified role |
| `IS_SRVROLEMEMBER('role')` | 1 if current login is in the specified server role |
| `HAS_PERMS_BY_NAME(obj, type, perm)` | 1 if current context has the specified permission |

```sql
-- Practical use: guard a procedure against unauthorized callers
IF HAS_PERMS_BY_NAME('dbo.SensitiveTable', 'OBJECT', 'SELECT') = 0
    THROW 50001, 'Caller does not have SELECT on SensitiveTable.', 1;
```

> [!WARNING]
> `EXECUTE AS SELF` captures the permission set of the user who runs `CREATE PROCEDURE`. If that user later loses permissions or is dropped, the proc may behave unexpectedly. Prefer `EXECUTE AS OWNER` or a dedicated signing certificate.

---

## 15. Schema-level security

Schemas are the recommended unit of permission management. Granting at the schema level applies to all current and future objects within the schema.

```sql
-- Create schemas with dbo ownership
CREATE SCHEMA app    AUTHORIZATION dbo;
CREATE SCHEMA rpt    AUTHORIZATION dbo;
CREATE SCHEMA etl    AUTHORIZATION dbo;
CREATE SCHEMA audit_ AUTHORIZATION dbo;

-- Grant read on reporting schema
GRANT SELECT ON SCHEMA::rpt TO app_reader;

-- Grant write on app schema
GRANT INSERT, UPDATE, DELETE ON SCHEMA::app TO app_writer;

-- Grant execute on app schema (all procs/functions)
GRANT EXECUTE ON SCHEMA::app TO app_exec;

-- VIEW DEFINITION: allows seeing proc/view source without execute rights
GRANT VIEW DEFINITION ON SCHEMA::app TO developer_role;
```

**Schema permission applies to future objects automatically.** Object-level grants do not.

---

## 16. Metadata queries

### All logins with role memberships

```sql
SELECT
    sp.name          AS login_name,
    sp.type_desc,
    sp.is_disabled,
    STRING_AGG(r.name, ', ') WITHIN GROUP (ORDER BY r.name) AS server_roles
FROM sys.server_principals sp
LEFT JOIN sys.server_role_members srm ON srm.member_principal_id = sp.principal_id
LEFT JOIN sys.server_principals r     ON r.principal_id          = srm.role_principal_id
WHERE sp.type IN ('S','U','G')
GROUP BY sp.name, sp.type_desc, sp.is_disabled
ORDER BY sp.name;
```

### All database users with role memberships

```sql
SELECT
    dp.name          AS db_user,
    dp.type_desc,
    dp.default_schema_name,
    STRING_AGG(r.name, ', ') WITHIN GROUP (ORDER BY r.name) AS db_roles
FROM sys.database_principals dp
LEFT JOIN sys.database_role_members drm ON drm.member_principal_id = dp.principal_id
LEFT JOIN sys.database_principals r     ON r.principal_id          = drm.role_principal_id
WHERE dp.type NOT IN ('R','A')
  AND dp.principal_id > 4
GROUP BY dp.name, dp.type_desc, dp.default_schema_name
ORDER BY dp.name;
```

### Explicit permissions for every user/role

```sql
SELECT
    pr.name             AS principal,
    pr.type_desc        AS principal_type,
    p.class_desc        AS securable_class,
    COALESCE(
        OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id),
        SCHEMA_NAME(p.major_id),
        CAST(p.major_id AS varchar(20))
    )                   AS securable_name,
    p.permission_name,
    p.state_desc
FROM sys.database_permissions p
JOIN sys.database_principals  pr ON pr.principal_id = p.grantee_principal_id
WHERE pr.principal_id > 4
ORDER BY pr.name, p.class_desc, securable_name, p.permission_name;
```

### Detect TRUSTWORTHY on databases not owned by sa

```sql
SELECT
    d.name,
    d.is_trustworthy_on,
    sp.name AS owner_login
FROM sys.databases d
JOIN sys.server_principals sp ON sp.sid = d.owner_sid
WHERE d.is_trustworthy_on = 1
  AND sp.name != 'sa';
```

### Orphaned users (no matching login)

```sql
SELECT dp.name AS orphaned_user, dp.type_desc
FROM sys.database_principals dp
WHERE dp.type IN ('S','U')
  AND dp.authentication_type = 1  -- instance auth
  AND NOT EXISTS (
      SELECT 1 FROM sys.server_principals sp
      WHERE sp.sid = dp.sid
  )
  AND dp.principal_id > 4;
```

---

## 17. Auditing permission changes

Track who granted/revoked/denied what using the `SCHEMA_OBJECT_PERMISSION_CHANGE_GROUP` and `DATABASE_PRINCIPAL_CHANGE_GROUP` audit action groups. See `38-auditing.md` for full audit setup.

```sql
-- Quick check: recent permission changes using default trace (SQL Server 2022 still supports this)
SELECT
    te.name         AS event_name,
    t.StartTime,
    t.NTUserName,
    t.ApplicationName,
    t.HostName,
    t.LoginName,
    t.DatabaseName,
    t.ObjectName,
    t.TextData
FROM sys.fn_trace_gettable(
    (SELECT path FROM sys.traces WHERE is_default = 1), DEFAULT
) t
JOIN sys.trace_events te ON te.trace_event_id = t.EventClass
WHERE te.name IN (
    'Audit Add Member to DB Role Event',
    'Audit Add Login to Server Role Event',
    'Audit Schema Object GDR Event',   -- GRANT/DENY/REVOKE on objects
    'Audit Database Principal Management'
)
ORDER BY t.StartTime DESC;
```

> [!WARNING] Deprecated
> The default trace is deprecated and will be removed in a future version. Use SQL Server Audit (see `38-auditing.md`) or Extended Events for long-term permission change tracking.

---

## 18. Gotchas / Anti-patterns

1. **`dbo` user and the `sa` login** — The `dbo` user in every database is automatically mapped to the `sa` login (and any `sysadmin` member). Granting `db_owner` to a service account gives it more than `db_datareader` + `db_datawriter` combined — it can drop tables and truncate data.

2. **DENY propagates through role membership** — If you `DENY SELECT` to role `r`, then all members of `r` are denied, even if they have an explicit `GRANT` from another role. This is often surprising.

3. **Public role is implicit** — Every user is a member of `public`. Permissions granted to `public` apply to every user in the database including future ones. Never grant sensitive permissions to `public`.

4. **Schema default and object resolution** — A user with `DEFAULT_SCHEMA = sales` who queries `SELECT * FROM Orders` will look for `sales.Orders` first. If it doesn't exist, SQL Server tries `dbo.Orders`. This is surprising when two schemas have same-named objects.

5. **Orphaned users after database restore** — Restoring a database to a different instance creates orphaned users (same `name` but the `SID` doesn't exist in the new instance's `master`). Always run `ALTER USER ... WITH LOGIN = ...` or `sp_change_users_login` after a cross-instance restore.

6. **`EXECUTE AS 'user'` doesn't work cross-database** — Impersonation context does not flow across database or server boundaries unless the target database has `TRUSTWORTHY ON` or you're using certificate-based security.

7. **Guest account** — By default, `guest` is denied `CONNECT` in user databases. Never re-enable it with `GRANT CONNECT TO guest` unless you specifically intend to allow any authenticated login into that database.

8. **Schema ownership ≠ schema permission** — Owning a schema (via `CREATE SCHEMA ... AUTHORIZATION user`) does not automatically grant DDL/DML permissions on schema objects to other users. Ownership controls who can `ALTER SCHEMA` and who inherits objects created within; permissions are still managed via GRANT.

9. **`WITH GRANT OPTION` cascade revoke** — When you `REVOKE ... CASCADE` from a user who had `WITH GRANT OPTION`, all downstream grants made by that user are also revoked. This can unexpectedly remove permissions from unrelated users.

10. **Server-role membership vs database role** — Adding a login to `db_owner` via `sp_addrolemember` (legacy) operates at the database level. Adding a login to a server role (e.g., `sysadmin`) operates at the instance level and gives access to all databases. These are separate hierarchies.

---

## 19. See also

- [`13-transactions-locking.md`](13-transactions-locking.md) — `EXECUTE AS` in transaction context
- [`14-error-handling.md`](14-error-handling.md) — catching permission errors (error 229, 230)
- [`16-security-encryption.md`](16-security-encryption.md) — RLS, DDM, TDE, Always Encrypted
- [`38-auditing.md`](38-auditing.md) — SQL Server Audit action groups for compliance
- [`06-stored-procedures.md`](06-stored-procedures.md) — `EXECUTE AS` in module context

---

## Sources

[^1]: [sys.server_principals (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-server-principals-transact-sql?view=sql-server-ver17) — catalog view returning a row for every server-level principal
[^2]: [sys.database_principals (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-database-principals-transact-sql?view=sql-server-ver17) — catalog view returning a row for each security principal in a database
[^3]: [sys.database_permissions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-database-permissions-transact-sql?view=sql-server-ver17) — catalog view returning a row for every permission or column-exception permission in a database
[^4]: [CREATE LOGIN (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-login-transact-sql?view=sql-server-ver17) — syntax, arguments, and examples for creating server-level logins
[^5]: [CREATE USER (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-user-transact-sql?view=sql-server-ver17) — syntax and examples for creating database-level users including contained users
[^6]: [sp_setapprole (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-setapprole-transact-sql?view=sql-server-ver17) — activating application role permissions in the current database
[^7]: [Tutorial: Ownership Chains and Context Switching](https://learn.microsoft.com/en-us/sql/relational-databases/tutorial-ownership-chains-and-context-switching?view=sql-server-ver17) — walkthrough of ownership chaining and EXECUTE AS context switching
[^8]: [EXECUTE AS Clause (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/execute-as-clause-transact-sql?view=sql-server-ver17) — defining execution context for modules (procedures, functions, triggers, queues)
[^9]: [Database-Level Roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/database-level-roles?view=sql-server-ver17) — fixed and user-defined database roles with permissions
[^10]: [Server-Level Roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles?view=sql-server-ver17) — fixed and user-defined server roles with permissions
[^11]: [Contained User Access to Contained Databases](https://learn.microsoft.com/en-us/sql/relational-databases/security/contained-database-users-making-your-database-portable?view=sql-server-ver17) — contained database user model vs traditional login/user model
[^12]: [sys.fn_my_permissions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-my-permissions-transact-sql?view=sql-server-ver17) — returns effective permissions of the current principal on a securable
[^13]: [HAS_PERMS_BY_NAME (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/has-perms-by-name-transact-sql?view=sql-server-ver17) — evaluates effective permission of the current user on a securable
[^14]: [User with Elevated Database Permissions](https://www.brentozar.com/blitz/user-with-elevated-database-permissions/) — Brent Ozar on risks of granting db_owner and elevated database permissions
[^15]: [TRUSTWORTHY database property](https://learn.microsoft.com/en-us/sql/relational-databases/security/trustworthy-database-property?view=sql-server-ver17) — security implications and best practices for the TRUSTWORTHY setting

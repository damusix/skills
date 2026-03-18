# Linked Servers

## Table of Contents
1. [When to Use](#1-when-to-use)
2. [Architecture Overview](#2-architecture-overview)
3. [Creating Linked Servers](#3-creating-linked-servers)
4. [Four-Part Names](#4-four-part-names)
5. [OPENQUERY](#5-openquery)
6. [OPENDATASOURCE](#6-opendatasource)
7. [Security and Authentication](#7-security-and-authentication)
8. [Distributed Transactions and DTC](#8-distributed-transactions-and-dtc)
9. [Performance Gotchas](#9-performance-gotchas)
10. [Metadata and Management](#10-metadata-and-management)
11. [Common Patterns](#11-common-patterns)
12. [Azure SQL and Linked Servers](#12-azure-sql-and-linked-servers)
13. [Gotchas / Anti-Patterns](#13-gotchas--anti-patterns)
14. [See Also](#14-see-also)
15. [Sources](#15-sources)

---

## 1. When to Use

Use linked servers when you need to:
- Query data from a remote SQL Server instance in a single T-SQL statement
- Execute remote stored procedures
- Access heterogeneous data sources (Oracle, Excel, flat files, ODBC sources)
- Perform cross-instance distributed transactions (OLTP, not analytics — see caveats)

**Prefer alternatives when:**
- You need reliable, high-volume data movement → use SSIS, Azure Data Factory, or bcp
- You need near-real-time replication → use Always On readable secondaries or Transactional Replication
- You need analytics across systems → use PolyBase (`46-polybase-external-tables.md`) or external tables
- Performance matters and the remote query is complex → linked servers frequently pull too much data

Linked servers are best for ad-hoc lookups and infrequent cross-server joins. They are a common source of performance surprises in production.

---

## 2. Architecture Overview

```
Local SQL Server
  └── sp_addlinkedserver (registers remote)
        ├── Provider (SQLNCLI11, MSOLEDBSQL, OraOLEDB.Oracle, etc.)
        ├── Data Source (remote host\instance or DSN)
        ├── Security mapping (local login → remote login)
        └── Options (RPC, RPC OUT, collation compatibility, etc.)
```

When you reference a linked server:
1. SQL Server contacts the OLE DB provider
2. The provider connects to the remote data source
3. SQL Server sends SQL to the remote (full remote execution via OPENQUERY, or partial via four-part names)
4. Results return over the network and are joined locally

**Key providers:**

| Provider | Target | Notes |
|---|---|---|
| `MSOLEDBSQL` | SQL Server (modern) | Recommended for SQL Server 2012+ |
| `SQLNCLI11` | SQL Server (legacy) | Deprecated; still widely used |
| `OraOLEDB.Oracle` | Oracle | Requires Oracle client install |
| `Microsoft.ACE.OLEDB.12.0` | Excel, Access | For file-based sources; not recommended in prod |
| `MSDASQL` | ODBC sources | Generic ODBC bridge |

---

## 3. Creating Linked Servers

### Basic SQL Server to SQL Server

```sql
-- Add linked server (modern provider)
EXEC sp_addlinkedserver
    @server     = N'REMOTE_SERVER',        -- alias used in queries
    @srvproduct = N'SQL Server',
    @provider   = N'MSOLEDBSQL',
    @datasrc    = N'remotehost\instancename';  -- or just 'remotehost' for default instance

-- Configure options
EXEC sp_serveroption
    @server     = N'REMOTE_SERVER',
    @optname    = N'rpc',          -- allow remote procedure calls
    @optvalue   = N'true';

EXEC sp_serveroption
    @server     = N'REMOTE_SERVER',
    @optname    = N'rpc out',      -- allow local procs to call remote procs
    @optvalue   = N'true';

EXEC sp_serveroption
    @server     = N'REMOTE_SERVER',
    @optname    = N'collation compatible',  -- skip remote collation check; set only if collations match
    @optvalue   = N'false';

EXEC sp_serveroption
    @server     = N'REMOTE_SERVER',
    @optname    = N'data access',
    @optvalue   = N'true';
```

### Security mapping

```sql
-- Map local login to remote login
EXEC sp_addlinkedsrvlogin
    @rmtsrvname  = N'REMOTE_SERVER',
    @useself     = N'false',          -- don't use current credentials
    @locallogin  = NULL,              -- NULL = applies to all local logins without explicit mapping
    @rmtuser     = N'remote_user',
    @rmtpassword = N'StrongPassword!';

-- Explicit mapping for a specific local login
EXEC sp_addlinkedsrvlogin
    @rmtsrvname  = N'REMOTE_SERVER',
    @useself     = N'false',
    @locallogin  = N'MyDomain\AppServiceAccount',
    @rmtuser     = N'remote_app_user',
    @rmtpassword = N'StrongPassword!';

-- Self-mapping (pass current Windows credentials — requires Kerberos delegation)
EXEC sp_addlinkedsrvlogin
    @rmtsrvname  = N'REMOTE_SERVER',
    @useself     = N'true',
    @locallogin  = NULL;
```

### Remove a linked server

```sql
EXEC sp_dropserver
    @server   = N'REMOTE_SERVER',
    @droplogins = 'droplogins';  -- also removes all login mappings
```

---

## 4. Four-Part Names

Four-part naming allows referencing remote objects inline in T-SQL:

```sql
-- [linked_server_name].[database].[schema].[object]
SELECT *
FROM REMOTE_SERVER.Northwind.dbo.Orders
WHERE OrderDate >= '2024-01-01';

-- Join local and remote tables
SELECT o.OrderID, c.CustomerName
FROM dbo.LocalOrders o
JOIN REMOTE_SERVER.Northwind.dbo.Customers c
    ON o.CustomerID = c.CustomerID;

-- INSERT from remote
INSERT INTO dbo.LocalCopy (OrderID, Amount)
SELECT OrderID, TotalAmount
FROM REMOTE_SERVER.SalesDB.dbo.Orders
WHERE OrderDate = CAST(GETDATE() AS date);
```

**What SQL Server does with four-part names:**
- If the optimizer can't push predicates to the remote, it may fetch the entire remote table and filter locally
- With OPENQUERY (see §5), you control exactly what the remote server executes

> [!WARNING] Performance
> A four-part name query like `SELECT * FROM LINKED.DB.dbo.BigTable WHERE col = @val` may transfer the entire table if the optimizer cannot push the predicate. Always check the execution plan — look for a "Remote Query" operator and examine what SQL it sends to the remote.

---

## 5. OPENQUERY

OPENQUERY executes a pass-through query on the remote server. The entire string is sent as-is to the remote — SQL Server cannot inspect or optimize it locally.

```sql
-- Basic pass-through query
SELECT *
FROM OPENQUERY(REMOTE_SERVER, 'SELECT OrderID, Amount FROM SalesDB.dbo.Orders WHERE OrderDate >= ''2024-01-01''');

-- Insert using OPENQUERY result
INSERT INTO dbo.LocalCache
SELECT *
FROM OPENQUERY(REMOTE_SERVER, 'SELECT ProductID, Price FROM Catalog.dbo.Products');

-- UPDATE via OPENQUERY (if provider supports it)
UPDATE OPENQUERY(REMOTE_SERVER, 'SELECT Price FROM Catalog.dbo.Products WHERE ProductID = 42')
SET Price = 99.99;
```

### OPENQUERY vs four-part names

| Feature | Four-Part Name | OPENQUERY |
|---|---|---|
| Predicate pushdown | Optimizer decides; may fail | Always pushed — full query runs remote |
| Parameter support | Supports local variables | String literal only — no parameters |
| Plan readability | Remote Query node in plan | Remote Query node in plan |
| Injection risk | None (parameterized) | High — must sanitize manually |
| Performance | Unpredictable | Predictable (remote controls execution) |
| Use case | Ad-hoc, simple queries | Performance-critical, complex remote queries |

### Dynamic OPENQUERY (handle with care)

```sql
-- UNSAFE example — do not use with user input
DECLARE @sql NVARCHAR(MAX) = N'SELECT * FROM OPENQUERY(REMOTE_SERVER, ''SELECT * FROM dbo.T WHERE id = ' + CAST(@id AS NVARCHAR) + ''')';
EXEC sp_executesql @sql;

-- SAFER approach: validate/whitelist input before embedding in OPENQUERY string
-- There is no parameterization for OPENQUERY — sanitize all values
DECLARE @safe_id INT = CAST(@input_id AS INT);  -- ensure it's an integer
DECLARE @sql2 NVARCHAR(MAX) = N'SELECT * FROM OPENQUERY(REMOTE_SERVER, ''SELECT * FROM dbo.T WHERE id = '
    + CAST(@safe_id AS NVARCHAR) + ''')';
EXEC sp_executesql @sql2;
```

> [!WARNING] SQL Injection
> OPENQUERY does not support parameterization. Any dynamic value embedded in the query string is a potential injection vector. Validate and cast all inputs to strongly typed values before embedding. Avoid OPENQUERY with untrusted input.

---

## 6. OPENDATASOURCE

OPENDATASOURCE is for one-off queries without a pre-configured linked server. It accepts a provider name and connection string inline.

```sql
-- One-off query to another SQL Server instance
SELECT *
FROM OPENDATASOURCE(
    'MSOLEDBSQL',
    'Data Source=remotehost;Initial Catalog=Northwind;User ID=myuser;Password=mypass;'
).Northwind.dbo.Orders
WHERE OrderID = 10248;
```

> [!WARNING] Security and Performance
> OPENDATASOURCE embeds credentials in the query string (visible in query plans, logs, and `sys.dm_exec_sql_text`). Avoid in production. Use sp_addlinkedserver with a security mapping instead. OPENDATASOURCE also bypasses linked server options like RPC and collation settings.

OPENDATASOURCE requires `Ad Hoc Distributed Queries` enabled:

```sql
EXEC sp_configure 'show advanced options', 1;
RECONFIGURE;
EXEC sp_configure 'Ad Hoc Distributed Queries', 1;
RECONFIGURE;
```

---

## 7. Security and Authentication

### Authentication modes

| Mode | How it works | Requirements | Risk |
|---|---|---|---|
| SQL login mapping | Local login maps to a fixed remote SQL login | sp_addlinkedsrvlogin | Password stored in master (encrypted) |
| Self (Windows passthrough) | Current Windows token passed to remote | Kerberos delegation (SPN) | Double-hop problem — see below |
| Self (same machine) | Shared memory — no double-hop | Remote = local instance | Low |
| No mapping | Connection fails for unmapped logins | Explicit allow or deny | Default deny |

### Kerberos double-hop problem

When using `@useself = 'true'` (passthrough credentials):
1. User authenticates to Local SQL Server (first hop — OK)
2. Local SQL Server tries to authenticate to Remote SQL Server as the user (second hop — requires Kerberos delegation)

Without constrained delegation configured in Active Directory, the second hop fails with an authentication error.

**Solutions:**
1. **Constrained Kerberos delegation** — configure in AD for the SQL Server service account (preferred)
2. **SQL login mapping** — use `sp_addlinkedsrvlogin` with a dedicated service account
3. **Same-instance linked server** — use `LOOPBACK` linked server for self-referencing (no delegation needed)

### SPN requirements for Kerberos

The remote SQL Server must have SPNs registered:
```
setspn -S MSSQLSvc/remotehost.domain.com:1433 DOMAIN\SqlServiceAccount
setspn -S MSSQLSvc/remotehost:1433 DOMAIN\SqlServiceAccount
```

---

## 8. Distributed Transactions and DTC

When a single T-SQL statement touches multiple linked servers (or a single linked server + local tables), SQL Server automatically escalates to a distributed transaction via Microsoft Distributed Transaction Coordinator (MSDTC).

```sql
BEGIN TRANSACTION;

    -- Local write
    INSERT INTO dbo.LocalAudit (msg) VALUES ('Starting sync');

    -- Remote write — auto-escalates to distributed transaction
    INSERT INTO REMOTE_SERVER.TargetDB.dbo.SyncLog (msg)
    VALUES ('Received');

COMMIT TRANSACTION;
-- If either insert fails, both roll back — MSDTC coordinates
```

### DTC requirements

- MSDTC must be running on **both** servers
- Network DTC access must be enabled (Windows Firewall, DTC security config)
- For Linux SQL Server: MSDTC is available from SQL Server 2019 on Linux but requires configuration via `mssql-conf`

### DTC configuration (Windows)

```
Component Services → Computers → My Computer → Distributed Transaction Coordinator
  → Properties → Security tab:
    ✓ Network DTC Access
    ✓ Allow Remote Clients
    ✓ Allow Inbound/Outbound
    ✓ Enable XA Transactions
    ✓ Enable SNA LU 6.2 Transactions (optional)
```

> [!WARNING] DTC in practice
> DTC is notoriously fragile — firewall changes, NLB configurations, or service restarts can silently break distributed transactions. Test DTC connectivity before going to production. Many teams avoid linked server DTC entirely by restructuring the workload to use explicit two-phase application logic or staging tables.

### Avoiding DTC escalation

A query that only reads (no writes) from a linked server does **not** start a DTC transaction.

A local BEGIN TRANSACTION + remote read (no write) also typically avoids DTC unless the linked server returns data that is modified locally within the same transaction scope.

To explicitly control: use `SET XACT_ABORT ON` — if a remote operation fails, the local transaction is aborted cleanly without waiting for DTC timeout.

---

## 9. Performance Gotchas

### Remote query plans

Always check the execution plan for linked server queries. Look for:
- **Remote Query** operator — click it, read the "Remote Query" property to see exactly what SQL was sent
- Large "Estimated Number of Rows" on the Remote Query — if high, the remote may return many rows that are filtered locally

```sql
-- Check what SQL Server sends to the remote
SET SHOWPLAN_XML ON;
GO
SELECT *
FROM REMOTE_SERVER.Northwind.dbo.Orders
WHERE CustomerID = 'ALFKI';
GO
SET SHOWPLAN_XML OFF;
-- Examine the RemoteQuery text in the plan XML
```

### Predicate pushdown failure

Common reasons the optimizer fails to push predicates to a linked server:

| Cause | Effect | Fix |
|---|---|---|
| Type mismatch (local `INT` vs remote `BIGINT`) | Full table scan remote | Cast explicitly |
| Collation mismatch on string columns | Filter not pushed | Use OPENQUERY with explicit WHERE |
| Complex expression (function on column) | Not pushable | Simplify; use OPENQUERY |
| `collation compatible = false` | String comparisons not pushed | Set `true` if collations genuinely match |
| Remote table has incompatible statistics | Bad cardinality estimate | Use OPENQUERY for better control |

### Remote statistics

SQL Server can fetch statistics from a linked server to improve cardinality estimates:

```sql
-- Check if remote statistics are available
EXEC sp_serveroption
    @server   = N'REMOTE_SERVER',
    @optname  = N'use remote collation',
    @optvalue = N'true';
```

For SQL Server linked servers, statistics are fetched via internal calls. For non-SQL Server providers, statistics are typically unavailable and cardinality defaults to 1 or 10000.

### Loopback linked servers

A linked server pointing to the same instance (loopback) can be useful for testing or for OPENQUERY against the same server:

```sql
EXEC sp_addlinkedserver
    @server   = N'LOOPBACK',
    @srvproduct = N'',
    @provider = N'MSOLEDBSQL',
    @datasrc  = N'(local)';

-- Now you can use OPENQUERY with a string that runs in a separate scope
SELECT *
FROM OPENQUERY(LOOPBACK, 'SELECT * FROM master.sys.databases');
```

Use case: OPENQUERY on the same server avoids the "no parameters in OPENQUERY" limitation — you build the string dynamically and execute via sp_executesql:

```sql
DECLARE @sql NVARCHAR(4000) =
    N'SELECT * FROM OPENQUERY(LOOPBACK, ''SELECT TOP (10) name FROM sys.objects WHERE type = ''''U'''''')';
EXEC sp_executesql @sql;
```

---

## 10. Metadata and Management

### List linked servers

```sql
SELECT
    s.name,
    s.product,
    s.provider,
    s.data_source,
    s.is_linked,
    s.is_remote_proc_transaction_promotion_enabled
FROM sys.servers s
WHERE s.is_linked = 1;
```

### List login mappings

```sql
SELECT
    s.name AS linked_server,
    l.remote_name,
    l.local_name,
    l.uses_self_credential
FROM sys.linked_logins l
JOIN sys.servers s ON l.server_id = s.server_id
WHERE s.is_linked = 1;
```

### Test connectivity

```sql
-- Test basic connectivity
EXEC sp_testlinkedserver 'REMOTE_SERVER';

-- Check if remote server is online
SELECT name, is_linked
FROM sys.servers
WHERE name = 'REMOTE_SERVER';

-- Test with a simple query
SELECT @@SERVERNAME AS remote_server
FROM OPENQUERY(REMOTE_SERVER, 'SELECT @@SERVERNAME');
```

### Server options reference

```sql
-- List all options for a linked server
EXEC sp_helpserver 'REMOTE_SERVER';

-- Set common options
EXEC sp_serveroption 'REMOTE_SERVER', 'rpc', 'true';            -- allow inbound RPC
EXEC sp_serveroption 'REMOTE_SERVER', 'rpc out', 'true';        -- allow outbound RPC
EXEC sp_serveroption 'REMOTE_SERVER', 'data access', 'true';    -- allow data queries
EXEC sp_serveroption 'REMOTE_SERVER', 'lazy schema validation', 'true';  -- skip remote schema check until query time
EXEC sp_serveroption 'REMOTE_SERVER', 'query timeout', '30';    -- seconds; 0 = infinite
EXEC sp_serveroption 'REMOTE_SERVER', 'connect timeout', '10';  -- seconds
EXEC sp_serveroption 'REMOTE_SERVER', 'collation compatible', 'false';
EXEC sp_serveroption 'REMOTE_SERVER', 'use remote collation', 'true';
```

### Remote procedure calls

```sql
-- Execute a stored procedure on the remote server
-- Requires 'rpc' and 'rpc out' options set to true
EXEC REMOTE_SERVER.TargetDB.dbo.usp_ProcessBatch @batch_id = 42;

-- With output parameter
DECLARE @result INT;
EXEC REMOTE_SERVER.TargetDB.dbo.usp_GetCount @result OUTPUT;
SELECT @result;
```

---

## 11. Common Patterns

### Cross-instance lookup with OPENQUERY

```sql
-- Pull reference data from a central server
SELECT
    o.OrderID,
    p.ProductName,
    p.ListPrice
FROM dbo.OrderItems o
CROSS APPLY (
    SELECT ProductName, ListPrice
    FROM OPENQUERY(CATALOG_SERVER,
        'SELECT ProductID, ProductName, ListPrice FROM Products.dbo.Catalog WHERE IsActive = 1')
    WHERE ProductID = o.ProductID  -- local filter after remote fetch
) p;
```

**Better pattern** — push the filter to the remote:

```sql
-- Build dynamic OPENQUERY with the product ID list
DECLARE @ids NVARCHAR(MAX) = (
    SELECT STRING_AGG(CAST(ProductID AS NVARCHAR), ',')
    FROM dbo.OrderItems
);
DECLARE @sql NVARCHAR(MAX) = N'
    SELECT *
    FROM OPENQUERY(CATALOG_SERVER, ''SELECT ProductID, ProductName, ListPrice
    FROM Products.dbo.Catalog WHERE ProductID IN (' + @ids + ')'')';
EXEC sp_executesql @sql;
```

### Incremental data pull

```sql
-- Pull new records since last sync
DECLARE @last_sync DATETIME2 = (SELECT MAX(synced_at) FROM dbo.SyncCheckpoint);

-- Use OPENQUERY to ensure predicate is pushed
DECLARE @sql NVARCHAR(MAX) = N'
    SELECT *
    FROM OPENQUERY(REMOTE_SERVER, ''
        SELECT TransactionID, Amount, TransactionDate
        FROM FinanceDB.dbo.Transactions
        WHERE TransactionDate > ''''' + CONVERT(NVARCHAR, @last_sync, 126) + '''''
    '')';
EXEC sp_executesql @sql;
```

### Remote execute with EXEC AT

```sql
-- SQL Server 2005+ AT clause — preferred for RPC to SQL Server linked servers
EXEC ('UPDATE dbo.Config SET Value = ? WHERE Key = ?', 'new_value', 'timeout')
    AT REMOTE_SERVER;

-- WITH RESULT SETS for metadata control
EXEC ('SELECT TOP 10 * FROM dbo.Events') AT REMOTE_SERVER
WITH RESULT SETS (
    (EventID INT, EventType NVARCHAR(50), EventTime DATETIME2)
);
```

The `AT` syntax uses RPC and properly handles parameters without string concatenation.

---

## 12. Azure SQL and Linked Servers

### Azure SQL Database

Azure SQL Database **does not support** linked servers as a data source provider or as a server that hosts outbound linked server connections. There is no equivalent of `sp_addlinkedserver` in Azure SQL Database.

**Alternatives for Azure SQL Database:**
- **Elastic Query** — cross-database queries within the same logical server using external data sources and external tables (limited, deprecated in newer documentation)
- **PolyBase** — external tables to Azure Blob, S3, etc. (`46-polybase-external-tables.md`)
- **Synapse Link** — for analytics workloads
- **Application-level data access** — preferred for production cross-database work

### Azure SQL Managed Instance

Azure SQL Managed Instance **supports linked servers** with the following restrictions:

- Supported providers: SQL Server (MSOLEDBSQL), Azure SQL MI, SQL Server on Azure VM
- Not supported: Oracle, ODBC, OLE DB file-based providers
- MSDTC: Limited support; avoid cross-MI distributed transactions
- Windows Auth (Kerberos): Supported if Azure AD joined and SPN configured
- `sp_addlinkedserver`, `sp_addlinkedsrvlogin` — fully supported

```sql
-- Linked server from MI to another SQL Server / MI
EXEC sp_addlinkedserver
    @server     = N'OTHER_MI',
    @srvproduct = N'',
    @provider   = N'MSOLEDBSQL',
    @datasrc    = N'other-mi.public.xxxx.database.windows.net,3342';

EXEC sp_addlinkedsrvlogin
    @rmtsrvname  = N'OTHER_MI',
    @useself     = N'false',
    @locallogin  = NULL,
    @rmtuser     = N'sql_user',
    @rmtpassword = N'StrongPassword!';
```

---

## 13. Gotchas / Anti-Patterns

1. **Full table transfer via four-part name** — the most common linked server problem. Always verify with SHOWPLAN that predicates are pushed. Use OPENQUERY when in doubt.

2. **No parameters in OPENQUERY** — OPENQUERY takes a string literal, not a parameterized query. To use variables, build the string dynamically with `sp_executesql`, but watch for injection (see §5).

3. **DTC failures are silent until commit** — a distributed transaction may appear to work fine up to COMMIT, then fail with DTC errors (error 8501, 7391). Test DTC in staging before production.

4. **Credentials stored in master** — remote login passwords are stored encrypted in `sys.linked_logins`. A restore of master to another server carries these credentials. Treat linked server credentials as sensitive secrets.

5. **Collation mismatch causes remote scans** — if local and remote have different collations and `collation compatible` is false (the safe default), string predicates may not be pushed to the remote. Use OPENQUERY with explicit filters for string-based joins.

6. **Linked server names are case-sensitive in some contexts** — the name registered via `sp_addlinkedserver` must exactly match usage in queries (including four-part names and OPENQUERY/AT).

7. **No linked servers to Azure SQL Database** — see §12. If you attempt to configure one, sp_addlinkedserver will succeed but queries will fail at runtime.

8. **Lazy schema validation delays errors** — with `lazy schema validation = true`, schema mismatches between local and remote are detected at query time, not at plan compilation. This can produce runtime errors that look like data errors.

9. **RPC OUT required for remote EXEC** — if you try `EXEC REMOTE_SERVER.db.dbo.proc` without `rpc out = true`, you get error 7411. Set this option deliberately — it increases attack surface if the remote is compromised.

10. **OPENQUERY cannot be the target of an INSERT/UPDATE/DELETE with complex queries** — updatable OPENQUERY has restrictions (single table, no aggregates, no JOINs in the subquery). Use four-part names or application-layer writes for complex remote DML.

11. **Query timeouts differ from connection timeouts** — `connect timeout` controls how long to wait for the initial connection; `query timeout` controls how long a query runs before being cancelled. Both default to 0 (infinite) — set explicit values for production.

12. **Linked server joins create serial execution zones** — optimizer cannot parallelize across the linked server boundary. The local side of a linked server join runs serial, which can severely hurt performance on large datasets.

---

## 14. See Also

- `46-polybase-external-tables.md` — PolyBase for large-scale cross-source queries (better alternative for analytics)
- `47-cli-bulk-operations.md` — bcp and BULK INSERT for data movement
- `13-transactions-locking.md` — distributed transactions and isolation levels
- `16-security-encryption.md` — credential management and encryption
- `23-dynamic-sql.md` — safe dynamic SQL patterns for OPENQUERY
- `49-configuration-tuning.md` — sp_configure for Ad Hoc Distributed Queries

---

## Sources

[^1]: [Linked Servers (Database Engine) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/linked-servers/linked-servers-database-engine) — overview of linked server architecture, providers, configuration, and Azure SQL Managed Instance support
[^2]: [sp_addlinkedserver (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-addlinkedserver-transact-sql) — reference for creating linked servers including provider options, security mapping, and examples
[^3]: [OPENQUERY (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/openquery-transact-sql) — reference for executing pass-through queries on linked servers
[^4]: [OPENDATASOURCE (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/opendatasource-transact-sql) — reference for ad hoc connections to OLE DB data sources without a pre-configured linked server
[^5]: [Transactions: availability groups & database mirroring - SQL Server Always On | Microsoft Learn](https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/transactions-always-on-availability-and-database-mirroring) — covers distributed transaction (MSDTC/DTC) support and limitations in SQL Server availability groups
[^6]: [Why Are Linked Server Queries So Bad?](https://www.brentozar.com/archive/2021/07/why-are-linked-server-queries-so-bad/) — Brent Ozar explains why linked server queries cause poor performance, including full table transfers and lack of result caching

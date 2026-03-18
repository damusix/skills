# 39 — Triggers

## Table of Contents

1. [When to Use](#when-to-use)
2. [Trigger Types Overview](#trigger-types-overview)
3. [DML Trigger Syntax](#dml-trigger-syntax)
4. [AFTER vs INSTEAD OF](#after-vs-instead-of)
5. [inserted and deleted Virtual Tables](#inserted-and-deleted-virtual-tables)
6. [COLUMNS_UPDATED and UPDATE()](#columns_updated-and-update)
7. [Set-Based Logic Inside Triggers](#set-based-logic-inside-triggers)
8. [Trigger Execution Order (sp_settriggerorder)](#trigger-execution-order-sp_settriggerorder)
9. [Nested and Recursive Triggers](#nested-and-recursive-triggers)
10. [DDL Triggers](#ddl-triggers)
11. [Logon Triggers](#logon-triggers)
12. [EVENTDATA() Function](#eventdata-function)
13. [Trigger and Transaction Interaction](#trigger-and-transaction-interaction)
14. [Common Patterns](#common-patterns)
15. [Anti-Patterns](#anti-patterns)
16. [Metadata Queries](#metadata-queries)
17. [Gotchas](#gotchas)
18. [See Also](#see-also)
19. [Sources](#sources)

---

## When to Use

**Use triggers when:**
- Auditing must be enforced transparently without caller cooperation (INSERT/UPDATE/DELETE audit log)
- Cross-table constraints cannot be expressed with CHECK constraints or FK (e.g., "must have at least one row in child table")
- Legacy INSTEAD OF trigger pattern on non-updateable views is the only viable path
- DDL event logging or blocking is required (CREATE/ALTER/DROP events)
- Logon-time restrictions cannot be handled at the application layer

**Prefer over triggers:**
- Application-layer logic for business rules (testable, debuggable, versioned)
- Computed persisted columns for derived values
- `DEFAULT` constraints and CHECK constraints for simple validation
- Temporal tables (`17-temporal-tables.md`) for history tracking — lower overhead, better query support
- Change Tracking or CDC (`37-change-tracking-cdc.md`) for change capture at scale

---

## Trigger Types Overview

| Type | Fires On | Scope | When |
|------|----------|-------|------|
| `AFTER` DML trigger | INSERT, UPDATE, DELETE | Table | After statement succeeds, before COMMIT |
| `INSTEAD OF` DML trigger | INSERT, UPDATE, DELETE | Table or View | Replaces the DML statement entirely |
| `AFTER` DDL trigger | CREATE, ALTER, DROP, etc. | Database or Server | After DDL statement executes |
| Logon trigger | LOGON event | Server | After authentication, before session is established |

> [!NOTE] SQL Server 2005+
> DDL triggers and logon triggers were introduced in SQL Server 2005.

---

## DML Trigger Syntax

### Basic AFTER trigger

```sql
CREATE OR ALTER TRIGGER dbo.trg_Orders_Audit
ON dbo.Orders
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;

    -- Guard: no rows affected
    IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
        RETURN;

    -- Insert audit rows for deleted (UPDATE before-image and DELETE)
    INSERT INTO dbo.OrdersAudit (OrderId, Action, OldStatus, NewStatus, ChangedAt, ChangedBy)
    SELECT
        COALESCE(i.OrderId, d.OrderId),
        CASE
            WHEN i.OrderId IS NOT NULL AND d.OrderId IS NOT NULL THEN 'UPDATE'
            WHEN i.OrderId IS NOT NULL THEN 'INSERT'
            ELSE 'DELETE'
        END,
        d.Status,
        i.Status,
        SYSUTCDATETIME(),
        SYSTEM_USER
    FROM inserted i
    FULL OUTER JOIN deleted d ON i.OrderId = d.OrderId;
END;
GO
```

### Dropping and altering

```sql
-- Preferred: CREATE OR ALTER (2016+) avoids DROP/CREATE cycle
CREATE OR ALTER TRIGGER dbo.trg_Orders_Audit
ON dbo.Orders
AFTER INSERT, UPDATE, DELETE
AS ...

-- Disable/enable without dropping (preserves permissions)
DISABLE TRIGGER dbo.trg_Orders_Audit ON dbo.Orders;
ENABLE  TRIGGER dbo.trg_Orders_Audit ON dbo.Orders;

-- Disable ALL triggers on a table
DISABLE TRIGGER ALL ON dbo.Orders;
ENABLE  TRIGGER ALL ON dbo.Orders;

DROP TRIGGER dbo.trg_Orders_Audit;
```

---

## AFTER vs INSTEAD OF

| Feature | AFTER | INSTEAD OF |
|---------|-------|------------|
| Valid on tables | Yes | Yes |
| Valid on views | No | Yes |
| Runs after statement | Yes (post-constraint check) | No — replaces statement |
| `inserted`/`deleted` populated | Yes | Yes (reflects attempted DML) |
| Can abort with ROLLBACK | Yes | Yes (or just don't execute the DML) |
| Multiple per event per object | Yes (ordered via `sp_settriggerorder`) | One per event per object |
| Constraint firing order | After constraints | Before constraints |
| FK cascade interaction | After cascade completes | Not applicable |

### INSTEAD OF on a view

```sql
CREATE OR ALTER TRIGGER dbo.trg_vOrdersActive_IU
ON dbo.vOrdersActive          -- a non-updateable view
INSTEAD OF INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    -- Decompose the view insert/update into base table operations
    UPDATE o
    SET    o.Status = i.Status,
           o.ModifiedAt = SYSUTCDATETIME()
    FROM   dbo.Orders o
    JOIN   inserted   i ON o.OrderId = i.OrderId;

    INSERT INTO dbo.Orders (CustomerId, Status, CreatedAt)
    SELECT i.CustomerId, i.Status, SYSUTCDATETIME()
    FROM   inserted i
    LEFT JOIN dbo.Orders o ON o.OrderId = i.OrderId
    WHERE  o.OrderId IS NULL;
END;
GO
```

> [!WARNING]
> `INSTEAD OF DELETE` on a view with cascading FK relationships requires manually cascading the deletes. The engine does NOT cascade for you when an INSTEAD OF trigger fires — you own the complete operation.

---

## inserted and deleted Virtual Tables

Both `inserted` and `deleted` are in-memory tables with the **same schema as the trigger's base table** (including all columns, even those not referenced in the DML statement).

| Trigger Event | `inserted` | `deleted` |
|---------------|------------|-----------|
| INSERT | New rows | Empty |
| DELETE | Empty | Removed rows |
| UPDATE | After-image (new values) | Before-image (old values) |

Key rules:
- Both are **multi-row** — never assume a single row. Code that assumes single-row fires correctly until a bulk DML operation produces wrong results.
- Columns in `inserted`/`deleted` that were NOT included in an UPDATE statement still reflect the **current stored value** (before-image for `deleted`, after-image for `inserted`).
- `inserted` and `deleted` cannot be referenced in subqueries that use aggregation (use a `JOIN` or `EXISTS` instead for set-based logic).
- For INSTEAD OF triggers, `inserted`/`deleted` reflect the *attempted* values, not values already in the table.

```sql
-- Accessing both images in an UPDATE trigger
CREATE OR ALTER TRIGGER dbo.trg_Products_PriceChange
ON dbo.Products
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    -- Only fire when Price column actually changed
    IF NOT UPDATE(Price) RETURN;

    INSERT INTO dbo.PriceHistory (ProductId, OldPrice, NewPrice, ChangedAt)
    SELECT d.ProductId, d.Price, i.Price, SYSUTCDATETIME()
    FROM   inserted i
    JOIN   deleted  d ON i.ProductId = d.ProductId
    WHERE  i.Price <> d.Price;    -- Additional row-level guard
END;
GO
```

### TEXT/NTEXT/IMAGE columns (legacy)

`inserted`/`deleted` do **not** contain BLOB columns of type `text`, `ntext`, or `image`. Use `TEXTPTR()` to get a pointer if you need the value. Prefer `varchar(max)` / `nvarchar(max)` / `varbinary(max)` in new designs — these are fully available in `inserted`/`deleted`.

---

## COLUMNS_UPDATED and UPDATE()

### UPDATE(column) predicate

Simple boolean — true if the column *was included in the SET clause* of an UPDATE, regardless of whether the value actually changed:

```sql
-- Fire only if specific columns were targeted
IF UPDATE(UnitPrice) OR UPDATE(Quantity)
BEGIN
    -- handle price/quantity change
END
```

> [!WARNING]
> `UPDATE(col)` returns `1` for INSERT statements for every column. It is only meaningful for detecting which columns were SET in an UPDATE.

### COLUMNS_UPDATED() bitmask

Returns a `varbinary` bitmask representing all columns included in the SET clause. Column ordinal positions are 1-based within each byte (8 columns per byte).

```sql
-- Check if column 3 (3rd column in the table) was updated
IF (COLUMNS_UPDATED() & POWER(2, 3-1)) > 0
BEGIN
    PRINT 'Column 3 was updated';
END
```

**Practical guidance:** `UPDATE(col)` is cleaner for individual columns. `COLUMNS_UPDATED()` is useful when you need to check many columns efficiently in a loop or bitmask comparison. For wide tables, use `sys.columns` to find `column_id` values.

```sql
-- Dynamic COLUMNS_UPDATED check for auditing multiple columns
DECLARE @ColMask varbinary(128) = COLUMNS_UPDATED();
DECLARE @AuditCols TABLE (ColName sysname, ColId int);

INSERT @AuditCols
SELECT c.name, c.column_id
FROM   sys.columns c
WHERE  c.object_id = OBJECT_ID('dbo.Orders')
  AND  c.name IN ('Status', 'TotalAmount', 'ShippedDate');

SELECT ColName
FROM   @AuditCols
WHERE  (CAST(SUBSTRING(@ColMask, (ColId - 1) / 8 + 1, 1) AS int)
       & POWER(2, (ColId - 1) % 8)) > 0;
```

---

## Set-Based Logic Inside Triggers

**Critical rule:** Triggers fire **once per DML statement**, not once per row. A trigger that assumes a single row will silently produce wrong results during batch DML.

```sql
-- BAD: assumes single row — fails silently on multi-row INSERT
CREATE TRIGGER dbo.trg_Orders_Bad ON dbo.Orders AFTER INSERT AS
BEGIN
    DECLARE @OrderId int = (SELECT OrderId FROM inserted);  -- Error if >1 row!
    EXEC dbo.sp_ProcessNewOrder @OrderId;
END;

-- GOOD: iterate if you must call a proc per row, or handle set-based
CREATE OR ALTER TRIGGER dbo.trg_Orders_Good ON dbo.Orders AFTER INSERT AS
BEGIN
    SET NOCOUNT ON;
    -- Option A: set-based INSERT directly
    INSERT INTO dbo.OrderQueue (OrderId, QueuedAt)
    SELECT OrderId, SYSUTCDATETIME()
    FROM   inserted;

    -- Option B: cursor for per-row proc calls (only when unavoidable)
    DECLARE @OrderId int;
    DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
        SELECT OrderId FROM inserted;
    OPEN cur;
    FETCH NEXT FROM cur INTO @OrderId;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC dbo.sp_ProcessNewOrder @OrderId;
        FETCH NEXT FROM cur INTO @OrderId;
    END;
    CLOSE cur;
    DEALLOCATE cur;
END;
GO
```

Prefer set-based logic in every trigger. Use cursor iteration only when calling a stored procedure per-row is genuinely unavoidable (and reconsider that design).

---

## Trigger Execution Order (sp_settriggerorder)

When a table has multiple AFTER triggers for the same event, you can pin the **first** and **last** trigger:

```sql
-- Set trg_Orders_AuditFirst to fire first on INSERT
EXEC sp_settriggerorder
    @triggername = 'dbo.trg_Orders_AuditFirst',
    @order = 'First',
    @stmttype = 'INSERT';

-- Set trg_Orders_NotifyLast to fire last on INSERT
EXEC sp_settriggerorder
    @triggername = 'dbo.trg_Orders_NotifyLast',
    @order = 'Last',
    @stmttype = 'INSERT';
```

Triggers not pinned fire in an **undefined order** between first and last. There is **no way** to control the middle triggers' order — if order matters for more than two triggers, consolidate them into one.

Valid `@stmttype` values: `'INSERT'`, `'UPDATE'`, `'DELETE'`.

---

## Nested and Recursive Triggers

### Nested triggers

When a trigger performs DML, that DML can fire another trigger (nested trigger). Nesting depth limit is **32 levels** — exceeding it causes an error and the transaction rolls back.

```sql
-- Check current nested triggers setting
SELECT value_in_use
FROM   sys.configurations
WHERE  name = 'nested triggers';

-- Disable nested triggers (server-level, affects all databases)
EXEC sp_configure 'nested triggers', 0;
RECONFIGURE;
```

> [!WARNING]
> Disabling nested triggers is a server-level setting. It affects all databases on the instance. Consider whether you actually need to disable it or whether trigger design is the real problem.

### Recursive triggers

A trigger can fire itself (direct recursion) if the DML inside the trigger modifies the same table. This is controlled per-database:

```sql
-- Check setting
SELECT is_recursive_triggers_on
FROM   sys.databases
WHERE  name = DB_NAME();

-- Enable recursive triggers for current database
ALTER DATABASE CURRENT SET RECURSIVE_TRIGGERS ON;

-- Disable (default)
ALTER DATABASE CURRENT SET RECURSIVE_TRIGGERS OFF;
```

Even with `RECURSIVE_TRIGGERS OFF`, a trigger can still fire *indirectly* (A → B → A) if nested triggers are enabled. The 32-level depth limit stops infinite recursion in both cases.

---

## DDL Triggers

DDL triggers fire on data definition events (CREATE, ALTER, DROP, GRANT, DENY, REVOKE, etc.). They are scoped to a database or the entire server.

### Database-scoped DDL trigger

```sql
-- Log all CREATE and DROP TABLE events
CREATE OR ALTER TRIGGER trg_DDL_TableChanges
ON DATABASE
FOR CREATE_TABLE, DROP_TABLE, ALTER_TABLE
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @EventData xml = EVENTDATA();

    INSERT INTO dbo.DDLAudit (EventType, ObjectName, ObjectType, SqlText, LoginName, EventTime)
    VALUES (
        @EventData.value('(/EVENT_INSTANCE/EventType)[1]',      'nvarchar(100)'),
        @EventData.value('(/EVENT_INSTANCE/ObjectName)[1]',     'nvarchar(256)'),
        @EventData.value('(/EVENT_INSTANCE/ObjectType)[1]',     'nvarchar(100)'),
        @EventData.value('(/EVENT_INSTANCE/TSQLCommand)[1]',    'nvarchar(max)'),
        @EventData.value('(/EVENT_INSTANCE/LoginName)[1]',      'nvarchar(256)'),
        SYSUTCDATETIME()
    );
END;
GO
```

### Server-scoped DDL trigger

```sql
-- Prevent dropping any database (server-level)
CREATE OR ALTER TRIGGER trg_Server_PreventDropDatabase
ON ALL SERVER
FOR DROP_DATABASE
AS
BEGIN
    PRINT 'DROP DATABASE is not permitted through this trigger.';
    ROLLBACK;
END;
GO

-- Drop a server-scoped DDL trigger
DROP TRIGGER trg_Server_PreventDropDatabase ON ALL SERVER;
```

### Common DDL event groups

| Event Group | Includes |
|-------------|----------|
| `DDL_TABLE_EVENTS` | CREATE_TABLE, ALTER_TABLE, DROP_TABLE |
| `DDL_VIEW_EVENTS` | CREATE_VIEW, ALTER_VIEW, DROP_VIEW |
| `DDL_INDEX_EVENTS` | CREATE_INDEX, ALTER_INDEX, DROP_INDEX |
| `DDL_PROCEDURE_EVENTS` | CREATE_PROCEDURE, ALTER_PROCEDURE, DROP_PROCEDURE |
| `DDL_DATABASE_LEVEL_EVENTS` | All database-scoped DDL events |
| `DDL_SERVER_LEVEL_EVENTS` | All server-scoped DDL events |

Using event groups instead of individual events is more resilient to new event types being added in future versions.

---

## Logon Triggers

Logon triggers fire after a user authenticates but before the session is established. They can block connections.

```sql
-- Restrict logins outside business hours for a specific login
CREATE OR ALTER TRIGGER trg_Logon_BusinessHoursOnly
ON ALL SERVER
FOR LOGON
AS
BEGIN
    IF ORIGINAL_LOGIN() = 'ReportUser'
       AND (DATEPART(HOUR, GETDATE()) < 8 OR DATEPART(HOUR, GETDATE()) >= 20)
    BEGIN
        PRINT 'Login not permitted outside business hours (08:00–20:00).';
        ROLLBACK;
    END;
END;
GO
```

> [!WARNING] Logon Trigger Risk
> A buggy logon trigger can **lock everyone out of the instance**, including sysadmin. Always test logon triggers in a non-production environment first. If you get locked out:
> 1. Start SQL Server in single-user mode (`sqlservr.exe -m`)
> 2. Connect with a DAC: `sqlcmd -A -S .` (dedicated admin connection)
> 3. Drop or disable the trigger: `DISABLE TRIGGER trg_Logon_BusinessHoursOnly ON ALL SERVER;`

The DAC (Dedicated Administrator Connection) is always available even when logon triggers prevent normal connections. It allows one sysadmin connection via port 1434 (or `ADMIN:servername`).

---

## EVENTDATA() Function

`EVENTDATA()` is available inside DDL triggers and logon triggers to return an XML document describing the event.

```sql
-- Full EVENTDATA() XML structure for a DDL event
DECLARE @xml xml = EVENTDATA();

-- Common XPath extractions
SELECT
    @xml.value('(/EVENT_INSTANCE/EventType)[1]',        'nvarchar(100)')  AS EventType,
    @xml.value('(/EVENT_INSTANCE/PostTime)[1]',         'datetime2')       AS PostTime,
    @xml.value('(/EVENT_INSTANCE/SPID)[1]',             'int')             AS SPID,
    @xml.value('(/EVENT_INSTANCE/ServerName)[1]',       'nvarchar(256)')   AS ServerName,
    @xml.value('(/EVENT_INSTANCE/LoginName)[1]',        'nvarchar(256)')   AS LoginName,
    @xml.value('(/EVENT_INSTANCE/UserName)[1]',         'nvarchar(256)')   AS UserName,
    @xml.value('(/EVENT_INSTANCE/DatabaseName)[1]',     'nvarchar(256)')   AS DatabaseName,
    @xml.value('(/EVENT_INSTANCE/SchemaName)[1]',       'nvarchar(256)')   AS SchemaName,
    @xml.value('(/EVENT_INSTANCE/ObjectName)[1]',       'nvarchar(256)')   AS ObjectName,
    @xml.value('(/EVENT_INSTANCE/ObjectType)[1]',       'nvarchar(100)')   AS ObjectType,
    @xml.value('(/EVENT_INSTANCE/TSQLCommand)[1]',      'nvarchar(max)')   AS TSQLCommand;
```

`EVENTDATA()` returns `NULL` in DML triggers (not available there). Use `inserted`/`deleted` for DML trigger context.

---

## Trigger and Transaction Interaction

A DML trigger fires within the same transaction as the triggering statement. Rolling back inside a trigger rolls back **the entire statement and transaction** including all work done before the trigger fired.

```sql
-- Trigger that conditionally aborts the INSERT
CREATE OR ALTER TRIGGER dbo.trg_Orders_Validate
ON dbo.Orders
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    -- Abort if any inserted row violates a business rule
    IF EXISTS (
        SELECT 1 FROM inserted
        WHERE  TotalAmount <= 0
    )
    BEGIN
        RAISERROR('Order total must be positive.', 16, 1);
        ROLLBACK TRANSACTION;
        RETURN;
    END;
END;
GO
```

When `ROLLBACK TRANSACTION` is issued inside a trigger:
- The triggering statement is rolled back
- Any explicit outer transaction is also rolled back
- `@@TRANCOUNT` is set to 0
- Control returns to the caller with error 3609 ("The transaction ended in the trigger. The batch has been aborted.")

> [!WARNING] XACT_ABORT and Triggers
> If `SET XACT_ABORT ON` is active and the trigger raises an error (even without explicit ROLLBACK), the entire transaction is rolled back. Callers must be prepared for transaction state changes initiated inside triggers.

### ROLLBACK vs returning error without ROLLBACK

Option 1 — ROLLBACK inside trigger (rolls back entire outer transaction):
```sql
ROLLBACK TRANSACTION;
RETURN;
```

Option 2 — THROW inside trigger (raises error, rolls back if caller has XACT_ABORT ON):
```sql
THROW 50001, 'Validation failed.', 1;
```

Option 3 — INSTEAD OF trigger (never executes the DML, no rollback needed):
```sql
-- Simply don't execute the INSERT; raise an informational error
THROW 50001, 'Insert not permitted: reason.', 1;
```

Prefer INSTEAD OF when you want to validate before writing — the AFTER+ROLLBACK pattern is an after-the-fact correction with more overhead and more surprising semantics for callers.

---

## Common Patterns

### Audit trail trigger

```sql
CREATE TABLE dbo.AuditLog (
    AuditId     bigint IDENTITY PRIMARY KEY,
    TableName   nvarchar(128) NOT NULL,
    Action      char(1)       NOT NULL,   -- 'I', 'U', 'D'
    PrimaryKey  nvarchar(256) NOT NULL,
    OldValues   nvarchar(max) NULL,       -- JSON
    NewValues   nvarchar(max) NULL,       -- JSON
    ChangedBy   nvarchar(256) NOT NULL,
    ChangedAt   datetime2     NOT NULL
);

CREATE OR ALTER TRIGGER dbo.trg_Customers_Audit
ON dbo.Customers
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.AuditLog (TableName, Action, PrimaryKey, OldValues, NewValues, ChangedBy, ChangedAt)
    SELECT
        'dbo.Customers',
        CASE
            WHEN i.CustomerId IS NOT NULL AND d.CustomerId IS NOT NULL THEN 'U'
            WHEN i.CustomerId IS NOT NULL THEN 'I'
            ELSE 'D'
        END,
        CAST(COALESCE(i.CustomerId, d.CustomerId) AS nvarchar(256)),
        (SELECT d.Name, d.Email, d.Phone FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
        (SELECT i.Name, i.Email, i.Phone FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
        SYSTEM_USER,
        SYSUTCDATETIME()
    FROM inserted i
    FULL OUTER JOIN deleted d ON i.CustomerId = d.CustomerId;
END;
GO
```

### Enforcing a "exactly one active" constraint

```sql
-- Only one row may have IsDefault = 1 per CustomerId
CREATE OR ALTER TRIGGER dbo.trg_Addresses_EnforceDefault
ON dbo.Addresses
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM inserted WHERE IsDefault = 1)
        RETURN;  -- No default change in this batch

    -- Clear IsDefault on all other addresses for affected customers
    UPDATE a
    SET    a.IsDefault = 0
    FROM   dbo.Addresses a
    JOIN   inserted      i ON a.CustomerId = i.CustomerId
    WHERE  a.AddressId <> i.AddressId
      AND  a.IsDefault  = 1;
END;
GO
```

### DDL protection trigger

```sql
-- Prevent DROP TABLE on any table with "Protected" in the name
CREATE OR ALTER TRIGGER trg_PreventDropProtectedTable
ON DATABASE
FOR DROP_TABLE
AS
BEGIN
    DECLARE @ObjectName nvarchar(256) =
        EVENTDATA().value('(/EVENT_INSTANCE/ObjectName)[1]', 'nvarchar(256)');

    IF @ObjectName LIKE '%Protected%'
    BEGIN
        RAISERROR('Cannot drop protected tables.', 16, 1);
        ROLLBACK;
    END;
END;
GO
```

### Soft-delete enforcement via INSTEAD OF

```sql
-- Convert DELETE to soft-delete (IsDeleted = 1)
CREATE OR ALTER TRIGGER dbo.trg_Orders_SoftDelete
ON dbo.Orders
INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE o
    SET    o.IsDeleted  = 1,
           o.DeletedAt  = SYSUTCDATETIME(),
           o.DeletedBy  = SYSTEM_USER
    FROM   dbo.Orders o
    JOIN   deleted    d ON o.OrderId = d.OrderId;
END;
GO
```

---

## Anti-Patterns

### Single-row assumption

```sql
-- WRONG: scalar SELECT from inserted assumes 1 row
DECLARE @Id int = (SELECT Id FROM inserted);  -- Fails on multi-row DML
```

Fix: always treat `inserted`/`deleted` as multi-row tables and use JOIN or set-based logic.

### Calling stored procedures per-row from a trigger

Each `EXEC` inside a trigger is a round-trip. 10,000 rows = 10,000 `EXEC` calls. Trigger fires synchronously — the caller waits for all of them.

Fix: batch the work into a queue table (INSERT all rows, then process asynchronously via Service Broker or SQL Agent), or convert the proc logic to set-based T-SQL inside the trigger.

### SELECT inside a trigger (returning result sets)

Triggers must not return result sets — any `SELECT` that produces rows goes to the caller as an extra result set. This breaks ORMs and ADO.NET clients that don't expect it.

```sql
-- Enable the "no result sets from triggers" option (database-scoped)
-- SQL Server 2012+: disallow_results_from_triggers
-- This is a best practice for all databases
EXEC sp_configure 'disallow_results_from_triggers', 1;
RECONFIGURE;
```

Always use `SET NOCOUNT ON` at the start of every trigger to suppress `@@ROWCOUNT` messages.

### Trigger updating the same table without a guard

```sql
-- Can cause infinite recursion if RECURSIVE_TRIGGERS is ON
CREATE TRIGGER dbo.trg_T ON dbo.T AFTER UPDATE AS
BEGIN
    UPDATE dbo.T SET LastModified = GETDATE() WHERE Id IN (SELECT Id FROM inserted);
    -- This UPDATE fires the trigger again!
END;
```

Fix: use a guard condition, or better — use a computed column or default for LastModified.

### Trigger-driven business logic hiding

Triggers are invisible to developers reading application code. Business logic in triggers leads to:
- Silent behavior during bulk loads (triggers can be disabled)
- Unexpected transaction rollbacks propagating to callers
- Hard-to-test code paths
- Performance regression during bulk DML that wasn't trigger-tested

Document all triggers prominently. Consider whether the logic belongs in the application or an explicit stored procedure.

---

## Metadata Queries

### List all DML triggers

```sql
SELECT
    t.name          AS TriggerName,
    OBJECT_SCHEMA_NAME(t.parent_id) + '.' + OBJECT_NAME(t.parent_id) AS ParentObject,
    t.type_desc,
    t.is_disabled,
    t.is_instead_of_trigger,
    t.is_not_for_replication,
    STRING_AGG(te.type_desc, ', ') WITHIN GROUP (ORDER BY te.type_desc) AS Events
FROM sys.triggers       t
JOIN sys.trigger_events te ON te.object_id = t.object_id
WHERE t.parent_class = 1  -- object-level triggers (vs 0 = database)
GROUP BY t.name, t.parent_id, t.type_desc, t.is_disabled,
         t.is_instead_of_trigger, t.is_not_for_replication
ORDER BY OBJECT_NAME(t.parent_id), t.name;
```

### List DDL and logon triggers

```sql
-- Database-scoped DDL triggers
SELECT name, type_desc, is_disabled, parent_class_desc
FROM   sys.triggers
WHERE  parent_class = 0  -- database level
ORDER  BY name;

-- Server-scoped DDL and logon triggers
SELECT name, type_desc, is_disabled, parent_class_desc
FROM   sys.server_triggers
ORDER  BY name;
```

### Trigger definition

```sql
-- Option 1: OBJECT_DEFINITION
SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_Orders_Audit'));

-- Option 2: sys.sql_modules
SELECT definition
FROM   sys.sql_modules
WHERE  object_id = OBJECT_ID('dbo.trg_Orders_Audit');

-- Option 3: sp_helptext
EXEC sp_helptext 'dbo.trg_Orders_Audit';
```

### Trigger execution order

```sql
-- View sp_settriggerorder assignments
SELECT
    t.name         AS TriggerName,
    OBJECT_NAME(t.parent_id) AS TableName,
    te.type_desc   AS EventType,
    t.is_first,
    t.is_last
FROM sys.triggers       t
JOIN sys.trigger_events te ON te.object_id = t.object_id
WHERE t.is_first = 1 OR t.is_last = 1;
```

### Tables with many triggers (smell check)

```sql
SELECT
    OBJECT_SCHEMA_NAME(parent_id) + '.' + OBJECT_NAME(parent_id) AS TableName,
    COUNT(*) AS TriggerCount
FROM   sys.triggers
WHERE  parent_class = 1
GROUP  BY parent_id
HAVING COUNT(*) > 2
ORDER  BY TriggerCount DESC;
```

---

## Gotchas

1. **Triggers fire once per statement, not per row.** A trigger that works in unit testing (single-row INSERT) can corrupt data silently during batch load. Always verify with a multi-row test.

2. **ROLLBACK inside a trigger kills the outer transaction.** Callers that catch `@@ERROR` but not the transaction state will leave an orphaned transaction. Always use `XACT_STATE()` in CATCH blocks.

3. **SET NOCOUNT ON is mandatory.** Without it, the row-count message from the trigger body propagates to the caller as an extra result set, breaking many clients.

4. **Triggers can be disabled.** Bulk loads often `DISABLE TRIGGER ALL ON dbo.T` to improve performance. If your trigger enforces a business rule, the rule is bypassed during those loads. Use constraints where possible instead.

5. **INSTEAD OF triggers on views don't support FK cascades.** You must manually cascade. Forgetting this causes silent orphan rows.

6. **`TEXT`/`NTEXT`/`IMAGE` are not available in `inserted`/`deleted`.** These legacy types require `TEXTPTR()` workaround. Use `(n)varchar(max)` / `varbinary(max)` in new designs.

7. **`UPDATE(col)` is TRUE for INSERT on every column.** Don't use it as an "only fire on UPDATE" guard — check `IF EXISTS (SELECT 1 FROM deleted)` to detect a true update.

8. **Logon trigger bugs can lock out all users.** Always have a recovery plan (single-user mode + DAC) before deploying logon triggers. Test in a non-production environment first.

9. **Trigger nesting depth limit is 32.** A trigger chain of A→B→C→...→32 raises an error and rolls back. Monitor `sys.dm_exec_trigger_stats` for deeply nested trigger chains.

10. **Triggers add overhead to every affected DML statement.** An AFTER INSERT trigger that inserts into an audit log doubles the write amplification for every INSERT. Measure trigger overhead under load before deploying to high-throughput tables.

11. **`FOR REPLICATION` disabling.** By default, triggers fire when a replication agent applies changes. Add `NOT FOR REPLICATION` to prevent the trigger from firing during replication, which prevents double-auditing or cascading side effects on subscribers.

12. **DDL triggers don't fire for system objects.** Creating or modifying system tables, temporary tables in `tempdb`, or objects in the `resource` database does not trigger DDL triggers.

---

## See Also

- [`06-stored-procedures.md`](06-stored-procedures.md) — parameter sniffing, EXECUTE AS
- [`14-error-handling.md`](14-error-handling.md) — XACT_ABORT, XACT_STATE, ROLLBACK in nested transactions
- [`17-temporal-tables.md`](17-temporal-tables.md) — prefer over audit triggers for history tracking
- [`37-change-tracking-cdc.md`](37-change-tracking-cdc.md) — prefer over triggers for change capture at scale
- [`38-auditing.md`](38-auditing.md) — SQL Server Audit for compliance (instead of trigger-based audit)
- [`19-json-xml.md`](19-json-xml.md) — FOR JSON in audit triggers

---

## Sources

[^1]: [CREATE TRIGGER (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-trigger-transact-sql) — full syntax reference for creating DML, DDL, and logon triggers
[^2]: [DML Triggers - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/triggers/dml-triggers) — overview of AFTER and INSTEAD OF DML trigger types, benefits over constraints, and related tasks
[^3]: [DDL Triggers - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/triggers/ddl-triggers) — DDL trigger scope, event types, event groups, and usage patterns
[^4]: [Logon triggers - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/triggers/logon-triggers) — logon trigger behavior, transaction management, and how to disable a runaway trigger
[^5]: [EVENTDATA (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/eventdata-transact-sql) — XML function available inside DDL and logon triggers to retrieve event metadata
[^6]: [COLUMNS_UPDATED (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/columns-updated-transact-sql) — varbinary bitmask function for testing which columns were inserted or updated inside a trigger
[^7]: [sp_settriggerorder (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-settriggerorder-transact-sql) — system stored procedure for pinning first and last AFTER trigger execution order

---
name: mssql-writing-guidelines
description: "Use when writing or reviewing MSSQL/T-SQL, creating stored procedures, designing table schemas, writing views, building migrations, defining custom types, or architecting a SQL Server application database. Also use when writing RAISERROR patterns, CHECK constraints with scalar functions, base/subtype table hierarchies, composite key designs, role-scoped views with row-level security, or idempotent DDL scripts. If you are touching MSSQL for an application database, use this skill. Not for PostgreSQL, MySQL, Oracle, or SQLite — patterns are SQL Server-specific."
---

# MSSQL Writing Guidelines


## When to Use

- Starting a new SQL Server application database from scratch
- Adding tables, views, procedures, or functions to an existing schema that follows this methodology
- Reviewing SQL for adherence to type safety, access control, or structural enforcement
- Writing migrations that must be idempotent and safe to rerun
- Designing table hierarchies (base/subtype, parent-child composite keys)
- Implementing background job queues backed by relational tables

**When NOT to use:** one-off ad-hoc queries, read-only reporting databases, or any non-SQL-Server engine (PostgreSQL, MySQL, Oracle, SQLite). Examples and syntax throughout are T-SQL — they will not run on other dialects without translation.

## The Two Access Rules

1. **All reads go through views.** Never SELECT directly from tables. Views filter by role, enforce row-level security, flatten joins, and evolve independently of tables.

2. **All mutations go through stored procedures.** No ad-hoc INSERT, UPDATE, or DELETE. Procedures validate inputs, manage transactions, check business rules, and return structured errors.

Tables become an implementation detail — restructure them freely as long as views and procedures maintain their contracts.

## Custom Type Systems

Never use bare built-in types (`VARCHAR`, `INT`, `DATETIME`, `BIT`) for columns. Define **named type aliases** that form a semantic layer across the schema:

    CREATE TYPE Email FROM VARCHAR(100) NOT NULL;
    CREATE TYPE ApiKey FROM VARCHAR(128) NOT NULL;
    CREATE TYPE AccountNo FROM INT NOT NULL;
    CREATE TYPE _Timestamp FROM DATETIME2 NOT NULL;
    CREATE TYPE _Bool FROM BIT NOT NULL;

Every column uses a named type — `Email` instead of `VARCHAR(100)`, `_Timestamp` instead of `DATETIME2`.

**NOT NULL by default.** Nullable only with an explicit business reason.

**Organize types by domain** and maintain a central manifest (YAML or similar) as the source of truth. Document a standard default for each type (`_Timestamp` → `SYSDATETIME()`, `_Bool` → `0`, `DbUserID` → `DATABASE_PRINCIPAL_ID()`) and apply as column-level `DEFAULT` constraints consistently.

## Transaction Hierarchy

Procedures are classified by their relationship to transactions, signaled by a suffix:

| Suffix | Role | Transaction Check |
|--------|------|-------------------|
| `_trx` | **Transaction owner** — opens and commits/rolls back its own transaction | Validates `@@TRANCOUNT = 0` (rejects if already inside a transaction) |
| `_utx` | **Transaction participant** — called inside a `_trx`'s transaction | Validates `@@TRANCOUNT > 0` (rejects if NOT inside a transaction) |
| `_ut` | **Utility** — no transaction requirement | No check |

A `_trx` refuses to run inside another transaction; a `_utx` refuses to run outside one. The suffix makes the contract visible in the name.

**Composition pattern:** a `_trx` opens the transaction, calls one or more `_utx` procedures for subtasks, then commits or rolls back the whole unit. The `_utx` procedures trust their caller to manage the boundary.

For complete procedure templates, read [Procedure Structure](references/procedure-structure.md).

## Functional Constraints

SQL's built-in constraints (FOREIGN KEY, CHECK, UNIQUE) are powerful but limited to a single table's data. **Functional constraints** extend this by using scalar functions inside CHECK constraints to enforce cross-table logic:

    -- Function that checks a fact about another table
    CREATE OR ALTER FUNCTION dbo.Account_IsType_fn (
        @AccountNo AccountNo,
        @ExpectedType _Type
    )
    RETURNS BIT AS BEGIN
        IF EXISTS (SELECT 1 FROM Account WHERE AccountNo = @AccountNo AND [Type] = @ExpectedType)
            RETURN 1;
        RETURN 0;
    END;

    -- CHECK constraint that calls the function
    CONSTRAINT SavingsAccount_IsAccountType
        CHECK (dbo.Account_IsType_fn(AccountNo, 'Savings') = 1)

This enforces at the schema level that a SavingsAccount row can only reference an Account with `Type = 'Savings'`. The database rejects invalid data.

**Use functional constraints for:**
- Type discriminator enforcement across base/subtype tables
- Cross-table existence validation
- Business rule enforcement that spans multiple tables
- State machine transition validation

## Base/Subtype Inheritance (Primary Key Inheritance)

When entities share common attributes but have specialized ones, use **primary key inheritance** instead of polymorphic columns. A base table holds shared attributes and a type discriminator. Each subtype table inherits the base table's PK as both its PK and FK, plus a functional constraint enforcing the type discriminator:

    -- Subtype: PK = FK to base + type check
    CREATE TABLE SavingsAccount (
        AccountNo AccountNo PRIMARY KEY,
        InterestRate GrowthRate NOT NULL,
        MinBalance _Money NOT NULL,

        CONSTRAINT SavingsAccount_Is_Account
            FOREIGN KEY(AccountNo) REFERENCES Account(AccountNo),

        CONSTRAINT SavingsAccount_IsAccountType
            CHECK (dbo.Account_IsType_fn(AccountNo, 'Savings') = 1)
    );

Primary key inheritance gives each subtype its own table with clean NOT NULL constraints. Foreign keys can reference either the base (any type) or the subtype (specific type).

For the full pattern — base table setup, IsType function, referencing base vs subtype, creating subtypes in procedures, and views over subtypes — read [Base/Subtype Inheritance](references/basetype-subtype.md).

## Hierarchical Composite Keys

Tables in a parent-child hierarchy use composite primary keys that grow wider as the hierarchy deepens. Each child inherits the full primary key of its parent and adds its own discriminator — making the key itself a path that encodes full lineage from root to leaf:

    Customer       (CustomerNo)
    Order          (CustomerNo, OrderNo)
    OrderLine      (CustomerNo, OrderNo, LineNo)
    OrderShipment  (CustomerNo, OrderNo, LineNo, ShipmentNo)

**Max-plus-one functions** replace IDENTITY columns. Each table gets a scalar function (`NextOrderNo_fn`, `NextLineNo_fn`) returning `ISNULL(MAX(col), 0) + 1` scoped to the parent key. Clustered composite keys group parent-child data contiguously on disk and produce human-readable paths.

For the full pattern — max-plus-one functions, temporal children, sibling tables, insert procedures, and disk locality — read [Hierarchical Composite Keys](references/hierarchical-keys.md).

## Constraint Names as Business Predicates

Constraints should read as **predicates** — natural-language statements about the relationship between two entities:

    CONSTRAINT Customer_Rents_Vehicle
        FOREIGN KEY (CustomerNo) REFERENCES Customer(CustomerNo)

    CONSTRAINT SavingsAccount_Is_Account
        FOREIGN KEY (AccountNo) REFERENCES Account(AccountNo)

    CONSTRAINT Customer_MustHave_ValidEmail
        CHECK (Email LIKE '%_@_%.__%')

    CONSTRAINT Customer_Email_IsUnique
        UNIQUE (Email)

`FK_Rental_Customer` describes the *mechanism*. `Customer_Rents_Vehicle` describes the *meaning*. When a constraint violation appears in an error log, the predicate name tells you exactly what business rule was violated.

## Role-Scoped Views

Views are prefixed with the role they serve, making permissions self-documenting:

    Manager_TeamReport_V     -- managers can see team reports
    Admin_AllCustomers_V     -- admins can see all customers
    Customer_MyOrders_V      -- customer sees their own orders
    Worker_PendingJobs_V     -- background worker sees pending jobs

**Row-level security** is baked into views that serve user-scoped data:

    WHERE
        -- Privileged system accounts bypass the filter
        USER_NAME() IN ('__sysadmin', 'dbo', '__worker')
        OR IS_ROLEMEMBER('db_securityadmin') = 1
        -- Everyone else: only rows they own or are assigned to
        OR OwnerID = USER_ID()

For view templates, read [View Patterns](references/view-patterns.md).

## Security Model

Application users are real database users — every authenticated user gets a SQL Server login and database user. This is what makes `USER_NAME()`, `USER_ID()`, and `IS_ROLEMEMBER()` work in views. Permissions go to **roles**, never directly to users or service accounts. Roles get `GRANT SELECT` on views and `GRANT EXECUTE` on procedures — never direct table access. A centralized manifest (YAML) provides a bird's-eye view of all users, roles, and permissions, compiled into SQL at deployment.

For the full security model — user creation, role membership, granular permissions, service accounts, and the centralized manifest pattern — read [Security & Permissions](references/security-permissions.md).

## Relational Queues

Tables that carry queue semantics alongside relational data. Queue columns (`Status`, `Step`, `AttemptNum`, `Response`, `Error`, `StartedAt`, `Duration`, `ScheduledFor`, `UpdatedAt`) track work lifecycle. Workers claim items via a `Next_` procedure (atomic SELECT-then-UPDATE with `READPAST` for concurrent consumers) and report results via a `Modify_` procedure (optimistic concurrency, state machine enforcement, step tracking).

For queue table shapes, state classification functions, the Next/Modify procedure patterns, and queues as base/subtypes — read [Relational Queues](references/relational-queues.md).

## Error Handling

Procedures only perform **deterministic, local operations** — they don't "try" to succeed. After every DML, check `@@ROWCOUNT` and `@@ERROR` immediately and GOTO an explicit exit label on failure. TRY-CATCH is reserved exclusively for non-deterministic operations (network calls). GOTO gives explicit, visible control flow — no hidden exception handling, no ambiguity about what gets rolled back.

Define a catalog of semantic error codes (50001–50014) registered via `sp_addmessage`, designed to be parsable by client applications. Each error names what went wrong so upstream code can match on the number and present meaningful feedback.

For the full error code catalog, DML checking patterns, and RAISERROR examples — read [Error Handling](references/error-handling.md).

## Idempotent Migrations

Every migration must be safe to run multiple times. This is enforced by wrapping DDL in **meta-function** existence checks:

    -- Only add the column if it doesn't exist
    IF dbo.ColumnExists_fn('Customer', 'IsVerified') = 0
        ALTER TABLE Customer ADD IsVerified _Bool NOT NULL DEFAULT 0;

Build a library of meta functions that query `sys.*` catalog views:
- Object existence: `TableExists_fn`, `ViewExists_fn`, `ProcedureExists_fn`, `ScalarFunctionExists_fn`, `TableFunctionExists_fn`, `TypeExists_fn`, `SchemaExists_fn`
- Column inspection: `ColumnExists_fn`, `ColumnDataType_fn`, `ColumnFullType_fn`, `ColumnIsNullable_fn`, `ColumnIsIdentity_fn`, `ColumnIsComputed_fn`
- Constraint existence: `ForeignKeyExists_fn`, `CheckConstraintExists_fn`, `DefaultConstraintExists_fn`, `UniqueConstraintExists_fn`, `PrimaryKeyExists_fn`
- Index inspection: `IndexExists_fn`, `IndexIsUnique_fn`, `IndexIsClustered_fn`, `IndexIncludesColumn_fn`, `GetIndexType_fn`
- Utilities: `GetDefaultConstraintName_fn` (for dropping auto-generated constraints)

**Validation workflow:** after writing a migration, verify before committing:

1. **Run once** — confirm no errors
2. **Verify objects exist** — `SELECT dbo.TableExists_fn('NewTable')`, `SELECT dbo.ColumnExists_fn('Customer', 'IsVerified')`
3. **Verify constraints** — `SELECT dbo.ForeignKeyExists_fn('Customer_Rents_Vehicle')`, `SELECT dbo.CheckConstraintExists_fn('SavingsAccount_IsAccountType')`
4. **Run again** — confirm idempotency (no errors on re-run, no duplicate objects)

For migration templates, read [Migration Patterns](references/migration-patterns.md).

## Naming Conventions

Everything is **PascalCase** — tables, columns, views, procedures, functions, constraints, types, parameters. Underscores appear only in suffixes and structural separators:

| Object | Pattern | Examples |
|--------|---------|----------|
| Tables | `EntityName` | `Account`, `Customer`, `OrderLine` |
| Views | `Role_Intent_V` | `Manager_TeamReport_V`, `Admin_AllCustomers_V` |
| Procedures | `Verb_Domain_{trx,utx,ut}` | `Add_OrderLine_trx`, `FindCustomer_ut` |
| Functions | `Descriptive_fn` | `Account_IsType_fn`, `NextOrderNo_fn` |
| Constraints | `Subject_Relationship_Object` | `Customer_Rents_Vehicle`, `SavingsAccount_Is_Account` |

**Never use SQL keywords as verbs** — use `Add`/`Modify`/`Remove`/`Find` instead of `Create`/`Update`/`Delete`/`Select`. **Prefer AddOrModify** with MERGE over separate Add and Modify procedures (see [Procedure Structure](references/procedure-structure.md)). **Avoid abbreviations** unless universally understood (`No` for Number, `ID` for external identifiers).

For the complete naming guide — columns, parameters, types, indexes, abbreviation rules, and all naming patterns by object type — read [Naming Conventions](references/naming-conventions.md).

## Reference Tables

When creating a reference (lookup) table, immediately seed it with all known values in the same DDL script. Reference tables define the valid universe of values for a type discriminator or classifier — if those values are known at design time, they belong in the schema definition, not deferred to application code or a later migration:

    CREATE TABLE AccountType (
        [Type] _Type PRIMARY KEY
    );

    INSERT INTO AccountType([Type]) VALUES
        ('Savings'),
        ('Checking'),
        ('MoneyMarket'),
        ('CertificateOfDeposit');

This ensures that foreign key constraints referencing the table are immediately enforceable. A subtype table with `CONSTRAINT Account_IsClassifiedBy_AccountType FOREIGN KEY([Type]) REFERENCES AccountType([Type])` won't accept any inserts until the reference data exists. Seeding inline eliminates that gap.

## Application Settings

A centralized `AppSettings` table for runtime configuration (retry limits, feature flags, endpoints, batch sizes):

    CREATE TABLE AppSettings (
        Param Name PRIMARY KEY,
        ValBool _Bool DEFAULT 0,
        ValInt _Int DEFAULT 0,
        ValFloat FLOAT DEFAULT 0,
        ValStr Description DEFAULT ''
    );

Rows use dot-separated namespaces (`notification.maxAttempts`, `smtp.host`). Procedures read from the typed column wrapped in `COALESCE` with a sane default.

For the full pattern — read [Application Settings](references/application-settings.md).

## Normal Form Violations

Normal Forms are the standards a correctly designed schema must meet. Violations produce Update Anomalies, data duplication, broken join paths, and constraints that live only in application code.

For each violation: what it looks like in SQL Server, why it's wrong, and the fix pattern — read [Normal Form Violations](references/normal-form-violations.md).

The most damaging violation in practice is the **Relational Breach**: a child table with an `IDENTITY` surrogate Primary Key instead of a composite key that includes the parent's PK. Every table that does this severs itself from its ancestry — joins that should be direct require traversing every intermediate table. For the theoretical foundation behind all Normal Forms, see `relational-db-design`.

## Query Patterns

Write SARGable WHERE clauses — never wrap a column in a function (`WHERE YEAR(OrderDate) = 2025` forces a scan; `WHERE OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01'` allows a seek). Use `NOT EXISTS` instead of `NOT IN` for NULL safety. Prefer window functions (`SUM() OVER`, `ROW_NUMBER()`, `LAG`/`LEAD`) over self-joins. Use `CROSS APPLY VALUES` for unpivoting. For parameter sniffing, use `OPTION (OPTIMIZE FOR UNKNOWN)` — not the local variable copy trick.

For the full catalog — SARGability traps, window function patterns, CROSS APPLY techniques, batch operations, STRING_AGG, and parameter sniffing fixes — read [Query Patterns](references/query-patterns.md).

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using bare `VARCHAR`, `INT`, `DATETIME` for columns | Always use a named custom type — `Email`, `AccountNo`, `_Timestamp` |
| Wrapping deterministic DML in TRY-CATCH | Use GOTO with `@@ROWCOUNT`/`@@ERROR` checks after every DML |
| Naming constraints `FK_Table_OtherTable` | Use business predicates: `Customer_Rents_Vehicle` |
| Using IDENTITY for child table keys | Use max-plus-one functions scoped to the parent key |
| Forgetting to seed reference tables | INSERT known values immediately in the same DDL script |
| SELECT directly from tables in application code | All reads go through views; all mutations through procedures |
| Using `Create`, `Update`, `Delete` as procedure verbs | Use `Add`, `Modify`, `Remove` — avoid SQL keyword collisions |
| Nullable columns by default | Define custom types as NOT NULL; nullable only with explicit business reason |
| Hardcoding configuration in procedures | Read from `AppSettings` with `COALESCE` defaults |
| Polymorphic tables with nullable subtype columns | Use base/subtype with primary key inheritance |
| Wrapping columns in functions in WHERE clauses | Keep predicates SARGable — apply functions to parameters, not columns |
| Using `NOT IN` with a subquery | Use `NOT EXISTS` — `NOT IN` silently returns nothing if the subquery contains NULL |

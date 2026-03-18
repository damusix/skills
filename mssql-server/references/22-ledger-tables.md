# 22 — Ledger Tables

> [!NOTE] SQL Server 2022
> Ledger tables are a SQL Server 2022+ and Azure SQL Database feature. On-prem
> availability requires SQL Server 2022 or later.

## Table of Contents

1. [When to Use](#when-to-use)
2. [Concepts Overview](#concepts-overview)
3. [Append-Only Ledger Tables](#append-only-ledger-tables)
4. [Updatable Ledger Tables](#updatable-ledger-tables)
5. [Ledger View and History Table](#ledger-view-and-history-table)
6. [Database Ledger and Digests](#database-ledger-and-digests)
7. [Digest Storage](#digest-storage)
8. [Verification](#verification)
9. [Azure Confidential Ledger Integration](#azure-confidential-ledger-integration)
10. [Ledger vs Temporal Tables](#ledger-vs-temporal-tables)
11. [Metadata Queries](#metadata-queries)
12. [Altering Ledger Tables](#altering-ledger-tables)
13. [Gotchas](#gotchas)
14. [See Also](#see-also)
15. [Sources](#sources)

---

## When to Use

Use ledger tables when you need **cryptographically verifiable tamper evidence** — proof that data has not been altered by anyone, including DBAs, application owners, or security administrators.

**Good fits:**
- Financial audit trails (who paid what, when — provably unmodified)
- Regulatory compliance (SOX, HIPAA, PCI-DSS) requiring immutable audit logs
- Contracts or agreement records that must be provably unaltered
- High-trust multi-party environments where no single party should be fully trusted

**Not a substitute for:**
- Access control (use RLS and permissions — see `16-security-encryption.md`)
- Full change history for rollback (use temporal tables — see `17-temporal-tables.md`)
- General audit logging (use SQL Server Audit — see `38-auditing.md`)

**Key distinction from temporal tables:** Temporal tables record history for time-travel queries; ledger tables provide *cryptographic proof* that history has not been tampered with. They serve different purposes and can be combined.

---

## Concepts Overview

| Concept | Description |
|---------|-------------|
| **Append-only ledger table** | Rows can only be INSERTed, never UPDATEd or DELETEd; each row is part of the hash chain |
| **Updatable ledger table** | Normal DML is allowed; every change (insert/update/delete) is recorded in a separate history table |
| **Ledger view** | System-generated view that unions current + history rows, showing the full audit trail |
| **Database ledger** | Block-level hash chain over all ledger table transactions in the database |
| **Database digest** | A hash of the latest database ledger block — a small JSON value you store externally to anchor the chain |
| **Verification** | `sp_verify_database_ledger` re-computes hashes and compares against stored digests to detect tampering |
| **Azure Confidential Ledger (ACL)** | An Azure service that acts as an immutable, independently-auditable digest store |

The tamper-evidence guarantee works by hashing the block of each transaction that touches a ledger table. Each block references the hash of the prior block, forming a chain. If any row is altered after the fact, the hash chain breaks and verification fails.

---

## Append-Only Ledger Tables

Use when rows are **write-once** — inserts are allowed, no updates or deletes.

```sql
-- Create an append-only ledger table
CREATE TABLE dbo.Payments
(
    PaymentId    INT            IDENTITY(1,1) NOT NULL,
    AccountId    INT            NOT NULL,
    Amount       DECIMAL(18,4)  NOT NULL,
    PaymentDate  DATETIME2(7)   NOT NULL,
    Reference    NVARCHAR(100)  NULL,
    CONSTRAINT PK_Payments PRIMARY KEY (PaymentId)
)
WITH (LEDGER = ON (APPEND_ONLY = ON));
```

After creation, SQL Server adds two hidden system columns:

| Hidden column | Type | Purpose |
|---------------|------|---------|
| `ledger_start_transaction_id` | BIGINT | Transaction ID that inserted this row |
| `ledger_start_sequence_number` | BIGINT | Sequence within the transaction |

You cannot UPDATE or DELETE rows in an append-only table:

```sql
-- This will fail:
UPDATE dbo.Payments SET Amount = 0 WHERE PaymentId = 1;
-- Msg 37359: You cannot update rows in a ledger table 'dbo.Payments' that is
-- configured for append-only writes.
```

---

## Updatable Ledger Tables

Use when rows need normal DML but you want a tamper-evident audit trail of every change.

```sql
-- Create an updatable ledger table
-- SQL Server automatically creates: dbo.Payments_Ledger (history) and dbo.Ledger_Payments (view)
CREATE TABLE dbo.AccountBalances
(
    AccountId    INT            NOT NULL,
    Balance      DECIMAL(18,4)  NOT NULL,
    LastUpdated  DATETIME2(7)   NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_AccountBalances PRIMARY KEY (AccountId)
)
WITH (LEDGER = ON);
-- Equivalent: WITH (LEDGER = ON (APPEND_ONLY = OFF))
```

SQL Server automatically creates:
1. **Hidden columns** on the base table: `ledger_start_transaction_id`, `ledger_start_sequence_number`, `ledger_end_transaction_id`, `ledger_end_sequence_number`
2. **History table**: `dbo.AccountBalances_Ledger` (auto-named, or specify with `LEDGER_VIEW` / custom)
3. **Ledger view**: `dbo.Ledger_AccountBalances` (or custom name via `LEDGER_VIEW`)

### Specifying custom names

```sql
CREATE TABLE dbo.AccountBalances
(
    AccountId    INT           NOT NULL,
    Balance      DECIMAL(18,4) NOT NULL,
    CONSTRAINT PK_AccountBalances PRIMARY KEY (AccountId)
)
WITH (
    LEDGER = ON (
        APPEND_ONLY        = OFF,
        LEDGER_VIEW        = dbo.AccountBalancesLedgerView
            (
                TRANSACTION_ID_COLUMN_NAME     = TxnId,
                SEQUENCE_NUMBER_COLUMN_NAME    = SeqNo,
                OPERATION_TYPE_COLUMN_NAME     = OperationType,
                OPERATION_TYPE_DESC_COLUMN_NAME = OperationTypeDesc
            )
    )
);
```

### DML on updatable ledger tables

DML works normally from the application's perspective:

```sql
-- Normal insert
INSERT dbo.AccountBalances (AccountId, Balance) VALUES (1001, 1000.00);

-- Normal update — the old row is moved to history automatically
UPDATE dbo.AccountBalances SET Balance = 1250.00 WHERE AccountId = 1001;

-- Normal delete — the row is moved to history automatically
DELETE dbo.AccountBalances WHERE AccountId = 1001;
```

Behind the scenes, SQL Server records each operation type:
| Operation type (int) | Description |
|----------------------|-------------|
| 1 | INSERT |
| 2 | LAST KNOWN DELETE (row before delete) |
| 3 | UPDATE — before image (what the row was) |
| 4 | UPDATE — after image (what the row became) |

---

## Ledger View and History Table

The ledger view unions current + history rows, exposing the full audit trail:

```sql
-- Query the auto-generated ledger view (updatable table)
SELECT
    l.AccountId,
    l.Balance,
    l.OperationTypeDesc,
    l.TxnId,
    l.SeqNo,
    t.commit_time,
    t.principal_name
FROM dbo.AccountBalancesLedgerView l
JOIN sys.database_ledger_transactions t
    ON t.transaction_id = l.TxnId
ORDER BY t.commit_time, l.SeqNo;
```

`sys.database_ledger_transactions` records the principal (user) and commit time for every transaction that touched a ledger table.

For append-only tables, the ledger view exists too but only shows inserts:

```sql
-- Append-only: view is automatically named MSSQL_LedgerHistoryFor_<object_id>
-- or query the sys view directly:
SELECT * FROM sys.ledger_table_history
WHERE object_id = OBJECT_ID('dbo.Payments');
```

### History table structure (updatable tables)

The auto-created history table mirrors the base table columns and adds:

| Column | Type | Description |
|--------|------|-------------|
| `ledger_start_transaction_id` | BIGINT | Transaction that caused this row to be superseded |
| `ledger_start_sequence_number` | BIGINT | Sequence within the transaction |
| `ledger_end_transaction_id` | BIGINT | Transaction that ended this row's validity |
| `ledger_end_sequence_number` | BIGINT | Sequence within the ending transaction |

The history table has a clustered index on `(ledger_end_transaction_id, ledger_end_sequence_number)`.

> [!WARNING]
> **Do not directly INSERT, UPDATE, or DELETE the history table.** It is
> maintained exclusively by the SQL Server engine. Direct DML raises an error.

---

## Database Ledger and Digests

The *database ledger* is a separate system concept from ledger tables. Every transaction that modifies a ledger table produces a **block** in the database ledger. Each block contains:

- A hash of the transaction's row-level changes
- The previous block's hash (forming the chain)
- The transaction ID, timestamp, and principal

```sql
-- Query the database ledger blocks
SELECT
    block_id,
    hash,
    previous_block_hash,
    transaction_id,
    commit_time,
    principal_name,
    table_hashes        -- JSON array of per-table hashes in this block
FROM sys.database_ledger_blocks
ORDER BY block_id DESC;
```

A **database digest** is a compact JSON representation of the latest block's hash. Periodically exporting and storing this digest externally is what allows verification later:

```sql
-- Generate the current database digest
EXEC sp_generate_database_ledger_digest;
-- Returns a JSON result like:
-- {
--   "database_name": "MyDB",
--   "block_id": 42,
--   "hash": "0xABCD...",
--   "last_transaction_commit_time": "2026-03-17T04:00:00",
--   "digest_version": 1
-- }
```

The digest is just a hash — it is compact (a few hundred bytes) and can be stored anywhere outside the database: a file share, Azure Blob, Azure Confidential Ledger, a printed page.

---

## Digest Storage

| Storage option | Tamper-resistance level | Notes |
|----------------|------------------------|-------|
| **Azure Confidential Ledger** | Highest — blockchain-backed, independently auditable | Requires Azure; recommended for regulated industries |
| **Azure Blob Storage (immutable)** | High — WORM (write-once read-many) policy locks digests | Requires Azure; good middle ground |
| **Local/network file (manual export)** | Low — whoever controls the file system can modify it | Only use if files are escrow'd with a third party |
| **Database table in a different SQL instance** | Low-medium | Only as tamper-resistant as that instance's security |

### Auto-digest to Azure Blob (SQL Server 2022)

> [!NOTE] SQL Server 2022
> Automatic digest upload requires Azure Blob or Azure Confidential Ledger.

```sql
-- Configure automatic digest uploads every N seconds (minimum 60)
ALTER DATABASE [MyDB]
SET LEDGER_DIGEST_STORAGE_ENDPOINT = 'https://mystorageaccount.blob.core.windows.net/digests';
-- SQL Server will upload a digest JSON file after each new block is committed
```

```sql
-- Disable automatic digest storage
ALTER DATABASE [MyDB]
SET LEDGER_DIGEST_STORAGE_ENDPOINT = 'OFF';
```

### Manual digest workflow

```sql
-- Step 1: Generate digest (do this periodically — e.g., nightly, after each critical operation)
DECLARE @Digest NVARCHAR(MAX);
EXEC sp_generate_database_ledger_digest;
-- Capture the result and store externally

-- Step 2: At verification time, supply stored digests
-- See Verification section
```

---

## Verification

Verification re-hashes all ledger data and compares against stored digests to detect any tampering.

```sql
-- Verify using digests stored in Azure Blob
EXEC sp_verify_database_ledger
    @digests = N'[
      {"database_name":"MyDB","block_id":1,"hash":"0x...","last_transaction_commit_time":"...","digest_version":1},
      {"database_name":"MyDB","block_id":42,"hash":"0x...","last_transaction_commit_time":"...","digest_version":1}
    ]';
```

If verification succeeds:
```
Ledger verification successful.
```

If tampering is detected:
```
Ledger verification failed for table [dbo].[AccountBalances].
Block 17 hash mismatch. Expected: 0xABCD..., Computed: 0x1234...
```

### Verification scope

```sql
-- Verify only a specific table (faster for large databases)
EXEC sp_verify_database_ledger
    @digests = N'[...]',
    @table_name = N'dbo.AccountBalances';
```

### What verification can detect

- Any row inserted, updated, or deleted directly in the history table bypassing the engine
- Any row modified in the base table by bypassing the ledger machinery (e.g., DBCC PAGE tricks, file-level editing)
- Missing blocks or gaps in the hash chain

### What verification cannot detect

- Tampering that occurred *before* the first digest was generated (no anchor point)
- Rollback of legitimate transactions (these are not recorded as ledger rows)

> [!WARNING]
> Verification is only as trustworthy as your digest storage. If the digests
> can be tampered with alongside the database, the chain provides no guarantee.
> Use Azure Confidential Ledger or a separate custody chain for high-assurance
> environments.

---

## Azure Confidential Ledger Integration

Azure Confidential Ledger (ACL) is an Azure service backed by a blockchain running in Trusted Execution Environments (TEEs). It provides:

- **Append-only** — digests written to ACL cannot be modified or deleted
- **Independent auditability** — a third party can verify the ACL ledger without trusting Microsoft
- **Receipts** — each write returns a signed receipt that can be independently verified

```sql
-- Configure auto-digest to Azure Confidential Ledger (requires Azure RBAC setup)
ALTER DATABASE [MyDB]
SET LEDGER_DIGEST_STORAGE_ENDPOINT = 'https://myacl.confidential-ledger.azure.com';
```

The managed identity of the SQL Server instance (or Azure SQL logical server) must have the `Contributor` role on the ACL resource.

For on-prem SQL Server 2022 writing to ACL, outbound HTTPS (port 443) to the ACL endpoint must be permitted.

---

## Ledger vs Temporal Tables

| Feature | Ledger Tables | Temporal Tables |
|---------|--------------|-----------------|
| **Primary purpose** | Tamper-evidence / cryptographic proof | Time-travel queries / historical state |
| **Integrity guarantee** | Hash chain — detects post-hoc tampering | No cryptographic guarantee; history can be manipulated by a sysadmin |
| **Change history** | Yes (updatable ledger) | Yes |
| **Time-travel queries** | Via ledger view + `sys.database_ledger_transactions` | Via `FOR SYSTEM_TIME AS OF` |
| **DML restrictions** | Append-only: no UPDATE/DELETE; Updatable: none | No restrictions on current table |
| **History manipulation** | Blocked by design | Blocked but not cryptographically provable |
| **Retention policy** | None — history is permanent | HISTORY_RETENTION_PERIOD supported (2017+) |
| **Compliance** | Cryptographic tamper evidence | Audit trail without tamper evidence |
| **Can combine?** | Yes — create a temporal ledger table | Yes |

### Temporal + Ledger (combined)

You can create a table that is both temporal and a ledger:

```sql
CREATE TABLE dbo.ContractAmounts
(
    ContractId   INT            NOT NULL,
    Amount       DECIMAL(18,4)  NOT NULL,
    ValidFrom    DATETIME2(7)   GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo      DATETIME2(7)   GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_ContractAmounts PRIMARY KEY (ContractId)
)
WITH (
    SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.ContractAmounts_History),
    LEDGER = ON
);
```

This gives you both time-travel query capability (`FOR SYSTEM_TIME AS OF`) and cryptographic tamper evidence (hash chain). The trade-off is increased storage and write overhead.

---

## Metadata Queries

### List all ledger tables in the database

```sql
SELECT
    SCHEMA_NAME(t.schema_id)  AS SchemaName,
    t.name                    AS TableName,
    t.ledger_type,
    t.ledger_type_desc,       -- 'APPEND_ONLY_LEDGER_TABLE' or 'UPDATABLE_LEDGER_TABLE'
    t.ledger_view_object_id,
    OBJECT_NAME(t.ledger_view_object_id) AS LedgerViewName,
    t.is_dropped_ledger_table
FROM sys.tables t
WHERE t.ledger_type <> 0
ORDER BY SchemaName, TableName;
```

### Find the history table for an updatable ledger table

```sql
SELECT
    SCHEMA_NAME(t.schema_id) AS BaseSchema,
    t.name                   AS BaseTable,
    SCHEMA_NAME(h.schema_id) AS HistorySchema,
    h.name                   AS HistoryTable
FROM sys.tables t
JOIN sys.tables h ON h.object_id = t.history_table_id
WHERE t.ledger_type = 2  -- UPDATABLE_LEDGER_TABLE
ORDER BY BaseTable;
```

### Current database digest

```sql
EXEC sp_generate_database_ledger_digest;
```

### Recent ledger transactions

```sql
SELECT TOP 20
    t.transaction_id,
    t.commit_time,
    t.principal_name,
    t.table_hashes   -- JSON: which tables were touched and their per-table hash
FROM sys.database_ledger_transactions t
ORDER BY t.commit_time DESC;
```

### Ledger blocks

```sql
SELECT TOP 10
    block_id,
    CONVERT(VARCHAR(64), hash, 1)          AS BlockHash,
    CONVERT(VARCHAR(64), previous_block_hash, 1) AS PreviousHash,
    commit_time
FROM sys.database_ledger_blocks
ORDER BY block_id DESC;
```

### Check if automatic digest upload is configured

```sql
SELECT
    name,
    ledger_digest_storage_endpoint
FROM sys.databases
WHERE name = DB_NAME();
```

---

## Altering Ledger Tables

### Adding columns

You can add nullable columns to ledger tables without disabling the ledger:

```sql
ALTER TABLE dbo.AccountBalances
ADD Notes NVARCHAR(500) NULL;
-- Allowed. NOT NULL columns require a DEFAULT and cannot be added to append-only tables
-- if the table already has rows (similar restriction to temporal tables).
```

### Renaming ledger system columns

The auto-named ledger view and history table can be renamed after creation, but do so with care — dependent queries will break.

### You cannot

- Convert a non-ledger table into a ledger table after creation
- Convert a ledger table into a non-ledger table
- Change from append-only to updatable after creation
- Drop individual columns that are part of the ledger structure

> [!WARNING]
> Ledger tables **cannot be dropped and recreated** without losing the hash
> chain continuity. `DROP TABLE` on a ledger table sets `is_dropped_ledger_table = 1`
> in `sys.tables` and moves the table to a "dropped ledger tables" tombstone state.
> The history is retained in the database ledger for verification purposes, but
> the data itself is no longer queryable.

### Dropping a ledger table

```sql
DROP TABLE dbo.AccountBalances;
-- The table is "soft-deleted" — sys.tables still shows it with is_dropped_ledger_table = 1
-- The ledger history for this table is retained for verification

-- To view dropped ledger tables:
SELECT name, ledger_type_desc, is_dropped_ledger_table
FROM sys.tables
WHERE is_dropped_ledger_table = 1;
```

---

## Gotchas

1. **No retroactive ledger protection.** You cannot convert an existing table to a ledger table. If you need tamper evidence for existing data, you must create a new ledger table and migrate data into it — which itself becomes an auditable INSERT event.

2. **Digests are meaningless without external custody.** A digest stored in the same database or on the same server as the data provides no tamper evidence — anyone who can modify the data can also modify the digest. External storage (ACL, immutable Blob, escrow) is mandatory for actual trust.

3. **Verification requires all historical digests.** You need every digest from block 0 through the latest to verify the full chain. If you skip digest generation for a period, you can only verify from the earliest available digest forward.

4. **sp_verify_database_ledger is expensive.** It re-hashes all ledger data since the earliest supplied digest. For large databases with many ledger transactions, plan for significant CPU/IO and run during off-peak hours.

5. **Append-only tables cannot be used for UPDATE/DELETE — ever.** There is no workaround, no `NOCHECK`, no admin override. Design your schema around this constraint before deploying.

6. **sysadmin/sa can bypass history table INSERT protection via `DBCC WRITEPAGE`.** The ledger hash chain detects this because it re-computes hashes from the page level. However, a determined attacker with physical file access and the ability to also modify the blockchain is outside the threat model. The ledger protects against *software-layer* tampering by privileged users.

7. **History table is named automatically.** The auto-generated name is `<TableName>_Ledger`. If you have a table called `Orders`, the history table becomes `Orders_Ledger`. This can conflict with existing table names. Use the explicit `LEDGER_VIEW` clause to control naming.

8. **Ledger tables are not compatible with TRUNCATE.** `TRUNCATE TABLE` raises an error on both append-only and updatable ledger tables.

9. **No cross-database ledger chain.** Each database has its own independent ledger. If you need cross-database tamper evidence, each database requires its own digest management.

10. **Azure SQL Database vs on-prem availability.** Ledger tables were available in Azure SQL Database before SQL Server 2022 on-prem. Some features (e.g., Azure Confidential Ledger auto-upload) require Azure. On-prem digest upload to Blob Storage requires network connectivity.

11. **Ledger view performance.** The ledger view unions the base table with the history table. For high-volume tables with years of history, querying the ledger view without appropriate WHERE predicates is expensive. Always filter by transaction ID range or time window.

12. **No DDL triggers on ledger metadata.** You cannot intercept the automatic creation of the history table or ledger view via DDL triggers. The objects are created atomically with the `CREATE TABLE ... WITH (LEDGER = ON)` statement.

---

## See Also

- [`17-temporal-tables.md`](17-temporal-tables.md) — system-versioned history for time-travel queries (no tamper evidence)
- [`16-security-encryption.md`](16-security-encryption.md) — RLS, TDE, Always Encrypted (access control, not tamper evidence)
- [`38-auditing.md`](38-auditing.md) — SQL Server Audit for compliance logging
- [`15-principals-permissions.md`](15-principals-permissions.md) — minimizing who can reach ledger tables in the first place
- [`51-2022-features.md`](51-2022-features.md) — ledger tables in the context of all SQL Server 2022 features

---

## Sources

[^1]: [Ledger overview - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-overview?view=sql-server-ver16) — overview of ledger feature, tamper-evidence concepts, and hash chain architecture
[^2]: [Append-only ledger tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-append-only-ledger-tables?view=sql-server-ver16) — schema, system columns, and ledger view for append-only tables
[^3]: [Updatable ledger tables - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-updatable-ledger-tables?view=sql-server-ver16) — schema, history table, ledger view, and operation types for updatable tables
[^4]: [sys.sp_verify_database_ledger (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sys-sp-verify-database-ledger-transact-sql?view=sql-server-ver16) — stored procedure reference for verifying database ledger integrity
[^5]: [sys.sp_generate_database_ledger_digest (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sys-sp-generate-database-ledger-digest-transact-sql?view=sql-server-ver16) — stored procedure reference for generating database ledger digests
[^6]: [Digest management - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-digest-management?view=sql-server-ver16) — automatic and manual digest generation, storage options, and restore considerations
[^7]: [sys.database_ledger_transactions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-database-ledger-transactions-transact-sql?view=sql-server-ver16) — catalog view reference for ledger transaction history
[^8]: [Azure Confidential Ledger overview](https://learn.microsoft.com/en-us/azure/confidential-ledger/overview) — immutable blockchain-backed data store for tamper-proof digest storage
[^9]: [Ledger considerations and limitations - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-limits?view=sql-server-ver16) — unsupported features, data types, schema change rules, and temporal table inherited limitations
[^10]: [SQL Server 2022 is now generally available](https://www.microsoft.com/en-us/sql-server/blog/2022/11/16/sql-server-2022-is-now-generally-available/) — Microsoft SQL Server Blog announcing SQL Server 2022 GA with ledger tables for tamper-evidence on-prem

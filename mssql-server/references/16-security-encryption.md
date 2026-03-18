# 16 — Security & Encryption

Row-Level Security, Dynamic Data Masking, Transparent Data Encryption, Always Encrypted, column-level encryption, certificates, and backup encryption.

---

## Table of Contents

1. [When to use](#1-when-to-use)
2. [Row-Level Security (RLS)](#2-row-level-security-rls)
3. [Dynamic Data Masking (DDM)](#3-dynamic-data-masking-ddm)
4. [Transparent Data Encryption (TDE)](#4-transparent-data-encryption-tde)
5. [Always Encrypted](#5-always-encrypted)
6. [Column-Level Encryption (Symmetric Keys / ENCRYPTBYKEY)](#6-column-level-encryption-symmetric-keys--encryptbykey)
7. [Certificate-Based Encryption](#7-certificate-based-encryption)
8. [Backup Encryption](#8-backup-encryption)
9. [Key Management Hierarchy](#9-key-management-hierarchy)
10. [Encryption Algorithm Reference](#10-encryption-algorithm-reference)
11. [Column Master Key (CMK) Provider Comparison](#11-column-master-key-cmk-provider-comparison)
12. [CEK Creation and Binding Workflow](#12-cek-creation-and-binding-workflow)
13. [Key Rotation Strategies](#13-key-rotation-strategies)
14. [Metadata Queries](#14-metadata-queries)
15. [Gotchas / Anti-patterns](#15-gotchas--anti-patterns)
16. [See Also](#16-see-also)
17. [Sources](#17-sources)

---

## 1. When to use

| Scenario | Recommended feature |
|---|---|
| Restrict rows by user/tenant without changing app queries | Row-Level Security |
| Obfuscate sensitive columns for non-privileged users | Dynamic Data Masking |
| Encrypt data files at rest (transparent to app) | TDE |
| Prevent DBA/admin from reading plaintext column values | Always Encrypted |
| Encrypt specific columns; app manages keys | Symmetric key + ENCRYPTBYKEY |
| Sign modules, cross-DB trust, certificates for logins | Certificate-based encryption |
| Encrypt backup files at rest | BACKUP WITH ENCRYPTION |

> [!WARNING] DDM is not a true security boundary — privileged users (`CONTROL DATABASE`, `db_owner`, or UNMASK permission) can read unmasked data. Use TDE or Always Encrypted for actual at-rest protection.

---

## 2. Row-Level Security (RLS)

RLS uses inline table-valued functions as **security predicates** applied transparently to every access of a table.

### 2.1 Predicate types

| Type | Controls | Notes |
|---|---|---|
| Filter predicate | SELECT, UPDATE, DELETE visibility | Invisible rows silently excluded |
| Block predicate (AFTER INSERT) | INSERT | Prevents inserting rows outside user's scope |
| Block predicate (AFTER UPDATE) | UPDATE moving a row out of scope | |
| Block predicate (BEFORE UPDATE) | UPDATE on rows in scope | |
| Block predicate (BEFORE DELETE) | DELETE | |

### 2.2 Setup pattern

```sql
-- Step 1: Create the predicate function
CREATE FUNCTION Security.fn_TenantFilter(@TenantId INT)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
(
    SELECT 1 AS fn_result
    WHERE @TenantId = CAST(SESSION_CONTEXT(N'TenantId') AS INT)
       OR IS_MEMBER('db_owner') = 1
       OR IS_MEMBER('SecurityAdmin') = 1
);
GO

-- Step 2: Bind to the table
CREATE SECURITY POLICY TenantFilterPolicy
    ADD FILTER PREDICATE Security.fn_TenantFilter(TenantId) ON dbo.Orders,
    ADD BLOCK  PREDICATE Security.fn_TenantFilter(TenantId) ON dbo.Orders AFTER INSERT,
    ADD BLOCK  PREDICATE Security.fn_TenantFilter(TenantId) ON dbo.Orders AFTER UPDATE
WITH (STATE = ON, SCHEMABINDING = ON);
GO
```

### 2.3 Set tenant context (application login)

```sql
-- Set at connection start (ADO.NET, JDBC, etc.)
EXEC sp_set_session_context @key = N'TenantId', @value = 42, @read_only = 1;
-- @read_only = 1 prevents the app from overwriting it mid-session
```

### 2.4 Alter and drop

```sql
-- Disable without dropping
ALTER SECURITY POLICY TenantFilterPolicy WITH (STATE = OFF);

-- Add a predicate to an existing policy
ALTER SECURITY POLICY TenantFilterPolicy
    ADD FILTER PREDICATE Security.fn_TenantFilter(TenantId) ON dbo.OrderItems;

-- Drop
DROP SECURITY POLICY TenantFilterPolicy;
```

### 2.5 Performance

RLS predicates are inlined by the optimizer. Check execution plans — the predicate appears as an additional `Filter` operator or gets pushed into seeks. Ensure the filter column is indexed; RLS does not bypass index access paths.

> [!NOTE] SQL Server 2022
> RLS security policies now participate in **Query Store** plan forcing. Forced plans respect the predicate function.

### 2.6 RLS gotchas

- **`SCHEMABINDING` on the predicate function is required** for optimal performance (allows the optimizer to inline it). Without SCHEMABINDING, the function is called as a regular TVF.
- **Side-channel via error messages:** a block predicate raises error 33104. If the app leaks this to the user, they learn the row exists. Filter predicates are silent.
- **Views with `SCHEMABINDING` bypass RLS** if the view definition reads the table directly and the caller has view permissions. Always test with a low-privilege user.
- **Cross-database queries:** RLS predicates only apply to the database where they are defined. Linked server queries, OPENQUERY, or cross-database SELECT bypass the policy unless the target DB also has RLS.
- **`db_owner` / `CONTROL DATABASE` can always read all rows.** Design around this — use application roles or contained databases to limit DBA reach if the threat model requires it.
- **Indexing the predicate column:** without an index on the RLS filter column, every query becomes a full scan (the filter is applied post-scan).

---

## 3. Dynamic Data Masking (DDM)

DDM masks column values at query time for users without `UNMASK` (or `SELECT` on the column in older versions).

### 3.1 Mask functions

| Function | Syntax | Effect |
|---|---|---|
| `default()` | `MASKED WITH (FUNCTION = 'default()')` | Type-appropriate mask (0, `XXXX`, `01/01/1900`, `aXXX@XXXX.com`) |
| `partial(prefix, padding, suffix)` | `partial(1,"XXXXXXX",2)` | Shows first N and last M characters |
| `email()` | `email()` | `aXXX@XXXX.com` format |
| `random(low, high)` | `random(1,100)` | Random int in range; numeric only |

```sql
CREATE TABLE dbo.Customers (
    CustomerId   INT          PRIMARY KEY,
    Email        VARCHAR(200) MASKED WITH (FUNCTION = 'email()') NOT NULL,
    Phone        VARCHAR(20)  MASKED WITH (FUNCTION = 'partial(0,"XXX-XXX-",4)') NULL,
    CreditScore  INT          MASKED WITH (FUNCTION = 'random(300,850)') NULL,
    SSN          CHAR(11)     MASKED WITH (FUNCTION = 'partial(0,"XXX-XX-",4)') NULL
);

-- Add mask to existing column
ALTER TABLE dbo.Customers
    ALTER COLUMN CreditScore ADD MASKED WITH (FUNCTION = 'default()');

-- Drop mask
ALTER TABLE dbo.Customers
    ALTER COLUMN CreditScore DROP MASKED;
```

### 3.2 Grant UNMASK

```sql
-- Database-scoped UNMASK (2022+)
GRANT UNMASK ON dbo.Customers(SSN) TO SupportRole;

-- Grant column-level unmask (2022+)
GRANT UNMASK ON SCHEMA::dbo TO DataEngineer;
```

> [!NOTE] SQL Server 2022
> Granular `UNMASK` permission now scoped to schema, table, or column level [^1]. Before 2022, `UNMASK` was database-wide only.

### 3.3 Test masking

```sql
EXECUTE AS USER = 'LowPrivUser';
SELECT CustomerId, Email, SSN FROM dbo.Customers;
REVERT;
```

### 3.4 DDM limitations

- **NOT a substitute for encryption.** Anyone with `db_owner`, `CONTROL DATABASE`, or the explicit `UNMASK` permission sees plaintext. DBA access = plaintext access.
- **Masked values can be inferred** via `WHERE SSN = '123-45-6789'` — masking only affects the output columns, not predicates. Use RLS or application-level access control to prevent this.
- **Aggregate functions operate on real data.** `SELECT AVG(CreditScore)` returns the real average to masked users.
- **No masking in computed columns** — the computed column expression uses real data regardless.

---

## 4. Transparent Data Encryption (TDE)

TDE encrypts data files (`.mdf`, `.ndf`, `.ldf`) and backups at rest using a database encryption key (DEK). The app and SQL Server read/write plaintext — encryption is entirely transparent at the storage layer.

### 4.1 TDE architecture

```
Service Master Key (SMK)            ← protected by Windows DPAPI / machine key
  └── Database Master Key (DMK)     ← in master database
        └── Certificate (or AEK)    ← in master database
              └── Database Encryption Key (DEK) ← in user database
```

### 4.2 Enable TDE

```sql
-- Step 1: Create DMK in master (if not exists)
USE master;
CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'S3cur3P@ssw0rd!2024';
GO

-- Step 2: Create certificate to protect the DEK
CREATE CERTIFICATE TDE_Cert
    WITH SUBJECT = 'TDE Certificate for MyDatabase',
    EXPIRY_DATE = '2030-01-01';
GO

-- Step 3: Back up the certificate IMMEDIATELY
-- (cannot restore an encrypted database without it)
BACKUP CERTIFICATE TDE_Cert
    TO FILE = '/var/opt/mssql/backup/TDE_Cert.cer'
    WITH PRIVATE KEY (
        FILE = '/var/opt/mssql/backup/TDE_Cert_key.pvk',
        ENCRYPTION BY PASSWORD = 'CertBackupP@ss!'
    );
GO

-- Step 4: Create DEK in the user database
USE MyDatabase;
CREATE DATABASE ENCRYPTION KEY
    WITH ALGORITHM = AES_256
    ENCRYPTION BY SERVER CERTIFICATE TDE_Cert;
GO

-- Step 5: Enable encryption
ALTER DATABASE MyDatabase SET ENCRYPTION ON;
GO
```

### 4.3 Monitor encryption progress

```sql
-- Encryption state: 0=None, 1=Unencrypted, 2=Encrypting, 3=Encrypted,
--                   4=Key change in progress, 5=Decrypting
SELECT d.name,
       dek.encryption_state,
       dek.encryption_state_desc,
       dek.percent_complete,
       dek.key_algorithm,
       dek.key_length
FROM sys.databases d
JOIN sys.dm_database_encryption_keys dek ON d.database_id = dek.database_id;
```

### 4.4 Rotate the TDE certificate

```sql
-- Create new certificate
USE master;
CREATE CERTIFICATE TDE_Cert_2025
    WITH SUBJECT = 'TDE Certificate Rotation 2025';

-- Re-encrypt the DEK with the new certificate
USE MyDatabase;
ALTER DATABASE ENCRYPTION KEY
    REGENERATE WITH ALGORITHM = AES_256
    ENCRYPTION BY SERVER CERTIFICATE TDE_Cert_2025;
```

### 4.5 Disable TDE

```sql
ALTER DATABASE MyDatabase SET ENCRYPTION OFF;
-- Wait for decryption to complete (check percent_complete)
USE MyDatabase;
DROP DATABASE ENCRYPTION KEY;
```

### 4.6 TDE and backups

TDE-encrypted databases produce **encrypted backups automatically**. Restoring on another instance requires:
1. The certificate (`.cer`) and private key (`.pvk`) files
2. The private key password

```sql
-- Restore certificate on target instance
USE master;
CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'TargetDMKPass!';
CREATE CERTIFICATE TDE_Cert
    FROM FILE = '/var/opt/mssql/backup/TDE_Cert.cer'
    WITH PRIVATE KEY (
        FILE = '/var/opt/mssql/backup/TDE_Cert_key.pvk',
        DECRYPTION BY PASSWORD = 'CertBackupP@ss!'
    );
-- Now RESTORE DATABASE will succeed
```

> [!WARNING] Certificate backup is mandatory
> If you lose the TDE certificate and its backup, the database is **permanently unrecoverable**. Back up the certificate immediately after creation and after every rotation. Store the backup offline and separately from the database backup.

---

## 5. Always Encrypted

Always Encrypted (AE) ensures column values are **never in plaintext on the server** — encryption/decryption happens exclusively in the client driver. DBAs, cloud admins, and SQL Server itself cannot read the values.

### 5.1 Key hierarchy

```
Column Master Key (CMK)          ← stored outside SQL Server (cert store, Azure Key Vault, HSM)
  └── Column Encryption Key (CEK) ← encrypted copy stored in SQL Server
        └── Encrypted column value ← stored in table
```

### 5.2 Encryption types

| Type | Supports equality lookup? | Supports range/ORDER BY? | Notes |
|---|---|---|---|
| Deterministic | Yes | No (ordering leaks) | Same plaintext → same ciphertext |
| Randomized | No | No | Different ciphertext every time; more secure |

Use **deterministic** only when you need to filter (`WHERE`, `JOIN`) on the column.
Use **randomized** for everything else (especially sensitive free-text, SSN stored not queried).

### 5.3 Setup (certificate store CMK)

```sql
-- Step 1: Create CMK metadata (actual key lives in cert store / AKV)
CREATE COLUMN MASTER KEY CMK1
WITH (
    KEY_STORE_PROVIDER_NAME = N'MSSQL_CERTIFICATE_STORE',
    KEY_PATH = N'CurrentUser/My/BBF037EC4A133912893A2E7DC5C4D9D4F14ECBA3'
);
GO

-- Step 2: Create CEK (encrypted with CMK)
CREATE COLUMN ENCRYPTION KEY CEK1
WITH VALUES (
    COLUMN_MASTER_KEY = CMK1,
    ALGORITHM = 'RSA_OAEP',
    ENCRYPTED_VALUE = 0x016E000001630075007200720065006E...  -- generated by SSMS/PowerShell
);
GO

-- Step 3: Create encrypted columns
CREATE TABLE dbo.PatientData (
    PatientId   INT          PRIMARY KEY,
    SSN         CHAR(11)     COLLATE Latin1_General_BIN2
                             ENCRYPTED WITH (
                                 COLUMN_ENCRYPTION_KEY = CEK1,
                                 ENCRYPTION_TYPE = DETERMINISTIC,
                                 ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
                             ) NOT NULL,
    Diagnosis   VARCHAR(500) ENCRYPTED WITH (
                                 COLUMN_ENCRYPTION_KEY = CEK1,
                                 ENCRYPTION_TYPE = RANDOMIZED,
                                 ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
                             ) NULL
);
```

### 5.4 Always Encrypted with Secure Enclaves (2019+)

> [!NOTE] SQL Server 2019
> **Always Encrypted with Secure Enclaves** (VBS or SGX enclaves) allows the server to perform equality comparisons, range queries, and pattern matching inside a trusted execution environment — without exposing keys. Requires `Column Encryption Setting = Enabled; Enclave Attestation Url = ...` in the connection string.

### 5.5 Constraints and limitations

| Feature | Supported? |
|---|---|
| Deterministic columns in WHERE/JOIN | Yes (client re-encrypts param) |
| Range predicates (`>`, `<`, `BETWEEN`) on randomized | No |
| Range predicates on deterministic (without enclave) | No |
| Server-side string functions (`LEN`, `UPPER`, etc.) | No |
| Bulk copy with encrypted columns | With `AllowEncryptedValueModifications` |
| `LIKE` patterns | Only with enclave |
| Indexes on deterministic columns | Yes |
| Indexes on randomized columns | No (except enclave) |
| NULL | Allowed (stored as encrypted NULL) |
| Computed columns over encrypted cols | No |

> [!WARNING] Collation requirement
> Deterministic encryption requires `_BIN2` collation on character columns. The plaintext sort order must match binary sort order to avoid ciphertext-collation mismatches.

---

## 6. Column-Level Encryption (Symmetric Keys / ENCRYPTBYKEY)

Pre-AE approach using T-SQL functions. The key is managed by SQL Server; DBAs with appropriate permissions can decrypt. Use when Always Encrypted's client-side key requirement is impractical.

### 6.1 Setup and encrypt

```sql
USE MyDatabase;

-- Create DMK in user database
CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'DMKPass!2024';

-- Create certificate for symmetric key protection
CREATE CERTIFICATE ColumnEncryptCert
    WITH SUBJECT = 'Column Encryption Cert';

-- Create symmetric key
CREATE SYMMETRIC KEY ColEncKey
    WITH ALGORITHM = AES_256
    ENCRYPTION BY CERTIFICATE ColumnEncryptCert;

-- Encrypt a value (key must be open in session)
OPEN SYMMETRIC KEY ColEncKey
    DECRYPTION BY CERTIFICATE ColumnEncryptCert;

UPDATE dbo.Employees
SET SSN_Encrypted = ENCRYPTBYKEY(KEY_GUID('ColEncKey'), SSN_Plaintext);

CLOSE SYMMETRIC KEY ColEncKey;
```

### 6.2 Decrypt

```sql
OPEN SYMMETRIC KEY ColEncKey
    DECRYPTION BY CERTIFICATE ColumnEncryptCert;

SELECT EmployeeId,
       CONVERT(CHAR(11),
           DECRYPTBYKEY(SSN_Encrypted)) AS SSN
FROM dbo.Employees;

CLOSE SYMMETRIC KEY ColEncKey;
```

### 6.3 Column definition

```sql
ALTER TABLE dbo.Employees
    ADD SSN_Encrypted VARBINARY(256) NULL;
-- Store original as varbinary; ENCRYPTBYKEY returns varbinary(8000)
```

### 6.4 Authenticator (optional)

Pass an authenticator to bind the ciphertext to a specific row identifier, preventing ciphertext swapping attacks:

```sql
-- Encrypt with authenticator (EmployeeId binds the ciphertext)
ENCRYPTBYKEY(KEY_GUID('ColEncKey'), SSN_Plaintext, 1, CONVERT(VARBINARY, EmployeeId))

-- Decrypt: must pass matching authenticator or result is NULL
DECRYPTBYKEY(SSN_Encrypted, 1, CONVERT(VARBINARY, EmployeeId))
```

---

## 7. Certificate-Based Encryption

Certificates serve multiple roles in SQL Server beyond TDE:

### 7.1 Module signing (cross-database trust without TRUSTWORTHY)

```sql
-- Database A: create cert, sign the procedure
USE DatabaseA;
CREATE CERTIFICATE ModuleSignCert
    WITH SUBJECT = 'Signs procedures that access DatabaseB';

ADD SIGNATURE TO dbo.usp_CrossDbOperation
    BY CERTIFICATE ModuleSignCert;

-- Export cert (without private key — only the public key is needed)
BACKUP CERTIFICATE ModuleSignCert
    TO FILE = '/tmp/ModuleSignCert.cer';

-- Database B: import cert, create user from cert, grant permissions
USE DatabaseB;
CREATE CERTIFICATE ModuleSignCert
    FROM FILE = '/tmp/ModuleSignCert.cer';

CREATE USER CertUser FROM CERTIFICATE ModuleSignCert;
GRANT SELECT ON dbo.SensitiveTable TO CertUser;
```

The procedure in DatabaseA now has access to DatabaseB via the certificate user, without TRUSTWORTHY=ON and without exposing any login credentials.

### 7.2 Certificate-backed logins (for SQL Agent proxy / automation)

```sql
USE master;
CREATE CERTIFICATE AutomationCert
    WITH SUBJECT = 'Automation Login Cert',
    EXPIRY_DATE = '2030-01-01';

CREATE LOGIN AutomationLogin FROM CERTIFICATE AutomationCert;
GRANT VIEW SERVER STATE TO AutomationLogin;
```

### 7.3 Asymmetric key encryption

```sql
CREATE ASYMMETRIC KEY AsymKey1
    WITH ALGORITHM = RSA_2048;

-- Encrypt (public key)
SELECT ENCRYPTBYASYMKEY(ASYMKEY_ID('AsymKey1'), 'SecretData');

-- Decrypt (private key — requires password if key is password-protected)
SELECT CONVERT(VARCHAR(100), DECRYPTBYASYMKEY(ASYMKEY_ID('AsymKey1'), ciphertext));
```

---

## 8. Backup Encryption

Backup encryption protects backup files at rest independently of TDE. Can be used with or without TDE.

```sql
-- Requires a certificate or asymmetric key in master
USE master;
CREATE CERTIFICATE BackupCert
    WITH SUBJECT = 'Backup Encryption Certificate',
    EXPIRY_DATE = '2030-01-01';

BACKUP CERTIFICATE BackupCert
    TO FILE = '/var/opt/mssql/backup/BackupCert.cer'
    WITH PRIVATE KEY (
        FILE = '/var/opt/mssql/backup/BackupCert.pvk',
        ENCRYPTION BY PASSWORD = 'BackupCertPass!'
    );

-- Encrypted backup
BACKUP DATABASE MyDatabase
    TO DISK = '/var/opt/mssql/backup/MyDatabase_enc.bak'
    WITH ENCRYPTION (
        ALGORITHM = AES_256,
        SERVER CERTIFICATE = BackupCert
    ),
    COMPRESSION, STATS = 10;
```

> [!NOTE] SQL Server 2022
> `BACKUP TO URL` with S3-compatible storage supports backup encryption using the same `WITH ENCRYPTION` syntax [^2].

```sql
-- S3 backup with encryption (2022+)
BACKUP DATABASE MyDatabase
    TO URL = 's3://mybucket/MyDatabase.bak'
    WITH ENCRYPTION (ALGORITHM = AES_256, SERVER CERTIFICATE = BackupCert),
    CREDENTIAL = 'S3Credential';
```

---

## 9. Key Management Hierarchy

```
Windows DPAPI / Machine Key
  └── Service Master Key (SMK)          -- auto-created; protects DMK in master
        └── Database Master Key (DMK)   -- per-database; opened explicitly or auto by SMK
              ├── Certificates
              ├── Symmetric Keys
              └── Asymmetric Keys
                    └── Column Encryption Keys (CEKs)  -- Always Encrypted
```

### 9.1 Service Master Key management

```sql
-- Regenerate SMK (careful: requires all DMKs to be re-encrypted)
ALTER SERVICE MASTER KEY REGENERATE;

-- Back up SMK
BACKUP SERVICE MASTER KEY
    TO FILE = '/var/opt/mssql/backup/SMK.bak'
    ENCRYPTION BY PASSWORD = 'SMKBackupPass!';

-- Restore SMK
RESTORE SERVICE MASTER KEY
    FROM FILE = '/var/opt/mssql/backup/SMK.bak'
    DECRYPTION BY PASSWORD = 'SMKBackupPass!';
```

### 9.2 Database Master Key management

```sql
USE MyDatabase;
-- Back up DMK
BACKUP MASTER KEY
    TO FILE = '/var/opt/mssql/backup/MyDB_DMK.bak'
    ENCRYPTION BY PASSWORD = 'DMKBackupPass!';

-- Open DMK manually (when auto-open by SMK is disabled)
OPEN MASTER KEY DECRYPTION BY PASSWORD = 'DMKPass!2024';
```

> [!WARNING] DMK auto-open dependency
> If the DMK is encrypted by the SMK (default), it opens automatically. If you remove the SMK encryption (`ALTER MASTER KEY DROP ENCRYPTION BY SERVICE MASTER KEY`), all dependent operations (TDE, symmetric keys) will fail silently at startup. Always keep the SMK copy of DMK encryption unless you have a specific compliance reason to remove it.

---

## 10. Encryption Algorithm Reference

SQL Server supports symmetric and asymmetric algorithms for different tiers of the key hierarchy.

| Algorithm | Type | Key Length | Strength | Performance | Use Cases |
|---|---|---|---|---|---|
| `AES_128` | Symmetric | 128-bit | Good | Fastest AES | Column encryption where throughput is critical |
| `AES_192` | Symmetric | 192-bit | Strong | Moderate | Rarely used; prefer AES_256 |
| `AES_256` | Symmetric | 256-bit | Strongest symmetric | Slightly slower than AES_128 | **Default recommendation** — TDE DEK, column encryption, backup encryption |
| `TRIPLE_DES_3KEY` | Symmetric | 168-bit effective | Legacy-adequate | Slowest symmetric | **Avoid for new work** — backward compat with SQL Server 2000-era databases only |
| `RSA_2048` | Asymmetric | 2048-bit | Good for current use | Slow — not for bulk data | Key wrapping (CEK encrypted by CMK), module signing, TDE certificate backing |
| `RSA_4096` | Asymmetric | 4096-bit | Strongest asymmetric | Slowest | High-security key wrapping, long-lived CMKs |

> **Recommendation:** Default to `AES_256` for all symmetric encryption (TDE DEK, symmetric column keys, backup encryption). Use `RSA_2048` or `RSA_4096` only for wrapping symmetric keys or signing modules — never for encrypting data directly, as asymmetric operations are orders of magnitude slower. Avoid `TRIPLE_DES_3KEY` entirely for new deployments: AES_256 is both faster and stronger.

### 10.1 Specify algorithm in T-SQL

```sql
-- Symmetric key (column encryption)
CREATE SYMMETRIC KEY ColEncKey
    WITH ALGORITHM = AES_256
    ENCRYPTION BY CERTIFICATE ColumnEncryptCert;

-- TDE database encryption key
CREATE DATABASE ENCRYPTION KEY
    WITH ALGORITHM = AES_256
    ENCRYPTION BY SERVER CERTIFICATE TDE_Cert;

-- Backup encryption
BACKUP DATABASE MyDatabase
    TO DISK = '/var/opt/mssql/backup/MyDatabase_enc.bak'
    WITH ENCRYPTION (ALGORITHM = AES_256, SERVER CERTIFICATE = BackupCert);

-- Asymmetric key
CREATE ASYMMETRIC KEY AsymKey_RSA4096
    WITH ALGORITHM = RSA_4096;
```

---

## 11. Column Master Key (CMK) Provider Comparison

Always Encrypted CMKs are stored outside SQL Server. The KEY_STORE_PROVIDER_NAME determines where.

| Provider | KEY_STORE_PROVIDER_NAME | Storage | Portability | Centralized Rotation | Audit Trail | HSM-backed | Best For |
|---|---|---|---|---|---|---|---|
| Windows Certificate Store | `MSSQL_CERTIFICATE_STORE` | Local machine or current-user cert store | Not portable between machines | No | Windows Event Log only | No | Dev/test; single-server on-prem |
| Azure Key Vault | `AZURE_KEY_VAULT` | Azure cloud | Yes | Yes | Azure Monitor / Activity Log | Yes (AKV Managed HSM) | Azure SQL, multi-region, compliance workloads |
| HSM via CNG/EKM | `MSSQL_CNG_STORE` or custom EKM | On-prem HSM | Limited (HSM-specific) | Yes | HSM audit log | Yes (FIPS 140-2) | Highest security, air-gapped on-prem |

### 11.1 Setup syntax — Windows Certificate Store

```sql
-- CMK backed by a local certificate (thumbprint from cert store)
CREATE COLUMN MASTER KEY CMK_WinCert
WITH (
    KEY_STORE_PROVIDER_NAME = N'MSSQL_CERTIFICATE_STORE',
    KEY_PATH = N'CurrentUser/My/BBF037EC4A133912893A2E7DC5C4D9D4F14ECBA3'
);
```

> [!WARNING] Windows Cert Store CMK is machine-bound
> The private key is tied to the local machine's key store. If the server is replaced or the certificate is not exported with its private key, the CMK — and all CEKs and encrypted column data protected by it — becomes permanently inaccessible.

### 11.2 Setup syntax — Azure Key Vault

```sql
-- CMK backed by Azure Key Vault (key URL from AKV portal)
CREATE COLUMN MASTER KEY CMK_AKV
WITH (
    KEY_STORE_PROVIDER_NAME = N'AZURE_KEY_VAULT',
    KEY_PATH = N'https://myvault.vault.azure.net/keys/AlwaysEncryptedKey/abc123def456'
);
```

Requires the `Microsoft.Data.SqlClient.AlwaysEncrypted.AzureKeyVaultProvider` NuGet package in the client application and an Azure AD identity with `Get`, `Wrap Key`, and `Unwrap Key` permissions on the AKV key. [^3]

### 11.3 Setup syntax — HSM via CNG

```sql
-- CMK backed by an HSM using the CNG (Cryptography Next Generation) store
CREATE COLUMN MASTER KEY CMK_HSM
WITH (
    KEY_STORE_PROVIDER_NAME = N'MSSQL_CNG_STORE',
    KEY_PATH = N'My HSM CNG Provider/MyHSMKeyName'
);
```

The provider name must match the CNG provider registered on the client machine. The HSM vendor supplies the CNG provider DLL. [^4]

---

## 12. CEK Creation and Binding Workflow

The three-step sequence to go from CMK to encrypted columns. Step 2 (generating the encrypted CEK value) must be done from a client tool that has access to the CMK's private key — SSMS, PowerShell `SqlServer` module, or the `Microsoft.Data.SqlClient` API.

```sql
-- Step 1: Create the Column Master Key metadata in SQL Server
--         (actual key material lives in the provider specified above)
CREATE COLUMN MASTER KEY CMK1
WITH (
    KEY_STORE_PROVIDER_NAME = N'MSSQL_CERTIFICATE_STORE',
    KEY_PATH = N'CurrentUser/My/BBF037EC4A133912893A2E7DC5C4D9D4F14ECBA3'
);
GO

-- Step 2: Create the Column Encryption Key, encrypted by the CMK
--         The ENCRYPTED_VALUE is the CEK bytes encrypted with the CMK's public key.
--         Generate ENCRYPTED_VALUE via SSMS Always Encrypted wizard or:
--         New-SqlColumnEncryptionKeyEncryptedValue -TargetColumnMasterKeySettings $cmkSettings
CREATE COLUMN ENCRYPTION KEY CEK1
WITH VALUES (
    COLUMN_MASTER_KEY = CMK1,
    ALGORITHM = 'RSA_OAEP',
    ENCRYPTED_VALUE = 0x016E000001630075007200720065006E...  -- generated client-side
);
GO

-- Step 3a: Use CEK in a new table definition
CREATE TABLE dbo.PatientRecords (
    PatientId   INT  PRIMARY KEY,
    SSN         CHAR(11) COLLATE Latin1_General_BIN2
                ENCRYPTED WITH (
                    COLUMN_ENCRYPTION_KEY = CEK1,
                    ENCRYPTION_TYPE = DETERMINISTIC,
                    ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
                ) NOT NULL,
    Notes       VARCHAR(2000)
                ENCRYPTED WITH (
                    COLUMN_ENCRYPTION_KEY = CEK1,
                    ENCRYPTION_TYPE = RANDOMIZED,
                    ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
                ) NULL
);
GO

-- Step 3b: Encrypt an existing column (requires data migration via SSMS or SqlServer module)
--          SQL Server cannot re-encrypt data server-side; use SSMS > Always Encrypted wizard
--          or PowerShell Set-SqlColumnEncryption to handle the client-side re-encryption.
--
-- After client-side re-encryption, the column definition will show:
ALTER TABLE dbo.Employees
    ALTER COLUMN SSN CHAR(11) COLLATE Latin1_General_BIN2
        ENCRYPTED WITH (
            COLUMN_ENCRYPTION_KEY = CEK1,
            ENCRYPTION_TYPE = DETERMINISTIC,
            ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
        ) NOT NULL;
GO
```

> [!WARNING] Encrypted column data migration
> `ALTER TABLE ... ALTER COLUMN ... ENCRYPTED WITH` updates the column metadata but **does not re-encrypt existing data** server-side. Use the SSMS Always Encrypted wizard or `Set-SqlColumnEncryption` (PowerShell) to perform the actual data re-encryption via the client driver.

---

## 13. Key Rotation Strategies

Rotate keys at each layer on a schedule or after a suspected compromise. Rotation at a lower layer requires re-encrypting everything above it.

### 13.1 Rotation checklist

| Layer | Rotation Command | Downtime Required | Backup Before Rotation | Re-encrypt Dependents |
|---|---|---|---|---|
| SMK | `ALTER SERVICE MASTER KEY REGENERATE` | No | Yes — `BACKUP SERVICE MASTER KEY` | DMKs auto re-encrypted by SQL Server |
| DMK | `ALTER MASTER KEY REGENERATE` | No | Yes — `BACKUP MASTER KEY` | Symmetric keys and certs auto re-encrypted |
| TDE Certificate | Create new cert + `ALTER DATABASE ENCRYPTION KEY` | No | Yes — `BACKUP CERTIFICATE` (new cert) | DEK re-encrypted; old backups still need old cert |
| Always Encrypted CMK | Create new CMK in key store, re-wrap CEK | No | Back up new CMK in key store | CEK re-encrypted by new CMK; client drivers must update |
| Symmetric Key (column) | No built-in rotate; decrypt + re-encrypt | No | n/a | All encrypted column data must be re-encrypted |

### 13.2 SMK rotation

```sql
-- Regenerate the SMK; SQL Server re-encrypts all DMKs automatically
-- Run during a maintenance window — brief lock on master
ALTER SERVICE MASTER KEY REGENERATE;

-- Back up immediately after
BACKUP SERVICE MASTER KEY
    TO FILE = '/var/opt/mssql/backup/SMK_new.bak'
    ENCRYPTION BY PASSWORD = 'SMKBackupPass!New';
```

### 13.3 DMK rotation

```sql
USE MyDatabase;

-- Regenerate DMK; SQL Server re-encrypts all dependent symmetric keys and certs
ALTER MASTER KEY REGENERATE WITH ENCRYPTION BY PASSWORD = 'DMKNewPass!2025';

-- Back up immediately
BACKUP MASTER KEY
    TO FILE = '/var/opt/mssql/backup/MyDB_DMK_new.bak'
    ENCRYPTION BY PASSWORD = 'DMKBackupPass!New';
```

### 13.4 TDE certificate rotation

```sql
USE master;

-- Step 1: Create new certificate
CREATE CERTIFICATE TDE_Cert_2025
    WITH SUBJECT = 'TDE Certificate Rotation 2025',
    EXPIRY_DATE = '2031-01-01';

-- Step 2: Back up new certificate BEFORE switching
BACKUP CERTIFICATE TDE_Cert_2025
    TO FILE = '/var/opt/mssql/backup/TDE_Cert_2025.cer'
    WITH PRIVATE KEY (
        FILE   = '/var/opt/mssql/backup/TDE_Cert_2025.pvk',
        ENCRYPTION BY PASSWORD = 'CertBackupP@ss2025!'
    );

-- Step 3: Re-encrypt the DEK with the new certificate (online, no downtime)
USE MyDatabase;
ALTER DATABASE ENCRYPTION KEY
    REGENERATE WITH ALGORITHM = AES_256
    ENCRYPTION BY SERVER CERTIFICATE TDE_Cert_2025;

-- Monitor progress
SELECT percent_complete, encryption_state_desc
FROM sys.dm_database_encryption_keys
WHERE database_id = DB_ID('MyDatabase');
```

> **Retain old certificate backups** until all backup files encrypted with the old certificate have aged out of your retention policy. Old `.bak` files cannot be restored without the certificate that was active when the backup was taken.

### 13.5 Always Encrypted CMK rotation

CMK rotation is a two-phase client-side operation. The new CMK wraps a new copy of the CEK value; both copies coexist in `sys.column_encryption_key_values` until cleanup.

```sql
-- Phase 1: Add new CMK metadata (new key must already exist in the key store)
CREATE COLUMN MASTER KEY CMK2
WITH (
    KEY_STORE_PROVIDER_NAME = N'MSSQL_CERTIFICATE_STORE',
    KEY_PATH = N'CurrentUser/My/NEWTHUMBPRINTHERE'
);
GO

-- Phase 2 (client-side): Use SSMS or PowerShell to re-wrap the CEK with CMK2
-- Invoke-SqlColumnMasterKeyRotation -InputObject $db -SourceColumnMasterKeyName 'CMK1' -TargetColumnMasterKeyName 'CMK2'

-- Phase 3: Refresh stored procedure parameter encryption metadata
EXEC sp_refresh_parameter_encryption @procedure_name = N'dbo.usp_GetPatient';

-- Phase 4 (client-side): Complete rotation — removes old CMK1 copy of CEK value
-- Complete-SqlColumnMasterKeyRotation -InputObject $db -SourceColumnMasterKeyName 'CMK1'

-- Phase 5: Drop old CMK metadata after all clients are updated
DROP COLUMN MASTER KEY CMK1;
```

> [!WARNING] Client driver coordination required
> CMK rotation requires all application clients to be updated to use the new CMK before the old CMK is removed. Clients that only have access to the old CMK will fail to decrypt column values after the old CMK is dropped.

### 13.6 Symmetric key rotation (column encryption)

SQL Server has no built-in `ALTER SYMMETRIC KEY ... REGENERATE`. Rotation is a manual decrypt-and-reencrypt:

```sql
-- Step 1: Create new key
CREATE SYMMETRIC KEY ColEncKey_v2
    WITH ALGORITHM = AES_256
    ENCRYPTION BY CERTIFICATE ColumnEncryptCert;

-- Step 2: Open both keys and re-encrypt all rows
OPEN SYMMETRIC KEY ColEncKey   DECRYPTION BY CERTIFICATE ColumnEncryptCert;
OPEN SYMMETRIC KEY ColEncKey_v2 DECRYPTION BY CERTIFICATE ColumnEncryptCert;

UPDATE dbo.Employees
SET SSN_Encrypted_v2 = ENCRYPTBYKEY(
    KEY_GUID('ColEncKey_v2'),
    CONVERT(NVARCHAR(50), DECRYPTBYKEY(SSN_Encrypted))
);

CLOSE ALL SYMMETRIC KEYS;

-- Step 3: Validate, then drop old key and rename new column
-- (do in a transaction or with application downtime to avoid partial state)
DROP SYMMETRIC KEY ColEncKey;
```

---

## 14. Metadata Queries

### 10.1 Certificates

```sql
SELECT name, subject, expiry_date, thumbprint, pvt_key_encryption_type_desc
FROM sys.certificates
ORDER BY expiry_date;
```

### 10.2 Symmetric keys

```sql
SELECT name, key_algorithm, key_length, create_date, modify_date
FROM sys.symmetric_keys;
```

### 10.3 TDE status for all databases

```sql
SELECT d.name,
       CASE dek.encryption_state
           WHEN 0 THEN 'No DEK'
           WHEN 1 THEN 'Unencrypted'
           WHEN 3 THEN 'Encrypted'
           WHEN 2 THEN 'Encrypting...'
           WHEN 5 THEN 'Decrypting...'
           ELSE CAST(dek.encryption_state AS VARCHAR(10))
       END AS tde_state,
       dek.key_algorithm,
       dek.key_length,
       c.name AS protecting_certificate
FROM sys.databases d
LEFT JOIN sys.dm_database_encryption_keys dek ON d.database_id = dek.database_id
LEFT JOIN master.sys.certificates c ON dek.encryptor_thumbprint = c.thumbprint
ORDER BY d.name;
```

### 10.4 Security policies (RLS)

```sql
SELECT pol.name AS policy_name,
       pol.is_enabled,
       pred.predicate_type_desc,
       OBJECT_SCHEMA_NAME(pred.target_object_id) + '.' +
           OBJECT_NAME(pred.target_object_id) AS target_table,
       OBJECT_SCHEMA_NAME(pred.predicate_object_id) + '.' +
           OBJECT_NAME(pred.predicate_object_id) AS predicate_function
FROM sys.security_policies pol
JOIN sys.security_predicates pred ON pol.object_id = pred.object_id;
```

### 10.5 Masked columns (DDM)

```sql
SELECT OBJECT_SCHEMA_NAME(c.object_id) + '.' + OBJECT_NAME(c.object_id) AS table_name,
       c.name AS column_name,
       c.masking_function
FROM sys.masked_columns c
WHERE c.is_masked = 1;
```

### 10.6 Always Encrypted keys

```sql
-- Column master keys
SELECT name, key_store_provider_name, key_path, create_date
FROM sys.column_master_keys;

-- Column encryption keys and their values
SELECT cek.name, cev.encryption_algorithm_name,
       cmk.name AS master_key_name, cmk.key_store_provider_name
FROM sys.column_encryption_keys cek
JOIN sys.column_encryption_key_values cev ON cek.column_encryption_key_id = cev.column_encryption_key_id
JOIN sys.column_master_keys cmk ON cev.column_master_key_id = cmk.column_master_key_id;

-- Encrypted columns
SELECT OBJECT_SCHEMA_NAME(c.object_id) + '.' + OBJECT_NAME(c.object_id) AS table_name,
       c.name AS column_name, c.encryption_type_desc, cek.name AS cek_name
FROM sys.columns c
JOIN sys.column_encryption_keys cek ON c.column_encryption_key_id = cek.column_encryption_key_id
WHERE c.column_encryption_key_id IS NOT NULL;
```

---

## 15. Gotchas / Anti-patterns

1. **TDE certificate not backed up.** The most common TDE disaster. Back up the certificate immediately after creation — you cannot restore the database on another instance without it.

2. **DDM used as a security control.** DDM protects column display values; it does not protect against WHERE-clause inference, aggregates, or any user with `UNMASK`. Use Always Encrypted or application-layer encryption for genuine confidentiality.

3. **RLS `db_owner` bypass.** Members of `db_owner` bypass RLS filter predicates. If your threat model includes rogue DBAs, RLS alone is insufficient.

4. **RLS predicate function without SCHEMABINDING.** Without SCHEMABINDING, the predicate is not inlined and executes as a regular multi-statement function call per row — severe performance degradation on large tables.

5. **Always Encrypted and server-side operations.** Any T-SQL function (`UPPER`, `SUBSTRING`, `LEN`) operating on an AE column fails — the server only sees ciphertext. All string manipulation must happen client-side after decryption.

6. **Symmetric key left open.** `OPEN SYMMETRIC KEY` opens the key for the session. If the session is pooled (connection pooling), the next user of that connection gets an open key. Always `CLOSE SYMMETRIC KEY` in a `TRY/FINALLY`-equivalent pattern.

7. **Rotating TDE cert without backing up the new cert.** After rotation, the old cert is no longer protecting new backups, but older backups still need the old cert. Keep old cert backups until all backups using the old cert expire from your retention policy.

8. **TRUSTWORTHY as substitute for module signing.** `ALTER DATABASE MyDB SET TRUSTWORTHY ON` is a blunt instrument — it gives `db_owner` members sysadmin-equivalent for cross-database calls. Use certificate-based module signing instead.

9. **Always Encrypted deterministic + non-BIN2 collation.** Using a non-BIN2 collation on a deterministic AE column produces metadata mismatches that cause query failures. Always use `_BIN2` collation.

10. **DDM and reporting tools.** SSRS, Power BI, and Excel pivot tables connect as the service account. If the service account has `UNMASK`, reports expose unmasked data to all consumers of the report. Audit service account permissions before deploying masked columns.

11. **`TRIPLE_DES_3KEY` for new deployments.** `TRIPLE_DES_3KEY` is slower than AES_128 and weaker than AES_256. There is no reason to choose it for any new symmetric key, TDE DEK, or backup encryption. Existing keys using `TRIPLE_DES_3KEY` should be rotated to `AES_256` during the next scheduled maintenance.

12. **CMK rotation requires client-side coordination.** When rotating an Always Encrypted CMK, removing the old CMK from SQL Server before all application instances have been updated to use the new CMK will cause immediate query failures for any client that still references the old CMK. Coordinate rotation across all client deployments before dropping the old CMK metadata.

13. **Losing the SMK without a backup.** The SMK is auto-created and protected by Windows DPAPI (the machine key). If you migrate to a new server OS or rebuild the machine without restoring the SMK, all DMKs that were encrypted by that SMK become unreadable — which means all symmetric keys, TDE DEKs, and certificates in those databases are permanently lost. Run `BACKUP SERVICE MASTER KEY` after every SQL Server installation and after any `ALTER SERVICE MASTER KEY REGENERATE`.

---

## 16. See Also

- [`15-principals-permissions.md`](15-principals-permissions.md) — login/user/role setup, EXECUTE AS, ownership chaining
- [`13-transactions-locking.md`](13-transactions-locking.md) — isolation levels relevant to RLS predicate interaction
- [`38-auditing.md`](38-auditing.md) — SQL Server Audit for compliance logging of data access
- [`43-high-availability.md`](43-high-availability.md) — TDE with Always On AG (certificate must be on all replicas)
- [`44-backup-restore.md`](44-backup-restore.md) — backup encryption, TDE certificate restore workflow

---

## Sources

[^1]: [Dynamic Data Masking - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/security/dynamic-data-masking) — covers DDM mask functions, granular UNMASK permission scoped to column/table/schema level (SQL Server 2022+)
[^2]: [SQL Server back up to URL for S3-compatible object storage - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/sql-server-backup-to-url-s3-compatible-object-storage) — covers S3-compatible backup and restore including WITH ENCRYPTION support (SQL Server 2022+)
[^3]: [Create & store column master keys for Always Encrypted - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/create-and-store-column-master-keys-always-encrypted) — covers Azure Key Vault CMK setup including required permissions (get, unwrapKey, wrapKey) and the AzureKeyVaultProvider NuGet package
[^4]: [Create & store column master keys for Always Encrypted - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/create-and-store-column-master-keys-always-encrypted) — covers CNG/KSP-based CMK storage in hardware security modules including KSP provider configuration requirements

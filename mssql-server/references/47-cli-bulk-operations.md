# 47 — CLI & Bulk Operations

SQL Server CLI tools, bulk load utilities, and PowerShell automation reference for developers and DBAs.

---

## Table of Contents

1. [When to Use](#when-to-use)
2. [Tool Overview](#tool-overview)
3. [sqlcmd](#sqlcmd)
4. [bcp](#bcp)
5. [Format Files](#format-files)
6. [BULK INSERT](#bulk-insert)
7. [OPENROWSET BULK](#openrowset-bulk)
8. [Minimal Logging Checklist](#minimal-logging-checklist)
9. [sqlpackage](#sqlpackage)
10. [mssql-cli](#mssql-cli)
11. [PowerShell SQLServer Module](#powershell-sqlserver-module)
12. [BULK INSERT vs bcp Comparison](#bulk-insert-vs-bcp-comparison)
13. [Gotchas](#gotchas)
14. [See Also](#see-also)
15. [Sources](#sources)

---

## When to Use

| Task | Tool |
|------|------|
| Script execution, CI/CD automation | `sqlcmd` |
| Fast data export/import between files and SQL Server | `bcp` |
| Schema deploy/diff, dacpac/bacpac packaging | `sqlpackage` |
| Interactive SSMS-like terminal | `mssql-cli` |
| Bulk load from a file on the SQL Server machine | `BULK INSERT` |
| Bulk load from a file accessible to the SQL Engine | `OPENROWSET BULK` |
| PowerShell automation, backup/restore, SSAS/SSRS mgmt | `SqlServer` module |

---

## Tool Overview

| Tool | Ships With | Platform | Auth | Notes |
|------|-----------|----------|------|-------|
| `sqlcmd` (legacy) | SQL Server tools | Win/Linux/macOS | SQL + Windows | Scriptable, -v variables, batch mode |
| `sqlcmd` (go) | Standalone install | Win/Linux/macOS | SQL + Windows + AAD | v21+, replaces legacy |
| `bcp` | SQL Server tools | Win/Linux | SQL + Windows | Bulk copy program |
| `sqlpackage` | Standalone DacFx | Win/Linux/macOS | SQL + Windows + AAD | Schema deploy/diff |
| `mssql-cli` | pip install | Win/Linux/macOS | SQL + Windows | Interactive REPL |
| `SqlServer` module | `Install-Module` | Win/Linux | SQL + Windows | PowerShell automation |

---

## sqlcmd

### Basic usage

```bash
# Run a script file
sqlcmd -S myserver -d mydb -U sa -P 'pass' -i script.sql

# Run inline query
sqlcmd -S myserver -d mydb -U sa -P 'pass' -Q "SELECT @@VERSION"

# Trusted Windows auth
sqlcmd -S myserver -d mydb -E -i script.sql

# Write output to file
sqlcmd -S myserver -d mydb -E -i script.sql -o output.txt

# No header, no row count (for parseable output)
sqlcmd -S myserver -d mydb -E -Q "SELECT name FROM sys.databases" -h -1 -W
```

### Key flags reference

| Flag | Meaning |
|------|---------|
| `-S server[\instance]` | Target server (also `tcp:host,port`) |
| `-d database` | Initial catalog |
| `-U login` / `-P password` | SQL authentication |
| `-E` | Windows integrated auth |
| `-i file.sql` | Input script |
| `-o file.txt` | Output file |
| `-Q "query"` | Run query and exit |
| `-q "query"` | Run query, stay in interactive mode |
| `-v name=value` | Set scripting variable |
| `-b` | Exit with error on batch failure |
| `-V errorlevel` | Minimum severity to set exit code |
| `-h -1` | Suppress column headers |
| `-W` | Remove trailing spaces |
| `-s ,` | Column separator (for CSV) |
| `-t seconds` | Query timeout |
| `-l seconds` | Login timeout |
| `-r [0|1]` | Redirect error messages to stderr |
| `-X` | Disable commands: ED, !! (security hardening) |
| `-f codepage` | Input/output codepage |
| `-u` | Unicode output |
| `-m errorlevel` | Suppress messages below this severity |

### Scripting variables

```sql
-- In script file: reference with $(VarName)
SELECT TOP $(TopN) name FROM sys.databases WHERE name = '$(DbName)';
GO

-- In error messages
:setvar MyVar "hello"
PRINT 'Value is $(MyVar)';
GO
```

```bash
# Pass from command line
sqlcmd -S myserver -E -i script.sql -v TopN=10 DbName=AdventureWorks
```

### Conditional logic / :on error

```sql
-- Abort the entire script on any error
:on error exit

-- Explicitly check SQLCMDMAXVARTYPEWIDTH
CREATE TABLE ##temp (id INT);
GO
IF @@ERROR <> 0
BEGIN
    RAISERROR('Table creation failed', 16, 1);
END
GO
```

### GO batches and loops

```sql
-- GO N executes the batch N times
INSERT INTO dbo.TestRows (val) VALUES (NEWID());
GO 1000

-- GO with SQLCMD variable
INSERT INTO dbo.TestRows (val) VALUES (NEWID());
GO $(RowCount)
```

### CI/CD invocation pattern

```bash
#!/bin/bash
set -e  # abort on error

sqlcmd \
  -S "$DB_SERVER" \
  -d "$DB_NAME" \
  -U "$DB_USER" \
  -P "$DB_PASS" \
  -b \
  -V 16 \
  -i migrations/V001__create_schema.sql

echo "Migration applied successfully"
```

> [!NOTE] sqlcmd (go) v21+
> The new Go-based `sqlcmd` supports Azure AD authentication (`--authentication-method`), interactive MFA (`ActiveDirectoryInteractive`), and JSON output (`--format json`). The legacy C-based sqlcmd is still available but receives only security fixes.

---

## bcp

### Basic syntax

```bash
# Export: queryout (run a query, write to file)
bcp "SELECT * FROM AdventureWorks.HumanResources.Employee" queryout employees.dat -S myserver -T -c

# Export: out (entire table)
bcp AdventureWorks.HumanResources.Employee out employees.dat -S myserver -T -c

# Import: in
bcp AdventureWorks.dbo.EmployeeStage in employees.dat -S myserver -T -c

# Generate format file
bcp AdventureWorks.HumanResources.Employee format nul -S myserver -T -c -f employee.fmt

# Use existing format file on import
bcp AdventureWorks.dbo.EmployeeStage in employees.dat -S myserver -T -f employee.fmt
```

### Key flags

| Flag | Meaning |
|------|---------|
| `-S server` | Target server |
| `-d database` | Database (use fully-qualified name in object, or `-d` shorthand) |
| `-U login` / `-P password` | SQL auth |
| `-T` | Windows integrated auth |
| `-c` | Character mode (UTF-8 friendly, field sep `\t`, row sep `\n`) |
| `-w` | Unicode character mode (NCHAR columns) |
| `-n` | Native mode (SQL Server binary, fast for SQL-to-SQL) |
| `-N` | Wide-character native (native for non-char, unicode for char) |
| `-f format_file` | Use format file |
| `-F first_row` | Skip N rows at start |
| `-L last_row` | Stop after row N |
| `-b batchsize` | Rows per commit batch |
| `-h hints` | Load hints: ORDER, ROWS_PER_BATCH, KILOBYTES_PER_BATCH, TABLOCK, CHECK_CONSTRAINTS, FIRE_TRIGGERS |
| `-t field_term` | Field terminator (default `\t`) |
| `-r row_term` | Row terminator (default `\n`) |
| `-e errorfile` | Log bad rows to file |
| `-m maxerrors` | Max errors before abort |
| `-q` | Quoted identifiers (required for reserved word table names) |
| `-k` | Keep NULLs (don't substitute column defaults) |
| `-E` | Keep identity values from file |
| `-a packetsize` | Network packet size (512–65535; larger improves throughput) |

### Mode comparison

| Mode | Flag | Use case | Notes |
|------|------|----------|-------|
| Character | `-c` | CSV/text, cross-platform | Field sep `\t`, row sep `\n` |
| Unicode char | `-w` | Unicode text data | Double the file size vs `-c` for ASCII |
| Native | `-n` | SQL Server → SQL Server | Fastest; not human-readable; includes data type metadata |
| Wide-char native | `-N` | Mixed char+binary | Native for binary, unicode for char columns |

### Performance tuning

```bash
# High-performance bulk load
bcp mydb.dbo.StagingTable in data.dat \
  -S myserver \
  -T \
  -n \
  -b 10000 \
  -a 65535 \
  -h "TABLOCK,ORDER(id ASC),ROWS_PER_BATCH=1000000"
```

**Minimal logging with bcp requires:**
- Table is a heap OR target index is the clustered index and data is loaded in key order
- Database recovery model is SIMPLE or BULK_LOGGED
- `-h "TABLOCK"` hint provided
- No triggers, no FK constraints enabled on the target table

### Exporting with custom query and column header

```bash
# Export with header row (sqlcmd handles this better than bcp)
sqlcmd -S myserver -T -Q "SET NOCOUNT ON; SELECT 'col1','col2'; SELECT col1, col2 FROM dbo.MyTable" \
  -s "," -W -o output.csv
```

> [!NOTE]
> `bcp` does not write column headers. Use `sqlcmd` or `sqlpackage` for header-inclusive CSV export, or prepend a header row from the shell.

---

## Format Files

Format files describe the mapping between a data file's layout and a table's columns. They are required when:
- Column order in the file differs from the table
- Some columns need to be skipped
- Delimiters differ per column
- Using native mode with precise column control

### Non-XML format file

Generated with:
```bash
bcp AdventureWorks.HumanResources.Employee format nul -S myserver -T -c -f employee_char.fmt
```

Example output (`employee_char.fmt`):
```
14.0
13
1       SQLCHAR    0   12  "\t"    1  BusinessEntityID             SQL_Latin1_General_CP1_CI_AS
2       SQLCHAR    0   50  "\t"    2  NationalIDNumber             SQL_Latin1_General_CP1_CI_AS
3       SQLCHAR    0   1   "\t"    3  LoginID                      SQL_Latin1_General_CP1_CI_AS
4       SQLCHAR    0   50  "\t"    4  OrganizationNode             SQL_Latin1_General_CP1_CI_AS
5       SQLCHAR    0   4   "\t"    5  OrganizationLevel            SQL_Latin1_General_CP1_CI_AS
6       SQLCHAR    0   50  "\t"    6  JobTitle                     SQL_Latin1_General_CP1_CI_AS
7       SQLCHAR    0   24  "\t"    7  BirthDate                    SQL_Latin1_General_CP1_CI_AS
8       SQLCHAR    0   1   "\t"    8  MaritalStatus                SQL_Latin1_General_CP1_CI_AS
9       SQLCHAR    0   1   "\t"    9  Gender                       SQL_Latin1_General_CP1_CI_AS
10      SQLCHAR    0   24  "\t"    10 HireDate                     SQL_Latin1_General_CP1_CI_AS
11      SQLCHAR    0   1   "\t"    11 SalariedFlag                 SQL_Latin1_General_CP1_CI_AS
12      SQLCHAR    0   4   "\t"    12 VacationHours                SQL_Latin1_General_CP1_CI_AS
13      SQLCHAR    0   8   "\r\n"  13 SickLeaveHours               SQL_Latin1_General_CP1_CI_AS
```

**Format file column layout:**
```
HostFileFieldOrder  DataType  PrefixLen  FieldLen  Terminator  TableColOrder  TableColName  Collation
```

To **skip a column** (e.g., skip file column 2), set its `TableColOrder` to `0`:
```
2       SQLCHAR    0   50  "\t"    0  ""    ""
```

### XML format file (preferred for complex mappings)

```xml
<?xml version="1.0"?>
<BCPFORMAT xmlns="http://schemas.microsoft.com/sqlserver/2004/bulkload/format"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <RECORD>
    <FIELD ID="1" xsi:type="CharTerm" TERMINATOR=","  MAX_LENGTH="12"/>
    <FIELD ID="2" xsi:type="CharTerm" TERMINATOR=","  MAX_LENGTH="100"/>
    <FIELD ID="3" xsi:type="CharTerm" TERMINATOR="\r\n" MAX_LENGTH="50"/>
  </RECORD>
  <ROW>
    <COLUMN SOURCE="1" NAME="EmployeeID" xsi:type="SQLINT"/>
    <COLUMN SOURCE="3" NAME="Department"  xsi:type="SQLNVARCHAR"/>
    <!-- SOURCE="2" skipped — not mapped to any ROW COLUMN -->
  </ROW>
</BCPFORMAT>
```

XML format files support:
- Column reordering (SOURCE ≠ column position)
- Skipping file columns (omit from `<ROW>` section)
- Mixed delimiters per field

---

## BULK INSERT

Loads a data file directly into a table. The file must be accessible to the SQL Server engine (local path or UNC share).

```sql
-- Basic character-mode load
BULK INSERT dbo.StagingTable
FROM 'C:\data\employees.csv'
WITH (
    FIELDTERMINATOR = ',',
    ROWTERMINATOR   = '\n',
    FIRSTROW        = 2,        -- skip header row
    MAXERRORS       = 10,
    ERRORFILE       = 'C:\data\errors.txt',
    TABLOCK
);

-- Using a format file
BULK INSERT dbo.StagingTable
FROM '\\fileserver\share\employees.dat'
WITH (
    FORMATFILE  = '\\fileserver\share\employee.fmt',
    TABLOCK,
    BATCHSIZE   = 10000,
    CHECK_CONSTRAINTS,
    FIRE_TRIGGERS
);

-- S3-compatible storage (SQL Server 2022+)
BULK INSERT dbo.StagingTable
FROM 's3://mybucket/data/employees.csv'
WITH (
    CREDENTIAL = 'MyS3Credential',
    FIELDTERMINATOR = ',',
    ROWTERMINATOR   = '\n',
    FIRSTROW        = 2
);
```

> [!NOTE] SQL Server 2022
> `BULK INSERT` supports S3-compatible object storage URLs with a database-scoped credential. The credential must be created with `CREATE DATABASE SCOPED CREDENTIAL`.

### BULK INSERT WITH options reference

| Option | Default | Notes |
|--------|---------|-------|
| `BATCHSIZE` | All rows | Rows per commit; larger = fewer commits but more log space |
| `CHECK_CONSTRAINTS` | OFF | Validate FK/CHECK during load |
| `CODEPAGE` | 'ACP' | For `CHAR` data: `'ACP'`, `'OEM'`, `'RAW'`, or numeric codepage |
| `DATAFILETYPE` | 'char' | `'char'`, `'native'`, `'widechar'`, `'widenative'` |
| `ERRORFILE` | none | Row-level errors written here |
| `FIELDQUOTE` | none | Quote character (2017+) |
| `FIELDTERMINATOR` | `'\t'` | Column separator |
| `FIRE_TRIGGERS` | OFF | Execute INSERT triggers during load |
| `FIRSTROW` | 1 | Row number to start loading |
| `FORMAT` | none | `'CSV'` uses RFC 4180 rules (2017+) |
| `FORMATFILE` | none | Format file path |
| `KEEPIDENTITY` | OFF | Use identity values from file |
| `KEEPNULLS` | OFF | Preserve NULLs instead of using column defaults |
| `LASTROW` | 0 (all) | Stop at this row number |
| `MAXERRORS` | 10 | Abort after N errors |
| `ORDER` | none | `(col ASC/DESC)` for minimal logging optimization |
| `ROWTERMINATOR` | `'\n'` | Row delimiter |
| `ROWS_PER_BATCH` | auto | Hint to optimizer for load batching |
| `TABLOCK` | OFF | Table-level lock; required for minimal logging |

> [!NOTE] SQL Server 2017
> `FORMAT = 'CSV'` and `FIELDQUOTE` options added, enabling RFC 4180 compliant CSV parsing including quoted fields with embedded commas.

---

## OPENROWSET BULK

Allows reading a file as a table in a query — useful for ad-hoc inspection or INSERT…SELECT patterns. The file path is resolved by the SQL Server engine.

```sql
-- Ad-hoc CSV read
SELECT *
FROM OPENROWSET(
    BULK 'C:\data\employees.csv',
    FORMATFILE = 'C:\data\employee.xml',
    FIRSTROW = 2
) AS src;

-- Single-column SINGLE_CLOB for reading text files
SELECT BulkColumn
FROM OPENROWSET(BULK 'C:\scripts\myscript.sql', SINGLE_CLOB) AS t;

-- Insert using OPENROWSET BULK
INSERT INTO dbo.StagingTable
SELECT *
FROM OPENROWSET(
    BULK 'C:\data\employees.dat',
    FORMATFILE = 'C:\data\employee.fmt'
) AS src;

-- S3-compatible (SQL Server 2022+)
SELECT *
FROM OPENROWSET(
    BULK 's3://mybucket/data/employees.csv',
    CREDENTIAL = 'MyS3Credential',
    FORMAT = 'CSV',
    FIRSTROW = 2
) WITH (
    EmployeeID   INT,
    LastName     NVARCHAR(50),
    Department   NVARCHAR(100)
) AS src;
```

### SINGLE_CLOB / SINGLE_NCLOB / SINGLE_BLOB

| Option | Type returned | Use case |
|--------|--------------|----------|
| `SINGLE_CLOB` | `VARCHAR(MAX)` | Read entire text file as one value |
| `SINGLE_NCLOB` | `NVARCHAR(MAX)` | Read entire unicode file |
| `SINGLE_BLOB` | `VARBINARY(MAX)` | Read binary file (images, etc.) |

> [!WARNING]
> `OPENROWSET` requires `Ad Hoc Distributed Queries` to be enabled:
> ```sql
> EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
> EXEC sp_configure 'Ad Hoc Distributed Queries', 1; RECONFIGURE;
> ```
> This is disabled by default for security. Enable only when needed; prefer BULK INSERT for automated loads.

---

## Minimal Logging Checklist

Minimal logging dramatically reduces transaction log growth during bulk loads. All conditions must be met:

### Heap target table

- [ ] Recovery model is **SIMPLE** or **BULK_LOGGED**
- [ ] `TABLOCK` hint specified
- [ ] No triggers on the table (or `FIRE_TRIGGERS` not specified)
- [ ] Table has **no indexes** (heap) — OR all indexes are created after the load

### Clustered index target table

- [ ] Recovery model is **SIMPLE** or **BULK_LOGGED**
- [ ] `TABLOCK` hint specified
- [ ] Data is loaded in **clustered key order** (`ORDER` hint matches clustered key)
- [ ] Table is **empty** (loading into existing data gets full logging even in order)
- [ ] No nonclustered indexes — each NCI adds row logging overhead

### Nonclustered indexes

- [ ] Each nonclustered index incurs **full row logging** regardless of table type
- [ ] Best practice: drop NCIs before large loads, rebuild after

### Always fully logged

- [ ] FULL recovery model (unless switched to BULK_LOGGED first)
- [ ] `CHECK_CONSTRAINTS` on (FK/CHECK validation fully logged)
- [ ] `FIRE_TRIGGERS` on
- [ ] Triggers present on target table
- [ ] Foreign keys enabled on the table

### Verify minimal logging is active

```sql
-- Check transaction log usage before/after to compare
SELECT log_reuse_wait_desc, log_size_mb = log_size_mb,
       log_used_mb = log_used_mb
FROM sys.dm_db_log_stats(DB_ID());

-- During load: look for BULK_OP_ALLOC wait type (indicates minimal logging)
SELECT wait_type, waiting_tasks_count, wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type LIKE 'BULK%';
```

> [!WARNING] Recovery model switch
> Switching from FULL to BULK_LOGGED breaks the log backup chain. After the load, take a log backup immediately before switching back, then take another log backup. Without this you will not be able to do point-in-time restore across the switch boundary.

---

## sqlpackage

`sqlpackage` is the CLI wrapper around DacFx — the same engine SSMS uses for schema compare and deployment.

### Actions overview

| Action | Description |
|--------|-------------|
| `Publish` | Deploy a dacpac to a database (schema + optionally data) |
| `Extract` | Extract a dacpac from a live database |
| `Export` | Export a bacpac from a live database (schema + data) |
| `Import` | Import a bacpac into a new/existing database |
| `DeployReport` | XML report of what Publish *would* change |
| `DriftReport` | XML report of schema drift since last publish |
| `Script` | Generate T-SQL deployment script without executing |

### Extract (capture schema snapshot)

```bash
sqlpackage /Action:Extract \
  /SourceServerName:myserver \
  /SourceDatabaseName:MyDatabase \
  /SourceUser:sa \
  /SourcePassword:pass \
  /TargetFile:MyDatabase.dacpac
```

### Publish (deploy dacpac)

```bash
sqlpackage /Action:Publish \
  /SourceFile:MyDatabase.dacpac \
  /TargetServerName:targetserver \
  /TargetDatabaseName:MyDatabase \
  /TargetUser:sa \
  /TargetPassword:pass \
  /p:BlockOnPossibleDataLoss=true \
  /p:DropObjectsNotInSource=false \
  /p:IgnorePermissions=true
```

### Script (generate deployment T-SQL without executing)

```bash
sqlpackage /Action:Script \
  /SourceFile:MyDatabase.dacpac \
  /TargetServerName:targetserver \
  /TargetDatabaseName:MyDatabase \
  /TargetUser:sa \
  /TargetPassword:pass \
  /OutputPath:deploy.sql
```

### DeployReport (what would change)

```bash
sqlpackage /Action:DeployReport \
  /SourceFile:MyDatabase.dacpac \
  /TargetServerName:targetserver \
  /TargetDatabaseName:MyDatabase \
  /TargetUser:sa \
  /TargetPassword:pass \
  /OutputPath:report.xml
```

### Export/Import (bacpac with data)

```bash
# Export schema + data
sqlpackage /Action:Export \
  /SourceServerName:myserver \
  /SourceDatabaseName:MyDatabase \
  /TargetFile:MyDatabase.bacpac \
  /SourceUser:sa /SourcePassword:pass

# Import to new database
sqlpackage /Action:Import \
  /SourceFile:MyDatabase.bacpac \
  /TargetServerName:targetserver \
  /TargetDatabaseName:MyDatabaseCopy \
  /TargetUser:sa /TargetPassword:pass
```

### CI/CD publish example (GitHub Actions)

```yaml
# .github/workflows/deploy-db.yml
name: Deploy Database

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install sqlpackage
        run: |
          curl -sSL https://aka.ms/sqlpackage-linux -o sqlpackage.zip
          unzip sqlpackage.zip -d ~/sqlpackage
          chmod +x ~/sqlpackage/sqlpackage

      - name: Deploy Report (what will change)
        run: |
          ~/sqlpackage/sqlpackage /Action:DeployReport \
            /SourceFile:./database/MyDatabase.dacpac \
            /TargetServerName:${{ secrets.DB_SERVER }} \
            /TargetDatabaseName:MyDatabase \
            /TargetUser:${{ secrets.DB_USER }} \
            /TargetPassword:${{ secrets.DB_PASS }} \
            /OutputPath:/tmp/deploy-report.xml

      - name: Deploy dacpac
        run: |
          ~/sqlpackage/sqlpackage /Action:Publish \
            /SourceFile:./database/MyDatabase.dacpac \
            /TargetServerName:${{ secrets.DB_SERVER }} \
            /TargetDatabaseName:MyDatabase \
            /TargetUser:${{ secrets.DB_USER }} \
            /TargetPassword:${{ secrets.DB_PASS }} \
            /p:BlockOnPossibleDataLoss=true \
            /p:DropObjectsNotInSource=false \
            /p:IgnorePermissions=true \
            /p:ExcludeObjectTypes=Logins
```

### Key publish properties (`/p:`)

| Property | Default | Notes |
|----------|---------|-------|
| `BlockOnPossibleDataLoss` | `true` | Abort if operation could lose data |
| `DropObjectsNotInSource` | `false` | Drop objects in target not in dacpac |
| `IgnorePermissions` | `false` | Don't deploy GRANT/REVOKE statements |
| `IgnoreRoleMembership` | `false` | Skip role membership changes |
| `ExcludeObjectTypes` | none | Comma-separated list of types to skip |
| `CreateNewDatabase` | `false` | Create DB if it doesn't exist |
| `BackupDatabaseBeforeChanges` | `false` | Take backup before deploying |
| `ScriptDatabaseCompatibility` | `true` | Include compat level in deploy |
| `IncludeCompositeObjects` | `false` | Include referenced objects in same server |

---

## mssql-cli

`mssql-cli` is an interactive terminal client with syntax highlighting, multi-line editing, and auto-completion. Install via pip:

```bash
pip install mssql-cli

# Connect
mssql-cli -S myserver -U sa -P pass -d MyDatabase

# Windows integrated auth
mssql-cli -S myserver -E -d MyDatabase
```

### Interactive features

- `F3` / `\e` — Toggle multi-line mode
- `F4` — Toggle syntax highlighting
- `\l` — List databases
- `\dn` — List schemas
- `\dt` — List tables
- `\d tablename` — Describe table
- `\q` or `quit` — Exit

### Key configuration (via `~/.config/mssql-cli/config`)

```ini
[main]
multi_line = True
style = solarized
row_limit = 1000
less_chatty = True
```

> [!NOTE]
> `mssql-cli` is currently in maintenance mode. For production scripting, use `sqlcmd`. For interactive development, it remains useful for syntax highlighting and autocomplete.

---

## PowerShell SQLServer Module

```powershell
# Install
Install-Module -Name SqlServer -AllowClobber -Force

# Import
Import-Module SqlServer
```

### Invoke-Sqlcmd

```powershell
# Run a query
Invoke-Sqlcmd -ServerInstance "myserver" `
              -Database "MyDB" `
              -Query "SELECT TOP 10 name FROM sys.tables" `
              -Username "sa" `
              -Password "pass"

# From file with variables
Invoke-Sqlcmd -ServerInstance "myserver" `
              -Database "MyDB" `
              -InputFile "C:\scripts\deploy.sql" `
              -Variable @("Env=Prod", "MaxRows=1000") `
              -TrustServerCertificate

# Capture output to CSV
Invoke-Sqlcmd -ServerInstance "myserver" `
              -Database "MyDB" `
              -Query "SELECT * FROM dbo.Orders" |
  Export-Csv -Path "orders.csv" -NoTypeInformation
```

### Backup and restore cmdlets

```powershell
# Full backup
Backup-SqlDatabase -ServerInstance "myserver" `
                   -Database "MyDB" `
                   -BackupFile "C:\backups\MyDB_full.bak" `
                   -CompressionOption On

# Differential backup
Backup-SqlDatabase -ServerInstance "myserver" `
                   -Database "MyDB" `
                   -BackupFile "C:\backups\MyDB_diff.bak" `
                   -BackupAction Differential `
                   -CompressionOption On

# Log backup
Backup-SqlDatabase -ServerInstance "myserver" `
                   -Database "MyDB" `
                   -BackupFile "C:\backups\MyDB_log.bak" `
                   -BackupAction Log `
                   -CompressionOption On

# Restore
Restore-SqlDatabase -ServerInstance "myserver" `
                    -Database "MyDB_Restored" `
                    -BackupFile "C:\backups\MyDB_full.bak" `
                    -ReplaceDatabase `
                    -NoRecovery
```

### Useful SMO-based commands

```powershell
# List all databases
Get-SqlDatabase -ServerInstance "myserver"

# Get index fragmentation
$srv = New-Object Microsoft.SqlServer.Management.Smo.Server("myserver")
$db  = $srv.Databases["MyDB"]
$db.Tables | ForEach-Object {
    $_.Indexes | ForEach-Object {
        [PSCustomObject]@{
            Table = $_.Parent.Name
            Index = $_.Name
            AverageFragmentation = $_.EnumFragmentation() |
                                   Select-Object -ExpandProperty AverageFragmentation
        }
    }
}
```

---

## BULK INSERT vs bcp Comparison

| Dimension | BULK INSERT | bcp |
|-----------|-------------|-----|
| Execution context | T-SQL (inside SQL Server) | Command line (client machine) |
| File location | SQL Server machine or UNC share | Client machine or UNC share |
| Authentication | Current SQL connection | `-T` / `-U -P` |
| S3/Azure Blob | Yes (2022+) | No |
| Format files | Yes | Yes (generates and uses) |
| Column header skip | `FIRSTROW = 2` | `-F 2` |
| Minimal logging | Yes (with correct conditions) | Yes (with correct conditions) |
| Error file | `ERRORFILE = '...'` | `-e errorfile` |
| Use in scripts | T-SQL only | Any shell/CI environment |
| SSPI Kerberos | Inherited from connection | `-T` |
| Transform during load | No (use OPENROWSET + SELECT) | No |
| Network load | Possible if UNC accessible | Client-side; can be faster |
| Automation | Via SQL Agent job | Shell script / cron |

**Rule of thumb:**
- Use `bcp` when the file is on the client machine and you need to automate from a shell
- Use `BULK INSERT` when the file is on the server or accessible via UNC and you want T-SQL control
- Use `OPENROWSET BULK` for one-off SELECT-based inspection or INSERT…SELECT transforms

---

## Gotchas

1. **`bcp` native mode is not portable.** Native (`-n`) files are tied to the source SQL Server version. Do not use native mode for cross-version migrations; use character mode or XML format files.

2. **`bcp` does not write column headers.** Export headers separately with `sqlcmd` or prepend manually. Importing a file with headers requires `FIRSTROW = 2` or `-F 2` to skip.

3. **BULK INSERT file path is server-side.** The path in `BULK INSERT ... FROM 'C:\...'` must be accessible to the SQL Server service account, not the application server. Use UNC shares for cross-machine loads.

4. **Minimal logging is all-or-nothing per load.** If even one condition is unmet (e.g., an NCI exists), the entire load reverts to full logging. Use `sys.dm_db_log_stats` to verify before production runs.

5. **`sqlcmd` exit codes.** Without `-b` (abort on error), `sqlcmd` exits 0 even after T-SQL errors. Always add `-b -V 16` in CI/CD pipelines to detect failures.

6. **`sqlpackage BlockOnPossibleDataLoss` default is `true`.** This will abort if a column is being narrowed, a type is changing, or a table is being dropped. Set to `false` only with explicit DBA review — it exists to prevent accidents.

7. **`sqlpackage` drops triggers and statistics as "noise".** By default it deploys statistics objects, which causes needless churn in CI. Add `/p:IgnoreStatistics=true` and `/p:DoNotDropObjectTypes=Statistics` in most CI pipelines.

8. **`OPENROWSET BULK` requires Ad Hoc Distributed Queries.** This is a server-wide setting with security implications. Prefer `BULK INSERT` from a scheduled job over keeping Ad Hoc Distributed Queries permanently enabled.

9. **`bcp` format file column numbers are 1-based** and the `TableColOrder` of `0` means "skip this field". Confusion between these two columns causes silent data misalignment.

10. **Character mode bcp and `DATETIME` format.** `bcp -c` exports dates as locale-dependent strings. Use a format file with `SQLDATETIME` or use `-q` (quoted identifiers) and ensure `SET DATEFORMAT` matches on import. Prefer ISO 8601 format (`yyyy-MM-dd`) in character files.

11. **sqlpackage on Linux needs `--version` check.** The Linux build occasionally lags the Windows build on feature support. Verify version with `sqlpackage /version` before relying on newer publish properties.

12. **`mssql-cli` Python dependency conflicts.** `mssql-cli` requires Python 3.6–3.9 on some platforms. Use a virtual environment to isolate it from system Python packages.

---

## See Also

- [`references/44-backup-restore.md`](44-backup-restore.md) — BACKUP/RESTORE T-SQL reference
- [`references/46-polybase-external-tables.md`](46-polybase-external-tables.md) — S3/Azure Blob external data sources
- [`references/36-data-compression.md`](36-data-compression.md) — Compression and bulk load interaction
- [`references/50-sql-server-agent.md`](50-sql-server-agent.md) — Scheduling bulk jobs via SQL Agent

---

## Sources

[^1]: [Run Transact-SQL Commands with the sqlcmd Utility - SQL Server](https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-utility) — reference for sqlcmd flags, scripting variables, and the Go-based v21+ sqlcmd with Azure AD support
[^2]: [Bulk Copy with bcp Utility - SQL Server](https://learn.microsoft.com/en-us/sql/tools/bcp-utility) — reference for bcp syntax, flags, data modes, format file generation, and performance hints
[^3]: [BULK INSERT (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/bulk-insert-transact-sql) — T-SQL reference for BULK INSERT syntax, WITH options, CSV support (2017+), and S3-compatible storage (2022+)
[^4]: [OPENROWSET (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/openrowset-transact-sql) — reference for OPENROWSET BULK provider including SINGLE_CLOB/SINGLE_BLOB options and Ad Hoc Distributed Queries requirement
[^5]: [SqlPackage - SQL Server](https://learn.microsoft.com/en-us/sql/tools/sqlpackage/sqlpackage) — reference for sqlpackage actions (Publish, Extract, Export, Import, Script, DeployReport, DriftReport) and publish properties
[^6]: [XML Format Files (SQL Server) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/import-export/xml-format-files-sql-server) — reference for XML format file schema, FIELD and COLUMN element attributes, and column reordering/skipping
[^7]: [Prerequisites for Minimal Logging in Bulk Import - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/import-export/prerequisites-for-minimal-logging-in-bulk-import) — covers table and recovery model conditions required for minimal logging during bulk import operations
[^8]: [GitHub - dbcli/mssql-cli: A command-line client for SQL Server with auto-completion and syntax highlighting](https://github.com/dbcli/mssql-cli) — mssql-cli source repository; project is on the path to deprecation, to be replaced by go-sqlcmd
[^9]: [SQL Server PowerShell - SQL Server PowerShell](https://learn.microsoft.com/en-us/powershell/sql-server/sql-server-powershell) — overview of the SqlServer PowerShell module, Invoke-Sqlcmd, Backup-SqlDatabase, and SMO-based cmdlets

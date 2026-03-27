# Export Patterns for ML Pipelines


Patterns for moving feature data out of SQL Server and into the tools your ML pipeline consumes — pandas, Parquet, feature stores, and streaming frameworks.

## Table of Contents

1. [BCP for Large CSV Exports](#bcp-for-large-csv-exports)
2. [pandas.read_sql with pyodbc and SQLAlchemy](#pandasread_sql-with-pyodbc-and-sqlalchemy)
3. [Chunked Reads with OFFSET/FETCH](#chunked-reads-with-offsetfetch)
4. [FOR JSON PATH for Structured Export](#for-json-path-for-structured-export)
5. [OPENROWSET for Parquet (SQL Server 2022+)](#openrowset-for-parquet-sql-server-2022)
6. [Feature Store Refresh Patterns](#feature-store-refresh-patterns)
7. [See Also](#see-also)

---

## BCP for Large CSV Exports


`bcp` (Bulk Copy Program) is the fastest way to export millions of rows from SQL Server to a file. [^1] It connects to SQL Server directly and streams data without going through an application layer.

### Export a query result to CSV

    bcp "SELECT CustomerId, Revenue_7Day, OrderCount_30Day, Recency, Split FROM ML.dbo.FeatureTable" ^
        queryout features.csv ^
        -S myserver ^
        -d ML ^
        -T ^
        -c ^
        -t ","

**Key flags:**
- `queryout` — run a query and write results to file (vs `out` for a full table)
- `-c` — character mode: tab-separated by default, UTF-8 friendly
- `-t ","` — override field terminator to comma
- `-T` — Windows integrated auth; use `-U login -P pass` for SQL auth
- `-r "\n"` — row terminator (default); on Windows, use `-r "\r\n"` if downstream tools expect CRLF

`bcp` does not write column headers. To add headers, write them separately:

    echo CustomerId,Revenue_7Day,OrderCount_30Day,Recency,Split > features_with_header.csv
    bcp "SELECT ..." queryout tmp.csv -S myserver -d ML -T -c -t ","
    type tmp.csv >> features_with_header.csv

Or use `sqlcmd` which can emit headers:

    sqlcmd -S myserver -d ML -T -h -1 -W -s "," ^
           -Q "SET NOCOUNT ON; SELECT 'CustomerId','Revenue_7Day','Split'; SELECT CustomerId, Revenue_7Day, Split FROM FeatureTable" ^
           -o features.csv

### Performance tips

- Add `-b 50000` to commit in batches of 50,000 rows (reduces memory pressure for imports; no effect on export).
- Add `-a 65535` to maximize the network packet size.
- On Linux/macOS, replace `^` line continuation with `\` and use single quotes for the query string.


---

## pandas.read_sql with pyodbc and SQLAlchemy


For moderate-sized datasets (up to a few million rows), `pandas.read_sql` is the most convenient path. [^3] The connection string and chunking behavior are the main configuration points.

### Connection string (pyodbc)

    import pyodbc
    import pandas as pd

    conn = pyodbc.connect(
        "DRIVER={ODBC Driver 18 for SQL Server};"
        "SERVER=myserver;"
        "DATABASE=ML;"
        "Trusted_Connection=yes;"
        # For SQL auth:
        # "UID=myuser;PWD=mypassword;"
        # For Azure SQL:
        # "Authentication=ActiveDirectoryInteractive;"
    )

    df = pd.read_sql("SELECT * FROM dbo.FeatureTable WHERE Split = 'train'", conn)

    conn.close()

### Connection string (SQLAlchemy, recommended for larger queries)

    from sqlalchemy import create_engine
    import pandas as pd

    engine = create_engine(
        "mssql+pyodbc://myserver/ML"
        "?driver=ODBC+Driver+18+for+SQL+Server"
        "&trusted_connection=yes",
        fast_executemany=True   # improves INSERT performance if writing back
    )

    df = pd.read_sql("SELECT * FROM dbo.FeatureTable WHERE Split = 'train'", engine)

### What the driver versions mean

- `ODBC Driver 17` — supports SQL Server 2008–2022; widely installed.
- `ODBC Driver 18` — adds TLS 1.3, Azure AD auth; requires `Encrypt=yes` by default. Add `TrustServerCertificate=yes` for local dev servers.

### Specifying column types on read

SQL Server's `DECIMAL`/`NUMERIC` columns can arrive as Python `Decimal` objects rather than `float`. Force float conversion to avoid downstream surprises:

    df = pd.read_sql(
        "SELECT CustomerId, Revenue, OrderCount FROM dbo.FeatureTable",
        conn,
        dtype={"Revenue": "float64", "OrderCount": "int64"}
    )

---

## Chunked Reads with OFFSET/FETCH


For datasets too large to fit in memory, read in pages using `OFFSET ... FETCH NEXT ... ROWS ONLY`. [^4] This requires an `ORDER BY` clause.

    -- T-SQL pattern for a specific page
    SELECT CustomerId, Revenue_7Day, Label
    FROM dbo.FeatureTable
    ORDER BY CustomerId
    OFFSET 0 ROWS FETCH NEXT 100000 ROWS ONLY;   -- page 1

    -- Next page:
    OFFSET 100000 ROWS FETCH NEXT 100000 ROWS ONLY;   -- page 2

In Python:

    chunk_size = 100_000
    offset = 0
    chunks = []

    while True:
        sql = f"""
            SELECT CustomerId, Revenue_7Day, Label
            FROM dbo.FeatureTable
            ORDER BY CustomerId
            OFFSET {offset} ROWS FETCH NEXT {chunk_size} ROWS ONLY
        """
        chunk = pd.read_sql(sql, conn)
        if chunk.empty:
            break
        chunks.append(chunk)
        offset += chunk_size

    df = pd.concat(chunks, ignore_index=True)

**Use pandas chunked reading:** `pd.read_sql` also accepts a `chunksize` parameter that returns an iterator of DataFrames. The underlying driver fetches rows in batches regardless, but `chunksize` controls when Python materializes them:

    for chunk in pd.read_sql("SELECT ...", conn, chunksize=100_000):
        process(chunk)

> **Gotcha:** Deep `OFFSET` values require SQL Server to scan and discard all preceding rows. For very large tables (>10M rows), partition the export by a range predicate instead:

    -- Partition by Id range instead of OFFSET for deep pages
    SELECT CustomerId, Revenue_7Day, Label
    FROM dbo.FeatureTable
    WHERE CustomerId BETWEEN 1 AND 100000
    ORDER BY CustomerId;

    -- Next batch:
    WHERE CustomerId BETWEEN 100001 AND 200000;

---

## FOR JSON PATH for Structured Export


`FOR JSON PATH` serializes query results as a JSON array. [^2] Useful when downstream consumers expect JSON (REST APIs, document stores, streaming pipelines).

    SELECT
        CustomerId,
        Revenue_7Day    AS revenue7d,
        OrderCount_30Day AS orderCount30d,
        Recency,
        Label
    FROM dbo.FeatureTable
    WHERE Split = 'train'
    FOR JSON PATH;

Output:

    [
        {"CustomerId": 1, "revenue7d": 142.50, "orderCount30d": 3, "Recency": 12, "Label": 0},
        {"CustomerId": 2, "revenue7d": 890.00, "orderCount30d": 11, "Recency": 2, "Label": 1},
        ...
    ]

### Nested JSON (for hierarchical features)

    SELECT
        c.CustomerId,
        c.Region,
        JSON_OBJECT(
            'revenue7d'      : f.Revenue_7Day,
            'orderCount30d'  : f.OrderCount_30Day,
            'recency'        : f.Recency
        ) AS Features,
        f.Label
    FROM Customers c
    JOIN dbo.FeatureTable f ON f.CustomerId = c.CustomerId
    FOR JSON PATH, ROOT('records');

`JSON_OBJECT` is available in SQL Server 2022+. On earlier versions use `FOR JSON PATH` with column aliases and nested table references.

> `FOR JSON PATH` returns results as a single `NVARCHAR(MAX)` column. The maximum length is 2 GB. For very large result sets, paginate with OFFSET/FETCH and concatenate on the client.

---

## OPENROWSET for Parquet (SQL Server 2022+)


SQL Server 2022 can read Parquet files from S3-compatible storage or Azure Blob using `OPENROWSET`. Writing Parquet from SQL Server requires PolyBase external tables.

### Reading Parquet from S3

    -- Step 1: Create a database-scoped credential for S3
    CREATE DATABASE SCOPED CREDENTIAL MyS3Cred
    WITH IDENTITY = 'S3 Access Key',
         SECRET = 'accessKeyId:secretAccessKey';

    -- Step 2: Create an external data source pointing to the S3 bucket
    CREATE EXTERNAL DATA SOURCE MyS3
    WITH (
        LOCATION  = 's3://my-ml-bucket/',
        CREDENTIAL = MyS3Cred
    );

    -- Step 3: Query a Parquet file
    SELECT *
    FROM OPENROWSET(
        BULK 'features/train/part-0001.parquet',
        DATA_SOURCE = 'MyS3',
        FORMAT = 'PARQUET'
    ) WITH (
        CustomerId   INT,
        Revenue_7Day FLOAT,
        Label        INT
    ) AS src;

### Writing to Parquet via external table

    CREATE EXTERNAL FILE FORMAT ParquetFmt
    WITH (FORMAT_TYPE = PARQUET, DATA_COMPRESSION = 'org.apache.hadoop.io.compress.SnappyCodec');

    CREATE EXTERNAL TABLE dbo.FeatureExport (
        CustomerId   INT,
        Revenue_7Day FLOAT,
        Label        INT
    )
    WITH (
        LOCATION     = 'features/export/',
        DATA_SOURCE  = MyS3,
        FILE_FORMAT  = ParquetFmt
    );

    INSERT INTO dbo.FeatureExport
    SELECT CustomerId, Revenue_7Day, Label
    FROM dbo.FeatureTable
    WHERE Split = 'train';

> PolyBase requires the PolyBase feature to be installed and the `PolyBase Data Movement Service` running. Verify with `SELECT * FROM sys.configurations WHERE name = 'hadoop connectivity'`.

---

## Feature Store Refresh Patterns


A feature store is a materialized table (or set of tables) that holds pre-computed features for every entity at a known point in time. Queries at training and inference time read from the feature store rather than recomputing features on the fly.

### Materialized feature table

    -- Create the feature table once
    CREATE TABLE dbo.CustomerFeatureStore (
        CustomerId      INT           NOT NULL,
        SnapshotDate    DATE          NOT NULL,
        Revenue_7Day    FLOAT,
        Revenue_30Day   FLOAT,
        OrderCount_90Day INT,
        Recency          INT,
        Label            BIT,
        CreatedAt        DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_CustomerFeatureStore PRIMARY KEY NONCLUSTERED (CustomerId, SnapshotDate)
    );

    -- Refresh stored procedure: called daily by SQL Agent or an external orchestrator
    CREATE OR ALTER PROCEDURE dbo.RefreshCustomerFeatures_ut
        @SnapshotDate DATE = NULL
    AS
    BEGIN
        SET @SnapshotDate = COALESCE(@SnapshotDate, CAST(SYSUTCDATETIME() AS DATE));

        -- Delete and reinsert for this snapshot date (idempotent)
        DELETE FROM dbo.CustomerFeatureStore WHERE SnapshotDate = @SnapshotDate;

        INSERT INTO dbo.CustomerFeatureStore (CustomerId, SnapshotDate, Revenue_7Day,
                                              Revenue_30Day, OrderCount_90Day, Recency, Label)
        SELECT
            CustomerId,
            @SnapshotDate,
            SUM(CASE WHEN OrderDate >= DATEADD(DAY, -7, @SnapshotDate)
                     THEN OrderAmount ELSE 0 END)               AS Revenue_7Day,
            SUM(CASE WHEN OrderDate >= DATEADD(DAY, -30, @SnapshotDate)
                     THEN OrderAmount ELSE 0 END)               AS Revenue_30Day,
            COUNT(CASE WHEN OrderDate >= DATEADD(DAY, -90, @SnapshotDate)
                       THEN 1 END)                              AS OrderCount_90Day,
            DATEDIFF(DAY, MAX(OrderDate), @SnapshotDate)        AS Recency,
            MAX(CASE WHEN Churned = 1 THEN 1 ELSE 0 END)        AS Label
        FROM Orders
        WHERE OrderDate < @SnapshotDate
        GROUP BY CustomerId;
    END;

### Incremental refresh with HASHBYTES change detection

For large feature stores, detect which entities have changed and recompute only those:

    -- Compute a row hash for each entity
    SELECT
        CustomerId,
        HASHBYTES('SHA2_256', CONCAT_WS('|',
            CAST(Revenue_7Day AS NVARCHAR(20)),
            CAST(OrderCount_30Day AS NVARCHAR(20)),
            CAST(Recency AS NVARCHAR(20))
        )) AS FeatureHash
    FROM dbo.CustomerFeatureStore
    WHERE SnapshotDate = @PreviousDate;

    -- Compare to current computation and update only changed rows
    MERGE dbo.CustomerFeatureStore AS target
    USING NewFeatures AS source
    ON target.CustomerId = source.CustomerId
       AND target.SnapshotDate = @SnapshotDate
    WHEN MATCHED AND target.FeatureHash <> source.FeatureHash
        THEN UPDATE SET ...
    WHEN NOT MATCHED BY TARGET
        THEN INSERT ...;

`CONCAT_WS('|', ...)` concatenates all feature values with a pipe delimiter. `HASHBYTES('SHA2_256', ...)` produces a deterministic 32-byte hash [^5] — if the hash matches, the row has not changed and can be skipped.

### Columnstore index on the feature store

Feature store reads are analytical (scan all rows for a training run). A clustered columnstore index provides 5–10× compression and batch-mode execution for aggregate queries:

    CREATE CLUSTERED COLUMNSTORE INDEX CCI_CustomerFeatureStore
    ON dbo.CustomerFeatureStore;


---

## See Also

- [sampling-splitting.md](sampling-splitting.md) — splitting before export
- [null-imputation.md](null-imputation.md) — imputing NULLs before or after export
- [data-leakage.md](data-leakage.md) — ensuring the feature store does not include future data

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.

[^1]: [bcp Utility - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/tools/bcp-utility) — bulk copy program syntax, flags (-c, -t, -T, queryout), format files, and performance hints (TABLOCK, ORDER)
[^2]: [Format Query Results as JSON with FOR JSON - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/json/format-query-results-as-json-with-for-json-sql-server) — FOR JSON PATH and AUTO modes, ROOT wrapper, nested output via column aliases
[^3]: [Python SQL Driver - pyodbc quickstart | Microsoft Learn](https://learn.microsoft.com/en-us/sql/connect/python/pyodbc/python-sql-driver-pyodbc-quickstart) — pyodbc connection to SQL Server with ODBC Driver 17/18, example queries
[^4]: [ORDER BY Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-order-by-clause-transact-sql) — OFFSET/FETCH pagination syntax; deep offset performance considerations
[^5]: [HASHBYTES (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/hashbytes-transact-sql) — SHA2_256 for row-level change detection in incremental feature store refresh patterns

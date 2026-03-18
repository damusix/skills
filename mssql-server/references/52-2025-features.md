# SQL Server 2025 New Features

## Table of Contents

1. [When to Use This File](#when-to-use-this-file)
2. [Release Overview](#release-overview)
3. [Compatibility Level 170](#compatibility-level-170)
4. [Preview Features Flag](#preview-features-flag)
5. [VECTOR Data Type](#vector-data-type)
6. [Vector Functions](#vector-functions)
7. [Vector Indexes and VECTOR_SEARCH](#vector-indexes-and-vector_search)
8. [External Models](#external-models)
9. [AI Text Processing Functions](#ai-text-processing-functions)
10. [Native JSON Data Type](#native-json-data-type)
11. [JSON Aggregate Functions](#json-aggregate-functions)
12. [sp_invoke_external_rest_endpoint](#sp_invoke_external_rest_endpoint)
13. [Regular Expression Functions](#regular-expression-functions)
14. [Fuzzy String Matching](#fuzzy-string-matching)
15. [New T-SQL Functions and Syntax](#new-t-sql-functions-and-syntax)
16. [Optimized Locking](#optimized-locking)
17. [Engine and Performance Changes](#engine-and-performance-changes)
18. [Backup Improvements — ZSTD Compression](#backup-improvements--zstd-compression)
19. [Edition Changes](#edition-changes)
20. [Feature GA vs Preview Matrix](#feature-ga-vs-preview-matrix)
21. [Azure SQL Comparison](#azure-sql-comparison)
22. [Upgrade Checklist](#upgrade-checklist)
23. [Gotchas](#gotchas)
24. [See Also](#see-also)
25. [Sources](#sources)

---

## When to Use This File

Load this file when the user asks about:
- SQL Server 2025 or version 17.x features
- `VECTOR` data type, vector search, or AI workloads in SQL Server
- `CREATE EXTERNAL MODEL`, `AI_GENERATE_EMBEDDINGS`, or RAG pipelines in T-SQL
- Native `JSON` data type (not varchar/nvarchar storing JSON text)
- Regular expressions in T-SQL (`REGEXP_LIKE`, `REGEXP_REPLACE`, etc.)
- `sp_invoke_external_rest_endpoint`
- Fuzzy string matching (`EDIT_DISTANCE`, `JARO_WINKLER_SIMILARITY`)
- Optimized locking, ZSTD backup compression, or tempdb ADR
- SQL Server 2025 edition/licensing changes
- What is preview vs GA in SQL Server 2025

For SQL Server 2022 features, see [`51-2022-features.md`](51-2022-features.md).

---

## Release Overview

| Property | Value |
|---|---|
| Version | 17.0 |
| Build | 17.0.1000.7 |
| GA Date | November 18, 2025 |
| Default Compat Level | 170 |
| Platform | Windows, Linux, containers |

SQL Server 2025 is the most AI-focused SQL Server release to date. The headline features are the native `VECTOR` data type, external model integration for embedding generation and inference, and native `JSON` column type. Alongside AI features, it ships significant T-SQL language additions (regex, fuzzy matching, new aggregate functions), engine improvements (optimized locking, ZSTD backup compression, tempdb ADR), and edition changes that expand Standard edition capabilities.

---

## Compatibility Level 170

> [!NOTE] SQL Server 2025
> Compatibility level 170 is required for some 2025 features. The database remains at its current compat level after upgrade — you must manually raise it.

```sql
-- Check current compat level
SELECT name, compatibility_level
FROM sys.databases
WHERE name = DB_NAME();

-- Raise to 170 after testing
ALTER DATABASE YourDatabase
SET COMPATIBILITY_LEVEL = 170;
```

Features that require compat 170 are called out in each section below. Many 2025 features (VECTOR, external models, regex functions) do **not** require compat 170 — they are engine-level additions available at any compat level.

---

## Preview Features Flag

Some 2025 features require an explicit opt-in at the database level:

```sql
-- Enable preview features for a single database
ALTER DATABASE SCOPED CONFIGURATION
    SET PREVIEW_FEATURES = ON;

-- Check current setting
SELECT name, value
FROM sys.database_scoped_configurations
WHERE name = 'PREVIEW_FEATURES';
```

> [!WARNING] Preview features are not covered by standard support SLAs and may change between builds. Enable `PREVIEW_FEATURES` in dev/test first; review release notes before enabling in production.

Features requiring `PREVIEW_FEATURES = ON` are marked **[Preview]** in this document. All others are **[GA]**.

---

## VECTOR Data Type

> [!NOTE] SQL Server 2025
> The `VECTOR` data type is GA in SQL Server 2025.[^1]

`VECTOR` stores a fixed-dimension array of floating-point values in an optimized binary format. It is surfaced to clients as a JSON array of numbers.

### Declaring a VECTOR column

```sql
CREATE TABLE dbo.ProductEmbeddings (
    product_id      INT          NOT NULL PRIMARY KEY,
    name            NVARCHAR(200) NOT NULL,
    -- 1536 dimensions = text-embedding-3-small (OpenAI)
    embedding       VECTOR(1536) NOT NULL
);
```

The dimension is fixed at column definition and cannot be altered afterwards (you must rebuild the table).

### Supported element types

| Type | Storage per element | Status |
|---|---|---|
| `float32` (default) | 4 bytes | GA |
| `float16` (half-precision) | 2 bytes | Preview |

The total storage is `dimensions × bytes_per_element + small fixed overhead`. A `VECTOR(1536)` with `float32` costs ~6 KB per row.

### Inserting vectors

```sql
-- Insert from a literal JSON array
INSERT INTO dbo.ProductEmbeddings (product_id, name, embedding)
VALUES (1, 'Hiking Boots',
        CAST('[0.012, -0.034, 0.091, ...]' AS VECTOR(1536)));

-- Verify
SELECT product_id, name,
       CAST(embedding AS NVARCHAR(MAX)) AS embedding_json
FROM dbo.ProductEmbeddings
WHERE product_id = 1;
```

> [!NOTE] Client applications pass vectors as JSON arrays (`'[0.1, 0.2, ...]'`). The engine stores them internally in a compact binary format. Casting back to `NVARCHAR(MAX)` returns the JSON array representation.

### Standard index on VECTOR columns

You cannot create a standard B-tree index with `VECTOR` as a key column. You can INCLUDE it:

```sql
-- INCLUDE is allowed
CREATE NONCLUSTERED INDEX IX_ProductEmbeddings_ProductId
    ON dbo.ProductEmbeddings (product_id)
    INCLUDE (embedding);
```

For similarity search, use a vector index (see [Vector Indexes](#vector-indexes-and-vector_search)).

### Metadata

```sql
-- Find all VECTOR columns in the current database
SELECT
    SCHEMA_NAME(t.schema_id)    AS schema_name,
    t.name                      AS table_name,
    c.name                      AS column_name,
    VECTORPROPERTY(c.column_id, 'Dimensions') AS dimensions,
    VECTORPROPERTY(c.column_id, 'BaseType')   AS base_type
FROM sys.columns c
JOIN sys.tables  t ON c.object_id = t.object_id
WHERE c.system_type_id = TYPE_ID('vector');
```

---

## Vector Functions

> [!NOTE] SQL Server 2025
> All standard vector functions are GA.[^2]

### VECTOR_DISTANCE

Computes the distance between two vectors of the same dimension.

```sql
-- Find the 10 nearest products to a given query vector
DECLARE @query VECTOR(1536) = CAST('[...]' AS VECTOR(1536));

SELECT TOP (10)
    product_id,
    name,
    VECTOR_DISTANCE('cosine', embedding, @query) AS distance
FROM dbo.ProductEmbeddings
ORDER BY distance ASC;
```

**Supported metrics:**

| Metric | String | When to use |
|---|---|---|
| Cosine distance | `'cosine'` | Text/document similarity (most common for embeddings) |
| Euclidean (L2) | `'euclidean'` | Geometric/spatial proximity |
| L1 (Manhattan) | `'L1'` | Sparse feature vectors |
| Dot product | `'dot'` | Embeddings already normalized to unit length |
| Hamming | `'hamming'` | Binary/categorical vectors |

> [!NOTE] Cosine distance returns values in [0, 2] where 0 = identical and 2 = opposite. Dot product for normalized unit vectors equals `1 - cosine_similarity`.

### VECTOR_NORM

Returns the Euclidean (L2) magnitude of a vector.

```sql
SELECT VECTOR_NORM(embedding) AS l2_magnitude
FROM dbo.ProductEmbeddings
WHERE product_id = 1;
```

### VECTOR_NORMALIZE

Returns a unit-length (L2-normalized) vector.

```sql
-- Normalize before storing if using dot product similarity
UPDATE dbo.ProductEmbeddings
SET embedding = VECTOR_NORMALIZE(embedding);
```

### VECTORPROPERTY

Returns metadata about a vector column or variable.

```sql
-- Dimensions of a column
SELECT VECTORPROPERTY(c.column_id, 'Dimensions')
FROM sys.columns c
JOIN sys.tables  t ON c.object_id = t.object_id
WHERE t.name = 'ProductEmbeddings' AND c.name = 'embedding';

-- On a variable
DECLARE @v VECTOR(3) = CAST('[1,2,3]' AS VECTOR(3));
SELECT VECTORPROPERTY(@v, 'Dimensions'); -- returns 3
```

---

## Vector Indexes and VECTOR_SEARCH

> [!NOTE] SQL Server 2025
> Vector indexes and `VECTOR_SEARCH` are **[Preview]** — requires `PREVIEW_FEATURES = ON`.[^3]

Standard `VECTOR_DISTANCE` with `ORDER BY` performs an exact (brute-force) search scanning all rows. For large tables you need an **Approximate Nearest Neighbor (ANN) index**.

### Creating a vector index

```sql
ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON;

CREATE VECTOR INDEX IX_ProductEmbeddings_cosine
    ON dbo.ProductEmbeddings (embedding)
    WITH (METRIC = 'cosine');
```

Only one metric is supported per vector index. If you need multiple metrics on the same column, create multiple vector indexes.

### VECTOR_SEARCH

```sql
-- ANN search using the vector index
SELECT v.product_id, v.name, s.distance
FROM VECTOR_SEARCH(
    TABLE dbo.ProductEmbeddings AS v,
    COLUMN embedding,
    SIMILAR_TO = CAST('[...]' AS VECTOR(1536)),
    METRIC = 'cosine',
    TOP_N = 10
) AS s;
```

`VECTOR_SEARCH` is a table-valued function that returns the approximate top-N neighbors with a `distance` column. Filter the outer query to restrict results beyond distance:

```sql
SELECT v.product_id, v.name, s.distance
FROM VECTOR_SEARCH(
    TABLE dbo.ProductEmbeddings AS v,
    COLUMN embedding,
    SIMILAR_TO = @query_vector,
    METRIC = 'cosine',
    TOP_N = 50
) AS s
JOIN dbo.Products p ON v.product_id = p.product_id
WHERE p.category = 'Footwear'
  AND s.distance < 0.3
ORDER BY s.distance;
```

> [!NOTE] ANN results are approximate — a small fraction of true nearest neighbors may be missed. For compliance or financial applications requiring exact search, use `VECTOR_DISTANCE` with `ORDER BY` instead.

### Catalog view

```sql
SELECT * FROM sys.vector_indexes;
```

---

## External Models

> [!NOTE] SQL Server 2025
> `CREATE EXTERNAL MODEL` and related DDL are GA.[^4]

External models let you register REST-based AI inference endpoints (Azure OpenAI, Ollama, any OpenAI-compatible API) and call them from T-SQL. They power `AI_GENERATE_EMBEDDINGS` and inference stored procedures.

### Registering an external model

```sql
-- Create a credential for the API key
CREATE DATABASE SCOPED CREDENTIAL MyAOAICredential
    WITH IDENTITY = 'HTTPEndpointHeaders',
         SECRET = '{"api-key": "YOUR_AZURE_OPENAI_KEY"}';

-- Register the embedding model
CREATE EXTERNAL MODEL MyEmbeddingModel
    WITH (
        LOCATION    = 'https://myaccount.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-02-01',
        API_FORMAT  = 'Azure_OpenAI',
        MODEL_TYPE  = EMBEDDINGS,
        CREDENTIAL  = MyAOAICredential
    );

-- Register a chat/completion model
CREATE EXTERNAL MODEL MyChatModel
    WITH (
        LOCATION    = 'https://myaccount.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01',
        API_FORMAT  = 'Azure_OpenAI',
        MODEL_TYPE  = GENERATIVE,
        CREDENTIAL  = MyAOAICredential
    );
```

**API_FORMAT values:** `'Azure_OpenAI'`, `'OpenAI'` (OpenAI.com or compatible), `'Ollama'`

### Altering and dropping

```sql
ALTER EXTERNAL MODEL MyEmbeddingModel
    WITH (CREDENTIAL = NewCredential);

DROP EXTERNAL MODEL MyEmbeddingModel;
```

### Catalog view

```sql
SELECT name, model_type_desc, location, api_format_desc
FROM sys.external_models;
```

---

## AI Text Processing Functions

> [!NOTE] SQL Server 2025
> `AI_GENERATE_CHUNKS` and `AI_GENERATE_EMBEDDINGS` are GA.[^5]

### AI_GENERATE_CHUNKS — Text chunking for RAG

Splits a document into overlapping or non-overlapping text chunks suitable for embedding and retrieval-augmented generation (RAG).

```sql
-- Chunk a document column
SELECT
    doc_id,
    c.chunk_text,
    c.chunk_number
FROM dbo.Documents d
CROSS APPLY AI_GENERATE_CHUNKS(
    d.content,
    JSON_OBJECT(
        'chunk_size': 512,       -- target tokens per chunk
        'overlap_size': 50,      -- token overlap between chunks
        'tokenizer': 'cl100k'    -- tokenizer (cl100k = GPT-4, tiktoken)
    )
) AS c;
```

### AI_GENERATE_EMBEDDINGS — Call an external model for embeddings

```sql
-- Generate and store embeddings from an external model
UPDATE dbo.Documents
SET embedding = (
    SELECT CAST(e.embedding AS VECTOR(1536))
    FROM AI_GENERATE_EMBEDDINGS(content USING MyEmbeddingModel) AS e
)
WHERE embedding IS NULL;
```

### Full RAG pipeline pattern

```sql
-- 1. Chunk documents
INSERT INTO dbo.DocumentChunks (doc_id, chunk_text, chunk_number)
SELECT d.doc_id, c.chunk_text, c.chunk_number
FROM dbo.Documents d
CROSS APPLY AI_GENERATE_CHUNKS(d.content, '{"chunk_size":512,"overlap_size":50}') AS c;

-- 2. Generate embeddings for chunks
UPDATE dbo.DocumentChunks
SET embedding = (
    SELECT CAST(e.embedding AS VECTOR(1536))
    FROM AI_GENERATE_EMBEDDINGS(chunk_text USING MyEmbeddingModel) AS e
)
WHERE embedding IS NULL;

-- 3. Retrieve top-K relevant chunks for a query
DECLARE @query_text NVARCHAR(1000) = 'How do I configure TLS?';
DECLARE @query_vec  VECTOR(1536);

SELECT @query_vec = CAST(e.embedding AS VECTOR(1536))
FROM AI_GENERATE_EMBEDDINGS(@query_text USING MyEmbeddingModel) AS e;

SELECT TOP (5)
    dc.chunk_text,
    VECTOR_DISTANCE('cosine', dc.embedding, @query_vec) AS distance
FROM dbo.DocumentChunks dc
ORDER BY distance ASC;
```

---

## Native JSON Data Type

> [!NOTE] SQL Server 2025
> The native `JSON` data type is GA in SQL Server 2025 (was Preview in early builds; GA in Azure SQL Database/MI earlier).[^6]

The native `JSON` type stores JSON documents in a binary format (internally similar to BSON/UTF-8 pre-parsed). It is *not* `NVARCHAR(MAX)` — it is a distinct type with its own OID.

### Key differences from storing JSON in NVARCHAR(MAX)

| Aspect | `NVARCHAR(MAX)` | `JSON` type |
|---|---|---|
| Storage format | UTF-16 text | Internal binary (UTF-8) |
| Validation | None at column level | Valid JSON enforced |
| Reads | Parse on every access | Pre-parsed binary |
| In-place update | Rewrites entire column | `modify()` [Preview] for small changes |
| Compression | TEXT compression | Better compression |
| Size limit | 2 GB | 2 GB |
| Nesting depth | Unlimited | 128 levels |
| Index | INCLUDE only | INCLUDE only (no key column) |

### Creating and using a JSON column

```sql
CREATE TABLE dbo.Events (
    event_id    BIGINT  NOT NULL PRIMARY KEY,
    occurred_at DATETIME2 NOT NULL,
    payload     JSON    NOT NULL
);

-- Insert — pass a valid JSON string
INSERT INTO dbo.Events (event_id, occurred_at, payload)
VALUES (1, SYSDATETIME(),
        '{"type":"click","page":"/home","user_id":42}');

-- Query scalar values (same JSON_VALUE syntax as before)
SELECT event_id,
       JSON_VALUE(payload, '$.type')    AS event_type,
       JSON_VALUE(payload, '$.user_id') AS user_id
FROM dbo.Events
WHERE JSON_VALUE(payload, '$.type') = 'click';
```

> [!NOTE] `JSON_VALUE`, `JSON_QUERY`, `OPENJSON`, `JSON_PATH_EXISTS`, `JSON_MODIFY`, and all 2022 JSON functions work on `JSON` columns without casting. The engine handles the type internally.

### Explicit cast for older APIs

Some older ADO.NET drivers send `JSON` columns as `NVARCHAR(MAX)` over TDS. If you need to read back as text:

```sql
SELECT CAST(payload AS NVARCHAR(MAX)) AS payload_text
FROM dbo.Events;
```

### JSON column modify method [Preview]

```sql
-- In-place update of a single JSON field
UPDATE dbo.Events
SET payload.modify('$.user_id', 99)
WHERE event_id = 1;
```

Only possible when the new value fits in the existing allocated space; falls back to full rewrite otherwise.

---

## JSON Aggregate Functions

> [!NOTE] SQL Server 2025
> `JSON_OBJECTAGG` and `JSON_ARRAYAGG` are GA.[^7]

### JSON_OBJECTAGG

Builds a JSON object by aggregating key/value pairs across rows.

```sql
-- Produce {"prod_1":"Widget","prod_2":"Gadget"} per category
SELECT
    category,
    JSON_OBJECTAGG('prod_' + CAST(product_id AS VARCHAR) VALUE name
                   ABSENT ON NULL) AS product_map
FROM dbo.Products
GROUP BY category;
```

`ABSENT ON NULL` omits entries where the value is NULL. Use `NULL ON NULL` (default) to include `"key": null`.

### JSON_ARRAYAGG

Builds a JSON array from values across rows.

```sql
-- Produce ["Widget","Gadget","Doohickey"] per category
SELECT
    category,
    JSON_ARRAYAGG(name ORDER BY name ABSENT ON NULL) AS product_names
FROM dbo.Products
GROUP BY category;
```

`ORDER BY` inside `JSON_ARRAYAGG` controls element order within the array.

---

## sp_invoke_external_rest_endpoint

> [!NOTE] SQL Server 2025
> GA. Originally available in Azure SQL Database; now available on-prem.[^8]

Calls REST or GraphQL endpoints from T-SQL — useful for integrating with Azure OpenAI, custom inference endpoints, webhooks, or external services.

```sql
DECLARE @response NVARCHAR(MAX);
DECLARE @status   INT;

EXEC sp_invoke_external_rest_endpoint
    @url         = N'https://api.example.com/classify',
    @method      = N'POST',
    @headers     = N'{"Content-Type":"application/json","Authorization":"Bearer TOKEN"}',
    @payload     = N'{"text":"Classify this product description."}',
    @response    = @response OUTPUT,
    @status_code = @status   OUTPUT;

-- Handle the response
IF @status BETWEEN 200 AND 299
    SELECT JSON_VALUE(@response, '$.result') AS classification;
ELSE
    THROW 50001, 'REST call failed', 1;
```

**Key parameters:**

| Parameter | Type | Description |
|---|---|---|
| `@url` | `NVARCHAR(4000)` | Full URL of the endpoint |
| `@method` | `NVARCHAR(10)` | HTTP verb: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `@headers` | `NVARCHAR(MAX)` | JSON object of HTTP headers |
| `@payload` | `NVARCHAR(MAX)` | Request body (JSON or text) |
| `@response` | `NVARCHAR(MAX) OUTPUT` | Response body |
| `@status_code` | `INT OUTPUT` | HTTP status code |
| `@timeout` | `INT` | Timeout in seconds (default 30) |
| `@credential` | `SYSNAME` | DATABASE SCOPED CREDENTIAL for auth |

> [!WARNING] `sp_invoke_external_rest_endpoint` makes synchronous HTTP calls inside a SQL transaction context. Long HTTP latencies will hold locks. Use in job steps or background procedures — avoid calling from high-concurrency OLTP paths.

---

## Regular Expression Functions

> [!NOTE] SQL Server 2025
> All `REGEXP_*` functions are GA.[^9]

SQL Server 2025 adds native regex support using the ICU regex library (same as most modern languages). Syntax follows POSIX ERE / Perl-compatible patterns.

### REGEXP_LIKE — boolean match test

```sql
-- Find emails in a column
SELECT customer_id, email
FROM dbo.Customers
WHERE REGEXP_LIKE(email, N'^[^@]+@[^@]+\.[^@]+$') = 1;

-- Use in a CHECK constraint
ALTER TABLE dbo.Customers
ADD CONSTRAINT CK_Customers_Email
    CHECK (email IS NULL OR REGEXP_LIKE(email, N'^[^@]+@[^@]+\.[^@]+$') = 1);
```

### REGEXP_REPLACE — replace matches

```sql
-- Redact US phone numbers
SELECT REGEXP_REPLACE(notes, N'\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b', N'XXX-XXX-XXXX')
FROM dbo.CustomerNotes;

-- Third argument: replacement string (literal, not a back-reference by default)
-- Fourth argument: occurrence (1 = first only, 0 = all; default 0)
SELECT REGEXP_REPLACE('aabbcc', N'b+', N'X', 1);  -- 'aaXbcc' (first match)
SELECT REGEXP_REPLACE('aabbcc', N'b+', N'X', 0);  -- 'aaXcc'  (all matches)
```

### REGEXP_SUBSTR — extract a match

```sql
-- Extract ISO date from free text
SELECT REGEXP_SUBSTR(log_line, N'\d{4}-\d{2}-\d{2}') AS extracted_date
FROM dbo.Logs;

-- Optional: occurrence number and capture group
SELECT REGEXP_SUBSTR('foo bar baz', N'\w+', 1, 2) -- 'bar' (second match)
```

### REGEXP_INSTR — position of a match

```sql
-- Returns the start position (1-based) of first match, 0 if no match
SELECT REGEXP_INSTR(description, N'\d+') AS first_number_pos
FROM dbo.Products;
```

### REGEXP_COUNT — count matches

```sql
-- Count occurrences of 'error' (case-insensitive) in a log line
SELECT REGEXP_COUNT(log_line, N'(?i)error') AS error_count
FROM dbo.Logs;
```

### REGEXP_MATCHES — extract all matches as rows (TVF)

```sql
-- Shred all hashtags from a tweet
SELECT m.match_value, m.match_position
FROM dbo.Tweets t
CROSS APPLY REGEXP_MATCHES(t.content, N'#\w+') AS m;
```

### REGEXP_SPLIT_TO_TABLE — split on a pattern (TVF)

```sql
-- Split on any whitespace or comma
SELECT s.value, s.ordinal
FROM dbo.Tags t
CROSS APPLY REGEXP_SPLIT_TO_TABLE(t.tag_list, N'[\s,]+') AS s
WHERE s.value <> '';
```

### Common regex flags (ICU)

| Flag | Meaning |
|---|---|
| `(?i)` | Case-insensitive |
| `(?m)` | Multiline — `^`/`$` match line boundaries |
| `(?s)` | Dotall — `.` matches newline |
| `(?x)` | Extended — whitespace/comments in pattern |

---

## Fuzzy String Matching

> [!NOTE] SQL Server 2025
> `EDIT_DISTANCE`, `EDIT_DISTANCE_SIMILARITY`, `JARO_WINKLER_DISTANCE`, and `JARO_WINKLER_SIMILARITY` are **[Preview]** — requires `PREVIEW_FEATURES = ON`.[^10]

### EDIT_DISTANCE / EDIT_DISTANCE_SIMILARITY

Levenshtein edit distance (number of single-character edits).

```sql
ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON;

-- Raw edit distance
SELECT EDIT_DISTANCE('kitten', 'sitting'); -- returns 3

-- Normalized similarity 0–100 (higher = more similar)
SELECT EDIT_DISTANCE_SIMILARITY('kitten', 'sitting'); -- returns 57 (approx)

-- Find near-duplicate customer names
SELECT a.customer_id, a.name, b.customer_id, b.name,
       EDIT_DISTANCE_SIMILARITY(a.name, b.name) AS similarity
FROM dbo.Customers a
JOIN dbo.Customers b ON a.customer_id < b.customer_id
WHERE EDIT_DISTANCE_SIMILARITY(a.name, b.name) > 80
ORDER BY similarity DESC;
```

### JARO_WINKLER_DISTANCE / JARO_WINKLER_SIMILARITY

Jaro-Winkler distance is better suited for short strings where transpositions are common (names, addresses).

```sql
-- Distance: 0.0 = identical, 1.0 = completely different
SELECT JARO_WINKLER_DISTANCE('MARTHA', 'MARHTA');   -- ~0.0389 (very similar)
SELECT JARO_WINKLER_DISTANCE('JONES', 'JOHNSON');   -- ~0.168

-- Similarity: 0–100 (integer scale)
SELECT JARO_WINKLER_SIMILARITY('MARTHA', 'MARHTA'); -- ~96
SELECT JARO_WINKLER_SIMILARITY('JONES',  'JOHNSON'); -- ~83
```

**When to use which:**

| Use case | Function |
|---|---|
| Typo detection, free-text similarity | `EDIT_DISTANCE_SIMILARITY` |
| Name/address matching, deduplication | `JARO_WINKLER_SIMILARITY` |
| Spell check, autocorrect | `EDIT_DISTANCE` |

---

## New T-SQL Functions and Syntax

> [!NOTE] SQL Server 2025
> All items in this section are GA unless marked [Preview].[^11]

### CURRENT_DATE

ANSI-standard, returns the current date without a time component. Equivalent to `CAST(GETDATE() AS DATE)`.

```sql
SELECT CURRENT_DATE;       -- returns 2025-11-18 (no time)
SELECT GETDATE();          -- returns 2025-11-18 14:32:07.123 (with time)
```

### PRODUCT() aggregate

Computes the mathematical product of a set of values. NULL values are ignored.

```sql
-- Running product of growth rates
SELECT
    year,
    growth_rate,
    PRODUCT(growth_rate) OVER (ORDER BY year) AS cumulative_return
FROM dbo.AnnualReturns;

-- Total product in a group
SELECT category, PRODUCT(weight_factor) AS combined_weight
FROM dbo.Factors
GROUP BY category;
```

### BASE64_ENCODE / BASE64_DECODE

```sql
-- Encode binary to Base64 string
SELECT BASE64_ENCODE(0x48656C6C6F);  -- returns 'SGVsbG8='

-- Decode Base64 string back to binary
SELECT BASE64_DECODE('SGVsbG8=');   -- returns 0x48656C6C6F

-- Encode a string
SELECT BASE64_ENCODE(CAST('Hello' AS VARBINARY(MAX))); -- 'SGVsbG8='
```

### UNISTR

Returns a Unicode string from Unicode code point escape sequences. Useful for inserting characters by codepoint.

```sql
-- Euro sign U+20AC
SELECT UNISTR(N'\20AC');    -- returns '€'

-- Mix literal and escape
SELECT UNISTR(N'Price: \20AC 9.99'); -- returns 'Price: € 9.99'
```

### `||` string concatenation operator

ANSI SQL double-pipe concatenation. Equivalent to `+`, but propagates NULL differently — same behavior as `CONCAT()` (NULL treated as empty string).

```sql
SELECT first_name || ' ' || last_name AS full_name
FROM dbo.Customers;

-- NULL propagation
SELECT NULL || 'hello';   -- returns 'hello' (like CONCAT, not like +)
SELECT NULL + 'hello';    -- returns NULL    (original + behavior)
```

### SUBSTRING with optional length

`length` is now optional in `SUBSTRING`. Omitting it returns the remainder of the string.

```sql
-- Previously required: SUBSTRING(col, 5, LEN(col))
-- Now:
SELECT SUBSTRING(description, 5) AS trimmed
FROM dbo.Products;
```

### DATEADD with bigint

```sql
-- Previously limited to INT; now accepts BIGINT for nanosecond-precision work
DECLARE @ns BIGINT = 9000000000000;
SELECT DATEADD(nanosecond, @ns, '2025-01-01');
```

---

## Optimized Locking

> [!NOTE] SQL Server 2025
> Optimized locking is GA. It was available in Azure SQL Database earlier.[^12]

Optimized locking reduces blocking and lock memory for DML operations by changing how row locks are acquired and released during statement execution. Key behaviors:

- **Transaction ID (TID) locking**: A single TID lock per transaction replaces per-row X locks under most circumstances, reducing the number of locks in memory.
- **Lock After Qualification (LAQ)**: Rows are locked only after the engine determines they satisfy the predicate — preventing unnecessary locks on rows that will be skipped.

```sql
-- Check whether optimized locking is active
SELECT * FROM sys.dm_tran_locks WHERE -- reduced row count expected
-- No configuration needed — automatic when compat level 160+ and RCSI enabled

-- Verify it is active
SELECT optimized_locking_enabled
FROM sys.databases
WHERE name = DB_NAME();
```

**Requirements:**
- RCSI (`READ_COMMITTED_SNAPSHOT = ON`) must be enabled on the database
- Compatibility level 160 or higher

**What it does NOT change:**
- Serializable isolation — still uses key-range locks
- Explicit lock hints (`UPDLOCK`, `HOLDLOCK`) — still honored
- Deadlock detection — still operates normally

> [!NOTE] If you have applications that rely on `NOLOCK` hints to work around lock contention, optimized locking may allow you to remove those hints safely. Test thoroughly — `NOLOCK` reads dirty data; removing it changes semantics.

---

## Engine and Performance Changes

> [!NOTE] SQL Server 2025

### Tempdb ADR (Accelerated Database Recovery)

ADR now applies to tempdb, not just user databases. Prior to 2025, version store cleanup in tempdb could cause long-running version cleanup or blocking during transaction rollback involving temp objects.

```sql
-- No configuration needed — automatic
-- Monitor version store in tempdb
SELECT * FROM sys.dm_tran_version_store_space_usage
WHERE database_id = 2; -- tempdb is always DB ID 2
```

### Columnstore improvements

- **Ordered nonclustered columnstore indexes**: The non-clustered version now supports ORDER keys for better segment elimination.
- **Online ordered columnstore rebuild**: Can rebuild ordered CCI online without taking the table offline.

```sql
-- Create an ordered NCCI (new in 2025)
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Sales_Ordered
    ON dbo.Sales (order_date, region_id, amount)
    ORDER (order_date);
```

### Persisted statistics on readable AG secondaries

Statistics are now created and persisted on readable AG secondaries. Previously statistics could only be created in `tempdb` on secondaries (using the `AUTOUPDATE_STATISTICS_ASYNC_SECONDARY` trace flag or feature).

```sql
-- No special configuration needed
-- Statistics are persisted automatically on 2025+ secondaries
```

### DOP Feedback on by default

In SQL Server 2022, DOP Feedback (reducing parallel degree based on observed overhead) was off by default. In SQL Server 2025 it is on by default for databases at compat level 160+.

```sql
-- Check DOP Feedback setting
SELECT name, value
FROM sys.database_scoped_configurations
WHERE name = 'DOP_FEEDBACK';

-- Disable if needed
ALTER DATABASE SCOPED CONFIGURATION SET DOP_FEEDBACK = OFF;
```

### Query Store for readable secondaries on by default

Query Store data collection is now enabled by default on readable AG secondaries in SQL Server 2025, avoiding the cold-plan problem immediately after failover.

### OPPO — Optional Parameter Plan Optimization

Extends Parameter Sensitive Plan Optimization (PSPO from 2022) to handle optional parameters — queries like `WHERE col = @val OR @val IS NULL` now receive distinct cached plans per cardinality scenario.

### sp_executesql compilation serialization

Reduces compilation storms by serializing concurrent compilations of identical `sp_executesql` batches, similar to stored procedure compilation.

### Tempdb resource governance

Limits the maximum tempdb space a single workload can consume without Resource Governor configuration. Prevents runaway queries from filling tempdb and impacting the instance.

```sql
-- Monitor tempdb usage per session
SELECT session_id, user_objects_alloc_page_count,
       internal_objects_alloc_page_count
FROM sys.dm_db_session_space_usage
WHERE database_id = 2
ORDER BY (user_objects_alloc_page_count + internal_objects_alloc_page_count) DESC;
```

### Tmpfs for tempdb on Linux

SQL Server on Linux now supports running tempdb on a RAM-backed tmpfs filesystem for maximum tempdb I/O performance.

```bash
# mssql-conf configuration
mssql-conf set filelocation.masterdatafile /var/opt/mssql/data/master.mdf
# Mount tmpfs and point tempdb at it
mount -t tmpfs -o size=8G tmpfs /mnt/tmpfs-tempdb
# Then set tempdb path in mssql-conf
mssql-conf set filelocation.defaultlogdir /mnt/tmpfs-tempdb
```

---

## Backup Improvements — ZSTD Compression

> [!NOTE] SQL Server 2025
> ZSTD backup compression is GA.[^13]

ZSTD offers better compression ratio and/or faster compression speed than the legacy GZIP-based algorithm.

```sql
-- ZSTD backup
BACKUP DATABASE AdventureWorks
TO DISK = 'C:\Backups\AdventureWorks_zstd.bak'
WITH COMPRESSION = ZSTD, STATS = 10;

-- Choose compression level (1=fastest/least compression, 22=slowest/most)
BACKUP DATABASE AdventureWorks
TO DISK = 'C:\Backups\AdventureWorks_zstd_max.bak'
WITH COMPRESSION = ZSTD,
     COMPRESSION_LEVEL = 3,  -- level 3 is a good default
     STATS = 10;

-- Verify compression algorithm
SELECT
    database_name,
    backup_start_date,
    compressed_backup_size,
    backup_size,
    CAST(compressed_backup_size * 100.0 / backup_size AS DECIMAL(5,2)) AS compression_pct,
    compression_type_desc
FROM msdb.dbo.backupset
WHERE database_name = 'AdventureWorks'
ORDER BY backup_start_date DESC;
```

**Compression algorithm comparison:**

| Algorithm | Speed | Ratio | Notes |
|---|---|---|---|
| Legacy (MS default) | Fast | ~3–5× | Default if `COMPRESSION` specified without algorithm |
| `ZSTD` | Faster | ~4–7× | New default recommendation for 2025+ |
| `QAT` | Hardware | ~3–6× | Intel QAT hardware accelerator required |

---

## Edition Changes

> [!NOTE] SQL Server 2025
> Significant edition restructuring.[^14]

| Edition | Previous limit | 2025 limit | Key change |
|---|---|---|---|
| Enterprise | Unlimited | Unlimited | No change |
| Standard | 4 sockets / 24 cores / 128 GB | 4 sockets / 32 cores / 256 GB | +8 cores, +128 GB RAM |
| Standard | No RG | Resource Governor included | Major workload management addition |
| Express | 10 GB max DB size | 50 GB max DB size | 5× DB size limit |
| Express | Base + Advanced Services | Base only (AS features folded in) | Simplified |
| Web | Available | **Discontinued** | No longer sold |
| Developer | Standard Developer / Enterprise Developer | Two named free dev editions | Explicit naming |

> [!WARNING] Deprecated: **Web Edition** is discontinued in SQL Server 2025. Customers on Web edition should migrate to Standard or Developer edition. Existing Web edition licenses are grandfathered for support purposes.

---

## Feature GA vs Preview Matrix

| Feature | Status | Requires |
|---|---|---|
| `VECTOR` data type (float32) | GA | — |
| `VECTOR_DISTANCE`, `VECTOR_NORM`, `VECTOR_NORMALIZE` | GA | — |
| `VECTORPROPERTY` | GA | — |
| `VECTOR` half-precision (float16) | Preview | `PREVIEW_FEATURES = ON` |
| `CREATE VECTOR INDEX` | Preview | `PREVIEW_FEATURES = ON` |
| `VECTOR_SEARCH` | Preview | `PREVIEW_FEATURES = ON` |
| `CREATE EXTERNAL MODEL` | GA | — |
| `AI_GENERATE_CHUNKS` | GA | — |
| `AI_GENERATE_EMBEDDINGS` | GA | — |
| `sp_invoke_external_rest_endpoint` | GA | — |
| Native `JSON` data type | GA | — |
| `JSON modify()` method | Preview | `PREVIEW_FEATURES = ON` |
| `JSON_OBJECTAGG`, `JSON_ARRAYAGG` | GA | — |
| `REGEXP_LIKE`, `REGEXP_REPLACE`, `REGEXP_SUBSTR`, `REGEXP_INSTR`, `REGEXP_COUNT` | GA | — |
| `REGEXP_MATCHES`, `REGEXP_SPLIT_TO_TABLE` | GA | — |
| `EDIT_DISTANCE`, `EDIT_DISTANCE_SIMILARITY` | Preview | `PREVIEW_FEATURES = ON` |
| `JARO_WINKLER_DISTANCE`, `JARO_WINKLER_SIMILARITY` | Preview | `PREVIEW_FEATURES = ON` |
| `CURRENT_DATE` | GA | — |
| `PRODUCT()` aggregate | GA | — |
| `BASE64_ENCODE`, `BASE64_DECODE` | GA | — |
| `UNISTR` | GA | — |
| `\|\|` string concatenation | GA | — |
| `SUBSTRING` optional length | GA | — |
| `DATEADD` bigint | GA | — |
| Optimized locking | GA | RCSI + compat 160+ |
| Tempdb ADR | GA | — |
| DOP Feedback on by default | GA | compat 160+ |
| QS for readable secondaries default | GA | — |
| ZSTD backup compression | GA | — |
| Ordered NCCI | GA | — |
| Persisted stats on secondaries | GA | — |
| OPPO | GA | compat 170 |
| Tmpfs tempdb on Linux | GA | Linux only |
| Change event streaming | Preview | `PREVIEW_FEATURES = ON` |

---

## Azure SQL Comparison

| Feature | SQL Server 2025 | Azure SQL DB | Azure SQL MI |
|---|---|---|---|
| `VECTOR` type | GA | GA (earlier) | GA |
| Vector indexes / `VECTOR_SEARCH` | Preview | GA | GA |
| Native `JSON` type | GA | GA (earlier) | GA |
| External models | GA | GA | GA |
| `sp_invoke_external_rest_endpoint` | GA | GA (earlier) | GA |
| Regex functions | GA | GA | GA |
| Fuzzy matching | Preview | Preview | Preview |
| Optimized locking | GA | GA (earlier) | GA |
| ZSTD backup | GA | N/A (managed) | GA |
| Web edition | Discontinued | N/A | N/A |
| Standard edition 256 GB | GA (on-prem) | N/A | N/A |
| Tmpfs tempdb | Linux only | N/A | N/A |

---

## Upgrade Checklist

### Pre-upgrade (at current version)

```sql
-- 1. Run sp_Blitz to capture health baseline
EXEC sp_Blitz @CheckUserDatabaseObjects = 1;

-- 2. Identify deprecated feature usage
SELECT * FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%Deprecated%'
  AND cntr_value > 0;

-- 3. Check for Web edition (discontinued)
SELECT SERVERPROPERTY('Edition');

-- 4. Capture Query Store baseline for regression comparison
SELECT TOP 20 q.query_id,
              AVG(rs.avg_duration) AS avg_duration_us
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan  p ON q.query_id = p.query_id
JOIN sys.query_store_runtime_stats rs ON p.plan_id = rs.plan_id
GROUP BY q.query_id
ORDER BY AVG(rs.avg_duration) DESC;
```

### Post-upgrade — remain at current compat level

```sql
-- Verify version
SELECT @@VERSION;

-- Check service is healthy
SELECT * FROM sys.dm_os_ring_buffers WHERE ring_buffer_type = 'RING_BUFFER_EXCEPTION';

-- Compare Query Store regressions vs baseline
```

### Upgrade compat level to 160 (enables optimized locking, DOP Feedback default, etc.)

```sql
ALTER DATABASE YourDatabase SET COMPATIBILITY_LEVEL = 160;
-- Monitor for regressions; use Query Store plan forcing if needed
```

### Upgrade compat level to 170 (enables OPPO and future features)

```sql
ALTER DATABASE YourDatabase SET COMPATIBILITY_LEVEL = 170;
-- Monitor for 2 weeks minimum before declaring stable
```

### Enable preview features (only after internal testing)

```sql
ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON;
-- Test vector index, fuzzy matching, JSON modify() in dev/staging first
```

---

## Gotchas

1. **VECTOR dimension is immutable.** Once a `VECTOR(N)` column is created, you cannot change `N`. You must add a new column, populate it, and drop the old one — a potentially expensive operation on large tables.

2. **VECTOR_SEARCH is ANN, not exact.** It may miss some true nearest neighbors. For compliance, financial, or safety-critical similarity search, use `VECTOR_DISTANCE` with `ORDER BY` (exact brute-force scan).

3. **External model calls are synchronous.** `AI_GENERATE_EMBEDDINGS` and `sp_invoke_external_rest_endpoint` make HTTP calls inline. Network latency or rate-limiting at the AI endpoint becomes SQL Server query latency. Always wrap in TRY/CATCH and consider running in Agent jobs rather than user-facing queries.

4. **Native JSON is not `NVARCHAR`.** Existing code that uses `DATALENGTH()` or `LEN()` on a `JSON` column will behave differently (binary length, not character length). Use `JSON_VALUE` and `OPENJSON` uniformly.

5. **`||` treats NULL as empty string.** The new `||` operator matches `CONCAT` semantics — `NULL || 'x'` = `'x'`. The original `+` still propagates NULL. Mixing operators in the same query is valid but confusing — pick one style per codebase.

6. **CURRENT_DATE is date-only.** Unlike `GETDATE()`, `CURRENT_DATE` returns `DATE` type with no time component. Comparing it with `DATETIME` columns causes an implicit conversion that may kill index seeks — use explicit `CAST(CURRENT_DATE AS DATETIME2)` when needed.

7. **Optimized locking requires RCSI.** If your database is on `READ_COMMITTED` (pessimistic, not RCSI), optimized locking does not activate. Check `is_read_committed_snapshot_on` in `sys.databases`.

8. **REGEXP_* uses ICU, not POSIX.** Patterns written for `PATINDEX` (which uses LIKE-style wildcards) are not regex. ICU regex syntax differs from T-SQL LIKE — `%` and `_` are literal characters in regex.

9. **ZSTD backups are incompatible with pre-2025 restore.** A ZSTD-compressed backup cannot be restored on SQL Server 2022 or earlier. Ensure your restore environment is also on 2025+ before switching compression algorithms in production.

10. **Preview features may change between CU releases.** `PREVIEW_FEATURES = ON` enables features that may change syntax, behavior, or be removed in subsequent Cumulative Updates. Pin to a specific CU if stability is required.

11. **PRODUCT() returns NULL for empty sets.** Like `SUM()` on an empty set returning NULL, `PRODUCT()` returns NULL when there are no qualifying rows. Wrap with `ISNULL(..., 1)` if a neutral element is needed.

12. **Web edition is discontinued — no patch path.** If you are running Web edition, plan migration to Standard edition before upgrading the OS or reaching end-of-support for your current SQL Server version.

---

## See Also

- [`51-2022-features.md`](51-2022-features.md) — SQL Server 2022 features (ledger, S3 backup, contained AG, IS DISTINCT FROM)
- [`53-migration-compatibility.md`](53-migration-compatibility.md) — compatibility level table, deprecated feature checklist, upgrade strategy
- [`09-columnstore-indexes.md`](09-columnstore-indexes.md) — columnstore architecture, batch mode, ordered CCI
- [`31-intelligent-query-processing.md`](31-intelligent-query-processing.md) — DOP Feedback, CE Feedback, PSPO background
- [`30-query-store.md`](30-query-store.md) — Query Store configuration, plan forcing, regression detection
- [`43-high-availability.md`](43-high-availability.md) — AG architecture, readable secondaries, persisted stats context
- [`44-backup-restore.md`](44-backup-restore.md) — backup compression options, ZSTD context
- [`54-linux-containers.md`](54-linux-containers.md) — tmpfs tempdb on Linux, mssql-conf settings

---

## Sources

[^1]: [Vector Data Type (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/vector-data-type) — reference for the VECTOR data type: syntax, element types (float32/float16), storage, limitations, and driver compatibility
[^2]: [Vector Functions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/vector-functions-transact-sql) — reference index for VECTOR_DISTANCE, VECTOR_NORM, VECTOR_NORMALIZE, VECTORPROPERTY, and VECTOR_SEARCH
[^3]: [CREATE VECTOR INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-vector-index-transact-sql) — syntax, arguments, limitations, and examples for creating approximate vector indexes (DiskANN); preview feature requiring PREVIEW_FEATURES = ON
[^4]: [CREATE EXTERNAL MODEL (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-external-model-transact-sql) — syntax and examples for registering external AI inference endpoints (Azure OpenAI, OpenAI, Ollama, ONNX Runtime) used by AI_GENERATE_EMBEDDINGS
[^5]: [What's New in SQL Server 2025](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025) — comprehensive overview of all new features in SQL Server 2025 (17.x), including AI, developer, analytics, engine, and edition changes
[^6]: [JSON Data Type (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) — reference for the native JSON data type: binary storage format, modify method, function compatibility, and limitations
[^7]: [What's New in SQL Server 2025](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025) — covers JSON_OBJECTAGG and JSON_ARRAYAGG aggregate functions introduced in SQL Server 2025
[^8]: [sp_invoke_external_rest_endpoint (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-invoke-external-rest-endpoint-transact-sql) — reference for the system stored procedure that invokes HTTPS REST endpoints from T-SQL; parameters, credentials, response format, and examples
[^9]: [Regular Expressions Functions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/regular-expressions-functions-transact-sql) — reference index for REGEXP_LIKE, REGEXP_REPLACE, REGEXP_SUBSTR, REGEXP_INSTR, REGEXP_COUNT, REGEXP_MATCHES, and REGEXP_SPLIT_TO_TABLE
[^10]: [SQL Server 2025 Release Notes](https://learn.microsoft.com/en-us/sql/sql-server/sql-server-2025-release-notes) — build number, preview feature status table (fuzzy matching, vector indexes, half-precision vectors), and breaking changes for SQL Server 2025 (17.x)
[^11]: [What's New in SQL Server 2025](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025) — covers new T-SQL functions and syntax: CURRENT_DATE, PRODUCT(), BASE64_ENCODE/DECODE, UNISTR, || concatenation, SUBSTRING optional length, DATEADD bigint
[^12]: [What's New in SQL Server 2025](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025) — covers optimized locking (TID locking, Lock After Qualification) available in SQL Server 2025
[^13]: [What's New in SQL Server 2025](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025) — covers ZSTD backup compression algorithm introduced in SQL Server 2025
[^14]: [SQL Server 2025 Release Notes](https://learn.microsoft.com/en-us/sql/sql-server/sql-server-2025-release-notes) — documents edition changes in SQL Server 2025: Standard edition capacity increases, Express edition 50 GB limit, Web edition discontinuation

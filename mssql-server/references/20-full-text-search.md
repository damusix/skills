# Full-Text Search (FTS)

Full-text search in SQL Server enables linguistic queries over character and binary columns that LIKE and substring searches cannot handle efficiently: word proximity, inflectional forms, thesaurus synonyms, ranking by relevance, and semantic similarity.

## Table of Contents

- [When to Use](#when-to-use)
- [Architecture Overview](#architecture-overview)
- [Full-Text Catalogs](#full-text-catalogs)
- [Full-Text Indexes](#full-text-indexes)
- [Word Breakers and Stoplists](#word-breakers-and-stoplists)
- [Thesaurus Files](#thesaurus-files)
- [Predicate Functions: CONTAINS and FREETEXT](#predicate-functions-contains-and-freetext)
- [Rowset Functions: CONTAINSTABLE and FREETEXTTABLE](#rowset-functions-containstable-and-freetexttable)
- [Semantic Search](#semantic-search)
- [Population and Change Tracking](#population-and-change-tracking)
- [Metadata and Monitoring](#metadata-and-monitoring)
- [Performance Tuning](#performance-tuning)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use

Use full-text search when you need:
- **Linguistic matching** — find "run", "ran", "running" with a single search (inflectional forms)
- **Proximity search** — "server NEAR database" within N words of each other
- **Relevance ranking** — rank results by how well they match, not just whether they match
- **Thesaurus expansion** — "automobile" matches "car", "vehicle"
- **Binary document indexing** — index Word, PDF, and HTML content through IFilters
- **Semantic similarity** — find documents that are semantically related even with no keyword overlap (requires Semantic Search add-on)

Do NOT use FTS for:
- Simple substring matching (`LIKE '%foo%'` on small tables is fine)
- Exact prefix matching (`LIKE 'foo%'` uses a regular index)
- High-cardinality exact lookups — regular indexes are faster

---

## Architecture Overview

```
SQL Server Full-Text Engine (fdhost.exe)
│
├── Word Breakers (per language) ──────── tokenise input text into words
├── Stoplists ─────────────────────────── filter out noise words ("the", "a", "of")
├── Thesaurus ──────────────────────────── synonym expansion (XML files per language)
├── Stemmer / Inflectional Generator ──── "runs" → "run" → matches "ran", "running"
│
└── Full-Text Index (per table)
    ├── stored in Full-Text Catalog
    ├── one FT index per table (limit)
    ├── can span multiple columns
    └── change tracking: Auto | Manual | Off
```

The Full-Text Engine runs in-process (SQL Server 2008+) as a set of FDHOST processes. The index data is stored in Windows files managed by SQL Server, NOT in user database pages — which is why FT indexes are not part of normal backup unless you back up the catalog files.

> [!NOTE] SQL Server 2008+
> Full-text was integrated into the core engine (no separate Full-Text service). Starting with SQL Server 2008, the full-text catalog is a logical concept — the actual index data resides in database filegroups and is backed up and restored with the database. [^12]

---

## Full-Text Catalogs

A full-text catalog is a logical container grouping one or more full-text indexes. Since SQL Server 2008 the physical storage is fully managed; you just need the logical object.

```sql
-- Create a catalog (default filegroup)
CREATE FULLTEXT CATALOG ft_catalog AS DEFAULT;

-- Create a catalog on a specific filegroup (useful for large catalogs)
CREATE FULLTEXT CATALOG ft_catalog ON FILEGROUP [FTData] AS DEFAULT;

-- View catalogs
SELECT name, is_default, path
FROM sys.fulltext_catalogs;

-- Rebuild a catalog (drops and recreates all indexes in it — expensive)
ALTER FULLTEXT CATALOG ft_catalog REBUILD;

-- Reorganize a catalog (incremental optimization, less disruptive)
ALTER FULLTEXT CATALOG ft_catalog REORGANIZE;

-- Drop
DROP FULLTEXT CATALOG ft_catalog;
```

**Catalog design guidance:**
- One catalog per database is usually fine for < 50 million words
- Separate catalogs per table if you need independent rebuild schedules
- Use `AS DEFAULT` so indexes created without specifying a catalog land here

---

## Full-Text Indexes

One full-text index per table (not per column). A single FT index can cover multiple columns.

```sql
-- Prerequisites:
-- 1. Table must have a UNIQUE, single-column, non-nullable index (the "key column")
-- 2. Full-text catalog must exist

-- Minimal creation
CREATE FULLTEXT INDEX ON dbo.Articles
(
    Title LANGUAGE 1033,        -- 1033 = US English
    Body  LANGUAGE 1033
)
KEY INDEX PK_Articles           -- must be UNIQUE NOT NULL single-column
ON ft_catalog                   -- catalog name
WITH CHANGE_TRACKING AUTO;      -- Auto | Manual | Off + No population

-- With type column for binary documents (e.g. PDF stored as varbinary)
CREATE FULLTEXT INDEX ON dbo.Documents
(
    FileContent TYPE COLUMN FileExtension  -- FileExtension holds '.pdf', '.docx', etc.
        LANGUAGE 1033
)
KEY INDEX PK_Documents
ON ft_catalog
WITH CHANGE_TRACKING AUTO;

-- Alter: add a column
ALTER FULLTEXT INDEX ON dbo.Articles ADD (Summary LANGUAGE 1033);

-- Alter: remove a column
ALTER FULLTEXT INDEX ON dbo.Articles DROP (Summary);

-- Alter: change tracking mode
ALTER FULLTEXT INDEX ON dbo.Articles SET CHANGE_TRACKING MANUAL;

-- Trigger manual population
ALTER FULLTEXT INDEX ON dbo.Articles START FULL POPULATION;
ALTER FULLTEXT INDEX ON dbo.Articles START INCREMENTAL POPULATION;  -- requires timestamp column
ALTER FULLTEXT INDEX ON dbo.Articles START UPDATE POPULATION;        -- pending changes only

-- Stop population
ALTER FULLTEXT INDEX ON dbo.Articles STOP POPULATION;

-- Enable / disable
ALTER FULLTEXT INDEX ON dbo.Articles ENABLE;
ALTER FULLTEXT INDEX ON dbo.Articles DISABLE;

-- Drop
DROP FULLTEXT INDEX ON dbo.Articles;
```

**CHANGE_TRACKING modes:**

| Mode | Behavior | Use Case |
|------|----------|----------|
| `AUTO` | Background thread tracks and propagates changes automatically | OLTP tables with frequent writes |
| `MANUAL` | Changes tracked but index not updated until you call START UPDATE POPULATION | Batch-heavy systems |
| `OFF` | No tracking; must do full population manually | Staging tables, rarely updated archives |
| `OFF, NO POPULATION` | Create index without populating it at all | Scripting, manual population later |

---

## Word Breakers and Stoplists

### Language and Word Breakers

Each column in a full-text index is associated with a language LCID. The word breaker for that language determines how text is tokenised.

```sql
-- List available languages and their word breakers
SELECT lcid, name, alias
FROM sys.fulltext_languages
ORDER BY name;

-- Common LCIDs
-- 1033  = English (US)
-- 2052  = Chinese Simplified
-- 1031  = German
-- 1036  = French
-- 0     = Neutral (basic word breaker, language-agnostic)
```

### Stoplists

Stoplists filter out common words ("the", "a", "and") that would bloat the index and contribute no search value.

```sql
-- System stoplist (built-in per language)
CREATE FULLTEXT INDEX ON dbo.Articles (Body LANGUAGE 1033)
KEY INDEX PK_Articles ON ft_catalog
WITH STOPLIST = SYSTEM;  -- default; use built-in stoplist

-- No stoplist (index everything)
CREATE FULLTEXT INDEX ON dbo.Articles (Body LANGUAGE 1033)
KEY INDEX PK_Articles ON ft_catalog
WITH STOPLIST = OFF;

-- Custom stoplist
CREATE FULLTEXT STOPLIST custom_stops;
ALTER FULLTEXT STOPLIST custom_stops ADD 'foo' LANGUAGE 'English';
ALTER FULLTEXT STOPLIST custom_stops ADD 'bar' LANGUAGE 'English';
ALTER FULLTEXT STOPLIST custom_stops DROP 'foo' LANGUAGE 'English';

-- Use custom stoplist for an index
CREATE FULLTEXT INDEX ON dbo.Articles (Body LANGUAGE 1033)
KEY INDEX PK_Articles ON ft_catalog
WITH STOPLIST = custom_stops;

-- View stoplist words
SELECT stoplist_id, language, stopword
FROM sys.fulltext_stopwords
WHERE stoplist_id = (SELECT stoplist_id FROM sys.fulltext_stoplists WHERE name = 'custom_stops');
```

> [!WARNING]
> Changing the stoplist requires repopulation of the full-text index. Words in the stoplist are not indexed; if you remove a word from the stoplist you must repopulate to index it retroactively.

---

## Thesaurus Files

Thesaurus files are per-language XML files stored on disk that define synonym expansions. They are NOT in the database — they live in the SQL Server installation directory.

**Location (typical):**
```
C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL\FTData\tsenu.xml  -- English US
```

**XML format:**
```xml
<XML ID="Microsoft Search Thesaurus">
  <thesaurus xmlns="x-schema:tsSchema.xml">
    <diacritics_sensitive>0</diacritics_sensitive>
    <expansion>
      <!-- All terms treated as synonyms of each other -->
      <sub>car</sub>
      <sub>automobile</sub>
      <sub>vehicle</sub>
    </expansion>
    <replacement>
      <!-- "USA" → "United States" (one-way) -->
      <pat>USA</pat>
      <sub>United States</sub>
    </replacement>
  </thesaurus>
</XML>
```

**After editing the thesaurus file, reload it:**
```sql
EXEC sys.sp_fulltext_load_thesaurus_file 1033;  -- 1033 = English US LCID
```

> [!WARNING]
> Thesaurus files are on the file system, not in the database. They are **not** backed up with the database. You must manage them separately as part of your deployment and backup processes.

---

## Predicate Functions: CONTAINS and FREETEXT

These return boolean results and can be used in WHERE clauses. They do not return relevance scores.

### CONTAINS

Precise, structured search. Supports: simple terms, prefix terms, inflectional forms, proximity, weighted terms, Boolean operators.

```sql
-- Simple word
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, '"database"');

-- OR phrase
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, '"full text" OR "full-text"');

-- AND / AND NOT
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, '"SQL Server" AND NOT "Oracle"');

-- Prefix term (word starting with "data")
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, '"data*"');

-- Inflectional forms: matches run, ran, running, runs
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, 'FORMSOF(INFLECTIONAL, run)');

-- Thesaurus expansion: matches car, automobile, vehicle
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, 'FORMSOF(THESAURUS, car)');

-- Proximity: "SQL" within 5 words of "Server"
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, 'SQL NEAR((Server), 5)');

-- Generic NEAR (unordered, distance not specified)
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, '"SQL" NEAR "database"');

-- Ordered proximity (SQL must appear before performance, within 3 words)
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, 'SQL NEAR((performance), 3, TRUE)');

-- Search multiple columns
SELECT * FROM dbo.Articles
WHERE CONTAINS((Title, Body), '"indexing"');

-- Search all FT-indexed columns in the table
SELECT * FROM dbo.Articles
WHERE CONTAINS(*, '"indexing"');

-- Combine with regular predicates
SELECT * FROM dbo.Articles
WHERE CONTAINS(Body, '"deadlock"')
  AND PublishedDate >= '2023-01-01';
```

### FREETEXT

Natural language search. The engine breaks the search string into words, stems them, and expands via thesaurus. Less precise but more forgiving.

```sql
-- Natural language query — finds documents about managing SQL Server databases
SELECT * FROM dbo.Articles
WHERE FREETEXT(Body, 'managing SQL Server databases efficiently');

-- FREETEXT with multiple columns
SELECT * FROM dbo.Articles
WHERE FREETEXT((Title, Body), 'query performance tuning');
```

**CONTAINS vs FREETEXT:**

| Feature | CONTAINS | FREETEXT |
|---------|----------|----------|
| Exact phrases | Yes (`"..."`) | No |
| Boolean operators | Yes (AND/OR/AND NOT) | No |
| Proximity (NEAR) | Yes | No |
| Prefix wildcard | Yes (`"data*"`) | No |
| Inflectional forms | FORMSOF(INFLECTIONAL) | Automatic |
| Thesaurus | FORMSOF(THESAURUS) | Automatic |
| Relevance score | No | No |
| Best for | Structured, precise search | End-user free-form search |

---

## Rowset Functions: CONTAINSTABLE and FREETEXTTABLE

Return a result set with columns `[KEY]` (matching the FT key column type) and `RANK` (relevance score 0–1000). Must be used in the FROM clause with a JOIN.

### CONTAINSTABLE

```sql
-- Returns KEY and RANK, joined back to source table
SELECT a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN CONTAINSTABLE(dbo.Articles, Body, '"deadlock" OR "locking"') AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;

-- With TOP N (only return top 10 ranked results — more efficient than filtering after JOIN)
SELECT a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN CONTAINSTABLE(dbo.Articles, Body, '"SQL Server"', 10) AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;

-- Weighted terms: boost rank for "performance" matches
SELECT a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN CONTAINSTABLE(
    dbo.Articles,
    Body,
    'ISABOUT (performance WEIGHT(0.9), tuning WEIGHT(0.5), optimization WEIGHT(0.7))'
) AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;

-- LANGUAGE clause (override column default language)
SELECT a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN CONTAINSTABLE(dbo.Articles, Body, '"données"', LANGUAGE 'French') AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;
```

### FREETEXTTABLE

```sql
SELECT a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN FREETEXTTABLE(dbo.Articles, (Title, Body), 'query performance tuning') AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;

-- With TOP limit
SELECT a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN FREETEXTTABLE(dbo.Articles, Body, 'backup and restore strategies', 20) AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;
```

**Rank interpretation:**
- RANK is an integer from 0 to 1000
- Higher = more relevant
- Values are relative within a result set; do not compare RANK values across different queries
- RANK does not map to a percentage — a RANK of 1000 just means the highest match in that result set

---

## Semantic Search

Semantic Search extends full-text search with statistical analysis of document meaning. It requires the **Semantic Language Statistics Database** to be installed and registered.

> [!NOTE] SQL Server 2012+
> Semantic Search was introduced in SQL Server 2012. It requires a separate download and registration step.

### Setup

```sql
-- 1. Install Semantic Language Statistics Database (SemanticLanguageDatabase.msi)
--    This adds a database named SemanticLanguageDatabase to the instance

-- 2. Register the semantic language database
EXEC sp_fulltext_semantic_register_language_statistics_db
    @dbname = N'SemanticLanguageDatabase';

-- 3. Add STATISTICAL_SEMANTICS to the FT index column
CREATE FULLTEXT INDEX ON dbo.Articles
(
    Body LANGUAGE 1033 STATISTICAL_SEMANTICS
)
KEY INDEX PK_Articles ON ft_catalog
WITH CHANGE_TRACKING AUTO;

-- Or add to existing FT index
ALTER FULLTEXT INDEX ON dbo.Articles
ADD (Body LANGUAGE 1033 STATISTICAL_SEMANTICS);
```

### Semantic Key Phrases

```sql
-- Extract key phrases from a specific document
SELECT TOP 20
    keyphrase,
    score
FROM SEMANTICKEYPHRASETABLE(
    dbo.Articles,       -- table
    Body,               -- column
    @ArticleId          -- document key value (matches FT key column)
)
ORDER BY score DESC;
```

### Semantic Similarity Between Documents

```sql
-- Find documents semantically similar to a given document
SELECT TOP 10
    a.ArticleId,
    a.Title,
    ss.score
FROM dbo.Articles AS a
INNER JOIN SEMANTICSIMILARITYTABLE(
    dbo.Articles,       -- table
    Body,               -- column
    @SourceArticleId    -- the source document key
) AS ss
    ON a.ArticleId = ss.matched_document_key
ORDER BY ss.score DESC;

-- Details: which key phrases drove the similarity
SELECT
    ss.matched_document_key,
    ss.keyphrase,
    ss.score
FROM SEMANTICSIMILARITYDETAILSTABLE(
    dbo.Articles,       -- table
    Body,               -- source column
    @SourceArticleId,   -- source document key
    Body,               -- matched column
    @TargetArticleId    -- target document key
) AS ss
ORDER BY ss.score DESC;
```

> [!WARNING]
> Semantic Search has significant overhead: it requires a separate Semantic Language Statistics Database to be installed and registered, and semantic population indexes additional key phrase and similarity data beyond what full-text indexing alone produces. Measure impact before enabling on large tables. [^13]

---

## Population and Change Tracking

### Checking Population Status

```sql
-- Current population status for all FT indexes in the database
SELECT
    OBJECT_NAME(i.object_id) AS TableName,
    i.change_tracking_state_desc,
    i.crawl_type_desc,
    i.crawl_start_date,
    i.crawl_end_date,
    i.incremental_timestamp,
    i.item_count,
    i.pending_doc_count,
    i.error_count,
    i.retry_count
FROM sys.fulltext_indexes AS i;

-- Real-time population progress
SELECT
    database_id,
    table_id,
    population_type_description,
    population_status_description,
    completion_type_description,
    queued_population_type_description,
    start_time,
    range_count
FROM sys.dm_fts_index_population;

-- Active crawls
SELECT
    database_id,
    table_id,
    document_count,
    document_error_count
FROM sys.dm_fts_active_catalogs;
```

### Manual Population Triggers

```sql
-- Full repopulation (all rows — slow on large tables)
ALTER FULLTEXT INDEX ON dbo.Articles START FULL POPULATION;

-- Incremental population (only rows changed since last population)
-- Requires a timestamp/rowversion column in the table
ALTER FULLTEXT INDEX ON dbo.Articles START INCREMENTAL POPULATION;

-- Update population (process tracked changes)
ALTER FULLTEXT INDEX ON dbo.Articles START UPDATE POPULATION;

-- Pause and resume
ALTER FULLTEXT INDEX ON dbo.Articles PAUSE POPULATION;
ALTER FULLTEXT INDEX ON dbo.Articles RESUME POPULATION;
```

### When to Force Full Population

- After adding a new column to the FT index
- After changing the stoplist (if you added words, existing indexed tokens remain until repopulation)
- After installing a new word breaker or IFilter
- After a restore where the FT catalog may be out of sync
- After enabling Semantic Search on a column

---

## Metadata and Monitoring

```sql
-- All full-text indexes in the database
SELECT
    OBJECT_NAME(i.object_id)    AS TableName,
    c.name                       AS CatalogName,
    i.change_tracking_state_desc AS ChangeTracking,
    i.item_count,
    i.unique_key_count
FROM sys.fulltext_indexes AS i
JOIN sys.fulltext_catalogs AS c ON i.fulltext_catalog_id = c.fulltext_catalog_id;

-- Columns covered by each FT index
SELECT
    OBJECT_NAME(ic.object_id) AS TableName,
    COL_NAME(ic.object_id, ic.column_id) AS ColumnName,
    l.name  AS Language,
    ic.statistical_semantics
FROM sys.fulltext_index_columns AS ic
JOIN sys.fulltext_languages AS l ON ic.language_id = l.lcid;

-- Catalog disk usage
SELECT
    c.name,
    FILEPROPERTY(c.path, 'SpaceUsed') AS SpaceUsedKB
FROM sys.fulltext_catalogs AS c;

-- FT-related wait stats
SELECT wait_type, waiting_tasks_count, wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type LIKE 'FT%'
ORDER BY wait_time_ms DESC;

-- Check for FT population errors
SELECT
    OBJECT_NAME(object_id) AS TableName,
    document_key,
    error_code,
    error_description,
    error_source,
    error_time
FROM sys.dm_fts_index_keywords_by_document(DB_ID(), OBJECT_ID('dbo.Articles'))  -- not an error DMV; example placeholder
-- Use error_count from sys.fulltext_indexes as the primary error indicator
```

---

## Performance Tuning

### Limiting FT Resource Usage

```sql
-- Set FT crawl bandwidth: max range (concurrent crawl threads) and min range
EXEC sp_fulltext_service 'resource_usage', 3;  -- 1 (low) to 5 (high, default)

-- Default: SQL Server allocates resource_usage based on server load
-- Lower this on OLTP systems during business hours
```

### Effective Query Patterns

```sql
-- BAD: CONTAINS in WHERE + expensive sort of all rows
SELECT *
FROM dbo.Articles
WHERE CONTAINS(Body, '"indexing"')
ORDER BY PublishedDate DESC;

-- BETTER: Use CONTAINSTABLE with TOP, join last
SELECT TOP 20 a.ArticleId, a.Title, a.PublishedDate, ft.RANK
FROM dbo.Articles AS a
INNER JOIN CONTAINSTABLE(dbo.Articles, Body, '"indexing"', 100) AS ft
    ON a.ArticleId = ft.[KEY]
ORDER BY ft.RANK DESC;

-- If you need date filtering, push it into a subquery:
SELECT TOP 20 a.ArticleId, a.Title, ft.RANK
FROM dbo.Articles AS a
INNER JOIN CONTAINSTABLE(dbo.Articles, Body, '"indexing"', 100) AS ft
    ON a.ArticleId = ft.[KEY]
WHERE a.PublishedDate >= '2023-01-01'
ORDER BY ft.RANK DESC;
```

### Index Design for FT-Heavy Workloads

- Make the FT key column a narrow integer (`INT` or `BIGINT`) — the FT engine stores and looks up this key constantly
- Ensure the FT key column has a clustered or nonclustered covering index that supports the JOIN back to the base table
- For filtered FT queries (FT + regular predicate), a filtered nonclustered index on the regular predicate columns reduces the base-table rows scanned

### Catalog Maintenance

```sql
-- Reorganize (defragment) — low disruption, runs while queries execute
ALTER FULLTEXT CATALOG ft_catalog REORGANIZE;

-- Rebuild — drops and recreates; causes full repopulation of all indexes in catalog
-- Only do this for severe fragmentation or corruption
ALTER FULLTEXT CATALOG ft_catalog REBUILD;
```

---

## Gotchas / Anti-patterns

1. **LIKE is not FTS.** `LIKE '%word%'` does a table scan; FTS uses an inverted index. For large text columns with frequent searches, always prefer FTS over LIKE.

2. **One FT index per table.** You cannot create two full-text indexes on the same table. If you need to index different column sets with different settings, you cannot — design around this constraint.

3. **FT key column restriction.** The key column must be `UNIQUE NOT NULL` and single-column. Composite keys are not allowed. An integer data type is recommended for best performance; non-integer key columns incur additional overhead via a DocId mapping table. [^14]

4. **Stoplists silently swallow search terms.** If the user searches for "the" and "the" is in the stoplist, CONTAINS/FREETEXT return no rows without error. Consider using `WITH STOPLIST = OFF` for diagnostic queries or very short query terms.

5. **NEAR default distance is unlimited, not 5.** Generic `A NEAR B` matches regardless of intervening distance and order; however, terms more than 50 logical terms apart receive a rank of 0 in CONTAINSTABLE. [^15] For precise control use `A NEAR((B), N)` with an explicit maximum distance.

6. **FT indexes are not in sys.indexes.** You cannot query `sys.indexes` to find FT indexes. Use `sys.fulltext_indexes` and `sys.fulltext_index_columns`.

7. **Binary columns require a TYPE COLUMN.** If you store Word or PDF files in a `VARBINARY(MAX)` column, you must have a companion column (e.g. `NVARCHAR(10)`) with the file extension (`.docx`, `.pdf`) and reference it with `TYPE COLUMN` in the FT index definition. The appropriate IFilter must be installed for each file type.

8. **Thesaurus files are not backed up with the database.** See [Thesaurus Files](#thesaurus-files). Include them in your server backup/DR procedures separately.

9. **Population blocks schema changes.** Running `ALTER TABLE` on a table with a full-text index while a population is active may fail or be blocked. Pause or stop population first, then make schema changes, then resume.

10. **RANK values are not portable.** RANK from CONTAINSTABLE/FREETEXTTABLE is relative to the result set of that query. Do not store RANK values, compare them across queries, or use them as a stable score — they will change as the index is populated.

11. **Semantic Search is a separate install.** The Semantic Language Statistics Database is not installed by the SQL Server setup program — it must be downloaded separately, attached, and registered via `sp_fulltext_semantic_register_language_statistics_db`. [^13] Forgetting this step means `STATISTICAL_SEMANTICS` silently does nothing or errors on index creation.

12. **No FTS on memory-optimized tables.** `CREATE FULLTEXT INDEX` is explicitly unsupported for memory-optimized tables. [^16]

---

## See Also

- [`08-indexes.md`](08-indexes.md) — regular index design and fragmentation
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — wait stats, DMVs
- [`19-json-xml.md`](19-json-xml.md) — for document storage patterns
- [`28-statistics.md`](28-statistics.md) — statistics update after bulk load

---

## Sources

[^1]: [Full-Text Search - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/search/full-text-search) — overview of full-text search architecture, components, and capabilities
[^2]: [CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/contains-transact-sql) — syntax and usage for the CONTAINS full-text predicate
[^3]: [CONTAINSTABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/containstable-transact-sql) — syntax and usage for the CONTAINSTABLE rowset function
[^4]: [FREETEXT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/freetext-transact-sql) — syntax and usage for the FREETEXT full-text predicate
[^5]: [FREETEXTTABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/freetexttable-transact-sql) — syntax and usage for the FREETEXTTABLE rowset function
[^6]: [Semantic Search (SQL Server)](https://learn.microsoft.com/en-us/sql/relational-databases/search/semantic-search-sql-server) — overview of statistical semantic search capabilities
[^7]: [Create and manage full-text indexes](https://learn.microsoft.com/en-us/sql/relational-databases/search/create-and-manage-full-text-indexes) — creating, populating, and managing full-text indexes
[^8]: [Configure and Manage Thesaurus Files for Full-Text Search](https://learn.microsoft.com/en-us/sql/relational-databases/search/configure-and-manage-thesaurus-files-for-full-text-search) — thesaurus XML file structure, expansion and replacement sets
[^9]: [sys.fulltext_indexes (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-fulltext-indexes-transact-sql) — catalog view for full-text index metadata
[^10]: [sys.dm_fts_index_population (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-fts-index-population-transact-sql) — DMV for monitoring full-text index population progress
[^11]: [Why Full Text's CONTAINS Queries Are So Slow](https://www.brentozar.com/archive/2020/11/why-full-texts-contains-queries-are-so-slow/) — Brent Ozar on full-text search performance problems: CONTAINS queries scan all rows instead of using other WHERE predicates first
[^12]: [Back Up and Restore Full-Text Catalogs and Indexes](https://learn.microsoft.com/en-us/sql/relational-databases/search/back-up-and-restore-full-text-catalogs-and-indexes?view=sql-server-ver17) — documents that full-text catalogs are logical concepts in SQL Server 2008+ and index data resides in database filegroups
[^13]: [Install and Configure Semantic Search](https://learn.microsoft.com/en-us/sql/relational-databases/search/install-and-configure-semantic-search?view=sql-server-ver16) — separate download, attach, and registration steps for the Semantic Language Statistics Database
[^14]: [CREATE FULLTEXT INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-fulltext-index-transact-sql?view=sql-server-ver17) — KEY INDEX must be unique, single-key, non-nullable; integer data type recommended for best performance
[^15]: [Search for Words Close to Another Word with NEAR](https://learn.microsoft.com/en-us/sql/relational-databases/search/search-for-words-close-to-another-word-with-near?view=sql-server-ver17) — generic NEAR matches regardless of distance; terms >50 logical terms apart receive rank 0
[^16]: [Transact-SQL Constructs Not Supported by In-Memory OLTP](https://learn.microsoft.com/en-us/sql/relational-databases/in-memory-oltp/transact-sql-constructs-not-supported-by-in-memory-oltp?view=sql-server-ver16) — CREATE FULLTEXT INDEX listed as unsupported for memory-optimized tables

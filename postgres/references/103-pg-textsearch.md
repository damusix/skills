# pg_textsearch — BM25 Ranked Full-Text Search

`pg_textsearch` extension. Adds a `bm25` index access method that ranks documents by BM25 relevance (IDF, term-frequency saturation, document-length normalization) and returns top-k results through `ORDER BY col <@> 'query' LIMIT k`. Latest version **1.5.1** (2026-10-02), GA since 1.0.0 (2026-03-27). PostgreSQL License, maintained by Tiger Data (formerly Timescale). External extension — not in core PostgreSQL.[^1][^2]

> [!WARNING] PostgreSQL 17 and 18 only
> pg_textsearch supports **PG17 and PG18**. PG19 support is best-effort (CI allowed to fail, no prebuilt binaries). **PG14, PG15, and PG16 are not supported.** The skill's PG16 baseline does not apply to this file: on PG16, use core FTS ([`20-text-search.md`](./20-text-search.md)).[^1]

## Table of Contents

- [When to Use](#when-to-use)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Installation](#installation)
    - [Creating a BM25 Index](#creating-a-bm25-index)
    - [Querying: the <@> Operator](#querying-the--operator)
    - [Explicit Index Names: to_bm25query](#explicit-index-names-to_bm25query)
    - [Boolean Filtering with @@ (1.5.0+)](#boolean-filtering-with--150)
    - [Scoring and Corpus Statistics](#scoring-and-corpus-statistics)
    - [Filters: Pre-filter vs Post-filter](#filters-pre-filter-vs-post-filter)
    - [Write Path, Segments, Compaction](#write-path-segments-compaction)
    - [VACUUM, Replication, Standbys](#vacuum-replication-standbys)
    - [Index Builds](#index-builds)
    - [Functions](#functions)
    - [Configuration GUCs](#configuration-gucs)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use

Relevance-ranked keyword search where the ranking quality matters: product search, documentation search, support-ticket search, the keyword half of hybrid (BM25 + vector) retrieval for RAG. Top-k over millions of documents where core `ts_rank` is too slow because it must score every matching row.

Not for: boolean "does it match" filtering with no ranking (core `tsvector` + GIN is enough, see [`20-text-search.md`](./20-text-search.md)), typo tolerance or fuzzy matching (use [`93-pg-trgm.md`](./93-pg-trgm.md)), semantic similarity (use [`94-pgvector.md`](./94-pgvector.md)), highlighting (use core `ts_headline` on the result rows), PG16 or older clusters.

## Mental Model

Five rules:

1. **One index = one corpus.** BM25 needs corpus statistics (document count, per-term document frequency, average length). pg_textsearch keeps them per index. Scores are comparable within one index only — not across indexes, partitions, or text configs.[^1]

2. **Scores are negated.** `<@>` returns the BM25 score multiplied by −1, so `ORDER BY col <@> 'q'` (ascending) returns best matches first. Lower is better.[^1]

3. **Ranking is top-k inside the index.** `ORDER BY ... <@> ... LIMIT k` runs a Block-Max WAND top-k scan in the index. Core FTS finds matches with GIN, then computes `ts_rank` on every matching row; pg_textsearch skips blocks that cannot reach the top k.[^3]

4. **Tokenization is core FTS.** Documents and queries are tokenized with `to_tsvector(text_config, ...)`, so dictionaries, stemming, and stopwords from [`20-text-search.md`](./20-text-search.md) carry over. The index stores term frequencies, not positions.[^3]

5. **Preload is mandatory.** `shared_preload_libraries = 'pg_textsearch'` plus a restart, since 0.6.0. `CREATE EXTENSION` fails without it.[^1]

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Ranked keyword search, PG17/18, top-k | pg_textsearch `bm25` index | BM25 ranking + top-k pushdown |
| Ranked keyword search, PG16 or older | core `tsvector` + GIN + `ts_rank` with LIMIT | pg_textsearch not supported |
| Match/no-match filtering only | core `tsvector` + GIN | no ranking cost |
| Boolean query + BM25 ranking | `WHERE col @@ tsquery ORDER BY col <@> 'q'` (1.5.0+) | fast only when the filter matches few rows |
| Phrase matching | `@@` with `<->` (1.5.0+), rechecked on heap | no positional index |
| Typo tolerance | [`93-pg-trgm.md`](./93-pg-trgm.md) | BM25 matches exact lexemes only |
| Semantic + keyword | pg_textsearch + pgvector with RRF | different score scales, fuse by rank |
| Multiple languages in one table | one partial `bm25` index per language | `text_config` is per index |
| Per-field weights (title > body) | not supported | `ARRAY[title, body]` flattens fields; no weighting |
| Search across partitions with comparable scores | query one partition, or do not partition the searched table | IDF is per partition |
| Pre-loading a large table | load data, then `CREATE INDEX` | faster than incremental inserts |

## Mechanics

### Installation

    # postgresql.conf — add to the existing list
    shared_preload_libraries = 'pg_textsearch'

Restart the server, then in each database:

    CREATE EXTENSION pg_textsearch;

Install paths:[^1]

- Prebuilt packages on GitHub Releases for PG17 and PG18, Linux amd64 and arm64.
- Source build: `make && make install` with `PG_CONFIG` pointing at the target install (needs `postgresql-server-dev-17` or `-18`). Windows via `nmake /F Makefile.win` (1.5.0+).
- The maintainer's `timescale/timescaledb-ha:pg17` image ships it preinstalled with the preload set.[^4]

The extension is not relocatable. Most managed providers do not let you change `shared_preload_libraries` for unlisted extensions; check the provider's extension list before designing around it (see [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md)).

### Creating a BM25 Index

    CREATE INDEX docs_idx ON documents USING bm25 (content)
        WITH (text_config = 'english');

| Option | Default | Range | Meaning |
|---|---|---|---|
| `text_config` | **required** | any `regconfig` (`'english'`, `'simple'`, `'public.chinese'`) | tokenizer for documents and queries |
| `k1` | `1.2` | 0.1–10.0 | term-frequency saturation |
| `b` | `0.75` | 0.0–1.0 | document-length normalization |
| `compaction` | `inline` | `inline`, `background`, `manual` | segment-merge policy (see below) |
| `compaction_schedule` | GUC `pg_textsearch.background_compaction_schedule` | cron string | used only in `background` mode |

Omitting `text_config` raises `text_config parameter is required for bm25 indexes`.[^5]

Indexable input: one column or expression of type `text`, `varchar`, `char`, or an array of those. Expressions must use only IMMUTABLE functions, and queries must repeat the same expression in `ORDER BY`. Multi-column indexes are not supported (`amcanmulticol = false`). No UNIQUE, no INCLUDE, no backward scan.[^1][^6]

Ways to search several columns:

    -- Concatenated expression
    CREATE INDEX ON articles USING bm25 ((coalesce(title, '') || ' ' || coalesce(body, '')))
        WITH (text_config = 'english');

    -- Array expression: elements are joined with spaces into one document
    CREATE INDEX ON articles USING bm25 ((ARRAY[title, body]))
        WITH (text_config = 'english');

    -- Generated column
    ALTER TABLE episodes ADD COLUMN search_text text
        GENERATED ALWAYS AS (coalesce(title, '') || ' ' || coalesce(description, '')) STORED;
    CREATE INDEX ON episodes USING bm25 (search_text) WITH (text_config = 'english');

Partial indexes (`WHERE ...`) are supported since 1.1.0 and require an explicit index name at query time.[^1]

### Querying: the <@> Operator

    SELECT * FROM documents
    ORDER BY content <@> 'database system'
    LIMIT 5;

| Operator | Returns | Notes |
|---|---|---|
| `text <@> text` | `float8` | implicit form; a planner hook resolves the BM25 index on the column |
| `text <@> bm25query` | `float8` | explicit form; `bm25query` carries the index name |
| `text[] <@> text`, `text[] <@> bm25query` | `float8` | array columns |
| `text @@ tsquery` | `boolean` | core operator; uses the BM25 index for Boolean filtering (1.5.0+) |

The 1.0 announcement and the maintainer's hybrid tutorial state that `<@>` query terms are combined with OR: a document matching any term scores.[^3][^4] The 1.5.1 README does not restate this; verify on your version before relying on it.

Without a `LIMIT` that reaches the index scan, `pg_textsearch.default_limit` (1000) sets the initial scoring batch, which grows if more rows are fetched.[^1]

On small tables the planner may choose a seq scan with standalone scoring. To check the index plan:

    SET enable_seqscan = off;
    EXPLAIN SELECT * FROM documents ORDER BY content <@> 'database system' LIMIT 5;

### Explicit Index Names: to_bm25query

    SELECT * FROM documents
    ORDER BY content <@> to_bm25query('database system', 'docs_idx')
    LIMIT 5;

    -- Equivalent cast form
    SELECT 'docs_idx:database system'::bm25query;

The implicit `col <@> 'text'` form relies on planner hooks. Use the explicit form in all of these cases:[^1]

- Inside PL/pgSQL, DO blocks, functions, procedures.
- Prepared statements and dynamic SQL.
- Partial indexes (the implicit form skips them).
- Expressions that match more than one BM25 index.
- Score thresholds in `WHERE`.

`to_bm25query(text)` with one argument has no index context and relies on the same planner resolution.[^5]

### Boolean Filtering with @@ (1.5.0+)

    SELECT * FROM documents
    WHERE content @@ to_tsquery('english', 'postgres & (search | database) & !mysql');

A BM25 index answers core `@@ tsquery` predicates: AND, OR, NOT, pure negation, prefix (`:*`), weights, and phrase (`<->`). Phrase and weight conditions are rechecked against the heap row: the index stores neither positions nor weights.[^1]

> [!WARNING] default_text_search_config must match
> Index-accelerated `@@` requires `default_text_search_config` to equal the index's `text_config`. If the setting changes while a prepared Boolean statement uses a generic plan, `DEALLOCATE` and re-prepare.[^1]

Boolean filter plus ranking (`WHERE col @@ q ORDER BY col <@> 'terms' LIMIT k`) is not a single index scan: PostgreSQL evaluates the filter, scores the matching rows standalone, then sorts them. It is fast only when the filter matches few rows.[^1]

### Scoring and Corpus Statistics

Per-term score (Okapi BM25), summed over query terms, then negated:[^7]

    idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))

    idf = ln(1 + (N - df + 0.5) / (df + 0.5))     -- always >= 0

- `N`, `df`, `avgdl` come from the index. A score expression outside an index scan ("standalone scoring") still reads statistics from the selected BM25 index.[^1]
- Document length `dl` is stored as a 1-byte quantized value: exact for lengths 0–39, roughly 5–11% error above.[^3]
- Statistics are physical index statistics, not MVCC-filtered.[^8]
- **Partitioned tables:** "BM25 statistics are local to each partition. Scores are comparable within a partition but may use different IDF scales across partitions."[^1]
- **RLS:** statistics include rows hidden by row-level security, so a user who knows a term can infer how often it occurs. `pg_textsearch.allow_rls = off` forbids BM25 indexes on RLS-protected tables.[^1]

### Filters: Pre-filter vs Post-filter

When the planner picks the BM25 ordered scan, other `WHERE` conditions are post-filters applied after scoring. Post-filtered scans grow their scoring batch until the `LIMIT` is filled or matches run out. Since 1.4.0, the initial batch is seeded from the planner's selectivity estimate (`pg_textsearch.filtered_seed`); results are the same either way.[^1][^9]

When a selective condition has its own index, PostgreSQL may pre-filter through it (for example a B-tree on `category_id`) and score only those rows standalone. Standalone scoring is expensive: the scoring function has `COST 1000` and is `PARALLEL UNSAFE`.[^5]

    CREATE INDEX ON documents (category_id);

    SELECT * FROM documents
    WHERE category_id = 1
    ORDER BY content <@> 'search terms'
    LIMIT 10;

For a fixed, frequently-queried subset, a partial BM25 index gives that subset its own corpus and a direct top-k scan.

### Write Path, Segments, Compaction

The index is an LSM layout: an on-disk, WAL-logged memtable receives writes and spills into immutable segments, which are merged across up to 8 levels.[^8]

    INSERT/UPDATE -> memtable (on-disk pages + shared-memory read cache)
                  -> spill -> L0 segment -> merge -> L1 ... L7

Spill triggers: `memtable_pages_threshold` (64 pages), `bulk_load_threshold` (100,000 terms in one transaction), VACUUM, or `bm25_spill_index()`. A level holding `segments_per_level` (8) segments merges into the next level. Segments with at least 50% dead documents are rewritten early.[^1][^8]

| `compaction` | Behavior |
|---|---|
| `inline` (default) | One synchronous merge pass during spills, VACUUM, builds. The writer that triggers it pays for the merge; readers are not blocked. |
| `manual` | No automatic merges; run `bm25_compact()` / `bm25_compact_step()` yourself. Legacy `off` is an alias. |
| `background` | Beta (1.5.0+). Requires the `pg_durable` extension 0.2.8+ in the same database, preloaded. Not available for temporary indexes. |

Change policy online: `ALTER INDEX docs_idx SET (compaction = 'manual');` (takes ShareUpdateExclusiveLock). Merges already published are not undone by ROLLBACK.[^1]

If level 0 is full and cannot be merged (all segments over `max_segment_size`), the spill fails with `bm25 segment count limit reached at level 0`.[^8]

### VACUUM, Replication, Standbys

- VACUUM marks dead documents in per-segment alive bitsets (1.1.0+); cost is proportional to dead documents. Fully dead segments are dropped; others are cleaned at the next merge.[^9]
- Update-heavy workloads fragment index pages; `REINDEX` in a quiet window if cold-cache latency degrades. Plain `REINDEX` blocks writes.[^1]
- Physical replication is supported (1.2.0+; stateless WAL replay since 1.3.0). Logical replication sends rows; the subscriber builds its own index.[^3][^9]
- Hot standbys that serve queries **must** set `hot_standby_feedback = on`: freed pages are reclaimed only after the transaction horizon passes.[^1]
- `PREPARE TRANSACTION` is not supported in a transaction that created a BM25 index, or while index-drop cleanup is pending.[^1]

### Index Builds

Large builds use parallel maintenance workers automatically. Workers scan disjoint heap ranges into temporary segments, and the leader merges them into one L0 segment.[^1][^8]

    SET max_parallel_maintenance_workers = 4;
    SET maintenance_work_mem = '256MB';   -- total batch budget shared by workers
    CREATE INDEX docs_idx ON documents USING bm25 (content) WITH (text_config = 'english');

`pg_textsearch.memory_limit` does not govern builds; `maintenance_work_mem` does. Create the index after the initial data load. Partitioned tables build each partition separately.[^1] The index AM supports parallel builds but not parallel scans.[^6]

### Functions

| Function | Purpose |
|---|---|
| `to_bm25query(text)` / `to_bm25query(text, index_name text)` | build a query; second form names the index |
| `bm25_compact(regclass)` | run eligible merge passes to completion; requires index ownership; not on partitioned parent indexes |
| `bm25_compact_step(regclass) → boolean` | run at most one pass; true if one ran |
| `bm25_needs_compaction(regclass) → boolean` | whether a step would run |
| `bm25_level_counts(regclass) → int[]` | segments per LSM level |
| `bm25_force_merge(text)` | one bounded best-effort merge pass; a development function (README: "These interfaces may change without notice.") |
| `bm25_spill_index(text) → int4` | force a memtable spill; development function |
| `bm25_summarize_index(text)`, `bm25_dump_index(text)`, `bm25_pending_free_pages(text)` | superuser-only introspection |

Source: the 1.5.1 install script and README.[^5][^1] Functions marked internal in the script (`bm25_test_*`, `bm25_cache_*`, `bm25_memtable_*`, `bm25_compact_step_if_current`) are not public API. `bm25_memory_usage()` appeared in 1.1.0 and is absent from the 1.5.1 script.

### Configuration GUCs

All under the reserved prefix `pg_textsearch.` (typos produce a warning).[^10]

| GUC | Default | Context | Meaning |
|---|---|---|---|
| `library_version` | build version | read-only | loaded shared library version |
| `default_limit` | `1000` | user | initial scoring batch when no LIMIT is pushed down (1–100000) |
| `compress_segments` | `on` | user | delta + bitpacked posting blocks in new segments |
| `filtered_seed` | `on` | user | seed top-k from filter selectivity |
| `filtered_seed_margin` | `3.0` | user | margin for the seed |
| `memtable_cache_enabled` | `on` | user | shared-memory memtable read cache |
| `memory_limit` | `2GB` | sighup | shared-memory budget for memtable caches across all indexes (`0` = no limit) |
| `memtable_pages_threshold` | `64` | superuser | memtable pages before auto-spill (`0` disables) |
| `bulk_load_threshold` | `100000` | superuser | terms per transaction before spill at commit (`0` disables) |
| `segments_per_level` | `8` | superuser | merge trigger per level (2–64) |
| `max_segment_size` | `4095MB` | superuser | size budget for merged segments |
| `background_compaction_schedule` | `*/5 * * * *` | superuser | default cron schedule for `compaction = 'background'` |
| `allow_rls` | `on` | superuser | `off` forbids BM25 indexes on RLS tables |
| `log_scores`, `log_bmw_stats`, `log_cache_state` | `off` | — | debug logging |

## Per-Version Timeline

PG14–PG18 release notes contain no pg_textsearch items; it is wholly external. The relevant timeline is the extension's own.[^2]

| Version | Released | Key changes |
|---|---|---|
| 0.1.0 | 2025-12-13 | First open-source release, partitioned tables |
| 0.3.0 | 2026-01-09 | Block-Max WAND top-k |
| 0.5.0 | 2026-02-02 | Parallel index builds |
| 0.6.0 | 2026-03-03 | **`shared_preload_libraries` required** |
| 1.0.0 | 2026-03-27 | First GA release |
| 1.1.0 | 2026-04-22 | Concurrent writes, alive-bitset VACUUM, `text[]`, expression and partial indexes |
| 1.2.0 | 2026-05-12 | Physical replication support |
| 1.3.0 | 2026-05-29 | On-disk memtable, stateless WAL replay (index header v7) |
| 1.3.1 | 2026-06-23 | Standby-safe page reclaim (header v8) |
| 1.4.0 | 2026-08-18 | Selectivity-seeded filtered top-k, Chinese via zhparser |
| 1.5.0 | 2026-10-01 | `@@ tsquery` Boolean/phrase filtering, beta background compaction, Windows, RLS controls, PG19 beta (header v9) |
| 1.5.1 | 2026-10-02 | Corruption fix for concurrent spill/force-merge; no format change |

Verify the loaded binary against the installed SQL version:[^11]

    SELECT current_setting('pg_textsearch.library_version', true) AS loaded_version,
           (SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch') AS installed_version;

> [!WARNING] Upgrades can be one-way
> Upgrade order: install the new binary, restart, then `ALTER EXTENSION pg_textsearch UPDATE` in each database (the script errors on a library version mismatch). 1.3.1 and 1.5.0 change the index header format: once a newer server writes an index, older binaries, including replicas, cannot read it, and rolling back the binary does not undo this. Upgrade replicas first. Indexes built with 0.5.0 or earlier must be rebuilt. When moving from a release before 1.3.0, documents not yet spilled from the old in-memory memtable may be missing after the binaries change: spill first (`bm25_spill_index()`) or `REINDEX` afterwards. Indexes built before 1.5.0 omit empty or stopword-only documents; `REINDEX` if you need complete results for negative Boolean queries such as `!missing`.[^11]

## Recipes

### Recipe 1 — Install and first ranked query

    -- postgresql.conf: shared_preload_libraries = 'pg_textsearch'; restart
    CREATE EXTENSION pg_textsearch;

    CREATE TABLE documents (
        id bigserial PRIMARY KEY,
        content text,
        category_id integer
    );

    CREATE INDEX docs_idx ON documents USING bm25 (content) WITH (text_config = 'english');

    SELECT id, content, content <@> 'database system' AS score
    FROM documents
    ORDER BY content <@> 'database system'
    LIMIT 10;

### Recipe 2 — Search from a PL/pgSQL function

The implicit form does not resolve inside functions; name the index.

    CREATE FUNCTION search_docs(q text, k int DEFAULT 10)
    RETURNS TABLE (id bigint, score float8)
    LANGUAGE plpgsql STABLE AS $$
    BEGIN
        RETURN QUERY
        SELECT d.id, d.content <@> to_bm25query(q, 'docs_idx')
        FROM documents d
        ORDER BY d.content <@> to_bm25query(q, 'docs_idx')
        LIMIT k;
    END $$;

### Recipe 3 — Multilingual table

    ALTER TABLE documents ADD COLUMN lang char(2) NOT NULL DEFAULT 'en';

    CREATE INDEX docs_en_idx ON documents USING bm25 (content)
        WITH (text_config = 'english') WHERE lang = 'en';
    CREATE INDEX docs_de_idx ON documents USING bm25 (content)
        WITH (text_config = 'german') WHERE lang = 'de';

    SELECT * FROM documents
    WHERE lang = 'en'
    ORDER BY content <@> to_bm25query('databases', 'docs_en_idx')
    LIMIT 10;

### Recipe 4 — Search a JSONB field

    CREATE INDEX events_expr_idx ON events USING bm25 ((data->>'description'))
        WITH (text_config = 'english');

    SELECT * FROM events
    ORDER BY (data->>'description') <@> to_bm25query('network error', 'events_expr_idx')
    LIMIT 10;

### Recipe 5 — Hybrid search: BM25 + pgvector with Reciprocal Rank Fusion

BM25 scores and cosine distances use different scales, so fuse by rank position: `1 / (60 + rank)` per list, summed. The repo README has no hybrid recipe; this pattern is from the maintainer's tutorial.[^4]

    WITH bm25_results AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY description <@> to_bm25query($2, 'episodes_bm25_idx')) AS rank
        FROM episodes
        ORDER BY description <@> to_bm25query($2, 'episodes_bm25_idx')
        LIMIT 20
    ),
    vector_results AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS rank
        FROM episodes
        ORDER BY embedding <=> $1
        LIMIT 20
    )
    SELECT d.id, d.title,
           COALESCE(1.0 / (60 + b.rank), 0) + COALESCE(1.0 / (60 + v.rank), 0) AS rrf_score
    FROM episodes d
    LEFT JOIN bm25_results b ON d.id = b.id
    LEFT JOIN vector_results v ON d.id = v.id
    WHERE b.id IS NOT NULL OR v.id IS NOT NULL
    ORDER BY rrf_score DESC
    LIMIT 10;

`$1` is the query embedding, `$2` the query text. For a weighted blend, multiply each term (for example `0.7 *` vector, `0.3 *` keyword).

### Recipe 6 — Highlight matches

pg_textsearch has no highlighter; apply core `ts_headline` to the top-k rows only.

    SELECT title,
           ts_headline('english', description, plainto_tsquery('english', 'productivity')),
           description <@> 'productivity' AS score
    FROM episodes
    ORDER BY description <@> 'productivity'
    LIMIT 10;

### Recipe 7 — Phrase match with ranking

    -- 1.5.0+: phrase filter through the index (heap recheck), then rank
    SET default_text_search_config = 'english';

    SELECT * FROM episodes
    WHERE description @@ phraseto_tsquery('english', 'year end planning')
    ORDER BY description <@> 'year end planning'
    LIMIT 10;

Fast only when the phrase matches few rows (filter, then standalone scoring, then sort).

### Recipe 8 — Bulk load and compaction

    SET max_parallel_maintenance_workers = 4;
    SET maintenance_work_mem = '256MB';

    -- Load first, index second
    COPY documents (content, category_id) FROM '/data/docs.csv' WITH (FORMAT csv);
    CREATE INDEX docs_idx ON documents USING bm25 (content) WITH (text_config = 'english');

    -- After later bulk loads: inspect, then merge
    SELECT bm25_level_counts('docs_idx'::regclass);
    SELECT bm25_needs_compaction('docs_idx'::regclass);
    SELECT bm25_compact('docs_idx'::regclass);

### Recipe 9 — Find BM25 indexes and their usage

    SELECT s.schemaname, s.relname AS tablename, s.indexrelname AS indexname,
           s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
    FROM pg_stat_user_indexes s
    JOIN pg_class i ON i.oid = s.indexrelid
    JOIN pg_am am ON am.oid = i.relam
    WHERE am.amname = 'bm25';

## Gotchas

1. **Not on PG14–16.** PG17 and PG18 only.
2. **Restart required.** `shared_preload_libraries` is mandatory since 0.6.0.
3. **`text_config` has no default.** Index creation fails without it.
4. **Negative scores.** Order ascending. A threshold filter reads `< -1.5`, not `> 1.5`.
5. **Implicit `<@>` fails in PL/pgSQL, prepared and dynamic SQL, and skips partial indexes.** Use `to_bm25query(q, 'index_name')`.
6. **Scores are not comparable across partitions or indexes.** IDF is per index, and partitions have their own indexes.
7. **No per-field weighting.** `ARRAY[title, body]` merges fields into one document. Core FTS `setweight` has no BM25 equivalent here.
8. **No positions.** Phrase queries need `@@` with heap recheck (1.5.0+). Older posts and tutorials say phrase search is unsupported and suggest over-fetching plus `ILIKE`; that advice predates 1.5.0.
9. **Boolean `@@` + ranking is filter, then score, then sort.** It slows down as the filter matches more rows.
10. **Hot standbys need `hot_standby_feedback = on`.**
11. **One-way index format upgrades** (1.3.1, 1.5.0). Upgrade replicas before the primary.
12. **RLS leaks term statistics.** Corpus statistics include hidden rows.
13. **Old docs use the wrong access method name.** The preview announcement shows `USING pg_textsearch(content)`; the access method is `bm25`.
14. **Long tokens.** Lexemes over 2047 bytes are ignored by the core parser. Inputs over 256 KB are split before tokenization.[^1]
15. **Wait event labels.** pg_textsearch uses LWLock tranche IDs 1001–1012; another extension using the same IDs can mislabel wait events in `pg_stat_activity`.[^1]

## See Also

- [`20-text-search.md`](./20-text-search.md) — core `tsvector`/`tsquery`, text search configurations, `ts_rank`, `ts_headline`
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN, the core FTS index
- [`35-partitioning.md`](./35-partitioning.md) — per-partition indexes, and therefore per-partition IDF
- [`47-row-level-security.md`](./47-row-level-security.md) — RLS and the statistics leak
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries`
- [`56-explain.md`](./56-explain.md) — confirm the BM25 index scan
- [`69-extensions.md`](./69-extensions.md) — `CREATE EXTENSION`, `ALTER EXTENSION UPDATE`
- [`73-streaming-replication.md`](./73-streaming-replication.md) — `hot_standby_feedback`
- [`93-pg-trgm.md`](./93-pg-trgm.md) — fuzzy and typo-tolerant matching
- [`94-pgvector.md`](./94-pgvector.md) — the vector half of hybrid search
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — preload restrictions on managed services

## Sources

[^1]: pg_textsearch README at v1.5.1 — `https://github.com/timescale/pg_textsearch/blob/v1.5.1/README.md` — supported PG versions, install, syntax, options, filtering, partitioning, RLS, standby, limits.

[^2]: pg_textsearch releases — `https://github.com/timescale/pg_textsearch/releases` — version history and dates.

[^3]: pg_textsearch 1.0 design and benchmark post (2026-03-31) — `https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres` — Block-Max WAND, quantized lengths, no positions, replication behavior, OR semantics.

[^4]: Hybrid search tutorial — `https://www.tigerdata.com/docs/learn/tutorials/hybrid-search` — RRF recipe, `ts_headline`, generated-column pattern, Docker image.

[^5]: v1.5.1 install script — `https://github.com/timescale/pg_textsearch/blob/v1.5.1/sql/pg_textsearch--1.5.1.sql` — types, operators, function signatures, costs, parallel labels. Required-option error text from `https://github.com/timescale/pg_textsearch/blob/main/src/access/build.c`.

[^6]: Index AM handler — `https://github.com/timescale/pg_textsearch/blob/main/src/access/handler.c` — AM capabilities.

[^7]: Scoring source — `https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bm25.c` and `https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bmw.c` — IDF and per-term formula.

[^8]: ARCHITECTURE.md — `https://github.com/timescale/pg_textsearch/blob/main/ARCHITECTURE.md` — LSM layout, compaction, statistics, page reclaim, build.

[^9]: Release notes v1.1.0–v1.5.1 — `https://github.com/timescale/pg_textsearch/releases` — VACUUM bitsets (1.1.0), replication (1.2.0, 1.3.0), filtered seeding (1.4.0), `@@` (1.5.0).

[^10]: GUC and reloption definitions — `https://github.com/timescale/pg_textsearch/blob/main/src/mod.c`.

[^11]: UPGRADING.md — `https://github.com/timescale/pg_textsearch/blob/main/UPGRADING.md` — upgrade order, header versions, rebuild requirements.

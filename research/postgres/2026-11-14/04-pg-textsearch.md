# pg_textsearch research

Researched 2026-11-14. Primary sources: GitHub repo `timescale/pg_textsearch` (README at tag v1.5.1, ARCHITECTURE.md, UPGRADING.md, `sql/pg_textsearch--1.5.1.sql`, `src/mod.c`, `src/access/handler.c`, `src/scoring/*.c`, GitHub release notes), Tiger Data blog posts and docs, Neon FAQ (third-party comparison), PostgreSQL.org news.

Source labels used in tables:

- `README@1.5.1` = https://github.com/timescale/pg_textsearch/blob/v1.5.1/README.md (diffed against `main`: identical except `main` adds an "Upgrading" pointer to UPGRADING.md)
- `SQL@1.5.1` = https://github.com/timescale/pg_textsearch/blob/v1.5.1/sql/pg_textsearch--1.5.1.sql (the full install script; `main` has `pg_textsearch--1.6.0-dev.sql`, identical except version strings)
- `mod.c` = https://github.com/timescale/pg_textsearch/blob/main/src/mod.c (GUC and reloption definitions; the set of GUC names is identical at v1.5.1 and `main`)
- `handler.c` = https://github.com/timescale/pg_textsearch/blob/main/src/access/handler.c (index AM capabilities)
- `ARCH` = https://github.com/timescale/pg_textsearch/blob/main/ARCHITECTURE.md
- `UPGR` = https://github.com/timescale/pg_textsearch/blob/main/UPGRADING.md
- `bm25.c` / `bmw.c` = https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bm25.c, `.../bmw.c`

## Identity

```yaml
repo: https://github.com/timescale/pg_textsearch   # confirmed; maintainer org is Timescale, now branded Tiger Data
maintainer: Tiger Data (formerly Timescale). Implementor per the preview blog: Todd J. Green (Senior Staff Engineer, Tiger Data)
description: "PostgreSQL extension for BM25 relevance-ranked full-text search. Postgres OSS licensed."   # GitHub repo description
license: PostgreSQL License (SPDX: PostgreSQL)   # GitHub API license field; LICENSE file in repo
latest_version: v1.5.1
released: 2026-10-02 (v1.5.0 was 2026-10-01)
unreleased: main is at 1.6.0-dev (default_version in pg_textsearch.control on main; bumped 2026-10-02)
status: GA since v1.0.0 (2026-03-27 tag; README Version History says "First generally available release"). Preview releases were v0.0.1 (2025-10-14) through v0.6.x. Tiger Cloud docs call it "production-ready".
pg_versions: PostgreSQL 17 and 18 supported. PostgreSQL 19 "best-effort while in beta; its CI is allowed to fail and prebuilt binaries are not published for it yet" (README). NOT supported on PG 14, 15, 16. CI matrix is [17, 18].
install:
  create_extension_name: pg_textsearch
  shared_preload_libraries: REQUIRED (since v0.6.0). Server restart required. _PG_init raises an error if not loaded via shared_preload_libraries. CREATE EXTENSION's install script also raises "pg_textsearch library not loaded. Add pg_textsearch to shared_preload_libraries and restart."
  extension_is_relocatable: false   # pg_textsearch.control
  packages: GitHub Releases ship per-PG-version zip/tar.gz for pg17 and pg18, Linux amd64 and arm64 (v1.5.1 assets listed below). README says "Available for Linux on amd64 and arm64".
  source_build: "make && make install" (Linux/Mac); Windows via MSVC "nmake /F Makefile.win" (Windows support added v1.5.0). PG_CONFIG env var selects the PG install. Needs postgresql-server-dev-17/18.
  docker: the timescale/timescaledb-ha:pg17 image ships PostgreSQL, TimescaleDB, pgvector, pgvectorscale and pg_textsearch pre-installed, with shared_preload_libraries already set (Tiger Data hybrid-search tutorial). No standalone upstream pg_textsearch Docker image found.
```

v1.5.1 release assets (from `gh release view v1.5.1`): `pg-textsearch-v1.5.1-pg17-amd64.zip`, `-pg17-arm64.zip`, `-pg18-amd64.zip`, `-pg18-arm64.zip`, `pg_textsearch-1.5.1.tar.bz2`, `.tar.gz`, `pg_textsearch-pg17-v1.5.1.tar.gz`, `pg_textsearch-pg18-v1.5.1.tar.gz`. Source: https://github.com/timescale/pg_textsearch/releases/tag/v1.5.1

PG 19 status (for context, not pg_textsearch): official PostgreSQL.org RC1 announcement (2026-10-15) says planned PG 19 GA date is 2026-11-19. As of 2026-11-14 PG 19 is a release candidate, not GA. https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/

Upgrade mechanics (UPGR): install binary, restart, then `ALTER EXTENSION pg_textsearch UPDATE TO 'x.y.z'` in each database. Check `current_setting('pg_textsearch.library_version', true)` (loaded binary) against `pg_extension.extversion` (SQL version). Some upgrades need `REINDEX` (see Version history and Limitations).

## SQL surface

### Index access method

| Item | Value | Source |
|---|---|---|
| Access method | `bm25` (`CREATE ACCESS METHOD bm25 TYPE INDEX HANDLER tp_handler`) | SQL@1.5.1 |
| Syntax | `CREATE INDEX name ON table USING bm25 (col_or_expr) WITH (text_config='english' [, k1=.., b=..]);` | README@1.5.1 |
| Default operator class, `text` | `text_bm25_ops`: registers `@@ (text, tsquery)` (boolean filtering) and `<@> (text, bm25query) FOR ORDER BY float_ops` | SQL@1.5.1 |
| Default operator class, `text[]` | `text_array_bm25_ops`: registers `<@> (text[], bm25query) FOR ORDER BY float_ops` | SQL@1.5.1 |
| Columns per index | single column only (`amcanmulticol = false`) | handler.c |
| Other AM capabilities | ordered scans by operator yes (`amcanorderbyop`); no UNIQUE; no backward scan; no INCLUDE columns; no parallel index scan (`amcanparallel = false`); parallel index BUILD yes (`amcanbuildparallel`); parallel VACUUM bulk-delete supported | handler.c |
| Indexable expression types | `text`, `varchar`, `char`, or arrays thereof; must use only IMMUTABLE functions; queries must repeat the same expression in ORDER BY | README@1.5.1 |
| Partial indexes (`WHERE`) | supported since v1.1.0; require explicit index naming via `to_bm25query()` (implicit `text <@> 'q'` skips them) | README@1.5.1, release v1.1.0 |

### Index options (WITH clause)

| Option | Default | Range / values | Notes | Source |
|---|---|---|---|---|
| `text_config` | none, REQUIRED | any `regconfig` name (e.g. `'english'`, `'simple'`, `'public.chinese'`) | omitting it raises `text_config parameter is required for bm25 indexes` with hint | README@1.5.1; build.c error text (https://github.com/timescale/pg_textsearch/blob/main/src/access/build.c) |
| `k1` | 1.2 | 0.1 to 10.0 | term-frequency saturation | README@1.5.1; mod.c (`add_real_reloption`) |
| `b` | 0.75 | 0.0 to 1.0 | length normalization | README@1.5.1; mod.c |
| `compaction` | `inline` | `inline`, `background`, `manual` (legacy `off` accepted as alias for `manual`) | spill-time compaction policy; changeable with `ALTER INDEX ... SET (compaction = ...)` (ShareUpdateExclusiveLock) | README@1.5.1; mod.c; ARCH |
| `compaction_schedule` | `pg_textsearch.background_compaction_schedule` | cron string | captured when index enters background mode; `ALTER INDEX ... RESET (compaction_schedule)` re-reads the GUC default | README@1.5.1 |
| `compaction_lineage` | internal | hex string | internal, set by managed background compaction; not for users | mod.c |

### Types

| Type | Purpose | Source |
|---|---|---|
| `bm25query` | query text plus optional index name. Text I/O form `'index_name:query text'::bm25query`. Has `=` operator. | SQL@1.5.1; README@1.5.1 |
| `bm25vector` | term-frequency vector type; has `=` operator. README documents no user-facing use. The Oct 2025 preview blog says it "stores term frequencies with index context". | SQL@1.5.1 |

### Operators

| Operator | Returns | Meaning | Source |
|---|---|---|---|
| `text <@> bm25query` | `float8` | BM25 score, NEGATED (lower = better match). Implemented by `bm25_text_bm25query_score` (STABLE, PARALLEL UNSAFE, COST 1000) | SQL@1.5.1 |
| `text <@> text` | `float8` | implicit-index form. A planner hook rewrites it to `text <@> bm25query` when it can resolve a BM25 index; the underlying function errors if no index scan context | SQL@1.5.1 |
| `text[] <@> bm25query`, `text[] <@> text` | `float8` | same, for array columns; elements flattened with spaces into one document | SQL@1.5.1; README@1.5.1 |
| `text @@ tsquery` (core operator) | `boolean` | Boolean filtering through a BM25 index (AND, OR, NOT, pure negative, prefix `:*`, weights, phrase `<->`). Added v1.5.0. | README@1.5.1; release v1.5.0 |
| `bm25query = bm25query` | `boolean` | equality | SQL@1.5.1 |
| `bm25vector = bm25vector` | `boolean` | equality | SQL@1.5.1 |

### User-facing functions

| Signature | Notes | Source |
|---|---|---|
| `to_bm25query(input_text text) RETURNS bm25query` | no index context; index resolved from the column by the planner | SQL@1.5.1 |
| `to_bm25query(input_text text, index_name text) RETURNS bm25query` | explicit index; required for partial indexes, PL/pgSQL, prepared/dynamic SQL, ambiguous expressions, and `WHERE` score filters | SQL@1.5.1; README@1.5.1 |
| `bm25_force_merge(index_name text) RETURNS void` | one bounded best-effort compaction pass (Lucene `forceMerge`-like); oversized segments may remain; README marks it under "Development Functions" (may change without notice) | SQL@1.5.1; README@1.5.1 |
| `bm25_spill_index(index_name text) RETURNS int4` | force memtable spill to an L0 segment (listed as development function) | SQL@1.5.1; README@1.5.1 |
| `bm25_compact(idx regclass) RETURNS void` | run eligible compaction passes to completion (PARALLEL default); requires index ownership; not for partitioned parent indexes or during recovery | SQL@1.5.1; README@1.5.1 |
| `bm25_compact_step(idx regclass) RETURNS boolean` | run at most one pass; true if one ran | SQL@1.5.1 |
| `bm25_needs_compaction(idx regclass) RETURNS boolean` | advisory; whether `bm25_compact_step` would run (PARALLEL RESTRICTED) | SQL@1.5.1 |
| `bm25_level_counts(idx regclass) RETURNS int[]` | segments held at each of the eight LSM levels (PARALLEL RESTRICTED) | SQL@1.5.1; README@1.5.1 |
| `bm25_summarize_index(text) RETURNS text` | superuser only (EXECUTE revoked from PUBLIC) | SQL@1.5.1 |
| `bm25_dump_index(text) RETURNS text` | superuser only; shows header version; output truncated | SQL@1.5.1; UPGR |
| `bm25_pending_free_pages(index_name text) RETURNS bigint` | superuser only; pages awaiting standby-safe reclaim | SQL@1.5.1; README@1.5.1 |
| `bm25_debug_scoring_passes(reset boolean DEFAULT false) RETURNS bigint` | session-local debug counter; not documented in README | SQL@1.5.1 |

Internal, undocumented, subject to removal in any release (do not put in the page): `bm25_compact_step_if_current`, `bm25_background_target_is_current` (PUBLIC revoked), and test scaffolds `bm25_test_*`, `bm25_memtable_chain`, `bm25_memtable_dead_pages`, `bm25_cache_*` (all marked "INTERNAL-ONLY" in SQL@1.5.1).

Note: `bm25_memory_usage()` appeared in v1.1.0 release notes and in the Tiger Cloud docs page, but is NOT in `sql/pg_textsearch--1.5.1.sql` (grep count 0). Treat as removed (the memtable became an on-disk chain in v1.3.0).

### GUCs (all prefixed `pg_textsearch.`; prefix reserved via `MarkGUCPrefixReserved`, so typos warn)

| GUC | Default | Context | Range | Meaning | Source |
|---|---|---|---|---|---|
| `library_version` | build version | internal (read-only) | | version of loaded shared library | mod.c; UPGR |
| `default_limit` | 1000 | USERSET | 1 to 100000 | initial scoring batch when no SQL `LIMIT` is pushed down; can grow as more rows are requested | mod.c; README@1.5.1 |
| `compress_segments` | on | USERSET | bool | compress posting blocks (delta + bitpacking) in new segments | mod.c; README@1.5.1 |
| `filtered_seed` | on | USERSET | bool | seed top-K from planner selectivity estimate when a filter sits above a BM25 top-k scan: seed = ceil(margin * LIMIT / selectivity). Results identical either way. Not in README settings table. | mod.c |
| `filtered_seed_margin` | 3.0 | USERSET | 1.0 to 1000.0 | margin for the above | mod.c |
| `memtable_cache_enabled` | on | USERSET | bool | derived shared-memory cache of memtable; standbys always read the chain | mod.c; README@1.5.1 |
| `memory_limit` | 2GB | SIGHUP | 0 (no limit) to INT_MAX kB | approximate shared-memory budget for the memtable cache across all indexes; tiers at limit/8 (per-index per-record guard), limit/2 (global eviction), limit (admission) | mod.c; README@1.5.1; ARCH |
| `memtable_pages_threshold` | 64 | SUSET | 0 (disable) up | on-disk memtable chain pages (8 KiB each) before auto-spill | mod.c; README@1.5.1 |
| `bulk_load_threshold` | 100000 | SUSET | 0 (disable) up | terms per transaction before auto-spill at transaction end | mod.c; README@1.5.1 |
| `segments_per_level` | 8 | SUSET | 2 to 64 | count-triggered compaction threshold and max inputs per opportunistic merge | mod.c; README@1.5.1 |
| `max_segment_size` | 4095MB | SUSET | 1 to 4095 MB | conservative size budget for newly merged multi-source segments | mod.c; README@1.5.1 |
| `background_compaction_schedule` | `*/5 * * * *` | SUSET | cron string | default cron schedule for indexes entering `compaction = 'background'` | mod.c; README@1.5.1 |
| `allow_rls` | on | SUSET | bool | when off, BM25 indexes cannot be created/rebuilt on RLS-protected tables and RLS cannot be enabled where a BM25 index exists | mod.c; README@1.5.1 |
| `log_scores` | off | SUSET | bool | log BM25 score of each returned doc (debugging) | mod.c |
| `log_bmw_stats` | off | SUSET | bool | log Block-Max WAND blocks scanned/skipped | mod.c |
| `log_cache_state` | off | USERSET | bool | log memtable cache state transitions | mod.c |
| `debug_segment_graph_snapshot_*_ms` (3 GUCs) | 0 | SUSET | 0 to 60000 | testing-only pauses; ignore | mod.c |

Related core GUCs documented by upstream for builds: `max_parallel_maintenance_workers`, `maintenance_work_mem` ("sets the total batch budget shared by parallel workers"; `memory_limit` does not govern index builds), `enable_seqscan` (for testing index plans), `default_text_search_config` (must match the index's `text_config` for Boolean `@@` filtering), `hot_standby_feedback` (must be on for query-serving hot standbys). Source: README@1.5.1.

## Mechanics

### Scoring

- Per-term score (bmw.c lines ~370-395): `idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))`. Document score is the sum over query terms. Source: https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bmw.c
- IDF (bm25.c, `tp_calculate_idf`): `ln(1 + (N - df + 0.5) / (df + 0.5))`, always non-negative. Source: https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bm25.c
- Reported score is the negation of the BM25 sum, so ascending `ORDER BY` returns best first. README: "`<@>` returns negative BM25 scores for ascending index scans, so lower scores rank first."
- Document length `dl` is a quantized 1-byte "fieldnorm" (Lucene/Tantivy SmallFloat encoding): exact for lengths 0-39, quantization error about 5% to 11% for longer documents (1.0 blog). Source: https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres
- Tokenization uses core `to_tsvector(text_config, ...)` (stemming and stopwords per the config). Source: 1.0 blog; preview blog ("piggyback on Postgres' mature ... support for tokenization, by using the standard tsvector under the covers"). The same `text_config` tokenizes documents and queries (README, Chinese section).
- No term positions are stored (1.0 blog: "index stores term frequencies but not term positions"). Phrase and weight queries via `@@` are therefore handled with heap rechecks ("Phrase and weight checks may be rechecked against the table row after the index finds candidates", README@1.5.1).
- Query-term OR semantics: the 1.0 blog and the hybrid tutorial say all `<@>` query terms are implicitly OR'd; any matching term contributes. Boolean AND/NOT is now via `@@ tsquery`. (Not re-verified against v1.5.1 `<@>` code; see Not verified.)

### IDF / corpus statistics scope

- Statistics (N, df, avgdl) are per index. README: "`<@>` can also score rows outside a BM25 index scan. This is standalone scoring; it still uses corpus statistics from the selected BM25 index."
- Even when EXPLAIN shows a seq scan, `<@>` / `to_bm25query()` still consult the BM25 index for corpus statistics (Tiger Cloud docs page, which is stale at v1.1.0; README@1.5.1 repeats the standalone-scoring statement).
- Partitioned tables: "BM25 statistics are local to each partition. Scores are comparable within a partition but may use different IDF scales across partitions. Query individual partitions when cross-row score comparability matters." (README@1.5.1)
- Partial indexes: statistics cover only the rows matching the index predicate (follows from "one index = one corpus"; README multilingual recipe builds one partial index per language, each with its own text_config). Not stated verbatim as a statistics rule.
- Statistics are "physical index statistics, not MVCC-filtered corpus statistics" (ARCH). Each scan or standalone score expression captures one generation of statistics per physical index and executor; a later statement captures fresh statistics.
- RLS: corpus statistics include rows hidden by RLS; a user who knows a term can infer frequency information. `pg_textsearch.allow_rls = off` blocks creating indexes on RLS tables. (README@1.5.1)

### Query execution

- `ORDER BY col <@> 'q' LIMIT n` uses the BM25 index scan (ordered scan via `amcanorderbyop`). Scoring uses Block-Max WAND (BMW) with WAND pivot selection for multi-term queries; blocks are 128 postings with per-block max tf and min fieldnorm upper-bound metadata. `LIMIT n` is the top-k count pushed down. Without a pushed-down `LIMIT`, `pg_textsearch.default_limit` sets the initial scoring batch, which "can grow as more rows are requested". Sources: README@1.5.1, 1.0 blog.
- Scoring the top-k requires LIMIT to be visible to the index scan; README says "Without a pushed-down SQL LIMIT, `pg_textsearch.default_limit` sets the initial scoring batch" (so a missing LIMIT does not fail; it falls back to the batch).
- Small tables: the planner may prefer a seq scan with standalone scoring; use `SET enable_seqscan = off;` to test the index plan (README@1.5.1).
- WHERE filters when the BM25 ordered scan is chosen: "other conditions are post-filters applied after BM25 scoring ... Post-filtered scans automatically grow their internal scoring batch until the LIMIT is filled or matches are exhausted." (README@1.5.1). v1.4.0 added selectivity-based seeding of top-K for filtered queries (up to 5x speedup per release note; `filtered_seed` GUC).
- Pre-filtering: PostgreSQL can use a separate index (e.g. B-tree on `category_id`) to restrict rows before standalone scoring (README recipe below). Standalone scoring is expensive (function COST 1000; SQL comment says `to_tsvector` costs about 14 microseconds per doc plus index lookups).
- Standalone scoring function is PARALLEL UNSAFE and the index AM has no parallel scan, so score expressions do not run in parallel workers (SQL@1.5.1 comments; handler.c).
- Boolean filter + ranking: "supported, but is not yet optimized as a single index scan. PostgreSQL currently evaluates the filter, calculates standalone scores for the matching rows, and then sorts them. This is most effective when the Boolean filter matches relatively few rows." (README@1.5.1)
- Score threshold in WHERE (e.g. `col <@> to_bm25query('q','idx') < -1.5`) works with an explicit index name; Tiger Cloud docs show it as the documented pattern (page is v1.1.0-era). Note that in standalone scoring a non-matching row scores `0` in the Tiger Cloud example output.

### Write path, storage, VACUUM

- LSM-like layout: "an on-disk memtable receives writes and spills into immutable segments that are compacted across levels" (ARCH). Up to 8 levels (`TP_MAX_LEVELS 8`, constants.h). A level holding `segments_per_level` (8) segments is merged into the next level.
- History: v0.x kept the memtable in shared memory and rebuilt from the heap at startup (preview and 1.0 blogs). v1.2.0 added custom WAL for replicas. v1.3.0 replaced that with a paged (on-disk, WAL-logged) memtable plus a derived, disposable shared-memory read cache, so WAL replay is stateless (release v1.3.0). There is no custom WAL resource manager; index uses GenericXLog and `log_newpage_buffer` (ARCH). Works with physical replication, pg_dump, pg_upgrade; logical replication replicates rows and the index is rebuilt on the subscriber (1.0 blog).
- Memtable spill triggers: `memtable_pages_threshold` (64 pages), `bulk_load_threshold` (100000 terms in one transaction), VACUUM, manual `bm25_spill_index()`.
- Compaction policy `inline` (default): one synchronous pass during spills, serial VACUUM and index builds; skipped (not blocked) when another session is reindexing, vacuuming or compacting. The writer that triggers it pays for the merge ("reader non-blocking, not foreground-writer non-blocking"). `manual`: debt left for explicit `bm25_compact*`. `background`: beta, requires Microsoft `pg_durable` extension 0.2.8+ in the same database, preloaded, owner with LOGIN. Temporary indexes do not support background mode. (README@1.5.1, ARCH)
- A level-0 already at `segments_per_level` blocks the spill; if it cannot be reduced (all segments over `max_segment_size`) the spill fails closed with "bm25 segment count limit reached at level 0" (ARCH; build.c).
- Segments with at least 50% dead documents are rewritten even below the count threshold (README, ARCH).
- VACUUM: since v1.1.0, per-segment alive bitsets (1 bit per doc); cost O(dead_docs); fully dead segments dropped; dead docs filtered during scoring and physically removed at next merge (release v1.1.0). Update-heavy workloads: "can fragment index pages. Use REINDEX during a low-traffic window if cold-cache latency degrades." (README@1.5.1)
- Deferred page reclaim: displaced pages are returned to the FSM only after the transaction horizon passes. Hot standbys serving queries "must set `hot_standby_feedback = on`" (README@1.5.1, ARCH).
- Index is fully transactional / MVCC-correct and maintained automatically on INSERT/UPDATE/DELETE (preview blog; 1.0 blog "MVCC visibility, proper rollback on abort").
- `PREPARE TRANSACTION` is not supported after creating a BM25 index (until that DDL commits) or while index-drop cleanup is pending (README@1.5.1).

### Index build and parallelism

- Parallel builds use PG's parallel maintenance workers automatically for large tables: `SET max_parallel_maintenance_workers = 4; SET maintenance_work_mem = '256MB';`. `maintenance_work_mem` is "the total batch budget shared by parallel workers" (README@1.5.1). Tiger Cloud docs (v1.1.0-era) add: planner needs `maintenance_work_mem >= 64MB` for a parallel build, otherwise it falls back to serial silently; a `NOTICE: parallel index build: launched N of N requested workers` is shown.
- Workers scan disjoint heap ranges and write temporary segments; the leader merges them into one final L0 segment (ARCH; 1.0 blog). 1.0 blog benchmark: 138M passages in 17 min 37 s with 15 workers.
- "For initial loads, create the index after loading data." (README@1.5.1)
- Partitioned tables build each partition separately (README@1.5.1). `CREATE INDEX CONCURRENTLY` / concurrent builds supported since v0.5.1 per README Version History ("Concurrent index builds"). 

## Limitations & gotchas

Documented by the project at v1.5.1 unless a different source is named:

1. `shared_preload_libraries = 'pg_textsearch'` is mandatory and needs a restart; CREATE EXTENSION fails otherwise. After upgrading the binary, restart before `ALTER EXTENSION UPDATE` (the SQL script checks the loaded library version equals the script version and raises "library version mismatch").
2. Supported on PG 17 and 18 only (PG 19 best-effort, no binaries). Nothing for PG 14-16.
3. `text_config` is required; there is no default config. The `default_text_search_config` GUC must equal the index's config for Boolean `@@` filtering through the index. If it changes while a prepared Boolean statement uses a generic plan, `DEALLOCATE` and re-prepare.
4. Scores are negative; lower is better; ascending `ORDER BY` is the natural order. Scores are not comparable across indexes, partitions, or text_configs.
5. Single column per index. For multiple columns, index an expression (`(coalesce(title,'') || ' ' || coalesce(body,''))`), a generated column, or `ARRAY[title, body]` (array elements flatten with spaces and do not preserve element boundaries; no per-field weighting).
6. Implicit syntax `col <@> 'text'` relies on planner hooks. These do NOT resolve inside PL/pgSQL, DO blocks, functions, procedures, or prepared/dynamic query text; use `to_bm25query('text', 'index_name')`. Partial indexes and ambiguous expressions also need explicit index names.
7. Phrase queries: no positional index. v1.5.0 added phrase (`<->`) and weight conditions through `@@ tsquery`, executed via conservative heap rechecks. The 1.0 blog and the Tiger Data hybrid tutorial (still published, say "extension 1.0") list "No phrase queries" and recommend an over-fetch plus `ILIKE` post-filter; this is superseded for `@@` but the pattern is still the documented workaround for `<@>` ranking.
8. Highlighting: not provided; use core `ts_headline()` on the result set (hybrid tutorial; 1.0 blog).
9. Fuzzy / typo tolerance: none; use `pg_trgm` (1.0 blog).
10. Post-filtering with a selective WHERE can under-fill LIMIT in the older (v1.1.0-era) Tiger Cloud docs; README@1.5.1 says post-filtered scans grow the scoring batch until LIMIT is filled or matches exhausted. Prefer the README.
11. Boolean `@@` + ranking is evaluated as filter, then standalone score, then sort; it is only fast when the filter matches few rows.
12. Partitioned tables: per-partition statistics, so cross-partition score comparison is unreliable. `bm25_compact*` do not operate on partitioned parent indexes.
13. Token limits: lexemes over 2047 bytes are ignored by PG's parser; raw inputs over 256KB are split at whitespace/multibyte boundaries before tokenization and term frequencies merged.
14. RLS: statistics leak (see Mechanics). `pg_textsearch.allow_rls` (superuser) can forbid it.
15. `PREPARE TRANSACTION` restriction after creating a BM25 index.
16. LWLock tranche IDs 1001-1012 are used; may mislabel wait events in `pg_stat_activity` if another extension uses the same IDs.
17. Upgrade traps (UPGR): indexes built with v0.5.0 or earlier cannot be read by any current release and must be rebuilt. v1.3.0: documents not yet spilled from pre-v1.3 memtable may be missing after changing binaries (spill first or REINDEX). v1.3.1 and v1.5.0 change the index header format (version 8 then 9); once a newer server writes or maintains the index, older-binary servers (including replicas) cannot read it, and rolling back the binary does not undo this. Indexes built before v1.5.0 omit empty/stopword-only documents; REINDEX if you need complete results for negative Boolean queries such as `!missing` or `alpha | !missing`. Standard `REINDEX` blocks writes.
18. Superuser-only introspection: no supported non-superuser SQL function reports an index's header state in v1.5.1 (`bm25_dump_index` needs superuser).
19. `bm25_force_merge`, `bm25_spill_index` and friends are classed "Development Functions": "These interfaces may change without notice."
20. Background compaction depends on `pg_durable` (Microsoft) and is documented as beta in release notes (v1.5.0); `pg_durable` must be installed in the same database as the index.
21. Compaction published passes are not undone by ROLLBACK (README@1.5.1).
22. Index must be created after data load for best build time; REINDEX or `bm25_force_merge` after heavy bulk loading (Tiger Cloud docs / hybrid tutorial advice: "Run it after large bulk loads, not after every insert").
23. Tiger Cloud docs state no support for Hypercore-compressed hypertable chunk data. That statement comes from a docs page labeled v1.1.0; not verified for later versions.
24. Third-party/older pages contain stale statements. Tiger Data's Oct 2025 preview blog shows `USING pg_textsearch(content)`, which is wrong: the access method is `bm25`. It also describes a 64MB per-index in-memory limit that is no longer how the extension works.

## Comparison

### Versus core tsvector / ts_rank (our `postgres/references/20-text-search.md`)

Our reference's mental model: `tsvector` is normalized lexemes; `tsquery` is a query language; GIN is the default index; "ranking is opt-in and costs an extra heap fetch per row ... Plan ranking against a LIMIT" (header of postgres/references/20-text-search.md, rule 4). pg_textsearch targets exactly that ranking gap.

| Point | core FTS (`tsvector`, GIN, `ts_rank`) | pg_textsearch | Source |
|---|---|---|---|
| Ranking function | `ts_rank` / `ts_rank_cd`; no IDF, no term-frequency saturation, no corpus-average length normalization | BM25 (IDF, tf saturation via k1, length norm via b) | 1.0 blog; preview blog |
| Top-k | GIN finds matches; ranking requires consulting every matching row's tsvector; no top-k path | Block-Max WAND top-k inside the index; `ORDER BY ... LIMIT` | 1.0 blog; our 20-text-search.md rule 4 |
| Match semantics | `@@` boolean AND by default; a doc missing one query term is excluded before ranking | `<@>` scores docs matching ANY term (OR); Boolean/phrase via `@@ tsquery` since v1.5.0 | preview blog; tutorial; README@1.5.1 |
| Storage | separate `tsvector` column or expression index; positions stored | index stores no positions; one text column or expression, `text_config` as index option | 1.0 blog; README@1.5.1 |
| Weights A/B/C/D, `ts_headline`, `ts_rank_cd` proximity | yes | no per-field weights in `<@>` (`@@` accepts weight restrictions); `ts_headline` still usable on results | README@1.5.1; tutorial |
| Languages | any text search config | same configs via `text_config`; one index per language (partial indexes); Chinese via zhparser config | README@1.5.1 |
| PG versions | all | 17 and 18 | README@1.5.1 |
| Install | built in | extension + `shared_preload_libraries` + restart | README@1.5.1 |

Tokenization is the same machinery (`to_tsvector` with a text search configuration), so config choices from 20-text-search.md (dictionaries, stopwords, stemming) carry over.

### Versus other BM25 extensions (facts from cited sources only)

| | pg_textsearch | ParadeDB pg_search | VectorChord-bm25 |
|---|---|---|---|
| Repo | https://github.com/timescale/pg_textsearch | https://github.com/paradedb/paradedb | https://github.com/supervc-stack/VectorChord-bm25 (GitHub redirect from tensorchord/VectorChord-bm25) |
| License | PostgreSQL License | AGPL-3.0 (Community); commercial Enterprise edition | dual: AGPLv3 or Elastic License v2 |
| Latest release seen | v1.5.1 (2026-10-02) | v0.26.6 (2026-11-08); v0.27.0-rc.0 2026-11-11 | 0.3.0 (2025-12-15) |
| Engine | built from scratch in C on Postgres pages; no external storage | Tantivy (Rust) | Block-WeakAnd in C/Rust inside Postgres; needs separate `pg_tokenizer.rs` extension for tokenization |
| Index | `CREATE INDEX ... USING bm25 (text_col) WITH (text_config=..)` on text | custom ParadeDB index; own operators (`|||`, `pdb.score()`) | index on a `bm25vector` column (`bm25_ops`); `tokenize()` result stored in the column; operator `<&>`, `bm25query(index, tokenized_query)` |
| Query syntax | `ORDER BY col <@> 'terms' LIMIT k` | `WHERE body ||| 'terms' ORDER BY pdb.score(id) DESC` | `embedding <&> bm25query('idx', tokenize('q','bert'))` |
| Phrase / highlighting / facets | phrase via `@@` (v1.5.0, rechecked on heap); no highlighting or facets | highlighting, facets, aggregations, many tokenizers, vector search in same index (README) | not stated in the README sections read |
| Postgres versions | 17, 18 (19 best effort) | 15 and later (Neon FAQ) | not stated in sections read |
| Needs preload | yes | yes (per Neon FAQ) | not checked |

Sources: pg_textsearch README@1.5.1; ParadeDB README https://github.com/paradedb/paradedb ; VectorChord-bm25 README and LICENSE https://github.com/supervc-stack/VectorChord-bm25 ; Neon FAQ comparison table https://neon.com/faqs/pg-search-vs-pg-textsearch-vs-lakebase-search-bm25 (dated 2026-11-13; vendor details "verified on 2026-11-13 against the linked pages" by Neon).

Vendor benchmark claims (treat as vendor-published, warm cache, one dataset): 1.0 blog compares pg_textsearch against ParadeDB v0.21.6 on MS-MARCO v2 (138M passages), c6i.4xlarge, PG 17.4. Single-client p50 top-10: 5.11 ms vs 59.83 ms for 1 lexeme; 9.14 vs 59.65 for 2; 20.04 vs 77.62 for 3; converges at 7+ lexemes (159 vs 170 ms; 178 vs 190 ms at 8+). Index 17 GB vs 23 GB. Build 17 min 37 s vs 8 min 55 s (ParadeDB about 2x faster to build). 16-client pgbench: 198.7 vs 22.8 TPS. The post states: "We have not performed a systematic ranking equivalence comparison ... differences in IDF computation and tokenization edge cases may produce different orderings." The index size comparison is "not apples-to-apples" because pg_textsearch stores no positions. https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres

## Recipes found upstream

All SQL below is copied verbatim from the cited page. Where the source is a docs page at an older version, the note says so.

### 1. Install and first index (README@1.5.1)

Source: https://github.com/timescale/pg_textsearch/blob/v1.5.1/README.md

```
shared_preload_libraries = 'pg_textsearch'  # add to existing list if needed
```

```sql
CREATE EXTENSION pg_textsearch;
```

```sql
CREATE TABLE documents (
    id bigserial PRIMARY KEY,
    content text,
    category_id integer
);
INSERT INTO documents (content, category_id) VALUES
    ('PostgreSQL is a powerful database system', 1),
    ('BM25 is an effective ranking function', 1),
    ('Full text search with custom scoring', 2);
```

```sql
CREATE INDEX docs_idx ON documents USING bm25(content) WITH (text_config='english');
```

### 2. Top-k ranked query; explicit index; verify plan (README@1.5.1)

```sql
SELECT * FROM documents
ORDER BY content <@> 'database system'
LIMIT 5;
```

```sql
SELECT * FROM documents
ORDER BY content <@> to_bm25query('database system', 'docs_idx')
LIMIT 5;
```

```sql
EXPLAIN SELECT * FROM documents
ORDER BY content <@> 'database system'
LIMIT 5;
```

```sql
SET enable_seqscan = off;
```

### 3. Boolean filtering (README@1.5.1)

```sql
SELECT * FROM documents
WHERE content @@ to_tsquery('english', 'postgres & (search | database) & !mysql');
```

```sql
SET default_text_search_config = 'english';
```

### 4. Pre-filter and post-filter (README@1.5.1)

```sql
CREATE INDEX ON documents (category_id);

SELECT * FROM documents
WHERE category_id = 1
ORDER BY content <@> 'search terms'
LIMIT 10;
```

```sql
SELECT * FROM documents
WHERE length(content) > 100
ORDER BY content <@> 'search terms'
LIMIT 10;
```

### 5. Index options, expression, partial, array indexes (README@1.5.1; array recipe from release v1.1.0)

```sql
CREATE INDEX ON documents USING bm25(content) WITH (text_config='english', k1=1.5, b=0.8);
```

```sql
-- JSONB field extraction
CREATE INDEX events_expr_idx ON events USING bm25 ((data->>'description'))
    WITH (text_config='english');

SELECT * FROM events
ORDER BY (data->>'description') <@> to_bm25query('network error', 'events_expr_idx')
LIMIT 10;

-- Text transformation
CREATE INDEX ON documents USING bm25 ((lower(content)))
    WITH (text_config='simple');

-- Multi-column search
CREATE INDEX ON articles USING bm25 ((coalesce(title, '') || ' ' || coalesce(body, '')))
    WITH (text_config='english');

-- Array expression
CREATE INDEX ON articles USING bm25 ((ARRAY[title, body]))
    WITH (text_config='english');
```

```sql
CREATE INDEX documents_category_bm25_idx ON documents USING bm25 (content)
    WITH (text_config='english')
    WHERE category_id = 1;

SELECT * FROM documents
WHERE category_id = 1
ORDER BY content <@> to_bm25query('search terms', 'documents_category_bm25_idx')
LIMIT 10;
```

Array column (release notes v1.1.0, https://github.com/timescale/pg_textsearch/releases/tag/v1.1.0):

```sql
CREATE TABLE posts (id serial, tags text[]);
CREATE INDEX ON posts USING bm25 (tags) WITH (text_config='english');
SELECT * FROM posts ORDER BY tags <@> 'database' LIMIT 10;
```

### 6. Multilingual tables, one partial index per language (README@1.5.1)

```sql
ALTER TABLE documents ADD COLUMN lang CHAR(2) NOT NULL DEFAULT 'en';

CREATE INDEX docs_en_idx ON documents USING bm25 (content)
    WITH (text_config='english') WHERE lang = 'en';
CREATE INDEX docs_de_idx ON documents USING bm25 (content)
    WITH (text_config='german')  WHERE lang = 'de';
CREATE INDEX docs_fr_idx ON documents USING bm25 (content)
    WITH (text_config='french')  WHERE lang = 'fr';
```

```sql
SELECT * FROM documents
WHERE lang = 'en'
ORDER BY content <@> to_bm25query('databases', 'docs_en_idx')
LIMIT 10;
```

### 7. Chinese full-text search via zhparser (README@1.5.1)

```sql
CREATE EXTENSION zhparser;

CREATE TEXT SEARCH CONFIGURATION public.chinese (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION public.chinese
    ADD MAPPING FOR n, v, a, i, e, l WITH simple;

CREATE TABLE chinese_documents (id bigserial PRIMARY KEY, content text);
INSERT INTO chinese_documents (content) VALUES ('机器学习');

CREATE INDEX chinese_documents_bm25 ON chinese_documents USING bm25 (content)
    WITH (text_config='public.chinese');

SELECT id FROM chinese_documents
ORDER BY content <@> to_bm25query('机器学习', 'chinese_documents_bm25')
LIMIT 10;
```

### 8. Explicit bm25query forms (README@1.5.1)

```sql
SELECT to_bm25query('search query text', 'docs_idx');

SELECT 'docs_idx:search query text'::bm25query;
```

### 9. Parallel build, compaction, background compaction, monitoring (README@1.5.1)

```sql
SET max_parallel_maintenance_workers = 4;
SET maintenance_work_mem = '256MB';
```

```sql
SET pg_textsearch.compress_segments = off;
```

```sql
REINDEX INDEX docs_idx;
```

```sql
SELECT bm25_force_merge('docs_idx');
SELECT bm25_compact('docs_idx'::regclass);
SELECT bm25_compact_step('docs_idx'::regclass);
```

```sql
SELECT bm25_needs_compaction('docs_idx'::regclass);
SELECT bm25_level_counts('docs_idx'::regclass);
```

```sql
-- Manual spill
SELECT bm25_spill_index('docs_idx');
```

```sql
CREATE INDEX documents_bm25 ON documents USING bm25(content)
WITH (
    text_config = 'english',
    compaction = 'background'
);
```

```sql
ALTER INDEX documents_bm25 SET (compaction = 'background');
ALTER INDEX documents_bm25 RESET (compaction_schedule);
ALTER INDEX documents_bm25 SET (compaction = 'manual');
```

```sql
-- Check index usage
SELECT s.schemaname, s.relname AS tablename,
       s.indexrelname AS indexname,
       s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
FROM pg_stat_user_indexes AS s
JOIN pg_class AS i ON i.oid = s.indexrelid
JOIN pg_am AS am ON am.oid = i.relam
WHERE am.amname = 'bm25';
```

```sql
SELECT cfgname FROM pg_ts_config;
```

```sql
SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%USING bm25%';
```

Version check (UPGR, https://github.com/timescale/pg_textsearch/blob/main/UPGRADING.md):

```sql
SELECT
    current_setting('pg_textsearch.library_version', true) AS loaded_version,
    (SELECT extversion FROM pg_extension
     WHERE extname = 'pg_textsearch') AS installed_version;
```

```sql
ALTER EXTENSION pg_textsearch UPDATE TO 'TARGET_VERSION';
```

### 10. Hybrid search: BM25 + pgvector with Reciprocal Rank Fusion

Upstream (the repo README) does NOT document a hybrid or RRF recipe. The recipes are in Tiger Data docs and blog posts (the docs pages use `pgvectorscale` but the SQL pattern is plain pgvector ops; the preview blog uses pgvector HNSW).

(a) Tiger Data hybrid-search tutorial (extension shown as 1.0.0 in its output; BM25 side uses implicit syntax, vector side uses pgvectorscale DiskANN but `<=>` and `ROW_NUMBER` are pgvector-compatible). Source: https://www.tigerdata.com/docs/learn/tutorials/hybrid-search

```sql
CREATE INDEX episodes_bm25_idx ON episodes
     USING bm25(description) WITH (text_config = 'english');
```

```sql
-- Get the top 20 BM25 keyword matches
WITH bm25_results AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY description <@> 'mental health boundaries'
  ) AS rank
  FROM episodes
  ORDER BY description <@> 'mental health boundaries'
  LIMIT 20
),
-- Get the top 20 vector similarity matches
vector_results AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY embedding <=> $1  -- $1 is the query embedding vector
  ) AS rank
  FROM episodes
  ORDER BY embedding <=> $1
  LIMIT 20
)
-- Fuse the two ranked lists using RRF
SELECT
  d.id,
  d.title,
  COALESCE(1.0 / (60 + b.rank), 0)
    + COALESCE(1.0 / (60 + v.rank), 0) AS rrf_score
FROM episodes d
LEFT JOIN bm25_results b ON d.id = b.id
LEFT JOIN vector_results v ON d.id = v.id
WHERE b.id IS NOT NULL OR v.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT 10;
```

(b) Preview blog, pgvector HNSW variant with explicit index name and weighted fusion. Source: https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres . Caution: this post's DDL uses `USING pg_textsearch(content)`, which is incorrect; use `USING bm25(content)`. The query body is valid:

```sql
-- Hybrid search combining vector and keyword results
-- Note: Replace $1 with your actual query embedding from your embedding model
WITH vector_search AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
    FROM documents
    ORDER BY embedding <=> $1::vector
    LIMIT 20
),
keyword_search AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY content <@> to_bm25query('query performance', 'documents_content_idx')) AS rank
    FROM documents
    ORDER BY content <@> to_bm25query('query performance', 'documents_content_idx')
    LIMIT 20
)
SELECT
    d.id,
    d.title,
    COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + k.rank), 0.0) AS combined_score
FROM documents d
LEFT JOIN vector_search v ON d.id = v.id
LEFT JOIN keyword_search k ON d.id = k.id
WHERE v.id IS NOT NULL OR k.id IS NOT NULL
ORDER BY combined_score DESC
LIMIT 10;
```

Weighted variant (same post; "adjust the weights in the final SELECT" with the same CTEs):

```sql
SELECT
    d.id,
    d.title,
    0.7 * COALESCE(1.0 / (60 + v.rank), 0.0) +  -- 70% weight to vectors
    0.3 * COALESCE(1.0 / (60 + k.rank), 0.0)    -- 30% weight to keywords
    AS combined_score
FROM documents d
LEFT JOIN vector_search v ON d.id = v.id
LEFT JOIN keyword_search k ON d.id = k.id
WHERE v.id IS NOT NULL OR k.id IS NOT NULL
ORDER BY combined_score DESC
LIMIT 10;
```

Framing from the sources: RRF scores `1 / (k + rank)` with k=60, "parameter-free" rank merging, chosen because BM25 and cosine distance are on different scales (hybrid tutorial: "Instead of trying to compare raw scores across different systems (which use different scales), Reciprocal Rank Fusion only looks at rank position"). The preview blog also lists alternatives (linear score combination, learning-to-rank, cross-encoder reranking, cascade) and says handling fusion in application code "is equally valid".

### 11. Other upstream workarounds (hybrid tutorial; Tiger Data docs)

Phrase over-fetch + post-filter (hybrid tutorial; still valid for `<@>` ranking, but `@@` phrase queries exist since v1.5.0):

```sql
SELECT * FROM (

  SELECT * FROM episodes

  ORDER BY description <@> 'year end planning'

  LIMIT 100  -- over-fetch to compensate for the post-filter

) sub

WHERE description ILIKE '%end-of-year%'

LIMIT 10;
```

Highlighting with core `ts_headline` (hybrid tutorial):

```sql
SELECT title,

  ts_headline('english', description, to_tsquery('english', 'productivity')),

  description <@> 'productivity' AS score

FROM episodes

ORDER BY description <@> 'productivity'

LIMIT 10;
```

Multi-column via generated column (hybrid tutorial):

```sql
ALTER TABLE episodes ADD COLUMN search_text text

  GENERATED ALWAYS AS (title || ' ' || description) STORED;

CREATE INDEX ON episodes USING bm25(search_text)

  WITH (text_config = 'english');
```

Score-threshold filter (Tiger Cloud docs, v1.1.0-era page: https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/tiger-cloud-extensions/pg-textsearch):

```sql
SELECT name, description <@> to_bm25query('wireless', 'products_search_idx') AS score

FROM products

WHERE description <@> to_bm25query('wireless', 'products_search_idx') < -0.5;
```

## Version history

Dates are GitHub release `publishedAt` (UTC). Highlights are from the README Version History table and release notes (https://github.com/timescale/pg_textsearch/releases ; README@1.5.1).

| Version | Date | Highlights |
|---|---|---|
| v0.0.1 | 2025-10-14 | Initial release |
| v0.0.2 | 2025-10-18 | Schema insertion fixes, inheritance safety check |
| v0.0.3 | 2025-11-07 | PostgreSQL 18 support (pre-release) |
| v0.0.4 | 2025-11-20 | BM25 indexing, PG 17/18, crash recovery, memory budgets (pre-release) |
| v0.0.5 | 2025-12-04 | pre-release |
| v0.1.0 | 2025-12-13 | First open-source release, simpler query syntax, partitioned tables |
| v0.2.0 | 2026-01-01 | Public benchmarks, block-based segment storage, dynamic index registry |
| v0.3.0 | 2026-01-09 | Block-Max WAND, bounded memtable growth |
| v0.4.0 | 2026-01-13 | Compressed posting lists, ordered-scan planner support, partitioned-table fixes |
| v0.4.1 / v0.4.2 | 2026-01-23 / 2026-01-25 | Hypertable scan locking and scoring fixes |
| v0.5.0 | 2026-02-02 | Parallel index builds, improved hypertable support |
| v0.5.1 | 2026-02-12 | Concurrent index builds, iterative scans, progress reporting, scan statistics |
| v0.6.0 | 2026-03-03 | Large-scale performance, lower memory, REQUIRED shared preloading |
| v0.6.1 | 2026-03-12 | Transaction-abort, VACUUM, large-posting, BMW stability |
| v1.0.0 | 2026-03-27 | First GA release. Announcement blog dated 2026-03-31; PostgreSQL.org news post 2026-04-03 |
| v1.1.0 | 2026-04-22 | Concurrent writes, alive-bitset VACUUM, memory controls, `text[]` columns, expression indexes, partial indexes, schema-qualified (`@extschema@`) objects |
| v1.2.0 | 2026-05-12 | Physical replication support, update-heavy workload correctness |
| v1.3.0 | 2026-05-29 | On-disk (paged) memtable + shared-memory read cache, stateless WAL replay; header version 7 |
| v1.3.1 | 2026-06-23 | Standby-safe page reclaim, concurrency, VACUUM, parallel-build fixes; header version 8 |
| v1.4.0 | 2026-08-18 | Faster filtered top-k (selectivity-seeded K, up to 5x), Chinese search via zhparser, large-corpus robustness |
| v1.5.0 | 2026-10-01 | Boolean queries via `@@ tsquery` (incl. phrase, prefix, weight, NOT), beta background compaction via pg_durable, PG 19 beta support, Windows support, RLS controls, faster/lower-memory builds; header version 9; empty/stopword-only docs now indexed (affects Boolean NOT queries) |
| v1.5.1 | 2026-10-02 | Fixes: concurrent spill/force-merge truncation corruption (#540), expression-index insertion and array/domain handling (#542), maintenance when extension preloaded but not installed (#543). No index format change. |
| main (1.6.0-dev) | unreleased | Post-1.5.1 commits through 2026-11-10, e.g. "Quantize memtable document lengths in BM25 index scans (#575)", security hardening (#558). |

## Sources

- https://github.com/timescale/pg_textsearch (repo, GitHub API metadata: license PostgreSQL, 4065 stars, not archived, last push 2026-11-14)
- https://github.com/timescale/pg_textsearch/blob/v1.5.1/README.md (and `main`; diffed)
- https://github.com/timescale/pg_textsearch/blob/v1.5.1/sql/pg_textsearch--1.5.1.sql
- https://github.com/timescale/pg_textsearch/blob/main/sql/pg_textsearch--1.6.0-dev.sql
- https://github.com/timescale/pg_textsearch/blob/main/pg_textsearch.control (and v1.5.1 tag)
- https://github.com/timescale/pg_textsearch/blob/main/ARCHITECTURE.md
- https://github.com/timescale/pg_textsearch/blob/main/UPGRADING.md
- https://github.com/timescale/pg_textsearch/blob/main/src/mod.c (GUCs, reloptions; v1.5.1 copy compared)
- https://github.com/timescale/pg_textsearch/blob/main/src/access/handler.c
- https://github.com/timescale/pg_textsearch/blob/main/src/access/build.c
- https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bm25.c
- https://github.com/timescale/pg_textsearch/blob/main/src/scoring/bmw.c
- https://github.com/timescale/pg_textsearch/blob/main/src/constants.h
- https://github.com/timescale/pg_textsearch/releases (release notes v1.5.1, v1.5.0, v1.4.0, v1.3.1, v1.3.0, v1.2.0, v1.1.0, v1.0.0 read via `gh release view`)
- https://github.com/timescale/pg_textsearch/blob/main/.github/workflows/ci.yml (PG 17, 18 matrix)
- https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres (preview announcement, published 2025-10-23)
- https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres (1.0 GA design and benchmark post, 2026-03-31)
- https://www.postgresql.org/about/news/pg_textsearch-v10-3264 (PostgreSQL.org GA news item; surfaced in search results only, body not read)
- https://www.tigerdata.com/docs/learn/tutorials/hybrid-search (hybrid RRF tutorial)
- https://www.tigerdata.com/docs/learn/search/using-pg-textsearch (concept page, says v1.1.0)
- https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/tiger-cloud-extensions/pg-textsearch (deploy guide, labeled v1.1.0, stale in places)
- https://neon.com/faqs/pg-search-vs-pg-textsearch-vs-lakebase-search-bm25 (third-party comparison, 2026-11-13)
- https://github.com/paradedb/paradedb (README; GitHub API: AGPL-3.0, releases v0.26.6 / v0.27.0-rc.0)
- https://github.com/supervc-stack/VectorChord-bm25 (README, LICENSE; GitHub API: releases, 0.3.0 latest)
- https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/ (PG 19 RC1, GA planned 2026-11-19)
- https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442/ (surfaced in search; RC2 date not read in full)

## Managed-service availability (categorical, no vendor names for the page)

- The extension requires `shared_preload_libraries`, so it can only run where the operator controls preloaded libraries. The 1.0 blog says on the maintainer's own managed service this "is handled automatically".
- One managed service by the maintainer ships it preinstalled (docs say "production-ready", but those pages are labeled v1.1.0 and lag the repo).
- The only comparison source found (Neon FAQ, 2026-11-13) states pg_textsearch is available on that maintainer's managed cloud "or self-managed Postgres 17 and 18" and not on the other managed service the FAQ covers, which offers its own BM25 extension on `tsvector` columns instead (`lakebase_text`, PG 16+, not pg_textsearch).
- A Microsoft Q&A thread (search snippet only, not read in full, about 9 months old) says the Azure team is "evaluating" it; no roadmap commitment.
- v1.3.0 release notes say the architecture was changed for compatibility with disaggregated-storage Postgres variants (named: Aurora, AlloyDB, Neon, HorizonDB). That is design compatibility, not availability.
- I did NOT check official extension lists for the large hyperscaler managed Postgres services or for Supabase. Do not claim availability or non-availability there.
- Install paths summary for the page: managed (maintainer's cloud, preinstalled), self-hosted (binary from Releases or source build + preload + restart), and the `timescaledb-ha` Docker image (preinstalled, preload configured).

## Not verified

- Whether `<@>` ranking at v1.5.1 still treats unquoted multi-term queries as implicit OR. Only the 1.0 blog and the 1.0-era tutorial say so; README@1.5.1 does not restate it. Not confirmed in v1.5.1 source (only scoring code read, not query parsing). Test before asserting for 1.5.1.
- Whether `<@>` index scans return only rows that match at least one query term (vs. all rows). The Tiger Cloud docs example (v1.1.0-era) shows non-matching rows scoring `0` in a non-LIMIT-pushed standalone scan. Index-scan behavior not directly confirmed.
- Whether a partial-index corpus (N, df, avgdl) covers only the predicate rows. Inferred from the design (one index = one corpus), not stated verbatim.
- Whether dead-but-not-yet-vacuumed rows affect IDF/avgdl. ARCH says statistics are "physical index statistics, not MVCC-filtered" and VACUUM does "corpus-statistic adjustment", which implies stats lag until VACUUM; this inference is not stated explicitly.
- Whether `CREATE INDEX CONCURRENTLY` works at v1.5.1 (README Version History for v0.5.1 says "Concurrent index builds"; ARCH mentions `REINDEX INDEX CONCURRENTLY`; no explicit CIC recipe or caveats read).
- Hypercore/compressed-chunk non-support: from a v1.1.0-labeled docs page; not re-verified.
- Whether the PostgreSQL.org GA news item (https://www.postgresql.org/about/news/pg_textsearch-v10-3264) says anything beyond the Tiger Data blog; only its snippet was seen.
- Windows and macOS binary availability: README says pre-built packages for Linux amd64/arm64 only; the 1.0 blog says "Linux and macOS (amd64, arm64)"; v1.5.1 release assets contain only Linux-named zips/tarballs as far as the filenames show. Not tested.
- VectorChord-bm25: supported PG versions, preload requirement, phrase/highlight support not read (README sections after line 120 only grepped). ParadeDB PG-version "15 and later" and preload requirement are from the Neon FAQ, not ParadeDB's own docs.
- `bm25_memory_usage()`: absent from the 1.5.1 SQL script (confirmed) but I did not find the commit that removed it.
- Exact `pg_durable` maturity (the README calls the dependency out; release notes call background compaction "beta"); not researched further.
- PG 19 final GA: as of 2026-11-14 only RC releases exist (RC1 2026-10-15 official; RC2 date 2026-11-12 from a PostgreSQL.org title and search snippet). GA planned 2026-11-19 per the official RC1 post. Whether pg_textsearch gets prebuilt PG 19 binaries after GA is unknown.
- No SQL or index behavior was run against a live database in this research; everything is from source files, release notes and docs.

# pg_trgm — Trigram Similarity + Fuzzy Match

`pg_trgm` extension. Trigram-based string similarity. Accelerates `LIKE '%foo%'` + `ILIKE` + regex (`~`, `~*`) + similarity queries via GIN or GiST indexes. Three similarity flavors: full-string `similarity()`, sliding-window `word_similarity()`, word-boundary `strict_word_similarity()`.

## Table of Contents

- [When to Use](#when-to-use)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Trigram Extraction Rules](#trigram-extraction-rules)
    - [Function Catalog](#function-catalog)
    - [Operator Catalog](#operator-catalog)
    - [Similarity Thresholds (GUCs)](#similarity-thresholds-gucs)
    - [GIN Index — gin_trgm_ops](#gin-index--gin_trgm_ops)
    - [GiST Index — gist_trgm_ops](#gist-index--gist_trgm_ops)
    - [GIN vs GiST Decision](#gin-vs-gist-decision)
    - [LIKE / ILIKE / Regex Acceleration](#like--ilike--regex-acceleration)
    - [Equality Acceleration PG14+](#equality-acceleration-pg14)
    - [Collation-Provider Change PG18+](#collation-provider-change-pg18)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use

User typing partial names, fuzzy-matching free-text columns, autocomplete with typo tolerance, `LIKE '%foo%'` patterns that B-tree cannot index, regex search, deduplication by approximate match. Substring/regex/similarity all share the same trigram index — single index covers multiple query shapes.

Not for: anchored prefix `LIKE 'foo%'` under C-locale (use B-tree), full-text search across long documents (use `tsvector` — see [`20-text-search.md`](./20-text-search.md)), semantic similarity (use [`94-pgvector.md`](./94-pgvector.md)), case-insensitive equality (use [`citext`](./14-data-types-builtin.md) or expression index on `lower(col)`).

## Mental Model

Five rules:

1. **Trigrams = 3-char windows over normalized string.** Lowercased, alphanumeric-only, two leading spaces + one trailing space added per word. `'cat'` → `{' c', ' ca', 'cat', 'at '}`. `'foo|bar'` → `{' f', ' fo', 'foo', 'oo ', ' b', ' ba', 'bar', 'ar '}`. Pipe is non-word, splits into two words.

2. **Three similarity functions, three operators, three thresholds.** `similarity()` (full-string, default `%` threshold 0.3) / `word_similarity()` (sliding-window any-boundary, `<%` threshold 0.6) / `strict_word_similarity()` (word-boundary only, `<<%` threshold 0.5). Each pairs with distance operator `<->` / `<<->` / `<<<->` for KNN ORDER BY.

3. **GIN = faster reads, slower writes, larger index.** GiST = faster writes, smaller index, lossy (recheck heap), supports KNN `ORDER BY col <-> 'query'`. GIN does NOT support KNN distance ordering — only operator predicates.

4. **PG14+ allows equality lookups via trigram index.** Before PG14, `WHERE col = 'foo'` could not use a trigram index. PG14 added equality support (Julien Rouhaud) — but B-tree still faster for pure equality unless you want one index serving both substring and equality.

5. **PG18+ collation-provider change can invalidate trigram indexes.** FTS + pg_trgm now use default collation provider (Peter Eisentraut). Clusters defaulting to non-libc providers (ICU, builtin) may behave differently for `LC_CTYPE` characters. After pg_upgrade, reindex FTS + pg_trgm indexes.

> [!WARNING] pg_trgm is NOT FTS
> Trigrams treat strings as character sequences. No stemming, no stop words, no language awareness, no phrase search. For document search (English/Spanish/etc. with morphology), use `tsvector` — see [`20-text-search.md`](./20-text-search.md). pg_trgm shines for identifiers, names, codes, short fields where character-level fuzzy match beats linguistic processing.

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Substring match `LIKE '%foo%'` on column | GIN + `gin_trgm_ops` | Default. Substring patterns benefit most from inverted index. |
| Anchored prefix `LIKE 'foo%'`, C-locale or `text_pattern_ops` | B-tree on `text_pattern_ops` | Trigram works but B-tree faster for pure prefix. See [`23-btree-indexes.md`](./23-btree-indexes.md). |
| Substring + similarity ranking | GIN + `gin_trgm_ops` | Substring filter + `similarity()` in `ORDER BY`. |
| KNN nearest-neighbor `ORDER BY col <-> 'query' LIMIT 10` | GiST + `gist_trgm_ops` | GIN does NOT support KNN. GiST does. |
| Autocomplete typo-tolerant | GiST + `gist_trgm_ops` + `<%` operator | Word-similarity operator + GiST KNN ordering. |
| High write volume, occasional fuzzy query | GiST + `gist_trgm_ops` | GIN write amplification high. GiST cheaper inserts. |
| Read-heavy, infrequent writes | GIN + `gin_trgm_ops` | GIN reads ~10× faster than GiST for trigram. |
| Tune siglen for precision vs index size | `gist_trgm_ops(siglen=N)` | Larger siglen → more precise → larger index. Default 12, range 1-2024. |
| Equality `WHERE col = 'foo'` accelerated by trigram | PG14+ GIN/GiST + `gin_trgm_ops`/`gist_trgm_ops` | One index for substring + similarity + equality. B-tree still faster for pure equality. |
| Multi-word free-text | tsvector + GIN | pg_trgm doesn't understand words/sentences. See [`20-text-search.md`](./20-text-search.md). |
| Approximate dedup across million-row table | GIN + `gin_trgm_ops` + `%` operator | Tune `pg_trgm.similarity_threshold` per session. |
| Semantic similarity (embeddings) | pgvector | pg_trgm is character-level. See [`94-pgvector.md`](./94-pgvector.md). |

Three smell signals:

- **`pg_trgm` GIN on column queried only with `=`** → use B-tree, smaller + faster.
- **`pg_trgm` GiST on column queried only with `LIKE '%x%'`** → use GIN, ~10× faster reads.
- **`similarity()` in `WHERE` without supporting GIN/GiST** → sequential scan, every row de-trigrammed at query time. Add index OR change to `col % 'query'` so operator threshold can use index.

## Mechanics

### Trigram Extraction Rules

Verbatim from [pgtrgm.html][pgtrgm-16]:

> A trigram is a group of three consecutive characters taken from a string.

> `pg_trgm` ignores non-word characters (non-alphanumerics) when extracting trigrams from a string. Each word is considered to have two spaces prefixed and one space suffixed when determining the set of trigrams contained in the string. For example, the set of trigrams in the string 'cat' is ` c`, ` ca`, `cat`, and `at `. The set of trigrams in the string 'foo|bar' is ` f`, ` fo`, `foo`, `oo `, ` b`, ` ba`, `bar`, and `ar `.

Inspect with `show_trgm()`:

    SELECT show_trgm('Hello World!');
    --        show_trgm
    -- ------------------------
    --  {"  h"," he","ell","hel","llo","lo ","  w","wo ","wor","orl","rld"}
    --
    -- Lowercased. Non-word (!) split. Per-word ' '+' ' prefix and ' ' suffix.

Three operational consequences:

- **Case-insensitive by construction.** Trigram extraction lowercases. Index does NOT discriminate `Foo` from `foo`.
- **Punctuation = word boundary.** `'foo-bar'` and `'foo bar'` produce identical trigram sets. Hyphens, underscores, dots all split.
- **Trigrams under length 3 collapse oddly.** `'a'` → `{' a', '  a', 'a '}` — three trigrams from one letter. Short strings have low information content; similarity scores noisy.

### Function Catalog

Verbatim from [pgtrgm.html][pgtrgm-16]:

| Function | Returns | Description |
|---|---|---|
| `similarity(text, text)` | `real` | "Returns a number that indicates how similar the two arguments are. The range of the result is zero (indicating that the two strings are completely dissimilar) to one (indicating that the two strings are identical)." |
| `show_trgm(text)` | `text[]` | "Returns an array of all the trigrams in the given string. (In practice this is seldom useful except for debugging.)" |
| `word_similarity(text, text)` | `real` | "Returns a number that indicates the greatest similarity between the set of trigrams in the first string and any continuous extent of an ordered set of trigrams in the second string." |
| `strict_word_similarity(text, text)` | `real` | "Same as `word_similarity`, but forces extent boundaries to match word boundaries. Since we don't have cross-word trigrams, this function actually returns greatest similarity between first string and any continuous extent of words of the second string." |
| `show_limit()` | `real` | "Returns the current similarity threshold used by the `%` operator." — **deprecated**, use `SHOW pg_trgm.similarity_threshold`. |
| `set_limit(real)` | `real` | "Sets the current similarity threshold that is used by the `%` operator. The threshold must be between 0 and 1 (default is 0.3). Returns the same value passed in." — **deprecated**, use `SET pg_trgm.similarity_threshold`. |

`word_similarity` vs `strict_word_similarity` distinction:

    SELECT word_similarity('database', 'I love postgres databases'),
           strict_word_similarity('database', 'I love postgres databases');
    --  word_similarity | strict_word_similarity
    -- -----------------|------------------------
    --        0.875     |         0.875
    --
    --  word_similarity matches 'databases' anywhere in extent
    --  strict_word_similarity requires extent boundary at word edge
    --
    -- Difference shows on partial-word match:
    SELECT word_similarity('post', 'postgres'),
           strict_word_similarity('post', 'postgres');
    --  word_similarity | strict_word_similarity
    -- -----------------|------------------------
    --        0.6       |         0.3
    --                  -- strict scores lower because 'post' is not whole word in 'postgres'

### Operator Catalog

Verbatim from [pgtrgm.html][pgtrgm-16]:

| Operator | Type | Returns | Description |
|---|---|---|---|
| `text % text` | predicate | `boolean` | "Returns `true` if its arguments have a similarity that is greater than the current similarity threshold set by `pg_trgm.similarity_threshold`." |
| `text <% text` | predicate | `boolean` | "Returns `true` if the similarity between the trigram set in the first argument and a continuous extent of an ordered trigram set in the second argument is greater than the current word similarity threshold set by `pg_trgm.word_similarity_threshold` parameter." |
| `text %> text` | predicate | `boolean` | "Commutator of the `<%` operator." |
| `text <<% text` | predicate | `boolean` | "Returns `true` if its second argument has a continuous extent of an ordered trigram set that matches word boundaries, and its similarity to the trigram set of the first argument is greater than the current strict word similarity threshold set by the `pg_trgm.strict_word_similarity_threshold` parameter." |
| `text %>> text` | predicate | `boolean` | "Commutator of the `<<%` operator." |
| `text <-> text` | distance | `real` | "Returns the 'distance' between the arguments, that is one minus the `similarity()` value." |
| `text <<-> text` | distance | `real` | "Returns the 'distance' between the arguments, that is one minus the `word_similarity()` value." |
| `text <->> text` | distance | `real` | "Commutator of the `<<->` operator." |
| `text <<<-> text` | distance | `real` | "Returns the 'distance' between the arguments, that is one minus the `strict_word_similarity()` value." |
| `text <->>> text` | distance | `real` | "Commutator of the `<<<->` operator." |

Argument-order rule for asymmetric operators (`<%`, `<<%`, `<<->`, `<<<->`):

- `'query' <% 'haystack'` — does `'query'` similarity-match a contiguous extent inside `'haystack'`?
- `'haystack' %> 'query'` — same thing, commutator. Pick the form that matches your index expression.

The distance operators `<->` / `<<->` / `<<<->` are how you do KNN ranking with GiST. Always pair with `ORDER BY col <-> 'q' LIMIT N` — never `WHERE` on distance alone (no index without LIMIT).

### Similarity Thresholds (GUCs)

| GUC | Default | Operator | Set with |
|---|---|---|---|
| `pg_trgm.similarity_threshold` | 0.3 | `%` | `SET pg_trgm.similarity_threshold = 0.5;` |
| `pg_trgm.word_similarity_threshold` | 0.6 | `<%`, `%>` | `SET pg_trgm.word_similarity_threshold = 0.7;` |
| `pg_trgm.strict_word_similarity_threshold` | 0.5 | `<<%`, `%>>` | `SET pg_trgm.strict_word_similarity_threshold = 0.6;` |

Per-session GUC. Use `SET LOCAL` inside a transaction for one-query overrides. Cluster-wide via `ALTER SYSTEM SET pg_trgm.similarity_threshold = 0.4;` + `SELECT pg_reload_conf();`.

> [!NOTE] threshold change → query results change
> Operator `%` returns true based on the current threshold. A 0.3 default catches more matches but more false positives; 0.5 narrower. Tune per-application — never assume default fits your data.

### GIN Index — gin_trgm_ops

    CREATE INDEX users_name_trgm_idx
        ON users USING gin (name gin_trgm_ops);

Supports operators: `%`, `<%`, `%>`, `<<%`, `%>>`, `LIKE`, `ILIKE`, `~`, `~*`, `=` (PG14+).

Does NOT support distance operators (`<->`, `<<->`, `<<<->`) — no KNN with GIN. For `ORDER BY col <-> 'q' LIMIT N` use GiST.

Tuning:

- `fastupdate` storage parameter (default `on`): writes to pending list first, flushed on `VACUUM`/`gin_clean_pending_list()`. Lower latency on inserts, longer first-query after burst.
- `gin_pending_list_limit` GUC: flush threshold. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for full GIN mechanics.

### GiST Index — gist_trgm_ops

    CREATE INDEX users_name_trgm_idx
        ON users USING gist (name gist_trgm_ops);

Supports operators: `%`, `<%`, `%>`, `<<%`, `%>>`, `<->`, `<<->`, `<->>`, `<<<->`, `<->>>`, `LIKE`, `ILIKE`, `~`, `~*`, `=` (PG14+). **And** distance operators for KNN.

`siglen` parameter — signature length:

Verbatim from [pgtrgm.html][pgtrgm-16]:

> `gist_trgm_ops` GiST opclass approximates a set of trigrams as a bitmap signature. Its optional integer parameter `siglen` determines the signature length in bytes. The default length is 12 bytes. Valid values of signature length are between 1 and 2024 bytes. Longer signatures lead to a more precise search (scanning a smaller fraction of the index and fewer heap pages), at the cost of a larger index.

    -- Default siglen=12, ~good-enough for most workloads
    CREATE INDEX a ON t USING gist (col gist_trgm_ops);

    -- Larger siglen=64 for higher precision (less false-positive recheck)
    CREATE INDEX b ON t USING gist (col gist_trgm_ops(siglen=64));

    -- Maximum siglen=2024 (rarely useful; index becomes huge)
    CREATE INDEX c ON t USING gist (col gist_trgm_ops(siglen=2024));

GiST is **lossy** for trigram — bitmap signatures lose information. Index match always rechecked against heap tuple via `Recheck Cond` in `EXPLAIN`. See [`56-explain.md`](./56-explain.md).

### GIN vs GiST Decision

| Property | `gin_trgm_ops` | `gist_trgm_ops` |
|---|---|---|
| Read speed | Fast (~10× GiST on substring) | Slower |
| Write speed | Slow, write amplification | Faster |
| Index size | Larger (~2-5× heap) | Smaller (~10-20% heap) |
| Lossy / recheck | Lossless | Lossy (recheck always) |
| KNN `<->` distance ordering | NO | YES |
| `LIKE` / `ILIKE` / regex | YES | YES |
| `%` / `<%` / `<<%` predicates | YES | YES |
| Equality `=` (PG14+) | YES | YES |
| Tuning knob | `fastupdate`, `gin_pending_list_limit` | `siglen` (1-2024, default 12) |
| Build parallel (PG18+) | YES (Tomas Vondra, Matthias van de Meent) | NO |

Rule of thumb: **GIN unless you need KNN or write rate is so high GIN can't keep up.** GiST's main practical advantage is KNN `ORDER BY col <-> 'q'`. If your queries are pure substring/regex filtering, GIN wins.

### LIKE / ILIKE / Regex Acceleration

Both opclasses accelerate `LIKE`, `ILIKE`, `~`, `~*` patterns. Planner picks index when pattern has 2+ contiguous non-wildcard characters.

    -- All four accelerate via gin_trgm_ops / gist_trgm_ops:
    SELECT * FROM users WHERE name LIKE '%alice%';
    SELECT * FROM users WHERE name ILIKE '%ALICE%';
    SELECT * FROM users WHERE name ~ 'alice.*smith';
    SELECT * FROM users WHERE name ~* '^john.*[0-9]$';

    -- Anchored prefix LIKE 'foo%' — trigram works but B-tree text_pattern_ops faster:
    SELECT * FROM users WHERE name LIKE 'al%';

    -- Single-character pattern '%a%' — too short, won't use index:
    SELECT * FROM users WHERE name LIKE '%a%';
    -- Sequential scan. Need at least 2 contiguous characters.

`EXPLAIN ANALYZE` to verify trigram index used:

    EXPLAIN ANALYZE
    SELECT name FROM users WHERE name ILIKE '%mart%';
    --                          QUERY PLAN
    -- ────────────────────────────────────────────────────────────
    --  Bitmap Heap Scan on users  (cost=...)
    --    Recheck Cond: (name ~~* '%mart%'::text)
    --    Rows Removed by Index Recheck: 12     -- GiST is lossy
    --    ->  Bitmap Index Scan on users_name_trgm_idx
    --          Index Cond: (name ~~* '%mart%'::text)
    --
    -- ILIKE uses ~~* operator; mapped to trigram index by gin_trgm_ops/gist_trgm_ops

### Equality Acceleration PG14+

> [!NOTE] PostgreSQL 14
> "Allow GiST/GIN pg_trgm indexes to do equality lookups (Julien Rouhaud). … This is similar to `LIKE` except no wildcards are honored." [^pg14-trgm-eq]

Before PG14, `WHERE col = 'foo'` could not use a trigram index — required a separate B-tree. PG14+ trigram indexes serve `=` too.

Operational consequence: **one trigram index can cover substring + regex + equality + similarity**. Saves the second B-tree if column is primarily fuzzy-queried.

Trade-off: B-tree on `=` still ~5-10× faster than trigram on `=`. If equality is the dominant query, keep B-tree; trigram for fuzzy.

### Collation-Provider Change PG18+

> [!WARNING] PostgreSQL 18 — Reindex pg_trgm indexes after pg_upgrade if non-libc default
> Verbatim from [PG18 release notes][pg18-release-notes]:
>
> "Change full text search to use the default collation provider of the cluster to read configuration files and dictionaries, rather than always using libc (Peter Eisentraut) … Clusters that default to non-libc collation providers (e.g., ICU, builtin) that behave differently than libc for characters processed by LC_CTYPE could observe changes in behavior of some full-text search functions, as well as the pg_trgm extension. When upgrading such clusters using pg_upgrade, it is recommended to reindex all indexes related to full-text search and pg_trgm after the upgrade."

This affects you if:

- Cluster default collation provider is **not** libc (ICU or builtin)
- You upgrade to PG18 via `pg_upgrade`
- You have `gin_trgm_ops` or `gist_trgm_ops` indexes

Fix: post-`pg_upgrade`, run `REINDEX INDEX CONCURRENTLY <each_trgm_index>;` per affected index. See [`26-index-maintenance.md`](./26-index-maintenance.md) for full REINDEX CONCURRENTLY mechanics.

Audit query to find all trigram indexes:

    SELECT n.nspname AS schema, c.relname AS index_name, t.relname AS table_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_opclass o ON o.oid = ANY(i.indclass)
    WHERE o.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
    ORDER BY schema, table_name;

## Per-Version Timeline

| Version | Change | Author |
|---|---|---|
| PG14 | "Allow GiST/GIN pg_trgm indexes to do equality lookups" [^pg14-trgm-eq] | Julien Rouhaud |
| PG15 | No direct pg_trgm release-note items | — |
| PG16 | No direct pg_trgm release-note items | — |
| PG17 | No direct pg_trgm release-note items | — |
| PG18 | "Allow GIN indexes to be created in parallel" [^pg18-parallel-gin] | Tomas Vondra, Matthias van de Meent |
| PG18 | FTS + pg_trgm use cluster default collation provider; REINDEX after pg_upgrade if non-libc [^pg18-fts-collation] | Peter Eisentraut |

**Five consecutive majors had only THREE pg_trgm items** (PG14, PG18×2). pg_trgm interface is stable. Anyone claiming "PG15/16/17 improved pg_trgm" — verify against release notes directly.

## Recipes

### 1. Baseline GIN index for substring search

    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE TABLE users (
        id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name    text NOT NULL,
        email   text NOT NULL UNIQUE
    );

    -- One index covers LIKE / ILIKE / regex / similarity / equality PG14+
    CREATE INDEX users_name_trgm_idx
        ON users USING gin (name gin_trgm_ops);

    -- Verify
    SELECT name FROM users WHERE name ILIKE '%alic%';
    --
    EXPLAIN (ANALYZE, BUFFERS) SELECT name FROM users WHERE name ILIKE '%alic%';
    -- Should show Bitmap Index Scan on users_name_trgm_idx

### 2. GiST KNN typo-tolerant autocomplete

    CREATE INDEX users_name_trgm_gist_idx
        ON users USING gist (name gist_trgm_ops);

    -- Top-10 closest matches to typo'd input
    SELECT name, similarity(name, 'jonh smit') AS sim
    FROM users
    WHERE name % 'jonh smit'              -- threshold prefilter via index
    ORDER BY name <-> 'jonh smit'         -- distance via GiST KNN
    LIMIT 10;

    -- Plan must show "Index Scan using users_name_trgm_gist_idx"
    -- with sort key column <-> 'jonh smit' — no Sort node

### 3. Tune siglen for higher GiST precision

    -- Default siglen=12 — fast but lossy, lots of recheck
    -- siglen=64 — fewer false positives, ~5× index size
    CREATE INDEX products_name_gist_64
        ON products USING gist (name gist_trgm_ops(siglen=64));

    -- Compare:
    SELECT pg_size_pretty(pg_relation_size('products_name_gist_default')) AS default_size,
           pg_size_pretty(pg_relation_size('products_name_gist_64'))      AS large_size;

    -- Check recheck-rows-removed in EXPLAIN ANALYZE — should drop substantially

### 4. Per-session similarity threshold

    BEGIN;
    SET LOCAL pg_trgm.similarity_threshold = 0.5;   -- stricter than default 0.3
    SELECT name FROM users WHERE name % 'martin';
    COMMIT;

    -- Cluster-wide:
    ALTER SYSTEM SET pg_trgm.similarity_threshold = 0.4;
    SELECT pg_reload_conf();
    SHOW pg_trgm.similarity_threshold;

### 5. Fuzzy search with similarity ranking

    SELECT name, similarity(name, 'martn') AS sim
    FROM users
    WHERE name % 'martn'              -- index-friendly predicate
    ORDER BY sim DESC                  -- rank by full-string similarity
    LIMIT 20;

    -- For word-level matching (multi-word free-text):
    SELECT description, word_similarity('database', description) AS sim
    FROM articles
    WHERE description <% 'database'
    ORDER BY description <<-> 'database'
    LIMIT 10;

### 6. Multi-column fuzzy via concatenation

    -- pg_trgm operators work on single text; combine columns via expression index
    CREATE INDEX users_fullname_trgm_idx
        ON users USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

    -- Query MUST match expression exactly
    SELECT first_name, last_name
    FROM users
    WHERE (first_name || ' ' || last_name) ILIKE '%jo%smith%';

### 7. Audit all trigram indexes

    SELECT n.nspname || '.' || t.relname AS table_qualified,
           c.relname                       AS index_name,
           o.opcname                       AS opclass,
           pg_size_pretty(pg_relation_size(c.oid)) AS size,
           CASE WHEN a.amname = 'gin' THEN 'GIN'
                WHEN a.amname = 'gist' THEN 'GiST' END AS method
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am a ON a.oid = c.relam
    JOIN pg_opclass o ON o.oid = ANY(i.indclass)
    WHERE o.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
    ORDER BY pg_relation_size(c.oid) DESC;

### 8. Post-PG18-upgrade REINDEX after non-libc default

    -- One-shot loop for any cluster where default collation provider is non-libc
    DO $$
    DECLARE r record;
    BEGIN
        FOR r IN
            SELECT format('%I.%I', n.nspname, c.relname) AS idx
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_opclass o ON o.oid = ANY(i.indclass)
            WHERE o.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
        LOOP
            EXECUTE format('REINDEX INDEX CONCURRENTLY %s', r.idx);
            RAISE NOTICE 'Reindexed %', r.idx;
        END LOOP;
    END $$;

    -- Alternative if you also have FTS indexes — pair with iter 65/26 cross-reference
    -- See 65-collations-encoding.md for full collation-version monitoring

### 9. Detect tables that would benefit from trigram index

    -- Find columns where users query with LIKE/ILIKE/% but no trigram index exists
    SELECT s.queryid, s.calls, s.mean_exec_time, left(s.query, 100) AS sample
    FROM pg_stat_statements s
    WHERE s.query ILIKE '%LIKE ''%''%' OR s.query ILIKE '%ILIKE ''%''%'
    ORDER BY s.total_exec_time DESC
    LIMIT 20;

    -- For each, run EXPLAIN; if Seq Scan + filter on LIKE/ILIKE, candidate for trigram

### 10. Approximate dedup across million-row table

    -- Find near-duplicate names by similarity threshold
    WITH candidates AS (
        SELECT a.id AS id_a, b.id AS id_b,
               a.name AS name_a, b.name AS name_b,
               similarity(a.name, b.name) AS sim
        FROM users a
        JOIN users b ON b.name % a.name      -- index-eligible operator
        WHERE a.id < b.id                     -- one pair, not both directions
    )
    SELECT * FROM candidates
    WHERE sim > 0.85
    ORDER BY sim DESC;

    -- Tune threshold via SET LOCAL or by changing similarity > 0.85 comparison

### 11. Combine trigram with B-tree for hot equality + fuzzy

    -- Trigram covers fuzzy; B-tree faster for the dominant equality query
    CREATE INDEX users_email_btree ON users (email);                    -- = lookups
    CREATE INDEX users_email_trgm  ON users USING gin (email gin_trgm_ops);  -- LIKE/similarity

    -- Planner picks per query:
    SELECT * FROM users WHERE email = 'alice@example.com';        -- B-tree
    SELECT * FROM users WHERE email ILIKE '%@example.com';        -- GIN trigram

### 12. PG18 parallel GIN build

    -- Before PG18, GIN builds were single-threaded — slow on large tables
    -- PG18+ allows parallel GIN build (Tomas Vondra, Matthias van de Meent)
    SET max_parallel_maintenance_workers = 4;
    SET maintenance_work_mem = '2GB';

    CREATE INDEX big_table_text_trgm
        ON big_table USING gin (text_col gin_trgm_ops);

    -- Monitor with pg_stat_progress_create_index — Workers Launched should be >0

### 13. Inspect what a trigram column actually contains

    -- show_trgm for debugging match failures
    SELECT name, show_trgm(name) AS trigrams
    FROM users
    WHERE id = 42;

    -- Compare two strings' trigram sets
    SELECT show_trgm('martin') AS a, show_trgm('mártín') AS b,
           similarity('martin', 'mártín') AS sim;
    -- ICU vs libc accent handling: similarity may be 0.0 (no shared trigrams)
    -- under default libc collation, or non-zero under ICU with accent-insensitive locale

### 14. Benchmark GIN vs GiST on the same column

    -- Same table, two indexes
    CREATE TABLE bench (name text);
    INSERT INTO bench SELECT 'user_' || gs::text
    FROM generate_series(1, 1000000) gs;

    CREATE INDEX bench_gin  ON bench USING gin  (name gin_trgm_ops);
    CREATE INDEX bench_gist ON bench USING gist (name gist_trgm_ops);

    -- Compare sizes
    SELECT pg_size_pretty(pg_relation_size('bench_gin'))  AS gin_size,
           pg_size_pretty(pg_relation_size('bench_gist')) AS gist_size,
           pg_size_pretty(pg_relation_size('bench'))      AS heap_size;
    -- typical: gin 45MB / gist 8MB / heap 35MB

    -- Force planner choice
    SET enable_bitmapscan = on;
    SET LOCAL random_page_cost = 1.1;

    -- Force GIN
    DROP INDEX bench_gist;
    EXPLAIN (ANALYZE, BUFFERS) SELECT name FROM bench WHERE name ILIKE '%user_5%';

    -- Force GiST
    CREATE INDEX bench_gist ON bench USING gist (name gist_trgm_ops);
    DROP INDEX bench_gin;
    EXPLAIN (ANALYZE, BUFFERS) SELECT name FROM bench WHERE name ILIKE '%user_5%';

    -- Compare execution time + Buffers + Rows Removed by Index Recheck

### 15. Force exact substring match via combination

    -- pg_trgm is character-level; for exact-match keywords use combined approach
    -- Trigram index narrows candidates → LATERAL filter does exact check

    CREATE INDEX docs_body_trgm ON docs USING gin (body gin_trgm_ops);

    SELECT id, body
    FROM docs
    WHERE body ILIKE '%postgres%'                 -- trigram-eligible filter
      AND body LIKE '%postgres%'                  -- exact substring (case-sensitive)
      AND position(' postgres ' IN body) > 0;     -- word-boundary exact match

    -- Trigram filters down to ~thousands; remaining predicates run per-row

### 16. Detect duplicate-trigger queries skipping index

    -- pg_stat_statements may show similar queries with and without trigram acceleration
    SELECT s.queryid, s.calls, s.mean_exec_time,
           left(s.query, 80) AS sample
    FROM pg_stat_statements s
    JOIN pg_user u ON u.usesysid = s.userid
    WHERE s.query ~* '(ilike|like|similarity\(|~ *['']%|~\* *['']%)'
    ORDER BY s.total_exec_time DESC
    LIMIT 25;
    -- Pair with EXPLAIN to find Seq Scan candidates

### 17. Bound work_mem during fuzzy-heavy reporter session

    BEGIN;
    SET LOCAL work_mem = '128MB';                  -- trigram bitmaps need more memory
    SET LOCAL pg_trgm.similarity_threshold = 0.4;

    SELECT name FROM customers
    WHERE name % 'martinz'                          -- fuzzy
       OR name ILIKE '%mart%'                       -- substring
    ORDER BY similarity(name, 'martinz') DESC
    LIMIT 50;
    COMMIT;

## Operational Notes

### Cost model considerations

The planner estimates trigram-index cost via the `gincostestimate`/`gistcostestimate` mechanisms. Cardinality on `LIKE '%foo%'` predicates is hard — planner often overestimates the selectivity, leading to seq-scan choice. Two mitigations:

- Bump `default_statistics_target` for the column (`ALTER TABLE t ALTER COLUMN c SET STATISTICS 1000;`) so the planner sees more representative MCV/histogram entries.
- Use the `%` operator with `pg_trgm.similarity_threshold` — planner can rely on the operator's selectivity estimator more reliably than free-form `LIKE`.

See [`55-statistics-planner.md`](./55-statistics-planner.md) for full planner-stats tuning.

### Build-time vs query-time cost

| Operation | GIN cost profile | GiST cost profile |
|---|---|---|
| `CREATE INDEX` (1M rows) | Slow single-threaded pre-PG18; PG18+ parallel | Medium |
| `INSERT` per row | Slow (writes pending list then merge on VACUUM) | Fast |
| `UPDATE` non-indexed column | HOT may apply if no trigram-column change | Same |
| `UPDATE` indexed column | Index entry rewrite | Index entry rewrite |
| `SELECT` substring | Fast (~10× GiST) | Slower |
| `SELECT` KNN `<->` | Not supported | Fast (no Sort node) |
| `REINDEX CONCURRENTLY` | Slow + ACCESS EXCLUSIVE at end | Faster |

### Monitoring trigram index health

    -- Per-index usage from pg_stat_user_indexes
    SELECT s.schemaname || '.' || s.relname AS table_qualified,
           s.indexrelname                    AS index_name,
           s.idx_scan,
           s.idx_tup_read,
           s.idx_tup_fetch,
           pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
           CASE WHEN s.idx_scan = 0 THEN 'UNUSED'
                WHEN s.idx_scan < 100 THEN 'rare'
                ELSE 'active' END            AS usage_class
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    JOIN pg_opclass o ON o.oid = ANY(i.indclass)
    WHERE o.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
    ORDER BY s.idx_scan;

    -- GIN pending-list pressure (only for fastupdate=on)
    -- Run gin_clean_pending_list() if pending list grows large
    SELECT n.nspname || '.' || c.relname AS index_name,
           gin_clean_pending_list(c.oid)
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_opclass o ON o.oid = ANY(i.indclass)
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE o.opcname = 'gin_trgm_ops';

### When pg_trgm is the wrong tool

Five clear signals you should NOT use pg_trgm:

- **Anchored prefix only (`LIKE 'foo%'`)** — B-tree with `text_pattern_ops` is smaller, faster, supports range. See [`23-btree-indexes.md`](./23-btree-indexes.md).
- **Multi-token document search** — `tsvector` understands words, stemming, stop words, languages. See [`20-text-search.md`](./20-text-search.md).
- **Semantic similarity** — pg_trgm matches character overlap, not meaning. `'car'` and `'automobile'` share zero trigrams. Use [`94-pgvector.md`](./94-pgvector.md).
- **Case-insensitive equality only** — `citext` type or expression index on `lower(col)` is purpose-built and smaller.
- **Exact regex with anchors** — `~ '^foo$'` is equivalent to `= 'foo'`. Use B-tree.

## Gotchas

1. **`similarity()` in `WHERE` without operator → no index use.** `WHERE similarity(col, 'q') > 0.3` is a sequential scan. Use `WHERE col % 'q'` instead — operator is index-eligible.

2. **`pg_trgm.similarity_threshold` is per-session.** Cluster-wide change via `ALTER SYSTEM` + reload. Changing threshold changes which rows the `%` operator returns. Tests pass at threshold 0.3 may fail at 0.5.

3. **Patterns under 2 contiguous characters can't use trigram index.** `LIKE '%a%'`, `LIKE 'a%b%c'` (single-char fragments) sequential-scan. Need at least one 2-char run.

4. **GIN does NOT support KNN distance ordering.** `ORDER BY col <-> 'q' LIMIT 10` on `gin_trgm_ops` produces a Sort node, not an index scan with KNN. Use `gist_trgm_ops` for KNN.

5. **GiST is lossy — always rechecks heap.** `Rows Removed by Index Recheck` in `EXPLAIN` is normal. Larger `siglen` reduces recheck but enlarges index.

6. **Trigram extraction lowercases.** `'Foo'` and `'foo'` have identical trigram sets. Trigram index is implicitly case-insensitive for both substring and similarity. For case-sensitive substring, use B-tree on `text_pattern_ops` (anchored only) or expression index.

7. **Non-word characters split words.** `'foo-bar'` ≡ `'foo bar'` ≡ `'foo|bar'` for trigram purposes. Pattern `'%foo-bar%'` searches for `' f', 'fo', 'oo ', ' b', 'ba', 'ar '` — the hyphen disappears. Index may match `'foo bar'` rows you didn't expect.

8. **Short strings produce noisy similarity scores.** `similarity('a', 'b') = 0` but `similarity('ab', 'ac') = 0.2` — three trigrams each, one shared. Below ~5 character strings, scores are unreliable for ranking. Use `length(col) >= 5` filter for stable ranking.

9. **`set_limit()` and `show_limit()` are deprecated.** Use `SET pg_trgm.similarity_threshold` and `SHOW pg_trgm.similarity_threshold`. Docs explicitly mark deprecated.

10. **`%` operator order matters under PgBouncer transaction-mode.** Per-session `SET pg_trgm.similarity_threshold` doesn't persist across pgBouncer transaction-mode connections — use `SET LOCAL` inside the transaction. See [`80-connection-pooling.md`](./80-connection-pooling.md).

11. **Equality via trigram is slower than B-tree.** PG14+ trigram indexes support `=` but a B-tree is still ~5-10× faster for pure equality. Only use trigram for `=` when you want one index for substring + equality.

12. **Index size 2-5× heap for GIN.** A 10GB table with `gin_trgm_ops` on a text column can produce a 20-50GB index. Plan disk + `maintenance_work_mem` accordingly.

13. **GIN `fastupdate=on` (default) causes search latency variance.** Bursts of writes accumulate in pending list, first query after burst scans pending list inline. For latency-sensitive workloads, set `fastupdate=off` or run `gin_clean_pending_list()` proactively. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md).

14. **REINDEX CONCURRENTLY required after PG18 pg_upgrade if non-libc default.** ICU/builtin collation providers may produce different trigrams than libc for LC_CTYPE-sensitive characters. Triple-anchored: mental-model rule 5 / Collation-Provider Change H3 / gotcha 14. See [`65-collations-encoding.md`](./65-collations-encoding.md).

15. **No language awareness.** pg_trgm has no concept of stemming, stop words, language detection, multi-byte normalization. `'running'` and `'run'` share trigrams `'run'` but won't match well. Use [tsvector](./20-text-search.md) for linguistic search.

16. **Expression index requires exact expression match in query.** `CREATE INDEX ... USING gin ((lower(name)) gin_trgm_ops)` accelerates `WHERE lower(name) ILIKE '%x%'` only — `WHERE name ILIKE '%x%'` won't use it.

17. **PG14 added equality support but didn't add `IS NULL` support.** `WHERE col IS NULL` cannot use trigram index. Use partial index `WHERE col IS NULL` separately if needed.

18. **Cross-locale similarity changes.** Same trigram-index column produces different `similarity()` values under different `LC_CTYPE`. PG18 amplifies this with the collation-provider default change. Test thresholds in your target locale before deploying.

19. **`<%` argument order asymmetric.** `'short' <% 'long string'` checks if `'short'` matches an extent in `'long string'`. `'long string' <% 'short'` likely returns false. Pick commutator `%>` when query column is on the left for index use.

20. **Trigram index does NOT help `column1 LIKE column2`.** Cross-column substring requires sequential scan even with both indexed. Index helps only literal-pattern queries.

21. **Concatenated-column indexes need transitivity care.** `CREATE INDEX ... USING gin ((a || ' ' || b) gin_trgm_ops)` works but query must use exact expression. Mid-string spaces matter: `'foo bar' || ' ' || 'baz'` → `'foo bar baz'`; concatenating `'foo'` + `'bar baz'` gives the same trigrams but different word boundaries.

22. **PG18 parallel GIN build doesn't help CREATE INDEX CONCURRENTLY.** CIC always single-threaded regardless of `max_parallel_maintenance_workers`. Parallel GIN helps offline `CREATE INDEX` and `REINDEX`. See [`26-index-maintenance.md`](./26-index-maintenance.md).

23. **No partial trigram operators.** No way to ask "trigrams starting with X" via operator. Must use `LIKE` or regex.

## See Also

- [`20-text-search.md`](./20-text-search.md) — full-text search (`tsvector` / `tsquery`) for linguistic search, the canonical alternative to pg_trgm for document-style content
- [`22-indexes-overview.md`](./22-indexes-overview.md) — index-type decision matrix
- [`23-btree-indexes.md`](./23-btree-indexes.md) — B-tree `text_pattern_ops` for anchored prefix LIKE
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN + GiST mechanics, `fastupdate`, `gin_pending_list_limit`
- [`26-index-maintenance.md`](./26-index-maintenance.md) — REINDEX CONCURRENTLY, CREATE INDEX CONCURRENTLY
- [`56-explain.md`](./56-explain.md) — reading Bitmap Index Scan + Recheck Cond
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — pg_stat_user_indexes for index usage
- [`64-system-catalogs.md`](./64-system-catalogs.md) — pg_opclass for index audit
- [`65-collations-encoding.md`](./65-collations-encoding.md) — collation-provider implications PG18+
- [`69-extensions.md`](./69-extensions.md) — CREATE EXTENSION mechanics
- [`80-connection-pooling.md`](./80-connection-pooling.md) — `SET` vs `SET LOCAL` under transaction-mode pooling
- [`94-pgvector.md`](./94-pgvector.md) — semantic-similarity via embeddings (different problem than trigram)
- [`95-postgis.md`](./95-postgis.md) — geocoding workflows often combine trigram fuzzy text matching with spatial queries
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — PG18 collation-provider change that requires REINDEX of trigram indexes
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — Recipe 1 Index Decision Flowchart row for LIKE/ILIKE using pg_trgm

## Sources

[^pgtrgm-16]: PostgreSQL 16 pg_trgm — https://www.postgresql.org/docs/16/pgtrgm.html — definitions of trigram extraction, function catalog, operator catalog, siglen parameter, GIN/GiST opclass capabilities

[^pgtrgm-17]: PostgreSQL 17 pg_trgm — https://www.postgresql.org/docs/17/pgtrgm.html — identical interface to PG16

[^pgtrgm-18]: PostgreSQL 18 pg_trgm — https://www.postgresql.org/docs/18/pgtrgm.html — interface unchanged from PG16/17; collation-provider behavior change reflected in release notes

[^pg14-trgm-eq]: PostgreSQL 14 Release Notes — https://www.postgresql.org/docs/release/14.0/ — "Allow GiST/GIN pg_trgm indexes to do equality lookups (Julien Rouhaud). This is similar to LIKE except no wildcards are honored." (E.23.3.13. Additional Modules)

[^pg18-parallel-gin]: PostgreSQL 18 Release Notes — https://www.postgresql.org/docs/release/18.0/ — "Allow GIN indexes to be created in parallel (Tomas Vondra, Matthias van de Meent)" (E.4.3.1.2. Indexes)

[^pg18-fts-collation]: PostgreSQL 18 Release Notes — https://www.postgresql.org/docs/release/18.0/ — "Change full text search to use the default collation provider of the cluster to read configuration files and dictionaries, rather than always using libc (Peter Eisentraut). Clusters that default to non-libc collation providers (e.g., ICU, builtin) that behave differently than libc for characters processed by LC_CTYPE could observe changes in behavior of some full-text search functions, as well as the pg_trgm extension. When upgrading such clusters using pg_upgrade, it is recommended to reindex all indexes related to full-text search and pg_trgm after the upgrade." (E.4.2. Migration to Version 18)

[pgtrgm-16]: https://www.postgresql.org/docs/16/pgtrgm.html
[pg18-release-notes]: https://www.postgresql.org/docs/release/18.0/

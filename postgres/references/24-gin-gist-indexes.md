# GIN and GiST Indexes


GIN (Generalized Inverted Index) and GiST (Generalized Search Tree) are PostgreSQL's two extensible non-B-tree access methods. They share a "generalized" character — both delegate the type-specific logic to operator-class support functions and ship with built-in opclasses for arrays, JSONB, full-text search, ranges, and geometric types — but they are operationally very different and are picked for different reasons. This file is the deep-dive on both, picking up where [`22-indexes-overview.md`](./22-indexes-overview.md) routes the reader.


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [The Mental Model](#the-mental-model)
- [Decision Matrix: GIN vs GiST](#decision-matrix-gin-vs-gist)
- [GIN Mechanics](#gin-mechanics)
    - [Posting lists and posting trees](#posting-lists-and-posting-trees)
    - [Built-in GIN opclasses](#built-in-gin-opclasses)
    - [fastupdate and the pending list](#fastupdate-and-the-pending-list)
    - [GIN tuning GUCs](#gin-tuning-gucs)
    - [GIN extensibility (writing your own opclass)](#gin-extensibility-writing-your-own-opclass)
- [GiST Mechanics](#gist-mechanics)
    - [Built-in GiST opclasses](#built-in-gist-opclasses)
    - [KNN-GiST: distance-ordered search](#knn-gist-distance-ordered-search)
    - [GiST extensibility (writing your own opclass)](#gist-extensibility-writing-your-own-opclass)
    - [Build methods (sorted vs buffering vs default)](#build-methods-sorted-vs-buffering-vs-default)
- [EXCLUDE constraints with GiST](#exclude-constraints-with-gist)
- [pg_trgm: GIN vs GiST trigram opclasses](#pg_trgm-gin-vs-gist-trigram-opclasses)
- [btree_gin and btree_gist (when needed)](#btree_gin-and-btree_gist-when-needed)
- [Per-version timeline](#per-version-timeline)
- [Inspection with pageinspect](#inspection-with-pageinspect)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Read this file when:

- You need to decide between **GIN and GiST** for a column whose access patterns are non-scalar — arrays, JSONB, tsvector, ranges, geometric types, trigrams, etc.
- You need to understand why GIN updates are slow and what `fastupdate` actually trades.
- You need to write `EXCLUDE USING gist (period WITH &&)` constraints and aren't sure if `btree_gist` is required.
- You need to pick between `jsonb_ops` and `jsonb_path_ops` for a JSONB GIN index.
- You need a `<->` (KNN distance) ordered query and need to know which access methods support it.
- You need to use `pg_trgm` with `gin_trgm_ops` vs `gist_trgm_ops` and need the operational trade-off.

Defer to siblings for:

- **B-tree** internals — [`23-btree-indexes.md`](./23-btree-indexes.md).
- **BRIN, hash, SP-GiST, Bloom** — [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md). SP-GiST shares a name with GiST but is a separate access method (a partitioning-based extensibility framework for non-balanced trees: k-d-trees, quadtrees, suffix trees, radix trees).
- **CREATE INDEX CONCURRENTLY, REINDEX, bloat** — [`26-index-maintenance.md`](./26-index-maintenance.md).
- **PostGIS spatial indexes** — [`95-postgis.md`](./95-postgis.md). The geometric opclasses below are the in-core types only; PostGIS layers on much richer spatial opclasses for `geometry`/`geography` over the same GiST/SP-GiST machinery.


## The Mental Model


Five rules drive every decision in this file.


1. **GIN is an inverted index; GiST is a tree of bounding predicates.** GIN stores `(key, posting list of TIDs)` pairs — *element-level* indexing. GiST stores at each node a *predicate* that holds for every row reachable below — *region-level* indexing. The data model dictates which is appropriate.

2. **GIN is the default for set-membership / containment workloads.** For arrays (`@>`, `<@`, `&&`, `=`), JSONB (`@>`, `?`, `?|`, `?&`), and full-text search (`@@`), GIN is the right call. Docs: *"GIN indexes are the preferred text search index type."*[^gin-fts-preferred] Pick GiST for FTS only when the dataset is small and updates dominate reads.

3. **GIN is lossless; GiST is lossy.** GIN returns exact TIDs; queries do not need to recheck rows for the indexed predicate (though the *outer* query may still recheck for non-indexed predicates). GiST stores a fixed-length *signature* — a lossy summary — and every match must be rechecked against the heap to eliminate false positives.[^textsearch-indexes]

4. **GiST is the only choice for KNN ordering and EXCLUDE constraints.** The `<->` distance operator and the `EXCLUDE USING gist (... WITH &&)` exclusion-constraint pattern are GiST-only (and SP-GiST in some cases — see [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md)). GIN cannot do either.

5. **GIN updates are slow by construction.** Every indexed row produces N index entries (one per extracted key). The `fastupdate` mechanism (default ON) batches them into a pending list to amortize cost — but searches must scan the pending list, autovacuum eventually flushes it, and the choice trades latency variance for sustained write throughput. Bulk-loading? Drop the index and rebuild after.[^gin-tips]


## Decision Matrix: GIN vs GiST


Eleven rows. The upper option is the default unless the row's "Use GiST when" column gives you a concrete reason.


| Workload / data | Default | Use GiST instead when | Notes |
|---|---|---|---|
| Full-text search (`tsvector @@ tsquery`) | **GIN** (`tsvector_ops`) | Updates dominate reads, dataset under ~100 MB | Docs explicitly call GIN preferred[^gin-fts-preferred] |
| Array containment / overlap (`@>`, `<@`, `&&`, `=`) | **GIN** (`array_ops`) | Never | GiST has no built-in array opclass |
| JSONB containment + key existence | **GIN** (`jsonb_ops`) | Never (GIN-only) | See `jsonb_path_ops` row below |
| JSONB containment only (`@>`) | **GIN** (`jsonb_path_ops`) | Never (GIN-only) | Smaller, faster, but no `?`/`?|`/`?&` |
| pg_trgm substring/`LIKE`/`ILIKE`/regex | **GIN** (`gin_trgm_ops`) | You need `<->` distance ordering | KNN ordering is GiST-only |
| Range overlap / containment / adjacency (`&&`, `@>`, `<@`, `-|-`) | **GiST** (`range_ops`) | n/a | GIN does not support range operators |
| Multirange overlap / containment (`&&`, `@>`, `<@`) | **GiST** (`multirange_ops`) | n/a | Native GiST opclass since multirange shipped (PG14+) |
| KNN nearest neighbor (`ORDER BY col <-> point LIMIT N`) | **GiST** (`<->` operator) | n/a | Only GiST and SP-GiST support ordering operators |
| Geometric `box`, `circle`, `polygon`, `point`, `line` predicates | **GiST** (built-in opclasses) | n/a | See built-in opclasses below |
| `inet` / `cidr` containment (`<<`, `>>`, `<<=`, `>>=`) | **GiST** (`inet_ops`, **must specify**) | n/a | `inet_ops` is **not** the default opclass; you must request it explicitly[^gist-inet] |
| `EXCLUDE USING ...` exclusion constraint | **GiST** | n/a | Range/geometric exclusion. Add `btree_gist` only when mixing equality with range |


### Three smell signals that you reached for the wrong index

1. **GIN for low-cardinality scalar equality** — pure overhead vs B-tree. Use B-tree (or `btree_gin` only as part of a multicolumn GIN — see [btree_gin section](#btree_gin-and-btree_gist-when-needed)).
2. **GiST for FTS at scale** — GiST signatures get false positives that scale as data grows; GIN keeps lookups exact at the cost of slower updates.
3. **GIN with `fastupdate=off` and high write volume** — you've forfeited GIN's only write-throughput optimization. Either accept the variance with `fastupdate=on` or move the workload to a different access method.


## GIN Mechanics


Internally, a GIN index is a B-tree of B-trees. The outer B-tree indexes keys (lexemes for FTS, elements for arrays, paths-and-leaves for JSONB). Each outer-B-tree leaf tuple holds either a posting list (small inline TID array) or a pointer to a posting tree (a separate B-tree of TIDs for high-frequency keys).

> Internally, a GIN index contains a B-tree index constructed over keys, where each key is an element of one or more indexed items (a member of an array, for example) and where each tuple in a leaf page contains either a pointer to a B-tree of heap pointers (a "posting tree"), or a simple list of heap pointers (a "posting list") when the list is small enough to fit into a single index tuple along with the key value.[^gin-implementation]


### Posting lists and posting trees


- A **posting list** is the inline form. It lives in the outer B-tree's leaf tuple alongside the key. Used when the number of TIDs for that key is small.
- A **posting tree** is the spilled form: a separate, dedicated B-tree of TIDs for one key. Used when one key (e.g., the lexeme `the`, or the array element `1`) has many matching rows.

Practical effect: high-frequency keys (FTS stop-words, JSONB keys present in most rows, array values shared by many rows) cost more per match because they go through a posting tree rather than an inline list. The classic FTS advice — strip stop-words via the configuration's dictionary chain — is what saves GIN here.


### Built-in GIN opclasses


GIN ships with four built-in opclasses[^gin-builtin]:


| Opclass | Type | Operators supported |
|---|---|---|
| `array_ops` (default) | `anyarray` | `&&`, `@>`, `<@`, `=` |
| `jsonb_ops` (default) | `jsonb` | `@>`, `@?`, `@@`, `?`, `?|`, `?&` |
| `jsonb_path_ops` | `jsonb` | `@>`, `@?`, `@@` |
| `tsvector_ops` (default) | `tsvector` | `@@`, `@@@` |


Two important non-default opclasses ship with **contrib** extensions:

- `gin_trgm_ops` — the canonical answer for substring / `LIKE` / `ILIKE` / regex search on `text`. See [pg_trgm section](#pg_trgm-gin-vs-gist-trigram-opclasses).
- `gin_hstore_ops` — the default for `hstore` (cross-reference [`21-hstore.md`](./21-hstore.md)).
- `btree_gin` opclasses for scalar types — see [btree_gin section](#btree_gin-and-btree_gist-when-needed).


#### `jsonb_ops` vs `jsonb_path_ops`: pick on operator surface


- **`jsonb_ops`** (default) supports the full operator set: `@>`, `?`, `?|`, `?&`, `@?`, `@@`. Per-key indexing means key-existence (`?`) queries work.
- **`jsonb_path_ops`** indexes only the *root-to-leaf paths*, not the keys themselves. Smaller index. Faster `@>` queries — often substantially so. But `?`, `?|`, `?&` do **not** work because there is no per-key entry to consult.
- **The tie-break:** if your queries are 100% containment (`@>`), pick `jsonb_path_ops` — it's smaller and faster. The moment you need any of `?`, `?|`, `?&`, you're back to `jsonb_ops`.
- **Empty-object trap:** `jsonb_path_ops` produces no index entries for empty JSON structures (`{}` or `[]`). Already covered in detail in [`17-json-jsonb.md`](./17-json-jsonb.md).


### fastupdate and the pending list


GIN's per-row insert cost is high because each indexed row produces N index entries, and inserting each one requires walking and possibly modifying the outer B-tree. PG amortizes this with a **pending list**:

> Updating a GIN index tends to be slow because of the intrinsic nature of inverted indexes: inserting or updating one heap row can cause many inserts into the index (one for each key extracted from the indexed item). GIN is capable of postponing much of this work by inserting new tuples into a temporary, unsorted list of pending entries. When the table is vacuumed or autoanalyzed, or when `gin_clean_pending_list` function is called, or if the pending list becomes larger than `gin_pending_list_limit`, the entries are moved to the main GIN data structure using the same bulk insert techniques used during initial index creation.[^gin-implementation]


The trade-off, also from the docs:

> The main disadvantage of this approach is that searches must scan the list of pending entries in addition to searching the regular index, and so a large list of pending entries will slow searches significantly.[^gin-implementation]


Operationally:

- **`fastupdate = on` (default)** — write-friendly. Writes are fast (one append to pending list); reads pay a per-query scan of the pending list; periodic flushes (autovacuum, manual `gin_clean_pending_list()`, or list-size-exceeds-limit) are bulk-amortized but cause latency spikes.
- **`fastupdate = off`** — read-friendly. Every insert pays the full per-key cost. Reads are uniform. Use when search latency variance is unacceptable (e.g., user-facing queries that must complete in tight SLOs).
- **`gin_pending_list_limit`** (default 4 MB) — the per-index storage parameter / GUC threshold at which the next inserter is forced to flush. Larger = better write throughput, longer latency-spike duration when a flush hits.


To override per-index:

```sql
-- Build with fastupdate disabled (read-uniform)
CREATE INDEX events_payload_gin
  ON events USING GIN (payload jsonb_path_ops)
  WITH (fastupdate = off);

-- Or change a per-index pending list limit
ALTER INDEX events_payload_gin
  SET (gin_pending_list_limit = 16384);  -- 16 MB
```

Manual flush of the pending list:

```sql
SELECT gin_clean_pending_list('events_payload_gin'::regclass);
-- Returns the number of pages cleaned.
```


### GIN tuning GUCs


| GUC | Default | What it does |
|---|---|---|
| `gin_pending_list_limit` | `4MB` | Threshold for moving entries from pending list to main index; per-index `WITH` parameter overrides |
| `gin_fuzzy_search_limit` | `0` (no limit) | Soft upper bound on result rows for FTS queries — random subset returned past limit; useful for protecting users from "common word" disasters |
| `maintenance_work_mem` | `64MB` | The single most important knob for `CREATE INDEX` / `REINDEX` speed; the docs say *"Build time for a GIN index is very sensitive to the `maintenance_work_mem` setting; it doesn't pay to skimp on work memory during index creation."*[^gin-tips] Bump for index builds, return after. |


> [!NOTE] PostgreSQL 18
> GIN index builds can now run in parallel with `max_parallel_maintenance_workers > 0`. For large GIN builds (e.g., FTS over a multi-million-row corpus), this can cut wall-clock time substantially. Verbatim release-note quote: *"Allow GIN indexes to be created in parallel."*[^pg18-gin-parallel] `CREATE INDEX CONCURRENTLY` does **not** parallelize — same restriction as B-tree (cross-reference [`23-btree-indexes.md`](./23-btree-indexes.md) and [`26-index-maintenance.md`](./26-index-maintenance.md)).


### GIN extensibility (writing your own opclass)


For *most* readers this is irrelevant — the four built-in opclasses plus pg_trgm cover ~95% of practical GIN use. If you are implementing a custom GIN opclass for a custom data type, the support functions are[^gin-extensibility]:


| Function | Required? | Purpose |
|---|---|---|
| `extractValue(item, *nkeys, **nullFlags)` | required | Extract array of keys from an indexed value |
| `extractQuery(query, *nkeys, n, **pmatch, **extra_data, **nullFlags, *searchMode)` | required | Extract array of keys from a query value |
| `consistent(check[], n, query, nkeys, extra_data[], *recheck, queryKeys[], nullFlags[])` | required (or `triConsistent`) | Decide if an indexed item satisfies the query — boolean variant |
| `triConsistent(check[], n, query, nkeys, extra_data[], queryKeys[], nullFlags[])` | required (or `consistent`) | Three-valued (true/false/maybe) variant — usually preferred |
| `compare(a, b)` | required | Sort order between keys (used to build the outer B-tree) |
| `comparePartial(partial_key, key, n, extra_data)` | optional | Required only for partial-match queries (e.g., prefix search inside an array element) |
| `options(local_relopts *)` | optional | Define `WITH (...)` storage parameters for this opclass |


Cross-reference [`72-extension-development.md`](./72-extension-development.md) for the C-extension mechanics.


## GiST Mechanics


GiST is a balanced tree where each internal node carries a *predicate* (typically a bounding box, range, or signature) that holds for every entry in the subtree below it. A query operator either *certainly excludes* the subtree (don't descend), *certainly includes* it (return all entries below), or *might match* (descend and check). The verbatim positioning from the docs:

> GiST stands for Generalized Search Tree. It is a balanced, tree-structured access method, that acts as a base template in which to implement arbitrary indexing schemes. B-trees, R-trees and many other indexing schemes can be implemented in GiST.[^gist-intro]


Two consequences fall out of this design:

- **GiST is lossy by construction** — the bounding predicate is a summary, so the access method must recheck the heap row for every matching entry. PostGIS, range types, and pg_trgm `gist_trgm_ops` all live with this.
- **GiST supports ordering operators** — because the access method's `distance` support function can be ordered ascending, GiST natively supports `ORDER BY col <-> constant LIMIT N` (KNN) without a separate sort node. GIN cannot do this.


### Built-in GiST opclasses


PostgreSQL 16 ships with eight built-in GiST opclasses[^gist-builtin]:


| Opclass | Type | Indexable operators | Ordering operators (`<->`) |
|---|---|---|---|
| `box_ops` (default) | `box` | `<<`, `&<`, `&&`, `&>`, `>>`, `~=`, `@>`, `<@`, `&<|`, `<<|`, `|>>`, `|&>` | `<-> (box, point)` |
| `circle_ops` (default) | `circle` | Same family as `box_ops` | `<-> (circle, point)` |
| `inet_ops` | `inet`, `cidr` | `<<`, `<<=`, `>>`, `>>=`, `=`, `<>`, `<`, `<=`, `>`, `>=`, `&&` | none |
| `multirange_ops` (default) | `anymultirange` | `=`, `&&`, `@>`, `<@`, `<<`, `>>`, `&<`, `&>`, `-|-` (with anymultirange and anyrange operands) | none |
| `point_ops` (default) | `point` | `|>>`, `<<`, `>>`, `<<|`, `~=`, `<@` (point in box/polygon/circle) | `<-> (point, point)` |
| `poly_ops` (default) | `polygon` | Same family as `box_ops` | `<-> (polygon, point)` |
| `range_ops` (default) | `anyrange` | `=`, `&&`, `@>`, `<@`, `<<`, `>>`, `&<`, `&>`, `-|-` (with anyrange and anymultirange operands) | none |
| `tsquery_ops` (default) | `tsquery` | `<@`, `@>` | none |
| `tsvector_ops` (default) | `tsvector` | `@@ (tsvector, tsquery)` | none |


> [!WARNING]
> `inet_ops` is **not** the default opclass for `inet`/`cidr`. You must request it explicitly: `CREATE INDEX ON tbl USING gist (col inet_ops);`[^gist-inet] The reason is historical — `inet`/`cidr` columns are most often queried with B-tree-friendly equality and range operators. You'd reach for `inet_ops` specifically when you need network-containment operators (`<<`, `>>`, `<<=`, `>>=`).


Two important contrib opclasses:

- `gist_trgm_ops` (pg_trgm) for trigram similarity — see [pg_trgm section](#pg_trgm-gin-vs-gist-trigram-opclasses).
- `gist_hstore_ops` (hstore) — alternate to GIN for `hstore`, signature-lossy.

PostGIS adds GiST opclasses for `geometry` and `geography` — covered in [`95-postgis.md`](./95-postgis.md).


### KNN-GiST: distance-ordered search


Any GiST opclass that ships an ordering operator (above table) can answer `ORDER BY col <-> constant LIMIT N` queries by traversing the tree in distance order — no separate Sort node, no full scan, no buffering of the entire matching set. This is the **only** in-core mechanism for k-nearest-neighbor queries on geometric and pg_trgm-trigram data. (For embedding-vector KNN see [`94-pgvector.md`](./94-pgvector.md), which adds HNSW and IVFFLAT — not GiST under the hood, but conceptually solving the same problem.)


```sql
-- Find the 10 places nearest to a point
SELECT name, location <-> point '(101, 456)' AS dist
FROM places
ORDER BY location <-> point '(101, 456)'
LIMIT 10;
```

The `<->` in `ORDER BY` is what triggers the KNN traversal. EXPLAIN shows `Index Scan using places_location_idx` with the ordering pushed into the index node, no separate `Sort`.


### GiST extensibility (writing your own opclass)


GiST has a richer API than GIN. Eleven support functions, of which five are required and six optional[^gist-extensibility]:


| Function | Required? | Purpose |
|---|---|---|
| `consistent(entry, query, n, *recheck)` | required | True if a tree node *might* match the query — sets `recheck=true` if not exact |
| `union(entries[]) → predicate` | required | Combine N predicates into a single covering predicate (used at split + insert) |
| `penalty(orig, new) → float4` | required | Cost of inserting `new` into the subtree rooted at `orig` — drives "pick the smallest-penalty branch" insert |
| `picksplit(entries[], v) → split` | required | When a node overflows, partition entries into two groups |
| `same(a, b) → bool` | required | Equality test on predicates |
| `compress(item) → entry` | optional | Convert data item to in-index storage form |
| `decompress(entry) → item` | optional | Inverse of `compress` |
| `distance(entry, query, n, *recheck) → float8` | optional | Required for KNN ordering operators — distance from query to bounding predicate |
| `fetch(entry) → item` | optional | Required for **index-only scans** — retrieve original value from the index entry |
| `options(local_relopts *)` | optional | Define `WITH (...)` storage parameters (e.g., `siglen`) |
| `sortsupport(SortSupport)` | optional | Used by sorted index build (PG14+) — see next section |


> [!NOTE] PostgreSQL 14 and PostgreSQL 15
> PG14 added the **sorted build** path for GiST opclasses that supply a `sortsupport` function. Verbatim release-note quote: *"Allow some GiST indexes to be built by presorting the data (Andrey Borodin) ... Presorting happens automatically and allows for faster index creation and smaller indexes."*[^pg14-gist-sort] PG15 followed up with: *"Improve lookup performance of GiST indexes that were built using sorting (Aliaksandr Kalenik, Sergei Shoulbakov, Andrey Borodin)."*[^pg15-gist-sort] You don't have to opt in — if the opclass supports it, the build uses it automatically.


> [!NOTE] PostgreSQL 14
> **`compress` and `decompress` are no longer mandatory** for GiST opclasses. If you don't need a custom storage representation, omit them and the access method handles raw entries directly.[^gist-extensibility] This simplifies new opclass implementations significantly.


> [!NOTE] PostgreSQL 18
> A new GiST support function `stratnum()` was added (Paul A. Jungwirth).[^pg18-gist-stratnum] This allows opclasses to declare which strategy numbers they support, used by the planner for partition-key validation on non-btree unique indexes.


### Build methods (sorted vs buffering vs default)


GiST has three index-build paths, picked automatically:

1. **Sorted** — used when every opclass in the index supplies `sortsupport`. Verbatim docs: *"The sorted method is only available if each of the opclasses used by the index provides a `sortsupport` function ... If they do, this method is usually the best, so it is used by default."*[^gist-implementation] Fastest, smallest indexes.
2. **Buffering** — kicks in for large data without sortsupport. From the docs: *"If sorting is not possible, then by default a GiST index build switches to the buffering method when the index size reaches `effective_cache_size`."*[^gist-implementation] Trades CPU for less random I/O during build.
3. **Default (insert-each-row)** — small indexes, simple insertion. Used when neither sorted nor buffering is justified.

Manual override:

```sql
CREATE INDEX trips_route_gist
  ON trips USING gist (route)
  WITH (buffering = on);     -- force buffering build, useful for very large geometric indexes
```

Valid `buffering` values: `auto` (default), `on`, `off`. Setting `buffering = off` forces the insert-each-row path even on a large index — useful only for testing.


## EXCLUDE constraints with GiST


An exclusion constraint says: *"there must be no two rows where the listed predicates are simultaneously true."* The canonical use cases are non-overlapping ranges (room reservation, billing periods, employment intervals). Only GiST (and SP-GiST for some types) supports `EXCLUDE` because the access method must answer "does any existing row's predicate overlap mine?" — exactly the GiST operator surface.

```sql
-- Non-overlapping reservations per room
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- only needed because of `room WITH =`

CREATE TABLE reservation (
    id          bigint generated always as identity primary key,
    room        int      not null,
    period      tstzrange not null,
    EXCLUDE USING gist (
        room   WITH =,
        period WITH &&
    )
);
```

Two notes that bite real teams:

1. **`btree_gist` is required only when you mix B-tree-only operators (like `=`) with range/geometric operators in the same `EXCLUDE` clause.** A pure range-only EXCLUDE (`EXCLUDE USING gist (period WITH &&)`) needs no extension. The example above needs `btree_gist` because `room WITH =` uses B-tree-style equality.
2. **The constraint is enforced via a GiST index, with all of GiST's lossiness costs.** Inserting into a non-overlapping table with millions of rows pays per-insert log-N cost just like an index. Use partitioning by tenant or time bucket for very large datasets — see [`35-partitioning.md`](./35-partitioning.md).


## pg_trgm: GIN vs GiST trigram opclasses


Both `gin_trgm_ops` and `gist_trgm_ops` index `text` columns for similarity (`%`), substring (`LIKE '%foo%'`), case-insensitive (`ILIKE`), regex (`~`, `~*`), word-similarity (`<%`, `%>`, `<<%`, `%>>`), and equality (`=`).[^pgtrgm] The decision:


| Property | `gin_trgm_ops` | `gist_trgm_ops` |
|---|---|---|
| Storage | Larger (one entry per trigram per row) | Smaller (signature per row, default 12 bytes) |
| Search speed | Faster | Slower; lossy, requires recheck |
| Update cost | Slower; uses pending list (fastupdate) | Faster; one update per row |
| Distance ordering (`<->`) | **Not supported** | **Supported** |
| Tuning knobs | none documented | `siglen` (default 12, max 2024 bytes) |
| Default choice | **Yes for substring/ILIKE/regex** | **Only when you need `<->` ordering or storage matters** |


```sql
-- Substring/regex search (most common case)
CREATE INDEX docs_body_trgm
  ON docs USING gin (body gin_trgm_ops);

-- KNN-style "most similar" ordering — GiST is the only option
CREATE INDEX names_full_trgm
  ON people USING gist (full_name gist_trgm_ops);

SELECT full_name, full_name <-> 'Robert Smith' AS dist
FROM people
ORDER BY full_name <-> 'Robert Smith'
LIMIT 10;

-- Tune signature length when index size matters
CREATE INDEX names_full_trgm_long
  ON people USING gist (full_name gist_trgm_ops(siglen=64));
```

Cross-reference [`93-pg-trgm.md`](./93-pg-trgm.md) for the full pg_trgm operator surface, similarity threshold tuning (`pg_trgm.similarity_threshold`), and word-similarity operators.


## btree_gin and btree_gist (when needed)


Both contrib extensions exist for the **same** narrow purpose: they let GIN or GiST index scalar types (`int`, `text`, `timestamp`, etc.) so that a *multicolumn* GIN/GiST index can mix scalar columns with the access method's native types.

- **`btree_gin`** — *"for queries that test both a GIN-indexable column and a B-tree-indexable column, it might be more efficient to create a multicolumn GIN index that uses one of these operator classes than to create two separate indexes that would have to be combined via bitmap ANDing."*[^btree-gin] Supports `int2`/`int4`/`int8`/`float4`/`float8`/`timestamp[tz]`/`time[tz]`/`date`/`interval`/`oid`/`money`/`"char"`/`varchar`/`text`/`bytea`/`bit`/`varbit`/`macaddr`/`macaddr8`/`inet`/`cidr`/`uuid`/`name`/`bool`/`bpchar` and all enum types.
- **`btree_gist`** — same idea for GiST. Required when a GiST exclusion constraint mixes equality with range/geometric operators (the room-reservation example above). Also adds `<>` (not-equals) operator class and `<->` distance for several scalar types.


> [!WARNING]
> Don't reach for `btree_gin` to "speed up scalar equality with GIN" — it does not outperform a real B-tree. The docs are explicit: *"These operator classes will not outperform equivalent standard B-tree index methods, and they lack one major feature of the standard B-tree code: the ability to enforce uniqueness."*[^btree-gin] Use them only as the *secondary* columns of a multicolumn GIN/GiST index whose leading column is a "real" GIN/GiST type.


## Per-version timeline


| Version | Change | Footnote |
|---|---|---|
| PG14 | GiST presort build via `sortsupport` (faster build, smaller index) | [^pg14-gist-sort] |
| PG14 | SP-GiST gains `INCLUDE` columns | [^pg14-spgist-include] |
| PG14 | pg_trgm GIN/GiST opclasses gain equality (`=`) operator support | [^pg14-trgm-eq] |
| PG14 | pageinspect gains GiST inspection functions | [^pg14-pageinspect-gist] |
| PG14 | intarray containment (`@>`, `<@`) **no longer uses GiST** — heap scan is faster, drop those indexes | [^pg14-intarray] |
| PG14 | `compress`/`decompress` GiST support functions become optional | [^gist-extensibility] |
| PG15 | GiST sorted-build lookup performance improvement | [^pg15-gist-sort] |
| PG16 | GIN cost-accuracy improvement in the planner | [^pg16-gin-cost] |
| PG17 | GiST and SP-GiST indexes can be part of incremental sorts | [^pg17-gist-incremental] |
| PG18 | GIN indexes can be built in parallel | [^pg18-gin-parallel] |
| PG18 | GiST range-type and B-tree builds use sorting to speed up | [^pg18-gist-sorted] |
| PG18 | GiST gains `stratnum()` support function | [^pg18-gist-stratnum] |


## Inspection with pageinspect


The `pageinspect` extension lets you look directly inside GIN and GiST pages — invaluable for diagnosing why an index is much larger than expected, what's actually in the pending list, or whether posting trees have grown out of control.[^pageinspect]


### GIN pageinspect functions


| Function | Returns |
|---|---|
| `gin_metapage_info(page bytea)` | Pending list size, total pages, entry pages, version |
| `gin_page_opaque_info(page bytea)` | rightlink, maxoff, page-type flags (data/leaf/compressed) |
| `gin_leafpage_items(page bytea)` | first_tid, nbytes, list of TIDs in the leaf |


### GiST pageinspect functions


| Function | Returns |
|---|---|
| `gist_page_opaque_info(page bytea)` | LSN, NSN, rightlink, page-type flags |
| `gist_page_items(page bytea, index_oid regclass)` | itemoffset, ctid, itemlen, dead status, decoded keys |
| `gist_page_items_bytea(page bytea)` | Same as above but raw bytea — no opclass-decode needed |


Example — inspect the metapage of a GIN index to see pending-list size:

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;

SELECT *
FROM gin_metapage_info(get_raw_page('events_payload_gin', 0));
-- pending_head, pending_tail, pending_tail_free_size,
-- n_pending_pages, n_pending_tuples, n_total_pages,
-- n_entry_pages, n_data_pages, n_entries, version
```

If `n_pending_tuples` is climbing into the tens of thousands and search latency is suffering, manually flush:

```sql
SELECT gin_clean_pending_list('events_payload_gin'::regclass);
```


## Examples / Recipes


### Recipe 1: Baseline JSONB GIN index, jsonb_path_ops + maintenance plan

The 80% case for a JSONB column whose primary access pattern is `WHERE payload @> '...'`:

```sql
CREATE TABLE events (
    id           bigint generated always as identity primary key,
    received_at  timestamptz not null default clock_timestamp(),
    payload      jsonb not null
);

-- Smaller, faster than the default jsonb_ops because we only need @>
CREATE INDEX events_payload_gin
  ON events USING gin (payload jsonb_path_ops);

-- Confirm the planner uses the index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM events
WHERE payload @> '{"type":"order.created"}';
-- Bitmap Index Scan on events_payload_gin
--   Index Cond: (payload @> '{"type": "order.created"}'::jsonb)
```

If a separate query needs `payload ? 'session_id'`, you'll need a *second* index using `jsonb_ops` (or a B-tree on the hoisted scalar — see Recipe 7).


### Recipe 2: FTS GIN index with a generated tsvector column

Cross-references [`20-text-search.md`](./20-text-search.md) Recipe 1 — the canonical baseline:

```sql
CREATE TABLE articles (
    id     bigint generated always as identity primary key,
    title  text not null,
    body   text not null,
    doc_tsv tsvector
        GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(body,  '')), 'B')
        ) STORED
);

CREATE INDEX articles_doc_gin
  ON articles USING gin (doc_tsv);

SELECT id, ts_rank(doc_tsv, q) AS rank
FROM articles, websearch_to_tsquery('english', $1) q
WHERE doc_tsv @@ q
ORDER BY rank DESC
LIMIT 10;
```


### Recipe 3: Tag column with GIN array_ops

```sql
CREATE TABLE products (
    id    bigint generated always as identity primary key,
    name  text not null,
    tags  text[] not null default '{}'
);

CREATE INDEX products_tags_gin
  ON products USING gin (tags);

-- Find products that have ALL of these tags
SELECT id, name FROM products WHERE tags @> ARRAY['sale', 'featured'];

-- Find products that have ANY of these tags
SELECT id, name FROM products WHERE tags && ARRAY['clearance', 'discontinued'];
```


### Recipe 4: Non-overlapping time ranges via GiST EXCLUDE

The canonical "no two reservations for the same room can overlap":

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE reservation (
    id     bigint generated always as identity primary key,
    room   int not null,
    period tstzrange not null,
    EXCLUDE USING gist (
        room   WITH =,
        period WITH &&
    )
);

-- Insert 1: succeeds
INSERT INTO reservation (room, period)
VALUES (101, '[2026-06-01 09:00, 2026-06-01 10:00)');

-- Insert 2: conflicts with the same room — raises exclusion_violation
INSERT INTO reservation (room, period)
VALUES (101, '[2026-06-01 09:30, 2026-06-01 11:00)');
-- ERROR:  conflicting key value violates exclusion constraint
```


### Recipe 5: KNN nearest-neighbor with point GiST

```sql
CREATE TABLE places (
    id       bigint generated always as identity primary key,
    name     text not null,
    location point not null
);

-- Default opclass for point is point_ops, which supports <->
CREATE INDEX places_location_gist ON places USING gist (location);

-- 10 nearest places to a query point
SELECT name, location <-> point '(101, 456)' AS dist
FROM places
ORDER BY location <-> point '(101, 456)'
LIMIT 10;
-- EXPLAIN should show: Index Scan using places_location_gist
--   Order By: (location <-> '(101,456)'::point)
-- (no Sort node — KNN traversal pushed into the index)
```

For the same workload on lat/lon coordinates use PostGIS `geography(Point, 4326)` and `<->` over a `gist(geography_col)` — see [`95-postgis.md`](./95-postgis.md).


### Recipe 6: Substring search with pg_trgm GIN

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE customers (
    id    bigint generated always as identity primary key,
    email text not null
);

CREATE INDEX customers_email_trgm
  ON customers USING gin (email gin_trgm_ops);

-- Substring matching — would be a full table scan without the GIN+pg_trgm index
SELECT id, email FROM customers WHERE email LIKE '%example.com';

-- Case-insensitive
SELECT id, email FROM customers WHERE email ILIKE '%@gmail%';

-- Similarity (trigram %) — pulls visually-similar matches
SET pg_trgm.similarity_threshold = 0.4;
SELECT id, email FROM customers WHERE email % 'jhon@example.com';
```


### Recipe 7: Hot scalar field hoisted alongside whole-jsonb GIN

JSONB GIN is great for arbitrary containment but bad for hot scalar lookups. Pair it with a generated B-tree column on the hot field:

```sql
CREATE TABLE events (
    id           bigint generated always as identity primary key,
    payload      jsonb not null,
    -- Hoist the hot scalar
    event_type   text generated always as (payload->>'type') stored
);

-- Whole-document containment queries
CREATE INDEX events_payload_gin
  ON events USING gin (payload jsonb_path_ops);

-- Cheap equality lookup on event_type
CREATE INDEX events_event_type_btree
  ON events (event_type);

-- Each query uses the right index automatically
SELECT * FROM events WHERE event_type = 'order.created';            -- B-tree
SELECT * FROM events WHERE payload @> '{"customer_id": 12345}';     -- GIN
```


### Recipe 8: Audit query — find every GIN/GiST index in a database

```sql
SELECT
    n.nspname            AS schema,
    c.relname            AS index_name,
    t.relname            AS table_name,
    am.amname            AS access_method,
    pg_size_pretty(pg_relation_size(c.oid)) AS index_size,
    array_agg(opc.opcname ORDER BY a.attnum) AS opclasses
FROM   pg_index i
JOIN   pg_class c   ON c.oid = i.indexrelid
JOIN   pg_class t   ON t.oid = i.indrelid
JOIN   pg_namespace n ON n.oid = c.relnamespace
JOIN   pg_am am     ON am.oid = c.relam
JOIN   pg_attribute a ON a.attrelid = c.oid
LEFT JOIN unnest(i.indclass) WITH ORDINALITY AS u(opcoid, ord) ON u.ord = a.attnum
LEFT JOIN pg_opclass opc ON opc.oid = u.opcoid
WHERE  am.amname IN ('gin', 'gist')
  AND  n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP  BY n.nspname, c.relname, t.relname, am.amname, c.oid
ORDER  BY pg_relation_size(c.oid) DESC;
```



### Recipe 9: Diagnose GIN pending-list bloat

```sql
-- Quick check: what's in the metapage of a heavily-written GIN?
CREATE EXTENSION IF NOT EXISTS pageinspect;

SELECT
    n_pending_pages,
    n_pending_tuples,
    n_total_pages,
    n_entries
FROM gin_metapage_info(get_raw_page('events_payload_gin', 0));

-- If n_pending_tuples is high (tens of thousands+) and search latency suffers,
-- flush manually:
SELECT gin_clean_pending_list('events_payload_gin'::regclass);
-- Returns the number of pages cleaned.

-- Long-term: turn fastupdate off, or shrink the limit
ALTER INDEX events_payload_gin SET (gin_pending_list_limit = 1024);  -- 1 MB

-- Or, accept the variance:
ALTER INDEX events_payload_gin SET (fastupdate = off);  -- read-uniform
```


### Recipe 10: Enable parallel GIN build for large initial loads (PG18+)

```sql
-- PG18+ — parallel GIN builds (CONCURRENTLY still serial)
SET max_parallel_maintenance_workers = 4;
SET maintenance_work_mem = '2GB';
CREATE INDEX docs_body_gin ON docs USING gin (body_tsv);

-- Verify with EXPLAIN-style status during build:
SELECT pid, phase, blocks_done, blocks_total
FROM pg_stat_progress_create_index;
```


### Recipe 11: GiST sorted vs buffering build for a very large geometric column

```sql
-- For an opclass with sortsupport (PG14+), the sorted build is automatic and best.
CREATE INDEX trips_origin_gist ON trips USING gist (origin);

-- For an opclass without sortsupport, the planner will switch to buffering at
-- effective_cache_size. Force it for testing on a smaller dataset:
CREATE INDEX trips_route_gist ON trips USING gist (route)
WITH (buffering = on);

-- Verify build progress
SELECT pid, phase, tuples_done, tuples_total
FROM pg_stat_progress_create_index;
```


### Recipe 12: Choose `jsonb_path_ops` deliberately — measure both

Before committing to one opclass for the long term, build both and measure on representative data:

```sql
-- Build both side-by-side on the same data
CREATE INDEX events_payload_default ON events USING gin (payload);          -- jsonb_ops
CREATE INDEX events_payload_pathops ON events USING gin (payload jsonb_path_ops);

-- Compare sizes
SELECT
    indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan
FROM pg_stat_user_indexes
WHERE indexrelname IN ('events_payload_default', 'events_payload_pathops');

-- Compare plans for the dominant query
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM events WHERE payload @> '{"type":"checkout"}';

-- Drop the loser
DROP INDEX events_payload_default;  -- if jsonb_path_ops won
```

Typical outcome: `jsonb_path_ops` is 25–50% smaller, scans 30–60% faster on `@>` queries — but completely unusable for `?`/`?|`/`?&`. Pick on operator surface, not on size alone.


## Gotchas / Anti-patterns


1. **GIN for low-cardinality scalar equality is overhead, not speedup.** A B-tree on `status text` will outperform a GIN with `btree_gin`'s `text_ops` for `WHERE status = 'pending'`. `btree_gin` exists to mix scalars into a *multicolumn* GIN where the leading column is GIN-native — not as a single-column scalar index.

2. **GiST is lossy and must recheck the heap.** Every match returned from a GiST scan is rechecked against the heap row, even when the predicate is exact for the data type. This is structural — the access method's `consistent` function returns `recheck=true` whenever the bounding predicate cannot guarantee an exact match. Long index scans on highly-selective predicates can pay surprising heap-fetch overhead.

3. **`fastupdate=on` causes search-latency variance.** Reads scan the pending list synchronously; periodic flushes cause latency spikes. See §fastupdate and the pending list above. Set `fastupdate=off` for tight latency SLOs.

4. **`gin_clean_pending_list()` requires `MAINTAIN` (PG17+) or table-owner privileges.** Cannot be called by a regular user. If you need it as part of a scheduled job, either run as a privileged role or grant `MAINTAIN` on the index's table to the job role.

5. **`jsonb_path_ops` is silently empty for `{}` and `[]`.** Already covered in [`17-json-jsonb.md`](./17-json-jsonb.md) gotcha #12. The opclass produces no index entries for empty containers, so a `WHERE payload @> '{}'` (which matches everything) returns from the index but rows with empty payloads are missed.

6. **`inet_ops` is not the default.** A bare `CREATE INDEX ON tbl USING gist (ip);` produces an empty opclass list and fails. You must say `gist (ip inet_ops)` to get the network-containment index.[^gist-inet]

7. **GiST `<->` ordering with a `LIMIT` is the only fast path** — without `LIMIT`, the planner often picks a sequential scan because the KNN traversal cost dominates without an early stop.

8. **`EXCLUDE USING gist` is enforced via a normal GiST index** — it has all the per-insert costs of a regular GiST insert, including the buffering or sorted build. For very high-write tables consider partitioning or a deferred-checking pattern.

9. **`btree_gist` is required only for mixed-operator EXCLUDE constraints** — pure-range (`EXCLUDE USING gist (period WITH &&)`) does not need it; `EXCLUDE USING gist (room WITH =, period WITH &&)` does.

10. **`pg_trgm` `gist_trgm_ops` indexes are signature-lossy with default 12-byte signatures** — small datasets see acceptable false-positive rates; large datasets need `siglen=64` or higher (max 2024). Larger signatures = larger index = lower false-positive rate.

11. **Multicolumn GIN is rare and almost always wrong.** A multi-column GIN index where each column has a different opclass is supported but performs badly. Prefer separate single-column GINs and let the planner combine via `BitmapAnd`/`BitmapOr` — the bitmap-combination cost is usually less than the single-multicolumn maintenance cost.

12. **GiST opclasses without `fetch` cannot do index-only scans.** The default opclasses for `point`, `box`, `polygon` etc. mostly support `fetch` for index-only scans on the geometric type itself; pg_trgm's `gist_trgm_ops` does not because the signature is lossy. Cross-reference [`23-btree-indexes.md`](./23-btree-indexes.md) on the index-only-scan visibility-map prerequisite.

13. **`maintenance_work_mem` matters enormously for GIN builds.** Bump to `1GB`–`4GB` during initial loads or `REINDEX`. See §GIN tuning GUCs above for the full quote.[^gin-tips]

14. **`maintenance_work_mem` does not help GiST builds.** GiST is sortsupport-driven (PG14+) or buffering-driven, not in-memory-work-driven. Memory still helps the buffering path's I/O patterns but the relationship is far less direct.

15. **PG14 removed intarray's GiST containment opclass support.** *"Prevent the containment operators (`<@` and `@>`) for intarray from using GiST indexes."*[^pg14-intarray] Indexes created for that purpose should be dropped — they no longer help and just cost writes.

16. **`CREATE INDEX CONCURRENTLY` does not parallelize even on PG18.** Same restriction as B-tree — the parallel GIN build path requires the non-concurrent form. Plan for a maintenance window when parallel speedup matters.

17. **`pg_trgm` similarity threshold is a session GUC** (`pg_trgm.similarity_threshold`, default 0.3) — not a per-index property. Setting it differently per backend can change which indexes the planner picks.

18. **Postingtree spillover is silent**. A GIN key that gradually accumulates many TIDs (e.g., a JSONB key present in 30%+ of rows) silently transitions from inline posting list to spilled posting tree. The transition is invisible operationally but each posting-tree match adds I/O. Monitor with `pageinspect` and consider a `WHERE` clause on the index (partial GIN) to exclude high-frequency keys.

19. **GiST ordering operators only work with the operator class's specific argument types.** `<-> (point, point)` works; `<-> (box, point)` works; `<-> (point, box)` does not — the operand order matters and matches the opclass row exactly.

20. **`gist_trgm_ops` requires `pg_trgm` extension to be installed**, even though `gin_trgm_ops` and `gist_trgm_ops` are referred to together in documentation. Both ship in the `pg_trgm` contrib module.

21. **GIN indexes on small tables can be slower than seq scan** — because the per-search overhead (scan pending list, walk outer B-tree, fetch posting list/tree) is fixed and only amortized over many matches. Heuristic: skip GIN if your table is under ~10,000 rows and lookup queries return >10% of rows.

22. **`enable_seqscan = off` is not a fix** for GIN/GiST plan selection — the planner's cost estimates for these access methods improved in PG16 (GIN cost-accuracy fix[^pg16-gin-cost]). If queries pick seqscan when you expect GIN, run `ANALYZE` on the table and check for skewed `pg_stats` row counts.


## See Also


- [`22-indexes-overview.md`](./22-indexes-overview.md) — picker file routing predicate shapes across all 7 access methods
- [`23-btree-indexes.md`](./23-btree-indexes.md) — B-tree internals (deduplication, bottom-up deletion, INCLUDE, skip scan)
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — SP-GiST is structurally similar to GiST but partitioning-based; covered there
- [`26-index-maintenance.md`](./26-index-maintenance.md) — CREATE INDEX CONCURRENTLY, REINDEX, bloat detection
- [`16-arrays.md`](./16-arrays.md) — `array_ops` is the default GIN opclass for `T[]`
- [`17-json-jsonb.md`](./17-json-jsonb.md) — `jsonb_ops` vs `jsonb_path_ops` decision deep dive
- [`20-text-search.md`](./20-text-search.md) — `tsvector_ops` for FTS and the `ts_rank` filter-vs-rank pattern
- [`21-hstore.md`](./21-hstore.md) — `gin_hstore_ops` and `gist_hstore_ops`
- [`15-data-types-custom.md`](./15-data-types-custom.md) — `range_ops` and `multirange_ops` ship with the corresponding range types; EXCLUDE constraints leverage GiST
- [`93-pg-trgm.md`](./93-pg-trgm.md) — full `pg_trgm` operator surface, similarity tuning
- [`94-pgvector.md`](./94-pgvector.md) — embedding-vector KNN using HNSW/IVFFLAT (not GiST under the hood, but solving the same KNN problem for high-dimensional vectors)
- [`95-postgis.md`](./95-postgis.md) — PostGIS spatial opclasses on GiST and SP-GiST
- [`56-explain.md`](./56-explain.md) — reading `Bitmap Index Scan`, `Recheck Cond`, `Heap Fetches`
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum's role in flushing the GIN pending list
- [`72-extension-development.md`](./72-extension-development.md) — implementing custom GIN/GiST opclasses in C
- [`37-constraints.md`](./37-constraints.md) — EXCLUDE constraint syntax and semantics
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_opclass`, `pg_am`, `pg_amop`, `pg_amproc` for opclass introspection


## Sources


[^gin-implementation]: PostgreSQL 16 Manual, GIN Implementation. *"Internally, a GIN index contains a B-tree index constructed over keys, where each key is an element of one or more indexed items (a member of an array, for example) and where each tuple in a leaf page contains either a pointer to a B-tree of heap pointers (a 'posting tree'), or a simple list of heap pointers (a 'posting list') when the list is small enough to fit into a single index tuple along with the key value."* Also: *"Updating a GIN index tends to be slow because of the intrinsic nature of inverted indexes ... GIN is capable of postponing much of this work by inserting new tuples into a temporary, unsorted list of pending entries."* https://www.postgresql.org/docs/16/gin-implementation.html

[^gin-builtin]: PostgreSQL 16 Manual, GIN Built-in Operator Classes (Table 70.1). https://www.postgresql.org/docs/16/gin-builtin-opclasses.html

[^gin-extensibility]: PostgreSQL 16 Manual, GIN Extensibility — `extractValue`, `extractQuery`, `consistent`, `triConsistent`, `compare`, `comparePartial`, `options`. https://www.postgresql.org/docs/16/gin-extensibility.html

[^gin-tips]: PostgreSQL 16 Manual, GIN Tips. *"Build time for a GIN index is very sensitive to the `maintenance_work_mem` setting; it doesn't pay to skimp on work memory during index creation."* Also covers `gin_pending_list_limit` and `gin_fuzzy_search_limit`. https://www.postgresql.org/docs/16/gin-tips.html

[^gin-fts-preferred]: PostgreSQL 16 Manual, Text Search GIN and GiST Index Types. *"GIN indexes are the preferred text search index type."* https://www.postgresql.org/docs/16/textsearch-indexes.html

[^textsearch-indexes]: PostgreSQL 16 Manual, Text Search Indexes — comparison of GIN (lossless, larger, slower updates) vs GiST (lossy with default 124-byte signatures up to 2024 bytes, requires recheck). *"The index might produce false matches, and it is necessary to check the actual table row to eliminate such false matches."* https://www.postgresql.org/docs/16/textsearch-indexes.html

[^gist-intro]: PostgreSQL 16 Manual, GiST Introduction. *"GiST stands for Generalized Search Tree. It is a balanced, tree-structured access method, that acts as a base template in which to implement arbitrary indexing schemes. B-trees, R-trees and many other indexing schemes can be implemented in GiST."* https://www.postgresql.org/docs/16/gist-intro.html

[^gist-builtin]: PostgreSQL 16 Manual, GiST Built-in Operator Classes (Table 68.1) — `box_ops`, `circle_ops`, `inet_ops`, `multirange_ops`, `point_ops`, `poly_ops`, `range_ops`, `tsquery_ops`, `tsvector_ops`. https://www.postgresql.org/docs/16/gist-builtin-opclasses.html

[^gist-inet]: PostgreSQL 16 Manual, GiST Built-in Operator Classes — *"For historical reasons, the `inet_ops` operator class is not the default class for types `inet` and `cidr`. To use it, mention the class name in `CREATE INDEX`, for example `CREATE INDEX ON my_table USING GIST (my_inet_column inet_ops);`"* https://www.postgresql.org/docs/16/gist-builtin-opclasses.html

[^gist-extensibility]: PostgreSQL 16 Manual, GiST Extensibility. Lists required (`consistent`, `union`, `penalty`, `picksplit`, `same`) and optional (`compress`, `decompress`, `distance`, `fetch`, `options`, `sortsupport`) support functions. *"compress and decompress are no longer mandatory."* https://www.postgresql.org/docs/16/gist-extensibility.html

[^gist-implementation]: PostgreSQL 16 Manual, GiST Implementation, Build Methods — *"The sorted method is only available if each of the opclasses used by the index provides a `sortsupport` function ... If they do, this method is usually the best, so it is used by default."* and *"If sorting is not possible, then by default a GiST index build switches to the buffering method when the index size reaches `effective_cache_size`."* https://www.postgresql.org/docs/16/gist-implementation.html

[^pageinspect]: PostgreSQL 16 Manual, pageinspect — `gin_metapage_info`, `gin_page_opaque_info`, `gin_leafpage_items`, `gist_page_opaque_info`, `gist_page_items`, `gist_page_items_bytea`. https://www.postgresql.org/docs/16/pageinspect.html

[^pgtrgm]: PostgreSQL 16 Manual, pg_trgm. `gin_trgm_ops` and `gist_trgm_ops`. `gist_trgm_ops` accepts the optional `siglen` integer storage parameter (default 12 bytes, max 2024 bytes); larger signatures are more precise at the cost of larger indexes. https://www.postgresql.org/docs/16/pgtrgm.html

[^btree-gin]: PostgreSQL 16 Manual, btree_gin. *"For queries that test both a GIN-indexable column and a B-tree-indexable column, it might be more efficient to create a multicolumn GIN index that uses one of these operator classes than to create two separate indexes that would have to be combined via bitmap ANDing."* Also: *"These operator classes will not outperform equivalent standard B-tree index methods, and they lack one major feature of the standard B-tree code: the ability to enforce uniqueness."* https://www.postgresql.org/docs/16/btree-gin.html

[^btree-gist]: PostgreSQL 16 Manual, btree_gist. Adds B-tree-equivalent operators plus `<>` (not-equals) plus `<->` distance for many scalar types. Required for EXCLUDE constraints that mix equality with range/geometric operators. https://www.postgresql.org/docs/16/btree-gist.html

[^pg14-gist-sort]: PostgreSQL 14 release notes — *"Allow some GiST indexes to be built by presorting the data (Andrey Borodin) ... Presorting happens automatically and allows for faster index creation and smaller indexes."* https://www.postgresql.org/docs/release/14.0/

[^pg14-spgist-include]: PostgreSQL 14 release notes — *"Allow SP-GiST indexes to contain `INCLUDE`'d columns (Pavel Borisov)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-trgm-eq]: PostgreSQL 14 release notes — *"Allow GiST/GIN pg_trgm indexes to do equality lookups (Julien Rouhaud). This is similar to LIKE except no wildcards are honored."* https://www.postgresql.org/docs/release/14.0/

[^pg14-pageinspect-gist]: PostgreSQL 14 release notes — *"Allow pageinspect to inspect GiST indexes (Andrey Borodin, Heikki Linnakangas)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-intarray]: PostgreSQL 14 release notes (Migration to Version 14, Incompatibilities) — *"Prevent the containment operators (`<@` and `@>`) for intarray from using GiST indexes (Tom Lane). Previously a full GiST index scan was required, so just avoid that and scan the heap, which is faster. Indexes created for this purpose should be removed."* https://www.postgresql.org/docs/release/14.0/

[^pg15-gist-sort]: PostgreSQL 15 release notes — *"Improve lookup performance of GiST indexes that were built using sorting (Aliaksandr Kalenik, Sergei Shoulbakov, Andrey Borodin)."* https://www.postgresql.org/docs/release/15.0/

[^pg16-gin-cost]: PostgreSQL 16 release notes — *"Improve the accuracy of GIN index access optimizer costs (Ronan Dunklau)."* https://www.postgresql.org/docs/release/16.0/

[^pg17-gist-incremental]: PostgreSQL 17 release notes — *"Allow GiST and SP-GiST indexes to be part of incremental sorts (Miroslav Bendik). This is particularly useful for ORDER BY clauses where the first column has a GiST and SP-GiST index, and other columns do not."* https://www.postgresql.org/docs/release/17.0/

[^pg18-gin-parallel]: PostgreSQL 18 release notes — *"Allow GIN indexes to be created in parallel (Tomas Vondra, Matthias van de Meent)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-gist-sorted]: PostgreSQL 18 release notes — *"Allow values to be sorted to speed range-type GiST and btree index builds (Bernd Helmle)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-gist-stratnum]: PostgreSQL 18 release notes — *"Add GiST support function `stratnum()` (Paul A. Jungwirth)."* https://www.postgresql.org/docs/release/18.0/

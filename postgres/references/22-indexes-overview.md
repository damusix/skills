# Indexes — Overview and Picker


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix — Picking an Index Type](#decision-matrix--picking-an-index-type)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The Seven Index Access Methods](#the-seven-index-access-methods)
    - [Type Comparison Table](#type-comparison-table)
    - [CREATE INDEX Grammar](#create-index-grammar)
    - [Operator Classes](#operator-classes)
    - [Multicolumn Indexes](#multicolumn-indexes)
    - [Partial Indexes](#partial-indexes)
    - [Expression Indexes](#expression-indexes)
    - [INCLUDE (Covering) Indexes](#include-covering-indexes)
    - [Index-Only Scans](#index-only-scans)
    - [Ordering: ASC/DESC and NULLS FIRST/LAST](#ordering-ascdesc-and-nulls-firstlast)
    - [Unique Indexes and NULLS NOT DISTINCT (PG15+)](#unique-indexes-and-nulls-not-distinct-pg15)
    - [Combining Indexes via Bitmap](#combining-indexes-via-bitmap)
    - [Collations and Indexes](#collations-and-indexes)
- [Version History At A Glance](#version-history-at-a-glance)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file when:

- You are designing a schema and need to pick an index type for a new column
- A query is slow and you suspect the wrong index type, the wrong opclass, or the wrong column order
- You are auditing an existing schema for redundant / unused / wrong-shape indexes
- You need the seven-way decision matrix that routes you to the deep-dive file for the index type you actually want

This file is the **picker** — it is intentionally light on internals. Once you have decided which access method you need, follow the See Also section to the dedicated reference:

- B-tree internals (deduplication PG13+, bottom-up deletion PG14+, fillfactor, skip scan PG18+) → [`23-btree-indexes.md`](./23-btree-indexes.md)
- GIN and GiST (posting lists, fastupdate, exclusion constraints, KNN, opclass selection) → [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)
- BRIN, Hash, SP-GiST, Bloom → [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md)
- `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, bloat, pg_repack → [`26-index-maintenance.md`](./26-index-maintenance.md)


## Mental Model

Five rules. Internalize these and almost every "which index?" question routes correctly.

1. **B-tree is the default and answers more than you think.** Equality, range, `IN`, `IS NULL`, sort-avoidance, uniqueness, and most pattern matches that begin with a literal prefix. *"B-trees can handle equality and range queries on data that can be sorted into some ordering."*[^types] Reach for a non-B-tree access method only when B-tree provably cannot serve the predicate.

2. **An index accelerates a *predicate*, not a column.** The same column can need different indexes for different predicates: `LIKE 'prefix%'` wants B-tree with `text_pattern_ops` (or default `text_ops` under the C collation); `LIKE '%middle%'` wants GIN with `gin_trgm_ops`; full-text search wants GIN on `tsvector`; range overlap wants GiST. List the *predicates your workload runs* and pick an access method per predicate family.

3. **Multicolumn B-tree indexes work best with constraints on the leading columns.** *"A multicolumn B-tree index can be used with query conditions that involve any subset of the index's columns, but the index is most efficient when there are constraints on the leading (leftmost) columns."*[^multi] PG18 relaxes this with *skip scan*[^pg18-skip], but skip scan is still slower than putting the high-selectivity column first.

4. **Indexes cost writes, RAM, and disk.** *"Indexes can also prevent the creation of heap-only tuples. Therefore indexes that are seldom or never used in queries should be removed."*[^intro] Every index slows `INSERT`/`UPDATE`/`DELETE` on the indexed columns and consumes shared buffers. The break-even is workload-specific; track unused indexes via `pg_stat_user_indexes.idx_scan` and remove them.

5. **Index-only scan is the cheapest scan, but it requires the visibility map to be current.** Add `INCLUDE (...)` columns to a B-tree (PG11+)[^pg11-include] when a hot read query needs a few extra columns alongside an indexed lookup, and keep VACUUM healthy on those tables. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the visibility-map mechanics.


## Decision Matrix — Picking an Index Type

Read your predicate, find the row, follow the link to the deep-dive file. Where two rows could apply, the **upper row is the recommended default**.

| Predicate shape | Use | Avoid | Why |
|---|---|---|---|
| `=`, `<`, `<=`, `>=`, `>`, `BETWEEN`, `IN`, `IS NULL`, sort-avoidance, uniqueness on scalar | B-tree (default) | Hash | B-tree handles all of these; hash handles only `=` and historically had other drawbacks |
| `=` only, want a marginally smaller index for a single very wide column | Hash[^hash-walogged] | B-tree | Niche. B-tree handles `=` fine. Only consider hash for very wide columns where the 32-bit hash is materially smaller than the value |
| `LIKE 'prefix%'` on `text` under non-C collation | B-tree with `text_pattern_ops` opclass | Default B-tree | *"The operator classes `text_pattern_ops`, `varchar_pattern_ops`, and `bpchar_pattern_ops` support B-tree indexes on the types `text`, `varchar`, and `char` respectively. The difference from the default operator classes is that the values are compared strictly character by character rather than according to the locale-specific collation rules."*[^opclass] |
| `LIKE '%middle%'`, `ILIKE`, fuzzy / similarity, regex | GIN with `pg_trgm` (`gin_trgm_ops`) | LIKE | GIN trigram is the only way to index a substring anywhere. See [`93-pg-trgm.md`](./93-pg-trgm.md) |
| Full-text search (`tsvector @@ tsquery`) | GIN on `tsvector` (default opclass) | GiST | GIN is preferred for FTS. See [`20-text-search.md`](./20-text-search.md) and [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) |
| JSONB containment `@>` only | GIN with `jsonb_path_ops` | Default GIN | Smaller, faster for the `@>` case at the cost of dropping `?`/`?&`/`?|` support |
| JSONB `@>`, `?`, `?&`, `?|` | GIN with default `jsonb_ops` | jsonb_path_ops | The default supports all four operators; `jsonb_path_ops` supports only `@>` |
| Array membership / overlap `@>`, `<@`, `&&` | GIN with `array_ops` | B-tree | B-tree only handles whole-array equality |
| Range / multirange overlap, containment, adjacency | GiST (or SP-GiST for SP-GiST-supported range types) | GIN | GIN does not have range opclasses; GiST does |
| Nearest-neighbor / KNN (`ORDER BY col <-> point LIMIT N`) | GiST or SP-GiST with distance opclass | B-tree | Only GiST/SP-GiST can drive `ORDER BY distance` from the index |
| Vector similarity (embedding search) | HNSW (default) or IVFFLAT via pgvector | GiST | See [`94-pgvector.md`](./94-pgvector.md) |
| Geometric / spatial predicates | GiST (PostGIS) or SP-GiST for non-overlapping data | — | See [`95-postgis.md`](./95-postgis.md) |
| Very large, append-only or naturally clustered (time-series, log) where blocks correlate with values | BRIN with `minmax` or `minmax_multi`[^pg14-brin-multi] | B-tree | BRIN is 1000× smaller than B-tree on the same table; works only when physical order tracks indexed value |
| Multi-attribute equality where any combination of columns might appear in the predicate | Bloom (contrib) | One B-tree per column | *"This type of index is most useful when a table has many attributes and queries test arbitrary combinations of them."*[^bloom] Beware: lossy and equality-only |
| Exclusion constraint (e.g., no overlapping reservations) | GiST `EXCLUDE USING gist (...)` | App-level locks | See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) and [`37-constraints.md`](./37-constraints.md) |
| Unique within a subset of rows (soft-delete, multi-tenant) | Partial unique B-tree | Application-side uniqueness check | See [Recipe 6](#examples--recipes) below |
| Computed value or function output (`lower(email)`, `date_trunc('day', ts)`) | Expression index on B-tree (usually) | Trigger-maintained shadow column | See [Recipe 5](#examples--recipes) |

Three smell signals for wrong index choice:

1. You added a multicolumn index where the leading column has only 2–3 distinct values. Move the high-cardinality column to the front, or use a partial index on each value of the leading column, or use Bloom if every column is roughly the same selectivity.
2. You added a GIN index for `=` and you saw no improvement. GIN's per-tuple overhead dominates B-tree for simple equality; that workload wants B-tree.
3. You added a B-tree on a `jsonb` column. B-tree on `jsonb` indexes the binary value; it accelerates `=` and `<` on the whole document, not on any contained value. You almost certainly wanted GIN.


## Syntax / Mechanics

### The Seven Index Access Methods

Six built-in access methods plus one contrib module:

| Method | `USING` keyword | Built-in / contrib | Locks during build (without `CONCURRENTLY`) |
|---|---|---|---|
| B-tree | `btree` (default) | built-in | `SHARE` on table |
| Hash | `hash` | built-in | `SHARE` on table |
| GiST | `gist` | built-in | `SHARE` on table |
| SP-GiST | `spgist` | built-in | `SHARE` on table |
| GIN | `gin` | built-in | `SHARE` on table |
| BRIN | `brin` | built-in | `SHARE` on table |
| Bloom | `bloom` | contrib (`CREATE EXTENSION bloom`) | `SHARE` on table |

*"Choices are `btree`, `hash`, `gist`, `spgist`, `gin`, `brin`, or user-installed access methods like bloom."*[^createindex]

### Type Comparison Table

A condensed seven-row comparison. The "Multicolumn?" column reflects the official statement that *"Currently, only the B-tree, GiST, GIN, and BRIN index types support multiple-key-column indexes."*[^multi]

| Property | B-tree | Hash | GiST | SP-GiST | GIN | BRIN | Bloom |
|---|---|---|---|---|---|---|---|
| Equality | yes | yes | yes (via opclass) | yes (via opclass) | yes (via opclass) | yes | yes |
| Range / order | yes | no | yes (via opclass) | yes (via opclass) | no | yes | no |
| `IS NULL` | yes | no | depends | depends | no | no | no |
| Multicolumn keys | yes | no | yes | no | yes | yes | yes |
| `INCLUDE` (payload columns) | PG11+ | no | PG14+ | PG14+ | no | no | no |
| Lossy (bitmap recheck required) | no | no | yes (signature opclasses) | partial | yes (with `RECHECK`) | yes | yes |
| WAL-logged & crash-safe | yes | PG10+ | yes | yes | yes | yes | yes |
| Supports unique constraint | yes (default) | no (PG18: non-btree unique allowed as PK / matview)[^pg18-nonbtree-unique] | no | no | no | no | no |
| Parallel build | PG11+[^pg11-parallel] | no | no | no | PG18+[^pg18-parallel-gin] | PG17+[^pg17-parallel-brin] | no |
| Size vs B-tree on the same data | 1× | ~1× | 0.8–1.5× | ~1× | 0.5–2× (varies) | ~1/1000× | ~0.1–0.3× |
| Drives `ORDER BY distance LIMIT N` (KNN) | no | no | yes | yes | no | no | no |

Lossy means the access method may return false-positive candidate tuples that the executor must recheck against the heap. Lossy indexes are usually scanned as **bitmap index scans**, not as ordinary index scans.

### CREATE INDEX Grammar

The full PG16 grammar:[^createindex]

    CREATE [ UNIQUE ] INDEX [ CONCURRENTLY ] [ [ IF NOT EXISTS ] name ] ON [ ONLY ] table_name
        [ USING method ]
        ( { column_name | ( expression ) } [ COLLATE collation ] [ opclass [ ( opclass_parameter = value [, ... ] ) ] ] [ ASC | DESC ] [ NULLS { FIRST | LAST } ] [, ...] )
        [ INCLUDE ( column_name [, ...] ) ]
        [ NULLS [ NOT ] DISTINCT ]
        [ WITH ( storage_parameter [= value] [, ... ] ) ]
        [ TABLESPACE tablespace_name ]
        [ WHERE predicate ]

Eight orthogonal options apply to most index types:

1. `UNIQUE` — only valid for B-tree (and PG18+ for any opclass that supports equality)
2. `CONCURRENTLY` — non-blocking build at the cost of a longer build time; see [`26-index-maintenance.md`](./26-index-maintenance.md)
3. `USING method` — the access method (`btree` is the default if omitted)
4. `( expression )` — wrap any expression in parentheses to build a functional index
5. `opclass` — pick a non-default operator class (e.g., `text_pattern_ops`, `jsonb_path_ops`, `gin_trgm_ops`)
6. `INCLUDE` — non-key payload columns for index-only scans (PG11+ for B-tree, PG14+ for GiST and SP-GiST)
7. `NULLS NOT DISTINCT` — treat NULLs as equal for uniqueness (PG15+)
8. `WHERE predicate` — partial index

### Operator Classes

*"An index definition can specify an operator class for each column of an index. The operator class identifies the operators to be used by the index for that column."*[^opclass]

The most-commonly-overridden opclasses:

| Opclass | Where | Use case |
|---|---|---|
| `text_pattern_ops` / `varchar_pattern_ops` / `bpchar_pattern_ops` | B-tree on text under non-C collation | `LIKE 'prefix%'` index usability |
| `jsonb_path_ops` | GIN on `jsonb` | Smaller / faster index when you only need `@>` |
| `gin_trgm_ops` / `gist_trgm_ops` | GIN/GiST with `pg_trgm` | `LIKE '%any%'`, `ILIKE`, similarity, regex |
| `tsvector_ops` (default) | GIN/GiST on `tsvector` | Full-text search |
| `array_ops` (default) | GIN on arrays | `@>`, `<@`, `&&` on arrays |
| `inet_ops` | GiST on `inet`/`cidr` | Network containment `<<=`/`>>` |
| `vector_l2_ops` / `vector_cosine_ops` / `vector_ip_ops` | HNSW/IVFFLAT (pgvector) | Distance-metric selection for ANN search |

Inspect available opclasses for a type:

    SELECT amname, opcname, opcintype::regtype, opcdefault
    FROM pg_opclass o
    JOIN pg_am a ON a.oid = o.opcmethod
    WHERE opcintype = 'text'::regtype
    ORDER BY amname, opcname;

In psql: `\dAc` lists operator classes, `\dAf` lists operator families.

### Multicolumn Indexes

*"An index can be defined on more than one column of a table … Indexes can have up to 32 columns, including `INCLUDE` columns."*[^multi]

Three real rules for picking column order in a multicolumn B-tree:

1. **Equality columns first, range columns last.** A B-tree can use the index for predicates on the leading columns; once a range predicate is seen, lower-order columns are useful only for `ORDER BY`.
2. **High-selectivity columns before low-selectivity.** Same logic as picking the first key in a composite key on paper.
3. **PG18+ skip scan partly relaxes this** for the case where the leading column has few distinct values and a non-leading column has a strong predicate.[^pg18-skip] Still — design the index for the common predicate, not for skip scan.

A multicolumn GIN index is *not* the same as multiple single-column GIN indexes. GIN combines them at the index level; multiple single-column indexes get combined later via bitmap AND (and the planner often picks the multicolumn shape when both columns are filtered together).

### Partial Indexes

*"A partial index is an index built over a subset of a table; the subset is defined by a conditional expression (called the predicate of the partial index). The index contains entries only for those table rows that satisfy the predicate."*[^partial]

Three canonical uses:

1. **Skip a common low-value value** to keep the index small: `WHERE status <> 'done'` on a tasks table that is 99% done.
2. **Enforce uniqueness within a subset**, e.g., one active row per user (Recipe 6).
3. **Index hot, narrow query paths** without paying for every row: `WHERE deleted_at IS NULL`.

The predicate must use only columns of the target table and only `IMMUTABLE` operators/functions; the planner compares the query's `WHERE` against the partial-index predicate via implication, so write the predicate in the same shape your queries use.

### Expression Indexes

*"An index column need not be just a column of the underlying table, but can be a function or scalar expression computed from one or more columns of the table … the index expressions are not recomputed during an indexed search, since they are already stored in the index. Thus, indexes on expressions are useful when retrieval speed is more important than insertion and update speed."*[^expr]

The function in an expression index must be marked `IMMUTABLE` ([`06-functions.md`](./06-functions.md)). The canonical examples:

    CREATE INDEX users_email_lower ON users (lower(email));
    CREATE INDEX orders_day ON orders (date_trunc('day', created_at));

Match the query's expression *exactly* — `WHERE lower(email) = $1` will use the first index, but `WHERE email ILIKE $1` will not.

### INCLUDE (Covering) Indexes

PG11 added `INCLUDE` for B-tree:[^pg11-include]

> *"Allow B-tree indexes to include columns that are not part of the search key or unique constraint, but are available to be read by index-only scans … This is enabled by the new `INCLUDE` clause of CREATE INDEX."*

*"A non-key column cannot be used in an index scan search qualification, and it is disregarded for purposes of any uniqueness or exclusion constraint enforced by the index."*[^createindex]

*"Because column `y` is not part of the index's search key, it does not have to be of a data type that the index can handle; it's merely stored in the index and is not interpreted by the index machinery."*[^index-only]

> [!NOTE] PostgreSQL 14
> *"Allow SP-GiST indexes to contain `INCLUDE`'d columns."*[^pg14-spgist-include] GiST also supports `INCLUDE` since PG12.

Use `INCLUDE` to drive index-only scans for read-hot lookups that need a few extra payload columns. Do **not** stuff every column of the table into `INCLUDE` — every payload column inflates the index, slows writes, and reduces HOT-update eligibility on those columns (see [`30-hot-updates.md`](./30-hot-updates.md)).

`INCLUDE` is also the canonical way to make a unique constraint cover a payload column without disturbing the uniqueness contract — `CREATE UNIQUE INDEX … (user_id) INCLUDE (last_active_at)` enforces uniqueness on `user_id` only.

### Index-Only Scans

*"All indexes in PostgreSQL are secondary indexes, meaning that each index is stored separately from the table's main data area (which is called the table's heap in PostgreSQL terminology) … To solve this performance problem, PostgreSQL supports index-only scans, which can answer queries from an index alone without any heap access."*[^index-only]

Two prerequisites that often surprise people:

1. **All referenced columns** in the query must be either index key columns or `INCLUDE` columns. Even `SELECT count(*) WHERE indexed_col = $1` needs index-only scan eligibility on indexed_col; an unrelated `WHERE another_col > 0` defeats it.
2. **The visibility map must report the heap page as all-visible.** Otherwise the executor must visit the heap to recheck visibility. Pages get marked all-visible by VACUUM. A table with stale autovacuum will lose index-only scans even when the index would otherwise qualify. Run `VACUUM (VERBOSE)` and check the all-visible page count; see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

EXPLAIN shows index-only eligibility as `Index Only Scan using …` and the heap fetches needed because of the visibility map as `Heap Fetches: N`. Non-zero `Heap Fetches` indicates VACUUM is behind.

### Ordering: ASC/DESC and NULLS FIRST/LAST

*"By default, B-tree indexes store their entries in ascending order with nulls last … This means that a forward scan of an index on column `x` produces output satisfying `ORDER BY x` (or more verbosely, `ORDER BY x ASC NULLS LAST`). The index can also be scanned backward, producing output satisfying `ORDER BY x DESC` (or more verbosely, `ORDER BY x DESC NULLS FIRST`, since `NULLS FIRST` is the default for `ORDER BY DESC`)."*[^order]

A B-tree can be scanned in either direction at the same cost. You need an explicit ASC/DESC or NULLS FIRST/LAST modifier on the index only when:

- You want `ORDER BY x ASC NULLS FIRST` (default index direction reverses this)
- You want `ORDER BY x DESC NULLS LAST` (same reason)
- You have a multicolumn index and the query's `ORDER BY` mixes ASC and DESC across columns (the index column ordering must match)

### Unique Indexes and NULLS NOT DISTINCT (PG15+)

*"Currently, only B-tree indexes can be declared unique."*[^unique] (PG18 relaxes this for any opclass that supports equality, but only as a partition key or in a materialized view — see version notes.)

*"By default, null values in a unique column are not considered equal, allowing multiple nulls in the column. The `NULLS NOT DISTINCT` option modifies this and causes the index to treat nulls as equal."*[^unique]

> [!NOTE] PostgreSQL 15
> `NULLS NOT DISTINCT` clause added to `CREATE UNIQUE INDEX` and `UNIQUE` constraints. Treats NULLs as equal for uniqueness, so a column can hold at most one NULL.

> [!NOTE] PostgreSQL 16
> *"Disallow `NULLS NOT DISTINCT` indexes for primary keys."*[^pg16-nnd] Use `NULLS NOT DISTINCT` only on uniqueness constraints, not primary keys (primary keys already forbid NULLs).

### Combining Indexes via Bitmap

*"To combine multiple indexes, the system scans each needed index and prepares a bitmap in memory giving the locations of table rows that are reported as matching that index's conditions. The bitmaps are then ANDed and ORed together as needed by the query."*[^bitmap]

*"The table rows are visited in physical order, because that is how the bitmap is laid out; this means that any ordering of the original indexes is lost, and so a separate sort step will be needed if the query has an `ORDER BY` clause."*[^bitmap]

When EXPLAIN shows a `BitmapAnd` or `BitmapOr` followed by `Bitmap Heap Scan`, the planner has decided combining two or more single-column indexes beats any one of them alone. This is usually a sign that a multicolumn index would be more efficient — *if* the query's predicate columns are a stable subset. If the query's predicates vary unpredictably, leave the per-column indexes alone and let the bitmap mechanism handle it.

### Collations and Indexes

*"An index can support only one collation per index column. If multiple collations are of interest, multiple indexes may be needed."*[^collations]

Two operational consequences:

1. The default collation comes from the column's declared collation; override with `COLLATE` in the index definition.
2. **A libc collation update (glibc, ICU upgrade) can silently invalidate B-tree indexes on text columns.** See [`65-collations-encoding.md`](./65-collations-encoding.md). PG18 changed the default-collation-provider story; old indexes built before an upgrade must be reindexed.

For `LIKE 'prefix%'` to use a B-tree on a text column, either (a) the database collation must be `C` / `POSIX` / a deterministic collation under which byte order equals character order, or (b) the index must use `text_pattern_ops` / `varchar_pattern_ops` / `bpchar_pattern_ops` to force byte-wise comparison.[^opclass]


## Version History At A Glance

Inline admonitions throughout this file cover the version-specific facts. The cumulative timeline:

> [!NOTE] PostgreSQL 11
> `INCLUDE` clause for B-tree indexes; parallel B-tree index build.[^pg11-include][^pg11-parallel]

> [!NOTE] PostgreSQL 13
> B-tree deduplication: *"More efficiently store duplicates in B-tree indexes. This allows efficient B-tree indexing of low-cardinality columns by storing duplicate keys only once. Users upgrading with pg_upgrade will need to use `REINDEX` to make an existing index use this feature."*[^pg13-dedup]

> [!NOTE] PostgreSQL 14
> Bottom-up B-tree index deletion (reduces bloat on frequently-updated indexed columns)[^pg14-bottomup]; BRIN `minmax_multi` and `bloom` opclasses[^pg14-brin-multi][^pg14-brin-bloom]; SP-GiST gains `INCLUDE` support[^pg14-spgist-include].

> [!NOTE] PostgreSQL 15
> `NULLS NOT DISTINCT` for unique indexes and unique constraints.

> [!NOTE] PostgreSQL 16
> *"Allow HOT updates if only BRIN-indexed columns are updated."*[^pg16-hot-brin] *"Disallow `NULLS NOT DISTINCT` indexes for primary keys."*[^pg16-nnd] GIN index access optimizer cost accuracy improved.[^pg16-gin-cost]

> [!NOTE] PostgreSQL 17
> *"Allow btree indexes to more efficiently find a set of values, such as those supplied by `IN` clauses using constants."*[^pg17-btree-in] *"Allow BRIN indexes to be created using parallel workers."*[^pg17-parallel-brin] GiST/SP-GiST can participate in incremental sorts.[^pg17-gist-incsort]

> [!NOTE] PostgreSQL 18
> Skip scan for multicolumn B-tree[^pg18-skip]; parallel GIN build[^pg18-parallel-gin]; sorted range-type GiST/btree builds[^pg18-rangesort]; non-B-tree unique indexes allowed as partition keys and in materialized views[^pg18-nonbtree-unique].


## Examples / Recipes

### Recipe 1 — Audit: tables without a primary key

A table with no PK is almost always a mistake (logical replication breaks, ORM upserts misbehave, audit becomes guesswork).

    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.oid AND i.indisprimary
      )
    ORDER BY n.nspname, c.relname;

### Recipe 2 — Audit: unused indexes

Indexes with zero scans are good candidates for removal, but read the caveats first:

    SELECT s.schemaname, s.relname AS table_name, s.indexrelname AS index_name,
           pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
           s.idx_scan
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    WHERE s.idx_scan = 0
      AND NOT i.indisunique               -- never drop a UNIQUE index without analysis
      AND NOT i.indisprimary               -- never drop a PK
    ORDER BY pg_relation_size(s.indexrelid) DESC;

Caveats: `pg_stat_user_indexes` is per-server. A standby that runs read queries has its own counters; an index "unused" on the primary may be hot on a replica. Reset counters with `pg_stat_reset()` and let representative traffic flow before deciding.

### Recipe 3 — Audit: foreign keys missing a covering index

A foreign key without an index on the referencing column makes `DELETE` on the parent slow because each delete forces a sequential scan of the child to check referential integrity. See [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).

    SELECT c.conrelid::regclass AS child_table,
           a.attname            AS fk_column,
           c.confrelid::regclass AS parent_table,
           c.conname            AS fk_name
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum   = ANY (c.conkey)
    WHERE c.contype = 'f'
      AND NOT EXISTS (
          SELECT 1
          FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND (i.indkey::int[])[0:array_length(c.conkey, 1) - 1] @> c.conkey::int[]
      )
    ORDER BY child_table, fk_column;

The `(indkey::int[])[0:N-1] @> conkey::int[]` test ensures the FK columns are a leading subset of an existing index — a covering index must lead with the FK column(s).

### Recipe 4 — Audit: duplicate or overlapping indexes

A common bloat source. The query finds indexes whose key columns are an exact prefix of another index's key columns:

    WITH idx AS (
        SELECT indexrelid, indrelid, indkey::int[] AS keys,
               pg_get_indexdef(indexrelid) AS def
        FROM pg_index
    )
    SELECT a.indrelid::regclass AS table_name,
           a.def AS index_a,
           b.def AS index_b,
           pg_size_pretty(pg_relation_size(a.indexrelid)) AS size_a,
           pg_size_pretty(pg_relation_size(b.indexrelid)) AS size_b
    FROM idx a
    JOIN idx b
      ON a.indrelid = b.indrelid
     AND a.indexrelid < b.indexrelid
     AND (a.keys = b.keys OR a.keys @> b.keys OR b.keys @> a.keys)
    ORDER BY a.indrelid::regclass::text;

### Recipe 5 — Expression index for `lower(email)` case-insensitive lookups

The canonical case-insensitive equality index:

    CREATE INDEX users_email_lower
        ON users (lower(email));

Query:

    SELECT * FROM users WHERE lower(email) = lower($1);

The `lower(...)` on both sides is required — the index stores `lower(email)`, not `email`, so the WHERE clause must use the *same expression*. For a typed alternative consider the `citext` type and a plain B-tree (see [`65-collations-encoding.md`](./65-collations-encoding.md)).

### Recipe 6 — Partial unique index for "one active row per user"

The canonical soft-delete uniqueness pattern:

    CREATE UNIQUE INDEX one_active_session_per_user
        ON sessions (user_id)
        WHERE ended_at IS NULL;

Now a user can have any number of ended sessions, but at most one active one. The constraint exists at the database layer, no application-side coordination needed.

For multi-tenant uniqueness within a tenant:

    CREATE UNIQUE INDEX tenant_external_id_unique
        ON entities (tenant_id, external_id)
        WHERE deleted_at IS NULL;

### Recipe 7 — Covering index for an index-only scan

A read-hot lookup that needs a few payload columns:

    CREATE INDEX orders_user_status_idx
        ON orders (user_id, status)
        INCLUDE (created_at, total_cents);

    -- Now this is an Index Only Scan if VACUUM keeps the visibility map current:
    SELECT created_at, total_cents
    FROM orders
    WHERE user_id = $1 AND status = 'paid';

Verify with `EXPLAIN (ANALYZE, BUFFERS)` that you see `Index Only Scan` and `Heap Fetches: 0`. Non-zero `Heap Fetches` means autovacuum is behind on this table.

### Recipe 8 — `LIKE 'prefix%'` index under a non-C collation

If the database is created with a libc collation like `en_US.UTF-8`:

    -- This WILL NOT use a default B-tree for LIKE 'foo%':
    SELECT * FROM users WHERE email LIKE 'admin@%';

    -- Fix:
    CREATE INDEX users_email_pattern_ops
        ON users (email text_pattern_ops);

Now the same query uses the index because *"values are compared strictly character by character rather than according to the locale-specific collation rules."*[^opclass]

### Recipe 9 — Bloom for arbitrary-column equality

When a wide table is queried with `WHERE a = ? AND c = ? AND e = ?` for arbitrary subsets of columns:

    CREATE EXTENSION IF NOT EXISTS bloom;

    CREATE INDEX events_bloom
        ON events
        USING bloom (event_type, source, user_id, status, region)
        WITH (length = 80, col1 = 2, col2 = 2, col3 = 4, col4 = 2, col5 = 2);

Bloom is **lossy and equality-only**; the executor must recheck candidates against the heap. *"This type of index is most useful when a table has many attributes and queries test arbitrary combinations of them."*[^bloom]

### Recipe 10 — BRIN for an append-only time-series table

A 500 GB events table with `created_at` correlated to insertion order (typical of an append-only ingest):

    CREATE INDEX events_created_at_brin
        ON events
        USING brin (created_at) WITH (pages_per_range = 32);

    SELECT * FROM events
    WHERE created_at >= now() - interval '1 hour';

The BRIN index on a 500 GB heap may be only a few megabytes. The B-tree equivalent would be tens of gigabytes. For non-correlated data BRIN is useless; verify correlation with `pg_stats.correlation`. See [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md).

### Recipe 11 — Identify multicolumn-index reorder candidates

Find multicolumn indexes whose leading column has low cardinality (fewer than 10 distinct values typical) — these are reorder candidates:

    SELECT s.schemaname, s.relname AS table_name, i.indexrelid::regclass AS index_name,
           a.attname AS leading_col,
           st.n_distinct
    FROM pg_index i
    JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
    JOIN pg_attribute a
      ON a.attrelid = i.indrelid
     AND a.attnum   = i.indkey[0]
    JOIN pg_stats st
      ON st.schemaname = s.schemaname
     AND st.tablename  = s.relname
     AND st.attname    = a.attname
    WHERE i.indnatts > 1
      AND NOT i.indisunique
      AND ((st.n_distinct >= 0 AND st.n_distinct < 10)
           OR (st.n_distinct < 0 AND st.n_distinct > -0.01))
    ORDER BY st.n_distinct;

`n_distinct` is positive (raw count) or negative (fraction of `reltuples`). Both shapes are handled.

### Recipe 12 — `EXPLAIN` reading: confirm an index is being used

The canonical four-flag invocation:

    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
    SELECT * FROM users WHERE lower(email) = lower($1);

Look for:

- `Index Scan using users_email_lower …` or `Index Only Scan using …`
- `Index Cond:` matching your WHERE
- `Rows Removed by Filter: 0` (a non-zero number means the index returned candidates that didn't actually match — the index is incomplete for the predicate)
- `Buffers: shared hit=N read=M` (in a warm cache, `read` should be small)

See [`56-explain.md`](./56-explain.md) for the full plan-node reference.

### Recipe 13 — Add an index without blocking writes

Anything in production should be `CONCURRENTLY`:

    CREATE INDEX CONCURRENTLY orders_user_idx
        ON orders (user_id);

If the build is interrupted, you may end up with an invalid index — drop it and retry. Verify build status:

    SELECT indexrelid::regclass, indisvalid, indisready
    FROM pg_index
    WHERE NOT (indisvalid AND indisready);

See [`26-index-maintenance.md`](./26-index-maintenance.md) for the full operational playbook.


## Gotchas / Anti-patterns

1. **B-tree on `jsonb` does not index extracted values.** A B-tree on `payload jsonb` indexes the binary document, not `payload->>'user_id'`. Use a functional index `(payload->>'user_id')` or a GIN index on `payload`. See [`17-json-jsonb.md`](./17-json-jsonb.md).

2. **GIN does not accelerate equality on a single key.** For `WHERE payload->>'user_id' = $1` build a functional B-tree on `(payload->>'user_id')`, not a GIN.

3. **`LIKE 'prefix%'` does not use the default B-tree under a non-C collation.** Use `text_pattern_ops`. See Recipe 8.

4. **`LIKE '%any%'` cannot use any B-tree.** Use GIN with `gin_trgm_ops` from `pg_trgm`. See [`93-pg-trgm.md`](./93-pg-trgm.md).

5. **Index expressions must match the query expression exactly.** `CREATE INDEX … (lower(email))` is not used by `WHERE email ILIKE $1` because the planner cannot prove the predicates equivalent.

6. **Function in an expression index must be `IMMUTABLE`.** `STABLE` and `VOLATILE` functions cannot back an expression index — different invocations could return different results and the index would be wrong. See [`06-functions.md`](./06-functions.md).

7. **Multicolumn-index leading-column rule.** A B-tree on `(a, b)` does not accelerate `WHERE b = $1` (pre-PG18). PG18 skip scan partly relaxes this[^pg18-skip]; see §Multicolumn Indexes above.

8. **`INCLUDE` columns are not part of the search key.** *"A non-key column cannot be used in an index scan search qualification."*[^createindex] Adding a column to `INCLUDE` does not make it filterable from the index; the column is payload only.

9. **`INCLUDE` payload is not free.** Every included column inflates the index, slows writes, and reduces HOT-update eligibility on those columns. See [`30-hot-updates.md`](./30-hot-updates.md).

10. **A unique-on-NULL column allows multiple NULLs by default.** Use `UNIQUE … NULLS NOT DISTINCT` (PG15+) when you want at most one NULL.

11. **Partial-index predicate must use only IMMUTABLE expressions.** `WHERE created_at > now() - interval '7 days'` is not a valid partial-index predicate — `now()` is `STABLE`, not `IMMUTABLE`. Use a fixed timestamp instead, and rebuild the index periodically.

12. **Index-only scan still does heap fetches if VACUUM is behind.** `Heap Fetches: N` in EXPLAIN means the visibility map is stale. Tune autovacuum; see §Index-Only Scans above and [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

13. **B-tree deduplication requires REINDEX after pg_upgrade from PG12 or earlier.** *"Users upgrading with pg_upgrade will need to use `REINDEX` to make an existing index use this feature."*[^pg13-dedup]

14. **A libc / ICU collation upgrade can silently break text indexes.** Reindex text B-trees after the host OS or PG cluster collation provider changes. See [`65-collations-encoding.md`](./65-collations-encoding.md).

15. **Hash index pre-PG10 was not crash-safe.** PG10 added WAL logging; that's the only PG version this matters for now, but if you inherit a hash index in a cluster ever upgraded from ≤9.6 along an unusual path, `REINDEX` it once.

16. **Hash index allows only `=`.** *"Hash indexes store a 32-bit hash code derived from the value of the indexed column. Hence, such indexes can only handle simple equality comparisons."*[^types] No range, no `IS NULL`, no sort, no uniqueness. B-tree handles `=` fine; reach for hash only for very wide columns.

17. **BRIN is useless on non-correlated data.** If `pg_stats.correlation` for the indexed column is near zero, BRIN returns most of the table per query and wastes CPU. Check correlation before building BRIN.

18. **Bloom is lossy and equality-only.** It returns false-positive candidates that the executor must recheck. Use it when *every* candidate column would otherwise be a separate per-column index.

19. **Multiple single-column indexes do not replace a multicolumn index for queries that always filter on all of them.** They get combined via bitmap, but the combined cost is higher than scanning a multicolumn index once. Build the multicolumn index when the predicate columns are stable.

20. **Building an index without `CONCURRENTLY` takes `SHARE` lock and blocks writes.** Use `CREATE INDEX CONCURRENTLY` in production. See [`26-index-maintenance.md`](./26-index-maintenance.md).

21. **Indexes can prevent HOT updates.** *"Indexes can also prevent the creation of heap-only tuples. Therefore indexes that are seldom or never used in queries should be removed."*[^intro] A HOT update requires that no indexed column be modified; every extra index narrows that condition. See [`30-hot-updates.md`](./30-hot-updates.md).

22. **An invalid index (build failed under `CONCURRENTLY`) still costs writes.** PostgreSQL maintains entries in invalid indexes during writes but does not use them for reads. Drop and recreate.

23. **`NULLS NOT DISTINCT` is not allowed on a primary key in PG16+.** Use it on a uniqueness index/constraint that allows the column to be NULL.[^pg16-nnd]


## See Also

- [`23-btree-indexes.md`](./23-btree-indexes.md) — B-tree internals, deduplication (PG13+), bottom-up deletion (PG14+), fillfactor, leaf vs internal pages, skip scan (PG18+)
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN posting lists, fastupdate, GiST extensibility, KNN, exclusion constraints, jsonb_ops vs jsonb_path_ops
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — BRIN minmax/minmax_multi/bloom opclasses, pages_per_range, hash, SP-GiST, Bloom
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY` (PG12+), pg_repack, invalid indexes, index bloat
- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — `CREATE INDEX` grammar in context of `CREATE TABLE` and `ALTER TABLE`
- [`06-functions.md`](./06-functions.md) — Volatility rules for functions used in expression indexes
- [`15-data-types-custom.md`](./15-data-types-custom.md) — composite types; `range_ops` and `multirange_ops`
- [`17-json-jsonb.md`](./17-json-jsonb.md) — JSONB-specific index choices and `jsonb_ops` vs `jsonb_path_ops`
- [`20-text-search.md`](./20-text-search.md) — FTS indexing and configuration
- [`21-hstore.md`](./21-hstore.md) — `gin_hstore_ops` opclass used in the operator-class table
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — Why index-only scan needs current visibility map
- [`30-hot-updates.md`](./30-hot-updates.md) — Indexed-column rule for HOT eligibility
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — Why FK columns need a covering index
- [`55-statistics-planner.md`](./55-statistics-planner.md) — `pg_stats.correlation` for BRIN viability; `n_distinct` for multicolumn ordering
- [`56-explain.md`](./56-explain.md) — Reading `Index Scan` / `Index Only Scan` / `Bitmap Heap Scan` plan nodes
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_index`, `pg_stat_user_indexes`, the catalog joins behind every audit recipe in this file
- [`65-collations-encoding.md`](./65-collations-encoding.md) — Why collation upgrades invalidate text B-trees
- [`93-pg-trgm.md`](./93-pg-trgm.md) — Trigram GIN/GiST for `LIKE '%any%'`, similarity, regex
- [`94-pgvector.md`](./94-pgvector.md) — HNSW and IVFFLAT for vector similarity


## Sources

[^intro]: PostgreSQL 16 docs, "11.1. Introduction" — *"Once an index is created, no further intervention is required: the system will update the index when the table is modified, and it will use the index in queries when it thinks doing so would be more efficient than a sequential table scan."* and *"Indexes can also prevent the creation of heap-only tuples. Therefore indexes that are seldom or never used in queries should be removed."* https://www.postgresql.org/docs/16/indexes-intro.html

[^types]: PostgreSQL 16 docs, "11.2. Index Types" — *"B-trees can handle equality and range queries on data that can be sorted into some ordering."* and *"Hash indexes store a 32-bit hash code derived from the value of the indexed column. Hence, such indexes can only handle simple equality comparisons."* https://www.postgresql.org/docs/16/indexes-types.html

[^multi]: PostgreSQL 16 docs, "11.3. Multicolumn Indexes" — *"An index can be defined on more than one column of a table."* and *"Currently, only the B-tree, GiST, GIN, and BRIN index types support multiple-key-column indexes."* and *"Indexes can have up to 32 columns, including `INCLUDE` columns."* and *"A multicolumn B-tree index can be used with query conditions that involve any subset of the index's columns, but the index is most efficient when there are constraints on the leading (leftmost) columns."* https://www.postgresql.org/docs/16/indexes-multicolumn.html

[^order]: PostgreSQL 16 docs, "11.4. Indexes and ORDER BY" — *"By default, B-tree indexes store their entries in ascending order with nulls last (table TID is treated as a tiebreaker column among otherwise equal entries). This means that a forward scan of an index on column `x` produces output satisfying `ORDER BY x` (or more verbosely, `ORDER BY x ASC NULLS LAST`). The index can also be scanned backward, producing output satisfying `ORDER BY x DESC` (or more verbosely, `ORDER BY x DESC NULLS FIRST`, since `NULLS FIRST` is the default for `ORDER BY DESC`)."* https://www.postgresql.org/docs/16/indexes-ordering.html

[^bitmap]: PostgreSQL 16 docs, "11.5. Combining Multiple Indexes" — *"To combine multiple indexes, the system scans each needed index and prepares a bitmap in memory giving the locations of table rows that are reported as matching that index's conditions. The bitmaps are then ANDed and ORed together as needed by the query."* and *"The table rows are visited in physical order, because that is how the bitmap is laid out; this means that any ordering of the original indexes is lost, and so a separate sort step will be needed if the query has an `ORDER BY` clause."* https://www.postgresql.org/docs/16/indexes-bitmap-scans.html

[^unique]: PostgreSQL 16 docs, "11.6. Unique Indexes" — *"Indexes can also be used to enforce uniqueness of a column's value, or the uniqueness of the combined values of more than one column."* and *"Currently, only B-tree indexes can be declared unique."* and *"By default, null values in a unique column are not considered equal, allowing multiple nulls in the column. The `NULLS NOT DISTINCT` option modifies this and causes the index to treat nulls as equal."* https://www.postgresql.org/docs/16/indexes-unique.html

[^expr]: PostgreSQL 16 docs, "11.7. Indexes on Expressions" — *"An index column need not be just a column of the underlying table, but can be a function or scalar expression computed from one or more columns of the table."* and *"Index expressions are relatively expensive to maintain, because the derived expression(s) must be computed for each row insertion and non-HOT update. However, the index expressions are not recomputed during an indexed search, since they are already stored in the index. Thus, indexes on expressions are useful when retrieval speed is more important than insertion and update speed."* https://www.postgresql.org/docs/16/indexes-expressional.html

[^partial]: PostgreSQL 16 docs, "11.8. Partial Indexes" — *"A partial index is an index built over a subset of a table; the subset is defined by a conditional expression (called the predicate of the partial index). The index contains entries only for those table rows that satisfy the predicate."* https://www.postgresql.org/docs/16/indexes-partial.html

[^index-only]: PostgreSQL 16 docs, "11.9. Index-Only Scans and Covering Indexes" — *"All indexes in PostgreSQL are secondary indexes, meaning that each index is stored separately from the table's main data area (which is called the table's heap in PostgreSQL terminology)."* and *"To solve this performance problem, PostgreSQL supports index-only scans, which can answer queries from an index alone without any heap access."* and *"Because column `y` is not part of the index's search key, it does not have to be of a data type that the index can handle; it's merely stored in the index and is not interpreted by the index machinery."* https://www.postgresql.org/docs/16/indexes-index-only-scans.html

[^opclass]: PostgreSQL 16 docs, "11.10. Operator Classes and Operator Families" — *"An index definition can specify an operator class for each column of an index."* and *"The operator class identifies the operators to be used by the index for that column."* and *"The operator classes `text_pattern_ops`, `varchar_pattern_ops`, and `bpchar_pattern_ops` support B-tree indexes on the types `text`, `varchar`, and `char` respectively. The difference from the default operator classes is that the values are compared strictly character by character rather than according to the locale-specific collation rules."* https://www.postgresql.org/docs/16/indexes-opclass.html

[^collations]: PostgreSQL 16 docs, "11.11. Indexes and Collations" — *"An index can support only one collation per index column. If multiple collations are of interest, multiple indexes may be needed."* https://www.postgresql.org/docs/16/indexes-collations.html

[^createindex]: PostgreSQL 16 docs, "CREATE INDEX" — *"The optional `INCLUDE` clause specifies a list of columns which will be included in the index as non-key columns."* and *"A non-key column cannot be used in an index scan search qualification, and it is disregarded for purposes of any uniqueness or exclusion constraint enforced by the index."* and *"The name of the index method to be used. Choices are `btree`, `hash`, `gist`, `spgist`, `gin`, `brin`, or user-installed access methods like bloom."* https://www.postgresql.org/docs/16/sql-createindex.html

[^bloom]: PostgreSQL 16 docs, "F.7. bloom" — *"`bloom` provides an index access method based on Bloom filters."* and *"A signature is a lossy representation of the indexed attribute(s), and as such is prone to reporting false positives; that is, it may be reported that an element is in the set, when it is not."* and *"This type of index is most useful when a table has many attributes and queries test arbitrary combinations of them."* and *"Note however that bloom indexes only support equality queries, whereas btree indexes can also perform inequality and range searches."* https://www.postgresql.org/docs/16/bloom.html

[^hash-walogged]: Hash indexes have been WAL-logged and crash-safe since PostgreSQL 10. Before PG10 they were not durable across crashes; the planner generally advised against them. https://www.postgresql.org/docs/release/10.0/

[^pg11-include]: PostgreSQL 11 release notes — *"Allow B-tree indexes to include columns that are not part of the search key or unique constraint, but are available to be read by index-only scans. This is enabled by the new `INCLUDE` clause of CREATE INDEX."* https://www.postgresql.org/docs/release/11.0/

[^pg11-parallel]: PostgreSQL 11 release notes — *"Allow parallel building of a btree index."* https://www.postgresql.org/docs/release/11.0/

[^pg13-dedup]: PostgreSQL 13 release notes — *"More efficiently store duplicates in B-tree indexes. This allows efficient B-tree indexing of low-cardinality columns by storing duplicate keys only once. Users upgrading with pg_upgrade will need to use `REINDEX` to make an existing index use this feature."* https://www.postgresql.org/docs/release/13.0/

[^pg14-bottomup]: PostgreSQL 14 release notes — *"Allow btree index additions to remove expired index entries to prevent page splits."* (Bottom-up index deletion; particularly helpful for reducing index bloat on tables whose indexed columns are frequently updated.) https://www.postgresql.org/docs/release/14.0/

[^pg14-brin-multi]: PostgreSQL 14 release notes — *"Allow BRIN indexes to record multiple min/max values per range."* (The `minmax_multi` opclass; useful if there are groups of values in each page range.) https://www.postgresql.org/docs/release/14.0/

[^pg14-brin-bloom]: PostgreSQL 14 release notes — *"Allow BRIN indexes to use bloom filters."* (Enables BRIN to be effective on data that is not well-localized in the heap.) https://www.postgresql.org/docs/release/14.0/

[^pg14-spgist-include]: PostgreSQL 14 release notes — *"Allow SP-GiST indexes to contain `INCLUDE`'d columns."* https://www.postgresql.org/docs/release/14.0/

[^pg16-hot-brin]: PostgreSQL 16 release notes — *"Allow HOT updates if only BRIN-indexed columns are updated."* https://www.postgresql.org/docs/release/16.0/

[^pg16-nnd]: PostgreSQL 16 release notes — *"Disallow `NULLS NOT DISTINCT` indexes for primary keys."* https://www.postgresql.org/docs/release/16.0/

[^pg16-gin-cost]: PostgreSQL 16 release notes — *"Improve the accuracy of GIN index access optimizer costs."* https://www.postgresql.org/docs/release/16.0/

[^pg17-btree-in]: PostgreSQL 17 release notes — *"Allow btree indexes to more efficiently find a set of values, such as those supplied by `IN` clauses using constants."* https://www.postgresql.org/docs/release/17.0/

[^pg17-parallel-brin]: PostgreSQL 17 release notes — *"Allow BRIN indexes to be created using parallel workers."* https://www.postgresql.org/docs/release/17.0/

[^pg17-gist-incsort]: PostgreSQL 17 release notes — *"Allow GiST and SP-GiST indexes to be part of incremental sorts."* https://www.postgresql.org/docs/release/17.0/

[^pg18-skip]: PostgreSQL 18 release notes — *"Allow skip scans of btree indexes ... This allows multi-column btree indexes to be used in more cases such as when there are no restrictions on the first or early indexed columns (or there are non-equality ones), and there are useful restrictions on later indexed columns."* https://www.postgresql.org/docs/release/18.0/

[^pg18-parallel-gin]: PostgreSQL 18 release notes — *"Allow GIN indexes to be created in parallel."* https://www.postgresql.org/docs/release/18.0/

[^pg18-rangesort]: PostgreSQL 18 release notes — *"Allow values to be sorted to speed range-type GiST and btree index builds."* https://www.postgresql.org/docs/release/18.0/

[^pg18-nonbtree-unique]: PostgreSQL 18 release notes — *"Allow non-btree unique indexes to be used as partition keys and in materialized views ... The index type must still support equality."* https://www.postgresql.org/docs/release/18.0/

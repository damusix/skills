# B-Tree Indexes (Deep Dive)

This file is the **internals deep dive** for the B-tree access method: page layout, operator-class behavior, deduplication, bottom-up deletion, skip scan, fillfactor, ordering, and the diagnostics you actually use on a running cluster. For "should I use B-tree or another type?" see [`22-indexes-overview.md`](./22-indexes-overview.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Definition and limits](#definition-and-limits)
    - [Page structure](#page-structure)
    - [Operator-class contract](#operator-class-contract)
    - [Default opclass vs text_pattern_ops family](#default-opclass-vs-text_pattern_ops-family)
    - [Ordering: ASC / DESC / NULLS FIRST / NULLS LAST](#ordering-asc--desc--nulls-first--nulls-last)
    - [Multicolumn leading-column rule](#multicolumn-leading-column-rule)
    - [Skip scan (PG18+)](#skip-scan-pg18)
    - [Deduplication (PG13+)](#deduplication-pg13)
    - [Bottom-up index deletion (PG14+)](#bottom-up-index-deletion-pg14)
    - [Fillfactor and storage parameters](#fillfactor-and-storage-parameters)
    - [INCLUDE columns (covering indexes, PG11+)](#include-columns-covering-indexes-pg11)
    - [Unique indexes and NULLS NOT DISTINCT (PG15+)](#unique-indexes-and-nulls-not-distinct-pg15)
    - [Index-only scans and the visibility map](#index-only-scans-and-the-visibility-map)
    - [Parallel index build (PG11+)](#parallel-index-build-pg11)
    - [pageinspect functions](#pageinspect-functions)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when:

- You're tuning a B-tree on a high-write or high-churn table and need to understand HOT / bottom-up-deletion / fillfactor interactions.
- You're debugging "why is my index this big?" or "why isn't dedup helping?" and need the posting-list-tuple model.
- You're sizing a multicolumn index and need to know exactly what the leading-column rule does, plus whether PG18 skip scan relaxes it for your case.
- You're picking between the default opclass and `text_pattern_ops` / `varchar_pattern_ops` / `bpchar_pattern_ops` for a `LIKE 'foo%'` workload.
- You're investigating index ordering — `ORDER BY` with mixed `ASC` / `DESC` directions, or `NULLS FIRST` vs the default `NULLS LAST`.
- You're using `pageinspect` to inspect a real index live on a running cluster.
- You're planning a PG13 → PG14+ pg_upgrade and need to know when to `REINDEX`.

For the picker file (which index type for which workload), see [`22-indexes-overview.md`](./22-indexes-overview.md). For GIN/GiST internals see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md). For BRIN/hash/SP-GiST/Bloom see [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md). For maintenance (CREATE INDEX CONCURRENTLY, REINDEX, bloat detection) see [`26-index-maintenance.md`](./26-index-maintenance.md).

## Mental Model

Five rules drive every operational question about B-tree:

1. **B-tree is the default for a reason.** Docs: *"By default, the `CREATE INDEX` command creates B-tree indexes, which fit the most common situations."*[^types] The full grid of operators a B-tree handles — `<`, `<=`, `=`, `>=`, `>`, `BETWEEN`, `IN`, `IS NULL`, `IS NOT NULL`, anchored `LIKE 'foo%'`, anchored regex `~ '^foo'` — covers the overwhelming majority of indexable predicates.
2. **B-tree is a sorted structure first, an indexed structure second.** Docs: *"PostgreSQL includes an implementation of the standard btree (multi-way balanced tree) index data structure. Any data type that can be sorted into a well-defined linear order can be indexed by a btree index."*[^intro] Every B-tree operation — equality, range, sort, uniqueness — is a corollary of "the data is in sorted order."
3. **Posting-list tuples make duplicate keys cheap.** Since PG13, duplicate index entries are merged into a single posting-list tuple containing the key once plus a sorted TID array.[^pg13-dedup] Low-cardinality columns are no longer the disaster they once were on B-tree.
4. **Bottom-up index deletion handles version churn.** Since PG14, B-tree itself proactively removes expired index entries on an "about-to-split" leaf page, before autovacuum runs.[^pg14-bottomup] This is why bottom-up deletion is qualitative (triggered by page split, looks at logical row identity), while autovacuum is quantitative (triggered by table-level dead-tuple thresholds).
5. **Tuple size is capped at ~1/3 of a page.** Docs: *"The only limitation is that an index entry cannot exceed approximately one-third of a page (after TOAST compression, if applicable)."*[^intro] On the default 8 KB page that's ~2,700 bytes per index tuple after compression. Indexing wide text columns is feasible, but a CHECK on tuple length is wise.

## Syntax / Mechanics

### Definition and limits

A B-tree index is a balanced multiway tree with the following operational properties:

- **Multi-level structure.** Docs: *"PostgreSQL B-Tree indexes are multi-level tree structures, where each level of the tree can be used as a doubly-linked list of pages. A single metapage is stored in a fixed position at the start of the first segment file of the index."*[^impl]
- **Leaf pages dominate.** Docs: *"All other pages are either leaf pages or internal pages. Leaf pages are the pages on the lowest level of the tree. All other levels consist of internal pages. Each leaf page contains tuples that point to table rows. Each internal page contains tuples that point to the next level down in the tree. Typically, over 99% of all pages are leaf pages."*[^impl]
- **Tree depth grows logarithmically.** A B-tree on a billion-row table is normally only 3–5 levels deep; the metapage and a small set of internal pages cache in `shared_buffers` essentially permanently.
- **Tuple-size cap.** Per-entry size cannot exceed approximately one-third of a page after TOAST compression. On a standard 8 KB page that's roughly 2,700 bytes.[^intro]

The B-tree access method is registered as the access method `btree` in `pg_am`:

    SELECT amname, amhandler::regproc, amtype
    FROM pg_am
    WHERE amname = 'btree';

The implementation is the Lehman-Yao concurrent B+-tree variant. The canonical source-code-level explanation is in `src/backend/access/nbtree/README` of the PostgreSQL source distribution; the doc chapter explicitly defers to it for internals depth.[^impl]

### Page structure

Every B-tree index has four kinds of pages:

| Page type | Role | Notes |
|---|---|---|
| Metapage | Block 0, fixed-position metadata pointing to the root | Read once per scan; cached forever in shared_buffers |
| Root page | Top of the tree | Initially a leaf; promoted to internal when it splits |
| Internal page | Each entry is a downlink to a lower-level page | Stores separator keys, not heap pointers |
| Leaf page | Bottom level; each entry points to a heap TID | Doubly linked left↔right for range and backward scans |

Each leaf page has a **high key** at slot 0: the smallest key value greater than every key on the page. Internal pages' downlink entries carry separator keys derived from suffix truncation of the high keys below them. Leaf-page right-links let a forward range scan continue without re-descending the tree; the doubly-linked layout also enables backward `ORDER BY ... DESC` scans without sort.

When an insert can't fit on the destination leaf, a **page split** copies roughly half the entries to a new page and inserts a downlink in the parent. Docs: *"Page splits must also insert a new _downlink_ to the new page in the parent page, which may cause the parent to split in turn. Page splits 'cascade upwards' in a recursive fashion. When the root page finally cannot fit a new downlink, a _root page split_ operation takes place."*[^impl] Splits are the dominant fragmentation source on write-heavy B-trees.

### Operator-class contract

A B-tree opclass must implement five comparison operators and one comparison support function. Docs: *"a btree operator class must provide five comparison operators, `<`, `<=`, `=`, `>=` and `>`."*[^behavior]

Note the absence of `<>`. Docs: *"`<>` should also be part of the operator class, but it is not, because it would almost never be useful to use a `<>` WHERE clause in an index search."*[^behavior] The planner still finds `<>` via the `=` operator's negator link in `pg_operator`, but B-tree itself does not register an opclass entry for it.

The opclass must satisfy three algebraic laws for `=` (equivalence) and two for `<` (strong ordering), plus trichotomy across the type domain:

- `A = A` (reflexive); `A = B → B = A` (symmetric); `A = B ∧ B = C → A = C` (transitive)
- `A < A` is false (irreflexive); `A < B ∧ B < C → A < C` (transitive)
- Exactly one of `A < B`, `A = B`, `B < A` holds (trichotomy)

When an opclass family supports multiple types in cross-type comparison (e.g., the `integer` family allows `int2`, `int4`, `int8`), these laws must hold across every combination. Docs: *"it would not work to put `float8` and `numeric` into the same operator family, at least not with the current semantics that `numeric` values are converted to `float8` for comparison to a `float8`. Because of the limited accuracy of `float8`, this means there are distinct `numeric` values that will compare equal to the same `float8` value, and thus the transitive law would fail."*[^behavior]

### Default opclass vs text_pattern_ops family

For text-like types the default opclass uses the column's collation. Pattern matching with anchored `LIKE 'foo%'` or `~ '^foo'` can only use the default opclass when the collation is `C` (or the deterministic ICU `C.UTF-8`); in any other collation, the planner cannot prove the prefix-monotonicity needed to convert `LIKE` to a range scan.

The fix is the three `xxx_pattern_ops` opclasses:

| Opclass | Type | Use |
|---|---|---|
| `text_pattern_ops` | text | LIKE / regex anchored prefix |
| `varchar_pattern_ops` | varchar | LIKE / regex anchored prefix |
| `bpchar_pattern_ops` | char(n) | LIKE / regex anchored prefix |

Docs: *"The difference from the default operator classes is that the values are compared strictly character by character rather than according to the locale-specific collation rules."*[^opclass] That's why these indexes support anchored pattern queries under any locale.

The trade-off: equality (`=`) still uses the same opclass, but `<` / `>` / `<=` / `>=` against the index are using byte-order, not the locale collation. Docs: *"You should also create an index with the default operator class if you want queries involving ordinary `<`, `<=`, `>`, or `>=` comparisons to use an index. Such queries cannot use the `xxx_pattern_ops` operator classes."*[^opclass] If your workload mixes both pattern queries and ordinary ranges, you need both indexes.

> [!NOTE] PostgreSQL 15
> The starts-with operator `^@` and `starts_with()` function can use B-tree indexes when the column is in the `C` collation, instead of requiring SP-GiST.[^pg15-startswith]

### Ordering: ASC / DESC / NULLS FIRST / NULLS LAST

The default ordering of a B-tree is ascending with `NULLS LAST`. Verbatim:

> *"By default, B-tree indexes store their entries in ascending order with nulls last (table TID is treated as a tiebreaker column among otherwise equal entries). This means that a forward scan of an index on column `x` produces output satisfying `ORDER BY x` (or more verbosely, `ORDER BY x ASC NULLS LAST`). The index can also be scanned backward, producing output satisfying `ORDER BY x DESC` (or more verbosely, `ORDER BY x DESC NULLS FIRST`, since `NULLS FIRST` is the default for `ORDER BY DESC`)."*[^ordering]

The asymmetric default is the most-cited gotcha in this surface. `ORDER BY x DESC` defaults to `NULLS FIRST` (nulls at the top), but application code almost always wants nulls last regardless of direction. Spell it out.

Explicit modifiers matter in three cases:

1. **Mixed ascending and descending columns.** A plain index on `(x, y)` cannot satisfy `ORDER BY x ASC, y DESC` without sort. Declaring the index `(x ASC, y DESC)` or equivalently `(x DESC, y ASC)` (scanned backward) lets the planner skip the Sort node.
2. **`NULLS FIRST` on ascending queries.** Single-column `ORDER BY x NULLS FIRST` cannot use the default-built index efficiently in a forward scan; either declare the index `(x NULLS FIRST)` or accept the Sort.
3. **Filtering with `IS NULL`.** B-tree indexes the NULL value; `IS NULL` and `IS NOT NULL` predicates can use the index. Docs: *"an `IS NULL` or `IS NOT NULL` condition on an index column can be used with a B-tree index."*[^types]

The reverse-scan path is essentially free — leaf pages link both directions — so a `DESC` query against a default `ASC` index has the same cost as `ASC`. Only when columns have *different* sort directions does the index definition matter.

### Multicolumn leading-column rule

A multicolumn B-tree is sorted by the columns left-to-right. The classical leading-column rule applies. Verbatim:

> *"A multicolumn B-tree index can be used with query conditions that involve any subset of the index's columns, but the index is most efficient when there are constraints on the leading (leftmost) columns. The exact rule is that equality constraints on leading columns, plus any inequality constraints on the first column that does not have an equality constraint, will be used to limit the portion of the index that is scanned."*[^multicolumn]

For an index on `(a, b, c)`:

- `WHERE a = 5 AND b = 42 AND c = 77` — every column used; tight scan
- `WHERE a = 5 AND b = 42 AND c < 77` — `a`, `b` bound; `c` does a one-sided range
- `WHERE a = 5 AND b >= 42 AND c < 77` — `a` bound; `b` does a range; `c` is *post-scanned* (entries with `c >= 77` are skipped but the leaf pages still get read)
- `WHERE a = 5 AND c < 77` — `a` bound; `c` is a filter, not an index condition (pre-PG18)
- `WHERE c < 77` alone — pre-PG18, this is essentially a full index scan equivalent to a seqscan

For ordering, a query with `ORDER BY a, b, c` can use the index without sort; `ORDER BY a, c` cannot.

### Skip scan (PG18+)

> [!NOTE] PostgreSQL 18
> Docs: *"Allow skip scans of btree indexes. This allows multi-column btree indexes to be used in more cases such as when there are no restrictions on the first or early indexed columns (or there are non-equality ones), and there are useful restrictions on later indexed columns."*[^pg18-skip]

The PG18 planner can use a multicolumn B-tree even when the leading column has no equality predicate, by enumerating the distinct values of the leading column and issuing a scan per value. This partly relaxes the leading-column rule:

- An index on `(a, b)` with low-cardinality `a` (a few hundred distinct values) and a query `WHERE b = 42` becomes usable.
- It's a relaxation, not a replacement: a dedicated index on `b` is still cheaper when the leading column has high cardinality. The planner makes the decision based on `n_distinct` statistics for the leading column.

The savings show up directly in `EXPLAIN`: the plan reports `Skip Scan` or `Index Scan` with skip-scan-style cost estimates rather than the previous "must add a leading column" workaround.

### Deduplication (PG13+)

> [!NOTE] PostgreSQL 13
> Docs: *"More efficiently store duplicates in B-tree indexes. This allows efficient B-tree indexing of low-cardinality columns by storing duplicate keys only once. Users upgrading with pg_upgrade will need to use REINDEX to make an existing index use this feature."*[^pg13-dedup]

A duplicate is a leaf-page tuple where all indexed key columns match at least one other leaf-page tuple in the same index. Pre-PG13, each duplicate occupied a full index tuple (key bytes plus a TID). PG13+ merges them into a single **posting-list tuple**:

- The key appears once.
- A sorted array of TIDs follows the key.

Docs: *"Deduplication works by periodically merging groups of duplicate tuples together, forming a single posting list tuple for each group. The column key value(s) only appear once in this representation. This is followed by a sorted array of TIDs that point to rows in the table."*[^impl]

Deduplication is **enabled by default** and triggers lazily — verbatim: *"The deduplication process occurs lazily, when a new item is inserted that cannot fit on an existing leaf page, though only when index tuple deletion could not free sufficient space for the new item."*[^impl] It is the page-split-deferral mechanism that runs before bottom-up index deletion does.

Dedup cannot be used in the following cases (the index simply has dedup disabled):

- `text`, `varchar`, `char` with a **nondeterministic** collation
- `numeric` (different binary representations of the same value)
- `jsonb` (containers)
- `float4`, `float8` (NaN and zero/negative-zero have ambiguous equality)
- Container types: composite types, arrays, range types
- Indexes with `INCLUDE` columns

Control:

    -- Disable for one index
    CREATE INDEX idx ON t (col) WITH (deduplicate_items = off);

    -- Or after the fact
    ALTER INDEX idx SET (deduplicate_items = off);
    REINDEX INDEX idx;

The `pg_index.indisdeduplicated` (PG13+ equivalent via `bt_metap().allequalimage`) and the `bt_metap()` `allequalimage` field together let you check whether an index is even eligible. `allequalimage = t` means all opclass-equal values are bitwise identical, so dedup can proceed safely; `f` means the opclass disqualifies dedup.

> [!NOTE] PostgreSQL 15
> Docs: *"Allow btree indexes on system and TOAST tables to efficiently store duplicates."*[^pg15-systoast] Previously dedup was disabled for these; PG15 enables it.

### Bottom-up index deletion (PG14+)

> [!NOTE] PostgreSQL 14
> Docs: *"Allow btree index additions to remove expired index entries to prevent page splits. This is particularly helpful for reducing index bloat on tables whose indexed columns are frequently updated."*[^pg14-bottomup]

When an insert can't fit on a leaf page, PG14+ runs a **bottom-up index deletion** pass *before* splitting. The pass looks at index entries pointing to heap rows that are version churn — specifically, multiple index entries for the same logical row that differ only because the row was updated and a non-HOT update created a new index entry. If those old entries reference heap tuples that are now dead, they're removed in place.

Verbatim characterization: *"A bottom-up index deletion pass targets suspected garbage tuples in a single leaf page based on qualitative distinctions involving logical rows and versions."*[^impl] Contrast with autovacuum: autovacuum is *quantitative* (table-level dead-tuple thresholds trigger a cleanup), bottom-up deletion is *qualitative* (the impending split on a single page triggers it).

The practical impact: a frequently-updated narrow-column index that pre-PG14 would bloat unboundedly between autovacuums now stays close to its steady-state size. Tables with frequent UPDATEs on a non-HOT-eligible column see the biggest improvement.

Verbatim, secondary improvement: *"Allow vacuum to more eagerly add deleted btree pages to the free space map. Previously vacuum could only add pages to the free space map that were marked as deleted by previous vacuums."*[^pg14-fsm] This complements bottom-up deletion by making freed pages reusable more aggressively.

### Fillfactor and storage parameters

The fillfactor for a B-tree is the percentage of each leaf page that the *initial* index build fills. Verbatim:

> *"The fillfactor for an index is a percentage that determines how full the index method will try to pack index pages. For B-trees, leaf pages are filled to this percentage during initial index builds, and also when extending the index at the right (adding new largest key values). If pages subsequently become completely full, they will be split, leading to fragmentation of the on-disk index structure. B-trees use a default fillfactor of 90, but any integer value from 10 to 100 can be selected."*[^storage]

The default 90 leaves 10% headroom per leaf page for in-place updates and bottom-up deletion reclamation. Lower values are useful when:

- The indexed column is updated frequently. (Cross-reference [`30-hot-updates.md`](./30-hot-updates.md) for the HOT update rule, since an indexed-column update never qualifies for HOT.)
- You're building an append-mostly workload but expect intermittent churn on older keys.

Higher values approaching 100 are useful for read-only append-only workloads where the steady state is sequential leaf appends.

The `deduplicate_items` storage parameter (PG13+):

> *"Controls usage of the B-tree deduplication technique. Set to `ON` or `OFF` to enable or disable the optimization. The default is `ON`."*[^storage]

Both parameters can be set in `CREATE INDEX ... WITH (...)` or modified post-build via `ALTER INDEX ... SET (...)`; the latter requires `REINDEX` to take effect for existing data.

### INCLUDE columns (covering indexes, PG11+)

> [!NOTE] PostgreSQL 11
> Docs: *"Allow B-tree indexes to include columns that are not part of the search key or unique constraint, but are available to be read by index-only scans. This is enabled by the new INCLUDE clause of CREATE INDEX. It facilitates building 'covering indexes' that optimize specific types of queries. Columns can be included even if their data types don't have B-tree support."*[^pg11-include]

INCLUDE columns are stored on the leaf page alongside the key columns but do not participate in sort, uniqueness, or search qualification. They exist solely to let an **index-only scan** return them without a heap fetch.

    CREATE INDEX users_email_idx ON users (email)
      INCLUDE (display_name, created_at);

For a `SELECT email, display_name, created_at FROM users WHERE email = 'a@b.com'` query that finds the row via the visibility map, the heap is not touched. See [`22-indexes-overview.md`](./22-indexes-overview.md) for the canonical recipe and the don't-stuff-every-column warning. INCLUDE on B-tree disables deduplication for that index (the posting-list format cannot carry payload).

### Unique indexes and NULLS NOT DISTINCT (PG15+)

Docs: *"Currently, only B-tree indexes can be declared unique."*[^unique] This is a hard rule — no other index method supports `UNIQUE`. (PG18 relaxed an adjacent rule about non-B-tree unique indexes being usable as partition keys / matview targets; the requirement that B-tree is the only access method supporting UNIQUE itself is unchanged.)

Default NULL behavior: *"null values in a unique column are not considered equal, allowing multiple nulls in the column."*[^unique] A unique index on a nullable column accepts arbitrarily many NULL rows.

> [!NOTE] PostgreSQL 15
> Docs: *"Allow unique constraints and indexes to treat NULL values as not distinct. Previously NULL entries were always treated as distinct values, but this can now be changed by creating constraints and indexes using UNIQUE NULLS NOT DISTINCT."*[^pg15-nnd]

The syntax:

    CREATE UNIQUE INDEX idx ON t (col1, col2) NULLS NOT DISTINCT;

With `NULLS NOT DISTINCT`, two rows where `col1, col2` are both NULL collide and the second insert raises `unique_violation`.

> [!NOTE] PostgreSQL 16
> Docs: *"Disallow NULLS NOT DISTINCT indexes for primary keys."*[^pg16-nnd-pk] Primary-key columns are `NOT NULL` by definition, so the clause is meaningless and PG16 rejects it at DDL time.

Multicolumn unique rule: *"A multicolumn unique index will only reject cases where all indexed columns are equal in multiple rows."*[^unique] Partial-column matches do not violate uniqueness.

### Index-only scans and the visibility map

A B-tree index-only scan returns rows from the index without touching the heap. Verbatim:

> *"PostgreSQL supports index-only scans, which can answer queries from an index alone without any heap access. The basic idea is to return values directly out of each index entry instead of consulting the associated heap entry."*[^ios]

Two requirements:

1. **The index must store every column the query references** — either as a key column or via `INCLUDE`. *"The index type must support index-only scans. B-tree indexes always do."*[^ios]
2. **The visibility map must indicate the heap page is all-visible.** Docs: *"Visibility information is not stored in index entries, only in heap entries; so at first glance it would seem that every row retrieval would require a heap access anyway. ... PostgreSQL tracks, for each page in a table's heap, whether all rows stored in that page are old enough to be visible to all current and future transactions. This information is stored in a bit in the table's visibility map. An index-only scan, after finding a candidate index entry, checks the visibility map bit for the corresponding heap page. If it's set, the row is known visible and so the data can be returned with no further work."*[^ios]

`EXPLAIN (ANALYZE, BUFFERS)` shows `Heap Fetches: N` for an index-only scan. `N > 0` means the visibility map was not set on at least N heap pages and the heap was visited anyway. Cause: insufficient autovacuum frequency, or a long-running transaction blocking xmin advance and pinning the visibility map open. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

Verbatim closing rule: *"In short, while an index-only scan is possible given the two fundamental requirements, it will be a win only if a significant fraction of the table's heap pages have their all-visible map bits set. But tables in which a large fraction of the rows are unchanging are common enough to make this type of scan very useful in practice."*[^ios]

### Parallel index build (PG11+)

> [!NOTE] PostgreSQL 11
> Docs: *"Allow parallel building of a btree index."*[^pg11-parallel] `CREATE INDEX` (without `CONCURRENTLY`) parallelizes the sort phase across `max_parallel_maintenance_workers` (default 2 since PG11). On a large table, this is a 2–4× build-time reduction.

Parallel build does not apply to `CREATE INDEX CONCURRENTLY`. The CONCURRENTLY variant intentionally does extra scans to avoid blocking writes; parallel workers are not coordinated with that protocol.

Maintenance settings:

    SET maintenance_work_mem = '4GB';     -- per-process sort memory
    SET max_parallel_maintenance_workers = 8;
    CREATE INDEX idx ON huge_table (col); -- parallel sort if planner picks it

### Functional (expression) B-tree indexes

A B-tree can index an expression rather than a bare column. The expression must be `IMMUTABLE` — verbatim from `CREATE INDEX`: index expressions are evaluated once per insert and once per matching query, and the planner only considers an expression index when the query's expression is *syntactically* identical to the indexed expression.

    -- Case-insensitive email lookup; index covers any query of the same shape
    CREATE INDEX users_lower_email_idx ON users (lower(email));
    SELECT * FROM users WHERE lower(email) = lower($1);

    -- Day-bucket on a timestamptz column for hourly analytics
    CREATE INDEX events_day_idx ON events (date_trunc('day', occurred_at));
    SELECT count(*) FROM events
    WHERE date_trunc('day', occurred_at) = '2026-03-01';

> [!NOTE] PostgreSQL 16
> The three-argument form `date_trunc(unit, timestamptz, time_zone)` was reclassified as `IMMUTABLE` in PG16, enabling expression indexes on bucketed-with-zone timestamps. See [`19-timestamp-timezones.md`](./19-timestamp-timezones.md).

The function used in the indexed expression must be `IMMUTABLE`, never `STABLE` or `VOLATILE`. Common traps:

- `now()` / `current_date` — `STABLE` per-transaction, but mutable across transactions.
- `to_char(timestamptz, ...)` — `STABLE`, depends on the session's `DateStyle` / `TimeZone`.
- `lower(text)` — `IMMUTABLE` *only* under a deterministic collation; an `IMMUTABLE` lower on a nondeterministic-collation column will fail at index build.

Expression indexes don't deduplicate (the expression result is computed and stored, but the opclass may not advertise `equalimage`). Inspect `bt_metap().allequalimage` to confirm.

### Partial B-tree indexes

A partial B-tree includes only rows that satisfy a `WHERE` predicate. The predicate must be `IMMUTABLE`. Three canonical uses:

1. **Skip a dominant value.** A `status` column where 99% of rows are `'active'` and 1% are `'pending'` benefits from indexing only the minority:

        CREATE INDEX orders_pending_idx ON orders (created_at)
        WHERE status = 'pending';

   Query must include the same predicate exactly: `WHERE status = 'pending' AND created_at > now() - interval '1 hour'`.

2. **Subset uniqueness.** "Each user has at most one active subscription":

        CREATE UNIQUE INDEX subs_one_active_idx ON subscriptions (user_id)
        WHERE deleted_at IS NULL;

3. **Hot narrow paths.** A `priority = 'high'` queue lane that's served by a dedicated B-tree, leaving a separate index for the slow lane.

The predicate must match the query *shape*, not just truth value. `WHERE status IN ('pending')` is not the same as `WHERE status = 'pending'` for predicate-matching purposes; the planner's predicate-implication prover is conservative.

### B-tree corruption detection (amcheck)

The `amcheck` contrib extension exposes two B-tree integrity checkers:

| Function | Scope | Privileges |
|---|---|---|
| `bt_index_check(index regclass, heapallindexed bool)` | Index alone, plus optional heap-vs-index consistency | Requires `AccessShareLock` on the index |
| `bt_index_parent_check(index regclass, heapallindexed bool, rootdescend bool)` | More thorough; verifies parent-child relationships | Requires `ShareLock` on the index — blocks writes |

Canonical usage on a suspected-corrupt index:

    CREATE EXTENSION IF NOT EXISTS amcheck;

    -- Light, non-blocking check
    SELECT bt_index_check('users_email_idx', heapallindexed => true);

    -- Heavy check; takes a ShareLock — schedule a maintenance window
    SELECT bt_index_parent_check('users_email_idx',
                                 heapallindexed => true,
                                 rootdescend    => true);

Both functions raise an error on the first inconsistency they find. A clean run prints the function name and an empty result; a corrupt index raises one of several `XX002` (`index_corrupted`) errors describing the violation (ordering invariant, downlink mismatch, heap-vs-index disagreement).

The most common cause of B-tree corruption in field reports is a libc / ICU collation upgrade that silently changed text sort order. See [`65-collations-encoding.md`](./65-collations-encoding.md). The second most common is hardware corruption on a server without `data_checksums` enabled — see [`88-corruption-recovery.md`](./88-corruption-recovery.md).

### pageinspect functions

The `pageinspect` extension exposes three core B-tree inspection functions (PG16 added a fourth):

| Function | Returns | Use |
|---|---|---|
| `bt_metap(relname)` | metapage record | Magic, version, root, level, fastroot, fastlevel, last_cleanup_num_delpages, last_cleanup_num_tuples, allequalimage |
| `bt_page_stats(relname, blkno)` | leaf/internal page summary | type ('r'/'l'/'i'/'e'), live_items, dead_items, avg_item_size, free_size, btpo_prev/next/level/flags |
| `bt_page_items(relname, blkno)` | per-item details | itemoffset, ctid, itemlen, nulls, vars, data, dead, htid, tids[] |
| `bt_multi_page_stats(...)` | range of pages | PG16+ |

> [!NOTE] PostgreSQL 16
> Docs: *"Add pageinspect function `bt_multi_page_stats()` to report statistics on multiple pages. This is similar to `bt_page_stats()` except it can report on a range of pages."*[^pg16-multipage]

Canonical use: inspect dedup posting lists vs single-TID entries by reading `bt_page_items()` — when `tids` is non-empty for a row, that row is a posting-list tuple containing multiple heap TIDs.

## Per-Version Timeline

| Version | Change | Citation |
|---|---|---|
| PG11 | `INCLUDE` clause for covering indexes; parallel B-tree build | [^pg11-include] [^pg11-parallel] |
| PG13 | Deduplication enabled by default for B-tree (REINDEX required after pg_upgrade to take effect) | [^pg13-dedup] |
| PG14 | Bottom-up index deletion; VACUUM more eagerly returns deleted B-tree pages to FSM | [^pg14-bottomup] [^pg14-fsm] |
| PG15 | `NULLS NOT DISTINCT` for unique indexes; `^@` and `starts_with()` use B-tree under C collation; dedup enabled on system / TOAST tables | [^pg15-nnd] [^pg15-startswith] [^pg15-systoast] |
| PG16 | `NULLS NOT DISTINCT` disallowed on primary keys; `bt_multi_page_stats()` pageinspect function | [^pg16-nnd-pk] [^pg16-multipage] |
| PG17 | B-tree IN-list optimization (more efficient multi-value lookups) | [^pg17-inlist] |
| PG18 | Skip scan for multicolumn B-tree; sorted range builds; non-btree unique as partition key / matview target | [^pg18-skip] [^pg18-sortedrange] [^pg18-nonbtreeunique] |

## Examples / Recipes

### Recipe 1 — Inspect a real index with pageinspect

    CREATE EXTENSION IF NOT EXISTS pageinspect;

    -- Top-level metadata
    SELECT * FROM bt_metap('users_email_idx');

    -- The leaf page containing block 1
    SELECT * FROM bt_page_stats('users_email_idx', 1);

    -- Every item on block 1 (look at tids[] to spot posting-list tuples)
    SELECT itemoffset, ctid, itemlen, dead, htid,
           array_length(tids, 1) AS tid_count
    FROM bt_page_items('users_email_idx', 1)
    LIMIT 20;

`tid_count > 1` means the entry is a posting-list (deduplicated) tuple. `dead = t` means the entry is logically deleted but not yet reclaimed (will be cleaned by bottom-up deletion or VACUUM).

### Recipe 2 — Check deduplication eligibility and ratio

    -- Is this index even allowed to deduplicate?
    SELECT relname, allequalimage
    FROM bt_metap('orders_status_idx') m
    CROSS JOIN pg_class c
    WHERE c.relname = 'orders_status_idx';

    -- Index size relative to table; useful as a coarse dedup-effectiveness signal
    SELECT pg_size_pretty(pg_relation_size('orders_status_idx')) AS index_size,
           pg_size_pretty(pg_relation_size('orders'))            AS table_size,
           (pg_relation_size('orders_status_idx')::float /
            pg_relation_size('orders')) AS index_to_table_ratio;

For a low-cardinality column on PG13+, dedup typically keeps the index/table ratio under 0.10. A ratio above 0.30 after `REINDEX` suggests dedup is disabled (check `allequalimage`) or the column has high cardinality after all.

### Recipe 3 — text_pattern_ops for anchored LIKE

    -- Default opclass (collation-aware) — does NOT support LIKE 'foo%' under non-C collations
    CREATE INDEX users_email_default_idx ON users (email);

    -- Pattern opclass (byte-order) — supports LIKE 'foo%' under any collation
    CREATE INDEX users_email_pattern_idx ON users (email text_pattern_ops);

    -- Both indexes coexist; planner picks the right one per query
    EXPLAIN (ANALYZE) SELECT * FROM users WHERE email = 'a@b.com';       -- default
    EXPLAIN (ANALYZE) SELECT * FROM users WHERE email LIKE 'admin%';     -- pattern

Cross-reference [`22-indexes-overview.md`](./22-indexes-overview.md) recipe 8 for the canonical LIKE-prefix fix.

### Recipe 4 — Mixed-direction multicolumn sort

A leaderboard ordered newest-first by date, then alphabetical by name within a date:

    -- Plain (a, b) index — cannot satisfy ORDER BY a DESC, b ASC
    CREATE INDEX scores_date_name_idx ON scores (event_date, name);

    -- Mixed-direction index — does satisfy it (and ORDER BY a ASC, b DESC scanned backward)
    CREATE INDEX scores_date_name_idx2 ON scores (event_date DESC, name ASC);

    EXPLAIN (ANALYZE) SELECT *
    FROM scores
    ORDER BY event_date DESC, name ASC
    LIMIT 100;

Without the mixed-direction index, the planner adds a Sort node on top of either an Index Scan + heap fetch or a Seq Scan. Look for the absence of `Sort` in the plan as the success signal.

### Recipe 5 — Covering index with INCLUDE for index-only scan

    -- Hot query: profile lookup by user_id returns three columns
    CREATE INDEX users_id_cover_idx ON users (id)
      INCLUDE (email, display_name);

    -- Verify index-only scan with Heap Fetches: 0
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT id, email, display_name FROM users WHERE id = 42;

If `Heap Fetches: > 0` appears, autovacuum has not yet set the visibility map for the heap pages those rows live on. Force it with `VACUUM users;` and re-EXPLAIN.

### Recipe 6 — Audit fillfactor on hot-UPDATE tables

    SELECT
      c.relname,
      i.relname AS index_name,
      coalesce(
        (SELECT option_value::int
         FROM pg_options_to_table(i.reloptions)
         WHERE option_name = 'fillfactor'),
        90
      ) AS fillfactor,
      pg_size_pretty(pg_relation_size(i.oid)) AS index_size
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_am am   ON am.oid = i.relam
    WHERE am.amname = 'btree'
      AND c.relkind IN ('r', 'p')
      AND c.relnamespace NOT IN
          (SELECT oid FROM pg_namespace
           WHERE nspname IN ('pg_catalog', 'information_schema'))
    ORDER BY pg_relation_size(i.oid) DESC
    LIMIT 50;

Indexes on tables with high `pg_stat_user_tables.n_tup_upd` and a default fillfactor of 90 may benefit from lower fillfactor (70–80). Tables with high `n_tup_hot_upd` ratio already exploit HOT and don't need lower fillfactor on every index. Cross-reference [`30-hot-updates.md`](./30-hot-updates.md).

### Recipe 7 — Skip scan candidate audit (PG18+)

    -- Find multicolumn B-tree indexes where the leading column has low cardinality.
    -- These are candidates for PG18 skip scan working out of the box.
    SELECT
      c.relname AS table_name,
      i.relname AS index_name,
      pg_get_indexdef(x.indexrelid) AS index_def,
      s.n_distinct AS leading_col_n_distinct,
      array_to_string(x.indkey::int[], ',') AS keycols
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_am am   ON am.oid = i.relam
    JOIN pg_attribute a
      ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
    JOIN pg_stats s
      ON s.schemaname = (SELECT nspname FROM pg_namespace WHERE oid = c.relnamespace)
     AND s.tablename  = c.relname
     AND s.attname    = a.attname
    WHERE am.amname = 'btree'
      AND array_length(x.indkey, 1) > 1
      AND c.relkind IN ('r', 'p')
      AND (s.n_distinct BETWEEN 1 AND 500
           OR (s.n_distinct < 0 AND s.n_distinct > -0.001));

On PG18+, queries that historically did Seq Scan because they only constrained later columns may flip to Skip Scan automatically. Test by re-EXPLAINing the slow queries after the upgrade.

### Recipe 8 — Post-pg_upgrade REINDEX to enable dedup

After `pg_upgrade` from PG12 or earlier to PG13+, existing B-tree indexes do not have the on-disk deduplicated layout. The PG13 release notes are explicit:

> *"Users upgrading with pg_upgrade will need to use REINDEX to make an existing index use this feature."*[^pg13-dedup]

Plan REINDEX CONCURRENTLY (PG12+) for every B-tree index on tables with low-cardinality indexed columns:

    -- Inventory of large B-tree indexes on low-cardinality columns
    SELECT
      n.nspname,
      i.relname AS index_name,
      pg_size_pretty(pg_relation_size(i.oid)) AS size
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE am.amname = 'btree'
      AND pg_relation_size(i.oid) > 100 * 1024 * 1024  -- >100 MB
    ORDER BY pg_relation_size(i.oid) DESC;

    -- Rebuild one at a time
    REINDEX INDEX CONCURRENTLY some_schema.large_btree_idx;

### Recipe 9 — Bottom-up deletion verification

The cleanest signal is `n_tup_upd` divided by index size growth over a fixed window. On a busy UPDATE-heavy table:

    -- Before
    SELECT relname, pg_size_pretty(pg_relation_size(oid)) FROM pg_class
    WHERE relname = 'my_btree_idx';
    -- ... run workload for an hour ...
    -- After
    SELECT relname, pg_size_pretty(pg_relation_size(oid)) FROM pg_class
    WHERE relname = 'my_btree_idx';

Pre-PG14, a write-heavy update workload on a non-HOT-eligible column grew the index continuously until VACUUM. PG14+, the steady-state size is much tighter — bottom-up deletion runs at every would-be page split. If you still see unbounded growth on PG14+, autovacuum may be falling behind ([`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)) or the index has been disabled for dedup (`allequalimage = f` in `bt_metap()`).

### Recipe 10 — Find oversized B-tree entries (1/3-page rule)

    -- TOAST-compressed index tuples cannot exceed ~2,700 bytes on an 8 KB page.
    -- Indexing very wide text columns is technically allowed but can fail at insert time.
    SELECT
      i.relname AS index_name,
      pg_size_pretty(pg_relation_size(i.oid)) AS size,
      a.attname  AS column_name,
      t.typname  AS column_type
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_am am   ON am.oid = i.relam
    JOIN pg_attribute a
      ON a.attrelid = x.indrelid AND a.attnum = ANY(x.indkey)
    JOIN pg_type t  ON t.oid = a.atttypid
    WHERE am.amname = 'btree'
      AND t.typname IN ('text', 'varchar', 'bpchar', 'bytea', 'jsonb')
      AND a.attlen = -1;

Index entries over the limit raise `index row size N exceeds btree version 4 maximum 2704 for index "..."`. Mitigation: index `md5(col)` (or `digest(col, 'sha256')` from pgcrypto) instead, or use a GIN trigram index for substring searches via [`93-pg-trgm.md`](./93-pg-trgm.md).

## Gotchas / Anti-patterns

1. **B-tree on `jsonb` indexes the binary representation, not extracted fields.** A B-tree on a `jsonb` column compares by `jsonb_cmp_internal`, which produces an opaque sort order. To index a hot field, use a functional B-tree (`CREATE INDEX ... ON t ((doc->>'k'))`) or a GIN index. See [`17-json-jsonb.md`](./17-json-jsonb.md).
2. **`<>` is not in the B-tree opclass.** A `WHERE col <> 'value'` predicate cannot use the index directly; the planner falls back to a heap scan or a bitmap with a negated condition. Docs: *"`<>` should also be part of the operator class, but it is not, because it would almost never be useful to use a `<>` WHERE clause in an index search."*[^behavior]
3. **`LIKE '%foo'` and `~ 'foo$'` cannot use B-tree.** Only anchored prefix patterns are indexable. Reverse-string functional indexes are one workaround; `pg_trgm` GIN indexes are usually the right choice — see [`93-pg-trgm.md`](./93-pg-trgm.md).
4. **`ILIKE 'foo%'` only uses B-tree if `foo` starts with a non-letter.** Letter case-folding is not byte-order-monotone under standard collations. Workaround: index `lower(col)` (functional B-tree) and query with `lower(col) LIKE lower('foo%')`. See [`22-indexes-overview.md`](./22-indexes-overview.md) recipe 5.
5. **Default `NULLS FIRST` on `ORDER BY ... DESC`.** Application code that wants `ORDER BY created_at DESC NULLS LAST` will, by default, get nulls at the top. Either spell out `NULLS LAST` in the query or build the index `(created_at DESC NULLS LAST)`.
6. **Leading-column rule (pre-PG18).** `WHERE last_col = X` on an index `(first_col, last_col)` was effectively useless before PG18 unless `first_col` was also constrained. PG18 skip scan partially relaxes this when `first_col` has low cardinality; a dedicated index on `last_col` is still usually better for high-cardinality leading columns.
7. **Dedup disabled when you don't expect it.** `numeric`, `float`, `jsonb`, container types, and `INCLUDE` indexes all disable dedup. A "low cardinality" `numeric(10,2)` price column shows poor dedup ratios because `1.0` and `1.00` have different binary representations.
8. **`allequalimage = false` from a nondeterministic collation.** PG12+ allows custom collations with `deterministic = false` (e.g., case-insensitive UNIQUE). Text B-tree indexes on those columns disable dedup because byte-different values can compare equal. The trade-off — case-insensitive uniqueness — is usually worth the bloat.
9. **`UNIQUE` columns admit infinite NULLs by default.** Unless you add `NULLS NOT DISTINCT` (PG15+), a UNIQUE constraint allows arbitrarily many rows with NULL in the unique column. Combined with `NULL` in a multi-column unique index, this is a common "why did my soft-delete dup-check fail?" trap.
10. **`NULLS NOT DISTINCT` not allowed on primary keys (PG16+).** A primary key is `NOT NULL`; the clause is meaningless. PG16 rejects it at DDL time.[^pg16-nnd-pk]
11. **Bottom-up deletion does not replace VACUUM.** It defers page splits but does not update the visibility map. Autovacuum is still required for index-only-scan eligibility (see §Index-only scans).
12. **INCLUDE columns disable deduplication.** See §Deduplication. A covering index on a high-duplicate key with wide INCLUDE payload can be larger than two separate indexes (one dedup-eligible for filtering, one covering for IOS).
13. **`REINDEX` after pg_upgrade from PG12 or earlier is mandatory for dedup.** See §Deduplication and Recipe 8 above. The same applies if `deduplicate_items = off` was ever set and later reset to `on`.[^pg13-dedup]
14. **A libc or ICU collation upgrade silently invalidates text B-trees.** Collation version embedded in the index no longer matches runtime; unique constraints can be silently violated, range queries can return wrong results. See [`65-collations-encoding.md`](./65-collations-encoding.md) and `pg_collation.collversion`.
15. **Single-column descending indexes are usually unnecessary.** Leaf pages are doubly linked; a forward `ASC` index scan in reverse satisfies `ORDER BY x DESC` at the same cost. Build `(x DESC)` only when combined with a different-direction column in a multicolumn index.
16. **`fillfactor` matters less than expected on the indexed column itself.** Fillfactor primarily affects the *heap* table — leaving space for HOT updates. The B-tree's own fillfactor mainly affects bottom-up-deletion headroom on UPDATE-heavy non-HOT-eligible columns.
17. **B-tree is not a sort substitute for ad-hoc DISTINCT.** An Index Scan does return rows in index order, but `SELECT DISTINCT col FROM big_table` rarely uses an index alone — the planner usually picks HashAggregate or GroupAggregate. A B-tree on `col` becomes useful only when combined with a `LIMIT` for top-N distinct.
18. **`bt_metap().allequalimage = f` is informational, not an error.** Many legitimate B-trees disable dedup (numeric, jsonb, container). The signal is only worth investigating when the column is `text`, `varchar`, or `char` and the cardinality looks low — that's where dedup should help and the `f` flag indicates a nondeterministic collation or some other disqualifier.
19. **Index entry > 1/3 page raises at insert time.** Wide indexed text columns work fine for short rows and fail for long rows. The error is `index row size ... exceeds btree version 4 maximum`. Plan ahead with a hash-of-content functional index or a GIN trigram index.
20. **CONCURRENTLY does not parallelize.** `CREATE INDEX CONCURRENTLY` skips parallel workers by design. Production builds on huge tables take much longer than the non-concurrent equivalent. Plan accordingly. See [`26-index-maintenance.md`](./26-index-maintenance.md).
21. **The catalog version of `pg_index.indisready` vs `indisvalid`.** A `CREATE INDEX CONCURRENTLY` that fails halfway leaves the index `indisvalid = false` but takes up disk space and slows writes. Always audit and drop invalid indexes:

        SELECT n.nspname, c.relname AS table_name, i.relname AS index_name,
               x.indisvalid, x.indisready
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class c ON c.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE NOT x.indisvalid OR NOT x.indisready;

22. **Skip scan is a planner choice, not a query rewrite.** PG18 may or may not pick skip scan depending on the leading column's `n_distinct`. If it doesn't pick it when you expected, run `ANALYZE` (statistics may be stale) and re-check with `EXPLAIN`. A `pg_stats.n_distinct` of `-1` (every row distinct) disqualifies skip scan.
23. **Parallel build memory is per-worker.** `maintenance_work_mem = '4GB'` with `max_parallel_maintenance_workers = 8` budgets up to 32 GB. Set them deliberately on memory-constrained machines.

## See Also

- [`22-indexes-overview.md`](./22-indexes-overview.md) — picker file: which index for which workload
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN and GiST deep dive
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — alternative access methods
- [`26-index-maintenance.md`](./26-index-maintenance.md) — CREATE/REINDEX CONCURRENTLY, bloat detection, pg_repack
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — visibility map, autovacuum scheduling
- [`30-hot-updates.md`](./30-hot-updates.md) — HOT update rule, fillfactor on heap tables
- [`55-statistics-planner.md`](./55-statistics-planner.md) — n_distinct and skip-scan decisions
- [`56-explain.md`](./56-explain.md) — reading Index Scan / Index Only Scan / Bitmap Heap Scan
- [`65-collations-encoding.md`](./65-collations-encoding.md) — libc / ICU upgrades and text index invalidation
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — hardware corruption detection via data_checksums and amcheck
- [`19-timestamp-timezones.md`](./19-timestamp-timezones.md) — PG16 date_trunc IMMUTABLE reclassification for expression indexes
- [`93-pg-trgm.md`](./93-pg-trgm.md) — substring search alternative

## Sources

[^intro]: PG 16 docs, "67.1. Introduction" (B-Tree Indexes chapter). Docs: *"PostgreSQL includes an implementation of the standard btree (multi-way balanced tree) index data structure. Any data type that can be sorted into a well-defined linear order can be indexed by a btree index."* and *"The only limitation is that an index entry cannot exceed approximately one-third of a page (after TOAST compression, if applicable)."* https://www.postgresql.org/docs/16/btree-intro.html
[^impl]: PG 16 docs, "67.4. Implementation" (B-Tree Indexes chapter). Docs: *"PostgreSQL B-Tree indexes are multi-level tree structures, where each level of the tree can be used as a doubly-linked list of pages. A single metapage is stored in a fixed position at the start of the first segment file of the index."* and *"All other pages are either leaf pages or internal pages. Leaf pages are the pages on the lowest level of the tree. ... Typically, over 99% of all pages are leaf pages."* and *"Deduplication works by periodically merging groups of duplicate tuples together, forming a single posting list tuple for each group."* and *"The deduplication process occurs lazily, when a new item is inserted that cannot fit on an existing leaf page, though only when index tuple deletion could not free sufficient space for the new item."* and *"A bottom-up index deletion pass targets suspected garbage tuples in a single leaf page based on qualitative distinctions involving logical rows and versions."* https://www.postgresql.org/docs/16/btree-implementation.html
[^behavior]: PG 16 docs, "67.2. Behavior of B-Tree Operator Classes". Docs: *"a btree operator class must provide five comparison operators, <, <=, =, >= and >."* and *"<> should also be part of the operator class, but it is not, because it would almost never be useful to use a <> WHERE clause in an index search."* and *"it would not work to put float8 and numeric into the same operator family, at least not with the current semantics that numeric values are converted to float8 for comparison to a float8."* https://www.postgresql.org/docs/16/btree-behavior.html
[^types]: PG 16 docs, "11.2. Index Types". Docs: *"B-trees can handle equality and range queries on data that can be sorted into some ordering."* and *"Also, an `IS NULL` or `IS NOT NULL` condition on an index column can be used with a B-tree index."* and *"By default, the CREATE INDEX command creates B-tree indexes, which fit the most common situations."* https://www.postgresql.org/docs/16/indexes-types.html
[^opclass]: PG 16 docs, "11.10. Operator Classes and Operator Families". Docs: *"The difference from the default operator classes is that the values are compared strictly character by character rather than according to the locale-specific collation rules."* and *"You should also create an index with the default operator class if you want queries involving ordinary <, <=, >, or >= comparisons to use an index. Such queries cannot use the xxx_pattern_ops operator classes."* https://www.postgresql.org/docs/16/indexes-opclass.html
[^ordering]: PG 16 docs, "11.4. Indexes and ORDER BY". Docs: *"By default, B-tree indexes store their entries in ascending order with nulls last (table TID is treated as a tiebreaker column among otherwise equal entries). This means that a forward scan of an index on column x produces output satisfying ORDER BY x (or more verbosely, ORDER BY x ASC NULLS LAST). The index can also be scanned backward, producing output satisfying ORDER BY x DESC (or more verbosely, ORDER BY x DESC NULLS FIRST, since NULLS FIRST is the default for ORDER BY DESC)."* https://www.postgresql.org/docs/16/indexes-ordering.html
[^multicolumn]: PG 16 docs, "11.3. Multicolumn Indexes". Docs: *"A multicolumn B-tree index can be used with query conditions that involve any subset of the index's columns, but the index is most efficient when there are constraints on the leading (leftmost) columns. The exact rule is that equality constraints on leading columns, plus any inequality constraints on the first column that does not have an equality constraint, will be used to limit the portion of the index that is scanned."* https://www.postgresql.org/docs/16/indexes-multicolumn.html
[^ios]: PG 16 docs, "11.9. Index-Only Scans and Covering Indexes". Docs: *"PostgreSQL supports index-only scans, which can answer queries from an index alone without any heap access. The basic idea is to return values directly out of each index entry instead of consulting the associated heap entry."* and *"The index type must support index-only scans. B-tree indexes always do."* and *"PostgreSQL tracks, for each page in a table's heap, whether all rows stored in that page are old enough to be visible to all current and future transactions. This information is stored in a bit in the table's visibility map."* https://www.postgresql.org/docs/16/indexes-index-only-scans.html
[^unique]: PG 16 docs, "11.7. Unique Indexes". Docs: *"Currently, only B-tree indexes can be declared unique."* and *"null values in a unique column are not considered equal, allowing multiple nulls in the column."* and *"A multicolumn unique index will only reject cases where all indexed columns are equal in multiple rows."* https://www.postgresql.org/docs/16/indexes-unique.html
[^storage]: PG 16 docs, "CREATE INDEX". Docs: *"The fillfactor for an index is a percentage that determines how full the index method will try to pack index pages. ... B-trees use a default fillfactor of 90, but any integer value from 10 to 100 can be selected."* and *"Controls usage of the B-tree deduplication technique. ... The default is ON."* https://www.postgresql.org/docs/16/sql-createindex.html
[^pageinspect]: PG 16 docs, "F.25. pageinspect — low-level inspection of database pages". Documents `bt_metap`, `bt_page_stats`, `bt_page_items`, and (PG16+) `bt_multi_page_stats`. https://www.postgresql.org/docs/16/pageinspect.html
[^pg11-include]: PG 11 release notes. Docs: *"Allow B-tree indexes to include columns that are not part of the search key or unique constraint, but are available to be read by index-only scans (Anastasia Lubennikova, Alexander Korotkov, Teodor Sigaev). This is enabled by the new INCLUDE clause of CREATE INDEX. It facilitates building 'covering indexes' that optimize specific types of queries. Columns can be included even if their data types don't have B-tree support."* https://www.postgresql.org/docs/release/11.0/
[^pg11-parallel]: PG 11 release notes. Docs: *"Allow parallel building of a btree index (Peter Geoghegan, Rushabh Lathia, Heikki Linnakangas)"* https://www.postgresql.org/docs/release/11.0/
[^pg13-dedup]: PG 13 release notes. Docs: *"More efficiently store duplicates in B-tree indexes (Anastasia Lubennikova, Peter Geoghegan). This allows efficient B-tree indexing of low-cardinality columns by storing duplicate keys only once. Users upgrading with pg_upgrade will need to use REINDEX to make an existing index use this feature."* https://www.postgresql.org/docs/release/13.0/
[^pg14-bottomup]: PG 14 release notes. Docs: *"Allow btree index additions to remove expired index entries to prevent page splits (Peter Geoghegan). This is particularly helpful for reducing index bloat on tables whose indexed columns are frequently updated."* https://www.postgresql.org/docs/release/14.0/
[^pg14-fsm]: PG 14 release notes. Docs: *"Allow vacuum to more eagerly add deleted btree pages to the free space map (Peter Geoghegan). Previously vacuum could only add pages to the free space map that were marked as deleted by previous vacuums."* https://www.postgresql.org/docs/release/14.0/
[^pg15-nnd]: PG 15 release notes. Docs: *"Allow unique constraints and indexes to treat NULL values as not distinct (Peter Eisentraut). Previously NULL entries were always treated as distinct values, but this can now be changed by creating constraints and indexes using UNIQUE NULLS NOT DISTINCT."* https://www.postgresql.org/docs/release/15.0/
[^pg15-startswith]: PG 15 release notes. Docs: *"Allow the ^@ starts-with operator and the starts_with() function to use btree indexes if using the C collation (Tom Lane). Previously these could only use SP-GiST indexes."* https://www.postgresql.org/docs/release/15.0/
[^pg15-systoast]: PG 15 release notes. Docs: *"Allow btree indexes on system and TOAST tables to efficiently store duplicates (Peter Geoghegan). Previously de-duplication was disabled for these types of indexes."* https://www.postgresql.org/docs/release/15.0/
[^pg16-nnd-pk]: PG 16 release notes (Migration section). Docs: *"Disallow NULLS NOT DISTINCT indexes for primary keys (Daniel Gustafsson)."* https://www.postgresql.org/docs/release/16.0/
[^pg16-multipage]: PG 16 release notes. Docs: *"Add pageinspect function bt_multi_page_stats() to report statistics on multiple pages (Hamid Akhtar). This is similar to bt_page_stats() except it can report on a range of pages."* https://www.postgresql.org/docs/release/16.0/
[^pg17-inlist]: PG 17 release notes. Docs: *"Allow btree indexes to more efficiently find a set of values, such as those supplied by IN clauses using constants (Peter Geoghegan, Matthias van de Meent)."* https://www.postgresql.org/docs/release/17.0/
[^pg18-skip]: PG 18 release notes. Docs: *"Allow skip scans of btree indexes (Peter Geoghegan). This allows multi-column btree indexes to be used in more cases such as when there are no restrictions on the first or early indexed columns (or there are non-equality ones), and there are useful restrictions on later indexed columns."* https://www.postgresql.org/docs/18/release-18.html
[^pg18-sortedrange]: PG 18 release notes. Docs: *"Allow values to be sorted to speed range-type GiST and btree index builds (Bernd Helmle)."* https://www.postgresql.org/docs/18/release-18.html
[^pg18-nonbtreeunique]: PG 18 release notes. Docs: *"Allow non-btree unique indexes to be used as partition keys and in materialized views (Mark Dilger). The index type must still support equality."* https://www.postgresql.org/docs/18/release-18.html
[^collations]: PG 16 docs, "11.5. Indexes and Collations". Docs: *"An index can support only one collation per index column. If multiple collations are of interest, multiple indexes may be needed."* https://www.postgresql.org/docs/16/indexes-collations.html

# Indexing Strategy


Postgres has five index access methods. Knowing which to pick and how to use partial/expression/covering indexes is the difference between a query that scans 10M rows and one that probes 12 pages.

## Table of Contents

- [The Five Index Types](#the-five-index-types)
- [B-tree: The Default](#b-tree-the-default)
- [Composite Indexes and Column Order](#composite-indexes-and-column-order)
- [Partial Indexes](#partial-indexes)
- [Covering Indexes with INCLUDE](#covering-indexes-with-include)
- [Expression Indexes](#expression-indexes)
- [GIN: Arrays, JSONB, Full-Text](#gin-arrays-jsonb-full-text)
- [GiST: Ranges, Geospatial, Custom](#gist-ranges-geospatial-custom)
- [BRIN: Huge Append-Only Tables](#brin-huge-append-only-tables)
- [Unique Indexes vs UNIQUE Constraints](#unique-indexes-vs-unique-constraints)
- [Maintenance: REINDEX, Bloat, VACUUM](#maintenance-reindex-bloat-vacuum)
- [When NOT to Add an Index](#when-not-to-add-an-index)

---

## The Five Index Types

| Type | Best for |
|------|----------|
| **B-tree** | Equality and range on scalar values (default) |
| **Hash** | Equality only — rarely useful; B-tree handles equality too |
| **GIN** | Membership queries on arrays, JSONB, tsvector (full-text) |
| **GiST** | Range overlap, geospatial, custom data types |
| **BRIN** | Very large tables where row order correlates with column (time series) |

99% of the time it's B-tree, GIN, or BRIN. GiST when you need ranges/geo. Hash almost never.

## B-tree: The Default

    CREATE INDEX customer_email_idx ON customer(email);

Supports `=`, `<`, `>`, `<=`, `>=`, `BETWEEN`, `IN`, sort ordering, and prefix `LIKE 'abc%'`.

Doesn't help with: suffix `LIKE '%abc'`, contains `LIKE '%abc%'` (use trigram + GIN), regex without anchored prefix, function calls on the column (use expression index).

## Composite Indexes and Column Order

Composite indexes work for **leftmost prefix** of the column list:

    CREATE INDEX order_lookup_idx ON orders(customer_no, status, ordered_at);

This index serves:

- `WHERE customer_no = X`
- `WHERE customer_no = X AND status = Y`
- `WHERE customer_no = X AND status = Y AND ordered_at > Z`
- `WHERE customer_no = X ORDER BY status, ordered_at`

But **does not efficiently serve** `WHERE status = Y` alone — `status` is not the leftmost column.

**Column order rules:**

1. Equality predicates first, range predicates last
2. Most selective column first (rough heuristic)
3. Match the dominant access pattern; secondary patterns may need their own index

## Partial Indexes

Index only the rows that match a predicate — smaller, faster, and lets you express domain constraints:

    -- Only active customers (skips soft-deleted)
    CREATE INDEX customer_email_idx
        ON customer(email) WHERE deleted_at IS NULL;

    -- Only pending/retry queue items
    CREATE INDEX notification_queue_claim_idx
        ON notification_queue(scheduled_for)
        WHERE status IN ('pending', 'retry');

    -- Only verified email addresses
    CREATE UNIQUE INDEX customer_verified_email_unique
        ON customer(email) WHERE is_verified;

For queue claim and soft-deleted patterns, partial indexes are nearly mandatory — they cut index size by orders of magnitude.

## Covering Indexes with INCLUDE

The `INCLUDE` clause adds columns to the index leaf without making them part of the key. Queries can then be satisfied entirely from the index (index-only scan):

    CREATE INDEX customer_lookup_idx
        ON customer(customer_no) INCLUDE (email, full_name);

    -- This now runs as an index-only scan:
    SELECT email, full_name FROM customer WHERE customer_no = 42;

Use when:

- A few non-key columns are read together with a key lookup
- The non-key columns are small and rarely updated
- The query is performance-critical and frequent

Don't include large columns (TEXT bodies, JSONB blobs) — bloats the index.

## Expression Indexes

Index the result of a function or expression:

    -- Case-insensitive email lookup (alternative to citext)
    CREATE INDEX customer_email_lower_idx ON customer(lower(email));

    -- Date bucket
    CREATE INDEX order_day_idx ON orders(date_trunc('day', ordered_at));

    -- JSONB field
    CREATE INDEX customer_data_status_idx ON customer((data->>'status'));

The query must call the *same expression* for the planner to use it:

    SELECT * FROM customer WHERE lower(email) = 'alice@example.com';  -- uses index

Expression indexes are powerful but easy to over-add. If you're indexing the same expression in many places, consider a generated column instead.

## GIN: Arrays, JSONB, Full-Text

GIN indexes are inverted indexes — the index is keyed by the *element*, not the row. Use for:

    -- Array membership
    CREATE INDEX customer_roles_gin_idx ON customer USING GIN(roles);

    -- JSONB containment and key existence
    CREATE INDEX customer_data_gin_idx ON customer USING GIN(data);

    -- Or, smaller GIN for containment-only queries
    CREATE INDEX customer_data_path_idx ON customer USING GIN(data jsonb_path_ops);

    -- Full-text search
    CREATE INDEX customer_search_idx ON customer USING GIN(to_tsvector('english', full_name || ' ' || email));

GIN indexes are larger and slower to update than B-tree, but cheap to query. Don't put one on a write-heavy column unless you genuinely need the lookup.

## GiST: Ranges, Geospatial, Custom

GiST is for data types with overlap semantics (ranges, points, polygons, custom types from extensions):

    -- Range exclusion (no overlapping reservations)
    CREATE INDEX reservation_during_idx
        ON reservation USING GIST(room_id, during);

    -- Geospatial (with PostGIS)
    CREATE INDEX location_geo_idx ON location USING GIST(geom);

Pairs naturally with `EXCLUDE` constraints for "non-overlapping" enforcement.

## BRIN: Huge Append-Only Tables

Block-range indexes summarize ranges of blocks rather than indexing every row. Use when row order strongly correlates with a column — typically time-series append-only data:

    CREATE INDEX event_log_occurred_at_brin_idx
        ON event_log USING BRIN(occurred_at);

A BRIN index on a 100M-row event log is a few MB and covers `WHERE occurred_at BETWEEN X AND Y` efficiently. Useless if rows are inserted out of order or updated frequently.

## Unique Indexes vs UNIQUE Constraints

`UNIQUE` constraints and unique indexes are functionally equivalent in Postgres — constraints are implemented as unique indexes. The difference is metadata:

    -- Constraint form: shows up in pg_constraint, can be FK target
    ALTER TABLE customer ADD CONSTRAINT customer_email_is_unique UNIQUE (email);

    -- Index form: more flexible (partial, expression, etc.)
    CREATE UNIQUE INDEX customer_email_unique
        ON customer(email) WHERE deleted_at IS NULL;

Use the **constraint** form for plain uniqueness (it documents intent better, and you get a nice error name). Use the **unique index** form when you need partial, expression, or non-default options.

## Maintenance: REINDEX, Bloat, VACUUM

Indexes accumulate bloat from updates and deletes. Symptoms: index size grows faster than table size; query plans become inconsistent.

- **`REINDEX CONCURRENTLY`** — rebuild without blocking. Run during maintenance windows for hot indexes.
- **`VACUUM`** — cleans up dead tuples; autovacuum usually handles this but can lag under heavy write load.
- **`pg_stat_user_indexes`** — find unused indexes (`idx_scan = 0`); they cost write performance for nothing.
- **`pgstattuple`** extension — inspect actual bloat.

## When NOT to Add an Index

- **Low-cardinality columns** (boolean, small enum) — unless paired in a composite or as a partial index predicate
- **Write-heavy columns** — every index slows INSERT/UPDATE
- **Columns rarely queried** — verify with `pg_stat_user_indexes` after some time
- **Tables under ~10k rows** — sequential scan is often as fast or faster
- **Speculative future use** — add when the query plan shows the need, not before

Every index has a cost. The default should be "no index" — add when measurement justifies it.

# DDL Syntax — `CREATE`, `ALTER`, `DROP`


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Schemas](#schemas)
    - [Sequences](#sequences)
    - [`CREATE TABLE` — the full surface](#create-table--the-full-surface)
    - [Column constraints](#column-constraints)
    - [Table constraints](#table-constraints)
    - [Identity columns (`GENERATED … AS IDENTITY`)](#identity-columns-generated--as-identity)
    - [Generated columns (`GENERATED ALWAYS AS … STORED`)](#generated-columns-generated-always-as--stored)
    - [Partitioned tables (`PARTITION BY`)](#partitioned-tables-partition-by)
    - [`INHERITS` vs `LIKE`](#inherits-vs-like)
    - [`TEMPORARY` and `UNLOGGED` tables](#temporary-and-unlogged-tables)
    - [Storage parameters (`WITH (...)`)](#storage-parameters-with-)
    - [`ALTER TABLE` — every subcommand](#alter-table--every-subcommand)
    - [Lock-level reference for `ALTER TABLE`](#lock-level-reference-for-alter-table)
    - [`DROP TABLE`, `CASCADE`, `RESTRICT`](#drop-table-cascade-restrict)
    - [`IF NOT EXISTS` / `IF EXISTS` family](#if-not-exists--if-exists-family)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Load this file when the question involves:

- Creating, altering, or dropping **tables**, **schemas**, or **sequences**
- Designing **column-level** or **table-level** constraints (anything other than foreign keys, which live in [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md))
- Picking between **`SERIAL`/`bigserial`** and **`GENERATED … AS IDENTITY`** for surrogate keys
- Adding **generated columns** (stored or — on PG18+ — virtual)
- Building **declarative partitioned tables** (the deep dive on partition pruning, sub-partitioning, and partition-wise joins is in [`35-partitioning.md`](./35-partitioning.md); this file covers the DDL grammar)
- Performing a **safe schema migration** under load (avoiding ACCESS EXCLUSIVE rewrites, splitting `ADD CONSTRAINT … NOT VALID` from `VALIDATE CONSTRAINT`, switching `SET LOGGED`/`UNLOGGED`, detaching a partition concurrently)
- Understanding which `ALTER TABLE` variants block readers vs writers
- Idempotent migrations using **`IF NOT EXISTS`**, **`IF EXISTS`**, **`OR REPLACE`** semantics


## Syntax / Mechanics



### Schemas


A **schema** is a namespace inside a database that owns tables, views, sequences, functions, types, and operators. Every object lives in exactly one schema.[^ddl-schemas]

```sql
-- Create a schema (idempotent variant uses IF NOT EXISTS).
CREATE SCHEMA reporting;
CREATE SCHEMA IF NOT EXISTS reporting AUTHORIZATION etl_writer;

-- Create a schema *and* its contents in one transactional unit.
-- The schema_element list accepts only CREATE TABLE / VIEW / INDEX / SEQUENCE / TRIGGER, and GRANT.
CREATE SCHEMA hollywood AUTHORIZATION joe
    CREATE TABLE films (title text, release date, awards text[])
    CREATE VIEW recent AS SELECT * FROM films WHERE release > CURRENT_DATE - 30
    GRANT SELECT ON films TO public;

-- Rename and reassign.
ALTER SCHEMA reporting RENAME TO analytics;
ALTER SCHEMA analytics OWNER TO data_eng;

-- Drop (RESTRICT is the default; CASCADE drops every contained object).
DROP SCHEMA analytics RESTRICT;
DROP SCHEMA IF EXISTS analytics CASCADE;
```

> [!WARNING] `pg_` is reserved
> Schema names starting with `pg_` are reserved for the system. Use `_pg`, `app_pg`, or another prefix if you need a private prefix that *looks* like a namespace marker.

**Resolution: `search_path`.** Unqualified references resolve against the per-session GUC `search_path` (default `"$user", public`). When you create a table without specifying a schema, the first writable schema in `search_path` wins.[^ddl-schemas-path]

```sql
SHOW search_path;
SET search_path TO app, public;            -- session-wide
ALTER ROLE etl_writer SET search_path = etl, public;   -- role default
ALTER DATABASE app SET search_path = app, public;       -- DB default
```

> [!NOTE] PostgreSQL 15
> The implicit `CREATE` privilege on the `public` schema for the special role `PUBLIC` was **revoked** in PG15. New databases ship with `public` owned by the database owner and not world-writable. Adjust deployment scripts that assume `CREATE` on `public` works for any logged-in user.[^pg15-public]

> [!WARNING] Removed/Deprecated
> `IF NOT EXISTS` with a `schema_element` list is **not supported** — you cannot atomically create-or-skip a schema *and* populate it in the same statement. Pick one: idempotent header, or transactional populate.[^ddl-schemas]



### Sequences


A **sequence** is a single-row counter object managed by `nextval()` / `currval()` / `setval()`. Identity columns and `SERIAL` types are sugar over sequences.[^create-sequence]

```sql
CREATE [ { TEMPORARY | TEMP } | UNLOGGED ] SEQUENCE [ IF NOT EXISTS ] name
    [ AS data_type ]
    [ INCREMENT [ BY ] increment ]
    [ MINVALUE minvalue | NO MINVALUE ] [ MAXVALUE maxvalue | NO MAXVALUE ]
    [ START [ WITH ] start ] [ CACHE cache ] [ [ NO ] CYCLE ]
    [ OWNED BY { table_name.column_name | NONE } ];
```

| Option | Default | Notes |
|---|---|---|
| `AS smallint \| integer \| bigint` | `bigint` | Caps `MAXVALUE` (or `MINVALUE` for descending) at the data-type's bound |
| `INCREMENT [BY]` | `1` | Negative → descending sequence |
| `MINVALUE` / `NO MINVALUE` | `1` (asc) or data-type min (desc) | Implies floor |
| `MAXVALUE` / `NO MAXVALUE` | data-type max (asc) or `-1` (desc) | Implies ceiling |
| `START [WITH]` | `MINVALUE` (asc) / `MAXVALUE` (desc) | First value handed out by `nextval` |
| `CACHE` | `1` | Per-backend preallocation; with `CACHE 50` each backend reserves 50 values, **creating gaps when sessions exit early** |
| `CYCLE` / `NO CYCLE` | `NO CYCLE` | `CYCLE` wraps from max → min (or vice versa); `NO CYCLE` raises an error |
| `OWNED BY` | `NONE` | Drops sequence with the owning column |

**Sequence-related functions.** All session-local except `setval`:

```sql
SELECT nextval('orders_id_seq');     -- advances and returns the next value
SELECT currval('orders_id_seq');     -- last value handed out *in this session* (error if never used here)
SELECT lastval();                    -- last value handed out by any nextval in this session
SELECT setval('orders_id_seq', 1000, true);   -- (next nextval -> 1001; pass false to mean "next nextval -> 1000")
```

**Gaps are by design.** Sequences are *not* transactional — `nextval()` is not rolled back when its transaction aborts, and `CACHE > 1` reserves values per-backend at session start. Don't rely on identity values being gap-free.[^create-sequence]

```sql
ALTER SEQUENCE orders_id_seq RESTART WITH 1000000;     -- emergency reset (BEWARE: pre-existing rows above this value)
ALTER SEQUENCE orders_id_seq OWNED BY orders.id;       -- pair to a column so DROP COLUMN/DROP TABLE drops it too
ALTER SEQUENCE orders_id_seq SET LOGGED;               -- promote an UNLOGGED sequence (PG15+)
DROP SEQUENCE IF EXISTS legacy_id_seq CASCADE;
```

> [!NOTE] PostgreSQL 15
> Sequences now support `LOGGED`/`UNLOGGED` directly, and identity columns can specify `SEQUENCE NAME`, `LOGGED`, or `UNLOGGED` inside the `(sequence_options)` list.[^create-table]



### `CREATE TABLE` — the full surface


The grammar fans out in many directions. The skeleton:

```sql
CREATE [ [ GLOBAL | LOCAL ] { TEMPORARY | TEMP } | UNLOGGED ] TABLE [ IF NOT EXISTS ] table_name (
    [ column_name data_type [ COMPRESSION compression_method ] [ COLLATE collation ]
        [ column_constraint [ ... ] ]
    | table_constraint
    | LIKE source_table [ like_option ... ]
    ] [, ... ]
)
[ INHERITS ( parent_table [, ...] ) ]
[ PARTITION BY { RANGE | LIST | HASH } ( { column_name | ( expression ) }
    [ COLLATE collation ] [ opclass ] [, ...] ) ]
[ USING method ]
[ WITH ( storage_parameter [= value] [, ... ] ) | WITHOUT OIDS ]
[ ON COMMIT { PRESERVE ROWS | DELETE ROWS | DROP } ]
[ TABLESPACE tablespace_name ];
```

Minimal example:

```sql
CREATE TABLE app.orders (
    id          bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint   NOT NULL REFERENCES app.customers (id),
    placed_at   timestamptz NOT NULL DEFAULT now(),
    status      text     NOT NULL CHECK (status IN ('open','paid','cancelled')),
    total_cents bigint   NOT NULL CHECK (total_cents >= 0)
);
```

Column-position keywords:

- **`COLLATE`** — per-column collation override. See [`65-collations-encoding.md`](./65-collations-encoding.md) for collation pitfalls.
- **`COMPRESSION`** — column-level compression algorithm for TOAST-able types (`pglz` or `lz4`). Default is set by the GUC `default_toast_compression`. See [`31-toast.md`](./31-toast.md).
- **`USING method`** — table access method (heap, or a pluggable AM). The only stable AM as of PG16 is `heap`; `columnar` ships via the Citus or Hydra extensions.



### Column constraints


Attach directly to a column. The grammar:[^create-table]

```sql
[ CONSTRAINT constraint_name ]
{ NOT NULL
| NULL
| CHECK ( expression ) [ NO INHERIT ]
| DEFAULT default_expr
| GENERATED ALWAYS AS ( generation_expr ) STORED         -- STORED only on PG ≤ 17
| GENERATED ALWAYS AS ( generation_expr ) [ STORED | VIRTUAL ]   -- PG 18+
| GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [ ( sequence_options ) ]
| UNIQUE [ NULLS [ NOT ] DISTINCT ] index_parameters
| PRIMARY KEY index_parameters
| REFERENCES reftable [ ( refcolumn ) ]
    [ MATCH { FULL | PARTIAL | SIMPLE } ]
    [ ON DELETE referential_action ]
    [ ON UPDATE referential_action ]
}
[ DEFERRABLE | NOT DEFERRABLE ]
[ INITIALLY DEFERRED | INITIALLY IMMEDIATE ];
```

> [!NOTE] PostgreSQL 15
> `UNIQUE NULLS NOT DISTINCT` is new. Previously every NULL was treated as a distinct value, so multiple NULL rows could coexist in a unique index. `NULLS NOT DISTINCT` flips that.[^pg15-nulls-not-distinct]

```sql
-- Without NULLS NOT DISTINCT: two NULL rows are allowed.
-- With NULLS NOT DISTINCT: at most one NULL is allowed.
CREATE TABLE invites (
    email text,
    token text UNIQUE NULLS NOT DISTINCT
);
```

Prefer to **name your constraints** — autogenerated names (`orders_status_check`) drift if columns are renamed, and meaningful names show up in error messages and `pg_constraint`. A naming convention like `chk_orders_status` makes incidents readable.

> [!NOTE] PostgreSQL 18
> Not-null constraints are now stored as proper constraints in `pg_constraint`, with a constraint name, the ability to use `NOT VALID` + `VALIDATE CONSTRAINT` on `NOT NULL`, and inheritability control via `ALTER TABLE … ALTER CONSTRAINT … [NO] INHERIT`. Previously they lived inline on `pg_attribute.attnotnull` and adding `NOT NULL` always required a full table scan.[^pg18-notnull]



### Table constraints


Live at the table level after the column list — required for composite keys, exclusion constraints, or to use `WITHOUT OVERLAPS` (PG18+).

```sql
[ CONSTRAINT constraint_name ]
{ CHECK ( expression ) [ NO INHERIT ]
| UNIQUE [ NULLS [ NOT ] DISTINCT ] ( column_name [, ...] ) index_parameters
| PRIMARY KEY ( column_name [, ...] ) index_parameters
| EXCLUDE [ USING index_method ] ( exclude_element WITH operator [, ...] )
    index_parameters [ WHERE ( predicate ) ]
| FOREIGN KEY ( column_name [, ...] ) REFERENCES reftable [ ( refcolumn [, ...] ) ]
    [ MATCH FULL | MATCH PARTIAL | MATCH SIMPLE ]
    [ ON DELETE referential_action ] [ ON UPDATE referential_action ]
}
[ DEFERRABLE | NOT DEFERRABLE ]
[ INITIALLY DEFERRED | INITIALLY IMMEDIATE ];
```

**`index_parameters`** lets you push storage knobs into the implicit unique index:

```sql
PRIMARY KEY (id) WITH (fillfactor = 90)
PRIMARY KEY (id) USING INDEX TABLESPACE fast_ssd
UNIQUE (slug) INCLUDE (title, created_at)         -- covering, PG11+
```

`INCLUDE` columns are payload columns on the index leaf — they don't participate in the uniqueness check but make the index "covering" for index-only scans. See [`23-btree-indexes.md`](./23-btree-indexes.md).

> [!NOTE] PostgreSQL 18
> `UNIQUE`/`PRIMARY KEY` accept a `WITHOUT OVERLAPS` modifier on the last column, which must be a range or multirange type and is compared by overlap rather than equality. Combined with `FOREIGN KEY ( … PERIOD col )`, this gives temporal referential integrity natively.[^pg18-temporal]

```sql
-- PG18+ temporal primary key
CREATE TABLE rentals (
    room_id    int,
    booked_during tstzrange,
    PRIMARY KEY (room_id, booked_during WITHOUT OVERLAPS)
);
```



### Identity columns (`GENERATED … AS IDENTITY`)


**Always prefer `IDENTITY` over `SERIAL` for new schemas.** `IDENTITY` is the SQL-standard surrogate-key idiom, has cleaner semantics around ownership (`OWNED BY` is implicit), and survives `pg_dump`/`pg_restore` more cleanly. `SERIAL` remains supported for back-compat.[^ddl-identity]

```sql
-- The standard pattern (PG10+):
CREATE TABLE app.events (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    payload    jsonb  NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

|  | `GENERATED ALWAYS AS IDENTITY` | `GENERATED BY DEFAULT AS IDENTITY` |
|---|---|---|
| Accept user-supplied INSERT value? | No — rejected unless `OVERRIDING SYSTEM VALUE` | Yes — user value wins, sequence used only when omitted |
| Accept UPDATE? | No — only `DEFAULT` | Yes |
| When to choose | App must never set the id | Migrations / bulk loads / replication need to insert specific ids |

**Override at INSERT time:**

```sql
-- Force the sequence value even when the column is GENERATED ALWAYS:
INSERT INTO events (id, payload) OVERRIDING SYSTEM VALUE VALUES (42, '{}'::jsonb);

-- Force the *sequence* to assign (instead of the user value) on a BY DEFAULT column:
INSERT INTO events (id, payload) OVERRIDING USER VALUE VALUES (NULL, '{}'::jsonb);
```

**Identity sequence options.** You can shape the implicit sequence:

```sql
CREATE TABLE app.batches (
    id bigint GENERATED ALWAYS AS IDENTITY (
        SEQUENCE NAME app.batches_id_seq      -- PG15+ explicit name
        START WITH 100000
        INCREMENT BY 1
        CACHE 50
        NO CYCLE
    ),
    label text NOT NULL
);
```

**Reset the underlying sequence after a bulk load:**

```sql
SELECT setval(
    pg_get_serial_sequence('app.batches', 'id'),
    (SELECT max(id) FROM app.batches),
    true
);
```

**Promote a `SERIAL` column to `IDENTITY`** (recommended migration):

```sql
-- Reattach the existing sequence as the identity sequence in a single transaction.
BEGIN;
ALTER TABLE old_table ALTER COLUMN id DROP DEFAULT;
ALTER TABLE old_table ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
-- The pre-existing old_table_id_seq is reused.
COMMIT;
```



### Generated columns (`GENERATED ALWAYS AS … STORED`)


A computed column whose value is derived from other columns in the same row.[^ddl-generated]

```sql
CREATE TABLE app.invoices (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subtotal    numeric(12,2) NOT NULL,
    tax         numeric(12,2) NOT NULL,
    total       numeric(12,2) GENERATED ALWAYS AS (subtotal + tax) STORED
);
```

**Constraints on the expression:**

- Must be **immutable** (no `now()`, no `random()`, no volatile functions).
- May reference other columns of the **same row only**, never other tables, never subqueries.
- May not reference another **generated** column.
- The column itself cannot have a `DEFAULT` and cannot accept `INSERT`/`UPDATE` values (use the keyword `DEFAULT` if you must include it in a column list).

> [!NOTE] PostgreSQL 18
> Generated columns can now be `VIRTUAL` (computed on read, no storage) in addition to `STORED`. `VIRTUAL` is the default if the keyword is omitted. Virtual columns may **not** be indexed and may **not** reference user-defined functions or types — only built-ins. Choose `STORED` when you want to index the column or accept the storage cost in exchange for read-time speed.[^pg18-virtual]

```sql
-- PG18+
CREATE TABLE app.invoices (
    subtotal numeric(12,2),
    tax      numeric(12,2),
    total    numeric(12,2) GENERATED ALWAYS AS (subtotal + tax) VIRTUAL
);
```

A common pattern is using a stored generated column as the FTS source so the `tsvector` is always in sync:

```sql
CREATE TABLE app.articles (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title text   NOT NULL,
    body  text   NOT NULL,
    fts   tsvector GENERATED ALWAYS AS (
              setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
              setweight(to_tsvector('english', coalesce(body, '')), 'B')
          ) STORED
);
CREATE INDEX articles_fts_gin ON app.articles USING gin (fts);
```

See [`20-text-search.md`](./20-text-search.md) for FTS depth.



### Partitioned tables (`PARTITION BY`)


Declarative partitioning was introduced in PG10 and has had material improvements in every major release since. The DDL surface:[^create-table]

```sql
-- The parent ("partitioned table") declares the partition key.
CREATE TABLE app.measurements (
    sensor_id int  NOT NULL,
    ts        timestamptz NOT NULL,
    reading   double precision
) PARTITION BY RANGE (ts);

-- Child partitions can be created with PARTITION OF (takes ACCESS EXCLUSIVE on parent)…
CREATE TABLE app.measurements_2025q1 PARTITION OF app.measurements
    FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');

-- …or created standalone then ATTACHed (takes SHARE UPDATE EXCLUSIVE on parent — preferred for online ops).
CREATE TABLE app.measurements_2025q2 (LIKE app.measurements INCLUDING ALL);
ALTER TABLE app.measurements_2025q2
    ADD CONSTRAINT chk_range CHECK (ts >= '2025-04-01' AND ts < '2025-07-01') NOT VALID;
ALTER TABLE app.measurements_2025q2 VALIDATE CONSTRAINT chk_range;
ALTER TABLE app.measurements ATTACH PARTITION app.measurements_2025q2
    FOR VALUES FROM ('2025-04-01') TO ('2025-07-01');

-- A DEFAULT partition catches values outside any declared range/list:
CREATE TABLE app.measurements_default PARTITION OF app.measurements DEFAULT;
```

**Bound spec by partition type:**

| Type | Bound spec |
|---|---|
| `RANGE` | `FOR VALUES FROM ( v1 [, …] ) TO ( v2 [, …] )` — `MINVALUE`/`MAXVALUE` accepted; lower inclusive, upper exclusive |
| `LIST` | `FOR VALUES IN ( v1 [, v2, …] )` |
| `HASH` | `FOR VALUES WITH (MODULUS m, REMAINDER r)` — usually create `m` siblings with `REMAINDER 0..m-1` |

**Indexes on partitioned tables.** Creating an index on the parent table cascades a matching child index onto every partition (and any future partition).[^ddl-partitioning] The big caveat: you cannot use `CONCURRENTLY` on a partitioned-table-level `CREATE INDEX`. The workaround is the **`ONLY` + ATTACH** dance:

```sql
-- 1. Build an invalid parent index that does not propagate.
CREATE INDEX measurements_ts_idx ON ONLY app.measurements (ts);

-- 2. Build each child index concurrently, in parallel transactions.
CREATE INDEX CONCURRENTLY measurements_2025q1_ts_idx ON app.measurements_2025q1 (ts);
CREATE INDEX CONCURRENTLY measurements_2025q2_ts_idx ON app.measurements_2025q2 (ts);

-- 3. Attach. Once every partition has the index, the parent index flips to valid.
ALTER INDEX app.measurements_ts_idx ATTACH PARTITION app.measurements_2025q1_ts_idx;
ALTER INDEX app.measurements_ts_idx ATTACH PARTITION app.measurements_2025q2_ts_idx;
```

> [!NOTE] PostgreSQL 14
> `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` (and the `FINALIZE` variant for resuming an interrupted detach) was added in PG14. It runs in two transactions and downgrades the parent lock from ACCESS EXCLUSIVE to SHARE UPDATE EXCLUSIVE.[^pg14-detach-concurrently] **There is no `ATTACH PARTITION CONCURRENTLY`** — but plain `ATTACH PARTITION` already takes only SHARE UPDATE EXCLUSIVE on the parent (plus ACCESS EXCLUSIVE on the partition being attached), so it is the recommended online path for adding partitions.[^alter-table]

Partition-key columns must be marked `NOT NULL` to participate in `PRIMARY KEY` or `UNIQUE` constraints because the partition key must be part of any unique key — there's no global index across partitions. See [`35-partitioning.md`](./35-partitioning.md) for the runtime side.



### `INHERITS` vs `LIKE`


Two superficially similar clauses with very different semantics:

| | `INHERITS (parent)` | `LIKE source [ INCLUDING … ]` |
|---|---|---|
| Schema link maintained? | Yes — column adds, type changes, constraints on parent propagate down | No — child is a snapshot at create time |
| Parent scans see child rows? | Yes (unless `ONLY parent`) | No |
| Common use today | Almost none — superseded by declarative partitioning | Cloning a table's shape for a one-off (e.g. staging, archive, audit) |
| Constraint merging | Identical CHECK constraints merge | Constraints copied only with `INCLUDING CONSTRAINTS` |

`LIKE` options:

```sql
CREATE TABLE staging.orders (LIKE app.orders INCLUDING ALL EXCLUDING IDENTITY);
```

Per the docs the `LIKE` option set is: `COMMENTS`, `COMPRESSION`, `CONSTRAINTS`, `DEFAULTS`, `GENERATED`, `IDENTITY`, `INDEXES`, `STATISTICS`, `STORAGE`, `ALL`. Each can be `INCLUDING` or `EXCLUDING`.[^create-table] `INCLUDING ALL` is the everything-and-the-kitchen-sink default; `EXCLUDING IDENTITY` is common to avoid two tables sharing the same identity sequence.

See [`36-inheritance.md`](./36-inheritance.md) for the legacy `INHERITS` story.



### `TEMPORARY` and `UNLOGGED` tables


```sql
CREATE TEMP TABLE session_cache (key text PRIMARY KEY, payload jsonb)
    ON COMMIT DELETE ROWS;

CREATE UNLOGGED TABLE fast_scratch (id bigint, body text);
```

| Aspect | `TEMP` | `UNLOGGED` |
|---|---|---|
| Visibility | Single session only | All sessions |
| Survives crash? | n/a (dies at session end anyway) | **No** — truncated on unclean shutdown |
| Replicated to standby? | No | **No** — not WAL-logged, not visible on physical or logical replicas |
| WAL written? | Minimal | None |
| Autovacuum? | No — manual `VACUUM`/`ANALYZE` only | Yes |
| `ON COMMIT` clause | `PRESERVE ROWS` (default), `DELETE ROWS`, `DROP` | Not supported |
| Storage location | Session-private temp schema (`pg_temp_*`) | Normal schema |

**Promote `UNLOGGED` → `LOGGED` carefully.** `ALTER TABLE … SET LOGGED` rewrites the table and WAL-logs every row — full ACCESS EXCLUSIVE lock for the duration. Plan an outage window.



### Storage parameters (`WITH (...)`)


Per-table knobs that shadow the global GUCs. The full list:[^create-table]

| Parameter | Type | Effect |
|---|---|---|
| `fillfactor` | int 10–100 | Reserve `100-fillfactor`% free space per page for HOT updates — drop to ~80 on hot-update-heavy tables |
| `toast_tuple_target` | int 128–8160 | Minimum tuple length before TOASTing kicks in |
| `parallel_workers` | int | Override parallel-scan worker count for this table |
| `autovacuum_enabled` | bool | Per-table autovacuum on/off |
| `autovacuum_vacuum_threshold` / `_scale_factor` | numeric | Per-table trigger thresholds (see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)) |
| `autovacuum_vacuum_insert_threshold` / `_scale_factor` | numeric | Insert-only VACUUM trigger (PG13+) |
| `autovacuum_analyze_threshold` / `_scale_factor` | numeric | ANALYZE trigger overrides |
| `autovacuum_vacuum_cost_delay` / `_cost_limit` | numeric | Per-table IO throttling |
| `autovacuum_freeze_min_age` / `_max_age` / `_table_age` | int | Per-table wraparound knobs |
| `log_autovacuum_min_duration` | int | Threshold to log autovacuum runs |
| `vacuum_index_cleanup` | enum `auto`/`on`/`off` | Skip index cleanup phase per-table |
| `vacuum_truncate` | bool | Whether VACUUM can shrink the relation file |
| `user_catalog_table` | bool | Mark for logical replication on a custom replication identity scheme |

```sql
ALTER TABLE app.hot_table SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE app.cold_table RESET (autovacuum_vacuum_scale_factor);
```



### `ALTER TABLE` — every subcommand


Every `ALTER TABLE` subcommand below has the form `ALTER TABLE [ IF EXISTS ] [ ONLY ] name [ * ] action [, …]`. Multiple `action`s in a single statement run **in one transaction with one lock** — useful when adding many columns at once to avoid repeated rewrites.[^alter-table]

#### Add / drop / change columns

```sql
-- ADD COLUMN. Since PG11, adding a column with a non-volatile DEFAULT does NOT rewrite the table —
-- the default is stored in pg_attribute.attmissingval and applied on the fly.
ALTER TABLE app.orders ADD COLUMN priority int NOT NULL DEFAULT 0;

-- DROP COLUMN is logical: the column is hidden but the storage stays until table rewrite.
ALTER TABLE app.orders DROP COLUMN legacy_flag;

-- ALTER TYPE often rewrites the whole table. Use USING to convert values:
ALTER TABLE app.orders
    ALTER COLUMN total_cents TYPE numeric(14,2) USING total_cents::numeric / 100;

-- Toggle NOT NULL. Adding NOT NULL scans the whole table to confirm no nulls.
ALTER TABLE app.orders ALTER COLUMN status SET NOT NULL;
ALTER TABLE app.orders ALTER COLUMN priority DROP NOT NULL;

-- Defaults are metadata-only.
ALTER TABLE app.orders ALTER COLUMN priority SET DEFAULT 5;
ALTER TABLE app.orders ALTER COLUMN priority DROP DEFAULT;

-- Per-column stats target.
ALTER TABLE app.orders ALTER COLUMN customer_id SET STATISTICS 1000;
ALTER TABLE app.orders ALTER COLUMN body SET (n_distinct = -0.5);

-- Per-column storage strategy.
ALTER TABLE app.articles ALTER COLUMN body SET STORAGE EXTERNAL;   -- PLAIN | EXTENDED | EXTERNAL | MAIN
ALTER TABLE app.articles ALTER COLUMN body SET COMPRESSION lz4;
```

> [!NOTE] PostgreSQL 11
> Adding a column with a non-volatile `DEFAULT` (constants, immutable expressions) is metadata-only — no table rewrite. Volatile defaults still rewrite. Use this whenever possible to avoid downtime on big tables.[^pg11-fast-add-col]

#### Constraint operations

```sql
-- Add a CHECK constraint without validating it (no scan, fast).
ALTER TABLE app.orders
    ADD CONSTRAINT chk_total_nonneg CHECK (total_cents >= 0) NOT VALID;

-- Validate it later (takes SHARE UPDATE EXCLUSIVE — concurrent reads/writes proceed).
ALTER TABLE app.orders VALIDATE CONSTRAINT chk_total_nonneg;

-- Drop a constraint.
ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS chk_total_nonneg;

-- Rename a constraint or column or table.
ALTER TABLE app.orders RENAME CONSTRAINT chk_total_nonneg TO chk_total_nonnegative;
ALTER TABLE app.orders RENAME COLUMN total_cents TO total_minor_units;
ALTER TABLE app.orders RENAME TO orders_v2;
```

The `NOT VALID` + `VALIDATE CONSTRAINT` pattern is the standard way to add a new constraint to a live table — see the recipe below.

#### Partition ops

```sql
ALTER TABLE app.measurements DETACH PARTITION app.measurements_2024q4;
ALTER TABLE app.measurements DETACH PARTITION app.measurements_2024q4 CONCURRENTLY;
ALTER TABLE app.measurements DETACH PARTITION app.measurements_2024q4 FINALIZE;

ALTER TABLE app.measurements ATTACH PARTITION app.measurements_2025q3
    FOR VALUES FROM ('2025-07-01') TO ('2025-10-01');
```

#### Storage / persistence

```sql
ALTER TABLE app.scratch SET UNLOGGED;        -- rewrites the table, ACCESS EXCLUSIVE
ALTER TABLE app.scratch SET LOGGED;          -- rewrites the table, ACCESS EXCLUSIVE
ALTER TABLE app.big SET TABLESPACE fast_ssd; -- rewrites the table; consider pg_repack for online moves
ALTER TABLE ALL IN TABLESPACE old_disk SET TABLESPACE new_disk NOWAIT;
```

#### Inheritance / ownership / replica identity

```sql
ALTER TABLE app.audit_archive INHERIT app.audit;
ALTER TABLE app.audit_archive NO INHERIT app.audit;

ALTER TABLE app.orders OWNER TO app_writer;

-- REPLICA IDENTITY drives what's emitted for UPDATEs/DELETEs in logical replication.
-- DEFAULT  -> PK columns (recommended)
-- USING INDEX i -> a specific NOT NULL unique non-partial index
-- FULL     -> every column (heavy; only when there is no usable key)
-- NOTHING  -> UPDATEs/DELETEs are not decoded for this table (drop only)
ALTER TABLE app.orders REPLICA IDENTITY FULL;
```

See [`74-logical-replication.md`](./74-logical-replication.md) for the consequences.



### Lock-level reference for `ALTER TABLE`


Many `ALTER TABLE` subcommands take ACCESS EXCLUSIVE on the table (blocking *everything* including `SELECT`). Some take softer locks. **This is the table to consult before running a migration on a live system.**[^alter-table] [^locking-docs]

| Operation | Lock on table |
|---|---|
| `ADD COLUMN` (no default, or non-volatile default since PG11) | ACCESS EXCLUSIVE |
| `ADD COLUMN` (with volatile default) — rewrites | ACCESS EXCLUSIVE |
| `DROP COLUMN` | ACCESS EXCLUSIVE |
| `ALTER COLUMN TYPE` (rewrites in most cases) | ACCESS EXCLUSIVE |
| `ALTER COLUMN SET DEFAULT` / `DROP DEFAULT` | ACCESS EXCLUSIVE |
| `ALTER COLUMN SET NOT NULL` (scans the table) | ACCESS EXCLUSIVE |
| `ALTER COLUMN DROP NOT NULL` | ACCESS EXCLUSIVE |
| `ADD CONSTRAINT CHECK` (not `NOT VALID`) | ACCESS EXCLUSIVE |
| `ADD CONSTRAINT CHECK … NOT VALID` | ACCESS EXCLUSIVE (brief — no scan) |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE |
| `ADD CONSTRAINT FOREIGN KEY` | SHARE ROW EXCLUSIVE (on both tables) |
| `ADD CONSTRAINT PRIMARY KEY` / `UNIQUE` (builds index) | ACCESS EXCLUSIVE |
| `ATTACH PARTITION` | SHARE UPDATE EXCLUSIVE (parent) + ACCESS EXCLUSIVE (partition) |
| `DETACH PARTITION` | ACCESS EXCLUSIVE (parent + partition) |
| `DETACH PARTITION … CONCURRENTLY` | SHARE UPDATE EXCLUSIVE (parent) — two-phase |
| `RENAME` (column / constraint / table) | ACCESS EXCLUSIVE |
| `SET TABLESPACE` / `SET LOGGED` / `SET UNLOGGED` | ACCESS EXCLUSIVE (rewrites) |
| `SET STATISTICS` | SHARE UPDATE EXCLUSIVE |
| `CLUSTER ON` / `SET WITHOUT CLUSTER` | SHARE UPDATE EXCLUSIVE |
| `OWNER TO` | ACCESS EXCLUSIVE |
| `REPLICA IDENTITY` | ACCESS EXCLUSIVE |

> [!WARNING] Migration lock-storms
> The single most common production incident in Postgres migrations is **`ALTER TABLE` waiting on ACCESS EXCLUSIVE behind a long-running SELECT**, then blocking every reader and writer behind itself. Mitigate by setting `lock_timeout` on the migration session (e.g. `SET lock_timeout = '3s'`), retrying on `LockNotAvailable`, and splitting `ADD CONSTRAINT … NOT VALID` from `VALIDATE CONSTRAINT`. See the recipe below.



### `DROP TABLE`, `CASCADE`, `RESTRICT`


```sql
DROP TABLE [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ];
```

`RESTRICT` (default) refuses to drop if anything depends on the table; `CASCADE` drops dependent objects (views, foreign keys, etc.) recursively. **Be careful with `CASCADE`** — Postgres won't ask twice, and once views/triggers are gone they're gone unless you have the prior schema in `pg_dump`.

```sql
-- Always inspect dependencies first:
SELECT classid::regclass, objid::regclass AS dependent
FROM pg_depend WHERE refobjid = 'app.orders'::regclass;
```

`TRUNCATE` is covered in [`03-syntax-dml.md`](./03-syntax-dml.md).



### `IF NOT EXISTS` / `IF EXISTS` family


Idempotent migration tools rely on these:

```sql
CREATE TABLE IF NOT EXISTS app.orders (...);
CREATE SCHEMA IF NOT EXISTS app;
CREATE SEQUENCE IF NOT EXISTS app.orders_id_seq;
CREATE INDEX IF NOT EXISTS orders_status_idx ON app.orders (status);

DROP TABLE IF EXISTS legacy.foo CASCADE;
DROP INDEX IF EXISTS bad_idx;
DROP SCHEMA IF EXISTS legacy CASCADE;

ALTER TABLE IF EXISTS app.orders ADD COLUMN priority int DEFAULT 0;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS priority int DEFAULT 0;
ALTER TABLE app.orders DROP COLUMN IF EXISTS priority;
ALTER TABLE app.orders RENAME COLUMN IF EXISTS priority TO prio;     -- PG14+
ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS chk_priority_range;
```

> [!WARNING] `CREATE TABLE IF NOT EXISTS` does NOT validate the existing definition
> If the table already exists, the statement is a no-op even if the existing definition is different. To enforce a definition, use a migration framework that diffs schema. The `OR REPLACE` form does **not** exist for tables (it does for views, functions, procedures, triggers).



## Examples / Recipes



### Recipe: add a `NOT NULL` column to a huge live table


The naive `ALTER TABLE … ADD COLUMN … NOT NULL` requires every row to be backfilled before the column can be flagged not-null. The split-step approach:

```sql
-- 1. Add the column nullable with a constant default. PG11+ keeps this metadata-only.
ALTER TABLE app.big ADD COLUMN tier int DEFAULT 0;

-- 2. Backfill in batches if the default isn't sufficient (e.g. derived from another column).
DO $$
DECLARE
    rows_updated int;
BEGIN
    LOOP
        UPDATE app.big SET tier = compute_tier(customer_id)
        WHERE ctid IN (
            SELECT ctid FROM app.big WHERE tier IS NULL LIMIT 10000 FOR UPDATE SKIP LOCKED
        );
        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        EXIT WHEN rows_updated = 0;
        COMMIT;
    END LOOP;
END$$;

-- 3a. Portable across PG14–17: add a CHECK constraint, validate it, then promote.
--     (CHECK (col IS NOT NULL) is logically equivalent and supports NOT VALID + VALIDATE.)
ALTER TABLE app.big ADD CONSTRAINT big_tier_notnull CHECK (tier IS NOT NULL) NOT VALID;
ALTER TABLE app.big VALIDATE CONSTRAINT big_tier_notnull;
-- The CHECK can be left in place, or replaced with the proper NOT NULL via ALTER COLUMN SET NOT NULL —
-- with the CHECK already validated, SET NOT NULL still scans but the planner can use the CHECK to skip.

-- 3b. (PG18+) Set NOT NULL with NOT VALID directly on the column, then VALIDATE.
ALTER TABLE app.big ALTER COLUMN tier SET NOT NULL NOT VALID;
ALTER TABLE app.big VALIDATE CONSTRAINT big_tier_not_null;
```



### Recipe: add a CHECK constraint safely


```sql
-- Step 1: add the constraint, do not scan.
ALTER TABLE app.orders
    ADD CONSTRAINT chk_status CHECK (status IN ('open','paid','cancelled')) NOT VALID;

-- Step 2 (later, off-peak): validate.
ALTER TABLE app.orders VALIDATE CONSTRAINT chk_status;
```

Step 1 takes ACCESS EXCLUSIVE briefly. Step 2 takes only SHARE UPDATE EXCLUSIVE — readers and writers proceed.



### Recipe: rotate a partition into the archive


```sql
BEGIN;
-- 1. Detach without blocking writes.
ALTER TABLE app.measurements DETACH PARTITION app.measurements_2024q4 CONCURRENTLY;
COMMIT;

-- 2. (optional) Re-add as standalone in archive schema.
ALTER TABLE app.measurements_2024q4 SET SCHEMA archive;

-- 3. (much later) Drop.
DROP TABLE archive.measurements_2024q4;
```



### Recipe: clone a table's structure, exclude its identity


```sql
CREATE TABLE staging.orders (LIKE app.orders INCLUDING ALL EXCLUDING IDENTITY);
ALTER TABLE staging.orders ADD COLUMN id_orig bigint;
-- staging.orders now mirrors columns/constraints/indexes/defaults but its own id is plain bigint.
```



### Recipe: convert `SERIAL` to `IDENTITY` (in place)


```sql
BEGIN;
ALTER TABLE app.legacy ALTER COLUMN id DROP DEFAULT;   -- detach from the SERIAL sequence
ALTER TABLE app.legacy ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;  -- reuses the existing seq
COMMIT;
-- The implicit sequence (app.legacy_id_seq) is now owned by the identity column.
-- pg_dump output will use the IDENTITY syntax instead of SERIAL.
```



### Recipe: widen a column from `text` to `jsonb` without a long lock


```sql
-- Standard ALTER TYPE rewrites the table. To avoid the rewrite on a hot table:
-- 1. Add a new column.
ALTER TABLE app.events ADD COLUMN payload_v2 jsonb;

-- 2. Dual-write from the app layer; backfill in batches:
UPDATE app.events SET payload_v2 = payload::jsonb WHERE payload_v2 IS NULL AND id BETWEEN 1 AND 10000;
-- … repeat in batches …

-- 3. Cut over: rename in a single transaction with a short lock.
BEGIN;
ALTER TABLE app.events RENAME COLUMN payload    TO payload_legacy;
ALTER TABLE app.events RENAME COLUMN payload_v2 TO payload;
COMMIT;

-- 4. (later) Drop the legacy column.
ALTER TABLE app.events DROP COLUMN payload_legacy;
```



### Recipe: idempotent migration boilerplate


```sql
SET lock_timeout = '3s';
SET statement_timeout = '5min';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='app' AND table_name='orders' AND column_name='source'
    ) THEN
        ALTER TABLE app.orders ADD COLUMN source text;
    END IF;
END$$;

ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS country_code char(2);
ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS chk_legacy_status;
CREATE INDEX IF NOT EXISTS orders_status_idx ON app.orders (status);
```



## Gotchas / Anti-patterns


- **Don't `ALTER TABLE … ADD CONSTRAINT` without `NOT VALID`** on a large table during peak hours. The full-table scan blocks every reader and writer for the duration. Use `NOT VALID` + `VALIDATE CONSTRAINT`.
- **Don't `ALTER COLUMN TYPE`** on a hot table without a plan. It rewrites the whole table under ACCESS EXCLUSIVE. Prefer the new-column + backfill + rename trick (recipe above).
- **`CREATE TABLE IF NOT EXISTS` is not a schema check** — it silently no-ops if the table exists with a totally different shape. Use a real migration tool for schema-of-record.
- **`SERIAL` columns share an implicit sequence** that is *not* fully owned by the column unless `OWNED BY` is set. Prefer `IDENTITY`.
- **Identity gaps are normal.** Rolled-back transactions consume `nextval()` values. Apps that show identity to users should treat them as opaque, not as a sequence count.
- **`SET DEFAULT now()` does not retroactively populate** existing rows — `DEFAULT` applies only to future inserts. Backfill explicitly.
- **`DROP COLUMN` doesn't reclaim space.** The column becomes dropped-in-place metadata; storage stays until a table rewrite (`VACUUM FULL`, `CLUSTER`, or `pg_repack`).
- **Temporary tables aren't autovacuumed.** Long-lived sessions with frequently-mutated temp tables can build serious bloat; manual `VACUUM` in the session.
- **`UNLOGGED` tables do not replicate.** They exist only on the primary. They are truncated on crash recovery — never put anything you can't reconstruct in one.
- **Generated columns can't be indexed using a different expression**: the generated value *is* what's indexed. To index a different transformation of the same source columns, use an expression index on the source instead.
- **`ALTER TABLE` rolls back atomically — but at full cost.** A multi-action `ALTER TABLE` that rewrites the heap and fails halfway will not have committed any of the work, but you'll still have paid the I/O. Plan time accordingly.
- **`ON DELETE CASCADE` chains** can fan out unexpectedly far on large schemas. Use `EXPLAIN` on the equivalent SELECT to check before relying on cascading deletes for bulk cleanup.
- **`NULLS NOT DISTINCT` is opt-in.** If you've been using a partial unique index `(col) WHERE col IS NOT NULL` to express "at most one non-null", PG15+ lets you swap that for `UNIQUE NULLS NOT DISTINCT (col)` with simpler semantics and the constraint visible in `\d`.
- **Most managed providers** block `CREATE TABLESPACE`, custom collations, `CREATE EXTENSION` outside an allowlist, and `pg_repack`-style background rewrites. The DDL you write may be portable; the migration plan that depends on online rewrites may not be.
- **`recovery.conf` is gone.** If you're scripting standby setup with `CREATE TABLE` migrations as part of a base-image build, remember PG12+ uses `standby.signal` and `postgresql.conf` parameters instead. See [`73-streaming-replication.md`](./73-streaming-replication.md).



## See Also


- [`02-syntax-dql.md`](./02-syntax-dql.md) — `SELECT` syntax for querying what you just created
- [`03-syntax-dml.md`](./03-syntax-dml.md) — `INSERT`/`UPDATE`/`DELETE`/`MERGE` (the consumer of identity columns)
- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — picking column types
- [`15-data-types-custom.md`](./15-data-types-custom.md) — `CREATE TYPE`, `CREATE DOMAIN`, enums, ranges
- [`22-indexes-overview.md`](./22-indexes-overview.md) — choosing an index for new columns
- [`22-indexes-overview.md`](./22-indexes-overview.md) — `CREATE INDEX`, `CREATE INDEX CONCURRENTLY`, index types
- [`35-partitioning.md`](./35-partitioning.md) — the operational side of declarative partitioning
- [`37-constraints.md`](./37-constraints.md) — CHECK, UNIQUE, EXCLUDE, NOT VALID + VALIDATE
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — FK actions, partition-FK rules, indexing tradeoffs
- [`41-transactions.md`](./41-transactions.md) — transaction control, savepoints, DDL in transactions
- [`43-locking.md`](./43-locking.md) — full lock-conflict matrix for the locks named in this file
- [`46-roles-privileges.md`](./46-roles-privileges.md) — schema-level `GRANT`s and `ALTER DEFAULT PRIVILEGES`
- [`53-server-configuration.md`](./53-server-configuration.md) — GUCs that shadow per-table storage params
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — PITR and standby setup (recovery signal files replacing recovery.conf)
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — DDL capabilities commonly restricted by managed services



## Sources


[^create-table]: PostgreSQL 16 docs — `CREATE TABLE`. <https://www.postgresql.org/docs/16/sql-createtable.html>
[^alter-table]: PostgreSQL 16 docs — `ALTER TABLE`. <https://www.postgresql.org/docs/16/sql-altertable.html>
[^create-sequence]: PostgreSQL 16 docs — `CREATE SEQUENCE`. <https://www.postgresql.org/docs/16/sql-createsequence.html>
[^ddl-schemas]: PostgreSQL 16 docs — Chapter 5.9, Schemas. <https://www.postgresql.org/docs/16/ddl-schemas.html>
[^ddl-schemas-path]: PostgreSQL 16 docs — `CREATE SCHEMA`. <https://www.postgresql.org/docs/16/sql-createschema.html>
[^ddl-identity]: PostgreSQL 16 docs — Chapter 5, Data Definition (Identity Columns section is part of `CREATE TABLE` documentation). <https://www.postgresql.org/docs/16/ddl.html>
[^ddl-generated]: PostgreSQL 16 docs — Generated Columns (Section 5.3). <https://www.postgresql.org/docs/16/ddl-generated-columns.html>
[^ddl-partitioning]: PostgreSQL 16 docs — Table Partitioning (Section 5.11). <https://www.postgresql.org/docs/16/ddl-partitioning.html>
[^locking-docs]: PostgreSQL 16 docs — Explicit Locking. <https://www.postgresql.org/docs/16/explicit-locking.html>
[^pg11-fast-add-col]: PostgreSQL 11 release notes — "Allow `ALTER TABLE … ADD COLUMN` with a non-volatile `DEFAULT` to avoid a table rewrite." <https://www.postgresql.org/docs/release/11.0/>
[^pg14-detach-concurrently]: PostgreSQL 14 release notes — `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` and `FINALIZE`. <https://www.postgresql.org/docs/release/14.0/>
[^pg15-nulls-not-distinct]: PostgreSQL 15 release notes — `UNIQUE NULLS NOT DISTINCT`. <https://www.postgresql.org/docs/release/15.0/>
[^pg15-public]: PostgreSQL 15 release notes — `CREATE` privilege on `public` schema revoked for `PUBLIC`. <https://www.postgresql.org/docs/release/15.0/>
[^pg18-notnull]: PostgreSQL 18 release notes — "Store column `NOT NULL` specifications in `pg_constraint`" and "Allow `ALTER TABLE` to set the `NOT VALID` attribute of `NOT NULL` constraints". <https://www.postgresql.org/docs/release/18.0/>
[^pg18-temporal]: PostgreSQL 18 docs — `CREATE TABLE` (temporal `WITHOUT OVERLAPS` and FK `PERIOD`). <https://www.postgresql.org/docs/18/sql-createtable.html>
[^pg18-virtual]: PostgreSQL 18 docs — `CREATE TABLE` (virtual generated columns). <https://www.postgresql.org/docs/18/sql-createtable.html>

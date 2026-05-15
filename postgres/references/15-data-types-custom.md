# Custom Data Types — Composite, Domain, ENUM, Range, Multirange

Four user-defined type forms: **composite** (a named row type), **domain** (a named scalar with constraints and defaults), **ENUM** (a fixed-order string set), and **range** plus its companion **multirange** (a pair of bounds over an ordered subtype, plus an ordered list of such pairs). All four are first-class — usable as column types, function return types, function parameter types, even as the base of further domains.

This file is the canonical reference for picking the right one, declaring it correctly, evolving it without rewriting application code, and avoiding the traps each kind exposes. Built-in scalar types (text, numeric, timestamp, boolean, bytea, network types, bit-string) live in [`14-data-types-builtin.md`](./14-data-types-builtin.md); arrays in [`16-arrays.md`](./16-arrays.md); JSON/JSONB in [`17-json-jsonb.md`](./17-json-jsonb.md).


## Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Type-Selection Matrix](#type-selection-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Composite types](#composite-types)
    - [Domain types](#domain-types)
    - [ENUM types](#enum-types)
    - [Range and multirange types](#range-and-multirange-types)
    - [ALTER TYPE / ALTER DOMAIN forms](#alter-type--alter-domain-forms)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Reach for this file when you are about to:

- Define a typed row that does *not* need its own backing table (use a **composite**).
- Centralize a `CHECK` rule across many columns (use a **domain**).
- Constrain a column to a small, stable set of string values where ordering by declaration position matters (use an **ENUM** — but read the gotchas first; a lookup table is often the better default).
- Model an interval over an ordered subtype with overlap/containment semantics (use a **range** or **multirange**).
- Migrate from another database's `TYPE` / `DOMAIN` / `ENUM` features and need to know how PostgreSQL's semantics differ.

If you only need "varchar with a length" or "integer in 0..100", a column-level `CHECK` is simpler than a domain. If you only need "one of three states" and the set will grow, a lookup table is simpler than an ENUM. Domains and ENUMs are powerful but each carry a class of gotchas described below — pick them deliberately.


## Mental Model


Four guiding rules for picking and evolving custom types:

1. **Composite types are row shapes, not tables.** They have no rows, no indexes, no constraints, and no triggers. They are useful as function parameters, function return types, and occasionally as column types when the embedded fields will never be queried independently.
2. **Domain types are CHECK constraints with a name and a default.** They give you reuse across columns; they do *not* give you stronger NULL semantics than a column-level `NOT NULL` would. The widely-cited "domain `NOT NULL` is broken" complaint is real — see [Gotchas](#gotchas--anti-patterns).
3. **ENUM ordering is positional, immutable, and one-way.** You can add values; you cannot remove values; you can rename values; you cannot reorder values. If the set may be reordered or pruned, use a lookup table instead.
4. **Ranges are values, not relations.** A `tstzrange` is a single value in a column, like `numeric` is a single value. Range operators (`@>`, `&&`, `-|-`, …) are designed for set arithmetic over those values. Multirange (PG14+) adds disjoint unions to the same algebra.


## Type-Selection Matrix


| You need to model | Use | Avoid | Why |
|---|---|---|---|
| A typed row passed between functions | Composite type (`CREATE TYPE … AS (…)`) | A `RECORD` parameter | Named composite gives type-checked field access; `RECORD` is untyped and forces runtime lookups. |
| A scalar reused across many columns with one shared `CHECK` | Domain | Repeated `CHECK` clauses on each column | DRY constraint definition; rename + re-validate is centralized. |
| A scalar with one rule that is unique to a single column | Column-level `CHECK` | Domain | A domain just for one column is overhead. |
| A column that must be one of `'low' / 'medium' / 'high'` with that ordering | ENUM | `text` + `CHECK` | ENUM gives 4-byte storage and positional ordering; `text` requires the CHECK on every table. |
| Status codes that change often (add, deprecate, reorder) | Lookup table + FK | ENUM | ENUM members cannot be removed; lookup tables can. |
| Categorical column with thousands of distinct values | Lookup table + FK | ENUM | ENUM read-side overhead and ALTER cost grow with size. |
| A pair of timestamps for "valid from / valid to" with overlap detection | `tstzrange` + `EXCLUDE USING gist` | Two columns + a trigger | Built-in semantics, indexable, exclusion-constraint enforced. |
| Multiple disjoint reservation windows for one resource | `tstzmultirange` (PG14+) | Many rows of `tstzrange` | One row per resource; operators work on the whole set. |
| Reuse a numeric range type with a domain-specific subtype | Custom `RANGE` over a base type | A composite of `(lower, upper)` | Range operators only work on real range types. |


## Syntax / Mechanics



### Composite types


A composite type names a row shape. It has fields with types, optional per-field collation, and no constraints[^createtype].

```sql
CREATE TYPE inventory_item AS (
    name        text,
    supplier_id integer,
    price       numeric(10, 2)
);
```

Use it as a column type or a function I/O type:

```sql
CREATE TABLE on_hand (
    item   inventory_item,
    count  integer
);

CREATE FUNCTION price_extension(inventory_item, integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT $1.price * $2
$$;
```

**Literal forms.** Two equivalent ways to write a composite literal:

```sql
INSERT INTO on_hand VALUES ('("fuzzy dice", 42, 1.99)', 1000);
INSERT INTO on_hand VALUES (ROW('fuzzy dice', 42, 1.99), 1000);
```

In the string form: double-quote any field value containing a comma, parenthesis, or quote; an empty position between commas means NULL; `""` means empty string[^rowtypes].

**Field access requires parentheses around the composite reference.** This is the single most surprising parser rule for composite types:

```sql
SELECT item.name FROM on_hand;     -- ERROR: confuses `item` with a table
SELECT (item).name FROM on_hand;   -- correct
SELECT (on_hand.item).price        -- table-qualified
       FROM on_hand;
```

**`.*` expansion** is allowed only at top-level (SELECT list, RETURNING, VALUES, row constructor). Inside a function call `somefunc(c.*)` collapses back to `somefunc(c)` — no expansion happens[^rowtypes].

A subtle performance trap: `SELECT (myfunc(x)).*` re-evaluates `myfunc(x)` once per output field. Use a `LATERAL` instead:

```sql
SELECT m.* FROM some_table, LATERAL myfunc(x) AS m;
```

> [!NOTE] PostgreSQL 14
> User-defined relations have long had a composite type automatically created for them; PG14 added the same for system catalogs and removed the redundant composite types previously created for sequences and TOAST tables[^pg14-composite].

> [!NOTE] PostgreSQL 15
> A view or rule that references a specific column of a composite-returning function's result now records a dependency on that column. Previously the dependency was only on the whole composite type, which allowed dropping the column and breaking the view at later use[^pg15-composite].

When the field shape really is a row in disguise (it has its own identity, lifecycle, or cross-references), use a *table*, not a composite. Composites have no `PRIMARY KEY`, no `FOREIGN KEY` enforcement, and no indexes on inner fields.



### Domain types


A domain is a base type plus a name, optional collation, optional default, and zero or more `CHECK` / `NOT NULL` constraints[^createdomain]:

```sql
CREATE DOMAIN positive_int AS integer
    CHECK (VALUE > 0);

CREATE DOMAIN us_zip AS text
    CHECK (VALUE ~ '^\d{5}(-\d{4})?$');

CREATE DOMAIN email AS citext
    CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
```

Inside the `CHECK` clause, the placeholder for the value being checked is the keyword `VALUE`. Multiple checks are allowed and run in **alphabetical order by constraint name**[^createdomain].

```sql
CREATE DOMAIN small_string AS text
    CONSTRAINT a_nonempty CHECK (length(VALUE) > 0)
    CONSTRAINT b_short    CHECK (length(VALUE) <= 64);
```

**The `VALUE` placeholder is the only legal variable** in the CHECK expression. Subqueries and references to other columns are not allowed — domain checks are pure functions of the value being assigned.

**Domain auto-downcast** is the rule most often missed: when a value of domain `posint` flows through an arithmetic or function operator, the result is the *underlying* type, not the domain[^domains]:

```sql
CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
SELECT pg_typeof(my.id - 1) FROM tab my;   -- integer, not posint
SELECT pg_typeof((my.id - 1)::posint) FROM tab my;   -- posint (rechecks CHECK)
```

The cast `::posint` re-checks every constraint, raising `check_violation` (SQLSTATE `23514`) if the value would fail. This is how to *opt in* to revalidation in a complex expression.

> [!WARNING] Domain `NOT NULL` is weaker than a column `NOT NULL`
> The SQL-standard `NOT NULL` on a domain is documented to be enforced during type conversion only. Outer joins and empty-subquery results can still produce NULL values in a column typed as a `NOT NULL` domain[^createdomain]. The verbatim example from the docs:
>
> ```sql
> INSERT INTO tab (domcol) VALUES ((SELECT domcol FROM tab WHERE false));
> ```
>
> This succeeds even when `domcol`'s domain has `NOT NULL`. **Always set `NOT NULL` on the table column, not on the domain.** Leave domain definitions allowing NULL and constrain nullability at the column level.



### ENUM types


An ENUM is a typed set of string labels, ordered by declaration position, stored in 4 bytes[^enum]:

```sql
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');

CREATE TABLE person (
    name         text,
    current_mood mood
);

INSERT INTO person VALUES ('Pat', 'happy');
SELECT * FROM person WHERE current_mood > 'sad' ORDER BY current_mood;
```

**Comparison and ordering** work because ENUM values implement the b-tree operators; the comparison is by declaration position, not by label text. `'happy' > 'sad'` is `true` because `'happy'` appears after `'sad'` in the type declaration.

**Cross-type comparison is forbidden.** Two ENUMs that happen to share a label cannot be compared without explicit `::text` casts on both sides[^enum]:

```sql
-- ERROR: operator does not exist: mood = happiness
SELECT * FROM person, holidays WHERE person.current_mood = holidays.happiness;

-- Works
SELECT * FROM person, holidays
WHERE person.current_mood::text = holidays.happiness::text;
```

**Adding values:**

```sql
ALTER TYPE mood ADD VALUE 'great' AFTER 'happy';
ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh' BEFORE 'ok';
```

The `BEFORE` and `AFTER` clauses control *positional* placement, which is how the new value will sort. With no clause, the value is appended at the end[^altertype].

> [!WARNING] ADD VALUE inside a transaction has a tight restriction
> If `ALTER TYPE … ADD VALUE` runs inside a transaction block, the new value **cannot be used until after the transaction has been committed**[^altertype]. This applies to ENUM types that pre-existed the transaction.

> [!NOTE] PostgreSQL 17
> The above restriction was loosened for one specific case: an ENUM value added via `ALTER TYPE` *can* be used within the same transaction **if the type itself was created in that same transaction**[^pg17-enum]. The verbatim release note: *"Allow the use of an ENUM added via ALTER TYPE if the type was created in the same transaction (Tom Lane). This was previously disallowed."* Pre-existing ENUMs still cannot have a value added and used in the same transaction.

**Renaming values is always allowed, regardless of transaction context:**

```sql
ALTER TYPE mood RENAME VALUE 'ok' TO 'fine';
```

**Removing or reordering values is not supported.** The only path is rebuild: create a new type with the desired members and order, swap the columns, drop the old type. Recipe 7 below shows the canonical rebuild.

**Catalog inspection:**

```sql
SELECT enumlabel, enumsortorder
FROM pg_enum
WHERE enumtypid = 'mood'::regtype
ORDER BY enumsortorder;
```

The `enumsortorder` float8 column drives positional comparison. When you `ADD VALUE BEFORE x`, PG picks an `enumsortorder` value between the neighbor positions; this is why insertions never require rewriting existing tables (the on-disk OID for each label is fixed when the label is created).



### Range and multirange types


A range type pairs two bounds over an ordered subtype. Six built-in range types ship in the catalog, each with a corresponding multirange[^rangetypes]:

| Range | Subtype | Multirange (PG14+) |
|---|---|---|
| `int4range` | `integer` | `int4multirange` |
| `int8range` | `bigint` | `int8multirange` |
| `numrange` | `numeric` | `nummultirange` |
| `tsrange` | `timestamp` | `tsmultirange` |
| `tstzrange` | `timestamptz` | `tstzmultirange` |
| `daterange` | `date` | `datemultirange` |

> [!NOTE] PostgreSQL 14
> Multirange types were introduced in PG14. Each existing range type automatically got a paired multirange; user-defined range types get one too (override the name with the `MULTIRANGE_TYPE_NAME` option in `CREATE TYPE … AS RANGE`)[^pg14-multirange].

**Bound syntax.** Square bracket = inclusive, parenthesis = exclusive. Missing bound = infinity[^rangetypes]:

```sql
SELECT '[3, 7)'::int4range;       -- 3 included, 7 excluded
SELECT '[2024-01-01, )'::tstzrange;  -- unbounded above
SELECT 'empty'::int4range;         -- the empty range
```

**Constructor form** is usually clearer than the string form:

```sql
SELECT int4range(3, 7);            -- defaults to '[)'
SELECT int4range(3, 7, '(]');      -- explicit bound spec
SELECT tstzrange('2024-01-01', NULL);  -- unbounded above
```

**Operators.** The full set on `anyrange` and `anymultirange`[^rangetypes]:

| Operator | Meaning | Range example |
|---|---|---|
| `@>` | contains range or element | `int4range(1, 10) @> 5` |
| `<@` | contained by | `5 <@ int4range(1, 10)` |
| `&&` | overlaps | `tsrange(...) && tsrange(...)` |
| `<<` | strictly left of | `int4range(1, 3) << int4range(5, 7)` |
| `>>` | strictly right of | `int4range(5, 7) >> int4range(1, 3)` |
| `&<` | does not extend to the right of | |
| `&>` | does not extend to the left of | |
| `-\|-` | is adjacent to | `'[1, 3)' -\|- '[3, 5)'` is true |
| `*` | intersection | `int4range(1, 10) * int4range(5, 15)` → `[5, 10)` |
| `+` | union (range form fails if disjoint; multirange form always succeeds) | |
| `-` | difference (range form fails if disjoint result) | |

**Functions.** Inspect range structure[^rangefns]:

| Function | Returns |
|---|---|
| `lower(r)` / `upper(r)` | the bound, or NULL if empty/infinite |
| `isempty(r)` | bool |
| `lower_inc(r)` / `upper_inc(r)` | bound inclusivity |
| `lower_inf(r)` / `upper_inf(r)` | bound infinity |
| `range_merge(r1, r2)` | smallest range containing both |
| `range_merge(mr)` | smallest range containing a multirange |
| `multirange(r)` | range → 1-element multirange |
| `unnest(mr)` | multirange → set of ranges, ascending |

**Discrete vs continuous canonicalization.** Range types over a *discrete* subtype (`integer`, `date`) have a canonical form: the lower bound is inclusive, the upper is exclusive (`[)`). PG silently rewrites equivalent ranges to canonical form on input[^rangetypes]:

```sql
SELECT '[4, 8]'::int4range;   -- displayed as [4,9)
SELECT '(3, 8]'::int4range;   -- displayed as [4,9)
```

Continuous subtypes (`numeric`, `timestamp`, `timestamptz`) keep the bound exactly as written.

**Aggregates** for range/multirange[^rangetypes]:

| Aggregate | What it does | Available since |
|---|---|---|
| `range_agg(anyrange)` | builds the multirange union of input ranges | PG14 |
| `range_intersect_agg(anyrange)` | builds the intersection of input ranges (a range, possibly empty) | PG14 |
| `range_intersect_agg(anymultirange)` | same for multirange inputs | PG14 |

**Indexing.** GiST and SP-GiST accelerate `=`, `&&`, `<@`, `@>`, `<<`, `>>`, `-|-`, `&<`, `&>`. B-tree and hash give only equality[^rangetypes]:

```sql
CREATE INDEX ON reservations USING gist (during);
CREATE INDEX ON reservations USING spgist (during);   -- often faster build, smaller
```

**Custom range types.** Build a range over a non-built-in subtype:

```sql
CREATE TYPE floatrange AS RANGE (
    subtype       = float8,
    subtype_diff  = float8mi
);
```

For a discrete subtype, supply a `canonical = your_canonicalize_fn` function. For a custom multirange name, supply `multirange_type_name = your_multirange_name`[^createtype].



### ALTER TYPE / ALTER DOMAIN forms


`ALTER TYPE` has ten forms; relevant ones for custom types[^altertype]:

| Form | Applies to |
|---|---|
| `RENAME TO` | all |
| `OWNER TO` | all |
| `SET SCHEMA` | all |
| `RENAME ATTRIBUTE … TO …` | composite only |
| `ADD ATTRIBUTE … type` | composite only |
| `DROP ATTRIBUTE … [IF EXISTS]` | composite only |
| `ALTER ATTRIBUTE … SET DATA TYPE …` | composite only |
| `ADD VALUE [IF NOT EXISTS] 'x' [BEFORE\|AFTER 'y']` | ENUM only |
| `RENAME VALUE 'old' TO 'new'` | ENUM only |
| `SET ( prop = val [, …] )` | base type properties only (RECEIVE, SEND, TYPMOD_IN/OUT, ANALYZE, SUBSCRIPT, STORAGE) |

`ALTER DOMAIN` has its own forms[^alterdomain]:

| Form | Notes |
|---|---|
| `SET DEFAULT expr` / `DROP DEFAULT` | applies to subsequent inserts |
| `SET NOT NULL` / `DROP NOT NULL` | fails if existing values would violate; see the domain `NOT NULL` warning above |
| `ADD CONSTRAINT … [NOT VALID]` | `NOT VALID` skips check against existing data |
| `VALIDATE CONSTRAINT name` | runs the deferred check |
| `DROP CONSTRAINT [IF EXISTS] name [RESTRICT\|CASCADE]` | |
| `RENAME CONSTRAINT … TO …` | |
| `RENAME TO` / `OWNER TO` / `SET SCHEMA` | |

The **`NOT VALID` + `VALIDATE`** pattern is the same as for tables: add the constraint without scanning existing rows (instant), then validate when the resulting `SHARE UPDATE EXCLUSIVE` scan is acceptable[^alterdomain]:

```sql
ALTER DOMAIN us_zip
    ADD CONSTRAINT zipchk CHECK (char_length(VALUE) = 5)
    NOT VALID;

-- later, possibly during a maintenance window
ALTER DOMAIN us_zip VALIDATE CONSTRAINT zipchk;
```

> [!WARNING] ALTER DOMAIN with constraints fails if the domain is used in a container
> If the domain appears as a field of a composite, an element of an array, or the subtype of a range, `ALTER DOMAIN … ADD CONSTRAINT` currently fails[^alterdomain]. The workaround is to rebuild the container types or migrate the column off the domain first.


## Examples / Recipes



### Recipe 1 — Composite type as function I/O


When a function needs to accept or return a structured value that has no table behind it:

```sql
CREATE TYPE point2d AS (x double precision, y double precision);

CREATE FUNCTION distance(point2d, point2d)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT sqrt(($2.x - $1.x)^2 + ($2.y - $1.y)^2)
$$;

SELECT distance(ROW(0, 0)::point2d, ROW(3, 4)::point2d);   -- 5
```

The `IMMUTABLE` and `PARALLEL SAFE` markings let the planner inline the SQL function — see [`06-functions.md`](./06-functions.md) for the inlining rules.



### Recipe 2 — Composite column with parenthesized field access


```sql
CREATE TYPE addr AS (street text, city text, postal text);

CREATE TABLE customer (
    id   bigint PRIMARY KEY,
    ship addr
);

INSERT INTO customer VALUES (1, ROW('100 Main', 'Pleasantville', '12345'));

SELECT (ship).city FROM customer;       -- ✓
SELECT ship.city  FROM customer;        -- ERROR
```

For more than one or two fields, prefer separate columns — composite columns work but disable per-field indexes, statistics, and `NOT NULL`.



### Recipe 3 — Domain for an externally-defined format


An RFC-ish email domain reused across multiple tables:

```sql
CREATE DOMAIN email_addr AS citext
    CHECK (VALUE ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

CREATE TABLE customer (
    id    bigint PRIMARY KEY,
    email email_addr NOT NULL          -- ← NOT NULL on the column, not the domain
);

CREATE TABLE subscriber (
    id    bigint PRIMARY KEY,
    email email_addr NOT NULL
);
```

The `citext` underlying type makes equality case-insensitive. For the trade-offs of `citext` vs nondeterministic collations see [`65-collations-encoding.md`](./65-collations-encoding.md). `NOT NULL` lives on each table column, not on the domain — see gotcha #4 for why.



### Recipe 4 — Domain online migration with NOT VALID


Rolling out a stricter domain rule without rewriting existing rows:

```sql
ALTER DOMAIN positive_int
    ADD CONSTRAINT no_zero CHECK (VALUE > 0)
    NOT VALID;

-- application is updated to reject zero on the way in

-- during maintenance: confirm all existing data also conforms
ALTER DOMAIN positive_int VALIDATE CONSTRAINT no_zero;
```

If validation fails it identifies the offending row by raising `check_violation` (SQLSTATE `23514`). Diagnose with:

```sql
SELECT table_schema, table_name, column_name
FROM information_schema.columns
WHERE domain_name = 'positive_int';
-- then SELECT … WHERE col <= 0 from each table
```



### Recipe 5 — ENUM ADD VALUE in deployment


Standard deploy pattern with a non-zero risk of touching transactional code:

```sql
-- migration script (runs OUTSIDE a transaction block)
ALTER TYPE mood ADD VALUE IF NOT EXISTS 'great' AFTER 'happy';
```

The `IF NOT EXISTS` makes the migration idempotent. **Critically: run `ALTER TYPE … ADD VALUE` outside a transaction block** so the new value is immediately usable. If your migration framework wraps everything in `BEGIN…COMMIT`, the new value cannot be referenced by any subsequent statement in the same transaction (except in PG17+ when the *type itself* was created in that transaction — see [Mechanics](#enum-types)).

```sql
-- Won't work pre-PG17 (and even in PG17, only if `mood` was just created):
BEGIN;
ALTER TYPE mood ADD VALUE 'great';
UPDATE person SET current_mood = 'great' WHERE name = 'Pat';   -- ERROR
COMMIT;
```



### Recipe 6 — Renaming an ENUM value


Renaming is safe and transactional. No row rewrite happens because storage references the value by an internal OID, not by label:

```sql
BEGIN;
ALTER TYPE mood RENAME VALUE 'ok' TO 'fine';
COMMIT;
```

All existing rows immediately read as `'fine'`. Application code can be updated independently.



### Recipe 7 — Removing or reordering ENUM values (rebuild)


Direct removal is unsupported; the canonical pattern is *rebuild and swap*:

```sql
BEGIN;

-- 1. New type with the desired members and order
CREATE TYPE mood_v2 AS ENUM ('terrible', 'sad', 'fine', 'happy');

-- 2. Per affected column, convert via text (string label match)
ALTER TABLE person
    ALTER COLUMN current_mood TYPE mood_v2
    USING current_mood::text::mood_v2;

-- 3. Drop the old type
DROP TYPE mood;
ALTER TYPE mood_v2 RENAME TO mood;

COMMIT;
```

Caveats: every column referencing the old type must be converted in the same transaction, and the `text` cast will raise an `invalid_text_representation` error for any row whose label is not in the new set. Map those rows beforehand with an `UPDATE`.

The rebuild is schema-intrusive. A lookup table (Recipe 8) avoids this entirely when the set may change.



### Recipe 8 — Lookup table as an ENUM alternative


When the value set may evolve in either direction:

```sql
CREATE TABLE mood (
    code  text PRIMARY KEY,             -- 'sad', 'ok', 'happy'
    label text NOT NULL,
    sort  integer NOT NULL UNIQUE,
    deprecated_at timestamptz
);

INSERT INTO mood (code, label, sort) VALUES
    ('sad',   'Sad',    10),
    ('ok',    'OK',     20),
    ('happy', 'Happy',  30);

CREATE TABLE person (
    name         text PRIMARY KEY,
    current_mood text NOT NULL REFERENCES mood(code)
);
```

The `sort` column gives application-controlled ordering (which can change without touching tables). `deprecated_at` lets you retire values without rewriting history. The FK gives the same data-integrity guarantee as an ENUM. For FK mechanics and index requirements see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).



### Recipe 9 — Non-overlapping time ranges with EXCLUDE


The single most-cited reason to reach for ranges: enforce that no two rows for the same resource share overlapping intervals[^rangetypes]:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE reservation (
    id         bigint PRIMARY KEY,
    room_id    bigint NOT NULL,
    during     tstzrange NOT NULL,
    EXCLUDE USING gist (room_id WITH =, during WITH &&)
);
```

The `btree_gist` extension is what makes the equality comparison (`room_id WITH =`) participate in a GiST exclusion constraint. The `EXCLUDE` constraint rejects any insert where another row has the same `room_id` AND `&&`-overlaps in `during`. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for the full exclusion-constraint surface.



### Recipe 10 — Multirange to consolidate disjoint windows (PG14+)


One row per resource, holding all the windows in a single column:

```sql
CREATE TABLE worker_schedule (
    worker_id  bigint PRIMARY KEY,
    available  tstzmultirange NOT NULL
);

INSERT INTO worker_schedule VALUES
    (1, '{[2026-05-01 09:00, 2026-05-01 12:00),
          [2026-05-01 13:00, 2026-05-01 17:00)}');

-- Does worker 1 overlap with a meeting?
SELECT EXISTS (
    SELECT 1 FROM worker_schedule
    WHERE worker_id = 1
      AND available && tstzrange('2026-05-01 11:30', '2026-05-01 13:15')
);
```

Built-in functions get this for free: `range_agg` to aggregate ranges into a multirange; `unnest` to expand back; the full operator algebra (`&&`, `@>`, `+`, `-`, `*`) works on multiranges too.



### Recipe 11 — Custom range type over a domain-specific subtype


A "version number" type where ranges are useful for compatibility intervals:

```sql
-- subtype already supports b-tree ordering (semver as integer)
CREATE TYPE semver_range AS RANGE (
    subtype = integer
);

CREATE TABLE feature_support (
    feature      text PRIMARY KEY,
    versions     semver_range
);

INSERT INTO feature_support VALUES
    ('jsonb_path_query',  int4range(120000, 999999, '[)')),
    ('virtual_generated', int4range(180000, 999999, '[)'));

-- Which features support v15.4 = 150004?
SELECT feature FROM feature_support WHERE versions @> 150004;
```

For a discrete subtype, declare a canonical function (see [`sql-createtype`][^createtype]) to normalize equivalent representations.



### Recipe 12 — Aggregate ranges into a multirange


When you have N rows of ranges (e.g., individual bookings) and want the combined coverage as one multirange:

```sql
SELECT room_id, range_agg(during) AS booked
FROM reservation
GROUP BY room_id;
```

The inverse is `unnest`:

```sql
SELECT worker_id, unnest(available) AS slot
FROM worker_schedule;
```

`range_intersect_agg` produces the intersection of all input ranges (an empty range if any input is disjoint from the rest).



### Recipe 13 — Catalog audit: list all custom types and domains in a schema


```sql
-- All ENUMs and their labels
SELECT t.typname,
       array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname
ORDER BY t.typname;

-- All composite types (excluding the auto-generated ones for tables)
SELECT t.typname,
       array_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                 ORDER BY a.attnum) AS fields
FROM pg_type t
JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname
ORDER BY t.typname;

-- All domains, their base types, and constraints
SELECT t.typname AS domain_name,
       format_type(t.typbasetype, t.typtypmod) AS base_type,
       d.conname AS constraint_name,
       pg_get_constraintdef(d.oid) AS constraint_def
FROM pg_type t
LEFT JOIN pg_constraint d ON d.contypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'd'
  AND n.nspname = 'public'
ORDER BY t.typname, d.conname;
```

See [`64-system-catalogs.md`](./64-system-catalogs.md) for the catalog reference. `pg_type.typtype` distinguishes the four kinds: `c` composite, `d` domain, `e` ENUM, `r` range, `m` multirange, `b` base, `p` pseudo.



### Recipe 14 — Find every column that uses a given domain


Before dropping or modifying a domain, you need to find its callers:

```sql
SELECT n.nspname AS schema,
       c.relname AS table,
       a.attname AS column
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE t.typname = 'email_addr'
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'm')   -- ordinary, partitioned, matview
ORDER BY n.nspname, c.relname, a.attname;
```

For dependencies that route through composite/array/range, walk `pg_depend` — see [`64-system-catalogs.md`](./64-system-catalogs.md).


## Gotchas / Anti-patterns


1. **Composite field access without parentheses parses as `table.column`.** `SELECT item.name FROM tab` fails because the parser tries `item` as a table name. Always write `(item).name`. This is a one-time learning cost — once you've hit it, you remember forever.

2. **`SELECT (myfunc(x)).*` calls `myfunc(x)` once per field.** N invocations for N fields, each one redoing the work. Use `SELECT m.* FROM tab, LATERAL myfunc(x) AS m` to call once and explode[^rowtypes].

3. **Composite columns hide structure from per-field indexes and statistics.** A `WHERE (ship).city = 'NYC'` does not use a normal index on the table — you would need an expression index `CREATE INDEX ON customer (((ship).city))`. Per-field constraints (`NOT NULL`, `CHECK`) cannot apply to composite sub-fields. Prefer separate columns unless the composite is truly always handled as a single value.

4. **Domain `NOT NULL` does not stop NULL from outer joins or empty-subquery inserts.** See the `> [!WARNING]` in [Domain types](#domain-types) for the verbatim doc quote and example. **Always set `NOT NULL` on the column.**

5. **Domain values auto-downcast to the base type in arithmetic.** `posint - 1` returns `integer`, not `posint`, so the CHECK does not re-run. To re-validate, cast back: `(posint - 1)::posint`[^domains].

6. **`ALTER DOMAIN … ADD CONSTRAINT` fails if the domain is buried inside a composite, array, or range.** Plan domain rollouts before nesting them into container types. To recover, drop and re-add the constraint on the container type or migrate columns off the domain first[^alterdomain].

7. **ENUM `ADD VALUE 'x'` inside a transaction cannot be used until COMMIT.** See the restriction in [ENUM types](#enum-types) and the deployment recipe in [Recipe 5](#recipe-5--enum-add-value-in-deployment). Migration tools need a "no transaction" escape — `psql` has `\set AUTOCOMMIT on`; Flyway-style tools usually offer a per-migration flag.

8. **ENUM values cannot be dropped.** `ALTER TYPE … DROP VALUE` does not exist. To remove a value, rebuild the type (Recipe 7) or move to a lookup table (Recipe 8). Renaming is fine.

9. **ENUM ordering is positional, not lexicographic.** `'low' < 'medium' < 'high'` works only because of declaration order — alphabetically `'high' < 'low' < 'medium'`. If the application surface needs lexical ordering, cast to `text` for the comparison or use a lookup-table `sort` column.

10. **Cross-ENUM comparisons require an explicit `::text` cast on both sides.** Even if two ENUMs share labels, `mood_v1.x = mood_v2.x` is rejected; write `mood_v1.x::text = mood_v2.x::text`[^enum].

11. **Discrete range types silently canonicalize on input.** `'[4, 8]'::int4range` displays as `[4, 9)` (see [Range and multirange types](#range-and-multirange-types)). Always compare ranges semantically (`=`, `@>`, etc.) rather than via text representation[^rangetypes].

12. **An empty range and an unbounded range are not the same.** `'empty'::int4range` contains nothing; `'(,)'::int4range` contains everything. `isempty()` distinguishes them. Containment tests on `'(,)'` always return true.

13. **`range_agg` and `range_intersect_agg` are PG14+.** On earlier versions you need to write your own aggregate or fall back to client-side computation.

14. **GiST/SP-GiST indexes accelerate range operators; b-tree does not.** A b-tree index on a range column only supports equality. For `&&`, `@>`, `<@`, `-|-` you must use `USING gist` or `USING spgist` (the latter is often smaller and faster to build for the built-in range types).

15. **Range exclusion constraints require `btree_gist` only when combining b-tree-only operators (like `=`) with range operators.** `EXCLUDE USING gist (during WITH &&)` alone works without `btree_gist`; adding `room_id WITH =` to the constraint is what pulls in the extension.

16. **`CREATE DOMAIN d AS d2` is allowed but rarely necessary.** Domain over domain works (a layered constraint), but a flat domain over the base type is almost always clearer. Reserve nested domains for genuine taxonomy (`positive_money` AS `money_amount` AS `numeric(12,2)`).

17. **A column typed as a domain still appears in `pg_attribute.atttypid` as the domain's OID, not the base type's OID.** Audit queries that filter by base type (e.g., "all `integer` columns") will miss columns typed by an integer-based domain. Walk through `pg_type.typbasetype` if you need to include them.

18. **A type used as a column type cannot be dropped without `CASCADE`** — and `CASCADE` drops every column too. Use Recipe 14 to find dependencies first; migrate columns off the type before `DROP TYPE`.

19. **Range subtype `RECORD`/composite is rarely useful.** PostgreSQL allows it but the canonical comparison/ordering semantics over a composite are usually surprising. If the subtype is a composite, you almost certainly want a different data model (two scalar columns + a CHECK on `lower <= upper`).


## See Also


- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — `CREATE TABLE`, column-level CHECK constraints (the alternative to a domain for one-column rules), and the lock matrix for `ALTER TABLE … ADD COLUMN type`.
- [`06-functions.md`](./06-functions.md) — composite types as function I/O, the `RETURNS TABLE` form, polymorphic types `anyelement` / `anyrange` / `anymultirange`.
- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — built-in scalars (text, numeric, timestamp, boolean, bytea, network, bit).
- [`16-arrays.md`](./16-arrays.md) — array types (including arrays of composite types, domains, and ENUMs).
- [`17-json-jsonb.md`](./17-json-jsonb.md) — when JSON is better than a composite column for semi-structured data.
- [`19-timestamp-timezones.md`](./19-timestamp-timezones.md) — the `timestamp` vs `timestamptz` decision, which determines `tsrange` vs `tstzrange` for time interval modeling.
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GiST and SP-GiST for range types, the `btree_gist` extension, exclusion constraints.
- [`37-constraints.md`](./37-constraints.md) — table-level CHECK, EXCLUDE constraints (the home of the exclusion-constraint deep dive).
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — FK on a lookup-table column as an alternative to ENUM (and the FK-into-partitioned-table rules).
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_type` (`typtype` enumeration), `pg_enum`, `pg_range`, `pg_attribute` joins for type audits.
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — version-by-version index of type-system changes.


## Sources


[^createtype]: PostgreSQL 16 — `CREATE TYPE`. Full grammar for composite, ENUM, RANGE, base, and shell forms; default behavior of automatic array-type creation; the `MULTIRANGE_TYPE_NAME` option for RANGE types. https://www.postgresql.org/docs/16/sql-createtype.html

[^createdomain]: PostgreSQL 16 — `CREATE DOMAIN`. Includes the explicit warning about `NOT NULL` and outer joins / empty subqueries, the `VALUE` placeholder rule, the alphabetical evaluation order of multiple CHECK constraints. https://www.postgresql.org/docs/16/sql-createdomain.html

[^rowtypes]: PostgreSQL 16 — Composite Types (chapter 8.16). Field access requires parentheses; `.*` only expands at top level; the `(myfunc(x)).*` performance trap with the LATERAL-rewrite remedy. https://www.postgresql.org/docs/16/rowtypes.html

[^domains]: PostgreSQL 16 — Domain Types (chapter 8.18). The auto-downcast rule (`posint - 1` is `integer`); cast back with `::domain` to re-check the constraint. https://www.postgresql.org/docs/16/domains.html

[^enum]: PostgreSQL 16 — Enumerated Types (chapter 8.7). Positional ordering, 4-byte storage, 63-byte label limit, case-sensitive labels, cross-ENUM comparison requires `::text`. https://www.postgresql.org/docs/16/datatype-enum.html

[^altertype]: PostgreSQL 16 — `ALTER TYPE`. The ten ALTER TYPE forms; the verbatim restriction *"If `ALTER TYPE ... ADD VALUE` (the form that adds a new value to an enum type) is executed inside a transaction block, the new value cannot be used until after the transaction has been committed."* https://www.postgresql.org/docs/16/sql-altertype.html

[^alterdomain]: PostgreSQL 16 — `ALTER DOMAIN`. The full set of forms; `NOT VALID` / `VALIDATE CONSTRAINT` workflow; the limitation that constraint changes fail if the domain is used in a composite, array, or range. https://www.postgresql.org/docs/16/sql-alterdomain.html

[^rangetypes]: PostgreSQL 16 — Range Types (chapter 8.17). Six built-in range types and their multirange variants; bracket/parenthesis bound notation; operator catalog; discrete vs continuous canonicalization rule with the `[4,8]`→`[4,9)` example; GiST/SP-GiST indexing rule; the `EXCLUDE USING gist (during WITH &&)` exclusion-constraint pattern. https://www.postgresql.org/docs/16/rangetypes.html

[^rangefns]: PostgreSQL 16 — Range/Multirange Functions and Operators. `lower`/`upper`/`isempty`/`lower_inc`/`upper_inc`/`lower_inf`/`upper_inf`/`range_merge`/`multirange`/`unnest`; range-vs-multirange operator differences (range `+` fails on disjoint, multirange `+` succeeds). https://www.postgresql.org/docs/16/functions-range.html

[^pg14-multirange]: PostgreSQL 14 release notes. Verbatim: *"Add support for multirange data types (Paul Jungwirth, Alexander Korotkov). These are like range data types, but they allow the specification of multiple, ordered, non-overlapping ranges. An associated multirange type is automatically created for every range type."* https://www.postgresql.org/docs/release/14.0/

[^pg14-composite]: PostgreSQL 14 release notes. Two related items: *"Remove the composite types that were formerly created for sequences and toast tables (Tom Lane)"* and *"Create composite array types for system catalogs (Wenjing Zeng). User-defined relations have long had composite types associated with them, and also array types over those composite types. System catalogs now do as well."* https://www.postgresql.org/docs/release/14.0/

[^pg15-composite]: PostgreSQL 15 release notes. Verbatim: *"Track dependencies on individual columns in the results of functions returning composite types (Tom Lane). Previously, if a view or rule contained a reference to a specific column within the result of a composite-returning function, that was not noted as a dependency; the view or rule was only considered to depend on the composite type as a whole."* https://www.postgresql.org/docs/release/15.0/

[^pg17-enum]: PostgreSQL 17 release notes. Verbatim: *"Allow the use of an ENUM added via ALTER TYPE if the type was created in the same transaction (Tom Lane). This was previously disallowed."* The PG17 change applies only when the ENUM type was created in the same transaction; the general restriction on pre-existing ENUMs remains. https://www.postgresql.org/docs/release/17.0/

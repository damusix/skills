# hstore — The Legacy Key/Value Type


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Installation](#installation)
    - [Literal Forms and I/O Representation](#literal-forms-and-io-representation)
    - [NULL Handling and Duplicate Keys](#null-handling-and-duplicate-keys)
    - [Operator Catalog](#operator-catalog)
    - [Function Catalog](#function-catalog)
    - [Subscripting (PG14+)](#subscripting-pg14)
    - [Conversions to and from JSON](#conversions-to-and-from-json)
    - [Indexing: GIN, GiST, B-tree, hash](#indexing-gin-gist-b-tree-hash)
    - [Storage and size considerations](#storage-and-size-considerations)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file when:

- You inherited a schema that uses `hstore` and need to read, query, or migrate it
- A library, ORM, or vendor extension you cannot replace stores data in `hstore`
- You need the operator/function catalog to write `hstore`-aware code on an existing column
- You are choosing between `hstore` and [`jsonb`](./17-json-jsonb.md) for new code — this file's recommendation is **always pick `jsonb`** unless you can point at a concrete reason `hstore` wins (you usually can't)
- You need the canonical `hstore` → `jsonb` migration recipe (Recipe 7 below)

> [!WARNING] Default for new code is `jsonb`, not `hstore`
> `hstore` predates `jsonb` by about a decade. It is a single-level string-keyed map. It cannot store nested structure, cannot distinguish strings from numbers from booleans from null, and is missing most of the operator surface that makes `jsonb` ergonomic. For new schemas use [`jsonb`](./17-json-jsonb.md). Use `hstore` only when you can articulate a specific reason it beats `jsonb` for your case — see the [Decision Matrix](#decision-matrix).


## Mental Model

Five rules. Internalize these and you can read, write, and migrate `hstore` columns correctly.

1. **`hstore` is a legacy single-level string-to-string map.** *"This module implements the `hstore` data type for storing sets of key/value pairs within a single PostgreSQL value … Keys and values are simply text strings."*[^hstore] No nesting. No arrays. No numbers. No booleans. No JSON-null vs SQL-NULL distinction. If your value needs *any* of those, you have outgrown `hstore` and should be on [`jsonb`](./17-json-jsonb.md).

2. **Values can be SQL `NULL`; keys cannot.** *"A value (but not a key) can be an SQL `NULL`. For example: `key => NULL`. The `NULL` keyword is case-insensitive. Double-quote the `NULL` to treat it as the ordinary string `'NULL'`."*[^hstore-null] The `defined(h, k)` function distinguishes "key absent" from "key present with NULL value"; the `?` operator does not.

3. **Duplicate keys are silently dropped, last-write-unspecified.** *"Each key in an `hstore` is unique. If you declare an `hstore` with duplicate keys, only one will be stored in the `hstore` and there is no guarantee as to which will be kept."*[^hstore-dup] Same behavior as `jsonb`; a silent bug source on input from multi-valued sources.

4. **The default index is GIN, just like `jsonb`.** `gin_hstore_ops` supports `@>`, `?`, `?&`, `?|`. `gist_hstore_ops` is a lossy bitmap-signature opclass primarily useful when combining `hstore` with other GiST-indexable columns in a single index. B-tree and hash support only `=` on the whole value.

5. **`hstore` is a trusted extension.** Since PG13, `hstore` can be installed by any non-superuser with `CREATE` privilege on the database (subject to `pg_available_extensions.trusted = true`). On managed providers this generally means `CREATE EXTENSION hstore` works without elevation.

> [!NOTE] PostgreSQL 14
> Generalized subscripting was added to `hstore`. `h['key']` is now legal for both read (returns the value or NULL) and write (`UPDATE t SET h['k'] = 'v'` replaces or inserts). *"Allow subscripting of hstore values"*[^pg14-sub]. Subscripted fetch returns `NULL` if the key does not exist; subscripted update fails if the subscript itself is `NULL`.

> [!NOTE] PostgreSQL 14
> The deprecated containment operators `@` and `~` were removed: *"Remove deprecated containment operators `@` and `~` for built-in geometric data types and contrib modules cube, hstore, intarray, and seg … The more consistently named `<@` and `@>` have been recommended for many years."*[^pg14-remove-ops] If you are upgrading from a very old codebase and have stored procedures containing the bare `@` or `~` operators on `hstore` columns, those will fail to parse on PG14+.

PG15, PG16, PG17, and PG18 have **no `hstore`-specific release-note changes**.


## Decision Matrix

Use this table when picking a key/value type for a new column. The bias is heavy toward [`jsonb`](./17-json-jsonb.md).

| You need… | Use | Avoid | Why |
|---|---|---|---|
| Nested or hierarchical structure | `jsonb` | `hstore` | `hstore` is flat. Nesting is impossible without serializing inner values as JSON strings — at which point use `jsonb` natively |
| Mixed-type values (string, number, bool, null) | `jsonb` | `hstore` | All `hstore` values are text. Numeric comparison, boolean filtering, and JSON-null-vs-missing-key distinction require `jsonb` |
| Schema-flexible tags / sparse attributes | `jsonb` | `hstore` | `jsonb` does everything `hstore` does, plus more, with active development |
| Single-level string-only key/value, existing schema | Keep `hstore` | Force a migration | Migration cost is real; if the column already works and is indexed, leave it |
| Single-level string-only key/value, new schema | `jsonb` | `hstore` | Modern tooling, ORMs, dashboards, monitoring agents understand `jsonb`. Many do not understand `hstore` |
| Truly homogeneous list of string labels | `text[]` (see [16-arrays.md](./16-arrays.md)) | `hstore` | An array is the right type when there are no keys, only values |
| Fixed shape and named fields | Composite type (see [15-data-types-custom.md](./15-data-types-custom.md)) | `hstore` | Composites get column-level constraints, type-checked field access, and pg_dump fidelity |
| Many similar rows you want to index per-key on `=` | Child table | `hstore` | "EAV-in-a-column" is a smell; if you really query by key all the time, normalize |
| HTTP header / cookie store where everything is text | `hstore` is acceptable | — | All values are strings by spec; `?` and `->` are concise. Still defensible. `jsonb` works equally well. |
| Environment-variable-style map for short-lived rows | `hstore` is acceptable | — | Same shape as `setenv`: short, flat, all text. `jsonb` works equally well. |

No use cases left where `hstore` strictly beats `jsonb`. Rows 9–10 are ties. Every other case: `jsonb`.


## Syntax / Mechanics

### Installation

`hstore` ships with the standard PostgreSQL distribution (`contrib`), but is not enabled by default. Install per-database:

    CREATE EXTENSION IF NOT EXISTS hstore;

The extension is marked **trusted** in `pg_available_extensions`, so a non-superuser holding `CREATE` on the database may install it.

Inventory check:

    SELECT extname, extversion, extnamespace::regnamespace
    FROM pg_extension
    WHERE extname = 'hstore';

Two related transform extensions exist for procedural languages: `hstore_plperl` / `hstore_plperlu` (Perl hashes) and `hstore_plpython3u` (Python dicts). Install only if you actually invoke `hstore` from those languages. The docs warn: *"It is strongly recommended that the transform extensions be installed in the same schema as `hstore`. Otherwise there are installation-time security hazards if a transform extension's schema contains objects defined by a hostile user."*[^hstore-transform]

### Literal Forms and I/O Representation

Input: a comma-separated list of `key => value` pairs.

    SELECT 'a=>1, b=>2'::hstore;
    --       hstore
    -- "a"=>"1", "b"=>"2"

    SELECT 'foo => bar, baz => "with whitespace"'::hstore;

    SELECT 'with comma => "x, y", with arrow => "x=>y"'::hstore;

Quoting rules from the docs:

- Whitespace between pairs and around `=>` is ignored.
- Keys and values must be double-quoted if they contain whitespace, commas, `=`, or `>`.
- Backslash-escape `"` and `\` inside quoted strings.
- Output **always** double-quotes both keys and values, regardless of input form.

Constructor functions (preferred for programmatic input, identical to `format()`-vs-concatenation in safety):

    SELECT hstore('a', '1');                                -- "a"=>"1"
    SELECT hstore(ARRAY['a', '1', 'b', '2']);               -- alternating
    SELECT hstore(ARRAY['a', 'b'], ARRAY['1', '2']);        -- parallel arrays
    SELECT hstore(ROW(1, 'two'));                           -- field-named: "f1"=>"1", "f2"=>"two"

> [!WARNING] String concatenation into `hstore` literals is unsafe
> Never build `hstore` input by `'key=>' || user_value || ',...'`. Use the constructor functions or the `||` operator on already-typed `hstore` values. The injection surface is the same as for any text format and the parser will silently accept badly-quoted input that gives the wrong key/value pairs.

### NULL Handling and Duplicate Keys

Three rules every `hstore` query must respect:

- A **value** may be `NULL`. Literal form: `key => NULL` (case-insensitive). The string `'NULL'` requires explicit double quotes: `key => "NULL"`.[^hstore-null]
- A **key** cannot be `NULL`. Literal `NULL => 1` is rejected.
- **Duplicate keys** are silently deduplicated, last-write-unspecified (see Mental Model rule 3).[^hstore-dup]

The `?` (key-exists) and `defined()` (key-exists-with-non-null-value) operators disagree on present-NULL:

    SELECT ('a => NULL'::hstore) ? 'a';            -- t   (key is present)
    SELECT defined('a => NULL'::hstore, 'a');      -- f   (value is NULL)
    SELECT ('a => NULL'::hstore) -> 'a' IS NULL;   -- t   (cannot distinguish from missing)

To distinguish "key absent" from "key present, NULL value," use `?` plus `defined()`, or `?` plus `IS NULL`.

### Operator Catalog

All operators from the `hstore.html` reference, with type signatures.

| Operator | Signature | Description | Example | Result |
|---|---|---|---|---|
| `->` | `hstore -> text → text` | Value for key, NULL if absent | `'a=>x,b=>y'::hstore -> 'a'` | `x` |
| `->` | `hstore -> text[] → text[]` | Values for many keys, NULL for missing | `'a=>x,b=>y'::hstore -> ARRAY['b','c']` | `{y,NULL}` |
| `\|\|` | `hstore \|\| hstore → hstore` | Concatenate; RHS keys win on conflict | `'a=>1,b=>2'::hstore \|\| 'b=>9,c=>3'::hstore` | `"a"=>"1","b"=>"9","c"=>"3"` |
| `?` | `hstore ? text → bool` | Contains key (present, possibly NULL value) | `'a=>1'::hstore ? 'a'` | `t` |
| `?&` | `hstore ?& text[] → bool` | Contains **all** specified keys | `'a=>1,b=>2'::hstore ?& ARRAY['a','b']` | `t` |
| `?\|` | `hstore ?\| text[] → bool` | Contains **any** specified key | `'a=>1,b=>2'::hstore ?\| ARRAY['b','c']` | `t` |
| `@>` | `hstore @> hstore → bool` | LHS contains RHS (all pairs present) | `'a=>1,b=>2'::hstore @> 'b=>2'::hstore` | `t` |
| `<@` | `hstore <@ hstore → bool` | LHS is contained in RHS | `'a=>1'::hstore <@ 'a=>1,b=>2'::hstore` | `t` |
| `-` | `hstore - text → hstore` | Delete key | `'a=>1,b=>2'::hstore - 'a'::text` | `"b"=>"2"` |
| `-` | `hstore - text[] → hstore` | Delete multiple keys | `'a=>1,b=>2,c=>3'::hstore - ARRAY['a','b']` | `"c"=>"3"` |
| `-` | `hstore - hstore → hstore` | Delete pairs that match (both key and value) | `'a=>1,b=>2'::hstore - 'a=>4,b=>2'::hstore` | `"a"=>"1"` |
| `=` | `hstore = hstore → bool` | Equal (order-independent, key/value-wise) | `'a=>1,b=>2'::hstore = 'b=>2,a=>1'::hstore` | `t` |
| `#=` | `anyelement #= hstore → anyelement` | Override fields of a composite from `hstore` | `ROW(1,3) #= 'f1=>11'::hstore` | `(11,3)` |
| `%%` | `%% hstore → text[]` | Alternating keys/values flat array | `%% 'a=>1,b=>2'::hstore` | `{a,1,b,2}` |
| `%#` | `%# hstore → text[]` | 2D key/value array | `%# 'a=>1,b=>2'::hstore` | `{{a,1},{b,2}}` |

Three of these have the same shape as the [`jsonb`](./17-json-jsonb.md) catalog (`->`, `@>`, `<@`, `?`, `?&`, `?|`, `||`, `-`), which makes mental translation easy. Two are unique to `hstore`: `#=` for composite-override and `%%` / `%#` for flat-array export.

### Function Catalog

| Function | Returns | Description |
|---|---|---|
| `hstore(text, text)` | `hstore` | Single-pair constructor |
| `hstore(text[])` | `hstore` | From alternating or 2D array |
| `hstore(text[], text[])` | `hstore` | From parallel key and value arrays |
| `hstore(record)` | `hstore` | From row, using column names as keys |
| `akeys(h)` | `text[]` | Keys as an array |
| `skeys(h)` | `setof text` | Keys as a set (for `FROM`) |
| `avals(h)` | `text[]` | Values as an array |
| `svals(h)` | `setof text` | Values as a set |
| `hstore_to_array(h)` | `text[]` | Alternating-flat key/value array |
| `hstore_to_matrix(h)` | `text[][]` | 2D key/value matrix |
| `slice(h, text[])` | `hstore` | Subset containing only listed keys |
| `each(h)` | `setof (key text, value text)` | Iterate pairs in `FROM` |
| `exist(h, text)` | `bool` | Same as `?` |
| `defined(h, text)` | `bool` | Key present **and** value is not NULL |
| `delete(h, text)` | `hstore` | Same as `-` text |
| `delete(h, text[])` | `hstore` | Same as `-` text[] |
| `delete(h, hstore)` | `hstore` | Same as `-` hstore |
| `populate_record(comp, h)` | composite | Override fields of composite from `hstore`; same as `#=` |
| `hstore_to_json(h)` | `json` | Strict — all values become JSON strings |
| `hstore_to_jsonb(h)` | `jsonb` | Strict — all values become JSON strings |
| `hstore_to_json_loose(h)` | `json` | Heuristic — numeric/boolean strings become JSON numbers/booleans |
| `hstore_to_jsonb_loose(h)` | `jsonb` | Heuristic — numeric/boolean strings become JSON numbers/booleans |

`each()` is the workhorse for unpacking an `hstore` row-wise:

    SELECT (each(h)).key, (each(h)).value FROM t;
    -- or, the FROM-clause variant:
    SELECT t.id, kv.key, kv.value
    FROM t, LATERAL each(t.h) AS kv;

### Subscripting (PG14+)

> [!NOTE] PostgreSQL 14
> `hstore` supports the generalized subscripting mechanism. Read with `h['key']`, write with `UPDATE t SET h['k'] = 'v'`. Verbatim release-note: *"Allow subscripting of hstore values"*[^pg14-sub].

Read semantics:

    SELECT h['username'] FROM t WHERE id = 1;
    -- NULL if key 'username' is absent OR present with NULL value.
    -- Use ? + defined() to distinguish (see Recipe 4).

Write semantics:

    UPDATE t SET h['username'] = 'alice' WHERE id = 1;   -- inserts or replaces
    UPDATE t SET h['username'] = NULL WHERE id = 1;       -- sets value to SQL NULL (key stays present)
    UPDATE t SET h = h - 'username' WHERE id = 1;         -- actually delete the key

Subscripted update with a NULL **subscript** raises an error; subscripted update with a NULL **value** stores the NULL.

Pre-PG14 deployments must use the operator/function forms (`h -> 'k'`, `h || hstore('k', 'v')`, `h - 'k'`).

### Conversions to and from JSON

`hstore_to_jsonb()` is the primary migration path. Two variants:

- **Strict** (`hstore_to_jsonb`): every value emerges as a JSON string. `'count=>42'::hstore` → `{"count": "42"}`.
- **Loose** (`hstore_to_jsonb_loose`): if a value looks like a JSON number or boolean, it is emitted as that type. `'count=>42, ok=>true'::hstore` → `{"count": 42, "ok": true}`.

The loose form is convenient for migrations *if* you trust the source data, but it is a heuristic — `'count=>007'::hstore` emits `{"count": 7}` (leading zero lost) so for *audit*-grade migrations prefer the strict form plus an application-side typed cast.

For the reverse direction, `jsonb_each_text(j)` produces a `(key, value)` row set you can pass to `hstore(...)`. This only works for flat, all-text `jsonb`; nested structure cannot be represented in `hstore`. See Recipe 8.

### Indexing: GIN, GiST, B-tree, hash

| Index type | Opclass | Operators supported | When to use |
|---|---|---|---|
| GIN | `gin_hstore_ops` (default) | `@>`, `?`, `?&`, `?|` | The default for any `hstore` column you query by containment or key existence |
| GiST | `gist_hstore_ops` | `@>`, `?`, `?&`, `?|` | Smaller than GIN, lossy, useful when you need a composite index combining `hstore` with another GiST-indexable column (e.g., a range type) |
| B-tree | default | `=` only on whole value | Equality lookups on the entire `hstore` value; required for `UNIQUE` or `GROUP BY`/`ORDER BY` on the column |
| hash | default | `=` only on whole value | Equality lookups; smaller than B-tree but only equality |

Index creation:

    CREATE INDEX t_attrs_gin ON t USING gin (attrs);                    -- default gin_hstore_ops
    CREATE INDEX t_attrs_gin_strict ON t USING gin (attrs gin_hstore_ops);

    CREATE INDEX t_attrs_gist ON t USING gist (attrs);                   -- default gist_hstore_ops
    CREATE INDEX t_attrs_gist_long ON t USING gist (attrs gist_hstore_ops(siglen = 32));

The `gist_hstore_ops` opclass exposes a `siglen` parameter (default 16 bytes, range 1–2024). *"Longer signatures lead to a more precise search (scanning a smaller fraction of the index and fewer heap pages), at the cost of a larger index."*[^hstore-gist]

> [!NOTE] PostgreSQL 18
> Parallel GIN index build is available, which materially reduces `REINDEX` time on large `hstore` columns under high `maintenance_work_mem`. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for the full GIN tuning surface.

Functional B-tree on a single hoisted key is the standard way to support `=` on a single key:

    CREATE INDEX t_username_idx ON t ((attrs -> 'username'));
    SELECT * FROM t WHERE attrs -> 'username' = 'alice';   -- uses the index

### Storage and size considerations

`hstore` is a varlena type and follows the standard TOAST rules — values above the TOAST threshold (~2KB after compression) move out-of-line to the `pg_toast.pg_toast_*` heap. See [`31-toast.md`](./31-toast.md) for the full TOAST mechanics.

Practical sizing rules of thumb:

- Empty `hstore` (`''::hstore`): 4 bytes (varlena header).
- Per pair on-disk: roughly `4 + 4 + len(key) + len(value)` bytes plus alignment padding.
- `jsonb` of the same data is typically 10–25% smaller because numeric values are stored in binary, not as text.
- `gin_hstore_ops` index entries are one posting per `(key, value)` pair. A column with N distinct keys × M distinct values has up to N × M postings — large indexes when the value space is unbounded.
- `gist_hstore_ops` with default `siglen=16` is more compact than GIN by roughly an order of magnitude, but is lossy and requires a heap recheck for every match.

When migrating from a wide `hstore` to `jsonb`, expect roughly 10–25% storage reduction on the heap and a similar reduction on the GIN index.


## Examples / Recipes

### Recipe 1 — Baseline schema with GIN

    CREATE EXTENSION IF NOT EXISTS hstore;

    CREATE TABLE event (
        id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ts    timestamptz NOT NULL DEFAULT now(),
        attrs hstore NOT NULL DEFAULT ''
    );

    CREATE INDEX event_attrs_gin ON event USING gin (attrs);

    INSERT INTO event (attrs) VALUES
        ('source => web, user => alice, action => login'),
        ('source => api, user => bob, action => signup, plan => "pro"'),
        ('source => web, user => alice, action => view, page => "/dashboard"');

    -- Containment is GIN-accelerated
    SELECT * FROM event WHERE attrs @> 'source => web';

    -- Key-exists also GIN-accelerated
    SELECT * FROM event WHERE attrs ? 'plan';

The `NOT NULL DEFAULT ''` makes `attrs @> 'k=>v'` safe without `IS NULL` gymnastics; the empty `hstore` is a valid value distinct from SQL NULL.

### Recipe 2 — Hot single-key access via functional B-tree

When one key is queried far more often than the others, hoist it to its own B-tree:

    CREATE INDEX event_user_idx ON event ((attrs -> 'user'));

    EXPLAIN ANALYZE
    SELECT * FROM event WHERE attrs -> 'user' = 'alice';

GIN on the whole column accelerates `attrs @> 'user=>alice'`; the functional B-tree above is faster for `attrs -> 'user' = 'alice'` because B-tree is more selective than GIN postings for a single key/value. Keep both if both forms are used. Prefer migrating the hot key to its own typed column once it's clearly the access pattern.

### Recipe 3 — Audit query: find all `hstore` columns in a database

    SELECT n.nspname  AS schema,
           c.relname  AS table,
           a.attname  AS column
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE t.typname = 'hstore'
      AND c.relkind IN ('r', 'p')
      AND NOT a.attisdropped
    ORDER BY n.nspname, c.relname, a.attnum;

Run this before any database-wide migration. The `relkind IN ('r', 'p')` filter covers ordinary tables and partitioned tables; foreign tables and views are intentionally excluded — see [`64-system-catalogs.md`](./64-system-catalogs.md) for the full `relkind` enumeration.

### Recipe 4 — Distinguish "key absent" from "key present with NULL value"

The `?` operator and `defined()` function disagree on present-NULL, and the `->` operator alone cannot tell the two cases apart:

    -- Key absent
    SELECT 'a=>1'::hstore -> 'b' IS NULL;            -- t (because key b absent)
    SELECT 'a=>1'::hstore ? 'b';                      -- f
    SELECT defined('a=>1'::hstore, 'b');             -- f

    -- Key present with NULL
    SELECT 'a=>1, b=>NULL'::hstore -> 'b' IS NULL;   -- t (because value is NULL)
    SELECT 'a=>1, b=>NULL'::hstore ? 'b';            -- t
    SELECT defined('a=>1, b=>NULL'::hstore, 'b');    -- f

The discriminator: `attrs ? 'b' AND attrs -> 'b' IS NULL` means key present with NULL value. Equivalently `attrs ? 'b' AND NOT defined(attrs, 'b')`.

### Recipe 5 — Convert all values to a uniform type via `each()`

`hstore_to_jsonb_loose()` is one way, but if you want to validate or transform each value before emitting, use `each()`:

    -- Cast every numeric-looking string value to numeric, leaving non-numerics as text in jsonb
    SELECT id,
           jsonb_object_agg(kv.key,
               CASE WHEN kv.value ~ '^-?\d+(\.\d+)?$' THEN to_jsonb(kv.value::numeric)
                    ELSE to_jsonb(kv.value)
               END
           ) AS j
    FROM event, LATERAL each(attrs) AS kv
    GROUP BY id;

This is the pattern to reach for when migrating a column with semi-structured data — strict `hstore_to_jsonb()` would emit all values as strings, losing numeric semantics.

### Recipe 6 — Update via subscript (PG14+) vs operator forms

    -- PG14+: subscript syntax
    UPDATE event SET attrs['ip'] = '10.0.0.1' WHERE id = 17;
    UPDATE event SET attrs = attrs - 'ip' WHERE id = 17;        -- delete still uses operator

    -- Operator form (all versions)
    UPDATE event SET attrs = attrs || hstore('ip', '10.0.0.1') WHERE id = 17;
    UPDATE event SET attrs = attrs - 'ip' WHERE id = 17;

The subscript syntax does not have a "delete key" form — `UPDATE ... SET h['k'] = NULL` stores a NULL value, it does not remove the key. Use `attrs = attrs - 'k'` to actually delete.

### Recipe 7 — Migrate an `hstore` column to `jsonb`

This is the canonical recipe and the reason most readers are in this file. Online, lock-light variant:

    -- Step 1: Add the new column (fast metadata-only change)
    ALTER TABLE event ADD COLUMN attrs_j jsonb;

    -- Step 2: Backfill in batches; commit between batches to keep autovacuum healthy.
    -- Loose form preserves numeric/boolean values where they look like numbers/booleans.
    -- Strict form (hstore_to_jsonb) preserves the original-as-string fidelity.
    UPDATE event
    SET attrs_j = hstore_to_jsonb_loose(attrs)
    WHERE attrs_j IS NULL
      AND id BETWEEN $1 AND $2;

    -- Step 3: Add the GIN index concurrently
    CREATE INDEX CONCURRENTLY event_attrs_j_gin ON event USING gin (attrs_j);

    -- Step 4: Migrate readers to the new column; verify in shadow traffic.

    -- Step 5: When confident, swap and drop. This briefly locks the table.
    BEGIN;
    ALTER TABLE event DROP COLUMN attrs;
    ALTER TABLE event RENAME COLUMN attrs_j TO attrs;
    COMMIT;

Pick `hstore_to_jsonb_loose` for the typical "we want numbers as numbers in the new column" intent. Pick `hstore_to_jsonb` (strict) when audit-grade fidelity matters — leading zeros, locale-tagged numeric strings, and any value that *looks* numeric but is semantically text (US zip codes, account numbers) are preserved as-is.

After the swap, follow the JSONB indexing recipe in [`17-json-jsonb.md`](./17-json-jsonb.md) (Recipe 1) for the canonical GIN + generated-column + B-tree-on-hot-scalar baseline.

### Recipe 8 — Migrate `jsonb` to `hstore` (rare; for compatibility only)

Only works for flat, all-string-value `jsonb`. Any nested object or non-string value will lose information.

    SELECT id,
           (SELECT hstore(array_agg(k), array_agg(v))
            FROM jsonb_each_text(j) AS kv(k, v)) AS h
    FROM things;

If `jsonb_each_text(j)` raises on a row, that row contains a nested object (`jsonb_each_text` only descends one level; nested objects come back as their JSON serialization, which is usually not what you want). The presence of any such row is your signal that the migration direction is wrong.

### Recipe 9 — Override composite fields with `#=` / `populate_record`

`#=` is the unique-to-`hstore` operator that overrides named fields of a composite row from an `hstore`:

    CREATE TYPE addr AS (street text, city text, postcode text);

    SELECT ROW('1 High St', 'London', 'SW1A 1AA')::addr
           #= 'postcode => "EC1A 1BB"'::hstore;
    -- ("1 High St", London, "EC1A 1BB")

This is structurally a partial-update against a row literal. The `jsonb` equivalent is `jsonb_populate_record(target_composite, j::jsonb)` — same shape, more general because `jsonb` can carry non-string fields.

### Recipe 10 — Compare two `hstore` rows: changed vs added vs removed

`a - b` returns the pairs in `a` whose (key, value) pair is not exactly present in `b`. To get a full diff:

    WITH cur AS (SELECT 'a=>1, b=>2, c=>3'::hstore AS h),
         prev AS (SELECT 'a=>1, b=>20, d=>4'::hstore AS h)
    SELECT
        cur.h - akeys(prev.h)  AS added,           -- keys in cur not in prev: {c=>3}
        prev.h - akeys(cur.h)  AS removed,         -- keys in prev not in cur: {d=>4}
        cur.h - prev.h         AS changed_or_new   -- pairs in cur not in prev: {b=>2, c=>3}
    FROM cur, prev;

`changed_or_new` is the union of "added" and "changed"; subtract `added` from it to get pure "changed."

### Recipe 11 — Build an `hstore` from a query result row

    SELECT hstore(t) FROM (SELECT 1 AS f1, 'two' AS f2) AS t;
    -- "f1"=>"1", "f2"=>"two"

Useful for snapshotting a row into a change log without enumerating columns. Note that all values are converted to text — typed columns lose their type. The `jsonb` analogue (`to_jsonb(t)`) preserves types and is the recommended approach for new audit-log schemas.

### Recipe 12 — Inspect index size and bloat for an `hstore` GIN

    SELECT pg_size_pretty(pg_relation_size('event_attrs_gin'))     AS index_size,
           pg_size_pretty(pg_relation_size('event'))               AS heap_size,
           round(pg_relation_size('event_attrs_gin')::numeric
                 / NULLIF(pg_relation_size('event'), 0) * 100, 2)  AS pct_of_heap
    FROM pg_class
    WHERE relname = 'event';

GIN on a wide `hstore` column with many distinct keys regularly reaches 30–80% of heap size. If yours exceeds 100%, you have either too many distinct keys (consider hoisting the high-cardinality ones to columns) or are missing a routine `REINDEX` cycle — see [`26-index-maintenance.md`](./26-index-maintenance.md).

### Recipe 13 — One-shot ALTER COLUMN TYPE for small tables

For tables small enough that an `ACCESS EXCLUSIVE` lock for a few seconds is acceptable, the in-place type swap is the shortest migration:

    BEGIN;
    LOCK TABLE event IN ACCESS EXCLUSIVE MODE;     -- explicit so the lock is obvious

    -- Drop the old GIN index first (otherwise PG must rebuild it as it rewrites the heap)
    DROP INDEX event_attrs_gin;

    -- Type swap; the USING expression converts every row.
    ALTER TABLE event
        ALTER COLUMN attrs TYPE jsonb USING hstore_to_jsonb_loose(attrs);

    -- Re-add the index under jsonb's default opclass
    CREATE INDEX event_attrs_gin ON event USING gin (attrs jsonb_path_ops);

    COMMIT;

This pattern is only sane below a few million rows on warm cache. For anything larger or with non-trivial concurrent traffic, use the additive Recipe 7 (add column → backfill → swap → drop) instead. The `ACCESS EXCLUSIVE` lock here blocks readers and writers for the duration of the rewrite.

> [!WARNING] Foreign keys to the renamed column
> If anything references the `attrs` column directly (CHECK constraints citing it, generated columns derived from it, view definitions, downstream subscriptions), they must be rebuilt after the type change. Run a `pg_depend` audit before flipping the type — see [`64-system-catalogs.md`](./64-system-catalogs.md).

### Recipe 14 — Enumerate all keys across all rows

The "what keys exist in this column?" diagnostic is essential before any migration. `akeys()` returns keys per row; flatten with `unnest`:

    SELECT k AS key, count(*) AS row_count
    FROM event, LATERAL unnest(akeys(attrs)) AS k
    GROUP BY k
    ORDER BY row_count DESC;

This is the equivalent of the JSONB recipe `SELECT key FROM event, jsonb_object_keys(attrs::jsonb)` for an `hstore` column. Sort descending to find your high-cardinality keys — those are the migration-to-typed-column candidates.

### Recipe 15 — Detect rows whose values violate an expected type

`hstore` will happily store the string `"not a number"` in a column you mentally think of as numeric. Audit before relying on `::int` casts:

    SELECT id, attrs -> 'count' AS bad_count
    FROM event
    WHERE attrs ? 'count'
      AND (attrs -> 'count') !~ '^-?\d+$';

The negation of an integer regex catches NULL values from `->` automatically (NULL `!~ regex` is NULL, which is falsy in the WHERE clause). To explicitly include NULL-value rows: `OR (attrs ? 'count' AND attrs -> 'count' IS NULL)`.

### Recipe 16 — Side-by-side: same query in `hstore` and `jsonb`

This table is the cheat sheet for translating an `hstore`-using codebase to `jsonb` without changing query semantics:

| Operation | `hstore` | `jsonb` |
|---|---|---|
| Extract value as text | `h -> 'k'` | `j ->> 'k'` |
| Extract value as typed JSON | n/a (all text) | `j -> 'k'` |
| Containment | `h @> 'a=>1'::hstore` | `j @> '{"a": 1}'::jsonb` (value type must match) |
| Key exists | `h ? 'k'` | `j ? 'k'` |
| All listed keys exist | `h ?& ARRAY['a','b']` | `j ?& ARRAY['a','b']` |
| Any listed key exists | `h ?\| ARRAY['a','b']` | `j ?\| ARRAY['a','b']` |
| Merge (RHS wins) | `h \|\| h2` | `j \|\| j2` (shallow, RHS wins) |
| Delete key | `h - 'k'` | `j - 'k'` |
| Delete multiple keys | `h - ARRAY['k1','k2']` | `j - ARRAY['k1','k2']` |
| Iterate pairs | `each(h)` | `jsonb_each(j)` / `jsonb_each_text(j)` |
| Set value (insert or replace) | `h \|\| hstore('k','v')` or `h['k'] = 'v'` (PG14+) | `jsonb_set(j, '{k}', '"v"'::jsonb)` |
| GIN default opclass | `gin_hstore_ops` | `jsonb_ops` |
| Compact GIN opclass | `gist_hstore_ops` (lossy) | `jsonb_path_ops` (smaller, `@>` only) |

Most operators have identical names. The biggest behavioral differences sit on containment (`hstore` is all-text on both sides; `jsonb` is type-strict) and on extraction (`hstore` has only one form; `jsonb` has `->` for typed extraction and `->>` for text extraction).

### Recipe 17 — Round-trip a row to and from `hstore` for change auditing

A common `hstore` pattern is "snapshot a row before update, snapshot after, compute diff." The `hstore(record)` constructor makes this concise:

    CREATE TABLE change_log (
        change_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        changed_at    timestamptz NOT NULL DEFAULT now(),
        table_name    text NOT NULL,
        row_key       text NOT NULL,
        before_attrs  hstore NOT NULL,
        after_attrs   hstore NOT NULL,
        changed_only  hstore GENERATED ALWAYS AS (after_attrs - before_attrs) STORED
    );

    -- In a trigger or app code, with OLD and NEW as the trigger record:
    -- INSERT INTO change_log (table_name, row_key, before_attrs, after_attrs)
    -- VALUES (TG_TABLE_NAME, NEW.id::text, hstore(OLD), hstore(NEW));

The `before_attrs - after_attrs` form (in `changed_only`) returns the pairs in *after* that are not exactly in *before* — i.e., the new and changed pairs. Reverse the operands to get *removed and previous values of changed*. For the modern equivalent see [`03-syntax-dml.md`](./03-syntax-dml.md) Recipe 11 (`RETURNING old.*, new.*` in PG18+) and [`39-triggers.md`](./39-triggers.md) for trigger plumbing. `to_jsonb(row)` is the type-preserving replacement that does not silently text-cast every column.


## Gotchas / Anti-patterns

1. **All values are text.** `'count => 42'::hstore -> 'count' + 1` raises `operator does not exist: text + integer`. You must cast: `('count => 42'::hstore -> 'count')::int + 1`. The `jsonb` equivalent (`'{"count":42}'::jsonb ->> 'count'`) has the same shape, but `('{"count":42}'::jsonb -> 'count')::int` is a cleaner cast because `jsonb` preserves the numeric form.

2. **No nesting.** `'a => "b => c"'::hstore -> 'a'` gives the *string* `'b => c'`, not an `hstore`. If you wanted nesting you wanted `jsonb`.

3. **No JSON-null vs SQL-NULL distinction.** `jsonb` has both `null` (a JSON value) and SQL NULL (no row produced); `hstore` has only SQL NULL as a value, and `'key=>NULL'::hstore -> 'key' IS NULL` returns `t` indistinguishably from key-missing. See Recipe 4 for the discriminator.

4. **`?` says yes for present-but-NULL keys; `defined()` says no.** This is the trap in Gotcha 3 in operator form. If you want "key present with a real value," use `defined(h, k)` (or `h ? k AND h -> k IS NOT NULL`), not `h ? k`.

5. **Duplicate keys silently dedupe with no winner-guarantee.** Per the docs verbatim: *"there is no guarantee as to which will be kept."*[^hstore-dup] If input may have duplicates, dedupe explicitly in your application before constructing the `hstore`.

6. **GIN does not accelerate `->` extraction or `->>`-style equality.** GIN indexes the *set of key/value pairs*; it accelerates `@>`, `?`, `?&`, `?|`. For single-key equality (`h -> 'k' = 'v'`), add a functional B-tree on `(h -> 'k')` (Recipe 2).

7. **B-tree and hash on the whole `hstore` are rarely useful.** They only accelerate `=` of the *whole* value. The docs say so plainly: *"The sort ordering for `hstore` values is not particularly useful, but these indexes may be useful for equivalence lookups."*[^hstore-btree] Reserve for cases where you genuinely need `UNIQUE (h)` or `GROUP BY h`.

8. **Concatenation `||` is RHS-wins.** `'a=>1,b=>2'::hstore || 'b=>9'::hstore` is `"a"=>"1","b"=>"9"`. Same as `jsonb ||`. If you want LHS-wins, swap operands.

9. **The `-` operator on `hstore - hstore` deletes *pairs*, not *keys*.** `'a=>1,b=>2'::hstore - 'b=>9'::hstore` is `"a"=>"1","b"=>"2"` (the `b` pair is *not* removed because `b=>9 ≠ b=>2`). To delete by keys, use `h - akeys(other)` or `h - ARRAY['b']`.

10. **Subscripted update with NULL value keeps the key.** `UPDATE t SET h['k'] = NULL` stores SQL NULL as the value of `k`; it does not remove `k` from `h`. Use `UPDATE t SET h = h - 'k'` to actually delete.

11. **The deprecated `@` and `~` containment operators were removed in PG14.** Old code using `attrs @ 'key=>val'::hstore` will fail to parse. Replace with `@>` and `<@`. Verbatim release-note: *"The more consistently named `<@` and `@>` have been recommended for many years."*[^pg14-remove-ops]

12. **`hstore_to_jsonb_loose` is a heuristic, not an audit-grade conversion.** A value of `"007"` becomes JSON `7`; a value of `"1.0"` becomes JSON `1.0` but `"1.00"` becomes JSON `1` (trailing-zero normalization). For audit-grade migrations use strict `hstore_to_jsonb` and cast on the application side.

13. **`hstore` is single-level. `each()` is the deepest iteration.** Treating an `hstore`-encoded JSON-string-as-value as nested data is a smell that says you should be on `jsonb`.

14. **`hstore` columns are not understood by most ORMs out of the box.** SQLAlchemy and Django ORM have explicit support; many smaller frameworks treat the column as text and round-trip with no operator surface. `jsonb` has near-universal driver support.

15. **`hstore` is not the same as `text[]`.** If your column never has unique keys (e.g., a multi-set of tags), [`text[]`](./16-arrays.md) is the right type. `hstore` keys are unique — you cannot represent a tag-with-count via repeated keys.

16. **The `gist_hstore_ops` opclass is lossy.** Like all GiST text-signature opclasses, it returns a candidate set that must be rechecked against the heap. For most workloads GIN is faster overall. Reach for GiST only if you need a single index combining `hstore` with another GiST-only column (a range, a geometry, a tsvector).

17. **Trusted-extension status does not equal automatic availability on managed services.** Even though `hstore` is a trusted extension, some providers gate `CREATE EXTENSION` behind an allowlist. Check `pg_available_extensions` before assuming you can install it; the constraint is the provider's allowlist, not the PG `trusted` flag. See [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md).

18. **The `%%` and `%#` operators are easy to mis-type.** `%%` returns a flat alternating array; `%#` returns a 2D matrix. The two single-character difference is subtle and the operators read the same in casual prose. Prefer the named function forms (`hstore_to_array(h)` and `hstore_to_matrix(h)`) in production code — they are self-documenting and don't punish a typo with a wrong result.

19. **`hstore_to_json` (strict) and `hstore_to_json_loose` produce different JSON Schemas.** A downstream consumer expecting integer fields will silently misbehave if you swap strict for loose mid-migration. Pick one form per pipeline and stick to it.

20. **`hstore` predates and is independent of `pg_dump --column-inserts`.** A dump of a wide `hstore` column is large and slow because the canonical text form double-quotes every key and every value. If your backups are bottlenecked on a particular table with a heavy `hstore` column, migrating to `jsonb` reduces dump size by 20–40% in typical workloads because `jsonb`'s canonical form omits redundant quoting for numbers, booleans, and bareword-safe keys.

21. **`hstore` is not maintained for new features.** The last meaningful core change was PG14 subscripting. All subsequent changes are bug fixes. New schema-flexible features go to `jsonb` and the SQL/JSON family; `hstore` does not get them.


## See Also

- [`17-json-jsonb.md`](./17-json-jsonb.md) — the recommended replacement for almost every `hstore` use case
- [`16-arrays.md`](./16-arrays.md) — when there are no keys, only values
- [`15-data-types-custom.md`](./15-data-types-custom.md) — composite types as a typed alternative for fixed-shape rows
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — deep dive on GIN and GiST that the `gin_hstore_ops` / `gist_hstore_ops` opclasses ride on
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `REINDEX CONCURRENTLY`, GIN-specific maintenance considerations
- [`31-toast.md`](./31-toast.md) — TOAST mechanics for oversized `hstore` values
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_extension` audit, `relkind` enumeration used in Recipe 3
- [`69-extensions.md`](./69-extensions.md) — extension installation, trusted-extension model, version upgrades
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — version-feature tracker including PG14 subscripting addition and `@`/`~` removal
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — extension allowlist constraints on managed environments


## Sources

[^hstore]: PostgreSQL 16 docs, "F.18. hstore" — *"This module implements the `hstore` data type for storing sets of key/value pairs within a single PostgreSQL value. This can be useful in various scenarios, such as rows with many attributes that are rarely examined, or semi-structured data. Keys and values are simply text strings."* https://www.postgresql.org/docs/16/hstore.html

[^hstore-null]: PostgreSQL 16 docs, "F.18.1. hstore External Representation" — *"A value (but not a key) can be an SQL NULL. For example: `key => NULL`. The NULL keyword is case-insensitive. Double-quote the NULL to treat it as the ordinary string `'NULL'`."* https://www.postgresql.org/docs/16/hstore.html

[^hstore-dup]: PostgreSQL 16 docs, "F.18.1. hstore External Representation" — *"Each key in an `hstore` is unique. If you declare an `hstore` with duplicate keys, only one will be stored in the `hstore` and there is no guarantee as to which will be kept."* https://www.postgresql.org/docs/16/hstore.html

[^hstore-transform]: PostgreSQL 16 docs, "F.18.6. Transforms" — *"It is strongly recommended that the transform extensions be installed in the same schema as `hstore`. Otherwise there are installation-time security hazards if a transform extension's schema contains objects defined by a hostile user."* https://www.postgresql.org/docs/16/hstore.html

[^hstore-gist]: PostgreSQL 16 docs, "F.18.3. Indexes" — *"`gist_hstore_ops` GiST opclass approximates a set of key/value pairs as a bitmap signature. Its optional integer parameter `siglen` determines the signature length in bytes. The default length is 16 bytes. Valid values of signature length are between 1 and 2024 bytes. Longer signatures lead to a more precise search (scanning a smaller fraction of the index and fewer heap pages), at the cost of a larger index."* https://www.postgresql.org/docs/16/hstore.html

[^hstore-btree]: PostgreSQL 16 docs, "F.18.3. Indexes" — *"`hstore` also supports `btree` or `hash` indexes for the `=` operator. This allows `hstore` columns to be declared `UNIQUE`, or to be used in `GROUP BY`, `ORDER BY` or `DISTINCT` expressions. The sort ordering for `hstore` values is not particularly useful, but these indexes may be useful for equivalence lookups."* https://www.postgresql.org/docs/16/hstore.html

[^pg14-sub]: PostgreSQL 14 release notes, "E.23.3.13. Additional Modules" — *"Allow subscripting of hstore values (Tom Lane, Dmitry Dolgov)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-remove-ops]: PostgreSQL 14 release notes, "E.23.2. Migration to Version 14" — *"Remove deprecated containment operators `@` and `~` for built-in geometric data types and contrib modules cube, hstore, intarray, and seg (Justin Pryzby). The more consistently named `<@` and `@>` have been recommended for many years."* https://www.postgresql.org/docs/release/14.0/

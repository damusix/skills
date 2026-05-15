# JSON and JSONB

PostgreSQL ships two JSON types — `json` and `jsonb` — that look interchangeable but differ in storage, indexability, comparison semantics, and operator catalog. This file is the canonical reference for both: when to pick one over the other, the full operator + function surface, the SQL/JSON path language, the `JSON_TABLE` / `JSON_QUERY` / `JSON_VALUE` / `JSON_EXISTS` constructors added in PG17, GIN indexing trade-offs (`jsonb_ops` vs `jsonb_path_ops`), and the gotchas that produce silent data corruption or 10× slowdowns.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix: JSONB vs Array vs Composite vs hstore vs Child Table](#decision-matrix-jsonb-vs-array-vs-composite-vs-hstore-vs-child-table)
- [Syntax / Mechanics](#syntax--mechanics)
  - [Type Comparison: `json` vs `jsonb`](#type-comparison-json-vs-jsonb)
  - [Literals, Casting, and JSON Primitives](#literals-casting-and-json-primitives)
  - [Extraction Operators: `->`, `->>`, `#>`, `#>>`](#extraction-operators-------)
  - [Containment and Existence: `@>`, `<@`, `?`, `?|`, `?&`](#containment-and-existence---------)
  - [Concatenation and Deletion: `||`, `-`, `#-`](#concatenation-and-deletion-----)
  - [JSONB Subscripting (PG14+)](#jsonb-subscripting-pg14)
  - [Modification Functions](#modification-functions)
  - [SQL/JSON Path Language](#sqljson-path-language)
  - [jsonpath Query Functions and Operators](#jsonpath-query-functions-and-operators)
  - [SQL/JSON Constructors (PG16+)](#sqljson-constructors-pg16)
  - [SQL/JSON Query Functions (PG17+)](#sqljson-query-functions-pg17)
  - [`JSON_TABLE` (PG17+)](#json_table-pg17)
  - [`IS JSON` Predicate (PG16+)](#is-json-predicate-pg16)
  - [GIN Indexing: `jsonb_ops` vs `jsonb_path_ops`](#gin-indexing-jsonb_ops-vs-jsonb_path_ops)
  - [Functional GIN on Derived JSON](#functional-gin-on-derived-json)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when:

- Designing a schema and weighing `jsonb` against a normalized child table, a composite type, or `hstore`.
- Writing queries that extract or filter on JSON fields, especially with the `->`/`->>`/`#>`/`#>>`/`@>`/`?` operator zoo.
- Modifying JSON values in place with `jsonb_set` / `jsonb_insert` / `||` / `-` / subscripting.
- Writing SQL/JSON path expressions (`$.foo[*] ? (@.x > 10)`) or using `jsonb_path_query` / `jsonb_path_exists` / `JSON_QUERY` / `JSON_TABLE`.
- Picking between `jsonb_ops` and `jsonb_path_ops` for a GIN index, or sizing the index for containment queries.
- Diagnosing slow queries that scan a `jsonb` column, or `@>` filters that don't use the GIN index.

For arrays of homogeneous scalars (tags, IDs), see [`16-arrays.md`](./16-arrays.md). For trigram-substring search inside JSON-extracted text, see [`93-pg-trgm.md`](./93-pg-trgm.md). For full-text search inside JSON, see [`20-text-search.md`](./20-text-search.md).

## Mental Model

Five rules drive every decision in this file:

1. **`jsonb` is the default.** Use `json` only when you must round-trip the input text byte-perfect — preserving whitespace, key order, and duplicate keys. The docs say so directly: *"In general, most applications should prefer to store JSON data as `jsonb`, unless there are quite specialized needs, such as legacy assumptions about ordering of object keys."*[^json-vs-jsonb]
2. **`jsonb` is normalized at input.** Whitespace is dropped, key order is not preserved, duplicate keys are collapsed (last write wins), and numbers are reparsed as `numeric` (which preserves trailing zeros: `1.230e-5` round-trips as `0.00001230`).[^jsonb-normalization]
3. **`->` returns JSON; `->>` returns text.** Use `->>` whenever you want to compare to a SQL value (`WHERE doc->>'email' = $1`). Use `->` only when you need to chain another JSON operator (`doc->'profile'->>'email'`).
4. **Containment (`@>`) is the GIN-indexable workhorse, but it is type-strict and does not unwrap arrays.** `'{"a": 1}' @> '{"a": 1}'` is true; `'{"a": 1}' @> '{"a": "1"}'` is false. The right side must be a valid JSON document, not a bare scalar.
5. **Schemaless drift is the primary long-term failure mode.** A `jsonb` column is a temptation to skip schema design. Three years later you have `email` / `Email` / `email_address` / `user_email` and twenty queries that each guess differently. Push values that the application reads with `WHERE` into real columns or generated columns.

## Decision Matrix: JSONB vs Array vs Composite vs hstore vs Child Table

| You need... | Use | Avoid | Why |
|---|---|---|---|
| Nested, heterogeneous structure (objects, arrays, mixed scalars) | `jsonb` | Composite | Composite has a fixed shape; JSONB lets the shape evolve per row |
| A list of N homogeneous scalars (tag IDs, allowed roles) | `text[]` / `int[]` | `jsonb` | Arrays index more cheaply and have richer operators (see [`16-arrays.md`](./16-arrays.md)) |
| A fixed record with named fields you query individually | columns + indexes | `jsonb` | Real columns get per-column stats and dedicated indexes |
| Flat key/value map of text→text only | `hstore` | `jsonb` for this only | `hstore` is smaller and faster for the flat-string-only case (see [`21-hstore.md`](./21-hstore.md)) |
| One-to-many child rows you want to JOIN, FK-reference, or update individually | child table | `jsonb` array | Arrays-of-objects look convenient but force you to rewrite the whole document on every change |
| Optional fields that vary per row, rarely filtered | `jsonb` | sparse columns | Per-row optional shape is exactly what JSONB is for |
| Byte-perfect round-trip of the input (whitespace, duplicates, key order) | `json` | `jsonb` | Only `json` preserves all of these |
| Document with predicates pushed into `WHERE` and indexed | `jsonb` + GIN | `text` + regex | GIN-on-JSONB is the whole reason to pick this type |
| Audit-log payload, webhook capture, third-party API response | `jsonb` | structured columns | The shape is dictated by the source; storing it as-is and projecting later is correct |

Three smell signals that you reached for `jsonb` when a child table was the right answer:

- You write `WHERE doc->>'status' = 'active'` on millions of rows and the GIN index can't help (`->>` produces `text`, not `jsonb`).
- You want a foreign key from a field inside the JSON to another table. JSON fields can't be FK targets.
- You always `jsonb_array_elements(doc->'items')` in every query that touches the document.

## Syntax / Mechanics

### Type Comparison: `json` vs `jsonb`

| Property | `json` | `jsonb` |
|---|---|---|
| Storage | Exact text copy | Decomposed binary[^json-vs-jsonb] |
| Insert speed | Faster (no normalization) | Slightly slower (binary conversion) |
| Read speed | Slower (must reparse on every access) | Much faster (no reparsing)[^json-vs-jsonb] |
| Whitespace | Preserved | Dropped[^jsonb-normalization] |
| Duplicate keys | Kept (last operative) | Collapsed, last wins[^jsonb-normalization] |
| Key order | Preserved | Not preserved |
| Indexable with GIN | No | Yes (`jsonb_ops`, `jsonb_path_ops`) |
| Containment (`@>`/`<@`) | Not supported | Supported |
| Key existence (`?`/`?|`/`?&`) | Not supported | Supported |
| `=` comparison | Not supported | Supported (semantic, not byte-wise) |
| Subscripting (`x['key']`) | No | Yes, PG14+[^pg14-subscript] |
| Number representation | Original text | `numeric` (trailing zeros preserved) |

> [!NOTE] PostgreSQL 14
> JSONB subscripting landed in PG14: *"Allow subscripting of `JSONB` (Dmitry Dolgov). `JSONB` subscripting can be used to extract and assign to portions of `JSONB` documents."*[^pg14-subscript]

> [!NOTE] PostgreSQL 15
> JSON numeric literal processing was adjusted to match the SQL/JSON standard: *"This accepts numeric formats like `.1` and `1.`, and disallows trailing junk after numeric literals, like `1.type()`."*[^pg15-numeric]

> [!NOTE] PostgreSQL 18
> *"Allow `jsonb` `null` values to be cast to scalar types as `NULL` (Tom Lane). Previously such casts generated an error."*[^pg18-null-cast] Also: *"Improve the performance of processing long `JSON` strings using SIMD."*[^pg18-simd] And `jsonb_strip_nulls` gained an optional parameter for stripping null array elements.[^pg18-strip-nulls]

### Literals, Casting, and JSON Primitives

JSON primitive types map to PG types as follows:[^json-primitives]

| JSON primitive | PG type | Restrictions |
|---|---|---|
| `string` | `text` | ` ` is disallowed; Unicode escapes for characters not in the DB encoding are disallowed |
| `number` | `numeric` | `NaN` and `infinity` are disallowed |
| `boolean` | `boolean` | Only lowercase `true` and `false` are accepted |
| `null` | (none) | JSON null is distinct from SQL `NULL` |

Casting from text uses the standard `::jsonb` form. The cast is the place input validation happens:

    -- Literal in SQL
    SELECT '{"name": "alice", "tags": ["a","b"]}'::jsonb;

    -- From a text column
    SELECT raw::jsonb FROM webhook_events WHERE id = $1;

    -- Reject invalid input early at write time
    ALTER TABLE webhook_events
      ADD COLUMN payload jsonb GENERATED ALWAYS AS (raw::jsonb) STORED;

`jsonb` will reject numbers outside the range of `numeric`; `json` will not. Trailing zeros are preserved in `jsonb`: `'{"x": 1.230e-5}'::jsonb` prints as `{"x": 0.00001230}` and `'{"x": 1.0}'::jsonb = '{"x": 1}'::jsonb` is **false**.[^jsonb-numbers]

### Extraction Operators: `->`, `->>`, `#>`, `#>>`

Four operators, two dimensions: returns-JSON vs returns-text, and single-step vs path.[^extraction]

| Operator | LHS | RHS | Returns | Example | Result |
|---|---|---|---|---|---|
| `->` | `jsonb` | `text` | `jsonb` | `'{"a":{"b":1}}' -> 'a'` | `{"b":1}` |
| `->` | `jsonb` | `integer` | `jsonb` | `'[10,20,30]' -> 1` | `20` |
| `->>` | `jsonb` | `text` | `text` | `'{"a":"foo"}' ->> 'a'` | `foo` |
| `->>` | `jsonb` | `integer` | `text` | `'[10,20,30]' ->> 1` | `20` |
| `#>` | `jsonb` | `text[]` | `jsonb` | `'{"a":{"b":[1,2]}}' #> '{a,b,1}'` | `2` |
| `#>>` | `jsonb` | `text[]` | `text` | `'{"a":{"b":[1,2]}}' #>> '{a,b,1}'` | `2` |

Array elements are 0-indexed (unlike SQL arrays, which are 1-indexed). Negative indices count from the end.

The single most important rule: *"The field/element/path extraction operators return NULL, rather than failing, if the JSON input does not have the right structure to match the request; for example if no such key or array element exists."*[^extraction-null] That makes `WHERE doc->>'nonexistent' = 'x'` filter out non-matching rows silently rather than erroring — useful but easy to confuse with "the field exists and is null."

> [!WARNING] `->` chained vs `#>` path
> `doc -> 'a' -> 'b' -> 'c'` and `doc #> '{a,b,c}'` produce the same result, but the path form is one operator call instead of three. For deep extractions, prefer `#>` / `#>>`.

### Containment and Existence: `@>`, `<@`, `?`, `?|`, `?&`

All are `jsonb`-only (no `json` variants). All are GIN-indexable under `jsonb_ops`. Only `@>` is indexable under `jsonb_path_ops` (along with `@?` and `@@`).

| Operator | Meaning | Example | Result |
|---|---|---|---|
| `@>` | LHS contains RHS | `'{"a":1,"b":2}' @> '{"b":2}'` | `t` |
| `<@` | LHS is contained in RHS | `'{"b":2}' <@ '{"a":1,"b":2}'` | `t` |
| `?` | Top-level key (or array element) exists | `'{"a":1}' ? 'a'` | `t` |
| `?|` | Any of the given keys exists | `'{"a":1}' ?| array['a','b']` | `t` |
| `?&` | All of the given keys exist | `'{"a":1,"b":2}' ?& array['a','b']` | `t` |

**Containment is type-strict, key-only-at-its-depth, and array-as-subset:**

- `'{"a": 1}' @> '{"a": 1}'` → `t`
- `'{"a": 1}' @> '{"a": "1"}'` → `f` (type mismatch)
- `'{"a": {"b": 1}}' @> '{"b": 1}'` → `f` (`b` is not at the top level)
- `'{"a": {"b": 1}}' @> '{"a": {"b": 1}}'` → `t` (full nested path must match)
- `'[1,2,3]' @> '[2]'` → `t` (array contains element)
- `'[1,2,3]' @> '[2,1]'` → `t` (order does not matter; arrays are treated as multisets for containment)
- `'[{"a":1},{"b":2}]' @> '[{"a":1}]'` → `t`

The `?` family checks **top-level** keys only. `'{"a": {"b": 1}}' ? 'b'` is `f` because `b` is one level down. Use `@?` / `@@` with a `jsonpath` expression for deep existence checks.

### Concatenation and Deletion: `||`, `-`, `#-`

| Operator | Meaning | Example | Result |
|---|---|---|---|
| `\|\|` | Merge / concat | `'{"a":1}' \|\| '{"b":2}'` | `{"a":1,"b":2}` |
| `-` (`text`) | Delete key from object, or text element from array | `'{"a":1,"b":2}' - 'a'` | `{"b":2}` |
| `-` (`text[]`) | Delete multiple keys / elements | `'{"a":1,"b":2,"c":3}' - '{a,c}'::text[]` | `{"b":2}` |
| `-` (`integer`) | Delete array element by index | `'["a","b","c"]' - 1` | `["a","c"]` |
| `#-` | Delete at path | `'{"a":{"b":1,"c":2}}' #- '{a,b}'` | `{"a":{"c":2}}` |

The `||` rule is *"Does not operate recursively: only the top-level array or object structure is merged."*[^concat] So:

- `'{"a":{"x":1}}' || '{"a":{"y":2}}'` produces `{"a":{"y":2}}`, **not** `{"a":{"x":1,"y":2}}`. Last-key-wins at the top level only; the inner object is replaced wholesale.
- For deep merge you write a recursive PL/pgSQL function or use `jsonb_set` per path.

When concatenating two objects, the **second** object's value wins for duplicate keys: `'{"a":1}' || '{"a":2}'` → `{"a":2}`.

### JSONB Subscripting (PG14+)

PG14 added generic subscripting, and `jsonb` is one of the types that opted in.[^pg14-subscript] It reads and writes; assignment creates missing intermediate keys.

    -- Read (equivalent to ->)
    SELECT doc['profile']['email'] FROM users WHERE id = 1;

    -- Write (in UPDATE)
    UPDATE users SET doc['profile']['verified'] = 'true'::jsonb
    WHERE id = 1;

    -- Negative array index counts from end
    SELECT doc['items'][-1] FROM orders;

Subscripting returns `jsonb`, not `text`. To get text use `->>` or cast: `doc['email'] #>> '{}'`.

**Important asymmetry:** subscript assignment creates missing keys (acts like `jsonb_set(..., create_if_missing => true)`). Read returns NULL for missing keys (like `->`).

> [!NOTE] PostgreSQL 14
> Subscripting works only on `jsonb`. The `json` type does not support it.

### Modification Functions

| Function | Purpose | Default |
|---|---|---|
| `jsonb_set(target, path, value, create_if_missing)` | Replace or insert at path | `create_if_missing = true`[^jsonb-set] |
| `jsonb_insert(target, path, value, insert_after)` | Insert into array or object | `insert_after = false` (before) |
| `jsonb_set_lax(target, path, value, create_if_missing, null_value_treatment)` | Like `jsonb_set` but NULL-handling configurable | `null_value_treatment = 'use_json_null'`[^jsonb-set-lax] |
| `jsonb_strip_nulls(jsonb [, strip_in_arrays])` | Remove null-valued fields (and PG18+ null array elements) | PG18+ optional parameter[^pg18-strip-nulls] |
| `jsonb_concat` (op `\|\|`) | See above | n/a |

**`jsonb_set` rules:**

- *"All earlier steps in the path must exist, or the target is returned unchanged."* So `jsonb_set('{"a":1}', '{b,c}', '2')` returns `{"a":1}` unmodified — `b` does not exist, so neither does its child `c`.
- Negative array indices count from the end.
- *"If the last path step is an array index that is out of range, and `create_if_missing` is true, the new value is added at the beginning of the array if the index is negative, or at the end of the array if it is positive."*[^jsonb-set]

**`jsonb_set_lax` is for the "what if the value is NULL?" case:**

- `'raise_exception'` — error
- `'use_json_null'` — store JSON null (default; same as `jsonb_set`)
- `'delete_key'` — remove the key entirely
- `'return_target'` — leave the document unchanged

Use `delete_key` to translate SQL NULLs into "remove the field" instead of "store JSON null."

### SQL/JSON Path Language

The `jsonpath` type stores a parsed SQL/JSON path expression. Use it as a filter language when `@>` is too rigid.

Path syntax:

- `$` — the current document (the root)
- `@` — the current item inside a filter
- `.field` — object field access
- `[*]` — every array element
- `[N]` — array index (0-based)
- `[N to M]` — array slice
- `?( predicate )` — filter
- `.method()` — type / size / format methods

Two modes, set by a leading keyword:

- **`lax`** (default) — *"The path engine implicitly adapts the queried data to the specified path. Any remaining structural errors are suppressed and converted to empty SQL/JSON sequences."* Automatic array unwrapping happens automatically.
- **`strict`** — *"If a structural error occurs, an error is raised."*

Comparison and predicate operators inside a filter:

| Op | Meaning |
|---|---|
| `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=` | Scalar comparison |
| `&&`, `\|\|`, `!` | Boolean AND / OR / NOT |
| `like_regex "pat" flag "imsq"` | POSIX-ish regex |
| `starts with "prefix"` | Prefix match |
| `exists(path)` | Path matches at least one item |
| `is unknown` | Tests whether result is `unknown` |

Useful methods:

- `.type()` — `"string"` / `"number"` / `"boolean"` / `"null"` / `"object"` / `"array"`
- `.size()` — array length (1 for non-array)
- `.double()`, `.ceiling()`, `.floor()`, `.abs()`
- `.datetime()` / `.datetime(template)` — parse ISO datetime; on success returns date/time/timetz/timestamp/timestamptz
- `.keyvalue()` — explode an object as `{"key":..., "value":..., "id":...}` records

> [!NOTE] PostgreSQL 16
> *"Add support for enhanced numeric literals in SQL/JSON paths (Peter Eisentraut). For example, allow hexadecimal, octal, and binary integers and underscores between digits."*[^pg16-numeric-paths]

> [!NOTE] PostgreSQL 17
> *"The jsonpath methods are `.bigint()`, `.boolean()`, `.date()`, `.decimal([precision [, scale]])`, `.integer()`, `.number()`, `.string()`, `.time()`, `.time_tz()`, `.timestamp()`, and `.timestamp_tz()`."*[^pg17-jsonpath-methods] These return a properly typed value rather than the prior `.double()`-only converter.

### jsonpath Query Functions and Operators

| Function/Op | Returns | Notes |
|---|---|---|
| `jsonb @? jsonpath` | `boolean` | Path returns at least one item |
| `jsonb @@ jsonpath` | `boolean` | Path predicate evaluates to true (only first result counted) |
| `jsonb_path_exists(target, path [, vars [, silent]])` | `boolean` | Function form of `@?` |
| `jsonb_path_match(target, path [, vars [, silent]])` | `boolean` | Function form of `@@` |
| `jsonb_path_query(target, path [, vars [, silent]])` | `setof jsonb` | All matching items, one per row |
| `jsonb_path_query_array(target, path [, vars [, silent]])` | `jsonb` | All matching items packed into a JSON array |
| `jsonb_path_query_first(target, path [, vars [, silent]])` | `jsonb` | First matching item or NULL |

The `vars` argument binds named parameters (`$min`, `$max`) used inside the path expression. The `silent` flag suppresses *"missing object field or array element, unexpected JSON item type, datetime and numeric errors"*[^jsonpath-silent] — the same errors `@?` and `@@` suppress by default.

    SELECT jsonb_path_query(
      '{"users":[{"age":21},{"age":35}]}'::jsonb,
      '$.users[*] ? (@.age > $min)',
      jsonb_build_object('min', 30)
    );
    -- {"age": 35}

### SQL/JSON Constructors (PG16+)

PG16 added the SQL standard `JSON_*` constructors as first-class functions.[^pg16-constructors]

| Constructor | Purpose |
|---|---|
| `JSON_ARRAY(v1, v2, ...)` | Build a JSON array from values |
| `JSON_ARRAY(query)` | Build from a subquery |
| `JSON_OBJECT('k1' VALUE v1, 'k2' VALUE v2, ...)` | Build a JSON object |
| `JSON_ARRAYAGG(expr)` | Aggregate (see [`12-aggregates-grouping.md`](./12-aggregates-grouping.md)) |
| `JSON_OBJECTAGG(k VALUE v)` | Aggregate |

> [!NOTE] PostgreSQL 16
> *"The new functions `JSON_ARRAY()`, `JSON_ARRAYAGG()`, `JSON_OBJECT()`, and `JSON_OBJECTAGG()` are part of the SQL standard."*[^pg16-constructors] Older code uses the PG-specific `jsonb_build_array`, `jsonb_build_object`, `jsonb_agg`, `jsonb_object_agg` — those still work and are functionally equivalent.

> [!NOTE] PostgreSQL 17
> Added the lower-level `JSON()`, `JSON_SCALAR()`, `JSON_SERIALIZE()` constructors.[^pg17-constructors]

### SQL/JSON Query Functions (PG17+)

PG17 added three SQL-standard query functions on top of jsonpath.[^pg17-query-funcs]

| Function | Returns | Use when |
|---|---|---|
| `JSON_EXISTS(doc, path [PASSING ...] [ON ERROR ...])` | `boolean` | Predicate-style existence check |
| `JSON_VALUE(doc, path [RETURNING type] [DEFAULT v ON EMPTY \| ERROR])` | scalar of the chosen type | Extract one scalar with type coercion and default |
| `JSON_QUERY(doc, path [RETURNING type] [WRAPPER ...] [QUOTES ...] [DEFAULT ...])` | `jsonb` (or chosen type) | Extract sub-document, with array-wrapping options |

`JSON_VALUE` is the typed alternative to `->>` plus a cast:

    -- Pre-PG17: implicit conversion plus default
    SELECT COALESCE((doc->>'age')::int, 0) FROM users;

    -- PG17+
    SELECT JSON_VALUE(doc, '$.age' RETURNING int DEFAULT 0 ON EMPTY) FROM users;

`JSON_QUERY` handles "one or many" array-wrapping with the `WITH WRAPPER` / `WITH CONDITIONAL WRAPPER` / `WITHOUT WRAPPER` modifiers:

    JSON_QUERY(jsonb '[1,[2,3],null]', 'lax $[*][$off]'
      PASSING 1 AS off WITH CONDITIONAL WRAPPER) -- 3

`JSON_EXISTS` is the predicate form of `@?`:

    JSON_EXISTS(jsonb '{"key1": [1,2,3]}',
                'strict $.key1[*] ? (@ > $x)' PASSING 2 AS x) -- t

The `ON EMPTY` / `ON ERROR` clauses are the killer feature: they let you choose `NULL` (default), `ERROR`, `DEFAULT expr`, or — for `JSON_QUERY` — `EMPTY ARRAY` / `EMPTY OBJECT`. This replaces ad-hoc `COALESCE(..., '{}'::jsonb)` patterns.

### `JSON_TABLE` (PG17+)

`JSON_TABLE` projects a JSON document into a relational table, suitable for use in the `FROM` clause as a tuple source (see [`02-syntax-dql.md`](./02-syntax-dql.md) for FROM-clause rules).[^pg17-json-table] It internally desugars to `JSON_VALUE` / `JSON_QUERY` / `JSON_EXISTS` per column.

Grammar:

    JSON_TABLE (
        context_item, path_expression [ AS json_path_name ]
        [ PASSING { value AS varname } [, ...] ]
        COLUMNS ( json_table_column [, ...] )
        [ { ERROR | EMPTY [ARRAY] } ON ERROR ]
    )

Column variants:

1. `name FOR ORDINALITY` — sequential row number starting at 1; each `NESTED PATH` gets its own counter.
2. `name type [FORMAT JSON [ENCODING UTF8]] [PATH path] [WRAPPER] [QUOTES] [DEFAULT ... ON EMPTY] [DEFAULT ... ON ERROR]` — value column; desugars to `JSON_VALUE` (or `JSON_QUERY` for non-scalar or with `FORMAT JSON` / `WRAPPER` / `QUOTES`).
3. `name type EXISTS [PATH path] [...ON ERROR]` — existence check; desugars to `JSON_EXISTS`.
4. `NESTED [PATH] path [AS name] COLUMNS ( ... )` — descend into a nested array; produces multiple rows joined to the parent.

If `PATH` is omitted, the default is `$.name` (the column name).

Worked example: a `my_films` table containing a `js` `jsonb` column whose payload is `{"favorites": [{"kind": "comedy", "films": [{"title": "Bananas", "director": "Woody Allen"}]}, ...]}`.

    SELECT jt.* FROM my_films,
      JSON_TABLE(js, '$.favorites[*]'
        COLUMNS (
          id FOR ORDINALITY,
          kind text PATH '$.kind',
          NESTED PATH '$.films[*]' COLUMNS (
            title text FORMAT JSON PATH '$.title' OMIT QUOTES,
            director text PATH '$.director' KEEP QUOTES
          )
        )
      ) AS jt;

Returns one row per nested film, each tagged with the parent `kind`. The pre-PG17 equivalent is a chain of `jsonb_array_elements` calls in lateral joins — `JSON_TABLE` collapses that into one operator that the planner can sometimes optimize.

> [!WARNING] Context-item parse errors are NOT routed through `ON ERROR`
> *"The `context_item` expression is converted to `jsonb` by an implicit cast if the expression is not already of type `jsonb`. Note, however, that any parsing errors that occur during that conversion are thrown unconditionally, that is, are not handled according to the (specified or implicit) `ON ERROR` clause."*[^json-table-cast] A malformed source string raises even with `EMPTY ON ERROR`. Validate at write time with `IS JSON`.

### `IS JSON` Predicate (PG16+)

PG16 added the SQL-standard `IS JSON` predicate.[^pg16-is-json] It is a parse-only check, not a schema validator.

    -- Coarse check
    SELECT value IS JSON                FROM events;  -- valid JSON at all?
    SELECT value IS JSON OBJECT         FROM events;  -- specifically an object
    SELECT value IS JSON ARRAY          FROM events;  -- specifically an array
    SELECT value IS JSON SCALAR         FROM events;  -- string/number/bool/null
    SELECT value IS JSON WITH UNIQUE KEYS FROM events;  -- catches duplicate keys

Use this at write time in a CHECK constraint:

    ALTER TABLE events
      ADD CONSTRAINT payload_is_object_json
      CHECK (payload IS JSON OBJECT);

### GIN Indexing: `jsonb_ops` vs `jsonb_path_ops`

Two GIN operator classes ship for `jsonb`:[^gin-jsonb]

| | `jsonb_ops` (default) | `jsonb_path_ops` |
|---|---|---|
| Default? | Yes | No |
| Supports `@>` | Yes | Yes |
| Supports `@?` (jsonpath) | Yes | Yes |
| Supports `@@` (jsonpath) | Yes | Yes |
| Supports `?` (key exists) | Yes | **No** |
| Supports `?|` (any-key) | Yes | **No** |
| Supports `?&` (all-keys) | Yes | **No** |
| Index size | Larger | *"Usually much smaller"*[^jsonb-path-ops] |
| Selectivity for hot keys | Lower | Higher |
| Empty object trap | None | *"Produces no index entries for JSON structures not containing any values, such as `{"a": {}}`"*[^jsonb-path-ops] |

The technical difference: *"`jsonb_ops` creates independent index items for each key and value in the data, while `jsonb_path_ops` creates index items only for each value in the data."*[^jsonb-path-ops]

**Pick `jsonb_ops` if:**

- You rely on `?` / `?|` / `?&` key-existence operators.
- You want the index to also help with key probes, not just containment.
- Your documents are shallow with many distinct keys.

**Pick `jsonb_path_ops` if:**

- Containment (`@>`) and jsonpath (`@?` / `@@`) are the only operators you index for.
- Your documents are large; index size matters.
- A small number of keys appear in nearly every row (`{"type": "X", ...}`) — `jsonb_path_ops` is better at narrowing through that hot key.

> [!NOTE] PostgreSQL 18
> *"Allow parallel builds of GIN indexes"*[^pg18-gin-parallel] — both `jsonb_ops` and `jsonb_path_ops` benefit. Builds on multi-million-row tables drop substantially.

Create either with explicit opclass:

    CREATE INDEX users_doc_gin ON users USING GIN (doc);                   -- jsonb_ops (default)
    CREATE INDEX users_doc_pgin ON users USING GIN (doc jsonb_path_ops);   -- explicit
    CREATE INDEX CONCURRENTLY users_doc_gin ON users USING GIN (doc);     -- non-blocking

Use [`CREATE INDEX CONCURRENTLY`](./26-index-maintenance.md) on live tables.

### Functional GIN on Derived JSON

When you almost always filter on a sub-path (`doc->'profile'`), index that sub-path directly. The index is smaller and the planner picks it up automatically for matching expressions.

    -- Frequent query
    SELECT * FROM users WHERE doc->'profile' @> '{"verified": true}';

    -- Functional GIN: index only the profile sub-object
    CREATE INDEX users_profile_gin
      ON users USING GIN ((doc->'profile') jsonb_path_ops);

Similarly, for repeated single-field lookups on a stable scalar field, a B-tree on the extracted text often beats a GIN-on-the-whole-document:

    CREATE INDEX users_email_btree ON users ((doc->>'email'));

    SELECT * FROM users WHERE doc->>'email' = 'alice@example.com';

The trade-off: each functional index targets one access pattern. A single `jsonb_ops` GIN supports any `@>` filter on the document; a stack of functional indexes covers fewer patterns but answers each one faster.

## Examples / Recipes

### 1. Baseline schema: webhook payload with GIN and IS JSON check

    CREATE TABLE webhook_events (
        id          bigserial PRIMARY KEY,
        received_at timestamptz NOT NULL DEFAULT now(),
        provider    text NOT NULL,
        event_type  text GENERATED ALWAYS AS (payload->>'type') STORED,
        payload     jsonb NOT NULL,
        CHECK (payload IS JSON OBJECT)
    );
    CREATE INDEX webhook_payload_gin ON webhook_events USING GIN (payload);
    CREATE INDEX webhook_type_btree ON webhook_events (event_type);

Why this shape: `event_type` is hoisted into a generated column with a B-tree because every query filters by it; the GIN-on-jsonb is the fallback for ad-hoc containment queries; the `IS JSON OBJECT` CHECK refuses malformed inputs at write time.

### 2. Containment query with GIN

    -- Find events where actor.country = 'US' and status = 'active'
    SELECT id, received_at
      FROM webhook_events
     WHERE payload @> '{"actor": {"country": "US"}, "status": "active"}';

The planner uses `webhook_payload_gin` for this. `EXPLAIN ANALYZE` shows `Bitmap Heap Scan on webhook_events` driven by `Bitmap Index Scan on webhook_payload_gin`.

### 3. `->>` cast + B-tree for hot scalar field

    -- BAD: GIN on the document does NOT help equality on an extracted scalar
    SELECT * FROM users WHERE doc->>'email' = 'alice@example.com';

    -- GOOD: functional B-tree on the extracted field
    CREATE INDEX users_email ON users ((doc->>'email'));

### 4. `jsonb_set` to update a single field without rewriting the whole document — mostly a myth

`jsonb_set` is a function: it builds a new `jsonb` value and the UPDATE writes a new tuple regardless (see MVCC, [`27-mvcc-internals.md`](./27-mvcc-internals.md)). There is no in-place mutation.

    UPDATE users
       SET doc = jsonb_set(doc, '{profile,verified}', 'true'::jsonb)
     WHERE id = $1;

    -- Equivalent with PG14+ subscripting, and clearer:
    UPDATE users SET doc['profile']['verified'] = 'true'::jsonb WHERE id = $1;

### 5. Delete a key idempotently

    -- Remove tracking field on opt-out
    UPDATE users
       SET doc = doc #- '{tracking,consent}'
     WHERE id = $1;

`#-` is a no-op if the path doesn't exist; safe to run repeatedly.

### 6. Append to a JSON array safely

    -- Append a tag, deduplicating
    UPDATE users
       SET doc = jsonb_set(
             doc,
             '{tags}',
             (
               SELECT jsonb_agg(DISTINCT t)
                 FROM jsonb_array_elements_text(coalesce(doc->'tags','[]'::jsonb)) AS t
                UNION
               SELECT to_jsonb($2::text)
             )
           )
     WHERE id = $1;

For order-preserving append-on-conflict, use a normalized `text[]` column instead — JSONB arrays don't have an "insert without duplicates" operator.

### 7. Deep merge two JSON objects recursively

JSONB `||` is shallow. For deep merge define an SQL function:

    CREATE OR REPLACE FUNCTION jsonb_deep_merge(a jsonb, b jsonb)
    RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT
        CASE
          WHEN jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
            (SELECT jsonb_object_agg(
                      k,
                      CASE
                        WHEN a ? k AND jsonb_typeof(a->k) = 'object'
                             AND jsonb_typeof(b->k) = 'object'
                        THEN jsonb_deep_merge(a->k, b->k)
                        ELSE coalesce(b->k, a->k)
                      END
                    )
               FROM (SELECT jsonb_object_keys(a) AS k
                      UNION
                     SELECT jsonb_object_keys(b)) keys)
          ELSE coalesce(b, a)
        END
    $$;

This is the canonical "deep merge" function for PG.

### 8. Filter rows whose JSON path matches a complex predicate

    -- All users with at least one active session in the last 24 hours
    SELECT id
      FROM users
     WHERE doc @? '$.sessions[*] ? (@.active == true && @.ended_at == null)';

Indexable under both `jsonb_ops` and `jsonb_path_ops` GIN.

### 9. Project nested JSON to rows with `JSON_TABLE` (PG17+)

    -- Each user has many addresses inside doc->'addresses'
    SELECT u.id, a.kind, a.city, a.postcode
      FROM users u,
           JSON_TABLE(u.doc, '$.addresses[*]' COLUMNS (
             kind     text PATH '$.kind',
             city     text PATH '$.city',
             postcode text PATH '$.postcode'
           )) AS a
     WHERE u.id = $1;

Pre-PG17 equivalent:

    SELECT u.id,
           a->>'kind' AS kind,
           a->>'city' AS city,
           a->>'postcode' AS postcode
      FROM users u,
           jsonb_array_elements(u.doc->'addresses') AS a
     WHERE u.id = $1;

The PG17 form is one operator the planner can optimize; the pre-PG17 form is several.

### 10. `JSON_VALUE` with typed default (PG17+)

    -- Pre-PG17 (clumsy):
    SELECT COALESCE(NULLIF(doc->>'priority', '')::int, 0) FROM tasks;

    -- PG17+:
    SELECT JSON_VALUE(doc, '$.priority' RETURNING int DEFAULT 0 ON EMPTY)
      FROM tasks;

### 11. Generated column for hot field + B-tree (works in any PG14+ version)

    ALTER TABLE orders
      ADD COLUMN customer_id bigint
        GENERATED ALWAYS AS ((doc->>'customer_id')::bigint) STORED;
    CREATE INDEX orders_customer_id ON orders (customer_id);

This is the canonical "promote a hot JSON field to a real column without changing the writer" pattern. The column is read-only at the SQL level (PG18 also supports virtual generated columns; see [`01-syntax-ddl.md`](./01-syntax-ddl.md)).

### 12. Audit query: every JSONB column and its index coverage

    SELECT n.nspname  AS schema,
           c.relname  AS table_name,
           a.attname  AS column_name,
           pg_size_pretty(pg_table_size(c.oid)) AS table_size,
           (SELECT count(*)
              FROM pg_index i
              JOIN pg_class ic ON ic.oid = i.indexrelid
             WHERE i.indrelid = c.oid
               AND a.attnum = ANY (i.indkey)) AS index_count
      FROM pg_attribute a
      JOIN pg_class c     ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t      ON t.oid = a.atttypid
     WHERE c.relkind IN ('r', 'p')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND t.typname IN ('json', 'jsonb')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY pg_table_size(c.oid) DESC;

Routes through `pg_attribute` / `pg_type` and shows you which JSON-bearing tables are missing indexes. See [`64-system-catalogs.md`](./64-system-catalogs.md) for the deeper catalog walk.

### 13. Bulk normalize duplicate keys and whitespace by re-casting `json` to `jsonb`

If you have a legacy `json` column and want to switch to `jsonb` semantics (dedup keys, drop whitespace):

    BEGIN;
    ALTER TABLE legacy ADD COLUMN doc_new jsonb;
    UPDATE legacy SET doc_new = doc::jsonb;
    ALTER TABLE legacy DROP COLUMN doc;
    ALTER TABLE legacy RENAME COLUMN doc_new TO doc;
    COMMIT;
    -- VACUUM ANALYZE legacy;
    -- CREATE INDEX CONCURRENTLY legacy_doc_gin ON legacy USING GIN (doc);

The `::jsonb` cast is the normalization step. Run it on a copy first if you depend on duplicate-key behavior.

### 14. Catch malformed payloads at write time

    -- BEFORE PG16: function-based check
    ALTER TABLE webhook_events
      ADD CONSTRAINT payload_valid
      CHECK (payload IS NOT NULL);

    -- PG16+ with IS JSON predicate
    ALTER TABLE webhook_events
      ADD CONSTRAINT payload_valid_object
      CHECK (payload IS JSON OBJECT WITH UNIQUE KEYS);

The `WITH UNIQUE KEYS` form catches input that `jsonb` would have silently collapsed.

## Gotchas / Anti-patterns

1. **`->` returns JSON; `->>` returns text.** `WHERE doc->'email' = 'alice@example.com'` is `false` for every row — the LHS is `jsonb` (quoted string) and the RHS is `text`. Use `->>` or `doc->'email' = '"alice@example.com"'::jsonb`.
2. **`@>` does not unwrap arrays at the top level the way you might guess.** `'{"tags":["a","b"]}' @> '{"tags":["a"]}'` is `t` (array sub-containment), but `'{"tags":["a","b"]}' @> '{"tags":"a"}'` is `f`. The RHS must mirror the LHS shape at the matched path.
3. **`@>` is type-strict.** `'{"a":1}' @> '{"a":"1"}'` is `f`. Numbers and strings are different JSON types even when they print identically.
4. **GIN on the document does NOT accelerate `->>` equality.** `WHERE doc->>'email' = 'x'` is not indexable by `jsonb_ops` or `jsonb_path_ops`. Use a functional B-tree on `(doc->>'email')`, or hoist to a generated column.
5. **`jsonb_set` returns `target` unchanged when an earlier path step is missing.** *"All earlier steps in the path must exist, or the target is returned unchanged."*[^jsonb-set] Combined with `create_if_missing => true`, this means `jsonb_set('{}', '{a,b}', '1')` returns `{}` — `a` is missing so its child `b` is too. Build intermediate objects first or use subscripting (which builds them for you).
6. **`jsonb_set` with a NULL `new_value` stores JSON null, not "remove the key."** Use `jsonb_set_lax(..., null_value_treatment => 'delete_key')` or `#-` to remove.
7. **`||` is shallow.** Merging two objects with overlapping keys replaces the inner object whole; it does not deep-merge. Write a recursive function (Recipe 7) for true deep merge.
8. **Schemaless drift.** A `jsonb` column collects `email`, `Email`, and `user_email` over time. Every consumer of the data has to know which is current. Push fields you query into real columns or generated columns; reserve `jsonb` for genuinely variable shapes.
9. **Duplicate keys silently disappear in `jsonb`.** `'{"a":1,"a":2}'::jsonb` is `{"a":2}`. If duplicate-key detection matters (audit, signature verification), keep the original `text` column too, or use `IS JSON WITH UNIQUE KEYS` to reject at write time.
10. **`json` numbers preserve their original text; `jsonb` numbers are normalized.** `'{"x":1.0}'::jsonb = '{"x":1}'::jsonb` is `f` because trailing zeros are preserved in `jsonb`. Equality is semantic in shape but byte-exact in numeric representation.
11. **`?` checks top-level keys only.** `'{"a":{"b":1}}' ? 'b'` is `f`. Use `@?` with a jsonpath for nested existence.
12. **`jsonb_path_ops` doesn't index empty-valued structures.** *"Produces no index entries for JSON structures not containing any values, such as `{"a": {}}`. If a search for documents containing such a structure is requested, it will require a full-index scan."*[^jsonb-path-ops] If you genuinely need to find documents with empty objects, use `jsonb_ops` instead.
13. **Mixing JSONB and JSON in the same column family is a foot-gun.** `'{"a":1}'::json @> '{"a":1}'::jsonb` won't even parse — `@>` is `jsonb`-only. Pick one type and stick to it.
14. **`jsonb_array_elements` versus `jsonb_array_elements_text` produce different types.** The first returns `setof jsonb` (quoted strings come through with their quotes); the second returns `setof text` (quotes stripped from scalar strings). If you forget which one you used, `WHERE x = 'foo'` may silently match no rows because `x` is `"foo"`.
15. **TOAST kicks in around 2KB of JSONB.** Large JSONB values are decompressed on every read of the field, including `->`/`->>` extraction. If you frequently extract a single field from a 50KB document, hoist it to a column. See [`31-toast.md`](./31-toast.md).
16. **`jsonb_path_query` returns `setof jsonb` — it produces rows.** A `SELECT jsonb_path_query(...) FROM t` produces zero rows for documents with no match (not one NULL row). Use `jsonb_path_query_first` or `JSON_VALUE` (PG17+) for scalar extraction with NULL on miss.
17. **PG16's `IS JSON` is a parse-only check, not a JSON-Schema validator.** It verifies the value is parseable JSON of the requested kind; it does not check that required fields are present or that scalar types match an expected shape. For that, use a CHECK with `JSON_VALUE` typed defaults or a trigger.
18. **`JSON_TABLE` context-item parse errors bypass `ON ERROR`.** If `doc::jsonb` fails the implicit cast, the row errors out regardless of `EMPTY ON ERROR` at the top level.[^json-table-cast]
19. **JSONB does not preserve insertion order of object keys.** *"`jsonb` does not preserve white space, does not preserve the order of object keys, and does not keep duplicate object keys."*[^jsonb-normalization] If a downstream consumer requires a stable key order (signature checks, deterministic hashing), serialize with `jsonb_object_agg(... ORDER BY ...)` or store the raw bytes in `text` / `bytea`.
20. **`->>` on a JSON null gives SQL NULL, not the string `"null"`.** `'{"a": null}'::jsonb ->> 'a'` is SQL NULL. So is `'{"a": null}'::jsonb ->> 'b'` (missing key). Use `IS NULL` plus `?` to distinguish "field present with null" from "field absent."

## See Also

- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — text/numeric/bytea built-in scalars
- [`15-data-types-custom.md`](./15-data-types-custom.md) — composite vs JSONB decision
- [`16-arrays.md`](./16-arrays.md) — text[] / int[] vs JSONB for homogeneous lists
- [`21-hstore.md`](./21-hstore.md) — flat key/value alternative
- [`22-indexes-overview.md`](./22-indexes-overview.md) — index decision matrix
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — deep dive on GIN internals, fastupdate, gin_pending_list_limit
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY`, REINDEX
- [`31-toast.md`](./31-toast.md) — TOAST and large-JSONB read cost
- [`12-aggregates-grouping.md`](./12-aggregates-grouping.md) — `JSON_ARRAYAGG` / `JSON_OBJECTAGG` (PG16+)
- [`56-explain.md`](./56-explain.md) — reading bitmap-index-scan plans on GIN-on-jsonb
- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — generated columns and IS JSON CHECK constraints
- [`64-system-catalogs.md`](./64-system-catalogs.md) — auditing JSON columns

## Sources

[^json-vs-jsonb]: PostgreSQL 16 documentation — JSON Types. *"`json` data is stored as an exact copy of the input text, which processing functions must reparse on each execution… `jsonb` data is stored in a decomposed binary format that makes it slightly slower to input due to added conversion overhead, but significantly faster to process, since no reparsing is needed."* And: *"In general, most applications should prefer to store JSON data as `jsonb`, unless there are quite specialized needs, such as legacy assumptions about ordering of object keys."* https://www.postgresql.org/docs/16/datatype-json.html

[^jsonb-normalization]: PostgreSQL 16 documentation — JSON Types. *"`jsonb` does not preserve white space, does not preserve the order of object keys, and does not keep duplicate object keys. If duplicate keys are specified in the input, only the last value is kept."* https://www.postgresql.org/docs/16/datatype-json.html

[^json-primitives]: PostgreSQL 16 documentation — Table 8.23. JSON Primitive Types and Corresponding PostgreSQL Types. https://www.postgresql.org/docs/16/datatype-json.html

[^jsonb-numbers]: PostgreSQL 16 documentation — JSON Types. *"`jsonb` will reject numbers that are outside the range of the PostgreSQL `numeric` data type, while `json` will not… `jsonb` will preserve trailing fractional zeroes, as seen in this example, even though those are semantically insignificant for purposes such as equality checks."* https://www.postgresql.org/docs/16/datatype-json.html

[^extraction]: PostgreSQL 16 documentation — Table 9.45. `jsonb` Operators (`->`, `->>`, `#>`, `#>>`). https://www.postgresql.org/docs/16/functions-json.html

[^extraction-null]: PostgreSQL 16 documentation — Notes on JSON operators. *"The field/element/path extraction operators return NULL, rather than failing, if the JSON input does not have the right structure to match the request; for example if no such key or array element exists."* https://www.postgresql.org/docs/16/functions-json.html

[^concat]: PostgreSQL 16 documentation — `jsonb || jsonb` definition. *"Concatenating two arrays generates an array containing all the elements of each input. Concatenating two objects generates an object containing the union of their keys, taking the second object's value when there are duplicate keys. All other cases are treated by converting a non-array input into a single-element array, and then proceeding as for two arrays. Does not operate recursively: only the top-level array or object structure is merged."* https://www.postgresql.org/docs/16/functions-json.html

[^jsonb-set]: PostgreSQL 16 documentation — `jsonb_set`. *"Returns `target` with the item designated by `path` replaced by `new_value`, or with `new_value` added if `create_if_missing` is true (which is the default) and the item designated by `path` does not exist. All earlier steps in the path must exist, or the `target` is returned unchanged."* https://www.postgresql.org/docs/16/functions-json.html

[^jsonb-set-lax]: PostgreSQL 16 documentation — `jsonb_set_lax`. *"Otherwise behaves according to the value of `null_value_treatment` which must be one of `'raise_exception'`, `'use_json_null'`, `'delete_key'`, or `'return_target'`. The default is `'use_json_null'`."* https://www.postgresql.org/docs/16/functions-json.html

[^jsonpath-silent]: PostgreSQL 16 documentation — jsonpath operators. *"The `jsonpath` operators `@?` and `@@` suppress the following errors: missing object field or array element, unexpected JSON item type, datetime and numeric errors."* https://www.postgresql.org/docs/16/functions-json.html

[^gin-jsonb]: PostgreSQL 16 documentation — Built-in GIN Operator Classes. *"Of the two operator classes for type `jsonb`, `jsonb_ops` is the default. `jsonb_path_ops` supports fewer operators but offers better performance for those operators."* https://www.postgresql.org/docs/16/gin-builtin-opclasses.html

[^jsonb-path-ops]: PostgreSQL 16 documentation — JSON Indexing. *"The technical difference between a `jsonb_ops` and a `jsonb_path_ops` GIN index is that the former creates independent index items for each key and value in the data, while the latter creates index items only for each value in the data… A `jsonb_path_ops` index is usually much smaller than a `jsonb_ops` index over the same data, and the specificity of searches is better, particularly when queries contain keys that appear frequently in the data… A disadvantage of the `jsonb_path_ops` approach is that it produces no index entries for JSON structures not containing any values, such as `{"a": {}}`. If a search for documents containing such a structure is requested, it will require a full-index scan, which is quite slow."* https://www.postgresql.org/docs/16/datatype-json.html

[^pg14-subscript]: PostgreSQL 14 Release Notes. *"Allow subscripting of `JSONB` (Dmitry Dolgov). `JSONB` subscripting can be used to extract and assign to portions of `JSONB` documents."* (Part of the generalized subscripting feature: *"Previously subscript handling was hard-coded into the server, so that subscripting could only be applied to array types. This change allows subscript notation to be used to extract or assign portions of a value of any type for which the concept makes sense."*) https://www.postgresql.org/docs/release/14.0/

[^pg15-numeric]: PostgreSQL 15 Release Notes. *"Adjust JSON numeric literal processing to match the SQL/JSON-standard (Peter Eisentraut). This accepts numeric formats like `.1` and `1.`, and disallows trailing junk after numeric literals, like `1.type()`."* https://www.postgresql.org/docs/release/15.0/

[^pg16-constructors]: PostgreSQL 16 Release Notes. *"Add SQL/JSON constructors (Nikita Glukhov, Teodor Sigaev, Oleg Bartunov, Alexander Korotkov, Amit Langote). The new functions `JSON_ARRAY()`, `JSON_ARRAYAGG()`, `JSON_OBJECT()`, and `JSON_OBJECTAGG()` are part of the SQL standard."* https://www.postgresql.org/docs/release/16.0/

[^pg16-is-json]: PostgreSQL 16 Release Notes. *"Add SQL/JSON object checks (Nikita Glukhov, Teodor Sigaev, Oleg Bartunov, Alexander Korotkov, Amit Langote, Andrew Dunstan). The `IS JSON` checks include checks for values, arrays, objects, scalars, and unique keys."* https://www.postgresql.org/docs/release/16.0/

[^pg16-numeric-paths]: PostgreSQL 16 Release Notes. *"Add support for enhanced numeric literals in SQL/JSON paths (Peter Eisentraut). For example, allow hexadecimal, octal, and binary integers and underscores between digits."* https://www.postgresql.org/docs/release/16.0/

[^pg17-json-table]: PostgreSQL 17 Release Notes. *"Add function `JSON_TABLE()` to convert `JSON` data to a table representation (Nikita Glukhov, Teodor Sigaev, Oleg Bartunov, Alexander Korotkov, Andrew Dunstan, Amit Langote, Jian He). This function can be used in the `FROM` clause of `SELECT` queries as a tuple source."* https://www.postgresql.org/docs/release/17.0/

[^pg17-constructors]: PostgreSQL 17 Release Notes. *"Add SQL/JSON constructor functions `JSON()`, `JSON_SCALAR()`, and `JSON_SERIALIZE()` (Nikita Glukhov, Teodor Sigaev, Oleg Bartunov, Alexander Korotkov, Andrew Dunstan, Amit Langote)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-query-funcs]: PostgreSQL 17 Release Notes. *"Add SQL/JSON query functions `JSON_EXISTS()`, `JSON_QUERY()`, and `JSON_VALUE()` (Nikita Glukhov, Teodor Sigaev, Oleg Bartunov, Alexander Korotkov, Andrew Dunstan, Amit Langote, Peter Eisentraut, Jian He)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-jsonpath-methods]: PostgreSQL 17 Release Notes. *"Add jsonpath methods to convert `JSON` values to other `JSON` data types (Jeevan Chalke). The jsonpath methods are `.bigint()`, `.boolean()`, `.date()`, `.decimal([precision [, scale]])`, `.integer()`, `.number()`, `.string()`, `.time()`, `.time_tz()`, `.timestamp()`, and `.timestamp_tz()`."* https://www.postgresql.org/docs/release/17.0/

[^json-table-cast]: PostgreSQL 17 documentation — `JSON_TABLE`. *"The `context_item` expression is converted to `jsonb` by an implicit cast if the expression is not already of type `jsonb`. Note, however, that any parsing errors that occur during that conversion are thrown unconditionally, that is, are not handled according to the (specified or implicit) `ON ERROR` clause."* https://www.postgresql.org/docs/17/functions-json.html

[^pg18-null-cast]: PostgreSQL 18 Release Notes. *"Allow `jsonb` `null` values to be cast to scalar types as `NULL` (Tom Lane). Previously such casts generated an error."* https://www.postgresql.org/docs/release/18.0/

[^pg18-strip-nulls]: PostgreSQL 18 Release Notes. *"Add optional parameter to `json{b}_strip_nulls` to allow removal of null array elements (Florents Tselai)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-simd]: PostgreSQL 18 Release Notes. *"Improve the performance of processing long `JSON` strings using SIMD (Single Instruction Multiple Data) (David Rowley)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-gin-parallel]: PostgreSQL 18 Release Notes — parallel GIN index build. *"Allow `GIN` indexes to be created in parallel (Tomas Vondra, Matthias van de Meent)."* https://www.postgresql.org/docs/release/18.0/

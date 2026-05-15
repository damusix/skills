# Arrays — Declaration, Literals, Subscripting, Operators, GIN Indexing

PostgreSQL has a first-class **array type for every base type**: the moment you write `text`, the system also has `text[]`, `text[][]`, and so on — same input/output rules, same storage, same operator catalog. Arrays excel at tag lists, multi-valued attributes that never need their own table, parameter passing in PL/pgSQL, and as the natural output of `array_agg()`; they are a footgun when they replace a one-to-many relationship that wanted to be its own table.

This file is the canonical reference for declaring arrays, writing literals safely, navigating the 1-indexed subscript model (with its out-of-bounds-returns-NULL surprise), composing operators (`@>`, `<@`, `&&`, `||`, `ANY`, `ALL`), indexing membership queries with GIN, and knowing when an array column is the right call vs when it is a data-model smell. Composite, domain, ENUM, range and multirange types live in [`15-data-types-custom.md`](./15-data-types-custom.md); JSONB — often the right choice when the answer to "should this be an array?" is "yes, of heterogeneous objects" — lives in [`17-json-jsonb.md`](./17-json-jsonb.md).


## Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix — Array vs Child Table vs JSONB](#decision-matrix--array-vs-child-table-vs-jsonb)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Declaration](#declaration)
    - [Literals — curly-brace vs ARRAY constructor](#literals--curly-brace-vs-array-constructor)
    - [Subscripting](#subscripting)
    - [Modifying arrays in DML](#modifying-arrays-in-dml)
    - [Operators](#operators)
    - [The full function catalog](#the-full-function-catalog)
    - [Searching with ANY and ALL](#searching-with-any-and-all)
    - [unnest and ordinality](#unnest-and-ordinality)
- [Indexing Arrays](#indexing-arrays)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Reach for this file when you are about to:

- Add an array column to a table (or wondering whether you should).
- Write a literal `'{1,2,3}'` or `ARRAY[1,2,3]` and get the escaping wrong.
- Search for "contains any of", "contains all of", or "overlaps with" — operators that look unfamiliar (`@>`, `<@`, `&&`).
- Index `WHERE tags @> ARRAY['urgent']`-style membership queries (GIN, not B-tree).
- Translate a result-set into a single row with `array_agg()` or expand one back out with `unnest()`.
- Pass a variable-length list of values to PL/pgSQL and not know whether to use `VARIADIC`, an array parameter, or a `text` of comma-joined values.

If you really want **set semantics** (deduplication, mathematical set operations) consider a child table or `WITH x AS (SELECT DISTINCT unnest(arr)) ...` instead — arrays are *ordered* and *duplicate-tolerant*. If you need **nested heterogeneous structure**, the answer is JSONB, not array-of-arrays.


## Mental Model


Five rules govern almost every array surprise:

1. **Every type has a parallel array type, auto-created.** `integer` has `_int4` (displayed as `integer[]`). You do not `CREATE TYPE foo[]`; the array type is materialized in `pg_type` automatically with `typarray` pointing back to the element type's OID.[^arrays]
2. **Arrays are 1-indexed by default, but the lower bound is a property of the value, not the type.** The literal `'[2:4]={a,b,c}'::text[]` has lower bound 2. Built constructors (`ARRAY[1,2,3]`, `array_append`, `array_cat`) always produce lower bound 1; the unusual lower bounds only show up if you wrote a non-default literal or fed `array_fill` an explicit lower-bound argument.[^arrays]
3. **Subscripting an out-of-bounds index returns NULL, not an error.** This is the most frequent source of silent bugs. `(ARRAY[1,2,3])[10]` is `NULL`. Slicing a fully-out-of-range range returns an *empty* zero-dimensional array, not NULL.[^arrays]
4. **Declared size and dimension are decorative.** `integer[3][3]` does *not* constrain the array to 3×3. The grammar accepts the syntax; the engine ignores the limits and stores any size and any dimensionality. Use a `CHECK` constraint if you actually need a bound.[^arrays]
5. **Equality is element-wise; "contains" is the `@>` operator.** `a = b` returns true only when every element matches in order. `a @> b` returns true when every element of `b` appears somewhere in `a`. Mixing these up is the second-most-frequent array bug after off-by-one indexing.[^funcs]

Important corollary to rule 2: **PostgreSQL ignores the declared size in `integer[3][3]` and does not enforce dimensionality** — the documented behavior is verbatim: *"PostgreSQL ignores declared size limits and does not enforce the declared number of dimensions."*[^arrays]


## Decision Matrix — Array vs Child Table vs JSONB


| You need to store … | Use | Avoid | Why |
|---|---|---|---|
| A small set of homogeneous primitive values per row (tags, role names, allowed origins) | `text[]` (or `integer[]`) | child table when there's no row-specific metadata | One round-trip; GIN index on `@>` works; no join cost |
| A list that *will* grow per row with per-element metadata (notes, audit entries) | Child table with FK | array | Each element has its own row, indexable independently |
| A bag of distinct identifiers used for "user has access to X" lookups (membership tests) | `bigint[]` + GIN | many `EXISTS` joins | `@>` with GIN is faster than join on tiny lookups |
| Nested heterogeneous shape (different keys per element, or arrays of objects) | `jsonb` | array of records | Arrays of composite types are technically legal but operationally painful |
| A fixed-shape coordinate or vector | composite type or `vector(N)` ([`94-pgvector.md`](./94-pgvector.md)) | array | Types have names; pgvector has distance operators |
| A multidimensional matrix for analytics | external system or `bytea` of floats | `double precision[][]` | PG arrays carry per-element overhead; not designed for dense numerics |
| Ordered sequence where ordering carries data meaning (e.g. command sequence) | array | unordered set | Arrays preserve insertion order — sets do not |
| A pair / triple of bounds where overlap is the query (e.g. "available time windows") | `tstzrange` / `tstzmultirange` ([`15-data-types-custom.md`](./15-data-types-custom.md)) | array of two timestamps | Range types ship overlap/containment operators and GiST indexing |
| A "set membership" relation between two entities | join table | array of FKs | FK enforcement requires a join table; array-of-FK foreign keys are not supported |

Three honest "smell" signals that an array column should probably have been a child table:

- You find yourself writing `unnest(arr)` in every query against the column.
- You want a `FOREIGN KEY` on the array elements (cannot — PostgreSQL has no array-element FK).
- You want to update *one element by primary key* rather than by position.


## Syntax / Mechanics


### Declaration


Three equivalent declarations for "column of integers":

    CREATE TABLE t (
        tags     text[],          -- the canonical PostgreSQL form
        scores   integer ARRAY,   -- SQL standard, no size
        matrix   integer ARRAY[4] -- SQL standard with size (ignored)
    );

The size and dimension count in `text[10][3]` are **parsed and discarded** — every column declared as an array of `text` accepts any size and any dimensionality.[^arrays] This was a deliberate design choice: declared bounds were considered too rigid for the dynamic use cases arrays are usually applied to. Enforce with `CHECK (cardinality(matrix) = 16)` if you genuinely need a fixed cardinality.

Multidimensional arrays must be **rectangular** (all sub-arrays at a given dimension have the same length). Ragged 2D arrays are not legal:

    -- ERROR: multidimensional arrays must have array expressions with matching dimensions
    SELECT ARRAY[ARRAY[1,2], ARRAY[3,4,5]];


### Literals — curly-brace vs ARRAY constructor


PostgreSQL accepts two literal forms; each has a niche:

    -- Curly-brace text literal (a string that PostgreSQL parses as an array on cast)
    '{1, 2, 3}'::integer[]
    '{{1,2,3},{4,5,6}}'::integer[]           -- 2D
    '{"hello, world", "with \"quotes\""}'::text[]

    -- ARRAY constructor (each element is an ordinary SQL expression)
    ARRAY[1, 2, 3]
    ARRAY[ARRAY[1,2,3], ARRAY[4,5,6]]
    ARRAY['hello, world', 'with "quotes"']
    ARRAY[]::integer[]                        -- empty array (must cast)

**Pick the constructor form for everything except hand-written DDL constants.** The constructor evaluates each element as a normal SQL expression: bound parameters work, function calls work, type promotion works. The curly-brace form is a string that PostgreSQL parses *as* an array on cast — useful for `DEFAULT '{}'::text[]` and for psql's `\copy` input, but error-prone in client code because every embedded comma, brace, backslash, double quote, and whitespace boundary follows array-literal escape rules separate from SQL string-literal escape rules.[^arrays]

Quoting rules for curly-brace form (any one of these requires double-quoting an element):

- Element is the empty string `""`
- Element contains `{` or `}`
- Element contains the delimiter (`,` for most types; `;` for `box`)
- Element contains `"` or `\` (these must also be escaped with `\` inside the quotes)
- Element has leading or trailing whitespace
- Element matches the literal word `NULL` (case-insensitive) — use `"NULL"` for the string `NULL`

The `array_nulls` GUC controls whether unquoted `NULL` in input is recognized as a NULL element. Default is `on`; rarely changed.


### Subscripting


    SELECT (ARRAY['a','b','c'])[2];                   -- 'b' — 1-indexed
    SELECT (ARRAY['a','b','c'])[0];                   -- NULL — out of bounds
    SELECT (ARRAY['a','b','c'])[100];                 -- NULL — out of bounds, NOT an error
    SELECT (ARRAY['a','b','c','d','e'])[2:4];         -- {b,c,d} — slice returns an array
    SELECT (ARRAY['a','b','c','d','e'])[2:];          -- {b,c,d,e} — omitted upper bound
    SELECT (ARRAY['a','b','c','d','e'])[:3];          -- {a,b,c} — omitted lower bound

The verbatim out-of-bounds rule from the docs: *"null is returned if a subscript is outside the array bounds (this case does not raise an error)."*[^arrays] For slices: *"In other cases such as selecting an array slice that is completely outside the current array bounds, a slice expression yields an empty (zero-dimensional) array instead of null."*[^arrays]

The asymmetry — single-element subscript → NULL, slice → empty array — is the single most common source of array-related bugs in production code. Defensive code that needs to distinguish "the array had 5 elements and you asked for #10" from "the array was NULL" must use `array_length(arr, 1)` or `cardinality(arr)`, not the subscript result.

**Slice-with-single-index promotion.** When *any* dimension is a slice (contains `:`), *all* dimensions are treated as slices for that expression: a dimension written as bare `[2]` becomes `[1:2]`. From the docs: *"If any dimension is written as a slice, i.e., contains a colon, then all dimensions are treated as slices."*[^arrays] This trips up code that mixes slice and single-index subscripting on multidimensional arrays.

> [!NOTE] PostgreSQL 14
> Subscripting was generalized so that user types (not only arrays) can implement subscripting. *"Previously subscript handling was hard-coded into the server, so that subscripting could only be applied to array types."*[^pg14-subscript] As a practical consequence, `jsonb` gained subscript syntax (`my_json['key']`) — see [`17-json-jsonb.md`](./17-json-jsonb.md). Array subscripting behaviour itself did not change.


### Modifying arrays in DML


Replace the whole array:

    UPDATE t SET tags = ARRAY['a','b','c'] WHERE id = 1;
    UPDATE t SET tags = '{a,b,c}'         WHERE id = 1;

Replace one element by position:

    UPDATE t SET tags[2] = 'new' WHERE id = 1;

Replace a slice:

    UPDATE t SET tags[2:4] = ARRAY['x','y','z'] WHERE id = 1;

Append, prepend, concatenate:

    UPDATE t SET tags = tags || 'new'         WHERE id = 1;   -- append
    UPDATE t SET tags = 'first' || tags       WHERE id = 1;   -- prepend
    UPDATE t SET tags = tags || ARRAY['x','y'] WHERE id = 1;  -- concat
    UPDATE t SET tags = array_append(tags, 'new');             -- function form

Remove by value (all occurrences):

    UPDATE t SET tags = array_remove(tags, 'old');

Replace by value (all occurrences):

    UPDATE t SET tags = array_replace(tags, 'old', 'new');

**Element assignment can enlarge a 1D array** (the gap fills with NULLs):

    -- arr was {1,2,3,4}; after this it is {1,2,3,4,NULL,99}
    UPDATE t SET arr[6] = 99 WHERE id = 1;

This works for 1D arrays only. Multidimensional enlargement is rejected.

There is **no `array_insert(at_position, value)`** in core PostgreSQL. To insert into the middle, slice around the target index:

    -- Insert 'X' at position 3 in arr = {a,b,c,d,e}
    UPDATE t SET arr = arr[1:2] || 'X' || arr[3:] WHERE id = 1;
    -- Result: {a,b,X,c,d,e}


### Operators


| Operator | Signature | Meaning | Indexable by |
|---|---|---|---|
| `=` | `anyarray = anyarray` | Element-wise equality (same length, all elements `IS NOT DISTINCT FROM` corresponding) | B-tree on whole-array, GIN `array_ops` |
| `<>` `<` `<=` `>` `>=` | `anyarray <op> anyarray` | Element-wise comparison, sort by first difference | B-tree |
| `@>` | `anyarray @> anyarray` | Left contains every element of right (duplicates ignored) | GIN `array_ops` |
| `<@` | `anyarray <@ anyarray` | Left contained by right | GIN `array_ops` |
| `&&` | `anyarray && anyarray` | Arrays share at least one element (overlap) | GIN `array_ops` |
| `\|\|` | `array \|\| array`, `elem \|\| array`, `array \|\| elem` | Concatenate (also as `array_cat`, `array_prepend`, `array_append`) | — |

Verbatim definitions from `functions-array.html`:[^funcs]

- `@>`: *"Does the first array contain the second, that is, does each element appearing in the second array equal some element of the first array? (Duplicates are not treated specially, thus `ARRAY[1]` and `ARRAY[1,1]` are each considered to contain the other.)"*
- `&&`: *"Do the arrays overlap, that is, have any elements in common?"*
- `||`: *"Concatenates the two arrays. Concatenating a null or empty array is a no-op; otherwise the arrays must have the same number of dimensions (as illustrated by the first example) or differ in number of dimensions by one."*

The duplicates-ignored rule for `@>` is the canonical subtlety: `ARRAY[1] @> ARRAY[1,1]` returns true, and `ARRAY[1,1] @> ARRAY[1]` also returns true. If your application code is using `@>` as a *multiset* containment test, it is silently wrong.


### The full function catalog


| Function | Returns | What it does |
|---|---|---|
| `array_append(arr, elem)` | array | Append element (same as `arr \|\| elem`) |
| `array_prepend(elem, arr)` | array | Prepend element (same as `elem \|\| arr`) |
| `array_cat(a, b)` | array | Concatenate (same as `a \|\| b`) |
| `array_dims(arr)` | text | Text rep of dimensions, e.g. `[1:3][1:2]` |
| `array_fill(value, dims_int[], lbounds_int[])` | array | Build array of given shape filled with value |
| `array_length(arr, dim)` | integer | Length along dimension `dim`; NULL for empty/missing dim |
| `array_lower(arr, dim)` | integer | Lower bound of dimension `dim` |
| `array_upper(arr, dim)` | integer | Upper bound of dimension `dim` |
| `array_ndims(arr)` | integer | Number of dimensions |
| `array_position(arr, val, [start])` | integer | First subscript of `val` in 1D array; NULL if absent. `IS NOT DISTINCT FROM` semantics → searches for NULL |
| `array_positions(arr, val)` | integer[] | All subscripts of `val` in 1D array; `{}` (not NULL) if absent |
| `array_remove(arr, val)` | array | Remove every element equal to `val` (1D only) |
| `array_replace(arr, old, new)` | array | Replace every `old` with `new` |
| `array_to_string(arr, sep, [null_repr])` | text | Join elements; NULL elements omitted unless `null_repr` given |
| `string_to_array(str, sep, [null_str])` | text[] | Split string; treat tokens equal to `null_str` as NULL |
| `cardinality(arr)` | integer | Total element count across all dimensions; `0` for empty |
| `unnest(arr)` | setof element | Set-returning; expand array into rows |
| `unnest(a, b, ...)` | setof (a_elem, b_elem, ...) | Multi-array unnest, shorter arrays padded with NULL; FROM clause only |
| `generate_subscripts(arr, dim, [reverse])` | setof integer | Yield each subscript of dimension `dim` |
| `trim_array(arr, n)` | array | Remove last `n` elements of first dimension |
| `array_sample(arr, n)` | array | Random `n` items from first dimension |
| `array_shuffle(arr)` | array | Randomly permute first dimension |
| `array_reverse(arr)` | array | Reverse first dimension |
| `array_sort(arr)` | array | Sort first dimension ascending |

> [!NOTE] PostgreSQL 14
> `trim_array(arr, n)` was added: *"Add SQL-standard `trim_array()` function. This could already be done with array slices, but less easily."*[^pg14-trim] In the same release, `array_append`, `array_prepend`, `array_cat`, `array_position`, `array_positions`, `array_remove`, `array_replace`, and `width_bucket()` were retyped from `anyarray` to `anycompatiblearray`, *"makes them less fussy about exact matches of argument types."*[^pg14-anycompat]

> [!NOTE] PostgreSQL 16
> `array_sample(arr, n)` and `array_shuffle(arr)` were added.[^pg16-sample] In the same release, `array_agg` and `string_agg` were parallelized.[^pg16-parallel]

> [!NOTE] PostgreSQL 18
> `array_reverse(arr)` and `array_sort(arr)` were added.[^pg18-arrays] `MIN()` and `MAX()` aggregates now accept array and composite arguments.[^pg18-minmax] GIN index builds are parallelizable.[^pg18-gin-parallel]


### Searching with ANY and ALL


`expr = ANY (array_expr)` is the canonical "is this value in the array?" predicate:

    SELECT * FROM users WHERE 'admin' = ANY (roles);              -- 'admin' in roles
    SELECT * FROM users WHERE 'admin' <> ALL (roles);             -- 'admin' not in roles
    SELECT * FROM events WHERE event_type = ANY (ARRAY['a','b']); -- type is a or b

This is the **idiomatic Postgres `IN`-list-from-a-parameter** pattern: drivers bind a single `text[]` parameter, the server expands. Compared to `IN ($1, $2, $3, ...)`, the `= ANY ($1::text[])` form has **one** prepared plan regardless of list length, and the array can be empty.

Be precise about quantification:

- `x = ANY (arr)` → true if *some* element equals `x`.
- `x = ALL (arr)` → true if *every* element equals `x` (vacuously true on empty array).
- `x <> ANY (arr)` → true if *some* element differs from `x` (almost always wrong for "not in"; use `<> ALL`).
- `x <> ALL (arr)` → true if *every* element differs from `x` (the correct "not in").

`= ANY` is **planner-equivalent to `IN`** for indexable comparisons — both produce the same scan plan on a B-tree index of the compared column. `@>`, `<@`, `&&` are not interchangeable with `IN`; they are containment between arrays, not value-in-array.


### unnest and ordinality


`unnest(arr)` is the inverse of `array_agg`:

    SELECT tag
      FROM unnest(ARRAY['a','b','c']) AS tag;
    -- a, b, c

With `WITH ORDINALITY` (which is set-returning-function syntax, not unnest-specific), you get the position:

    SELECT *
      FROM unnest(ARRAY['a','b','c']) WITH ORDINALITY AS t(elem, pos);
    --  elem | pos
    -- ------+-----
    --  a    |   1
    --  b    |   2
    --  c    |   3

The multi-array `unnest` form **is FROM-clause-only** and pads shorter arrays:

    SELECT * FROM unnest(ARRAY[1,2,3], ARRAY['a','b']) AS t(n, s);
    --  n |  s
    -- ---+------
    --  1 | a
    --  2 | b
    --  3 | NULL

Used together, `unnest` + `WITH ORDINALITY` + `array_agg` over a recomputed array gives you per-element manipulation while preserving order:

    UPDATE t
       SET tags = (
           SELECT array_agg(elem ORDER BY pos)
             FROM unnest(t.tags) WITH ORDINALITY AS u(elem, pos)
            WHERE elem <> 'tombstone'
       )
     WHERE id = 1;


## Indexing Arrays


The native index access method for arrays is **GIN with `array_ops`** (the default operator class when you `CREATE INDEX ... USING gin (col)` on an array column). GIN supports the four set-style operators: `&&` (overlap), `@>` (contains), `<@` (contained by), `=`.[^gin-opclass]

    CREATE INDEX ON posts USING gin (tags);

    -- This query can now use the index:
    SELECT * FROM posts WHERE tags @> ARRAY['urgent'];

The B-tree index access method **also supports arrays**, but only for whole-array equality and ordering (`=`, `<`, `>`, `<=`, `>=`). A B-tree on `tags` will accelerate `WHERE tags = ARRAY[...]` but **not** `WHERE 'urgent' = ANY (tags)`. For tag-style membership queries, you want GIN.

**GIN tuning knobs that matter for arrays:**

- `gin_pending_list_limit` (default 4 MB per table-level setting `fastupdate=on`): GIN insertions go to a pending list first, flushed to the main index on threshold or VACUUM. High-churn array tables can see lookup-amplification if the pending list grows. Lower the per-table value or set `fastupdate=off` on tables that read more than they write.
- `gin_fuzzy_search_limit` (default 0 — unlimited): caps the number of rows returned from a single GIN scan. Useful for protecting against runaway predicate-popular queries.

**Functional GIN on an unnested array** lets you index just the elements when the array contains structures:

    -- For text[] of structured tokens, normalize lowercase
    CREATE INDEX ON posts USING gin (LOWER(tags::text)::text[]);

    -- Or for queries on a derived array
    CREATE INDEX ON events USING gin ((string_to_array(LOWER(tags_csv), ',')));

> [!NOTE] PostgreSQL 18
> GIN index builds (initial `CREATE INDEX` and `REINDEX`) can be parallel.[^pg18-gin-parallel] No code change required — `max_parallel_maintenance_workers > 0` is sufficient.

**The intarray contrib extension** offers operators (`&&`, `@>`, `<@`) that work only on integer arrays without NULLs, with GIN (`gin__int_ops`) and GiST (`gist__int_ops`, `gist__intbig_ops`) operator classes. From the docs: *"The operators `&&`, `@>` and `<@` are equivalent to PostgreSQL's built-in operators of the same names, except that they work only on integer arrays that do not contain nulls, while the built-in operators work for any array type. This restriction makes them faster than the built-in operators in many cases."*[^intarray] Reach for it when you have a hot, large integer-array workload with no NULLs; otherwise stick with the built-in `array_ops`.

**Cross-reference:** GIN internals (pending list, posting tree, posting list), GiST extensibility, the full GIN operator-class catalog, and B-tree-vs-GIN trade-offs all live in [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md). The 7-way index-type decision matrix is in [`22-indexes-overview.md`](./22-indexes-overview.md).


## Examples / Recipes


### Recipe 1 — Tag column with GIN-indexed `@>` lookup


    CREATE TABLE posts (
        id     bigserial PRIMARY KEY,
        body   text,
        tags   text[] NOT NULL DEFAULT '{}'
    );
    CREATE INDEX posts_tags_gin ON posts USING gin (tags);

    INSERT INTO posts (body, tags) VALUES
        ('first',  ARRAY['draft','blog']),
        ('second', ARRAY['blog','urgent']),
        ('third',  ARRAY['draft']);

    -- Posts tagged 'urgent'
    SELECT id FROM posts WHERE tags @> ARRAY['urgent'];

    -- Posts tagged BOTH 'draft' AND 'blog'
    SELECT id FROM posts WHERE tags @> ARRAY['draft','blog'];

    -- Posts tagged 'draft' OR 'blog' (overlap)
    SELECT id FROM posts WHERE tags && ARRAY['draft','blog'];

The `NOT NULL DEFAULT '{}'` is deliberate. `NULL` and the empty array `'{}'` are different — most query patterns are simpler if every row has the empty-array baseline.


### Recipe 2 — Parameter binding with `= ANY` instead of dynamic `IN`


    -- Application code passes one parameter, an array of ids, regardless of length:
    PREPARE p1 (bigint[]) AS
      SELECT * FROM users WHERE id = ANY ($1);

    EXECUTE p1 (ARRAY[1, 2, 3]);
    EXECUTE p1 (ARRAY[]::bigint[]);   -- empty array — zero rows, no SQL injection risk

This is the canonical replacement for hand-built `IN (?, ?, ?, ...)` strings. See [`10-dynamic-sql.md`](./10-dynamic-sql.md) for the discussion of why this pattern is safer than dynamic SQL construction.


### Recipe 3 — `array_agg` to collapse, `unnest` to expand


    -- One row per user with their roles bundled
    SELECT user_id, array_agg(role ORDER BY granted_at) AS roles
      FROM user_roles
      GROUP BY user_id;

    -- Inverse: one row per (user, role) from a user-with-roles-array table
    SELECT u.id, r AS role
      FROM users AS u, unnest(u.roles) AS r;

The `ORDER BY` inside `array_agg` is **not optional for determinism**. Without it, the array contents come back in whatever order the aggregate happened to consume input — different runs can produce different arrays. The same gotcha applies to `string_agg`. See [`12-aggregates-grouping.md`](./12-aggregates-grouping.md).


### Recipe 4 — `unnest WITH ORDINALITY` for position-aware updates


    -- Renumber a position-stored array after a deletion
    UPDATE document
       SET section_ids = (
           SELECT array_agg(s ORDER BY pos)
             FROM unnest(section_ids) WITH ORDINALITY AS u(s, pos)
            WHERE s <> deleted_section_id
       )
     WHERE id = $1;


### Recipe 5 — Insert one element at a specific position (1D)


    -- Insert 'X' at position 3 in arr = {a,b,c,d,e}
    UPDATE t
       SET arr = arr[1:2] || 'X' || arr[3:]
     WHERE id = 1;
    -- Result: {a, b, X, c, d, e}

There is no built-in `array_insert(at, val)`. The slice-and-concatenate idiom is the canonical pattern.


### Recipe 6 — Find rows where any element matches a regex


    -- Posts where any tag starts with 'urg'
    SELECT id
      FROM posts
     WHERE EXISTS (
         SELECT 1
           FROM unnest(tags) AS t
          WHERE t ~ '^urg'
     );

    -- Or, with explicit unnest in FROM:
    SELECT DISTINCT p.id
      FROM posts AS p, unnest(p.tags) AS t
     WHERE t ~ '^urg';

Pattern matching against elements is **not GIN-indexable** with `array_ops`. For `LIKE 'urg%'`-style queries against many elements, consider denormalizing into a child table with a B-tree on the value, or using `pg_trgm` on a concatenated `array_to_string(tags, ' ')` column.


### Recipe 7 — Deduplicate while preserving order


    -- Custom: built-in array_distinct does not exist
    SELECT array_agg(DISTINCT elem) AS unique_unordered,
           array_agg(elem ORDER BY pos) AS preserve_order_with_dups,
           (SELECT array_agg(elem ORDER BY MIN(pos))
              FROM unnest(arr) WITH ORDINALITY AS u(elem, pos)
              GROUP BY elem) AS dedup_preserve_first_seen
      FROM t;

PostgreSQL does not ship an `array_distinct` function. The standard idiom is `array_agg(DISTINCT ...)`, but it loses ordering. For order-preserving dedup, group by element with `MIN(pos)`.


### Recipe 8 — Bitwise-style "must have all", "must have any", "must have none"


    -- All required tags present:
    WHERE tags @> ARRAY['active','public']

    -- Any of these tags present:
    WHERE tags && ARRAY['urgent','high-priority']

    -- None of these tags present:
    WHERE NOT (tags && ARRAY['draft','deleted'])
    -- Equivalent:
    WHERE tags @> ARRAY[]::text[]   -- (trivially true; do not use)
    WHERE NOT EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE t = ANY (ARRAY['draft','deleted']))

The `NOT (a && b)` form is the most readable — and it is GIN-indexable on `a`.


### Recipe 9 — Compute "is this row missing any required tag?"


    -- Required: {active, public}
    SELECT id, ARRAY(
              SELECT r
                FROM unnest(ARRAY['active','public']) AS r
               WHERE r <> ALL (tags)
           ) AS missing
      FROM posts
     WHERE NOT (tags @> ARRAY['active','public']);

`<> ALL` is the right "not in this array" predicate. `<> ANY` is almost always a bug.


### Recipe 10 — Append-on-conflict to track a multi-valued history


    -- Track which campaigns a user has been part of, idempotently
    CREATE TABLE user_campaigns (
        user_id   bigint PRIMARY KEY,
        campaigns text[] NOT NULL DEFAULT '{}'
    );

    INSERT INTO user_campaigns (user_id, campaigns)
    VALUES (:uid, ARRAY[:campaign])
    ON CONFLICT (user_id) DO UPDATE
       SET campaigns = CASE
           WHEN user_campaigns.campaigns @> ARRAY[:campaign]
             THEN user_campaigns.campaigns
           ELSE user_campaigns.campaigns || :campaign
       END;

This is one of the cleaner array column use cases: low cardinality, idempotent append, no per-element metadata needed.


### Recipe 11 — `PARALLEL SAFE` array helper for use in queries


    CREATE OR REPLACE FUNCTION array_intersect(a anyarray, b anyarray)
    RETURNS anyarray
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
        SELECT ARRAY(
            SELECT unnest($1)
            INTERSECT
            SELECT unnest($2)
        );
    $$;

    SELECT array_intersect(ARRAY[1,2,3], ARRAY[2,3,4]);  -- {2,3}

Cross-reference [`06-functions.md`](./06-functions.md) for volatility and parallel-safety classification.


### Recipe 12 — Audit: find array columns in the database


    SELECT n.nspname  AS schema,
           c.relname  AS table,
           a.attname  AS column,
           format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      JOIN pg_class c     ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t      ON t.oid = a.atttypid
     WHERE t.typcategory = 'A'                -- array category
       AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY 1, 2, a.attnum;

Use this to find array columns before deciding which need a GIN index, which should become child tables, or which should migrate to JSONB. `pg_type.typcategory = 'A'` is the canonical array filter — see [`64-system-catalogs.md`](./64-system-catalogs.md).


### Recipe 13 — Empty array vs NULL audit


    -- Rows where tags is NULL — usually a model error
    SELECT id FROM posts WHERE tags IS NULL;

    -- Rows where tags is empty — usually valid
    SELECT id FROM posts WHERE cardinality(tags) = 0;

    -- The NULL-or-empty union (rarely what you want):
    SELECT id FROM posts WHERE COALESCE(cardinality(tags), 0) = 0;

`array_length(arr, 1)` returns NULL for both empty and missing-dimension arrays, which is why `cardinality(arr) = 0` is the cleaner emptiness test — `cardinality` returns 0, not NULL, on empty.


## Gotchas / Anti-patterns


1. **Out-of-bounds subscript returns NULL, not error.** See Mental Model rule 3. Defensive code must check `cardinality(arr)` before indexing if NULL is a meaningful distinct value from a real element.[^arrays]

2. **Out-of-bounds slice returns empty array, not NULL.** Single index → NULL; slice → empty array. The asymmetry is documented but surprising. Slicing `arr[100:200]` on a 5-element array returns `{}`, not NULL.[^arrays]

3. **Declared size and dimension are ignored.** See Mental Model rule 4. `integer[3][3]` accepts a 100×100 array. Use `CHECK (cardinality(arr) = 9)` if you need real enforcement.[^arrays]

4. **`array_length(arr, 1)` returns NULL for an empty array.** This is the second-most-common subscript bug after #1: `array_length(ARRAY[]::int[], 1)` is NULL, not 0. Use `cardinality(arr)` if you want 0 for empty.

5. **`@>` is duplicate-blind.** `ARRAY[1] @> ARRAY[1,1]` is true. If you need multiset containment, you must `unnest` and count.

6. **`tags = ARRAY['a','b']` is order-sensitive.** `{a,b}` ≠ `{b,a}`. For order-independent equality use `array_agg(... ORDER BY ...)` on both sides, or `a @> b AND b @> a`.

7. **`x <> ANY (arr)` is almost always wrong.** It is true whenever *any* element differs from `x`, including the case where some element equals `x` and others do not. The correct "not in array" predicate is `x <> ALL (arr)` (or `NOT (x = ANY (arr))`).

8. **No FK on array elements.** PostgreSQL does not support a foreign-key constraint that references each element of an array. If FK is required, model as a join table. The pattern `tags integer[] REFERENCES tag(id)` does **not** exist.

9. **Array of composite types is legal but operationally painful.** Per-field access requires the `(arr[i]).field` syntax, GIN does not natively support member-field equality, and serialization/deserialization is byte-level brittle. Almost always you wanted JSONB or a child table.

10. **Multidimensional arrays must be rectangular.** Ragged 2D arrays (`ARRAY[ARRAY[1,2], ARRAY[3,4,5]]`) raise *"multidimensional arrays must have array expressions with matching dimensions"*. If you need ragged structure, use JSONB.

11. **Element assignment can enlarge a 1D array silently, padding with NULLs.** `UPDATE t SET arr[10] = 99` on a 5-element array produces `{..., NULL, NULL, NULL, NULL, NULL, 99}`. If the caller meant "append," they wanted `arr || 99`.

12. **Literal text form does not always round-trip what you think.** `'{Hello, World}'::text[]` is a 2-element array `{"Hello","World"}`. The unquoted comma is the delimiter; spaces are stripped; quoting was needed to keep "Hello, World" as one element. The `ARRAY[...]` constructor form sidesteps every escape rule and should be the default.

13. **GIN does not index `LIKE '%x%'` on array elements.** `array_ops` is for the set operators (`@>`, `<@`, `&&`, `=`). For substring search on elements, normalize into a child table or use `pg_trgm` ([`93-pg-trgm.md`](./93-pg-trgm.md)) on a `array_to_string(arr, ' ')` derived column.

14. **`array_position` and `array_remove` are 1D-only.** Calling them on a 2D array raises an error. Multidimensional arrays support only whole-array operations, slicing, and dimension-level functions (`array_length`, `array_dims`, etc.).

15. **`array_remove` removes all occurrences, not the first one.** It is value-based, not index-based. To remove the element at a specific position, slice around it: `arr[1:i-1] || arr[i+1:]`.

16. **`unnest(a, b, c)` is FROM-clause-only.** It cannot appear in `SELECT`. Single-array `unnest(a)` works anywhere; the multi-array form is restricted to `FROM`.

17. **Empty `ARRAY[]` requires an explicit cast.** `ARRAY[]` alone is ambiguous; write `ARRAY[]::integer[]` (or whichever element type). The curly-brace literal `'{}'::integer[]` also works.

18. **`array_agg(... ORDER BY ...)` is required for determinism.** Without `ORDER BY`, the order of elements in the resulting array is unspecified and can change run-to-run. Same rule applies to `string_agg`.[^funcs]

19. **`array_agg` includes NULLs in its output.** If the grouped column has NULLs they appear as NULL elements in the array. Use `array_agg(col) FILTER (WHERE col IS NOT NULL)` or `array_remove(array_agg(col), NULL)` to drop them.

20. **`generate_subscripts(arr, 1)` is empty for an empty array.** It returns zero rows, not a single NULL row. `LATERAL` joins against it for empty arrays produce zero output rows, which can silently drop the outer row in an inner join.


## See Also


- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — Element types: text, numeric, boolean, bytea, network, bit-string.
- [`15-data-types-custom.md`](./15-data-types-custom.md) — Composite types (used as array elements at your peril), ENUM, range, multirange.
- [`17-json-jsonb.md`](./17-json-jsonb.md) — JSON/JSONB; the right home for nested heterogeneous structure.
- [`22-indexes-overview.md`](./22-indexes-overview.md) — Index-type decision matrix; B-tree vs GIN for array columns.
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — Deep dive on GIN internals (posting list/tree, fastupdate, gin_pending_list_limit) and operator classes.
- [`10-dynamic-sql.md`](./10-dynamic-sql.md) — Using `= ANY ($1::int[])` instead of building `IN ($1, $2, …)` strings.
- [`12-aggregates-grouping.md`](./12-aggregates-grouping.md) — `array_agg` with `DISTINCT`, `FILTER`, `ORDER BY`; PG16 parallel aggregation.
- [`93-pg-trgm.md`](./93-pg-trgm.md) — Trigram indexing on a `array_to_string(arr, ' ')` derived column for substring search.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_type.typcategory = 'A'` for finding all array columns.
- [`94-pgvector.md`](./94-pgvector.md) — `vector(N)` for dense numeric arrays; ANN indexing.
- [`31-toast.md`](./31-toast.md) — TOAST storage for large arrays exceeding the 8 kB page size; compression strategies and inline vs out-of-line storage.


## Sources


[^arrays]: "Arrays" — PostgreSQL 16 manual. Exact verbatim rules quoted: *"By default PostgreSQL uses a one-based numbering convention for arrays, that is, an array of n elements starts with array[1] and ends with array[n]."*; *"PostgreSQL ignores declared size limits and does not enforce the declared number of dimensions."*; *"null is returned if a subscript is outside the array bounds (this case does not raise an error)."*; *"In other cases such as selecting an array slice that is completely outside the current array bounds, a slice expression yields an empty (zero-dimensional) array instead of null."*; *"If any dimension is written as a slice, i.e., contains a colon, then all dimensions are treated as slices."*; *"Arrays are not sets; searching for specific array elements can be a sign of database misdesign."* https://www.postgresql.org/docs/16/arrays.html
[^funcs]: "Array Functions and Operators" — PostgreSQL 16 manual. Exact verbatim operator descriptions: `@>`: *"Does the first array contain the second, that is, does each element appearing in the second array equal some element of the first array? (Duplicates are not treated specially, thus ARRAY[1] and ARRAY[1,1] are each considered to contain the other.)"*; `&&`: *"Do the arrays overlap, that is, have any elements in common?"*; `||`: *"Concatenates the two arrays. Concatenating a null or empty array is a no-op; otherwise the arrays must have the same number of dimensions … or differ in number of dimensions by one."* https://www.postgresql.org/docs/16/functions-array.html
[^gin-opclass]: "Built-in Operator Classes" — PostgreSQL 16 manual. `array_ops` supports `&&`, `@>`, `<@`, `=` on `anyarray`. https://www.postgresql.org/docs/16/gin-builtin-opclasses.html
[^intarray]: "intarray" — PostgreSQL 16 manual. Quote: *"The operators `&&`, `@>` and `<@` are equivalent to PostgreSQL's built-in operators of the same names, except that they work only on integer arrays that do not contain nulls, while the built-in operators work for any array type. This restriction makes them faster than the built-in operators in many cases."* Provides `gist__int_ops`, `gist__intbig_ops`, `gin__int_ops`. https://www.postgresql.org/docs/16/intarray.html
[^pg14-trim]: PG 14 release notes: *"Add SQL-standard `trim_array()` function (Vik Fearing). This could already be done with array slices, but less easily."* https://www.postgresql.org/docs/release/14.0/
[^pg14-anycompat]: PG 14 release notes: *"Allow some array functions to operate on a mix of compatible data types (Tom Lane). The functions `array_append()`, `array_prepend()`, `array_cat()`, `array_position()`, `array_positions()`, `array_remove()`, `array_replace()`, and `width_bucket()` now take `anycompatiblearray` instead of `anyarray` arguments. This makes them less fussy about exact matches of argument types."* https://www.postgresql.org/docs/release/14.0/
[^pg14-subscript]: PG 14 release notes: *"Allow extensions and built-in data types to implement subscripting (Dmitry Dolgov). Previously subscript handling was hard-coded into the server, so that subscripting could only be applied to array types. This change allows subscript notation to be used to extract or assign portions of a value of any type for which the concept makes sense."* https://www.postgresql.org/docs/release/14.0/
[^pg16-sample]: PG 16 release notes: *"Add functions `array_sample()` and `array_shuffle()` (Martin Kalcher)."* https://www.postgresql.org/docs/release/16.0/
[^pg16-parallel]: PG 16 release notes: *"Allow aggregate functions `string_agg()` and `array_agg()` to be parallelized (David Rowley)."* https://www.postgresql.org/docs/release/16.0/
[^pg18-arrays]: PG 18 release notes: *"Add function `array_reverse()` which reverses an array's first dimension (Aleksander Alekseev)."* and *"Add function `array_sort()` which sorts an array's first dimension (Junwang Zhao, Jian He)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-minmax]: PG 18 release notes: *"Allow `MIN()`/`MAX()` aggregates on arrays and composite types (Aleksander Alekseev, Marat Buharov)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-gin-parallel]: PG 18 release notes: *"Allow `GIN` indexes to be created in parallel (Tomas Vondra, Matthias van de Meent)."* https://www.postgresql.org/docs/release/18.0/

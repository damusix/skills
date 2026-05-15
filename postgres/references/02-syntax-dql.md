# DQL Syntax — `SELECT`, Joins, Set Operations, `LIMIT`/`FETCH`


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The complete `SELECT` grammar](#the-complete-select-grammar)
    - [Target list — `SELECT` expressions](#target-list--select-expressions)
    - [`FROM` clause forms](#from-clause-forms)
    - [Join types — `INNER`, `LEFT`, `RIGHT`, `FULL`, `CROSS`, `NATURAL`](#join-types--inner-left-right-full-cross-natural)
    - [`USING` vs `ON` vs implicit cross-join](#using-vs-on-vs-implicit-cross-join)
    - [`LATERAL` subqueries and functions](#lateral-subqueries-and-functions)
    - [`WHERE` and subqueries (`EXISTS`, `IN`, `ANY`, `ALL`)](#where-and-subqueries-exists-in-any-all)
    - [`GROUP BY`, `HAVING`, and grouping-set extensions](#group-by-having-and-grouping-set-extensions)
    - [`DISTINCT` and `DISTINCT ON`](#distinct-and-distinct-on)
    - [`UNION`, `INTERSECT`, `EXCEPT`](#union-intersect-except)
    - [`ORDER BY` — `NULLS FIRST`/`LAST`, `USING operator`](#order-by--nulls-firstlast-using-operator)
    - [`LIMIT` / `OFFSET` / `FETCH FIRST ... WITH TIES`](#limit--offset--fetch-first--with-ties)
    - [`FOR UPDATE` / `FOR SHARE` row locking](#for-update--for-share-row-locking)
    - [`TABLESAMPLE` — `BERNOULLI` and `SYSTEM`](#tablesample--bernoulli-and-system)
    - [`WITH ORDINALITY` and `ROWS FROM`](#with-ordinality-and-rows-from)
    - [`VALUES` as a row source](#values-as-a-row-source)
    - [`TABLE` shorthand](#table-shorthand)
    - [`JSON_TABLE` (PG17+)](#json_table-pg17)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Load this file when the question involves:

- The structure of a `SELECT` statement: target list, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`
- Picking the right **join type** or rewriting a slow correlated subquery as a `LATERAL` join
- The difference between `USING` and `ON` and how each affects the output column list
- **`DISTINCT ON`** for "first row per group" queries
- Set operations and their default `DISTINCT` vs `ALL` semantics
- **`FETCH FIRST n ROWS WITH TIES`** (the SQL-standard cousin of `LIMIT`)
- **`NULLS FIRST`** / **`NULLS LAST`** placement under `ORDER BY ASC` and `DESC`
- The four flavors of row locking: `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`, plus `NOWAIT` / `SKIP LOCKED`
- `TABLESAMPLE` for fast statistical samples
- **`JSON_TABLE`** (PG17+) for shredding JSON into relational rows

For deep dives, route to the topical files: window functions ([`11-window-functions.md`](./11-window-functions.md)), aggregates and grouping sets in detail ([`12-aggregates-grouping.md`](./12-aggregates-grouping.md)), CTEs and recursive queries ([`04-ctes.md`](./04-ctes.md)), the locking taxonomy ([`43-locking.md`](./43-locking.md)), planner behavior ([`56-explain.md`](./56-explain.md)).


## Syntax / Mechanics



### The complete `SELECT` grammar


This is the full surface of `SELECT` as of PostgreSQL 16:[^select]

```sql
[ WITH [ RECURSIVE ] with_query [, ...] ]
SELECT [ ALL | DISTINCT [ ON ( expression [, ...] ) ] ]
    [ { * | expression [ [ AS ] output_name ] } [, ...] ]
    [ FROM from_item [, ...] ]
    [ WHERE condition ]
    [ GROUP BY [ ALL | DISTINCT ] grouping_element [, ...] ]
    [ HAVING condition ]
    [ WINDOW window_name AS ( window_definition ) [, ...] ]
    [ { UNION | INTERSECT | EXCEPT } [ ALL | DISTINCT ] select ]
    [ ORDER BY expression
        [ ASC | DESC | USING operator ]
        [ NULLS { FIRST | LAST } ] [, ...] ]
    [ LIMIT { count | ALL } ]
    [ OFFSET start [ ROW | ROWS ] ]
    [ FETCH { FIRST | NEXT } [ count ] { ROW | ROWS }
        { ONLY | WITH TIES } ]
    [ FOR { UPDATE | NO KEY UPDATE | SHARE | KEY SHARE }
        [ OF table_name [, ...] ]
        [ NOWAIT | SKIP LOCKED ] [...] ]
```

Logical evaluation order (independent of how you *write* the clauses) is:

    FROM → WHERE → GROUP BY → HAVING → SELECT (target list)
         → DISTINCT → UNION/INTERSECT/EXCEPT → ORDER BY → LIMIT/OFFSET

That order is why you cannot reference a `SELECT`-list alias from `WHERE` (it does not yet exist) but **can** reference it from `ORDER BY` (it does).[^lateral-section]


### Target list — `SELECT` expressions


```sql
-- Every column from a single source.
SELECT * FROM orders;

-- All columns from one specific FROM-item with table.* notation.
SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id;

-- Expressions, casts, aliases.
SELECT
    o.id,
    o.amount_cents / 100.0          AS amount_dollars,
    o.created_at::date              AS order_date,
    o.amount_cents > 10000          AS is_big_ticket
FROM orders o;

-- Bare aliases (the AS keyword is optional but recommended for clarity).
SELECT id "Order ID", amount_cents amt FROM orders;   -- legal but ugly
```

- Output aliases are visible to `ORDER BY` and (since PG, always) to the result-set column names — but **not** to `WHERE`, `GROUP BY`, or `HAVING`.
- Use **double-quoted identifiers** when an alias contains spaces or mixed case; otherwise PostgreSQL folds it to lowercase.
- A **subquery in the target list** (a "scalar subquery") must return at most one row and one column.

```sql
-- Scalar subquery: must return ≤ 1 row × 1 column.
SELECT
    c.id,
    c.name,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count
FROM customers c;
```

> [!WARNING] Scalar subquery cardinality
> If the inner query returns more than one row at runtime, you get `ERROR: more than one row returned by a subquery used as an expression`. Either add a `LIMIT 1` (only when you genuinely want any one row) or rewrite as a `LEFT JOIN ... GROUP BY` — the `LEFT JOIN` is almost always faster as well, because the planner can avoid the per-outer-row evaluation pattern that scalar subqueries imply.


### `FROM` clause forms


```sql
-- 1. A table (optionally with ONLY to skip inheritance children / partitions).
FROM orders
FROM ONLY orders                              -- only the parent, not partitions
FROM orders *                                 -- redundant; "*" is the historical "include children" marker

-- 2. A subquery (must be aliased).
FROM (SELECT id, amount_cents FROM orders WHERE created_at > now() - interval '7 days') o

-- 3. A function call.
FROM generate_series(1, 100) AS s(n)
FROM unnest(ARRAY['a','b','c']) AS letter
FROM jsonb_each(my_jsonb_col) AS j(k, v)

-- 4. A WITH-query reference.
WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days')
SELECT * FROM recent;

-- 5. A VALUES expression (synthetic rows).
FROM (VALUES (1,'a'), (2,'b'), (3,'c')) AS t(id, letter)

-- 6. ROWS FROM(...) (parallel columns from N functions, "zipped" row-wise).
FROM ROWS FROM (generate_series(1,3), generate_series(10,12)) AS r(a, b)
```

Every `FROM`-item can carry an alias (with optional column aliases), and the alias replaces the table name for the rest of the query:[^from-clause]

```sql
SELECT o.id, o.amount_cents
FROM orders AS o (id, customer_id, amount_cents, created_at)   -- column aliases
WHERE o.id = 1;
```

> [!NOTE]
> Subqueries and function calls in `FROM` **must** have an alias (in `psql` you'll see `ERROR: subquery in FROM must have an alias`). A plain table is the only `FROM`-item where the alias is optional.


### Join types — `INNER`, `LEFT`, `RIGHT`, `FULL`, `CROSS`, `NATURAL`


| Form | Behavior |
|---|---|
| `T1 [INNER] JOIN T2 ON cond` | Rows where `cond` is true. `INNER` is optional. |
| `T1 LEFT [OUTER] JOIN T2 ON cond` | All `T1`, NULL-pad `T2` when no match. |
| `T1 RIGHT [OUTER] JOIN T2 ON cond` | Mirror of `LEFT`. Avoid; flip the join order instead. |
| `T1 FULL [OUTER] JOIN T2 ON cond` | All rows from both sides, NULL-pad missing side. |
| `T1 CROSS JOIN T2` | Cartesian product. Equivalent to `T1, T2` and to `T1 INNER JOIN T2 ON TRUE`. |
| `T1 NATURAL JOIN T2` | `INNER JOIN` on every commonly-named column. Avoid (see Gotchas). |

```sql
-- INNER (the default)
SELECT o.id, c.name
FROM orders o
JOIN customers c ON c.id = o.customer_id;

-- LEFT — find orders without a customer row (data-quality probe)
SELECT o.id
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE c.id IS NULL;

-- FULL — for set difference / overlap queries
SELECT COALESCE(a.id, b.id) AS id,
       a.value AS value_left,
       b.value AS value_right
FROM table_a a
FULL JOIN table_b b USING (id);

-- CROSS — date-spine times region-spine
SELECT d.day, r.region
FROM generate_series(date '2026-01-01', date '2026-01-31', interval '1 day') AS d(day)
CROSS JOIN (VALUES ('US'),('EU'),('APAC')) AS r(region);
```

> [!NOTE]
> `RIGHT JOIN` is the mirror of `LEFT JOIN`. There is no execution-plan difference once the planner has its way with it, but `LEFT` is conventional — keep the "preserved" side on the left and your code will read more consistently.


### `USING` vs `ON` vs implicit cross-join


```sql
-- ON: the most general; the join columns appear once for each side.
SELECT o.id, o.customer_id, c.id AS c_id, c.name
FROM orders o JOIN customers c ON c.id = o.customer_id;
--                                       ↑↑↑↑     ↑↑↑↑↑
-- Both o.customer_id and c.id are in the output.

-- USING: only one column per join-key in the output (the "merged" column).
SELECT id, customer_id, name
FROM orders JOIN customers USING (id, customer_id);
--             ↑ the USING columns collapse to one each;
--             the rest are appended in left-then-right order

-- NATURAL: USING on every commonly-named column. AVOID.
SELECT * FROM orders NATURAL JOIN customers;

-- Implicit cross product (comma-separated) — equivalent to CROSS JOIN.
SELECT *
FROM orders, customers
WHERE customers.id = orders.customer_id;
```

> [!WARNING] `NATURAL JOIN` is a foot-gun
> `NATURAL JOIN` silently picks up any new commonly-named column when the schema changes (e.g. someone adds `created_at` to both tables and `NATURAL JOIN` starts joining on it too). Use explicit `USING (...)` or `ON ...`. Even Postgres committers will tell you not to use `NATURAL JOIN` in production code.

> [!WARNING] `WHERE` filters after the join; `ON` filters during it
> For `INNER JOIN` the two are interchangeable. For `OUTER JOIN` they are **not**:[^queries-table-exprs]
>
> ```sql
> -- ON: keeps the unmatched left rows and NULL-pads them.
> FROM a LEFT JOIN b ON (a.id = b.id AND b.val > 5)
>
> -- WHERE: silently turns the LEFT JOIN into an INNER JOIN, because the
> -- NULL-padded rows fail the b.val > 5 predicate and are filtered out.
> FROM a LEFT JOIN b ON (a.id = b.id) WHERE b.val > 5
> ```
>
> If you want the "match-condition-only" behavior on an outer join, the predicate **must** be in `ON`. If you want a post-join filter that also drops unmatched rows, you wanted an `INNER JOIN` to begin with.


### `LATERAL` subqueries and functions


`LATERAL` lets a `FROM`-item reference columns from `FROM`-items that appear earlier in the same `FROM` clause. Without `LATERAL`, sibling `FROM`-items cannot see each other's columns.[^lateral-section]

```sql
-- Top-3 most recent orders per customer.
SELECT c.id, recent.*
FROM customers c
CROSS JOIN LATERAL (
    SELECT id, amount_cents, created_at
    FROM orders
    WHERE customer_id = c.id      -- ← references c, only legal because of LATERAL
    ORDER BY created_at DESC
    LIMIT 3
) AS recent;

-- LATERAL with LEFT JOIN to keep customers who have zero orders.
SELECT c.id, recent.*
FROM customers c
LEFT JOIN LATERAL (
    SELECT id, amount_cents, created_at
    FROM orders
    WHERE customer_id = c.id
    ORDER BY created_at DESC
    LIMIT 3
) AS recent ON TRUE;

-- LATERAL is implicit for set-returning functions in FROM.
SELECT p.id, vertex
FROM polygons p, unnest(p.vertices) AS vertex;   -- LATERAL implied
```

When to reach for `LATERAL`:

- "Top-N rows per group" (single round of per-outer-row work)
- Calling a **set-returning function** (`unnest`, `jsonb_array_elements`, `regexp_matches`, ...) with arguments from an earlier table
- Re-using a complex per-row expression several times in `SELECT` (compute it once in a `LATERAL` subquery aliased `calc`, then reference `calc.foo`, `calc.bar`)

```sql
-- "Re-use a complex expression several times" pattern.
SELECT o.id,
       calc.gross,
       calc.tax,
       calc.gross + calc.tax AS total
FROM orders o
CROSS JOIN LATERAL (
    SELECT (o.amount_cents * 1.0)            AS gross,
           round(o.amount_cents * 0.0875, 0) AS tax
) AS calc;
```


### `WHERE` and subqueries (`EXISTS`, `IN`, `ANY`, `ALL`)


```sql
-- Plain WHERE predicates.
WHERE o.amount_cents > 10000
  AND o.created_at >= now() - interval '7 days'
  AND o.status IN ('paid','refunded')

-- EXISTS: typically the fastest pattern for "row exists in another table".
WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)

-- NOT EXISTS: NULL-safe anti-join (preferred form).
WHERE NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id)

-- IN with a list, IN with a subquery.
WHERE o.status IN ('paid','refunded')
WHERE o.customer_id IN (SELECT id FROM customers WHERE region = 'EU')

-- ANY / SOME / ALL (equivalent operators).
WHERE o.amount_cents = ANY (ARRAY[100, 200, 300])
WHERE o.amount_cents >= ALL (SELECT min_threshold FROM tiers WHERE active)
```

| Pattern | What it means | Notes |
|---|---|---|
| `x IN (list)` | `x = ANY (list)` | Fine for small static lists. |
| `x IN (subquery)` | `x = ANY (subquery)` | Planner usually rewrites to semi-join. |
| `x NOT IN (subquery)` | `NOT (x = ANY (subquery))` | **NULL-unsafe.** If the subquery yields any NULL, the whole expression is `UNKNOWN` and no rows match. |
| `EXISTS (subquery)` / `NOT EXISTS (subquery)` | Row-existence test | **NULL-safe.** Preferred for anti-joins. |
| `x = ANY (subquery)` | "Any one row matches `x`" | Semi-join. |
| `x = ALL (subquery)` | "Every row matches `x`" | Often degenerates into a `= MAX/MIN` check; usually clearer rewritten. |

> [!WARNING] Never use `NOT IN` with a subquery
> Use `NOT EXISTS` instead. Even if the column you are matching on is `NOT NULL` today, a future schema change can introduce a NULL and silently drop your result set to zero rows. `NOT EXISTS` is NULL-safe in every case and the planner can choose an anti-join.


### `GROUP BY`, `HAVING`, and grouping-set extensions


```sql
-- Basic grouping.
SELECT customer_id, COUNT(*) AS n, SUM(amount_cents) AS total
FROM orders
GROUP BY customer_id
HAVING SUM(amount_cents) > 100000;

-- GROUP BY can reference SELECT-list position or alias (the latter is a PG extension).
SELECT customer_id, COUNT(*) FROM orders GROUP BY 1;             -- position
SELECT customer_id AS cid, COUNT(*) FROM orders GROUP BY cid;    -- alias (PG-only)

-- GROUPING SETS — explicit multiple groupings in one pass.
SELECT region, product, SUM(qty)
FROM sales
GROUP BY GROUPING SETS ((region, product), (region), (product), ());

-- ROLLUP — n+1 successively shorter prefix groupings.
SELECT region, product, SUM(qty)
FROM sales
GROUP BY ROLLUP (region, product);
-- → groupings: (region,product), (region), ()

-- CUBE — 2^n groupings (the power set).
SELECT region, product, channel, SUM(qty)
FROM sales
GROUP BY CUBE (region, product, channel);
```

> [!NOTE] PostgreSQL 14
> **`GROUP BY DISTINCT`** removes duplicate grouping sets that are produced when you combine multiple `ROLLUP` / `CUBE` clauses. The release note: *"Allow `DISTINCT` to be added to `GROUP BY` to remove duplicate `GROUPING SET` combinations."*[^pg14-group-by-distinct]
>
> ```sql
> -- Without DISTINCT, ((a,b),(a),(),  (a,c),(a),()) — note (a) and () repeat.
> -- With DISTINCT, ((a,b),(a,c),(a),()).
> SELECT a, b, c, COUNT(*)
> FROM t
> GROUP BY DISTINCT ROLLUP(a,b), ROLLUP(a,c);
> ```
>
> This deduplicates **grouping sets**, not output rows. `SELECT DISTINCT` still applies to the projection.

Deep-dive coverage of `GROUPING(...)` and per-grouping-set NULL semantics lives in [`12-aggregates-grouping.md`](./12-aggregates-grouping.md).


### `DISTINCT` and `DISTINCT ON`


```sql
-- DISTINCT: remove duplicate output rows (across the entire SELECT list).
SELECT DISTINCT region FROM sales;

-- DISTINCT ON (cols): for each unique combination of (cols), keep the FIRST row
-- as defined by ORDER BY. The ORDER BY must start with the same columns.
SELECT DISTINCT ON (customer_id) customer_id, id, created_at
FROM orders
ORDER BY customer_id, created_at DESC;
-- → most-recent order per customer.
```

`DISTINCT ON` is a PostgreSQL extension (not SQL standard) but it is the **most efficient** "top-1 per group" pattern in PG when you also have a btree index on `(group_col, sort_col DESC)`. The alternative — a window function — almost always plans worse for top-1.

> [!WARNING] `DISTINCT ON` and `ORDER BY` must agree
> The leading `ORDER BY` keys **must** match the `DISTINCT ON` columns, in the same order. Otherwise the planner emits *"SELECT DISTINCT ON expressions must match initial ORDER BY expressions."* Add any additional tie-breaker columns *after* the DISTINCT-ON keys.


### `UNION`, `INTERSECT`, `EXCEPT`


All three combine the result sets of two `SELECT`s with identical column counts and compatible column types.

```sql
-- UNION: A or B, duplicates removed (DEFAULT). Slow on big sets.
SELECT id FROM customers_a UNION SELECT id FROM customers_b;

-- UNION ALL: A or B, duplicates kept. Fast — use this unless you specifically need dedup.
SELECT id FROM customers_a UNION ALL SELECT id FROM customers_b;

-- INTERSECT: rows in both A and B (default DISTINCT; INTERSECT ALL is the multiset variant).
SELECT id FROM customers_a INTERSECT SELECT id FROM customers_b;

-- EXCEPT: rows in A but not B (default DISTINCT; EXCEPT ALL is multiset).
SELECT id FROM customers_a EXCEPT SELECT id FROM customers_b;
```

Precedence: `INTERSECT` binds tighter than `UNION` / `EXCEPT`. Parenthesize when in doubt.[^select]

```sql
-- ORDER BY / LIMIT apply to the *combined* result; place them at the very end.
( SELECT id, name FROM customers_a
  UNION ALL
  SELECT id, name FROM customers_b )
ORDER BY id
LIMIT 100;
```

> [!NOTE]
> PostgreSQL does not implement the SQL-standard `CORRESPONDING` clause for set operations.[^select] Column matching is strictly positional. Reorder columns yourself when the two sides have different layouts.

The default is `DISTINCT` for all three set operators. Explicitly writing `UNION DISTINCT` is legal as of PG, but conventional code writes plain `UNION`; explicitly writing `UNION ALL` is the customary way to *opt in* to duplicates.


### `ORDER BY` — `NULLS FIRST`/`LAST`, `USING operator`


```sql
ORDER BY created_at DESC
ORDER BY amount_cents DESC NULLS LAST
ORDER BY customer_id, created_at DESC NULLS FIRST
ORDER BY name COLLATE "en_US"
ORDER BY some_expression USING <      -- sort with the < operator of the column's type
ORDER BY 1, 2 DESC                    -- by SELECT-list position (legal but discouraged)
```

| Direction | Default `NULLS` placement |
|---|---|
| `ASC` (or implicit) | `NULLS LAST` |
| `DESC` | `NULLS FIRST` |

This default makes NULLs appear "at the end of the natural order for an ascending sort and at the start of a descending sort," which is rarely what application code wants — application code almost always wants NULLs at the bottom. **Spell out `NULLS LAST` explicitly when ordering DESC with a column that may be NULL.**[^select]

```sql
-- Common mistake: silently NULLs-first.
SELECT name FROM users ORDER BY last_login_at DESC;

-- Almost always what you actually meant:
SELECT name FROM users ORDER BY last_login_at DESC NULLS LAST;
```

`ORDER BY` is the only clause where SELECT-list aliases are visible and where positional references are allowed. Use named expressions in production code — positions silently re-map when you change the target list.


### `LIMIT` / `OFFSET` / `FETCH FIRST ... WITH TIES`


PostgreSQL accepts two equivalent forms for paging:[^select]

```sql
-- PostgreSQL form (always available; SQL-standard FETCH form is preferred for new code).
SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100;

-- SQL:2008 form. Equivalent.
SELECT * FROM orders ORDER BY id
OFFSET 100 ROWS
FETCH NEXT 20 ROWS ONLY;
```

> [!NOTE] PostgreSQL 13
> **`FETCH FIRST n ROWS WITH TIES`** returns the first *n* rows *plus* any additional rows that tie with the last returned row on the `ORDER BY` keys.[^pg13-with-ties]
>
> ```sql
> SELECT * FROM orders ORDER BY amount_cents DESC
> FETCH FIRST 5 ROWS WITH TIES;
> -- Returns at least 5 rows; if rows 5, 6, 7 all have the same amount_cents,
> -- all three are included.
> ```
>
> `WITH TIES` requires an `ORDER BY` and is incompatible with `SKIP LOCKED`.[^select]

Use `LIMIT n` for the common case and `FETCH FIRST n ROWS WITH TIES` when you need stable inclusion of tied-on-key rows (leaderboards, top-K rankings).

> [!WARNING] Deep-OFFSET pagination is anti-scaling
> `LIMIT 20 OFFSET 100000` makes the database scan and discard 100,000 rows. Use **keyset pagination** instead:
>
> ```sql
> -- Page boundary: pass the last (created_at, id) tuple from the previous page.
> SELECT * FROM orders
> WHERE (created_at, id) < (:last_created_at, :last_id)
> ORDER BY created_at DESC, id DESC
> LIMIT 20;
> ```
>
> With an index on `(created_at DESC, id DESC)` this is constant-time per page regardless of depth.


### `FOR UPDATE` / `FOR SHARE` row locking


Row-level locking attached to a `SELECT` declares the intent of the surrounding transaction to lock the returned rows. The variants are:

| Clause | Lock strength | Conflicts with |
|---|---|---|
| `FOR UPDATE` | Strongest; locks the row for any modification. | `FOR KEY SHARE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR UPDATE`. |
| `FOR NO KEY UPDATE` | Weaker `UPDATE` that promises not to change a key column. Acquired implicitly by plain `UPDATE` that doesn't change a key. | `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR UPDATE`. |
| `FOR SHARE` | Read-lock; prevents others from `UPDATE`ing the row. | `FOR NO KEY UPDATE`, `FOR UPDATE`. |
| `FOR KEY SHARE` | Weakest; acquired by foreign-key checks; blocks key changes but not non-key updates. | `FOR UPDATE`. |

Modifiers:

- `NOWAIT` — fail immediately with `ERROR: could not obtain lock on row in relation "..."` if the lock can't be taken at once.
- `SKIP LOCKED` — silently skip rows whose row-level lock is held by another transaction. The canonical pattern for "claim work from a queue table."

```sql
-- Worker claims up to 10 jobs at a time without blocking on jobs claimed by other workers.
BEGIN;

SELECT id, payload
FROM jobs
WHERE status = 'queued'
ORDER BY created_at
LIMIT 10
FOR UPDATE SKIP LOCKED;

-- ... do the work, then ...

UPDATE jobs SET status = 'done' WHERE id = ANY (:claimed_ids);
COMMIT;
```

`SKIP LOCKED` and `NOWAIT` are mutually exclusive with `WITH TIES`. The full table-level + row-level lock interaction matrix lives in [`43-locking.md`](./43-locking.md).


### `TABLESAMPLE` — `BERNOULLI` and `SYSTEM`


`TABLESAMPLE` returns a random sample of a base table. Two built-in methods are provided:[^select]

| Method | What it samples | Speed | Sample-size variance |
|---|---|---|---|
| `BERNOULLI(p)` | Each *row* with probability `p%`. | O(table size). | Low. |
| `SYSTEM(p)` | Each *page* with probability `p%` (all rows on the chosen pages). | O(table size × p). Much faster on big tables. | Higher (clustered). |

```sql
-- ~1% sample by row (more accurate, slow).
SELECT * FROM big_table TABLESAMPLE BERNOULLI (1);

-- ~1% sample by page (less accurate, fast).
SELECT * FROM big_table TABLESAMPLE SYSTEM (1);

-- Reproducible sample.
SELECT * FROM big_table TABLESAMPLE BERNOULLI (1) REPEATABLE (42);
```

Use `SYSTEM` for quick "give me roughly 1 % of the table" exploratory queries; use `BERNOULLI` when distribution accuracy matters (e.g. estimating per-customer aggregates). Both methods only work on **base tables**, not on the output of joins or subqueries.

> [!NOTE]
> The `tsm_system_rows` and `tsm_system_time` contrib extensions add `SYSTEM_ROWS(n)` and `SYSTEM_TIME(ms)` sampling methods — useful when you want "approximately *n* rows" or "approximately *t* milliseconds of sampling," not a percentage.


### `WITH ORDINALITY` and `ROWS FROM`


```sql
-- Per-row index of a set-returning function.
SELECT * FROM unnest(ARRAY['a','b','c']) WITH ORDINALITY AS t(value, idx);
-- value | idx
-- ------+----
-- a     | 1
-- b     | 2
-- c     | 3

-- ROWS FROM — zip multiple set-returning functions side by side.
SELECT * FROM ROWS FROM (
    generate_series(1, 3),
    unnest(ARRAY['a','b','c'])
) AS t(num, letter);
-- num | letter
-- ----+-------
--   1 | a
--   2 | b
--   3 | c
```

`ROWS FROM` pads shorter inputs with NULLs to match the longest input. `WITH ORDINALITY` then numbers the combined rows. Use these for stable correlated unrolling of array columns or paired JSON arrays without an explicit join.


### `VALUES` as a row source


```sql
-- VALUES as a stand-alone statement.
VALUES (1, 'a'), (2, 'b'), (3, 'c');

-- VALUES as a FROM-item (must be aliased).
SELECT v.id, v.label
FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS v(id, label);

-- VALUES as a join lookup.
SELECT o.id, o.status, label.text
FROM orders o
LEFT JOIN (VALUES ('p','pending'), ('a','approved'), ('r','rejected')) AS label(code, text)
       ON label.code = o.status;
```

`VALUES` lists are extremely cheap to plan (no statistics, no I/O) and the planner sees them as a sequential scan over an in-memory table. They are the right tool for hard-coded reference data inside a query.


### `TABLE` shorthand


`TABLE foo` is shorthand for `SELECT * FROM foo`:

```sql
TABLE orders;                          -- equivalent to: SELECT * FROM orders
TABLE ONLY orders;                     -- exclude inheritance children / partitions

-- Useful in set operations:
TABLE customers_a UNION ALL TABLE customers_b;
```

Rarely used in application code, but it shows up in scripts and you should recognize it.


### `JSON_TABLE` (PG17+)


> [!NOTE] PostgreSQL 17
> **`JSON_TABLE`** shreds a JSON document into a relational result set in a single query. It implements the SQL/JSON standard and replaces ad-hoc patterns built from `jsonb_to_recordset`, `jsonb_array_elements`, and `LATERAL` joins.[^pg17-json-table]

```sql
-- Sample document: an array of orders, each with an array of items.
WITH docs(doc) AS (VALUES (
'{
  "orders": [
    {"id": 1, "items": [{"sku":"A","qty":2}, {"sku":"B","qty":1}]},
    {"id": 2, "items": [{"sku":"C","qty":5}]}
  ]
}'::jsonb))
SELECT j.*
FROM docs,
     JSON_TABLE(
         doc,
         '$.orders[*]' AS root
         COLUMNS (
             order_id  int     PATH '$.id',
             NESTED PATH '$.items[*]'
                 COLUMNS (
                     sku   text PATH '$.sku',
                     qty   int  PATH '$.qty',
                     line  FOR ORDINALITY
                 )
         )
     ) AS j;
-- order_id | sku | qty | line
-- ---------+-----+-----+------
--        1 | A   |   2 | 1
--        1 | B   |   1 | 2
--        2 | C   |   5 | 1
```

Use `JSON_TABLE` when you would otherwise nest two or three `jsonb_array_elements` + `LATERAL` joins. It is concise, the planner understands it natively, and (where possible) it pushes path evaluation down into the row-shredding step.

Full coverage of JSON path operators (`->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `jsonb_path_query`, `jsonb_path_exists`, etc.) is in [`17-json-jsonb.md`](./17-json-jsonb.md).


## Examples / Recipes


### Top-N per group (`DISTINCT ON` vs `LATERAL` vs window)


```sql
-- A. DISTINCT ON — fastest for N = 1, single-pass.
SELECT DISTINCT ON (customer_id)
    customer_id, id, amount_cents, created_at
FROM orders
ORDER BY customer_id, created_at DESC;

-- B. LATERAL — most flexible; handles N > 1 cleanly.
SELECT c.id AS customer_id, r.*
FROM customers c
CROSS JOIN LATERAL (
    SELECT id, amount_cents, created_at
    FROM orders
    WHERE customer_id = c.id
    ORDER BY created_at DESC
    LIMIT 3
) AS r;

-- C. Window function — readable, but materializes the full join then filters.
SELECT customer_id, id, amount_cents, created_at
FROM (
    SELECT customer_id, id, amount_cents, created_at,
           row_number() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
    FROM orders
) s
WHERE rn <= 3;
```

For the index `CREATE INDEX ON orders (customer_id, created_at DESC)`, options A and B both use an index-only walk and short-circuit early; option C reads every row before filtering. Pick (A) for N = 1, (B) for small N.


### Anti-join: `NOT EXISTS` vs `LEFT JOIN ... IS NULL` vs `NOT IN`

See the comparison table and SQL examples in the [WHERE and subqueries](#where-and-subqueries-exists-in-any-all) section. Use `NOT EXISTS` — it is NULL-safe and the planner picks an anti-join. Never use `NOT IN` with a subquery.


### Set-difference for data-quality checks


```sql
-- Rows in staging that didn't make it to production (and vice versa).
( SELECT id FROM stage.orders EXCEPT SELECT id FROM prod.orders )
UNION ALL
( SELECT id FROM prod.orders EXCEPT SELECT id FROM stage.orders );

-- Row-level diff (every column equal).
SELECT row_to_json(s.*) AS only_in_stage
FROM stage.orders s
WHERE NOT EXISTS (
    SELECT 1 FROM prod.orders p
    WHERE p.id = s.id
      AND p.amount_cents IS NOT DISTINCT FROM s.amount_cents
      AND p.status        IS NOT DISTINCT FROM s.status
);
```

`IS NOT DISTINCT FROM` is the NULL-safe `=` operator; use it whenever you compare nullable columns.


### Sampling: rough `COUNT(DISTINCT)` estimation


```sql
-- Estimate distinct customer_id values cheaply on a giant table.
SELECT COUNT(DISTINCT customer_id) * 100 AS est_distinct
FROM events TABLESAMPLE SYSTEM (1);

-- HLL via the hll extension is much more accurate but requires the extension.
```


### Keyset pagination (deep-paging without `OFFSET`)


```sql
-- First page.
SELECT id, created_at, amount_cents
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- Subsequent page: pass the (created_at, id) tuple of the LAST row of the previous page.
SELECT id, created_at, amount_cents
FROM orders
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

Index: `CREATE INDEX ON orders (created_at DESC, id DESC)`. This is O(log n + 50) per page regardless of depth. Compare with `OFFSET 100000` which is O(100050).


### Stable random ordering for fixed-seed exploration


```sql
-- One-shot random sample (different each call).
SELECT * FROM orders ORDER BY random() LIMIT 100;

-- Reproducible random sample using setseed + random().
BEGIN;
SELECT setseed(0.42);
SELECT * FROM orders ORDER BY random() LIMIT 100;
COMMIT;

-- For sampling much larger tables, prefer TABLESAMPLE BERNOULLI with REPEATABLE.
SELECT * FROM orders TABLESAMPLE BERNOULLI (0.1) REPEATABLE (42) LIMIT 100;
```


### `LATERAL` recipe: parameterized SRF


```sql
-- For each user, find the 10 most-similar users by trigram similarity of names.
SELECT u.id, sim.peer_id, sim.score
FROM users u
CROSS JOIN LATERAL (
    SELECT peer.id AS peer_id, similarity(u.name, peer.name) AS score
    FROM users peer
    WHERE peer.id <> u.id
    ORDER BY u.name <-> peer.name      -- requires pg_trgm
    LIMIT 10
) AS sim;
```

Without `LATERAL`, this requires a per-user PL/pgSQL loop or a window-function plan over the full cross-join. With `LATERAL` plus a GiST index on `users(name gist_trgm_ops)` the inner query is a top-10 index scan per outer row.


### `JSON_TABLE` recipe — invoice shredding (PG17+)


```sql
WITH inv(doc) AS (
  VALUES (
    '{"invoice_id": "INV-7", "items": [
        {"sku":"A","qty":2,"price_cents":1500},
        {"sku":"B","qty":1,"price_cents":4000}
      ]}'::jsonb)
)
SELECT t.*
FROM inv,
     JSON_TABLE(
         doc, '$' AS root
         COLUMNS (
             invoice_id text PATH '$.invoice_id',
             NESTED PATH '$.items[*]'
                 COLUMNS (
                     sku         text PATH '$.sku',
                     qty         int  PATH '$.qty',
                     price_cents int  PATH '$.price_cents',
                     line_no     FOR ORDINALITY
                 )
         )
     ) AS t;
```

Before PG17 the same job needed `jsonb_to_recordset` plus `LATERAL jsonb_array_elements` plus column extraction:

```sql
-- Pre-PG17 equivalent.
SELECT
    doc ->> 'invoice_id'              AS invoice_id,
    item ->> 'sku'                    AS sku,
    (item ->> 'qty')::int             AS qty,
    (item ->> 'price_cents')::int     AS price_cents,
    line_no
FROM inv,
     LATERAL jsonb_array_elements(doc -> 'items') WITH ORDINALITY AS it(item, line_no);
```


### Worker-queue claim with `FOR UPDATE SKIP LOCKED`


```sql
-- One worker, one transaction. Many workers running this concurrently will not block one another.
BEGIN;

WITH next AS (
    SELECT id
    FROM jobs
    WHERE status = 'queued'
      AND run_after <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE jobs
SET status = 'running', started_at = now()
WHERE id = (SELECT id FROM next)
RETURNING id, payload;

-- ... worker does its thing using the returned id+payload ...

COMMIT;
```

`FOR UPDATE SKIP LOCKED` is the canonical pattern for backend job queues in PostgreSQL. It scales to hundreds of concurrent workers on a single table without coordination.


### Per-customer running total via correlated `LATERAL`


```sql
-- Without LATERAL: window function (preferred when you need it across all rows).
SELECT id, customer_id, amount_cents,
       SUM(amount_cents) OVER (PARTITION BY customer_id ORDER BY created_at) AS running_total
FROM orders;

-- With LATERAL: useful when you only need running total for a *subset* of rows.
SELECT o.id, o.customer_id, o.amount_cents, r.running_total
FROM orders o
CROSS JOIN LATERAL (
    SELECT SUM(amount_cents) AS running_total
    FROM orders o2
    WHERE o2.customer_id = o.customer_id
      AND o2.created_at  <= o.created_at
) AS r
WHERE o.id IN (SELECT id FROM flagged_orders);
```


## Gotchas / Anti-patterns


- **`NOT IN` with a subquery is NULL-unsafe.** Always use `NOT EXISTS` instead. A single NULL in the subquery yields zero rows. See also the DML-side NULL handling in [`03-syntax-dml.md`](./03-syntax-dml.md).
- **`NATURAL JOIN` silently changes meaning when columns are added.** Use explicit `USING(...)` or `ON ...`.
- **`WHERE` after a `LEFT JOIN` collapses it into an `INNER JOIN`.** Predicates on the nullable side must go in `ON` to preserve unmatched rows.
- **Default `NULLS` placement is direction-sensitive.** `ASC` → `NULLS LAST`, `DESC` → `NULLS FIRST`. Production code should specify the placement explicitly any time the column is nullable.
- **`DISTINCT ON` requires its keys at the front of `ORDER BY`.** "SELECT DISTINCT ON expressions must match initial ORDER BY expressions" is the error you get otherwise.
- **`SELECT DISTINCT` is not free.** It implies a sort or hash aggregation. If you can dedup at write time (a unique constraint) or know your join is already 1:1, omit `DISTINCT`.
- **`OFFSET` does not skip the work, it just discards rows.** Deep-paging via `OFFSET` is O(offset). Use keyset pagination for any page beyond the first dozen.
- **Scalar subqueries that fan out crash at runtime, not plan time.** Always rewrite as `LEFT JOIN ... GROUP BY` when there's any chance the inner query can produce more than one row.
- **`UNION` deduplicates; `UNION ALL` does not.** The default is `UNION` (= `DISTINCT`). On large sets that's a sort or hash you may not have wanted.
- **Set-operation column matching is positional, not by name.** Reorder columns in the second `SELECT` if the source-of-truth layouts differ.
- **`FOR UPDATE` on a `LEFT JOIN` locks only the rows from the FROM-list table named in `OF`.** Plain `FOR UPDATE` locks all rows from all base tables in `FROM`, including the right side of `LEFT JOIN`s; that often surprises developers who only meant to lock the primary table. Use `FOR UPDATE OF mytable` to scope.
- **`SELECT *` in views is fragile.** When the underlying table gains a column, the view's stored column list does not auto-update — you'll need a `CREATE OR REPLACE VIEW ...` (or `DROP` + recreate) to pick it up. See [`05-views.md`](./05-views.md).
- **`OFFSET` and `LIMIT` are applied *after* `ORDER BY`, which is applied *after* set operations.** That means `ORDER BY` / `LIMIT` belong at the very end of a `UNION` chain; if you want per-`SELECT` ordering you need parentheses + a wrapping query.
- **`FOR UPDATE` cannot be combined with aggregates, `DISTINCT`, `GROUP BY`, `HAVING`, `WINDOW`, `UNION`/`INTERSECT`/`EXCEPT`, or a `LIMIT/OFFSET` that follows them.** PG will reject these combinations: locking applies to specific source rows, and those clauses make the row identity ambiguous.
- **`WITH TIES` is incompatible with `SKIP LOCKED`.** Pick one.
- **Aliases in `SELECT` are visible to `ORDER BY` but not to `WHERE`, `GROUP BY`, or `HAVING`.** Repeat the expression in those clauses or wrap with a subquery.


## See Also


- [`03-syntax-dml.md`](./03-syntax-dml.md) — `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `RETURNING`, `ON CONFLICT`
- [`04-ctes.md`](./04-ctes.md) — `WITH`, `WITH RECURSIVE`, `MATERIALIZED` / `NOT MATERIALIZED`, `SEARCH` / `CYCLE`
- [`05-views.md`](./05-views.md) — views and materialized views built on `SELECT`
- [`11-window-functions.md`](./11-window-functions.md) — `OVER`, frame clauses, named `WINDOW`
- [`12-aggregates-grouping.md`](./12-aggregates-grouping.md) — `FILTER`, `GROUPING SETS` / `ROLLUP` / `CUBE`, ordered-set and hypothetical-set aggregates
- [`17-json-jsonb.md`](./17-json-jsonb.md) — `JSON_TABLE`, SQL/JSON path language, JSON operators
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — what `FOR UPDATE` actually locks at the tuple level
- [`20-text-search.md`](./20-text-search.md) — `tsvector`, `tsquery`, full-text search operators used in `SELECT`
- [`35-partitioning.md`](./35-partitioning.md) — `FROM ONLY` semantics and partition pruning in queries
- [`43-locking.md`](./43-locking.md) — full conflict matrix for row-level lock modes
- [`56-explain.md`](./56-explain.md) — reading the plan a `SELECT` produces
- [`69-extensions.md`](./69-extensions.md) — `tsm_system_rows` / `tsm_system_time` sampling method extensions


## Sources


[^select]: SQL command reference for `SELECT` (PG16). Full grammar including `WITH`, `WINDOW`, `FETCH FIRST ... WITH TIES`, `FOR ... SKIP LOCKED`, `TABLESAMPLE`, set-operation precedence, and the explicit note that PostgreSQL does not implement the SQL standard's `CORRESPONDING` clause. https://www.postgresql.org/docs/16/sql-select.html

[^from-clause]: "FROM Clause" — table expressions, aliases, `ONLY`, function-call FROM items, `WITH ORDINALITY`, `ROWS FROM`, `TABLESAMPLE`. https://www.postgresql.org/docs/16/queries-table-expressions.html

[^queries-table-exprs]: Same chapter: joined tables, the difference between `ON` and `WHERE` for outer joins, `NATURAL JOIN`, `CROSS JOIN`. https://www.postgresql.org/docs/16/queries-table-expressions.html

[^lateral-section]: "LATERAL Subqueries" section in the queries chapter — explains the lateral-reference rules and why `LATERAL` is implicit for set-returning functions in `FROM`. https://www.postgresql.org/docs/16/queries-table-expressions.html#QUERIES-LATERAL

[^pg13-with-ties]: PostgreSQL 13 release notes: *"Allow `FETCH FIRST` to use `WITH TIES` to return any additional rows that match the last result row (Surafel Temesgen)."* https://www.postgresql.org/docs/release/13.0/

[^pg14-group-by-distinct]: PostgreSQL 14 release notes: *"Allow `DISTINCT` to be added to `GROUP BY` to remove duplicate `GROUPING SET` combinations (Vik Fearing). For example, `GROUP BY CUBE (a,b), CUBE (b,c)` will generate duplicate grouping combinations without `DISTINCT`."* https://www.postgresql.org/docs/release/14.0/

[^pg17-json-table]: `JSON_TABLE` documented in the JSON functions chapter for PG17. Same shape applies in PG18. https://www.postgresql.org/docs/17/functions-json.html

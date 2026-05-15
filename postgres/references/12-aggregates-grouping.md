# Aggregates and Grouping

The full `agg(...)` grammar (`DISTINCT`, `ORDER BY` inside the call, `FILTER`, `WITHIN GROUP`), the catalog of built-in general / statistical / ordered-set / hypothetical-set aggregates, `GROUP BY` mechanics including `GROUPING SETS` / `ROLLUP` / `CUBE` / `GROUP BY DISTINCT`, the `GROUPING()` function, `HAVING`, parallel and pre-sorted aggregation, and `CREATE AGGREGATE` for user-defined aggregates.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model: Four Aggregate Classes](#mental-model-four-aggregate-classes)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Aggregate Call Grammar](#aggregate-call-grammar)
    - [ORDER BY Inside an Aggregate](#order-by-inside-an-aggregate)
    - [DISTINCT Inside an Aggregate](#distinct-inside-an-aggregate)
    - [FILTER (WHERE ...) Clause](#filter-where--clause)
    - [Catalog of General-Purpose Aggregates](#catalog-of-general-purpose-aggregates)
    - [Statistical Aggregates](#statistical-aggregates)
    - [Ordered-Set Aggregates (`WITHIN GROUP`)](#ordered-set-aggregates-within-group)
    - [Hypothetical-Set Aggregates](#hypothetical-set-aggregates)
    - [GROUP BY, HAVING, and Evaluation Order](#group-by-having-and-evaluation-order)
    - [GROUPING SETS, ROLLUP, CUBE](#grouping-sets-rollup-cube)
    - [`GROUP BY DISTINCT`](#group-by-distinct)
    - [The `GROUPING()` Function](#the-grouping-function)
    - [NULL Semantics in Aggregates](#null-semantics-in-aggregates)
    - [Parallel and Pre-Sorted Aggregation](#parallel-and-pre-sorted-aggregation)
    - [Reading Aggregate Plans in EXPLAIN](#reading-aggregate-plans-in-explain)
    - [CREATE AGGREGATE — User-Defined Aggregates](#create-aggregate--user-defined-aggregates)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- Writing any query with `GROUP BY`, `HAVING`, or an aggregate function in the `SELECT` list.
- Picking between `FILTER (WHERE ...)` and `CASE WHEN ... THEN ... END` inside an aggregate.
- Computing percentiles or median (`percentile_cont`, `percentile_disc`, `mode`).
- Producing subtotals or grand totals via `GROUPING SETS`, `ROLLUP`, or `CUBE`.
- Using `string_agg` or `array_agg` and the output order matters.
- Reading an `EXPLAIN` plan that contains `HashAggregate` / `GroupAggregate` / `Partial Aggregate` / `Finalize Aggregate` / `MixedAggregate`.
- Defining a `CREATE AGGREGATE` (state-machine transition function, optional final function, optional combine function for parallel).
- Diagnosing why `count(DISTINCT col)` is slow (it disables parallel aggregation).

Aggregates used as **window functions** (`sum(x) OVER (...)`) are covered in [`11-window-functions.md`](./11-window-functions.md). Most of the mechanics here (DISTINCT inside, ORDER BY inside, FILTER) **do** apply, with the additional restriction that `DISTINCT` and `ORDER BY` inside the aggregate are illegal when the aggregate is a window call (see Gotcha 9).

## Mental Model: Four Aggregate Classes

PostgreSQL aggregates fall into four grammatical and semantic classes. Picking the right one in the docs starts with knowing which class you need.[^agg-builtin]

| Class | Call shape | Examples | Key constraint |
|---|---|---|---|
| **General-purpose** | `agg(expr [, ...])` | `count`, `sum`, `avg`, `min`, `max`, `array_agg`, `string_agg`, `bool_and`, `jsonb_agg`, `range_agg`, `any_value` | Most can be window functions, parallelized, and used with `FILTER`/`DISTINCT`/`ORDER BY`. |
| **Statistical** | `agg(Y, X)` or `agg(expr)` | `corr`, `covar_*`, `regr_*`, `stddev_*`, `var_*` | Two-argument regression aggregates take `(Y, X)` not `(X, Y)`. Skip rows where either input is NULL. |
| **Ordered-set** | `agg([direct_args]) WITHIN GROUP (ORDER BY sort_args)` | `percentile_cont`, `percentile_disc`, `mode` | Cannot be used as window functions. No partial / parallel aggregation. Direct args are evaluated **once per group**, not once per row.[^create-aggregate] |
| **Hypothetical-set** | `agg(probe_args) WITHIN GROUP (ORDER BY sort_args)` | `rank`, `dense_rank`, `percent_rank`, `cume_dist` | Subclass of ordered-set. Probe-arg types must match sort-arg types one-for-one. Treats the probe row as an additional hypothetical row to compute its rank against. |

A general aggregate is a stateful fold over rows; an ordered-set aggregate is a fold over rows sorted by an explicit key; a hypothetical-set aggregate asks "where would this row land in the sorted group?".

## Syntax / Mechanics

### Aggregate Call Grammar

The five legal aggregate-call forms (verbatim from `sql-expressions.html`):[^sql-expressions]

1. `aggregate_name(expression [, ...] [order_by_clause]) [FILTER (WHERE filter_clause)]`
2. `aggregate_name(ALL expression [, ...] [order_by_clause]) [FILTER (WHERE filter_clause)]`
3. `aggregate_name(DISTINCT expression [, ...] [order_by_clause]) [FILTER (WHERE filter_clause)]`
4. `aggregate_name(*) [FILTER (WHERE filter_clause)]`
5. `aggregate_name([expression [, ...]]) WITHIN GROUP (order_by_clause) [FILTER (WHERE filter_clause)]`

Form 4 (`agg(*)`) is reserved for `count(*)`. Form 5 is reserved for ordered-set and hypothetical-set aggregates and requires the aggregate to be defined that way (you cannot use `WITHIN GROUP` with `sum` or `avg`).

`ALL` is the default; `count(ALL x)` is equivalent to `count(x)`.

### ORDER BY Inside an Aggregate

For order-sensitive aggregates (`array_agg`, `string_agg`, `json_agg`, `jsonb_agg`, `xmlagg`, `json_object_agg` and the `_strict` / `_unique` variants), the output depends on the order in which rows are fed in. Spell the order out:

    SELECT string_agg(name, ', ' ORDER BY name) FROM employees;

The `ORDER BY` goes **after** all regular arguments, not interleaved:

    SELECT string_agg(a, ',' ORDER BY a) FROM t;    -- correct
    SELECT string_agg(a ORDER BY a, ',') FROM t;    -- WRONG: parses ORDER BY a, ',' as a two-key sort

Verbatim from the docs: *"When dealing with multiple-argument aggregate functions, note that the `ORDER BY` clause goes after all the aggregate arguments."*[^sql-expressions]

Without an explicit `ORDER BY`, the order of inputs is **unspecified** — it depends on the chosen plan and is not stable across runs. Tests that pass today break tomorrow when the planner chooses a hash aggregate instead of a sort-based one.

> [!NOTE] PostgreSQL 16
> The planner can now use **pre-sorted data** to skip the in-aggregate sort: *"Add the ability for aggregates having `ORDER BY` or `DISTINCT` to use pre-sorted data"* (controlled by `enable_presorted_aggregate`).[^pg16-presorted] In practice this means an index that already orders by `(group_col, sort_col)` lets `string_agg(... ORDER BY sort_col)` run without a separate sort node.

### DISTINCT Inside an Aggregate

`agg(DISTINCT expr)` deduplicates **before** the aggregate sees the values:

    SELECT count(DISTINCT user_id) FROM events WHERE day = CURRENT_DATE;

Two crucial constraints:

1. **`DISTINCT` disables parallel aggregation** for that aggregate call. The planner cannot split distinct deduplication across workers without seeing every value, so it falls back to a serial plan. If `count(DISTINCT)` is hot, pre-aggregate distincts in a CTE or window first (see [Recipe 11](#recipe-11-faster-count-distinct-via-pre-deduplication)).
2. **`DISTINCT` + `ORDER BY` constraint**: *"If `DISTINCT` is specified in addition to an order_by_clause, then all the `ORDER BY` expressions must match regular arguments of the aggregate; that is, you cannot sort on an expression that is not included in the `DISTINCT` list."*[^sql-expressions]

That means this is legal:

    SELECT array_agg(DISTINCT name ORDER BY name) FROM users;

But this is not — `surname` is not in the DISTINCT key:

    SELECT array_agg(DISTINCT name ORDER BY surname) FROM users;   -- error

### FILTER (WHERE ...) Clause

`FILTER (WHERE cond)` restricts the rows that contribute to a single aggregate call without restricting the rest of the row set. Use it to compute several conditional aggregates over the same scan:

    SELECT
      count(*)                                            AS total_events,
      count(*) FILTER (WHERE kind = 'click')              AS clicks,
      count(*) FILTER (WHERE kind = 'view')              AS views,
      avg(latency_ms) FILTER (WHERE ok)                   AS p_avg_ok,
      sum(amount) FILTER (WHERE refunded IS FALSE)        AS net_revenue
    FROM events
    WHERE day = CURRENT_DATE;

This is strictly preferable to `CASE WHEN ... END` for almost every conditional-aggregate use case:

- `sum(CASE WHEN refunded IS FALSE THEN amount END)` — works but loops through every row materializing a `CASE` expression.
- `sum(amount) FILTER (WHERE refunded IS FALSE)` — the planner can short-circuit; signals intent clearly.

The only case where `CASE WHEN` is still needed is when you want to **substitute** a value, not just exclude rows (e.g., `sum(CASE WHEN ok THEN amount ELSE 0 END)` — but `coalesce(sum(amount) FILTER (WHERE ok), 0)` does the same job).

`FILTER` works with all aggregate classes (general, statistical, ordered-set, hypothetical-set). When an aggregate is used as a window function, `FILTER` is **legal for true aggregates** (`sum`, `count`, …) but **illegal for pure window functions** (`row_number`, `rank`, `lag`, …) — see [`11-window-functions.md`](./11-window-functions.md) Gotcha 8.

### Catalog of General-Purpose Aggregates

All entries below support `FILTER`, `DISTINCT`, and `ORDER BY` (the last is only meaningful for order-sensitive ones). The "Partial" column from the docs marks whether the aggregate participates in parallel / partial aggregation.[^agg-builtin]

| Function | Signature | Notes |
|---|---|---|
| `count(*)` | → `bigint` | Counts all rows in the group, including those with NULL columns. |
| `count(expr)` | → `bigint` | Counts rows where `expr IS NOT NULL`. |
| `sum(expr)` | numeric/int/interval/money | Returns NULL (not 0) on empty input. |
| `avg(expr)` | numeric inputs | Returns NULL on empty input. |
| `min(expr)` / `max(expr)` | comparable types | Skip NULLs. > [!NOTE] PostgreSQL 18 — `MIN()`/`MAX()` now work on arrays and composite types directly.[^pg18-minmax-arrays] |
| `any_value(expr)` | same as input | Returns an arbitrary non-NULL value. Useful when grouping by a key and you want one row's worth of context columns. > [!NOTE] PostgreSQL 16 — *"Add aggregate function `ANY_VALUE()` which returns any value from a set."*[^pg16-any-value] |
| `bool_and(b)` / `every(b)` | boolean | `every` is the SQL-standard synonym for `bool_and`. PG does **not** ship `any`/`some` as aggregates (parser ambiguity with subquery `any`/`some`).[^agg-builtin] |
| `bool_or(b)` | boolean | |
| `bit_and(x)` / `bit_or(x)` / `bit_xor(x)` | int / bigint / smallint / bit | > [!NOTE] PostgreSQL 14 — `bit_xor()` was added in PG14 (Alexey Bashtanov); useful as a cheap commutative checksum.[^pg14-bitxor] |
| `array_agg(expr)` | → `anyarray` | Includes NULLs. Order-sensitive. > [!NOTE] PostgreSQL 16 — `array_agg` and `string_agg` are now parallelizable.[^pg16-presorted] |
| `array_agg(array_expr)` | → array of higher dim | Concatenates arrays into one of `n+1` dimensions. |
| `string_agg(value, delim)` | text / bytea | Order-sensitive. Equivalent to `array_to_string(array_agg(...), delim)` but avoids materializing the array. |
| `json_agg(expr)` / `jsonb_agg(expr)` | json / jsonb | Order-sensitive. Includes nulls as `null` in the array. |
| `json_object_agg(k, v)` / `jsonb_object_agg(k, v)` | json / jsonb | Build a JSON object. Duplicate keys: result has both entries (no error). |
| `json_agg_strict` / `jsonb_agg_strict` / `_object_agg_strict` / `_object_agg_unique` / `_object_agg_unique_strict` | json / jsonb variants | See [`17-json-jsonb.md`](./17-json-jsonb.md) for the full JSON-aggregate matrix; the `_strict` suffix skips NULLs, `_unique` raises on duplicate keys. |
| `JSON_ARRAYAGG(...)` / `JSON_OBJECTAGG(...)` | SQL/JSON | > [!NOTE] PostgreSQL 16 — SQL/JSON aggregate constructors landed in PG16 (`JSON_ARRAY`, `JSON_ARRAYAGG`, `JSON_OBJECT`, `JSON_OBJECTAGG`) per the SQL standard.[^pg16-sqljson] See [`17-json-jsonb.md`](./17-json-jsonb.md). |
| `range_agg(r)` | range/multirange → multirange | Computes the union of all input ranges as a multirange. > [!NOTE] PostgreSQL 14 — `range_agg` arrived with the multirange types in PG14.[^agg-builtin] |
| `range_intersect_agg(r)` | range/multirange | Computes the intersection. |
| `xmlagg(x)` | xml → xml | Order-sensitive. |

### Statistical Aggregates

Two-argument regression aggregates (`regr_*`, `covar_*`, `corr`) take **`(Y, X)`** — the dependent variable first, then the independent variable. They skip any row where either argument is NULL. Single-argument statistical aggregates (`stddev`, `stddev_pop`, `stddev_samp`, `variance`, `var_pop`, `var_samp`) take one numeric input.

`stddev` is a historical alias for `stddev_samp` (sample standard deviation); `variance` is an alias for `var_samp`.[^agg-builtin] **Always spell out `stddev_samp` / `stddev_pop` / `var_samp` / `var_pop` explicitly** — the difference between sample (divide by `n-1`) and population (divide by `n`) is the kind of bug that survives code review.

### Ordered-Set Aggregates (`WITHIN GROUP`)

Ordered-set aggregates accept **direct arguments** (evaluated once per group) and **sort arguments** (the rows fed into the sorted aggregation):

    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY response_ms)  AS median_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms) AS p95_ms,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY response_ms) AS p99_ms
    FROM requests
    WHERE day = CURRENT_DATE;

You can pass an **array** of fractions to get all percentiles in one call (one ordered-set pass instead of three):

    SELECT
      percentile_cont(ARRAY[0.5, 0.95, 0.99])
        WITHIN GROUP (ORDER BY response_ms) AS percentiles
    FROM requests
    WHERE day = CURRENT_DATE;
    --                     percentiles
    -- ---------------------------------------------
    --  {120.5, 1840.0, 4320.0}

The four built-in ordered-set aggregates:

| Function | Returns | What it does |
|---|---|---|
| `mode() WITHIN GROUP (ORDER BY expr)` | same type as `expr` | Most frequent value. Ties broken by sort order. |
| `percentile_cont(fraction)` | double precision / interval | Continuous (interpolated) percentile. `fraction` must be in `[0, 1]` or it raises. |
| `percentile_disc(fraction)` | same type as `expr` | Discrete percentile: the first value in the ordering whose cumulative position ≥ fraction. |
| Array forms of `percentile_cont` / `percentile_disc` | array | Multiple percentiles in one pass. |

**`percentile_cont` vs `percentile_disc`** — pick `_cont` for SLO/latency reporting (you want an interpolated value, not "the value at row index ⌈0.95 × n⌉"); pick `_disc` for "give me an actual observed value" (e.g., representative election outcomes).

Per the docs: *"The `fraction` parameter must be between 0 and 1; an error is thrown if outside this range. A null `fraction` value produces a null result."*[^agg-builtin]

Ordered-set aggregates **cannot be used as window functions** and **do not participate in parallel aggregation** (per `CREATE AGGREGATE` docs).[^create-aggregate]

### Hypothetical-Set Aggregates

These ask "if I inserted this hypothetical row into the sorted group, where would it rank?" Probe-argument types must match sort-argument types one-for-one:

    SELECT
      rank(50000)        WITHIN GROUP (ORDER BY salary)        AS rank_at_50k,
      percent_rank(50000) WITHIN GROUP (ORDER BY salary)        AS pct_rank_at_50k
    FROM employees;

This computes "if we added a row with `salary = 50000`, what would its rank/percent-rank be among the existing employees?" The four built-ins are `rank`, `dense_rank`, `percent_rank`, `cume_dist` — same semantics as the [window-function counterparts](./11-window-functions.md#syntax--mechanics) but operating against a probe value rather than per-row.

Per the docs, hypothetical-set aggregates *"are not strict (do not drop rows containing nulls)"*.[^agg-builtin] If the probe value contains NULL, the result will reflect SQL NULL-comparison semantics for the chosen ordering.

### GROUP BY, HAVING, and Evaluation Order

Logical clause-evaluation order (same as [`02-syntax-dql.md`](./02-syntax-dql.md)) — aggregates live at step 4–5:

1. `FROM` / `JOIN`
2. `WHERE`
3. `GROUP BY`
4. **aggregates compute**
5. `HAVING`
6. window functions (see [`11-window-functions.md`](./11-window-functions.md))
7. `SELECT` (projection)
8. `DISTINCT`
9. outer `ORDER BY`
10. `LIMIT` / `OFFSET` / `FETCH`

Practical consequences:

- `WHERE` filters rows **before** they are grouped or fed to aggregates. `WHERE count(*) > 10` is illegal at parse time because aggregates haven't been computed yet — use `HAVING`.
- `HAVING` filters **after** aggregates. `HAVING avg(salary) > 50000` is the canonical form.
- Aliases defined in `SELECT` cannot be referenced in `WHERE`, `GROUP BY`, or `HAVING` (because `SELECT` is logically after them). PG accepts column-name references in `GROUP BY` and `ORDER BY` as a non-standard convenience, but not generally.
- `DISTINCT` runs **after** aggregates and the projection, so `SELECT DISTINCT count(*) FROM t GROUP BY k` deduplicates counts (not rare in practice).

> [!NOTE] PostgreSQL 18
> *"Allow some HAVING clauses on GROUPING SETS to be pushed to WHERE clauses."*[^pg18-having] When the predicate doesn't depend on a column that varies across grouping sets, the planner can move it to `WHERE` and filter earlier, reducing the rows that reach the grouping-set machinery. This also fixed correctness bugs in some grouping-set queries.

### GROUPING SETS, ROLLUP, CUBE

`GROUP BY GROUPING SETS ((...), (...))` runs the same query against multiple grouping keys in a single pass and unions the results. The docs put it precisely: *"The data selected by the `FROM` and `WHERE` clauses is grouped separately by each specified grouping set, aggregates computed for each group just as for simple `GROUP BY` clauses, and then the results returned."*[^queries-grouping]

The three forms:

| Form | Equivalent grouping sets |
|---|---|
| `GROUPING SETS ((a, b), (a), (b), ())` | exactly those four sets |
| `ROLLUP (a, b, c)` | `(a,b,c), (a,b), (a), ()` — prefixes plus the empty set |
| `CUBE (a, b, c)` | All 2³ = 8 subsets of `{a,b,c}` (power set) |

`ROLLUP` is the right tool for hierarchical totals: total by `(year, month, day)` with subtotals by `(year, month)`, by `(year)`, and a grand total. `CUBE` produces every conceivable subtotal — useful for BI dashboards, expensive for high-cardinality columns.

You can group elements as **sublists**: `CUBE ((a, b), (c, d))` treats `(a, b)` as one unit, producing `(a, b, c, d), (a, b), (c, d), ()` — four sets instead of `2⁴ = 16`. Useful when columns are conceptually paired (e.g., `(country, region)`, `(year, quarter)`).

**Composition rule** — multiple grouping items in the same `GROUP BY` produce the **cross product** of their grouping sets. Verbatim:

> *"If multiple grouping items are specified in a single GROUP BY clause, then the final list of grouping sets is the cross product of the individual items. For example: `GROUP BY a, CUBE (b, c), GROUPING SETS ((d), (e))` is equivalent to `GROUP BY GROUPING SETS ((a, b, c, d), (a, b, c, e), (a, b, d), (a, b, e), (a, c, d), (a, c, e), (a, d), (a, e))`."*[^queries-grouping]

That cross-product can balloon fast — `CUBE (a, b, c, d, e, f)` is 64 sets; `GROUP BY x, CUBE(a, b), CUBE(c, d)` is `1 × 4 × 4 = 16` sets. If `EXPLAIN` shows a `MixedAggregate` node with thousands of input rows per group, that may be why.

### `GROUP BY DISTINCT`

> [!NOTE] PostgreSQL 14
> *"Allow DISTINCT to be added to GROUP BY to remove duplicate GROUPING SET combinations."*[^pg14-groupby-distinct]

`GROUP BY DISTINCT` deduplicates **grouping sets**, not output rows. Consider `GROUP BY ROLLUP (a, b), ROLLUP (a, c)` — the cross product contains many duplicate grouping sets like `(a, b)` appearing twice and `(a)` appearing four times. `GROUP BY DISTINCT ROLLUP (a, b), ROLLUP (a, c)` collapses those duplicates so each unique set runs once. Verbatim:

> *"This is not the same as using `SELECT DISTINCT` because the output rows may still contain duplicates. If any of the ungrouped columns contains NULL, it will be indistinguishable from the NULL used when that same column is grouped."*[^queries-grouping]

That last sentence is the hidden footgun. See Gotcha 11.

### The `GROUPING()` Function

When a row in the result corresponds to a grouping set that **omits** a column, that column is reported as NULL — indistinguishable from a row where the underlying data was literally NULL. `GROUPING(col)` returns 1 if the column was *not* in this row's grouping set (i.e., the NULL is structural) and 0 if it was (i.e., the NULL is data).

    SELECT
      year,
      quarter,
      sum(revenue)                          AS rev,
      GROUPING(year)                        AS gy,
      GROUPING(quarter)                     AS gq,
      GROUPING(year, quarter)               AS bitmask
    FROM sales
    GROUP BY ROLLUP (year, quarter);
    -- year | quarter | rev  | gy | gq | bitmask
    -- 2024 | 1       | 120  |  0 |  0 |   0   (data row)
    -- 2024 | 2       | 140  |  0 |  0 |   0
    -- 2024 |   null  | 530  |  0 |  1 |   1   (year-subtotal)
    -- null |   null  | 980  |  1 |  1 |   3   (grand total)

The multi-argument form `GROUPING(a, b, c)` returns a bit mask. From the docs: *"Returns bit mask indicating which GROUP BY expressions are not included in current grouping set. Rightmost argument = least-significant bit; 0 if included, 1 if not."*[^agg-builtin] So `GROUPING(year, quarter) = 3` means both are excluded → grand total.

Use `GROUPING()` to **label** subtotal rows or to filter them out in `HAVING`:

    HAVING GROUPING(year, quarter) = 0   -- only the leaf rows, no subtotals

### NULL Semantics in Aggregates

| Situation | Result |
|---|---|
| Aggregate over **empty** input | NULL (for `sum`, `avg`, `min`, `max`, `array_agg`, `string_agg`, etc.) |
| `count(*)` over empty input | `0` (count is the one exception) |
| `count(expr)` over empty input | `0` |
| Aggregate over input where **every** value is NULL | NULL (because all rows are filtered out) |
| `sum` over rows where some values are NULL | NULL values are skipped; result is the sum of non-NULL values |
| `bool_and` over input including NULL | NULL ignored; behaves as if NULL rows didn't exist |
| `array_agg`, `json_agg`, `xmlagg` | **Include** NULLs in the output (unlike `sum`/`avg`/etc.) |
| `_strict` JSON variants | Skip NULLs (this is the whole point of the `_strict` suffix) |

Two common needs:

- **`sum` of empty group should be 0, not NULL**: wrap in `coalesce(sum(x), 0)`.
- **`array_agg` of empty group should be `'{}'` not NULL**: wrap in `coalesce(array_agg(x), '{}')`.

### Parallel and Pre-Sorted Aggregation

The planner can split an aggregate across parallel workers (see [`60-parallel-query.md`](./60-parallel-query.md)) when:

1. The aggregate is marked `PARALLEL SAFE` (see `pg_aggregate.aggparallel` and [`06-functions.md`](./06-functions.md) parallel safety).
2. The aggregate has a `COMBINEFUNC` defined (so partial states from workers can be merged).
3. The call does **not** use `DISTINCT`.
4. For `internal`-state aggregates: `SERIALFUNC` + `DESERIALFUNC` are defined (to serialize partial state across processes).[^create-aggregate]
5. **Ordered-set and hypothetical-set aggregates are never parallelized.**

The plan shape is two-node: workers each compute a `Partial Aggregate`; the leader runs a `Finalize Aggregate` on the merged states emitted via `Gather`:

    Finalize Aggregate
      -> Gather
        -> Partial Aggregate
          -> Parallel Seq Scan on events

> [!NOTE] PostgreSQL 16
> *"Allow aggregate functions `string_agg()` and `array_agg()` to be parallelized."*[^pg16-presorted] Prior to PG16 these were serial.

> [!NOTE] PostgreSQL 16
> *"Add the ability for aggregates having `ORDER BY` or `DISTINCT` to use pre-sorted data."*[^pg16-presorted] When an index already sorts on the aggregate's `ORDER BY` key, the aggregate runs without an intervening Sort. Toggle via `enable_presorted_aggregate`.

> [!NOTE] PostgreSQL 17
> *"Allow GROUP BY columns to be internally ordered to match ORDER BY."*[^pg17-groupby-reorder] When `GROUP BY a, b` is followed by `ORDER BY b, a`, the planner can reorder the grouping keys to align with the outer ORDER BY and skip the second sort. Toggle via `enable_group_by_reordering`.

> [!NOTE] PostgreSQL 18
> *"Ignore GROUP BY columns that are functionally dependent on other columns."*[^pg18-funcdep] If `GROUP BY` includes all columns of a unique index plus other columns of the same table, the other columns are redundant and dropped from the grouping. Previously this only applied to non-deferred primary keys.

> [!NOTE] PostgreSQL 18
> *"Improve the performance and reduce memory usage of hash joins and GROUP BY."*[^pg18-hashgroup] Affects every `HashAggregate` plan and hash set ops (`EXCEPT`, `INTERSECT`).

### Reading Aggregate Plans in EXPLAIN

Aggregate node types in plans:

| Node | When chosen | What it does |
|---|---|---|
| `Aggregate` | Plain `agg()` without `GROUP BY` (or `GROUP BY` collapses to one row) | Single result row. |
| `HashAggregate` | `GROUP BY` keys fit in `work_mem` (or `hash_mem_multiplier` × `work_mem` since PG13) | Build a hash table keyed by group columns. No sort needed. |
| `GroupAggregate` | `GROUP BY` exceeds memory budget, or input is already sorted on the keys | Reads sorted input, aggregates each peer group. Always paired with a `Sort` below it unless an index provides the order. |
| `MixedAggregate` | `GROUPING SETS` / `ROLLUP` / `CUBE` | Computes multiple grouping sets in one pass using a state machine. |
| `Partial Aggregate` + `Finalize Aggregate` | Parallel aggregation | Workers run Partial; leader merges via Finalize. |

A slow aggregate is usually one of:

- `HashAggregate` over a huge cardinality with `Memory Usage` near `work_mem` — bump `hash_mem_multiplier` (PG13+) or `work_mem` for that session.
- `GroupAggregate` preceded by a `Sort` doing disk spills — add a covering index that provides the sort order.
- `count(DISTINCT x)` running serially — see Gotcha 5 + Recipe 11.

### CREATE AGGREGATE — User-Defined Aggregates

Full reference: [`06-functions.md`](./06-functions.md) for volatility and parallel-safety markers that `CREATE AGGREGATE` inherits. Grammar for a normal aggregate:[^create-aggregate]

    CREATE [ OR REPLACE ] AGGREGATE name ( [ argmode ] [ argname ] arg_data_type [ , ... ] ) (
        SFUNC = sfunc,
        STYPE = state_data_type
        [ , SSPACE = state_data_size ]
        [ , FINALFUNC = ffunc ]
        [ , FINALFUNC_EXTRA ]
        [ , FINALFUNC_MODIFY = { READ_ONLY | SHAREABLE | READ_WRITE } ]
        [ , COMBINEFUNC = combinefunc ]
        [ , SERIALFUNC = serialfunc ]
        [ , DESERIALFUNC = deserialfunc ]
        [ , INITCOND = initial_condition ]
        [ , MSFUNC = msfunc ]
        [ , MINVFUNC = minvfunc ]
        [ , MSTYPE = mstate_data_type ]
        [ , MSSPACE = mstate_data_size ]
        [ , MFINALFUNC = mffunc ]
        [ , MFINALFUNC_EXTRA ]
        [ , MFINALFUNC_MODIFY = { READ_ONLY | SHAREABLE | READ_WRITE } ]
        [ , MINITCOND = minitial_condition ]
        [ , SORTOP = sort_operator ]
        [ , PARALLEL = { SAFE | RESTRICTED | UNSAFE } ]
    )

For ordered-set / hypothetical-set aggregates, arguments are split into direct args (in the parameter list) and aggregated args (after `ORDER BY`):

    CREATE [ OR REPLACE ] AGGREGATE name ( [ direct_args ] ORDER BY agg_args ) (
        SFUNC = sfunc,
        STYPE = state_data_type
        ...
        [ , HYPOTHETICAL ]
    )

**Required minimum**: `SFUNC` + `STYPE`. Everything else is opt-in.

Key option semantics:

- `SFUNC`: takes `(state, value1, value2, ...)` and returns the next state. Mark `STRICT` to skip NULL inputs (preserves prior state). With `STRICT`, the first non-NULL value becomes the initial state and `INITCOND` is ignored.
- `STYPE`: data type of the running state. For C-language aggregates, often `internal` (opaque pointer).
- `INITCOND`: initial state literal (parsed via `STYPE`'s input function). Omit to start at NULL.
- `FINALFUNC`: optional one-shot transform from final state to result. If omitted, the result type is `STYPE`.
- `FINALFUNC_EXTRA`: pass dummy NULLs of the input types to the final function (for polymorphic resolution).
- `FINALFUNC_MODIFY = READ_ONLY` (default for normal aggregates) lets the aggregate work as a window function and lets the planner merge equivalent aggregate calls. `READ_WRITE` disables both.
- `COMBINEFUNC`: enables partial / parallel aggregation. Takes two states and returns a merged state.
- `SERIALFUNC` / `DESERIALFUNC`: required if `STYPE = internal` and you want parallel — converts state to/from `bytea` for inter-process transport.
- `MSFUNC` / `MINVFUNC` / `MSTYPE`: enables **moving-aggregate mode** for window-function use with a moving frame. `MINVFUNC` removes a value from the state when the frame slides forward. Required if you want O(rows) cost instead of O(rows × frame_size) for sliding-window aggregates.
- `SORTOP`: declare the sort operator the aggregate is min/max-equivalent to. Lets the planner optimize `MIN(col)` / `MAX(col)` to an index lookup of the first or last index entry.
- `PARALLEL`: defaults to `UNSAFE` — explicitly mark `SAFE` to allow parallel use.[^create-aggregate]

See [Recipe 13](#recipe-13-custom-aggregate--running-product) for an end-to-end example.

## Examples / Recipes

### Recipe 1 — Several conditional aggregates over one scan via `FILTER`

    SELECT
      day,
      count(*)                                              AS requests,
      count(*) FILTER (WHERE status >= 500)                  AS errors_5xx,
      count(*) FILTER (WHERE status BETWEEN 400 AND 499)     AS errors_4xx,
      avg(latency_ms) FILTER (WHERE status < 400)            AS avg_ok_latency,
      sum(bytes_out)                                         AS total_bytes,
      sum(bytes_out) FILTER (WHERE cached)                   AS cached_bytes
    FROM request_log
    WHERE day >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY day
    ORDER BY day;

One scan, six aggregates. Prefer this shape over six separate `SELECT count(*) FROM ... WHERE ...` queries.

### Recipe 2 — Percentiles in one ordered-set pass

    SELECT
      route,
      count(*)                                                          AS req,
      percentile_cont(ARRAY[0.5, 0.95, 0.99])
        WITHIN GROUP (ORDER BY duration_ms)                             AS p50_p95_p99,
      avg(duration_ms)                                                  AS mean_ms,
      max(duration_ms)                                                  AS max_ms
    FROM api_log
    WHERE day = CURRENT_DATE
    GROUP BY route
    HAVING count(*) > 100
    ORDER BY (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)) DESC
    LIMIT 20;

The array form computes all three percentiles in one pass over the sorted group. The `HAVING count(*) > 100` filters out routes with too few samples for percentile statistics to be meaningful — `HAVING`, not `WHERE`, because the predicate uses an aggregate.

### Recipe 3 — `string_agg` with deterministic order

    SELECT
      team_id,
      string_agg(name, ', ' ORDER BY hire_date, name) AS members
    FROM employees
    GROUP BY team_id;

`ORDER BY hire_date, name` guarantees a stable result. Add `name` as a tiebreaker so two employees hired the same day come out in a deterministic order.

### Recipe 4 — `array_agg` of NULL-free, distinct values

    SELECT
      author_id,
      array_agg(DISTINCT tag ORDER BY tag) FILTER (WHERE tag IS NOT NULL) AS tags
    FROM article_tags
    GROUP BY author_id;

`DISTINCT` deduplicates, `ORDER BY tag` makes the array stable, and `FILTER (WHERE tag IS NOT NULL)` keeps NULLs out without coercing them via `coalesce`.

Note the constraint: `ORDER BY` expression must match the `DISTINCT` key. `ORDER BY some_other_col` would error out (see [DISTINCT Inside an Aggregate](#distinct-inside-an-aggregate)).

### Recipe 5 — Subtotals via `ROLLUP`

    SELECT
      coalesce(region,  'TOTAL') AS region,
      coalesce(country, 'TOTAL') AS country,
      sum(revenue)               AS revenue,
      GROUPING(region, country)  AS subtotal_level
    FROM sales
    GROUP BY ROLLUP (region, country)
    ORDER BY region NULLS LAST, country NULLS LAST;
    -- region | country | revenue | subtotal_level
    -- EU     | DE      |    400  |  0   (leaf)
    -- EU     | FR      |    350  |  0
    -- EU     | TOTAL   |    750  |  1   (region subtotal: country was rolled up)
    -- US     | US      |    900  |  0
    -- US     | TOTAL   |    900  |  1
    -- TOTAL  | TOTAL   |   1650  |  3   (grand total: both rolled up)

`GROUPING(region, country)` produces a bit mask: `0` = leaf row, `1` = country was rolled up (region subtotal), `2` = region was rolled up (country subtotal, doesn't occur in ROLLUP), `3` = both rolled up (grand total).

The `coalesce` is **only safe when the data has no real NULLs** in those columns. See Gotcha 11.

### Recipe 6 — Full crosstab via `CUBE` + `GROUPING()`

    SELECT
      year,
      quarter,
      product_line,
      sum(revenue) AS revenue,
      CASE
        WHEN GROUPING(year, quarter, product_line) = 7 THEN 'Grand Total'
        WHEN GROUPING(year, quarter)               = 3 THEN 'Product:  '  || product_line
        WHEN GROUPING(quarter, product_line)       = 3 THEN 'Year:     '  || year
        WHEN GROUPING(quarter)                     = 1 THEN 'Year+Prod: ' || year || '/' || product_line
        ELSE 'leaf'
      END AS label
    FROM sales
    GROUP BY CUBE (year, quarter, product_line);

`CUBE` over three columns yields `2³ = 8` grouping sets. The `CASE`/`GROUPING` combination labels each subtotal level so the UI doesn't have to interpret structural NULLs.

### Recipe 7 — `GROUP BY DISTINCT` to collapse duplicate grouping sets

    SELECT
      year, quarter, product_line, sum(revenue) AS revenue
    FROM sales
    GROUP BY DISTINCT
      ROLLUP (year, quarter),
      ROLLUP (year, product_line);
    -- Without DISTINCT, `(year)` and the grand total `()` each appear twice
    -- (once from each ROLLUP). DISTINCT collapses them.

### Recipe 8 — Median and IQR

    SELECT
      department,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY salary)               AS median,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY salary)               AS q1,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY salary)               AS q3,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY salary)
        - percentile_cont(0.25) WITHIN GROUP (ORDER BY salary)           AS iqr,
      mode() WITHIN GROUP (ORDER BY job_grade)                           AS modal_grade
    FROM employees
    GROUP BY department;

PostgreSQL has no `median()` aggregate. `percentile_cont(0.5)` is the answer; `_disc(0.5)` is the answer when you need an actual observed salary, not an interpolated halfway point.

### Recipe 9 — `mode()` for categorical "most common" reporting

    SELECT
      country,
      mode() WITHIN GROUP (ORDER BY preferred_language) AS top_language,
      count(*)                                          AS users
    FROM user_profiles
    GROUP BY country
    ORDER BY users DESC;

`mode()` is the ordered-set form of "what's the most frequent value." For ties it picks deterministically based on the sort order — useful but make the order explicit (`ORDER BY preferred_language` rather than relying on whatever the planner picks).

### Recipe 10 — Hypothetical rank: "where would this salary land?"

    SELECT
      department,
      rank(50000)         WITHIN GROUP (ORDER BY salary) AS rank_at_50k,
      percent_rank(50000) WITHIN GROUP (ORDER BY salary) AS pctrank_at_50k,
      cume_dist(50000)    WITHIN GROUP (ORDER BY salary) AS cumedist_at_50k
    FROM employees
    GROUP BY department;

Useful for "what percentile is this candidate's expected salary in each department?"

### Recipe 11 — Faster count-distinct via pre-deduplication

`count(DISTINCT x)` disables parallel aggregation. For high-cardinality columns this can be a 5–10× speedup:

    -- Slow: serial plan
    SELECT day, count(DISTINCT user_id) AS dau
    FROM events
    WHERE day >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY day;

    -- Fast: parallel-friendly dedupe then count
    SELECT day, count(*) AS dau
    FROM (
        SELECT DISTINCT day, user_id
        FROM events
        WHERE day >= CURRENT_DATE - INTERVAL '30 days'
    ) d
    GROUP BY day;

The rewrite turns `count(DISTINCT user_id)` into a `SELECT DISTINCT` + `count(*)`. The `SELECT DISTINCT` can run as a parallel `HashAggregate`, and the outer `count(*)` is trivially parallel-safe.

For approximate counts at scale, also consider `hll` or `topn` extensions (out-of-tree), or `count(*) FROM (SELECT 1 FROM events WHERE ... GROUP BY user_id)` if you need exactness but parallelism more than memory locality.

### Recipe 12 — `any_value()` to drop a row's worth of context

When `GROUP BY` covers your key but you also want non-aggregated columns from the same row:

    -- PG16+: clean
    SELECT
      user_id,
      any_value(name)        AS name,        -- assumes name is functionally dependent on user_id
      any_value(email)       AS email,
      max(login_at)          AS last_login,
      count(*)               AS login_count
    FROM logins
    GROUP BY user_id;

> [!NOTE] PostgreSQL 16
> `any_value()` landed in PG16.[^pg16-any-value] Before PG16, the idiom was `(array_agg(name))[1]` or `min(name)` (with the implicit assumption that all rows in the group share the same value).

`any_value()` is faster than `min()` because it can stop after the first non-NULL value rather than scanning all of them.

> [!NOTE] PostgreSQL 18
> If the `GROUP BY` already covers a unique constraint, PG18 may drop redundant `GROUP BY` columns automatically.[^pg18-funcdep] You can then reference functionally-dependent columns in `SELECT` directly without an aggregate wrapper.

### Recipe 13 — Custom aggregate: running product

A simple parallel-safe multiplicative aggregate:

    CREATE FUNCTION numeric_mul(state numeric, value numeric)
    RETURNS numeric
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$ SELECT state * value $$;

    CREATE AGGREGATE product(numeric) (
        SFUNC      = numeric_mul,
        STYPE      = numeric,
        INITCOND   = '1',
        COMBINEFUNC = numeric_mul,    -- multiplication is associative & commutative
        PARALLEL   = SAFE
    );

    SELECT category, product(growth_factor) AS compounded
    FROM monthly_growth
    GROUP BY category;

`COMBINEFUNC` is the same as `SFUNC` here because multiplication is both associative and commutative — partial products from different workers can be combined by another multiply. With `PARALLEL = SAFE` the planner can pick a `Partial Aggregate` + `Finalize Aggregate` plan.

For non-commutative state (`array_agg`, `string_agg`) the combine function must concatenate in a well-defined order — which is exactly why parallel `string_agg` / `array_agg` only landed in PG16 (the combine function exists but yields an arbitrary order unless an outer `ORDER BY` constrains it).

### Recipe 14 — `FILTER` for grouping-set-aware totals

Combine `FILTER` and `GROUPING SETS` to produce a totals row plus per-status counts in one query:

    SELECT
      coalesce(status, 'TOTAL')   AS status,
      count(*)                    AS n,
      sum(amount)                 AS amount
    FROM payments
    WHERE month = '2026-04'
    GROUP BY GROUPING SETS ((status), ())
    ORDER BY GROUPING(status), status;

The `()` empty grouping set produces the grand total row. `ORDER BY GROUPING(status)` puts the data rows first (`GROUPING(status) = 0`) and the total last (`GROUPING(status) = 1`).

## Gotchas / Anti-patterns

1. **`WHERE count(*) > 10` is illegal.** Aggregates haven't been computed at `WHERE` time. Use `HAVING count(*) > 10`. The fact that the keyword `HAVING` exists at all is because of this evaluation-order constraint.

2. **`sum()` of empty input is NULL, not 0.** `coalesce(sum(amount), 0)` is almost always what you want when reporting totals to a UI. `count(*)` is the exception (returns 0 on empty).

3. **`array_agg` includes NULLs by default.** If you want to skip them, use `array_agg(x) FILTER (WHERE x IS NOT NULL)` or `array_agg(x ORDER BY x) FILTER (WHERE x IS NOT NULL)`. The same applies to `json_agg`, `jsonb_agg`, `xmlagg`. The `_strict` JSON variants (PG16+) skip NULLs natively.

4. **`string_agg` / `array_agg` without `ORDER BY` is nondeterministic.** Tests that pass today may fail tomorrow when the planner picks a hash aggregate instead of a sort-based plan, or when parallel workers reorder rows. Always spell the order out for order-sensitive aggregates.

5. **`count(DISTINCT col)` disables parallel aggregation.** For high-cardinality columns this can be the difference between a 3-second and a 30-second query. See [Recipe 11](#recipe-11-faster-count-distinct-via-pre-deduplication).

6. **`ORDER BY` placement is grammar-sensitive.** `string_agg(a, ',' ORDER BY a)` is correct; `string_agg(a ORDER BY a, ',')` parses the `ORDER BY a, ','` as a two-key sort and produces a different result (sometimes silently).

7. **`DISTINCT` + `ORDER BY` inside an aggregate is constrained.** See [DISTINCT Inside an Aggregate](#distinct-inside-an-aggregate). `array_agg(DISTINCT a ORDER BY b)` raises at parse time.

8. **`stddev` and `variance` are sample (n-1) aliases, not population (n).** If you need the population formula, write `stddev_pop` / `var_pop` explicitly. Default sample-vs-population mistakes are the slow kind — they don't crash, they just give numbers that are slightly off from a downstream system using the other convention.

9. **`DISTINCT` and inline `ORDER BY` are illegal in window-function aggregate calls.** `sum(DISTINCT x) OVER (...)` and `array_agg(x ORDER BY y) OVER (...)` both raise at parse time. For windowed top-N kinds of problems, sort the outer query or use a different aggregate (see [`11-window-functions.md`](./11-window-functions.md)).

10. **Ordered-set aggregates cannot be window functions.** `percentile_cont(0.5) WITHIN GROUP (ORDER BY x) OVER (PARTITION BY g)` is illegal. Compute the percentile in a grouped subquery and join, or use the windowed `ntile(100)` trick (see [`11-window-functions.md`](./11-window-functions.md) Recipe 8).

11. **Structural NULLs from `GROUPING SETS` look like data NULLs.** A row from a `ROLLUP` subtotal has NULL for the rolled-up column — indistinguishable from a row where the underlying data was NULL. Verbatim: *"If any of the ungrouped columns contains NULL, it will be indistinguishable from the NULL used when that same column is grouped."*[^queries-grouping] Use `GROUPING(col)` to disambiguate.

12. **`CUBE` over many columns explodes.** `CUBE (a, b, c, d, e, f)` produces 64 grouping sets. The planner runs each one; `EXPLAIN` shows `MixedAggregate` with a huge state. If you only need a few subtotal levels, write them out as `GROUPING SETS ((...), (...))` directly.

13. **`HAVING` runs after aggregates, `WHERE` runs before.** `WHERE day = CURRENT_DATE` filters rows before they enter the aggregate (cheap). `HAVING day = CURRENT_DATE` is parsed but applied **after** aggregation (it still works because `day` is in the grouping, but you've thrown away the chance to filter early). Always push filters into `WHERE` unless they depend on an aggregate. > [!NOTE] PostgreSQL 18 — the planner now pushes some `HAVING` predicates on `GROUPING SETS` into `WHERE` automatically.[^pg18-having]

14. **`HashAggregate` spills to disk silently.** When a hash table exceeds `work_mem` × `hash_mem_multiplier`, PG13+ spills to disk (it did not on PG12 and earlier — it just used more memory than allotted, sometimes ballooning to OOM). The spill is correct but slow. Diagnose via `EXPLAIN (ANALYZE, BUFFERS)` — look for `Disk Usage` on the HashAggregate node. Bump `hash_mem_multiplier` (set at session level for the offending query) before tuning `work_mem` globally.

15. **Mixing `agg(DISTINCT x)` and `agg(DISTINCT y)` over different keys is single-threaded.** Multiple `DISTINCT` aggregates over the same column work; over different columns they force the planner to materialize and then count distincts on each, which historically did one pass per `DISTINCT` column. Consider grouping-set tricks or per-column subqueries with UNION ALL.

16. **`ORDER BY agg_call` re-evaluates the aggregate.** `ORDER BY count(*) DESC` is fine (the planner evaluates each aggregate once), but `ORDER BY percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)` repeated inline in the `ORDER BY` will sort by re-computing the ordered-set aggregate. Compute in `SELECT` with an alias and reference the alias (PG accepts this as a convenience extension), or wrap in a subquery.

## See Also

- [`11-window-functions.md`](./11-window-functions.md) — Aggregates used as window functions via `OVER (...)`, the catalog of pure window functions (`row_number`, `rank`, `lag`, `lead`).
- [`02-syntax-dql.md`](./02-syntax-dql.md) — `SELECT` grammar, the full clause-evaluation order, `DISTINCT ON`.
- [`04-ctes.md`](./04-ctes.md) — Wrapping aggregates in a CTE to filter or rejoin; `GROUPING SETS` inside CTEs.
- [`17-json-jsonb.md`](./17-json-jsonb.md) — The full JSON aggregate matrix (`json_agg` / `jsonb_agg` / `_strict` / `_unique` / `JSON_ARRAYAGG` / `JSON_OBJECTAGG`).
- [`56-explain.md`](./56-explain.md) — Reading `HashAggregate`, `GroupAggregate`, `Partial Aggregate`, `Finalize Aggregate`, `MixedAggregate` plan nodes.
- [`59-planner-tuning.md`](./59-planner-tuning.md) — `enable_hashagg`, `enable_presorted_aggregate` (PG16+), `enable_group_by_reordering` (PG17+), `hash_mem_multiplier`, `work_mem`.
- [`60-parallel-query.md`](./60-parallel-query.md) — Parallel-safe / restricted / unsafe markers and how they gate parallel aggregation.
- [`06-functions.md`](./06-functions.md) — `PARALLEL SAFE` / `LEAKPROOF` / volatility, the function metadata `CREATE AGGREGATE` builds on.
- [`72-extension-development.md`](./72-extension-development.md) — Writing C-language aggregate transition / final / combine functions.

## Sources

[^agg-builtin]: PostgreSQL 16 documentation, "Aggregate Functions" (Section 9.21) — full catalog of built-in general-purpose, statistical, ordered-set, hypothetical-set aggregates, and grouping operations. *"The aggregate functions array_agg, json_agg, jsonb_agg, ..., string_agg, and xmlagg, as well as similar user-defined aggregate functions, produce meaningfully different result values depending on the order of the input values."* Also: *"PostgreSQL supports every (SQL standard) but not any or some due to syntax ambiguity with subqueries."* https://www.postgresql.org/docs/16/functions-aggregate.html

[^sql-expressions]: PostgreSQL 16 documentation, "Value Expressions: Aggregate Expressions" (Section 4.2.7) — the five aggregate-call grammar forms, the rule that ORDER BY must come after all regular args, and the DISTINCT-with-ORDER-BY constraint. *"When dealing with multiple-argument aggregate functions, note that the ORDER BY clause goes after all the aggregate arguments. ... If DISTINCT is specified in addition to an order_by_clause, then all the ORDER BY expressions must match regular arguments of the aggregate; that is, you cannot sort on an expression that is not included in the DISTINCT list."* https://www.postgresql.org/docs/16/sql-expressions.html

[^queries-grouping]: PostgreSQL 16 documentation, "Table Expressions: GROUPING SETS, CUBE, and ROLLUP" (Section 7.2.4) — the formal definitions of `ROLLUP`, `CUBE`, sublist semantics, cross-product composition of multiple grouping items, and `GROUP BY DISTINCT`. *"If multiple grouping items are specified in a single GROUP BY clause, then the final list of grouping sets is the cross product of the individual items."* *"This is not the same as using SELECT DISTINCT because the output rows may still contain duplicates. If any of the ungrouped columns contains NULL, it will be indistinguishable from the NULL used when that same column is grouped."* https://www.postgresql.org/docs/16/queries-table-expressions.html

[^create-aggregate]: PostgreSQL 16 documentation, `CREATE AGGREGATE` reference — full grammar for normal, ordered-set, and hypothetical-set aggregates, every option (`SFUNC`, `STYPE`, `FINALFUNC`, `COMBINEFUNC`, `SERIALFUNC`, `DESERIALFUNC`, `MSFUNC`, `MINVFUNC`, `MSTYPE`, `FINALFUNC_MODIFY`, `SORTOP`, `PARALLEL`). *"Currently, ordered-set aggregates do not need to support moving-aggregate mode, since they cannot be used as window functions."* *"Partial (including parallel) aggregation is currently not supported for ordered-set aggregates."* https://www.postgresql.org/docs/16/sql-createaggregate.html

[^xaggr]: PostgreSQL 16 documentation, "User-Defined Aggregates" (Chapter 38.12 in xfunc/xaggr) — worked examples for simple aggregates, polymorphic aggregates, moving-aggregate mode, partial / parallel aggregation, and ordered-set aggregates. https://www.postgresql.org/docs/16/xaggr.html

[^pg14-bitxor]: PostgreSQL 14.0 Release Notes, section "Functions". *"Add bit_xor() XOR aggregate function (Alexey Bashtanov)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-groupby-distinct]: PostgreSQL 14.0 Release Notes. *"Allow DISTINCT to be added to GROUP BY to remove duplicate GROUPING SET combinations (Vik Fearing)."* https://www.postgresql.org/docs/release/14.0/

[^pg16-any-value]: PostgreSQL 16.0 Release Notes. *"Add aggregate function ANY_VALUE() which returns any value from a set (Vik Fearing)."* https://www.postgresql.org/docs/release/16.0/

[^pg16-presorted]: PostgreSQL 16.0 Release Notes. *"Add the ability for aggregates having ORDER BY or DISTINCT to use pre-sorted data (David Rowley). The new server variable enable_presorted_aggregate can be used to disable this."* And: *"Allow aggregate functions string_agg() and array_agg() to be parallelized (David Rowley)."* https://www.postgresql.org/docs/release/16.0/

[^pg16-sqljson]: PostgreSQL 16.0 Release Notes. *"Add SQL/JSON constructors (Nikita Glukhov, Teodor Sigaev, Oleg Bartunov, Alexander Korotkov, Amit Langote). The new functions JSON_ARRAY(), JSON_ARRAYAGG(), JSON_OBJECT(), and JSON_OBJECTAGG() are part of the SQL standard."* https://www.postgresql.org/docs/release/16.0/

[^pg17-groupby-reorder]: PostgreSQL 17.0 Release Notes, "Optimizer". *"Allow GROUP BY columns to be internally ordered to match ORDER BY (Andrei Lepikhov, Teodor Sigaev). This can be disabled using server variable enable_group_by_reordering."* https://www.postgresql.org/docs/release/17.0/

[^pg18-minmax-arrays]: PostgreSQL 18.0 Release Notes. *"Allow MIN()/MAX() aggregates on arrays and composite types (Aleksander Alekseev, Marat Buharov)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-funcdep]: PostgreSQL 18.0 Release Notes. *"Ignore GROUP BY columns that are functionally dependent on other columns (Zhang Mingli, Jian He, David Rowley). If a GROUP BY clause includes all columns of a unique index, as well as other columns of the same table, those other columns are redundant and can be dropped from the grouping. This was already true for non-deferred primary keys."* https://www.postgresql.org/docs/release/18.0/

[^pg18-having]: PostgreSQL 18.0 Release Notes. *"Allow some HAVING clauses on GROUPING SETS to be pushed to WHERE clauses (Richard Guo). This allows earlier row filtering. This release also fixes some GROUPING SETS queries that used to return incorrect results."* https://www.postgresql.org/docs/release/18.0/

[^pg18-hashgroup]: PostgreSQL 18.0 Release Notes. *"Improve the performance and reduce memory usage of hash joins and GROUP BY (David Rowley, Jeff Davis). This also improves hash set operations used by EXCEPT, and hash lookups of subplan values."* https://www.postgresql.org/docs/release/18.0/

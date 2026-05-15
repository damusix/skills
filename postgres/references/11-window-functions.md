# Window Functions

## When to Use This Reference

Reach for this file whenever you need a value computed **per row** that depends on a *set* of related rows (the "window") — running totals, top-N per group, moving averages, rank by partition, gap detection, prior/next row lookup.

This file covers:

- The full `OVER (…)` grammar — `PARTITION BY`, `ORDER BY`, `frame_clause`.
- All three frame modes: `ROWS`, `RANGE`, `GROUPS` (`GROUPS` added in PostgreSQL 11).
- `EXCLUDE` (added in PG11) and `FILTER` (aggregates as window functions only).
- All 11 built-in window functions (`row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`, `lag`, `lead`, `first_value`, `last_value`, `nth_value`).
- The named `WINDOW` clause and inheritance rules.
- When the planner uses `WindowAgg` and how to read it in `EXPLAIN`.
- Common recipes (top-N per group, moving average, gap-and-island, sessionization, cumulative percentile).
- Gotchas: default frame ending at "current row's peer", `last_value` returning the same row as `first_value`, no `IGNORE NULLS`, `NOT IN` of a window result anti-patterns.

If you're picking between `DISTINCT ON`, `LATERAL`, and a window function for "first row per group", see the three-way comparison in [`02-syntax-dql.md`](./02-syntax-dql.md). If you're trying to filter by a window function value, that's in `WHERE` is not allowed — wrap in a CTE or subquery (see [`04-ctes.md`](./04-ctes.md)).

## Table of Contents

- [The Mental Model](#the-mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Full grammar](#full-grammar)
    - [`PARTITION BY`](#partition-by)
    - [`ORDER BY` inside `OVER`](#order-by-inside-over)
    - [Frame clauses: `ROWS` vs `RANGE` vs `GROUPS`](#frame-clauses-rows-vs-range-vs-groups)
    - [Frame bounds and the default frame](#frame-bounds-and-the-default-frame)
    - [`EXCLUDE` clause](#exclude-clause)
    - [`FILTER` (aggregates only)](#filter-aggregates-only)
    - [Named `WINDOW` clause and inheritance](#named-window-clause-and-inheritance)
    - [Where window functions are allowed](#where-window-functions-are-allowed)
    - [Order of clause evaluation](#order-of-clause-evaluation)
- [Built-in Window Function Catalog](#built-in-window-function-catalog)
    - [Ranking: `row_number`, `rank`, `dense_rank`](#ranking-row_number-rank-dense_rank)
    - [Distribution: `percent_rank`, `cume_dist`, `ntile`](#distribution-percent_rank-cume_dist-ntile)
    - [Value: `lag`, `lead`, `first_value`, `last_value`, `nth_value`](#value-lag-lead-first_value-last_value-nth_value)
    - [Aggregates as window functions](#aggregates-as-window-functions)
- [Reading `WindowAgg` in `EXPLAIN`](#reading-windowagg-in-explain)
- [Examples / Recipes](#examples--recipes)
    1. [Top-N per group with `row_number`](#recipe-1-top-n-per-group-with-row_number)
    2. [Three-way ties: when to pick `RANK` vs `DENSE_RANK`](#recipe-2-three-way-ties-when-to-pick-rank-vs-dense_rank)
    3. [Running total and running average](#recipe-3-running-total-and-running-average)
    4. [Moving / rolling-window aggregate](#recipe-4-moving--rolling-window-aggregate)
    5. [Per-row delta from previous row (`lag`)](#recipe-5-per-row-delta-from-previous-row-lag)
    6. [Gap-and-island detection](#recipe-6-gap-and-island-detection)
    7. [Sessionization with `lag` + window sum](#recipe-7-sessionization-with-lag--window-sum)
    8. [Percentile bucket with `ntile`](#recipe-8-percentile-bucket-with-ntile)
    9. [First / last value over a per-group window done correctly](#recipe-9-first--last-value-over-a-per-group-window-done-correctly)
    10. [Time-series moving aggregate with `RANGE` interval](#recipe-10-time-series-moving-aggregate-with-range-interval)
    11. [Conditional aggregation via `FILTER`](#recipe-11-conditional-aggregation-via-filter)
    12. [Pagination cursor using window output](#recipe-12-pagination-cursor-using-window-output)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## The Mental Model

A window function computes a value *for each row* by looking at a set of other rows in the same query result. Three layers decide what those "other rows" are:

1. **Partition** — `PARTITION BY` splits the result into groups. Window calculations never cross a partition boundary. If you omit `PARTITION BY`, there is one implicit partition containing every row.
2. **Window order** — `ORDER BY` inside `OVER` defines the order of rows *within* a partition. This is independent of the query's outer `ORDER BY`.
3. **Frame** — for each row, the frame is the subset of the partition the window function actually sees. The default frame is `RANGE UNBOUNDED PRECEDING` which means "start of partition through the **last peer** of the current row" when `ORDER BY` is given — not "through the current row." This single default is the source of most window-function bugs.

Unlike aggregates, window functions **do not collapse rows**. Every input row produces exactly one output row, and each row gets its own computed window value.

Window functions evaluate **after** `FROM`, `WHERE`, `GROUP BY`, and `HAVING`, and **before** `DISTINCT`, the outer `ORDER BY`, and `LIMIT` / `OFFSET`. Because of this, you cannot reference a window function from `WHERE` or `GROUP BY` (it hasn't been computed yet) — wrap the query in a CTE or subquery if you need to filter on window results.[^queries-window]

> [!NOTE] PostgreSQL 11
> All three frame modes (`ROWS`, `RANGE`, `GROUPS`) and the `EXCLUDE` clause come from the SQL:2011 standard and were added in PG11. Before PG11, only `ROWS` and the basic `RANGE UNBOUNDED PRECEDING` / `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` forms existed.[^pg11-frames]

## Syntax / Mechanics

### Full grammar

```sql
function_name ( [ expr [, …] ] )
    [ FILTER ( WHERE filter_clause ) ]
    OVER { window_name | ( window_definition ) }

window_definition ::=
    [ existing_window_name ]
    [ PARTITION BY expr [, …] ]
    [ ORDER BY expr [ ASC | DESC | USING operator ]
        [ NULLS { FIRST | LAST } ] [, …] ]
    [ frame_clause ]

frame_clause ::=
      { RANGE | ROWS | GROUPS } frame_start [ frame_exclusion ]
    | { RANGE | ROWS | GROUPS } BETWEEN frame_start
                                AND     frame_end
                                [ frame_exclusion ]

frame_start, frame_end ::=
      UNBOUNDED PRECEDING
    | offset      PRECEDING
    | CURRENT ROW
    | offset      FOLLOWING
    | UNBOUNDED FOLLOWING

frame_exclusion ::=
      EXCLUDE CURRENT ROW
    | EXCLUDE GROUP
    | EXCLUDE TIES
    | EXCLUDE NO OTHERS      -- the default
```

Constraints worth committing to memory[^window-syntax]:

- `frame_start` cannot be `UNBOUNDED FOLLOWING`.
- `frame_end` cannot be `UNBOUNDED PRECEDING`.
- `frame_end` cannot appear *earlier* in the list above than `frame_start` — e.g. `RANGE BETWEEN CURRENT ROW AND offset PRECEDING` is illegal.
- `FILTER ( WHERE … )` is only legal on aggregate functions used as window functions, never on pure window functions like `row_number()` or `lag()`.

### `PARTITION BY`

`PARTITION BY` splits the query result into independent groups. The window function is computed separately within each group. Multiple expressions are allowed:

```sql
SELECT product_id, region,
       sum(units) OVER (PARTITION BY product_id, region) AS total
FROM sales;
```

If `PARTITION BY` is omitted, the entire query result is one partition.

### `ORDER BY` inside `OVER`

The window `ORDER BY` is independent of the query's outer `ORDER BY`:

```sql
SELECT id,
       row_number() OVER (ORDER BY created_at)  AS chronological,
       row_number() OVER (ORDER BY id DESC)     AS by_id_desc
FROM events
ORDER BY id;
```

Three properties of the window `ORDER BY` to know[^queries-window]:

- `NULLS FIRST` / `NULLS LAST` work the same as in the outer `ORDER BY`. Default is `NULLS LAST` for `ASC`, `NULLS FIRST` for `DESC`.
- Multiple window functions with **equivalent** `PARTITION BY` + `ORDER BY` are guaranteed to see the same input ordering — even when ties exist and `ORDER BY` is not unique. Use this to confirm that two `row_number()` calls with the same `OVER` produce the same numbering.
- The window `ORDER BY` is what defines "peers" for `RANGE` and `GROUPS` frame modes (rows with equal `ORDER BY` keys are peers).

### Frame clauses: `ROWS` vs `RANGE` vs `GROUPS`

The three frame modes determine **how** `offset PRECEDING` and `offset FOLLOWING` are interpreted:

| Mode | What `N PRECEDING` / `N FOLLOWING` counts | Restrictions |
|---|---|---|
| `ROWS` | Physical rows (positional). | None. `0 PRECEDING` ≡ `CURRENT ROW`. |
| `RANGE` | Logical range — rows whose `ORDER BY` value is within ±offset of the current row's value. | `ORDER BY` must specify exactly **one** column. Offset type must match the order column (or be `interval` for datetime). Offset must be non-null and non-negative.[^window-syntax] |
| `GROUPS` | Peer groups — rows that share an `ORDER BY` value count as a single "row" for the offset. | Requires `ORDER BY`. |

> [!NOTE] PostgreSQL 11
> `GROUPS` mode and `RANGE` with offset (`RANGE BETWEEN '7 days' PRECEDING AND CURRENT ROW`) were both added in PG11 as part of full SQL:2011 framing support.[^pg11-frames]

Examples of the same idea expressed three ways over a `salary`-ordered window:

```sql
-- ROWS: exactly the previous 2 physical rows + the current row
sum(salary) OVER (ORDER BY salary ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)

-- RANGE: every row whose salary is within 1000 of the current row's salary
sum(salary) OVER (ORDER BY salary RANGE BETWEEN 1000 PRECEDING AND CURRENT ROW)

-- GROUPS: the current peer group + the previous 2 peer groups
sum(salary) OVER (ORDER BY salary GROUPS BETWEEN 2 PRECEDING AND CURRENT ROW)
```

### Frame bounds and the default frame

The default frame, if you write `OVER (ORDER BY x)` with no explicit frame, is `RANGE UNBOUNDED PRECEDING` — equivalent to `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. This phrasing has a subtlety stated explicitly in the docs[^window-syntax]:

> "With `ORDER BY`, this sets the frame to be all rows from the partition start up through the current row's last `ORDER BY` peer. Without `ORDER BY`, this means all rows of the partition are included in the window frame, since all rows become peers of the current row."

So `RANGE UNBOUNDED PRECEDING` with `ORDER BY` does **not** mean "rows 1 through here." It means "rows 1 through the last row that ties with me on the order key." That is why `sum(x) OVER (ORDER BY y)` over data with ties produces the same value for every tied row.

For a true positional running total, write the frame explicitly:

```sql
sum(x) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
```

The default frame **without** `ORDER BY` is the entire partition. That is why `sum(x) OVER ()` gives every row the partition-wide total.

### `EXCLUDE` clause

`EXCLUDE` removes specific rows from the frame *after* it is computed. The four options[^window-syntax]:

- `EXCLUDE NO OTHERS` (default) — keep everything.
- `EXCLUDE CURRENT ROW` — remove the current row.
- `EXCLUDE GROUP` — remove the current row's entire peer group.
- `EXCLUDE TIES` — keep the current row, but remove the other rows in the peer group.

> [!NOTE] PostgreSQL 11
> `EXCLUDE` was added in PG11. Common use case: computing a per-row metric that compares the row to its neighbors *without* including itself.[^pg11-frames]

### `FILTER` (aggregates only)

Only aggregate-as-window calls (e.g. `sum`, `count`, `avg`, `array_agg`) accept `FILTER`:[^window-syntax]

```sql
-- Count successful events in the rolling window, ignoring failed ones
count(*) FILTER (WHERE status = 'success')
    OVER (ORDER BY ts ROWS BETWEEN 99 PRECEDING AND CURRENT ROW)
```

Pure window functions (`row_number`, `rank`, `lag`, `lead`, `nth_value`, …) do not accept `FILTER`. The grammar accepts the form `lag(x) FILTER (WHERE …) OVER (…)` only because the parser is shared; it will fail at validation. For non-aggregate filtering, use a `CASE` expression inside the function argument or filter in a subquery.

### Named `WINDOW` clause and inheritance

When two or more window functions share the same window specification, define it once:

```sql
SELECT depname, empno, salary,
       sum(salary) OVER w  AS total,
       avg(salary) OVER w  AS mean
FROM empsalary
WINDOW w AS (PARTITION BY depname ORDER BY salary DESC);
```

A named window can also derive from another by name, but the rules are tight[^select-window]:

```sql
WINDOW
    w1 AS (PARTITION BY depname ORDER BY salary DESC),
    w2 AS (w1 ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)
```

- A derived window **inherits** `PARTITION BY` from its parent and **cannot override** it.
- A derived window may add `ORDER BY` **only if the parent did not specify one**.
- A derived window **always uses its own** `frame_clause`; the parent **must not** specify a frame.

This restriction is enforced at parse time. If you want to reuse a partition definition but with different orderings, define the partition in a window without `ORDER BY` and add `ORDER BY` in the derived windows.

### Where window functions are allowed

Window functions are legal only in the `SELECT` list and in the outer `ORDER BY` of the query. They are illegal in `WHERE`, `GROUP BY`, `HAVING`, and in the targets of `INSERT`/`UPDATE`/`DELETE` — because they have not yet been computed when those clauses are evaluated.[^tutorial-window]

The standard workaround is wrap-in-subquery (or CTE):

```sql
SELECT *
FROM (
    SELECT id, dept_id, salary,
           rank() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS r
    FROM employees
) ranked
WHERE r <= 3;
```

### Order of clause evaluation

When a query has both aggregates *and* window functions[^queries-window]:

> "Window functions are evaluated after any grouping, aggregation, and `HAVING` filtering is performed. That is, if the query uses any aggregates, `GROUP BY`, or `HAVING`, then the rows seen by the window functions are the group rows instead of the original table rows from `FROM`/`WHERE`."

So the full evaluation order is:

1. `FROM` (joins, lateral expansions)
2. `WHERE`
3. `GROUP BY`
4. `HAVING`
5. Window functions (`SELECT`-list + outer `ORDER BY`)
6. `SELECT` projection (and non-aggregate expressions involving window output)
7. `DISTINCT` / `DISTINCT ON`
8. Outer `ORDER BY`
9. `LIMIT` / `OFFSET` / `FETCH`

This is why `rank() OVER (ORDER BY count(*))` is legal — `count(*)` is already a value by the time the window function runs.

## Built-in Window Function Catalog

### Ranking: `row_number`, `rank`, `dense_rank`

| Function | Returns | Ties | Use when |
|---|---|---|---|
| `row_number()` | `bigint` | Arbitrary; sequence 1, 2, 3, … | You want a unique row index. Ties are broken by however the planner ordered them — add tiebreakers to `ORDER BY` if it matters. |
| `rank()` | `bigint` | Tied rows get the same rank; gaps follow. E.g. 1, 2, 2, 4. | Sports-style "skip" ranking. |
| `dense_rank()` | `bigint` | Tied rows get the same rank; no gaps. E.g. 1, 2, 2, 3. | "Distinct level" ranking — `dense_rank() = N` means "the Nth distinct value." |

All three ignore the frame entirely — they look at the whole partition's order.[^functions-window]

```sql
SELECT empno, depname, salary,
       row_number() OVER w AS rn,
       rank()       OVER w AS rk,
       dense_rank() OVER w AS drk
FROM empsalary
WINDOW w AS (PARTITION BY depname ORDER BY salary DESC);
```

### Distribution: `percent_rank`, `cume_dist`, `ntile`

| Function | Returns | Meaning |
|---|---|---|
| `percent_rank()` | `double precision` | `(rank - 1) / (count - 1)` — value in `[0, 1]`. First row is always 0; last row is always 1 (unless there is only one row, then 0). |
| `cume_dist()` | `double precision` | `(rows ≤ current) / count` — value in `(0, 1]`. |
| `ntile(N)` | `integer` | Splits the partition into `N` roughly-equal buckets numbered 1..N. Extra rows go into the lower-numbered buckets. |

```sql
SELECT user_id, score,
       percent_rank() OVER (ORDER BY score DESC) AS pr,
       cume_dist()    OVER (ORDER BY score DESC) AS cd,
       ntile(4)       OVER (ORDER BY score DESC) AS quartile
FROM leaderboard;
```

### Value: `lag`, `lead`, `first_value`, `last_value`, `nth_value`

| Function | Signature | Notes |
|---|---|---|
| `lag(value [, offset [, default]])` | `value` from row `offset` rows before. | Ignores frame. `offset` defaults to 1. `default` returned when out of range, defaults to `NULL`. |
| `lead(value [, offset [, default]])` | `value` from row `offset` rows after. | Same defaults as `lag`. |
| `first_value(value)` | `value` at the first row **of the frame** | Frame-sensitive. |
| `last_value(value)` | `value` at the last row **of the frame** | Frame-sensitive — and the default frame ends at the current row's peer, so naive `last_value` *returns the current row*. See gotcha #1. |
| `nth_value(value, n)` | `value` at the Nth row **of the frame**, counting from 1; `NULL` if out of frame. | Frame-sensitive. |

> [!WARNING] No `RESPECT NULLS` / `IGNORE NULLS`
> PostgreSQL does **not** implement the SQL-standard `RESPECT NULLS`/`IGNORE NULLS` options on `lag`, `lead`, `first_value`, `last_value`, or `nth_value`. The behavior is always `RESPECT NULLS` — nulls in the input become nulls in the output. To "ignore nulls", filter them out in a subquery first, or use a `coalesce(...)` trick combined with a conditional.[^functions-window]

> [!WARNING] No `FROM LAST` for `nth_value`
> Only `FROM FIRST` (the default) is implemented. For `FROM LAST` semantics, reverse the window's `ORDER BY`.[^functions-window]

### Aggregates as window functions

Any regular aggregate (`sum`, `avg`, `min`, `max`, `count`, `array_agg`, `string_agg`, `bool_and`, `bool_or`, `every`, etc.) becomes a window function the moment you put `OVER (…)` after the call. Without `OVER`, it is an ordinary aggregate that collapses rows.

```sql
-- Aggregate (collapses):
SELECT dept_id, sum(salary) FROM emp GROUP BY dept_id;

-- Aggregate-as-window (per-row):
SELECT id, dept_id, salary,
       sum(salary) OVER (PARTITION BY dept_id) AS dept_total,
       sum(salary) OVER ()                     AS grand_total
FROM emp;
```

User-defined aggregates work the same way once they are declared with the appropriate kind. Ordered-set and hypothetical-set aggregates (`percentile_cont`, `percentile_disc`, `mode`, `rank` with `WITHIN GROUP`) are *not* window functions — they are aggregates with their own `WITHIN GROUP (ORDER BY …)` syntax. See [`12-aggregates-grouping.md`](./12-aggregates-grouping.md) for those.

## Reading `WindowAgg` in `EXPLAIN`

The plan node for window function evaluation is `WindowAgg` (see [`56-explain.md`](./56-explain.md) for how to read it). It always reads from a `Sort` (or sometimes `Incremental Sort` since PG13) input ordered by `PARTITION BY` keys, then `ORDER BY` keys.

```
 WindowAgg  (cost=... rows=...)
   ->  Sort
         Sort Key: dept_id, salary DESC
         ->  Seq Scan on emp
```

Two performance considerations to watch:

- **One `WindowAgg` per distinct window spec.** If you have three window functions over the same `(PARTITION BY a ORDER BY b)`, the plan has one `WindowAgg`. If you have three over *different* specs, you get three `WindowAgg` nodes stacked, each with its own `Sort` underneath.
- **Use a named `WINDOW` to consolidate.** Even if the function bodies differ, sharing a spec via `WINDOW w AS (…)` lets the planner co-locate them in a single `WindowAgg`.

> [!NOTE] PostgreSQL 14
> Window functions can take advantage of incremental sort (added in PG13). If an index already sorts on a leading subset of the window's `PARTITION BY` / `ORDER BY` keys, the planner can sort just the remaining keys per "group" rather than sorting the whole input.[^pg14-window-incremental-sort]

> [!NOTE] PostgreSQL 14 — infinite-range bug fix
> Frames like `RANGE BETWEEN 'inf' PRECEDING AND 'inf' FOLLOWING` returned incorrect results before PG14. This is a correctness fix worth flagging if you ever wrote a "give me everything in the partition" frame using infinities instead of `UNBOUNDED`.[^pg14-window-inf-fix]

> [!NOTE] PostgreSQL 18
> `EXPLAIN` now shows the arguments to each window function in plan output (previously you could see "WindowAgg" but not which fields it was computing). Window aggregate execution itself was also sped up.[^pg18-window]

## Examples / Recipes

Sample table used throughout:

```sql
CREATE TABLE empsalary (
    depname  text   NOT NULL,
    empno    int    NOT NULL,
    salary   int    NOT NULL,
    enroll_date date NOT NULL
);

INSERT INTO empsalary VALUES
    ('develop',   11, 5200, '2007-08-01'),
    ('develop',   7,  4200, '2008-01-02'),
    ('develop',   9,  4500, '2008-01-02'),
    ('develop',   8,  6000, '2006-10-01'),
    ('develop',   10, 5200, '2007-08-01'),
    ('personnel', 5,  3500, '2007-12-10'),
    ('personnel', 2,  3900, '2006-12-23'),
    ('sales',     3,  4800, '2007-08-01'),
    ('sales',     1,  5000, '2006-10-01'),
    ('sales',     4,  4800, '2007-08-08');
```

### Recipe 1: Top-N per group with `row_number`

The canonical "top 3 highest-paid in each department" query:

```sql
SELECT depname, empno, salary
FROM (
    SELECT depname, empno, salary,
           row_number() OVER (
               PARTITION BY depname
               ORDER BY salary DESC, empno   -- tiebreak deterministically
           ) AS rn
    FROM empsalary
) t
WHERE rn <= 3
ORDER BY depname, rn;
```

The tiebreaker is critical. Without `empno` (or any deterministic secondary key), tied rows would still produce a row_number, but **which** tied row gets number 1 vs 2 vs 3 is undefined and may change between runs. If ties should *all* be kept (i.e. "top 3 ties or fewer"), use `rank()` instead — see recipe 2.

For N=1 specifically, `DISTINCT ON (depname) … ORDER BY depname, salary DESC` is often more efficient and almost always more readable. See the three-way comparison in [`02-syntax-dql.md`](./02-syntax-dql.md).

### Recipe 2: Three-way ties: when to pick `RANK` vs `DENSE_RANK`

Suppose you want "top 3 *distinct* salary levels", keeping all ties:

```sql
SELECT depname, empno, salary
FROM (
    SELECT depname, empno, salary,
           dense_rank() OVER (PARTITION BY depname ORDER BY salary DESC) AS drk
    FROM empsalary
) t
WHERE drk <= 3
ORDER BY depname, drk, empno;
```

Compare to `rank()`, which would give all tied salaries the *same* numeric rank but produce gaps — `1, 1, 3, 4, 4, 6, …`. With `rank() <= 3`, the third distinct salary level is excluded if the top two levels happen to have multiple ties; with `dense_rank()`, that doesn't happen.

| Goal | Pick |
|---|---|
| "Give me 3 rows, no more, no less" — choose arbitrarily on ties | `row_number()` |
| "Give me at least the top N rows, including all ties at the cutoff" | `rank()` |
| "Give me the top N distinct levels, with all rows at those levels" | `dense_rank()` |

### Recipe 3: Running total and running average

Cumulative sum and running mean — **always specify the frame** to avoid the peer-group trap:

```sql
SELECT empno, depname, salary, enroll_date,
       sum(salary) OVER (
           PARTITION BY depname
           ORDER BY enroll_date
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_total,
       avg(salary) OVER (
           PARTITION BY depname
           ORDER BY enroll_date
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       )::numeric(10,2) AS running_avg
FROM empsalary
ORDER BY depname, enroll_date, empno;
```

If you write `sum(salary) OVER (PARTITION BY depname ORDER BY enroll_date)` and two employees share an `enroll_date`, **both rows will show the same running total** — the sum at the end of that peer group. Use `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` to force the conventional row-by-row interpretation.

### Recipe 4: Moving / rolling-window aggregate

The previous N rows including the current — useful for moving averages over events:

```sql
-- 7-day moving average over per-day measurements (one row per day)
SELECT day, value,
       avg(value) OVER (
           ORDER BY day
           ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       )::numeric(10,2) AS ma7
FROM measurements
ORDER BY day;
```

`ROWS` requires that you have **one row per period**. If days can be missing, `ROWS BETWEEN 6 PRECEDING` will average the previous 6 *available* rows, not the previous 6 calendar days. For calendar-day correctness, see recipe 10.

### Recipe 5: Per-row delta from previous row (`lag`)

```sql
SELECT day, reading,
       reading - lag(reading) OVER (ORDER BY day) AS delta
FROM sensor_data
ORDER BY day;
```

`lag()` returns `NULL` for the first row of each partition by default. If you want `0` instead:

```sql
reading - lag(reading, 1, reading) OVER (ORDER BY day) AS delta
```

`lag(reading, 1, reading)` says "the previous reading, but if none, the current reading" — making the first row's delta zero.

### Recipe 6: Gap-and-island detection

Find runs of consecutive days for each user:

```sql
WITH labeled AS (
    SELECT user_id, login_date,
           login_date - (row_number() OVER (PARTITION BY user_id ORDER BY login_date))::int AS grp
    FROM logins
),
islands AS (
    SELECT user_id, grp,
           min(login_date) AS start_date,
           max(login_date) AS end_date,
           count(*)        AS length
    FROM labeled
    GROUP BY user_id, grp
)
SELECT user_id, start_date, end_date, length
FROM islands
ORDER BY user_id, start_date;
```

The trick: subtract a sequential integer from a date. Consecutive dates produce the same difference; gaps shift the difference. Group by that difference to coalesce islands.

### Recipe 7: Sessionization with `lag` + window sum

Classify pageviews into sessions, where a new session starts whenever the gap to the previous view exceeds 30 minutes:

```sql
WITH gapped AS (
    SELECT user_id, ts,
           CASE
               WHEN ts - lag(ts) OVER (PARTITION BY user_id ORDER BY ts)
                        > interval '30 minutes'
                  OR lag(ts) OVER (PARTITION BY user_id ORDER BY ts) IS NULL
               THEN 1 ELSE 0
           END AS is_new_session
    FROM pageviews
),
sessioned AS (
    SELECT user_id, ts,
           sum(is_new_session) OVER (
               PARTITION BY user_id
               ORDER BY ts
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS session_id
    FROM gapped
)
SELECT user_id, session_id, min(ts) AS started, max(ts) AS ended, count(*) AS views
FROM sessioned
GROUP BY user_id, session_id
ORDER BY user_id, session_id;
```

The pattern: per-row 0/1 flag of "is this a session boundary?", then a running sum of that flag to label each row's session.

### Recipe 8: Percentile bucket with `ntile`

```sql
SELECT user_id, score,
       ntile(100) OVER (ORDER BY score) AS pctile_bucket
FROM benchmarks;
```

`ntile(100)` produces percentiles 1..100. If you want the row's `percent_rank()` (a continuous `[0, 1]` value) instead, swap in `percent_rank()`. For the *value at* a specific percentile (e.g. "the p95 latency"), use the ordered-set aggregate `percentile_cont(0.95) WITHIN GROUP (ORDER BY latency)` — that's not a window function. See [`12-aggregates-grouping.md`](./12-aggregates-grouping.md).

### Recipe 9: First / last value over a per-group window done correctly

`last_value` with a default frame returns the current row's value, not the partition maximum (see Gotcha #1). The correct form that covers the whole partition:

```sql
SELECT empno, depname, salary,
       first_value(salary) OVER w AS dept_min,
       last_value(salary)  OVER w AS dept_max
FROM empsalary
WINDOW w AS (
    PARTITION BY depname
    ORDER BY salary
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
)
ORDER BY depname, salary;
```

The `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` frame is the canonical "I want the function applied to the whole partition" override. For *just* the min and max per partition, `min()` and `max()` as window functions are simpler:

```sql
SELECT empno, depname, salary,
       min(salary) OVER (PARTITION BY depname) AS dept_min,
       max(salary) OVER (PARTITION BY depname) AS dept_max
FROM empsalary;
```

Window-aggregate `min`/`max`/`sum`/`avg`/`count` without `ORDER BY` use the whole-partition default frame and are the right tool here.

### Recipe 10: Time-series moving aggregate with `RANGE` interval

Calendar-aware moving averages (7-day rolling window over a timestamp column, allowing gaps):

```sql
SELECT ts, value,
       avg(value) OVER (
           ORDER BY ts
           RANGE BETWEEN interval '7 days' PRECEDING AND CURRENT ROW
       )::numeric(10,2) AS ma_7d
FROM measurements
ORDER BY ts;
```

> [!NOTE] PostgreSQL 11
> `RANGE BETWEEN '7 days' PRECEDING …` (offset with `RANGE`) requires PG11+.[^pg11-frames]

`RANGE` with a `date`/`timestamp` column requires that the offset be an `interval`. Mismatched types raise an error at parse time.

### Recipe 11: Conditional aggregation via `FILTER`

```sql
SELECT order_id, ts, status,
       count(*) FILTER (WHERE status = 'fulfilled')
           OVER (
               PARTITION BY customer_id
               ORDER BY ts
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS fulfilled_count_so_far
FROM orders;
```

`FILTER` is preferred over `sum(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END)` because:

- It is clearer.
- It produces NULL (not 0) when no row matches inside the frame — sometimes useful.
- Some aggregates (e.g. `array_agg`) cannot easily be filtered with `CASE` without producing arrays of NULLs.

### Recipe 12: Pagination cursor using window output

When you want stable, deep pagination based on a deterministic ranking, keep the window output in the result:

```sql
SELECT id, name, last_active,
       row_number() OVER (ORDER BY last_active DESC, id) AS rn
FROM users
ORDER BY last_active DESC, id
LIMIT 50 OFFSET 0;
```

Use the `rn` value as the page cursor. For "next page after `rn = 50`":

```sql
WITH paged AS (
    SELECT id, name, last_active,
           row_number() OVER (ORDER BY last_active DESC, id) AS rn
    FROM users
)
SELECT id, name, last_active
FROM paged
WHERE rn BETWEEN 51 AND 100;
```

For deep pagination, **keyset cursors are faster** than `row_number()` ranges — see [`02-syntax-dql.md`](./02-syntax-dql.md). The window-based form is useful only when the ordering keys are not unique on their own.

## Gotchas / Anti-patterns

1. **`last_value` looks broken.** The default frame ends at the current row's peer, so `last_value(x) OVER (ORDER BY x)` returns the current row's value, not the partition's last value. Fix: write `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` explicitly, or use `max(x) OVER (PARTITION BY …)` if you actually want the maximum. This is the single most-asked window-function question on Stack Overflow.[^functions-window]
2. **Filtering on a window result inside `WHERE`.** Illegal — window functions evaluate after `WHERE`. Wrap in a subquery or CTE. Same for `GROUP BY`/`HAVING`.[^tutorial-window]
3. **Running total ties give duplicate values.** `sum(x) OVER (ORDER BY ts)` over rows with equal `ts` produces the same running total for each tied row. The cause is the same default frame described in gotcha #1. Fix: `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`.
4. **`row_number()` ordering with ties is nondeterministic.** Without a tiebreaker, two equivalent `row_number()` calls in the same query *are* guaranteed to agree, but across runs the assignment among tied rows may change. Always add a deterministic tiebreaker (e.g. primary key) to the `ORDER BY` when the number itself is significant.
5. **No `IGNORE NULLS`.** `lag(x)` over `(NULL, 1, NULL, 2)` returns `(_, NULL, 1, NULL)` — not `(_, _, 1, 1)`. To skip nulls, pre-filter in a CTE or use `coalesce(lag(x), lag(x, 2), lag(x, 3), …)`. There is no clean primitive for this; the SQL-standard `IGNORE NULLS` option is not implemented.[^functions-window]
6. **`PARTITION BY` doesn't trigger `GROUP BY` semantics.** A window function never collapses rows. If you write `SELECT dept_id, sum(salary) OVER (PARTITION BY dept_id) FROM emp`, you get *one row per employee*, all rows for a given dept showing the same sum. Use `GROUP BY` if you want one row per dept.
7. **Window functions inside aggregates is illegal.** Aggregates evaluate before window functions, so an aggregate cannot reference a window result. The reverse is fine: a window function may receive an aggregate value as input.[^tutorial-window]
8. **`FILTER` on pure window functions.** `row_number() FILTER (WHERE …) OVER (…)` is rejected. Only aggregates accept `FILTER`. Use a `CASE` inside the function argument, or restructure with a subquery that excludes the filtered rows.
9. **Frame mode mismatch with offset type.** `RANGE BETWEEN 7 PRECEDING …` over a `timestamp`-ordered window throws "RANGE with offset PRECEDING/FOLLOWING is not supported for column type timestamp without time zone and offset type integer". The offset must be `interval`. With `ROWS`, the offset is always an integer regardless of column type.
10. **Two `WindowAgg` nodes for one query.** Two window functions with *different* `OVER` clauses produce two `WindowAgg` nodes, each with its own sort. If the specs are equivalent, use a named `WINDOW` clause (see [Reading `WindowAgg` in `EXPLAIN`](#reading-windowagg-in-explain)) to consolidate them into one node.
11. **`ntile(N)` doesn't give equal buckets when partition size isn't divisible by N.** Extra rows go into the *lower-numbered* buckets. So `ntile(4)` over 10 rows gives bucket sizes (3, 3, 2, 2), not (3, 3, 3, 1) — but specifically the first two buckets are larger, not the last two. If you need balanced buckets, use a custom `floor((row_number()-1) * N / count)` expression.
12. **Window functions and parallel queries.** Window functions themselves are not marked PARALLEL UNSAFE, but the planner historically didn't parallelize the `WindowAgg` node. Parallel scans below `WindowAgg` work, but the window-aggregate step itself runs in the leader. Check `EXPLAIN ANALYZE` to confirm — if you see `Gather` *below* `WindowAgg`, the scan is parallel but the window step isn't.
13. **`UNBOUNDED FOLLOWING` reads the rest of the partition.** Frames extending to `UNBOUNDED FOLLOWING` (or any FOLLOWING offset) force the executor to buffer subsequent rows, which costs memory proportional to the partition size. Avoid for very large partitions when you only need preceding rows.
14. **`RANGE` frames over non-unique `ORDER BY` are peer-sensitive.** Any frame where `frame_start = CURRENT ROW` includes all peers, not just the current row. To exclude peers, use `EXCLUDE GROUP` or `EXCLUDE TIES`; to keep only the current row, use `EXCLUDE GROUP` after extending the frame to peers.
15. **DISTINCT before vs after window function.** `DISTINCT` runs *after* window functions, so `SELECT DISTINCT id, row_number() OVER (…) FROM …` will not deduplicate on `id` alone — each row's `row_number()` value participates in the distinct comparison. Either drop `DISTINCT` or pre-deduplicate in a subquery.

## See Also

- [`02-syntax-dql.md`](./02-syntax-dql.md) — the three-way "top-N per group" comparison (`DISTINCT ON` vs `LATERAL` vs window function); outer `ORDER BY` semantics; logical-evaluation-order sidebar.
- [`04-ctes.md`](./04-ctes.md) — the canonical CTE wrapper pattern for filtering on window output; recursive CTEs for true graph/tree problems that windows can't express.
- [`12-aggregates-grouping.md`](./12-aggregates-grouping.md) — ordered-set aggregates (`percentile_cont`, `percentile_disc`), hypothetical-set aggregates, `GROUPING SETS` / `ROLLUP` / `CUBE`; `FILTER` for regular aggregates.
- [`56-explain.md`](./56-explain.md) — reading `WindowAgg` and the sort it sits on; spotting row-count misestimates that hurt window plans.
- [`59-planner-tuning.md`](./59-planner-tuning.md) — `enable_incremental_sort`; cost-tuning when a window query falls back to an external sort.

## Sources

[^tutorial-window]: PostgreSQL 16 manual, "3.5. Window Functions" — defines window function semantics, the `OVER` clause, `PARTITION BY`, the default frame ("the frame consists of all rows from the start of the partition up through the current row, plus any following rows that are equal to the current row according to the `ORDER BY` clause"), the rule that window functions are only allowed in `SELECT` and `ORDER BY` ("they are forbidden elsewhere, such as in `GROUP BY`, `HAVING` and `WHERE` clauses"), and that window functions evaluate after non-window aggregates. https://www.postgresql.org/docs/16/tutorial-window.html

[^window-syntax]: PostgreSQL 16 manual, "4.2.8. Window Function Calls" — full grammar for `OVER (window_definition)`, `frame_clause`, `frame_exclusion`, `FILTER`. Contains the verbatim rules: "frame_start cannot be UNBOUNDED FOLLOWING", "frame_end cannot be UNBOUNDED PRECEDING", "the frame_end choice cannot appear earlier in the above list of frame_start and frame_end options than the frame_start choice does", and the RANGE-offset constraint "These options require that the `ORDER BY` clause specify exactly one column." Also the default-frame statement: "The default framing option is `RANGE UNBOUNDED PRECEDING`, which is the same as `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. With `ORDER BY`, this sets the frame to be all rows from the partition start up through the current row's last `ORDER BY` peer." https://www.postgresql.org/docs/16/sql-expressions.html#SYNTAX-WINDOW-FUNCTIONS

[^functions-window]: PostgreSQL 16 manual, "9.22. Window Functions" — signatures and semantics for `row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`, `lag`, `lead`, `first_value`, `last_value`, `nth_value`. Contains the verbatim rule that PostgreSQL "does not support the SQL standard's `RESPECT NULLS` or `IGNORE NULLS` option; the behavior is always the same as the standard's default, namely `RESPECT NULLS`" and the rule that for `nth_value` "only the default `FROM FIRST` behavior is supported." Also defines that aggregates "act as window functions only when an `OVER` clause follows the call." https://www.postgresql.org/docs/16/functions-window.html

[^queries-window]: PostgreSQL 16 manual, "7.2.5. Window Function Processing" — establishes evaluation order. Verbatim: "If the query contains any window functions, these functions are evaluated after any grouping, aggregation, and `HAVING` filtering is performed. That is, if the query uses any aggregates, `GROUP BY`, or `HAVING`, then the rows seen by the window functions are the group rows instead of the original table rows from `FROM`/`WHERE`." Also: "When multiple window functions are used, all the window functions having equivalent `PARTITION BY` and `ORDER BY` clauses in their window definitions are guaranteed to see the same ordering of the input rows, even if the `ORDER BY` does not uniquely determine the ordering." https://www.postgresql.org/docs/16/queries-table-expressions.html#QUERIES-WINDOW

[^select-window]: PostgreSQL 16 manual, "SELECT" reference page, `WINDOW` clause subsection — grammar for `WINDOW window_name AS ( window_definition )` and the named-window inheritance rules. Verbatim: "If an `existing_window_name` is specified it must refer to an earlier entry in the `WINDOW` list; the new window copies its partitioning clause from that entry, as well as its ordering clause if any. In this case the new window cannot specify its own `PARTITION BY` clause, and it can specify `ORDER BY` only if the copied window does not have one. The new window always uses its own frame clause; the copied window must not specify a frame clause." https://www.postgresql.org/docs/16/sql-select.html

[^pg11-frames]: PostgreSQL 11 release notes, "E.23.3.5. Functions". Verbatim: "Add all window function framing options specified by SQL:2011 (Oliver Ford, Tom Lane). Specifically, allow `RANGE` mode to use `PRECEDING` and `FOLLOWING` to select rows having grouping values within plus or minus the specified offset. Add `GROUPS` mode to include plus or minus the number of peer groups. Frame exclusion syntax was also added." https://www.postgresql.org/docs/release/11.0/

[^pg14-window-incremental-sort]: PostgreSQL 14 release notes, "E.23.3.1.5. General Performance". Verbatim: "Allow window functions to perform incremental sorts (David Rowley)." Incremental sort itself was added in PG13 — this entry extends its use to window-function sorting. https://www.postgresql.org/docs/release/14.0/

[^pg14-window-inf-fix]: PostgreSQL 14 release notes, "E.23.2. Migration to Version 14". Verbatim: "Fix handling of infinite window function ranges (Tom Lane). Previously window frame clauses like `'inf' PRECEDING AND 'inf' FOLLOWING` returned incorrect results." https://www.postgresql.org/docs/release/14.0/

[^pg18-window]: PostgreSQL 18 release notes, "E.4.3.1.1. Optimizer" — "Speed up the processing of `INTERSECT`, `EXCEPT`, window aggregates, and view column aliases (Tom Lane, David Rowley)." And "E.4.3.2.3. EXPLAIN" — "Add details about window function arguments to `EXPLAIN` output (Tom Lane)." https://www.postgresql.org/docs/release/18.0/

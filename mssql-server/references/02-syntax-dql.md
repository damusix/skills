# 02 — DQL: SELECT, JOINs, Subqueries, Set Operators, Window Functions, PIVOT

## Table of Contents

1. [When to use this file](#when-to-use-this-file)
2. [SELECT fundamentals](#select-fundamentals)
3. [FROM and JOINs](#from-and-joins)
4. [Subqueries and correlated subqueries](#subqueries-and-correlated-subqueries)
5. [APPLY (CROSS APPLY / OUTER APPLY)](#apply-cross-apply--outer-apply)
6. [Set operators](#set-operators)
7. [Window functions](#window-functions)
   - [ROWS vs RANGE framing](#rows-vs-range-framing)
   - [Ranking functions](#ranking-functions)
   - [Offset functions: LAG / LEAD / FIRST_VALUE / LAST_VALUE](#offset-functions-lag--lead--first_value--last_value)
   - [Aggregate window functions](#aggregate-window-functions)
   - [NTILE](#ntile)
8. [PIVOT and UNPIVOT](#pivot-and-unpivot)
9. [Pagination: OFFSET / FETCH](#pagination-offset--fetch)
10. [TOP and PERCENT](#top-and-percent)
11. [Gotchas and anti-patterns](#gotchas-and-anti-patterns)
12. [See also](#see-also)
13. [Sources](#sources)

---

## When to use this file

Load this file when the question involves any read-only T-SQL query: `SELECT` structure, join types, subqueries, `APPLY`, `UNION`/`INTERSECT`/`EXCEPT`, window functions, `PIVOT`/`UNPIVOT`, or result-set pagination. For write operations (`INSERT`, `UPDATE`, `DELETE`, `MERGE`) see `03-syntax-dml.md`. For query execution plans and performance see `29-query-plans.md`.

---

## SELECT fundamentals

```sql
SELECT  [TOP (n) [PERCENT] [WITH TIES]]
        select_list
FROM    table_source
[WHERE  search_condition]
[GROUP BY [ALL | ROLLUP | CUBE | GROUPING SETS] grouping_columns]
[HAVING  aggregate_condition]
[ORDER BY  sort_expression [ASC | DESC] [NULLS FIRST | NULLS LAST]]
[OFFSET n ROWS FETCH NEXT m ROWS ONLY];
```

Logical processing order (not textual order) [^3]:
1. `FROM` / `JOIN` — build the virtual table
2. `WHERE` — filter rows
3. `GROUP BY` — group rows
4. `HAVING` — filter groups
5. `SELECT` — evaluate expressions and apply `DISTINCT`
6. `ORDER BY` — sort
7. `OFFSET` / `FETCH` — paginate

> [!WARNING] Deprecated
> `SELECT *` in production code. Always name columns explicitly — schema changes silently break column-position-dependent code. Last safe: every version, but always a bad practice.

### DISTINCT vs GROUP BY

`DISTINCT` deduplicates the entire projection. `GROUP BY` groups for aggregation. They produce the same result *only* when no aggregate functions are used; `GROUP BY` is preferred when aggregates are needed because intent is clear and the optimizer can sometimes use an index seek rather than a sort.

```sql
-- Equivalent when no aggregates are needed
SELECT DISTINCT department_id FROM employees;
SELECT department_id FROM employees GROUP BY department_id;

-- Only GROUP BY can aggregate
SELECT department_id, COUNT(*) AS head_count
FROM   employees
GROUP BY department_id
HAVING COUNT(*) > 5;
```

### GROUPING SETS, ROLLUP, CUBE

```sql
-- ROLLUP: hierarchical subtotals (year → quarter → month)
SELECT YEAR(order_date)  AS yr,
       MONTH(order_date) AS mo,
       SUM(amount)       AS total
FROM   orders
GROUP BY ROLLUP(YEAR(order_date), MONTH(order_date));

-- CUBE: all combinations of grouping columns
SELECT region, product_category, SUM(amount)
FROM   sales
GROUP BY CUBE(region, product_category);

-- GROUPING SETS: explicit control
SELECT region, product_category, SUM(amount)
FROM   sales
GROUP BY GROUPING SETS
(
    (region, product_category),  -- detail
    (region),                    -- region subtotal
    ()                           -- grand total
);
```

`GROUPING(col)` returns 1 when the row is a super-aggregate null (rollup placeholder), 0 otherwise. Use it to distinguish rollup nulls from real nulls. [^1]

---

## FROM and JOINs

### Join types

| Join | Returns |
|------|---------|
| `INNER JOIN` | Only rows where the condition matches in both tables |
| `LEFT [OUTER] JOIN` | All left rows; NULLs for unmatched right columns |
| `RIGHT [OUTER] JOIN` | All right rows; NULLs for unmatched left columns |
| `FULL [OUTER] JOIN` | All rows from both; NULLs where no match |
| `CROSS JOIN` | Cartesian product — every combination |
| `SELF JOIN` | Table joined to itself using aliases |

```sql
-- Standard inner join
SELECT e.last_name, d.department_name
FROM   employees   AS e
INNER JOIN departments AS d ON e.department_id = d.department_id;

-- Left join — keep employees even with no department
SELECT e.last_name, d.department_name
FROM   employees   AS e
LEFT  JOIN departments AS d ON e.department_id = d.department_id;

-- Full outer — surface unmatched rows from either side
SELECT e.last_name, d.department_name
FROM   employees   AS e
FULL OUTER JOIN departments AS d ON e.department_id = d.department_id;

-- Cross join — all combinations (use with care)
SELECT c.color, s.size
FROM   colors AS c
CROSS JOIN sizes AS s;
```

### Non-equi joins

JOINs do not require equality. Any predicate works:

```sql
-- Range join: assign salary band
SELECT e.last_name, b.band_name
FROM   employees    AS e
JOIN   salary_bands AS b
    ON e.salary BETWEEN b.low AND b.high;
```

### Old-style implicit joins (avoid)

```sql
-- Bad: implicit join syntax (ANSI-89) — still valid SQL Server but avoid
SELECT e.last_name, d.department_name
FROM   employees e, departments d
WHERE  e.department_id = d.department_id;
```

The `WHERE`-based join syntax makes accidental Cartesian products easy. Always use explicit `JOIN` syntax.

### NULL matching in joins

A join on `a.col = b.col` will never match rows where either side is `NULL` — `NULL = NULL` is `UNKNOWN`, not `TRUE`. To intentionally match NULLs on both sides:

```sql
-- SQL Server 2022+: IS DISTINCT FROM / IS NOT DISTINCT FROM
SELECT * FROM a JOIN b ON a.col IS NOT DISTINCT FROM b.col;

-- Pre-2022 equivalent
SELECT * FROM a JOIN b
    ON (a.col = b.col OR (a.col IS NULL AND b.col IS NULL));
```

> [!NOTE] SQL Server 2022
> `IS [NOT] DISTINCT FROM` treats NULLs as equal, making NULL-safe equality comparisons concise [^2].

---

## Subqueries and correlated subqueries

### Scalar subquery

Returns exactly one row and one column. Can appear in `SELECT`, `WHERE`, or `HAVING`.

```sql
SELECT department_id,
       (SELECT department_name FROM departments d WHERE d.department_id = e.department_id)
           AS dept_name
FROM   employees AS e;
```

A scalar subquery that returns more than one row raises runtime error 512. Guard with `TOP 1` or use a join instead when cardinality is uncertain.

### IN / NOT IN with subquery

```sql
-- Employees in departments that have a budget > 100000
SELECT last_name
FROM   employees
WHERE  department_id IN (SELECT department_id FROM departments WHERE budget > 100000);
```

> [!WARNING] Deprecated
> `NOT IN` when the subquery can return NULLs. `NOT IN (1, 2, NULL)` always returns no rows because `col NOT IN (... NULL ...)` evaluates to UNKNOWN. Prefer `NOT EXISTS` instead.

```sql
-- Safe alternative
SELECT last_name
FROM   employees e
WHERE  NOT EXISTS (
    SELECT 1 FROM departments d
    WHERE  d.department_id = e.department_id
    AND    d.budget <= 100000
);
```

### EXISTS / NOT EXISTS

Correlated; evaluates to TRUE/FALSE. The optimizer short-circuits on the first matching row — preferred over `IN` for large subquery result sets.

```sql
SELECT last_name
FROM   employees AS e
WHERE  EXISTS (
    SELECT 1
    FROM   orders AS o
    WHERE  o.employee_id = e.employee_id
);
```

### Derived tables

A subquery in the `FROM` clause. Must have an alias.

```sql
SELECT dept_name, avg_salary
FROM (
    SELECT d.department_name AS dept_name,
           AVG(e.salary)     AS avg_salary
    FROM   employees   AS e
    JOIN   departments AS d ON e.department_id = d.department_id
    GROUP BY d.department_name
) AS dept_avg
WHERE avg_salary > 80000;
```

For reusable derived tables across multiple references in the same query, prefer CTEs (see `04-ctes.md`).

---

## APPLY (CROSS APPLY / OUTER APPLY)

`APPLY` is a T-SQL extension (not standard SQL) that invokes a table-valued expression once per row of the left table. Essential for row-by-row TVF calls or lateral correlation.

| | Behaviour |
|---|---|
| `CROSS APPLY` | Only rows from left that produce at least one row from the right expression |
| `OUTER APPLY` | All rows from left; NULLs for right expression when it returns no rows |

Analogous to `INNER JOIN` vs `LEFT JOIN` for table expressions that depend on outer values.

```sql
-- CROSS APPLY: call an inline TVF per employee
SELECT e.last_name, t.total_sales
FROM   employees AS e
CROSS APPLY dbo.fn_EmployeeSales(e.employee_id) AS t;

-- OUTER APPLY: top N per group (classic pattern)
SELECT c.customer_name, r.order_id, r.order_date
FROM   customers AS c
OUTER APPLY (
    SELECT TOP (3) o.order_id, o.order_date
    FROM   orders AS o
    WHERE  o.customer_id = c.customer_id
    ORDER BY o.order_date DESC
) AS r;
```

The "top N per group" pattern with `OUTER APPLY` is a standard T-SQL idiom. The window function alternative (`ROW_NUMBER()`) is often more efficient on larger datasets because it avoids the correlated execution; benchmark both.

```sql
-- Window function alternative for top-N per group
WITH ranked AS (
    SELECT c.customer_name,
           o.order_id,
           o.order_date,
           ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.order_date DESC) AS rn
    FROM   orders    AS o
    JOIN   customers AS c ON c.customer_id = o.customer_id
)
SELECT customer_name, order_id, order_date
FROM   ranked
WHERE  rn <= 3;
```

---

## Set operators

All set operators require matching column count and compatible data types. Column names in the result come from the **first** query.

| Operator | Description |
|----------|-------------|
| `UNION` | All rows from both, duplicates removed |
| `UNION ALL` | All rows from both, duplicates kept |
| `INTERSECT` | Rows present in both result sets |
| `EXCEPT` | Rows in first but not in second |

```sql
-- UNION: combine active and archived customers
SELECT customer_id, name FROM customers_active
UNION
SELECT customer_id, name FROM customers_archived;

-- UNION ALL: faster than UNION when duplicates are acceptable or impossible
SELECT product_id FROM orders_2023
UNION ALL
SELECT product_id FROM orders_2024;

-- INTERSECT: products ordered in both years
SELECT product_id FROM orders_2023
INTERSECT
SELECT product_id FROM orders_2024;

-- EXCEPT: products ordered in 2023 but not 2024
SELECT product_id FROM orders_2023
EXCEPT
SELECT product_id FROM orders_2024;
```

**Ordering set operator results:** Place a single `ORDER BY` clause after the last query. Reference columns by position or by the alias assigned in the first query.

```sql
SELECT customer_id, name FROM customers_active
UNION ALL
SELECT customer_id, name FROM customers_archived
ORDER BY name;
```

> **Best practice:** Prefer `UNION ALL` over `UNION` unless duplicate elimination is genuinely required. `UNION` adds a blocking sort/hash operator that can be expensive on large inputs.

---

## Window functions

Window functions compute a value across a set of rows *related to the current row* without collapsing them (unlike `GROUP BY`). Available for: `SELECT` and `ORDER BY` clauses only — not in `WHERE` or `HAVING`. [^4]

```sql
function_name(...) OVER (
    [PARTITION BY partition_expression [, ...]]
    [ORDER BY     sort_expression      [ASC | DESC] [, ...]]
    [ROWS | RANGE BETWEEN frame_start AND frame_end]
)
```

### ROWS vs RANGE framing

| | `ROWS` | `RANGE` |
|---|---|---|
| Unit | Physical rows | Logical values |
| Ties | Handled exactly — each row is distinct | All rows with the same ORDER BY value included in window |
| Frame boundary | Exact | Value-based — all rows with equal sort key at boundary included |
| Performance | Generally faster (no sort-tie lookup) | Slower when ties exist |
| Default frame (when ORDER BY present, no explicit frame) | `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | same |

```sql
-- ROWS: running sum, each row counted once
SELECT order_id,
       amount,
       SUM(amount) OVER (ORDER BY order_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM   orders;

-- RANGE: running sum including all rows with the same order_date as current row
SELECT order_id,
       amount,
       SUM(amount) OVER (ORDER BY order_date RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total_range
FROM   orders;
```

> **Best practice:** Be explicit about the frame. When you want a running aggregate, use `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Relying on the implicit default (`RANGE ... CURRENT ROW`) causes confusing results with ties.

Frame boundary keywords:

| Keyword | Meaning |
|---------|---------|
| `UNBOUNDED PRECEDING` | First row of the partition |
| `n PRECEDING` | n rows/values before current |
| `CURRENT ROW` | Current row |
| `n FOLLOWING` | n rows/values after current |
| `UNBOUNDED FOLLOWING` | Last row of the partition |

```sql
-- Sliding 7-day moving average
SELECT order_date,
       AVG(daily_total) OVER (
           ORDER BY order_date
           ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ) AS moving_avg_7d
FROM   daily_sales;
```

### Ranking functions

```sql
SELECT
    last_name,
    salary,
    ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY salary DESC) AS row_num,
    RANK()       OVER (PARTITION BY department_id ORDER BY salary DESC) AS rnk,
    DENSE_RANK() OVER (PARTITION BY department_id ORDER BY salary DESC) AS dense_rnk,
    NTILE(4)     OVER (PARTITION BY department_id ORDER BY salary DESC) AS quartile
FROM employees;
```

| Function | Behavior on ties |
|----------|-----------------|
| `ROW_NUMBER()` | Unique integers — ties get arbitrary but distinct numbers |
| `RANK()` | Tied rows get same rank; next rank skips (1,1,3) |
| `DENSE_RANK()` | Tied rows get same rank; no skip (1,1,2) |
| `NTILE(n)` | Distributes rows into n buckets; larger buckets come first if not evenly divisible |

### Offset functions: LAG / LEAD / FIRST_VALUE / LAST_VALUE

```sql
SELECT
    order_date,
    amount,
    LAG (amount, 1, 0) OVER (PARTITION BY customer_id ORDER BY order_date) AS prev_amount,
    LEAD(amount, 1, 0) OVER (PARTITION BY customer_id ORDER BY order_date) AS next_amount
FROM orders;
```

`LAG(col, offset, default)` and `LEAD(col, offset, default)` — offset defaults to 1; default value substituted when there is no prior/next row.

```sql
-- FIRST_VALUE / LAST_VALUE: value from first or last row in window frame
SELECT
    order_date,
    amount,
    FIRST_VALUE(amount) OVER (PARTITION BY customer_id ORDER BY order_date
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS first_order,
    LAST_VALUE (amount) OVER (PARTITION BY customer_id ORDER BY order_date
                              ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS last_order
FROM orders;
```

> **Gotcha: LAST_VALUE frame trap.** Without an explicit `ROWS BETWEEN ... UNBOUNDED FOLLOWING` frame, `LAST_VALUE` uses the default frame (`RANGE ... CURRENT ROW`) and returns the *current row's value*, not the partition's last. Always specify the frame explicitly.

### Aggregate window functions

Any aggregate (`SUM`, `AVG`, `COUNT`, `MIN`, `MAX`, `STRING_AGG`) can be used as a window function by adding `OVER(...)`.

```sql
-- Percentage of department total
SELECT
    last_name,
    salary,
    SUM(salary) OVER (PARTITION BY department_id)                         AS dept_total,
    ROUND(100.0 * salary / SUM(salary) OVER (PARTITION BY department_id), 2) AS pct_of_dept
FROM employees;
```

### NTILE

Distributes rows into *n* approximately equal buckets. Useful for quartiles, deciles.

```sql
SELECT
    last_name,
    salary,
    NTILE(4) OVER (ORDER BY salary) AS salary_quartile
FROM employees;
```

If the row count is not evenly divisible by n, the first `(row_count % n)` buckets get one extra row.

---

## PIVOT and UNPIVOT

`PIVOT` rotates rows into columns; `UNPIVOT` does the reverse. [^5]

### PIVOT

```sql
-- Monthly sales per product as columns
SELECT *
FROM (
    SELECT product_id,
           DATENAME(MONTH, order_date) AS month_name,
           amount
    FROM   orders
) AS src
PIVOT (
    SUM(amount)
    FOR month_name IN ([January], [February], [March], [April],
                       [May], [June], [July], [August],
                       [September], [October], [November], [December])
) AS pvt;
```

Column list in `FOR ... IN (...)` must be known at compile time — use dynamic SQL if columns are runtime values.

```sql
-- Dynamic PIVOT pattern
DECLARE @cols  NVARCHAR(MAX),
        @sql   NVARCHAR(MAX);

SELECT @cols = STRING_AGG(QUOTENAME(month_name), ', ')
FROM (SELECT DISTINCT DATENAME(MONTH, order_date) AS month_name FROM orders) AS t;

SET @sql = N'
SELECT *
FROM (
    SELECT product_id, DATENAME(MONTH, order_date) AS month_name, amount
    FROM   orders
) AS src
PIVOT (SUM(amount) FOR month_name IN (' + @cols + N')) AS pvt;';

EXEC sp_executesql @sql;
```

### UNPIVOT

```sql
-- Column-per-quarter → row-per-quarter
SELECT product_id, quarter, sales
FROM (
    SELECT product_id, q1, q2, q3, q4
    FROM   quarterly_sales
) AS src
UNPIVOT (
    sales FOR quarter IN (q1, q2, q3, q4)
) AS unpvt;
```

UNPIVOT drops rows where the value column is NULL. If nulls matter, use `CROSS APPLY` with `VALUES()` instead:

```sql
SELECT product_id, quarter, sales
FROM   quarterly_sales AS s
CROSS APPLY (VALUES ('q1', s.q1), ('q2', s.q2), ('q3', s.q3), ('q4', s.q4))
             AS t(quarter, sales)
WHERE  t.sales IS NOT NULL;  -- remove WHERE to keep NULLs
```

---

## Pagination: OFFSET / FETCH

`OFFSET ... FETCH NEXT ... ROWS ONLY` is the ANSI-standard pagination syntax. Available since SQL Server 2012. Requires `ORDER BY`. [^6]

```sql
-- Page 3 of 20-row pages (rows 41–60)
SELECT product_id, product_name, price
FROM   products
ORDER  BY product_name
OFFSET 40 ROWS
FETCH  NEXT 20 ROWS ONLY;
```

Parameterized version for application code:

```sql
DECLARE @page_number  INT = 3,
        @page_size    INT = 20;

SELECT product_id, product_name, price
FROM   products
ORDER  BY product_name
OFFSET (@page_number - 1) * @page_size ROWS
FETCH  NEXT @page_size ROWS ONLY;
```

> **Best practice:** For stable, consistent pagination, include a tiebreaker column (e.g., primary key) in `ORDER BY`. Without a deterministic sort, rows can appear on multiple pages or be skipped when data changes between page requests.

> **Performance note:** Deep offsets (`OFFSET 100000 ROWS`) require the engine to read and discard all preceding rows. For large skip values, use a keyset/seek pagination pattern instead:

```sql
-- Keyset pagination: more efficient for deep pages
SELECT TOP (20) product_id, product_name, price
FROM   products
WHERE  product_name > @last_seen_name   -- last name from previous page
    OR (product_name = @last_seen_name AND product_id > @last_seen_id)
ORDER  BY product_name, product_id;
```

---

## TOP and PERCENT

```sql
-- Top 10 by salary
SELECT TOP (10) last_name, salary
FROM   employees
ORDER  BY salary DESC;

-- Top 10 percent
SELECT TOP (10) PERCENT last_name, salary
FROM   employees
ORDER  BY salary DESC;

-- WITH TIES: include all rows that tie at the boundary
SELECT TOP (10) WITH TIES last_name, salary
FROM   employees
ORDER  BY salary DESC;
```

> **Gotcha:** `TOP` without `ORDER BY` returns an arbitrary subset — the same query may return different rows on different executions depending on the physical storage and parallelism. Always pair with `ORDER BY` unless you genuinely want any N rows.

`TOP` in DML (`UPDATE TOP (n)`, `DELETE TOP (n)`) operates on an arbitrary set of rows — there is no `ORDER BY` for DML `TOP`. Use a subquery with `ROW_NUMBER()` if ordered DML is needed (see `03-syntax-dml.md`).

---

## Gotchas and anti-patterns

### Implicit type conversion in WHERE / JOIN predicates

```sql
-- Bad: function on indexed column defeats the index
WHERE CONVERT(VARCHAR, order_date, 101) = '01/15/2024'

-- Good: apply the conversion to the constant
WHERE order_date = CONVERT(DATE, '01/15/2024', 101)
```

Similarly, comparing a `VARCHAR` column to a `NVARCHAR` literal causes an implicit conversion that may suppress a seek (`N'value'` vs `'value'`). Check for implicit conversion warnings in execution plans.

### Sargability

A predicate is *sargable* (Search ARGument able) when the optimizer can use an index seek. Non-sargable predicates force a scan:

| Non-sargable | Sargable alternative |
|---|---|
| `WHERE YEAR(order_date) = 2024` | `WHERE order_date >= '2024-01-01' AND order_date < '2025-01-01'` |
| `WHERE LEFT(last_name, 3) = 'Smi'` | `WHERE last_name LIKE 'Smi%'` |
| `WHERE salary + 1000 > 80000` | `WHERE salary > 79000` |
| `WHERE LTRIM(RTRIM(code)) = 'ABC'` | Fix data quality at insert time; or use a computed column |

### OR in WHERE can suppress index seeks

```sql
-- May cause a scan if OR spans different columns
WHERE department_id = 5 OR manager_id = 10

-- Rewrite as UNION ALL (each branch can use its own index)
SELECT * FROM employees WHERE department_id = 5
UNION ALL
SELECT * FROM employees WHERE manager_id = 10
    AND department_id <> 5;  -- avoid duplicates if needed
```

### COUNT(*) vs COUNT(column)

`COUNT(*)` counts all rows; `COUNT(col)` counts non-NULL values. Use `COUNT(*)` when you want row count; use `COUNT(col)` intentionally when NULLs should be excluded.

### SELECT INTO vs INSERT INTO ... SELECT

`SELECT INTO` creates a new table and inserts data — minimal logging under simple recovery, but locks `tempdb` system tables, cannot be used with an existing table, and doesn't create indexes. `INSERT INTO ... SELECT` inserts into an existing table and can be minimally logged too (see `03-syntax-dml.md`).

### EXISTS vs COUNT for existence check

```sql
-- Bad: counts all rows when only presence matters
IF (SELECT COUNT(*) FROM orders WHERE customer_id = @id) > 0

-- Good: short-circuits on first match
IF EXISTS (SELECT 1 FROM orders WHERE customer_id = @id)
```

### NOLOCK / READ UNCOMMITTED caution

`WITH (NOLOCK)` avoids shared locks but can read uncommitted (dirty), phantom, or even twice-read rows due to page splits. Acceptable for approximate reporting; never for financial or correctness-critical reads. See `13-transactions-locking.md` for isolation level guidance.

---

## See also

- [`04-ctes.md`](04-ctes.md) — CTEs as an alternative to subqueries and derived tables
- [`03-syntax-dml.md`](03-syntax-dml.md) — write operations
- [`13-transactions-locking.md`](13-transactions-locking.md) — isolation levels affecting reads
- [`29-query-plans.md`](29-query-plans.md) — reading execution plans, seek vs scan
- [`32-performance-diagnostics.md`](32-performance-diagnostics.md) — query hints, STATISTICS IO/TIME
- [`25-null-handling.md`](25-null-handling.md) — NULL behavior in JOINs and WHERE

---

## Sources

[^1]: [GROUPING (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/grouping-transact-sql) — describes GROUPING() return value semantics (1 for super-aggregate, 0 otherwise) used with ROLLUP, CUBE, and GROUPING SETS
[^2]: [IS [NOT] DISTINCT FROM (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/is-distinct-from-transact-sql) — introduced in SQL Server 2022; compares two expressions treating NULL as a known value, enabling NULL-safe equality comparisons
[^3]: [SELECT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-transact-sql) — full SELECT statement syntax, logical processing order, and clause reference
[^4]: [OVER Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-over-clause-transact-sql) — defines partitioning, ordering, and frame (ROWS/RANGE) for window functions
[^5]: [Using PIVOT and UNPIVOT - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-using-pivot-and-unpivot) — syntax and examples for rotating rows to columns (PIVOT) and columns to rows (UNPIVOT)
[^6]: [ORDER BY Clause (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-order-by-clause-transact-sql) — covers ORDER BY syntax including OFFSET/FETCH pagination clauses available since SQL Server 2012

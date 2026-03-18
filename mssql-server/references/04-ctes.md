# CTEs — Common Table Expressions

## Table of Contents

1. [When to Use](#when-to-use)
2. [Non-Recursive CTEs](#non-recursive-ctes)
3. [Recursive CTEs](#recursive-ctes)
   - [Anatomy](#anatomy)
   - [Anchor and Recursive Members](#anchor-and-recursive-members)
   - [MAXRECURSION](#maxrecursion)
   - [Common Recursive Patterns](#common-recursive-patterns)
4. [Multiple CTEs in One Statement](#multiple-ctes-in-one-statement)
5. [CTEs with DML](#ctes-with-dml)
6. [Performance: CTE vs Temp Table vs Table Variable](#performance-cte-vs-temp-table-vs-table-variable)
7. [Gotchas / Anti-Patterns](#gotchas--anti-patterns)
8. [See Also](#see-also)
9. [Sources](#sources)

---

## When to Use

| Scenario | Prefer |
|---|---|
| Readable decomposition of a complex SELECT | CTE |
| Avoiding repeated subquery expression | CTE |
| Hierarchical / tree traversal | Recursive CTE |
| Result set used multiple times in same query | Temp table (CTE is re-evaluated each reference) |
| Large intermediate result, needs index | Temp table |
| Row-by-row iteration | Cursor or recursive CTE (with caution) |
| Passing result set to a child scope / SP | Table variable or temp table |
| Aggregation you need to filter on | CTE or derived table (both fine) |

CTEs exist **only within the scope of a single statement**. They are not materialized by default — the optimizer may expand them inline or apply the expression multiple times.

---

## Non-Recursive CTEs

```sql
WITH cte_name (col1, col2) AS (
    SELECT col_a, col_b
    FROM   some_table
    WHERE  some_condition
)
SELECT *
FROM   cte_name
WHERE  col1 > 0;
```

Column aliases in the CTE header are optional when the SELECT list already names every column unambiguously.

### Named column list form (required when column name is ambiguous)

```sql
WITH ranked_sales (salesperson_id, total_sales, rnk) AS (
    SELECT salesperson_id,
           SUM(amount),
           RANK() OVER (ORDER BY SUM(amount) DESC)
    FROM   Sales
    GROUP BY salesperson_id
)
SELECT *
FROM   ranked_sales
WHERE  rnk <= 5;
```

---

## Recursive CTEs

### Anatomy

```sql
WITH cte_name AS (
    -- Anchor member: runs once, seeds the recursion
    SELECT ...

    UNION ALL

    -- Recursive member: references cte_name, runs until no rows returned
    SELECT ...
    FROM   some_table
    JOIN   cte_name ON ...   -- self-reference must be on the right side of JOIN
)
SELECT * FROM cte_name;
```

Rules enforced by the parser:
- The anchor and recursive members must be joined with `UNION ALL`. `UNION`, `INTERSECT`, `EXCEPT` are not allowed in the recursive member.
- The recursive member cannot reference the CTE more than once.
- The recursive member cannot use `GROUP BY`, `HAVING`, `SELECT DISTINCT`, `TOP`, `PIVOT`, `UNPIVOT`, aggregate functions, or subqueries that reference the CTE.
- Outer queries can use `GROUP BY`, `ORDER BY`, `TOP`, etc. — these restrictions apply only to the recursive member itself.

### Anchor and Recursive Members

```sql
-- Hierarchy traversal: employees and their managers
WITH emp_tree AS (
    -- Anchor: top-level employees (no manager)
    SELECT employee_id,
           manager_id,
           full_name,
           0          AS depth,
           CAST(full_name AS NVARCHAR(4000)) AS path
    FROM   Employees
    WHERE  manager_id IS NULL

    UNION ALL

    -- Recursive: direct reports of current level
    SELECT e.employee_id,
           e.manager_id,
           e.full_name,
           t.depth + 1,
           CAST(t.path + N' > ' + e.full_name AS NVARCHAR(4000))
    FROM   Employees  e
    JOIN   emp_tree   t ON e.manager_id = t.employee_id
)
SELECT depth, path, employee_id
FROM   emp_tree
ORDER  BY path;
```

### MAXRECURSION

SQL Server limits recursion depth to **100 by default**. Exceed the limit and you get:

```
Msg 530, Level 16: The statement terminated. The maximum recursion 100
has been exhausted before statement completion.
```

Override with a query hint — **not** a session setting:

```sql
WITH cte AS (...)
SELECT * FROM cte
OPTION (MAXRECURSION 500);   -- 0 = unlimited (dangerous; guard with WHERE)
```

> [!WARNING] Unlimited recursion
> `MAXRECURSION 0` means SQL Server never terminates automatically. A logic bug that never reaches the base case will spin forever, consuming CPU and memory until cancelled or server restart. Always add an explicit depth guard:

```sql
WITH cte AS (
    SELECT id, parent_id, 0 AS depth FROM Nodes WHERE parent_id IS NULL
    UNION ALL
    SELECT n.id, n.parent_id, c.depth + 1
    FROM   Nodes n JOIN cte c ON n.parent_id = c.id
    WHERE  c.depth < 999          -- explicit guard
)
SELECT * FROM cte
OPTION (MAXRECURSION 1000);
```

### Common Recursive Patterns

#### 1 — Bill of materials (multi-level parts explosion)

```sql
WITH bom AS (
    SELECT component_id, parent_id, qty, 1 AS level
    FROM   BillOfMaterials
    WHERE  parent_id = @root_part_id   -- anchor = root part

    UNION ALL

    SELECT b.component_id, b.parent_id, b.qty * r.qty, r.level + 1
    FROM   BillOfMaterials b
    JOIN   bom r ON b.parent_id = r.component_id
)
SELECT component_id, SUM(qty) AS total_qty
FROM   bom
GROUP  BY component_id
OPTION (MAXRECURSION 20);
```

#### 2 — Date spine (generate series of dates)

```sql
DECLARE @start DATE = '2024-01-01', @end DATE = '2024-12-31';

WITH dates AS (
    SELECT @start AS d
    UNION ALL
    SELECT DATEADD(day, 1, d)
    FROM   dates
    WHERE  d < @end
)
SELECT d FROM dates
OPTION (MAXRECURSION 400);
```

> [!NOTE] SQL Server 2022
> `GENERATE_SERIES()` can replace date-spine CTEs for integer ranges, but not date ranges directly. Use `GENERATE_SERIES` + `DATEADD` for dates [^3].

#### 3 — Integer sequence

```sql
WITH nums AS (
    SELECT 1 AS n
    UNION ALL
    SELECT n + 1 FROM nums WHERE n < 100
)
SELECT n FROM nums
OPTION (MAXRECURSION 100);
```

#### 4 — Path accumulation with cycle detection

```sql
WITH graph_walk AS (
    SELECT node_id,
           CAST(node_id AS VARCHAR(MAX)) AS visited_path,
           0 AS depth
    FROM   Nodes WHERE node_id = @start

    UNION ALL

    SELECT e.target_node,
           g.visited_path + ',' + CAST(e.target_node AS VARCHAR(MAX)),
           g.depth + 1
    FROM   Edges e
    JOIN   graph_walk g ON e.source_node = g.node_id
    -- Cycle guard: skip nodes already in path
    WHERE  CHARINDEX(',' + CAST(e.target_node AS VARCHAR(MAX)) + ',',
                     ',' + g.visited_path + ',') = 0
      AND  g.depth < 20
)
SELECT * FROM graph_walk
OPTION (MAXRECURSION 50);
```

> [!NOTE] SQL Server 2019+
> For complex graph traversal consider [Graph Tables](21-graph-tables.md) with `MATCH` and `SHORTEST_PATH`, which are more readable and have native cycle-prevention semantics.

---

## Multiple CTEs in One Statement

Chain multiple CTEs with a single `WITH`, separated by commas. Each CTE can reference CTEs defined before it.

```sql
WITH
  raw_orders AS (
      SELECT order_id, customer_id, total
      FROM   Orders
      WHERE  order_date >= '2024-01-01'
  ),
  ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY total DESC) AS rn
      FROM   raw_orders
  ),
  top_orders AS (
      SELECT * FROM ranked WHERE rn = 1
  )
SELECT t.customer_id, t.order_id, t.total, c.email
FROM   top_orders t
JOIN   Customers  c ON t.customer_id = c.customer_id;
```

**Restriction:** you cannot write a second `WITH` keyword partway through — all CTEs for a statement go in one `WITH` clause.

---

## CTEs with DML

CTEs can precede `INSERT`, `UPDATE`, `DELETE`, and `MERGE`. This is the standard pattern for updatable CTEs.

### UPDATE via CTE (cleaner than FROM clause update)

```sql
WITH to_update AS (
    SELECT e.salary, d.budget_factor
    FROM   Employees e
    JOIN   Departments d ON e.dept_id = d.dept_id
    WHERE  d.dept_name = 'Engineering'
)
UPDATE to_update
SET    salary = salary * budget_factor;
```

> [!WARNING] Non-determinism in join-based UPDATE
> When the CTE or derived table joins produce multiple rows per target row, the UPDATE result is non-deterministic — SQL Server picks one value silently. Use a CTE with `ROW_NUMBER()` to guarantee one match per target row. See [03-syntax-dml.md — UPDATE gotchas](03-syntax-dml.md#gotchas--anti-patterns).

### DELETE via CTE (e.g., keep only top N per group)

```sql
WITH ranked AS (
    SELECT log_id,
           ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY     created_at DESC
           ) AS rn
    FROM   SessionLogs
)
DELETE FROM ranked WHERE rn > 10;
```

### INSERT … SELECT from CTE

```sql
WITH source AS (
    SELECT product_id, SUM(qty) AS total_qty
    FROM   StagingOrders
    GROUP  BY product_id
)
INSERT INTO ProductSales (product_id, total_qty, snapshot_date)
SELECT product_id, total_qty, GETDATE()
FROM   source;
```

---

## Performance: CTE vs Temp Table vs Table Variable

### Key principle: CTEs are not materialized

A CTE is a named subquery — the optimizer inlines it at each reference site. If you reference the same CTE twice in one query, its definition runs twice.

```sql
WITH expensive AS (
    SELECT ... FROM BigTable WHERE ...   -- complex aggregation
)
-- expensive runs TWICE here:
SELECT a.*, b.*
FROM   expensive a
JOIN   expensive b ON a.id <> b.id AND a.region = b.region;
```

**Fix:** materialize into a temp table if referenced multiple times or if the row count is large.

### Decision matrix

| Factor | CTE | Temp Table | Table Variable |
|---|---|---|---|
| Materialized? | No (re-evaluated per reference) | Yes (once) | Yes (once) |
| Statistics? | Inherits from base tables | Yes (auto-created) | No (1-row estimate pre-2019; deferred compilation 2019+) |
| Indexed? | No | Yes — you can CREATE INDEX | No (only PK/UQ constraints) |
| Scope | Single statement | Session (until DROP or end of scope) | Batch / routine |
| Temp table in tx? | N/A | Logged, participates in rollback | Logged, but DDL not rolled back [^1] |
| Best for | Readability, once-used subqueries | Large or reused intermediate sets | Small sets, output params, TVP |
| Parallel plan eligible | Depends on query | Yes (full parallel) | Yes |

> [!NOTE] SQL Server 2019+
> **Table variable deferred compilation** (part of Intelligent Query Processing) defers the compilation of statements referencing table variables until after the table variable is actually populated. This gives the optimizer a real row count estimate instead of assuming 1 row. Enable with compatibility level 150+. [^2]

### When to choose a temp table over a CTE

- The intermediate result is large (>10,000 rows) and referenced more than once.
- You need an index on the intermediate result (e.g., to avoid a sort or key lookup).
- You want statistics to be generated for accurate downstream cardinality estimates.
- The intermediate result is used across multiple statements (temp table outlives a single query).

```sql
-- Pattern: materialize expensive join, then query twice
SELECT e.employee_id,
       e.full_name,
       m.full_name AS manager_name,
       d.dept_name
INTO   #enriched_employees
FROM   Employees e
LEFT   JOIN Employees  m  ON e.manager_id  = m.employee_id
JOIN   Departments d ON e.dept_id = d.dept_id;

-- Index on the temp table for the subsequent queries
CREATE NONCLUSTERED INDEX ix_dept ON #enriched_employees (dept_name) INCLUDE (full_name);

-- First use
SELECT dept_name, COUNT(*) FROM #enriched_employees GROUP BY dept_name;

-- Second use
SELECT * FROM #enriched_employees WHERE dept_name = 'Engineering';

DROP TABLE IF EXISTS #enriched_employees;
```

---

## Gotchas / Anti-Patterns

### 1 — Referencing a CTE more than once silently re-executes it

```sql
WITH cte AS (SELECT NEWID() AS id)
SELECT a.id, b.id
FROM   cte a, cte b;
-- a.id and b.id are DIFFERENT values — NEWID() called twice
```

This is especially dangerous with non-deterministic functions, random sampling, or expensive aggregations.

### 2 — ORDER BY inside a CTE is illegal without TOP/OFFSET

```sql
-- WRONG: ORDER BY not allowed in CTE without TOP or OFFSET/FETCH
WITH bad AS (
    SELECT * FROM Orders ORDER BY order_date
)
SELECT * FROM bad;  -- Msg 1033 or similar error

-- CORRECT: Use ORDER BY in the outer query
WITH good AS (SELECT * FROM Orders)
SELECT * FROM good ORDER BY order_date;
```

### 3 — MAXRECURSION default of 100 surprises people

A date-spine CTE for a full year (365 rows) hits the limit. Always add `OPTION (MAXRECURSION n)` with an explicit safe upper bound.

### 4 — Recursive CTEs do not detect cycles automatically

SQL Server does not track visited nodes. A cycle in hierarchical data causes infinite recursion until MAXRECURSION fires. Use explicit path-tracking (see [Path accumulation with cycle detection](#4--path-accumulation-with-cycle-detection) above).

### 5 — CTE column names do not carry constraints

A CTE column named `salary` does not inherit a `NOT NULL` or `CHECK` from the base table. The optimizer may not know about these constraints when estimating cardinality through the CTE.

### 6 — OPTION hints go on the outer statement, not the CTE

```sql
-- WRONG: hint inside the CTE definition
WITH cte AS (
    SELECT * FROM BigTable OPTION (MAXDOP 4)  -- syntax error
)
SELECT * FROM cte;

-- CORRECT: hint on the final SELECT
WITH cte AS (SELECT * FROM BigTable)
SELECT * FROM cte OPTION (MAXDOP 4, MAXRECURSION 0);
```

### 7 — Recursive CTEs accumulate all levels before returning

The result of a recursive CTE is not streamed level-by-level. SQL Server builds a worktable (spool) with all rows first, then returns them. For very deep trees this can cause significant tempdb usage.

### 8 — Recursive CTEs and parallel plans

The recursive member typically executes serially (parallelism suppressed). If you need parallelism on a large hierarchy, consider a graph table with `SHORTEST_PATH` or an iterative approach with temp tables.

---

## See Also

- [02-syntax-dql.md](02-syntax-dql.md) — subqueries, derived tables, APPLY (alternatives to CTEs)
- [21-graph-tables.md](21-graph-tables.md) — SHORTEST_PATH as an alternative for graph traversal
- [34-tempdb.md](34-tempdb.md) — worktable and spool behavior in tempdb
- [29-query-plans.md](29-query-plans.md) — how CTEs appear in execution plans (Spool operator)

---

## Sources

[^1]: [DECLARE @local_variable (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/declare-local-variable-transact-sql) — covers table variable declaration, scope, and transaction behavior; DML inside a table variable is rolled back on ROLLBACK but the variable itself (DDL) is not
[^2]: [Intelligent Query Processing - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing) — IQP feature matrix listing Table Variable Deferred Compilation as available from SQL Server 2019 (compatibility level 150+)
[^3]: [GENERATE_SERIES (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/generate-series-transact-sql) — documents GENERATE_SERIES for integer and numeric ranges (SQL Server 2022+); date series require combining with DATEADD

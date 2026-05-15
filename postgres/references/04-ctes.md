# Common Table Expressions (WITH / WITH RECURSIVE)


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Basic WITH (non-recursive)](#basic-with-non-recursive)
    - [Chaining and visibility rules](#chaining-and-visibility-rules)
    - [Default materialization behavior (the inlining rule)](#default-materialization-behavior-the-inlining-rule)
    - [MATERIALIZED and NOT MATERIALIZED (PG12+)](#materialized-and-not-materialized-pg12)
    - [WITH RECURSIVE: shape, evaluation order, termination](#with-recursive-shape-evaluation-order-termination)
    - [UNION vs UNION ALL in the recursive term](#union-vs-union-all-in-the-recursive-term)
    - [SEARCH BREADTH FIRST / DEPTH FIRST BY (PG14+)](#search-breadth-first--depth-first-by-pg14)
    - [CYCLE detection (PG14+)](#cycle-detection-pg14)
    - [Data-modifying statements in WITH](#data-modifying-statements-in-with)
    - [MERGE in WITH (PG17+)](#merge-in-with-pg17)
    - [Lock-level summary](#lock-level-summary)
- [Examples / Recipes](#examples--recipes)
    - [1. Top-N per group via CTE + window function](#1-top-n-per-group-via-cte--window-function)
    - [2. Archive-then-delete (move rows between tables atomically)](#2-archive-then-delete-move-rows-between-tables-atomically)
    - [3. Audit-log capture on UPDATE](#3-audit-log-capture-on-update)
    - [4. Compute-once, reuse: when MATERIALIZED is mandatory](#4-compute-once-reuse-when-materialized-is-mandatory)
    - [5. Force inlining: when NOT MATERIALIZED helps](#5-force-inlining-when-not-materialized-helps)
    - [6. Tree traversal: ancestors and descendants](#6-tree-traversal-ancestors-and-descendants)
    - [7. Bill of materials (BOM) recursive explosion with aggregation](#7-bill-of-materials-bom-recursive-explosion-with-aggregation)
    - [8. Graph reachability with CYCLE detection](#8-graph-reachability-with-cycle-detection)
    - [9. Series generation as a recursive CTE](#9-series-generation-as-a-recursive-cte)
    - [10. Pagination of expensive ranking](#10-pagination-of-expensive-ranking)
    - [11. Partitioned cleanup: data-modifying recursion](#11-partitioned-cleanup-data-modifying-recursion)
    - [12. WITH ... MERGE for snapshot-driven upsert (PG17+)](#12-with--merge-for-snapshot-driven-upsert-pg17)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


| Use case | File |
|---|---|
| `WITH` inlining / materialization, `WITH RECURSIVE`, `SEARCH`/`CYCLE`, data-modifying CTEs | this file |
| `SELECT` syntax outside `WITH` | [`02-syntax-dql.md`](./02-syntax-dql.md) |
| `INSERT`/`UPDATE`/`DELETE`/`MERGE` syntax | [`03-syntax-dml.md`](./03-syntax-dml.md) |
| Window functions used inside CTEs | [`11-window-functions.md`](./11-window-functions.md) |


## Syntax / Mechanics


### Basic WITH (non-recursive)


A CTE attaches one or more named subqueries to the top of a primary statement. Each name is in scope for the rest of the `WITH` list and for the primary statement.

    WITH active_users AS (
        SELECT id, email
        FROM users
        WHERE deleted_at IS NULL
    )
    SELECT a.email, count(*) AS order_count
    FROM active_users a
    JOIN orders o ON o.user_id = a.id
    GROUP BY a.email;

A `WITH` clause can be attached to any of `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `MERGE` as the primary statement.[^queries-with]


### Chaining and visibility rules


CTEs are referenced by name and may chain — later CTEs can reference earlier ones.

    WITH
      recent_orders AS (
          SELECT *
          FROM orders
          WHERE created_at >= now() - interval '7 days'
      ),
      per_user AS (
          SELECT user_id, count(*) AS c, sum(total_cents) AS revenue
          FROM recent_orders
          GROUP BY user_id
      )
    SELECT u.email, p.c, p.revenue
    FROM per_user p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.revenue DESC
    LIMIT 50;

Visibility is one-directional and snapshot-based:

- A non-recursive CTE cannot reference itself.
- Sibling CTEs in the same `WITH` list cannot see each other's side effects (they execute against the same snapshot — see [Data-modifying statements in WITH](#data-modifying-statements-in-with)).
- A later CTE *can* see an earlier CTE's output table because the earlier CTE is in scope as a relation, but the earlier CTE's effects on actual base tables are not visible to siblings.


### Default materialization behavior (the inlining rule)


Since PG12, the planner inlines a CTE into the parent query when **all** of these hold:[^pg12-inline]

1. The CTE is **not recursive** (no `WITH RECURSIVE`).
2. The CTE has **no side effects** (it's a `SELECT` containing no `VOLATILE` functions and no `INSERT/UPDATE/DELETE/MERGE`).
3. The CTE is referenced **exactly once** in the rest of the query.

When all three hold, the CTE behaves like an inlined subquery: predicates from the outer query push down into it, indexes get used, and the planner can reorder joins across the boundary. When any of them fail, the CTE is computed once into a working table (an "optimization fence") and then read from there.

> [!NOTE] PostgreSQL 12
> Automatic inlining is a PG12 change. On PG ≤ 11, every CTE was an optimization fence — referenced once or many times, the planner never pushed predicates into it. Older "optimization fence" tricks (deliberately wrapping a subquery in `WITH foo AS (...)` to *prevent* inlining) silently stopped working at PG12 unless you mark them `MATERIALIZED`.[^pg12-inline]

The default rule means the same CTE text can produce very different plans depending on whether it's referenced once or multiple times. This is the single biggest source of CTE plan surprises after upgrading from PG ≤ 11 or after a query is restructured.


### MATERIALIZED and NOT MATERIALIZED (PG12+)


Explicit control over the inlining decision:

    WITH cte AS MATERIALIZED      (...)     -- force fence (compute once, store)
    WITH cte AS NOT MATERIALIZED  (...)     -- force inline (even with multiple references)

> [!NOTE] PostgreSQL 12
> `MATERIALIZED` / `NOT MATERIALIZED` keywords were introduced in PG12. *"Inlining can be prevented by specifying `MATERIALIZED`, or forced for multiply-referenced CTEs by specifying `NOT MATERIALIZED`."*[^pg12-inline]

When to use each:

- **`MATERIALIZED`** when:
    - The CTE contains a very expensive expression (e.g. a `STABLE`/`IMMUTABLE` function that's slow per call) that you want evaluated exactly once per output row.
    - You want a deliberate optimization fence to stop the planner from choosing a worse join order.
    - The CTE is `VOLATILE` or has side effects — these are always materialized, but adding the keyword documents intent.
- **`NOT MATERIALIZED`** when:
    - The CTE is referenced more than once but the predicates from the outer query are highly selective and you want the planner to push them through each reference.
    - You're refactoring a complex query into a chain of named CTEs for readability and *don't* want any to act as a fence.

In practice, write CTEs without either keyword by default and add one explicitly only when you've confirmed via `EXPLAIN` that the default decision is wrong. `MATERIALIZED` is the more common explicit choice because the "compute once" semantics are what people typically reach for CTEs to get.

`NOT MATERIALIZED` only applies to **non-recursive, side-effect-free** CTEs. Specifying it on a `WITH RECURSIVE` or a data-modifying CTE has no effect.[^queries-with]


### WITH RECURSIVE: shape, evaluation order, termination


    WITH RECURSIVE cte_name (col1, col2, ...) AS (
        anchor_term                  -- non-recursive seed query
        UNION [ALL]
        recursive_term               -- references cte_name
    )
    SELECT * FROM cte_name;

Evaluation algorithm:

1. Evaluate the anchor term once. Put the rows in a *working table* and a *result table*.
2. Evaluate the recursive term, substituting the current working table for the self-reference. Replace the working table with these new rows; append them to the result table (with `UNION ALL` semantics) or with deduplication (with `UNION` semantics).
3. Repeat step 2 until the working table is empty.
4. Return the result table.

Termination requires that the recursive term eventually produces zero new rows. Common termination mechanisms:

- The recursion walks a finite acyclic structure (a tree).
- The recursion has an explicit depth counter that's bounded with `WHERE depth < N`.
- `UNION` (without `ALL`) eliminates duplicates and naturally terminates over a finite graph because eventually every reachable node has been emitted.
- `CYCLE ... SET ...` (PG14+) terminates by marking and stopping at the first re-visit.

> [!WARNING] Infinite recursion
> A recursive CTE with no termination guarantee will run until it exhausts work_mem and spills to disk, then keeps running until it exhausts temp_file_limit or the disk. Always include either a depth bound, a `CYCLE` clause, or `UNION` over a finite domain.


### UNION vs UNION ALL in the recursive term


`UNION ALL` is the default choice in practice — it's strictly cheaper because it doesn't sort or hash for deduplication. Use it whenever:

- The recursion produces no duplicates (e.g. you're walking a tree, not a graph).
- You're carrying a depth counter or other unique-per-step column that makes each iteration's rows distinct anyway.

Use `UNION` (without `ALL`) when:

- The graph may have multiple paths to the same node and you want each node emitted once.
- You can rely on the deduplication to terminate the recursion over a finite vertex set.

Prefer `UNION ALL` with explicit cycle handling (`CYCLE` clause or a path-tracking column) over `UNION` for graph traversal — it makes the termination logic explicit and lets you keep auxiliary columns (depth, path) without affecting deduplication.


### SEARCH BREADTH FIRST / DEPTH FIRST BY (PG14+)


> [!NOTE] PostgreSQL 14
> Added in PG14: *"Add SQL-standard `SEARCH` and `CYCLE` clauses for common table expressions."*[^pg14-search-cycle]

The `SEARCH` clause adds an implicit ordering column to a recursive CTE so you can sort the output in tree-traversal order.

    WITH RECURSIVE descendants(id, parent_id, name) AS (
        SELECT id, parent_id, name
        FROM categories
        WHERE id = 1                                      -- root anchor
      UNION ALL
        SELECT c.id, c.parent_id, c.name
        FROM categories c
        JOIN descendants d ON c.parent_id = d.id
    )
    SEARCH DEPTH FIRST BY id SET ord                       -- adds 'ord' column
    SELECT *, ord
    FROM descendants
    ORDER BY ord;

- `SEARCH DEPTH FIRST BY id SET ord` — orders rows in depth-first traversal, breaking ties by `id` at each level.
- `SEARCH BREADTH FIRST BY id SET ord` — orders rows level by level, breaking ties by `id`.
- The column named in `SET` (here `ord`) is implicitly added to the CTE's output. You don't declare it in the column list; it appears as the last column.

Under the hood, `SEARCH` expands to a hand-written equivalent that prepends a tracking array to each row — what you'd have written manually before PG14 with `array[parent_path || id]` columns.

> [!WARNING] Implementation order is not contractual
> The internal evaluation happens to produce rows in breadth-first order, but the docs explicitly say *"this is an implementation detail and it is perhaps unsound to rely on it."*[^queries-with] If you need ordering, write `SEARCH ... BY ... SET ... ORDER BY ord` or sort manually — don't rely on the order rows happen to come back.


### CYCLE detection (PG14+)


> [!NOTE] PostgreSQL 14
> Added in PG14 alongside `SEARCH`. *"The SQL-standard `SEARCH` and `CYCLE` options for common table expressions have been implemented."*[^pg14-search-cycle]

The `CYCLE` clause adds cycle detection to a recursive CTE without you having to maintain a visited-set yourself.

    WITH RECURSIVE friend_graph(person_id, friend_id) AS (
        SELECT person_id, friend_id
        FROM friendships
        WHERE person_id = 42                                -- start node
      UNION ALL
        SELECT f.person_id, f.friend_id
        FROM friendships f
        JOIN friend_graph fg ON f.person_id = fg.friend_id
    )
    CYCLE friend_id SET is_cycle USING path                 -- adds two columns
    SELECT person_id, friend_id, is_cycle, path
    FROM friend_graph
    WHERE NOT is_cycle;

What the clause does:

- `CYCLE col1, col2, ... SET cyclemark USING pathcol`
- `col1, col2, ...` — columns whose combined value identifies a node.
- `cyclemark` — implicitly added boolean column; `true` when the current row's identifying columns appear earlier on the path (i.e., a cycle was detected).
- `pathcol` — implicitly added array column containing the path of identifying values from the anchor to the current row.

When a row would be a cycle, the recursion stops emitting along that branch but the cycle-marked row itself is still emitted with `is_cycle = true` so you can filter it out (or keep it as a diagnostic).

Combined `SEARCH` and `CYCLE`:

A query can have both, but the docs note: *"a depth-first search specification and a cycle detection specification would create redundant computations, so it's more efficient to just use the `CYCLE` clause and order by the path column. If breadth-first ordering is wanted, then specifying both `SEARCH` and `CYCLE` can be useful."*[^queries-with]

Practical takeaway: for depth-first cycle-protected traversal use `CYCLE ... USING path ORDER BY path`. For breadth-first cycle-protected traversal use both `SEARCH BREADTH FIRST` and `CYCLE`.


### Data-modifying statements in WITH


PostgreSQL allows `INSERT`, `UPDATE`, `DELETE` (and, on PG17+, `MERGE`) as auxiliary statements inside `WITH`. This enables atomic multi-table operations in a single SQL statement.

    WITH archived AS (
        DELETE FROM orders
        WHERE created_at < now() - interval '1 year'
        RETURNING *
    )
    INSERT INTO orders_archive
    SELECT * FROM archived;

Three rules drive everything about this feature:

1. **`RETURNING` is the only way to produce an output table.** Without `RETURNING`, the data-modifying CTE still executes (and to completion — see rule 3), but there's nothing to reference downstream.

2. **All sub-statements run against the same snapshot.** Sibling CTEs cannot see each other's effects. From the docs: *"The sub-statements in `WITH` are executed concurrently with each other and with the main query. Therefore, when using data-modifying statements in `WITH`, the order in which the specified updates actually happen is unpredictable."*[^queries-with]

    This is the source of the `WITH t AS (UPDATE products SET price = price * 1.05 RETURNING *) SELECT * FROM products` gotcha — the outer `SELECT` sees the *old* prices (snapshot taken before the statement started), while `SELECT * FROM t` sees the *new* prices because it's reading the `RETURNING` output, not the table.

3. **Data-modifying CTEs run to completion regardless of demand.** *"Data-modifying statements in `WITH` are executed exactly once, and always to completion, independently of whether the primary query reads all (or indeed any) of their output."*[^queries-with] This contrasts with `SELECT` CTEs, which can stop early if the outer query only fetches a few rows.

The `WITH` clause must be attached to the **top-level** statement, not to a sub-`SELECT`:

    -- WRONG: nested WITH inside a sub-SELECT (not allowed if the inner WITH contains a DML CTE)
    INSERT INTO target
    SELECT * FROM (
        WITH moved AS (DELETE FROM src RETURNING *)
        SELECT * FROM moved
    ) s;

    -- RIGHT: WITH attached to the top-level INSERT
    WITH moved AS (DELETE FROM src RETURNING *)
    INSERT INTO target SELECT * FROM moved;

Recursive self-references inside a data-modifying CTE are not allowed. To do recursive deletion (e.g. delete every node reachable from a root), compute the IDs with a recursive `SELECT` CTE first, then `DELETE` against that result:

    WITH RECURSIVE reachable(id) AS (
        SELECT id FROM nodes WHERE id = 1
      UNION
        SELECT n.id
        FROM nodes n
        JOIN edges e ON e.dst = n.id
        JOIN reachable r ON r.id = e.src
    )
    DELETE FROM nodes WHERE id IN (SELECT id FROM reachable);


### MERGE in WITH (PG17+)


> [!NOTE] PostgreSQL 17
> Before PG17, `MERGE` could be the *primary* statement that a `WITH` was attached to, but it could not be an *auxiliary* statement inside a `WITH`. The PG16 docs say *"You can use most data-modifying statements (`INSERT`, `UPDATE`, or `DELETE`, but not `MERGE`) in `WITH`."*[^pg16-queries-with] The PG17 docs say *"Each auxiliary statement in a `WITH` clause can be a `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `MERGE`."*[^pg17-queries-with]
>
> Note: this docs-level change is not called out in the PG17 release notes as a headline feature, but the documentation difference is unambiguous. Verify against your target version before relying on it.

This combines with the PG17 `MERGE ... RETURNING` feature (see [`03-syntax-dml.md`](./03-syntax-dml.md)) to allow patterns like:

    WITH sync AS (
        MERGE INTO target t
        USING source s ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET value = s.value
        WHEN NOT MATCHED THEN INSERT (id, value) VALUES (s.id, s.value)
        RETURNING merge_action() AS action, t.id, t.value
    )
    INSERT INTO sync_log (action, target_id, target_value, at)
    SELECT action, id, value, now() FROM sync;


### Lock-level summary


CTEs themselves take no locks — the locks come from the underlying statements. A `WITH` block doesn't change the locks the inner statements would take if run standalone. See [`03-syntax-dml.md`](./03-syntax-dml.md) and [`43-locking.md`](./43-locking.md) for the full lock matrix. Key reminders:

| CTE shape | Locks (taken by inner statement, not by the CTE) |
| --- | --- |
| `SELECT` CTE | `ACCESS SHARE` on referenced tables. |
| `SELECT ... FOR UPDATE` CTE | `ROW SHARE` on the table; row-level locks on matched rows. |
| `INSERT` CTE | `ROW EXCLUSIVE` on the target. |
| `UPDATE` / `DELETE` CTE | `ROW EXCLUSIVE` on the target; row-level `FOR UPDATE` lock on each modified row. |
| `MERGE` CTE (PG17+) | `ROW EXCLUSIVE` on the target; row-level lock on each matched/inserted row. |


## Examples / Recipes


### 1. Top-N per group via CTE + window function


Get the 3 most recent orders per customer in one pass.

    WITH ranked AS (
        SELECT
            o.*,
            row_number() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
        FROM orders o
        WHERE created_at >= now() - interval '90 days'
    )
    SELECT id, customer_id, created_at, total_cents
    FROM ranked
    WHERE rn <= 3
    ORDER BY customer_id, rn;

If `ranked` is referenced once and has no `VOLATILE` calls, PG12+ inlines it and the planner pushes the `rn <= 3` filter down efficiently. For a runtime-constant N, this is often as fast as the `LATERAL`/`DISTINCT ON` alternatives (see [`02-syntax-dql.md`](./02-syntax-dql.md) recipe section for the three-way comparison).


### 2. Archive-then-delete (move rows between tables atomically)


The canonical data-modifying CTE pattern. One snapshot, one statement, no race.

    WITH archived AS (
        DELETE FROM events
        WHERE occurred_at < now() - interval '30 days'
        RETURNING *
    )
    INSERT INTO events_archive
    SELECT * FROM archived;

Caveats:

- Both statements run against the same snapshot; concurrent inserts into `events` between snapshot acquisition and statement completion are not seen.
- If `events_archive` has triggers, they fire for the `INSERT` (the trigger sees the rows being inserted, not the deletion).
- For a very large delete, this holds locks on every affected row for the duration of the statement. Batch it (see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for bloat considerations and [`30-hot-updates.md`](./30-hot-updates.md) for related write-amplification notes).


### 3. Audit-log capture on UPDATE


Capture the before-state of a row update into an audit table in a single statement.

    WITH updated AS (
        UPDATE accounts
        SET balance = balance - 50
        WHERE id = $1 AND balance >= 50
        RETURNING id, balance + 50 AS old_balance, balance AS new_balance
    )
    INSERT INTO account_ledger (account_id, old_balance, new_balance, op, at)
    SELECT id, old_balance, new_balance, 'debit', now()
    FROM updated;

> [!NOTE] PostgreSQL 18
> On PG18+ the same effect is available without arithmetic via `RETURNING old.balance, new.balance` directly on the `UPDATE`. See [`03-syntax-dml.md`](./03-syntax-dml.md) for the `RETURNING OLD`/`RETURNING NEW` syntax.

If the `UPDATE`'s `WHERE` matches zero rows, the `INSERT` runs with zero input and no ledger row is produced — exactly the right behavior for "audit when something changed".


### 4. Compute-once, reuse: when MATERIALIZED is mandatory


A CTE referenced twice, where the per-row computation is expensive.

    WITH scored AS MATERIALIZED (
        SELECT
            doc_id,
            ts_rank_cd(tsv, websearch_to_tsquery('english', $1)) AS rank,
            very_expensive_score(doc_id) AS extra
        FROM documents
        WHERE tsv @@ websearch_to_tsquery('english', $1)
    )
    SELECT * FROM scored
    WHERE rank > 0.05
      AND extra > (SELECT avg(extra) FROM scored);

Without `MATERIALIZED`, the planner *could* inline `scored` and call `very_expensive_score` twice per matching row (once for the main filter, once inside the `AVG`). Forcing materialization compels a single evaluation. Confirm with `EXPLAIN (ANALYZE, BUFFERS)`.


### 5. Force inlining: when NOT MATERIALIZED helps


A CTE referenced multiple times where the outer query has highly selective predicates that should push through.

    WITH inventory AS NOT MATERIALIZED (
        SELECT
            i.sku,
            i.location_id,
            i.on_hand,
            l.region
        FROM inventory i
        JOIN locations l ON l.id = i.location_id
    )
    SELECT region, sum(on_hand)
    FROM inventory
    WHERE region = 'us-east'                                -- pushes through to base tables
    GROUP BY region
    UNION ALL
    SELECT region, sum(on_hand)
    FROM inventory
    WHERE region = 'eu-west'                                -- pushes through to base tables
    GROUP BY region;

Without `NOT MATERIALIZED`, the CTE is referenced twice and is materialized by default; the planner scans all of `inventory` once into a temp table. With `NOT MATERIALIZED`, the planner inlines both references and the region filters push down to indexes on `locations`.


### 6. Tree traversal: ancestors and descendants


Hierarchy of organizational units, threaded comments, file tree, etc.

    -- All ancestors of node 100, root first
    WITH RECURSIVE ancestors(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM org_units WHERE id = 100
      UNION ALL
        SELECT o.id, o.parent_id, o.name, a.depth + 1
        FROM org_units o
        JOIN ancestors a ON o.id = a.parent_id
    )
    SELECT id, name, depth FROM ancestors ORDER BY depth DESC;

    -- All descendants of node 100, ordered by tree position (PG14+)
    WITH RECURSIVE descendants(id, parent_id, name) AS (
        SELECT id, parent_id, name FROM org_units WHERE id = 100
      UNION ALL
        SELECT o.id, o.parent_id, o.name
        FROM org_units o
        JOIN descendants d ON o.parent_id = d.id
    )
    SEARCH DEPTH FIRST BY id SET ord
    SELECT id, name FROM descendants ORDER BY ord;

For pre-PG14 ordering use a manual path array:

    WITH RECURSIVE descendants(id, parent_id, name, path) AS (
        SELECT id, parent_id, name, ARRAY[id] FROM org_units WHERE id = 100
      UNION ALL
        SELECT o.id, o.parent_id, o.name, d.path || o.id
        FROM org_units o
        JOIN descendants d ON o.parent_id = d.id
    )
    SELECT id, name FROM descendants ORDER BY path;


### 7. Bill of materials (BOM) recursive explosion with aggregation


Compute total raw-material quantities for a finished product whose parts have sub-parts.

    WITH RECURSIVE exploded(product_id, component_id, qty) AS (
        SELECT product_id, component_id, qty
        FROM bom
        WHERE product_id = 'WIDGET-A'                       -- top product
      UNION ALL
        SELECT e.product_id, b.component_id, e.qty * b.qty
        FROM exploded e
        JOIN bom b ON b.product_id = e.component_id          -- sub-parts
    )
    SELECT component_id, sum(qty) AS total_qty
    FROM exploded
    WHERE component_id NOT IN (SELECT DISTINCT product_id FROM bom)  -- only raw materials
    GROUP BY component_id
    ORDER BY total_qty DESC;

This walks the assembly tree multiplying quantities as it descends. The leaf filter (`component_id NOT IN (SELECT DISTINCT product_id FROM bom)`) keeps only items that are *not themselves assembled* — i.e., raw materials.


### 8. Graph reachability with CYCLE detection


Find everyone reachable from a person in a friendship graph, with cycle protection.

    WITH RECURSIVE reachable(person_id, friend_id, hops) AS (
        SELECT person_id, friend_id, 1
        FROM friendships
        WHERE person_id = 42
      UNION ALL
        SELECT f.person_id, f.friend_id, r.hops + 1
        FROM friendships f
        JOIN reachable r ON f.person_id = r.friend_id
        WHERE r.hops < 6                                    -- hop limit (Bacon-style)
    )
    CYCLE friend_id SET is_cycle USING path
    SELECT DISTINCT friend_id, min(hops) AS shortest_hops
    FROM reachable
    WHERE NOT is_cycle
    GROUP BY friend_id
    ORDER BY shortest_hops;

> [!NOTE] PostgreSQL 14
> The `CYCLE friend_id SET is_cycle USING path` clause is PG14+. On PG ≤ 13 use a manual visited-set in a path array:
>
>     ...
>     UNION ALL
>     SELECT f.person_id, f.friend_id, r.hops + 1, r.path || f.friend_id
>     FROM friendships f
>     JOIN reachable r ON f.person_id = r.friend_id
>     WHERE r.hops < 6
>       AND NOT (f.friend_id = ANY(r.path))


### 9. Series generation as a recursive CTE


When you can't use `generate_series` (e.g., generating dates with business-logic gaps).

    WITH RECURSIVE business_days(d) AS (
        SELECT DATE '2026-01-01'
      UNION ALL
        SELECT (d + INTERVAL '1 day')::date
        FROM business_days
        WHERE d < DATE '2026-12-31'
    )
    SELECT d
    FROM business_days
    WHERE extract(dow FROM d) NOT IN (0, 6)                 -- skip weekends
      AND d NOT IN (SELECT holiday_date FROM holidays);

For straight numeric or date ranges, `generate_series` is faster and clearer; recursive CTEs are the right tool when each step depends on the previous step's value (Fibonacci, compound-interest accumulation, walking a linked-list-style structure).


### 10. Pagination of expensive ranking


Compute scores once, paginate over them without re-ranking.

    WITH scored AS MATERIALIZED (
        SELECT
            d.id,
            d.title,
            ts_rank_cd(d.tsv, websearch_to_tsquery('english', $1)) AS rank
        FROM documents d
        WHERE d.tsv @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT 1000                                          -- top-1000 candidates
    )
    SELECT * FROM scored
    OFFSET $2 LIMIT $3;

The `MATERIALIZED` keyword is technically redundant here because `LIMIT` is a side-effectless `SELECT` operation and a single-reference CTE would inline; but writing it explicitly documents the intent and prevents a future refactor that adds a second reference from accidentally double-ranking.


### 11. Partitioned cleanup: data-modifying recursion


Delete a node and all its descendants from a hierarchical table. Recursive CTEs can't directly self-reference in a data-modifying form, so split the recursive walk from the deletion:

    WITH RECURSIVE to_delete(id) AS (
        SELECT id FROM nodes WHERE id = $1                  -- target root
      UNION
        SELECT n.id
        FROM nodes n
        JOIN to_delete td ON n.parent_id = td.id
    )
    DELETE FROM nodes
    WHERE id IN (SELECT id FROM to_delete);

For graphs with possible cycles, use `CYCLE` on the recursive `SELECT` first:

    WITH RECURSIVE to_delete(id) AS (
        SELECT id FROM nodes WHERE id = $1
      UNION ALL
        SELECT n.id
        FROM nodes n
        JOIN to_delete td ON n.parent_id = td.id
    )
    CYCLE id SET is_cycle USING path
    DELETE FROM nodes
    WHERE id IN (SELECT id FROM to_delete WHERE NOT is_cycle);


### 12. WITH ... MERGE for snapshot-driven upsert (PG17+)


Use a `WITH` CTE to compute a source set, then `MERGE` into the target — captured with `RETURNING` for an audit log.

> [!NOTE] PostgreSQL 17
> `MERGE ... RETURNING` and `WHEN NOT MATCHED BY SOURCE` are PG17. `MERGE` as an auxiliary CTE statement is PG17.

    WITH new_prices AS (
        SELECT sku, new_price
        FROM staging_prices
        WHERE batch_id = $1
    ),
    applied AS (
        MERGE INTO products p
        USING new_prices n ON p.sku = n.sku
        WHEN MATCHED AND p.price <> n.new_price THEN UPDATE SET price = n.new_price
        WHEN NOT MATCHED THEN INSERT (sku, price) VALUES (n.sku, n.new_price)
        RETURNING merge_action() AS action, p.sku, p.price
    )
    INSERT INTO price_audit (action, sku, price, batch_id, at)
    SELECT action, sku, price, $1, now() FROM applied;

This is the cleanest single-statement form of "diff a staging table into production and log what changed".


## Gotchas / Anti-patterns


1. **PG ≤ 11 mental model on PG12+.** On older versions `WITH foo AS (...)` was an automatic optimization fence. On PG12+ it's only a fence when the CTE is referenced multiple times, is recursive, or has side effects. Code that depended on the fence to suppress predicate push-down (often to work around a planner regression) silently became slower on PG12+. Add `MATERIALIZED` explicitly if you need the fence behavior.[^pg12-inline]

2. **Sibling CTEs cannot see each other's writes.** All sub-statements run against the same snapshot. `WITH t AS (UPDATE ...) SELECT * FROM products` shows the *old* values of `products`; `SELECT * FROM t` shows the *new* values from the `RETURNING` output. Don't write CTEs that try to update a table and then re-query it expecting to see the changes.[^queries-with]

3. **Updating the same row twice in one statement is undefined behavior.** *"Trying to update the same row twice in a single statement is not supported. Only one of the modifications takes place, but it is not easy (and sometimes not possible) to reliably predict which one."*[^queries-with] If a row could be touched by two siblings, route it through one merge step.

4. **Outer-side cardinality with data-modifying CTEs.** `WITH del AS (DELETE FROM src RETURNING *) INSERT INTO dst SELECT * FROM del` inserts exactly the rows that were deleted — including duplicates that the `DELETE` might match. If you expected `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, you may need it explicitly.

5. **`WITH RECURSIVE` without a termination guard.** Always include either `WHERE depth < N`, a `CYCLE` clause (PG14+), or `UNION` (not `UNION ALL`) over a finite vertex set. There is no implicit recursion-depth limit. A run-away recursive CTE consumes work_mem, spills to disk, and exhausts the temp tablespace.

6. **`UNION` vs `UNION ALL` in recursive CTEs.** `UNION` deduplicates on every step, which is more expensive than `UNION ALL`. Prefer `UNION ALL` + an explicit cycle/depth guard for performance, except when the natural deduplication of `UNION` is what's terminating the recursion.

7. **Self-reference cannot appear inside an aggregate, subquery, or outer join in the recursive term.** The self-reference must appear at the top level of the recursive term's `FROM` clause. Wrapping it in a subquery or referencing it from inside an aggregate function is rejected. Restructure to push the aggregation outside the recursion.

8. **`SEARCH DEPTH FIRST` + `CYCLE` is redundant.** The docs explicitly recommend just `CYCLE` + `ORDER BY path` for depth-first cycle-protected traversal. Pair `SEARCH BREADTH FIRST` with `CYCLE` only when you genuinely need breadth-first order.[^queries-with]

9. **`RETURNING` is mandatory for data-modifying CTEs that are referenced.** If a data-modifying CTE doesn't have `RETURNING`, it still executes (to completion, regardless of demand), but there's no output table to reference. If you accidentally write `WITH t AS (DELETE FROM x) DELETE FROM y`, both deletes run, but the affected-rows count reported back is only `y`'s. Be careful what you commit.

10. **No recursive self-reference in data-modifying CTEs.** You can't write `WITH RECURSIVE r AS (DELETE FROM x WHERE id = (SELECT id FROM r) ...)`. Compute the rows with a recursive `SELECT` CTE first, then `DELETE`/`UPDATE` against that result.

11. **CTE name shadowing.** A CTE name shadows a base table of the same name within the same statement. Renaming the CTE is safer than relying on schema-qualification to disambiguate.

12. **Trick of fetching only N rows from an infinite recursive CTE.** *"This works because PostgreSQL's implementation evaluates only as many rows of a `WITH` query as are actually fetched by the parent query. Using this trick in production is not recommended."*[^queries-with] Don't rely on it — add a real bound.

13. **Triggers fire on data-modifying CTE writes.** Each `INSERT`/`UPDATE`/`DELETE` CTE fires the same triggers as the standalone statement. If two sibling CTEs both write to the same table, both sets of triggers fire and they see the same pre-statement snapshot.

14. **`MERGE` in `WITH` is PG17+.** On PG ≤ 16 it must be the primary statement. Don't write a `MERGE` auxiliary CTE on a PG16 cluster — it errors with a syntax error pointing at `MERGE`.[^pg16-queries-with][^pg17-queries-with]

15. **The "outer query reads fewer rows" optimization doesn't apply to data-modifying CTEs.** A `SELECT` CTE can stop early if the outer query has a `LIMIT`. A data-modifying CTE always runs to completion. Don't wrap a destructive `DELETE` in a CTE expecting a `LIMIT 10` outside to limit the damage — every row matched by the `DELETE`'s `WHERE` is gone.

16. **Plan instability across PG majors.** The inlining decision changed at PG12 and the planner has continued tuning CTE costing since. A query whose plan looks fine on PG14 may regress on PG16 or PG17. Lock down sensitive queries with `MATERIALIZED` or `NOT MATERIALIZED` to make the planner's decision explicit, and re-verify with `EXPLAIN (ANALYZE, BUFFERS)` after upgrade.


## See Also


- [`02-syntax-dql.md`](./02-syntax-dql.md) — `SELECT`, JOINs, set operations, `LATERAL` (alternative to recursive CTE for some shapes).
- [`03-syntax-dml.md`](./03-syntax-dml.md) — `INSERT`/`UPDATE`/`DELETE`/`MERGE` syntax, `RETURNING` (PG18 `OLD`/`NEW`), `ON CONFLICT` upsert.
- [`11-window-functions.md`](./11-window-functions.md) — `row_number()`/`rank()`/`dense_rank()` heavily used in CTEs.
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — when to paginate via cursor instead of `WITH ... LIMIT/OFFSET`.
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — the snapshot semantics that drive sibling-CTE visibility rules.
- [`41-transactions.md`](./41-transactions.md) — implicit transaction wrapping of multi-statement CTE expressions.
- [`42-isolation-levels.md`](./42-isolation-levels.md) — isolation levels and the same-snapshot semantics shared across CTE sub-statements.
- [`55-statistics-planner.md`](./55-statistics-planner.md) — planner cost model context for `MATERIALIZED` / `NOT MATERIALIZED` decisions.
- [`43-locking.md`](./43-locking.md) — the underlying lock modes inherited by data-modifying CTEs.
- [`56-explain.md`](./56-explain.md) — diagnose CTE inlining decisions with `EXPLAIN (VERBOSE, ANALYZE, BUFFERS)`. Look for "CTE Scan" vs an inlined join.


## Sources


[^queries-with]: PostgreSQL 16 docs — "WITH Queries (Common Table Expressions)". Covers `WITH`, `WITH RECURSIVE`, materialization semantics, `MATERIALIZED`/`NOT MATERIALIZED`, `SEARCH`, `CYCLE`, data-modifying statements in `WITH`, and the snapshot/visibility rules quoted in the Gotchas section. https://www.postgresql.org/docs/16/queries-with.html

[^pg12-inline]: PostgreSQL 12 Release Notes, §E.23.3.1.3 Optimizer. Exact quoted text: *"Allow common table expressions (CTEs) to be inlined into the outer query (Andreas Karlsson, Andrew Gierth, David Fetter, Tom Lane). Specifically, CTEs are automatically inlined if they have no side-effects, are not recursive, and are referenced only once in the query. Inlining can be prevented by specifying MATERIALIZED, or forced for multiply-referenced CTEs by specifying NOT MATERIALIZED. Previously, CTEs were never inlined and were always evaluated before the rest of the query."* https://www.postgresql.org/docs/release/12.0/

[^pg14-search-cycle]: PostgreSQL 14 Release Notes. Exact quoted text: *"Add SQL-standard SEARCH and CYCLE clauses for common table expressions (Peter Eisentraut). The same results could be accomplished using existing syntax, but much less conveniently."* Also from the Overview: *"The SQL-standard SEARCH and CYCLE options for common table expressions have been implemented."* https://www.postgresql.org/docs/release/14.0/

[^pg16-queries-with]: PostgreSQL 16 docs — "WITH Queries (Common Table Expressions)", data-modifying statements section. Exact quoted text: *"You can use most data-modifying statements (INSERT, UPDATE, or DELETE, but not MERGE) in WITH."* and *"Each auxiliary statement in a WITH clause can be a SELECT, INSERT, UPDATE, or DELETE; and the WITH clause itself is attached to a primary statement that can be a SELECT, INSERT, UPDATE, DELETE, or MERGE."* https://www.postgresql.org/docs/16/queries-with.html

[^pg17-queries-with]: PostgreSQL 17 docs — "WITH Queries (Common Table Expressions)". Exact quoted text: *"Each auxiliary statement in a WITH clause can be a SELECT, INSERT, UPDATE, DELETE, or MERGE; and the WITH clause itself is attached to a primary statement that can also be a SELECT, INSERT, UPDATE, DELETE, or MERGE."* (Contrast with the PG16 wording above — `MERGE` was added as an allowed auxiliary statement.) https://www.postgresql.org/docs/17/queries-with.html

# DML Syntax — `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `RETURNING`


Reference for PostgreSQL **data-manipulation language**: the full grammar of `INSERT` (with `ON CONFLICT` upsert), `UPDATE` (with `FROM`-clause joined updates), `DELETE` (with `USING`-clause joined deletes), `MERGE` (added in PG15, substantially expanded in PG17), and the `RETURNING` clause shared across all four (extended with `OLD` / `NEW` row aliases in PG18). Targets **PostgreSQL 16** as the baseline; PG14–PG18 deltas are called out inline. Locking semantics, `TRUNCATE`, and the bulk `COPY` command are touched on here but get full treatment in [`43-locking.md`](./43-locking.md), [`01-syntax-ddl.md`](./01-syntax-ddl.md), and [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [`INSERT` — the complete grammar](#insert--the-complete-grammar)
    - [`DEFAULT VALUES` and the `DEFAULT` marker](#default-values-and-the-default-marker)
    - [`OVERRIDING SYSTEM`/`USER VALUE` for identity columns](#overriding-systemuser-value-for-identity-columns)
    - [`INSERT ... ON CONFLICT` (upsert)](#insert--on-conflict-upsert)
    - [`conflict_target` — column lists, `ON CONSTRAINT`, partial indexes](#conflict_target--column-lists-on-constraint-partial-indexes)
    - [`DO UPDATE SET` and the `EXCLUDED` pseudo-table](#do-update-set-and-the-excluded-pseudo-table)
    - [`UPDATE` — the complete grammar](#update--the-complete-grammar)
    - [`UPDATE ... FROM` — joined updates and the duplicate-match trap](#update--from--joined-updates-and-the-duplicate-match-trap)
    - [Multi-column assignment and sub-`SELECT` assignment](#multi-column-assignment-and-sub-select-assignment)
    - [`DELETE` — the complete grammar](#delete--the-complete-grammar)
    - [`DELETE ... USING` — joined deletes](#delete--using--joined-deletes)
    - [`MERGE` (PG15+)](#merge-pg15)
    - [`MERGE ... WHEN NOT MATCHED BY SOURCE` (PG17+)](#merge--when-not-matched-by-source-pg17)
    - [`MERGE ... RETURNING` and `merge_action()` (PG17+)](#merge--returning-and-merge_action-pg17)
    - [`RETURNING` — output rows from any DML](#returning--output-rows-from-any-dml)
    - [`RETURNING OLD.*` / `NEW.*` (PG18+)](#returning-old--new-pg18)
    - [Data-modifying CTEs (`WITH ... INSERT/UPDATE/DELETE/MERGE`)](#data-modifying-ctes-with--insertupdatedeletemerge)
    - [Lock levels taken by DML](#lock-levels-taken-by-dml)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Load this file when the question involves:

- Writing an **upsert** (`INSERT ... ON CONFLICT`) or a multi-statement sync (`MERGE`)
- Choosing between `INSERT ... ON CONFLICT`, `MERGE`, and a hand-rolled `BEGIN; UPDATE; INSERT ...; COMMIT` pattern
- A **joined update**: "update column X in table A based on values in table B"
- A **joined delete**: "delete rows in A whose key appears in B"
- The right way to use `RETURNING` to fetch generated keys, computed values, or audit data
- Whether to use `RETURNING OLD.*` / `NEW.*` (PG18) versus an `AFTER` trigger to capture pre/post values
- Cardinality-violation errors from `MERGE` or `INSERT ... ON CONFLICT`
- Why `UPDATE ... FROM` with a multi-match `FROM` produced non-deterministic results
- Whether you can run `INSERT ... ON CONFLICT` while `CREATE INDEX CONCURRENTLY` is in progress

## Syntax / Mechanics


### `INSERT` — the complete grammar


```sql
[ WITH [ RECURSIVE ] with_query [, ...] ]
INSERT INTO table_name [ AS alias ] [ ( column_name [, ...] ) ]
    [ OVERRIDING { SYSTEM | USER } VALUE ]
    { DEFAULT VALUES
    | VALUES ( { expression | DEFAULT } [, ...] ) [, ...]
    | query }
    [ ON CONFLICT [ conflict_target ] conflict_action ]
    [ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]
```

Three mutually exclusive value sources:

| Form | When to use |
|---|---|
| `DEFAULT VALUES` | A row of pure defaults — every column gets its declared `DEFAULT`, generated value, or `NULL`. |
| `VALUES (...)` | One or more literal rows. The multi-row form `VALUES (a,b), (c,d), ...` is dramatically faster than N single-row `INSERT`s because it does one round-trip and one plan. |
| `query` (i.e. `INSERT ... SELECT`) | Insert the output of a `SELECT` (often from a staging table, FDW, or another schema). |

The optional column list (`(col1, col2, ...)`) is positional. **Always write the column list out.** Schema changes that add a new column at the end will silently shift unnamed positional `INSERT`s into wrong columns.

> [!NOTE] PostgreSQL 14
> `INSERT ... ON CONFLICT (col) DO UPDATE` on a partitioned table is allowed, but moving a row across partitions in `DO UPDATE` is **still rejected** (it would require coordinated `DELETE` + `INSERT` across partitions).[^insert-pg16]


### `DEFAULT VALUES` and the `DEFAULT` marker


`DEFAULT VALUES` is shorthand for "every column gets `DEFAULT`":

```sql
CREATE TABLE event (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), payload jsonb DEFAULT '{}'::jsonb);

INSERT INTO event DEFAULT VALUES RETURNING id, created_at;
```

The standalone `DEFAULT` keyword can also appear inside `VALUES` to pick the column's default for that one position:

```sql
INSERT INTO event (id, created_at, payload)
VALUES (DEFAULT, DEFAULT, '{"kind":"signup"}');
```

This matters for **identity** columns and **generated** columns — using `DEFAULT` is the only way to skip them in a positional `INSERT` without omitting the column from the column list.


### `OVERRIDING SYSTEM`/`USER VALUE` for identity columns


For columns declared `GENERATED ALWAYS AS IDENTITY`, any user-supplied value is **rejected** unless you say `OVERRIDING SYSTEM VALUE`:

```sql
CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY, name text);

INSERT INTO t (id, name) VALUES (42, 'no');         -- ERROR: cannot insert a non-DEFAULT value into column "id"
INSERT INTO t (id, name) OVERRIDING SYSTEM VALUE VALUES (42, 'yes');  -- OK
```

For `GENERATED BY DEFAULT AS IDENTITY`, the user value wins by default; `OVERRIDING USER VALUE` flips that and tells PG to use the sequence even if the user passed a value:

```sql
INSERT INTO t (id, name) OVERRIDING USER VALUE VALUES (42, 'use sequence anyway');
```

`OVERRIDING SYSTEM VALUE` is the right escape hatch for **bulk loading** an existing table that uses `ALWAYS AS IDENTITY` — without it you can't restore data. After load, run `SELECT setval(pg_get_serial_sequence('t','id'), MAX(id)) FROM t;` to fast-forward the sequence.


### `INSERT ... ON CONFLICT` (upsert)


The full grammar:

```sql
INSERT INTO ... VALUES ...
ON CONFLICT [ conflict_target ] { DO NOTHING | DO UPDATE SET ... [WHERE ...] }
[ RETURNING ... ]
```

`ON CONFLICT` only fires on a **unique-constraint or unique-index violation** (including primary-key violations). It does **not** fire on `CHECK`, `NOT NULL`, foreign-key, or exclusion-constraint violations — those still raise.

Two `conflict_action` forms:

- `DO NOTHING` — skip the row, no error. The `RETURNING` clause will **not** include skipped rows.
- `DO UPDATE SET col = ... [WHERE condition]` — update the conflicting row, optionally guarded by `WHERE`.

> [!WARNING] Locking under `DO UPDATE`
> Per the manual: "all rows will be locked when the ON CONFLICT DO UPDATE action is taken" — even rows where the optional `WHERE` evaluates to false are still locked (just not modified).[^insert-pg16] If the `WHERE` filters most rows, the lock footprint is still the full conflicting set.


### `conflict_target` — column lists, `ON CONSTRAINT`, partial indexes


Three ways to specify the conflict target:

```sql
-- by inferred unique index on column(s)
ON CONFLICT (email)
ON CONFLICT (lower(email))                                 -- expression index target
ON CONFLICT (tenant_id, email)
ON CONFLICT (email) WHERE deleted_at IS NULL                -- targets a *partial* unique index

-- by named constraint
ON CONFLICT ON CONSTRAINT users_email_uniq

-- omitted (only with DO NOTHING)
ON CONFLICT DO NOTHING                                      -- catches *any* unique/exclusion violation
```

Notes:

- The inference form `(col, ...)` must **uniquely** identify a single unique index (you can't be ambiguous between two indexes on the same column set with different opclasses or partial predicates).
- For a **partial unique index** like `CREATE UNIQUE INDEX ... ON users (email) WHERE deleted_at IS NULL`, you must supply the matching `WHERE` predicate in the conflict target.
- `ON CONFLICT ON CONSTRAINT name` is the most explicit form. Use it when the inference form is ambiguous, or when documentation clarity matters more than flexibility.
- The omitted form (`ON CONFLICT DO NOTHING` only) catches **any** unique or exclusion violation — useful for idempotent inserts without caring which constraint hit.

> [!WARNING] `CREATE INDEX CONCURRENTLY` interaction
> Per the manual: "While CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY is running on a unique index, INSERT ... ON CONFLICT statements on the same table may unexpectedly fail with a unique violation."[^insert-pg16] If you rebuild a unique index concurrently, expect transient `unique_violation` errors from upsert traffic — retry on the application side or quiesce upserts during the rebuild.


### `DO UPDATE SET` and the `EXCLUDED` pseudo-table


Inside `DO UPDATE`, two row sources are visible:

- The **existing row** in the target table, referenced by the table name (or alias).
- The **proposed-insert row**, referenced as `excluded`.

```sql
INSERT INTO inventory (sku, qty, last_seen_at)
VALUES ('ABC-1', 5, now())
ON CONFLICT (sku) DO UPDATE
    SET qty          = inventory.qty + excluded.qty,
        last_seen_at = greatest(inventory.last_seen_at, excluded.last_seen_at)
    WHERE inventory.qty + excluded.qty <= 1000;     -- guard: don't overflow
```

The optional `WHERE` on `DO UPDATE` is evaluated **after** the update target is chosen — it does **not** prevent the row from being locked, only from being modified.

The `EXCLUDED` reference also works in the `RETURNING` clause, but you usually want the **post-update** values from the target table:

```sql
INSERT INTO counter (id, n) VALUES (1, 1)
ON CONFLICT (id) DO UPDATE SET n = counter.n + excluded.n
RETURNING counter.n AS new_value;
```

> [!NOTE] Cardinality violation under multi-row `VALUES`
> Per the manual: `INSERT ... ON CONFLICT DO UPDATE` is "deterministic" — "the command will not be allowed to affect any single existing row more than once; a cardinality violation error will be raised when this situation arises."[^insert-pg16] Two source rows colliding on the same target row throws `ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time`. De-duplicate your `VALUES` list first.

> [!NOTE] PostgreSQL 15+ — `NULLS NOT DISTINCT` and upsert
> `UNIQUE NULLS NOT DISTINCT` (PG15) lets `NULL` collide with `NULL`. `ON CONFLICT` on such a column will now catch a previously-allowed `NULL`-vs-`NULL` insert — useful, but a behavior change worth flagging. See [`37-constraints.md`](./37-constraints.md).


### `UPDATE` — the complete grammar


```sql
[ WITH [ RECURSIVE ] with_query [, ...] ]
UPDATE [ ONLY ] table_name [ * ] [ [ AS ] alias ]
    SET { column_name = { expression | DEFAULT }
        | ( column_name [, ...] ) = [ ROW ] ( { expression | DEFAULT } [, ...] )
        | ( column_name [, ...] ) = ( sub-SELECT )
        } [, ...]
    [ FROM from_item [, ...] ]
    [ WHERE condition | WHERE CURRENT OF cursor_name ]
    [ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]
```

Key clauses:

| Clause | Notes |
|---|---|
| `ONLY` | Skip inheriting children. Use only if you really mean it — partitioned tables are not inheritance, so `ONLY` on a partitioned parent updates nothing. |
| `SET col = expr` | One assignment per column. Order doesn't matter; PG evaluates all RHS expressions over the **pre-update** row. |
| `SET (a,b) = (x, y)` | Multi-column row-constructor form. Identical to `SET a=x, b=y`. |
| `SET (a,b) = (SELECT x, y FROM ...)` | Multi-column subquery form — runs the subquery once per row updated. |
| `FROM` | Join other tables/CTEs/VALUES into the row source. See below — **the multi-match trap is here**. |
| `WHERE condition` | Filter rows to update. Without it, **every row is updated**. |
| `WHERE CURRENT OF cursor` | Update the row at a cursor's current position (only when the cursor is non-grouping, non-distinct, on the target table). |
| `RETURNING ...` | Post-update values, per row actually updated. |


### `UPDATE ... FROM` — joined updates and the duplicate-match trap


PostgreSQL extends standard SQL with an `UPDATE ... FROM` clause that lets you join other tables into the row source:

```sql
UPDATE accounts a
SET   tier = new_tier.label
FROM  new_tier
WHERE a.tier_id = new_tier.id;
```

The target table is **automatically** included as a `FROM`-clause member; **do not** add the target table to the `FROM` list again or you'll get a self-cross-join. To self-join, alias it:

```sql
UPDATE accounts a
SET   manager_id = b.id
FROM  accounts b
WHERE a.manager_email = b.email AND a.id <> b.id;
```

> [!WARNING] The duplicate-match trap
> Per the manual: "a target row shouldn't join to more than one row from the other table(s). If it does, then only one of the join rows will be used to update the target row, but which one will be used is not readily predictable."[^update-pg16] PostgreSQL will **not** error — it silently picks one. **Always verify the join produces a single row per target.** Add a `LIMIT 1` inside a subquery, or aggregate explicitly, when ambiguity exists.

A safe rewrite using a subquery:

```sql
UPDATE accounts a
SET   last_login_at = sub.max_login
FROM  ( SELECT user_id, max(login_at) AS max_login
        FROM   login_event
        GROUP  BY user_id ) sub
WHERE a.id = sub.user_id;
```


### Multi-column assignment and sub-`SELECT` assignment


When updating many columns from one row source, the multi-column form avoids repeating the subquery:

```sql
UPDATE customers c
SET   (city, region, postal_code) = (a.city, a.region, a.postal_code)
FROM  address_lookup a
WHERE a.customer_id = c.id;
```

Or with a sub-`SELECT` (executes per row):

```sql
UPDATE customers c
SET   (city, region, postal_code) = (
    SELECT city, region, postal_code
    FROM   address_lookup
    WHERE  customer_id = c.id
);
```

The `FROM`-clause form is almost always faster (one join vs N sub-`SELECT`s). The sub-`SELECT` form is only preferable when (a) the customer has at most one matching address and (b) you want NULL when there's no match — the sub-`SELECT` form yields `NULL` columns, while the `FROM`-clause form skips the row entirely.


### `DELETE` — the complete grammar


```sql
[ WITH [ RECURSIVE ] with_query [, ...] ]
DELETE FROM [ ONLY ] table_name [ * ] [ [ AS ] alias ]
    [ USING from_item [, ...] ]
    [ WHERE condition | WHERE CURRENT OF cursor_name ]
    [ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]
```

Same general shape as `UPDATE`: optional `ONLY`, mandatory target, optional `USING` clause (the `DELETE` equivalent of `UPDATE`'s `FROM`), optional `WHERE`, optional `RETURNING`.

Two reminders:

- `DELETE` without `WHERE` deletes every row. PostgreSQL will not warn you.
- **For deleting all rows from a table**, prefer [`TRUNCATE`](./01-syntax-ddl.md). It bypasses MVCC bloat, fires no row triggers (only statement-level, if any), and runs in roughly constant time.

> [!NOTE]
> `DELETE` does not free disk space immediately. The deleted tuples become dead and are reclaimed by `VACUUM`. After a large `DELETE`, run `VACUUM` (or wait for autovacuum) and `ANALYZE` to update planner stats. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).


### `DELETE ... USING` — joined deletes


`USING` is to `DELETE` what `FROM` is to `UPDATE`: it adds other tables to the row source, with the target table automatically present:

```sql
DELETE FROM films f
USING   producers p
WHERE   f.producer_id = p.id AND p.name = 'foo';
```

Same multi-match caveat applies — if multiple `producers` rows match a single `films` row, the delete still happens (the row is gone once, regardless), but **`RETURNING`** may report the row multiple times. Prefer `EXISTS` for clarity when you don't need columns from the other table:

```sql
DELETE FROM films f
WHERE   EXISTS (SELECT 1 FROM producers p WHERE p.id = f.producer_id AND p.name = 'foo');
```


### `MERGE` (PG15+)


> [!NOTE] PostgreSQL 15
> Added in PG15: "Add SQL `MERGE` command to adjust one table to match another." Per the release notes: "This is similar to `INSERT ... ON CONFLICT` but more batch-oriented."[^pg15-merge]

The grammar (PG15/16):

```sql
[ WITH with_query [, ...] ]
MERGE INTO [ ONLY ] target_table_name [ * ] [ [ AS ] target_alias ]
    USING data_source ON join_condition
    when_clause [...]
```

Where each `when_clause` is one of:

```sql
WHEN MATCHED     [ AND condition ] THEN { UPDATE SET ... | DELETE | DO NOTHING }
WHEN NOT MATCHED [ AND condition ] THEN { INSERT (...) VALUES (...) | INSERT DEFAULT VALUES | DO NOTHING }
```

A canonical sync example:

```sql
MERGE INTO customer_account ca
USING   recent_transactions t
ON      t.customer_id = ca.customer_id
WHEN MATCHED THEN
    UPDATE SET balance = ca.balance + t.amount
WHEN NOT MATCHED THEN
    INSERT (customer_id, balance) VALUES (t.customer_id, t.amount);
```

`MERGE` clauses are checked **top-down per source row**: the first matching `WHEN` clause wins. This means you can layer `AND condition` predicates:

```sql
MERGE INTO inventory i
USING   shipments s
ON      i.sku = s.sku
WHEN MATCHED AND s.kind = 'restock' THEN UPDATE SET qty = i.qty + s.qty
WHEN MATCHED AND s.kind = 'recall'  THEN UPDATE SET qty = i.qty - s.qty
WHEN MATCHED AND s.kind = 'audit'   THEN DO NOTHING
WHEN NOT MATCHED                    THEN INSERT (sku, qty) VALUES (s.sku, s.qty);
```

> [!WARNING] `MERGE` does not coordinate with concurrent inserts
> Unlike `INSERT ... ON CONFLICT`, `MERGE` does **not** internally re-check uniqueness after taking a snapshot. Under Read Committed isolation, two concurrent `MERGE`s targeting the same key can both decide "NOT MATCHED" and both try to `INSERT`, with the second failing on the unique-violation. Per the manual: "You may also wish to consider using `INSERT ... ON CONFLICT` as an alternative statement which offers the ability to run an `UPDATE` if a concurrent `INSERT` occurs."[^merge-pg16] Use `ON CONFLICT` when concurrent upserts are likely; reach for `MERGE` when you have `DELETE` or branching logic that `ON CONFLICT` can't express.

> [!WARNING] Cardinality violation
> Per the manual: "you should ensure that the join produces at most one candidate change row for each target row ... later attempts to modify the row will cause an error."[^merge-pg16] Multiple source rows hitting the same target throws `ERROR: MERGE command cannot affect row a second time` (cardinality violation). De-duplicate the source first.


### `MERGE ... WHEN NOT MATCHED BY SOURCE` (PG17+)


> [!NOTE] PostgreSQL 17
> Per the release notes: "Add `WHEN NOT MATCHED BY SOURCE` to `MERGE`. `WHEN NOT MATCHED` on target rows was already supported."[^pg17-merge-nmbs]

PG17 adds a third `WHEN` variant for rows present in the **target** but absent from the **source**:

```sql
WHEN NOT MATCHED BY SOURCE [ AND condition ] THEN { UPDATE SET ... | DELETE | DO NOTHING }
WHEN NOT MATCHED [ BY TARGET ] [ AND condition ] THEN { INSERT ... | DO NOTHING }   -- pre-PG17 default
```

The default `WHEN NOT MATCHED` is `BY TARGET` — meaning "source row has no target match" (insert candidates). The new `BY SOURCE` is the inverse — "target row has no source match" (delete candidates):

```sql
-- Full-set sync: target ends up equal to source
MERGE INTO product_catalog c
USING   product_staging s
ON      c.sku = s.sku
WHEN MATCHED                 THEN UPDATE SET name = s.name, price = s.price
WHEN NOT MATCHED BY TARGET   THEN INSERT (sku, name, price) VALUES (s.sku, s.name, s.price)
WHEN NOT MATCHED BY SOURCE   THEN DELETE;
```

This collapses what was previously three statements (`INSERT ... SELECT ... WHERE NOT IN`, `UPDATE ... FROM`, `DELETE ... WHERE NOT IN`) into one. Note: this is one of the strongest reasons to prefer `MERGE` over `ON CONFLICT` — `ON CONFLICT` has no `DELETE` action.


### `MERGE ... RETURNING` and `merge_action()` (PG17+)


> [!NOTE] PostgreSQL 17
> Per the release notes: "Allow `MERGE` to use the `RETURNING` clause. The new `RETURNING` function `merge_action()` reports on the DML that generated the row."[^pg17-merge-returning]

```sql
MERGE INTO product_catalog c
USING   product_staging s
ON      c.sku = s.sku
WHEN MATCHED               THEN UPDATE SET price = s.price
WHEN NOT MATCHED BY TARGET THEN INSERT (sku, name, price) VALUES (s.sku, s.name, s.price)
WHEN NOT MATCHED BY SOURCE THEN DELETE
RETURNING merge_action() AS action, c.sku, c.price;
```

`merge_action()` returns one of the strings `'INSERT'`, `'UPDATE'`, or `'DELETE'` — useful for logging, metrics, or downstream filtering. Combined with the PG17 `MERGE ... RETURNING`, this is the canonical way to drive an audit/CDC stream from a sync job.

> [!NOTE] PostgreSQL 17
> Per the release notes: "Allow `MERGE` to modify updatable views."[^pg17-merge-views] Previously `MERGE` rejected updatable views as targets.


### `RETURNING` — output rows from any DML


`RETURNING` is supported on `INSERT`, `UPDATE`, `DELETE`, and (since PG17) `MERGE`. It is a PostgreSQL extension; it does **not** exist in standard SQL.

```sql
INSERT INTO users (email) VALUES ('a@b.c') RETURNING id;
UPDATE users SET activated_at = now() WHERE id = $1 RETURNING activated_at;
DELETE FROM old_sessions WHERE created_at < now() - interval '7 days' RETURNING id, user_id;
MERGE INTO ... RETURNING merge_action(), *;   -- PG17+
```

What `RETURNING` returns:

- For `INSERT`: post-insert values for **successfully inserted** rows (or post-update values for rows handled by `ON CONFLICT DO UPDATE`; skipped `DO NOTHING` rows are not returned).
- For `UPDATE`: post-update values for **updated** rows only.
- For `DELETE`: pre-delete values for **deleted** rows.
- For `MERGE` (PG17+): post-action values; `merge_action()` reports which branch executed.

Combine with `WITH` to capture a result set without a separate query:

```sql
WITH inserted AS (
    INSERT INTO event (payload) SELECT row_to_json(t) FROM new_things t
    RETURNING id
)
INSERT INTO event_index (event_id) SELECT id FROM inserted;
```


### `RETURNING OLD.*` / `NEW.*` (PG18+)


> [!NOTE] PostgreSQL 18
> Per the release notes: "Add `OLD`/`NEW` support to `RETURNING` in DML queries. Previously `RETURNING` only returned new values for `INSERT` and `UPDATE`, and old values for `DELETE`; `MERGE` would return the appropriate value for the internal query executed. This new syntax allows the `RETURNING` list of `INSERT`/`UPDATE`/`DELETE`/`MERGE` to explicitly return old and new values by using the special aliases `old` and `new`. These aliases can be renamed to avoid identifier conflicts."[^pg18-returning-oldnew]

```sql
-- PG18+: capture both pre and post values from an UPDATE without a trigger
UPDATE accounts SET balance = balance - 100
WHERE  id = 42
RETURNING old.balance AS was, new.balance AS now;

-- Renaming the aliases if your column is named "old" or "new"
UPDATE pages SET ... RETURNING old AS prior, new AS current;
```

Before PG18, this pattern required either:

- An `AFTER UPDATE` trigger with a transition table (PG10+), or
- A self-join CTE: `WITH before AS (SELECT * FROM accounts WHERE id = 42) UPDATE ... RETURNING ... ` combined with the CTE.

PG18's `OLD`/`NEW` makes the trigger or CTE unnecessary for the common audit/log case.


### Data-modifying CTEs (`WITH ... INSERT/UPDATE/DELETE/MERGE`)


All four DML statements can appear inside a `WITH` clause, and their `RETURNING` output can feed downstream queries:

```sql
WITH archived AS (
    DELETE FROM orders WHERE status = 'cancelled' AND created_at < now() - interval '1 year'
    RETURNING *
), logged AS (
    INSERT INTO orders_archive SELECT * FROM archived
    RETURNING id
)
SELECT count(*) FROM logged;
```

Important semantic rules for data-modifying CTEs:

- All data-modifying CTEs run **with the same snapshot** as the main query. They do not see each other's effects on the underlying tables.
- The order of execution among them is **not defined**. Don't rely on it.
- Only the main query and CTEs that explicitly reference a data-modifying CTE's `RETURNING` output see those rows.
- `MERGE` in a CTE supports `RETURNING` only as of PG17.

Deep dive in [`04-ctes.md`](./04-ctes.md).


### Lock levels taken by DML


| Statement | Table lock | Row-level lock taken on modified rows |
|---|---|---|
| `INSERT` (no `ON CONFLICT`) | `ROW EXCLUSIVE` | None (new tuples are visible only to inserting txn until commit) |
| `INSERT ... ON CONFLICT DO NOTHING` | `ROW EXCLUSIVE` | None on skipped rows |
| `INSERT ... ON CONFLICT DO UPDATE` | `ROW EXCLUSIVE` | **Row lock on every matched row, even ones the `WHERE` filters out** |
| `UPDATE` | `ROW EXCLUSIVE` | `FOR NO KEY UPDATE` if no PK/unique column changed, else `FOR UPDATE` |
| `DELETE` | `ROW EXCLUSIVE` | `FOR UPDATE` |
| `MERGE` (per `WHEN` branch) | `ROW EXCLUSIVE` | As above, per the action chosen |
| `TRUNCATE` | `ACCESS EXCLUSIVE` | n/a (table-level only) |

`ROW EXCLUSIVE` conflicts with `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE`. It does **not** conflict with other `ROW EXCLUSIVE`, so concurrent INSERT/UPDATE/DELETE are fine at the table level; row-level conflicts are managed by tuple-level locks. Full matrix in [`43-locking.md`](./43-locking.md).


## Examples / Recipes


### 1. Bulk insert with multi-row `VALUES`

```sql
INSERT INTO log_event (ts, level, msg) VALUES
    (now(), 'INFO',  'startup'),
    (now(), 'WARN',  'slow query'),
    (now(), 'ERROR', 'connection lost'),
    (now(), 'INFO',  'shutdown');
```

Single round-trip, single plan, single transaction. For >1000 rows, switch to `COPY` (see [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md)).


### 2. Idempotent insert: `ON CONFLICT DO NOTHING`

```sql
INSERT INTO tag (name) VALUES ('postgres'), ('database'), ('mvcc')
ON CONFLICT (name) DO NOTHING
RETURNING id, name;            -- only newly inserted rows appear here
```

Use when you need to ensure a row exists but don't need to touch it if it does. Skipped rows are **not** returned by `RETURNING`.

If you need the row regardless (whether inserted or pre-existing), pair with a follow-up `SELECT`:

```sql
WITH ins AS (
    INSERT INTO tag (name) VALUES ('postgres') ON CONFLICT (name) DO NOTHING
    RETURNING id
)
SELECT id FROM ins
UNION ALL
SELECT id FROM tag WHERE name = 'postgres' AND NOT EXISTS (SELECT 1 FROM ins);
```

Or — cleaner — touch the row to force `RETURNING` to fire:

```sql
INSERT INTO tag (name) VALUES ('postgres')
ON CONFLICT (name) DO UPDATE SET name = excluded.name
RETURNING id;
```

The second form costs a no-op `UPDATE` (and the row lock that comes with it), but the `id` always comes back.


### 3. Counter upsert

```sql
INSERT INTO page_view (page_id, day, hits) VALUES ($1, current_date, 1)
ON CONFLICT (page_id, day) DO UPDATE
    SET hits = page_view.hits + 1
RETURNING hits;
```

This is the canonical concurrent-safe counter pattern. Each transaction either inserts a new row or atomically increments the existing one. Locking is per-row, so different `(page_id, day)` pairs don't contend.


### 4. Bulk upsert from a staging table

```sql
INSERT INTO product (sku, name, price, updated_at)
SELECT sku, name, price, now() FROM product_staging
ON CONFLICT (sku) DO UPDATE
    SET name       = excluded.name,
        price      = excluded.price,
        updated_at = excluded.updated_at
    WHERE product.name <> excluded.name OR product.price <> excluded.price;
```

The optional `WHERE product.name <> excluded.name OR ...` skips no-op updates — saves on WAL volume and dead-tuple creation. **But it still locks every matched row.**

If the staging table can contain duplicates by `sku`, you'll hit a cardinality-violation error. Pre-deduplicate:

```sql
INSERT INTO product (sku, name, price, updated_at)
SELECT sku, name, price, now()
FROM   ( SELECT DISTINCT ON (sku) sku, name, price
         FROM   product_staging
         ORDER  BY sku, loaded_at DESC ) s
ON CONFLICT (sku) DO UPDATE SET name = excluded.name, price = excluded.price;
```


### 5. Joined update from staging

```sql
UPDATE customer c
SET    region = s.region, tier = s.tier, updated_at = now()
FROM   customer_staging s
WHERE  c.id = s.customer_id;
```

For partial updates (only some staging rows have a `region`), guard with `COALESCE`:

```sql
UPDATE customer c
SET    region = COALESCE(s.region, c.region),
       tier   = COALESCE(s.tier,   c.tier),
       updated_at = now()
FROM   customer_staging s
WHERE  c.id = s.customer_id;
```


### 6. Deleting top-N rows

Plain `DELETE ... LIMIT N` does **not exist** in PostgreSQL. Use a subquery with `ctid` (the physical tuple identifier) — fastest because no FK or index lookup is needed:

```sql
DELETE FROM event
WHERE  ctid IN ( SELECT ctid FROM event
                 WHERE  level = 'DEBUG'
                 ORDER  BY ts ASC
                 LIMIT  10000 );
```

`ctid` is stable within a transaction (no concurrent VACUUM-FULL or CLUSTER), so this is safe inside one statement.


### 7. Cascading delete via `USING` from a join table

```sql
DELETE FROM article a
USING   author au
WHERE   a.author_id = au.id
   AND  au.banned_at IS NOT NULL
RETURNING a.id;
```


### 8. Full-set sync with `MERGE` (PG17+)

```sql
MERGE INTO product p
USING   product_source s ON p.sku = s.sku
WHEN MATCHED AND (p.name, p.price) IS DISTINCT FROM (s.name, s.price)
                            THEN UPDATE SET name = s.name, price = s.price
WHEN NOT MATCHED BY TARGET  THEN INSERT (sku, name, price) VALUES (s.sku, s.name, s.price)
WHEN NOT MATCHED BY SOURCE  THEN DELETE
RETURNING merge_action() AS act, p.sku, p.name, p.price;
```

Three-way collapse of insert/update/delete in a single statement, with per-row branch reporting. The `IS DISTINCT FROM` predicate on the matched branch skips no-op updates.


### 9. Audit table via `RETURNING OLD`/`NEW` (PG18+)

```sql
WITH changed AS (
    UPDATE customer c SET tier = $1, updated_at = now()
    WHERE  id = $2
    RETURNING old.tier AS old_tier, new.tier AS new_tier, c.id, new.updated_at
)
INSERT INTO customer_audit (customer_id, old_tier, new_tier, changed_at)
SELECT id, old_tier, new_tier, updated_at FROM changed;
```

Pre-PG18: required an `AFTER UPDATE` trigger with `REFERENCING OLD TABLE`/`NEW TABLE` transition tables.


### 10. Upsert vs MERGE — pick the right tool

| Need | Use | Why |
|---|---|---|
| "Insert, or update on dup-key" | `INSERT ... ON CONFLICT DO UPDATE` | Handles concurrent inserts safely; simpler grammar. |
| "Insert, ignoring duplicates" | `INSERT ... ON CONFLICT DO NOTHING` | Idempotent loaders. |
| "Sync table A to table B, including deletes" | `MERGE ... WHEN NOT MATCHED BY SOURCE THEN DELETE` (PG17+) | Only `MERGE` has a `DELETE` action. |
| "Conditional branching: insert vs update vs delete vs do-nothing in one pass" | `MERGE` (with `AND condition` per branch) | `ON CONFLICT` can't branch. |
| "Need to return both pre and post values" | `RETURNING old.*`, `new.*` (PG18+) or transition-table trigger | Trigger for older majors. |
| "Update many columns from a join" | `UPDATE ... FROM` | Single join; faster than `MERGE` or correlated `SET`. |


### 11. Delete-and-archive in a single statement

```sql
WITH moved AS (
    DELETE FROM session
    WHERE  last_seen_at < now() - interval '90 days'
    RETURNING *
)
INSERT INTO session_archive SELECT * FROM moved;
```

The `DELETE` and `INSERT` see the same snapshot. Wrapped in an explicit transaction, this is atomic.


### 12. `WHERE CURRENT OF` for cursor-driven updates

```sql
DECLARE cur SCROLL CURSOR FOR SELECT id FROM big_table WHERE needs_fix = true;
-- iterate in app code, occasionally:
FETCH NEXT FROM cur;
UPDATE big_table SET fixed_at = now() WHERE CURRENT OF cur;
```

Used in PL/pgSQL and from cursor-aware drivers; rarely the right tool from application code (one round-trip per row is slow). Cursor must be on the target table and non-grouping.


## Gotchas / Anti-patterns


- **Positional `INSERT` without a column list.** `INSERT INTO t VALUES (...)` is brittle — any future `ALTER TABLE ... ADD COLUMN` silently changes its semantics. Always name columns.
- **`UPDATE ... FROM` with a many-to-one source.** PG silently picks one row. Aggregate, `DISTINCT ON`, or `LIMIT 1`-in-subquery first.
- **`DELETE` without `WHERE`.** Wipes the table, no warning. Prefer `TRUNCATE` if that was actually your intent — it's faster and avoids MVCC bloat.
- **Forgetting `ANALYZE` after a large `DELETE` or `UPDATE`.** Planner estimates go stale, autovacuum may take a while to catch up. `ANALYZE` immediately after the change.
- **`ON CONFLICT` partition-key changes.** `INSERT ... ON CONFLICT DO UPDATE` on a partitioned table cannot move the row across partitions. Restructure as a manual `DELETE` + `INSERT` if you need that.
- **`ON CONFLICT` locks all matched rows even with a `WHERE` on `DO UPDATE`.** See the WARNING admonition in the [`ON CONFLICT` mechanics section](#insert--on-conflict-upsert).
- **`MERGE` vs concurrent inserts.** `MERGE` does **not** internally protect against another transaction inserting a conflicting row between the snapshot and the `INSERT`. For high-concurrency upserts of a known key, use `INSERT ... ON CONFLICT`.
- **`MERGE` cardinality violation.** Multiple source rows joining one target row is a fatal error per `WHEN` action. De-duplicate source first.
- **`MERGE` statement triggers fire for unused branches.** If a `MERGE` declares `WHEN MATCHED THEN UPDATE`, the `UPDATE` statement trigger fires **even if zero rows matched**. Per-action statement triggers can't tell you whether anything actually changed; use row triggers or `RETURNING merge_action()`.
- **`NOT IN (subquery)` is unsafe on nullable columns.** `WHERE col NOT IN (SELECT x FROM t)` returns no rows if any `t.x` is `NULL`. Use `NOT EXISTS` for anti-joins. (Detailed in [`02-syntax-dql.md`](./02-syntax-dql.md).)
- **`RETURNING *` after `ON CONFLICT DO UPDATE` mixes inserted and updated rows.** They share the same shape (the target table's columns), but if you wanted to distinguish, use a marker column like `xmax = 0` (true for fresh inserts) or upgrade to PG17 `MERGE` with `merge_action()`.
- **`CREATE INDEX CONCURRENTLY` on a unique index breaks `ON CONFLICT`.** Transient unique-violation errors during the rebuild. Quiesce upserts or implement application-side retry.
- **HOT updates and the change-column list.** An `UPDATE` that touches an indexed column **cannot** be HOT; the new tuple goes on a new page and the index gets a new pointer. Avoid touching indexed columns unless necessary. See [`30-hot-updates.md`](./30-hot-updates.md).
- **Big `UPDATE` rewrites the whole row.** PostgreSQL's MVCC writes a new tuple even if only one column changed. Large rows × frequent updates × indexed columns × no HOT = bloat. Consider splitting volatile columns into a side table.
- **`UPDATE` on a partitioned parent that changes the partition key moves the row.** As of PG11+, partition-key updates work transparently — but lock and cost are higher than an in-partition update. As of PG17, this also works for `MERGE`.
- **Toasted columns aren't rewritten on `UPDATE` if untouched.** `UPDATE` of a row with a 1MB TOASTed `text` column does **not** rewrite the TOAST tuple if that column wasn't in the `SET` list. The TOAST pointer is copied; only the main heap tuple is rewritten. See [`31-toast.md`](./31-toast.md).
- **`UPDATE` and `idle_in_transaction_session_timeout`.** A long-running transaction that has UPDATEd rows holds row locks. If it's idle, autovacuum can't reclaim the dead tuples until it commits or aborts. Set `idle_in_transaction_session_timeout` to kill stragglers. See [`41-transactions.md`](./41-transactions.md).


## See Also


- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — `CREATE TABLE`, `TRUNCATE`, identity columns, constraints
- [`02-syntax-dql.md`](./02-syntax-dql.md) — `SELECT`, joins, `LATERAL`, `RETURNING`-feeding sub-queries
- [`04-ctes.md`](./04-ctes.md) — data-modifying CTEs in depth
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — what an `UPDATE` actually does to the heap (new tuple, old tuple dead)
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — reclaiming the dead tuples a busy DML workload produces
- [`30-hot-updates.md`](./30-hot-updates.md) — HOT updates, fillfactor, n_tup_hot_upd
- [`31-toast.md`](./31-toast.md) — TOAST behavior on UPDATE
- [`35-partitioning.md`](./35-partitioning.md) — partition-routing INSERTs and partition-key UPDATEs
- [`37-constraints.md`](./37-constraints.md) — UNIQUE NULLS NOT DISTINCT (PG15) and ON CONFLICT
- [`39-triggers.md`](./39-triggers.md) — BEFORE / AFTER / INSTEAD OF, transition tables
- [`41-transactions.md`](./41-transactions.md) — autocommit, idle-in-transaction
- [`42-isolation-levels.md`](./42-isolation-levels.md) — MERGE vs ON CONFLICT under concurrent isolation
- [`43-locking.md`](./43-locking.md) — full lock matrix, row-level locks taken by DML
- [`56-explain.md`](./56-explain.md) — interpreting `EXPLAIN ANALYZE` for DML plans (Modify nodes)
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — `COPY` as the bulk-ingest alternative


## Sources


[^insert-pg16]: PostgreSQL 16 documentation, `INSERT`. https://www.postgresql.org/docs/16/sql-insert.html — quotes used: "All columns will be filled with their default values..."; "the SET and WHERE clauses in ON CONFLICT DO UPDATE have access to the existing row using the table's name (or an alias), and to the row proposed for insertion using the special `excluded` table"; "all rows will be locked when the ON CONFLICT DO UPDATE action is taken"; "INSERT with an ON CONFLICT DO UPDATE clause is a 'deterministic' statement. This means that the command will not be allowed to affect any single existing row more than once; a cardinality violation error will be raised when this situation arises."; "While CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY is running on a unique index, INSERT ... ON CONFLICT statements on the same table may unexpectedly fail with a unique violation."; "It is currently not supported for the ON CONFLICT DO UPDATE clause of an INSERT applied to a partitioned table to update the partition key of a conflicting row such that it requires the row be moved to a new partition."

[^update-pg16]: PostgreSQL 16 documentation, `UPDATE`. https://www.postgresql.org/docs/16/sql-update.html — quote used: "When using FROM you should ensure that the join produces at most one output row for each row to be modified. In other words, a target row shouldn't join to more than one row from the other table(s). If it does, then only one of the join rows will be used to update the target row, but which one will be used is not readily predictable."

[^delete-pg16]: PostgreSQL 16 documentation, `DELETE`. https://www.postgresql.org/docs/16/sql-delete.html

[^merge-pg16]: PostgreSQL 16 documentation, `MERGE`. https://www.postgresql.org/docs/16/sql-merge.html — quotes used: "You should ensure that the join produces at most one candidate change row for each target row. In other words, a target row shouldn't join to more than one data source row. If it does, then only one of the candidate change rows will be used to modify the target row; later attempts to modify the row will cause an error."; "You may also wish to consider using INSERT ... ON CONFLICT as an alternative statement which offers the ability to run an UPDATE if a concurrent INSERT occurs. There are a variety of differences and restrictions between the two statement types and they are not interchangeable."

[^pg15-merge]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/ — quote used: "Add SQL MERGE command to adjust one table to match another (Simon Riggs, Pavan Deolasee, Álvaro Herrera, Amit Langote). This is similar to INSERT ... ON CONFLICT but more batch-oriented."

[^pg17-merge-nmbs]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — quote used: "Add WHEN NOT MATCHED BY SOURCE to MERGE (Dean Rasheed). WHEN NOT MATCHED on target rows was already supported."

[^pg17-merge-returning]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — quote used: "Allow MERGE to use the RETURNING clause (Dean Rasheed). The new RETURNING function merge_action() reports on the DML that generated the row."

[^pg17-merge-views]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — quote used: "Allow MERGE to modify updatable views (Dean Rasheed)."

[^pg17-merge-syntax]: PostgreSQL 17 documentation, `MERGE`. https://www.postgresql.org/docs/17/sql-merge.html — confirms the three WHEN variants (`WHEN MATCHED`, `WHEN NOT MATCHED BY SOURCE`, `WHEN NOT MATCHED [BY TARGET]`) and the optional `RETURNING` clause with `merge_action()`.

[^pg18-returning-oldnew]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — quote used: "Add OLD/NEW support to RETURNING in DML queries (Dean Rasheed). Previously RETURNING only returned new values for INSERT and UPDATE, and old values for DELETE; MERGE would return the appropriate value for the internal query executed. This new syntax allows the RETURNING list of INSERT/UPDATE/DELETE/MERGE to explicitly return old and new values by using the special aliases old and new. These aliases can be renamed to avoid identifier conflicts."

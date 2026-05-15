# Views — Regular, Updatable, Materialized

A view is a named SELECT that you can query like a table. PostgreSQL has two distinct kinds — **regular views** (virtual, recomputed on every query) and **materialized views** (physically stored, refreshed on demand) — plus a security layer (`security_barrier`, `security_invoker`) and an updatability story (auto-updatable by default for trivial views; `INSTEAD OF` triggers for the rest).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [How views are implemented (the rule system)](#how-views-are-implemented-the-rule-system)
    - [CREATE VIEW](#create-view)
    - [View options: check_option, security_barrier, security_invoker](#view-options-check_option-security_barrier-security_invoker)
    - [ALTER VIEW](#alter-view)
    - [DROP VIEW](#drop-view)
    - [Updatable views (auto-updatable rules)](#updatable-views-auto-updatable-rules)
    - [INSTEAD OF triggers (for non-auto-updatable views)](#instead-of-triggers-for-non-auto-updatable-views)
    - [WITH CHECK OPTION](#with-check-option)
    - [Recursive views](#recursive-views)
    - [CREATE MATERIALIZED VIEW](#create-materialized-view)
    - [REFRESH MATERIALIZED VIEW](#refresh-materialized-view)
    - [Lock-level summary](#lock-level-summary)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Load this file when the question involves views, materialized views, updatability, `security_barrier`, `security_invoker`, or `REFRESH MATERIALIZED VIEW`. For the underlying SELECT syntax see [`02-syntax-dql.md`](./02-syntax-dql.md). For the rule system see [`52-rules-system.md`](./52-rules-system.md). For triggers see [`39-triggers.md`](./39-triggers.md).


## Syntax / Mechanics


### How views are implemented (the rule system)


A regular view is a relation with **no storage** and one `ON SELECT DO INSTEAD` rewrite rule (conventionally named `_RETURN`). At query-rewrite time the planner substitutes the view's SELECT into the calling query tree.[^rules-views]

That's why this:

    CREATE VIEW myview AS SELECT * FROM mytab;

is internally equivalent to:

    CREATE TABLE myview (/* same column list as mytab */);
    CREATE RULE "_RETURN" AS ON SELECT TO myview DO INSTEAD
        SELECT * FROM mytab;

Two consequences fall out of this design:

1. Views compose: a view over a view over a table flattens at rewrite, so the planner sees the full query tree and can optimize across all the layers.
2. Predicates pushed against the view typically pass *through* the view into the base table — unless you turn that off explicitly with `security_barrier` (see below).

The full mechanics live in [52-rules-system.md](./52-rules-system.md). For day-to-day use, what matters is that **a view does not add a hard optimization fence** — the way `MATERIALIZED` in a CTE does (see [04-ctes.md](./04-ctes.md)).


### CREATE VIEW


    CREATE [ OR REPLACE ] [ TEMP | TEMPORARY ] [ RECURSIVE ] VIEW name
        [ ( column_name [, ...] ) ]
        [ WITH ( view_option_name [= view_option_value] [, ...] ) ]
        AS query
        [ WITH [ CASCADED | LOCAL ] CHECK OPTION ]

Key points:[^create-view]

- `OR REPLACE` requires the new definition to keep the **same set, order, and types** of output columns. You can *add* trailing columns; you cannot rename or reorder existing ones.
- `TEMP` / `TEMPORARY` views live only for the session and are created in `pg_temp`.
- `RECURSIVE` is the view-form of `WITH RECURSIVE` — useful for graph traversals that you want to expose as a relation. See [Recursive views](#recursive-views) below.
- Explicit `column_name` list lets you rename the view's output columns without rewriting the inner SELECT.

> [!WARNING] CREATE OR REPLACE pitfalls
> `CREATE OR REPLACE VIEW` cannot change the data type of an existing output column, cannot drop or reorder columns, and (since PG15) cannot change a column's **collation**[^pg15-view-collation]. If you need any of those, drop and recreate the view — which also drops every dependent object unless you use `CASCADE`.

> [!NOTE] PostgreSQL 15
> `CREATE OR REPLACE VIEW` is no longer allowed to change the collation of an output column. Previously it could, which led to subtle behavior differences when a view was redefined to use a different `COLLATE` than the original.[^pg15-view-collation]


### View options: check_option, security_barrier, security_invoker


Three boolean/enum options are supported in `WITH ( ... )`:[^create-view]

| Option | Type | Default | Purpose |
|---|---|---|---|
| `check_option` | `local` / `cascaded` | (off) | Enforce that INSERT/UPDATE through the view cannot produce rows that the view's WHERE would hide |
| `security_barrier` | boolean | `false` | Block predicate push-down through the view so leaky functions can't see filtered-out rows |
| `security_invoker` | boolean | `false` (PG15+) | Run base-table access checks against the **invoker's** privileges, not the view owner's |

#### `security_barrier` — protecting from "leaky" functions


Without `security_barrier`, the planner may push a user-supplied WHERE predicate *underneath* the view's WHERE. If that user predicate is a cheap function with a side effect (a `RAISE NOTICE`, a write to a log table, a network call), the function sees rows that the view was supposed to hide.

The canonical exploit from the docs:[^rules-privileges]

    CREATE VIEW phone_number AS
        SELECT person, phone FROM phone_data WHERE phone NOT LIKE '412%';

    CREATE FUNCTION tricky(text, text) RETURNS bool AS $$
    BEGIN
        RAISE NOTICE '% => %', $1, $2;
        RETURN true;
    END;
    $$ LANGUAGE plpgsql COST 0.0000000000000000000001;

    SELECT * FROM phone_number WHERE tricky(person, phone);

The planner runs `tricky()` *before* the `NOT LIKE` filter because it's cheaper — and the attacker harvests every row, including the 412-area-code rows the view was meant to hide.

Fix:

    CREATE VIEW phone_number WITH (security_barrier) AS
        SELECT person, phone FROM phone_data WHERE phone NOT LIKE '412%';

With the barrier set, the planner refuses to push any non-leakproof function below the view's own WHERE.[^rules-privileges]

**Performance cost is real.** A `security_barrier` view rejects optimization opportunities. The docs are explicit: *"there is no way to avoid this: the fastest possible plan must be rejected if it may compromise security."*[^rules-privileges] Use it when you're using the view for security (often combined with RLS — see [47-row-level-security.md](./47-row-level-security.md)). Don't sprinkle it on views that are just for readability.

> [!NOTE] Leakproof functions can still be pushed
> A function declared `LEAKPROOF` (set via `CREATE FUNCTION ... LEAKPROOF`, superuser-only) is guaranteed to leak no information about its input via side effects or errors. The planner is allowed to evaluate it before a `security_barrier`. Most built-in equality and comparison operators are leakproof.[^rules-privileges]


#### `security_invoker` — caller's privileges, not owner's


> [!NOTE] PostgreSQL 15
> Added by Christoph Heiss: *"Allow table accesses done by a view to optionally be controlled by privileges of the view's caller… Previously, view accesses were always treated as being done by the view's owner. That's still the default."*[^pg15-security-invoker]

The default model: a view runs base-table access checks **as the view's owner**. That's useful when the owner has access to a sensitive table and you want to expose a filtered slice to less-privileged users — they need privileges on the view, not on the base table.

With `security_invoker=true`, the model flips: base-table access uses the **invoker's** privileges. The invoker must have rights on both the view and every base table the view touches.

Use `security_invoker=true` when:

- You want a view to be an alias / abstraction, not a privilege bridge. The caller's permissions stay authoritative.
- You're combining views with RLS and want the invoker's row-level policies to apply, not the owner's.

Use the default (owner-semantics) when:

- The view exists *because* you want to grant base-table access through a filter that the user can't bypass.

Set it in `CREATE VIEW`:

    CREATE VIEW orders_safe WITH (security_invoker = true) AS
        SELECT id, customer_id, total FROM orders;

…or change it later with `ALTER VIEW`:

    ALTER VIEW orders_safe SET (security_invoker = true);


#### `check_option` — block escape-the-view writes


When the view has a `WHERE` clause and is updatable, an INSERT or UPDATE through the view could produce a row that fails the WHERE — and would therefore be invisible through the view itself.

    CREATE VIEW pg_movies WITH (check_option = cascaded) AS
        SELECT * FROM movies WHERE rating = 'PG';

    -- Rejected: the new row would have rating='R' and be invisible through pg_movies
    INSERT INTO pg_movies (title, rating) VALUES ('Restricted Movie', 'R');

Two modes:[^create-view]

- `local` — check only this view's predicates.
- `cascaded` (default when you just write `WITH CHECK OPTION`) — check this view's predicates **and** every underlying base view's predicates.

`check_option` is the SQL-standard `WITH CHECK OPTION`. Both forms can be set in `CREATE VIEW`; only the `WITH (check_option = ...)` form can be modified later via `ALTER VIEW`.


### ALTER VIEW


    ALTER VIEW [ IF EXISTS ] name ALTER [ COLUMN ] column_name SET DEFAULT expression
    ALTER VIEW [ IF EXISTS ] name ALTER [ COLUMN ] column_name DROP DEFAULT
    ALTER VIEW [ IF EXISTS ] name OWNER TO new_owner
    ALTER VIEW [ IF EXISTS ] name RENAME [ COLUMN ] old TO new
    ALTER VIEW [ IF EXISTS ] name RENAME TO new_name
    ALTER VIEW [ IF EXISTS ] name SET SCHEMA new_schema
    ALTER VIEW [ IF EXISTS ] name SET ( option_name [= value] [, ...] )
    ALTER VIEW [ IF EXISTS ] name RESET ( option_name [, ...] )

You can flip any of `check_option`, `security_barrier`, `security_invoker` via `SET` / `RESET`.[^alter-view] You **cannot** change the underlying SELECT this way — use `CREATE OR REPLACE VIEW` (subject to the column-rename / collation restrictions above) or drop and recreate.

`SET DEFAULT` on a view column lets `INSERT ... DEFAULT VALUES` (or `INSERT ... (col) VALUES (DEFAULT)`) on the view use the view's own default instead of the base table's. That default is supplied during the rewrite step, before the INSERT touches the base table.


### DROP VIEW


    DROP VIEW [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]

`RESTRICT` is the default and fails if any other object (another view, a function, a stored generated column expression, etc.) depends on this one. `CASCADE` drops the whole dependency chain — usually what you want when you're tearing down a feature, but read the warning carefully because it can silently take out views you didn't plan on losing.[^drop-view]


### Updatable views (auto-updatable rules)


A view is **automatically updatable** by simple INSERT/UPDATE/DELETE if **all** of these hold:[^create-view]

1. Exactly one entry in the FROM list (a table or another updatable view).
2. No `WITH`, `DISTINCT`, `GROUP BY`, `HAVING`, `LIMIT`, or `OFFSET` at the top level.
3. No set operations (`UNION`, `INTERSECT`, `EXCEPT`).
4. No aggregates, window functions, or set-returning functions in the select list.
5. Every output column references exactly one column of the underlying base relation. Expressions in the select list are not updatable (you can still SELECT through such a view; you just can't UPDATE that column).

When the conditions hold, the rewriter translates DML on the view directly into DML on the base relation. Privileges on the view and on the base table are both checked (unless `security_invoker` is off and the owner has rights — see above).

To check whether a view is auto-updatable, look at `pg_views` plus the `is_*_updatable` columns of `information_schema.views`:

    SELECT table_name, is_insertable_into, is_updatable
    FROM information_schema.views
    WHERE table_schema = 'public';


### INSTEAD OF triggers (for non-auto-updatable views)


When a view doesn't meet the auto-updatable conditions — joins, aggregates, expressions in the select list — you can still make it writable with `INSTEAD OF` triggers.[^create-trigger]

Restrictions:

- `INSTEAD OF` triggers can only be defined on **views**, not tables or foreign tables.
- They must be `FOR EACH ROW` — statement-level `INSTEAD OF` is not supported.
- No `WHEN (condition)` clause is allowed.
- For `INSTEAD OF UPDATE` you can't restrict to specific columns via `UPDATE OF col1, col2, ...`.
- They can't be defined on partitioned tables (which are not views anyway).

Pattern:

    CREATE TRIGGER orders_view_insert
        INSTEAD OF INSERT ON orders_view
        FOR EACH ROW EXECUTE FUNCTION orders_view_insert_row();

The function returns `NEW` (for INSERT/UPDATE) or `OLD` (for DELETE) — return `NULL` to silently drop the row.

Auto-updatability **and** an `INSTEAD OF` trigger? The trigger wins: the trigger function handles the row, and the auto-update path is skipped.

For comparing `INSTEAD OF` triggers to `INSTEAD` rewrite rules (legacy), see [52-rules-system.md](./52-rules-system.md). New code should use triggers — rules are harder to reason about and have known subtle issues.


### WITH CHECK OPTION


On an updatable view, `WITH CHECK OPTION` forces inserted or updated rows to satisfy the view's WHERE. The two forms differ in how far up the view-chain they propagate:

    CREATE VIEW universal_comedies AS
        SELECT * FROM comedies WHERE classification = 'U'
        WITH LOCAL CHECK OPTION;

    CREATE VIEW pg_comedies AS
        SELECT * FROM comedies WHERE classification = 'PG'
        WITH CASCADED CHECK OPTION;

`LOCAL` checks only the immediate view's WHERE. `CASCADED` (which is the default if you write `WITH CHECK OPTION` with no qualifier) checks this view's WHERE **and** the WHEREs of every underlying base view that also has the check.[^create-view]

Equivalent option form:

    CREATE VIEW pg_comedies WITH (check_option = cascaded) AS ...;

The option-form is the one you can tweak afterward with `ALTER VIEW pg_comedies SET (check_option = local);`.


### Recursive views


`CREATE RECURSIVE VIEW` is sugar for a view whose definition is a `WITH RECURSIVE`.

    CREATE RECURSIVE VIEW nums_1_100 (n) AS
        VALUES (1)
        UNION ALL
        SELECT n + 1 FROM nums_1_100 WHERE n < 100;

is equivalent to:

    CREATE VIEW nums_1_100 (n) AS
        WITH RECURSIVE nums_1_100 (n) AS (
            VALUES (1)
            UNION ALL
            SELECT n + 1 FROM nums_1_100 WHERE n < 100
        )
        SELECT n FROM nums_1_100;

Same semantics as a hand-written recursive CTE — see [04-ctes.md](./04-ctes.md) for the full mechanics, cycle detection, and search ordering options.


### CREATE MATERIALIZED VIEW


A materialized view is a **table** that stores the result of a query, plus a remembered query definition for later refresh.[^create-matview]

    CREATE MATERIALIZED VIEW [ IF NOT EXISTS ] name
        [ ( column_name [, ...] ) ]
        [ USING method ]
        [ WITH ( storage_parameter [= value] [, ...] ) ]
        [ TABLESPACE tablespace_name ]
        AS query
        [ WITH [ NO ] DATA ]

Comparison to a regular view:

| | Regular view | Materialized view |
|---|---|---|
| Storage | None (rule-based) | Physical heap |
| Query latency | Pays the underlying cost every time | Pays it once at REFRESH |
| Freshness | Always current | Stale until REFRESH |
| Indexes | Inherits base table indexes | Can have its own |
| TEMP support | Yes | No |
| Triggers | `INSTEAD OF` only | None — it's not insertable |
| Direct writes | Through INSTEAD OF or auto-update | Not allowed — only `REFRESH` |

`WITH NO DATA` creates the matview empty and **unscannable** — querying it errors until you run `REFRESH MATERIALIZED VIEW`. Useful when:

- You want to define a complex matview without paying for population at create time (e.g., during a migration).
- You'll be loading it via a different process (truncate-and-insert).

> [!NOTE] PostgreSQL 18
> `COPY TO` can now copy from a populated materialized view, not just from tables or queries.[^pg18-copy-matview] If you've been doing `COPY (SELECT * FROM mv) TO ...` as a workaround, you can drop the wrapper.

The matview is owned by its creator, supports `ANALYZE`, can be `VACUUM`ed, can have indexes, and shows up in `pg_matviews` (in addition to `pg_class` with `relkind = 'm'`).


### REFRESH MATERIALIZED VIEW


    REFRESH MATERIALIZED VIEW [ CONCURRENTLY ] name [ WITH [ NO ] DATA ]

Without `CONCURRENTLY` PostgreSQL takes an **ACCESS EXCLUSIVE** lock for the duration of the refresh: every SELECT against the matview blocks until the refresh finishes. The refresh truncates the heap and rebuilds it from the underlying query.[^refresh-matview]

With `CONCURRENTLY`:[^refresh-matview]

- A new dataset is computed into a temporary table.
- The new data is `INSERT`/`UPDATE`/`DELETE`-merged into the matview using its unique index.
- Readers see consistent rows the entire time.
- The merge step is slower than a wholesale TRUNCATE+INSERT, so `CONCURRENTLY` is the right choice when reads cannot block but the **wrong** choice when the matview is small or when most rows change.

**Strict prerequisites for `CONCURRENTLY`:**

1. The matview must already be populated (cannot follow `WITH NO DATA`).
2. There must be **at least one `UNIQUE` index** on the matview that:
    - Uses only column names (no expressions).
    - Has no `WHERE` clause (i.e., not partial).
3. `CONCURRENTLY` and `WITH NO DATA` are mutually exclusive.

Always create the unique index before scheduling concurrent refreshes:

    CREATE MATERIALIZED VIEW daily_sales AS
        SELECT day, region, SUM(amount) AS total
        FROM sales GROUP BY day, region;

    CREATE UNIQUE INDEX daily_sales_pk ON daily_sales (day, region);

    REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales;

> [!WARNING] Only one REFRESH at a time per matview
> Even with `CONCURRENTLY`, the system serializes refreshes against a single matview. A second `REFRESH MATERIALIZED VIEW CONCURRENTLY mv` blocks until the first finishes — you do not get parallel refresh.[^refresh-matview]

`WITH NO DATA` on a refresh **discards** the existing rows and leaves the matview unscannable until the next refresh repopulates it. Storage is freed. Useful for shedding stale rows before a known-long rebuild on a maintenance window.

There is **no automatic refresh** in core PostgreSQL. Schedule it with a cron job, with [pg_cron](./98-pg-cron.md), with an event trigger that watches base-table writes, or with the application. The dedicated section in [98-pg-cron.md](./98-pg-cron.md) shows the scheduling recipe.


### Lock-level summary


| Operation | Lock on the view itself | Lock on the base relation(s) |
|---|---|---|
| `SELECT FROM view` | `ACCESS SHARE` | `ACCESS SHARE` |
| `INSERT/UPDATE/DELETE` on auto-updatable view | `ROW EXCLUSIVE` | `ROW EXCLUSIVE` |
| `INSERT/UPDATE/DELETE` triggering an `INSTEAD OF` trigger | `ROW EXCLUSIVE` on view | depends on trigger body |
| `CREATE VIEW` | (none on the view; view is being created) | `ACCESS SHARE` |
| `CREATE OR REPLACE VIEW` | `ACCESS EXCLUSIVE` | `ACCESS SHARE` |
| `ALTER VIEW` | `ACCESS EXCLUSIVE` | none |
| `DROP VIEW` | `ACCESS EXCLUSIVE` | none |
| `CREATE MATERIALIZED VIEW` | (none; being created) | `ACCESS SHARE` while populating |
| `REFRESH MATERIALIZED VIEW` (without CONCURRENTLY) | `ACCESS EXCLUSIVE` | `ACCESS SHARE` while reading base |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | `EXCLUSIVE` (blocks writes and DDL on the matview, allows SELECT) | `ACCESS SHARE` |
| `DROP MATERIALIZED VIEW` | `ACCESS EXCLUSIVE` | none |

Full table-lock matrix for DML in general is in [03-syntax-dml.md](./03-syntax-dml.md); the lock-conflict matrix is in [43-locking.md](./43-locking.md).


## Examples / Recipes


### Recipe 1 — A safe "filtered slice of a sensitive table" view


Goal: expose a customer-facing slice of `accounts` to the `app_user` role, hiding internal-only columns. Want the filter to actually *enforce* security against malicious WHERE predicates.

    CREATE VIEW accounts_public WITH (security_barrier) AS
        SELECT id, name, signup_date, status
        FROM accounts
        WHERE status <> 'INTERNAL_TEST'
          AND deleted_at IS NULL;

    REVOKE ALL ON accounts FROM app_user;
    GRANT SELECT ON accounts_public TO app_user;

The owner of the view (likely a more-privileged service role) has access to `accounts`; `app_user` does not. With the default owner-semantics, the view bridges privileges; `security_barrier` keeps malicious predicates from peeking past the WHERE. See also [47-row-level-security.md](./47-row-level-security.md) for the policy-based alternative when filters are per-user, not static.


### Recipe 2 — Use `security_invoker` so a view doesn't bridge privileges


Goal: a view that's just a readability alias (column rename, simple subset). The caller should need rights on the underlying table; the view should not bypass that.

    CREATE VIEW reports_by_customer WITH (security_invoker = true) AS
        SELECT customer_id, report_id, generated_at AS at
        FROM reports;

Now `SELECT FROM reports_by_customer` requires the caller to hold `SELECT` on both the view *and* `reports`. The view owner being a superuser doesn't magically grant access.

> [!NOTE] PostgreSQL 15
> Required version for `security_invoker`. Earlier majors silently use the owner's privileges.[^pg15-security-invoker]


### Recipe 3 — An updatable view that filters out soft-deleted rows


    CREATE TABLE products (
        id          bigint PRIMARY KEY,
        name        text NOT NULL,
        price       numeric(10,2) NOT NULL,
        deleted_at  timestamptz
    );

    CREATE VIEW products_live AS
        SELECT id, name, price FROM products
        WHERE deleted_at IS NULL
        WITH CASCADED CHECK OPTION;

This view meets all auto-updatable conditions (see [Updatable views](#updatable-views-auto-updatable-rules)) — single base table, no aggregates, no DISTINCT, no set operations, all output columns reference base columns directly.

INSERT/UPDATE/DELETE through `products_live` works directly. `WITH CASCADED CHECK OPTION` blocks any UPDATE that would set `deleted_at` (since `deleted_at` isn't an output column, the column won't be touched; the predicate `deleted_at IS NULL` is preserved post-update because the column isn't being modified). The check option is more valuable when the view exposes `deleted_at` and you want to refuse the user setting it to a non-NULL value.


### Recipe 4 — A view that joins, made writable via INSTEAD OF triggers


Goal: expose a join of `orders` and `order_lines` as a flat view and accept inserts that fan out across both tables.

    CREATE VIEW order_line_flat AS
        SELECT
            o.id          AS order_id,
            o.customer_id,
            o.placed_at,
            l.id          AS line_id,
            l.product_id,
            l.quantity,
            l.unit_price
        FROM orders o JOIN order_lines l ON l.order_id = o.id;

    CREATE FUNCTION order_line_flat_insert() RETURNS trigger AS $$
    DECLARE
        v_order_id bigint;
    BEGIN
        IF NEW.order_id IS NULL THEN
            INSERT INTO orders (customer_id, placed_at)
                VALUES (NEW.customer_id, COALESCE(NEW.placed_at, now()))
                RETURNING id INTO v_order_id;
            NEW.order_id := v_order_id;
        END IF;

        INSERT INTO order_lines (order_id, product_id, quantity, unit_price)
            VALUES (NEW.order_id, NEW.product_id, NEW.quantity, NEW.unit_price)
            RETURNING id INTO NEW.line_id;

        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER order_line_flat_insert
        INSTEAD OF INSERT ON order_line_flat
        FOR EACH ROW EXECUTE FUNCTION order_line_flat_insert();

Real systems will also want `INSTEAD OF UPDATE` and `INSTEAD OF DELETE` triggers — write each as a dedicated function. Return `NEW` for `INSTEAD OF UPDATE/INSERT`, `OLD` for `INSTEAD OF DELETE`, or `NULL` to suppress the row.


### Recipe 5 — Materialized view of a heavy aggregation, refreshed on schedule


    CREATE MATERIALIZED VIEW account_daily_balance AS
        SELECT
            account_id,
            date_trunc('day', ts) AS day,
            SUM(amount)            AS balance
        FROM ledger_entries
        GROUP BY account_id, day
        WITH NO DATA;

    -- Required for CONCURRENTLY refreshes.
    CREATE UNIQUE INDEX account_daily_balance_pk
        ON account_daily_balance (account_id, day);

    -- Populate the first time. CONCURRENTLY won't work yet (empty matview).
    REFRESH MATERIALIZED VIEW account_daily_balance;

    -- Subsequent refreshes: SELECT-friendly.
    REFRESH MATERIALIZED VIEW CONCURRENTLY account_daily_balance;

To schedule, use [pg_cron](./98-pg-cron.md):

    SELECT cron.schedule(
        'refresh-account-daily-balance',
        '*/15 * * * *',
        $$REFRESH MATERIALIZED VIEW CONCURRENTLY account_daily_balance$$
    );


### Recipe 6 — Layered views for tenant isolation (combine RLS, security_barrier, view)


    -- Base table with RLS policies.
    ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY invoices_tenant ON invoices
        USING (tenant_id = current_setting('app.tenant_id')::bigint);

    -- View that joins invoice + customer name. Security barrier protects against
    -- leaky predicates pushed past the WHERE; security_invoker makes RLS run
    -- under the caller's role, not the view owner's.
    CREATE VIEW invoice_summary
        WITH (security_barrier, security_invoker = true) AS
        SELECT i.id, i.tenant_id, c.name AS customer, i.total, i.due_date
        FROM invoices i JOIN customers c ON c.id = i.customer_id;

    GRANT SELECT ON invoice_summary TO app_user;

The RLS policy on `invoices` enforces tenant isolation; `security_invoker` makes the policy evaluate under the caller's role; `security_barrier` prevents the optimizer from giving up isolation in exchange for a faster plan.

Full RLS mechanics are in [47-row-level-security.md](./47-row-level-security.md).


### Recipe 7 — Snapshot table vs materialized view: when to choose which


| Use case | Recommendation |
|---|---|
| One-time export, no further refresh | `CREATE TABLE … AS SELECT` (lighter; doesn't carry the query definition) |
| Periodic refresh on the same query | `CREATE MATERIALIZED VIEW` — `REFRESH` is one statement |
| Refresh whose query rarely changes, with downstream indexes | Materialized view |
| Refresh whose body changes frequently | Regular view + cached values in a normal table (matview redefinition requires DROP/CREATE) |
| Cross-cluster snapshot | Logical replication or `pg_dump`, not matview |

`CREATE TABLE AS` is documented at [01-syntax-ddl.md](./01-syntax-ddl.md).


### Recipe 8 — Refresh ordering for dependent matviews


If `mv_a` depends on `mv_b`, refresh `mv_b` first. PostgreSQL does **not** order refreshes by dependency — you must.

    BEGIN;
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_b;
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_a;
    COMMIT;

If you're refreshing many matviews, wrap them in a procedure and call it from `pg_cron`. Use advisory locks ([44-advisory-locks.md](./44-advisory-locks.md)) to prevent two refresh runs overlapping if a previous run is still going.


### Recipe 9 — Refresh non-blocking for readers, but only when stale


Goal: skip the refresh if base data hasn't changed.

    CREATE OR REPLACE FUNCTION refresh_if_stale(mv_name text, source_table text)
        RETURNS void LANGUAGE plpgsql AS
    $$
    DECLARE
        last_mv_refresh   timestamptz;
        last_source_write timestamptz;
    BEGIN
        SELECT GREATEST(last_vacuum, last_autovacuum, last_analyze, last_autoanalyze)
            INTO last_source_write
            FROM pg_stat_user_tables
            WHERE schemaname || '.' || relname = source_table;

        -- Track last refresh in a side table; left as an exercise (see below).
        SELECT refreshed_at INTO last_mv_refresh
            FROM mv_refresh_log WHERE mv = mv_name;

        IF last_mv_refresh IS NULL OR last_mv_refresh < last_source_write THEN
            EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', mv_name);
            INSERT INTO mv_refresh_log (mv, refreshed_at)
                VALUES (mv_name, clock_timestamp())
                ON CONFLICT (mv) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;
        END IF;
    END;
    $$;

The freshness signal here is approximate (uses stats updates). For a robust system, track explicit "last write" timestamps on the base table with a trigger.


## Gotchas / Anti-patterns


1. **A view is not a hard plan boundary.** Unlike a `WITH ... MATERIALIZED` CTE, a regular view does **not** force materialization. The optimizer flattens it. If you have a complex view used as a building block and you find queries against it are inefficient because the optimizer is choosing a global plan you didn't expect, that's the rewrite system doing its job — not a bug.[^rules-views] If you want a fence, use a CTE with `MATERIALIZED` (see [04-ctes.md](./04-ctes.md)) or a materialized view.

2. **`CREATE OR REPLACE VIEW` is column-shape-rigid.** You can't drop, reorder, or rename existing output columns; can't change their types; (PG15+) can't change their collations.[^pg15-view-collation] To restructure a view, drop it and recreate — but `RESTRICT` will block the drop if anything depends on it. You'll either need to cascade (and rebuild downstream objects) or stage the change behind a temporary alias.

3. **`security_barrier` blocks optimization.** Predicates can't be pushed past it. A `SELECT … WHERE id = 42` against a barrier view scans the view's full underlying rowset, then filters. If you don't actually need the security guarantee — for instance, the view is only there for readability — *don't* set the barrier.[^rules-privileges] The cost is real.

4. **`security_invoker = true` doesn't help you bridge privileges.** A common mental model error: setting `security_invoker = true` and expecting the view to *expand* the caller's permissions. It does the opposite — the caller now needs the base-table privileges *too*.

5. **A view without `WITH CHECK OPTION` lets users insert/update rows the view itself can't see.** This is rarely what you want.

6. **`INSTEAD OF` triggers can't restrict by column.** `INSTEAD OF UPDATE OF col1, col2` is a syntax error. You'll receive every UPDATE to the view and must handle them all (or no-op for unhandled columns).

7. **`REFRESH MATERIALIZED VIEW` without `CONCURRENTLY` takes `ACCESS EXCLUSIVE`.** Every SELECT against the matview blocks until refresh completes — could be many minutes if the matview is big. Always add `CONCURRENTLY` for production matviews, and create the required UNIQUE index before the first concurrent refresh.[^refresh-matview]

8. **`CONCURRENTLY` is slower than the non-concurrent path on big-delta refreshes.** A truncate-and-insert is much faster than a merge when most rows change. If readers can tolerate the lock (off-hours job), drop `CONCURRENTLY`.

9. **Only one refresh runs at a time per matview.** Even with `CONCURRENTLY`. If you call refresh from cron *and* from a trigger *and* from an application worker, you'll find them serializing — usually undesirable. Coordinate with [advisory locks](./44-advisory-locks.md) to skip redundant refreshes.

10. **`CONCURRENTLY` and `WITH NO DATA` are mutually exclusive.** Trying to combine them errors at parse time.[^refresh-matview]

11. **Matviews lose `ORDER BY` of the defining query.** Refresh doesn't preserve order. If the consumer needs an order, add an `ORDER BY` to the consumer's query or build an index that the consumer can scan in order.[^refresh-matview]

12. **No DML on a matview.** You cannot `INSERT`/`UPDATE`/`DELETE` against a matview. `TRUNCATE` is also not a substitute for `REFRESH` — it empties the matview but leaves it unqueryable until a `REFRESH MATERIALIZED VIEW` repopulates it. To populate or replace rows, use `REFRESH` or `DROP+CREATE`.

13. **Matview is not automatically refreshed when the base table changes.** Stale data is the user's responsibility. Common patterns: per-write triggers that mark dirty + scheduled refresh; `pg_cron` periodic refresh; debounced refresh on idle.

14. **`pg_dump` includes matview definitions but never their data.**[^pgdump-matview-defaults] After a logical restore, every matview is unscannable until you `REFRESH MATERIALIZED VIEW` it — a base-table restore plus a matview-refresh pass is the runbook. Physical backups (`pg_basebackup`, PITR) restore the matview's stored heap normally because they're file-level. Plan for the difference: see [83-backup-pg-dump.md](./83-backup-pg-dump.md) and [84-backup-physical-pitr.md](./84-backup-physical-pitr.md).

15. **The view's owner matters.** Default access goes through the owner's privileges. If the owner is later dropped, the view becomes useless and queries against it fail. Use a dedicated role for view ownership (e.g., a service account that other roles inherit from), not a personal account.

16. **You can't add an index to a view.** Only matviews and tables can be indexed. If you find yourself wishing for a view index, you actually want a materialized view (or to index the base table).

17. **Stats collection on matviews requires ANALYZE.** After a `REFRESH MATERIALIZED VIEW`, run `ANALYZE matview_name` if downstream queries plan poorly. Autovacuum will eventually pick it up, but for time-sensitive workloads do it explicitly:

        REFRESH MATERIALIZED VIEW CONCURRENTLY mv;
        ANALYZE mv;

18. **The `relkind` of a matview is `'m'`, not `'r'`.** Catalog queries that filter `pg_class.relkind = 'r'` to "find all tables" will miss matviews. Include `'m'` if you mean "all heap-storage relations." See [64-system-catalogs.md](./64-system-catalogs.md).


## See Also


- [01-syntax-ddl.md](./01-syntax-ddl.md) — `CREATE TABLE AS` (snapshot) vs `CREATE MATERIALIZED VIEW`
- [02-syntax-dql.md](./02-syntax-dql.md) — the SELECT grammar that defines view contents
- [03-syntax-dml.md](./03-syntax-dml.md) — DML semantics for writes through auto-updatable views
- [04-ctes.md](./04-ctes.md) — `WITH RECURSIVE` for recursive views, MATERIALIZED CTEs as plan fences
- [39-triggers.md](./39-triggers.md) — full trigger reference (INSTEAD OF, BEFORE/AFTER, transition tables)
- [43-locking.md](./43-locking.md) — lock conflict matrix
- [46-roles-privileges.md](./46-roles-privileges.md) — view ownership, GRANT, the privilege model under `security_invoker`
- [47-row-level-security.md](./47-row-level-security.md) — RLS interacts with `security_invoker` and `security_barrier`
- [52-rules-system.md](./52-rules-system.md) — rule system internals; how views compile to `ON SELECT DO INSTEAD`
- [64-system-catalogs.md](./64-system-catalogs.md) — `pg_views`, `pg_matviews`, `pg_rewrite`, `information_schema.views`
- [83-backup-pg-dump.md](./83-backup-pg-dump.md) — matview behavior in dumps
- [98-pg-cron.md](./98-pg-cron.md) — scheduling `REFRESH MATERIALIZED VIEW CONCURRENTLY`


## Sources


[^create-view]: PostgreSQL 16 — *CREATE VIEW*. Lists the full syntax including `WITH (view_option_name ...)`, the auto-updatable view conditions, and the `WITH [CASCADED | LOCAL] CHECK OPTION` clause. https://www.postgresql.org/docs/16/sql-createview.html

[^alter-view]: PostgreSQL 16 — *ALTER VIEW*. Documents `SET` / `RESET` of `check_option`, `security_barrier`, and `security_invoker`, plus column-default, owner, schema, and rename operations. https://www.postgresql.org/docs/16/sql-alterview.html

[^drop-view]: PostgreSQL 16 — *DROP VIEW*. Documents `CASCADE` / `RESTRICT` and the owner-only requirement. https://www.postgresql.org/docs/16/sql-dropview.html

[^create-trigger]: PostgreSQL 16 — *CREATE TRIGGER*. Documents the `INSTEAD OF` form for triggers on views: "Views Only", "FOR EACH ROW required", "no WHEN condition", "no UPDATE OF column_name list". https://www.postgresql.org/docs/16/sql-createtrigger.html

[^create-matview]: PostgreSQL 16 — *CREATE MATERIALIZED VIEW*. Syntax for `CREATE MATERIALIZED VIEW`, the `WITH [NO] DATA` clause, `USING method`, `TABLESPACE`, and storage parameters. https://www.postgresql.org/docs/16/sql-creatematerializedview.html

[^refresh-matview]: PostgreSQL 16 — *REFRESH MATERIALIZED VIEW*. Documents `CONCURRENTLY` (requires non-partial column-only UNIQUE index, mutually exclusive with `WITH NO DATA`, only one refresh at a time per matview), `WITH NO DATA` (frees storage, leaves matview unscannable), and notes that ORDER BY is not preserved across refreshes. https://www.postgresql.org/docs/16/sql-refreshmaterializedview.html

[^rules-views]: PostgreSQL 16 — *The Rule System: Views and the Rule System*. "A view is basically an empty table (having no actual storage) with an `ON SELECT DO INSTEAD` rule. Conventionally, that rule is named `_RETURN`." https://www.postgresql.org/docs/16/rules-views.html

[^rules-privileges]: PostgreSQL 16 — *Rules and Privileges*. Documents `security_barrier`, the leaky-function exploit scenario, LEAKPROOF function semantics, and the explicit performance tradeoff: "the fastest possible plan must be rejected if it may compromise security." https://www.postgresql.org/docs/16/rules-privileges.html

[^pg15-security-invoker]: PostgreSQL 15 Release Notes. "Allow table accesses done by a view to optionally be controlled by privileges of the view's caller (Christoph Heiss). Previously, view accesses were always treated as being done by the view's owner. That's still the default." https://www.postgresql.org/docs/release/15.0/

[^pg15-view-collation]: PostgreSQL 15 Release Notes. "Prevent CREATE OR REPLACE VIEW from changing the collation of an output column (Tom Lane)." https://www.postgresql.org/docs/release/15.0/

[^pg18-copy-matview]: PostgreSQL 18 Release Notes. "Allow `COPY TO` to copy rows from populated materialized views (Jian He)." https://www.postgresql.org/docs/release/18.0/

[^pgdump-matview-defaults]: PostgreSQL 16 — *pg_dump*. Documents `--table` behavior: *"As well as tables, this option can be used to dump the definition of matching views, materialized views, foreign tables, and sequences. It will not dump the contents of views or materialized views."* The restored matview is empty (equivalent to `WITH NO DATA`) and requires `REFRESH MATERIALIZED VIEW` after restore. https://www.postgresql.org/docs/16/app-pgdump.html

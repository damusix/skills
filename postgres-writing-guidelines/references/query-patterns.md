# Query Patterns


SARGability and window function patterns follow standard SQL conventions. Postgres adds idiomatic constructs (`LATERAL`, `DISTINCT ON`, `INSERT ... ON CONFLICT`, array/jsonb operators). Parameter sniffing is rarely a concern — trust the planner.

## Table of Contents

- [SARGability](#sargability)
- [LATERAL Joins](#lateral-joins)
- [Hierarchical Result Assembly](#hierarchical-result-assembly)
- [DISTINCT ON for First-Per-Group](#distinct-on-for-first-per-group)
- [Window Functions](#window-functions)
- [INSERT ... ON CONFLICT](#insert--on-conflict)
- [Array Operators](#array-operators)
- [JSONB Operators and Indexing](#jsonb-operators-and-indexing)
- [NOT EXISTS over NOT IN](#not-exists-over-not-in)
- [String Aggregation](#string-aggregation)
- [Batch Operations](#batch-operations)
- [Parameter Sniffing — Mostly a Non-Issue](#parameter-sniffing--mostly-a-non-issue)

---

## SARGability

Predicates are SARGable when the index on the column can be used directly. Wrapping a column in a function disables the index:

    -- BAD: scans every row to compute YEAR
    SELECT * FROM orders WHERE EXTRACT(YEAR FROM ordered_at) = 2026;

    -- GOOD: index seek on (ordered_at)
    SELECT * FROM orders
    WHERE ordered_at >= '2026-01-01'
      AND ordered_at <  '2027-01-01';

**Rule:** apply functions to *parameters*, not to *columns*.

Postgres has a partial workaround for the bad form: an **expression index**.

    CREATE INDEX orders_year_idx ON orders ((EXTRACT(YEAR FROM ordered_at)));

This makes the SARGable. But you've now committed storage to that specific transformation — better to fix the query.

## LATERAL Joins

`LATERAL` lets the right side of a join reference columns from the left side, like a per-row subquery:

    -- For each customer, their 3 most recent orders
    SELECT c.customer_no, c.full_name, o.order_no, o.ordered_at
    FROM customer c
    LEFT JOIN LATERAL (
        SELECT order_no, ordered_at
        FROM orders
        WHERE customer_no = c.customer_no
        ORDER BY ordered_at DESC
        LIMIT 3
    ) o ON TRUE;

`LEFT JOIN LATERAL ... ON TRUE` keeps customers with no orders in the result. `JOIN LATERAL ... ON TRUE` (without LEFT) drops them.

## Hierarchical Result Assembly

For endpoints that need a fixed nested shape in a single round trip (user profile page, order detail with line items, etc.), assemble the result server-side using **composite types + `array_agg(row(...)::T)` + a final `to_json`**. This avoids both the N+1 round-trip problem and the per-row cost of calling `json_build_object` inside SELECT.

Define a composite type for each level of the hierarchy:

    CREATE TYPE phone_record AS (
        phone_no    bigint,
        number      text,
        type        text
    );

    CREATE TYPE address_record AS (
        address_no   bigint,
        line1        text,
        city         text,
        state        text,
        zip          text
    );

    CREATE TYPE user_profile_record AS (
        user_no    bigint,
        username   text,
        full_name  text,
        phones     phone_record[],
        addresses  address_record[]
    );

Assemble with grouped `array_agg` of typed rows, serialize once at the end:

    CREATE OR REPLACE FUNCTION fn_user_profile(p_user_no bigint)
    RETURNS jsonb
    LANGUAGE sql STABLE AS $$
        SELECT to_jsonb(
            ROW(
                u.user_no,
                u.username,
                u.full_name,
                COALESCE((
                    SELECT array_agg(ROW(p.phone_no, p.number, p.type)::phone_record)
                    FROM phone p WHERE p.user_no = u.user_no
                ), ARRAY[]::phone_record[]),
                COALESCE((
                    SELECT array_agg(ROW(a.address_no, a.line1, a.city, a.state, a.zip)::address_record)
                    FROM address a WHERE a.user_no = u.user_no
                ), ARRAY[]::address_record[])
            )::user_profile_record
        )
        FROM app_user u WHERE u.user_no = p_user_no;
    $$;

One round trip, one query, fully nested JSON result. The planner can use indexes on each child table's FK; RLS policies on each table still apply.

**When to use:**

- Read endpoints with a **fixed**, well-known nested shape
- The hierarchy is mostly 1:N (master → array of children)
- The same shape is consumed by all callers of this endpoint

**When NOT to use:**

- The shape varies by role — use role-scoped views instead, one per projection
- The endpoint is for mutations — use procedures with explicit validation, not JSON-parsing dispatchers
- The hierarchy is unbounded or recursive — paginate or stream instead
- Callers need to filter/post-process — return rows, not a blob

**Caveat:** the composite types couple the function signature to the JSON shape consumed by the client. Treat them like a versioned API contract: name them per-endpoint (`user_profile_v1_record`), and add a new type for breaking shape changes rather than mutating the existing one.

## DISTINCT ON for First-Per-Group

Postgres has `DISTINCT ON (cols)` — picks the first row per group based on `ORDER BY`:

    -- Latest balance snapshot per account
    SELECT DISTINCT ON (account_no)
        account_no, snapshot_at, balance
    FROM account_balance_snapshot
    ORDER BY account_no, snapshot_at DESC;

The columns in `DISTINCT ON` must be the leading columns in `ORDER BY`. Cleaner than the `ROW_NUMBER() OVER (PARTITION BY ...) = 1` pattern when you only need one row per group.

For more than one row per group, use `ROW_NUMBER()`:

    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY account_no ORDER BY snapshot_at DESC) AS rn
        FROM account_balance_snapshot
    ) ranked
    WHERE rn <= 3;

## Window Functions

Window functions use standard SQL syntax:

    -- Running balance
    SELECT
        account_no, posted_at, amount,
        SUM(amount) OVER (PARTITION BY account_no ORDER BY posted_at) AS running_balance
    FROM ledger_entry;

    -- Difference from previous row
    SELECT
        account_no, posted_at, balance,
        balance - LAG(balance) OVER (PARTITION BY account_no ORDER BY posted_at) AS delta
    FROM account_balance_snapshot;

Postgres adds `FILTER (WHERE ...)` as an aggregate modifier — cleaner than `CASE WHEN`:

    SELECT
        customer_no,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
    FROM orders
    GROUP BY customer_no;

## INSERT ... ON CONFLICT

`ON CONFLICT` is the idiomatic Postgres UPSERT:

    INSERT INTO customer(email, full_name, updated_at)
    VALUES ('alice@example.com', 'Alice Smith', clock_timestamp())
    ON CONFLICT (email) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        updated_at = EXCLUDED.updated_at
    WHERE customer.full_name IS DISTINCT FROM EXCLUDED.full_name;  -- only update if changed

`EXCLUDED` references the row that *would have been* inserted. `ON CONFLICT (col)` requires a unique constraint on that column. `DO NOTHING` is the no-op variant.

## Array Operators

Arrays are first-class in Postgres. Common operators:

    -- Membership
    SELECT * FROM customer WHERE 'admin' = ANY(roles);
    SELECT * FROM customer WHERE roles @> ARRAY['admin', 'user'];   -- contains all
    SELECT * FROM customer WHERE roles && ARRAY['admin', 'guest']; -- overlaps

    -- Aggregation into arrays
    SELECT customer_no, ARRAY_AGG(order_no ORDER BY ordered_at) AS order_nos
    FROM orders GROUP BY customer_no;

    -- Unnest into rows
    SELECT customer_no, unnest(roles) AS role FROM customer;

GIN indexes accelerate array contains queries:

    CREATE INDEX customer_roles_gin_idx ON customer USING GIN (roles);

## JSONB Operators and Indexing

For semi-structured data:

    -- Field access
    SELECT data->'address'->>'city' FROM customer;     -- ->> returns text, -> returns jsonb

    -- Containment
    SELECT * FROM customer WHERE data @> '{"verified": true}';

    -- Existence of key
    SELECT * FROM customer WHERE data ? 'phone';

    -- Path access
    SELECT data #>> '{address, city}' FROM customer;

GIN index on jsonb makes `@>` and `?` operators fast:

    CREATE INDEX customer_data_gin_idx ON customer USING GIN (data);

Or GIN on a specific path with `jsonb_path_ops` for smaller, faster index when you only need `@>`:

    CREATE INDEX customer_data_path_idx ON customer USING GIN (data jsonb_path_ops);

## NOT EXISTS over NOT IN

`NOT IN` with a subquery returns nothing if the subquery contains any NULL — silent bug.

    -- BAD: returns nothing if any user_id in disabled_user is NULL
    SELECT * FROM customer
    WHERE user_id NOT IN (SELECT user_id FROM disabled_user);

    -- GOOD: NULL-safe
    SELECT * FROM customer c
    WHERE NOT EXISTS (
        SELECT 1 FROM disabled_user d WHERE d.user_id = c.user_id
    );

`NOT EXISTS` also tends to plan better — Postgres can use a hash anti-join.

## String Aggregation

`STRING_AGG` for concatenating rows into a delimited string:

    SELECT customer_no, STRING_AGG(role, ', ' ORDER BY role) AS roles
    FROM customer_role
    GROUP BY customer_no;

For JSON output, use `jsonb_agg` / `json_agg`:

    SELECT customer_no, jsonb_agg(jsonb_build_object('order_no', order_no, 'total', total))
    FROM orders GROUP BY customer_no;

## Batch Operations

For bulk inserts, use `INSERT ... SELECT` or `COPY`. Avoid row-by-row loops in PL/pgSQL:

    -- Bulk insert from another table
    INSERT INTO customer_archive(customer_no, archived_at, snapshot)
    SELECT customer_no, clock_timestamp(), to_jsonb(c)
    FROM customer c
    WHERE last_active_at < clock_timestamp() - INTERVAL '2 years';

    -- COPY for fastest external load
    COPY customer FROM '/path/to/data.csv' CSV HEADER;

For bulk DELETE/UPDATE on huge tables, batch in chunks to avoid long locks and large WAL volume:

    DELETE FROM old_logs
    WHERE id IN (
        SELECT id FROM old_logs
        WHERE created_at < clock_timestamp() - INTERVAL '90 days'
        LIMIT 10000
    );

Loop until no rows affected.

## Parameter Sniffing — Mostly a Non-Issue

Postgres's planner re-plans prepared statements based on actual parameter values for the first 5 executions, then switches to a generic plan if costs are similar. Parameter sniffing is rarely a problem in Postgres.

If you suspect a generic plan is hurting you, force re-planning:

    -- Per-statement: avoid prepared statement cache
    EXECUTE format('SELECT ... WHERE x = %L', p_value);

Or set the planner to always use custom plans for a session:

    SET plan_cache_mode = force_custom_plan;

For most workloads, the default is fine.

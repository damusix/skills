# View Patterns


Views in Postgres earn their keep for **flattening multi-table joins** and **role-specific projections**. They are no longer a security boundary — RLS handles row filtering at the table layer. The `vw_role_intent` naming convention but means "the role this projection serves," not "this is the only path this role can read."

## Table of Contents

- [What Views Are For (and Aren't)](#what-views-are-for-and-arent)
- [Naming](#naming)
- [Flattening Views](#flattening-views)
- [Role-Specific Projections](#role-specific-projections)
- [Aggregation Views](#aggregation-views)
- [Materialized Views](#materialized-views)
- [Updatable Views](#updatable-views)
- [Views and RLS](#views-and-rls)
- [Common Pitfalls](#common-pitfalls)

---

## What Views Are For (and Aren't)

**Use a view when:**

- The same multi-table join appears in many queries — extract it
- Different roles need different column projections of the same data
- You want to hide a schema change behind a stable interface (e.g., column split, table rename)
- A computed column is useful in many contexts

**Don't use a view to:**

- Replace RLS (RLS handles row filtering at the table layer in Postgres)
- Hide columns from users who shouldn't see them — use column-level GRANTs or RLS column policies
- Wrap a single table with no transformation — adds indirection for nothing

## Naming

`vw_<role>_<intent>` — lowercase, snake_case, `vw_` prefix:

    vw_manager_team_report
    vw_admin_all_customers
    vw_customer_my_orders
    vw_worker_pending_jobs
    vw_public_homepage_stats

The role segment communicates the intended consumer; the `vw_` prefix distinguishes views from tables in error messages, search results, and tooling. Materialized views use `mv_`.

## Flattening Views

The most common use: join + project so callers don't repeat themselves.

    CREATE OR REPLACE VIEW vw_customer_my_orders AS
    SELECT
        c.customer_no,
        c.full_name,
        o.order_no,
        o.ordered_at,
        o.status,
        SUM(ol.quantity * ol.unit_price_at_sale) AS total_amount,
        COUNT(ol.line_no) AS line_count
    FROM customer c
    JOIN orders o    USING (customer_no)
    JOIN order_line ol USING (customer_no, order_no)
    GROUP BY c.customer_no, c.full_name, o.order_no, o.ordered_at, o.status;

Callers query `SELECT * FROM vw_customer_my_orders WHERE order_no = 42` and get a flattened result.

## Role-Specific Projections

Different roles see different columns of the same data. This is *not* security (RLS handles that) — it's API ergonomics.

    -- What managers see
    CREATE OR REPLACE VIEW vw_manager_team_report AS
    SELECT
        team_id, team_name,
        COUNT(*) AS member_count,
        AVG(performance_score) AS avg_score,
        MAX(last_review_at) AS last_review
    FROM employee
    GROUP BY team_id, team_name;

    -- What admins see — same source, more columns
    CREATE OR REPLACE VIEW vw_admin_team_report AS
    SELECT
        team_id, team_name,
        COUNT(*) AS member_count,
        AVG(performance_score) AS avg_score,
        AVG(salary) AS avg_salary,           -- admin-only
        SUM(salary) AS total_payroll,        -- admin-only
        MAX(last_review_at) AS last_review
    FROM employee
    GROUP BY team_id, team_name;

The base table's RLS still filters which rows each role sees. Views shape the *columns*; RLS shapes the *rows*.

## Aggregation Views

Pre-computed aggregations behind a stable name. Trades query simplicity for re-computation cost.

    CREATE OR REPLACE VIEW vw_customer_lifetime_value AS
    SELECT
        c.customer_no,
        c.full_name,
        COUNT(DISTINCT o.order_no) AS order_count,
        COALESCE(SUM(ol.quantity * ol.unit_price_at_sale), 0) AS lifetime_value,
        MAX(o.ordered_at) AS last_order_at
    FROM customer c
    LEFT JOIN orders o    USING (customer_no)
    LEFT JOIN order_line ol USING (customer_no, order_no)
    GROUP BY c.customer_no, c.full_name;

If this view becomes a hot path, consider materializing it.

## Materialized Views

For expensive aggregations queried more often than the underlying data changes:

    CREATE MATERIALIZED VIEW mv_customer_lifetime_value AS
    SELECT ... ;  -- same as above

    CREATE UNIQUE INDEX mv_customer_lifetime_value_pk
        ON mv_customer_lifetime_value (customer_no);

    -- Refresh on a schedule
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_customer_lifetime_value;

`CONCURRENTLY` requires the unique index — it lets readers continue using the old data while the refresh runs.

**Naming:** `mv_` prefix to distinguish from regular views.

**RLS doesn't apply to materialized views by default** — they're snapshots. Either filter at refresh time, build per-tenant materialized views, or accept that materialized views are global aggregates.

## Updatable Views

Postgres makes simple views (single table, no aggregation, no DISTINCT) automatically updatable — INSERT/UPDATE/DELETE on the view propagates to the base table:

    CREATE OR REPLACE VIEW vw_active_customer AS
    SELECT * FROM customer WHERE deactivated_at IS NULL;

    -- Works: updates customer table for matching rows
    UPDATE vw_active_customer SET full_name = 'New Name' WHERE customer_no = 42;

For complex views, define INSTEAD OF triggers — but at that point, ask whether a procedure would be clearer.

## Views and RLS

RLS policies on the underlying tables apply when querying a view, with one critical detail: by default, the view is evaluated with the *view owner's* privileges, not the caller's. If the view owner can bypass RLS, callers will too.

For views to respect the caller's RLS:

    CREATE VIEW vw_customer_my_orders
    WITH (security_invoker = TRUE) AS
    SELECT ... ;

`security_invoker = TRUE` makes the view check policies as the calling role, not the view owner. Use this for any view that exposes user-scoped data.

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| View owned by superuser bypasses RLS for all callers | `WITH (security_invoker = TRUE)` |
| `SELECT *` in a view — adding columns to base table breaks consumers | List columns explicitly |
| Materialized view returns stale data | Schedule refresh; consider regular view if staleness matters |
| View hides a slow underlying query | Materialize, add indexes, or rewrite the join |
| Updatable view loses updates because of WHERE filter | `WITH CHECK OPTION` to reject writes that would fall outside the filter |
| Many views layered on views — incomprehensible plan | Flatten to a single view; let the planner work on real tables |
| View used as a security boundary instead of RLS | Add RLS policies to the underlying tables |

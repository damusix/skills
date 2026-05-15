# Row-Level Security


Postgres has native row-level security (RLS): the filter lives on the table itself, not in a wrapping view. Once a table has RLS enabled and policies defined, the filter happens transparently — `SELECT *` returns only rows the current role is allowed to see, regardless of how the query was issued.

## Table of Contents

- [Why RLS Replaces View-Based Filtering](#why-rls-replaces-view-based-filtering)
- [Enabling RLS](#enabling-rls)
- [Policy Anatomy](#policy-anatomy)
- [USING vs WITH CHECK](#using-vs-with-check)
- [The fn_current_app_user_id() Pattern](#the-fn_current_app_user_id-pattern)
- [Setting Session Identity](#setting-session-identity)
- [Bypass Roles](#bypass-roles)
- [FORCE ROW LEVEL SECURITY](#force-row-level-security)
- [Multi-Tenant Patterns](#multi-tenant-patterns)
- [Debugging RLS](#debugging-rls)
- [Common Pitfalls](#common-pitfalls)

---

## Why RLS at the Table Layer

The row filter lives on the table itself, not in a wrapping view:

    ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY orders_owner_can_read ON orders
        FOR SELECT
        USING (owner_id = fn_current_app_user_id());

Now `SELECT * FROM orders` returns only the user's rows — no matter how the query was issued. The table itself enforces the filter; no application code or query convention is needed to keep data scoped.

## Enabling RLS

Two-step process per table:

    ALTER TABLE customer ENABLE ROW LEVEL SECURITY;

Without policies, an RLS-enabled table denies all access to non-owner roles. Add at least one permissive policy per operation you want to allow.

## Policy Anatomy

    CREATE POLICY <policy_name> ON <table>
        [ AS { PERMISSIVE | RESTRICTIVE } ]
        [ FOR { ALL | SELECT | INSERT | UPDATE | DELETE } ]
        [ TO { role_name | PUBLIC | CURRENT_USER } [, ...] ]
        [ USING (<expression>) ]
        [ WITH CHECK (<expression>) ]

- **PERMISSIVE** (default) — multiple permissive policies are OR-ed. A row is visible if *any* policy allows it.
- **RESTRICTIVE** — AND-ed with permissive results. Use to layer additional restrictions (e.g., "owner *and* not deleted").
- **FOR** — limit which DML the policy applies to.
- **TO** — limit which roles the policy applies to. Default is `PUBLIC`.
- **USING** — read filter. Applied to existing rows for SELECT/UPDATE/DELETE visibility.
- **WITH CHECK** — write filter. Applied to new/modified row state for INSERT/UPDATE.

## USING vs WITH CHECK

- **USING** governs *which existing rows you can see or touch*. Affects SELECT, and the row-targeting half of UPDATE/DELETE.
- **WITH CHECK** governs *what state new rows are allowed to land in*. Affects INSERT and the new-state half of UPDATE.

Common pairing: an UPDATE policy needs both — you can update rows you own (USING) but can't change them to be owned by someone else (WITH CHECK):

    CREATE POLICY orders_owner_can_modify ON orders
        FOR UPDATE
        USING (owner_id = fn_current_app_user_id())
        WITH CHECK (owner_id = fn_current_app_user_id());

If you omit `WITH CHECK` on UPDATE, Postgres uses the USING expression for both halves.

## The fn_current_app_user_id() Pattern

Policies need to know "who is the current app user?" Define a `SECURITY DEFINER` function that reads from a session variable:

    CREATE OR REPLACE FUNCTION fn_current_app_user_id()
    RETURNS user_id
    LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
    DECLARE
        v_id TEXT;
    BEGIN
        v_id := current_setting('app.user_id', TRUE);
        IF v_id IS NULL OR v_id = '' THEN
            RAISE EXCEPTION 'app.user_id session variable not set'
                USING ERRCODE = 'P0004';
        END IF;
        RETURN v_id::user_id;
    END;
    $$;

`STABLE` lets Postgres cache the value within a single query. `SECURITY DEFINER` lets the function read settings the calling role might not be able to read directly.

## Setting Session Identity

The application sets the session variable on every connection (or transaction):

    -- After authentication, set on the pooled connection
    SET app.user_id = '12345';

For pgbouncer-style pooling where connections are reused, prefer `SET LOCAL` inside an explicit transaction so the value is scoped to that transaction:

    BEGIN;
    SET LOCAL app.user_id = '12345';
    -- ... queries ...
    COMMIT;

Or use `set_config('app.user_id', '12345', TRUE)` — the `TRUE` makes it transaction-local equivalent to `SET LOCAL`.

## Bypass Roles

Some roles need to see all rows — admins, background workers, migration scripts. Two mechanisms:

**Per-role policy:**

    CREATE POLICY admin_full_access ON customer
        FOR ALL TO admin_role
        USING (TRUE) WITH CHECK (TRUE);

**Role-level bypass:**

    ALTER ROLE migration_role BYPASSRLS;

`BYPASSRLS` is a role attribute — that role ignores RLS entirely. Reserve for trusted system roles (DBA, migrations). Superusers bypass RLS by default.

## FORCE ROW LEVEL SECURITY

By default, the **table owner** also bypasses RLS. This is usually wrong for app schemas — the owner is often the role your app connects as. Force RLS to apply to the owner too:

    ALTER TABLE customer FORCE ROW LEVEL SECURITY;

Without `FORCE`, your application role (if it owns the table) sees all rows regardless of policies. With `FORCE`, only `BYPASSRLS` and superuser roles bypass.

## Multi-Tenant Patterns

For multi-tenant SaaS, add `tenant_id` to every table and combine with user identity:

    CREATE POLICY tenant_isolation ON customer
        AS RESTRICTIVE
        FOR ALL
        USING (tenant_id = fn_current_app_tenant_id());

    CREATE POLICY user_owns_customer ON customer
        FOR ALL
        USING (owner_id = fn_current_app_user_id());

The RESTRICTIVE tenant policy is AND-ed with the permissive user policy: a row is visible only if it's in the user's tenant AND owned by the user (or whatever permissive rule applies).

## Debugging RLS

**See current settings:**

    SHOW row_security;          -- 'on' or 'off' for the session
    SHOW app.user_id;           -- your custom variable

**See policies on a table:**

    SELECT * FROM pg_policies WHERE tablename = 'customer';

**Test as another role:**

    SET ROLE other_role;
    SELECT * FROM customer;     -- now subject to other_role's policies
    RESET ROLE;

**Disable RLS for a session (debugging only, requires privilege):**

    SET row_security = off;     -- errors if user can't bypass

**Explain plan shows the filter:**

    EXPLAIN SELECT * FROM customer;
    -- Look for "Filter: (owner_id = fn_current_app_user_id())" in the plan

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| RLS enabled but no policies — table is unreadable | Add at least one permissive policy per operation |
| Forgot `FORCE ROW LEVEL SECURITY` — table owner sees all | `ALTER TABLE x FORCE ROW LEVEL SECURITY` |
| Policy USING but no WITH CHECK on UPDATE — users can change ownership | Always specify both for UPDATE |
| `fn_current_app_user_id()` is `VOLATILE` — Postgres re-evaluates per row | Mark `STABLE` |
| Session variable not set — function raises | Set `app.user_id` immediately after auth |
| Background worker can't see rows | Grant `BYPASSRLS` or add a `worker_role` policy |
| Multi-tenant data leak | Use RESTRICTIVE policy for tenant_id; never trust permissive-only |
| Migration script blocked by RLS | Run as a `BYPASSRLS` role |

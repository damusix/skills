# Schema Separation


Postgres schemas are namespaces inside a database — separate from databases themselves. Splitting your schema into logical namespaces (app, audit, ref, archive) gives you cleaner permission boundaries, lifecycle separation, and reduced cognitive load.

## Table of Contents

- [Schemas Are Not Databases](#schemas-are-not-databases)
- [The Standard Layout](#the-standard-layout)
- [search_path](#search_path)
- [Cross-Schema References](#cross-schema-references)
- [Permissions: GRANT USAGE](#permissions-grant-usage)
- [Schema Migration Workflows](#schema-migration-workflows)
- [Anti-Patterns](#anti-patterns)

---

## Schemas Are Not Databases

In Postgres, one database can contain many schemas. Tables in different schemas are independent namespaces — `app.customer` and `archive.customer` can coexist.

This is the right tool for logical separation. Don't use multiple databases unless you need physical isolation (different replicas, different backup schedules, different connection limits).

## The Standard Layout

A typical application database:

    app          -- application tables (customer, orders, account, ...)
    audit        -- audit/history tables (customer_audit, ...)
    ref          -- reference / lookup tables (account_type, country, ...)
    archive      -- archived historical data (customer_audit_archive, ...)
    util         -- helper functions (fn_assert_not_in_transaction, meta-fns)
    public       -- usually empty; serves as fallback search_path entry

Create with:

    CREATE SCHEMA IF NOT EXISTS app;
    CREATE SCHEMA IF NOT EXISTS audit;
    CREATE SCHEMA IF NOT EXISTS ref;
    CREATE SCHEMA IF NOT EXISTS archive;
    CREATE SCHEMA IF NOT EXISTS util;

Why split:

- **Permissions** — grant `SELECT` on `audit` to `audit_reader` without exposing it to all roles
- **Lifecycle** — `audit` grows fast and may need partitioning; `ref` is mostly static
- **Visibility** — `\dt app.*` shows only your domain tables; `pg_dump --schema=app` backs up just the live app
- **Migration boundaries** — different schemas can be on different change cadences

## search_path

`search_path` tells Postgres which schemas to look in when you write an unqualified name:

    SHOW search_path;
    -- "$user", public

    SET search_path TO app, ref, public;
    SELECT * FROM customer;     -- finds app.customer first

Set per-role for predictability:

    ALTER ROLE app_user SET search_path TO app, ref, public;

Functions inherit `search_path` from the session by default. For `SECURITY DEFINER` functions, **always set search_path explicitly inside the function** to avoid privilege-escalation attacks:

    CREATE OR REPLACE FUNCTION util.fn_current_app_user_id()
    RETURNS user_id
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = util, pg_temp AS $$
    BEGIN
        ...
    END;
    $$;

## Cross-Schema References

FKs, joins, and function calls work transparently across schemas — qualify the name when there's any ambiguity:

    CREATE TABLE app.orders (
        customer_no customer_no NOT NULL REFERENCES app.customer(customer_no),
        status      type_name NOT NULL REFERENCES ref.order_status(status),
        ...
    );

In a busy schema layout, **qualify all DDL** (`app.customer`, not `customer`). For queries inside the app's normal flow, the `search_path` handles resolution.

## Permissions: GRANT USAGE

A role needs `USAGE` on a schema before it can access *anything* inside it, even with `SELECT` on the table:

    -- Read-only role for analytics
    CREATE ROLE analytics_reader;
    GRANT USAGE ON SCHEMA app, ref TO analytics_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA app, ref TO analytics_reader;

    -- Future tables: set defaults so new tables inherit the grant
    ALTER DEFAULT PRIVILEGES IN SCHEMA app
        GRANT SELECT ON TABLES TO analytics_reader;

This is one of the most common permission bugs: the role has `SELECT` on the table but no `USAGE` on the schema, so they get cryptic "permission denied for schema" errors.

## Schema Migration Workflows

Most migration tools (Flyway, Liquibase, goose, sqlx-migrate) track applied migrations in a table — by default in `public`. Move it to a dedicated schema:

    CREATE SCHEMA IF NOT EXISTS schema_migration;

Then configure your tool to use that schema (most support a setting).

This keeps `public` truly empty and prevents accidental dependencies on migration metadata.

## Anti-Patterns

| Anti-pattern | Fix |
|--------------|-----|
| All tables in `public` | Move to `app` (or other domain schemas); leave `public` empty |
| Different schemas per microservice in one DB | Use separate databases or instances if they truly belong to different services |
| Mirroring app code packages in schemas (`user_service`, `order_service`) | Schemas are for *lifecycle and permission* boundaries, not code structure |
| Schemas per tenant (10,000 tenants → 10,000 schemas) | Use a `tenant_id` column + RLS instead; schema-per-tenant scales poorly |
| Not qualifying DDL — relying on `search_path` for `CREATE TABLE customer` | Always qualify in DDL: `CREATE TABLE app.customer` |
| Granting `SELECT` without `USAGE` | Always grant both, plus set default privileges for future tables |

# Migration Patterns


Every migration must be safe to run multiple times. Postgres provides native `IF NOT EXISTS` clauses for most DDL, dramatically reducing the meta-function library. A small set of `fn_*_exists` helpers handles what Postgres doesn't natively guard.

## Table of Contents

- [Native IF NOT EXISTS Coverage](#native-if-not-exists-coverage)
- [The Slim Meta-Function Library](#the-slim-meta-function-library)
- [Migration File Structure](#migration-file-structure)
- [Idempotent Patterns by Operation](#idempotent-patterns-by-operation)
- [Validation Workflow](#validation-workflow)
- [Schema Migration Tools](#schema-migration-tools)

---

## Native IF NOT EXISTS Coverage

Postgres natively supports idempotent DDL for most objects:

| Statement | Idempotent form |
|-----------|-----------------|
| `CREATE SCHEMA` | `CREATE SCHEMA IF NOT EXISTS app;` |
| `CREATE TABLE` | `CREATE TABLE IF NOT EXISTS customer (...);` |
| `ALTER TABLE ADD COLUMN` | `ALTER TABLE customer ADD COLUMN IF NOT EXISTS is_verified bool_false;` |
| `ALTER TABLE DROP COLUMN` | `ALTER TABLE customer DROP COLUMN IF EXISTS legacy_field;` |
| `CREATE INDEX` | `CREATE INDEX IF NOT EXISTS customer_email_idx ON customer(email);` |
| `DROP INDEX` | `DROP INDEX IF EXISTS old_idx;` |
| `CREATE SEQUENCE` | `CREATE SEQUENCE IF NOT EXISTS order_no_seq;` |
| `CREATE FUNCTION` | `CREATE OR REPLACE FUNCTION ...` |
| `CREATE PROCEDURE` | `CREATE OR REPLACE PROCEDURE ...` |
| `CREATE VIEW` | `CREATE OR REPLACE VIEW ...` |
| `CREATE TRIGGER` | use `DROP TRIGGER IF EXISTS ...` then `CREATE TRIGGER ...` |
| `DROP TABLE` | `DROP TABLE IF EXISTS customer;` |

For everything in this table, idempotency is a one-keyword change.

## The Slim Meta-Function Library

What Postgres doesn't guard natively, plus introspection helpers:

    -- Constraints
    CREATE OR REPLACE FUNCTION fn_constraint_exists(
        p_table_name text, p_constraint_name text
    )
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = p_table_name
              AND constraint_name = p_constraint_name
        );
    $$;

    -- RLS policies
    CREATE OR REPLACE FUNCTION fn_policy_exists(
        p_table_name text, p_policy_name text
    )
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE tablename = p_table_name AND policyname = p_policy_name
        );
    $$;

    -- Triggers
    CREATE OR REPLACE FUNCTION fn_trigger_exists(
        p_table_name text, p_trigger_name text
    )
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
            SELECT 1 FROM information_schema.triggers
            WHERE event_object_table = p_table_name
              AND trigger_name = p_trigger_name
        );
    $$;

    -- Domains
    CREATE OR REPLACE FUNCTION fn_domain_exists(p_domain_name text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
            SELECT 1 FROM information_schema.domains
            WHERE domain_name = p_domain_name
        );
    $$;

    -- Column type introspection (for type-change migrations)
    CREATE OR REPLACE FUNCTION fn_column_data_type(
        p_table_name text, p_column_name text
    )
    RETURNS text LANGUAGE sql STABLE AS $$
        SELECT data_type FROM information_schema.columns
        WHERE table_name = p_table_name AND column_name = p_column_name;
    $$;

    -- RLS enabled?
    CREATE OR REPLACE FUNCTION fn_rls_enabled(p_table_name text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT relrowsecurity FROM pg_class WHERE relname = p_table_name;
    $$;

That.s the core library — small, focused on what Postgres doesn.t natively guard.

## Migration File Structure

Each migration is a single SQL file, named with timestamp + description:

    migrations/
        20260101_120000_create_account.sql
        20260102_093000_add_savings_account.sql
        20260103_140000_add_account_rls.sql

Each file is self-contained, idempotent, and runnable in any order *if* dependencies are honored (use a migration tool to enforce order — see below).

Standard structure:

    -- migration: 20260101_120000_create_account.sql
    -- purpose: Account base table + savings/checking subtypes

    BEGIN;

    CREATE DOMAIN account_no AS bigint NOT NULL;
    CREATE DOMAIN money_amount AS numeric(18,4) NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS account_type (
        type type_name PRIMARY KEY
    );
    INSERT INTO account_type(type) VALUES ('savings'), ('checking')
    ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS account (
        account_no account_no PRIMARY KEY,
        type       type_name NOT NULL,
        opened_at  ts_now NOT NULL,
        owner_id   user_id NOT NULL,
        CONSTRAINT account_is_classified_by_type
            FOREIGN KEY (type) REFERENCES account_type(type)
    );

    -- Add policy idempotently
    DO $$
    BEGIN
        IF NOT fn_policy_exists('account', 'account_owner_can_read') THEN
            CREATE POLICY account_owner_can_read ON account
                FOR SELECT USING (owner_id = fn_current_app_user_id());
        END IF;
    END $$;

    COMMIT;

Wrap the whole migration in `BEGIN`/`COMMIT` so partial failure rolls everything back.

## Idempotent Patterns by Operation

**Add a column with a constraint:**

    ALTER TABLE customer
        ADD COLUMN IF NOT EXISTS is_verified bool_false;

    DO $$
    BEGIN
        IF NOT fn_constraint_exists('customer', 'customer_verification_requires_email') THEN
            ALTER TABLE customer ADD CONSTRAINT customer_verification_requires_email
                CHECK (NOT is_verified OR email IS NOT NULL);
        END IF;
    END $$;

**Add a trigger:**

    DROP TRIGGER IF EXISTS customer_audit ON customer;
    CREATE TRIGGER customer_audit
        AFTER INSERT OR UPDATE OR DELETE ON customer
        FOR EACH ROW EXECUTE FUNCTION tg_customer_audit();

The `DROP IF EXISTS` + `CREATE` pattern is idiomatic for triggers (Postgres has no `CREATE OR REPLACE TRIGGER`).

**Add an RLS policy:**

    DO $$
    BEGIN
        IF NOT fn_policy_exists('customer', 'customer_owner_can_read') THEN
            CREATE POLICY customer_owner_can_read ON customer
                FOR SELECT USING (owner_id = fn_current_app_user_id());
        END IF;
    END $$;

**Change a column type (multi-step, online):**

    -- Step 1: add new column
    ALTER TABLE customer ADD COLUMN IF NOT EXISTS new_balance money_amount;

    -- Step 2: backfill (idempotent because it's a SET = SET)
    UPDATE customer SET new_balance = balance::money_amount
    WHERE new_balance IS NULL;

    -- Step 3: swap (in a separate migration after backfill confirmed)
    -- ALTER TABLE customer DROP COLUMN balance;
    -- ALTER TABLE customer RENAME COLUMN new_balance TO balance;

**Add a domain:**

    DO $$
    BEGIN
        IF NOT fn_domain_exists('email') THEN
            CREATE DOMAIN email AS varchar(100) NOT NULL
                CHECK (VALUE LIKE '%_@_%.__%');
        END IF;
    END $$;

## Validation Workflow

After writing a migration, verify before committing:

1. **Run once.** Confirm no errors.
2. **Verify objects exist.**
       SELECT to_regclass('customer');                 -- table exists if not NULL
       SELECT fn_constraint_exists('customer', 'customer_email_is_unique');
       SELECT fn_policy_exists('customer', 'customer_owner_can_read');
3. **Run again.** Confirm no errors and no duplicate objects (idempotency).
4. **Inspect with `\d+ table_name`** in psql to confirm the resulting schema.

## Schema Migration Tools

Use a migration runner that tracks applied migrations — don't roll your own:

- **Flyway** — file-based, `V001__create_account.sql` naming, supports Postgres
- **Liquibase** — XML/YAML/SQL, more features, more ceremony
- **goose** — Go-based, simple SQL files with `-- +goose Up` / `-- +goose Down` markers
- **sqlx-migrate** (Rust), **node-pg-migrate** (Node), **alembic** (Python/SQLAlchemy)

The runner tracks which files have been applied (in a `schema_migrations` table) and runs new ones in order. Your job: write idempotent SQL files; the runner enforces ordering and prevents re-runs.

For monorepo-scale, **Sqitch** or in-house runners that integrate with deployment pipelines are common — pick what fits your team's workflow.

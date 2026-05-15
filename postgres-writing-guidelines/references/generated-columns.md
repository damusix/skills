# Generated Columns


Generated columns are derived from other columns by an expression. Postgres computes them at write time, stores the result, and keeps them in sync automatically. They can be indexed like regular columns.

## Table of Contents

- [The Syntax](#the-syntax)
- [What You Can and Can't Reference](#what-you-can-and-cant-reference)
- [STORED, Not VIRTUAL](#stored-not-virtual)
- [Common Patterns](#common-patterns)
- [Indexing Generated Columns](#indexing-generated-columns)
- [When to Use a Generated Column vs a Trigger](#when-to-use-a-generated-column-vs-a-trigger)
- [Migration: Adding to an Existing Table](#migration-adding-to-an-existing-table)
- [Limitations](#limitations)

---

## The Syntax

    CREATE TABLE customer (
        customer_no customer_no PRIMARY KEY,
        first_name  text NOT NULL,
        last_name   text NOT NULL,
        full_name   text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED
    );

`GENERATED ALWAYS AS (...)` is the keyword. `STORED` means Postgres writes the computed value to disk on every insert/update.

Direct writes to a generated column are rejected:

    INSERT INTO customer(customer_no, first_name, last_name, full_name)
    VALUES (1, 'Alice', 'Smith', 'Alice S');
    -- ERROR: cannot insert into column "full_name"

You can use `DEFAULT` in INSERTs to make it explicit:

    INSERT INTO customer(customer_no, first_name, last_name, full_name)
    VALUES (1, 'Alice', 'Smith', DEFAULT);

## What You Can and Can't Reference

The expression must be **deterministic** and reference only:

- Constants
- The same row's columns (no other rows, no subqueries)
- Immutable functions (no `clock_timestamp()`, no `random()`)

**Cannot reference:**

- Other generated columns in the same row
- Other rows or tables
- Volatile functions (`clock_timestamp()`, `nextval()`, etc.)
- User-defined functions marked anything other than `IMMUTABLE`

Postgres enforces this — the column definition is checked at create time.

## STORED, Not VIRTUAL

Postgres supports only `STORED` generated columns (as of Postgres 17). `VIRTUAL` (compute on read) is in some other databases but not Postgres yet. Implication: every generated column adds row width — be selective.

## Common Patterns

**Concatenated full names:**

    full_name text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED

**Normalized search columns:**

    email_normalized text GENERATED ALWAYS AS (lower(trim(email))) STORED

Pair with an index on `email_normalized` for case-insensitive lookups.

**Computed totals:**

    line_total numeric(18,4)
        GENERATED ALWAYS AS (quantity * unit_price) STORED

Sum across rows still requires `SUM(line_total)` at query time, but you avoid recomputing the multiplication every read.

**Boolean flags from state:**

    is_terminal boolean
        GENERATED ALWAYS AS (status IN ('done', 'failed', 'cancelled')) STORED

Lets you index `is_terminal` directly — useful if many queries filter on it.

**Age from date_of_birth:**

    -- This DOES NOT work — clock_timestamp() is volatile
    age int GENERATED ALWAYS AS (DATE_PART('year', AGE(date_of_birth))) STORED;
    -- ERROR: generation expression is not immutable

Compute age in a view or at query time instead.

## Indexing Generated Columns

Index them like any column:

    CREATE INDEX customer_full_name_idx
        ON customer(full_name);

    CREATE INDEX customer_email_normalized_idx
        ON customer(email_normalized);

This is the main reason to use generated columns over expression indexes: the column is materialized once and indexed once, and queries can reference the column directly without recomputing the expression.

## When to Use a Generated Column vs a Trigger

**Generated column** for purely deterministic derivations of *the same row's data* — Postgres handles consistency, the column is type-checked, no DML in your codebase.

**Trigger** when the derivation depends on other tables, non-deterministic functions, or external state:

    -- This MUST be a trigger — calls a volatile function
    CREATE OR REPLACE FUNCTION tg_customer_search_text()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        NEW.search_text := lower(NEW.full_name || ' ' || NEW.email);
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER customer_search_text
        BEFORE INSERT OR UPDATE ON customer
        FOR EACH ROW EXECUTE FUNCTION tg_customer_search_text();

If you can express the derivation as a `STORED` generated column, do — it's simpler, faster, and the constraint is documented inline. Reach for triggers only when the constraints don't fit.

## Migration: Adding to an Existing Table

    -- Add the column (Postgres backfills the value for existing rows)
    ALTER TABLE customer
        ADD COLUMN full_name text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED;

    -- Index it
    CREATE INDEX IF NOT EXISTS customer_full_name_idx ON customer(full_name);

For large tables, the backfill rewrites the entire table — same cost as a `CHECK` on every row. Schedule for a maintenance window or use a multi-step migration (add column, backfill in batches, attach index `CONCURRENTLY`).

## Limitations

- **No VIRTUAL** — every generated column adds bytes per row
- **No reference to other generated columns** — chain via intermediate columns or use a trigger
- **No mutable expressions** — no `clock_timestamp()`, `random()`, `nextval()`, `current_user`
- **Type cannot be inferred** — must specify explicitly
- **Cannot be a PK** (technically possible but very rarely useful)
- **Replication considerations** — logical replication handles generated columns; some tools may not. Verify with your replica setup.

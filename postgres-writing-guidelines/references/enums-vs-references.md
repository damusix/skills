# Enums vs Reference Tables


Postgres gives you two ways to constrain a column to a fixed vocabulary: `CREATE TYPE ... AS ENUM` and a reference (lookup) table with a FK. They overlap, but they're not interchangeable. Pick deliberately.

## Table of Contents

- [The Two Options](#the-two-options)
- [Rule of Thumb](#rule-of-thumb)
- [Enums: Strengths and Limits](#enums-strengths-and-limits)
- [Reference Tables: Strengths and Limits](#reference-tables-strengths-and-limits)
- [Migrating Between Them](#migrating-between-them)
- [Hybrid: Enum + Mirror Table](#hybrid-enum--mirror-table)
- [Decision Examples](#decision-examples)

---

## The Two Options

**Enum:**

    CREATE TYPE order_status AS ENUM (
        'draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled'
    );

    CREATE TABLE orders (
        ...,
        status order_status NOT NULL DEFAULT 'draft'
    );

**Reference table:**

    CREATE TABLE order_status (
        status type_name PRIMARY KEY,
        sort_order smallint NOT NULL,
        is_terminal boolean NOT NULL
    );

    INSERT INTO order_status VALUES
        ('draft',     10, FALSE),
        ('submitted', 20, FALSE),
        ('approved',  30, FALSE),
        ('shipped',   40, FALSE),
        ('delivered', 50, TRUE),
        ('cancelled', 99, TRUE)
    ON CONFLICT DO NOTHING;

    CREATE TABLE orders (
        ...,
        status type_name NOT NULL DEFAULT 'draft' REFERENCES order_status(status)
    );

## Rule of Thumb

- **Enum** when the vocabulary is **closed, stable, and value-only** — you only care about the label, never about extra columns or runtime additions.
- **Reference table** when you need **extra columns** (display label, sort order, flags, descriptions), **FK targets** (e.g., a child table referencing the value), or **runtime additions** (admin UI adds new statuses without a migration).

If in doubt, use a reference table. The flexibility is worth the small overhead of a join when you need extra metadata.

## Enums: Strengths and Limits

**Strengths:**

- Type-safe at the column level — no need for an FK or CHECK
- Compact storage (4 bytes, regardless of label length)
- Ordering is intrinsic (enum values sort in declaration order)
- No join needed to validate
- Function/procedure parameter types can use it directly

**Limits:**

- **Adding values is fine** (`ALTER TYPE order_status ADD VALUE 'partially_shipped' BEFORE 'shipped'`) but **cannot be done inside a transaction in older Postgres versions** (works in v12+ in many cases, but check)
- **Removing values is hard** — no `ALTER TYPE ... DROP VALUE`. You have to rename the type, create a new one, migrate columns, drop the old type
- **Renaming values is supported** but requires `ALTER TYPE ... RENAME VALUE`
- **No extra columns** — if you later realize you need a display name or a flag, you'll regret picking enum
- **Each new value is a schema change** — bad for vocabularies that change frequently

## Reference Tables: Strengths and Limits

**Strengths:**

- Extra columns (sort order, display name, group, deprecated flag, etc.)
- FK targets — child tables can reference the value with cascade behavior
- Runtime additions via INSERT — no DDL needed
- Queryable like any other table (`SELECT * FROM order_status WHERE is_terminal`)
- Standard backup/restore semantics

**Limits:**

- Requires a join (or a function lookup) to retrieve extra columns
- A bit more verbose to declare and seed
- The string value is stored per row — slightly larger than an enum's 4-byte integer
- Vulnerable to operator mistakes if not protected: someone could `DELETE FROM order_status WHERE status = 'shipped'` and break the world (mitigation: RLS or `REVOKE DELETE ... FROM PUBLIC`)

## Migrating Between Them

**Enum → reference table:**

    -- 1. Create the reference table and seed
    CREATE TABLE order_status (status type_name PRIMARY KEY, ...);
    INSERT INTO order_status(status)
        SELECT unnest(enum_range(NULL::order_status))::text;

    -- 2. Add new column on orders
    ALTER TABLE orders ADD COLUMN status_new type_name;
    UPDATE orders SET status_new = status::text;

    -- 3. Swap columns, add FK
    ALTER TABLE orders DROP COLUMN status;
    ALTER TABLE orders RENAME COLUMN status_new TO status;
    ALTER TABLE orders ADD CONSTRAINT orders_classified_by_status
        FOREIGN KEY (status) REFERENCES order_status(status);

    -- 4. Drop the old enum
    DROP TYPE order_status;

**Reference table → enum:** rarely worth doing. If you find yourself going this direction, the table probably wasn't earning its keep.

## Hybrid: Enum + Mirror Table

For vocabularies where you want enum-level type safety *and* extra metadata, keep both:

    CREATE TYPE order_status AS ENUM (...);

    CREATE TABLE order_status_meta (
        status        order_status PRIMARY KEY,
        display_name  text NOT NULL,
        sort_order    smallint NOT NULL,
        is_terminal   boolean NOT NULL
    );

The column on `orders` is typed as the enum; the meta table is for lookups. Cost: every new enum value requires both an `ALTER TYPE` and an INSERT into the meta table.

This is reasonable for status machines (`queue_status`, `order_status`) where the vocabulary is genuinely closed but you still want metadata.

## Decision Examples

| Vocabulary | Pick | Why |
|------------|------|-----|
| `account_type` ('savings', 'checking', ...) | Reference table | Type discriminator with FK from subtype tables |
| `order_status` ('draft', 'shipped', ...) | Hybrid or enum | Closed state machine, need ordering, want metadata |
| `queue_status` ('pending', 'in_progress', ...) | Reference table or enum | Used by many tables, closed set |
| `country_code` (ISO 3166) | Reference table | Need name, region, currency, etc. |
| `phone_type` ('mobile', 'home', 'work') | Enum | Tiny closed set, just a label |
| `feature_flag_name` | Reference table | Runtime additions, metadata, possibly RLS-scoped |
| `audit_action` ('INSERT', 'UPDATE', 'DELETE') | Enum | Triple-locked: closed set, just labels, never changes |
| `permission_role` | Reference table | FK from user_role; rich metadata |

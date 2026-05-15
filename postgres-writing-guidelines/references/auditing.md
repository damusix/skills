# Auditing & History Tables


Audit tables capture who changed what, when, and what the before/after state was. Postgres + JSONB makes audit cheap to add and trivial to query later.

## Table of Contents

- [The Pattern: Parallel Audit Table](#the-pattern-parallel-audit-table)
- [The Audit Trigger Function](#the-audit-trigger-function)
- [Computing a Diff](#computing-a-diff)
- [Querying the History](#querying-the-history)
- [Per-Table vs Generic Audit](#per-table-vs-generic-audit)
- [Retention and Archival](#retention-and-archival)
- [Performance Considerations](#performance-considerations)
- [System-Versioned Alternative](#system-versioned-alternative)
- [What Audit Is NOT](#what-audit-is-not)

---

## The Pattern: Parallel Audit Table

Each audited table gets a sibling `<table>_audit` capturing every change:

    CREATE TYPE audit_action AS ENUM ('INSERT', 'UPDATE', 'DELETE');

    CREATE TABLE customer_audit (
        audit_id     bigserial PRIMARY KEY,
        customer_no  customer_no NOT NULL,
        action       audit_action NOT NULL,
        changed_by   user_id,
        changed_at   ts_now NOT NULL,
        before_data  jsonb,
        after_data   jsonb,
        change_diff  jsonb
    );

    CREATE INDEX customer_audit_lookup_idx
        ON customer_audit(customer_no, changed_at DESC);

    CREATE INDEX customer_audit_diff_gin_idx
        ON customer_audit USING GIN (change_diff);

## The Audit Trigger Function

One function per audited table, called from an `AFTER` trigger:

    CREATE OR REPLACE FUNCTION tg_customer_audit()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO customer_audit(
            customer_no, action, changed_by, changed_at,
            before_data, after_data, change_diff
        ) VALUES (
            COALESCE(NEW.customer_no, OLD.customer_no),
            TG_OP::audit_action,
            fn_current_app_user_id(),
            clock_timestamp(),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
            CASE WHEN TG_OP = 'UPDATE'
                 THEN fn_jsonb_diff(to_jsonb(OLD), to_jsonb(NEW))
                 ELSE NULL END
        );
        RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE TRIGGER customer_audit
        AFTER INSERT OR UPDATE OR DELETE ON customer
        FOR EACH ROW EXECUTE FUNCTION tg_customer_audit();

## Computing a Diff

`fn_jsonb_diff(old, new)` returns only the changed keys — saves storage and makes review easier:

    CREATE OR REPLACE FUNCTION fn_jsonb_diff(p_old jsonb, p_new jsonb)
    RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
        SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
        FROM jsonb_each(p_new)
        WHERE p_old->>key IS DISTINCT FROM p_new->>key;
    $$;

`IS DISTINCT FROM` is NULL-safe — treats `NULL → 'x'` and `'x' → NULL` as changes.

## Querying the History

Latest change for an entity:

    SELECT changed_at, changed_by, action, change_diff
    FROM customer_audit
    WHERE customer_no = 42
    ORDER BY changed_at DESC LIMIT 1;

Full timeline:

    SELECT changed_at, action, before_data, after_data
    FROM customer_audit
    WHERE customer_no = 42
    ORDER BY changed_at ASC;

Every change that touched a specific field (using the GIN index):

    SELECT customer_no, changed_at, change_diff->>'email' AS new_email
    FROM customer_audit
    WHERE change_diff ? 'email';

## Per-Table vs Generic Audit

**Per-table** (one `*_audit` per source): clear schema, easy per-entity queries, FK to source meaningful, easy to drop with the source.

**Generic** (one `audit_log` for everything): simpler triggers, but must filter on `table_name`, no FK relationship, drowns under high-volume tables.

**Default to per-table.** Use generic only for low-volume tables that share a common audit need (e.g., admin actions across reference tables).

## Retention and Archival

Audit tables grow forever. Plan retention from day one:

- **Hot retention** — keep N months in the live audit table for fast queries
- **Cold storage** — move older rows to `<table>_audit_archive` (same schema, separate tablespace or partition)
- **Hard delete** — GDPR right-to-be-forgotten may require deleting audit too; design for that case

Monthly archive job:

    WITH archived AS (
        DELETE FROM customer_audit
        WHERE changed_at < clock_timestamp() - INTERVAL '12 months'
        RETURNING *
    )
    INSERT INTO customer_audit_archive SELECT * FROM archived;

## Performance Considerations

Audit triggers double the write cost. Mitigations:

- Index narrowly — `(entity_key, changed_at DESC)` and a GIN on `change_diff`. Skip indexing wide columns.
- Disable for bulk migrations: `ALTER TABLE customer DISABLE TRIGGER customer_audit;` then re-enable.
- Use async audit (LISTEN/NOTIFY + worker) for very hot tables — accepts eventual consistency in exchange for write throughput.
- Partition `*_audit` tables by month once they exceed ~50M rows.

## System-Versioned Alternative

The `temporal_tables` extension (or manual implementation) provides SQL:2011 system versioning — every row gets an implicit valid-from/valid-to, and updates create new history rows automatically:

    CREATE TABLE customer (
        ...,
        sys_period tstzrange NOT NULL
    );
    CREATE TABLE customer_history (LIKE customer);
    SELECT versioning('sys_period', 'customer_history', true);

Tradeoff: less control over diff shape, harder to add context (who/why), but zero trigger code to maintain. Good for compliance-driven audit; less good for app-facing change feeds.

## What Audit Is NOT

- **Not a replacement for soft delete.** Audit captures changes; soft delete preserves the row in a deleted state so FKs still resolve. Different purposes.
- **Not a backup.** You can lose `customer` and still have audit rows, but you can't reliably reconstruct the table from audit alone if triggers were ever disabled.
- **Not a security log.** Authentication events, permission grants, and access attempts belong in a separate `auth_event` table tied to identity infrastructure.

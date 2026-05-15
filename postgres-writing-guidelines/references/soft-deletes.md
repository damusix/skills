# Soft Deletes


Soft delete means a row is marked deleted instead of physically removed, so FK references resolve and historical queries still work. The convention: a `deleted_at timestamptz` column, RLS that filters it out, and views/indexes that respect it.

## Table of Contents

- [The Column](#the-column)
- [RLS Filter for Soft Deletes](#rls-filter-for-soft-deletes)
- [Active Views](#active-views)
- [Partial Indexes](#partial-indexes)
- [Procedures for Delete and Restore](#procedures-for-delete-and-restore)
- [FK Behavior](#fk-behavior)
- [Unique Constraints and Soft Delete](#unique-constraints-and-soft-delete)
- [When to Hard Delete Anyway](#when-to-hard-delete-anyway)
- [Soft Delete vs Audit](#soft-delete-vs-audit)

---

## The Column

A single nullable `deleted_at`:

    ALTER TABLE customer
        ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

NULL means active; non-NULL means soft-deleted at that timestamp. No `is_deleted` boolean — the timestamp carries both signal and metadata.

Optionally pair with `deleted_by`:

    ALTER TABLE customer
        ADD COLUMN IF NOT EXISTS deleted_by user_id;

## RLS Filter for Soft Deletes

Make soft delete invisible at the table layer for normal callers:

    CREATE POLICY customer_visible_when_not_deleted ON customer
        FOR SELECT
        USING (deleted_at IS NULL);

    CREATE POLICY admin_sees_all_customers ON customer
        FOR SELECT TO admin_role
        USING (TRUE);

Now `SELECT * FROM customer` returns only active rows for everyone except admins. Restoring or auditing requires admin privilege or a `BYPASSRLS` role.

## Active Views

For shops that don't use RLS for this, or to give a explicit name to "active rows":

    CREATE OR REPLACE VIEW vw_active_customer AS
    SELECT * FROM customer WHERE deleted_at IS NULL;

App code reads from `vw_active_customer`; raw `customer` is for admin/audit tooling.

## Partial Indexes

Every index on a soft-deletable table should be partial — index only active rows:

    CREATE INDEX customer_email_idx
        ON customer(email) WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX customer_email_unique
        ON customer(email) WHERE deleted_at IS NULL;

Two wins: smaller index, and unique constraints don't block re-use of email after the original row is soft-deleted.

## Procedures for Delete and Restore

Mutate via procedures so the timestamp + actor are captured consistently:

    CREATE OR REPLACE PROCEDURE pr_remove_customer(p_customer_no customer_no)
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();

        UPDATE customer
        SET deleted_at = clock_timestamp(),
            deleted_by = fn_current_app_user_id()
        WHERE customer_no = p_customer_no
          AND deleted_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'customer % not found or already deleted', p_customer_no
                USING ERRCODE = 'P0002';
        END IF;

        COMMIT;
    EXCEPTION WHEN OTHERS THEN ROLLBACK; RAISE;
    END;
    $$;

    CREATE OR REPLACE PROCEDURE pr_restore_customer(p_customer_no customer_no)
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();

        UPDATE customer SET deleted_at = NULL, deleted_by = NULL
        WHERE customer_no = p_customer_no AND deleted_at IS NOT NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'customer % not found or not deleted', p_customer_no
                USING ERRCODE = 'P0002';
        END IF;

        COMMIT;
    EXCEPTION WHEN OTHERS THEN ROLLBACK; RAISE;
    END;
    $$;

## FK Behavior

**Gotcha:** Postgres FKs reference *all* rows, including soft-deleted ones. An FK from `orders.customer_no` to `customer.customer_no` happily resolves even if the customer is soft-deleted.

This is usually what you want (orders shouldn't break when a customer is removed) — but be deliberate. If you want a child to be invisible when its parent is soft-deleted, model that in policies, not in FKs.

**Cascade caveat:** `ON DELETE CASCADE` on the FK does nothing during soft delete (no actual DELETE happens). If you want children to soft-delete with their parent, add a trigger:

    CREATE OR REPLACE FUNCTION tg_customer_soft_delete_cascade()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
            UPDATE orders SET deleted_at = NEW.deleted_at
            WHERE customer_no = NEW.customer_no AND deleted_at IS NULL;
        END IF;
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER customer_soft_delete_cascade
        AFTER UPDATE OF deleted_at ON customer
        FOR EACH ROW EXECUTE FUNCTION tg_customer_soft_delete_cascade();

## Unique Constraints and Soft Delete

A plain `UNIQUE` constraint on `email` prevents re-using an email even after the original row is deleted. Use a partial unique index instead:

    -- WRONG: blocks reuse forever
    ALTER TABLE customer ADD CONSTRAINT customer_email_unique UNIQUE (email);

    -- RIGHT: only enforced on active rows
    CREATE UNIQUE INDEX customer_email_unique_active
        ON customer(email) WHERE deleted_at IS NULL;

## When to Hard Delete Anyway

Some data must be physically removed:

- **GDPR / right-to-be-forgotten** — PII must be unrecoverable
- **Test data, fixtures** — no need for history
- **Soft-deleted rows past retention horizon** — cleanup job hard-deletes after N months
- **Domain-specific compliance** (HIPAA, PCI)

A typical purge job hard-deletes anything soft-deleted longer than retention:

    DELETE FROM customer
    WHERE deleted_at < clock_timestamp() - INTERVAL '90 days';

Run after audit retention has captured what you needed.

## Soft Delete vs Audit

- **Soft delete** preserves the live row in a "deleted" state so FKs resolve, queries can still find it (with admin access), and restore is trivial.
- **Audit** captures *changes* to rows — including the soft-delete transition itself.

They complement each other. A soft-deleted row has one final audit entry capturing the `deleted_at` transition; a hard-deleted row leaves only audit history.

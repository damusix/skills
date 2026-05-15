# Cross-Table Constraints


Postgres `CHECK` constraints can't reliably reach across tables — functions in `CHECK` must be `IMMUTABLE`, but a function that reads from another table is not immutable (the data it reads can change). Use `BEFORE INSERT/UPDATE` triggers that delegate to validation functions. **Triggers stay thin; functions hold all logic and DML.**

## Table of Contents

- [The Pattern: Trigger + Function](#the-pattern-trigger--function)
- [Why Not CHECK + Function](#why-not-check--function)
- [Type Discriminator Enforcement](#type-discriminator-enforcement)
- [Cross-Table Existence Validation](#cross-table-existence-validation)
- [State Machine Transitions](#state-machine-transitions)
- [Audit Row Generation](#audit-row-generation)
- [DEFERRABLE Constraints for Ordering](#deferrable-constraints-for-ordering)
- [Naming and Granularity](#naming-and-granularity)

---

## The Pattern: Trigger + Function

The function holds the validation logic. The trigger is a one-liner that wires it to a table.

    -- Function: holds all logic, returns the row to commit (NEW) or abort (RAISE)
    CREATE OR REPLACE FUNCTION tg_savings_account_check_type()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM account
            WHERE account_no = NEW.account_no AND type = 'savings'
        ) THEN
            RAISE EXCEPTION 'savings_account requires account.type = ''savings'''
                USING ERRCODE = 'P0010';
        END IF;
        RETURN NEW;
    END;
    $$;

    -- Trigger: wires the function to the table, no logic of its own
    CREATE TRIGGER savings_account_must_be_savings_type
        BEFORE INSERT OR UPDATE ON savings_account
        FOR EACH ROW EXECUTE FUNCTION tg_savings_account_check_type();

**Why split:**

- Functions are testable in isolation (`SELECT tg_savings_account_check_type()` won't run, but the SQL inside can be unit-tested via fixtures)
- Functions can be reused across multiple triggers (e.g., one for INSERT, one for UPDATE with a different WHEN clause)
- Triggers become a wiring map, easy to audit
- Logic changes don't require dropping and recreating triggers — just `CREATE OR REPLACE FUNCTION`

## Why Not CHECK + Function

This *looks* like it should work:

    -- DON'T DO THIS
    CREATE FUNCTION fn_account_is_savings(p_account_no account_no)
    RETURNS BOOLEAN AS $$
        SELECT EXISTS (
            SELECT 1 FROM account WHERE account_no = p_account_no AND type = 'savings'
        );
    $$ LANGUAGE sql IMMUTABLE;  -- LIE: not actually immutable

    ALTER TABLE savings_account ADD CONSTRAINT savings_account_is_savings_type
        CHECK (fn_account_is_savings(account_no));

Postgres allows this, but the function is not actually immutable — the `account.type` column it reads can change. Postgres caches plans assuming immutability, so you get:

- Stale validation results
- CHECK constraints that pass at insert time but become invalid later
- No re-validation when the referenced row changes

**The right tool is a trigger, on both tables**: `BEFORE INSERT/UPDATE` on `savings_account` (the validating side), and a `BEFORE UPDATE` on `account` to prevent the referenced type from changing if subtypes exist.

## Type Discriminator Enforcement

Base table:

    CREATE TABLE account (
        account_no account_no PRIMARY KEY,
        type       account_type_enum NOT NULL,
        opened_at  ts_now NOT NULL,
        ...
    );

Subtype table with type-discriminator trigger:

    CREATE TABLE savings_account (
        account_no   account_no PRIMARY KEY,
        interest_rate growth_rate NOT NULL,
        min_balance  money_amount NOT NULL,

        CONSTRAINT savings_account_is_account
            FOREIGN KEY (account_no) REFERENCES account(account_no)
                ON DELETE CASCADE
    );

    CREATE TRIGGER savings_account_must_be_savings_type
        BEFORE INSERT OR UPDATE ON savings_account
        FOR EACH ROW EXECUTE FUNCTION tg_savings_account_check_type();

Don't forget the **other side**: prevent the base row from changing type while subtypes exist:

    CREATE OR REPLACE FUNCTION tg_account_type_immutable_when_subtyped()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.type IS DISTINCT FROM OLD.type THEN
            IF EXISTS (SELECT 1 FROM savings_account WHERE account_no = OLD.account_no)
            OR EXISTS (SELECT 1 FROM checking_account WHERE account_no = OLD.account_no)
            THEN
                RAISE EXCEPTION 'cannot change account.type while subtype rows exist'
                    USING ERRCODE = 'P0010';
            END IF;
        END IF;
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER account_type_immutable_when_subtyped
        BEFORE UPDATE ON account
        FOR EACH ROW EXECUTE FUNCTION tg_account_type_immutable_when_subtyped();

## Cross-Table Existence Validation

When a column must reference state in another table that an FK alone can't express:

    CREATE OR REPLACE FUNCTION tg_order_line_product_active()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM product
            WHERE product_no = NEW.product_no AND status = 'active'
        ) THEN
            RAISE EXCEPTION 'cannot add inactive product % to order line', NEW.product_no
                USING ERRCODE = 'P0005';
        END IF;
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER order_line_must_reference_active_product
        BEFORE INSERT OR UPDATE OF product_no ON order_line
        FOR EACH ROW EXECUTE FUNCTION tg_order_line_product_active();

`UPDATE OF product_no` limits the trigger to fire only when that column changes — cheaper than firing on every UPDATE.

## State Machine Transitions

Enforce that an entity can only move between allowed states:

    CREATE TABLE order_status_transition (
        from_status order_status_enum,
        to_status   order_status_enum,
        PRIMARY KEY (from_status, to_status)
    );

    INSERT INTO order_status_transition VALUES
        ('draft', 'submitted'),
        ('submitted', 'approved'),
        ('submitted', 'rejected'),
        ('approved', 'shipped'),
        ('shipped', 'delivered'),
        ('approved', 'cancelled')
    ON CONFLICT DO NOTHING;

    CREATE OR REPLACE FUNCTION tg_order_status_transition_check()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            IF NOT EXISTS (
                SELECT 1 FROM order_status_transition
                WHERE from_status = OLD.status AND to_status = NEW.status
            ) THEN
                RAISE EXCEPTION 'invalid order status transition: % -> %',
                        OLD.status, NEW.status
                    USING ERRCODE = 'P0005';
            END IF;
        END IF;
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER order_status_must_follow_transition_table
        BEFORE UPDATE OF status ON orders
        FOR EACH ROW EXECUTE FUNCTION tg_order_status_transition_check();

The reference table makes valid transitions data, not code — easy to inspect, easy to extend.

## Audit Row Generation

Generate audit rows from `AFTER INSERT/UPDATE/DELETE`:

    CREATE OR REPLACE FUNCTION tg_customer_audit()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO customer_audit(
            customer_no, action, changed_by, changed_at, before_data, after_data
        ) VALUES (
            COALESCE(NEW.customer_no, OLD.customer_no),
            TG_OP,
            fn_current_app_user_id(),
            clock_timestamp(),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END
        );
        RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE TRIGGER customer_audit
        AFTER INSERT OR UPDATE OR DELETE ON customer
        FOR EACH ROW EXECUTE FUNCTION tg_customer_audit();

`TG_OP` is `'INSERT'`, `'UPDATE'`, or `'DELETE'`. `to_jsonb(NEW)` snapshots the row.

## DEFERRABLE Constraints for Ordering

Some validations only make sense after a multi-statement operation completes (e.g., circular references). Use `DEFERRABLE INITIALLY DEFERRED`:

    ALTER TABLE order_line ADD CONSTRAINT order_line_belongs_to_order
        FOREIGN KEY (customer_no, order_no)
        REFERENCES orders(customer_no, order_no)
        DEFERRABLE INITIALLY DEFERRED;

Now FK validation runs at COMMIT, not after each statement. Use sparingly — deferred constraints can mask logic bugs because the failure surfaces far from the offending statement.

Trigger-based validation can be deferred similarly with `CONSTRAINT TRIGGER`:

    CREATE CONSTRAINT TRIGGER order_total_must_match_lines
        AFTER INSERT OR UPDATE ON order_line
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION tg_order_total_check();

## Naming and Granularity

| Object | Pattern | Example |
|--------|---------|---------|
| Trigger function | `tg_<subject>_<action>` | `tg_savings_account_check_type` |
| Trigger | `<subject>_<must|cannot>_<predicate>` | `savings_account_must_be_savings_type` |
| Audit trigger function | `tg_<subject>_audit` | `tg_customer_audit` |
| Audit trigger | `<subject>_audit` | `customer_audit` |

**Granularity:** prefer one trigger per business rule rather than one mega-trigger that checks everything. Easier to debug when one rule fails, easier to disable selectively, and the trigger name tells you exactly what was violated.

**One DML statement per function.** If a trigger function would do more than one INSERT/UPDATE/DELETE, extract the additional work into a separate function called by another trigger or by a procedure. Keeps each function's intent readable.

# Procedure Structure


Postgres distinguishes **PROCEDUREs** (can `COMMIT`/`ROLLBACK` inside; cannot be called from within an explicit transaction) from **FUNCTIONs** (always run inside a transaction; cannot `COMMIT`/`ROLLBACK`). Postgres's transaction model enforces most boundaries naturally.

## Table of Contents

- [The One Rule: No Nested Transactions](#the-one-rule-no-nested-transactions)
- [PROCEDURE — Mutations With Transaction Control](#procedure--mutations-with-transaction-control)
- [FUNCTION — Reads and Pure Computations](#function--reads-and-pure-computations)
- [The 4-Block Structure](#the-4-block-structure)
- [EXCEPTION Block Patterns](#exception-block-patterns)
- [SAVEPOINT for Selective Rollback](#savepoint-for-selective-rollback)
- [AddOrModify with INSERT ... ON CONFLICT](#addormodify-with-insert--on-conflict)
- [Naming and Verbs](#naming-and-verbs)

---

## The One Rule: No Nested Transactions

Never wrap one explicit `BEGIN` inside another. Postgres prevents most accidental nesting at the engine layer:

- A PROCEDURE that does `COMMIT`/`ROLLBACK` cannot be called from within an explicit transaction — Postgres errors with `2D000`.
- `BEGIN` inside `BEGIN` (in psql or a session) issues a warning ("there is already a transaction in progress") and ignores the inner one.

What's left to enforce: top-level operations that *assume* they own their transaction. Use a small assertion helper:

    CREATE OR REPLACE FUNCTION fn_assert_not_in_transaction()
    RETURNS VOID AS $$
    BEGIN
        IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
            RAISE EXCEPTION 'must not be called inside an explicit transaction'
                USING ERRCODE = 'P0012';
        END IF;
    END;
    $$ LANGUAGE plpgsql;

Call at the top of any PROCEDURE that owns its transaction:

    CREATE OR REPLACE PROCEDURE pr_transfer_funds(...)
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();
        -- ... rest of procedure
    END;
    $$;

For selective rollback within a single logical unit, use `SAVEPOINT` — never a nested `BEGIN`.

## PROCEDURE — Mutations With Transaction Control

Use a PROCEDURE when you need:

- Multiple statements that must commit atomically
- Explicit `COMMIT`/`ROLLBACK` mid-procedure (long-running batch jobs)
- Multi-table coordination

A PROCEDURE is invoked with `CALL`, not `SELECT`:

    CREATE OR REPLACE PROCEDURE pr_transfer_funds(
        p_from_account_no  account_no,
        p_to_account_no    account_no,
        p_amount           money_amount
    )
    LANGUAGE plpgsql AS $$
    DECLARE
        v_from_balance money_amount;
    BEGIN
        -- BLOCK 1: GUARD
        PERFORM fn_assert_not_in_transaction();

        IF p_from_account_no IS NULL OR p_to_account_no IS NULL THEN
            RAISE EXCEPTION 'account numbers required'
                USING ERRCODE = 'P0001';
        END IF;

        IF p_amount <= 0 THEN
            RAISE EXCEPTION 'amount must be positive'
                USING ERRCODE = 'P0001';
        END IF;

        -- BLOCK 2: VALIDATE STATE
        SELECT balance INTO v_from_balance
        FROM account WHERE account_no = p_from_account_no
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'source account not found: %', p_from_account_no
                USING ERRCODE = 'P0002';
        END IF;

        IF v_from_balance < p_amount THEN
            RAISE EXCEPTION 'insufficient funds'
                USING ERRCODE = 'P0005';
        END IF;

        -- BLOCK 3: APPLY
        UPDATE account SET balance = balance - p_amount
        WHERE account_no = p_from_account_no;

        UPDATE account SET balance = balance + p_amount
        WHERE account_no = p_to_account_no;

        INSERT INTO ledger_entry(from_account_no, to_account_no, amount)
        VALUES (p_from_account_no, p_to_account_no, p_amount);

        -- BLOCK 4: COMMIT
        COMMIT;

    EXCEPTION WHEN OTHERS THEN
        ROLLBACK;
        RAISE;  -- re-raise so caller sees the error
    END;
    $$;

## FUNCTION — Reads and Pure Computations

Use a FUNCTION when:

- Returning data (scalar, table, set)
- Pure computation (no DML)
- Trigger logic (always functions)
- Validation helpers called from triggers or procedures

FUNCTIONs always run in a transaction (the caller's, or implicit if invoked bare). They cannot `COMMIT`/`ROLLBACK`.

    CREATE OR REPLACE FUNCTION fn_find_customer_by_email(p_email email)
    RETURNS customer
    LANGUAGE plpgsql STABLE AS $$
    DECLARE
        v_row customer;
    BEGIN
        SELECT * INTO v_row FROM customer WHERE email = p_email;
        RETURN v_row;  -- NULL row if not found; caller can NULL-check
    END;
    $$;

**Volatility hints** (`IMMUTABLE`, `STABLE`, `VOLATILE`) help the planner. Use:

- `IMMUTABLE` — same input always produces same output, no I/O (e.g., math, string formatting)
- `STABLE` — no DML, results may change across statements but not within one (e.g., reads from tables)
- `VOLATILE` — default; anything else (DML, `clock_timestamp()`, `random()`)

## The 4-Block Structure

Every PROCEDURE follows the same shape:

1. **GUARD** — `fn_assert_not_in_transaction()`, NULL checks, type checks, simple input validation. Fail fast with `P0001`.
2. **VALIDATE STATE** — read current state under appropriate locks (`FOR UPDATE`, `FOR SHARE`); raise `P0002`/`P0005` if state precludes the operation.
3. **APPLY** — DML statements that change state. Each `UPDATE`/`DELETE` should be checked with `IF NOT FOUND THEN ...` if the row count matters.
4. **COMMIT** — explicit `COMMIT` (PROCEDUREs only). Wrap the whole body in `EXCEPTION WHEN OTHERS THEN ROLLBACK; RAISE;` for safety.

FUNCTIONs follow the same logical flow but skip the COMMIT block — the caller's transaction handles that.

## EXCEPTION Block Patterns

Postgres has no `GOTO`. Errors flow through `EXCEPTION WHEN ... THEN` clauses, which roll back the surrounding subtransaction automatically.

**Catch by SQLSTATE:**

    EXCEPTION
        WHEN unique_violation THEN
            RAISE EXCEPTION 'email already taken'
                USING ERRCODE = 'P0003';
        WHEN foreign_key_violation THEN
            RAISE EXCEPTION 'referenced record does not exist'
                USING ERRCODE = 'P0002';

**Catch by custom code:**

    EXCEPTION
        WHEN SQLSTATE 'P0010' THEN
            -- type discriminator mismatch — translate or re-raise
            RAISE;

**Catch all (use sparingly):**

    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_msg   = MESSAGE_TEXT;
        INSERT INTO error_log(sqlstate, message, occurred_at)
            VALUES (v_state, v_msg, clock_timestamp());
        RAISE;  -- always re-raise unless you have a real reason to swallow

**Rule of thumb:** EXCEPTION is for *handling* errors — translating, logging, rolling back. Don't use it as a substitute for `IF` checks. Validation belongs in the GUARD/VALIDATE blocks with explicit `RAISE EXCEPTION ... USING ERRCODE = ...`.

## SAVEPOINT for Selective Rollback

When part of a procedure may fail and you want to continue the rest:

    BEGIN
        -- main work
        INSERT INTO order_line(...) VALUES (...);

        -- optional side effect
        SAVEPOINT try_audit;
        BEGIN
            INSERT INTO audit_log(...) VALUES (...);
        EXCEPTION WHEN OTHERS THEN
            ROLLBACK TO SAVEPOINT try_audit;
            -- log and continue; main work is preserved
        END;

        COMMIT;
    END;

This is the *only* legitimate form of nested transaction-like behavior. SAVEPOINTs are not a nested `BEGIN` — they're a checkpoint within the current transaction.

## AddOrModify with INSERT ... ON CONFLICT

Use `INSERT ... ON CONFLICT` (UPSERT) for idempotent merges:

    CREATE OR REPLACE PROCEDURE pr_add_or_modify_customer(
        p_email      email,
        p_full_name  full_name
    )
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();

        INSERT INTO customer(email, full_name)
        VALUES (p_email, p_full_name)
        ON CONFLICT (email) DO UPDATE
            SET full_name = EXCLUDED.full_name,
                updated_at = clock_timestamp();

        COMMIT;
    EXCEPTION WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
    END;
    $$;

`EXCLUDED` references the row that *would have been* inserted. Prefer one `pr_add_or_modify_*` procedure over separate `pr_add_*` and `pr_modify_*` procedures when the operation is naturally idempotent.

## Naming and Verbs

| Pattern | Use |
|---------|-----|
| `pr_add_<entity>` | INSERT-only procedure |
| `pr_modify_<entity>` | UPDATE-only procedure |
| `pr_remove_<entity>` | DELETE-only procedure |
| `pr_add_or_modify_<entity>` | UPSERT procedure (preferred over add+modify pair) |
| `fn_find_<entity>` | SELECT function returning row(s) |
| `fn_next_<scope>_no` | Sequence/max-plus-one helper function |
| `tg_<subject>_<rule>` | Trigger function (called by trigger, not directly) |
| `fn_assert_<condition>` | Guard function — raises if condition is false |

Avoid SQL keyword verbs (`create`, `update`, `delete`, `select`) — they collide with statement keywords in error logs and grep.

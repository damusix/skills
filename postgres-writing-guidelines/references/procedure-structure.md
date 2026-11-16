# Procedure Structure


Postgres distinguishes **PROCEDUREs** (can `COMMIT`/`ROLLBACK`, but only when `CALL` runs in its own transaction) from **FUNCTIONs** (always run inside a transaction; cannot `COMMIT`/`ROLLBACK`). By default a procedure leaves the transaction to its caller: it does the work, raises on failure, and the caller's transaction rolls back.

## Table of Contents

- [The One Rule: No Nested Transactions](#the-one-rule-no-nested-transactions)
- [PROCEDURE — Mutations With Transaction Control](#procedure--mutations-with-transaction-control)
- [FUNCTION — Reads and Pure Computations](#function--reads-and-pure-computations)
- [The 4-Block Structure](#the-4-block-structure)
- [EXCEPTION Block Patterns](#exception-block-patterns)
- [Selective Rollback with a Nested Block](#selective-rollback-with-a-nested-block)
- [AddOrModify with INSERT ... ON CONFLICT](#addormodify-with-insert--on-conflict)
- [Naming and Verbs](#naming-and-verbs)

---

## The One Rule: No Nested Transactions

Never wrap one explicit `BEGIN` inside another. Postgres prevents most accidental nesting at the engine layer:

- A PROCEDURE that runs `COMMIT`/`ROLLBACK` while `CALL` is inside an explicit transaction block fails at that statement with `2D000` (`invalid_transaction_termination`). Transaction control works only when `CALL` runs in its own transaction, or under a chain of `CALL`/`DO` with no other command in between.
- `BEGIN` inside `BEGIN` (in psql or a session) issues a warning ("there is already a transaction in progress") and ignores the inner one.
- A PL/pgSQL block with an `EXCEPTION` clause runs as a subtransaction, so `COMMIT` or `ROLLBACK` inside it fails.

Most procedures never end the transaction, so a caller can run them anywhere. A batch procedure that commits between chunks must be called outside an explicit transaction. PostgreSQL enforces this at the first `COMMIT` with `2D000`, so the procedure needs no guard of its own:

    CREATE OR REPLACE PROCEDURE pr_archive_old_orders(p_batch_size integer)
    LANGUAGE plpgsql AS $$
    BEGIN
        -- ... loop: archive one batch, then COMMIT (outside any EXCEPTION block)
    END;
    $$;

    CALL pr_archive_old_orders(1000);  -- top level, not inside BEGIN

For selective rollback within a single logical unit, use a nested `BEGIN ... EXCEPTION ... END` block, never a second transaction. PL/pgSQL has no `SAVEPOINT` command; `SAVEPOINT` works only in client-side SQL sessions.

## PROCEDURE — Mutations With Transaction Control

Use a PROCEDURE when you need:

- Multiple statements that must commit atomically
- Explicit `COMMIT`/`ROLLBACK` mid-procedure (long-running batch jobs)
- Multi-table coordination

A PROCEDURE is invoked with `CALL`, not `SELECT`. This one does not commit: a bare `CALL` runs in its own implicit transaction, and a caller can wrap several calls in one `BEGIN`/`COMMIT`. Any raised error rolls back the whole transaction:

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
        IF p_from_account_no IS NULL OR p_to_account_no IS NULL THEN
            RAISE EXCEPTION 'account numbers required'
                USING ERRCODE = 'Z0001';
        END IF;

        IF p_from_account_no = p_to_account_no THEN
            RAISE EXCEPTION 'source and destination accounts must differ'
                USING ERRCODE = 'Z0001';
        END IF;

        IF p_amount <= 0 THEN
            RAISE EXCEPTION 'amount must be positive'
                USING ERRCODE = 'Z0001';
        END IF;

        -- BLOCK 2: VALIDATE STATE
        -- Lock both rows in account_no order so opposite-direction transfers cannot deadlock.
        PERFORM 1 FROM account
        WHERE account_no IN (p_from_account_no, p_to_account_no)
        ORDER BY account_no
        FOR UPDATE;

        SELECT balance INTO v_from_balance
        FROM account WHERE account_no = p_from_account_no;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'source account not found: %', p_from_account_no
                USING ERRCODE = 'Z0002';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM account WHERE account_no = p_to_account_no) THEN
            RAISE EXCEPTION 'destination account not found: %', p_to_account_no
                USING ERRCODE = 'Z0002';
        END IF;

        IF v_from_balance < p_amount THEN
            RAISE EXCEPTION 'insufficient funds'
                USING ERRCODE = 'Z0005';
        END IF;

        -- BLOCK 3: APPLY
        UPDATE account SET balance = balance - p_amount
        WHERE account_no = p_from_account_no;

        UPDATE account SET balance = balance + p_amount
        WHERE account_no = p_to_account_no;

        INSERT INTO ledger_entry(from_account_no, to_account_no, amount)
        VALUES (p_from_account_no, p_to_account_no, p_amount);
    END;
    $$;

    CALL pr_transfer_funds(1001, 1002, 250.00);

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

1. **GUARD** — NULL checks, type checks, simple input validation. Fail fast with `Z0001`.
2. **VALIDATE STATE** — read current state under appropriate locks (`FOR UPDATE`, `FOR SHARE`); raise `Z0002`/`Z0005` if state precludes the operation.
3. **APPLY** — DML statements that change state. Each `UPDATE`/`DELETE` should be checked with `IF NOT FOUND THEN ...` if the row count matters.
4. **COMMIT** — usually absent. The caller owns the transaction, and a raised error rolls it back. Only a procedure that deliberately owns batch boundaries (a long-running batch that commits per chunk) calls `COMMIT`, is called outside an explicit transaction, and keeps every `COMMIT` outside any block with an `EXCEPTION` clause.

Never wrap a body in `EXCEPTION WHEN OTHERS THEN ROLLBACK; RAISE;`. The `ROLLBACK` fails inside an exception block. Without the `ROLLBACK`, the handler re-raises an error that would propagate anyway, and adds a subtransaction to every call.

FUNCTIONs follow the same logical flow and never commit.

## EXCEPTION Block Patterns

Postgres has no `GOTO`. Errors flow through `EXCEPTION WHEN ... THEN` clauses, which roll back the surrounding subtransaction automatically.

**Catch by SQLSTATE:**

    EXCEPTION
        WHEN unique_violation THEN
            RAISE EXCEPTION 'email already taken'
                USING ERRCODE = 'Z0003';
        WHEN foreign_key_violation THEN
            RAISE EXCEPTION 'referenced record does not exist'
                USING ERRCODE = 'Z0002';

**Catch by custom code:**

    EXCEPTION
        WHEN SQLSTATE 'Z0010' THEN
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

The re-raise aborts the transaction, so the `error_log` row rolls back with it unless an outer caller catches the error. For a log that survives, use `RAISE LOG` or `RAISE WARNING` and let the server log carry it.

**Rule of thumb:** EXCEPTION is for *handling* errors: translating, logging, undoing a nested block's work. Don't use it as a substitute for `IF` checks. Validation belongs in the GUARD/VALIDATE blocks with explicit `RAISE EXCEPTION ... USING ERRCODE = ...`.

## Selective Rollback with a Nested Block

When part of a procedure may fail and you want to continue the rest, put that part in a nested block with its own `EXCEPTION` clause. Postgres opens a subtransaction when the block starts. On an error it undoes only that block's work, then runs the handler:

    BEGIN
        -- main work
        INSERT INTO order_line(...) VALUES (...);

        -- optional side effect
        BEGIN
            INSERT INTO audit_log(...) VALUES (...);
        EXCEPTION WHEN unique_violation THEN
            RAISE WARNING 'audit insert skipped: %', SQLERRM;
            -- main work is preserved
        END;
    END;

This is the only legitimate form of nested transaction-like behavior in PL/pgSQL. The nested block is not a second transaction, so it cannot `COMMIT` or `ROLLBACK`. Catch the specific condition you expect; `WHEN OTHERS` here would also hide bugs in the side effect. In a client-side SQL session, `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` does the same job; PL/pgSQL does not accept those commands.

## AddOrModify with INSERT ... ON CONFLICT

Use `INSERT ... ON CONFLICT` (UPSERT) for idempotent merges:

    CREATE OR REPLACE PROCEDURE pr_add_or_modify_customer(
        p_email      email,
        p_full_name  full_name
    )
    LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO customer(email, full_name)
        VALUES (p_email, p_full_name)
        ON CONFLICT (email) DO UPDATE
            SET full_name = EXCLUDED.full_name,
                updated_at = clock_timestamp();
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

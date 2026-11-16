# Error Handling


PL/pgSQL has no `GOTO`. Errors flow through `EXCEPTION WHEN ... THEN` blocks, which automatically roll back the enclosing subtransaction. For client-parseable errors, raise with explicit SQLSTATE codes from a versioned catalog so client applications can match on the code rather than the message.

## Table of Contents

- [Why Custom Error Codes Are Worth It](#why-custom-error-codes-are-worth-it)
- [SQLSTATE Format](#sqlstate-format)
- [The Error Code Catalog](#the-error-code-catalog)
- [RAISE EXCEPTION Syntax](#raise-exception-syntax)
- [Catching Specific Conditions](#catching-specific-conditions)
- [GET STACKED DIAGNOSTICS](#get-stacked-diagnostics)
- [Re-Raising vs Translating](#re-raising-vs-translating)
- [The Anti-Pattern: WHEN OTHERS](#the-anti-pattern-when-others)

---

## Why Custom Error Codes Are Worth It

Postgres's native errors carry SQLSTATE codes (`23505` for `unique_violation`, `23503` for `foreign_key_violation`, etc.) which clients can match. But native codes describe the *mechanism*, not the *business rule*. A `23505` could mean "email already taken" or "username already taken" or "API key collision" — the client can't tell.

Custom codes give you a parseable contract:

    -- Server side
    RAISE EXCEPTION 'email already taken: %', new_email
        USING ERRCODE = 'Z0003';

    -- Client side (Node example)
    catch (err) {
        if (err.code === 'Z0003') return showError('That email is taken');
    }

The catalog is a versioned constants document — no runtime registration needed.

## SQLSTATE Format

SQLSTATE is exactly **5 alphanumeric characters**. The first two characters are the *class*; the last three the *subclass*.

- The SQL standard defines classes starting with `0`–`4` or `A`–`H`. Classes starting with `5`–`9` or `I`–`Z` are left to implementations.
- Postgres defines its own codes in several implementation classes (`53`, `54`, `55`, `57`, `58`, `P0`, `XX`). It defines no class `Z` codes.
- Class `P0` is **PL/pgSQL's own**: `P0000` `plpgsql_error`, `P0001` `raise_exception` (the default for a bare `RAISE EXCEPTION`), `P0002` `no_data_found`, `P0003` `too_many_rows`, `P0004` `assert_failure`.

Application codes use class `Z0`, not `P0`. A `P0` code collides with native errors: `WHEN SQLSTATE 'P0002'` also catches a `SELECT INTO STRICT` that found no row, and a client matching `'P0001'` also catches every `RAISE EXCEPTION` that set no code.

Use `Z0001`–`Z0999` for application errors.

## The Error Code Catalog

Maintain a single source of truth (e.g., `errors.yaml`) shared by server and client:

| Code | Name | Meaning |
|------|------|---------|
| `Z0001` | `INVALID_INPUT` | Caller passed malformed or missing required input |
| `Z0002` | `NOT_FOUND` | Referenced entity does not exist |
| `Z0003` | `DUPLICATE_KEY` | Unique constraint conflict at the application level |
| `Z0004` | `FORBIDDEN` | Caller lacks permission for this operation |
| `Z0005` | `STATE_CONFLICT` | Operation invalid in current entity state |
| `Z0006` | `RATE_LIMITED` | Caller exceeded a rate limit |
| `Z0007` | `EXTERNAL_FAILURE` | A non-transient external service call failed |
| `Z0010` | `TYPE_DISCRIMINATOR_MISMATCH` | Subtype FK references a base row of the wrong type |
| `Z0011` | `TRANSACTION_REQUIRED` | Caller must be inside an explicit transaction |
| `Z0013` | `OPTIMISTIC_LOCK_LOST` | Row was modified between read and write |
| `Z0014` | `WORKER_RETRY_EXHAUSTED` | Background job exceeded max attempts |

Generate the constants file from this manifest at deploy time so server and client stay in sync.

## RAISE EXCEPTION Syntax

    RAISE EXCEPTION '<format string>', <arg1>, <arg2>, ...
        USING
            ERRCODE = '<sqlstate>',
            DETAIL  = '<extra context>',
            HINT    = '<actionable suggestion>',
            COLUMN  = '<offending column>',
            TABLE   = '<offending table>';

Example:

    RAISE EXCEPTION 'cannot transition order % from % to %',
            p_order_no, v_current_status, p_new_status
        USING
            ERRCODE = 'Z0005',
            DETAIL  = format('valid transitions from %s: %s',
                             v_current_status, v_valid_targets),
            HINT    = 'check order_status_transitions reference table';

`%` placeholders are positional; cast non-text args with `format()` if you need control. `DETAIL` and `HINT` show up in client error objects but are advisory — clients should match on `ERRCODE`, not parse messages.

## Catching Specific Conditions

Catch by named condition (preferred for built-in SQLSTATEs):

    EXCEPTION
        WHEN unique_violation THEN
            RAISE EXCEPTION 'email already taken'
                USING ERRCODE = 'Z0003';
        WHEN foreign_key_violation THEN
            RAISE EXCEPTION 'referenced record does not exist'
                USING ERRCODE = 'Z0002';
        WHEN check_violation THEN
            RAISE EXCEPTION 'value violates a check constraint'
                USING ERRCODE = 'Z0001';

Catch by SQLSTATE (required for custom `Z0...` codes):

    EXCEPTION
        WHEN SQLSTATE 'Z0010' THEN
            -- type discriminator mismatch: log to the server log and re-raise
            RAISE LOG 'type discriminator mismatch: %', SQLERRM;
            RAISE;

Catch multiple in one block:

    EXCEPTION
        WHEN unique_violation OR check_violation THEN
            RAISE EXCEPTION 'invalid data'
                USING ERRCODE = 'Z0001';

## GET STACKED DIAGNOSTICS

Inside an EXCEPTION block, retrieve full error context:

    EXCEPTION WHEN OTHERS THEN
        DECLARE
            v_state TEXT;
            v_msg   TEXT;
            v_detail TEXT;
            v_hint  TEXT;
            v_context TEXT;
        BEGIN
            GET STACKED DIAGNOSTICS
                v_state   = RETURNED_SQLSTATE,
                v_msg     = MESSAGE_TEXT,
                v_detail  = PG_EXCEPTION_DETAIL,
                v_hint    = PG_EXCEPTION_HINT,
                v_context = PG_EXCEPTION_CONTEXT;

            INSERT INTO error_log(sqlstate, message, detail, hint, context, occurred_at)
            VALUES (v_state, v_msg, v_detail, v_hint, v_context, clock_timestamp());

            RAISE;  -- re-raise so caller still sees the error
        END;

Use this when you need structured error data before re-raising. The `error_log` row survives only if an outer caller catches the error; if the error reaches the top level, the transaction aborts and the row rolls back. `PG_EXCEPTION_CONTEXT` includes the call stack — invaluable for debugging trigger chains.

## Re-Raising vs Translating

**Re-raise** when you've handled the side effect (logging, cleanup) but the caller still needs to know:

    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'job % failed: %', p_job_id, SQLERRM;
        RAISE;  -- caller sees the original error

Do not put `ROLLBACK` in a handler: a block with an `EXCEPTION` clause is a subtransaction, and ending the transaction inside it fails. Rows a handler inserts before `RAISE` roll back with the aborted transaction, so a durable failure record belongs in the server log (`RAISE WARNING`/`RAISE LOG`) or in the caller, after its own rollback.

**Translate** when you want to give the caller a more meaningful error than Postgres's native one:

    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'an account with email % already exists', p_email
            USING ERRCODE = 'Z0003';

`RAISE` with no arguments re-raises the current exception unchanged. Translation always uses `RAISE EXCEPTION ... USING ERRCODE = ...` with a fresh code.

## The Anti-Pattern: WHEN OTHERS

`EXCEPTION WHEN OTHERS THEN ...` catches *everything*, including bugs you'd want to surface. Three rules:

1. **Always re-raise** unless you have a documented reason not to. Swallowing exceptions hides bugs.
2. **Don't use it as control flow.** If you're catching `OTHERS` to handle a known case, you should be catching the specific condition instead. Validation belongs in `IF` checks before the operation.
3. **Reserve for genuinely unexpected failures** — usually paired with logging diagnostic info (`GET STACKED DIAGNOSTICS`) before re-raising.

Wrong:

    -- Using exceptions as control flow
    BEGIN
        INSERT INTO customer(email) VALUES (p_email);
    EXCEPTION WHEN unique_violation THEN
        UPDATE customer SET ... WHERE email = p_email;
    END;

Right:

    INSERT INTO customer(email) VALUES (p_email)
    ON CONFLICT (email) DO UPDATE SET ...;

The native ON CONFLICT path is faster and clearer. Reach for EXCEPTION only when no native construct expresses the intent.

# Error Handling


Procedures use GOTO-based error flow with structured error codes. Every failure has an explicit, labeled exit path — no hidden control flow, no exception swallowing.

## Table of Contents

- [Philosophy](#philosophy)
- [DML Error Checking](#dml-error-checking)
- [Structured Error Codes](#structured-error-codes)
- [RAISERROR Patterns](#raiserror-patterns)

---

## Philosophy

Procedures only perform **deterministic, local operations** — table reads, writes, and checks fully within the database's control. These operations don't "try" to succeed; they either do or they don't, and we check the result immediately with `@@ROWCOUNT` and `@@ERROR`.

**TRY-CATCH is reserved exclusively for non-deterministic operations** — like an HTTP request from SQL Server that depends on a network service. Even then, it's discouraged. If there is a failure, exit early. Don't swallow errors, don't retry silently, don't mask what happened.

GOTO gives you explicit, visible control flow. Every error path is a labeled jump target. There's no hidden control flow, no ambiguity about what gets rolled back. The procedure reads top-to-bottom with clear exit points.

---

## DML Error Checking

After every DML statement, immediately capture and check:

    SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

    IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
    IF (@RowCnt = 0) BEGIN
        RAISERROR(50005, 16, 1, 'CloseAccount_trx: Account');
        GOTO EXIT_TRANSACTION;
    END

`@@ROWCOUNT` and `@@ERROR` are reset by any statement — including `SET`, which resets `@@ERROR` to 0 on success. A single `SELECT` captures both atomically before either is lost.

**Row count expectations by operation:**
- **INSERT single row**: expect `@RowCnt = 1`, error with 50004 (EXIT_NOT_ADDED)
- **UPDATE**: expect `@RowCnt > 0` (or `= 1` for single-row), error with 50005 (EXIT_NOT_MODIFIED)
- **DELETE**: expect `@RowCnt > 0` (or `= 1` for single-row), error with 50006 (EXIT_NOT_REMOVED)

---

## Structured Error Codes

A catalog of semantic error codes registered via `sp_addmessage`. These are designed to be **parsable by client applications** — each error explicitly names what went wrong so upstream code can match on the error number and present meaningful feedback without guessing.

| Code | Name | Message pattern |
|------|------|----------------|
| 50001 | EXIT_ERROR | An error occurred (%s). %s |
| 50002 | EXIT_NO_DATA | No data was provided to %s. %s |
| 50003 | EXIT_NOT_FOUND | A required record %s was not found. %s |
| 50004 | EXIT_NOT_ADDED | No data was added into %s when intended. %s |
| 50005 | EXIT_NOT_MODIFIED | Nothing was modified in %s when intended. %s |
| 50006 | EXIT_NOT_REMOVED | Nothing was removed from %s when intended. %s |
| 50007 | EXIT_CANT_ADD | Cannot add %s. %s |
| 50008 | EXIT_CANT_MODIFY | Cannot modify %s. %s |
| 50009 | EXIT_CANT_REMOVE | Cannot remove %s. %s |
| 50010 | EXIT_BAD_DATA | Bad data, %s. %s |
| 50011 | EXIT_MODIFIED_ELSEWHERE | %s was modified elsewhere. %s |
| 50012 | EXIT_TRANCOUNT | Cannot run %s inside of an open transaction. %s |
| 50013 | EXIT_NO_TRANCOUNT | Cannot run %s outside of an open transaction. %s |
| 50014 | EXIT_PERMISSION | User does not have permission on %s. (%s %s %s) |

The first `%s` is always the procedure name (with optional context after a colon). The second `%s` is an optional variable for additional detail.

---

## RAISERROR Patterns

    -- Simple: just the procedure name
    RAISERROR(50002, 16, 1, 'TransferFunds_trx');

    -- With context: procedure name + what's missing
    RAISERROR(50002, 16, 1, 'TransferFunds_trx: FromAccountNo');

    -- With variable: procedure name + dynamic detail
    RAISERROR(50005, 16, 1, 'TransferFunds_trx: Account', @AccountNo);

These errors are not project-specific — they are a reusable catalog. Build yours to match your system's failure modes, but the principle holds: every error should have a number, a name, and a structured message that both humans and code can consume.

---

## See Also

- [Procedure Structure](procedure-structure.md) — the `_trx` / `_utx` templates where GOTO error flow and DML checks are used

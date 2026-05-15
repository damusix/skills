# Procedures (CREATE PROCEDURE, CALL, transaction control)

PostgreSQL procedures, `CALL`, and the embedded `COMMIT` / `ROLLBACK` discipline that distinguishes them from functions.


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The one-line summary: procedures vs functions](#the-one-line-summary-procedures-vs-functions)
    - [CREATE PROCEDURE grammar](#create-procedure-grammar)
    - [LANGUAGE choices for procedures](#language-choices-for-procedures)
    - [Argument modes (IN / OUT / INOUT / VARIADIC)](#argument-modes-in--out--inout--variadic)
    - [Default argument values](#default-argument-values)
    - [SECURITY DEFINER vs SECURITY INVOKER](#security-definer-vs-security-invoker)
    - [SET configuration parameters](#set-configuration-parameters)
    - [BEGIN ATOMIC bodies (PG14+)](#begin-atomic-bodies-pg14)
    - [ALTER PROCEDURE and DROP PROCEDURE](#alter-procedure-and-drop-procedure)
    - [CALL — invocation grammar](#call--invocation-grammar)
    - [Calling a procedure from PL/pgSQL](#calling-a-procedure-from-plpgsql)
    - [Procedure attributes that don't apply (vs functions)](#procedure-attributes-that-dont-apply-vs-functions)
    - [Default privileges and PUBLIC EXECUTE](#default-privileges-and-public-execute)
    - [Lock-level summary for procedure DDL](#lock-level-summary-for-procedure-ddl)
- [Transaction control inside procedures](#transaction-control-inside-procedures)
    - [The four legal commands](#the-four-legal-commands)
    - [Where transaction control is *not* allowed](#where-transaction-control-is-not-allowed)
    - [What happens to the snapshot on COMMIT](#what-happens-to-the-snapshot-on-commit)
    - [Cursor loops and the holdable-cursor surprise](#cursor-loops-and-the-holdable-cursor-surprise)
- [Examples / Recipes](#examples--recipes)
    - [Recipe 1 — Chunked DML with periodic COMMIT](#recipe-1--chunked-dml-with-periodic-commit)
    - [Recipe 2 — Procedure with OUT parameters (PG14+)](#recipe-2--procedure-with-out-parameters-pg14)
    - [Recipe 3 — Multi-step batch with checkpoint COMMITs](#recipe-3--multi-step-batch-with-checkpoint-commits)
    - [Recipe 4 — COMMIT AND CHAIN to preserve isolation](#recipe-4--commit-and-chain-to-preserve-isolation)
    - [Recipe 5 — SECURITY DEFINER procedure that pins search_path](#recipe-5--security-definer-procedure-that-pins-search_path)
    - [Recipe 6 — Procedure as the orchestrator, functions as the building blocks](#recipe-6--procedure-as-the-orchestrator-functions-as-the-building-blocks)
    - [Recipe 7 — Partition rotation procedure](#recipe-7--partition-rotation-procedure)
    - [Recipe 8 — Idempotent CREATE OR REPLACE PROCEDURE boilerplate](#recipe-8--idempotent-create-or-replace-procedure-boilerplate)
    - [Recipe 9 — Calling a procedure from psql vs from a function (the trap)](#recipe-9--calling-a-procedure-from-psql-vs-from-a-function-the-trap)
    - [Recipe 10 — Inspecting all procedures with their attributes](#recipe-10--inspecting-all-procedures-with-their-attributes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Use this file when:

- You need a routine that **commits or rolls back transactions mid-execution** (chunked bulk DML, multi-step batch jobs, scheduled maintenance) — that requires a procedure, not a function.
- You need a routine that returns data via **`OUT` / `INOUT` parameters** (introduced for procedures in PostgreSQL 14[^pg14-out]).
- You are deciding **procedure vs function** for new code and need the contract sheet that separates them.
- You hit the error `invalid transaction termination` while trying to `COMMIT` inside a function, a `SECURITY DEFINER` procedure, a procedure with a `SET` clause, an `EXCEPTION` block, or a cursor loop over a non-read-only command.
- You need to call a procedure from PL/pgSQL and want the right `CALL ... INTO ...` form.
- You're scheduling a periodic job with [`pg_cron`](./98-pg-cron.md) and need to know whether to register a function or a procedure.

For function mechanics (mutability, parallel safety, polymorphic types, SQL-function inlining, `LEAKPROOF`, `COST`/`ROWS`, `STRICT`), see [`06-functions.md`](./06-functions.md). For PL/pgSQL block grammar — `DECLARE`, control flow, exception handling, dynamic SQL — see [`08-plpgsql.md`](./08-plpgsql.md). For transactions and isolation generally, see [`41-transactions.md`](./41-transactions.md) and [`42-isolation-levels.md`](./42-isolation-levels.md).


## Syntax / Mechanics


### The one-line summary: procedures vs functions

**Procedures can `COMMIT` and `ROLLBACK`. Functions cannot.** Everything else falls out of that single contract:

| Capability | Function | Procedure |
|---|---|---|
| Invocation form | inside `SELECT` / DML | `CALL name(...)` standalone |
| Returns | scalar / `SETOF` / `TABLE` | `OUT`/`INOUT` parameters only (PG14+)[^pg14-out] |
| `RETURNS` clause | yes | **no** (omitted by grammar)[^xproc] |
| Can `COMMIT` / `ROLLBACK` | **no** | yes — top-level only[^plpgsql-tx] |
| Volatility (`VOLATILE`/`STABLE`/`IMMUTABLE`) | yes | not applicable[^xproc] |
| Parallel safety | yes | not applicable |
| `STRICT` / `CALLED ON NULL INPUT` | yes | not applicable[^xproc] |
| `LEAKPROOF` | yes (planner-relevant) | not applicable |
| `COST` / `ROWS` | yes | not applicable |
| `SECURITY DEFINER` / `INVOKER` | yes | yes (but **disables** transaction control)[^createproc] |
| `SET configuration_parameter` | yes | yes (but **disables** transaction control)[^createproc] |
| Usable in expressions | yes | no |
| Usable in index expressions | yes (`IMMUTABLE` only) | no |

> [!NOTE] PostgreSQL 11
> Procedures and `CALL` were introduced in PostgreSQL 11 along with transaction control inside server-side languages (PL/pgSQL, PL/Perl, PL/Python, PL/Tcl, SPI).[^pg11-proc]

> [!NOTE] PostgreSQL 14
> Procedures gained `OUT` parameters in PostgreSQL 14, allowing them to return data to their caller (previously only `INOUT` was usable for output).[^pg14-out]


### CREATE PROCEDURE grammar

The canonical grammar from the manual[^createproc]:

    CREATE [ OR REPLACE ] PROCEDURE
        name ( [ [ argmode ] [ argname ] argtype [ { DEFAULT | = } default_expr ] [, ...] ] )
      { LANGUAGE lang_name
        | TRANSFORM { FOR TYPE type_name } [, ... ]
        | [ EXTERNAL ] SECURITY INVOKER | [ EXTERNAL ] SECURITY DEFINER
        | SET configuration_parameter { TO value | = value | FROM CURRENT }
        | AS 'definition'
        | AS 'obj_file', 'link_symbol'
        | sql_body
      } ...

A minimal example:

    CREATE PROCEDURE refresh_dashboards()
    LANGUAGE plpgsql
    AS $$
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_daily;
        COMMIT;
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_traffic_daily;
        COMMIT;
    END;
    $$;

    CALL refresh_dashboards();

**`CREATE OR REPLACE PROCEDURE`** replaces the body of an existing procedure. Per the docs[^createproc]:

> *"To replace the current definition of an existing procedure, use `CREATE OR REPLACE PROCEDURE`. It is not possible to change the name or argument types of a procedure this way (if you tried, you would actually be creating a new, distinct procedure)."*

> *"When `CREATE OR REPLACE PROCEDURE` is used to replace an existing procedure, the ownership and permissions of the procedure do not change."*

To actually rename or reshape arguments, use `ALTER PROCEDURE ... RENAME TO ...` or `DROP PROCEDURE ...` + new `CREATE PROCEDURE`.


### LANGUAGE choices for procedures

| Language | Notes |
|---|---|
| `plpgsql` | The natural default. The only built-in language that combines control flow + transaction control elegantly. |
| `sql` | Procedures in SQL exist (with or without `BEGIN ATOMIC` — see below) but **cannot use `COMMIT` / `ROLLBACK`** because there is no procedural control flow. Use them for simple `CALL`-wrapped DML batches. |
| `plperl` / `plperlu` / `plpython3u` / `pltcl` / `pltclu` | All gained transaction control in PG11. Untrusted variants only. See [`09-procedural-languages.md`](./09-procedural-languages.md). |
| `c` | Same restrictions; transaction control via SPI. Advanced; see [`72-extension-development.md`](./72-extension-development.md). |

The default `LANGUAGE` is `sql` if a `sql_body` (`BEGIN ATOMIC ... END`) is given; otherwise specify it explicitly.[^createproc]


### Argument modes (IN / OUT / INOUT / VARIADIC)

| Mode | Direction | Notes |
|---|---|---|
| `IN` (default) | caller → procedure | the usual case |
| `OUT` | procedure → caller | PG14+ for procedures[^pg14-out]; column in the result row of `CALL` |
| `INOUT` | both | works pre-PG14; the only way to "return" anything from a procedure before PG14 |
| `VARIADIC` | caller → procedure | last parameter only; collects extra args into an array |

`CALL` requires you to **supply arguments for `OUT` parameters too**, but those expressions are not evaluated. Conventional usage is `NULL`[^callsql]:

> *"Arguments must be supplied for all procedure parameters that lack defaults, including OUT parameters. However, arguments matching OUT parameters are not evaluated, so it's customary to write `NULL` for them. (Writing something else for an OUT parameter might cause compatibility problems with future PostgreSQL versions.)"*

Example procedure with `OUT`:

    CREATE PROCEDURE compute_totals(
        IN  customer_id  bigint,
        OUT order_count  integer,
        OUT total_cents  bigint
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        SELECT count(*), sum(amount_cents)
        INTO order_count, total_cents
        FROM orders
        WHERE customer_id = compute_totals.customer_id;
    END;
    $$;

    -- psql:
    CALL compute_totals(42, NULL, NULL);
     order_count | total_cents
    -------------+-------------
              17 |      284990


### Default argument values

Same as functions — `DEFAULT expr` or `= expr`. Trailing arguments with defaults may be omitted at `CALL`-site:

    CREATE PROCEDURE archive_orders(cutoff date DEFAULT current_date - 90)
    LANGUAGE sql
    AS $$
        DELETE FROM orders WHERE created_at < cutoff;
    $$;

    CALL archive_orders();              -- uses default
    CALL archive_orders('2026-01-01');  -- override


### SECURITY DEFINER vs SECURITY INVOKER

Same flag meaning as functions: `SECURITY INVOKER` (default) runs as the caller; `SECURITY DEFINER` runs as the owner.

> [!WARNING] SECURITY DEFINER blocks COMMIT
> If you mark a procedure `SECURITY DEFINER`, any `COMMIT` or `ROLLBACK` inside it will fail at runtime with `invalid transaction termination`. The grammar accepts the combination at `CREATE PROCEDURE` time; the failure surfaces when you actually `CALL` it. To get both privileged execution and mid-procedure `COMMIT`, use a two-procedure pattern: a small `SECURITY DEFINER` outer procedure for privileged setup, and a separate non-`SECURITY DEFINER` worker procedure for the transactional loop.


### SET configuration parameters

`SET parameter = value` clauses on the procedure (e.g., `SET search_path = 'public, audit'`, `SET work_mem = '64MB'`) install a per-procedure GUC that is reverted at procedure exit.

**Like `SECURITY DEFINER`, attaching a `SET` clause disables transaction control inside the procedure**[^createproc]:

> *"If a `SET` clause is attached to a procedure, then that procedure cannot execute transaction control statements (for example, `COMMIT` and `ROLLBACK`, depending on the language)."*

This is the *single most surprising* procedure restriction. If you need a chunked-loop procedure that also pins `search_path`, do the `SET` **inside** the procedure body (e.g., `PERFORM set_config('search_path', 'audit, public', false);` once at entry) instead of using a `SET` clause on `CREATE PROCEDURE`.

There is a subtle interaction with `SET LOCAL` from within the procedure[^createproc]:

> *"If a `SET` clause is attached to a procedure, then the effects of a `SET LOCAL` command executed inside the procedure for the same variable are restricted to the procedure: the configuration parameter's prior value is still restored at procedure exit."*


### BEGIN ATOMIC bodies (PG14+)

> [!NOTE] PostgreSQL 14
> SQL-language procedures (and SQL-language functions) can use the SQL-standard `BEGIN ATOMIC ... END;` form for the body, which parses the statements at definition time and tracks dependencies in `pg_depend`. The pre-PG14 form is `AS $$ ... $$` with the body re-parsed at every call. See [`06-functions.md`](./06-functions.md#sql-function-inlining-the-big-optimization) for the full rules.

Example:

    CREATE PROCEDURE bump_versions(table_name regclass)
    LANGUAGE sql
    BEGIN ATOMIC
        UPDATE table_name SET version = version + 1;
    END;

`BEGIN ATOMIC` SQL procedures cannot use `COMMIT` / `ROLLBACK` (no procedural control flow). They are a clean choice for grouping a fixed sequence of DML statements behind a `CALL`.


### ALTER PROCEDURE and DROP PROCEDURE

Full syntax from the docs[^alterproc]:

    ALTER PROCEDURE name [ ( argspec ) ]
        RENAME TO new_name
      | OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
      | SET SCHEMA new_schema
      | [ NO ] DEPENDS ON EXTENSION extension_name
      | <action> [ ... ] [ RESTRICT ]

where `<action>` is one of:

    [ EXTERNAL ] SECURITY INVOKER | [ EXTERNAL ] SECURITY DEFINER
    SET configuration_parameter { TO | = } { value | DEFAULT }
    SET configuration_parameter FROM CURRENT
    RESET configuration_parameter
    RESET ALL

Things you can do with `ALTER PROCEDURE`:

- Rename: `ALTER PROCEDURE proc(int) RENAME TO new_proc;`
- Change owner: `ALTER PROCEDURE proc(int) OWNER TO new_owner;`
- Move schema: `ALTER PROCEDURE proc(int) SET SCHEMA private;`
- Flip security: `ALTER PROCEDURE proc(int) SECURITY DEFINER;`
- Pin a GUC: `ALTER PROCEDURE proc(int) SET search_path = audit, pg_temp;`
- Tie to an extension: `ALTER PROCEDURE proc(int) DEPENDS ON EXTENSION my_ext;`

Things you *cannot* change with `ALTER PROCEDURE`:

- The body — use `CREATE OR REPLACE PROCEDURE`.
- The argument types — drop and recreate.
- The language — drop and recreate.

`DROP PROCEDURE name [ ( argspec ) ] [ CASCADE | RESTRICT ]` removes the procedure; `RESTRICT` (default) errors if anything depends on it.


### CALL — invocation grammar

    CALL name ( [ argument ] [, ...] )

Named notation:

    CALL compute_totals(customer_id => 42, order_count => NULL, total_cents => NULL);

The result of `CALL` when there are `OUT` / `INOUT` parameters is **a single row** containing those parameter values[^callsql]:

> *"If the procedure has any output parameters, then a result row will be returned, containing the values of those parameters."*

And the headline transaction-context rule[^callsql]:

> *"If `CALL` is executed in a transaction block, then the called procedure cannot execute transaction control statements. Transaction control statements are only allowed if `CALL` is executed in its own transaction."*

This means: from the psql top level (autocommit on), a `CALL` runs in its own transaction and the procedure can `COMMIT`. But if you wrap it in `BEGIN; CALL ...; COMMIT;`, the inner `COMMIT` inside the procedure will fail.


### Calling a procedure from PL/pgSQL

Inside PL/pgSQL, you call a procedure with `CALL`, capturing `OUT` / `INOUT` values via `INTO`:

    DO $$
    DECLARE
        cnt   integer;
        total bigint;
    BEGIN
        CALL compute_totals(42, cnt, total);
        RAISE NOTICE 'cnt=% total=%', cnt, total;
    END;
    $$;

`PL/pgSQL handles output parameters in CALL commands differently`[^callsql] — specifically, it expects local variables of matching modes/types where you'd write `NULL` from SQL.

**Nested procedures may still commit** — the PL/pgSQL transaction rule[^plpgsql-tx]:

> *"Transaction control is only possible in `CALL` or `DO` invocations from the top level or nested `CALL` or `DO` invocations without any other intervening command."*

So `CALL outer()` → `CALL inner()` → `COMMIT;` works. But `CALL outer()` → `SELECT helper_fn()` → `CALL inner()` → `COMMIT;` does **not**: the `SELECT` in the middle establishes a function-call context that pins the snapshot. The procedure underneath can no longer commit.


### Procedure attributes that don't apply (vs functions)

From the user-defined procedures chapter[^xproc]:

> *"Certain function attributes, such as strictness, don't apply to procedures. Those attributes control how the function is used in a query, which isn't relevant to procedures."*

Concretely, procedures **do not accept** these attributes that functions accept:

- `IMMUTABLE` / `STABLE` / `VOLATILE` — not applicable; procedures aren't called inside expressions.
- `STRICT` / `CALLED ON NULL INPUT` — same reason.
- `LEAKPROOF` — irrelevant; procedures don't appear in query predicates.
- `PARALLEL { UNSAFE | RESTRICTED | SAFE }` — procedures can't be in a parallel plan.
- `COST` / `ROWS` — these tune the planner; procedures aren't planned-inside-a-query.

Attempting to add these to `CREATE PROCEDURE` is rejected at parse time.


### Default privileges and PUBLIC EXECUTE

Just like functions, **new procedures get `EXECUTE` granted to `PUBLIC` by default**. This is the single biggest privilege-escalation footgun for `SECURITY DEFINER` procedures.

The right hardening boilerplate is the same as for functions[^funcsec]:

    CREATE OR REPLACE PROCEDURE audit.archive_orders(cutoff date)
    SECURITY DEFINER
    SET search_path = audit, pg_catalog
    LANGUAGE sql
    AS $$
        DELETE FROM audit.orders WHERE created_at < cutoff;
    $$;

    REVOKE EXECUTE ON PROCEDURE audit.archive_orders(date) FROM PUBLIC;
    GRANT  EXECUTE ON PROCEDURE audit.archive_orders(date) TO ops_admin;

For new schemas, prefer `ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE EXECUTE ON ROUTINES FROM PUBLIC;` so the next procedure created in that schema is hardened too. See [`46-roles-privileges.md`](./46-roles-privileges.md) for the default-privileges machinery.


### Lock-level summary for procedure DDL

Same as functions. Procedures live in `pg_proc` (the same catalog), and the lock matrix is identical.

| Operation | Lock taken |
|---|---|
| `CREATE PROCEDURE`, `CREATE OR REPLACE PROCEDURE` | `RowExclusiveLock` on `pg_proc` |
| `ALTER PROCEDURE ... RENAME / OWNER / SET SCHEMA / SECURITY DEFINER / SET / DEPENDS ON EXTENSION` | `AccessExclusiveLock` on the procedure row |
| `DROP PROCEDURE` | `AccessExclusiveLock` on the procedure row + cascade locks |
| `GRANT` / `REVOKE` on procedure | `AccessShareLock` on the procedure row + `RowExclusiveLock` on `pg_proc` |

See [`43-locking.md`](./43-locking.md) for the full table-level matrix.


## Transaction control inside procedures


### The four legal commands

In a PL/pgSQL procedure body (and the equivalents in other procedural languages):

| Command | Effect |
|---|---|
| `COMMIT;` | end current transaction, start a new one with default characteristics |
| `ROLLBACK;` | abort current transaction, start a new one with default characteristics |
| `COMMIT AND CHAIN;` | end current transaction, start a new one with the **same** characteristics (isolation level, read-only, deferrable) |
| `ROLLBACK AND CHAIN;` | abort current transaction, start a new one with the **same** characteristics |

A new transaction starts automatically after `COMMIT` or `ROLLBACK` — you do **not** issue `START TRANSACTION` / `BEGIN`. (In PL/pgSQL, `BEGIN` and `END` are block delimiters; they are not transaction-control keywords.[^plpgsql-tx])


### Where transaction control is *not* allowed

From the manual[^plpgsql-tx], verbatim:

> *"Transaction control is only possible in `CALL` or `DO` invocations from the top level or nested `CALL` or `DO` invocations without any other intervening command."*

Concretely, all of these throw `invalid transaction termination` at runtime:

1. **`COMMIT` inside a function.** Functions are evaluated inside an expression context — there is no way to break that context.
2. **`COMMIT` inside a `SECURITY DEFINER` procedure.** The owner-context save would be torn by the transaction boundary.
3. **`COMMIT` inside a procedure with a `SET` clause.** Same reason.
4. **`COMMIT` inside a procedure called by `SELECT proc_caller()` where `proc_caller()` is a function.** The `SELECT` establishes a function-call snapshot.
5. **`COMMIT` inside an `EXCEPTION` block.** PL/pgSQL exception handling is implemented as a subtransaction (a `SAVEPOINT` + auto-rollback on raise) — committing the outer transaction would orphan the subtransaction. Per the docs[^plpgsql-tx]: *"A transaction cannot be ended inside a block with exception handlers."*
6. **`COMMIT` inside a `FOR row IN UPDATE ... RETURNING ... LOOP`.** The non-read-only cursor would lose its row-stream state. Per the docs[^plpgsql-tx]: *"Transaction commands are not allowed in cursor loops driven by commands that are not read-only (for example `UPDATE ... RETURNING`)."*
7. **`CALL proc()` inside a `BEGIN; ... COMMIT;` block** issued by the client — `CALL` must be its own top-level statement.[^callsql]

> [!WARNING] EXCEPTION blocks create subtransactions
> Every PL/pgSQL block that has an `EXCEPTION` clause is implemented as a subtransaction. This (a) forbids transaction control inside the block, (b) bumps the `subtrans` SLRU on every entry, and (c) is the most common silent performance regression in chunked-loop procedures that wrap each iteration in `BEGIN ... EXCEPTION ... END`. See [`41-transactions.md`](./41-transactions.md) for subtransaction cost.


### What happens to the snapshot on COMMIT

A `COMMIT` (or `ROLLBACK`) inside a procedure ends the current transaction. The next statement in the procedure runs in a **brand-new transaction with a fresh snapshot**. That has visibility consequences:

- Rows you read before the `COMMIT` may now be visible from concurrent writers that committed in the gap.
- Rows you wrote and committed are visible to other backends *and* to the next statement of your procedure under its new snapshot.
- Locks taken in the previous transaction (`FOR UPDATE`, advisory `pg_advisory_xact_lock`, table-level locks) are **released** at `COMMIT`. If you need those locks across the loop, use `pg_advisory_lock` (session-scoped — see [`44-advisory-locks.md`](./44-advisory-locks.md)) or re-acquire them.

If you want the new transaction to inherit characteristics like `ISOLATION LEVEL REPEATABLE READ` from the previous one, use `COMMIT AND CHAIN`. Otherwise the new transaction starts with `default_transaction_isolation` (typically `read committed`).


### Cursor loops and the holdable-cursor surprise

A frequent procedure pattern is `FOR row IN SELECT ... FROM ... ORDER BY ... LOOP ... COMMIT; END LOOP;`. PostgreSQL automatically converts that cursor to a holdable cursor on the first `COMMIT`, with a side effect described by the docs[^plpgsql-tx]:

> *"Normally, cursors are automatically closed at transaction commit. However, a cursor created as part of a loop like this is automatically converted to a holdable cursor by the first `COMMIT` or `ROLLBACK`. That means that the cursor is fully evaluated at the first `COMMIT` or `ROLLBACK` rather than row by row."*

Consequence: the entire result set is **materialized in memory** at the first commit. For a 50-million-row loop, that is not what you want. The right pattern is to **drive the loop by a `WHERE ... LIMIT N` query** that's re-run each iteration, not by an open cursor — see Recipe 1 below.


## Examples / Recipes


### Recipe 1 — Chunked DML with periodic COMMIT

The canonical "delete N million rows without blowing up WAL / autovacuum / lock waits" pattern. Drive the loop with a re-issued `DELETE ... WHERE id IN (... LIMIT 1000) RETURNING 1` so each commit releases locks and starts a fresh transaction with a fresh snapshot:

    CREATE PROCEDURE archive_old_orders(cutoff timestamptz, batch_size int DEFAULT 1000)
    LANGUAGE plpgsql
    AS $$
    DECLARE
        deleted integer;
    BEGIN
        LOOP
            WITH victims AS (
                SELECT id
                FROM orders
                WHERE created_at < cutoff
                ORDER BY id
                LIMIT batch_size
                FOR UPDATE SKIP LOCKED
            )
            DELETE FROM orders
            WHERE id IN (SELECT id FROM victims);

            GET DIAGNOSTICS deleted = ROW_COUNT;
            EXIT WHEN deleted = 0;

            COMMIT;
            PERFORM pg_sleep(0.05);  -- yield briefly between batches
        END LOOP;
    END;
    $$;

    CALL archive_old_orders('2024-01-01'::timestamptz);

Why this shape: each iteration is its own transaction, so vacuum can reclaim space between batches, `FOR UPDATE SKIP LOCKED` lets concurrent updaters proceed, and the `LIMIT` keeps lock count predictable.

> [!WARNING] Do not wrap the LOOP body in BEGIN ... EXCEPTION
> Adding `EXCEPTION WHEN OTHERS THEN ...` around the iteration disables `COMMIT` inside the loop (subtransaction rule). If you need error handling, log via `RAISE LOG` from outside an exception block, or use a wrapper procedure that calls this one and catches at that layer.


### Recipe 2 — Procedure with OUT parameters (PG14+)

> [!NOTE] PostgreSQL 14
> Procedures gained `OUT` parameters in PG14. Pre-PG14, use `INOUT` instead.

    CREATE PROCEDURE next_invoice_number(
        OUT new_number bigint,
        OUT issued_at  timestamptz
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        SELECT nextval('invoice_seq'), clock_timestamp()
        INTO new_number, issued_at;
    END;
    $$;

    CALL next_invoice_number(NULL, NULL);
     new_number |          issued_at
    ------------+------------------------------
            123 | 2026-05-11 07:50:12.345+00


### Recipe 3 — Multi-step batch with checkpoint COMMITs

Useful when each step is independent and you want crash-safe progress (a crash mid-procedure should not roll back the earlier steps):

    CREATE PROCEDURE nightly_maintenance()
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RAISE LOG 'maintenance: step 1 — refresh dashboards';
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_daily;
        COMMIT;

        RAISE LOG 'maintenance: step 2 — vacuum hot table';
        VACUUM (ANALYZE) orders;
        COMMIT;

        RAISE LOG 'maintenance: step 3 — roll partitions';
        CALL partition_admin.rotate_orders(retention_days => 90);
        COMMIT;

        RAISE LOG 'maintenance: done';
    END;
    $$;

(Note: `VACUUM` cannot run inside a transaction block — but in a procedure, between commits, each statement is its own top-level transaction, so `VACUUM` works. This is one of the strongest reasons to use a procedure over a script of `psql -c '...'` calls.)


### Recipe 4 — COMMIT AND CHAIN to preserve isolation

If your loop body relies on `REPEATABLE READ`, use `COMMIT AND CHAIN` so the next iteration inherits the isolation level instead of falling back to `read committed`:

    CREATE PROCEDURE consistent_export()
    LANGUAGE plpgsql
    AS $$
    BEGIN
        SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

        FOR partition_name IN
            SELECT inhrelid::regclass::text
            FROM pg_inherits
            WHERE inhparent = 'orders'::regclass
            ORDER BY 1
        LOOP
            -- ... export this partition snapshotted ...
            EXECUTE format('COPY %I TO ''/exports/%I.csv'' CSV', partition_name, partition_name);
            COMMIT AND CHAIN;
        END LOOP;
    END;
    $$;


### Recipe 5 — SECURITY DEFINER procedure that pins search_path

Hardening pattern for a privileged procedure. Note: this version **cannot use `COMMIT`** because of the `SECURITY DEFINER` restriction:

    CREATE OR REPLACE PROCEDURE audit.record_login(p_user bigint, p_ip inet)
    SECURITY DEFINER
    SET search_path = audit, pg_catalog
    LANGUAGE sql
    AS $$
        INSERT INTO audit.logins(user_id, ip, at) VALUES (p_user, p_ip, now());
    $$;

    REVOKE EXECUTE ON PROCEDURE audit.record_login(bigint, inet) FROM PUBLIC;
    GRANT  EXECUTE ON PROCEDURE audit.record_login(bigint, inet) TO app_role;

Two-procedure pattern for `SECURITY DEFINER` + `COMMIT` (see [WARNING above](#security-definer-vs-security-invoker)):

    -- non-SECURITY-DEFINER worker can commit; runs as caller
    CREATE PROCEDURE archive_worker(...)
    LANGUAGE plpgsql AS $$ ... COMMIT; ... $$;

    -- thin SECURITY DEFINER wrapper for privilege escalation;
    -- does NOT call COMMIT and does NOT have a SET clause that would block one in the worker.
    -- (We must set search_path inline instead of via SET clause to avoid the restriction.)
    CREATE OR REPLACE PROCEDURE archive_admin(...)
    SECURITY DEFINER
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM set_config('search_path', 'audit, pg_catalog', true);  -- transaction-local
        CALL archive_worker(...);  -- still no COMMIT here either
    END;
    $$;

The wrapper cannot `COMMIT` either — `SECURITY DEFINER` and chunked `COMMIT` are incompatible inside a single procedure. The caller must invoke the worker directly with appropriate privileges.


### Recipe 6 — Procedure as the orchestrator, functions as the building blocks

A clean architecture is: pure functions do the read-only / scalar work; one procedure orchestrates the writes and commits.

    CREATE FUNCTION compute_invoice_total(p_invoice bigint)
    RETURNS numeric
    LANGUAGE sql STABLE AS $$
        SELECT sum(unit_price * qty)
        FROM invoice_items
        WHERE invoice_id = p_invoice;
    $$;

    CREATE PROCEDURE close_invoice(p_invoice bigint)
    LANGUAGE plpgsql AS $$
    DECLARE
        total numeric;
    BEGIN
        total := compute_invoice_total(p_invoice);    -- function: no commit needed
        UPDATE invoices SET total_amount = total, closed_at = now()
         WHERE id = p_invoice;
        INSERT INTO audit.invoice_closures(invoice_id, total) VALUES (p_invoice, total);
        COMMIT;
    END;
    $$;


### Recipe 7 — Partition rotation procedure

Combine with [`pg_cron`](./98-pg-cron.md) for nightly scheduling. Each operation gets its own transaction so a crash mid-rotation leaves a clean state:

    CREATE PROCEDURE rotate_orders_partitions(retention_days int DEFAULT 90)
    LANGUAGE plpgsql AS $$
    DECLARE
        next_day date := (current_date + interval '1 day')::date;
        old_day  date := (current_date - retention_days * interval '1 day')::date;
        new_part text := format('orders_%s', to_char(next_day, 'YYYYMMDD'));
        old_part text := format('orders_%s', to_char(old_day, 'YYYYMMDD'));
    BEGIN
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF orders FOR VALUES FROM (%L) TO (%L)',
            new_part, next_day, next_day + 1
        );
        COMMIT;

        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = old_part) THEN
            EXECUTE format('ALTER TABLE orders DETACH PARTITION %I CONCURRENTLY', old_part);
            COMMIT;
            EXECUTE format('DROP TABLE %I', old_part);
            COMMIT;
        END IF;
    END;
    $$;

Schedule with pg_cron:

    SELECT cron.schedule('rotate-orders', '5 2 * * *',
                         $$CALL rotate_orders_partitions(90)$$);


### Recipe 8 — Idempotent CREATE OR REPLACE PROCEDURE boilerplate

`CREATE OR REPLACE PROCEDURE` is the safer default — it preserves dependencies and grants, where `DROP` + `CREATE` would silently drop them. Pattern:

    CREATE OR REPLACE PROCEDURE app.sync_users()
    LANGUAGE plpgsql AS $$
    BEGIN
        -- body
    END;
    $$;

    DO $$
    BEGIN
        -- (Re-)grant; safe to re-run.
        REVOKE EXECUTE ON PROCEDURE app.sync_users() FROM PUBLIC;
        GRANT  EXECUTE ON PROCEDURE app.sync_users() TO etl_role;
    END;
    $$;

If you need to change argument types, `DROP PROCEDURE app.sync_users(...);` is unavoidable — and you must re-`GRANT` afterwards. Take an inventory of grants from `pg_proc.proacl` before dropping.


### Recipe 9 — Calling a procedure from psql vs from a function (the trap)

From `psql` (autocommit on), this works:

    \c mydb
    CALL archive_old_orders('2024-01-01');

But this **fails** with `invalid transaction termination`:

    BEGIN;
    CALL archive_old_orders('2024-01-01');   -- ERROR inside the procedure on first COMMIT
    COMMIT;

And this is rejected at runtime too, because the surrounding `SELECT` establishes a snapshot the procedure cannot break out of:

    CREATE FUNCTION trigger_archive() RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
        CALL archive_old_orders('2024-01-01');  -- ERROR: cannot CALL a procedure that
                                                -- does transaction control from a function
    END;
    $$;

The right way to "call a procedure from a function" is: don't. Refactor the function into the procedure (or vice versa), or invoke the procedure separately from the application layer / pg_cron.


### Recipe 10 — Inspecting all procedures with their attributes

Procedures live in `pg_proc` like functions, distinguished by `prokind = 'p'`. (For functions, `prokind = 'f'`; aggregates `'a'`; window functions `'w'`.)

    SELECT
        n.nspname                            AS schema,
        p.proname                            AS name,
        pg_get_function_arguments(p.oid)     AS args,
        l.lanname                            AS language,
        p.prosecdef                          AS security_definer,
        p.proconfig                          AS attached_settings,
        pg_get_userbyid(p.proowner)          AS owner,
        obj_description(p.oid, 'pg_proc')    AS comment
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
    WHERE p.prokind = 'p'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2;

For the audit script that finds every `SECURITY DEFINER` procedure missing a pinned `search_path`, see [`06-functions.md`](./06-functions.md#recipe-11--pin-search_path-on-every-security-definer-and-index-used-function) — the same query works against `prokind IN ('f','p')` to cover both.


## Gotchas / Anti-patterns


1. **Trying to `COMMIT` inside a function.** Functions cannot end the transaction they're embedded in. If you find yourself wanting to, refactor to a procedure.

2. **`SECURITY DEFINER` + `COMMIT` in the same procedure.** Grammatically accepted; fails at runtime. Choose one. If you must have both, escalate privilege at the **outer** call site (e.g., a security-definer thin wrapper that does nothing requiring commit) and put the commit loop in a separate non-`SECURITY DEFINER` procedure granted to a privileged role.

3. **`SET search_path = '...'` clause on a chunked-COMMIT procedure.** Same problem as #2. Use `PERFORM set_config('search_path', '...', true)` at the top of the body instead.

4. **`EXCEPTION` block in the loop body.** The exception handler creates a subtransaction (`SAVEPOINT`), which disables `COMMIT` inside the block and adds `subtrans` SLRU pressure. If you need per-iteration error handling, do it at the calling layer or use a savepoint-free strategy like inspecting `GET DIAGNOSTICS` after each `UPDATE`.

5. **Holdable-cursor materialization.** `FOR row IN SELECT ... LOOP COMMIT; END LOOP;` does **not** stream row-by-row after the first commit — the cursor is fully materialized in memory. For large sets, drive the loop with `LIMIT N` re-issued each iteration, not by a `FOR row IN ...` cursor.

6. **Snapshot reset after `COMMIT`.** Code that reads a value pre-`COMMIT` and assumes it's still current post-`COMMIT` is wrong; concurrent writers may have committed in between. Re-read inside each transaction.

7. **Locks released at every `COMMIT`.** Row locks (`FOR UPDATE`), advisory transaction locks, and table locks are all dropped on `COMMIT`. If you need cross-iteration mutual exclusion, use `pg_advisory_lock` (session scope) once at the top of the procedure and `pg_advisory_unlock` at the bottom.

8. **`CALL` inside a `BEGIN; ... COMMIT;` from the client.** The procedure cannot commit because it's nested in an explicit transaction block. The caller must run `CALL` outside an open transaction.

9. **Procedures + connection pooling in transaction mode.** Procedures often hold a backend across multiple transactions (one per commit cycle). Transaction-pooled connections (pgBouncer `pool_mode = transaction`) will rotate the underlying backend at every commit, breaking session-scoped advisory locks and `SET LOCAL`. For procedures that commit, use session-pool mode or call them from a dedicated worker, not from the request-path pool. See [`81-pgbouncer.md`](./81-pgbouncer.md).

10. **`SECURITY DEFINER` without `REVOKE EXECUTE ... FROM PUBLIC`.** Same gotcha as functions: `PUBLIC` gets `EXECUTE` by default. A `SECURITY DEFINER` procedure that you intended only for one role is, by default, callable by anyone in the database. Always revoke `PUBLIC` and grant explicitly.

11. **`DROP PROCEDURE` losing grants.** `CREATE OR REPLACE PROCEDURE` preserves grants and ownership; `DROP` + `CREATE` does not. Prefer replace when the argument signature is unchanged.

12. **Using a procedure when a function would do.** If the routine has no commits, no transactional side effects across statements, and just computes-and-returns, write it as a function. Functions are usable in `SELECT` lists, can be `IMMUTABLE` (and thus indexed), and inline when the SQL form allows. Procedures cannot.

13. **Confusing PL/pgSQL `BEGIN` / `END` with transaction `BEGIN` / `COMMIT`.** PL/pgSQL `BEGIN` opens a *code block* (with optional `EXCEPTION` handler), not a transaction. `BEGIN; COMMIT;` is invalid inside a PL/pgSQL body. The transaction-control commands are `COMMIT;` and `ROLLBACK;` (and their `AND CHAIN` forms).

14. **Forgetting that `BEGIN ATOMIC` SQL procedures cannot commit.** They have no procedural control flow. `BEGIN ATOMIC` is for grouping a small fixed sequence of DML. For commit-loop work, use `LANGUAGE plpgsql`.

15. **`ALTER PROCEDURE` cannot change the body or argument types.** Use `CREATE OR REPLACE PROCEDURE` for body changes; drop and recreate for signature changes. There is no `ALTER PROCEDURE ... BODY` syntax.


## See Also


- [`06-functions.md`](./06-functions.md) — `CREATE FUNCTION`, volatility, parallel safety, `SECURITY DEFINER` hardening for functions, polymorphic types, SQL-function inlining.
- [`08-plpgsql.md`](./08-plpgsql.md) — PL/pgSQL block grammar, control flow (`IF` / `CASE` / `LOOP` / `FOR` / `WHILE`), exception handling, dynamic SQL, cursors.
- [`10-dynamic-sql.md`](./10-dynamic-sql.md) — `EXECUTE`, `format()`, injection prevention for dynamic SQL inside procedure bodies.
- [`09-procedural-languages.md`](./09-procedural-languages.md) — PL/Perl, PL/Python, PL/Tcl — and the trust/untrust split.
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — `DECLARE CURSOR`, holdable cursors, the cursor-loop behavior referenced above.
- [`35-partitioning.md`](./35-partitioning.md) — partition rotation patterns called by Recipe 7.
- [`41-transactions.md`](./41-transactions.md) — `BEGIN`/`COMMIT`/`ROLLBACK`, savepoints, subtransactions, autocommit semantics, `idle_in_transaction_session_timeout`.
- [`42-isolation-levels.md`](./42-isolation-levels.md) — `READ COMMITTED` vs `REPEATABLE READ` vs `SERIALIZABLE`; relevant to `COMMIT AND CHAIN`.
- [`43-locking.md`](./43-locking.md) — full lock matrix; relevant to "locks released at every COMMIT" gotcha.
- [`44-advisory-locks.md`](./44-advisory-locks.md) — session-scoped advisory locks survive `COMMIT`, transaction-scoped don't.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `ALTER DEFAULT PRIVILEGES`, `REVOKE EXECUTE` from `PUBLIC`.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_proc.prokind`, `proconfig`, `prosecdef`.
- [`81-pgbouncer.md`](./81-pgbouncer.md) — procedure interaction with transaction-mode pooling.
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling `CALL` on a cron.
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — the chunked-DML and partition-rotation recipes generalized.


## Sources


[^createproc]: PostgreSQL 16, `CREATE PROCEDURE` reference page. Includes the verbatim restriction *"A `SECURITY DEFINER` procedure cannot execute transaction control statements (for example, `COMMIT` and `ROLLBACK`, depending on the language)."* and *"If a `SET` clause is attached to a procedure, then that procedure cannot execute transaction control statements (for example, `COMMIT` and `ROLLBACK`, depending on the language)."* https://www.postgresql.org/docs/16/sql-createprocedure.html

[^callsql]: PostgreSQL 16, `CALL` reference page. Includes the verbatim restriction *"If `CALL` is executed in a transaction block, then the called procedure cannot execute transaction control statements. Transaction control statements are only allowed if `CALL` is executed in its own transaction."* and the `OUT`-parameter handling note *"Arguments must be supplied for all procedure parameters that lack defaults, including OUT parameters. However, arguments matching OUT parameters are not evaluated, so it's customary to write `NULL` for them."* https://www.postgresql.org/docs/16/sql-call.html

[^alterproc]: PostgreSQL 16, `ALTER PROCEDURE` reference page. Documents the supported actions: `RENAME TO`, `OWNER TO`, `SET SCHEMA`, `SECURITY DEFINER`/`INVOKER`, `SET configuration_parameter`, `RESET`, `DEPENDS ON EXTENSION`. https://www.postgresql.org/docs/16/sql-alterprocedure.html

[^plpgsql-tx]: PostgreSQL 16, *"43.8. Transaction Management"* (PL/pgSQL chapter). Includes the verbatim restrictions *"Transaction control is only possible in `CALL` or `DO` invocations from the top level or nested `CALL` or `DO` invocations without any other intervening command."*, *"A transaction cannot be ended inside a block with exception handlers."*, *"Transaction commands are not allowed in cursor loops driven by commands that are not read-only (for example `UPDATE ... RETURNING`)."*, and the holdable-cursor materialization note *"a cursor created as part of a loop like this is automatically converted to a holdable cursor by the first `COMMIT` or `ROLLBACK`. That means that the cursor is fully evaluated at the first `COMMIT` or `ROLLBACK` rather than row by row."* https://www.postgresql.org/docs/16/plpgsql-transactions.html

[^xproc]: PostgreSQL 16, *"38.4. User-Defined Procedures"*. Includes the verbatim function/procedure distinctions *"A procedure can commit or roll back transactions during its execution (then automatically beginning a new transaction), so long as the invoking `CALL` command is not part of an explicit transaction block. A function cannot do that."* and *"Certain function attributes, such as strictness, don't apply to procedures. Those attributes control how the function is used in a query, which isn't relevant to procedures."* https://www.postgresql.org/docs/16/xproc.html

[^pg11-proc]: PostgreSQL 11 release notes. *"Add SQL-level procedures, which can start and commit their own transactions (Peter Eisentraut). They are created with the new `CREATE PROCEDURE` command and invoked via `CALL`."* and *"Add transaction control to PL/pgSQL, PL/Perl, PL/Python, PL/Tcl, and SPI server-side languages (Peter Eisentraut)."* https://www.postgresql.org/docs/release/11.0/

[^pg14-out]: PostgreSQL 14 release notes. *"Allow procedures to have `OUT` parameters (Peter Eisentraut)."* Also in the overview: *"Stored procedures can now return data via `OUT` parameters."* https://www.postgresql.org/docs/release/14.0/

[^funcsec]: PostgreSQL 16, [`06-functions.md`](./06-functions.md#security-definer-vs-security-invoker) recipe 3 (cross-reference): the `SECURITY DEFINER` + `SET search_path` + `REVOKE EXECUTE FROM PUBLIC` hardening triad. Primary doc reference: PostgreSQL 16, `CREATE FUNCTION` security section. https://www.postgresql.org/docs/16/sql-createfunction.html

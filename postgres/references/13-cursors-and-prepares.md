# Cursors and Prepared Statements

Server-side iteration over result sets (cursors) and parsed-and-planned SQL templates (prepared statements). Both live inside session/transaction lifetimes and both share the planner machinery, but they solve completely different problems.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Cursor Mechanics](#cursor-mechanics)
    - [`DECLARE` Grammar](#declare-grammar)
    - [`FETCH` and `MOVE` Directions](#fetch-and-move-directions)
    - [`CLOSE` and Implicit Closure](#close-and-implicit-closure)
    - [Holdable Cursors (`WITH HOLD`)](#holdable-cursors-with-hold)
    - [Updatable Cursors and `WHERE CURRENT OF`](#updatable-cursors-and-where-current-of)
    - [`pg_cursors` View](#pg_cursors-view)
- [Cursors in PL/pgSQL](#cursors-in-plpgsql)
    - [Bound vs Unbound](#bound-vs-unbound)
    - [`OPEN` Forms](#open-forms)
    - [`refcursor` Return Values](#refcursor-return-values)
- [Prepared-Statement Mechanics](#prepared-statement-mechanics)
    - [`PREPARE` Grammar](#prepare-grammar)
    - [`EXECUTE` and Parameter Passing](#execute-and-parameter-passing)
    - [`DEALLOCATE` and Session Cleanup](#deallocate-and-session-cleanup)
    - [`pg_prepared_statements` View](#pg_prepared_statements-view)
- [Plan Caching: Generic vs Custom](#plan-caching-generic-vs-custom)
    - [The Five-Execution Rule](#the-five-execution-rule)
    - [`plan_cache_mode`](#plan_cache_mode)
    - [PL/pgSQL Embedded SQL Plan Cache](#plpgsql-embedded-sql-plan-cache)
    - [`DISCARD PLANS` vs `DEALLOCATE ALL`](#discard-plans-vs-deallocate-all)
- [Protocol-Level Prepared Statements](#protocol-level-prepared-statements)
- [Decision Matrix](#decision-matrix)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when you need to:

- Stream a large result set without buffering it all in the client.
- Hand a result set across function boundaries (return `refcursor`).
- Reuse a parsed/planned SQL template many times in one session (`PREPARE` / `EXECUTE`).
- Debug a "fast on first call, slow on the sixth call" prepared-statement regression — almost always plan-cache flipping.
- Understand why pgBouncer in transaction-pooling mode broke your prepared statements (and what PG17+ protocol-level support changes).
- Decide between in-PL/pgSQL `FOR rec IN query LOOP`, an explicit cursor, and a one-shot `SELECT ... INTO` capture.

PL/pgSQL-level cursor flow is also covered in [`08-plpgsql.md`](./08-plpgsql.md) at the syntax-fluent level. This file covers: the full SQL-level surface (`DECLARE`/`FETCH`/`MOVE`/`CLOSE`/`PREPARE`/`EXECUTE`/`DEALLOCATE`/`DISCARD`), `plan_cache_mode`, the generic-vs-custom-plan decision, and the per-session caches you can inspect.

## Mental Model

A **cursor** is a server-side iterator over a result set. It is *opened*, *advanced*, and *closed*. Between fetches the server holds the query state and the un-returned rows. Cursors are bound to a transaction by default; with `WITH HOLD` they can outlive their declaring transaction but only by *materializing all remaining rows into a temporary file or memory area at COMMIT*[^pg-decl].

A **prepared statement** is a parsed-and-planned SQL template, bound to a session by name. The `EXECUTE` call supplies positional parameters (`$1`, `$2`, …) and runs the cached plan. The server may choose, at each execution, to use a *generic* plan (parameter values unknown at plan time) or a *custom* plan (re-planned with this call's specific parameter values)[^pg-prep].

The two concepts share the planner machinery but solve different problems:

| Need | Tool |
|---|---|
| Iterate over a result set in pieces | Cursor |
| Return a result set from a function/procedure | `refcursor` cursor |
| Reuse the same query shape with different values, many times | Prepared statement |
| Parameterized one-shot SQL with `WHERE` clauses tuned per-call | Prepared statement (or driver-level parameter binding) |
| Stream large `SELECT` to a client without buffering | Cursor (or client driver fetch-size on extended-protocol) |
| Page forward and backward through a result set | `SCROLL` cursor |

Cursors and prepared statements *can* be combined: `DECLARE` accepts a query that is itself parameterized via `EXECUTE`-style binding on extended protocol, and PL/pgSQL's `OPEN cur FOR EXECUTE` opens a cursor over a dynamic statement.

## Cursor Mechanics

### `DECLARE` Grammar

```sql
DECLARE name [ BINARY ] [ ASENSITIVE | INSENSITIVE ] [ [ NO ] SCROLL ]
    CURSOR [ { WITH | WITHOUT } HOLD ] FOR query
    [ FOR { READ ONLY | UPDATE [ OF column [, ...] ] | SHARE [ OF column [, ...] ] } ]
```

Option-by-option semantics, verbatim from `sql-declare.html`[^pg-decl]:

- **`BINARY`** — rows come back in PostgreSQL binary wire format, not text. *"Many applications, including psql, are not prepared to handle binary cursors."* Reserve for native-protocol clients that explicitly opt in.

- **`ASENSITIVE` / `INSENSITIVE`** — *"All cursors are insensitive; so these key words have no effect and are only accepted for compatibility with the SQL standard."* Cannot be combined with `FOR UPDATE`/`FOR SHARE`.

- **`SCROLL` / `NO SCROLL`** — `SCROLL` permits non-sequential and backward fetches. *"The default is to allow scrolling in some cases; this is not the same as specifying `SCROLL`. PostgreSQL will allow backward fetches without `SCROLL`, if the cursor's query plan is simple enough that no extra overhead is needed to support it."* Treat the default as "forward-only" — explicitly declare `SCROLL` if you ever fetch backward.

- **`WITH HOLD` / `WITHOUT HOLD`** — default is `WITHOUT HOLD`. With `WITH HOLD`: *"the cursor can continue to be used after the transaction that created it successfully commits."* Without: *"the cursor would survive only to the completion of the statement. Therefore PostgreSQL reports an error if such a command is used outside a transaction block."*

- **`FOR UPDATE` / `FOR SHARE`** — locks rows as they are fetched, like the same clauses in a plain `SELECT`. Incompatible with `INSENSITIVE`, `SCROLL`, and `WITH HOLD`. Enables `UPDATE ... WHERE CURRENT OF` and `DELETE ... WHERE CURRENT OF` on the cursor.

Minimal example, inside a transaction:

```sql
BEGIN;

DECLARE c1 CURSOR FOR
    SELECT id, payload FROM events WHERE created_at >= now() - interval '1 day';

FETCH 100 FROM c1;
-- process, then fetch the next batch
FETCH 100 FROM c1;
-- ...

CLOSE c1;
COMMIT;
```

### `FETCH` and `MOVE` Directions

```sql
FETCH [ direction ] [ FROM | IN ] cursor_name
MOVE  [ direction ] [ FROM | IN ] cursor_name
```

`FETCH` returns rows; `MOVE` returns a `MOVE count` command tag and discards the rows — *"`MOVE` works exactly like the `FETCH` command, except it only positions the cursor and does not return rows."*[^pg-move]

The full direction grammar (identical for `FETCH` and `MOVE`)[^pg-fetch]:

| Direction | Behavior |
|---|---|
| *(none)* / `NEXT` / `FORWARD` | Fetch the next row |
| `PRIOR` / `BACKWARD` | Fetch the prior row (requires backward-fetch capability) |
| `FIRST` | Equivalent to `ABSOLUTE 1` |
| `LAST` | Equivalent to `ABSOLUTE -1` |
| `ABSOLUTE count` | Fetch the *count*'th row, or `abs(count)`'th from end if negative |
| `RELATIVE count` | Fetch the *count*'th succeeding row, or `abs(count)`'th prior row if negative |
| `count` | Equivalent to `FORWARD count` |
| `ALL` | Equivalent to `FORWARD ALL` |
| `FORWARD count` / `BACKWARD count` | Fetch *count* rows in that direction |
| `FORWARD ALL` / `BACKWARD ALL` | Fetch all remaining rows in that direction |

Two non-obvious positions:

- **`ABSOLUTE 0`** positions the cursor *before the first row* and returns no rows.
- **`RELATIVE 0`** *re-fetches the current row* without moving — useful for "peek again" semantics, but only valid when the cursor is currently on a row.

> [!WARNING] Volatile functions and `SCROLL`
> *"Scrollable cursors may give unexpected results if they invoke any volatile functions... When a previously fetched row is re-fetched, the functions might be re-executed."*[^pg-decl] If determinism matters, declare `SCROLL WITH HOLD` and `COMMIT` before reading — that forces full materialization, executing volatile functions exactly once per row.

### `CLOSE` and Implicit Closure

```sql
CLOSE { name | ALL }
```

Closure rules[^pg-close]:

- A non-holdable cursor is *automatically closed* on `COMMIT` or `ROLLBACK`.
- A holdable cursor is closed when the creating transaction `ROLLBACK`s, when explicitly `CLOSE`d, or when the session ends.
- Closure is **not transactional** in the rollback sense: *"If a cursor is closed after a savepoint that is later rolled back, the `CLOSE` is not rolled back — the cursor remains closed."*
- `CLOSE ALL` is a PG extension; the SQL-standard form only closes one cursor at a time.

### Holdable Cursors (`WITH HOLD`)

`WITH HOLD` is the only way to keep a server-side cursor open across `COMMIT`. The cost: the cursor's full remaining result set is *materialized into a temporary file or memory area* at `COMMIT`[^pg-decl]. This is the same gotcha called out in [`07-procedures.md`](./07-procedures.md) (procedure transaction control).

Implications:

- A `LIMIT`-less `WITH HOLD` cursor over a 10-million-row table will copy all 10 million rows on `COMMIT`. Avoid.
- Holdable + scrollable is the only safe combination for determinism with volatile functions in the query.
- Holdable cursors do **not** survive the session — at backend exit they are dropped.

### Updatable Cursors and `WHERE CURRENT OF`

```sql
BEGIN;
DECLARE c CURSOR FOR
    SELECT id, status FROM jobs WHERE worker_id IS NULL
    FOR UPDATE;

FETCH NEXT FROM c;       -- locks one row
UPDATE jobs SET worker_id = pg_backend_pid(), status = 'claimed'
    WHERE CURRENT OF c;
COMMIT;
```

Rules:

- Must declare with `FOR UPDATE` (or `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY SHARE`).
- The underlying query must be "simply updatable" — single table, no `GROUP BY`, no `ORDER BY`, no aggregates, no joins (or be made so via a `WHERE CURRENT OF`-compatible plan).
- Cannot combine with `WITH HOLD`, `SCROLL`, or `INSENSITIVE`.

For most use cases prefer keyset-based update (`UPDATE jobs SET ... WHERE id = $1`) — cursor-bound `WHERE CURRENT OF` is largely a legacy SQL-standard interface.

### `pg_cursors` View

```sql
SELECT name, statement, is_holdable, is_binary, is_scrollable, creation_time
FROM pg_cursors;
```

One row per cursor visible to the current session, including holdable cursors that survive `COMMIT` and cursors opened internally (e.g., by SPI inside a PL function)[^pg-cursors-view].

Diagnostic queries:

- Long-lived holdable cursor that's hogging temp space:

    ```sql
    SELECT name, statement, creation_time, now() - creation_time AS age
    FROM pg_cursors
    WHERE is_holdable
    ORDER BY creation_time;
    ```

- Cursors leaked across many backends — query each backend's view; aggregating across the cluster requires a connection per backend or the `auto_explain` audit trail.

## Cursors in PL/pgSQL

### Bound vs Unbound

A **bound** cursor variable is declared with a fixed query:

```sql
DECLARE
    c_jobs CURSOR (p_status text)
        FOR SELECT id FROM jobs WHERE status = p_status;
```

An **unbound** cursor variable is a `refcursor` with no attached query; the query is supplied at `OPEN` time:

```sql
DECLARE
    c refcursor;
BEGIN
    OPEN c FOR SELECT id FROM jobs WHERE status = 'pending';
END;
```

The full bound-cursor declaration grammar is[^pg-plpgsql-cur]:

```
name [ [ NO ] SCROLL ] CURSOR [ ( arguments ) ] FOR query;
```

Each argument in `arguments` is a `name datatype` pair.

### `OPEN` Forms

Three forms, in order of static-to-dynamic[^pg-plpgsql-cur]:

```sql
-- 1. Open a bound cursor (with optional named arguments)
OPEN c_jobs(p_status := 'pending');

-- 2. Open an unbound cursor over a fixed query
OPEN c FOR SELECT id FROM jobs WHERE status = 'pending';

-- 3. Open an unbound cursor over a dynamic query
OPEN c FOR EXECUTE format('SELECT id FROM %I WHERE status = $1', tbl)
    USING 'pending';
```

> [!NOTE] PostgreSQL 18
> `=>` is now also accepted for named cursor arguments[^pg18-named-cursor]. Previously only `:=` was accepted. Both work; new code is free to use `=>` to match function-call syntax.
>
> ```sql
> OPEN c_jobs(p_status => 'pending');   -- PG18+
> ```

`FOR ... IN cursor LOOP` automatically opens and closes a bound cursor:

```sql
FOR rec IN c_jobs('pending') LOOP
    PERFORM handle_job(rec.id);
END LOOP;
```

### `refcursor` Return Values

A function returning `refcursor` hands a named portal back to the caller, which can then `FETCH` from it client-side:

```sql
CREATE FUNCTION jobs_pending(OUT cur refcursor) AS $$
BEGIN
    OPEN cur FOR SELECT id, payload FROM jobs WHERE status = 'pending';
END;
$$ LANGUAGE plpgsql;

BEGIN;
SELECT jobs_pending('cur_a');  -- names the portal explicitly
FETCH 100 FROM cur_a;
-- ...
COMMIT;                         -- closes cur_a automatically
```

For multiple cursors in one call use `RETURNS SETOF refcursor` and `RETURN NEXT` each `refcursor`. If the `refcursor` parameter is `NULL` at `OPEN` time, PG generates a unique portal name.

## Prepared-Statement Mechanics

### `PREPARE` Grammar

```sql
PREPARE name [ ( data_type [, ...] ) ] AS statement
```

Where `statement` is a `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, or `VALUES`[^pg-prep]. Parameters are positional: `$1`, `$2`, …. Type declarations are optional and inferred from context when omitted or declared as `unknown`:

```sql
PREPARE find_user (int) AS
    SELECT * FROM users WHERE id = $1;

PREPARE find_logs AS
    SELECT * FROM users u, logs l
    WHERE u.id = $1 AND u.id = l.user_id AND l.created_at = $2;
-- $2 type inferred at first EXECUTE
```

Key facts:

- **Names are per-session.** *"Prepared statements only last for the duration of the current database session."*[^pg-prep] Reconnecting drops them.
- **No overloading.** Within a session a name maps to one statement; re-`PREPARE`ing a used name is an error.
- **All five DML/SELECT kinds are eligible**, including `MERGE` since PG15.
- The query's *referenced tables and columns must be stable across executions* — you cannot parameterize a table or column identifier through `$N`. (For that, use dynamic SQL — see [`10-dynamic-sql.md`](./10-dynamic-sql.md).)

### `EXECUTE` and Parameter Passing

```sql
EXECUTE name [ ( parameter [, ...] ) ]
```

Parameters bind positionally to `$1`, `$2`, … and must be type-compatible[^pg-exec]. The command tag returned is that of the underlying statement (`SELECT 1`, `INSERT 0 1`, etc.), *not* `EXECUTE`.

> [!WARNING] Two unrelated `EXECUTE` statements share a name
> SQL-level `EXECUTE name (...)` runs a prepared statement. PL/pgSQL `EXECUTE 'string'` runs dynamic SQL. They are not the same surface. The PL/pgSQL `EXECUTE` is covered in [`10-dynamic-sql.md`](./10-dynamic-sql.md).

`EXPLAIN EXECUTE name(params)` shows whether the cached plan in use is generic (parameter symbols `$1`, `$2` in the plan) or custom (actual values substituted).

### `DEALLOCATE` and Session Cleanup

```sql
DEALLOCATE [ PREPARE ] { name | ALL }
```

`PREPARE` is a noise word — `DEALLOCATE x` and `DEALLOCATE PREPARE x` are identical[^pg-dealloc]. `DEALLOCATE ALL` drops every prepared statement in the session.

Prepared statements are automatically dropped at session end, so explicit `DEALLOCATE` is only required when:

- A long-lived connection (especially behind a pooler) is accumulating thousands of prepared statements.
- An application needs to re-`PREPARE` the same name with a different statement body.

### `pg_prepared_statements` View

```sql
SELECT name, statement, from_sql, prepare_time,
       parameter_types, result_types,
       generic_plans, custom_plans
FROM pg_prepared_statements;
```

One row per prepared statement *in the current session*[^pg-prep-view]:

| Column | Meaning |
|---|---|
| `name` | Identifier (or auto-generated for protocol-level) |
| `statement` | The exact SQL text |
| `prepare_time` | When created |
| `parameter_types` | `regtype[]` of `$1`, `$2`, … |
| `result_types` | Column types returned (`NULL` for DML without `RETURNING`) |
| `from_sql` | `true` if from `PREPARE` SQL; `false` if from extended-protocol Parse |
| `generic_plans` | Count of times a generic plan was chosen at `EXECUTE` |
| `custom_plans` | Count of times a custom plan was chosen at `EXECUTE` |

> [!NOTE] PostgreSQL 14
> The `generic_plans` and `custom_plans` columns were added in PG14[^pg14-prep-cols]. This is the primary in-database diagnostic for "is my prepared statement on the generic plan yet?" Pre-PG14 the same information could only be obtained via `auto_explain` or `EXPLAIN EXECUTE`.

The view is per-session — to audit pool-wide prepared-statement bloat you must aggregate via a query per backend or via the pooler's own counters.

## Plan Caching: Generic vs Custom

### The Five-Execution Rule

When a prepared statement is `EXECUTE`d the planner decides whether to use a cached *generic* plan (planned with `$1`/`$2` as symbolic placeholders) or to produce a fresh *custom* plan keyed on this call's parameter values.

The rule, verbatim from `sql-prepare.html`[^pg-prep]:

> The current rule for this is that the first five executions are done with custom plans and the average estimated cost of those plans is calculated. Then a generic plan is created and its estimated cost is compared to the average custom-plan cost. Subsequent executions use the generic plan if its cost is not so much higher than the average custom-plan cost as to make repeated replanning seem preferable.

Translated:

| Execution # | Plan used |
|---|---|
| 1 – 5 | Custom plan, planned with current parameter values |
| 6 | Generic plan created; compared to average of first five custom costs |
| 7+ | Generic plan if generic_cost ≤ avg(custom_cost) + planning_overhead; otherwise custom plan each time |

The decision is **per-EXECUTE**: once enough custom evidence is gathered the planner can choose generic for some calls and custom for others depending on the parameter values' selectivity estimates.

This is why a query slows on the sixth call — the planner switched to a generic plan that picked a Seq Scan because the parameter is no longer known to be highly selective.

### `plan_cache_mode`

> [!NOTE] PostgreSQL 12
> `plan_cache_mode` was introduced in PG12 to override the five-execution heuristic on demand[^pg12-pcm]. Full GUC reference: [`53-server-configuration.md`](./53-server-configuration.md).

```sql
SET plan_cache_mode = 'auto';              -- default
SET plan_cache_mode = 'force_custom_plan'; -- re-plan every call
SET plan_cache_mode = 'force_generic_plan';-- never re-plan
```

From `runtime-config-query.html`[^pg-pcm]: *"This setting is considered when a cached plan is to be executed, not when it is prepared."* So you can flip it between `EXECUTE`s of the same prepared statement.

When to override:

- `force_custom_plan` for highly skewed parameters (e.g. `WHERE status = $1` where `'pending'` is 0.001% of rows but `'archived'` is 90%). Pays the planning cost every call but keeps the right plan shape.
- `force_generic_plan` to confirm a regression: if `force_generic_plan` reproduces the slow plan, the generic-vs-custom switch is your culprit. (Don't leave it forced in production unless you have measured the alternative.)
- `auto` everywhere else.

### PL/pgSQL Embedded SQL Plan Cache

PL/pgSQL maintains an *additional* per-session, per-function plan cache for the SQL statements embedded directly in function bodies. From `plpgsql-implementation.html`[^pg-plpgsql-impl]:

> As each expression and SQL command is first executed in the function, the PL/pgSQL interpreter parses and analyzes the command to create a prepared statement, using the SPI manager's `SPI_prepare` function. Subsequent visits to that expression or command reuse the prepared statement.

That means:

- Embedded SQL in a PL/pgSQL function goes through the same generic-vs-custom plan switching as a SQL-level `PREPARE`.
- The plans are **per-backend, per-session** — a backend that calls a function ten times in a session populates the cache once.
- A `DISCARD PLANS` in that session evicts these embedded plans alongside SQL-level prepared statements.
- `EXECUTE` inside PL/pgSQL (dynamic SQL) **bypasses** the cache and re-plans every call — see [`10-dynamic-sql.md`](./10-dynamic-sql.md).

The `plan_cache_mode` GUC affects embedded-SQL plans too.

### `DISCARD PLANS` vs `DEALLOCATE ALL`

```sql
DISCARD PLANS;     -- evict cached plans; keep prepared statements
DISCARD ALL;       -- everything: cursors, prepares, settings, temp tables, advisory locks
DEALLOCATE ALL;    -- drop prepared statements (their *names* go away)
```

Verbatim semantics[^pg-discard]:

- **`DISCARD PLANS`** — *"Releases all cached query plans, forcing re-planning to occur the next time the associated prepared statement is used."* Prepared-statement names stay defined; only the planner-state behind them is invalidated.
- **`DISCARD ALL`** — *"Releases all temporary resources associated with the current session and resets the session to its initial state."* Equivalent to `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; SELECT pg_advisory_unlock_all(); DISCARD PLANS; DISCARD TEMP; DISCARD SEQUENCES;`. **Cannot run inside a transaction block.**
- **`DEALLOCATE ALL`** — drops the prepared statements themselves; clients need to re-`PREPARE` before next `EXECUTE`.

A connection pooler that resets sessions between checkouts typically runs `DISCARD ALL` on release. If you depend on long-lived prepared statements you need to keep the same physical connection (session pooling), not transaction pooling.

## Protocol-Level Prepared Statements

Two distinct surfaces produce the *same* server-side artifact:

1. **SQL-level** — `PREPARE` / `EXECUTE` / `DEALLOCATE` strings sent over the simple query protocol. `pg_prepared_statements.from_sql = true`.
2. **Protocol-level** — drivers send Parse/Bind/Execute messages on the extended query protocol; the server stores the statement under a name the driver chose (or unnamed). `pg_prepared_statements.from_sql = false`.

Most modern PG drivers (libpq, psycopg2/3, pgjdbc, npgsql, node-postgres) issue Parse implicitly when you call their parameterized-query API. The SQL-level surface is mostly useful inside `psql`, scripts, and stored procedures that build queries dynamically.

> [!NOTE] PostgreSQL 16+ psql `\bind`
> `psql`'s `\bind` meta-command opts a single query into the extended-query protocol so you can test parameter binding from the SQL shell[^pg-psql-bind]:
>
> ```sql
> INSERT INTO tbl1 VALUES ($1, $2) \bind 'first value' 'second value' \g
> ```

> [!NOTE] PostgreSQL 17 protocol-prepared support
> Three new libpq functions land in PG17 for closing portals and prepared statements explicitly: `PQclosePrepared`, `PQclosePortal`, `PQsendClosePrepared`, `PQsendClosePortal`[^pg17-libpq]. Together with pgBouncer 1.21+ this enables transparent **prepared-statement support in transaction-pooling mode** — pgBouncer can now track Parse/Bind/Close per backend and re-prepare across pool members. Previously, prepared statements were a hard-no for pgBouncer's transaction mode. See [`81-pgbouncer.md`](./81-pgbouncer.md) for the pooler-side details.

> [!NOTE] PostgreSQL 18 psql `\parse`/`\bind_named`/`\close_prepared`
> PG18 adds psql meta-commands for the full protocol-level prepared-statement lifecycle from the shell[^pg18-psql-prep]:
>
> ```sql
> SELECT id FROM users WHERE id = $1 \parse stmt_x
> \bind_named stmt_x 42 \g
> \close_prepared stmt_x
> ```
>
> Useful for reproducing driver-prepared-statement behavior without a real client.

## Decision Matrix

| You need | Use | Avoid |
|---|---|---|
| Iterate over a large result set client-side | `DECLARE ... CURSOR FOR ...` inside a transaction, with `FETCH N` batches | Buffering whole result in the client; `SELECT *` without `LIMIT` |
| Return a result set from a function | Function returning `refcursor` or `SETOF record` / `TABLE(...)` | Returning a giant array; PL/pgSQL `RETURN QUERY` is fine for small/medium sets |
| Re-run the same query shape many times in one session | SQL-level `PREPARE` or driver-prepared statement | Re-parsing string SQL each call |
| Page through results forward and backward | `DECLARE SCROLL CURSOR` | Relying on the implicit-scroll backstop — declare it |
| Cursor that outlives the transaction | `WITH HOLD` cursor *only if* the result set is small | `WITH HOLD` over millions of rows — full materialization at `COMMIT` |
| Parameterize an identifier (table, column, schema) | Dynamic SQL with `format()` + `%I` (see [`10-dynamic-sql.md`](./10-dynamic-sql.md)) | `PREPARE` — `$N` cannot stand for identifiers |
| Diagnose "fast first time, slow later" | Inspect `pg_prepared_statements.generic_plans` / `custom_plans`; flip `plan_cache_mode = 'force_custom_plan'` | Guessing — measure first |
| Reset all session state between pool checkouts | `DISCARD ALL` on release | `DEALLOCATE ALL` alone (leaves cursors, advisory locks, temp tables, GUC overrides) |
| Stream a large `SELECT` in psql | `\set FETCH_COUNT 1000` then run the query | Manual `DECLARE`/`FETCH` if `psql` will do it for you |
| Use prepared statements behind a connection pooler | Session pooling, or transaction pooling on pgBouncer 1.21+ with PG17 protocol prepare support | Transaction pooling with SQL-level `PREPARE` on PG < 17 / pgBouncer < 1.21 |

## Examples / Recipes

### Recipe 1 — Batched stream of millions of rows

The canonical "I need to process every row of a huge table without materializing it" pattern. Each `FETCH 1000` round-trip pulls one batch; the cursor is dropped at `COMMIT`.

```sql
BEGIN;
DECLARE c_events CURSOR FOR
    SELECT id, payload
    FROM events
    WHERE created_at >= '2026-01-01'
    ORDER BY id;

-- in a loop, client-side:
FETCH 1000 FROM c_events;
-- … process …
FETCH 1000 FROM c_events;
-- … until FETCH returns 0 rows.

CLOSE c_events;
COMMIT;
```

In `psql`, the equivalent is letting `psql` declare the cursor for you:

```
postgres=# \set FETCH_COUNT 1000
postgres=# SELECT id, payload FROM events WHERE created_at >= '2026-01-01';
```

`FETCH_COUNT` flips `psql` into cursor mode for any query that returns rows.

### Recipe 2 — Hand a result set back to the caller via `refcursor`

```sql
CREATE FUNCTION pending_jobs() RETURNS refcursor AS $$
DECLARE
    cur refcursor;
BEGIN
    OPEN cur FOR
        SELECT id, priority, payload
        FROM jobs
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC;
    RETURN cur;
END;
$$ LANGUAGE plpgsql;

BEGIN;
SELECT pending_jobs();     -- returns the portal name
FETCH 100 FROM "<unnamed portal 1>";
-- …
COMMIT;
```

For predictable naming, pass the portal name in:

```sql
CREATE FUNCTION pending_jobs(p_cur refcursor) RETURNS refcursor AS $$
BEGIN
    OPEN p_cur FOR SELECT id FROM jobs WHERE status = 'pending';
    RETURN p_cur;
END;
$$ LANGUAGE plpgsql;

BEGIN;
SELECT pending_jobs('jobs_cur');
FETCH 100 FROM jobs_cur;
COMMIT;
```

### Recipe 3 — Prepared statement for repeated lookups

```sql
PREPARE find_user (int) AS
    SELECT id, email, status FROM users WHERE id = $1;

EXECUTE find_user(1);
EXECUTE find_user(2);
-- …
DEALLOCATE find_user;   -- optional; session end drops it
```

Reuse pays off when the query is non-trivial to plan and parameter values don't change the optimal plan shape across calls.

### Recipe 4 — Force a generic plan for skip-the-planner short queries

A point-lookup index probe is cheap to plan but cheaper to *not* plan:

```sql
SET plan_cache_mode = 'force_generic_plan';
PREPARE u_by_id (int) AS SELECT * FROM users WHERE id = $1;
EXECUTE u_by_id(42);          -- generic from execution 1
```

If the prepared statement is held by a long-lived backend that runs the same `u_by_id` thousands of times per second, forcing generic skips the per-call plan cost. Don't do this for queries whose plan depends on parameter selectivity.

### Recipe 5 — Force a custom plan for parameter-skewed queries

The status-column example: `'pending'` is highly selective, `'archived'` is not.

```sql
PREPARE jobs_by_status (text) AS
    SELECT id FROM jobs WHERE status = $1;

-- After plan flips generic, this might do a Seq Scan even for status='pending':
SET plan_cache_mode = 'force_custom_plan';
EXECUTE jobs_by_status('pending');     -- custom: Index Scan
EXECUTE jobs_by_status('archived');    -- custom: Seq Scan
```

### Recipe 6 — Inspect plan flip via `pg_prepared_statements`

```sql
PREPARE s1 (int) AS SELECT * FROM users WHERE id = $1;

DO $$
BEGIN
    FOR i IN 1..10 LOOP
        PERFORM (EXECUTE 's1' USING i);   -- via PL — see note below
    END LOOP;
END $$;

SELECT name, generic_plans, custom_plans
FROM pg_prepared_statements
WHERE name = 's1';
```

(For a real session, replace the inner loop with ten `EXECUTE s1(1..10);` lines; the PL `PERFORM` here is illustrative. The `pg_prepared_statements.generic_plans` counter advances starting around execution six on `auto`.)

### Recipe 7 — Cursor over a dynamic query

```sql
CREATE FUNCTION sample_table_first_n(p_table regclass, p_n int)
RETURNS SETOF record AS $$
DECLARE
    cur refcursor;
    rec record;
BEGIN
    OPEN cur FOR EXECUTE format(
        'SELECT * FROM %s LIMIT $1', p_table
    ) USING p_n;

    LOOP
        FETCH cur INTO rec;
        EXIT WHEN NOT FOUND;
        RETURN NEXT rec;
    END LOOP;

    CLOSE cur;
END;
$$ LANGUAGE plpgsql;
```

Identifier substitution goes through `format(%s, p_table::text)` (with `regclass` providing safe quoting); values go through the `USING` clause. See [`10-dynamic-sql.md`](./10-dynamic-sql.md) for the full hardening rules.

### Recipe 8 — Holdable cursor for chunked DML across COMMITs

Common in a procedure that wants to commit after each batch:

```sql
CREATE PROCEDURE archive_old_events() LANGUAGE plpgsql AS $$
DECLARE
    cur CURSOR WITH HOLD FOR
        SELECT id FROM events
        WHERE created_at < now() - interval '90 days'
        ORDER BY id
        LIMIT 1000000;       -- bound the materialization
    rec record;
    cnt int := 0;
BEGIN
    OPEN cur;
    COMMIT;                  -- materializes cursor

    LOOP
        FETCH cur INTO rec;
        EXIT WHEN NOT FOUND;
        DELETE FROM events WHERE id = rec.id;
        cnt := cnt + 1;
        IF cnt % 1000 = 0 THEN
            COMMIT;          -- cursor stays open across commits
        END IF;
    END LOOP;

    CLOSE cur;
    COMMIT;
END;
$$;
```

The `LIMIT` on the cursor's query is essential — without it, the `WITH HOLD` materialization at the first `COMMIT` copies the entire archive candidate set into temp storage. See [`07-procedures.md`](./07-procedures.md) for the broader chunked-DML pattern.

### Recipe 9 — Audit a session for prepared-statement bloat

A long-lived backend behind a connection pooler can accumulate thousands of prepared statements. Check from inside that session:

```sql
SELECT count(*) AS n,
       sum(length(statement)) AS bytes,
       max(prepare_time) AS most_recent
FROM pg_prepared_statements;

-- Top by frequency-of-generic-plan, useful for plan-cache regression hunting:
SELECT name, generic_plans, custom_plans, statement
FROM pg_prepared_statements
ORDER BY generic_plans DESC
LIMIT 20;
```

A persistent backend with > 10,000 prepared statements is a sign that a driver is creating named prepares per query *body* (rather than reusing names). Flip to driver-managed unnamed prepare or set a driver-level cap.

### Recipe 10 — Reset per-pool-checkout state

For a session-pooled connection that may have inherited cursors, prepared statements, advisory locks, temp tables, and GUC overrides:

```sql
DISCARD ALL;
```

This is what most poolers run on release. `DISCARD ALL` cannot run inside a transaction block — make sure the pool wrapper commits/rollbacks first.

### Recipe 11 — Bound cursor with parameters (PL/pgSQL)

```sql
CREATE FUNCTION queue_take(p_status text, p_limit int)
RETURNS TABLE(id bigint) AS $$
DECLARE
    c_jobs CURSOR (p_st text, p_lim int) FOR
        SELECT j.id FROM jobs j
        WHERE j.status = p_st
        ORDER BY j.priority DESC
        LIMIT p_lim
        FOR UPDATE SKIP LOCKED;
BEGIN
    FOR rec IN c_jobs(p_status, p_limit) LOOP
        UPDATE jobs SET status = 'claimed' WHERE jobs.id = rec.id;
        id := rec.id;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

PG18 callers can write `c_jobs(p_st => p_status, p_lim => p_limit)`. Pre-PG18 use `:=` for named arguments.

### Recipe 12 — Re-fetch the current row (`RELATIVE 0`)

When iterating through a `SCROLL` cursor and you need to "peek again" at the row currently positioned on, e.g. to re-run a volatile function with deterministic re-materialization:

```sql
BEGIN;
DECLARE c SCROLL CURSOR WITH HOLD FOR
    SELECT id, random() AS r FROM events ORDER BY id LIMIT 100;
COMMIT;            -- materializes, freezing the random() values

FETCH NEXT FROM c;
FETCH RELATIVE 0 FROM c;   -- same row, same r (because materialized)
FETCH PRIOR FROM c;
FETCH RELATIVE 0 FROM c;   -- prior row, again identical
CLOSE c;
```

Without `WITH HOLD`, the volatile-function caveat from `sql-declare.html`[^pg-decl] kicks in and `random()` may produce different values on re-fetch.

## Gotchas / Anti-patterns

1. **Forward-only by default, even after `SCROLL`-without-asking happens to work.** Default cursors are forward-only; the implicit-scroll backstop *"if the cursor's query plan is simple enough"*[^pg-decl] is an implementation detail, not a guarantee. Declare `SCROLL` if you ever fetch backward.

2. **`WITH HOLD` cursors materialize everything at `COMMIT`.** This is the single biggest cursor footgun. A `WITH HOLD` cursor over `SELECT * FROM huge_table` will copy the *entire* remaining result set into temp storage at `COMMIT`. Bound the cursor's query with `LIMIT` or convert to a non-holdable in-transaction cursor.

3. **`pg_cursors` shows the current backend only.** No cluster-wide view exists. To audit holdable cursors across a pool you must query each backend, or use the pooler's introspection.

4. **`ABSOLUTE 0` is not the first row.** It positions *before* the first row and returns nothing — `FIRST` (or `ABSOLUTE 1`) is what callers usually mean.

5. **Volatile functions in scrollable cursors re-fire on re-fetch.** Predicate functions, `random()`, `now()` (well, `now()` is stable inside a transaction but the principle holds for `clock_timestamp()`), nextval — re-fetching can re-run them. `SCROLL WITH HOLD` + commit-before-read is the determinism fix.

6. **Cursor named twice in a session.** Re-`DECLARE`ing a cursor name without closing the prior cursor is an error. Use a generated name or `CLOSE` first.

7. **Closure is not transactional.** A `CLOSE` issued inside a savepoint that later rolls back does **not** un-close the cursor[^pg-close]. Treat closure as commit-immediately even mid-transaction.

8. **`PREPARE` is per-session and per-connection.** Behind a connection pooler in transaction mode, every checkout potentially lands on a different backend. SQL-level `PREPARE` does not survive that checkout. Use session pooling, or PG17+ pgBouncer 1.21+ protocol-level prepared-statement support.

9. **Generic-plan regression on the sixth call.** A query that's fast through the first five `EXECUTE`s then slows down has flipped to a generic plan whose selectivity estimate doesn't fit your parameters. Verify with `EXPLAIN EXECUTE`; fix with `plan_cache_mode = 'force_custom_plan'` (or rewrite to use literals).

10. **`$N` cannot be a table, column, or schema identifier.** `PREPARE x AS SELECT * FROM $1` is a syntax error. Use dynamic SQL with `%I` (see [`10-dynamic-sql.md`](./10-dynamic-sql.md)).

11. **`DISCARD ALL` is forbidden inside a transaction block.** From `sql-discard.html`[^pg-discard]: *"DISCARD ALL cannot be executed inside a transaction block."* Apply it on connection release, outside any open transaction.

12. **`DEALLOCATE ALL` leaves cursors, advisory locks, temp tables, GUC overrides, and listeners.** It only drops prepared statements. For a true session reset use `DISCARD ALL`.

13. **PL/pgSQL embedded SQL is cached per-backend, per-session.** A function's plans are populated on the first call in each backend, not globally. Hot-path functions in a connection-poolwarm-up routine sometimes need a no-op pre-call to populate the cache.

14. **`EXECUTE` (PL/pgSQL) ≠ `EXECUTE` (SQL).** PL/pgSQL `EXECUTE 'string' USING ...` runs dynamic SQL and *re-plans every call*[^pg-plpgsql-impl]. SQL-level `EXECUTE prep_name(...)` runs a cached plan. Mixing them up in mental model is one of the top sources of "why is my query slow under high concurrency?" mistakes.

15. **`pg_prepared_statements.generic_plans`/`custom_plans` are PG14+.** Pre-PG14 the only way to see which plan was used is `EXPLAIN EXECUTE` or `auto_explain` with `log_min_duration = 0` and `log_nested_statements = on`. Plan diagnosing on PG13 and older is materially harder.

16. **`force_generic_plan` does not pre-plan eagerly.** From `runtime-config-query.html`[^pg-pcm]: *"This setting is considered when a cached plan is to be executed, not when it is prepared."* The first `EXECUTE` is still custom-planned to seed the cache; from execution two onwards it's generic. Set it before the *executions*, not before the `PREPARE`, if you care.

17. **`FOR UPDATE` cursor must be inside the same transaction as the `WHERE CURRENT OF`.** Holdable + updatable is forbidden by the grammar; even a non-holdable cursor's row locks are released at `COMMIT`. If you `COMMIT` mid-iteration the `WHERE CURRENT OF` will error.

## See Also

- [`07-procedures.md`](./07-procedures.md) — Chunked DML with periodic `COMMIT` and holdable-cursor materialization.
- [`08-plpgsql.md`](./08-plpgsql.md) — Cursors at the PL/pgSQL fluent level (`FOR rec IN cursor LOOP`, `RETURN QUERY`).
- [`10-dynamic-sql.md`](./10-dynamic-sql.md) — `EXECUTE 'string'` (the PL/pgSQL one) and why it re-plans; `format()` + `%I` for identifier substitution.
- [`56-explain.md`](./56-explain.md) — `EXPLAIN EXECUTE` reading; recognizing generic-plan parameter symbols in plans.
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — Per-statement timing aggregated across prepared and ad-hoc forms.
- [`59-planner-tuning.md`](./59-planner-tuning.md) — When parameter-skewed queries warrant `plan_cache_mode` overrides.
- [`80-connection-pooling.md`](./80-connection-pooling.md) — Session vs transaction pooling and the prepared-statement implications.
- [`81-pgbouncer.md`](./81-pgbouncer.md) — Transaction-mode prepared-statement support with PG17+ libpq.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_cursors` and `pg_prepared_statements` alongside the rest of the catalog exploration surface.

## Sources

[^pg-decl]: PostgreSQL 16 — `DECLARE`. <https://www.postgresql.org/docs/16/sql-declare.html>. Quoted: *"All cursors are insensitive; so these key words have no effect and are only accepted for compatibility with the SQL standard"*; *"The default is to allow scrolling in some cases; this is not the same as specifying `SCROLL`. PostgreSQL will allow backward fetches without `SCROLL`, if the cursor's query plan is simple enough that no extra overhead is needed to support it"*; *"the cursor created by this command can only be used within the current transaction"*; *"the cursor can continue to be used after the transaction that created it successfully commits"*; *"In the current implementation, the rows represented by a held cursor are copied into a temporary file or memory area so that they remain available for subsequent transactions"*; *"Scrollable cursors may give unexpected results if they invoke any volatile functions"*.

[^pg-fetch]: PostgreSQL 16 — `FETCH`. <https://www.postgresql.org/docs/16/sql-fetch.html>. Direction table verified verbatim; `ABSOLUTE 0` positions before the first row, `RELATIVE 0` re-fetches the current row.

[^pg-move]: PostgreSQL 16 — `MOVE`. <https://www.postgresql.org/docs/16/sql-move.html>. Quoted: *"`MOVE` repositions a cursor without retrieving any data. `MOVE` works exactly like the `FETCH` command, except it only positions the cursor and does not return rows."*; return tag *"MOVE count"*.

[^pg-close]: PostgreSQL 16 — `CLOSE`. <https://www.postgresql.org/docs/16/sql-close.html>. Quoted: non-holdable cursors auto-closed at `COMMIT`/`ROLLBACK`; *"If a cursor is closed after a savepoint that is later rolled back, the `CLOSE` is not rolled back—the cursor remains closed."*; `CLOSE ALL` is a PostgreSQL extension.

[^pg-cursors-view]: PostgreSQL 16 — `pg_cursors`. <https://www.postgresql.org/docs/16/view-pg-cursors.html>. Columns: `name`, `statement`, `is_holdable`, `is_binary`, `is_scrollable`, `creation_time`.

[^pg-plpgsql-cur]: PostgreSQL 16 — PL/pgSQL Cursors. <https://www.postgresql.org/docs/16/plpgsql-cursors.html>. Bound-cursor declaration grammar, `OPEN`/`FETCH`/`MOVE`/`CLOSE` variants, `OPEN ... FOR EXECUTE ... USING`, `refcursor` return type.

[^pg-prep]: PostgreSQL 16 — `PREPARE`. <https://www.postgresql.org/docs/16/sql-prepare.html>. Quoted: *"Prepared statements only last for the duration of the current database session. When the session ends, the prepared statement is forgotten, so it must be recreated before being used again."*; *"The current rule for this is that the first five executions are done with custom plans and the average estimated cost of those plans is calculated. Then a generic plan is created and its estimated cost is compared to the average custom-plan cost. Subsequent executions use the generic plan if its cost is not so much higher than the average custom-plan cost as to make repeated replanning seem preferable."*

[^pg-exec]: PostgreSQL 16 — `EXECUTE`. <https://www.postgresql.org/docs/16/sql-execute.html>. Positional parameter binding; command tag is the underlying statement's tag.

[^pg-dealloc]: PostgreSQL 16 — `DEALLOCATE`. <https://www.postgresql.org/docs/16/sql-deallocate.html>. `PREPARE` keyword is optional and ignored; `DEALLOCATE ALL` drops all session-scoped prepared statements.

[^pg-prep-view]: PostgreSQL 16 — `pg_prepared_statements`. <https://www.postgresql.org/docs/16/view-pg-prepared-statements.html>. Columns: `name`, `statement`, `prepare_time`, `parameter_types`, `result_types`, `from_sql`, `generic_plans`, `custom_plans`.

[^pg-discard]: PostgreSQL 16 — `DISCARD`. <https://www.postgresql.org/docs/16/sql-discard.html>. Quoted: *"Releases all cached query plans, forcing re-planning to occur the next time the associated prepared statement is used."* (PLANS); *"Releases all temporary resources associated with the current session and resets the session to its initial state."* (ALL); *"DISCARD ALL cannot be executed inside a transaction block."*

[^pg-pcm]: PostgreSQL 16 — `plan_cache_mode` GUC in `runtime-config-query.html`. <https://www.postgresql.org/docs/16/runtime-config-query.html>. Allowed values: `auto` (default), `force_custom_plan`, `force_generic_plan`. Quoted: *"This setting is considered when a cached plan is to be executed, not when it is prepared."*

[^pg12-pcm]: PostgreSQL 12 release notes — Optimizer. <https://www.postgresql.org/docs/release/12.0/>. Quoted: *"Allow control over when generic plans are used for prepared statements (Pavel Stehule). This is controlled by the `plan_cache_mode` server parameter."*

[^pg-plpgsql-impl]: PostgreSQL 16 — PL/pgSQL Implementation Notes. <https://www.postgresql.org/docs/16/plpgsql-implementation.html>. Quoted: *"As each expression and SQL command is first executed in the function, the PL/pgSQL interpreter parses and analyzes the command to create a prepared statement, using the SPI manager's `SPI_prepare` function. Subsequent visits to that expression or command reuse the prepared statement."*; *"If a cached plan is not used, then a fresh execution plan is generated on each visit to the statement, and the current parameter values (that is, PL/pgSQL variable values) can be used to optimize the selected plan. If the statement has no parameters, or is executed many times, the SPI manager will consider creating a generic plan that is not dependent on specific parameter values, and caching that for re-use."*

[^pg14-prep-cols]: PostgreSQL 14 release notes — System Views. <https://www.postgresql.org/docs/release/14.0/>. Quoted: *"Add columns to `pg_prepared_statements` to report generic and custom plan counts (Atsushi Torikoshi, Kyotaro Horiguchi)."*

[^pg17-libpq]: PostgreSQL 17 release notes — Additional Modules / libpq. <https://www.postgresql.org/docs/release/17.0/>. Quoted: *"Add libpq functions to close portals and prepared statements (Jelte Fennema-Nio). The functions are `PQclosePrepared()`, `PQclosePortal()`, `PQsendClosePrepared()`, and `PQsendClosePortal()`."*

[^pg18-named-cursor]: PostgreSQL 18 release notes — Functions. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Allow `=>` syntax for named cursor arguments in PL/pgSQL (Pavel Stehule). We previously only accepted `:=`."*

[^pg18-psql-prep]: PostgreSQL 18 release notes — psql. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Allow psql to parse, bind, and close named prepared statements (Anthonin Bonnefoy, Michael Paquier). This is accomplished with new commands `\parse`, `\bind_named`, and `\close_prepared`."*

[^pg-psql-bind]: PostgreSQL 16 — psql `\bind` meta-command. <https://www.postgresql.org/docs/16/app-psql.html>. Quoted: *"Sets query parameters for the next query execution, with the specified parameters passed for any parameter placeholders ($1 etc.). … This command causes the extended query protocol … to be used, unlike normal psql operation, which uses the simple query protocol."*

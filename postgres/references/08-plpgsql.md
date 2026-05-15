# PL/pgSQL — PostgreSQL's Native Procedural Language

PL/pgSQL is the in-core procedural language for writing functions, procedures, and trigger
bodies. It is a thin, server-side scripting layer wrapped around SQL: every statement in a
PL/pgSQL block is either an SQL statement (sent to the executor through SPI) or a
flow-control construct (IF / LOOP / EXCEPTION). Understanding the wrapper is the difference
between code that is correct, fast, and safe and code that hides bugs behind plan-cache
quirks, subtransaction churn, and silent SQL injection.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [The PL/pgSQL Mental Model](#the-plpgsql-mental-model)
- [Block Structure](#block-structure)
- [Variable Declarations](#variable-declarations)
- [Assignment and Expression Evaluation](#assignment-and-expression-evaluation)
- [SQL Statements Inside PL/pgSQL](#sql-statements-inside-plpgsql)
- [Control Structures](#control-structures)
- [RAISE and ASSERT](#raise-and-assert)
- [Exception Handling](#exception-handling)
- [Cursors](#cursors)
- [Dynamic SQL](#dynamic-sql)
- [Returning Sets](#returning-sets)
- [Plan Caching and Variable Substitution](#plan-caching-and-variable-substitution)
- [Triggers and Special Variables](#triggers-and-special-variables)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Use this file when you are:

- Writing a `LANGUAGE plpgsql` function, procedure, or trigger body
- Choosing between PL/pgSQL and a richer procedural language ([09-procedural-languages.md](./09-procedural-languages.md))
- Diagnosing exception-block subtransaction churn, plan-cache regressions, or
  `variable_conflict` errors in PL/pgSQL code
- Building dynamic SQL (use [10-dynamic-sql.md](./10-dynamic-sql.md) for the deep injection-prevention
  treatment)
- Iterating with cursors over a large result set without materializing it in memory
- Mapping `EXCEPTION WHEN ...` blocks onto SQLSTATE error codes

For everything *around* PL/pgSQL — function attributes (volatility, parallel safety,
SECURITY DEFINER, STRICT) — see [06-functions.md](./06-functions.md). For procedures and
transaction control inside server-side code see [07-procedures.md](./07-procedures.md).


## The PL/pgSQL Mental Model

A PL/pgSQL function body is not interpreted statement-by-statement against the database.
At first call, the body is parsed once into an internal instruction tree. Every embedded SQL
expression and SQL command is *separately* prepared on first reach via SPI, and the prepared
plan is then cached for the lifetime of the session. Subsequent calls of the same function
re-execute the cached plans, optionally regenerating per-call custom plans when parameter
values change the optimal plan shape.[^impl]

Four consequences follow from this model:

1. **Variable references in embedded SQL are bind parameters, not text substitution.**
   You cannot use a variable for an identifier (table or column name) — only for a data
   value. For dynamic identifiers you must use [`EXECUTE`](#dynamic-sql) and a string-building
   helper such as `format()`.[^impl]
2. **`'now'`-style constants are frozen at plan time.** A literal `'now'::timestamp` in
   embedded SQL is converted at plan time and never re-evaluated; use `now()` /
   `current_timestamp` instead.[^impl]
3. **An `EXCEPTION` clause makes the enclosing block a subtransaction.** Entering the
   block writes an internal savepoint; rolling back at exception time releases it. Tight
   loops with per-iteration `EXCEPTION` blocks burn through the `subtrans` SLRU and the
   32-bit XID space (see [27-mvcc-internals.md](./27-mvcc-internals.md) and
   [29-transaction-id-wraparound.md](./29-transaction-id-wraparound.md)).[^structure]
4. **Trigger functions cache per (function, table).** A trigger attached to two tables
   maintains two plan caches — useful if column names overlap but types differ.[^impl]

> [!NOTE] PostgreSQL 16
> Bound cursor variables are now initialized to `null` rather than to their own name. To
> restore the prior behavior, assign the desired portal name to the variable before
> `OPEN`.[^pg16-cursor]

> [!NOTE] PostgreSQL 14
> PL/pgSQL's expression and assignment parser was rewritten. The visible payoff:
> assignment to array slices and nested record fields now works
> (`v_arr[1:3] := ...`, `v_rec.sub.field := ...`). `RETURN QUERY` can now execute its
> query in parallel. Repeated `CALL`s inside a procedure are noticeably faster.[^pg14]


## Block Structure

A PL/pgSQL function body is a single block; blocks nest freely:

    [ <<label>> ]
    [ DECLARE
        declarations ]
    BEGIN
        statements
    [ EXCEPTION
        WHEN condition [ OR condition ... ] THEN
            handler_statements
        [ WHEN ... ] ]
    END [ label ];

Rules from the docs:[^structure]

- Each declaration and each statement is terminated by a semicolon, **including** `END;`
  for nested blocks; the outermost `END` of the function body does **not** require one
  (the `$$` terminator closes it).
- No semicolon after `BEGIN` — a frequent typo.
- Labels are optional. When present, the label after `END` must match the one before
  `BEGIN`.
- A label allows `EXIT label;` and `CONTINUE label;` to target a specific enclosing loop
  or block, and lets variable references be qualified (`outerblock.quantity`) to
  disambiguate from a same-named inner declaration.

Every PL/pgSQL function body has an implicit *outer block* labeled with the function
name. That outer block declares function parameters and the magic boolean `FOUND`. To
reference a parameter through the function name (e.g., to escape a same-named inner
variable), write `myfunc.argname`.[^structure]


### Nested blocks and variable shadowing

The canonical example from the docs:[^structure]

    CREATE FUNCTION somefunc() RETURNS integer AS $$
    << outerblock >>
    DECLARE
        quantity integer := 30;
    BEGIN
        RAISE NOTICE 'Quantity here is %', quantity;  -- 30
        quantity := 50;
        DECLARE
            quantity integer := 80;
        BEGIN
            RAISE NOTICE 'Quantity here is %', quantity;            -- 80
            RAISE NOTICE 'Outer quantity here is %', outerblock.quantity;  -- 50
        END;
        RAISE NOTICE 'Quantity here is %', quantity;  -- 50
        RETURN quantity;
    END;
    $$ LANGUAGE plpgsql;


## Variable Declarations

Variables live in the `DECLARE` section. Syntax:[^decl]

    name [ CONSTANT ] type [ COLLATE collation_name ] [ NOT NULL ] [ { DEFAULT | := | = } expression ];

The four interesting forms beyond plain scalars:

| Form | Effect |
|---|---|
| `var tbl.col%TYPE` | Same type as the named column; auto-tracks the column |
| `rec tbl%ROWTYPE` | Composite of all columns in declaration order |
| `rec RECORD` | Polymorphic row; shape assigned at first assignment |
| `var int CONSTANT := 0` | Cannot be reassigned within the block |
| `var int NOT NULL := 0` | Rejects null assignment; requires a non-null default |

Defaults are evaluated **at every block entry**, not once per function call. A `now()` default
will produce the timestamp at which the block was entered.[^decl]

A bare `ALIAS FOR $1` (or `ALIAS FOR another_name`) creates an alternate name; the canonical
modern style is to use named parameters in the `CREATE FUNCTION` signature instead. The one
remaining use case is renaming the magic trigger pseudo-records:

    -- Inside a trigger function
    DECLARE
        prior   ALIAS FOR old;
        updated ALIAS FOR new;
    BEGIN ...

> [!NOTE] PostgreSQL 14
> Array-slice and nested-record assignment is allowed:
> `v_arr[1:3] := ARRAY[10,11,12];` and `v_rec.payload.user_id := 42;`.[^pg14]


## Assignment and Expression Evaluation

Three legal assignment operators: `=`, `:=`, and `DEFAULT`. They are interchangeable.
Idiomatic style uses `:=` for assignment inside the body and `DEFAULT` (or `:=`) for
initial values in the `DECLARE` section.

Every PL/pgSQL expression is a *full SQL `SELECT` expression*: `v := upper(name);`
is internally `SELECT upper(name);` against the current variable bindings. The implication
is that any SQL function — including aggregates, set-returning functions, and CTEs — is
legal on the right-hand side, and the same plan caching rules apply.[^impl]

Variable substitution happens only where a data value is grammatically permitted:

    INSERT INTO foo (foo) VALUES (foo(foo));
    --             |        |         |
    --        column name   func     value position → THIS one substitutes

When a name could mean a variable *or* a column, PL/pgSQL raises an ambiguity error by
default. Resolve by:[^impl]

1. **Renaming the variable** (convention: prefix with `v_`); or
2. **Qualifying**: `users.id` for the column, `outerblock.id` for the variable; or
3. **Setting `plpgsql.variable_conflict`** globally or per-function:

       CREATE FUNCTION ... AS $$
       #variable_conflict use_variable     -- or use_column, or error (default)
       DECLARE ...

The `use_column` setting is meant for Oracle PL/SQL migration; default new code to
`error` and qualify by hand.


## SQL Statements Inside PL/pgSQL

A bare SQL statement (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`) runs as itself; you
cannot use `SELECT` alone for its side effects, because PL/pgSQL expects results. Three
patterns cover the practical cases:[^stmt]

| Goal | Syntax |
|---|---|
| Read at most one row into variables | `SELECT col INTO v_col FROM ... WHERE ...;` |
| Read exactly one row | `SELECT col INTO STRICT v_col FROM ... WHERE ...;` |
| Run a statement and discard rows | `PERFORM expr;` (executes a `SELECT` and ignores rows) |
| Capture rows modified by DML | `UPDATE ... RETURNING col INTO v_col;` |
| Count rows affected by the most recent SQL command | `GET DIAGNOSTICS v_count = ROW_COUNT;` |

Without `STRICT`, `SELECT INTO` discards extra rows silently (and sets `FOUND` true);
with `STRICT` it raises `no_data_found` for zero rows or `too_many_rows` for more than
one. Always use `STRICT` if "exactly one" is part of the invariant — `SELECT INTO` without
it is a foot-cannon for non-deterministic results.

`FOUND` is `boolean` and reset to `false` at function entry, then updated by:[^stmt]

- `SELECT INTO`, `PERFORM` — true if any row was returned
- `INSERT`/`UPDATE`/`DELETE`/`MERGE` — true if any row was affected
- `FETCH`, `MOVE` — true if the cursor moved/returned a row
- `FOR`/`FOREACH` loops — true if the loop ran at least once
- `RETURN QUERY` / `RETURN QUERY EXECUTE` — true if any row was returned

`GET DIAGNOSTICS` retrieves the latest SQL command's status. Inside the `EXCEPTION`
clause, `GET STACKED DIAGNOSTICS` retrieves the *caught* error's details.[^errors]

> [!NOTE] PostgreSQL 16
> `GET DIAGNOSTICS v := PG_ROUTINE_OID;` returns the OID of the currently executing
> function — useful for centralized logging that needs to identify the caller without
> hard-coding the function name.[^pg16-oid]


## Control Structures

PL/pgSQL implements the usual structured-control set, with the SQL twist that every
condition is a full SQL boolean expression.[^control]

### Conditionals

    IF cond THEN ... ELSIF cond THEN ... ELSE ... END IF;

    -- Simple CASE: value match
    CASE x
        WHEN 1, 3, 5 THEN ...
        WHEN 2, 4    THEN ...
        ELSE              ...
    END CASE;

    -- Searched CASE: boolean match
    CASE
        WHEN x < 0  THEN ...
        WHEN x = 0  THEN ...
        ELSE             ...
    END CASE;

If no branch matches and no `ELSE` is present, `CASE` raises `CASE_NOT_FOUND` (P0003 in
the same class as `too_many_rows` — verify with `errcodes-appendix.html`).

### Loops

The four loop forms:[^control]

    -- 1. Unconditional
    [ <<label>> ]
    LOOP
        EXIT WHEN cond;            -- or EXIT label WHEN cond;
        CONTINUE WHEN cond;        -- or CONTINUE label WHEN cond;
    END LOOP [ label ];

    -- 2. WHILE
    WHILE cond LOOP ... END LOOP;

    -- 3. Integer FOR (loop variable auto-declared)
    FOR i IN 1..100 LOOP ... END LOOP;
    FOR i IN REVERSE 100..1 BY 5 LOOP ... END LOOP;   -- i = 100, 95, 90, ...

    -- 4. Query FOR (rec auto-declared as RECORD)
    FOR rec IN SELECT ... LOOP ... END LOOP;
    FOR rec IN EXECUTE 'SELECT ...' USING $1, $2 LOOP ... END LOOP;

The query-FOR variant accepts any SQL command that produces rows, including
`INSERT ... RETURNING`, `UPDATE ... RETURNING`, `DELETE ... RETURNING`, and PG17+
`MERGE ... RETURNING` ([03-syntax-dml.md](./03-syntax-dml.md)). The loop variable is auto-declared as
`RECORD` if it doesn't already exist.

### Array iteration

    FOREACH x IN ARRAY $1 LOOP ... END LOOP;            -- scalar element
    FOREACH row SLICE 1 IN ARRAY $1 LOOP ... END LOOP;  -- one-D row of a 2-D array


## RAISE and ASSERT

`RAISE` emits a message or raises an error. Five syntactic forms:[^errors]

    RAISE [ level ] 'fmt %', arg1, arg2 [ USING option = expr, ... ];
    RAISE [ level ] condition_name [ USING ... ];
    RAISE [ level ] SQLSTATE 'xxxxx' [ USING ... ];
    RAISE [ level ] USING ... ;
    RAISE ;     -- re-throw, only inside an EXCEPTION clause

Levels in order of severity: `DEBUG`, `LOG`, `INFO`, `NOTICE`, `WARNING`, `EXCEPTION`
(default). Anything below `EXCEPTION` is suppressed by `client_min_messages` /
`log_min_messages`.

The format string uses `%` as the next-argument placeholder; `%%` emits a literal `%`.
The `USING` clause attaches structured fields:

| Option | Purpose |
|---|---|
| `MESSAGE` | Primary message text (mutually exclusive with the format-string form) |
| `DETAIL`, `HINT` | Secondary lines |
| `ERRCODE` | Condition name (`'unique_violation'`) or 5-char SQLSTATE (`'23505'`) |
| `COLUMN`, `CONSTRAINT`, `DATATYPE`, `TABLE`, `SCHEMA` | Names of related objects |

Custom SQLSTATEs use the unassigned class `P0xxx` (the docs recommend codes that do not
end in three zeroes, since those are reserved for class-level defaults).[^errors]

`ASSERT` is a debug-only equivalent of `RAISE` that fires `ASSERT_FAILURE` if its
boolean condition is false or null. Toggle with `plpgsql.check_asserts` (default `on`).
Treat `ASSERT` as a programmer-bug detector — for ordinary error conditions reach for
`RAISE EXCEPTION`.[^errors]


## Exception Handling

An `EXCEPTION` block at the end of a `BEGIN ... END` introduces a savepoint-style
subtransaction. If any statement inside the `BEGIN ... END` raises an error, all
database changes made inside that block are rolled back and control transfers to the
matching `WHEN` clause.[^control][^structure]

    BEGIN
        statements;
    EXCEPTION
        WHEN condition_a [ OR condition_b ... ] THEN
            handler_a;
        WHEN OTHERS THEN
            handler_default;
    END;

Condition names are SQLSTATE labels from `errcodes-appendix.html`. The high-traffic ones:[^errcodes]

| SQLSTATE | Condition | Use case |
|---|---|---|
| `23505` | `unique_violation` | Upsert race; duplicate key |
| `23503` | `foreign_key_violation` | Referencing missing parent |
| `23502` | `not_null_violation` | Inserting null into NOT NULL column |
| `23514` | `check_violation` | Failed CHECK constraint |
| `22012` | `division_by_zero` | Pure-SQL math |
| `P0001` | `raise_exception` | Default for `RAISE EXCEPTION` without ERRCODE |
| `P0002` | `no_data_found` | `SELECT INTO STRICT` returned zero rows |
| `P0003` | `too_many_rows` | `SELECT INTO STRICT` returned multiple rows |
| `P0004` | `assert_failure` | `ASSERT` condition failed |
| `40P01` | `deadlock_detected` | Lock cycle resolved by killing this transaction |
| `40001` | `serialization_failure` | SSI conflict; retry the whole transaction |

`OTHERS` catches everything *except* `QUERY_CANCELED` and `ASSERT_FAILURE`. This is
deliberate — you almost never want to swallow a user-initiated cancel.

Inside the handler:

    GET STACKED DIAGNOSTICS
        v_state   = RETURNED_SQLSTATE,
        v_msg     = MESSAGE_TEXT,
        v_detail  = PG_EXCEPTION_DETAIL,
        v_hint    = PG_EXCEPTION_HINT,
        v_context = PG_EXCEPTION_CONTEXT,
        v_table   = TABLE_NAME,
        v_col     = COLUMN_NAME,
        v_con     = CONSTRAINT_NAME;

The shortcut magic variables `SQLSTATE` and `SQLERRM` are available *only* inside an
exception handler.

> [!WARNING] Exception blocks are not free
> See mental model rule 3 and gotcha #1 for the subtransaction cost details and remediation patterns.


### Retry on serialization failure (canonical pattern)

    BEGIN
        -- Application-side retry loop calls this function up to N times.
        ...
    EXCEPTION
        WHEN serialization_failure THEN
            -- Don't handle inside the function; re-raise so the caller retries.
            RAISE;
        WHEN deadlock_detected THEN
            RAISE;
    END;

Handling serialization failure *inside* a function is almost always wrong: the
transaction must be retried in its entirety to get a fresh snapshot. See
[42-isolation-levels.md](./42-isolation-levels.md).


## Cursors

A cursor is a server-side portal that streams query rows on demand. PL/pgSQL exposes
them through the `refcursor` type and three syntactic forms:[^cursors]

    DECLARE
        c_unbound  refcursor;                                         -- bound at OPEN
        c_bound    CURSOR FOR SELECT * FROM orders WHERE shipped;     -- bound at declare
        c_param    CURSOR (since timestamptz) FOR
                       SELECT * FROM orders WHERE placed_at >= since;  -- parameterized

    OPEN c_unbound FOR SELECT id FROM users WHERE active;
    OPEN c_unbound FOR EXECUTE format('SELECT id FROM %I', tabname) USING ...;
    OPEN c_param(now() - interval '7 days');

    FETCH NEXT FROM c_unbound INTO v_id;
    FETCH RELATIVE -2 FROM c_unbound INTO v_id;
    MOVE FORWARD 10 IN c_unbound;
    CLOSE c_unbound;

> [!NOTE] PostgreSQL 18
> Named cursor arguments accept `=>` in addition to `:=`:
> `OPEN c_param(since => now() - interval '7 days');`[^pg18-cursor-arg]

### FOR row IN cursor LOOP

The most idiomatic pattern — auto-opens and auto-closes:

    DECLARE
        c_orders CURSOR FOR SELECT id, total FROM orders WHERE shipped;
        rec RECORD;
    BEGIN
        FOR rec IN c_orders LOOP
            -- process rec.id, rec.total
        END LOOP;
    END;

The same shape works against a bare query without a `CURSOR` declaration:

    FOR rec IN SELECT id, total FROM orders LOOP ... END LOOP;

In both cases, PL/pgSQL fetches rows in batches (governed by `cursor_tuple_fraction`).
The function never holds the entire result set in memory.

### Returning a cursor to the caller

A `LANGUAGE plpgsql` function whose `RETURNS refcursor` returns the **portal name**
(a string). The caller — on the same transaction — fetches from it by name:

    CREATE FUNCTION open_orders_for(p_user int)
    RETURNS refcursor AS $$
    DECLARE
        c refcursor;
    BEGIN
        OPEN c FOR SELECT * FROM orders WHERE user_id = p_user;
        RETURN c;
    END;
    $$ LANGUAGE plpgsql;

    -- Caller
    BEGIN;
    SELECT open_orders_for(42);   -- returns e.g. '<unnamed portal 7>'
    FETCH ALL IN "<unnamed portal 7>";
    COMMIT;                       -- closes the portal

> [!NOTE] PostgreSQL 16
> Bound cursor variables (`c CURSOR FOR ...`) are initialized to `null`, not to a name
> matching the variable. If you need a stable name (e.g. for protocol-level binding),
> assign it explicitly before `OPEN`: `c := 'my_portal_name'; OPEN c;`.[^pg16-cursor]

### WITH HOLD and scrollable cursors

`WITH HOLD` is set at the SQL-level `DECLARE CURSOR` (not in PL/pgSQL). When used inside
a procedure, the cursor's first `COMMIT` materializes its result set in full — a silent
correctness fix that turns into a silent latency problem on a billion-row query. See
[07-procedures.md](./07-procedures.md) and [13-cursors-and-prepares.md](./13-cursors-and-prepares.md) for the deep
treatment.


## Dynamic SQL

`EXECUTE` runs a string as SQL — re-planned every call. Use it when *the SQL itself* must
vary (table or column name, optional clauses), not when only parameter values vary.[^stmt]

    EXECUTE 'SELECT count(*) FROM ' || quote_ident(tablename)
          INTO v_count;

    -- Recommended form: format() + USING
    EXECUTE format('SELECT count(*) FROM %I WHERE owner = $1', tablename)
          INTO v_count
          USING current_user;

The three identifier/literal-quoting helpers and when to use each:

| Function | Purpose | NULL handling |
|---|---|---|
| `quote_ident(text)` | Quote an identifier (table/column/schema name) | Returns NULL on NULL input |
| `quote_literal(anyelement)` | Quote a literal value | Returns NULL on NULL input — **almost always a bug** |
| `quote_nullable(anyelement)` | Quote a literal value | Returns the string `'NULL'` on NULL input |

For `format()`, the placeholders are `%I` (identifier), `%L` (literal, NULL-safe via
`quote_nullable`), and `%s` (raw — never use this for user input).

> [!WARNING] Injection-safe rule
> If a value goes into the SQL as a *value*, pass it via `USING` — never concatenate.
> If it goes in as an *identifier*, use `%I` or `quote_ident()`. **Never** `%s`. See
> [10-dynamic-sql.md](./10-dynamic-sql.md) for the full treatment, including the rare cases where
> identifier construction beyond `%I` is needed.[^stmt]


## Returning Sets

A function declared `RETURNS SETOF rowtype` or `RETURNS TABLE(...)` can emit rows in
three ways:[^control]

    -- 1. One row at a time
    RETURN NEXT some_row_or_expression;

    -- 2. A whole result of a query
    RETURN QUERY SELECT id, name FROM users WHERE active;

    -- 3. A whole result of a dynamic query
    RETURN QUERY EXECUTE 'SELECT id, name FROM ' || quote_ident(tbl)
                  USING ...;

    -- After the last RETURN NEXT / RETURN QUERY, an empty RETURN ends the function.
    RETURN;

PL/pgSQL **materializes the whole set in a tuplestore** before returning it to the
caller. For very large sets the tuplestore spills past `work_mem` to disk. If streaming
matters (and you can refactor), use a `LANGUAGE sql` function (often inlinable) or a
cursor return instead.

> [!NOTE] PostgreSQL 14
> The query inside `RETURN QUERY` can now be parallelized.[^pg14] In practice this means
> a `RETURNS SETOF` function with a single large `RETURN QUERY` can use parallel workers
> against tables in the query — provided the function itself is `PARALLEL SAFE` (see
> [06-functions.md](./06-functions.md)).


## Plan Caching and Variable Substitution

The PL/pgSQL plan cache is per-session and per-function-invocation-shape. On first call:[^impl]

1. The function body text is parsed once into an internal tree.
2. Each embedded SQL command and each PL/pgSQL expression is prepared via SPI on first
   reach. Variable references become bind parameters.
3. The prepared statement is reused on subsequent reaches. SPI picks between a *custom
   plan* (re-planned every call with concrete parameter values) and a *generic plan* (planned
   once for symbolic parameters) based on cost comparison after the first few executions.

The practical consequences:

- **`'now'` and other text→type casts are frozen at plan time** — see mental model rule 2 and gotcha #3.
- **Record-variable fields are typed at first access.** Reassigning a `RECORD` to a row
  of a different shape between invocations raises an error.[^impl]
- **Trigger functions cache per (function, table).** A trigger function attached to two
  tables maintains separate plan caches; identical column names with different types
  work correctly.[^impl]
- **Polymorphic functions cache per argument-type combination.** Calling the same
  `anyelement` function with `int` then with `text` produces two caches.[^impl]
- **`DISCARD PLANS`** clears cached plans in the current session — useful after a schema
  change that invalidates plans but does not force their invalidation.

If a query inside the function shows good explain plans interactively but performs
poorly inside the function, suspect the generic plan. Set `plan_cache_mode = force_custom_plan`
in the function via `SET` and measure again:

    CREATE FUNCTION lookup(p_id bigint) RETURNS users AS $$
    DECLARE v users; BEGIN SELECT * INTO v FROM users WHERE id = p_id; RETURN v; END;
    $$ LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan;

See [13-cursors-and-prepares.md](./13-cursors-and-prepares.md) and
[57-pg-stat-statements.md](./57-pg-stat-statements.md) for the deeper plan-cache and diagnostic story.


## Triggers and Special Variables

Inside a `LANGUAGE plpgsql` trigger function, the parser pre-declares:[^structure]

| Name | Meaning |
|---|---|
| `NEW` | Composite of the new row (BEFORE/AFTER INSERT/UPDATE, INSTEAD OF INSERT/UPDATE) |
| `OLD` | Composite of the old row (BEFORE/AFTER UPDATE/DELETE, INSTEAD OF UPDATE/DELETE) |
| `TG_OP` | `'INSERT'`, `'UPDATE'`, `'DELETE'`, or `'TRUNCATE'` |
| `TG_NAME` | Trigger name |
| `TG_WHEN` | `'BEFORE'`, `'AFTER'`, or `'INSTEAD OF'` |
| `TG_LEVEL` | `'ROW'` or `'STATEMENT'` |
| `TG_TABLE_SCHEMA`, `TG_TABLE_NAME` | Target relation |
| `TG_RELID` | OID of the target relation |
| `TG_NARGS`, `TG_ARGV[]` | Trigger arguments declared in `CREATE TRIGGER` |
| `TG_TAG` | (Event triggers) command tag |

A `BEFORE` row trigger that returns `NULL` suppresses the operation for that row; a
`BEFORE` row trigger that returns a modified `NEW` causes the modified row to be used
for the operation. An `AFTER` row trigger's return value is ignored.

Full coverage in [39-triggers.md](./39-triggers.md) and [40-event-triggers.md](./40-event-triggers.md).


## Examples / Recipes

### 1. Idempotent upsert with retry on race

    CREATE FUNCTION counter_inc(p_key text, p_delta int DEFAULT 1)
    RETURNS bigint
    LANGUAGE plpgsql AS $$
    DECLARE
        v_total bigint;
    BEGIN
        INSERT INTO counters AS c (k, total)
             VALUES (p_key, p_delta)
        ON CONFLICT (k) DO UPDATE
             SET total = c.total + EXCLUDED.total
        RETURNING total INTO v_total;
        RETURN v_total;
    END;
    $$;

No `EXCEPTION` block — `ON CONFLICT` does the work and avoids subtransaction overhead.

### 2. Chunked DML loop with `LIMIT` and `RETURNING`

    CREATE PROCEDURE archive_old_events(p_cutoff timestamptz)
    LANGUAGE plpgsql AS $$
    DECLARE
        n int;
    BEGIN
        LOOP
            WITH moved AS (
                DELETE FROM events
                 WHERE id IN (
                     SELECT id FROM events
                      WHERE created_at < p_cutoff
                      ORDER BY id
                      LIMIT 10000
                     FOR UPDATE SKIP LOCKED)
                RETURNING *
            )
            INSERT INTO events_archive SELECT * FROM moved;

            GET DIAGNOSTICS n = ROW_COUNT;
            EXIT WHEN n = 0;
            COMMIT;
        END LOOP;
    END;
    $$;

A procedure (not function) because of the `COMMIT` calls — see
[07-procedures.md](./07-procedures.md).

### 3. STRICT lookup with friendly errors

    CREATE FUNCTION user_by_email(p_email text) RETURNS users
    LANGUAGE plpgsql AS $$
    DECLARE
        v users;
    BEGIN
        SELECT * INTO STRICT v FROM users WHERE lower(email) = lower(p_email);
        RETURN v;
    EXCEPTION
        WHEN no_data_found THEN
            RAISE EXCEPTION 'no user with email %', p_email
                  USING ERRCODE = 'P0002', HINT = 'check spelling';
        WHEN too_many_rows THEN
            RAISE EXCEPTION 'multiple users with email % — data corrupt', p_email;
    END;
    $$;

The `EXCEPTION` block sits at the function's top level — no per-row subtransaction churn.

### 4. Build a WHERE clause dynamically without injection

    CREATE FUNCTION search_orders(
        p_user_id int   DEFAULT NULL,
        p_status  text  DEFAULT NULL,
        p_since   timestamptz DEFAULT NULL)
    RETURNS SETOF orders
    LANGUAGE plpgsql AS $$
    DECLARE
        v_sql text := 'SELECT * FROM orders WHERE 1=1';
        v_args text[] := ARRAY[]::text[];
        v_idx int := 0;
    BEGIN
        IF p_user_id IS NOT NULL THEN
            v_idx := v_idx + 1;
            v_sql := v_sql || format(' AND user_id = $%s', v_idx);
            v_args := v_args || p_user_id::text;
        END IF;
        IF p_status IS NOT NULL THEN
            v_idx := v_idx + 1;
            v_sql := v_sql || format(' AND status = $%s', v_idx);
            v_args := v_args || p_status;
        END IF;
        IF p_since IS NOT NULL THEN
            v_idx := v_idx + 1;
            v_sql := v_sql || format(' AND placed_at >= $%s', v_idx);
            v_args := v_args || p_since::text;
        END IF;
        RETURN QUERY EXECUTE v_sql USING VARIADIC v_args;
    END;
    $$;

Use `USING` for values. `format(... %I ...)` for any identifier. **Never** concatenate
user-supplied values.

### 5. Audit trigger that copies old/new to a JSONB log

    CREATE OR REPLACE FUNCTION trg_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO audit_log(table_name, op, who, old_row, new_row)
        VALUES (TG_TABLE_NAME,
                TG_OP,
                current_user,
                CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
                CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END);
        RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE TRIGGER audit_users AFTER INSERT OR UPDATE OR DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION trg_audit();

### 6. Pure-set returning function (no per-row tuplestore overhead — prefer SQL)

    -- Slow path: PL/pgSQL builds tuplestore
    CREATE FUNCTION recent_orders_plpgsql(p_user int) RETURNS SETOF orders
    LANGUAGE plpgsql AS $$
    BEGIN
        RETURN QUERY SELECT * FROM orders WHERE user_id = p_user AND placed_at > now() - interval '30 days';
    END;
    $$;

    -- Fast path: SQL function — inlinable into the caller's plan
    CREATE FUNCTION recent_orders_sql(p_user int) RETURNS SETOF orders
    LANGUAGE sql STABLE AS $$
        SELECT * FROM orders WHERE user_id = p_user AND placed_at > now() - interval '30 days';
    $$;

See [06-functions.md](./06-functions.md) for SQL-function inlining rules.

### 7. Iterating a cursor for "process and commit every N"

    CREATE PROCEDURE process_pending_orders()
    LANGUAGE plpgsql AS $$
    DECLARE
        c CURSOR FOR SELECT id FROM orders WHERE status = 'pending' ORDER BY id;
        r RECORD;
        n int := 0;
    BEGIN
        FOR r IN c LOOP
            PERFORM process_order(r.id);
            n := n + 1;
            IF n % 1000 = 0 THEN
                COMMIT;
            END IF;
        END LOOP;
        COMMIT;
    END;
    $$;

The `COMMIT` works because we're in a procedure (not function). The cursor is rebuilt as
a holdable cursor on the first `COMMIT` and materialized — see
[07-procedures.md](./07-procedures.md) for the latency trade-off.

### 8. Catch a duplicate-key violation but only at the top of a batch

    -- WRONG: per-row subtransaction
    CREATE PROCEDURE bulk_ingest_bad(p_rows hstore[]) LANGUAGE plpgsql AS $$
    DECLARE r hstore;
    BEGIN
        FOREACH r IN ARRAY p_rows LOOP
            BEGIN
                INSERT INTO target ... ;
            EXCEPTION
                WHEN unique_violation THEN NULL;   -- subtxn per row!
            END;
        END LOOP;
    END;
    $$;

    -- RIGHT: push the dedup into ON CONFLICT
    CREATE PROCEDURE bulk_ingest_good(p_rows jsonb)
    LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO target (id, name, payload)
             SELECT (e->>'id')::bigint, e->>'name', e->'payload'
               FROM jsonb_array_elements(p_rows) AS e
        ON CONFLICT (id) DO NOTHING;
    END;
    $$;


## Gotchas / Anti-patterns

1. **`EXCEPTION` block inside a tight loop.** Each iteration writes a subtransaction
   record into the `subtrans` SLRU and consumes a virtual XID. Move the block outside
   the loop, or refactor to `ON CONFLICT` / preventive WHERE clauses. See
   [27-mvcc-internals.md](./27-mvcc-internals.md) and [29-transaction-id-wraparound.md](./29-transaction-id-wraparound.md).[^control]

2. **`SELECT INTO` without `STRICT` when "exactly one" is expected.** Silent
   non-determinism. Reach for `STRICT` and handle `no_data_found` / `too_many_rows`
   explicitly at the function boundary.[^stmt]

3. **`'now'::timestamp` baked into a prepared SQL inside PL/pgSQL.** The cast happens
   at plan time, not call time. Use `now()` or `current_timestamp` instead.[^impl]

4. **String concatenation in `EXECUTE` with user input.** Classic SQL injection. Use
   `EXECUTE format(... %I ...) USING ...` instead. `%s` is *not* injection-safe.[^stmt]

5. **`quote_literal()` on a possibly-null value.** Returns `NULL`, so the entire
   command string becomes `NULL`. Use `quote_nullable()` or, better, pass via `USING`.[^stmt]

6. **`RAISE NOTICE` for production logging.** `NOTICE`s are sent to clients by default
   and bloat application logs. Use `RAISE LOG` (server-log only) or push to a real
   logging extension; toggle thresholds with `client_min_messages` /
   `log_min_messages`.[^errors]

7. **Catching `serialization_failure` *inside* a function.** Retries inside the same
   transaction will fail again — you need a fresh snapshot. Re-raise and let the caller
   loop. See [42-isolation-levels.md](./42-isolation-levels.md).[^control]

8. **Catching `OTHERS` and swallowing the error.** Almost always wrong. Log it and
   re-raise (`RAISE;`). Use `GET STACKED DIAGNOSTICS` first to capture context.[^errors]

9. **Using a `RECORD` variable across rows of different shapes.** The first assignment
   fixes the shape; reassignment to a different row layout raises an error. Use
   distinct `RECORD` variables per query, or use `%ROWTYPE` with a concrete type.[^impl]

10. **Variable-name collisions with column names.** Default is to error. Prefix locals
    with `v_` or qualify both sides — `users.id` vs `myfunc.id` vs `outerblock.id`.[^impl]

11. **`PERFORM` confused with `SELECT`.** Inside PL/pgSQL, `SELECT expr;` alone is a
    syntax error (parser expects an `INTO`); use `PERFORM expr;` to call a function for
    side effects.[^stmt]

12. **Mutable defaults in `DECLARE`.** A default expression is re-evaluated at every
    block entry. `v_started timestamptz DEFAULT now()` is exactly the timestamp at
    block entry, which usually is what you want — but be aware it is not function-call
    constant if the variable lives in a nested block re-entered in a loop.[^decl]

13. **`RETURN NEXT` in a loop building a huge tuplestore.** PL/pgSQL materializes the
    full result before returning. If you can write it as a single `RETURN QUERY` or as a
    SQL function, do so — the planner can stream and parallelize. See
    [06-functions.md](./06-functions.md) for SQL-function inlining.

14. **`SET search_path = ...` on a `SECURITY DEFINER` PL/pgSQL function — forgotten.**
    Without it, the function resolves identifiers against the caller's `search_path`,
    enabling privilege-escalation attacks. Pin every `SECURITY DEFINER` function:
    `SET search_path = pg_catalog, public`. See [06-functions.md](./06-functions.md).

15. **Assuming `CREATE OR REPLACE FUNCTION` invalidates cached plans.** It does not
    invalidate cached plans across already-connected backends. After a hot rollout call
    `DISCARD PLANS;` or — better — coordinate with a pool rotation. See
    [80-connection-pooling.md](./80-connection-pooling.md).


## See Also

- [06-functions.md](./06-functions.md) — `CREATE FUNCTION` attributes that wrap every PL/pgSQL body
- [07-procedures.md](./07-procedures.md) — Procedures, transaction control, `CALL`
- [09-procedural-languages.md](./09-procedural-languages.md) — When to reach for PL/Python, PL/Perl, PL/v8
- [10-dynamic-sql.md](./10-dynamic-sql.md) — Deep injection-prevention treatment for `EXECUTE`
- [13-cursors-and-prepares.md](./13-cursors-and-prepares.md) — `DECLARE CURSOR` at the SQL level, `PREPARE` / generic-vs-custom plan switching
- [27-mvcc-internals.md](./27-mvcc-internals.md) — Why subtransactions are expensive
- [29-transaction-id-wraparound.md](./29-transaction-id-wraparound.md) — XID budget that exception blocks consume
- [39-triggers.md](./39-triggers.md) — Trigger function specifics (NEW/OLD, transition tables)
- [42-isolation-levels.md](./42-isolation-levels.md) — Retry-on-serialization-failure pattern
- [43-locking.md](./43-locking.md) — `FOR UPDATE` / `SKIP LOCKED` inside PL/pgSQL loops
- [56-explain.md](./56-explain.md) — `EXPLAIN ANALYZE` for diagnosing plan caching and plan instability in PL/pgSQL functions


## Sources

[^structure]: PostgreSQL 16 documentation — "Block Structure".
    https://www.postgresql.org/docs/16/plpgsql-structure.html

[^decl]: PostgreSQL 16 documentation — "Declarations" (variable declarations, `%TYPE`,
    `%ROWTYPE`, `RECORD`, `CONSTANT`, `NOT NULL`, `DEFAULT` / `:=` / `=`, `ALIAS FOR`).
    https://www.postgresql.org/docs/16/plpgsql-declarations.html

[^stmt]: PostgreSQL 16 documentation — "Basic Statements" (`SELECT INTO` /
    `[STRICT]`, `PERFORM`, `EXECUTE`, `USING`, `format()`, `quote_ident` /
    `quote_literal` / `quote_nullable`, `GET DIAGNOSTICS`, `FOUND`).
    https://www.postgresql.org/docs/16/plpgsql-statements.html

[^control]: PostgreSQL 16 documentation — "Control Structures" (`IF` / `CASE` /
    `LOOP` / `WHILE` / `FOR` / `FOREACH` / `EXIT` / `CONTINUE`, `RETURN` /
    `RETURN NEXT` / `RETURN QUERY`, `EXCEPTION WHEN`, `GET STACKED DIAGNOSTICS`,
    subtransaction-cost warning). https://www.postgresql.org/docs/16/plpgsql-control-structures.html

[^errors]: PostgreSQL 16 documentation — "Errors and Messages" (`RAISE` levels and
    `USING` options, `ASSERT`, `plpgsql.check_asserts`).
    https://www.postgresql.org/docs/16/plpgsql-errors-and-messages.html

[^cursors]: PostgreSQL 16 documentation — "Cursors" (`refcursor`, `OPEN`, `FETCH`,
    `MOVE`, `CLOSE`, bound vs unbound, `FOR row IN cursor LOOP`).
    https://www.postgresql.org/docs/16/plpgsql-cursors.html

[^impl]: PostgreSQL 16 documentation — "PL/pgSQL under the Hood" (variable
    substitution, plan caching, generic vs custom plans, time-sensitive values,
    `plpgsql.variable_conflict`, trigger/polymorphic plan caching).
    https://www.postgresql.org/docs/16/plpgsql-implementation.html

[^errcodes]: PostgreSQL 16 documentation — "PostgreSQL Error Codes" (SQLSTATE
    table). https://www.postgresql.org/docs/16/errcodes-appendix.html

[^pg14]: PostgreSQL 14 release notes. Exact quotes: *"Improve PL/pgSQL's expression
    and assignment parsing (Tom Lane) — This change allows assignment to array slices
    and nested record fields."*; *"Allow plpgsql's RETURN QUERY to execute its query
    using parallelism (Tom Lane)."*; *"Improve performance of repeated CALLs within
    plpgsql procedures (Pavel Stehule, Tom Lane)."*
    https://www.postgresql.org/docs/release/14.0/

[^pg16-cursor]: PostgreSQL 16 release notes — migration note. Exact quote: *"Change
    assignment rules for PL/pgSQL bound cursor variables (Tom Lane). Previously, the
    string value of such variables was set to match the variable name during cursor
    assignment; now it will be assigned during OPEN, and will not match the variable
    name. To restore the previous behavior, assign the desired portal name to the
    cursor variable before OPEN."* https://www.postgresql.org/docs/release/16.0/

[^pg16-oid]: PostgreSQL 16 release notes — PL/pgSQL section. Exact quote: *"Add the
    ability to get the current function's OID in PL/pgSQL (Pavel Stehule). This is
    accomplished with GET DIAGNOSTICS variable = PG_ROUTINE_OID."*
    https://www.postgresql.org/docs/release/16.0/

[^pg18-cursor-arg]: PostgreSQL 18 release notes — PL/pgSQL section. Exact quote:
    *"Allow `=>` syntax for named cursor arguments in PL/pgSQL (Pavel Stehule). We
    previously only accepted `:=`."* https://www.postgresql.org/docs/release/18.0/

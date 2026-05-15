# Dynamic SQL


Building, parametrizing, and executing SQL strings at runtime — and doing it without
creating SQL injection bugs.

## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [The Injection-Prevention Rule](#the-injection-prevention-rule)
- [Syntax / Mechanics](#syntax--mechanics)
    - [`EXECUTE` command-string forms](#execute-command-string-forms)
    - [`USING` parameter binding](#using-parameter-binding)
    - [Why `USING` cannot substitute identifiers](#why-using-cannot-substitute-identifiers)
    - [`format()` placeholders](#format-placeholders)
    - [Quoting helpers (`quote_ident` / `quote_literal` / `quote_nullable`)](#quoting-helpers-quote_ident--quote_literal--quote_nullable)
    - [Plan caching: `EXECUTE` re-plans every call](#plan-caching-execute-re-plans-every-call)
    - [SQL-level `PREPARE` / `EXECUTE` / `DEALLOCATE`](#sql-level-prepare--execute--deallocate)
- [Decision Matrix: When to Use Which Tool](#decision-matrix-when-to-use-which-tool)
- [Examples / Recipes](#examples--recipes)
    - [1. `format()` + `USING` (the canonical pattern)](#1-format--using-the-canonical-pattern)
    - [2. Dynamic table or schema name](#2-dynamic-table-or-schema-name)
    - [3. Dynamic `WHERE` with optional filters](#3-dynamic-where-with-optional-filters)
    - [4. Dynamic `ORDER BY` (the column-name problem)](#4-dynamic-order-by-the-column-name-problem)
    - [5. Dynamic `IN`-list of unknown length](#5-dynamic-in-list-of-unknown-length)
    - [6. Dynamic column list (`SELECT col1, col2, ...`)](#6-dynamic-column-list-select-col1-col2-)
    - [7. Loop over a dynamic query (`FOR rec IN EXECUTE`)](#7-loop-over-a-dynamic-query-for-rec-in-execute)
    - [8. Return rows from a dynamic query (`RETURN QUERY EXECUTE`)](#8-return-rows-from-a-dynamic-query-return-query-execute)
    - [9. Dynamic DDL across every table in a schema](#9-dynamic-ddl-across-every-table-in-a-schema)
    - [10. `EXECUTE ... INTO STRICT` with parameter binding](#10-execute--into-strict-with-parameter-binding)
    - [11. Anti-pattern: rebuilding a manual `quote_*` form, then unraveling it](#11-anti-pattern-rebuilding-a-manual-quote_-form-then-unraveling-it)
- [Exploit Walkthrough: What "Injection" Actually Looks Like](#exploit-walkthrough-what-injection-actually-looks-like)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference


Use this file when:

- A function or procedure must accept an **identifier** (table name, schema name, column
  name) at runtime — PL/pgSQL bind parameters cannot do this.
- You must build a **`WHERE` clause** whose predicates depend on which arguments the caller
  supplied.
- You must build an **`ORDER BY`** whose key is chosen at runtime.
- You're auditing existing code for **SQL injection** and need the canonical safe form for
  comparison.
- You're iterating with `FOR rec IN EXECUTE ... LOOP` over a query whose text isn't known
  at compile time.

If your SQL text is fixed and only the *values* change, **do not use dynamic SQL** — write
the SQL directly and let PL/pgSQL's normal expression handling pass the values as bind
parameters. The plan will be cached and the values are automatically safe from injection.
See [08-plpgsql.md](./08-plpgsql.md) for the embedded-SQL model.

## The Injection-Prevention Rule


> [!WARNING]
> **Any value built into the SQL string by textual concatenation must pass through
> `quote_literal`, `quote_nullable`, `quote_ident`, or `format()`'s `%I` / `%L`
> placeholders — never through `||` raw.**

The hierarchy of preference:

1. **`USING` clause** for *data values*. Values stay in their native type, the plan is
   parameterized just like for an embedded statement, and there is nothing to escape.[^plpgsql-stmts]
2. **`format(... %I ...)`** for *identifiers* (table, schema, column, type, trigger,
   constraint names). `%I` calls `quote_ident()` internally and produces a correctly
   double-quoted SQL identifier.[^funcs-string]
3. **`format(... %L ...)`** for *literals* only when binding via `USING` is not possible
   (e.g. inside a SQL fragment that is itself part of larger SQL, like a `CHECK`
   constraint body emitted by DDL generation). `%L` calls `quote_nullable()` and so
   handles `NULL` safely.[^funcs-string]
4. **`%s`** for trusted, non-attacker-controlled fragments only — e.g. a positional
   `$N` placeholder index you computed yourself. Treat any `%s` consuming a caller-provided
   string as a bug.

Every recipe in this file is a worked example of that ordering.

## Syntax / Mechanics


### `EXECUTE` command-string forms


    -- Bare: run a dynamic command, discard rows.
    EXECUTE command_string;

    -- With value bindings — preferred form for data.
    EXECUTE command_string USING expr1, expr2, ...;

    -- Capture the first row into local variables / record.
    EXECUTE command_string INTO target [USING ...];

    -- Capture into a record; exactly one row or error.
    EXECUTE command_string INTO STRICT target [USING ...];

    -- Loop over the result rows.
    FOR target IN EXECUTE command_string [USING ...] LOOP
        ...
    END LOOP;

    -- Pass the rows to the caller of a set-returning function.
    RETURN QUERY EXECUTE command_string [USING ...];

    -- Open a bound cursor over a dynamic query (see 13-cursors-and-prepares.md).
    OPEN curs FOR EXECUTE command_string [USING ...];

Every form takes a single `text` expression as the command. The string is not parsed at
function-creation time — it is parsed, analyzed, and planned at each call.[^plpgsql-stmts]

### `USING` parameter binding


Inside the command string, `$1`, `$2`, ... reference the `USING` expressions
positionally:

    EXECUTE 'SELECT count(*) FROM orders WHERE customer_id = $1 AND placed_at >= $2'
        INTO v_count
        USING p_customer_id, p_since;

The values stay in their native types — no text round-trip, no escape rules, no
injection surface. This is the form to reach for whenever the SQL text is fixed and
only the values vary. Multiple `USING` expressions are positional, just like
SQL-level `PREPARE` placeholders.[^plpgsql-stmts]

When the caller might pass `NULL`, `USING` handles it correctly because `$1` IS NULL
inside the dynamic query behaves the same as for any other parameter. The
`quote_literal` / `quote_nullable` distinction (below) is *only* relevant if you've
already chosen the `%L`-concatenation route.

### Why `USING` cannot substitute identifiers


    -- ✗ This does NOT do what you want.
    EXECUTE 'SELECT count(*) FROM $1 WHERE owner = $2' USING p_table, p_owner;
    -- ERROR:  syntax error at or near "$1"

`$N` is a *value placeholder*, evaluated by the parser as an expression slot. A table
name appears in a different grammatical position — in `FROM`, in `JOIN`, in `INTO`, in
`ALTER TABLE`, in a SECURITY context — and grammatically cannot be filled by a
parameter. Identifiers must therefore be **inlined as text** into the command string,
which is exactly where `format(... %I ...)` and `quote_ident()` come in.[^plpgsql-stmts]

The same logic applies to keywords (`ASC`/`DESC`), operator tokens (`=`/`<>`), and SQL
clause shape (e.g. presence or absence of a `WHERE` predicate). These are *structural*
elements, not values, and `USING` cannot deliver them.

### `format()` placeholders


    format(formatstr text, args...) → text

| Specifier | Meaning | NULL behavior |
|---|---|---|
| `%s` | Raw string insertion. **No quoting.** Use only for already-trusted strings. | NULL becomes empty string. |
| `%I` | SQL identifier — calls `quote_ident()` internally. Use for table / schema / column / role / index / type names. | NULL **raises an error**. |
| `%L` | SQL literal — calls `quote_nullable()` internally. Use for values when you cannot use `USING`. | NULL becomes the unquoted token `NULL`. |
| `%%` | Literal `%` in the output. | n/a |

Positional specifiers reorder argument consumption:

    format('Move %2$I to schema %1$I', 'archive', 'orders')
    -- → Move "orders" to schema "archive"

Width and `-` (left-justify) flags are supported but rarely useful in dynamic SQL —
the most useful trick is positional `%n$L` / `%n$I` when the same argument is needed
multiple times in the output.[^funcs-string]

> [!WARNING]
> `format('... %I ...', NULL)` raises a runtime error, not a parse error. If a code path
> can supply `NULL` as an identifier, guard the argument before calling `format()` (e.g.
> `IF p_table IS NULL THEN RAISE EXCEPTION 'table name required'; END IF;`).

### Quoting helpers (`quote_ident` / `quote_literal` / `quote_nullable`)


| Function | Returns | NULL input | Use when |
|---|---|---|---|
| `quote_ident(text)` | `"name"` if needed (special chars, mixed case, reserved word); otherwise unquoted | Returns `NULL` (the typed value) — **propagates and usually breaks the surrounding string** | Identifier composition, usually via `format(... %I ...)`. |
| `quote_literal(text)` / `quote_literal(anyelement)` | `'value'` with embedded `'` doubled and `\` escaped | Returns `NULL` (typed) — **makes the whole concatenation become `NULL`, which is almost always a bug** | Only when you need an SQL-literal form and you've proven the value can't be NULL. |
| `quote_nullable(text)` / `quote_nullable(anyelement)` | `'value'` with embedded `'` doubled, or the unquoted token `NULL` for NULL inputs | Returns the four-character SQL token `NULL` (a non-null text value, so the surrounding string survives) | The NULL-safe replacement for `quote_literal()` in concatenation.[^funcs-string] |

The relationship between `format()` and these helpers is direct: `%I` ≡ `quote_ident`,
`%L` ≡ `quote_nullable`. There is *no* `format()` specifier equivalent to
`quote_literal` — `%L` is the NULL-safe variant, by design.

### Plan caching: `EXECUTE` re-plans every call


Embedded SQL in PL/pgSQL is parsed once per function call, then cached as a prepared
plan; on subsequent invocations PL/pgSQL re-executes the cached plan, parameterized by
the local variables, and may switch between custom and generic plans based on
`plan_cache_mode`. **`EXECUTE` is different**: each call re-parses, re-analyzes, and
re-plans the command string from scratch. There is no plan cache for dynamic
statements.[^plpgsql-stmts] [^plpgsql-impl]

Implications:

- Dynamic SQL has higher per-call overhead. For hot paths, prefer a fixed embedded
  statement when feasible.
- The fresh plan means parameter-specific decisions (e.g. choosing between index scan
  and seq scan based on the literal value) can be more accurate per call.
- Catalog DDL between calls is automatically picked up by the next call — no `DISCARD
  PLANS` needed for a function that uses `EXECUTE`.
- If the *only* thing that varies is the `USING` values, the cost of re-planning is
  pure overhead. In that case, drop `EXECUTE` and use embedded SQL.

### SQL-level `PREPARE` / `EXECUTE` / `DEALLOCATE`


The SQL-level form is a different thing — it's a *session-level prepared statement*
that the client (or psql, or pgbench, or a driver) keeps a handle to:

    PREPARE stmt(int, text) AS
        SELECT * FROM orders WHERE customer_id = $1 AND status = $2;

    EXECUTE stmt(42, 'paid');
    EXECUTE stmt(43, 'pending');

    DEALLOCATE stmt;

Two important differences from PL/pgSQL `EXECUTE`:

1. **The SQL-level `EXECUTE` takes a *prepared-statement name and parameter list*, not
   a command string.** It is the consumer side of `PREPARE`. PL/pgSQL `EXECUTE` takes
   a `text` command string.
2. **SQL-level prepared statements *are* plan-cached** — `plan_cache_mode = auto`
   gives 5 custom plans, then evaluates and may switch to a generic plan.[^sql-prepare]

The naming collision is unfortunate, but the two are entirely separate facilities.
Don't confuse them; in PL/pgSQL bodies you almost always want the dynamic-SQL form
unless you're emitting client-facing benchmark scripts or interactive psql sessions.

For the prepared-statement plan-caching deep dive — generic vs custom plans, the
5-call decision, `plan_cache_mode`, `DISCARD PLANS` — see
[13-cursors-and-prepares.md](./13-cursors-and-prepares.md).

## Decision Matrix: When to Use Which Tool


| Need | Recommended | Avoid |
|---|---|---|
| Insert a *value* into a fixed-shape statement | Embedded SQL (no `EXECUTE`); bind via PL/pgSQL local | `EXECUTE` + `%L` |
| Insert a *value* into a runtime-shape statement | `EXECUTE` + `USING` | `EXECUTE` + `%L` + `quote_literal` |
| Insert a *table / schema / column name* | `EXECUTE format('... %I ...', p_name)` | `'... ' \|\| p_name \|\| ' ...'` (raw concat) |
| Insert a *direction keyword* (`ASC`/`DESC`) | `CASE ... THEN 'ASC' ELSE 'DESC' END` mapped to a hardcoded allowlist, then `%s` | Trusting caller-supplied text |
| Insert a *whole sub-clause* (`WHERE`, `JOIN`, etc.) | Build with `format(... %I ...)` for identifiers, `USING $N` for values; accumulate `$N` index manually | Caller-supplied SQL fragments |
| Insert a *NULL-possible value* without `USING` | `quote_nullable()` or `format('%L', x)` | `quote_literal()` — returns NULL, breaks concat |
| Loop over a runtime-shape query | `FOR rec IN EXECUTE ... USING ... LOOP` | Multiple round trips via cursor |

## Examples / Recipes


### 1. `format()` + `USING` (the canonical pattern)


    CREATE FUNCTION row_count(p_table text, p_owner text)
    RETURNS bigint
    LANGUAGE plpgsql AS $$
    DECLARE
        v_count bigint;
    BEGIN
        IF p_table IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
                MESSAGE = 'p_table must not be NULL';
        END IF;

        EXECUTE format(
            'SELECT count(*) FROM %I WHERE owner = $1',
            p_table)
        INTO v_count
        USING p_owner;

        RETURN v_count;
    END;
    $$;

- `%I` for the identifier (`p_table`).
- `$1` + `USING` for the value (`p_owner`).
- The identifier is validated by guard (`NULL` would raise inside `%I`).

This is the shape every recipe below extends.

### 2. Dynamic table or schema name


    CREATE FUNCTION truncate_in_schema(p_schema text, p_table text)
    RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
        EXECUTE format('TRUNCATE TABLE %I.%I', p_schema, p_table);
    END;
    $$;

`%I.%I` produces `"my schema"."my table"` when needed and `myschema.mytable` when both
identifiers are safe-bare. Two-part identifier composition is the most common dynamic
DDL pattern, and `format()` handles both halves correctly.

For all-tables-in-a-schema patterns, drive the loop from `pg_class` filtered by
`relnamespace` and `relkind = 'r'` — see [64-system-catalogs.md](./64-system-catalogs.md)
for the catalog joins.

### 3. Dynamic `WHERE` with optional filters


The injection-safe pattern for "any combination of optional filters" is to build the
SQL with positional `$N` placeholders, accumulate values in a `text[]`, and pass them
through `EXECUTE ... USING VARIADIC v_args`.

    CREATE FUNCTION search_orders(
        p_owner    text        DEFAULT NULL,
        p_status   text        DEFAULT NULL,
        p_since    timestamptz DEFAULT NULL,
        p_min_amt  numeric     DEFAULT NULL,
        p_sort_col text        DEFAULT 'placed_at',
        p_sort_dir text        DEFAULT 'DESC')
    RETURNS SETOF orders
    LANGUAGE plpgsql AS $$
    DECLARE
        v_sql  text   := 'SELECT * FROM orders WHERE TRUE';
        v_args text[] := ARRAY[]::text[];
        v_idx  int    := 0;
        v_dir  text;
    BEGIN
        IF p_owner IS NOT NULL THEN
            v_idx := v_idx + 1;
            v_sql := v_sql || format(' AND owner = $%s', v_idx);
            v_args := v_args || p_owner;
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

        IF p_min_amt IS NOT NULL THEN
            v_idx := v_idx + 1;
            v_sql := v_sql || format(' AND total >= $%s', v_idx);
            v_args := v_args || p_min_amt::text;
        END IF;

        -- Validate caller-supplied identifier/keyword against an allowlist.
        IF p_sort_col NOT IN ('placed_at', 'total', 'owner', 'status') THEN
            RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value',
                MESSAGE = format('sort column %L not allowed', p_sort_col);
        END IF;
        v_dir := CASE upper(p_sort_dir) WHEN 'ASC' THEN 'ASC' ELSE 'DESC' END;

        v_sql := v_sql || format(' ORDER BY %I %s', p_sort_col, v_dir);

        RETURN QUERY EXECUTE v_sql USING VARIADIC v_args;
    END;
    $$;

Key points:

- The `WHERE TRUE` seed makes every appended predicate a uniform `AND ...`.
- The accumulated `$N` indices ensure `USING VARIADIC` matches by position.
- Caller-supplied `p_sort_col` is checked against a hardcoded allowlist and then routed
  through `%I` — the allowlist is the actual security boundary; `%I` is defense in
  depth.
- `p_sort_dir` is normalized to one of two literal tokens via `CASE`; we never trust
  the input text directly.

This is the deeper version of recipe 4 in
[08-plpgsql.md](./08-plpgsql.md#dynamic-sql) — that file shows the minimal shape;
this file is the canonical reference.

### 4. Dynamic `ORDER BY` (the column-name problem)


You cannot say `ORDER BY $1` with a bind parameter — well, you can, but you'll
silently sort by the *value* of `$1`, which is constant for the query and therefore a
no-op:

    -- ✗ Sorts every row by the same constant; does nothing useful.
    EXECUTE 'SELECT * FROM orders ORDER BY $1' USING 'placed_at';

The fix is allowlist + `%I`:

    CREATE FUNCTION list_orders(p_sort text)
    RETURNS SETOF orders
    LANGUAGE plpgsql AS $$
    BEGIN
        IF p_sort NOT IN ('id', 'placed_at', 'total', 'owner') THEN
            RAISE EXCEPTION 'invalid sort column %', p_sort
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        RETURN QUERY EXECUTE format(
            'SELECT * FROM orders ORDER BY %I', p_sort);
    END;
    $$;

`%I` is *not* a substitute for the allowlist. A caller could pass a valid column name
of some *other* table — say, `pg_catalog.pg_class.relname` — and `%I` would happily
quote it. The allowlist enforces that the column name *makes sense in this query*.

### 5. Dynamic `IN`-list of unknown length


Use the `ANY(array)` form instead of building a comma-joined `IN (...)`. `ANY` takes a
single bind parameter that happens to be an array:

    -- ✓ One bind parameter, no string building.
    EXECUTE 'SELECT * FROM orders WHERE id = ANY($1)' USING p_id_array;

This works because `id = ANY(int[])` is semantically equivalent to `id IN (... unnest
of the array ...)`, but the array is just a single value as far as the parameter slot
is concerned.[^plpgsql-stmts] The caller passes `ARRAY[1, 2, 3]` or `'{1,2,3}'::int[]`.

Avoid the `string_agg(... , ',')` form. It's slower, it requires escaping each element,
and it's a perpetual injection source.

### 6. Dynamic column list (`SELECT col1, col2, ...`)


When the *column list* is supplied at runtime, use `string_agg(format('%I', c), ', ')`
to build a safe comma-separated identifier list:

    CREATE FUNCTION select_columns(
        p_table   text,
        p_columns text[])
    RETURNS SETOF record
    LANGUAGE plpgsql AS $$
    DECLARE
        v_col_list text;
    BEGIN
        SELECT string_agg(format('%I', c), ', ')
          INTO v_col_list
          FROM unnest(p_columns) AS c;

        IF v_col_list IS NULL THEN
            RAISE EXCEPTION 'p_columns must contain at least one column';
        END IF;

        RETURN QUERY EXECUTE format(
            'SELECT %s FROM %I', v_col_list, p_table);
    END;
    $$;

`%s` is appropriate for `v_col_list` because the *entire string* was assembled from
`%I`-quoted parts — at the point of substitution it's already-safe text. Callers
invoke this with a column-typing cast: `SELECT * FROM select_columns('orders',
ARRAY['id','owner']) AS t(id bigint, owner text);`.

### 7. Loop over a dynamic query (`FOR rec IN EXECUTE`)


    DO $$
    DECLARE
        rec   record;
        v_schema text := 'public';
    BEGIN
        FOR rec IN EXECUTE format(
            'SELECT relname, n_live_tup
               FROM pg_stat_user_tables
              WHERE schemaname = $1
              ORDER BY n_live_tup DESC
              LIMIT 10')
            USING v_schema
        LOOP
            RAISE NOTICE 'table=%, rows=%', rec.relname, rec.n_live_tup;
        END LOOP;
    END;
    $$;

`FOR ... IN EXECUTE` returns each row of the dynamic query as a `record`; fields are
accessed by name (`rec.relname`). Combine with `USING` for values, `%I` for
identifiers. The `record` type is structural — its field shape is determined per
iteration, so adding columns to the underlying query just adds fields to `rec`.

### 8. Return rows from a dynamic query (`RETURN QUERY EXECUTE`)


    CREATE FUNCTION rows_from(p_table text, p_limit int DEFAULT 100)
    RETURNS SETOF record
    LANGUAGE plpgsql AS $$
    BEGIN
        RETURN QUERY EXECUTE format(
            'SELECT * FROM %I LIMIT $1', p_table)
        USING p_limit;
    END;
    $$;

    -- Caller must declare the record shape:
    SELECT * FROM rows_from('orders', 5) AS r(id bigint, owner text, total numeric);

`RETURNS SETOF record` is the price of letting the schema vary at runtime. If the
shape is fixed, declare a concrete `RETURNS TABLE(...)` instead, and use the same
`RETURN QUERY EXECUTE` body.

> [!NOTE] PostgreSQL 14
> PL/pgSQL `RETURN QUERY` can use parallel workers since PG 14. Dynamic queries
> executed via `RETURN QUERY EXECUTE` benefit from this if the underlying query is
> parallel-safe and the planner picks a parallel plan.[^pg14-plpgsql]

### 9. Dynamic DDL across every table in a schema


    DO $$
    DECLARE
        rec record;
    BEGIN
        FOR rec IN
            SELECT n.nspname AS schema, c.relname AS table_name
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'staging'
               AND c.relkind = 'r'
        LOOP
            EXECUTE format(
                'ALTER TABLE %I.%I SET (autovacuum_vacuum_scale_factor = 0.05)',
                rec.schema, rec.table_name);
            RAISE NOTICE 'updated %.%', rec.schema, rec.table_name;
        END LOOP;
    END;
    $$;

`pg_class.relname` and `pg_namespace.nspname` are catalog-sourced — they're already
trusted (the catalog can't contain a syntactically invalid identifier) — but `%I` still
applies because some identifiers may need quoting (mixed case, special characters).
Always use `%I` for catalog-derived names; it's the same one-character cost and
removes the entire class of "what if someone created a weird-name table" bug.

### 10. `EXECUTE ... INTO STRICT` with parameter binding


    CREATE FUNCTION load_one(p_table text, p_key bigint)
    RETURNS record
    LANGUAGE plpgsql AS $$
    DECLARE
        v_row record;
    BEGIN
        EXECUTE format('SELECT * FROM %I WHERE id = $1', p_table)
            INTO STRICT v_row
            USING p_key;
        RETURN v_row;
    EXCEPTION
        WHEN no_data_found THEN
            RAISE EXCEPTION 'no row with id=% in %', p_key, p_table
                USING ERRCODE = 'no_data_found';
        WHEN too_many_rows THEN
            RAISE EXCEPTION 'multiple rows with id=% in % — data corrupt', p_key, p_table
                USING ERRCODE = 'cardinality_violation';
    END;
    $$;

`INTO STRICT` is the lookup form: anything other than "exactly one row" raises a
defined error. Wrap with an `EXCEPTION` block to convert the bare error into something
domain-specific. See [08-plpgsql.md](./08-plpgsql.md#exception-handling) for the
exception model.

### 11. Anti-pattern: rebuilding a manual `quote_*` form, then unraveling it


You will see code like this in older codebases:

    -- ✗ NULL-broken and over-complicated.
    EXECUTE 'UPDATE ' || quote_ident(p_table)
         || ' SET ' || quote_ident(p_col)
         || ' = ' || quote_literal(p_value)
         || ' WHERE id = ' || quote_literal(p_id);

Problems: `quote_literal(NULL)` returns SQL `NULL` (see [quoting helpers](#quoting-helpers-quote_ident--quote_literal--quote_nullable) and gotcha #2); values pay a text round-trip; hard to read.

The rewrite:

    -- ✓ Identifiers via %I, values via USING.
    EXECUTE format('UPDATE %I SET %I = $1 WHERE id = $2', p_table, p_col)
        USING p_value, p_id;

If you must keep the `%L`-style form (e.g. you're emitting a CHECK constraint body),
use `quote_nullable` not `quote_literal`:

    -- ✓ NULL-safe via quote_nullable / %L.
    EXECUTE 'UPDATE ' || quote_ident(p_table)
         || ' SET ' || quote_ident(p_col)
         || ' = ' || quote_nullable(p_value)
         || ' WHERE id = ' || quote_nullable(p_id);

The audit rule: every `quote_literal` in a codebase is a latent NULL-broken
concatenation. Convert to `USING` if at all possible; convert to `quote_nullable` /
`%L` otherwise.[^funcs-string]

## Exploit Walkthrough: What "Injection" Actually Looks Like


Consider a vulnerable function — the kind that appears in older codebases:

    -- ✗ VULNERABLE. Do not use as a template.
    CREATE FUNCTION lookup_user(p_email text)
    RETURNS users
    LANGUAGE plpgsql AS $$
    DECLARE
        v_user users;
    BEGIN
        EXECUTE 'SELECT * FROM users WHERE email = ''' || p_email || ''''
            INTO v_user;
        RETURN v_user;
    END;
    $$;

A normal call works:

    SELECT lookup_user('alice@example.com');
    -- → (1, 'alice@example.com', ...)

An attacker-supplied `p_email`:

    SELECT lookup_user($$' OR true LIMIT 1 OFFSET 5 -- $$);

After concatenation, the executed command is:

    SELECT * FROM users WHERE email = '' OR true LIMIT 1 OFFSET 5 --'

— which returns *some other user*. Worse forms (`'; DROP TABLE users; --`) can append
statements if the SQL is executed via the multi-statement interface or via certain
client-driver paths. Even in PL/pgSQL where multi-statement injection is structurally
hard, the *data-leak* form above is sufficient on its own to violate the function's
security contract.

The safe rewrite:

    -- ✓ Bind via USING; nothing to escape.
    CREATE OR REPLACE FUNCTION lookup_user(p_email text)
    RETURNS users
    LANGUAGE plpgsql AS $$
    DECLARE
        v_user users;
    BEGIN
        EXECUTE 'SELECT * FROM users WHERE email = $1'
            INTO v_user
            USING p_email;
        RETURN v_user;
    END;
    $$;

— but at this point there is no reason to use `EXECUTE` at all, because the SQL text is
fixed. The true-canonical form is embedded SQL:

    CREATE OR REPLACE FUNCTION lookup_user(p_email text)
    RETURNS users
    LANGUAGE plpgsql AS $$
    DECLARE
        v_user users;
    BEGIN
        SELECT * INTO v_user FROM users WHERE email = p_email;
        RETURN v_user;
    END;
    $$;

The decision tree from any candidate `EXECUTE`:

1. Is the SQL text varying at runtime? If no, drop `EXECUTE` entirely.
2. Are only *values* varying? Use embedded SQL; locals are bind parameters
   automatically.
3. Are *identifiers* varying? Keep `EXECUTE`; bind values via `USING`; substitute
   identifiers via `%I` from an allowlist or trusted catalog source.

## Gotchas / Anti-patterns


1. **String concatenation of user values.** The single largest source of SQL injection
   in PL/pgSQL code. Always use `USING` for values; the only acceptable concatenation is
   `%I` for identifiers from an allowlist or trusted catalog.[^plpgsql-stmts]

2. **`quote_literal()` on a possibly-NULL value.** Returns `NULL`, which propagates
   through `||` and makes the whole command string `NULL`. `EXECUTE NULL` raises. Use
   `quote_nullable()` or, better, pass via `USING`.[^funcs-string]

3. **`format(... %I ...)` on a possibly-NULL identifier.** Raises a runtime error, not a
   parse error. Validate identifier arguments before they reach `format`.[^funcs-string]

4. **Trusting `%I` as a security boundary.** `%I` only ensures the identifier is
   *syntactically* an identifier. It does not check the identifier *makes sense* in the
   query. For caller-supplied column/table names, pair `%I` with an allowlist.

5. **Trying to bind keywords or operators via `$N`.** Parser positions for keywords
   (`ASC`/`DESC`, `JOIN` / `LEFT JOIN`), operators (`=`/`<>`), and identifiers
   (`FROM tbl`) cannot accept bind parameters. Pre-validate against a hardcoded set and
   substitute as `%s` from that set.

6. **`USING` count mismatch.** If the command string references `$1..$3` but you pass two
   `USING` expressions, the call fails at execution. When building positional
   placeholders dynamically (recipe 3), increment `v_idx` *and* append to `v_args` in
   the same conditional branch so they stay in lockstep.

7. **`SELECT ... INTO ...` inside the dynamic command string.** PL/pgSQL's `INTO` is a
   modifier on `EXECUTE`, not part of the SQL. Writing `EXECUTE 'SELECT ... INTO foo
   FROM ...'` will either fail or — worse — create a table named `foo` if your dynamic
   text accidentally hits the `SELECT INTO` *DDL* form. Always put `INTO` *outside* the
   string.[^plpgsql-stmts]

8. **Expecting `EXECUTE` to use the prepared-statement plan cache.** It doesn't. Every
   call is replanned. If a dynamic query is on a hot path with fixed text, refactor
   the variability out and use embedded SQL so the per-function plan cache picks it
   up.[^plpgsql-impl]

9. **`EXECUTE` inside a tight loop.** Same root cause as #8: per-call planning is
   expensive. If you must `EXECUTE` in a loop, consider moving the looping into SQL
   itself (`INSERT ... SELECT`, `UPDATE ... FROM`, set-based DML) so a single planned
   statement does the work.

10. **`format()` for *DDL templates* without identifier validation.** `format('CREATE
    INDEX %I ON %I (%I)', idx_name, table_name, col_name)` looks safe but allows any
    string as an index name — including one that collides with a system object or that
    is 64+ characters and silently truncates. Validate against `length() ≤ 63` and
    against a name regex when emitting DDL.

11. **Forgetting `search_path` in dynamic DDL inside SECURITY DEFINER.** If the body
    `EXECUTE`s SQL that references unqualified names, those names resolve through the
    caller's `search_path` unless the function pins one via `SET search_path = ...`.
    See the SECURITY DEFINER hardening in [06-functions.md](./06-functions.md#security-definer).

12. **Two-line `RAISE EXCEPTION` with `format(... %L ...)` for an error parameter.**
    `RAISE` has its own `USING` mechanism for structured fields (`MESSAGE`, `DETAIL`,
    `HINT`, `ERRCODE`, etc.) and a native `%` format. There is no need to call
    `format()` separately; just `RAISE EXCEPTION 'no row with id=% in %', p_id, p_tbl;`.
    See [08-plpgsql.md](./08-plpgsql.md#raise) for the full `RAISE` surface.

13. **Calling `EXECUTE` to *read* a single value from a known table.** Embedded SQL
    plus a `SELECT INTO STRICT` is faster, plan-cached, and (mostly) injection-proof on
    its own. Don't reach for `EXECUTE` just because the syntax feels more "dynamic".

14. **`EXECUTE` returning rows the caller never consumes.** A bare `EXECUTE 'SELECT
    ...'` discards the rows but still pays for planning, execution, and result
    materialization. If you want the side effect of a function call without rows, use
    `PERFORM` for embedded SQL and `EXECUTE 'SELECT do_thing()'` only when the SQL text
    actually varies.

15. **Building an `IN` list by string interpolation.** Always use `ANY($N)` with an
    array (recipe 5). `WHERE id IN (' || string_agg(quote_literal(x), ',') || ')` is
    slower, error-prone, and a perpetual injection source.

16. **Forgetting that `EXECUTE` plans are *not* shared between sessions.** Even though
    `EXECUTE` re-plans every call within a session, separate sessions don't share any
    plan state. If you want a plan you can reach from multiple sessions, you want a
    server-side prepared statement (SQL-level `PREPARE`) — but those are also
    session-local. The only "global" plan cache is the catalog itself
    (auto-invalidated by DDL).

## See Also


- [08-plpgsql.md](./08-plpgsql.md) — PL/pgSQL block structure, embedded-SQL semantics,
  `FOR ... IN EXECUTE LOOP`, `RETURN QUERY EXECUTE`, plan-caching mental model.
- [06-functions.md](./06-functions.md) — `SECURITY DEFINER`, search_path pinning,
  PARALLEL safety implications when a function uses `EXECUTE`.
- [07-procedures.md](./07-procedures.md) — `EXECUTE` inside procedures (works the same
  way) plus interaction with transaction control.
- [13-cursors-and-prepares.md](./13-cursors-and-prepares.md) — SQL-level `PREPARE` /
  `EXECUTE` / `DEALLOCATE` and the generic-vs-custom plan decision.
- [46-roles-privileges.md](./46-roles-privileges.md) — `SECURITY DEFINER` and privilege escalation risks in dynamic SQL functions.
- [47-row-level-security.md](./47-row-level-security.md) — RLS predicates can fire
  inside dynamic SQL exactly as inside embedded SQL; the security_invoker / barrier
  semantics still apply.
- [56-explain.md](./56-explain.md) — Profiling dynamic queries (use `auto_explain` or
  wrap the `EXECUTE` body with `EXPLAIN ANALYZE`).
- [57-pg-stat-statements.md](./57-pg-stat-statements.md) — Dynamic statements appear
  as separate normalized entries; track them like any other workload.
- [64-system-catalogs.md](./64-system-catalogs.md) — Catalog joins for the
  "iterate over every table in a schema" pattern and identifier inspection queries.

## Sources


[^plpgsql-stmts]: "PL/pgSQL — SQL Procedural Language: Basic Statements (Executing
    Dynamic Commands)" — PostgreSQL 16 documentation. Documents `EXECUTE
    command-string [INTO [STRICT] target] [USING expression [, ...]]`, the use of
    `$1`/`$2`/... value placeholders, why identifiers cannot be parameters, the
    `format()` + `USING` recommended pattern, the NULL-propagation pitfall of
    `quote_literal`, and the rule that `EXECUTE` plans are not cached. URL:
    https://www.postgresql.org/docs/16/plpgsql-statements.html

[^plpgsql-impl]: "PL/pgSQL Implementation: Plan Caching" — PostgreSQL 16
    documentation. Documents how embedded SQL in a PL/pgSQL function body is parsed
    once per session, prepared, and cached; contrasted with `EXECUTE` which re-parses
    and re-plans on every call. URL:
    https://www.postgresql.org/docs/16/plpgsql-implementation.html

[^funcs-string]: "String Functions and Operators" — PostgreSQL 16 documentation.
    Documents `format(formatstr text [, formatarg "any" [, ...]])` and the `%s` / `%I`
    / `%L` / `%%` specifiers, including the rule that `%I` raises on NULL and `%L`
    calls `quote_nullable` (so it tolerates NULL). Also documents `quote_ident(text)`,
    `quote_literal(text)` / `quote_literal(anyelement)` (returns NULL on NULL input),
    and `quote_nullable(text)` / `quote_nullable(anyelement)` (returns the unquoted
    SQL token `NULL` on NULL input). URL:
    https://www.postgresql.org/docs/16/functions-string.html

[^sql-prepare]: "PREPARE" — PostgreSQL 16 documentation. Documents the SQL-level
    prepared-statement facility: `PREPARE name [(type [, ...])] AS statement`, the
    consumer-side `EXECUTE name(...)`, `DEALLOCATE`, and the generic-vs-custom plan
    decision controlled by `plan_cache_mode`. URL:
    https://www.postgresql.org/docs/16/sql-prepare.html

[^pg14-plpgsql]: PostgreSQL 14 release notes: *"Improve PL/pgSQL's expression and
    assignment parsing (Tom Lane). This change allows assignment to array slices and
    nested record fields."* and *"Allow plpgsql's RETURN QUERY to execute its query
    using parallelism (Tom Lane)."* URL: https://www.postgresql.org/docs/release/14.0/

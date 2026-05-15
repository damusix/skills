# Functions (CREATE FUNCTION)

PostgreSQL functions, mutability, parallel safety, security context, polymorphic types, and the rules of SQL-function inlining.


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [CREATE FUNCTION grammar at a glance](#create-function-grammar-at-a-glance)
    - [LANGUAGE — which one to choose](#language--which-one-to-choose)
    - [Function body forms](#function-body-forms)
    - [Argument modes and naming](#argument-modes-and-naming)
    - [Default argument values](#default-argument-values)
    - [Return types: scalar, SETOF, TABLE](#return-types-scalar-setof-table)
    - [Volatility (VOLATILE / STABLE / IMMUTABLE)](#volatility-volatile--stable--immutable)
    - [Parallel safety (UNSAFE / RESTRICTED / SAFE)](#parallel-safety-unsafe--restricted--safe)
    - [SECURITY DEFINER vs SECURITY INVOKER](#security-definer-vs-security-invoker)
    - [LEAKPROOF](#leakproof)
    - [COST and ROWS](#cost-and-rows)
    - [STRICT / CALLED ON NULL INPUT](#strict--called-on-null-input)
    - [SET configuration parameters](#set-configuration-parameters)
    - [Polymorphic types](#polymorphic-types)
    - [Function overloading](#function-overloading)
    - [SUPPORT function](#support-function)
    - [Lock-level summary for function DDL](#lock-level-summary-for-function-ddl)
- [SQL function inlining (the big optimization)](#sql-function-inlining-the-big-optimization)
- [Examples / Recipes](#examples--recipes)
    - [Recipe 1 — A correctly marked immutable scalar function](#recipe-1--a-correctly-marked-immutable-scalar-function)
    - [Recipe 2 — A stable wrapper for an expensive subquery](#recipe-2--a-stable-wrapper-for-an-expensive-subquery)
    - [Recipe 3 — SECURITY DEFINER for a privileged write](#recipe-3--security-definer-for-a-privileged-write)
    - [Recipe 4 — TABLE function with named output columns](#recipe-4--table-function-with-named-output-columns)
    - [Recipe 5 — Polymorphic helper using `anycompatible`](#recipe-5--polymorphic-helper-using-anycompatible)
    - [Recipe 6 — VARIADIC argument](#recipe-6--variadic-argument)
    - [Recipe 7 — Functional index on an IMMUTABLE function](#recipe-7--functional-index-on-an-immutable-function)
    - [Recipe 8 — Set-returning SQL function used in FROM](#recipe-8--set-returning-sql-function-used-in-from)
    - [Recipe 9 — Idempotent function migration boilerplate](#recipe-9--idempotent-function-migration-boilerplate)
    - [Recipe 10 — Convert SQL function to BEGIN ATOMIC body (PG14+)](#recipe-10--convert-sql-function-to-begin-atomic-body-pg14)
    - [Recipe 11 — Pin search_path on every SECURITY DEFINER and index-used function](#recipe-11--pin-search_path-on-every-security-definer-and-index-used-function)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Use this file when:

- You need the full grammar of `CREATE FUNCTION` / `CREATE OR REPLACE FUNCTION` / `ALTER FUNCTION`.
- You are deciding **volatility** (`VOLATILE` vs `STABLE` vs `IMMUTABLE`) and the choice affects whether a function can be inlined, used in an index expression, or constant-folded.
- You are deciding **parallel safety** (`PARALLEL SAFE` / `RESTRICTED` / `UNSAFE`) and the choice affects whether the planner can use parallel workers.
- You need to write a **`SECURITY DEFINER`** function safely (pin `search_path`, revoke `PUBLIC` execute, audit who can call it).
- You are picking between a **scalar** return, a **`SETOF`** return, or a **`RETURNS TABLE`** form.
- You are using **polymorphic types** (`anyelement`, `anyarray`, `anycompatible*`, `anymultirange`) and need the matching rules.
- You want to know **when an SQL function gets inlined** and when it doesn't.

For procedures (which support transaction control), see [`07-procedures.md`](./07-procedures.md). For PL/pgSQL body specifics — variables, control flow, exception handling, dynamic `EXECUTE` — see [`08-plpgsql.md`](./08-plpgsql.md). For non-PL/pgSQL procedural languages, see [`09-procedural-languages.md`](./09-procedural-languages.md).


## Syntax / Mechanics



### CREATE FUNCTION grammar at a glance


The full grammar from the PG16 reference[^create-function]:

    CREATE [ OR REPLACE ] FUNCTION
        name ( [ [ argmode ] [ argname ] argtype [ { DEFAULT | = } default_expr ] [, ...] ] )
        [ RETURNS rettype
          | RETURNS TABLE ( column_name column_type [, ...] ) ]
      { LANGUAGE lang_name
        | TRANSFORM { FOR TYPE type_name } [, ... ]
        | WINDOW
        | { IMMUTABLE | STABLE | VOLATILE }
        | { CALLED ON NULL INPUT | RETURNS NULL ON NULL INPUT | STRICT }
        | { [ EXTERNAL ] SECURITY INVOKER | [ EXTERNAL ] SECURITY DEFINER }
        | PARALLEL { UNSAFE | RESTRICTED | SAFE }
        | LEAKPROOF
        | COST execution_cost
        | ROWS result_rows
        | SUPPORT support_function
        | SET configuration_parameter { TO value | = value | FROM CURRENT }
        | AS 'definition'
        | AS 'obj_file', 'link_symbol'
        | sql_body
      } ...

Every clause is **optional except `name`, the argument list, and either a return type or a body that implies one**. The order between clauses does not matter and clauses can repeat (later wins).


### LANGUAGE — which one to choose


The `LANGUAGE` clause names a *registered* procedural language[^create-function]. The built-ins:

| Language | Trusted? | When to use |
|---|---|---|
| `sql` | trusted | One-liners, wrappers, anything that can be a single SQL statement (or a sequence of pure statements). **Inlinable.** Use this aggressively for scalar helpers. |
| `plpgsql` | trusted | Anything that needs control flow, variables, exceptions, dynamic SQL. The workhorse. See [`08-plpgsql.md`](./08-plpgsql.md). |
| `c` | untrusted | Extension-grade speed; requires server-side `.so`. Cannot be created in most managed environments. |
| `internal` | untrusted | Bindings to built-in C functions exposed under a new SQL name. Reserved for the project; you should not normally need this. |
| `plperl` | trusted | Trusted Perl. |
| `plperlu` | untrusted | Unrestricted Perl. |
| `plpython3u` | untrusted | Untrusted only — the trusted `plpython3` was removed long ago. See [`09-procedural-languages.md`](./09-procedural-languages.md). |
| `pltcl`, `pltclu` | trusted / untrusted | Tcl. |
| `plv8` | trusted | JavaScript via the v8 engine (community extension). |

> [!NOTE] Default rule
> Reach for `sql` first. Promote to `plpgsql` only when you need control flow, exception handling, or local variables that an SQL function cannot express. Pick anything else only when the language gives you something neither can — almost always for performance-critical numeric work (C), for libraries with no SQL equivalent (Python), or for short-lived analytics in `plv8`.

> [!WARNING] Managed environments
> Most managed Postgres providers disallow `c`, `plperlu`, `plpython3u`, `plv8`, and any other untrusted language. Some allow only an allowlist of extensions, which controls which trusted PLs are even installed. Plan around the **trusted** subset (`sql`, `plpgsql`, `plperl`, `pltcl`) for portable code.


### Function body forms


There are three legal body shapes for an SQL or PL/pgSQL function:

**1. String literal (the classic form, works for every language):**

    CREATE FUNCTION add_em(integer, integer) RETURNS integer AS $$
        SELECT $1 + $2;
    $$ LANGUAGE sql;

**2. `RETURN expr` (SQL-language only, single expression):**

    CREATE FUNCTION add_em(a integer, b integer) RETURNS integer
        LANGUAGE sql
        RETURN a + b;

**3. `BEGIN ATOMIC ... END` (SQL-language only, multi-statement, parsed at definition time):**

    CREATE FUNCTION inc_then_return(i integer) RETURNS integer
        LANGUAGE sql
    BEGIN ATOMIC
        UPDATE counter SET v = v + 1 WHERE id = i;
        SELECT v FROM counter WHERE id = i;
    END;

> [!NOTE] PostgreSQL 14
> The `BEGIN ATOMIC ... END` and `RETURN expr` SQL-standard body forms were added in PG14[^pg14-sql-body]. The body is parsed when the function is created (not at first call), so referenced objects must exist at that moment — which is what allows the planner to **record dependencies on those objects** (a `DROP TABLE` of a referenced table will fail rather than silently break the function at next call).

**Practical recommendation:** use the `BEGIN ATOMIC` form when you write SQL functions you want to *also* depend correctly on schemas — the dependency tracking is the main reason to prefer it over the string-literal form. Stick with the string-literal form for PL/pgSQL bodies (it is the only form that supports them) and for SQL bodies that need to delay parsing until call time (rare, but happens with `CREATE TABLE` followed by `INSERT` in the same function — see the gotchas below).


### Argument modes and naming


    [ argmode ] [ argname ] argtype [ { DEFAULT | = } default_expr ]

`argmode` is one of `IN` (default, omittable), `OUT`, `INOUT`, `VARIADIC`. Only `OUT` parameters can follow a `VARIADIC` parameter[^create-function].

- **`IN`** — input. Counted toward the function signature for overload resolution.
- **`OUT`** — output. Not counted toward the signature. Defines a result column.
- **`INOUT`** — input *and* output. Counted toward the signature.
- **`VARIADIC`** — last position before any `OUT`, of array type. Caller may pass multiple scalars (collected into an array) or `VARIADIC ARRAY[...]` to pass an array directly.

Inside a SQL function body, arguments may be referenced by **name** *or* by **position** `$1`, `$2`, ...; inside PL/pgSQL, only the name is recommended (positional access works but is unreadable)[^xfunc-sql]. For composite-type arguments, use dot notation: `arg.field`.

The result column names of an `OUT`/`INOUT`/`TABLE` function are taken from the argument names, *not* the SQL identifiers used in the body. Be deliberate about your output names; they end up in plans, in PostgREST/PostgreSQL clients, and in `RETURNING`.


### Default argument values


    CREATE FUNCTION foo(a int, b int DEFAULT 2, c int DEFAULT 3)
        RETURNS int LANGUAGE sql
    AS $$ SELECT $1 + $2 + $3; $$;

    SELECT foo(10);          -- 15
    SELECT foo(10, 20);      -- 33
    SELECT foo(10, c => 30); -- 42  (named-notation skip)

Rules[^create-function]:

- Every parameter after the first one with a default must also have a default.
- Defaults are evaluated at **call time**, not at `CREATE FUNCTION` time, in the caller's snapshot — so `DEFAULT now()` returns the calling statement's timestamp, not the time the function was defined.
- Named-argument syntax (`name => value`) lets you skip a default in the middle. `=` and `:=` are also accepted between names and values inside calls; prefer `=>`.

> [!NOTE] PostgreSQL 14
> Procedures gained `OUT` parameters in PG14[^pg14-proc-out]. See [`07-procedures.md`](./07-procedures.md).


### Return types: scalar, SETOF, TABLE


Three shapes:

    -- Scalar
    RETURNS integer

    -- SETOF (multiple rows; can be a single column or a composite)
    RETURNS SETOF foo

    -- TABLE (named output columns; equivalent to a list of OUT params plus SETOF record)
    RETURNS TABLE (id int, name text)

`RETURNS TABLE (a int, b text)` is *exactly* equivalent to `OUT a int, OUT b text` plus `RETURNS SETOF record`. Pick `TABLE` when the function is "row-returning"; pick named `OUT` parameters when the function is "single-row with multiple outputs"; pick a `composite` type if the row shape already has a name in the catalog.

A function that returns `void` has no result row; calling it in `SELECT` produces an empty string column.

> [!NOTE] PostgreSQL 17
> SQL/JSON brought `JSON_TABLE` to make JSON document expansion an alternative to `RETURNS TABLE`, but it is a built-in row-returning *expression*, not a function form. See [`02-syntax-dql.md`](./02-syntax-dql.md) and [`17-json-jsonb.md`](./17-json-jsonb.md).


### Volatility (VOLATILE / STABLE / IMMUTABLE)


The volatility marker tells the planner what optimizations are legal[^xfunc-volatility]:

| Marker | May modify the DB? | Same args → same result? | Index-expression usable? | Constant-folded at plan time? |
|---|---|---|---|---|
| `VOLATILE` (default) | yes | no (may differ per row) | **no** | no |
| `STABLE` | no | same result *within one statement* | **yes** | no (snapshot is per-statement) |
| `IMMUTABLE` | no | same result *forever* | **yes** | **yes** (with constant arguments) |

Concrete examples from the manual[^xfunc-volatility]:

- `random()`, `currval()`, `timeofday()` — `VOLATILE`. Cannot be pulled out of a loop; will execute once per row.
- `current_timestamp` family, `now()`, lookups against a database row — `STABLE`. Safe to use in `WHERE` against an index.
- Pure mathematical functions, `lower()`, `length(text)` — `IMMUTABLE`. May appear in `CREATE INDEX (lower(name))` and may be constant-folded when called with literal arguments.

**The rule for mutability mistakes:**

- Marking a `VOLATILE` function as `IMMUTABLE` (e.g., because it `SELECT`s from a table) **silently** produces wrong answers when a plan is cached or the function is used in an index. The function will be executed against an old snapshot or constant-folded against a stale value.
- Marking an `IMMUTABLE` function as `VOLATILE` loses optimizations but is always safe.

**Always pick the strictest *correct* category.** If you accidentally pick stricter than correct, you are wrong; if you pick more permissive than correct, you are just slow.

> [!WARNING] `IMMUTABLE` and `TimeZone`
> A function that returns a value derived from the session `TimeZone` setting — for example, anything that calls `now()::date` or `to_char(some_timestamp, ...)` with locale-dependent format strings — is **at most `STABLE`**, never `IMMUTABLE`. Marking it `IMMUTABLE` and using it in an index produces silent corruption when the session timezone differs from the one used to build the index.

The `STABLE` snapshot rule deserves emphasis: `STABLE` and `IMMUTABLE` functions see the snapshot that was current when the *calling statement* began — they do **not** see the effects of later modifications by the same statement, and they do not establish a new snapshot per call. `VOLATILE` functions see a fresh snapshot on each call.


### Parallel safety (UNSAFE / RESTRICTED / SAFE)


    PARALLEL { UNSAFE | RESTRICTED | SAFE }

Default for all **user-defined** functions is `UNSAFE`[^parallel-safety]. The planner refuses to use a parallel plan if any expression it executes is `PARALLEL UNSAFE`. The categories:

| Marker | Where it may run | Examples |
|---|---|---|
| `SAFE` | Leader **and** workers | Pure math, immutable transforms with no side effects |
| `RESTRICTED` | Leader only (never inside a `Gather` node) | Temp-table access, cursors, prepared statements, `setseed`, `random()`[^parallel-safety] |
| `UNSAFE` (default) | Never under parallel query | Functions that write, allocate sequences, manage transactions, or have `PL/pgSQL EXCEPTION` blocks |

**Required `UNSAFE`** (the planner will be wrong if you lie)[^parallel-safety]:

- Writes to the database (`INSERT`/`UPDATE`/`DELETE`/`MERGE`/`COPY` from within the function).
- Accesses a sequence (`nextval`, `setval`, `currval`).
- Changes transaction state, including PL/pgSQL `BEGIN ... EXCEPTION WHEN ... END` — those blocks create subtransactions.
- Persistent settings changes (`ALTER SYSTEM`, role-level config changes).

**Required `RESTRICTED`** (when the operation needs the leader's backend state but is otherwise harmless):

- Accesses a temporary table (worker doesn't have the leader's `temp_buffers` view).
- Uses cursors, prepared statements, or any persistent client-connection state.
- Depends on backend-local state that cannot be synced across workers.

**Default to `UNSAFE`. Promote to `SAFE` only when you can prove every branch is safe.** A wrong `SAFE` label produces incorrect results or crashes; a wrong `UNSAFE` label only forces serial execution.

> [!NOTE] PL/pgSQL exception blocks
> A PL/pgSQL `EXCEPTION` clause forces the function to be **at most `RESTRICTED`** (in practice you usually mark such functions `UNSAFE`). The block creates a subtransaction so the executor can roll back the protected statements. Subtransactions are not safe inside parallel workers.


### SECURITY DEFINER vs SECURITY INVOKER


    [ EXTERNAL ] SECURITY INVOKER  -- default
    [ EXTERNAL ] SECURITY DEFINER

`SECURITY INVOKER` (default) — the function runs with the privileges of the **caller**. Reading a table the caller can read works; reading one they cannot, fails.

`SECURITY DEFINER` — the function runs with the privileges of the **owner**. This lets you grant `EXECUTE` on a function that performs operations the caller wouldn't normally be allowed to do directly. It is the only sound way to expose a privileged operation behind a narrow contract.

**The mandatory hardening for every `SECURITY DEFINER` function**[^create-function]:

1. `SET search_path = ...` to a controlled list ending in `pg_temp`. Otherwise an attacker who controls a schema earlier on the caller's path can shadow `pg_catalog` functions and hijack the function body.
2. `REVOKE EXECUTE ... FROM PUBLIC` and `GRANT EXECUTE` only to specific roles. By default `PUBLIC` has execute on new functions.
3. Quote and parameterize all identifiers and literals built dynamically — see [`10-dynamic-sql.md`](./10-dynamic-sql.md).
4. Mark the function `STABLE` or `VOLATILE` honestly. A `SECURITY DEFINER` function that lies about volatility is just as dangerous as one that doesn't pin its search_path.

The verbatim example from the docs[^create-function]:

    CREATE FUNCTION check_password(uname TEXT, pass TEXT)
    RETURNS BOOLEAN AS $$
    DECLARE passed BOOLEAN;
    BEGIN
        SELECT (pwd = $2) INTO passed
        FROM pwds
        WHERE username = $1;
        RETURN passed;
    END;
    $$  LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = admin, pg_temp;

> [!NOTE] PostgreSQL 17
> The PG17 release introduced **a safe `search_path` during maintenance operations** (`ANALYZE`, `CLUSTER`, `CREATE INDEX`, `CREATE MATERIALIZED VIEW`, `REFRESH MATERIALIZED VIEW`, `REINDEX`, `VACUUM`)[^pg17-search-path]. **Functions referenced by an expression index or by a materialized view that need to reach a non-default schema must now `SET search_path` on themselves** — otherwise the maintenance operation will fail to find the referenced object. Audit every function used by an index expression or materialized view *now*, not after the upgrade.


### LEAKPROOF


    [ NOT ] LEAKPROOF

A function is leakproof if it cannot leak information about its arguments through side channels — error messages, timing, or anything observable outside the return value. **Only a superuser can mark a function `LEAKPROOF`**[^create-function].

Leakproofness matters for **`security_barrier` views** and **row-level security**: the planner is allowed to push a leakproof predicate inside a barrier (because evaluating it on the rejected row reveals nothing), but it refuses to push a non-leakproof predicate through one. The default is `NOT LEAKPROOF`.

> [!NOTE] PostgreSQL 18
> `\df+` (and `\do+`, `\dAo+`, `\dC+`) now displays the function's leakproof indicator in psql[^pg18-leakproof], making it possible to audit existing functions without joining `pg_proc` against `proleakproof` by hand.

The typical reasons a function is *not* leakproof: it throws errors that include the argument value, it calls another non-leakproof function, or its execution time depends on the argument in a measurable way (e.g., it loops, allocates, or short-circuits before throwing).


### COST and ROWS


    COST execution_cost   -- units of cpu_operator_cost
    ROWS result_rows      -- estimated row count, only for set-returning functions

Defaults are `1` for C and internal functions, `100` for everything else; `ROWS` defaults to `1000` for set-returning functions[^create-function]. These are planner inputs — they affect *plan choice*, not actual execution time.

Common reasons to set them:

- `COST 1000` on an expensive PL/pgSQL function so the planner doesn't push its evaluation into a `WHERE` clause that would call it once per row when it could be called once.
- `ROWS 1` on a "scalar disguised as a set" function that always returns exactly one row.
- `ROWS 10000` on a generator function so the planner knows to materialize.

**Don't tune `COST` blindly.** Trace a slow plan first ([`56-explain.md`](./56-explain.md)) and find the function call you want to push or pull; then set `COST` only on that one.


### STRICT / CALLED ON NULL INPUT


    CALLED ON NULL INPUT          -- default
    RETURNS NULL ON NULL INPUT    -- synonym: STRICT

`STRICT` skips the function body entirely and returns `NULL` if **any** argument is `NULL`. Use this for any function whose mathematical or operational identity is "all-null in, null out" (almost all pure scalar functions). It is faster because the body never runs.

Mark a function `STRICT` when you mean it — it changes behavior, not just performance: a `STRICT` function never sees a `NULL` argument inside its body, so you can drop defensive `IF arg IS NULL ...` checks. Conversely, **never** mark a function `STRICT` if it has to do something specific on `NULL` (e.g., `COALESCE`-like, count-the-nulls, error on unexpected null).


### SET configuration parameters


    SET configuration_parameter { TO value | = value | FROM CURRENT }

The setting applies on function entry and is restored on exit[^create-function]. Most common uses:

- **`SET search_path = ...`** — mandatory for every `SECURITY DEFINER` and any function used in an index expression (PG17+ — see above).
- **`SET statement_timeout = '5s'`** — protect long calls from runaway queries.
- **`SET jit = off`** — disable JIT for short fast functions that pay the JIT planning cost without benefit ([`61-jit-compilation.md`](./61-jit-compilation.md)).
- **`SET row_security = on/off`** — bypass or enforce RLS within the function (subject to ownership).

`SET LOCAL` inside the function body is scoped to that function call, not the outer transaction; the outer caller's value is unaffected.


### Polymorphic types


Pseudo-types that let one function definition accept many concrete types[^extend-type-system]:

| Family | Type | What it accepts |
|---|---|---|
| Simple (must match exactly) | `anyelement` | Any data type. All `anyelement` positions must agree. |
|  | `anyarray` | Any array. Element type must match any sibling `anyelement`. |
|  | `anynonarray` | Like `anyelement`, but rejects array arguments. |
|  | `anyenum` | Any enum. |
|  | `anyrange` | Any range. |
|  | `anymultirange` | Any multirange. *PG14+.* |
| Common (promoted to a shared type) | `anycompatible` | Any value; siblings are unified via the usual `UNION` rules. |
|  | `anycompatiblearray` | Like `anycompatible`, but array. |
|  | `anycompatiblenonarray` | Common-family non-array. |
|  | `anycompatiblerange` | Common-family range. |
|  | `anycompatiblemultirange` | Common-family multirange. *PG14+.* |

> [!NOTE] PostgreSQL 14
> The `anycompatible*` family was extended significantly in PG14: built-ins like `array_append`, `array_prepend`, `array_cat`, `array_position`, `array_positions`, `array_remove`, `array_replace`, and `width_bucket` now take `anycompatiblearray` instead of `anyarray`[^pg14-anycompatible], so they accept mixed-but-compatible numeric inputs without explicit casts. Multirange types and `anymultirange` also arrived in PG14[^pg14-multirange].

The simple and common families are **independent variables**, so this is legal[^extend-type-system]:

    CREATE FUNCTION myfunc(a anyelement, b anyelement,
                           c anycompatible, d anycompatible)
    RETURNS anycompatible AS ...;

`a` and `b` must agree exactly; `c` and `d` are unified to a common type and that type is also the result.

There is no `anycompatibleenum` — implicit casts to enum types do not exist, so the common-family rules can't pick a target type[^extend-type-system].


### Function overloading


PostgreSQL allows two functions with the same name as long as their **input** argument types differ. `OUT` parameters do not participate in the signature[^create-function]:

    CREATE FUNCTION foo(int) ...           -- exists
    CREATE FUNCTION foo(int, OUT text) ... -- SAME signature - rejected

Overload resolution at call time picks the function whose argument types match exactly, or — if no exact match — the unique candidate reachable through implicit casts. Ambiguity is an error.

**Avoid overloading by data type alone.** It is the single most common source of "the wrong function gets called" bugs in PL/pgSQL codebases. Prefer distinct names: `foo_int(int)`, `foo_text(text)`.


### SUPPORT function


    SUPPORT support_function

A C function (only superusers can set it) that the planner can call for selectivity estimation, expression simplification, or custom row-count estimation[^alter-function]. Reserved for extensions. Not something you write in application code; mentioned here for completeness.


### Lock-level summary for function DDL


| Operation | Catalog lock |
|---|---|
| `CREATE FUNCTION` | `ROW EXCLUSIVE` on `pg_proc` (no relation locks unless the body references tables via `BEGIN ATOMIC`) |
| `CREATE OR REPLACE FUNCTION` | `ROW EXCLUSIVE` on `pg_proc`; in-flight calls already running continue with the old body[^create-function] |
| `ALTER FUNCTION ... RENAME / OWNER / SET SCHEMA` | `ACCESS EXCLUSIVE` on the function row in `pg_proc` (effectively serial) |
| `ALTER FUNCTION ... { IMMUTABLE / SECURITY DEFINER / ... }` | Update on `pg_proc` row; takes a brief catalog lock |
| `DROP FUNCTION` | `ACCESS EXCLUSIVE` on the `pg_proc` row; rejected if any object depends on it unless `CASCADE` |

`CREATE OR REPLACE FUNCTION` does **not** invalidate prepared plans automatically across all backends — backends with cached generic plans referring to the old function body may still execute the old body until their plan cache is invalidated. Tools that rotate function bodies in production should follow with `DISCARD PLANS;` or sequence around peak traffic. Cross-reference: [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md).


## SQL function inlining (the big optimization)


SQL-language functions are special: when the optimizer can prove safety, it **substitutes the function body directly into the calling query** — eliminating call overhead, allowing the inlined expression to participate in further constant folding, index-condition matching, and predicate push-down.

Conditions for an SQL function to be inlined into a SELECT[^xfunc-sql]:

- `LANGUAGE sql`.
- Body is **a single `SELECT`** (no multi-statement body for the inlinable case; `BEGIN ATOMIC` with one statement counts).
- Marked `STABLE` or `IMMUTABLE` (or `VOLATILE` is acceptable for the no-`SETOF` scalar form when the planner can prove there is no side effect — but you should not rely on this; mark it `STABLE` or `IMMUTABLE`).
- Not `SECURITY DEFINER` and not `SET configuration_parameter`.
- Not `STRICT` if any argument is non-null (the strictness check itself prevents inlining when arguments are nullable).

The same applies to **set-returning** SQL functions used in `FROM`: if the body is a single `SELECT`, the function expands into the caller's plan. This is why `SELECT * FROM get_user(123)` can use an index that the function itself never knew about — the body becomes the caller's body.

**Practical implication:** make scalar SQL helpers small, single-statement, `IMMUTABLE` or `STABLE`, and watch them disappear from `EXPLAIN`. The function call has zero runtime cost; the body's expression appears inline in the plan.

> [!NOTE] PostgreSQL 18
> PG18 improved **SQL-language function plan caching**[^pg18-sql-plan-cache], so non-inlinable SQL functions (multi-statement bodies, SECURITY DEFINER, etc.) reuse plans more aggressively. The inlining rules above are unchanged.


## Examples / Recipes



### Recipe 1 — A correctly marked immutable scalar function


An idiomatic transform helper:

    CREATE OR REPLACE FUNCTION lower_trim(t text) RETURNS text
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        STRICT
        RETURN lower(btrim(t));

- `IMMUTABLE` — same args, same result forever. Lets us use it in an index.
- `PARALLEL SAFE` — pure, no side effects.
- `STRICT` — `NULL` input → `NULL` output without running the body.

And the index that depends on it:

    CREATE INDEX users_email_norm_idx
        ON users (lower_trim(email));


### Recipe 2 — A stable wrapper for an expensive subquery


Wrap a row lookup so the function is `STABLE` and the planner can use it under an index:

    CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS bigint
        LANGUAGE sql
        STABLE
        PARALLEL SAFE
        AS $$
            SELECT tenant_id
              FROM sessions
             WHERE session_id = current_setting('app.session_id')::uuid;
        $$;

Then `WHERE tenant_id = current_tenant_id()` becomes index-friendly because `STABLE` makes the planner evaluate the function once per statement and use the result as a constant for index lookup.


### Recipe 3 — SECURITY DEFINER for a privileged write


A user-facing API that records an audit event without granting `INSERT` on the audit table to clients:

    CREATE OR REPLACE FUNCTION audit_event(kind text, payload jsonb)
        RETURNS bigint
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = audit, pg_temp
    AS $$
    DECLARE
        new_id bigint;
    BEGIN
        INSERT INTO audit.events(actor, kind, payload, at)
        VALUES (session_user, kind, payload, now())
        RETURNING id INTO new_id;
        RETURN new_id;
    END;
    $$;

    -- lock down execution surface
    REVOKE EXECUTE ON FUNCTION audit_event(text, jsonb) FROM PUBLIC;
    GRANT  EXECUTE ON FUNCTION audit_event(text, jsonb) TO app_role;

The `SET search_path = audit, pg_temp` is what makes this safe — without it, an attacker with `CREATE` on a schema earlier in the caller's `search_path` could create a `now()` of their own and hijack the body's logic.


### Recipe 4 — TABLE function with named output columns


    CREATE OR REPLACE FUNCTION top_n_per_user(n int)
        RETURNS TABLE (user_id bigint, posted_at timestamptz, body text)
        LANGUAGE sql
        STABLE
        PARALLEL SAFE
        AS $$
            SELECT user_id, posted_at, body
              FROM (
                  SELECT *, row_number() OVER (PARTITION BY user_id
                                               ORDER BY posted_at DESC) AS rn
                    FROM posts
              ) t
             WHERE rn <= n;
        $$;

    SELECT * FROM top_n_per_user(3);

Because the body is a single `SELECT`, this function inlines into the caller — `EXPLAIN` will show only the underlying scan and window plan, not a `Function Scan`.


### Recipe 5 — Polymorphic helper using `anycompatible`


    CREATE OR REPLACE FUNCTION coalesce_first_two(a anycompatible, b anycompatible)
        RETURNS anycompatible
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        RETURN COALESCE(a, b);

    SELECT coalesce_first_two(NULL::int, 7);          -- 7
    SELECT coalesce_first_two(1::int, 2.5::numeric);  -- 1 (promoted to numeric)
    SELECT coalesce_first_two('a'::text, 'b'::text);  -- 'a'

`anycompatible` (vs. `anyelement`) is what allows mixed-but-compatible numeric types to be passed without explicit casts.


### Recipe 6 — VARIADIC argument


    CREATE OR REPLACE FUNCTION sum_of(VARIADIC arr numeric[]) RETURNS numeric
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        RETURN (SELECT sum(x) FROM unnest(arr) AS x);

    SELECT sum_of(1, 2, 3);                            -- 6
    SELECT sum_of(VARIADIC ARRAY[1, 2, 3]::numeric[]); -- 6


### Recipe 7 — Functional index on an IMMUTABLE function


    CREATE OR REPLACE FUNCTION email_canonical(t text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
        RETURN lower(btrim(t));

    CREATE UNIQUE INDEX users_email_canonical_uniq
        ON users (email_canonical(email));

> [!WARNING] PostgreSQL 17 search_path
> If `email_canonical` referenced any non-`pg_catalog` object, you'd now need `SET search_path = public, pg_temp` on the function for the index to survive a `VACUUM`/`REINDEX` after a PG17 upgrade. The function above is safe because `lower` and `btrim` are in `pg_catalog`, which always appears on the planner's resolved path.


### Recipe 8 — Set-returning SQL function used in FROM


    CREATE OR REPLACE FUNCTION posts_in_range(t1 timestamptz, t2 timestamptz)
        RETURNS SETOF posts
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$
            SELECT *
              FROM posts
             WHERE posted_at >= t1
               AND posted_at <  t2;
        $$;

    SELECT id, body
      FROM posts_in_range('2026-05-01', '2026-06-01') AS p
     ORDER BY id LIMIT 50;

Because the body is one `SELECT`, this inlines — the outer query is planned against `posts` directly, with the time-range filter folded in and the `ORDER BY id LIMIT 50` available to combine with whatever index exists.


### Recipe 9 — Idempotent function migration boilerplate


    CREATE OR REPLACE FUNCTION normalize_phone(p text) RETURNS text
        LANGUAGE sql
        IMMUTABLE STRICT PARALLEL SAFE
        SET search_path = pg_catalog
        AS $$
            SELECT regexp_replace($1, '\D', '', 'g');
        $$;

    REVOKE EXECUTE ON FUNCTION normalize_phone(text) FROM PUBLIC;
    GRANT  EXECUTE ON FUNCTION normalize_phone(text) TO app_role;

Use this exact shape (single statement, `IMMUTABLE STRICT PARALLEL SAFE`, pinned `search_path`, controlled grants) for every public-API helper. `CREATE OR REPLACE` makes the migration re-runnable.


### Recipe 10 — Convert SQL function to BEGIN ATOMIC body (PG14+)


Old (string literal — late binding, no dependency tracking on referenced relations):

    CREATE OR REPLACE FUNCTION post_count(uid bigint) RETURNS bigint
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT count(*) FROM posts WHERE user_id = uid; $$;

New (`BEGIN ATOMIC` — parsed at definition time, dependency on `posts` recorded so it cannot be silently dropped):

    CREATE OR REPLACE FUNCTION post_count(uid bigint) RETURNS bigint
        LANGUAGE sql STABLE PARALLEL SAFE
    BEGIN ATOMIC
        SELECT count(*) FROM posts WHERE user_id = uid;
    END;

> [!NOTE] PostgreSQL 14
> Available since PG14[^pg14-sql-body]. Prefer this for any SQL function that references stable tables you don't want a colleague to silently drop.


### Recipe 11 — Pin search_path on every SECURITY DEFINER and index-used function


    -- catch up the entire schema in one go
    DO $$
    DECLARE r record;
    BEGIN
        FOR r IN
            SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE p.prosecdef = true
               AND p.proconfig IS NULL                       -- no SET clause at all
               AND n.nspname NOT IN ('pg_catalog','information_schema')
        LOOP
            EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = %I, pg_temp',
                           r.nspname, r.proname, r.args, r.nspname);
        END LOOP;
    END $$;

Run this audit before every major upgrade — especially before PG17 — and again as an alert (e.g., daily) so any newly created `SECURITY DEFINER` function without a pinned `search_path` shows up.


## Gotchas / Anti-patterns


1. **`SECURITY DEFINER` without `SET search_path`** — single most common Postgres CVE pattern. Always pin `search_path` and put `pg_temp` *last* on the list.
2. **Mislabeled volatility on a function used in an index** — silent corruption. The index gets built using one snapshot of the function's results; queries use stale or differing snapshots. Always verify with `pg_get_indexdef()` and rebuild the index after fixing the marker.
3. **`PARALLEL SAFE` on a function that allocates from a sequence** — wrong answers. Sequences are not parallel-safe.
4. **PL/pgSQL function with `EXCEPTION` block marked `PARALLEL SAFE`** — the exception block creates a subtransaction; subtransactions are not parallel-safe.
5. **`CREATE OR REPLACE FUNCTION` while the old function is in active use** — old in-flight calls keep running the old body. Plan cache invalidation across backends is *eventual*, not synchronous. Sequence rollouts during low traffic; consider a `DISCARD PLANS;` broadcast.
6. **Overloading by type that the planner unifies through implicit casts** — `foo(text)` and `foo(varchar)` are not distinguishable in practice; PG will pick "wrong" half the time. Name your functions distinctly instead.
7. **`STRICT` on a function that has to count NULL inputs** — the function body never sees them; the body just produces `NULL`.
8. **`IMMUTABLE` on a function that touches a configuration parameter** (`current_setting('TimeZone')`, `current_setting('app.x')`) — at most `STABLE`. The setting can change between calls.
9. **Inline-eligible SQL function with `SECURITY DEFINER` or `SET` clause** — not inlined. If you want the inlining behavior, drop the `SECURITY DEFINER` (factor it out of the inline hot path) and rely on a separate `SECURITY DEFINER` wrapper that calls the inlinable helper.
10. **Using `RETURNS SETOF record` instead of `RETURNS TABLE(...)` or a named composite type** — the caller must spell out the column types with `AS (...)` on every call: `SELECT * FROM dynamic_query(...) AS (id int, name text)`. Almost never worth it; use `RETURNS TABLE` or a named composite type.
11. **Functions in expression indexes without pinned `search_path` after PG17** — maintenance operations may fail because they now run with a safe path[^pg17-search-path]. Audit before upgrading.
12. **Forgetting to revoke `EXECUTE` from `PUBLIC`** — newly created functions are executable by `PUBLIC` by default. For privileged operations or audit-sensitive code, revoke and re-grant.
13. **Using a `VOLATILE` function in a join predicate** — the planner cannot pull the call out of the loop; you pay the function's cost per row. Mark it `STABLE` if it is and watch the plan re-shape.
14. **Defining `COST 1` on an expensive function to "make it look cheap"** — that just makes the planner *prefer* a plan that calls it more. `COST` controls plan choice; it does not change cost.
15. **`anyarray` instead of `anycompatiblearray`** — refuses mixed numeric types that callers naturally pass. Reach for the `anycompatible*` family by default unless the simple family's stricter matching is what you want.


## See Also


- [`07-procedures.md`](./07-procedures.md) — `CREATE PROCEDURE`, `CALL`, transaction control inside procedures.
- [`08-plpgsql.md`](./08-plpgsql.md) — PL/pgSQL body language: blocks, variables, control flow, exceptions, cursors, dynamic SQL.
- [`09-procedural-languages.md`](./09-procedural-languages.md) — PL/Perl, PL/Python (untrusted), PL/Tcl, plv8.
- [`10-dynamic-sql.md`](./10-dynamic-sql.md) — Safe `EXECUTE`, `format()`, `quote_ident`, `quote_literal`, injection prevention.
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — Generic vs custom plans, `plan_cache_mode` (PG12+).
- [`22-indexes-overview.md`](./22-indexes-overview.md) — Functional and expression indexes; what marker a function needs to be eligible.
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — Why `LEAKPROOF` matters for `security_barrier` and RLS interaction.
- [`42-isolation-levels.md`](./42-isolation-levels.md) — Snapshot rules for `STABLE` vs `IMMUTABLE` evaluation.
- [`53-server-configuration.md`](./53-server-configuration.md) — `search_path` GUC and its interaction with `SET search_path` on function bodies.
- [`43-locking.md`](./43-locking.md) — Catalog locks taken by function DDL.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `GRANT` / `REVOKE` on functions, default `PUBLIC` execute privilege.
- [`47-row-level-security.md`](./47-row-level-security.md) — `LEAKPROOF` interaction with RLS predicates.
- [`56-explain.md`](./56-explain.md) — Reading the plan to verify a function inlined.
- [`60-parallel-query.md`](./60-parallel-query.md) — How `PARALLEL { SAFE | RESTRICTED | UNSAFE }` affects plan shape.
- [`61-jit-compilation.md`](./61-jit-compilation.md) — When `SET jit = off` on a function is the right answer.


## Sources


[^create-function]: PostgreSQL 16 — `CREATE FUNCTION`. Full syntax, every clause, the `check_password` `SECURITY DEFINER` example with `SET search_path = admin, pg_temp`, the function-overloading rules (input arg types only — `OUT` ignored), and the rule that "all parameters after one with a default must also have defaults". https://www.postgresql.org/docs/16/sql-createfunction.html

[^alter-function]: PostgreSQL 16 — `ALTER FUNCTION`. List of alterable attributes, including the rule that only superusers may set `SUPPORT`. https://www.postgresql.org/docs/16/sql-alterfunction.html

[^xfunc-volatility]: PostgreSQL 16 — Function Volatility Categories. Definitions of `VOLATILE`/`STABLE`/`IMMUTABLE`, snapshot rules, and the explicit warning that mislabeling `IMMUTABLE` against `TimeZone`-dependent code "can cause stale values in cached plans". https://www.postgresql.org/docs/16/xfunc-volatility.html

[^parallel-safety]: PostgreSQL 16 — Parallel Safety. "By default, all user-defined functions are assumed parallel unsafe unless explicitly marked otherwise." Required-`UNSAFE` operations (writes, sequences, transaction-state changes including PL/pgSQL `EXCEPTION` blocks); required-`RESTRICTED` operations (temp tables, cursors, prepared statements; `setseed()` and `random()` are explicitly listed as parallel restricted). https://www.postgresql.org/docs/16/parallel-safety.html

[^xfunc-sql]: PostgreSQL 16 — SQL Functions. Inlining behavior, polymorphic-type examples (`make_array`/`make_array2`), VARIADIC behavior, `OUT`-not-in-signature rule, parse-time behavior ("The entire SQL function body is parsed before any of it is executed"). https://www.postgresql.org/docs/16/xfunc-sql.html

[^extend-type-system]: PostgreSQL 16 — Extending the Type System: Polymorphic Types. Pseudo-types `anyelement`, `anyarray`, `anynonarray`, `anyenum`, `anyrange`, `anymultirange`, `anycompatible*` family. Explicit statement that the simple and common families are independent variables. Statement that there is no `anycompatibleenum` "because implicit casts to enum types don't exist". https://www.postgresql.org/docs/16/extend-type-system.html

[^pg14-sql-body]: PostgreSQL 14 release notes — "SQL-language functions and procedures can now use SQL-standard function body syntax with immediate parsing." This is the `BEGIN ATOMIC ... END` and `RETURN expr` body forms. https://www.postgresql.org/docs/release/14.0/

[^pg14-proc-out]: PostgreSQL 14 release notes — "Allow procedures to have OUT parameters (Peter Eisentraut)". https://www.postgresql.org/docs/release/14.0/

[^pg14-anycompatible]: PostgreSQL 14 release notes — "Allow some array functions to operate on a mix of compatible data types (Tom Lane) - The functions array_append(), array_prepend(), array_cat(), array_position(), array_positions(), array_remove(), array_replace(), and width_bucket() now take anycompatiblearray instead of anyarray arguments." https://www.postgresql.org/docs/release/14.0/

[^pg14-multirange]: PostgreSQL 14 release notes — "Add support for multirange data types (Paul Jungwirth, Alexander Korotkov) - These are like range data types, but they allow the specification of multiple, ordered, non-overlapping ranges. An associated multirange type is automatically created for every range type." https://www.postgresql.org/docs/release/14.0/

[^pg17-search-path]: PostgreSQL 17 release notes — "Change functions to use a safe search_path during maintenance operations... This prevents maintenance operations (ANALYZE, CLUSTER, CREATE INDEX, CREATE MATERIALIZED VIEW, REFRESH MATERIALIZED VIEW, REINDEX, or VACUUM) from performing unsafe access. Functions used by expression indexes and materialized views that need to reference non-default schemas must specify a search path during function creation." https://www.postgresql.org/docs/release/17.0/

[^pg18-leakproof]: PostgreSQL 18 release notes — "Added function's leakproof indicator to psql's output commands. The \df+, \do+, \dAo+, and \dC+ commands now display leakproof status (Yugo Nagata)." https://www.postgresql.org/docs/release/18.0/

[^pg18-sql-plan-cache]: PostgreSQL 18 release notes — "Improve SQL-language function plan caching (Alexander Pyhalov, Tom Lane)." https://www.postgresql.org/docs/release/18.0/

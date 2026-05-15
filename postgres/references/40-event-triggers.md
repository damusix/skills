# Event Triggers

DDL-level triggers that fire on `CREATE` / `ALTER` / `DROP` / `GRANT` / `REVOKE` / `COMMENT` / `SECURITY LABEL` / `SELECT INTO` (and PG17+ login). Unlike DML triggers (see [39-triggers.md](./39-triggers.md)), event triggers are **database-global**, capture **DDL events** rather than per-row mutations, must return type `event_trigger`, and are created by superusers only.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax and Mechanics](#syntax-and-mechanics)
    - [The Five Event Types](#the-five-event-types)
    - [CREATE EVENT TRIGGER Grammar](#create-event-trigger-grammar)
    - [Event Trigger Function Signature](#event-trigger-function-signature)
    - [WHEN TAG IN (...) Filter](#when-tag-in--filter)
    - [Firing Order](#firing-order)
    - [Restrictions and Failure Modes](#restrictions-and-failure-modes)
    - [Firing Matrix](#firing-matrix)
    - [Support Functions](#support-functions)
    - [ALTER EVENT TRIGGER](#alter-event-trigger)
    - [DROP EVENT TRIGGER](#drop-event-trigger)
    - [Login Event Triggers (PG17+)](#login-event-triggers-pg17)
    - [The event_triggers GUC (PG17+)](#the-event_triggers-guc-pg17)
    - [Per-version Timeline](#per-version-timeline)
- [Examples and Recipes](#examples-and-recipes)
- [Gotchas and Anti-patterns](#gotchas-and-anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when you need to:

- Audit every DDL change a database receives (compliance, schema-drift detection)
- Block a specific DDL command in production (`DROP TABLE`, `TRUNCATE`, `ALTER TABLE ... SET LOGGED/UNLOGGED`)
- Capture the OIDs and names of objects dropped by a single DDL command (which is when `pg_event_trigger_dropped_objects()` is the only API that works — at any other time the catalog rows are already gone)
- Detect that an `ALTER TABLE` or `ALTER TYPE` is about to **rewrite the table** (full-table rewrite is a maintenance-window operation, not a metadata change)
- Run per-session setup on connection (PG17+ `login` event)
- Build a manual DDL replication pipeline for use cases where logical replication's no-DDL-replication gap is the blocker
- Diagnose "why is my session locked out?" when a buggy event trigger has made every connection fail

Cross-references: [39-triggers.md](./39-triggers.md) for DML triggers, [46-roles-privileges.md](./46-roles-privileges.md) for superuser requirement, [51-pgaudit.md](./51-pgaudit.md) for the production-ready compliance audit alternative, [74-logical-replication.md](./74-logical-replication.md) for the DDL-replication gap that drives the manual-replication use case.

## Mental Model

Five rules that drive every event-trigger decision:

1. **Event triggers fire on DDL events, not DML.** DML triggers (see [39-triggers.md](./39-triggers.md)) attach to tables and fire on `INSERT`/`UPDATE`/`DELETE`. Event triggers attach to a *database* and fire on `CREATE`/`ALTER`/`DROP`/`GRANT`/`REVOKE`/`COMMENT`/`SECURITY LABEL`/`SELECT INTO` (and PG17+ login). Verbatim docs intro: *"Unlike regular triggers, which are attached to a single table and capture only DML events, event triggers are global to a particular database and are capable of capturing DDL events."*[^et-overview]

2. **There are five event types, not arbitrary events.** `ddl_command_start`, `ddl_command_end`, `sql_drop`, `table_rewrite`, and (PG17+) `login`. You cannot define custom events. The full PG17+ list, verbatim: *"Currently, the only supported events are `login`, `ddl_command_start`, `ddl_command_end`, `table_rewrite` and `sql_drop`."*[^pg17-login]

3. **The trigger function must return type `event_trigger`.** Verbatim: *"In order to create an event trigger, you must first create a function with the special return type `event_trigger`. This function need not (and may not) return a value; the return type serves merely as a signal that the function is to be invoked as an event trigger."*[^et-overview]

4. **You cannot `ROLLBACK` from inside, but you can `RAISE EXCEPTION` to abort the DDL.** A `ddl_command_start` trigger that raises stops the DDL from executing at all. A `ddl_command_end` trigger that raises causes the DDL effects to roll back (the actions happened, the transaction unwinds).

5. **`CREATE EVENT TRIGGER` is superuser-only.** Verbatim: *"Only superusers can create event triggers."*[^create-et] On PG17+ a buggy event trigger can be bypassed via `SET event_triggers = off` rather than restarting in single-user mode.[^pg17-guc] Pre-PG17, single-user mode is the only escape hatch — verbatim: *"Event triggers are disabled in single-user mode."*[^create-et]

> [!WARNING] Login event triggers on standbys must not write
> A `login` event trigger fires on standby servers too. Any write inside it will fail because standbys are read-only — and that failure will prevent every login. Verbatim: *"To prevent servers from becoming inaccessible, such triggers must avoid writing anything to the database when running on a standby."*[^pg17-login]

## Decision Matrix

| You need to                                                       | Use                                                          | Avoid                                              | Why                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Audit all DDL (compliance, drift detection)                       | `ddl_command_end` + `pg_event_trigger_ddl_commands()`        | `ddl_command_start` (parse-tree is unstable)       | The end-event API gives you stable command_tag + object_identity rows                              |
| Block specific DDL (e.g. forbid `DROP TABLE` in prod)             | `ddl_command_start` + `WHEN TAG IN (...)` + `RAISE EXCEPTION` | Triggers without `WHEN` filter                     | `RAISE EXCEPTION` in start-event aborts the DDL cleanly with no rollback work                      |
| Capture which objects were dropped                                | `sql_drop` + `pg_event_trigger_dropped_objects()`            | Querying `pg_class` after the drop                 | Only `sql_drop` can see the dropped catalog rows; everywhere else they're already gone             |
| Detect a full-table rewrite                                       | `table_rewrite` + `pg_event_trigger_table_rewrite_reason()`  | Polling `pg_stat_progress_*`                       | Fires *before* the rewrite begins, with bitmap of the reason (persistence/default/type/AM change)   |
| Run per-session setup on login (PG17+)                            | `login` event trigger                                        | Client-side connection-init scripts                | Server-side login event runs even for tools that bypass psql's `~/.psqlrc`                          |
| Emergency-disable a buggy event trigger on PG17+                  | `SET event_triggers = off` (superuser session)               | Restarting in single-user mode                     | GUC-based disable is per-session and avoids cluster downtime                                       |
| Emergency-disable a buggy event trigger on PG≤16                  | `postgres --single` (single-user mode)                       | Trying to `DROP EVENT TRIGGER` from a live session | The trigger blocks every DDL including its own DROP                                                |
| Temporarily disable without dropping                              | `ALTER EVENT TRIGGER ... DISABLE`                            | DROP + later recreate                              | Disabled triggers stay in catalog; metadata + ACL preserved                                        |
| Replicate DDL to a secondary cluster                              | `ddl_command_end` + custom queue table                       | Native logical replication                         | Logical replication has no native DDL replication (see [74](./74-logical-replication.md))           |
| Cause DDL to fire on a standby's event triggers                   | `ENABLE REPLICA` mode + `session_replication_role = replica` | `ENABLE` (default origin-only)                     | Only ALWAYS / REPLICA modes fire on the replication apply path                                     |
| Audit which user issued which DDL                                 | `ddl_command_end` + `current_user` / `session_user`          | Parsing logs                                       | In-trigger context has full session identity                                                       |

Three smell signals that you reached for the wrong tool:

- **Trying to fire on `CREATE DATABASE` / `DROP DATABASE` / `CREATE ROLE` / `DROP TABLESPACE`** — event triggers do **not** fire for DDL on shared (cluster-wide) objects. There is no escape hatch; this is a fundamental restriction.
- **Using `ddl_command_start` to audit completed DDL** — the start event can't access the post-execution catalog state. Use `ddl_command_end` for audits.
- **Building a write-heavy `login` event trigger for "real-time" connection telemetry** — this serializes on every login and breaks standbys. Use the connection-log + log-parsing path (see [51-pgaudit.md](./51-pgaudit.md)).

## Syntax and Mechanics

### The Five Event Types

Event triggers fire on one of five named events.

| Event                | Fires                                                                             | Useful support functions                                  | Available since |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------- |
| `ddl_command_start`  | Before any `CREATE`/`ALTER`/`DROP`/`SECURITY LABEL`/`COMMENT`/`GRANT`/`REVOKE`/`SELECT INTO` | `TG_TAG` (and `TG_EVENT` for context)                  | PG 9.3          |
| `ddl_command_end`    | After the same commands; before transaction commit                                 | `pg_event_trigger_ddl_commands()`                         | PG 9.3          |
| `sql_drop`           | Just before `ddl_command_end` for any DROP; after catalog rows are gone           | `pg_event_trigger_dropped_objects()`                      | PG 9.3          |
| `table_rewrite`      | Just before an `ALTER TABLE`/`ALTER TYPE`/`ALTER MATERIALIZED VIEW` table rewrite | `pg_event_trigger_table_rewrite_oid()` / `..._reason()`   | PG 9.5          |
| `login`              | After authentication succeeds, before the first client query                       | `current_user`, `pg_stat_activity`, normal SQL            | PG 17           |

> [!NOTE] PostgreSQL 17
> The `login` event was added in PG17. Verbatim release note: *"Add support for event triggers that fire at connection time (Konstantin Knizhnik, Mikhail Gribkov)."*[^pg17-login-rn]

### CREATE EVENT TRIGGER Grammar

Verbatim synopsis:[^create-et]

    CREATE EVENT TRIGGER name
        ON event
        [ WHEN filter_variable IN (filter_value [, ... ]) [ AND ... ] ]
        EXECUTE { FUNCTION | PROCEDURE } function_name()

Parameters:

- `name` — unique within the database. Not schema-qualified (event triggers are database-global, not schema-scoped).
- `event` — one of `ddl_command_start` / `ddl_command_end` / `sql_drop` / `table_rewrite` / `login`.
- `filter_variable` — verbatim: *"Currently the only supported filter_variable is TAG."*[^create-et]
- `filter_value` — single-quoted SQL command tag string, e.g. `'DROP TABLE'`, `'CREATE INDEX'`, `'ALTER TABLE'`.
- `function_name` — a function with zero parameters and `RETURNS event_trigger`.

> [!WARNING] PROCEDURE keyword is deprecated
> Verbatim docs: *"In the syntax of `CREATE EVENT TRIGGER`, the keywords `FUNCTION` and `PROCEDURE` are equivalent, but the referenced function must in any case be a function, not a procedure. The use of the keyword `PROCEDURE` here is historical and deprecated."*[^create-et] Use `EXECUTE FUNCTION`. The grammar accepts `EXECUTE PROCEDURE` but the target object must still be a function — the keyword is misleading.

Compatibility note (verbatim): *"There is no CREATE EVENT TRIGGER statement in the SQL standard."*[^create-et]

### Event Trigger Function Signature

The function must:

1. Take **zero parameters** (everything comes through `TG_*` special variables and the support functions).
2. Return type `event_trigger` (not `trigger`, not `record`).
3. Not contain a `RETURN` value — only `RETURN;` is valid (returning nothing).

Canonical PL/pgSQL skeleton:

    CREATE OR REPLACE FUNCTION my_event_trigger_fn()
    RETURNS event_trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        -- TG_EVENT     :: text  -- 'ddl_command_start', etc.
        -- TG_TAG       :: text  -- 'CREATE TABLE', etc.
        RAISE NOTICE 'event=% tag=%', TG_EVENT, TG_TAG;
    END;
    $$;

In C, the function uses `CALLED_AS_EVENT_TRIGGER(fcinfo)` and reads `EventTriggerData` from `fcinfo->context`. Per docs: *"The function must not alter the EventTriggerData structure or any of the data it points to."*[^et-c-interface] The `parsetree` field is explicitly subject to change without notice — do not rely on it.

### WHEN TAG IN (...) Filter

The `WHEN TAG IN (...)` clause is the only filter the grammar supports. It narrows the firing to specific command tags.

    CREATE EVENT TRIGGER block_dangerous_ddl
        ON ddl_command_start
        WHEN TAG IN ('DROP TABLE', 'TRUNCATE TABLE', 'DROP SCHEMA')
        EXECUTE FUNCTION refuse();

Filter value must be uppercase and match the SQL command tag as reported by `TG_TAG` (or by `pg_event_trigger_ddl_commands().command_tag`). The full list of valid command tags is the left column of the firing matrix.

Common pitfall: the tag is the **command type**, not the object type. `DROP INDEX`, `DROP TABLE`, `DROP FUNCTION` are three different tags. `WHEN TAG IN ('DROP')` matches nothing.

### Firing Order

Verbatim rule: *"If more than one event trigger is defined for a particular event, they will fire in alphabetical order by trigger name."*[^et-overview] Same convention as DML triggers (see [39-triggers.md](./39-triggers.md) firing-order H3). Operationally this means a `01_audit_ddl` trigger fires before a `99_block_drop` trigger on the same event — name your triggers with leading prefixes if order matters.

### Restrictions and Failure Modes

The five hard rules:

| Rule                                                                  | Consequence                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cannot run in an aborted transaction                                  | If a prior statement errored, no event trigger fires for the cleanup                  |
| Cannot fire on shared objects                                         | `CREATE DATABASE`, `CREATE ROLE`, `CREATE TABLESPACE` and their DROPs all bypass event triggers |
| Cannot fire on event-trigger DDL itself                               | `CREATE EVENT TRIGGER` / `DROP EVENT TRIGGER` do not invoke event triggers (no recursion possible) |
| `ddl_command_start` raise → DDL not executed                          | Clean abort; no rollback work                                                          |
| `ddl_command_end` raise → DDL effects rolled back                     | More expensive; the actions ran, the transaction is unwound                            |

Single-user mode is the universal escape hatch when an event trigger is misbehaving. Verbatim: *"Event triggers are disabled in single-user mode (see postgres). If an erroneous event trigger disables the database so much that you can't even drop the trigger, restart in single-user mode and you'll be able to do that."*[^create-et]

On PG17+ the GUC `event_triggers = off` provides a less-disruptive alternative; see the dedicated subsection below.

### Firing Matrix

Selected highlights from the firing matrix.[^et-matrix] The matrix has ~80 rows; what matters operationally is:

| Category                                                               | start  | end   | sql_drop | table_rewrite |
| ---------------------------------------------------------------------- | ------ | ----- | -------- | ------------- |
| All `CREATE *`, `ALTER *` (most), `COMMENT`, `GRANT`, `REVOKE`         | X      | X     | —        | —             |
| All `DROP *` (any object type)                                         | X      | X     | X        | —             |
| `ALTER TABLE` (can drop columns/constraints)                           | X      | X     | X        | X if rewrite |
| `ALTER FOREIGN TABLE` (can drop columns)                               | X      | X     | X        | —             |
| `ALTER MATERIALIZED VIEW` (rewrites possible)                          | X      | X     | —        | X if rewrite |
| `ALTER TYPE` (rewrites possible)                                       | X      | X     | —        | X if rewrite |
| `SELECT INTO`                                                          | X      | X     | —        | —             |
| `REFRESH MATERIALIZED VIEW`                                            | X      | X     | —        | —             |
| `REINDEX` (PG17+)                                                      | X      | X     | —        | —             |
| `CLUSTER`, `VACUUM`                                                    | —      | —     | —        | —             |
| `CREATE DATABASE`, `DROP DATABASE`, `CREATE ROLE`, etc.                | —      | —     | —        | —             |
| `CREATE EVENT TRIGGER` / `DROP EVENT TRIGGER`                          | —      | —     | —        | —             |

Three operational rules to remember (full command matrix at [^et-matrix]):

1. **`table_rewrite` is rare.** Only `ALTER TABLE`, `ALTER TYPE`, and `ALTER MATERIALIZED VIEW` ever fire it, and only when the action triggers a rewrite (changing column type, persistence, default, or access method).
2. **`sql_drop` fires for any DROP** — including DROPs caused by `ALTER TABLE ... DROP COLUMN`.
3. **`COMMENT` / `GRANT` / `REVOKE` / `SECURITY LABEL` only fire for local objects.** A `GRANT ON DATABASE` or `GRANT ROLE` does not fire any event trigger.

> [!NOTE] PostgreSQL 17
> `REINDEX` was added to the firing matrix in PG17. Verbatim release note: *"Add event trigger support for REINDEX (Garrett Thornburg, Jian He)."*[^pg17-reindex-rn] It fires `ddl_command_start` and `ddl_command_end`, not `sql_drop` or `table_rewrite`.

### Support Functions

Four functions provide access to context, each restricted to specific event types:

| Function                                       | Valid in event              | Returns                                              |
| ---------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| `pg_event_trigger_ddl_commands()`              | `ddl_command_end` only      | setof rows: classid, objid, objsubid, command_tag, object_type, schema_name, object_identity, in_extension, command |
| `pg_event_trigger_dropped_objects()`           | `sql_drop` only             | setof rows: classid, objid, objsubid, original, normal, is_temporary, object_type, schema_name, object_name, object_identity, address_names, address_args |
| `pg_event_trigger_table_rewrite_oid()`         | `table_rewrite` only        | `oid` — the table about to be rewritten              |
| `pg_event_trigger_table_rewrite_reason()`      | `table_rewrite` only        | `integer` bitmap: 1=persistence, 2=default, 4=type, 8=access method |

Calling any of these outside its event raises an error. The trigger function must branch on `TG_EVENT` if it serves multiple events.

`pg_event_trigger_dropped_objects()` is the only API that can see catalog rows that have just been deleted — by `sql_drop` time the rows are *already gone* from `pg_class` etc., so attempting to query the catalogs by OID will return zero rows. Verbatim from the function definition: *"executes after objects are deleted from system catalogs."*[^functions-et]

The `command` column from `pg_event_trigger_ddl_commands()` returns type `pg_ddl_command` — an opaque internal representation. There is no SQL function to decode it back into the original SQL text (you must use the `object_identity` and `command_tag` fields to reconstruct, or use it as an opaque payload).

### ALTER EVENT TRIGGER

Verbatim synopsis:[^alter-et]

    ALTER EVENT TRIGGER name DISABLE
    ALTER EVENT TRIGGER name ENABLE [ REPLICA | ALWAYS ]
    ALTER EVENT TRIGGER name OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
    ALTER EVENT TRIGGER name RENAME TO new_name

The four enabled-states are identical in surface form to those for DML triggers (see [39-triggers.md](./39-triggers.md) firing modes). The interaction with `session_replication_role` is the same:

| State           | Fires on origin sessions | Fires when `session_replication_role = replica` |
| --------------- | :----------------------: | :---------------------------------------------: |
| `DISABLE`       | no                       | no                                              |
| `ENABLE` (default) | yes                  | no                                              |
| `ENABLE REPLICA` | no                      | yes                                             |
| `ENABLE ALWAYS` | yes                      | yes                                             |

Verbatim: *"You must be superuser to alter an event trigger."*[^alter-et]

### DROP EVENT TRIGGER

Verbatim synopsis:[^drop-et]

    DROP EVENT TRIGGER [ IF EXISTS ] name [ CASCADE | RESTRICT ]

Notable asymmetry with `CREATE EVENT TRIGGER`: only the *owner* (not necessarily a superuser) can drop. Verbatim: *"To execute this command, the current user must be the owner of the event trigger."*[^drop-et] But since only a superuser can create one in the first place, the owner starts out as a superuser — though `ALTER EVENT TRIGGER ... OWNER TO some_role` can hand it off.

### Login Event Triggers (PG17+)

> [!NOTE] PostgreSQL 17
> The `login` event fires after authentication succeeds, before the first client query. Verbatim: *"The `login` event occurs when an authenticated user logs into the system."*[^pg17-login]

Critical operational facts:

1. **Bugs lock everyone out.** Verbatim: *"Any bug in a trigger procedure for this event may prevent successful login to the system."*[^pg17-login] Test thoroughly in a non-prod environment before deploying.
2. **Standbys are read-only.** Verbatim: *"The `login` event will also fire on standby servers. To prevent servers from becoming inaccessible, such triggers must avoid writing anything to the database when running on a standby."*[^pg17-login] Use a `pg_is_in_recovery()` guard at the start of the function.
3. **Long-running queries block logins.** Verbatim: *"It's recommended to avoid long-running queries in `login` event triggers."*[^pg17-login]
4. **Cannot be cancelled via Ctrl-C.** Verbatim: *"Note that, for instance, canceling a connection in psql will not cancel the in-progress `login` trigger."*[^pg17-login]
5. **Emergency escape hatches.** Verbatim: *"Such bugs may be worked around by setting [event_triggers](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-EVENT-TRIGGERS) to `false` either in a connection string or configuration file. Alternatively, you can restart the system in single-user mode."*[^pg17-login]

Setting `event_triggers = false` in a connection string is the canonical recovery path:

    psql "host=primary dbname=mydb user=postgres options='-c event_triggers=off'"

This works because the GUC has `userset` context — any session can disable for itself if it has the appropriate privilege.

### The event_triggers GUC (PG17+)

> [!NOTE] PostgreSQL 17
> Verbatim release note: *"Add server variable to disable event triggers (Daniel Gustafsson). The setting, `event_triggers`, allows for the temporary disabling of event triggers for debugging."*[^pg17-guc-rn]

Verbatim docs entry: *"`event_triggers` (`boolean`) — Allow temporarily disabling execution of event triggers in order to troubleshoot and repair faulty event triggers. All event triggers will be disabled by setting it to `false`. Setting the value to `true` allows all event triggers to fire, this is the default value. Only superusers and users with the appropriate `SET` privilege can change this setting."*[^pg17-guc]

Default: `true`. The GUC is the PG17+ alternative to single-user mode for recovering from a buggy event trigger, and the canonical mechanism for "I want to deploy a schema change without the audit-logging trigger firing":

    BEGIN;
    SET LOCAL event_triggers = off;
    CREATE TABLE temp_workspace_for_migration (...);
    DROP TABLE temp_workspace_for_migration;
    COMMIT;

Pre-PG17 the only way to bypass an event trigger was single-user mode or `ALTER EVENT TRIGGER ... DISABLE` (which requires the trigger not to be blocking your own DDL).

### Per-version Timeline

| Version | Change                                                                                                                                   | Citation                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| PG14    | *No event-trigger-specific changes.* Verified by direct fetch.                                                                          | [^pg14-rn]                                |
| PG15    | `pg_event_trigger_ddl_commands()` now reports actual temp-schema names (was always `pg_temp`)                                            | [^pg15-tempschema]                        |
| PG16    | *No event-trigger-specific changes.* Verified by direct fetch.                                                                          | [^pg16-rn]                                |
| PG17    | Three changes: `login` event added; `REINDEX` added to firing matrix; `event_triggers` GUC added                                         | [^pg17-login-rn] [^pg17-reindex-rn] [^pg17-guc-rn] |
| PG18    | *No event-trigger-specific changes.* Verified by direct fetch.                                                                          | [^pg18-rn]                                |

## Examples and Recipes

### Recipe 1: Audit all DDL to a log table

The canonical compliance/drift pattern. Use `ddl_command_end` so the audit captures only DDL that actually succeeded.

    CREATE TABLE ddl_audit_log (
        id           bigserial PRIMARY KEY,
        occurred_at  timestamptz NOT NULL DEFAULT now(),
        session_user_name text NOT NULL,
        current_user_name text NOT NULL,
        client_addr  inet,
        application_name text,
        command_tag  text NOT NULL,
        object_type  text,
        schema_name  text,
        object_identity text,
        in_extension boolean
    );

    CREATE OR REPLACE FUNCTION audit_ddl()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog AS $$
    DECLARE
        r record;
    BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
            INSERT INTO public.ddl_audit_log (
                session_user_name, current_user_name, client_addr, application_name,
                command_tag, object_type, schema_name, object_identity, in_extension
            )
            SELECT session_user, current_user,
                   (SELECT client_addr FROM pg_stat_activity WHERE pid = pg_backend_pid()),
                   current_setting('application_name', true),
                   r.command_tag, r.object_type, r.schema_name, r.object_identity, r.in_extension;
        END LOOP;
    END;
    $$;

    CREATE EVENT TRIGGER audit_ddl
        ON ddl_command_end
        EXECUTE FUNCTION audit_ddl();

The `SECURITY DEFINER` + pinned `search_path` pattern is required because the trigger fires under whichever role issued the DDL — and may not have INSERT on the audit table. The pinned search_path defeats SQL-injection through schema lookup (see [06-functions.md](./06-functions.md)). For production compliance, [51-pgaudit.md](./51-pgaudit.md) is the better tool — its scope and durability are wider — but this recipe shows the mechanism.

### Recipe 2: Capture dropped objects

`pg_event_trigger_dropped_objects()` is the only API that can see the dropped objects' identities. Without it, the catalog rows are already gone by the time anything else runs.

    CREATE TABLE drop_audit_log (
        id           bigserial PRIMARY KEY,
        occurred_at  timestamptz NOT NULL DEFAULT now(),
        session_user_name text NOT NULL,
        object_type  text,
        schema_name  text,
        object_identity text,
        was_temporary boolean
    );

    CREATE OR REPLACE FUNCTION audit_drops()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog AS $$
    DECLARE
        obj record;
    BEGIN
        FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() WHERE original LOOP
            INSERT INTO public.drop_audit_log (
                session_user_name, object_type, schema_name, object_identity, was_temporary
            )
            VALUES (
                session_user, obj.object_type, obj.schema_name, obj.object_identity, obj.is_temporary
            );
        END LOOP;
    END;
    $$;

    CREATE EVENT TRIGGER audit_drops
        ON sql_drop
        EXECUTE FUNCTION audit_drops();

The `WHERE original` filter excludes cascaded drops — useful when `DROP SCHEMA ... CASCADE` would otherwise log every dependent object as a separate audit row. Drop `WHERE original` if you want the full cascade list.

### Recipe 3: Prevent DROP TABLE in production

`ddl_command_start` + `WHEN TAG` + `RAISE EXCEPTION` aborts the DDL before it executes.

    CREATE OR REPLACE FUNCTION refuse_drop_table()
    RETURNS event_trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'DROP TABLE is forbidden in this environment. Use the migration framework.'
            USING ERRCODE = 'insufficient_privilege',
                  HINT = 'Set event_triggers = off to bypass for emergency repair (superuser only).';
    END;
    $$;

    CREATE EVENT TRIGGER no_drop_table
        ON ddl_command_start
        WHEN TAG IN ('DROP TABLE')
        EXECUTE FUNCTION refuse_drop_table();

Operationally: a superuser can still issue `SET event_triggers = off; DROP TABLE foo; SET event_triggers = on;` to bypass this on PG17+. Pre-PG17 the only bypass is single-user mode. This is *defense in depth*, not a security guarantee — anyone with superuser can always bypass.

### Recipe 4: Monitor table rewrites for maintenance-window alerting

The `table_rewrite` event fires *before* the rewrite begins and exposes the reason via a bitmap.

    CREATE TABLE rewrite_alerts (
        id           bigserial PRIMARY KEY,
        occurred_at  timestamptz NOT NULL DEFAULT now(),
        table_oid    oid NOT NULL,
        table_name   text,
        reason_mask  integer,
        reason_text  text
    );

    CREATE OR REPLACE FUNCTION warn_on_rewrite()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog AS $$
    DECLARE
        oid_value oid := pg_event_trigger_table_rewrite_oid();
        mask      integer := pg_event_trigger_table_rewrite_reason();
        reasons   text := '';
    BEGIN
        IF mask & 1 = 1 THEN reasons := reasons || 'persistence-change '; END IF;
        IF mask & 2 = 2 THEN reasons := reasons || 'default-change '; END IF;
        IF mask & 4 = 4 THEN reasons := reasons || 'type-change '; END IF;
        IF mask & 8 = 8 THEN reasons := reasons || 'access-method-change '; END IF;

        INSERT INTO public.rewrite_alerts (table_oid, table_name, reason_mask, reason_text)
        VALUES (oid_value, oid_value::regclass::text, mask, trim(reasons));
    END;
    $$;

    CREATE EVENT TRIGGER warn_on_rewrite
        ON table_rewrite
        EXECUTE FUNCTION warn_on_rewrite();

Pair with an `INSERT` trigger on `rewrite_alerts` that issues `NOTIFY` (see [45-listen-notify.md](./45-listen-notify.md)) to wake a watchdog, or with a pg_cron job (see [98-pg-cron.md](./98-pg-cron.md)) that pages on every row. The "this table is about to be rewritten" signal is the canonical moment to alert before a multi-hour migration locks the table.

### Recipe 5: PG17 login event — connection audit

> [!NOTE] PostgreSQL 17

    CREATE TABLE login_audit (
        id           bigserial PRIMARY KEY,
        occurred_at  timestamptz NOT NULL DEFAULT now(),
        session_user_name text NOT NULL,
        current_user_name text NOT NULL,
        application_name text,
        client_addr  inet,
        is_replica   boolean
    );

    CREATE OR REPLACE FUNCTION audit_login()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog AS $$
    BEGIN
        -- CRITICAL: read-only on standby
        IF pg_is_in_recovery() THEN
            RETURN;
        END IF;

        INSERT INTO public.login_audit (
            session_user_name, current_user_name, application_name, client_addr, is_replica
        )
        SELECT session_user, current_user,
               current_setting('application_name', true),
               (SELECT client_addr FROM pg_stat_activity WHERE pid = pg_backend_pid()),
               false;
    EXCEPTION
        WHEN OTHERS THEN
            -- NEVER let an audit failure block the login
            RETURN;
    END;
    $$;

    CREATE EVENT TRIGGER audit_login
        ON login
        EXECUTE FUNCTION audit_login();

Three defensive patterns in one recipe:

1. **`pg_is_in_recovery()` guard** prevents the trigger from attempting a write on a standby.
2. **`EXCEPTION WHEN OTHERS`** prevents any unexpected failure from blocking every login (this is the single most important pattern for any `login` event trigger).
3. **Pinned `search_path`** prevents schema-search-based privilege escalation.

### Recipe 6: PG17 login event — per-session GUC setup

> [!NOTE] PostgreSQL 17
> A common use case for login event triggers is forcing session-level GUC defaults that connection strings or `~/.psqlrc` can't reach (e.g., tool-launched sessions).

    CREATE OR REPLACE FUNCTION login_set_session_defaults()
    RETURNS event_trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF pg_is_in_recovery() THEN
            RETURN;
        END IF;

        -- Force statement timeout for non-superuser sessions
        IF current_user <> 'postgres' THEN
            PERFORM set_config('statement_timeout', '30s', false);
            PERFORM set_config('idle_in_transaction_session_timeout', '60s', false);
        END IF;

    EXCEPTION
        WHEN OTHERS THEN RETURN;
    END;
    $$;

    CREATE EVENT TRIGGER login_set_session_defaults
        ON login
        EXECUTE FUNCTION login_set_session_defaults();

The `set_config(name, value, is_local)` call with `is_local = false` sets the value for the rest of the session. Equivalent to `SET name = value;`. For per-database defaults, prefer `ALTER DATABASE ... SET ...` — it's simpler. The login event is the right tool when defaults depend on the *role*, the *client_addr*, or the *application_name*.

### Recipe 7: Emergency disable a buggy event trigger (PG17+)

A buggy event trigger may block every DDL — including the `DROP EVENT TRIGGER` you'd issue to clean it up. PG17+ gives you a per-session escape hatch:

    -- As a superuser, on PG17+:
    SET event_triggers = off;
    DROP EVENT TRIGGER bad_trigger;
    -- or
    ALTER EVENT TRIGGER bad_trigger DISABLE;

Or via the connection string for cases where the trigger is preventing connection itself (e.g., a buggy `login` trigger):

    psql "host=primary dbname=mydb user=postgres options='-c event_triggers=off'"

### Recipe 8: Emergency disable on PG≤16 — single-user mode

Pre-PG17 the only escape from a runaway event trigger is single-user mode. Verbatim from `CREATE EVENT TRIGGER`: *"If an erroneous event trigger disables the database so much that you can't even drop the trigger, restart in single-user mode and you'll be able to do that."*[^create-et]

The runbook (cluster downtime required):

    # 1. Stop the cluster cleanly
    sudo systemctl stop postgresql

    # 2. Start in single-user mode against the affected database
    sudo -u postgres /usr/lib/postgresql/16/bin/postgres --single \
        -D /var/lib/postgresql/16/main mydb

    # 3. Disable or drop the bad trigger
    backend> ALTER EVENT TRIGGER bad_trigger DISABLE;
    backend> \q

    # 4. Restart normally
    sudo systemctl start postgresql

This is a brief-downtime operation but it does require stopping the postmaster — there is no other PG≤16 path that bypasses the trigger from a live session.

### Recipe 9: Inventory all event triggers via pg_event_trigger

The catalog `pg_event_trigger` holds one row per event trigger.

    SELECT
        evtname        AS trigger_name,
        evtevent       AS event,
        evtenabled     AS enable_state, -- 'O' enabled, 'D' disabled, 'R' replica, 'A' always
        evttags        AS filter_tags,
        p.proname      AS function_name,
        r.rolname      AS owner
    FROM pg_event_trigger et
    JOIN pg_proc p ON p.oid = et.evtfoid
    JOIN pg_roles r ON r.oid = et.evtowner
    ORDER BY evtevent, evtname;

The `evtenabled` column is a one-character code:

| Code | Meaning                       |
| ---- | ----------------------------- |
| `O`  | enabled (default, origin)      |
| `D`  | disabled                       |
| `R`  | enabled on replica role only   |
| `A`  | always enabled (origin + replica) |

Same four-state surface as DML triggers (see [39-triggers.md](./39-triggers.md)).

### Recipe 10: Replicate DDL to a secondary cluster

The most operationally complex use case. Logical replication has no native DDL replication; the workaround is to capture `ddl_command_end` events into a queue table and replay them on the secondary.

    -- On the primary, in the database being replicated
    CREATE TABLE ddl_replication_queue (
        id          bigserial PRIMARY KEY,
        captured_at timestamptz NOT NULL DEFAULT now(),
        command_tag text NOT NULL,
        object_identity text,
        ddl_command text  -- NOTE: the docs do not provide a reliable way to reconstruct full DDL text;
                          -- this column is populated by the application, not by the trigger
    );

    CREATE OR REPLACE FUNCTION queue_ddl_for_replication()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog AS $$
    DECLARE
        r record;
    BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE NOT r.in_extension LOOP
            INSERT INTO public.ddl_replication_queue (command_tag, object_identity)
            VALUES (r.command_tag, r.object_identity);
        END LOOP;
    END;
    $$;

    CREATE EVENT TRIGGER queue_ddl
        ON ddl_command_end
        EXECUTE FUNCTION queue_ddl_for_replication();

> [!WARNING] Reconstructing DDL text is hard
> Postgres exposes no canonical "give me the SQL text of this DDL" function. The `pg_ddl_command` opaque type can't be cast back to text. You can reconstruct partial information from `command_tag` + `object_identity` (e.g., `DROP TABLE foo.bar;`) but you cannot reconstruct `CREATE INDEX CONCURRENTLY ... ON ... WHERE ...` from event-trigger data alone. The production answer is to capture the SQL text at the application layer (migration framework) and use the event trigger only as a verifier that nothing else slipped through.

### Recipe 11: Audit all REINDEX operations (PG17+)

> [!NOTE] PostgreSQL 17
> `REINDEX` was added to the firing matrix in PG17. Pre-PG17 there is no event-trigger surface for REINDEX.

    CREATE OR REPLACE FUNCTION audit_reindex()
    RETURNS event_trigger
    LANGUAGE plpgsql AS $$
    DECLARE
        r record;
    BEGIN
        IF TG_TAG <> 'REINDEX' THEN RETURN; END IF;
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
            RAISE NOTICE 'REINDEX on %', r.object_identity;
        END LOOP;
    END;
    $$;

    CREATE EVENT TRIGGER audit_reindex
        ON ddl_command_end
        WHEN TAG IN ('REINDEX')
        EXECUTE FUNCTION audit_reindex();

Use case: maintenance-window verification. If you run nightly REINDEX CONCURRENTLY via pg_cron (see [26-index-maintenance.md](./26-index-maintenance.md) Recipe 9 and [98-pg-cron.md](./98-pg-cron.md)), this trigger lets you confirm in audit logs that the job ran and on which indexes.

### Recipe 12: Schema-drift detection via DDL audit + scheduled diff

Combine Recipe 1 (DDL audit) with a scheduled diff to catch unexpected schema changes.

    -- Run on a schedule (pg_cron) against the audit table:
    SELECT
        date_trunc('hour', occurred_at) AS window,
        command_tag,
        object_type,
        count(*) AS n,
        array_agg(DISTINCT session_user_name) AS users,
        array_agg(DISTINCT object_identity ORDER BY object_identity) AS objects
    FROM ddl_audit_log
    WHERE occurred_at > now() - interval '24 hours'
      AND object_type NOT IN ('extension')
      AND in_extension = false
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, n DESC;

The `NOT in_extension` filter excludes DDL from extension installs (which are expected) — only "raw" DDL appears. Alert on DDL outside the maintenance window or by unexpected roles.

### Recipe 13: Cause an event trigger to fire on a standby's apply path

By default event triggers fire only on origin sessions (the primary). To fire them when logical-replication applies DDL to a subscriber, use `ENABLE REPLICA` or `ENABLE ALWAYS`:

    -- Fire ONLY during replication apply (skip primary sessions)
    ALTER EVENT TRIGGER audit_ddl ENABLE REPLICA;

    -- Fire on both primary sessions AND replication apply
    ALTER EVENT TRIGGER audit_ddl ENABLE ALWAYS;

This is the same `session_replication_role` interaction as DML triggers. Note: logical replication doesn't replicate DDL natively — so this only matters if you've built a DDL-replication pipeline (Recipe 10) or are using an out-of-tree tool that emits DDL through replication.

## Gotchas and Anti-patterns

1. **Event triggers do not fire on shared (cluster-wide) objects.** `CREATE DATABASE`, `DROP DATABASE`, `CREATE ROLE`, `DROP ROLE`, `CREATE TABLESPACE`, `DROP TABLESPACE` and similar all bypass event triggers. There is no workaround at the event-trigger level — audit at log level instead (see [51-pgaudit.md](./51-pgaudit.md)).

2. **`ddl_command_end` fires before commit.** Raising an exception still rolls back the transaction. Don't write to a critical audit log expecting "the DDL is already done" — both the DDL and the audit row vanish if any later statement in the transaction errors.

3. **`pg_event_trigger_ddl_commands()` is event-restricted.** Calling it outside `ddl_command_end` raises an error. Same for the other three support functions.

4. **`pg_event_trigger_dropped_objects()` shows objects already gone from catalogs.** By the time `sql_drop` fires, catalog rows are deleted. Don't try to look up the OID in `pg_class` — it won't be there.

5. **`pg_event_trigger_table_rewrite_reason()` is a bitmap, not an enum.** A single rewrite can have multiple reasons. Mask the bits: `& 1` for persistence, `& 2` for default, `& 4` for type, `& 8` for access method.

6. **Function must `RETURNS event_trigger`.** Returning `trigger` or `record` produces `ERROR: function must return type event_trigger`.

7. **`WHEN filter_variable` only supports `TAG`.** Verbatim docs: *"Currently the only supported filter_variable is TAG."*[^create-et] There's no `WHEN ROLE IN (...)` or `WHEN OBJECT_TYPE IN (...)` — filter inside the function body instead.

8. **`PROCEDURE` keyword in grammar is deprecated but legal.** Verbatim: *"The use of the keyword `PROCEDURE` here is historical and deprecated."*[^create-et] Always write `EXECUTE FUNCTION`.

9. **Login event triggers must avoid writes on standbys.** Verbatim: *"To prevent servers from becoming inaccessible, such triggers must avoid writing anything to the database when running on a standby."*[^pg17-login] Add `IF pg_is_in_recovery() THEN RETURN; END IF;` at the top of every `login` trigger.

10. **Login event triggers cannot be cancelled by Ctrl-C.** Verbatim: *"Canceling a connection in psql will not cancel the in-progress `login` trigger."*[^pg17-login] A long-running `login` trigger blocks the connection for its full duration.

11. **A bug in a `login` event trigger can lock everyone out.** Use `psql "... options='-c event_triggers=off'"` (PG17+) or single-user mode (any version) to recover.

12. **PG14 / PG15 / PG16 / PG18 had near-zero event-trigger changes.** Only PG15 has a single minor `pg_event_trigger_ddl_commands()` temp-schema fix and PG17 has the three major additions (login, REINDEX support, `event_triggers` GUC). Don't search PG18 release notes expecting more event-trigger features — there are none.

13. **`SELECT INTO` is treated as `CREATE TABLE AS` for event triggers.** Both fire `ddl_command_start` and `ddl_command_end` with `TG_TAG = 'SELECT INTO'`. If you want to capture `CREATE TABLE`-style operations exhaustively, your filter must include `'SELECT INTO'`.

14. **Event triggers do not fire on event trigger DDL.** `CREATE EVENT TRIGGER` and `DROP EVENT TRIGGER` are not part of the firing matrix. You cannot use event triggers to audit themselves — there is no recursive case to worry about.

15. **`ALTER EVENT TRIGGER ... OWNER TO non_superuser` is legal.** A non-superuser owner can `DROP` the trigger (per the verbatim docs rule that drop requires only the owner) but cannot `CREATE` new ones. Use this asymmetry to delegate cleanup rights without granting superuser.

16. **`event_triggers = off` is per-session.** Setting it in `postgresql.conf` requires reload + applies to new sessions. Use `SET event_triggers = off` for the current session, or pass via `options='-c event_triggers=off'` in the connection string for the connection-time case.

17. **`event_triggers` GUC is PG17+ only.** Pre-PG17 `SET event_triggers = ...` raises *unrecognized configuration parameter*. The only pre-PG17 escape is single-user mode.

18. **Disabled event triggers consume catalog space but no execution time.** A `DISABLE`d trigger is skipped at firing decision; no function call happens. Use `DISABLE` rather than `DROP` for triggers you may re-enable.

19. **`DROP EVENT TRIGGER` does not CASCADE through dependencies you'd expect.** It only CASCADEs through pg_depend records, which for event triggers means almost nothing — the function the trigger calls is **not** dropped automatically. Keep the function and the trigger in the same migration.

20. **`pg_ddl_command` (the column type returned by `pg_event_trigger_ddl_commands().command`) is opaque.** You cannot cast it to text or otherwise inspect it from SQL. C-language consumers can decode it; SQL consumers must use the other columns (`command_tag`, `object_identity`, `object_type`).

21. **DDL run as part of an extension install fires event triggers with `in_extension = true`.** Filter on `WHERE NOT in_extension` if you want to exclude extension scaffolding from your audit.

22. **Triggers do not fire on aborted transactions.** If an earlier statement in the transaction errored, the cleanup DDL (if any) runs without firing event triggers because the transaction is already in failed state.

23. **`session_replication_role = replica` makes `ENABLE`-default triggers silently skip.** This is the same trap as DML triggers (see [39-triggers.md](./39-triggers.md) gotcha #9). Use `ENABLE ALWAYS` if you need a trigger to fire regardless of `session_replication_role`.

## See Also

- [01-syntax-ddl.md](./01-syntax-ddl.md) — the DDL surface that event triggers fire on
- [06-functions.md](./06-functions.md) — `SECURITY DEFINER` + `SET search_path` pattern reused above
- [08-plpgsql.md](./08-plpgsql.md) — PL/pgSQL body, `EXCEPTION WHEN`, `RAISE EXCEPTION`
- [39-triggers.md](./39-triggers.md) — DML triggers (the per-row mechanism, not this one)
- [45-listen-notify.md](./45-listen-notify.md) — pairing event triggers with `NOTIFY` for real-time alerting
- [46-roles-privileges.md](./46-roles-privileges.md) — superuser requirement, `pg_event_trigger` ownership
- [51-pgaudit.md](./51-pgaudit.md) — production-quality compliance audit (better than event triggers for most audit use cases)
- [53-server-configuration.md](./53-server-configuration.md) — the `event_triggers` GUC (PG17+) and connection-string `options=` mechanics
- [64-system-catalogs.md](./64-system-catalogs.md) — `pg_event_trigger` catalog, `evtenabled` enumeration
- [43-locking.md](./43-locking.md) — `CREATE EVENT TRIGGER` takes ShareRowExclusive; DDL events themselves take various lock levels listed in the conflict matrix.
- [73-streaming-replication.md](./73-streaming-replication.md) — `session_replication_role` and the REPLICA/ALWAYS firing modes
- [74-logical-replication.md](./74-logical-replication.md) — the DDL-replication gap that motivates Recipe 10

## Sources

[^et-overview]: Event Triggers — Overview of Event Trigger Behavior. PostgreSQL 16 documentation. *"Unlike regular triggers, which are attached to a single table and capture only DML events, event triggers are global to a particular database and are capable of capturing DDL events."* + *"In order to create an event trigger, you must first create a function with the special return type `event_trigger`. This function need not (and may not) return a value; the return type serves merely as a signal that the function is to be invoked as an event trigger."* + *"If more than one event trigger is defined for a particular event, they will fire in alphabetical order by trigger name."* — https://www.postgresql.org/docs/16/event-trigger-definition.html

[^et-matrix]: Event Triggers — Event Trigger Firing Matrix. PostgreSQL 16 documentation. *"Table 40.1 lists all commands for which event triggers are supported."* Full matrix at the source URL. — https://www.postgresql.org/docs/16/event-trigger-matrix.html

[^et-c-interface]: Event Triggers — Writing Event Trigger Functions in C. PostgreSQL 16 documentation. *"The function must not alter the EventTriggerData structure or any of the data it points to."* — https://www.postgresql.org/docs/16/event-trigger-interface.html

[^create-et]: CREATE EVENT TRIGGER. PostgreSQL 16 documentation. *"Currently the only supported filter_variable is TAG."* + *"In the syntax of CREATE EVENT TRIGGER, the keywords FUNCTION and PROCEDURE are equivalent, but the referenced function must in any case be a function, not a procedure. The use of the keyword PROCEDURE here is historical and deprecated."* + *"Only superusers can create event triggers."* + *"Event triggers are disabled in single-user mode (see postgres). If an erroneous event trigger disables the database so much that you can't even drop the trigger, restart in single-user mode and you'll be able to do that."* — https://www.postgresql.org/docs/16/sql-createeventtrigger.html

[^alter-et]: ALTER EVENT TRIGGER. PostgreSQL 16 documentation. *"You must be superuser to alter an event trigger."* — https://www.postgresql.org/docs/16/sql-altereventtrigger.html

[^drop-et]: DROP EVENT TRIGGER. PostgreSQL 16 documentation. *"To execute this command, the current user must be the owner of the event trigger."* — https://www.postgresql.org/docs/16/sql-dropeventtrigger.html

[^functions-et]: System Information Functions and Operators — Event Trigger Functions. PostgreSQL 16 documentation. Documents `pg_event_trigger_ddl_commands()`, `pg_event_trigger_dropped_objects()`, `pg_event_trigger_table_rewrite_oid()`, and `pg_event_trigger_table_rewrite_reason()` including the bitmap (1=persistence, 2=default, 4=type, 8=access method). — https://www.postgresql.org/docs/16/functions-event-triggers.html

[^pg14-rn]: PostgreSQL 14 Release Notes. Verified by direct fetch: zero release-note items mention event triggers. — https://www.postgresql.org/docs/release/14.0/

[^pg15-tempschema]: PostgreSQL 15 Release Notes. *"Change `pg_event_trigger_ddl_commands()` to output references to other sessions' temporary schemas using the actual schema name (Tom Lane). Previously this function reported all temporary schemas as `pg_temp`, but it's misleading to use that for any but the current session's temporary schema."* — https://www.postgresql.org/docs/release/15.0/

[^pg16-rn]: PostgreSQL 16 Release Notes. Verified by direct fetch: zero release-note items mention event triggers. — https://www.postgresql.org/docs/release/16.0/

[^pg17-login-rn]: PostgreSQL 17 Release Notes. *"Add support for event triggers that fire at connection time (Konstantin Knizhnik, Mikhail Gribkov)."* — https://www.postgresql.org/docs/release/17.0/

[^pg17-reindex-rn]: PostgreSQL 17 Release Notes. *"Add event trigger support for REINDEX (Garrett Thornburg, Jian He)."* — https://www.postgresql.org/docs/release/17.0/

[^pg17-guc-rn]: PostgreSQL 17 Release Notes. *"Add server variable to disable event triggers (Daniel Gustafsson). The setting, `event_triggers`, allows for the temporary disabling of event triggers for debugging."* — https://www.postgresql.org/docs/release/17.0/

[^pg17-login]: Event Triggers — Overview of Event Trigger Behavior, PostgreSQL 17 documentation. *"Currently, the only supported events are `login`, `ddl_command_start`, `ddl_command_end`, `table_rewrite` and `sql_drop`."* + *"The `login` event occurs when an authenticated user logs into the system. Any bug in a trigger procedure for this event may prevent successful login to the system. Such bugs may be worked around by setting event_triggers to `false` either in a connection string or configuration file. Alternatively, you can restart the system in single-user mode (as event triggers are disabled in this mode). ... The `login` event will also fire on standby servers. To prevent servers from becoming inaccessible, such triggers must avoid writing anything to the database when running on a standby. Also, it's recommended to avoid long-running queries in `login` event triggers. Note that, for instance, canceling a connection in psql will not cancel the in-progress `login` trigger."* — https://www.postgresql.org/docs/17/event-trigger-definition.html

[^pg17-guc]: Server Configuration — `event_triggers` GUC. PostgreSQL 17 documentation. *"event_triggers (boolean) — Allow temporarily disabling execution of event triggers in order to troubleshoot and repair faulty event triggers. All event triggers will be disabled by setting it to false. Setting the value to true allows all event triggers to fire, this is the default value. Only superusers and users with the appropriate SET privilege can change this setting."* — https://www.postgresql.org/docs/17/runtime-config-client.html

[^pg18-rn]: PostgreSQL 18 Release Notes. Verified by direct fetch: zero release-note items mention event triggers. — https://www.postgresql.org/docs/release/18.0/

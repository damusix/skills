# 39 — Triggers


PostgreSQL triggers reference: `CREATE TRIGGER` grammar including `OR REPLACE` (PG14+), the timing/event/level matrix (`BEFORE`/`AFTER`/`INSTEAD OF` × `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` × `FOR EACH ROW`/`FOR EACH STATEMENT`), `NEW` and `OLD` records, the full `TG_*` special-variable catalog, transition tables via `REFERENCING { OLD | NEW } TABLE AS` (statement-level only), constraint triggers with `DEFERRABLE INITIALLY DEFERRED`, trigger firing order (alphabetical by name), data-change visibility rules within trigger functions, `ALTER TABLE ... DISABLE/ENABLE/ENABLE REPLICA/ENABLE ALWAYS TRIGGER` and the `session_replication_role` interaction, `ALTER TRIGGER ... RENAME` partition-recursion (PG15+), TRUNCATE triggers on foreign tables (PG16+), and the PG18 silent semantic change that `AFTER` triggers now execute as the role active at queue time. For `INSTEAD OF` triggers on views, cross-reference [`05-views.md`](./05-views.md); for the RI-trigger mechanism that backs FK enforcement, cross-reference [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md); for PL/pgSQL trigger function bodies, cross-reference [`08-plpgsql.md`](./08-plpgsql.md).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)

- [Mental Model](#mental-model)

- [Decision Matrix](#decision-matrix)

- [Mechanics](#mechanics)

    - [CREATE TRIGGER grammar](#create-trigger-grammar)

    - [Timing × event × level matrix](#timing--event--level-matrix)

    - [Firing order](#firing-order)

    - [BEFORE row trigger return values](#before-row-trigger-return-values)

    - [AFTER and statement-level return values](#after-and-statement-level-return-values)

    - [INSTEAD OF trigger return values](#instead-of-trigger-return-values)

    - [TG_* special variables](#tg_-special-variables)

    - [NEW and OLD records](#new-and-old-records)

    - [Transition tables](#transition-tables)

    - [WHEN clause](#when-clause)

    - [Constraint triggers](#constraint-triggers)

    - [Visibility of data changes](#visibility-of-data-changes)

    - [Trigger and RI-trigger interaction](#trigger-and-ri-trigger-interaction)

    - [Triggers on partitioned tables](#triggers-on-partitioned-tables)

    - [DISABLE / ENABLE TRIGGER](#disable--enable-trigger)

    - [session_replication_role](#session_replication_role)

    - [ALTER TRIGGER](#alter-trigger)

    - [DROP TRIGGER](#drop-trigger)

- [Per-Version Timeline](#per-version-timeline)

- [Examples / Recipes](#examples--recipes)

- [Gotchas / Anti-patterns](#gotchas--anti-patterns)

- [See Also](#see-also)

- [Sources](#sources)


---


## When to Use This Reference


Use this file when you need to:

- Write a trigger and pick the right `BEFORE`/`AFTER`/`INSTEAD OF` × `FOR EACH ROW`/`FOR EACH STATEMENT` combination.

- Audit existing triggers — find user triggers vs internal RI triggers, list per-table, inspect catalog metadata.

- Diagnose unexpected DML behavior caused by triggers (skipped rows, modified values, recursion, ordering, visibility surprises).

- Migrate a row-by-row audit trigger pattern to a statement-level trigger using *transition tables*.

- Implement deferred consistency checks via `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` and `SET CONSTRAINTS`.

- Decide between `DISABLE TRIGGER` (silent skip) vs `ENABLE REPLICA TRIGGER` vs `ENABLE ALWAYS TRIGGER` for logical-replication apply scenarios.

- Plan a PG18 upgrade where AFTER-trigger role-binding changed (now queue-time, not execution-time).

For the wider DDL surface (`CREATE TABLE`, generated columns, partitioning), see [`01-syntax-ddl.md`](./01-syntax-ddl.md). For the trigger function body itself (PL/pgSQL control flow, `RAISE`, exception blocks), see [`08-plpgsql.md`](./08-plpgsql.md). For event triggers (DDL-level), see [`40-event-triggers.md`](./40-event-triggers.md). For FK enforcement triggers (`tgisinternal = true`), see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).


---


## Mental Model


Five rules drive everything else:


1. **Triggers are catalog-stored functions that fire on table-level events.** A trigger is a pairing in `pg_trigger` between an event (INSERT/UPDATE/DELETE/TRUNCATE on a table) and a function that gets called when that event happens. The function can be written in any procedural language (PL/pgSQL by default, but also PL/Tcl, PL/Perl, PL/Python, or C)[^triggers-intro].

2. **`BEFORE ROW` triggers can modify or skip the row; `AFTER ROW` triggers cannot.** The verbatim docs rule[^before-skip]:

    > "It can return `NULL` to skip the operation for the current row. This instructs the executor to not perform the row-level operation that invoked the trigger (the insertion, modification, or deletion of a particular table row)."

    AFTER triggers' return value is ignored entirely[^after-ignored]:

    > "The return value of a row-level trigger fired AFTER or a statement-level trigger fired BEFORE or AFTER is always ignored; it might as well be null."

3. **Row-level and statement-level triggers have radically different semantics.** A row-level trigger fires *once per affected row*; a statement-level trigger fires *once per SQL statement, even when zero rows are affected*[^per-row-vs-statement]:

    > "In particular, a statement that affects zero rows will still result in the execution of any applicable per-statement triggers."

    The two are not interchangeable — pick row-level only when you need per-row context (`NEW`/`OLD`); pick statement-level when you need a global view of all changed rows. Transition tables (rule 4) bridge the gap.

4. **Transition tables (PG10+) give STATEMENT triggers access to all changed rows.** Declared via `REFERENCING { OLD | NEW } TABLE AS name`, they materialize the before-image / after-image sets and let you write a single set-based query instead of running the trigger body N times. **STATEMENT-level only on plain tables; not allowed on partitions or inheritance children, not on foreign tables, not on constraint triggers, and `UPDATE` triggers using them cannot specify a `column_name` list**[^trans-tables-restrict].

5. **User triggers fire AFTER internal RI triggers.** Foreign-key enforcement happens via internal triggers with `tgisinternal = true` and names like `RI_ConstraintTrigger_a_*` / `RI_ConstraintTrigger_c_*` (see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md)). User-level `AFTER` triggers see the world *after* FK constraints have already been checked. The verbatim docs ordering is **alphabetical by trigger name within the same timing/event**[^firing-order]:

    > "If more than one trigger is defined for the same event on the same relation, the triggers will be fired in alphabetical order by trigger name."


> [!WARNING] PG18 silent semantic change
> Starting with PostgreSQL 18, `AFTER` triggers execute as the role that was **active when the trigger event was queued**, not the role active at the time of execution (which previously was effectively the role at `COMMIT` time for deferred triggers)[^pg18-role]. The verbatim release-note quote:
>
> > "Execute AFTER triggers as the role that was active when trigger events were queued (Laurenz Albe). Previously such triggers were run as the role that was active at trigger execution time (e.g., at COMMIT). This is significant for cases where the role is changed between queue time and transaction commit."
>
> If you have code that does `SET ROLE` after an INSERT/UPDATE/DELETE and *expects* the deferred trigger to run as the new role (e.g., for audit logging), this changes on PG18. Audit your code paths before upgrading.


---


## Decision Matrix


| You want to ... | Trigger choice | Avoid | Why |
|---|---|---|---|
| Modify or validate a row before it's written | `BEFORE ROW INSERT OR UPDATE` returning `NEW` (or modified `NEW`, or `NULL`) | AFTER trigger that issues a corrective UPDATE | BEFORE row can substitute the value at no extra cost; AFTER round-trips through DML again |
| Audit-log every changed row | `AFTER STATEMENT INSERT OR UPDATE OR DELETE` with `REFERENCING NEW TABLE AS n, OLD TABLE AS o` plus a single `INSERT INTO audit_log SELECT ... FROM n` | AFTER ROW logging one INSERT per affected row | Transition-table set-based logging is dramatically faster on bulk DML; cross-ref [Recipe 4](#examples--recipes) |
| Reject DML that violates a complex (cross-row or cross-table) rule | `BEFORE ROW` with `RAISE EXCEPTION` | CHECK constraint (cannot reference other rows or tables) | Triggers can run SQL queries; CHECK constraints cannot, see [`37-constraints.md`](./37-constraints.md) gotcha #12 |
| Make a view writable | `INSTEAD OF ROW INSERT OR UPDATE OR DELETE` on the view | Updatable view auto-rewrite (works only for simple views) | INSTEAD OF triggers are the canonical way to make a view writable, cross-ref [`05-views.md`](./05-views.md) |
| Defer a check until COMMIT (e.g., cross-row uniqueness during a multi-step swap) | `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` | regular trigger | Only `CONSTRAINT TRIGGER` can be deferred; the deferral is `SET CONSTRAINTS`-controlled |
| Fire only when a specific column changes | `AFTER UPDATE OF col1, col2 ... FOR EACH ROW` plus optional `WHEN (OLD.col1 IS DISTINCT FROM NEW.col1)` | Trigger body that early-returns if `NEW.col = OLD.col` | The `UPDATE OF` clause skips the trigger entirely when the named columns are not in the UPDATE target list; `WHEN` clause skips when the values are equal |
| Fire on TRUNCATE | `BEFORE STATEMENT TRUNCATE` or `AFTER STATEMENT TRUNCATE` | row-level TRUNCATE trigger (illegal) | TRUNCATE has no per-row events to fire |
| Replicate-apply behavior selectively | `ENABLE REPLICA TRIGGER` for triggers that should fire only during logical replication apply; `ENABLE ALWAYS TRIGGER` for triggers that should fire in both modes | leaving everything as default | Default triggers do NOT fire when `session_replication_role = 'replica'` — common surprise during pglogical / native logical replication tests |
| Skip a row in BEFORE without dropping the statement | `RETURN NULL` from the trigger function | `RAISE EXCEPTION` (aborts the entire statement) | NULL silently skips just this row; exception rolls back the whole DML |
| Capture stats / row counts for the just-completed statement | `AFTER STATEMENT` reading from `REFERENCING NEW TABLE` / `OLD TABLE` | counting in row-level triggers | Statement-level + transition tables = one SQL query against the affected rows; cross-ref [Recipe 4](#examples--recipes) |
| Conditionally fire only when a value is `IS DISTINCT FROM` previous | `WHEN (OLD.col IS DISTINCT FROM NEW.col)` | trigger body with early `RETURN` | `WHEN` clause is evaluated by the executor; the trigger function never even runs |


Three smell signals that you have the wrong trigger shape:

- **Row-level trigger doing a `LOOP` or large query on every fire.** Move to a statement-level trigger with transition tables; the per-row overhead of trigger invocation will dominate.

- **Multiple triggers on the same table with names like `01_trigger_a` / `02_trigger_b`.** This is an indicator that the developer is trying to control firing order via naming — which works (alphabetical by name within the same timing/event) but is brittle. Document the ordering constraint with comments on `pg_trigger`.

- **Trigger that does `EXECUTE 'INSERT INTO ' || quote_ident(TG_TABLE_NAME) || ...';`** — building dynamic SQL inside a trigger usually means the trigger is being attached to many tables when it should be on a parent table with logic that branches on `TG_TABLE_NAME`. See [Recipe 9](#examples--recipes).


---


## Mechanics


### CREATE TRIGGER grammar


The full grammar (identical from PG14 through PG18[^create-trigger-grammar]):


    CREATE [ OR REPLACE ] [ CONSTRAINT ] TRIGGER name { BEFORE | AFTER | INSTEAD OF } { event [ OR ... ] }
        ON table_name
        [ FROM referenced_table_name ]
        [ NOT DEFERRABLE | [ DEFERRABLE ] [ INITIALLY IMMEDIATE | INITIALLY DEFERRED ] ]
        [ REFERENCING { { OLD | NEW } TABLE [ AS ] transition_relation_name } [ ... ] ]
        [ FOR [ EACH ] { ROW | STATEMENT } ]
        [ WHEN ( condition ) ]
        EXECUTE { FUNCTION | PROCEDURE } function_name ( arguments )

    where event can be one of:

        INSERT
        UPDATE [ OF column_name [, ... ] ]
        DELETE
        TRUNCATE


Eight orthogonal options:

1. `OR REPLACE` (PG14+[^pg14-or-replace]) — replace an existing trigger atomically. Verbatim release note: *"Add OR REPLACE option for CREATE TRIGGER (Takamichi Osumi). This allows pre-existing triggers to be conditionally replaced."*

2. `CONSTRAINT` — make this a constraint trigger (deferrable, never fired on TRUNCATE, AFTER ROW only).

3. Timing (`BEFORE` / `AFTER` / `INSTEAD OF`) — when the function runs relative to the operation.

4. `event` list — `INSERT`, `UPDATE` (optionally narrowed by `UPDATE OF col1, col2`), `DELETE`, `TRUNCATE`. Multiple events can be `OR`-combined.

5. `FROM referenced_table_name` — for constraint triggers only; declares the referenced table for FK-style constraint enforcement.

6. `DEFERRABLE` / `INITIALLY IMMEDIATE` / `INITIALLY DEFERRED` — for constraint triggers; same `SET CONSTRAINTS` mechanism as deferrable FKs.

7. `REFERENCING ... TABLE AS name` — transition tables (statement-level AFTER triggers only on plain tables).

8. `WHEN (condition)` — boolean filter; the trigger function is not even invoked when the condition is false. Cannot reference subqueries.

9. `FOR EACH ROW` / `FOR EACH STATEMENT` — default is `FOR EACH STATEMENT`[^for-each-default].

10. `EXECUTE FUNCTION` (preferred since PG11) or `EXECUTE PROCEDURE` (legacy synonym, still accepted).


> [!NOTE] PostgreSQL 14
> `OR REPLACE` was added in PG14. Before PG14, the only way to redefine a trigger was `DROP TRIGGER ... ; CREATE TRIGGER ...` which left a brief window where the trigger did not exist.


### Timing × event × level matrix


The legal combinations (verbatim from `sql-createtrigger.html`)[^matrix]:


| When | Event | Row-level | Statement-level |
|---|---|---|---|
| `BEFORE` | `INSERT` / `UPDATE` / `DELETE` | Tables and foreign tables | Tables, views, and foreign tables |
| `BEFORE` | `TRUNCATE` | *(illegal)* | Tables and foreign tables (PG16+) |
| `AFTER` | `INSERT` / `UPDATE` / `DELETE` | Tables and foreign tables | Tables, views, and foreign tables |
| `AFTER` | `TRUNCATE` | *(illegal)* | Tables and foreign tables (PG16+) |
| `INSTEAD OF` | `INSERT` / `UPDATE` / `DELETE` | Views | *(illegal)* |
| `INSTEAD OF` | `TRUNCATE` | *(illegal)* | *(illegal)* |


Three rules from the matrix:

- **`INSTEAD OF` is always `FOR EACH ROW`, always on views.** Verbatim: *"Triggers that are specified to fire INSTEAD OF the trigger event must be marked FOR EACH ROW, and can only be defined on views."*

- **TRUNCATE triggers are always statement-level.** Verbatim: *"Triggers on TRUNCATE may only be defined at statement level, not per-row."* As of PG16, they can also be defined on foreign tables[^pg16-truncate-fdw].

- **Views accept BEFORE/AFTER statement-level triggers** (since PG11 added this as a PostgreSQL extension to the SQL standard).


> [!NOTE] PostgreSQL 16
> `TRUNCATE` triggers on foreign tables — verbatim: *"Allow truncate triggers on foreign tables (Yugo Nagata)."* This closes a gap where you could `TRUNCATE` a foreign table but not observe it via triggers.


### Firing order


Multiple triggers on the same table, timing, and event fire in **alphabetical order by trigger name**[^firing-order]. This is PostgreSQL-specific — the SQL standard specifies time-of-creation order, but PostgreSQL judged name-order more convenient[^compat-name-order]:

> "SQL specifies that multiple triggers should be fired in time-of-creation order. PostgreSQL uses name order, which was judged to be more convenient."


The order matters because of cumulative effects: trigger A's modifications to `NEW` are visible to trigger B running later in the same firing cycle. The naming convention `01_validate_email`, `02_normalize_email`, `99_audit_log` (sortable prefix) is the common pattern.


For `BEFORE` triggers, the sequence is:

1. Resolve `WHEN` clause; skip if false.
2. Call the trigger function with the current `NEW` (or `OLD`).
3. If function returns `NULL`, **the whole DML operation for this row is skipped** — subsequent BEFORE triggers do NOT fire, and the INSERT/UPDATE/DELETE itself does NOT happen.
4. Otherwise, the returned row becomes the new `NEW` for the next BEFORE trigger.

For `AFTER` triggers, all queued trigger events fire at end-of-statement (or end-of-transaction for deferrable constraint triggers), in alphabetical order; their return values are ignored entirely.


### BEFORE row trigger return values


The verbatim PL/pgSQL rule[^plpgsql-before-return]:

> "Row-level triggers fired BEFORE can return null to signal the trigger manager to skip the rest of the operation for this row (i.e., subsequent triggers are not fired, and the INSERT/UPDATE/DELETE does not occur for this row). If a nonnull value is returned then the operation proceeds with that row value. Returning a row value different from the original value of NEW alters the row that will be inserted or updated. Thus, if the trigger function wants the triggering action to succeed normally without altering the row value, NEW (or a value equal thereto) has to be returned."


Four practical patterns:

| Goal | Return |
|---|---|
| Pass-through; don't change anything | `RETURN NEW;` for INSERT/UPDATE, `RETURN OLD;` for DELETE |
| Modify the row before it's written | mutate `NEW.col := ...;` then `RETURN NEW;` |
| Skip this row (silent, no error) | `RETURN NULL;` |
| Abort the entire statement | `RAISE EXCEPTION ...;` |


> [!WARNING] DELETE must return OLD, not NEW
> For BEFORE DELETE row triggers, the function must `RETURN OLD;` (or NULL to skip). `RETURN NEW;` in a DELETE trigger is a common error — `NEW` is NULL in DELETE triggers per the verbatim docs[^new-old-null] (see [TG_* variables](#new-and-old-records) below).


### AFTER and statement-level return values


All AFTER row triggers, BEFORE statement triggers, and AFTER statement triggers — their return value is **always ignored**. The verbatim rule[^after-ignored]:

> "The return value of a row-level trigger fired AFTER or a statement-level trigger fired BEFORE or AFTER is always ignored; it might as well be null. However, any of these types of triggers might still abort the entire operation by raising an error."


In practice, write `RETURN NULL;` at the end of all such trigger functions for clarity. The only way to influence the surrounding DML from an AFTER trigger is to `RAISE EXCEPTION` (which rolls back the statement, or in a deferred constraint trigger, rolls back the entire transaction).


### INSTEAD OF trigger return values


For INSTEAD OF triggers on views[^plpgsql-insteadof]:

> "INSTEAD OF triggers (which are always row-level triggers, and may only be used on views) can return null to signal that they did not perform any updates, and that the rest of the operation for this row should be skipped (i.e., subsequent triggers are not fired, and the row is not counted in the rows-affected status for the surrounding INSERT/UPDATE/DELETE). Otherwise a nonnull value should be returned, to signal that the trigger performed the requested operation."


The returned value is reported as the row processed by the surrounding INSERT/UPDATE/DELETE for `RETURNING` purposes — so the trigger function should usually do its underlying INSERT/UPDATE/DELETE against base tables, capture the resulting row, and return that.


### TG_* special variables


PL/pgSQL trigger functions have access to a fixed set of automatic variables (verbatim definitions from `plpgsql-trigger.html`)[^tg-vars]:


| Variable | Type | Contents |
|---|---|---|
| `TG_NAME` | `name` | "name of the trigger which fired" |
| `TG_WHEN` | `text` | "BEFORE, AFTER, or INSTEAD OF, depending on the trigger's definition" |
| `TG_LEVEL` | `text` | "ROW or STATEMENT, depending on the trigger's definition" |
| `TG_OP` | `text` | "operation for which the trigger was fired: INSERT, UPDATE, DELETE, or TRUNCATE" |
| `TG_RELID` | `oid` | "object ID of the table that caused the trigger invocation" (references `pg_class.oid`) |
| `TG_TABLE_NAME` | `name` | "table that caused the trigger invocation" |
| `TG_TABLE_SCHEMA` | `name` | "schema of the table that caused the trigger invocation" |
| `TG_NARGS` | `integer` | "number of arguments given to the trigger function in the CREATE TRIGGER statement" |
| `TG_ARGV` | `text[]` | "arguments from the CREATE TRIGGER statement. The index counts from 0. Invalid indexes (less than 0 or greater than or equal to tg_nargs) result in a null value" |
| `TG_RELNAME` | `name` | **deprecated** — verbatim: *"This is now deprecated, and could disappear in a future release. Use TG_TABLE_NAME instead."* |


> [!WARNING] TG_RELNAME is deprecated
> Use `TG_TABLE_NAME` instead. `TG_RELNAME` still works on current versions but the docs explicitly warn it may be removed. Legacy code carrying `TG_RELNAME` should be migrated.


### NEW and OLD records


The verbatim definitions[^new-old-null]:

> "**NEW** `record` — new database row for INSERT/UPDATE operations in row-level triggers. This variable is null in statement-level triggers and for DELETE operations."

> "**OLD** `record` — old database row for UPDATE/DELETE operations in row-level triggers. This variable is null in statement-level triggers and for INSERT operations."


The NEW/OLD/NULL table:

| Trigger type | INSERT | UPDATE | DELETE | TRUNCATE |
|---|---|---|---|---|
| ROW BEFORE/AFTER | `NEW`, `OLD`=NULL | `NEW`, `OLD` both set | `NEW`=NULL, `OLD` | *(illegal — no row-level TRUNCATE)* |
| INSTEAD OF (views) | `NEW`, `OLD`=NULL | `NEW`, `OLD` both set | `NEW`=NULL, `OLD` | *(illegal)* |
| STATEMENT BEFORE/AFTER | both NULL | both NULL | both NULL | both NULL |


Statement-level triggers cannot access NEW/OLD records of individual rows. Use transition tables instead.


### Transition tables


Declared via `REFERENCING { OLD | NEW } TABLE [ AS ] transition_relation_name`. Verbatim summary[^trans-tables-restrict]:

> "The REFERENCING option enables collection of transition relations, which are row sets that include all of the rows inserted, deleted, or modified by the current SQL statement. This feature lets the trigger see a global view of what the statement did, not just one row at a time. This option is only allowed for an AFTER trigger on a plain table (not a foreign table). The trigger should not be a constraint trigger. Also, if the trigger is an UPDATE trigger, it must not specify a column_name list when using this option."


Pairs by event:

| Event | `OLD TABLE` available? | `NEW TABLE` available? |
|---|---|---|
| INSERT | no | yes |
| UPDATE | yes | yes |
| DELETE | yes | no |


Restrictions (verbatim)[^trans-tables-restrict]:

> "Currently, row-level triggers with transition relations cannot be defined on partitions or inheritance child tables. Also, triggers on partitioned tables may not be INSTEAD OF."


And from `trigger-definition.html`:

> "AFTER ROW triggers can also request transition tables, so that they can see the total changes in the table as well as the change in the individual row they are currently being fired for."


Five operational consequences:

1. **AFTER triggers only.** BEFORE triggers cannot use transition tables because the changes have not been applied yet.

2. **Plain tables only.** Not foreign tables, not partitions / inheritance children — though the parent of a partitioned table can have them (and they see rows across all partitions of that statement).

3. **Not constraint triggers.** Constraint triggers fire on a per-row basis with deferral; they cannot collect a set of rows.

4. **No column list for UPDATE triggers using transition tables.** `AFTER UPDATE OF col1, col2 ... REFERENCING NEW TABLE AS n` is illegal — the trigger must be `AFTER UPDATE` without a column list.

5. **Transition relation name is local to the trigger.** Refer to it in the trigger function as a regular table (e.g., `SELECT ... FROM newrows`). It exists only for the duration of that trigger invocation.

See [Recipe 4](#examples--recipes) for the canonical statement-level audit pattern using transition tables.


### WHEN clause


The WHEN clause is a boolean expression that **decides whether the trigger function is invoked at all**. Verbatim semantics[^when-before-after]:

> "In a BEFORE trigger, the WHEN condition is evaluated just before the function is or would be executed, so using WHEN is not materially different from testing the same condition at the beginning of the trigger function."

> "However, in an AFTER trigger, the WHEN condition is evaluated just after the row update occurs, and it determines whether an event is queued to fire the trigger at the end of statement."

> "INSTEAD OF triggers do not support WHEN conditions."


For AFTER triggers, the WHEN clause is operationally significant — it determines whether the event is even queued, so a false-WHEN AFTER trigger has near-zero cost. For BEFORE triggers it just saves the function-call overhead.


Three rules[^when-rules]:

- Cannot contain subqueries (verbatim: *"Currently, WHEN expressions cannot contain subqueries."*).

- Can reference `OLD.col` for UPDATE/DELETE, `NEW.col` for INSERT/UPDATE; cannot reference both in INSERT-only or DELETE-only triggers.

- For constraint triggers, the WHEN condition is **evaluated immediately, not deferred** (verbatim: *"Note that for constraint triggers, evaluation of the WHEN condition is not deferred, but occurs immediately after the row update operation is performed."*).


Canonical use[^when-canonical]:

    -- only fire when status actually changes
    CREATE TRIGGER notify_status_change
    AFTER UPDATE OF status ON orders
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION send_status_notification();


The combination `UPDATE OF status` + `WHEN (OLD.status IS DISTINCT FROM NEW.status)` is the canonical "only fire on real changes" pattern. `UPDATE OF` skips the trigger when the column isn't in the SET list; `WHEN` skips when the column is in the SET list but the value is the same.


### Constraint triggers


Constraint triggers are `AFTER ROW` triggers that can be `DEFERRABLE INITIALLY DEFERRED`, allowing the check to be postponed to COMMIT. Verbatim definition[^constraint-trigger-defer]:

> "The execution of an AFTER trigger can be deferred to the end of the transaction, rather than the end of the statement, if it was defined as a constraint trigger."


Constraint triggers are how PostgreSQL itself implements FK enforcement (see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — the `RI_ConstraintTrigger_*` family). User code rarely needs them directly; the deferrable constraints in [`37-constraints.md`](./37-constraints.md) cover most cases. But for cross-table consistency rules that cannot be expressed as a FK or CHECK, constraint triggers are the right tool.


Constraint trigger restrictions:

- Always `AFTER ROW`. No `FOR EACH STATEMENT`, no `BEFORE`, no `INSTEAD OF`.

- Cannot fire on TRUNCATE.

- Cannot use transition tables.

- The optional `FROM referenced_table_name` clause exists but is documented as "not recommended for general use"[^constraint-from]; it's primarily for internal FK implementation.


### Visibility of data changes


Within a trigger function, what the trigger can SEE about the data depends on its timing[^data-changes]:

> "none of the changes made by a statement are visible to statement-level BEFORE triggers, whereas all modifications are visible to statement-level AFTER triggers."

> "The data change (insertion, update, or deletion) causing the trigger to fire is naturally not visible to SQL commands executed in a row-level BEFORE trigger, because it hasn't happened yet."

> "When a row-level AFTER trigger is fired, all data changes made by the outer command are already complete, and are visible to the invoked trigger function."

> "However, SQL commands executed in a row-level BEFORE trigger will see the effects of data changes for rows previously processed in the same outer command."

> "This requires caution, since the ordering of these change events is not in general predictable; an SQL command that affects multiple rows can visit the rows in any order."


Visibility table:

| Trigger | Sees its own row's change? | Sees other rows' changes in same statement? |
|---|---|---|
| STATEMENT BEFORE | n/a | no — nothing has changed yet |
| ROW BEFORE | no — change hasn't happened | **yes** — partial cumulative state, ordering unpredictable |
| ROW AFTER | yes | yes — all changes from this statement |
| STATEMENT AFTER | n/a | yes — full statement-level effect |
| INSTEAD OF ROW | n/a (the underlying view is unchanged) | yes for prior INSTEAD OF firings in the same statement |


> [!WARNING] STABLE / IMMUTABLE trigger functions
> Verbatim: *"If your trigger function is written in any of the standard procedural languages, then the above statements apply only if the function is declared VOLATILE. Functions that are declared STABLE or IMMUTABLE will not see changes made by the calling command in any case."* The default volatility for trigger functions is VOLATILE — but if you explicitly mark a trigger function STABLE/IMMUTABLE (rare, but happens), its snapshot is frozen at the start of the outer command and it will silently fail to see intra-statement changes. See [`06-functions.md`](./06-functions.md) for volatility rules.


### Trigger and RI-trigger interaction


The internal RI-enforcement triggers (`tgisinternal = true`, names like `RI_ConstraintTrigger_a_*` and `RI_ConstraintTrigger_c_*`) are **just AFTER ROW triggers** in the same firing-order pool as user triggers. They fire in alphabetical order with everything else. The `RI_ConstraintTrigger_a_*` prefix sorts ahead of most user trigger names, which is why FK enforcement effectively happens before most user AFTER triggers.


Two consequences:

1. **A user AFTER trigger named `aa_audit` runs before FK enforcement (because `aa_audit` < `RI_ConstraintTrigger_a_...` alphabetically).** If your audit trigger logs the post-state, and an FK violation later aborts the statement, the audit row is still rolled back with the rest of the transaction — but the audit trigger has *seen* a state that violated the FK. Usually fine; occasionally a source of debugging confusion.

2. **`DISABLE TRIGGER ALL` disables ALL user triggers AND requires superuser to also disable internal RI triggers.** The default `DISABLE TRIGGER ALL` excludes the internal ones[^disable-all-excludes-internal]:

    > "One can disable or enable a single trigger specified by name, or all triggers on the table, or only user triggers (this option excludes internally generated constraint triggers, such as those that are used to implement foreign key constraints or deferrable uniqueness and exclusion constraints)."

    > "Disabling or enabling internally generated constraint triggers requires superuser privileges; it should be done with caution since of course the integrity of the constraint cannot be guaranteed if the triggers are not executed."


To see which triggers are user-level vs internal, query `pg_trigger` filtering on `tgisinternal`:

    SELECT tgname, tgtype, tgenabled, tgisinternal
    FROM pg_trigger
    WHERE tgrelid = 'public.orders'::regclass
    ORDER BY tgname;


### Triggers on partitioned tables


Row-level triggers on partitioned tables are **cloned to every partition** (existing and future)[^partition-clone]:

> "Creating a row-level trigger on a partitioned table will cause an identical 'clone' trigger to be created on each of its existing partitions; and any partitions created or attached later will have an identical trigger, too. If there is a conflictingly-named trigger on a child partition already, an error occurs unless CREATE OR REPLACE TRIGGER is used, in which case that trigger is replaced with a clone trigger. When a partition is detached from its parent, its clone triggers are removed."


Inheritance / statement-trigger interaction[^partition-stmt]:

> "A statement that targets a parent table in an inheritance or partitioning hierarchy does not cause the statement-level triggers of affected child tables to be fired; only the parent table's statement-level triggers are fired. However, row-level triggers of any affected child tables will be fired."


PG-version timeline for trigger-on-partition support:

| Version | Capability | Verbatim release-note (where applicable) |
|---|---|---|
| PG10 | Declarative partitioning introduced; trigger story incomplete | n/a |
| PG11 | Row-level triggers on partitioned tables (cloned to children) | (introductory feature; verify against partitioning release notes) |
| PG13 | BEFORE ROW triggers on partitioned tables | (introductory feature; verify against partitioning release notes — see [`35-partitioning.md`](./35-partitioning.md)) |
| PG15 | `ALTER TRIGGER ... RENAME` recurses to children | *"Fix ALTER TRIGGER RENAME on partitioned tables to properly rename triggers on all partitions (Arne Roland, Álvaro Herrera). Also prohibit cloned triggers from being renamed."*[^pg15-rename] |


> [!NOTE] PostgreSQL 15
> `ALTER TRIGGER ... RENAME` on a partitioned-table trigger now recursively renames the clone on each partition. Pre-PG15, the rename only applied to the parent's row in `pg_trigger`, leaving the child clones with the old name. PG15 also prohibits renaming a cloned (child) trigger directly — you must rename via the parent.


Partition-row-movement consequence — verbatim[^partition-rowmove]:

> "If an UPDATE on a partitioned table causes a row to move to another partition, it will be performed as a DELETE from the original partition followed by an INSERT into the new partition."


So a partition-key UPDATE that moves a row fires both DELETE and INSERT triggers on the affected partitions, not UPDATE triggers — a common source of double-counting bugs in audit-trigger code. See [`35-partitioning.md`](./35-partitioning.md) gotcha #12.


### DISABLE / ENABLE TRIGGER


Four states for each trigger[^enable-states]:

| Clause | Fires when `session_replication_role` is... |
|---|---|
| `DISABLE TRIGGER name` | never |
| `ENABLE TRIGGER name` (default) | `origin` (default) or `local` |
| `ENABLE REPLICA TRIGGER name` | only `replica` |
| `ENABLE ALWAYS TRIGGER name` | any value (origin, local, or replica) |


Verbatim[^enable-states]:

> "Simply enabled triggers (the default) will fire when the replication role is 'origin' (the default) or 'local'."

> "Triggers configured as ENABLE REPLICA will only fire if the session is in 'replica' mode, and triggers configured as ENABLE ALWAYS will fire regardless of the current replication role."


And on deferred triggers[^enable-deferred]:

> "(For a deferred trigger, the enable status is checked when the event occurs, not when the trigger function is actually executed.)"


### session_replication_role


This GUC has three values: `origin` (default), `local`, `replica`. The `replica` value is set automatically by logical-replication apply workers when applying changes from a publisher; it can also be set manually for one-off "I am the replica" operations (rare).


Common patterns:

- **Default triggers don't fire during logical-replication apply.** This is usually what you want — the trigger already fired on the publisher, you don't want to double-fire on the subscriber. But it surprises operators who set up logical replication and wonder why their audit triggers stopped logging.

- **`ENABLE REPLICA TRIGGER` for "only fire on the replica" patterns** — e.g., a trigger that propagates changes to a downstream system from the subscriber side, but not from the publisher (where the change originates).

- **`ENABLE ALWAYS TRIGGER` for triggers that must run regardless** — e.g., security-critical validation that must not be bypassed by setting `session_replication_role = replica`.


To temporarily skip all user triggers in a maintenance session:

    SET session_replication_role = 'replica';
    -- DDL or DML that should bypass default triggers
    SET session_replication_role = 'origin';


> [!WARNING] session_replication_role is per-session
> The setting reverts to its default at session end. To make it permanent for a specific role: `ALTER ROLE replica_apply SET session_replication_role = 'replica';`. The logical-replication apply worker does this automatically.


### ALTER TRIGGER


Synopsis[^alter-trigger]:

    ALTER TRIGGER name ON table_name RENAME TO new_name
    ALTER TRIGGER name ON table_name [ NO ] DEPENDS ON EXTENSION extension_name


Verbatim semantics:

> "The RENAME clause changes the name of the given trigger without otherwise changing the trigger definition."

> "If the table that the trigger is on is a partitioned table, then corresponding clone triggers in the partitions are renamed too." (PG15+)

> "The DEPENDS ON EXTENSION clause marks the trigger as dependent on an extension, such that if the extension is dropped, the trigger will automatically be dropped as well."


And the canonical "why is enable/disable not in ALTER TRIGGER" answer:

> "The ability to temporarily enable or disable a trigger is provided by ALTER TABLE, not by ALTER TRIGGER, because ALTER TRIGGER has no convenient way to express the option of enabling or disabling all of a table's triggers at once."


### DROP TRIGGER


Synopsis[^drop-trigger]:

    DROP TRIGGER [ IF EXISTS ] name ON table_name [ CASCADE | RESTRICT ]


Standard semantics: `IF EXISTS` is silent on miss; `CASCADE` removes dependent objects; `RESTRICT` is the default (refuses if dependents exist). Cross-reference to SQL standard incompatibility — verbatim:

> "The DROP TRIGGER statement in PostgreSQL is incompatible with the SQL standard. In the SQL standard, trigger names are not local to tables, so the command is simply ``DROP TRIGGER name``."


---


## Per-Version Timeline


| Version | Triggers-relevant change | Source |
|---|---|---|
| PG10 | Transition tables (`REFERENCING OLD/NEW TABLE AS`) introduced; row-level triggers on partitioned tables not yet supported | Historical — pre-baseline for this skill |
| PG11 | Row-level triggers on partitioned tables (cloned to children) | (partitioning release notes; see [`35-partitioning.md`](./35-partitioning.md)) |
| PG13 | BEFORE ROW triggers on partitioned tables | (partitioning release notes; see [`35-partitioning.md`](./35-partitioning.md)) |
| PG14 | `OR REPLACE` for `CREATE TRIGGER` | *"Add OR REPLACE option for CREATE TRIGGER (Takamichi Osumi). This allows pre-existing triggers to be conditionally replaced."*[^pg14-or-replace] |
| PG15 | `ALTER TRIGGER ... RENAME` recurses on partitioned tables; prohibit renaming clone child triggers directly | *"Fix ALTER TRIGGER RENAME on partitioned tables to properly rename triggers on all partitions (Arne Roland, Álvaro Herrera). Also prohibit cloned triggers from being renamed."*[^pg15-rename] |
| PG16 | TRUNCATE triggers on foreign tables; `promote_trigger_file` GUC removed (HA-config incompatibility, unrelated to triggers despite the name) | *"Allow truncate triggers on foreign tables (Yugo Nagata)."*[^pg16-truncate-fdw] / *"Remove server variable promote_trigger_file (Simon Riggs). This was used to promote a standby to primary, but is now more easily accomplished with pg_ctl promote or pg_promote()."*[^pg16-promote-trigger-file] |
| PG17 | **Zero** direct trigger-API changes. `merge_action()` is a RETURNING-list function, not a trigger function (see [`03-syntax-dml.md`](./03-syntax-dml.md)) | Verified by direct fetch of PG17 release notes |
| PG18 | **Silent semantic change:** `AFTER` triggers execute as the role active at *queue time*, not execution/COMMIT time | *"Execute AFTER triggers as the role that was active when trigger events were queued (Laurenz Albe). Previously such triggers were run as the role that was active at trigger execution time (e.g., at COMMIT). This is significant for cases where the role is changed between queue time and transaction commit."*[^pg18-role] |
| PG18 | `RETURNING OLD/NEW` (DML feature) — triggers are unchanged, but trigger functions writing to other tables can now use `OLD`/`NEW` in those subordinate `RETURNING` clauses | *"Add OLD/NEW support to RETURNING in DML queries (Dean Rasheed). ... These aliases can be renamed to avoid identifier conflicts."*[^pg18-returning] |


> [!NOTE] PostgreSQL 16
> The PG16 release notes removed the `promote_trigger_file` GUC[^pg16-promote-trigger-file]. **This is unrelated to triggers** — `promote_trigger_file` was an HA-config knob (drop a file at this path to promote a standby) and was replaced by `pg_ctl promote` / `pg_promote()`. Mentioned here only because users searching release notes for "trigger" will find it and may misclassify; see [`77-standby-failover.md`](./77-standby-failover.md) for the standby-promotion context.


---


## Examples / Recipes


### Recipe 1 — baseline updated_at maintenance via BEFORE ROW trigger


The canonical "auto-maintain the updated_at column" pattern. BEFORE ROW UPDATE, modifies `NEW`, returns `NEW`.

    CREATE TABLE orders (
        id        bigint PRIMARY KEY,
        status    text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        NEW.updated_at := now();
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER orders_set_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION set_updated_at();


Two design choices:

1. **`BEFORE UPDATE` not `AFTER UPDATE`** — must be BEFORE so the function can modify `NEW` before the row is written. An AFTER trigger would need to issue a corrective `UPDATE`, doubling the write cost and risking infinite recursion.

2. **`WHEN (OLD IS DISTINCT FROM NEW)`** — skip when the UPDATE doesn't actually change anything. `IS DISTINCT FROM` (NULL-safe) is used because regular `=` returns NULL when either side is NULL.

Note: this skips on no-op updates including no-op partial-column UPDATEs (`UPDATE orders SET status = status WHERE id = 1`). That's almost always what you want; the trigger fires only when a meaningful change happens.


### Recipe 2 — selective AFTER trigger using UPDATE OF + WHEN


Notify a downstream system only when a specific column actually changes value:

    CREATE OR REPLACE FUNCTION notify_status_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        PERFORM pg_notify('order_status', json_build_object(
            'id', NEW.id,
            'old_status', OLD.status,
            'new_status', NEW.status
        )::text);
        RETURN NULL;  -- AFTER row trigger; return value ignored
    END;
    $$;

    CREATE TRIGGER orders_notify_status
    AFTER UPDATE OF status ON orders
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION notify_status_change();


Two filters:

- `UPDATE OF status` — the trigger event is only registered when `status` is in the SET list. `UPDATE orders SET note = 'foo'` doesn't even queue this trigger.

- `WHEN (OLD.status IS DISTINCT FROM NEW.status)` — when `status` *is* in the SET list but the value is the same, skip. Together this gives "fire only on actual status changes." See [`45-listen-notify.md`](./45-listen-notify.md) for `pg_notify` semantics.


### Recipe 3 — INSTEAD OF trigger to make a view writable


A view that joins two tables is not auto-updatable. INSTEAD OF triggers make it so:

    CREATE VIEW order_summary AS
    SELECT o.id, o.status, c.email AS customer_email, o.created_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id;

    CREATE OR REPLACE FUNCTION order_summary_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            UPDATE orders SET status = NEW.status WHERE id = OLD.id;
        END IF;
        IF NEW.customer_email IS DISTINCT FROM OLD.customer_email THEN
            UPDATE customers SET email = NEW.customer_email
            WHERE id = (SELECT customer_id FROM orders WHERE id = OLD.id);
        END IF;
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER order_summary_update_t
    INSTEAD OF UPDATE ON order_summary
    FOR EACH ROW
    EXECUTE FUNCTION order_summary_update();


INSTEAD OF triggers are always `FOR EACH ROW`, always on views. Define separate triggers for INSERT, UPDATE, DELETE if you want all three operations supported. Cross-reference [`05-views.md`](./05-views.md) for the auto-updatable-view rules and when INSTEAD OF is required.


### Recipe 4 — set-based audit via transition tables


Statement-level AFTER trigger with transition tables — far faster than the per-row equivalent for bulk DML:

    CREATE TABLE orders_audit (
        audit_id   bigserial PRIMARY KEY,
        op         text NOT NULL,
        order_id   bigint,
        old_row    jsonb,
        new_row    jsonb,
        changed_by text NOT NULL DEFAULT current_user,
        changed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION orders_audit_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF TG_OP = 'INSERT' THEN
            INSERT INTO orders_audit (op, order_id, new_row)
            SELECT 'INSERT', id, to_jsonb(n)
            FROM new_rows n;
        ELSIF TG_OP = 'UPDATE' THEN
            INSERT INTO orders_audit (op, order_id, old_row, new_row)
            SELECT 'UPDATE', n.id, to_jsonb(o), to_jsonb(n)
            FROM new_rows n JOIN old_rows o ON o.id = n.id;
        ELSIF TG_OP = 'DELETE' THEN
            INSERT INTO orders_audit (op, order_id, old_row)
            SELECT 'DELETE', id, to_jsonb(o)
            FROM old_rows o;
        END IF;
        RETURN NULL;
    END;
    $$;

    CREATE TRIGGER orders_audit_insert
    AFTER INSERT ON orders
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION orders_audit_fn();

    CREATE TRIGGER orders_audit_update
    AFTER UPDATE ON orders
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION orders_audit_fn();

    CREATE TRIGGER orders_audit_delete
    AFTER DELETE ON orders
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION orders_audit_fn();


Three separate triggers because the legal `REFERENCING` clauses differ per event (INSERT has only NEW TABLE, DELETE has only OLD TABLE). The same trigger function handles all three by branching on `TG_OP`.

Performance contrast: an `UPDATE orders SET status = 'shipped' WHERE created_at < ...` affecting 10,000 rows produces 10,000 row-level trigger invocations and 10,000 audit-table INSERTs in the AFTER ROW pattern. The statement-level + transition-table version produces **one** trigger invocation and one set-based INSERT — typically 50-100× faster on bulk DML.


### Recipe 5 — BEFORE INSERT to enforce a domain rule


Pattern: reject rows whose body violates a complex business rule that CHECK constraints can't express (because CHECK can't reference other tables; see [`37-constraints.md`](./37-constraints.md) gotcha #12).

    CREATE OR REPLACE FUNCTION enforce_email_unique_in_active_tenant()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
        existing_count integer;
    BEGIN
        SELECT count(*) INTO existing_count
        FROM users
        WHERE tenant_id = NEW.tenant_id
          AND email = NEW.email
          AND status = 'active'
          AND id IS DISTINCT FROM NEW.id;  -- exclude self when updating

        IF existing_count > 0 THEN
            RAISE EXCEPTION 'email % already in use in tenant %', NEW.email, NEW.tenant_id
                USING ERRCODE = 'unique_violation';
        END IF;

        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER users_unique_email_active
    BEFORE INSERT OR UPDATE OF email, status, tenant_id ON users
    FOR EACH ROW
    EXECUTE FUNCTION enforce_email_unique_in_active_tenant();


> [!WARNING] Race condition
> This pattern is NOT race-free under READ COMMITTED. Two concurrent inserts can both pass the trigger's `count(*)` check before either has committed. For real uniqueness, prefer a partial unique index: `CREATE UNIQUE INDEX ON users (tenant_id, email) WHERE status = 'active';`. Use a partial unique index instead whenever possible; trigger-based uniqueness is the fallback when the rule spans multiple tables or conditions a partial index cannot express — see [`22-indexes-overview.md`](./22-indexes-overview.md).


### Recipe 6 — disable triggers temporarily for bulk loads


    BEGIN;
    ALTER TABLE orders DISABLE TRIGGER USER;  -- user triggers only; preserves RI
    -- bulk DML
    COPY orders FROM STDIN ...;
    ALTER TABLE orders ENABLE TRIGGER USER;
    COMMIT;


`DISABLE TRIGGER USER` skips user triggers but preserves internal RI (FK-enforcement) triggers. `DISABLE TRIGGER ALL` would skip FK enforcement too — requires superuser and risks integrity violations. The PG18+ alternative is `ALTER CONSTRAINT ... NOT ENFORCED` for FKs specifically; see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) Recipe 11.


An alternative for replication-style bulk loads:

    BEGIN;
    SET LOCAL session_replication_role = 'replica';
    -- bulk DML; default user triggers skipped, ENABLE ALWAYS triggers still fire
    COPY orders FROM STDIN ...;
    COMMIT;  -- session_replication_role reverts


This is per-session/per-transaction and doesn't require ALTER TABLE (no AccessExclusiveLock).


### Recipe 7 — circular-dependency consistency via constraint trigger


Constraint triggers can be `DEFERRABLE INITIALLY DEFERRED` — useful for cross-table consistency rules that need to be checked at COMMIT, not at each statement.

    CREATE OR REPLACE FUNCTION check_team_has_lead()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
        missing_team_id bigint;
    BEGIN
        SELECT t.id INTO missing_team_id
        FROM teams t
        LEFT JOIN team_members m ON m.team_id = t.id AND m.role = 'lead'
        WHERE m.team_id IS NULL
        LIMIT 1;

        IF missing_team_id IS NOT NULL THEN
            RAISE EXCEPTION 'team % has no lead', missing_team_id
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER team_must_have_lead
    AFTER INSERT OR UPDATE OR DELETE ON team_members
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_team_has_lead();


With the trigger initially deferred, intermediate states are allowed mid-transaction — you can demote the current lead and promote a new one in two statements, with the check happening at COMMIT. Use `SET CONSTRAINTS team_must_have_lead IMMEDIATE` to force an early check.


### Recipe 8 — audit query for all triggers on a table


    SELECT tgname AS trigger_name,
           CASE tgenabled
               WHEN 'O' THEN 'enabled (origin/local)'
               WHEN 'D' THEN 'disabled'
               WHEN 'R' THEN 'enabled (replica only)'
               WHEN 'A' THEN 'enabled (always)'
           END AS state,
           CASE
               WHEN (tgtype::int & 2) <> 0 THEN 'BEFORE'
               WHEN (tgtype::int & 64) <> 0 THEN 'INSTEAD OF'
               ELSE 'AFTER'
           END AS timing,
           CASE
               WHEN (tgtype::int & 1) <> 0 THEN 'ROW'
               ELSE 'STATEMENT'
           END AS level,
           CONCAT_WS(' OR ',
               CASE WHEN (tgtype::int & 4) <> 0 THEN 'INSERT' END,
               CASE WHEN (tgtype::int & 8) <> 0 THEN 'DELETE' END,
               CASE WHEN (tgtype::int & 16) <> 0 THEN 'UPDATE' END,
               CASE WHEN (tgtype::int & 32) <> 0 THEN 'TRUNCATE' END
           ) AS events,
           tgisinternal,
           pg_get_triggerdef(oid) AS definition
    FROM pg_trigger
    WHERE tgrelid = 'public.orders'::regclass
    ORDER BY tgname;


The `tgtype` bitmask is the canonical decoder. The `tgisinternal` column distinguishes user triggers from RI / internal triggers. `pg_get_triggerdef(oid)` returns the reconstructed `CREATE TRIGGER` statement — verbatim from `functions-info.html`-style semantics; useful for dumping definitions for migration scripts.


### Recipe 9 — multi-table trigger via TG_TABLE_NAME branching


When the same logic applies to many tables, attach one trigger function to many tables and branch on `TG_TABLE_NAME`:

    CREATE OR REPLACE FUNCTION generic_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        INSERT INTO audit_log (table_name, op, row_data, changed_at)
        VALUES (TG_TABLE_NAME, TG_OP,
                CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
                now());
        RETURN NULL;
    END;
    $$;

    -- attach to multiple tables
    DO $$
    DECLARE
        t text;
    BEGIN
        FOREACH t IN ARRAY ARRAY['orders', 'customers', 'products', 'shipments']
        LOOP
            EXECUTE format(
                'CREATE TRIGGER %I_audit
                 AFTER INSERT OR UPDATE OR DELETE ON %I
                 FOR EACH ROW EXECUTE FUNCTION generic_audit()',
                t, t);
        END LOOP;
    END $$;


Preferred to building dynamic SQL inside the trigger body (which is slow and complicated to debug). The function is parameter-less and uses the implicit `TG_*` context.


### Recipe 10 — partition-aware trigger via parent attachment


Attach a row-level trigger to the partitioned-parent table; PostgreSQL automatically clones it to every existing partition and to any new partitions added or attached later[^partition-clone]:

    CREATE TABLE events (
        event_id   bigserial,
        occurred_at timestamptz NOT NULL,
        payload    jsonb,
        PRIMARY KEY (event_id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);

    CREATE TABLE events_2026_01 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

    CREATE TABLE events_2026_02 PARTITION OF events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

    CREATE OR REPLACE FUNCTION ensure_event_signed()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF NEW.payload->>'signature' IS NULL THEN
            RAISE EXCEPTION 'event missing signature';
        END IF;
        RETURN NEW;
    END;
    $$;

    -- attach once to the parent; PostgreSQL clones to each partition
    CREATE TRIGGER events_require_signature
    BEFORE INSERT ON events
    FOR EACH ROW
    EXECUTE FUNCTION ensure_event_signed();

    -- verify clones exist on each partition
    SELECT c.relname AS partition,
           tgname AS trigger_name,
           tgisinternal
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname LIKE 'events_%'
    ORDER BY c.relname, tgname;


When you add a new partition (`CREATE TABLE events_2026_03 PARTITION OF events FOR VALUES ...`), the clone trigger is created automatically on the new partition.


### Recipe 11 — find user triggers (excluding RI / internal)


    SELECT n.nspname AS schema,
           c.relname AS table_name,
           t.tgname AS trigger_name,
           pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE t.tgisinternal = false
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname, t.tgname;


Filter `tgisinternal = false` to exclude RI triggers (FK enforcement, deferrable unique / exclusion constraint enforcement). Filter out catalog / information_schema namespaces to focus on application tables.


### Recipe 12 — PG18 audit pre-emption


Before upgrading to PG18, audit code paths that change roles between trigger queue-time and COMMIT. Pattern to look for:

    BEGIN;
    SET ROLE owner_role;
    INSERT INTO orders ...;  -- AFTER triggers queue with effective role = owner_role
    SET ROLE admin_role;
    -- previously: AFTER triggers run as admin_role at COMMIT
    -- PG18+:      AFTER triggers run as owner_role (queue-time role)
    COMMIT;


This is most likely to surface in:

- Audit triggers that record `current_user` — the recorded user may now be the original DML caller, not the role that committed.

- SECURITY INVOKER triggers that depend on `SET ROLE` for privilege checks during the trigger function body.

- Multi-tenant patterns that switch role mid-transaction to attribute audit rows to the correct tenant.


Mitigation strategies:

1. **Avoid `SET ROLE` between DML and COMMIT** in transactions that have triggers.

2. **Use `SET LOCAL ROLE`** inside an explicit subtransaction (savepoint) so the role binding is scoped.

3. **Capture the desired audit user explicitly** in the application layer rather than relying on `current_user` inside trigger bodies.


### Recipe 13 — disable trigger for one statement using session_replication_role


    -- in a maintenance session, bypass default triggers for one statement
    BEGIN;
    SET LOCAL session_replication_role = 'replica';
    UPDATE orders SET status = 'archived'
    WHERE created_at < now() - interval '5 years';
    COMMIT;


`SET LOCAL` scopes the change to this transaction; `COMMIT` restores the prior value automatically. Triggers marked `ENABLE ALWAYS` will still fire — useful as a "must-not-skip" marker for audit-required triggers.


---


## Gotchas / Anti-patterns


1. **BEFORE DELETE must RETURN OLD, not NEW.** `NEW` is NULL in DELETE triggers (verbatim from `plpgsql-trigger.html`[^new-old-null]: *"This variable is null in statement-level triggers and for DELETE operations."*). A common error is copy-pasting an INSERT/UPDATE trigger and getting silent skip behavior because `RETURN NEW;` returns NULL in a DELETE context, which silently skips the row.

2. **`RETURN NULL` in BEFORE ROW silently skips the row, no error.** The DML succeeds (statement returns), but this specific row is not inserted/updated/deleted. Subsequent BEFORE triggers do NOT fire. If you want to abort the entire statement, `RAISE EXCEPTION` instead.

3. **AFTER trigger return values are ignored.** Writing `RETURN NEW;` vs `RETURN NULL;` in an AFTER trigger makes no difference; PostgreSQL ignores it. Many code style guides standardize on `RETURN NULL;` for AFTER triggers as a deliberate signal.

4. **Trigger firing order is alphabetical by name, not creation order.** SQL standard says creation order; PostgreSQL says name order[^compat-name-order]. The verbatim docs note: *"SQL specifies that multiple triggers should be fired in time-of-creation order. PostgreSQL uses name order, which was judged to be more convenient."* Prefix names with `01_`, `02_`, `99_` etc. to encode ordering explicitly.

5. **Transition tables are AFTER STATEMENT only, plain tables only.** Cannot be used on BEFORE triggers, cannot be used on constraint triggers, cannot be used on partitions / inheritance children (defined on the parent works), cannot be used with `UPDATE OF col_list` (UPDATE triggers using transition tables can't have a column list).

6. **`UPDATE OF col1, col2` filters at the event-registration level, not by value equality.** `UPDATE orders SET status = status WHERE id = 1` fires `AFTER UPDATE OF status` (because `status` is in the SET list) even though the value doesn't change. Add a `WHEN (OLD.status IS DISTINCT FROM NEW.status)` for value-equality skipping.

7. **`WHEN` cannot contain subqueries.** Verbatim: *"Currently, WHEN expressions cannot contain subqueries."*[^when-rules]. To express subquery-based conditions, do the check inside the trigger function body.

8. **A trigger function marked STABLE or IMMUTABLE silently fails to see intra-statement changes.** Trigger functions should be VOLATILE (the default). The docs verbatim[^data-changes]: *"Functions that are declared STABLE or IMMUTABLE will not see changes made by the calling command in any case."*

9. **session_replication_role = 'replica' silently skips default triggers.** Audit triggers that "stopped working after logical replication setup" are the canonical symptom. Mark must-fire triggers `ENABLE ALWAYS TRIGGER` to override.

10. **`DISABLE TRIGGER ALL` includes RI triggers and requires superuser.** Use `DISABLE TRIGGER USER` to disable only user-level triggers and preserve FK enforcement[^disable-all-excludes-internal]. The verbatim docs note: *"Disabling or enabling internally generated constraint triggers requires superuser privileges; it should be done with caution since of course the integrity of the constraint cannot be guaranteed if the triggers are not executed."*

11. **`ALTER TABLE ... DISABLE TRIGGER` takes ACCESS EXCLUSIVE on the table.** Even though it's a metadata-only change conceptually, it locks the table out for the duration. For high-traffic tables, `SET session_replication_role = 'replica'` per-session is the lock-free alternative.

12. **TG_RELNAME is deprecated.** Use `TG_TABLE_NAME` instead. Code that still uses `TG_RELNAME` works on current PG but will break in some future version.

13. **`pg_trigger.tgenabled` is a single char: 'O', 'D', 'R', 'A'.** Not a boolean. The codes mean origin/disabled/replica/always respectively. Make sure audit queries decode it.

14. **Trigger functions cannot be parallel-safe.** Trigger function calls happen inside DML, which generally cannot be parallelized in PostgreSQL. Marking a trigger function `PARALLEL SAFE` doesn't actually enable parallelism for the surrounding DML.

15. **Triggers fire on partitioned tables but the parent's statement-level triggers only fire once even when many partitions are affected.** Statement triggers are per-statement, not per-partition. Row-level triggers fire on each affected partition (cloned to children).

16. **A partition-key UPDATE that moves a row fires DELETE then INSERT triggers, not UPDATE.** Verbatim[^partition-rowmove]: *"If an UPDATE on a partitioned table causes a row to move to another partition, it will be performed as a DELETE from the original partition followed by an INSERT into the new partition."* Audit triggers that count UPDATE events will undercount in row-movement scenarios.

17. **`ENABLE REPLICA TRIGGER` doesn't bypass `DISABLE TRIGGER ALL`.** The four states (DISABLE / ENABLE / ENABLE REPLICA / ENABLE ALWAYS) are mutually exclusive — a trigger can only be in one state at a time. `DISABLE TRIGGER name` overrides any prior `ENABLE REPLICA TRIGGER name`.

18. **Triggers can recurse infinitely if they UPDATE the same table.** A BEFORE UPDATE trigger that does `UPDATE other_orders ...` from inside, where `other_orders` has its own BEFORE UPDATE trigger that updates back, will loop until stack overflow. PostgreSQL has `current_setting('max_stack_depth')` protection but it's not a substitute for not writing the loop.

19. **`CREATE OR REPLACE TRIGGER` (PG14+) replaces the function binding, not the function body.** If you also changed the function body, you must `CREATE OR REPLACE FUNCTION` separately. Triggers reference functions by OID; replacing the trigger doesn't recompile the function.

20. **Constraint trigger WHEN clause is NOT deferred** — verbatim[^when-rules]: *"Note that for constraint triggers, evaluation of the WHEN condition is not deferred, but occurs immediately after the row update operation is performed."* The deferral is on the trigger function call, not the WHEN evaluation.

21. **PG18 silent role-binding change for AFTER triggers.** Pre-PG18: AFTER trigger ran as the role active at execution time (effectively COMMIT time for deferred). PG18+: AFTER trigger runs as the role active at queue time (when the DML happened)[^pg18-role]. Audit code paths that rely on `current_user` inside AFTER trigger functions.

22. **Triggers do not fire on COPY FROM with FREEZE.** `COPY ... FREEZE` requires that no triggers fire on the target table (and several other restrictions). This is one of the reasons FREEZE is a niche optimization.

23. **`pg_get_triggerdef(oid)` returns a reconstruction, not the original SQL.** Verbatim semantics of `pg_get_*` functions (cross-ref `pg_get_constraintdef` from [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) gotcha #13): the output is a decompiled reconstruction. It is functionally equivalent but may differ from the exact source text (whitespace, quoting, alias expansion).


---


## See Also


- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — table DDL and the lock-level matrix that applies to `CREATE TRIGGER` / `ALTER TABLE ... DISABLE TRIGGER`

- [`03-syntax-dml.md`](./03-syntax-dml.md) — INSERT/UPDATE/DELETE/MERGE that fire triggers; `RETURNING OLD/NEW` (PG18+)

- [`05-views.md`](./05-views.md) — INSTEAD OF triggers as the way to make a view writable; auto-updatable view rules

- [`06-functions.md`](./06-functions.md) — volatility (VOLATILE / STABLE / IMMUTABLE) for trigger functions; SECURITY DEFINER vs INVOKER

- [`08-plpgsql.md`](./08-plpgsql.md) — writing trigger function bodies in PL/pgSQL; the full TG_* variable list; RAISE EXCEPTION

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — snapshot semantics for trigger functions; what "visible" means within a trigger body

- [`35-partitioning.md`](./35-partitioning.md) — declarative partitioning; trigger cloning to partitions; partition-key UPDATEs and row movement

- [`37-constraints.md`](./37-constraints.md) — CHECK / NOT NULL / UNIQUE / FK as constraint alternatives to trigger-based enforcement

- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — RI triggers (`tgisinternal = true`, `RI_ConstraintTrigger_a_/c_`) as the FK enforcement mechanism

- [`40-event-triggers.md`](./40-event-triggers.md) — DDL-level event triggers (different from this file's table-level triggers)

- [`43-locking.md`](./43-locking.md) — lock levels taken by `CREATE TRIGGER` (ShareRowExclusive) and `ALTER TABLE ... DISABLE TRIGGER` (AccessExclusive)

- [`45-listen-notify.md`](./45-listen-notify.md) — `pg_notify()` from inside trigger functions

- [`52-rules-system.md`](./52-rules-system.md) — CREATE RULE as the legacy mechanism that triggers largely replaced

- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_trigger` schema, `tgtype` bitmask decoding, `pg_get_triggerdef()`

- [`74-logical-replication.md`](./74-logical-replication.md) — `session_replication_role = replica` set by apply workers; ENABLE REPLICA / ENABLE ALWAYS TRIGGER use cases

- [`77-standby-failover.md`](./77-standby-failover.md) — PG16 removal of `promote_trigger_file` GUC (HA-related, despite the name)


---


## Sources


All URLs verified via WebFetch during iteration 40.

[^triggers-intro]: PostgreSQL 16 — Triggers chapter intro. https://www.postgresql.org/docs/16/triggers.html

[^before-skip]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"It can return NULL to skip the operation for the current row. This instructs the executor to not perform the row-level operation that invoked the trigger (the insertion, modification, or deletion of a particular table row)."* https://www.postgresql.org/docs/16/trigger-definition.html

[^after-ignored]: PostgreSQL 16 — "PL/pgSQL Trigger Functions" — *"The return value of a row-level trigger fired AFTER or a statement-level trigger fired BEFORE or AFTER is always ignored; it might as well be null. However, any of these types of triggers might still abort the entire operation by raising an error."* https://www.postgresql.org/docs/16/plpgsql-trigger.html

[^per-row-vs-statement]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"In particular, a statement that affects zero rows will still result in the execution of any applicable per-statement triggers."* https://www.postgresql.org/docs/16/trigger-definition.html

[^trans-tables-restrict]: PostgreSQL 16 — `CREATE TRIGGER` reference — *"The REFERENCING option enables collection of transition relations ... Currently, row-level triggers with transition relations cannot be defined on partitions or inheritance child tables. Also, triggers on partitioned tables may not be INSTEAD OF."* https://www.postgresql.org/docs/16/sql-createtrigger.html

[^firing-order]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"If more than one trigger is defined for the same event on the same relation, the triggers will be fired in alphabetical order by trigger name."* https://www.postgresql.org/docs/16/trigger-definition.html

[^pg18-role]: PostgreSQL 18 release notes (Migration to Version 18 — Incompatibilities) — *"Execute AFTER triggers as the role that was active when trigger events were queued (Laurenz Albe). Previously such triggers were run as the role that was active at trigger execution time (e.g., at COMMIT). This is significant for cases where the role is changed between queue time and transaction commit."* https://www.postgresql.org/docs/release/18.0/

[^create-trigger-grammar]: PostgreSQL 16 / 18 — `CREATE TRIGGER` reference, full synopsis (byte-identical between PG16 and PG18). https://www.postgresql.org/docs/16/sql-createtrigger.html and https://www.postgresql.org/docs/18/sql-createtrigger.html

[^pg14-or-replace]: PostgreSQL 14 release notes — *"Add OR REPLACE option for CREATE TRIGGER (Takamichi Osumi). This allows pre-existing triggers to be conditionally replaced."* https://www.postgresql.org/docs/release/14.0/

[^for-each-default]: PostgreSQL 16 — `CREATE TRIGGER` reference — *"This specifies whether the trigger function should be fired once for every row affected by the trigger event, or just once per SQL statement. If neither is specified, FOR EACH STATEMENT is the default."* https://www.postgresql.org/docs/16/sql-createtrigger.html

[^matrix]: PostgreSQL 16 — `CREATE TRIGGER` reference, "Description" table showing legal when × event × level × relation-kind combinations. https://www.postgresql.org/docs/16/sql-createtrigger.html

[^pg16-truncate-fdw]: PostgreSQL 16 release notes — *"Allow truncate triggers on foreign tables (Yugo Nagata)."* https://www.postgresql.org/docs/release/16.0/

[^compat-name-order]: PostgreSQL 16 — `CREATE TRIGGER` Compatibility section — *"SQL specifies that multiple triggers should be fired in time-of-creation order. PostgreSQL uses name order, which was judged to be more convenient."* https://www.postgresql.org/docs/16/sql-createtrigger.html

[^plpgsql-before-return]: PostgreSQL 16 — PL/pgSQL Trigger Functions — *"Row-level triggers fired BEFORE can return null to signal the trigger manager to skip the rest of the operation for this row ... Returning a row value different from the original value of NEW alters the row that will be inserted or updated."* https://www.postgresql.org/docs/16/plpgsql-trigger.html

[^new-old-null]: PostgreSQL 16 — PL/pgSQL Trigger Functions — *"NEW record — new database row for INSERT/UPDATE operations in row-level triggers. This variable is null in statement-level triggers and for DELETE operations. OLD record — old database row for UPDATE/DELETE operations in row-level triggers. This variable is null in statement-level triggers and for INSERT operations."* https://www.postgresql.org/docs/16/plpgsql-trigger.html

[^plpgsql-insteadof]: PostgreSQL 16 — PL/pgSQL Trigger Functions — *"INSTEAD OF triggers (which are always row-level triggers, and may only be used on views) can return null to signal that they did not perform any updates ... Otherwise a nonnull value should be returned, to signal that the trigger performed the requested operation."* https://www.postgresql.org/docs/16/plpgsql-trigger.html

[^tg-vars]: PostgreSQL 16 — PL/pgSQL Trigger Functions — full TG_* variable catalog (TG_NAME, TG_WHEN, TG_LEVEL, TG_OP, TG_RELID, TG_TABLE_NAME, TG_TABLE_SCHEMA, TG_NARGS, TG_ARGV, TG_RELNAME). https://www.postgresql.org/docs/16/plpgsql-trigger.html

[^when-before-after]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"In a BEFORE trigger, the WHEN condition is evaluated just before the function is or would be executed ... However, in an AFTER trigger, the WHEN condition is evaluated just after the row update occurs, and it determines whether an event is queued to fire the trigger at the end of statement."* https://www.postgresql.org/docs/16/trigger-definition.html

[^when-rules]: PostgreSQL 16 — `CREATE TRIGGER` reference — *"Currently, WHEN expressions cannot contain subqueries."* and *"Note that for constraint triggers, evaluation of the WHEN condition is not deferred, but occurs immediately after the row update operation is performed."* https://www.postgresql.org/docs/16/sql-createtrigger.html

[^when-canonical]: PostgreSQL 16 — combined `UPDATE OF` + `WHEN (OLD.col IS DISTINCT FROM NEW.col)` canonical "only fire on real changes" pattern. https://www.postgresql.org/docs/16/sql-createtrigger.html

[^constraint-trigger-defer]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"The execution of an AFTER trigger can be deferred to the end of the transaction, rather than the end of the statement, if it was defined as a constraint trigger."* https://www.postgresql.org/docs/16/trigger-definition.html

[^constraint-from]: PostgreSQL 16 — `CREATE TRIGGER` reference — *"The (possibly schema-qualified) name of another table referenced by the constraint ... This option is used for foreign-key constraints and is not recommended for general use. This can only be specified for constraint triggers."* https://www.postgresql.org/docs/16/sql-createtrigger.html

[^data-changes]: PostgreSQL 16 — "Visibility of Data Changes" — full visibility paragraph covering BEFORE/AFTER × ROW/STATEMENT × VOLATILE/STABLE/IMMUTABLE. https://www.postgresql.org/docs/16/trigger-datachanges.html

[^disable-all-excludes-internal]: PostgreSQL 16 — `ALTER TABLE` DISABLE/ENABLE TRIGGER section — *"One can disable or enable a single trigger specified by name, or all triggers on the table, or only user triggers (this option excludes internally generated constraint triggers, such as those that are used to implement foreign key constraints or deferrable uniqueness and exclusion constraints)."* and *"Disabling or enabling internally generated constraint triggers requires superuser privileges; it should be done with caution since of course the integrity of the constraint cannot be guaranteed if the triggers are not executed."* https://www.postgresql.org/docs/16/sql-altertable.html

[^partition-clone]: PostgreSQL 16 — `CREATE TRIGGER` reference — *"Creating a row-level trigger on a partitioned table will cause an identical 'clone' trigger to be created on each of its existing partitions; and any partitions created or attached later will have an identical trigger, too. If there is a conflictingly-named trigger on a child partition already, an error occurs unless CREATE OR REPLACE TRIGGER is used, in which case that trigger is replaced with a clone trigger. When a partition is detached from its parent, its clone triggers are removed."* https://www.postgresql.org/docs/16/sql-createtrigger.html

[^partition-stmt]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"A statement that targets a parent table in an inheritance or partitioning hierarchy does not cause the statement-level triggers of affected child tables to be fired; only the parent table's statement-level triggers are fired. However, row-level triggers of any affected child tables will be fired."* https://www.postgresql.org/docs/16/trigger-definition.html

[^pg15-rename]: PostgreSQL 15 release notes — *"Fix ALTER TRIGGER RENAME on partitioned tables to properly rename triggers on all partitions (Arne Roland, Álvaro Herrera). Also prohibit cloned triggers from being renamed."* https://www.postgresql.org/docs/release/15.0/

[^partition-rowmove]: PostgreSQL 16 — "Overview of Trigger Behavior" — *"If an UPDATE on a partitioned table causes a row to move to another partition, it will be performed as a DELETE from the original partition followed by an INSERT into the new partition."* https://www.postgresql.org/docs/16/trigger-definition.html

[^enable-states]: PostgreSQL 16 — `ALTER TABLE` DISABLE/ENABLE TRIGGER section — full verbatim text on ENABLE / DISABLE / ENABLE REPLICA / ENABLE ALWAYS and the `session_replication_role` interaction. https://www.postgresql.org/docs/16/sql-altertable.html

[^enable-deferred]: PostgreSQL 16 — `ALTER TABLE` DISABLE/ENABLE TRIGGER section — *"(For a deferred trigger, the enable status is checked when the event occurs, not when the trigger function is actually executed.)"* https://www.postgresql.org/docs/16/sql-altertable.html

[^alter-trigger]: PostgreSQL 16 — `ALTER TRIGGER` reference. https://www.postgresql.org/docs/16/sql-altertrigger.html

[^drop-trigger]: PostgreSQL 16 — `DROP TRIGGER` reference. https://www.postgresql.org/docs/16/sql-droptrigger.html

[^pg16-promote-trigger-file]: PostgreSQL 16 release notes (Migration to Version 16) — *"Remove server variable promote_trigger_file (Simon Riggs). This was used to promote a standby to primary, but is now more easily accomplished with pg_ctl promote or pg_promote()."* https://www.postgresql.org/docs/release/16.0/

[^pg18-returning]: PostgreSQL 18 release notes — *"Add OLD/NEW support to RETURNING in DML queries (Dean Rasheed). Previously RETURNING only returned new values for INSERT and UPDATE, and old values for DELETE; MERGE would return the appropriate value for the internal query executed. This new syntax allows the RETURNING list of INSERT/UPDATE/DELETE/MERGE to explicitly return old and new values by using the special aliases old and new. These aliases can be renamed to avoid identifier conflicts."* https://www.postgresql.org/docs/release/18.0/

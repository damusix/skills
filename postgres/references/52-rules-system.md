# The Rule System — CREATE RULE, ALTER RULE, DROP RULE

The PostgreSQL **query rewrite rule system** is the parse-time mechanism that rewrites query trees before planning. It is the substrate that views are built on (every view is internally one `ON SELECT DO INSTEAD` rule named `_RETURN`), and it remains supported for DML rewriting via `ON INSERT`/`ON UPDATE`/`ON DELETE` rules. **For new code, triggers and views are almost always the correct tool**; the docs themselves repeatedly hedge toward triggers (*"you probably want to use a trigger, not a rule"*[^create-rule], *"easier for novices to get right"*[^rules-triggers]). This file documents the rule system for the rare cases where it still fits and for understanding how views work internally.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — Five Rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [CREATE RULE Grammar](#create-rule-grammar)
- [ALSO vs INSTEAD](#also-vs-instead)
- [ON SELECT — How Views Work Internally](#on-select--how-views-work-internally)
- [ON INSERT / UPDATE / DELETE — DML Rewriting](#on-insert--update--delete--dml-rewriting)
- [NEW and OLD References](#new-and-old-references)
- [Rules and Privileges](#rules-and-privileges)
- [Rules and Command Status](#rules-and-command-status)
- [Rules vs Triggers — The Canonical Comparison](#rules-vs-triggers--the-canonical-comparison)
- [ALTER RULE — Rename Only](#alter-rule--rename-only)
- [DROP RULE](#drop-rule)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Read this file when you need to:

- Understand how views work internally — every view is one `ON SELECT DO INSTEAD` rule, and that knowledge is essential for diagnosing view rewrite issues, predicate push-down failures, and rule/trigger ordering questions.
- Maintain or migrate legacy code that uses `CREATE RULE` for DML rewriting on tables or views (most commonly `ON INSERT DO INSTEAD` on a view, predating PG9.1's auto-updatable views and INSTEAD OF triggers).
- Decide between rules and triggers for a new rewrite requirement (almost always the answer is "triggers" — this file makes that explicit).
- Understand the PG16 incompatibility that removed manual `_RETURN` rule construction for views.

> [!WARNING] Rules are a legacy mechanism for new DML rewriting
> The rule system is **the foundation of views** and is not deprecated, but `CREATE RULE` for DML rewriting (`ON INSERT`/`ON UPDATE`/`ON DELETE`) has been superseded by **auto-updatable views** (PG9.3+) for simple cases and **`INSTEAD OF` triggers** (PG9.1+) for complex cases. The official `CREATE RULE` docs themselves recommend triggers: *"If you actually want an operation that fires independently for each physical row, you probably want to use a trigger, not a rule."*[^create-rule] For new code, reach for [`39-triggers.md`](./39-triggers.md) or [`05-views.md`](./05-views.md) first. Use `CREATE RULE` only when (a) you are maintaining legacy schemas that use it, (b) you genuinely need parse-time query rewriting that triggers cannot provide, or (c) you are reading this to understand what `CREATE VIEW` compiles down to.

If you want updatable views, see [`05-views.md`](./05-views.md) — auto-updatable rules and `INSTEAD OF` triggers cover the cases where `ON INSERT DO INSTEAD` rules were the only option in PG9.0 and earlier.

## Mental Model — Five Rules

1. **Rules rewrite queries at parse time; triggers fire at execution time.** A rule transforms the parsed query tree *before* the planner sees it. A trigger runs *after* the planner has produced a plan, when the executor actually touches a row (or statement). This is the single most consequential distinction: rules see the *query*, triggers see the *data*. A rule fires zero, one, or N times depending on what the rewrite produces; a trigger fires per-row or per-statement based on its declaration. Cross-reference [`39-triggers.md`](./39-triggers.md) for the trigger surface.

2. **Views are implemented via `ON SELECT DO INSTEAD`.** Verbatim: *"Views in PostgreSQL are implemented using the rule system. A view is basically an empty table (having no actual storage) with an `ON SELECT DO INSTEAD` rule."*[^rules-views] The rule's conventional name is `_RETURN`. `CREATE VIEW v AS SELECT ...` and `CREATE TABLE v (...); CREATE RULE "_RETURN" AS ON SELECT TO v DO INSTEAD SELECT ...` were operationally equivalent through PG15, but PG16 removed the ability to construct views manually that way — see the per-version timeline.

3. **`INSTEAD` replaces; `ALSO` adds.** Verbatim: *"INSTEAD indicates that the commands should be executed instead of the original command. ALSO indicates that the commands should be executed in addition to the original command. If neither ALSO nor INSTEAD is specified, ALSO is the default."*[^create-rule] An `INSTEAD NOTHING` rule silently discards matching commands; an unqualified `INSTEAD` rule replaces them; an `ALSO` rule keeps the original and adds the rule's commands.

4. **ON SELECT rules are syntactically restricted to `DO INSTEAD SELECT`.** All `ON SELECT` rules must be `DO INSTEAD` with a single `SELECT` action. They cannot be `ALSO`, they cannot have `WHERE` qualifications other than `WHERE true`, and they cannot fire multiple actions. This restriction exists because `ON SELECT` rules rewrite *in place* (they mutate the query tree directly, not by adding new trees) — verbatim *"And they have different semantics from rules on the other command types in that they modify the query tree in place instead of creating a new one."*[^rules-views]

5. **Rules don't have separate owners — the table owner owns them.** Verbatim: *"Rewrite rules don't have a separate owner. The owner of a relation (table or view) is automatically the owner of the rewrite rules that are defined for it."*[^rules-privileges] All relations referenced through rules are checked against the rule owner's privileges, not the invoker's. This is exactly the same model as default (non-`security_invoker`) views — and for the same reason: a view *is* a rule. Cross-reference [`05-views.md`](./05-views.md) and [`47-row-level-security.md`](./47-row-level-security.md) for the `security_invoker` opt-out.

## Decision Matrix

| You want to | Use | Avoid | Why |
|---|---|---|---|
| Make a SELECT-on-view work (the everyday case) | `CREATE VIEW` | manual `CREATE RULE "_RETURN" ON SELECT DO INSTEAD` | PG16+ disallows the manual form; even pre-PG16 it is undocumented-extension territory |
| Make an updatable view (simple cases) | Auto-updatable view (PG9.3+) | `CREATE RULE ON INSERT DO INSTEAD ...` | PG auto-generates the right rules when the view meets simple-updatability rules; see [`05-views.md`](./05-views.md) |
| Make an updatable view (complex cases) | `INSTEAD OF` trigger | `CREATE RULE ON INSERT DO INSTEAD ...` | Triggers are easier to reason about and verbatim *"easier for novices to get right"*[^rules-triggers] |
| Validate / reject DML on a table | `BEFORE` trigger with `RAISE EXCEPTION` | `CREATE RULE ... WHERE ... DO INSTEAD NOTHING` | Rules cannot raise errors meaningfully; verbatim *"If checks for valid values are required, and in the case of an invalid value an error message should be generated, it must be done by a trigger."*[^rules-triggers] |
| Audit/log every row changed | `AFTER` trigger writing to audit table; or transition tables for set-based audit | `CREATE RULE ON UPDATE DO ALSO INSERT INTO audit ...` | Triggers see NEW/OLD per row; rules see only the query tree and only fire once per statement |
| Implement RLS-like row filtering | RLS policies (`CREATE POLICY`) | `CREATE RULE ON SELECT DO INSTEAD SELECT ... WHERE owner = current_user` | RLS is purpose-built for this since PG9.5; rules require `security_barrier` to be safe and are harder to compose |
| Make a non-updatable view writable to a different target table | `INSTEAD OF` trigger on the view | `CREATE RULE ON INSERT DO INSTEAD INSERT INTO other_tab ...` | Triggers compose with constraints, RETURNING, and `WITH CHECK OPTION` cleanly; rules have subtle interaction quirks |
| Implement set-based statement audit | `AFTER STATEMENT` trigger with `REFERENCING NEW TABLE / OLD TABLE` (PG10+) | `ON UPDATE DO ALSO INSERT ...` rule | Transition tables give you the changed-row set without requiring per-row trigger fan-out; see [`39-triggers.md`](./39-triggers.md) Recipe 4 |
| Cascade an INSERT to a partition or shard | Declarative partitioning or `INSTEAD OF` trigger | Hand-rolled `ON INSERT DO INSTEAD` rule fan-out | Partitioning is the modern answer; if you have multiple targets, an `INSTEAD OF` trigger composes more cleanly with `RETURNING` |
| Maintain pre-PG9.1 legacy code that uses rules for DML | Keep the rules running; document them | Migrating without understanding the rewrite semantics | Rules and triggers fire at different phases — silently swapping a rule for a trigger can change behavior |
| Diagnose "my view is slow" | Read [`05-views.md`](./05-views.md) and [`56-explain.md`](./56-explain.md) | Rewriting the view as a CTE or temp table | Almost every "slow view" issue traces to predicate push-down or rewrite optimization, not to the rule system itself |

**Three smell signals** that you have reached for a rule when you should not have:

- **Your rule has `WHERE` clauses that need to inspect column values.** Rules see the query tree, not the data; complex per-row conditional logic is a trigger problem.
- **You are using `ON INSERT DO INSTEAD` on a view to redirect writes.** This is the legacy idiom that `INSTEAD OF` triggers (PG9.1+) and auto-updatable views (PG9.3+) replaced. Migrate.
- **You are writing `ON UPDATE DO ALSO INSERT INTO audit_log ...` to capture row deltas.** The audit will not see NEW/OLD on a per-row basis; it will fire once per statement against the *query tree*. Use a trigger.

## CREATE RULE Grammar

The grammar is identical in PG14, PG15, PG16, PG17, and PG18 (verified by direct fetch of PG18 and PG16 docs):[^create-rule]

```sql
CREATE [ OR REPLACE ] RULE name AS ON event
    TO table_name [ WHERE condition ]
    DO [ ALSO | INSTEAD ] { NOTHING | command | ( command ; command ; ... ) }
```

where `event` is one of: `SELECT`, `INSERT`, `UPDATE`, `DELETE`.

**Operational properties:**

- `CREATE OR REPLACE RULE` requires the new rule to match the old one's event type and target relation.
- The condition in `WHERE` cannot reference any tables other than `NEW` and `OLD`, and cannot contain aggregate functions or subqueries that reference the target.
- Multiple commands inside `( ... ; ... )` execute in order.
- Rules are per-relation: `CREATE RULE r ON event TO t1` and `CREATE RULE r ON event TO t2` are independent rules sharing the same name.
- Verbatim: *"CREATE RULE is a PostgreSQL language extension, as is the entire query rewrite system."*[^create-rule]

## ALSO vs INSTEAD

The two qualifiers determine what happens to the original command:

| Qualifier | Effect | Default? |
|---|---|---|
| `ALSO` | Run the original command AND the rule's commands | Yes (when neither is specified) |
| `INSTEAD` | Run the rule's commands; the original is suppressed | No |
| `INSTEAD NOTHING` | Run nothing; the original is discarded silently | Special case of `INSTEAD` with empty action |

A subtle case: an `INSTEAD` rule with a `WHERE` condition only replaces the original *for rows matching the condition*. Verbatim: *"Finally, if the rule is ALSO, the unchanged original query tree is added to the list. Since only qualified INSTEAD rules already add the original query tree, we end up with either one or two output query trees for a rule with one action."*[^rules-update]

The practical implication: an `INSTEAD` rule with no `WHERE` clause discards the original entirely; an `INSTEAD ... WHERE cond` rule keeps the original tree for rows that do *not* match the condition. This asymmetry is one of the reasons triggers are usually easier to reason about — a trigger fires per-row and `RETURN NULL` skips that row; a rule transforms the query tree at parse time without seeing data.

## ON SELECT — How Views Work Internally

`ON SELECT` rules have a special, restricted form: they must be `DO INSTEAD` with a single `SELECT` action and no `WHERE` qualification. This restriction exists because they rewrite *in place* — they mutate the query tree directly rather than appending new trees.[^rules-views]

Verbatim: *"Views in PostgreSQL are implemented using the rule system. A view is basically an empty table (having no actual storage) with an ON SELECT DO INSTEAD rule."*[^rules-views]

Conventionally that rule is named `_RETURN`. Pre-PG16, `CREATE VIEW v AS SELECT ...` was operationally equivalent to:

```sql
-- PRE-PG16 ONLY — this manual form was removed in PG16
CREATE TABLE v (/* same column list as the SELECT */);
CREATE RULE "_RETURN" AS ON SELECT TO v DO INSTEAD SELECT ... ;
```

> [!WARNING] PG16 removed manual `_RETURN` rule construction for views
> The PG16 release notes contain the incompatibility item: *"Remove the ability to create views manually with ON SELECT rules (Tom Lane)."*[^pg16-remove] Pre-PG16, you could (in principle) convert a regular table into a view by hand-attaching an `ON SELECT DO INSTEAD` rule. PG16+ disallows this — you must use `CREATE VIEW`. The internal representation is unchanged; only the bypass-CREATE-VIEW manual construction path was removed. If you have legacy migration scripts that perform this trick, they will break on PG16+.

### Why ON SELECT rules are restricted

The verbatim explanation:[^rules-views]

> *"Rules ON SELECT are applied to all queries as the last step, even if the command given is an INSERT, UPDATE or DELETE. And they have different semantics from rules on the other command types in that they modify the query tree in place instead of creating a new one. So SELECT rules are described first."*

In other words, the rule rewriter does *not* generate a separate query for a SELECT rule — it substitutes a subquery range-table entry containing the rule's action into the original tree, replacing the view-reference range-table entry. The planner then sees a tree as if the user had written the underlying SELECT directly. Verbatim: *"The planner has all the information about which tables have to be scanned plus the relationships between these tables plus the restrictive qualifications from the views plus the qualifications from the original query in one single query tree."*[^rules-views]

This is the structural reason views participate in plan optimizations (join elimination, predicate push-down, etc.) — they aren't a separate planning unit, they're a substituted subquery.

## ON INSERT / UPDATE / DELETE — DML Rewriting

`ON INSERT`/`ON UPDATE`/`ON DELETE` rules transform DML commands before they reach the executor. Unlike `ON SELECT`, these rules append additional query trees to the rewrite output rather than mutating in place.

The rewriter walks the rule list for each command, producing zero, one, or multiple output query trees:

- `INSTEAD` rule with no `WHERE` → 1 output query (the rule's action; original suppressed).
- `INSTEAD` rule with `WHERE cond` → 2 output queries (the rule's action for matching rows, the original for non-matching rows).
- `ALSO` rule (default if unqualified) → N+1 output queries (the original plus the rule's action).
- `INSTEAD NOTHING` → 0 output queries (silently discards the command for matching rows).

### Ordering rules: ON INSERT vs ON UPDATE/DELETE

The order of original-command vs rule-added-commands differs by event type. Verbatim:[^rules-update]

> *"For ON INSERT rules, the original query (if not suppressed by INSTEAD) is done before any actions added by rules. This allows the actions to see the inserted row(s). But for ON UPDATE and ON DELETE rules, the original query is done after the actions added by rules."*

The practical implication: an `ON INSERT DO ALSO INSERT INTO audit ...` rule sees the freshly-inserted rows; an `ON UPDATE DO ALSO INSERT INTO audit ...` rule sees the rows *before* the UPDATE applies. This asymmetry catches people writing audit rules. Use a trigger with `BEFORE`/`AFTER` semantics and explicit `OLD`/`NEW` references if you need predictable timing.

## NEW and OLD References

DML rules can reference the pseudo-relations `NEW` and `OLD` in their actions and `WHERE` clauses:

- `NEW` represents the new row values (for `INSERT`, `UPDATE`).
- `OLD` represents the existing row values (for `UPDATE`, `DELETE`).

Verbatim from the rewriter's substitution algorithm:[^rules-update]

> *"For any reference to NEW, the target list of the original query is searched for a corresponding entry. If found, that entry's expression replaces the reference. Otherwise, NEW means the same as OLD (for an UPDATE) or is replaced by a null value (for an INSERT). Any reference to OLD is replaced by a reference to the range-table entry that is the result relation."*

**Critical distinction from triggers:** `NEW` and `OLD` in rules are *substituted at parse-time* into the rewritten query tree. They are not row variables. The rule does not "see" actual values; it produces SQL that references columns. This is why rules cannot perform per-row conditional logic the way triggers can — the substitution happens once per statement, not once per row.

| Event | `NEW` references resolve to | `OLD` references resolve to |
|---|---|---|
| `INSERT` | The inserted row's column expressions (from the INSERT's VALUES or SELECT) | NULL (no pre-existing row) |
| `UPDATE` | The new column expressions (from the UPDATE's SET) | The existing row's columns (range-table entry) |
| `DELETE` | The existing row's columns (rules treat NEW as OLD for DELETE per docs) | The existing row's columns (range-table entry) |
| `SELECT` | Not applicable | Not applicable |

## Rules and Privileges

Rules execute with the privileges of the **rule owner** (which is the table owner — rules have no separate owner). This is identical to the default behavior of views and is the structural reason views were chosen as the implementation foundation.

Verbatim:[^rules-privileges]

> *"Rewrite rules don't have a separate owner. The owner of a relation (table or view) is automatically the owner of the rewrite rules that are defined for it."*

> *"All relations that are used due to rules get checked against the privileges of the rule owner, not the user invoking the rule. This means that, except for security invoker views, users only need the required privileges for the tables/views that are explicitly named in their queries."*

### security_barrier and security_invoker

The `security_barrier` view attribute prevents the planner from pushing user-supplied predicates *through* the view's WHERE clauses, blocking a class of information-leak attacks via leaky operators. Verbatim:[^rules-privileges]

> *"Views cannot be used to reliably conceal the data in unseen rows unless the security_barrier flag has been set."*

> *"When it is necessary for a view to provide row-level security, the security_barrier attribute should be applied to the view. This prevents maliciously-chosen functions and operators from being passed values from rows until after the view has done its work."*

The `security_invoker` attribute (PG15+) inverts the privilege model — the view runs with the *invoker's* privileges, not the owner's. Cross-reference [`05-views.md`](./05-views.md) and [`47-row-level-security.md`](./47-row-level-security.md) for the deeper view-security discussion. For pure `CREATE RULE` usage (not views), there is no `security_invoker` equivalent — rules always run as the table owner.

## Rules and Command Status

The `rules-status.html` page (section 41.6 in PG16, 39.6 in PG18) documents how rule-rewritten commands return status to the client. It is **not** an anti-patterns or limitations section — that framing lives in `rules-triggers.html` and the Notes section of `sql-createrule.html`.

The status string returned to the client (e.g., `INSERT 0 5`, `UPDATE 12`, `DELETE 3`) reflects the operation that actually happened on the *original* command:

- An `INSTEAD` rule with no `WHERE` and no `RETURNING` causes the client to see the status of the rule's last command (because the original is suppressed).
- An `INSTEAD` rule with `WHERE` produces the status of the original for rows that didn't match.
- An `ALSO` rule does not affect status — the original is run and its status is returned.

The operational consequence: an `INSTEAD NOTHING` rule that silently discards `INSERT` commands will return `INSERT 0 0` — there is no error, no warning, no log line indicating that the command was discarded. If you want the user to know, write a trigger that calls `RAISE EXCEPTION` instead.

## Rules vs Triggers — The Canonical Comparison

The docs include an entire section (`rules-triggers.html`) dedicated to this comparison. Key verbatim points:[^rules-triggers]

| Aspect | Rules | Triggers |
|---|---|---|
| When | Parse time (query rewrite) | Execution time (per row or per statement) |
| Granularity | Per statement (modifies the query) | Per row (`FOR EACH ROW`) or per statement (`FOR EACH STATEMENT`) |
| Sees data values? | No — sees only the query tree | Yes — `NEW`/`OLD` are actual row variables |
| Can RAISE EXCEPTION? | Effectively no (rules can't see data to validate) | Yes, with `RAISE EXCEPTION` |
| Can enforce FK-like constraints? | Not for cross-table validation | Yes |
| Cost model | Adds queries; cost scales with query, not row count | Fires per row; cost scales with row count |
| Best for | Large set-based rewrites where one extra query replaces N triggers | Per-row logic, validation, audit with NEW/OLD |
| Easier to reason about? | No (per docs) | Yes (per docs) |

Verbatim hedges from the docs:

> *"All of the update rule examples in this chapter can also be implemented using INSTEAD OF triggers on the views. Writing such triggers is often easier than writing rules, particularly if complex logic is required to perform the update."*[^rules-triggers]

> *"However, the trigger approach is conceptually far simpler than the rule approach, and is easier for novices to get right."*[^rules-triggers]

> *"If checks for valid values are required, and in the case of an invalid value an error message should be generated, it must be done by a trigger."*[^rules-triggers]

The one genuine performance advantage of rules:

> *"A trigger is fired once for each affected row. A rule modifies the query or generates an additional query. So if many rows are affected in one statement, a rule issuing one extra command is likely to be faster than a trigger that is called for every single row and must re-determine what to do many times."*[^rules-triggers]

The pre-PG10 era used this advantage routinely. **Since PG10, `AFTER STATEMENT` triggers with transition tables (`REFERENCING NEW TABLE / OLD TABLE`) give you the set-based-once-per-statement performance of rules with the data-visibility ergonomics of triggers** — cross-reference [`39-triggers.md`](./39-triggers.md) Recipe 4. The "rules are faster for bulk operations" justification rarely holds in modern code.

## ALTER RULE — Rename Only

The only `ALTER RULE` operation is `RENAME`:[^alter-rule]

```sql
ALTER RULE name ON table_name RENAME TO new_name
```

Verbatim: *"ALTER RULE changes properties of an existing rule. Currently, the only available action is to change the rule's name."*[^alter-rule]

To change a rule's body, you must `DROP RULE` and re-create it, or use `CREATE OR REPLACE RULE`. The owner is tied to the table — you cannot reassign rule ownership independently. To change ownership, transfer ownership of the underlying table.

## DROP RULE

```sql
DROP RULE [ IF EXISTS ] name ON table_name [ CASCADE | RESTRICT ]
```

`RESTRICT` (default) refuses to drop the rule if any objects depend on it. `CASCADE` drops dependent objects. Dropping a view's `_RETURN` rule via `DROP RULE _RETURN ON v` is generally disallowed because it would leave the view in an inconsistent state — use `DROP VIEW` instead.

## Per-Version Timeline

The rule system has been stable for many versions. The five-PG-major release-notes scan returned:

| Version | Rules-related changes |
|---|---|
| PG14 | **Zero** rules-system changes |
| PG15 | **Zero** rules-system changes |
| PG16 | **One incompatibility** — verbatim *"Remove the ability to create views manually with ON SELECT rules (Tom Lane)."*[^pg16-remove] The internal `_RETURN` rule construction that `CREATE VIEW` does is unchanged; only the **manual** path (attaching an `ON SELECT DO INSTEAD` rule by hand to convert a table into a view) was removed. |
| PG17 | **Zero** rules-system changes |
| PG18 | **Zero** rules-system changes. The rules chapter was renumbered from chapter 41 (PG16) to chapter 39 (PG18) due to broader manual reorganization, but the content is byte-identical. |

> [!NOTE] Four-of-five PG-major absence streak
> Across PG14, PG15, PG17, and PG18 release notes, the rules system received zero changes. PG16 contained one narrow incompatibility (manual `_RETURN` removal). If a tutorial claims "rules were improved in PG version N," verify against the release notes directly. The rule system is the longest-stable feature surface in modern PostgreSQL — its API is essentially frozen since PG9.x.

## Examples / Recipes

### Recipe 1 — Inspect the implicit `_RETURN` rule on a view

Every view has an internally-generated `ON SELECT DO INSTEAD` rule named `_RETURN`. You can see it directly in `pg_rewrite`:

```sql
CREATE VIEW active_users AS SELECT id, email FROM users WHERE deleted_at IS NULL;

SELECT n.nspname AS schema, c.relname AS view, r.rulename, r.ev_type
FROM pg_rewrite r
JOIN pg_class c ON c.oid = r.ev_class
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'active_users';
```

`ev_type` is `'1'` (SELECT), `'2'` (UPDATE), `'3'` (INSERT), `'4'` (DELETE). The rule body lives in `r.ev_action` as a parse-tree internal representation; `pg_get_viewdef(c.oid)` is the human-readable form. Cross-reference [`64-system-catalogs.md`](./64-system-catalogs.md) for the catalog graph.

### Recipe 2 — Find all user-defined rules (excluding view `_RETURN` rules)

Most rules in a typical database are view-implementation rules. To find rules that are NOT implementing a view's SELECT:

```sql
SELECT n.nspname AS schema, c.relname AS relation, r.rulename, r.ev_type,
       CASE r.ev_type
           WHEN '1' THEN 'SELECT'
           WHEN '2' THEN 'UPDATE'
           WHEN '3' THEN 'INSERT'
           WHEN '4' THEN 'DELETE'
       END AS event_type,
       pg_get_ruledef(r.oid) AS definition
FROM pg_rewrite r
JOIN pg_class c ON c.oid = r.ev_class
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE r.rulename <> '_RETURN'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');
```

This surfaces every hand-written rule in the database — useful as a migration audit before upgrading legacy schemas.

### Recipe 3 — DO INSTEAD NOTHING to make a view read-only

Pre-PG9.3 idiom for making a view explicitly reject writes:

```sql
CREATE VIEW reports AS SELECT id, name, total FROM raw_reports WHERE archived = false;

CREATE RULE reports_no_insert AS ON INSERT TO reports DO INSTEAD NOTHING;
CREATE RULE reports_no_update AS ON UPDATE TO reports DO INSTEAD NOTHING;
CREATE RULE reports_no_delete AS ON DELETE TO reports DO INSTEAD NOTHING;
```

**Modern replacement** (PG9.3+): rely on the fact that a view with `WHERE archived = false` is auto-updatable; if you want to forbid writes entirely, REVOKE INSERT/UPDATE/DELETE from PUBLIC. The `DO INSTEAD NOTHING` form silently swallows the command with no error — `REVOKE` produces an explicit permission-denied error, which is almost always the better behavior.

### Recipe 4 — Migrate a legacy ON INSERT DO INSTEAD rule to an INSTEAD OF trigger

Legacy pattern: a view whose INSERT redirects to a different table.

```sql
-- Legacy (pre-PG9.1 idiom)
CREATE VIEW v_users AS SELECT id, email FROM users;

CREATE RULE v_users_insert AS ON INSERT TO v_users
    DO INSTEAD INSERT INTO users (id, email) VALUES (NEW.id, NEW.email);
```

Modern equivalent using an `INSTEAD OF` trigger:

```sql
-- Drop the legacy rule
DROP RULE v_users_insert ON v_users;

-- Add an INSTEAD OF INSERT trigger
CREATE FUNCTION v_users_insert_fn() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO users (id, email) VALUES (NEW.id, NEW.email);
    RETURN NEW;  -- so RETURNING works
END;
$$;

CREATE TRIGGER v_users_insert_trg
    INSTEAD OF INSERT ON v_users
    FOR EACH ROW EXECUTE FUNCTION v_users_insert_fn();
```

The trigger form composes correctly with `RETURNING`, allows constraint checks, and supports `WITH CHECK OPTION`. The rule form had subtle interactions with all three. Cross-reference [`05-views.md`](./05-views.md) for INSTEAD OF trigger details and [`39-triggers.md`](./39-triggers.md) for the trigger surface.

### Recipe 5 — Use ALSO for fan-out (legacy pattern; prefer triggers)

`ON INSERT DO ALSO` runs both the original INSERT and the rule's action. The legacy use case was to fan out an INSERT to multiple tables.

```sql
-- Legacy
CREATE RULE orders_fan_out AS ON INSERT TO orders
    DO ALSO INSERT INTO orders_audit (order_id, created_at)
                     VALUES (NEW.id, now());
```

**Modern replacement**: an `AFTER INSERT` trigger that writes to the audit table. The trigger composes with transition tables (statement-level audit), explicit error handling, and works correctly with bulk inserts. The rule form has a subtle interaction with `INSERT ... RETURNING` because the audit insert is part of the same statement.

```sql
CREATE FUNCTION orders_audit_fn() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO orders_audit (order_id, created_at) VALUES (NEW.id, now());
    RETURN NULL;  -- AFTER triggers ignore return value
END;
$$;

CREATE TRIGGER orders_audit_trg
    AFTER INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_audit_fn();
```

For a higher-performance set-based audit, use transition tables:

```sql
CREATE TRIGGER orders_audit_stmt_trg
    AFTER INSERT ON orders
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION orders_audit_stmt_fn();
```

The function then runs one `INSERT INTO orders_audit SELECT id, now() FROM new_rows`. This is the modern equivalent of the legacy ALSO rule's performance properties. Cross-reference [`39-triggers.md`](./39-triggers.md) Recipe 4.

### Recipe 6 — Drop an old DO INSTEAD NOTHING rule to make a view writable

If you inherit a schema where rules block writes on a view:

```sql
-- Identify the blocking rule
SELECT rulename, pg_get_ruledef(r.oid)
FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
WHERE c.relname = 'reports';

-- Drop the blocking rule
DROP RULE reports_no_insert ON reports;

-- Optionally test auto-updatability
SELECT is_insertable_into FROM information_schema.tables WHERE table_name = 'reports';
```

`information_schema.tables.is_insertable_into` reports `YES` if PG considers the view auto-updatable (PG9.3+). If not, add an `INSTEAD OF INSERT` trigger.

### Recipe 7 — Find views that depend on ON SELECT rules with complex logic

Views with simple `SELECT * FROM tab WHERE ...` are auto-updatable. Complex views (joins, aggregates, DISTINCT) are not. Find views that may need `INSTEAD OF` triggers for writability:

```sql
SELECT v.viewname, v.definition,
       t.is_insertable_into, t.is_updatable
FROM pg_views v
JOIN information_schema.tables t
  ON t.table_schema = v.schemaname AND t.table_name = v.viewname
WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')
  AND t.is_insertable_into = 'NO';
```

These views require `INSTEAD OF` triggers if you want to support writes. Cross-reference [`05-views.md`](./05-views.md) for the updatability rules.

### Recipe 8 — Verify that the PG16 incompatibility breaks your code

If you have migration scripts that hand-construct views via `_RETURN` rules:

```sql
-- This pattern WORKED on PG15 and earlier, FAILS on PG16+
CREATE TABLE legacy_view (id int, email text);
CREATE RULE "_RETURN" AS ON SELECT TO legacy_view DO INSTEAD
    SELECT id, email FROM users WHERE deleted_at IS NULL;
```

On PG16+, the `CREATE RULE` call fails with an error. The fix is to use `CREATE VIEW`:

```sql
DROP TABLE IF EXISTS legacy_view;
CREATE VIEW legacy_view AS
    SELECT id, email FROM users WHERE deleted_at IS NULL;
```

Audit your migration scripts for any direct `_RETURN` rule construction before upgrading to PG16. Cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

### Recipe 9 — Audit which tables have user-defined rules

Operational audit query for cluster-wide rule inventory:

```sql
SELECT n.nspname AS schema,
       c.relname AS relation,
       c.relkind,
       count(*) AS rule_count,
       string_agg(r.rulename, ', ' ORDER BY r.rulename) AS rules
FROM pg_rewrite r
JOIN pg_class c ON c.oid = r.ev_class
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE r.rulename <> '_RETURN'  -- exclude view-implementation rules
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP BY n.nspname, c.relname, c.relkind
ORDER BY rule_count DESC;
```

Any non-zero row is a candidate for migration to triggers. Continues the catalog-audit-as-maintenance-recipe convention.

### Recipe 10 — Side-by-side: audit via rule vs audit via statement-trigger

The legacy idiom for capturing every UPDATE to an `orders` table:

```sql
-- LEGACY: rule-based audit
CREATE TABLE orders_audit (
    audit_id   bigserial PRIMARY KEY,
    order_id   int NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE RULE orders_audit_rule AS ON UPDATE TO orders
    DO ALSO INSERT INTO orders_audit (order_id) VALUES (NEW.id);
```

**Problems with this rule:** (a) the rewriter inserts a single audit row per *statement*, not per row — `UPDATE orders SET ...` affecting 1000 rows generates only 1 audit row, with `NEW.id` referring to the rewritten target list (the audit row gets the *last* row's id, not all of them); (b) `ON UPDATE DO ALSO` runs the rule's action *before* the original UPDATE per the rules-update.html ordering rule, so the audit doesn't see post-UPDATE state; (c) zero-row UPDATEs still fire the rule.

The modern equivalent uses a statement-level trigger with transition tables:

```sql
-- MODERN: statement-trigger audit with NEW TABLE
CREATE FUNCTION orders_audit_fn() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO orders_audit (order_id, changed_at)
    SELECT id, now() FROM new_rows;
    RETURN NULL;
END;
$$;

CREATE TRIGGER orders_audit_trg
    AFTER UPDATE ON orders
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION orders_audit_fn();
```

The trigger version: (a) audits one row per changed order; (b) sees post-UPDATE state via `new_rows`; (c) fires once per statement (low overhead); (d) sees zero rows when zero rows changed (does nothing). This is the canonical replacement for legacy `ON UPDATE DO ALSO` audit rules.

### Recipe 11 — Diagnose why a view query is being rewritten unexpectedly

If a view's `_RETURN` rule is producing surprising plan output, dump the rewriter's view of the query:

```sql
SET debug_print_rewritten = on;
SET client_min_messages = 'log';

SELECT * FROM my_view WHERE id = 1;
```

The server log will contain the post-rewrite query tree (very verbose). Set `debug_pretty_print = on` for readability. This is the canonical "what does the rewriter see" diagnostic for rule-related plan questions. For most cases, `EXPLAIN (VERBOSE) SELECT * FROM my_view ...` shows the substituted subquery directly in the plan output. Cross-reference [`56-explain.md`](./56-explain.md) for the full plan-reading surface.

### Recipe 12 — Inspect a rule's parse-tree action via pg_get_ruledef

`pg_get_ruledef()` reconstructs a rule's SQL form from the internal parse tree stored in `pg_rewrite.ev_action`:

```sql
SELECT r.rulename,
       pg_get_ruledef(r.oid, true) AS pretty_definition  -- second arg: pretty-print
FROM pg_rewrite r
JOIN pg_class c ON c.oid = r.ev_class
WHERE c.relname = 'my_view'
ORDER BY r.rulename;
```

The reconstructed form is canonicalized — it may include explicit casts, parenthesization, or schema-qualification that the original `CREATE RULE` statement did not have. This is exactly the same `pg_get_*def()` reconstruction-not-echo property documented in [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) and [`39-triggers.md`](./39-triggers.md) for FK and trigger definitions.

### Recipe 13 — Use psql `\d+` to list rules on a table

```sql
\d+ my_view
```

The expanded `\d+` output includes a "Rules:" section listing all rules on the relation, with their action definitions. Combine with `\set ECHO_HIDDEN on` to see the catalog query psql is running underneath — cross-reference [`64-system-catalogs.md`](./64-system-catalogs.md) for the catalog graph and [`67-cli-tools.md`](./67-cli-tools.md) for psql meta-command details.

## Gotchas / Anti-patterns

1. **`DO INSTEAD NOTHING` silently swallows commands with no error or log line.** A misconfigured rule that blocks INSERTs returns `INSERT 0 0` to the client — no exception, no warning. The application thinks it succeeded. Use `REVOKE` for permission enforcement or a `BEFORE` trigger with `RAISE EXCEPTION` for application-level rejection.

2. **Rules cannot validate data values.** Verbatim: *"If checks for valid values are required, and in the case of an invalid value an error message should be generated, it must be done by a trigger."*[^rules-triggers] Rules see the query tree, not row data; there is no clean way to inspect a column value and reject the operation.

3. **Rules fire at parse time, not execution time.** A rule that writes to an audit table runs whether or not the original command actually affects any rows. An `ON UPDATE DO ALSO INSERT INTO audit ...` rule fires on `UPDATE t SET x = 1 WHERE false` — zero rows updated, one audit row inserted. Triggers fire per-row and don't have this issue.

4. **`NEW` and `OLD` in rules are substituted at parse time, not row variables.** A rule cannot inspect actual row values to make conditional decisions. The `WHERE` clause on the rule can reference `NEW`/`OLD` columns, but the comparison happens per-statement against the rewritten query, not per-row.

5. **ON INSERT vs ON UPDATE/DELETE have opposite ordering.** Verbatim: *"For ON INSERT rules, the original query (if not suppressed by INSTEAD) is done before any actions added by rules ... But for ON UPDATE and ON DELETE rules, the original query is done after the actions added by rules."*[^rules-update] An INSERT rule's audit insert sees the new rows; an UPDATE rule's audit insert sees the rows *before* the UPDATE applies. Easy to get wrong.

6. **ON SELECT rules cannot be ALSO.** All ON SELECT rules must be `DO INSTEAD SELECT`. Attempting `CREATE RULE r AS ON SELECT TO t DO ALSO SELECT ...` fails. This is because ON SELECT rules rewrite in place.

7. **Rules with WHERE clauses can produce TWO output query trees.** Verbatim: *"Finally, if the rule is ALSO, the unchanged original query tree is added to the list. Since only qualified INSTEAD rules already add the original query tree, we end up with either one or two output query trees for a rule with one action."*[^rules-update] The implication: rule-side and original-side both run, and the database does double work for matching+non-matching rows.

8. **PG16 removed manual `_RETURN` rule construction.** Scripts that build views by attaching `ON SELECT DO INSTEAD` rules to empty tables stop working on PG16+. Use `CREATE VIEW`.

9. **Rules don't have separate owners.** Verbatim: *"Rewrite rules don't have a separate owner. The owner of a relation (table or view) is automatically the owner of the rewrite rules that are defined for it."*[^rules-privileges] To change rule owner, transfer the underlying table's ownership.

10. **`security_barrier` matters when a view is used for row filtering.** Without `security_barrier`, the planner can push user-supplied predicates *through* the view's WHERE clauses, potentially exposing rows the view should hide. Verbatim: *"Views cannot be used to reliably conceal the data in unseen rows unless the security_barrier flag has been set."*[^rules-privileges] Set `security_barrier = true` on any view used as a security boundary.

11. **`ALTER RULE` only renames.** To change a rule's body, you must DROP it and re-create, or use `CREATE OR REPLACE RULE`. There is no `ALTER RULE ... ACTION` form.

12. **Rules cannot fire conditionally per row.** A rule's `WHERE` clause filters statement-level: it either applies or doesn't, based on the query tree, not the row data. A trigger with a `WHEN` clause filters per-row. For row-level conditional logic, use a trigger.

13. **Rules and `INSTEAD OF` triggers conflict.** Verbatim: *"Rules are evaluated first, rewriting the original query before it is planned and executed. Therefore, if a view has INSTEAD OF triggers as well as rules on INSERT, UPDATE, or DELETE, then the rules will be evaluated first, and depending on the result, the triggers may not be used at all."*[^rules-views] If a rule's INSTEAD action eliminates the original query, the INSTEAD OF trigger never fires. Pick one mechanism.

14. **`pg_get_ruledef()` may return a reconstruction, not the original text.** The catalog stores rules in internal parse-tree form; reconstruction renders cleanly but may rearrange clauses or add explicit casts. Cross-reference [`64-system-catalogs.md`](./64-system-catalogs.md) for `pg_get_*def()` function semantics.

15. **DROP RULE does not cascade to view storage.** Dropping `_RETURN` on a view leaves an empty table-like object with no data and no rules. Use `DROP VIEW` to remove a view cleanly.

16. **Rules cannot reference WITH (CTE) constructs.** A rule's action is a self-contained command, not a CTE. To use CTE-style logic, write a function and have the rule call it (or just use a trigger).

17. **CASCADE rule drops can be surprising.** `DROP RULE r ON t CASCADE` will drop any objects depending on rule `r` — usually nothing, but if other rules reference values computed by `r`, the cascade can be wider than expected. Use `RESTRICT` (the default) and address dependencies explicitly.

18. **Rules do not honor session_replication_role = replica.** Unlike triggers (which have `ENABLE REPLICA TRIGGER` semantics — cross-reference [`39-triggers.md`](./39-triggers.md) gotcha #9), rules cannot be selectively disabled per session_replication_role. Logical-replication apply workers running with `session_replication_role = replica` still fire rules.

19. **Auto-updatable views (PG9.3+) generate auto-updatable rules behind the scenes.** These don't appear in `pg_rewrite` as user-visible rules; they are synthesized by the rewriter at query time. If `is_updatable` says YES but you see no rule in `pg_rewrite` other than `_RETURN`, the view is auto-updatable.

20. **`CREATE OR REPLACE RULE` requires same event type.** You cannot replace an `ON INSERT` rule with an `ON UPDATE` rule using `CREATE OR REPLACE` — drop the original first.

21. **Rules with `INSTEAD` and `RETURNING` interact subtly.** If an `INSERT ... RETURNING` is rewritten via an `INSTEAD` rule, the RETURNING list applies to the *replacement* command's output, not the original. This can surprise application code that expects the original table's columns.

22. **Triggers with transition tables (PG10+) supersede the rules-are-faster-for-bulk argument.** The traditional "use rules instead of triggers for bulk updates" advice predates `REFERENCING NEW TABLE / OLD TABLE`. Statement-level triggers with transition tables now give you set-based once-per-statement semantics with full data access. Cross-reference [`39-triggers.md`](./39-triggers.md) Recipe 4.

23. **The rule system has had zero changes in PG14/15/17/18.** If a tutorial claims rules gained a feature in a recent version, verify against the release notes directly. The only PG14+ rules change is the PG16 manual-`_RETURN` removal, and that is an incompatibility, not a feature.

## See Also

- [`05-views.md`](./05-views.md) — views are the user-facing surface of the rule system; auto-updatable rules, INSTEAD OF triggers, security_barrier, security_invoker
- [`39-triggers.md`](./39-triggers.md) — the modern alternative for DML rewriting; per-row vs per-statement semantics, NEW/OLD records, transition tables, INSTEAD OF
- [`40-event-triggers.md`](./40-event-triggers.md) — DDL-level triggers, not DML; different mechanism than user-table rules
- [`47-row-level-security.md`](./47-row-level-security.md) — purpose-built for row filtering; replaces hand-rolled ON SELECT rules with WHERE clauses for access control
- [`46-roles-privileges.md`](./46-roles-privileges.md) — rules run with table-owner privileges (same as default views)
- [`56-explain.md`](./56-explain.md) — view rewrites appear as substituted subqueries; rules don't appear as plan nodes
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_rewrite` schema, `ev_type` enumeration, `pg_get_ruledef()` and `pg_get_viewdef()`
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — PG16 incompatibility check for manual `_RETURN` rule construction
- [`53-server-configuration.md`](./53-server-configuration.md) — `search_path` and session GUCs that affect rule parsing behavior
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — cross-cutting recipes; rule-and-trigger interaction patterns

## Sources

[^rules-intro]: PostgreSQL 16 documentation, Chapter 41 "The Rule System" (renumbered to Chapter 39 in PG18 due to broader manual reorganization). Verbatim: *"The rule system (more precisely speaking, the query rewrite rule system) is totally different from stored procedures and triggers. It modifies queries to take rules into consideration, and then passes the modified query to the query planner for planning and execution."* and *"It is very powerful, and can be used for many things such as query language procedures, views, and versions."* https://www.postgresql.org/docs/16/rules.html

[^create-rule]: PostgreSQL 16 documentation, `CREATE RULE` reference page. Verbatim grammar plus: *"If neither ALSO nor INSTEAD is specified, ALSO is the default."*, *"INSTEAD indicates that the commands should be executed instead of the original command."*, *"ALSO indicates that the commands should be executed in addition to the original command."*, *"If you actually want an operation that fires independently for each physical row, you probably want to use a trigger, not a rule."*, *"A view that is simple enough to be automatically updatable (see CREATE VIEW) does not require a user-created rule in order to be updatable... Another alternative worth considering is to use INSTEAD OF triggers (see CREATE TRIGGER) in place of rules."*, *"CREATE RULE is a PostgreSQL language extension, as is the entire query rewrite system."* https://www.postgresql.org/docs/16/sql-createrule.html

[^alter-rule]: PostgreSQL 16 documentation, `ALTER RULE` reference page. Verbatim: *"ALTER RULE changes properties of an existing rule. Currently, the only available action is to change the rule's name."* and *"To use ALTER RULE, you must own the table or view that the rule applies to."* Grammar confirmed identical in PG18. https://www.postgresql.org/docs/16/sql-alterrule.html

[^drop-rule]: PostgreSQL 16 documentation, `DROP RULE` reference page. Verbatim: *"DROP RULE drops a rewrite rule."* and *"RESTRICT — Refuse to drop the rule if any objects depend on it. This is the default."* https://www.postgresql.org/docs/16/sql-droprule.html

[^rules-views]: PostgreSQL 16 documentation, section 41.2 "Views and the Rule System". Verbatim: *"Views in PostgreSQL are implemented using the rule system. A view is basically an empty table (having no actual storage) with an ON SELECT DO INSTEAD rule."*, *"Conventionally, that rule is named `_RETURN`."*, *"Rules ON SELECT are applied to all queries as the last step, even if the command given is an INSERT, UPDATE or DELETE. And they have different semantics from rules on the other command types in that they modify the query tree in place instead of creating a new one."*, *"To expand the view, the rewriter simply creates a subquery range-table entry containing the rule's action query tree, and substitutes this range table entry for the original one that referenced the view."*, *"The planner has all the information about which tables have to be scanned plus the relationships between these tables plus the restrictive qualifications from the views plus the qualifications from the original query in one single query tree."*, *"Rules are evaluated first, rewriting the original query before it is planned and executed. Therefore, if a view has INSTEAD OF triggers as well as rules on INSERT, UPDATE, or DELETE, then the rules will be evaluated first, and depending on the result, the triggers may not be used at all."* https://www.postgresql.org/docs/16/rules-views.html

[^rules-update]: PostgreSQL 16 documentation, section 41.4 "Rules on INSERT, UPDATE, and DELETE". Verbatim: *"Finally, if the rule is ALSO, the unchanged original query tree is added to the list. Since only qualified INSTEAD rules already add the original query tree, we end up with either one or two output query trees for a rule with one action."*, *"For ON INSERT rules, the original query (if not suppressed by INSTEAD) is done before any actions added by rules. This allows the actions to see the inserted row(s). But for ON UPDATE and ON DELETE rules, the original query is done after the actions added by rules."*, *"For any reference to NEW, the target list of the original query is searched for a corresponding entry. If found, that entry's expression replaces the reference. Otherwise, NEW means the same as OLD (for an UPDATE) or is replaced by a null value (for an INSERT). Any reference to OLD is replaced by a reference to the range-table entry that is the result relation."*, and the hedge: *"In many cases, tasks that could be performed by rules on INSERT/UPDATE/DELETE are better done with triggers. Triggers are notationally a bit more complicated, but their semantics are much simpler to understand."* https://www.postgresql.org/docs/16/rules-update.html

[^rules-privileges]: PostgreSQL 16 documentation, section 41.5 "Rules and Privileges". Verbatim: *"Rewrite rules don't have a separate owner. The owner of a relation (table or view) is automatically the owner of the rewrite rules that are defined for it."*, *"All relations that are used due to rules get checked against the privileges of the rule owner, not the user invoking the rule. This means that, except for security invoker views, users only need the required privileges for the tables/views that are explicitly named in their queries."*, *"Views cannot be used to reliably conceal the data in unseen rows unless the security_barrier flag has been set."*, *"When it is necessary for a view to provide row-level security, the security_barrier attribute should be applied to the view. This prevents maliciously-chosen functions and operators from being passed values from rows until after the view has done its work."* https://www.postgresql.org/docs/16/rules-privileges.html

[^rules-status]: PostgreSQL 16 documentation, section 41.6 "Rules and Command Status". This page documents how status strings (e.g., `INSERT 0 5`) are returned to the client when rules rewrite commands. It is **not** an anti-patterns or current-limitations section — that framing lives in `rules-triggers.html` and the Notes section of `sql-createrule.html`. https://www.postgresql.org/docs/16/rules-status.html

[^rules-triggers]: PostgreSQL 16 documentation, section 41.7 "Rules Versus Triggers" — the canonical comparison. Verbatim: *"Many things that can be done using triggers can also be implemented using the PostgreSQL rule system. One of the things that cannot be implemented by rules are some kinds of constraints, especially foreign keys."*, *"If checks for valid values are required, and in the case of an invalid value an error message should be generated, it must be done by a trigger."*, *"All of the update rule examples in this chapter can also be implemented using INSTEAD OF triggers on the views. Writing such triggers is often easier than writing rules, particularly if complex logic is required to perform the update."*, *"A trigger is fired once for each affected row. A rule modifies the query or generates an additional query."*, *"So if many rows are affected in one statement, a rule issuing one extra command is likely to be faster than a trigger that is called for every single row and must re-determine what to do many times."*, *"The summary is, rules will only be significantly slower than triggers if their actions result in large and badly qualified joins, a situation where the planner fails."*, *"However, the trigger approach is conceptually far simpler than the rule approach, and is easier for novices to get right."* https://www.postgresql.org/docs/16/rules-triggers.html

[^pg16-remove]: PostgreSQL 16.0 release notes, Migration to Version 16 / Incompatibilities section. Verbatim: *"Remove the ability to create views manually with ON SELECT rules (Tom Lane)."* The internal `_RETURN` rule that `CREATE VIEW` produces is unchanged; only the manual-construction path (attaching an `ON SELECT DO INSTEAD` rule by hand to an empty table) was removed. Commit reference: postgr.es/c/b23cd185f. https://www.postgresql.org/docs/release/16.0/

[^pg14-release]: PostgreSQL 14.0 release notes — confirmed by direct fetch to contain **zero** rules-system-related items. https://www.postgresql.org/docs/release/14.0/

[^pg15-release]: PostgreSQL 15.0 release notes — confirmed by direct fetch to contain **zero** rules-system-related items. https://www.postgresql.org/docs/release/15.0/

[^pg17-release]: PostgreSQL 17.0 release notes — confirmed by direct fetch to contain **zero** rules-system-related items. https://www.postgresql.org/docs/release/17.0/

[^pg18-release]: PostgreSQL 18.0 release notes — confirmed by direct fetch to contain **zero** rules-system-related items. The rules chapter was renumbered from chapter 41 (PG16) to chapter 39 (PG18) due to broader manual reorganization, but the content is byte-identical. https://www.postgresql.org/docs/release/18.0/

[^create-view-rules]: PostgreSQL 16 documentation, `CREATE VIEW` reference page. Verbatim: *"If the view or any of its base relations has an INSTEAD rule that causes the INSERT or UPDATE command to be rewritten, then all check options will be ignored in the rewritten query, including any checks from automatically updatable views defined on top of the relation with the INSTEAD rule."* and *"You can get the effect of an updatable view by creating INSTEAD OF triggers on the view, which must convert attempted inserts, etc. on the view into appropriate actions on other tables. For more information see CREATE TRIGGER. Another possibility is to create rules (see CREATE RULE), but in practice triggers are easier to understand and use correctly."* https://www.postgresql.org/docs/16/sql-createview.html

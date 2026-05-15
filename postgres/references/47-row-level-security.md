# Row-Level Security



## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Mental Model — Five Rules](#mental-model--five-rules)
    - [Decision Matrix](#decision-matrix)
    - [Enabling and Disabling RLS](#enabling-and-disabling-rls)
    - [CREATE POLICY Grammar](#create-policy-grammar)
    - [PERMISSIVE vs RESTRICTIVE](#permissive-vs-restrictive)
    - [USING vs WITH CHECK](#using-vs-with-check)
    - [FOR Command Variants](#for-command-variants)
    - [TO Role Targeting](#to-role-targeting)
    - [Multi-Policy Combination](#multi-policy-combination)
    - [Default-Deny Policy](#default-deny-policy)
    - [BYPASSRLS and Owner Bypass](#bypassrls-and-owner-bypass)
    - [FORCE ROW LEVEL SECURITY](#force-row-level-security)
    - [row_security GUC and pg_dump](#row_security-guc-and-pg_dump)
    - [Views and RLS](#views-and-rls)
    - [Replication and RLS](#replication-and-rls)
    - [ALTER POLICY and DROP POLICY](#alter-policy-and-drop-policy)
    - [Inspecting Policies](#inspecting-policies)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)



## When to Use This Reference

Reach for this file when you are:

- Building multi-tenant tables where every query must be scoped to the caller's tenant.
- Adding row-visibility filters that survive ad-hoc SQL access — not just application-layer checks.
- Mixing `PERMISSIVE` (additive) and `RESTRICTIVE` (subtractive) policies and need the combining rules.
- Writing an `INSERT` / `UPDATE` policy and deciding whether you want `USING`, `WITH CHECK`, or both.
- Investigating why a query returns fewer rows than expected — RLS silently drops invisible rows.
- Granting `BYPASSRLS` for a backup / monitoring / replication role, or wondering if a maintenance role inherits the exemption.
- Switching a view's RLS behavior from owner-context to caller-context via `security_invoker` (PG15+).
- Running `pg_dump` and seeing it fail with `row security policy is enabled` — `row_security = off` is *not* a bypass.
- Working with logical replication into a target with RLS enabled (PG15+ subscription owner rules).

> [!NOTE] RLS has been remarkably stable across five PG majors
> PG14, PG16, and PG17 had **zero** RLS-related release-note items. PG15 had one narrow item — logical replication runs as the subscription owner and **row-level security policies are not checked**, so only superusers, `BYPASSRLS` roles, and table owners can replicate into RLS-protected tables.[^pg15-logrep] PG18 added a `--no-policies` flag to `pg_dump` / `pg_dumpall` / `pg_restore` for stripping RLS from dumps[^pg18-no-policies]. The core mechanics (policies, `USING`, `WITH CHECK`, `PERMISSIVE`/`RESTRICTIVE`, `FORCE ROW LEVEL SECURITY`, `BYPASSRLS`) are byte-identical across PG14 through PG18. If a tutorial claims a recent PG version "improved" RLS performance, the planner may have improved but the surface did not — verify against release notes directly.

This file is the SQL surface for RLS policies. Role attributes (including `BYPASSRLS` mechanics) live in [`46-roles-privileges.md`](./46-roles-privileges.md). View interaction details (`security_invoker` PG15+, `security_barrier`) live in [`05-views.md`](./05-views.md). Authentication is [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md). Audit logging is [`51-pgaudit.md`](./51-pgaudit.md).



## Syntax / Mechanics


### Mental Model — Five Rules

1. **RLS is per-table opt-in.** A table has no policies by default; any role with table-level `SELECT` / `INSERT` / `UPDATE` / `DELETE` privilege gets every row.[^ddl-rls] Policies only apply once you run `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. Without enabling, `CREATE POLICY` rows sit in `pg_policy` and do nothing — silently.

2. **`PERMISSIVE` policies are OR-combined; `RESTRICTIVE` policies are AND-combined.** Default is `PERMISSIVE`. Verbatim docs rule: *"All permissive policies which are applicable to a given query will be combined together using the Boolean 'OR' operator ... All restrictive policies which are applicable to a given query will be combined together using the Boolean 'AND' operator."*[^createpolicy-perm] Practical consequence: you cannot deny access by adding more permissive policies — only by switching to restrictive or revoking grants.

3. **`USING` controls visibility; `WITH CHECK` controls what writes are allowed.** `USING` is checked against rows being read or matched (`SELECT`, `UPDATE-WHERE`, `DELETE-WHERE`). `WITH CHECK` is checked against rows after a write (`INSERT` new row, `UPDATE` post-modification row). Verbatim: *"Existing table rows are checked against the expression specified in USING, while new rows that would be created via INSERT or UPDATE are checked against the expression specified in WITH CHECK."*[^createpolicy-desc] Rule of thumb: a violated `USING` silently drops the row from view; a violated `WITH CHECK` raises an error.

4. **Table owners bypass their own table's RLS by default.** Superusers and `BYPASSRLS` roles always bypass. Verbatim docs rule: *"Superusers and roles with the BYPASSRLS attribute always bypass the row security system when accessing a table. Table owners normally bypass row security as well, though a table owner can choose to be subject to row security with ALTER TABLE ... FORCE ROW LEVEL SECURITY."*[^ddl-rls] If your application role *owns* the table, your policies never fire against it.

5. **`row_security = off` does not bypass RLS — it raises an error if filtering would happen.** Setting the GUC to `off` is a *safety check*, not a permission. Verbatim docs: *"This does not in itself bypass row security; what it does is throw an error if any query's results would get filtered by a policy."*[^ddl-rls] This is what `pg_dump` does by default to refuse silently-incomplete dumps.


### Decision Matrix

| You want to... | Use | Avoid | Why |
|---|---|---|---|
| Multi-tenant table where every row carries `tenant_id` | RLS policy `USING (tenant_id = current_setting('app.tenant_id')::int)` | Application-layer WHERE only | Survives ad-hoc SQL and ORM bypasses |
| Allow user to see only their own rows | RLS `FOR ALL TO PUBLIC USING (owner = current_user)` | Trigger-based filter | Triggers can't filter `SELECT` |
| Combine "tenant filter" with "admin override" | Two `PERMISSIVE` policies (OR-combined) | One mega-policy with `OR` | Easier to audit; admin policy `TO admin_role` |
| Enforce "no row may exceed X regardless of who writes" | One `RESTRICTIVE` policy gating writes | More permissive policies | Restrictive AND-combines: subtractive |
| Audit-only role that reads everything | Grant `pg_read_all_data` predefined role OR `BYPASSRLS` | A wide-open permissive policy | Predefined role audits clearly; avoids policy sprawl |
| Application owns the table AND needs RLS | `ALTER TABLE ... FORCE ROW LEVEL SECURITY` | Letting the owner bypass | Without FORCE, the app role sees everything |
| Prevent `pg_dump` from silently dropping rows | Default is correct (`row_security=off` raises an error) | Setting `row_security=on` in dump session | The error surfaces unintended filtering |
| Strip RLS from a dump (PG18+) | `pg_dump --no-policies` | Manually editing dump SQL | PG18+ supported tooling[^pg18-no-policies] |
| Make a view enforce caller's RLS, not owner's | `WITH (security_invoker = true)` view (PG15+) | A `security_barrier` view alone | `security_invoker` reads as the caller[^createview-invoker] |
| Logical replication INTO an RLS table | Subscription owner has `BYPASSRLS` OR is table owner | Plain non-bypass subscription role | Verbatim: policies not checked, copy fails for non-bypass non-owner[^pg15-logrep] |
| Quick RLS escape hatch for one query | `SET row_security = on/off` per-session | `BYPASSRLS` as a permanent attribute | Use GUC for diagnostics, attribute for service accounts |
| Detect missing RLS on a "should be secured" table | Audit `pg_class.relrowsecurity = false` | Manual review | See Recipe 11 |

Three smell signals that you reached for RLS but should not have:

- **The policy expression calls a slow function on every row.** RLS evaluates per-row. Use a CHECK constraint or trigger if the expression is value-derivable.
- **You added `BYPASSRLS` to every service account.** That's a sign your tenancy model lives in the application layer; RLS is providing no value. Pick one — drop RLS or remove the bypasses.
- **You disabled RLS to make migrations work.** Migrations should run as a role that owns the table (and bypasses by default) or has `BYPASSRLS`. Disabling RLS during DDL is operationally fragile.


### Enabling and Disabling RLS

```sql
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events DISABLE ROW LEVEL SECURITY;
```

Verbatim docs rule: *"These forms control the application of row security policies belonging to the table. If enabled and no policies exist for the table, then a default-deny policy is applied. Note that policies can exist for a table even if row-level security is disabled. In this case, the policies will not be applied and the policies will be ignored."*[^altertable-rls]

Two operational consequences:

1. **Enabling without creating a policy locks everyone out** except the owner and `BYPASSRLS` roles. The default policy is **deny-all**.
2. **Disabling does not delete policies.** They remain in `pg_policy` and re-activate the moment you re-enable. `DROP POLICY` is the only way to remove them.

`ENABLE`/`DISABLE` and `FORCE`/`NO FORCE` are independent toggles. The four states form a small matrix:

| `ENABLE`? | `FORCE`? | Effect on owner | Effect on non-owner (non-bypass) |
|---|---|---|---|
| `DISABLE` | (any) | No filtering | No filtering |
| `ENABLE` | `NO FORCE` (default) | No filtering — owner bypass | Policies apply |
| `ENABLE` | `FORCE` | Policies apply to owner too | Policies apply |


### CREATE POLICY Grammar

Verbatim full synopsis from PG16 docs:[^createpolicy-syn]

```sql
CREATE POLICY name ON table_name
    [ AS { PERMISSIVE | RESTRICTIVE } ]
    [ FOR { ALL | SELECT | INSERT | UPDATE | DELETE } ]
    [ TO { role_name | PUBLIC | CURRENT_ROLE | CURRENT_USER | SESSION_USER } [, ...] ]
    [ USING ( using_expression ) ]
    [ WITH CHECK ( check_expression ) ]
```

Verbatim docs description: *"The CREATE POLICY command defines a new row-level security policy for a table. Note that row-level security must be enabled on the table (using ALTER TABLE ... ENABLE ROW LEVEL SECURITY) in order for created policies to be applied."*[^createpolicy-desc]

Four rules to remember:

1. **Policies are named.** The name is unique per (table, command), not globally per database. Two policies named `tenant_read` on different tables are independent.
2. **`OR REPLACE` is not supported on `CREATE POLICY`.** You must `DROP POLICY ... IF EXISTS` then `CREATE` or use `ALTER POLICY`.
3. **`USING` and `WITH CHECK` are independent expressions.** Omit either where it does not apply (see below).
4. **The policy expression cannot contain aggregates or window functions.** Verbatim: *"The conditional expression cannot contain any aggregate or window functions."*[^createpolicy-using]


### PERMISSIVE vs RESTRICTIVE

PG10 added the distinction[^ddl-rls]; the file's PG16+ era uses both heavily.

**PERMISSIVE (default):** *"All permissive policies which are applicable to a given query will be combined together using the Boolean 'OR' operator. By creating permissive policies, administrators can add to the set of records which can be accessed. Policies are permissive by default."*[^createpolicy-perm]

**RESTRICTIVE:** *"All restrictive policies which are applicable to a given query will be combined together using the Boolean 'AND' operator. By creating restrictive policies, administrators can reduce the set of records which can be accessed as all restrictive policies must be passed for each record."*[^createpolicy-rest]

The critical combining rule, verbatim: *"Note that there needs to be at least one permissive policy to grant access to records before restrictive policies can be usefully used to reduce that access. If only restrictive policies exist, then no records will be accessible. When a mix of permissive and restrictive policies are present, a record is only accessible if at least one of the permissive policies passes, in addition to all the restrictive policies."*[^createpolicy-rest]

Mental model — a row is visible to the caller iff:

```
( P1_USING OR P2_USING OR ... )   [at least one permissive]
   AND
( R1_USING AND R2_USING AND ... ) [every restrictive]
```

If there are zero permissive policies, the OR-chain is empty (false) and **no row is visible** regardless of restrictive policies. Gotcha #2 expands on this.


### USING vs WITH CHECK

The four-row asymmetric rule:

| Command | `USING` evaluated against | `WITH CHECK` evaluated against | What failure means |
|---|---|---|---|
| `SELECT` | existing row | (not allowed) | Row silently invisible |
| `INSERT` | (not allowed) | proposed new row | `new row violates row-level security policy` error |
| `UPDATE` | existing row (matching `WHERE`) | proposed new row (post-update) | `USING` → row not eligible for update; `WITH CHECK` → error |
| `DELETE` | existing row (matching `WHERE`) | (not allowed) | Row not eligible for delete |

Verbatim docs:

- *"A SELECT policy cannot have a WITH CHECK expression, as it only applies in cases where records are being retrieved from the relation."*[^createpolicy-select]
- *"An INSERT policy cannot have a USING expression, as it only applies in cases where records are being added to the relation."*[^createpolicy-insert]
- *"Since an UPDATE command involves pulling an existing record and replacing it with a new modified record, UPDATE policies accept both a USING expression and a WITH CHECK expression. The USING expression determines which records the UPDATE command will see to operate against, while the WITH CHECK expression defines which modified rows are allowed to be stored back into the relation."*[^createpolicy-update]
- *"For a DELETE command, only rows that pass this policy will be seen by the DELETE command."*[^createpolicy-delete]

Verbatim error/silent-drop distinction: *"When a USING expression returns true for a given row then that row is visible to the user, while if false or null is returned then the row is not visible. Typically, no error occurs when a row is not visible ... When a WITH CHECK expression returns true for a row then that row is inserted or updated, while if false or null is returned then an error occurs."*[^createpolicy-desc]

`WITH CHECK` is also evaluated against the post-UPDATE row, not the pre-UPDATE row: *"the check_expression is evaluated against the proposed new contents of the row, not the original contents."*[^createpolicy-using]


### FOR Command Variants

Five command keywords:

- **`FOR ALL`** — applies to every command. Verbatim: *"If an ALL policy exists and more specific policies exist, then both the ALL policy and the more specific policy (or policies) will be applied. Additionally, ALL policies will be applied to both the selection side of a query and the modification side, using the USING expression for both cases if only a USING expression has been defined."*[^createpolicy-all] Practically: an `ALL` policy with only `USING` makes that expression do double duty as the `WITH CHECK` for writes.
- **`FOR SELECT`** — `USING` only.
- **`FOR INSERT`** — `WITH CHECK` only.
- **`FOR UPDATE`** — both `USING` and `WITH CHECK`.
- **`FOR DELETE`** — `USING` only.

Two policies of different `FOR` types do not OR-combine in the way two `FOR SELECT` policies do — they apply to *disjoint* operations. A `FOR SELECT` policy and a `FOR INSERT` policy both being present means SELECT queries use the first, INSERT statements use the second, never both.

The exception is `FOR ALL` + a more-specific policy: both apply to the matched command, OR-combined as permissive.


### TO Role Targeting

Verbatim docs default: *"The default is PUBLIC, which will apply the policy to all roles."*[^createpolicy-to]

Policies can be scoped to one role, several roles (comma-separated), or `PUBLIC`. The role match uses *direct + inherited* membership: a role inherits a policy granted to any role it is a member of (under standard `INHERIT`). Useful patterns:

- Tenant-scoped policy `TO PUBLIC` (everyone is filtered) plus an override policy `TO admins` (admin role sees everything).
- Separate `FOR SELECT TO reader` and `FOR ALL TO writer` policies so reader cannot write.
- Audit-only role with policy `TO auditor USING (true)` to make the filtering explicit even though it returns all rows.


### Multi-Policy Combination

Three operational rules pulling together the per-mode and PERMISSIVE/RESTRICTIVE rules:

1. **Within one command type**, all applicable permissive policies are OR-combined, and the result must AND with every applicable restrictive policy.
2. **`FOR ALL` policies apply to every command** AND are OR-combined with the command-specific permissive policies for that command.
3. **A `FOR UPDATE` policy's `USING` matches existing rows; its `WITH CHECK` is also OR-combined separately for the post-UPDATE row.** If a `FOR ALL` policy with only `USING` is in play, that `USING` becomes the implicit `WITH CHECK` for the update.

The decision is operational: write one permissive policy per *tenant boundary* (or per *user-data-scope*), then add `RESTRICTIVE` policies to enforce cross-cutting rules ("no row may have status='draft' if approval_level < 2").


### Default-Deny Policy

If `ROW LEVEL SECURITY` is enabled and **no policy applies to the current command + role**, RLS denies access entirely. The verbatim rule: *"If enabled and no policies exist for the table, then a default-deny policy is applied."*[^altertable-rls]

Three operational situations where this surfaces:

- **You enabled RLS before creating policies.** All non-bypass non-owner queries return zero rows / fail to write until the first policy is created.
- **Your policy was `FOR SELECT` only.** `INSERT`/`UPDATE`/`DELETE` are denied by default — you need explicit policies for write operations.
- **You dropped the last policy.** From `DROP POLICY` docs verbatim: *"Note that if the last policy is removed for a table and the table still has row-level security enabled via ALTER TABLE, then the default-deny policy will be used."*[^droppolicy] Verify the last-policy state before dropping in production.


### BYPASSRLS and Owner Bypass

Three classes of bypass:

| Bypass class | Always bypasses? | How to grant |
|---|---|---|
| Superuser | Yes — bypasses RLS, privileges, FK, CHECK, everything | `CREATE ROLE … SUPERUSER` |
| `BYPASSRLS` role | Yes — bypasses RLS only, still subject to grants | `CREATE ROLE … BYPASSRLS` (PG9.5+) |
| Table owner | Yes by default — unless `FORCE ROW LEVEL SECURITY` is set on the table | Implicit on ownership |

Verbatim BYPASSRLS docs: *"BYPASSRLS / NOBYPASSRLS — These clauses determine whether a role bypasses every row-level security (RLS) policy. NOBYPASSRLS is the default. Only superuser roles or roles with BYPASSRLS can specify BYPASSRLS."*[^createrole-bypassrls]

Three operational consequences:

1. **`BYPASSRLS` is orthogonal to grants.** A `BYPASSRLS` role still needs `SELECT` on the table to read it. The attribute only skips the policy filter — it does not grant access.
2. **`BYPASSRLS` must be granted by a superuser or another `BYPASSRLS` role.** Pre-PG16, a `CREATEROLE`-having role could grant `BYPASSRLS`; PG16 narrowed this — the granting role must have `BYPASSRLS` itself.[^pg16-createrole] See [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #8.
3. **Owner bypass is invisible.** There's no error or warning when an owner reads through RLS — they just see every row. Tests that pass as the table owner may fail as a non-owner.

Verbatim docs on pg_dump + BYPASSRLS: *"Note that pg_dump will set row_security to OFF by default, to ensure all contents of a table are dumped out. If the user running pg_dump does not have appropriate permissions, an error will be returned. However, superusers and the owner of the table being dumped always bypass RLS."*[^createrole-bypassrls]


### FORCE ROW LEVEL SECURITY

```sql
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE events NO FORCE ROW LEVEL SECURITY;
```

Verbatim docs: *"These forms control the application of row security policies belonging to the table when the user is the table owner. If enabled, row-level security policies will be applied when the user is the table owner. If disabled (the default) then row-level security will not be applied when the user is the table owner."*[^altertable-rls]

When to reach for `FORCE`:

- The application user that runs DML *is* the table owner (common in single-role app deployments). Without `FORCE`, RLS does nothing.
- You want defense-in-depth and don't trust the "owner won't run risky SQL" assumption.

When *not* to reach for `FORCE`:

- Operational scripts running as the owner (`REINDEX`, `pg_repack`, partition rotation) — they'll be filtered by RLS, which is rarely what you want. Either separate the role or use `BYPASSRLS` for that role.


### row_security GUC and pg_dump

Verbatim docs: *"In some contexts it is important to be sure that row security is not being applied. For example, when taking a backup, it could be disastrous if row security silently caused some rows to be omitted from the backup. In such a situation, you can set the row_security configuration parameter to off. This does not in itself bypass row security; what it does is throw an error if any query's results would get filtered by a policy."*[^ddl-rls]

The three values:

| `row_security` | Behavior on RLS-protected table |
|---|---|
| `on` (default) | Policies apply; rows silently filtered |
| `off` | Error raised if any policy would filter; otherwise pass-through |
| (per-session `SET`) | Use `off` to *verify* you're seeing every row; use `on` for normal queries |

Two operational consequences:

1. **`pg_dump` sets `row_security = off` automatically.** If the dumping role can bypass RLS (superuser, table owner, `BYPASSRLS`), the dump completes. Otherwise the dump errors out. This is intentional: better to fail loudly than to silently dump a partial table.
2. **PG18 added `--no-policies`** to `pg_dump`, `pg_dumpall`, and `pg_restore`. Verbatim release-note: *"Add option `--no-policies` to disable row level security policy processing in pg_dump, pg_dumpall, pg_restore."*[^pg18-no-policies] Use this when migrating an RLS-protected schema to a target where RLS will be configured separately (e.g., during dev environment refresh).


### Views and RLS

Two view security attributes interact with RLS. Verbatim docs on the `security_barrier` interaction with RLS: *"When it is necessary for a view to provide row-level security, the security_barrier attribute should be applied to the view. This prevents maliciously-chosen functions and operators from being passed values from rows until after the view has done its work."*[^rules-privileges]

PG15+ added `security_invoker`. Verbatim docs: *"If any of the underlying base relations has row-level security enabled, then by default, the row-level security policies of the view owner are applied, and access to any additional relations referred to by those policies is determined by the permissions of the view owner. However, if the view has security_invoker set to true, then the policies and permissions of the invoking user are used instead, as if the base relations had been referenced directly from the query using the view."*[^createview-invoker]

Three-row decision table:

| View attribute | RLS evaluated for | When to use |
|---|---|---|
| Default (no `security_invoker`) | View owner | Owner = trusted role that should see everything; view is a controlled aperture |
| `WITH (security_invoker = true)` (PG15+) | View caller | View is just a query alias; per-caller RLS should still apply |
| `WITH (security_barrier = true)` | (orthogonal) | Prevents leaky operators from seeing pre-filter rows; combine with either model |

Note that views inherit policies from their **base tables**, not from themselves — you cannot `CREATE POLICY` on a view. The base table is what gets enabled, and the view either evaluates as the owner (default) or the caller (`security_invoker = true`).

PG15 cross-reference: [`05-views.md`](./05-views.md) covers the full grammar and rule mechanics.


### Replication and RLS

Verbatim PG15 release note: *"Allow logical replication to run as the owner of the subscription (Mark Dilger). Because row-level security policies are not checked, only superusers, roles with bypassrls, and table owners can replicate into tables with row-level security policies."*[^pg15-logrep]

Three operational consequences for logical replication:

1. **The subscription owner must be `BYPASSRLS`, the table owner, or superuser.** Otherwise apply fails on RLS-protected target tables.
2. **Policies on the source publisher are *not* replicated.** Logical replication ships row changes, not DDL. If the target schema has RLS configured, configure it separately on the target.
3. **For physical streaming replication, RLS is irrelevant on the standby in normal operation** — the standby is read-only and replays bytes verbatim; queries on the standby still apply RLS as on the primary.


### ALTER POLICY and DROP POLICY

Verbatim `ALTER POLICY` synopsis:[^alterpolicy-syn]

```sql
ALTER POLICY name ON table_name RENAME TO new_name;

ALTER POLICY name ON table_name
    [ TO { role_name | PUBLIC | CURRENT_ROLE | CURRENT_USER | SESSION_USER } [, ...] ]
    [ USING ( using_expression ) ]
    [ WITH CHECK ( check_expression ) ];
```

Verbatim: *"ALTER POLICY only allows the set of roles to which the policy applies and the USING and WITH CHECK expressions to be modified. To change other properties of a policy, such as the command to which it applies or whether it is permissive or restrictive, the policy must be dropped and recreated."*[^alterpolicy-desc]

Practical consequence: changing `FOR SELECT` → `FOR ALL` or `PERMISSIVE` → `RESTRICTIVE` requires a `DROP POLICY` + `CREATE POLICY` sequence. Plan for the brief window where the policy doesn't exist — wrap in a transaction or accept that the default-deny may apply if the table has no other policies covering that command.

`DROP POLICY` synopsis: `DROP POLICY [ IF EXISTS ] name ON table_name [ CASCADE | RESTRICT ];`[^droppolicy]


### Inspecting Policies

The `pg_policies` view exposes all policies in a queryable form:

```sql
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

The `qual` column is the `USING` expression text; `with_check` is the `WITH CHECK` expression text. The `cmd` column is `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `ALL`.

`pg_class.relrowsecurity` is true if RLS is `ENABLE`d. `pg_class.relforcerowsecurity` is true if `FORCE ROW LEVEL SECURITY` is set. Useful audit:

```sql
SELECT n.nspname, c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY rls_enabled DESC, n.nspname, c.relname;
```


### Per-Version Timeline

| Version | RLS-related changes | Source |
|---|---|---|
| **PG9.5** | RLS introduced (`CREATE POLICY`, `ENABLE ROW LEVEL SECURITY`, `BYPASSRLS`). | Historical — predates the 14+ window. |
| **PG10** | `PERMISSIVE` / `RESTRICTIVE` distinction added. `FORCE ROW LEVEL SECURITY`. | Historical. |
| **PG14** | **Zero** RLS-related release-note items. | Direct fetch. |
| **PG15** | Logical replication runs as subscription owner; verbatim: policies not checked, copy fails for non-bypass non-owner.[^pg15-logrep] Also `security_invoker` view attribute (PG15+) — RLS context becomes caller, not owner.[^createview-invoker] | E.18.2 release notes. |
| **PG16** | Zero direct RLS items. CREATEROLE narrowed so that granting `BYPASSRLS` now requires the grantor to have `BYPASSRLS`.[^pg16-createrole] Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md). | E.4 release notes. |
| **PG17** | **Zero** RLS-related release-note items. | Direct fetch. |
| **PG18** | `pg_dump --no-policies` / `pg_dumpall --no-policies` / `pg_restore --no-policies` added.[^pg18-no-policies] | E.4.3.7.1 release notes. |



## Examples / Recipes


### Recipe 1 — Multi-tenant baseline with session GUC

The canonical multi-tenant RLS pattern: every row carries `tenant_id`; the app sets a session GUC at connection time; one policy filters every read and write.

```sql
CREATE TABLE events (
    id          bigserial PRIMARY KEY,
    tenant_id   int NOT NULL,
    payload     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON events (tenant_id, created_at DESC);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Session GUC pattern — app sets this on connection checkout.
CREATE POLICY events_tenant_isolation
    ON events
    FOR ALL
    TO PUBLIC
    USING  (tenant_id = current_setting('app.tenant_id', true)::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);

-- On each new connection, the app runs:
-- SET app.tenant_id = '42';
```

The `true` second argument to `current_setting` returns NULL instead of erroring if the GUC is unset — important because `false OR NULL = NULL`, which a `USING` clause treats as "row not visible." So an unset GUC silently denies all rows rather than crashing — much safer than the alternative.

If the table owner runs the app, add `FORCE` so the owner is subject to RLS:

```sql
ALTER TABLE events FORCE ROW LEVEL SECURITY;
```


### Recipe 2 — Layered permissive policies (tenant + admin override)

Two permissive policies OR-combine. A regular caller sees only their tenant's rows; an admin role sees everything:

```sql
CREATE POLICY events_tenant_isolation
    ON events
    FOR ALL
    TO PUBLIC
    USING (tenant_id = current_setting('app.tenant_id', true)::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY events_admin_full_access
    ON events
    FOR ALL
    TO admin_role
    USING  (true)
    WITH CHECK (true);
```

When a member of `admin_role` runs `SELECT * FROM events`, the combined permissive `USING` is `(tenant_id = X) OR true = true`. The admin sees everything. A non-admin gets only the tenant filter.

The `TO admin_role` clause means policy 2 is only *applicable* to admin role members — non-admins don't even see it in the OR-combination.


### Recipe 3 — Restrictive policy enforcing a cross-cutting rule

A `RESTRICTIVE` policy AND-combines with whatever permissive policies allowed the row through. Use it to enforce a global constraint that should never be bypassed:

```sql
-- Permissive: each user sees their own org's data.
CREATE POLICY org_isolation
    ON contracts
    FOR ALL
    USING  (org_id = current_setting('app.org_id', true)::int)
    WITH CHECK (org_id = current_setting('app.org_id', true)::int);

-- Restrictive: even within your org, draft contracts are hidden from non-managers.
CREATE POLICY hide_drafts_from_non_managers
    ON contracts
    AS RESTRICTIVE
    FOR SELECT
    USING (
        status <> 'draft'
        OR EXISTS (
            SELECT 1 FROM org_members
            WHERE user_id = current_setting('app.user_id', true)::int
              AND role = 'manager'
        )
    );
```

Drafts are gated AND-combined: the row must pass both the org-isolation permissive policy AND the draft-visibility restrictive policy. Adding more permissive policies later cannot weaken the restrictive policy — exactly what "restrictive" means.


### Recipe 4 — Soft-delete with RLS

Hide soft-deleted rows from normal queries; allow an admin role to see them. The visibility rule is row-data-derivable:

```sql
ALTER TABLE accounts ADD COLUMN deleted_at timestamptz;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_hide_deleted
    ON accounts
    FOR SELECT
    TO PUBLIC
    USING (deleted_at IS NULL);

CREATE POLICY accounts_admin_sees_deleted
    ON accounts
    FOR SELECT
    TO admin_role
    USING (true);

-- Application performs UPDATE accounts SET deleted_at = now() WHERE id = $1;
-- (Need an UPDATE policy for that — separate.)
CREATE POLICY accounts_owner_can_update
    ON accounts
    FOR UPDATE
    TO PUBLIC
    USING  (owner_id = current_setting('app.user_id', true)::int)
    WITH CHECK (owner_id = current_setting('app.user_id', true)::int);
```

This approach survives ad-hoc SQL access through any tool — the policy is enforced regardless of query source.


### Recipe 5 — Per-user table with `current_user`

If your tenancy boundary is the database user itself (rare but legitimate for internal tools):

```sql
CREATE TABLE personal_notes (
    id     bigserial PRIMARY KEY,
    owner  name NOT NULL DEFAULT current_user,
    note   text
);

ALTER TABLE personal_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY notes_owner_only
    ON personal_notes
    FOR ALL
    TO PUBLIC
    USING  (owner = current_user)
    WITH CHECK (owner = current_user);
```

`current_user` returns the *effective* role after `SET ROLE`, so this composes with role-based access patterns. `session_user` would return the originally-authenticated role.


### Recipe 6 — INSERT-only policy with WITH CHECK

Audit-log pattern: anyone can insert, no one can update or delete, only auditors can read:

```sql
CREATE TABLE audit_log (
    id        bigserial PRIMARY KEY,
    actor     name NOT NULL DEFAULT current_user,
    event     jsonb NOT NULL,
    occurred  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (WITH CHECK forces actor to be current_user — prevents impersonation).
CREATE POLICY audit_log_insert_anyone
    ON audit_log
    FOR INSERT
    TO PUBLIC
    WITH CHECK (actor = current_user);

-- Only auditors can read.
CREATE POLICY audit_log_read_auditor
    ON audit_log
    FOR SELECT
    TO auditor_role
    USING (true);

-- No UPDATE or DELETE policies at all — default-deny applies.
```

Note: the lack of UPDATE/DELETE policies means even the auditor cannot delete rows. That's intentional for audit logs. If you need cleanup, run as the table owner (default bypass) or `BYPASSRLS` via a separate retention job.


### Recipe 7 — Force RLS on owner-app pattern

Common deployment: the application connects as `app_user`, which is also the table owner. Without `FORCE`, RLS doesn't apply to the app at all:

```sql
ALTER TABLE events OWNER TO app_user;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;  -- <-- critical
```

Without `FORCE`, the policies are dormant for the owning role. Verify:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname = 'events';
-- expect: rls_enabled=t, rls_forced=t
```


### Recipe 8 — Test policies via SET ROLE inside a transaction

Don't deploy RLS without testing what each role sees:

```sql
BEGIN;
SET LOCAL ROLE alice;
SELECT count(*) FROM events;   -- what does alice see?
RESET ROLE;
SET LOCAL ROLE bob;
SELECT count(*) FROM events;   -- what does bob see?
ROLLBACK;
```

`SET LOCAL` ensures the role change doesn't escape the transaction. `BEGIN ... ROLLBACK` ensures no test data leaks.

For policies depending on a session GUC:

```sql
BEGIN;
SET LOCAL app.tenant_id = '42';
SET LOCAL ROLE webapp;
SELECT count(*) FROM events;
ROLLBACK;
```


### Recipe 9 — Bypass RLS for a backup or maintenance job

Don't grant `SUPERUSER` to backup roles. Use `BYPASSRLS` plus the minimum table grants:

```sql
CREATE ROLE backup_role WITH LOGIN BYPASSRLS PASSWORD '...';
GRANT pg_read_all_data TO backup_role;
-- backup_role can now read every row of every table for pg_dump.
```

`pg_read_all_data` (PG14+) gives implicit `SELECT` on all tables; `BYPASSRLS` ensures policies don't filter. The combination is the right pattern for unattended backup roles. Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md) recipe 8.


### Recipe 10 — Use `row_security = off` to detect filtered data

Set the session GUC to `off` to verify your query sees every row:

```sql
SET row_security = off;
SELECT count(*) FROM accounts;
-- If RLS would filter, this raises:
-- ERROR: query would be affected by row-level security policy for table "accounts"
```

The error signals that RLS *would* filter; switch the role or get `BYPASSRLS` to access. Don't catch the error and retry with `on` — that defeats the safety check.


### Recipe 11 — Audit query for tables missing RLS

Find tables that should be RLS-protected but aren't. This is a policy-and-process question, but the catalog query helps:

```sql
SELECT n.nspname AS schema,
       c.relname AS table,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY rls_enabled, n.nspname, c.relname;
```

Three rows are suspicious:

- `rls_enabled = true` with `policy_count = 0` — table is locked out (default-deny applies).
- `rls_enabled = false` with `policy_count > 0` — dormant policies will activate the moment someone enables RLS.
- Tables in your tenant-data schemas with `rls_enabled = false` — should probably have policies.


### Recipe 12 — Inspect existing policies with `pg_policies`

```sql
SELECT schemaname, tablename, policyname, permissive,
       array_to_string(roles, ', ') AS roles,
       cmd,
       qual AS using_expr,
       with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

The view is a read-only convenience over `pg_policy` joined with `pg_class` and `pg_namespace`. Use it to dump policy state for review, code review diffs, or migration scripts.


### Recipe 13 — security_invoker view as caller-context aperture (PG15+)

A view over an RLS table normally evaluates RLS as the *view owner*. PG15+ `security_invoker` flips that:

```sql
CREATE VIEW my_events
    WITH (security_invoker = true, security_barrier = true)
    AS SELECT id, payload, created_at FROM events;
```

A caller `alice` querying `my_events` triggers RLS evaluation as alice, not as the view owner — exactly as if alice had run `SELECT ... FROM events` directly. Combined with `security_barrier`, leaky operators can't see pre-filter rows. Cross-ref [`05-views.md`](./05-views.md).


### Recipe 14 — Migrate a dump across environments using `--no-policies` (PG18+)

PG18+ allows stripping RLS from dump and restore. Useful for dev-environment refreshes where policies will be re-applied separately by migrations:

```bash
# PG18+
pg_dump --no-policies -Fc -d prod_db -f prod.dump
pg_restore --no-policies -d dev_db prod.dump
```

Pre-PG18 you must edit the dump SQL by hand or restore everything and `DROP POLICY` post-hoc. Cross-ref [`83-backup-pg-dump.md`](./83-backup-pg-dump.md).



## Gotchas / Anti-patterns

1. **`ENABLE ROW LEVEL SECURITY` without any policy = default-deny.** All non-bypass non-owner queries return zero rows. Always create at least one policy before enabling.[^altertable-rls]

2. **Only `RESTRICTIVE` policies = no rows visible.** Verbatim: *"If only restrictive policies exist, then no records will be accessible."*[^createpolicy-rest] You need at least one `PERMISSIVE` policy to grant access; restrictive policies AND-combine on top.

3. **Table owner bypasses RLS by default.** If your app role owns the table, your policies are dormant for that role. Add `FORCE ROW LEVEL SECURITY` to subject owners to policies.[^altertable-rls]

4. **`USING` returning NULL silently drops the row.** Verbatim: *"if false or null is returned then the row is not visible."*[^createpolicy-desc] Use `current_setting('app.x', true)` (missing-OK form) and pair with `IS NOT NULL` checks if the GUC unset case should be visible to admins. Otherwise unset GUC = no rows visible.

5. **`WITH CHECK` raises an error, `USING` doesn't.** A `USING` violation silently filters; a `WITH CHECK` violation errors with `new row violates row-level security policy`. Asymmetry caught in [USING vs WITH CHECK section](#using-vs-with-check).

6. **`FOR ALL` policy with only `USING` makes that expression do double duty as `WITH CHECK`.** Verbatim: *"ALL policies will be applied to both the selection side of a query and the modification side, using the USING expression for both cases if only a USING expression has been defined."*[^createpolicy-all] Often what you want for tenant isolation; surprising if you intended only to filter reads.

7. **You cannot `OR REPLACE` a policy.** `CREATE POLICY` is the only form. `ALTER POLICY` can change the role list, `USING`, and `WITH CHECK` but **not** the command or permissive/restrictive status — those require `DROP POLICY` + `CREATE POLICY`.[^alterpolicy-desc]

8. **Policy expressions cannot contain aggregates or window functions.** Verbatim docs.[^createpolicy-using] If your access rule needs a group-by, push it into a SECURITY DEFINER function (cross-ref [`06-functions.md`](./06-functions.md)) and call from the policy.

9. **Logical replication into an RLS table requires the subscription role to bypass.** Verbatim PG15 release note: only superusers, `BYPASSRLS` roles, and table owners can replicate into RLS-protected tables.[^pg15-logrep] A plain replication role gets apply errors. Cross-ref [`74-logical-replication.md`](./74-logical-replication.md).

10. **RLS policies cost CPU per row.** A `SELECT` on a 10M-row table now evaluates the policy expression 10M times. If the expression calls a slow function or does a subquery without an index, this is an O(N) tax on every query. Profile with `EXPLAIN (ANALYZE, BUFFERS)`.

11. **The planner may not push policy filters down through joins.** Joins on RLS-protected tables can prevent index use because the policy must apply before the join sees the row. Test plans before and after enabling RLS; cross-ref [`56-explain.md`](./56-explain.md).

12. **`pg_dump` fails on RLS tables for non-bypass roles.** Default `row_security = off` raises an error if filtering would happen. Solution: dump as a `BYPASSRLS` role, the owner, or superuser.[^createrole-bypassrls]

13. **`row_security = on` does *not* bypass RLS** — it's the *default*, the one that applies policies. `off` *errors on filtering*. There is no "bypass via GUC" — bypass requires the role attribute or ownership.[^ddl-rls]

14. **`security_invoker` is PG15+.** Pre-PG15 views always evaluate RLS as the view owner. If you need caller-context RLS on PG14, you must restructure: either grant the underlying table to all callers and let them query directly, or accept that policies will evaluate as the view owner.[^createview-invoker]

15. **Disabling RLS does not delete policies.** They remain in `pg_policy` and re-activate on `ENABLE`. Always `DROP POLICY` if you want them gone permanently.[^altertable-rls]

16. **Dropping the last policy with RLS still enabled triggers default-deny.** Verbatim: *"Note that if the last policy is removed for a table and the table still has row-level security enabled via ALTER TABLE, then the default-deny policy will be used."*[^droppolicy] Combine `DROP POLICY` with `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` in the same transaction if you intend to remove all enforcement.

17. **A policy's `WITH CHECK` is evaluated against the post-UPDATE row, not the pre-UPDATE.** Verbatim.[^createpolicy-using] An UPDATE that moves a row out of the caller's tenant must satisfy both the pre-update `USING` and the post-update `WITH CHECK` — usually meaning the caller can't move rows between tenants at all.

18. **`current_setting('app.x', true)` returns NULL on missing; `current_setting('app.x')` raises an error.** The two-arg form is almost always correct in RLS expressions — you do *not* want connection setup errors crashing every query.

19. **`SET ROLE` doesn't re-apply per-role GUCs.** If your tenant_id is configured via `ALTER ROLE webapp SET app.tenant_id = '42'`, then `SET ROLE webapp` does *not* trigger that GUC to be set. Per-role GUCs only apply at session start. Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6.

20. **`pg_dump --no-policies` is PG18+ only.** Pre-PG18, you must edit the dump SQL post-hoc to strip `CREATE POLICY` statements. There's no flag.[^pg18-no-policies]

21. **`BYPASSRLS` does not grant `SUPERUSER` powers.** It bypasses RLS only. The role still needs `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants on the table.[^createrole-bypassrls]

22. **`BYPASSRLS` grant requires `BYPASSRLS` on the grantor (PG16+).** Previously, any `CREATEROLE`-having role could grant it; PG16 narrowed this.[^pg16-createrole] Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #8.

23. **An RLS policy that references another table needs `SELECT` on that table for the *role evaluating the policy*.** In default views, that's the view owner. In `security_invoker` views or direct table access, that's the caller. A subquery in `USING (...)` will fail if the caller lacks `SELECT` on the referenced table.



## See Also

- [`05-views.md`](./05-views.md) — `security_invoker` (PG15+), `security_barrier`, `INSTEAD OF` triggers, and the full view-side RLS interaction.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `BYPASSRLS` role attribute, `pg_read_all_data`, predefined roles, grant mechanics, PG16 `CREATEROLE` narrowing.
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — which roles can connect from where; RLS only kicks in after auth succeeds.
- [`51-pgaudit.md`](./51-pgaudit.md) — audit log integration; commonly paired with RLS for compliance.
- [`56-explain.md`](./56-explain.md) — reading plans with RLS filters; the `EXPLAIN` plan shows policy `Filter` clauses.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_class.relrowsecurity`, `pg_class.relforcerowsecurity`, `pg_policy`, `pg_policies` view.
- [`74-logical-replication.md`](./74-logical-replication.md) — subscription owner + RLS interaction; PG15 release-note quote.
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — `pg_dump` and `row_security` behavior; PG18 `--no-policies`.



## Sources

[^ddl-rls]: PostgreSQL 16 documentation, *5.9. Row Security Policies*. Verbatim: *"In addition to the SQL-standard privilege system available through GRANT, tables can have row security policies that restrict, on a per-user basis, which rows can be returned by normal queries or inserted, updated, or deleted by data modification commands."* And: *"Superusers and roles with the BYPASSRLS attribute always bypass the row security system when accessing a table. Table owners normally bypass row security as well, though a table owner can choose to be subject to row security with ALTER TABLE ... FORCE ROW LEVEL SECURITY."* And on `row_security`: *"This does not in itself bypass row security; what it does is throw an error if any query's results would get filtered by a policy."* https://www.postgresql.org/docs/16/ddl-rowsecurity.html

[^createpolicy-syn]: PostgreSQL 16 documentation, *CREATE POLICY*. Verbatim full synopsis preserved in the [CREATE POLICY Grammar](#create-policy-grammar) section. https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-desc]: PostgreSQL 16 documentation, *CREATE POLICY — Description*. Verbatim: *"The CREATE POLICY command defines a new row-level security policy for a table. Note that row-level security must be enabled on the table (using ALTER TABLE ... ENABLE ROW LEVEL SECURITY) in order for created policies to be applied. A policy grants the permission to select, insert, update, or delete rows that match the relevant policy expression. Existing table rows are checked against the expression specified in USING, while new rows that would be created via INSERT or UPDATE are checked against the expression specified in WITH CHECK. When a USING expression returns true for a given row then that row is visible to the user, while if false or null is returned then the row is not visible. Typically, no error occurs when a row is not visible, but see Table 292 for exceptions. When a WITH CHECK expression returns true for a row then that row is inserted or updated, while if false or null is returned then an error occurs."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-perm]: PostgreSQL 16 documentation, *CREATE POLICY — PERMISSIVE*. Verbatim: *"Specify that the policy is to be created as a permissive policy. All permissive policies which are applicable to a given query will be combined together using the Boolean 'OR' operator. By creating permissive policies, administrators can add to the set of records which can be accessed. Policies are permissive by default."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-rest]: PostgreSQL 16 documentation, *CREATE POLICY — RESTRICTIVE*. Verbatim: *"Specify that the policy is to be created as a restrictive policy. All restrictive policies which are applicable to a given query will be combined together using the Boolean 'AND' operator. By creating restrictive policies, administrators can reduce the set of records which can be accessed as all restrictive policies must be passed for each record. Note that there needs to be at least one permissive policy to grant access to records before restrictive policies can be usefully used to reduce that access. If only restrictive policies exist, then no records will be accessible. When a mix of permissive and restrictive policies are present, a record is only accessible if at least one of the permissive policies passes, in addition to all the restrictive policies."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-all]: PostgreSQL 16 documentation, *CREATE POLICY — FOR ALL*. Verbatim: *"Using ALL for a policy means that it will apply to all commands, regardless of the type of command. If an ALL policy exists and more specific policies exist, then both the ALL policy and the more specific policy (or policies) will be applied. Additionally, ALL policies will be applied to both the selection side of a query and the modification side, using the USING expression for both cases if only a USING expression has been defined."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-select]: PostgreSQL 16 documentation, *CREATE POLICY — FOR SELECT*. Verbatim: *"A SELECT policy cannot have a WITH CHECK expression, as it only applies in cases where records are being retrieved from the relation, except as described below."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-insert]: PostgreSQL 16 documentation, *CREATE POLICY — FOR INSERT*. Verbatim: *"An INSERT policy cannot have a USING expression, as it only applies in cases where records are being added to the relation."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-update]: PostgreSQL 16 documentation, *CREATE POLICY — FOR UPDATE*. Verbatim: *"Since an UPDATE command involves pulling an existing record and replacing it with a new modified record, UPDATE policies accept both a USING expression and a WITH CHECK expression. The USING expression determines which records the UPDATE command will see to operate against, while the WITH CHECK expression defines which modified rows are allowed to be stored back into the relation."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-delete]: PostgreSQL 16 documentation, *CREATE POLICY — FOR DELETE*. Verbatim: *"For a DELETE command, only rows that pass this policy will be seen by the DELETE command."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-to]: PostgreSQL 16 documentation, *CREATE POLICY — TO role_name*. Verbatim: *"The role(s) to which the policy is to be applied. The default is PUBLIC, which will apply the policy to all roles."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^createpolicy-using]: PostgreSQL 16 documentation, *CREATE POLICY — using_expression and check_expression*. Verbatim for using_expression: *"Any SQL conditional expression (returning boolean). The conditional expression cannot contain any aggregate or window functions. This expression will be added to queries that refer to the table if row-level security is enabled. Rows for which the expression returns true will be visible. Any rows for which the expression returns false or null will not be visible to the user (in a SELECT), and will not be available for modification (in an UPDATE or DELETE). Typically, such rows are silently suppressed; no error is reported (but see Table 292 for exceptions)."* Verbatim for check_expression: *"Any SQL conditional expression (returning boolean). The conditional expression cannot contain any aggregate or window functions. This expression will be used in INSERT and UPDATE queries against the table if row-level security is enabled. Only rows for which the expression evaluates to true will be allowed. An error will be thrown if the expression evaluates to false or null for any of the records inserted or any of the records that result from the update. Note that the check_expression is evaluated against the proposed new contents of the row, not the original contents."* https://www.postgresql.org/docs/16/sql-createpolicy.html

[^alterpolicy-syn]: PostgreSQL 16 documentation, *ALTER POLICY*. Verbatim synopsis preserved in the [ALTER POLICY and DROP POLICY](#alter-policy-and-drop-policy) section. https://www.postgresql.org/docs/16/sql-alterpolicy.html

[^alterpolicy-desc]: PostgreSQL 16 documentation, *ALTER POLICY — Description*. Verbatim: *"ALTER POLICY changes the definition of an existing row-level security policy. Note that ALTER POLICY only allows the set of roles to which the policy applies and the USING and WITH CHECK expressions to be modified. To change other properties of a policy, such as the command to which it applies or whether it is permissive or restrictive, the policy must be dropped and recreated. To use ALTER POLICY, you must own the table that the policy applies to. In the second form of ALTER POLICY, the role list, using_expression, and check_expression are replaced independently if specified. When one of those clauses is omitted, the corresponding part of the policy is unchanged."* https://www.postgresql.org/docs/16/sql-alterpolicy.html

[^droppolicy]: PostgreSQL 16 documentation, *DROP POLICY*. Verbatim: *"DROP POLICY removes the specified policy from the table. Note that if the last policy is removed for a table and the table still has row-level security enabled via ALTER TABLE, then the default-deny policy will be used. ALTER TABLE ... DISABLE ROW LEVEL SECURITY can be used to disable row-level security for a table, whether policies for the table exist or not."* https://www.postgresql.org/docs/16/sql-droppolicy.html

[^altertable-rls]: PostgreSQL 16 documentation, *ALTER TABLE — ENABLE/DISABLE/FORCE ROW LEVEL SECURITY*. Verbatim for `ENABLE`/`DISABLE`: *"These forms control the application of row security policies belonging to the table. If enabled and no policies exist for the table, then a default-deny policy is applied. Note that policies can exist for a table even if row-level security is disabled. In this case, the policies will not be applied and the policies will be ignored. See also CREATE POLICY."* Verbatim for `FORCE`/`NO FORCE`: *"These forms control the application of row security policies belonging to the table when the user is the table owner. If enabled, row-level security policies will be applied when the user is the table owner. If disabled (the default) then row-level security will not be applied when the user is the table owner. See also CREATE POLICY."* https://www.postgresql.org/docs/16/sql-altertable.html

[^createrole-bypassrls]: PostgreSQL 16 documentation, *CREATE ROLE — BYPASSRLS / NOBYPASSRLS*. Verbatim: *"BYPASSRLS / NOBYPASSRLS — These clauses determine whether a role bypasses every row-level security (RLS) policy. NOBYPASSRLS is the default. Only superuser roles or roles with BYPASSRLS can specify BYPASSRLS. Note that pg_dump will set row_security to OFF by default, to ensure all contents of a table are dumped out. If the user running pg_dump does not have appropriate permissions, an error will be returned. However, superusers and the owner of the table being dumped always bypass RLS."* https://www.postgresql.org/docs/16/sql-createrole.html

[^createview-invoker]: PostgreSQL 16 documentation, *CREATE VIEW — security_invoker and security_barrier; Notes on RLS*. Verbatim security_barrier: *"This should be used if the view is intended to provide row-level security."* Verbatim security_invoker: *"This option causes the underlying base relations to be checked against the privileges of the user of the view rather than the view owner."* Verbatim RLS interaction: *"If any of the underlying base relations has row-level security enabled, then by default, the row-level security policies of the view owner are applied, and access to any additional relations referred to by those policies is determined by the permissions of the view owner. However, if the view has security_invoker set to true, then the policies and permissions of the invoking user are used instead, as if the base relations had been referenced directly from the query using the view."* `security_invoker` was added in PG15. https://www.postgresql.org/docs/16/sql-createview.html

[^rules-privileges]: PostgreSQL 16 documentation, *41.5. Rules and Privileges*. Verbatim: *"With the exception of SELECT rules associated with security invoker views (see CREATE VIEW), all relations that are used due to rules get checked against the privileges of the rule owner, not the user invoking the rule. This means that, except for security invoker views, users only need the required privileges for the tables/views that are explicitly named in their queries."* And: *"When it is necessary for a view to provide row-level security, the security_barrier attribute should be applied to the view. This prevents maliciously-chosen functions and operators from being passed values from rows until after the view has done its work."* https://www.postgresql.org/docs/16/rules-privileges.html

[^pg15-logrep]: PostgreSQL 15.0 release notes, §E.18.2. Verbatim: *"Allow logical replication to run as the owner of the subscription (Mark Dilger). Because row-level security policies are not checked, only superusers, roles with bypassrls, and table owners can replicate into tables with row-level security policies."* https://www.postgresql.org/docs/release/15.0/

[^pg16-createrole]: PostgreSQL 16.0 release notes, *CREATEROLE narrowing*. Verbatim: *"they can now change the CREATEDB, REPLICATION, and BYPASSRLS properties only if they also have those permissions."* (This applies to the `BYPASSRLS` attribute grant path, narrowed in PG16.) https://www.postgresql.org/docs/release/16.0/

[^pg18-no-policies]: PostgreSQL 18.0 release notes, §E.4.3.7.1 (Migration). Verbatim: *"Add option --no-policies to disable row level security policy processing in pg_dump, pg_dumpall, pg_restore (Nikolay Samokhvalov)."* https://www.postgresql.org/docs/release/18.0/

Additional release notes consulted for absence-of-changes confirmation:

- PostgreSQL 14.0 release notes — zero RLS-related items. https://www.postgresql.org/docs/release/14.0/
- PostgreSQL 17.0 release notes — zero RLS-related items. https://www.postgresql.org/docs/release/17.0/

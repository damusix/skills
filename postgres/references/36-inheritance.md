# Table Inheritance


> [!WARNING] Legacy mechanism
> **Table inheritance is legacy.** For new partitioning use cases, use **declarative partitioning** — see [`35-partitioning.md`](./35-partitioning.md). This file documents inheritance for the rare cases where it still fits (cross-schema federation, polymorphic table designs with per-child extra columns, multi-parent designs) and for understanding existing code. The official docs themselves describe inheritance partitioning as "the legacy inheritance method"[^legacy-phrase].


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [INHERITS clause grammar](#inherits-clause-grammar)
    - [The ONLY keyword and the trailing *](#the-only-keyword-and-the-trailing-)
    - [ALTER TABLE INHERIT and NO INHERIT](#alter-table-inherit-and-no-inherit)
    - [What inherits and what does not](#what-inherits-and-what-does-not)
    - [Privileges and Row Level Security](#privileges-and-row-level-security)
    - [Column merging](#column-merging)
    - [CHECK and NOT NULL merging](#check-and-not-null-merging)
    - [Identity columns and generated columns](#identity-columns-and-generated-columns)
    - [Command recursion rules](#command-recursion-rules)
    - [Inheritance vs declarative partitioning](#inheritance-vs-declarative-partitioning)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file when you are:

- Maintaining a pre-PG10 codebase that uses inheritance for partitioning (you should be planning a migration to declarative partitioning — see Recipe 11).
- Designing a *polymorphic* model where child tables genuinely need additional columns the parent does not have (declarative partitioning forbids this; inheritance allows it).
- Designing a multi-parent table (declarative partitioning forbids multiple inheritance; inheritance allows it).
- Federating tables across schemas where the parent is a view-like aggregation point.
- Reading existing queries that use `ONLY` or trailing-`*` table references and need to understand the recursion semantics.

Anyone reaching for inheritance to implement *partitioning* on PG10+ is using the wrong tool. Cross-reference [`35-partitioning.md`](./35-partitioning.md) Recipe 3 for the canonical "convert inheritance-partitioned table to declarative" migration.


## Mental Model

Five rules drive every decision in this file.

1. **Inheritance is legacy for partitioning; it remains valid for a narrow set of designs.** PG10 introduced declarative partitioning and PG11+ closed most of the functional gaps. The three legitimate reasons to still use inheritance: child tables need extra columns the parent does not have, you need multiple inheritance, or you are reading existing code that uses it[^ddl-partitioning].

2. **CHECK and NOT NULL inherit. Nothing else does.** Indexes, UNIQUE constraints, PRIMARY KEY constraints, FOREIGN KEY constraints, and identity columns are all per-table. The verbatim docs sentence: *"All check constraints and not-null constraints on a parent table are automatically inherited by its children, unless explicitly specified otherwise with NO INHERIT clauses. Other types of constraints (unique, primary key, and foreign key constraints) are not inherited"*[^ddl-inherit-constraints]. This single rule defeats half the use cases readers try.

3. **Privileges check the parent only when accessed *through* the parent.** Granting `UPDATE` on the parent does not authorize direct UPDATE on the child[^ddl-inherit-priv]. RLS policies behave the same way: parent policies apply when the row is reached through the parent; child policies apply only when the child is named explicitly. This is the inverse of what most operators assume.

4. **`ONLY` excludes children; the default includes them; `INSERT` and `ALTER TABLE ... RENAME` are exceptions.** Most DML/DDL commands default to recursing through the hierarchy and accept `ONLY` to opt out. `INSERT` always targets exactly one table — there is no automatic routing of an INSERT on the parent to the correct child. `ALTER TABLE ... RENAME` does not recurse either[^caveats]. These exceptions are why inheritance is unsuited to partitioning.

5. **PG18 changes `VACUUM` and `ANALYZE` to recurse by default — an incompatibility from PG17.** Pre-PG18 the maintenance commands did not recurse through inheritance; you had to vacuum each child explicitly. PG18 reverses this default — `VACUUM cities` now processes `cities` plus all descendants. The previous behavior requires the new `ONLY` keyword: `VACUUM ONLY cities`[^pg18-vacuum-only]. Operators upgrading to PG18 must audit cron jobs.


## Decision Matrix

| You have | Use | Why |
|---|---|---|
| New partitioning design (any PG10+) | **Declarative partitioning** (see [`35-partitioning.md`](./35-partitioning.md)) | All the operational features (CONCURRENTLY DETACH, partition pruning, partitionwise join, FK propagation, index propagation, default partition) are declarative-only. |
| Existing inheritance-partitioned table on PG10+ | **Migrate to declarative partitioning** (Recipe 11) | Inheritance partitioning predates every operational improvement; the maintenance burden compounds with every new partition. |
| Child tables genuinely need extra columns | **Inheritance** | This is one of the three legitimate reasons. Declarative forbids it: *"partitions must have exactly the same set of columns as the partitioned table, whereas with table inheritance, child tables may have extra columns not present in the parent"*[^ddl-partitioning]. |
| Multiple inheritance (one child has two parents) | **Inheritance** | Declarative forbids it[^ddl-partitioning]. Realistic only in cross-schema federation designs. |
| Cross-schema federation (parent is logical, children are physical in separate schemas) | **Inheritance** OR foreign tables | Both work. FDW gives transactional isolation between sub-systems; inheritance gives a single execution plan. |
| Audit trail with a polymorphic event table | **Inheritance** OR jsonb column on a single table | Inheritance only wins if the children differ enough in column shape that jsonb-with-rendering becomes the bottleneck. |
| Migrating from an ORM that emitted CREATE TABLE INHERITS | **Migrate to declarative partitioning OR a single table with jsonb** | Almost always inheritance was the wrong choice in the first place. |


## Syntax / Mechanics


### INHERITS clause grammar

The grammar appears in `CREATE TABLE`[^createtable]:

```
CREATE TABLE child_name (
    [ column definitions ]
) INHERITS ( parent_table [, ... ] )
```

The verbatim docs description: *"The optional `INHERITS` clause specifies a list of tables from which the new table automatically inherits all columns. Parent tables can be plain tables or foreign tables."*[^createtable]

```sql
-- Single-parent inheritance
CREATE TABLE cities (
    name        text,
    population  float,
    elevation   int
);

CREATE TABLE capitals (
    state       char(2)
) INHERITS (cities);

-- The capitals child gets all parent columns plus its own.
-- SELECT * FROM capitals returns: name, population, elevation, state
```

Multiple parents are allowed:

```sql
CREATE TABLE audit_event (
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_record (
    invoice_id  bigint NOT NULL,
    amount_cents bigint NOT NULL
);

CREATE TABLE invoice_audit (
    -- inherits both occurred_at AND invoice_id, amount_cents
) INHERITS (audit_event, billing_record);
```

Column-name conflicts merge if the types match, error otherwise[^createtable]: *"If the same column name exists in more than one parent table, an error is reported unless the data types of the columns match in each of the parent tables. If there is no conflict, then the duplicate columns are merged to form a single column in the new table."*


### The ONLY keyword and the trailing *

Two equivalent notations control recursion:

```sql
-- Both apply only to the parent, ignoring children
SELECT * FROM ONLY cities;
SELECT * FROM cities ONLY;        -- equivalent

-- Both apply to the parent and all descendants (default)
SELECT * FROM cities;
SELECT * FROM cities *;           -- explicit recursive form
```

The verbatim docs framing: *"You can also write the table name with a trailing `*` to explicitly specify that descendant tables are included"*[^ddl-inherit-pg18].

The default depends on the command:

| Command | Default | Accepts ONLY? |
|---|---|---|
| `SELECT` | Recursive | Yes |
| `UPDATE` | Recursive | Yes |
| `DELETE` | Recursive | Yes |
| Most `ALTER TABLE` forms (`ADD COLUMN`, `DROP COLUMN`, `ALTER COLUMN`, `ADD CONSTRAINT`) | Recursive | Yes |
| `ALTER TABLE ... RENAME` | **Not applicable** — does not recurse[^caveats] | n/a |
| `INSERT` | **Single-table** — always targets the named table; no routing | No |
| `COPY ... FROM` | **Single-table** | No |
| `TRUNCATE` | Recursive | Yes |
| `REINDEX` | Per-table only[^caveats] | n/a |
| `VACUUM` (PG≤17) | Per-table only[^caveats] | n/a |
| `VACUUM` (PG18+) | **Recursive** (changed) — see incompatibility | Yes (new `ONLY` keyword) |
| `ANALYZE` (PG18+) | **Recursive** (changed) | Yes (new `ONLY` keyword) |

> [!NOTE] PostgreSQL 18
> `VACUUM` and `ANALYZE` now recurse through inheritance children of a parent by default[^pg18-vacuum-only]. The previous per-table behavior requires the new `ONLY` option: `VACUUM ONLY parent_name;` / `ANALYZE ONLY parent_name;`. Audit any cron jobs that explicitly enumerate children before upgrading — under PG18, calling `VACUUM` on the parent now does the work the cron job intended.


### ALTER TABLE INHERIT and NO INHERIT

A table can be added to an existing inheritance hierarchy with `ALTER TABLE`[^ddl-inherit-alter]:

```sql
-- Add capitals as a child of cities (it must already have matching columns)
ALTER TABLE capitals INHERIT cities;

-- Remove the inheritance link
ALTER TABLE capitals NO INHERIT cities;
```

The verbatim docs requirement: *"To do this the new child table must already include columns with the same names and types as the columns of the parent. It must also include check constraints with the same names and check expressions as those of the parent."*[^ddl-inherit-alter]

> [!NOTE] PostgreSQL 18
> `NOT NULL` constraints can now have their inheritability modified after creation via `ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT`[^pg18-notnull]. Pre-PG18 you had to drop and recreate the constraint. The full grammar applies to `NOT NULL` constraints specifically — other constraint kinds (CHECK, UNIQUE, FOREIGN KEY) still cannot have their inheritability changed in place.


### What inherits and what does not

This is the headline rule of the file. The verbatim docs sentence[^ddl-inherit-constraints]:

> All check constraints and not-null constraints on a parent table are automatically inherited by its children, unless explicitly specified otherwise with `NO INHERIT` clauses. Other types of constraints (unique, primary key, and foreign key constraints) are not inherited.

Concretely:

| Object on parent | Inherits to child? | Operational consequence |
|---|---|---|
| Columns | Yes | Child has all parent columns plus its own. |
| `CHECK` constraints | Yes (unless `NO INHERIT`) | A row visible through the parent satisfies parent CHECKs. |
| `NOT NULL` constraints | Yes (unless `NO INHERIT` on PG18+) | Same. |
| Column `DEFAULT` values | **Copied at creation, not linked**[^createtable] | Changing the parent default does not change the child default. |
| Column `STORAGE` settings | Yes — copied[^createtable] | Continues to apply to inserted child rows. |
| `UNIQUE` constraints | **No** | A unique constraint on the parent does not prevent duplicate values in children. |
| `PRIMARY KEY` | **No** | Same. Duplicate PK values can exist across the hierarchy. |
| `FOREIGN KEY` (parent has FK pointing out) | **No** | Each child must declare its own FK if needed. |
| `FOREIGN KEY` (other table has FK pointing in) | **No** | An FK referencing `cities(name)` does not allow `capitals` values. *"There is no good workaround for this case"*[^ddl-inherit-fk]. |
| Indexes (including expression and partial) | **No** | Create the same index on each child explicitly. |
| Identity columns | **No**[^createtable] | The child can be declared as identity independently. |
| Triggers | **No** (must be created per-table) | See [`39-triggers.md`](./39-triggers.md). |
| Row Level Security policies | Applied at parent during inherited queries; child policies apply only when child is named[^ddl-inherit-priv] | See next section. |
| Comments, column statistics, ACLs | **No** | Per-table. |

The verbatim CREATE TABLE docs reinforce the unique-constraint trap[^createtable]: *"Unique constraints and primary keys are not inherited in the current implementation. This makes the combination of inheritance and unique constraints rather dysfunctional."* Note the docs themselves use the word "dysfunctional."


### Privileges and Row Level Security

The verbatim privilege rule[^ddl-inherit-priv]:

> Inherited queries perform access permission checks on the parent table only. Thus, for example, granting `UPDATE` permission on the `cities` table implies permission to update rows in the `capitals` table as well, when they are accessed through `cities`. This preserves the appearance that the data is (also) in the parent table. But the `capitals` table could not be updated directly without an additional grant.

This is asymmetric — a privilege on the parent flows down only when the parent is the named target. A direct query against the child requires its own grant. Operators frequently expect either both directions (privileges propagate fully) or neither (privileges check the named target only). The actual behavior is *"check parent at parent-targeted query, check child at child-targeted query."*

RLS policies follow the same asymmetric pattern[^ddl-inherit-priv]:

> In a similar way, the parent table's row security policies (see Section 5.8) are applied to rows coming from child tables during an inherited query. A child table's policies, if any, are applied only when it is the table explicitly named in the query; and in that case, any policies attached to its parent(s) are ignored.

If you secure data using RLS and inheritance together, the only safe pattern is: put policies on the parent that all readers reach through, and `REVOKE ALL ON child FROM PUBLIC` so nobody can bypass the parent's policies by querying the child directly. See [`47-row-level-security.md`](./47-row-level-security.md) for the broader RLS surface.


### Column merging

When the same column name appears on the new child explicitly and on a parent, the columns are merged into one[^createtable]. Types must match. If the new child specifies a default and the parent also has one, *the child's default wins* — same column, child override. If two parents specify different defaults for the same column, an error is raised.

```sql
CREATE TABLE auditable (
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
    invoice_id bigint,
    created_at timestamptz DEFAULT '2026-01-01'::timestamptz   -- overrides parent default
) INHERITS (auditable);
```

> [!WARNING]
> `DEFAULT` values are **copied at the time of `CREATE TABLE`**, not linked. Changing the parent's default with `ALTER TABLE auditable ALTER COLUMN created_at SET DEFAULT '...'` after the fact does **not** update the child. The same is true of the `STORAGE` setting. Identity-column properties are not inherited at all.


### CHECK and NOT NULL merging

CHECK constraints merge by name and expression. The verbatim rule[^createtable]:

> CHECK constraints are merged in essentially the same way as columns: if multiple parent tables and/or the new table definition contain identically-named CHECK constraints, these constraints must all have the same check expression, or an error will be reported. Constraints having the same name and expression will be merged into one copy. A constraint marked `NO INHERIT` in a parent will not be considered. Notice that an unnamed CHECK constraint in the new table will never be merged, since a unique name will always be chosen for it.

The `NO INHERIT` modifier prevents a constraint from cascading to children:

```sql
CREATE TABLE products (
    sku text PRIMARY KEY,
    in_stock boolean NOT NULL DEFAULT true,
    CONSTRAINT default_in_stock CHECK (in_stock = true) NO INHERIT
);

CREATE TABLE discontinued_products (
    -- No CHECK on in_stock here because parent's constraint is NO INHERIT
    retired_at timestamptz
) INHERITS (products);

INSERT INTO discontinued_products (sku, in_stock, retired_at)
    VALUES ('OLD-SKU', false, '2026-01-01');   -- succeeds
```


### Identity columns and generated columns

The verbatim CREATE TABLE rule[^createtable]:

> If a column in the parent table is an identity column, that property is not inherited. A column in the child table can be declared identity column if desired.

This is the cleanest "do not inherit" rule in the docs because it is explicit. The same applies to generated columns — `GENERATED ALWAYS AS (expr)` and `GENERATED ALWAYS AS IDENTITY` are per-table column properties.

For inheritance hierarchies that need a single global sequence, share an explicit sequence across children:

```sql
CREATE SEQUENCE shared_event_id;

CREATE TABLE event (
    event_id bigint PRIMARY KEY DEFAULT nextval('shared_event_id'),
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_event (
    event_id bigint PRIMARY KEY DEFAULT nextval('shared_event_id'),   -- explicit re-declaration
    invoice_id bigint
) INHERITS (event);
```

Note that the PRIMARY KEY constraint on `event` does not propagate, so the child's PK declaration is independent — and uniqueness across the hierarchy is not enforced.


### Command recursion rules

The verbatim caveats subsection[^caveats]:

> Note that not all SQL commands are able to work on inheritance hierarchies. Commands that are used for data querying, data modification, or schema modification (e.g., `SELECT`, `UPDATE`, `DELETE`, most variants of `ALTER TABLE`, but not `INSERT` or `ALTER TABLE ... RENAME`) typically default to including child tables and support the `ONLY` notation to exclude them. Commands that do database maintenance and tuning (e.g., `REINDEX`, `VACUUM`) typically only work on individual, physical tables and do not support recursing over inheritance hierarchies. The respective behavior of each individual command is documented in its reference page.

The `INSERT` exception is the most operationally damaging. `INSERT INTO cities ...` always inserts into `cities`; the row does not get routed to a child based on its content. This is why inheritance is unsuited to partitioning — every application using inheritance for partitioning needs a `BEFORE INSERT` trigger that redirects rows to the correct child. Declarative partitioning handles this routing in the core.

The `ALTER TABLE ... RENAME` exception is subtle: rename a column on the parent and child columns keep the old name, leading to schema drift. Cross-reference [`01-syntax-ddl.md`](./01-syntax-ddl.md) lock-level matrix.


### Inheritance vs declarative partitioning

The verbatim docs comparison (the closest thing the docs have to a recommendation)[^ddl-partitioning]:

> Partitioning can be implemented using table inheritance, which allows for several features not supported by declarative partitioning, such as:
>
> *   For declarative partitioning, partitions must have exactly the same set of columns as the partitioned table, whereas with table inheritance, child tables may have extra columns not present in the parent.
>
> *   Table inheritance allows for multiple inheritance.
>
> *   Declarative partitioning only supports range, list and hash partitioning, whereas table inheritance allows data to be divided in a manner of the user's choosing.

The docs do not explicitly say "prefer declarative." The recommendation is structural — declarative partitioning has its own first-class chapter, the constraint-exclusion section[^legacy-phrase] explicitly calls inheritance partitioning *"the legacy inheritance method"*, and every PG10+ release has added features only to declarative partitioning (ATTACH/DETACH CONCURRENTLY, FK propagation, partition-wise join, default partition, BEFORE ROW triggers, row movement, partition pruning).

Eight-row comparison:

| Aspect | Declarative partitioning | Inheritance partitioning |
|---|---|---|
| Row routing on INSERT | Automatic by partition key | Requires BEFORE INSERT trigger |
| Indexes propagate to children | Yes (PG11+) | No — declare per-child |
| FK from partitioned to partitioned | Yes (PG11+/PG12+) | No |
| Partition pruning at plan and exec | Yes (PG11+) | Constraint exclusion only at plan |
| ATTACH / DETACH partition | Yes (PG10+); DETACH CONCURRENTLY PG14+ | Manual `ALTER TABLE INHERIT / NO INHERIT` |
| Partition-wise join | Yes (PG11+) | No |
| Child has extra columns | Forbidden | Allowed |
| Multiple parents | Forbidden | Allowed |


### Per-version timeline

| Version | Inheritance-relevant change | Verbatim source |
|---|---|---|
| PG14 | **No changes** to table inheritance in release notes. | Confirmed by direct fetch of release notes index. |
| PG15 | **No changes** to table inheritance in release notes. | Confirmed by direct fetch. |
| PG16 | **No table-inheritance changes.** Note: PG16 added `GRANT ... WITH INHERIT` for *role inheritance* — this is unrelated to table inheritance. See Gotcha #19. | Verbatim quote: *"Role inheritance now controls the default inheritance status of member roles added during GRANT"*[^pg16-role-inherit]. |
| PG17 | **No changes** to table inheritance in release notes. | Confirmed by direct fetch. |
| PG18 | (1) `ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT` for NOT NULL constraints[^pg18-notnull]. (2) **Incompatibility:** `VACUUM` and `ANALYZE` now process inheritance children by default; new `ONLY` keyword for pre-PG18 behavior[^pg18-vacuum-only]. | Two separate verbatim release-note quotes. |


## Examples / Recipes


### Recipe 1: Polymorphic event log with per-child extra columns

This is one of the legitimate uses of inheritance. The parent is a generic event log; each child adds event-type-specific columns:

```sql
CREATE TABLE audit_event (
    event_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_id    bigint NOT NULL,
    event_type  text NOT NULL
);

CREATE TABLE billing_event (
    invoice_id    bigint NOT NULL,
    amount_cents  bigint NOT NULL,
    CONSTRAINT billing_event_type CHECK (event_type = 'billing')
) INHERITS (audit_event);

CREATE TABLE login_event (
    ip_address    inet NOT NULL,
    user_agent    text,
    CONSTRAINT login_event_type CHECK (event_type = 'login')
) INHERITS (audit_event);

-- Generic query against parent sees both subtypes
SELECT event_id, event_type, occurred_at FROM audit_event ORDER BY occurred_at DESC LIMIT 10;

-- Subtype-specific query
SELECT event_id, invoice_id, amount_cents FROM billing_event WHERE occurred_at > now() - interval '1 day';
```

> [!WARNING]
> The PK declaration on `audit_event` is **not inherited**. Each child can have duplicate `event_id` values, and the global sequence does not prevent it. If you need cluster-wide unique event IDs, declare PRIMARY KEY on every child explicitly *and* enforce uniqueness in the application layer or via a deferred trigger. The `event_id` column inherits, but the PRIMARY KEY constraint does not.


### Recipe 2: Cross-schema federation via inheritance

When a single logical entity spans multiple subsystems with separate schemas:

```sql
-- Parent in 'shared' schema (deployed by platform team)
CREATE SCHEMA shared;
CREATE TABLE shared.user_data (
    user_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Each subsystem owns its child in its own schema
CREATE SCHEMA billing;
CREATE TABLE billing.user_data (
    billing_address jsonb NOT NULL
) INHERITS (shared.user_data);

CREATE SCHEMA reporting;
CREATE TABLE reporting.user_data (
    last_report_at timestamptz
) INHERITS (shared.user_data);

-- Cross-subsystem query through the parent
SELECT user_id, created_at FROM shared.user_data WHERE user_id = $1;
```

Foreign Data Wrappers ([`70-fdw.md`](./70-fdw.md)) give stricter isolation between subsystems; inheritance keeps everything in one cluster with a single execution plan.


### Recipe 3: Use NO INHERIT to scope a CHECK to one table

```sql
CREATE TABLE products (
    sku text PRIMARY KEY,
    in_stock boolean NOT NULL DEFAULT true,
    discontinued_at timestamptz,
    CONSTRAINT active_only CHECK (discontinued_at IS NULL) NO INHERIT
);

-- This child can record retired products without violating the parent's constraint
CREATE TABLE retired_products (
    retired_reason text
) INHERITS (products);

INSERT INTO retired_products (sku, in_stock, discontinued_at, retired_reason)
    VALUES ('OBSOLETE-1', false, '2026-01-01', 'replaced');   -- succeeds
```


### Recipe 4: Audit existing inheritance hierarchies

This query inventories every inheritance relationship in the database:

```sql
SELECT
    parent_ns.nspname  AS parent_schema,
    parent.relname     AS parent_table,
    child_ns.nspname   AS child_schema,
    child.relname      AS child_table,
    i.inhseqno         AS inherit_order
FROM pg_inherits i
JOIN pg_class parent     ON parent.oid = i.inhparent
JOIN pg_class child      ON child.oid  = i.inhrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
JOIN pg_namespace child_ns  ON child_ns.oid  = child.relnamespace
WHERE parent.relkind IN ('r', 'f')   -- ordinary table or foreign table; NOT 'p' (partitioned)
ORDER BY parent_ns.nspname, parent.relname, i.inhseqno;
```

Filtering `relkind IN ('r', 'f')` is the key step: `'p'` is a partitioned table, and `pg_inherits` contains both inheritance and partition relationships. To find pure inheritance (not partitioning), exclude `'p'`. To find partitioned tables instead, filter for `relkind = 'p'`.


### Recipe 5: Find tables that have extra columns beyond their parent

Useful to identify legitimate inheritance use cases that should *not* be migrated to declarative partitioning:

```sql
SELECT
    child.oid::regclass AS child_table,
    parent.oid::regclass AS parent_table,
    array_agg(att.attname) FILTER (WHERE NOT att.attinhcount > 0) AS child_only_columns
FROM pg_inherits i
JOIN pg_class child  ON child.oid  = i.inhrelid
JOIN pg_class parent ON parent.oid = i.inhparent
JOIN pg_attribute att ON att.attrelid = child.oid
WHERE child.relkind = 'r'
  AND parent.relkind = 'r'
  AND att.attnum > 0
  AND NOT att.attisdropped
GROUP BY child.oid, parent.oid
HAVING bool_or(NOT att.attinhcount > 0);
```

`pg_attribute.attinhcount > 0` means the column was inherited from at least one parent; the `FILTER` clause keeps only columns the child added on its own.


### Recipe 6: Tighten privileges to prevent direct child access

For inheritance hierarchies that depend on parent-level privilege checks (or parent-level RLS), strip child access:

```sql
-- Application role can see/modify only through the parent
REVOKE ALL ON billing_event FROM app_user;
REVOKE ALL ON login_event   FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_event TO app_user;

-- Direct queries against billing_event/login_event by app_user now fail with permission denied,
-- but queries through audit_event still see all subtype rows.
```


### Recipe 7: Replace UNIQUE-across-hierarchy with a coordinating sequence

UNIQUE constraints do not propagate. If you need globally-unique values across an inheritance hierarchy, share a sequence:

```sql
CREATE SEQUENCE event_id_seq;

CREATE TABLE event_root (
    event_id bigint NOT NULL DEFAULT nextval('event_id_seq')
);

CREATE TABLE event_billing (
    invoice_id bigint NOT NULL,
    -- explicit PK because parent's PK does not inherit, AND uniqueness is per-table
    PRIMARY KEY (event_id)
) INHERITS (event_root);

CREATE TABLE event_login (
    ip_address inet NOT NULL,
    PRIMARY KEY (event_id)
) INHERITS (event_root);
```

Each child has its own primary key on `event_id`; the shared sequence prevents collisions across children. Note that this does NOT enforce uniqueness — a manual INSERT with a custom `event_id` could still produce a duplicate. The sequence is the *coordination* mechanism, not the *enforcement* mechanism.


### Recipe 8: Add CHECK constraint to entire hierarchy in one step

`ALTER TABLE` is recursive by default for constraint additions:

```sql
ALTER TABLE cities ADD CONSTRAINT name_not_empty CHECK (name <> '');
-- propagates to capitals and all descendants automatically
```

Use `ONLY` to apply just to the parent:

```sql
ALTER TABLE ONLY cities ADD CONSTRAINT name_not_empty CHECK (name <> '') NO INHERIT;
-- attaches to parent only; new children created later will inherit normally,
-- but existing children remain unconstrained
```


### Recipe 9: Use ALTER TABLE INHERIT to retroactively add a child

```sql
-- A pre-existing table that happens to have compatible columns
CREATE TABLE european_cities (
    name        text,
    population  float,
    elevation   int,
    country     text
);

-- Attach it to the cities hierarchy
ALTER TABLE european_cities INHERIT cities;

-- Now queries on cities include european_cities rows
SELECT count(*) FROM cities;
```

The compatibility check is strict: column names, types, and existing parent CHECK constraints must all match.


### Recipe 10: Remove a child without dropping its data

```sql
-- Detach without dropping
ALTER TABLE capitals NO INHERIT cities;

-- The data still exists in capitals; it just no longer appears in queries against cities.
SELECT count(*) FROM cities;      -- excludes capitals rows now
SELECT count(*) FROM capitals;    -- unchanged
```

Compare to `ALTER TABLE ... DETACH PARTITION` in declarative partitioning ([`35-partitioning.md`](./35-partitioning.md)) — same operational effect, different command name.


### Recipe 11: Migrate inheritance-partitioned table to declarative partitioning

The canonical migration. Reuses much of [`35-partitioning.md`](./35-partitioning.md) Recipe 3.

```sql
-- BEFORE: inheritance partitioning by month
-- events (parent, no data), events_2026_01, events_2026_02, ...

-- 1. Build the new declarative parent under a different name
CREATE TABLE events_new (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    payload     jsonb NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_new_2026_01 PARTITION OF events_new
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
-- repeat per partition

-- 2. Copy data from each inheritance child into the matching declarative partition
INSERT INTO events_new_2026_01 SELECT * FROM ONLY events_2026_01;
-- repeat per month, ideally in a chunked transaction loop

-- 3. (Brief lock window) Atomic rename
BEGIN;
LOCK TABLE events IN ACCESS EXCLUSIVE MODE;
ALTER TABLE events RENAME TO events_old;
ALTER TABLE events_new RENAME TO events;
COMMIT;

-- 4. Verify, then drop the old hierarchy
DROP TABLE events_old CASCADE;
```

> [!WARNING]
> The atomic rename step requires `ACCESS EXCLUSIVE` on the parent table — readers and writers block briefly. Schedule a maintenance window for clusters with continuous traffic. For zero-downtime migration, use logical replication ([`74-logical-replication.md`](./74-logical-replication.md)) into a fresh cluster.


### Recipe 12: PG18 `VACUUM ONLY` to preserve pre-PG18 cron behavior

Pre-PG18 a cron job that vacuums each inheritance child individually still works on PG18. But a job that called `VACUUM parent_name` to mean "vacuum *just* the parent" silently changes behavior on upgrade:

```sql
-- Pre-PG18 semantics: vacuum just the parent, do NOT touch children
VACUUM cities;

-- PG18+ semantics with original intent: vacuum just the parent
VACUUM ONLY cities;

-- PG18+ semantics for full-hierarchy vacuum (new default behavior):
VACUUM cities;   -- now equivalent to VACUUM cities, capitals, european_cities, ...
```

Audit cron jobs and runbooks for the strings `VACUUM <parent>` and `ANALYZE <parent>` before upgrading to PG18.


### Recipe 13: Detect orphaned children with no remaining parent

A child can be orphaned via `ALTER TABLE ... NO INHERIT`. Orphans look like normal tables but may have had columns added under the assumption that the parent owned the schema:

```sql
SELECT c.oid::regclass AS table_name,
       a.attinhcount,
       a.attname
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid
WHERE c.relkind = 'r'
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND a.attinhcount > 0    -- column claims to be inherited
  AND NOT EXISTS (         -- but no parent provides it
      SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
  )
ORDER BY table_name, a.attnum;
```

This is the inheritance equivalent of "broken FK after a `NO INHERIT`" — `pg_attribute.attinhcount` is supposed to match the count of providing parents, but the relationship rows in `pg_inherits` are deleted on `NO INHERIT`. If you see attinhcount > 0 with no matching pg_inherits row, the catalog is in a recoverable but unusual state.


## Gotchas / Anti-patterns

1. **`UNIQUE` / `PRIMARY KEY` does not propagate** — the single most damaging surprise. Duplicates across the hierarchy are silently allowed unless you declare the constraint on every child. The docs use the word *"dysfunctional"* for this[^createtable]. Cross-reference Recipe 7 for the coordinating-sequence workaround.

2. **`FOREIGN KEY` does not propagate either direction.** Outbound FKs on the parent must be redeclared on every child. Inbound FKs `REFERENCES cities(name)` accept only parent values, not child values — and the docs explicitly say *"there is no good workaround for this case"*[^ddl-inherit-fk].

3. **Privileges flow through the parent, not symmetrically.** `GRANT SELECT ON parent` allows reading child rows through the parent but does NOT allow direct queries against the child. This is the inverse of what most operators assume.

4. **RLS policies are asymmetric the same way as privileges.** Parent policies apply when the row is fetched through the parent; the *child's* policies apply only when the child is named directly[^ddl-inherit-priv]. To enforce uniformly, revoke direct child access (Recipe 6).

5. **`INSERT` does not route automatically.** This is the killer reason inheritance is bad for partitioning. Every application using inheritance for partitioning needs a `BEFORE INSERT` trigger on the parent that redirects rows to the correct child. Declarative partitioning routes automatically.

6. **`ALTER TABLE ... RENAME` does not recurse**[^caveats]. Renaming a column on the parent leaves child columns with the old name — silent schema drift across the hierarchy. Use `ALTER TABLE` on each child explicitly, or migrate to declarative partitioning where rename is automatic for the parent (and children are required to match anyway).

7. **`REINDEX` and `VACUUM` (pre-PG18) do not recurse**[^caveats]. Pre-PG18 you had to enumerate children explicitly. PG18+ `VACUUM` recurses by default — a silent behavior change on upgrade. `REINDEX` still does not.

8. **PG18 `VACUUM cities` no longer means "vacuum just cities."** It now means "vacuum cities and every descendant." Use `VACUUM ONLY cities` to preserve pre-PG18 behavior[^pg18-vacuum-only]. Affects cron jobs and runbooks.

9. **`DEFAULT` and `STORAGE` are copied at child creation, not linked.** Changing the parent's default after the child exists does not update the child. Audit defaults across the hierarchy with `pg_attribute.atthasdef` joined to `pg_attrdef`.

10. **Identity columns are not inherited**[^createtable]. The column itself is inherited (data type, NOT NULL); the IDENTITY property is not. The child can declare its own IDENTITY, but it will use a *different* sequence by default.

11. **Generated columns are not inherited as generated.** Same rule as identity. If the parent has `GENERATED ALWAYS AS (...)`, the child has the column but not the generation expression — verify with `pg_attribute.attgenerated`.

12. **Indexes do not propagate.** Create the same index on every child explicitly, including expression indexes, partial indexes, and covering indexes. Build them `CONCURRENTLY` per child to avoid blocking; see [`26-index-maintenance.md`](./26-index-maintenance.md).

13. **`SELECT count(*) FROM parent` is a full scan of every child.** Recursion is the default; the planner reads from each child sequentially. Use `pg_class.reltuples` (per child, summed) for an estimate instead.

14. **Constraint exclusion is the only "pruning" inheritance gets** and it only fires at plan time on constant predicates. There is no execution-time pruning, no prepared-statement pruning, and no nested-loop-join pruning — all of those are declarative-only features.

15. **`COPY ... FROM` targets one table, just like `INSERT`.** Bulk-loading an inheritance hierarchy means routing rows in the application or using a `BEFORE INSERT` trigger that re-targets them. Declarative partitioning handles routing in the core.

16. **CHECK constraints with the same name but different expressions across the hierarchy raise an error on child creation**[^createtable]. The merging rule requires identical expressions. If you renamed an expression in a parent and then `ALTER TABLE ... INHERIT`, the operation fails.

17. **`pg_inherits` contains both inheritance and partitioning rows.** Filter `relkind` to disambiguate — `'p'` is a partitioned parent, `'r'` is an ordinary inheritance parent. See Recipe 4.

18. **`pg_attribute.attinhcount` is per-column** and counts the number of providing parents. Useful to find columns the child added itself (`attinhcount = 0`) vs columns the child inherited (`attinhcount > 0`). Multiple inheritance can show counts > 1.

19. **Do not confuse role inheritance with table inheritance.** PG16 added `GRANT ... WITH INHERIT` for *role* inheritance[^pg16-role-inherit]. The new keyword controls whether granting role A to role B causes B to automatically gain A's privileges. This is unrelated to `CREATE TABLE ... INHERITS` — search for the exact phrase carefully when reading release notes.

20. **The `*` trailing notation for recursion is rarely used in modern code.** `SELECT * FROM cities *` is equivalent to `SELECT * FROM cities`. Existing pre-PG9 codebases sometimes use `*` explicitly; you can safely remove it.

21. **PG18 `ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT` applies only to NOT NULL**[^pg18-notnull]. CHECK constraints still cannot have their inheritability changed in place — you must drop and recreate with the desired `NO INHERIT` modifier.

22. **`TRUNCATE` is recursive by default — `TRUNCATE ONLY` empties just the parent.** Unlike `INSERT`, `TRUNCATE` does cascade through inheritance children unless you opt out. Be especially careful with `TRUNCATE` in scripts that intend to clear only the parent.

23. **PG14/PG15/PG17 had zero inheritance changes.** The substantive recent changes are PG18's two items: the NOT NULL inheritability ALTER and the VACUUM/ANALYZE default-recursion incompatibility.


## See Also

- [`35-partitioning.md`](./35-partitioning.md) — the declarative partitioning reference. New code goes here.
- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — CREATE TABLE grammar; the INHERITS clause appears in the lock-level matrix.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — the maintenance-command recursion rules referenced here.
- [`37-constraints.md`](./37-constraints.md) — what constraints are and how they behave (including NO INHERIT on CHECK constraints).
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — the FK rules; the no-propagation rule for inheritance is reinforced there.
- [`39-triggers.md`](./39-triggers.md) — triggers are per-table and not inherited. The BEFORE INSERT trigger pattern for inheritance partitioning is documented there.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — for the unrelated PG16 role-inheritance change.
- [`47-row-level-security.md`](./47-row-level-security.md) — RLS policies under inheritance behave like privileges (asymmetric).
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_inherits`, `pg_attribute.attinhcount`, `pg_class.relkind` are the catalog surface for inspecting inheritance.
- [`43-locking.md`](./43-locking.md) — PG18 VACUUM/ANALYZE lock changes on inheritance hierarchies; lock-conflict matrix for ALTER TABLE … INHERIT/NO INHERIT.
- [`74-logical-replication.md`](./74-logical-replication.md) — for zero-downtime migration from inheritance to declarative partitioning.


## Sources

[^ddl-inherit-constraints]: PostgreSQL 16 docs, section 5.10 Inheritance: "All check constraints and not-null constraints on a parent table are automatically inherited by its children, unless explicitly specified otherwise with NO INHERIT clauses. Other types of constraints (unique, primary key, and foreign key constraints) are not inherited." https://www.postgresql.org/docs/16/ddl-inherit.html

[^ddl-inherit-priv]: PostgreSQL 16 docs, section 5.10 Inheritance, privileges paragraph: "Inherited queries perform access permission checks on the parent table only. Thus, for example, granting UPDATE permission on the cities table implies permission to update rows in the capitals table as well, when they are accessed through cities. This preserves the appearance that the data is (also) in the parent table. But the capitals table could not be updated directly without an additional grant." And: "In a similar way, the parent table's row security policies (see Section 5.8) are applied to rows coming from child tables during an inherited query. A child table's policies, if any, are applied only when it is the table explicitly named in the query; and in that case, any policies attached to its parent(s) are ignored." https://www.postgresql.org/docs/16/ddl-inherit.html

[^ddl-inherit-fk]: PostgreSQL 16 docs, section 5.10 Inheritance: "A serious limitation of the inheritance feature is that indexes (including unique constraints) and foreign key constraints only apply to single tables, not to their inheritance children. This is true on both the referencing and referenced sides of a foreign key constraint." And: "Specifying that another table's column REFERENCES cities(name) would allow the other table to contain city names, but not capital names. There is no good workaround for this case." https://www.postgresql.org/docs/16/ddl-inherit.html

[^ddl-inherit-alter]: PostgreSQL 16 docs, section 5.10 Inheritance: "Alternatively, a table which is already defined in a compatible way can have a new parent relationship added, using the INHERIT variant of ALTER TABLE. To do this the new child table must already include columns with the same names and types as the columns of the parent. It must also include check constraints with the same names and check expressions as those of the parent. Similarly an inheritance link can be removed from a child using the NO INHERIT variant of ALTER TABLE." https://www.postgresql.org/docs/16/ddl-inherit.html

[^ddl-inherit-pg18]: PostgreSQL 18 docs, section 5.10 Inheritance: "You can also write the table name with a trailing `*` to explicitly specify that descendant tables are included." https://www.postgresql.org/docs/18/ddl-inherit.html

[^caveats]: PostgreSQL 16 docs, section 5.10.1 Caveats: "Note that not all SQL commands are able to work on inheritance hierarchies. Commands that are used for data querying, data modification, or schema modification (e.g., SELECT, UPDATE, DELETE, most variants of ALTER TABLE, but not INSERT or ALTER TABLE ... RENAME) typically default to including child tables and support the ONLY notation to exclude them. Commands that do database maintenance and tuning (e.g., REINDEX, VACUUM) typically only work on individual, physical tables and do not support recursing over inheritance hierarchies." https://www.postgresql.org/docs/16/ddl-inherit.html

[^createtable]: PostgreSQL 16 docs, CREATE TABLE reference, INHERITS clause: "The optional INHERITS clause specifies a list of tables from which the new table automatically inherits all columns. Parent tables can be plain tables or foreign tables." Plus the column-merging, CHECK-merging, STORAGE-inheritance, identity-not-inherited, and "Unique constraints and primary keys are not inherited in the current implementation. This makes the combination of inheritance and unique constraints rather dysfunctional." paragraphs. https://www.postgresql.org/docs/16/sql-createtable.html

[^ddl-partitioning]: PostgreSQL 16 docs, section 5.11.3 Partitioning Using Inheritance: "Partitioning can be implemented using table inheritance, which allows for several features not supported by declarative partitioning, such as: For declarative partitioning, partitions must have exactly the same set of columns as the partitioned table, whereas with table inheritance, child tables may have extra columns not present in the parent. Table inheritance allows for multiple inheritance. Declarative partitioning only supports range, list and hash partitioning, whereas table inheritance allows data to be divided in a manner of the user's choosing." https://www.postgresql.org/docs/16/ddl-partitioning.html

[^legacy-phrase]: PostgreSQL 16 docs, section 5.11.5 Partition Pruning vs. Constraint Exclusion: "Constraint exclusion is a query optimization technique similar to partition pruning. While it is primarily used for partitioning implemented using the legacy inheritance method..." https://www.postgresql.org/docs/16/ddl-partitioning.html

[^pg18-notnull]: PostgreSQL 18 release notes, section E.4.3.2.1 Constraints: "Allow modification of the inheritability of NOT NULL constraints (Suraj Kharage, Álvaro Herrera). The syntax is ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT." https://www.postgresql.org/docs/release/18.0/

[^pg18-vacuum-only]: PostgreSQL 18 release notes, section E.4.2 Migration to Version 18 — Incompatibilities: "Change VACUUM and ANALYZE to process the inheritance children of a parent (Michael Harris). The previous behavior can be performed by using the new ONLY option." https://www.postgresql.org/docs/release/18.0/

[^pg16-role-inherit]: PostgreSQL 16 release notes: "Role inheritance now controls the default inheritance status of member roles added during GRANT (Robert Haas). The role's default inheritance behavior can be overridden with the new GRANT ... WITH INHERIT clause. This allows inheritance of some roles and not others because the members' inheritance status is set at GRANT time. Previously the inheritance status of member roles was controlled only by the role's inheritance status, and changes to a role's inheritance status affected all previous and future member roles." https://www.postgresql.org/docs/release/16.0/

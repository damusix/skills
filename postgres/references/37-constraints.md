# Constraints

PostgreSQL constraints reference: CHECK, NOT NULL, UNIQUE, PRIMARY KEY, FOREIGN KEY, EXCLUDE. Covers grammar, lock levels, the `NOT VALID` + `VALIDATE` online-migration pattern, deferrable constraint semantics, and the PG15+ `UNIQUE NULLS NOT DISTINCT` rule. For the FK deep dive (referential actions, partitioned-table rules, ON DELETE column lists) see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md). For domain constraints see [`15-data-types-custom.md`](./15-data-types-custom.md). For the EXCLUDE-with-GiST deep dive see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)

    - [The six constraint kinds](#the-six-constraint-kinds)

    - [CHECK constraints](#check-constraints)

    - [NOT NULL constraints](#not-null-constraints)

    - [UNIQUE constraints](#unique-constraints)

    - [PRIMARY KEY constraints](#primary-key-constraints)

    - [FOREIGN KEY constraints](#foreign-key-constraints)

    - [EXCLUDE constraints](#exclude-constraints)

    - [NOT VALID + VALIDATE CONSTRAINT](#not-valid--validate-constraint)

    - [DEFERRABLE and SET CONSTRAINTS](#deferrable-and-set-constraints)

    - [ALTER CONSTRAINT](#alter-constraint)

    - [Generated columns and constraints](#generated-columns-and-constraints)

    - [Lock-level matrix](#lock-level-matrix)

    - [Per-version timeline](#per-version-timeline)

- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Reach for this file when you need to:

- Decide which kind of constraint to use (CHECK vs trigger, UNIQUE vs PK, EXCLUDE vs UNIQUE).
- Add a constraint to a large production table without taking an `ACCESS EXCLUSIVE` lock for the duration of a full table scan (`NOT VALID` + `VALIDATE CONSTRAINT`).
- Understand the difference between `UNIQUE` (allows multiple NULLs) and `UNIQUE NULLS NOT DISTINCT` (PG15+, treats NULLs as equal).
- Resolve a chicken-and-egg cycle between two FKs (`DEFERRABLE INITIALLY DEFERRED` + `SET CONSTRAINTS`).
- Diagnose a constraint failure: violation rule, constraint name lookup in `pg_constraint`, deferred-vs-immediate timing.
- Migrate constraint semantics on PG18+: `NOT VALID` for `NOT NULL`, `ALTER CONSTRAINT ... [NO] INHERIT`, `NOT ENFORCED` for `CHECK` / FK, temporal constraints with `WITHOUT OVERLAPS` / `PERIOD`.

If you came here for FK referential actions (`ON DELETE CASCADE`, `SET NULL`, `RESTRICT` vs `NO ACTION`), the partitioned-table FK rules, or self-referencing/circular FK patterns: skip ahead to [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).


## Mental Model


PostgreSQL constraints follow five rules that drive almost every recipe and gotcha downstream:

1. **There are six constraint kinds.** `CHECK`, `NOT NULL`, `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY`, and `EXCLUDE`. Every other "constraint-like" mechanism (triggers, RLS, generated columns) is a different feature with different semantics. `NOT NULL` is functionally a special-case `CHECK (col IS NOT NULL)` but has its own catalog representation for efficiency [^pg16-notnull].

2. **`CHECK` and `NOT NULL` propagate through inheritance; the other four do not.** `UNIQUE`, `PRIMARY KEY`, and `FOREIGN KEY` are *not* inherited — a parent's PK does not enforce uniqueness across children. Same with declarative partitioning: a partitioned-table PK must include every partition-key column (see [`35-partitioning.md`](./35-partitioning.md) gotcha #1). `CHECK` constraints can be marked `NO INHERIT` to scope them to a single relation [^pg16-cttable].

3. **`UNIQUE` allows multiple NULLs by default.** The docs put it bluntly: *"By default, two null values are not considered equal in this comparison. That means even in the presence of a unique constraint it is possible to store duplicate rows that contain a null value in at least one of the constrained columns"* [^pg16-unique]. Use `UNIQUE NULLS NOT DISTINCT` (PG15+) to treat NULLs as equal [^pg15-nulls]. Primary keys reject this combination on PG16+ [^pg16-pk-nulls].

4. **Only `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY`, and `EXCLUDE` can be deferrable.** `NOT NULL` and `CHECK` are *always* immediate — `SET CONSTRAINTS` cannot defer them [^pg16-deferrable] [^pg16-setcon]. Deferrable constraints fire at the end of the transaction unless explicitly set otherwise.

5. **`NOT VALID` + `VALIDATE CONSTRAINT` is the canonical online-migration pattern.** Adding a CHECK or FK constraint normally requires `ACCESS EXCLUSIVE` for a full table scan. `NOT VALID` lets you take a brief lock to install the constraint (future writes are enforced), then `VALIDATE CONSTRAINT` rescans the existing rows with only `SHARE UPDATE EXCLUSIVE` [^pg16-altertable-notes]. PG18 extends this to `NOT NULL` [^pg18-notnull-notvalid].


## Decision Matrix


| You want to enforce | Use | Avoid | Why |
|---|---|---|---|
| Required field | `NOT NULL` (column constraint) | `CHECK (col IS NOT NULL)` | More efficient; docs explicitly recommend NOT NULL [^pg16-notnull] |
| Domain rule (value range, format) | `CHECK (...)` | Trigger | Declarative, planner-visible, no race conditions |
| Single-column or single-tuple uniqueness | `UNIQUE` constraint | Triggers, application-level checks | Backed by B-tree index; concurrent-write safe |
| Subset uniqueness ("one active row per user") | `UNIQUE` partial **index** (CREATE UNIQUE INDEX ... WHERE) | Constraint with WHERE — does not exist for UNIQUE | UNIQUE constraints can't have a WHERE; promote a partial unique index instead |
| Treat NULL as equal in uniqueness check | `UNIQUE NULLS NOT DISTINCT` (PG15+) | Workaround with COALESCE-expression unique index | Built-in since PG15; cleaner and indexable [^pg15-nulls] |
| Primary key | `PRIMARY KEY` | Composite UNIQUE + NOT NULL | Same surface; PK marks the canonical row identity, used by FKs |
| Cross-table referential integrity | `FOREIGN KEY` | Triggers, application-level checks | Declarative; supports CASCADE/SET NULL/SET DEFAULT/RESTRICT |
| Non-overlapping time ranges or polygons | `EXCLUDE USING gist (col WITH operator)` | UNIQUE + triggers | Built for range overlap, polygon disjointness, IP non-collision [^pg16-exclude] |
| Defer FK check until COMMIT (circular FKs) | `DEFERRABLE INITIALLY DEFERRED` + `SET CONSTRAINTS` | Disable FK temporarily | Constraint stays enforced; just deferred [^pg16-deferrable] |
| Add CHECK/FK to a huge table without long lock | `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` | Single `ADD CONSTRAINT` (ACCESS EXCLUSIVE during scan) | NOT VALID skips scan; VALIDATE takes only SHARE UPDATE EXCLUSIVE [^pg16-altertable-notes] |
| Temporal uniqueness (non-overlapping ranges per key) on PG18 | `UNIQUE (id, valid_at WITHOUT OVERLAPS)` | Hand-rolled EXCLUDE | Built-in PG18 syntax; expands to EXCLUDE USING gist [^pg18-temporal] |
| Document-only constraint (skip enforcement, hint planner) on PG18 | `... CHECK (...) NOT ENFORCED` | Trigger that no-ops | PG18 added NOT ENFORCED for FK and CHECK [^pg18-notenforced] |

**Three smell signals** that you reached for the wrong constraint:

1. You wrote a `CHECK` constraint with a subquery — illegal; CHECK can only reference the current row. Use a trigger (and accept the race conditions) or model the rule with a FK.
2. You added `DEFERRABLE` to a `CHECK` or `NOT NULL` — silently ignored; only UNIQUE/PK/FK/EXCLUDE can defer. Reorder your DML instead.
3. You wrote `UNIQUE (email) WHERE deleted_at IS NULL` — illegal syntax; UNIQUE constraints can't have a WHERE. Use `CREATE UNIQUE INDEX ... WHERE` instead.


## Syntax / Mechanics


### The six constraint kinds


PostgreSQL has six constraint kinds, defined in the `ddl-constraints.html` chapter [^pg16-ddl-constraints]:

| Kind | Scope | Inherited? | Deferrable? | Lock to add |
|---|---|---|---|---|
| `CHECK` | per-row | Yes (unless `NO INHERIT`) | No | `ACCESS EXCLUSIVE` (or use `NOT VALID`) |
| `NOT NULL` | per-row, per-column | Yes (PG18 adds `NO INHERIT`) | No | `ACCESS EXCLUSIVE` (PG18 supports `NOT VALID`) |
| `UNIQUE` | multi-row | No | Yes | `ACCESS EXCLUSIVE` (briefly; long part is index build) |
| `PRIMARY KEY` | multi-row | No | Yes | `ACCESS EXCLUSIVE` |
| `FOREIGN KEY` | cross-table | No | Yes | `SHARE ROW EXCLUSIVE` (both sides) |
| `EXCLUDE` | multi-row | No | Yes | `ACCESS EXCLUSIVE` |

Verbatim from the constraints chapter:

> *"Constraints give you as much control over the data in your tables as you wish. If a user attempts to store data in a column that would violate a constraint, an error is raised. This applies even if the value came from the default value definition."* [^pg16-ddl-constraints]


### CHECK constraints


Verbatim definition:

> *"A check constraint is the most generic constraint type. It allows you to specify that the value in a certain column must satisfy a Boolean (truth-value) expression."* [^pg16-ddl-constraints]

Grammar (column constraint):

    CREATE TABLE products (
        product_no integer,
        name text,
        price numeric CHECK (price > 0),
        discounted_price numeric CHECK (discounted_price > 0),
        CHECK (price > discounted_price)
    );

CHECK can be inline on a column or written as a table constraint. The table form is required when the predicate references multiple columns.

**Rules and restrictions** [^pg16-cttable]:

- The expression must be `IMMUTABLE` (no `now()`, no subqueries, no references to other tables, no volatile functions).
- The expression may reference the system column `tableoid` but no other system column.
- A CHECK constraint can be marked `NO INHERIT` to scope it to one table only.

> [!NOTE] PostgreSQL 18
>
> PG18 allows CHECK constraints to be marked `NOT ENFORCED` — the database does not check them but may still use them for planner optimization where correctness is not affected. Useful for documentation, expensive checks, or migration windows [^pg18-notenforced].

**NULL handling.** A CHECK constraint passes when the expression returns `TRUE` or `NULL`. So `CHECK (price > 0)` *allows* a NULL price — to require non-null, add an explicit `NOT NULL` constraint or write the rule as `CHECK (price IS NOT NULL AND price > 0)`.


### NOT NULL constraints


Verbatim definition (PG16):

> *"A not-null constraint simply specifies that a column must not assume the null value."* [^pg16-ddl-constraints]

> *"A not-null constraint is functionally equivalent to creating a check constraint `CHECK (column_name IS NOT NULL)`, but in PostgreSQL creating an explicit not-null constraint is more efficient."* [^pg16-ddl-constraints]

Column-constraint form:

    CREATE TABLE products (
        product_no integer NOT NULL,
        name text NOT NULL,
        price numeric
    );

> [!NOTE] PostgreSQL 18
>
> Major changes to NOT NULL in PG18 [^pg18-notnull-store]:
>
> - `NOT NULL` is now stored in `pg_constraint` and can have an explicit name.
> - Table-constraint syntax is allowed: `NOT NULL product_no` (mainly for `pg_dump`).
> - Foreign tables can have `NOT NULL` constraints.
> - `NO INHERIT` is allowed on `NOT NULL` (PG≤17: not allowed).
> - `ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT` works for NOT NULL [^pg18-notnull-inherit].
> - `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL NOT VALID` is the canonical online-migration form [^pg18-notnull-notvalid].

On PG≤17, the only way to add a NOT NULL to a populated table is `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` — which takes `ACCESS EXCLUSIVE` and scans the table. The PG18 `NOT VALID` form lets you install the constraint immediately and validate later (see Recipe 8).


### UNIQUE constraints


Verbatim:

> *"Unique constraints ensure that the data contained in a column, or a group of columns, is unique among all the rows in the table."* [^pg16-unique]

> *"In general, a unique constraint is violated if there is more than one row in the table where the values of all of the columns included in the constraint are equal. By default, two null values are not considered equal in this comparison. That means even in the presence of a unique constraint it is possible to store duplicate rows that contain a null value in at least one of the constrained columns."* [^pg16-unique]

Grammar:

    -- Column constraint
    CREATE TABLE products (
        product_no integer UNIQUE,
        name text,
        price numeric
    );

    -- Table constraint (composite)
    CREATE TABLE orders (
        order_id integer,
        line_no integer,
        UNIQUE (order_id, line_no)
    );

**Backed by a B-tree index.** Adding a UNIQUE constraint creates a unique B-tree index. The index is what enforces uniqueness; the constraint is the catalog-level handle that names it.

> [!NOTE] PostgreSQL 15 — NULLS NOT DISTINCT
>
> Verbatim release-note quote: *"Allow unique constraints and indexes to treat NULL values as not distinct (Peter Eisentraut). Previously NULL entries were always treated as distinct values, but this can now be changed by creating constraints and indexes using UNIQUE NULLS NOT DISTINCT."* [^pg15-nulls]
>
>     CREATE TABLE users (
>         email text,
>         tenant_id integer,
>         UNIQUE NULLS NOT DISTINCT (email, tenant_id)
>     );
>
> With `NULLS NOT DISTINCT`, two rows with `(NULL, 5)` collide. The default (`NULLS DISTINCT`) treats them as distinct.

> [!WARNING] PG16: NULLS NOT DISTINCT not allowed on PRIMARY KEY
>
> Verbatim PG16 release note: *"Disallow NULLS NOT DISTINCT indexes for primary keys"* [^pg16-pk-nulls]. PG15 briefly allowed this combination; PG16+ rejects it. The rationale: a PK should never accept NULLs at all, so the NULL-treatment rule has no effect.


### PRIMARY KEY constraints


Verbatim:

> *"A primary key constraint indicates that a column, or group of columns, can be used as a unique identifier for rows in the table. This requires that the values be both unique and not null."* [^pg16-ddl-constraints]

> *"Adding a primary key will automatically create a unique B-tree index on the column or group of columns listed in the primary key, and will force the column(s) to be marked NOT NULL. A table can have at most one primary key. (There can be any number of unique and not-null constraints, which are functionally almost the same thing, but only one can be identified as the primary key.)"* [^pg16-ddl-constraints]

Grammar:

    -- Column constraint
    CREATE TABLE products (
        product_no integer PRIMARY KEY,
        name text
    );

    -- Composite
    CREATE TABLE order_lines (
        order_id integer,
        line_no integer,
        PRIMARY KEY (order_id, line_no)
    );

**Three semantic differences from UNIQUE + NOT NULL:**

1. Only one PK per table; many UNIQUEs allowed.
2. PK columns are auto-marked `NOT NULL`. UNIQUE allows NULLs unless you add `NOT NULL` separately.
3. PK is the default FK target if a child references the parent without naming columns.

**Promote an existing unique index to PK** without rewriting the table:

    ALTER TABLE products ADD CONSTRAINT products_pkey
        PRIMARY KEY USING INDEX products_pk_idx;

This briefly takes `ACCESS EXCLUSIVE` to mark columns NOT NULL (full-table scan to verify no NULLs unless the columns are already NOT NULL) [^pg16-altertable-notes].

> [!NOTE] PostgreSQL 17
>
> Partitioned tables can have identity columns (and therefore IDENTITY-driven PKs on partitioned tables work cleanly). See [`18-uuid-numeric-money.md`](./18-uuid-numeric-money.md) for the IDENTITY surface.

> [!NOTE] PostgreSQL 18
>
> Verbatim release-note quote: *"Require primary/foreign key relationships to use either deterministic collations or the same nondeterministic collations (Peter Eisentraut). The restore of a pg_dump, also used by pg_upgrade, will fail if these requirements are not met"* [^pg18-collations]. Audit cross-table FKs over text/varchar columns before upgrading.


### FOREIGN KEY constraints


Verbatim:

> *"A foreign key constraint specifies that the values in a column (or a group of columns) must match the values appearing in some row of another table. We say this maintains the referential integrity between two related tables."* [^pg16-fk]

> *"Restricting and cascading deletes are the two most common options. RESTRICT prevents deletion of a referenced row. NO ACTION means that if any referencing rows still exist when the constraint is checked, an error is raised; this is the default behavior if you do not specify anything. (The essential difference between these two choices is that NO ACTION allows the check to be deferred until later in the transaction, whereas RESTRICT does not.) CASCADE specifies that when a referenced row is deleted, row(s) referencing it should be automatically deleted as well. There are two other options: SET NULL and SET DEFAULT."* [^pg16-fk]

Grammar:

    CREATE TABLE orders (
        order_id bigserial PRIMARY KEY,
        customer_id bigint NOT NULL REFERENCES customers (customer_id)
            ON DELETE RESTRICT
            ON UPDATE CASCADE
    );

**MATCH modes.** Default is `MATCH SIMPLE`: a referencing row passes if *any* FK column is NULL. `MATCH FULL` requires *all* FK columns to be NULL or *all* non-NULL — no mix. `MATCH PARTIAL` is reserved but not implemented [^pg16-fk].

**Lock level.** `ADD FOREIGN KEY` takes `SHARE ROW EXCLUSIVE` on both the referencing and referenced table — not `ACCESS EXCLUSIVE`. Reads and other DDL on conflicting modes are blocked; concurrent SELECTs are not [^pg16-altertable-notes]. The full scan to verify existing rows is the slow part; use `NOT VALID` + `VALIDATE CONSTRAINT` (Recipe 6) to split it.

> [!NOTE] PostgreSQL 15 — column-list ON DELETE SET
>
> Verbatim release-note quote: *"Allow foreign key ON DELETE SET actions to affect only specified columns (Paul Martinez). Previously, all of the columns in the foreign key were always affected."* [^pg15-fk-cols]
>
>     CREATE TABLE shipments (
>         shipment_id bigint PRIMARY KEY,
>         primary_carrier_id bigint,
>         secondary_carrier_id bigint,
>         FOREIGN KEY (primary_carrier_id, secondary_carrier_id)
>             REFERENCES carriers (id1, id2)
>             ON DELETE SET NULL (primary_carrier_id)
>     );
>
> When a referenced row is deleted, only `primary_carrier_id` is set to NULL; `secondary_carrier_id` is left alone. The full deep dive is in [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).

> [!NOTE] PostgreSQL 18
>
> Three FK-related changes in PG18:
>
> 1. `NOT VALID` foreign keys allowed on partitioned tables [^pg18-notvalid-fk-part].
> 2. `NOT ENFORCED` for FK constraints — declarative documentation without runtime enforcement [^pg18-notenforced].
> 3. Temporal FKs via `PERIOD` clause (see Recipe 11) [^pg18-temporal].


### EXCLUDE constraints


Verbatim:

> *"Exclusion constraints ensure that if any two rows are compared on the specified columns or expressions using the specified operators, at least one of these operator comparisons will return false or null."* [^pg16-exclude]

> *"Adding an exclusion constraint will automatically create an index of the type specified in the constraint declaration."* [^pg16-exclude]

The canonical use case is non-overlapping time ranges (room reservations) or non-overlapping geometric regions. The constraint requires GiST or SP-GiST because `=` is the only operator B-tree supports; EXCLUDE typically uses `&&` (range overlap), `~~` (LIKE), or custom operators.

    CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed only because we mix = and &&

    CREATE TABLE reservation (
        room_id integer NOT NULL,
        period tstzrange NOT NULL,
        EXCLUDE USING gist (room_id WITH =, period WITH &&)
    );

A row passes if, for every pair compared, at least one of `room_id = other.room_id` or `period && other.period` returns false or null. Equivalently: no two rows in the same room have overlapping periods.

**btree_gist is only required when mixing operators.** A pure-range EXCLUDE — `EXCLUDE USING gist (period WITH &&)` — works without `btree_gist`. You need the extension only when mixing B-tree-only operators (`=`, `<`, `>`) with range/geometric operators in the same EXCLUDE clause. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for the GiST deep dive.

> [!NOTE] PostgreSQL 17
>
> Verbatim release-note quote: *"Allow exclusion constraints on partitioned tables (Paul A. Jungwirth). As long as exclusion constraints compare partition key columns for equality, other columns can use exclusion constraint-specific comparisons."* [^pg17-exclude-part] The partition-key-equality requirement is the same shape as the unique-constraint-must-include-partition-key rule.


### NOT VALID + VALIDATE CONSTRAINT


The canonical "online constraint migration" pattern. Quoted verbatim from the `sql-altertable.html` Notes section:

> *"Scanning a large table to verify a new foreign key or check constraint can take a long time, and other updates to the table are locked out until the ALTER TABLE ADD CONSTRAINT command is committed. The main purpose of the NOT VALID constraint option is to reduce the impact of adding a constraint on concurrent updates. With NOT VALID, the ADD CONSTRAINT command does not scan the table and can be committed immediately. After that, a VALIDATE CONSTRAINT command can be issued to verify that existing rows satisfy the constraint. The validation step does not need to lock out concurrent updates, since it knows that other transactions will be enforcing the constraint for rows that they insert or update; only pre-existing rows need to be checked. Hence, validation acquires only a SHARE UPDATE EXCLUSIVE lock on the table being altered. (If the constraint is a foreign key then a ROW SHARE lock is also required on the table referenced by the constraint.) In addition to improving concurrency, it can be useful to use NOT VALID and VALIDATE CONSTRAINT in cases where the table is known to contain pre-existing violations. Once the constraint is in place, no new violations can be inserted, and the existing problems can be corrected at leisure until VALIDATE CONSTRAINT finally succeeds."* [^pg16-altertable-notes]

**Two-step pattern:**

    -- Step 1: install the constraint, do NOT scan existing rows
    ALTER TABLE orders
        ADD CONSTRAINT orders_total_positive
        CHECK (total > 0) NOT VALID;

    -- Step 2: validate (scan with SHARE UPDATE EXCLUSIVE)
    ALTER TABLE orders VALIDATE CONSTRAINT orders_total_positive;

**Eligibility:**

- PG≤17: `NOT VALID` only allowed for `CHECK` and `FOREIGN KEY` constraints.
- PG18+: `NOT VALID` allowed for `NOT NULL` as well [^pg18-notnull-notvalid].

**The constraint catalog flag.** A constraint in `NOT VALID` state has `pg_constraint.convalidated = false`. New writes are still rejected; only the historical-row scan is deferred.

**Use this pattern even when the table is clean.** If you know there are no violations, `NOT VALID` + `VALIDATE` still beats a single `ADD CONSTRAINT` on any production OLTP table: the constraint is installed in milliseconds (brief `ACCESS EXCLUSIVE`), and the scan runs under `SHARE UPDATE EXCLUSIVE` which does not block writes.


### DEFERRABLE and SET CONSTRAINTS


Verbatim:

> *"This controls whether the constraint can be deferred. A constraint that is not deferrable will be checked immediately after every command. Checking of constraints that are deferrable can be postponed until the end of the transaction (using the SET CONSTRAINTS command). NOT DEFERRABLE is the default. Currently, only UNIQUE, PRIMARY KEY, EXCLUDE, and REFERENCES (foreign key) constraints accept this clause. NOT NULL and CHECK constraints are not deferrable. Note that deferrable constraints cannot be used as conflict arbiters in an INSERT statement that includes an ON CONFLICT clause."* [^pg16-deferrable]

> *"If a constraint is deferrable, this clause specifies the default time to check the constraint. If the constraint is INITIALLY IMMEDIATE, it is checked after each statement. This is the default. If the constraint is INITIALLY DEFERRED, it is checked only at the end of the transaction."* [^pg16-deferrable]

**Three constraint-modes**, set at constraint-creation time [^pg16-setcon]:

| Mode | Default check time | `SET CONSTRAINTS` can change? |
|---|---|---|
| `NOT DEFERRABLE` (default) | After each statement | No |
| `DEFERRABLE INITIALLY IMMEDIATE` | After each statement | Yes — to DEFERRED |
| `DEFERRABLE INITIALLY DEFERRED` | At transaction COMMIT | Yes — to IMMEDIATE |

**`SET CONSTRAINTS` grammar:**

    SET CONSTRAINTS { ALL | name [, ...] } { DEFERRED | IMMEDIATE };

**Three semantic rules** to remember [^pg16-setcon]:

1. `SET CONSTRAINTS` only affects the current transaction. Outside a transaction block it emits a warning and does nothing.
2. Switching from DEFERRED to IMMEDIATE *retroactively* checks any outstanding violations. If there are any, the `SET CONSTRAINTS` command itself fails and the constraint mode is unchanged.
3. `NOT NULL` and `CHECK` are *always* checked immediately, regardless of `SET CONSTRAINTS`. Same for non-deferrable UNIQUE/EXCLUDE.

**Canonical use case: circular foreign keys.**

    CREATE TABLE employees (
        emp_id bigint PRIMARY KEY,
        manager_id bigint,
        FOREIGN KEY (manager_id) REFERENCES employees (emp_id)
            DEFERRABLE INITIALLY DEFERRED
    );

    BEGIN;
    INSERT INTO employees (emp_id, manager_id) VALUES (1, 2);  -- not yet violation
    INSERT INTO employees (emp_id, manager_id) VALUES (2, 1);  -- not yet violation
    COMMIT;  -- FK checked here; both rows exist, both pass

Without the `INITIALLY DEFERRED`, the first INSERT fails immediately because emp_id 2 doesn't exist yet.


### ALTER CONSTRAINT


Verbatim:

> *"This form alters the attributes of a constraint that was previously created. Currently only foreign key constraints may be altered."* [^pg16-altertable-notes]

Grammar (PG≤17):

    ALTER TABLE table_name
        ALTER CONSTRAINT constraint_name
        [ DEFERRABLE | NOT DEFERRABLE ]
        [ INITIALLY DEFERRED | INITIALLY IMMEDIATE ];

PG≤17: only the deferrable/initial attributes of FK constraints can be changed. To change anything else (e.g., the check expression), you must `DROP CONSTRAINT` + `ADD CONSTRAINT`.

> [!NOTE] PostgreSQL 18 — `ALTER CONSTRAINT [NO] INHERIT`
>
> Verbatim release-note quote: *"Allow modification of the inheritability of NOT NULL constraints (Suraj Kharage, Álvaro Herrera). The syntax is `ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT`."* [^pg18-notnull-inherit] This applies only to NOT NULL — the inheritability of CHECK constraints is fixed at creation time.


### Generated columns and constraints


Verbatim definition:

> *"A generated column is a special column that is always computed from other columns. ... A stored generated column is computed when it is written (inserted or updated) and occupies storage as if it were a normal column. A virtual generated column occupies no storage and is computed when it is read. ... PostgreSQL currently implements only stored generated columns."* (PG16) [^pg16-gencol]

PG16 restrictions on generated columns [^pg16-gencol]:

- The generation expression must be `IMMUTABLE`.
- Cannot reference another generated column.
- Cannot reference any system column except `tableoid`.
- Cannot have a `DEFAULT` clause or an identity definition.
- Cannot be part of a partition key.

> [!NOTE] PostgreSQL 18 — virtual generated columns by default
>
> Verbatim release-note quote: *"Allow generated columns to be virtual, and make them the default (Peter Eisentraut, Jian He, Richard Guo, Dean Rasheed). Virtual generated columns generate their values when the columns are read, not written. The write behavior can still be specified via the STORED option."* [^pg18-virtual]
>
> Virtual generated columns occupy no storage; they are computed on every read. The PG18 grammar adds `[ STORED | VIRTUAL ]` with `VIRTUAL` as the default. Virtual generated columns cannot have user-defined types and the expression cannot reference user-defined functions or types.

**Generated columns and CHECK constraints.** You can add a CHECK constraint that references a generated column (stored or virtual), and the CHECK fires every time the row is written. You cannot reference a generated column from a FOREIGN KEY's referencing-side; you can reference a generated column from a referenced-table PK (stored only; virtual columns can't have indexes that back constraints on PG18).


### Lock-level matrix


This is the canonical matrix for constraint DDL. Lock levels come from `sql-altertable.html` and the Notes section [^pg16-altertable-notes]:

| Command | Lock on this table | Lock on referenced table | Notes |
|---|---|---|---|
| `ALTER TABLE ADD CONSTRAINT CHECK (...)` (no NOT VALID) | `ACCESS EXCLUSIVE` | — | Scans all rows during the holding window |
| `ALTER TABLE ADD CONSTRAINT CHECK (...) NOT VALID` | `ACCESS EXCLUSIVE` | — | No scan; brief lock |
| `ALTER TABLE ADD CONSTRAINT FOREIGN KEY ...` (no NOT VALID) | `SHARE ROW EXCLUSIVE` | `SHARE ROW EXCLUSIVE` | Less restrictive than ACCESS EXCLUSIVE |
| `ALTER TABLE ADD CONSTRAINT FOREIGN KEY ... NOT VALID` | `SHARE ROW EXCLUSIVE` | `SHARE ROW EXCLUSIVE` | No scan; brief lock |
| `ALTER TABLE ADD CONSTRAINT UNIQUE (...)` | `ACCESS EXCLUSIVE` | — | Builds B-tree index inline; for huge tables, use `CREATE UNIQUE INDEX CONCURRENTLY` then `ADD CONSTRAINT USING INDEX` |
| `ALTER TABLE ADD CONSTRAINT PRIMARY KEY (...)` | `ACCESS EXCLUSIVE` | — | Builds B-tree; sets columns NOT NULL |
| `ALTER TABLE ADD CONSTRAINT PRIMARY KEY USING INDEX idx` | `ACCESS EXCLUSIVE` (brief) | — | Promotes existing index; takes NOT NULL check on columns if needed |
| `ALTER TABLE ADD CONSTRAINT EXCLUDE ...` | `ACCESS EXCLUSIVE` | — | Builds GiST/SP-GiST index inline |
| `ALTER TABLE VALIDATE CONSTRAINT name` | `SHARE UPDATE EXCLUSIVE` | `ROW SHARE` (FK only) | Scans existing rows but does not block writes |
| `ALTER TABLE DROP CONSTRAINT name` | `ACCESS EXCLUSIVE` | — | Drops associated index for UNIQUE/PK/EXCLUDE |
| `ALTER TABLE ALTER CONSTRAINT name DEFERRABLE` | `ACCESS EXCLUSIVE` | — | Catalog-only change but takes full lock |
| `ALTER TABLE ALTER COLUMN ... SET NOT NULL` (PG≤17) | `ACCESS EXCLUSIVE` | — | Full table scan during lock |
| `ALTER TABLE ALTER COLUMN ... SET NOT NULL NOT VALID` (PG18+) | `ACCESS EXCLUSIVE` (brief) | — | No scan; brief lock |
| `SET CONSTRAINTS ...` | none | none | Affects current transaction only |

Cross-reference: [`43-locking.md`](./43-locking.md) has the full lock-conflict matrix.


### Per-version timeline


| Version | Constraint change | Source |
|---|---|---|
| **PG14** | No end-user constraint feature changes. Only internal: PK/UNIQUE/FK added to system catalogs. | [^pg14-syscat] |
| **PG15** | `UNIQUE NULLS NOT DISTINCT` for constraints and indexes. `ON DELETE SET (col_list)` for FKs. | [^pg15-nulls] [^pg15-fk-cols] |
| **PG16** | `NULLS NOT DISTINCT` disallowed for primary keys. | [^pg16-pk-nulls] |
| **PG17** | Exclusion constraints on partitioned tables (with partition-key-equality requirement). | [^pg17-exclude-part] |
| **PG18** | **Major rewrite of NOT NULL:** stored in `pg_constraint`, explicit names, `NO INHERIT`, table-constraint syntax, `NOT VALID` for NOT NULL. `NOT ENFORCED` for CHECK and FK. **Virtual generated columns** (default). **Temporal constraints:** `WITHOUT OVERLAPS` and `PERIOD`. `ALTER CONSTRAINT [NO] INHERIT` for NOT NULL. `NOT VALID` FK on partitioned tables. `DROP CONSTRAINT ONLY` on partitioned tables. PK/FK collation determinism rule. | [^pg18-notnull-store] [^pg18-notnull-notvalid] [^pg18-notenforced] [^pg18-virtual] [^pg18-temporal] [^pg18-notnull-inherit] [^pg18-notvalid-fk-part] [^pg18-drop-only] [^pg18-collations] |


## Examples / Recipes


### Recipe 1: Adding a CHECK constraint to a large table without blocking writes


    -- Step 1: install the constraint NOT VALID (brief ACCESS EXCLUSIVE)
    ALTER TABLE events
        ADD CONSTRAINT events_severity_valid
        CHECK (severity BETWEEN 0 AND 9) NOT VALID;

    -- Step 2: scan existing rows under SHARE UPDATE EXCLUSIVE (writes proceed)
    ALTER TABLE events VALIDATE CONSTRAINT events_severity_valid;

The `NOT VALID` form takes `ACCESS EXCLUSIVE` only long enough to write the catalog row. New inserts and updates are immediately rejected if they violate. The scan in step 2 acquires `SHARE UPDATE EXCLUSIVE`, which does not block reads or writes (only conflicting DDL).

If step 2 fails with `ERROR: check constraint "events_severity_valid" is violated`, the constraint stays NOT VALID and continues to enforce on new writes. Find the violating rows:

    SELECT * FROM events WHERE NOT (severity BETWEEN 0 AND 9);


### Recipe 2: Adding a foreign key to a large table without blocking writes


    -- Brief SHARE ROW EXCLUSIVE on both tables
    ALTER TABLE orders
        ADD CONSTRAINT orders_customer_fk
        FOREIGN KEY (customer_id) REFERENCES customers (customer_id) NOT VALID;

    -- Scan with SHARE UPDATE EXCLUSIVE on orders + ROW SHARE on customers
    ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_fk;

This is the safest way to introduce a FK to a populated table.


### Recipe 3: Online PRIMARY KEY via USING INDEX


Creating a PK normally takes `ACCESS EXCLUSIVE` for the full B-tree build. The workaround:

    -- Step 1: build the unique index concurrently (no ACCESS EXCLUSIVE)
    CREATE UNIQUE INDEX CONCURRENTLY orders_pkey_idx ON orders (order_id);

    -- Step 2: ensure column is NOT NULL (also concurrently if needed)
    ALTER TABLE orders ALTER COLUMN order_id SET NOT NULL;  -- ACCESS EXCLUSIVE, brief scan

    -- Step 3: promote the existing index to PK (brief ACCESS EXCLUSIVE)
    ALTER TABLE orders ADD CONSTRAINT orders_pkey
        PRIMARY KEY USING INDEX orders_pkey_idx;

The `USING INDEX` form requires a unique B-tree with no expression columns, no partial index, default sort order, and matching column set. PG18 NOT NULL `NOT VALID` lets you skip the table scan in step 2 if you can validate later.


### Recipe 4: UNIQUE NULLS NOT DISTINCT for soft-delete-aware uniqueness


Pre-PG15 pattern: `CREATE UNIQUE INDEX ... ON users (email) WHERE deleted_at IS NULL` and a separate uniqueness rule for deleted rows.

PG15+ alternative when the schema is `(email, deleted_at)` and you want NULL `deleted_at` rows to compete with each other:

    CREATE TABLE users (
        user_id bigserial PRIMARY KEY,
        email text NOT NULL,
        deleted_at timestamptz,
        UNIQUE NULLS NOT DISTINCT (email, deleted_at)
    );

Two rows with `('alice@example.com', NULL)` collide because the NULLs are treated as equal. After deletion, `deleted_at = '2026-05-11 10:00:00+00'` makes them distinct.


### Recipe 5: Non-overlapping reservations with EXCLUDE


    CREATE EXTENSION IF NOT EXISTS btree_gist;  -- because we mix = and &&

    CREATE TABLE bookings (
        booking_id bigserial PRIMARY KEY,
        room_id integer NOT NULL,
        period tstzrange NOT NULL,
        guest_name text NOT NULL,
        EXCLUDE USING gist (room_id WITH =, period WITH &&)
    );

    INSERT INTO bookings (room_id, period, guest_name)
        VALUES (101, '[2026-05-11 14:00, 2026-05-12 11:00)', 'Alice');

    -- This fails — same room, overlapping period
    INSERT INTO bookings (room_id, period, guest_name)
        VALUES (101, '[2026-05-11 18:00, 2026-05-13 11:00)', 'Bob');
    -- ERROR: conflicting key value violates exclusion constraint "bookings_room_id_period_excl"

The error includes both the conflicting row and the new row in the DETAIL line.


### Recipe 6: Audit existing NOT VALID constraints


Find every `NOT VALID` constraint in a database. These are constraints that enforce future writes but have not yet certified existing rows:

    SELECT
        n.nspname AS schema,
        c.relname AS table,
        con.conname AS constraint,
        CASE con.contype
            WHEN 'c' THEN 'CHECK'
            WHEN 'f' THEN 'FOREIGN KEY'
            WHEN 'n' THEN 'NOT NULL'  -- PG18+
        END AS kind,
        pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT con.convalidated
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname, con.conname;

Each row is a constraint where you should consider running `ALTER TABLE ... VALIDATE CONSTRAINT ...` during a low-write window.


### Recipe 7: Circular FKs with deferred constraint


    CREATE TABLE departments (
        dept_id bigint PRIMARY KEY,
        head_emp_id bigint
    );

    CREATE TABLE employees (
        emp_id bigint PRIMARY KEY,
        dept_id bigint NOT NULL REFERENCES departments (dept_id)
            DEFERRABLE INITIALLY DEFERRED
    );

    ALTER TABLE departments
        ADD CONSTRAINT departments_head_fk
        FOREIGN KEY (head_emp_id) REFERENCES employees (emp_id)
            DEFERRABLE INITIALLY DEFERRED;

    BEGIN;
    INSERT INTO departments (dept_id, head_emp_id) VALUES (1, 100);  -- FK deferred
    INSERT INTO employees (emp_id, dept_id) VALUES (100, 1);          -- FK deferred
    COMMIT;  -- Both FKs checked here, both pass

Without `INITIALLY DEFERRED`, the first INSERT fails because `head_emp_id = 100` doesn't exist yet.


### Recipe 8: PG18 — add NOT NULL to a large table without scanning


On PG≤17, `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` takes `ACCESS EXCLUSIVE` and scans the table. PG18 fixes this:

    -- PG18+: brief ACCESS EXCLUSIVE, no scan
    ALTER TABLE events
        ALTER COLUMN occurred_at SET NOT NULL NOT VALID;

    -- Validate later under SHARE UPDATE EXCLUSIVE
    ALTER TABLE events VALIDATE CONSTRAINT events_occurred_at_not_null;

Per [^pg18-notnull-notvalid], the NOT NULL is stored in `pg_constraint` with a name (auto-generated unless you specify). The validation step uses `SHARE UPDATE EXCLUSIVE` like every other `VALIDATE CONSTRAINT`.

**Pre-PG18 alternative:** add the NOT NULL as a CHECK constraint with NOT VALID:

    -- PG≤17 workaround
    ALTER TABLE events
        ADD CONSTRAINT events_occurred_at_not_null
        CHECK (occurred_at IS NOT NULL) NOT VALID;

    ALTER TABLE events VALIDATE CONSTRAINT events_occurred_at_not_null;

This is functionally equivalent but produces an explicit CHECK constraint rather than a NOT NULL column attribute. The CHECK form is what the SQL standard calls a "table check constraint" and works on every version since PG9.x.


### Recipe 9: Naming all your constraints


The default constraint name is generated from the table and column (e.g., `orders_customer_id_fkey`). Naming explicitly makes migrations readable and lets you `ALTER` or `DROP` by name:

    CREATE TABLE orders (
        order_id bigserial,
        customer_id bigint NOT NULL,
        total numeric NOT NULL,

        CONSTRAINT orders_pkey PRIMARY KEY (order_id),
        CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id)
            REFERENCES customers (customer_id),
        CONSTRAINT orders_total_positive CHECK (total > 0)
    );

The default-naming convention to mimic: `{table}_{column}_{suffix}` where the suffix is `pkey`, `key` (UNIQUE), `fkey` (FK), `check` (CHECK), `excl` (EXCLUDE). Using the convention keeps `\d table` output sortable.


### Recipe 10: Switch a deferrable constraint mid-transaction


    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;  -- defer everything deferrable

    -- ... bulk DML across multiple referencing tables ...

    SET CONSTRAINTS ALL IMMEDIATE;  -- force check now; raises if anything violates
    -- If we reach here, everything passes; commit
    COMMIT;

If `SET CONSTRAINTS ALL IMMEDIATE` raises (because there's a pending violation), you can stay in the transaction, fix the offending row, and run `SET CONSTRAINTS ALL IMMEDIATE` again. Or you can `ROLLBACK`.


### Recipe 11: PG18 temporal constraints — non-overlapping prices per product


Pre-PG18: use EXCLUDE with btree_gist.

PG18+: native temporal grammar.

    CREATE TABLE prices (
        product_id bigint NOT NULL,
        price numeric NOT NULL,
        valid_at tstzrange NOT NULL,
        PRIMARY KEY (product_id, valid_at WITHOUT OVERLAPS)
    );

The verbatim grammar quote: *"UNIQUE (id, valid_at WITHOUT OVERLAPS) behaves like EXCLUDE USING GIST (id WITH =, valid_at WITH &&)"* [^pg18-temporal]. Same semantics, more declarative.

Temporal FK example:

    CREATE TABLE price_history (
        product_id bigint NOT NULL,
        currency_id integer NOT NULL,
        valid_at tstzrange NOT NULL,
        FOREIGN KEY (currency_id, PERIOD valid_at) REFERENCES currencies (currency_id, valid_at),
        PRIMARY KEY (product_id, currency_id, valid_at WITHOUT OVERLAPS)
    );

The FK is satisfied if the referenced table has rows whose combined `valid_at` ranges *completely cover* the referencing row's range.


### Recipe 12: PG18 NOT ENFORCED for documentation-only constraints


    -- A check we know to be true (data-quality cleanup pending) but cannot enforce yet
    ALTER TABLE legacy_events
        ADD CONSTRAINT legacy_events_severity_valid
        CHECK (severity BETWEEN 0 AND 9) NOT ENFORCED;

    -- Planner can use this for optimization where correctness is unaffected
    -- New writes are NOT rejected even if they violate

Verbatim: *"If the constraint is NOT ENFORCED, the database system will not check the constraint. ... The database system might still assume that the data actually satisfies the constraint for optimization decisions where this does not affect the correctness of the result."* [^pg18-notenforced]

Currently only `CHECK` and `FOREIGN KEY` can be `NOT ENFORCED`.


### Recipe 13: Catalog audit for tables missing constraints


Tables without a primary key (cross-reference [`22-indexes-overview.md`](./22-indexes-overview.md) Recipe 1):

    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con
          WHERE con.conrelid = c.oid AND con.contype = 'p'
      )
    ORDER BY n.nspname, c.relname;

Foreign keys without a covering index on the child side (delete-on-parent will be slow):

    SELECT
        n.nspname,
        c.relname AS child_table,
        con.conname,
        pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f'
      AND NOT EXISTS (
          SELECT 1 FROM pg_index ix
          WHERE ix.indrelid = con.conrelid
            AND (ix.indkey::int[])[0 : array_length(con.conkey, 1) - 1] @> con.conkey::int[]
      )
    ORDER BY n.nspname, c.relname;


## Gotchas / Anti-patterns


1. **`CHECK` accepts NULL as passing.** A constraint `CHECK (price > 0)` allows a NULL price because `NULL > 0` evaluates to NULL, which the constraint treats as not-false. To require positive *and* present, write `CHECK (price IS NOT NULL AND price > 0)` or add a separate `NOT NULL`.

2. **`UNIQUE` allows multiple NULLs by default.** Verbatim docs: *"By default, two null values are not considered equal in this comparison."* [^pg16-unique] Use `NULLS NOT DISTINCT` (PG15+) or `COALESCE` in a unique index expression.

3. **`UNIQUE NULLS NOT DISTINCT` is not allowed on PRIMARY KEY.** PG16+ rejects this combination [^pg16-pk-nulls]. The PG15 syntax allowed it; PG16 forbids it because a PK column is already NOT NULL.

4. **`NOT DEFERRABLE` is the default for all constraints.** If you forget to write `DEFERRABLE`, you can't `SET CONSTRAINTS ... DEFERRED` later. The constraint must be created with `DEFERRABLE` at the start; `ALTER CONSTRAINT` can change the *initial* mode but only for FKs and only if the constraint was created deferrable.

5. **`NOT NULL` and `CHECK` are never deferrable.** Even if you write `DEFERRABLE` next to a `CHECK`, it's silently meaningless (the grammar accepts it but the constraint is always immediate). Verbatim: *"NOT NULL and CHECK constraints are always checked immediately when a row is inserted or modified (not at the end of the statement)."* [^pg16-setcon]

6. **`ALTER CONSTRAINT` works on FK only, pre-PG18.** To change a CHECK constraint's expression, you must drop and recreate. PG18 added `ALTER CONSTRAINT [NO] INHERIT` but only for NOT NULL [^pg18-notnull-inherit].

7. **`CREATE UNIQUE INDEX CONCURRENTLY` doesn't create a UNIQUE constraint.** The index alone enforces uniqueness, but the catalog has no `pg_constraint` row. Use `ALTER TABLE ... ADD CONSTRAINT ... USING INDEX` to promote.

8. **`ADD CONSTRAINT FOREIGN KEY` takes `SHARE ROW EXCLUSIVE`, not `ACCESS EXCLUSIVE`.** [^pg16-altertable-notes] This is the most often-misquoted lock level. Reads are not blocked; only conflicting DDL and `SHARE` modes higher. Concurrent SELECT/INSERT/UPDATE/DELETE proceed.

9. **`VALIDATE CONSTRAINT` does not parallelize.** The full-table scan runs single-threaded. On a 1 TB table this can take hours. Schedule it during a low-write window.

10. **`SET CONSTRAINTS` outside a transaction emits a warning and does nothing.** [^pg16-setcon] Always wrap in `BEGIN; ... COMMIT;` even when there's a single statement.

11. **`ON CONFLICT` cannot use a deferred constraint as the arbiter.** The verbatim rule: *"deferrable constraints cannot be used as conflict arbiters in an INSERT statement that includes an ON CONFLICT clause."* [^pg16-deferrable] If you need both upsert and deferral, restructure or rebuild the index as non-deferrable.

12. **CHECK can't reference other tables.** No subqueries, no other relations. The expression sees only the current row and the table itself (via `tableoid`). Use a FK or a trigger for cross-table rules.

13. **CHECK expressions must be IMMUTABLE.** No `now()`, no `random()`, no STABLE functions, no user-defined VOLATILE functions. The CHECK is re-evaluated only at write time, but PG requires deterministic evaluability for index-expression and dump-restore compatibility.

14. **`ALTER COLUMN SET NOT NULL` is `ACCESS EXCLUSIVE` + scan on PG≤17.** Use the PG18 `NOT VALID` form (Recipe 8) or the PG≤17 CHECK-constraint workaround.

15. **EXCLUDE constraints have per-insert lookup costs.** Every insert checks against the GiST/SP-GiST index. For very-high-write workloads (>10K/s sustained), profile EXCLUDE inserts before committing to the pattern. Cross-reference [`35-partitioning.md`](./35-partitioning.md) for mitigation via partition keys.

16. **`btree_gist` extension is only required for *mixed* operator EXCLUDE.** A pure-range EXCLUDE (`period WITH &&` only) works without it. Don't install `btree_gist` reflexively.

17. **`ALTER TABLE ... ADD CONSTRAINT name UNIQUE (col) USING INDEX idx` requires column-set match.** The index columns must exactly match the constraint columns in order, and the index must be unique B-tree with default sort and no WHERE.

18. **`NULLS NOT DISTINCT` and `NULLS DISTINCT` are part of the constraint syntax, not the index syntax (on PG15).** The clause is `UNIQUE NULLS NOT DISTINCT`, not `UNIQUE (col) NULLS NOT DISTINCT` — placement matters in older parsers.

19. **`pg_constraint.contype` codes are single letters.** `c` CHECK, `f` FK, `n` NOT NULL (PG18+), `p` PK, `t` constraint trigger (legacy), `u` UNIQUE, `x` EXCLUDE. Audit queries that filter by `contype` should switch on these values.

20. **`pg_constraint` rows for NOT NULL only exist on PG18+.** Pre-PG18, NOT NULL was stored only in `pg_attribute.attnotnull` (a boolean). On PG≤17, querying `pg_constraint` for NOT NULL constraints returns zero rows. Use `pg_attribute.attnotnull` for cross-version compatibility.

21. **`NOT ENFORCED` is opt-in even when planner could benefit.** PG18+ allows `NOT ENFORCED` for CHECK and FK but does not retroactively apply to existing constraints. You must explicitly recreate them. The planner uses `NOT ENFORCED` constraints for optimization only when it doesn't affect correctness [^pg18-notenforced].

22. **PG18 PK/FK collation rule can break pg_upgrade.** Verbatim: *"The restore of a pg_dump, also used by pg_upgrade, will fail if these requirements are not met; schema changes must be made for these upgrade methods to succeed."* [^pg18-collations] Audit FKs over text/varchar columns and confirm both sides use deterministic collations OR the same nondeterministic collation before upgrading to PG18.

23. **`DEFERRABLE` doesn't make UNIQUE behave differently with `ON CONFLICT`.** Same gotcha as #11 but specifically: many teams add `DEFERRABLE` thinking it relaxes uniqueness checking inside a statement. It doesn't. INSERT statements check uniqueness row-by-row regardless; `DEFERRABLE` only matters for cross-statement timing.


## See Also


- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — full `CREATE TABLE` / `ALTER TABLE` grammar with lock matrix
- [`15-data-types-custom.md`](./15-data-types-custom.md) — domain CHECK constraints + range types underpinning EXCLUDE
- [`22-indexes-overview.md`](./22-indexes-overview.md) — UNIQUE constraints as B-tree indexes; partial unique indexes
- [`23-btree-indexes.md`](./23-btree-indexes.md) — `NULLS NOT DISTINCT` mechanics at the index level
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — EXCLUDE with GiST and `btree_gist`
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... USING INDEX` pattern
- [`35-partitioning.md`](./35-partitioning.md) — partition-key-must-be-in-PK rule; PG17 EXCLUDE on partitioned tables
- [`36-inheritance.md`](./36-inheritance.md) — what propagates through inheritance (CHECK and NOT NULL) vs what doesn't
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — referential actions, MATCH modes, FK-on-partitioned, FK-referencing-partitioned, circular FKs
- [`39-triggers.md`](./39-triggers.md) — when triggers are appropriate alternatives to CHECK (cross-table rules)
- [`41-transactions.md`](./41-transactions.md) — DEFERRABLE constraint behavior within explicit transaction blocks; SET CONSTRAINTS semantics.
- [`42-isolation-levels.md`](./42-isolation-levels.md) — DEFERRABLE / INITIALLY DEFERRED constraint checking varies by isolation level.
- [`43-locking.md`](./43-locking.md) — full lock-conflict matrix
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_constraint` schema and joining to `pg_class` / `pg_attribute`


## Sources


[^pg16-ddl-constraints]: PostgreSQL 16 docs, section 5.4 Constraints. Verbatim quotes throughout. https://www.postgresql.org/docs/16/ddl-constraints.html

[^pg16-cttable]: PostgreSQL 16 docs, `CREATE TABLE`. Full column-constraint and table-constraint grammar including `NO INHERIT`, `DEFERRABLE`, `INITIALLY DEFERRED / IMMEDIATE`, `NULLS [NOT] DISTINCT`. https://www.postgresql.org/docs/16/sql-createtable.html

[^pg16-unique]: PostgreSQL 16 docs, section 5.4.3 Unique Constraints. *"In general, a unique constraint is violated if there is more than one row in the table where the values of all of the columns included in the constraint are equal. By default, two null values are not considered equal in this comparison. That means even in the presence of a unique constraint it is possible to store duplicate rows that contain a null value in at least one of the constrained columns."* https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS

[^pg16-notnull]: PostgreSQL 16 docs, section 5.4.2 Not-Null Constraints. *"A not-null constraint simply specifies that a column must not assume the null value. ... A not-null constraint is functionally equivalent to creating a check constraint CHECK (column_name IS NOT NULL), but in PostgreSQL creating an explicit not-null constraint is more efficient."* https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-NOT-NULL

[^pg16-fk]: PostgreSQL 16 docs, section 5.4.5 Foreign Keys. Full referential-action description quoted in body. https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-FK

[^pg16-exclude]: PostgreSQL 16 docs, section 5.4.6 Exclusion Constraints. *"Exclusion constraints ensure that if any two rows are compared on the specified columns or expressions using the specified operators, at least one of these operator comparisons will return false or null."* https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-EXCLUSION

[^pg16-deferrable]: PostgreSQL 16 docs, `CREATE TABLE`, DEFERRABLE clause. *"NOT DEFERRABLE is the default. Currently, only UNIQUE, PRIMARY KEY, EXCLUDE, and REFERENCES (foreign key) constraints accept this clause. NOT NULL and CHECK constraints are not deferrable. Note that deferrable constraints cannot be used as conflict arbiters in an INSERT statement that includes an ON CONFLICT clause."* https://www.postgresql.org/docs/16/sql-createtable.html

[^pg16-setcon]: PostgreSQL 16 docs, `SET CONSTRAINTS`. *"SET CONSTRAINTS sets the behavior of constraint checking within the current transaction. IMMEDIATE constraints are checked at the end of each statement. DEFERRED constraints are not checked until transaction commit."* Plus: *"NOT NULL and CHECK constraints are always checked immediately when a row is inserted or modified (not at the end of the statement). Uniqueness and exclusion constraints that have not been declared DEFERRABLE are also checked immediately."* https://www.postgresql.org/docs/16/sql-set-constraints.html

[^pg16-altertable-notes]: PostgreSQL 16 docs, `ALTER TABLE` Notes section. Lock levels and full NOT VALID + VALIDATE CONSTRAINT rationale quoted verbatim. *"Although most forms of ADD table_constraint require an ACCESS EXCLUSIVE lock, ADD FOREIGN KEY requires only a SHARE ROW EXCLUSIVE lock."* and *"[VALIDATE CONSTRAINT] acquires a SHARE UPDATE EXCLUSIVE lock on the table being altered."* https://www.postgresql.org/docs/16/sql-altertable.html

[^pg16-gencol]: PostgreSQL 16 docs, section 5.3 Generated Columns. *"PostgreSQL currently implements only stored generated columns."* And the list of restrictions. https://www.postgresql.org/docs/16/ddl-generated-columns.html

[^pg14-syscat]: PostgreSQL 14 release notes. *"Add primary keys, unique constraints, and foreign keys to system catalogs (Peter Eisentraut). The existing unique indexes of catalogs now have associated UNIQUE or PRIMARY KEY constraints. Foreign key relationships are not actually stored or implemented as constraints, but can be obtained for display from the function pg_get_catalog_foreign_keys()."* Only constraint-related PG14 change. https://www.postgresql.org/docs/release/14.0/

[^pg15-nulls]: PostgreSQL 15 release notes. *"Allow unique constraints and indexes to treat NULL values as not distinct (Peter Eisentraut). Previously NULL entries were always treated as distinct values, but this can now be changed by creating constraints and indexes using UNIQUE NULLS NOT DISTINCT."* https://www.postgresql.org/docs/release/15.0/

[^pg15-fk-cols]: PostgreSQL 15 release notes. *"Allow foreign key ON DELETE SET actions to affect only specified columns (Paul Martinez). Previously, all of the columns in the foreign key were always affected."* https://www.postgresql.org/docs/release/15.0/

[^pg16-pk-nulls]: PostgreSQL 16 release notes. *"Disallow NULLS NOT DISTINCT indexes for primary keys (Daniel Gustafsson)"* https://www.postgresql.org/docs/release/16.0/

[^pg17-exclude-part]: PostgreSQL 17 release notes. *"Allow exclusion constraints on partitioned tables (Paul A. Jungwirth). As long as exclusion constraints compare partition key columns for equality, other columns can use exclusion constraint-specific comparisons."* https://www.postgresql.org/docs/release/17.0/

[^pg18-notnull-store]: PostgreSQL 18 release notes. *"Store column NOT NULL specifications in pg_constraint (Álvaro Herrera, Bernd Helmle). This allows names to be specified for NOT NULL constraint. This also adds NOT NULL constraints to foreign tables and NOT NULL inheritance control to local tables."* https://www.postgresql.org/docs/release/18.0/

[^pg18-notnull-notvalid]: PostgreSQL 18 release notes. *"Allow ALTER TABLE to set the NOT VALID attribute of NOT NULL constraints (Rushabh Lathia, Jian He)"* https://www.postgresql.org/docs/release/18.0/

[^pg18-notnull-inherit]: PostgreSQL 18 release notes. *"Allow modification of the inheritability of NOT NULL constraints (Suraj Kharage, Álvaro Herrera). The syntax is `ALTER TABLE ... ALTER CONSTRAINT ... [NO] INHERIT`."* https://www.postgresql.org/docs/release/18.0/

[^pg18-notenforced]: PostgreSQL 18 release notes. *"Allow CHECK and foreign key constraints to be specified as NOT ENFORCED (Amul Sul). This also adds column pg_constraint.conenforced."* Plus the verbatim CREATE TABLE quote: *"When the constraint is ENFORCED, then the database system will ensure that the constraint is satisfied ... If the constraint is NOT ENFORCED, the database system will not check the constraint."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/sql-createtable.html

[^pg18-virtual]: PostgreSQL 18 release notes. *"Allow generated columns to be virtual, and make them the default (Peter Eisentraut, Jian He, Richard Guo, Dean Rasheed). Virtual generated columns generate their values when the columns are read, not written. The write behavior can still be specified via the STORED option."* https://www.postgresql.org/docs/release/18.0/

[^pg18-temporal]: PostgreSQL 18 release notes. *"Allow the specification of non-overlapping PRIMARY KEY, UNIQUE, and foreign key constraints (Paul A. Jungwirth). This is specified by WITHOUT OVERLAPS for PRIMARY KEY and UNIQUE, and by PERIOD for foreign keys, all applied to the last specified column."* Plus the CREATE TABLE grammar quote: *"UNIQUE (id, valid_at WITHOUT OVERLAPS) behaves like EXCLUDE USING GIST (id WITH =, valid_at WITH &&)."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/sql-createtable.html

[^pg18-notvalid-fk-part]: PostgreSQL 18 release notes. *"Allow NOT VALID foreign key constraints on partitioned tables (Amul Sul)"* https://www.postgresql.org/docs/release/18.0/

[^pg18-drop-only]: PostgreSQL 18 release notes. *"Allow dropping of constraints ONLY on partitioned tables (Álvaro Herrera). This was previously erroneously prohibited."* https://www.postgresql.org/docs/release/18.0/

[^pg18-collations]: PostgreSQL 18 release notes. *"Require primary/foreign key relationships to use either deterministic collations or the the same nondeterministic collations (Peter Eisentraut). The restore of a pg_dump, also used by pg_upgrade, will fail if these requirements are not met; schema changes must be made for these upgrade methods to succeed."* https://www.postgresql.org/docs/release/18.0/

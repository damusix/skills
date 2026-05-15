# 38 — Foreign Keys Deep Dive


PostgreSQL foreign key deep dive: every referential action (`CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT`, `NO ACTION`), the `RESTRICT`-vs-`NO ACTION` deferral distinction, `MATCH SIMPLE` vs `MATCH FULL` semantics, the obligatory index on the referencing side, self-referencing FKs, circular-FK patterns with `DEFERRABLE INITIALLY DEFERRED`, FKs across partitioned tables (PG11 introduced FK *from* partitioned, PG12 introduced FK *referencing* partitioned), PG15+ `ON DELETE SET (col_list)`, PG18+ `NOT VALID` FK on partitioned and `NOT ENFORCED` and temporal `PERIOD` FKs, the underlying RI trigger mechanism, replication considerations. For basic FK grammar and online migration via `NOT VALID` + `VALIDATE CONSTRAINT`, see [`37-constraints.md`](./37-constraints.md).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)

- [Mental Model](#mental-model)

- [Decision Matrix](#decision-matrix)

- [Mechanics](#mechanics)

    - [REFERENCES grammar recap](#references-grammar-recap)

    - [The five referential actions](#the-five-referential-actions)

    - [RESTRICT vs NO ACTION](#restrict-vs-no-action)

    - [MATCH SIMPLE vs MATCH FULL](#match-simple-vs-match-full)

    - [ON DELETE SET (column_list) — PG15+](#on-delete-set-column_list--pg15)

    - [Indexing the referencing side](#indexing-the-referencing-side)

    - [Lock levels recap](#lock-levels-recap)

    - [Self-referencing foreign keys](#self-referencing-foreign-keys)

    - [Circular foreign keys](#circular-foreign-keys)

    - [Foreign keys and partitioned tables](#foreign-keys-and-partitioned-tables)

    - [Foreign keys and inheritance](#foreign-keys-and-inheritance)

    - [PG18 temporal FKs with PERIOD](#pg18-temporal-fks-with-period)

    - [PG18 NOT ENFORCED](#pg18-not-enforced)

    - [RI trigger mechanism](#ri-trigger-mechanism)

    - [Catalog introspection](#catalog-introspection)

    - [Replication and FKs](#replication-and-fks)

- [Per-Version Timeline](#per-version-timeline)

- [Examples / Recipes](#examples--recipes)

- [Gotchas / Anti-patterns](#gotchas--anti-patterns)

- [See Also](#see-also)

- [Sources](#sources)


## When to Use This Reference


Open this file when:


- You need to pick a referential action (`CASCADE` vs `SET NULL` vs `RESTRICT` vs `NO ACTION` vs `SET DEFAULT`) and need to know what each actually does — including the subtle `RESTRICT`-vs-`NO ACTION` distinction.

- You need to choose between `MATCH SIMPLE` (default) and `MATCH FULL` for a composite FK, or to understand what `MATCH PARTIAL` would do (it is reserved but unimplemented).

- A `DELETE` or `UPDATE` on a parent table is unexpectedly slow — almost always a missing index on the referencing side.

- You are setting up a self-referencing tree (employees / categories / threads) or a two-table cycle (departments-and-managers).

- You are migrating from inheritance partitioning to declarative partitioning and need to know how FKs work across each model. PG11 introduced FK *from* a partitioned table; PG12 introduced FK *referencing* a partitioned table; PG18 lets you add such an FK with `NOT VALID`.

- You are on PG15+ and want to set only a *subset* of FK columns to NULL on parent delete.

- You are on PG18+ and want to use temporal `PERIOD` FKs or `NOT ENFORCED` FKs.

- You need to inspect the underlying RI triggers, the `pg_constraint` row, or `pg_get_constraintdef()` output.

- You are debugging an FK-related replication failure (`REPLICA IDENTITY` requirement on `UPDATE`/`DELETE`).


For basic FK grammar (`REFERENCES`), `DEFERRABLE` / `INITIALLY DEFERRED` / `SET CONSTRAINTS`, `NOT VALID` + `VALIDATE CONSTRAINT`, the `SHARE ROW EXCLUSIVE` lock level on `ADD FOREIGN KEY`, and the constraint-kind comparison table, see [`37-constraints.md`](./37-constraints.md).


## Mental Model


Five rules that drive every FK design and debugging decision:


1. **FK enforcement is per-row and real-time, implemented by internal triggers.** Every FK installs two trigger sets (one set per side) that fire on `INSERT`/`UPDATE` of the referencing table and on `UPDATE`/`DELETE` of the referenced table. The triggers are invisible in `\d` but visible in `pg_trigger` with `tgisinternal = true` and names like `RI_ConstraintTrigger_a_*` / `RI_ConstraintTrigger_c_*`. The implication: FK overhead is not free — each child INSERT does a referenced-table lookup, each parent DELETE/UPDATE does a referencing-table scan. See [RI trigger mechanism](#ri-trigger-mechanism).


2. **Five referential actions; `RESTRICT` and `NO ACTION` are *almost* identical.** Both raise an error if removing/updating the referenced row would leave dangling children. The *only* difference: *"The essential difference between these two choices is that NO ACTION allows the check to be deferred until later in the transaction, whereas RESTRICT does not"* [^pg16-fk]. If you use `DEFERRABLE INITIALLY DEFERRED`, use `NO ACTION` (or omit, since `NO ACTION` is the default).


3. **FK columns are not auto-indexed on the referencing side.** This is the single most common FK performance bug. PostgreSQL's docs are explicit: *"Since a DELETE of a row from the referenced table or an UPDATE of a referenced column will require a scan of the referencing table for rows matching the old value, it is often a good idea to index the referencing columns too. Because this is not always needed, and there are many choices available on how to index, the declaration of a foreign key constraint does not automatically create an index on the referencing columns"* [^pg16-fk]. Without that index, every parent DELETE/UPDATE is `O(N)` over the referencing table. See [Indexing the referencing side](#indexing-the-referencing-side) and Recipe 4.


4. **FKs do not inherit — in either direction — and the docs name no workaround.** Verbatim: *"Other types of constraints (unique, primary key, and foreign key constraints) are not inherited"* [^pg16-inherit]. The tutorial chapter is blunter still: *"There is no good workaround for this case"* [^pg16-inherit-no-workaround]. For declarative partitioning, the rules are different and better (see [partitioned tables](#foreign-keys-and-partitioned-tables)).


5. **`ADD FOREIGN KEY` takes `SHARE ROW EXCLUSIVE` on both tables, not `ACCESS EXCLUSIVE`.** This is the most-misquoted lock level in Postgres. Verbatim: *"Although most forms of ADD table_constraint require an ACCESS EXCLUSIVE lock, ADD FOREIGN KEY requires only a SHARE ROW EXCLUSIVE lock. Note that ADD FOREIGN KEY also acquires a SHARE ROW EXCLUSIVE lock on the referenced table"* [^pg16-altertable]. Reads on both sides continue; conflicting DDL and `FOR UPDATE`/`FOR NO KEY UPDATE` row locks block. Use `NOT VALID` + `VALIDATE CONSTRAINT` to split the long lock window further (see [`37-constraints.md`](./37-constraints.md) NOT VALID section).


## Decision Matrix


| Situation | Choice | Avoid | Why |
|---|---|---|---|
| Parent row never deleted while children exist | `ON DELETE NO ACTION` (default) or `ON DELETE RESTRICT` | `CASCADE` for cleanup convenience | The error is the contract; cascading silently is debt |
| Children are owned by parent (delete with parent) | `ON DELETE CASCADE` | App-level deletes | One write; survives partial-failure better |
| Children outlive parent but lose reference | `ON DELETE SET NULL` | `CASCADE` then re-insert orphan record | Nullable FK column; ensures FK column is nullable |
| Like SET NULL but with a sentinel "unknown" parent | `ON DELETE SET DEFAULT` | Application-level patch | Default value must exist in referenced table |
| Defer FK in a circular two-table insert | `DEFERRABLE INITIALLY DEFERRED` + `NO ACTION` | `DEFERRABLE INITIALLY IMMEDIATE` + manual `SET CONSTRAINTS` | Defaults DEFERRED for the canonical use case |
| Multi-column FK where partial NULL should fail | `MATCH FULL` | `MATCH SIMPLE` (default) | Default allows mixed-NULL rows |
| Multi-column FK where partial NULL is fine | `MATCH SIMPLE` (default) | `MATCH FULL` | Default semantics |
| Parent has many children, DELETE on parent slow | `CREATE INDEX` on FK columns of child | Hope autovacuum will help | Without the index, DELETE is O(N) |
| FK from a partitioned table to non-partitioned (PG11+) | Normal `REFERENCES` works | Trigger-based polyfills | Built-in since PG11 [^pg11-fk-from-part] |
| FK referencing a partitioned table (PG12+) | Normal `REFERENCES partitioned_tbl` works | Trigger workaround | Built-in since PG12 [^pg12-fk-to-part] |
| Adding FK on a giant table without long lock | `ADD FK ... NOT VALID` + `VALIDATE CONSTRAINT` | `ADD FK` directly | Splits SHARE ROW EXCLUSIVE window |
| Adding FK on partitioned table without long lock (PG18+) | `ADD FK ... NOT VALID` then `VALIDATE` | Single `ADD FK` | PG18 lifts the pre-PG18 partitioned-NOT-VALID prohibition [^pg18-notvalid-fk-part] |
| Same FK column appears in two tables sharing semantics (e.g., `user_id`) | Two independent FKs to the parent | Trigger-based join consistency | Each FK is its own RI trigger pair |
| Reference-table-only check (no enforcement, document only) on PG18 | `... NOT ENFORCED` | Trigger no-op | PG18 added per-constraint enforcement toggle [^pg18-notenforced] |
| Time-bounded reference (effective dates) on PG18 | `... REFERENCES tbl (id, valid_at PERIOD)` | EXCLUDE-based hand-rolled | PG18 temporal FKs [^pg18-temporal] |
| Replicate the table via logical replication | Ensure `REPLICA IDENTITY` is `PRIMARY KEY` or a chosen `UNIQUE` index | Rely on FK columns alone | FK columns don't auto-become replica identity [^pg16-pub-replica-identity] |

**Three smell signals** that an FK is causing pain:


1. `EXPLAIN ANALYZE` of `DELETE FROM parent WHERE id = ?` shows a `Seq Scan` on a child table — missing index on the referencing column (see Recipe 4).

2. Tests with multiple `INSERT`s in a fixed order keep tripping over a chicken-and-egg cycle — circular FKs need `DEFERRABLE INITIALLY DEFERRED`, not application-level reordering.

3. A bulk-import job runs slowly and `pg_stat_activity` shows `wait_event = RowExclusiveLock` on a parent table — FK INSERT/UPDATE acquires `ROW SHARE` on the referenced table; one slow validator can serialize the whole import.


## Mechanics


### REFERENCES grammar recap


The basic FK syntax (covered in [`37-constraints.md`](./37-constraints.md)):


    [CONSTRAINT name] FOREIGN KEY (col[, ...])
        REFERENCES referenced_table [(referenced_col[, ...])]
        [MATCH FULL | MATCH PARTIAL | MATCH SIMPLE]
        [ON DELETE referential_action]
        [ON UPDATE referential_action]
        [DEFERRABLE | NOT DEFERRABLE]
        [INITIALLY DEFERRED | INITIALLY IMMEDIATE]


Where `referential_action` is one of: `NO ACTION | RESTRICT | CASCADE | SET NULL [(col_list)] | SET DEFAULT [(col_list)]` [^pg16-createtable]. The `(col_list)` form is **PG15+ and only valid for `ON DELETE`** [^pg15-fk-cols].


Column-level FK shorthand:


    column_name type REFERENCES parent (parent_col) [ON DELETE …] [ON UPDATE …]


This is equivalent to a single-column table-level FK and accepts the same modifiers.


### The five referential actions


From the canonical docs paragraph [^pg16-fk]:


> *"Restricting and cascading deletes are the two most common options. RESTRICT prevents deletion of a referenced row. NO ACTION means that if any referencing rows still exist when the constraint is checked, an error is raised; this is the default behavior if you do not specify anything. (The essential difference between these two choices is that NO ACTION allows the check to be deferred until later in the transaction, whereas RESTRICT does not.) CASCADE specifies that when a referenced row is deleted, row(s) referencing it should be automatically deleted as well. There are two other options: SET NULL and SET DEFAULT. These cause the referencing column(s) in the referencing row(s) to be set to nulls or their default values, respectively, when the referenced row is deleted."*


| Action | On parent DELETE | On parent UPDATE of referenced col | Deferrable? | Notes |
|---|---|---|---|---|
| `NO ACTION` (default) | Error if children exist (at check time) | Error if children point at old value | Yes | Default; check happens at end-of-statement or end-of-transaction if `DEFERRABLE INITIALLY DEFERRED` |
| `RESTRICT` | Error if children exist (immediately) | Error if children point at old value | **No** | Cannot be deferred even with `DEFERRABLE` |
| `CASCADE` | Children deleted | Children updated to new value | n/a | Pre-PG15 the only way to clean up dependents declaratively |
| `SET NULL` | FK columns set to NULL | FK columns set to NULL | n/a | FK columns must be nullable; PG15+ allows column subset [^pg15-fk-cols] |
| `SET DEFAULT` | FK columns set to their DEFAULT | FK columns set to their DEFAULT | n/a | Default values must themselves exist in referenced table or operation fails [^pg16-createtable] |


Verbatim per-action from `CREATE TABLE` [^pg16-createtable]:


- **`NO ACTION`** — *"Produce an error indicating that the deletion or update would create a foreign key constraint violation. If the constraint is deferred, this error will be produced at constraint check time if there still exist any referencing rows. This is the default action."*

- **`RESTRICT`** — *"Produce an error indicating that the deletion or update would create a foreign key constraint violation. This is the same as NO ACTION except that the check is not deferrable."*

- **`CASCADE`** — *"Delete any rows referencing the deleted row, or update the values of the referencing column(s) to the new values of the referenced columns, respectively."*

- **`SET NULL`** — *"Set all of the referencing columns, or a specified subset of the referencing columns, to null. A subset of columns can only be specified for ON DELETE actions."*

- **`SET DEFAULT`** — *"Set all of the referencing columns, or a specified subset of the referencing columns, to their default values. A subset of columns can only be specified for ON DELETE actions. (There must be a row in the referenced table matching the default values, if they are not null, or the operation will fail.)"*


### RESTRICT vs NO ACTION


The two actions are operationally identical *except* for deferrability. Both raise an integrity-violation error when removing/updating a referenced row would orphan a child.


| Property | `RESTRICT` | `NO ACTION` (default) |
|---|---|---|
| Error if children exist | Yes | Yes |
| Allows `DEFERRABLE` | No | Yes |
| Check timing | End of statement | End of statement, or end of transaction if `DEFERRABLE INITIALLY DEFERRED` |
| Use case | "I want this to fail loudly and never silently" | Default; allows circular-FK pattern |


The "never silently" framing on `RESTRICT` is mostly social: the actions produce identical errors, so a reader can't tell from the error message which was chosen. **Pick `NO ACTION` unless you specifically want to forbid future deferrability** on this FK — that future deferrability is the only practical reason to choose `RESTRICT` explicitly over the default `NO ACTION`.


### MATCH SIMPLE vs MATCH FULL


Three match types, with `MATCH SIMPLE` the default. From `CREATE TABLE` [^pg16-createtable]:


> *"There are three match types: MATCH FULL, MATCH PARTIAL, and MATCH SIMPLE (which is the default). MATCH FULL will not allow one column of a multicolumn foreign key to be null unless all foreign key columns are null; if they are all null, the row is not required to have a match in the referenced table. MATCH SIMPLE allows any of the foreign key columns to be null; if any of them are null, the row is not required to have a match in the referenced table. MATCH PARTIAL is not yet implemented."*


For single-column FKs the distinction is moot — there is only one column to be NULL or not. The choice matters only when the FK spans **two or more columns**.


Worked example. A `shipments` table whose FK references a `(region, carrier)` composite key on `carriers`:


    CREATE TABLE carriers (
        region   text NOT NULL,
        carrier  text NOT NULL,
        PRIMARY KEY (region, carrier)
    );


    -- MATCH SIMPLE (default): allows partial NULL
    CREATE TABLE shipments_simple (
        id       bigserial PRIMARY KEY,
        region   text,
        carrier  text,
        FOREIGN KEY (region, carrier) REFERENCES carriers (region, carrier)
            -- MATCH SIMPLE is implicit
    );


    -- This row inserts successfully under MATCH SIMPLE — region is NULL,
    -- so the constraint is treated as not applicable.
    INSERT INTO shipments_simple (region, carrier) VALUES (NULL, 'UPS');


    -- MATCH FULL: forbids partial NULL
    CREATE TABLE shipments_full (
        id       bigserial PRIMARY KEY,
        region   text,
        carrier  text,
        FOREIGN KEY (region, carrier) REFERENCES carriers (region, carrier) MATCH FULL
    );


    -- This row fails: cannot mix NULL and non-NULL FK columns.
    INSERT INTO shipments_full (region, carrier) VALUES (NULL, 'UPS');
    -- ERROR:  insert or update on table "shipments_full" violates foreign key constraint
    -- DETAIL: MATCH FULL does not allow mixing of null and non-null key values.


    -- Both rows are accepted: all-NULL or all-non-NULL.
    INSERT INTO shipments_full (region, carrier) VALUES (NULL, NULL);     -- ok
    INSERT INTO shipments_full (region, carrier) VALUES ('US', 'UPS');    -- ok (if matches)


Rule of thumb: **pick `MATCH FULL` for composite FKs where partial NULL signals a bug**. Pick `MATCH SIMPLE` for optional-relationship FKs where the whole reference is either present or absent. Pick `MATCH PARTIAL`… never; it's not implemented.


### ON DELETE SET (column_list) — PG15+


> [!NOTE] PostgreSQL 15

> Verbatim release note: *"Allow foreign key ON DELETE SET actions to affect only specified columns (Paul Martinez). Previously, all of the columns in the foreign key were always affected."* [^pg15-fk-cols]


Pre-PG15, `ON DELETE SET NULL` on a composite FK nulled *every* FK column. PG15 lets you specify a subset — but only for `ON DELETE`, not for `ON UPDATE` [^pg16-createtable].


    CREATE TABLE shipments (
        id                    bigserial PRIMARY KEY,
        primary_carrier_id    int,
        secondary_carrier_id  int,
        FOREIGN KEY (primary_carrier_id, secondary_carrier_id)
            REFERENCES carriers (id1, id2)
            ON DELETE SET NULL (primary_carrier_id)
            -- Only nulls primary_carrier_id; secondary_carrier_id retains its value
    );


When a referenced `carriers` row is deleted, `shipments.primary_carrier_id` is set to NULL but `shipments.secondary_carrier_id` is untouched. The FK still has to verify the new partial-NULL row satisfies the FK; under default `MATCH SIMPLE` that row passes because the FK columns now contain a NULL. Under `MATCH FULL` the operation would fail (you'd get a mixed-NULL row, which `MATCH FULL` forbids).


This feature pairs with `MATCH SIMPLE` to model "primary carrier is invalidated, fall back to secondary" cleanly.


### Indexing the referencing side


**The single most important practical FK rule.** Verbatim from `ddl-constraints.html` [^pg16-fk]:


> *"Since a DELETE of a row from the referenced table or an UPDATE of a referenced column will require a scan of the referencing table for rows matching the old value, it is often a good idea to index the referencing columns too. Because this is not always needed, and there are many choices available on how to index, the declaration of a foreign key constraint does not automatically create an index on the referencing columns."*


Translation: every `DELETE` (or `UPDATE` that changes the key) on the referenced side fires the FK's internal trigger, which executes:


    SELECT 1 FROM child WHERE child.parent_id = OLD.id


If `child(parent_id)` is not indexed, that becomes a sequential scan of the entire child table — *per parent row deleted*. A bulk parent `DELETE` of 10,000 rows against a 100M-row child table without an index is `10,000 × 100M = 10^12` row comparisons.


Audit query: find every FK whose child column does not have a leading-position index covering the FK columns:


    SELECT c.conrelid::regclass  AS child_table,
           c.conname              AS fk_name,
           a.attname              AS fk_column,
           c.confrelid::regclass  AS parent_table
    FROM   pg_constraint c
    CROSS  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN   pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE  c.contype = 'f'
    AND NOT EXISTS (
        SELECT 1
        FROM   pg_index i
        WHERE  i.indrelid = c.conrelid
        AND    (i.indkey::int[])[0:cardinality(c.conkey) - 1] = c.conkey::int[]
    )
    ORDER  BY child_table, fk_name;


This catches the most common shape: a single-column FK with no index, and composite FKs whose leading-prefix doesn't match the FK columns. Note that a "covering" index needs the FK columns *as the leading columns* — an index on `(other_col, parent_id)` does **not** help.


Exceptions to the always-index rule (rare):


- The referenced row is **never deleted** in production (immutable reference table) — but documenting this assumption is its own risk.

- The child table is tiny (under ~1000 rows) — seq scan is fine.

- The FK is `ON DELETE CASCADE` and the cascading DELETE itself is rare and acceptable to be slow.


Even with these exceptions, the index almost always pays for itself the first time the parent row gets deleted. Default: **index every FK column on the referencing side**.


### Lock levels recap


| Operation | Lock on this table | Lock on referenced table | Note |
|---|---|---|---|
| `ADD FOREIGN KEY` | `SHARE ROW EXCLUSIVE` | `SHARE ROW EXCLUSIVE` | Both sides locked; reads OK; row-level `FOR UPDATE` blocks [^pg16-altertable] |
| `ADD FOREIGN KEY ... NOT VALID` | `SHARE ROW EXCLUSIVE` | `SHARE ROW EXCLUSIVE` | Skips full table scan |
| `VALIDATE CONSTRAINT` (FK) | `SHARE UPDATE EXCLUSIVE` | `ROW SHARE` | Far less blocking; reads + writes continue on both sides [^pg16-altertable] |
| `DROP CONSTRAINT` (FK) | `ACCESS EXCLUSIVE` | none | Standard DDL |
| `INSERT`/`UPDATE` of child | `ROW EXCLUSIVE` (default) | `ROW SHARE` (RI lookup) | Concurrent DELETE on referenced row that orphans this one is blocked |
| `DELETE`/`UPDATE` of referenced col | `ROW EXCLUSIVE` (default) | n/a | RI trigger scans child table |


The `SHARE ROW EXCLUSIVE` lock from `ADD FOREIGN KEY` is the single most-misquoted lock level in Postgres — many sources claim `ACCESS EXCLUSIVE`. The verbatim docs quote (cited in Mental Model rule 5) is the authority. Use `NOT VALID` + `VALIDATE CONSTRAINT` to split the long lock window further; see [`37-constraints.md`](./37-constraints.md) Recipe 2.


### Self-referencing foreign keys


A foreign key can reference the same table it lives on — common for trees (categories, employees with manager, replies in a thread).


    CREATE TABLE employees (
        id          bigserial PRIMARY KEY,
        name        text NOT NULL,
        manager_id  bigint REFERENCES employees (id) ON DELETE SET NULL
    );


    -- Root employee (no manager)
    INSERT INTO employees (name, manager_id) VALUES ('Alice', NULL);
    -- Direct report
    INSERT INTO employees (name, manager_id) VALUES ('Bob', 1);


**Three operational rules for self-referencing FKs:**


1. **Index `manager_id`** — same rule as any FK. Otherwise `DELETE` of a manager rows scans the whole table per delete.

2. **NULL handling for roots** — the root has `manager_id IS NULL`. Use a partial UNIQUE index to enforce single-root if needed: `CREATE UNIQUE INDEX one_root ON employees ((1)) WHERE manager_id IS NULL`.

3. **Don't use `CASCADE` on a tree** unless you mean it. `CASCADE` deletes all descendants when an ancestor is deleted. Recursive CASCADE on a deep tree is a long-running statement; for very large trees, do batched deletes with explicit `WITH RECURSIVE`. (Cross-reference [`04-ctes.md`](./04-ctes.md) for recursive CTE patterns.)


Bulk-load self-referencing data: insert with `manager_id = NULL` first, then `UPDATE` to set the parent. Alternatively, declare the FK `DEFERRABLE INITIALLY DEFERRED` and insert in any order inside a single transaction.


### Circular foreign keys


When two tables reference each other, neither row can be inserted first under default-immediate FK semantics. The fix is `DEFERRABLE INITIALLY DEFERRED` — the FK check fires at COMMIT, by which time both rows exist.


Canonical example: `employees` references `departments` (every employee has a department) and `departments` references `employees` (every department has a head). See [`37-constraints.md`](./37-constraints.md) Recipe 7 for the full worked example. Operational rules:


- **Make both FKs deferrable.** Only one needs to be `INITIALLY DEFERRED` to allow the canonical pair-insert; declaring both deferrable allows either order.

- **Use `NO ACTION`, not `RESTRICT`.** `RESTRICT` cannot be deferred (cited above).

- **Use `SET CONSTRAINTS ALL IMMEDIATE`** at end of a bulk-import transaction to catch errors before commit, so the application gets the error from `SET CONSTRAINTS` rather than from `COMMIT` (which is harder to handle).


### Foreign keys and partitioned tables


PostgreSQL has incrementally improved declarative-partitioning FK support across PG10–PG18. The current state:


| Direction | Supported since | Verbatim release note |
|---|---|---|
| FK *from* partitioned to non-partitioned | PG11 | *"Allow foreign keys on partitioned tables"* [^pg11-fk-from-part] |
| FK *referencing* partitioned table | PG12 | *"Allow foreign keys to reference partitioned tables"* [^pg12-fk-to-part] |
| `NOT VALID` FK on partitioned | PG18 | *"Allow NOT VALID foreign key constraints on partitioned tables"* [^pg18-notvalid-fk-part] |
| Temporal FK with `PERIOD` | PG18 | *"Allow the specification of non-overlapping PRIMARY KEY, UNIQUE, and foreign key constraints"* [^pg18-temporal] |
| `NOT ENFORCED` | PG18 | *"Allow CHECK and foreign key constraints to be specified as NOT ENFORCED"* [^pg18-notenforced] |


> [!NOTE] PostgreSQL 11 — FK from partitioned tables

> An FK declared on a partitioned-table parent propagates to every partition, today and in the future. Adding a new partition automatically inherits the FK definition. The implementation is one `pg_constraint` row per partition under the hood.


> [!NOTE] PostgreSQL 12 — FK referencing a partitioned table

> Before PG12, you could only reference a regular table from another table's FK. PG12 lifted this: the referenced table can itself be partitioned. The implementation requires a partition-routing lookup on every FK enforcement, which has measurable overhead on very-high-update workloads.


> [!NOTE] PostgreSQL 18 — NOT VALID FK on partitioned

> Before PG18, you could not declare a partitioned-table FK with `NOT VALID` — the only path was a full-table-scan validation at FK creation time. PG18 lifts this restriction [^pg18-notvalid-fk-part]. Combined with `VALIDATE CONSTRAINT`, this is now the canonical online-FK-add pattern for partitioned tables.


**Lock implication.** `ADD FOREIGN KEY` on a partitioned-table parent takes `SHARE ROW EXCLUSIVE` on the parent *and on every partition*. With many partitions, this can briefly contend with concurrent DDL across the partition tree. `NOT VALID` (PG18+) skips the full scan; `VALIDATE CONSTRAINT` then revalidates each partition under `SHARE UPDATE EXCLUSIVE` per partition.


Pre-PG18 workaround if you can't declare `NOT VALID`: declare the FK on each leaf partition individually (each leaf is a regular table, supports `NOT VALID`), then attach the parent later — but this is gnarly enough that most teams just take the maintenance window.


**Indexing.** A partitioned-table FK requires an index on the referenced side's PK or unique key, which is automatically present (PK creates a UNIQUE index). On the referencing side, you still need an index per partition for parent-DELETE performance (same rule as non-partitioned).


### Foreign keys and inheritance


For legacy table inheritance (not declarative partitioning — see [`36-inheritance.md`](./36-inheritance.md)), FKs do **not** propagate in either direction. Verbatim from the inheritance chapter [^pg16-inherit]:


> *"All check constraints and not-null constraints on a parent table are automatically inherited by its children, unless explicitly specified otherwise with NO INHERIT clauses. Other types of constraints (unique, primary key, and foreign key constraints) are not inherited."*


The blunter statement from the tutorial [^pg16-inherit-no-workaround]:


> *"Specifying that another table's column REFERENCES cities(name) would allow the other table to contain city names, but not capital names. There is no good workaround for this case."*


Operational consequences:


1. **Outgoing FK from a parent doesn't enforce on children.** A row in a child table can reference a value that doesn't exist on the parent's FK target — unless you also declare the FK on each child.

2. **Incoming FK to a parent only matches rows actually in the parent, not in children.** This is the docs' own example: an FK to `cities` doesn't accept names that exist only in the `capitals` child.

3. **No good workaround.** The docs say so themselves. The honest answer is to migrate to declarative partitioning if you need FK support.


### PG18 temporal FKs with PERIOD


> [!NOTE] PostgreSQL 18 — Temporal foreign keys

> PG18 introduced range-based FK matching via the `PERIOD` clause. Companion feature: `WITHOUT OVERLAPS` for unique/primary keys (see [`37-constraints.md`](./37-constraints.md)). Verbatim from PG18 release notes: *"Allow the specification of non-overlapping PRIMARY KEY, UNIQUE, and foreign key constraints (Paul A. Jungwirth). This is specified by WITHOUT OVERLAPS for PRIMARY KEY and UNIQUE, and by PERIOD for foreign keys, all applied to the last specified column."* [^pg18-temporal]


From the PG18 `CREATE TABLE` reference [^pg18-createtable]:


> *"If the last column is marked with PERIOD, it is treated in a special way. While the non-PERIOD columns are compared for equality (and there must be at least one of them), the PERIOD column is not. Instead, the constraint is considered satisfied if the referenced table has matching records (based on the non-PERIOD parts of the key) whose combined PERIOD values completely cover the referencing record's. In other words, the reference must have a referent for its entire duration. This column must be a range or multirange type. In addition, the referenced table must have a primary key or unique constraint declared with WITHOUT OVERLAPS."*


Worked example: prices with effective-date ranges, referenced by orders that must fall entirely within an effective period.


    -- PG18+
    CREATE TABLE products (
        id          bigserial NOT NULL,
        price       numeric(10,2),
        valid_at    tstzrange NOT NULL,
        PRIMARY KEY (id, valid_at WITHOUT OVERLAPS)
    );


    CREATE TABLE orders (
        id              bigserial PRIMARY KEY,
        product_id      bigint,
        period          tstzrange,
        FOREIGN KEY (product_id, period PERIOD)
            REFERENCES products (id, valid_at)
    );


An `INSERT INTO orders (product_id, period) VALUES (1, '[2026-01-01,2026-02-01)')` succeeds iff some combination of `products` rows for `id = 1` *fully covers* `[2026-01-01,2026-02-01)`. The FK enforces that the order's whole duration falls within a contiguous price-validity interval.


### PG18 NOT ENFORCED


> [!NOTE] PostgreSQL 18 — Per-constraint enforcement toggle

> Verbatim PG18 release note: *"Allow CHECK and foreign key constraints to be specified as NOT ENFORCED (Amul Sul). This also adds column pg_constraint.conenforced."* [^pg18-notenforced]


From `CREATE TABLE` [^pg18-createtable]:


> *"When the constraint is ENFORCED, then the database system will ensure that the constraint is satisfied, by checking the constraint at appropriate times (after each statement or at the end of the transaction, as appropriate). That is the default. If the constraint is NOT ENFORCED, the database system will not check the constraint. It is then up to the application code to ensure that the constraints are satisfied."*

> *"This is currently only supported for foreign key and CHECK constraints."*


Use cases:


- **Documentation-only constraints** — an FK that describes intent without runtime cost. Useful when an application enforces the constraint elsewhere (e.g., via a service boundary) and the team wants the schema to declare the relationship.

- **Migration intermediate state** — temporarily disable enforcement during a large data migration without dropping the constraint.

- **Performance escape hatch** — turn off enforcement on a hot FK in a known-safe context.


> [!WARNING]

> `NOT ENFORCED` is **not retroactive**. Switching an enforced FK to `NOT ENFORCED` does not delete its history of enforcement; switching from `NOT ENFORCED` back to `ENFORCED` does not retroactively validate the now-old data. Combined with `NOT VALID` + `VALIDATE`, you have four states: enforced+valid (default), enforced+not-valid (write-time only), not-enforced+valid (declarative only), not-enforced+not-valid (decorative).


    ALTER TABLE orders
        ADD CONSTRAINT orders_product_fk
        FOREIGN KEY (product_id) REFERENCES products (id)
        NOT ENFORCED;
    -- Constraint exists in pg_constraint but RI triggers are not active.


To toggle enforcement after creation, use `ALTER TABLE ... ALTER CONSTRAINT name ENFORCED` or `NOT ENFORCED` (PG18+).


### RI trigger mechanism


FK enforcement is implemented as a set of internal triggers visible in `pg_trigger`. They have `tgisinternal = true` and `tgname` matching the pattern `RI_ConstraintTrigger_a_*` (action trigger on referenced side) or `RI_ConstraintTrigger_c_*` (check trigger on referencing side).


    -- Inspect the RI triggers for a given table
    SELECT t.tgname,
           t.tgtype,
           t.tgenabled,
           CASE t.tgtype & 66 -- 64 = TRIGGER_TYPE_BEFORE, 2 = TRIGGER_TYPE_AFTER
               WHEN 2  THEN 'AFTER'
               WHEN 64 THEN 'BEFORE'
           END AS timing,
           t.tgconstraint::regclass::text  AS constraint,
           c.conname                       AS constraint_name
    FROM   pg_trigger t
    LEFT   JOIN pg_constraint c ON c.oid = t.tgconstraint
    WHERE  t.tgrelid = 'orders'::regclass
    AND    t.tgisinternal = true;


The triggers themselves call C-level functions (`RI_FKey_check_ins`, `RI_FKey_check_upd`, `RI_FKey_cascade_del`, etc.) — they are visible but not user-modifiable. You generally don't interact with them directly except to:


- **Disable** a constraint trigger to bypass FK enforcement (rare, dangerous): `ALTER TABLE child DISABLE TRIGGER ALL;` (also disables user triggers; prefer `ALTER TABLE child ALTER CONSTRAINT fkname NOT ENFORCED` on PG18+ for the same effect with safer scope).

- **Inspect** for performance tracing: a hot FK shows up as time spent inside its RI trigger when running EXPLAIN ANALYZE with `track_function_call_count` semantics.


### Catalog introspection


FKs live in `pg_constraint` with `contype = 'f'`. The most useful columns for FK auditing [^pg16-catalog-constraint]:


| Column | What it means |
|---|---|
| `conname` | Constraint name (autogenerated as `<table>_<col>_fkey` if not specified) |
| `conrelid` | OID of the referencing (child) table |
| `confrelid` | OID of the referenced (parent) table |
| `conkey` | Array of `attnum`s of FK columns on child |
| `confkey` | Array of `attnum`s of referenced columns on parent |
| `confupdtype` | `ON UPDATE` action: `a`=NO ACTION, `r`=RESTRICT, `c`=CASCADE, `n`=SET NULL, `d`=SET DEFAULT |
| `confdeltype` | `ON DELETE` action (same encoding) |
| `confmatchtype` | `f`=FULL, `p`=PARTIAL (unused), `s`=SIMPLE |
| `condeferrable` | Boolean: can be deferred? |
| `condeferred` | Boolean: deferred by default? |
| `convalidated` | Boolean: has been validated? PG16 docs: *"Currently, can be false only for foreign keys and CHECK constraints"* — PG18 widens to NOT NULL [^pg16-catalog-constraint] |
| `conenforced` | (PG18+) Boolean: is this constraint enforced? |


The user-friendly view of an FK definition comes from `pg_get_constraintdef()` [^pg16-functions-info]:


    -- Pretty-printed FK definition for one specific constraint
    SELECT conname, pg_get_constraintdef(oid, true) AS defn
    FROM   pg_constraint
    WHERE  conrelid = 'orders'::regclass
    AND    contype = 'f';

    --       conname       |                                defn
    --  --------------------+--------------------------------------------------------------------
    --  orders_product_fkey | FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE


### Replication and FKs


Logical replication has two FK-specific interactions:


1. **`REPLICA IDENTITY` is required for `UPDATE`/`DELETE` replication.** Verbatim [^pg16-pub-replica-identity]: *"A published table must have a replica identity configured in order to be able to replicate UPDATE and DELETE operations, so that appropriate rows to update or delete can be identified on the subscriber side ... If a table without a replica identity is added to a publication that replicates UPDATE or DELETE operations then subsequent UPDATE or DELETE operations will cause an error on the publisher. INSERT operations can proceed regardless of any replica identity."*


2. **FK columns are not automatically part of replica identity.** The default `REPLICA IDENTITY` is the primary key; if your FK columns are not the PK and not a chosen unique-index identity, replication of an UPDATE on those FK columns transmits only the old-row identity, not the FK values. If you need to replicate FK-column changes, ensure the FK columns are either the PK or part of a `REPLICA IDENTITY USING INDEX` choice.


For FK enforcement on the subscriber side: subscribers enforce FKs the same as the publisher *only if* the FK definition is replicated separately (DDL is not auto-replicated; see [`74-logical-replication.md`](./74-logical-replication.md)). If you replicate data only, ensure FK constraints are created identically on both sides; otherwise the subscriber can accept rows the publisher would reject (or vice versa).


## Per-Version Timeline


| PG | FK-related changes |
|---|---|
| **PG11** | FK on partitioned tables introduced — verbatim *"Allow foreign keys on partitioned tables (Álvaro Herrera)"* [^pg11-fk-from-part]. |
| **PG12** | FK referencing partitioned tables — verbatim *"Allow foreign keys to reference partitioned tables (Álvaro Herrera)"* [^pg12-fk-to-part]. |
| **PG13** | No FK-specific release-note items. |
| **PG14** | No FK-specific release-note items. |
| **PG15** | `ON DELETE SET (col_list)` — verbatim *"Allow foreign key ON DELETE SET actions to affect only specified columns (Paul Martinez). Previously, all of the columns in the foreign key were always affected."* [^pg15-fk-cols]. Plus FK action normalization on partition row movement (see [`35-partitioning.md`](./35-partitioning.md)). |
| **PG16** | No headline FK release-note items. (Some pg_constraint catalog clarifications.) |
| **PG17** | No FK-specific release-note items. |
| **PG18** | Three FK additions: `NOT VALID` FK on partitioned tables [^pg18-notvalid-fk-part]; `NOT ENFORCED` for FK and CHECK with new `pg_constraint.conenforced` column [^pg18-notenforced]; temporal FK via `PERIOD` clause [^pg18-temporal]. Plus `ALTER CONSTRAINT [NO] INHERIT` widened to NOT NULL (see [`37-constraints.md`](./37-constraints.md)). |


## Examples / Recipes


### Recipe 1 — Add an indexed FK from scratch


Always add the index *first*, then the FK; that way the FK validation can use the index, and the FK is never live without its index.


    -- Schema
    CREATE TABLE users   (id bigserial PRIMARY KEY, email text NOT NULL);
    CREATE TABLE orders  (id bigserial PRIMARY KEY, user_id bigint NOT NULL, total numeric(10,2));

    -- Step 1: index the FK column
    CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);

    -- Step 2: add the FK
    ALTER TABLE orders
        ADD CONSTRAINT orders_user_fkey
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE CASCADE;


For an existing large table, see Recipe 2 below.


### Recipe 2 — Add FK to a giant table with minimal lock


The canonical online-FK-add pattern using `NOT VALID` + `VALIDATE CONSTRAINT`. See [`37-constraints.md`](./37-constraints.md) Recipe 2 for the basic shape; the FK-specific notes:


    -- Step 1: install the index (no scan on the parent yet)
    CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);

    -- Step 2: install the constraint with NOT VALID. Future writes are enforced;
    -- existing rows are NOT checked. Takes SHARE ROW EXCLUSIVE on both tables briefly.
    ALTER TABLE orders
        ADD CONSTRAINT orders_user_fkey
        FOREIGN KEY (user_id) REFERENCES users (id)
        NOT VALID;

    -- Step 3: validate. SHARE UPDATE EXCLUSIVE on orders, ROW SHARE on users.
    -- Other DML on both tables continues.
    ALTER TABLE orders VALIDATE CONSTRAINT orders_user_fkey;


On PG18+, the same pattern works for partitioned tables [^pg18-notvalid-fk-part]; pre-PG18, declaring `NOT VALID` on a partitioned-table FK was forbidden.


### Recipe 3 — Find FKs without a covering index


    SELECT c.conrelid::regclass    AS child_table,
           c.conname                AS fk_name,
           string_agg(a.attname, ', ' ORDER BY k.ord) AS fk_columns,
           c.confrelid::regclass    AS parent_table,
           pg_size_pretty(pg_relation_size(c.conrelid)) AS child_size
    FROM   pg_constraint c
    CROSS  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN   pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE  c.contype = 'f'
    AND NOT EXISTS (
        SELECT 1
        FROM   pg_index i
        WHERE  i.indrelid = c.conrelid
        AND    (i.indkey::int[])[0:cardinality(c.conkey) - 1] = c.conkey::int[]
        AND    i.indisvalid
    )
    GROUP BY c.conrelid, c.conname, c.confrelid
    ORDER BY pg_relation_size(c.conrelid) DESC;


Reports each FK whose child columns are not the leading prefix of *any valid* index. The result is sorted by child-table size — fix the biggest tables first.


### Recipe 4 — Diagnose a slow parent DELETE


Symptom: `DELETE FROM users WHERE id = 42` takes seconds when `users` is tiny.


    EXPLAIN (ANALYZE, BUFFERS) DELETE FROM users WHERE id = 42;
    -- Look for "Trigger for constraint orders_user_fkey: time=XXX calls=1"
    -- If the trigger time dominates, the FK scan is the bottleneck.
    -- Check whether the child table has an index on the FK column:
    --
    --     \d+ orders
    --
    -- If not, that's the fix.


PostgreSQL's `EXPLAIN ANALYZE` of a DELETE reports per-trigger time at the bottom of the plan. Hot FK triggers show up directly with their constraint name.


### Recipe 5 — Self-referencing FK with index and root constraint


    CREATE TABLE categories (
        id          bigserial PRIMARY KEY,
        name        text NOT NULL,
        parent_id   bigint REFERENCES categories (id) ON DELETE CASCADE
    );

    -- Index the FK column for delete performance
    CREATE INDEX categories_parent_id_idx ON categories (parent_id);

    -- Optional: enforce exactly one root (parent_id IS NULL)
    CREATE UNIQUE INDEX categories_one_root
        ON categories ((1))
        WHERE parent_id IS NULL;


For non-cascade-delete trees, prefer `ON DELETE SET NULL` (orphaned subtree retained) or `ON DELETE RESTRICT` (refuse to delete a node with children).


### Recipe 6 — Circular FK between two tables


    CREATE TABLE departments (
        id           bigserial PRIMARY KEY,
        name         text NOT NULL,
        head_id      bigint
    );

    CREATE TABLE employees (
        id            bigserial PRIMARY KEY,
        name          text NOT NULL,
        department_id bigint NOT NULL,
        CONSTRAINT employees_department_fkey
            FOREIGN KEY (department_id) REFERENCES departments (id)
            DEFERRABLE INITIALLY DEFERRED
    );

    ALTER TABLE departments
        ADD CONSTRAINT departments_head_fkey
        FOREIGN KEY (head_id) REFERENCES employees (id)
        DEFERRABLE INITIALLY DEFERRED;

    -- Insert in one transaction; FK checks fire at COMMIT.
    BEGIN;
        INSERT INTO departments (id, name, head_id) VALUES (1, 'Eng', 1);
        INSERT INTO employees (id, name, department_id) VALUES (1, 'Alice', 1);
    COMMIT;
    -- Both succeed because the FK validation is deferred.

    -- Catch errors before COMMIT:
    BEGIN;
        INSERT INTO departments (id, name, head_id) VALUES (2, 'Sales', 999);
        SET CONSTRAINTS ALL IMMEDIATE;  -- raises now, not at COMMIT
    ROLLBACK;


### Recipe 7 — Cross-table delete cascade with audit


When you do want `ON DELETE CASCADE`, pair it with a trigger that captures what got cascaded (since the rows are about to be gone).


    CREATE TABLE archived_orders (
        id          bigint,
        user_id     bigint,
        archived_at timestamptz DEFAULT now(),
        reason      text
    );

    CREATE OR REPLACE FUNCTION archive_cascaded_orders() RETURNS trigger AS $$
    BEGIN
        INSERT INTO archived_orders (id, user_id, reason)
        VALUES (OLD.id, OLD.user_id, 'user-deleted-cascade');
        RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER orders_archive_cascade
        BEFORE DELETE ON orders
        FOR EACH ROW
        EXECUTE FUNCTION archive_cascaded_orders();


This works because the FK's RI trigger generates the same per-row `DELETE` on `orders` that fires user triggers. Be careful with batch sizes — a CASCADE that deletes 1M orders fires the BEFORE trigger 1M times.


### Recipe 8 — Inventory of all FKs in a schema


    SELECT n.nspname || '.' || c.conrelid::regclass::text AS child,
           c.conname                                       AS fk_name,
           n2.nspname || '.' || c.confrelid::regclass::text AS parent,
           pg_get_constraintdef(c.oid, true)               AS defn,
           c.convalidated                                   AS validated,
           c.condeferrable                                  AS deferrable
    FROM   pg_constraint c
    JOIN   pg_class      ch ON ch.oid = c.conrelid
    JOIN   pg_namespace  n  ON n.oid = ch.relnamespace
    JOIN   pg_class      p  ON p.oid = c.confrelid
    JOIN   pg_namespace  n2 ON n2.oid = p.relnamespace
    WHERE  c.contype = 'f'
    AND    n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER  BY n.nspname, child, fk_name;


### Recipe 9 — Audit FKs that are NOT VALID


    SELECT c.conrelid::regclass  AS table,
           c.conname              AS fk_name,
           pg_get_constraintdef(c.oid, true) AS defn
    FROM   pg_constraint c
    WHERE  c.contype = 'f'
    AND    c.convalidated = false;


An FK with `convalidated = false` is enforcing new writes but has not been re-checked against existing rows. Either run `VALIDATE CONSTRAINT` to finish the migration, or accept the lazy-validation state (rare, but legal).


### Recipe 10 — Drop FK without orphaning data


    BEGIN;
        ALTER TABLE orders
            DROP CONSTRAINT orders_user_fkey;
    COMMIT;


`DROP CONSTRAINT` takes `ACCESS EXCLUSIVE` on the child table (briefly). No lock is taken on the referenced table because the link is gone. Dropping an FK leaves data intact; if you want orphan rows to also disappear, query them explicitly after the drop:


    DELETE FROM orders WHERE user_id NOT IN (SELECT id FROM users);


### Recipe 11 — Temporary FK disable for bulk import (PG18+)


    -- PG18+: cleanest way is NOT ENFORCED
    ALTER TABLE orders ALTER CONSTRAINT orders_user_fkey NOT ENFORCED;

    -- Bulk load
    COPY orders FROM '/path/to/orders.csv' WITH CSV;

    -- Re-enforce
    ALTER TABLE orders ALTER CONSTRAINT orders_user_fkey ENFORCED;

    -- And validate that loaded data conformed:
    ALTER TABLE orders VALIDATE CONSTRAINT orders_user_fkey;


Pre-PG18, the equivalent path is to `DROP CONSTRAINT` and re-add with `NOT VALID`, then `VALIDATE` after the import. Both are operationally similar; PG18's `NOT ENFORCED` is cleaner because the constraint name and definition don't move.


### Recipe 12 — Add a partitioned-table FK online (PG18+)


    -- PG18+: NOT VALID FK on partitioned table is now legal
    ALTER TABLE events_partitioned
        ADD CONSTRAINT events_user_fkey
        FOREIGN KEY (user_id) REFERENCES users (id)
        NOT VALID;

    -- Validate each partition under SHARE UPDATE EXCLUSIVE (and parent acquires
    -- the lock briefly to mark convalidated):
    ALTER TABLE events_partitioned VALIDATE CONSTRAINT events_user_fkey;


Pre-PG18 the validation could not be split; the FK install required a full scan under `SHARE ROW EXCLUSIVE` on the parent and every partition.


### Recipe 13 — Disable inherited "fanout" with NO INHERIT trigger


For a CHECK with `NO INHERIT`, see [`37-constraints.md`](./37-constraints.md). For FK enforcement at the parent-table level only (not children), you cannot use `NO INHERIT` because FKs already do not propagate. The reverse case — wanting an FK *only* on a specific child but not its inheritance siblings — requires declaring the FK on that child individually. This is one of the inheritance pain-points the docs name explicitly.


## Gotchas / Anti-patterns


1. **The default `ON DELETE` action is `NO ACTION`, not `RESTRICT`.** They are almost identical except for deferrability. If you want hard error-out behavior, the default is fine; `RESTRICT` only changes whether the FK can be made deferrable in the future.


2. **`ON UPDATE SET (col_list)` does not exist** — the column subset form is only legal for `ON DELETE` actions [^pg16-createtable]. Trying to declare `ON UPDATE SET NULL (a)` raises a syntax error.


3. **FK column not indexed on child side → parent DELETE is `O(N)` per parent row.** The single most common FK performance bug. See Recipe 4 for the EXPLAIN signature. The docs explicitly say *"the declaration of a foreign key constraint does not automatically create an index on the referencing columns"* [^pg16-fk].


4. **A covering index needs FK columns as the leading columns.** An index on `(other_col, fk_col)` does **not** help the FK validation scan — the planner cannot use a non-leading column for an equality probe efficiently. See Recipe 3.


5. **`ADD FOREIGN KEY` takes `SHARE ROW EXCLUSIVE` on both tables, not `ACCESS EXCLUSIVE`.** Verbatim *"ADD FOREIGN KEY requires only a SHARE ROW EXCLUSIVE lock. Note that ADD FOREIGN KEY also acquires a SHARE ROW EXCLUSIVE lock on the referenced table"* [^pg16-altertable]. Reads continue on both sides; `FOR UPDATE` / `FOR NO KEY UPDATE` and conflicting DDL block.


6. **`MATCH SIMPLE` (the default) is permissive on multicolumn NULLs.** A row with one NULL FK column passes the constraint without referencing any parent row. For composite FKs where partial NULL is a bug, declare `MATCH FULL`.


7. **`MATCH PARTIAL` is not implemented.** Verbatim from `CREATE TABLE`: *"MATCH PARTIAL is not yet implemented"* [^pg16-createtable]. Don't use it.


8. **`RESTRICT` cannot be deferred even with `DEFERRABLE`.** The clause is accepted by the parser, but `SET CONSTRAINTS ... DEFERRED` has no effect on a `RESTRICT` FK. Use `NO ACTION` for any FK that needs to be deferrable.


9. **FKs do not inherit.** Verbatim *"Other types of constraints (unique, primary key, and foreign key constraints) are not inherited"* [^pg16-inherit]. Worse, *"there is no good workaround"* [^pg16-inherit-no-workaround]. For new code, use declarative partitioning, not inheritance.


10. **`ON DELETE CASCADE` on a partition key that gets updated** — pre-PG15, the cascade fired through row-movement could trigger surprising behaviors. PG15 normalized FK action handling on partition row movement to run `UPDATE` on the partition root (see [`35-partitioning.md`](./35-partitioning.md) and [^pg15-fk-cols]'s related items).


11. **`SET DEFAULT` requires the default value to exist in the referenced table** — verbatim *"There must be a row in the referenced table matching the default values, if they are not null, or the operation will fail"* [^pg16-createtable]. Easy to forget when adding a `DEFAULT 0` to an FK column whose parent table doesn't contain a row with `id = 0`.


12. **Bulk INSERT performance is dominated by RI triggers, not by INSERT itself.** Every child row INSERT fires the FK lookup against the parent. For multi-million-row imports, consider PG18+ `NOT ENFORCED` (Recipe 11) or pre-PG18 drop-and-rebuild — either pattern lets the import run without per-row FK lookups, with validation deferred to a single bulk-scan operation.


13. **`pg_get_constraintdef()` reconstructs, not echoes.** Verbatim *"This is a decompiled reconstruction, not the original text of the command"* [^pg16-functions-info]. Comments and exact whitespace are lost; comparison against original CREATE statements must be semantic, not textual.


14. **`convalidated = false` (NOT VALID) does not prevent new violations.** It just skips re-checking existing rows. New writes are enforced normally [^pg16-altertable].


15. **`NOT ENFORCED` (PG18+) is the opposite: it disables runtime enforcement.** Even new writes are not checked. Don't confuse with `NOT VALID`. PG18 introduces both as separate features; combining them produces a four-state matrix (enforced+valid, enforced+not-valid, not-enforced+valid, not-enforced+not-valid).


16. **Replication of `UPDATE`/`DELETE` requires `REPLICA IDENTITY` to be set.** Verbatim: *"A published table must have a replica identity configured in order to be able to replicate UPDATE and DELETE operations"* [^pg16-pub-replica-identity]. Tables without PK or chosen UNIQUE identity fail to replicate updates/deletes. FK columns are not automatically part of replica identity.


17. **`pg_constraint.contype = 'f'` is the FK filter.** Each FK has *one* `pg_constraint` row; on a partitioned table, each partition's FK is its own `pg_constraint` row.


18. **`ALTER TABLE ... DROP CONSTRAINT` takes `ACCESS EXCLUSIVE`.** Cleaner than ADD because there's no validation needed; the lock is brief but full.


19. **Self-referencing FK and bulk insert via `\copy`** — `\copy` doesn't support deferred FK checks the way you might want. If you need to load tree data with self-references in arbitrary order, declare the FK `DEFERRABLE INITIALLY DEFERRED` and use a `BEGIN` ... `\copy` ... `COMMIT` block.


20. **`ALTER CONSTRAINT` is FK-only until PG18.** Pre-PG18, `ALTER CONSTRAINT` accepts only foreign-key constraints — verbatim *"Currently only foreign key constraints may be altered"* [^pg16-altertable]. PG18 extends this to NOT NULL (see [`37-constraints.md`](./37-constraints.md)).


21. **An FK can reference a non-PK UNIQUE constraint.** The referenced columns must be marked `UNIQUE` or `PRIMARY KEY` (or be the entire columns of an FK referencing an inherited primary key on a parent partitioned table). Many teams assume PK only — composite UNIQUE works fine.


22. **`SET CONSTRAINTS` outside a transaction block is silently a no-op.** Verbatim *"Issuing this outside of a transaction block emits a warning and otherwise has no effect"* [^pg16-setcon]. The warning is at WARNING level, often missed by tooling that filters to ERROR-only.


## See Also


- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — CREATE TABLE FK column-level vs table-level grammar.

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — FK enforcement happens inside the snapshot of the transaction performing the parent UPDATE/DELETE.

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — A bloated index on the FK column degrades parent-DELETE performance.

- [`30-hot-updates.md`](./30-hot-updates.md) — FK columns count as indexed; updating an FK column kills HOT.

- [`35-partitioning.md`](./35-partitioning.md) — FK rules across partitioned tables; partition-wise FK enforcement; PG15 row-movement FK normalization.

- [`36-inheritance.md`](./36-inheritance.md) — FKs do not inherit; the "no good workaround" surface; why declarative partitioning replaced inheritance for this use case.

- [`37-constraints.md`](./37-constraints.md) — Constraint basics: grammar, DEFERRABLE, NOT VALID + VALIDATE, the six constraint kinds, SET CONSTRAINTS, ALTER CONSTRAINT.

- [`39-triggers.md`](./39-triggers.md) — User triggers fire alongside RI triggers; sequence of events on cascade.

- [`43-locking.md`](./43-locking.md) — Full SHARE ROW EXCLUSIVE conflict matrix; FK INSERT/UPDATE acquires ROW SHARE on referenced table.

- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_constraint`, `pg_trigger`, `pg_index` joins for FK auditing.

- [`41-transactions.md`](./41-transactions.md) — DEFERRABLE FK patterns in multi-table transactions; SET CONSTRAINTS ALL DEFERRED.
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — NOT ENFORCED / session_replication_role patterns for bulk import without FK overhead.
- [`74-logical-replication.md`](./74-logical-replication.md) — REPLICA IDENTITY requirements; FK behavior on subscriber.


## Sources


[^pg16-fk]: PostgreSQL 16 docs, "5.4. Constraints — Foreign Keys": *"A foreign key constraint specifies that the values in a column (or a group of columns) must match the values appearing in some row of another table. We say this maintains the referential integrity between two related tables."* and *"Restricting and cascading deletes are the two most common options. RESTRICT prevents deletion of a referenced row. NO ACTION means that if any referencing rows still exist when the constraint is checked, an error is raised; this is the default behavior if you do not specify anything. (The essential difference between these two choices is that NO ACTION allows the check to be deferred until later in the transaction, whereas RESTRICT does not.) CASCADE specifies that when a referenced row is deleted, row(s) referencing it should be automatically deleted as well. There are two other options: SET NULL and SET DEFAULT. These cause the referencing column(s) in the referencing row(s) to be set to nulls or their default values, respectively, when the referenced row is deleted."* and *"Since a DELETE of a row from the referenced table or an UPDATE of a referenced column will require a scan of the referencing table for rows matching the old value, it is often a good idea to index the referencing columns too. Because this is not always needed, and there are many choices available on how to index, the declaration of a foreign key constraint does not automatically create an index on the referencing columns."* https://www.postgresql.org/docs/16/ddl-constraints.html


[^pg16-createtable]: PostgreSQL 16 docs, `CREATE TABLE`: *"There are three match types: MATCH FULL, MATCH PARTIAL, and MATCH SIMPLE (which is the default). MATCH FULL will not allow one column of a multicolumn foreign key to be null unless all foreign key columns are null; if they are all null, the row is not required to have a match in the referenced table. MATCH SIMPLE allows any of the foreign key columns to be null; if any of them are null, the row is not required to have a match in the referenced table. MATCH PARTIAL is not yet implemented."* Plus per-action quotes for `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, `SET DEFAULT`. https://www.postgresql.org/docs/16/sql-createtable.html


[^pg16-altertable]: PostgreSQL 16 docs, `ALTER TABLE` Notes: *"Although most forms of ADD table_constraint require an ACCESS EXCLUSIVE lock, ADD FOREIGN KEY requires only a SHARE ROW EXCLUSIVE lock. Note that ADD FOREIGN KEY also acquires a SHARE ROW EXCLUSIVE lock on the referenced table, in addition to the lock on the table on which the constraint is declared."* and *"The validation step does not need to lock out concurrent updates, since it knows that other transactions will be enforcing the constraint for rows that they insert or update; only pre-existing rows need to be checked. Hence, validation acquires only a SHARE UPDATE EXCLUSIVE lock on the table being altered. (If the constraint is a foreign key then a ROW SHARE lock is also required on the table referenced by the constraint.)"* and *"ALTER CONSTRAINT — This form alters the attributes of a constraint that was previously created. Currently only foreign key constraints may be altered."* and *"foreign key constraints on partitioned tables may not be declared NOT VALID at present."* (PG18 lifts this.) https://www.postgresql.org/docs/16/sql-altertable.html


[^pg16-inherit]: PostgreSQL 16 docs, "5.10. Inheritance": *"All check constraints and not-null constraints on a parent table are automatically inherited by its children, unless explicitly specified otherwise with NO INHERIT clauses. Other types of constraints (unique, primary key, and foreign key constraints) are not inherited."* https://www.postgresql.org/docs/16/ddl-inherit.html


[^pg16-inherit-no-workaround]: PostgreSQL 16 docs, "5.10. Inheritance": *"Specifying that another table's column REFERENCES cities(name) would allow the other table to contain city names, but not capital names. There is no good workaround for this case."* https://www.postgresql.org/docs/16/ddl-inherit.html


[^pg16-setcon]: PostgreSQL 16 docs, `SET CONSTRAINTS`: *"Currently, only UNIQUE, PRIMARY KEY, REFERENCES (foreign key), and EXCLUDE constraints are affected by this setting."* and *"NOT NULL and CHECK constraints are always checked immediately when a row is inserted or modified (not at the end of the statement)."* and *"This command only alters the behavior of constraints within the current transaction. Issuing this outside of a transaction block emits a warning and otherwise has no effect."* https://www.postgresql.org/docs/16/sql-set-constraints.html


[^pg16-catalog-constraint]: PostgreSQL 16 docs, "53.10. pg_constraint": column descriptions for `contype` (c=check, f=foreign key, p=primary key, u=unique, t=constraint trigger, x=exclusion), `confupdtype`/`confdeltype` (a=no action, r=restrict, c=cascade, n=set null, d=set default), `confmatchtype` (f=full, p=partial, s=simple), `convalidated` *"Has the constraint been validated? Currently, can be false only for foreign keys and CHECK constraints"*. https://www.postgresql.org/docs/16/catalog-pg-constraint.html


[^pg16-functions-info]: PostgreSQL 16 docs, "System Information Functions": `pg_get_constraintdef ( constraint oid [, pretty boolean ] ) → text` — *"Reconstructs the creating command for a constraint. (This is a decompiled reconstruction, not the original text of the command.)"* https://www.postgresql.org/docs/16/functions-info.html


[^pg16-pub-replica-identity]: PostgreSQL 16 docs, "31.1. Publication": *"A published table must have a replica identity configured in order to be able to replicate UPDATE and DELETE operations, so that appropriate rows to update or delete can be identified on the subscriber side ... If a table without a replica identity is added to a publication that replicates UPDATE or DELETE operations then subsequent UPDATE or DELETE operations will cause an error on the publisher. INSERT operations can proceed regardless of any replica identity."* https://www.postgresql.org/docs/16/logical-replication-publication.html


[^pg18-createtable]: PostgreSQL 18 docs, `CREATE TABLE` — PERIOD: *"If the last column is marked with PERIOD, it is treated in a special way. While the non-PERIOD columns are compared for equality (and there must be at least one of them), the PERIOD column is not. Instead, the constraint is considered satisfied if the referenced table has matching records (based on the non-PERIOD parts of the key) whose combined PERIOD values completely cover the referencing record's. In other words, the reference must have a referent for its entire duration. This column must be a range or multirange type. In addition, the referenced table must have a primary key or unique constraint declared with WITHOUT OVERLAPS."* NOT ENFORCED: *"When the constraint is ENFORCED, then the database system will ensure that the constraint is satisfied, by checking the constraint at appropriate times (after each statement or at the end of the transaction, as appropriate). That is the default. If the constraint is NOT ENFORCED, the database system will not check the constraint. It is then up to the application code to ensure that the constraints are satisfied."* and *"This is currently only supported for foreign key and CHECK constraints."* https://www.postgresql.org/docs/18/sql-createtable.html


[^pg11-fk-from-part]: PostgreSQL 11 release notes, "E.23.3.1.1 Partitioning": *"Allow foreign keys on partitioned tables (Álvaro Herrera)."* https://www.postgresql.org/docs/release/11.0/


[^pg12-fk-to-part]: PostgreSQL 12 release notes, "E.23.3.1.1 Partitioning": *"Allow foreign keys to reference partitioned tables (Álvaro Herrera)."* https://www.postgresql.org/docs/release/12.0/


[^pg15-fk-cols]: PostgreSQL 15 release notes, "E.18.3.3 Utility Commands": *"Allow foreign key ON DELETE SET actions to affect only specified columns (Paul Martinez). Previously, all of the columns in the foreign key were always affected."* https://www.postgresql.org/docs/release/15.0/


[^pg18-notvalid-fk-part]: PostgreSQL 18 release notes, "E.4.3.2.1 Partitioning": *"Allow NOT VALID foreign key constraints on partitioned tables (Amul Sul)."* https://www.postgresql.org/docs/18/release-18.html


[^pg18-notenforced]: PostgreSQL 18 release notes: *"Allow CHECK and foreign key constraints to be specified as NOT ENFORCED (Amul Sul). This also adds column pg_constraint.conenforced."* https://www.postgresql.org/docs/18/release-18.html


[^pg18-temporal]: PostgreSQL 18 release notes: *"Allow the specification of non-overlapping PRIMARY KEY, UNIQUE, and foreign key constraints (Paul A. Jungwirth). This is specified by WITHOUT OVERLAPS for PRIMARY KEY and UNIQUE, and by PERIOD for foreign keys, all applied to the last specified column."* and overview umbrella *"Temporal constraints, or constraints over ranges, for PRIMARY KEY, UNIQUE, and FOREIGN KEY constraints."* https://www.postgresql.org/docs/18/release-18.html

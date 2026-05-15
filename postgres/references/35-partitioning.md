# Declarative Partitioning


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [PARTITION BY grammar](#partition-by-grammar)
    - [Three strategies: RANGE, LIST, HASH](#three-strategies-range-list-hash)
    - [DEFAULT partition](#default-partition)
    - [Sub-partitioning](#sub-partitioning)
    - [ATTACH PARTITION](#attach-partition)
    - [DETACH PARTITION CONCURRENTLY](#detach-partition-concurrently)
    - [Row movement](#row-movement)
    - [Indexes on partitioned tables](#indexes-on-partitioned-tables)
    - [Constraints on partitioned tables](#constraints-on-partitioned-tables)
    - [Foreign keys](#foreign-keys)
    - [Partition pruning](#partition-pruning)
    - [Partition-wise join and aggregate](#partition-wise-join-and-aggregate)
    - [Triggers on partitioned tables](#triggers-on-partitioned-tables)
    - [Declarative partitioning limitations](#declarative-partitioning-limitations)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file when you are:

- Designing a table that will accumulate many millions of rows and need partition pruning to keep queries fast.
- Implementing a retention policy (drop old data without `DELETE`).
- Rotating partitions (e.g., monthly time-series, hash-by-tenant).
- Diagnosing why a query is not pruning partitions.
- Migrating an existing non-partitioned table to a partitioned one.
- Adding indexes / foreign keys / unique constraints to a partitioned table.
- Picking between declarative partitioning and legacy table inheritance (this is the canonical declarative reference — see [`36-inheritance.md`](./36-inheritance.md) for inheritance and the rare cases where it is still right).

This file is the canonical home for the declarative partitioning surface. Automation via `pg_partman` lives in [`99-pg-partman.md`](./99-pg-partman.md); scheduling rotation via `pg_cron` lives in [`98-pg-cron.md`](./98-pg-cron.md).


## Mental Model

Five rules drive every decision in this file.

1. **Declarative partitioning is the right answer.** Inheritance partitioning is legacy and exists only because declarative partitioning had not yet been written when the existing applications were built. New code always uses `PARTITION BY`. See [`36-inheritance.md`](./36-inheritance.md) for when (rarely) inheritance still fits.

2. **Partition by one key.** RANGE and HASH accept multi-column keys, LIST does not, but in practice a single key (a date, a tenant_id, a hash modulus) is the right answer for ~95% of designs. Multi-column partition keys complicate pruning, ATTACH, FK enforcement, and the rotation runbook for marginal benefit. Reach for sub-partitioning before multi-column keys.

3. **Pruning happens at planning AND execution time, but only when the partition key appears in `WHERE`.** Planning-time pruning eliminates partitions whose `CHECK` constraint is incompatible with the query's WHERE clause. Execution-time pruning (PG11+) handles parameter values that are not known until execution (prepared statements, nested-loop join keys). If you query without referencing the partition key, *every* partition gets scanned[^prune-exec].

4. **`ATTACH PARTITION` has no `CONCURRENTLY` mode; `DETACH PARTITION CONCURRENTLY` exists since PG14 with restrictions.** This is the single most common operational confusion. ATTACH always takes `SHARE UPDATE EXCLUSIVE` on the parent + `ACCESS EXCLUSIVE` on the new partition; DETACH defaults to `ACCESS EXCLUSIVE` on the parent unless you use `CONCURRENTLY`. `DETACH CONCURRENTLY` cannot run in a transaction block and is forbidden when a DEFAULT partition exists[^detach-concurrently].

5. **Indexes on the partitioned parent propagate to children, but you cannot `CREATE INDEX CONCURRENTLY` on the parent directly.** The pattern is: create the index per-partition `CONCURRENTLY`, then create the parent index with `ON ONLY` (which marks it invalid until all partition indexes attach), then `ALTER INDEX … ATTACH PARTITION` each child[^index-only]. The parent index becomes valid automatically once every partition has a matching attached index.


## Decision Matrix

Use this matrix to pick a strategy before reaching for syntax. Three smell signals at the end identify cases where the matrix is wrong for your data.

| You have | Use | Avoid | Why |
|---|---|---|---|
| Time-series events, append-mostly, retention policy in months/years | **RANGE on the timestamp** | LIST per day, single huge unpartitioned table | RANGE prunes cleanly on time bounds; retention becomes `DETACH PARTITION` not `DELETE`. |
| Multi-tenant data, even-ish row counts per tenant | **HASH on tenant_id (modulus 16–64)** | LIST per tenant (operational nightmare at scale), RANGE on tenant_id | HASH spreads write load, keeps partitions sized uniformly, no rotation needed. |
| Small fixed set of categories with disjoint values (region, status, country) | **LIST on the category column** | HASH (kills locality), per-category schema | LIST gives exact-match pruning and natural per-category retention. |
| Large fact table joined frequently to a similarly-keyed table | **Same partition key + `enable_partitionwise_join`** | Partitioning only one side | Partitionwise joins eliminate cross-partition shuffles. |
| Need to drop ≥monthly partitions without affecting writers | **DETACH PARTITION CONCURRENTLY** (PG14+) | `DELETE WHERE date < …` | DETACH is metadata-only after CHECK is validated; DELETE generates bloat and WAL. |
| Need to load a large staging table and atomically add it to the partitioned set | **ATTACH PARTITION with pre-built `CHECK` constraint matching the partition bound** | `INSERT INTO partitioned SELECT` | ATTACH avoids the full table scan when a matching `CHECK` already exists. |
| Want unique constraints across the whole partitioned set | **Include all partition-key columns in the unique constraint** | Per-partition uniqueness | A unique constraint must include the partition key — see Gotcha #1. |
| Want a foreign key from partitioned to partitioned | **Same partition strategy on both sides** | Mismatched strategies | FKs work but each leaf partition gets a per-partition FK index. |
| Sub-1 GB tables with no retention policy | **Do not partition** | Partitioning a 50 MB table | Planner overhead and lock-fanout overwhelm any pruning benefit. |
| Append-only time-series < 1 TB on PG16+ | **BRIN on timestamp without partitioning** as Plan A | Partitioning by reflex | BRIN gives most of the locality win without the operational overhead. Cross-reference [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md). |

**Three smell signals that you reached for the wrong tool:**

1. You partitioned a table under 1 GB. The planner overhead and lock fanout on plans that touch many partitions costs more than the pruning saves. Drop partitioning, add a BRIN or B-tree index on the column you intended to use as the partition key.

2. Most of your queries omit the partition key. Pruning cannot help — you are scanning every partition every time, with extra planner work on top. Either (a) add the partition key to the WHERE clause everywhere, (b) re-partition by the column your queries actually filter on, or (c) un-partition.

3. You have more than ~1000 leaf partitions and complain about plan time. PG14 dramatically improved planning at high partition counts but the ceiling is still real. Coalesce — e.g., monthly partitions instead of daily for old data — or migrate to sub-partitioning where leaves stay reasonable.


## Syntax / Mechanics


### PARTITION BY grammar

A partitioned table declares its partition strategy at `CREATE TABLE` time. Once declared, the parent table has no storage of its own; data lives entirely in its partitions[^createtable].

```sql
-- RANGE on a timestamp
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    tenant_id   bigint NOT NULL,
    payload     jsonb NOT NULL
) PARTITION BY RANGE (occurred_at);

-- LIST on a category
CREATE TABLE shipments (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    region     text NOT NULL,
    weight_g   integer NOT NULL
) PARTITION BY LIST (region);

-- HASH on a tenant key with modulus 16
CREATE TABLE tenant_events (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id  bigint NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload    jsonb NOT NULL
) PARTITION BY HASH (tenant_id);
```

The verbatim grammar from `sql-createtable.html`[^createtable]:

```
PARTITION BY { RANGE | LIST | HASH } ( { column_name | ( expression ) } [ COLLATE collation ] [ opclass ] [, ...] )
```

> [!NOTE] PostgreSQL 12
> Partition bounds can be any expression (not just literal constants), evaluated once at partition creation time[^pg12-bounds]. Useful for partitions that should align to `date_trunc('month', now())` boundaries computed at DDL time.


### Three strategies: RANGE, LIST, HASH

Each leaf partition declares its bounds with `FOR VALUES`. The grammar:

```
IN ( partition_bound_expr [, ...] )                               -- LIST
| FROM ( bound | MINVALUE | MAXVALUE [, ...] )
  TO   ( bound | MINVALUE | MAXVALUE [, ...] )                    -- RANGE
| WITH ( MODULUS numeric_literal, REMAINDER numeric_literal )     -- HASH
```

```sql
-- RANGE: half-open intervals [FROM, TO)
CREATE TABLE events_2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE events_2026_06 PARTITION OF events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- LIST: explicit values
CREATE TABLE shipments_us PARTITION OF shipments FOR VALUES IN ('US');
CREATE TABLE shipments_eu PARTITION OF shipments FOR VALUES IN ('FR', 'DE', 'IT', 'ES');
CREATE TABLE shipments_apac PARTITION OF shipments FOR VALUES IN ('JP', 'KR', 'SG');

-- HASH: modulus + remainder; create one partition per remainder
CREATE TABLE tenant_events_0 PARTITION OF tenant_events
    FOR VALUES WITH (MODULUS 16, REMAINDER 0);
-- ... through ...
CREATE TABLE tenant_events_15 PARTITION OF tenant_events
    FOR VALUES WITH (MODULUS 16, REMAINDER 15);
```

RANGE bounds are half-open: `FROM ('2026-05-01') TO ('2026-06-01')` includes May 1 inclusive but excludes June 1. Adjacent partitions must not overlap and there must be no gap if you want every row to land. Use `MINVALUE` / `MAXVALUE` for unbounded ends.

> [!NOTE] PostgreSQL 11
> Hash partitioning was introduced in PG11[^pg11-hash]. Before PG11 you had only RANGE and LIST. Hash partitioning requires every row to land in exactly one partition, which means you must create every remainder from 0 to MODULUS-1.

> [!WARNING] HASH partitions cannot have a DEFAULT
> Hash partitioning is total by construction; there is no fallback. If you omit a remainder, INSERTs that hash to it will error with `no partition of relation … found for row`.


### DEFAULT partition

Since PG11, RANGE and LIST partitioned tables may have a DEFAULT partition that catches rows not matching any explicit bound[^pg11-default]:

```sql
CREATE TABLE shipments_other PARTITION OF shipments DEFAULT;

CREATE TABLE events_overflow PARTITION OF events DEFAULT;
```

DEFAULT partitions interact in two important ways:

1. **Future ATTACH/CREATE TABLE PARTITION OF requires a default-partition scan.** When you add a new partition with bounds that overlap rows currently in the DEFAULT partition, PostgreSQL must scan the DEFAULT partition to verify no row belongs in the new partition. This takes `ACCESS EXCLUSIVE` on the DEFAULT partition[^default-scan]. The workaround is to add a `CHECK` constraint on the DEFAULT partition that explicitly excludes the new partition's bounds:

   ```sql
   ALTER TABLE shipments_other ADD CONSTRAINT future_no_apac
       CHECK (region NOT IN ('JP', 'KR', 'SG')) NOT VALID;
   ALTER TABLE shipments_other VALIDATE CONSTRAINT future_no_apac;
   ```

2. **`DETACH PARTITION CONCURRENTLY` is forbidden if a DEFAULT partition exists.** The verbatim docs quote: *"`CONCURRENTLY` cannot be run in a transaction block and is not allowed if the partitioned table contains a default partition."*[^detach-concurrently] If you need DETACH CONCURRENTLY for partition rotation, you must drop the DEFAULT partition first (or accept blocking ACCESS EXCLUSIVE on the parent during DETACH).


### Sub-partitioning

A partition can itself be partitioned. The most common pattern is year → month for high-volume time-series:

```sql
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    payload     jsonb NOT NULL
) PARTITION BY RANGE (occurred_at);

-- Year-2026 sub-partitioned by month
CREATE TABLE events_2026 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')
    PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_01 PARTITION OF events_2026
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events_2026
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ... etc
```

Sub-partitioning is the right answer when a single-level partition would have too many leaves (planning overhead) or too few (uneven sizes). The cost: rotation runbooks become two-level, and a query that prunes well at the top level may still scan many leaves at the second level.


### ATTACH PARTITION

`ATTACH PARTITION` adds an existing table to the partitioned set. The key operational fact: **`ATTACH PARTITION` does NOT have a `CONCURRENTLY` mode** — only DETACH does. ATTACH takes `SHARE UPDATE EXCLUSIVE` on the parent plus `ACCESS EXCLUSIVE` on the table being attached and on the DEFAULT partition if present[^attach].

```sql
-- Build the staging table independently
CREATE TABLE events_staging_2026_07 (LIKE events INCLUDING ALL);
COPY events_staging_2026_07 FROM '/data/july-events.csv' (FORMAT csv);
CREATE INDEX ON events_staging_2026_07 (tenant_id);

-- Add a CHECK constraint matching the partition bound BEFORE attaching.
-- Without this, ATTACH performs a full table scan.
ALTER TABLE events_staging_2026_07 ADD CONSTRAINT range_check
    CHECK (occurred_at >= '2026-07-01' AND occurred_at < '2026-08-01') NOT VALID;
ALTER TABLE events_staging_2026_07 VALIDATE CONSTRAINT range_check;

-- ATTACH now skips the scan because the CHECK proves containment.
ALTER TABLE events ATTACH PARTITION events_staging_2026_07
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Optional: drop the redundant CHECK; the partition bound now enforces it.
ALTER TABLE events_staging_2026_07 DROP CONSTRAINT range_check;
```

> [!NOTE] PostgreSQL 12
> ATTACH PARTITION runs with reduced locking requirements since PG12[^pg12-attach]. Pre-PG12 took ACCESS EXCLUSIVE on the parent; PG12+ takes only SHARE UPDATE EXCLUSIVE.

Index ATTACH happens automatically when the parent index has a matching equivalent on the new partition — same column set, same opclass, same uniqueness, same predicate.


### DETACH PARTITION CONCURRENTLY

> [!NOTE] PostgreSQL 14
> `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` was introduced in PG14[^pg14-detach] as the headline partitioning feature of that release. Verbatim release-note quote: *"Allow partitions to be detached in a non-blocking manner. The syntax is `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY`, and `FINALIZE`."*

The mechanics, verbatim from `sql-altertable.html`[^detach-concurrently]:

> *"If `CONCURRENTLY` is specified, it runs using a reduced lock level to avoid blocking other sessions that might be accessing the partitioned table. In this mode, two transactions are used internally. During the first transaction, a `SHARE UPDATE EXCLUSIVE` lock is taken on both parent table and partition, and the partition is marked as undergoing detach; at that point, the transaction is committed and all other transactions using the partitioned table are waited for. Once all those transactions have completed, the second transaction acquires `SHARE UPDATE EXCLUSIVE` on the partitioned table and `ACCESS EXCLUSIVE` on the partition, and the detach process completes. A `CHECK` constraint that duplicates the partition constraint is added to the partition."*

Two hard restrictions:

1. **Cannot run in a transaction block.** Same constraint as `CREATE INDEX CONCURRENTLY` and `REINDEX CONCURRENTLY`. See migration framework escape hatches in [`26-index-maintenance.md`](./26-index-maintenance.md) Recipe 2.
2. **Forbidden when a DEFAULT partition exists.** You must drop the DEFAULT partition first or use the blocking form.

If DETACH CONCURRENTLY is canceled or interrupted mid-flight, the partition is in an in-between state. Recover with:

```sql
ALTER TABLE events DETACH PARTITION events_2025_01 FINALIZE;
```

Only one partition per parent can be in the pending-detach state at a time.

```sql
-- Canonical online detach for partition rotation
ALTER TABLE events DETACH PARTITION events_2025_01 CONCURRENTLY;
-- events_2025_01 is now a standalone table; archive or DROP at leisure
```


### Row movement

> [!NOTE] PostgreSQL 11
> UPDATE statements that change the partition key automatically move the row to the appropriate partition[^pg11-rowmove]. Pre-PG11 this raised an error.

```sql
-- An UPDATE that changes tenant_id moves the row across hash partitions.
UPDATE tenant_events
   SET tenant_id = 4242
 WHERE id = 17;
-- The row is internally DELETEd from one partition and INSERTed into another.
```

> [!NOTE] PostgreSQL 15
> Foreign-key actions on row movement were normalized in PG15[^pg15-fk]. Previously a partition-key UPDATE ran a `DELETE` action on the source partition and an `INSERT` action on the target, which could fire `ON DELETE` triggers and FK actions in surprising ways. PG15+ runs an UPDATE action on the partition root, giving the semantics most operators expect.

Row movement still has cost: the row is physically deleted from the source partition and inserted into the destination, which produces dead tuples in the source. Frequent partition-key UPDATEs negate the locality benefit of partitioning. If row movement is the norm, the partition key is wrong.


### Indexes on partitioned tables

> [!NOTE] PostgreSQL 11
> Indexes on partitioned tables were introduced in PG11[^pg11-index]. Pre-PG11 you had to create the index separately on each partition by hand.

The verbatim mental model from `ddl-partitioning.html`[^index-virtual]:

> *"An index or unique constraint declared on a partitioned table is 'virtual' in the same way that the partitioned table is: the actual data is in child indexes on the individual partition tables."*

`CREATE INDEX` on a partitioned parent recurses to every partition and creates a matching child index on each. New partitions added via `CREATE TABLE … PARTITION OF` automatically inherit the index. The `ONLY` keyword suppresses the recursion[^index-only]:

```sql
-- Recurse: create on parent + every partition
CREATE INDEX ON events (tenant_id);

-- ONLY parent: index is marked invalid until each partition has a matching attached index
CREATE INDEX events_tenant_idx ON ONLY events (tenant_id);
```

**The big restriction:** `CREATE INDEX CONCURRENTLY` does not work on a partitioned table parent[^index-concurrent]. Verbatim:

> *"Concurrent builds for indexes on partitioned tables are currently not supported. However, you may concurrently build the index on each partition individually and then finally create the partitioned index non-concurrently in order to reduce the time where writes to the partitioned table will be locked out. In this case, building the partitioned index is a metadata only operation."*

The online recipe is the three-step:

```sql
-- 1. Build the index per-partition CONCURRENTLY
CREATE INDEX CONCURRENTLY events_2026_05_tenant_idx ON events_2026_05 (tenant_id);
CREATE INDEX CONCURRENTLY events_2026_06_tenant_idx ON events_2026_06 (tenant_id);
-- ... for every partition

-- 2. Create the parent index with ONLY (marks invalid)
CREATE INDEX events_tenant_idx ON ONLY events (tenant_id);

-- 3. Attach each partition's index to the parent index
ALTER INDEX events_tenant_idx ATTACH PARTITION events_2026_05_tenant_idx;
ALTER INDEX events_tenant_idx ATTACH PARTITION events_2026_06_tenant_idx;
-- ... for every partition

-- Parent index automatically becomes valid once all partitions have attached.
```

Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md) Recipe 2 for the safe-CIC migration pattern; cross-reference [`23-btree-indexes.md`](./23-btree-indexes.md) for index-type details.


### Constraints on partitioned tables

`CHECK` and `NOT NULL` constraints declared on the partitioned parent are inherited by all partitions and cannot be dropped from individual partitions while the parent constraint exists[^constraint-inherit]. Reverse is not true — a partition may have additional `CHECK` constraints the parent does not.

**`UNIQUE` and `PRIMARY KEY`** on a partitioned table have a hard requirement: every column of the partition key must be included in the unique constraint[^unique-rule]. Verbatim:

> *"To create a unique or primary key constraint on a partitioned table, the partition keys must not include any expressions or function calls and the constraint's columns must include all of the partition key columns. This limitation exists because the individual indexes making up the constraint can only directly enforce uniqueness within their own partitions; therefore, the partition structure itself must guarantee that there are not duplicates in different partitions."*

Practical consequence: if you partition by `occurred_at` and want a primary key, the PK must be `(id, occurred_at)` not `(id)` alone. This is the single most surprising constraint of partitioning.

```sql
-- WRONG: PK on id alone with a non-PK partition key
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ERROR
    occurred_at timestamptz NOT NULL
) PARTITION BY RANGE (occurred_at);

-- RIGHT: composite PK including the partition key
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
```

> [!NOTE] PostgreSQL 17
> Exclusion constraints on partitioned tables are now supported[^pg17-exclude] as long as the exclusion compares partition-key columns for equality. Verbatim: *"Allow exclusion constraints on partitioned tables. As long as exclusion constraints compare partition key columns for equality, other columns can use exclusion constraint-specific comparisons."* Pre-PG17 you could only put exclusion constraints on individual leaf partitions.

> [!NOTE] PostgreSQL 17
> Identity columns on partitioned tables are allowed since PG17[^pg17-identity]. Verbatim: *"Allow partitioned tables to have identity columns."* Pre-PG17 you had to attach a sequence to a non-identity bigint column.


### Foreign keys

> [!NOTE] PostgreSQL 11
> FKs FROM a partitioned table to a non-partitioned table were added in PG11[^pg11-fk].

> [!NOTE] PostgreSQL 12
> FKs TO a partitioned table (referencing) were added in PG12[^pg12-fk-ref]. Verbatim: *"Allow foreign keys to reference partitioned tables."* Both directions now work.

FK enforcement on partitioned tables runs per-leaf-partition. Every leaf partition needs an index covering the FK columns to keep cascade DELETE / SET NULL performant. The pattern is the same as for non-partitioned tables — see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) (not yet written) for the deep dive.

```sql
CREATE TABLE tenants (
    id   bigint PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE events (
    id          bigint,
    occurred_at timestamptz NOT NULL,
    tenant_id   bigint NOT NULL REFERENCES tenants(id),
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- The FK applies to every leaf partition. Each partition needs its own
-- index on tenant_id for cascade-delete performance.
CREATE INDEX ON events (tenant_id);  -- recurses
```


### Partition pruning

The whole point of partitioning. Two flavors[^prune-exec]:

**Planning-time pruning** — partitions whose `CHECK` constraint is incompatible with the WHERE clause are eliminated before any execution begins. Works for constants:

```sql
SELECT * FROM events WHERE occurred_at >= '2026-05-15' AND occurred_at < '2026-05-16';
-- EXPLAIN shows only events_2026_05 in the plan.
```

**Execution-time pruning** (PG11+) — partitions whose CHECK is incompatible with a parameter value known at execution time are eliminated mid-execution. The values come from:

- Prepared statement parameters (`$1`).
- Nested-loop join keys (each outer-row value prunes the inner side).
- Subquery results.

The verbatim docs distinction[^prune-exec]:

> *"During initialization of the query plan. Partition pruning can be performed here for parameter values which are known during the initialization phase of execution. Partitions which are pruned during this stage will not show up in the query's `EXPLAIN` or `EXPLAIN ANALYZE`. It is possible to determine the number of partitions which were removed during this phase by observing the 'Subplans Removed' property in the `EXPLAIN` output. It's important to note that any partitions removed by the partition pruning done at this stage are still locked at the beginning of execution."*

> *"During actual execution of the query plan. Partition pruning may also be performed here to remove partitions using values which are only known during actual query execution."*

The "still locked at the beginning of execution" rule is the silent-cost gotcha — even a query that prunes to one partition will briefly lock-then-skip every other partition during planning, which matters at high partition counts.

```sql
-- Verify pruning fired
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM events
 WHERE occurred_at >= '2026-05-15' AND occurred_at < '2026-05-16';

-- Look for:
--   - Append node showing only one child (planning-time prune worked)
--   - "Subplans Removed: N" in the output (execution-time prune fired)
--   - Buffers reads only on the partitions that actually matter
```

Cross-reference [`56-explain.md`](./56-explain.md) (not yet written) for reading EXPLAIN output in detail.

`enable_partition_pruning` (default `on`) controls the optimization[^gucs]. Turning it off is exclusively a debugging tool — production should leave it on.


### Partition-wise join and aggregate

> [!NOTE] PostgreSQL 11
> Two `enable_*` GUCs were introduced in PG11 for these optimizations[^pg11-pwjoin] — **both default to `off`**. You must explicitly turn them on:

```sql
ALTER SYSTEM SET enable_partitionwise_join = on;
ALTER SYSTEM SET enable_partitionwise_aggregate = on;
SELECT pg_reload_conf();
```

The verbatim docs warnings for both[^gucs]:

> *"With this setting enabled, the number of nodes whose memory usage is restricted by `work_mem` appearing in the final plan can increase linearly according to the number of partitions being scanned. This can result in a large increase in overall memory consumption during the execution of the query. Query planning also becomes significantly more expensive in terms of memory and CPU."*

In practice: turn them on when joining two partitioned tables with the same partition strategy, modulus, and column type — partitionwise joins eliminate cross-partition shuffles. PG13 broadened the cases where partitionwise joins fire (no longer requires identical partition bounds)[^pg13-pwjoin]. PG18 broadened them further and reduced their memory cost[^pg18-pwjoin].


### Triggers on partitioned tables

> [!NOTE] PostgreSQL 11
> `FOR EACH ROW` triggers can be declared on partitioned tables[^pg11-trigger]; they are automatically cloned to existing and future partitions.

> [!NOTE] PostgreSQL 13
> `BEFORE ROW` triggers on partitioned tables work since PG13[^pg13-trigger], with the explicit restriction that they cannot change which partition the row lands in.

See [`39-triggers.md`](./39-triggers.md) (not yet written) for the trigger surface; the partition-specific rule is:

- An AFTER trigger sees the row in its final partition.
- A BEFORE trigger fires on the partition before insert, and cannot rewrite the row to a different partition.
- Trigger renames cascade properly only since PG15[^pg15-trigger-rename].


### Declarative partitioning limitations

The verbatim limitations list from `ddl-partitioning.html` §5.11.2.3[^limitations]:

1. **Unique / PK constraints must include all partition key columns** (covered above).
2. **No exclusion constraints spanning the whole partitioned table** pre-PG17 (PG17 relaxed this for partition-key-equality cases — see above).
3. **BEFORE ROW INSERT triggers cannot change destination partition.**
4. **Cannot mix temporary and permanent relations in one partition tree.**
5. **Partition cannot inherit from anything other than its partitioned parent**; no multiple inheritance.
6. **Partitions cannot have columns absent from the parent**; ALTER TABLE on a partition cannot add a column.
7. **`CHECK` and `NOT NULL` from the parent are always inherited** and cannot be dropped from partitions.
8. **Cannot use `ONLY` to add a constraint to the parent** when partitions exist (except UNIQUE and PRIMARY KEY).
9. **`TRUNCATE ONLY parent` always errors** because the parent has no rows of its own.

> [!NOTE] PostgreSQL 18
> Unlogged partitioned tables are now disallowed outright[^pg18-unlogged]. Pre-PG18 the `UNLOGGED` keyword on a partitioned parent silently did nothing (partitions remained logged); PG18 raises an error. Existing pg_dump output from older versions may need adjustment.


### Per-version timeline

| Version | Change | Cite |
|---|---|---|
| PG10 | Declarative partitioning introduced (RANGE + LIST); range, list partitioning, tuple-routing on INSERT/UPDATE | [^pg10-decl] |
| PG11 | Hash partitioning; indexes on partitioned tables; FK on partitioned table (partitioned → non-partitioned); DEFAULT partition; FOR EACH ROW triggers; row movement on partition-key UPDATE; execution-time partition pruning; partitionwise join (default off); partitionwise aggregate (default off) | [^pg11-hash], [^pg11-index], [^pg11-fk], [^pg11-default], [^pg11-trigger], [^pg11-rowmove], [^pg11-pwjoin] |
| PG12 | FK referencing partitioned table; partition pruning improvements; `COPY` into partitioned tables faster; reduced lock for ATTACH PARTITION; partition introspection functions (`pg_partition_root`, `pg_partition_ancestors`, `pg_partition_tree`); `\dP` in psql | [^pg12-fk-ref], [^pg12-bounds], [^pg12-attach], [^pg12-intro] |
| PG13 | More partition pruning cases; partitionwise joins fire with non-matching bounds; BEFORE ROW triggers on partitioned tables; logical replication of partitioned tables (with `publish_via_partition_root`); subscribers can target partitioned tables | [^pg13-pwjoin], [^pg13-trigger], [^pg13-logical] |
| PG14 | `DETACH PARTITION CONCURRENTLY` + `FINALIZE`; UPDATE/DELETE on partitioned tables much faster; `REINDEX` recurses through partition tree | [^pg14-detach], [^pg14-reindex] |
| PG15 | Planning time for queries on many partitions improved; ordered scans of partitions usable in more cases (default + multi-value LIST partitions); FK actions on row movement normalized to UPDATE action on root; `CLUSTER` on partitioned tables; `ALTER TRIGGER RENAME` properly recurses | [^pg15-plan], [^pg15-fk], [^pg15-cluster], [^pg15-trigger-rename] |
| PG16 | RANGE and LIST partition lookup caching | [^pg16-cache] |
| PG17 | Identity columns; exclusion constraints (with partition-key equality); partition pruning for `IS [NOT] UNKNOWN` on booleans; per-table access methods on partitioned tables | [^pg17-identity], [^pg17-exclude], [^pg17-bool-prune], [^pg17-am] |
| PG18 | Non-btree unique indexes allowed as partition keys (index type must support equality); partitionwise join broader + lower memory; planning faster on many partitions; cost estimates improved; `VACUUM`/`ANALYZE` with `ONLY` skip partition children (useful since autovacuum does not process partitioned parents); **unlogged partitioned tables disallowed (incompatibility)** | [^pg18-nonbtree-unique], [^pg18-pwjoin], [^pg18-plan], [^pg18-cost], [^pg18-vac-only], [^pg18-unlogged] |


## Examples / Recipes


### Recipe 1: Baseline range-partitioned events table

The canonical schema for time-series events with monthly retention. Composite PK (because the partition key must be in the PK), TOAST-aware payload column, generated hot-scalar for indexing.

```sql
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    tenant_id   bigint NOT NULL,
    event_type  text NOT NULL,
    payload     jsonb NOT NULL,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Indexes propagate to all partitions automatically.
CREATE INDEX ON events (tenant_id, occurred_at);
CREATE INDEX ON events USING gin (payload jsonb_path_ops);

-- Create the rolling window of partitions (current month + next two).
CREATE TABLE events_2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE events_2026_06 PARTITION OF events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE events_2026_07 PARTITION OF events
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
```

Production deployment automates partition creation via pg_partman + pg_cron — see [`99-pg-partman.md`](./99-pg-partman.md) for the canonical setup.


### Recipe 2: Online partition rotation (drop old, add new)

The monthly cron job: detach last month + 12 months ago, drop the archived one, add the next future month. Uses `DETACH PARTITION CONCURRENTLY` (PG14+) and assumes no DEFAULT partition (the precondition for CONCURRENTLY).

```sql
-- 1. Add the next future month (does not block; SHARE UPDATE EXCLUSIVE on parent).
CREATE TABLE events_2026_10 PARTITION OF events
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- 2. Detach the month 12 ago without blocking writers.
ALTER TABLE events DETACH PARTITION events_2025_05 CONCURRENTLY;
-- ^ Cannot run in a transaction block; the migration runner must
--   know to issue this outside of any explicit BEGIN.

-- 3. Archive or drop the now-standalone table at leisure.
DROP TABLE events_2025_05;
-- or: ALTER TABLE events_2025_05 RENAME TO events_archive_2025_05;
```

Cross-reference [`98-pg-cron.md`](./98-pg-cron.md) for scheduling this rotation; [`99-pg-partman.md`](./99-pg-partman.md) for the automation that does both steps + retention drop.


### Recipe 3: Convert non-partitioned table to partitioned

The standard online migration. Atomic swap at the end. Works on PG10+ but uses PG14+ DETACH/ATTACH semantics.

```sql
-- 1. Create new partitioned table with the same schema.
CREATE TABLE events_new (LIKE events_old INCLUDING ALL)
    PARTITION BY RANGE (occurred_at);

-- 2. Pre-create partitions covering all existing data + future room.
CREATE TABLE events_new_2024 PARTITION OF events_new
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE events_new_2025 PARTITION OF events_new
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE events_new_2026 PARTITION OF events_new
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

-- 3. Backfill in chunks. Use a tracking table or batched LIMIT pattern.
INSERT INTO events_new SELECT * FROM events_old WHERE id BETWEEN  0 AND 1000000;
INSERT INTO events_new SELECT * FROM events_old WHERE id BETWEEN 1000001 AND 2000000;
-- ... etc

-- 4. During a brief maintenance window: lock, top up, rename swap.
BEGIN;
LOCK TABLE events_old IN EXCLUSIVE MODE;  -- blocks writers, allows readers
INSERT INTO events_new SELECT * FROM events_old WHERE id > (SELECT max(id) FROM events_new);
ALTER TABLE events_old RENAME TO events_archive;
ALTER TABLE events_new RENAME TO events;
COMMIT;
-- 5. Drop events_archive when confidence is high.
```

For larger tables, use logical replication for the catch-up phase instead of `INSERT … SELECT`. See [`74-logical-replication.md`](./74-logical-replication.md) (not yet written).


### Recipe 4: ATTACH with pre-built CHECK to skip the scan

The fast path for adding a partition with existing data. Without the matching CHECK, ATTACH scans every row of the new partition. With it, ATTACH is essentially metadata.

```sql
-- Staging table populated independently (often via COPY from S3 / object storage).
CREATE TABLE events_2026_08_stage (LIKE events INCLUDING ALL);
COPY events_2026_08_stage FROM '/data/aug.csv' (FORMAT csv);

-- Add the CHECK constraint matching the intended partition bound, then VALIDATE.
ALTER TABLE events_2026_08_stage ADD CONSTRAINT bound_check
    CHECK (occurred_at >= '2026-08-01' AND occurred_at < '2026-09-01') NOT VALID;
ALTER TABLE events_2026_08_stage VALIDATE CONSTRAINT bound_check;

-- ATTACH skips the scan (PostgreSQL trusts the validated CHECK).
ALTER TABLE events ATTACH PARTITION events_2026_08_stage
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- The CHECK is now redundant with the partition bound; drop it.
ALTER TABLE events_2026_08_stage DROP CONSTRAINT bound_check;
```


### Recipe 5: Online index creation across all partitions

The three-step from §Indexes above, applied to a real-world case. Use `pg_class` to discover the partition list.

```sql
-- 1. Find every partition.
SELECT c.relname
  FROM pg_class c
  JOIN pg_inherits i ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'events' AND p.relkind = 'p'
 ORDER BY c.relname;

-- 2. Build the index CONCURRENTLY on each partition (out-of-transaction):
CREATE INDEX CONCURRENTLY events_2026_05_payload_type_idx
    ON events_2026_05 USING gin ((payload->'event_type'));
CREATE INDEX CONCURRENTLY events_2026_06_payload_type_idx
    ON events_2026_06 USING gin ((payload->'event_type'));
-- ... etc, one per partition

-- 3. Create the parent index ONLY (marks invalid), then attach each child.
CREATE INDEX events_payload_type_idx ON ONLY events USING gin ((payload->'event_type'));

ALTER INDEX events_payload_type_idx ATTACH PARTITION events_2026_05_payload_type_idx;
ALTER INDEX events_payload_type_idx ATTACH PARTITION events_2026_06_payload_type_idx;
-- ... etc

-- 4. Verify parent index validity (becomes 'true' once all partitions attached).
SELECT indrelid::regclass, indexrelid::regclass, indisvalid
  FROM pg_index
 WHERE indexrelid = 'events_payload_type_idx'::regclass;
```


### Recipe 6: Verify partition pruning is firing

The canonical sanity check after deploying partitioning. Use `EXPLAIN (ANALYZE, BUFFERS)` and confirm only the relevant partition appears in the plan.

```sql
-- Good — pruning by literal date.
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM events WHERE occurred_at >= '2026-05-15' AND occurred_at < '2026-05-16';
-- Expected: Append node has one child only (events_2026_05).

-- Good — prepared statement + parameter, execution-time pruning.
PREPARE q (timestamptz, timestamptz) AS
    SELECT count(*) FROM events WHERE occurred_at >= $1 AND occurred_at < $2;
EXPLAIN (ANALYZE) EXECUTE q ('2026-05-15', '2026-05-16');
-- Expected: "Subplans Removed: N" in the plan.

-- Bad — no partition-key predicate, every partition scanned.
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM events WHERE tenant_id = 1;
-- Expected: every partition shows in Append. Fix the query or re-partition.
```


### Recipe 7: HASH partitioning for multi-tenant workload

Even distribution across N hash partitions. Pick MODULUS such that average partition fits comfortably in shared_buffers + leaves room for growth.

```sql
CREATE TABLE tenant_events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id   bigint NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload     jsonb NOT NULL,
    PRIMARY KEY (id, tenant_id)  -- partition key must be in PK
) PARTITION BY HASH (tenant_id);

-- Create 16 partitions; every row hashes to exactly one.
DO $$
BEGIN
    FOR i IN 0..15 LOOP
        EXECUTE format(
            'CREATE TABLE tenant_events_%s PARTITION OF tenant_events
                 FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    END LOOP;
END
$$;

-- Pruning fires on equality with the partition key.
EXPLAIN ANALYZE SELECT * FROM tenant_events WHERE tenant_id = 4242 LIMIT 10;
-- Only one partition appears.
```

**HASH partitioning warning:** the modulus is part of the data layout. To go from MODULUS=16 to MODULUS=32 you must rebuild — there is no online resize.


### Recipe 8: Sub-partitioning (year then month)

For very high-volume time-series where a single-level monthly scheme would hit too many leaves. Years are the top level; months are the sub-partitions.

```sql
CREATE TABLE events_subpart (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    payload     jsonb NOT NULL,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_subpart_2026 PARTITION OF events_subpart
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')
    PARTITION BY RANGE (occurred_at);

CREATE TABLE events_subpart_2026_05 PARTITION OF events_subpart_2026
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE events_subpart_2026_06 PARTITION OF events_subpart_2026
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Aged 2024 partition is no longer touched. Sub-partitioned at year only
-- to keep the leaf count tractable.
CREATE TABLE events_subpart_2024 PARTITION OF events_subpart
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```


### Recipe 9: PG17 identity column on partitioned parent

Pre-PG17 you needed a non-identity bigint with a separate sequence. PG17 makes IDENTITY natural.

> [!NOTE] PostgreSQL 17

```sql
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    payload     jsonb NOT NULL,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Each partition shares the parent's sequence; no separate setup per partition.
```


### Recipe 10: Catalog audit — find every partitioned table and its leaves

```sql
-- All partitioned tables (relkind = 'p').
SELECT n.nspname || '.' || c.relname AS partitioned_table,
       pg_get_partkeydef(c.oid)        AS partition_key
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'p'
 ORDER BY 1;

-- Full partition tree for one partitioned parent (PG12+).
SELECT * FROM pg_partition_tree('events');

-- Direct children with their partition bounds.
SELECT c.relname AS partition_name,
       pg_get_expr(c.relpartbound, c.oid) AS bound,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c
  JOIN pg_inherits i ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'events' AND p.relkind = 'p'
 ORDER BY c.relname;

-- Partitions ordered by size, useful for diagnosing skew.
SELECT c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
       pg_total_relation_size(c.oid) AS bytes
  FROM pg_class c
  JOIN pg_inherits i ON c.oid = i.inhrelid
 WHERE i.inhparent = 'events'::regclass
 ORDER BY 3 DESC;
```


### Recipe 11: PG18 VACUUM ONLY parent

Autovacuum does not process the partitioned parent — it processes each leaf partition independently. Before PG18, `ANALYZE events` would recurse into all leaves (often wasteful). PG18 adds `ONLY` to both VACUUM and ANALYZE:

> [!NOTE] PostgreSQL 18

```sql
-- PG18+: refresh planner stats on the partitioned parent without recursing.
ANALYZE ONLY events;

-- Useful when autovacuum has analyzed leaves but the parent's plan-relevant
-- aggregate stats are stale.
VACUUM ONLY events;
```

Verbatim PG18 release-note quote: *"Allow `VACUUM` and `ANALYZE` to process partitioned tables without processing their children. This is enabled with the new `ONLY` option. This is useful since autovacuum does not process partitioned tables, just its children."*[^pg18-vac-only]

Cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the autovacuum-doesn't-touch-partitioned-parent rule.


### Recipe 12: Partitionwise join for two co-partitioned tables

```sql
ALTER SYSTEM SET enable_partitionwise_join = on;
SELECT pg_reload_conf();

-- Both partitioned by tenant_id with identical HASH (MODULUS=16) layout.
CREATE TABLE tenant_events (...) PARTITION BY HASH (tenant_id);
CREATE TABLE tenant_billing (...) PARTITION BY HASH (tenant_id);
-- ... matching MODULUS/REMAINDER on both ...

-- Join now happens per-partition instead of a Cartesian-style cross-shuffle.
EXPLAIN (ANALYZE, BUFFERS)
SELECT e.id, b.amount
  FROM tenant_events  e
  JOIN tenant_billing b USING (tenant_id)
 WHERE e.occurred_at >= '2026-05-01';
-- Look for: Append node containing Hash Join per partition, not a single
-- Hash Join over the full Appended sets.
```


### Recipe 13: DETACH-and-archive (retention drop)

```sql
-- Detach the old partition without blocking writers (PG14+).
ALTER TABLE events DETACH PARTITION events_2025_05 CONCURRENTLY;
-- ^ Outside of transaction block. No DEFAULT partition exists.

-- The detached table is now standalone. Three options:
-- A. Drop it.
DROP TABLE events_2025_05;

-- B. Rename and keep for compliance.
ALTER TABLE events_2025_05 RENAME TO events_archive_2025_05;

-- C. Export to cold storage then drop.
\copy events_2025_05 TO '/archive/events_2025_05.csv' (FORMAT csv);
DROP TABLE events_2025_05;
```


## Gotchas / Anti-patterns

1. **The PK must include the partition key.** The most common surprise. PostgreSQL cannot enforce uniqueness across partitions without a per-partition index, and the per-partition index cannot enforce uniqueness on a column that varies across partitions. If you want `id` as a logical row identifier, the table PK must be `(id, partition_key)`. Application code referencing `id` alone via FK must be redesigned.

2. **`ATTACH PARTITION CONCURRENTLY` does not exist.** Only DETACH has CONCURRENTLY. ATTACH always takes `SHARE UPDATE EXCLUSIVE` on the parent + `ACCESS EXCLUSIVE` on the table being attached. The lock-fanout is small but real.

3. **`DETACH PARTITION CONCURRENTLY` is forbidden if a DEFAULT partition exists.** Drop the DEFAULT first, or accept blocking ACCESS EXCLUSIVE on the parent.

4. **`DETACH PARTITION CONCURRENTLY` cannot run inside a transaction block.** Migration framework consumers must use the same escape hatches as for `CREATE INDEX CONCURRENTLY` — see [`26-index-maintenance.md`](./26-index-maintenance.md) Recipe 2.

5. **Pruning requires the partition key in WHERE.** A query without the partition key scans every partition. The most common cause of "I partitioned and the queries didn't get faster."

6. **`CREATE INDEX CONCURRENTLY` is not supported on the partitioned parent.** Use the three-step ONLY-then-attach pattern in Recipe 5. The parent-level CIC fails immediately with an error message rather than silently downgrading.

7. **Indexes on the parent recurse to all partitions and lock each one briefly.** On a table with hundreds of partitions, even a metadata-only operation can take noticeable time. Schedule index changes during quieter periods.

8. **Default partition with overlapping new partition triggers a default-partition scan.** Add a `CHECK` constraint on the DEFAULT partition excluding the new bounds before adding new partitions. Without this, the new ATTACH/CREATE PARTITION OF takes ACCESS EXCLUSIVE on the DEFAULT partition for the duration of the scan.

9. **Autovacuum does not touch the partitioned parent.** It processes each leaf independently. Stale parent stats (n_distinct, most-common-values) cause the planner to misestimate partition counts, leading to bad join orders and partition-pruning failures. Run `ANALYZE ONLY` on the parent manually or via pg_cron to keep parent stats current. PG18 added `ANALYZE ONLY` to refresh parent stats without recursing into leaves.

10. **HASH partitioning has no online MODULUS change.** Going from 16 to 32 hash partitions requires creating a new partitioned table and migrating data. Pick the MODULUS for your eventual scale, not your current scale.

11. **HASH partitioning has no DEFAULT partition.** Forgetting a remainder causes runtime errors for any row hashing to it.

12. **Partition-key UPDATEs cause row movement, which costs bloat.** If row movement is the norm rather than the exception, the partition key is wrong. Re-partition by a stable column.

13. **`enable_partitionwise_join` and `enable_partitionwise_aggregate` default to `off`.** PG11 introduced both; they have remained off-by-default for over a decade because the memory and planning cost can be significant. Turn them on deliberately, after measuring.

14. **Planning-time pruning locks every partition briefly even when pruning eliminates them.** The verbatim docs quote: *"any partitions removed by the partition pruning done at this stage are still locked at the beginning of execution."* At very high partition counts this adds noticeable latency.

15. **`pg_dump` of a partitioned table dumps the parent and each partition.** Restore order matters: the parent must be created first (with `PARTITION BY`), then each partition with `PARTITION OF`. `pg_restore --jobs=N` understands this; do not hand-craft the restore order.

16. **No partition-tree-spanning constraints other than PK/UNIQUE that include the key.** No CHECK on the parent that references aggregates across partitions; no FK enforcing uniqueness of `(id)` alone when the table is partitioned by something other than `id`.

17. **`TRUNCATE ONLY parent` always errors.** Use `TRUNCATE parent` (recurses) or `TRUNCATE specific_partition` to remove data without dropping partitions.

18. **`ALTER TABLE … ATTACH PARTITION` does not validate FK on the partition being attached.** The partition's existing FK constraints are trusted, not re-checked. If you mutated the partition outside the FK while detached, the resulting state is silently inconsistent. Always re-VALIDATE FKs after a non-trivial detach/attach cycle.

19. **The DEFAULT partition is scanned by ATTACH even when the new partition's bound is disjoint from the DEFAULT's actual contents.** PostgreSQL doesn't know that until proven by the scan. Always pre-build a matching `CHECK` constraint on the DEFAULT to skip the scan.

20. **Partitioned table indexes do not appear in `\d table_name` of the parent the same way as a regular table.** Use `\d+ table_name` for full info, or query `pg_indexes` joined with `pg_partition_tree('table_name')`.

21. **Schema-bound objects (sequences owned by IDENTITY columns) on PG10–16 partitioned tables are non-trivial.** PG17's `IDENTITY` on partitioned parents made this clean; pre-PG17 deployments often used a bigint + shared sequence pattern that pg_partman or migration scripts maintained.

22. **PG18 disallows unlogged partitioned tables.** Pre-PG18 the `UNLOGGED` keyword on a partitioned parent did nothing but `pg_dump` output preserved it. PG18+ raises an error when restoring such dumps. Audit `pg_class.relpersistence` for partitioned tables before upgrading.

23. **Multi-column partition keys complicate pruning.** Only a query that constrains the leading column will prune on the first level; further constraints help only if every preceding column is also constrained. Almost always simpler to sub-partition than to use a multi-column partition key.


## See Also

- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — CREATE TABLE / ALTER TABLE grammar, lock matrix for ATTACH/DETACH PARTITION.
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — partition-key UPDATE triggers DELETE + INSERT under MVCC; visibility implications.
- [`31-toast.md`](./31-toast.md) — each partition has its own TOAST sidecar relation; TOAST tables do not span partitions.
- [`22-indexes-overview.md`](./22-indexes-overview.md) — pick the right index type for partition keys (BRIN for time-series partitions is the canonical pattern).
- [`23-btree-indexes.md`](./23-btree-indexes.md) — B-tree mechanics; INCLUDE columns + partitioned-table considerations.
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — BRIN per-partition is the canonical time-series index.
- [`26-index-maintenance.md`](./26-index-maintenance.md) — CREATE INDEX CONCURRENTLY restrictions on partitioned tables; the three-step ONLY-then-attach pattern.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum does not process the partitioned parent; per-leaf scheduling.
- [`36-inheritance.md`](./36-inheritance.md) — legacy partitioning via inheritance; when (rarely) still right.
- [`37-constraints.md`](./37-constraints.md) — CHECK / NOT VALID / VALIDATE pattern used in ATTACH recipes.
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — FK on partitioned tables (PG11+) and FK referencing partitioned tables (PG12+).
- [`39-triggers.md`](./39-triggers.md) — FOR EACH ROW triggers on partitioned tables; BEFORE-ROW restrictions.
- [`43-locking.md`](./43-locking.md) — full lock-conflict matrix for ATTACH/DETACH/CIC.
- [`56-explain.md`](./56-explain.md) — reading partition pruning in EXPLAIN output ("Subplans Removed").
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_class.relkind`, `pg_partition_tree`, `pg_partition_ancestors`, `pg_partition_root`, `pg_inherits`.
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication of partitioned tables (PG13+); `publish_via_partition_root`.
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling partition rotation.
- [`99-pg-partman.md`](./99-pg-partman.md) — automation of partition lifecycle.


## Sources

[^createtable]: PG16 `CREATE TABLE` — PARTITION BY grammar and PARTITION OF semantics. *"The optional `PARTITION BY` clause specifies a strategy of partitioning the table. … When using range or hash partitioning, the partition key can include multiple columns or expressions (up to 32, but this limit can be altered when building PostgreSQL), but for list partitioning, the partition key must consist of a single column or expression."* https://www.postgresql.org/docs/16/sql-createtable.html

[^prune-exec]: PG16 declarative partitioning — partition pruning during execution. *"During initialization of the query plan … any partitions removed by the partition pruning done at this stage are still locked at the beginning of execution. … During actual execution of the query plan. Partition pruning may also be performed here to remove partitions using values which are only known during actual query execution."* https://www.postgresql.org/docs/16/ddl-partitioning.html

[^detach-concurrently]: PG16 `ALTER TABLE … DETACH PARTITION` — CONCURRENTLY restrictions. *"If `CONCURRENTLY` is specified, it runs using a reduced lock level to avoid blocking other sessions that might be accessing the partitioned table. … `CONCURRENTLY` cannot be run in a transaction block and is not allowed if the partitioned table contains a default partition."* https://www.postgresql.org/docs/16/sql-altertable.html

[^index-only]: PG16 `CREATE INDEX` — ONLY keyword and the parent-marked-invalid-until-all-attach pattern. *"When `CREATE INDEX` is invoked on a partitioned table, the default behavior is to recurse to all partitions to ensure they all have matching indexes. … If the `ONLY` option is specified, no recursion is done, and the index is marked invalid. (`ALTER INDEX ... ATTACH PARTITION` marks the index valid, once all partitions acquire matching indexes.)"* https://www.postgresql.org/docs/16/sql-createindex.html

[^index-concurrent]: PG16 `CREATE INDEX` — CONCURRENTLY not supported on partitioned tables; build per-partition pattern. *"Concurrent builds for indexes on partitioned tables are currently not supported. However, you may concurrently build the index on each partition individually and then finally create the partitioned index non-concurrently in order to reduce the time where writes to the partitioned table will be locked out. In this case, building the partitioned index is a metadata only operation."* https://www.postgresql.org/docs/16/sql-createindex.html

[^index-virtual]: PG16 declarative partitioning — virtual parent index. *"An index or unique constraint declared on a partitioned table is 'virtual' in the same way that the partitioned table is: the actual data is in child indexes on the individual partition tables."* https://www.postgresql.org/docs/16/ddl-partitioning.html

[^attach]: PG16 `ALTER TABLE … ATTACH PARTITION` — lock requirements and CHECK constraint skip-scan. *"Attaching a partition acquires a `SHARE UPDATE EXCLUSIVE` lock on the parent table, in addition to the `ACCESS EXCLUSIVE` locks on the table being attached and on the default partition (if any)."* https://www.postgresql.org/docs/16/sql-altertable.html

[^default-scan]: PG16 declarative partitioning — DEFAULT partition scan on ATTACH. *"Similarly, if the partitioned table has a `DEFAULT` partition, it is recommended to create a `CHECK` constraint which excludes the to-be-attached partition's constraint. If this is not done then the `DEFAULT` partition will be scanned to verify that it contains no records which should be located in the partition being attached."* https://www.postgresql.org/docs/16/ddl-partitioning.html

[^unique-rule]: PG16 declarative partitioning — UNIQUE / PRIMARY KEY must include all partition key columns. *"To create a unique or primary key constraint on a partitioned table, the partition keys must not include any expressions or function calls and the constraint's columns must include all of the partition key columns. This limitation exists because the individual indexes making up the constraint can only directly enforce uniqueness within their own partitions; therefore, the partition structure itself must guarantee that there are not duplicates in different partitions."* https://www.postgresql.org/docs/16/ddl-partitioning.html

[^constraint-inherit]: PG16 declarative partitioning — CHECK / NOT NULL inheritance from parent. *"Both `CHECK` and `NOT NULL` constraints of a partitioned table are always inherited by all its partitions. … You cannot drop a `NOT NULL` constraint on a partition's column if the same constraint is present in the parent table."* https://www.postgresql.org/docs/16/ddl-partitioning.html

[^limitations]: PG16 declarative partitioning — Limitations §5.11.2.3. https://www.postgresql.org/docs/16/ddl-partitioning.html

[^gucs]: PG16 runtime configuration — `enable_partition_pruning` (default on), `enable_partitionwise_join` (default off), `enable_partitionwise_aggregate` (default off). https://www.postgresql.org/docs/16/runtime-config-query.html

[^pg10-decl]: PG10 release notes — *"Add table partitioning syntax that automatically creates partition constraints and handles routing of tuple insertions and updates (Amit Langote). The syntax supports range and list partitioning."* https://www.postgresql.org/docs/release/10.0/

[^pg11-hash]: PG11 release notes — *"Allow the creation of partitions based on hashing a key column (Amul Sul)"* https://www.postgresql.org/docs/release/11.0/

[^pg11-index]: PG11 release notes — *"Support indexes on partitioned tables (Álvaro Herrera, Amit Langote). An 'index' on a partitioned table is not a physical index across the whole partitioned table, but rather a template for automatically creating similar indexes on each partition of the table. … The new command `ALTER INDEX ATTACH PARTITION` causes an existing index on a partition to be associated with a matching index template for its partitioned table."* https://www.postgresql.org/docs/release/11.0/

[^pg11-fk]: PG11 release notes — *"Allow foreign keys on partitioned tables (Álvaro Herrera)"* https://www.postgresql.org/docs/release/11.0/

[^pg11-default]: PG11 release notes — *"Allow partitioned tables to have a default partition (Jeevan Ladhe, Beena Emerson, Ashutosh Bapat, Rahila Syed, Robert Haas). The default partition will store rows that don't match any of the other defined partitions, and is searched accordingly."* https://www.postgresql.org/docs/release/11.0/

[^pg11-trigger]: PG11 release notes — *"Allow `FOR EACH ROW` triggers on partitioned tables (Álvaro Herrera). Creation of a trigger on a partitioned table automatically creates triggers on all existing and future partitions."* https://www.postgresql.org/docs/release/11.0/

[^pg11-rowmove]: PG11 release notes — *"`UPDATE` statements that change a partition key column now cause affected rows to be moved to the appropriate partitions (Amit Khandekar)"* https://www.postgresql.org/docs/release/11.0/

[^pg11-pwjoin]: PG11 release notes — *"In an equality join between partitioned tables, allow matching partitions to be joined directly (Ashutosh Bapat). This feature is disabled by default but can be enabled by changing `enable_partitionwise_join`."* and *"Allow aggregate functions on partitioned tables to be evaluated separately for each partition, subsequently merging the results (Jeevan Chalke, Ashutosh Bapat, Robert Haas). This feature is disabled by default but can be enabled by changing `enable_partitionwise_aggregate`."* https://www.postgresql.org/docs/release/11.0/

[^pg12-fk-ref]: PG12 release notes — *"Allow foreign keys to reference partitioned tables (Álvaro Herrera)"* https://www.postgresql.org/docs/release/12.0/

[^pg12-bounds]: PG12 release notes — *"Allow partition bounds to be any expression (Kyotaro Horiguchi, Tom Lane, Amit Langote). Such expressions are evaluated at partitioned-table creation time. Previously, only simple constants were allowed as partition bounds."* https://www.postgresql.org/docs/release/12.0/

[^pg12-attach]: PG12 release notes — *"`ALTER TABLE ATTACH PARTITION` is now performed with reduced locking requirements (Robert Haas)"* https://www.postgresql.org/docs/release/12.0/

[^pg12-intro]: PG12 release notes — *"Add partition introspection functions (Michaël Paquier, Álvaro Herrera, Amit Langote). The new function `pg_partition_root()` returns the top-most parent of a partition tree, `pg_partition_ancestors()` reports all ancestors of a partition, and `pg_partition_tree()` displays information about partitions."* https://www.postgresql.org/docs/release/12.0/

[^pg13-pwjoin]: PG13 release notes — *"Allow partitionwise joins to happen in more cases (Ashutosh Bapat, Etsuro Fujita, Amit Langote, Tom Lane). For example, partitionwise joins can now happen between partitioned tables even when their partition bounds do not match exactly."* https://www.postgresql.org/docs/release/13.0/

[^pg13-trigger]: PG13 release notes — *"Support row-level `BEFORE` triggers on partitioned tables (Álvaro Herrera). However, such a trigger is not allowed to change which partition is the destination."* https://www.postgresql.org/docs/release/13.0/

[^pg13-logical]: PG13 release notes — *"Allow partitioned tables to be logically replicated via publications (Amit Langote). Previously, partitions had to be replicated individually. … The `CREATE PUBLICATION` option `publish_via_partition_root` controls whether changes to partitions are published as their own changes or their parent's."* https://www.postgresql.org/docs/release/13.0/

[^pg14-detach]: PG14 release notes — *"Allow partitions to be detached in a non-blocking manner (Álvaro Herrera). The syntax is `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY`, and `FINALIZE`."* https://www.postgresql.org/docs/release/14.0/

[^pg14-reindex]: PG14 release notes — *"Allow `REINDEX` to process all child tables or indexes of a partitioned relation (Justin Pryzby, Michael Paquier)"* https://www.postgresql.org/docs/release/14.0/

[^pg15-plan]: PG15 release notes — *"Improve planning time for queries referencing partitioned tables (David Rowley). This change helps when only a few of many partitions are relevant."* https://www.postgresql.org/docs/release/15.0/

[^pg15-fk]: PG15 release notes — *"Improve foreign key behavior of updates on partitioned tables that move rows between partitions (Amit Langote). Previously, such updates ran a delete action on the source partition and an insert action on the target partition. PostgreSQL will now run an update action on the partition root, providing cleaner semantics."* https://www.postgresql.org/docs/release/15.0/

[^pg15-cluster]: PG15 release notes — *"Allow `CLUSTER` on partitioned tables (Justin Pryzby)"* https://www.postgresql.org/docs/release/15.0/

[^pg15-trigger-rename]: PG15 release notes — *"Fix `ALTER TRIGGER RENAME` on partitioned tables to properly rename triggers on all partitions (Arne Roland, Álvaro Herrera). Also prohibit cloned triggers from being renamed."* https://www.postgresql.org/docs/release/15.0/

[^pg16-cache]: PG16 release notes — *"Improve performance by caching `RANGE` and `LIST` partition lookups (Amit Langote, Hou Zhijie, David Rowley)"* https://www.postgresql.org/docs/release/16.0/

[^pg17-identity]: PG17 release notes — *"Allow partitioned tables to have identity columns (Ashutosh Bapat)"* https://www.postgresql.org/docs/release/17.0/

[^pg17-exclude]: PG17 release notes — *"Allow exclusion constraints on partitioned tables (Paul A. Jungwirth). As long as exclusion constraints compare partition key columns for equality, other columns can use exclusion constraint-specific comparisons."* https://www.postgresql.org/docs/release/17.0/

[^pg17-bool-prune]: PG17 release notes — *"Allow partition pruning on boolean columns on `IS [NOT] UNKNOWN` conditionals (David Rowley)"* https://www.postgresql.org/docs/release/17.0/

[^pg17-am]: PG17 release notes — *"Allow specification of table access methods on partitioned tables (Justin Pryzby, Soumyadeep Chakraborty, Michael Paquier)"* https://www.postgresql.org/docs/release/17.0/

[^pg18-nonbtree-unique]: PG18 release notes — *"Allow non-btree unique indexes to be used as partition keys and in materialized views (Mark Dilger). The index type must still support equality."* https://www.postgresql.org/docs/release/18.0/

[^pg18-pwjoin]: PG18 release notes — *"Allow partitionwise joins in more cases, and reduce its memory usage (Richard Guo, Tom Lane, Ashutosh Bapat)"* https://www.postgresql.org/docs/release/18.0/

[^pg18-plan]: PG18 release notes — *"Improve the efficiency of planning queries accessing many partitions (Ashutosh Bapat, Yuya Watari, David Rowley)"* https://www.postgresql.org/docs/release/18.0/

[^pg18-cost]: PG18 release notes — *"Improve cost estimates of partition queries (Nikita Malakhov, Andrei Lepikhov)"* https://www.postgresql.org/docs/release/18.0/

[^pg18-vac-only]: PG18 release notes — *"Allow `VACUUM` and `ANALYZE` to process partitioned tables without processing their children (Michael Harris). This is enabled with the new `ONLY` option. This is useful since autovacuum does not process partitioned tables, just its children."* https://www.postgresql.org/docs/release/18.0/

[^pg18-unlogged]: PG18 release notes (incompatibility) — *"Disallow unlogged partitioned tables (Michael Paquier). Previously `ALTER TABLE SET [UN]LOGGED` did nothing, and the creation of an unlogged partitioned table did not cause its children to be unlogged."* https://www.postgresql.org/docs/release/18.0/

# Index Maintenance

The operational surface that applies to *every* index type: how to build, rebuild, drop, and bloat-detect them online without locking out application traffic. This file is purely about the *mechanics* — pick the right index *type* in [`22-indexes-overview.md`](./22-indexes-overview.md), then come here to deploy or rebuild it on a live production cluster.

For the deep dive on each access method see [`23-btree-indexes.md`](./23-btree-indexes.md), [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md), [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [CREATE INDEX CONCURRENTLY](#create-index-concurrently)
- [REINDEX CONCURRENTLY](#reindex-concurrently)
- [DROP INDEX CONCURRENTLY](#drop-index-concurrently)
- [Bloat Detection with pgstattuple](#bloat-detection-with-pgstattuple)
- [Progress Monitoring](#progress-monitoring)
- [Online Table Reorg: pg_repack and pg_squeeze](#online-table-reorg-pg_repack-and-pg_squeeze)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when:

- You are about to run any `CREATE INDEX`, `REINDEX`, or `DROP INDEX` on a production table and need to know which form is safe and what locks it takes.
- You see `INVALID` indexes in `pg_index` (`indisvalid = false`) and need to clean them up.
- Index bloat is suspected — query times for index-only scans rose, or `pg_relation_size` of an index is much larger than the expected fan-out for `reltuples` rows.
- An autovacuum index-vacuum phase is taking too long, or planner stats suggest dead index entries are dominating leaf pages.
- Post-`pg_upgrade` cleanup is needed for B-tree dedup (PG13+) or libc collation upgrade invalidating text indexes.
- You are choosing between in-core `REINDEX CONCURRENTLY` and the community tools `pg_repack` / `pg_squeeze` for online bloat removal.

Do **not** load this file for: index *type* selection (use [`22-indexes-overview.md`](./22-indexes-overview.md)); operator-class catalog (use [`22-indexes-overview.md`](./22-indexes-overview.md) and the per-method files); query planning issues with healthy indexes (use [`56-explain.md`](./56-explain.md), [`55-statistics-planner.md`](./55-statistics-planner.md)).

## Mental Model

Five rules that should drive every decision in this file.

1. **CONCURRENTLY is the recommended practice in production.** Any `CREATE INDEX` / `REINDEX` / `DROP INDEX` on a non-trivial table in production should use `CONCURRENTLY`. Without it, the plain form takes `ACCESS EXCLUSIVE` on the table for the duration and blocks every read and write. With it, the operation takes `SHARE UPDATE EXCLUSIVE` and lets concurrent reads + DML proceed. The cost: CONCURRENTLY does *two* table scans and waits for concurrent transactions to drain between scans, so it runs roughly 2–3× longer than the plain form.[^createindex]

2. **CONCURRENTLY cannot run inside a transaction block.** *"a regular CREATE INDEX command can be performed within a transaction block, but CREATE INDEX CONCURRENTLY cannot"*[^createindex]. Same rule applies to `DROP INDEX CONCURRENTLY`[^dropindex] and `REINDEX CONCURRENTLY`. No `BEGIN; CREATE INDEX CONCURRENTLY ...; COMMIT;`, no migration framework that wraps every statement in a transaction — you need its "raw" or "transactional: false" escape hatch.

3. **Failed CONCURRENTLY leaves a ghost index behind.** *"If a problem arises while scanning the table, such as a deadlock or a uniqueness violation in a unique index, the CREATE INDEX command will fail but leave behind an 'invalid' index. This index will be ignored for querying purposes because it might be incomplete; however it will still consume update overhead."*[^createindex] Same trap for `REINDEX CONCURRENTLY` with `_ccnew` / `_ccold` suffixed indexes[^reindex]. **Always audit `indisvalid = false` before re-running.**

4. **REINDEX rebuilds; it doesn't shrink the table.** `REINDEX` is for *index* bloat. Heap bloat from dead-tuple churn requires `VACUUM FULL` (offline) or `pg_repack` / `pg_squeeze` (online). A REINDEX-CONCURRENTLY pass that "didn't help query performance" almost always means heap bloat, not index bloat — go diagnose with [`pgstattuple`](#bloat-detection-with-pgstattuple) first.

5. **The visibility map and FSM track the heap, not the index.** Index-only scans depend on the heap's visibility map being current (see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)); a freshly REINDEXed index still requires an UP-TO-DATE visibility map to skip the heap fetch. If you REINDEX and `Heap Fetches` in `EXPLAIN ANALYZE` remains nonzero, the problem is autovacuum lag on the *table*, not the index.

## Decision Matrix

Ten rows mapping operational scenario to the right tool. Rows ordered: most common first.

| Scenario                                                | Use                                              | Avoid                                  | Why                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Build a new index on a production table                 | **`CREATE INDEX CONCURRENTLY`**                  | plain `CREATE INDEX`                   | Plain form takes `ACCESS EXCLUSIVE` for the duration — blocks all reads + writes.                      |
| Rebuild a single bloated index in production            | **`REINDEX INDEX CONCURRENTLY`** (PG12+)[^pg12-rc] | `DROP + CREATE INDEX CONCURRENTLY`     | REINDEX preserves constraints / FK references; drop+create requires temporarily unconstraining.        |
| Rebuild all indexes on a table                          | **`REINDEX TABLE CONCURRENTLY`** (PG12+)         | per-index loop                         | One command, handles TOAST table indexes, atomic per-index swap.                                       |
| Drop an old / unused index                              | **`DROP INDEX CONCURRENTLY`**                    | plain `DROP INDEX`                     | Plain form takes `ACCESS EXCLUSIVE`; CONCURRENTLY waits for conflicting transactions instead.          |
| Clean up an `INVALID` index from a failed CIC           | **`DROP INDEX [CONCURRENTLY]`** + retry CIC      | `REINDEX`                              | See §Failure Recovery below for exact procedure.                                                        |
| Clean up `_ccnew` / `_ccold` from a failed `REINDEX CC` | **`DROP INDEX`** by suffix                       | re-run REINDEX                         | See §`_ccnew` / `_ccold` Suffix Recovery below for decision tree.                                      |
| Heap bloat from dead-tuple churn                        | **`pg_repack`** or **`pg_squeeze`**              | `REINDEX`, `VACUUM FULL`               | REINDEX fixes only index bloat; `VACUUM FULL` is offline; community tools are online.                  |
| Post-`pg_upgrade` dedup migration (PG12 → ≥PG13)        | **`REINDEX INDEX CONCURRENTLY`** per B-tree      | leave it                               | PG13+ B-tree dedup requires REINDEX after pg_upgrade to take effect[^pg13-dedup-cite].                 |
| Post-libc/ICU upgrade (collation version mismatch)      | **`REINDEX INDEX CONCURRENTLY`** on text indexes | trust the cluster                      | Silent corruption risk; pg_amcheck flags `XX002 index_corrupted`. See [`65-collations-encoding.md`](./65-collations-encoding.md). |
| Periodic preventive reindex on a churn-heavy table      | **`REINDEX TABLE CONCURRENTLY`** monthly         | `pg_repack` for index-only             | REINDEX CONCURRENTLY is the in-core, lower-overhead choice when heap is not bloated.                   |

Three smell signals for wrong tool:

- **REINDEX did not change query latency.** Almost always means heap bloat, not index bloat. Run `pgstattuple` on the *table* before reaching for REINDEX again.
- **CIC takes 5×+ longer than the plain form.** Almost always means a long-running transaction is blocking the "wait for existing transactions" phase. Check `pg_stat_activity` for `xact_start` older than your CIC start time — kill or wait.
- **Same `INVALID` index name keeps reappearing.** A unique-index CIC failing on unique violations: data already has duplicates. Use a non-unique CIC, dedupe, then add the UNIQUE constraint via `ALTER TABLE ... ADD CONSTRAINT ... USING INDEX` (which requires a non-unique-then-promote pattern won't actually help — the real fix is dedupe first, then create the unique index).

## CREATE INDEX CONCURRENTLY

### Mechanics

The verbatim three-step protocol from `sql-createindex.html`:

> *"In a concurrent index build, the index is actually entered as an 'invalid' index into the system catalogs in one transaction, then two table scans occur in two more transactions. Before each table scan, the index build must wait for existing transactions that have modified the table to terminate. After the second scan, the index build must wait for any transactions that have a snapshot (see Chapter 13. Concurrency Control) predating the second scan to terminate, including transactions used by any phase of concurrent index builds on other tables, if the indexes involved are partial or have columns that are not simple column references. Then finally the index can be marked 'valid' and ready for use, and the CREATE INDEX command terminates."*[^createindex]

What this means operationally:

1. **First catalog transaction.** Index entry created with `indisready = false`, `indisvalid = false`. Other backends now know about the index but ignore it for queries and writes.
2. **Wait for old transactions to finish.** Any in-flight DML must drain so the new index can see a consistent state.
3. **First table scan.** Builds the index from existing rows. Returns to the planner with `indisready = true`, `indisvalid = false`. From this point on, every concurrent write also writes to the new index.
4. **Wait again.** Drain transactions older than the second scan's snapshot.
5. **Second table scan.** Picks up any rows written between the first scan and `indisready = true`.
6. **Wait once more.** Drain snapshots older than the second-scan snapshot, since they could still hold a view in which the index is "incomplete."
7. **Mark valid.** `indisvalid = true`. Index is now eligible for query planning.

### Lock Levels (verbatim)

> *"Normally PostgreSQL locks the table to be indexed against writes and performs the entire index build with a single scan of the table. Other transactions can still read the table, but if they try to insert, update, or delete rows in the table they will block until the index build is finished."*[^createindex]

> *"When this option is used, PostgreSQL will build the index without taking any locks that prevent concurrent inserts, updates, or deletes on the table; whereas a standard index build locks out writes (but not reads) on the table until it's done."*[^createindex]

The exact lock taken by `CREATE INDEX CONCURRENTLY` is `SHARE UPDATE EXCLUSIVE` on the table. This conflicts with itself (two concurrent index builds on the same table block each other), with `VACUUM`, with `ANALYZE`, and with most schema changes — but **not** with `INSERT` / `UPDATE` / `DELETE` / `SELECT`.

### Restrictions

> *"Regular index builds permit other regular index builds on the same table to occur simultaneously, but only one concurrent index build can occur on a table at a time. In either case, schema modification of the table is not allowed while the index is being built. Another difference is that a regular CREATE INDEX command can be performed within a transaction block, but CREATE INDEX CONCURRENTLY cannot."*[^createindex]

Three independent rules embedded here:

- **At most one CIC per table at a time.** If you need to build N indexes on one table, serialize them — there is no parallelism across CICs on the same relation.
- **Schema changes blocked.** `ALTER TABLE` (including `ADD COLUMN` with a default that does a rewrite) is locked out by the CIC's `SHARE UPDATE EXCLUSIVE`.
- **Not in a transaction block.** Most migration frameworks (Rails, Alembic, Flyway, Django) wrap every statement in a transaction. You must use the framework's "raw" or "transactional: false" escape hatch.

### Unique-Index Special Case

> *"Another caveat when building a unique index concurrently is that the uniqueness constraint is already being enforced against other transactions when the second table scan begins. This means that constraint violations could be reported in other queries prior to the index becoming available for use, or even in cases where the index build eventually fails. Also, if a failure does occur in the second scan, the 'invalid' index continues to enforce its uniqueness constraint afterwards."*[^createindex]

Translation: once the first scan completes, every concurrent INSERT or UPDATE that would violate uniqueness *fails* — even if the CIC itself later fails. Until you `DROP INDEX` the invalid leftover, the uniqueness constraint is "live" in the sense that it rejects writes.

### Failure Recovery

> *"The recommended recovery method in such cases is to drop the index and try again to perform CREATE INDEX CONCURRENTLY. (Another possibility is to rebuild the index with REINDEX INDEX CONCURRENTLY)."*[^createindex]

The drop-and-retry path is the safer default. REINDEX-the-invalid-index works in principle but couples your retry to whatever caused the original failure — if the cause was a data issue (duplicate values for a unique index, NULL violations for a CHECK on the column), it will fail again the same way.

### Audit for Failed CICs

    SELECT
        n.nspname  AS schema,
        c.relname  AS index,
        t.relname  AS table,
        i.indisvalid,
        i.indisready,
        pg_size_pretty(pg_relation_size(c.oid)) AS size
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT i.indisvalid OR NOT i.indisready
    ORDER BY pg_relation_size(c.oid) DESC;

Any row here is consuming write overhead for zero query benefit. Drop it.

## REINDEX CONCURRENTLY

> [!NOTE] PostgreSQL 12
> `REINDEX CONCURRENTLY` was introduced in PG12 (Michaël Paquier, Andreas Karlsson, Peter Eisentraut)[^pg12-rc]. On PG11 and earlier the only options were `REINDEX INDEX` (offline) or the manual two-step `CREATE INDEX CONCURRENTLY name_new; DROP INDEX CONCURRENTLY name; ALTER INDEX name_new RENAME TO name;` pattern.

### Six-Step Swap Mechanics (verbatim)

> *"1. A new transient index definition is added to the catalog `pg_index`. This definition will be used to replace the old index. A `SHARE UPDATE EXCLUSIVE` lock at session level is taken on the indexes being reindexed as well as their associated tables to prevent any schema modification while processing.*
>
> *2. A first pass to build the index is done for each new index. Once the index is built, its flag `pg_index.indisready` is switched to 'true' to make it ready for inserts, making it visible to other sessions once the transaction that performed the build is finished. This step is done in a separate transaction for each index.*
>
> *3. Then a second pass is performed to add tuples that were added while the first pass was running. This step is also done in a separate transaction for each index.*
>
> *4. All the constraints that refer to the index are changed to refer to the new index definition, and the names of the indexes are changed. At this point, `pg_index.indisvalid` is switched to 'true' for the new index and to 'false' for the old, and a cache invalidation is done causing all sessions that referenced the old index to be invalidated.*
>
> *5. The old indexes have `pg_index.indisready` switched to 'false' to prevent any new tuple insertions, after waiting for running queries that might reference the old index to complete.*
>
> *6. The old indexes are dropped. The `SHARE UPDATE EXCLUSIVE` session locks for the indexes and the table are released."*[^reindex]

Operational consequences:

- The new index is built in parallel with continuing DML; both the old and the new index are written for the gap between steps 2 and 5.
- The name swap (step 4) is atomic from a query-planner perspective — there is no "no index for this column" window.
- The old index briefly remains in `pg_index` between steps 4 and 6, with `indisvalid = false`. If REINDEX fails after step 4 you may see it as `_ccold`.

### `_ccnew` / `_ccold` Suffix Recovery (verbatim)

> *"If a problem arises while rebuilding the indexes, such as a uniqueness violation in a unique index, the REINDEX command will fail but leave behind an 'invalid' new index in addition to the pre-existing one. This index will be ignored for querying purposes because it might be incomplete; however it will still consume update overhead."*[^reindex]

> *"If the index marked INVALID is suffixed `_ccnew`, then it corresponds to the transient index created during the concurrent operation, and the recommended recovery method is to drop it using DROP INDEX, then attempt REINDEX CONCURRENTLY again. If the invalid index is instead suffixed `_ccold`, it corresponds to the original index which could not be dropped; the recommended recovery method is to just drop said index, since the rebuild proper has been successful. A nonzero number may be appended to the suffix of the invalid index names to keep them unique, like `_ccnew1`, `_ccold2`, etc."*[^reindex]

Decision tree:

- Invalid index named `*_ccnew*` → the rebuild failed mid-way. Drop it, fix the underlying cause (duplicate data, lock timeout, etc.), retry REINDEX.
- Invalid index named `*_ccold*` → the rebuild *succeeded* but the old index couldn't be dropped. Drop the old one — the new one is already in service.

### What REINDEX CONCURRENTLY Cannot Do

> *"Furthermore, indexes for exclusion constraints cannot be reindexed concurrently. If such an index is named directly in this command, an error is raised. If a table or database with exclusion constraint indexes is reindexed concurrently, those indexes will be skipped."*[^reindex]

> *"REINDEX SYSTEM does not support CONCURRENTLY since system catalogs cannot be reindexed concurrently."*[^reindex]

Two hard constraints to remember:

- **Exclusion-constraint indexes** (typically `EXCLUDE USING gist`) — REINDEX CONCURRENTLY *skips* them silently when reindexing a whole table or database. To rebuild them you must drop the constraint and recreate it (which requires `ACCESS EXCLUSIVE`).
- **System catalogs** — `REINDEX SYSTEM` is offline-only. Schedule a maintenance window or use a logical replication failover (see [`87-major-version-upgrade.md`](./87-major-version-upgrade.md)).

### Variants

| Variant                                | Scope                                                                      | CONCURRENTLY?       |
| -------------------------------------- | -------------------------------------------------------------------------- | ------------------- |
| `REINDEX INDEX name`                   | Single named index                                                         | ✓                   |
| `REINDEX TABLE name`                   | All indexes on the table plus its TOAST table indexes                      | ✓                   |
| `REINDEX SCHEMA name`                  | All indexes in a schema (and TOAST), skipping system catalogs              | ✓                   |
| `REINDEX DATABASE`                     | All indexes in the database (PG16+ excludes system catalogs by default)[^pg16-reindex] | ✓        |
| `REINDEX SYSTEM`                       | System catalog indexes only                                                | ✗ — offline only    |

Two options worth knowing:

- **`REINDEX (VERBOSE) ...`** — prints a progress report as each index is reindexed.
- **`REINDEX (TABLESPACE name) ...`** — rebuilds the index in a different tablespace (PG14+)[^pg14-reindex-tablespace]. *"When using the TABLESPACE clause with REINDEX on a partitioned index or table, only the tablespace references of the leaf partitions are updated."*[^reindex]

> [!NOTE] PostgreSQL 17
> `MAINTAIN` privilege and the `pg_maintain` predefined role were added in PG17[^pg17-maintain]. Permitted operations: VACUUM, ANALYZE, REINDEX, REFRESH MATERIALIZED VIEW, CLUSTER, and LOCK TABLE. Grants the ability to delegate index rebuilds to a non-superuser role.

> [!NOTE] PostgreSQL 17
> `reindexdb --index` can now process indexes from different tables in parallel[^pg17-reindexdb]. Useful for cluster-wide maintenance windows.

## DROP INDEX CONCURRENTLY

> *"Drop the index without locking out concurrent selects, inserts, updates, and deletes on the index's table. A normal DROP INDEX acquires an ACCESS EXCLUSIVE lock on the table, blocking other accesses until the index drop can be completed. With this option, the command instead waits until conflicting transactions have completed."*[^dropindex]

### Restrictions (verbatim)

> *"There are several caveats to be aware of when using this option. Only one index name can be specified, and the CASCADE option is not supported. (Thus, an index that supports a UNIQUE or PRIMARY KEY constraint cannot be dropped this way.) Also, regular DROP INDEX commands can be performed within a transaction block, but DROP INDEX CONCURRENTLY cannot. Lastly, indexes on partitioned tables cannot be dropped using this option."*[^dropindex]

Five independent restrictions:

1. **One index per command.** No batch drop.
2. **No CASCADE.** Drop dependents manually first.
3. **Cannot drop a unique-/PK-backing index.** You must `ALTER TABLE ... DROP CONSTRAINT` first (which takes `ACCESS EXCLUSIVE`).
4. **Not in a transaction block.**
5. **Not on partitioned-table parent indexes.** Drop the parent index with the plain (locking) form, or detach + drop each partition's index.

> *"For temporary tables, DROP INDEX is always non-concurrent, as no other session can access them, and non-concurrent index drop is cheaper."*[^dropindex]

## Bloat Detection with pgstattuple

`pgstattuple` is a contrib extension. Two layers of granularity: full-scan (`pgstattuple`) and sampled (`pgstattuple_approx`). On very large indexes the full scan is expensive — prefer the approximate function for monitoring; reserve the full scan for an answer-this-question-now diagnostic.

### Setup

    CREATE EXTENSION pgstattuple;
    -- Grant access to a non-superuser monitoring role:
    GRANT pg_stat_scan_tables TO monitoring;

Per docs: *"By default, only the role `pg_stat_scan_tables` has EXECUTE privilege. Superusers of course bypass this restriction."*[^pgstattuple]

### Function Catalog

| Function                        | Target           | Cost        | What it returns                                                            |
| ------------------------------- | ---------------- | ----------- | -------------------------------------------------------------------------- |
| `pgstattuple(regclass)`         | Tables, any index | Full scan   | `tuple_count`, `dead_tuple_count`, `dead_tuple_percent`, `free_percent`    |
| `pgstattuple_approx(regclass)`  | Tables, B-tree   | Sampled     | `scanned_percent`, `approx_tuple_percent`, `dead_tuple_percent`            |
| `pgstatindex(regclass)`         | B-tree           | Full scan   | `avg_leaf_density`, `leaf_fragmentation`, `deleted_pages`, `empty_pages`   |
| `pgstatginindex(regclass)`      | GIN              | Full scan   | `pending_pages`, `pending_tuples`                                          |
| `pgstathashindex(regclass)`     | Hash (PG10+)     | Full scan   | `bucket_pages`, `overflow_pages`, `live_items`, `dead_tuples`, `free_percent` |
| `pg_relpages(regclass)`         | Any              | O(1)        | Page count                                                                 |

### Key Columns for Diagnosis

**For B-tree indexes (`pgstatindex`):**

- `avg_leaf_density` — percentage of leaf-page space used by live tuples. Healthy B-trees sit at ~70–90%; the default fillfactor 90 caps this at 90% after a fresh build. Below ~50% means substantial bloat.
- `leaf_fragmentation` — percentage of leaf pages out of physical order. Above ~50% degrades range-scan performance.
- `deleted_pages` — pages marked deleted but not yet reclaimed. Reclaimable by autovacuum; persistent high values suggest a long-running transaction is holding back vacuum (see [`27-mvcc-internals.md`](./27-mvcc-internals.md)).

**For tables (`pgstattuple`):**

- `dead_tuple_percent` — fraction of heap occupied by dead tuples. Above ~20% on a hot table means autovacuum is falling behind or a long-running transaction is blocking it.

**For GIN indexes (`pgstatginindex`):**

- `pending_pages` and `pending_tuples` — the fastupdate pending list. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for the deep dive. Non-zero is fine; persistently growing is the smell.

### Triage Sequence

1. Identify suspect table via `pg_stat_user_tables.n_dead_tup / n_live_tup`. Top offenders are usually obvious.
2. Run `pgstattuple_approx(suspect_table)` for the table; `pgstatindex(suspect_index)` for each B-tree on it.
3. If `dead_tuple_percent > 20%` *on the heap* — heap bloat, REINDEX won't help, reach for `pg_repack` or `pg_squeeze`.
4. If `avg_leaf_density < 50%` *on an index* — index bloat, `REINDEX INDEX CONCURRENTLY` fixes it.
5. Cross-check with a query like recipe 1 below to find any *unused* indexes — dropping them is often cheaper than reindexing.

## Progress Monitoring

`pg_stat_progress_create_index` reports the live state of a `CREATE INDEX`, `CREATE INDEX CONCURRENTLY`, `REINDEX`, or `REINDEX CONCURRENTLY` operation. Available since PG12[^pg12-progress].

### Columns

| Column                | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `pid`                 | PID of the backend running the operation                                      |
| `command`             | `CREATE INDEX`, `CREATE INDEX CONCURRENTLY`, `REINDEX`, or `REINDEX CONCURRENTLY` |
| `phase`               | Current phase (see below)                                                     |
| `lockers_total`       | Total number of lockers being waited on in the current phase                  |
| `lockers_done`        | Lockers already waited out                                                    |
| `current_locker_pid`  | PID of the locker currently being waited on                                   |
| `blocks_total`        | Total heap blocks to be scanned                                               |
| `blocks_done`         | Heap blocks scanned so far                                                    |
| `tuples_total`        | Total tuples to be indexed                                                    |
| `tuples_done`         | Tuples indexed so far                                                         |
| `partitions_total`    | Total partitions (for partitioned-index builds)                               |
| `partitions_done`     | Partitions done                                                               |

### Phases (verbatim)

The `phase` column cycles through, in order:

- `initializing`
- `waiting for writers before build`
- `building index`
- `waiting for writers before validation`
- `index validation: scanning index`
- `index validation: sorting tuples`
- `index validation: scanning table`
- `waiting for old snapshots`
- `waiting for readers before marking dead`
- `waiting for readers before dropping`

The two phases that bite the most:

- **`waiting for writers before build`** and **`waiting for writers before validation`** — a long-running transaction (any session with `xact_start` older than your operation) blocks here. Hunt them via `pg_stat_activity` ordered by `xact_start`.
- **`waiting for old snapshots`** — the same problem after the second scan; the operation has done all its real work but cannot mark the index valid until the oldest snapshot in the cluster ends.

### Diagnostic Query

    SELECT
        a.pid,
        p.command,
        p.phase,
        round(100.0 * p.blocks_done / NULLIF(p.blocks_total, 0), 1) AS pct_blocks,
        round(100.0 * p.tuples_done / NULLIF(p.tuples_total, 0), 1) AS pct_tuples,
        p.current_locker_pid,
        now() - a.xact_start AS xact_duration,
        a.query
    FROM pg_stat_progress_create_index p
    JOIN pg_stat_activity a USING (pid)
    ORDER BY a.xact_start;

> [!NOTE] PostgreSQL 14
> *"Allow index commands using CONCURRENTLY to avoid waiting for the completion of other operations using CONCURRENTLY"*[^pg14-cic-wait]. Pre-PG14, one running CIC could block another CIC on a different table; PG14+ they no longer serialize on each other.

## Online Table Reorg: pg_repack and pg_squeeze

`REINDEX CONCURRENTLY` only fixes *index* bloat. For *heap* bloat — where dead tuples consume table pages and autovacuum cannot reclaim them (e.g., the live tuples are too scattered, or fillfactor is low) — the in-core options are `VACUUM FULL` (rewrites the table; takes `ACCESS EXCLUSIVE`; offline) and `CLUSTER` (same lock; reorders by an index). Both are unacceptable for production traffic. Two community extensions fill the gap.

### pg_repack

Project: <https://github.com/reorg/pg_repack>. Long-running de-facto standard.

> *"pg_repack is a PostgreSQL extension which lets you remove bloat from tables and indexes, and optionally restore the physical order of clustered indexes. Unlike CLUSTER and VACUUM FULL it works online, without holding an exclusive lock on the processed tables during processing. pg_repack is efficient to boot, with performance comparable to using CLUSTER directly."*[^pg-repack]

**How it works:** creates a shadow table, registers triggers on the original to capture concurrent DML, copies the live tuples in physical order to the shadow, replays trigger-captured DML, then briefly takes `ACCESS EXCLUSIVE` to swap the relfilenodes. The swap window is small (sub-second on typical hardware) but it is *not* zero — connection-pooled apps may see a brief stall.

**What it can do:**

- Rebuild a table online, reclaiming heap bloat.
- Rebuild only the indexes of a table (`-x` / `--only-indexes`) — similar to REINDEX TABLE CONCURRENTLY but with parallelism across indexes.
- Cluster a table by an index online.

**What it cannot do:**

- Tables without a primary key or REPLICA IDENTITY USING INDEX (the shadow approach needs a stable key for replay).
- Tables with `EXCLUDE USING gist` constraints (similar limitation to REINDEX CONCURRENTLY).
- Partitioned tables — must repack each leaf partition individually.

**Operational notes:** runs as a client tool (`pg_repack` binary) talking to a backend; requires superuser; takes its own catalog locks during setup. Always test on a staging snapshot first.

### pg_squeeze

Project: <https://github.com/cybertec-postgresql/pg_squeeze>. Server-side, logical-decoding-based.

> *"PostgreSQL extension that removes unused space from a table and optionally sorts tuples according to particular index (as if CLUSTER command was executed concurrently with regular reads / writes). In fact we try to replace pg_repack extension."*[^pg-squeeze]

**How it works:** uses PostgreSQL's *logical decoding* (`wal_level = logical`) to capture concurrent DML rather than triggers. A background worker reads the WAL stream, applies changes to the shadow, and swaps at the end. Trigger-free means lower transaction-overhead during the operation.

**Requirements:**

- `wal_level = logical`
- `max_replication_slots >= 1` (free one for pg_squeeze to use)
- `shared_preload_libraries = 'pg_squeeze'`
- Table needs an identity index — PRIMARY KEY, UNIQUE NOT NULL, or `REPLICA IDENTITY USING INDEX`.

**What it can do:**

- Same scope as pg_repack: heap bloat reclamation, optional cluster by index, online.
- Schedule reorgs declaratively via `squeeze.tables` config table.
- Runs entirely server-side (no client-binary dependency).

**What it cannot do:**

- Tables without an identity index (same as pg_repack).
- Run without `wal_level = logical` (which has its own overhead — see [`33-wal.md`](./33-wal.md)).

### Choosing Between Them

| Property                          | pg_repack                       | pg_squeeze                      |
| --------------------------------- | ------------------------------- | ------------------------------- |
| Project owner                     | reorg (community fork of pg_reorg) | Cybertec PostgreSQL          |
| Client/server model               | Client binary + server extension | Pure server-side (background worker) |
| Concurrent-DML capture            | Triggers                        | Logical decoding                |
| `wal_level` requirement           | `replica` (default)             | `logical` (heavier WAL)         |
| Requires identity index           | PK or REPLICA IDENTITY index    | PK / unique / REPLICA IDENTITY  |
| Handles partitioned tables        | Per leaf only                   | Per leaf only                   |
| Handles GIN/GiST EXCLUDE          | No                              | No                              |
| Maturity                          | ~15 years, broadly deployed     | Active development, narrower deployment |

Pick **pg_repack** as the default — broader operational evidence, no `wal_level=logical` overhead. Pick **pg_squeeze** when your cluster already runs `wal_level = logical` for replication or CDC, and you want to consolidate the bloat-removal infrastructure server-side.

## Per-Version Timeline

Cumulative summary of index-maintenance-relevant changes.

| Version | Change                                                                                                     | Verbatim quote (from release notes / docs)                                              |
| ------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PG12    | `REINDEX CONCURRENTLY` introduced                                                                          | *"Add REINDEX CONCURRENTLY option to allow reindexing without locking out writes"*[^pg12-rc] |
| PG12    | Progress reporting for CREATE INDEX and REINDEX                                                            | *"Add progress reporting to CREATE INDEX and REINDEX operations"*[^pg12-progress]       |
| PG14    | `REINDEX` can change tablespace of the new index                                                           | *"Allow REINDEX to change the tablespace of the new index"*[^pg14-reindex-tablespace]   |
| PG14    | `REINDEX` walks child partitions                                                                           | *"Allow REINDEX to process all child tables or indexes of a partitioned relation"*[^pg14-reindex-partition] |
| PG14    | CIC builds no longer serialize on each other                                                               | *"Allow index commands using CONCURRENTLY to avoid waiting for the completion of other operations using CONCURRENTLY"*[^pg14-cic-wait] |
| PG14    | `amcheck` can validate heap pages                                                                          | *"Allow amcheck to also check heap pages"*[^pg14-amcheck-heap]                          |
| PG16    | `REINDEX DATABASE` no longer touches system catalogs by default                                            | *"Change REINDEX DATABASE and reindexdb to not process indexes on system catalogs"*[^pg16-reindex] |
| PG16    | `REINDEX DATABASE` / `REINDEX SYSTEM` no longer require explicit database-name argument                    | *"Change REINDEX DATABASE and REINDEX SYSTEM to no longer require an argument"*[^pg16-reindex-arg] |
| PG17    | `MAINTAIN` privilege + `pg_maintain` role                                                                  | *"Allow granting the right to perform maintenance operations ... per-table basis using the MAINTAIN privilege and on a per-role basis via the pg_maintain predefined role"*[^pg17-maintain] |
| PG17    | Event-trigger support for REINDEX                                                                          | *"Add event trigger support for REINDEX"*[^pg17-reindex-event]                          |
| PG17    | `reindexdb --index` parallelizes across tables                                                             | *"Allow reindexdb --index to process indexes from different tables in parallel"*[^pg17-reindexdb] |
| PG17    | `amcheck --checkunique` flag                                                                               | *"Allow amcheck to check for unique constraint violations using new option --checkunique"*[^pg17-amcheck-unique] |
| PG17    | Maintenance operations now use a safe `search_path`                                                        | *"Change functions to use a safe search_path during maintenance operations"*[^pg17-search-path] |
| PG18    | `amcheck` GIN check function                                                                               | *"Add amcheck check function gin_index_check() to verify GIN indexes"*[^pg18-amcheck-gin] |
| PG18    | Expression indexes can be very large (TOAST on pg_index)                                                   | *"Add TOAST table to pg_index to allow for very large expression indexes"*[^pg18-pg-index-toast] |

## Examples / Recipes

### Recipe 1 — Inventory all invalid indexes

Audit before any maintenance work. Anything returned is consuming write overhead for zero query benefit.

    SELECT
        n.nspname  AS schema,
        c.relname  AS index,
        t.relname  AS table,
        i.indisvalid,
        i.indisready,
        pg_size_pretty(pg_relation_size(c.oid)) AS size
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT i.indisvalid OR NOT i.indisready
    ORDER BY pg_relation_size(c.oid) DESC;

Action per row:

- Name ends in `_ccnew` or `_ccnewN` → drop it, retry REINDEX CONCURRENTLY after fixing the underlying cause.
- Name ends in `_ccold` or `_ccoldN` → drop it; the new index is already in service.
- Plain name → failed CIC; drop and retry per docs.

### Recipe 2 — Safe production CIC migration script

Run outside any transaction block:

    -- One statement at a time, NOT wrapped in BEGIN/COMMIT.
    CREATE INDEX CONCURRENTLY idx_events_user_id_created_at
        ON events (user_id, created_at DESC);

    -- Verify success before relying on it.
    SELECT indisvalid, indisready
    FROM pg_index
    WHERE indexrelid = 'idx_events_user_id_created_at'::regclass;
    -- Expect: indisvalid=t, indisready=t

For migration frameworks: use the framework's "no transaction" escape (Rails: `disable_ddl_transaction!`; Alembic: `op.execute(...)` with explicit `migration_options = {'transactional_ddl': False}`; Flyway: `executeInTransaction=false` in the migration file).

### Recipe 3 — Pre-flight + run + verify REINDEX CONCURRENTLY

    -- 1. Pre-flight: check current index size and bloat.
    SELECT pg_size_pretty(pg_relation_size('idx_events_user_id_created_at'::regclass));
    SELECT * FROM pgstatindex('idx_events_user_id_created_at');

    -- 2. Run the rebuild (cannot be in a transaction block).
    REINDEX INDEX CONCURRENTLY idx_events_user_id_created_at;

    -- 3. Verify success.
    SELECT pg_size_pretty(pg_relation_size('idx_events_user_id_created_at'::regclass));
    SELECT indisvalid, indisready
    FROM pg_index
    WHERE indexrelid = 'idx_events_user_id_created_at'::regclass;

    -- 4. Inventory any leftover _ccnew/_ccold from prior failures.
    SELECT c.relname
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname LIKE 'idx_events_user_id_created_at%cc%'
      AND NOT i.indisvalid;

### Recipe 4 — Find tables with index bloat candidates

Approximate-only — for confirmation, run `pgstatindex` on each suspect index.

    SELECT
        n.nspname  AS schema,
        c.relname  AS index,
        t.relname  AS table,
        pg_size_pretty(pg_relation_size(c.oid)) AS index_size,
        pg_size_pretty(pg_relation_size(t.oid)) AS table_size,
        round(pg_relation_size(c.oid)::numeric / NULLIF(pg_relation_size(t.oid), 0), 3) AS index_to_table_ratio
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
      AND pg_relation_size(c.oid) > 100 * 1024 * 1024   -- > 100 MB
    ORDER BY pg_relation_size(c.oid) DESC
    LIMIT 25;

Indexes larger than ~20% of their table size are bloat suspects. Confirm with `pgstatindex(...).avg_leaf_density` — below 50% is bloated.

### Recipe 5 — Drop an old / unused index online

Identify the unused index first (see recipe in [`22-indexes-overview.md`](./22-indexes-overview.md)). Then:

    -- Cannot be in a transaction block.
    DROP INDEX CONCURRENTLY idx_events_legacy_lookup;

If the index supports a constraint:

    -- For unique/PK indexes — must drop the constraint first.
    ALTER TABLE events DROP CONSTRAINT events_external_id_key;
    -- ALTER TABLE takes ACCESS EXCLUSIVE briefly; plan accordingly.

### Recipe 6 — Convert a unique constraint to CONCURRENTLY-built unique index

Standard `ALTER TABLE ... ADD UNIQUE` takes `ACCESS EXCLUSIVE`. The CONCURRENTLY path:

    -- Step 1: build a unique index concurrently.
    CREATE UNIQUE INDEX CONCURRENTLY uq_users_email_new
        ON users (lower(email));

    -- Verify valid before promoting.
    SELECT indisvalid FROM pg_index
    WHERE indexrelid = 'uq_users_email_new'::regclass;

    -- Step 2: promote the index to a constraint atomically (brief ACCESS EXCLUSIVE).
    ALTER TABLE users
        ADD CONSTRAINT uq_users_email
        UNIQUE USING INDEX uq_users_email_new;

The `USING INDEX` form takes the existing index without rebuilding — the lock window is just long enough to register the constraint in `pg_constraint`.

### Recipe 7 — Post-pg_upgrade B-tree REINDEX inventory

PG13+ B-tree deduplication requires REINDEX after pg_upgrade from PG12 or earlier to take effect[^pg13-dedup-cite]. Inventory candidates:

    SELECT
        n.nspname  AS schema,
        c.relname  AS index,
        pg_size_pretty(pg_relation_size(c.oid)) AS size
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am   ON am.oid = c.relam
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE am.amname = 'btree'
      AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
      AND pg_relation_size(c.oid) > 100 * 1024 * 1024
    ORDER BY pg_relation_size(c.oid) DESC;

Iterate `REINDEX INDEX CONCURRENTLY` over the list, largest first.

### Recipe 8 — Diagnose a stuck CREATE INDEX CONCURRENTLY

    -- 1. Who is running it and how far along?
    SELECT
        a.pid,
        p.phase,
        round(100.0 * p.blocks_done / NULLIF(p.blocks_total, 0), 1) AS pct_blocks,
        p.current_locker_pid,
        now() - a.xact_start AS xact_duration
    FROM pg_stat_progress_create_index p
    JOIN pg_stat_activity a USING (pid);

    -- 2. If phase is 'waiting for writers before build' or '... validation' —
    --    find the long-running transactions blocking it.
    SELECT
        pid,
        usename,
        now() - xact_start AS xact_duration,
        state,
        wait_event_type,
        wait_event,
        query
    FROM pg_stat_activity
    WHERE state IN ('active', 'idle in transaction')
      AND xact_start < (
          SELECT min(xact_start) FROM pg_stat_activity a
          JOIN pg_stat_progress_create_index p USING (pid)
      )
    ORDER BY xact_start;

    -- 3. If the locker has been idle in transaction for a long time, terminate it:
    -- SELECT pg_terminate_backend(<pid>);   -- destructive; verify first

### Recipe 9 — Schedule periodic REINDEX with pg_cron

For a churn-heavy table where bottom-up deletion (PG14+) is not keeping up:

    -- Run during low-traffic window. Each REINDEX is one statement,
    -- and pg_cron runs each job in its own session.
    SELECT cron.schedule(
        'monthly-reindex-events',
        '0 3 1 * *',  -- 3am UTC, 1st of each month
        $$ REINDEX TABLE CONCURRENTLY events; $$
    );

See [`98-pg-cron.md`](./98-pg-cron.md) for scheduling details and failover behavior.

### Recipe 10 — Detect heap bloat vs index bloat before reaching for tools

    -- Heap side:
    SELECT
        approx_tuple_percent  AS live,
        dead_tuple_percent    AS dead,
        approx_free_percent   AS free,
        scanned_percent
    FROM pgstattuple_approx('events');

    -- Index side:
    SELECT
        avg_leaf_density,
        leaf_fragmentation,
        deleted_pages,
        empty_pages
    FROM pgstatindex('idx_events_user_id_created_at');

Decision:

- High `dead_tuple_percent` on heap → autovacuum is behind, or long-running transaction is blocking it. Investigate [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) before reaching for `pg_repack`.
- Low `avg_leaf_density` on index → index bloat. `REINDEX INDEX CONCURRENTLY`.
- Both → heap bloat is dominating; fix that first, the index bloat may resolve itself.

### Recipe 11 — Recover from a failed unique-index CIC

Failed CIC on a unique index leaves an `INVALID` index that *still rejects writes* per the unique-constraint enforcement rule.

    -- 1. Symptoms: writes failing with unique_violation pointing at the half-built index.
    SELECT indexrelid::regclass AS index_name, indisvalid, indisready
    FROM pg_index
    WHERE indrelid = 'users'::regclass
      AND NOT indisvalid;

    -- 2. Drop the half-built index (this UNBLOCKS writes immediately).
    DROP INDEX CONCURRENTLY uq_users_email;

    -- 3. Find and resolve the duplicates that caused the failure.
    SELECT lower(email), count(*)
    FROM users
    GROUP BY lower(email)
    HAVING count(*) > 1;
    -- ... fix data ...

    -- 4. Retry.
    CREATE UNIQUE INDEX CONCURRENTLY uq_users_email ON users (lower(email));

### Recipe 12 — pg_repack walkthrough for heap bloat

    -- Prereq: install on each PG node.
    -- $ apt-get install postgresql-16-repack    (or distro equivalent)

    -- Run from a client host with superuser DB access:
    -- $ pg_repack -d mydb -t events --jobs=4

    -- Verify post-repack size:
    SELECT pg_size_pretty(pg_total_relation_size('events'));

`pg_repack` blocks on tables with EXCLUDE GiST constraints and on tables without a PK or REPLICA IDENTITY index. For partitioned tables, repack each leaf partition.

### Recipe 13 — Cluster-wide collation-corruption audit (libc upgrade)

After a libc upgrade (e.g., Debian point release that bumps glibc), text indexes may be silently corrupt. PG warns via `pg_database.datcollversion` mismatch. Audit and fix:

    -- 1. Detect mismatched collation versions.
    SELECT
        datname,
        datcollate,
        datcollversion,
        pg_database_collation_actual_version(oid) AS actual_version
    FROM pg_database
    WHERE datcollversion <> pg_database_collation_actual_version(oid)
       OR datcollversion IS NULL;

    -- 2. For each affected database: REINDEX every text index.
    -- Use amcheck to confirm corruption first:
    CREATE EXTENSION amcheck;
    SELECT bt_index_check(indexrelid)
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    -- ... filter to text-typed btree indexes ...
    ;

    -- 3. Rebuild concurrently.
    REINDEX INDEX CONCURRENTLY <each_index>;

    -- 4. Once cluster-clean, refresh the recorded collation version:
    ALTER DATABASE <name> REFRESH COLLATION VERSION;

See [`65-collations-encoding.md`](./65-collations-encoding.md) for the full workflow.

## Gotchas / Anti-patterns

1. **`CREATE INDEX CONCURRENTLY` cannot run in a transaction block.** Most migration frameworks wrap every statement in `BEGIN/COMMIT` by default. Use the framework's transactional-DDL-off escape (Rails `disable_ddl_transaction!`, Alembic `transactional_ddl: False`, Flyway `executeInTransaction=false`). Otherwise CIC fails with `25001 active_sql_transaction`.

2. **Failed CIC leaves an INVALID index that still consumes write overhead.** Always audit `indisvalid = false` with Recipe 1 after any CIC operation. Drop leftovers before retry per docs[^createindex].

3. **`_ccnew` and `_ccold` indexes from failed REINDEX CONCURRENTLY.** `_ccnew*` → drop, retry. `_ccold*` → drop, the rebuild already succeeded[^reindex]. The numeric suffixes (`_ccnew1`, `_ccold2`) accumulate across multiple failed attempts — drop them all.

4. **Failed unique-index CIC keeps enforcing uniqueness.** The most surprising trap. Until you `DROP INDEX`, every concurrent write that would violate the unique constraint *fails*, even though the index isn't visible to queries[^createindex]. Recipe 11 is the recovery path.

5. **CIC takes 2–3× longer than the plain form.** This is structural, not a tuning problem — two table scans plus wait phases. Plan maintenance windows accordingly; do not assume "concurrent = same speed."

6. **One CIC per table at a time.** *"only one concurrent index build can occur on a table at a time"*[^createindex]. Serialize multi-index migrations on the same table. Across different tables, PG14+ they no longer block each other[^pg14-cic-wait]; pre-PG14 they did.

7. **CIC blocks `VACUUM`, `ANALYZE`, and `ALTER TABLE` for its duration.** All four operations conflict on `SHARE UPDATE EXCLUSIVE`. A long-running CIC on a hot table delays autovacuum, which can compound into bloat. Monitor `n_dead_tup` during long CICs.

8. **REINDEX CONCURRENTLY silently skips exclusion-constraint indexes.** *"those indexes will be skipped"*[^reindex] when reindexing a table or database. The only way to rebuild them is `DROP CONSTRAINT` + `ADD CONSTRAINT` (which takes `ACCESS EXCLUSIVE`). Plan a window.

9. **REINDEX SYSTEM cannot use CONCURRENTLY.** Per docs[^reindex]. The only way to rebuild system catalog indexes is offline. For HA clusters: rebuild on a standby then promote.

10. **DROP INDEX CONCURRENTLY cannot drop a unique/PK-backing index.** *"the CASCADE option is not supported. (Thus, an index that supports a UNIQUE or PRIMARY KEY constraint cannot be dropped this way.)"*[^dropindex] Must drop the constraint first (which takes `ACCESS EXCLUSIVE` briefly).

11. **DROP INDEX CONCURRENTLY is single-index.** No batch drops, no CASCADE. Script the loop.

12. **DROP INDEX CONCURRENTLY does not work on partitioned-table parent indexes.** *"indexes on partitioned tables cannot be dropped using this option"*[^dropindex]. Drop the parent index with the plain form (which is fast because partitioned-index "parents" are catalog-only entries), or drop each leaf's index individually.

13. **REINDEX does not shrink the heap.** A REINDEX-CONCURRENTLY that "didn't help" is almost always heap bloat. Run `pgstattuple_approx` before reaching for REINDEX again; reach for `pg_repack` or `pg_squeeze` instead.

14. **`pgstattuple` does a full scan.** On 50 GB+ tables this can take an hour and load the buffer cache. Use `pgstattuple_approx` for routine monitoring; reserve `pgstattuple` for a deliberate diagnostic.

15. **`pgstatindex` requires the index to be B-tree.** Throws an error on other access methods. Use `pgstatginindex` for GIN, `pgstathashindex` for hash; there is no equivalent for GiST / SP-GiST / BRIN / Bloom — fall back to `pg_relation_size` ratios.

16. **`pgstattuple` requires `pg_stat_scan_tables` role or superuser.** Default-deny[^pgstattuple]. Grant `pg_stat_scan_tables` to your monitoring role, not superuser to the monitor.

17. **Long-running transactions block CIC and REINDEX CONCURRENTLY indefinitely.** The "wait for writers" and "wait for old snapshots" phases progress only when older transactions end. A pgBouncer session pool with idle-in-transaction sessions can stall index work for hours. Set `idle_in_transaction_session_timeout` and audit `pg_stat_activity` (see [`41-transactions.md`](./41-transactions.md)).

18. **`pg_repack` requires a PK or REPLICA IDENTITY USING INDEX.** Tables without one cannot be repacked. The same restriction applies to `pg_squeeze`.

19. **`pg_repack` runs as a client tool requiring superuser.** Not all hosting environments allow superuser. Check before scheduling.

20. **`pg_squeeze` requires `wal_level = logical`.** This bumps WAL volume across the cluster, not just for the squeezed table — measure the WAL throughput impact before turning it on for `pg_squeeze` alone.

21. **CIC parallelism (PG18 parallel GIN, PG17 parallel BRIN, PG11 parallel B-tree) does not apply to CONCURRENTLY.** Parallel index builds use `max_parallel_maintenance_workers` for the *plain* build path. `CREATE INDEX CONCURRENTLY` performs its scans serially. Plan for the slower wall-clock when you need CONCURRENTLY.

22. **`ALTER TABLE ... ADD CONSTRAINT ... USING INDEX` requires the index to be UNIQUE and to match the constraint columns exactly.** The `USING INDEX` shortcut is the only way to promote a CIC-built unique index to a constraint without rebuilding. See recipe 6.

23. **REINDEX'd index does *not* update planner statistics.** REINDEX rebuilds the storage; it does not run `ANALYZE`. If selectivity estimates are stale, follow REINDEX with `ANALYZE table` for the affected columns.

## See Also

- [`22-indexes-overview.md`](./22-indexes-overview.md) — picker file for which index type to build.
- [`23-btree-indexes.md`](./23-btree-indexes.md) — B-tree internals, dedup, bottom-up deletion, amcheck.
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN fastupdate pending-list flushing, GiST buffering build.
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — BRIN summarization functions, hash overflow page recycling.
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — why long-running transactions block CIC.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — heap bloat causes; visibility map and index-only scans.
- [`41-transactions.md`](./41-transactions.md) — `idle_in_transaction_session_timeout`.
- [`43-locking.md`](./43-locking.md) — `SHARE UPDATE EXCLUSIVE` conflict matrix.
- [`56-explain.md`](./56-explain.md) — `Heap Fetches: N` diagnostic for index-only scans.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_index`, `pg_class`, `pg_am` joins.
- [`65-collations-encoding.md`](./65-collations-encoding.md) — collation-version corruption and the REINDEX recipe.
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — post-pg_upgrade REINDEX requirements.
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — amcheck for index corruption detection.
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling periodic REINDEX.

## Sources

[^createindex]: PostgreSQL 16 `CREATE INDEX` reference, "Building Indexes Concurrently" section — *"Normally PostgreSQL locks the table to be indexed against writes and performs the entire index build with a single scan of the table. ... When this option is used, PostgreSQL will build the index without taking any locks that prevent concurrent inserts, updates, or deletes on the table ... In a concurrent index build, the index is actually entered as an 'invalid' index into the system catalogs in one transaction, then two table scans occur in two more transactions. ... If a problem arises while scanning the table, such as a deadlock or a uniqueness violation in a unique index, the CREATE INDEX command will fail but leave behind an 'invalid' index. ... The recommended recovery method in such cases is to drop the index and try again to perform CREATE INDEX CONCURRENTLY. (Another possibility is to rebuild the index with REINDEX INDEX CONCURRENTLY). ... Regular index builds permit other regular index builds on the same table to occur simultaneously, but only one concurrent index build can occur on a table at a time. ... a regular CREATE INDEX command can be performed within a transaction block, but CREATE INDEX CONCURRENTLY cannot. ... Another caveat when building a unique index concurrently is that the uniqueness constraint is already being enforced against other transactions when the second table scan begins."* <https://www.postgresql.org/docs/16/sql-createindex.html>

[^reindex]: PostgreSQL 16 `REINDEX` reference — *"When this option is used, PostgreSQL will rebuild the index without taking any locks that prevent concurrent inserts, updates, or deletes on the table; whereas a standard index rebuild locks out writes (but not reads) on the table until it's done."* and the six-step procedure including *"A new transient index definition is added to the catalog pg_index ... A SHARE UPDATE EXCLUSIVE lock at session level is taken ..."* and *"If the index marked INVALID is suffixed _ccnew, then it corresponds to the transient index created during the concurrent operation, and the recommended recovery method is to drop it using DROP INDEX, then attempt REINDEX CONCURRENTLY again. If the invalid index is instead suffixed _ccold, it corresponds to the original index which could not be dropped; the recommended recovery method is to just drop said index, since the rebuild proper has been successful. A nonzero number may be appended to the suffix ..."* and *"Furthermore, indexes for exclusion constraints cannot be reindexed concurrently."* and *"REINDEX SYSTEM does not support CONCURRENTLY since system catalogs cannot be reindexed concurrently."* and *"When using the TABLESPACE clause with REINDEX on a partitioned index or table, only the tablespace references of the leaf partitions are updated."* <https://www.postgresql.org/docs/16/sql-reindex.html>

[^dropindex]: PostgreSQL 16 `DROP INDEX` reference — *"Drop the index without locking out concurrent selects, inserts, updates, and deletes on the index's table. A normal DROP INDEX acquires an ACCESS EXCLUSIVE lock on the table, blocking other accesses until the index drop can be completed. With this option, the command instead waits until conflicting transactions have completed. There are several caveats to be aware of when using this option. Only one index name can be specified, and the CASCADE option is not supported. (Thus, an index that supports a UNIQUE or PRIMARY KEY constraint cannot be dropped this way.) Also, regular DROP INDEX commands can be performed within a transaction block, but DROP INDEX CONCURRENTLY cannot. Lastly, indexes on partitioned tables cannot be dropped using this option. For temporary tables, DROP INDEX is always non-concurrent, as no other session can access them, and non-concurrent index drop is cheaper."* <https://www.postgresql.org/docs/16/sql-dropindex.html>

[^pgstattuple]: PostgreSQL 16 pgstattuple — function signatures `pgstattuple(regclass)`, `pgstattuple_approx(regclass)`, `pgstatindex(regclass)` returning `avg_leaf_density`, `leaf_fragmentation`, `deleted_pages`, etc., `pgstatginindex(regclass)`, `pgstathashindex(regclass)`, `pg_relpages(regclass)`. Privileges: *"By default, only the role pg_stat_scan_tables has EXECUTE privilege. Superusers of course bypass this restriction."* <https://www.postgresql.org/docs/16/pgstattuple.html>

[^pg-repack]: pg_repack project README — *"pg_repack is a PostgreSQL extension which lets you remove bloat from tables and indexes, and optionally restore the physical order of clustered indexes. Unlike CLUSTER and VACUUM FULL it works online, without holding an exclusive lock on the processed tables during processing. pg_repack is efficient to boot, with performance comparable to using CLUSTER directly."* <https://github.com/reorg/pg_repack>

[^pg-squeeze]: pg_squeeze project README — *"PostgreSQL extension that removes unused space from a table and optionally sorts tuples according to particular index (as if CLUSTER command was executed concurrently with regular reads / writes). In fact we try to replace pg_repack extension."* and *"Implements the functionality purely on server side."* <https://github.com/cybertec-postgresql/pg_squeeze>

[^pg12-rc]: PostgreSQL 12 release notes — *"Add REINDEX CONCURRENTLY option to allow reindexing without locking out writes (Michaël Paquier, Andreas Karlsson, Peter Eisentraut)"* and *"REINDEX CONCURRENTLY can rebuild an index without blocking writes to its table"*. <https://www.postgresql.org/docs/release/12.0/>

[^pg12-progress]: PostgreSQL 12 release notes — *"Add progress reporting to CREATE INDEX and REINDEX operations (Álvaro Herrera, Peter Eisentraut)"*. <https://www.postgresql.org/docs/release/12.0/>

[^pg13-dedup-cite]: PostgreSQL 13 release notes — *"More efficiently store duplicates in B-tree indexes. This allows efficient B-tree indexing of low-cardinality columns by storing duplicate keys only once. Users upgrading with pg_upgrade will need to use REINDEX to make an existing index use this feature."* <https://www.postgresql.org/docs/release/13.0/>

[^pg14-reindex-tablespace]: PostgreSQL 14 release notes — *"Allow REINDEX to change the tablespace of the new index (Alexey Kondratov, Michael Paquier, Justin Pryzby)"*. <https://www.postgresql.org/docs/release/14.0/>

[^pg14-reindex-partition]: PostgreSQL 14 release notes — *"Allow REINDEX to process all child tables or indexes of a partitioned relation (Justin Pryzby, Michael Paquier)"*. <https://www.postgresql.org/docs/release/14.0/>

[^pg14-cic-wait]: PostgreSQL 14 release notes — *"Allow index commands using CONCURRENTLY to avoid waiting for the completion of other operations using CONCURRENTLY (Álvaro Herrera)"*. <https://www.postgresql.org/docs/release/14.0/>

[^pg14-amcheck-heap]: PostgreSQL 14 release notes — *"Allow amcheck to also check heap pages (Mark Dilger)"*. <https://www.postgresql.org/docs/release/14.0/>

[^pg16-reindex]: PostgreSQL 16 release notes — *"Change REINDEX DATABASE and reindexdb to not process indexes on system catalogs (Simon Riggs). Processing such indexes is still possible using REINDEX SYSTEM and reindexdb --system."* <https://www.postgresql.org/docs/release/16.0/>

[^pg16-reindex-arg]: PostgreSQL 16 release notes — *"Change REINDEX DATABASE and REINDEX SYSTEM to no longer require an argument (Simon Riggs). Previously the database name had to be specified."* <https://www.postgresql.org/docs/release/16.0/>

[^pg17-maintain]: PostgreSQL 17 release notes — *"Allow granting the right to perform maintenance operations (Nathan Bossart). The permission can be granted on a per-table basis using the MAINTAIN privilege and on a per-role basis via the pg_maintain predefined role. Permitted operations are VACUUM, ANALYZE, REINDEX, REFRESH MATERIALIZED VIEW, CLUSTER, and LOCK TABLE."* <https://www.postgresql.org/docs/release/17.0/>

[^pg17-reindex-event]: PostgreSQL 17 release notes — *"Add event trigger support for REINDEX (Garrett Thornburg, Jian He)"*. <https://www.postgresql.org/docs/release/17.0/>

[^pg17-reindexdb]: PostgreSQL 17 release notes — *"Allow reindexdb --index to process indexes from different tables in parallel (Maxim Orlov, Svetlana Derevyanko, Alexander Korotkov)"*. <https://www.postgresql.org/docs/release/17.0/>

[^pg17-amcheck-unique]: PostgreSQL 17 release notes — *"Allow amcheck to check for unique constraint violations using new option --checkunique (Anastasia Lubennikova, Pavel Borisov, Maxim Orlov)"*. <https://www.postgresql.org/docs/release/17.0/>

[^pg17-search-path]: PostgreSQL 17 release notes — *"Change functions to use a safe search_path during maintenance operations (Jeff Davis). This prevents maintenance operations (ANALYZE, CLUSTER, CREATE INDEX, CREATE MATERIALIZED VIEW, REFRESH MATERIALIZED VIEW, REINDEX, or VACUUM) from performing unsafe access."* <https://www.postgresql.org/docs/release/17.0/>

[^pg18-amcheck-gin]: PostgreSQL 18 release notes — *"Add amcheck check function gin_index_check() to verify GIN indexes (Grigory Kryachko, Heikki Linnakangas, Andrey Borodin)"*. <https://www.postgresql.org/docs/release/18.0/>

[^pg18-pg-index-toast]: PostgreSQL 18 release notes — *"Add TOAST table to pg_index to allow for very large expression indexes (Nathan Bossart)"*. <https://www.postgresql.org/docs/release/18.0/>

Primary doc landing pages:

- PostgreSQL 16 `CREATE INDEX`: <https://www.postgresql.org/docs/16/sql-createindex.html>
- PostgreSQL 16 `REINDEX`: <https://www.postgresql.org/docs/16/sql-reindex.html>
- PostgreSQL 16 `DROP INDEX`: <https://www.postgresql.org/docs/16/sql-dropindex.html>
- PostgreSQL 16 `pgstattuple`: <https://www.postgresql.org/docs/16/pgstattuple.html>
- PostgreSQL 16 Progress Reporting: <https://www.postgresql.org/docs/16/progress-reporting.html>
- PostgreSQL 16 Routine Reindexing: <https://www.postgresql.org/docs/16/routine-reindex.html>
- pg_repack: <https://github.com/reorg/pg_repack>
- pg_squeeze: <https://github.com/cybertec-postgresql/pg_squeeze>

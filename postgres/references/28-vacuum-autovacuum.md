# VACUUM and Autovacuum

Where [`27-mvcc-internals.md`](./27-mvcc-internals.md) describes the data structures (tuple header, snapshot, xmin horizon, visibility map), this file covers the maintenance surface: how dead tuples get reclaimed, how `relfrozenxid` advances, how the autovacuum daemon decides what to vacuum, what the per-table tuning knobs do, and how to read `pg_stat_progress_vacuum` while a vacuum is running.

The canonical chapter is [`routine-vacuuming.html`](https://www.postgresql.org/docs/16/routine-vacuuming.html), which states the purpose flatly: *"PostgreSQL databases require periodic maintenance known as vacuuming."*[^routine] The four reasons VACUUM exists, quoted verbatim:[^routine]

> 1. To recover or reuse disk space occupied by updated or deleted rows.
> 2. To update data statistics used by the PostgreSQL query planner.
> 3. To update the visibility map, which speeds up index-only scans.
> 4. To protect against loss of very old data due to transaction ID wraparound or multixact ID wraparound.

(1) is what most operators think of when they hear "VACUUM"; (2) is `ANALYZE`; (3) is the [visibility-map](./27-mvcc-internals.md#the-visibility-map) maintenance that index-only scans depend on; (4) is freezing, treated in depth in [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md). All four happen in one VACUUM pass and you do not get to opt into only a subset.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [VACUUM Variants](#vacuum-variants)
    - [Plain VACUUM (LAZY)](#plain-vacuum-lazy)
    - [VACUUM FULL](#vacuum-full)
    - [VACUUM FREEZE](#vacuum-freeze)
    - [VACUUM ANALYZE](#vacuum-analyze)
- [VACUUM Grammar and Options](#vacuum-grammar-and-options)
- [Autovacuum Architecture](#autovacuum-architecture)
- [Autovacuum Trigger Formulas](#autovacuum-trigger-formulas)
- [Per-Table Tuning](#per-table-tuning)
- [Cost-Based Vacuum Delay (IO Throttling)](#cost-based-vacuum-delay-io-throttling)
- [Memory: maintenance_work_mem and autovacuum_work_mem](#memory-maintenance_work_mem-and-autovacuum_work_mem)
- [Parallel Vacuum (PG13+)](#parallel-vacuum-pg13)
- [Progress Reporting: pg_stat_progress_vacuum](#progress-reporting-pg_stat_progress_vacuum)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- An `n_dead_tup` audit shows a table is bloated and you need to decide whether to wait for autovacuum, run `VACUUM` manually, run `VACUUM FULL`, or reach for `pg_repack` / `pg_squeeze`.
- You see `autovacuum: VACUUM ... (to prevent wraparound)` in `pg_stat_activity` and need to interpret the urgency.
- You need to tune autovacuum *per table* because one hot table needs aggressive vacuuming and the rest of the cluster does not.
- You are diagnosing why autovacuum is not running on a table (`last_autovacuum` stays NULL, or far in the past).
- You need to read `pg_stat_progress_vacuum` mid-run to predict completion time or identify a stuck phase.
- You are choosing between `INDEX_CLEANUP`, `TRUNCATE`, `PROCESS_TOAST`, `PROCESS_MAIN`, `PARALLEL`, `SKIP_LOCKED`, `DISABLE_PAGE_SKIPPING`, `SKIP_DATABASE_STATS`, `BUFFER_USAGE_LIMIT` options on a deliberate `VACUUM` call.
- You need to size `maintenance_work_mem` / `autovacuum_work_mem` and want the rules behind it.

For the *table-rewrite* operational surface (`VACUUM FULL`, `CLUSTER`, `pg_repack`, `pg_squeeze`) the deep dive is in [`26-index-maintenance.md`](./26-index-maintenance.md). For the data structures VACUUM operates on (`xmin`/`xmax`, snapshot, visibility map, dead/recently-dead/live distinction), see [`27-mvcc-internals.md`](./27-mvcc-internals.md). For wraparound mechanics specifically (freeze, `relfrozenxid`, anti-wraparound autovacuum, failsafe, emergency recovery), see [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md). For HOT updates (the in-page optimization that avoids most index maintenance entirely), see [`30-hot-updates.md`](./30-hot-updates.md).

## Mental Model

Five rules:

1. **Plain VACUUM does not shrink the table.** It marks dead tuples reusable and may truncate trailing empty pages, but it does not return space mid-relation to the OS. Quoted verbatim: *"Plain VACUUM (without FULL) simply reclaims space and makes it available for re-use ... extra space is not returned to the operating system (in most cases); it's just kept available for re-use within the same table."*[^vacuum] To reclaim heap bloat at the filesystem level you need `VACUUM FULL`, `CLUSTER`, or an online tool like `pg_repack` / `pg_squeeze` ([`26-index-maintenance.md`](./26-index-maintenance.md)).
2. **VACUUM FULL is a rewrite under ACCESS EXCLUSIVE.** Quoted verbatim: *"This form is much slower and requires an ACCESS EXCLUSIVE lock on each table while it is being processed."*[^vacuum] It is correct for *one-time* reclamation after a deletion of most of a table; it is *wrong* for routine maintenance.
3. **Autovacuum is on by default and is mandatory.** Quoted verbatim: *"PostgreSQL has an optional but highly recommended feature called autovacuum"*[^routine] — but in practice it is mandatory; the wraparound machinery depends on it. Disabling it cluster-wide is a footgun (gotcha #1). Per-table `autovacuum_enabled=false` is occasionally valid but still leaves the anti-wraparound path armed: *"If false, this table will not be autovacuumed, except to prevent transaction ID wraparound."*[^createtable]
4. **`autovacuum_vacuum_scale_factor` defaults to 0.2 — too lazy for a hot table.** Quoted verbatim: *"The default is 0.2 (20% of table size) ... the setting can be overridden for individual tables by changing table storage parameters."*[^autoconf] On a 100M-row table this means autovacuum waits for ~20M dead tuples before triggering. Lowering it to 0.01 or 0.005 *per table* on hot tables is the single highest-leverage tuning move.
5. **Long-running transactions defeat VACUUM no matter how aggressively you tune it.** The xmin horizon ([`27-mvcc-internals.md#the-xmin-horizon`](./27-mvcc-internals.md#the-xmin-horizon)) caps how recently a dead tuple can have been deleted and still be reclaimable. If a backend has been idle-in-transaction for an hour, no VACUUM that finishes today can reclaim anything that became dead in the last hour. Fix the horizon-holder; do not tune autovacuum harder.

## Decision Matrix

| You want to | Use | Avoid | Why |
|---|---|---|---|
| Reclaim dead tuples for reuse (routine) | autovacuum, or plain `VACUUM` | `VACUUM FULL` | Plain VACUUM does not lock writers; FULL takes ACCESS EXCLUSIVE.[^vacuum] |
| Reclaim heap to the OS after deleting most of a table | `VACUUM FULL`, `CLUSTER`, or `pg_repack` | plain VACUUM | Plain VACUUM only truncates trailing empty pages.[^vacuum] |
| Refresh planner statistics | `VACUUM (ANALYZE)` or `ANALYZE` | `VACUUM` alone | Plain VACUUM does not run ANALYZE. |
| Force aggressive freeze to advance `relfrozenxid` | `VACUUM (FREEZE)` | wait for natural anti-wraparound | FREEZE = `vacuum_freeze_min_age=0` + `vacuum_freeze_table_age=0`.[^vacuum] |
| Vacuum without blocking on lock waits | `VACUUM (SKIP_LOCKED)` | plain VACUUM during peak | Skips the relation if a conflicting lock is held.[^vacuum] |
| Vacuum only the TOAST side | `VACUUM (PROCESS_MAIN false)` (PG16+) | full VACUUM on the parent | Useful when the main relation is fine but TOAST grew.[^vacuum] |
| Skip TOAST | `VACUUM (PROCESS_TOAST false)` (PG14+) | full VACUUM | Useful when main relation needs urgent vacuum and TOAST is large.[^vacuum] |
| Throttle a manual VACUUM | set `vacuum_cost_delay` in the session | run on default | Default for manual VACUUM is `vacuum_cost_delay=0` (no throttle).[^resource] |
| Reduce shared-buffer churn from a one-off VACUUM | `VACUUM (BUFFER_USAGE_LIMIT '4MB')` (PG16+) | default | Caps the ring buffer used; default is 256 kB in PG16, 2 MB in PG17+.[^pg16-buf][^pg17-buf] |
| Tune autovacuum harder on one table | per-table storage parameter | cluster-wide GUC change | Cluster GUCs affect every table; storage parameters scope precisely.[^createtable] |
| Reclaim filesystem space *online* with minimal locking | `pg_repack` or `pg_squeeze` | `VACUUM FULL` | Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md). |
| Identify the *cause* of bloat | check xmin horizon, then n_dead_tup | tuning autovacuum harder | Fix the horizon holder first; otherwise no vacuum helps.[^routine] |

Three smell signals:

- **`last_autovacuum` advances but `n_dead_tup` stays high** → xmin horizon held back. Run the canonical horizon query from [`27-mvcc-internals.md`](./27-mvcc-internals.md#the-xmin-horizon).
- **`VACUUM FULL` is in your routine cron** → you are using a write-once table strategy that doesn't fit MVCC; switch to partitioning + `DROP PARTITION` or fix the underlying churn.
- **Autovacuum runs but a hot table is bloated** → `autovacuum_vacuum_scale_factor` default too high for that table; set a per-table storage parameter (recipe 1).

## VACUUM Variants

### Plain VACUUM (LAZY)

Plain VACUUM — invoked as `VACUUM tbl` with no `FULL` keyword — is the *only* variant safe for routine maintenance and is the variant autovacuum runs. Its operational contract, quoted verbatim:[^vacuum]

> Plain VACUUM (without FULL) simply reclaims space and makes it available for re-use ... This form of the command can operate in parallel with normal reading and writing of the table, as an exclusive lock is not obtained.

It takes `SHARE UPDATE EXCLUSIVE` on the table (does not block `SELECT`, `INSERT`, `UPDATE`, or `DELETE`; conflicts with `ALTER TABLE`, `DROP TABLE`, another VACUUM, autovacuum, ANALYZE). It does the following work in a single pass:

1. **Scan heap** — visit every page that the visibility map doesn't certify as all-frozen (and, in non-aggressive mode, optionally skip all-visible pages).
2. **Prune** dead tuples and defragment each page in place; collect dead TIDs to a `dead_tuples` array.
3. **Vacuum indexes** — visit each index and remove entries pointing at the collected dead TIDs.
4. **Vacuum heap** — release the line-pointer slots for the removed tuples back to the free-space-map.
5. **Cleanup indexes** — index-AM-specific cleanup (e.g., GIN pending-list flush, B-tree page deletion).
6. **Truncate heap** — if there are empty pages at the *end* of the relation, take a brief ACCESS EXCLUSIVE and truncate them; otherwise skip.
7. **Final cleanup** — update `pg_class.relfrozenxid`, `pg_class.relminmxid`, `pg_class.reltuples`, `pg_class.relpages`, FSM, visibility map.

Verbatim on truncation:[^vacuum]

> Specifies that VACUUM should attempt to truncate off any empty pages at the end of the table and allow the disk space for the truncated pages to be returned to the operating system ... Setting this option to false may be useful to avoid ACCESS EXCLUSIVE lock on the table that the truncation requires.

The brief ACCESS EXCLUSIVE for trailing truncation is the only time a plain VACUUM takes a strong lock; use `VACUUM (TRUNCATE FALSE)` or `ALTER TABLE ... SET (vacuum_truncate = false)` if even that is unacceptable.

### VACUUM FULL

VACUUM FULL is a *rewrite* of the table into a new physical file. Quoted verbatim:[^vacuum]

> VACUUM FULL rewrites the entire contents of the table into a new disk file with no extra space, allowing unused space to be returned to the operating system. This form is much slower and requires an ACCESS EXCLUSIVE lock on each table while it is being processed.

And:[^vacuum]

> The FULL option is not recommended for routine use, but might be useful in special cases.

Three operational realities:

- **Takes ACCESS EXCLUSIVE** — blocks `SELECT`, `INSERT`, `UPDATE`, `DELETE`, every DDL, every other VACUUM. The application is offline for that table for the duration.
- **Requires 2× the table size on disk** — verbatim: *"This method also requires extra disk space, since it writes a new copy of the table and doesn't release the old copy until the operation is complete."*[^vacuum]
- **Rebuilds every index on the table** as a side effect — much more work than a plain VACUUM, which only removes dead entries.

The right time to run `VACUUM FULL` is *after* a one-time `DELETE` of most of a table, when you are certain no further churn will follow and the application can tolerate the lock. Prefer `pg_repack` or `pg_squeeze` ([`26-index-maintenance.md`](./26-index-maintenance.md)) for online filesystem reclamation. Progress reports under `pg_stat_progress_cluster`, not `pg_stat_progress_vacuum`:[^progress]

> Progress for VACUUM FULL commands is reported via pg_stat_progress_cluster because both VACUUM FULL and CLUSTER rewrite the table, while regular VACUUM only modifies it in place.

### VACUUM FREEZE

`VACUUM (FREEZE)` forces aggressive freeze. Verbatim:[^vacuum]

> Specifying FREEZE is equivalent to performing VACUUM with the vacuum_freeze_min_age and vacuum_freeze_table_age parameters set to zero. Aggressive freezing is always performed when the table is rewritten, so this option is redundant when FULL is specified.

When to reach for it: pre-emptively freeze a large mostly-immutable table (e.g., a historical fact table that will rarely be updated again) so that the next time anti-wraparound kicks in, there is nothing left to freeze on that table. Deep dive in [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

### VACUUM ANALYZE

`VACUUM (ANALYZE)` runs ANALYZE as part of the same pass. Verbatim:[^vacuum]

> Updates statistics used by the planner to determine the most efficient way to execute a query.

ANALYZE samples rows from the heap and rewrites `pg_statistic` / `pg_stats`. Running ANALYZE inside VACUUM amortizes the heap scan cost. Autovacuum runs ANALYZE on its own schedule (`autovacuum_analyze_threshold` + `autovacuum_analyze_scale_factor`), separate from the VACUUM schedule.

> [!NOTE] PostgreSQL 18
> `VACUUM ONLY tbl` and `ANALYZE ONLY tbl` skip descent into child partitions: *"Allow VACUUM and ANALYZE to process partitioned tables without processing their children ... This is enabled with the new ONLY option. This is useful since autovacuum does not process partitioned tables, just its children."*[^pg18-only]

## VACUUM Grammar and Options

Two grammars, the parenthesized form preferred. Verbatim:[^vacuum]

> VACUUM [ ( option [, ...] ) ] [ table_and_columns [, ...] ]
>
> When the option list is surrounded by parentheses, the options can be written in any order. Without parentheses, options must be specified in exactly the order shown above. The parenthesized syntax was added in PostgreSQL 9.0; the unparenthesized syntax is deprecated.

Always write the parenthesized form. The full option catalog, with verbatim docs descriptions and version provenance:

| Option | Default | Available in | What it does |
|---|---|---|---|
| `FULL` | off | all | Rewrite the table; ACCESS EXCLUSIVE.[^vacuum] |
| `FREEZE` | off | all | Equivalent to `vacuum_freeze_min_age=0` + `vacuum_freeze_table_age=0`.[^vacuum] |
| `VERBOSE` | off | all | *"Prints a detailed vacuum activity report for each table."*[^vacuum] |
| `ANALYZE` | off | all | Run ANALYZE in the same pass.[^vacuum] |
| `DISABLE_PAGE_SKIPPING` | false | all | Disable visibility-map-based skipping. *"Intended to be used only when the contents of the visibility map are suspect, which should happen only if there is a hardware or software issue causing database corruption."*[^vacuum] |
| `SKIP_LOCKED` | false | all | *"if a relation cannot be locked immediately without waiting, the relation is skipped."*[^vacuum] |
| `INDEX_CLEANUP` | `AUTO` | PG14+ default change | `AUTO` / `ON` / `OFF`. Verbatim: *"The default is AUTO, which allows VACUUM to skip index vacuuming when appropriate."*[^vacuum] |
| `PROCESS_TOAST` | true | PG14+ | Set false to skip the TOAST side.[^vacuum] *"Add ability to skip vacuuming of TOAST tables."*[^pg14-toast] |
| `PROCESS_MAIN` | true | PG16+ | Set false to vacuum only the TOAST side. *"Allow VACUUM and vacuumdb to only process TOAST tables."*[^pg16-main] |
| `TRUNCATE` | true | all | *"Setting this option to false may be useful to avoid ACCESS EXCLUSIVE lock on the table that the truncation requires."*[^vacuum] |
| `PARALLEL n` | 0 (none) | PG13+ | Parallel index vacuum with `n` workers.[^pg13-parallel] |
| `SKIP_DATABASE_STATS` | false | PG16+ | Skip updating database-wide oldest-XID stats; useful when issuing many VACUUMs in parallel.[^pg16-skipdb] |
| `ONLY_DATABASE_STATS` | false | PG16+ | Only update database-wide oldest-XID stats.[^pg16-onlydb] |
| `BUFFER_USAGE_LIMIT 'size'` | from `vacuum_buffer_usage_limit` | PG16+ | Ring buffer size for the VACUUM. Range 128 kB to 16 GB; 0 disables.[^vacuum] |
| `ONLY` (table modifier) | off | PG18+ | Don't recurse into partitions.[^pg18-only] |

The `INDEX_CLEANUP=AUTO` default landed in PG14:[^pg14-indexcleanup]

> Allow vacuum to skip index vacuuming when the number of removable index entries is insignificant ... The vacuum parameter INDEX_CLEANUP has a new default of auto that enables this optimization.

Permissions:[^vacuum]

> To vacuum a table, one must ordinarily be the table's owner or a superuser. However, database owners are allowed to vacuum all tables in their databases, except shared catalogs. (The restriction for shared catalogs means that a true database-wide VACUUM can only be performed by a superuser.) VACUUM will skip over any tables that the calling user does not have permission to vacuum.

Hard transaction restriction:[^vacuum]

> VACUUM cannot be executed inside a transaction block.

This means a migration framework that wraps every step in a transaction (Rails, Alembic, Flyway) needs an escape hatch (analogous to `CREATE INDEX CONCURRENTLY`, see [`26-index-maintenance.md`](./26-index-maintenance.md)).

GIN-pending-list flush is a side effect of any VACUUM:[^vacuum]

> For tables with GIN indexes, VACUUM (in any form) also completes any pending index insertions, by moving pending index entries to the appropriate places in the main GIN index structure.

This is what `gin_clean_pending_list()` does in a more targeted way ([`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)).

## Autovacuum Architecture

Verbatim from `routine-vacuuming.html`:[^routine]

> The "autovacuum daemon" actually consists of multiple processes. There is a persistent daemon process, called the autovacuum launcher, which is in charge of starting autovacuum worker processes for all databases. The launcher will distribute the work across time, attempting to start one worker within each database every autovacuum_naptime seconds. (Therefore, if the installation has N databases, a new worker will be launched every autovacuum_naptime/N seconds.) A maximum of autovacuum_max_workers worker processes are allowed to run at the same time.

The launcher is one process (visible in `pg_stat_activity.backend_type = 'autovacuum launcher'`); the workers are short-lived backends (`backend_type = 'autovacuum worker'`, query column shows `autovacuum: VACUUM schema.table` or `autovacuum: VACUUM schema.table (to prevent wraparound)`).

The cluster-wide GUCs (verbatim defaults):[^autoconf]

| GUC | Default | Reload? | Notes |
|---|---|---|---|
| `autovacuum` | `on` | postmaster | "This is on by default." Only set in postgresql.conf or server command line. |
| `autovacuum_max_workers` | `3` | restart | "This parameter can only be set at server start." |
| `autovacuum_naptime` | `1min` | reload | Time between launcher sweeps per database. |
| `autovacuum_vacuum_threshold` | `50` | reload | Per-table override available. |
| `autovacuum_vacuum_scale_factor` | `0.2` | reload | 20% of table size. Per-table override available. |
| `autovacuum_analyze_threshold` | `50` | reload | Per-table override available. |
| `autovacuum_analyze_scale_factor` | `0.1` | reload | 10% of table size. |
| `autovacuum_vacuum_insert_threshold` | `1000` | reload | PG13+. Set `-1` to disable insert-only triggering on a table. |
| `autovacuum_vacuum_insert_scale_factor` | `0.2` | reload | PG13+. 20% of table size. |
| `autovacuum_freeze_max_age` | `200000000` | restart | "relatively low 200 million transactions." |
| `autovacuum_multixact_freeze_max_age` | `400000000` | restart | "relatively low 400 million multixacts." |
| `autovacuum_vacuum_cost_delay` | `2ms` | reload | -1 to use `vacuum_cost_delay`. |
| `autovacuum_vacuum_cost_limit` | `-1` | reload | Means: use `vacuum_cost_limit` (200). |

`autovacuum` requires `track_counts`. Verbatim:[^routine]

> When enabled, autovacuum checks for tables that have had a large number of inserted, updated or deleted tuples. These checks use the statistics collection facility; therefore, autovacuum cannot be used unless track_counts is set to true.

Autovacuum is *cancellable* by a conflicting-lock acquirer — except when it's preventing wraparound. Verbatim:[^routine]

> Autovacuum workers generally don't block other commands. If a process attempts to acquire a lock that conflicts with the SHARE UPDATE EXCLUSIVE lock held by autovacuum, lock acquisition will interrupt the autovacuum.
>
> However, if the autovacuum is running to prevent transaction ID wraparound (i.e., the autovacuum query name in the pg_stat_activity view ends with (to prevent wraparound)), the autovacuum is not automatically interrupted.

The `(to prevent wraparound)` suffix is the operational signal that auto-cancel does not apply and any `ALTER TABLE` / `DROP TABLE` / `pg_repack` that tries to take a stronger lock will *block*. The fix is to let the wraparound vacuum finish (gotcha #6).

> [!NOTE] PostgreSQL 15
> *"Enable default logging of checkpoints and slow autovacuum operations ... This changes the default of log_checkpoints to on and that of log_autovacuum_min_duration to 10 minutes."*[^pg15-log] On PG15+ clusters you get autovacuum log lines for runs over 10 minutes without any GUC change.

> [!NOTE] PostgreSQL 16
> *"Allow autovacuum to more frequently honor changes to delay settings ... Rather than honor changes only at the start of each relation, honor them at the start of each block."*[^pg16-delay] On PG16+ a `vacuum_cost_delay` change via `ALTER SYSTEM` + `SELECT pg_reload_conf()` propagates into a running autovacuum within a page rather than waiting for the next table.

## Autovacuum Trigger Formulas

The launcher picks tables to vacuum and analyze by evaluating two (since PG13, three) threshold formulas per table per cycle. All three are stated verbatim in [`routine-vacuuming.html`](https://www.postgresql.org/docs/16/routine-vacuuming.html).

**VACUUM trigger (update/delete pressure):**[^routine]

> vacuum threshold = vacuum base threshold + vacuum scale factor * number of tuples
>
> where the vacuum base threshold is autovacuum_vacuum_threshold, the vacuum scale factor is autovacuum_vacuum_scale_factor, and the number of tuples is pg_class.reltuples.

A table is vacuumed when `n_dead_tup ≥ vacuum_threshold`. Worked example, default GUCs:

| Table size (`reltuples`) | `vacuum_threshold` | Dead tuples to trigger |
|---|---|---|
| 100 | `50 + 0.2 × 100` = 70 | 70 |
| 10,000 | `50 + 0.2 × 10,000` = 2,050 | 2,050 |
| 1,000,000 | `50 + 0.2 × 1,000,000` = 200,050 | ~200,000 |
| 100,000,000 | `50 + 0.2 × 100,000,000` = 20,000,050 | ~20 million |

That 20-million-dead-tuple threshold on a 100M-row table is the textbook *"why is my big table bloated?"* answer. Lower the scale factor *per table* (recipe 1).

**VACUUM trigger (insert pressure, PG13+):**[^routine]

> vacuum insert threshold = vacuum base insert threshold + vacuum insert scale factor * number of tuples
>
> where the vacuum insert base threshold is autovacuum_vacuum_insert_threshold, and vacuum insert scale factor is autovacuum_vacuum_insert_scale_factor.

PG13 rationale, verbatim:[^pg13-insert]

> Previously, insert-only activity would trigger auto-analyze but not auto-vacuum, on the grounds that there could not be any dead tuples to remove. However, a vacuum scan has other useful side-effects such as setting page-all-visible bits, which improves the efficiency of index-only scans. Also, allowing an insert-only table to receive periodic vacuuming helps to spread out the work of "freezing" old tuples, so that there is not suddenly a large amount of freezing work to do when the entire table reaches the anti-wraparound threshold all at once.

This trigger uses `n_ins_since_vacuum` from `pg_stat_user_tables`. To disable insert-triggering on one table, set `autovacuum_vacuum_insert_threshold = -1` as the per-table storage parameter.[^createtable]

**ANALYZE trigger:**[^routine]

> analyze threshold = analyze base threshold + analyze scale factor * number of tuples
>
> is compared to the total number of tuples inserted, updated, or deleted since the last ANALYZE.

Default scale factor 0.1 means ANALYZE runs at 10% modifications; lower for tables where the planner picks bad plans because of stale stats.

**Anti-wraparound trigger:**[^routine]

> Tables whose relfrozenxid value is more than autovacuum_freeze_max_age transactions old are always vacuumed.

This bypasses the normal scale-factor formula entirely and is the one autovacuum that cannot be auto-cancelled.

## Per-Table Tuning

Per-table autovacuum GUCs are set via `CREATE TABLE ... WITH (...)` or `ALTER TABLE tbl SET (key = value)`. Quoted verbatim from `sql-createtable.html`:[^createtable]

> Enables or disables the autovacuum daemon for a particular table. If true, the autovacuum daemon will perform automatic VACUUM and/or ANALYZE operations on this table following the rules discussed in Section 25.1.6. If false, this table will not be autovacuumed, except to prevent transaction ID wraparound.

Full per-table parameter catalog:

| Storage parameter | Maps to GUC | Notes |
|---|---|---|
| `autovacuum_enabled` | (none) | `true`/`false`. Even `false` allows anti-wraparound. |
| `autovacuum_vacuum_threshold` | `autovacuum_vacuum_threshold` | Per-table override. |
| `autovacuum_vacuum_scale_factor` | `autovacuum_vacuum_scale_factor` | **Most-tuned knob in production.** |
| `autovacuum_vacuum_insert_threshold` | `autovacuum_vacuum_insert_threshold` | -1 disables insert vacuums.[^createtable] |
| `autovacuum_vacuum_insert_scale_factor` | `autovacuum_vacuum_insert_scale_factor` | PG13+. |
| `autovacuum_analyze_threshold` | `autovacuum_analyze_threshold` | |
| `autovacuum_analyze_scale_factor` | `autovacuum_analyze_scale_factor` | Lower this on tables with hot-skewed distributions. |
| `autovacuum_vacuum_cost_delay` | `autovacuum_vacuum_cost_delay` | Override per-table for big tables. |
| `autovacuum_vacuum_cost_limit` | `autovacuum_vacuum_cost_limit` | Raise to make vacuum on big tables faster. |
| `autovacuum_freeze_min_age` | `vacuum_freeze_min_age` | "autovacuum will ignore per-table autovacuum_freeze_min_age parameters that are larger than half the system-wide autovacuum_freeze_max_age setting."[^createtable] |
| `autovacuum_freeze_max_age` | `autovacuum_freeze_max_age` | "autovacuum will ignore per-table autovacuum_freeze_max_age parameters that are larger than the system-wide setting (it can only be set smaller)."[^createtable] |
| `autovacuum_freeze_table_age` | `vacuum_freeze_table_age` | |
| `autovacuum_multixact_freeze_min_age` | `vacuum_multixact_freeze_min_age` | Same half-of-max rule applies. |
| `autovacuum_multixact_freeze_max_age` | `autovacuum_multixact_freeze_max_age` | Same can-only-set-smaller rule applies. |
| `autovacuum_multixact_freeze_table_age` | `vacuum_multixact_freeze_table_age` | |
| `log_autovacuum_min_duration` | `log_autovacuum_min_duration` | Per-table override of the cluster default. |
| `vacuum_truncate` / `toast.vacuum_truncate` | (none) | `false` disables trailing-page truncation (avoids ACCESS EXCLUSIVE). |
| `vacuum_index_cleanup` / `toast.vacuum_index_cleanup` | (none) | `AUTO`/`ON`/`OFF`. Verbatim: *"With OFF, index cleanup is disabled, with ON it is enabled, and with AUTO a decision is made dynamically, each time VACUUM runs."*[^createtable] |
| `toast.autovacuum_*` | corresponding GUC | Override settings on the TOAST side independently. |

The headline per-table tuning move is `autovacuum_vacuum_scale_factor = 0.01` on hot churn tables (10× more aggressive than default). Combine with a `autovacuum_vacuum_threshold` floor of a few thousand to prevent over-triggering on tiny tables.

## Cost-Based Vacuum Delay (IO Throttling)

VACUUM accumulates "cost" as it reads and writes buffers; when the accumulated cost reaches `vacuum_cost_limit`, the worker sleeps for `vacuum_cost_delay` milliseconds. Verbatim:[^resource]

> During the execution of VACUUM and ANALYZE commands, the system maintains an internal counter that keeps track of the estimated cost of the various I/O operations that are performed. When the accumulated cost reaches a limit (specified by vacuum_cost_limit), the process performing the operation will sleep for a short period of time, as specified by vacuum_cost_delay. Then it will reset the counter and continue execution.

The four cost components, with verbatim defaults:[^resource]

| Cost component | Default | What it measures |
|---|---|---|
| `vacuum_cost_page_hit` | 1 | "The estimated cost for vacuuming a buffer found in the shared buffer cache." |
| `vacuum_cost_page_miss` | 2 | "The estimated cost for vacuuming a buffer that has to be read from disk." (PG14 lowered from 10) |
| `vacuum_cost_page_dirty` | 20 | "The estimated cost charged when vacuum modifies a block that was previously clean." |

The throttle GUCs:[^resource]

| GUC | Default | Applies to |
|---|---|---|
| `vacuum_cost_delay` | `0` (disabled) | Manual VACUUM. |
| `vacuum_cost_limit` | `200` | Manual + autovacuum (if its limit is `-1`). |
| `autovacuum_vacuum_cost_delay` | `2ms` | Autovacuum. |
| `autovacuum_vacuum_cost_limit` | `-1` (use `vacuum_cost_limit`) | Autovacuum. |

Manual VACUUM has the delay *disabled by default*. Verbatim:[^resource]

> This feature is disabled by default for manually issued VACUUM commands. To enable it, set the vacuum_cost_delay variable to a nonzero value. ... When using cost-based vacuuming, appropriate values for vacuum_cost_delay are usually quite small, perhaps less than 1 millisecond.

This is the right call: when you run `VACUUM` manually, you usually *want* it to finish quickly. Autovacuum, by contrast, has a 2 ms delay default and runs in the background.

For parallel vacuum (PG13+), the delay is computed per worker:[^vacuum]

> For parallel vacuum, each worker sleeps in proportion to the work done by that worker.

> [!NOTE] PostgreSQL 14
> *"Reduce the default value of vacuum_cost_page_miss to better reflect current hardware capabilities."*[^pg14-costmiss] Default `vacuum_cost_page_miss` dropped from 10 to 2. If you're tuning a PG14+ cluster using PG13-era cookbook values, you're throttling vacuum 5× more than intended.

## Memory: maintenance_work_mem and autovacuum_work_mem

VACUUM stores dead-tuple TIDs in memory between scan and index-vacuum phases. `maintenance_work_mem` is the cap, verbatim:[^resource]

> Specifies the maximum amount of memory to be used by maintenance operations, such as VACUUM, CREATE INDEX, and ALTER TABLE ADD FOREIGN KEY. If this value is specified without units, it is taken as kilobytes. It defaults to 64 megabytes (64MB). Since only one of these operations can be executed at a time by a database session, and an installation normally doesn't have many of them running concurrently, it's safe to set this value significantly larger than work_mem. Larger settings might improve performance for vacuuming and for restoring database dumps.

The 64 MB default is conservatively low for any modern server. A typical production setting is 512 MB to 2 GB.

`autovacuum_work_mem` overrides per-worker. Verbatim:[^resource]

> Specifies the maximum amount of memory to be used by each autovacuum worker process. ... It defaults to -1, indicating that the value of maintenance_work_mem should be used instead.

Two consequences:

1. **Total RAM used by autovacuum** can reach `autovacuum_max_workers × maintenance_work_mem`. With defaults that's `3 × 64 MB = 192 MB` — fine. Raise `maintenance_work_mem` to 2 GB and that becomes 6 GB potentially in use. Verbatim warning:[^resource] *"Note that when autovacuum runs, up to autovacuum_max_workers times this memory may be allocated, so be careful not to set the default value too high."*
2. **Pre-PG17 1 GB cap** — verbatim from the PG16 docs:[^resource] *"Note that for the collection of dead tuple identifiers, VACUUM is only able to utilize up to a maximum of 1GB of memory."* This silently capped VACUUM at ~178 million TIDs per index-pass regardless of `maintenance_work_mem`.

> [!NOTE] PostgreSQL 17
> The 1 GB cap is lifted. Verbatim:[^pg17-mem] *"New memory management system for VACUUM, which reduces memory consumption and can improve overall vacuuming performance. ... Additionally, vacuum is no longer silently limited to one gigabyte of memory when maintenance_work_mem or autovacuum_work_mem are higher."* On PG17+ you can size `maintenance_work_mem = 4GB` and a single VACUUM pass will use all of it, reducing the number of index-vacuum cycles on a very large table from many to one.

## Parallel Vacuum (PG13+)

PG13 introduced `PARALLEL n` for VACUUM. Verbatim:[^pg13-parallel]

> Allow VACUUM to process a table's indexes in parallel (Masahiko Sawada, Amit Kapila) ... The new PARALLEL option controls this.

And from the VACUUM syntax page:[^vacuum]

> Perform index vacuum and index cleanup phases of VACUUM in parallel using integer background workers. The number of workers used to perform the operation is equal to the number of indexes on the relation that support parallel vacuum which is limited by the number of workers specified with PARALLEL option if any which is further limited by max_parallel_maintenance_workers. An index can participate in parallel vacuum if and only if the size of the index is more than min_parallel_index_scan_size.

Four operational consequences:

- **Parallelism only helps the *index* phase**, not the heap scan. A table with one giant index but a small heap will not benefit much. A table with many indexes will.
- **`PARALLEL` cannot be combined with `FULL`** — verbatim: *"This option can't be used with the FULL option."*[^vacuum]
- **Autovacuum does not parallelize**, only manual `VACUUM (PARALLEL n)`. If you have a known-bloated table and want to vacuum it faster, you must invoke VACUUM manually.
- **`PARALLEL 0` disables it** — verbatim: *"To disable this feature, one can use PARALLEL option and specify parallel workers as zero."*[^vacuum]

The relevant GUC is `max_parallel_maintenance_workers`, default 2, which caps the worker count whatever you ask for.

## Progress Reporting: pg_stat_progress_vacuum

`pg_stat_progress_vacuum` reports one row per actively-running VACUUM (manual + autovacuum). Quoted verbatim:[^progress]

> Whenever VACUUM is running, the pg_stat_progress_vacuum view will contain one row for each backend (including autovacuum worker processes) that is currently vacuuming.

Columns (PG16 names; see PG17 renames below):[^progress]

| Column | Type | What it tells you |
|---|---|---|
| `pid` | int | Process ID. Join `pg_stat_activity.pid` for the query and lock state. |
| `datid` / `datname` | oid / name | Database being vacuumed. |
| `relid` | oid | Table being vacuumed. |
| `phase` | text | Current phase (see below). |
| `heap_blks_total` | bigint | Total heap blocks at start of scan. "blocks added later will not be (and need not be) visited by this VACUUM." |
| `heap_blks_scanned` | bigint | Blocks scanned. Skipped (visibility-map-certified) blocks counted here too. |
| `heap_blks_vacuumed` | bigint | Blocks vacuumed in the vacuuming-heap phase. |
| `index_vacuum_count` | bigint | Completed index vacuum cycles. > 1 means `maintenance_work_mem` was undersized. |
| `max_dead_tuples` | bigint | Pre-PG17 name. PG17+ is `max_dead_tuple_bytes`. |
| `num_dead_tuples` | bigint | Pre-PG17 name. PG17+ is `num_dead_item_ids` plus new `dead_tuple_bytes`. |

The seven phases, verbatim:[^progress]

| Phase | Meaning |
|---|---|
| `initializing` | "VACUUM is preparing to begin scanning the heap. This phase is expected to be very brief." |
| `scanning heap` | "VACUUM is currently scanning the heap. It will prune and defragment each page if required, and possibly perform freezing activity. The heap_blks_scanned column can be used to monitor the progress of the scan." |
| `vacuuming indexes` | "VACUUM is currently vacuuming the indexes. If a table has any indexes, this will happen at least once per vacuum, after the heap has been completely scanned. It may happen multiple times per vacuum if maintenance_work_mem (or, in the case of autovacuum, autovacuum_work_mem if set) is insufficient to store the number of dead tuples found." |
| `vacuuming heap` | "VACUUM is currently vacuuming the heap. Vacuuming the heap is distinct from scanning the heap, and occurs after each instance of vacuuming indexes. If heap_blks_scanned is less than heap_blks_total, the system will return to scanning the heap after this phase is completed; otherwise, it will begin cleaning up indexes after this phase is completed." |
| `cleaning up indexes` | "VACUUM is currently cleaning up indexes. This occurs after the heap has been completely scanned and all vacuuming of the indexes and the heap has been completed." |
| `truncating heap` | "VACUUM is currently truncating the heap so as to return empty pages at the end of the relation to the operating system. This occurs after cleaning up indexes." |
| `performing final cleanup` | "VACUUM is performing final cleanup. During this phase, VACUUM will vacuum the free space map, update statistics in pg_class, and report statistics to the cumulative statistics system. When this phase is completed, VACUUM will end." |

> [!NOTE] PostgreSQL 17
> Three column changes:[^pg17-progress] *"Rename pg_stat_progress_vacuum column max_dead_tuples to max_dead_tuple_bytes, rename num_dead_tuples to num_dead_item_ids, and add dead_tuple_bytes."* Plus a new pair for index processing:[^pg17-progress-index] *"Allow vacuum to report the progress of index processing ... This appears in system view pg_stat_progress_vacuum columns indexes_total and indexes_processed."* Diagnostic queries that joined `max_dead_tuples` need to be rewritten for PG17.

If `index_vacuum_count > 1` in `pg_stat_progress_vacuum`, the table was too big for one pass and VACUUM had to round-trip through indexes multiple times. The fix on PG≤16 is to raise `maintenance_work_mem`, accepting the 1 GB cap. On PG17+ the cap is gone and raising `maintenance_work_mem` removes the multi-pass entirely (recipe 6).

## Per-Version Timeline

| Version | Change | Source |
|---|---|---|
| **13** | Parallel index vacuum via `PARALLEL n` option. *"Allow VACUUM to process a table's indexes in parallel."*[^pg13-parallel] | [^pg13-parallel] |
| **13** | Insert-triggered autovacuum via `autovacuum_vacuum_insert_threshold` / `autovacuum_vacuum_insert_scale_factor`. *"Allow inserts, not only updates and deletes, to trigger vacuuming activity in autovacuum."*[^pg13-insert] | [^pg13-insert] |
| **13** | New wait event `VacuumDelay` for cost-based delays.[^pg13-waitevent] | [^pg13-waitevent] |
| **14** | `INDEX_CLEANUP` default `AUTO`. *"Allow vacuum to skip index vacuuming when the number of removable index entries is insignificant."*[^pg14-indexcleanup] | [^pg14-indexcleanup] |
| **14** | `PROCESS_TOAST` option. *"Add ability to skip vacuuming of TOAST tables."*[^pg14-toast] | [^pg14-toast] |
| **14** | `vacuum_failsafe_age` / `vacuum_multixact_failsafe_age` GUCs. *"Cause vacuum operations to be more aggressive if the table is near xid or multixact wraparound."*[^pg14-failsafe] | [^pg14-failsafe] |
| **14** | Earlier wraparound warnings + hard-limit shutdown. *"Increase warning time and hard limit before transaction id and multi-transaction wraparound."*[^pg14-warnings] | [^pg14-warnings] |
| **14** | Per-index autovacuum logging. *"Add per-index information to autovacuum logging output."*[^pg14-perindex] | [^pg14-perindex] |
| **14** | `vacuum_cost_page_miss` default dropped from 10 to 2.[^pg14-costmiss] | [^pg14-costmiss] |
| **14** | Vacuum reclaims unused trailing line pointers.[^pg14-linepointer] | [^pg14-linepointer] |
| **14** | Vacuum more eagerly adds deleted B-tree pages to the FSM.[^pg14-btreefsm] | [^pg14-btreefsm] |
| **14** | `COPY FREEZE` properly updates page visibility bits.[^pg14-copyfreeze] | [^pg14-copyfreeze] |
| **15** | More aggressive freeze of oldest XIDs/MXIDs.[^pg15-aggressive] | [^pg15-aggressive] |
| **15** | `log_autovacuum_min_duration` default changed to `10min` (from `-1`).[^pg15-log] | [^pg15-log] |
| **16** | Opportunistic page freezing during non-freeze VACUUM. *"During non-freeze operations, perform page freezing where appropriate ... This makes full-table freeze vacuums less necessary."*[^pg16-oppfreeze] | [^pg16-oppfreeze] |
| **16** | `BUFFER_USAGE_LIMIT` option + `vacuum_buffer_usage_limit` GUC. *"Allow control of the shared buffer usage by vacuum and analyze."*[^pg16-buf] | [^pg16-buf] |
| **16** | `SKIP_DATABASE_STATS` / `ONLY_DATABASE_STATS` options. *"Add VACUUM options to skip or update all frozen statistics."*[^pg16-skipdb] | [^pg16-skipdb] |
| **16** | `PROCESS_MAIN` option (skip main relation, vacuum TOAST only). *"Allow VACUUM and vacuumdb to only process TOAST tables."*[^pg16-main] | [^pg16-main] |
| **16** | Autovacuum honors delay changes per-block, not per-table.[^pg16-delay] | [^pg16-delay] |
| **17** | New TID-store memory management; 1 GB cap removed. *"vacuum is no longer silently limited to one gigabyte of memory."*[^pg17-mem] | [^pg17-mem] |
| **17** | `pg_stat_progress_vacuum` column renames + new `dead_tuple_bytes`.[^pg17-progress] | [^pg17-progress] |
| **17** | Index processing progress in `pg_stat_progress_vacuum`. New `indexes_total` / `indexes_processed` columns.[^pg17-progress-index] | [^pg17-progress-index] |
| **17** | More efficient freeze; compacter WAL.[^pg17-freeze] | [^pg17-freeze] |
| **17** | `old_snapshot_threshold` removed. *"Remove server variable old_snapshot_threshold."*[^pg17-oldsnap] | [^pg17-oldsnap] |
| **17** | `vacuum_buffer_usage_limit` default raised to 2 MB.[^pg17-buf] | [^pg17-buf] |
| **18** | Eager freezing during normal vacuum + `vacuum_max_eager_freeze_failure_rate` GUC. *"Allow normal vacuums to freeze some pages, even though they are all-visible."*[^pg18-eager] | [^pg18-eager] |
| **18** | `pg_class.relallfrozen` column.[^pg18-relallfrozen] | [^pg18-relallfrozen] |
| **18** | `VACUUM ONLY` / `ANALYZE ONLY` skips partition children.[^pg18-only] | [^pg18-only] |
| **18** | Data checksums enabled by default in `initdb`. *"Change initdb default to enable data checksums."*[^pg18-checksums] | [^pg18-checksums] |
| **18** | Async I/O subsystem speeds up vacuum scans.[^pg18-aio] | [^pg18-aio] |

## Examples / Recipes

### Recipe 1 — Tune autovacuum aggressiveness on a hot table

The single highest-leverage operational move. Default `autovacuum_vacuum_scale_factor = 0.2` means autovacuum waits for 20% of the table to be dead. On a 100M-row table that is 20M dead tuples — far too lazy.

    -- 1% scale factor with a 10k-row floor on a hot churn table
    ALTER TABLE orders SET (
      autovacuum_vacuum_scale_factor = 0.01,
      autovacuum_vacuum_threshold = 10000,
      autovacuum_analyze_scale_factor = 0.005,
      autovacuum_analyze_threshold = 5000
    );

    -- Verify
    SELECT relname, reloptions
    FROM pg_class
    WHERE relname = 'orders';

The threshold floor prevents over-triggering on tiny tables. For an insert-mostly table that you want to freeze opportunistically rather than wait for anti-wraparound:

    ALTER TABLE events SET (
      autovacuum_vacuum_insert_scale_factor = 0.01,
      autovacuum_vacuum_insert_threshold = 100000
    );

### Recipe 2 — Find tables that need attention

The canonical bloat-candidate audit, ordered by dead-tuple ratio. Cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 5 (n_dead_tup audit) for the longer form.

    SELECT
      schemaname || '.' || relname AS table,
      n_live_tup,
      n_dead_tup,
      ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
      last_autovacuum,
      last_autoanalyze,
      autovacuum_count,
      n_ins_since_vacuum
    FROM pg_stat_user_tables
    WHERE n_live_tup + n_dead_tup > 10000
    ORDER BY dead_pct DESC NULLS LAST
    LIMIT 20;

If `dead_pct` is high *and* `last_autovacuum` is recent — autovacuum ran but couldn't reclaim. Check the xmin horizon ([`27-mvcc-internals.md`](./27-mvcc-internals.md#the-xmin-horizon)). If `dead_pct` is high and `last_autovacuum` is far in the past — autovacuum is not triggering; lower the per-table scale factor (recipe 1).

### Recipe 3 — Watch a running VACUUM in real time

    SELECT
      v.pid,
      a.query,
      v.phase,
      v.heap_blks_scanned,
      v.heap_blks_total,
      ROUND(100.0 * v.heap_blks_scanned / NULLIF(v.heap_blks_total, 0), 1) AS pct,
      v.index_vacuum_count,
      a.wait_event_type, a.wait_event
    FROM pg_stat_progress_vacuum v
    JOIN pg_stat_activity a USING (pid)
    ORDER BY v.heap_blks_total DESC;

If `index_vacuum_count > 1`, the table is too big for one pass — raise `maintenance_work_mem` (recipe 6). If `phase = 'vacuuming indexes'` and stuck, check `pg_stat_activity.wait_event` for `BufferPin` (a query holding a pin on a page that VACUUM wants to clean) or `Lock` (a conflicting lock).

> [!NOTE] PostgreSQL 17
> Replace `max_dead_tuples`/`num_dead_tuples` with `max_dead_tuple_bytes`/`num_dead_item_ids`/`dead_tuple_bytes` in any diagnostic that quoted them.[^pg17-progress] Add `v.indexes_total`, `v.indexes_processed` to the SELECT to see index-processing progress.

### Recipe 4 — Disable trailing truncation on a write-hot table

Trailing-page truncation requires a brief ACCESS EXCLUSIVE. For a table whose application is sensitive to even a sub-second blocking, disable it:

    ALTER TABLE realtime_signals SET (vacuum_truncate = false);
    -- Same for TOAST side
    ALTER TABLE realtime_signals SET (toast.vacuum_truncate = false);

The downside: trailing empty pages stay until the next non-LAZY operation that rewrites the relation (`VACUUM FULL`, `CLUSTER`, `pg_repack`). For most write-heavy OLTP tables this is the right trade.

### Recipe 5 — One-off manual VACUUM with parallel workers

    -- Big table with several indexes — parallelize the index phase.
    VACUUM (PARALLEL 4, VERBOSE, ANALYZE) large_table;

`PARALLEL n` caps at `max_parallel_maintenance_workers` and at the count of indexes on the table that exceed `min_parallel_index_scan_size`. VERBOSE prints per-index and per-phase stats. ANALYZE folds in the statistics refresh.

### Recipe 6 — Detect and fix the index_vacuum_count > 1 problem

If `pg_stat_progress_vacuum.index_vacuum_count > 1` during a vacuum, the dead-tuple TID store didn't fit in `maintenance_work_mem` and VACUUM had to round-trip through every index multiple times.

    -- Pre-PG17: capped at 1 GB anyway.
    -- PG17+: cap is removed.
    SET maintenance_work_mem = '4GB';
    VACUUM (PARALLEL 4, VERBOSE) huge_archive_table;

> [!NOTE] PostgreSQL 17
> The 1 GB silent cap is gone:[^pg17-mem] *"vacuum is no longer silently limited to one gigabyte of memory when maintenance_work_mem or autovacuum_work_mem are higher."* On PG17+ this recipe collapses a multi-pass vacuum of a 500 GB table from hours to a single index round-trip.

### Recipe 7 — Bloat triage walkthrough

A `n_dead_tup`-heavy table with autovacuum running:

1. **Confirm autovacuum is running on this table** — check `pg_stat_user_tables.last_autovacuum` and `autovacuum_count`.
2. **Check the xmin horizon** — if any backend has `backend_xmin < (max XID - days*86400*xacts/sec)`, autovacuum cannot reclaim tuples that became dead after that backend's xmin. Run the diagnostic query from [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 2.
3. **If horizon is fine, check that autovacuum is finishing** — `pg_stat_progress_vacuum` will tell you. If a vacuum is repeatedly being cancelled by lock conflicts, set `lock_timeout` lower on the offending statement, not on the vacuum.
4. **If autovacuum runs and finishes but bloat stays** — the scale factor is wrong for this table size. Apply recipe 1.
5. **If heap is bloated but indexes are not** — `n_dead_tup` is wrong as a proxy; check `pgstattuple_approx(tbl)` for the heap and `pgstatindex(idx)` for each index ([`26-index-maintenance.md`](./26-index-maintenance.md) recipe 10). Decide between routine VACUUM (already running) and online table reorg via `pg_repack` / `pg_squeeze`.
6. **If pgstattuple says the heap is 80% dead** — switch to a one-time online reorg with `pg_repack`, not `VACUUM FULL`.

### Recipe 8 — Schedule a maintenance window VACUUM ANALYZE with pg_cron

    -- Weekly Sunday 02:00 UTC, on tables that need it.
    SELECT cron.schedule(
      'weekly-vacuum-analyze-bigtable',
      '0 2 * * 0',
      $$ VACUUM (ANALYZE, PARALLEL 4, BUFFER_USAGE_LIMIT '32MB') public.big_fact_table $$
    );

The `BUFFER_USAGE_LIMIT '32MB'` keeps the maintenance from sweeping shared_buffers clean during the run (PG16+). Cross-reference [`98-pg-cron.md`](./98-pg-cron.md). For the `VACUUM cannot run in transaction block` rule — pg_cron jobs execute outside a transaction, so this works.

### Recipe 9 — Inventory tables with autovacuum disabled

    SELECT
      n.nspname || '.' || c.relname AS relation,
      c.reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND (c.reloptions::text ILIKE '%autovacuum_enabled=false%'
        OR c.reloptions::text ILIKE '%autovacuum_enabled=off%')
    ORDER BY 1;

Any row here is a table the operator deliberately exempted from autovacuum. Anti-wraparound still runs on it. Each row deserves a code-review comment explaining *why*.

### Recipe 10 — Audit autovacuum cancellations

When autovacuum is repeatedly cancelled by lock conflicts, it never finishes. Watch the logs:

    -- postgresql.conf (or ALTER SYSTEM)
    log_autovacuum_min_duration = 0      -- log every autovacuum (verbose; revert after diagnosis)

Then grep `postgresql.log` for `canceling autovacuum task` lines. Each cancellation is paired with the conflicting lock acquirer's PID. On PG15+ the default `log_autovacuum_min_duration = 10min` so long autovacuums are logged automatically.[^pg15-log]

### Recipe 11 — Process only the TOAST side of a table

A table whose main relation is fine but whose TOAST side is bloated (e.g., a table with one `jsonb` column where most rows are toasted):

    -- PG16+
    VACUUM (PROCESS_MAIN false, VERBOSE) tbl;

Or the inverse, when TOAST processing is slow and you want to vacuum only the main relation:

    -- PG14+
    VACUUM (PROCESS_TOAST false, VERBOSE) tbl;

### Recipe 12 — Use `vacuumdb` for cluster-wide maintenance

`vacuumdb` is the wrapper used in scheduled jobs:

    # Vacuum analyze every database, 4 parallel jobs, 8 parallel index workers per table.
    vacuumdb --all --analyze --jobs=4 --parallel=8 --verbose

    # PG16+ buffer usage limit
    vacuumdb --all --analyze --buffer-usage-limit=64MB

    # Post-pg_upgrade: refresh planner stats in stages of increasing fidelity.
    vacuumdb --all --analyze-in-stages

`--analyze-in-stages` runs three passes with progressively higher `default_statistics_target` (1, 10, full). On PG17+ pg_upgrade preserves statistics, but `--analyze-in-stages` is still the right post-upgrade catch-all.

### Recipe 13 — Pre-emptive freeze of a write-once partition

For a daily-rotation partition that will never be updated again, pre-emptively freeze it after the rotation is complete:

    VACUUM (FREEZE, ANALYZE, PARALLEL 4) events_2025_05_10;

This advances `relfrozenxid` on the partition to "now," so anti-wraparound never has to scan it. Combined with [`35-partitioning.md`](./35-partitioning.md) retention, you get bounded freeze cost.

## Gotchas / Anti-patterns

1. **Disabling autovacuum cluster-wide is operationally fatal.** Without autovacuum, freezing never happens, `relfrozenxid` does not advance, and the cluster will shut down at wraparound. Whatever problem motivated disabling autovacuum (high CPU, IO contention) is better solved by tuning cost limits, raising `maintenance_work_mem`, or rebalancing workers — never by disabling the daemon.

2. **`autovacuum_enabled = false` on a table still allows anti-wraparound.** Verbatim:[^createtable] *"If false, this table will not be autovacuumed, except to prevent transaction ID wraparound."* You cannot fully exempt a table from VACUUM. The setting is correct for "I will run VACUUM on this table manually on my own schedule" but you must actually do that.

3. **`VACUUM FULL` is not a routine maintenance command.** It rewrites the table under ACCESS EXCLUSIVE and rebuilds all indexes. For routine reclamation use plain VACUUM (which is what autovacuum runs). For online filesystem reclamation use `pg_repack` or `pg_squeeze`.

4. **`VACUUM FULL` followed by `VACUUM` is redundant.** FULL already rewrites the table and freezes aggressively as a side effect. Verbatim:[^vacuum] *"Aggressive freezing is always performed when the table is rewritten, so this option is redundant when FULL is specified."*

5. **The 0.2 default scale factor is too lazy for big tables.** Out-of-the-box, a 100M-row table waits for 20M dead tuples before autovacuum triggers. Lower the per-table `autovacuum_vacuum_scale_factor` aggressively — 0.01 or even 0.005 — on hot tables. Cluster-wide changes are coarse; per-table is precise.

6. **`autovacuum: ... (to prevent wraparound)` cannot be auto-cancelled.** A query that takes a conflicting lock will *block* on it until the vacuum finishes, even if your application has a `lock_timeout`. The fix is to let it complete, then investigate why anti-wraparound triggered in the first place (was `autovacuum_freeze_max_age` reached because routine autovacuum was being cancelled? see gotcha #10).

7. **Manual `VACUUM` defaults to `vacuum_cost_delay = 0`** — no throttle.[^resource] If you run `VACUUM big_table` in business hours expecting it to be polite to other queries, you will be surprised. Either set `SET vacuum_cost_delay = '2ms';` before issuing the VACUUM, or rely on autovacuum which already has the throttle.

8. **`maintenance_work_mem` × `autovacuum_max_workers` is a real RAM commitment.** Verbatim:[^resource] *"when autovacuum runs, up to autovacuum_max_workers times this memory may be allocated, so be careful not to set the default value too high."* Setting `maintenance_work_mem = 8GB` and `autovacuum_max_workers = 6` means autovacuum can use 48 GB. Size accordingly.

9. **Pre-PG17, VACUUM is silently capped at 1 GB regardless of `maintenance_work_mem`.** Verbatim from the PG16 docs:[^resource] *"Note that for the collection of dead tuple identifiers, VACUUM is only able to utilize up to a maximum of 1GB of memory."* The cap is removed in PG17.[^pg17-mem] If you tuned `maintenance_work_mem = 8GB` on PG16 and saw no speedup, this is why.

10. **A long-running transaction or abandoned replication slot defeats VACUUM completely.** No autovacuum tuning helps. The fix is upstream — `idle_in_transaction_session_timeout`, dropping abandoned slots — not in this file. See [`27-mvcc-internals.md`](./27-mvcc-internals.md) gotchas #2, #4, and the long-running-offender recipes.

11. **`VACUUM` cannot run inside a transaction block.** Verbatim:[^vacuum] *"VACUUM cannot be executed inside a transaction block."* Migration frameworks that wrap every step in a transaction (Rails, Alembic, Flyway) need the same escape hatch as `CREATE INDEX CONCURRENTLY` ([`26-index-maintenance.md`](./26-index-maintenance.md)).

12. **Autovacuum requires `track_counts`.** Verbatim:[^routine] *"autovacuum cannot be used unless track_counts is set to true."* `track_counts` is on by default; if you turned it off (e.g., for `pg_stat_kcache` experimentation), you turned off autovacuum.

13. **Trailing-page truncation takes brief ACCESS EXCLUSIVE.** Plain VACUUM's only blocking operation. For ultra-latency-sensitive tables, set `ALTER TABLE tbl SET (vacuum_truncate = false)` and accept that empty trailing pages stay until the next FULL.

14. **`pg_stat_progress_vacuum` shows only LAZY VACUUM, not VACUUM FULL.** Verbatim:[^progress] *"Backends running VACUUM FULL will instead report their progress in the pg_stat_progress_cluster view."* Diagnostic queries that look for a stuck VACUUM by querying `pg_stat_progress_vacuum` will miss any FULL.

15. **`VACUUM` does *not* lower `relfrozenxid` on a partitioned-table parent — only on the partitions.** A parent is just a catalog entry; the actual heap is in the child partitions. Anti-wraparound triggers per partition. On PG18+ use `VACUUM ONLY parent` to run a vacuum on just the parent's catalog row.[^pg18-only]

16. **`INDEX_CLEANUP=OFF` skips index entries but the TID-store still grows.** Don't use OFF as a workaround for "VACUUM is too slow" except in genuine pre-wraparound emergencies. Verbatim:[^vacuum] *"This may be useful when it is necessary to make VACUUM run as quickly as possible to avoid imminent transaction ID wraparound."* And the immediate next sentence: *"However, the wraparound failsafe mechanism controlled by vacuum_failsafe_age will generally trigger automatically to avoid transaction ID wraparound failure, and should be preferred."*

17. **Replication-slot xmin holds the horizon back cluster-wide.** A slot for a subscriber that's been down for a day pins every database's horizon at where the subscriber left off. Bloat will accumulate on *every* table in *every* database. Fix the slot ([`75-replication-slots.md`](./75-replication-slots.md)), not the autovacuum.

18. **Autovacuum cancellation by lock conflict is silent in default logs.** Set `log_autovacuum_min_duration = 0` temporarily to see every autovacuum (and every cancellation) in the log. On PG15+ the default `10min` catches long runs but not quick cancellations.[^pg15-log]

19. **`PARALLEL n` is for the index phase only — it does not parallelize the heap scan.** A table with one giant index gets no parallel speedup. A table with many indexes gets a near-linear speedup.

20. **`autovacuum_max_workers` is restart-only.** Verbatim:[^autoconf] *"This parameter can only be set at server start."* You cannot raise it during an incident.

21. **GIN-pending-list flush happens during every VACUUM** — a busy GIN-indexed table will have most of its VACUUM time go to GIN cleanup. Tune `gin_pending_list_limit` per index ([`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)) if VACUUM is slow on GIN-heavy tables.

22. **`vacuum_cost_page_miss` was lowered from 10 to 2 in PG14.**[^pg14-costmiss] If you carried PG13-era cookbook values forward, your throttle is 5× stricter than the modern default.

## See Also

- [`26-index-maintenance.md`](./26-index-maintenance.md) — CREATE/REINDEX CONCURRENTLY, pg_repack vs pg_squeeze for online table reorganization, pgstattuple for bloat audit.
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — Tuple header, snapshot, visibility map, dead vs live tuples, xmin horizon (the data structures VACUUM operates on).
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — Freeze process, `relfrozenxid` / `relminmxid` advancement, anti-wraparound autovacuum, failsafe, emergency recovery.
- [`30-hot-updates.md`](./30-hot-updates.md) — Heap-only-tuple updates and the `n_tup_hot_upd` counter.
- [`31-toast.md`](./31-toast.md) — The TOAST sidecar that `PROCESS_TOAST` controls.
- [`33-wal.md`](./33-wal.md) — WAL records generated by VACUUM (freeze, visibility-map updates).
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — How vacuum-dirtied pages reach disk.
- [`35-partitioning.md`](./35-partitioning.md) — `VACUUM ONLY` parent vs children on PG18+; per-partition freeze.
- [`43-locking.md`](./43-locking.md) — `SHARE UPDATE EXCLUSIVE` (plain VACUUM) vs `ACCESS EXCLUSIVE` (VACUUM FULL) lock conflict matrix.
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_user_tables`, `pg_stat_progress_vacuum`, `pg_stat_io` (PG16+).
- [`75-replication-slots.md`](./75-replication-slots.md) — How a slot's xmin pins the cluster-wide horizon.
- [`98-pg-cron.md`](./98-pg-cron.md) — Scheduling periodic VACUUM ANALYZE jobs.

## Sources

[^routine]: PostgreSQL 16 docs, *Routine Vacuuming* (Chapter 25.1). Verbatim quotes used: *"PostgreSQL databases require periodic maintenance known as vacuuming."*; the four-reasons list; *"PostgreSQL has an optional but highly recommended feature called autovacuum"*; *"autovacuum cannot be used unless track_counts is set to true."*; the launcher/worker architecture quote; the three trigger formulas (vacuum, vacuum-insert, analyze); *"Tables whose relfrozenxid value is more than autovacuum_freeze_max_age transactions old are always vacuumed."*; the `(to prevent wraparound)` non-cancellation quote; the autovacuum lock-conflict-cancellation quote; the visibility-map two-purposes quote. https://www.postgresql.org/docs/16/routine-vacuuming.html

[^vacuum]: PostgreSQL 16 docs, *VACUUM* command reference. Verbatim quotes used: the two grammar forms; *"VACUUM reclaims storage occupied by dead tuples."*; *"Plain VACUUM (without FULL) simply reclaims space and makes it available for re-use."*; *"This form of the command can operate in parallel with normal reading and writing of the table, as an exclusive lock is not obtained."*; *"extra space is not returned to the operating system (in most cases); it's just kept available for re-use within the same table."*; *"VACUUM FULL rewrites the entire contents of the table into a new disk file with no extra space ..."*; *"requires an ACCESS EXCLUSIVE lock on each table while it is being processed."*; *"This method also requires extra disk space, since it writes a new copy of the table and doesn't release the old copy until the operation is complete."*; *"The FULL option is not recommended for routine use, but might be useful in special cases."*; FREEZE = *"equivalent to performing VACUUM with the vacuum_freeze_min_age and vacuum_freeze_table_age parameters set to zero."*; the INDEX_CLEANUP AUTO default quote; the SKIP_LOCKED, DISABLE_PAGE_SKIPPING, TRUNCATE, PARALLEL, PROCESS_TOAST, PROCESS_MAIN, SKIP_DATABASE_STATS, ONLY_DATABASE_STATS, BUFFER_USAGE_LIMIT option descriptions; the GIN pending-list flush quote; *"VACUUM cannot be executed inside a transaction block."*; permissions paragraph. https://www.postgresql.org/docs/16/sql-vacuum.html

[^autoconf]: PostgreSQL 16 docs, *Automatic Vacuuming* GUC reference. Verbatim quotes used: defaults and ranges for `autovacuum`, `autovacuum_max_workers`, `autovacuum_naptime`, `autovacuum_vacuum_threshold`, `autovacuum_vacuum_scale_factor`, `autovacuum_analyze_threshold`, `autovacuum_analyze_scale_factor`, `autovacuum_vacuum_insert_threshold`, `autovacuum_vacuum_insert_scale_factor`, `autovacuum_freeze_max_age` (*"the default is a relatively low 200 million transactions"*), `autovacuum_multixact_freeze_max_age` (*"the default is a relatively low 400 million multixacts"*), `autovacuum_vacuum_cost_delay`, `autovacuum_vacuum_cost_limit`. https://www.postgresql.org/docs/16/runtime-config-autovacuum.html

[^resource]: PostgreSQL 16 docs, *Resource Consumption* GUC reference. Verbatim quotes used: the `maintenance_work_mem` description (*"defaults to 64 megabytes (64MB)"*, *"safe to set this value significantly larger than work_mem"*, the `autovacuum_max_workers × maintenance_work_mem` warning, the *"VACUUM is only able to utilize up to a maximum of 1GB of memory"* pre-PG17 cap); `autovacuum_work_mem` (*"defaults to -1, indicating that the value of maintenance_work_mem should be used instead"*); the cost-based-delay framing paragraph; `vacuum_cost_delay` (*"The default value is zero, which disables the cost-based vacuum delay feature."*); `vacuum_cost_limit` (default 200); `vacuum_cost_page_hit` (default 1); `vacuum_cost_page_miss` (default 2); `vacuum_cost_page_dirty` (default 20); `vacuum_buffer_usage_limit` (range 128 kB to 16 GB; default 256 kB on PG16). https://www.postgresql.org/docs/16/runtime-config-resource.html

[^createtable]: PostgreSQL 16 docs, *CREATE TABLE* storage parameters. Verbatim quotes used: `autovacuum_enabled` (*"If false, this table will not be autovacuumed, except to prevent transaction ID wraparound."*); the `autovacuum_freeze_min_age` half-of-max rule; the `autovacuum_freeze_max_age` can-only-set-smaller rule; the `vacuum_truncate` and `vacuum_index_cleanup` per-table parameter descriptions. https://www.postgresql.org/docs/16/sql-createtable.html

[^progress]: PostgreSQL 16 docs, *Progress Reporting*. Verbatim quotes used: *"Whenever VACUUM is running, the pg_stat_progress_vacuum view will contain one row for each backend (including autovacuum worker processes) that is currently vacuuming."*; *"Progress for VACUUM FULL commands is reported via pg_stat_progress_cluster ..."*; all seven phase descriptions verbatim; all column descriptions. https://www.postgresql.org/docs/16/progress-reporting.html

[^pg13-parallel]: PostgreSQL 13 release notes. *"Allow VACUUM to process a table's indexes in parallel (Masahiko Sawada, Amit Kapila). The new PARALLEL option controls this."* https://www.postgresql.org/docs/release/13.0/

[^pg13-insert]: PostgreSQL 13 release notes. *"Allow inserts, not only updates and deletes, to trigger vacuuming activity in autovacuum (Laurenz Albe, Darafei Praliaskouski). Previously, insert-only activity would trigger auto-analyze but not auto-vacuum, on the grounds that there could not be any dead tuples to remove. However, a vacuum scan has other useful side-effects such as setting page-all-visible bits, which improves the efficiency of index-only scans. Also, allowing an insert-only table to receive periodic vacuuming helps to spread out the work of 'freezing' old tuples, so that there is not suddenly a large amount of freezing work to do when the entire table reaches the anti-wraparound threshold all at once. If necessary, this behavior can be adjusted with the new parameters autovacuum_vacuum_insert_threshold and autovacuum_vacuum_insert_scale_factor, or the equivalent table storage options."* https://www.postgresql.org/docs/release/13.0/

[^pg13-waitevent]: PostgreSQL 13 release notes. *"Add wait event VacuumDelay to report on cost-based vacuum delay (Justin Pryzby)."* https://www.postgresql.org/docs/release/13.0/

[^pg14-indexcleanup]: PostgreSQL 14 release notes. *"Allow vacuum to skip index vacuuming when the number of removable index entries is insignificant (Masahiko Sawada, Peter Geoghegan). The vacuum parameter INDEX_CLEANUP has a new default of auto that enables this optimization."* https://www.postgresql.org/docs/release/14.0/

[^pg14-toast]: PostgreSQL 14 release notes. *"Add ability to skip vacuuming of TOAST tables (Nathan Bossart). VACUUM now has a PROCESS_TOAST option which can be set to false to disable TOAST processing, and vacuumdb has a --no-process-toast option."* https://www.postgresql.org/docs/release/14.0/

[^pg14-failsafe]: PostgreSQL 14 release notes. *"Cause vacuum operations to be more aggressive if the table is near xid or multixact wraparound (Masahiko Sawada, Peter Geoghegan). This is controlled by vacuum_failsafe_age and vacuum_multixact_failsafe_age."* https://www.postgresql.org/docs/release/14.0/

[^pg14-warnings]: PostgreSQL 14 release notes. *"Increase warning time and hard limit before transaction id and multi-transaction wraparound (Noah Misch). This should reduce the possibility of failures that occur without having issued warnings about wraparound."* https://www.postgresql.org/docs/release/14.0/

[^pg14-perindex]: PostgreSQL 14 release notes. *"Add per-index information to autovacuum logging output (Masahiko Sawada)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-costmiss]: PostgreSQL 14 release notes. *"Reduce the default value of vacuum_cost_page_miss to better reflect current hardware capabilities (Peter Geoghegan)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-linepointer]: PostgreSQL 14 release notes. *"Allow vacuum to reclaim space used by unused trailing heap line pointers (Matthias van de Meent, Peter Geoghegan)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-btreefsm]: PostgreSQL 14 release notes. *"Allow vacuum to more eagerly add deleted btree pages to the free space map (Peter Geoghegan)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-copyfreeze]: PostgreSQL 14 release notes. *"Have COPY FREEZE appropriately update page visibility bits (Anastasia Lubennikova, Pavan Deolasee, Jeff Janes)."* https://www.postgresql.org/docs/release/14.0/

[^pg15-aggressive]: PostgreSQL 15 release notes. *"Allow vacuum to be more aggressive in setting the oldest frozen and multi transaction id (Peter Geoghegan)."* https://www.postgresql.org/docs/release/15.0/

[^pg15-log]: PostgreSQL 15 release notes. *"Enable default logging of checkpoints and slow autovacuum operations (Bharath Rupireddy). This changes the default of log_checkpoints to on and that of log_autovacuum_min_duration to 10 minutes."* https://www.postgresql.org/docs/release/15.0/

[^pg16-oppfreeze]: PostgreSQL 16 release notes. *"During non-freeze operations, perform page freezing where appropriate (Peter Geoghegan). This makes full-table freeze vacuums less necessary."* https://www.postgresql.org/docs/release/16.0/

[^pg16-buf]: PostgreSQL 16 release notes. *"Allow control of the shared buffer usage by vacuum and analyze (Melanie Plageman). The VACUUM/ANALYZE option is BUFFER_USAGE_LIMIT, and the vacuumdb option is --buffer-usage-limit. The default value is set by server variable vacuum_buffer_usage_limit, which also controls autovacuum."* https://www.postgresql.org/docs/release/16.0/

[^pg16-skipdb]: PostgreSQL 16 release notes. *"Add VACUUM options to skip or update all frozen statistics (Tom Lane, Nathan Bossart). The options are SKIP_DATABASE_STATS and ONLY_DATABASE_STATS."* https://www.postgresql.org/docs/release/16.0/

[^pg16-onlydb]: Same source as `pg16-skipdb`. PostgreSQL 16 release notes — `ONLY_DATABASE_STATS` option introduction.

[^pg16-main]: PostgreSQL 16 release notes. *"Allow VACUUM and vacuumdb to only process TOAST tables (Nathan Bossart). This is accomplished by having VACUUM turn off PROCESS_MAIN or by vacuumdb using the --no-process-main option."* https://www.postgresql.org/docs/release/16.0/

[^pg16-delay]: PostgreSQL 16 release notes. *"Allow autovacuum to more frequently honor changes to delay settings (Melanie Plageman). Rather than honor changes only at the start of each relation, honor them at the start of each block."* https://www.postgresql.org/docs/release/16.0/

[^pg17-mem]: PostgreSQL 17 release notes. *"New memory management system for VACUUM, which reduces memory consumption and can improve overall vacuuming performance."* and *"Allow vacuum to more efficiently store tuple references (Masahiko Sawada, John Naylor). Additionally, vacuum is no longer silently limited to one gigabyte of memory when maintenance_work_mem or autovacuum_work_mem are higher."* https://www.postgresql.org/docs/release/17.0/

[^pg17-progress]: PostgreSQL 17 release notes. *"Rename pg_stat_progress_vacuum column max_dead_tuples to max_dead_tuple_bytes, rename num_dead_tuples to num_dead_item_ids, and add dead_tuple_bytes (Masahiko Sawada)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-progress-index]: PostgreSQL 17 release notes. *"Allow vacuum to report the progress of index processing (Sami Imseih). This appears in system view pg_stat_progress_vacuum columns indexes_total and indexes_processed."* https://www.postgresql.org/docs/release/17.0/

[^pg17-freeze]: PostgreSQL 17 release notes. *"Allow vacuum to more efficiently remove and freeze tuples (Melanie Plageman, Heikki Linnakangas). WAL traffic caused by vacuum is also more compact."* https://www.postgresql.org/docs/release/17.0/

[^pg17-oldsnap]: PostgreSQL 17 release notes. *"Remove server variable old_snapshot_threshold (Thomas Munro). This variable allowed vacuum to remove rows that potentially could be still visible to running transactions, causing 'snapshot too old' errors later if accessed."* https://www.postgresql.org/docs/release/17.0/

[^pg17-buf]: PostgreSQL 17 release notes. *"Increase default vacuum_buffer_usage_limit to 2MB (Thomas Munro)."* https://www.postgresql.org/docs/release/17.0/

[^pg18-eager]: PostgreSQL 18 release notes. *"Allow normal vacuums to freeze some pages, even though they are all-visible (Melanie Plageman). This reduces the overhead of later full-relation freezing. The aggressiveness of this can be controlled by server variable and per-table setting vacuum_max_eager_freeze_failure_rate. Previously vacuum never processed all-visible pages until freezing was required."* https://www.postgresql.org/docs/release/18.0/

[^pg18-relallfrozen]: PostgreSQL 18 release notes. *"Add column pg_class.relallfrozen (Melanie Plageman)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-only]: PostgreSQL 18 release notes. *"Allow VACUUM and ANALYZE to process partitioned tables without processing their children (Michael Harris). This is enabled with the new ONLY option. This is useful since autovacuum does not process partitioned tables, just its children."* https://www.postgresql.org/docs/release/18.0/

[^pg18-checksums]: PostgreSQL 18 release notes. *"Change initdb default to enable data checksums (Greg Sabino Mullane). Checksums can be disabled with the new initdb option --no-data-checksums. pg_upgrade requires matching cluster checksum settings, so this new option can be useful to upgrade non-checksum old clusters."* https://www.postgresql.org/docs/release/18.0/

[^pg18-aio]: PostgreSQL 18 release notes. *"Add an asynchronous I/O subsystem (Andres Freund, Thomas Munro, Nazir Bilal Yavuz, Melanie Plageman). This feature allows backends to queue multiple read requests, which allows for more efficient sequential scans, bitmap heap scans, vacuums, etc."* https://www.postgresql.org/docs/release/18.0/

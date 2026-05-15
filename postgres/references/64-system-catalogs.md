# PostgreSQL System Catalogs

`pg_catalog` schema as exploration surface. Joins, recipes, version-specific column changes for PG14-PG18.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [pg_catalog Schema Position](#pg_catalog-schema-position)
  - [The `relkind` Enumeration](#the-relkind-enumeration)
  - [OID Cross-Reference Graph](#oid-cross-reference-graph)
  - [psql `ECHO_HIDDEN` Trick](#psql-echo_hidden-trick)
  - [`information_schema` vs `pg_catalog`](#information_schema-vs-pg_catalog)
  - [Core Catalog Tables](#core-catalog-tables)
  - [Core System Views](#core-system-views)
  - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

When you need to inspect cluster state via SQL: "what tables exist", "which indexes never used", "who is blocking whom right now", "how far behind is each replica", "what extensions installed at what version", "what does the partition tree of this table look like". This file is the exploration cookbook for `pg_catalog` joins; per-view deep dives live in the matching topic files (locks → [`43-locking.md`](./43-locking.md), pg_stat_activity → [`58-performance-diagnostics.md`](./58-performance-diagnostics.md), replication slots → [`75-replication-slots.md`](./75-replication-slots.md)).

> [!WARNING] PG17 + PG18 changed many catalog columns
> Monitoring queries written against PG≤16 columns silently return wrong data or zero rows on PG17+:
> - PG17 split `pg_stat_checkpointer` off `pg_stat_bgwriter` (removed `buffers_backend`, `buffers_backend_fsync`).
> - PG17 renamed `pg_stat_progress_vacuum.max_dead_tuples` → `max_dead_tuple_bytes`, `num_dead_tuples` → `num_dead_item_ids`.
> - PG17 renamed `pg_collation.colliculocale` → `colllocale`, `pg_database.daticulocale` → `datlocale`.
> - PG17 changed `pg_attribute.attstattarget` to `NULL` (not `-1`) for default.
> - PG18 removed `pg_stat_io.op_bytes` (replaced by `read_bytes`/`write_bytes`/`extend_bytes`).
> - PG18 removed `pg_stat_wal` read/sync columns (relocated to `pg_stat_io`).
> - PG18 added `pg_constraint.conenforced` and stores NOT NULL constraints in `pg_constraint`.
> - PG18 added `pg_class.relallfrozen`, removed `pg_attribute.attcacheoff`.
>
> Audit every monitoring query before upgrading from PG16 to PG17+, again from PG17 to PG18.

## Mental Model

Five rules. Each names a misconception.

1. **`pg_catalog` is always in `search_path` implicitly** — defeating "I need to `SET search_path = pg_catalog, ...`". Verbatim docs[^pgcatalog]: *"`pg_catalog` is always effectively part of the search path. ... `pg_catalog` will be searched before any of these. This ensures that built-in names will always be findable."* Qualify with `pg_catalog.` only if user table shadows a system name.

2. **The 8-letter `relkind` enumeration is the discriminator for `pg_class`** — defeating "I'll filter `pg_class` by `relname LIKE '%_pkey'`". Values: `r` ordinary table, `i` index, `v` view, `m` materialized view, `c` composite type, `t` TOAST table, `p` partitioned table, `I` partitioned index, `f` foreign table, `S` sequence. Filter by `relkind IN ('r', 'p')` to find "all heap-storing tables including partitioned."

3. **OIDs cross-reference between catalogs** — defeating "I'll join on `relname`". Names not unique across schemas; `oid` always is. Canonical joins: `pg_class.relnamespace → pg_namespace.oid`, `pg_class.oid ← pg_attribute.attrelid`, `pg_class.oid ← pg_index.indrelid`, `pg_index.indexrelid → pg_class.oid` (the index's own row in pg_class).

4. **`\set ECHO_HIDDEN on` reveals what `\d` compiles down to** — defeating "I'll memorize the catalog joins". psql backslash commands are SQL queries against pg_catalog; setting ECHO_HIDDEN prints them before executing. Copy, paste, customize.

5. **`information_schema` is portable; `pg_catalog` is detailed** — defeating "I'll just use information_schema for everything". Information schema is SQL-standard, lossy (no relkind discrimination beyond TABLE/VIEW, no partitioning visibility, no extended stats, no replication slots). Use it only for cross-RDBMS portability; use pg_catalog for actual diagnostics.

## Decision Matrix

| You want to | Use this catalog/view | Join with | Avoid |
|---|---|---|---|
| List tables in a schema | `pg_class` `WHERE relkind IN ('r','p')` | `pg_namespace` | `information_schema.tables` — loses relkind detail |
| List columns of a table | `pg_attribute` `WHERE attrelid = '...'::regclass AND attnum > 0 AND NOT attisdropped` | — | `information_schema.columns` — slower, no storage details |
| List indexes | `pg_index` + `pg_class` (relkind `i` or `I`) | `pg_class` for table name | — |
| Inspect index definition | `pg_get_indexdef(indexrelid)` | — | re-parse `relname` |
| List constraints | `pg_constraint` `WHERE conrelid = '...'::regclass` | `pg_class`, `pg_attribute` | `information_schema.table_constraints` — no `contype` filter granularity |
| Find functions | `pg_proc` `WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = '...')` | `pg_namespace` | scanning `\df` interactively |
| Inventory extensions | `pg_extension` | `pg_namespace` for schema | manually listing `CREATE EXTENSION` output |
| List roles + memberships | `pg_roles` + `pg_auth_members` | recursive CTE | `pg_authid` — restricted (PG masks `rolpassword`) |
| Show server settings | `pg_settings` | — | `SHOW ALL` — no source/category metadata |
| Inspect live activity | `pg_stat_activity` | `pg_blocking_pids()` | `ps -ef` — misses backend state + wait events |
| Per-relation IO | `pg_stat_io` (PG16+) | `pg_stat_database` for cluster sums | `pg_statio_*` — kept but `pg_stat_io` more accurate |
| Partition tree | `pg_partition_tree(oid)` (PG12+) | `pg_class`, `pg_inherits` | walking `pg_inherits` manually |
| Object dependencies | `pg_depend` | `pg_describe_object()` | walking via `\d+` |
| Replication slots | `pg_replication_slots` | `pg_stat_replication` for live walsenders | manual WAL position math |
| Statistics for planner | `pg_stats` (view over `pg_statistic`) | `pg_class` | `pg_statistic` directly — access-restricted |

Three smell signals you reached for the wrong catalog:
- Joining by `relname` text. Use `oid` joins.
- Filtering `pg_class` without a `relkind` clause. You'll mix tables, indexes, sequences, TOAST.
- Querying `pg_statistic` directly and getting permission denied. Use `pg_stats` view (filters by SELECT privilege on the table).

## Syntax / Mechanics

### pg_catalog Schema Position

`pg_catalog` is created by `initdb` in every cluster. Sits implicitly first in `search_path` regardless of GUC value. Schema-qualify only when user object shadows a system name (rare; PG reserves `pg_*` prefix).

```sql
-- Reveal the implicit position
SHOW search_path;
--   search_path
-- ---------------
--  "$user", public
-- (note: pg_catalog NOT shown; it's prepended implicitly)

-- Verify by listing system tables visible without qualification
SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'pg_catalog'::regnamespace LIMIT 5;
```

### The `relkind` Enumeration

`pg_class.relkind` is a single character. Eight values:

| `relkind` | Meaning | Example query |
|---|---|---|
| `r` | Ordinary table (heap) | `WHERE relkind = 'r'` |
| `i` | Index | indexes other than partitioned-index rows |
| `S` | Sequence | created by `CREATE SEQUENCE` or `serial`/IDENTITY |
| `v` | View | `CREATE VIEW` |
| `m` | Materialized view | `CREATE MATERIALIZED VIEW` |
| `c` | Composite type | `CREATE TYPE ... AS (...)` |
| `t` | TOAST table | `pg_toast.pg_toast_<oid>`, one per TOAST-eligible table |
| `f` | Foreign table | `CREATE FOREIGN TABLE` |
| `p` | Partitioned table | parent of declarative partitioning (PG10+) |
| `I` | Partitioned index | parent of partitioned-table index (PG11+) |

**Rule of thumb**: heap-storing tables = `relkind IN ('r', 'p')`. Index-like = `relkind IN ('i', 'I')`. Partitioning-related = `relkind IN ('p', 'I')`.

```sql
-- Wrong: misses partitioned tables
SELECT count(*) FROM pg_class WHERE relkind = 'r';

-- Right: includes partition parents (which themselves store no rows; children do)
SELECT count(*) FROM pg_class WHERE relkind IN ('r', 'p');
```

### OID Cross-Reference Graph

Canonical joins between catalog tables. Memorize this graph and most queries write themselves.

```
pg_namespace (oid, nspname)
   ▲
   │ relnamespace
   │
pg_class (oid, relname, relkind, reltype, reltablespace, reltoastrelid, relfilenode)
   ▲                                        │              │
   │ attrelid                                │ reltype      │ reltoastrelid → pg_class.oid (TOAST table)
   │                                          ▼              ▼
pg_attribute (attrelid, attnum, attname)   pg_type (oid, typname, typrelid)
                                              ▲
                                              │ typrelid (for composite/relation types)
                                              │
pg_class.oid ◄── pg_index (indexrelid, indrelid, indkey, indisunique, indisvalid)
   ▲                  │
   │ conrelid          │ indexrelid → pg_class.oid (the index itself)
   │                  ▼
pg_constraint (oid, conname, contype, conrelid, conindid, confrelid, conkey, confkey)

pg_class.oid ◄── pg_inherits (inhrelid, inhparent, inhseqno)
                       │
                       └──► partition hierarchy or legacy inheritance

pg_class.oid ◄── pg_depend (classid, objid, refclassid, refobjid, deptype)
                       │
                       └──► dependency graph for DROP CASCADE
```

`classid` and `refclassid` in `pg_depend` are themselves OIDs of catalog tables (`'pg_class'::regclass`, `'pg_proc'::regclass`, etc.) — the dependency graph is reified across catalogs.

### psql `ECHO_HIDDEN` Trick

`\d`, `\dt`, `\di`, `\df`, `\dn`, `\du`, `\dx` are SQL queries against pg_catalog. Setting `ECHO_HIDDEN` reveals them.

```sql
\set ECHO_HIDDEN on
\d my_table
-- ********* QUERY **********
-- SELECT c.oid, n.nspname, c.relname
-- FROM pg_catalog.pg_class c
-- LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
-- WHERE c.relname OPERATOR(pg_catalog.~) '^(my_table)$' COLLATE pg_catalog.default
-- ...
```

Use this when you need an exact query to copy into a monitoring tool, dashboard, or stored function.

### `information_schema` vs `pg_catalog`

| Question | information_schema | pg_catalog |
|---|---|---|
| Portable across RDBMS | Yes (SQL standard) | No |
| Sees materialized views | No (only TABLE, VIEW) | Yes (`relkind = 'm'`) |
| Sees partitioned tables | Limited | Yes (`relkind = 'p'`) |
| Sees TOAST tables | No | Yes (`relkind = 't'`) |
| Sees indexes by columns | No direct surface | `pg_index.indkey` array |
| Sees per-column storage | No | `pg_attribute.attstorage`, `attcompression` |
| Sees extension membership | No | `pg_extension` + `pg_depend` |
| Performance | Slower (filtered views) | Faster (direct catalog access) |

Use `information_schema` for cross-RDBMS DDL inventory; use `pg_catalog` for everything else.

### Core Catalog Tables

Quick reference for the most-cited catalogs.

**`pg_class`** — all relations (tables, indexes, views, sequences, partitioned parents, TOAST). Key columns: `oid`, `relname`, `relnamespace`, `relowner`, `relkind`, `reltype`, `relam` (access method, e.g., heap/btree), `relfilenode` (on-disk filename root or 0 for mapped/shared catalogs), `reltoastrelid` (the OID of the TOAST table for this relation, or 0), `relhasindex`, `relpersistence` (`p`/`u`/`t` permanent/unlogged/temporary), `reltuples` (estimated row count from last ANALYZE), `relpages` (heap pages on disk), `relallvisible` (all-visible-map pages), `relallfrozen` (PG18+, all-frozen-map pages).

**`pg_attribute`** — all columns of all relations. Key columns: `attrelid → pg_class.oid`, `attnum` (1-based; system columns are negative), `attname`, `atttypid → pg_type.oid`, `attnotnull`, `atthasdef`, `attisdropped` (logically deleted column, physically present until table rewrite), `attidentity` (`a` ALWAYS, `d` BY DEFAULT, `''` none), `attgenerated` (`s` STORED, `v` VIRTUAL PG18+, `''` none), `attstattarget` (NULL for default in PG17+; `-1` for default in PG≤16).

**`pg_index`** — index metadata (per-row in `pg_class` for index itself; this is the extra index-specific data). Key columns: `indexrelid → pg_class.oid` (the index), `indrelid → pg_class.oid` (the table), `indkey` (`int2vector` of column attnums; `0` means expression), `indclass` (operator classes), `indoption` (per-column flags for `DESC`, `NULLS FIRST/LAST`), `indisunique`, `indisprimary`, `indisvalid`, `indisready`, `indisreplident`, `indpred` (partial-index predicate).

**`pg_constraint`** — all constraints. Key columns: `conname`, `contype` (`p` PK, `u` UNIQUE, `f` FK, `c` CHECK, `x` EXCLUDE, `t` constraint trigger, `n` NOT NULL PG18+), `conrelid`, `confrelid` (FK reference table), `conkey` (column attnums on this table), `confkey` (FK referenced columns), `confupdtype`/`confdeltype` (action codes), `confmatchtype`, `condeferrable`, `condeferred`, `convalidated`, `conenforced` (PG18+).

**`pg_proc`** — functions, procedures, aggregates, window functions. Key columns: `proname`, `pronamespace`, `proowner`, `prolang` (language oid), `prokind` (`f` function, `p` procedure, `a` aggregate, `w` window), `prosecdef` (SECURITY DEFINER), `provolatile` (`i`/`s`/`v`), `proparallel` (`s`/`r`/`u`), `prorettype`, `proargtypes`, `prosrc`.

**`pg_type`** — all data types (including composite types backed by tables, and array types). Key columns: `typname`, `typtype` (`b` base, `c` composite, `d` domain, `e` enum, `r` range, `m` multirange PG14+, `p` pseudo), `typcategory` (broad family: `S` string, `N` numeric, `D` date/time, `A` array, ...), `typrelid` (composite types reference back to a `pg_class` row), `typelem` (array element type), `typarray` (corresponding array type oid).

**`pg_depend`** — dependency edges between catalog objects. Key columns: `classid`, `objid`, `objsubid` (column number for relation columns; 0 otherwise), `refclassid`, `refobjid`, `refobjsubid`, `deptype`. Eight deptypes: `n` NORMAL, `a` AUTO (drop when ref drops), `i` INTERNAL, `e` EXTENSION (object belongs to extension; drop blocks unless dropping the extension), `x` EXTENSION (PG14+ alternative naming), `P` PARTITION_PRI, `S` PARTITION_SEC, plus a few special variants. Walks via `pg_describe_object(classid, objid, objsubid)` produce human-readable strings.

**`pg_inherits`** — inheritance and partitioning edges. Columns: `inhrelid → pg_class.oid` (child), `inhparent → pg_class.oid` (parent), `inhseqno`, `inhdetachpending` (PG14+ for DETACH CONCURRENTLY in progress).

**`pg_partitioned_table`** — declarative-partitioning metadata for parents (relkind `p`). Columns: `partrelid → pg_class.oid`, `partstrat` (`l` LIST, `r` RANGE, `h` HASH), `partnatts`, `partattrs` (column attnums), `partclass`, `partcollation`, `partexprs`.

**`pg_namespace`** — schemas. Columns: `nspname`, `nspowner`, `nspacl`.

**`pg_extension`** — installed extensions. Columns: `extname`, `extowner`, `extnamespace → pg_namespace.oid`, `extrelocatable`, `extversion`, `extconfig` (config-table OIDs preserved by pg_dump), `extcondition`.

**`pg_authid`** — roles (including passwords). Restricted access; non-superusers see filtered version via `pg_roles`. Columns: `rolname`, `rolsuper`, `rolinherit`, `rolcreaterole`, `rolcreatedb`, `rolcanlogin`, `rolreplication`, `rolconnlimit`, `rolpassword`, `rolvaliduntil`, `rolbypassrls`.

**`pg_database`** — databases (cluster-wide; readable from any DB). Columns: `datname`, `datdba` (owner), `encoding`, `datcollate`, `datctype`, `datistemplate`, `datallowconn`, `datconnlimit`, `dattablespace`, `datfrozenxid` (cluster-wide wraparound horizon — cross-ref [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md)), `datminmxid`, `datlocale` (PG17+; was `daticulocale` PG≤16).

**`pg_tablespace`** — tablespaces. Columns: `spcname`, `spcowner`, `spcacl`, `spcoptions`. Cross-ref [`62-tablespaces.md`](./62-tablespaces.md).

**`pg_statistic`** + **`pg_stats`** — planner statistics. Direct access to `pg_statistic` restricted; query `pg_stats` view (filters by SELECT privilege on the underlying table). Cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md).

### Core System Views

**`pg_stat_activity`** — one row per backend (client + autovacuum + walsender + apply workers + parallel workers). Key columns: `datname`, `pid`, `leader_pid` (NULL for non-parallel; set for parallel workers), `usename`, `application_name`, `client_addr`, `backend_start`, `xact_start`, `query_start`, `state_change`, `wait_event_type`, `wait_event`, `state`, `backend_xid`, `backend_xmin`, `query`, `backend_type`, `query_id` (PG14+ when `compute_query_id` on). Cross-ref [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

**`pg_locks`** — one row per held or wanted lock. Key columns: `locktype`, `database`, `relation`, `page`, `tuple`, `virtualxid`, `transactionid`, `mode`, `granted`, `pid`, `waitstart` (PG14+). Cross-ref [`43-locking.md`](./43-locking.md).

**`pg_settings`** — server configuration parameters. Key columns: `name`, `setting`, `unit`, `category`, `context` (`internal`/`postmaster`/`sighup`/`superuser-backend`/`backend`/`superuser`/`user`), `vartype`, `source` (file/default/session/database/role/etc.), `boot_val`, `reset_val`, `sourcefile`, `sourceline`, `pending_restart`. Cross-ref [`53-server-configuration.md`](./53-server-configuration.md).

**`pg_stat_replication`** — one row per active walsender (primary's view of standbys). Key columns: `pid`, `usename`, `application_name`, `client_addr`, `state`, `sent_lsn`, `write_lsn`, `flush_lsn`, `replay_lsn`, `write_lag`, `flush_lag`, `replay_lag`, `sync_priority`, `sync_state`.

**`pg_replication_slots`** — replication slots (physical + logical). Key columns: `slot_name`, `plugin`, `slot_type`, `database`, `temporary`, `active`, `active_pid`, `xmin`, `catalog_xmin`, `restart_lsn`, `confirmed_flush_lsn`, `wal_status` (`reserved`/`extended`/`unreserved`/`lost` — PG13+), `safe_wal_size`, `invalidation_reason` (PG17+), `inactive_since` (PG17+). Cross-ref [`75-replication-slots.md`](./75-replication-slots.md).

**`pg_stat_user_tables`** + **`pg_stat_user_indexes`** + **`pg_statio_*`** — per-relation activity counters. Reset via `pg_stat_reset()` cluster-wide or `pg_stat_reset_single_table_counters(oid)`. Cross-ref [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

**`pg_stat_io`** (PG16+) — per-(backend_type, context, object) IO counters. Replaces several PG≤15 `pg_statio_*` views. Cross-ref [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

**`pg_stat_progress_*`** (vacuum, create_index, basebackup, copy, cluster, analyze) — in-flight long operations. Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md), [`26-index-maintenance.md`](./26-index-maintenance.md).

**`pg_stat_database`** — per-database aggregate counters. Includes session-stats columns (PG14+): `session_time`, `active_time`, `idle_in_transaction_time`, `sessions`, `sessions_abandoned`, `sessions_fatal`, `sessions_killed`. PG18+ adds `parallel_workers_to_launch` + `parallel_workers_launched`.

**`pg_stat_bgwriter`** + **`pg_stat_checkpointer`** (PG17+) — background-writer and checkpointer counters. PG17 split removed `buffers_backend` + `buffers_backend_fsync` from `pg_stat_bgwriter`. Cross-ref [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md).

**`pg_stat_wal`** (PG14+) — WAL emission counters. PG18 removed `wal_write`, `wal_sync`, `wal_write_time`, `wal_sync_time` (relocated to `pg_stat_io`).

**`pg_stat_statements`** (extension) — per-query aggregate. Cross-ref [`57-pg-stat-statements.md`](./57-pg-stat-statements.md).

### Per-Version Timeline

| Version | Catalog/view changes |
|---|---|
| PG14 | New views: `pg_stat_progress_copy`, `pg_stat_wal`, `pg_stat_replication_slots`, `pg_backend_memory_contexts`, `pg_stat_statements_info`, `pg_stats_ext_exprs`. `pg_stat_activity` gains `query_id` column. `pg_stat_database` gains session-stats columns. `pg_prepared_statements` gains `generic_plans`/`custom_plans`. `pg_locks` gains `waitstart`. System catalogs gain primary keys + unique constraints + FKs[^pg14release]. |
| PG15 | New views: `pg_ident_file_mappings`, `pg_stat_subscription_stats`. `pg_database` records collation version (PG15-only `daticulocale` column added; renamed PG17). `pg_type.typcategory` gains internal value for `"char"`[^pg15release]. |
| PG16 | New view: `pg_stat_io`[^pg16release]. `pg_stat_*_tables` gains `last_seq_scan`, `last_idx_scan`, `n_tup_newpage_upd`. `pg_stat_subscription` gains `leader_pid`. `pg_hba_file_rules` + `pg_ident_file_mappings` gain rule/file-name columns. New predefined roles `pg_create_subscription`, `pg_use_reserved_connections`. `pg_attribute` reorganized for efficiency. |
| PG17 | **`pg_stat_checkpointer` view split** from `pg_stat_bgwriter` (removed `buffers_backend`, `buffers_backend_fsync`)[^pg17release]. New view `pg_wait_events`. `pg_collation.colliculocale` → `colllocale`. `pg_database.daticulocale` → `datlocale`. `pg_stat_progress_vacuum` columns renamed (`max_dead_tuples` → `max_dead_tuple_bytes`, `num_dead_tuples` → `num_dead_item_ids`; gained `dead_tuple_bytes`, `indexes_total`, `indexes_processed`). `pg_attribute.attstattarget` + `pg_statistic_ext.stxstattarget` use NULL not -1 for default. `pg_replication_slots` gains `invalidation_reason`, `inactive_since`. |
| PG18 | New views: `pg_aios`, `pg_shmem_allocations_numa`, `pg_buffercache_numa`[^pg18release]. `pg_constraint` gains `conenforced` column; **NOT NULL constraints now stored in `pg_constraint`**. `pg_class` gains `relallfrozen`. `pg_attribute` loses `attcacheoff`. `pg_stat_io` columns renamed (`op_bytes` removed; `read_bytes`/`write_bytes`/`extend_bytes` added) + WAL rows added. `pg_stat_wal` loses read/sync columns. `pg_stat_checkpointer` gains `num_done`, `slru_written`. `pg_stat_database` + `pg_stat_statements` gain `parallel_workers_to_launch`/`parallel_workers_launched`. `pg_stat_all_tables` gains `total_vacuum_time`, `total_autovacuum_time`, `total_analyze_time`, `total_autoanalyze_time`. New functions: `pg_get_acl()`, `has_largeobject_privilege()`, `pg_restore_relation_stats()` family, `pg_stat_get_backend_io()`, `pg_stat_get_backend_wal()`, `pg_get_loaded_modules()`. |

## Examples / Recipes

### Recipe 1 — Top tables by size

```sql
SELECT
  n.nspname AS schema,
  c.relname AS table,
  pg_size_pretty(pg_relation_size(c.oid))         AS heap_size,
  pg_size_pretty(pg_indexes_size(c.oid))          AS indexes_size,
  pg_size_pretty(pg_total_relation_size(c.oid))   AS total_size,
  pg_total_relation_size(c.oid)                   AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')                     -- heap-storing
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY total_bytes DESC
LIMIT 20;
```

`pg_relation_size` = heap only. `pg_indexes_size` = all indexes on the relation. `pg_total_relation_size` = heap + indexes + TOAST. For partitioned parents (relkind `p`), `pg_relation_size` returns 0 since rows live in children; use `pg_partition_tree(oid)` to roll up.

### Recipe 2 — Tables without a primary key

```sql
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
```

Tables without PK can still have UNIQUE indexes; this query specifically finds tables with no `contype = 'p'` constraint. Useful for: logical replication readiness (PG requires PRIMARY KEY or REPLICA IDENTITY on every published table for UPDATE/DELETE), accidental table-without-PK creation audits.

### Recipe 3 — Foreign keys missing a covering index

FK columns on the child side must be indexed if `ON DELETE`/`ON UPDATE` on the parent will ever fire — without an index, every parent DELETE/UPDATE triggers a sequential scan of the child. Cross-ref [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).

```sql
SELECT
  conrelid::regclass    AS child_table,
  conname               AS fk_name,
  pg_get_constraintdef(c.oid) AS fk_definition
FROM pg_constraint c
WHERE contype = 'f'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND (i.indkey::int[])[0:cardinality(c.conkey)-1] = c.conkey::int[]
  );
```

Leading-prefix-match: an index `(other_col, fk_col)` does NOT satisfy. The index must lead with the FK columns in the FK's declared column order.

### Recipe 4 — Duplicate or redundant indexes

```sql
WITH idx AS (
  SELECT
    indrelid::regclass AS table_name,
    indexrelid::regclass AS index_name,
    indkey::int[]      AS columns,
    pg_get_indexdef(indexrelid) AS def,
    pg_relation_size(indexrelid) AS bytes
  FROM pg_index
  WHERE indisvalid AND indisready
)
SELECT a.table_name, a.index_name AS index_a, b.index_name AS index_b,
       pg_size_pretty(a.bytes + b.bytes) AS combined_size
FROM idx a
JOIN idx b
  ON a.table_name = b.table_name
 AND a.index_name < b.index_name
 AND a.columns = b.columns      -- exact match
ORDER BY a.bytes + b.bytes DESC;
```

Finds exact-duplicate indexes. For prefix-redundancy (`(a, b)` made redundant by `(a, b, c)` if no scan uses `b` alone), inspect manually via `pg_get_indexdef`.

### Recipe 5 — Unused indexes (with caveats)

```sql
SELECT
  n.nspname AS schema,
  c.relname AS table,
  i.relname AS index,
  pg_size_pretty(pg_relation_size(i.oid)) AS index_size,
  idx_scan
FROM pg_stat_user_indexes s
JOIN pg_class i ON i.oid = s.indexrelid
JOIN pg_class c ON c.oid = s.relid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_index ix ON ix.indexrelid = i.oid
WHERE idx_scan = 0
  AND NOT ix.indisunique                            -- skip uniqueness-enforcing
  AND NOT ix.indisprimary
  AND pg_relation_size(i.oid) > 1024 * 1024         -- ignore tiny
ORDER BY pg_relation_size(i.oid) DESC;
```

**Three caveats**:
1. Counters are per-instance: indexes used only on a standby (with `hot_standby_feedback`) show 0 on the primary.
2. Counters reset on `pg_stat_reset()` + cluster restart (PG≤14) or only on explicit reset (PG15+).
3. Recently-created indexes appear with `idx_scan = 0` until they're actually scanned. PG16+ added `last_idx_scan` column for a better signal.

### Recipe 6 — Currently running queries with wait events

```sql
SELECT
  pid,
  age(clock_timestamp(), xact_start) AS xact_age,
  age(clock_timestamp(), query_start) AS query_age,
  state,
  wait_event_type || '/' || wait_event AS wait,
  usename,
  application_name,
  left(query, 200) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND state != 'idle'
ORDER BY xact_start ASC NULLS LAST;
```

Read `wait` first: `Lock/relation`, `Lock/transactionid` → blocked on a lock; `LWLock/*` → contention on a shared-memory lock; `IO/*` → reading or writing storage; `Activity/*` → idle (no work). Cross-ref [`43-locking.md`](./43-locking.md) for wait-event taxonomy.

### Recipe 7 — Blocking chain via `pg_blocking_pids()`

```sql
SELECT
  blocked.pid           AS blocked_pid,
  blocked.usename       AS blocked_user,
  age(now(), blocked.xact_start) AS blocked_xact_age,
  blocker.pid           AS blocker_pid,
  blocker.usename       AS blocker_user,
  blocker.state         AS blocker_state,
  blocker.wait_event    AS blocker_wait,
  left(blocked.query, 100) AS blocked_query,
  left(blocker.query, 100) AS blocker_query
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocking_pid ON true
JOIN pg_stat_activity blocker ON blocker.pid = blocking_pid
WHERE blocked.wait_event_type = 'Lock'
ORDER BY blocked.xact_start ASC;
```

`pg_blocking_pids(pid)` returns array of PIDs blocking the given PID. A PID can appear multiple times in the array (one per held lock); de-duplicate downstream if needed. PID `0` in the result means a prepared transaction is the blocker.

### Recipe 8 — Replication lag per standby + slot

```sql
-- On primary
SELECT
  application_name,
  client_addr,
  state,
  sync_state,
  pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)    AS sent_lag_bytes,
  pg_wal_lsn_diff(sent_lsn, replay_lsn)              AS replay_lag_bytes,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS total_lag,
  replay_lag                                          AS apply_time_lag
FROM pg_stat_replication
ORDER BY sent_lag_bytes DESC NULLS LAST;
```

`replay_lag` (time-based) is NULL on idle standbys — that's healthy, not a problem. For slot-based monitoring, also check `pg_replication_slots`:

```sql
SELECT
  slot_name, slot_type, active, wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
  inactive_since                                       -- PG17+
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

`wal_status = 'lost'` means the slot exceeded `max_slot_wal_keep_size` and was invalidated; standby must be rebuilt.

### Recipe 9 — Autovacuum-overdue tables

```sql
SELECT
  n.nspname AS schema,
  c.relname AS table,
  c.reltuples::bigint                          AS approx_rows,
  s.n_dead_tup                                 AS dead_tuples,
  round(100.0 * s.n_dead_tup / NULLIF(c.reltuples, 0), 1) AS dead_pct,
  s.last_autovacuum,
  s.last_autoanalyze,
  age(clock_timestamp(), s.last_autovacuum)    AS time_since_av
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p')
  AND c.reltuples > 10000
  AND s.n_dead_tup > 1000
ORDER BY dead_pct DESC NULLS LAST
LIMIT 20;
```

Thresholds: `dead_pct < 5%` is fine; `5-20%` may need raised autovacuum scale factor; `>20%` with `last_autovacuum` stale means autovacuum is being canceled by lock conflicts or xmin horizon is held back. Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) and [`27-mvcc-internals.md`](./27-mvcc-internals.md).

### Recipe 10 — Longest-running transactions holding xmin horizon back

```sql
SELECT
  pid,
  usename,
  application_name,
  state,
  age(clock_timestamp(), xact_start) AS xact_age,
  age(clock_timestamp(), state_change) AS state_age,
  backend_xmin,
  age(backend_xmin)                  AS xmin_age,
  left(query, 200)                   AS query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 10;
```

A row with `xmin_age > 1_000_000` and `state = 'idle in transaction'` is the canonical bloat-builder: long-held snapshot prevents `VACUUM` from reclaiming dead tuples cluster-wide. Kill via `pg_terminate_backend(pid)` or wait it out. Also check `pg_replication_slots.xmin` and `pg_prepared_xacts` for slot/2PC-pinned horizons.

### Recipe 11 — Settings overridden from default

```sql
SELECT
  name,
  setting,
  unit,
  source,
  category,
  short_desc
FROM pg_settings
WHERE source NOT IN ('default', 'override')
ORDER BY category, name;
```

`source = 'configuration file'` → comes from `postgresql.conf` or `postgresql.auto.conf`. `source = 'environment variable'` → set via `PGOPTIONS`. `source = 'database'` → set via `ALTER DATABASE ... SET`. `source = 'user'` → `ALTER ROLE ... SET`. Use `pg_settings.sourcefile`/`sourceline` to locate the file entry.

### Recipe 12 — Extension inventory

```sql
SELECT
  e.extname,
  e.extversion                       AS installed_version,
  av.default_version                 AS available_version,
  n.nspname                          AS schema,
  CASE WHEN e.extversion = av.default_version THEN 'up to date' ELSE 'upgrade available' END AS status
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_available_extensions av ON av.name = e.extname
ORDER BY status DESC, e.extname;
```

`pg_available_extensions` shows what the cluster has install scripts for. After a major-version upgrade, run `ALTER EXTENSION <name> UPDATE` for each extension with `status = 'upgrade available'`. Cross-ref [`69-extensions.md`](./69-extensions.md).

### Recipe 13 — Partition hierarchy

```sql
SELECT
  pt.relid::regclass         AS partition,
  pt.parentrelid::regclass   AS parent,
  pt.level,
  pt.isleaf,
  pg_size_pretty(pg_relation_size(pt.relid)) AS size
FROM pg_partition_tree('orders'::regclass) pt
ORDER BY pt.level, pt.relid::regclass::text;
```

`pg_partition_tree(parent_oid)` (PG12+) walks the partition tree recursively. For non-partitioned tables it returns a single row. To list partition bounds: `pg_get_partition_constraintdef(child_oid)` shows the `CHECK` clause derived from the partition spec. Cross-ref [`35-partitioning.md`](./35-partitioning.md).

### Recipe 14 — Role membership tree

```sql
WITH RECURSIVE membership AS (
  SELECT
    r.oid, r.rolname, NULL::name AS member_of, 0 AS depth
  FROM pg_roles r
  WHERE r.rolname NOT LIKE 'pg\_%'

  UNION ALL

  SELECT
    r.oid, r.rolname, parent.rolname, m.depth + 1
  FROM membership m
  JOIN pg_auth_members am ON am.member = m.oid
  JOIN pg_roles parent ON parent.oid = am.roleid
  JOIN pg_roles r ON r.oid = m.oid
)
SELECT lpad('', depth * 2) || rolname AS role_tree, member_of
FROM membership
ORDER BY rolname, depth;
```

Walks the grants graph in `pg_auth_members`. PG16+ added per-grant `WITH SET`/`WITH INHERIT` options visible in `pg_auth_members.set_option`/`inherit_option` — check those when debugging "I'm a member of X but cannot use its privileges". Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md).

## Gotchas / Anti-patterns

1. **`pg_class` filtered without `relkind`** — mixes tables, indexes, sequences, TOAST, views. Always add a `relkind IN (...)` clause for the kind you care about.

2. **Joining catalog tables by `relname`** — `relname` is not unique across schemas. Always join via `oid`. The `regclass` cast (`'public.my_table'::regclass`) handles the schema+name → oid lookup correctly with `search_path`.

3. **`pg_statistic` direct access returns permission denied for non-superusers** — use the `pg_stats` view, which filters by SELECT privilege on the underlying table.

4. **`pg_authid` returns permission denied for non-superusers** — `rolpassword` is sensitive. Use the `pg_roles` view, which masks the password column.

5. **`pg_stat_user_indexes.idx_scan = 0` is not proof of unused** — three caveats. Counters per-instance (standby usage doesn't count on primary). Counters reset on `pg_stat_reset()`. Recently created indexes haven't had time to be scanned. PG16+ `last_idx_scan` column is the better signal.

6. **`pg_stat_*` counters wrap at `bigint`** — at extreme rates (billions per hour), monitoring tools can record overflow as zero. Use rate-of-change between snapshots, not absolute values.

7. **`relfilenode = 0`** — appears on mapped or shared catalogs (`pg_database`, `pg_authid`, etc.). The filename is held in `pg_filenode.map`, not in `pg_class.relfilenode`. Don't grep filesystems by `relfilenode` for these.

8. **`pg_partition_tree()` requires PG12+** — pre-PG12 you must walk `pg_inherits` recursively. The function exists on PG12 in core (not extension-required).

9. **`pg_get_indexdef()` reconstructs from catalog, not the original DDL** — comments, exact whitespace, `INCLUDE` clause ordering match docs but verbose options may be normalized. Don't `diff` original DDL against `pg_get_indexdef()` output literally.

10. **`pg_locks` shows current locks, not historical** — for "who blocked whom an hour ago" you need either logging via `log_lock_waits` or external sampling.

11. **`pg_settings.context = 'postmaster'`** — change requires server restart. `ALTER SYSTEM SET` writes `postgresql.auto.conf`; `pg_settings.pending_restart` becomes `true` after reload until restart happens.

12. **`information_schema` is slower than `pg_catalog`** — information_schema views wrap pg_catalog with per-row privilege filters. For monitoring scripts that hit catalogs often, prefer pg_catalog.

13. **Cross-database queries**: `pg_database`, `pg_authid`, `pg_tablespace`, `pg_settings` are cluster-wide (readable from any database). `pg_class`, `pg_attribute`, `pg_index`, `pg_proc`, etc. are per-database — you cannot query another database's tables from the current connection without `dblink` or `postgres_fdw`.

14. **`pg_stat_activity.query` truncated at `track_activity_query_size`** (default 1024 bytes). Long queries appear cut off. Raise the GUC if you need full text.

15. **`backend_xid = NULL` doesn't mean no transaction** — `backend_xmin` (the visible-xmin) is set whenever any read transaction is in flight; `backend_xid` (the assigned XID) is set only when the transaction has written. A long-running read-only transaction holds xmin without ever getting an xid.

16. **`pg_blocking_pids()` duplicates PIDs** — one entry per held lock blocking the queried PID; for a parallel-query group, every worker shows the same blockers. De-dupe with `DISTINCT` downstream.

17. **`pg_constraint` for NOT NULL is PG18+** — pre-PG18, NOT NULL was stored only in `pg_attribute.attnotnull`. Audit queries that join via `pg_constraint.contype = 'n'` return zero rows on PG≤17.

18. **`pg_stat_io` does not exist before PG16** — monitoring queries that select from it must `WHERE current_setting('server_version_num')::int >= 160000` guard or break on older clusters.

19. **`pg_stat_checkpointer` does not exist before PG17** — `pg_stat_bgwriter.buffers_backend` and `buffers_backend_fsync` were removed in PG17. Queries depending on those columns return errors on PG17+.

20. **`pg_partitioned_table.partattrs` is `int2vector`**, not `int[]` — must cast via `partattrs::int[]` to use array operators.

21. **`pg_extension.extconfig` is the array of OIDs for user-table configuration data the extension owns** — pg_dump preserves their contents across dump/restore. If an extension's config table contains user data, that data survives `DROP EXTENSION ... CASCADE` and `pg_restore`.

22. **`pg_database.datfrozenxid` advancing slowly across hours of writes** is a wraparound-risk signal — combine with `age()` and cross-ref [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

23. **System catalog modifications via direct UPDATE are unsupported** — verbatim docs[^pgcatalog]: *"It is seldom advisable to alter the system catalogs by hand. ... Use of SQL commands is highly recommended."* In emergency-recovery contexts only, requires `allow_system_table_mods = on` and survives no PG-major upgrade.

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin horizon mechanics behind `backend_xmin`, `datfrozenxid`.
- [`31-toast.md`](./31-toast.md) — TOAST table `relkind = 't'` in `pg_class` enumeration.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum trigger thresholds, `pg_stat_progress_vacuum`.
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — wraparound monitoring via `pg_database.datfrozenxid`.
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — FK-without-covering-index full discussion.
- [`43-locking.md`](./43-locking.md) — `pg_locks` + `pg_blocking_pids()` deep dive.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pg_roles`, `pg_auth_members`, predefined roles.
- [`53-server-configuration.md`](./53-server-configuration.md) — `pg_settings` columns + precedence.
- [`55-statistics-planner.md`](./55-statistics-planner.md) — `pg_statistic`, `pg_stats`, `pg_statistic_ext`.
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity`, `pg_stat_*_tables`, `pg_stat_io`.
- [`62-tablespaces.md`](./62-tablespaces.md) — `pg_tablespace` joins.
- [`67-cli-tools.md`](./67-cli-tools.md) — psql backslash commands compile down to catalog queries.
- [`69-extensions.md`](./69-extensions.md) — `pg_extension`, `pg_available_extensions`.
- [`75-replication-slots.md`](./75-replication-slots.md) — `pg_replication_slots` deep dive.
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — cross-cutting catalog recipes.

## Sources

[^pgcatalog]: PostgreSQL 16 Manual, "5.9.5. The Schema Search Path" — `pg_catalog` always effectively part of search path. https://www.postgresql.org/docs/16/ddl-schemas.html#DDL-SCHEMAS-CATALOG
[^pg14release]: PostgreSQL 14 Release Notes — New views `pg_stat_progress_copy`, `pg_stat_wal`, `pg_stat_replication_slots`, `pg_backend_memory_contexts`, `pg_stat_statements_info`, `pg_stats_ext_exprs`; `pg_stat_activity` query_id column; system catalogs gain PKs/FKs/unique constraints. https://www.postgresql.org/docs/release/14.0/
[^pg15release]: PostgreSQL 15 Release Notes — New views `pg_ident_file_mappings`, `pg_stat_subscription_stats`; `pg_database` records collation version; `pg_type.typcategory` gains internal value for `"char"`. https://www.postgresql.org/docs/release/15.0/
[^pg16release]: PostgreSQL 16 Release Notes — New view `pg_stat_io`; `pg_stat_*_tables` gains `last_seq_scan`, `last_idx_scan`, `n_tup_newpage_upd`; `pg_stat_subscription` gains `leader_pid`; `pg_create_subscription` and `pg_use_reserved_connections` predefined roles. https://www.postgresql.org/docs/release/16.0/
[^pg17release]: PostgreSQL 17 Release Notes — `pg_stat_checkpointer` view created (relevant columns removed from `pg_stat_bgwriter`); `pg_wait_events` view added; `pg_collation.colliculocale` → `colllocale`; `pg_database.daticulocale` → `datlocale`; `pg_stat_progress_vacuum` column renames; `pg_attribute.attstattarget` NULL representation; `pg_replication_slots` gains `invalidation_reason`, `inactive_since`. https://www.postgresql.org/docs/release/17.0/
[^pg18release]: PostgreSQL 18 Release Notes — `pg_aios`, `pg_shmem_allocations_numa`, `pg_buffercache_numa` views; `pg_constraint.conenforced`; NOT NULL stored in `pg_constraint`; `pg_class.relallfrozen`; `pg_attribute.attcacheoff` removed; `pg_stat_io` `op_bytes` removed (`read_bytes`/`write_bytes`/`extend_bytes` added); `pg_stat_wal` read/sync columns removed; `pg_stat_checkpointer.num_done`/`slru_written`; new functions `pg_get_acl()`, `has_largeobject_privilege()`, `pg_restore_relation_stats()` family, `pg_stat_get_backend_io()`, `pg_stat_get_backend_wal()`. https://www.postgresql.org/docs/release/18.0/

Primary docs (all PG 16):

- System Catalogs chapter — https://www.postgresql.org/docs/16/catalogs.html
- `pg_class` — https://www.postgresql.org/docs/16/catalog-pg-class.html
- `pg_attribute` — https://www.postgresql.org/docs/16/catalog-pg-attribute.html
- `pg_index` — https://www.postgresql.org/docs/16/catalog-pg-index.html
- `pg_constraint` — https://www.postgresql.org/docs/16/catalog-pg-constraint.html
- `pg_proc` — https://www.postgresql.org/docs/16/catalog-pg-proc.html
- `pg_type` — https://www.postgresql.org/docs/16/catalog-pg-type.html
- `pg_depend` — https://www.postgresql.org/docs/16/catalog-pg-depend.html
- `pg_inherits` — https://www.postgresql.org/docs/16/catalog-pg-inherits.html
- `pg_partitioned_table` — https://www.postgresql.org/docs/16/catalog-pg-partitioned-table.html
- `pg_namespace` — https://www.postgresql.org/docs/16/catalog-pg-namespace.html
- `pg_extension` — https://www.postgresql.org/docs/16/catalog-pg-extension.html
- `pg_authid` — https://www.postgresql.org/docs/16/catalog-pg-authid.html
- `pg_database` — https://www.postgresql.org/docs/16/catalog-pg-database.html
- `pg_tablespace` — https://www.postgresql.org/docs/16/catalog-pg-tablespace.html
- `pg_statistic` — https://www.postgresql.org/docs/16/catalog-pg-statistic.html
- `pg_statistic_ext` — https://www.postgresql.org/docs/16/catalog-pg-statistic-ext.html
- System Views chapter — https://www.postgresql.org/docs/16/views-overview.html
- `pg_roles` — https://www.postgresql.org/docs/16/view-pg-roles.html
- `pg_stats` — https://www.postgresql.org/docs/16/view-pg-stats.html
- `pg_settings` — https://www.postgresql.org/docs/16/view-pg-settings.html
- `pg_locks` — https://www.postgresql.org/docs/16/view-pg-locks.html
- `pg_cursors` — https://www.postgresql.org/docs/16/view-pg-cursors.html
- Information Schema — https://www.postgresql.org/docs/16/information-schema.html
- psql `app-psql` — https://www.postgresql.org/docs/16/app-psql.html

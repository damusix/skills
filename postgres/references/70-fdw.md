# 70 — Foreign Data Wrappers (FDW)

Query external data sources as if they were local tables. `postgres_fdw` for PG-to-PG, `file_fdw` for server-side CSV/TSV, third-party FDWs for MySQL/MongoDB/Oracle/CSV-over-HTTP/etc.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Four DDL objects](#four-ddl-objects)
    - [`CREATE FOREIGN DATA WRAPPER`](#create-foreign-data-wrapper)
    - [`CREATE SERVER`](#create-server)
    - [`CREATE USER MAPPING`](#create-user-mapping)
    - [`CREATE FOREIGN TABLE`](#create-foreign-table)
    - [`IMPORT FOREIGN SCHEMA`](#import-foreign-schema)
    - [Pushdown semantics](#pushdown-semantics)
    - [`postgres_fdw`](#postgres_fdw-deep-dive)
    - [`file_fdw`](#file_fdw)
    - [`dblink`](#dblink-legacy-alternative)
    - [FDW C-API (writing a wrapper)](#fdw-c-api-writing-a-wrapper)
- [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

> [!WARNING] Pushdown is opt-in, not automatic
> `postgres_fdw` defaults to `use_remote_estimate=false`. Planner uses *local* statistics (none, for foreign tables) → typically yanks all rows back, filters locally. Pushdown of WHERE/JOIN/aggregate happens **only** when planner has enough info — usually means `use_remote_estimate=true` (verbatim cost) or explicit `ANALYZE foreign_table` (sampling). Without it `EXPLAIN VERBOSE` shows remote SQL = `SELECT * FROM remote` and local Filter — can cause incorrect query plans and full-table transfers on large remote tables.

Use FDW when:

- Query external PG cluster from current cluster (postgres_fdw)
- Read server-side CSV/TSV as queryable table (file_fdw)
- Federate across heterogeneous datastores (third-party FDWs: mysql_fdw, mongo_fdw, oracle_fdw, jdbc_fdw, csv_fdw, multicorn-based)
- Migrate data with `INSERT INTO local SELECT ... FROM foreign_table` + `ANALYZE`
- Read remote table once for ETL — much simpler than COPY + scp + COPY

Do NOT use FDW for:

- Sharding workload (use Citus — see [`97-citus.md`](./97-citus.md))
- High-throughput OLTP across nodes (FDW is request-response over libpq; latency dominates)
- Replication (use logical replication — [`74-logical-replication.md`](./74-logical-replication.md))
- Hot path where you'd `JOIN local TO foreign WHERE local.id IN (...)` with thousands of IDs — N+1-like fetch even with batched IN list

## Mental Model

Five rules:

1. **Four DDL objects required** to query external data. `CREATE FOREIGN DATA WRAPPER` (extension installs it), `CREATE SERVER` (named endpoint), `CREATE USER MAPPING` (auth credentials per role), `CREATE FOREIGN TABLE` (or `IMPORT FOREIGN SCHEMA`). All four must exist before any query works.
2. **`IMPORT FOREIGN SCHEMA`** bulk-imports remote table definitions. Avoids hand-writing `CREATE FOREIGN TABLE` for every remote table.
3. **Pushdown** decides what executes remotely vs locally. `EXPLAIN VERBOSE` shows the remote SQL string sent to the foreign server — the canonical "is my filter being pushed down?" diagnostic. Aggregates / joins / ORDER BY / LIMIT pushdown landed gradually across PG versions.
4. **`postgres_fdw`** is the canonical PG-to-PG FDW (contrib, trusted PG13+). Uses libpq + extended query protocol. Async append (PG14+) parallelizes cross-server scans. Batch insert (PG14+) groups INSERT into N-row batches.
5. **`file_fdw`** reads server-side CSV/TSV/binary files via the COPY protocol. Needs `pg_read_server_files` role or superuser — managed environments usually block it.

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Query another PG cluster | `postgres_fdw` | `dblink` | Better pushdown, planner integration, prepared-statement reuse |
| Query a CSV file on server | `file_fdw` | manual `COPY` into staging table | Read-only direct query, no temp storage |
| Heterogeneous SQL data source | `oracle_fdw`, `mysql_fdw`, `mssql_fdw` | porting via dump/restore | Live query, optional pushdown |
| Non-SQL data source (MongoDB, REST, S3) | `mongo_fdw`, `multicorn` (Python FDW framework), `kafka_fdw` | porting | Live query |
| Sharded write workload across N nodes | [`97-citus.md`](./97-citus.md) | hand-rolled FDW federation | Citus has shard router + colocated joins |
| Replicate writes to another cluster | [`74-logical-replication.md`](./74-logical-replication.md) | FDW with trigger-based replication | Logical replication is purpose-built |
| Bulk one-time migration from another cluster | `postgres_fdw` + `INSERT INTO ... SELECT * FROM foreign_t` | `pg_dump | psql` | One transaction, ANALYZE-friendly |
| Federated query across 2+ PG clusters | `postgres_fdw` with `async_capable=true` on each server | sequential queries | PG14+ parallelizes the foreign scans |
| Read CSV in a managed cluster (no `pg_read_server_files`) | client-side `\copy` into staging table | `file_fdw` | Most managed providers block server-file access |
| Application connecting to multiple unrelated dbs | application-level connection pooling | FDW per remote db | FDW per-tx pinned connection; pool churn worse |
| Cross-cluster transaction | none (2PC not auto-coordinated) | `postgres_fdw` as if atomic | FDW transactions are best-effort per-server; failure leaves orphan state |

**Smell signals:**

- `EXPLAIN VERBOSE` on a foreign-table query shows `Remote SQL: SELECT ... FROM table` (no filter) — means filter is not pushed down. Run `ANALYZE foreign_table` or set `use_remote_estimate=true`.
- `pg_stat_activity` on the foreign server shows backends in `idle in transaction` originating from your local cluster — means `keep_connections=on` is leaving idle pinned conns. Tune `idle_session_timeout` on the remote.
- Bulk `INSERT INTO foreign_t SELECT FROM local_t` is slow — set `batch_size=1000` on the foreign server or table.

## Syntax / Mechanics

### Four DDL objects

```sql
CREATE EXTENSION postgres_fdw;

CREATE SERVER remote_db
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host '10.0.0.5', port '5432', dbname 'analytics');

CREATE USER MAPPING FOR app_user
    SERVER remote_db
    OPTIONS (user 'app_user', password '<secret>');

CREATE FOREIGN TABLE orders_remote (
    order_id    bigint,
    customer_id bigint,
    total       numeric(12, 2),
    created_at  timestamptz
)
    SERVER remote_db
    OPTIONS (schema_name 'public', table_name 'orders');

SELECT * FROM orders_remote WHERE order_id = 42;
```

All four DDL objects required. Drop in reverse order: `DROP FOREIGN TABLE` → `DROP USER MAPPING` → `DROP SERVER` → `DROP EXTENSION` (`CASCADE` to skip the dependency walk).

### `CREATE FOREIGN DATA WRAPPER`

```
CREATE FOREIGN DATA WRAPPER name
    [ HANDLER handler_function | NO HANDLER ]
    [ VALIDATOR validator_function | NO VALIDATOR ]
    [ OPTIONS ( option 'value' [, ... ] ) ]
```

Almost always installed via `CREATE EXTENSION` (which calls `CREATE FOREIGN DATA WRAPPER` internally). Manual `CREATE FOREIGN DATA WRAPPER` only needed when writing a custom wrapper — see [FDW C-API](#fdw-c-api-writing-a-wrapper).

Inspect installed wrappers via:

```sql
SELECT fdwname, fdwhandler::regproc, fdwvalidator::regproc
FROM pg_foreign_data_wrapper;
```

### `CREATE SERVER`

```
CREATE SERVER server_name
    [ TYPE 'server_type' ]
    [ VERSION 'server_version' ]
    FOREIGN DATA WRAPPER fdw_name
    [ OPTIONS ( option 'value' [, ... ] ) ]
```

Options depend on the FDW. For `postgres_fdw` they map to libpq connection parameters (`host`, `port`, `dbname`, `sslmode`, `application_name`, etc.) plus postgres_fdw-specific options (catalog below).

`ALTER SERVER ... OPTIONS (ADD/SET/DROP option 'value')` to change at runtime. Connections in flight keep old values until reconnect.

### `CREATE USER MAPPING`

```
CREATE USER MAPPING FOR { user_name | USER | CURRENT_USER | PUBLIC }
    SERVER server_name
    [ OPTIONS ( option 'value' [, ... ] ) ]
```

`USER`/`CURRENT_USER` = currently running role. `PUBLIC` = default fallback for any role lacking a specific mapping.

For `postgres_fdw`, options are `user`, `password`, `sslpassword`. Stored in `pg_user_mapping` — only superuser + the mapped role can read the `password` field via `pg_user_mappings` view.

> [!WARNING] Password storage
> Passwords stored in `pg_user_mapping.umoptions` as plain text. Backups (`pg_dump --include-foreign-data`) include them. Managed environments typically forbid this — use SCRAM passthrough (PG18+) or external secret store.

### `CREATE FOREIGN TABLE`

```
CREATE FOREIGN TABLE [ IF NOT EXISTS ] table_name (
    column_name data_type [ OPTIONS ( option 'value' [, ... ] ) ]
                          [ COLLATE collation ]
                          [ column_constraint [ ... ] ]
    [, ... ]
    [ table_constraint [, ... ] ]
)
    [ INHERITS ( parent_table [, ... ] ) ]
    SERVER server_name
    [ OPTIONS ( option 'value' [, ... ] ) ]
```

Per-column `OPTIONS`: `column_name 'remote_name'` (map local col name to a differently-named remote col). Useful when remote schema uses snake_case but local prefers something else, or when you cannot otherwise change the local API.

Table constraints (`PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`) are **not** enforced for foreign tables — they are declarations the planner uses for join planning. The actual constraint lives (or doesn't) on the remote.

Foreign tables can be partitions of a partitioned table since PG11. They can also be partitions parent in PG12+ via `INHERITS`.

### `IMPORT FOREIGN SCHEMA`

```
IMPORT FOREIGN SCHEMA remote_schema
    [ { LIMIT TO | EXCEPT } ( table_name [, ... ] ) ]
    FROM SERVER server_name
    INTO local_schema
    [ OPTIONS ( option 'value' [, ... ] ) ]
```

Bulk-imports all (or `LIMIT TO`/`EXCEPT` filtered) remote table definitions as foreign tables in `local_schema`. Saves writing `CREATE FOREIGN TABLE` for each remote table by hand.

> [!NOTE] PostgreSQL 14
> Verbatim: *"Allow postgres_fdw to import table partitions if specified by IMPORT FOREIGN SCHEMA ... LIMIT TO (Matthias van de Meent)"*. Pre-PG14 `IMPORT FOREIGN SCHEMA` could not target partitions by name in the `LIMIT TO` clause.

`postgres_fdw` import options:

| Option | Default | Effect |
|---|---|---|
| `import_collate` | `true` (PG18+) | Include `COLLATE` from remote |
| `import_default` | `false` | Include column `DEFAULT` expressions |
| `import_generated` | `true` (PG12+) | Include `GENERATED` column expressions |
| `import_not_null` | `true` | Include `NOT NULL` constraints |

> [!NOTE] PostgreSQL 18
> Per the verbatim PG18 docs the `import_collate`, `import_default`, `import_generated`, and `import_not_null` server-level options control what gets included on import. Set on the SERVER and they apply to every `IMPORT FOREIGN SCHEMA FROM SERVER ...`. Pre-PG18 some of these options weren't exposed at the server level.

### Pushdown semantics

Pushdown = executing parts of the query *on the remote server* rather than locally. Massively affects performance.

`postgres_fdw` pushdown matrix (PG16 baseline, then version annotations):

| Capability | Default | Notes |
|---|---|---|
| WHERE predicates | Yes (immutable, foreign-safe) | Volatile functions stay local |
| Column projection | Yes | Only fetched columns sent |
| LIMIT | Yes | Pushed when no ORDER BY ambiguity |
| ORDER BY | Yes (when remote can return sorted) | Requires `use_remote_estimate` for cost decisions |
| Inner JOIN | Yes | Both sides same `postgres_fdw` server |
| LEFT/RIGHT OUTER JOIN | Yes | Same server |
| FULL OUTER JOIN | Yes | Same server |
| Aggregates (SUM, AVG, COUNT, MIN, MAX) | Yes | Same server, immutable filter |
| GROUP BY | Yes | Often together with aggregate pushdown |
| Sub-query (`EXISTS`, `IN`) | PG17+ | See per-version timeline |
| Non-join qualifications in joined queries | PG17+ | See per-version timeline |
| `UPDATE`/`DELETE` (multi-row) | Yes since PG10 | Pushed as `UPDATE table SET ... WHERE ...` |
| `TRUNCATE` | PG14+ | See per-version timeline |

To verify pushdown:

```sql
EXPLAIN (VERBOSE, COSTS OFF)
    SELECT customer_id, sum(total)
    FROM orders_remote
    WHERE created_at >= '2026-01-01'
    GROUP BY customer_id;
```

Look at `Remote SQL:` — if it shows `SELECT customer_id, sum(total) FROM ... WHERE created_at >= ... GROUP BY customer_id`, aggregate + filter + group push down. If it shows `SELECT order_id, customer_id, total, created_at FROM ...`, nothing pushed except column projection.

### `postgres_fdw` deep dive

Trusted contrib extension (PG13+). Cross-cluster query for PG-to-PG.

**Server-level options (PG16 baseline):**

```sql
CREATE SERVER remote_db FOREIGN DATA WRAPPER postgres_fdw OPTIONS (
    host                'remote.internal',
    port                '5432',
    dbname              'analytics',
    sslmode             'verify-full',
    sslrootcert         '/etc/ssl/certs/ca.pem',
    application_name    'fdw-from-prod',
    use_remote_estimate 'false',     -- default: planner uses local stats
    fdw_startup_cost    '100',       -- planner cost per remote query
    fdw_tuple_cost      '0.2',       -- planner cost per remote tuple (PG17 raised default — see gotchas)
    fetch_size          '100',       -- rows per cursor FETCH
    batch_size          '100',       -- rows per remote INSERT (PG14+)
    async_capable       'true',      -- parallel append (PG14+)
    parallel_commit     'true',      -- 2PC-style commit (PG15+)
    parallel_abort      'true',      -- parallel ROLLBACK (PG16+)
    keep_connections    'on',        -- pin conn across txns (PG14+)
    extensions          'pg_trgm'    -- whitelist immutable funcs from these extensions for pushdown
);
```

**Table-level options:**

```sql
CREATE FOREIGN TABLE orders_remote (...) SERVER remote_db OPTIONS (
    schema_name         'public',     -- remote schema
    table_name          'orders',     -- remote table name
    use_remote_estimate 'true',       -- override server default per-table
    analyze_sampling    'random',     -- PG16+ sampling method (off | auto | random | system | bernoulli)
    fetch_size          '500',        -- override
    batch_size          '500',
    async_capable       'true',
    updatable           'true',       -- allow UPDATE/DELETE/INSERT
    truncatable         'true'        -- allow TRUNCATE (PG14+)
);
```

**Per-column options:**

```sql
CREATE FOREIGN TABLE x (
    id    bigint    OPTIONS (column_name 'order_id'),
    total numeric   OPTIONS (column_name 'order_total')
) SERVER remote_db ...;
```

#### `use_remote_estimate`

By default `false`. Planner uses local (zero) statistics → assumes ~1 row, picks NestedLoop with foreign as inner → catastrophic for large remote tables.

Set `true` to make planner issue `EXPLAIN` on remote for each candidate plan. Cost: an extra remote roundtrip during planning. Use per-table if a few foreign tables are large and the rest are small.

Alternative: `ANALYZE foreign_table` runs locally but samples remote (via `analyze_sampling` since PG16). Stats stored in local `pg_statistic`. Lower planning cost than `use_remote_estimate`, slightly less accurate.

#### `fetch_size`

Rows per cursor FETCH. Default 100. Bigger value = fewer remote roundtrips, more local memory. Tune for high-latency networks (200ms RTT × 1000 fetches = 200s of nothing-but-network).

#### `batch_size`

> [!NOTE] PostgreSQL 14
> Verbatim: *"Allow postgres_fdw to INSERT rows in bulk (Takayuki Tsunakawa, Tomas Vondra, Amit Langote)"*.

Rows per remote `INSERT`. Default 1 (one INSERT per local row). Set to 100+ for bulk loads. Multi-row `INSERT ... VALUES (...), (...), ...` over the wire.

Caveat: `RETURNING` may force batch_size=1 (single-row INSERT to get OID/PK back).

#### `async_capable` (PG14+)

> [!NOTE] PostgreSQL 14
> Verbatim: *"Allow a query referencing multiple foreign tables to perform foreign table scans in parallel (Robert Haas, Kyotaro Horiguchi, Thomas Munro, Etsuro Fujita). postgres_fdw supports this type of scan if async_capable is set."* PG15 verbatim: *"Allow a query referencing multiple foreign tables to perform parallel foreign table scans in more cases (Andrey Lepikhov, Etsuro Fujita)"*.

Set `async_capable='true'` on either SERVER or FOREIGN TABLE. Planner's `Append` node can fire all child scans in parallel rather than sequentially.

```sql
ALTER SERVER remote_db OPTIONS (ADD async_capable 'true');
```

`EXPLAIN` shows `Async Foreign Scan` rather than `Foreign Scan` for the parallelized children.

#### `keep_connections` (PG14+)

> [!NOTE] PostgreSQL 14
> Verbatim: *"Allow control over whether foreign servers keep connections open after transaction completion (Bharath Rupireddy). This is controlled by keep_connections and defaults to on."*

Default `on`. Connection pinned per session. Set `off` if connection pool on remote is precious.

Inspect open connections via `postgres_fdw_get_connections()`:

```sql
SELECT * FROM postgres_fdw_get_connections();
```

> [!NOTE] PostgreSQL 18
> PG18 added output columns `used_in_xact`, `closed`, `user_name`, `remote_backend_pid` to `postgres_fdw_get_connections()`. Lets you find which remote PID is yours when debugging hung queries.

#### `parallel_commit` / `parallel_abort`

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow parallel commit on postgres_fdw servers (Etsuro Fujita). This is enabled with the CREATE SERVER option parallel_commit."*

> [!NOTE] PostgreSQL 16
> Verbatim: *"Allow postgres_fdw to do aborts in parallel (Etsuro Fujita). This is enabled with postgres_fdw option parallel_abort."*

When a local transaction touches N foreign servers, PG15+ commits them concurrently (default off — set per server). PG16+ aborts concurrently. Materially reduces commit latency for federated transactions across 3+ servers.

**Not 2PC.** No automatic recovery if some commit and others abort — failure leaves orphan state. Use external 2PC coordinator (or accept best-effort).

#### `TRUNCATE` on foreign tables (PG14+)

> [!NOTE] PostgreSQL 14
> Verbatim: *"Allow TRUNCATE to operate on foreign tables (Kazutaka Onishi, Kohei KaiGai). The postgres_fdw module also now supports this."*

```sql
TRUNCATE orders_remote;
```

Foreign table must have `truncatable=true`. Maps to remote `TRUNCATE`.

#### SCRAM passthrough (PG18+)

> [!NOTE] PostgreSQL 18
> Verbatim: *"Allow SCRAM authentication from the client to be passed to postgres_fdw servers (Matheus Alcantara, Peter Eisentraut). This avoids storing postgres_fdw authentication information in the database, and is enabled with the postgres_fdw use_scram_passthrough connection option."*

Set `use_scram_passthrough=true` on USER MAPPING (or SERVER). Local backend forwards the SCRAM exchange from the client to the remote — no password stored locally.

Requirements:

- Client authenticated to local via SCRAM (`scram-sha-256` in pg_hba.conf)
- Local connected to remote via SCRAM
- Remote pg_hba.conf allows SCRAM from local's IP

Cross-reference [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) for SCRAM mechanics.

```sql
CREATE USER MAPPING FOR app_user SERVER remote_db
    OPTIONS (user 'app_user', use_scram_passthrough 'true');
```

#### Pushdown improvements (PG17)

> [!NOTE] PostgreSQL 17
> Verbatim: *"Allow pushdown of EXISTS and IN subqueries to postgres_fdw foreign servers (Alexander Pyhalov)"*. Plus *"Increase the default foreign data wrapper tuple cost (David Rowley, Umair Shahid)"* — `fdw_tuple_cost` default raised from `0.01` to `0.2`. Operationally: planner becomes more conservative about pushing many tuples to remote post-PG17. Check `EXPLAIN VERBOSE` after pg_upgrade — plans may shift.

### `file_fdw`

Server-side CSV/TSV/binary file reader. Trusted contrib extension.

```sql
CREATE EXTENSION file_fdw;

CREATE SERVER file_server FOREIGN DATA WRAPPER file_fdw;

CREATE FOREIGN TABLE access_log (
    ts          timestamptz,
    user_id     bigint,
    path        text,
    status      int
) SERVER file_server OPTIONS (
    filename '/var/log/app/access.csv',
    format 'csv',
    header 'true',
    delimiter ',',
    null ''
);

SELECT count(*) FROM access_log WHERE status >= 500;
```

Options match `COPY` options. Read-only (no `INSERT` / `UPDATE` / `DELETE`).

> [!NOTE] PostgreSQL 18
> Verbatim: *"Add on_error and log_verbosity options to file_fdw (Atsushi Torikoshi). These control how file_fdw handles and reports invalid file rows."* And: *"Add reject_limit to control the number of invalid rows file_fdw can ignore (Atsushi Torikoshi). This is active when ON_ERROR = 'ignore'."*

PG18 `file_fdw` gains `on_error='ignore'` + `reject_limit=N` + `log_verbosity={verbose|default}` for error-tolerant ingest. Same option family as PG17 COPY ON_ERROR (see [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md)).

Permission requirement: role needs `pg_read_server_files` membership OR superuser. Most managed environments revoke `pg_read_server_files` → `file_fdw` unusable.

### `dblink` (legacy alternative)

Pre-FDW PG-to-PG mechanism. Function-based, not catalog-based — no foreign tables, no planner integration, no pushdown. Still useful for: ad-hoc cross-cluster queries, fire-and-forget DDL replication, sending NOTIFY to another cluster.

```sql
CREATE EXTENSION dblink;

SELECT * FROM dblink(
    'host=remote dbname=mydb user=app',
    'SELECT order_id, total FROM orders WHERE created_at > now() - interval ''1 hour'''
) AS t (order_id bigint, total numeric);
```

Function catalog (PG16 verbatim):

| Function | Purpose |
|---|---|
| `dblink_connect(connname, connstr)` | Open named persistent connection |
| `dblink_connect_u(...)` | Same but as superuser (auth bypass — managed envs block) |
| `dblink_disconnect(connname)` | Close named connection |
| `dblink(connstr, sql) → record` | Open conn, execute, return rows, close |
| `dblink_exec(connstr, sql) → text` | Execute statement, return command tag (no rows) |
| `dblink_open(connname, cursorname, sql)` | Open server-side cursor |
| `dblink_fetch(connname, cursorname, n)` | Fetch N rows |
| `dblink_close(connname, cursorname)` | Close cursor |
| `dblink_get_connections() → text[]` | List open named connections |
| `dblink_error_message(connname)` | Last error from connection |
| `dblink_send_query(connname, sql)` | Async fire-and-return |
| `dblink_is_busy(connname)` | Check async-query state |
| `dblink_get_notify(connname)` | Receive NOTIFY messages from async conn |
| `dblink_get_result(connname)` | Reap async-query result |
| `dblink_cancel_query(connname)` | Cancel in-flight async query |
| `dblink_get_pkey(relname)` | Inspect remote PK columns (helper for builder funcs) |
| `dblink_build_sql_insert/update/delete` | DML-text builders |

> [!NOTE] PostgreSQL 17
> Verbatim: *"Allow dblink database operations to be interrupted (Noah Misch)"* + *"Custom wait events have been added to postgres_fdw and dblink"*. Pre-PG17 a hung `dblink` was uncancellable by `Ctrl-C`.

> [!NOTE] PostgreSQL 18
> Verbatim: *"Allow SCRAM authentication from the client to be passed to dblink servers (Matheus Alcantara)"*. Same SCRAM passthrough mechanism as `postgres_fdw`.

Recommend: use `postgres_fdw` for new code. Keep `dblink` for narrow async-query / fire-and-forget patterns.

### FDW C-API (writing a wrapper)

Documented in `fdwhandler.html`. Author writes a C handler function returning a `FdwRoutine` struct populated with callback function pointers. Compile as shared library, install via `CREATE EXTENSION`.

Callback function categories:

**Scanning (required):**

- `GetForeignRelSize` — size estimate
- `GetForeignPaths` — candidate access paths
- `GetForeignPlan` — chosen plan as `ForeignScan` node
- `BeginForeignScan` — runtime init
- `IterateForeignScan` — fetch next tuple
- `ReScanForeignScan` — restart scan (rewind)
- `EndForeignScan` — runtime teardown

**Updates (optional, since PG9.3):**

- `AddForeignUpdateTargets`
- `PlanForeignModify`
- `BeginForeignModify`
- `ExecForeignInsert`
- `ExecForeignBatchInsert` (PG14+)
- `GetForeignModifyBatchSize` (PG14+)
- `ExecForeignUpdate`
- `ExecForeignDelete`
- `EndForeignModify`

**TRUNCATE (PG14+):**

- `ExecForeignTruncate`

**Joins (since PG9.5):**

- `GetForeignJoinPaths`

**Upper-level pushdown (since PG10):**

- `GetForeignUpperPaths` — aggregates, grouping, ORDER BY/LIMIT, DISTINCT, window functions

**Async execution (PG14+):**

- `IsForeignScanParallelSafe`
- `EstimateDSMForeignScan` / `InitializeDSMForeignScan`
- `ShutdownForeignScan`
- `ForeignAsyncRequest` / `ForeignAsyncConfigureWait` / `ForeignAsyncNotify`

**EXPLAIN:**

- `ExplainForeignScan`
- `ExplainForeignModify`

**ANALYZE:**

- `AnalyzeForeignTable`
- `ImportForeignSchema`

For deeper internals see [`72-extension-development.md`](./72-extension-development.md).

## Per-version timeline

| Version | FDW changes |
|---|---|
| **PG14** | Bulk INSERT (`batch_size`), `IMPORT FOREIGN SCHEMA ... LIMIT TO` with partitions, `keep_connections`, connection reestablish, async-append (`async_capable`), `TRUNCATE` on foreign tables, `postgres_fdw_get_connections()` |
| **PG15** | `parallel_commit`, `postgres_fdw.application_name` GUC, parallel foreign-table scans broader cases, pushdown `CASE` expressions |
| **PG16** | `parallel_abort`, `COPY` to foreign tables in batches (`batch_size`), `analyze_sampling` option, interrupt handling during connection establishment |
| **PG17** | `EXISTS`/`IN` subquery pushdown, non-join-qualification pushdown, default `fdw_tuple_cost` raised from `0.01` to `0.2`, custom wait events for `postgres_fdw`/`dblink`, `dblink` operations interruptible |
| **PG18** | SCRAM passthrough (`use_scram_passthrough`), `postgres_fdw_get_connections()` new columns (`used_in_xact`, `closed`, `user_name`, `remote_backend_pid`), `import_collate`/`import_default`/`import_generated`/`import_not_null` server-level, `file_fdw` `on_error` + `log_verbosity` + `reject_limit`, `dblink` SCRAM passthrough |

## Examples / Recipes

### Recipe 1: baseline `postgres_fdw` for PG-to-PG federation

```sql
-- One-time install + setup
CREATE EXTENSION postgres_fdw;

CREATE SERVER analytics_db
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (
        host 'analytics.internal',
        port '5432',
        dbname 'analytics',
        sslmode 'verify-full',
        sslrootcert '/etc/postgresql/ca.pem',
        use_remote_estimate 'true',
        fetch_size '1000',
        batch_size '500',
        async_capable 'true',
        keep_connections 'on'
    );

CREATE USER MAPPING FOR app_user
    SERVER analytics_db
    OPTIONS (user 'fdw_reader', use_scram_passthrough 'true');  -- PG18+

-- Import all tables from remote schema
IMPORT FOREIGN SCHEMA reporting
    FROM SERVER analytics_db
    INTO local_reporting;

-- Sample query
SELECT customer_id, sum(total) AS lifetime_value
FROM local_reporting.orders
WHERE created_at >= now() - interval '30 days'
GROUP BY customer_id;
```

### Recipe 2: verify pushdown via EXPLAIN VERBOSE

```sql
EXPLAIN (VERBOSE, COSTS OFF, FORMAT TEXT)
    SELECT customer_id, count(*)
    FROM orders_remote
    WHERE created_at >= '2026-01-01'
    GROUP BY customer_id
    ORDER BY count(*) DESC
    LIMIT 10;
```

Expected output (pushdown working):

```
Limit
  Output: customer_id, (count(*))
  ->  Sort
        Sort Key: (count(*)) DESC
        ->  Foreign Scan
              Output: customer_id, (count(*))
              Relations: Aggregate on (orders_remote)
              Remote SQL: SELECT customer_id, count(*) FROM public.orders
                          WHERE ((created_at >= '2026-01-01'::date))
                          GROUP BY customer_id
```

If `Remote SQL` shows only `SELECT * FROM public.orders` with no WHERE / GROUP BY, run:

```sql
ALTER FOREIGN TABLE orders_remote OPTIONS (SET use_remote_estimate 'true');
ANALYZE orders_remote;  -- alternative / complement
```

### Recipe 3: bulk migration with batched INSERT

```sql
-- One-time, single big transaction
BEGIN;
SET LOCAL statement_timeout = 0;

INSERT INTO local_orders (order_id, customer_id, total, created_at)
SELECT order_id, customer_id, total, created_at
FROM orders_remote
WHERE created_at >= '2026-01-01';

ANALYZE local_orders;
COMMIT;
```

With `batch_size=1000` on the foreign table the remote roundtrips drop dramatically. Watch `pg_stat_activity` on remote for the actual SQL — should see batched INSERTs or COPY-style streaming.

### Recipe 4: federated query across two remote clusters

```sql
CREATE SERVER analytics_east FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'east.internal', dbname 'analytics', async_capable 'true');

CREATE SERVER analytics_west FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'west.internal', dbname 'analytics', async_capable 'true');

CREATE USER MAPPING FOR CURRENT_USER SERVER analytics_east OPTIONS (...);
CREATE USER MAPPING FOR CURRENT_USER SERVER analytics_west OPTIONS (...);

IMPORT FOREIGN SCHEMA public LIMIT TO (orders) FROM SERVER analytics_east INTO east;
IMPORT FOREIGN SCHEMA public LIMIT TO (orders) FROM SERVER analytics_west INTO west;

CREATE VIEW orders_all AS
    SELECT 'east' AS region, * FROM east.orders
    UNION ALL
    SELECT 'west' AS region, * FROM west.orders;

-- The Append node fires both child scans in parallel (PG14+ async)
SELECT region, count(*) FROM orders_all WHERE created_at >= now() - interval '1 day' GROUP BY region;
```

### Recipe 5: `file_fdw` for CSV-as-table on PG18+

```sql
CREATE EXTENSION file_fdw;
CREATE SERVER files FOREIGN DATA WRAPPER file_fdw;

CREATE FOREIGN TABLE imports.access_log (
    ts timestamptz, user_id bigint, path text, status int
) SERVER files OPTIONS (
    filename '/var/imports/access-2026-05-13.csv',
    format 'csv',
    header 'true',
    on_error 'ignore',        -- PG18+ skip malformed rows
    reject_limit '1000',      -- PG18+ abort if > 1000 bad rows
    log_verbosity 'verbose'   -- PG18+ log each error
);

SELECT count(*) AS errors FROM imports.access_log WHERE status >= 500;
```

### Recipe 6: audit installed FDW objects

```sql
-- All servers + their wrappers
SELECT
    s.srvname  AS server_name,
    w.fdwname  AS wrapper_name,
    s.srvtype, s.srvversion,
    s.srvoptions,
    array_agg(DISTINCT um.umuser::regrole) AS mapped_roles
FROM pg_foreign_server s
JOIN pg_foreign_data_wrapper w ON w.oid = s.srvfdw
LEFT JOIN pg_user_mapping um ON um.umserver = s.oid
GROUP BY s.srvname, w.fdwname, s.srvtype, s.srvversion, s.srvoptions
ORDER BY w.fdwname, s.srvname;

-- All foreign tables + their server
SELECT
    ft.foreign_table_schema,
    ft.foreign_table_name,
    ft.foreign_server_name,
    fto.option_name,
    fto.option_value
FROM information_schema.foreign_tables ft
LEFT JOIN information_schema.foreign_table_options fto USING (foreign_table_schema, foreign_table_name)
ORDER BY 1, 2, 4;
```

### Recipe 7: monitor `postgres_fdw` connections

```sql
-- Local side: what conns am I holding open?
SELECT * FROM postgres_fdw_get_connections();

-- PG18+ with extra columns
SELECT server_name, used_in_xact, closed, user_name, remote_backend_pid
FROM postgres_fdw_get_connections();

-- Remote side: who is connecting from FDW backends?
SELECT pid, application_name, client_addr, state, query_start, query
FROM pg_stat_activity
WHERE application_name LIKE 'postgres_fdw%'
   OR application_name LIKE 'fdw-%'
ORDER BY query_start;
```

### Recipe 8: drop foreign object cleanly

```sql
-- Reverse-order drop
DROP FOREIGN TABLE local.orders_remote;
DROP USER MAPPING FOR app_user SERVER remote_db;
DROP SERVER remote_db;
-- Optional: DROP EXTENSION postgres_fdw;  -- only if no other servers use it

-- Or CASCADE (drops dependent foreign tables + mappings)
DROP SERVER remote_db CASCADE;
```

### Recipe 9: per-table override for use_remote_estimate

```sql
-- Default OFF on server (cheap planning for many small tables)
ALTER SERVER remote_db OPTIONS (SET use_remote_estimate 'false');

-- ON for big tables only (better plans worth the planning RTT)
ALTER FOREIGN TABLE orders_remote OPTIONS (ADD use_remote_estimate 'true');
ALTER FOREIGN TABLE events_remote OPTIONS (ADD use_remote_estimate 'true');
```

### Recipe 10: SCRAM passthrough for password-less FDW (PG18+)

```sql
-- Remote pg_hba.conf must allow scram-sha-256 from local cluster's IP
-- Local pg_hba.conf must require scram-sha-256 from client

CREATE USER MAPPING FOR app_user SERVER remote_db OPTIONS (
    user 'app_user_remote',
    use_scram_passthrough 'true'
);

-- No password stored locally. Client must auth via SCRAM to local for this to work.
```

### Recipe 11: `dblink` fire-and-forget async query

```sql
-- Send query without waiting
SELECT dblink_connect('async_conn', 'host=remote dbname=mydb user=app');
SELECT dblink_send_query('async_conn', 'REFRESH MATERIALIZED VIEW CONCURRENTLY heavy_view');

-- Poll later
SELECT dblink_is_busy('async_conn');

-- Reap result when done
SELECT dblink_get_result('async_conn');
SELECT dblink_disconnect('async_conn');
```

### Recipe 12: import foreign schema selectively

```sql
-- Import only specific tables
IMPORT FOREIGN SCHEMA public LIMIT TO (orders, customers, products)
    FROM SERVER remote_db INTO remote;

-- Import everything except a few
IMPORT FOREIGN SCHEMA public EXCEPT (audit_log, sessions)
    FROM SERVER remote_db INTO remote;

-- Import with custom options (PG18+)
IMPORT FOREIGN SCHEMA public FROM SERVER remote_db INTO remote
    OPTIONS (import_default 'true', import_not_null 'true');
```

### Recipe 13: refresh remote-table definition after remote DDL

```sql
-- Remote added a column. Foreign table definition is stale.
DROP FOREIGN TABLE orders_remote;
IMPORT FOREIGN SCHEMA public LIMIT TO (orders) FROM SERVER remote_db INTO local;

-- Or hand-add the column without dropping
ALTER FOREIGN TABLE orders_remote ADD COLUMN currency text;
```

### Recipe 14: diagnose stuck FDW backend

```sql
-- Local side: backends waiting on FDW
SELECT pid, state, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND wait_event LIKE '%fdw%';  -- PG17+ custom wait events

-- Remote side: find the backend originating from local FDW
-- Match remote_backend_pid from postgres_fdw_get_connections() PG18+
SELECT pid, state, query_start, query
FROM pg_stat_activity
WHERE pid = <remote_backend_pid>;

-- Cancel local query — FDW backend interrupted in PG17+ for dblink, postgres_fdw always
SELECT pg_cancel_backend(<local_pid>);
```

## Gotchas / Anti-patterns

1. **Pushdown is opt-in.** Without `use_remote_estimate=true` (or recent `ANALYZE`) planner assumes 1 row from foreign table and picks NestedLoop with foreign as inner. Catastrophic on big remote tables. Always check `EXPLAIN VERBOSE` `Remote SQL:` line.

2. **Volatile functions block pushdown.** `WHERE col = random_uuid()` won't push the predicate. Volatile-marked functions stay local even if the value is constant for the query.

3. **`use_remote_estimate` adds planning RTT.** Per-query overhead = round-trip to remote + remote EXPLAIN cost. Acceptable for analytic queries (~ms vs minutes of execution). Catastrophic for high-frequency OLTP.

4. **No automatic 2PC.** `BEGIN; ... INSERT INTO foreign_t ...; ... COMMIT;` is best-effort across servers. If remote commit fails after local, no auto-rollback. PG15+ `parallel_commit` just concurrent — not atomic.

5. **`keep_connections=on` (default PG14+) pins idle connections on remote.** Watch `idle_in_transaction_session_timeout` on remote — may kill your FDW conn mid-transaction.

6. **`batch_size` only applies to INSERT.** UPDATE/DELETE go one row at a time. `RETURNING` clauses may force `batch_size=1`.

7. **Foreign tables ignore most constraints.** `PRIMARY KEY` / `UNIQUE` / `FOREIGN KEY` / `CHECK` declared on foreign table are planner hints only — not enforced. Verify constraints live on remote.

8. **`IMPORT FOREIGN SCHEMA` is one-shot.** No re-import / merge mode. To refresh after remote DDL, drop and re-import the affected tables.

9. **`file_fdw` requires server-side filesystem access.** Role needs `pg_read_server_files` (or superuser). Managed environments usually deny this.

10. **`dblink_connect_u` is `_u` for unauth.** Bypasses pg_hba's authentication for the role — superuser only on PG10+. Forbidden in managed envs. Use `dblink_connect` (which requires you've configured authentication).

11. **`postgres_fdw` doesn't share connections across roles.** Each (local_role, server) pair gets its own pinned connection. Long pg_stat_activity tails on remote when many roles use FDW.

12. **Statement-level FOR UPDATE / FOR SHARE not pushed down.** Per docs: row locks taken on foreign tables are local-only — they don't lock the remote rows. Real lock-aware federation needs application-level coordination.

13. **`TRUNCATE` requires `truncatable=true`** on foreign table (default true since PG14). Pre-PG14 there is no `TRUNCATE` for foreign tables — `DELETE FROM foreign_t` instead (much slower).

14. **`fdw_tuple_cost` default rose in PG17** from 0.01 to 0.2. Plans that worked on PG16 may regress after pg_upgrade — planner becomes more conservative about pushing many tuples. Audit `EXPLAIN VERBOSE` after upgrade.

15. **Async append (`async_capable`) is server-or-table opt-in, not automatic.** Set it explicitly on the SERVER or FOREIGN TABLE. Default off pre-PG14, default off in PG14+ too.

16. **Custom wait events PG17+.** Pre-PG17 a stuck FDW backend appeared as `wait_event=null` — looked like CPU. PG17 + custom-wait-events makes `pg_stat_activity` show `wait_event='libpqsrv:wait_for_connect'` etc. Update monitoring queries.

17. **`postgres_fdw.application_name` GUC (PG15+)** lets you set the app name remote sees. Default = local cluster's PID. Set per session: `SET postgres_fdw.application_name = 'reporter-job-42';`. Helps when grepping remote `pg_stat_activity`.

18. **Foreign tables in partitioned hierarchies inherit constraints.** Partition-key constraint on parent applies to foreign partition — but is enforced by *planner pruning*, not by remote storage. Bad data on remote isn't rejected; it just may be invisible to constraint-aware queries.

19. **`postgres_fdw` does not propagate `LOCAL` GUCs.** `SET LOCAL work_mem='1GB'` on local backend does NOT affect remote. Tune remote GUCs explicitly via `SET options` on the SERVER or `options=-c work_mem=1GB` in the conninfo.

20. **`extensions` SERVER option lets pushdown of immutable funcs from those extensions.** `OPTIONS (extensions 'pg_trgm,intarray')` adds `pg_trgm` and `intarray` immutable functions to the pushdown-safe whitelist. Without it `similarity('a', 'b')` won't push.

21. **`dblink_connect` named connections live only inside the current session.** Disconnect on backend exit — but if your backend lingers due to connection pooling, the `dblink` conn stays open and consumes a slot on remote.

22. **`SCRAM passthrough` requires SCRAM at both ends.** If local client uses `md5` or `password` auth, passthrough fails. Audit `pg_hba.conf` on both sides before flipping `use_scram_passthrough=true`.

23. **No DDL replication via FDW.** `ALTER TABLE foreign_t ADD COLUMN ...` works ONLY on the foreign-table definition locally — does not run on remote. Real DDL replication needs logical replication or external tooling (see [`74-logical-replication.md`](./74-logical-replication.md)).

## See Also

- [`08-plpgsql.md`](./08-plpgsql.md) — building blocks for FDW-using procedures
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — FDW uses cursors internally; `fetch_size` controls cursor batch
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — `analyze_sampling` for foreign tables, ANALYZE of foreign tables
- [`33-wal.md`](./33-wal.md) — foreign-table writes are NOT WAL-logged on local; only remote logs them
- [`41-transactions.md`](./41-transactions.md) — best-effort cross-server transactions, no auto 2PC
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `USAGE ON FOREIGN SERVER` grants, `pg_read_server_files` for file_fdw
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — SCRAM passthrough setup
- [`49-tls-ssl.md`](./49-tls-ssl.md) — `sslmode`/`sslrootcert` on the SERVER OPTIONS
- [`55-statistics-planner.md`](./55-statistics-planner.md) — `use_remote_estimate` vs `ANALYZE foreign_table`
- [`56-explain.md`](./56-explain.md) — reading `Foreign Scan` / `Async Foreign Scan` plan nodes
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity` custom wait events PG17+
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_foreign_server`, `pg_foreign_data_wrapper`, `pg_foreign_table`, `pg_user_mapping`
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — `file_fdw` `on_error`/`reject_limit` PG18+ shares semantics with COPY
- [`69-extensions.md`](./69-extensions.md) — `postgres_fdw`/`file_fdw`/`dblink` are trusted contrib extensions
- [`72-extension-development.md`](./72-extension-development.md) — writing custom FDW (C-API)
- [`74-logical-replication.md`](./74-logical-replication.md) — proper PG-to-PG replication
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — pg_dump as alternative for PG-to-PG data migration (Decision Matrix)
- [`63-internals-architecture.md`](./63-internals-architecture.md) — FDW worker processes and background worker pool
- [`97-citus.md`](./97-citus.md) — distributed PG (sharding) vs federation
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — `file_fdw` / `dblink_connect_u` typically blocked

## Sources

[^ddl-fd]: PostgreSQL 16 Documentation — Foreign Data. https://www.postgresql.org/docs/16/ddl-foreign-data.html
[^cre-fdw]: PostgreSQL 16 Documentation — `CREATE FOREIGN DATA WRAPPER`. https://www.postgresql.org/docs/16/sql-createforeigndatawrapper.html
[^cre-srv]: PostgreSQL 16 Documentation — `CREATE SERVER`. https://www.postgresql.org/docs/16/sql-createserver.html
[^cre-um]: PostgreSQL 16 Documentation — `CREATE USER MAPPING`. https://www.postgresql.org/docs/16/sql-createusermapping.html
[^cre-ft]: PostgreSQL 16 Documentation — `CREATE FOREIGN TABLE`. https://www.postgresql.org/docs/16/sql-createforeigntable.html
[^imp-fs]: PostgreSQL 16 Documentation — `IMPORT FOREIGN SCHEMA`. https://www.postgresql.org/docs/16/sql-importforeignschema.html
[^pg-fdw-16]: PostgreSQL 16 Documentation — `postgres_fdw`. https://www.postgresql.org/docs/16/postgres-fdw.html
[^pg-fdw-17]: PostgreSQL 17 Documentation — `postgres_fdw`. https://www.postgresql.org/docs/17/postgres-fdw.html
[^pg-fdw-18]: PostgreSQL 18 Documentation — `postgres_fdw`. https://www.postgresql.org/docs/18/postgres-fdw.html
[^file-fdw]: PostgreSQL 16 Documentation — `file_fdw`. https://www.postgresql.org/docs/16/file-fdw.html
[^dblink]: PostgreSQL 16 Documentation — `dblink`. https://www.postgresql.org/docs/16/dblink.html
[^fdw-handler]: PostgreSQL 16 Documentation — Writing a Foreign Data Wrapper. https://www.postgresql.org/docs/16/fdwhandler.html
[^pg14-batch]: PG14 release notes — *"Allow postgres_fdw to INSERT rows in bulk (Takayuki Tsunakawa, Tomas Vondra, Amit Langote)"*. https://www.postgresql.org/docs/release/14.0/
[^pg14-partimp]: PG14 release notes — *"Allow postgres_fdw to import table partitions if specified by IMPORT FOREIGN SCHEMA ... LIMIT TO (Matthias van de Meent)"*. https://www.postgresql.org/docs/release/14.0/
[^pg14-keepconn]: PG14 release notes — *"Allow control over whether foreign servers keep connections open after transaction completion (Bharath Rupireddy). This is controlled by keep_connections and defaults to on."*. https://www.postgresql.org/docs/release/14.0/
[^pg14-async]: PG14 release notes — *"Allow a query referencing multiple foreign tables to perform foreign table scans in parallel (Robert Haas, Kyotaro Horiguchi, Thomas Munro, Etsuro Fujita). postgres_fdw supports this type of scan if async_capable is set."*. https://www.postgresql.org/docs/release/14.0/
[^pg14-truncate]: PG14 release notes — *"Allow TRUNCATE to operate on foreign tables (Kazutaka Onishi, Kohei KaiGai). The postgres_fdw module also now supports this."*. https://www.postgresql.org/docs/release/14.0/
[^pg14-getconn]: PG14 release notes — *"Add postgres_fdw function postgres_fdw_get_connections() to report open foreign server connections (Bharath Rupireddy)"*. https://www.postgresql.org/docs/release/14.0/
[^pg15-pc]: PG15 release notes — *"Allow parallel commit on postgres_fdw servers (Etsuro Fujita). This is enabled with the CREATE SERVER option parallel_commit."*. https://www.postgresql.org/docs/release/15.0/
[^pg15-app]: PG15 release notes — *"Add server variable postgres_fdw.application_name to control the application name of postgres_fdw connections (Hayato Kuroda)"*. https://www.postgresql.org/docs/release/15.0/
[^pg15-case]: PG15 release notes — *"Allow postgres_fdw to push down CASE expressions (Alexander Pyhalov)"*. https://www.postgresql.org/docs/release/15.0/
[^pg15-async2]: PG15 release notes — *"Allow a query referencing multiple foreign tables to perform parallel foreign table scans in more cases (Andrey Lepikhov, Etsuro Fujita)"*. https://www.postgresql.org/docs/release/15.0/
[^pg16-copy]: PG16 release notes — *"Allow COPY into foreign tables to add rows in batches (Andrey Lepikhov, Etsuro Fujita). This is controlled by the postgres_fdw option batch_size."*. https://www.postgresql.org/docs/release/16.0/
[^pg16-pa]: PG16 release notes — *"Allow postgres_fdw to do aborts in parallel (Etsuro Fujita). This is enabled with postgres_fdw option parallel_abort."*. https://www.postgresql.org/docs/release/16.0/
[^pg16-analyze]: PG16 release notes — *"Make ANALYZE on foreign postgres_fdw tables more efficient (Tomas Vondra). The postgres_fdw option analyze_sampling controls the sampling method."*. https://www.postgresql.org/docs/release/16.0/
[^pg16-interrupt]: PG16 release notes — *"Have postgres_fdw and dblink handle interrupts during connection establishment (Andres Freund)"*. https://www.postgresql.org/docs/release/16.0/
[^pg17-subq]: PG17 release notes — *"Allow pushdown of EXISTS and IN subqueries to postgres_fdw foreign servers (Alexander Pyhalov)"*. https://www.postgresql.org/docs/release/17.0/
[^pg17-cost]: PG17 release notes — *"Increase the default foreign data wrapper tuple cost (David Rowley, Umair Shahid)"*. https://www.postgresql.org/docs/release/17.0/
[^pg17-wait]: PG17 release notes — *"Custom wait events have been added to postgres_fdw and dblink"*. https://www.postgresql.org/docs/release/17.0/
[^pg17-dblink-int]: PG17 release notes — *"Allow dblink database operations to be interrupted (Noah Misch)"*. https://www.postgresql.org/docs/release/17.0/
[^pg18-scram]: PG18 release notes — *"Allow SCRAM authentication from the client to be passed to postgres_fdw servers (Matheus Alcantara, Peter Eisentraut). This avoids storing postgres_fdw authentication information in the database, and is enabled with the postgres_fdw use_scram_passthrough connection option."*. https://www.postgresql.org/docs/release/18.0/
[^pg18-conn]: PG18 release notes — *"Add output columns to postgres_fdw_get_connections() (Hayato Kuroda, Sagar Dilip Shedge). New output column used_in_xact indicates if the foreign data wrapper is being used by a current transaction, closed indicates if it is closed, user_name indicates the user name, and remote_backend_pid indicates the remote backend process identifier."*. https://www.postgresql.org/docs/release/18.0/
[^pg18-onerror]: PG18 release notes — *"Add on_error and log_verbosity options to file_fdw (Atsushi Torikoshi). These control how file_fdw handles and reports invalid file rows."*. https://www.postgresql.org/docs/release/18.0/
[^pg18-reject]: PG18 release notes — *"Add reject_limit to control the number of invalid rows file_fdw can ignore (Atsushi Torikoshi). This is active when ON_ERROR = 'ignore'."*. https://www.postgresql.org/docs/release/18.0/
[^pg18-dblink-scram]: PG18 release notes — *"Allow SCRAM authentication from the client to be passed to dblink servers (Matheus Alcantara)"*. https://www.postgresql.org/docs/release/18.0/

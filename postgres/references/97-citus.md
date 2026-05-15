# Citus

Citus = open-source extension turning PostgreSQL into a distributed database. Adds **coordinator + worker** topology, **distributed tables** (sharded by hash on a chosen column), **reference tables** (replicated everywhere), **columnar storage**, and (since Citus 12) **schema-based sharding** for multi-tenant SaaS. Microsoft-maintained since 2019 acquisition, still Apache-2.0, still open source. Wholly external extension — versioned independently of PostgreSQL.[^1]

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [Architecture](#architecture)
  - [Three Table Classes](#three-table-classes)
  - [Distribution Column](#distribution-column)
  - [Co-location](#co-location)
  - [Schema-Based Sharding (Citus 12+)](#schema-based-sharding-citus-12)
  - [Reference Tables](#reference-tables)
  - [Distributed Functions](#distributed-functions)
  - [Columnar Storage](#columnar-storage)
  - [Shard Rebalancer](#shard-rebalancer)
  - [HA / Failover](#ha--failover)
  - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

When single-node Postgres has hit a wall on **write throughput**, **dataset size > one machine's RAM × 10**, or **multi-tenant scale-out**. Citus is the canonical Postgres-sharding extension. For time-series single-node see [`96-timescaledb.md`](./96-timescaledb.md). For native single-node partitioning see [`35-partitioning.md`](./35-partitioning.md). For HA-without-sharding see [`78-ha-architectures.md`](./78-ha-architectures.md). For FDW-based federation (lighter than Citus, different shape) see [`70-fdw.md`](./70-fdw.md). For connection pooling across many nodes see [`81-pgbouncer.md`](./81-pgbouncer.md).

## Mental Model

Five rules:

1. **Citus is THE distributed-Postgres extension.** Wholly external, versioned independently. Latest stable **Citus 14.0** released 2026-02-17 — supports through PG **18.1**. Apache-2.0 throughout (no license split like TimescaleDB). Microsoft acquired Citus Data in 2019 but the extension stayed open source and provider-agnostic. **Zero Citus items in PG14/15/16/17/18 release notes** — Citus evolves on its own cadence.[^2][^16]

2. **Coordinator + workers, not a quorum.** One coordinator node (also a Postgres instance with Citus loaded) stores **metadata** about shard placement. N worker nodes store the **shard data** itself (shards = regular Postgres tables named like `events_102008`). Coordinator routes queries; workers do work. Coordinator is single-point-of-config but not single-point-of-data — replace via metadata-restore + failover.

3. **Three table classes, choose deliberately per table.** **Distributed** (hash-sharded by a column, lives on workers, N shards spread across them), **reference** (one shard replicated on every worker for joins / lookups), **local** (only on coordinator — small admin tables, sequences, audit). Choice between distributed vs reference vs local dominates query performance more than any tuning knob.[^3][^4]

4. **Distribution-column choice is irreversible (online) and dominates joins.** Tables sharded on the same distribution column with the same shard count + colocation group are **co-located** — joins on the distribution column stay on one worker. Distribution columns that don't match across tables force network shuffles. Pick distribution column to match your dominant join key, not your primary key.[^5]

5. **Schema-based sharding (Citus 12+) trades cross-tenant joins for zero data-model change.** `SELECT citus_schema_distribute('tenant_42')` makes that schema's tables co-located on a single worker, no `distributed_column` needed. Verbatim docs: "Schema-based sharding means that tables from the same schema are placed on the same node, while different schemas may be on different nodes." Limitation: "joins and foreign keys should only involve tables from the same schema."[^11]

> [!WARNING] Citus is NOT in core PostgreSQL
> External extension. `shared_preload_libraries = 'citus'` + restart + `CREATE EXTENSION citus`. Most managed providers do **not** offer Citus on plain PG instances — Microsoft offers it on their managed product, third-party providers vary. Self-host runs anywhere with Apache-2.0 license. PG14/15/16/17/18 release notes contain **zero** Citus items — version Citus by its own version, not by PG major.

> [!WARNING] Cross-shard transactions and DDL have sharp edges
> Distributed transactions use **2PC** across workers, so `max_prepared_transactions` must be raised on every node (typically `2 * max_connections`). DDL on distributed tables propagates from coordinator to workers — but slow, locking, and partial-failure during DDL leaves drift. Use `citus.multi_shard_modify_mode`, plan DDL windows like a real migration.

## Decision Matrix

| Use case | Tool / pattern | Rationale |
|---|---|---|
| Single-node Postgres + 16 TB headroom + simple workload | Stay single-node | Sharding overhead not yet justified — coordinator round-trips + 2PC cost |
| OLTP at write rate exceeding single-machine NVMe | **Distributed table** + 4-16 workers | Hash-shard on entity ID; reads colocate on one worker, inserts spread |
| Multi-tenant SaaS (clear tenant_id everywhere) | **Distributed table** + `tenant_id` distribution column + colocation group | Per-tenant queries hit one shard; cross-tenant joins disallowed by design |
| Multi-tenant SaaS but tenants don't share schema cleanly | **Schema-based sharding** (Citus 12+) | `CREATE SCHEMA tenant_42` + `citus_schema_distribute('tenant_42')` — no app changes |
| Small lookup tables joined to many distributed tables | **Reference table** | Replicated on every worker, joins are local on each worker |
| Coordinator-only admin / audit / sequences | **Local table** (default) | Don't distribute; living on coordinator avoids broadcast overhead |
| Analytical scans over giant tables | **Columnar storage** + distributed table | Citus columnar (USING columnar) gives 3-10× compression + parallel scans |
| Need ACID across shards | **Citus 2PC** (default) | `max_prepared_transactions = 2 × max_connections` on every node, raise it before going to prod |
| Add a worker / rebalance shards | `citus_rebalance_start()` (Citus 11+) | Online, background, throttleable; old `master_rebalance_shards` deprecated |
| Distributed table needs a query that doesn't filter on distribution column | Avoid if hot — broadcasts every shard | Plan returns "broadcast" — every worker scans, results union on coordinator |
| Need PG-native sharding (no extension) | **Native partitioning + FDW** | Manual sharding via partition-per-tenant + postgres_fdw — much more limited; useful for federation, not for true scale-out |
| Need TimescaleDB on Citus | **TimescaleDB + Citus together is unsupported** | TimescaleDB multi-node was deprecated in TimescaleDB 2.14 (cross-ref [96](./96-timescaledb.md)). Pick one |
| Need columnar + transactional in same table | **Hot/cold partitioning** | Recent partition rowstore, archive partitions columnar |

Smell signals:

- **Slow queries with EXPLAIN showing "broadcast" or "repartition"** — distribution column wrong for that query, or join key not co-located.
- **Frequent cross-shard `UPDATE` / `DELETE`** — wrong shape, design hits 2PC every commit. Re-think distribution column.
- **Manual `INSERT` into individual shard tables** — never do this. Always go through coordinator. Direct-worker writes corrupt metadata.

## Syntax / Mechanics

### Architecture

Three node roles:

| Role | Process | What's stored |
|---|---|---|
| **Coordinator** | Postgres + Citus extension | Metadata catalog (`pg_dist_*`), routes queries to workers, runs distributed planner |
| **Worker** | Postgres + Citus extension | Actual shards (regular tables named `events_102008`, `events_102009`, ...) |
| **(Optional) Read replica** | Streaming-replication standby per node | Each Citus node can have its own PG streaming standby — see [73](./73-streaming-replication.md) |

ASCII topology:

```
              ┌──────────────────────────────┐
              │       Coordinator (PG18)     │
              │   citus extension loaded     │
              │   pg_dist_partition table    │   ← metadata
              │   query routing + planning   │
              └──────────────┬───────────────┘
                             │ libpq
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Worker 1     │    │  Worker 2     │    │  Worker N     │
│ events_102008 │    │ events_102009 │    │ events_102015 │
│ events_102016 │    │ events_102017 │    │ events_102023 │
│ ref_tbl       │    │ ref_tbl       │    │ ref_tbl       │
└───────────────┘    └───────────────┘    └───────────────┘
```

Add a worker:

```sql
-- Run on coordinator
SELECT citus_add_node('worker-4.internal', 5432);
SELECT citus_rebalance_start();  -- background rebalance
```

Inspect cluster:

```sql
SELECT * FROM pg_dist_node;        -- which nodes are workers
SELECT * FROM citus_get_active_worker_nodes();
SELECT * FROM citus_tables;        -- which tables are distributed
SELECT * FROM citus_shards;        -- shard-to-worker placement
```

### Three Table Classes

| Class | Function | Lives on | When to pick |
|---|---|---|---|
| **Distributed** | `create_distributed_table('events', 'tenant_id')` | Sharded across workers | Big append/update workload, partition key dominates query filters |
| **Reference** | `create_reference_table('countries')` | One shard replicated on every worker + coordinator | Small lookup / dimension tables joined into many distributed tables |
| **Local** | (default — do nothing) | Coordinator only | Sequences, admin / audit tables, small singletons |

Verbatim docs on reference tables:[^4]

> "A reference table is a type of distributed table whose entire contents are concentrated into a single shard which is replicated on every worker."

> "The `create_reference_table()` function is used to define a small reference or dimension table. This function takes in a table name, and creates a distributed table with just one shard, replicated to every worker node."

### Distribution Column

`create_distributed_table(table_name, distribution_column, [distribution_method := 'hash'], [colocate_with := 'default'])`:

```sql
-- Distribute events table by tenant_id (the dominant filter / join key)
SELECT create_distributed_table('events', 'tenant_id');

-- Distribute users by tenant_id, colocate with events
SELECT create_distributed_table('users', 'tenant_id', colocate_with => 'events');
```

Rules:

- Distribution column must be `NOT NULL` and immutable per row (PK or stable identifier).
- Picked from **dominant join key** + **dominant filter column** + **column with even cardinality** — bias toward join key wins ties.
- **Cannot change distribution column online.** Requires drop + recreate (or `citus_split_shard_by_split_points` for re-sharding).
- Hash partitioning: `hash(distribution_column) mod shard_count` chooses shard. Default `citus.shard_count = 32`.
- `SELECT alter_distributed_table('events', shard_count => 64)` re-shards online (Citus 11+).

### Co-location

Verbatim docs:[^5]

> "Co-location is the practice of dividing data tactically, where one keeps related information on the same machines to enable efficient relational operations"

> "Data co-location is a powerful technique for providing both horizontal scale and support to relational data models."

Co-location groups: tables sharded on the same distribution column with the same shard count + colocation group → matching shards live on the same worker. Joins on the distribution column stay local.

```sql
-- Pattern: co-locate everything by tenant_id
SELECT create_distributed_table('events',   'tenant_id');
SELECT create_distributed_table('users',    'tenant_id', colocate_with => 'events');
SELECT create_distributed_table('payments', 'tenant_id', colocate_with => 'events');

-- Verify co-location
SELECT logicalrelid, colocationid FROM pg_dist_partition WHERE logicalrelid::text IN ('events','users','payments');
```

Joins on `tenant_id` between any two of these stay on one worker. Joins on any other column require shuffle.

### Schema-Based Sharding (Citus 12+)

Released 2023-07. Verbatim Microsoft engineering blog:[^11]

> "Schema-based sharding means that tables from the same schema are placed on the same node, while different schemas may be on different nodes."

> "each tenant has a separate schema with its own set of tables, in the same database"

> Schema-based sharding has "almost no data modelling restrictions or special steps compared to unsharded PostgreSQL." Limitation: "joins and foreign keys should only involve tables from the same schema."

Use case: multi-tenant SaaS where each tenant gets its own schema and you want zero data-model change.

```sql
-- Enable on cluster
SET citus.enable_schema_based_sharding TO ON;

-- Per-tenant schema (each lands on one worker)
CREATE SCHEMA tenant_42;
SELECT citus_schema_distribute('tenant_42');

CREATE SCHEMA tenant_99;
SELECT citus_schema_distribute('tenant_99');

-- Inside schema, tables behave like normal Postgres
CREATE TABLE tenant_42.orders (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ, ...);
```

Trade-off vs row-based distribution: no cross-tenant analytics from a single query, but no distribution-column requirement on every table either. Pick row-based for analytics-heavy multi-tenant. Pick schema-based when tenants are operationally isolated and per-tenant queries dominate.

### Reference Tables

```sql
CREATE TABLE countries (
    iso2 CHAR(2) PRIMARY KEY,
    name TEXT NOT NULL
);
INSERT INTO countries VALUES ('US','United States'), ('GB','United Kingdom'), ...;

SELECT create_reference_table('countries');
```

After this, every worker has a full copy. Joins from distributed tables to `countries` stay local on each worker. Writes go through coordinator and replicate to all workers in same transaction — slow on hot writes, fine on rarely-updated dimensions.

### Distributed Functions

`create_distributed_function('fn(args)', 'distribution_arg')`: marks a function as runnable on workers, with one argument as the "distribution argument" so Citus routes the call to the right worker.

```sql
CREATE FUNCTION place_order(tenant BIGINT, payload JSONB) RETURNS BIGINT AS $$
    INSERT INTO orders(tenant_id, payload) VALUES (tenant, payload) RETURNING id;
$$ LANGUAGE SQL;

SELECT create_distributed_function('place_order(bigint,jsonb)', 'tenant', colocate_with => 'orders');
```

Calling `place_order(42, '{"amount":99}')` routes to the worker holding shard for `tenant=42` and runs entirely there — no coordinator round-trips per row. Critical pattern for write-throughput-bound workloads.

### Columnar Storage

Citus columnar = compressed, column-oriented storage for analytical scans. Per-table `USING columnar`:

```sql
CREATE TABLE events_archive (
    event_id BIGINT, ts TIMESTAMPTZ, payload JSONB
) USING columnar;
```

Properties:

- 3-10× compression typical (zstd / pglz).
- Append-only by design — `UPDATE` and `DELETE` not supported on columnar tables.
- No B-tree / GIN / GiST indexes on columnar tables. Filters use **chunk-group metadata** (min/max per ~10K-row chunk).
- Common pattern: rowstore for recent (writable), columnar for archive — combine via partitioning.

```sql
-- Hybrid: rowstore current + columnar archive
CREATE TABLE events (id BIGINT, ts TIMESTAMPTZ, payload JSONB) PARTITION BY RANGE (ts);
CREATE TABLE events_2026_05 PARTITION OF events FOR VALUES FROM ('2026-05-01') TO ('2026-06-01'); -- rowstore
CREATE TABLE events_2026_04 PARTITION OF events FOR VALUES FROM ('2026-04-01') TO ('2026-05-01') USING columnar; -- columnar

SELECT create_distributed_table('events', 'tenant_id');
```

Convert partition to columnar later: `SELECT alter_table_set_access_method('events_2026_04', 'columnar');`

### Shard Rebalancer

`citus_rebalance_start()` (Citus 11+) — background, throttled, online. Old `master_*` functions deprecated.

```sql
-- Plan a rebalance (does not execute)
SELECT * FROM get_rebalance_table_shards_plan();

-- Run in background
SELECT citus_rebalance_start();

-- Inspect progress
SELECT * FROM citus_rebalance_status();

-- Throttle via GUC
ALTER SYSTEM SET citus.rebalancer_by_disk_size_base_cost = 100;
ALTER SYSTEM SET citus.max_background_task_executors_per_node = 1;
SELECT pg_reload_conf();
```

Strategies (`citus.shard_rebalancer_strategy`):

- `by_shard_count` — equal shard count per worker.
- `by_disk_size` — equal disk usage per worker.

Pick `by_disk_size` for skewed data (one tenant 100× the others); `by_shard_count` for uniform.

### HA / Failover

Citus does **not** include automatic failover. Each Citus node (coordinator + workers) is a regular Postgres cluster — pair each with **streaming replication standby** and a cluster manager:

- **Patroni** on every node (cross-ref [79](./79-patroni.md)) — most common production pattern. Each Citus node = independent Patroni cluster with its own DCS key.
- **CloudNativePG with Citus addon** on Kubernetes (cross-ref [92](./92-kubernetes-operators.md)).
- **Manual + repmgr** — lower automation, more control.

Failover sequence for a worker:

1. Standby promotes (`pg_promote()` or Patroni).
2. Update coordinator's `pg_dist_node` to point to new IP (`citus_update_node`).
3. Resume traffic.

Failover sequence for coordinator:

1. Standby promotes.
2. Apps switch connection string to new coordinator.
3. Workers continue serving — coordinator metadata is the only thing that moved.

**Critical**: coordinator metadata (`pg_dist_*` tables) must be on the new coordinator. Streaming replication carries them automatically; manual snapshot + restore must include them.

### Per-Version Timeline

Citus's own version timeline (not Postgres release notes — Citus is wholly external):

| Citus version | Released | Headline features / supported PG | Source |
|---|---|---|---|
| 10.0 | 2021-03 | Columnar storage moved from cstore_fdw; PG13 support | citusdata.com release notes |
| 11.0 | 2022-06 | Coordinator can be queried from any node; auto-rebalancer | citusdata.com release notes |
| 11.3 | 2023-03 | PG15 support | release notes |
| 12.0 | 2023-07 | **Schema-based sharding** (`citus_schema_distribute`)[^11] | citusdata.com blog |
| 12.1 | 2023-09 | PG16 support | release notes |
| 13.0 | 2025-Q1 | PG17 support + perf improvements | release notes |
| **14.0** | **2026-02-17** | **PG18.1 support, latest at planning time** | github.com/citusdata/citus/releases[^2] |

PG release notes — explicit zero-changes streak:

| PG version | Citus-relevant release-note items |
|---|---|
| PG14 (2021-09) | **Zero.** Verified by full-text search of release notes.[^12] |
| PG15 (2022-10) | **Zero.**[^13] |
| PG16 (2023-09) | **Zero.**[^14] |
| PG17 (2024-09) | **Zero.**[^15] |
| PG18 (2025-09) | **Zero.**[^16] |

> [!NOTE] Citus evolves on its own cadence
> Five consecutive PG majors with zero direct Citus mentions in release notes. If a guide tells you "PG18 added [Citus feature]", verify against Citus release notes directly — the feature is a Citus release, not a PG one. Same pattern as pgvector (cross-ref [94](./94-pgvector.md)), PostGIS (cross-ref [95](./95-postgis.md)), TimescaleDB (cross-ref [96](./96-timescaledb.md)).

## Examples / Recipes

### Recipe 1: Bootstrap a 4-node cluster

```bash
# On every node (coordinator + 3 workers)
echo "shared_preload_libraries = 'citus'" >> postgresql.conf
systemctl restart postgresql
```

```sql
-- On coordinator only
CREATE EXTENSION citus;
SELECT citus_set_coordinator_host('coordinator.internal', 5432);

-- Add workers
SELECT citus_add_node('worker-1.internal', 5432);
SELECT citus_add_node('worker-2.internal', 5432);
SELECT citus_add_node('worker-3.internal', 5432);

-- Verify
SELECT * FROM citus_get_active_worker_nodes();
```

### Recipe 2: Distribute a multi-tenant schema by `tenant_id`

```sql
-- Hot tables: distribute by tenant_id, co-locate via 'events' colocation group
SELECT create_distributed_table('events',   'tenant_id');
SELECT create_distributed_table('users',    'tenant_id', colocate_with => 'events');
SELECT create_distributed_table('payments', 'tenant_id', colocate_with => 'events');
SELECT create_distributed_table('sessions', 'tenant_id', colocate_with => 'events');

-- Lookup tables: reference (replicated everywhere)
SELECT create_reference_table('countries');
SELECT create_reference_table('plans');

-- Verify
SELECT logicalrelid::regclass, colocationid, partmethod, repmodel
FROM pg_dist_partition
ORDER BY logicalrelid;
```

### Recipe 3: Schema-per-tenant (Citus 12+)

```sql
SET citus.enable_schema_based_sharding TO ON;

CREATE SCHEMA tenant_acme;
CREATE TABLE tenant_acme.orders (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ, total NUMERIC(12,2));
CREATE TABLE tenant_acme.line_items (id BIGSERIAL PRIMARY KEY, order_id BIGINT REFERENCES tenant_acme.orders, sku TEXT);

SELECT citus_schema_distribute('tenant_acme');

-- Verify placement
SELECT schema_name, colocation_id, schema_owner
FROM citus_schemas;
```

### Recipe 4: Add a worker and rebalance

```sql
SELECT citus_add_node('worker-4.internal', 5432);

-- Background rebalance (Citus 11+)
SELECT citus_rebalance_start();

-- Monitor
SELECT * FROM citus_rebalance_status();

-- Stop / pause if needed
SELECT citus_rebalance_stop();
```

### Recipe 5: Hybrid rowstore + columnar partitioning

```sql
CREATE TABLE events (
    tenant_id BIGINT NOT NULL,
    id BIGSERIAL,
    ts TIMESTAMPTZ NOT NULL,
    payload JSONB,
    PRIMARY KEY (tenant_id, id, ts)
) PARTITION BY RANGE (ts);

-- Recent: rowstore (writable)
CREATE TABLE events_2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- Older: columnar (read-only, compressed)
CREATE TABLE events_2026_04 PARTITION OF events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01') USING columnar;

SELECT create_distributed_table('events', 'tenant_id');

-- Convert older partition to columnar after it ages out
SELECT alter_table_set_access_method('events_2026_05', 'columnar');
```

### Recipe 6: Distributed function for high write throughput

```sql
CREATE FUNCTION place_order(p_tenant BIGINT, p_payload JSONB) RETURNS BIGINT
LANGUAGE SQL AS $$
    INSERT INTO orders(tenant_id, payload, ts) VALUES (p_tenant, p_payload, now())
    RETURNING id;
$$;

SELECT create_distributed_function(
    'place_order(bigint,jsonb)',
    'p_tenant',
    colocate_with => 'orders'
);

-- Now this call routes entirely to the worker holding tenant=42
SELECT place_order(42, '{"amount":99}'::jsonb);
```

### Recipe 7: Audit distribution decisions across the database

```sql
SELECT
    logicalrelid::regclass AS table_name,
    CASE partmethod
        WHEN 'h' THEN 'hash-distributed'
        WHEN 'n' THEN 'reference'
        ELSE 'other'
    END AS distribution,
    colocationid,
    column_to_column_name(logicalrelid, partkey) AS distribution_column,
    repmodel
FROM pg_dist_partition
ORDER BY colocationid, logicalrelid;
```

### Recipe 8: Find broadcasts (queries that don't filter on distribution column)

```sql
-- On coordinator, capture queries planned as broadcast
SET citus.log_multi_join_order TO on;
SET citus.explain_all_tasks TO on;

EXPLAIN (ANALYZE, VERBOSE)
SELECT count(*) FROM events WHERE event_type = 'click';
-- Look for "Task Count: 32" (one per shard) → broadcast, slow
-- vs    "Task Count: 1" → routed to single worker, fast
```

Add filter on distribution column to convert broadcast to single-worker:

```sql
EXPLAIN ANALYZE
SELECT count(*) FROM events WHERE tenant_id = 42 AND event_type = 'click';
-- Task Count: 1 → routed to one worker
```

### Recipe 9: Diagnose hot worker (skewed distribution)

```sql
-- Per-worker shard count + disk usage
SELECT
    nodename,
    nodeport,
    count(*) AS shard_count,
    pg_size_pretty(sum(shard_size)) AS total_size
FROM citus_shards
GROUP BY nodename, nodeport
ORDER BY sum(shard_size) DESC;

-- If one node has 80% of disk, time to rebalance
-- citus_rebalance_start() defaults to by_shard_count
-- Switch to by_disk_size for skewed data
SET citus.shard_rebalancer_strategy = 'by_disk_size';
SELECT citus_rebalance_start();
```

### Recipe 10: Replace a failed worker

```sql
-- Worker dead. Standby already promoted to new IP 10.0.0.42.
-- Update coordinator's metadata to point to new node:
SELECT citus_update_node(
    nodeid := (SELECT nodeid FROM pg_dist_node WHERE nodename = 'worker-old.internal'),
    new_node_name := 'worker-new.internal',
    new_node_port := 5432
);

-- Verify
SELECT * FROM pg_dist_node;
```

### Recipe 11: Migrate from single-node to Citus (online cutover)

1. Stand up Citus cluster with same PG major.
2. Use logical replication (cross-ref [74](./74-logical-replication.md)) coordinator side ← single-node source.
3. After tables sync, on coordinator: `SELECT create_distributed_table('events', 'tenant_id')` for each (Citus allows distributing tables with data).
4. Cut over connection strings.

Caveats:

- `CREATE PUBLICATION ... FOR ALL TABLES` won't replicate sequence values — use `pg_dump --section=pre-data` first to load schema + sequences.
- Logical replication does not replicate DDL (cross-ref [74](./74-logical-replication.md) gotcha) — pause DDL during cutover window.

### Recipe 12: Inspect 2PC state after failure

```sql
-- Distributed transactions hung in PREPARED state
SELECT * FROM pg_dist_transaction;

-- Pending 2PC across workers
SELECT gid, prepared, owner, database FROM pg_prepared_xacts;

-- Manually resolve a stuck 2PC (last resort, after verifying state on workers)
ROLLBACK PREPARED 'citus_0_1234_5678_9';  -- or COMMIT PREPARED if all workers ready
```

Cross-ref [41](./41-transactions.md) for PREPARE TRANSACTION mechanics.

### Recipe 13: PG-major upgrade on a Citus cluster

Per-node `pg_upgrade` (cross-ref [86](./86-pg-upgrade.md)) is the right tool, but the order matters:

1. Stop traffic to coordinator (drain via pgBouncer pause).
2. `pg_upgrade` all workers in parallel — each is independent.
3. `pg_upgrade` coordinator last (it has the metadata).
4. `ALTER EXTENSION citus UPDATE` on coordinator + every worker (Citus extension may need bumping for new PG major).
5. Resume traffic.

Verify Citus version compatibility with target PG major **before** starting. Citus 14.0 supports PG18.1; older Citus on newer PG = unsupported.

## Gotchas / Anti-patterns

1. **Citus is NOT in core PostgreSQL.** External extension, requires `shared_preload_libraries = 'citus'` + restart. Most managed PG providers do not offer it without their own managed-Citus product. Self-host requires running it on every node.

2. **Direct writes to shard tables corrupt metadata.** Never `INSERT INTO events_102008 ...` directly on a worker. Always go through the coordinator. Workers' shard tables are an implementation detail.

3. **Distribution column choice is effectively one-way online.** Re-sharding via `alter_distributed_table` exists (Citus 11+) but is expensive and locking. Pick the column right the first time — match dominant join key.

4. **Cross-shard `UPDATE` / `DELETE` hits 2PC.** Every commit pays the cost of distributed transaction coordination. Workload that frequently updates rows on different workers will see latency dominated by 2PC, not the underlying writes.

5. **`max_prepared_transactions` must be raised on every node.** Default is 0 (disabled). Rule of thumb: `max_prepared_transactions = 2 × max_connections` on every node in the cluster. Otherwise distributed transactions fail with `out of shared memory` or `prepared transaction limit reached`.

6. **Schema-based sharding (Citus 12+) disallows cross-schema joins.** Verbatim docs: "joins and foreign keys should only involve tables from the same schema." If you need cross-tenant analytics, pick row-based distribution instead.

7. **Reference table writes propagate synchronously across workers.** A `INSERT INTO countries VALUES (...)` on the coordinator writes to every worker in the same transaction. Slow on big clusters. Acceptable for rarely-updated dimensions, painful for hot tables.

8. **Columnar tables can't be updated.** No `UPDATE`, no `DELETE`. Append-only. Use partitioning to combine rowstore (recent, mutable) + columnar (archive).

9. **Columnar tables can't have B-tree / GIN / GiST indexes.** Filters use only chunk-group metadata (min/max per ~10K rows). Wide column scans require reading all chunk groups.

10. **DDL on distributed tables locks every shard.** `ALTER TABLE events ADD COLUMN ...` runs on coordinator + every worker, each holding ACCESS EXCLUSIVE on the shard. Plan DDL windows like a real migration.

11. **Partial DDL failure leaves drift between coordinator and workers.** Network blip mid-DDL → coordinator has new column, some workers don't. Detect with `SELECT * FROM citus_check_cluster_node_health()` (Citus 11+). Re-run the DDL on the lagging nodes manually.

12. **`pg_dump` from coordinator dumps metadata, not all shard data.** Use `citus_metadata_sync` for backups + per-worker `pg_basebackup` (cross-ref [84](./84-backup-physical-pitr.md)). Don't rely on coordinator `pg_dump` as your backup.

13. **Citus does not include automatic failover.** Each node is a regular Postgres cluster — pair with Patroni or operator. Cross-ref [79](./79-patroni.md), [92](./92-kubernetes-operators.md).

14. **Coordinator is a SPOC (single point of config) but not a SPOF if you replicate it.** Stream coordinator metadata via PG streaming replication. Failure of coordinator with no standby = whole cluster unavailable.

15. **`citus_rebalance_start()` is throttled but not free.** Default rate avoids saturating workers but rebalancing a TB-scale cluster can take days. Plan rebalances during low-traffic windows or tune `citus.max_background_task_executors_per_node`.

16. **TimescaleDB + Citus is unsupported.** TimescaleDB multi-node was deprecated in TimescaleDB 2.14. Pick one — Citus for sharding, TimescaleDB for time-series-on-single-node (cross-ref [96](./96-timescaledb.md)).

17. **PG-major release notes contain zero Citus items.** PG14/15/16/17/18 all zero direct mentions. If a claim says "PG18 improved Citus X", check Citus's own release notes, not PG's.

18. **`SELECT count(*)` over distributed table is a broadcast.** No distribution-column filter → every worker scans every shard. Add `WHERE distribution_column = X` whenever possible, or use approximate counts via `citus_table_stats` for monitoring.

19. **`COPY` to distributed table routes per-row but is single-stream from coordinator.** Speed up bulk loads by parallelizing on the application side: split data by distribution-column ranges and `COPY` from multiple connections.

20. **`pg_dist_partition.partkey` is opaque (text-encoded internal node tree).** Use `column_to_column_name()` helper to decode distribution column from it — don't try to parse the raw column.

21. **Sequence values aren't unique across nodes by default.** `BIGSERIAL` on a distributed table gives each worker its own sequence range — collisions impossible because Citus uses `nextval()` on the coordinator. But local sequences on workers are independent. If migrating from single-node, watch for sequence gaps.

22. **Citus 11+ removed `master_*` function names.** Old guides referring to `master_add_node`, `master_rebalance_shards`, etc. — replace with `citus_add_node`, `citus_rebalance_start`. Old names removed entirely in Citus 11.0.

23. **Citus extension version must be in sync on coordinator + every worker.** `ALTER EXTENSION citus UPDATE` on coordinator without same on workers = subtle wire-protocol mismatch. Always upgrade in lock-step. Cross-ref [86](./86-pg-upgrade.md).

## See Also

- [`33-wal.md`](./33-wal.md) — WAL is per-node; distributed transactions add 2PC overhead.
- [`35-partitioning.md`](./35-partitioning.md) — native partitioning; Citus distributed tables built atop the same `pg_inherits` / partition machinery on each worker.
- [`41-transactions.md`](./41-transactions.md) — `max_prepared_transactions` sizing; PREPARE TRANSACTION drives Citus 2PC.
- [`46-roles-privileges.md`](./46-roles-privileges.md) — Citus replicates role grants across workers automatically; understand the propagation.
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries` requires restart; `citus.*` GUC catalog.
- [`63-internals-architecture.md`](./63-internals-architecture.md) — process model on every Citus node.
- [`69-extensions.md`](./69-extensions.md) — extension installation, version bump, `ALTER EXTENSION ... UPDATE`.
- [`70-fdw.md`](./70-fdw.md) — FDW-based federation as the lighter alternative when sharding isn't justified.
- [`73-streaming-replication.md`](./73-streaming-replication.md) — pair each Citus node with a standby for HA.
- [`74-logical-replication.md`](./74-logical-replication.md) — online migration from single-node to Citus.
- [`78-ha-architectures.md`](./78-ha-architectures.md) — pattern catalog; Citus pairs with Patroni or operators.
- [`79-patroni.md`](./79-patroni.md) — most common production HA partner for Citus.
- [`81-pgbouncer.md`](./81-pgbouncer.md) — pool in front of coordinator (and optionally workers).
- [`82-monitoring.md`](./82-monitoring.md) — `citus_stat_statements`, `citus_shards`, per-worker metrics.
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — per-worker pg_basebackup + coordinated PITR.
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — orchestrating major-version upgrade across Citus nodes.
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — CloudNativePG can run a Citus cluster.
- [`94-pgvector.md`](./94-pgvector.md) — combine pgvector with Citus for distributed vector search (sharded HNSW).
- [`96-timescaledb.md`](./96-timescaledb.md) — TimescaleDB + Citus combination is unsupported; pick one.
- [`98-pg-cron.md`](./98-pg-cron.md) — `citus_rebalance_start()` and maintenance tasks schedulable via pg_cron (same Citus Data org).
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version context; Citus evolves on its own cadence outside PG14-18 release notes.
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — Citus availability across managed providers varies; self-host is most common.

## Sources

[^1]: Citus GitHub repo (README + license). <https://github.com/citusdata/citus> — verified at planning time. Apache-2.0 throughout; README: "PostgreSQL extension that transforms Postgres into a distributed database."

[^2]: Citus releases page. <https://github.com/citusdata/citus/releases> — Citus 14.0 released 2026-02-17, supports PG 18.1.

[^3]: Citus concepts docs (coordinator / worker / table classes). <https://docs.citusdata.com/en/stable/get_started/concepts.html>

[^4]: Citus UDF reference (`create_distributed_table`, `create_reference_table`). <https://docs.citusdata.com/en/stable/develop/api_udf.html>

[^5]: Citus data-modeling / co-location docs. <https://docs.citusdata.com/en/stable/sharding/data_modeling.html> — verbatim: "Co-location is the practice of dividing data tactically, where one keeps related information on the same machines to enable efficient relational operations" + "Data co-location is a powerful technique for providing both horizontal scale and support to relational data models."

[^6]: Citus SQL reference (querying distributed tables). <https://docs.citusdata.com/en/stable/develop/reference_sql.html>

[^7]: Citus multi-tenant migration guide. <https://docs.citusdata.com/en/stable/develop/migration_mt_schema.html>

[^8]: Citus cluster management guide (sizing, scaling, failure handling). <https://docs.citusdata.com/en/stable/admin_guide/cluster_management.html>

[^9]: Citus upgrade guide. <https://docs.citusdata.com/en/stable/admin_guide/upgrading_citus.html>

[^10]: Citus docs home. <https://docs.citusdata.com/en/stable/>

[^11]: Schema-based sharding blog (Citus 12). <https://www.citusdata.com/blog/2023/07/18/citus-12-schema-based-sharding-for-postgres/> — verbatim: "Schema-based sharding means that tables from the same schema are placed on the same node, while different schemas may be on different nodes." + "joins and foreign keys should only involve tables from the same schema."

[^12]: PG14 release notes. <https://www.postgresql.org/docs/14/release-14.html> — verified zero Citus mentions.

[^13]: PG15 release notes. <https://www.postgresql.org/docs/15/release-15.html> — verified zero Citus mentions.

[^14]: PG16 release notes. <https://www.postgresql.org/docs/16/release-16.html> — verified zero Citus mentions.

[^15]: PG17 release notes. <https://www.postgresql.org/docs/17/release-17.html> — verified zero Citus mentions.

[^16]: PG18 release notes. <https://www.postgresql.org/docs/18/release-18.html> — verified zero Citus mentions. Citus evolves on its own version cadence; no PG release-note items in any of PG14-18.

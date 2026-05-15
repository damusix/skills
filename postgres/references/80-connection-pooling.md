# Connection Pooling

> [!WARNING] Pooling is mandatory at any non-trivial concurrency
> PostgreSQL forks one OS process per backend (~5-15 MB RSS each, more under load). Cluster running with `max_connections = 100` and 100 active sessions costs at least 500 MB-1.5 GB RAM in backend processes alone — before `work_mem`, before `shared_buffers`, before parallel workers. Application that opens 500-2000 connections without pooler will exhaust memory long before saturating CPU. Pooling = solved problem with three established patterns: app-side, sidecar (pgBouncer), centralized.

Production reference for connection pooling: process-per-connection cost, sizing formulas, three pool modes, feature trade-offs, pgBouncer overview (deep dive lives in [`81-pgbouncer.md`](./81-pgbouncer.md)).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
  - [Why pooling is needed](#why-pooling-is-needed)
  - [Pool sizing formula](#pool-sizing-formula)
  - [Three pooling tiers](#three-pooling-tiers)
  - [Three pool modes](#three-pool-modes)
  - [Pool mode × feature compatibility matrix](#pool-mode--feature-compatibility-matrix)
  - [reserved_connections (PG16+)](#reserved_connections-pg16)
  - [Idle-session timeouts](#idle-session-timeouts)
  - [Pooler landscape](#pooler-landscape)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file for:

- Sizing pool (how many connections to allow / accept)
- Picking pool mode (session / transaction / statement)
- Deciding pooling tier (app-side / sidecar / centralized)
- Understanding what session-level features each mode breaks
- Diagnosing "too many connections" + thundering-herd + lock-explosion problems

Use [`81-pgbouncer.md`](./81-pgbouncer.md) for pgBouncer config + ops deep dive.
Use [`63-internals-architecture.md`](./63-internals-architecture.md) for process model + procarray cost.
Use [`46-roles-privileges.md`](./46-roles-privileges.md) for per-role pool routing patterns.

## Mental Model

Five rules:

1. **Process-per-connection, not thread-per-connection.** Postmaster forks one backend per client[^connect-estab]. Backend = full OS process + ProcArray slot + per-backend memory (work_mem allocations per node, prepared-statement plan cache, GUC state, etc.). Fork latency + memory cost scale linearly with connections. Cannot raise `max_connections` past ~500-1000 on typical multi-core server hardware (spinning or SSD, non-HBM RAM) without operationally significant overhead. Pooler decouples app concurrency from backend count.

2. **Pool sizing formula = active connections, not max connections.** Community wiki rule: `active connections ≈ (CPU cores × 2) + effective_spindle_count`[^wiki-conn]. Verbatim: *"for optimal throughput the number of active connections should be somewhere near ((core_count * 2) + effective_spindle_count)"*. NVMe / fully-cached datasets → spindle term = 0. Pool size of 16-50 typically saturates 8-16-core machine. Bigger pool = lock contention + context switching + memory pressure, not more throughput.

3. **Three pool modes form a feature/throughput dial.** Session mode (one client = one backend for connection lifetime, transparent, expensive). Transaction mode (backend lease per transaction, default for pgBouncer, loses session-level state). Statement mode (lease per statement, breaks multi-statement transactions, rare). Picking transaction over session = ~10-100× connection-reuse multiplier; cost = giving up SET/LISTEN/cursors-WITH-HOLD/advisory-session-locks.

4. **PG17 + libpq close-prepared = transaction-mode prepared statements work.** Pre-PG17 + pgBouncer transaction mode: every prepared statement ties client to backend, defeats pooling. PG17 added `PQclosePrepared()` / `PQclosePortal()`[^pg17-close]; pgBouncer 1.21+ (Oct 2023, supports protocol-level Close even on older servers) tracks named prepared statements across server-side pool members. Transaction-mode + prepared statements no longer mutually exclusive.

5. **Idle-in-transaction kills cluster; idle-outside-transaction merely annoys.** `idle_in_transaction_session_timeout` (PG default 0 = disabled) kills sessions holding open transactions while idle — these block VACUUM, hold locks, retain xmin horizon. `idle_session_timeout` PG14+ kills idle-not-in-transaction sessions — only annoying (slot held, memory consumed, no horizon impact). Set the former aggressively (30s-5min); set the latter only with explicit pooler-awareness[^idle-session-warning].

## Decision Matrix

| Need / situation | Tier + mode | Avoid | Why |
|---|---|---|---|
| App workload < 50 concurrent users, short transactions | App-side pool + direct PG, session mode | Adding pgBouncer adds complexity for nothing | Pool overhead > savings |
| Web app, > 100 concurrent users, short transactions | App-side pool + pgBouncer transaction mode | Session mode for 1000 clients to 50 backends | Transaction mode = mandatory for ratio >10:1 |
| Need session-level state (SET, LISTEN, advisory locks, temp tables across transactions) | pgBouncer session mode OR direct PG | Transaction mode + SET — breaks silently | Transaction mode disallows SET |
| Need protocol-level prepared statements + transaction-mode pooling | PG17+ libpq + pgBouncer 1.21+ + `max_prepared_statements > 0` | Pre-PG17 + transaction-mode + named PREPARE | Pre-PG17 ties client to backend |
| Batch jobs with one long transaction each | App-side pool, low pool_size, session mode | Transaction mode (no benefit for one-tx-per-job) | Pooling adds nothing for long single tx |
| Serverless / Lambda / FaaS with bursty connection storms | pgBouncer or pgcat in front; **never** raw libpq | Each Lambda invocation opening + dropping connection | Fork cost + procarray contention = catastrophic |
| Multi-tenant SaaS with per-tenant role | Pool per role/tenant or transaction-mode pool with SET LOCAL only | One global pool with SET ROLE on checkout | Wasted server-side memory; pool fragmentation |
| HA cluster with promoted standby | pgBouncer in front of HAProxy → PG primary | App direct to PG; needs reconnect on every failover | Pooler = thin abstraction over failover |
| Microservices, > 50 services connecting to shared PG | Centralized pgBouncer cluster; service connects to pgBouncer | Each service opens own connection pool | Each-service pool × N-services = explosion |
| Want session-state isolation per client but small backend count | session-mode pool, pool_size small (10-30) | Transaction mode if any code uses SET | Session mode preserves correctness |
| Pool checkout / return should reset session state | `server_reset_query = DISCARD ALL` in pgBouncer | No reset query, transaction mode | Reset query catches stragglers |
| Replica scaling for reads | pgBouncer per-replica OR HAProxy in front | Single pgBouncer across primary + replicas without per-pool routing | pgBouncer not topology-aware |

**Three smell signals:**

1. `pg_stat_activity` shows hundreds of `idle` rows with no app workload → no pooler in front of cluster.
2. Application throughput plateaus + p99 latency rises sharply when concurrent clients increase → pool too large (lock contention) or no pool (procarray contention).
3. `pg_stat_activity` shows `idle in transaction` rows older than `now() - interval '1 minute'` → idle-in-transaction not bounded; VACUUM is being blocked. Set `idle_in_transaction_session_timeout = '60s'` per-role or cluster-wide.

## Mechanics

### Why pooling is needed

Postmaster forks one backend per accepted connection[^connect-estab]:

> "PostgreSQL implements a 'process per user' client/server model. In this model, every client process connects to exactly one backend process."

> "we have to use a 'supervisor process' that spawns a new backend process every time a connection is requested. This supervisor process is called postmaster."

Per-backend cost:

| Cost component | Approximate size | Notes |
|---|---|---|
| Backend process RSS (idle) | 5-15 MB | Steady-state; grows with workload |
| Backend process RSS (active) | 20-200 MB+ | `work_mem` allocations per node, plan cache, prepared statements |
| ProcArray slot | 1 entry | Linear-scan cost for every snapshot creation; PG14 scalability fix mitigated[^pg14-snapshot] but still scales with `max_connections` |
| Shared lock-table slot | `max_locks_per_transaction` | Cluster-wide, per-backend reserved |
| Fork latency | 1-5 ms | New connection = postmaster fork + auth + startup packet |

`max_connections` default is 100[^max-conn]:

> "The default is typically 100 connections, but might be less if your kernel settings will not support it (as determined during initdb). This parameter can only be set at server start."

**Restart-only.** Cannot raise without bounce. Plan capacity ahead.

`superuser_reserved_connections` (default 3) — reserves slots for superusers when `max_connections` is full[^max-conn].

### Pool sizing formula

Wiki rule (canonical, oft-cited)[^wiki-conn]:

> "for optimal throughput the number of active connections should be somewhere near ((core_count * 2) + effective_spindle_count)"

> "Core count should not include HT threads, even if hyperthreading is enabled. Effective spindle count is zero if the active data set is fully cached, and approaches the actual number of spindles as the cache hit rate falls."

Tier table:

| Hardware | Active-connection target | Notes |
|---|---|---|
| 4-core, NVMe, dataset cached | 8-10 | `(4 × 2) + 0` |
| 8-core, NVMe, dataset cached | 16-20 | `(8 × 2) + 0` |
| 16-core, NVMe, dataset cached | 32-40 | `(16 × 2) + 0` |
| 8-core, mixed RAID-10 SAS, dataset 5× RAM | 18-24 | `(8 × 2) + 6-8` |
| 32-core, NVMe, OLTP heavy | 64-80 | Diminishing returns past this; lock contention |

**Pool size ≠ max_connections.** Common deployment: `max_connections = 200`, pgBouncer `default_pool_size = 20`, app sees 2000 concurrent clients. Backend count saturates around 20-40 active.

**Wait queue size matters more than pool size at saturation.** pgBouncer `reserve_pool_size = 5`, `reserve_pool_timeout = 3s` lets temporary spikes use spare slots. Beyond that → 429 / 503 / connection-refused at app layer.

### Three pooling tiers

| Tier | Where it runs | Examples | When to pick |
|---|---|---|---|
| **App-side** | In-process inside application | HikariCP (JVM), psycopg pool (Python), node-postgres pool (Node.js), pgx + Pgxpool (Go) | Single app, < 50 connections, no inter-process sharing needed |
| **Sidecar** | One pooler per app instance | pgBouncer on app-server localhost, Unix socket | Per-host pooling; bounds connection count per host |
| **Centralized** | Dedicated pooler service | pgBouncer cluster behind LB, pgcat | Many services sharing one PG, > 100 client processes total |

Trade-off: **app-side has zero network hop + zero auth latency + zero TLS termination cost**, but limited to one process. **Centralized adds 0.1-1 ms latency per query** but consolidates connection budget across many app processes.

**Combine tiers.** Common: app-side pool of 10-20 connections per process → pgBouncer sidecar (transaction mode, pool_size 20) → PG primary. App-side enforces same-process connection reuse + retries; pgBouncer enforces backend-count cap.

### Three pool modes

pgBouncer terminology (industry standard)[^pgb-usage]:

| Mode | Lease unit | Verbatim description |
|---|---|---|
| Session | Client connection lifetime | "Most polite method. When a client connects, a server connection will be assigned to it for the whole duration the client stays connected." |
| Transaction | Single transaction | "A server connection is assigned to a client only during a transaction. When PgBouncer notices that transaction is over, the server connection will be put back into the pool." |
| Statement | Single statement | "Most aggressive method. The server connection will be put back into the pool immediately after a query completes. Multi-statement transactions are disallowed in this mode as they would break the assumption of statement pooling." |

**Default and almost-always-right choice = transaction mode.** Lease per transaction = highest reuse + correct semantics for stateless web requests.

**Session mode is mandatory** when client code:

- Issues `SET` / `RESET` outside transactions (per-session GUC)
- Uses `LISTEN` / `NOTIFY` (cross-transaction)
- Holds session-level advisory locks (`pg_advisory_lock`, not `pg_advisory_xact_lock`)
- Uses session-lifetime temporary tables (`ON COMMIT PRESERVE ROWS` / `DELETE ROWS`)
- Issues SQL-level `PREPARE` / `DEALLOCATE` (not protocol-level prepared statements)
- Uses `WITH HOLD` cursors

**Statement mode** = rare. Only useful for true single-statement workloads (read-only analytics with `autocommit = true`, no transactions). Most ORMs implicitly start transactions; statement mode breaks them.

### Pool mode × feature compatibility matrix

Verbatim from pgBouncer features matrix[^pgb-features]:

| Feature | Session | Transaction |
|---|---|---|
| Startup parameters (client_encoding, datestyle, timezone, standard_conforming_strings, application_name) | Yes | Yes |
| `SET` / `RESET` | Yes | **Never** |
| `LISTEN` | Yes | **Never** |
| `NOTIFY` | Yes | Yes |
| `WITHOUT HOLD CURSOR` | Yes | Yes |
| `WITH HOLD CURSOR` | Yes | **Never** |
| Protocol-level prepared plans | Yes | Yes (pgBouncer 1.21+) |
| SQL-level `PREPARE` / `DEALLOCATE` | Yes | **Never** |
| `ON COMMIT DROP` temp tables | Yes | Yes |
| `PRESERVE/DELETE ROWS` temp tables | Yes | **Never** |
| Cached plan reset | Yes | Yes |
| `LOAD` statement | Yes | **Never** |
| Session-level advisory locks | Yes | **Never** |

**Transaction-mode rule of thumb:** anything that survives `COMMIT` and persists at the session level is broken. Use `SET LOCAL` instead of `SET`. Use `pg_advisory_xact_lock` instead of `pg_advisory_lock`. Use `ON COMMIT DROP` temp tables only.

**Statement-mode is transaction-mode minus multi-statement transactions.** pgBouncer features.html does not publish a separate statement column — statement mode inherits transaction restrictions plus the `usage.html` rule: *"Multi-statement transactions are disallowed in this mode as they would break the assumption of statement pooling."*

### reserved_connections (PG16+)

> [!NOTE] PostgreSQL 16
> `reserved_connections` GUC added — reserves connection slots for roles that have the `pg_use_reserved_connections` predefined role granted[^pg16-reserved]. Verbatim: *"Allow the server to reserve backend slots for roles with `pg_use_reserved_connections` membership (Nathan Bossart). The number of reserved slots is set by server variable `reserved_connections`."*

Three-tier reservation:

| Reservation tier | GUC | Reserved for | Default |
|---|---|---|---|
| Top | `superuser_reserved_connections` | Superusers only | 3 |
| Middle (PG16+) | `reserved_connections` | Roles with `pg_use_reserved_connections` | 0 |
| Bottom | Remaining | All other roles | `max_connections - sum(above)` |

Use case: dedicated monitoring + replication + maintenance roles never get locked out when application pool exhausts `max_connections`. Grant `pg_use_reserved_connections` to those roles, set `reserved_connections = 5`.

### Idle-session timeouts

| GUC | Default | Kills what | Why it matters |
|---|---|---|---|
| `idle_in_transaction_session_timeout` | `0` (disabled) | Sessions idle inside transaction | **Critical**. Blocks VACUUM, holds xmin horizon, retains locks. Set to 30s-5min cluster-wide or per-role |
| `idle_session_timeout` (PG14+) | `0` (disabled) | Sessions idle, no transaction open | Cosmetic / capacity. Pooler-aware before setting cluster-wide[^idle-session-warning] |
| `statement_timeout` | `0` (disabled) | Single statement running too long | Per-query; per-role baseline pattern |
| `lock_timeout` | `0` (disabled) | Waiting for lock too long | Per-query; per-role baseline pattern |

> [!WARNING] idle_session_timeout + pooler
> Verbatim docs warning: *"Be wary of enforcing this timeout on connections made through connection-pooling software or other middleware, as such a layer may not react well to unexpected connection closure."* pgBouncer + cluster-wide `idle_session_timeout` = pgBouncer reconnects silently but logs grow. Set only per-role for non-pooled roles, or align with pgBouncer `server_idle_timeout`.

> [!NOTE] PostgreSQL 14
> `idle_session_timeout` introduced[^pg14-idle]. Verbatim: *"Add server parameter idle_session_timeout to close idle sessions (Li Japin). This is similar to idle_in_transaction_session_timeout."*

### Pooler landscape

| Pooler | Language | Pool modes | Maturity | Notes |
|---|---|---|---|---|
| **pgBouncer** | C | session / transaction / statement | Battle-tested since 2007 | De-facto standard. Single-threaded but very efficient. See [`81-pgbouncer.md`](./81-pgbouncer.md) |
| **Pgpool-II** | C | session / connection-pool / replication / load-balance | Mature; broader feature set | Heavier; also does query routing, load balancing, in-memory cache. Heavier ops surface |
| **pgcat** | Rust | session / transaction | Active; postgresml/pgcat | Multi-threaded; supports sharding + per-shard routing; newer than pgBouncer |
| **Odyssey** | C | session / transaction | Yandex-developed | Multi-threaded; less mainstream than pgBouncer |
| **awslabs/pgbouncer-fast-switchover** | C (pgBouncer fork) | session / transaction | AWS-maintained | "intercept and programmatically change client queries before they are sent to the server" — adds query rewriting + failover speedup |
| **App-side pools** | language-native | session-equivalent only | Library-dependent | HikariCP (Java), psycopg pool (Python), node-postgres (Node), pgx (Go) |

**Default recommendation = pgBouncer.** Smallest operational surface, broadest production evidence, transaction mode + PG17 close-prepared = mature. Pgpool-II + pgcat are valid for specific use cases (load balancing, sharding) but heavier.

## Per-Version Timeline

| Version | Connection-pooling-relevant items | Sources |
|---|---|---|
| PG14 | `idle_session_timeout` GUC introduced (Li Japin)[^pg14-idle]; snapshot scalability improvements reduce per-backend cost at high `max_connections`[^pg14-snapshot] | PG14 release notes |
| PG15 | No direct pooling-relevant changes | PG15 release notes |
| PG16 | `reserved_connections` GUC + `pg_use_reserved_connections` predefined role (Nathan Bossart)[^pg16-reserved]; pg_hba.conf `include` directives + regex-on-database/user (composes with pooler-injected `application_name` for per-app rules) | PG16 release notes |
| PG17 | `PQclosePrepared()` / `PQclosePortal()` libpq functions (Jelte Fennema-Nio)[^pg17-close] — explicit support for pgBouncer-style closing of named prepared statements + portals; pgBouncer 1.21+ (Oct 2023) tracks named prepared statements across pool members via protocol-level Close (not strictly requiring PG17, but PG17 libpq helpers make it canonical for app drivers); `pg_dump`/`pgBouncer` + scram-passthrough improvements; `event_triggers` GUC disables event triggers cluster-wide for debugging (cross-reference [`40-event-triggers.md`](./40-event-triggers.md)) | PG17 release notes, pgBouncer changelog |
| PG18 | No headline connection-pooling-feature changes; async I/O subsystem reduces per-backend I/O wait[^pg18-aio] | PG18 release notes |

> [!NOTE] PG17 + pgBouncer 1.21 = transaction-mode prepared statements
> Pre-PG17, transaction-mode + prepared statements = mutually exclusive (each PREPARE ties client to backend). pgBouncer 1.21 (Oct 2023, pre-PG17 GA) added protocol-level named-prepared-statement tracking. PG17 added libpq `PQclosePrepared()` so client drivers can portably close prepared statements. Set `max_prepared_statements = 100-200` in pgBouncer config[^pgb-changelog]:
>
> *"Add support for protocol-level named prepared statements! This is probably one of the most requested features for PgBouncer ... In synthetic benchmarks this feature was able to increase query throughput anywhere from 15% to 250%, depending on the workload."*

## Examples / Recipes

### Recipe 1 — Baseline production setup: 8-core OLTP cluster

```ini
# postgresql.conf
max_connections = 200                  # Bound. App reaches via pgBouncer, not direct
superuser_reserved_connections = 3
reserved_connections = 5               # PG16+: for monitoring/replication roles

idle_in_transaction_session_timeout = '60s'  # Critical
statement_timeout = '0'                 # Set per-role
lock_timeout = '0'                      # Set per-role
```

```ini
# pgbouncer.ini
[databases]
appdb = host=127.0.0.1 port=5432 dbname=appdb

[pgbouncer]
pool_mode = transaction
listen_port = 6432
listen_addr = 127.0.0.1
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

default_pool_size = 20                  # ~ (cores × 2) + 4 buffer
max_client_conn = 2000                  # 100× backend count
reserve_pool_size = 5
reserve_pool_timeout = 3
server_reset_query = DISCARD ALL        # Clean state between client leases
server_idle_timeout = 600                # Close backend idle for 10 min

max_prepared_statements = 200            # PG17+ libpq + pgBouncer 1.21+
```

Three-config-block convention: postgresql.conf + pgBouncer config + app driver connection string. App connects to `127.0.0.1:6432` not `:5432`.

### Recipe 2 — Pool sizing calculation

```sql
-- Determine target pool size per host
WITH params AS (
    SELECT
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn,
        4 AS cpu_cores,                  -- adjust for actual cores
        0 AS effective_spindles           -- 0 = fully cached / NVMe
)
SELECT
    max_conn,
    cpu_cores,
    effective_spindles,
    (cpu_cores * 2 + effective_spindles) AS recommended_active_pool,
    max_conn / (cpu_cores * 2 + effective_spindles) AS recommended_clients_per_backend
FROM params;
```

Output guides `default_pool_size` in pgBouncer + `max_clients_per_pool` heuristics.

### Recipe 3 — Per-role pool routing (sidecar pgBouncer)

```ini
# pgbouncer.ini — separate pools per role for different workload profiles
[databases]
appdb_web = host=127.0.0.1 port=5432 dbname=appdb pool_size=30 pool_mode=transaction
appdb_reporter = host=127.0.0.1 port=5432 dbname=appdb pool_size=5 pool_mode=session
appdb_batch = host=127.0.0.1 port=5432 dbname=appdb pool_size=3 pool_mode=session
```

Web tier connects to `appdb_web` (transaction mode, large pool). Reporter role connects to `appdb_reporter` (session mode for long analytic queries with `WITH HOLD` cursors). Batch jobs connect to `appdb_batch` (small pool, session mode for one-tx-per-job).

### Recipe 4 — Detect "no pooler" symptom

```sql
-- High idle-connection count = no pooler
SELECT
    state,
    count(*) AS sessions,
    pg_size_pretty(count(*) * 10 * 1024 * 1024) AS approx_rss
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY sessions DESC;
```

`idle` rows greater than ~50 with sub-1% CPU utilization → app keeps connections open between requests. Pool tier missing or misconfigured.

### Recipe 5 — Detect idle-in-transaction (the canonical bloat builder)

```sql
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    now() - xact_start AS xact_duration,
    now() - state_change AS idle_duration,
    state,
    query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND xact_start IS NOT NULL
ORDER BY xact_duration DESC;
```

Any `xact_duration > 1 minute` = bug. Set `idle_in_transaction_session_timeout = '60s'` cluster-wide or per-role. Cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) for xmin-horizon consequences.

### Recipe 6 — Connection-storm protection at app boundary

```python
# Python (psycopg pool) — bound at app side, sidecar pgBouncer further bounds
import psycopg_pool

pool = psycopg_pool.ConnectionPool(
    conninfo="host=127.0.0.1 port=6432 dbname=appdb",   # → pgBouncer
    min_size=2,
    max_size=10,
    timeout=5.0,                # Refuse-fast under load
    max_lifetime=900,           # Recycle every 15 min
    max_idle=300,               # Close idle after 5 min
    reconnect_timeout=30,
)
```

Two-tier bound: app pool max 10 → pgBouncer default_pool_size 20 → PG max_connections 200. App-side `timeout=5.0` returns 503 to user fast instead of saturating backend.

### Recipe 7 — Per-role timeouts (canonical baseline)

```sql
-- Webapp role: aggressive timeouts (correctness)
ALTER ROLE webapp SET statement_timeout = '5s';
ALTER ROLE webapp SET lock_timeout = '500ms';
ALTER ROLE webapp SET idle_in_transaction_session_timeout = '30s';

-- Reporter role: long queries allowed, no idle-in-tx tolerated
ALTER ROLE reporter SET statement_timeout = '15min';
ALTER ROLE reporter SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE reporter SET default_transaction_read_only = on;

-- Batch role: long-running, monitoring picks up failures
ALTER ROLE batchjobs SET statement_timeout = '2h';
ALTER ROLE batchjobs SET idle_in_transaction_session_timeout = '5min';
```

> [!NOTE] Per-role + pgBouncer transaction mode caveat
> Per-role `ALTER ROLE SET` values do NOT propagate across pgBouncer transaction-mode pool returns. pgBouncer's `server_reset_query = DISCARD ALL` may clear them. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6. Mitigations: (a) make the value cluster-wide in `postgresql.conf`, or (b) set in pgBouncer's `connect_query`, or (c) use `SET LOCAL` per transaction.

### Recipe 8 — Migrate from session to transaction mode (verification checklist)

```sql
-- Pre-migration audit: find session-level state usage
-- 1. SQL-level prepared statements (PREPARE / EXECUTE / DEALLOCATE)
SELECT query FROM pg_stat_statements
WHERE query ILIKE 'PREPARE %' OR query ILIKE 'DEALLOCATE %';

-- 2. Session-level advisory locks (vs pg_advisory_xact_lock)
SELECT query FROM pg_stat_statements
WHERE query ~* 'pg_advisory_lock\s*\('
  AND query !~* 'pg_advisory_xact_lock';

-- 3. SET vs SET LOCAL
SELECT query FROM pg_stat_statements
WHERE query ~* '^SET '
  AND query !~* '^SET LOCAL';

-- 4. LISTEN
SELECT query FROM pg_stat_statements
WHERE query ILIKE 'LISTEN %';

-- 5. WITH HOLD cursors
SELECT query FROM pg_stat_statements
WHERE query ILIKE '%WITH HOLD%';

-- 6. Session-lifetime temp tables
SELECT query FROM pg_stat_statements
WHERE query ~* 'CREATE\s+TEMP'
  AND query !~* 'ON COMMIT DROP';
```

Each non-empty result = code change needed before flipping `pool_mode = transaction`.

### Recipe 9 — Verify pgBouncer transaction-mode prepared statements (PG17+)

```sql
-- After enabling max_prepared_statements > 0 in pgBouncer 1.21+
-- and connecting via app driver that uses protocol-level prepared statements:

-- pgBouncer console (psql -p 6432 pgbouncer)
SHOW STATS;
SHOW POOLS;

-- Server-side verification via pg_stat_statements
-- Same query repeated should show calls > 1 with stable queryid (queryid stable across sessions/clients).
```

App drivers using protocol-level extended-query messages (most modern drivers) benefit automatically. SQL-level `PREPARE` still requires session mode.

### Recipe 10 — Three-tier pooling at scale (microservices + central pool)

```
[Service A pod] [Service B pod] [Service C pod]   ← N replicas each, app-pool size 5
       ↓                ↓                ↓
       └────────────────┼────────────────┘
                        ↓
                [pgBouncer cluster (3-5 replicas)]   ← transaction mode, pool_size 30
                        ↓
                [HAProxy / Patroni REST]              ← failover
                        ↓
                [PG primary + 2 standbys]             ← max_connections 200
```

App pool × N services × M replicas = client side. pgBouncer cluster bounds total backend usage. HAProxy routes around failover.

### Recipe 11 — Monitor pool exhaustion (server side)

```sql
-- Backend usage per role
SELECT
    rolname,
    count(*) AS backends,
    count(*) FILTER (WHERE state = 'active') AS active,
    count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx
FROM pg_stat_activity a
JOIN pg_roles r ON r.oid = a.usesysid
GROUP BY rolname
ORDER BY backends DESC;

-- Current vs max
SELECT
    count(*) AS current_backends,
    (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
    round(100.0 * count(*) /
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections'), 1) AS pct_used
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

Alert at 75% pct_used. Hit 100% = "FATAL: sorry, too many clients already" errors.

### Recipe 12 — Monitor pool exhaustion (pgBouncer side)

```text
$ psql -h 127.0.0.1 -p 6432 -U pgbouncer pgbouncer
pgbouncer=# SHOW POOLS;
 database | user    | cl_active | cl_waiting | sv_active | sv_idle | sv_used | maxwait
----------+---------+-----------+------------+-----------+---------+---------+---------
 appdb    | webapp  | 1500      | 50         | 18        | 2       | 0       | 12

pgbouncer=# SHOW STATS;
```

`cl_waiting > 0` = clients queued; pool is saturated. `maxwait > 5` (seconds) = users seeing slow responses. Raise `default_pool_size` or `reserve_pool_size`, or scale pgBouncer horizontally.

### Recipe 13 — Connection-pool checkout reset patterns

```ini
# pgBouncer — clean state on server return to pool
server_reset_query = DISCARD ALL
```

`DISCARD ALL` resets: temp tables, prepared statements, cursors, listen channels, session GUCs (back to defaults), advisory session locks. Safe + canonical. Equivalent to fresh connection state.

Alternative (PG14+, narrower):

```sql
DISCARD PLANS;            -- only prepared-plan cache
DISCARD TEMP;             -- only temp tables
DISCARD SEQUENCES;        -- only sequence cache
```

Use full `DISCARD ALL` unless you have a specific reason. Faster than reconnecting.

## Gotchas / Anti-patterns

1. **Setting `max_connections = 1000` and skipping pooler.** Linear procarray scan, 5-15 GB+ RSS, lock-table pressure. Pool. Always pool.

2. **Pool size equal to `max_connections`.** Defeats pooling — every client gets own backend. Pool size should be 10-100× smaller than `max_connections`.

3. **Transaction-mode pooling + `SET` (not `SET LOCAL`).** Silently breaks: GUC clears on next transaction's pool return. Code that uses `SET search_path` outside transactions in transaction-mode pool = bug.

4. **`pg_advisory_lock` in transaction-mode pool.** Lock held in backend, but client's next transaction may land on different backend. Lock orphan + correctness bug. Use `pg_advisory_xact_lock`.

5. **SQL-level `PREPARE` / `EXECUTE` in transaction-mode pool.** Prepared name lives only on that backend. Next transaction may not find it. Use protocol-level prepared statements (PG17+ libpq + pgBouncer 1.21+).

6. **`idle_in_transaction_session_timeout = 0` (default).** Means: any client bug that holds open transaction → VACUUM blocked indefinitely, xmin horizon held back, bloat accumulates. Set to 30s-5min cluster-wide. Setting this GUC is a high-impact, low-risk change for most production deployments; it prevents indefinite transaction holds that silently accumulate bloat.

7. **`idle_session_timeout` cluster-wide + pgBouncer.** Verbatim docs warning. pgBouncer reconnects silently but logs grow + reconnect overhead. Set per-role for non-pooled access only, or align with `server_idle_timeout`.

8. **Pool too small → app threads block waiting for connection.** Symptom: app-side connection timeouts; pgBouncer `cl_waiting > 0`; queries themselves fast. Raise pool size or reduce app concurrency.

9. **Pool too large → server-side lock contention + memory pressure.** Symptom: `pg_stat_activity` shows many `active` rows; CPU pegged; per-query latency rising. Reduce pool size.

10. **One global pool, many roles, role-switching via `SET ROLE` on checkout.** Wastes per-backend role-cache; planner cache pollution. Run separate pgBouncer pools per role.

11. **pgBouncer + cluster-wide `event_triggers` GUC (PG17+) set off.** Some apps depend on event triggers for audit/cache invalidation. Verify before disabling. Cross-reference [`40-event-triggers.md`](./40-event-triggers.md).

12. **No `server_reset_query`.** Connection state leaks between client leases — prepared statements, GUCs, advisory locks. Set `server_reset_query = DISCARD ALL`.

13. **Application connecting directly to PG when pgBouncer is also deployed.** Bypasses pool entirely. Either remove direct path, or accept dual-connect for specific session-mode workloads.

14. **`max_prepared_statements = 0` (pgBouncer default) + protocol-level prepared statements.** pgBouncer 1.21+ supports them in transaction mode only when this GUC is non-zero. Default zero = feature disabled, every PREPARE re-sent.

15. **`max_connections` raise without reboot plan.** Postmaster-context GUC. Requires restart, not reload. Plan capacity ahead.

16. **Per-role `ALTER ROLE SET` GUCs not propagating through transaction-mode pool.** Set in postgresql.conf, in pgBouncer `connect_query`, or use `SET LOCAL` per transaction. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6.

17. **Pool size scaled with concurrent users instead of CPU cores.** Wrong formula. CPU cores × 2 + spindles, not user count. Concurrent users connects to pool entry queue, not backend.

18. **Sidecar pgBouncer with `listen_addr = *` and no firewall.** pgBouncer authenticates clients, but accepting external connections without TLS exposes credentials. Bind to `127.0.0.1` or use TLS.

19. **Statement-mode pooling with ORM that implicitly opens transactions.** Hibernate, ActiveRecord, SQLAlchemy default to transactions per request. Statement mode breaks them. Use transaction mode.

20. **Multi-tenant SaaS using transaction-mode pool + role switching mid-transaction.** Role active when transaction commits is what gets logged + applied for `pg_stat_activity.usename`. Use one pool per tenant role.

21. **Stale connection in pool after PG restart.** pgBouncer detects + reconnects, but in-flight transactions error. Application must retry on connection-reset errors. Set `query_wait_timeout` for clean failure.

22. **HAProxy + pgBouncer + Patroni stack without health-check awareness.** pgBouncer doesn't know if it's pointing at primary or standby. HAProxy must route based on Patroni REST API check (`/primary` or `/replica`), not on pgBouncer alone. Cross-reference [`79-patroni.md`](./79-patroni.md) Recipe 6.

23. **Replicas pooled identically to primary.** Replicas often serve read-only workload with lower concurrency. Smaller per-replica pool (5-10) is fine. Don't blindly mirror primary pool config.

## See Also

- [`63-internals-architecture.md`](./63-internals-architecture.md) — Process model deep dive (postmaster, backends, ProcArray, shared memory)
- [`81-pgbouncer.md`](./81-pgbouncer.md) — pgBouncer config + ops deep dive (next file)
- [`46-roles-privileges.md`](./46-roles-privileges.md) — Per-role baseline; per-role GUC + transaction-mode pool caveat
- [`41-transactions.md`](./41-transactions.md) — `idle_in_transaction_session_timeout`, `transaction_timeout` PG17+
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — Why idle-in-transaction is catastrophic (xmin horizon)
- [`43-locking.md`](./43-locking.md) — Table and row lock modes; transaction-mode pool incompatibility with long-held locks
- [`44-advisory-locks.md`](./44-advisory-locks.md) — Session vs transaction advisory locks
- [`56-explain.md`](./56-explain.md) — Plan caching + transaction-mode + prepared statements interaction
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — Track query latency to spot pool exhaustion
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity` deep dive
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HAProxy + pgBouncer + Patroni patterns
- [`79-patroni.md`](./79-patroni.md) — Patroni REST API health checks for HAProxy routing

## Sources

[^connect-estab]: PostgreSQL 16 documentation, Chapter 52.2 "How Connections Are Established". Verbatim: *"PostgreSQL implements a 'process per user' client/server model. In this model, every client process connects to exactly one backend process."* and *"we have to use a 'supervisor process' that spawns a new backend process every time a connection is requested. This supervisor process is called postmaster."* https://www.postgresql.org/docs/16/connect-estab.html

[^wiki-conn]: PostgreSQL Wiki, "Number Of Database Connections". Verbatim: *"for optimal throughput the number of active connections should be somewhere near ((core_count * 2) + effective_spindle_count)"* and *"Core count should not include HT threads, even if hyperthreading is enabled. Effective spindle count is zero if the active data set is fully cached, and approaches the actual number of spindles as the cache hit rate falls."* https://wiki.postgresql.org/wiki/Number_Of_Database_Connections

[^max-conn]: PostgreSQL 16 documentation, Section 20.3 "Connections and Authentication". Verbatim: *"The default is typically 100 connections, but might be less if your kernel settings will not support it (as determined during initdb). This parameter can only be set at server start."* https://www.postgresql.org/docs/16/runtime-config-connection.html

[^pg14-snapshot]: PostgreSQL 14 release notes. Snapshot scalability improvements by Andres Freund — reduce ProcArray contention at high `max_connections`. https://www.postgresql.org/docs/release/14.0/

[^pg14-idle]: PostgreSQL 14 release notes, section E.23.3.1.9. Verbatim: *"Add server parameter idle_session_timeout to close idle sessions (Li Japin). This is similar to idle_in_transaction_session_timeout."* https://www.postgresql.org/docs/release/14.0/

[^idle-session-warning]: PostgreSQL 16 documentation, `idle_session_timeout` GUC description. Verbatim: *"Be wary of enforcing this timeout on connections made through connection-pooling software or other middleware, as such a layer may not react well to unexpected connection closure."* https://www.postgresql.org/docs/16/runtime-config-client.html

[^pg16-reserved]: PostgreSQL 16 release notes, section E.14.3.1.5. Verbatim: *"Allow the server to reserve backend slots for roles with `pg_use_reserved_connections` membership (Nathan Bossart). The number of reserved slots is set by server variable `reserved_connections`."* https://www.postgresql.org/docs/release/16.0/

[^pg17-close]: PostgreSQL 17 release notes, section E.10.3.7. Verbatim: *"Add libpq functions to close portals and prepared statements (Jelte Fennema-Nio). The functions are PQclosePrepared(), PQclosePortal(), PQsendClosePrepared(), and PQsendClosePortal()."* https://www.postgresql.org/docs/release/17.0/

[^pg18-aio]: PostgreSQL 18 release announcement. Async I/O subsystem reduces per-backend I/O wait via `io_method` + worker pool. https://www.postgresql.org/about/news/postgresql-18-released-3142/

[^pgb-usage]: pgBouncer usage documentation, pool-mode descriptions. https://www.pgbouncer.org/usage.html

[^pgb-features]: pgBouncer feature compatibility matrix. https://www.pgbouncer.org/features.html

[^pgb-changelog]: pgBouncer changelog, 1.21.0 release (2023-10-16). Verbatim: *"Add support for protocol-level named prepared statements! This is probably one of the most requested features for PgBouncer."* and *"In synthetic benchmarks this feature was able to increase query throughput anywhere from 15% to 250%, depending on the workload."* and *"To benefit from this new feature you need to change the new `max_prepared_statements` setting to a non-zero value (the exact value depends on your workload, but 100 is probably reasonable)."* https://www.pgbouncer.org/changelog.html

Additional sources consulted:

- PostgreSQL 17 documentation, Section 20.3 "Connections and Authentication" — `reserved_connections` PG16+. https://www.postgresql.org/docs/17/runtime-config-connection.html
- PostgreSQL 18 documentation, same section. https://www.postgresql.org/docs/18/runtime-config-connection.html
- pgBouncer configuration reference. https://www.pgbouncer.org/config.html
- pgcat repository (Rust-based, multi-threaded alternative). https://github.com/postgresml/pgcat
- pgbouncer-fast-switchover (AWS-maintained pgBouncer fork with query rewriting + failover speedup). https://github.com/awslabs/pgbouncer-fast-switchover
- PostgreSQL 15 release notes — no direct pooling-relevant changes confirmed. https://www.postgresql.org/docs/release/15.0/
- PostgreSQL 18 release notes — no direct pooling-feature changes confirmed. https://www.postgresql.org/docs/release/18.0/
- pganalyze blog, "5mins of Postgres: Prepared statements + transaction-mode pooling". https://pganalyze.com/blog/5mins-postgres-pgbouncer-prepared-statements-transaction-mode

# pgBouncer Deep Dive

> [!WARNING] pgBouncer single-process single-threaded
> One pgBouncer process serves ALL clients via `libevent` event loop. Multi-core hosts need multiple pgBouncer instances behind load balancer + peering (1.23+) or `SO_REUSEPORT` for cancellation routing. Vertical scaling caps ~10-20k connections / 60-80k QPS per process depending on workload. Beyond that → multi-instance.

## When to Use This Reference

- Configuring pgBouncer for production (`pool_mode`, sizing, TLS, auth)
- Operational tasks via console (`SHOW POOLS`, `SHOW STATS`, `RELOAD`, `PAUSE`, `RESUME`)
- Enabling prepared statements (PG17 + libpq + `max_prepared_statements`)
- Peering multiple pgBouncer instances for cancellation routing (1.23+)
- Authenticating via `auth_query` against PG vs static `auth_file`
- Diagnosing pool exhaustion / `cl_waiting` / `maxwait` spikes

Sibling files: [`80-connection-pooling.md`](./80-connection-pooling.md) for WHY pool, WHICH mode, sizing math. This file is HOW (config, console, monitoring, multi-instance).

## Table of Contents

- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Architecture](#architecture)
- [Configuration File](#configuration-file)
- [Pool Modes](#pool-modes)
- [GUC Reference](#guc-reference)
- [Console Commands](#console-commands)
- [Per-Database and Per-User Overrides](#per-database-and-per-user-overrides)
- [Prepared Statements](#prepared-statements-pg17)
- [TLS](#tls)
- [Authentication](#authentication)
- [Peering](#peering-pgbouncer-123)
- [Multi-Instance Patterns](#multi-instance-patterns)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## Mental Model

1. **Single-threaded per process**. `libevent`-based. Scales horizontally not vertically. Multi-core hosts need multiple pgBouncer processes behind a load balancer + peering (1.23+) or `SO_REUSEPORT` for cancellation routing.

2. **`pool_mode` default `session`** — keeps connection per client. **`transaction`** = production default for new deployments — releases server connection at `COMMIT`. **`statement`** = rare, breaks transactions.

3. **Two sizing knobs decide everything**. `max_client_conn` = clients allowed in (default 100). `default_pool_size` = server connections out per `(database, user)` pair (default 20). PG `max_connections` must be ≥ sum of all pool sizes across all pgBouncer instances + reserved slots + app-side direct connections.

4. **Console = primary operational surface**. Connect to `pgbouncer` virtual database as `stats_users` / `admin_users`. `SHOW POOLS` for capacity, `SHOW STATS` for throughput, `SHOW CLIENTS` / `SHOW SERVERS` for forensics, `RELOAD` / `PAUSE` / `RESUME` for online ops.

5. **Prepared statements require PG17 libpq + `max_prepared_statements > 0`**[^pg17-libpq]. Default is **200** since pgBouncer 1.21 — not 0[^prepstmt-default]. App driver must use protocol-level prepare (not SQL `PREPARE` / `DEALLOCATE`). Older app drivers using SQL-level PREPARE will not benefit.

## Decision Matrix

| Need | Use | Default | Production value |
|---|---|---|---|
| Default pool mode | `pool_mode` | `session` | `transaction` |
| Total clients pgBouncer accepts | `max_client_conn` | 100 | 1000-5000 |
| Server connections per (db, user) | `default_pool_size` | 20 | 10-50 |
| Burst over default_pool_size | `reserve_pool_size` + `reserve_pool_timeout` | 0 / 5s | 5-10 / 3s |
| Keep idle servers warm | `min_pool_size` | 0 | match default_pool_size |
| Reset connection on checkout | `server_reset_query` | `DISCARD ALL` | keep default |
| Bound idle server reuse | `server_idle_timeout` | 600s | 300-900s |
| Recycle servers periodically | `server_lifetime` | 3600s | 1800-7200s |
| Bound idle-in-tx clients | `idle_transaction_timeout` | 0 (off) | 30-60s |
| Bound any one query | `query_timeout` | 0 (off) | 0 cluster-wide; per-DB |
| Bound queue wait | `query_wait_timeout` | 120s | 30-60s for latency-sensitive |
| Enable prepared statements | `max_prepared_statements` | 200 | 200-1000 |
| Auth via PG catalog lookup | `auth_query` | — | use this |
| HA cancellation routing | `peers` section | — | 1.23+ multi-instance |

Three smell signals — if you see these, fix at this layer:

- `cl_waiting > 0` sustained → `default_pool_size` too low OR queries too slow. First check `SHOW POOLS`; second check `pg_stat_activity` server-side.
- `maxwait > 5s` → app is timing out before pgBouncer even forwards request. Latency cliff.
- Lots of `closed_in_use` / `closed_idle` in `SHOW STATS_TOTALS` → server connections churning. `server_lifetime` too short OR network flapping.

## Architecture

```
                   client          client          client
                     │               │               │
                     ▼               ▼               ▼
                  ┌────────────────────────────────────┐
                  │           pgBouncer process        │
                  │  ┌──────────────┐  ┌────────────┐  │
                  │  │ libevent     │  │ admin DB   │  │
                  │  │ event loop   │  │ (console)  │  │
                  │  └──────────────┘  └────────────┘  │
                  │  ┌──────────────────────────────┐  │
                  │  │ per-(database, user) pools   │  │
                  │  │  active / idle / used        │  │
                  │  └──────────────────────────────┘  │
                  └────────────────────────────────────┘
                                   │
                                   ▼  (server connections)
                  ┌────────────────────────────────────┐
                  │        PostgreSQL backend          │
                  └────────────────────────────────────┘
```

Five operational facts:

1. **One process, one thread**. `accept()` + `recv()` + `send()` multiplexed via `libevent`. CPU-bound at high QPS — measure with `perf top` / `top` if `cl_waiting` non-zero AND PG backends are idle.

2. **Client auth happens at pgBouncer**. PG never sees raw client password under `auth_type = scram-sha-256` / `md5` — pgBouncer validates against `auth_file` or `auth_query` result, then opens its own authenticated server connection.

3. **Per-`(database, user)` pool**. Two users connecting to same database → two separate pools, two separate `default_pool_size` budgets.

4. **`pgbouncer` virtual database** = console. Connect with `psql -p 6432 -d pgbouncer -U admin` (no password if `admin_users` matches). Cannot run regular SQL — only `SHOW`, `RELOAD`, `PAUSE`, `RESUME`, `KILL`, `SUSPEND`, `SHUTDOWN`, `SET`.

5. **No query parsing**. pgBouncer forwards bytes. Does NOT understand SQL. Cannot rewrite queries, route based on read/write, or load-balance to replicas. For query-aware routing use pgcat / pgpool-II / app-side logic.

## Configuration File

`pgbouncer.ini` has four sections.

```ini
[databases]
; database aliases → real connections
appdb_web      = host=10.0.0.5 port=5432 dbname=appdb pool_size=30 pool_mode=transaction
appdb_reporter = host=10.0.0.5 port=5432 dbname=appdb pool_size=5  pool_mode=session
appdb_batch    = host=10.0.0.5 port=5432 dbname=appdb pool_size=3  pool_mode=session
* = host=10.0.0.5 port=5432       ; fallback for unlisted DBs

[users]
; per-user pool overrides
webapp = pool_size=30 max_user_connections=60
reporter = pool_mode=session

[peers]                              ; pgBouncer 1.23+ — see Peering section
1 = host=pgb-a port=6432
2 = host=pgb-b port=6432

[pgbouncer]
; main config
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_user = pgbouncer_authuser
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename = $1

pool_mode = transaction
max_client_conn = 2000
default_pool_size = 20
reserve_pool_size = 5
reserve_pool_timeout = 3

server_idle_timeout = 600
server_lifetime = 3600
idle_transaction_timeout = 60
query_wait_timeout = 30

max_prepared_statements = 200
server_reset_query = DISCARD ALL

admin_users = pgb_admin
stats_users = pgb_stats

logfile = /var/log/pgbouncer/pgbouncer.log
pidfile = /run/pgbouncer/pgbouncer.pid
```

Five rules:

- **`[databases]` aliases give isolation**. Same physical DB exposed three times = three independent pools with different sizes and modes. Recipe 3.
- **`*` fallback** routes unlisted client-supplied DB names. Useful for multi-tenant; risky if you intend to whitelist.
- **`pool_mode` is per-database AND per-user**, overrideable. Per-user overrides per-database.
- **`peer_id`** is THIS pgBouncer's ID in the `[peers]` map. Must be unique per instance.
- **`auth_query`** runs against PG to fetch credentials for unlisted users. Avoids syncing `auth_file` across many users.

## Pool Modes

Three verbatim from `usage.html`[^poolmodes]:

- **`session`**: *"Most polite method. When a client connects, a server connection will be assigned to it for the whole duration the client stays connected. When the client disconnects, the server connection will be put back into the pool."*
- **`transaction`**: *"A server connection is assigned to a client only during a transaction. When PgBouncer notices that transaction is over, the server connection will be put back into the pool."*
- **`statement`**: *"Most aggressive method. The server connection will be put back into the pool immediately after a query completes. Multi-statement transactions are disallowed in this mode as they would break the assumption of statement pooling."*

`statement` mode breaks transactions outright — every `BEGIN ... COMMIT` block fails. Use only for app code that issues single-statement autocommit queries (rare).

For the feature compatibility matrix per mode (SET, LISTEN, advisory locks, etc.) see [`80-connection-pooling.md`](./80-connection-pooling.md#three-pool-modes).

## GUC Reference

Top settings grouped by concern. Default + production-typical value.

### Pool sizing

| Setting | Default | Effect |
|---|---|---|
| `max_client_conn` | 100 | Total client connections pgBouncer accepts before refusing new. |
| `default_pool_size` | 20 | Per (database, user) server connections. |
| `min_pool_size` | 0 | Always keep at least this many open. Lowers cold-start latency. |
| `reserve_pool_size` | 0 | Burst capacity beyond pool_size when `reserve_pool_timeout` exceeded. |
| `reserve_pool_timeout` | 5.0 s | How long a client waits before reserve_pool slots are used. |
| `max_db_connections` | 0 (∞) | Cluster-wide cap across all users per database. |
| `max_user_connections` | 0 (∞) | Cluster-wide cap across all databases per user. |

### Timeouts

| Setting | Default | Effect |
|---|---|---|
| `server_idle_timeout` | 600.0 s | Drop idle server connection after this. |
| `server_lifetime` | 3600.0 s | Cycle server connections regardless of activity. |
| `client_idle_timeout` | 0.0 (off) | Drop idle client (not in tx). |
| `idle_transaction_timeout` | 0.0 (off) | Drop client whose tx idles this long. Cross-ref [27](./27-mvcc-internals.md). |
| `query_timeout` | 0.0 (off) | Kill query running longer. **Use server-side `statement_timeout` instead — cross-ref [41](./41-transactions.md).** |
| `query_wait_timeout` | 120.0 s | Drop client whose query hasn't been forwarded after this. |
| `cancel_wait_timeout` | 10.0 s | How long to wait for a cancel request to be forwarded. |

### Server connection hygiene

| Setting | Default | Effect |
|---|---|---|
| `server_reset_query` | `DISCARD ALL` | Run on checkout/return. Resets session state. |
| `server_check_query` | empty | Optional liveness check before handing server to client. |
| `server_check_delay` | 30.0 s | Skip check if server used within this window. |
| `server_fast_close` | 0 | If 1, close server connection at end of in-progress transaction when client disconnects. |

### Prepared statements

| Setting | Default | Effect |
|---|---|---|
| `max_prepared_statements` | **200**[^prepstmt-default] | Per-connection cache of protocol-level prepared statements. Set to 0 to disable. |

### TLS — client side (incoming)

| Setting | Default | Effect |
|---|---|---|
| `client_tls_sslmode` | `disable` | `disable` / `allow` / `prefer` / `require` / `verify-ca` / `verify-full`. |
| `client_tls_key_file` | — | Server private key. |
| `client_tls_cert_file` | — | Server certificate. |
| `client_tls_ca_file` | — | CA for client cert verification. |
| `client_tls_protocols` | `secure` | TLS version list. |
| `client_tls_ciphers` | `default` | TLS<1.3 cipher list. |
| `client_tls_tls13_ciphers` | (OpenSSL default) | TLS 1.3 ciphersuites (1.25+). |

### TLS — server side (outgoing to PG)

| Setting | Default | Effect |
|---|---|---|
| `server_tls_sslmode` | `prefer` | Same enum as client. |
| `server_tls_key_file` | — | Client private key presented to PG. |
| `server_tls_cert_file` | — | Client certificate presented to PG. |
| `server_tls_ca_file` | — | CA for verifying PG's server cert. |
| `server_tls_protocols` | `secure` | TLS version list. |

### Authentication

| Setting | Default | Effect |
|---|---|---|
| `auth_type` | `md5` | `cert` / `md5` / `scram-sha-256` / `plain` / `trust` / `any` / `hba` / `ldap` / `pam` / `peer`[^authtype]. Production = `scram-sha-256`. |
| `auth_file` | — | Path to `"user" "hashed-password"` lines. |
| `auth_user` | — | PG user used by `auth_query` to look up credentials. |
| `auth_query` | `SELECT usename, passwd FROM pg_shadow WHERE usename = $1` | Override default catalog query. |
| `auth_hba_file` | — | `pg_hba.conf`-style file used when `auth_type = hba`. |

### Logging and admin

| Setting | Default | Effect |
|---|---|---|
| `admin_users` | — | Users with full console access. |
| `stats_users` | — | Users with read-only `SHOW` access. |
| `log_connections` | 1 | Log client connect/disconnect. |
| `log_disconnections` | 1 | — |
| `log_pooler_errors` | 1 | — |
| `verbose` | 0 | 0-3, more = noisier. |

## Console Commands

Connect via `psql -p 6432 -d pgbouncer -U admin -h /run/pgbouncer` (or whatever socket dir). Cannot run regular SQL. Quoting from `usage.html`[^console].

### Read-only — capacity and throughput

`SHOW POOLS` — per-pool state with verbatim columns[^showpools]:

- `cl_active`: Client connections that are linked to server connection.
- `cl_waiting`: *"Client connections that have sent queries but have not yet got a server connection."*
- `sv_active` / `sv_idle` / `sv_used` / `sv_tested` / `sv_login`: Server connections by state.
- `maxwait`: *"How long the first (oldest) client in the queue has waited, in seconds. If this starts increasing, then the current pool of servers does not handle requests quickly enough."*
- `maxwait_us`: *"Microsecond part of the maximum waiting time."*

`SHOW STATS` — cumulative totals per database with verbatim columns[^showstats]:

- `total_xact_count`: *"Total number of SQL transactions pooled by pgbouncer."*
- `total_query_count`: *"Total number of SQL commands pooled by pgbouncer."*
- `total_received` / `total_sent`: Bytes counters.
- `avg_query_time`: *"Average query duration, in microseconds."*
- `avg_xact_time` / `avg_query_count` / `avg_recv` / `avg_sent`.

`SHOW STATS_TOTALS` — same as `SHOW STATS` but only totals.

`SHOW STATS_AVERAGES` — same as `SHOW STATS` but only averages.

`SHOW DATABASES` — config + current connection counts per database.

`SHOW CLIENTS` — one row per client. Has `ptr`, `state`, `wait` columns for forensics.

`SHOW SERVERS` — one row per server connection. Shows `application_name`, `link` (client ptr currently using this server), `state` (`active` / `idle` / `used`).

`SHOW CONFIG` — every GUC and its source.

`SHOW VERSION`.

`SHOW USERS`.

`SHOW LISTS` — high-level resource counts.

`SHOW MEM` — per-cache memory breakdown.

`SHOW PEERS` — peer table (1.23+).

`SHOW PREPARED_STATEMENTS` — protocol-level prepared statement cache state (1.21+).

### Write — operational

`RELOAD` — reload `pgbouncer.ini`, `auth_file`, `auth_hba_file` without restart[^reload]. Database connection-string changes trigger automatic server reconnection.

`PAUSE [db]` — *"PgBouncer tries to disconnect from all servers... The command will not return before all server connections have been disconnected."*[^pause]. Use before PG restart or failover.

`RESUME [db]` — *"Resume work from previous KILL, PAUSE, or SUSPEND command."*

`KILL db` — drop all client and server connections on a database immediately.

`KILL_CLIENT client_id` — drop a specific client (1.24+).

`SUSPEND` — flush all sockets, stop reading data. Used before online restart (pass open FDs to new process via socket activation).

`SHUTDOWN` — exit.

`RECONNECT` — gracefully recycle server connections.

`DISABLE` / `ENABLE` — block/unblock new connections to a database.

`SET key = value` — change runtime setting (not all settings reloadable this way).

### Cannot reload via RELOAD

- `listen_addr` / `listen_port`
- `unix_socket_dir`
- `auth_type` changes that require new socket setup
- `peer_id`

These require full restart.

## Per-Database and Per-User Overrides

In `[databases]`, per-DB overrides:

```ini
appdb_web      = host=10.0.0.5 dbname=appdb pool_size=30 pool_mode=transaction max_db_connections=60
appdb_reporter = host=10.0.0.5 dbname=appdb pool_size=5  pool_mode=session
```

In `[users]`, per-user overrides:

```ini
webapp = pool_size=30 pool_mode=transaction max_user_connections=100
reporter = pool_mode=session reserve_pool_size=2
```

**Resolution order**: per-user > per-database > `[pgbouncer]` defaults.

Use case: same physical PG database, three logical roles with different mode requirements. Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md) for per-role server-side baseline (statement_timeout, default_transaction_isolation, etc.) — pgBouncer can override `pool_mode` but cannot set PG-side GUCs.

## Prepared Statements (PG17+)

Pre-1.21 → SQL `PREPARE` / `EXECUTE` tied to specific backend → broken in transaction mode → big perf miss because every query reparsed.

Since pgBouncer 1.21 (Oct 2023) + libpq 17 (Sep 2024):

> [!NOTE] PostgreSQL 17 / pgBouncer 1.21
> *"Add support for protocol-level named prepared statements! This is probably one of the most requested features for PgBouncer. Using prepared statements together with PgBouncer can reduce the CPU load on your system a lot... In synthetic benchmarks this feature was able to increase query throughput anywhere from 15% to 250%, depending on the workload."*[^prepstmt-changelog]

Mechanism: pgBouncer caches the protocol-level prepared statement per server connection. On checkout, sends `Parse` to server only if not cached, else just `Bind` + `Execute`.

Three requirements:

1. **`max_prepared_statements > 0`** in `pgbouncer.ini`. Default is 200 since 1.21[^prepstmt-default] — already enabled out of the box.
2. **App driver uses protocol-level prepare** (libpq `PQprepare()` / JDBC `PreparedStatement` / psycopg `prepare()` / pgx `Prepare()`). NOT SQL-level `PREPARE foo AS ...`.
3. **For full transaction-mode safety, PG 17+ libpq with `PQclosePrepared()` / `PQclosePortal()`** so the protocol-level Close support advertised by pgBouncer is honored.

Verify via console:

```sql
SHOW PREPARED_STATEMENTS;
```

Returns per-pool cache stats: `prepared_statements`, `prepared_statements_global`.

For DEALLOCATE / DISCARD ALL interaction (added 1.22): `server_reset_query = DISCARD ALL` will NOT clear the protocol-level prepared cache. pgBouncer maintains the cache across resets explicitly.

Recipe 9.

## TLS

Two independent stacks: client-side (clients → pgBouncer) and server-side (pgBouncer → PG). Different keys, certs, modes per side. Set both.

```ini
client_tls_sslmode = require
client_tls_key_file = /etc/pgbouncer/server.key
client_tls_cert_file = /etc/pgbouncer/server.crt
client_tls_ca_file = /etc/pgbouncer/clients-ca.crt
client_tls_protocols = secure
client_tls_tls13_ciphers = TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256

server_tls_sslmode = verify-full
server_tls_key_file = /etc/pgbouncer/pgb-client.key
server_tls_cert_file = /etc/pgbouncer/pgb-client.crt
server_tls_ca_file = /etc/pgbouncer/pg-server-ca.crt
```

Trap: setting only `client_tls_sslmode = require` while leaving `server_tls_sslmode = prefer` means clients are encrypted to pgBouncer but pgBouncer may connect to PG in cleartext if PG offers it. Always set both to `require` or `verify-full` for end-to-end. Cross-ref [`49-tls-ssl.md`](./49-tls-ssl.md).

PG 18 + pgBouncer 1.25 → SCRAM passthrough via `auth_type = scram-sha-256` + matching credentials end-to-end with channel binding. Cross-ref [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md).

PG18 client-side direct TLS startup (skip the StartupMessage TLS request) → pgBouncer 1.25+ supports it server-side.

## Authentication

Two mechanisms.

**`auth_file`** — static list:

```
"webapp" "SCRAM-SHA-256$4096:..."
"reporter" "SCRAM-SHA-256$4096:..."
```

Generate hashes via PG and copy from `pg_shadow.passwd`. Reload via `RELOAD` console command.

Drawback: manual sync on every role change.

**`auth_query`** — query PG for credentials per user:

```ini
auth_type = scram-sha-256
auth_user = pgbouncer_authuser
auth_query = SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname = $1 AND rolcanlogin
```

Requires:

1. `pgbouncer_authuser` PG role with `SELECT` on `pg_authid` (typically via security-definer wrapper function since `pg_authid` is restricted).
2. Credentials for `pgbouncer_authuser` in `auth_file` (chicken-and-egg).

Recommended wrapper function so `auth_query` runs without superuser:

```sql
CREATE OR REPLACE FUNCTION public.pgbouncer_get_auth(p_usename text)
  RETURNS TABLE (usename name, passwd text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT usename, passwd FROM pg_shadow WHERE usename = $1;
$$;

REVOKE EXECUTE ON FUNCTION public.pgbouncer_get_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgbouncer_get_auth(text) TO pgbouncer_authuser;
```

Then:

```ini
auth_query = SELECT usename, passwd FROM public.pgbouncer_get_auth($1)
```

For pgBouncer 1.22+ per-database `auth_query` lets you point different databases at different lookup functions.

## Peering (pgBouncer 1.23+)

Problem before peering: PG cancellation requests (Ctrl-C) only routed correctly if the same pgBouncer process received both the original query and the cancel. Behind a load balancer hashing per-connection, cancels could hit a different pgBouncer instance with no record of the original.

> [!NOTE] pgBouncer 1.23 (2024-07-03)
> *"Add support for peering between PgBouncer processes. This allows configuring PgBouncer such that cancellation requests continue to work when multiple different PgBouncer processes are behind a single load balancer."*[^peering]

Setup:

```ini
# pgbouncer-a.ini
peer_id = 1
[peers]
1 = host=pgb-a port=6432 pool_size=10
2 = host=pgb-b port=6432 pool_size=10
3 = host=pgb-c port=6432 pool_size=10
```

```ini
# pgbouncer-b.ini
peer_id = 2
[peers]
1 = host=pgb-a port=6432
2 = host=pgb-b port=6432
3 = host=pgb-c port=6432
```

Each pgBouncer instance has a unique `peer_id`. When a cancel arrives at instance 2 for a query running on instance 1, instance 2 forwards via the peer table.

Inspect with `SHOW PEERS`.

## Multi-Instance Patterns

Vertical scaling of pgBouncer caps. Three patterns for going beyond.

### Pattern A — Multi-instance behind HAProxy

```
        clients
           │
           ▼
       ┌─────────┐
       │ HAProxy │  TCP load-balance on port 5432
       └─────────┘
        │       │
        ▼       ▼
    pgBouncer  pgBouncer       (peers + same backend)
        │       │
        └───┬───┘
            ▼
            PG primary
```

Each pgBouncer = own process, own pool. Total server connections = N_instances × default_pool_size — must fit under PG `max_connections`. Peering routes cancels.

### Pattern B — Multi-instance via `SO_REUSEPORT`

Multiple pgBouncer processes on same host bind to same TCP port via `SO_REUSEPORT` (Linux). Kernel load-balances accept() across them. Requires `so_reuseport = 1` in each instance's config.

```ini
so_reuseport = 1
listen_port = 6432
peer_id = 1     ; 2, 3, ... per instance
[peers]
1 = host=127.0.0.1 port=6432
2 = host=127.0.0.1 port=6432
...
```

All instances on same host, same port. Cancel routing via peering.

### Pattern C — Sidecar per app pod (K8s)

Each app pod has a co-located pgBouncer container connecting via Unix socket. Pool count = pod count. Trivial peering (cancels stay within pod). Scales horizontally with the app.

Cross-ref [`78-ha-architectures.md`](./78-ha-architectures.md) for pgBouncer + Patroni + HAProxy three-layer integration.

## Per-Version Timeline

| Version | Released | Headline items |
|---|---|---|
| 1.21.0 | 2023-10-16 | Protocol-level prepared statements (15-250% throughput[^prepstmt-changelog]) |
| 1.22.0 | 2024-01-31 | DEALLOCATE ALL / DISCARD ALL with prepared statements; per-database `auth_query`; systemd improvements |
| 1.23.0 | 2024-07-03 | Peering (cancel routing across instances)[^peering] |
| 1.24.0 | 2025-01-10 | `KILL_CLIENT`; per-user / per-database limits; prepared-statement usage counters; `client_idle_timeout`; PAM in HBA |
| 1.24.1 | 2025-04-16 | CVE-2025-2291 fix (password expiration handling) |
| 1.25.0 | 2025-11-09 | LDAP auth; client-side direct TLS; transaction timeouts; configurable SCRAM iterations; TLS 1.3 cipher selection |
| 1.25.1 | 2025-12-03 | CVE-2025-12819 fix |
| 1.25.2 | 2026-05-08 | CVE-2026-6664 through 6667 fixes |

Latest at write time = **1.25.2** (2026-05-08).

## Recipes

### Recipe 1 — Production baseline pgbouncer.ini

```ini
[databases]
appdb = host=10.0.0.5 port=5432 dbname=appdb

[users]
webapp = pool_size=30 pool_mode=transaction
reporter = pool_size=5 pool_mode=session
batchjobs = pool_size=3 pool_mode=session

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir = /var/run/postgresql

auth_type = scram-sha-256
auth_user = pgbouncer_authuser
auth_query = SELECT usename, passwd FROM public.pgbouncer_get_auth($1)
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
max_client_conn = 2000
default_pool_size = 20
reserve_pool_size = 5
reserve_pool_timeout = 3
min_pool_size = 5

server_idle_timeout = 600
server_lifetime = 3600
idle_transaction_timeout = 60
query_wait_timeout = 30

server_reset_query = DISCARD ALL
max_prepared_statements = 200

client_tls_sslmode = require
client_tls_key_file = /etc/pgbouncer/server.key
client_tls_cert_file = /etc/pgbouncer/server.crt
server_tls_sslmode = verify-full
server_tls_ca_file = /etc/pgbouncer/pg-ca.crt

admin_users = pgb_admin
stats_users = pgb_stats, monitoring

logfile = /var/log/pgbouncer/pgbouncer.log
log_connections = 1
log_disconnections = 1
verbose = 0

pidfile = /run/pgbouncer/pgbouncer.pid
```

Capacity math: 2000 clients × 1 server connection = max 2000 backends if every client active. Default pool size 20 × (webapp + reporter + batchjobs + admin) = ~80 actual server connections steady state. PG `max_connections` should be set to handle peak (e.g., 200) + reserved slots.

### Recipe 2 — Verify production config

```bash
pgbouncer -V                          # version
pgbouncer -V -V                       # version + build flags
pgbouncer -d /etc/pgbouncer/pgbouncer.ini    # start daemonized
```

From console:

```sql
SHOW VERSION;
SHOW CONFIG;                          -- diff from defaults
SHOW DATABASES;                       -- verify [databases] section parsed
SHOW USERS;                           -- verify per-user overrides
SHOW POOLS;                           -- per-(database, user) pools
```

### Recipe 3 — Three pools, one physical database

Same `appdb` exposed three times with different sizing per role.

```ini
[databases]
appdb_web      = host=10.0.0.5 dbname=appdb pool_size=30 pool_mode=transaction
appdb_reporter = host=10.0.0.5 dbname=appdb pool_size=5  pool_mode=session
appdb_batch    = host=10.0.0.5 dbname=appdb pool_size=3  pool_mode=session
```

App connection strings:

```
postgresql://webapp@pgbouncer:6432/appdb_web
postgresql://reporter@pgbouncer:6432/appdb_reporter
postgresql://batchjobs@pgbouncer:6432/appdb_batch
```

Reporter and batch get separate pools — long-running query in `appdb_reporter` cannot starve `appdb_web`.

### Recipe 4 — Monitor pool exhaustion

From console (run periodically via [`98-pg-cron.md`](./98-pg-cron.md) or postgres_exporter[^exporter]):

```sql
SHOW POOLS;
```

Alert if `cl_waiting > 0` AND `maxwait > 2s` sustained for >5 minutes. Either pool too small or queries too slow. Cross-ref [`80-connection-pooling.md`](./80-connection-pooling.md) Recipe 11/12.

### Recipe 5 — Pre-PG-restart drain

```sql
-- on pgBouncer console
PAUSE;                  -- waits for all in-progress transactions to commit/rollback
-- now restart PG
RESUME;                 -- pgBouncer reopens server connections lazily
```

`PAUSE` blocks the console call until every server connection is closed. Clients sending new queries during PAUSE see them queue (`SHOW POOLS` will show `cl_waiting`). When `RESUME`, queued queries forward.

### Recipe 6 — Reload config without restart

```bash
# edit /etc/pgbouncer/pgbouncer.ini
psql -p 6432 -d pgbouncer -U pgb_admin -c 'RELOAD'
```

Or via systemd: `kill -HUP $(cat /run/pgbouncer/pgbouncer.pid)`.

`RELOAD` is enough for: pool sizes, timeouts, server_reset_query, auth_query, auth_file changes, per-database/user entries. NOT enough for: `listen_addr`, `listen_port`, `peer_id`, `unix_socket_dir`. These require full restart.

### Recipe 7 — Enable prepared statements + verify

```ini
max_prepared_statements = 200       # 1.21+ default — explicit for clarity
```

After `RELOAD`, run an app workload that uses protocol-level prepare. Then:

```sql
SHOW PREPARED_STATEMENTS;
```

Expect non-zero `prepared_statements_global`. Audit cluster-side via `pg_stat_statements` showing stable `queryid` rows for parameterized queries[^pg-stat-statements].

If `prepared_statements_global` is 0 → app driver is using SQL-level `PREPARE`, not protocol-level. Switch driver / connection-string flag (e.g., psycopg `prepare_threshold`).

### Recipe 8 — Migrate from `auth_file` to `auth_query`

Goal: stop syncing `userlist.txt` on every role change.

1. Create wrapper function on every database that needs auth (typically just app DB):

   ```sql
   CREATE ROLE pgbouncer_authuser WITH LOGIN PASSWORD 'changeme';

   CREATE OR REPLACE FUNCTION public.pgbouncer_get_auth(p_usename text)
     RETURNS TABLE (usename name, passwd text)
     LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
   AS $$ SELECT usename, passwd FROM pg_shadow WHERE usename = $1 $$;

   REVOKE EXECUTE ON FUNCTION public.pgbouncer_get_auth(text) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION public.pgbouncer_get_auth(text) TO pgbouncer_authuser;
   ```

2. Add `pgbouncer_authuser` credential to `auth_file` (the only credential it needs to contain).

3. Update `pgbouncer.ini`:

   ```ini
   auth_user = pgbouncer_authuser
   auth_query = SELECT usename, passwd FROM public.pgbouncer_get_auth($1)
   ```

4. `RELOAD`. New users created in PG are now usable through pgBouncer immediately.

### Recipe 9 — Find long-running queries on the server side

pgBouncer hides individual queries behind transaction-mode pooling. Use `application_name_add_host = 1` + `application_name` per client to attribute server-side rows back to client.

In `pgbouncer.ini`:

```ini
application_name_add_host = 1
```

Then `pg_stat_activity` shows `application_name` like `webapp - 10.0.0.42`, letting you trace a single client.

Cross-ref [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

### Recipe 10 — Peering setup for two-instance HA

Two pgBouncer instances behind HAProxy, mutual peering so cancels route correctly.

```ini
# pgbouncer on host-a — pgbouncer.ini
peer_id = 1
listen_addr = 0.0.0.0
[peers]
1 = host=10.0.0.10 port=6432
2 = host=10.0.0.11 port=6432
```

```ini
# pgbouncer on host-b
peer_id = 2
listen_addr = 0.0.0.0
[peers]
1 = host=10.0.0.10 port=6432
2 = host=10.0.0.11 port=6432
```

HAProxy config (excerpt):

```
backend pgbouncer
    mode tcp
    balance roundrobin
    server pgb-a 10.0.0.10:6432 check
    server pgb-b 10.0.0.11:6432 check
```

Verify:

```sql
-- on pgBouncer 1
SHOW PEERS;
```

Test cancellation via long-running query + Ctrl-C through HAProxy → cancel should hit either instance and route correctly.

### Recipe 11 — Online restart via SUSPEND + socket-passing

PgBouncer supports zero-downtime restart on Linux via systemd socket activation. Sequence:

```sql
SUSPEND;                              -- flush sockets, stop reading
```

```bash
# new pgbouncer process starts with same listening socket inherited
systemctl restart pgbouncer
```

```sql
RESUME;                               -- on new process
```

Alternative: rely on peering + rolling restart — drain instance A via `PAUSE`, restart, repeat for B. HAProxy health-check failure routes around the down instance.

### Recipe 12 — Drop a specific client

Kick a misbehaving session without affecting others (1.24+):

```sql
SHOW CLIENTS;
-- find client_id of offending row
KILL_CLIENT <client_id>;
```

Pre-1.24 you had to `KILL <database>` which dropped EVERY client on the database — heavy hammer.

### Recipe 13 — Diagnose "connections refused" errors

Symptom: clients see `FATAL: connection limit exceeded` from pgBouncer (not from PG).

Check:

```sql
SHOW POOLS;
-- look at cl_active per pool — is it at max_client_conn?
SHOW LISTS;
-- "used clients" and "free clients" at the bottom
```

If `used_clients` ≈ `max_client_conn`, raise `max_client_conn`. If `cl_waiting > 0` AND `sv_active = pool_size`, raise `default_pool_size` OR add `reserve_pool_size`.

If clients are leaking (long-lived idle connections from buggy app) — set `client_idle_timeout = 1800` to bound idle client lifetime.

## Gotchas / Anti-patterns

1. **`pool_mode = transaction` + `SET` without `SET LOCAL`** — server-side GUC persists across transactions on the server connection. Next client gets the leaked GUC. Cross-ref [`80-connection-pooling.md`](./80-connection-pooling.md) gotcha #3.

2. **`max_client_conn` too low default 100** — most production deployments need 1000-5000. Update first, don't leave at default.

3. **`default_pool_size = 20` × 100 DBs × 100 users** = 200,000 potential backends. Pool sizing must consider all distinct `(database, user)` pairs. Set `max_db_connections` and `max_user_connections` to cap total.

4. **Pre-1.21 SQL-level PREPARE broken in transaction mode** — every reuse of a server connection wipes the prepared plan. Migrate to protocol-level prepare AND pgBouncer 1.21+.

5. **`max_prepared_statements = 0` disables protocol-level prepared statements entirely**. Default is 200 since 1.21 — only set to 0 if you have a specific reason.

6. **`server_reset_query = DISCARD ALL` does NOT clear protocol-level prepared statement cache** (1.21+). pgBouncer maintains it separately. If you need full reset, restart server connections (kill via `server_lifetime`).

7. **TLS only configured on client side** — `client_tls_sslmode = require` does NOT imply server-side TLS. Set both `client_tls_*` AND `server_tls_*`.

8. **`auth_file` SCRAM hash format mismatch** — must match `pg_shadow.passwd` exactly. Wrong format → silent auth failure with cryptic log. Use `auth_query` to avoid manual sync.

9. **`auth_query` against `pg_shadow`/`pg_authid` requires elevated permission** — superuser, or wrapper function with `SECURITY DEFINER`. Never grant `pg_read_all_data` to `auth_user` blindly.

10. **`statement` mode breaks transactions outright** — `BEGIN ... COMMIT` blocks fail with cryptic error. Almost never the right choice.

11. **`RELOAD` does NOT reload `listen_port` / `listen_addr` / `unix_socket_dir`** — these require full restart. Test config changes in staging.

12. **`PAUSE` blocks the console session until all servers disconnect** — if any transaction never commits, PAUSE never returns. Use `PAUSE <database>` per-DB or `KILL <database>` if you need to force.

13. **`KILL <database>` drops EVERY client + server connection on that database** — disruptive. Use `KILL_CLIENT <id>` (1.24+) for surgical removal.

14. **pgBouncer is single-threaded** — at high QPS (>30k QPS sustained) a single instance saturates one CPU. Scale horizontally with peering + load balancer or `SO_REUSEPORT`.

15. **`server_lifetime = 3600` recycles even idle connections** — every hour every server connection gets dropped + reconnected. On TLS-heavy deployments this is non-trivial overhead. Tune up to 7200-14400 if cluster restarts are rare.

16. **`idle_transaction_timeout` is pgBouncer-side**. Server-side `idle_in_transaction_session_timeout` is separate. Both can be active — pgBouncer trips first. Cross-ref [`41-transactions.md`](./41-transactions.md).

17. **Cancellation requests routed by IP:port** — without peering (pre-1.23), multi-instance pgBouncer behind a load balancer drops cancels. Always set up peering for HA deployments.

18. **`application_name` not forwarded by default** — set `application_name_add_host = 1` so `pg_stat_activity.application_name` is useful for tracing.

19. **`pgbouncer` virtual database is admin-only** — connecting as a regular user fails. Add user to `admin_users` (full control) or `stats_users` (read-only `SHOW`).

20. **No native query rewriting / read-write splitting** — pgBouncer forwards bytes. For read replica routing use pgcat / pgpool-II / app-side connection-string switching.

21. **`max_db_connections` cap is per-pgBouncer-instance** — N instances × cap = total server connections. Coordinate across instances.

22. **PG `max_connections` must exceed total pool capacity** — N_instances × default_pool_size × N_(db,user)_pairs + reserve + admin slots. Otherwise pgBouncer queues clients waiting for PG slots that don't exist.

23. **CVE-2025-2291 / CVE-2025-12819 / CVE-2026-6664..6667** — security advisories in 1.24.1, 1.25.1, 1.25.2. Stay on latest patch release.

## See Also

- [`80-connection-pooling.md`](./80-connection-pooling.md) — why pool, sizing math, pool-mode feature matrix
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — `PAUSE` / `RESUME` pgBouncer before pg_dump on high-load source
- [`41-transactions.md`](./41-transactions.md) — `idle_in_transaction_session_timeout`, server-side transaction control
- [`46-roles-privileges.md`](./46-roles-privileges.md) — per-role server-side GUCs + transaction-mode pool caveat
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — SCRAM mechanics on PG side
- [`49-tls-ssl.md`](./49-tls-ssl.md) — TLS deep dive
- [`56-explain.md`](./56-explain.md) — diagnosing slow queries surfacing as `cl_waiting`
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — server-side query attribution
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity` + `application_name`
- [`78-ha-architectures.md`](./78-ha-architectures.md) — pgBouncer + Patroni + HAProxy integration
- [`82-monitoring.md`](./82-monitoring.md) — postgres_exporter / pgbouncer_exporter
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — pgBouncer sidecar patterns

## Sources

[^poolmodes]: https://www.pgbouncer.org/usage.html — Pool modes section, verbatim definitions for `session`, `transaction`, `statement`.
[^showpools]: https://www.pgbouncer.org/usage.html — `SHOW POOLS` columns reference.
[^showstats]: https://www.pgbouncer.org/usage.html — `SHOW STATS` columns reference.
[^console]: https://www.pgbouncer.org/usage.html — full console-command catalog including `RELOAD`, `PAUSE`, `RESUME`, `KILL`, `KILL_CLIENT`, `SUSPEND`, `SHUTDOWN`, `RECONNECT`, `DISABLE`, `ENABLE`.
[^reload]: https://www.pgbouncer.org/usage.html — *"The PgBouncer process will reload its configuration files and update changeable settings. This includes the main configuration file as well as the files specified by the settings `auth_file` and `auth_hba_file`."*
[^pause]: https://www.pgbouncer.org/usage.html — *"PgBouncer tries to disconnect from all servers... The command will not return before all server connections have been disconnected."*
[^prepstmt-changelog]: https://www.pgbouncer.org/changelog.html — 1.21.0 release notes (2023-10-16): *"Add support for protocol-level named prepared statements! This is probably one of the most requested features for PgBouncer. Using prepared statements together with PgBouncer can reduce the CPU load on your system a lot (both at the PgBouncer side and the PostgreSQL side). In synthetic benchmarks this feature was able to increase query throughput anywhere from 15% to 250%, depending on the workload."*
[^prepstmt-default]: https://www.pgbouncer.org/config.html — `max_prepared_statements` default is **200** since pgBouncer 1.21. Setting to 0 disables prepared statement support entirely.
[^pg17-libpq]: https://www.postgresql.org/docs/17/libpq-exec.html — PG17 added `PQclosePrepared()` and `PQclosePortal()` enabling clean transaction-mode prepared statement use with pgBouncer.
[^peering]: https://www.pgbouncer.org/changelog.html — 1.23.0 release notes (2024-07-03): *"Add support for peering between PgBouncer processes. This allows configuring PgBouncer such that cancellation requests continue to work when multiple different PgBouncer processes are behind a single load balancer."*
[^authtype]: https://www.pgbouncer.org/config.html — `auth_type` valid values: `cert`, `md5`, `scram-sha-256`, `plain` (deprecated), `trust`, `any`, `hba`, `ldap` (1.25+), `pam`, `peer`.
[^exporter]: https://github.com/prometheus-community/pgbouncer_exporter — Prometheus exporter for pgBouncer console metrics.
[^pg-stat-statements]: https://www.postgresql.org/docs/17/pgstatstatements.html — Server-side query observability complementing pgBouncer console.

Additional sources:

- pgBouncer home: https://www.pgbouncer.org/
- Configuration reference: https://www.pgbouncer.org/config.html
- Features compatibility matrix: https://www.pgbouncer.org/features.html
- Install + build: https://www.pgbouncer.org/install.html
- FAQ: https://www.pgbouncer.org/faq.html
- Full changelog: https://www.pgbouncer.org/changelog.html
- Latest release at write time: 1.25.2 (2026-05-08).

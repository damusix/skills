# Internals — Process Model and Shared Memory Architecture

PostgreSQL implements a **process-per-connection** server model: a single supervisor process (`postmaster`) accepts incoming TCP/Unix-socket connections and `fork()`s a dedicated *backend* process for each. The supervisor and its children communicate through a fixed-size shared-memory region allocated once at server start, plus a pool of semaphores for synchronization. This file is the canonical reference for the process catalog, what each process does, how they cooperate, and where the shared-memory regions live.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Process Inventory](#process-inventory)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The two-tier model](#the-two-tier-model)
    - [postmaster — the supervisor](#postmaster--the-supervisor)
    - [Client backends](#client-backends)
    - [Connection establishment](#connection-establishment)
    - [Auxiliary processes](#auxiliary-processes)
    - [Parallel workers](#parallel-workers)
    - [Background workers (extensions)](#background-workers-extensions)
    - [Replication and logical-decoding processes](#replication-and-logical-decoding-processes)
    - [postmaster.pid](#postmasterpid)
- [Shared Memory Architecture](#shared-memory-architecture)
    - [Allocation strategy](#allocation-strategy)
    - [The major regions](#the-major-regions)
    - [SLRU buffers](#slru-buffers)
    - [Dynamic shared memory](#dynamic-shared-memory)
    - [Semaphores](#semaphores)
- [Process Provisioning GUCs](#process-provisioning-gucs)
- [Per-version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when you need to know **what processes the cluster is running, why each one exists, and how they share state.** Reach for it when:

- A `ps aux | grep postgres` listing shows processes you don't recognize and you need to identify them;
- You are sizing `max_connections`, `max_worker_processes`, `autovacuum_max_workers`, or computing the total backend slot budget;
- You are debugging a connection-establishment failure or a "could not fork" error;
- You are tuning shared-memory parameters (`shared_buffers`, `wal_buffers`, `min_dynamic_shared_memory`, the seven SLRU buffer GUCs);
- You are choosing between a single PG cluster with a connection pooler and one PG cluster per service, and want to understand the per-connection memory cost;
- You are inspecting a backend's `backend_type` in `pg_stat_activity` and want to know what that type does.

Do not reach for this file when you want syntax-level reference for any specific subsystem — each subsystem has its own dedicated file (vacuum, WAL, checkpointer, parallel query, replication, etc., all cross-referenced in [See Also](#see-also)).

> [!WARNING] PostgreSQL does NOT use a thread-per-connection model
> A common assumption from operators arriving from MySQL/MariaDB or many application servers is that "the server" is one process with many threads. PostgreSQL is the opposite: the server is a tree of *processes*, and every client connection has its own OS process with its own private memory plus a pointer into a shared-memory region. The fork-per-connection cost is real (typically 1–2 ms plus the cost of preparing the shared-memory mapping) and the per-backend memory footprint is in the megabytes. **Production deployments need a connection pooler** in front of PG. See [80-connection-pooling.md](./80-connection-pooling.md) and [81-pgbouncer.md](./81-pgbouncer.md).

> [!WARNING] PG15 removed the stats collector process — tutorials older than 2022 are stale
> Pre-PG15 deployments had a dedicated **stats collector** process that received metric events from backends via UDP packets and periodically wrote stats files to disk. PG15 moved cumulative statistics into shared memory and *eliminated the stats collector process entirely*. Verbatim release note: *"Store cumulative statistics system data in shared memory. Previously this data was sent to a statistics collector process via UDP packets, and could only be read by sessions after transferring it via the file system. **There is no longer a separate statistics collector process.**"*[^pg15-stats] If a tutorial mentions a `stats collector` in the process tree, it is documenting pre-PG15 behavior.

## Mental Model

Five rules cover almost every question about the PG process model:

1. **The postmaster is the supervisor; every client connection becomes a forked backend.** Verbatim from `connect-estab.html`: *"PostgreSQL implements a 'process per user' client/server model. In this model, every client process connects to exactly one backend process."* and *"This supervisor process is called postmaster and listens at a specified TCP/IP port for incoming connections. Whenever it detects a request for a connection, it spawns a new backend process."*[^connect-estab] The backends do the real work; the postmaster does very little once the connection is handed off — it just monitors children, restarts dead auxiliary processes, and accepts new connections.

2. **Auxiliary processes are started by postmaster and live as long as the cluster.** `checkpointer`, `background writer`, `walwriter`, `autovacuum launcher`, `archiver` (when archiving), and `logical replication launcher` are always running. They are *not* per-connection; they are per-cluster. A `ps` listing on an idle cluster still shows roughly half a dozen processes for this reason.

3. **Shared memory is allocated once at postmaster start, not dynamically per backend.** `shared_buffers`, the WAL buffer ring, the lock table, the procarray, the SLRU caches (CLOG / multixact / subtrans / notify / serializable / commit-timestamp) — all sized at startup. Changing `shared_buffers` requires a full server restart. Per-backend memory (`work_mem`, sort/hash workspaces, query plans) is *private* to each backend and allocated lazily.[^kernel-resources] One narrow exception is `min_dynamic_shared_memory` (PG14+), which pre-allocates a pool of DSM at startup so parallel queries don't have to fall back to OS `mmap()` calls.[^pg14-min-dsm]

4. **The WAL writer, the background writer, and the checkpointer are three separate processes with three different jobs.** They are commonly conflated because they all write to disk. The WAL writer flushes WAL buffers asynchronously so that committing backends don't have to (this reduces commit latency under `synchronous_commit = off`). The background writer drains dirty *data* buffers from `shared_buffers` to disk during normal operation so clock-sweep doesn't trip over them. The checkpointer does a periodic recovery anchor — it writes a "checkpoint" record to WAL after flushing *all* currently dirty data buffers, so crash recovery doesn't have to replay WAL older than that point.[^wal-writer-cfg] See [33-wal.md](./33-wal.md) and [34-checkpoints-bgwriter.md](./34-checkpoints-bgwriter.md).

5. **Parallel workers are short-lived backends dispatched per-query, drawn from the same pool as background workers.** When a plan with a `Gather` node executes, the leader backend asks postmaster for up to `max_parallel_workers_per_gather` workers; postmaster forks them, they attach to the same DSM segment as the leader, do their part of the plan, exit. They share the `max_worker_processes` global slot pool with extension-supplied background workers, autovacuum workers, and logical replication workers — so over-committing `max_parallel_workers` against `max_worker_processes` silently starves parallel queries.[^how-parallel-query]

## Process Inventory

`pg_stat_activity.backend_type` is the canonical introspection surface. Verbatim from the PG16 monitoring docs: *"Possible types are `autovacuum launcher`, `autovacuum worker`, `logical replication launcher`, `logical replication worker`, `parallel worker`, `background writer`, `client backend`, `checkpointer`, `archiver`, `standalone backend`, `startup`, `walreceiver`, `walsender` and `walwriter`. In addition, background workers registered by extensions may have additional types."*[^backend-type]

The full PG16 catalog (14 base types plus extension-registered):

| `backend_type` | Persistent? | Started by | Purpose | Cluster role |
|---|---|---|---|---|
| `client backend` | Per-connection | postmaster `fork()` | Executes SQL for one client connection | Both primary and standby |
| `autovacuum launcher` | One per cluster | postmaster (if `autovacuum=on`) | Periodically wakes, picks a database, forks an autovacuum worker | Primary only |
| `autovacuum worker` | Short-lived | autovacuum launcher | Runs VACUUM/ANALYZE on tables in one database, exits | Primary only |
| `parallel worker` | Per-query, transient | postmaster (on leader request) | Runs one branch of a parallel plan, exits when the Gather completes | Both |
| `background writer` | One per cluster | postmaster | Drains dirty `shared_buffers` pages to disk during normal operation | Both |
| `checkpointer` | One per cluster | postmaster | Performs periodic checkpoints; also fsync-files-touched-since-last-checkpoint | Both |
| `walwriter` | One per cluster | postmaster | Asynchronously flushes WAL buffers; reduces commit latency for async commits | Primary only |
| `archiver` | One per cluster (if archiving on) | postmaster | Runs `archive_command` / `archive_library` on completed WAL segments | Primary only |
| `walsender` | Per-replication-connection | postmaster (on inbound replication request) | Streams WAL to one standby or logical subscriber | Primary (also on standby for cascading) |
| `walreceiver` | One per standby | postmaster (on standby) | Connects to upstream, receives WAL, writes to local `pg_wal/` | Standby only |
| `startup` | Standby/recovery only | postmaster | Replays WAL during crash recovery or hot-standby; exits when caught up (on primary) | Both, briefly on primary at start |
| `standalone backend` | Special-mode | invoked via `postgres --single` | Single-user mode for recovery / wraparound emergencies | Not present in normal operation |
| `logical replication launcher` | One per cluster | postmaster | Manages logical-replication subscription workers | Subscriber only |
| `logical replication worker` | One per subscription/table | logical replication launcher | Applies logical-replication changes | Subscriber only |
| (extension bgworker) | Configured | postmaster | Whatever the extension does (`pg_cron`, TimescaleDB workers, etc.) | Whatever the extension configures |

> [!NOTE] PostgreSQL 15
> The `stats collector` process (a 14-type list before PG15) was removed; cumulative statistics now live in shared memory. The `pg_stat_activity.backend_type` enum dropped the `stats collector` value in PG15.[^pg15-stats]

> [!NOTE] PostgreSQL 18
> `io_method = worker` introduces a new pool of **I/O worker processes** (`io_workers` GUC, default 3) that run asynchronous I/O on behalf of regular backends. These workers do not appear as a new `backend_type` value — they are auxiliary processes the same way the WAL writer and checkpointer are.[^pg18-io-workers] PG18 also added `autovacuum_worker_slots` (typically 16) as the explicit cap on autovacuum worker slots, decoupled from `max_worker_processes`.[^pg18-av-slots] See [Per-version Timeline](#per-version-timeline) for the full list of PG18 process-model changes.

## Syntax / Mechanics

### The two-tier model

```
postmaster (the supervisor)
    |
    +---- client backend (one per SQL connection)
    +---- client backend
    +---- client backend
    |     ... up to max_connections + superuser_reserved_connections
    |
    +---- background writer        (always)
    +---- checkpointer             (always)
    +---- walwriter                (always on primary)
    +---- autovacuum launcher      (if autovacuum = on)
    |       +---- autovacuum worker  (transient, spawned by launcher)
    +---- archiver                 (if archive_mode = on)
    +---- logical replication launcher  (always; idle if no subscriptions)
    |       +---- logical replication worker  (one per active subscription/table)
    +---- walsender                (one per inbound replication connection)
    +---- walreceiver              (standby only)
    +---- io worker                (PG18+ when io_method = worker)
    |       +---- io worker
    |       +---- io worker
    +---- background worker        (any extension-registered bgworker; pg_cron, etc.)
    |
    +---- parallel worker          (transient, one per parallel branch in flight)
    +---- parallel worker
    +---- parallel worker
```

Two things to note about the diagram:

- **The postmaster's only ongoing job is fork-and-watch.** It does not execute SQL. It does not hold locks. It does not write WAL. Killing the postmaster cleanly is a `SIGTERM`; the postmaster forwards termination to all children. Killing the postmaster with `SIGKILL` (`kill -9`) leaves orphan backends and is one of the canonical sources of half-recovered clusters — never `kill -9` the postmaster.
- **The autovacuum worker reports to its launcher, but it is a child of *postmaster*.** When a worker exits, its `wait4()` is on postmaster; if postmaster dies, every child is reparented to PID 1 and the cluster's state machine is broken. This is why "supervisor dies; children continue serving" is *not* a viable mode in PG.

### postmaster — the supervisor

`postmaster` is the binary you actually start (its modern name `postgres` — same binary, started without `--single`):

    $ postgres -D /var/lib/postgresql/16/main

Verbatim from `server-start.html`: *"The bare-bones way to start the server manually is just to invoke `postgres` directly, specifying the location of the data directory with the `-D` option."*[^server-start] In production you'd use the platform's init wrapper (systemd, pg_ctl, an HA agent), but the binary underneath is the same.

The postmaster's lifecycle responsibilities:

1. **Listen on the TCP port + Unix socket.** Defaults: TCP port `5432`, Unix socket `/var/run/postgresql/.s.PGSQL.5432` (path varies by distro).
2. **Accept incoming connection requests, authenticate, and fork.** The postmaster does the initial protocol handshake (startup packet, authentication exchange via `pg_hba.conf`) *before* forking — once the client is authenticated, the postmaster forks a backend, hands off the socket, and goes back to listening.
3. **Spawn and supervise auxiliary processes.** Background writer, checkpointer, walwriter, autovacuum launcher, archiver (if archiving), logical replication launcher, IO workers (PG18+) are all postmaster-spawned at startup and respawned if they die.
4. **Detect dead children and restart the cluster if necessary.** If a *backend* dies abnormally (segfault, OOM kill), the postmaster initiates an emergency restart: all backends are signaled to exit, shared memory is reset, the checkpointer triggers a crash recovery from the most recent checkpoint. This is the right call — a corrupted shared-memory region could have been left behind. The brief downtime (typically a few seconds) is the price of crash safety.
5. **Handle signals.** `SIGTERM` = smart shutdown (wait for active connections), `SIGINT` = fast shutdown (cancel running queries, then terminate), `SIGQUIT` = immediate shutdown (force-exit all children, crash recovery on next start), `SIGHUP` = reload `postgresql.conf`.

The postmaster's PID lives in `$PGDATA/postmaster.pid` — see [postmaster.pid](#postmasterpid) below.

### Client backends

Each authenticated client connection becomes a *backend*. The backend:

- Has its own OS process (PID visible in `pg_stat_activity.pid`);
- Has its own private memory: query plans, sort/hash workspaces (sized by `work_mem` per executor node), the parse and rewrite buffers, the prepared-statement cache;
- Connects to shared memory via the inherited mapping (the postmaster mapped it at startup, and `fork()` preserves the mapping in the child);
- Acquires its own slot in the `procarray` (the in-memory list of all live transactions) and its own row in `pg_stat_activity` (which is itself a function backed by `pg_stat_get_activity()`);
- Holds session-level state until disconnect: GUC settings via `SET`, prepared statements, advisory locks, `LISTEN` subscriptions, cursors.

A backend exits when:

- The client sends `Terminate` (protocol-level `X` message);
- The TCP connection drops (detected via socket close);
- `pg_terminate_backend(pid)` is called by an authorized session;
- `idle_in_transaction_session_timeout` or `idle_session_timeout` (PG14+) fires;
- The postmaster initiates emergency restart due to an abnormal child death.

When a backend exits, its private memory is released back to the kernel, its slot in `procarray` is freed, and any session-level state (GUCs, prepared statements, advisory locks, `LISTEN`s) is discarded.

> [!WARNING] Per-backend memory cost is real
> A reasonable rule of thumb for a fresh-after-handshake backend is **8–10 MB resident** (RSS) on a typical Linux x86_64 build. Running queries add `work_mem` per executor node *per worker*, plus the plan, plus per-relation lock entries. A 200-backend cluster with 64 MB `work_mem` and a complex query can commit gigabytes of RAM. This is why connection pooling (transaction-mode pgBouncer with a small pool) usually wins over allowing applications to open 1000s of PG connections.

### Connection establishment

The connection-establishment dance:

1. **Client opens a TCP connection** to the postmaster's listening port.
2. **Client sends the startup packet** containing the desired database, role, and any GUC overrides.
3. **postmaster authenticates the client** according to the first matching line in `pg_hba.conf`. Methods range from `trust` (no challenge) to `scram-sha-256` (modern default) to `cert` (TLS client cert) to `peer` / `ident` (OS-level). See [48-authentication-pg-hba.md](./48-authentication-pg-hba.md).
4. **postmaster forks a new backend.** The forked backend inherits the open socket, the shared-memory mapping, and a few other essentials. The postmaster goes back to listening.
5. **The backend completes startup**: attaches to `procarray`, opens its log connection, sends `BackendKeyData` (used later by `pg_cancel_backend()`), then sends `ReadyForQuery`.
6. **Steady-state**: client sends `Query` / `Parse` / `Bind` / `Execute` messages; backend responds with `RowDescription`, `DataRow`, etc.

This sequence happens once per connection. For a workload that opens-and-closes 100 connections/sec, the fork() + auth + setup cost is a noticeable fraction of total CPU. **Pool externally.**

### Auxiliary processes

The persistent per-cluster processes:

**`background writer`** — drains dirty data buffers from `shared_buffers` to disk during normal operation. Runs every `bgwriter_delay` (default 200 ms) and writes at most `bgwriter_lru_maxpages` dirty buffers per round (default 100), targeting buffers that are about to be evicted by clock-sweep. This is NOT the checkpointer; the bgwriter does small continuous trickle writes, not bulk flushes. See [32-buffer-manager.md](./32-buffer-manager.md) and [34-checkpoints-bgwriter.md](./34-checkpoints-bgwriter.md).

**`checkpointer`** — performs periodic checkpoints. A checkpoint forces all currently-dirty buffers to disk, fsyncs the data files, and writes a checkpoint record to WAL. The checkpoint anchor is what crash recovery rewinds to. Triggered by `checkpoint_timeout` (default 5 min), by `max_wal_size` accumulation, or by explicit `CHECKPOINT` command. PG15 added a separate-process behavior: the checkpointer and bgwriter now run *during crash recovery* too (previously the startup process did this work itself).[^pg15-checkpointer-recovery]

**`walwriter`** — flushes WAL buffers asynchronously. Backends committing with `synchronous_commit = off` rely on this process to eventually fsync their WAL. Wakes every `wal_writer_delay` (default 200 ms) or when `wal_writer_flush_after` (default 1 MB) of WAL accumulates.[^wal-writer-cfg] On a primary, it always runs. On a standby, it does not run (the startup process handles WAL).

**`autovacuum launcher`** — wakes every `autovacuum_naptime` (default 1 min), examines `pg_stat_user_tables` across all databases, picks tables that have exceeded their per-table thresholds, and asks postmaster to fork an `autovacuum worker` to vacuum or analyze each. The launcher itself does not vacuum; it dispatches. See [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md).

**`archiver`** — only present when `archive_mode = on`. Runs `archive_command` or `archive_library` (PG15+) for each completed WAL segment, then deletes the local copy if the archive call succeeded. See [33-wal.md](./33-wal.md).

**`logical replication launcher`** — always present. Idle when no subscriptions exist. When subscriptions are active, the launcher dispatches per-subscription / per-table `logical replication worker` processes. See [74-logical-replication.md](./74-logical-replication.md).

**`io worker`** (PG18+) — only present when `io_method = worker`. A configurable pool (`io_workers`, default 3) that runs asynchronous I/O on behalf of regular backends.[^pg18-aio]

### Parallel workers

When the planner picks a parallel plan, the executor inserts a `Gather` or `Gather Merge` node at the top of the parallel portion. At execution time, verbatim from the docs:

*"When the `Gather` node is reached during query execution, the process that is implementing the user's session will request a number of background worker processes equal to the number of workers chosen by the planner."*[^how-parallel-query]

The leader backend coordinates: it asks postmaster for workers (limited by `max_parallel_workers_per_gather`, default 2), the workers attach to a per-query DSM segment, they execute parallel-safe nodes, the leader collects their output. Verbatim: *"Every background worker process that is successfully started for a given parallel query will execute the parallel portion of the plan. The leader will also execute that portion of the plan, but it has an additional responsibility: it must also read all of the tuples generated by the workers."*[^how-parallel-query]

Parallel workers come from the shared pool of background workers. Verbatim: *"The number of background workers that the planner will consider using is limited to at most `max_parallel_workers_per_gather`. The total number of background workers that can exist at any one time is limited by both `max_worker_processes` and `max_parallel_workers`."*[^how-parallel-query]

> [!WARNING] The three GUC caps compose, not substitute
> `max_worker_processes` (default 8) is the cluster-wide hard cap. `max_parallel_workers` (default 8) is the cap on workers used for parallel queries specifically. `max_parallel_workers_per_gather` (default 2) is the per-query cap. *"a setting for `max_parallel_workers` which is higher than `max_worker_processes` will have no effect, since parallel workers are taken from the pool of worker processes established by that setting."*[^pg16-resource] Same for autovacuum and bgworkers — they all draw from `max_worker_processes`.

See [60-parallel-query.md](./60-parallel-query.md) for the full mechanics.

### Background workers (extensions)

Extensions can register background workers via the `bgworker` API. Verbatim from the docs: *"PostgreSQL can be extended to run user-supplied code in separate processes. Such processes are started, stopped and monitored by `postgres`, which permits them to have a lifetime closely linked to the server's status."*[^bgworker] Examples in the wild: `pg_cron` (the scheduler process), `pg_partman`'s maintenance worker, TimescaleDB's various workers, Citus's distributed query workers.

The total worker budget is `max_worker_processes`. Add bgworkers, autovacuum workers (`autovacuum_max_workers`), parallel workers (`max_parallel_workers`), and logical-replication workers and verify the sum is reasonable.

Verbatim from `bgworker.html`: *"There are considerable robustness and security risks in using background worker processes because, being written in the `C` language, they have unrestricted access to data."*[^bgworker] This is the canonical reason managed providers gate which extensions can register bgworkers.

### Replication and logical-decoding processes

**`walsender`** — one per inbound replication connection (physical streaming standby OR logical-decoding subscription). The walsender runs *on the primary* (or upstream cascading server); it reads from `pg_wal/` and pushes records over the wire. Capped by `max_wal_senders` (default 10).[^pg16-wal-senders]

**`walreceiver`** — exactly one per standby. Runs *on the standby*. Connects to the upstream's walsender, receives WAL records, writes them to local `pg_wal/`. The startup process then replays them.

**`logical replication launcher` + `logical replication worker`** — running on the *subscriber* side of logical replication. The launcher (one per cluster) dispatches per-subscription / per-table workers (capped by `max_logical_replication_workers`, default 4). Each worker subscribes to a publication via a walsender on the publisher, reads the decoded stream, and applies the changes.

See [73-streaming-replication.md](./73-streaming-replication.md), [74-logical-replication.md](./74-logical-replication.md), [75-replication-slots.md](./75-replication-slots.md), [76-logical-decoding.md](./76-logical-decoding.md).

### postmaster.pid

Verbatim from `server-start.html`: *"While the server is running, its PID is stored in the file `postmaster.pid` in the data directory. This is used to prevent multiple server instances from running in the same data directory and can also be used for shutting down the server."*[^server-start]

`$PGDATA/postmaster.pid` is more than a PID file — it is also a sentinel for "this cluster is running." A stale `postmaster.pid` from a crashed server can prevent a clean restart. The file is locked via `flock()` on Linux; only the postmaster holds the lock during normal operation. If the file's lock is held but the named PID doesn't exist, the postmaster on the next startup attempt will recognize the stale state and proceed; if the lock is held by a live PID, startup will refuse with `another server might be running`.

Format (each field on its own line):

    <pid>
    <data_directory>
    <start_time (seconds since epoch)>
    <port>
    <socket_directory>
    <listen_addr>
    <shmem_key>
    <status_flags>

Useful in monitoring (Prometheus node-exporter has a textfile collector hook for the `postmaster.pid` start time, which lets you alert on unexpected restart).

## Shared Memory Architecture

### Allocation strategy

PostgreSQL allocates the bulk of its shared memory at postmaster startup, before any backends fork. Verbatim from `kernel-resources.html`: *"By default, PostgreSQL allocates a very small amount of System V shared memory, as well as a much larger amount of anonymous `mmap` shared memory. Alternatively, a single large System V shared memory region can be used (see `shared_memory_type`)."*[^kernel-resources]

The default `shared_memory_type = mmap` is preferred on every platform that supports it because it avoids the historical SysV `SHMMAX` / `SHMALL` kernel-limit headaches. Verbatim: *"PostgreSQL requires a few bytes of System V shared memory (typically 48 bytes, on 64-bit platforms) for each copy of the server."*[^kernel-resources] The remaining gigabytes come from anonymous `mmap()`.

The shared mapping is inherited by every forked backend via `fork()` copy-on-write semantics — the backends do not need to re-map. Auxiliary processes inherit the same way.

> [!NOTE] PostgreSQL 15
> `shared_memory_size` and `shared_memory_size_in_huge_pages` GUCs added — they report the total shared memory the server *would* allocate, which is essential for sizing huge-page reservations correctly. See [54-memory-tuning.md](./54-memory-tuning.md).

### The major regions

The shared-memory layout is not enumerated in any one user-facing docs page (the breakdown lives in `src/backend/storage/ipc/ipci.c` and per-subsystem source files), but the major consumers are well-known:

| Region | Size | Notes |
|---|---|---|
| `shared_buffers` | `shared_buffers` GUC (default 128 MB; production 25%-of-RAM rule) | Main data-page cache. Holds 8 KB pages from tables, indexes, sequences, the visibility map, the FSM. See [32-buffer-manager.md](./32-buffer-manager.md). |
| WAL buffers | `wal_buffers` GUC (default -1 = 1/32 of `shared_buffers`, capped at one WAL segment, typically 16 MB) | Outbound WAL data not yet flushed to disk[^wal-buffers] |
| Lock table | sized by `max_locks_per_transaction × (max_connections + max_prepared_transactions)` | Heavyweight lock entries (table locks, row-level locks tracked as TIDs, advisory locks). See [43-locking.md](./43-locking.md) and [44-advisory-locks.md](./44-advisory-locks.md). |
| `procarray` | one slot per `max_connections + autovacuum_max_workers + max_wal_senders + max_worker_processes` | Live transaction list: each slot has the backend's XID, xmin, snapshot-related fields. The basis for MVCC visibility checks. See [27-mvcc-internals.md](./27-mvcc-internals.md). |
| SLRU caches | seven separate caches; sized by their own GUCs (PG17+) | CLOG, multixact (offsets + members), subtrans, notify, serializable, commit-timestamp. See [SLRU buffers](#slru-buffers) below. |
| Sinval (shared-invalidation) queue | fixed | Cross-backend cache-invalidation messages (e.g., "this catalog entry was DROP'd") |
| Lightweight lock (LWLock) tranches | fixed array of LWLocks | Used to serialize access to every other shared region |
| Predicate locks | sized by `max_pred_locks_per_transaction × max_connections` | Used by SERIALIZABLE isolation. See [42-isolation-levels.md](./42-isolation-levels.md). |
| Replication slot state | `max_replication_slots` slots | Tracks WAL position each slot has acknowledged. See [75-replication-slots.md](./75-replication-slots.md). |
| Statistics (PG15+) | shared-memory hash; replaces pre-PG15 stats collector + on-disk files | `pg_stat_*` view backing store. See [PG15 note above](#mental-model). |
| Free Space Map / Visibility Map shared state | metadata only; the per-relation FSM/VM forks themselves are on disk | Small overhead |
| `min_dynamic_shared_memory` (PG14+) | configurable (default 0) | Pre-allocated DSM pool for parallel queries; reduces OS-level allocations[^pg14-min-dsm] |

The `pg_shmem_allocations` view (added in PG13) exposes the runtime allocation breakdown — query it after startup to see exactly how the regions were sized.

### SLRU buffers

The Simple LRU caches handle small fixed-page sets that are accessed cluster-wide. Pre-PG17 their sizes were hard-coded at build time; PG17 made every SLRU cache configurable.

> [!NOTE] PostgreSQL 17
> Verbatim release-note quote: *"Allow the SLRU cache sizes to be configured (Andrey Borodin, Dilip Kumar, Alvaro Herrera). The new server variables are `commit_timestamp_buffers`, `multixact_member_buffers`, `multixact_offset_buffers`, `notify_buffers`, `serializable_buffers`, `subtransaction_buffers`, and `transaction_buffers`."*[^pg17-slru] Before PG17 these were hard-coded; PG17 also restructured the SLRU access pattern to handle high concurrency better.

Each SLRU cache backs an on-disk file in `$PGDATA/pg_<name>/`:

| GUC (PG17+) | On-disk dir | Purpose | Default size |
|---|---|---|---|
| `transaction_buffers` | `pg_xact/` | Transaction commit status (CLOG) | `0` = auto-size as `shared_buffers/512`, min 16 blocks, max 1024 blocks[^pg17-resource] |
| `commit_timestamp_buffers` | `pg_commit_ts/` | Commit timestamps (if `track_commit_timestamp = on`) | `0` = auto-size, same formula |
| `multixact_offset_buffers` | `pg_multixact/offsets/` | MultiXact offset table | `0` = auto-size |
| `multixact_member_buffers` | `pg_multixact/members/` | MultiXact member table | `32` |
| `subtransaction_buffers` | `pg_subtrans/` | Subtransaction parent links | `0` = auto-size |
| `notify_buffers` | `pg_notify/` | LISTEN/NOTIFY queue | `16` |
| `serializable_buffers` | `pg_serial/` | Serializable Snapshot Isolation conflict tracking | `0` = auto-size |

When a cluster has high XID churn or heavy LISTEN/NOTIFY usage or massive numbers of multixacts (row locking by many transactions on the same row), raising the relevant SLRU buffer count reduces SLRU misses (visible as `SLRU` wait events in `pg_stat_activity`).

### Dynamic shared memory

Parallel queries and some extensions allocate transient DSM segments that the leader and its workers map to share intermediate state (hash tables, tuplestores). DSM is managed by the OS at runtime — different from the startup-time shared region.

DSM type controlled by `dynamic_shared_memory_type` (`posix` / `sysv` / `windows` / `mmap` / `none`). Default `posix` on most Unixes.

> [!NOTE] PostgreSQL 14
> `min_dynamic_shared_memory` GUC added. *"Allow startup allocation of dynamic shared memory (Thomas Munro)."*[^pg14-min-dsm] Verbatim from runtime-config-resource: *"Specifies the amount of memory that should be allocated at server startup for use by parallel queries. When this memory region is insufficient or exhausted by concurrent queries, new parallel queries try to allocate extra shared memory temporarily from the operating system."*[^pg16-resource] Set this if you observe high `DynamicSharedMemoryControlLock` wait events on parallel-heavy workloads.

> [!NOTE] PostgreSQL 18
> The `pg_aios` system view exposes the file handles currently in use by the asynchronous I/O subsystem.[^pg18-aio]

### Semaphores

Verbatim from `kernel-resources.html`: *"In addition a significant number of semaphores, which can be either System V or POSIX style, are created at server startup. Currently, POSIX semaphores are used on Linux and FreeBSD systems while other platforms use System V semaphores."*[^kernel-resources-sem]

Sizing: *"the number of semaphores needed is the same as for System V, that is one semaphore per allowed connection (`max_connections`), allowed autovacuum worker process (`autovacuum_max_workers`), allowed WAL sender process (`max_wal_senders`), and allowed background process (`max_worker_processes`)."*[^kernel-resources-sem]

On Linux with POSIX semaphores there is no specific kernel limit. On other platforms, see the kernel-resources page for the SysV `SEMMNI` / `SEMMNS` math.

## Process Provisioning GUCs

Sizing the process tree:

| GUC | Default | Restart? | What it bounds |
|---|---|---|---|
| `max_connections` | `100` | Yes | Total client backends + walsenders + (in some accounting) replication-related |
| `superuser_reserved_connections` | `3` | Yes | Slots reserved for superuser connections out of `max_connections` |
| `reserved_connections` (PG16+) | `0` | Yes | Slots reserved for the `pg_use_reserved_connections` role |
| `max_worker_processes` | `8` | Yes | Cluster-wide hard cap on all background workers: autovacuum + parallel + bgworkers + (PG18+) IO workers + (logical-rep workers on subscriber) |
| `max_parallel_workers` | `8` | Reload | Cap on workers used for parallel query specifically (within `max_worker_processes`) |
| `max_parallel_workers_per_gather` | `2` | Reload | Per-query cap on parallel workers |
| `max_parallel_maintenance_workers` | `2` | Reload | Per-query cap for parallel `CREATE INDEX`, `VACUUM`, etc. |
| `autovacuum_max_workers` | `3` (PG16); PG18 same default but reloadable | Reload (PG18+); restart (PG≤17) | Concurrent autovacuum workers |
| `autovacuum_worker_slots` (PG18+) | typically `16` | Yes | Reserved backend slots for autovacuum, decoupled from `max_worker_processes`[^pg18-av-slots] |
| `max_wal_senders` | `10` | Yes | Concurrent replication connections (standbys + logical subscribers) |
| `max_replication_slots` | `10` | Yes | Replication slots (physical + logical) |
| `max_logical_replication_workers` | `4` | Yes | Logical-replication apply workers on subscriber |
| `io_workers` (PG18+) | `3` | Reload | I/O worker pool (only used when `io_method = worker`)[^pg18-io-workers] |
| `min_dynamic_shared_memory` | `0` | Yes | Pre-allocated DSM pool for parallel queries[^pg14-min-dsm] |

The combined worker budget formula (good back-of-envelope sanity check):

    max_worker_processes  ≥  autovacuum_max_workers
                            + max_parallel_workers (queries)
                            + max_logical_replication_workers (subscriber-side)
                            + (PG18+) io_workers (if io_method=worker)
                            + (sum of extension-registered bgworkers, e.g. pg_cron usually 1)

If the sum exceeds `max_worker_processes`, the highest-priority workloads succeed and the others silently get fewer workers than configured.

The semaphore-and-procarray budget:

    procarray slots = max_connections
                    + autovacuum_max_workers
                    + max_wal_senders
                    + max_worker_processes
                    + 1 (postmaster) + a few for other auxiliary processes

This is the kernel-resource sizing input for SysV semaphores on platforms that need them.

## Per-version Timeline

| Version | Process-model changes |
|---|---|
| **PG14** | `idle_session_timeout` GUC added. `min_dynamic_shared_memory` GUC added for pre-allocated DSM (verbatim *"Allow startup allocation of dynamic shared memory"*).[^pg14-min-dsm] Parallel sequential scans now allocate blocks in groups to parallel workers for better I/O.[^pg14-parallel-io] No new process types. |
| **PG15** | **Stats collector process removed.** Cumulative statistics now in shared memory (verbatim *"There is no longer a separate statistics collector process"*).[^pg15-stats] Checkpointer and bgwriter now run during crash recovery (verbatim *"Run the checkpointer and bgwriter processes during crash recovery"*).[^pg15-checkpointer-recovery] WAL pre-fetch added (`recovery_prefetch`). `shared_memory_size` and `shared_memory_size_in_huge_pages` GUCs added. |
| **PG16** | **No process model changes.** Several parallel-query feature improvements: parallel `string_agg()`/`array_agg()` aggregates, parallel application of logical replication, parallelization of FULL and right OUTER hash joins.[^pg16-release] |
| **PG17** | **`pg_stat_checkpointer` system view created** (verbatim *"Create system view `pg_stat_checkpointer`"*); `buffers_backend` and `buffers_backend_fsync` columns *removed* from `pg_stat_bgwriter`.[^pg17-checkpointer-split] SLRU buffer sizes configurable for the first time (seven new GUCs).[^pg17-slru] |
| **PG18** | **Async I/O subsystem** added (verbatim *"Add an asynchronous I/O subsystem"*); `io_method` GUC accepts `sync`/`worker`/`io_uring`; with `worker`, a pool of **I/O worker processes** (`io_workers` GUC, default 3) services async reads.[^pg18-aio] **`autovacuum_worker_slots`** GUC added; `autovacuum_max_workers` reclassified to reloadable.[^pg18-av-slots] `pg_aios` system view exposes in-flight async I/O. `effective_io_concurrency` and `maintenance_io_concurrency` defaults raised from 1 to 16. |

## Examples / Recipes

### 1. Identify every process in the cluster

```sql
SELECT
    pid,
    backend_type,
    leader_pid,
    state,
    wait_event_type || ':' || wait_event AS wait,
    backend_start::time(0) AS started,
    application_name,
    datname,
    usename,
    LEFT(query, 60) AS query_excerpt
FROM pg_stat_activity
ORDER BY backend_type, pid;
```

`leader_pid` is non-NULL for parallel workers and points at the leader backend. Filter on `leader_pid IS NULL` to see only "real" client backends.

### 2. Audit process slot budget headroom

```sql
WITH provisioning AS (
    SELECT
        current_setting('max_connections')::int      AS max_conn,
        current_setting('max_worker_processes')::int AS max_workers,
        current_setting('autovacuum_max_workers')::int AS av_workers,
        current_setting('max_wal_senders')::int      AS wal_senders,
        current_setting('max_parallel_workers')::int AS parallel_workers,
        current_setting('max_parallel_workers_per_gather')::int AS per_gather
),
in_use AS (
    SELECT
        count(*) FILTER (WHERE backend_type = 'client backend')         AS client_backends,
        count(*) FILTER (WHERE backend_type = 'autovacuum worker')      AS av_workers_running,
        count(*) FILTER (WHERE backend_type = 'parallel worker')        AS parallel_running,
        count(*) FILTER (WHERE backend_type = 'walsender')              AS walsenders,
        count(*) FILTER (WHERE backend_type LIKE 'logical replication%') AS logical_rep
    FROM pg_stat_activity
)
SELECT * FROM provisioning, in_use;
```

### 3. Check shared-memory allocation breakdown

```sql
SELECT name, allocated_size, pg_size_pretty(allocated_size) AS pretty
FROM pg_shmem_allocations
ORDER BY allocated_size DESC;
```

`pg_shmem_allocations` (PG13+) shows the exact byte breakdown of the postmaster's startup allocation by name (e.g., `Shared Buffer Lookup Table`, `XLOG Ctl`, `Buffer Strategy Status`, `LOCK hash`, `PROC hash`, every SLRU cache by name). Useful when tuning `shared_buffers` against a memory budget.

### 4. Check huge-page sizing (PG15+)

```sql
SELECT
    name,
    setting,
    unit
FROM pg_settings
WHERE name IN ('shared_memory_size', 'shared_memory_size_in_huge_pages',
               'shared_buffers', 'huge_pages')
ORDER BY name;
```

`shared_memory_size_in_huge_pages` reports how many huge pages the postmaster would allocate at the current `shared_buffers` setting — the exact value to feed into `vm.nr_hugepages`.

### 5. Watch the cluster's process tree from the OS

    $ ps -ef --forest | grep -E '\s+postgres' | head -30

You should see the postmaster at the top, followed by an indented tree of auxiliary processes and any active client backends. The `--forest` flag shows the parent-child relationship explicitly; every child should report the postmaster as its parent.

### 6. Diagnose "too many connections"

```sql
SELECT
    state,
    count(*),
    max(now() - backend_start) AS oldest_backend
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY count(*) DESC;
```

If `idle` connections dominate, the answer is connection pooling. If `idle in transaction` dominates, the answer is `idle_in_transaction_session_timeout` plus application fixes (see [41-transactions.md](./41-transactions.md)).

### 7. Kill a runaway backend safely

```sql
-- Step 1: try graceful cancel first
SELECT pg_cancel_backend(<pid>);

-- Step 2: if that doesn't work, terminate
SELECT pg_terminate_backend(<pid>);
```

> [!WARNING] Do not pg_terminate_backend a walsender or logical replication worker without understanding the consequence
> Killing a walsender disconnects the standby; the standby will reconnect and resume but the abrupt close can leave an orphan slot entry until `wal_sender_timeout` elapses. Killing a logical-replication apply worker on a subscriber will retry from the last commit — usually fine but can flood logs. See [43-locking.md](./43-locking.md) gotcha #20.

### 8. Verify the postmaster process

    $ cat $PGDATA/postmaster.pid
    142857
    /var/lib/postgresql/16/main
    1719934401
    5432
    /var/run/postgresql
    *
    1234567890
    ready

    $ ps -p 142857 -o pid,comm,etime
        PID COMMAND         ELAPSED
     142857 postgres       2-14:33:27

The eight lines of `postmaster.pid` are documented in `src/include/postmaster/postmaster.h`. The `ready` final line is the postmaster's last-reported state; `starting`, `stopping`, `ready`, `standby`, `in archive recovery` are the values you may see.

### 9. PG18+ inspect async I/O

```sql
-- Confirm async I/O is enabled
SHOW io_method;

-- Inspect in-flight async I/O (PG18+ only)
SELECT * FROM pg_aios LIMIT 20;

-- Check I/O worker pool size
SHOW io_workers;
```

`pg_aios` shows the file handles currently used by the async I/O subsystem; it's the diagnostic surface when `io_method = worker` or `io_method = io_uring` and you suspect saturation.

## Gotchas / Anti-patterns

1. **Process-per-connection means 200 PG connections cost ~2 GB of RAM minimum.** Each backend is ~10 MB at idle. Always run pgBouncer (or equivalent) in production for any workload with more than a few dozen concurrent connections. See [80-connection-pooling.md](./80-connection-pooling.md) and [81-pgbouncer.md](./81-pgbouncer.md).

2. **`fork()` is not free.** On Linux x86_64 a backend fork is typically 1–2 ms before the new backend can accept the first query. A workload that opens-and-closes 100 connections/sec burns ~10% of one CPU on fork() alone. Pool externally.

3. **Killing the postmaster with `SIGKILL` leaves orphan children.** Use `pg_ctl stop` or `systemctl stop postgresql`. Even `SIGTERM` to the postmaster (graceful shutdown) is preferable to `SIGKILL`. The postmaster expects to coordinate its children's exit.

4. **The stats collector is gone in PG15+.** Old tutorials, monitoring tools written before 2022, and Stack Overflow answers from that era describe a process that no longer exists. Verify against the verbatim PG15 release-note quote.[^pg15-stats]

5. **`max_worker_processes` is restart-only.** Raising it requires a server restart, not a reload. The same applies to `max_connections`, `max_wal_senders`, `max_replication_slots`, `superuser_reserved_connections`, and `io_workers` (PG18+).

6. **Over-committing `max_parallel_workers` against `max_worker_processes` silently fails.** A parallel query that requests workers when the budget is exhausted gets fewer (or zero) workers and the plan degrades to a non-parallel execution silently. There is no error. Check `pg_stat_activity` for `parallel worker` count vs `max_parallel_workers`.

7. **Autovacuum workers share the `max_worker_processes` budget.** A cluster with `max_parallel_workers = 8` and `autovacuum_max_workers = 3` needs `max_worker_processes ≥ 11` (plus headroom for any extension bgworkers). PG18 decoupled autovacuum slots via `autovacuum_worker_slots`.[^pg18-av-slots]

8. **`SET max_connections` does nothing; it requires server restart.** Same for every `_SU_BACKEND` or postmaster-context GUC. Reloading the config (SIGHUP) is silently ignored for these; check `pg_settings.context = 'postmaster'`.

9. **`shared_buffers` is the single most-misallocated GUC in the wild.** Default 128 MB is too low for any production workload. The 25% rule with a 40% ceiling is the docs' explicit guidance.[^pg16-resource] See [54-memory-tuning.md](./54-memory-tuning.md).

10. **A walsender on the primary holds a replication slot's WAL retention.** If the standby disconnects and the slot is not invalidated, the primary keeps every WAL segment until the slot is dropped or invalidated by `max_slot_wal_keep_size` (PG13+). The cluster can run out of disk this way. See [75-replication-slots.md](./75-replication-slots.md).

11. **The archiver is per-cluster, not per-WAL-stream.** If `archive_command` is slow, archives back up, `pg_wal/` grows, and eventually the cluster halts. `archive_library` (PG15+) is the preferred mechanism for production. See [33-wal.md](./33-wal.md).

12. **A long-running `client backend` with an open transaction blocks autovacuum on every table it has touched.** The xmin horizon (visible in `pg_stat_activity.backend_xmin`) is held back by the oldest active transaction. See [27-mvcc-internals.md](./27-mvcc-internals.md) and [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md).

13. **`leader_pid` is NULL for client backends.** Filter parallel workers via `leader_pid IS NOT NULL` if you want to exclude them from session counts. The opposite trap (counting parallel workers as separate "connections") shows up in dashboard metrics.

14. **A `walreceiver` process on a standby that disconnects from the primary will retry forever until `wal_retrieve_retry_interval` (default 5s) gives up.** Failed reconnects show in the standby's logs as `could not connect to the primary server`. The standby is otherwise functional but will fall further behind. Monitor `pg_stat_wal_receiver` on standbys.

15. **`pg_stat_replication.replay_lag = NULL` on idle standby is healthy, not a problem.** A standby that has caught up and has no WAL to apply reports NULL for replay lag. The trap is interpreting NULL as "the replica is broken." See [58-performance-diagnostics.md](./58-performance-diagnostics.md) gotcha #14.

16. **`backend_type = 'startup'` on a primary appears briefly during recovery, then exits.** On a standby it stays forever — it is the WAL-replay process. A primary that shows a `startup` process for more than a few seconds is still recovering from a crash.

17. **`pg_shmem_allocations` shows only what was allocated at postmaster startup.** It does not show per-backend private memory (`work_mem`, plan cache, sort/hash workspaces). Use OS-level tools (`smaps`, `htop`'s RES column) for those.

18. **`min_dynamic_shared_memory = 0` is the default and is usually fine.** Only raise it if you see `DynamicSharedMemoryControlLock` waits in `pg_stat_activity` under parallel-heavy workloads. Most clusters do not need this knob.

19. **PG18 `io_workers` are extra processes, not threads.** Setting `io_method = worker` and `io_workers = 8` adds 8 new OS processes to the cluster. Each has its own ~10 MB RSS. Verify against your memory budget.

20. **Standalone backend mode (`postgres --single`) bypasses every safety net.** No connection limits, no auth, no autovacuum, no replication. It exists for wraparound recovery and emergency catalog surgery — see [29-transaction-id-wraparound.md](./29-transaction-id-wraparound.md) gotcha #11. Do not use it for routine work.

21. **PG15 `pg_stat_*` shared-memory backing means stats persist across crashes** but are reset on `pg_stat_reset()` calls and on cluster start (the on-disk file `pg_stat/pgstat.stat` is read at startup and discarded if shutdown was unclean). Long-history stats analysis still requires an external sampler like `pganalyze` or scheduled snapshots.

22. **The postmaster's PID changes on every restart**, so `postmaster.pid` is a poor signal for "is this the same cluster instance." Use the `start_time` line in `postmaster.pid` or the `pg_postmaster_start_time()` function to detect restarts.

23. **PG18 `autovacuum_max_workers` became reloadable** but only up to the `autovacuum_worker_slots` cap. Raising `autovacuum_max_workers` past `autovacuum_worker_slots` is silently ignored.[^pg18-av-slots]

## See Also

- [27-mvcc-internals.md](./27-mvcc-internals.md) — tuple visibility uses `procarray` from shared memory
- [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md) — autovacuum launcher + workers, the canonical process-tree consumer
- [32-buffer-manager.md](./32-buffer-manager.md) — `shared_buffers` region in detail
- [33-wal.md](./33-wal.md) — WAL buffers, WAL writer, archiver
- [34-checkpoints-bgwriter.md](./34-checkpoints-bgwriter.md) — checkpointer + bgwriter process responsibilities
- [41-transactions.md](./41-transactions.md) — idle-in-transaction backends, `idle_session_timeout`
- [43-locking.md](./43-locking.md) — shared lock table, predicate locks, advisory locks
- [44-advisory-locks.md](./44-advisory-locks.md)
- [48-authentication-pg-hba.md](./48-authentication-pg-hba.md) — auth happens in the postmaster, before fork
- [53-server-configuration.md](./53-server-configuration.md) — postmaster-context GUCs require restart
- [54-memory-tuning.md](./54-memory-tuning.md) — `shared_buffers` and the per-backend memory budget
- [58-performance-diagnostics.md](./58-performance-diagnostics.md) — `pg_stat_activity` deep dive
- [60-parallel-query.md](./60-parallel-query.md) — parallel worker dispatch, `Gather` node mechanics
- [73-streaming-replication.md](./73-streaming-replication.md) — walsender + walreceiver
- [74-logical-replication.md](./74-logical-replication.md) — logical replication launcher + workers
- [75-replication-slots.md](./75-replication-slots.md) — slots hold WAL retention
- [76-logical-decoding.md](./76-logical-decoding.md) — logical decoding processes and walsender interaction
- [29-transaction-id-wraparound.md](./29-transaction-id-wraparound.md) — standalone backend mode for emergency wraparound recovery
- [80-connection-pooling.md](./80-connection-pooling.md) — why the process-per-connection model needs pooling
- [81-pgbouncer.md](./81-pgbouncer.md) — pooler mechanics

## Sources

[^connect-estab]: PostgreSQL 16 docs, "How the Server Establishes Connections": *"PostgreSQL implements a 'process per user' client/server model. In this model, every client process connects to exactly one backend process."* and *"This supervisor process is called postmaster and listens at a specified TCP/IP port for incoming connections. Whenever it detects a request for a connection, it spawns a new backend process."* https://www.postgresql.org/docs/16/connect-estab.html

[^server-start]: PostgreSQL 16 docs, "Starting the Database Server": *"While the server is running, its PID is stored in the file `postmaster.pid` in the data directory."* https://www.postgresql.org/docs/16/server-start.html

[^kernel-resources]: PostgreSQL 16 docs, "Managing Kernel Resources": *"By default, PostgreSQL allocates a very small amount of System V shared memory, as well as a much larger amount of anonymous `mmap` shared memory. Alternatively, a single large System V shared memory region can be used (see `shared_memory_type`)."* and *"PostgreSQL requires a few bytes of System V shared memory (typically 48 bytes, on 64-bit platforms) for each copy of the server."* https://www.postgresql.org/docs/16/kernel-resources.html

[^kernel-resources-sem]: PostgreSQL 16 docs, "Managing Kernel Resources", semaphores section: *"In addition a significant number of semaphores, which can be either System V or POSIX style, are created at server startup. Currently, POSIX semaphores are used on Linux and FreeBSD systems while other platforms use System V semaphores."* https://www.postgresql.org/docs/16/kernel-resources.html

[^backend-type]: PostgreSQL 16 docs, `pg_stat_activity` view: *"Possible types are `autovacuum launcher`, `autovacuum worker`, `logical replication launcher`, `logical replication worker`, `parallel worker`, `background writer`, `client backend`, `checkpointer`, `archiver`, `standalone backend`, `startup`, `walreceiver`, `walsender` and `walwriter`. In addition, background workers registered by extensions may have additional types."* https://www.postgresql.org/docs/16/monitoring-stats.html

[^how-parallel-query]: PostgreSQL 16 docs, "How Parallel Query Works": *"When the `Gather` node is reached during query execution, the process that is implementing the user's session will request a number of background worker processes equal to the number of workers chosen by the planner. ... Every background worker process that is successfully started for a given parallel query will execute the parallel portion of the plan. ... The number of background workers that the planner will consider using is limited to at most `max_parallel_workers_per_gather`. The total number of background workers that can exist at any one time is limited by both `max_worker_processes` and `max_parallel_workers`."* https://www.postgresql.org/docs/16/how-parallel-query-works.html

[^bgworker]: PostgreSQL 16 docs, "Background Worker Processes": *"PostgreSQL can be extended to run user-supplied code in separate processes. Such processes are started, stopped and monitored by `postgres`, which permits them to have a lifetime closely linked to the server's status."* and *"There are considerable robustness and security risks in using background worker processes because, being written in the `C` language, they have unrestricted access to data."* https://www.postgresql.org/docs/16/bgworker.html

[^wal-writer-cfg]: PostgreSQL 16 docs, `wal_writer_delay`: *"Specifies how often the WAL writer flushes WAL, in time terms. After flushing WAL the writer sleeps for the length of time given by `wal_writer_delay`, unless woken up sooner by an asynchronously committing transaction."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^wal-buffers]: PostgreSQL 16 docs, `wal_buffers`: *"The amount of shared memory used for WAL data that has not yet been written to disk. The default setting of -1 selects a size equal to 1/32nd (about 3%) of `shared_buffers`, but not less than `64kB` nor more than the size of one WAL segment, typically `16MB`."* https://www.postgresql.org/docs/16/runtime-config-wal.html

[^pg16-resource]: PostgreSQL 16 docs, "Resource Consumption": defaults for `max_worker_processes` (8), `max_parallel_workers` (8), `max_parallel_workers_per_gather` (2), `shared_buffers` (128 MB), `min_dynamic_shared_memory` (0). https://www.postgresql.org/docs/16/runtime-config-resource.html

[^pg16-wal-senders]: PostgreSQL 16 docs, `max_wal_senders`: *"Specifies the maximum number of concurrent connections from standby servers or streaming base backup clients (i.e., the maximum number of simultaneously running WAL sender processes). The default is `10`."* https://www.postgresql.org/docs/16/runtime-config-replication.html

[^pg14-min-dsm]: PostgreSQL 14 release notes: *"Allow startup allocation of dynamic shared memory (Thomas Munro). This is controlled by `min_dynamic_shared_memory`. This allows more use of huge pages."* https://www.postgresql.org/docs/release/14.0/

[^pg14-parallel-io]: PostgreSQL 14 release notes: *"Improve the I/O performance of parallel sequential scans (Thomas Munro, David Rowley). This was done by allocating blocks in groups to parallel workers."* https://www.postgresql.org/docs/release/14.0/

[^pg15-stats]: PostgreSQL 15 release notes: *"Store cumulative statistics system data in shared memory (Kyotaro Horiguchi, Andres Freund, Melanie Plageman). Previously this data was sent to a statistics collector process via UDP packets, and could only be read by sessions after transferring it via the file system. There is no longer a separate statistics collector process."* https://www.postgresql.org/docs/release/15.0/

[^pg15-checkpointer-recovery]: PostgreSQL 15 release notes: *"Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro). This helps to speed up long crash recoveries."* https://www.postgresql.org/docs/release/15.0/

[^pg16-release]: PostgreSQL 16 release notes index — no process-model changes; parallel-feature improvements only. https://www.postgresql.org/docs/release/16.0/

[^pg17-checkpointer-split]: PostgreSQL 17 release notes: *"Create system view `pg_stat_checkpointer` (Bharath Rupireddy, Anton A. Melnikov, Alexander Korotkov). Relevant columns have been removed from `pg_stat_bgwriter` and added to this new system view."* and *"Remove `buffers_backend` and `buffers_backend_fsync` from `pg_stat_bgwriter` (Bharath Rupireddy). These fields are considered redundant to similar columns in `pg_stat_io`."* https://www.postgresql.org/docs/release/17.0/

[^pg17-slru]: PostgreSQL 17 release notes: *"Allow the SLRU cache sizes to be configured (Andrey Borodin, Dilip Kumar, Alvaro Herrera). The new server variables are `commit_timestamp_buffers`, `multixact_member_buffers`, `multixact_offset_buffers`, `notify_buffers`, `serializable_buffers`, `subtransaction_buffers`, and `transaction_buffers`."* https://www.postgresql.org/docs/release/17.0/

[^pg17-resource]: PostgreSQL 17 docs, "Resource Consumption": SLRU buffer GUC defaults and auto-sizing formula (`shared_buffers/512`, min 16 blocks, max 1024 blocks). https://www.postgresql.org/docs/17/runtime-config-resource.html

[^pg18-aio]: PostgreSQL 18 release notes: *"Add an asynchronous I/O subsystem (Andres Freund, Thomas Munro, Nazir Bilal Yavuz, Melanie Plageman). This feature allows backends to queue multiple read requests, which allows for more efficient sequential scans, bitmap heap scans, vacuums, etc. This is enabled by server variable `io_method`, with server variables `io_combine_limit` and `io_max_combine_limit` added to control it. ... The new system view `pg_aios` shows the file handles being used for asynchronous I/O."* https://www.postgresql.org/docs/release/18.0/

[^pg18-io-workers]: PostgreSQL 18 docs, `io_workers`: *"Selects the number of I/O worker processes to use. The default is 3. This parameter can only be set in the `postgresql.conf` file or on the server command line. Only has an effect if `io_method` is set to `worker`."* https://www.postgresql.org/docs/18/runtime-config-resource.html

[^pg18-av-slots]: PostgreSQL 18 release notes and docs: *"Add server variable `autovacuum_worker_slots` to specify the maximum number of background workers (Nathan Bossart). With this variable set, `autovacuum_max_workers` can be adjusted at runtime up to this maximum without a server restart."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/runtime-config-autovacuum.html

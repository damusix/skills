# PostgreSQL Advisory Locks

> [!NOTE]
> This file covers application-managed cooperative locks via the `pg_advisory_lock` family. Advisory locks are a separate, independent system from row-level and table-level locks — they share the shared-memory lock pool but never block DML or DDL on their own. For the explicit row/table locking surface see [`43-locking.md`](./43-locking.md). For `SERIALIZABLE` predicate locks see [`42-isolation-levels.md`](./42-isolation-levels.md). For the cluster-wide lock-pool sizing GUC `max_locks_per_transaction` see [`43-locking.md`](./43-locking.md) and [`53-server-configuration.md`](./53-server-configuration.md).


> [!WARNING] Stable across PG14, PG15, PG16, PG17, PG18
> All five supported major versions have **zero** advisory-lock release-note items. The function catalog, semantics, key spaces, scope rules, and `pg_locks` encoding have been stable since at least PG 9.x. If a tutorial or blog post claims a recent PG version improved advisory locks, verify against the per-major release notes directly — the claim is almost certainly wrong or about a different feature.


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Function catalog](#function-catalog)
    - [Session-level vs transaction-level](#session-level-vs-transaction-level)
    - [Key spaces](#key-spaces)
    - [Shared vs exclusive](#shared-vs-exclusive)
    - [Stacking and reentrancy](#stacking-and-reentrancy)
    - [pg_locks encoding](#pg_locks-encoding)
    - [Wait events](#wait-events)
    - [Capacity and shared-memory pool](#capacity-and-shared-memory-pool)
    - [The LIMIT trap](#the-limit-trap)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Use this file when you are:

- Building a singleton job — only one worker may run the daily report at a time across N application servers.
- Building a distributed semaphore — at most K workers may run an expensive operation simultaneously.
- Implementing leader election among hot-standby application processes.
- Guarding a schema migration so that two deploy pipelines do not race.
- Coordinating a one-time initialization or backfill that must run exactly once cluster-wide.
- Looking at `pg_locks` and trying to decode an `advisory` row back to the application key.
- Deciding whether advisory locks or `SELECT … FOR UPDATE` is the right pattern for cross-session coordination.

If you need to lock rows in a way the database enforces, advisory locks are the **wrong** tool — use `SELECT … FOR UPDATE` (see [`43-locking.md`](./43-locking.md)). If you need cross-database-cluster coordination, advisory locks are also the wrong tool — they exist only within one cluster, with no cross-cluster propagation.


## Mental Model

Five rules that drive almost every advisory-lock decision:

1. **Advisory locks are cooperative — the server tracks them but does not enforce their meaning.** Verbatim from the docs: *"these are called advisory locks, because the system does not enforce their use — it is up to the application to use them correctly."*[^advisory-cooperative] An advisory lock on key `12345` does not protect any row, table, or value. It is just a named slot in the lock manager that two sessions can fight over. The application decides what the slot stands for. Code that takes an advisory lock and then forgets to check it before doing work has not protected anything.

2. **There are two scopes — session-level and transaction-level — with radically different semantics around transaction rollback.** Session-level locks (`pg_advisory_lock`, `pg_try_advisory_lock`, plus the `_shared` variants) are held until you explicitly release them OR your session disconnects. They do **not** honor transaction semantics. Verbatim: *"a lock acquired during a transaction that is later rolled back will still be held following the rollback, and likewise an unlock is effective even if the calling transaction fails later."*[^session-vs-xact] Transaction-level locks (`pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`, plus `_shared` variants) release automatically at COMMIT or ROLLBACK. There is no explicit unlock for the transaction-level variants. For short-term coordination, prefer transaction-level — it cleans up automatically.

3. **There are two key spaces — a single `bigint` and a pair of `(int4, int4)` — and they do not overlap.** Verbatim: *"these two key spaces do not overlap."*[^key-spaces] A lock on `pg_advisory_lock(1)` is a **different** lock from `pg_advisory_lock(0, 1)`. Pick one form per application and stick with it. The two-int form is the canonical choice when you have two natural identifiers to combine (e.g., tenant_id + operation_id). The single-bigint form is canonical for hashed string identifiers.

4. **Session-level locks stack — N acquires require N releases by the same backend.** Verbatim: *"Multiple session-level lock requests stack, so that if the same resource identifier is locked three times there must then be three unlock requests to release the resource in advance of session end."*[^stacking] Reentrancy by the current holder always succeeds: *"If a session already holds a given advisory lock, additional requests by it will always succeed, even if other sessions are awaiting the lock."*[^reentrancy] This means `pg_advisory_lock` is **not** idempotent — calling it twice in the same backend takes two slots. Use `pg_try_advisory_lock` with a held-already check if you need idempotence.

5. **Advisory locks consume shared memory from the same pool as row/table locks** — sized by `max_locks_per_transaction × (max_connections + max_prepared_transactions)`. Verbatim: *"Both advisory locks and regular locks are stored in a shared memory pool whose size is defined by the configuration variables `max_locks_per_transaction` and `max_connections`. Care must be taken not to exhaust this memory or the server will be unable to grant any locks at all."*[^shared-pool] On a cluster with `max_locks_per_transaction = 64` and `max_connections = 100`, there is a hard ceiling of roughly 6,400 concurrent locks (advisory + relation + tuple combined). Holding tens of thousands of session-level advisory locks across long-lived connections will drive the pool to exhaustion and break **all** locking — including DDL.


## Decision Matrix

| Situation | Use | Avoid | Notes |
|---|---|---|---|
| One worker runs a singleton job (daily report, leader election, schema migration) | `pg_try_advisory_lock(key)` returns false if held; exit | A sentinel-row `UPDATE` with `FOR UPDATE` | Advisory is cheaper and auto-releases on disconnect; no row to clean up. |
| At most K workers run the same expensive operation simultaneously | Distributed semaphore: try N+1 keys, succeed if any free | Application-level counters in a row | Implemented as N separate advisory keys, each worker grabs the first free one. Recipe 4. |
| Coordination needed only for the duration of one transaction | `pg_advisory_xact_lock(key)` — auto-releases at COMMIT/ROLLBACK | Session-level lock then manual unlock | Transaction-level avoids the rollback-doesn't-release foot-gun (Rule 2). |
| Coordination needed across multiple transactions in one session | `pg_advisory_lock(key)` (session-level) | `pg_advisory_xact_lock` (releases too early) | Session-level locks survive across `COMMIT`/`ROLLBACK` boundaries within the same session. |
| String identifier (e.g., a tenant slug, a migration filename) | Single `bigint` form, hash to bigint: `pg_advisory_lock(hashtext('migration_v42')::bigint)` | Two-int form for arbitrary strings | Recipe 9 shows the safe hashtext pattern. |
| Two natural integer identifiers (tenant_id, operation_id) | Two-int form: `pg_advisory_lock(tenant_id, operation_id)` | Bit-packing into one bigint | Two-int reads naturally and is searchable in `pg_locks` (Recipe 7). |
| Many readers may proceed concurrently; exclusive only when writing | `pg_advisory_lock_shared` / `pg_advisory_xact_lock_shared` | Always exclusive | Shared advisory locks behave like RW-locks — multiple shared OK, exclusive blocks all shared. |
| Wait at most N seconds for a lock | `SET LOCAL lock_timeout = '5s'; pg_advisory_lock(...)` | Loop calling `pg_try_advisory_lock` with `pg_sleep` | `lock_timeout` raises `lock_not_available` (`55P03`) cleanly. |
| Application wants "is this held right now?" | `pg_try_advisory_lock(key)` then immediately release | Read `pg_locks` from app code | The try-then-release pattern is the canonical "is anyone working on this?" check; reading `pg_locks` is racy. |
| Lock must survive past application disconnect | **None of the advisory lock forms** | Any advisory lock at all | Advisory locks release on session end. For persistent coordination use a state row in a table. |
| Coordinating across two PostgreSQL clusters | **None of the advisory lock forms** | Cross-cluster advisory locks | Advisory locks are cluster-local. Use a distributed coordinator (etcd, Consul, Zookeeper). |
| Lock for a row's content / business invariant | `SELECT … FOR UPDATE` — see [`43-locking.md`](./43-locking.md) | Advisory locks as row substitutes | Advisory locks cannot prevent row writes; only `FOR UPDATE` can. |

Three smell signals that you have reached for the wrong lock type:

- **You are catching `lock_timeout` failures and retrying in a tight loop.** Advisory locks under contention should usually be released and the work skipped or deferred, not retried. If retry is correct, the operation is probably a queue and `SELECT … FOR UPDATE SKIP LOCKED` is the right pattern (see [`43-locking.md`](./43-locking.md) Recipe 4).
- **Your pool of database connections grows because each long-lived connection holds an advisory lock waiting for work.** Holding session-level advisory locks across application requests through a connection pool ([`81-pgbouncer.md`](./81-pgbouncer.md)) means the lock attaches to a pooler backend, not your application — and pooler transaction-mode pooling will return the connection to the pool before your unlock runs. Use transaction-level advisory locks or move coordination outside the database.
- **You see `out of shared memory; HINT: You might need to increase max_locks_per_transaction`.** This is the shared-pool exhaustion signal from Rule 5. Audit for session-level locks held forever (one application that took `pg_advisory_lock` and never released it), then size the GUC for the observed peak.


## Syntax / Mechanics


### Function catalog

The full catalog is small and orthogonal — each function has a single-bigint form and a two-int form, with `_shared` variants for read-style locks and `_try_` variants for non-blocking acquisition. All 10 logical functions × 2 key spaces = 20 callable forms.

| Function | Scope | Shared/Exclusive | Wait/Try | Returns | One-line description |
|---|---|---|---|---|---|
| `pg_advisory_lock(bigint)` / `(int, int)` | Session | Exclusive | Wait | `void` | Obtains an exclusive session-level advisory lock, waiting if necessary.[^lock-fns] |
| `pg_advisory_lock_shared(bigint)` / `(int, int)` | Session | Shared | Wait | `void` | Obtains a shared session-level advisory lock, waiting if necessary.[^lock-fns] |
| `pg_advisory_xact_lock(bigint)` / `(int, int)` | Transaction | Exclusive | Wait | `void` | Obtains an exclusive transaction-level advisory lock, waiting if necessary.[^lock-fns] |
| `pg_advisory_xact_lock_shared(bigint)` / `(int, int)` | Transaction | Shared | Wait | `void` | Obtains a shared transaction-level advisory lock, waiting if necessary.[^lock-fns] |
| `pg_try_advisory_lock(bigint)` / `(int, int)` | Session | Exclusive | Try | `boolean` | Obtains an exclusive session-level advisory lock if available. Returns `true` immediately or `false` without waiting.[^lock-fns] |
| `pg_try_advisory_lock_shared(bigint)` / `(int, int)` | Session | Shared | Try | `boolean` | Obtains a shared session-level advisory lock if available.[^lock-fns] |
| `pg_try_advisory_xact_lock(bigint)` / `(int, int)` | Transaction | Exclusive | Try | `boolean` | Obtains an exclusive transaction-level advisory lock if available.[^lock-fns] |
| `pg_try_advisory_xact_lock_shared(bigint)` / `(int, int)` | Transaction | Shared | Try | `boolean` | Obtains a shared transaction-level advisory lock if available.[^lock-fns] |
| `pg_advisory_unlock(bigint)` / `(int, int)` | Session | (matches held) | — | `boolean` | Releases a previously-acquired exclusive session-level advisory lock. Returns `true` on success. *"If the lock was not held, `false` is returned, and in addition, an SQL warning will be reported by the server."*[^unlock-fn] |
| `pg_advisory_unlock_shared(bigint)` / `(int, int)` | Session | Shared | — | `boolean` | Releases a previously-acquired shared session-level advisory lock.[^lock-fns] |
| `pg_advisory_unlock_all()` | Session (all) | — | — | `void` | Releases all session-level advisory locks held by the current session. *"This function is implicitly invoked at session end, even if the client disconnects ungracefully."*[^unlock-all] |

There is no `pg_advisory_xact_unlock`. Transaction-level locks release implicitly at COMMIT or ROLLBACK; trying to unlock them with `pg_advisory_unlock` returns `false` and warns.


### Session-level vs transaction-level

The full verbatim docs paragraph names every property of both:

> *"Once acquired at session level, an advisory lock is held until explicitly released or the session ends. Unlike standard lock requests, session-level advisory lock requests do not honor transaction semantics: a lock acquired during a transaction that is later rolled back will still be held following the rollback, and likewise an unlock is effective even if the calling transaction fails later. A lock can be acquired multiple times by its owning process; for each completed lock request there must be a corresponding unlock request before the lock is actually released. Transaction-level lock requests, on the other hand, behave more like regular lock requests: they are automatically released at the end of the transaction, and there is no explicit unlock operation. This behavior is often more convenient than the session-level behavior for short-term usage of an advisory lock. Session-level and transaction-level lock requests for the same advisory lock identifier will block each other in the expected way."*[^session-vs-xact]

Five operational consequences:

1. **`ROLLBACK` does not release session-level advisory locks.** Use `pg_advisory_unlock` in a `finally`/`ensure` block, or use the transaction-level variant.
2. **`COMMIT` does not release session-level advisory locks either.** They live until session end.
3. **Transaction-level and session-level locks on the same key block each other normally** — you do not get to escape contention by switching scope.
4. **There is no upgrade or downgrade.** Once you acquired session-level, you must release session-level. You cannot "convert" a session-level lock into a transaction-level one.
5. **Disconnect always releases everything**, even ungraceful disconnects — the postmaster cleans up the backend's lock entries when reaping the orphaned process.


### Key spaces

Two key spaces, **non-overlapping**:

| Form | Domain | Lock identity |
|---|---|---|
| Single `bigint` | All `bigint` values (`-2^63 .. 2^63-1`) | `(bigint=K)` |
| Two `int4` | All ordered pairs `(int4, int4)` | `(int4=K1, int4=K2)` |

Verbatim rule: *"these two key spaces do not overlap."*[^key-spaces] A lock with bigint key `1` is distinct from a lock with two-int key `(0, 1)`. The first appears in `pg_locks` with `objsubid = 1`; the second appears with `objsubid = 2`. The `objsubid` column is the discriminator.

Pick one form per application:

- **Single bigint** is the canonical choice when your key is a hashed string. Pattern: `pg_advisory_lock(hashtext('schema_migration_v42')::bigint)`. `hashtext` is stable and returns `int4`; cast to `bigint` to use the single-bigint form. Recipe 9.
- **Two int4** is the canonical choice when your key is a pair of natural integers (tenant_id + operation_id, user_id + resource_id). Pattern: `pg_advisory_lock(tenant_id, op_id)`. Recipe 5.

Do not mix the two forms for the same logical lock — workers using `pg_advisory_lock(123)` and `pg_advisory_lock(0, 123)` will not see each other's locks at all.


### Shared vs exclusive

Verbatim: *"Locks can be either shared or exclusive: a shared lock does not conflict with other shared locks on the same resource, only with exclusive locks."*[^shared-exclusive] The semantics mirror the rwlock/sxlock primitive:

| Holder | Requester | Result |
|---|---|---|
| (none) | Shared | Granted |
| (none) | Exclusive | Granted |
| Shared (by N sessions) | Shared (new) | Granted; N+1 shared holders |
| Shared (by N sessions) | Exclusive | Waits until all N release |
| Exclusive | Shared | Waits |
| Exclusive | Exclusive | Waits |

Shared locks are useful when you have a "readers can proceed concurrently, writers are mutually exclusive" pattern — e.g., many workers read a configuration cache, but only one may rebuild it at a time. The convention is: workers take `pg_advisory_lock_shared`, the rebuilder takes `pg_advisory_lock` (exclusive). Exclusive then waits for all readers and blocks new readers.

In practice, the majority of advisory-lock uses are exclusive only — singleton job, leader election, schema migration. Shared is the right choice for read-style coordination where multiple callers may proceed concurrently.


### Stacking and reentrancy

Verbatim, the full rule: *"Multiple session-level lock requests stack, so that if the same resource identifier is locked three times there must then be three unlock requests to release the resource in advance of session end."*[^stacking]

And: *"If a session already holds a given advisory lock, additional requests by it will always succeed, even if other sessions are awaiting the lock; this statement is true regardless of whether the existing lock hold and new request are at session level or transaction level."*[^reentrancy]

Three operational facts:

1. **Calling `pg_advisory_lock(K)` twice in one backend takes two slots.** You must call `pg_advisory_unlock(K)` twice to actually release.
2. **The current holder always succeeds on re-acquire — even if other backends are queued waiting for the lock.** This is the reentrancy guarantee.
3. **Mixing scopes within one backend reentrantly is legal but confusing.** A backend holding a session-level lock can take a transaction-level lock on the same key (it succeeds because of reentrancy), and the transaction-level lock releases at COMMIT but the session-level one persists. Recipe 11 demonstrates.


### pg_locks encoding

When you read `pg_locks` with `locktype = 'advisory'`, the columns `classid`, `objid`, `objsubid` encode the key. The encoding depends on which key-space form was used:

| Original call | `classid` | `objid` | `objsubid` |
|---|---|---|---|
| `pg_advisory_lock(K)` where K is `bigint` | high 32 bits of K (signed) | low 32 bits of K (signed) | **1** |
| `pg_advisory_lock(K1, K2)` where K1, K2 are `int4` | K1 | K2 | **2** |

Verbatim: *"A `bigint` key is displayed with its high-order half in the `classid` column, its low-order half in the `objid` column, and `objsubid` equal to 1. The original `bigint` value can be reassembled with the expression `(classid::bigint << 32) | objid::bigint`. Integer keys are displayed with the first key in the `classid` column, the second key in the `objid` column, and `objsubid` equal to 2."*[^pg-locks-advisory]

This is the only way to decode advisory locks from a `pg_locks` snapshot back to application keys. Recipe 7 walks through the SQL.


### Wait events

When a backend blocks waiting for an advisory lock, its `pg_stat_activity` row shows `wait_event_type = 'Lock'` and `wait_event = 'advisory'`. Verbatim from the wait-event catalog: *"`advisory` — Waiting to acquire an advisory user lock."*[^wait-event]

This is the canonical signal in monitoring dashboards that some session is waiting on an application-defined coordination lock — distinct from `wait_event = 'relation'` (waiting on a table lock) or `wait_event = 'transactionid'` (waiting on a row's xmax).


### Capacity and shared-memory pool

Advisory locks are stored in the same shared-memory lock pool as relation locks, tuple locks, transaction-id locks, and every other lock type. The pool size is fixed at server start by:

```
total_lock_slots ≈ max_locks_per_transaction × (max_connections + max_prepared_transactions)
```

Default values: `max_locks_per_transaction = 64`, `max_connections = 100`, `max_prepared_transactions = 0`. Default total ≈ 6,400 slots — shared across all backends, all lock types.

Verbatim warning: *"Care must be taken not to exhaust this memory or the server will be unable to grant any locks at all. This imposes an upper limit on the number of advisory locks grantable by the server, typically in the tens to hundreds of thousands depending on how the server is configured."*[^shared-pool]

When the pool is exhausted, the server raises:

```
ERROR:  out of shared memory
HINT:  You might need to increase max_locks_per_transaction.
```

This error blocks **all** new lock acquisitions — including the `ACCESS SHARE` lock taken by every `SELECT` and the `ROW EXCLUSIVE` lock taken by every `UPDATE`. A runaway advisory-lock holder can take the entire cluster down. Recipe 8 shows the audit query.

Sizing rule of thumb: budget `peak_concurrent_advisory_locks_per_backend + 64` as the `max_locks_per_transaction` floor. Raising it is restart-only (see [`53-server-configuration.md`](./53-server-configuration.md)).


### The LIMIT trap

The verbatim docs example is the canonical warning. *"In certain cases using advisory locking methods, especially in queries involving explicit ordering and `LIMIT` clauses, care must be taken to control the locks acquired because of the order in which SQL expressions are evaluated."*[^limit-trap]

```sql
-- ok: WHERE filter evaluated first, exactly one row processed
SELECT pg_advisory_lock(id) FROM foo WHERE id = 12345;

-- DANGER: LIMIT is not guaranteed to apply before the locking function fires.
-- The planner may evaluate pg_advisory_lock for every row that matches the
-- predicate before applying LIMIT, leaving dangling locks the application
-- did not expect.
SELECT pg_advisory_lock(id) FROM foo WHERE id > 12345 LIMIT 100;

-- ok: subquery materializes the limited set first, then the outer query
-- evaluates pg_advisory_lock against exactly 100 ids
SELECT pg_advisory_lock(q.id) FROM (
  SELECT id FROM foo WHERE id > 12345 LIMIT 100
) q;
```

The verbatim warning: *"the second form is dangerous because the `LIMIT` is not guaranteed to be applied before the locking function is executed. This might cause some locks to be acquired that the application was not expecting, and hence would fail to release (until it ends the session). From the point of view of the application, such locks would be dangling, although still viewable in `pg_locks`."*[^limit-trap]

Rule: **never call an advisory-lock function directly in a SELECT's target list against a `LIMIT`ed result.** Always materialize the row set first via a subquery or CTE, then apply the lock function to the materialized rows.


### Per-version timeline

| Version | Advisory-lock changes | Notes |
|---|---|---|
| PG14 | **None** | Zero advisory-lock items in PG14 release notes. |
| PG15 | **None** | Zero advisory-lock items in PG15 release notes. |
| PG16 | **None** | Zero advisory-lock items in PG16 release notes. The PG16 *"Simplify permissions for `LOCK TABLE`"* change applies to `LOCK TABLE` statements only, not to advisory locks. |
| PG17 | **None** | Zero advisory-lock items in PG17 release notes. |
| PG18 | **None** | Zero advisory-lock items in PG18 release notes. The PG18 `log_lock_failures` GUC logs `SELECT … NOWAIT` failures but does not cover `pg_try_advisory_lock` returning `false` (those are not failures — they are the documented "lock not available" return). |

**Five consecutive major versions with zero advisory-lock changes.** The semantics, function signatures, key spaces, scoping rules, and `pg_locks` encoding documented in this file apply identically to every supported PG release. If you find a Stack Overflow answer claiming "in PG16 advisory locks now do X" — verify against the release notes; the claim is wrong.


## Examples / Recipes


### Recipe 1: Singleton job (only one worker may run the daily report)

Pattern: every worker calls `pg_try_advisory_lock` on a fixed key. Exactly one succeeds; the rest exit. Auto-releases on disconnect.

```sql
-- Convention: namespace your keys. This is the daily-report lock.
-- Use a project-wide constant for the namespace half.
DO $$
BEGIN
    IF NOT pg_try_advisory_lock(42, 1) THEN
        RAISE NOTICE 'daily report already running, exiting';
        RETURN;
    END IF;

    -- ... run the report ...

    PERFORM pg_advisory_unlock(42, 1);
END $$;
```

The `(42, 1)` key uses the two-int form: namespace `42` for "your project" and operation `1` for "daily report". This makes the key searchable in `pg_locks` (Recipe 7).

If the worker crashes during the report, the session terminates and the lock auto-releases. Next run will succeed cleanly.


### Recipe 2: Schema migration guard (one migration at a time)

A common deploy-pipeline coordination need: multiple instances of the migration tool start in parallel during a rolling deploy. Only one should actually run.

```sql
BEGIN;

-- hashtext is stable; pin to the migration filename
SELECT pg_advisory_xact_lock(hashtext('migrations/v42_add_users_email.sql')::bigint);

-- ... DDL runs here ...
ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX CONCURRENTLY users_email_idx ON users(email);

COMMIT;
```

Why `pg_advisory_xact_lock` not `pg_advisory_lock`: the transaction-level form auto-releases at COMMIT. If the migration fails mid-DDL and rolls back, the lock releases too — the next attempt can retry cleanly. The session-level form would leave the lock held even after rollback (Rule 2), and a redeploy of the migration container would block forever until someone killed the original session.

> [!WARNING]
> `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block (see [`26-index-maintenance.md`](./26-index-maintenance.md)). Split the migration into separate transactions, taking `pg_advisory_xact_lock` in each, OR take a session-level `pg_advisory_lock` outside any transaction and release explicitly in a `finally` block.


### Recipe 3: Refresh materialized view with skip-if-running

```sql
DO $$
BEGIN
    IF NOT pg_try_advisory_lock(hashtext('refresh_user_stats')::bigint) THEN
        RAISE NOTICE 'refresh already running, skipping';
        RETURN;
    END IF;

    REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats;

    PERFORM pg_advisory_unlock(hashtext('refresh_user_stats')::bigint);
EXCEPTION WHEN OTHERS THEN
    -- Ensure release even on error. This is the canonical pattern
    -- for session-level locks (Rule 2).
    PERFORM pg_advisory_unlock(hashtext('refresh_user_stats')::bigint);
    RAISE;
END $$;
```

Note that the EXCEPTION block creates a subtransaction (see [`08-plpgsql.md`](./08-plpgsql.md) gotcha #5 and [`27-mvcc-internals.md`](./27-mvcc-internals.md)) — for high-frequency calls this matters. A safer high-frequency pattern is `pg_advisory_xact_lock` inside a single transaction wrapping just the refresh:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('refresh_user_stats')::bigint);
REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats;
COMMIT;
```

This blocks (rather than skipping) if another refresh is running — pick the form that matches your scheduling semantics.


### Recipe 4: Distributed semaphore (at most K concurrent expensive operations)

Limit how many workers may simultaneously run an expensive job — e.g., at most 3 concurrent embedding-generation workers.

```sql
-- Try keys 1..K. First free key wins. If none free, semaphore is saturated.
CREATE OR REPLACE FUNCTION acquire_semaphore_slot(
    sem_namespace int,
    max_slots int
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    slot int;
BEGIN
    FOR slot IN 1..max_slots LOOP
        IF pg_try_advisory_lock(sem_namespace, slot) THEN
            RETURN slot;
        END IF;
    END LOOP;
    RETURN NULL;  -- semaphore saturated
END $$;
```

Worker:

```sql
SELECT acquire_semaphore_slot(100, 3) AS slot;  -- namespace 100 = "embedding workers", K=3
-- if slot IS NULL, the semaphore is saturated; defer or fail
-- otherwise:
-- ... do work ...
SELECT pg_advisory_unlock(100, slot);
```

The auto-release-on-disconnect guarantee gives you crash-safe semaphore behavior — a worker that crashes mid-work loses its slot, and the next worker picks it up.


### Recipe 5: Per-tenant exclusive operation

When the same operation may run concurrently across different tenants but must serialize within a tenant — e.g., billing finalization, monthly aggregate rebuild.

```sql
-- Lock is per-tenant; tenants don't block each other
BEGIN;
SELECT pg_advisory_xact_lock(tenant_id, 7) FROM tenants WHERE id = $1;
--                          ^^^^^^^^^^^ ^
--                          per-tenant  "operation 7 = billing finalize"

-- ... billing-finalize logic ...

COMMIT;  -- auto-releases the lock
```

This is the canonical use case for the two-int form. Reading `pg_locks` (Recipe 7) shows exactly which tenants currently have which operation in progress.


### Recipe 6: Leader election among application processes

```sql
-- Each process tries to be leader. Whoever succeeds is the leader.
-- On disconnect (process crash, restart), the lock releases and a
-- new leader is elected on the next try.

SELECT pg_try_advisory_lock(0, 1) AS am_leader;  -- (0, 1) = "leader of application X"
```

Workers poll periodically. Whoever holds the lock is the leader. When that backend disconnects, the lock auto-releases and another worker picks it up on its next poll.

Advisory locks do not survive failover — they release when the session ends or the primary changes. If you need leader election with fencing tokens, use etcd/Consul/ZooKeeper (see [`78-ha-architectures.md`](./78-ha-architectures.md)). Advisory-lock leader election is appropriate for "one of these workers should be the cron-runner; if it crashes, another takes over within a poll cycle" — not for safety-critical coordination.


### Recipe 7: Inspect advisory locks in pg_locks

Find all advisory locks currently held, with both key-form decoded back to application identifiers.

```sql
SELECT
    l.pid,
    a.usename,
    a.application_name,
    l.mode,
    l.granted,
    CASE l.objsubid
        WHEN 1 THEN format('bigint=%s',
                           (l.classid::bigint << 32) | l.objid::bigint)
        WHEN 2 THEN format('(%s, %s)', l.classid, l.objid)
    END AS key,
    a.query,
    age(now(), a.xact_start) AS xact_age
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
ORDER BY l.granted ASC, age(now(), a.xact_start) DESC NULLS LAST;
```

The `objsubid` discriminator is what tells you whether `classid`/`objid` should be read as a single combined bigint or as two separate integers. Ungranted rows (`granted = false`) show backends currently waiting on advisory locks — the canonical signal that contention is real.


### Recipe 8: Audit shared-memory lock-pool exhaustion risk

```sql
WITH pool_size AS (
    SELECT (current_setting('max_locks_per_transaction')::int *
            (current_setting('max_connections')::int +
             current_setting('max_prepared_transactions')::int))
           AS total_slots
),
current_use AS (
    SELECT count(*) AS in_use,
           count(*) FILTER (WHERE locktype = 'advisory') AS advisory_locks,
           count(DISTINCT pid) AS distinct_backends
    FROM pg_locks
)
SELECT
    p.total_slots,
    u.in_use,
    u.advisory_locks,
    u.distinct_backends,
    round(100.0 * u.in_use / p.total_slots, 1) AS pct_used,
    CASE
        WHEN u.in_use::numeric / p.total_slots > 0.75 THEN 'CRITICAL: raise max_locks_per_transaction'
        WHEN u.in_use::numeric / p.total_slots > 0.50 THEN 'WARN: monitor'
        ELSE 'OK'
    END AS status
FROM pool_size p CROSS JOIN current_use u;
```

Run this on any cluster that uses advisory locks at scale. Three-tier interpretation: `<50%` healthy, `50-75%` watch list, `>75%` raise the GUC. Raising `max_locks_per_transaction` is restart-only (see [`53-server-configuration.md`](./53-server-configuration.md)).


### Recipe 9: Convert string identifier to bigint via hashtext

When your natural lock key is a string (migration filename, tenant slug, queue name), the canonical pattern is `hashtext(...)::bigint`. `hashtext` is `IMMUTABLE`, returns `int4`, and is stable across PG versions.

```sql
-- The cast to bigint is mandatory: hashtext returns int4 (32 bits), but
-- pg_advisory_lock with a single int argument would attempt the two-int
-- form. Casting to bigint forces the single-bigint form.
SELECT pg_advisory_xact_lock(hashtext('queue:invoice_emails')::bigint);
```

Hash collisions are possible but unlikely in practice (32-bit hash space). If two semantically different lock names happen to hash to the same `int4`, you will get over-serialization — workers on the colliding keys will wait for each other. Mitigation: prefix every key with a namespace string that you keep distinct in your application (`'inv:foo'`, `'usr:foo'` — the prefix prevents most collisions).

Do not use MD5/SHA1 for the hash. Those are slow `text`-returning functions; `hashtext` is the canonical fast PG hash and exactly the right tool here.


### Recipe 10: Bound wait time with lock_timeout

`pg_advisory_lock` waits indefinitely. To give up after N seconds, set `lock_timeout` for just the lock acquisition:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(42, 7);  -- raises lock_not_available (55P03) if not granted in 5s
-- ... work ...
COMMIT;
```

`SET LOCAL` scopes the timeout to the current transaction. The raised SQLSTATE is `55P03 lock_not_available` (the same code as `NOWAIT` on row locks). Catch it in application code if you want graceful degradation.

`lock_timeout` applies to advisory locks inside an explicit transaction. Outside a transaction (autocommit single-statement mode), `lock_timeout` does not apply to advisory-lock waits — use `statement_timeout` or `pg_try_advisory_lock()` in that context. See [`43-locking.md`](./43-locking.md) Gotcha #10 for the scoping rule.


### Recipe 11: Reentrancy and scope mixing

Demonstrates the verbatim "if a session already holds a given advisory lock, additional requests by it will always succeed" rule.

```sql
BEGIN;
SELECT pg_advisory_lock(1, 1);       -- session-level, exclusive
SELECT pg_advisory_xact_lock(1, 1);  -- succeeds via reentrancy (Rule 4)
SELECT pg_advisory_lock(1, 1);       -- succeeds; now held twice at session level

SELECT count(*) FROM pg_locks
WHERE locktype = 'advisory'
  AND pid = pg_backend_pid()
  AND classid = 1 AND objid = 1;
-- Returns 3 (two session + one transaction) — stacked count.

COMMIT;
-- Transaction-level entry released. Two session-level entries remain.

SELECT pg_advisory_unlock(1, 1);  -- true (one released)
SELECT pg_advisory_unlock(1, 1);  -- true (second released)
SELECT pg_advisory_unlock(1, 1);  -- false + WARNING (none left)
```

This is the canonical demonstration of stacking (Rule 4). The held-count is observable in `pg_locks` — each acquisition is a separate row.


### Recipe 12: Lock-around a batch operation with rollback safety

The full pattern for "do work under a session-level lock with rollback-safe release":

```sql
DO $$
DECLARE
    have_lock boolean;
BEGIN
    have_lock := pg_try_advisory_lock(99, 42);
    IF NOT have_lock THEN
        RAISE NOTICE 'lock not available, skipping';
        RETURN;
    END IF;

    BEGIN
        -- ... real work ...
        UPDATE accounts SET balance = balance * 1.01 WHERE active = true;
        -- (if this raises, the EXCEPTION block below catches it
        --  and we still release the lock)
    EXCEPTION WHEN OTHERS THEN
        PERFORM pg_advisory_unlock(99, 42);
        RAISE;
    END;

    PERFORM pg_advisory_unlock(99, 42);
END $$;
```

The lock is acquired *outside* the inner BEGIN/EXCEPTION block, and the unlock appears *in two places* — once in the EXCEPTION handler (for failure path) and once after the inner block (for success path). Use `pg_advisory_xact_lock` instead if your work fits in one transaction (Recipe 5) — it releases automatically at COMMIT/ROLLBACK.


### Recipe 13: Audit advisory-lock holders across an HA failover

After a streaming-replication failover (see [`77-standby-failover.md`](./77-standby-failover.md)), the new primary has **no** advisory locks held — slots are local to a postmaster instance and do not propagate via replication. Applications that depended on advisory locks for coordination must:

1. **Reconnect** to the new primary.
2. **Re-acquire** their locks.
3. **Reconcile state** that may have been "protected" by an advisory lock that the new primary has never seen.

```sql
-- Run on the new primary after failover. Should always return zero rows
-- immediately after promotion (because slots reset).
SELECT count(*) FROM pg_locks WHERE locktype = 'advisory';
```

If the count is non-zero immediately after promotion, you have applications that have already reconnected and re-acquired — verify the operational sequence is correct. The takeaway: advisory locks are **not** durable HA primitives. For coordination that must survive failover, use a row in a table (which is replicated) or an external coordinator.


## Gotchas / Anti-patterns

1. **Advisory locks do not enforce anything.** Verbatim: *"the system does not enforce their use — it is up to the application to use them correctly."*[^advisory-cooperative] If you take an advisory lock and then forget to check it before doing the work, the lock has done nothing. The check must be explicit in application code.

2. **`ROLLBACK` does not release session-level advisory locks.** Verbatim: *"a lock acquired during a transaction that is later rolled back will still be held following the rollback."*[^session-vs-xact] If you take `pg_advisory_lock` inside a transaction that errors, the lock survives the rollback. Use `pg_advisory_xact_lock` for transaction-scope coordination, or unlock in an EXCEPTION handler.

3. **The two key spaces do not overlap.** `pg_advisory_lock(1)` and `pg_advisory_lock(0, 1)` are different locks. Workers using different forms will not see each other. Pick one form per application.

4. **Session-level locks stack — N acquires require N releases.** Calling `pg_advisory_lock(K)` twice in one backend takes two slots. Do not assume `pg_advisory_lock` is idempotent.

5. **Reentrancy succeeds even when other backends are queued.** Verbatim: *"If a session already holds a given advisory lock, additional requests by it will always succeed, even if other sessions are awaiting the lock."*[^reentrancy] A backend that calls `pg_advisory_lock(K)` and waits for a second backend's reply that calls `pg_advisory_lock(K)` will deadlock — but if the same backend recursively re-acquires its own lock, it succeeds, which can mask logic bugs.

6. **`pg_advisory_unlock` returns `false` and warns when the lock was not held.** Application code that calls unlock blindly will log warnings into the server log. Check `pg_locks` first or save the boolean from the acquire call.

7. **There is no `pg_advisory_xact_unlock` function.** Transaction-level locks release implicitly at COMMIT/ROLLBACK. Calling `pg_advisory_unlock` on a transaction-level lock returns `false` and warns (it does not find a session-level lock with that key).

8. **Holding session-level advisory locks across a connection pooler is a foot-gun.** With pgBouncer in transaction mode ([`81-pgbouncer.md`](./81-pgbouncer.md)), each transaction may run on a different backend. A `pg_advisory_lock` taken in one transaction attaches to that backend; the next transaction from the same client may land on a different backend and not "see" the lock. Always use transaction-level advisory locks behind transaction-mode poolers, or pin a session.

9. **`SELECT pg_advisory_lock(id) FROM tbl WHERE … LIMIT N` may acquire more locks than `N`.** Verbatim: *"the `LIMIT` is not guaranteed to be applied before the locking function is executed."*[^limit-trap] Always materialize the row set first via a subquery, then apply the lock function.

10. **Advisory locks share the shared-memory lock pool with all other lock types.** Verbatim: *"Care must be taken not to exhaust this memory or the server will be unable to grant any locks at all."*[^shared-pool] A leaky advisory-lock acquirer can break **all** locking, including DDL. Audit with Recipe 8.

11. **`max_locks_per_transaction` is restart-only.** If you exhaust the pool, raising the GUC requires a server restart. Plan for headroom up-front.

12. **`hashtext(string)::bigint` is the right pattern for string keys; `md5(string)::bigint` is wrong.** `md5` returns text (a hex string); casting hex text to bigint either errors or silently truncates. `hashtext` returns `int4` cleanly.

13. **Hash collisions are real but rare.** Two semantically distinct lock names hashing to the same `int4` will over-serialize. Mitigate by namespacing keys with a project-distinct prefix.

14. **Cross-cluster coordination via advisory locks does not work.** Locks are postmaster-local. Replicas do not see the primary's advisory locks. After failover, all advisory locks reset.

15. **Reading `pg_locks` to "check if anyone has the lock" is racy.** Between your SELECT and your acquire, another backend may have acquired. The atomic check is `pg_try_advisory_lock` itself.

16. **`pg_advisory_unlock_all()` releases only this session's locks, not the whole cluster's.** The function is implicitly invoked at session end — calling it explicitly is rarely useful and is **never** the right way to "clear stuck locks" in another backend.

17. **No way to release another session's advisory locks.** The only way to force release is to terminate the holder with `pg_terminate_backend` — and that has all the standard caveats (see [`43-locking.md`](./43-locking.md) Recipe 10).

18. **Advisory locks do not participate in `pg_blocking_pids()` output in the way relation locks do.** A backend waiting on an advisory lock will show in `pg_blocking_pids()` as blocked by the holder — but only if both are waiting in the same lock manager structure. `pg_safe_snapshot_blocking_pids` does not cover advisory locks at all.

19. **The wait event is `Lock:advisory`, not `Lock:relation`.** Monitoring dashboards filtering on `wait_event = 'relation'` will miss advisory-lock contention. Filter on `wait_event_type = 'Lock'` to catch all lock waits.

20. **Empty arguments do not exist.** There is no `pg_advisory_lock()` with no arguments. You must supply either one bigint or two ints. Calling with a single int (not bigint) will error unless an int → bigint cast is implicit (it is, but only via promotion — better to be explicit with `::bigint`).

21. **PG14, PG15, PG16, PG17, and PG18 have zero advisory-lock release-note items.** If a blog claims a recent PG version improved advisory locks, verify against the per-major release notes directly. The claim is almost certainly wrong, about a different feature, or about a third-party extension.

22. **The `LIMIT` trap also applies to `ORDER BY`.** `SELECT pg_advisory_lock(id) FROM tbl ORDER BY x LIMIT N` is dangerous for the same reason — the planner may execute the lock function before the sort/limit. Always materialize first.

23. **Transaction-level advisory locks released at COMMIT/ROLLBACK are not loggable individually.** Unlike `pg_advisory_unlock` (which warns when the lock was not held), implicit transaction-end release is silent. To audit, monitor `pg_locks` over time or take a snapshot before COMMIT.


## See Also

- [`43-locking.md`](./43-locking.md) — the eight table-level lock modes, row-level locks, deadlock detection, `pg_locks` introspection. Advisory locks share the lock-manager shared-memory pool with these.
- [`42-isolation-levels.md`](./42-isolation-levels.md) — `SERIALIZABLE` predicate locks (`SIReadLock`), which are also visible in `pg_locks` but are not application-managed.
- [`41-transactions.md`](./41-transactions.md) — `BEGIN`/`COMMIT`/`ROLLBACK` semantics that determine when transaction-level advisory locks release. Cross-reference for `idle_in_transaction_session_timeout`, which can terminate sessions holding advisory locks.
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — advisory locks are independent of MVCC; they do not affect tuple visibility.
- [`53-server-configuration.md`](./53-server-configuration.md) — `max_locks_per_transaction`, `max_connections`, `max_prepared_transactions` shared-pool sizing GUCs (all restart-only).
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_locks` schema and join patterns to `pg_stat_activity`.
- [`77-standby-failover.md`](./77-standby-failover.md) — advisory locks reset on failover; applications must reconnect and re-acquire.
- [`81-pgbouncer.md`](./81-pgbouncer.md) — transaction-mode pooling and session-level advisory locks are mutually incompatible.
- [`98-pg-cron.md`](./98-pg-cron.md) — pg_cron jobs commonly use `pg_try_advisory_lock` for skip-if-running guards across HA failover.
- [`45-listen-notify.md`](./45-listen-notify.md) — NOTIFY-the-id delivery contrasted with advisory lock coordination for cross-session signaling.


## Sources

[^advisory-cooperative]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.5 Advisory Locks: *"PostgreSQL provides a means for creating locks that have application-defined meanings. These are called advisory locks, because the system does not enforce their use — it is up to the application to use them correctly."* https://www.postgresql.org/docs/16/explicit-locking.html

[^session-vs-xact]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.5 Advisory Locks: *"Once acquired at session level, an advisory lock is held until explicitly released or the session ends. Unlike standard lock requests, session-level advisory lock requests do not honor transaction semantics: a lock acquired during a transaction that is later rolled back will still be held following the rollback, and likewise an unlock is effective even if the calling transaction fails later. A lock can be acquired multiple times by its owning process; for each completed lock request there must be a corresponding unlock request before the lock is actually released. Transaction-level lock requests, on the other hand, behave more like regular lock requests: they are automatically released at the end of the transaction, and there is no explicit unlock operation. This behavior is often more convenient than the session-level behavior for short-term usage of an advisory lock. Session-level and transaction-level lock requests for the same advisory lock identifier will block each other in the expected way."* https://www.postgresql.org/docs/16/explicit-locking.html

[^key-spaces]: PostgreSQL 16 documentation, "System Administration Functions", Table 9.102 Advisory Lock Functions intro paragraph: *"All these functions are intended to be used to lock application-defined resources, which can be identified either by a single 64-bit key value or two 32-bit key values (note that these two key spaces do not overlap)."* https://www.postgresql.org/docs/16/functions-admin.html

[^stacking]: PostgreSQL 16 documentation, "System Administration Functions", Table 9.102 Advisory Lock Functions intro paragraph: *"Multiple session-level lock requests stack, so that if the same resource identifier is locked three times there must then be three unlock requests to release the resource in advance of session end."* https://www.postgresql.org/docs/16/functions-admin.html

[^reentrancy]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.5 Advisory Locks: *"If a session already holds a given advisory lock, additional requests by it will always succeed, even if other sessions are awaiting the lock; this statement is true regardless of whether the existing lock hold and new request are at session level or transaction level."* https://www.postgresql.org/docs/16/explicit-locking.html

[^shared-pool]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.5 Advisory Locks: *"Both advisory locks and regular locks are stored in a shared memory pool whose size is defined by the configuration variables max_locks_per_transaction and max_connections. Care must be taken not to exhaust this memory or the server will be unable to grant any locks at all. This imposes an upper limit on the number of advisory locks grantable by the server, typically in the tens to hundreds of thousands depending on how the server is configured."* https://www.postgresql.org/docs/16/explicit-locking.html

[^shared-exclusive]: PostgreSQL 16 documentation, "System Administration Functions", Table 9.102 intro paragraph: *"Locks can be either shared or exclusive: a shared lock does not conflict with other shared locks on the same resource, only with exclusive locks."* https://www.postgresql.org/docs/16/functions-admin.html

[^lock-fns]: PostgreSQL 16 documentation, "System Administration Functions", Table 9.102 Advisory Lock Functions. Per-function signatures and verbatim descriptions for `pg_advisory_lock`, `pg_advisory_lock_shared`, `pg_advisory_unlock`, `pg_advisory_unlock_shared`, `pg_advisory_xact_lock`, `pg_advisory_xact_lock_shared`, `pg_try_advisory_lock`, `pg_try_advisory_lock_shared`, `pg_try_advisory_xact_lock`, `pg_try_advisory_xact_lock_shared`. https://www.postgresql.org/docs/16/functions-admin.html

[^unlock-fn]: PostgreSQL 16 documentation, "System Administration Functions", Table 9.102 `pg_advisory_unlock`: *"Releases a previously-acquired exclusive session-level advisory lock. Returns true if the lock is successfully released. If the lock was not held, false is returned, and in addition, an SQL warning will be reported by the server."* https://www.postgresql.org/docs/16/functions-admin.html

[^unlock-all]: PostgreSQL 16 documentation, "System Administration Functions", Table 9.102 `pg_advisory_unlock_all`: *"Releases all session-level advisory locks held by the current session. (This function is implicitly invoked at session end, even if the client disconnects ungracefully.)"* https://www.postgresql.org/docs/16/functions-admin.html

[^pg-locks-advisory]: PostgreSQL 16 documentation, `pg_locks` system view: *"Advisory locks can be acquired on keys consisting of either a single bigint value or two integer values. A bigint key is displayed with its high-order half in the classid column, its low-order half in the objid column, and objsubid equal to 1. The original bigint value can be reassembled with the expression (classid::bigint << 32) | objid::bigint. Integer keys are displayed with the first key in the classid column, the second key in the objid column, and objsubid equal to 2."* https://www.postgresql.org/docs/16/view-pg-locks.html

[^wait-event]: PostgreSQL 16 documentation, "The Statistics Collector", Table 28.11 Wait Events of Type Lock: *"`advisory` — Waiting to acquire an advisory user lock."* https://www.postgresql.org/docs/16/monitoring-stats.html

[^limit-trap]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.5 Advisory Locks: *"In certain cases using advisory locking methods, especially in queries involving explicit ordering and LIMIT clauses, care must be taken to control the locks acquired because of the order in which SQL expressions are evaluated. … the second form is dangerous because the LIMIT is not guaranteed to be applied before the locking function is executed. This might cause some locks to be acquired that the application was not expecting, and hence would fail to release (until it ends the session). From the point of view of the application, such locks would be dangling, although still viewable in pg_locks."* https://www.postgresql.org/docs/16/explicit-locking.html

- PostgreSQL 16 documentation, "System Administration Functions" (advisory lock function catalog). https://www.postgresql.org/docs/16/functions-admin.html
- PostgreSQL 16 documentation, "Explicit Locking" §13.3.5 Advisory Locks. https://www.postgresql.org/docs/16/explicit-locking.html
- PostgreSQL 16 documentation, `pg_locks` system view. https://www.postgresql.org/docs/16/view-pg-locks.html
- PostgreSQL 16 documentation, "The Statistics Collector" (wait events). https://www.postgresql.org/docs/16/monitoring-stats.html
- PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/
- PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/
- PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/
- PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/
- PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/

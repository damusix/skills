# PostgreSQL Locking

> [!NOTE]
> This file covers the explicit-locking surface: the eight table-level lock modes and their conflict matrix, the four row-level lock modes (`FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY SHARE`), `NOWAIT` and `SKIP LOCKED`, deadlock detection, `pg_locks` introspection, the lock-timing GUCs (`deadlock_timeout`, `lock_timeout`, `max_locks_per_transaction`), and a full set of diagnostic recipes for blocking-chain analysis. For predicate locks (`SIReadLock`) used by `SERIALIZABLE`, see [`42-isolation-levels.md`](./42-isolation-levels.md). For application-managed advisory locks see [`44-advisory-locks.md`](./44-advisory-locks.md). For the implicit locks taken by `ALTER TABLE` forms and DDL see [`01-syntax-ddl.md`](./01-syntax-ddl.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Eight table-level lock modes](#eight-table-level-lock-modes)
    - [Full conflict matrix](#full-conflict-matrix)
    - [Implicit locks per command](#implicit-locks-per-command)
    - [LOCK TABLE](#lock-table)
    - [Row-level locks](#row-level-locks)
    - [NOWAIT and SKIP LOCKED](#nowait-and-skip-locked)
    - [Page-level locks](#page-level-locks)
    - [Deadlocks](#deadlocks)
    - [pg_locks](#pg_locks)
    - [Blocking-pid functions](#blocking-pid-functions)
    - [Lock-related GUCs](#lock-related-gucs)
    - [Lock wait events](#lock-wait-events)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Use this file when you are:

- Diagnosing a query that hangs, with no error: it is almost certainly waiting on a lock.
- Tracing a deadlock (`SQLSTATE 40P01 deadlock detected`) and need to know which lock pair caused it.
- Planning an online DDL change (`ALTER TABLE`, `CREATE INDEX`, `REINDEX`) and need to know which lock mode it takes and what that blocks.
- Building a queue table that consumes rows safely with `SELECT … FOR UPDATE SKIP LOCKED`.
- Sizing `max_locks_per_transaction` for a cluster that touches many partitions or many objects per transaction.
- Tuning `deadlock_timeout` or `lock_timeout` for a workload with predictable lock-wait patterns.
- Reading a `pg_locks` snapshot to identify the blocking chain in a production incident.

If you only need to know how `SERIALIZABLE` predicate locks work, skip to [`42-isolation-levels.md`](./42-isolation-levels.md). If you need application-defined cooperative locks unrelated to row/table locks, skip to [`44-advisory-locks.md`](./44-advisory-locks.md).


## Mental Model

Five rules that drive almost every locking-related decision:

1. **Every statement takes an implicit table-level lock — the mode depends on the command, not on whether you wrote `LOCK TABLE`.** `SELECT` takes `ACCESS SHARE`. `UPDATE`/`DELETE`/`INSERT`/`MERGE` take `ROW EXCLUSIVE`. `CREATE INDEX CONCURRENTLY` takes `SHARE UPDATE EXCLUSIVE`. `DROP TABLE` takes `ACCESS EXCLUSIVE`. Explicit `LOCK TABLE` is the rare exception, used when you need a stronger lock than the statement would otherwise take.

2. **There are eight table-level lock modes, ordered by strictness from `ACCESS SHARE` (weakest) to `ACCESS EXCLUSIVE` (strongest), and they form a fixed conflict matrix.** The mode names ending in `EXCLUSIVE` are not all mutually exclusive — `ROW EXCLUSIVE` and `ROW SHARE` are both shareable (multiple sessions can hold them concurrently). The verbatim rule from `sql-lock.html` is: *"`LOCK TABLE` only deals with table-level locks, and so the mode names involving `ROW` are all misnomers."*[^lock-naming]

3. **Row-level locks are a separate, independent system from table-level locks.** `SELECT FOR UPDATE` takes `ROW SHARE` at the table level and `FOR UPDATE` at the row level — the row-level lock is what actually blocks concurrent UPDATEs of the same row. Row-level locks come in four strengths (`FOR UPDATE` > `FOR NO KEY UPDATE` > `FOR SHARE` > `FOR KEY SHARE`) and the weakest pair are designed specifically to coexist with FK-enforcement RI triggers (see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md)).

4. **Deadlocks are detected automatically, never prevented.** PostgreSQL runs a deadlock check after `deadlock_timeout` (default `1s`) of waiting and aborts one transaction with `SQLSTATE 40P01`. The verbatim docs quote is: *"Exactly which transaction will be aborted is difficult to predict and should not be relied upon."*[^deadlock-rule] Applications must catch `40P01` and retry — same retry contract as `40001` from `SERIALIZABLE` (cross-reference [`42-isolation-levels.md`](./42-isolation-levels.md) Rule 5).

5. **`pg_locks` is the truth about who holds what.** Anything that hangs without an error is in `pg_locks` with `granted = false`. Combine with `pg_blocking_pids()` and `pg_stat_activity` to chain backwards: which session is blocked, which session is blocking it, what query each is running. This three-view join is the canonical incident-response diagnostic.


## Decision Matrix

| Situation | Use | Avoid | Notes |
|---|---|---|---|
| Read consistent rows for a single statement | Default `SELECT` (takes `ACCESS SHARE`) | Explicit `LOCK TABLE IN ACCESS SHARE MODE` | The implicit lock is acquired anyway; `LOCK TABLE` only adds latency. |
| Lock a row you intend to UPDATE | `SELECT … FOR UPDATE` | `SELECT … FOR SHARE` | `FOR UPDATE` is the canonical "I will UPDATE this" intent; `FOR SHARE` allows concurrent `FOR SHARE` and produces lock contention for no win. |
| Lock a row you intend to UPDATE but not change its keys | `SELECT … FOR NO KEY UPDATE` | `SELECT … FOR UPDATE` | Letting FK-checking transactions take `FOR KEY SHARE` concurrently reduces contention. |
| Reference a row you do not intend to UPDATE (read with row-level lock) | `SELECT … FOR KEY SHARE` | `SELECT … FOR SHARE` (which is stronger) | `FOR KEY SHARE` is the weakest row lock; designed to coexist with FK-trigger logic. |
| Consume work items from a queue table | `SELECT … FOR UPDATE SKIP LOCKED` | `SELECT … FOR UPDATE` (which queues) | Multiple consumers each grab disjoint rows; no contention. |
| Acquire a lock without waiting | `SELECT … FOR UPDATE NOWAIT` or `LOCK TABLE … NOWAIT` | Polling loops with `pg_try_advisory_lock()` for row locks | `NOWAIT` raises `SQLSTATE 55P03 lock_not_available` immediately. |
| Block all writes to a table briefly | `LOCK TABLE t IN SHARE MODE` | `LOCK TABLE t` (which takes `ACCESS EXCLUSIVE` and blocks reads too) | `SHARE` blocks writers but permits readers. |
| Block everything including readers | `LOCK TABLE t` or `LOCK TABLE t IN ACCESS EXCLUSIVE MODE` | Any weaker mode | Default is `ACCESS EXCLUSIVE`. |
| Diagnose "my query is hung" | `pg_stat_activity` + `pg_locks` + `pg_blocking_pids()` | Blind kills via `pg_cancel_backend()` | First find the blocker, then decide; killing the wrong PID can break the application. |
| Bound how long a statement waits for a lock | `SET lock_timeout = '5s'` (per-session or per-statement) | `statement_timeout` alone | `lock_timeout` only triggers on lock waits, not on long query execution. |
| Detect predicate-lock conflicts under SERIALIZABLE | See [`42-isolation-levels.md`](./42-isolation-levels.md) | Reading `pg_locks` alone | Predicate locks are `SIReadLock` mode and never block; `pg_locks` shows them but `pg_blocking_pids` does not flag them. |
| Application-managed cooperative lock (singleton job, distributed work queue) | Advisory locks (see [`44-advisory-locks.md`](./44-advisory-locks.md)) | Row-level locks on a sentinel table | Advisory locks are cheaper, automatically released on session end. |

Three smell signals:

- **Queries blocked on `relation` wait_event for hours**: usually an idle-in-transaction session that holds a row or table lock the workload needs. Find with the blocking-chain query (Recipe 1) and address with `idle_in_transaction_session_timeout` (see [`41-transactions.md`](./41-transactions.md)).
- **`deadlock_timeout` set above 30s "to avoid false-positive deadlocks"**: there are no false-positive deadlocks; the check only runs when at least two sessions are mutually waiting. The high setting just delays diagnosis. Default `1s` is correct for almost every workload.
- **`max_locks_per_transaction` raised to thousands without measurement**: each slot costs RAM in shared memory at server start. Raise only if you see `out of shared memory; HINT: You might need to increase max_locks_per_transaction` errors, and raise in proportion to the observed peak object count per transaction (often driven by partitioned-table fan-out).


## Syntax / Mechanics


### Eight table-level lock modes

Every statement that touches a relation acquires one of the eight modes. The verbatim docs description for each mode is preserved below — each mode names the modes it conflicts with explicitly. Note that two modes can be self-conflicting (`SHARE UPDATE EXCLUSIVE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE`) — only one session can hold them at a time.

| Mode | Conflicts with | Acquired by |
|---|---|---|
| **`ACCESS SHARE`** | `ACCESS EXCLUSIVE` only | `SELECT` (read-only) |
| **`ROW SHARE`** | `EXCLUSIVE`, `ACCESS EXCLUSIVE` | `SELECT … FOR UPDATE/FOR NO KEY UPDATE/FOR SHARE/FOR KEY SHARE` |
| **`ROW EXCLUSIVE`** | `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | `UPDATE`, `DELETE`, `INSERT`, `MERGE` |
| **`SHARE UPDATE EXCLUSIVE`** | `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | `VACUUM` (no `FULL`), `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `CREATE STATISTICS`, `COMMENT ON`, `REINDEX CONCURRENTLY`, some `ALTER INDEX`/`ALTER TABLE` |
| **`SHARE`** | `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | `CREATE INDEX` (no `CONCURRENTLY`) |
| **`SHARE ROW EXCLUSIVE`** | `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | `CREATE TRIGGER`, some `ALTER TABLE`; `ADD FOREIGN KEY` takes this on both tables (see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md)) |
| **`EXCLUSIVE`** | `ROW SHARE`, `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, `ACCESS EXCLUSIVE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| **`ACCESS EXCLUSIVE`** | All modes | `DROP TABLE`, `TRUNCATE`, `REINDEX` (no `CONCURRENTLY`), `CLUSTER`, `VACUUM FULL`, `REFRESH MATERIALIZED VIEW` (no `CONCURRENTLY`), many `ALTER INDEX`/`ALTER TABLE`, default for `LOCK TABLE` |

Verbatim from `explicit-locking.html` for `ACCESS EXCLUSIVE`: *"Conflicts with locks of all modes (`ACCESS SHARE`, `ROW SHARE`, `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`, `EXCLUSIVE`, and `ACCESS EXCLUSIVE`). This mode guarantees that the holder is the only transaction accessing the table in any way."*[^lock-modes]


### Full conflict matrix

A `Y` in row R, column C means "a transaction requesting mode C will wait if any session already holds mode R" — i.e., the modes conflict. Symmetric: if R conflicts with C, then C conflicts with R.

| | ACCESS&nbsp;SHARE | ROW&nbsp;SHARE | ROW&nbsp;EXCL | SHARE&nbsp;UPDATE&nbsp;EXCL | SHARE | SHARE&nbsp;ROW&nbsp;EXCL | EXCL | ACCESS&nbsp;EXCL |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **ACCESS SHARE** | | | | | | | | Y |
| **ROW SHARE** | | | | | | | Y | Y |
| **ROW EXCL** | | | | | Y | Y | Y | Y |
| **SHARE UPDATE EXCL** | | | | Y | Y | Y | Y | Y |
| **SHARE** | | | Y | Y | | Y | Y | Y |
| **SHARE ROW EXCL** | | | Y | Y | Y | Y | Y | Y |
| **EXCL** | | Y | Y | Y | Y | Y | Y | Y |
| **ACCESS EXCL** | Y | Y | Y | Y | Y | Y | Y | Y |

- **`ACCESS SHARE` (every `SELECT`) conflicts with only `ACCESS EXCLUSIVE`.** A normal `SELECT` is blocked only by `DROP TABLE`/`TRUNCATE`/`CLUSTER`/`VACUUM FULL`/`REFRESH MATERIALIZED VIEW` (no CONCURRENTLY) and many `ALTER TABLE` variants. This is why `CREATE INDEX CONCURRENTLY` is online-safe — it takes only `SHARE UPDATE EXCLUSIVE` which does not conflict with `ACCESS SHARE`.
- **`ROW EXCLUSIVE` (`UPDATE`/`DELETE`/`INSERT`/`MERGE`) conflicts with `SHARE` and stronger.** A `CREATE INDEX` without `CONCURRENTLY` blocks every writer because it takes `SHARE`.
- **`SHARE UPDATE EXCLUSIVE` is self-conflicting.** You cannot run two `VACUUM`s or two `CREATE INDEX CONCURRENTLY` operations on the same table simultaneously; the second one waits. Same for `ANALYZE` running while another `ANALYZE` is in progress.


### Implicit locks per command

The complete mapping from common SQL commands to table-level lock mode. Cross-references throughout the skill point here:

| Command | Lock mode |
|---|---|
| `SELECT` | `ACCESS SHARE` |
| `SELECT … FOR UPDATE`/`FOR NO KEY UPDATE`/`FOR SHARE`/`FOR KEY SHARE` | `ROW SHARE` (plus row-level lock on matched rows) |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE` | `ROW EXCLUSIVE` |
| `COPY … FROM` | `ROW EXCLUSIVE` |
| `COPY … TO` | `ACCESS SHARE` |
| `VACUUM` (no `FULL`) | `SHARE UPDATE EXCLUSIVE` |
| `ANALYZE` | `SHARE UPDATE EXCLUSIVE` |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` |
| `REINDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` |
| `CREATE STATISTICS`, `COMMENT ON` | `SHARE UPDATE EXCLUSIVE` |
| `CREATE INDEX` (no `CONCURRENTLY`) | `SHARE` |
| `CREATE TRIGGER` | `SHARE ROW EXCLUSIVE` |
| `ADD FOREIGN KEY` | `SHARE ROW EXCLUSIVE` on both tables (see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md)) |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | `EXCLUSIVE` |
| `DROP TABLE`, `TRUNCATE`, `CLUSTER`, `VACUUM FULL` | `ACCESS EXCLUSIVE` |
| `REFRESH MATERIALIZED VIEW` (no `CONCURRENTLY`) | `ACCESS EXCLUSIVE` |
| `REINDEX` (no `CONCURRENTLY`) | `ACCESS EXCLUSIVE` |
| Most `ALTER TABLE` (changing column type, adding NOT NULL pre-PG18, etc.) | `ACCESS EXCLUSIVE` |
| `ALTER TABLE … ATTACH PARTITION` | `SHARE UPDATE EXCLUSIVE` on parent + `ACCESS EXCLUSIVE` on partition (PG12+; see [`35-partitioning.md`](./35-partitioning.md)) |
| `ALTER TABLE … DETACH PARTITION CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` then briefly `ACCESS EXCLUSIVE` on partition (PG14+) |

Note the per-`ALTER TABLE`-variant lock matrix lives in [`01-syntax-ddl.md`](./01-syntax-ddl.md) and [`37-constraints.md`](./37-constraints.md). Most users underestimate how many `ALTER TABLE` forms take `ACCESS EXCLUSIVE` and surprise their workload.


### LOCK TABLE

`LOCK TABLE` lets you acquire any table-level lock mode explicitly. The grammar is:

```
LOCK [ TABLE ] [ ONLY ] name [ * ] [, ...] [ IN lockmode MODE ] [ NOWAIT ]
```

Where `lockmode` is one of the eight modes. **The default is `ACCESS EXCLUSIVE`** — verbatim: *"If no lock mode is specified, then `ACCESS EXCLUSIVE`, the most restrictive mode, is used."*[^lock-default]

Four operational rules from `sql-lock.html`:

1. **`LOCK TABLE` outside a transaction block is an error.** Verbatim: *"`LOCK TABLE` is useless outside a transaction block: the lock would remain held only to the completion of the statement. Therefore PostgreSQL reports an error if `LOCK` is used outside a transaction block."*[^lock-outside-tx] All `LOCK TABLE` must follow an explicit `BEGIN`.

2. **`NOWAIT` raises `SQLSTATE 55P03 lock_not_available`** if the lock cannot be acquired immediately. Verbatim: *"`NOWAIT` Specifies that `LOCK TABLE` should not wait for any conflicting locks to be released: if the specified lock(s) cannot be acquired immediately without waiting, the transaction is aborted."*[^lock-nowait]

3. **Permission rules (PG16+ simplified).** A user with `UPDATE`/`DELETE`/`TRUNCATE` privilege can take any mode. A user with `INSERT` can take any mode `ROW EXCLUSIVE` or weaker. A user with `SELECT` can take `ACCESS SHARE`. PG16 relaxed the rules: if you have permission for a stronger mode, you can also take weaker modes.[^pg16-lock-perms]

4. **Mode names with `ROW` are misnomers.** Verbatim: *"`LOCK TABLE` only deals with table-level locks, and so the mode names involving `ROW` are all misnomers. These mode names should generally be read as indicating the intention of the user to acquire row-level locks within the locked table. Also, `ROW EXCLUSIVE` mode is a shareable table lock."*[^lock-naming]

`LOCK TABLE` is rarely the right tool. Two use cases:

- **Pre-acquire a stronger lock than the statement would take.** For example, an UPDATE batch that wants to block all readers until done can take `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` at the start of the transaction.
- **Bound how long a DDL waits.** Combine `SET LOCAL lock_timeout = '500ms'` with `LOCK TABLE` to either acquire the table quickly or abort. Pattern shown in Recipe 5.


### Row-level locks

Four strengths exist. Going from strongest to weakest:

| Mode | Blocks | Blocked by |
|---|---|---|
| **`FOR UPDATE`** | `UPDATE`, `DELETE`, `SELECT FOR UPDATE`, `SELECT FOR NO KEY UPDATE`, `SELECT FOR SHARE`, `SELECT FOR KEY SHARE` of these rows | Same set |
| **`FOR NO KEY UPDATE`** | `UPDATE`, `DELETE`, `SELECT FOR UPDATE`, `SELECT FOR NO KEY UPDATE`, `SELECT FOR SHARE` of these rows. Does NOT block `SELECT FOR KEY SHARE`. | `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` |
| **`FOR SHARE`** | `UPDATE`, `DELETE`, `SELECT FOR UPDATE`, `SELECT FOR NO KEY UPDATE`. Does NOT block other `FOR SHARE` or `FOR KEY SHARE`. | `FOR UPDATE`, `FOR NO KEY UPDATE` |
| **`FOR KEY SHARE`** | `DELETE` and any `UPDATE` that changes the key. Does NOT block other `UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, or `FOR KEY SHARE`. | `FOR UPDATE` only |

Three subtle rules from `explicit-locking.html`:

- **`UPDATE` and `DELETE` acquire `FOR UPDATE` automatically.** Any DELETE on a row takes the FOR UPDATE row-level lock; UPDATE takes either `FOR UPDATE` (if it modifies a column with a unique index usable in a foreign key) or `FOR NO KEY UPDATE` (otherwise). Verbatim: *"The `FOR UPDATE` lock mode is also acquired by any `DELETE` on a row, and also by an `UPDATE` that modifies the values of certain columns. Currently, the set of columns considered for the `UPDATE` case are those that have a unique index on them that can be used in a foreign key (so partial indexes and expressional indexes are not considered), but this may change in the future."*[^update-takes-for-update]

- **`FOR KEY SHARE` is the FK-checker's lock.** Internal RI triggers (see [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md)) take `FOR KEY SHARE` on the referenced row when validating an FK from a child. This is why FK validation does not block normal `UPDATE`s on the parent — only `FOR UPDATE` and `FOR NO KEY UPDATE` (which would change the key) conflict.

- **Repeatable Read / Serializable interaction.** Verbatim: *"Within a `REPEATABLE READ` or `SERIALIZABLE` transaction, however, an error will be thrown if a row to be locked has changed since the transaction started."*[^repeatable-read-lock-fail] This raises `SQLSTATE 40001 serialization_failure` — same retry contract as the `SERIALIZABLE` mechanism (see [`42-isolation-levels.md`](./42-isolation-levels.md)).

The locking-clause grammar from `sql-select.html`:

```
FOR lock_strength [ OF table_name [, ...] ] [ NOWAIT | SKIP LOCKED ]
```

Where `lock_strength` is one of `UPDATE`, `NO KEY UPDATE`, `SHARE`, `KEY SHARE`.

The `OF table_name` form restricts the lock to specific tables in a join. Without `OF`, all tables in the `SELECT` are locked. Verbatim: *"If specific tables are named in a locking clause, then only rows coming from those tables are locked; any other tables used in the `SELECT` are simply read as usual."*[^lock-clause-scope]


### NOWAIT and SKIP LOCKED

Two ways to avoid waiting for a row-level lock:

- **`NOWAIT`**: raise `SQLSTATE 55P03 lock_not_available` immediately if any selected row cannot be locked.
- **`SKIP LOCKED`**: silently omit any selected row that cannot be locked.

Verbatim from `sql-select.html`: *"With `NOWAIT`, the statement reports an error, rather than waiting, if a selected row cannot be locked immediately. With `SKIP LOCKED`, any selected rows that cannot be immediately locked are skipped. Skipping locked rows provides an inconsistent view of the data, so this is not suitable for general purpose work, but can be used to avoid lock contention with multiple consumers accessing a queue-like table."*[^nowait-skip-locked]

> [!WARNING]
> `NOWAIT` and `SKIP LOCKED` apply only to row-level locks. Verbatim: *"Note that `NOWAIT` and `SKIP LOCKED` apply only to the row-level lock(s) — the required `ROW SHARE` table-level lock is still taken in the ordinary way."*[^nowait-table-lock] If a `DROP TABLE` is queued, `SELECT … FOR UPDATE NOWAIT` will still block waiting for the `ROW SHARE` table-level lock. Use `LOCK TABLE … NOWAIT` to handle that case separately.

`SKIP LOCKED` is the canonical "consume from a queue" pattern. Recipe 4 shows the full worker pattern.


### Page-level locks

Verbatim from `explicit-locking.html`: *"In addition to table and row locks, page-level share/exclusive locks are used to control read/write access to table pages in the shared buffer pool. These locks are released immediately after a row is fetched or updated. Application developers normally need not be concerned with page-level locks, but they are mentioned here for completeness."*[^page-locks]

Page locks (also called buffer content locks) are internal and short-lived. They appear in `pg_locks` only briefly and are not the source of application-visible lock waits unless under extreme buffer-pool pressure. The relevant `pg_locks.locktype = 'page'` rows almost always belong to GIN pending-list flush or B-tree page splits and clear themselves within milliseconds.


### Deadlocks

Verbatim: *"PostgreSQL automatically detects deadlock situations and resolves them by aborting one of the transactions involved, allowing the other(s) to complete. (Exactly which transaction will be aborted is difficult to predict and should not be relied upon.)"*[^deadlock-rule]

Three operational rules:

1. **Detection is opportunistic.** The check runs only after a session has been waiting on a lock for `deadlock_timeout` (default `1s`). This is intentional — the docs verbatim: *"The check for deadlock is relatively expensive, so the server doesn't run it every time it waits for a lock."*[^deadlock-timeout]

2. **The aborted transaction raises `SQLSTATE 40P01 deadlock_detected`.** The application must catch and retry — replay the entire transaction from `BEGIN`, not just the failing statement. Same retry contract as `40001` (see [`42-isolation-levels.md`](./42-isolation-levels.md)).

3. **Logging deadlocks.** Set `log_lock_waits = on` (off by default) to log every lock wait longer than `deadlock_timeout`. Deadlock detections are always logged regardless. The log message shows the full lock wait graph including PIDs, modes, and queries.

The canonical deadlock pattern is **out-of-order row access**:

- Session A: `UPDATE accounts WHERE id = 1; UPDATE accounts WHERE id = 2;`
- Session B: `UPDATE accounts WHERE id = 2; UPDATE accounts WHERE id = 1;`

Both sessions hold one row's `FOR UPDATE` lock and wait for the other. The deadlock detector aborts one. Fix: enforce a deterministic locking order (e.g., always lock rows in ascending PK order). Recipe 8 shows the canonical batch-update pattern.


### pg_locks

`pg_locks` is the central system view for current locks. Every locking-related diagnostic starts here.

| Column | Type | Description |
|---|---|---|
| `locktype` | `text` | One of: `relation`, `extend`, `frozenid`, `page`, `tuple`, `transactionid`, `virtualxid`, `spectoken`, `object`, `userlock`, `advisory`, `applytransaction` (PG16+) |
| `database` | `oid` | OID of the database; null for shared objects or transaction-id locks |
| `relation` | `oid` | OID of the targeted relation, or null |
| `page` | `int4` | Page number within the relation, or null |
| `tuple` | `int2` | Tuple number within the page, or null |
| `virtualxid` | `text` | Virtual XID of the targeted transaction, or null |
| `transactionid` | `xid` | Real XID of the targeted transaction, or null |
| `classid` | `oid` | OID of the system catalog for general database objects (e.g., `pg_class`) |
| `objid` | `oid` | OID of the target object within `classid` |
| `objsubid` | `int2` | Column number for column locks; 0 for whole-object; null otherwise |
| `virtualtransaction` | `text` | Virtual XID of the holder/waiter |
| `pid` | `int4` | PID of the holding/waiting backend, or null if held by a prepared transaction |
| `mode` | `text` | Lock mode name (one of the eight, or row-level/predicate mode names) |
| `granted` | `bool` | True if held, false if waiting |
| `fastpath` | `bool` | True if taken via the fast path (no entry in main lock table) |
| `waitstart` | `timestamptz` | When the wait started, or null if granted (PG14+) |

Two columns most readers don't know about:

- **`fastpath`** (verbatim): *"True if lock was taken via fast path, false if taken via main lock table."*[^fastpath] The fast path is a per-backend cache for the four weakest non-conflicting modes (`ACCESS SHARE`, `ROW SHARE`, `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`). Fast-path locks are not visible to other backends until promoted, but conflict detection still works. `fastpath = true` does NOT mean the lock is weaker — it means it was tracked efficiently.

- **`waitstart`** (PG14+, verbatim): *"Time when the server process started waiting for this lock, or null if the lock is held. Note that this can be null for a very short period of time after the wait started even though `granted` is `false`."*[^waitstart-rule] Pre-PG14 you had no way to know how long a session had been waiting without manual instrumentation; PG14+ exposes it directly.

> [!NOTE] PostgreSQL 14
> `pg_locks.waitstart` added. Verbatim release-note quote: *"Add lock wait start time to `pg_locks`."*[^pg14-waitstart] Combined with `now() - waitstart` you can rank waiters by age — see Recipe 1.

> [!NOTE] PostgreSQL 16
> Two `pg_locks` changes: (1) the `applytransaction` locktype was added for logical-replication apply-worker transactions; (2) speculative insertion locks now expose useful info — the transaction id appears in `transactionid` and the speculative token in `objid`. Verbatim: *"Add speculative lock information to the `pg_locks` system view ... The transaction id is displayed in the `transactionid` column and the speculative insertion token is displayed in the `objid` column."*[^pg16-spectoken]


### Blocking-pid functions

Two functions are the workhorses for blocking-chain analysis:

**`pg_blocking_pids(integer) → integer[]`**

Verbatim: *"Returns an array of the process ID(s) of the sessions that are blocking the server process with the specified process ID from acquiring a lock, or an empty array if there is no such server process or it is not blocked. One server process blocks another if it either holds a lock that conflicts with the blocked process's lock request (hard block), or is waiting for a lock that would conflict with the blocked process's lock request and is ahead of it in the wait queue (soft block)."*[^pg-blocking-pids]

Three rules:

- **Hard block vs soft block.** A hard block is a process that *holds* a conflicting lock. A soft block is a process *waiting* for a conflicting lock that is ahead of you in the queue. Both count as "blocking" for `pg_blocking_pids`. Soft blocks are the silent cause of "I see no holder, but I'm still waiting."
- **Parallel-query PIDs are normalized.** Verbatim: *"When using parallel queries the result always lists client-visible process IDs (that is, `pg_backend_pid` results) even if the actual lock is held or awaited by a child worker process."*
- **Prepared-transaction PIDs are zero.** Verbatim: *"When a prepared transaction holds a conflicting lock, it will be represented by a zero process ID."* A PID of 0 in the result means a prepared transaction is the blocker — find it with `SELECT * FROM pg_prepared_xacts;`.

**`pg_safe_snapshot_blocking_pids(integer) → integer[]`**

Verbatim: *"Returns an array of the process ID(s) of the sessions that are blocking the server process with the specified process ID from acquiring a safe snapshot, or an empty array if there is no such server process or it is not blocked. A session running a SERIALIZABLE transaction blocks a SERIALIZABLE READ ONLY DEFERRABLE transaction from acquiring a snapshot until the latter determines that it is safe to avoid taking any predicate locks."*[^safe-snapshot-blocking]

Used only when diagnosing why a `DEFERRABLE READ ONLY SERIALIZABLE` transaction is waiting at `BEGIN` — see [`42-isolation-levels.md`](./42-isolation-levels.md).

> [!WARNING]
> Verbatim: *"Frequent calls to this function could have some impact on database performance, because it needs exclusive access to the lock manager's shared state for a short time."* Do not call `pg_blocking_pids()` in a tight loop or from a monitoring agent that polls every second on a busy cluster. Use it interactively during incidents and from sampling-based monitoring (e.g., once per 10–30 seconds).


### Lock-related GUCs

Five GUCs control lock behavior:

| GUC | Default | Description |
|---|---|---|
| `deadlock_timeout` | `1s` | How long a session waits before the deadlock check runs. Lowering reports deadlocks faster but raises CPU overhead. Recommended: keep default. |
| `lock_timeout` | `0` (disabled) | Abort any statement that waits longer than this for a lock. Recommended: set per-session or per-statement, never cluster-wide. |
| `max_locks_per_transaction` | `64` | Average per-transaction object-lock budget for the shared lock table. Restart required to change. |
| `max_pred_locks_per_transaction` | `64` | Average per-transaction predicate-lock budget for SSI. Restart required. |
| `max_pred_locks_per_relation` | `-2` | When predicate locks on one relation exceed this, escalate to whole-relation lock. Negative means `max_pred_locks_per_transaction / abs(setting)`. |

**`deadlock_timeout`** (verbatim): *"This is the amount of time to wait on a lock before checking to see if there is a deadlock condition ... The default is one second (`1s`), which is probably about the smallest value you would want in practice ... When `log_lock_waits` is set, this parameter also determines the amount of time to wait before a log message is issued about the lock wait."*[^deadlock-timeout]

**`lock_timeout`** (verbatim): *"Abort any statement that waits longer than the specified amount of time while attempting to acquire a lock on a table, index, row, or other database object ... A value of zero (the default) disables the timeout. Unlike `statement_timeout`, this timeout can only occur while waiting for locks ... Setting `lock_timeout` in `postgresql.conf` is not recommended because it would affect all sessions."*[^lock-timeout] When a `lock_timeout` fires, `SQLSTATE 55P03 lock_not_available` is raised — same code as `NOWAIT` failures.

**`max_locks_per_transaction`** (verbatim): *"The shared lock table has space for `max_locks_per_transaction` objects (e.g., tables) per server process or prepared transaction; hence, no more than this many distinct objects can be locked at any one time. This parameter limits the average number of object locks used by each transaction; individual transactions can lock more objects as long as the locks of all transactions fit in the lock table. This is not the number of rows that can be locked; that value is unlimited. The default, 64, has historically proven sufficient ... When running a standby server, you must set this parameter to have the same or higher value as on the primary server."*[^max-locks]

The "average" framing matters: the real limit is `max_locks_per_transaction × (max_connections + max_prepared_transactions)`. A single transaction touching 5,000 partitions can succeed if other transactions are touching fewer objects.

> [!NOTE] PostgreSQL 18
> `log_lock_failures` GUC added — logs `SELECT … NOWAIT` lock-acquisition failures specifically. Verbatim: *"Add server variable `log_lock_failures` to log lock acquisition failures (Yuki Seino, Fujii Masao). Specifically it reports `SELECT ... NOWAIT` lock failures."*[^pg18-log-lock-failures] Useful for diagnosing application-side `NOWAIT` patterns that silently retry without surfacing in regular logs.


### Lock wait events

When a backend is waiting on a lock, `pg_stat_activity.wait_event_type` is `'Lock'` and `wait_event` is one of:

| wait_event | Meaning |
|---|---|
| `relation` | Waiting on a table-level lock (one of the eight modes) |
| `tuple` | Waiting on a row-level lock |
| `transactionid` | Waiting for another transaction to finish (canonical pattern for two sessions updating the same row) |
| `virtualxid` | Waiting on a virtual XID lock (rare; used internally for some coordination) |
| `extend` | Waiting to extend a relation (allocate a new heap page); high under bulk inserts |
| `page` | Waiting on a page-level lock (B-tree splits, GIN pending-list flush) |
| `frozenid` | Waiting to update `pg_database.datfrozenxid`/`datminmxid` (anti-wraparound vacuum coordination) |
| `object` | Waiting on a non-relation database object lock (e.g., function, namespace) |
| `spectoken` | Waiting on a speculative-insertion lock (ON CONFLICT mechanics) |
| `userlock` | Application-defined user lock (legacy) |
| `advisory` | Waiting on an advisory lock (see [`44-advisory-locks.md`](./44-advisory-locks.md)) |
| `applytransaction` | Waiting on a remote transaction being applied by a logical-replication subscriber (PG16+) |

The most common wait events in blocking chains are `relation`, `tuple`, and `transactionid`. Recipe 1 (blocking chain) joins `pg_stat_activity.wait_event_type = 'Lock'` to `pg_locks` and surfaces the wait reason for each blocked session.


### Per-version timeline

| Version | Change |
|---|---|
| **PG14** | `pg_locks.waitstart` column added — exposes wait duration directly[^pg14-waitstart] |
| **PG15** | No lock-system release-note changes |
| **PG16** | `applytransaction` wait event/locktype added (logical-replication apply workers); `pg_locks` exposes speculative-insertion lock info via `transactionid` + `objid`[^pg16-spectoken]; `LOCK TABLE` permissions simplified — having permission for a stronger mode now also grants weaker modes[^pg16-lock-perms] |
| **PG17** | No lock-system release-note changes |
| **PG18** | `log_lock_failures` GUC added for `SELECT … NOWAIT` lock-failure logging[^pg18-log-lock-failures] |

> [!NOTE]
> The eight-mode conflict matrix and row-level lock model have been **operationally stable since PG9.x**. If a tutorial claims that PG16/17/18 introduced new lock modes or changed the conflict matrix, verify directly against `explicit-locking.html` — it has not.


## Examples / Recipes


### Recipe 1: Canonical blocking-chain query

The single most important diagnostic in this file. Identifies every waiting session, what it's waiting for, who is blocking it, and what query each is running.

    SELECT
        blocked.pid                                     AS blocked_pid,
        blocked.usename                                 AS blocked_user,
        blocked.application_name                        AS blocked_app,
        blocked.wait_event_type,
        blocked.wait_event,
        blocked.state,
        age(now(), blocked.xact_start)                  AS blocked_xact_age,
        substring(blocked.query, 1, 80)                 AS blocked_query,
        blocking.pid                                    AS blocking_pid,
        blocking.usename                                AS blocking_user,
        blocking.state                                  AS blocking_state,
        age(now(), blocking.xact_start)                 AS blocking_xact_age,
        substring(blocking.query, 1, 80)                AS blocking_query
    FROM pg_stat_activity AS blocked
    JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker_pid ON true
    JOIN pg_stat_activity AS blocking ON blocking.pid = blocker_pid
    WHERE blocked.wait_event_type = 'Lock'
    ORDER BY blocked_xact_age DESC;

If `blocking_state = 'idle in transaction'`, the blocker is an abandoned connection — look at `blocking.xact_start` to decide whether to terminate it. Cross-reference [`41-transactions.md`](./41-transactions.md) Recipe 3.


### Recipe 2: Lock-holder inventory ordered by wait time

Find sessions that have been waiting longest for a specific relation. PG14+ via `waitstart`:

    SELECT
        l.pid,
        l.locktype,
        l.relation::regclass        AS rel,
        l.mode,
        l.granted,
        l.fastpath,
        now() - l.waitstart         AS wait_duration,
        a.usename,
        a.application_name,
        a.state,
        substring(a.query, 1, 100)  AS query
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.granted = false
    ORDER BY l.waitstart NULLS LAST;

The pre-PG14 equivalent uses `xact_start` from `pg_stat_activity` as a proxy — less precise because the wait may have started long after the transaction did.


### Recipe 3: Find what's holding a lock on a specific table

When you know the table name but not the blocker:

    SELECT
        l.pid,
        l.mode,
        l.granted,
        l.fastpath,
        a.usename,
        a.application_name,
        a.state,
        age(now(), a.xact_start)    AS xact_age,
        substring(a.query, 1, 120)  AS query
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.relation = 'public.orders'::regclass
      AND l.locktype = 'relation'
    ORDER BY l.granted, l.mode;


### Recipe 4: `SKIP LOCKED` queue consumer

The canonical pattern for a worker that claims one job at a time without blocking other workers:

    BEGIN;

    SELECT id, payload
    FROM job_queue
    WHERE status = 'pending'
    ORDER BY priority DESC, id
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    -- … process job …

    UPDATE job_queue
       SET status = 'done',
           processed_at = now()
     WHERE id = $1;

    COMMIT;

Notes:

- `FOR UPDATE` takes the row-level lock; `SKIP LOCKED` makes parallel workers each grab disjoint rows.
- Order by a deterministic column (priority + id) so each worker picks the highest-priority unclaimed row.
- A partial index `CREATE INDEX ON job_queue (priority DESC, id) WHERE status = 'pending'` keeps the scan cost constant as the table grows; see [`23-btree-indexes.md`](./23-btree-indexes.md).
- A long-running worker holds the row lock until COMMIT. Set `idle_in_transaction_session_timeout` so a crashed worker eventually frees the lock.


### Recipe 5: Bounded online DDL with `lock_timeout`

For `ALTER TABLE` statements that take `ACCESS EXCLUSIVE`, the wait queue can hide behind a single long query and stall everything for hours. Use a short `lock_timeout` and retry:

    DO $$
    DECLARE
        attempts int := 0;
        max_attempts int := 20;
    BEGIN
        LOOP
            BEGIN
                SET LOCAL lock_timeout = '500ms';
                ALTER TABLE orders ADD COLUMN ship_method text;
                EXIT;
            EXCEPTION WHEN lock_not_available THEN
                attempts := attempts + 1;
                IF attempts >= max_attempts THEN
                    RAISE EXCEPTION 'Could not acquire ALTER TABLE lock after % attempts', attempts;
                END IF;
                PERFORM pg_sleep(2);
            END;
        END LOOP;
    END $$;

The pattern: take the strong lock with a tight timeout; if it fails (because some long query holds `ACCESS SHARE`), back off, then retry. Eventually a quiet moment lets the ALTER through without blocking the workload for an arbitrary time.


### Recipe 6: Detect deadlocks proactively via logging

    -- Cluster-wide:
    ALTER SYSTEM SET log_lock_waits = on;
    ALTER SYSTEM SET deadlock_timeout = '1s';      -- keep default
    SELECT pg_reload_conf();

    -- Then watch the server log for:
    --   LOG:  process N still waiting for ShareLock on transaction X after 1000.234 ms
    --   DETAIL:  Process holding the lock: Y. Wait queue: N, M.

With `log_lock_waits = on`, every wait longer than `deadlock_timeout` is logged with the wait graph. Combined with `log_line_prefix` settings that include `%p %u %d %a`, this produces enough info to build a deadlock heatmap from logs alone.

PG18+ alternative: `ALTER SYSTEM SET log_lock_failures = on;` to additionally log `SELECT … NOWAIT` failures.


### Recipe 7: Audit `pg_locks` size and `max_locks_per_transaction` headroom

If your cluster has lots of partitions or wide-fanout queries, you may hit `out of shared memory; HINT: You might need to increase max_locks_per_transaction`. Audit current usage:

    SELECT
        max_locks                                                AS max_locks_per_transaction,
        max_connections,
        max_prepared_xacts                                       AS max_prepared_transactions,
        (max_locks * (max_connections + max_prepared_xacts))     AS total_lock_slots,
        current_locks,
        round(100.0 * current_locks /
              (max_locks * (max_connections + max_prepared_xacts)), 2) AS pct_used
    FROM (
        SELECT
            (SELECT setting::int FROM pg_settings WHERE name = 'max_locks_per_transaction')
                AS max_locks,
            (SELECT setting::int FROM pg_settings WHERE name = 'max_connections')
                AS max_connections,
            (SELECT setting::int FROM pg_settings WHERE name = 'max_prepared_transactions')
                AS max_prepared_xacts,
            (SELECT count(*)::int FROM pg_locks)
                AS current_locks
    ) AS m;

Run this on a healthy cluster to baseline `pct_used`. If a workload spike pushes it above 70%, raise `max_locks_per_transaction` (requires restart). Typical values: 64 (default), 128 (cluster with 1k–10k partitions), 256–512 (heavy partitioning + many backends).


### Recipe 8: Enforce locking order to avoid deadlocks in batch updates

The canonical pattern for "update multiple rows in one transaction" that prevents the out-of-order deadlock:

    -- BAD: locks rows in input order
    UPDATE accounts SET balance = balance + 100 WHERE id = ANY('{42, 17, 99}'::int[]);

    -- GOOD: locks rows in PK order regardless of input
    WITH targets AS (
        SELECT id FROM accounts
        WHERE id = ANY($1::int[])
        ORDER BY id
        FOR UPDATE
    )
    UPDATE accounts
       SET balance = balance + $2
     WHERE id IN (SELECT id FROM targets);

The `ORDER BY id` in the CTE forces consistent lock-acquisition order across all callers. As long as every concurrent transaction uses the same ordering rule, deadlocks become impossible by construction.


### Recipe 9: Detect tables with the most lock contention

Surface the relations with the most blocked/contended sessions over a sampling window:

    -- Run this from a monitoring agent every minute, store rows in a metrics table:
    SELECT
        l.relation::regclass        AS rel,
        l.mode,
        count(*)                    AS n_waiting,
        max(now() - l.waitstart)    AS longest_wait
    FROM pg_locks l
    WHERE l.granted = false
      AND l.locktype = 'relation'
    GROUP BY l.relation, l.mode
    ORDER BY n_waiting DESC;

Aggregate over a week and the resulting top-10 list is the canonical "tables most likely to benefit from lower-blocking DDL strategies" report.


### Recipe 10: Kill a blocker (carefully)

When a runaway session is blocking everything else:

    -- Step 1: confirm the blocker via pg_blocking_pids (Recipe 1).
    -- Step 2: try a graceful cancel first (cancels current query, transaction may continue).
    SELECT pg_cancel_backend(12345);

    -- Step 3: if that doesn't work after ~10 seconds, terminate the backend
    -- (rolls back the transaction, closes the connection).
    SELECT pg_terminate_backend(12345);

`pg_cancel_backend` is safer because it only cancels the current statement, letting the transaction commit or rollback cleanly if the application catches the cancellation. `pg_terminate_backend` is the nuclear option — the backend exits, all session-local state is lost.

> [!WARNING]
> Never `pg_terminate_backend` a logical-replication apply worker or a walsender without understanding replication implications. Those backends have specific roles in [`74-logical-replication.md`](./74-logical-replication.md) and [`73-streaming-replication.md`](./73-streaming-replication.md).


### Recipe 11: Distinguish hard block vs soft block

`pg_blocking_pids` does not tell you which entries are hard vs soft blocks. To inspect manually:

    -- Inspect the wait queue for a specific relation:
    SELECT
        pid,
        mode,
        granted,
        fastpath,
        now() - waitstart   AS wait_age
    FROM pg_locks
    WHERE relation = 'public.orders'::regclass
    ORDER BY granted DESC, waitstart NULLS FIRST;

Rows with `granted = true` are the holders (hard blockers). Rows with `granted = false` are the waiters; among them, the order (oldest `waitstart` first) is the queue order. A waiter is a soft block to all waiters behind it in the queue.


### Recipe 12: Predicate lock visibility under SERIALIZABLE

When debugging serialization failures under SERIALIZABLE, view the SIRead (predicate) locks:

    SELECT
        l.pid,
        l.locktype,
        l.relation::regclass        AS rel,
        l.page,
        l.tuple,
        l.mode,
        a.usename,
        substring(a.query, 1, 100)  AS query
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.mode = 'SIReadLock'
    ORDER BY l.relation, l.page, l.tuple;

`SIReadLock` mode means the lock is a predicate-conflict-detection marker, not a blocking lock. They never appear in `pg_blocking_pids` results because they never block. They're invisible to non-SERIALIZABLE transactions. Cross-reference [`42-isolation-levels.md`](./42-isolation-levels.md).


### Recipe 13: Audit lock-related GUCs against production baseline

    SELECT
        name,
        setting,
        unit,
        category,
        boot_val                AS factory_default,
        source,
        context
    FROM pg_settings
    WHERE name IN (
        'deadlock_timeout',
        'lock_timeout',
        'max_locks_per_transaction',
        'max_pred_locks_per_transaction',
        'max_pred_locks_per_relation',
        'max_pred_locks_per_page',
        'log_lock_waits',
        'log_lock_failures',                -- PG18+
        'idle_in_transaction_session_timeout',
        'statement_timeout'
    )
    ORDER BY name;

The `source` column tells you whether each value is from `postgresql.conf`, `ALTER SYSTEM`, `ALTER ROLE/DATABASE`, command line, or default. The `context` column tells you whether changes require restart, reload, or session.


## Gotchas / Anti-patterns

1. **`UPDATE`/`DELETE` take `FOR UPDATE` at the row level, automatically.** A naive `SELECT` followed by `UPDATE` is two statements, but the `UPDATE` itself acquires `FOR UPDATE` row-level locks on every row it touches. There is no "write without locking the row" — the UPDATE is the lock.

2. **The default `LOCK TABLE` mode is `ACCESS EXCLUSIVE`.** Verbatim: *"If no lock mode is specified, then `ACCESS EXCLUSIVE`, the most restrictive mode, is used."*[^lock-default] Always specify the mode explicitly. `LOCK TABLE t` blocks everything including `SELECT`s.

3. **`LOCK TABLE` outside a transaction is an error.** It raises immediately — not silently no-op. Always wrap in `BEGIN`/`COMMIT`.

4. **`NOWAIT`/`SKIP LOCKED` only apply to row-level locks.** Verbatim: *"`NOWAIT` and `SKIP LOCKED` apply only to the row-level lock(s) — the required `ROW SHARE` table-level lock is still taken in the ordinary way."*[^nowait-table-lock] If you need NOWAIT on a table lock, use `LOCK TABLE … NOWAIT` separately.

5. **`SKIP LOCKED` provides an inconsistent view of the data.** Verbatim: *"Skipping locked rows provides an inconsistent view of the data, so this is not suitable for general purpose work."*[^nowait-skip-locked] Use it only for queue-consumer patterns where you genuinely want to skip claimed work.

6. **`FOR SHARE` is rarely what you want.** Multiple `FOR SHARE` sessions coexist, which sounds useful, but then any one of them that wants to escalate to `FOR UPDATE` deadlocks against the others. Prefer `FOR UPDATE` (intent to modify) or `FOR KEY SHARE` (intent to reference). `FOR SHARE` is a niche choice.

7. **`pg_blocking_pids` can show duplicate PIDs.** Verbatim: *"there may be duplicated PIDs in the result."*[^pg-blocking-pids] This happens when a parallel-query leader has multiple workers, each blocking the same target. Use `array(SELECT DISTINCT unnest(pg_blocking_pids(pid)))` to dedup.

8. **A PID of `0` in `pg_blocking_pids` means a prepared transaction blocker.** Find it with `SELECT * FROM pg_prepared_xacts;` and decide whether to `COMMIT PREPARED` or `ROLLBACK PREPARED`. See [`41-transactions.md`](./41-transactions.md).

9. **`deadlock_timeout` is per-session settable (`PGC_SUSET`), not postmaster-only.** `SET deadlock_timeout = '2s'` in a session is valid for users with the `pg_maintain` predefined role or superusers. It controls how long *this* session waits before running the deadlock check — not a cluster-wide detection interval. Lowering it for one session makes that session's deadlock checks more aggressive at the cost of slightly more CPU on its lock waits.

10. **`lock_timeout` applies to `pg_advisory_lock()` waits inside an explicit transaction.** Within a `BEGIN … COMMIT` block, `SET LOCAL lock_timeout = '5s'` before `pg_advisory_lock(key)` raises `SQLSTATE 55P03 lock_not_available` if the advisory lock cannot be acquired within the timeout. Outside a transaction (implicit autocommit statement), `lock_timeout` does not apply to advisory-lock waits — use `statement_timeout` or `pg_try_advisory_lock()` instead. See [`44-advisory-locks.md`](./44-advisory-locks.md) Recipe 10 for the full pattern.

11. **`max_locks_per_transaction` is an average, not a hard per-transaction cap.** Verbatim: *"This parameter limits the average number of object locks used by each transaction; individual transactions can lock more objects as long as the locks of all transactions fit in the lock table."*[^max-locks] You hit the "out of shared memory" error only when total across all transactions exceeds the slot pool.

12. **`max_locks_per_transaction` requires restart.** Cannot be changed at runtime — it sizes shared memory at server start.

13. **A standby must have `max_locks_per_transaction` ≥ primary.** Verbatim: *"When running a standby server, you must set this parameter to have the same or higher value as on the primary server. Otherwise, queries will not be allowed in the standby server."*[^max-locks] Same applies to `max_pred_locks_per_transaction` and similar settings; verify before upgrading either side.

14. **`fastpath = true` does not mean a weaker lock.** It means the lock was tracked in the per-backend fast-path cache, available only for the four weakest modes (`ACCESS SHARE`, `ROW SHARE`, `ROW EXCLUSIVE`, `SHARE UPDATE EXCLUSIVE`). Conflict detection still works correctly; the lock is just cheaper to acquire.

15. **`waitstart` can be null for a granted lock OR briefly null for a wait.** Verbatim PG14+: *"Note that this can be null for a very short period of time after the wait started even though `granted` is `false`."*[^waitstart-rule] Filter on `granted = false` AND `waitstart IS NOT NULL` if you specifically want "waiting AND wait-time known."

16. **Page-level locks (`pg_locks.locktype = 'page'`) are not the source of application-visible blocks.** They are internal, short-lived, and almost always GIN pending-list flush or B-tree page splits. If you see one persistently, investigate the GIN index's `fastupdate` setting and `gin_pending_list_limit` (see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)).

17. **`SELECT … FOR UPDATE` on a JOIN locks both tables.** Verbatim: *"A locking clause without a table list affects all tables used in the statement."*[^lock-clause-scope] Use `FOR UPDATE OF specific_table` to scope.

18. **REPEATABLE READ and SERIALIZABLE turn lock-wait failures into serialization failures.** Verbatim: *"Within a `REPEATABLE READ` or `SERIALIZABLE` transaction, however, an error will be thrown if a row to be locked has changed since the transaction started."*[^repeatable-read-lock-fail] You get `SQLSTATE 40001` instead of waiting — and the retry contract from [`42-isolation-levels.md`](./42-isolation-levels.md) Rule 5 applies.

19. **`pg_locks` does not show wait queue order directly.** The order is implied by `waitstart` (PG14+) — earlier `waitstart` = ahead in the queue. Pre-PG14 you have no way to determine the queue order from the view alone.

20. **`CREATE INDEX CONCURRENTLY` takes `SHARE UPDATE EXCLUSIVE`, which is self-conflicting.** You cannot run two `CREATE INDEX CONCURRENTLY` operations on the same table simultaneously — the second waits. Also blocks `VACUUM`, `ANALYZE`, and other concurrent maintenance on the same table for the duration. See [`26-index-maintenance.md`](./26-index-maintenance.md).

21. **`pg_locks` does not show the wait queue across PostgreSQL clusters.** Logical replication apply workers wait on `applytransaction` locks (PG16+) when remote-origin conflicts occur. The other end of the wait — the remote primary's transaction — is invisible to local `pg_locks`. Cross-reference [`74-logical-replication.md`](./74-logical-replication.md).

22. **Predicate locks (`SIReadLock`) do not appear in `pg_blocking_pids` results.** They are conflict-detection markers, not blocking locks. SERIALIZABLE conflict resolution aborts a transaction with `40001`; it does not block one transaction waiting for another to commit. See [`42-isolation-levels.md`](./42-isolation-levels.md).

23. **Setting `lock_timeout` in `postgresql.conf` is not recommended.** Verbatim: *"Setting `lock_timeout` in `postgresql.conf` is not recommended because it would affect all sessions."*[^lock-timeout] Set per-role via `ALTER ROLE … SET lock_timeout` for production defaults (continuing the iteration-41 per-role baseline pattern), or per-statement via `SET LOCAL` for DDL operations.


## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — the snapshot/xmin/xmax model that determines what row-level locks see.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM's `SHARE UPDATE EXCLUSIVE` conflict matrix, the `(to prevent wraparound)` autovacuum that cannot be cancelled.
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — FK enforcement via internal RI triggers taking `FOR KEY SHARE`.
- [`41-transactions.md`](./41-transactions.md) — `BEGIN`/`COMMIT`/`ROLLBACK`, savepoints (which acquire row locks via `FOR UPDATE`), `idle_in_transaction_session_timeout`.
- [`42-isolation-levels.md`](./42-isolation-levels.md) — predicate locks (`SIReadLock`), `40001` serialization failures, the retry contract.
- [`44-advisory-locks.md`](./44-advisory-locks.md) — application-managed cooperative locks via `pg_advisory_lock` family.
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY` lock requirements and conflict surface.
- [`35-partitioning.md`](./35-partitioning.md) — ATTACH/DETACH PARTITION lock matrix.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — joining `pg_locks` to `pg_class`/`pg_namespace`/`pg_stat_activity`.
- [`45-listen-notify.md`](./45-listen-notify.md) — queue-table patterns using `FOR UPDATE SKIP LOCKED` paired with `NOTIFY`-the-id delivery.
- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — per-`ALTER TABLE`-variant lock mode matrix.
- [`37-constraints.md`](./37-constraints.md) — `ALTER TABLE` constraint variants and their lock modes.


## Sources

[^lock-naming]: PostgreSQL 16 documentation, `LOCK` SQL command, Notes section: *"`LOCK TABLE` only deals with table-level locks, and so the mode names involving `ROW` are all misnomers."* https://www.postgresql.org/docs/16/sql-lock.html

[^lock-modes]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.1 Table-Level Locks. Each mode listed with its conflicting modes and acquiring commands verbatim. https://www.postgresql.org/docs/16/explicit-locking.html

[^lock-default]: PostgreSQL 16 documentation, `LOCK` SQL command, Parameters section: *"If no lock mode is specified, then `ACCESS EXCLUSIVE`, the most restrictive mode, is used."* https://www.postgresql.org/docs/16/sql-lock.html

[^lock-outside-tx]: PostgreSQL 16 documentation, `LOCK` SQL command, Notes section: *"`LOCK TABLE` is useless outside a transaction block: the lock would remain held only to the completion of the statement. Therefore PostgreSQL reports an error if `LOCK` is used outside a transaction block."* https://www.postgresql.org/docs/16/sql-lock.html

[^lock-nowait]: PostgreSQL 16 documentation, `LOCK` SQL command, Parameters section: *"`NOWAIT` Specifies that `LOCK TABLE` should not wait for any conflicting locks to be released: if the specified lock(s) cannot be acquired immediately without waiting, the transaction is aborted."* https://www.postgresql.org/docs/16/sql-lock.html

[^pg16-lock-perms]: PostgreSQL 16 release notes: *"Simplify permissions for `LOCK TABLE` (Jeff Davis). Previously a user's ability to perform `LOCK TABLE` at various lock levels was limited to the lock levels required by the commands they had permission to execute on the table. For example, someone with `UPDATE` permission could perform all lock levels except `ACCESS SHARE`, even though it was a lesser lock level. Now users can issue lesser lock levels if they already have permission for greater lock levels."* https://www.postgresql.org/docs/release/16.0/

[^update-takes-for-update]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.2 Row-Level Locks: *"The `FOR UPDATE` lock mode is also acquired by any `DELETE` on a row, and also by an `UPDATE` that modifies the values of certain columns. Currently, the set of columns considered for the `UPDATE` case are those that have a unique index on them that can be used in a foreign key (so partial indexes and expressional indexes are not considered), but this may change in the future."* https://www.postgresql.org/docs/16/explicit-locking.html

[^repeatable-read-lock-fail]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.2 Row-Level Locks: *"Within a `REPEATABLE READ` or `SERIALIZABLE` transaction, however, an error will be thrown if a row to be locked has changed since the transaction started."* https://www.postgresql.org/docs/16/explicit-locking.html

[^lock-clause-scope]: PostgreSQL 16 documentation, `SELECT` SQL command, "The Locking Clause": *"If specific tables are named in a locking clause, then only rows coming from those tables are locked; any other tables used in the `SELECT` are simply read as usual. A locking clause without a table list affects all tables used in the statement."* https://www.postgresql.org/docs/16/sql-select.html

[^nowait-skip-locked]: PostgreSQL 16 documentation, `SELECT` SQL command, "The Locking Clause": *"With `NOWAIT`, the statement reports an error, rather than waiting, if a selected row cannot be locked immediately. With `SKIP LOCKED`, any selected rows that cannot be immediately locked are skipped. Skipping locked rows provides an inconsistent view of the data, so this is not suitable for general purpose work, but can be used to avoid lock contention with multiple consumers accessing a queue-like table."* https://www.postgresql.org/docs/16/sql-select.html

[^nowait-table-lock]: PostgreSQL 16 documentation, `SELECT` SQL command, "The Locking Clause": *"Note that `NOWAIT` and `SKIP LOCKED` apply only to the row-level lock(s) — the required `ROW SHARE` table-level lock is still taken in the ordinary way (see Chapter 13)."* https://www.postgresql.org/docs/16/sql-select.html

[^page-locks]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.3 Page-Level Locks: *"In addition to table and row locks, page-level share/exclusive locks are used to control read/write access to table pages in the shared buffer pool. These locks are released immediately after a row is fetched or updated."* https://www.postgresql.org/docs/16/explicit-locking.html

[^deadlock-rule]: PostgreSQL 16 documentation, "Explicit Locking", §13.3.5 Deadlocks: *"PostgreSQL automatically detects deadlock situations and resolves them by aborting one of the transactions involved, allowing the other(s) to complete. (Exactly which transaction will be aborted is difficult to predict and should not be relied upon.)"* https://www.postgresql.org/docs/16/explicit-locking.html

[^deadlock-timeout]: PostgreSQL 16 documentation, "Lock Management" runtime config, `deadlock_timeout`: *"This is the amount of time to wait on a lock before checking to see if there is a deadlock condition. The check for deadlock is relatively expensive, so the server doesn't run it every time it waits for a lock. We optimistically assume that deadlocks are not common in production applications and just wait on the lock for a while before checking for a deadlock ... The default is one second (`1s`), which is probably about the smallest value you would want in practice ... When `log_lock_waits` is set, this parameter also determines the amount of time to wait before a log message is issued about the lock wait."* https://www.postgresql.org/docs/16/runtime-config-locks.html

[^lock-timeout]: PostgreSQL 16 documentation, "Client Connection Defaults" runtime config, `lock_timeout`: *"Abort any statement that waits longer than the specified amount of time while attempting to acquire a lock on a table, index, row, or other database object. The time limit applies separately to each lock acquisition attempt ... A value of zero (the default) disables the timeout. Unlike `statement_timeout`, this timeout can only occur while waiting for locks ... Setting `lock_timeout` in `postgresql.conf` is not recommended because it would affect all sessions."* https://www.postgresql.org/docs/16/runtime-config-client.html

[^max-locks]: PostgreSQL 16 documentation, "Lock Management" runtime config, `max_locks_per_transaction`: *"The shared lock table has space for `max_locks_per_transaction` objects (e.g., tables) per server process or prepared transaction; hence, no more than this many distinct objects can be locked at any one time. This parameter limits the average number of object locks used by each transaction; individual transactions can lock more objects as long as the locks of all transactions fit in the lock table. This is not the number of rows that can be locked; that value is unlimited. The default, 64, has historically proven sufficient ... When running a standby server, you must set this parameter to have the same or higher value as on the primary server."* https://www.postgresql.org/docs/16/runtime-config-locks.html

[^fastpath]: PostgreSQL 16 documentation, `pg_locks` system view, columns table: `fastpath` is *"True if lock was taken via fast path, false if taken via main lock table."* https://www.postgresql.org/docs/16/view-pg-locks.html

[^waitstart-rule]: PostgreSQL 16 documentation, `pg_locks` system view, columns table: `waitstart` is *"Time when the server process started waiting for this lock, or null if the lock is held. Note that this can be null for a very short period of time after the wait started even though `granted` is `false`."* https://www.postgresql.org/docs/16/view-pg-locks.html

[^pg14-waitstart]: PostgreSQL 14 release notes, System Views: *"Add lock wait start time to `pg_locks` (Atsushi Torikoshi)."* https://www.postgresql.org/docs/release/14.0/

[^pg16-spectoken]: PostgreSQL 16 release notes, Monitoring: *"Add speculative lock information to the `pg_locks` system view (Masahiko Sawada, Noriyoshi Shinoda). The transaction id is displayed in the `transactionid` column and the speculative insertion token is displayed in the `objid` column."* https://www.postgresql.org/docs/release/16.0/

[^pg-blocking-pids]: PostgreSQL 16 documentation, "System Information Functions", `pg_blocking_pids`: *"Returns an array of the process ID(s) of the sessions that are blocking the server process with the specified process ID from acquiring a lock, or an empty array if there is no such server process or it is not blocked. One server process blocks another if it either holds a lock that conflicts with the blocked process's lock request (hard block), or is waiting for a lock that would conflict with the blocked process's lock request and is ahead of it in the wait queue (soft block) ... there may be duplicated PIDs in the result. Also note that when a prepared transaction holds a conflicting lock, it will be represented by a zero process ID. Frequent calls to this function could have some impact on database performance, because it needs exclusive access to the lock manager's shared state for a short time."* https://www.postgresql.org/docs/16/functions-info.html

[^safe-snapshot-blocking]: PostgreSQL 16 documentation, "System Information Functions", `pg_safe_snapshot_blocking_pids`: *"Returns an array of the process ID(s) of the sessions that are blocking the server process with the specified process ID from acquiring a safe snapshot, or an empty array if there is no such server process or it is not blocked. A session running a SERIALIZABLE transaction blocks a SERIALIZABLE READ ONLY DEFERRABLE transaction from acquiring a snapshot until the latter determines that it is safe to avoid taking any predicate locks."* https://www.postgresql.org/docs/16/functions-info.html

[^pg18-log-lock-failures]: PostgreSQL 18 release notes, Monitoring: *"Add server variable `log_lock_failures` to log lock acquisition failures (Yuki Seino, Fujii Masao). Specifically it reports `SELECT ... NOWAIT` lock failures."* https://www.postgresql.org/docs/release/18.0/

- PostgreSQL 16 documentation, "Explicit Locking" chapter. https://www.postgresql.org/docs/16/explicit-locking.html
- PostgreSQL 16 documentation, `LOCK` SQL command. https://www.postgresql.org/docs/16/sql-lock.html
- PostgreSQL 16 documentation, `SELECT` SQL command. https://www.postgresql.org/docs/16/sql-select.html
- PostgreSQL 16 documentation, `pg_locks` view. https://www.postgresql.org/docs/16/view-pg-locks.html
- PostgreSQL 16 documentation, "System Information Functions". https://www.postgresql.org/docs/16/functions-info.html
- PostgreSQL 16 documentation, "Lock Management" runtime configuration. https://www.postgresql.org/docs/16/runtime-config-locks.html
- PostgreSQL 16 documentation, "Client Connection Defaults" runtime configuration. https://www.postgresql.org/docs/16/runtime-config-client.html
- PostgreSQL 16 documentation, "The Statistics Collector", wait events table. https://www.postgresql.org/docs/16/monitoring-stats.html
- PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/
- PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/
- PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/
- PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/
- PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/

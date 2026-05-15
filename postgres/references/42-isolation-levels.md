# Transaction Isolation Levels

The four standard SQL isolation levels (`READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE`), how PostgreSQL maps them onto only **three** distinct internal implementations, what anomalies each level prevents, the Serializable Snapshot Isolation (SSI) algorithm, the `DEFERRABLE READ ONLY` optimization, and the application-level retry contract for serialization failures. The transaction-control commands (`BEGIN` / `COMMIT` / `SAVEPOINT` / `SET TRANSACTION`) live in [`41-transactions.md`](./41-transactions.md); the snapshot data structures (`xmin` / `xmax` / `xip[]`) live in [`27-mvcc-internals.md`](./27-mvcc-internals.md).


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax and Mechanics](#syntax-and-mechanics)
    - [The Three Distinct Levels](#the-three-distinct-levels)
    - [Anomalies Table](#anomalies-table)
    - [READ COMMITTED](#read-committed)
    - [REPEATABLE READ](#repeatable-read)
    - [SERIALIZABLE and Serializable Snapshot Isolation](#serializable-and-serializable-snapshot-isolation)
    - [DEFERRABLE READ ONLY Optimization](#deferrable-read-only-optimization)
    - [Setting the Isolation Level](#setting-the-isolation-level)
    - [default_transaction_isolation and Friends](#default_transaction_isolation-and-friends)
    - [Snapshot Timing](#snapshot-timing)
    - [Predicate Locks (SIReadLock)](#predicate-locks-sireadlock)
    - [The Retry Contract](#the-retry-contract)
    - [Hot Standby Limitation](#hot-standby-limitation)
    - [MVCC Caveats — DDL and Catalogs](#mvcc-caveats--ddl-and-catalogs)
    - [Per-version Timeline](#per-version-timeline)
- [Examples and Recipes](#examples-and-recipes)
- [Gotchas and Anti-patterns](#gotchas-and-anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file when you need to:

- Pick the right isolation level for a workload
- Diagnose a write-skew anomaly that two concurrent `READ COMMITTED` transactions silently allowed
- Understand the Serializable Snapshot Isolation (SSI) algorithm well enough to know when its retry cost is worth its consistency guarantee
- Implement an idempotent application-side retry loop for `40001 serialization_failure` errors
- Bound a long-running analytics report inside `SERIALIZABLE` without abort risk via `READ ONLY DEFERRABLE`
- Decide between `default_transaction_isolation = 'serializable'` cluster-wide vs per-transaction `SET TRANSACTION ISOLATION LEVEL`
- Inspect SSI predicate locks (`SIReadLock` rows in `pg_locks`)
- Audit application code that mistakenly uses `READ UNCOMMITTED` thinking it's a fast non-blocking dirty-read mode (it isn't — PG silently maps it to `READ COMMITTED`)

Cross-references: [`27-mvcc-internals.md`](./27-mvcc-internals.md) for the snapshot data structure and tuple visibility, [`41-transactions.md`](./41-transactions.md) for `BEGIN` / `SET TRANSACTION` / `SET TRANSACTION SNAPSHOT`, [`43-locking.md`](./43-locking.md) for explicit row and table locks (an alternative consistency mechanism), [`44-advisory-locks.md`](./44-advisory-locks.md) for application-level locks (a different alternative), [`08-plpgsql.md`](./08-plpgsql.md) Recipe 8 for the per-row-EXCEPTION-loop anti-pattern in retry code, [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) for monitoring serialization-failure rate.


## Mental Model

Five rules drive every isolation-level decision:

1. **PostgreSQL implements only three distinct levels.** The SQL standard defines four (`READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE`), but PG silently maps `READ UNCOMMITTED` onto `READ COMMITTED`. Verbatim: *"In PostgreSQL, you can request any of the four standard transaction isolation levels, but internally only three distinct isolation levels are implemented, i.e., PostgreSQL's Read Uncommitted mode behaves like Read Committed. This is because it is the only sensible way to map the standard isolation levels to PostgreSQL's multiversion concurrency control architecture."*[^txn-iso] **PG never exposes uncommitted data to readers.**

2. **The default is `READ COMMITTED`.** Not `SERIALIZABLE` (the SQL standard default). Verbatim: *"This parameter controls the default isolation level of each new transaction. The default is 'read committed'."*[^client-config] Every untagged transaction in your application runs at `READ COMMITTED` until you explicitly raise it. This matters because *"Repeatable Read"* and *"Serializable"* in PG are stricter than the SQL standard requires.

3. **Snapshot is taken at the first query/DML, not at `BEGIN`.** Verbatim: *"A repeatable read transaction's snapshot is actually frozen at the start of its first query or data-modification command (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `MERGE`), so it is possible to obtain locks explicitly before the snapshot is frozen."*[^applevel] An empty `BEGIN; ... COMMIT;` with no statement in between has no observable snapshot. This is why `BEGIN ISOLATION LEVEL REPEATABLE READ` followed by a multi-second `LOCK TABLE` is legal and useful.

4. **`SERIALIZABLE` is implemented via SSI (Serializable Snapshot Isolation), not by locking reads.** Verbatim: *"The Serializable isolation level is implemented using a technique known in academic database literature as Serializable Snapshot Isolation, which builds on Snapshot Isolation by adding checks for serialization anomalies."*[^txn-iso] Reads acquire *predicate locks* (`SIReadLock` in `pg_locks`) that don't block other transactions but participate in conflict detection. Verbatim: *"In PostgreSQL these locks do not cause any blocking and therefore can not play any part in causing a deadlock."*[^txn-iso] The cost of `SERIALIZABLE` is the *retry contract*, not blocking.

5. **`SERIALIZABLE` requires applications to retry on SQLSTATE `40001`.** Verbatim: *"It is important that an environment which uses this technique have a generalized way of handling serialization failures (which always return with an SQLSTATE value of '40001')."*[^txn-iso] *"Applications using this level must be prepared to retry transactions due to serialization failures."*[^txn-iso] If your application code cannot wrap its database calls in a retry-from-`BEGIN` loop, you cannot use `SERIALIZABLE` safely. The `DEFERRABLE READ ONLY` form is the *only* SERIALIZABLE shape that cannot abort.

> [!WARNING] Five PG majors with zero changes
> PostgreSQL 14, 15, 16, 17, and 18 release notes contain **zero items** about isolation-level semantics, snapshot model, SSI, predicate locks, or serialization-failure handling. The semantics are stable since the PG9.1 SSI introduction. PG17 did remove `old_snapshot_threshold` (see [`27-mvcc-internals.md`](./27-mvcc-internals.md) gotcha #10) but that was a vacuum/visibility-window setting, not an isolation-level change. If a tutorial claims "PG18 improved SERIALIZABLE," verify against the release notes directly.


## Decision Matrix

| You need to                                                              | Use                                                       | Avoid                                            | Why                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Default OLTP workload (CRUD + transactional reads)                       | `READ COMMITTED` (the default)                            | `SERIALIZABLE` cluster-wide                      | Most workloads don't have anomalies that matter; the SSI overhead is wasted                                                         |
| Multi-statement read consistency (financial summary across two tables)   | `BEGIN ISOLATION LEVEL REPEATABLE READ`                   | `READ COMMITTED` with manual locking             | Repeatable Read freezes a single snapshot for the whole transaction — easy and free                                                  |
| Prevent write skew (concurrent updates each pass a check that excludes the other) | `BEGIN ISOLATION LEVEL SERIALIZABLE`                  | `REPEATABLE READ` with `SELECT ... FOR UPDATE`   | Write skew is exactly what SSI catches; FOR UPDATE on every read is fragile and error-prone                                          |
| Long-running analytics report on serializable cluster without abort risk | `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE` | Plain SERIALIZABLE                               | DEFERRABLE waits for a safe snapshot, then runs predicate-lock-free                                                                  |
| Set isolation for one transaction only                                   | `BEGIN ISOLATION LEVEL ... ;` or `SET TRANSACTION ...`    | `default_transaction_isolation` cluster-wide     | Per-transaction is precise; cluster-wide affects pg_dump, autovacuum, every legacy connection                                         |
| Prepare an idempotent retry path before opting into SERIALIZABLE         | Application-level retry loop catching `40001`             | "Just try once" SERIALIZABLE                     | SERIALIZABLE without retry is unreliable on busy clusters                                                                            |
| Read consistency on a hot standby                                        | `REPEATABLE READ` (SERIALIZABLE not supported)            | `SERIALIZABLE` (errors on standby)               | SSI infrastructure isn't replicated to standbys                                                                                      |
| Snapshot-share two parallel reader sessions                              | `pg_export_snapshot()` + `SET TRANSACTION SNAPSHOT`       | Two `BEGIN ISOLATION LEVEL REPEATABLE READ`s     | Manual will give two *different* snapshots taken at slightly different times                                                          |
| Configure `READ COMMITTED` as the cluster default explicitly             | Leave `default_transaction_isolation` at its default      | Setting it to `read committed`                   | The default *is* `read committed`; setting it explicitly is a no-op that confuses operators                                          |
| Bypass SSI cost for a SERIALIZABLE shop's reporting queries              | `SET TRANSACTION READ ONLY DEFERRABLE` (already SERIALIZABLE) | New SERIALIZABLE READ-WRITE for a report     | DEFERRABLE READ ONLY transactions skip predicate locks once they get a safe snapshot                                                  |

Three smell signals that you reached for the wrong tool:

- **Reaching for `READ UNCOMMITTED` for "performance"** — this is silently `READ COMMITTED` in PG; the only thing you achieved is making a code reviewer think you don't know PostgreSQL. Remove it.
- **`SERIALIZABLE` cluster-wide on a workload with no application-side retry handler** — every transient SSI conflict surfaces as an unhandled exception in the application. Either lower to `READ COMMITTED` or write the retry loop first.
- **Manual `SELECT ... FOR UPDATE` on every read inside a `READ COMMITTED` transaction to "simulate" SERIALIZABLE** — you're paying lock-conflict cost on every read and still missing write-skew anomalies. Use SERIALIZABLE.


## Syntax and Mechanics

### The Three Distinct Levels

PostgreSQL implements three levels. The mapping from the SQL standard is:

| SQL standard requested | What PG runs internally | Notes                                                                                                                  |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `READ UNCOMMITTED`     | `READ COMMITTED`        | Verbatim: *"In PostgreSQL `READ UNCOMMITTED` is treated as `READ COMMITTED`."*[^set-tx]                                  |
| `READ COMMITTED`       | `READ COMMITTED`        | Per-statement snapshot. **Default.**                                                                                    |
| `REPEATABLE READ`      | `REPEATABLE READ` (true SI) | Transaction-scoped snapshot; stricter than the standard requires (also prevents phantoms)                            |
| `SERIALIZABLE`         | `SERIALIZABLE` (SSI)    | REPEATABLE READ + predicate-lock conflict detection (Serializable Snapshot Isolation)                                  |

### Anomalies Table

The four classical anomalies and which PG levels prevent them. Note PG's REPEATABLE READ is stricter than the SQL standard requires (the standard permits phantom reads at REPEATABLE READ; PG does not):

| Anomaly                  | READ COMMITTED | REPEATABLE READ      | SERIALIZABLE         |
| ------------------------ | -------------- | -------------------- | -------------------- |
| Dirty read               | Prevented      | Prevented            | Prevented            |
| Non-repeatable read      | **Possible**   | Prevented            | Prevented            |
| Phantom read             | **Possible**   | Prevented (PG-specific) | Prevented         |
| Lost update              | **Possible**   | Prevented (raises 40001) | Prevented (raises 40001) |
| Write skew               | **Possible**   | **Possible**         | Prevented (raises 40001) |
| Read-only anomaly        | **Possible**   | **Possible**         | Prevented (raises 40001) |

Verbatim from the docs: *"This is a stronger guarantee than is required by the SQL standard for this isolation level, and prevents all of the phenomena described in Table 13.1 except for serialization anomalies."*[^txn-iso] And: *"The table also shows that PostgreSQL's Repeatable Read implementation does not allow phantom reads."*[^txn-iso]

### READ COMMITTED

The default level. Each statement sees a snapshot taken **at the start of that statement** — not at the start of the transaction. Two `SELECT` statements within the same `READ COMMITTED` transaction can see different data because concurrent commits land between them.

Verbatim: *"When a transaction uses this isolation level, a `SELECT` query (without a `FOR UPDATE/SHARE` clause) sees only data committed before the query began; it never sees either uncommitted data or changes committed by concurrent transactions during the query's execution."*[^txn-iso]

And: *"However, `SELECT` does see the effects of previous updates executed within its own transaction, even though they are not yet committed."*[^txn-iso]

What this means operationally:

- **`UPDATE` re-reads.** When an `UPDATE` finds a row that another transaction modified after the snapshot but before this `UPDATE` reached it, the second `UPDATE` *waits* for the first to commit/rollback, then re-reads the row's latest committed version and re-evaluates its `WHERE` clause against the new version. If the new version still matches, the update proceeds against the *latest* version (not the original snapshot). This is "first-updater-wins" semantics — not a serialization failure, just a brief block.
- **`SELECT FOR UPDATE` and `SELECT FOR SHARE` follow the same re-read rule.** Verbatim: *"Because of the above rules, it is possible for an updating command to see an inconsistent snapshot: it can see the effects of concurrent updating commands on the same rows it is trying to update, but it does not see effects of those commands on other rows in the database."*[^txn-iso]
- **No protection against lost updates.** Two concurrent `UPDATE accounts SET balance = balance - 100 WHERE id = 5` are both safe (each takes a row lock and re-reads). But two concurrent `value = balance - 100` reads followed by `UPDATE accounts SET balance = $value WHERE id = 5` *are not* — each computes its own `$value` from its own snapshot and stomps the other.
- **Phantom rows** can appear between two `SELECT count(*) FROM ... WHERE ...` calls in the same transaction.

### REPEATABLE READ

A single snapshot is taken at the first query/DML in the transaction and **all** subsequent reads in the transaction see exactly that snapshot — committed-before-snapshot data only, regardless of how many other transactions commit during this transaction.

Verbatim: *"The _Repeatable Read_ isolation level only sees data committed before the transaction began; it never sees either uncommitted data or changes committed by concurrent transactions during the transaction's execution."*[^txn-iso]

What this means:

- **Same-row consistency.** Two `SELECT * FROM t WHERE id = 5` within a transaction always return the same row data.
- **Phantom prevention.** Two `SELECT count(*) FROM t WHERE owner = 'alice'` always return the same count, even if another transaction commits new matching rows.
- **`UPDATE` and `DELETE` raise serialization failure if the row was modified by a concurrent committed transaction.** This is the "first-committer-wins" rule. The application receives `ERROR: could not serialize access due to concurrent update` (SQLSTATE `40001`) and must retry the entire transaction from `BEGIN`.
- **Write skew is still possible.** Two transactions can each `SELECT` a set of rows that satisfy a constraint, then each `UPDATE` a non-overlapping subset, and both commit successfully even though the *combined* effect violates the application's invariant. This is the precise gap that SERIALIZABLE closes.

> [!NOTE] Snapshot frozen at first statement, not at BEGIN
> Verbatim: *"A repeatable read transaction's snapshot is actually frozen at the start of its first query or data-modification command (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `MERGE`), so it is possible to obtain locks explicitly before the snapshot is frozen."*[^applevel]
>
> Practical consequence: `BEGIN ISOLATION LEVEL REPEATABLE READ; LOCK TABLE accounts IN SHARE MODE; SELECT ...;` is the canonical pattern for "I want to lock first, then read consistently." The `LOCK TABLE` runs *before* the snapshot is taken; the snapshot is taken at the `SELECT`.

### SERIALIZABLE and Serializable Snapshot Isolation

`SERIALIZABLE` provides **REPEATABLE READ + predicate-lock-based conflict detection**. Verbatim: *"The _Serializable_ isolation level provides the strictest transaction isolation. This level emulates serial transaction execution for all committed transactions; as if transactions had been executed one after another, serially, rather than concurrently."*[^txn-iso]

The implementation is **Serializable Snapshot Isolation (SSI)** — verbatim: *"The Serializable isolation level is implemented using a technique known in academic database literature as Serializable Snapshot Isolation, which builds on Snapshot Isolation by adding checks for serialization anomalies."*[^txn-iso]

How SSI works (conceptually, no verbatim source quote available — the academic paper is the canonical reference):

1. Every read in a SERIALIZABLE transaction acquires a **predicate lock** (called `SIReadLock` in PG) on the row(s), page(s), or relation it touched. The granularity is chosen by the executor based on plan shape.
2. These locks **do not block** other transactions — they only flag a *potential dependency*.
3. The transaction manager tracks **read-write dependencies** between concurrent transactions. When `T2` writes data that `T1` previously read (or vice versa), an edge is recorded in the dependency graph.
4. At commit time, if the dependency graph contains a **dangerous structure** (a cycle of read-write conflicts that would imply no serial ordering can produce these results), one transaction is aborted with SQLSTATE `40001`.

Verbatim from the docs: *"To guarantee true serializability PostgreSQL uses _predicate locking_, which means that it keeps locks which allow it to determine when a write would have had an impact on the result of a previous read from a concurrent transaction, had it run first. In PostgreSQL these locks do not cause any blocking and therefore can _not_ play any part in causing a deadlock."*[^txn-iso]

Operational consequences:

- **No new blocking.** SSI does not introduce new `LOCK` waits. SERIALIZABLE never deadlocks at the predicate-lock level.
- **The cost is retry.** A small percentage of transactions that would have committed under SI will be aborted under SSI; the application retries them.
- **The cost grows with concurrency.** More concurrent transactions means more potential dependency edges and more chances of a dangerous structure forming.
- **Predicate-lock granularity affects false positives.** Verbatim: *"The particular locks acquired during execution of a query will depend on the plan used by the query, and multiple finer-grained locks (e.g., tuple locks) may be combined into fewer coarser-grained locks (e.g., page locks) during the course of the transaction to prevent exhaustion of the memory used to track the locks."*[^txn-iso]

Two error messages you will see:

```
ERROR: could not serialize access due to concurrent update
```

(REPEATABLE READ + SERIALIZABLE; first-committer-wins on a directly-conflicting row update.)

```
ERROR: could not serialize access due to read/write dependencies among transactions
```

(SERIALIZABLE only; SSI detected a dangerous structure in the dependency graph.)

Both have SQLSTATE `40001` (`serialization_failure`).[^errcodes]

### DEFERRABLE READ ONLY Optimization

A SERIALIZABLE transaction marked `READ ONLY DEFERRABLE` will *block briefly* at the start until SSI determines it can use a snapshot that cannot trigger serialization failure later. Once it starts reading, it incurs zero predicate-lock overhead.

Verbatim: *"If you explicitly request a `SERIALIZABLE READ ONLY DEFERRABLE` transaction, it will block until it can establish this fact. (This is the _only_ case where Serializable transactions block but Repeatable Read transactions don't.)"*[^txn-iso]

And: *"data read within a _deferrable_ read-only transaction is known to be valid as soon as it is read, because such a transaction waits until it can acquire a snapshot guaranteed to be free from such problems before starting to read any data."*[^txn-iso]

And: *"In fact, `READ ONLY` transactions will often be able to establish that fact at startup and avoid taking any predicate locks."*[^txn-iso]

This is the canonical pattern for **long-running analytics reports on a SERIALIZABLE cluster**. Without `DEFERRABLE`, a 10-minute report has 10 minutes of opportunity to be aborted by an SSI conflict at commit time — which means re-running 10 minutes of work. With `DEFERRABLE`, it waits (typically milliseconds) for a safe snapshot, then runs to completion with no abort risk.

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE;
-- multi-statement reporting query
SELECT ... ;
SELECT ... ;
COMMIT;  -- or simply close the connection; nothing to write
```

> [!WARNING] DEFERRABLE only matters for SERIALIZABLE READ ONLY
> Verbatim from `SET TRANSACTION`: *"The `DEFERRABLE` transaction property has no effect unless the transaction is also `SERIALIZABLE` and `READ ONLY`."*[^set-tx] All three properties must be set together. `BEGIN DEFERRABLE` (without SERIALIZABLE READ ONLY) is silently a no-op.

### Setting the Isolation Level

The grammar (cross-references [`41-transactions.md`](./41-transactions.md) for the full transaction-mode list):

```sql
-- Per-transaction, at BEGIN:
BEGIN ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
                     [ , READ WRITE | READ ONLY ]
                     [ , [NOT] DEFERRABLE ];

-- Equivalent: SET inside an open transaction (must be the FIRST statement after BEGIN):
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;

-- Persistent default for the session:
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

Verbatim from the SET TRANSACTION grammar:

```
ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
READ WRITE | READ ONLY
[ NOT ] DEFERRABLE
```

The four isolation level keywords, and READ WRITE / READ ONLY (with READ WRITE the default), and the DEFERRABLE flag. **READ UNCOMMITTED** is accepted by the parser but executes as READ COMMITTED.[^set-tx]

> [!WARNING] Cannot change isolation level after the first statement
> Verbatim from `SET TRANSACTION`: *"The `SET TRANSACTION` command sets the characteristics of the current transaction. It has no effect on any subsequent transactions."* And implicitly: once a snapshot is taken (at the first statement), the isolation level cannot change. Calls to `SET TRANSACTION ISOLATION LEVEL` *after* the first statement raise `ERROR: SET TRANSACTION ISOLATION LEVEL must be called before any query`.

### default_transaction_isolation and Friends

Three GUCs control transaction defaults; all three are session-scoped (settable in `postgresql.conf`, per-database with `ALTER DATABASE ... SET`, per-role with `ALTER ROLE ... SET`, or per-session with `SET`):

| GUC                                | Default          | Effect                                                                                              |
| ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `default_transaction_isolation`    | `'read committed'` | Sets the default isolation for new transactions in this session                                   |
| `default_transaction_read_only`    | `off` (read/write) | Sets the default `READ WRITE` vs `READ ONLY` for new transactions                                 |
| `default_transaction_deferrable`   | `off`            | Sets the default `DEFERRABLE` flag (only meaningful with `SERIALIZABLE READ ONLY`)                |

Verbatim from the docs: *"This parameter controls the default isolation level of each new transaction. The default is 'read committed'."*[^client-config]

And: *"A read-only SQL transaction cannot alter non-temporary tables. This parameter controls the default read-only status of each new transaction. The default is `off` (read/write)."*[^client-config]

And: *"When running at the `serializable` isolation level, a deferrable read-only SQL transaction may be delayed before it is allowed to proceed. However, once it begins executing it does not incur any of the overhead required to ensure serializability; so serialization code will have no reason to force it to abort because of concurrent updates, making this option suitable for long-running read-only transactions."*[^client-config]

The verbatim recommendation from the application-level consistency chapter: *"If the Serializable transaction isolation level is used for all writes and for all reads which need a consistent view of the data, no other effort is required to ensure consistency."*[^applevel] *"It may be a good idea to set `default_transaction_isolation` to `serializable`. It would also be wise to take some action to ensure that no other transaction isolation level is used, either inadvertently or to subvert integrity checks, through checks of the transaction isolation level in triggers."*[^applevel]

### Snapshot Timing

The exact instant a snapshot is taken depends on the level:

| Level             | When the snapshot is taken                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| `READ COMMITTED`  | At the start of **each individual statement** in the transaction           |
| `REPEATABLE READ` | At the **first query or DML** in the transaction (not at `BEGIN`)          |
| `SERIALIZABLE`    | At the **first query or DML** in the transaction (same as REPEATABLE READ) |

Verbatim from the application-level consistency chapter: *"A repeatable read transaction's snapshot is actually frozen at the start of its first query or data-modification command (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `MERGE`), so it is possible to obtain locks explicitly before the snapshot is frozen."*[^applevel]

Why this matters:

- `BEGIN; LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE; SELECT ...;` at REPEATABLE READ takes the lock first, *then* takes the snapshot. The snapshot reflects all transactions committed up to that moment — including any that committed *between* `BEGIN` and `LOCK TABLE`.
- An empty `BEGIN ISOLATION LEVEL SERIALIZABLE; COMMIT;` consumes no SSI resources because no snapshot was ever taken.
- Inside a transaction, `pg_current_snapshot()` returns the active snapshot. Calling it *before* any other statement in REPEATABLE READ counts as the first statement and freezes the snapshot.

### Predicate Locks (SIReadLock)

Predicate locks live in `pg_locks` with `mode = 'SIReadLock'`. Verbatim: *"These will show up in the `pg_locks` system view with a `mode` of `SIReadLock`. The particular locks acquired during execution of a query will depend on the plan used by the query, and multiple finer-grained locks (e.g., tuple locks) may be combined into fewer coarser-grained locks (e.g., page locks) during the course of the transaction to prevent exhaustion of the memory used to track the locks."*[^txn-iso]

Diagnostic query:

```sql
SELECT pid, mode, locktype, relation::regclass, page, tuple, granted
FROM pg_locks
WHERE mode = 'SIReadLock'
ORDER BY pid, relation, page, tuple;
```

Locktype is one of: `relation` (whole table — coarsest), `page`, `tuple` (finest). Granularity escalates dynamically as memory pressure grows. Higher granularity = more false-positive serialization conflicts.

The `max_pred_locks_per_transaction` GUC (default `64`) controls per-transaction predicate-lock memory. The `max_pred_locks_per_relation` and `max_pred_locks_per_page` GUCs (PG10+, default `-2` and `2` respectively) control when granularity escalation kicks in.

### The Retry Contract

Verbatim: *"Applications using this level must be prepared to retry transactions due to serialization failures."*[^txn-iso]

And: *"When an application receives this error message, it should abort the current transaction and retry the whole transaction from the beginning."*[^txn-iso]

And: *"It is important that an environment which uses this technique have a generalized way of handling serialization failures (which always return with an SQLSTATE value of '40001')."*[^txn-iso]

The retry must:

1. **Run the entire transaction from `BEGIN`**, not just the failed statement. The snapshot is gone; you must take a fresh one.
2. **Re-acquire any application-level state** that depended on values read in the failed transaction. Don't cache results across attempts.
3. **Bound the retry count.** Two or three attempts is reasonable; infinite retry under sustained contention will starve the application thread.
4. **Backoff between attempts.** A small randomized delay reduces contention.

The framework example below (Recipe 4) demonstrates the canonical retry shape.

### Hot Standby Limitation

SERIALIZABLE is **not supported on hot standby** servers. Verbatim: *"Support for the Serializable transaction isolation level has not yet been added to hot standby replication targets... The strictest isolation level currently supported in hot standby mode is Repeatable Read. While performing all permanent database writes within Serializable transactions on the primary will ensure that all standbys will eventually reach a consistent state, a Repeatable Read transaction run on the standby can sometimes see a transient state that is inconsistent with any serial execution of the transactions on the primary."*[^mvcc-caveats]

Practical consequences:

- Issuing `BEGIN ISOLATION LEVEL SERIALIZABLE` on a standby raises an error.
- Reporting workloads on a read replica must use `REPEATABLE READ`, not `SERIALIZABLE`. The result may be transiently inconsistent with any serial primary execution.
- If you require SSI guarantees, run reporting on the primary using `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE` (Recipe 5).

### MVCC Caveats — DDL and Catalogs

Two important MVCC caveats that surface at every isolation level:

**TRUNCATE and table-rewriting ALTER TABLE are not MVCC-safe.** Verbatim: *"Some DDL commands, currently only TRUNCATE and the table-rewriting forms of ALTER TABLE, are not MVCC-safe. This means that after the truncation or rewrite commits, the table will appear empty to concurrent transactions, if they are using a snapshot taken before the DDL command committed."*[^mvcc-caveats]

A REPEATABLE READ transaction that read 1000 rows from `accounts` may see 0 rows on its next `SELECT` if a `TRUNCATE accounts` committed between them. This is documented behavior, not a bug.

**System catalog access bypasses isolation level.** Verbatim: *"Internal access to the system catalogs is not done using the isolation level of the current transaction. This means that newly created database objects such as tables are visible to concurrent Repeatable Read and Serializable transactions, even though the rows they contain are not."*[^mvcc-caveats]

Practical: `CREATE TABLE foo (...)` in T1 + `SELECT * FROM foo` in T2 (REPEATABLE READ, snapshot taken before T1 created the table) — T2 *sees* `foo` exists (catalog lookups bypass MVCC) but sees zero rows in it (data reads use the snapshot). T2 cannot easily distinguish "table was just created" from "table was always empty."

### Per-version Timeline

| Version | Change to isolation-level semantics |
| ------- | ----------------------------------- |
| PG14    | **No isolation-level changes.** Release notes contain zero items mentioning serializable / isolation / SSI / predicate locks / snapshot semantics.[^pg14-notes] |
| PG15    | **No isolation-level changes.** Confirmed by direct fetch of release notes.[^pg15-notes] |
| PG16    | **No isolation-level changes.** Confirmed by direct fetch.[^pg16-notes] |
| PG17    | **No isolation-level changes.** PG17 *did* remove `old_snapshot_threshold` (verbatim "Remove server variable old_snapshot_threshold") but that was a snapshot-aging window setting — see [`27-mvcc-internals.md`](./27-mvcc-internals.md) gotcha #10 — not an isolation-level change.[^pg17-notes] |
| PG18    | **No isolation-level changes.** Confirmed by direct fetch.[^pg18-notes] |

The semantics in this file have been stable since the SSI introduction in PG 9.1. If a tutorial or blog claims a recent PG version improved SERIALIZABLE behavior, verify against the release notes directly.


## Examples and Recipes

### Recipe 1 — READ COMMITTED lost-update demonstration

The canonical "two transactions, both compute new value from current value, both write" race that READ COMMITTED does **not** prevent.

Setup:

```sql
CREATE TABLE accounts (id int PRIMARY KEY, balance numeric);
INSERT INTO accounts VALUES (1, 1000);
```

Two concurrent sessions, both at READ COMMITTED (the default):

```sql
-- Session A:
BEGIN;
SELECT balance FROM accounts WHERE id = 1;
-- Returns 1000

-- Session B (in parallel):
BEGIN;
SELECT balance FROM accounts WHERE id = 1;
-- Returns 1000

-- Session A:
UPDATE accounts SET balance = 1000 - 100 WHERE id = 1;  -- balance = 900
COMMIT;

-- Session B:
UPDATE accounts SET balance = 1000 - 200 WHERE id = 1;  -- balance = 800 (!)
COMMIT;

-- Result: balance = 800. Session A's withdrawal of 100 is LOST.
-- Expected if serial: 1000 - 100 - 200 = 700.
```

The fix at READ COMMITTED is **`UPDATE` with arithmetic on the live value**:

```sql
-- Both sessions run:
UPDATE accounts SET balance = balance - $delta WHERE id = 1;
-- The second UPDATE waits for the first, then re-reads balance and applies the delta.
-- Final balance = 700. Correct.
```

Or use REPEATABLE READ (Recipe 2) and accept that one transaction will get a serialization failure and retry.

### Recipe 2 — REPEATABLE READ snapshot-stability demonstration

```sql
-- Session A:
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM accounts;  -- snapshot taken here. Returns 100.

-- Session B (in parallel):
BEGIN;
INSERT INTO accounts (id, balance) VALUES (101, 500);
COMMIT;

-- Session A:
SELECT count(*) FROM accounts;  -- still returns 100 (the snapshot is frozen).
COMMIT;

-- Session A's next BEGIN takes a fresh snapshot; subsequent count returns 101.
```

Use this when:

- Multi-statement reads must be consistent (financial summary across two related tables).
- A long report needs a stable view of the database without holding `SELECT ... FOR UPDATE` on every row.
- You can tolerate a serialization failure if the transaction also writes (REPEATABLE READ raises `40001` on a write conflict, not on a read).

### Recipe 3 — Write skew demonstration that SERIALIZABLE catches

The classic "two doctors on call" scenario. Constraint: at least one doctor must remain on call.

Setup:

```sql
CREATE TABLE doctors (id int PRIMARY KEY, name text, on_call boolean);
INSERT INTO doctors VALUES (1, 'Alice', true), (2, 'Bob', true);
```

Two concurrent sessions, both at REPEATABLE READ (or even READ COMMITTED), both trying to take themselves off-call:

```sql
-- Session A (Alice):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call = true;
-- Returns 2. Constraint OK to take off-call.

-- Session B (Bob, in parallel):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call = true;
-- Returns 2. Constraint OK to take off-call.

-- Session A:
UPDATE doctors SET on_call = false WHERE id = 1;
COMMIT;

-- Session B:
UPDATE doctors SET on_call = false WHERE id = 2;
COMMIT;
-- Both committed. Now zero doctors on call. Invariant violated.
```

Now run the same scenario at SERIALIZABLE — one transaction aborts:

```sql
-- Session A (Alice):
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM doctors WHERE on_call = true;  -- predicate lock acquired
-- Returns 2.

-- Session B (Bob, in parallel):
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM doctors WHERE on_call = true;  -- predicate lock acquired
-- Returns 2.

-- Session A:
UPDATE doctors SET on_call = false WHERE id = 1;
COMMIT;
-- COMMIT succeeds.

-- Session B:
UPDATE doctors SET on_call = false WHERE id = 2;
COMMIT;
-- ERROR: could not serialize access due to read/write dependencies among transactions
-- DETAIL: Reason code: ...
-- HINT: The transaction might succeed if retried.
```

Session B retries from `BEGIN`; on the retry, Bob's count returns 1 and he leaves himself on-call. Invariant preserved.

### Recipe 4 — Application-side retry loop (Python)

Canonical retry-on-`40001` framework. Note: re-acquire all state inside the retry.

```python
import psycopg
from psycopg import errors
import random
import time

def execute_with_retry(conn_factory, work_fn, max_attempts=3, base_delay=0.05):
    """
    Run `work_fn(cursor)` inside a SERIALIZABLE transaction.
    Retry up to `max_attempts` times on serialization_failure (40001).
    """
    for attempt in range(1, max_attempts + 1):
        with conn_factory() as conn:
            try:
                with conn.transaction():
                    conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                    with conn.cursor() as cur:
                        result = work_fn(cur)
                # Commit succeeded.
                return result
            except errors.SerializationFailure:
                if attempt == max_attempts:
                    raise
                # Exponential backoff with jitter.
                time.sleep(base_delay * (2 ** (attempt - 1)) * (0.5 + random.random()))
            # Other errors propagate immediately; psycopg rolls back automatically.
```

For PL/pgSQL inside a function, you cannot retry from within the function (the function runs inside the caller's transaction); the retry must live in the application or in the caller's session. See [`08-plpgsql.md`](./08-plpgsql.md).

### Recipe 5 — DEFERRABLE READ ONLY for analytics reports

The canonical pattern for "long-running reporting query on a SERIALIZABLE cluster that must not abort midway."

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;
-- BEGIN may block briefly (typically <100ms) waiting for a safe snapshot.

-- Once running, no predicate locks are taken; no abort risk.
SELECT
    date_trunc('day', created_at) AS day,
    sum(amount)                     AS total
FROM transactions
WHERE created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1;

SELECT
    customer_id,
    count(*) AS purchase_count,
    sum(amount) AS lifetime_value
FROM transactions
WHERE created_at >= now() - interval '90 days'
GROUP BY 1
ORDER BY 3 DESC
LIMIT 100;

COMMIT;  -- nothing was written; pure read transaction.
```

**Why all three flags matter together:** Verbatim — *"The `DEFERRABLE` transaction property has no effect unless the transaction is also `SERIALIZABLE` and `READ ONLY`."*[^set-tx]

For a report that runs hourly via [`pg_cron`](./98-pg-cron.md):

```sql
SELECT cron.schedule(
    'hourly-revenue-report',
    '0 * * * *',
    $$
    BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;
    INSERT INTO report_revenue (run_at, hourly_total)
    SELECT now(), sum(amount) FROM transactions
    WHERE created_at >= date_trunc('hour', now() - interval '1 hour')
      AND created_at <  date_trunc('hour', now());
    COMMIT;
    $$
);
```

> [!WARNING] DEFERRABLE READ ONLY transactions can write — to a different transaction
> The READ ONLY flag means *this transaction* cannot write to non-temp tables. But the canonical reporting pattern often writes the *result* of the report somewhere. Either: (a) write the result into a TEMP table inside the DEFERRABLE READ ONLY transaction and `INSERT INTO permanent_table SELECT * FROM temp_table` in a separate following transaction; or (b) move the write into a separate non-DEFERRABLE transaction (the recipe above's `INSERT INTO report_revenue SELECT ...` form is *not* READ ONLY — fix as needed).

### Recipe 6 — Set isolation per-session vs per-transaction

```sql
-- Per-transaction (preferred for single transactions that need elevated isolation):
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- ... statements ...
COMMIT;

-- SET TRANSACTION inside an open transaction — must be FIRST statement after BEGIN:
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;
SELECT ...;
COMMIT;

-- Persistent default for the session (every BEGIN in this session uses this level
-- until you SET it again or the session ends):
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Inspect the current setting:
SHOW transaction_isolation;          -- the level of the active transaction
SHOW default_transaction_isolation;  -- the session default for new transactions
```

### Recipe 7 — Per-role default isolation

If a particular service role should always run at SERIALIZABLE, set it via `ALTER ROLE` so every connection from that role inherits the default:

```sql
-- Reporting service connects as role 'reporter' and should always be deferrable RO serializable.
-- We can only set isolation, read_only, and deferrable defaults — not the combination atomically.
ALTER ROLE reporter SET default_transaction_isolation = 'serializable';
ALTER ROLE reporter SET default_transaction_read_only = on;
ALTER ROLE reporter SET default_transaction_deferrable = on;

-- Transactional service should explicitly be at READ COMMITTED (the default, but visible).
ALTER ROLE webapp SET default_transaction_isolation = 'read committed';

-- Inspect:
SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('reporter', 'webapp');
```

Continues the iteration-41 "per-role ALTER ROLE for production timeouts" convention. The `default_transaction_*` settings are set independently — a role using all three (`serializable` + `read_only=on` + `deferrable=on`) gets the DEFERRABLE READ ONLY SERIALIZABLE optimization for every transaction.

### Recipe 8 — Snapshot-share two parallel reader sessions

Two parallel sessions reading the *same* committed snapshot (the pg_dump pattern). See [`41-transactions.md`](./41-transactions.md) for the deep dive on `pg_export_snapshot()`/`SET TRANSACTION SNAPSHOT`.

```sql
-- Session A (the snapshot exporter):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();  -- returns e.g. '00000003-00000018-1'
-- Stay open; do not COMMIT until both readers have imported.

-- Session B (parallel reader 1):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-00000018-1';
SELECT count(*) FROM big_table_partition_1;
COMMIT;

-- Session C (parallel reader 2):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-00000018-1';
SELECT count(*) FROM big_table_partition_2;
COMMIT;

-- Session A finally commits:
COMMIT;
```

All three sessions saw the *same* committed-rows snapshot. This is what `pg_dump --jobs=N` does internally. Note: SERIALIZABLE snapshot export/import is supported (verbatim from `SET TRANSACTION`), but SERIALIZABLE-using-imported-snapshot transactions cannot become read-write — they're read-only.

### Recipe 9 — Inspect predicate locks (SIReadLock)

```sql
-- During an active SERIALIZABLE transaction, see the predicate locks it holds:
SELECT pid, mode, locktype, relation::regclass AS rel, page, tuple, granted
FROM pg_locks
WHERE mode = 'SIReadLock'
ORDER BY pid, rel, page, tuple;

-- Aggregated view: count of predicate locks per backend.
SELECT pid, count(*) AS predicate_locks
FROM pg_locks
WHERE mode = 'SIReadLock'
GROUP BY pid
ORDER BY 2 DESC;

-- Granularity distribution — if you see lots of 'relation' rows, predicate-lock
-- memory pressure caused escalation, which raises false-positive 40001 rate.
SELECT locktype, count(*)
FROM pg_locks
WHERE mode = 'SIReadLock'
GROUP BY locktype;
```

If escalation is hurting you, raise `max_pred_locks_per_transaction` (default 64). It's a server-start-only GUC.

### Recipe 10 — Audit isolation level a transaction is actually using

A common deployment confusion: did this connection actually pick up the new `default_transaction_isolation` setting?

```sql
-- Inside any transaction:
SHOW transaction_isolation;          -- 'read committed', 'repeatable read', or 'serializable'
SHOW transaction_read_only;          -- 'on' or 'off'
SHOW transaction_deferrable;         -- 'on' or 'off'

-- Session-default values (what new transactions will start with):
SHOW default_transaction_isolation;
SHOW default_transaction_read_only;
SHOW default_transaction_deferrable;

-- Cluster-wide (postgresql.conf or ALTER SYSTEM SET):
SELECT name, setting, source, sourcefile, sourceline
FROM pg_settings
WHERE name IN ('default_transaction_isolation',
               'default_transaction_read_only',
               'default_transaction_deferrable');
```

Use this when investigating "I set `default_transaction_isolation = serializable` but the application still fails with non-serializable behavior." Common causes: the application is calling `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` on every connection (check connection-pool config), or the `ALTER SYSTEM` write hadn't been picked up by `SELECT pg_reload_conf()` in already-open connections (the GUC is `S` context — sighup, requires reload).

### Recipe 11 — Trigger-side isolation enforcement

If your data-integrity strategy assumes SERIALIZABLE, defend it via a trigger that aborts non-SERIALIZABLE writes. Continues iteration 41's "trust but verify" pattern for per-role defaults.

```sql
CREATE OR REPLACE FUNCTION enforce_serializable_writes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'serializable' THEN
        RAISE EXCEPTION
            'Writes to % require SERIALIZABLE isolation; current is %',
            TG_TABLE_NAME, current_setting('transaction_isolation')
        USING ERRCODE = 'invalid_transaction_state';
    END IF;
    RETURN NEW;  -- BEFORE-INSERT/UPDATE/DELETE — pass-through
END $$;

CREATE TRIGGER require_serializable
BEFORE INSERT OR UPDATE OR DELETE ON sensitive_ledger
FOR EACH ROW EXECUTE FUNCTION enforce_serializable_writes();
```

Application code that forgets `BEGIN ISOLATION LEVEL SERIALIZABLE` will now fail loudly rather than silently corrupt the ledger. Verbatim from the docs: *"It would also be wise to take some action to ensure that no other transaction isolation level is used, either inadvertently or to subvert integrity checks, through checks of the transaction isolation level in triggers."*[^applevel]

Cross-references [`39-triggers.md`](./39-triggers.md) for the trigger mechanics.

### Recipe 12 — SELECT FOR UPDATE as a READ-COMMITTED workaround

When you cannot use SERIALIZABLE (e.g., the application has no retry loop) and want to defend against lost-update at READ COMMITTED, take an explicit row-level lock:

```sql
BEGIN;  -- READ COMMITTED (default)

-- Read-and-lock pattern:
SELECT balance FROM accounts WHERE id = 5 FOR UPDATE;
-- Returns the latest committed balance and holds a row lock until COMMIT.

-- Compute new value in application code, then write:
UPDATE accounts SET balance = $new_balance WHERE id = 5;
COMMIT;
```

Verbatim from the application-level consistency chapter: *"When non-serializable writes are possible, to ensure the current validity of a row and protect it against concurrent updates one must use `SELECT FOR UPDATE`, `SELECT FOR SHARE`, or an appropriate `LOCK TABLE` statement."*[^applevel] *"`SELECT FOR UPDATE` does not ensure that a concurrent transaction will not update or delete a selected row. To do that in PostgreSQL you must actually update the row, even if no values need to be changed."*[^applevel]

This protects against lost-update on the **single locked row** but does not help with **write skew** across multiple rows or with phantom-creating inserts. For those, SERIALIZABLE is the only built-in defense.

Cross-reference [`43-locking.md`](./43-locking.md) for the row-level lock catalog.

### Recipe 13 — Reporting on a hot standby

SERIALIZABLE is not supported on standbys. Use REPEATABLE READ and accept transient inconsistency.

```sql
-- On the standby:
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- snapshot frozen at first SELECT below
SELECT sum(amount) FROM transactions;
SELECT count(*) FROM customers;
COMMIT;
```

Verbatim from the caveats: *"a Repeatable Read transaction run on the standby can sometimes see a transient state that is inconsistent with any serial execution of the transactions on the primary."*[^mvcc-caveats]

If you need SSI guarantees for the report, run it on the primary with `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE` (Recipe 5) — the predicate-lock-free path means the primary's OLTP throughput is barely affected.


## Gotchas and Anti-patterns

1. **READ UNCOMMITTED is silently READ COMMITTED.** Verbatim: *"In PostgreSQL `READ UNCOMMITTED` is treated as `READ COMMITTED`."*[^set-tx] If your code reaches for READ UNCOMMITTED to "speed up" reads, the only effect is that someone reading your code will assume you don't know PostgreSQL. Remove it.

2. **Default isolation is READ COMMITTED, not SERIALIZABLE.** Verbatim: *"The default is 'read committed'."*[^client-config] The SQL standard's default is SERIALIZABLE; PG's is one notch lower. Application code that assumed SERIALIZABLE behavior because that's what the SQL standard mandates is wrong.

3. **Snapshot is taken at the first query, not at BEGIN.** Verbatim: *"A repeatable read transaction's snapshot is actually frozen at the start of its first query or data-modification command."*[^applevel] An empty `BEGIN; ... COMMIT;` doesn't take a snapshot. `BEGIN; LOCK TABLE foo IN SHARE MODE; SELECT ...;` takes the lock first, then the snapshot — useful pattern.

4. **Cannot change isolation level after first statement.** Once a snapshot is taken, calling `SET TRANSACTION ISOLATION LEVEL` raises `ERROR: SET TRANSACTION ISOLATION LEVEL must be called before any query`. The level is fixed for the transaction's lifetime. Cross-reference [`41-transactions.md`](./41-transactions.md) gotcha #12.

5. **REPEATABLE READ does not allow phantom reads in PG.** The SQL standard permits phantoms at REPEATABLE READ; PG's snapshot isolation prevents them. Verbatim: *"This is a stronger guarantee than is required by the SQL standard for this isolation level."*[^txn-iso] Cross-database portability code that assumes phantom-allowed at REPEATABLE READ is overengineering on PG.

6. **Write skew is invisible at REPEATABLE READ.** Two transactions can both pass a uniqueness check (each scanning a frozen snapshot that excludes the other's pending insert) and both commit. SERIALIZABLE is the only level that catches this. The "doctors on call" / "unique-name across siblings" / "balanced-ledger across two accounts" patterns are all write-skew scenarios.

7. **SERIALIZABLE without a retry loop is broken.** Verbatim: *"Applications using this level must be prepared to retry transactions due to serialization failures."*[^txn-iso] If the application cannot loop back to `BEGIN` on `40001`, it cannot use SERIALIZABLE safely. The retry-loop is part of the contract, not an optional optimization.

8. **The retry must replay from BEGIN, not from the failed statement.** Verbatim: *"it should abort the current transaction and retry the whole transaction from the beginning."*[^txn-iso] The snapshot is dead; you must take a new one. Replay any read-then-decide logic against the new snapshot.

9. **DEFERRABLE is meaningless without SERIALIZABLE READ ONLY.** Verbatim: *"The `DEFERRABLE` transaction property has no effect unless the transaction is also `SERIALIZABLE` and `READ ONLY`."*[^set-tx] `BEGIN DEFERRABLE` (alone) is silently a no-op. `BEGIN SERIALIZABLE DEFERRABLE` (without READ ONLY) is also silently a no-op for the optimization. All three flags must appear together.

10. **SERIALIZABLE is not supported on hot standby.** Verbatim: *"Support for the Serializable transaction isolation level has not yet been added to hot standby replication targets."*[^mvcc-caveats] BEGIN ISOLATION LEVEL SERIALIZABLE on a standby errors out. Reporting on a standby uses REPEATABLE READ at most, with the documented transient-inconsistency caveat.

11. **TRUNCATE and ALTER TABLE are not MVCC-safe.** Verbatim: *"Some DDL commands, currently only TRUNCATE and the table-rewriting forms of ALTER TABLE, are not MVCC-safe. This means that after the truncation or rewrite commits, the table will appear empty to concurrent transactions, if they are using a snapshot taken before the DDL command committed."*[^mvcc-caveats] A REPEATABLE READ transaction reading a table that another transaction TRUNCATEs may see the table as empty mid-transaction. This is documented behavior, not a bug.

12. **System catalog access bypasses isolation.** Verbatim: *"Internal access to the system catalogs is not done using the isolation level of the current transaction. This means that newly created database objects such as tables are visible to concurrent Repeatable Read and Serializable transactions, even though the rows they contain are not."*[^mvcc-caveats] A REPEATABLE READ transaction can see a CREATE TABLE that committed *after* its snapshot was taken — but it cannot see any rows in that table.

13. **SELECT FOR UPDATE inside READ COMMITTED protects only the locked row, not surrounding logic.** It defends against lost-update on a single row but does nothing for write skew or phantom-creating concurrent inserts. The right tool for those is SERIALIZABLE or an explicit table-level LOCK.

14. **`pg_locks.SIReadLock` rows do not block other transactions.** Verbatim: *"In PostgreSQL these locks do not cause any blocking and therefore can _not_ play any part in causing a deadlock."*[^txn-iso] If you see SIReadLock entries in `pg_locks` while debugging a hang, look elsewhere — the hang is from a regular lock, not predicate locking.

15. **Predicate-lock granularity escalates under memory pressure, raising false-positive `40001` rate.** When `max_pred_locks_per_transaction` (default 64) fills, finer-grained tuple locks combine into coarser page or relation locks. A relation-level predicate lock conflicts with everything in the table. Symptom: SSI abort rate climbs as concurrency grows. Fix: raise `max_pred_locks_per_transaction` (server-start-only).

16. **`default_transaction_isolation` set in `postgresql.conf` affects pg_dump, autovacuum, and every connection.** Setting it cluster-wide to `serializable` means pg_dump runs at SERIALIZABLE — its REPEATABLE READ baseline is no longer the explicit choice. Use per-role `ALTER ROLE ... SET default_transaction_isolation` instead so each service role gets the right default. Same per-role pattern as iteration 41 Recipe 1.

17. **Connection poolers can lose `SET SESSION CHARACTERISTICS AS TRANSACTION ...` between checkout and checkin.** In transaction-pooling mode (pgBouncer's `pool_mode = transaction`), session-level state including `SET SESSION CHARACTERISTICS` may not survive across pool checkouts. Use per-transaction `BEGIN ISOLATION LEVEL ...` instead, or use per-role defaults via `ALTER ROLE`. Cross-reference [`81-pgbouncer.md`](./81-pgbouncer.md).

18. **REPEATABLE READ on a write-heavy workload raises `40001` more often than expected.** Any concurrent `UPDATE` to a row this transaction also wants to update raises `could not serialize access due to concurrent update`. This is normal — it's REPEATABLE READ enforcing first-committer-wins. Application must retry from `BEGIN`, just like SERIALIZABLE.

19. **`pg_export_snapshot()` requires its exporting transaction to remain open.** Verbatim from `SET TRANSACTION`: *"The exporting transaction must remain open until the snapshot is imported."* If the exporter commits or rolls back before the importer runs `SET TRANSACTION SNAPSHOT`, the import fails. Cross-reference [`41-transactions.md`](./41-transactions.md) gotcha #15.

20. **SSI does not protect application-level invariants if writes happen outside the transaction.** SSI tracks read-write dependencies *within* the database. If your transaction reads from `accounts`, queries an external service, then writes to `accounts`, SSI can detect a database-side conflict but cannot detect that your external service's response was based on stale data. Hold the entire decision-and-write logic inside one transaction.

21. **`current_setting('transaction_isolation')` returns the *active* level; reading it inside a function does not change it.** A trigger can check the level (Recipe 11) but cannot raise it mid-transaction. Setting it after the first statement raises an error.

22. **Catching `40001` blindly in `EXCEPTION WHEN OTHERS` and continuing is silently corrupting.** A SERIALIZABLE abort means the transaction's reads were not consistent with any serial schedule — the application's logic, if it continues, is operating on inconsistent data. Re-raise from the BEGIN, do not swallow.

23. **Per-row `EXCEPTION` blocks in PL/pgSQL loops create subtransactions, not new transactions.** Catching `unique_violation` or `serialization_failure` inside a PL/pgSQL loop does not retry the *outer* transaction — it only rolls back the inner subtransaction. The outer transaction's snapshot is unchanged. To genuinely retry on `40001`, the retry must live in the application or in a wrapper CALL outside the function. Cross-reference [`08-plpgsql.md`](./08-plpgsql.md) gotcha #5 and [`41-transactions.md`](./41-transactions.md) gotcha #5.


## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — the snapshot data structure (`xmin` / `xmax` / `xip[]`), tuple visibility rules, the cluster-wide xmin horizon
- [`41-transactions.md`](./41-transactions.md) — `BEGIN` / `COMMIT` / `SET TRANSACTION` syntax, savepoints, the five timeouts, two-phase commit
- [`43-locking.md`](./43-locking.md) — explicit row and table locks (`FOR UPDATE`, `LOCK TABLE`, lock conflict matrix), an alternative to SERIALIZABLE for some patterns
- [`44-advisory-locks.md`](./44-advisory-locks.md) — application-level locks, useful when row-level isn't expressive enough
- [`08-plpgsql.md`](./08-plpgsql.md) — `EXCEPTION` blocks and the per-row anti-pattern that fragments retries
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM's interaction with the cluster-wide xmin horizon (long-running SERIALIZABLE transactions block dead-tuple reclamation, same as long-running REPEATABLE READ)
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — monitoring serialization-failure rate via `pg_stat_database.xact_rollback`
- [`81-pgbouncer.md`](./81-pgbouncer.md) — pool-mode interaction with session-level isolation defaults
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling DEFERRABLE READ ONLY analytics jobs


## Sources

[^txn-iso]: PostgreSQL 16 Documentation — Chapter 13.2 *Transaction Isolation*. Verbatim: *"In PostgreSQL, you can request any of the four standard transaction isolation levels, but internally only three distinct isolation levels are implemented, i.e., PostgreSQL's Read Uncommitted mode behaves like Read Committed. This is because it is the only sensible way to map the standard isolation levels to PostgreSQL's multiversion concurrency control architecture."* And: *"This is a stronger guarantee than is required by the SQL standard for this isolation level, and prevents all of the phenomena described in Table 13.1 except for serialization anomalies. The table also shows that PostgreSQL's Repeatable Read implementation does not allow phantom reads."* And: *"The Serializable isolation level provides the strictest transaction isolation. This level emulates serial transaction execution for all committed transactions; as if transactions had been executed one after another, serially, rather than concurrently."* And: *"The Serializable isolation level is implemented using a technique known in academic database literature as Serializable Snapshot Isolation, which builds on Snapshot Isolation by adding checks for serialization anomalies."* And: *"To guarantee true serializability PostgreSQL uses predicate locking, which means that it keeps locks which allow it to determine when a write would have had an impact on the result of a previous read from a concurrent transaction, had it run first. In PostgreSQL these locks do not cause any blocking and therefore can not play any part in causing a deadlock."* And: *"These will show up in the pg_locks system view with a mode of SIReadLock. The particular locks acquired during execution of a query will depend on the plan used by the query, and multiple finer-grained locks (e.g., tuple locks) may be combined into fewer coarser-grained locks (e.g., page locks) during the course of the transaction to prevent exhaustion of the memory used to track the locks."* And: *"Applications using this level must be prepared to retry transactions due to serialization failures. ... When an application receives this error message, it should abort the current transaction and retry the whole transaction from the beginning. ... It is important that an environment which uses this technique have a generalized way of handling serialization failures (which always return with an SQLSTATE value of '40001')."* And: *"If you explicitly request a SERIALIZABLE READ ONLY DEFERRABLE transaction, it will block until it can establish this fact. (This is the only case where Serializable transactions block but Repeatable Read transactions don't.) ... data read within a deferrable read-only transaction is known to be valid as soon as it is read, because such a transaction waits until it can acquire a snapshot guaranteed to be free from such problems before starting to read any data. ... In fact, READ ONLY transactions will often be able to establish that fact at startup and avoid taking any predicate locks."* https://www.postgresql.org/docs/16/transaction-iso.html

[^set-tx]: PostgreSQL 16 Documentation — `SET TRANSACTION`. Verbatim grammar: *"ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }"* and *"READ WRITE | READ ONLY"* and *"[ NOT ] DEFERRABLE"*. And: *"In PostgreSQL READ UNCOMMITTED is treated as READ COMMITTED."* And: *"The DEFERRABLE transaction property has no effect unless the transaction is also SERIALIZABLE and READ ONLY. When all three of these properties are selected for a transaction, the transaction may block when first acquiring its snapshot, after which it is able to run without the normal overhead of a SERIALIZABLE transaction and without any risk of contributing to or being canceled by a serialization failure."* https://www.postgresql.org/docs/16/sql-set-transaction.html

[^client-config]: PostgreSQL 16 Documentation — `Runtime Configuration: Client Connection Defaults` — Statement Behavior. Verbatim for `default_transaction_isolation`: *"Each SQL transaction has an isolation level, which can be either 'read uncommitted', 'read committed', 'repeatable read', or 'serializable'. This parameter controls the default isolation level of each new transaction. The default is 'read committed'."* For `default_transaction_read_only`: *"A read-only SQL transaction cannot alter non-temporary tables. This parameter controls the default read-only status of each new transaction. The default is off (read/write)."* For `default_transaction_deferrable`: *"When running at the serializable isolation level, a deferrable read-only SQL transaction may be delayed before it is allowed to proceed. However, once it begins executing it does not incur any of the overhead required to ensure serializability; so serialization code will have no reason to force it to abort because of concurrent updates, making this option suitable for long-running read-only transactions. This parameter controls the default deferrable status of each new transaction. It currently has no effect on read-write transactions or those operating at isolation levels lower than serializable. The default is off."* https://www.postgresql.org/docs/16/runtime-config-client.html

[^applevel]: PostgreSQL 16 Documentation — Chapter 13.4 *Data Consistency Checks at the Application Level*. Verbatim on retry framework: *"If the Serializable transaction isolation level is used for all writes and for all reads which need a consistent view of the data, no other effort is required to ensure consistency. Software from other environments which is written to use serializable transactions to ensure consistency should 'just work' in this regard in PostgreSQL. When using this technique, it will avoid creating an unnecessary burden for application programmers if the application software goes through a framework which automatically retries transactions which are rolled back with a serialization failure. It may be a good idea to set default_transaction_isolation to serializable. It would also be wise to take some action to ensure that no other transaction isolation level is used, either inadvertently or to subvert integrity checks, through checks of the transaction isolation level in triggers."* On non-serializable workarounds: *"When non-serializable writes are possible, to ensure the current validity of a row and protect it against concurrent updates one must use SELECT FOR UPDATE, SELECT FOR SHARE, or an appropriate LOCK TABLE statement. ... SELECT FOR UPDATE does not ensure that a concurrent transaction will not update or delete a selected row. To do that in PostgreSQL you must actually update the row, even if no values need to be changed."* On snapshot timing: *"A repeatable read transaction's snapshot is actually frozen at the start of its first query or data-modification command (SELECT, INSERT, UPDATE, DELETE, or MERGE), so it is possible to obtain locks explicitly before the snapshot is frozen."* https://www.postgresql.org/docs/16/applevel-consistency.html

[^mvcc-caveats]: PostgreSQL 16 Documentation — Chapter 13.6 *Caveats*. Verbatim on TRUNCATE/ALTER: *"Some DDL commands, currently only TRUNCATE and the table-rewriting forms of ALTER TABLE, are not MVCC-safe. This means that after the truncation or rewrite commits, the table will appear empty to concurrent transactions, if they are using a snapshot taken before the DDL command committed."* On hot-standby SSI: *"Support for the Serializable transaction isolation level has not yet been added to hot standby replication targets... The strictest isolation level currently supported in hot standby mode is Repeatable Read. While performing all permanent database writes within Serializable transactions on the primary will ensure that all standbys will eventually reach a consistent state, a Repeatable Read transaction run on the standby can sometimes see a transient state that is inconsistent with any serial execution of the transactions on the primary."* On catalog visibility: *"Internal access to the system catalogs is not done using the isolation level of the current transaction. This means that newly created database objects such as tables are visible to concurrent Repeatable Read and Serializable transactions, even though the rows they contain are not."* https://www.postgresql.org/docs/16/mvcc-caveats.html

[^errcodes]: PostgreSQL 16 Documentation — Appendix A. *PostgreSQL Error Codes*. Class 40 — Transaction Rollback. Verbatim: `40001 | serialization_failure` and `40P01 | deadlock_detected`. https://www.postgresql.org/docs/16/errcodes-appendix.html

[^pg14-notes]: PostgreSQL 14 Release Notes (verified by direct fetch). Zero items mentioning serializable / isolation / SSI / predicate locks / snapshot semantics / read committed / repeatable read in the headline behavior changes. https://www.postgresql.org/docs/release/14.0/

[^pg15-notes]: PostgreSQL 15 Release Notes (verified by direct fetch). Zero isolation-level items. https://www.postgresql.org/docs/release/15.0/

[^pg16-notes]: PostgreSQL 16 Release Notes (verified by direct fetch). Zero isolation-level items. https://www.postgresql.org/docs/release/16.0/

[^pg17-notes]: PostgreSQL 17 Release Notes (verified by direct fetch). Zero isolation-level semantic items. PG17 *did* remove `old_snapshot_threshold` (verbatim *"Remove server variable old_snapshot_threshold"*) but that was a snapshot-aging window setting, not an isolation-level change — see [`27-mvcc-internals.md`](./27-mvcc-internals.md) gotcha #10. https://www.postgresql.org/docs/release/17.0/

[^pg18-notes]: PostgreSQL 18 Release Notes (verified by direct fetch). Zero isolation-level items. https://www.postgresql.org/docs/release/18.0/

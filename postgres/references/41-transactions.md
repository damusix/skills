# Transactions

`BEGIN` / `COMMIT` / `ROLLBACK` and what they actually do, plus savepoints, subtransactions and their hidden cost, the four timeouts that bound transaction lifetime, and two-phase commit (`PREPARE TRANSACTION`). Isolation-level semantics (`READ COMMITTED` / `REPEATABLE READ` / `SERIALIZABLE`) live in [`42-isolation-levels.md`](./42-isolation-levels.md); the snapshot/xmin model behind them lives in [`27-mvcc-internals.md`](./27-mvcc-internals.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax and Mechanics](#syntax-and-mechanics)
    - [Autocommit and Explicit Transactions](#autocommit-and-explicit-transactions)
    - [BEGIN / START TRANSACTION](#begin--start-transaction)
    - [COMMIT and ROLLBACK](#commit-and-rollback)
    - [END is COMMIT](#end-is-commit)
    - [AND CHAIN](#and-chain)
    - [SAVEPOINT / RELEASE / ROLLBACK TO](#savepoint--release--rollback-to)
    - [Subtransactions and Their Cost](#subtransactions-and-their-cost)
    - [SET TRANSACTION and Transaction Characteristics](#set-transaction-and-transaction-characteristics)
    - [DEFERRABLE SERIALIZABLE READ ONLY](#deferrable-serializable-read-only)
    - [SET TRANSACTION SNAPSHOT](#set-transaction-snapshot)
    - [The Five Timeouts](#the-five-timeouts)
    - [PREPARE TRANSACTION (2PC)](#prepare-transaction-2pc)
    - [pg_prepared_xacts](#pg_prepared_xacts)
    - [Per-version Timeline](#per-version-timeline)
- [Examples and Recipes](#examples-and-recipes)
- [Gotchas and Anti-patterns](#gotchas-and-anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when you need to:

- Pick the right shape for an explicit transaction (`BEGIN ... COMMIT` vs autocommit, with-or-without `AND CHAIN`)
- Use savepoints correctly — and understand why per-row `EXCEPTION` blocks in PL/pgSQL loops are slow
- Configure timeouts that prevent a stuck transaction from holding `xmin` and blocking VACUUM
- Decide whether to enable two-phase commit (`max_prepared_transactions`) and how to clean up abandoned prepared transactions
- Diagnose `idle in transaction` sessions, prepared-transaction leaks, or subxact overflow
- Snapshot-share two parallel sessions for consistent multi-connection reads (`SET TRANSACTION SNAPSHOT`)

Cross-references: [`27-mvcc-internals.md`](./27-mvcc-internals.md) for xmin/xmax and the snapshot model, [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the idle-in-transaction → bloat link, [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) for the prepared-transaction → wraparound link, [`42-isolation-levels.md`](./42-isolation-levels.md) for `READ COMMITTED`/`REPEATABLE READ`/`SERIALIZABLE`, [`43-locking.md`](./43-locking.md) for what `lock_timeout` aborts, [`08-plpgsql.md`](./08-plpgsql.md) for `EXCEPTION` blocks creating subtransactions.

## Mental Model

Five rules drive every transaction decision:

1. **Without `BEGIN`, every statement is its own transaction.** Verbatim: *"By default (without BEGIN), PostgreSQL executes transactions in 'autocommit' mode, that is, each statement is executed in its own transaction and a commit is implicitly performed at the end of the statement (if execution was successful, otherwise a rollback is done)."*[^begin] An explicit `BEGIN` starts a *transaction block*; every statement until `COMMIT` or `ROLLBACK` is part of the same transaction with a single XID and snapshot.

2. **Savepoints are subtransactions; subtransactions cost real money.** Each `SAVEPOINT` (and each PL/pgSQL `EXCEPTION` block) starts a subtransaction. Verbatim from the internals chapter: *"Up to 64 open subxids are cached in shared memory for each backend; after that point, the storage I/O overhead increases significantly due to additional lookups of subxid entries in pg_subtrans."*[^subxacts] Beyond 64, `pg_subtrans` SLRU lookups dominate latency and an EXCEPTION-in-tight-loop becomes pathological. See [Subtransactions and Their Cost](#subtransactions-and-their-cost).

3. **`PREPARE TRANSACTION` is off by default and almost certainly should stay off.** `max_prepared_transactions = 0` is the default, which *disables the feature entirely*.[^max-prepared] Verbatim from PREPARE TRANSACTION: *"PREPARE TRANSACTION is not intended for use in applications or interactive sessions. Its purpose is to allow an external transaction manager to perform atomic global transactions across multiple databases or other transactional resources. Unless you're writing a transaction manager, you probably shouldn't be using PREPARE TRANSACTION."*[^prepare-tx] And: *"It is unwise to leave transactions in the prepared state for a long time. This will interfere with the ability of VACUUM to reclaim storage, and in extreme cases could cause the database to shut down to prevent transaction ID wraparound."*[^prepare-tx]

4. **Idle sessions inside an open transaction are catastrophic; idle sessions outside one are merely annoying.** An open transaction holds an `xmin` that prevents VACUUM from reclaiming dead tuples cluster-wide. Verbatim: *"Even when no significant locks are held, an open transaction prevents vacuuming away recently-dead tuples that may be visible only to this transaction; so remaining idle for a long time can contribute to table bloat."*[^idle-tx-timeout] `idle_in_transaction_session_timeout` must be set in production. The PG14+ `idle_session_timeout` only kills sessions that are *not* in a transaction — it's less critical.

5. **There are five timeouts that bound transaction lifetime; they compose, not conflict.** `statement_timeout` (per statement), `lock_timeout` (per lock acquisition), `idle_in_transaction_session_timeout` (idle *inside* a transaction), `idle_session_timeout` (idle *outside* a transaction, PG14+), and `transaction_timeout` (whole-transaction wall clock, PG17+). They interact: *"If transaction_timeout is shorter or equal to idle_in_transaction_session_timeout or statement_timeout then the longer timeout is ignored."*[^transaction-timeout]

> [!WARNING] Prepared transactions can break wraparound prevention
> A prepared transaction's `xmin` is held until `COMMIT PREPARED` or `ROLLBACK PREPARED` runs — even after the originating session disconnects. An abandoned prepared transaction blocks VACUUM forever. Verbatim: *"If you have not set up an external transaction manager to track prepared transactions and ensure they get closed out promptly, it is best to keep the prepared-transaction feature disabled by setting max_prepared_transactions to zero."*[^prepare-tx] See [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

## Decision Matrix

| You need to                                                          | Use                                                       | Avoid                                       | Why                                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Group multiple statements atomically                                 | `BEGIN ... COMMIT` (or driver-managed transaction)        | Relying on autocommit + retries             | Autocommit cannot give multi-statement atomicity                                                 |
| Roll back partial work without aborting the outer transaction        | `SAVEPOINT name; ... ROLLBACK TO SAVEPOINT name`          | Per-row `EXCEPTION` in a tight PL/pgSQL loop | EXCEPTION blocks open subxacts; >64 active = pg_subtrans overflow                                |
| Chain a fresh transaction with the same characteristics              | `COMMIT AND CHAIN` / `ROLLBACK AND CHAIN`                 | Re-running explicit `SET TRANSACTION`        | AND CHAIN preserves isolation/read-only/deferrable                                               |
| Bound a single query's runtime                                       | `SET LOCAL statement_timeout = '5s'`                      | Cluster-wide `statement_timeout` in postgresql.conf | Cluster-wide affects every session including pg_dump and autovacuum                       |
| Bound a single lock-acquisition wait                                 | `SET LOCAL lock_timeout = '500ms'`                        | NOWAIT for *every* lock                     | NOWAIT errors immediately even on transient contention; lock_timeout gives one bounded wait     |
| Prevent sessions stuck idle inside a transaction                     | `idle_in_transaction_session_timeout` cluster-wide        | Manual `pg_terminate_backend()` cron        | Server-side timeout fires precisely when idle threshold passes; no polling                       |
| Prevent leaked connections                                           | `idle_session_timeout` (PG14+)                            | Idle-in-transaction timeout alone           | idle_session_timeout catches sessions outside any transaction                                    |
| Bound *total* transaction duration                                   | `transaction_timeout` (PG17+)                             | Combining statement_timeout + idle_in_tx    | transaction_timeout aborts at wall-clock duration regardless of per-statement state              |
| Run a long read-only report on serializable without abort risk       | `BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE` | Plain SERIALIZABLE                          | DEFERRABLE waits for a safe snapshot then runs with no serialization-failure risk                |
| Run two parallel sessions over the same snapshot (pg_dump-style)     | `pg_export_snapshot()` + `SET TRANSACTION SNAPSHOT`       | Manual `BEGIN ISOLATION LEVEL REPEATABLE READ` in each session | Manual won't give *identical* snapshots                                              |
| Do atomic two-phase commit across two PG databases                   | `PREPARE TRANSACTION` + `COMMIT PREPARED` on each side    | Application-level retry/compensation        | 2PC gives genuine atomic global commit (with risks; see Gotchas)                                 |
| Disable prepared transactions globally to prevent accidental use     | `max_prepared_transactions = 0`                           | Trusting that no caller will issue PREPARE  | Setting to 0 makes PREPARE TRANSACTION error out at parse                                         |

Three smell signals that you reached for the wrong tool:

- **Per-row `BEGIN`/`COMMIT` inside a single business operation** — each statement that needs to commit-or-rollback together belongs in one transaction. Repeatedly committing midway through fragments atomicity and quadruples WAL volume.
- **Catching `unique_violation` per row in a PL/pgSQL FOREACH loop** — each `EXCEPTION` block creates a subtransaction. At 1000 rows you get 1000 subxids, 16× the overflow threshold. Move to `INSERT ... ON CONFLICT DO NOTHING` (set-based), see [`08-plpgsql.md`](./08-plpgsql.md) Recipe 8.
- **Setting `statement_timeout` in `postgresql.conf`** — it kills pg_dump, REINDEX CONCURRENTLY, autovacuum, and every legitimate long-running maintenance. Use per-role or `SET LOCAL` instead.

## Syntax and Mechanics

### Autocommit and Explicit Transactions

PostgreSQL is autocommit by default (see Mental Model rule 1 for the verbatim quote). Some clients also do their own autocommit toggling. `psql`'s `\set AUTOCOMMIT off` makes psql wrap every statement in an implicit `BEGIN` until `COMMIT`. JDBC's `Connection.setAutoCommit(false)`, libpq's `BEGIN` issued at connection time, ORM frameworks (Hibernate's `@Transactional`, SQLAlchemy's `Session`, etc.) all do something similar. The server doesn't know or care which side started the transaction — once it sees a `BEGIN` (or its first statement under client-side autocommit-off mode), it opens a transaction block.

### BEGIN / START TRANSACTION

```
BEGIN [ WORK | TRANSACTION ] [ transaction_mode [, ...] ]

START TRANSACTION [ transaction_mode [, ...] ]

transaction_mode :=
    ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
  | READ WRITE | READ ONLY
  | [ NOT ] DEFERRABLE
```

`BEGIN` and `START TRANSACTION` are identical. Verbatim: *"START TRANSACTION has the same functionality as BEGIN."*[^begin] BEGIN is a PostgreSQL extension; `START TRANSACTION` is the SQL-standard form.[^begin]

The `WORK` and `TRANSACTION` noise words are optional and equivalent. `BEGIN;`, `BEGIN WORK;`, and `BEGIN TRANSACTION;` are all the same.

`BEGIN` *inside* an existing transaction is **a warning, not an error**. Verbatim: *"Issuing BEGIN when already inside a transaction block will provoke a warning message. The state of the transaction is not affected. To nest transactions within a transaction block, use savepoints (see SAVEPOINT)."*[^begin] PostgreSQL has no nested-transaction syntax; the only way to nest is via savepoints.

### COMMIT and ROLLBACK

```
COMMIT [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]

ROLLBACK [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]
```

`COMMIT` makes the transaction's changes visible to other sessions and durable. Verbatim: *"COMMIT commits the current transaction. All changes made by the transaction become visible to others and are guaranteed to be durable if a crash occurs."*[^commit] Whether durability requires a `fsync` at COMMIT time is controlled by `synchronous_commit` — see [`33-wal.md`](./33-wal.md).

`ROLLBACK` discards everything. Verbatim: *"ROLLBACK rolls back the current transaction and causes all the updates made by the transaction to be discarded."*[^rollback]

`COMMIT` and `ROLLBACK` *outside* a transaction block are warnings, not errors. Verbatim from COMMIT: *"Issuing COMMIT when not inside a transaction does no harm, but it will provoke a warning message. COMMIT AND CHAIN when not inside a transaction is an error."*[^commit]

### END is COMMIT

```
END [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]
```

`END` is a PostgreSQL-only synonym for `COMMIT`. Verbatim: *"END commits the current transaction. ... This command is a PostgreSQL extension that is equivalent to COMMIT."*[^end] There is **no `END` synonym for `ROLLBACK`**. Don't use `END` in code that needs to be SQL-standard portable.

### AND CHAIN

`COMMIT AND CHAIN` or `ROLLBACK AND CHAIN` immediately starts a new transaction with the same characteristics as the just-finished one. Verbatim: *"If AND CHAIN is specified, a new transaction is immediately started with the same transaction characteristics (see SET TRANSACTION) as the just finished one. Otherwise, no new transaction is started."*[^commit]

This is the right primitive for "loop over batches in one connection, each batch its own transaction, all batches with the same isolation level":

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT process_batch(1);
COMMIT AND CHAIN;
SELECT process_batch(2);
COMMIT AND CHAIN;
-- ... continues with REPEATABLE READ READ ONLY ...
COMMIT;
```

`AND NO CHAIN` is the default (no new transaction). It exists for symmetry with the SQL standard; you almost never write it explicitly.

### SAVEPOINT / RELEASE / ROLLBACK TO

```
SAVEPOINT savepoint_name

RELEASE [ SAVEPOINT ] savepoint_name

ROLLBACK [ WORK | TRANSACTION ] TO [ SAVEPOINT ] savepoint_name
```

`SAVEPOINT` opens a named subtransaction. Verbatim: *"A savepoint is a special mark inside a transaction that allows all commands that are executed after it was established to be rolled back, restoring the transaction state to what it was at the time of the savepoint."*[^savepoint]

`RELEASE SAVEPOINT name` discards the savepoint name but **keeps the work** done inside it (merges it into the parent transaction or savepoint). Verbatim: *"RELEASE SAVEPOINT releases the named savepoint and all active savepoints that were created after the named savepoint, and frees their resources. All changes made since the creation of the savepoint that didn't already get rolled back are merged into the transaction or savepoint that was active when the named savepoint was created."*[^release]

`ROLLBACK TO SAVEPOINT name` undoes work done after the savepoint and **leaves the savepoint open** so you can try again. Verbatim: *"Roll back all commands that were executed after the savepoint was established and then start a new subtransaction at the same transaction level. The savepoint remains valid and can be rolled back to again later, if needed."*[^rollback-to]

The keyword `SAVEPOINT` after `RELEASE` or `ROLLBACK TO` is optional in PostgreSQL: `RELEASE foo;` and `ROLLBACK TO foo;` work, but the SQL standard requires the keyword.[^release][^rollback-to]

**Same-name shadowing differs from the SQL standard.** Verbatim: *"SQL requires a savepoint to be destroyed automatically when another savepoint with the same name is established. In PostgreSQL, the old savepoint is kept, though only the more recent one will be used when rolling back or releasing."*[^savepoint] A second `SAVEPOINT foo` doesn't drop the first; releases happen in LIFO order. This bites scripts that assume one-savepoint-per-name semantics.

**Cursor caveat.** Verbatim: *"Any cursor that is opened inside a savepoint will be closed when the savepoint is rolled back. ... A cursor whose execution causes a transaction to abort is put in a cannot-execute state, so while the transaction can be restored using ROLLBACK TO SAVEPOINT, the cursor can no longer be used."*[^rollback-to]

### Subtransactions and Their Cost

A subtransaction is started by either:

- An explicit `SAVEPOINT` command, or
- PL/pgSQL's `BEGIN ... EXCEPTION WHEN ... END;` block (each EXCEPTION block opens an implicit subtransaction so that on error the block's work can be rolled back without aborting the surrounding transaction)

Verbatim from the internals chapter: *"Subtransactions are started inside transactions, allowing large transactions to be broken into smaller units. Subtransactions can commit or abort without affecting their parent transactions. ... Subtransactions can be started explicitly using the SAVEPOINT command, but can also be started in other ways, such as PL/pgSQL's EXCEPTION clause."*[^subxacts]

**Subxids only consume resources if they write.** Verbatim: *"Read-only subtransactions are not assigned subxids, but once they attempt to write, they will be assigned one. This also causes all of a subxid's parents, up to and including the top-level transaction, to be assigned non-virtual transaction ids."*[^subxacts]

**The 64-subxact threshold.** This is the canonical operational rule. Verbatim: *"The more subtransactions each transaction keeps open (not rolled back or released), the greater the transaction management overhead. Up to 64 open subxids are cached in shared memory for each backend; after that point, the storage I/O overhead increases significantly due to additional lookups of subxid entries in pg_subtrans."*[^subxacts]

Operational consequences:

- More than 64 *active* subxids per backend pushes lookups into the `pg_subtrans` SLRU. SLRU contention shows up as `SubtransSLRU` wait events in `pg_stat_activity.wait_event`.
- The threshold is per-backend, not cluster-wide; the SLRU is shared so contention from many backends compounds.
- Releasing or rolling back a savepoint frees its subxid. The threshold counts *active* subxids, not lifetime created.
- PL/pgSQL `EXCEPTION` blocks always create subxacts — even when they catch no exception in a particular iteration — so a loop of 1000 iterations with an EXCEPTION block creates 1000 subxids in sequence (released as each iteration completes the inner BEGIN block).

> [!NOTE] PostgreSQL 16
> PG16 added `pg_stat_get_backend_subxact()` to report per-backend subxid usage live. Verbatim release note: *"Add function pg_stat_get_backend_subxact() to report on a session's subtransaction cache (Dilip Kumar)."*[^pg16-subxact] Pre-PG16 the only way to detect overflow was watching SubtransSLRU wait events.

### SET TRANSACTION and Transaction Characteristics

```
SET TRANSACTION transaction_mode [, ...]
SET TRANSACTION SNAPSHOT snapshot_id
SET SESSION CHARACTERISTICS AS TRANSACTION transaction_mode [, ...]

transaction_mode :=
    ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
  | READ WRITE | READ ONLY
  | [ NOT ] DEFERRABLE
```

`SET TRANSACTION` changes the *current* transaction's characteristics. Verbatim: *"The SET TRANSACTION command sets the characteristics of the current transaction. It has no effect on any subsequent transactions. SET SESSION CHARACTERISTICS sets the default transaction characteristics for subsequent transactions of a session."*[^set-tx]

**The four isolation levels.** Verbatim from PG16:

- `READ COMMITTED` — *"A statement can only see rows committed before it began. This is the default."*[^set-tx]
- `REPEATABLE READ` — *"All statements of the current transaction can only see rows committed before the first query or data-modification statement was executed in this transaction."*[^set-tx]
- `SERIALIZABLE` — *"All statements of the current transaction can only see rows committed before the first query or data-modification statement was executed in this transaction. If a pattern of reads and writes among concurrent serializable transactions would create a situation which could not have occurred for any serial (one-at-a-time) execution of those transactions, one of them will be rolled back with a serialization_failure error."*[^set-tx]
- `READ UNCOMMITTED` — accepted but treated as `READ COMMITTED`. Verbatim: *"The SQL standard defines one additional level, READ UNCOMMITTED. In PostgreSQL READ UNCOMMITTED is treated as READ COMMITTED."*[^set-tx]

Full semantics for each level live in [`42-isolation-levels.md`](./42-isolation-levels.md).

**Isolation can only be set at the start of a transaction.** Verbatim: *"The transaction isolation level cannot be changed after the first query or data-modification statement (SELECT, INSERT, DELETE, UPDATE, MERGE, FETCH, or COPY) of a transaction has been executed."*[^set-tx] In practice this means: put `SET TRANSACTION ISOLATION LEVEL ...` (or use `BEGIN ISOLATION LEVEL ...`) before anything else.

**Default isolation is `READ COMMITTED`.** Set via `default_transaction_isolation`. Verbatim: *"This parameter controls the default isolation level of each new transaction. The default is 'read committed'."*[^default-tx-iso] The SQL standard's default is `SERIALIZABLE`.[^set-tx]

**Read-only mode.** `SET TRANSACTION READ ONLY` (or `BEGIN READ ONLY`, or `default_transaction_read_only = on`). Verbatim: *"A read-only SQL transaction cannot alter non-temporary tables. ... The default is off (read/write)."*[^default-tx-ro] Useful for analytics workloads that should never accidentally write, and as a defense-in-depth measure for read-replica connections.

### DEFERRABLE SERIALIZABLE READ ONLY

The `DEFERRABLE` flag only matters in combination with `SERIALIZABLE READ ONLY`. Verbatim: *"The DEFERRABLE transaction property has no effect unless the transaction is also SERIALIZABLE and READ ONLY. When all three of these properties are selected for a transaction, the transaction may block when first acquiring its snapshot, after which it is able to run without the normal overhead of a SERIALIZABLE transaction and without any risk of contributing to or being canceled by a serialization failure. This mode is well suited for long-running reports or backups."*[^set-tx]

The canonical use case: a long-running analytics report that needs serializable semantics but cannot tolerate being aborted with `serialization_failure`.

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE;
-- waits briefly for a "safe" snapshot, then runs without abort risk
SELECT large_report();
COMMIT;
```

### SET TRANSACTION SNAPSHOT

Two parallel sessions can share an exact snapshot. Session A exports the snapshot, session B imports it.

```sql
-- Session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();         -- returns e.g. '00000003-00000007-1'

-- Session B (within 60s or so)
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-00000007-1';
-- now sees exactly what session A sees
```

Verbatim restrictions: *"The SET TRANSACTION SNAPSHOT command allows a new transaction to run with the same snapshot as an existing transaction."*[^set-tx] *"SET TRANSACTION SNAPSHOT can only be executed at the start of a transaction, before the first query or data-modification statement."*[^set-tx]

This is how `pg_dump --jobs=N` keeps every parallel dump worker on the same MVCC snapshot.

### The Five Timeouts

| Timeout                                 | What it kills                                                              | Where to set         | Default | Available since |
| --------------------------------------- | -------------------------------------------------------------------------- | -------------------- | ------- | --------------- |
| `statement_timeout`                     | A single statement that runs too long                                      | Session / role / db  | 0 (off) | <PG10           |
| `lock_timeout`                          | A single lock-acquisition wait that takes too long                         | Session / role / db  | 0 (off) | 9.3             |
| `idle_in_transaction_session_timeout`   | A session idle while inside an open transaction                            | Session / role / db  | 0 (off) | 9.6             |
| `idle_session_timeout`                  | A session idle *outside* any transaction                                   | Session / role / db  | 0 (off) | **14**          |
| `transaction_timeout`                   | A whole transaction (regardless of statement/idle state)                   | Session / role / db  | 0 (off) | **17**          |

**`statement_timeout`.** Verbatim: *"Abort any statement that takes more than the specified amount of time. ... A value of zero (the default) disables the timeout."*[^statement-timeout] *"Setting statement_timeout in postgresql.conf is not recommended because it would affect all sessions."*[^statement-timeout]

Pre-PG13 behavior difference for simple-query protocol: *"If multiple SQL statements appear in a single simple-Query message, the timeout is applied to each statement separately. (PostgreSQL versions before 13 usually treated the timeout as applying to the whole query string.)"*[^statement-timeout]

**`lock_timeout`.** Verbatim: *"Abort any statement that waits longer than the specified amount of time while attempting to acquire a lock on a table, index, row, or other database object. The time limit applies separately to each lock acquisition attempt. ... A value of zero (the default) disables the timeout."*[^lock-timeout] *"Unlike statement_timeout, this timeout can only occur while waiting for locks. Note that if statement_timeout is nonzero, it is rather pointless to set lock_timeout to the same or larger value, since the statement timeout would always trigger first."*[^lock-timeout]

The right shape for online DDL: `SET LOCAL lock_timeout = '500ms'` before any `ALTER TABLE` that takes `ACCESS EXCLUSIVE` so the migration doesn't queue behind a long-running transaction.

**`idle_in_transaction_session_timeout`.** Verbatim: *"Terminate any session that has been idle (that is, waiting for a client query) within an open transaction for longer than the specified amount of time. ... A value of zero (the default) disables the timeout."*[^idle-tx-timeout] *"This option can be used to ensure that idle sessions do not hold locks for an unreasonable amount of time. Even when no significant locks are held, an open transaction prevents vacuuming away recently-dead tuples that may be visible only to this transaction; so remaining idle for a long time can contribute to table bloat."*[^idle-tx-timeout]

Set it to `1min` or `5min` for OLTP workloads.

**`idle_session_timeout` (PG14+).** Verbatim: *"Terminate any session that has been idle (that is, waiting for a client query), but not within an open transaction, for longer than the specified amount of time. ... A value of zero (the default) disables the timeout."*[^idle-session-timeout]

Less urgent than `idle_in_transaction_session_timeout`. Verbatim: *"Unlike the case with an open transaction, an idle session without a transaction imposes no large costs on the server, so there is less need to enable this timeout."*[^idle-session-timeout] But: *"Be wary of enforcing this timeout on connections made through connection-pooling software or other middleware, as such a layer may not react well to unexpected connection closure."*[^idle-session-timeout]

> [!NOTE] PostgreSQL 14
> Verbatim release note: *"Add server parameter idle_session_timeout to close idle sessions (Li Japin). This is similar to idle_in_transaction_session_timeout."*[^pg14-idle-session]

**`transaction_timeout` (PG17+).** Verbatim from PG17: *"Terminate any session that spans longer than the specified amount of time in a transaction. The limit applies both to explicit transactions (started with BEGIN) and to an implicitly started transaction corresponding to a single statement. ... A value of zero (the default) disables the timeout."*[^transaction-timeout] *"Setting transaction_timeout in postgresql.conf is not recommended because it would affect all sessions."*[^transaction-timeout]

The interaction rule: *"If transaction_timeout is shorter or equal to idle_in_transaction_session_timeout or statement_timeout then the longer timeout is ignored."*[^transaction-timeout]

**The prepared-transaction exception.** Verbatim: *"Prepared transactions are not subject to this timeout."*[^transaction-timeout] Prepared transactions are detached from any session, so per-session timeouts cannot fire.

> [!NOTE] PostgreSQL 17
> Verbatim release note: *"Add server variable transaction_timeout to restrict the duration of transactions (Andrey Borodin, Japin Li, Junwang Zhao, Alexander Korotkov)."*[^pg17-tx-timeout]

### PREPARE TRANSACTION (2PC)

```
PREPARE TRANSACTION transaction_id

COMMIT PREPARED transaction_id

ROLLBACK PREPARED transaction_id
```

Verbatim: *"PREPARE TRANSACTION prepares the current transaction for two-phase commit. After this command, the transaction is no longer associated with the current session; instead, its state is fully stored on disk, and there is a very high probability that it can be committed successfully, even if a database crash occurs before the commit is requested."*[^prepare-tx]

After `PREPARE TRANSACTION`, the transaction is detached from any session and waits for either `COMMIT PREPARED` or `ROLLBACK PREPARED`. Verbatim: *"Once prepared, a transaction can later be committed or rolled back with COMMIT PREPARED or ROLLBACK PREPARED, respectively. Those commands can be issued from any session, not only the one that executed the original transaction."*[^prepare-tx]

**The GID.** The argument to `PREPARE TRANSACTION` is the global transaction identifier (GID). Verbatim: *"An arbitrary identifier that later identifies this transaction for COMMIT PREPARED or ROLLBACK PREPARED. The identifier must be written as a string literal, and must be less than 200 bytes long. It must not be the same as the identifier used for any currently prepared transaction."*[^prepare-tx]

**What a prepared transaction cannot have done.** Verbatim: *"It is not currently allowed to PREPARE a transaction that has executed any operations involving temporary tables or the session's temporary namespace, created any cursors WITH HOLD, or executed LISTEN, UNLISTEN, or NOTIFY."*[^prepare-tx]

**Disabled by default.** Verbatim from the GUC: *"max_prepared_transactions (integer) — Sets the maximum number of transactions that can be in the 'prepared' state simultaneously (see PREPARE TRANSACTION). Setting this parameter to zero (which is the default) disables the prepared-transaction feature. This parameter can only be set at server start."*[^max-prepared]

**Standby implication.** Verbatim: *"When running a standby server, you must set this parameter to the same or higher value than on the primary server. Otherwise, queries will not be allowed in the standby server."*[^max-prepared]

**Permission to commit/rollback prepared.** Verbatim from COMMIT PREPARED: *"To commit a prepared transaction, you must be either the same user that executed the transaction originally, or a superuser. But you do not have to be in the same session that executed the transaction."*[^commit-prepared] The same rule applies to ROLLBACK PREPARED.[^rollback-prepared]

**Cannot run inside a transaction block.** Verbatim: *"This command cannot be executed inside a transaction block. The prepared transaction is committed immediately."*[^commit-prepared]

**Storage of long-lived prepared transactions.** Verbatim from the internals chapter on 2PC: *"In general, this prepared state is intended to be of very short duration, but external availability issues might mean transactions stay in this state for an extended interval. Short-lived prepared transactions are stored only in shared memory and WAL. Transactions that span checkpoints are recorded in the pg_twophase directory."*[^two-phase]

### pg_prepared_xacts

Verbatim: *"The view pg_prepared_xacts displays information about transactions that are currently prepared for two-phase commit. ... pg_prepared_xacts contains one row per prepared transaction. An entry is removed when the transaction is committed or rolled back."*[^pg-prepared-xacts]

Columns:

| Column        | Type            | Meaning                                                              |
| ------------- | --------------- | -------------------------------------------------------------------- |
| `transaction` | xid             | Numeric transaction identifier                                       |
| `gid`         | text            | The GID passed to PREPARE TRANSACTION                                |
| `prepared`    | timestamptz     | When the transaction was prepared                                    |
| `owner`       | name            | User who executed the original transaction (refs `pg_authid.rolname`) |
| `database`    | name            | Database the transaction was executed in (refs `pg_database.datname`) |

Verbatim note: *"When the pg_prepared_xacts view is accessed, the internal transaction manager data structures are momentarily locked, and a copy is made for the view to display."*[^pg-prepared-xacts] Don't poll it at high frequency.

### Per-version Timeline

| Version | Transaction-related changes                                                                                                                                                  | Reference                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| PG 14   | `idle_session_timeout` added.[^pg14-idle-session] Subtransaction-XID association WAL-logged immediately (improves logical decoding).[^pg14-subxact-wal] Logical decoding for 2PC.[^pg14-logical-2pc] | [PG14 release notes][^pg14-rel] |
| PG 15   | Two-phase commit support in logical replication (`CREATE_REPLICATION_SLOT TWO_PHASE`).[^pg15-2pc-logrep]                                                                       | [PG15 release notes][^pg15-rel] |
| PG 16   | `pg_stat_get_backend_subxact()` for subxact monitoring.[^pg16-subxact]                                                                                                         | [PG16 release notes][^pg16-rel] |
| PG 17   | **`transaction_timeout` added.**[^pg17-tx-timeout] Savepoint names and 2PC GIDs replaced with placeholders in `pg_stat_statements`.[^pg17-pgss-savepoint][^pg17-pgss-gid]      | [PG17 release notes][^pg17-rel] |
| PG 18   | Logical-replication-side improvements around two-phase (ALTER SUBSCRIPTION can change a slot's 2PC behavior; `pg_createsubscriber --enable-two-phase`).[^pg18-2pc-alter][^pg18-2pc-createsub] No core SQL or timeout changes. | [PG18 release notes][^pg18-rel] |

## Examples and Recipes

### 1. Baseline production timeouts

Per-role timeouts are the right granularity: they don't affect superuser maintenance, autovacuum, or pg_dump.

```sql
-- Application role (interactive web app)
ALTER ROLE webapp SET statement_timeout = '30s';
ALTER ROLE webapp SET lock_timeout = '5s';
ALTER ROLE webapp SET idle_in_transaction_session_timeout = '60s';

-- PG14+: catch leaked connections
ALTER ROLE webapp SET idle_session_timeout = '15min';

-- PG17+: bound any transaction's wall-clock duration
ALTER ROLE webapp SET transaction_timeout = '5min';

-- Batch role: longer statement timeout, same idle limits
ALTER ROLE batchjobs SET statement_timeout = '1h';
ALTER ROLE batchjobs SET lock_timeout = '30s';
ALTER ROLE batchjobs SET idle_in_transaction_session_timeout = '60s';
```

These apply at *connection time*; existing sessions are unaffected until reconnect. Use `SET` (session-scope) or `SET LOCAL` (transaction-scope) inside an open session to change them per-operation.

### 2. Online DDL with `lock_timeout`

```sql
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '10s';

ALTER TABLE big_table ADD COLUMN new_col integer NULL;

COMMIT;
```

The `SET LOCAL` form resets at COMMIT/ROLLBACK, so it doesn't bleed into the next operation. If the `ALTER TABLE` cannot acquire `ACCESS EXCLUSIVE` within 500ms (because a long-running transaction is holding `ACCESS SHARE`), it aborts cleanly instead of blocking the table. Retry the migration on a quieter window.

### 3. Diagnose idle-in-transaction sessions

```sql
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    state,
    state_change,
    now() - state_change AS idle_for,
    backend_xmin,
    query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change ASC;
```

The leftmost (oldest `state_change`) row is the one holding the xmin horizon back. Terminate it with `SELECT pg_terminate_backend(<pid>);` after confirming. Better: set `idle_in_transaction_session_timeout` so this never lingers in the first place.

### 4. Subtransaction overflow audit

PG16+ via `pg_stat_get_backend_subxact()`:

```sql
SELECT
    a.pid,
    a.usename,
    a.application_name,
    a.state,
    s.subxact_count,
    s.subxact_overflow,
    a.query
FROM pg_stat_activity a
CROSS JOIN LATERAL pg_stat_get_backend_subxact(a.backend_xid) s
WHERE s.subxact_count > 32
ORDER BY s.subxact_count DESC;
```

`subxact_overflow = true` means this backend has overflowed past 64 subxids; lookups now hit pg_subtrans SLRU. Cross-reference [`08-plpgsql.md`](./08-plpgsql.md) for the EXCEPTION-block-in-loop anti-pattern that produces this.

Pre-PG16 audit (less precise):

```sql
SELECT pid, wait_event_type, wait_event, COUNT(*) AS sample_count
FROM pg_stat_activity
WHERE wait_event LIKE 'SubtransSLRU%'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

### 5. SAVEPOINT for retry-on-conflict

```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);

SAVEPOINT before_inventory;
UPDATE inventory SET qty = qty - 1 WHERE sku = 'A123' AND qty > 0;
-- Did the inventory check fail (zero rows updated)?
DO $$
BEGIN
    IF NOT FOUND THEN
        ROLLBACK TO SAVEPOINT before_inventory;
        INSERT INTO backorders (...) VALUES (...);
    END IF;
END $$;
RELEASE SAVEPOINT before_inventory;

COMMIT;
```

The `ROLLBACK TO SAVEPOINT` discards the failed UPDATE but keeps the original INSERT. The savepoint is then released, merging the recovered state into the parent transaction.

### 6. SET LOCAL for one-statement overrides

```sql
BEGIN;
SET LOCAL statement_timeout = '0';            -- disable for this txn only
SET LOCAL lock_timeout = '0';
CLUSTER big_table USING big_table_pkey;
COMMIT;
```

`SET LOCAL` is transaction-scoped — the timeouts reset to the session value at COMMIT. Without `LOCAL`, the `SET` would persist for the rest of the session.

### 7. Snapshot-share two parallel readers

```sql
-- Session A: opens snapshot, exports its identifier
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();          -- e.g. '00000003-00000007-1'
-- Session A continues with its work...

-- Session B (different connection, within ~60s):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-00000007-1';
-- B now sees exactly what A sees
COPY (SELECT * FROM big_table) TO STDOUT;
COMMIT;
```

This is the mechanism pg_dump uses for `--jobs > 1`. The exported snapshot expires when the exporting transaction commits or rolls back.

### 8. DEFERRABLE serializable read-only for reports

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE;
SELECT
    customer_id,
    SUM(amount) AS lifetime_value
FROM transactions
GROUP BY customer_id;
-- ... rest of multi-query report ...
COMMIT;
```

The session may block briefly at the start (waiting for a "safe" snapshot the SSI machinery can confirm needs no abort risk). Once it begins, it runs without the per-tuple overhead of serializable and is immune to serialization-failure aborts.

### 9. Audit and clean up prepared transactions

```sql
-- Inventory all currently-prepared transactions:
SELECT gid, prepared, owner, database, age(prepared) AS age
FROM pg_prepared_xacts
ORDER BY prepared ASC;

-- If a prepared transaction is older than your tolerance (e.g. >1h),
-- the transaction coordinator likely died. After verifying with the app:
ROLLBACK PREPARED 'gid_value_from_query';
```

Until you commit-or-rollback a prepared transaction, its `xmin` blocks VACUUM cluster-wide. The cleanup is `COMMIT PREPARED 'gid';` or `ROLLBACK PREPARED 'gid';` — must be run by the original user or a superuser.

### 10. Disable PREPARE TRANSACTION entirely

```sql
-- postgresql.conf or ALTER SYSTEM
ALTER SYSTEM SET max_prepared_transactions = 0;
-- Requires server restart to take effect.
```

If you have no external transaction manager (XA coordinator, distributed-tx middleware), set this to 0 and keep it there. A stale prepared transaction is one of the few ways a single mistake can take down a cluster via wraparound.

### 11. Bound a maintenance command with `transaction_timeout` (PG17+)

```sql
BEGIN;
SET LOCAL transaction_timeout = '10min';
SET LOCAL lock_timeout = '30s';
VACUUM (VERBOSE, ANALYZE) target_table;
COMMIT;
```

`transaction_timeout` aborts the whole transaction (statement and idle time combined) once `10min` of wall clock elapses, regardless of whether `statement_timeout` has fired. Note: prepared transactions are not subject to this timeout (they can't be — they're not attached to any session).

### 12. AND CHAIN for repeated read-only batches

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
INSERT INTO archive_buffer SELECT * FROM source WHERE batch_id = 1;
COMMIT AND CHAIN;

INSERT INTO archive_buffer SELECT * FROM source WHERE batch_id = 2;
COMMIT AND CHAIN;

-- ... no need to re-state REPEATABLE READ READ ONLY each iteration ...
COMMIT;
```

The `AND CHAIN` form preserves isolation level, read-only flag, and deferrable flag from the just-committed transaction.

### 13. Catalog overview of the four timeouts at session level

```sql
SELECT name, setting, unit, context, source
FROM pg_settings
WHERE name IN (
    'statement_timeout',
    'lock_timeout',
    'idle_in_transaction_session_timeout',
    'idle_session_timeout',
    'transaction_timeout'
)
ORDER BY name;
```

`context = 'user'` for all five — they can be set per-session, per-role, per-database, or cluster-wide. `source` shows where the current value came from (default / configuration file / role / database / session).

## Gotchas and Anti-patterns

1. **`statement_timeout` in `postgresql.conf` kills your maintenance.** It applies to every session including pg_dump, autovacuum's manual VACUUM, REINDEX CONCURRENTLY, and any cron-scheduled job. Set it per-role on the *application* role instead.

2. **`SET` without `LOCAL` persists for the session.** `SET statement_timeout = '0'` inside a transaction bleeds into every subsequent transaction on that connection. Use `SET LOCAL` when you want transaction scope.

3. **`SAVEPOINT foo; SAVEPOINT foo;` keeps both — PostgreSQL extension to the standard.** SQL says the first `foo` should be destroyed; PG keeps it. Releases happen in LIFO order. Scripts ported from other DBs may misbehave.

4. **`RELEASE` cannot run when the transaction is in an aborted state.** Verbatim: *"It is not possible to release a savepoint when the transaction is in an aborted state; to do that, use ROLLBACK TO SAVEPOINT."*[^release] You must roll back to the savepoint first, then release.

5. **A PL/pgSQL `EXCEPTION` block in a tight loop blows past 64 subxids fast.** 1000 iterations = 1000 subxids (each released, but pressure builds). Wait events tell the story: `SubtransSLRU`. Move to set-based DML or `INSERT ... ON CONFLICT DO NOTHING`. Cross-reference [`08-plpgsql.md`](./08-plpgsql.md) gotcha #9.

6. **`idle_in_transaction_session_timeout = 0` (default) is dangerous for OLTP.** A client that hangs (network drop, client deadlock, debugger) keeps a transaction open forever; `xmin` is pinned; VACUUM can't reclaim dead tuples. Set this. Always.

7. **`idle_session_timeout` confuses connection poolers.** Verbatim warning: *"Be wary of enforcing this timeout on connections made through connection-pooling software or other middleware, as such a layer may not react well to unexpected connection closure."*[^idle-session-timeout] If the pool keeps idle connections open longer than your timeout, the pool will get surprise disconnects. Coordinate with pool settings.

8. **`transaction_timeout` skips prepared transactions.** Verbatim: *"Prepared transactions are not subject to this timeout."*[^transaction-timeout] A leaked prepared transaction is invisible to all session-level timeouts and must be cleaned up via `pg_prepared_xacts` audits.

9. **`statement_timeout = 5s, transaction_timeout = 1s` → only `transaction_timeout` matters.** Verbatim: *"If transaction_timeout is shorter or equal to idle_in_transaction_session_timeout or statement_timeout then the longer timeout is ignored."*[^transaction-timeout]

10. **Pre-PG13 `statement_timeout` over a multi-statement simple-Query message timed the *whole message*.** PG13+ times each statement separately. If you carried forward an old `statement_timeout` from a PG12 cluster, behavior changed silently in PG13.[^statement-timeout]

11. **Default isolation level is `READ COMMITTED`, *not* `SERIALIZABLE`.** The SQL standard says SERIALIZABLE; PostgreSQL says READ COMMITTED. If your application requires a stronger guarantee, set `default_transaction_isolation = serializable` on the role.[^default-tx-iso]

12. **Isolation cannot be changed after the first statement.** `SET TRANSACTION ISOLATION LEVEL ...` after a single SELECT errors out. Use `BEGIN ISOLATION LEVEL ...` instead.[^set-tx]

13. **`READ UNCOMMITTED` is silently `READ COMMITTED`.** Verbatim: *"In PostgreSQL READ UNCOMMITTED is treated as READ COMMITTED."*[^set-tx] No dirty reads ever happen in PG; this is intentional.

14. **`DEFERRABLE` is meaningless without both `SERIALIZABLE` and `READ ONLY`.** Verbatim: *"The DEFERRABLE transaction property has no effect unless the transaction is also SERIALIZABLE and READ ONLY."*[^set-tx]

15. **`pg_export_snapshot()` requires the exporting transaction to stay open.** As soon as session A commits, the exported snapshot expires and session B's `SET TRANSACTION SNAPSHOT` errors with `ERROR: invalid snapshot identifier`.

16. **`BEGIN` already inside a transaction is a warning, not an error.** It doesn't open a nested transaction. If you want nesting, you need `SAVEPOINT`. Drivers that issue spurious `BEGIN`s leak warnings into logs.[^begin]

17. **`PREPARE TRANSACTION` cannot follow `LISTEN`/`NOTIFY`/`WITH HOLD` cursor/temp-table activity.** Verbatim: *"It is not currently allowed to PREPARE a transaction that has executed any operations involving temporary tables or the session's temporary namespace, created any cursors WITH HOLD, or executed LISTEN, UNLISTEN, or NOTIFY."*[^prepare-tx]

18. **`COMMIT PREPARED` cannot run inside a transaction block.** Verbatim: *"This command cannot be executed inside a transaction block."*[^commit-prepared] You can't wrap it in `BEGIN; COMMIT PREPARED '...'; COMMIT;` — it must be at the top level.

19. **GID must be a string literal, ≤ 200 bytes.** Verbatim: *"The identifier must be written as a string literal, and must be less than 200 bytes long."*[^prepare-tx] Numeric GIDs get cast to string in error messages, but you must always use string syntax.

20. **Standby must have `max_prepared_transactions` ≥ primary's.** Verbatim: *"When running a standby server, you must set this parameter to the same or higher value than on the primary server. Otherwise, queries will not be allowed in the standby server."*[^max-prepared] A standby with a smaller value won't accept connections.

21. **A prepared transaction's `xmin` is held until commit/rollback prepared.** Even after the originating session disconnects, the xmin lives in `pg_twophase` (if it spanned a checkpoint) and continues to block VACUUM. Cross-reference [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

22. **`END` is a PG-only synonym for COMMIT — there is no `END` for ROLLBACK.** Code that uses `END;` to commit is non-portable. `COMMIT;` is the safe choice.[^end]

23. **`ROLLBACK` outside a transaction is a warning, not an error.** Defensive code that "always rolls back" between operations litters logs with warnings. Driver-level autocommit handling is preferable.[^rollback]

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — tuple xmin/xmax, snapshot xip[], why long-running transactions block VACUUM
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — the operational consequence of an idle-in-transaction session pinning xmin
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — prepared transactions and the wraparound danger
- [`42-isolation-levels.md`](./42-isolation-levels.md) — full semantics of `READ COMMITTED` / `REPEATABLE READ` / `SERIALIZABLE` including SSI
- [`43-locking.md`](./43-locking.md) — what `lock_timeout` aborts; the full lock-conflict matrix
- [`44-advisory-locks.md`](./44-advisory-locks.md) — transaction-scoped vs session-scoped advisory locks
- [`08-plpgsql.md`](./08-plpgsql.md) — `EXCEPTION` blocks creating subtransactions; the loop anti-pattern
- [`07-procedures.md`](./07-procedures.md) — procedures and their ability to issue `COMMIT`/`ROLLBACK` inside the procedure body
- [`33-wal.md`](./33-wal.md) — `synchronous_commit` and the durability/latency tradeoff at COMMIT time
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity` columns including `state`, `wait_event`, `backend_xmin`
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_prepared_xacts`, `pg_locks`
- [`74-logical-replication.md`](./74-logical-replication.md) — two-phase commit decoding (PG14+) and `--enable-two-phase` (PG18+)
- [`80-connection-pooling.md`](./80-connection-pooling.md) — pool-mode interaction with `idle_session_timeout`
- [`45-listen-notify.md`](./45-listen-notify.md) — `LISTEN`/`NOTIFY` incompatibility with `PREPARE TRANSACTION` (gotcha #17); commit-delivery semantics
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `ALTER ROLE … SET` syntax for applying per-role timeout defaults (Recipe 1)
- [`81-pgbouncer.md`](./81-pgbouncer.md) — transaction-mode pooling and `LISTEN`/prepared-statement limitations

## Sources

[^begin]: `BEGIN` — https://www.postgresql.org/docs/16/sql-begin.html
[^commit]: `COMMIT` — https://www.postgresql.org/docs/16/sql-commit.html
[^rollback]: `ROLLBACK` — https://www.postgresql.org/docs/16/sql-rollback.html
[^end]: `END` — https://www.postgresql.org/docs/16/sql-end.html
[^savepoint]: `SAVEPOINT` — https://www.postgresql.org/docs/16/sql-savepoint.html
[^release]: `RELEASE SAVEPOINT` — https://www.postgresql.org/docs/16/sql-release-savepoint.html
[^rollback-to]: `ROLLBACK TO SAVEPOINT` — https://www.postgresql.org/docs/16/sql-rollback-to.html
[^set-tx]: `SET TRANSACTION` — https://www.postgresql.org/docs/16/sql-set-transaction.html
[^prepare-tx]: `PREPARE TRANSACTION` — https://www.postgresql.org/docs/16/sql-prepare-transaction.html
[^commit-prepared]: `COMMIT PREPARED` — https://www.postgresql.org/docs/16/sql-commit-prepared.html
[^rollback-prepared]: `ROLLBACK PREPARED` — https://www.postgresql.org/docs/16/sql-rollback-prepared.html
[^pg-prepared-xacts]: `pg_prepared_xacts` system view — https://www.postgresql.org/docs/16/view-pg-prepared-xacts.html
[^two-phase]: Two-Phase Transactions internals chapter — https://www.postgresql.org/docs/16/two-phase.html
[^subxacts]: Subtransactions internals chapter — https://www.postgresql.org/docs/16/subxacts.html
[^statement-timeout]: `statement_timeout` GUC docs — https://www.postgresql.org/docs/16/runtime-config-client.html
[^lock-timeout]: `lock_timeout` GUC docs — https://www.postgresql.org/docs/16/runtime-config-client.html
[^idle-tx-timeout]: `idle_in_transaction_session_timeout` GUC docs — https://www.postgresql.org/docs/16/runtime-config-client.html
[^idle-session-timeout]: `idle_session_timeout` GUC docs — https://www.postgresql.org/docs/16/runtime-config-client.html
[^default-tx-iso]: `default_transaction_isolation` GUC docs — https://www.postgresql.org/docs/16/runtime-config-client.html
[^default-tx-ro]: `default_transaction_read_only` GUC docs — https://www.postgresql.org/docs/16/runtime-config-client.html
[^transaction-timeout]: `transaction_timeout` GUC docs (PG17+) — https://www.postgresql.org/docs/17/runtime-config-client.html
[^max-prepared]: `max_prepared_transactions` GUC docs — https://www.postgresql.org/docs/16/runtime-config-resource.html
[^pg14-rel]: PG14 release notes — https://www.postgresql.org/docs/release/14.0/
[^pg14-idle-session]: PG14 release notes: *"Add server parameter idle_session_timeout to close idle sessions (Li Japin). This is similar to idle_in_transaction_session_timeout."* — https://www.postgresql.org/docs/release/14.0/
[^pg14-subxact-wal]: PG14 release notes: *"Immediately WAL-log subtransaction and top-level XID association (Tomas Vondra, Dilip Kumar, Amit Kapila). This is useful for logical decoding."* — https://www.postgresql.org/docs/release/14.0/
[^pg14-logical-2pc]: PG14 release notes: *"Enhance logical decoding APIs to handle two-phase commits (Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich)."* — https://www.postgresql.org/docs/release/14.0/
[^pg15-rel]: PG15 release notes — https://www.postgresql.org/docs/release/15.0/
[^pg15-2pc-logrep]: PG15 release notes: *"Add support for prepared (two-phase) transactions to logical replication (Peter Smith, Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). The new CREATE_REPLICATION_SLOT option is called TWO_PHASE. pg_recvlogical now supports a new --two-phase option during slot creation."* — https://www.postgresql.org/docs/release/15.0/
[^pg16-rel]: PG16 release notes — https://www.postgresql.org/docs/release/16.0/
[^pg16-subxact]: PG16 release notes: *"Add function pg_stat_get_backend_subxact() to report on a session's subtransaction cache (Dilip Kumar)."* — https://www.postgresql.org/docs/release/16.0/
[^pg17-rel]: PG17 release notes — https://www.postgresql.org/docs/release/17.0/
[^pg17-tx-timeout]: PG17 release notes: *"Add server variable transaction_timeout to restrict the duration of transactions (Andrey Borodin, Japin Li, Junwang Zhao, Alexander Korotkov)."* — https://www.postgresql.org/docs/release/17.0/
[^pg17-pgss-savepoint]: PG17 release notes: *"Replace savepoint names stored in pg_stat_statements with placeholders (Greg Sabino Mullane). This greatly reduces the number of entries needed to record SAVEPOINT, RELEASE SAVEPOINT, and ROLLBACK TO SAVEPOINT commands."* — https://www.postgresql.org/docs/release/17.0/
[^pg17-pgss-gid]: PG17 release notes: *"Replace the two-phase commit GIDs stored in pg_stat_statements with placeholders (Michael Paquier). This greatly reduces the number of entries needed to record PREPARE TRANSACTION, COMMIT PREPARED, and ROLLBACK PREPARED."* — https://www.postgresql.org/docs/release/17.0/
[^pg18-rel]: PG18 release notes — https://www.postgresql.org/docs/release/18.0/
[^pg18-2pc-alter]: PG18 release notes: *"Allow ALTER SUBSCRIPTION to change the replication slot's two-phase commit behavior (Hayato Kuroda, Ajin Cherian, Amit Kapila, Zhijie Hou)."* — https://www.postgresql.org/docs/release/18.0/
[^pg18-2pc-createsub]: PG18 release notes: *"Add pg_createsubscriber option --enable-two-phase to enable prepared transactions (Shubham Khanna)."* — https://www.postgresql.org/docs/release/18.0/

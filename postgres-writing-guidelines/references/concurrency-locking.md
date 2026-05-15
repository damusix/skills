# Concurrency & Locking


Postgres uses MVCC, so readers never block writers and writers never block readers — but writers block writers when they touch the same row. The row-level lock you take determines how much they block. Picking the right mode prevents deadlocks and lock contention.

## Table of Contents

- [Row Lock Modes](#row-lock-modes)
- [FOR UPDATE](#for-update)
- [FOR NO KEY UPDATE](#for-no-key-update)
- [FOR SHARE and FOR KEY SHARE](#for-share-and-for-key-share)
- [SKIP LOCKED and NOWAIT](#skip-locked-and-nowait)
- [Optimistic Concurrency](#optimistic-concurrency)
- [Advisory Locks](#advisory-locks)
- [Deadlocks](#deadlocks)
- [Isolation Levels (Briefly)](#isolation-levels-briefly)

---

## Row Lock Modes

Postgres has four row-level lock modes, in increasing strength:

| Mode | Blocks | Use case |
|------|--------|----------|
| `FOR KEY SHARE` | FOR UPDATE | Hold a FK reference open against parent deletion |
| `FOR SHARE` | FOR UPDATE, FOR NO KEY UPDATE | Read consistent snapshot; prevent modification |
| `FOR NO KEY UPDATE` | All non-share modes; safer for FK targets | Updating non-key columns |
| `FOR UPDATE` | Everything | Updating or deleting the row |

The weaker the lock, the more concurrent operations succeed.

## FOR UPDATE

Strongest lock. Acquire when you intend to UPDATE or DELETE the row (or change a column referenced by an FK from another table):

    BEGIN;
    SELECT balance FROM account WHERE account_no = 42 FOR UPDATE;
    -- ... compute ...
    UPDATE account SET balance = ... WHERE account_no = 42;
    COMMIT;

Concurrent transactions trying to lock the same row block until you commit or roll back.

## FOR NO KEY UPDATE

Like `FOR UPDATE` but doesn't block `FOR KEY SHARE`. Use when you're updating columns that aren't part of any unique key — the typical "update business data, not the PK":

    SELECT * FROM customer WHERE customer_no = 42 FOR NO KEY UPDATE;
    UPDATE customer SET full_name = 'New' WHERE customer_no = 42;

This lets FK-checking transactions on other tables (which take `FOR KEY SHARE`) proceed without waiting. **For most app updates, this is the right choice** — `FOR UPDATE` is overkill unless you're touching keys.

## FOR SHARE and FOR KEY SHARE

`FOR SHARE` — "I'm reading this row and want it stable, but I don't intend to write it. Block writers from changing it under me." Useful for multi-step reads where consistency matters.

`FOR KEY SHARE` — Postgres takes this automatically when inserting/updating a row that has an FK to another table. You rarely write it explicitly, but understanding it explains why `FOR UPDATE` on a parent row can block child INSERTs.

## SKIP LOCKED and NOWAIT

Two ways to avoid blocking:

    -- Skip rows another session has locked (use for queues)
    SELECT * FROM queue_item
    WHERE status = 'pending'
    ORDER BY scheduled_for
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    -- Error immediately instead of waiting
    SELECT * FROM account WHERE account_no = 42 FOR UPDATE NOWAIT;

`SKIP LOCKED` is the queue-worker idiom — see [Relational Queues](relational-queues.md). `NOWAIT` is useful in UIs where waiting is worse than failing.

## Optimistic Concurrency

For workflows where conflicts are rare and you'd rather fail loudly than serialize, use a version column:

    CREATE TABLE document (
        document_id bigserial PRIMARY KEY,
        body text NOT NULL,
        version integer NOT NULL DEFAULT 1
    );

    -- Modify only if version still matches what we read
    UPDATE document
    SET body = $1, version = version + 1
    WHERE document_id = $2 AND version = $3;

    -- If row count is 0, someone else modified it — surface to caller
    IF NOT FOUND THEN
        RAISE EXCEPTION 'document modified by another writer'
            USING ERRCODE = 'P0013';   -- OPTIMISTIC_LOCK_LOST
    END IF;

No pessimistic lock, no waiting, no deadlock potential. Trade-off: callers may have to retry.

## Advisory Locks

Postgres provides app-level locks identified by integer keys. Use for serializing operations that don't map cleanly to a single row:

    -- Hold for the rest of the transaction
    PERFORM pg_advisory_xact_lock(p_customer_no::bigint);

    -- Acquire and release manually
    PERFORM pg_advisory_lock(42);
    -- ... work ...
    PERFORM pg_advisory_unlock(42);

Use cases:

- **Max-plus-one race prevention** — `pg_advisory_xact_lock(p_parent_no)` serializes ID generation within one parent. See [Hierarchical Composite Keys](hierarchical-keys.md).
- **Named cron-like operations** — only one worker generates today's report.
- **Cross-table coordination** — when row locks aren't enough because the work spans many rows.

`pg_advisory_xact_lock` releases automatically at transaction end. `pg_advisory_lock` requires explicit release — leak-prone, prefer the transaction variant unless you genuinely need session-scoped.

Two-argument form encodes a (classid, objid) pair — useful for namespacing locks:

    -- Lock "operation type 7, target id 42"
    PERFORM pg_advisory_xact_lock(7, 42);

## Deadlocks

A deadlock happens when two transactions wait on each other's locks. Postgres detects them automatically (~1 second timeout) and aborts one with `40P01`. You can catch and retry:

    EXCEPTION WHEN deadlock_detected THEN
        -- log and let caller retry
        RAISE;

**Prevention is better than handling:**

1. **Always acquire locks in the same order.** If transactions touch accounts A and B, both should lock the smaller account_no first. Random order → deadlock.
2. **Acquire all needed locks up front.** Don't grab one, do work, then grab another.
3. **Keep transactions short.** The longer a lock is held, the higher the deadlock chance.

For multi-row updates, sort the IDs first:

    UPDATE account SET balance = balance + 100
    WHERE account_no IN (
        SELECT account_no FROM account WHERE customer_no = 42
        ORDER BY account_no FOR UPDATE
    );

## Isolation Levels (Briefly)

Postgres supports `READ COMMITTED` (default), `REPEATABLE READ`, and `SERIALIZABLE`. For 95% of app workloads, `READ COMMITTED` is correct.

Switch to `SERIALIZABLE` when:

- Multi-statement business invariants must hold (e.g., "total balance across accounts is unchanged after a transfer")
- You want the database to detect serialization anomalies and force retry — simpler than getting locking exactly right

`SERIALIZABLE` may raise `40001` (serialization_failure) on commit; callers must retry. The error is the deal: Postgres guarantees correctness if you retry.

    BEGIN ISOLATION LEVEL SERIALIZABLE;
    -- ... work ...
    COMMIT;   -- may raise 40001

Use selectively — long-running serializable transactions hurt throughput.

# Connection Pooling Caveats


Connection poolers (pgbouncer, PgCat, RDS Proxy) let many app processes share a smaller Postgres connection pool. They have modes that constrain what SQL you can run — if you don't know your mode, you'll hit surprising failures.

## Table of Contents

- [Pooling Modes](#pooling-modes)
- [Session Mode](#session-mode)
- [Transaction Mode](#transaction-mode)
- [Statement Mode](#statement-mode)
- [Implications for RLS](#implications-for-rls)
- [Implications for Prepared Statements](#implications-for-prepared-statements)
- [Choosing a Mode](#choosing-a-mode)
- [Connection Count Math](#connection-count-math)

---

## Pooling Modes

Most poolers offer three modes:

| Mode | Connection lifecycle | What's preserved |
|------|----------------------|------------------|
| Session | Connection held for the full app-session | Everything (`SET`, prepared statements, advisory locks) |
| Transaction | Connection held only for the duration of a transaction | Per-transaction state only |
| Statement | Connection held only for one statement | Nothing across statements |

The mode determines which Postgres features you can rely on across statements.

## Session Mode

The pooler hands a connection to the client for the full session, releases when the client disconnects. Behaves like a direct connection — everything works, but pool sharing is poor: a single long-lived app process holds one connection forever.

Use when:

- You need session-level features: `SET` (not `SET LOCAL`), `LISTEN`/`NOTIFY`, session-scoped advisory locks (`pg_advisory_lock`), server-side cursors, `WITH HOLD` cursors
- Pool sizing isn't constrained (low concurrent connections)

## Transaction Mode

The pooler returns the connection to the pool at COMMIT/ROLLBACK. The same client's next transaction may land on a different physical connection.

**What breaks:**

- **Session `SET`** — `SET timezone = 'UTC'` is lost after COMMIT. Use `SET LOCAL` inside a transaction.
- **Prepared statements** — typically disabled by the pooler in this mode (the next connection doesn't know about your prepared plan).
- **`pg_advisory_lock`** (session-scoped) — lost between transactions. Use `pg_advisory_xact_lock` instead.
- **`LISTEN`/`NOTIFY`** — `LISTEN` is session-scoped, doesn't work in transaction mode.
- **Temporary tables** (`CREATE TEMP TABLE`) — survive across statements only within one transaction; session pool persistence is gone.

**What works:**

- Everything *inside* one transaction
- `SET LOCAL` for the duration of the current transaction
- `pg_advisory_xact_lock`

This is the most common mode in production. Defaults in pgbouncer.

## Statement Mode

Connection released after every statement. Even transactions are effectively single-statement.

**What breaks:**

- Multi-statement transactions — you can't `BEGIN; ...; COMMIT;`
- Everything that requires more than one round trip in sequence

Use only for read-only workloads with no transactions. Rare in app servers; sometimes used for analytics gateways.

## Implications for RLS

The RLS pattern relies on a session variable:

    SET app.user_id = '12345';
    SELECT * FROM customer;   -- RLS filters by current_app_user_id()

In **transaction mode**, this `SET` is lost after every COMMIT. Use `SET LOCAL` inside the transaction:

    BEGIN;
    SET LOCAL app.user_id = '12345';
    SELECT * FROM customer;
    COMMIT;

Or use `set_config(...)` which has the same effect:

    SELECT set_config('app.user_id', '12345', TRUE);   -- TRUE = local to transaction

Either way: the app must set the identity at the *start of every transaction*, not once per connection.

For session-mode pools, set once per checkout and you're fine.

## Implications for Prepared Statements

In transaction mode, most poolers disable prepared statements server-side because the prepared plan lives on a specific connection. Workarounds:

- **Application-side prepared statements that automatically deallocate** — node-postgres, asyncpg can detect connection switches
- **Server-side prepared statements with pooler support** — pgbouncer 1.21+ supports `prepared_statements = 1` in transaction mode
- **Just don't prepare** — the planner caches plans for parameterized queries reasonably well; the win from explicit PREPARE is smaller in Postgres than in some other DBs

If you depend on prepared statements for performance, verify your pooler supports them in your mode.

## Choosing a Mode

| Situation | Mode |
|-----------|------|
| Default production app, transactions, RLS | Transaction mode + `SET LOCAL` |
| App needs `LISTEN/NOTIFY`, session advisory locks, `WITH HOLD` cursors | Session mode |
| Read-only analytics gateway, no transactions | Statement mode |
| Hybrid: app needs session features for one workflow, transaction mode for others | Two pools, two endpoints |

## Connection Count Math

Your DB has a `max_connections` setting (often 100–500). Each connection consumes RAM (a few MB to tens of MB, depending on work_mem) and a backend process.

Pool size budget:

    max_pool_size = (max_connections - reserved) / number_of_app_instances
    -- e.g., 500 connections - 20 reserved for admin / replication
    --       = 480 / 8 app instances = 60 connections per app

With transaction pooling, an app's pool size of 60 supports far more concurrent app requests than 60 — because Postgres connections are only held during the transaction. Right-size based on transaction duration × throughput, not request concurrency.

Most apps over-provision pool size out of habit; profile what you actually need.

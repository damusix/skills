# PostgreSQL LISTEN / NOTIFY

> [!NOTE]
> This file covers the asynchronous notification mechanism (`LISTEN`, `NOTIFY`, `UNLISTEN`, `pg_notify()`, libpq's `PQnotifies` / `PQconsumeInput`). LISTEN/NOTIFY is a **pub/sub primitive**, not a durable message broker or work queue. For durable work-queue patterns built on the queue-table + `FOR UPDATE SKIP LOCKED` model see [`43-locking.md`](./43-locking.md). For change-data-capture across clusters see [`76-logical-decoding.md`](./76-logical-decoding.md). For coordination across sessions via lock identifiers see [`44-advisory-locks.md`](./44-advisory-locks.md).


> [!WARNING] Stable across PG14, PG15, PG16, PG18 — narrow PG17 additions only
> PG14, PG15, PG16, and PG18 each have **zero** LISTEN/NOTIFY release-note items. The protocol surface (`LISTEN`/`NOTIFY`/`UNLISTEN`/`pg_notify`), the 8000-byte payload limit, the delivery-at-commit rule, the duplicate-suppression rule, and the same-database scope have been stable since long before PG14. **PG17 added two configurability GUCs only** — `max_notify_queue_pages` (default `1048576` = 8 GB at 8 kB pages) and `notify_buffers` (default `16` blocks = 128 kB SLRU cache) — both restart-only, both about queue sizing, neither changing semantics. If a tutorial or blog claims a recent PG version made LISTEN/NOTIFY durable, multi-cluster, or larger-payload, verify against the per-major release notes directly — the claim is wrong.


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [LISTEN](#listen)
    - [NOTIFY](#notify)
    - [UNLISTEN](#unlisten)
    - [pg_notify() function form](#pg_notify-function-form)
    - [Delivery semantics](#delivery-semantics)
    - [Ordering guarantees](#ordering-guarantees)
    - [Duplicate suppression](#duplicate-suppression)
    - [Payload size limit](#payload-size-limit)
    - [Transaction interactions](#transaction-interactions)
    - [Two-phase commit incompatibility](#two-phase-commit-incompatibility)
    - [libpq client API](#libpq-client-api)
    - [The notification queue](#the-notification-queue)
    - [Wait events](#wait-events)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Use this file when you are:

- Broadcasting cache-invalidation events across application servers (e.g., "tenant 42's config changed; reload it").
- Waking up worker processes that are blocked waiting for new work in a queue table — the worker uses `LISTEN` for a wakeup signal, then drains the queue with `SELECT ... FOR UPDATE SKIP LOCKED`.
- Implementing real-time push from a database trigger to an application server (notification on `INSERT`, `UPDATE`, `DELETE` via `AFTER ROW` trigger calling `pg_notify`).
- Coordinating between long-running application processes that are all connected to the same PostgreSQL cluster and database.
- Trying to diagnose "I called `NOTIFY` but the listener never received it" — almost always a commit-timing or connect-timing issue (Recipe 11 walks the diagnostic).
- Deciding whether to use LISTEN/NOTIFY at all vs. Kafka/Redis/RabbitMQ/SQS for a given workload.

If you need **durable** delivery (the listener receives the message even if it was offline when the event happened), LISTEN/NOTIFY is the **wrong** tool — use a queue table or an external broker. If you need cross-database or cross-cluster delivery, LISTEN/NOTIFY is also the wrong tool — notifications never cross a database boundary (let alone a cluster boundary).


## Mental Model

Five rules drive almost every LISTEN/NOTIFY decision:

1. **LISTEN/NOTIFY is at-most-once delivery to currently-LISTENing sessions — no persistence, no replay.** A session that is not LISTENing when `NOTIFY` is committed misses the message permanently. There is no replay API, no offset, no "deliver-since". Applications must be prepared to bootstrap their state from the database directly on reconnect, then use LISTEN/NOTIFY only for live updates. Treat it as **a wake-up signal, not a message channel**.

2. **NOTIFY delivers at COMMIT time, not at NOTIFY execution time.** Verbatim: *"if a `NOTIFY` is executed inside a transaction, the notify events are not delivered until and unless the transaction is committed."*[^delivery-at-commit] This is the single most common surprise. A `BEGIN; NOTIFY ch, 'x'; SELECT pg_sleep(60); COMMIT;` will not produce any visible notification for the first 60 seconds. Worse: `BEGIN; NOTIFY ch, 'x'; ROLLBACK;` produces no notification at all — `NOTIFY` follows transaction semantics, unlike session-level advisory locks (see [`44-advisory-locks.md`](./44-advisory-locks.md) Rule 2 for the contrast).

3. **Notifications are scoped to a single database in a single cluster.** Verbatim: *"The `NOTIFY` command sends a notification event together with an optional 'payload' string to each client application that has previously executed `LISTEN channel` for the specified channel name in the current database."*[^notify-current-database] No cross-database delivery in the same cluster. No cross-cluster delivery (no streaming replication of notifications, no logical replication of notifications, no archiving). If your workers connect to a different database than the publisher, they will never see the notifications.

4. **Payload is bounded at 8000 bytes and identical (channel, payload) pairs within one transaction are collapsed to one delivery.** Verbatim: *"In the default configuration it must be shorter than 8000 bytes."*[^payload-limit] Verbatim: *"If the same channel name is signaled multiple times with identical payload strings within the same transaction, only one instance of the notification event is delivered to listeners."*[^duplicate-suppression] **Different** payloads on the same channel are all delivered separately. The duplicate-suppression rule means high-volume "ping" notifications without unique payloads silently lose count.

5. **LISTEN/NOTIFY is not a queue, not a broker, not durable storage.** Missing capabilities: durability (offline listeners miss messages), replay (no offset/cursor), multi-database scope, cross-cluster delivery, payload sizes above 8 KB. If your design needs any of these, the answer is "use Kafka / RabbitMQ / NATS / Redis Streams / SQS / a queue table with SKIP LOCKED", not "wait for PostgreSQL to add it."


## Decision Matrix

| Situation | Use | Avoid | Notes |
|---|---|---|---|
| Real-time cache invalidation across always-connected app servers | LISTEN/NOTIFY on a single channel; app reloads config | Polling the database every N seconds | Recipe 1 is the canonical pattern. Workers must reconnect-and-bootstrap on any disconnect. |
| Wake idle workers blocked on an empty queue table | LISTEN/NOTIFY as a wake-up signal; worker pulls work with `SELECT … FOR UPDATE SKIP LOCKED` | Tight polling loops or LISTEN/NOTIFY carrying the work itself | Work always lives in a table; the notification signals that new work is available. See Recipe 2. |
| Durable message delivery (consumer may be offline) | A queue table + `SKIP LOCKED` consumer ([`43-locking.md`](./43-locking.md) Recipe 4); optionally `pg_notify` for wakeup | LISTEN/NOTIFY alone | Without a queue table the message is gone the instant no one is LISTENing. |
| Cross-database broadcast in the same cluster | An external broker (Redis Pub/Sub, NATS) or logical replication into a shared "events" database | LISTEN/NOTIFY (single-database-only) | The same-database rule is hard. Workers connected to other databases never see your NOTIFY. |
| Cross-cluster broadcast (primary + standbys; data-center A and B) | External broker, or logical decoding ([`76-logical-decoding.md`](./76-logical-decoding.md)) | LISTEN/NOTIFY | Notifications are intra-cluster and do not replicate. |
| Audit / CDC stream to downstream system | Logical decoding with `pgoutput` or `wal2json` | LISTEN/NOTIFY as a CDC primitive | LISTEN/NOTIFY drops events on disconnect; logical decoding has a replication slot that retains WAL. See [`74-logical-replication.md`](./74-logical-replication.md). |
| Trigger-driven push (notify on `INSERT/UPDATE/DELETE`) | `AFTER ROW` trigger calling `pg_notify(channel, row_payload::text)` | Triggers calling `NOTIFY` with literal channel names | The function form `pg_notify(text, text)` accepts non-constant channel names; the `NOTIFY` statement requires a literal channel. Recipe 5. |
| Payload larger than ~7.5 KB | Store the message in a table; NOTIFY a row ID only | Pack everything into the payload | The 8000-byte hard limit is the absolute ceiling — under load you want headroom. Use the database table as the data plane, NOTIFY as the control plane. |
| Channel name needs to be dynamic (computed per row, per tenant) | `pg_notify(channel_text, payload)` | `EXECUTE format('NOTIFY %I, %L', ...)` | The function form is the documented way to use a non-constant channel; format-and-EXECUTE works but is heavier. |
| Need to know "did anyone receive this?" | An app-level RPC or a request/response queue table | Treat LISTEN/NOTIFY as RPC | LISTEN/NOTIFY is fire-and-forget. There is no delivery receipt, no acknowledgment. |
| Need to monitor queue depth or detect a "stuck listener" | `SELECT pg_notification_queue_usage();` and `pg_stat_activity` join | Guessing from connection state | Recipe 9 details the diagnostic. PG17+ also exposes `max_notify_queue_pages` for hard-cap sizing. |

Three smell signals that LISTEN/NOTIFY is the wrong tool:

- **Your design requires durability** ("the consumer was down for 5 minutes; it should still process every event that happened during those 5 minutes"). LISTEN/NOTIFY drops messages for any non-LISTENing session. Move the messages to a queue table.
- **Your payload is approaching 1 KB.** The 8000-byte ceiling is hard. If you are anywhere near it, the design will fail on a slightly larger row. Use the table-stores-data + NOTIFY-the-ID pattern (Recipe 4).
- **You see `pg_notification_queue_usage()` climbing toward 1.0.** A slow consumer is holding the queue back, which can block every other writer's COMMIT once full. Recipe 9 explains the runbook.


## Syntax / Mechanics


### LISTEN

```sql
LISTEN channel
```

Registers the current backend as a listener on the named channel. Verbatim purpose: *"LISTEN — listen for a notification."*[^listen]

Operational properties from the docs:

- **Session-scoped:** *"A session's listen registrations are automatically cleared when the session ends."*[^listen] Disconnect ⇒ registration gone. No persistence across reconnect; the application must re-issue `LISTEN` on every new connection.
- **Commit-bound:** *"LISTEN takes effect at transaction commit. If LISTEN or UNLISTEN is executed within a transaction that later rolls back, the set of notification channels being listened to is unchanged."*[^listen-commit] LISTEN inside a transaction that rolls back does not subscribe.
- **Case-folding:** the channel name follows the normal PostgreSQL identifier rules — case-folded to lower case unless double-quoted. `LISTEN MyChannel` and `LISTEN mychannel` are the same channel; `LISTEN "MyChannel"` is a different channel.
- **No wildcard for LISTEN:** you must name each channel explicitly. (The wildcard `*` exists only for `UNLISTEN`.)

A backend may LISTEN on many channels simultaneously. Each `LISTEN` call adds one channel to the backend's subscription set. Repeated `LISTEN` on the same channel is a no-op.


### NOTIFY

```sql
NOTIFY channel [ , payload ]
```

`channel` must be a literal identifier (use `pg_notify()` for dynamic names — see below). `payload` is an optional string literal.

Verbatim purpose: *"The `NOTIFY` command sends a notification event together with an optional 'payload' string to each client application that has previously executed `LISTEN channel` for the specified channel name in the current database. Notifications are visible to all users."*[^notify]

Note the *"Notifications are visible to all users"* clause — there is no `GRANT` / `REVOKE` for NOTIFY channels. Any role that can connect to the database can send and receive notifications. This is a fact worth surfacing when designing multi-tenant applications: tenant A's NOTIFY on channel `cache_invalidate` is visible to tenant B's LISTENing session. Either use tenant-disambiguated channel names (`cache_invalidate_tenant_42`) or carry the tenant ID in the payload.


### UNLISTEN

```sql
UNLISTEN channel
UNLISTEN *
```

Verbatim purpose: *"UNLISTEN — stop listening for a notification."*[^unlisten]

The wildcard form deregisters everything. Verbatim: *"The special wildcard `*` cancels all listener registrations for the current session."*[^unlisten] This is what application-side disconnect cleanup should call before releasing a connection to a pool.

`UNLISTEN` of a channel the session does not subscribe to is a no-op (no error). Like `LISTEN`, it takes effect at transaction commit.


### pg_notify() function form

```sql
pg_notify(channel text, payload text)
```

Verbatim from the docs: *"To send a notification you can also use the function `pg_notify(text, text)`. The function takes the channel name as the first argument and the payload as the second. The function is much easier to use than the NOTIFY command if you need to work with non-constant channel names and payloads."*[^pg-notify]

The function is the right form for:

- Dynamic channel names: `pg_notify('tenant_' || tenant_id::text, payload)`.
- Trigger bodies that need to construct the channel from row data.
- Application code passing both channel and payload as bind parameters.

Behavior is otherwise identical to the `NOTIFY` statement — same commit-time delivery, same 8000-byte limit, same duplicate-suppression rule. The function is a thin SQL wrapper around the same internal queue write.


### Delivery semantics

Notifications follow these rules, all derived directly from the docs:

1. **Same database only.** *"… in the current database."*[^notify] A session connected to database `app` does not receive notifications sent in database `analytics` in the same cluster.

2. **Delivery at COMMIT.** *"if a `NOTIFY` is executed inside a transaction, the notify events are not delivered until and unless the transaction is committed."*[^delivery-at-commit] Until COMMIT fires, the notification is sitting in the sender's local pending-notify list. After ROLLBACK, the list is discarded silently.

3. **At-most-once to currently-listening sessions.** No persistence, no replay. If a listener disconnects between NOTIFY-at-the-publisher and COMMIT, it misses the message.

4. **Self-notification works.** *"It is common for a client that executes `NOTIFY` to be listening on the same notification channel itself. In that case it will get back a notification event, just like all the other listening sessions."*[^self-notify] This is sometimes useful for "I just made this change; reset my own cache too" patterns, but more often a source of bugs (the worker re-processes the row it just inserted). Apply origin filtering in the application: skip notifications where `be_pid` (sender PID) equals your own connection's PID.

5. **Asynchronous arrival.** Even after COMMIT on the sender, the listener does not see the notification until libpq is asked to consume input — see [libpq client API](#libpq-client-api).


### Ordering guarantees

Verbatim: *"Except for dropping later instances of duplicate notifications, `NOTIFY` guarantees that notifications from the same transaction get delivered in the order they were sent. It is also guaranteed that messages from different transactions are delivered in the order in which the transactions committed."*[^ordering]

Two consequences:

- **Intra-transaction ordering is preserved.** A transaction that issues `NOTIFY ch, '1'; NOTIFY ch, '2'; NOTIFY ch, '3';` delivers them as `'1'`, `'2'`, `'3'` — never reordered.
- **Inter-transaction ordering follows commit order.** If transaction A's COMMIT lands before transaction B's COMMIT, A's notifications arrive at listeners before B's. This is **not** the order in which `NOTIFY` was issued by the senders — it is the order in which the transactions completed COMMIT.

There is no guarantee about the order across **channels** within one transaction. `NOTIFY a, 'x'; NOTIFY b, 'y';` may deliver in either order at the listener.


### Duplicate suppression

Verbatim: *"If the same channel name is signaled multiple times with identical payload strings within the same transaction, only one instance of the notification event is delivered to listeners. On the other hand, notifications with distinct payload strings will always be delivered as distinct notifications."*[^duplicate-suppression]

The (channel, payload) pair is the dedup key. **Within one transaction**:

- `NOTIFY ch, 'x'` then `NOTIFY ch, 'x'` ⇒ one delivery.
- `NOTIFY ch, 'x'` then `NOTIFY ch, 'y'` ⇒ two deliveries.
- `NOTIFY ch1, 'x'` then `NOTIFY ch2, 'x'` ⇒ two deliveries.
- `NOTIFY ch` (no payload) then `NOTIFY ch` (no payload) ⇒ one delivery.

Across transactions, no dedup — every committed transaction's notifications are delivered separately. The dedup window is the transaction.

**Operational consequence:** if your design uses `NOTIFY ch` as a counter ("one notify per row inserted; count them at the listener to track ingestion"), you will silently lose count when the transaction issues many notifications. Either include a unique payload (row id, timestamp) or rely on the table state, not the notify count.


### Payload size limit

Verbatim: *"In the default configuration it must be shorter than 8000 bytes. (If binary data or a large amount of information needs to be communicated, it's best to put it in a database table and send the key of the record.)"*[^payload-limit]

The 8000-byte limit is a hard cap enforced at NOTIFY/pg_notify time — overrunning raises `ERROR: 22023: payload string too long`. There is **no GUC to raise it**; the limit is a compile-time constant (`NAMEDATALEN`-adjacent in source). The docs themselves recommend the table-stores-data pattern (Recipe 4).

Budget no more than ~7000 bytes for the payload to keep clear of the limit for multi-byte UTF-8 characters. Payloads at or near the limit are an architectural smell — move the data to a row and notify the ID.


### Transaction interactions

Both LISTEN and NOTIFY are transactional in the sense that their effects materialize only at COMMIT:

- **LISTEN inside ROLLBACK ⇒ no subscription.** *"If LISTEN or UNLISTEN is executed within a transaction that later rolls back, the set of notification channels being listened to is unchanged."*[^listen-commit] The same applies to UNLISTEN.
- **NOTIFY inside ROLLBACK ⇒ no delivery.** This is the right behavior — you don't want to advertise changes that didn't happen.
- **Auto-commit semantics.** A bare `NOTIFY` outside an explicit transaction commits as its own implicit transaction, so the notification fires within milliseconds. This is the form most application code uses for stateless `pg_notify` calls.

**Critical operational rule:** if your application uses long-running transactions (a 30-minute report transaction with `NOTIFY progress, '50%'` along the way), **no one receives the in-flight progress notifications**. They all batch at the final COMMIT. To get progress streaming, either commit the progress updates as their own transactions (use `pg_notify` outside the long transaction's transaction block via a separate connection / autonomous transaction equivalent), or use a status table that listeners poll.


### Two-phase commit incompatibility

Verbatim: *"A transaction that has executed LISTEN cannot be prepared for two-phase commit."*[^listen-2pc]

This is the same restriction that applies to temp tables, cursors `WITH HOLD`, and a few other session-state surfaces — see [`41-transactions.md`](./41-transactions.md) gotcha #17. If your application uses `PREPARE TRANSACTION` (a federated-write protocol with an external transaction manager), the transactions that issue `PREPARE` cannot also issue `LISTEN`. Use a separate connection for LISTEN duties.


### libpq client API

Listeners do not receive notifications synchronously. The libpq client API exposes them through:

| Function | Verbatim signature & purpose |
|---|---|
| `PQnotifies` | `PGnotify *PQnotifies(PGconn *conn);` — *"returns the next notification from a list of unhandled notification messages received from the server. It returns a null pointer if there are no pending notifications. Once a notification is returned from `PQnotifies`, it is considered handled and will be removed from the list of notifications."*[^pqnotifies] |
| `PQconsumeInput` | Fills libpq's internal buffer from the socket without blocking. The recommended pattern: call `PQconsumeInput`, then loop `PQnotifies` until it returns NULL. |
| `PQsocket` | Returns the file descriptor of the connection so the application can `select()` / `poll()` / `epoll()` on it and block efficiently until either query results or notifications arrive. |

The returned `PGnotify` struct is `{ char *relname; int be_pid; char *extra; }` — `relname` is the channel, `be_pid` is the sending backend's PID, `extra` is the payload string. Verbatim memory rule: *"After processing a `PGnotify` object returned by `PQnotifies`, be sure to free it with `PQfreemem`."*[^pqnotifies]

Verbatim recommended pattern from the docs: *"A better way to check for `NOTIFY` messages when you have no useful commands to execute is to call `PQconsumeInput`, then check `PQnotifies`. You can use `select()` to wait for data to arrive from the server, thereby using no CPU power unless there is something to do."*[^pqnotifies]

Higher-level drivers (psycopg, asyncpg, JDBC, node-postgres) wrap these primitives — the application normally registers a callback or awaits a `notifications()` iterator. Recipe 6 shows the psycopg pattern.


### The notification queue

Notifications live in a server-wide SLRU on disk (the `pg_notify/` directory), plus an in-memory cache (`notify_buffers`). Each backend's pending-but-uncommitted notifications live in process-local memory until COMMIT, at which point they are flushed into the shared queue. Listeners advance their own read pointer through the queue as they consume notifications.

Three GUCs are relevant (the last two are PG17+):

| GUC | Default | Context | Purpose |
|---|---|---|---|
| (queue size) | — | — | Pre-PG17 the queue was effectively unbounded by GUC; in practice limited by disk. |
| `max_notify_queue_pages` | `1048576` (PG17+) | server-start | *"Specifies the maximum amount of allocated pages for NOTIFY / LISTEN queue. The default value is 1048576. For 8 KB pages it allows to consume up to 8 GB of disk space."*[^max-notify-pages] |
| `notify_buffers` | `16` (PG17+) | server-start | *"Specifies the amount of shared memory to use to cache the contents of `pg_notify`. If this value is specified without units, it is taken as blocks, that is BLCKSZ bytes, typically 8kB. The default value is 16."*[^notify-buffers] |

> [!NOTE] PostgreSQL 17
> Both `max_notify_queue_pages` and `notify_buffers` were added in PG17 as part of the broader SLRU-cache configurability work. Verbatim from the PG17 release notes: *"Allow the SLRU cache sizes to be configured (Andrey Borodin, Dilip Kumar, Alvaro Herrera). The new server variables are commit_timestamp_buffers, multixact_member_buffers, multixact_offset_buffers, notify_buffers, serializable_buffers, subtransaction_buffers, and transaction_buffers."*[^pg17-slru] Pre-PG17 the queue's cache size was fixed in source; there was no way to tune it from `postgresql.conf`.

**Backpressure rule:** if the queue fills (one or more listeners is far behind and the queue cannot advance), `NOTIFY` calls on **other** sessions begin to block. This is the canonical "stuck listener jams the whole cluster" failure mode. The diagnostic is `pg_notification_queue_usage()` returning a fraction close to 1.0; the fix is to either kick the stuck listener (cancel/terminate the backend) or raise `max_notify_queue_pages` on PG17+ to buy time. Recipe 9 walks the runbook.

The function `pg_notification_queue_usage()` reports the fraction in `[0.0, 1.0]`:

```sql
SELECT pg_notification_queue_usage();
```

Verbatim: *"Returns the fraction (0–1) of the asynchronous notification queue's maximum size that is currently occupied by notifications that are waiting to be processed."*[^queue-usage]


### Wait events

Backends waiting for queue-internal coordination appear in `pg_stat_activity` with `wait_event_type = 'LWLock'` and one of four `wait_event` values:

| `wait_event` | Verbatim description[^wait-events] |
|---|---|
| `NotifyBuffer` | *"Waiting for I/O on a NOTIFY message SLRU buffer."* |
| `NotifyQueue` | *"Waiting to read or update NOTIFY messages."* |
| `NotifyQueueTail` | *"Waiting to update limit on NOTIFY message storage."* |
| `NotifySLRU` | *"Waiting to access the NOTIFY message SLRU cache."* |

A sustained presence of these wait events on many backends signals either a hot notification workload (many publishers competing on the SLRU) or a stuck listener pinning the queue tail. They are LWLock-typed (low-level lightweight locks), not table-level Lock waits — see [`43-locking.md`](./43-locking.md) for the broader wait-event taxonomy.


### Per-version timeline

| Version | LISTEN/NOTIFY changes |
|---|---|
| PG14 | **Zero** LISTEN/NOTIFY release-note items. Surface stable. |
| PG15 | **Zero** LISTEN/NOTIFY release-note items. Surface stable. |
| PG16 | **Zero** LISTEN/NOTIFY release-note items. Surface stable. |
| PG17 | `notify_buffers` GUC (SLRU cache size, default 16 blocks = 128 kB); `max_notify_queue_pages` GUC (max queue disk, default 1048576 pages = 8 GB).[^pg17-slru] Both restart-only. No protocol or semantic changes. |
| PG18 | **Zero** LISTEN/NOTIFY release-note items. Surface stable. |

If a tutorial claims a recent PG version made NOTIFY durable, raised the 8000-byte payload limit, added wildcard channel patterns, added cross-database delivery, or added an acknowledgment protocol — none of those have happened. Verify against the verbatim release notes (`https://www.postgresql.org/docs/release/<N>/`) before believing the claim.


## Examples / Recipes


### Recipe 1: Cache invalidation broadcast (the canonical pattern)

Application servers each maintain an in-memory cache of tenant configurations. When a tenant config row changes, every server must reload it within seconds. The publisher commits the row update and fires a notification carrying the tenant ID; every listener reloads on receipt.

```sql
-- Publisher (web request that updates a tenant config)
BEGIN;
UPDATE tenant_config SET value = $1 WHERE tenant_id = $2;
SELECT pg_notify('tenant_config_changed', $2::text);  -- payload is the tenant_id
COMMIT;
```

Each application server, at startup and after every reconnect:

```sql
LISTEN tenant_config_changed;
```

On notification, the worker reloads the named tenant's config from `tenant_config`. **Key bootstrap step:** on every fresh connection, the worker re-reads the entire `tenant_config` table to recover from any notifications missed while disconnected (Rule 1: at-most-once-while-LISTENing, no replay).

Why this works: the publisher commits the change before the notification fires (delivery-at-commit), so any listener that receives the notification can safely read the new value. The payload is small (a tenant ID) and the channel is single-database-scoped (all app servers connect to the same database).


### Recipe 2: Wake a worker queue (NOTIFY as a doorbell)

A worker process consumes from a `job_queue` table using `SELECT … FOR UPDATE SKIP LOCKED` (see [`43-locking.md`](./43-locking.md) Recipe 4). It blocks on LISTEN for the wake-up channel between empty-queue checks, instead of polling tight-loop.

Publisher (job submission):

```sql
INSERT INTO job_queue (payload) VALUES ($1);
SELECT pg_notify('job_queue', '');  -- empty payload, just a wakeup
```

Worker pseudo-code:

```sql
LISTEN job_queue;
```

Then loop:

1. Try to claim a job: `SELECT id FROM job_queue WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`.
2. If found: process and update status; loop.
3. If not found: block on libpq notification arrival (with a timeout — e.g., 30 seconds) and loop.

Even if the worker misses a notification (disconnect, transient), the next empty-queue check or the timed wakeup will catch the job. The work always lives in the table. Recipe 4 of [`43-locking.md`](./43-locking.md) covers the `SKIP LOCKED` queue-table consumer pattern in detail.


### Recipe 3: Trigger-driven notification on INSERT

An `AFTER INSERT` row-level trigger fires `pg_notify` for every new row, carrying the row's primary key.

```sql
CREATE OR REPLACE FUNCTION notify_audit_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('audit_event', NEW.id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_notify
AFTER INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION notify_audit_event();
```

Listeners receive one notification per row. Note that an INSERT of 1000 rows in one transaction fires 1000 trigger executions, which queue 1000 notifications, which all deliver at the same COMMIT. The duplicate-suppression rule only applies to identical (channel, payload) pairs — different row IDs are different payloads, so all 1000 deliver. This can flood listeners; the alternative is a `FOR EACH STATEMENT` trigger that notifies once per statement, using transition tables to convey the changed row set (see [`39-triggers.md`](./39-triggers.md) Recipe 4 for the transition-table pattern).


### Recipe 4: NOTIFY a row ID, not the data (the 8 KB workaround)

A change event includes a large JSON payload (say, 50 KB of audit data) that cannot fit in NOTIFY's 8000-byte ceiling. Store the change in a table, NOTIFY the row's ID, let listeners read the data on demand.

```sql
CREATE TABLE change_events (
    id      bigserial PRIMARY KEY,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Publisher
WITH inserted AS (
    INSERT INTO change_events (payload) VALUES ($1::jsonb)
    RETURNING id
)
SELECT pg_notify('change_event', id::text) FROM inserted;
```

Listener: receive the notification, parse the payload as the integer ID, `SELECT payload FROM change_events WHERE id = $1`. The application-side retention policy (e.g., `DELETE FROM change_events WHERE created_at < now() - interval '7 days'` from a `pg_cron` job — see [`98-pg-cron.md`](./98-pg-cron.md)) prevents unbounded growth.

This pattern also solves the at-most-once-while-LISTENing problem partially: a listener that disconnects and reconnects can read missed `change_events` rows by ID range from the last seen ID, gaining a poor-man's replay. Combine with a `last_processed_id` checkpoint per listener (stored in a separate `listener_state` table) for full reliability.


### Recipe 5: Dynamic channel name via pg_notify()

A multi-tenant audit trigger needs per-tenant channel names so each tenant's listeners receive only their own events.

```sql
CREATE OR REPLACE FUNCTION notify_per_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('tenant_' || NEW.tenant_id::text, NEW.id::text);
    RETURN NEW;
END;
$$;
```

Tenant-42's listener does `LISTEN tenant_42;` and receives only its own events.

**Anti-pattern note:** doing this with `EXECUTE format('NOTIFY %I, %L', ...)` is unnecessarily heavy and rebuilds a plan on every call. The `pg_notify()` function form is the documented way to construct channel names at runtime.

**Multi-tenant security warning:** see gotcha #6 — there are no privileges on NOTIFY channels. Any role with database connect rights can LISTEN to `tenant_42`. Use the payload to carry a tenant-bound authentication signal if confidentiality matters.


### Recipe 6: Listener in Python with psycopg

```python
import psycopg
import select

with psycopg.connect("postgresql://app@host/db", autocommit=True) as conn:
    conn.execute("LISTEN tenant_config_changed")
    while True:
        # Block until socket has data, with a timeout
        select.select([conn], [], [], 30.0)
        conn.execute("SELECT 1")  # Forces poll; psycopg surfaces notifies
        for notify in conn.notifies():
            print(f"channel={notify.channel} pid={notify.pid} payload={notify.payload}")
```

Key points:

- `autocommit=True` is required because LISTEN takes effect at commit; in autocommit mode every statement commits immediately.
- `select.select([conn], …, timeout)` blocks efficiently on the socket — no CPU spin.
- After `select` returns, call any query (or psycopg's `conn.notifies()` iterator after a poll) to make psycopg consume the input and surface notifications.
- The worker reconnects on socket error and re-issues `LISTEN`. **Always re-bootstrap state from the database on reconnect** — see Rule 1.

Asyncio / asyncpg equivalent:

```python
import asyncpg
async def listen():
    conn = await asyncpg.connect("...")
    await conn.add_listener("tenant_config_changed", on_notify)

def on_notify(conn, pid, channel, payload):
    print(channel, payload)
```

asyncpg's `add_listener` registers a callback and handles the underlying LISTEN + libpq consumption in its event loop.


### Recipe 7: UNLISTEN before returning to a connection pool

Connection poolers (especially session-mode pgBouncer) hand out reused backend connections. If a previous user left a `LISTEN` registration on the connection, the next user receives that user's notifications. The cleanup convention:

```sql
-- Application "release-to-pool" hook
UNLISTEN *;
```

This deregisters every channel the connection was subscribed to. Issue it before returning the connection to the pool, or rely on pgBouncer's `server_reset_query` (default `DISCARD ALL` since pgBouncer 1.5+ handles this — verify your version's config) which calls `UNLISTEN *` among other resets. See [`81-pgbouncer.md`](./81-pgbouncer.md) for pool-mode interaction.

**Transaction-mode pgBouncer caveat:** LISTEN is incompatible with transaction-mode pooling. Each transaction releases the connection back to the pool, and the LISTEN registration is on a different backend each time. Use a dedicated direct connection (not via pgBouncer) for LISTENing workers, or use session-mode pooling with `server_reset_query = 'DISCARD ALL'`.


### Recipe 8: Self-notification filtering

The application server that performs an INSERT may not want to react to its own notification (it already knows about the change). Filter on the sending backend's PID:

```python
my_pid = conn.info.backend_pid  # libpq's PQbackendPID
for notify in conn.notifies():
    if notify.pid == my_pid:
        continue  # skip our own
    process(notify)
```

The `be_pid` field in libpq's `PGnotify` struct (psycopg exposes as `.pid`) is the sender's backend PID. Self-notification was documented earlier; this is the canonical way to suppress it without changing the publisher.


### Recipe 9: Diagnose a stuck notification queue

Symptom: `pg_notify` or `NOTIFY` statements start blocking on `wait_event = NotifyQueue` or COMMITs stall. The queue is filling because a listener is not consuming.

```sql
-- 1. Check current queue usage
SELECT pg_notification_queue_usage() AS pct_full;
-- > 0.9 is a strong signal

-- 2. Find listeners and their state
SELECT
    pid,
    application_name,
    state,
    wait_event_type,
    wait_event,
    state_change,
    now() - state_change AS idle_for,
    query
FROM pg_stat_activity
WHERE state IN ('idle', 'idle in transaction')
  AND backend_type = 'client backend'
ORDER BY state_change ASC;

-- 3. Find LISTENing backends specifically (PG-version-dependent)
--    On PG 9.6+ pg_listening_channels() returns this for the current session;
--    cluster-wide visibility requires inspecting pg_stat_activity for
--    backends whose recent queries included LISTEN.
```

If a backend appears `idle` and has not made progress for hours, it is likely a stuck or hung consumer. Recovery options:

1. **Cancel the stuck backend:** `SELECT pg_cancel_backend(<pid>);` — cooperative, may not work if the backend is wedged.
2. **Terminate the stuck backend:** `SELECT pg_terminate_backend(<pid>);` — nuclear option, forces disconnect. The disconnect auto-UNLISTENs the orphaned subscription, freeing the queue tail.
3. **PG17+ only:** raise `max_notify_queue_pages` to buy time (server restart required).

Prevention: every listening application should have a watchdog that kills its own connection after N minutes of no activity, or use a separate fast-fail connection for LISTEN with idle-session timeouts (see [`41-transactions.md`](./41-transactions.md) Recipe 1 for `idle_session_timeout`).


### Recipe 10: Audit current listeners and channels in this session

```sql
SELECT pg_listening_channels();
```

Returns one row per channel the current session is LISTENing on. Useful for testing trigger logic, verifying that a session's subscription set matches expectations, or debugging "I called LISTEN but it doesn't seem to receive." This function exists since PG 9.6.


### Recipe 11: Diagnose "I called NOTIFY but no one received it"

Five-step decision tree:

1. **Are you inside a transaction that hasn't committed yet?** Most common case. `BEGIN; NOTIFY ch, 'x';` and then leaving the transaction open delivers nothing until COMMIT. Either commit explicitly or run the `NOTIFY` outside any explicit `BEGIN`.

2. **Did the transaction COMMIT, not ROLLBACK?** A `NOTIFY` inside a rolled-back transaction is silently discarded.

3. **Is the listener in the same database as the sender?** Same-cluster-different-database means no delivery. Check both with `SELECT current_database();` on each connection.

4. **Was the listener actually LISTENing at COMMIT time?** A listener that connected and called LISTEN **after** your COMMIT will not see that committed notification — no replay. Bootstrap your application logic to rebuild state from the database on every connect.

5. **Is the listener's libpq actually consuming input?** A listener that just sits in `select()` without ever calling `PQconsumeInput` / running a query / iterating its notify queue will not receive notifications even though they are queued on the socket. Most higher-level drivers handle this automatically; raw libpq code may not.

If all five check out, look at `pg_stat_activity` for the LISTENing PID and check `wait_event` — if it shows `ClientRead` (idle, waiting for client), the notification is on the socket and the client just hasn't drained it.


### Recipe 12: Configure queue size on PG17+

For a write-heavy NOTIFY workload — e.g., a trigger fires `pg_notify` on every row INSERT in a high-cardinality table — the default 8 GB queue cap is generous, but the default 128 kB SLRU cache may not be. Tune both at server start:

```ini
# postgresql.conf — restart required
notify_buffers = 64           # 64 blocks × 8 kB = 512 kB SLRU cache
max_notify_queue_pages = 1048576  # default; raise only if you measure actual fills
```

Verify after restart:

```sql
SHOW notify_buffers;
SHOW max_notify_queue_pages;
```

Both GUCs are server-start-only — they cannot be set per-session, per-role, or with `ALTER SYSTEM` and a reload.


### Recipe 13: NOTIFY from a deferred constraint trigger

A constraint trigger that fires at COMMIT (`DEFERRABLE INITIALLY DEFERRED`) is a clean way to consolidate notifications: instead of one notify per row in a batch, fire one summary notify after the constraint pass.

```sql
CREATE TABLE audit_changes (id bigserial PRIMARY KEY, table_name text, change_count int);

CREATE OR REPLACE FUNCTION summarize_and_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'audit_summary',
        json_build_object(
            'table', TG_TABLE_NAME,
            'rows_changed', (SELECT count(*) FROM new_rows)
        )::text
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER summary_after_statement
AFTER INSERT ON audit_changes
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION summarize_and_notify();
```

The `FOR EACH STATEMENT` trigger with a transition table (`REFERENCING NEW TABLE AS new_rows`) fires once per statement and can summarize the changed set in a single payload — avoiding the row-flood pattern from Recipe 3. See [`39-triggers.md`](./39-triggers.md) Recipe 4 for transition-table mechanics.


## Gotchas / Anti-patterns

1. **NOTIFY inside `BEGIN` ... `COMMIT` does not deliver until COMMIT.** This is the verbatim docs rule and the #1 source of "my listener isn't getting messages" tickets. A long-running transaction batches every `NOTIFY` until its COMMIT.

2. **NOTIFY inside ROLLBACK is silently discarded.** No error, no log, just no delivery. This is correct behavior (don't advertise reverted changes) but combined with #1 it means a listener can miss notifications and never know why.

3. **No persistence, no replay.** A listener that disconnects between the sender's COMMIT and the listener's `PQnotifies` call misses the message. There is no offset, cursor, or "deliver since timestamp" API. Designs must bootstrap state from the database on every reconnect and treat LISTEN/NOTIFY as live-only.

4. **8000-byte hard limit on payload.** No GUC raises it; the limit is a compile-time constant. Overruns produce `ERROR: payload string too long` at the `NOTIFY`/`pg_notify` site. Architect with headroom — never approach the ceiling.

5. **Duplicate (channel, payload) within one transaction are collapsed to one delivery.** Verbatim docs rule. Counter-style use ("one NOTIFY per event, count at the listener") silently undercounts within a transaction. Either include a unique payload or rely on table state, not notify count.

6. **No privileges or RLS on channels.** Verbatim: *"Notifications are visible to all users."* Any role with `CONNECT` on the database can LISTEN to any channel. Channel names are an open namespace. For multi-tenant isolation, use tenant-disambiguated channel names AND carry an auth/integrity signal in the payload, OR don't put confidential data in the payload at all.

7. **Same-database scope only.** A notification in database `app` is invisible to a listener in database `analytics` on the same cluster. There is no cross-database delivery. Workers that connect to a different database than the publisher will silently never receive.

8. **No cross-cluster delivery.** Notifications are not replicated by streaming replication, not exposed by logical decoding, and not durable in any backup. Cross-cluster propagation needs an external broker or logical replication of a queue table.

9. **LISTEN/NOTIFY is not a queue.** Treating it as one (relying on "the message must be received") will lose data the first time a listener disconnects. Always pair with a queue table for durability and use NOTIFY only as a wakeup signal.

10. **Channel names follow identifier case-folding rules.** `LISTEN MyChannel` becomes `mychannel`; `LISTEN "MyChannel"` stays `MyChannel`. Mixing the quoted and unquoted forms across publisher and listener results in silently never matching. Pick one (lowercase, unquoted is the convention).

11. **`LISTEN` then `PREPARE TRANSACTION` is illegal.** Verbatim: *"A transaction that has executed LISTEN cannot be prepared for two-phase commit."* If your app uses 2PC across databases, do LISTEN on a separate connection.

12. **Long-running transactions delay in-flight progress notifications.** A 30-minute transaction issuing `NOTIFY progress, '50%'` etc. delivers them all in a burst at the final COMMIT — useless for live progress. Use autonomous-transaction-style writes (separate connection, separate transaction) for live status.

13. **Stuck listener can jam the whole cluster's notify pipeline.** When `pg_notification_queue_usage()` approaches 1.0, new `NOTIFY` calls block on `NotifyQueue` LWLock. Mitigation: kick the stuck backend with `pg_terminate_backend` or, on PG17+, temporarily raise `max_notify_queue_pages` and restart.

14. **Transaction-mode pgBouncer is incompatible with LISTEN.** Session state including LISTEN registrations is lost between transactions in transaction-mode pooling. LISTENing workers must use direct connections or session-mode pooling with `server_reset_query`.

15. **Self-notification arrives in the publishing session.** A backend that does `LISTEN ch; NOTIFY ch, 'x';` receives its own notification. Filter on `pg_backend_pid()` vs the notification's `be_pid` if this is unwanted.

16. **Listeners must re-LISTEN on every reconnect.** LISTEN registrations die with the session. Application code that connects-and-stays-connected often forgets that connection pools or transient errors trigger reconnects that silently drop LISTENs.

17. **`UNLISTEN` of an unsubscribed channel is silent.** No error, no warning. Misnamed channels in `UNLISTEN` calls fail silently.

18. **No timeout, no error on payload overflow at the listener.** The 8000-byte limit is enforced at the publisher. There is no listener-side hint that earlier payloads were dropped due to a stuck queue or that anything is wrong — the listener just doesn't see them.

19. **`pg_notify` is a regular SQL function — it can be called from inside SELECT queries.** This is mostly fine but means a trigger-side `pg_notify` runs once per row of the trigger's invocation; combined with statement triggers using transition tables this can produce surprising fan-out. See Recipe 3 vs Recipe 13.

20. **Notification ordering is by transaction commit order across senders, not by `NOTIFY`-issue order.** Two senders issuing `NOTIFY` in some order may have their notifications delivered in the opposite order if their COMMITs land in the opposite order. Designs that need cross-publisher ordering must serialize through a queue table.

21. **Pre-PG17 the queue had no GUC-tunable size.** Operators on PG14/15/16 cannot raise the cap to handle a temporary stuck listener; the only remedy is to kick the listener. Plan operationally for fast detection.

22. **The `notify_buffers` SLRU cache is small by default (128 kB).** A heavy notify workload can cause cache misses on the SLRU, surfacing as `NotifyBuffer` / `NotifySLRU` LWLock waits. On PG17+ raise `notify_buffers` after measuring the wait events; on pre-PG17 there is no tuning knob.

23. **Notify channels are unbounded — there is no `CREATE CHANNEL` or `DROP CHANNEL`.** Any string is a valid channel name. There is no catalog enumerating "the channels in use" beyond inspecting `pg_listening_channels()` per active session. Documenting the channel taxonomy is the application's responsibility.


## See Also

- [`41-transactions.md`](./41-transactions.md) — BEGIN/COMMIT/ROLLBACK semantics; idle_in_transaction_session_timeout for stuck listeners; the LISTEN-cannot-be-2PC restriction (gotcha #17).
- [`43-locking.md`](./43-locking.md) — Queue tables with `FOR UPDATE SKIP LOCKED` for durable work delivery; the canonical Recipe 4 for queue-table consumers.
- [`44-advisory-locks.md`](./44-advisory-locks.md) — Cooperative coordination locks; contrast with NOTIFY for session-singleton patterns. Note that advisory locks do NOT follow transaction semantics (Rule 2 there), while NOTIFY does (Rule 2 here).
- [`39-triggers.md`](./39-triggers.md) — `AFTER ROW` and `AFTER STATEMENT` triggers calling `pg_notify`; transition tables for set-based notifications.
- [`74-logical-replication.md`](./74-logical-replication.md) — Cross-cluster propagation of row changes (the durable alternative to LISTEN/NOTIFY when you need cross-cluster delivery).
- [`76-logical-decoding.md`](./76-logical-decoding.md) — Replication-slot-based change feed (the durable alternative for CDC patterns).
- [`81-pgbouncer.md`](./81-pgbouncer.md) — Pool-mode interaction with LISTEN; transaction-mode incompatibility.
- [`82-monitoring.md`](./82-monitoring.md) — Monitoring `pg_notification_queue_usage`, `NotifyQueue` wait events, and stuck-listener detection.
- [`98-pg-cron.md`](./98-pg-cron.md) — Scheduling cleanup jobs for `change_events`-style tables that pair with NOTIFY-the-ID patterns (Recipe 4).
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — Cross-cutting recipes including LISTEN/NOTIFY paired with queue tables.
- [`53-server-configuration.md`](./53-server-configuration.md) — `max_notify_queue_pages` and `notify_buffers` restart-only GUCs that govern the notification queue size.


## Sources

[^listen]: PostgreSQL 16 docs, `LISTEN`: "LISTEN — listen for a notification" and "A session's listen registrations are automatically cleared when the session ends." https://www.postgresql.org/docs/16/sql-listen.html
[^listen-commit]: PostgreSQL 16 docs, `LISTEN`: "LISTEN takes effect at transaction commit. If LISTEN or UNLISTEN is executed within a transaction that later rolls back, the set of notification channels being listened to is unchanged." https://www.postgresql.org/docs/16/sql-listen.html
[^listen-2pc]: PostgreSQL 16 docs, `LISTEN`: "A transaction that has executed LISTEN cannot be prepared for two-phase commit." https://www.postgresql.org/docs/16/sql-listen.html
[^notify]: PostgreSQL 16 docs, `NOTIFY`: "The `NOTIFY` command sends a notification event together with an optional 'payload' string to each client application that has previously executed `LISTEN channel` for the specified channel name in the current database. Notifications are visible to all users." https://www.postgresql.org/docs/16/sql-notify.html
[^delivery-at-commit]: PostgreSQL 16 docs, `NOTIFY`: "Firstly, if a `NOTIFY` is executed inside a transaction, the notify events are not delivered until and unless the transaction is committed." https://www.postgresql.org/docs/16/sql-notify.html
[^notify-current-database]: PostgreSQL 16 docs, `NOTIFY`: "… in the current database." https://www.postgresql.org/docs/16/sql-notify.html
[^payload-limit]: PostgreSQL 16 docs, `NOTIFY`: "In the default configuration it must be shorter than 8000 bytes. (If binary data or a large amount of information needs to be communicated, it's best to put it in a database table and send the key of the record.)" https://www.postgresql.org/docs/16/sql-notify.html
[^duplicate-suppression]: PostgreSQL 16 docs, `NOTIFY`: "If the same channel name is signaled multiple times with identical payload strings within the same transaction, only one instance of the notification event is delivered to listeners. On the other hand, notifications with distinct payload strings will always be delivered as distinct notifications." https://www.postgresql.org/docs/16/sql-notify.html
[^ordering]: PostgreSQL 16 docs, `NOTIFY`: "Except for dropping later instances of duplicate notifications, `NOTIFY` guarantees that notifications from the same transaction get delivered in the order they were sent. It is also guaranteed that messages from different transactions are delivered in the order in which the transactions committed." https://www.postgresql.org/docs/16/sql-notify.html
[^self-notify]: PostgreSQL 16 docs, `NOTIFY`: "It is common for a client that executes `NOTIFY` to be listening on the same notification channel itself. In that case it will get back a notification event, just like all the other listening sessions." https://www.postgresql.org/docs/16/sql-notify.html
[^pg-notify]: PostgreSQL 16 docs, `NOTIFY`: "To send a notification you can also use the function `pg_notify(text, text)`. The function takes the channel name as the first argument and the payload as the second. The function is much easier to use than the NOTIFY command if you need to work with non-constant channel names and payloads." https://www.postgresql.org/docs/16/sql-notify.html
[^unlisten]: PostgreSQL 16 docs, `UNLISTEN`: "UNLISTEN — stop listening for a notification" and "The special wildcard `*` cancels all listener registrations for the current session." https://www.postgresql.org/docs/16/sql-unlisten.html
[^pqnotifies]: PostgreSQL 16 docs, libpq async notifications: "The function `PQnotifies` returns the next notification from a list of unhandled notification messages received from the server. It returns a null pointer if there are no pending notifications. Once a notification is returned from `PQnotifies`, it is considered handled and will be removed from the list of notifications." and "After processing a `PGnotify` object returned by `PQnotifies`, be sure to free it with `PQfreemem`." and "A better way to check for `NOTIFY` messages when you have no useful commands to execute is to call `PQconsumeInput`, then check `PQnotifies`. You can use `select()` to wait for data to arrive from the server, thereby using no CPU power unless there is something to do." https://www.postgresql.org/docs/16/libpq-notify.html
[^queue-usage]: PostgreSQL 16 docs, Session Information Functions: "pg_notification_queue_usage () → double precision — Returns the fraction (0–1) of the asynchronous notification queue's maximum size that is currently occupied by notifications that are waiting to be processed." https://www.postgresql.org/docs/16/functions-info.html
[^max-notify-pages]: PostgreSQL 17 docs, runtime-config (Disk): "Specifies the maximum amount of allocated pages for NOTIFY / LISTEN queue. The default value is 1048576. For 8 KB pages it allows to consume up to 8 GB of disk space. This parameter can only be set at server start." https://www.postgresql.org/docs/17/runtime-config-resource.html
[^notify-buffers]: PostgreSQL 17 docs, runtime-config (Resource Consumption): "Specifies the amount of shared memory to use to cache the contents of `pg_notify` (see Table 65.1). If this value is specified without units, it is taken as blocks, that is BLCKSZ bytes, typically 8kB. The default value is 16. This parameter can only be set at server start." https://www.postgresql.org/docs/17/runtime-config-resource.html
[^pg17-slru]: PostgreSQL 17 release notes: "Allow the SLRU cache sizes to be configured (Andrey Borodin, Dilip Kumar, Alvaro Herrera). The new server variables are commit_timestamp_buffers, multixact_member_buffers, multixact_offset_buffers, notify_buffers, serializable_buffers, subtransaction_buffers, and transaction_buffers. commit_timestamp_buffers, transaction_buffers, and subtransaction_buffers scale up automatically with shared_buffers." https://www.postgresql.org/docs/release/17.0/
[^wait-events]: PostgreSQL 16 docs, Monitoring Database Activity, Table 28.12 wait_event Description: "NotifyBuffer — Waiting for I/O on a NOTIFY message SLRU buffer." "NotifyQueue — Waiting to read or update NOTIFY messages." "NotifyQueueTail — Waiting to update limit on NOTIFY message storage." "NotifySLRU — Waiting to access the NOTIFY message SLRU cache." https://www.postgresql.org/docs/16/monitoring-stats.html

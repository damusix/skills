# pgmq — Message Queues in PostgreSQL

`pgmq` extension. SQS-style message queues stored in ordinary Postgres tables: `send` writes a JSONB message, `read` hides it from other consumers for a visibility timeout, and `delete` or `archive` acknowledges it. Pure PL/pgSQL, no background worker, no `shared_preload_libraries`. Latest version **1.13.1** (2026-10-20). PostgreSQL License, maintained by the `pgmq` GitHub org (originally Tembo). External extension — not in core PostgreSQL.[^1][^2]

> [!NOTE] Version support
> Upstream states "Supported on Postgres 14-18." CI tests 13–18; Docker images exist for 14–18. PG19 is not mentioned upstream.[^1]

## Table of Contents

- [When to Use](#when-to-use)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Installation](#installation)
    - [Storage Model](#storage-model)
    - [Message Record](#message-record)
    - [Queue Lifecycle](#queue-lifecycle)
    - [Sending](#sending)
    - [Reading and the Visibility Timeout](#reading-and-the-visibility-timeout)
    - [Acknowledging: delete vs archive](#acknowledging-delete-vs-archive)
    - [FIFO Groups (1.9.0+)](#fifo-groups-190)
    - [Topic Routing (1.11.0+)](#topic-routing-1110)
    - [Insert Notifications](#insert-notifications)
    - [Partitioned Queues](#partitioned-queues)
    - [Monitoring](#monitoring)
- [Delivery Semantics](#delivery-semantics)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use

Background jobs, outbox delivery, webhook dispatch, and work distribution where the producer already writes to Postgres and you want the enqueue to commit or roll back with the business write. Moderate throughput where an extra broker (SQS, RabbitMQ, Kafka) would cost more to run than it saves.

Not for: fan-out pub/sub with no durability (use [`45-listen-notify.md`](./45-listen-notify.md)), streaming change capture (use [`76-logical-decoding.md`](./76-logical-decoding.md)), very high-throughput event logs where per-message UPDATE/DELETE churn on a heap table is too costly, scheduled recurring jobs (use [`98-pg-cron.md`](./98-pg-cron.md); pgmq only delays individual messages).

## Mental Model

Five rules:

1. **A queue is two tables.** `pgmq.q_<name>` holds live messages; `pgmq.a_<name>` holds archived ones. Everything is plain SQL over these tables, so backups, replication, and `pg_dump` cover queues like any other data.[^3]

2. **`read` is `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE vt`.** A read locks visible rows, moves their visibility timeout (`vt`) into the future, and increments `read_ct`, in one statement. Concurrent readers get disjoint rows.[^3]

3. **Nothing is acknowledged until you `delete` or `archive`.** If `vt` passes first, the message becomes visible again and is redelivered. pgmq stores no consumer identity; `read_ct` is the only retry counter.[^1]

4. **Queue operations join the caller's transaction.** A `send` inside a transaction that rolls back never happened. This is the main reason to queue in Postgres.[^4]

5. **Every read is an UPDATE and every ack is a DELETE.** Queue tables churn dead tuples at message rate. Autovacuum health decides queue performance; upstream does not document tuning, so see [Gotchas](#gotchas) and [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Work queue, one consumer per message | `send` + `read` + `delete`/`archive` | visibility timeout gives at-least-once with retries |
| Fire-and-forget consumption | `pop` | read and delete in one statement; at-most-once |
| Keep processed messages for audit | `archive` | moves row to `a_<name>` with `archived_at` |
| Per-key ordering (per user, per order) | `x-pgmq-group` header + `read_grouped*` | strict order within a group |
| Fair share across tenants | `read_grouped_rr` | round-robin across groups |
| Retry later | `set_vt(queue, msg_id, seconds)` | message reappears after the delay |
| Delay first delivery | `send(..., delay => seconds or timestamptz)` | sets initial `vt` |
| Wake idle consumers without polling | `enable_notify_insert` + `LISTEN` | NOTIFY as a doorbell |
| One message to several queues by key | `bind_topic` + `send_topic` | AMQP-style `*` / `#` patterns |
| High volume with time-based retention | `create_partitioned` (needs pg_partman) | drop partitions instead of deleting rows |
| Speed over durability | `create_unlogged` | queue table is UNLOGGED; lost on crash |
| Managed service without the extension | plain-SQL install (`pgmq.sql`) | no `CREATE EXTENSION` required; no upgrade path |
| Hand-rolled queue on an existing table | [`43-locking.md`](./43-locking.md) Recipe 4 | same SKIP LOCKED pattern without the extension |

## Mechanics

### Installation

    CREATE EXTENSION pgmq;    -- creates schema pgmq; not relocatable

Install paths:[^1][^5]

| Method | Command | Notes |
|---|---|---|
| PGXN | `pgxn install pgmq` | on the database host |
| Source | `cd pgmq/pgmq-extension && make && make install` | PGXS build |
| Docker | `ghcr.io/pgmq/pg18-pgmq:<tag>` (pg14–pg18) | Postgres with pgmq preinstalled; still run `CREATE EXTENSION` |
| Plain SQL | `psql -f pgmq-extension/sql/pgmq.sql <conn>` | for managed services; "only works for a fresh installation" |

The control file sets `superuser = false`, and pgmq needs no `shared_preload_libraries` entry. Upstream describes extension installs on managed services as limited; where the extension is not allowlisted, the plain-SQL install creates the same schema and functions and is "compatible with most managed services". That path has no upgrade mechanism: upgrading means dropping the schema (and its queues) or applying changes by hand.[^5]

Upgrade the extension with `ALTER EXTENSION pgmq UPDATE;` after installing new files. Versions before 0.14.3 are unsupported; upgrades from 0.x must stop at 1.0.0 first.[^6]

### Storage Model

`pgmq.create('orders')` creates:[^3]

| Object | Definition |
|---|---|
| `pgmq.q_orders` | `msg_id bigint PK GENERATED ALWAYS AS IDENTITY, read_ct int, enqueued_at timestamptz, last_read_at timestamptz, vt timestamptz NOT NULL, message jsonb, headers jsonb` |
| `pgmq.a_orders` | same columns plus `archived_at timestamptz DEFAULT now()` |
| `q_orders_vt_idx` | B-tree on `(vt)` |
| `archived_at_idx_orders` | B-tree on `archived_at` |
| `pgmq.meta` row | queue registry (`is_partitioned`, `is_unlogged`, `created_at`) |

Queue names are folded to lower case in table names and limited to 47 characters (so the full identifier fits 63 bytes). Names containing `$`, `;`, `--`, or `'` are rejected.[^3]

`pgmq.meta`, `pgmq.notify_insert_throttle`, and `pgmq.topic_bindings` are registered with `pg_extension_config_dump`, so `pg_dump` includes their rows. Queue and archive tables are ordinary tables (not extension members) and dump normally.[^3]

All functions are `SECURITY INVOKER` with `search_path` pinned to `pg_catalog, pg_temp` (1.13.1+). Grant callers privileges on the queue tables they use.[^3]

### Message Record

`read`, `pop`, `set_vt`, and the FIFO readers return `pgmq.message_record`:[^3][^7]

| Column | Type | Meaning |
|---|---|---|
| `msg_id` | `bigint` | unique per queue |
| `read_ct` | `integer` | times read; use for retry limits |
| `enqueued_at` | `timestamptz` | send time |
| `last_read_at` | `timestamptz` | last read time (1.10.0+) |
| `vt` | `timestamptz` | invisible until this time |
| `message` | `jsonb` | payload (may be NULL) |
| `headers` | `jsonb` | metadata (1.5.0+) |

> [!WARNING] 1.10.0 changed the column order
> `last_read_at` was inserted as the 4th column. Code that reads result columns by position broke at 1.10.0. Select columns by name.[^2]

### Queue Lifecycle

| Function | Returns | Notes |
|---|---|---|
| `pgmq.create(queue_name)` | `void` | idempotent |
| `pgmq.create_unlogged(queue_name)` | `void` | queue table UNLOGGED; archive stays logged |
| `pgmq.create_partitioned(queue_name, partition_interval DEFAULT '10000', retention_interval DEFAULT '100000', premake DEFAULT 4)` | `void` | requires pg_partman; see [Partitioned Queues](#partitioned-queues) |
| `pgmq.convert_archive_partitioned(queue_name, partition_interval, retention_interval, leading_partition)` | `void` | renames `a_<q>` to `a_<q>_old` and creates a partitioned archive; data is not migrated |
| `pgmq.drop_queue(queue_name)` | `boolean` | drops both tables and metadata; `false` if missing |
| `pgmq.purge_queue(queue_name)` | `bigint` | `TRUNCATE` of the queue table only; returns the prior count |
| `pgmq.list_queues()` | `SETOF pgmq.queue_record` | contents of `pgmq.meta` |

Deprecated, removal planned for 2.0: `drop_queue(name, partitioned boolean)` and `detach_archive(name)` (now a no-op).[^3]

### Sending

    -- Returns the new msg_id
    SELECT * FROM pgmq.send(queue_name => 'orders', msg => '{"order_id": 42}');

    -- Delay 30 seconds, or until a timestamp
    SELECT * FROM pgmq.send(queue_name => 'orders', msg => '{"order_id": 43}', delay => 30);
    SELECT * FROM pgmq.send('orders', '{"order_id": 44}', CURRENT_TIMESTAMP + INTERVAL '1 day');

    -- With headers
    SELECT * FROM pgmq.send('orders', '{"order_id": 45}', headers => '{"trace_id": "abc123"}');

    -- Batch; headers array, if given, must match msgs length
    SELECT * FROM pgmq.send_batch('orders',
        ARRAY['{"order_id": 46}', '{"order_id": 47}']::jsonb[]);

`send` has six overloads: `(queue_name, msg [, headers] [, delay integer | timestamptz])`. Integer `delay` is seconds from `clock_timestamp()`; a timestamp is used as `vt` directly. `send_batch` mirrors them with `jsonb[]` arrays.[^3]

> [!WARNING] Ambiguous overloads
> Untyped literals can match more than one overload and fail with `function ... is not unique`. Since 1.5.0, a string delay such as `send(q, msg, '10')` no longer resolves. Use named arguments or typed values (`10`, `'...'::timestamptz`, `'{}'::jsonb`).[^2]

### Reading and the Visibility Timeout

    -- Up to 10 messages, hidden from other readers for 30 seconds
    SELECT * FROM pgmq.read(queue_name => 'orders', vt => 30, qty => 10);

| Function | Notes |
|---|---|
| `pgmq.read(queue_name, vt integer, qty integer, conditional jsonb DEFAULT '{}')` | `vt` in seconds; `conditional` filters by `message @> conditional` (experimental) |
| `pgmq.read_with_poll(queue_name, vt, qty, max_poll_seconds DEFAULT 5, poll_interval_ms DEFAULT 100, conditional DEFAULT '{}')` | server-side loop with `pg_sleep` until rows arrive or time runs out |
| `pgmq.pop(queue_name, qty DEFAULT 1)` | read and delete in one statement (`qty` 1.7.0+) |
| `pgmq.set_vt(queue_name, msg_id, vt integer \| timestamptz)` | change visibility; `0` = visible now; batch form takes `bigint[]` (1.8.0+) |

The read query, verbatim from `pgmq.sql`:[^3]

    WITH cte AS
    (
        SELECT msg_id
        FROM pgmq.%I
        WHERE vt <= clock_timestamp() AND CASE
            WHEN %L != '{}'::jsonb THEN (message @> %2$L)::integer
            ELSE 1
        END = 1
        ORDER BY msg_id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE pgmq.%I m
    SET
        last_read_at = clock_timestamp(),
        vt = clock_timestamp() + %L,
        read_ct = read_ct + 1
    FROM cte
    WHERE m.msg_id = cte.msg_id
    RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.last_read_at, m.vt, m.message, m.headers;

Consequences:

- `vt` comparisons use `clock_timestamp()`, not `now()`, so they are evaluated per statement, not per transaction (1.5.1+).
- If the reading transaction rolls back, the `vt` update rolls back too and the message is immediately visible again.
- `read_with_poll` holds a connection and sleeps inside the server. On a transaction-mode pooler, that connection is occupied for up to `max_poll_seconds`.
- `conditional` filters with a JSONB containment check after the `vt` filter; there is no index on `message`.

### Acknowledging: delete vs archive

| Function | Returns | Effect |
|---|---|---|
| `pgmq.delete(queue_name, msg_id)` | `boolean` | row removed |
| `pgmq.delete(queue_name, msg_ids bigint[])` | `SETOF bigint` | ids actually deleted; missing ids are omitted |
| `pgmq.archive(queue_name, msg_id)` | `boolean` | `DELETE ... RETURNING` into `INSERT INTO a_<q>`, one statement |
| `pgmq.archive(queue_name, msg_ids bigint[])` | `SETOF bigint` | ids actually archived |

The archive table grows forever unless you prune it (or partition it). pgmq does not prune non-partitioned archives.[^3]

### FIFO Groups (1.9.0+)

Put a group key in the `x-pgmq-group` header. Messages without the header share the group `_default_fifo_group`.[^8]

    SELECT pgmq.send('orders', '{"step": 1}', headers => '{"x-pgmq-group": "user123"}');
    SELECT pgmq.send('orders', '{"step": 2}', headers => '{"x-pgmq-group": "user123"}');

    SELECT pgmq.create_fifo_index('orders');     -- GIN on headers; not created by create()

| Reader | Behavior |
|---|---|
| `read_grouped(queue, vt, qty)` | fills the batch from the oldest eligible group first (SQS FIFO style) |
| `read_grouped_rr(queue, vt, qty)` | round-robin across groups |
| `read_grouped_head(queue, vt, qty)` | at most one message per group, up to `qty` groups (1.11.1+) |
| `*_with_poll` variants | same polling parameters as `read_with_poll` |

A group is blocked while one of its messages is in flight, so later messages in that group wait for the earlier one to be acknowledged or to time out. Compared with SQS FIFO, pgmq FIFO has no deduplication.[^8]

### Topic Routing (1.11.0+)

    SELECT pgmq.bind_topic('logs.#', 'all_logs');
    SELECT pgmq.bind_topic('logs.*.error', 'error_logs');

    SELECT pgmq.send_topic('logs.api.error', '{"message": "API failed"}');   -- returns queues delivered to
    SELECT * FROM pgmq.test_routing('logs.api.error');                         -- dry run

`*` matches exactly one dot-separated segment; `#` is compiled to `.*`. `send_topic` delivers to all matching queues in one transaction. Delays on `send_topic` are integer seconds only. Use `send_batch_topic` for batches, and `unbind_topic` / `list_topic_bindings` to manage bindings.[^9]

### Insert Notifications

    SELECT pgmq.enable_notify_insert('orders');          -- default throttle 250 ms
    SELECT pgmq.enable_notify_insert('orders', 1000);    -- at most 1 NOTIFY per second

    -- Consumer session; the channel contains dots, so quote it
    LISTEN "pgmq.q_orders.INSERT";

A constraint trigger on the queue table sends a NOTIFY with a NULL payload, at most once per `throttle_interval_ms` (`0` = no throttling). The notification only wakes the consumer, which then calls `read`. This is the doorbell pattern in [`45-listen-notify.md`](./45-listen-notify.md) Recipe 2. NOTIFY is delivered at commit, so consumers never wake for a rolled-back send.[^7]

Manage with `update_notify_insert`, `disable_notify_insert`, `list_notify_insert_throttles`. Before 1.13.1, notifications never fired for queue names that were not all lowercase.[^2]

### Partitioned Queues

`create_partitioned` hands both tables to pg_partman ([`99-pg-partman.md`](./99-pg-partman.md)). pg_partman must be installed first, in any schema.[^10]

    -- Partition by msg_id: 100,000 messages per partition, keep 10,000,000
    SELECT pgmq.create_partitioned('events', '100000', '10000000');

    -- Partition by time: daily partitions, keep 7 days
    SELECT pgmq.create_partitioned('events_daily', '1 day', '7 days');

- An integer-like `partition_interval` partitions by `msg_id`; a duration partitions the queue by `enqueued_at` and the archive by `archived_at`. `retention_interval` must be the same kind.
- Retention drops whole partitions. It does not apply to rows already removed by `delete` or `archive`.
- Maintenance must run: pg_partman's background worker (`pg_partman_bgw` in `shared_preload_libraries`) or a scheduled `partman.run_maintenance_proc()` via pg_cron ([`98-pg-cron.md`](./98-pg-cron.md) Recipe 4).
- **Runway:** about `partition_interval × premake` messages (or that much time) between maintenance runs. Past it, `send` still succeeds but rows land in the pg_partman default partition, and then `run_maintenance` fails for that queue and retention stops.[^10]

Watch `pgmq.metrics('events').default_partition_length`: "Zero is the only healthy value." To recover (run outside a transaction block, and repeat for `pgmq.a_events` if the archive spilled):[^10]

    CALL partman.partition_data_proc('pgmq.q_events');
    SELECT partman.run_maintenance('pgmq.q_events');
    ANALYZE pgmq.q_events_default;

Since 1.13.0, partitioned queues use `GENERATED BY DEFAULT AS IDENTITY` for `msg_id` (so `partition_data_proc` can reinsert rows). Postgres no longer rejects explicit `msg_id` values; write only through the pgmq API.[^10]

### Monitoring

    SELECT * FROM pgmq.metrics('orders');
    SELECT * FROM pgmq.metrics_all();

| Column | Meaning |
|---|---|
| `queue_length` | `count(*)` of the queue table (visible + in flight + delayed) |
| `queue_visible_length` | rows with `vt <= now()` |
| `newest_msg_age_sec`, `oldest_msg_age_sec` | from `enqueued_at` |
| `total_messages` | last value of the `msg_id` sequence |
| `default_partition_length` | rows estimated in pg_partman default partitions; NULL for non-partitioned queues (1.13.0+) |

`metrics` runs `count(*)` on the queue table. On a deep queue, poll it at monitoring intervals, not per request. Since 1.13.1, `pg_monitor` members can read metrics without access to message payloads.[^3]

## Delivery Semantics

| Path | Guarantee |
|---|---|
| `read` → process → `delete`/`archive` | at-least-once. Upstream wording: "exactly once delivery of messages to a consumer within a visibility timeout" |
| `vt` expires before ack | redelivered with `read_ct + 1` |
| `pop` | at-most-once: lost if the consumer fails after `pop` commits |
| `send` in a rolled-back transaction | never enqueued |
| ordering with concurrent `read` | best-effort `msg_id` order; `SKIP LOCKED` gives no strict order |
| ordering within a FIFO group | strict |

Make consumers idempotent: a message can be processed twice if the consumer finishes the work but fails before the ack commits, or if processing outlasts `vt`. Set `vt` longer than worst-case processing time, or extend it with `set_vt` during long work.[^1]

## Per-Version Timeline

PG14–PG18 release notes contain no pgmq items; it is wholly external. The relevant timeline is the extension's own.[^2]

| Version | Released | Key changes |
|---|---|---|
| 1.0.0 | 2023-11-30 | stable API |
| 1.3.2 | 2024-06-04 | pure PL/pgSQL, no shared objects |
| 1.4.1 / 1.4.2 | 2024-08 | SQL-injection fix; queue names reject `$ ' ; --` |
| 1.5.0 | 2024-12-30 | headers, timestamptz delay, `conditional` read, `queue_visible_length` |
| 1.5.1 | 2025-03-21 | plain-SQL install; `clock_timestamp()` in `pop`/`set_vt` |
| 1.6.0 | 2025-07-13 | moved to the `pgmq` org; extension data dumpable |
| 1.7.0 | 2025-09-11 | `pop(queue, qty)`; insert notifications |
| 1.8.0 | 2025-11-30 | notify throttling; batch `set_vt`; PG18 |
| 1.9.0 | 2026-01-18 | FIFO groups (`read_grouped`, `read_grouped_rr`, `create_fifo_index`) |
| 1.10.0 | 2026-02-02 | `last_read_at` (column order change); `set_vt` timestamptz |
| 1.11.0 | 2026-02-19 | topic routing |
| 1.11.1 | 2026-04-19 | `read_grouped_head` |
| 1.12.0 | 2026-07-14 | `read_grouped_head_with_poll` |
| 1.13.0 | 2026-09-07 | `create_partitioned(..., premake)`; `default_partition_length`; overrun fix |
| 1.13.1 | 2026-10-20 | security: pinned `search_path`, narrower `pg_monitor` grants; notify fix for mixed-case names |

> [!WARNING] Upgrade to 1.13.1
> Upstream: "We recommend that everyone on v1.13.0 or earlier upgrade." 1.13.1 pins `search_path` in every function and removes `pg_monitor` read access to payload tables.[^2]

    SELECT extversion FROM pg_extension WHERE extname = 'pgmq';

## Recipes

### Recipe 1 — Transactional outbox

Enqueue in the same transaction as the business write. Either both commit or neither does.

    BEGIN;
    INSERT INTO orders (id, customer_id, total) VALUES (42, 7, 99.00);
    SELECT pgmq.send('order_events', jsonb_build_object('type', 'order_created', 'order_id', 42));
    COMMIT;

### Recipe 2 — Worker loop with retry limit and dead-letter queue

    SELECT pgmq.create('jobs');
    SELECT pgmq.create('jobs_dlq');

    -- Worker: claim one message for 60 s
    SELECT msg_id, read_ct, message FROM pgmq.read('jobs', 60, 1);

    -- Success
    SELECT pgmq.delete('jobs', :msg_id);

    -- Failure: retry with backoff, or dead-letter after 5 attempts
    SELECT pgmq.set_vt('jobs', :msg_id, 30 * :read_ct);                 -- when read_ct < 5

    BEGIN;                                                               -- when read_ct >= 5
    SELECT pgmq.send('jobs_dlq', :message::jsonb);
    SELECT pgmq.archive('jobs', :msg_id);
    COMMIT;

Upstream ships no dead-letter feature; this pattern composes it from two queues.

### Recipe 3 — Long-running job: extend the timeout

    SELECT * FROM pgmq.read('reports', 300, 1);      -- 5 minutes
    -- ... still working after 4 minutes:
    SELECT * FROM pgmq.set_vt('reports', :msg_id, 300);

### Recipe 4 — Idle consumers without polling

    SELECT pgmq.enable_notify_insert('jobs', 250);

Consumer: `LISTEN "pgmq.q_jobs.INSERT";` then, on each notification and once at startup, call `pgmq.read` in a loop until it returns no rows. Keep a periodic fallback read in case a notification is missed while the consumer is disconnected.

### Recipe 5 — Per-customer ordering

    SELECT pgmq.create('billing');
    SELECT pgmq.create_fifo_index('billing');

    SELECT pgmq.send('billing', '{"op": "charge"}', headers => '{"x-pgmq-group": "cust_7"}');
    SELECT pgmq.send('billing', '{"op": "refund"}', headers => '{"x-pgmq-group": "cust_7"}');

    -- Fair share across customers, strict order within each
    SELECT * FROM pgmq.read_grouped_rr('billing', 30, 10);

### Recipe 6 — Prune the archive with pg_cron

pgmq does not prune non-partitioned archives. Schedule it ([`98-pg-cron.md`](./98-pg-cron.md)):

    SELECT cron.schedule('prune-jobs-archive', '0 3 * * *',
        $$DELETE FROM pgmq.a_jobs WHERE archived_at < now() - interval '30 days'$$);

### Recipe 7 — Queue health check

    SELECT queue_name, queue_length, queue_visible_length, oldest_msg_age_sec, default_partition_length
    FROM pgmq.metrics_all()
    ORDER BY oldest_msg_age_sec DESC NULLS LAST;

    -- Messages retried many times
    SELECT msg_id, read_ct, enqueued_at FROM pgmq.q_jobs WHERE read_ct >= 5 ORDER BY msg_id;

## Gotchas

1. **`pop` loses messages on consumer failure.** Use `read` + ack for anything that must be processed.
2. **`vt` shorter than processing time causes duplicates.** Another worker reads the message while the first is still working on it.
3. **Consumers must be idempotent.** At-least-once delivery means a message can arrive twice.
4. **Column order changed in 1.10.0.** Select result columns by name.
5. **Overload ambiguity in `send`.** Use named or typed arguments.
6. **Queue tables bloat.** Each read is an UPDATE, each ack a DELETE. Upstream gives no tuning guidance; this page derives it from [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md): watch `n_dead_tup` on `pgmq.q_*`, and lower `autovacuum_vacuum_scale_factor` per table for busy queues. A long-running transaction anywhere in the cluster holds back cleanup for every queue.
7. **Archives grow without limit.** Prune them (Recipe 6) or use partitioned queues.
8. **Partitioned queues depend on pg_partman maintenance.** If maintenance stops, rows spill into the default partition and retention stops. Alert when `default_partition_length` is above 0.
9. **The NOTIFY channel needs quoting.** `LISTEN "pgmq.q_jobs.INSERT"`. Before 1.13.1, mixed-case queue names never notified.
10. **`read_with_poll` occupies a connection.** It sleeps server-side; budget pool size accordingly ([`80-connection-pooling.md`](./80-connection-pooling.md)).
11. **The plain-SQL install has no upgrade path.** Prefer `CREATE EXTENSION` wherever it is available.
12. **`create_unlogged` queues empty on crash** and are not replicated to standbys ([`73-streaming-replication.md`](./73-streaming-replication.md)).
13. **`purge_queue` truncates only the queue table.** The archive is untouched.
14. **Queue names fold to lower case** in table names, so `MyQueue` and `myqueue` map to the same tables (read from `format_table_name` in the source).[^3]
15. **FIFO group locks are global.** `read_grouped_rr` takes `pg_try_advisory_xact_lock(hashtextextended(group_key, 0))` with no queue name in the key, so the same group key in two queues contends on one advisory lock (read from source; see [`44-advisory-locks.md`](./44-advisory-locks.md)).[^3]
16. **Topic `#` after a dot needs at least one segment.** `logs.#` compiles to `^logs\..*$` and does not match bare `logs`.[^3][^9]
17. **Stale upstream metadata.** The README Docker example pins an old tag, and `META.json` lists PostgreSQL 11. Trust the README text (14–18) and the release notes.

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — per-table autovacuum for churn-heavy queue tables
- [`41-transactions.md`](./41-transactions.md) — enqueue inside the business transaction
- [`43-locking.md`](./43-locking.md) — `FOR UPDATE SKIP LOCKED`, the pattern under `read`; hand-rolled queue recipe
- [`44-advisory-locks.md`](./44-advisory-locks.md) — locks used by create/drop and `read_grouped_rr`
- [`45-listen-notify.md`](./45-listen-notify.md) — NOTIFY as a doorbell; payload and delivery rules
- [`69-extensions.md`](./69-extensions.md) — `CREATE EXTENSION`, `ALTER EXTENSION UPDATE`
- [`80-connection-pooling.md`](./80-connection-pooling.md) — pool sizing with long-polling consumers
- [`98-pg-cron.md`](./98-pg-cron.md) — archive pruning, pg_partman maintenance scheduling
- [`99-pg-partman.md`](./99-pg-partman.md) — `premake`, default partition, `partition_data_proc`
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — extension allowlists; plain-SQL install

## Sources

[^1]: pgmq README — `https://github.com/pgmq/pgmq/blob/main/README.md` — supported versions, install, visibility timeout, delivery wording, clients.

[^2]: pgmq releases — `https://github.com/pgmq/pgmq/releases` — version history, breaking changes (1.5.0, 1.10.0), 1.13.1 security advisory.

[^3]: pgmq install script — `https://github.com/pgmq/pgmq/blob/main/pgmq-extension/sql/pgmq.sql` (identical at tag v1.13.1) — table definitions, function signatures, read/pop/archive queries, grants, name validation, advisory locks, topic regex compilation.

[^4]: pgmq transaction isolation test — `https://github.com/pgmq/pgmq/blob/main/pgmq-extension/test/specs/transaction_tests.spec`; and `https://github.com/pgmq/pgmq/blob/main/docs/topics.md` ("All sends succeed or all fail (transactional)").

[^5]: INSTALLATION.md — `https://github.com/pgmq/pgmq/blob/main/INSTALLATION.md` — extension vs plain-SQL install, managed-service considerations. Control file: `https://github.com/pgmq/pgmq/blob/main/pgmq-extension/pgmq.control`.

[^6]: UPDATING.md — `https://github.com/pgmq/pgmq/blob/main/UPDATING.md`.

[^7]: SQL function and type docs — `https://github.com/pgmq/pgmq/blob/main/docs/api/sql/functions.md`, `https://github.com/pgmq/pgmq/blob/main/docs/api/sql/types.md`.

[^8]: FIFO queues — `https://github.com/pgmq/pgmq/blob/main/docs/fifo-queues.md`.

[^9]: Topics — `https://github.com/pgmq/pgmq/blob/main/docs/topics.md`.

[^10]: Partitioned queues — `https://github.com/pgmq/pgmq/blob/main/docs/partitioned-queues.md` — runway, default-partition spill, recovery, identity change.

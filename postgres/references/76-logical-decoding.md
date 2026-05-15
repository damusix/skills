# Logical Decoding

Output-plugin protocol that extracts row-level changes from WAL. Foundation for native logical replication (`74-logical-replication.md`), CDC pipelines, and custom WAL consumers. This file covers the output-plugin author surface and the SQL/protocol consumer surface — slot mechanics live in `75-replication-slots.md`.

> [!WARNING] Three planning-note traps fixed in this file
> (1) `logicaldecoding-restrictions.html` does **not exist**. DDL / sequence / large-object restrictions live in `logical-replication-restrictions.html` (Chapter 31.6 in PG16, renumbered later). (2) `logical_decoding_work_mem` is on `runtime-config-resource.html` (Resource Consumption), **not** `runtime-config-wal.html`. (3) PG17 renumbered the chapter from 49 to 47; cite by URL slug (`logicaldecoding.html`), never by chapter number.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [SQL interface](#sql-interface)
    - [Streaming Replication Protocol interface](#streaming-replication-protocol-interface)
    - [Output plugin callbacks](#output-plugin-callbacks)
    - [Streaming in-progress transactions](#streaming-in-progress-transactions)
    - [Two-phase commit decoding](#two-phase-commit-decoding)
    - [Synchronous logical decoding](#synchronous-logical-decoding)
    - [REPLICA IDENTITY](#replica-identity)
    - [Memory + spill (logical_decoding_work_mem)](#memory--spill-logical_decoding_work_mem)
    - [Restrictions](#restrictions)
- [pgoutput (built-in)](#pgoutput-built-in)
- [test_decoding (contrib)](#test_decoding-contrib)
- [pg_recvlogical CLI](#pg_recvlogical-cli)
- [Third-party output plugins](#third-party-output-plugins)
- [Per-version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

When you need to:

- Write a custom output plugin for CDC, audit, cache invalidation, or cross-system replication
- Consume changes from a logical slot via SQL (`pg_logical_slot_get_changes`) or replication protocol (`START_REPLICATION SLOT … LOGICAL`)
- Pick between `pgoutput` (native), `test_decoding` (SQL-like text), `wal2json` (JSON), `decoderbufs` (Protobuf)
- Tune `logical_decoding_work_mem` for high-throughput decoding
- Set `REPLICA IDENTITY` so UPDATE / DELETE can identify the old row
- Configure synchronous logical decoding via `synchronous_standby_names`
- Diagnose decoding-side issues: subxact overflow, large-transaction memory pressure, decoder back-pressure

For the user-facing `CREATE PUBLICATION` / `CREATE SUBSCRIPTION` model, see `74-logical-replication.md`. For slot lifecycle + retention, see `75-replication-slots.md`. For wire protocol formats (pgoutput messages), see Section 55.9 "Logical Replication Message Formats" in protocol docs.

## Mental Model

Five rules.

1. **Logical decoding = WAL → output-plugin callback → consumer.** Walsender process reads WAL, calls plugin callbacks (`begin_cb` / `change_cb` / `commit_cb` / etc.), plugin emits bytes. Consumer reads bytes via SQL function or replication protocol. `[^lc-explain]`

2. **Plugin is a shared library, named at slot creation.** `pg_create_logical_replication_slot(slot_name, 'plugin_name')` binds the slot to a plugin. Cannot change plugin without dropping + recreating slot. Built-in: `pgoutput` (binary protocol for native replication). Contrib: `test_decoding`. Third-party: `wal2json`, `decoderbufs`, `pglogical_output`, custom. `[^lc-output-plugin]`

3. **`REPLICA IDENTITY` decides what's in OLD for UPDATE / DELETE.** Default = PK columns. `FULL` = every column (high WAL volume). `USING INDEX idx` = named unique-not-null index. `NOTHING` = nothing (UPDATE / DELETE error or skip). DDL on table without acceptable REPLICA IDENTITY breaks decoding silently for UPDATE / DELETE. `[^replica-identity]`

4. **Decoding can spill to disk.** When transaction exceeds `logical_decoding_work_mem` (default 64 MB), changes spill to `$PGDATA/pg_replslot/<slot>/`. PG14+ supports **streaming in-progress transactions** so subscribers see changes before COMMIT — but plugin must implement `stream_*` callbacks. `[^lc-mem]` `[^pg14-stream]`

5. **Logical decoding does NOT replicate DDL, sequences, or large objects.** Verbatim docs: *"The database schema and DDL commands are not replicated."* / *"Sequence data is not replicated."* / *"Large objects … are not replicated. There is no workaround for that."* Custom plugins can capture these via event triggers + custom messages, but pgoutput / native logical replication does not. `[^lr-restrict]`

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Native logical replication (pub/sub) | `pgoutput` via `CREATE SUBSCRIPTION` | Custom plugin | Already wired into PG, supports all PG-version features |
| CDC pipeline to Kafka / Kinesis / etc. | Debezium with `pgoutput` or `decoderbufs` | Roll your own | Debezium handles offset, schema evolution, restart |
| Human-readable change inspection / tests | `test_decoding` via `pg_logical_slot_get_changes` | pgoutput (binary) | test_decoding emits SQL-like text — easy to read in `psql` |
| JSON change events for application | `wal2json` (third-party) | Build JSON in custom plugin | wal2json mature, maintained |
| Protobuf change events | `decoderbufs` (third-party) | Roll your own | Used by Debezium PG connector |
| Audit trail / change history | Custom plugin OR triggers | DDL replication | Decoding misses DDL — triggers cover that |
| Cache invalidation broadcast | `pg_recvlogical` to LISTEN / message bus | Custom plugin | Simpler than writing a plugin |
| Replicate DDL | Custom event-trigger-based mechanism | Stock logical decoding | DDL not in WAL as decodable change |
| Replicate sequences | Custom periodic sync | Stock logical decoding | Sequence advances not in WAL changes |
| Replicate large objects | `bytea` columns + decode normally | LO API + decoding | LO contents not replicated |
| Stream large transactions before COMMIT | PG14+ `streaming = on` in publisher slot + plugin with `stream_*` callbacks | Wait for COMMIT | Long transactions otherwise blow `logical_decoding_work_mem` |
| Two-phase commit visibility | PG14+ decoding-side `twophase = true` + plugin with prepare callbacks | Wait for COMMIT PREPARED | Reduces commit latency on subscriber |

Three smell signals.

1. **Custom plugin emitting JSON.** Use `wal2json` — actively maintained with well-tested edge cases.
2. **Slot lag climbing under bursty INSERTs.** Either subscriber too slow, or `logical_decoding_work_mem` too low forcing spill. Raise the GUC OR enable streaming.
3. **UPDATE / DELETE silently absent from decoded stream.** Source table likely missing REPLICA IDENTITY. Check `pg_class.relreplident`.

## Mechanics

### SQL interface

Six functions, all in `functions-admin.html#FUNCTIONS-REPLICATION`. `[^lc-sql]`

| Function | Returns | Purpose |
|---|---|---|
| `pg_create_logical_replication_slot(slot_name, plugin, temporary, twophase, failover)` | (slot_name, lsn) | Create logical slot bound to `plugin`. `temporary` PG10+, `twophase` PG14+, `failover` PG17+. |
| `pg_drop_replication_slot(slot_name)` | void | Drop slot. Frees WAL retention. |
| `pg_logical_slot_get_changes(slot_name, upto_lsn, upto_nchanges, opts...)` | (lsn, xid, data) | Consume + advance slot. Changes gone after return. |
| `pg_logical_slot_peek_changes(slot_name, upto_lsn, upto_nchanges, opts...)` | (lsn, xid, data) | Read without consuming. Useful for diagnostics. |
| `pg_logical_slot_get_binary_changes` / `pg_logical_slot_peek_binary_changes` | (lsn, xid, data bytea) | Binary variant for plugins that emit non-text. |
| `pg_replication_slot_advance(slot_name, upto_lsn)` | (slot_name, end_lsn) | Skip ahead. Discard pending changes. |

`opts...` = variadic key/value pairs passed to plugin (e.g., `'include-xids', '0'` for test_decoding).

> [!WARNING] `_get_` vs `_peek_`
> `pg_logical_slot_get_changes` **consumes** changes — they are advanced past and cannot be replayed via that slot. If your real consumer is hooked up, calling `_get_` from another session silently swallows changes. Use `_peek_` for inspection.

### Streaming Replication Protocol interface

For production consumers, use the replication protocol — lower overhead, asynchronous delivery. Documented in `logicaldecoding-walsender.html` (URL slug is misleading; actual title is "Streaming Replication Protocol Interface"). `[^lc-walsender]`

Key commands sent over a `replication=database` connection:

- `IDENTIFY_SYSTEM` — returns system identifier, timeline, xlogpos
- `CREATE_REPLICATION_SLOT slot_name LOGICAL plugin_name` — equivalent to `pg_create_logical_replication_slot`; `TWO_PHASE` (PG15+) and `FAILOVER` (PG17+) options available
- `START_REPLICATION SLOT slot_name LOGICAL lsn [(opt = val, …)]` — begin streaming. `lsn` is the start position (`0/0` = where slot left off). Options forwarded to plugin.
- `DROP_REPLICATION_SLOT slot_name`

Consumer sends `Standby Status Update` messages to ACK received LSNs. Without ACK the slot retains WAL — that's how replication slots survive crash but also how abandoned consumers fill disk.

### Output plugin callbacks

Plugin = shared library with `_PG_output_plugin_init(OutputPluginCallbacks *cb)` symbol. Fills callback pointers. Documented in `logicaldecoding-output-plugin.html`. `[^lc-output-plugin]`

**Required for any plugin:**

| Callback | Signature | Purpose |
|---|---|---|
| `begin_cb` | `(ctx, txn)` | Transaction starting |
| `change_cb` | `(ctx, txn, relation, change)` | INSERT / UPDATE / DELETE on one row |
| `commit_cb` | `(ctx, txn, commit_lsn)` | Transaction committing |

**Optional:**

| Callback | Purpose | Version |
|---|---|---|
| `startup_cb` | Parse plugin options at slot start | Any |
| `shutdown_cb` | Cleanup at slot stop | Any |
| `truncate_cb` | TRUNCATE on tables | PG11+ |
| `message_cb` | Logical decoding messages (`pg_logical_emit_message`) | PG11+ |
| `filter_by_origin_cb` | Skip changes from named origin | PG10+ |
| `filter_prepare_cb` | Skip 2PC prepares | PG14+ |

Verbatim docs: *"The `begin_cb`, `change_cb` and `commit_cb` callbacks are required, while `startup_cb`, `truncate_cb`, `message_cb`, `filter_by_origin_cb`, and `shutdown_cb` are optional."* `[^lc-output-plugin]`

**Streaming callbacks (PG14+, required if plugin advertises streaming):**

`stream_start_cb` / `stream_stop_cb` / `stream_abort_cb` / `stream_commit_cb` / `stream_change_cb` are required; `stream_message_cb` and `stream_truncate_cb` optional. `[^lc-streaming]`

**Two-phase callbacks (PG14+ decoding-side, required if plugin advertises 2PC):**

`begin_prepare_cb` / `prepare_cb` / `commit_prepared_cb` / `rollback_prepared_cb` required; `filter_prepare_cb` optional. `[^lc-2pc]`

Minimal C skeleton:

```c
#include "postgres.h"
#include "replication/output_plugin.h"
#include "replication/logical.h"

PG_MODULE_MAGIC;

static void my_begin(LogicalDecodingContext *ctx, ReorderBufferTXN *txn);
static void my_change(LogicalDecodingContext *ctx, ReorderBufferTXN *txn,
                       Relation rel, ReorderBufferChange *change);
static void my_commit(LogicalDecodingContext *ctx, ReorderBufferTXN *txn,
                       XLogRecPtr commit_lsn);

void
_PG_output_plugin_init(OutputPluginCallbacks *cb)
{
    cb->begin_cb  = my_begin;
    cb->change_cb = my_change;
    cb->commit_cb = my_commit;
}

static void
my_change(LogicalDecodingContext *ctx, ReorderBufferTXN *txn,
          Relation rel, ReorderBufferChange *change)
{
    OutputPluginPrepareWrite(ctx, true);
    appendStringInfo(ctx->out, "change: relation %s, action %d\n",
                     RelationGetRelationName(rel), change->action);
    OutputPluginWrite(ctx, true);
}
```

Build via PGXS (`72-extension-development.md`). Install to `$libdir`. Use plugin name (matches `.so` basename) at slot creation.

### Streaming in-progress transactions

> [!NOTE] PostgreSQL 14
> Verbatim release note: *"Allow logical decoding to stream large in-progress transactions to subscribers (Dilip Kumar, Amit Kapila, Ajin Cherian, Tomas Vondra, Nikhil Sontakke, Stas Kelvich)."* `[^pg14-stream]`

Before PG14, plugins received `change_cb` calls only after COMMIT. Large transactions buffered in memory until commit, spilled to `pg_replslot/` past `logical_decoding_work_mem`. PG14+ adds `stream_*` callbacks so plugins receive changes incrementally — subscriber can apply or discard before commit.

Plugin opts into streaming by setting `ctx->streaming = true` in `startup_cb`. Subscriber opts in via `streaming = on` (or `streaming = parallel` PG16+, default PG18+) on `CREATE SUBSCRIPTION`.

### Two-phase commit decoding

> [!NOTE] PostgreSQL 14
> Verbatim release note: *"Allow logical decoding to decode prepared transactions (Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich)."* `[^pg14-2pc]`

Decoding-side support landed in PG14: a `PREPARE TRANSACTION` decodes via `prepare_cb`, then later `COMMIT PREPARED` decodes via `commit_prepared_cb`. Subscriber can apply at prepare time and finalize on commit.

> [!NOTE] PostgreSQL 15
> Verbatim release note: *"Allow logical replication subscribers to support two-phase commit (Peter Smith, Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich)."* Subscriber-side wiring + `CREATE_REPLICATION_SLOT … TWO_PHASE` option + `pg_recvlogical --two-phase`. `[^pg15-2pc]`

> [!NOTE] PostgreSQL 18
> `ALTER SUBSCRIPTION` can change a slot's 2PC behavior; `pg_recvlogical --enable-two-phase` is the new spelling (deprecates `--two-phase`); `pg_createsubscriber --enable-two-phase`. `[^pg18-2pc]`

### Synchronous logical decoding

Documented in `logicaldecoding-synchronous.html`. `[^lc-sync]`

`synchronous_standby_names` controls which standbys (including logical subscribers) the primary waits on at COMMIT. A logical slot's `application_name` matches against this list. Logical replication thus participates in synchronous commit if the subscriber's `application_name` is in `synchronous_standby_names`.

Asymmetric durability vs physical streaming: logical replication's "synchronous" applies at slot-flush time on the subscriber's walsender, not at apply time. Use `synchronous_commit = remote_apply` for subscriber-applied durability.

### REPLICA IDENTITY

Per-table setting controlling what's in OLD for UPDATE / DELETE decoding. Set via `ALTER TABLE … REPLICA IDENTITY {DEFAULT | USING INDEX name | FULL | NOTHING}`. `[^replica-identity]`

| Mode | OLD contents | UPDATE / DELETE behavior |
|---|---|---|
| `DEFAULT` | PK columns | Works if table has PK; fails silently otherwise |
| `USING INDEX idx` | Columns of named unique-not-null index | Works for tables with unique not-null index but no PK |
| `FULL` | Every column | Works always; high WAL volume |
| `NOTHING` | Nothing | UPDATE / DELETE not decoded |

Inspect via `pg_class.relreplident` (`d` = default, `n` = nothing, `f` = full, `i` = using index).

Verbatim docs from `sql-altertable.html`: *"This form changes the information which is written to the write-ahead log to identify rows which are updated or deleted."* `[^alter-table]`

Default for ordinary tables is `DEFAULT`. Default for system tables is `NOTHING`. Tables with no PK and no chosen index decoded only for INSERT — UPDATE / DELETE silently missing from the stream (gotcha #4).

### Memory + spill (logical_decoding_work_mem)

> [!NOTE] PostgreSQL 13
> `logical_decoding_work_mem` GUC introduced. Default 64 MB. Lives on `runtime-config-resource.html#GUC-LOGICAL-DECODING-WORK-MEM` (Resource Consumption — Memory), NOT `runtime-config-wal.html`. `[^lc-mem]`

Verbatim docs: *"Specifies the maximum amount of memory to be used by logical decoding, before some of the decoded changes are written to local disk. … It defaults to 64 megabytes (64MB)."*

When a single transaction's reorder-buffer entries exceed this, oldest entries spill to `$PGDATA/pg_replslot/<slot>/`. On PG14+ with streaming-capable plugin, decoding can instead stream incrementally without spilling.

Per-process limit, not per-cluster. Each walsender has its own budget. Setting it cluster-wide: ALTER SYSTEM SET logical_decoding_work_mem = '256MB'; pg_reload_conf();

### Restrictions

Documented in `logical-replication-restrictions.html` (not under the logical decoding chapter — gotcha #15). Apply to native logical replication AND to anything built on logical decoding unless the plugin works around them. `[^lr-restrict]`

Verbatim docs:

- *"The database schema and DDL commands are not replicated."*
- *"Sequence data is not replicated."* (PG18: REPLICA IDENTITY can include sequences indirectly via published-generated-cols. Sequence advances themselves still not in WAL changes.)
- *"Large objects (see Chapter 35) are not replicated. There is no workaround for that, other than storing data in normal tables."*
- *"Replication is only possible from base tables to base tables. … The tables on both the publication and subscription side must have the same fully qualified name."*

Custom plugin can capture DDL via event triggers + `pg_logical_emit_message` but the decoded stream then carries logical messages, not DDL records.

## pgoutput (built-in)

Native logical replication's output plugin. Compiled into the server. Cannot be missing.

Wire format documented in **`protocol-logicalrep-message-formats.html`** — not on the pgoutput page (which is the docs slug, but the actual content is the message catalog under protocol docs). `[^lr-msg]`

Options passed at `CREATE_REPLICATION_SLOT … LOGICAL pgoutput`:

| Option | Purpose | PG version |
|---|---|---|
| `proto_version` | Protocol version (1, 2, 3, 4) | 1=PG10+, 2=PG14+ (streaming), 3=PG15+ (2PC subscriber), 4=PG16+ (parallel apply) |
| `publication_names` | Comma-separated publication names | PG10+ |
| `binary` | Send values in binary representation | PG14+ |
| `messages` | Send `pg_logical_emit_message` messages | PG14+ |
| `streaming` | Stream in-progress transactions (`on` / `parallel` PG16+) | PG14+ |
| `two_phase` | Decode 2PC | PG15+ |
| `origin` | Filter by origin (`any` / `none`) | PG16+ |

For protocol message types (Begin / Commit / Origin / Relation / Type / Insert / Update / Delete / Truncate / Message / Stream\* / Begin Prepare / Prepare / Commit Prepared / Rollback Prepared), see `protocol-logicalrep-message-formats.html`.

## test_decoding (contrib)

Verbatim docs: *"test_decoding is an example of a logical decoding output plugin. It doesn't do anything especially useful, but can serve as a starting point for developing your own output plugin."* `[^test-decoding]`

Emits SQL-like text. Designed for diagnostics + plugin-author reference. Not for production CDC.

Install (PG13+ trusted extension cross-reference `69-extensions.md`):

    CREATE EXTENSION IF NOT EXISTS test_decoding;
    SELECT pg_create_logical_replication_slot('debug_slot', 'test_decoding');

Read changes (commit them in another session first):

    SELECT * FROM pg_logical_slot_peek_changes('debug_slot', NULL, NULL);
    --   lsn    | xid |                         data
    -- --------+-----+--------------------------------------------------------
    --  0/1A23 | 543 | BEGIN 543
    --  0/1A24 | 543 | table public.orders: INSERT: id[integer]:1 amount[numeric]:100.00
    --  0/1A25 | 543 | COMMIT 543

Options: `include-xids`, `include-timestamp`, `skip-empty-xacts`, `include-origin`. All boolean (`'0'` / `'1'`).

## pg_recvlogical CLI

Standalone consumer for logical slots. Lives in `app-pgrecvlogical.html`. `[^pg-recvlogical]`

Common use:

    # Create slot bound to test_decoding
    pg_recvlogical --create-slot --slot=audit_slot --dbname=mydb \
                   --plugin=test_decoding

    # Stream changes to stdout (run until interrupted)
    pg_recvlogical --start --slot=audit_slot --dbname=mydb \
                   --file=- --option=include-xids=0

    # Drop slot
    pg_recvlogical --drop-slot --slot=audit_slot --dbname=mydb

> [!NOTE] PostgreSQL 18
> Verbatim release note: *"Add pg_recvlogical option `--enable-failover` to create slots that survive failover (Hayato Kuroda)."* Also adds `--enable-two-phase` synonym for `--two-phase`. `[^pg18-recvlogical]`

`--file=-` writes to stdout. `--file=/path/to/log` rotates if size limit reached. Sends Standby Status Updates on `--status-interval=N` seconds (default 10).

## Third-party output plugins

| Plugin | Repo | Format | Maintained for |
|---|---|---|---|
| `wal2json` | https://github.com/eulerto/wal2json | JSON (full row or change-only) | All current PG majors |
| `decoderbufs` | https://github.com/debezium/postgres-decoderbufs | Protocol Buffers | Debezium |
| `pglogical_output` | https://github.com/2ndQuadrant/pglogical_output | Custom binary | Legacy pre-pgoutput; deprecated for new work |

`wal2json` is the de-facto choice for JSON CDC: emits format-version 1 (one JSON object per transaction) or format-version 2 (one per change). Stable, version-pinned releases.

`decoderbufs` is the Debezium connector's preferred plugin for PG ≤ 11; Debezium ≥ 1.x can use `pgoutput` instead — preferred for newer deployments.

## Per-version Timeline

| Version | Changes |
|---|---|
| **PG14** | (8) Streaming in-progress transactions + `stream_*` callbacks (Dilip Kumar et al.); two-phase decoding API + `*_prepared` callbacks (Ajin Cherian et al.); cache-invalidation WAL on command completion (Dilip Kumar, Tomas Vondra, Amit Kapila); efficient invalidation processing (Dilip Kumar); option to control whether logical messages reach the stream (David Pirotte, Euler Taveira); binary mode for subscriptions (Dave Cramer); decode-filter by xid (Markus Wanner); pgoutput `streaming` option `[^pg14-stream]` `[^pg14-2pc]` |
| **PG15** | (3) Two-phase prepared transactions on subscriber side + `CREATE_REPLICATION_SLOT … TWO_PHASE` + `pg_recvlogical --two-phase` (Peter Smith et al.); prevent empty-transaction replication (Ajin Cherian, Hou Zhijie, Euler Taveira); `pg_ls_replslotdir()` (Bharath Rupireddy) `[^pg15-2pc]` |
| **PG16** | (7) **Logical decoding on standbys** (Bertrand Drouvot, Andres Freund, Amit Khandekar); `pg_log_standby_snapshot()`; `debug_logical_replication_streaming` (Shi Yu); binary initial table sync (Melih Mutlu); parallel apply (Hou Zhijie, Wang Wei, Amit Kapila); apply-without-PK performance (Onder Kalaci); pgoutput `origin=none` filter (Vignesh C, Amit Kapila) `[^pg16-standby]` |
| **PG17** | (5) Subtransaction-heavy decoding performance (Masahiko Sawada); **failover of logical slots** (Hou Zhijie, Shveta Malik, Ajin Cherian); `sync_replication_slots` GUC; `synchronized_standby_slots` GUC; `pg_sync_replication_slots()` (Hou Zhijie, Shveta Malik, Ajin Cherian, Peter Eisentraut) `[^pg17-failover]` |
| **PG18** | (6) `idle_replication_slot_timeout` (Nisha Moond, Bharath Rupireddy); `max_active_replication_origins` decouples from `max_replication_slots` (Euler Taveira); `pg_recvlogical --enable-failover` (Hayato Kuroda); `ALTER SUBSCRIPTION` can change slot 2PC behavior; `pg_recvlogical --enable-two-phase` synonym; `pg_createsubscriber --enable-two-phase` (Shubham Khanna) `[^pg18-recvlogical]` |

**Every PG14-18 version contributed substantive items** to the logical decoding surface.

## Examples / Recipes

### Recipe 1: Inspect changes via test_decoding

In session A:

    -- Install + create slot
    CREATE EXTENSION IF NOT EXISTS test_decoding;
    SELECT pg_create_logical_replication_slot('debug_slot', 'test_decoding');

    -- Generate some changes
    CREATE TABLE orders (id serial PRIMARY KEY, amount numeric);
    INSERT INTO orders (amount) VALUES (100.00), (200.00);
    UPDATE orders SET amount = 150.00 WHERE id = 1;

In session B (or same):

    SELECT lsn, xid, data
    FROM pg_logical_slot_peek_changes('debug_slot', NULL, NULL,
                                       'include-xids', '0',
                                       'skip-empty-xacts', '1');
    --  lsn  | xid |                            data
    -- ------+-----+------------------------------------------------------------
    -- 0/.. | 543 | BEGIN
    -- 0/.. | 543 | table public.orders: INSERT: id[integer]:1 amount[numeric]:100.00
    -- 0/.. | 543 | table public.orders: INSERT: id[integer]:2 amount[numeric]:200.00
    -- 0/.. | 543 | COMMIT

Cleanup:

    SELECT pg_drop_replication_slot('debug_slot');
    DROP TABLE orders;

### Recipe 2: Inspect changes via pg_recvlogical (CLI)

    pg_recvlogical --create-slot --slot=cli_slot --dbname=mydb \
                   --plugin=test_decoding

    # Stream until Ctrl-C
    pg_recvlogical --start --slot=cli_slot --dbname=mydb --file=- \
                   --option=include-xids=0 --option=skip-empty-xacts=1

    pg_recvlogical --drop-slot --slot=cli_slot --dbname=mydb

### Recipe 3: Stream via Streaming Replication Protocol (Python)

    import psycopg
    from psycopg.replication import LogicalReplicationConnection

    conn = psycopg.Connection.connect(
        "host=primary dbname=mydb user=replicator replication=database"
    )
    cur = conn.cursor()
    cur.create_replication_slot("py_slot", output_plugin="test_decoding")

    cur.start_replication(slot_name="py_slot",
                          options={"include-xids": "0"})

    def consume(msg):
        print(msg.payload)
        msg.cursor.send_feedback(flush_lsn=msg.data_start)

    try:
        cur.consume_stream(consume)
    except KeyboardInterrupt:
        cur.drop_replication_slot("py_slot")

`send_feedback(flush_lsn=...)` ACKs the slot, freeing WAL. **Without ACK, the slot retains WAL indefinitely** — cross-reference `75-replication-slots.md` gotcha #1.

### Recipe 4: Set REPLICA IDENTITY for tables without PK

Decoding UPDATE / DELETE on a PK-less table requires a unique not-null index OR `REPLICA IDENTITY FULL`.

    -- Table without PK
    CREATE TABLE sessions (
        token bytea NOT NULL UNIQUE,
        user_id int NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Pick the unique not-null index as replica identity
    ALTER TABLE sessions REPLICA IDENTITY USING INDEX sessions_token_key;

    -- Or, if no acceptable index exists, fall back to FULL (high WAL volume):
    -- ALTER TABLE sessions REPLICA IDENTITY FULL;

    -- Verify
    SELECT relname, CASE relreplident
                     WHEN 'd' THEN 'DEFAULT'
                     WHEN 'n' THEN 'NOTHING'
                     WHEN 'f' THEN 'FULL'
                     WHEN 'i' THEN 'USING INDEX'
                   END AS replica_identity
    FROM pg_class
    WHERE relname = 'sessions';

### Recipe 5: Find tables that will silently lose UPDATE / DELETE from decoding

    SELECT n.nspname || '.' || c.relname AS table_name,
           CASE c.relreplident
             WHEN 'd' THEN 'DEFAULT (needs PK)'
             WHEN 'n' THEN 'NOTHING'
             WHEN 'f' THEN 'FULL'
             WHEN 'i' THEN 'USING INDEX'
           END AS replica_identity,
           EXISTS (SELECT 1 FROM pg_index i
                   WHERE i.indrelid = c.oid AND i.indisprimary) AS has_pk
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ((c.relreplident = 'd' AND NOT EXISTS (
              SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.oid AND i.indisprimary))
           OR c.relreplident = 'n')
    ORDER BY table_name;

Any row returned is a table whose UPDATE / DELETE will not appear in decoded streams.

### Recipe 6: Raise logical_decoding_work_mem for bulk-write workload

    -- Cluster-wide (postmaster context — reload, not restart)
    ALTER SYSTEM SET logical_decoding_work_mem = '256MB';
    SELECT pg_reload_conf();

    -- Verify
    SHOW logical_decoding_work_mem;

Effect on existing walsenders: takes effect on next walsender start. Existing logical-decoding sessions continue with their prior value until reconnect.

### Recipe 7: Monitor decoding spill via pg_stat_replication_slots (PG14+)

    SELECT slot_name,
           spill_txns, spill_count, spill_bytes,
           stream_txns, stream_count, stream_bytes,
           total_txns, total_bytes
    FROM pg_stat_replication_slots
    WHERE slot_type = 'logical';

`spill_*` non-zero → transactions exceeded `logical_decoding_work_mem`. Raise the GUC OR enable streaming on consumer.

### Recipe 8: Emit a custom logical message

    -- Producer
    SELECT pg_logical_emit_message(true, 'my_prefix', 'arbitrary payload');

    -- Consumer (test_decoding)
    SELECT data FROM pg_logical_slot_peek_changes('debug_slot', NULL, NULL,
                                                    'include-xids', '0');
    --  data
    -- ------------------------------------------------------
    --  BEGIN
    --  message: transactional: 1 prefix: my_prefix, sz: 17 ...
    --  COMMIT

`pg_logical_emit_message(transactional, prefix, content)` injects an arbitrary message into the WAL stream. Custom plugins can decode + emit it; pgoutput emits it as a `Message` protocol message if `messages = true` option set.

Use cases: DDL audit (event trigger emits message), application-level logical checkpoints, custom CDC events.

### Recipe 9: PG16+ logical decoding on standbys

> [!NOTE] PostgreSQL 16

Pre-PG16: logical decoding only on primary. Post-PG16: standbys can host logical slots, offloading decoding work from primary.

    -- On the standby (read-only, but can host logical slots)
    SELECT pg_create_logical_replication_slot('standby_audit', 'pgoutput');

Requires: primary has `wal_level = logical`; standby has same; primary executes `pg_log_standby_snapshot()` periodically (or the snapshot is captured naturally) so the standby can produce a consistent decoding starting point. `[^pg16-standby]`

### Recipe 10: PG17+ failover slot setup

> [!NOTE] PostgreSQL 17

Cross-reference `75-replication-slots.md` Recipe 7. Logical slot survives failover to a physical standby promoted to primary.

On primary:

    -- Create logical slot with failover enabled
    SELECT pg_create_logical_replication_slot(
        'durable_slot', 'pgoutput', false, false, true
    );  -- last arg: failover = true

    -- Configure standby slot names that participate in sync
    ALTER SYSTEM SET synchronized_standby_slots = 'physical_standby_slot';
    SELECT pg_reload_conf();

On standby:

    ALTER SYSTEM SET sync_replication_slots = on;
    -- restart, then standby walreceiver syncs failover slots

### Recipe 11: Diagnose stuck decoding — find the binding transaction

    -- Walsender process holding the slot
    SELECT s.pid, s.usename, s.application_name, s.state,
           s.backend_xmin, a.query, a.query_start
    FROM pg_stat_replication s
    LEFT JOIN pg_stat_activity a ON a.pid = s.pid
    WHERE s.application_name LIKE '%logical%';

    -- Long-running transactions that could be pinning catalog_xmin
    SELECT pid, usename, state, xact_start, query
    FROM pg_stat_activity
    WHERE backend_xmin IS NOT NULL
      AND state != 'idle'
    ORDER BY xact_start ASC NULLS LAST
    LIMIT 10;

If a transaction is holding `catalog_xmin` back, VACUUM cannot clean catalog tuples that the logical decoder might still need — cross-reference `75-replication-slots.md` gotcha #6 and `27-mvcc-internals.md`.

### Recipe 12: Capture DDL via event trigger + logical message

```sql
CREATE FUNCTION ddl_to_logical_message() RETURNS event_trigger AS $$
DECLARE
    cmd record;
BEGIN
    FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        PERFORM pg_logical_emit_message(
            true,
            'ddl',
            format('{"type":"%s","schema":"%s","object":"%s","sql":"%s"}',
                   cmd.command_tag,
                   cmd.schema_name,
                   cmd.object_identity,
                   current_query())
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER ddl_capture ON ddl_command_end
EXECUTE FUNCTION ddl_to_logical_message();
```

DDL fired on primary → event trigger emits logical message → message decoded through any logical slot with `messages = on` (or test_decoding). Consumer sees DDL alongside row changes.

Workaround for the DDL-not-replicated restriction. Cross-reference `40-event-triggers.md`.

## Gotchas / Anti-patterns

1. **DDL not decoded.** Verbatim docs: *"The database schema and DDL commands are not replicated."* Use event-trigger + logical-message workaround (Recipe 12). `[^lr-restrict]`

2. **Sequences not decoded.** Sequence advance is not a WAL record decoded as a change. Replicate via periodic sync.

3. **Large objects not decoded.** Verbatim docs: *"Large objects … are not replicated. There is no workaround for that, other than storing data in normal tables."* Use `bytea` columns.

4. **REPLICA IDENTITY DEFAULT + no PK = silent UPDATE / DELETE drop.** Decoder cannot identify row. Run Recipe 5 to audit.

5. **`pg_logical_slot_get_changes` consumes changes — `peek` does not.** Calling `_get_` while a real consumer is attached silently swallows changes from that consumer.

6. **Plugin name is the `.so` basename without extension.** `wal2json.so` → plugin name `wal2json`.

7. **Cannot change plugin without recreating slot.** Plugin binding is permanent for the slot's lifetime.

8. **Slot creation requires connection to a specific database — OR — `immediately_reserve=true` for physical-only.** Logical slots are per-database.

9. **`logical_decoding_work_mem` is per-walsender, not cluster-wide.** N walsenders → up to N × value committed RAM.

10. **Spilling to `pg_replslot/` fills disk under bursty bulk writes.** Mitigate via `logical_decoding_work_mem` raise OR PG14+ streaming.

11. **`pg_recvlogical --start` without `--endpos` runs forever.** SIGINT to stop. Doesn't drop the slot — call `--drop-slot` separately.

12. **`pg_create_logical_replication_slot` cannot run inside a transaction block.** Same restriction as `CREATE SUBSCRIPTION`.

13. **Walsender process consumes a connection slot.** Counts against `max_wal_senders`, not `max_connections`.

14. **`max_replication_slots` is the cap; default is 10.** Restart-only GUC. Cross-reference `75-replication-slots.md` gotcha #9.

15. **DDL / sequence / LO restrictions live in `logical-replication-restrictions.html`, NOT under the logical decoding chapter.** Easy to miss when reading only `logicaldecoding.html`.

16. **`logical_decoding_work_mem` is on `runtime-config-resource.html`, NOT `runtime-config-wal.html`.** Resource Consumption, not Write-Ahead Log. Frequent docs-URL mistake.

17. **`logicaldecoding-restrictions.html` returns 404.** No such page exists. Restrictions are at `logical-replication-restrictions.html`.

18. **PG17 renumbered the chapter from 49 to 47.** Don't cite chapter number across versions. Cite URL slug (`logicaldecoding.html`).

19. **`pg_recvlogical --two-phase` deprecated PG18+.** New spelling is `--enable-two-phase`. Old flag still works for now.

20. **PG14 streaming requires plugin support.** `streaming = on` to a plugin without `stream_*` callbacks errors out at slot start.

21. **`twophase` slot option (PG14+) does NOT make decoding 2PC-aware retroactively.** Slot must be created with `twophase = true`; cannot toggle on existing slot pre-PG18.

22. **PG14 binary mode (`binary = true`) requires both sides on same PG major.** Binary output formats are version-specific.

23. **`pg_logical_emit_message(transactional=false, ...)` flushes even on transaction abort.** Non-transactional messages bypass the abort path — useful for hard logging, dangerous for state machines that assume rollback semantics.

## See Also

- [`74-logical-replication.md`](./74-logical-replication.md) — user-facing CREATE PUBLICATION / SUBSCRIPTION model built on logical decoding
- [`75-replication-slots.md`](./75-replication-slots.md) — slot lifecycle, retention, invalidation, failover slots
- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical replication; `wal_level = logical` configuration
- [`33-wal.md`](./33-wal.md) — `wal_level` setting (`logical` required for logical decoding)
- [`40-event-triggers.md`](./40-event-triggers.md) — DDL capture workaround for the DDL-not-replicated restriction
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_replication_slots` view, walsender wait events
- [`72-extension-development.md`](./72-extension-development.md) — writing a custom output plugin (C extension)
- [`46-roles-privileges.md`](./46-roles-privileges.md) — REPLICATION role attribute required for slot management
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — `replication=database` connection type required for logical decoding slots in `pg_hba.conf`
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — `catalog_xmin` retention for logical slots
- [`63-internals-architecture.md`](./63-internals-architecture.md) — walsender process model

## Sources

[^lc-explain]: PostgreSQL 16 — Logical Decoding Concepts. https://www.postgresql.org/docs/16/logicaldecoding-explanation.html

[^lc-output-plugin]: PostgreSQL 16 — Logical Decoding Output Plugins. https://www.postgresql.org/docs/16/logicaldecoding-output-plugin.html (callback catalog; verbatim required-vs-optional rules)

[^lc-walsender]: PostgreSQL 16 — Streaming Replication Protocol Interface (slug `logicaldecoding-walsender.html`). https://www.postgresql.org/docs/16/logicaldecoding-walsender.html

[^lc-sql]: PostgreSQL 16 — Logical Decoding SQL Interface. https://www.postgresql.org/docs/16/logicaldecoding-sql.html

[^lc-streaming]: PostgreSQL 16 — Streaming of Large In-Progress Transactions. https://www.postgresql.org/docs/16/logicaldecoding-streaming.html

[^lc-2pc]: PostgreSQL 16 — Two-Phase Commit Support for Logical Decoding. https://www.postgresql.org/docs/16/logicaldecoding-two-phase-commit.html

[^lc-sync]: PostgreSQL 16 — Synchronous Replication Support for Logical Decoding. https://www.postgresql.org/docs/16/logicaldecoding-synchronous.html

[^lc-mem]: PostgreSQL 16 — `logical_decoding_work_mem` GUC at `runtime-config-resource.html`. https://www.postgresql.org/docs/16/runtime-config-resource.html#GUC-LOGICAL-DECODING-WORK-MEM

[^replica-identity]: PostgreSQL 16 — `ALTER TABLE ... REPLICA IDENTITY` clause. https://www.postgresql.org/docs/16/sql-altertable.html

[^alter-table]: PostgreSQL 16 — `ALTER TABLE` reference. https://www.postgresql.org/docs/16/sql-altertable.html

[^lr-restrict]: PostgreSQL 16 — Restrictions on logical replication (covers logical decoding too). https://www.postgresql.org/docs/16/logical-replication-restrictions.html (verbatim quotes for DDL / sequence / large-object restrictions)

[^lr-msg]: PostgreSQL 16 — Logical Replication Message Formats (pgoutput wire format). https://www.postgresql.org/docs/16/protocol-logicalrep-message-formats.html

[^test-decoding]: PostgreSQL 16 — test_decoding contrib module. https://www.postgresql.org/docs/16/test-decoding.html (verbatim "starting point for developing your own output plugin" quote)

[^pg-recvlogical]: PostgreSQL 16 — pg_recvlogical reference. https://www.postgresql.org/docs/16/app-pgrecvlogical.html

[^pg14-stream]: PostgreSQL 14 release notes — streaming of large in-progress transactions to subscribers (Dilip Kumar, Amit Kapila, Ajin Cherian, Tomas Vondra, Nikhil Sontakke, Stas Kelvich). https://www.postgresql.org/docs/release/14.0/

[^pg14-2pc]: PostgreSQL 14 release notes — decoding of two-phase prepared transactions API (Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). https://www.postgresql.org/docs/release/14.0/

[^pg15-2pc]: PostgreSQL 15 release notes — two-phase prepared transactions on subscriber side + `CREATE_REPLICATION_SLOT … TWO_PHASE` + `pg_recvlogical --two-phase` (Peter Smith, Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). https://www.postgresql.org/docs/release/15.0/

[^pg16-standby]: PostgreSQL 16 release notes — logical decoding on standbys (Bertrand Drouvot, Andres Freund, Amit Khandekar). https://www.postgresql.org/docs/release/16.0/

[^pg17-failover]: PostgreSQL 17 release notes — failover of logical slots, `sync_replication_slots`, `synchronized_standby_slots`, `pg_sync_replication_slots()` (Hou Zhijie, Shveta Malik, Ajin Cherian, Peter Eisentraut). https://www.postgresql.org/docs/release/17.0/

[^pg18-recvlogical]: PostgreSQL 18 release notes — `pg_recvlogical --enable-failover`, `--enable-two-phase` synonym (Hayato Kuroda); `pg_createsubscriber --enable-two-phase` (Shubham Khanna). https://www.postgresql.org/docs/release/18.0/

[^pg18-2pc]: PostgreSQL 18 release notes — `ALTER SUBSCRIPTION` can change slot 2PC behavior (Hayato Kuroda, Ajin Cherian, Amit Kapila, Zhijie Hou). https://www.postgresql.org/docs/release/18.0/

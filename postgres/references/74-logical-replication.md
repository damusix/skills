# Logical Replication

Row-level change replication via WAL decoding. Publisher emits changes per table; subscriber applies. DDL not replicated. Schema sync = manual.

> [!WARNING]
> **Logical replication ships row changes, not DDL.** Schema changes on publisher do NOT propagate. Adding a column on the publisher without first adding it on the subscriber breaks the apply worker. Use `--no-schema-only` `pg_dump` or hand-managed migrations to sync DDL ahead of the publisher writes.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Publication](#publication)
    - [Subscription](#subscription)
    - [Row filters (PG15+)](#row-filters-pg15)
    - [Column lists (PG15+)](#column-lists-pg15)
    - [FOR TABLES IN SCHEMA (PG15+)](#for-tables-in-schema-pg15)
    - [Two-phase commit decoding (PG14+) and subscriber (PG15+)](#two-phase-commit-decoding-pg14-and-subscriber-pg15)
    - [Streaming in-progress transactions](#streaming-in-progress-transactions)
    - [Origin filtering (PG16+) — bidirectional replication](#origin-filtering-pg16--bidirectional-replication)
    - [REPLICA IDENTITY](#replica-identity)
    - [Configuration GUCs](#configuration-gucs)
    - [Process model](#process-model)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use for `CREATE PUBLICATION` / `CREATE SUBSCRIPTION` grammar, row filters, column lists, conflict handling, bidirectional setup, `pg_createsubscriber` (PG17+), failover slots (PG17+), apply-worker monitoring, version-introduced surface. Pair with [`73-streaming-replication.md`](./73-streaming-replication.md) for physical replication and [`75-replication-slots.md`](./75-replication-slots.md) for slot lifecycle (logical + physical share slot mechanics). [`76-logical-decoding.md`](./76-logical-decoding.md) covers the output-plugin author surface; this file is the user-facing publisher/subscriber view.

## Mental Model

Five rules:

1. **Logical replication ships row-level changes (INSERT / UPDATE / DELETE / TRUNCATE) decoded from WAL via an output plugin.** Default plugin = `pgoutput` (built-in, used for `pgoutput` protocol — the wire format `CREATE SUBSCRIPTION` consumes). Publisher side = PUBLICATION (what gets sent). Subscriber side = SUBSCRIPTION (what gets consumed). Verbatim docs: *"Logical replication is a method of replicating data objects and their changes, based upon their replication identity (usually a primary key). We use the term logical in contrast to physical replication, which uses exact block addresses and byte-by-byte replication."*[^lr-intro]

2. **DDL is NOT replicated. Sequence-state changes are NOT replicated. Large Objects are NOT replicated.** Schema, sequence advances, LOs must be synced out-of-band. Verbatim docs: *"The database schema and DDL commands are not replicated. ... Sequence data is not replicated. The data in serial or identity columns backed by sequences will of course be replicated as part of the table, but the sequence itself would still show the start value on the subscriber. ... Large objects (see Chapter 35) are not replicated. There is no workaround for that, other than storing data in normal tables."*[^lr-restrictions]

3. **Conflicts BLOCK the apply worker. No automatic resolution.** Subscriber-side row missing where publisher expects it = log message + retry forever. Subscriber-side row violates a constraint = apply worker stops. Fix manually (advance LSN via `ALTER SUBSCRIPTION ... SKIP`, edit subscriber row, or replay carefully). PG18 logs the conflicting tuple values into `pg_stat_subscription_stats`.

4. **REPLICA IDENTITY decides what identifies a row over the wire.** Default = PK. No PK = need explicit `REPLICA IDENTITY USING INDEX <unique_not_null_index>` or `REPLICA IDENTITY FULL` (slow — sends every column to find matches). `REPLICA IDENTITY NOTHING` blocks `UPDATE` and `DELETE` replication.

5. **Subscription apply worker runs as table owner per-DML (PG16+ secure default).** Pre-PG16: ran as subscription owner. PG16+: switches role per table to table owner. Opt-out via `CREATE SUBSCRIPTION (run_as_owner = true)` — exists since PG15 but PG16 made not-`run_as_owner` the default. Verbatim PG16: *"Perform logical replication SELECT and DML actions as the table owner. ... The previous behavior of performing all operations as the subscription owner can be enabled with the subscription run_as_owner option."*[^pg16-rao]

## Decision Matrix

| You want | Use | Avoid | Why |
|---|---|---|---|
| Replicate one or few tables across clusters | `CREATE PUBLICATION` + `CREATE SUBSCRIPTION` | Physical streaming | Physical sends ALL data + system catalogs |
| Replicate whole-cluster including DDL | Streaming + standby + failover | Logical | DDL not replicated by logical |
| Replicate to a different major version | Logical replication | pg_upgrade | Logical works cross-version (subscriber must be same-or-newer) |
| Zero-downtime major upgrade | Logical replication | pg_upgrade (downtime) | Spin up new-version subscriber, switch traffic |
| Subset of rows | Row filter (PG15+) | Subscribing then deleting | Filter happens publisher-side; less wire traffic |
| Subset of columns | Column list (PG15+) | View then publish view | Views not publishable |
| Per-schema replication | `FOR TABLES IN SCHEMA` (PG15+) | Per-table grants | Auto-includes future tables in schema |
| Bidirectional (two-way) | PG16+ with `origin = none` | Pre-PG16 (loops) | PG16 origin filter breaks the replication loop |
| Convert standby into subscriber | `pg_createsubscriber` (PG17+) | Stop standby + dump+restore | One command, preserves data, switches role |
| HA: subscriber survives publisher failover | PG17+ failover slots + `synchronized_standby_slots` | Manual slot recreation | Slot syncs to standbys so promotion preserves it |
| Conflict resolution | Application logic | Built-in CRDT | PG has no built-in conflict resolver — apply blocks |

Smell signals:

- "Apply worker stuck at LSN X" with row missing → conflict (no auto-resolve). Investigate via `pg_stat_subscription_stats` (PG15+) and server log.
- DROP SUBSCRIPTION hangs → replication slot still associated. Use `ALTER SUBSCRIPTION ... DISABLE` then `SET (slot_name = NONE)` then `DROP SUBSCRIPTION`. Manually drop the slot on the publisher.
- "Replication slot keeps growing" → subscriber disconnected; publisher retains WAL indefinitely. See [`75-replication-slots.md`](./75-replication-slots.md) `max_slot_wal_keep_size`.

## Syntax / Mechanics

### Publication

```sql
CREATE PUBLICATION pub_name
    [ FOR ALL TABLES
      | FOR publication_object [, ...]
      | FOR TABLES IN SCHEMA schema_name [, ...] ]
    [ WITH (option [= value] [, ...]) ];
```

Where `publication_object` is:

```sql
TABLE [ ONLY ] table_name [ * ] [ ( column_list ) ] [ WHERE ( row_filter ) ]
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `publish` | `'insert, update, delete, truncate'` | Which DML to publish |
| `publish_via_partition_root` | `false` | Publish partition writes via root table |
| `publish_generated_columns` | `false` (PG18+) | Replicate generated column values |

ALTER PUBLICATION forms:

```sql
ALTER PUBLICATION pub_name ADD TABLE t1, t2;
ALTER PUBLICATION pub_name DROP TABLE t1;
ALTER PUBLICATION pub_name SET TABLE t1, t2 WHERE (status = 'active');
ALTER PUBLICATION pub_name ADD TABLES IN SCHEMA s1;       -- PG15+
ALTER PUBLICATION pub_name SET (publish_via_partition_root = true);
ALTER PUBLICATION pub_name OWNER TO new_owner;
ALTER PUBLICATION pub_name RENAME TO new_name;
```

`pg_publication_tables` view shows the resolved table list (after `FOR ALL TABLES` / `FOR TABLES IN SCHEMA` expansion) plus per-table row filter + column list.

### Subscription

```sql
CREATE SUBSCRIPTION sub_name
    CONNECTION 'conninfo'
    PUBLICATION pub_name [, ...]
    [ WITH (option [= value] [, ...]) ];
```

Common options:

| Option | Default | Meaning |
|---|---|---|
| `connect` | `true` | If `false`: do not connect immediately; useful for slot pre-creation |
| `enabled` | `true` | Whether apply worker starts |
| `create_slot` | `true` | Create logical replication slot on publisher |
| `slot_name` | sub_name | Slot name on publisher (NULL = none, must already exist) |
| `copy_data` | `true` | Initial COPY of existing rows before streaming |
| `binary` | `false` | Use binary wire format (faster, less robust) |
| `streaming` | `parallel` (PG18+) / `off` (≤PG17) | Stream large transactions |
| `synchronous_commit` | `off` | Per-subscription override |
| `two_phase` | `false` | Apply prepared transactions on subscriber (PG15+) |
| `disable_on_error` | `false` | Disable subscription on apply error |
| `password_required` | `true` | Allow non-password conn for non-superuser owners (PG16+) |
| `run_as_owner` | `false` (PG16+ default) | Run apply as subscription owner instead of table owner |
| `origin` | `any` | `none` filters out remotely-originated changes (PG16+ for bidirectional) |
| `failover` | `false` (PG17+) | Slot syncs to physical standbys for failover (PG17+) |

ALTER SUBSCRIPTION forms:

```sql
ALTER SUBSCRIPTION sub_name CONNECTION 'new_conninfo';
ALTER SUBSCRIPTION sub_name SET PUBLICATION pub_a, pub_b;
ALTER SUBSCRIPTION sub_name ADD PUBLICATION pub_c;             -- PG14+
ALTER SUBSCRIPTION sub_name DROP PUBLICATION pub_b;            -- PG14+
ALTER SUBSCRIPTION sub_name REFRESH PUBLICATION;
ALTER SUBSCRIPTION sub_name ENABLE;
ALTER SUBSCRIPTION sub_name DISABLE;
ALTER SUBSCRIPTION sub_name SET (slot_name = NONE);
ALTER SUBSCRIPTION sub_name SKIP (lsn = '0/1234ABCD');         -- PG15+
ALTER SUBSCRIPTION sub_name OWNER TO new_owner;
```

DROP SUBSCRIPTION caveat — verbatim docs: *"DROP SUBSCRIPTION cannot be executed inside a transaction block if the subscription is associated with a replication slot. (You can use ALTER SUBSCRIPTION to unset the slot.)"*[^dropsub] Safe-drop sequence when publisher unreachable:

```sql
ALTER SUBSCRIPTION sub_name DISABLE;
ALTER SUBSCRIPTION sub_name SET (slot_name = NONE);
DROP SUBSCRIPTION sub_name;
-- THEN manually drop slot on publisher:
-- SELECT pg_drop_replication_slot('sub_name');
```

### Row filters (PG15+)

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow publication content to be filtered using a WHERE clause (Hou Zhijie, Euler Taveira, Peter Smith, Ajin Cherian, Tomas Vondra, Amit Kapila). Rows not satisfying the WHERE clause are not published."*[^pg15-rowfilter]

```sql
CREATE PUBLICATION orders_active
    FOR TABLE orders WHERE (status IN ('open', 'pending'));
```

Restrictions (verbatim docs):

- *"The WHERE clause allows only simple expressions. It cannot contain user-defined functions, operators, types, and collations, system column references or non-immutable built-in functions."*[^lr-rowfilter]
- *"If a publication publishes UPDATE or DELETE operations, the row filter WHERE clause must contain only columns that are covered by the replica identity."*[^lr-rowfilter] So with `REPLICA IDENTITY DEFAULT` (PK), only PK columns may appear in the WHERE for an UPDATE/DELETE-publishing publication.

Row filter applies AFTER the row is decoded. If an UPDATE changes the row from passing-the-filter to not-passing-the-filter, the UPDATE is sent as a DELETE on the subscriber.

### Column lists (PG15+)

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow publication content to be restricted to specific columns (Tomas Vondra, Álvaro Herrera, Rahila Syed)."*[^pg15-collist]

```sql
CREATE PUBLICATION pub_pii_safe
    FOR TABLE users (id, username, created_at);
```

Listed columns must include every REPLICA IDENTITY column (PK or unique index columns). Omitted columns simply do not flow to subscriber; subscriber table can have additional columns the publisher does not send (they keep DEFAULT or NULL).

### FOR TABLES IN SCHEMA (PG15+)

> [!NOTE] PostgreSQL 15
> Verbatim: *"Allow publication of all tables in a schema (Vignesh C, Hou Zhijie, Amit Kapila). For example, this syntax is now supported: CREATE PUBLICATION pub1 FOR TABLES IN SCHEMA s1,s2. ALTER PUBLICATION supports a similar syntax. Tables added later to the listed schemas will also be replicated."*[^pg15-schema]

```sql
CREATE PUBLICATION pub_app FOR TABLES IN SCHEMA app, billing;
```

Tables added to `app` or `billing` later get auto-included. Combine with individual `FOR TABLE` for mixed scope:

```sql
CREATE PUBLICATION pub_mixed
    FOR TABLES IN SCHEMA app,
        TABLE billing.invoices WHERE (paid = false);
```

### Two-phase commit decoding (PG14+) and subscriber (PG15+)

PG14 added decoding 2PC at the output-plugin layer. PG15 added applying 2PC on the subscriber.

> [!NOTE] PostgreSQL 14
> Verbatim: *"Enhance logical decoding APIs to handle two-phase commits (Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). This is controlled via pg_create_logical_replication_slot()."*[^pg14-2pc]

> [!NOTE] PostgreSQL 15
> Verbatim: *"Add support for prepared (two-phase) transactions to logical replication (Peter Smith, Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). The new CREATE_REPLICATION_SLOT option is called TWO_PHASE."*[^pg15-2pc]

Enable with `WITH (two_phase = true)` on `CREATE SUBSCRIPTION`. Subscriber receives `PREPARE TRANSACTION` then later `COMMIT PREPARED` / `ROLLBACK PREPARED`. Subscriber cluster needs `max_prepared_transactions > 0`.

### Streaming in-progress transactions

Default pre-PG14: large transactions buffered to disk on publisher until COMMIT, then sent in a single batch. PG14+ streams partial transactions as they happen.

> [!NOTE] PostgreSQL 14
> Verbatim: *"Allow logical replication to stream long in-progress transactions to subscribers (Dilip Kumar, Amit Kapila, Ajin Cherian, Tomas Vondra, Nikhil Sontakke, Stas Kelvich). Previously transactions that exceeded logical_decoding_work_mem were written to disk until the transaction completed."*[^pg14-stream]

Three modes for `streaming`:

| Value | Behavior | Version |
|---|---|---|
| `off` | Buffer until COMMIT (legacy) | All |
| `on` | Stream to subscriber, apply at COMMIT | PG14+ |
| `parallel` | Stream + parallel apply workers | PG16+ (default in PG18+) |

> [!NOTE] PostgreSQL 16
> Verbatim: *"Allow parallel application of logical replication (Hou Zhijie, Wang Wei, Amit Kapila). The CREATE SUBSCRIPTION STREAMING option now supports parallel to enable application of large transactions by parallel workers. The number of parallel workers is controlled by the new server variable max_parallel_apply_workers_per_subscription."*[^pg16-parallel]

> [!NOTE] PostgreSQL 18
> Default `streaming` flipped from `off` to `parallel`. Verbatim: *"Change the default CREATE SUBSCRIPTION streaming option from off to parallel (Vignesh C)."*[^pg18-stream-default]

### Origin filtering (PG16+) — bidirectional replication

Without origin filtering, two-way logical replication loops: A→B→A→B→... PG16 added `origin = none` so subscriber only applies changes that did not originate from another logical replication apply worker.

> [!NOTE] PostgreSQL 16
> Verbatim: *"Allow logical replication subscribers to process only changes that have no origin (Vignesh C, Amit Kapila). This can be used to avoid replication loops. This is controlled by the new CREATE SUBSCRIPTION ... ORIGIN option."*[^pg16-origin]

Bidirectional pattern (PG16+):

```sql
-- On node A:
CREATE PUBLICATION pub_a FOR TABLE shared;
CREATE SUBSCRIPTION sub_from_b
    CONNECTION 'host=b dbname=app user=repl password=...'
    PUBLICATION pub_b WITH (origin = none);

-- On node B (mirror):
CREATE PUBLICATION pub_b FOR TABLE shared;
CREATE SUBSCRIPTION sub_from_a
    CONNECTION 'host=a dbname=app user=repl password=...'
    PUBLICATION pub_a WITH (origin = none);
```

No conflict resolution. Concurrent updates to same row on both sides = blocked apply worker.

### REPLICA IDENTITY

Tells the publisher how to identify rows for UPDATE/DELETE. Verbatim grammar from `ALTER TABLE`: `REPLICA IDENTITY { DEFAULT | USING INDEX index_name | FULL | NOTHING }`.

| Mode | Use when |
|---|---|
| `DEFAULT` | Table has primary key (default) |
| `USING INDEX idx` | No PK but has unique, not-null, non-partial, non-deferrable index |
| `FULL` | No suitable unique index. Sends every column. Subscriber-side seq scan (PG16+ can use any btree index instead) |
| `NOTHING` | UPDATE/DELETE replication errors out |

PG16 lifted the FULL-seqscan tax:

> [!NOTE] PostgreSQL 16
> Verbatim: *"Improve performance for logical replication apply without a primary key (Onder Kalaci, Amit Kapila). Specifically, REPLICA IDENTITY FULL can now use btree indexes rather than sequentially scanning the table to find matches."*[^pg16-full]

PG17 added hash-index support too:

> [!NOTE] PostgreSQL 17
> Verbatim: *"Allow the application of logical replication changes to use hash indexes on the subscriber (Hayato Kuroda). Previously only btree indexes could be used for this purpose."*[^pg17-hash]

### Configuration GUCs

Publisher (`postgresql.conf`):

```ini
wal_level = logical                     # MUST. Restart required.
max_replication_slots = 10              # >= number of subscriber slots
max_wal_senders = 12                    # >= max_replication_slots + physical replicas
wal_sender_timeout = 60s
logical_decoding_work_mem = 64MB        # spill threshold
```

Subscriber (`postgresql.conf`):

```ini
max_replication_slots = 5               # for receiving (origin tracking)
max_logical_replication_workers = 8     # apply + tablesync + parallel-apply
max_worker_processes = 16               # must accommodate above + autovacuum
max_sync_workers_per_subscription = 4   # parallelism for initial COPY
max_parallel_apply_workers_per_subscription = 4   # PG16+
```

### Process model

- **Publisher:** one `walsender` per subscriber's slot. Reads WAL, decodes via output plugin, sends pgoutput stream over `replication=database` connection.
- **Subscriber:** one **logical replication launcher** (cluster-wide). For each subscription: one **apply worker** (main). For each tablesync (initial COPY): one **tablesync worker** per table (up to `max_sync_workers_per_subscription`). For streaming=parallel: one or more **parallel apply workers** per subscription (up to `max_parallel_apply_workers_per_subscription`).

Each worker counts against `max_worker_processes`. Budget:

```
max_worker_processes >=
    max_logical_replication_workers
    + autovacuum_max_workers
    + max_parallel_workers
    + 1   (logical replication launcher)
```

Cross-reference [`63-internals-architecture.md`](./63-internals-architecture.md) for the full process budget formula.

### Per-version timeline

> [!NOTE] PostgreSQL 14 — Logical replication
> - Two-phase commit decoding via `pg_create_logical_replication_slot()`[^pg14-2pc].
> - Streaming in-progress transactions (`streaming = on`)[^pg14-stream].
> - `ALTER SUBSCRIPTION ... ADD/DROP PUBLICATION` (verbatim: *"Allow publications to be more easily added to and removed from a subscription (Japin Li)."*[^pg14-addsub]).
> - Binary mode (`WITH (binary = true)`)[^pg14-binary].
> - XID-based filtering for logical decoding (Markus Wanner)[^pg14-xid].

> [!NOTE] PostgreSQL 15 — Logical replication
> - Row filters (`WHERE (...)`)[^pg15-rowfilter].
> - Column lists (`(col1, col2, ...)`)[^pg15-collist].
> - `FOR TABLES IN SCHEMA`[^pg15-schema].
> - Two-phase commit on subscriber (`WITH (two_phase = true)`)[^pg15-2pc].
> - `run_as_owner` subscription option (default `false` here means subscription owner is used; PG16 flipped it)[^pg15-rao].
> - `ALTER SUBSCRIPTION ... SKIP (lsn = '...')` (verbatim: *"Allow skipping of transactions on a subscriber using ALTER SUBSCRIPTION ... SKIP (Masahiko Sawada)."*[^pg15-skip]).
> - `disable_on_error` subscription option[^pg15-doe].
> - `pg_stat_subscription_stats` view[^pg15-stats].

> [!NOTE] PostgreSQL 16 — Logical replication
> - Parallel apply for streaming transactions (`streaming = parallel`)[^pg16-parallel].
> - Logical decoding on physical standbys (verbatim: *"Allow logical decoding on standbys (Bertrand Drouvot, Andres Freund, Amit Khandekar)."*[^pg16-standby]).
> - `pg_create_subscription` predefined role[^pg16-role].
> - `password_required = false` subscription option (for non-password conninfo on non-superuser owners)[^pg16-pwreq].
> - **Origin filtering** (`origin = none`) for bidirectional[^pg16-origin].
> - Binary initial sync[^pg16-binsync].
> - `REPLICA IDENTITY FULL` uses btree on subscriber[^pg16-full].
> - **Apply runs as table owner per-DML by default** (run_as_owner=false default)[^pg16-rao].

> [!NOTE] PostgreSQL 17 — Logical replication
> - `pg_createsubscriber` CLI (convert physical standby to logical subscriber in-place)[^pg17-createsub].
> - **Failover slots:** `failover = true` subscription option + `sync_replication_slots` GUC + `synchronized_standby_slots` GUC + `pg_sync_replication_slots()` function[^pg17-failover].
> - pg_upgrade preserves logical slots and subscriptions (only when old cluster is PG17 or later)[^pg17-pgupgrade].
> - Hash-index support for subscriber apply[^pg17-hash].
> - `pg_replication_slots.invalidation_reason` column[^pg17-invreason].
> - `pg_replication_slots.inactive_since` column[^pg17-inactive].
> - `pg_stat_subscription.worker_type` column[^pg17-worker].
> - Apply worker restarts when subscription owner's superuser status revoked[^pg17-restart].
> - Better subtransaction decoding performance[^pg17-subxact].
> - `pg_logical_emit_message()` gains `flush` option[^pg17-emit].

> [!NOTE] PostgreSQL 18 — Logical replication
> - Generated-column replication (`publish_generated_columns` publication option)[^pg18-gen].
> - **Default `streaming` flipped from `off` to `parallel`** (Vignesh C)[^pg18-stream-default].
> - `ALTER SUBSCRIPTION` can change a slot's two-phase commit behavior[^pg18-alter2pc].
> - **Conflict logging** to server log + new `pg_stat_subscription_stats` columns (`confl_*`)[^pg18-conflicts].
> - `pg_createsubscriber --all`, `--clean`, `--enable-two-phase` flags[^pg18-cs].
> - `pg_recvlogical --enable-failover` (+ `--enable-two-phase` synonym, deprecate `--two-phase`)[^pg18-pgrecv].
> - `idle_replication_slot_timeout` GUC auto-invalidates idle slots[^pg18-idleslot].
> - `max_active_replication_origins` GUC[^pg18-origins].
> - New CREATE SUBSCRIPTION `failover` parameter description quotes the wire-level behavior.

## Examples / Recipes

### Recipe 1 — Baseline single-table publish/subscribe

Publisher:

```sql
-- postgresql.conf: wal_level = logical, max_replication_slots = 10, max_wal_senders = 12

-- replication role
CREATE ROLE repl_user WITH REPLICATION LOGIN PASSWORD 'changeme';
GRANT CONNECT ON DATABASE app TO repl_user;
GRANT USAGE ON SCHEMA public TO repl_user;
GRANT SELECT ON TABLE orders TO repl_user;

-- pg_hba.conf:
-- host    app    repl_user    10.0.0.0/24    scram-sha-256

CREATE PUBLICATION pub_orders FOR TABLE orders;
```

Subscriber:

```sql
-- subscriber must have the table created first (same columns or superset)
CREATE TABLE orders (
    id          bigint PRIMARY KEY,
    customer_id bigint NOT NULL,
    total       numeric(12,2) NOT NULL,
    status      text NOT NULL,
    created_at  timestamptz NOT NULL
);

CREATE SUBSCRIPTION sub_orders
    CONNECTION 'host=10.0.0.5 port=5432 dbname=app user=repl_user password=changeme sslmode=require'
    PUBLICATION pub_orders;

-- monitor
SELECT subid, subname, pid, received_lsn, latest_end_lsn,
       extract(epoch from now() - latest_end_time) AS lag_seconds
  FROM pg_stat_subscription;
```

Initial COPY runs automatically. Apply worker takes over when COPY finishes.

### Recipe 2 — Row filter for tenant-scoped subscription

```sql
-- publisher
CREATE PUBLICATION pub_tenant_42
    FOR TABLE orders WHERE (tenant_id = 42),
        TABLE invoices WHERE (tenant_id = 42);
```

Subscriber gets only rows where `tenant_id = 42`. Row filters and RLS solve different problems: row filter limits what the publisher SENDS (no data leakage over the wire); RLS limits what the subscriber's user SEES after data arrives. See [`47-row-level-security.md`](./47-row-level-security.md) for the RLS mechanics.

### Recipe 3 — Column list to redact PII

```sql
-- omit email, phone, ssn columns
CREATE PUBLICATION pub_users_redacted
    FOR TABLE users (id, username, created_at, last_login);
```

Subscriber needs the same `id` PK column (REPLICA IDENTITY). Extra columns on the subscriber (e.g., `email`) will keep their existing values or NULL.

### Recipe 4 — Bidirectional replication PG16+

```sql
-- Node A
CREATE PUBLICATION pub_a FOR TABLE shared_data;
CREATE SUBSCRIPTION sub_from_b
    CONNECTION 'host=node-b dbname=app user=repl_user password=...'
    PUBLICATION pub_b
    WITH (origin = none, copy_data = false);  -- copy_data false for one side after both schemas in sync

-- Node B
CREATE PUBLICATION pub_b FOR TABLE shared_data;
CREATE SUBSCRIPTION sub_from_a
    CONNECTION 'host=node-a dbname=app user=repl_user password=...'
    PUBLICATION pub_a
    WITH (origin = none, copy_data = false);
```

`origin = none` filters out changes that originated from a replication apply worker, breaking the loop. Insert/update conflicts still possible — no automatic resolver. PG18 conflict logging makes diagnosis tractable.

### Recipe 5 — Zero-downtime major-version upgrade via logical replication

1. Spin up new-major-version cluster (e.g., PG18) with identical schema.
2. Copy globals: `pg_dumpall --globals-only | psql -h new-host`.
3. Copy schema: `pg_dump --schema-only app | psql -h new-host`.
4. On old cluster: `CREATE PUBLICATION pub_all FOR ALL TABLES;`
5. On new cluster: `CREATE SUBSCRIPTION sub_all CONNECTION '...' PUBLICATION pub_all;` — initial COPY runs.
6. Wait for `pg_stat_subscription.received_lsn` to catch up to `pg_current_wal_lsn()` on old cluster.
7. Stop application. Final drain. Sync sequences manually:
   ```sql
   -- on old:
   SELECT 'SELECT setval(''' || sequence_name || ''', ' || last_value || ');'
     FROM information_schema.sequences;
   -- pipe output, execute on new
   ```
8. Repoint application to new cluster.
9. `DROP SUBSCRIPTION sub_all;` on new cluster. Decommission old.

PG17+ can use `pg_createsubscriber` to skip steps 4-6 by converting a physical standby in place.

### Recipe 6 — pg_createsubscriber (PG17+)

Convert an existing physical standby into a logical subscriber without copying data:

```bash
# Stop standby
pg_ctl -D /var/lib/postgresql/18/main stop

# Convert
pg_createsubscriber \
    --pgdata=/var/lib/postgresql/18/main \
    --publisher-server='host=primary dbname=app user=repl_user password=...' \
    --database=app \
    --subscription=sub_app \
    --publication=pub_app
```

Tool drops the physical replication slot, promotes the standby, creates the publication on the (now-former) primary, and subscription on the (now-)subscriber. Standby's existing data becomes the starting point — no initial COPY needed.

### Recipe 7 — Failover slot (PG17+)

Make the subscriber survive the publisher's primary failing over to a standby:

```sql
-- On publisher (primary side):
-- postgresql.conf:
--   synchronized_standby_slots = 'standby_a, standby_b'  -- physical standbys that must be in sync

-- On the standby that will be promoted:
-- postgresql.conf:
--   sync_replication_slots = on

-- On subscriber:
CREATE SUBSCRIPTION sub_failover
    CONNECTION '...'
    PUBLICATION pub_main
    WITH (failover = true);
```

Verbatim PG17 release-note: *"Enable the failover of logical slots (Hou Zhijie, Shveta Malik, Ajin Cherian)."*[^pg17-failover] After promotion of the physical standby, the logical slot is already on the new primary; subscriber reconnects and resumes apply without manual slot recreation. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).

### Recipe 8 — Handle a stuck apply worker (conflict)

```sql
-- find conflicts
SELECT subid, subname, apply_error_count, sync_error_count,
       confl_insert_exists, confl_update_origin_differs, confl_delete_missing  -- PG18+
  FROM pg_stat_subscription_stats;

-- inspect server log for the conflicting LSN, e.g.:
-- ERROR: duplicate key value violates unique constraint "..."
-- DETAIL: Key (id)=(1234) already exists.
-- LOG: processing remote data for replication origin "..." during message type "INSERT"
--      in transaction 9876, finished at 0/A1B2C3D4

-- Option A: subscriber-side, the row that conflicts is the right one; skip
ALTER SUBSCRIPTION sub_orders SKIP (lsn = '0/A1B2C3D4');

-- Option B: subscriber-side, delete the local conflict row, let apply retry
DELETE FROM orders WHERE id = 1234;
-- apply worker retries automatically

-- Option C: stop forever (data divergence is unacceptable)
ALTER SUBSCRIPTION sub_orders DISABLE;
-- then investigate / re-sync
```

### Recipe 9 — Audit publications + subscriptions cluster-wide

```sql
-- publisher
SELECT p.pubname, p.puballtables,
       p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate,
       p.pubviaroot,
       array_agg(pt.schemaname || '.' || pt.tablename ORDER BY pt.schemaname, pt.tablename) AS tables
  FROM pg_publication p
  LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
 GROUP BY p.oid, p.pubname, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate, p.pubviaroot
 ORDER BY p.pubname;

-- subscriber
SELECT s.subname,
       s.subenabled,
       s.subbinary,
       s.substream,
       s.subtwophasestate,
       s.subrunasowner,
       s.suborigin,
       s.subpublications,
       (SELECT pid FROM pg_stat_subscription WHERE subid = s.oid AND leader_pid IS NULL) AS apply_pid
  FROM pg_subscription s
 ORDER BY s.subname;
```

### Recipe 10 — Subscribe to subset of partitioned table via partition root

```sql
-- publisher
ALTER PUBLICATION pub_events SET (publish_via_partition_root = true);
-- partition writes flow through the parent table; subscriber sees one logical table
-- without needing to know the publisher's partition layout
```

Subscriber side can have a non-partitioned table OR its own partition layout. Publisher's partition boundaries are not communicated.

### Recipe 11 — Set REPLICA IDENTITY when no PK exists

```sql
-- table has no PK but has a unique-not-null index
ALTER TABLE orders REPLICA IDENTITY USING INDEX orders_natural_key_idx;

-- table has neither PK nor unique-not-null index
ALTER TABLE orders REPLICA IDENTITY FULL;
-- now publisher sends every column on UPDATE/DELETE
-- subscriber uses any btree index to locate the row (PG16+) or seqscan (≤PG15)
```

### Recipe 12 — Diagnose lagging subscription

```sql
-- on subscriber: how far behind is the apply worker?
SELECT s.subname,
       sub.received_lsn,
       sub.latest_end_lsn,
       sub.last_msg_send_time,
       sub.last_msg_receipt_time,
       extract(epoch from now() - sub.latest_end_time) AS lag_seconds
  FROM pg_stat_subscription sub
  JOIN pg_subscription s ON s.oid = sub.subid
 WHERE sub.leader_pid IS NULL;  -- main apply worker only

-- on publisher: what is the slot's retained WAL?
SELECT slot_name, active, wal_status, safe_wal_size,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained
  FROM pg_replication_slots
 WHERE slot_type = 'logical';
```

If `received_lsn` is current but `latest_end_lsn` is behind: apply worker is the bottleneck. Try `streaming = parallel` and raise `max_parallel_apply_workers_per_subscription`. If both are behind: network or publisher CPU bound.

### Recipe 13 — Drop subscription when publisher unreachable

```sql
-- the safe sequence — DROP SUBSCRIPTION fails if publisher is down and slot still attached
ALTER SUBSCRIPTION sub_orders DISABLE;
ALTER SUBSCRIPTION sub_orders SET (slot_name = NONE);
DROP SUBSCRIPTION sub_orders;

-- THEN if publisher comes back, drop the orphaned slot manually:
-- on publisher:
SELECT pg_drop_replication_slot('sub_orders');
```

Verbatim docs warn: leaving the slot intact retains WAL on the publisher and "might eventually cause the disk to fill up."[^dropsub]

### Recipe 14 — Generated column replication (PG18+)

```sql
-- publisher
ALTER PUBLICATION pub_orders SET (publish_generated_columns = true);

-- subscriber table must have matching generated column expression (or a plain column)
CREATE TABLE orders (
    id      bigint PRIMARY KEY,
    qty     int NOT NULL,
    price   numeric NOT NULL,
    total   numeric GENERATED ALWAYS AS (qty * price) STORED
);
```

Pre-PG18 the subscriber had to recompute generated column values locally (and ALWAYS-stored generated columns made this impossible to specify on the wire). PG18 sends the computed value if `publish_generated_columns = true`.

## Gotchas / Anti-patterns

1. **DDL not replicated.** Adding a column on the publisher with no matching column on the subscriber breaks the apply worker on the next INSERT/UPDATE for that table. Sync schema first, always.

2. **Sequences not replicated.** Subscriber's serial / IDENTITY sequences stay at their starting value forever. After failover from publisher → subscriber, sequence values collide with existing data. Sync via `setval()` in the cutover step.

3. **Large Objects not replicated.** `lo_create()` / `lo_write()` writes on the publisher do nothing on the subscriber. Store blob data in `bytea` columns (see [`14-data-types-builtin.md`](./14-data-types-builtin.md)) or sync LOs out-of-band.

4. **REPLICA IDENTITY NOTHING blocks UPDATE/DELETE replication.** Silent on INSERT, errors on UPDATE/DELETE: `ERROR: cannot update table "x" because it does not have a replica identity and publishes updates`. Fix: `ALTER TABLE x REPLICA IDENTITY DEFAULT;` (if PK exists) or USING INDEX or FULL.

5. **Row filter columns must be covered by REPLICA IDENTITY for UPDATE/DELETE.** Row filter `WHERE (status = 'active')` on an UPDATE-publishing publication where REPLICA IDENTITY is the PK and `status` is not in the PK → silent acceptance, but UPDATEs that touch `status` are not properly filtered. Always test the matrix.

6. **DROP SUBSCRIPTION in transaction block errors if slot attached.** Use `DISABLE` + `SET (slot_name = NONE)` + `DROP` outside any explicit BEGIN/COMMIT.

7. **`subconninfo` contains plaintext passwords.** `pg_subscription.subconninfo` access is revoked from normal users on PG16+ (verbatim PG16: subscriptions without local password storage path added)[^pg16-pwreq]. Pre-PG16 + service files / `.pgpass` were the safer answer.

8. **Apply worker conflicts BLOCK forever.** No automatic conflict resolution. Set `disable_on_error = true` (PG15+) for production subscriptions you can pause without page.

9. **`logical_decoding_work_mem` default 64MB is too small for OLTP write bursts pre-PG14.** Pre-PG14: large transactions spilled to disk on the publisher's `pg_replslot/SLOTNAME/snap/`. PG14+ streaming sends partial data instead.

10. **`wal_level = logical` is publisher-side only, but adds WAL volume cluster-wide.** Even tables not in any publication generate more verbose WAL. Cross-reference [`33-wal.md`](./33-wal.md).

11. **`max_replication_slots` and `max_wal_senders` on the publisher both need raising.** Each subscriber consumes one slot AND one walsender. Slots persist across restarts; walsenders do not.

12. **`max_logical_replication_workers` does NOT include tablesync workers in PG14.** PG15+: tablesync workers count against the limit. Subscriber's `max_worker_processes` must accommodate everyone.

13. **`streaming = parallel` (PG16+) + functions with side effects = wrong results.** Parallel apply workers may apply changes out of strict commit order across transactions but within a transaction they apply in order. Volatile functions in BEFORE triggers can see different orderings than they would on the publisher.

14. **Logical decoding on standbys (PG16+) is fragile under primary `VACUUM`.** Removed dead rows on primary may invalidate the standby's logical slot. `hot_standby_feedback = on` reduces (but does not eliminate) the risk.

15. **`copy_data = true` (default) reads the table from the publisher with `COPY`.** For very large tables this can take hours and holds a snapshot open. `copy_data = false` + manual `pg_dump --data-only` + `pg_restore` may be faster — then `ALTER SUBSCRIPTION ... REFRESH PUBLICATION WITH (copy_data = false)`.

16. **`publish_via_partition_root` (off by default) sends per-partition writes.** Subscriber needs identical partition hierarchy. Turn on if subscriber has a different (or no) partition layout.

17. **Origin filtering (PG16+) only filters at the apply level; the slot still receives all changes.** Network traffic for bidirectional setups is not reduced — the subscriber just ignores echoes.

18. **`run_as_owner` default flip (PG16+) breaks pre-existing subscriptions on upgrade.** Pre-PG16 apply ran as subscription owner. PG16+ runs as table owner per-DML. Subscription owners that previously could write to all tables may now lack permission. Set `run_as_owner = true` to restore old behavior — or grant table-level permissions properly.

19. **Two-phase commit (`two_phase = true`) requires `max_prepared_transactions > 0` on subscriber.** Default is 0. Apply worker errors out if 2PC messages arrive without prepared-transaction support enabled.

20. **`pg_createsubscriber` (PG17+) cannot be undone.** It drops the physical replication slot and promotes the standby. Run `pg_basebackup` to reseed if you change your mind.

21. **Failover slots (PG17+) need `synchronized_standby_slots` configured BEFORE failover.** Setting it after the standby promotes is too late — the new primary won't know which slots to retain WAL for.

22. **`ALTER SUBSCRIPTION ... REFRESH PUBLICATION` does not retroactively COPY new rows.** Only new tables added to the publication get initial COPY. Existing-table row-filter or column-list changes do not re-COPY; the subscriber retains rows that no longer match the updated filter.

23. **PG14 / PG15 / PG16 / PG17 / PG18 each added breaking-default-behavior surface.** PG16 flipped `run_as_owner` default; PG18 flipped `streaming` default. Read release notes for every major before upgrading a logical replication topology. Cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin/xmax mechanics underlying logical decoding
- [`71-large-objects.md`](./71-large-objects.md) — Large Object contents are NOT replicated by logical replication; workarounds and migration paths
- [`33-wal.md`](./33-wal.md) — `wal_level = logical` and per-record overhead
- [`41-transactions.md`](./41-transactions.md) — two-phase commit semantics
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `REPLICATION` role attribute + `pg_create_subscription` predefined role
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — `hostssl` rules with `replication` pseudo-database for PHYSICAL only; logical replication uses a normal `database = appdb` rule
- [`49-tls-ssl.md`](./49-tls-ssl.md) — `sslmode=verify-full` for replication connections
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_subscription` and `pg_stat_subscription_stats` full column reference
- [`63-internals-architecture.md`](./63-internals-architecture.md) — apply worker process model
- [`65-collations-encoding.md`](./65-collations-encoding.md) — collation must agree across publisher and subscriber for indexed columns
- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical replication contrast
- [`75-replication-slots.md`](./75-replication-slots.md) — slot mechanics shared by logical and physical
- [`76-logical-decoding.md`](./76-logical-decoding.md) — output-plugin author surface (pgoutput, wal2json, etc.)
- [`77-standby-failover.md`](./77-standby-failover.md) — `pg_promote()` interaction with failover slots
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — logical replication as zero-downtime upgrade strategy

## Sources

[^lr-intro]: PostgreSQL 16 docs, "Chapter 31. Logical Replication". *"Logical replication is a method of replicating data objects and their changes, based upon their replication identity (usually a primary key)."* https://www.postgresql.org/docs/16/logical-replication.html
[^lr-restrictions]: PostgreSQL 16 docs, "31.6. Restrictions". *"The database schema and DDL commands are not replicated. ... Sequence data is not replicated. ... Large objects (see Chapter 35) are not replicated."* https://www.postgresql.org/docs/16/logical-replication-restrictions.html
[^lr-rowfilter]: PostgreSQL 16 docs, "31.3. Row Filters". *"The WHERE clause allows only simple expressions. It cannot contain user-defined functions, operators, types, and collations, system column references or non-immutable built-in functions. ... If a publication publishes UPDATE or DELETE operations, the row filter WHERE clause must contain only columns that are covered by the replica identity."* https://www.postgresql.org/docs/16/logical-replication-row-filter.html
[^dropsub]: PostgreSQL 16 docs, `DROP SUBSCRIPTION`. *"DROP SUBSCRIPTION cannot be executed inside a transaction block if the subscription is associated with a replication slot. (You can use ALTER SUBSCRIPTION to unset the slot.)"* https://www.postgresql.org/docs/16/sql-dropsubscription.html
[^pg14-2pc]: PostgreSQL 14 release notes. *"Enhance logical decoding APIs to handle two-phase commits (Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). This is controlled via pg_create_logical_replication_slot()."* https://www.postgresql.org/docs/release/14.0/
[^pg14-stream]: PostgreSQL 14 release notes. *"Allow logical replication to stream long in-progress transactions to subscribers (Dilip Kumar, Amit Kapila, Ajin Cherian, Tomas Vondra, Nikhil Sontakke, Stas Kelvich). Previously transactions that exceeded logical_decoding_work_mem were written to disk until the transaction completed."* https://www.postgresql.org/docs/release/14.0/
[^pg14-addsub]: PostgreSQL 14 release notes. *"Allow publications to be more easily added to and removed from a subscription (Japin Li). The new syntax is ALTER SUBSCRIPTION ... ADD/DROP PUBLICATION."* https://www.postgresql.org/docs/release/14.0/
[^pg14-binary]: PostgreSQL 14 release notes. *"Allow logical replication subscriptions to use binary transfer mode (Dave Cramer). This is faster than text mode, but slightly less robust."* https://www.postgresql.org/docs/release/14.0/
[^pg14-xid]: PostgreSQL 14 release notes. *"Allow logical decoding to be filtered by xid (Markus Wanner)."* https://www.postgresql.org/docs/release/14.0/
[^pg15-rowfilter]: PostgreSQL 15 release notes. *"Allow publication content to be filtered using a WHERE clause (Hou Zhijie, Euler Taveira, Peter Smith, Ajin Cherian, Tomas Vondra, Amit Kapila). Rows not satisfying the WHERE clause are not published."* https://www.postgresql.org/docs/release/15.0/
[^pg15-collist]: PostgreSQL 15 release notes. *"Allow publication content to be restricted to specific columns (Tomas Vondra, Álvaro Herrera, Rahila Syed)."* https://www.postgresql.org/docs/release/15.0/
[^pg15-schema]: PostgreSQL 15 release notes. *"Allow publication of all tables in a schema (Vignesh C, Hou Zhijie, Amit Kapila). For example, this syntax is now supported: CREATE PUBLICATION pub1 FOR TABLES IN SCHEMA s1,s2."* https://www.postgresql.org/docs/release/15.0/
[^pg15-2pc]: PostgreSQL 15 release notes. *"Add support for prepared (two-phase) transactions to logical replication (Peter Smith, Ajin Cherian, Amit Kapila, Nikhil Sontakke, Stas Kelvich). The new CREATE_REPLICATION_SLOT option is called TWO_PHASE."* https://www.postgresql.org/docs/release/15.0/
[^pg15-rao]: PostgreSQL 15 release notes. *"Allow logical replication to run as the owner of the subscription (Mark Dilger). Because row-level security policies are not checked, only superusers, roles with bypassrls, and table owners can replicate into tables with row-level security policies."* https://www.postgresql.org/docs/release/15.0/
[^pg15-skip]: PostgreSQL 15 release notes. *"Allow skipping of transactions on a subscriber using ALTER SUBSCRIPTION ... SKIP (Masahiko Sawada)."* https://www.postgresql.org/docs/release/15.0/
[^pg15-doe]: PostgreSQL 15 release notes. *"Allow subscribers to stop the application of logical replication changes on error (Osumi Takamichi, Mark Dilger). This is enabled with the subscriber option disable_on_error and avoids possible infinite error loops during stream application."* https://www.postgresql.org/docs/release/15.0/
[^pg15-stats]: PostgreSQL 15 release notes. *"Add system view pg_stat_subscription_stats to report on subscriber activity (Masahiko Sawada). The new function pg_stat_reset_subscription_stats() allows resetting these statistics counters."* https://www.postgresql.org/docs/release/15.0/
[^pg16-parallel]: PostgreSQL 16 release notes. *"Allow parallel application of logical replication (Hou Zhijie, Wang Wei, Amit Kapila). The CREATE SUBSCRIPTION STREAMING option now supports parallel to enable application of large transactions by parallel workers."* https://www.postgresql.org/docs/release/16.0/
[^pg16-standby]: PostgreSQL 16 release notes. *"Allow logical decoding on standbys (Bertrand Drouvot, Andres Freund, Amit Khandekar). Snapshot WAL records are required for logical slot creation but cannot be created on standbys."* https://www.postgresql.org/docs/release/16.0/
[^pg16-role]: PostgreSQL 16 release notes. *"Add predefined role pg_create_subscription with permission to create subscriptions (Robert Haas)."* https://www.postgresql.org/docs/release/16.0/
[^pg16-pwreq]: PostgreSQL 16 release notes. *"Allow subscriptions to not require passwords (Robert Haas). This is accomplished with the option password_required=false."* https://www.postgresql.org/docs/release/16.0/
[^pg16-origin]: PostgreSQL 16 release notes. *"Allow logical replication subscribers to process only changes that have no origin (Vignesh C, Amit Kapila). This can be used to avoid replication loops. This is controlled by the new CREATE SUBSCRIPTION ... ORIGIN option."* https://www.postgresql.org/docs/release/16.0/
[^pg16-binsync]: PostgreSQL 16 release notes. *"Allow logical replication initial table synchronization to copy rows in binary format (Melih Mutlu). This is only possible for subscriptions marked as binary."* https://www.postgresql.org/docs/release/16.0/
[^pg16-full]: PostgreSQL 16 release notes. *"Improve performance for logical replication apply without a primary key (Onder Kalaci, Amit Kapila). Specifically, REPLICA IDENTITY FULL can now use btree indexes rather than sequentially scanning the table to find matches."* https://www.postgresql.org/docs/release/16.0/
[^pg16-rao]: PostgreSQL 16 release notes. *"Perform logical replication SELECT and DML actions as the table owner (Robert Haas). ... The previous behavior of performing all operations as the subscription owner can be enabled with the subscription run_as_owner option."* https://www.postgresql.org/docs/release/16.0/
[^pg17-createsub]: PostgreSQL 17 release notes. *"Add application pg_createsubscriber to create a logical replica from a physical standby server (Euler Taveira)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-failover]: PostgreSQL 17 release notes. *"Enable the failover of logical slots (Hou Zhijie, Shveta Malik, Ajin Cherian). ... Add server variable sync_replication_slots to enable failover logical slot synchronization. ... Allow specification of physical standbys that must be synchronized before they are visible to subscribers. The new server variable is synchronized_standby_slots. ... Add function pg_sync_replication_slots() to synchronize logical replication slots."* https://www.postgresql.org/docs/release/17.0/
[^pg17-pgupgrade]: PostgreSQL 17 release notes. *"Have pg_upgrade migrate valid logical slots and subscriptions (Hayato Kuroda, Hou Zhijie, Vignesh C, Julien Rouhaud, Shlok Kyal). This only works for old PostgreSQL clusters that are version 17 or later."* https://www.postgresql.org/docs/release/17.0/
[^pg17-hash]: PostgreSQL 17 release notes. *"Allow the application of logical replication changes to use hash indexes on the subscriber (Hayato Kuroda). Previously only btree indexes could be used for this purpose."* https://www.postgresql.org/docs/release/17.0/
[^pg17-invreason]: PostgreSQL 17 release notes. *"Add column pg_replication_slots.invalidation_reason to report the reason for invalid slots (Shveta Malik, Bharath Rupireddy)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-inactive]: PostgreSQL 17 release notes. *"Add column pg_replication_slots.inactive_since to report slot inactivity duration (Bharath Rupireddy)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-worker]: PostgreSQL 17 release notes. *"Add worker type column to pg_stat_subscription (Peter Smith)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-restart]: PostgreSQL 17 release notes. *"Restart apply workers if subscription owner's superuser privileges are revoked (Vignesh C). This forces reauthentication."* https://www.postgresql.org/docs/release/17.0/
[^pg17-subxact]: PostgreSQL 17 release notes. *"Improve logical decoding performance in cases where there are many subtransactions (Masahiko Sawada)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-emit]: PostgreSQL 17 release notes. *"Add flush option to pg_logical_emit_message() (Michael Paquier). This makes the message durable."* https://www.postgresql.org/docs/release/17.0/
[^pg18-gen]: PostgreSQL 18 release notes. *"Allow the values of generated columns to be logically replicated (Shubham Khanna, Vignesh C, Zhijie Hou, Shlok Kyal, Peter Smith). ... Without a specified column list, publication option publish_generated_columns controls whether generated columns are published."* https://www.postgresql.org/docs/release/18.0/
[^pg18-stream-default]: PostgreSQL 18 release notes. *"Change the default CREATE SUBSCRIPTION streaming option from off to parallel (Vignesh C)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-alter2pc]: PostgreSQL 18 release notes. *"Allow ALTER SUBSCRIPTION to change the replication slot's two-phase commit behavior (Hayato Kuroda, Ajin Cherian, Amit Kapila, Zhijie Hou)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-conflicts]: PostgreSQL 18 release notes. *"Log conflicts while applying logical replication changes (Zhijie Hou, Nisha Moond). Also report in new columns of pg_stat_subscription_stats."* https://www.postgresql.org/docs/release/18.0/
[^pg18-cs]: PostgreSQL 18 release notes. *"Add pg_createsubscriber option --all to create logical replicas for all databases (Shubham Khanna). Add pg_createsubscriber option --clean to remove publications. Add pg_createsubscriber option --enable-two-phase to enable prepared transactions."* https://www.postgresql.org/docs/release/18.0/
[^pg18-pgrecv]: PostgreSQL 18 release notes. *"Add pg_recvlogical option --enable-failover to specify failover slots (Hayato Kuroda). Also add option --enable-two-phase as a synonym for --two-phase, and deprecate the latter."* https://www.postgresql.org/docs/release/18.0/
[^pg18-idleslot]: PostgreSQL 18 release notes. *"Allow inactive replication slots to be automatically invalidated using server variable idle_replication_slot_timeout (Nisha Moond, Bharath Rupireddy)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-origins]: PostgreSQL 18 release notes. *"Add server variable max_active_replication_origins to control the maximum active replication origins (Euler Taveira)."* https://www.postgresql.org/docs/release/18.0/

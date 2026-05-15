# Replication Slots

Server-side mechanism that prevents WAL segments from being removed (and on logical slots, prevents `VACUUM` from removing required catalog rows) until a downstream consumer has confirmed receipt — independent of whether the consumer is currently connected.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
  - [Physical vs Logical Slots](#physical-vs-logical-slots)
  - [Slot Persistence](#slot-persistence)
  - [WAL Retention](#wal-retention)
  - [Slot Invalidation (PG13+)](#slot-invalidation-pg13)
  - [`pg_replication_slots` View](#pg_replication_slots-view)
  - [Slot Management Functions](#slot-management-functions)
  - [Configuration GUCs](#configuration-gucs)
  - [Failover Slots (PG17+)](#failover-slots-pg17)
  - [`pg_stat_replication_slots` View (PG14+)](#pg_stat_replication_slots-view-pg14)
  - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use when:

- Setting up a streaming replica that should NOT lose its place if disconnected briefly (use a physical slot)
- Setting up logical replication / change data capture (use a logical slot)
- Investigating `pg_wal` directory disk growth — abandoned slot is the #1 root cause
- Configuring HA so that subscribers survive primary failover (PG17+ failover slots)
- Cleaning up after a former subscriber permanently went away
- Reading `wal_status`, `invalidation_reason`, `inactive_since`, `safe_wal_size` columns
- Tuning `max_slot_wal_keep_size`, `max_replication_slots`, `idle_replication_slot_timeout` (PG18+)
- Deciding whether `wal_keep_size` or a slot is the right WAL-retention mechanism

> [!WARNING] Abandoned slot fills disk
> A replication slot persists across crashes and **knows nothing about its consumer's state**. If a subscriber disappears (crashed, deprovisioned, network partition that never resolved), the slot keeps retaining WAL forever unless `max_slot_wal_keep_size` (PG13+) is set, or you drop the slot manually. The `pg_wal` directory grows until the disk fills. This is the most common production incident involving slots.

## Mental Model

Five rules that drive every operational decision:

1. **A slot is a server-side bookmark, not a connection.** It lives in `pg_replication_slots`, persists across restarts, and survives the consumer disconnecting. The slot is on disk; the walsender (or subscriber's apply worker) is in process memory.
2. **Physical slots retain WAL; logical slots retain WAL + `catalog_xmin` + slot-level snapshot state.** Logical slots additionally hold back `VACUUM` from removing system-catalog rows the slot's consumer might still need.
3. **An abandoned slot retains its resources indefinitely unless `max_slot_wal_keep_size` (PG13+) bounds WAL retention.** The default is `-1` (unlimited). Configure this on every production cluster.
4. **Slot invalidation is a one-way operation.** Once the slot's `wal_status` reaches `lost`, it cannot resume — you must drop and recreate (and re-bootstrap the consumer). Verbatim from the docs: *"`lost` means that this slot is no longer usable."*
5. **PG17+ failover slots sync to physical standbys.** Pre-PG17, when the primary failed over, logical subscribers had to be rebuilt against the new primary because slots existed only on the old primary. PG17 fixes this for HA deployments via `sync_replication_slots` + `synchronized_standby_slots` + `pg_sync_replication_slots()`.

## Decision Matrix

| Need | Use | Default | Production value | Avoid |
|---|---|---|---|---|
| Streaming replica that survives brief disconnect | Physical slot via `primary_slot_name` GUC on standby | none | named slot per standby | `wal_keep_size` alone |
| Logical replication subscriber (CDC / cross-cluster) | Logical slot via `CREATE SUBSCRIPTION` (auto-creates) | n/a | one slot per subscription | manual slot management |
| Cap WAL retention per slot | `max_slot_wal_keep_size = 64GB` (PG13+) | `-1` (unlimited) | sized to disk + write rate | leaving unlimited |
| Bound how many slots can exist | `max_replication_slots = 10` (PG13+ default 10) | 10 | size to subscribers + standbys + 2 headroom | leaving default if you have many subscriptions |
| Detect abandoned slots | Monitor `pg_replication_slots.active = false` + `wal_status` + (PG17+) `inactive_since` | n/a | alert on `wal_status = 'extended'` or `'lost'` | polling `pg_wal` size as proxy |
| HA logical replication that survives failover | Failover slots PG17+ (`failover = true` + `sync_replication_slots` + `synchronized_standby_slots`) | off | required for production logical replication | running logical replication without failover slots on a HA primary |
| Idle-slot auto-cleanup | `idle_replication_slot_timeout` GUC PG18+ | `0` (disabled) | cluster-specific (often 7-30 days) | relying on humans to notice |
| Inspect what changes a logical slot would emit (peek, no consume) | `pg_logical_slot_peek_changes()` / `pg_logical_slot_peek_binary_changes()` | n/a | diagnostic only | calling `_get_` variants during debugging (consumes!) |
| Copy a slot for testing | `pg_copy_physical_replication_slot()` / `pg_copy_logical_replication_slot()` | n/a | when forking a CDC pipeline | manual slot recreation (loses position) |
| Skip ahead on a logical slot | `pg_replication_slot_advance(slot, upto_lsn)` | n/a | recovering from stuck apply | `DROP` + recreate (loses position too) |

Three smell signals:

- **`pg_wal` directory growing unbounded**: someone created a slot, the consumer went away, `max_slot_wal_keep_size = -1`. Find the abandoned slot in `pg_replication_slots WHERE active = false`.
- **`pg_replication_slots.wal_status = 'extended'`** for a slot: WAL beyond `max_wal_size` is being retained. Either the consumer is lagging (catch it up) or it's been abandoned (drop it).
- **VACUUM not reclaiming dead tuples** despite no long-running transactions: a logical slot's `catalog_xmin` is holding the cluster-wide xmin horizon back. Check `pg_replication_slots.catalog_xmin`.

## Mechanics

### Physical vs Logical Slots

Verbatim: *"Replication slots provide an automated way to ensure that the primary does not remove WAL segments until they have been received by all standbys, and that the primary does not remove rows which could cause a recovery conflict even when the standby is disconnected."*[^warm-standby]

| Property | Physical slot | Logical slot |
|---|---|---|
| Purpose | Stream raw WAL to a physical standby | Decode WAL into row-level changes via output plugin |
| Created by | `pg_create_physical_replication_slot()` or `CREATE_REPLICATION_SLOT ... PHYSICAL` (replication protocol) | `pg_create_logical_replication_slot()` or `CREATE SUBSCRIPTION` (auto-creates) or `CREATE_REPLICATION_SLOT ... LOGICAL` |
| Retains WAL | Yes | Yes |
| Retains `catalog_xmin` | No | **Yes** — blocks `VACUUM` from removing required catalog rows |
| Output | Raw WAL bytes (consumed by walreceiver) | Logical changes via `pgoutput` (built-in), `wal2json`, `test_decoding`, etc. |
| `database` column populated | NULL | The database OID the slot belongs to |
| `wal_level` required | `replica` | `logical` |
| Can be temporary | Yes (`temporary = true`) | Yes (`temporary = true`) |

Logical slot identity rule, verbatim: *"A replication slot has an identifier that is unique across all databases in a PostgreSQL cluster. Slots persist independently of the connection using them and are crash-safe."*[^logicaldecoding] But each logical slot is bound to **one database** — `pg_replication_slots.database` shows which.

### Slot Persistence

Verbatim: *"Slots persist independently of the connection using them and are crash-safe."*[^logicaldecoding]

What this means operationally:

- Slot survives server restart
- Slot survives consumer disconnect
- Slot survives consumer process crash
- Slot does **NOT** survive primary failover unless it is a failover slot (PG17+) **AND** the physical standby is configured with `sync_replication_slots = true`
- Temporary slots (`temporary = true`) are released on session end or on any error — useful for one-shot CDC

The on-disk location is `pg_replslot/<slot_name>/`. State is persisted only at checkpoint, which is why the docs say (PG16 wording): *"A logical slot will emit each change just once in normal operation. The current position of each slot is persisted only at checkpoint, so in the case of a crash the slot may return to an earlier LSN, which will then cause recent changes to be sent again when the server restarts."*[^logicaldecoding]

> [!NOTE] PostgreSQL 18 wording change
> PG18 changed "the slot **may** return to an earlier LSN" to "the slot **might** return to an earlier LSN". No semantic difference — the behavior is identical to PG16/PG17.[^logicaldecoding-18]

The consumer must be idempotent or tolerate replay across this small window.

### WAL Retention

The primary mechanism by which slots retain WAL:

- `pg_replication_slots.restart_lsn` is the oldest LSN the consumer still needs
- Checkpointer will NOT remove any WAL segment containing data at or after `restart_lsn`
- This applies even if the slot is `active = false` (consumer disconnected)

Verbatim: *"The address (LSN) of oldest WAL which still might be required by the consumer of this slot and thus won't be automatically removed during checkpoints unless this LSN gets behind more than max_slot_wal_keep_size from the current LSN. NULL if the LSN of this slot has never been reserved."*[^view-pg-replication-slots]

The hot-standby-feedback interaction, verbatim: *"Similarly, `hot_standby_feedback` on its own, without also using a replication slot, provides protection against relevant rows being removed by vacuum, but provides no protection during any time period when the standby is not connected. Replication slots overcome these disadvantages."*[^warm-standby]

So slots subsume the protection `hot_standby_feedback` offers while a connection is up — and extend it across disconnects.

### Slot Invalidation (PG13+)

> [!NOTE] PostgreSQL 13
> `max_slot_wal_keep_size` GUC introduced. Verbatim release note: *"Allow WAL storage for replication slots to be limited by `max_slot_wal_keep_size`. Replication slots that would require exceeding this value are marked invalid."*[^pg13-release]

When `max_slot_wal_keep_size` is non-negative and a slot's `restart_lsn` falls farther behind the current LSN than that value, the slot transitions through `wal_status` states. The `wal_status` column was added in the same PG13 release alongside `max_slot_wal_keep_size`.

Verbatim semantics from PG16 docs[^view-pg-replication-slots]:

| `wal_status` | Meaning |
|---|---|
| `reserved` | "The claimed files are within `max_wal_size`." |
| `extended` | "`max_wal_size` is exceeded but the files are still retained, either by the replication slot or by `wal_keep_size`." |
| `unreserved` | "The slot no longer retains the required WAL files and some of them are to be removed at the next checkpoint. This typically occurs when `max_slot_wal_keep_size` is set to a non-negative value. This state can return to `reserved` or `extended`." |
| `lost` | "This slot is no longer usable." |

The state machine: `reserved → extended → unreserved → lost`. Slots can move backwards from `unreserved` to `extended` or `reserved` if the consumer catches up before the next checkpoint. Once `lost`, the slot must be dropped and the consumer rebootstrapped.

The `safe_wal_size` column, verbatim: *"The number of bytes that can be written to WAL such that this slot is not in danger of getting in state 'lost'. It is NULL for lost slots, as well as if `max_slot_wal_keep_size` is -1."*[^view-pg-replication-slots]

### `pg_replication_slots` View

Columns change across PG versions. Reference baseline is PG16.

**Common to PG16, PG17, PG18:**

| Column | Type | Meaning |
|---|---|---|
| `slot_name` | `name` | Cluster-unique slot identifier |
| `plugin` | `name` | Output plugin name (logical slots; NULL for physical) |
| `slot_type` | `text` | `physical` or `logical` |
| `datoid` | `oid` | Database OID (logical only) |
| `database` | `name` | Database name (logical only) |
| `temporary` | `bool` | Temporary slot flag |
| `active` | `bool` | A consumer is currently connected |
| `active_pid` | `int4` | PID of the connected backend |
| `xmin` | `xid` | Oldest transaction whose effects must be preserved (physical slots) |
| `catalog_xmin` | `xid` | Oldest transaction whose catalog effects must be preserved (logical slots) |
| `restart_lsn` | `pg_lsn` | Oldest WAL LSN still required |
| `confirmed_flush_lsn` | `pg_lsn` | LSN up to which the consumer has confirmed receipt (logical only) |
| `wal_status` | `text` | One of `reserved`, `extended`, `unreserved`, `lost` |
| `safe_wal_size` | `int8` | Bytes that can still be written before risking `lost` |
| `two_phase` | `bool` | Slot decodes prepared transactions |
| `conflicting` | `bool` | Logical slot conflicted with recovery (always NULL for physical) |

> [!NOTE] PostgreSQL 17 new columns
> Four columns added in PG17: `inactive_since timestamptz`, `invalidation_reason text`, `failover bool`, `synced bool`. Verbatim release note: *"Add column `pg_replication_slots.invalidation_reason` to report the reason for invalid slots."*[^pg17-release]

PG17 also expanded the `conflicting` description, verbatim: *"True if this logical slot conflicted with recovery (and so is now invalidated). When this column is true, check `invalidation_reason` column for the conflict reason. Always NULL for physical slots."*[^view-pg-replication-slots-17]

Verbatim PG17 description of `invalidation_reason`: *"The reason for the slot's invalidation. It is set for both logical and physical slots. NULL if the slot is not invalidated. Possible values are: `wal_removed`, `rows_removed`, `wal_level_insufficient`"*[^view-pg-replication-slots-17]

Note: `invalidation_reason` applies to **both logical and physical slots** — common misconception is that it's logical-only.

> [!NOTE] PostgreSQL 18 new columns
> `two_phase_at pg_lsn` column added. `invalidation_reason` enum expanded with `idle_timeout` value (corresponds to the new `idle_replication_slot_timeout` GUC). Verbatim PG18 column doc: *"The address (LSN) from which the decoding of prepared transactions is enabled."*[^view-pg-replication-slots-18]

### Slot Management Functions

Verbatim signatures from `functions-admin.html` §9.27.6[^functions-admin]:

| Function | Signature | Notes |
|---|---|---|
| `pg_create_physical_replication_slot` | `(slot_name name [, immediately_reserve boolean, temporary boolean]) → record` | `immediately_reserve = true` claims an LSN at creation time instead of first connection |
| `pg_create_logical_replication_slot` | PG16: `(slot_name name, plugin name [, temporary boolean, twophase boolean]) → record` | PG17+ adds 5th param `failover boolean` |
| `pg_drop_replication_slot` | `(slot_name name) → void` | Works on both physical and logical |
| `pg_replication_slot_advance` | `(slot_name name, upto_lsn pg_lsn) → record` | Can only advance forward, never beyond current insert LSN |
| `pg_copy_physical_replication_slot` | `(src_slot_name, dst_slot_name [, temporary boolean]) → record` | Copy of an invalidated slot is not allowed |
| `pg_copy_logical_replication_slot` | `(src_slot_name, dst_slot_name [, temporary boolean [, plugin name]]) → record` | Copy of an invalidated slot is not allowed |
| `pg_logical_slot_get_changes` | `(slot_name, upto_lsn, upto_nchanges, VARIADIC options) → setof record` | **Consumes** changes — advances `confirmed_flush_lsn` |
| `pg_logical_slot_peek_changes` | same args as `_get_` | **Does NOT consume** — safe for diagnostics |
| `pg_logical_slot_get_binary_changes` | same args | Returns `bytea` instead of `text` |
| `pg_logical_slot_peek_binary_changes` | same args | Binary peek variant |
| `pg_sync_replication_slots` | `() → void` (PG17+) | Sync failover slots from primary; standby-only |

> [!WARNING] `_get_` vs `_peek_`
> `pg_logical_slot_get_changes()` **consumes** the changes — advances `confirmed_flush_lsn`. If you call it during debugging without realizing this, you may move the slot past changes the real consumer never received. Use `_peek_` variants for diagnostics.

### Configuration GUCs

| GUC | Default | Context | Purpose |
|---|---|---|---|
| `max_replication_slots` | 10 | postmaster (restart) | Maximum slots the cluster can have. Setting lower than current count prevents server start. Requires `wal_level = replica` or higher. |
| `max_wal_senders` | 10 | postmaster | Maximum concurrent walsender connections (separate budget from slots) |
| `wal_level` | `replica` | postmaster | Must be `replica` for physical slots, `logical` for logical slots |
| `wal_keep_size` | 0 | sighup | WAL retention floor (parallel mechanism to slots; both apply) |
| `max_slot_wal_keep_size` | `-1` (unlimited) | sighup (PG13+) | Maximum WAL a slot may retain. **Set this on every production cluster.** |
| `hot_standby_feedback` | off | sighup | Standby reports xmin back to primary; redundant with physical slot for `xmin` retention but cheaper for some workloads |
| `wal_sender_timeout` | 60s | user | Terminate replication conns idle longer than this. Does NOT invalidate the slot — only the connection. |
| `idle_replication_slot_timeout` | 0 (off) | sighup (PG18+) | Invalidate slots inactive longer than this duration |
| `sync_replication_slots` | off | sighup (PG17+) | Standby-side: enables the slotsync worker that replicates failover slots from primary |
| `synchronized_standby_slots` | empty | sighup (PG17+) | Primary-side: comma-separated physical slot names that must ack WAL before logical failover slots advance |

Verbatim for `max_slot_wal_keep_size`: *"If `max_slot_wal_keep_size` is -1 (the default), replication slots may retain an unlimited amount of WAL files. Otherwise, if `restart_lsn` of a replication slot falls behind the current LSN by more than the given size, the standby using the slot may no longer be able to continue replication due to removal of required WAL files."*[^runtime-config-replication]

Verbatim for `idle_replication_slot_timeout` (PG18+): *"Invalidate replication slots that have remained inactive (not used by a replication connection) for longer than this duration. If this value is specified without units, it is taken as seconds. A value of zero (the default) disables the idle timeout invalidation mechanism."*[^runtime-config-replication-18]

PG18 also notes the checkpoint-lag caveat for `idle_replication_slot_timeout`, verbatim: *"Slot invalidation due to idle timeout occurs during checkpoint. Because checkpoints happen at `checkpoint_timeout` intervals, there can be some lag between when the `idle_replication_slot_timeout` was exceeded and when the slot invalidation is triggered at the next checkpoint. To avoid such lags, users can force a checkpoint to promptly invalidate inactive slots."*[^runtime-config-replication-18]

And synced slots are exempt, verbatim: *"Note that the idle timeout invalidation mechanism is not applicable for slots that do not reserve WAL or for slots on the standby server that are being synced from the primary server."*[^runtime-config-replication-18]

### Failover Slots (PG17+)

> [!NOTE] PostgreSQL 17 — failover slots
> Verbatim release notes[^pg17-release]:
> - *"Enable the failover of logical slots."* (Hou Zhijie, Shveta Malik, Ajin Cherian)
> - *"Add server variable `sync_replication_slots` to enable failover logical slot synchronization."* (Shveta Malik, Hou Zhijie, Peter Smith)
> - *"Add function `pg_sync_replication_slots()` to synchronize logical replication slots."* (Hou Zhijie, Shveta Malik, Ajin Cherian, Peter Eisentraut)
> - *"Allow specification of physical standbys that must be synchronized before they are visible to subscribers. The new server variable is `synchronized_standby_slots`."* (Hou Zhijie, Shveta Malik)

Pre-PG17: logical replication slot exists only on primary. Primary failure → subscriber loses its place → must rebuild subscription (and lose all in-flight data) on the new primary.

PG17+ failover-slots architecture:

1. **Primary** has a logical slot created with `failover = true` (5th param of `pg_create_logical_replication_slot()`, or `CREATE SUBSCRIPTION ... WITH (failover = true)`).
2. **Primary** lists each physical standby's slot in `synchronized_standby_slots = 'standby1_slot, standby2_slot'`.
3. **Standby** has `sync_replication_slots = true`. The slotsync background worker periodically copies logical slot state from primary.
4. Primary's logical walsender BLOCKS the slot from advancing until all `synchronized_standby_slots` standbys have flushed the WAL — ensures the slot's `confirmed_flush_lsn` on standby is always ≤ the value that would be served to subscribers.
5. On primary failure, promote standby. The synced logical slot on the new primary has the right state. Subscribers reconnect, no data loss.

Verbatim semantics for `synchronized_standby_slots`: *"Logical WAL sender processes will send decoded changes to plugins only after the specified replication slots confirm receiving WAL. ... Additionally, the replication management functions `pg_replication_slot_advance`, `pg_logical_slot_get_changes`, and `pg_logical_slot_peek_changes`, when used with logical failover slots, will block until all physical slots specified in `synchronized_standby_slots` have confirmed WAL receipt."*[^runtime-config-replication-18]

Operational warning, verbatim: *"The standbys corresponding to the physical replication slots in `synchronized_standby_slots` must configure `sync_replication_slots = true` so they can receive logical failover slot changes from the primary."*[^runtime-config-replication-18]

### `pg_stat_replication_slots` View (PG14+)

> [!NOTE] PostgreSQL 14
> Verbatim release note: *"Add a system view `pg_stat_replication_slots` to report replication slot activity."* Plus `pg_stat_reset_replication_slot()` function.[^pg14-release]

Columns (logical-slot statistics; physical slots produce zeros)[^monitoring-stats]:

| Column | Type | Meaning |
|---|---|---|
| `slot_name` | `text` | Slot identifier |
| `spill_txns` | `bigint` | Transactions spilled to disk after exceeding `logical_decoding_work_mem` |
| `spill_count` | `bigint` | Number of times spilling occurred |
| `spill_bytes` | `bigint` | Total bytes spilled |
| `stream_txns` | `bigint` | In-progress transactions streamed (PG14+ streaming) |
| `stream_count` | `bigint` | Number of times streaming occurred |
| `stream_bytes` | `bigint` | Total bytes streamed |
| `total_txns` | `bigint` | Top-level transactions decoded (excludes subtransactions) |
| `total_bytes` | `bigint` | Total bytes decoded |
| `stats_reset` | `timestamptz` | Last reset via `pg_stat_reset_replication_slot()` |

Tuning hook, verbatim: *"This and other spill counters can be used to gauge the I/O which occurred during logical decoding and allow tuning `logical_decoding_work_mem`."*[^monitoring-stats]

### Per-Version Timeline

| Version | Changes |
|---|---|
| **PG13** | `max_slot_wal_keep_size` GUC; `wal_status` column added to `pg_replication_slots`; slot invalidation via `lost` state. Authors: Kyotaro Horiguchi.[^pg13-release] |
| **PG14** | `pg_stat_replication_slots` view + `pg_stat_reset_replication_slot()` (Masahiko Sawada, Amit Kapila, Vignesh C); two-phase commit decoding via `twophase` param to `pg_create_logical_replication_slot()` (Ajin Cherian et al.); streaming long in-progress transactions (Dilip Kumar et al.).[^pg14-release] |
| **PG15** | TWO_PHASE protocol option for slot creation (Peter Smith et al.); `pg_ls_logicalsnapdir()`, `pg_ls_logicalmapdir()`, `pg_ls_replslotdir()` for slot directory inspection (Bharath Rupireddy).[^pg15-release] |
| **PG16** | Logical decoding on standbys, with `conflicting` column added to `pg_replication_slots` (Bertrand Drouvot, Andres Freund, Amit Khandekar); `pg_log_standby_snapshot()` function to allow standby slot creation.[^pg16-release] |
| **PG17** | Failover slots (`failover` param on `pg_create_logical_replication_slot()`); `sync_replication_slots` GUC; `synchronized_standby_slots` GUC; `pg_sync_replication_slots()` function; `invalidation_reason`, `inactive_since`, `failover`, `synced` columns on `pg_replication_slots`. Authors: Hou Zhijie, Shveta Malik, Ajin Cherian, Peter Smith, Bharath Rupireddy, Peter Eisentraut.[^pg17-release] |
| **PG18** | `idle_replication_slot_timeout` GUC for auto-invalidation (Nisha Moond, Bharath Rupireddy); `two_phase_at` column on `pg_replication_slots`; `idle_timeout` value in `invalidation_reason`; `pg_recvlogical --enable-failover` (Hayato Kuroda); `--enable-two-phase` as synonym for `--two-phase` (deprecates the older flag).[^pg18-release] |

## Examples / Recipes

### Recipe 1 — Production-baseline GUCs for slot retention

Configure on every production cluster that has replicas or logical replication:

    -- postgresql.conf on the primary
    wal_level = logical           -- enables both physical and logical slots
    max_replication_slots = 16    -- subscribers + standbys + 2 headroom
    max_wal_senders = 16
    max_slot_wal_keep_size = 64GB -- bound WAL retention per slot
    -- PG18+
    idle_replication_slot_timeout = 7d  -- auto-invalidate dead slots after 7 days

Reload via `pg_reload_conf()` (none of these require restart unless raising `max_replication_slots` or `max_wal_senders` past prior value at startup).

### Recipe 2 — Create a physical slot for a streaming standby

On the primary:

    SELECT pg_create_physical_replication_slot('standby_1', true);
    -- second arg = immediately_reserve = true → claims LSN now,
    -- so abandoned slot retention starts ticking immediately

On the standby `postgresql.conf`:

    primary_conninfo = 'host=primary.example.com user=replicator'
    primary_slot_name = 'standby_1'

The slot now persists across standby disconnects. Without the slot, a brief standby outage could let the primary recycle WAL the standby still needs.

### Recipe 3 — Create a logical slot for CDC outside `CREATE SUBSCRIPTION`

When using `pg_recvlogical` or a custom CDC consumer (not native logical replication):

    -- Slot creation. wal_level = logical required.
    SELECT pg_create_logical_replication_slot(
        'cdc_stream',     -- slot name
        'pgoutput',       -- output plugin (use 'wal2json' if installed)
        false,            -- temporary = false (permanent)
        false             -- twophase = false (set true to decode PREPARE TRANSACTION)
    );

    -- Peek changes (non-consuming, safe for inspection)
    SELECT lsn, xid, substring(data, 1, 100)
    FROM pg_logical_slot_peek_changes('cdc_stream', NULL, 10);

    -- Consume changes (advances confirmed_flush_lsn)
    SELECT lsn, xid, data
    FROM pg_logical_slot_get_changes('cdc_stream', NULL, NULL);

### Recipe 4 — Find abandoned slots and bound disk impact

    SELECT
        slot_name,
        slot_type,
        database,
        active,
        active_pid,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
        wal_status,
        pg_size_pretty(safe_wal_size) AS bytes_until_lost
    FROM pg_replication_slots
    ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;

Interpretation tree:

- `active = false` + `retained_wal > 1GB` → likely abandoned. Investigate.
- `wal_status = 'extended'` → consumer lagging or `max_slot_wal_keep_size` headroom thin.
- `wal_status = 'lost'` → slot is dead; drop it.
- `safe_wal_size < 100MB` → invalidation imminent if consumer doesn't catch up.

### Recipe 5 — Drop a confirmed-abandoned slot

    -- Step 1: Verify it's been inactive long enough (PG17+ inactive_since)
    SELECT slot_name, active, inactive_since, now() - inactive_since AS dead_for
    FROM pg_replication_slots
    WHERE slot_name = 'old_subscriber_slot';

    -- Step 2: If certain it's abandoned, drop it
    SELECT pg_drop_replication_slot('old_subscriber_slot');

    -- Step 3: Force a checkpoint to reclaim WAL immediately
    CHECKPOINT;

> [!WARNING] Dropping a logical slot is irreversible
> The subscriber must be rebuilt against a fresh snapshot. Drop only when certain the subscriber is gone or has been migrated.

### Recipe 6 — Monitor `catalog_xmin` and `VACUUM` blockage

Logical slots hold the cluster-wide xmin horizon back. If `VACUUM` isn't reclaiming dead tuples:

    -- Check what's holding xmin back
    SELECT
        slot_name,
        slot_type,
        catalog_xmin,
        xmin,
        age(catalog_xmin) AS catalog_xmin_age,
        active,
        database
    FROM pg_replication_slots
    WHERE catalog_xmin IS NOT NULL OR xmin IS NOT NULL
    ORDER BY age(coalesce(catalog_xmin, xmin)) DESC;

If `catalog_xmin_age` exceeds `autovacuum_freeze_max_age * 0.5`, the slot is at risk of triggering a wraparound emergency. Either get the subscriber to catch up or drop the slot.

Cross-check against the cluster-wide xmin horizon:

    -- Compare slot catalog_xmin to current pg_database datfrozenxid
    SELECT
        d.datname,
        age(d.datfrozenxid) AS db_frozenxid_age,
        (SELECT min(age(catalog_xmin))
         FROM pg_replication_slots
         WHERE catalog_xmin IS NOT NULL) AS oldest_slot_catalog_xmin_age
    FROM pg_database d
    ORDER BY age(d.datfrozenxid) DESC;

If the slot's `catalog_xmin_age` matches `datfrozenxid_age` on the database in question, the slot is the binding constraint on VACUUM-freeze progress.

### Recipe 7 — PG17+ failover-slot setup for HA logical replication

Goal: subscriber survives primary failover.

Primary `postgresql.conf`:

    wal_level = logical
    max_replication_slots = 16
    max_wal_senders = 16
    synchronized_standby_slots = 'standby_1_slot, standby_2_slot'

Standby `postgresql.conf` (each standby):

    primary_slot_name = 'standby_1_slot'   -- (or standby_2_slot)
    sync_replication_slots = on
    hot_standby_feedback = on              -- required so synced slot xmin survives

Create the logical slot WITH `failover = true`:

    -- On primary
    SELECT pg_create_logical_replication_slot(
        'failover_cdc',
        'pgoutput',
        false,   -- temporary
        false,   -- twophase
        true     -- failover ← THIS IS THE KEY PARAMETER
    );

    -- OR via subscription on the consumer side
    CREATE SUBSCRIPTION my_sub
    CONNECTION '...'
    PUBLICATION pub
    WITH (failover = true);

Verify sync is working on each standby:

    SELECT slot_name, slot_type, failover, synced, inactive_since
    FROM pg_replication_slots
    WHERE failover = true;

After failover, the subscriber reconnects to the new primary; the synced slot has the right state.

### Recipe 8 — PG17+ on-demand sync from standby

If `sync_replication_slots = off` (or for testing), manually trigger:

    -- Run on the STANDBY
    SELECT pg_sync_replication_slots();

Verbatim: *"This function can only be executed on the standby server. ... Note that this function is primarily intended for testing and debugging purposes and should be used with caution."*[^functions-admin]

### Recipe 9 — Advance a stuck logical slot past a poison transaction

A subscriber may be stuck on a transaction it can't apply (e.g., FK violation on subscriber side). To skip it:

    -- Find current confirmed_flush_lsn
    SELECT slot_name, confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = 'sub_slot';

    -- Find target LSN past the poison transaction (use pg_waldump to inspect)
    -- Advance the slot
    SELECT pg_replication_slot_advance('sub_slot', '0/1A2B3C4D'::pg_lsn);

Verbatim caveat: *"The slot will not be moved backwards, and it will not be moved beyond the current insert location."*[^functions-admin]

PG17+ failover-slot caveat: if the slot has `failover = true`, this call BLOCKS until all `synchronized_standby_slots` confirm WAL — operationally important when debugging.

### Recipe 10 — Per-database slot inventory

    SELECT
        coalesce(database, '<physical>') AS db,
        slot_type,
        count(*) AS slots,
        count(*) FILTER (WHERE active) AS active,
        count(*) FILTER (WHERE NOT active) AS inactive,
        count(*) FILTER (WHERE wal_status = 'lost') AS lost
    FROM pg_replication_slots
    GROUP BY 1, 2
    ORDER BY 1, 2;

### Recipe 11 — PG18+ idle-slot auto-invalidation

PG18 makes auto-cleanup possible without scripts:

    -- postgresql.conf
    idle_replication_slot_timeout = 7d   -- invalidate slots idle > 7 days
    -- restart not needed; SIGHUP is enough

After setting, slots with `pg_replication_slots.inactive_since` older than 7 days will be invalidated at the next checkpoint. Verify:

    SELECT
        slot_name,
        active,
        inactive_since,
        now() - inactive_since AS idle_duration,
        invalidation_reason
    FROM pg_replication_slots
    WHERE NOT active
    ORDER BY inactive_since;

To force immediate invalidation rather than waiting for checkpoint:

    CHECKPOINT;

### Recipe 12 — Diagnose logical-decoding memory pressure

If a logical slot is spilling transactions to disk frequently, raise `logical_decoding_work_mem`:

    SELECT
        slot_name,
        spill_txns,
        spill_count,
        pg_size_pretty(spill_bytes) AS spill_bytes,
        stream_txns,
        stream_count,
        pg_size_pretty(stream_bytes) AS stream_bytes,
        total_txns,
        pg_size_pretty(total_bytes) AS total_bytes
    FROM pg_stat_replication_slots
    ORDER BY spill_bytes DESC;

If `spill_bytes` is a meaningful fraction of `total_bytes` (say > 10%), raise the GUC on the primary:

    ALTER SYSTEM SET logical_decoding_work_mem = '256MB';
    SELECT pg_reload_conf();

### Recipe 13 — Copy a slot for a test environment

Fork a logical slot to test a CDC schema change without disturbing production:

    SELECT pg_copy_logical_replication_slot(
        'prod_cdc',           -- source
        'test_cdc',           -- destination
        true,                 -- temporary (auto-released on session end)
        'wal2json'            -- can change output plugin
    );

Both slots receive the same WAL. Test consumer drains `test_cdc`; production keeps draining `prod_cdc`. Verbatim restriction: *"Copy of an invalidated slot is not allowed."*[^functions-admin]

### Recipe 14 — Audit slot capacity headroom

    SELECT
        current_setting('max_replication_slots')::int AS max_slots,
        current_setting('max_wal_senders')::int AS max_walsenders,
        (SELECT count(*) FROM pg_replication_slots) AS current_slots,
        (SELECT count(*) FROM pg_stat_replication) AS current_walsenders,
        current_setting('max_replication_slots')::int -
            (SELECT count(*) FROM pg_replication_slots) AS slot_headroom;

If `slot_headroom < 2`, plan to raise `max_replication_slots`. Note: requires server restart.

## Gotchas / Anti-patterns

1. **Abandoned slot fills `pg_wal` — the #1 production incident.** Default `max_slot_wal_keep_size = -1` means unlimited retention. Always set it. Pair with monitoring on `pg_replication_slots WHERE active = false`.
2. **Dropping a slot is destructive.** A logical subscriber whose slot is dropped can never resume — must rebootstrap. A physical standby whose slot is dropped becomes vulnerable to WAL recycling. Verify before dropping.
3. **`wal_status = 'lost'` is one-way.** The slot cannot be repaired. Drop and recreate.
4. **`invalidation_reason` applies to BOTH logical and physical slots** (PG17+). Common misconception is logical-only. Verbatim PG17 docs: *"It is set for both logical and physical slots."*[^view-pg-replication-slots-17]
5. **`conflicting` is logical-only.** Always NULL for physical slots in PG16/17/18.
6. **Logical slot holds `catalog_xmin` back cluster-wide** — not just on its own database. An abandoned logical slot on database `app1` can prevent `VACUUM` from cleaning up dead catalog rows on `app2`.
7. **Temporary slots (`temporary = true`) are released on session end OR on any error.** Useful for one-shot CDC but not for long-running subscribers. They are also released on the consumer disconnecting.
8. **`pg_logical_slot_get_changes()` consumes; `pg_logical_slot_peek_changes()` does not.** During debugging, `_get_` will silently advance the slot past changes the real consumer never received.
9. **`max_replication_slots` requires server restart.** Plan capacity at deployment time. Setting it lower than the current count prevents server start.
10. **`wal_keep_size` and slots are parallel mechanisms.** Both apply. WAL is retained until BOTH thresholds say it can be removed.
11. **PG13 introduced `max_slot_wal_keep_size`; the `wal_status` column came in the same release.** Pre-PG13 clusters cannot bound slot WAL retention except by manual monitoring.
12. **PG17 failover slots require `wal_level = logical` + `hot_standby_feedback = on` + slot created with `failover = true` + `synchronized_standby_slots` on primary + `sync_replication_slots = on` on standby.** Missing any one breaks the chain.
13. **`synchronized_standby_slots` blocks `pg_replication_slot_advance` / `pg_logical_slot_get_changes` / `pg_logical_slot_peek_changes`** when called against logical failover slots until all listed physical slots ack WAL. Operational consequence: a slow or disconnected standby can stall logical-slot management functions.
14. **PG18 `idle_replication_slot_timeout` operates at checkpoint, not in real-time.** A slot exceeding the threshold is not invalidated until the next checkpoint. Force `CHECKPOINT` for prompt cleanup.
15. **Synced slots on standby are always considered inactive.** Verbatim: *"Synced slots are always considered to be inactive because they don't perform logical decoding to produce changes."*[^runtime-config-replication-18] `idle_replication_slot_timeout` therefore does NOT apply to them — they are exempt.
16. **`pg_sync_replication_slots()` is for testing, not production.** Production should use `sync_replication_slots = on` which spawns a background slotsync worker. Verbatim PG17 docs: *"this function is primarily intended for testing and debugging purposes."*[^functions-admin]
17. **`pg_replication_slot_advance` can only move FORWARD.** No way to rewind a logical slot to an earlier LSN (would require dropping and recreating).
18. **`pg_copy_*_replication_slot` cannot copy an invalidated slot.** Drop + recreate the source first.
19. **Logical slots survive crash, but the position is persisted only at checkpoint.** Verbatim: *"in the case of a crash the slot may return to an earlier LSN, which will then cause recent changes to be sent again when the server restarts."*[^logicaldecoding] Consumers must be idempotent or tolerate replay across this window.
20. **Slot creation requires connection from the consumer or explicit `immediately_reserve = true`** — without one of those, `restart_lsn` is NULL and no WAL is retained yet.
21. **`pg_stat_replication_slots` is PG14+.** Pre-PG14 has no decoding-statistics view.
22. **Slot names use a restricted character set.** Verbatim: *"Each replication slot has a name, which can contain lower-case letters, numbers, and the underscore character."*[^warm-standby] No uppercase, no hyphens, no spaces.
23. **`wal_sender_timeout` terminates the connection, not the slot.** A walsender process exits after `wal_sender_timeout`, but the slot remains and continues retaining WAL. The slot stays `active = false` until the consumer reconnects (or until invalidation).

## See Also

- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical streaming uses physical slots
- [`74-logical-replication.md`](./74-logical-replication.md) — `CREATE SUBSCRIPTION` creates logical slots
- [`76-logical-decoding.md`](./76-logical-decoding.md) — output plugins consume logical slots
- [`77-standby-failover.md`](./77-standby-failover.md) — failover slot promotion procedure
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — `catalog_xmin` and xmin horizon
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM blocked by `catalog_xmin`
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — slot-pinned xmin can cause wraparound emergency
- [`33-wal.md`](./33-wal.md) — `wal_level`, `wal_keep_size`, WAL archiving
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_replication`, `pg_stat_replication_slots` full reference
- [`78-ha-architectures.md`](./78-ha-architectures.md) — slot lifecycle decisions within HA cluster design
- [`79-patroni.md`](./79-patroni.md) — Patroni manages slot creation and cleanup for HA replicas
- [`82-monitoring.md`](./82-monitoring.md) — alerting thresholds for slot lag

## Sources

[^warm-standby]: PostgreSQL 16 — Warm Standby chapter, Streaming Replication Slots section. https://www.postgresql.org/docs/16/warm-standby.html
[^logicaldecoding]: PostgreSQL 16 — Logical Decoding Concepts. https://www.postgresql.org/docs/16/logicaldecoding-explanation.html
[^logicaldecoding-18]: PostgreSQL 18 — Logical Decoding Concepts. https://www.postgresql.org/docs/18/logicaldecoding-explanation.html
[^view-pg-replication-slots]: PostgreSQL 16 — `pg_replication_slots` view. https://www.postgresql.org/docs/16/view-pg-replication-slots.html
[^view-pg-replication-slots-17]: PostgreSQL 17 — `pg_replication_slots` view. https://www.postgresql.org/docs/17/view-pg-replication-slots.html
[^view-pg-replication-slots-18]: PostgreSQL 18 — `pg_replication_slots` view. https://www.postgresql.org/docs/18/view-pg-replication-slots.html
[^functions-admin]: PostgreSQL 16 — System Administration Functions §9.27.6 Replication Management Functions. https://www.postgresql.org/docs/16/functions-admin.html
[^runtime-config-replication]: PostgreSQL 16 — Server Configuration: Replication. https://www.postgresql.org/docs/16/runtime-config-replication.html
[^runtime-config-replication-18]: PostgreSQL 18 — Server Configuration: Replication. https://www.postgresql.org/docs/18/runtime-config-replication.html
[^monitoring-stats]: PostgreSQL 16 — Monitoring Database Activity, `pg_stat_replication_slots` view. https://www.postgresql.org/docs/16/monitoring-stats.html
[^pg13-release]: PostgreSQL 13 Release Notes. https://www.postgresql.org/docs/release/13.0/
[^pg14-release]: PostgreSQL 14 Release Notes. https://www.postgresql.org/docs/release/14.0/
[^pg15-release]: PostgreSQL 15 Release Notes. https://www.postgresql.org/docs/release/15.0/
[^pg16-release]: PostgreSQL 16 Release Notes. https://www.postgresql.org/docs/release/16.0/
[^pg17-release]: PostgreSQL 17 Release Notes. https://www.postgresql.org/docs/release/17.0/
[^pg18-release]: PostgreSQL 18 Release Notes. https://www.postgresql.org/docs/release/18.0/

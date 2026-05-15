# MVCC Internals

PostgreSQL implements concurrency control via **multi-version concurrency control** (MVCC). Every row that has ever existed is identified by an `(xmin, xmax)` pair stamped into its tuple header. A reading transaction picks a *snapshot* — a frozen point-in-time view of which transactions have committed — and answers visibility questions by comparing each tuple's `(xmin, xmax)` against that snapshot. There is no row-level read lock; readers and writers do not block each other.

Data-structure view of MVCC: how tuples and snapshots are laid out and how the visibility decision is computed. Operational counterparts: `28-vacuum-autovacuum.md` for dead-tuple reclamation, `29-transaction-id-wraparound.md` for the 32-bit XID counter and freeze process, `30-hot-updates.md` for in-place UPDATE optimization, `42-isolation-levels.md` for snapshot semantics under Read Committed / Repeatable Read / Serializable, and `43-locking.md` for explicit locks.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The tuple header](#the-tuple-header)
    - [The infomask bits](#the-infomask-bits)
    - [The visibility rule](#the-visibility-rule)
    - [Snapshot construction](#snapshot-construction)
    - [Hint bits](#hint-bits)
    - [MultiXact](#multixact)
    - [The visibility map](#the-visibility-map)
    - [Dead, live, all-visible, all-frozen — four states](#dead-live-all-visible-all-frozen--four-states)
    - [The xmin horizon](#the-xmin-horizon)
    - [The long-running transaction problem](#the-long-running-transaction-problem)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- You are diagnosing why a row "is still there" after a `DELETE` (it is, until VACUUM reclaims it).
- You are diagnosing why VACUUM is not reclaiming dead tuples even though they appear dead (a long-running transaction is holding the xmin horizon back).
- You are looking at `pg_stat_activity.backend_xmin` and trying to interpret it.
- You are reading `pageinspect` output (`heap_page_items()`, `heap_tuple_infomask_flags()`) and decoding the infomask bits.
- You are trying to understand why an index-only scan still touches the heap (the visibility map for that page isn't `all-visible`).
- You need to explain why `SELECT count(*)` is not cheap on PostgreSQL — every row's visibility is computed against the reader's snapshot.
- You are choosing an isolation level and need the underlying snapshot model.

Use [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the operational VACUUM surface, [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) for the freeze loop and wraparound prevention, and [`42-isolation-levels.md`](./42-isolation-levels.md) for SQL-level snapshot semantics.

## Mental Model

Five rules that drive every gotcha downstream:

1. **Every tuple has `xmin` (the XID that created it) and `xmax` (the XID that deleted/updated it, or 0).** An `UPDATE` is logically a `DELETE` of the old tuple followed by an `INSERT` of the new one; the old tuple gets its `xmax` stamped and a new tuple is written with a fresh `xmin`. This is the same machinery for inserts, updates, and deletes — there is no in-place update of a row's user-visible data without writing a new tuple.[^mvcc-intro][^page-layout]
2. **A snapshot is `(xmin, xmax, xip[])` — the set of "what was running and what had already committed when I took this snapshot."** Visibility is a *function* of the tuple's `xmin` / `xmax` evaluated against the reader's snapshot; nothing about the tuple changes when a transaction commits. The same tuple is visible to one reader and invisible to another depending on whose snapshot you ask.[^current-snapshot]
3. **`(xmin, xmax)` are bare 32-bit XIDs.** Wraparound is real, finite, and must be prevented by freezing. The `FrozenTransactionId` sentinel marks a tuple as "older than every normal XID, always visible." Freezing is what VACUUM does. See [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).[^routine-vacuuming]
4. **Reading never blocks writing; writing never blocks reading.** A `SELECT` does not take row-level locks. Two concurrent `UPDATE`s on the same row conflict, but a `SELECT` against an actively-being-updated row simply sees the pre-update version (under Read Committed at the start of the statement; under Repeatable Read at the start of the transaction).[^mvcc-intro][^iso]
5. **A tuple cannot be reclaimed while any running transaction's snapshot could still see it.** Even a tuple whose `xmax` committed long ago stays in the heap if even one open transaction has a snapshot from before that commit. The cluster-wide *xmin horizon* — the minimum `xmin` across every running transaction, replication slot, and prepared transaction — gates reclamation. Long-running transactions cause bloat cluster-wide.[^routine-vacuuming]

## Syntax / Mechanics

### The tuple header

Every heap tuple begins with a fixed-size `HeapTupleHeaderData` of **23 bytes** on most architectures, followed by an optional null bitmap, an optional OID (now always absent because `WITH OIDS` was removed in PG12), and the user data.[^page-layout]

| Field | Bytes | Contents |
|---|---|---|
| `t_xmin` | 4 | XID that inserted this tuple |
| `t_xmax` | 4 | XID that deleted or row-locked it (0 if neither) |
| `t_cid` (union with `t_xvac`) | 4 | Command ID within the inserting/deleting transaction (cmin / cmax) — VACUUM FULL also reuses this slot |
| `t_ctid` | 6 | `(blocknum, offnum)` pointer — for an updated tuple, points at the new version |
| `t_infomask2` | 2 | Number of attributes plus a few bit flags (`HEAP_HOT_UPDATED`, `HEAP_ONLY_TUPLE`, `HEAP_KEYS_UPDATED`) |
| `t_infomask` | 2 | Status flags — committed/aborted/multi/frozen/locked, plus null and variable-width markers |
| `t_hoff` | 1 | Offset to user data (accounts for null bitmap if present) |

The verbatim docs description:

> *"All table rows are structured in the same way. There is a fixed-size header (occupying 23 bytes on most machines), followed by an optional null bitmap, an optional object ID field, and the user data."*[^page-layout]

The docs deliberately do not enumerate every infomask bit — they say so:

> *"All the details can be found in `src/include/access/htup_details.h`."*[^page-layout]

That source header is the canonical authority for bit constants.[^htup-details-h]

### The infomask bits

Source-of-truth: `src/include/access/htup_details.h`.[^htup-details-h] The bits that matter for visibility, plus their `pageinspect` decoding via `heap_tuple_infomask_flags()`:[^pageinspect-htif]

`t_infomask` — visibility-relevant bits:

| Bit | Meaning |
|---|---|
| `HEAP_XMIN_COMMITTED` | The inserter committed; visibility check can skip a CLOG lookup |
| `HEAP_XMIN_INVALID` | The inserter aborted (or, when combined with `HEAP_XMIN_COMMITTED`, the tuple is *frozen*) |
| `HEAP_XMIN_FROZEN` | Convenience macro = both bits above; equivalent to `t_xmin = FrozenTransactionId` semantics |
| `HEAP_XMAX_COMMITTED` | The deleter committed |
| `HEAP_XMAX_INVALID` | The deleter aborted, *or* `t_xmax` is currently a row lock that has been released |
| `HEAP_XMAX_IS_MULTI` | `t_xmax` is a MultiXactId, not a plain XID — multiple transactions locked/deleted this row |
| `HEAP_XMAX_LOCK_ONLY` | The XMAX is a row lock, not a delete |
| `HEAP_XMAX_KEYSHR_LOCK`, `HEAP_XMAX_SHR_LOCK`, `HEAP_XMAX_EXCL_LOCK` | Lock mode if `LOCK_ONLY` |
| `HEAP_HASNULL` | A null bitmap follows the header |
| `HEAP_HASVARWIDTH` | At least one variable-width attribute |
| `HEAP_HASEXTERNAL` | A TOAST pointer is present — see [`31-toast.md`](./31-toast.md) |

`t_infomask2` — physical-layout-relevant bits:

| Bit | Meaning |
|---|---|
| `HEAP_KEYS_UPDATED` | The UPDATE changed a unique-index column — non-HOT-eligible |
| `HEAP_HOT_UPDATED` | This is the OLD tuple, and it was UPDATEd via HOT to a new tuple on the same page |
| `HEAP_ONLY_TUPLE` | This is the NEW tuple of a HOT chain — not reachable from any index |

The HOT-related bits are the gateway to the [`30-hot-updates.md`](./30-hot-updates.md) deep dive; see it for the chain-walking logic.

Quick decoder via pageinspect — given a 16-bit infomask integer, expand to symbolic names:

    SELECT heap_tuple_infomask_flags('2305'::int, '0'::int);
    --   flags                 raw_flags
    --   {HEAP_HASVARWIDTH, HEAP_XMAX_INVALID, HEAP_XMIN_COMMITTED}   {}

### The visibility rule

A heap tuple is visible to a transaction `T` (whose snapshot is `S`) if and only if:

1. `t_xmin` is in a state that `S` considers "committed and earlier" — i.e. `t_xmin` is committed in CLOG, `t_xmin < S.xmax`, and `t_xmin` is not in `S.xip` (the active-transactions array).
2. **AND** either `t_xmax = 0` (the tuple has not been deleted or row-locked), or `t_xmax` is in a state that `S` considers "not yet committed" — i.e. `t_xmax` is still running (in `S.xip`), `t_xmax >= S.xmax`, or `t_xmax` aborted in CLOG.

A tuple's `xmax = T_self` always sees its own deletion (under Read Committed) — handled by the `cmin/cmax` (command-ID) check, which is one level below `xid`-level visibility and is what makes `RETURNING *` after a `DELETE` return the deleted rows from the current statement's frame.

The Read Committed and Repeatable Read snapshots come from different *moments in time* but use the same visibility rule. The verbatim docs definition:

> *"a SELECT query (without a FOR UPDATE/SHARE clause) sees only data committed before the query began; it never sees either uncommitted data or changes committed by concurrent transactions during the query's execution."*[^iso] (Read Committed — per-statement snapshot)

> *"The Repeatable Read isolation level only sees data committed before the transaction began ... a query in a repeatable read transaction sees a snapshot as of the start of the first non-transaction-control statement in the transaction, not as of the start of the current statement within the transaction."*[^iso] (Repeatable Read — per-transaction snapshot)

> *"The Serializable isolation level provides the strictest transaction isolation. This level emulates serial transaction execution for all committed transactions; as if transactions had been executed one after another, serially, rather than concurrently."*[^iso] (Serializable — same snapshot as RR, plus predicate-lock conflict detection)

See [`42-isolation-levels.md`](./42-isolation-levels.md) for the full snapshot-acquisition rules and the SQLSTATE 40001 retry pattern.

### Snapshot construction

A snapshot is in-memory and consists of:

| Field | Contents |
|---|---|
| `xmin` | Lowest XID currently running (anything strictly less is "definitely committed or aborted") |
| `xmax` | First XID *not yet* assigned at snapshot acquisition (anything strictly less than this is decidable) |
| `xip[]` | Array of XIDs of transactions in progress at acquisition time |
| `xcnt` | Count of entries in `xip[]` |
| `subxcnt`, `suboverflowed` | Subtransaction tracking — see below |

You can introspect the current snapshot via the `pg_snapshot` type:[^functions-info]

    SELECT pg_current_snapshot();
    --   pg_current_snapshot
    --   1003:1015:1007,1009,1012

    SELECT
      pg_snapshot_xmin(s)  AS xmin,
      pg_snapshot_xmax(s)  AS xmax,
      pg_snapshot_xip(s)   AS in_progress
    FROM pg_current_snapshot() AS s;

The docs definition:

> *"Returns a current snapshot, a data structure showing which transaction IDs are now in-progress. Only top-level transaction IDs are included in the snapshot; subtransaction IDs are not shown."*[^functions-info]

The "subxids are not shown" rule matters: a snapshot tracks subtransactions only up to a small inline array (default 64). If a backend has more open subtransactions than fits, the snapshot is marked *overflowed*, and every visibility check for a tuple inserted by that backend must consult the `pg_subtrans` SLRU instead of the inline array — a real source of contention. See [`41-transactions.md`](./41-transactions.md) for the savepoint cost and `subtrans` SLRU pressure.

To check whether a specific transaction is visible to a captured snapshot:

    SELECT pg_visible_in_snapshot('12345'::xid8, pg_current_snapshot());
    --   t   -- already committed at the time my snapshot was taken
    --   f   -- still running, or committed after my snapshot

`pg_visible_in_snapshot` returns true iff the tested XID is *strictly less than* `snapshot.xmax` AND *not* a member of `snapshot.xip`. It does **not** consult CLOG — it answers "was this transaction outside the active-transactions set when the snapshot was taken?" not "is this transaction committed."

> [!NOTE] PostgreSQL 14
> *"Improve the speed of computing MVCC visibility snapshots on systems with many CPUs and high session counts (Andres Freund). This also improves performance when there are many idle sessions."*[^pg14-snapshot] The PG14 snapshot-scalability work reduced cache-line contention on `ProcArray` when many connections coexist — relevant for any cluster routinely above ~256 active backends.

### Hint bits

The first time a backend evaluates `t_xmin` or `t_xmax` against CLOG and determines the answer (committed, aborted, in-progress), it stamps the corresponding infomask bit (`HEAP_XMIN_COMMITTED`, `HEAP_XMIN_INVALID`, `HEAP_XMAX_COMMITTED`, `HEAP_XMAX_INVALID`) into the tuple header so future readers can skip the CLOG lookup. This is the *hint bit* mechanism.

Hint bits are:

- **Set asynchronously and lazily.** The first reader after commit pays a small per-tuple cost to look up CLOG and stamp the bit. Subsequent readers get a CLOG-free fast path.
- **Not WAL-logged by default** (unless `wal_log_hints = on` or `data_checksums` is enabled — both of which are needed for `pg_rewind` to work correctly; see [`89-pg-rewind.md`](./89-pg-rewind.md)).
- **Dirty pages.** A pure `SELECT` against just-committed data can dirty pages — the hint-bit update is a heap modification. The first scan after a bulk insert is *much* more expensive than the second; this is why pre-warming after bulk loads can be valuable.

> [!NOTE] PostgreSQL 18
> Data checksums are now enabled by default in `initdb` for new clusters.[^pg18-checksums] This implies `wal_log_hints` is effectively in force for those clusters — every hint-bit update is WAL-logged. Operationally: the post-bulk-load "first scan" pages still get dirtied, but the WAL volume is paid back by `pg_rewind` and corruption-detection capability. See [`88-corruption-recovery.md`](./88-corruption-recovery.md).

### MultiXact

When a single XID is enough to represent who is acting on a row, `t_xmax` holds that XID. When **multiple** transactions concurrently lock or update the same row — for example, `SELECT ... FOR SHARE` from session A while session B holds `SELECT ... FOR KEY SHARE` — the limited space in the tuple header cannot store multiple XIDs directly. Instead, `t_xmax` holds a **MultiXactId**, and the `HEAP_XMAX_IS_MULTI` bit in `t_infomask` is set. The actual transaction list and lock-mode metadata live in the `pg_multixact/` SLRU directory.

The verbatim docs description:

> *"Multixact IDs are used to support row locking by multiple transactions. Since there is only limited space in a tuple header to store lock information, that information is encoded as a 'multiple transaction ID', or multixact ID for short, whenever there is more than one transaction concurrently locking a row."*[^routine-vacuuming]

> *"Like transaction IDs, multixact IDs are implemented as a 32-bit counter and corresponding storage, all of which requires careful aging management, storage cleanup, and wraparound handling."*[^routine-vacuuming]

MultiXact wraparound is independent of XID wraparound — there is a separate `pg_class.relminmxid` / `pg_database.datminmxid` accounting and a separate `autovacuum_multixact_freeze_max_age` GUC. The same anti-wraparound autovacuum machinery handles both; see [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

Two operational signals to watch:

| Signal | Meaning |
|---|---|
| Workload uses `SELECT ... FOR KEY SHARE` or `FOR SHARE` heavily | High MultiXact creation rate, `pg_multixact/` SLRU pressure |
| Concurrent foreign-key check + UPDATE on the parent row | Each FK touch on the child takes a `FOR KEY SHARE` row lock, contributing to MultiXact pressure |

You can inspect the MultiXact membership of a specific MultiXactId via `pg_get_multixact_members(mxid)`:

    SELECT * FROM pg_get_multixact_members('12345'::xid);
    --    xid  | mode
    --   ------+------------
    --    1234 | keysh
    --    1240 | sh

### The visibility map

Each heap relation has a parallel **visibility map** (VM) fork named `<relfilenode>_vm`. Two bits per heap page:

| Bit | Set means... |
|---|---|
| `VISIBILITYMAP_ALL_VISIBLE` | Every tuple on this heap page is visible to *every* current and future transaction (no in-progress XIDs, no uncommitted deletes) |
| `VISIBILITYMAP_ALL_FROZEN` | Every tuple on this heap page is frozen — even an anti-wraparound VACUUM can skip this page |

Verbatim docs:

> *"Each heap relation has a Visibility Map (VM) to keep track of which pages contain only tuples that are known to be visible to all active transactions; it also keeps track of which pages contain only frozen tuples."*[^vm]

> *"The first bit, if set, indicates that the page is all-visible, or in other words that the page does not contain any tuples that need to be vacuumed. This information can also be used by index-only scans to answer queries using only the index tuple."*[^vm]

> *"The map is conservative in the sense that we make sure that whenever a bit is set, we know the condition is true, but if a bit is not set, it might or might not be true."*[^vm]

Two operational consequences:

1. **Index-only scans need the VM.** An index-only scan reads only the index. Before returning a row from an index entry, it consults the VM: if the page is `ALL_VISIBLE`, the index entry is trusted as-is; otherwise it falls back to a heap fetch to recheck visibility. A nonzero `Heap Fetches` in `EXPLAIN (ANALYZE, BUFFERS)` means the VM was not `ALL_VISIBLE` for that page — typically because VACUUM is behind. See [`56-explain.md`](./56-explain.md).
2. **Anti-wraparound VACUUM skips `ALL_FROZEN` pages.** This is what makes the freeze process scalable on append-mostly tables — VACUUM eventually freezes everything and then can skip it forever.

The `pg_visibility` extension introspects the VM:

    CREATE EXTENSION pg_visibility;
    SELECT * FROM pg_visibility_map('orders'::regclass) WHERE NOT all_visible LIMIT 10;

### Dead, live, all-visible, all-frozen — four states

Every tuple in the heap is in one of four states at any moment from the perspective of the cluster's current xmin horizon:

| State | `xmin` state | `xmax` state | Reclaimable? | Counted in `n_live_tup` |
|---|---|---|---|---|
| **Live** | committed, ≥ horizon | 0 or aborted | No — still visible | Yes |
| **Recently dead** | committed | committed, ≥ horizon | No — still visible to some snapshot | No (counted in `n_dead_tup`) |
| **Dead** | committed | committed, < horizon | Yes — VACUUM can reclaim | No |
| **Aborted** | aborted | n/a | Yes — never was visible | No |

VACUUM's job is to find tuples in the "dead" state and reclaim them. A tuple is dead iff its `xmax` is committed *and* less than the cluster's xmin horizon — meaning no current or future snapshot can see it.

`pg_stat_all_tables.n_dead_tup` is the planner's estimate of dead tuples; it drives autovacuum scheduling. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

### The xmin horizon

The **cluster-wide xmin horizon** is the minimum of:

1. `pg_stat_activity.backend_xmin` across every running backend (each active transaction's snapshot xmin).
2. The `xmin` field of every active replication slot (physical and logical).
3. The `xmin` of every prepared transaction (2PC; see [`41-transactions.md`](./41-transactions.md)).
4. Standby `xmin` reported via `hot_standby_feedback`, if enabled (see [`77-standby-failover.md`](./77-standby-failover.md)).
5. Cursors held by `WITH HOLD` cursors across `COMMIT` (see [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md)).

VACUUM can only reclaim tuples whose `xmax` committed strictly before this horizon. Anything younger is "recently dead" — VACUUM knows it's dead but cannot remove it because some snapshot could still see it.

Two backend-level columns expose this directly:

> *"`backend_xid xid`: Top-level transaction identifier of this backend, if any."*[^monitoring]

> *"`backend_xmin xid`: The current backend's xmin horizon."*[^monitoring]

The single most important diagnostic query for "why is VACUUM not reclaiming bloat":

    SELECT pid, datname, usename, state, backend_xmin, xact_start, query
    FROM pg_stat_activity
    WHERE backend_xmin IS NOT NULL
    ORDER BY age(backend_xmin) DESC
    LIMIT 10;

Whichever PID is at the top — that's the backend whose snapshot is holding the horizon back.

### The long-running transaction problem

A single transaction that has held a snapshot for hours or days will hold the xmin horizon back for the entire cluster, on every table. Bloat accumulates everywhere — even on tables the long-running transaction has never read.

The five xmin horizon sources (§The xmin horizon above) map to four triage targets:

| Offender | Symptom | Fix |
|---|---|---|
| Idle-in-transaction session | `state = 'idle in transaction'`, `xact_start` very old | `idle_in_transaction_session_timeout = '5min'` |
| Long-running query | `state = 'active'`, same query for hours | `statement_timeout`; kill via `pg_cancel_backend` |
| Abandoned replication slot | `pg_replication_slots.active = false`, large `restart_lsn` lag | Drop the slot; see [`75-replication-slots.md`](./75-replication-slots.md) |
| Stale prepared transaction | Row in `pg_prepared_xacts` from days ago | `ROLLBACK PREPARED 'name'` |

The `pg_stat_activity.backend_xmin` diagnostic (above) surfaces the first two; `pg_replication_slots.xmin` and `pg_prepared_xacts` surface the last two.

> [!WARNING] Removed in PostgreSQL 17
> The `old_snapshot_threshold` GUC was removed in PG17.[^pg17-ost] It previously allowed VACUUM to reclaim rows that *could* still be visible to long-running transactions, at the cost of a `snapshot too old` error if those transactions later tried to read them. The feature was rarely operationally clean — a removed cure for the disease this section describes. The modern answer is to fix the long-running-transaction root cause via timeouts and slot hygiene, not to violate snapshot semantics.

### Per-version timeline

| Version | Change | Source |
|---|---|---|
| **PG14** | Snapshot scalability — `ProcArray` lock contention reduced for high session counts; also helps idle sessions | [^pg14-snapshot] |
| **PG14** | `vacuum_failsafe_age` / `vacuum_multixact_failsafe_age` make anti-wraparound VACUUM more aggressive near the limit | [^pg14-failsafe] |
| **PG14** | Earlier wraparound warnings + earlier hard-limit shutdown for both XID and MultiXact | [^pg14-wrap-warn] |
| **PG15** | No headline MVCC changes; aggressive freeze-min-XID/MXID setting | [^pg15-aggressive] |
| **PG16** | Improved VACUUM freeze performance; opportunistic page freezing during non-freeze VACUUM | [^pg16-freeze] |
| **PG16** | `VACUUM (SKIP_DATABASE_STATS, ONLY_DATABASE_STATS)` options for staged stats updates | [^pg16-skipstats] |
| **PG17** | **`old_snapshot_threshold` removed** | [^pg17-ost] |
| **PG17** | VACUUM memory management rewrite — `maintenance_work_mem` no longer silently capped at 1 GB; vacuum on un-indexed tables is faster | [^pg17-vac-mem] |
| **PG17** | `pg_stat_progress_vacuum` columns renamed: `max_dead_tuples → max_dead_tuple_bytes`, `num_dead_tuples → num_dead_item_ids`, plus new `dead_tuple_bytes` | [^pg17-pgsv] |
| **PG18** | Eager freezing during normal (non-aggressive) VACUUM; `vacuum_max_eager_freeze_failure_rate` GUC; `pg_class.relallfrozen` column | [^pg18-eager-freeze] |
| **PG18** | `initdb` enables data checksums by default (implies hint-bit WAL logging by default for new clusters) | [^pg18-checksums] |

PostgreSQL 18 did **not** introduce 64-bit XIDs. Wraparound prevention via freezing remains the operational requirement on all supported majors.

## Examples / Recipes

### Recipe 1 — Decode the infomask on a real row using `pageinspect`

The canonical inspection function returns one row per item-pointer on a heap page:

    CREATE EXTENSION IF NOT EXISTS pageinspect;

    SELECT
      lp        AS item,
      t_xmin    AS xmin,
      t_xmax    AS xmax,
      t_field3  AS cmin_cmax,
      t_ctid    AS ctid,
      to_hex(t_infomask::int)  AS infomask_hex,
      to_hex(t_infomask2::int) AS infomask2_hex,
      heap_tuple_infomask_flags(t_infomask, t_infomask2)
    FROM heap_page_items(get_raw_page('orders', 0))
    ORDER BY lp;

Reading the output:

- `xmin` and `xmax` columns hold the raw XIDs.
- `infomask_hex` decoded via `heap_tuple_infomask_flags()` returns the symbolic flag names — `HEAP_XMIN_COMMITTED`, `HEAP_XMAX_INVALID`, `HEAP_HASNULL`, etc.[^pageinspect-htif]
- An empty `xmax = 0` plus `HEAP_XMAX_INVALID` means the tuple is live; an `xmax > 0` plus `HEAP_XMAX_COMMITTED` means it's been deleted/updated and is reclaimable once the xmin horizon advances past `xmax`.

### Recipe 2 — Find the backend holding the xmin horizon back

    SELECT
      pid,
      datname,
      usename,
      state,
      wait_event_type,
      wait_event,
      age(backend_xmin)       AS xmin_age,
      now() - xact_start      AS xact_duration,
      query
    FROM pg_stat_activity
    WHERE backend_xmin IS NOT NULL
    ORDER BY age(backend_xmin) DESC
    LIMIT 5;

The PID at the top of the result is the one bloating every table. `xmin_age` is measured in XIDs, not seconds; an `xmin_age` of 50 million in a write-heavy cluster might be one minute, while in a quiet cluster it might be days.

### Recipe 3 — Also check replication slots and prepared transactions

    -- Replication slots that are pinning xmin:
    SELECT slot_name, plugin, active, xmin, catalog_xmin,
           pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_retained
    FROM pg_replication_slots
    WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL
    ORDER BY age(coalesce(xmin, catalog_xmin)) DESC;

    -- Prepared transactions (2PC) that are pinning xmin:
    SELECT gid, prepared, owner, database,
           age(transaction::text::xid) AS xact_age
    FROM pg_prepared_xacts
    ORDER BY prepared;

If `pg_replication_slots.active = false` and the slot is old, the slot has been abandoned by its consumer — its `xmin` is still pinning the horizon. Drop it (`SELECT pg_drop_replication_slot('name')`) after confirming with the slot's owner.

### Recipe 4 — Inspect the visibility map for a table

    CREATE EXTENSION IF NOT EXISTS pg_visibility;

    SELECT
      relname,
      pg_size_pretty(pg_relation_size(c.oid)) AS heap_size,
      pg_size_pretty(pg_relation_size(c.oid, 'vm')) AS vm_size,
      (SELECT count(*) FROM pg_visibility_map(c.oid) WHERE all_visible)  AS pages_all_visible,
      (SELECT count(*) FROM pg_visibility_map(c.oid) WHERE all_frozen)   AS pages_all_frozen,
      (SELECT count(*) FROM pg_visibility_map(c.oid))                    AS pages_total
    FROM pg_class c
    WHERE c.relname = 'orders'
      AND c.relkind IN ('r', 'p');

A page count where `pages_all_visible ≈ pages_total` is a healthy append-mostly table where index-only scans will avoid heap fetches. A low ratio means VACUUM is behind or the table has frequent updates.

### Recipe 5 — Find tables with bloated dead tuples (autovacuum debt)

    SELECT
      schemaname,
      relname,
      n_live_tup,
      n_dead_tup,
      round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
      last_autovacuum,
      last_vacuum
    FROM pg_stat_all_tables
    WHERE n_dead_tup > 1000
    ORDER BY n_dead_tup DESC
    LIMIT 20;

A `dead_pct` above 20% on a hot table is autovacuum debt. Either autovacuum is throttled too aggressively (see [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)) or the xmin horizon is being held back (Recipe 2).

### Recipe 6 — Test snapshot semantics interactively

Two psql sessions. Session A:

    -- session A
    BEGIN ISOLATION LEVEL REPEATABLE READ;
    SELECT pg_current_snapshot();                  -- capture xmin/xmax/xip
    SELECT count(*) FROM orders;                   -- N rows

Session B (in parallel):

    -- session B
    INSERT INTO orders ...;                        -- new row, commits

Session A again:

    -- session A (still in transaction)
    SELECT count(*) FROM orders;                   -- still N — RR snapshot is frozen
    SELECT pg_visible_in_snapshot(
        (SELECT pg_current_xact_id_if_assigned()),   -- B's XID hypothetically
        pg_current_snapshot()
    );
    COMMIT;
    SELECT count(*) FROM orders;                   -- N+1

This is the experimental demonstration of the visibility rule: the same row is invisible to session A's snapshot but visible to its post-commit state.

### Recipe 7 — Verify a tuple is or is not frozen

    SELECT
      ctid,
      xmin,
      xmax,
      (heap_tuple_infomask_flags(t_infomask, t_infomask2)).*
    FROM (
      SELECT (heap_page_items(get_raw_page('orders', 0))).*
    ) hp;

A frozen tuple has `HEAP_XMIN_FROZEN` in the flags array. After a `VACUUM FREEZE orders;` followed by re-inspection, all rows on that page should show `HEAP_XMIN_FROZEN`. Alternatively, on PG13+ the raw `xmin` value will be displayed as `2` (`FrozenTransactionId`).

### Recipe 8 — Measure the impact of hint-bit dirtying after a bulk load

    \timing on
    CREATE TABLE bulk_hint_test AS SELECT i FROM generate_series(1, 10_000_000) i;

    -- First SELECT: dirties pages stamping hint bits
    SELECT count(*) FROM bulk_hint_test;          -- record time T1

    -- Now CHECKPOINT to flush the dirty pages
    CHECKPOINT;

    -- Second SELECT: cold pages but no hint-bit work
    SELECT count(*) FROM bulk_hint_test;          -- record time T2

T1 will typically be substantially slower than T2 — the first scan paid the per-tuple CLOG lookup + page-dirty cost. This is exactly the diagnostic for "why is my first query after a bulk load slow?"

### Recipe 9 — Demonstrate MultiXact creation via concurrent FOR KEY SHARE

Set up:

    CREATE TABLE m (id int PRIMARY KEY, val text);
    INSERT INTO m VALUES (1, 'a');

Two sessions both take `FOR KEY SHARE` on row id=1, then inspect:

    -- session A
    BEGIN;
    SELECT * FROM m WHERE id = 1 FOR KEY SHARE;

    -- session B (parallel)
    BEGIN;
    SELECT * FROM m WHERE id = 1 FOR KEY SHARE;   -- does not block

    -- session C (inspect)
    SELECT (heap_tuple_infomask_flags(t_infomask, t_infomask2)).flags,
           t_xmax::text AS multixact_id
    FROM heap_page_items(get_raw_page('m', 0))
    WHERE t_xmin IS NOT NULL;
    -- expect HEAP_XMAX_IS_MULTI, HEAP_XMAX_LOCK_ONLY, HEAP_XMAX_KEYSHR_LOCK
    -- t_xmax holds a multixact id, not a plain xid

    SELECT * FROM pg_get_multixact_members(<multixact_id>::xid);
    -- shows both A and B with mode 'keysh'

This is the canonical way to see MultiXact in action. Foreign-key validation on the parent side of an FK uses exactly this lock mode, which is why FK-heavy workloads stress the `pg_multixact/` SLRU.

### Recipe 10 — Audit subtransaction overflow

    SELECT pid, application_name, backend_xid, backend_xmin,
           (SELECT count(*) FROM pg_locks WHERE pid = a.pid AND locktype = 'transactionid') AS lock_count,
           query
    FROM pg_stat_activity a
    WHERE state = 'active'
      AND backend_xid IS NOT NULL
    ORDER BY lock_count DESC;

A backend with many `transactionid` lock entries is creating many subtransactions per top-level transaction (typical for `EXCEPTION` blocks in tight PL/pgSQL loops — see [`08-plpgsql.md`](./08-plpgsql.md) recipe 8). At >64 simultaneous subxids per backend, the snapshot overflows and every visibility check involving that backend's xids must consult `pg_subtrans`, which becomes a hot SLRU.

### Recipe 11 — Test visibility across an UPDATE (HOT vs non-HOT)

    CREATE TABLE u (id serial PRIMARY KEY, val text, indexed text);
    CREATE INDEX ON u(indexed);
    INSERT INTO u(val, indexed) VALUES ('a', 'x');

    -- A non-indexed-column UPDATE → HOT-eligible
    UPDATE u SET val = 'b' WHERE id = 1;

    -- Inspect: old tuple has HEAP_HOT_UPDATED, new tuple has HEAP_ONLY_TUPLE
    SELECT lp, t_xmin, t_xmax,
           (heap_tuple_infomask_flags(t_infomask, t_infomask2)).flags
    FROM heap_page_items(get_raw_page('u', 0));

The presence of `HEAP_HOT_UPDATED` (on the old) and `HEAP_ONLY_TUPLE` (on the new) means the UPDATE took the HOT path — no new index entries were written. If the UPDATE had touched an indexed column, both bits would be absent and the index would carry an additional entry. See [`30-hot-updates.md`](./30-hot-updates.md).

## Gotchas / Anti-patterns

1. **`SELECT count(*)` is not free** — it must compute visibility for every row. There is no row-count metadata cached in PG. Use `pg_class.reltuples` (planner estimate) or maintain a counter via triggers if you need cheap counts.
2. **Idle-in-transaction sessions silently bloat every table.** `idle_in_transaction_session_timeout` should be set to a value short enough to bound bloat — typically 5-10 minutes in OLTP. Without it, a connection-pool client that holds a transaction open while it does external I/O will hold the cluster xmin horizon back for the duration. See `81-pgbouncer.md`.
3. **`hot_standby_feedback = on` propagates the standby's xmin to the primary.** A long-running query on a standby with feedback on holds the primary's xmin horizon back exactly as if the query were on the primary. Standby reporting queries should be designed to be short, or `hot_standby_feedback` should be off (accepting query cancellations on the standby). See [`77-standby-failover.md`](./77-standby-failover.md).
4. **An abandoned replication slot is an indefinite bloat accelerator.** Slots have no built-in timeout. The `max_slot_wal_keep_size` GUC (PG13+) prevents unbounded *WAL* retention but does *not* release the slot's xmin pin. Monitor `pg_replication_slots` and drop slots whose consumer is gone. See [`75-replication-slots.md`](./75-replication-slots.md).
5. **Hint bits dirty pages on first read.** See §Hint bits above. First `SELECT` after a bulk load is expensive; pre-warm or accept the cost — never benchmark on the first scan.
6. **`VACUUM FULL` is not "VACUUM but more thorough"** — it rewrites the entire table and takes `ACCESS EXCLUSIVE`. Plain VACUUM marks space reusable; `VACUUM FULL` actually shrinks the relation. Use `pg_repack` or `pg_squeeze` for online table-bloat removal (see [`26-index-maintenance.md`](./26-index-maintenance.md)).
7. **A tuple's `xmax > 0` does not mean it was deleted.** It might be a row lock (`HEAP_XMAX_LOCK_ONLY`). The visibility decision depends on `HEAP_XMAX_INVALID` and the lock-mode bits, not just on `xmax`.
8. **`HEAP_XMIN_COMMITTED` set with `HEAP_XMIN_INVALID` also set means frozen, not contradictory.** Both bits set is the encoding of `HEAP_XMIN_FROZEN`. This trips inspectors who try to interpret the bits independently.
9. **Subtransaction overflow is silent.** Once a backend has >64 simultaneous subxids, every subsequent visibility check involving its XIDs hits `pg_subtrans`. The cluster-wide symptom is high `BufferContent` lock contention. Cause: `EXCEPTION` blocks in tight loops (one subxact per iteration; rolling back on exception is what creates the subxact). See [`08-plpgsql.md`](./08-plpgsql.md) gotcha #9.
10. **`old_snapshot_threshold` is gone in PG17+.** Code or documentation that recommends setting it to fight bloat from long-running transactions is obsolete. The right answer is timeouts and slot hygiene.[^pg17-ost]
11. **MultiXact wraparound is a separate ceiling from XID wraparound.** A foreign-key-heavy workload may hit MultiXact freeze pressure before XID freeze pressure; monitor both `pg_database.datfrozenxid` *and* `pg_database.datminmxid` via `age()`. See [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).
12. **`pg_visible_in_snapshot` does not consult CLOG.** It tells you whether the XID was outside the snapshot's active-set when the snapshot was taken, not whether it's currently committed. To check commit status, use `pg_xact_status(xid8)`.[^functions-info]
13. **Read Committed can see "phantom" inserts mid-statement.** A `SELECT ... FROM big_table` running for 30 seconds sees rows committed up to the statement's start; new inserts committed during the scan are invisible. But a *subsequent* statement in the same transaction will see them, because Read Committed takes a fresh snapshot per statement. See [`42-isolation-levels.md`](./42-isolation-levels.md).
14. **The visibility map is conservative.** A bit being unset does not mean the page has invisible rows — it might just mean VACUUM has not yet processed the page. Index-only scans will fall back to heap fetches; this is *correct*, not a bug.[^vm]
15. **DDL is mostly not MVCC-safe.** `TRUNCATE` and the table-rewriting `ALTER TABLE` forms (e.g., `ALTER COLUMN ... TYPE`) commit instantly visible — concurrent transactions using older snapshots see an empty table or fail. The verbatim docs caveat: *"after the truncation or rewrite commits, the table will appear empty to concurrent transactions, if they are using a snapshot taken before the DDL command committed."*[^mvcc-caveats] See [`01-syntax-ddl.md`](./01-syntax-ddl.md) and [`41-transactions.md`](./41-transactions.md).
16. **`xmin` overflow at 4 billion is real.** Without freezing, after 2^31 transactions, the modular comparison fails and tuples that should be "old" appear "in the future" — silent corruption. This is what anti-wraparound autovacuum prevents. See [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).
17. **`pg_stat_activity.backend_xid` is null when the backend has not written.** Read-only transactions don't get a top-level XID assigned until they perform a write. Their `backend_xmin` is still meaningful for the horizon, but `backend_xid` will be null. Do not exclude null `backend_xid` rows from horizon diagnostics.
18. **A snapshot taken inside `pg_dump` will hold the horizon back for the duration of the dump.** Long dumps on hot clusters cause real bloat. Use `pg_dump --jobs` (parallel) or `pg_basebackup` for very large clusters. See [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) and [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).
19. **`SELECT pg_current_xact_id()` *assigns* an XID.** If you only want to check whether the transaction already has one, use `pg_current_xact_id_if_assigned()`.[^functions-info] Calling `pg_current_xact_id()` in a read-only transaction converts it into a writing transaction for XID-allocation purposes.
20. **TOAST tuples have their own MVCC.** A TOASTed value lives in `pg_toast.pg_toast_<oid>` and has its own `xmin`/`xmax` on the toast chunks. When you DELETE a row, the main heap tuple's `xmax` is set, but the toast chunks become reclaimable independently. See [`31-toast.md`](./31-toast.md).
21. **The xmin horizon can be held back by an unrelated database in the cluster.** XID wraparound is cluster-wide. A long-running transaction in `db1` holds the horizon back for `db2`'s tables too — every autovacuum on every table in the cluster.
22. **`HEAP_HOT_UPDATED` on the old tuple does not mean the row is logically deleted; it means it was replaced via HOT.** The old tuple is still visible to snapshots from before the UPDATE. See [`30-hot-updates.md`](./30-hot-updates.md).

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM mechanics, autovacuum scheduling, parallel vacuum, IO throttling
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — 32-bit XID counter, freeze process, wraparound prevention
- [`30-hot-updates.md`](./30-hot-updates.md) — Heap-Only Tuple optimization, HOT chains, fillfactor
- [`31-toast.md`](./31-toast.md) — Oversized-attribute storage and its independent MVCC
- [`41-transactions.md`](./41-transactions.md) — BEGIN/COMMIT/ROLLBACK, savepoints, subtransaction cost, 2PC
- [`42-isolation-levels.md`](./42-isolation-levels.md) — Read Committed / Repeatable Read / Serializable snapshot semantics
- [`43-locking.md`](./43-locking.md) — Lock-conflict matrix and the lock side of MVCC
- [`56-explain.md`](./56-explain.md) — Reading `Heap Fetches` to detect VM-not-set pages
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity`, `backend_xmin`, wait events
- [`75-replication-slots.md`](./75-replication-slots.md) — Slots that pin xmin
- [`77-standby-failover.md`](./77-standby-failover.md) — `hot_standby_feedback` propagating xmin
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `data_checksums`, `pg_amcheck`
- [`89-pg-rewind.md`](./89-pg-rewind.md) — WAL logging of hint-bit updates and its interaction with diverged timelines.
- [`08-plpgsql.md`](./08-plpgsql.md) — subtransaction overflow from `EXCEPTION` blocks in tight loops (gotcha #9).
- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — `WITH HOLD` cursors as xmin-horizon holders.

## Sources

[^mvcc-intro]: https://www.postgresql.org/docs/16/mvcc-intro.html — *"Internally, data consistency is maintained by using a multiversion model (Multiversion Concurrency Control, MVCC). This means that each SQL statement sees a snapshot of data (a database version) as it was some time ago, regardless of the current state of the underlying data."*

[^page-layout]: https://www.postgresql.org/docs/16/storage-page-layout.html — *"All table rows are structured in the same way. There is a fixed-size header (occupying 23 bytes on most machines), followed by an optional null bitmap, an optional object ID field, and the user data."* and *"All the details can be found in `src/include/access/htup_details.h`."*

[^htup-details-h]: https://github.com/postgres/postgres/blob/master/src/include/access/htup_details.h — canonical authority for `HEAP_XMIN_COMMITTED`, `HEAP_XMIN_INVALID`, `HEAP_XMIN_FROZEN`, `HEAP_XMAX_COMMITTED`, `HEAP_XMAX_INVALID`, `HEAP_XMAX_IS_MULTI`, `HEAP_XMAX_LOCK_ONLY`, `HEAP_HOT_UPDATED`, `HEAP_ONLY_TUPLE`, and all infomask/infomask2 constants.

[^current-snapshot]: https://www.postgresql.org/docs/16/functions-info.html — *"Returns a current snapshot, a data structure showing which transaction IDs are now in-progress. Only top-level transaction IDs are included in the snapshot; subtransaction IDs are not shown."* (description of `pg_current_snapshot()`).

[^iso]: https://www.postgresql.org/docs/16/transaction-iso.html — Read Committed: *"a SELECT query (without a FOR UPDATE/SHARE clause) sees only data committed before the query began."* Repeatable Read: *"The Repeatable Read isolation level only sees data committed before the transaction began."* Serializable: *"The Serializable isolation level provides the strictest transaction isolation. This level emulates serial transaction execution for all committed transactions."*

[^functions-info]: https://www.postgresql.org/docs/16/functions-info.html — `pg_current_xact_id()`, `pg_current_xact_id_if_assigned()`, `pg_xact_status(xid8)`, `pg_current_snapshot()`, `pg_snapshot_xmin/xmax/xip()`, `pg_visible_in_snapshot(xid8, pg_snapshot)`. Verbatim on the latter: *"Is the given transaction ID visible according to this snapshot (that is, was it completed before the snapshot was taken)? Note that this function will not give the correct answer for a subtransaction ID (subxid)."*

[^monitoring]: https://www.postgresql.org/docs/16/monitoring-stats.html — `pg_stat_activity.backend_xid`: *"Top-level transaction identifier of this backend, if any; see Section 74.1."* `pg_stat_activity.backend_xmin`: *"The current backend's xmin horizon."*

[^routine-vacuuming]: https://www.postgresql.org/docs/16/routine-vacuuming.html — *"PostgreSQL reserves a special XID, FrozenTransactionId, which does not follow the normal XID comparison rules and is always considered older than every normal XID."* and *"Normal XIDs are compared using modulo-2³² arithmetic. This means that for every normal XID, there are two billion XIDs that are 'older' and two billion that are 'newer' ... To avoid this, it is necessary to vacuum every table in every database at least once every two billion transactions."* Also the MultiXact paragraph: *"Multixact IDs are used to support row locking by multiple transactions. Since there is only limited space in a tuple header to store lock information, that information is encoded as a 'multiple transaction ID', or multixact ID for short, whenever there is more than one transaction concurrently locking a row."*

[^mvcc-caveats]: https://www.postgresql.org/docs/16/mvcc-caveats.html — *"Some DDL commands, currently only TRUNCATE and the table-rewriting forms of ALTER TABLE, are not MVCC-safe. This means that after the truncation or rewrite commits, the table will appear empty to concurrent transactions, if they are using a snapshot taken before the DDL command committed."*

[^vm]: https://www.postgresql.org/docs/16/storage-vm.html — *"Each heap relation has a Visibility Map (VM) to keep track of which pages contain only tuples that are known to be visible to all active transactions; it also keeps track of which pages contain only frozen tuples."* and *"The first bit, if set, indicates that the page is all-visible, or in other words that the page does not contain any tuples that need to be vacuumed. This information can also be used by index-only scans to answer queries using only the index tuple."* and *"The second bit, if set, means that all tuples on the page have been frozen."* and *"The map is conservative in the sense that we make sure that whenever a bit is set, we know the condition is true, but if a bit is not set, it might or might not be true."*

[^pageinspect-htif]: https://www.postgresql.org/docs/16/pageinspect.html — `heap_tuple_infomask_flags(t_infomask integer, t_infomask2 integer)` decoder function returning a `flags` text[] and `combined_flags` text[].

[^pg14-snapshot]: https://www.postgresql.org/docs/release/14.0/ — *"Improve the speed of computing MVCC visibility snapshots on systems with many CPUs and high session counts (Andres Freund). This also improves performance when there are many idle sessions."*

[^pg14-failsafe]: https://www.postgresql.org/docs/release/14.0/ — *"Cause vacuum operations to be more aggressive if the table is near xid or multixact wraparound (Masahiko Sawada, Peter Geoghegan). This is controlled by vacuum_failsafe_age and vacuum_multixact_failsafe_age."*

[^pg14-wrap-warn]: https://www.postgresql.org/docs/release/14.0/ — *"Increase warning time and hard limit before transaction id and multi-transaction wraparound (Noah Misch)."*

[^pg15-aggressive]: https://www.postgresql.org/docs/release/15.0/ — *"Allow vacuum to be more aggressive in setting the oldest frozen and multi transaction id."*

[^pg16-freeze]: https://www.postgresql.org/docs/release/16.0/ — *"Improve performance of vacuum freezing (Peter Geoghegan)."* and *"During non-freeze operations, perform page freezing where appropriate (Peter Geoghegan). This makes full-table freeze vacuums less necessary."*

[^pg16-skipstats]: https://www.postgresql.org/docs/release/16.0/ — *"Add VACUUM options to skip or update all frozen statistics (Tom Lane, Nathan Bossart)"* (`SKIP_DATABASE_STATS`, `ONLY_DATABASE_STATS`).

[^pg17-ost]: https://www.postgresql.org/docs/release/17.0/ — *"Remove server variable old_snapshot_threshold (Thomas Munro). This variable allowed vacuum to remove rows that potentially could be still visible to running transactions, causing 'snapshot too old' errors later if accessed."*

[^pg17-vac-mem]: https://www.postgresql.org/docs/release/17.0/ — *"New memory management system for VACUUM, which reduces memory consumption and can improve overall vacuuming performance."* and *"Additionally, vacuum is no longer silently limited to one gigabyte of memory when maintenance_work_mem or autovacuum_work_mem are higher."*

[^pg17-pgsv]: https://www.postgresql.org/docs/release/17.0/ — column renames in `pg_stat_progress_vacuum`: `max_dead_tuples → max_dead_tuple_bytes`, `num_dead_tuples → num_dead_item_ids`; new column `dead_tuple_bytes`.

[^pg18-eager-freeze]: https://www.postgresql.org/docs/release/18.0/ — *"Allow normal vacuums to freeze some pages, even though they are all-visible (Melanie Plageman)."* New GUC `vacuum_max_eager_freeze_failure_rate`; new column `pg_class.relallfrozen`; enhanced `pg_stat_progress_vacuum` reporting.

[^pg18-checksums]: https://www.postgresql.org/docs/release/18.0/ — data checksums are enabled by default for new clusters created with `initdb` in PG18.

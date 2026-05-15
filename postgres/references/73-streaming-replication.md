# Physical Streaming Replication

> [!WARNING] PG12 watershed
> `recovery.conf` removed in PG12. Server refuses to start if file exists. Standby identity now via `standby.signal` (presence file in `$PGDATA`) + standby GUCs in `postgresql.conf`. Configurations carried forward from PG≤11 fail at startup. Verbatim PG12 release-note: *"`recovery.conf` is no longer used, and the server will not start if that file exists. `recovery.signal` and `standby.signal` files are now used to switch into non-primary mode. The `trigger_file` setting has been renamed to `promote_trigger_file`. The `standby_mode` setting has been removed."*[^pg12-recoveryconf]

> [!WARNING] PG16 watershed
> `promote_trigger_file` GUC removed. Use `pg_ctl promote` or `pg_promote()` instead.[^pg16-promote-trigger-removed]

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — Five Rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Setup Topology](#setup-topology)
    - [Standby Identity Files (PG12+)](#standby-identity-files-pg12)
    - [`primary_conninfo` and `primary_slot_name`](#primary_conninfo-and-primary_slot_name)
    - [`wal_level` Required Settings](#wal_level-required-settings)
    - [`hot_standby` (Read Queries on Standby)](#hot_standby-read-queries-on-standby)
    - [`hot_standby_feedback` (Block Primary Vacuum)](#hot_standby_feedback-block-primary-vacuum)
    - [`synchronous_commit` Durability Dial](#synchronous_commit-durability-dial)
    - [`synchronous_standby_names` (Quorum vs Priority)](#synchronous_standby_names-quorum-vs-priority)
    - [`max_standby_archive_delay` / `max_standby_streaming_delay`](#max_standby_archive_delay--max_standby_streaming_delay)
    - [Recovery Target GUCs](#recovery-target-guc s)
    - [Cascading Replication](#cascading-replication)
    - [Promotion (`pg_promote()`)](#promotion-pg_promote)
    - [`pg_stat_replication` View](#pg_stat_replication-view)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Pick this file for: setting up physical streaming replication primary+standby, choosing `synchronous_commit` level, picking `synchronous_standby_names` quorum vs priority mode, deciding `hot_standby_feedback` on/off, sizing `max_standby_*_delay`, planning controlled switchover, recovering from query-cancel cascades on standby, monitoring lag via `pg_stat_replication`.

NOT this file for: logical replication (→ [`74-logical-replication.md`](./74-logical-replication.md)), replication slot mechanics deep dive (→ [`75-replication-slots.md`](./75-replication-slots.md)), failover orchestration via Patroni/repmgr (→ [`77-standby-failover.md`](./77-standby-failover.md), [`78-ha-architectures.md`](./78-ha-architectures.md), [`79-patroni.md`](./79-patroni.md)), `pg_rewind` for diverged former primaries (→ [`89-pg-rewind.md`](./89-pg-rewind.md)), backup/PITR (→ [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md)).

## Mental Model — Five Rules

1. **Physical streaming = byte-for-byte WAL ship.** Standby applies primary's WAL records. Same binary. Standby identical to primary at byte level. Cannot replicate selectively (no per-table, no row filter — that's logical replication).

2. **Standby identity = `standby.signal` file + `primary_conninfo` GUC since PG12.** Before PG12: `recovery.conf`. After PG12: empty `standby.signal` file in `$PGDATA` + `postgresql.conf` (or `postgresql.auto.conf`) with `primary_conninfo='host=primary port=5432 user=replicator ...'`. Server refuses startup if `recovery.conf` exists.[^pg12-recoveryconf]

3. **`synchronous_commit` is per-transaction durability dial.** Five levels: `off` / `local` / `remote_write` / `on` (default) / `remote_apply`. Orthogonal to `synchronous_standby_names` — names list says *which* standbys count; level says *how far* WAL must travel before COMMIT returns.

4. **`synchronous_standby_names` has three syntaxes.** Simple list (priority, first N), `FIRST N (s1,s2,s3)` (priority — first N must ack), `ANY N (s1,s2,s3)` (quorum — any N must ack). Empty string = async.

5. **`hot_standby_feedback = on` is bidirectional trade-off.** Standby tells primary its xmin horizon. Primary delays vacuum to keep tuples visible to standby. Long-running standby query → primary table bloat. Off → standby query cancelled when primary vacuums tuples it still needs.

## Decision Matrix

| Need | Use | Default | Production value | Avoid |
|---|---|---|---|---|
| Standby identity | `standby.signal` file (PG12+) | none | `touch $PGDATA/standby.signal` | `recovery.conf` (removed PG12) |
| Connect to primary | `primary_conninfo` GUC | empty | full libpq conninfo with replication user | hard-coded credentials in postgresql.conf (use service file) |
| Bound primary WAL retention | `primary_slot_name` + `max_slot_wal_keep_size` | none / `-1` | named slot + `max_slot_wal_keep_size = 64GB` | unbounded slot — primary disk fills |
| Block standby query cancel due to vacuum | `hot_standby_feedback = on` | `off` | `on` for query-heavy standbys | leaving on with abandoned standby — primary bloats |
| Allow standby reads | `hot_standby = on` | `on` | `on` | `off` only for hot-replay-only standby |
| Sync replication, single standby must ack | `synchronous_standby_names = 'standby1'` + `synchronous_commit = on` | empty / `on` | named standby + `on` | `remote_apply` for OLTP (latency punishment) |
| Sync replication, quorum (any N of M) | `ANY 2 (s1,s2,s3)` | n/a | quorum mode for HA across AZs | priority mode when AZ failure shouldn't block COMMIT |
| Per-transaction async commit | `SET LOCAL synchronous_commit = off` | n/a | high-volume ingest in known-loseable transactions | cluster-wide `off` on transactional workload |
| Cascading replication | standby with `max_wal_senders > 0` + downstream `primary_conninfo` pointing at it | n/a | for geographic distribution | when primary can serve all standbys directly |
| Long-running standby reports without primary bloat | `hot_standby_feedback = off` + raise `max_standby_streaming_delay` | `30s` | `5min` for reporting standbys | infinite (`-1`) on transactional standby — query cancels appear at random |
| Apply WAL with delay (PITR safety net) | `recovery_min_apply_delay = '1h'` | `0` | `1h` for human-error rollback window | high values without monitoring slot lag |
| Promote standby | `pg_promote()` (PG12+) | n/a | `SELECT pg_promote(true, 60)` | `pg_ctl promote` from cron — race conditions |

Three smell signals:

- **`pg_stat_replication.replay_lag` always NULL** → standby idle, nothing to compare. Send dummy WAL via heartbeat-insert on primary. Not a bug.
- **`pg_stat_replication.state = 'catchup'` for hours** → standby behind. Slot retention working but standby can't keep up. Check standby disk I/O, `max_wal_senders`, network.
- **Standby queries silently cancelled with `ERROR: canceling statement due to conflict with recovery`** → `max_standby_*_delay` too low for workload, `hot_standby_feedback = off`. Pick one mitigation.

## Mechanics

### Setup Topology

Physical streaming replication = one primary + N standbys. Standby connects to primary as replication user, walreceiver process consumes WAL, startup process applies. Primary may also archive WAL (decoupled from streaming). Standbys may cascade.

```
                   ┌──────────────────┐
                   │   Primary (rw)   │
                   │                  │
                   │ walsender ──────►│ standby1 (read-only)
                   │ walsender ──────►│ standby2 (read-only)
                   │                  │   │
                   │ archiver ──► WAL │   ▼
                   │   archive  store │ walsender ──► standby3 (cascading)
                   └──────────────────┘
```

Primary needs:
- `wal_level = replica` (or `logical`)
- `max_wal_senders >= N + slack`
- `max_replication_slots >= N`
- replication-user role (`CREATE ROLE rep REPLICATION LOGIN PASSWORD 'x'`)
- `pg_hba.conf` rule allowing replication connections

Standby needs:
- base backup from primary (`pg_basebackup -R` writes both `standby.signal` and `primary_conninfo`)
- `standby.signal` file in `$PGDATA`
- `primary_conninfo` GUC pointing at primary
- optional: `primary_slot_name` for bounded WAL retention

### Standby Identity Files (PG12+)

Two presence files (empty content; their existence triggers behavior):

| File | Effect | Used when |
|---|---|---|
| `standby.signal` | Server starts in standby mode. Streams + applies WAL forever. Promotion ends standby mode. | Long-running replicas |
| `recovery.signal` | Server starts in recovery mode. Applies WAL until `recovery_target_*` reached, then promotes. | Point-in-time recovery |

Verbatim from `recovery-config.html`: *"In releases prior to PostgreSQL 12, recovery configuration was specified in a separate `recovery.conf` file."*[^recovery-config]

Both files: empty content. PostgreSQL checks for existence at startup. Removing `standby.signal` mid-life requires restart (file is read at startup, not periodically).

`pg_basebackup -R` writes `standby.signal` automatically, plus appends `primary_conninfo` to `postgresql.auto.conf`.

### `primary_conninfo` and `primary_slot_name`

`primary_conninfo` (sighup-context, since PG12 was here) = libpq conninfo string. Standby's walreceiver uses it to connect.

```ini
# postgresql.auto.conf (or postgresql.conf)
primary_conninfo = 'host=primary.example.com port=5432 user=replicator
                    sslmode=verify-full sslrootcert=/etc/postgres/ca.crt
                    application_name=standby1 channel_binding=require
                    options=''-c statement_timeout=0'''
primary_slot_name = 'standby1_slot'
```

Three operational rules:

1. **`application_name`** in `primary_conninfo` is what shows up in `pg_stat_replication.application_name` AND what `synchronous_standby_names` matches against. Pick stable names.

2. **Use libpq service file** (`~/.pg_service.conf`) or `PGSERVICE` to avoid embedding password literally. Cross-reference [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md).

3. **`primary_slot_name`** ties standby to a named replication slot on primary. Without it, primary may recycle WAL standby still needs (controlled by `wal_keep_size` on primary). With it, slot retains WAL until standby acknowledges — but unbounded retention if standby stalls. Cap with `max_slot_wal_keep_size`. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).

### `wal_level` Required Settings

`wal_level` (postmaster-context — restart required) controls WAL detail:

| Value | What's logged | Streaming replication? | Logical replication? |
|---|---|---|---|
| `minimal` | Just enough for crash recovery | NO (standby cannot attach) | NO |
| `replica` (default) | Enough for streaming + base backup | YES | NO |
| `logical` | Replica + per-row info for logical decoding | YES | YES |

Pick `replica` for physical streaming. Pick `logical` if planning to also run logical replication / CDC. Logical implies replica.

### `hot_standby` (Read Queries on Standby)

`hot_standby = on` (default since PG10) on standby = allow read-only queries during recovery. `off` = standby is replay-only, no client queries.

Standby restrictions (verbatim from `hot-standby.html`):
- No INSERT/UPDATE/DELETE/MERGE
- No DDL
- No `SERIALIZABLE` isolation (verbatim *"Serializable transactions are not allowed on hot standby servers"*)[^hot-standby]
- `pg_replication_origin_*` functions disabled
- LISTEN/NOTIFY disabled
- Temp tables: only via `pg_temp` namespace allowed since PG14

### `hot_standby_feedback` (Block Primary Vacuum)

`hot_standby_feedback = on` (sighup-context) makes standby's walreceiver send its xmin horizon back to primary. Primary delays autovacuum from removing tuples standby still references.

Trade-off:

| Direction | If `on` | If `off` (default) |
|---|---|---|
| Standby query | Will not be cancelled by recovery conflict on vacuum-removed tuples | Cancelled with `ERROR: canceling statement due to conflict with recovery` after `max_standby_streaming_delay` |
| Primary | Autovacuum delayed → table bloat grows | Autovacuum runs unrestricted |
| Failure mode | Abandoned/stuck standby keeps primary's xmin horizon back forever → unbounded bloat | Random query cancels on standby under heavy primary write load |

Recommendation: `on` for reporting/analytics standbys (queries are long-running, bloat acceptable). `off` for HA-only standbys (short queries, prefer cancellation over primary bloat).

### `synchronous_commit` Durability Dial

`synchronous_commit` (user-context — set per session, transaction, or cluster) controls how far WAL must travel before COMMIT returns success.

| Value | Where data is when COMMIT returns | Latency | Durability |
|---|---|---|---|
| `off` | In primary's WAL buffer (asynchronous flush) | Lowest | Loss window: up to `wal_writer_delay × 3` (~600ms default). Crash-safe but recent commits may vanish. NOT corruption — bounded loss. |
| `local` | Flushed to primary's local disk (fsync) | Low | Survives primary crash. Does NOT wait for any standby. |
| `remote_write` | Primary's disk + standby has received WAL into memory | Medium | Survives primary crash if at least one sync standby alive. NOT durable on standby's disk. |
| `on` (default) | Primary's disk + standby's disk (flushed) | Higher | Survives both primary and standby crash. |
| `remote_apply` | Primary's disk + standby's disk + standby has REPLAYED the WAL | Highest | Reads on standby see this commit immediately. Required for read-after-write on standby. |

Per-transaction override:

```sql
BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO event_log (payload) SELECT payload FROM staging;
COMMIT;
```

Cluster-wide via `ALTER SYSTEM` or `postgresql.conf`. Per-role via `ALTER ROLE webapp SET synchronous_commit = on;`. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md).

`local` is useful when you have synchronous standbys configured but a specific batch transaction can tolerate primary-only durability — bypasses sync wait without compromising primary fsync.

### `synchronous_standby_names` (Quorum vs Priority)

`synchronous_standby_names` (sighup-context) = list of standbys that must ack before sync `synchronous_commit` levels return.

Three syntaxes:

```ini
# Empty string (default) — async, no standby is sync
synchronous_standby_names = ''

# Simple list = priority mode, FIRST 1 implicit
synchronous_standby_names = 'standby1, standby2, standby3'

# Priority mode explicit — first N from list must ack
synchronous_standby_names = 'FIRST 2 (standby1, standby2, standby3)'

# Quorum mode — ANY N of the listed must ack
synchronous_standby_names = 'ANY 2 (standby1, standby2, standby3)'

# Wildcard — any standby with matching application_name
synchronous_standby_names = 'ANY 1 (*)'
```

| Mode | Semantics | When to use |
|---|---|---|
| Empty string | Async — no standby blocks COMMIT | Best throughput, no commit-time HA guarantee |
| Simple list / `FIRST N` | Priority — must hear from first N in order. Falls through list if a higher-priority standby disconnects. | Hierarchy with preferred sync (e.g., same-AZ over remote-AZ) |
| `ANY N` | Quorum — any N of M acks suffice. Tolerates failure of (M − N) standbys. | Multi-AZ HA where any AZ failure should not block COMMIT |

Names matched against `pg_stat_replication.application_name`. `application_name` set via `primary_conninfo`'s `application_name=...` parameter.

Operational rules:

- Sync standby that disconnects → COMMIT blocks until either (a) standby reconnects, (b) timeout via `wal_sender_timeout`, (c) operator removes it from list and reloads. **No automatic fallback to async** — explicit policy.
- `pg_stat_replication.sync_state` shows current status: `async` / `potential` (in list but not currently sync) / `sync` (currently sync) / `quorum` (member of quorum group).

### `max_standby_archive_delay` / `max_standby_streaming_delay`

When standby's WAL apply needs to remove tuples a running standby query references, conflict resolution:

| GUC | Default | Applies to |
|---|---|---|
| `max_standby_archive_delay` | `30s` | WAL replayed from archive (restore_command) |
| `max_standby_streaming_delay` | `30s` | WAL replayed from streaming connection |

Three behaviors:

- **`-1`** = wait forever. Standby query never cancelled. WAL apply blocks indefinitely. Lag accumulates.
- **`0`** = no delay. Cancel queries immediately on conflict. Maximum apply throughput.
- **positive value** = wait this long, then cancel.

Combine with `hot_standby_feedback`: feedback prevents the conflict from arising; `max_standby_*_delay` controls behavior when conflict already arose.

### Recovery Target GUCs

When `recovery.signal` present (point-in-time recovery, NOT regular standby), recovery target controls when to stop replay and promote.

| GUC | Format | Effect |
|---|---|---|
| `recovery_target` | `'immediate'` | Stop at first consistent point after base backup |
| `recovery_target_time` | timestamp | Stop at first commit after this time |
| `recovery_target_xid` | XID | Stop at this transaction |
| `recovery_target_lsn` | LSN | Stop at this WAL position |
| `recovery_target_name` | string | Stop at named restore point (set via `pg_create_restore_point()` on primary before crash) |
| `recovery_target_timeline` | `'latest'` (PG12+ default), `'current'`, or specific TLI | Which timeline to follow |
| `recovery_target_action` | `pause` (default) / `promote` / `shutdown` | What to do at target |
| `recovery_target_inclusive` | `true` (default) / `false` | Include target xact in replay or stop just before |

Verbatim PG12: *"Cause recovery to advance to the latest timeline by default ... `recovery_target_timeline` now defaults to `latest`. Previously, it defaulted to `current`."*[^pg12-target-latest]

Verbatim PG12: *"Do not allow multiple conflicting `recovery_target*` specifications ... only allow one of `recovery_target`, `recovery_target_lsn`, `recovery_target_name`, `recovery_target_time`, and `recovery_target_xid`."*[^pg12-target-conflict]

Cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) for full PITR walkthrough.

### Cascading Replication

Standby may serve as upstream for downstream standby. Reduces load on primary, useful for geographic distribution.

Setup:
- Cascading source standby needs `max_wal_senders > 0` (already required for any standby that receives traffic).
- Downstream standby's `primary_conninfo` points at cascading-source standby instead of original primary.
- Downstream sees same WAL stream eventually. Promotion of cascading source promotes downstream's source — but downstream itself needs its own promotion to become a primary.

Constraints:
- Cascading source must have `wal_level >= replica`.
- Synchronous replication only via direct standby of primary — cascaded standbys are always async with respect to primary's COMMIT.

### Promotion (`pg_promote()`)

`pg_promote(wait boolean DEFAULT true, wait_seconds integer DEFAULT 60)` (PG12+) ends recovery, promotes to primary.[^pg12-promote]

```sql
SELECT pg_promote(true, 60);  -- wait up to 60s for promotion to complete
```

Returns `true` if promoted, `false` if timeout. Standby becomes primary, can accept writes. New timeline ID created.

Pre-PG12 alternatives (still work):
- `pg_ctl promote -D $PGDATA`
- Touch `promote_trigger_file` (REMOVED in PG16)[^pg16-promote-trigger-removed]

Recovery-pause alternative:

```sql
SELECT pg_wal_replay_pause();    -- pause apply (does not promote)
SELECT pg_get_wal_replay_pause_state();  -- 'not paused' / 'pause requested' / 'paused' (PG14+)
SELECT pg_wal_replay_resume();   -- resume apply
```

Verbatim PG14: *"Add function `pg_get_wal_replay_pause_state()` to report the recovery state ... It gives more detailed information than `pg_is_wal_replay_paused()`, which still exists."*[^pg14-replay-pause-state]

After promotion: timeline file (`<timeline>.history`) records the divergence. Old primary becomes diverged — re-attaching requires `pg_rewind` or fresh `pg_basebackup`. Cross-reference [`89-pg-rewind.md`](./89-pg-rewind.md).

### `pg_stat_replication` View

Run on primary to inspect downstream standbys.

| Column | Meaning |
|---|---|
| `pid` | Primary-side walsender backend PID |
| `usesysid`, `usename` | Replication role on primary |
| `application_name` | Standby's identifier (matched by `synchronous_standby_names`) |
| `client_addr`, `client_hostname`, `client_port` | Network endpoint of standby |
| `backend_start` | When walsender started |
| `backend_xmin` | Standby's xmin horizon (NULL if `hot_standby_feedback=off`) |
| `state` | `startup` / `catchup` / `streaming` / `backup` / `stopping` |
| `sent_lsn` | WAL position last sent |
| `write_lsn` | WAL position standby has written to OS |
| `flush_lsn` | WAL position standby has flushed to disk |
| `replay_lsn` | WAL position standby has applied |
| `write_lag` / `flush_lag` / `replay_lag` | Time interval — primary's commit timestamp to standby's stage |
| `sync_priority` | Position in priority list (0 = async, otherwise from `synchronous_standby_names`) |
| `sync_state` | `async` / `potential` / `sync` / `quorum` |
| `reply_time` | Last time standby replied |

Lag interpretation: `pg_wal_lsn_diff(primary_lsn, standby_replay_lsn)` returns bytes. `replay_lag` returns `interval` — but only meaningful when standby is actively replaying. Idle standby: `replay_lag` is NULL despite `sent_lsn = replay_lsn`.

### Per-Version Timeline

| Version | Streaming-replication changes |
|---|---|
| **PG12** | `recovery.conf` removed; `standby.signal` / `recovery.signal` model; `recovery_target_timeline` default `latest`; `pg_promote()`; `wal_sender_timeout` per-connection; `pg_copy_physical_replication_slot()` / `pg_copy_logical_replication_slot()`; `max_wal_senders` no longer counts against `max_connections`. All verbatim quotes captured in mechanics sections.[^pg12-recoveryconf][^pg12-target-latest][^pg12-promote] |
| **PG13** | `max_slot_wal_keep_size` (cap WAL retained by stuck slot). Cross-reference [`75-replication-slots.md`](./75-replication-slots.md). |
| **PG14** | `restore_command` reloadable on SIGHUP; `log_recovery_conflict_waits` GUC; `pg_get_wal_replay_pause_state()` returns three states; `in_hot_standby` server parameter; `recovery_init_sync_method=syncfs` (Linux); `pg_xact_commit_timestamp_origin()`; `pg_stat_replication_slots` view; `WalReceiverExit` wait event. Verbatim release-note quotes captured in mechanics.[^pg14-restore-command-reload][^pg14-conflict-waits][^pg14-replay-pause-state][^pg14-in-hot-standby][^pg14-syncfs][^pg14-stat-repl-slots] |
| **PG15** | LZ4 + Zstandard server-side base-backup compression; checkpointer + bgwriter run during crash recovery; `recovery_prefetch` GUC; `archive_library` GUC (alternative to `archive_command`); `IDENTIFY_SYSTEM` no longer required before `START_REPLICATION`. Verbatim quotes captured.[^pg15-basebackup-lz4][^pg15-checkpointer-recovery][^pg15-recovery-prefetch][^pg15-archive-library][^pg15-no-identify-system] |
| **PG16** | `promote_trigger_file` removed (use `pg_promote()`); `vacuum_defer_cleanup_age` removed (use `hot_standby_feedback` + slots); logical decoding allowed on standbys (cross-reference [`76-logical-decoding.md`](./76-logical-decoding.md)). Verbatim quotes captured.[^pg16-promote-trigger-removed][^pg16-vacuum-defer-removed][^pg16-logical-on-standby] |
| **PG17** | `pg_basebackup --incremental` + `pg_combinebackup` (cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md)); WAL summarization via `summarize_wal` + `wal_summary_keep_time`; `pg_replication_slots.invalidation_reason` + `inactive_since` columns; `pg_sync_replication_slots()` for failover slot sync; `sync_replication_slots` GUC (standby side); `synchronized_standby_slots` GUC (primary side, names physical standbys that must catch up before logical subscribers see the WAL); `pg_createsubscriber` tool to create logical replica from physical standby; system identifier in backup manifest; `dbname` in `pg_basebackup -R` output. Verbatim quotes captured.[^pg17-incremental][^pg17-summarize-wal][^pg17-slot-cols][^pg17-sync-slots-fn][^pg17-sync-replication-slots][^pg17-synchronized-standby-slots][^pg17-pgcreatesubscriber][^pg17-basebackup-dbname] |
| **PG18** | `idle_replication_slot_timeout` (auto-invalidate inactive slots); `max_active_replication_origins` (separates origin count from `max_replication_slots`); `pg_recvlogical --enable-failover` + `--enable-two-phase` synonym. Verbatim quotes captured.[^pg18-idle-slot-timeout][^pg18-max-active-origins][^pg18-pgrecvlogical-failover] |

## Examples / Recipes

### Recipe 1 — Baseline production primary + standby

Primary `postgresql.conf`:

```ini
# WAL + replication
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
wal_keep_size = 0           # rely on slots, not wal_keep_size
max_slot_wal_keep_size = 64GB

# Synchronous (one named standby must ack)
synchronous_standby_names = 'standby1'
synchronous_commit = on

# Crash safety
fsync = on
full_page_writes = on

# Archive (independent of streaming)
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'

# Logging
log_replication_commands = on
```

Primary `pg_hba.conf`:

```
# TYPE  DATABASE      USER          ADDRESS          METHOD
hostssl replication   replicator    10.0.0.0/8       scram-sha-256
host    all           all           0.0.0.0/0        reject
```

Replication user on primary:

```sql
CREATE ROLE replicator REPLICATION LOGIN PASSWORD '<scram-hash>';
SELECT pg_create_physical_replication_slot('standby1_slot');
```

Standby setup (run on standby host with empty `$PGDATA`):

```bash
sudo -u postgres pg_basebackup \
    -h primary.example.com -p 5432 -U replicator \
    -D $PGDATA -X stream -P -R -S standby1_slot

# pg_basebackup -R wrote standby.signal + appended primary_conninfo to postgresql.auto.conf
```

Standby `postgresql.conf` additions:

```ini
hot_standby = on
hot_standby_feedback = off       # HA standby — prefer query cancel over primary bloat
max_standby_streaming_delay = 30s
max_standby_archive_delay = 30s

# application_name set via primary_conninfo (in postgresql.auto.conf)
# Match against synchronous_standby_names = 'standby1'
```

Verify on primary:

```sql
SELECT application_name, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) AS lag_bytes,
       replay_lag
FROM pg_stat_replication;
```

### Recipe 2 — Quorum sync across three AZs

Primary in AZ-A, two standbys (`standby_az_b`, `standby_az_c`) in AZ-B and AZ-C. Want any 1 of 2 to ack — survive single-AZ failure without blocking COMMITs.

```ini
synchronous_standby_names = 'ANY 1 (standby_az_b, standby_az_c)'
synchronous_commit = on
```

Each standby's `primary_conninfo` sets `application_name=standby_az_b` (or `_c`).

Verify quorum behavior:

```sql
SELECT application_name, sync_state FROM pg_stat_replication;
-- Expect: both rows show sync_state = 'quorum'
```

Stop one standby, verify primary still accepts writes (the other ack satisfies quorum). Stop both, verify primary blocks (no quorum possible).

### Recipe 3 — Per-role async commit for batch jobs

Cluster default `synchronous_commit = on` (sync standby blocks). Batch ETL role can tolerate primary-only durability for known-resumable jobs.

```sql
ALTER ROLE batch SET synchronous_commit = local;  -- skip sync standby wait
ALTER ROLE webapp SET synchronous_commit = on;    -- explicit (default)
ALTER ROLE reporter SET default_transaction_read_only = on;  -- belt-and-braces
```

Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) for per-role baseline pattern.

### Recipe 4 — Reporting standby with hot_standby_feedback

Long-running analytic queries on standby. Want no random query-cancel errors. Accept primary bloat trade-off.

Standby `postgresql.conf`:

```ini
hot_standby = on
hot_standby_feedback = on
max_standby_streaming_delay = 5min  # belt-and-braces; feedback should prevent the conflict
max_standby_archive_delay = 5min
```

Monitor primary bloat after enabling. If `pg_stat_user_tables.n_dead_tup` grows unbounded on hot tables, standby has stuck transaction. Diagnose:

```sql
-- Run on primary
SELECT application_name, backend_xmin, age(backend_xmin) AS xmin_age
FROM pg_stat_replication
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC;
```

If `xmin_age` grows continuously, standby has long-running transaction. Either kill it on standby or accept bloat.

Cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) for xmin horizon.

### Recipe 5 — Safe controlled switchover (planned promotion)

Primary becomes secondary, standby becomes primary. Zero data loss. Manual orchestration (use Patroni/repmgr in production — cross-reference [`78-ha-architectures.md`](./78-ha-architectures.md)).

```bash
# Step 1: On primary — stop application traffic, force checkpoint
psql -h primary -c "CHECKPOINT;"

# Step 2: On primary — stop cleanly (waits for standby to catch up)
sudo systemctl stop postgresql

# Step 3: On standby — verify caught up to old primary's last LSN
psql -h standby -c "SELECT pg_last_wal_replay_lsn();"

# Step 4: On standby — promote
psql -h standby -c "SELECT pg_promote(true, 60);"

# Step 5: Verify standby is now primary
psql -h standby -c "SELECT pg_is_in_recovery();"  -- should be false

# Step 6: Reconfigure old primary as standby of new primary
# Either pg_rewind (if wal_log_hints or data_checksums enabled)
# or fresh pg_basebackup

# Step 7: Update application connection string to point at new primary
```

Cross-reference [`89-pg-rewind.md`](./89-pg-rewind.md) for re-attaching old primary.

### Recipe 6 — `recovery_min_apply_delay` for human-error rollback

Apply WAL with 1-hour delay. Bug-induced data loss can be reverted by promoting standby before delayed WAL applies.

Standby `postgresql.conf`:

```ini
recovery_min_apply_delay = 1h
```

Standby still receives WAL immediately (network) but applies it 1 hour late. If primary corrupts data at 10:00, you have until 11:00 to promote standby and stop replay.

Trade-offs:
- Standby data is always 1 hour stale.
- WAL accumulates on standby disk (1 hour worth).
- During the delay window, RPO is 0 but RTO is "promote + delete remaining WAL" = minutes.
- Slot retention on primary still measures "WAL written" not "WAL applied" — slot does NOT block primary from recycling.

### Recipe 7 — Diagnose stuck `state = 'catchup'`

Standby connected but not caught up. Common when standby was offline for a while.

```sql
-- Run on primary
SELECT application_name, state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn))   AS sent_behind,
       pg_size_pretty(pg_wal_lsn_diff(sent_lsn, write_lsn))               AS write_behind,
       pg_size_pretty(pg_wal_lsn_diff(write_lsn, flush_lsn))              AS flush_behind,
       pg_size_pretty(pg_wal_lsn_diff(flush_lsn, replay_lsn))             AS replay_behind
FROM pg_stat_replication
WHERE state = 'catchup';
```

Bottleneck identification:
- High `sent_behind` → primary CPU-bound or `max_wal_senders` saturated.
- High `write_behind` → standby network or OS write cache slow.
- High `flush_behind` → standby disk fsync slow.
- High `replay_behind` → standby CPU-bound on apply (typically: long transactions on standby blocking apply, or recovery_min_apply_delay set).

### Recipe 8 — Failover slot sync (PG17+)

Logical replication slots normally only exist on primary. After failover, subscribers must rebuild slots from scratch (data loss). PG17 introduces failover slots.

Primary:
```sql
SELECT pg_create_logical_replication_slot('app_slot', 'pgoutput', false, true);
-- 4th arg = failover = true
```

Standby `postgresql.conf` (PG17+):
```ini
sync_replication_slots = on
```

Primary `postgresql.conf` (PG17+):
```ini
synchronized_standby_slots = 'standby1'
```

Verbatim PG17: *"Allow specification of physical standbys that must be synchronized before they are visible to subscribers."*[^pg17-synchronized-standby-slots]

After promotion, standby's slot is in sync with subscribers' last-known LSN. Subscribers reconnect to new primary without restart-from-scratch.

Cross-reference [`74-logical-replication.md`](./74-logical-replication.md) and [`75-replication-slots.md`](./75-replication-slots.md).

### Recipe 9 — Cascading replication for geographic distribution

Primary in US-East, hub-standby in US-West, downstream standbys in US-West local DCs.

Hub-standby `postgresql.conf`:
```ini
hot_standby = on
max_wal_senders = 5
max_replication_slots = 5
# primary_conninfo points at primary (US-East)
```

Downstream standby `postgresql.conf`:
```ini
hot_standby = on
# primary_conninfo points at hub-standby (US-West) — NOT at primary
primary_conninfo = 'host=hub-standby.us-west.example.com user=replicator ...'
```

Bandwidth saving: primary ships WAL once across US-East→US-West. Hub then redistributes locally.

Caveat: cascading standbys are always async with respect to primary's COMMIT. Primary's `synchronous_standby_names` cannot include cascaded standbys.

### Recipe 10 — Enable channel binding for replication

PG14 added SCRAM channel binding for client-side. Apply to replication connections too.

Primary `pg_hba.conf`:
```
hostssl replication replicator 10.0.0.0/8 scram-sha-256
```

Standby `primary_conninfo`:
```ini
primary_conninfo = 'host=primary.example.com port=5432 user=replicator
                    sslmode=verify-full sslrootcert=/etc/ssl/ca.crt
                    channel_binding=require
                    application_name=standby1'
```

Cross-reference [`49-tls-ssl.md`](./49-tls-ssl.md) for full TLS hardening.

### Recipe 11 — Detect query-cancel cascade

Standby logs flooded with `ERROR: canceling statement due to conflict with recovery`. Means `max_standby_streaming_delay` too low for query workload.

```sql
-- Run on standby
SELECT count(*) AS cancels_today
FROM pg_stat_database
WHERE datname = current_database();
-- conflicts column was added in PG14
```

Three mitigations:
1. **Raise `max_standby_streaming_delay`** to e.g., `5min`. Trade off: lag can grow during heavy primary writes.
2. **Enable `hot_standby_feedback = on`**. Trade off: primary bloat.
3. **Move queries to a dedicated reporting standby** with both #1 and #2 enabled.

### Recipe 12 — Force WAL switch + verify standby ack

For scripted operations that need confirmation a checkpoint reached the standby:

```sql
-- On primary
SELECT pg_switch_wal();

-- Wait for standby to catch up
DO $$
DECLARE
    target_lsn pg_lsn := pg_current_wal_lsn();
    standby_lsn pg_lsn;
BEGIN
    LOOP
        SELECT replay_lsn INTO standby_lsn
        FROM pg_stat_replication WHERE application_name = 'standby1';

        EXIT WHEN standby_lsn >= target_lsn;
        PERFORM pg_sleep(0.1);
    END LOOP;
    RAISE NOTICE 'standby1 caught up to %', target_lsn;
END$$;
```

### Recipe 13 — Emergency demotion (force-pause apply)

Standby is about to apply destructive WAL. Pause replay immediately.

```sql
-- On standby
SELECT pg_wal_replay_pause();

-- Verify
SELECT pg_get_wal_replay_pause_state();  -- 'paused'

-- After investigation, either resume or promote
SELECT pg_wal_replay_resume();           -- continue
-- OR
SELECT pg_promote(true, 60);             -- promote, abandon remaining WAL
```

`pg_get_wal_replay_pause_state()` PG14+ returns three values: `not paused`, `pause requested`, `paused`. Pre-PG14 use `pg_is_wal_replay_paused()` (boolean only).

## Gotchas / Anti-patterns

1. **`recovery.conf` carried forward from PG≤11 prevents PG12+ startup.** Server refuses to start with verbatim error referencing the file. Delete it and migrate settings to `postgresql.conf` + `standby.signal`.[^pg12-recoveryconf]

2. **`promote_trigger_file` removed in PG16.** Custom failover scripts that touched a trigger file silently no-op on PG16+. Use `pg_promote()` or `pg_ctl promote`.[^pg16-promote-trigger-removed]

3. **`synchronous_standby_names` empty string ≠ no sync — sync is OFF.** A common misconfiguration is to set `synchronous_commit = on` cluster-wide thinking it enables sync replication. Without `synchronous_standby_names` populated, every commit is "sync to primary disk only" — no standby is involved.

4. **Sync standby disconnect blocks all writes.** No automatic fallback to async. COMMIT hangs forever (or until `wal_sender_timeout` declares standby dead). Operator must explicitly remove from `synchronous_standby_names` and reload to unblock.

5. **`hot_standby_feedback = on` + abandoned standby = unbounded primary bloat.** If standby is offline but slot is retained, primary's `xmin` horizon is held back by the last reported standby xmin. Vacuum cannot remove dead tuples. Combine with `max_slot_wal_keep_size` AND monitor `pg_stat_replication` for missing standbys.

6. **`max_standby_streaming_delay = -1` is "wait forever" — apply lag grows unbounded.** Standby reads block primary's commits if you also have sync replication. Pick a finite value or use `hot_standby_feedback`.

7. **`max_standby_streaming_delay = 0` does not mean "fail fast on any conflict" — it means "cancel as soon as conflict arises".** WAL apply does not wait. If your reporting workload has even brief queries, you'll see frequent cancels.

8. **`primary_slot_name` without `max_slot_wal_keep_size` = unbounded primary disk usage.** Stuck/dead standby retains WAL forever. Combine with `max_slot_wal_keep_size` (PG13+) to cap.[^pg13-max-slot-wal-keep] Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).

9. **`wal_keep_size` is a fallback for slot-less replication.** With slots, set `wal_keep_size = 0` and let slots manage retention. Both at once = double-counting.

10. **`application_name` in `primary_conninfo` must be unique per standby.** Duplicate names → `synchronous_standby_names` matches whichever connects first; behavior undefined for the duplicate. Also breaks `pg_stat_replication` row identification.

11. **Synchronous replication does NOT replicate atomically — it replicates on COMMIT.** If primary crashes mid-transaction, the in-progress writes are not on the standby. After failover, the in-progress transaction is rolled back as if it never started. This is correct behavior, but subtle.

12. **`SERIALIZABLE` isolation forbidden on standby.** Verbatim from `hot-standby.html`: *"Serializable transactions are not allowed on hot standby servers."*[^hot-standby] Use `REPEATABLE READ` instead.

13. **LISTEN/NOTIFY does not propagate to standby.** A `NOTIFY` issued on primary does not fire LISTEN handlers on standby connections. Standby applications must connect to primary for notifications.

14. **Temp tables not allowed on standby pre-PG14.** PG14 relaxed: temp tables allowed via `pg_temp` namespace. Older versions: any `CREATE TEMP TABLE` errors out.

15. **Standby does NOT serve transactions started on primary.** Cannot start tx on primary, route SELECT to standby. `synchronous_commit = remote_apply` only ensures the COMMIT is visible on standby — does not transfer the transaction itself.

16. **`pg_basebackup -R` writes `primary_conninfo` to `postgresql.auto.conf`.** Hand-editing `postgresql.conf` does NOT override (`postgresql.auto.conf` precedence is higher). Use `ALTER SYSTEM SET primary_conninfo = ''` to clear, then re-set.

17. **`pg_promote()` returns immediately if `wait = false`.** Caller gets back `false` (because not yet complete) but promotion is in flight. Always check `pg_is_in_recovery()` to confirm.

18. **`recovery_target_inclusive = true` (default) means STOP AFTER target.** If `recovery_target_xid = 12345`, replay includes XID 12345 and stops just after. Set `inclusive = false` to stop just before.

19. **Multiple `recovery_target_*` GUCs is an error since PG12.** Verbatim: *"only allow one of `recovery_target`, `recovery_target_lsn`, `recovery_target_name`, `recovery_target_time`, and `recovery_target_xid`."*[^pg12-target-conflict]

20. **`recovery_target_timeline = 'latest'` is the PG12+ default.** Pre-PG12 default was `'current'`. After failover, new timeline is created — old standbys following `current` would be stuck on the dead branch. `latest` follows the newly promoted timeline automatically.[^pg12-target-latest]

21. **`pg_stat_replication.replay_lag` is NULL on idle standby.** The lag interval is computed from "primary commit timestamp" minus "standby reply at that LSN". If primary hasn't committed anything, there's nothing to compare. Insert a heartbeat row periodically if you need a non-NULL value.

22. **Cascaded standbys cannot satisfy primary's `synchronous_standby_names`.** Primary's sync requirement is only satisfied by standbys connected directly to primary. Cascaded standbys are always async from primary's perspective.

23. **`vacuum_defer_cleanup_age` removed in PG16.** Old advice "set this to defer vacuum until standby has caught up" no longer works. Use `hot_standby_feedback` + replication slots instead.[^pg16-vacuum-defer-removed]

## See Also

- [`33-wal.md`](./33-wal.md) — WAL format, `wal_level` deep dive, `synchronous_commit` low-level mechanics
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint interaction with replication
- [`46-roles-privileges.md`](./46-roles-privileges.md) — replication user privileges
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — `hostssl replication` rules
- [`49-tls-ssl.md`](./49-tls-ssl.md) — channel binding for replication conns
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_replication` view full reference
- [`63-internals-architecture.md`](./63-internals-architecture.md) — walsender / walreceiver / startup process
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication contrast
- [`76-logical-decoding.md`](./76-logical-decoding.md) — logical decoding on standbys (PG16+); output-plugin surface
- [`75-replication-slots.md`](./75-replication-slots.md) — slot mechanics shared by physical + logical
- [`77-standby-failover.md`](./77-standby-failover.md) — failover decision-tree
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA pattern catalog
- [`79-patroni.md`](./79-patroni.md) — Patroni cluster manager
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — PITR walkthrough
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest / Barman / WAL-G
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged former primary
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR runbook

## Sources

[^pg12-recoveryconf]: PG12 release notes. Verbatim: *"Move `recovery.conf` settings into `postgresql.conf` (Masao Fujii, Simon Riggs, Abhijit Menon-Sen, Sergei Kornilov). `recovery.conf` is no longer used, and the server will not start if that file exists. `recovery.signal` and `standby.signal` files are now used to switch into non-primary mode. The `trigger_file` setting has been renamed to `promote_trigger_file`. The `standby_mode` setting has been removed."* https://www.postgresql.org/docs/release/12.0/

[^pg12-target-latest]: PG12 release notes. Verbatim: *"Cause recovery to advance to the latest timeline by default (Peter Eisentraut). Specifically, `recovery_target_timeline` now defaults to `latest`. Previously, it defaulted to `current`."* https://www.postgresql.org/docs/release/12.0/

[^pg12-target-conflict]: PG12 release notes. Verbatim: *"Do not allow multiple conflicting `recovery_target*` specifications (Peter Eisentraut). Specifically, only allow one of `recovery_target`, `recovery_target_lsn`, `recovery_target_name`, `recovery_target_time`, and `recovery_target_xid`."* https://www.postgresql.org/docs/release/12.0/

[^pg12-promote]: PG12 release notes. Verbatim: *"Add function `pg_promote()` to promote standbys to primaries (Laurenz Albe, Michaël Paquier). Previously, this operation was only possible by using `pg_ctl` or creating a trigger file."* https://www.postgresql.org/docs/release/12.0/

[^recovery-config]: PostgreSQL 16 docs Appendix O.1 (Obsolete or Renamed Features). https://www.postgresql.org/docs/16/recovery-config.html

[^hot-standby]: PostgreSQL 16 docs §27.4 Hot Standby. https://www.postgresql.org/docs/16/hot-standby.html

[^pg13-max-slot-wal-keep]: PG13 release notes. `max_slot_wal_keep_size` GUC introduced. https://www.postgresql.org/docs/release/13.0/

[^pg14-restore-command-reload]: PG14 release notes. Verbatim: *"Allow the `restore_command` setting to be changed during a server reload (Sergei Kornilov). You can also set `restore_command` to an empty string and reload to force recovery to only read from the `pg_wal` directory."* https://www.postgresql.org/docs/release/14.0/

[^pg14-conflict-waits]: PG14 release notes. Verbatim: *"Add server parameter `log_recovery_conflict_waits` to report long recovery conflict wait times (Bertrand Drouvot, Masahiko Sawada)."* https://www.postgresql.org/docs/release/14.0/

[^pg14-replay-pause-state]: PG14 release notes. Verbatim: *"Add function `pg_get_wal_replay_pause_state()` to report the recovery state (Dilip Kumar). It gives more detailed information than `pg_is_wal_replay_paused()`, which still exists."* https://www.postgresql.org/docs/release/14.0/

[^pg14-in-hot-standby]: PG14 release notes. Verbatim: *"Add new read-only server parameter `in_hot_standby` (Haribabu Kommi, Greg Nancarrow, Tom Lane). This allows clients to easily detect whether they are connected to a hot standby server."* https://www.postgresql.org/docs/release/14.0/

[^pg14-syncfs]: PG14 release notes. Verbatim: *"Allow file system sync at the start of crash recovery on Linux (Thomas Munro). By default, PostgreSQL opens and fsyncs each data file in the database cluster at the start of crash recovery. A new setting, `recovery_init_sync_method=syncfs`, instead syncs each filesystem used by the cluster. This allows for faster recovery on systems with many database files."* https://www.postgresql.org/docs/release/14.0/

[^pg14-stat-repl-slots]: PG14 release notes. Verbatim: *"Add system view `pg_stat_replication_slots` to report replication slot activity (Masahiko Sawada, Amit Kapila, Vignesh C). The function `pg_stat_reset_replication_slot()` resets slot statistics."* https://www.postgresql.org/docs/release/14.0/

[^pg15-basebackup-lz4]: PG15 release notes. Verbatim: *"Add support for LZ4 and Zstandard compression of server-side base backups (Jeevan Ladhe, Robert Haas)."* https://www.postgresql.org/docs/release/15.0/

[^pg15-checkpointer-recovery]: PG15 release notes. Verbatim: *"Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro). This helps to speed up long crash recoveries."* https://www.postgresql.org/docs/release/15.0/

[^pg15-recovery-prefetch]: PG15 release notes. Verbatim: *"Allow WAL processing to pre-fetch needed file contents (Thomas Munro). This is controlled by the server variable `recovery_prefetch`."* https://www.postgresql.org/docs/release/15.0/

[^pg15-archive-library]: PG15 release notes. Verbatim: *"Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."* https://www.postgresql.org/docs/release/15.0/

[^pg15-no-identify-system]: PG15 release notes. Verbatim: *"No longer require `IDENTIFY_SYSTEM` to be run before `START_REPLICATION` (Jeff Davis)."* https://www.postgresql.org/docs/release/15.0/

[^pg16-promote-trigger-removed]: PG16 release notes. Verbatim: *"Remove server variable `promote_trigger_file` (Simon Riggs). This was used to promote a standby to primary, but is now more easily accomplished with `pg_ctl promote` or `pg_promote()`."* https://www.postgresql.org/docs/release/16.0/

[^pg16-vacuum-defer-removed]: PG16 release notes. Verbatim: *"Remove the server variable `vacuum_defer_cleanup_age` (Andres Freund). This has been unnecessary since `hot_standby_feedback` and replication slots were added."* https://www.postgresql.org/docs/release/16.0/

[^pg16-logical-on-standby]: PG16 release notes. Verbatim: *"Allow logical decoding on standbys (Bertrand Drouvot, Andres Freund, Amit Khandekar). Snapshot WAL records are required for logical slot creation but cannot be created on standbys. To avoid delays, the new function `pg_log_standby_snapshot()` allows creation of such records."* https://www.postgresql.org/docs/release/16.0/

[^pg17-incremental]: PG17 release notes. Verbatim: *"Add support for incremental file system backup (Robert Haas, Jakub Wartak, Tomas Vondra). Incremental backups can be created using `pg_basebackup`'s new `--incremental` option. The new application `pg_combinebackup` allows manipulation of base and incremental file system backups."* https://www.postgresql.org/docs/release/17.0/

[^pg17-summarize-wal]: PG17 release notes. Verbatim: *"Allow the creation of WAL summarization files (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski). These files record the block numbers that have changed within an LSN range and are useful for incremental file system backups. This is controlled by the server variables `summarize_wal` and `wal_summary_keep_time`, and introspected with `pg_available_wal_summaries()`, `pg_wal_summary_contents()`, and `pg_get_wal_summarizer_state()`."* https://www.postgresql.org/docs/release/17.0/

[^pg17-slot-cols]: PG17 release notes. Verbatim: *"Add column `pg_replication_slots.invalidation_reason` to report the reason for invalid slots (Shveta Malik, Bharath Rupireddy). Add column `pg_replication_slots.inactive_since` to report slot inactivity duration (Bharath Rupireddy)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-sync-slots-fn]: PG17 release notes. Verbatim: *"Add function `pg_sync_replication_slots()` to synchronize logical replication slots (Hou Zhijie, Shveta Malik, Ajin Cherian, Peter Eisentraut)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-sync-replication-slots]: PG17 release notes. Verbatim: *"Add server variable `sync_replication_slots` to enable failover logical slot synchronization (Shveta Malik, Hou Zhijie, Peter Smith)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-synchronized-standby-slots]: PG17 release notes. Verbatim: *"Allow specification of physical standbys that must be synchronized before they are visible to subscribers (Hou Zhijie, Shveta Malik). The new server variable is `synchronized_standby_slots`."* https://www.postgresql.org/docs/release/17.0/

[^pg17-pgcreatesubscriber]: PG17 release notes. Verbatim: *"Add application `pg_createsubscriber` to create a logical replica from a physical standby server (Euler Taveira)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-basebackup-dbname]: PG17 release notes. Verbatim: *"Allow connection string value `dbname` to be written when `pg_basebackup` writes connection information to `postgresql.auto.conf` (Vignesh C, Hayato Kuroda)."* https://www.postgresql.org/docs/release/17.0/

[^pg18-idle-slot-timeout]: PG18 release notes. Verbatim: *"Allow inactive replication slots to be automatically invalidated using server variable `idle_replication_slot_timeout` (Nisha Moond, Bharath Rupireddy)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-max-active-origins]: PG18 release notes. Verbatim: *"Add server variable `max_active_replication_origins` to control the maximum active replication origins (Euler Taveira). This was previously controlled by `max_replication_slots`, but this new setting allows a higher origin count in cases where fewer slots are required."* https://www.postgresql.org/docs/release/18.0/

[^pg18-pgrecvlogical-failover]: PG18 release notes. Verbatim: *"Add `pg_recvlogical` option `--enable-failover` to specify failover slots (Hayato Kuroda). Also add option `--enable-two-phase` as a synonym for `--two-phase`, and deprecate the latter."* https://www.postgresql.org/docs/release/18.0/

Primary references:

- PG16 §27.2 Log-Shipping Standby Servers — https://www.postgresql.org/docs/16/warm-standby.html
- PG16 §20.6 Replication GUCs — https://www.postgresql.org/docs/16/runtime-config-replication.html
- PG16 §20.5 WAL GUCs — https://www.postgresql.org/docs/16/runtime-config-wal.html
- PG16 §27.4 Hot Standby — https://www.postgresql.org/docs/16/hot-standby.html
- PG16 §30.4 Asynchronous Commit — https://www.postgresql.org/docs/16/wal-async-commit.html
- PG16 Appendix O.1 (recovery.conf migration) — https://www.postgresql.org/docs/16/recovery-config.html
- PG16 §55.4 Streaming Replication Protocol — https://www.postgresql.org/docs/16/protocol-replication.html
- PG16 `pg_basebackup` reference — https://www.postgresql.org/docs/16/app-pgbasebackup.html
- PG16 `pg_stat_replication` view — https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW
- PG16 Recovery Control Functions — https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-RECOVERY-CONTROL

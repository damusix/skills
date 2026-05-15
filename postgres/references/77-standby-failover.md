# Hot Standby + Failover

Hot standby query rules, promotion mechanics (`pg_promote()` PG12+ supersedes `trigger_file`/`promote_trigger_file`), `max_standby_*_delay` cancel vs wait, `hot_standby_feedback` trade-off, `pg_rewind` re-attach diverged former primary, timeline divergence, `pg_createsubscriber` PG17+ physical-to-logical conversion.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [Hot standby query rules](#hot-standby-query-rules)
  - [Standby query conflicts](#standby-query-conflicts)
  - [Promotion mechanisms](#promotion-mechanisms)
  - [Recovery target settings](#recovery-target-settings)
  - [Recovery pause introspection](#recovery-pause-introspection)
  - [Controlled switchover procedure](#controlled-switchover-procedure)
  - [Timeline IDs](#timeline-ids)
  - [pg_rewind — re-attach diverged former primary](#pg_rewind--re-attach-diverged-former-primary)
  - [pg_createsubscriber — convert physical standby to logical subscriber (PG17+)](#pg_createsubscriber--convert-physical-standby-to-logical-subscriber-pg17)
  - [Monitoring views](#monitoring-views)
  - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

> [!WARNING] PG12 watershed — recovery.conf removed, `pg_promote()` is the modern promotion mechanism
> PG12 deleted `recovery.conf` entirely. Standby identity moved to `standby.signal` (presence file) + `primary_conninfo` GUC in `postgresql.conf`. The `trigger_file` GUC was renamed to `promote_trigger_file`. PG12 also added `pg_promote()` as the in-DB promotion path.[^pg12]

> [!WARNING] PG16 watershed — `promote_trigger_file` removed entirely
> Verbatim PG16 release note: *"Remove server variable `promote_trigger_file` (Simon Riggs). This was used to promote a standby to primary, but is now more easily accomplished with `pg_ctl promote` or `pg_promote()`."*[^pg16-promote] Failover scripts that touch a filesystem path silently no-op on PG16+.

This is the failover/promotion deep dive. Cross-references:

- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical streaming setup, `synchronous_standby_names`, `hot_standby_feedback` trade-off
- [`75-replication-slots.md`](./75-replication-slots.md) — slot WAL retention, slot invalidation, PG17+ failover slots
- [`89-pg-rewind.md`](./89-pg-rewind.md) — pg_rewind deep dive (this file documents the *when* + summary; 89 documents the full mechanics)
- [`78-ha-architectures.md`](./78-ha-architectures.md) — cluster-manager patterns (Patroni, repmgr, pg_auto_failover) that orchestrate the procedures documented here
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR drills + cross-region failover

This file owns: hot standby query rules, the promotion API surface, the controlled switchover runbook, timeline-divergence theory, `pg_rewind` use cases, `pg_createsubscriber` use cases.

## Mental Model

1. **Standby is read-only until promoted.** Hot standby (default `on` since PG10) allows SELECT against a streaming standby during recovery. Writes are rejected with error `25006: cannot execute X in a read-only transaction`. SERIALIZABLE is forbidden on hot standby (`SERIALIZABLE READ ONLY DEFERRABLE` also fails).[^hot-standby]

2. **`pg_promote()` is the modern promotion mechanism (PG12+).** Verbatim release-note quote: *"Add function `pg_promote()` to promote standbys to primaries. Previously, this operation was only possible by using pg_ctl or creating a trigger file."*[^pg12-promote] Signature: `pg_promote(wait boolean DEFAULT true, wait_seconds integer DEFAULT 60) → boolean`. Three operational paths: `SELECT pg_promote();` (SQL), `pg_ctl promote -D /path/to/data` (shell), `touch promote.signal` in `$PGDATA` (signal file). `promote_trigger_file` GUC was removed in PG16.

3. **`max_standby_streaming_delay = -1` waits forever; `= 0` cancels immediately.** Tunes query-cancel-vs-replication-lag trade-off when a standby query conflicts with WAL replay. Default 30s. Negative one means "wait forever for query, let replay lag"; zero means "kill query immediately on conflict". The asymmetric defaults (`max_standby_archive_delay` also 30s) bite operators who assume `-1` and `0` are similar.[^max-standby-delay]

4. **`hot_standby_feedback` is a bidirectional trade-off.** Set `on` → standby xmin propagates to primary's autovacuum → primary keeps dead tuples longer → less query-cancel on standby BUT more primary bloat. Set `off` (default) → no propagation → autovacuum cleans aggressively on primary BUT standby queries get cancelled on UPDATE-heavy workloads. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) for the full trade-off table.

5. **After failover, the old primary's timeline diverges from the new primary's.** `pg_rewind` rewinds the old primary back to the divergence point + applies WAL from the new primary, avoiding a fresh base backup. Requirements: `wal_log_hints = on` OR `data_checksums` enabled at `initdb` AND `full_page_writes = on` AND both nodes cleanly shut down before `pg_rewind` runs.[^pg-rewind]

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Promote standby via SQL | `SELECT pg_promote();` PG12+ | Touch promote signal file | API-driven, returns success/failure boolean |
| Promote standby from shell | `pg_ctl promote -D $PGDATA` | `kill -USR1 postmaster` | Documented, idempotent, integrates with init systems |
| Disable failover orchestration tool from promoting | Set `promote_trigger_file` (PG≤15) | Disable replication | **N/A on PG16+** — promote-trigger-file removed |
| Bound max query-cancel risk on standby | `max_standby_streaming_delay = 30s` (default) | `-1` wait-forever in production | -1 lets replay lag unbounded under contention |
| Bound primary bloat from hot_standby_feedback | Monitor primary `n_dead_tup` + standby connection age | Leave `hot_standby_feedback=on` forever | Long-running standby query + busy primary = unbounded bloat |
| Controlled switchover with zero data loss | Sync primary → wait flush → `pg_promote()` standby → restart old primary as standby | Hard kill old primary | See switchover recipe |
| Re-attach diverged former primary | `pg_rewind` | Fresh `pg_basebackup` | Rewind transfers ~delta-since-divergence, not full DB |
| Convert physical standby to logical subscriber | `pg_createsubscriber` PG17+ | Build logical replica from scratch | Avoids initial COPY for large databases |
| Detect "am I on standby?" from app | `SELECT pg_is_in_recovery();` OR `SHOW in_hot_standby;` PG14+ | Read `pg_stat_replication` | Direct boolean, no privilege escalation |
| Pause replay for forensics | `SELECT pg_wal_replay_pause();` + `pg_get_wal_replay_pause_state()` PG14+ | Stop the standby process | Three-state return clarifies pause-requested vs paused |
| Force WAL flush before failover | Application-side: `SELECT pg_switch_wal();` + wait `pg_wal_lsn_diff` | Manual file copy | Programmatic, drains async standbys |

Smell signals:

- Failover script that writes a file to `$PGDATA/standby.signal` AND a separate `trigger_file` path → script written pre-PG12; refactor to `pg_promote()` or `pg_ctl promote`
- `max_standby_streaming_delay = -1` in postgresql.conf → no upper bound on replication lag; production hazard
- `pg_rewind` failing with "cluster needs to be shut down cleanly" → old primary still has the postmaster running; must `pg_ctl stop` first

## Syntax / Mechanics

### Hot standby query rules

Hot standby is enabled by default since PG10 (`hot_standby = on`). When the postmaster sees `standby.signal` at startup, it enters recovery mode and the startup process replays WAL continuously. Once the standby reaches a consistent snapshot, query backends are accepted.

**Allowed on standby:**

- `SELECT`, `WITH`, `EXPLAIN`, `SHOW`
- `BEGIN`/`COMMIT`/`ROLLBACK` (transaction commands)
- `LOCK TABLE ... IN ACCESS SHARE MODE` (or weaker)
- `SET`/`RESET` (session GUCs)
- `LISTEN`/`UNLISTEN` (read-only session commands)

> [!NOTE] `NOTIFY` is NOT allowed on standby — it requires a write. Only `LISTEN` and `UNLISTEN` are permitted; `NOTIFY` is refused.
- `DECLARE CURSOR FOR SELECT ...`
- `FETCH`, `MOVE`, `CLOSE`
- Temp tables (PG14+; pre-PG14 forbidden — cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) gotcha #14)
- `DISCARD` (since PG14)

**Forbidden on standby:**

- Any DML (`INSERT`/`UPDATE`/`DELETE`/`MERGE`)
- DDL of any kind
- `VACUUM`, `ANALYZE`, `REINDEX`, `CREATE INDEX` (write WAL)
- `SELECT ... FOR UPDATE/SHARE` (writes row lock to xmax)
- `SERIALIZABLE` isolation level — verbatim docs quote: *"Transactions started during recovery may issue the LISTEN, UNLISTEN, and NOTIFY commands, but these commands will only be effective on the primary."*[^hot-standby]
- Sequences (`nextval()`, `setval()`)
- 2PC commands (`PREPARE TRANSACTION`, `COMMIT PREPARED`, `ROLLBACK PREPARED`)

### Standby query conflicts

Replay may stall because a standby query holds resources that conflict with the WAL record about to be replayed. Five conflict types:

| Conflict type | Trigger | Resolution |
|---|---|---|
| Buffer pin | Standby query has pinned buffer that needs cleanup-lock from VACUUM record | Cancel query OR wait |
| Lock | Standby query holds `AccessShareLock`, replay needs `AccessExclusiveLock` (DDL) | Cancel query OR wait |
| Snapshot | Standby query's xmin older than the row VACUUM is about to remove | Cancel query OR wait |
| Tablespace | Standby query reads from a tablespace being dropped on primary | Cancel query (always) |
| Database | Standby query connected to a database being dropped on primary | Disconnect (always) |

Three GUCs control how long replay waits before cancelling the standby query:

| GUC | Default | Meaning |
|---|---|---|
| `max_standby_streaming_delay` | `30s` | Wait time when conflict appears during streaming-mode replay. `-1` = wait forever (lag unbounded); `0` = cancel immediately |
| `max_standby_archive_delay` | `30s` | Wait time during archive-recovery replay (rare in modern streaming). Same `-1` and `0` semantics |
| `hot_standby_feedback` | `off` | If `on`, standby sends its xmin to primary's autovacuum so primary delays cleanup. Reduces snapshot-conflict cancels at cost of primary bloat |

> [!NOTE] PG14 `log_recovery_conflict_waits`
> Verbatim PG14 release note: *"Add server parameter `log_recovery_conflict_waits` to report long recovery conflict wait times (Bertrand Drouvot, Masahiko Sawada)."*[^pg14-log-recovery-conflict] When `on`, recovery process logs when a conflict has waited longer than `deadlock_timeout`. Operational signal that replay is being blocked.

When the wait deadline expires, the cancel hits with: `ERROR: canceling statement due to conflict with recovery`. Application code that reads from a standby must catch this and retry.

### Promotion mechanisms

Three paths to promote a standby to primary. All three end with the startup process exiting recovery mode, writing a new WAL record (the "end-of-recovery checkpoint"), incrementing the timeline ID, and accepting writes.

#### `pg_promote()` SQL function (PG12+, recommended)

```sql
-- Returns true if promotion succeeds within wait_seconds, false on timeout
SELECT pg_promote();                       -- wait=true, wait_seconds=60 (defaults)
SELECT pg_promote(wait := true, wait_seconds := 30);  -- explicit args
SELECT pg_promote(wait := false);          -- fire-and-forget, returns immediately
```

When `wait=true`, the function blocks until `pg_is_in_recovery()` returns false or `wait_seconds` elapses. When `wait=false`, returns immediately after sending `SIGUSR1` to postmaster — caller must poll `pg_is_in_recovery()` separately. Requires `pg_promote` predefined role or superuser.

> [!NOTE] PG12 introduction
> Verbatim: *"Add function `pg_promote()` to promote standbys to primaries (Laurenz Albe, Michaël Paquier). Previously, this operation was only possible by using pg_ctl or creating a trigger file."*[^pg12-promote]

#### `pg_ctl promote` shell command

```bash
pg_ctl promote -D /var/lib/postgresql/16/main
# server promoting
```

Sends `SIGUSR1` to the postmaster process (after writing a promote signal file in `$PGDATA`). Returns immediately; caller must check `pg_is_in_recovery()` to confirm.

#### Promote signal file

Touch a file named `promote` (or `fallback_promote` for fast promotion without checkpoint) in `$PGDATA`:

```bash
# Standard promotion (creates end-of-recovery checkpoint)
touch /var/lib/postgresql/16/main/promote

# Fast promotion (skip end-of-recovery checkpoint; PG also writes one shortly after)
touch /var/lib/postgresql/16/main/fallback_promote
```

The startup process polls for these files. Used internally by `pg_ctl promote` and `pg_promote()`. Direct manipulation is rare; only useful when SQL/CLI paths are unavailable (e.g., running out of connections).

> [!WARNING] `promote_trigger_file` GUC removed in PG16
> Pre-PG16 configurations could specify an arbitrary path via `promote_trigger_file = '/path/to/trigger'`. The startup process polled that exact path. Failover scripts that wrote to that file silently no-op on PG16+ because the GUC no longer exists. Migrate to `pg_promote()` or `pg_ctl promote`.[^pg16-promote]

### Recovery target settings

Recovery target settings stop WAL replay at a specific point. Used for PITR + emergency rollback. All live in `postgresql.conf` since PG12 (formerly `recovery.conf`):

| GUC | Type | Effect |
|---|---|---|
| `recovery_target` | `'immediate'` or unset | If `immediate`, stop at first consistent state |
| `recovery_target_lsn` | LSN | Stop at exact WAL LSN |
| `recovery_target_xid` | xid | Stop after applying this transaction |
| `recovery_target_time` | timestamptz | Stop at first commit > target |
| `recovery_target_name` | text | Stop at named restore point (created via `pg_create_restore_point()` on primary) |
| `recovery_target_inclusive` | bool, default `true` | Whether to stop AFTER target (true) or BEFORE (false) |
| `recovery_target_timeline` | `'latest'` (default since PG12), `'current'`, or integer | Which timeline to follow at branches |
| `recovery_target_action` | `pause`/`promote`/`shutdown` (default `pause`) | What to do once target reached |

> [!NOTE] PG12 recovery_target_timeline default changed to 'latest'
> Verbatim: *"recovery_target_timeline=latest is now the default (was current)."*[^pg12] Most PITR users want to follow the latest timeline; previous default caused confusing replays.

> [!NOTE] PG13 recovery-target enforcement
> Verbatim: *"Generate an error if recovery does not reach the specified recovery target (Leif Gunnar Erlandsen, Peter Eisentraut). Previously, a standby would promote itself upon reaching the end of WAL, even if the target was not reached."*[^pg13-recovery-target] Pre-PG13 silently promoted instead of erroring — operational hazard if archive incomplete.

Cross-reference [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) for full PITR walkthrough.

### Recovery pause introspection

Pause WAL replay without stopping the standby process:

```sql
-- Request replay pause (returns immediately, may still be applying current record)
SELECT pg_wal_replay_pause();

-- PG14+: three-state return
SELECT pg_get_wal_replay_pause_state();
-- Returns one of:
--   'not paused'        — replay active
--   'pause requested'   — pause sent but startup is mid-record
--   'paused'            — fully paused, no replay happening
```

> [!NOTE] PG14 `pg_get_wal_replay_pause_state()` three-state
> Verbatim: *"Add function `pg_get_wal_replay_pause_state()` to report the recovery state (Dilip Kumar). It gives more detailed information than `pg_is_wal_replay_paused()`, which still exists."*[^pg14-pause-state] Pre-PG14 `pg_is_wal_replay_paused()` returned `true` immediately after the pause request even if replay was still applying a record — debugging hazard. Three-state return clarifies.

Resume:

```sql
SELECT pg_wal_replay_resume();
```

Use cases: forensics (inspect data state at specific LSN), bound replay lag during planned maintenance, hold standby behind primary for human-error rollback window.

> [!NOTE] PG13 promotion-during-pause
> Verbatim: *"Allow standby promotion to cancel any requested pause (Fujii Masao). Previously, promotion could not happen while the standby was in paused state."*[^pg13-pause-promote] Pre-PG13 paused standby required `pg_wal_replay_resume()` before promotion. PG13+ promotion cancels pending pause automatically.

### Controlled switchover procedure

Planned switch of primary role with **zero data loss**. Pre-PG18 this is a 7-step manual procedure; cluster managers (Patroni, repmgr) automate it. Cross-reference [`78-ha-architectures.md`](./78-ha-architectures.md) and [`79-patroni.md`](./79-patroni.md).

```bash
# === On OLD primary (call it P1) ===
# 1. Stop new connections via pgBouncer PAUSE or REVOKE CONNECT on all roles
#    (cross-reference 46-roles-privileges.md Recipe 3 for REVOKE CONNECT)

# 2. Wait for all in-flight transactions to finish; verify no idle-in-tx
psql -c "SELECT pid, state, xact_start, query FROM pg_stat_activity
         WHERE state IN ('active','idle in transaction') AND pid <> pg_backend_pid();"

# 3. Force final WAL switch
psql -c "SELECT pg_switch_wal();"

# 4. Verify standby caught up (replay_lsn on P2 == current WAL on P1)
psql -c "SELECT application_name, sent_lsn, write_lsn, flush_lsn, replay_lsn,
                pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes
         FROM pg_stat_replication;"
# Expect replay_lag_bytes = 0 for the standby being promoted

# 5. Cleanly stop OLD primary
pg_ctl stop -D $PGDATA -m fast

# === On NEW primary (call it P2) ===
# 6. Promote P2
psql -c "SELECT pg_promote();"
# OR: pg_ctl promote -D $PGDATA

# Verify
psql -c "SELECT pg_is_in_recovery();"  -- expect: f

# === Re-attach OLD primary as standby ===
# 7. P1's timeline now diverges from P2. Use pg_rewind to re-attach.
#    (See pg_rewind section below.)
pg_rewind --target-pgdata=$PGDATA --source-server="host=p2-host user=replication" -P

# Write recovery config + start P1 as standby of P2
cat >> $PGDATA/postgresql.auto.conf <<EOF
primary_conninfo = 'host=p2-host user=replication application_name=p1'
primary_slot_name = 'p1_slot'
EOF
touch $PGDATA/standby.signal
pg_ctl start -D $PGDATA
```

Key invariants:

- Step 4 confirms `replay_lag_bytes = 0` on the standby being promoted. Skip this and lose committed transactions if old primary had outstanding WAL not yet shipped.
- Step 5 must use `pg_ctl stop` (clean shutdown writes a checkpoint). A `kill -9` or crash bypasses this and forces a `pg_rewind` instead.
- Step 7 (`pg_rewind`) requires `wal_log_hints = on` OR `data_checksums` enabled at initdb time on the OLD primary. Without one of these, `pg_rewind` refuses — fall back to fresh `pg_basebackup`.

### Timeline IDs

PostgreSQL tracks WAL streams via integer timeline IDs (`tli`). Every fresh cluster starts at timeline 1. Each promotion increments the timeline; the promotion event writes a `timeline_history` file in `pg_wal/` recording the LSN at which the new timeline diverged from the old.

ASCII illustration:

```
Timeline 1: ─────────────────────┬──────────────  (old primary's history)
                                 │
                                 └─ promotion at LSN 0/A1B2C3D4
                                    │
Timeline 2:                         ──────────────  (new primary continues here)
```

Files in `pg_wal/`:

```
000000010000000000000001        — WAL segment, timeline 1, lsn 0/01000000
000000010000000000000002
...
000000020000000000000003        — first WAL segment on timeline 2
00000002.history                — records "timeline 2 forked from timeline 1 at 0/A1B2C3D4"
```

`pg_rewind` and `recovery_target_timeline` rely on timeline history files to follow branches correctly. A standby with `recovery_target_timeline = 'latest'` will follow timeline 2 automatically after promotion.

Introspection on a running standby:

```sql
SELECT pg_walfile_name(pg_last_wal_replay_lsn());
-- Returns:  000000020000000000000003  (timeline 2)

SELECT timeline_id FROM pg_control_checkpoint();
-- Returns:  2
```

### pg_rewind — re-attach diverged former primary

`pg_rewind` synchronizes a former primary (whose timeline has diverged) with the new primary, transferring only the changed blocks since the divergence point. Avoids a fresh `pg_basebackup` for large databases.

**Requirements (mandatory):**

1. **`wal_log_hints = on`** in postgresql.conf **OR** `data_checksums` enabled at `initdb` time on the OLD primary. One of the two must have been active BEFORE the divergence — turning on after is too late.[^pg-rewind]
2. **`full_page_writes = on`** (default).
3. **Target server cleanly shut down.** No `kill -9`, no crash.
4. **Source server cleanly shut down** (when using `--source-pgdata`) **OR running** (when using `--source-server`).

**Two source modes:**

```bash
# Source = running new primary (recommended for online switchover)
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-server="host=new-primary.example.com port=5432 user=replication dbname=postgres" \
  --progress

# Source = filesystem path to new primary's data dir (rare; offline scenario)
pg_rewind \
  --target-pgdata=/var/lib/postgresql/16/main \
  --source-pgdata=/mnt/new-primary/pgdata
```

**What it does internally:**

1. Scan WAL on the target (old primary) backward from current tip to find the divergence LSN (point where the target's WAL last matched the source's history).
2. Determine which blocks changed on the target after divergence.
3. Fetch those same blocks from the source (which has the authoritative new-timeline content).
4. Overwrite changed blocks on the target.
5. Update target's pg_control to point at the new timeline.

After `pg_rewind` completes, configure the target to start as a standby (write `standby.signal`, set `primary_conninfo`) and start the postmaster. The target will pick up streaming replay from the new primary.

> [!NOTE] PG13 pg_rewind ergonomics
> Three PG13 improvements: (a) automatic crash recovery before rewinding — verbatim *"Have pg_rewind automatically run crash recovery before rewinding (Paul Guo, Jimmy Yih, Ashwin Agrawal). This can be disabled by using `--no-ensure-shutdown`."*[^pg13-rewind-crash]; (b) target-cluster `restore_command` integration — verbatim *"Allow pg_rewind to use the target cluster's `restore_command` to retrieve needed WAL (Alexey Kondratov)."*[^pg13-rewind-restore]; (c) standby configuration write — verbatim *"Add an option to pg_rewind to configure standbys (Paul Guo, Jimmy Yih, Ashwin Agrawal). This matches pg_basebackup's `--write-recovery-conf` option."*[^pg13-rewind-conf]

> [!NOTE] PG18 pg_rewind dbname in recovery config
> Verbatim: *"If pg_rewind's `--source-server` specifies a database name, use it in `--write-recovery-conf` output (Masahiko Sawada)."*[^pg18-rewind-dbname] Pre-PG18 generated recovery config had no dbname, requiring manual editing for clusters where the replication-monitoring tool expects one.

Cross-reference [`89-pg-rewind.md`](./89-pg-rewind.md) for the full mechanics deep dive.

### pg_createsubscriber — convert physical standby to logical subscriber (PG17+)

Converts a physical streaming standby into a logical replication subscriber without an initial COPY. Useful for cross-version upgrades and selective-table replication of large databases.

```bash
# On the physical standby (must be cleanly stopped first)
pg_ctl stop -D /var/lib/postgresql/17/standby -m fast

pg_createsubscriber \
  --pgdata=/var/lib/postgresql/17/standby \
  --publisher-server="host=primary.example.com user=replication dbname=app" \
  --subscriber-server="host=localhost user=postgres dbname=app" \
  --database=app \
  --publication=app_pub \
  --subscription=app_sub
```

What it does:

1. Stop the standby's recovery at a consistent LSN.
2. Create the publication on the source (publisher) if it doesn't exist.
3. Promote the standby to primary.
4. Create a subscription that picks up where physical replay stopped, with `copy_data = false` (because the data is already there byte-for-byte).
5. Start the subscriber. Apply continues logically.

> [!NOTE] PG17 pg_createsubscriber introduction
> Verbatim: *"Add application pg_createsubscriber to create a logical replica from a physical standby server (Euler Taveira)."*[^pg17-createsubscriber] The PG18 release adds `--enable-two-phase` and `--all` flags.

Cross-reference [`74-logical-replication.md`](./74-logical-replication.md) Recipe 6 for the use case (zero-downtime major upgrade).

### Monitoring views

| View | Used for | Cross-reference |
|---|---|---|
| `pg_stat_replication` (on primary) | Shows each connected walsender: `application_name`, `state`, `sent_lsn`, `write_lsn`, `flush_lsn`, `replay_lsn`, `write_lag`, `flush_lag`, `replay_lag` | [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) |
| `pg_stat_wal_receiver` (on standby) | Shows the walreceiver process: `status`, `received_lsn`, `last_msg_send_time`, `last_msg_receipt_time`, `latest_end_lsn`, `slot_name`, `conninfo` | [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) |
| `pg_replication_slots` | Slot WAL retention, `wal_status`, `invalidation_reason`, `inactive_since`, `failover` (PG17+) | [`75-replication-slots.md`](./75-replication-slots.md) |
| `pg_is_in_recovery()` | Boolean: am I a standby? | n/a |
| `pg_last_wal_replay_lsn()` | Last LSN applied on this standby | n/a |
| `pg_last_wal_receive_lsn()` | Last LSN received (may be > replay_lsn if replay is paused/lagging) | n/a |
| `pg_get_wal_replay_pause_state()` PG14+ | `not paused` / `pause requested` / `paused` | this file |
| `pg_control_checkpoint()` | Timeline ID, redo LSN, checkpoint LSN from on-disk control file | this file |

Critical queries documented in Recipes section below.

### Per-version timeline

| Version | Standby/failover changes |
|---|---|
| **PG12** | `recovery.conf` removed; replaced by `standby.signal` + `recovery.signal` + GUCs in postgresql.conf. `pg_promote()` function added. `trigger_file` renamed to `promote_trigger_file`. `recovery_target_timeline = 'latest'` default. `pg_copy_*_replication_slot()` added. Verbatim release-note quotes preserved.[^pg12][^pg12-promote] |
| **PG13** | Standby promotion cancels pending pause; recovery-target-not-reached now errors (was silent promote); pg_rewind auto-crash-recovery + `restore_command` integration + standby-config writer. Five items, all verbatim.[^pg13-pause-promote][^pg13-recovery-target][^pg13-rewind-crash][^pg13-rewind-restore][^pg13-rewind-conf] |
| **PG14** | `pg_get_wal_replay_pause_state()` three-state function; `in_hot_standby` read-only GUC; `log_recovery_conflict_waits` GUC; `recovery_init_sync_method=syncfs` Linux option; `restore_command` reloadable on SIGHUP; recovery pause (instead of immediate shutdown) on standby/primary parameter mismatch.[^pg14-pause-state][^pg14-in-hot-standby][^pg14-log-recovery-conflict][^pg14-syncfs][^pg14-restore-command-reload][^pg14-param-mismatch] |
| **PG15** | No headline hot standby / promotion / pg_rewind release-note items. Recovery enhancements focused on WAL prefetch + background process improvements during crash recovery (cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md)). |
| **PG16** | `promote_trigger_file` REMOVED (operational watershed for failover scripts); `vacuum_defer_cleanup_age` removed; logical decoding on standbys.[^pg16-promote] |
| **PG17** | `pg_createsubscriber` CLI for physical-to-logical conversion; logical slot failover (`sync_replication_slots`, `synchronized_standby_slots`, `pg_sync_replication_slots()`); pg_basebackup `--incremental` + `pg_combinebackup`.[^pg17-createsubscriber] |
| **PG18** | `idle_replication_slot_timeout` GUC; pg_recvlogical `--enable-failover`; pg_createsubscriber `--enable-two-phase`; pg_rewind `--write-recovery-conf` includes dbname.[^pg18-rewind-dbname] |

## Examples / Recipes

### Recipe 1: Detect "am I on a standby?" from an application

The canonical "is this a writable connection?" check. Both work; second is PG14+.

```sql
-- Works on all supported versions
SELECT pg_is_in_recovery();
-- f (primary) or t (standby)

-- PG14+: GUC, allows app-side detection via SHOW
SHOW in_hot_standby;
-- off (primary) or on (standby in hot standby mode)
```

App-side connection-pool routing: if `pg_is_in_recovery()` returns `true` and the app intended a write, the pool should route to a different connection or surface an error.

### Recipe 2: Promote a standby via SQL

```sql
-- Synchronous promote, wait up to 60s
SELECT pg_promote();
-- Returns: t (success) or f (timeout)

-- Verify
SELECT pg_is_in_recovery();
-- Returns: f

-- Check new timeline
SELECT timeline_id FROM pg_control_checkpoint();
-- Returns: 2 (was 1)
```

If `pg_promote()` returns `f`, the standby is still in recovery. Inspect the server log for the reason (most common: walreceiver was still applying a large transaction when the wait timeout expired).

### Recipe 3: Check standby lag in real time (run on primary)

```sql
SELECT
  client_addr,
  application_name,
  state,
  sync_state,
  pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)     AS pending_bytes,
  pg_wal_lsn_diff(sent_lsn, flush_lsn)                AS flush_lag_bytes,
  pg_wal_lsn_diff(flush_lsn, replay_lsn)              AS replay_lag_bytes,
  write_lag, flush_lag, replay_lag
FROM pg_stat_replication
ORDER BY client_addr;
```

Interpretation:

- `pending_bytes > 0` → primary hasn't sent recent WAL to this standby (network or walsender backpressure)
- `flush_lag_bytes > 0` → standby received but hasn't fsynced
- `replay_lag_bytes > 0` → standby fsynced but startup process hasn't replayed (queries on the standby could be holding it up if `hot_standby_feedback = off` is forcing pauses)
- `replay_lag IS NULL` → standby is idle, no recent WAL traffic to measure — NOT a problem

### Recipe 4: Bound query-cancel risk on a reporting standby

```sql
-- On the standby, in postgresql.conf
hot_standby_feedback = on            # avoid query cancels at cost of primary bloat
max_standby_streaming_delay = 5min   # allow longer queries before cancelling
max_standby_archive_delay = 5min     # same for archive recovery

-- On the primary, monitor for bloat caused by this
SELECT
  relname,
  n_live_tup,
  n_dead_tup,
  round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
  last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 100000
ORDER BY n_dead_tup DESC
LIMIT 20;
```

If primary bloat starts climbing, find the long-running standby query holding the xmin horizon back:

```sql
-- On the primary
SELECT pid, application_name, client_addr, backend_xmin, age(backend_xmin) AS xmin_age
FROM pg_stat_replication
WHERE backend_xmin IS NOT NULL
ORDER BY backend_xmin;
```

Tune by either (a) shortening the standby query, (b) lowering `max_standby_streaming_delay` to force cancels, or (c) routing the reporting workload to a dedicated standby that doesn't share `hot_standby_feedback` with the rest of the fleet.

### Recipe 5: Controlled switchover with zero data loss

Walkthrough of the canonical procedure for planned primary swap. See the [Controlled switchover procedure](#controlled-switchover-procedure) section above for the full script; this recipe demonstrates the verification queries.

```sql
-- Step 4 verification: standby caught up?
SELECT
  application_name,
  pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
FROM pg_stat_replication
WHERE application_name = 'p2';
-- Expect: lag_bytes = 0
-- If non-zero, do NOT proceed — issue pg_switch_wal() and re-check
```

After Step 6 (promotion of P2):

```sql
-- On P2
SELECT pg_is_in_recovery();              -- f
SELECT timeline_id FROM pg_control_checkpoint();  -- new timeline number
SELECT pg_walfile_name(pg_current_wal_lsn());     -- shows new timeline in filename
```

After Step 7 (P1 re-attached as standby):

```sql
-- On P2 (new primary)
SELECT client_addr, application_name, state, sync_state FROM pg_stat_replication;
-- Expect: row for P1 with state = 'streaming'
```

### Recipe 6: `recovery_min_apply_delay` — 1-hour rollback window

Set on a designated standby to keep it 1 hour behind primary for human-error rollback (`DELETE FROM critical_table WHERE accident_id = 42`). Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) Recipe 6.

```sql
-- On the lag-behind standby, in postgresql.conf
recovery_min_apply_delay = '1h'

-- After reload, verify
SHOW recovery_min_apply_delay;
-- 1h

-- Replay LSN should lag receive LSN by ~1h of WAL volume
SELECT
  pg_last_wal_receive_lsn() AS received,
  pg_last_wal_replay_lsn()  AS replayed,
  pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS delay_bytes;
```

To roll back: pause replay, set `recovery_target_time` to just before the accident, restart standby with `recovery_target_action = pause`, query at the rolled-back state, copy out the rows needed, then promote and re-attach the original primary or fail forward.

### Recipe 7: Pause replay for forensics

```sql
-- On standby
SELECT pg_wal_replay_pause();
-- Returns void

-- Wait for actual pause
SELECT pg_get_wal_replay_pause_state();  -- PG14+
-- Expect: 'paused' (after 'pause requested' transient state)

-- Inspect state, run analytical queries, etc.
SELECT count(*) FROM orders WHERE created_at > '2026-05-01';

-- Resume
SELECT pg_wal_replay_resume();
```

> [!WARNING] Standby falls behind during pause
> Replay pause does NOT stop the walreceiver — WAL keeps arriving and gets staged. The standby will catch up after resume. But: if the primary has a replication slot for this standby and `max_slot_wal_keep_size` is undersized, an extended pause can trigger slot invalidation. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md) gotcha #3.

### Recipe 8: Re-attach diverged former primary with pg_rewind

```bash
# On the old primary (P1), after stopping cleanly
pg_ctl stop -D $PGDATA -m fast

# Verify clean shutdown
grep "database system was shut down" $PGDATA/log/*.log | tail -1
# Should show: "database system was shut down at YYYY-MM-DD HH:MM:SS ..."

# Run pg_rewind against the new primary (P2)
pg_rewind \
  --target-pgdata=$PGDATA \
  --source-server="host=p2-host port=5432 user=replication dbname=postgres" \
  --write-recovery-conf \
  --progress

# pg_rewind output:
# servers diverged at WAL location 0/A1B2C3D4 on timeline 1
# rewinding from last common checkpoint at 0/A0F0E0D0 on timeline 1
# reading source file list
# reading target file list
# reading WAL in target
# need to copy 142 MB (total source directory size is 8.7 GB)
# 145623 / 145623 kB (100%) copied
# creating backup label and updating control file
# syncing target data directory
# Done!

# pg_rewind wrote standby.signal + primary_conninfo for us (via --write-recovery-conf)
# Verify
cat $PGDATA/standby.signal       # empty file, presence is the signal
grep primary_conninfo $PGDATA/postgresql.auto.conf
# primary_conninfo = 'host=p2-host port=5432 user=replication dbname=postgres'

# Start P1 as standby of P2
pg_ctl start -D $PGDATA

# Verify
psql -c "SELECT pg_is_in_recovery();"  -- t
# Check on P2
psql -h p2-host -c "SELECT application_name, state FROM pg_stat_replication;"
# row for P1 with state = 'streaming'
```

### Recipe 9: Detect timeline divergence

Symptom: standby reports `requested WAL segment ... has already been removed` or `record with incorrect prev-link`. The standby's timeline doesn't match the primary's anymore. Diagnostic:

```sql
-- On standby
SELECT timeline_id FROM pg_control_checkpoint();
-- e.g., 2

SELECT pg_walfile_name(pg_last_wal_replay_lsn());
-- e.g., 000000020000000300000050
--       ^^^^^^^^
--       Timeline 2

-- On primary
SELECT timeline_id FROM pg_control_checkpoint();
-- e.g., 3 — primary has advanced to timeline 3, standby is on timeline 2
--           (standby was promoted earlier, didn't follow latest, then a NEW primary appeared)

-- Inspect timeline history file for divergence point
\! cat $PGDATA/pg_wal/00000003.history
-- Shows: timeline 3 forked from timeline 2 at 0/AABBCCDD on YYYY-MM-DD
```

Resolution: `pg_rewind` (if requirements met) or fresh `pg_basebackup`.

### Recipe 10: `pg_createsubscriber` for cross-version upgrade

PG16 → PG18 zero-downtime upgrade via physical-standby-to-logical-subscriber conversion. Cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

```bash
# Prerequisites:
# - PG16 primary (P1) with at least one physical streaming standby (P2) caught up
# - P2 running PG18 binaries (binary upgrade via pg_upgrade --link, then revert to standby)
# - wal_level = logical on P1
# - max_replication_slots and max_wal_senders sufficient

# Stop P2 cleanly
pg_ctl stop -D /var/lib/postgresql/18/main -m fast

# Convert
pg_createsubscriber \
  --pgdata=/var/lib/postgresql/18/main \
  --publisher-server="host=p1-host user=replication dbname=app" \
  --subscriber-server="host=localhost user=postgres dbname=app" \
  --database=app \
  --publication=app_pub \
  --subscription=app_sub \
  --enable-two-phase

# pg_createsubscriber starts P2 as a logical subscriber automatically
# Switch traffic from P1 to P2 at convenient time
# Decommission P1 after verification
```

### Recipe 11: Force a WAL switch + verify standby acknowledged

Used during planned switchover to make sure no in-flight WAL is stuck on the primary.

```sql
DO $$
DECLARE
  switch_lsn pg_lsn;
  standby_replay pg_lsn;
  attempts int := 0;
BEGIN
  -- Generate a heartbeat to ensure something to switch
  CREATE TABLE IF NOT EXISTS _switch_heartbeat (ts timestamptz);
  INSERT INTO _switch_heartbeat VALUES (now());

  -- Force WAL switch; pg_switch_wal returns the LSN of the switch boundary
  SELECT pg_switch_wal() INTO switch_lsn;

  RAISE NOTICE 'Switched at LSN %', switch_lsn;

  -- Poll until standby replays past the switch LSN
  LOOP
    SELECT replay_lsn INTO standby_replay
    FROM pg_stat_replication
    WHERE application_name = 'p2'
    LIMIT 1;

    EXIT WHEN standby_replay >= switch_lsn;
    EXIT WHEN attempts >= 30;
    PERFORM pg_sleep(1);
    attempts := attempts + 1;
  END LOOP;

  IF standby_replay < switch_lsn THEN
    RAISE EXCEPTION 'Standby did not catch up within 30s. Current replay: %, target: %',
                    standby_replay, switch_lsn;
  END IF;

  RAISE NOTICE 'Standby caught up to %', standby_replay;
END $$;
```

### Recipe 12: Emergency demotion of a primary (split-brain prevention)

If a network partition has caused a fence event and the old primary needs to be demoted to standby quickly. NOT a substitute for cluster-manager fencing; this is for forensics.

```sql
-- On the suspected old primary
SELECT pg_wal_replay_pause();  -- harmless; only no-ops if not in recovery
-- Note: pg_wal_replay_pause() only works if the server is in recovery.
-- For a misbehaving primary, you must stop it cleanly first.
```

Cleaner approach: stop the postmaster, write `standby.signal`, restart pointing at the new primary:

```bash
pg_ctl stop -D $PGDATA -m fast
touch $PGDATA/standby.signal
echo "primary_conninfo = 'host=new-primary user=replication'" >> $PGDATA/postgresql.auto.conf
# If timelines have diverged, run pg_rewind first
pg_rewind --target-pgdata=$PGDATA --source-server="host=new-primary user=replication"
pg_ctl start -D $PGDATA
```

### Recipe 13: Audit hot standby query rules with EXPLAIN

Verify a query that runs on standby uses no write paths.

```sql
-- On standby
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM big_table;

-- Plan should show:
--   Aggregate
--     -> Seq Scan on big_table  (or Index Only Scan, etc.)
--   No "Insert", "Update", "Delete", "Sequence Scan on pg_sequence", etc.

-- For SELECT FOR UPDATE attempt (forbidden on standby):
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
-- ERROR:  cannot execute SELECT FOR UPDATE in a read-only transaction
```

## Gotchas / Anti-patterns

1. **`promote_trigger_file` removed in PG16.** Pre-PG16 failover scripts that write a file to `$PGDATA/promote_trigger` silently no-op on PG16+. **Migrate to `pg_promote()` or `pg_ctl promote`.** Audit `find /etc /opt /usr/local -name '*.sh' -exec grep -l promote_trigger_file {} \;` before upgrading.

2. **`max_standby_streaming_delay = -1` lets replay lag unbounded.** Production hazard for any standby that takes traffic. The asymmetric defaults (`-1` wait-forever vs `0` immediate-cancel) bite operators who assume they're similar.

3. **`hot_standby_feedback = on` plus an abandoned standby causes unbounded primary bloat.** Standby session leaks → xmin frozen on primary → autovacuum can't reclaim dead tuples cluster-wide. Set `idle_in_transaction_session_timeout` on the standby AND monitor primary `n_dead_tup`.

4. **`pg_promote()` requires `pg_promote` predefined role or superuser.** Not `pg_monitor` or `pg_signal_backend`. PG14+ added `pg_promote` predefined role; grant to monitoring/automation accounts.

5. **`pg_rewind` requires `wal_log_hints = on` OR `data_checksums` at initdb time.** Cannot enable retroactively to "fix" a cluster mid-incident — those settings must have been active BEFORE the divergence. New clusters: enable both at initdb to keep this option available.

6. **`pg_rewind` requires clean shutdown on the target.** A crashed old primary cannot be rewinded directly. Either start it briefly (it will replay its own WAL, reach a consistent state, then stop cleanly), or fall back to `pg_basebackup`.

7. **Timeline divergence happens at every promotion.** Even a "successful" controlled switchover increments the timeline. Standbys following the old primary must use `recovery_target_timeline = 'latest'` (default since PG12) to follow the new primary automatically.

8. **`SERIALIZABLE` is forbidden on hot standby.** Verbatim docs: *"Transactions started during recovery may issue the LISTEN, UNLISTEN, and NOTIFY commands, but these commands will only be effective on the primary."*[^hot-standby] Apps that use SERIALIZABLE for read-only reports must not route to standby OR must downgrade to REPEATABLE READ for reports.

9. **`SELECT FOR UPDATE` is forbidden on hot standby.** Writes row lock to xmax → tuple write → refused. Apps must check `pg_is_in_recovery()` and skip the FOR UPDATE if read-only.

10. **`pg_wal_replay_pause()` does not stop the walreceiver.** WAL keeps arriving and gets staged. Extended pause + small `max_slot_wal_keep_size` → slot invalidation. Use for short-duration forensics only.

11. **`pg_get_wal_replay_pause_state()` is PG14+.** Pre-PG14 use `pg_is_wal_replay_paused()` which returns `true` immediately on pause-request even before replay actually stops — debugging hazard.

12. **`recovery_target_inclusive = true` (default) stops AFTER the target.** If you set `recovery_target_xid = 100`, replay stops AFTER xid 100 commits. Set `recovery_target_inclusive = false` to stop BEFORE.

13. **Multiple `recovery_target_*` cause errors since PG12.** Verbatim: *"recovery_target_timeline, recovery_target_xid, recovery_target_name, recovery_target_lsn, recovery_target_time can only be set to one of these values during recovery."* Pre-PG12 silently used last-specified; PG12+ errors out.[^pg12]

14. **`recovery_target_timeline = 'latest'` is PG12+ default.** Pre-PG12 default was `current`, which silently kept standbys on old timelines after promotion. PG12+ default is correct.

15. **`pg_promote(wait=>false)` returns immediately even if promotion fails.** Caller must poll `pg_is_in_recovery()` afterwards. Default `wait=>true` is safer.

16. **`pg_basebackup -R` writes recovery config to `postgresql.auto.conf`, not `postgresql.conf`.** Settings in `auto.conf` override `postgresql.conf`. After failover, audit `postgresql.auto.conf` for stale `primary_conninfo` entries.

17. **A demoted former primary still has any connection-string SSL/auth credentials.** If primary credentials differ from standby credentials in your infra, re-attaching the former primary as standby may need a credentials swap. Audit pg_hba and connection strings.

18. **`pg_is_in_recovery()` is `true` during PITR too**, not just streaming standbys. App code that branches on this assumes "standby" but might be in PITR recovery. Use `pg_stat_wal_receiver` presence to disambiguate.

19. **`pg_stat_replication.replay_lag` is NULL on idle standby**, not 0. NOT an error. Indicates no recent WAL activity to measure. Check `pg_wal_lsn_diff` instead for absolute lag.

20. **Cascaded standbys cannot satisfy the primary's `synchronous_standby_names`.** Only direct standbys appear in `pg_stat_replication` on the primary. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) gotcha #22.

21. **`recovery_target_action = pause` is the default since PG13.** Pre-PG13 default was `promote`, which auto-promoted the cluster after reaching the target. The current safe default is `pause` so an operator can inspect state before committing.

22. **Standby promotion increments the timeline IMMEDIATELY.** No "are you sure?" prompt. If `pg_promote()` returns `true`, the cluster is on a new timeline. Walking back requires `pg_rewind` against the original primary (if it still exists and is on the old timeline).

23. **`pg_createsubscriber` cannot be undone.** The physical standby becomes a logical subscriber permanently. Backup the physical standby's data dir before running, or run on a dispensable replica.

## See Also

- [`73-streaming-replication.md`](./73-streaming-replication.md) — physical replication setup, `synchronous_standby_names`, `hot_standby_feedback`
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication (publisher/subscriber) and `pg_createsubscriber` use cases
- [`75-replication-slots.md`](./75-replication-slots.md) — slot mechanics, retention, PG17+ failover slots
- [`78-ha-architectures.md`](./78-ha-architectures.md) — cluster-manager patterns (Patroni, repmgr, pg_auto_failover)
- [`79-patroni.md`](./79-patroni.md) — Patroni deep dive for orchestrated failover
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — PITR using `recovery_target_*` settings
- [`89-pg-rewind.md`](./89-pg-rewind.md) — pg_rewind deep dive
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR drills, cross-region failover
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_replication`, `pg_stat_wal_receiver` view reference
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin horizon and how `hot_standby_feedback` propagates it
- [`43-locking.md`](./43-locking.md) — recovery conflict lock types

## Sources

[^hot-standby]: PostgreSQL 16 Hot Standby docs. https://www.postgresql.org/docs/16/hot-standby.html
[^max-standby-delay]: PostgreSQL 16 runtime-config-replication — `max_standby_streaming_delay`, `max_standby_archive_delay`, `hot_standby_feedback`. https://www.postgresql.org/docs/16/runtime-config-replication.html
[^pg-rewind]: PostgreSQL 16 pg_rewind reference — requirements (`wal_log_hints` OR `data_checksums`), source-server vs source-pgdata modes. https://www.postgresql.org/docs/16/app-pgrewind.html
[^pg12]: PostgreSQL 12 release notes. Verbatim: *"Move `recovery.conf` settings into `postgresql.conf` (Masao Fujii, Simon Riggs, Abhijit Menon-Sen, Sergei Kornilov). `recovery.conf` is no longer used, and the server will not start if that file exists. `recovery.signal` and `standby.signal` files are now used to switch into non-primary mode. The `trigger_file` setting has been renamed to `promote_trigger_file`. The `standby_mode` setting has been removed."* https://www.postgresql.org/docs/release/12.0/
[^pg12-promote]: PostgreSQL 12 release notes. Verbatim: *"Add function `pg_promote()` to promote standbys to primaries (Laurenz Albe, Michaël Paquier). Previously, this operation was only possible by using pg_ctl or creating a trigger file."* https://www.postgresql.org/docs/release/12.0/
[^pg13-pause-promote]: PostgreSQL 13 release notes. Verbatim: *"Allow standby promotion to cancel any requested pause (Fujii Masao). Previously, promotion could not happen while the standby was in paused state."* https://www.postgresql.org/docs/release/13.0/
[^pg13-recovery-target]: PostgreSQL 13 release notes. Verbatim: *"Generate an error if recovery does not reach the specified recovery target (Leif Gunnar Erlandsen, Peter Eisentraut). Previously, a standby would promote itself upon reaching the end of WAL, even if the target was not reached."* https://www.postgresql.org/docs/release/13.0/
[^pg13-rewind-crash]: PostgreSQL 13 release notes. Verbatim: *"Have pg_rewind automatically run crash recovery before rewinding (Paul Guo, Jimmy Yih, Ashwin Agrawal). This can be disabled by using `--no-ensure-shutdown`."* https://www.postgresql.org/docs/release/13.0/
[^pg13-rewind-restore]: PostgreSQL 13 release notes. Verbatim: *"Allow pg_rewind to use the target cluster's `restore_command` to retrieve needed WAL (Alexey Kondratov). This is enabled using the `-c`/`--restore-target-wal` option."* https://www.postgresql.org/docs/release/13.0/
[^pg13-rewind-conf]: PostgreSQL 13 release notes. Verbatim: *"Add an option to pg_rewind to configure standbys (Paul Guo, Jimmy Yih, Ashwin Agrawal). This matches pg_basebackup's `--write-recovery-conf` option."* https://www.postgresql.org/docs/release/13.0/
[^pg14-pause-state]: PostgreSQL 14 release notes. Verbatim: *"Add function `pg_get_wal_replay_pause_state()` to report the recovery state (Dilip Kumar). It gives more detailed information than `pg_is_wal_replay_paused()`, which still exists."* https://www.postgresql.org/docs/release/14.0/
[^pg14-in-hot-standby]: PostgreSQL 14 release notes. Verbatim: *"Add new read-only server parameter in_hot_standby (Haribabu Kommi, Greg Nancarrow, Tom Lane). This allows clients to easily detect whether they are connected to a hot standby server."* https://www.postgresql.org/docs/release/14.0/
[^pg14-log-recovery-conflict]: PostgreSQL 14 release notes. Verbatim: *"Add server parameter `log_recovery_conflict_waits` to report long recovery conflict wait times (Bertrand Drouvot, Masahiko Sawada)."* https://www.postgresql.org/docs/release/14.0/
[^pg14-syncfs]: PostgreSQL 14 release notes. Verbatim: *"Add file system sync at the start of crash recovery on Linux (Thomas Munro). By default, PostgreSQL opens and fsyncs each data file in the database cluster at the start of crash recovery. A new setting, `recovery_init_sync_method=syncfs`, instead syncs each filesystem used by the cluster."* https://www.postgresql.org/docs/release/14.0/
[^pg14-restore-command-reload]: PostgreSQL 14 release notes. Verbatim: *"Allow the `restore_command` setting to be changed during a server reload (Sergei Kornilov). You can also set restore_command to an empty string and reload to force recovery to only read from the pg_wal directory."* https://www.postgresql.org/docs/release/14.0/
[^pg14-param-mismatch]: PostgreSQL 14 release notes. Verbatim: *"Pause recovery on a hot standby server if the primary changes its parameters in a way that prevents replay on the standby (Peter Eisentraut). Previously the standby would shut down immediately."* https://www.postgresql.org/docs/release/14.0/
[^pg16-promote]: PostgreSQL 16 release notes. Verbatim: *"Remove server variable `promote_trigger_file` (Simon Riggs). This was used to promote a standby to primary, but is now more easily accomplished with `pg_ctl promote` or `pg_promote()`."* https://www.postgresql.org/docs/release/16.0/
[^pg17-createsubscriber]: PostgreSQL 17 release notes. Verbatim: *"Add application pg_createsubscriber to create a logical replica from a physical standby server (Euler Taveira)."* https://www.postgresql.org/docs/release/17.0/
[^pg18-rewind-dbname]: PostgreSQL 18 release notes. Verbatim: *"If pg_rewind's `--source-server` specifies a database name, use it in `--write-recovery-conf` output (Masahiko Sawada)."* https://www.postgresql.org/docs/release/18.0/

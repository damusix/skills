# PostgreSQL Skill Cookbook

Capstone synthesis. Recipes that span multiple reference files — each one is a complete investigation or remediation playbook with copy-paste-ready SQL, the catalog joins behind it, and cross-references to the per-topic deep dives. Catalog Exploration section at the bottom answers the ten most common "what's happening right now on this cluster" questions via `pg_catalog`.

This file is meant to be loaded **first** when a user reports a symptom (slow query, bloat, lag, deadlock, upgrade question) — it routes the investigation across files and gives the SQL to start with.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Recipes](#recipes)
    - [Recipe 1 — Index Decision Flowchart](#recipe-1--index-decision-flowchart)
    - [Recipe 2 — Locking + Deadlock Investigation](#recipe-2--locking--deadlock-investigation)
    - [Recipe 3 — VACUUM Bloat Triage](#recipe-3--vacuum-bloat-triage)
    - [Recipe 4 — Replication Lag Investigation](#recipe-4--replication-lag-investigation)
    - [Recipe 5 — PITR Recovery Walkthrough](#recipe-5--pitr-recovery-walkthrough)
    - [Recipe 6 — Major Version Upgrade Playbook](#recipe-6--major-version-upgrade-playbook)
    - [Recipe 7 — Slow Query Investigation](#recipe-7--slow-query-investigation)
    - [Recipe 8 — Autovacuum Tuning](#recipe-8--autovacuum-tuning)
    - [Recipe 9 — Connection Storm Response](#recipe-9--connection-storm-response)
    - [Recipe 10 — Partition Rotation Automation](#recipe-10--partition-rotation-automation)
    - [Recipe 11 — DDL with Shorter Blocking Windows](#recipe-11--ddl-with-shorter-blocking-windows)
    - [Recipe 12 — Role Inventory + Cleanup](#recipe-12--role-inventory--cleanup)
- [Catalog Exploration](#catalog-exploration)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when:

- User reports a symptom but is unsure which reference applies ("queries got slow last Tuesday")
- A diagnostic spans multiple files (a deadlock involves [`43-locking.md`](./43-locking.md) + [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) + [`27-mvcc-internals.md`](./27-mvcc-internals.md))
- You need a copy-paste-ready SQL recipe rather than a deep-mechanics explanation
- A user asks "how do I check X on a running cluster" — Catalog Exploration section is the canonical answer

Do NOT use when:

- You need full mechanics of one feature → go to that feature's reference file
- You need version-by-version timeline of one feature → go to that feature's reference file
- You need a fresh-cluster setup checklist → most relevant: [`53-server-configuration.md`](./53-server-configuration.md) + [`54-memory-tuning.md`](./54-memory-tuning.md) + [`82-monitoring.md`](./82-monitoring.md) + [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md)

## Mental Model

Five rules:

1. **Recipes here are entry points, not full references.** Every recipe cross-references the deep-dive file(s) for the underlying mechanics. Do not stop at the SQL — read why it works.

2. **Symptom-driven investigation is the canonical path.** Users almost never say "I have an autovacuum scale-factor problem." They say "deletes got slow." Start from the symptom, narrow via Catalog Exploration, end at the deep-dive file.

3. **Most diagnostics span 2-4 files.** A slow query investigation pulls in [`56-explain.md`](./56-explain.md) (plan analysis) + [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) (workload-wide) + [`55-statistics-planner.md`](./55-statistics-planner.md) (estimates) + [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) (live state). A replication problem pulls in [`73-streaming-replication.md`](./73-streaming-replication.md) + [`75-replication-slots.md`](./75-replication-slots.md) + [`82-monitoring.md`](./82-monitoring.md).

4. **Copy-paste-ready SQL with interpretation notes.** Every recipe gives the SQL, then explains what each interpretation rule means and points at remediation. The SQL is meant to be runnable on PG16+ without modification — version-specific columns are flagged.

5. **`pg_catalog` is the cluster's introspection surface.** Catalog Exploration section walks through using catalog joins to answer the ten most common runtime questions. Internalize the four canonical joins (`pg_class` ↔ `pg_namespace`, `pg_class` ↔ `pg_attribute`, `pg_class` ↔ `pg_index`, `pg_class` ↔ `pg_stat_user_tables`) and almost any diagnostic falls out.

## Decision Matrix

| Symptom / Question | Start here | Then |
|---|---|---|
| Query is slow | Recipe 7 (Slow Query Investigation) | [`56-explain.md`](./56-explain.md) + [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) |
| Table is bloated / dead-tuple-heavy | Recipe 3 (VACUUM Bloat Triage) | [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) + [`27-mvcc-internals.md`](./27-mvcc-internals.md) |
| Sessions are blocked | Recipe 2 (Locking + Deadlock Investigation) | [`43-locking.md`](./43-locking.md) + [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) |
| Replica is falling behind | Recipe 4 (Replication Lag Investigation) | [`73-streaming-replication.md`](./73-streaming-replication.md) + [`75-replication-slots.md`](./75-replication-slots.md) |
| Need to recover to a specific time | Recipe 5 (PITR Recovery) | [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) + [`90-disaster-recovery.md`](./90-disaster-recovery.md) |
| Need to upgrade a major version | Recipe 6 (Upgrade Playbook) | [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) + [`86-pg-upgrade.md`](./86-pg-upgrade.md) |
| Autovacuum can't keep up | Recipe 8 (Autovacuum Tuning) | [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) + [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) |
| "too many connections" errors | Recipe 9 (Connection Storm) | [`80-connection-pooling.md`](./80-connection-pooling.md) + [`81-pgbouncer.md`](./81-pgbouncer.md) |
| Picking the right index | Recipe 1 (Index Decision Flowchart) | [`22-indexes-overview.md`](./22-indexes-overview.md) |
| Adding/changing schema online | Recipe 11 (DDL with Shorter Blocking Windows) | [`26-index-maintenance.md`](./26-index-maintenance.md) + [`37-constraints.md`](./37-constraints.md) |
| Need to rotate partitions | Recipe 10 (Partition Rotation) | [`35-partitioning.md`](./35-partitioning.md) + [`99-pg-partman.md`](./99-pg-partman.md) + [`98-pg-cron.md`](./98-pg-cron.md) |
| Need to drop a role / clean orphans | Recipe 12 (Role Inventory) | [`46-roles-privileges.md`](./46-roles-privileges.md) |
| What's running right now | Catalog Exploration §1 | [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) |
| What's eating disk | Catalog Exploration §2 | [`64-system-catalogs.md`](./64-system-catalogs.md) |
| Which extensions are installed | Catalog Exploration §9 | [`69-extensions.md`](./69-extensions.md) |

## Recipes

### Recipe 1 — Index Decision Flowchart

Most "should I add an index" questions resolve by walking the predicate shape against the seven access methods. Cross-ref [`22-indexes-overview.md`](./22-indexes-overview.md), [`23-btree-indexes.md`](./23-btree-indexes.md), [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md), [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md).

| Predicate shape | Index | Notes |
|---|---|---|
| `WHERE col = ?` / `IN (...)` / `<` / `>` / `BETWEEN` / `IS NULL` / `ORDER BY col` / `LIKE 'foo%'` under C locale | B-tree | Default. Always start here. |
| `LIKE 'foo%'` under non-C locale | B-tree with `text_pattern_ops` opclass | Default opclass uses collation, can't satisfy prefix match |
| `LIKE '%foo%'` / `ILIKE '%foo%'` / `~ 'regex'` | GIN with `gin_trgm_ops` (pg_trgm extension) | Cross-ref [`93-pg-trgm.md`](./93-pg-trgm.md) |
| `WHERE jsonb_col @> '{...}'` / `?` / `?&` / `?\|` | GIN `jsonb_ops`; consider `jsonb_path_ops` for supported containment/jsonpath predicates only | `jsonb_path_ops` does not support the key-existence operators |
| `WHERE array_col @> ARRAY[...]` / `&&` / `<@` | GIN with `array_ops` | Cross-ref [`16-arrays.md`](./16-arrays.md) |
| Full-text `tsvector @@ tsquery` | GIN with `tsvector_ops` | GiST also possible, slower reads, smaller |
| `range_col @> point` / `&&` / `<<` | GiST or SP-GiST with `range_ops` | Cross-ref [`15-data-types-custom.md`](./15-data-types-custom.md) |
| `ORDER BY point <-> ref_point LIMIT N` (KNN nearest-neighbor) | GiST or SP-GiST | Cross-ref [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) |
| `ORDER BY vec <=> '[...]' LIMIT N` (nearest cosine distance) | HNSW or IVFFlat with the matching pgvector operator class | A distance predicate alone does not provide the ordered nearest-neighbor index path |
| `WHERE created_at >= ?` on append-only correlated time-series | BRIN minmax | Verify `pg_stats.correlation > 0.9` first |
| Arbitrary AND-of-equalities across many columns | Bloom (contrib extension) | Lossy, equality-only |
| `EXCLUDE USING gist (room WITH =, period WITH &&)` | GiST exclusion constraint + btree_gist | Cross-ref [`37-constraints.md`](./37-constraints.md) |

**Three pre-flight checks before adding any index:**

1. Does the query actually run often enough to matter? Check `pg_stat_statements.calls`:
    ```sql
    SELECT queryid, calls, mean_exec_time, total_exec_time/1000 AS total_sec
    FROM pg_stat_statements WHERE query ILIKE '%my_table%' ORDER BY total_exec_time DESC LIMIT 10;
    ```
2. Is the column selective enough? Check `pg_stats.n_distinct` and `pg_stats.most_common_vals`:
    ```sql
    SELECT attname, n_distinct, most_common_vals, most_common_freqs
    FROM pg_stats WHERE schemaname='public' AND tablename='my_table';
    ```
3. Will it conflict with HOT updates? Indexes on hot-update columns kill HOT and cause index bloat. Cross-ref [`30-hot-updates.md`](./30-hot-updates.md).

**Build the index online:**

```sql
CREATE INDEX CONCURRENTLY my_table_col_idx ON my_table (col);
-- Verify it's valid + ready
SELECT indexrelid::regclass, indisvalid, indisready FROM pg_index WHERE indrelid='my_table'::regclass;
```

If `indisvalid = false`, the build failed mid-flight. Drop the invalid index and retry. Cross-ref [`26-index-maintenance.md`](./26-index-maintenance.md).

### Recipe 2 — Locking + Deadlock Investigation

When sessions block each other. Cross-ref [`43-locking.md`](./43-locking.md), [`44-advisory-locks.md`](./44-advisory-locks.md), [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

**Step 1 — Who is blocked, who is blocking:**

```sql
SELECT
  blocked.pid           AS blocked_pid,
  blocked.usename       AS blocked_user,
  age(now(), blocked.xact_start)  AS blocked_xact_age,
  blocked.wait_event_type || '/' || blocked.wait_event AS wait,
  blockers.pid          AS blocker_pid,
  blocker.usename       AS blocker_user,
  blocker.state         AS blocker_state,
  age(now(), blocker.xact_start)  AS blocker_xact_age,
  left(blocked.query, 120) AS blocked_query,
  left(blocker.query, 120) AS blocker_query
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blockers(pid) ON true
LEFT JOIN pg_stat_activity blocker ON blocker.pid = blockers.pid
WHERE blocked.wait_event_type = 'Lock'
ORDER BY blocked_xact_age DESC;
```

PID `0` represents a blocking prepared transaction, which has no `pg_stat_activity` row; inspect `pg_prepared_xacts` and `pg_locks` separately. Duplicate client PIDs can arise from parallel workers.[^blocking-pids]

**Step 2 — Which lock modes are involved:**

```sql
SELECT
  pid, locktype, relation::regclass AS table, mode, granted, fastpath,
  waitstart  -- PG14+
FROM pg_locks
WHERE pid IN (12345, 12346)  -- pids from step 1
ORDER BY pid, granted DESC;
```

Lock-mode conflict matrix is the canonical decoder. `ACCESS EXCLUSIVE` (held by `ALTER TABLE`, `DROP`, `TRUNCATE`, `VACUUM FULL`, `CLUSTER`) blocks everything. `ROW EXCLUSIVE` (held by DML) blocks only `SHARE`/`SHARE ROW EXCLUSIVE`/`EXCLUSIVE`/`ACCESS EXCLUSIVE`.

**Step 3 — Diagnose pattern:**

| Symptom | Likely cause | Fix |
|---|---|---|
| Many backends waiting on `Lock/relation` of one table | One backend holds `ACCESS EXCLUSIVE` (DDL) | Find the DDL backend, finish or cancel |
| Many backends waiting on `Lock/transactionid` of one txid | Long-running transaction holding row locks | Find the long-running backend, cancel or wait |
| Recurring `Lock/tuple` waits | UPDATE contention on hot rows | Refactor: queue / advisory locks / `SKIP LOCKED` |
| Lock wait during `CREATE INDEX CONCURRENTLY` and `ANALYZE` | Their `SHARE UPDATE EXCLUSIVE` locks conflict; `ACCESS SHARE` itself does not conflict with that mode | Inspect the actual held and requested locks |
| Deadlock detected (40P01) | Inconsistent lock-acquisition order across sessions | Order locks deterministically; cross-ref [`43-locking.md`](./43-locking.md) Recipe 7 |

**Step 4 — Kill safely:**

```sql
-- Try graceful cancel first (interrupts current statement, transaction stays open)
SELECT pg_cancel_backend(12345);

-- If that fails, terminate (closes the connection — DON'T run on walsenders / logical-replication apply workers)
SELECT pg_terminate_backend(12345);
```

Check `backend_type` before signaling a PID. Terminating replication workers interrupts service and can force reconnects; do it only as a deliberate replication intervention, not generic query cleanup.

### Recipe 3 — VACUUM Bloat Triage

Six-step decision tree when a table looks bloated. Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md), [`27-mvcc-internals.md`](./27-mvcc-internals.md), [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

**Step 1 — Inspect dead-tuple estimates and relation sizes:**

```sql
SELECT
  n.nspname AS schema, c.relname AS table,
  c.reltuples::bigint AS live_estimate,
  s.n_dead_tup        AS dead_tuples,
  round(100.0 * s.n_dead_tup / NULLIF(c.reltuples::numeric, 0), 1) AS dead_pct,
  pg_size_pretty(pg_relation_size(c.oid))            AS heap_size,
  pg_size_pretty(pg_total_relation_size(c.oid))      AS total_size,
  s.last_autovacuum,
  s.last_vacuum
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p') AND c.reltuples > 10000
ORDER BY dead_pct DESC NULLS LAST LIMIT 20;
```

`dead_pct` is a ratio of estimated dead tuples to estimated live tuples, not the percentage of wasted bytes. Investigate its trend together with vacuum progress, reuse, and relation growth; no fixed ratio proves severe bloat.

**Step 2 — Is a retained horizon preventing cleanup?**

```sql
SELECT 'backend' AS source, pid, usename::text AS owner,
       now() - xact_start AS elapsed,
       greatest(age(backend_xid), age(backend_xmin)) AS xid_age,
       state, left(query, 120) AS detail
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL OR backend_xmin IS NOT NULL
UNION ALL
SELECT 'slot', NULL::int, slot_name::text, NULL::interval,
       greatest(age(xmin), age(catalog_xmin)),
       'active=' || active::text, slot_name::text
FROM pg_replication_slots
WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL
UNION ALL
SELECT 'prepared', NULL::int, owner::text, now() - prepared,
       age(transaction), 'prepared', gid
FROM pg_prepared_xacts
ORDER BY xid_age DESC NULLS LAST;
```

An old retained XID can prevent cleanup of tuples still needed by that horizon; there is no universal one-million-XID cutoff. Inspect the affected relations and resolve blockers with their owners. Do not decide a prepared transaction's commit/rollback outcome without its coordinator, or drop a live consumer's slot without accepting rebuild consequences.

**Step 3 — Is autovacuum running but slow?**

```sql
SELECT
  v.pid, a.datname, v.relid::regclass AS table, v.phase,
  pg_size_pretty(v.heap_blks_total::bigint * current_setting('block_size')::int) AS heap_total,
  pg_size_pretty(v.heap_blks_scanned::bigint * current_setting('block_size')::int) AS heap_scanned,
  v.index_vacuum_count,
  v.num_dead_tuples   -- PG16; use num_dead_item_ids on PG17+
FROM pg_stat_progress_vacuum v
JOIN pg_stat_activity a USING (pid);
```

Repeated index-vacuum cycles can indicate an undersized dead-item store. PG16 and earlier cap that store at 1GB whatever the memory setting; PG17+ has no cap. Budget memory before changing `maintenance_work_mem` (manual VACUUM) or `autovacuum_work_mem` (autovacuum); there is no per-table memory override.

**Step 4 — Is autovacuum being canceled?** Temporarily enable `log_autovacuum_min_duration = 0` and inspect cancellation logs. Anti-wraparound autovacuum is not automatically canceled by conflicting lock requests, but can still be explicitly canceled.

**Step 5 — Manual VACUUM with diagnostics:**

```sql
VACUUM (VERBOSE, ANALYZE, PARALLEL 4) my_table;
```

Read the `tuples: NN removed` line. If `removed = 0` despite high `n_dead_tup`, the horizon is held back (return to Step 2).

**Step 6 — If table is bloated but VACUUM is healthy** (e.g., one-time historical bloat from before a tuning fix): use `pg_repack` for online table rewrite, NOT `VACUUM FULL` (which takes `ACCESS EXCLUSIVE` for hours). Cross-ref [`26-index-maintenance.md`](./26-index-maintenance.md) recipe 12.

### Recipe 4 — Replication Lag Investigation

Four-stage lag breakdown. Cross-ref [`73-streaming-replication.md`](./73-streaming-replication.md), [`75-replication-slots.md`](./75-replication-slots.md), [`77-standby-failover.md`](./77-standby-failover.md).

**Step 1 — Where is the lag?**

```sql
-- Run on primary
SELECT
  application_name,
  client_addr,
  state,
  sync_state,
  pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)    AS pending_bytes,
  pg_wal_lsn_diff(sent_lsn, write_lsn)               AS write_lag_bytes,
  pg_wal_lsn_diff(write_lsn, flush_lsn)              AS flush_lag_bytes,
  pg_wal_lsn_diff(flush_lsn, replay_lsn)             AS replay_lag_bytes,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS total_lag,
  write_lag, flush_lag, replay_lag
FROM pg_stat_replication
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) DESC NULLS LAST;
```

The byte differences show the current backlog between reported positions. `write_lag`, `flush_lag`, and `replay_lag` instead measure recent commit acknowledgment delays at those stages, not the time needed to clear the current backlog. They can remain nonzero briefly on an idle, caught-up system and then become NULL.

| Stage with the lag | Likely cause |
|---|---|
| `pending_bytes` large | WAL generation exceeds sender/network throughput, or the receiver is stalled |
| `write_lag_bytes` large | Network, receiver scheduling, or standby write throughput |
| `flush_lag_bytes` large | Standby durable-flush throughput |
| `replay_lag_bytes` large | Replay throughput, recovery conflicts, configured delay, or paused recovery; inspect standby logs and state |

**Step 2 — Replication slots:**

```sql
SELECT
  slot_name, slot_type, database, active, wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

On PG17+, optionally add `inactive_since` and `invalidation_reason`. `lost` means the slot is unusable. `unreserved` means needed WAL is no longer protected by that slot and may be removed at the next checkpoint; it does not prove the files are already absent. `extended` means retained WAL exceeds `max_wal_size` but the slot or `wal_keep_size` still keeps it. Check archives and the recovery procedure before rebuilding.

**Step 3 — Replay blocked by standby query?**

```sql
-- On standby
SELECT
  pid, usename, state, wait_event_type, wait_event,
  age(now(), xact_start) AS xact_age,
  left(query, 120) AS query
FROM pg_stat_activity
WHERE wait_event = 'RecoveryConflictSnapshot'
   OR backend_xmin IS NOT NULL
ORDER BY xact_age DESC;
```

If `hot_standby_feedback = on`, long-running standby queries hold xmin back on **primary**, blocking VACUUM cluster-wide. Cross-ref [`27-mvcc-internals.md`](./27-mvcc-internals.md) gotcha #5.

**Step 4 — Verify standby is actually a standby:**

```sql
SELECT pg_is_in_recovery();         -- t = standby, f = primary
SELECT pg_last_wal_replay_lsn();    -- standby only
SELECT pg_last_wal_receive_lsn();   -- standby only
-- On the primary only: SELECT pg_current_wal_lsn();
```

A node expected to be a standby that returns `false` needs topology investigation. This alone does not prove split brain; split brain requires conflicting writable primaries.

### Recipe 5 — PITR Recovery Walkthrough

Eight-step recovery to a specific point in time. Cross-ref [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md), [`85-backup-tools.md`](./85-backup-tools.md), [`90-disaster-recovery.md`](./90-disaster-recovery.md).

The paths below illustrate a PG18 source backup, not a cross-major restore. Use binaries matching the source major and explicitly target the isolated recovery instance for every command. Prevent application access and production archive writes until recovery is validated.

1. `wal_level = replica` (or `logical`) on the source cluster, NOT `minimal`.
2. `archive_mode = on` and `archive_command` (or `archive_library`, PG15+) configured.
3. A completed base backup whose recovery-consistency point precedes the desired target.
4. An unbroken WAL archive from that backup through the target, plus any required timeline history.

**The eight-step recovery:**

```bash
# 1. Stop application traffic and select the recovery target.
set -euo pipefail
RECOVERY_TARGET='2026-05-14 03:42:17+00'

# 2. Provision a fresh host (do NOT recover in place — preserve evidence)
# 3. Install matching PG major version
# This example uses PostgreSQL 18 binaries and an isolated recovery endpoint.
RECOVERY_SOCKET=$(mktemp -d /tmp/pg-recovery.XXXXXX)
RECOVERY_PORT=5433

# 4. Restore base backup
# --archive-mode=off keeps the recovered cluster from pushing its new timeline
# into the production repository after promotion.
pgbackrest --stanza=main --pg1-path=/var/lib/postgresql/18/data \
  --type=time --target="$RECOVERY_TARGET" --target-action=pause \
  --archive-mode=off restore

# 5. Inspect pgBackRest's generated recovery configuration before startup.
# Confirm restore_command, the time target, target-action=pause, and recovery.signal.
# Resolve any inherited recovery-target selectors or standby.signal first.

# 6. Start with no TCP listener and a private Unix socket.
pg_ctl -D /var/lib/postgresql/18/data \
  -o "-k $RECOVERY_SOCKET -p $RECOVERY_PORT -c listen_addresses='' -c archive_mode=off" start

# 7. Verify before promoting
psql -h "$RECOVERY_SOCKET" -p "$RECOVERY_PORT" -d postgres \
  -c "SELECT pg_last_wal_replay_lsn(), pg_is_in_recovery(), pg_get_wal_replay_pause_state();"
psql -h "$RECOVERY_SOCKET" -p "$RECOVERY_PORT" -d mydb \
  -c "SELECT count(*) FROM critical_table WHERE created_at < '$RECOVERY_TARGET';"
# If an earlier target is needed, restore the base backup again; replay cannot go backward.
# A later target can be configured after shutdown and resumed on restart.

# 8. Only after the target is reached, replay is paused, and data is validated:
psql -h "$RECOVERY_SOCKET" -p "$RECOVERY_PORT" -d postgres \
  -c "SELECT pg_wal_replay_resume();"
# At a reached recovery target with action=pause, resume ends recovery.
```

**Critical rules:**

- `recovery_target_inclusive = on` (default) stops **after** the target transaction. Set to `off` to stop **before**.
- `recovery_target_action = 'pause'` (default since PG13) lets you verify. `promote` auto-promotes (risky — you can't go back). `shutdown` lets you inspect offline.
- Only one target selector (`recovery_target`, `_time`, `_xid`, `_lsn`, or `_name`) may be set. Modifiers such as `recovery_target_action`, `_inclusive`, and `_timeline` may accompany it.
- `recovery.conf` was removed in PG12 — use `postgresql.conf` / `postgresql.auto.conf` + `recovery.signal` / `standby.signal`.

Cross-ref [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) for full grammar; [`89-pg-rewind.md`](./89-pg-rewind.md) if the old primary needs to rejoin as standby.

### Recipe 6 — Major Version Upgrade Playbook

Four strategies, decision-tree first. Cross-ref [`87-major-version-upgrade.md`](./87-major-version-upgrade.md), [`86-pg-upgrade.md`](./86-pg-upgrade.md), [`100-pg-versions-features.md`](./100-pg-versions-features.md).

**Strategy decision tree:**

| Constraint | Pick |
|---|---|
| Cluster < 100GB, downtime budget > 1 hour | `pg_dump` + `pg_restore` (simplest, cross-version-safe) |
| Cluster > 100GB, downtime budget ~10-30 min | `pg_upgrade --link` (in-place, near-zero copy) |
| Downtime budget < 5 min | Logical replication (blue-green via subscriber) |
| Seed a logical subscriber from an existing physical standby | See `pg_createsubscriber` in reference 87; conversion requires the same major, with any major upgrade as a separate step |

**Pre-upgrade audit (run on source cluster):**

```sql
-- 1. Extension inventory + version status
SELECT e.extname, e.extversion, av.default_version,
       CASE WHEN e.extversion != av.default_version THEN 'UPGRADE AVAILABLE' ELSE 'CURRENT' END AS status
FROM pg_extension e
JOIN pg_available_extensions av ON av.name = e.extname
WHERE e.extname != 'plpgsql'
ORDER BY status, e.extname;

-- 2. Tables with deprecated/removed types (e.g., abstime/reltime/tinterval gone in PG12)
SELECT format('%I.%I.%I', n.nspname, c.relname, a.attname) AS column,
       format_type(a.atttypid, a.atttypmod) AS type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE NOT a.attisdropped AND a.attnum > 0
  AND t.typname IN ('abstime', 'reltime', 'tinterval', 'unknown')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');

-- 3. Permissions / roles audit
SELECT rolname, rolsuper, rolreplication, rolbypassrls
FROM pg_roles WHERE NOT rolname LIKE 'pg_%' ORDER BY rolname;
```

Initialize the new cluster with compatible locale and checksum settings and install matching extension binaries first. PG18 `initdb` enables data checksums by default, and `pg_upgrade` requires both clusters to match, so pass `--no-data-checksums` when the PG16 source has checksums off. Preserve a tested independent backup. With `--link`, starting the new cluster changes shared files and makes the old cluster unsafe to start; prefer `--clone` where supported if an independent old copy is needed.

**pg_upgrade --link workflow:**

```bash
# 1. Run --check on a clone to validate
/usr/lib/postgresql/18/bin/pg_upgrade \
  --old-datadir=/var/lib/postgresql/16/main \
  --new-datadir=/var/lib/postgresql/18/main \
  --old-bindir=/usr/lib/postgresql/16/bin \
  --new-bindir=/usr/lib/postgresql/18/bin \
  --check --link

# 2. Stop both clusters
pg_ctlcluster 16 main stop
pg_ctlcluster 18 main stop

# 3. Actual upgrade
/usr/lib/postgresql/18/bin/pg_upgrade \
  --old-datadir=/var/lib/postgresql/16/main \
  --new-datadir=/var/lib/postgresql/18/main \
  --old-bindir=/usr/lib/postgresql/16/bin \
  --new-bindir=/usr/lib/postgresql/18/bin --link

# 4. Start new cluster
pg_ctlcluster 18 main start

# 5. Follow pg_upgrade's post-upgrade instructions.
# This example upgrades to PG18; transferred planner statistics are not complete.
vacuumdb --all --analyze-in-stages --missing-stats-only --jobs=4
vacuumdb --all --analyze-only --jobs=4
```

**Post-upgrade checks (cross-ref [`100-pg-versions-features.md`](./100-pg-versions-features.md) for per-version GUC changes):**

```sql
-- Connection params + auth still working?
SELECT version(), current_setting('server_version_num');

-- Inspect replication slots; preservation depends on slot type and upgrade prerequisites.
SELECT slot_name, slot_type, active FROM pg_replication_slots;

-- Extensions match new cluster?
SELECT extname, extversion FROM pg_extension;
```

### Recipe 7 — Slow Query Investigation

Six-step debugging walk. Cross-ref [`56-explain.md`](./56-explain.md), [`57-pg-stat-statements.md`](./57-pg-stat-statements.md), [`55-statistics-planner.md`](./55-statistics-planner.md), [`58-performance-diagnostics.md`](./58-performance-diagnostics.md).

**Step 1 — Is this one slow query or workload-wide slowness?**

```sql
-- Workload-wide: top queries by total time
SELECT
  queryid,
  calls,
  round(mean_exec_time::numeric, 2)  AS mean_ms,
  round(total_exec_time::numeric / 1000, 2) AS total_sec,
  round(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct,
  left(query, 100) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 20;
```

If one query dominates, focus there. If many small queries dominate, the issue is likely poor cache hit ratio or connection-pool / lock contention (Recipe 9).

**Step 2 — Get a representative plan:**

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS) <the slow query>;
```

`EXPLAIN ANALYZE` executes the statement. `BEGIN` followed by `ROLLBACK` can undo transactional table changes, but does not prevent locks, sequence consumption, trigger execution, or external effects. Use a disposable clone for statements with irreversible effects. PG18+ includes `BUFFERS` output in `EXPLAIN ANALYZE` by default.

**Step 3 — Read the plan tree from inputs toward parents.**

Compare `actual rows` per loop with estimated `rows` per invocation; multiply actual rows by `loops` only when calculating total work. A 10× mismatch is an investigation heuristic, not proof of a root cause. LIMIT, early-stopped join inputs, and unexecuted nodes can produce apparent mismatches without bad estimates. Execution is demand-driven, not a strict deepest-node-first schedule.[^using-explain]

| Symptom | Likely cause | Fix |
|---|---|---|
| Misestimate on a single column | Stale statistics | `ANALYZE table` |
| Misestimate on `WHERE a AND b` | Correlated columns, planner assumes independence | `CREATE STATISTICS (mcv, dependencies) ON a, b FROM table` |
| Misestimate on `WHERE lower(email)` | No stats on expression | Functional index on `lower(email)` or extended-stats on expression PG14+ |
| `actual rows = 1` everywhere from a `LIMIT 1` | Planner expected uniform distribution | Cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md) gotcha "LIMIT 1 collapse" |
| Generic-vs-custom plan flip (prepared statement) | Parameter skew | `SET plan_cache_mode = force_custom_plan;` cross-ref [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) |

**Step 4 — Buffer reads:**

`shared read` counts pages read into PostgreSQL buffers; those reads may be served from the OS cache, so they do not prove physical-disk I/O. `shared hit` means a PostgreSQL buffer hit. Temporary reads/writes can indicate spill; confirm the responsible sort or hash before increasing per-operation memory.

**Step 5 — Check whether the access method fits the workload:**

A sequential scan can be optimal for a small table or a query returning many rows even when an index exists. A residual filter can suggest a different key or partial predicate; adding an `INCLUDE` column alone does not make that filter an index search condition.[^using-explain]

**Step 6 — Try a fix in a session, verify:**

```sql
BEGIN;
SET LOCAL work_mem = '256MB';
SET LOCAL random_page_cost = 1.1;
SET LOCAL plan_cache_mode = force_custom_plan;
EXPLAIN (ANALYZE, BUFFERS) <the slow query>;
ROLLBACK;
```

If a SET LOCAL fixes it, apply per-role (`ALTER ROLE webapp SET random_page_cost = 1.1`) rather than cluster-wide. Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md).

### Recipe 8 — Autovacuum Tuning

When defaults (20% scale factor) aren't aggressive enough. Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md), [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

**Step 1 — Identify hot tables that autovacuum can't keep up with:**

```sql
WITH stats AS (
  SELECT
    n.nspname || '.' || c.relname AS table,
    c.reltuples::bigint AS approx_rows,
    s.n_dead_tup,
    s.n_live_tup,
    s.last_autovacuum,
    s.last_autoanalyze,
    s.autovacuum_count,
    age(now(), s.last_autovacuum) AS time_since_av,
    round(100.0 * s.n_dead_tup / NULLIF(s.n_live_tup, 0), 1) AS dead_pct
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relkind IN ('r', 'p')
)
SELECT * FROM stats
WHERE dead_pct > 10 AND approx_rows > 100000
ORDER BY dead_pct DESC;
```

**Step 2 — Per-table tuning (10x more aggressive than defaults):**

```sql
ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor = 0.02,    -- vacuum when 2% dead (vs 20% default)
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 500,
  autovacuum_vacuum_cost_delay = 2,         -- ms per cost-cycle (lower = faster)
  autovacuum_vacuum_cost_limit = 2000       -- example; budget total I/O first
);
```

`autovacuum_naptime` is a cluster configuration setting, not a table storage parameter. Tune it separately only when launcher scheduling, rather than worker capacity or blockers, is the limiting factor.

Per-table overrides win over cluster GUCs. Verify:

```sql
SELECT relname, reloptions FROM pg_class
WHERE relkind = 'r' AND reloptions IS NOT NULL;
```

**Step 3 — Insert-mostly tables need their own treatment** (PG13+ `autovacuum_vacuum_insert_threshold`):

```sql
ALTER TABLE events SET (
  autovacuum_vacuum_insert_scale_factor = 0.05,   -- run after 5% inserts (for FREEZE-prep)
  autovacuum_vacuum_insert_threshold = 10000
);
```

**Step 4 — Verify under load:**

```sql
-- Watch autovacuum activity for 5 minutes
-- Capture this result, then compare after the observation window; do not reset statistics.
-- wait 5 minutes under workload
SELECT relname, autovacuum_count, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'events';
```

No completed autovacuum in five minutes can also mean the trigger was not reached, workers were busy, the relation was blocked, or a scan is still running. Inspect settings, live progress, horizons, and logs before concluding it was canceled.

### Recipe 9 — Connection Storm Response

"too many connections" or backend RAM exhaustion. Cross-ref [`80-connection-pooling.md`](./80-connection-pooling.md), [`81-pgbouncer.md`](./81-pgbouncer.md), [`82-monitoring.md`](./82-monitoring.md).

**Step 1 — Confirm the symptom:**

```sql
SELECT
  state, count(*),
  array_agg(DISTINCT application_name) AS apps
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state ORDER BY count DESC;
```

If `idle in transaction` count is high, application is leaking transactions — set `idle_in_transaction_session_timeout = '60s'` immediately (`ALTER SYSTEM SET ...; SELECT pg_reload_conf();`).

**Step 2 — Per-application connection count:**

```sql
SELECT
  application_name, usename, count(*),
  max(age(now(), backend_start)) AS oldest_conn_age
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY application_name, usename
ORDER BY count DESC;
```

If one app has hundreds of idle connections, it has no client-side pool or `max_pool_size` is mis-set.

**Step 3 — Estimate RAM commitment:**

Per-backend RAM ≈ `5-15 MB` idle, `20-200 MB` active under load. `200 connections × 100 MB` = 20 GB committed before counting `work_mem` × parallel workers.

**Step 4 — Deploy pgBouncer (the canonical fix):**

```ini
# pgbouncer.ini
[databases]
appdb = host=primary dbname=appdb

[pgbouncer]
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 30
server_idle_timeout = 600
```

Provision the restricted authentication file and server credentials as described in reference 81; SCRAM pass-through requires matching stored secrets and compatible authentication. Configure TLS verification for remote connections. `default_pool_size = 30` is **per database/user pair**, not a global 30-backend cap. Review session-state, prepared-statement, and LISTEN requirements before choosing transaction pooling.[^pgbouncer-config]

**Step 5 — Per-role baseline as defense-in-depth:**

```sql
ALTER ROLE webapp SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE webapp SET idle_session_timeout = '30min';
ALTER ROLE webapp SET statement_timeout = '30s';
ALTER ROLE webapp SET lock_timeout = '5s';
ALTER ROLE webapp CONNECTION LIMIT 200;
```

### Recipe 10 — Partition Rotation Automation

Daily partition create/drop without manual intervention. Cross-ref [`35-partitioning.md`](./35-partitioning.md), [`99-pg-partman.md`](./99-pg-partman.md), [`98-pg-cron.md`](./98-pg-cron.md).

**Setup (one-time):**

```sql
-- 1. Create the parent table partitioned by day
CREATE TABLE events (
  id        bigint generated always as identity,
  occurred_at timestamptz NOT NULL,
  user_id   bigint NOT NULL,
  payload   jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- 2. Install pg_partman
CREATE SCHEMA partman;
CREATE EXTENSION pg_partman WITH SCHEMA partman;

-- 3. Template table for indexes/constraints (applies to NEW partitions only)
CREATE TABLE events_template (LIKE events);
CREATE INDEX ON events_template (user_id);
CREATE INDEX ON events_template USING gin (payload jsonb_path_ops);

-- 4. Register with partman
SELECT partman.create_parent(
  p_parent_table => 'public.events',
  p_control      => 'occurred_at',
  p_interval     => '1 day',
  p_premake      => 7,                      -- create 7 days ahead
  p_template_table => 'public.events_template'
);

-- 5. Configure 90-day retention
UPDATE partman.part_config
SET retention = '90 days',
    retention_keep_table = false,           -- drop, don't detach
    retention_keep_index = false
WHERE parent_table = 'public.events';

-- 6. Install pg_cron, schedule maintenance hourly
CREATE EXTENSION pg_cron;
SELECT cron.schedule(
  'partman-events',
  '0 * * * *',
  $$ CALL partman.run_maintenance_proc() $$
);
```

**Verify:**

```sql
-- Future partitions pre-created?
SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent='events'::regclass ORDER BY 1;

-- pg_cron job scheduled?
SELECT * FROM cron.job WHERE jobname='partman-events';

-- Recent runs successful?
SELECT d.* FROM cron.job_run_details d
JOIN cron.job j USING (jobid)
WHERE j.jobname = 'partman-events'
ORDER BY d.start_time DESC LIMIT 5;
```

**Note on HA failover:** pg_cron does not run jobs during hot standby. After promotion, its background worker starts scheduling replicated jobs. Confirm extension setup, job ownership, authentication, and the scheduling database on every candidate primary. Cross-ref [`77-standby-failover.md`](./77-standby-failover.md) + [`98-pg-cron.md`](./98-pg-cron.md).

### Recipe 11 — DDL with Shorter Blocking Windows

These operations still take locks. Keep the initial and final DDL transactions short, use a bounded `lock_timeout`, and run long validation separately. Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md), [`37-constraints.md`](./37-constraints.md), and [`43-locking.md`](./43-locking.md).

**Pattern A — Add a NOT NULL constraint without rewriting:**

```sql
-- 1. Brief ACCESS EXCLUSIVE lock; NOT VALID skips the initial table scan.
ALTER TABLE users ADD CONSTRAINT users_email_not_null CHECK (email IS NOT NULL) NOT VALID;

-- 2. Find existing rows requiring a business-correct backfill; do not invent emails.
SELECT id FROM users WHERE email IS NULL;

-- 3. Validate (SHARE UPDATE EXCLUSIVE, doesn't block reads/writes)
ALTER TABLE users VALIDATE CONSTRAINT users_email_not_null;

-- 4. PG12+: validated CHECK lets SET NOT NULL skip the scan, but a brief strong lock remains.
ALTER TABLE users ALTER COLUMN email SET NOT NULL;   -- now fast because CHECK guarantees it

-- 5. The CHECK is now redundant.
ALTER TABLE users DROP CONSTRAINT users_email_not_null;

-- PG18+ alternative to steps 1, 3 and 4: a NOT VALID not-null constraint, no CHECK.
ALTER TABLE users ADD CONSTRAINT users_email_not_null NOT NULL email NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_email_not_null;
```

**Pattern B — Add a foreign key without long lock:**

```sql
-- 1. NOT VALID skips the scan, but takes SHARE ROW EXCLUSIVE on both tables.
ALTER TABLE orders ADD CONSTRAINT orders_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;

-- 2. Inspect orphans. Reconcile them; do not delete business records automatically.
SELECT o.* FROM orders o
WHERE o.user_id IS NOT NULL
  AND NOT EXISTS (SELECT FROM users u WHERE u.id = o.user_id);

-- 3. Validate: SHARE UPDATE EXCLUSIVE on orders, ROW SHARE on users.
ALTER TABLE orders VALIDATE CONSTRAINT orders_user_fk;
```

**Pattern C — Add an index online:**

```sql
-- CREATE INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, allows reads + writes
CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);

-- Verify it's valid (not INVALID from a failed build)
SELECT indexrelid::regclass, indisvalid, indisready
FROM pg_index WHERE indrelid='orders'::regclass AND NOT indisvalid;

-- Drop only if inspection confirms this index is invalid and not constraint-owned.
-- Run separately from the successful build path:
-- DROP INDEX CONCURRENTLY orders_user_id_idx;
```

**Cannot run inside transaction block:**

`CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `ALTER TABLE ... DETACH PARTITION CONCURRENTLY`, and `VACUUM` all refuse to run in `BEGIN ... COMMIT`. Most migration frameworks (Rails, Alembic, Flyway) wrap each migration in a transaction by default — use the framework's escape hatch (e.g., Alembic `op.execute(...)` with `transactional_ddl = False`).

### Recipe 12 — Role Inventory + Cleanup

Cluster-wide audit before dropping a role. Cross-ref [`46-roles-privileges.md`](./46-roles-privileges.md), [`47-row-level-security.md`](./47-row-level-security.md).

**Step 1 — Inventory all roles + attributes:**

```sql
SELECT
  rolname,
  rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls,
  rolconnlimit,
  rolvaliduntil,
  array_to_string(rolconfig, ', ') AS guc_overrides
FROM pg_roles
WHERE rolname NOT LIKE 'pg_%'
ORDER BY rolsuper DESC, rolname;
```

**Step 2 — Membership graph:**

```sql
WITH RECURSIVE membership AS (
  SELECT roleid, member, ARRAY[roleid] AS path, 1 AS depth
  FROM pg_auth_members
  UNION ALL
  SELECT am.roleid, m.member, m.path || am.roleid, m.depth + 1
  FROM pg_auth_members am
  JOIN membership m ON am.member = m.roleid
  WHERE NOT am.roleid = ANY(m.path)
)
SELECT
  r1.rolname AS member_of,
  r2.rolname AS member,
  depth
FROM membership
JOIN pg_roles r1 ON r1.oid = roleid
JOIN pg_roles r2 ON r2.oid = member
ORDER BY r2.rolname, depth;
```

**Step 3 — Objects owned by a role (must reassign before drop):**

```sql
-- Per-database; loop over all databases for cluster-wide picture
SELECT current_database(), n.nspname AS schema, c.relname AS object,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                     WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence'
                     WHEN 'm' THEN 'matview' WHEN 'p' THEN 'part_table' END AS type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE r.rolname = 'soon_to_be_dropped'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');
```

**Step 4 — Safe drop:**

Before retiring the role, stop its sessions and prevent new work or ownership changes. Repeat the following transaction in **every database containing its objects, grants, or default privileges**, including a modified template database:

    psql -X -v ON_ERROR_STOP=1 -d mydb -c '
      BEGIN;
      REASSIGN OWNED BY soon_to_be_dropped TO new_owner;
      DROP OWNED BY soon_to_be_dropped;
      COMMIT;
    '

Only after each database succeeds:

    psql -X -v ON_ERROR_STOP=1 -d postgres -c 'DROP ROLE soon_to_be_dropped;'

`DROP OWNED` can delete objects still owned by the role, so it must not run after a failed reassignment. `REASSIGN OWNED` also handles shared databases and tablespaces; it does not revoke grants or default privileges, which the later `DROP OWNED` handles.[^reassign-owned]

## Catalog Exploration

Ten copy-paste-ready queries answering the most common "what's happening right now" questions. Each query includes a one-paragraph interpretation note. Cross-ref [`64-system-catalogs.md`](./64-system-catalogs.md) for catalog-mechanics deep dive.

### §1 — What's running right now

```sql
SELECT
  pid,
  age(clock_timestamp(), xact_start) AS xact_age,
  state,
  wait_event_type || '/' || COALESCE(wait_event, '') AS wait,
  usename, application_name,
  left(query, 200) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND state != 'idle'
ORDER BY xact_start ASC NULLS LAST;
```

`state = 'active'` and a non-null wait event means the query is executing but currently waiting for a resource, not consuming CPU at that instant. `state` and wait events are independent.[^statistics]

### §2 — What's eating disk

```sql
SELECT
  n.nspname AS schema,
  c.relname AS object,
  CASE c.relkind
    WHEN 'r' THEN 'table' WHEN 'p' THEN 'part_table'
    WHEN 'i' THEN 'index' WHEN 'I' THEN 'part_index'
    WHEN 'm' THEN 'matview' WHEN 't' THEN 'toast'
    WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' END AS type,
  pg_size_pretty(pg_relation_size(c.oid))       AS relation_size,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'i', 'I', 'm', 'S')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;
```

`pg_relation_size` measures one relation fork. `pg_total_relation_size` adds the relation's forks, TOAST, and indexes, but does not recursively total a partition hierarchy. For a partitioned parent, sum `pg_total_relation_size(relid)` over leaf rows of `pg_partition_tree(parent)`.

### §3 — Tables without a primary key

```sql
SELECT
  n.nspname AS schema, c.relname AS table,
  c.reltuples::bigint AS approx_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = c.oid AND contype = 'p'
  )
ORDER BY c.reltuples DESC;
```

Logical replication can publish INSERTs without a primary key. UPDATE/DELETE replication needs a suitable replica identity, which can be a qualifying unique index or `REPLICA IDENTITY FULL`. Full-table `pg_repack` also accepts a qualifying unique index on non-null columns; a PK is not its only option.

### §4 — Foreign keys missing a covering index

```sql
SELECT
  conrelid::regclass AS child_table,
  conname AS fk_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE contype = 'f'
  AND c.conparentid = 0   -- skip per-partition clones of a partitioned FK
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indrelid = c.conrelid
      AND i.indisvalid AND i.indisready AND i.indpred IS NULL
      AND am.amname = 'btree'
      AND i.indnkeyatts >= cardinality(c.conkey)
      AND ARRAY(
        SELECT k FROM unnest(i.indkey) WITH ORDINALITY AS keys(k, pos)
        WHERE pos <= cardinality(c.conkey)
      ) @> c.conkey
  );
```

This is a structural candidate check, not a guarantee of a particular plan. The leading B-tree key positions should contain the FK columns; equality checks can use them in a different order. Included columns are not search keys. Confirm operator/collation compatibility and the actual plan before adding an index.

### §5 — Unused indexes (with caveats)

```sql
SELECT
  n.nspname AS schema,
  c.relname AS table,
  i.relname AS index,
  pg_size_pretty(pg_relation_size(i.oid)) AS size,
  s.idx_scan,
  s.last_idx_scan    -- PG16+
FROM pg_stat_user_indexes s
JOIN pg_class i ON i.oid = s.indexrelid
JOIN pg_class c ON c.oid = s.relid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_index ix ON ix.indexrelid = i.oid
WHERE s.idx_scan = 0
  AND NOT ix.indisunique AND NOT ix.indisprimary AND NOT ix.indisexclusion
  AND NOT EXISTS (SELECT FROM pg_constraint con WHERE con.conindid = i.oid)
  AND pg_relation_size(i.oid) > 1024*1024
ORDER BY pg_relation_size(i.oid) DESC;
```

Three caveats: (a) counters are per-instance — indexes used only on a standby show 0 on primary; (b) recently-created indexes appear with `idx_scan = 0` until first scan; (c) `last_idx_scan` (PG16+) is a better signal than `idx_scan = 0`.

### §6 — Blocking chains

```sql
SELECT
  blocked.pid AS blocked_pid, blockers.pid AS blocker_pid,
  age(now(), blocked.xact_start) AS blocked_age,
  blocked.wait_event,
  left(blocked.query, 100) AS blocked_query,
  left(blocker.query, 100) AS blocker_query
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blockers(pid) ON true
LEFT JOIN pg_stat_activity blocker ON blocker.pid = blockers.pid
WHERE blocked.wait_event_type = 'Lock';
```

PID `0` represents a blocking prepared transaction; inspect `pg_prepared_xacts` and `pg_locks` because it has no activity row. Parallel workers can produce duplicate client PIDs.[^blocking-pids]

### §7 — Replication lag per replica + slot retention

```sql
-- Live walsenders
SELECT application_name, client_addr, state, sync_state,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS total_lag,
  replay_lag
FROM pg_stat_replication
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) DESC;

-- Slot retention
SELECT slot_name, slot_type, active, wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

`replay_lag = NULL` on an idle standby is healthy (no transactions to wait on). `wal_status = 'lost'` means the slot exceeded `max_slot_wal_keep_size` — standby must be rebuilt.

### §8 — Longest-running transactions (xmin horizon holders)

```sql
SELECT
  pid, usename, application_name, state,
  age(now(), xact_start) AS xact_age,
  age(now(), state_change) AS state_age,
  backend_xid, backend_xmin,
  greatest(age(backend_xid), age(backend_xmin)) AS oldest_xid_age,
  left(query, 200) AS query
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL OR backend_xmin IS NOT NULL
ORDER BY oldest_xid_age DESC LIMIT 10;
```

Inspect both `backend_xid` and `backend_xmin`: an idle transaction may retain an XID without an active statement snapshot. Judge urgency from age, XID consumption rate, and evidence of blocked cleanup rather than a universal one-million-XID threshold.

### §9 — Extension inventory + version status

```sql
SELECT
  e.extname, e.extversion AS installed,
  av.default_version AS available,
  CASE WHEN e.extversion != av.default_version THEN 'UPGRADE AVAILABLE' ELSE 'CURRENT' END AS status,
  n.nspname AS schema
FROM pg_extension e
LEFT JOIN pg_available_extensions av ON av.name = e.extname
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY status, e.extname;
```

Compares installed version to what's available on disk. After `pg_upgrade`, run this — extensions don't auto-upgrade; you may need `ALTER EXTENSION pg_stat_statements UPDATE;`.

### §10 — Partition hierarchy of a partitioned table

```sql
SELECT
  pg_partition_tree('events'::regclass) AS leaf_set;

-- Detailed:
SELECT
  c.oid::regclass AS partition,
  pg_get_expr(c.relpartbound, c.oid) AS partition_bound,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
  s.n_dead_tup, s.last_autovacuum
FROM pg_partition_tree('events'::regclass) pt
JOIN pg_class c ON c.oid = pt.relid
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
ORDER BY c.oid::regclass::text;
```

`pg_partition_tree` (PG12+) walks the entire partition hierarchy (parent + children + grandchildren for sub-partitioning). `pg_get_expr(c.relpartbound, c.oid)` reconstructs the partition bound expression.

### §11 — Settings overridden from default

```sql
SELECT
  name, setting, unit, source, category, short_desc
FROM pg_settings
WHERE source NOT IN ('default', 'override')
ORDER BY category, name;
```

Use this for cluster baseline audits — what is non-default? `source` reveals where the override comes from (`configuration file`, `command line`, `database`, `user`, `session`, `ALTER SYSTEM`).

### §12 — Role membership tree

```sql
WITH RECURSIVE rm AS (
  SELECT roleid, member, 1 AS depth, rolname AS root
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.roleid
  UNION ALL
  SELECT rm.roleid, am.member, rm.depth + 1, rm.root
  FROM rm
  JOIN pg_auth_members am ON am.roleid = rm.member
)
SELECT
  rm.root AS parent_role,
  r.rolname AS member,
  rm.depth
FROM rm
JOIN pg_roles r ON r.oid = rm.member
ORDER BY rm.root, rm.depth, r.rolname;
```

Reveals transitive membership — useful when a user has access they "shouldn't" because of a deep inheritance chain.

## Gotchas / Anti-patterns

1. **Reaching for `VACUUM FULL` when the answer is `pg_repack`.** `VACUUM FULL` takes `ACCESS EXCLUSIVE` for the duration. `pg_repack` rewrites the table online with brief locks at start and swap. Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

2. **Signaling replication workers as generic query cleanup interrupts replication.** Check `backend_type` and use the replication runbook when intervention is intended.

3. **Running diagnostic queries against `pg_statistic` directly.** Restricted (PG masks by per-table SELECT privilege). Use `pg_stats` view instead.

4. **Joining catalog tables by name.** `relname` not unique across schemas. Always join by `oid`.

5. **Filtering `pg_class` without `relkind`.** You'll mix tables, indexes, sequences, TOAST tables, partitioned tables. Always specify the kinds you want.

6. **`pg_blocking_pids` can repeat client PIDs for parallel workers.** It also represents a blocking prepared transaction as PID 0; an inner join to `pg_stat_activity` would hide that blocker.[^blocking-pids]

7. **Planner I/O costs are workload-dependent estimates.** Benchmark changes to `random_page_cost`; NVMe alone does not establish that 1.1 is correct for every query mix.

8. **Running `ANALYZE` on a single table when planner stats look wrong.** If multi-column correlation is the issue, plain `ANALYZE` won't help — create extended statistics via `CREATE STATISTICS`. Cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md).

9. **`idx_scan = 0` does not prove an index is unused or safe to drop.** Check constraint dependencies, representative workload coverage, replicas, and statistics resets. Clean PG16 shutdowns preserve cumulative counters; crashes and recovery reset them. `last_idx_scan` also depends on that observation history.[^statistics]

10. **Using `\d` interactively when a recurring catalog query would be faster.** `\set ECHO_HIDDEN on` reveals the catalog query psql is running — copy, paste, automate.

11. **Asking "is autovacuum running"** when the real question is "is autovacuum being canceled". Enable `log_autovacuum_min_duration = 0` and grep for `canceling autovacuum task`.

12. **Treating `pg_stat_*` cumulative counters as instantaneous.** They're since-last-reset (per-collector). For time-series, snapshot and diff.

13. **pg_cron jobs resume on a promoted physical standby when configured and available.** Both `cron.job` and `cron.job_run_details` are ordinary tables replicated with the database, subject to replication lag; job execution itself does not run during hot standby.[^pgcron]

14. **Running a `CREATE INDEX CONCURRENTLY` inside a transaction block.** Refused with `25001 active_sql_transaction`. Use the migration framework's escape hatch.

15. **Auditing roles against `pg_authid` directly.** Restricted (masks `rolpassword`). Use `pg_roles` view instead.

## See Also

- [22-indexes-overview.md](./22-indexes-overview.md) — Index decision matrix
- [27-mvcc-internals.md](./27-mvcc-internals.md) — Snapshots, tuple visibility, xmin horizon
- [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md) — VACUUM mechanics + tuning
- [29-transaction-id-wraparound.md](./29-transaction-id-wraparound.md) — Wraparound monitoring
- [43-locking.md](./43-locking.md) — Lock-conflict matrix + diagnosis
- [44-advisory-locks.md](./44-advisory-locks.md) — Application-level locks
- [46-roles-privileges.md](./46-roles-privileges.md) — Role + privilege model
- [55-statistics-planner.md](./55-statistics-planner.md) — pg_statistic + extended stats
- [56-explain.md](./56-explain.md) — EXPLAIN reading + plan operators
- [57-pg-stat-statements.md](./57-pg-stat-statements.md) — Workload-wide query stats
- [58-performance-diagnostics.md](./58-performance-diagnostics.md) — pg_stat_* catalog
- [64-system-catalogs.md](./64-system-catalogs.md) — pg_catalog deep dive
- [73-streaming-replication.md](./73-streaming-replication.md) — Physical replication
- [75-replication-slots.md](./75-replication-slots.md) — Slot retention + invalidation
- [77-standby-failover.md](./77-standby-failover.md) — Failover mechanics
- [80-connection-pooling.md](./80-connection-pooling.md) — Pool sizing model
- [81-pgbouncer.md](./81-pgbouncer.md) — pgBouncer config + modes
- [84-backup-physical-pitr.md](./84-backup-physical-pitr.md) — pg_basebackup + PITR
- [86-pg-upgrade.md](./86-pg-upgrade.md) — In-place major upgrade
- [87-major-version-upgrade.md](./87-major-version-upgrade.md) — Four upgrade strategies
- [90-disaster-recovery.md](./90-disaster-recovery.md) — RPO/RTO + DR strategies
- [91-docker-postgres.md](./91-docker-postgres.md) — Container deployment context for operational recipes
- [92-kubernetes-operators.md](./92-kubernetes-operators.md) — K8s operator deployment context
- [93-pg-trgm.md](./93-pg-trgm.md) — LIKE/ILIKE index acceleration (Recipe 1 Index Decision Flowchart)
- [94-pgvector.md](./94-pgvector.md) — Vector similarity index (Recipe 1 Index Decision Flowchart)
- [95-postgis.md](./95-postgis.md) — Spatial index patterns referenced in index decision flowchart
- [96-timescaledb.md](./96-timescaledb.md) — Time-series partitioning context for partition rotation recipe
- [97-citus.md](./97-citus.md) — Distributed Postgres context for sharding decisions
- [98-pg-cron.md](./98-pg-cron.md) — In-database scheduling
- [99-pg-partman.md](./99-pg-partman.md) — Partition rotation automation
- [100-pg-versions-features.md](./100-pg-versions-features.md) — Per-version feature catalog
- [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md) — Hosting-model trade-offs

## Sources

This file is a synthesis — primary sources for each fact live in the per-topic reference files cross-referenced above. The following canonical PostgreSQL docs URLs back the catalog-exploration SQL examples:

- pg_catalog overview: <https://www.postgresql.org/docs/16/catalogs.html>
- pg_stat_activity columns: <https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW>
- pg_blocking_pids: <https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-SESSION>
- pg_stat_replication columns: <https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW>
- pg_replication_slots columns: <https://www.postgresql.org/docs/16/view-pg-replication-slots.html>
- pg_partition_tree (PG12+): <https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-PARTITION>
- pg_settings: <https://www.postgresql.org/docs/16/view-pg-settings.html>
- Recovery configuration: <https://www.postgresql.org/docs/16/runtime-config-wal.html#RUNTIME-CONFIG-WAL-RECOVERY-TARGET>
- pg_upgrade: <https://www.postgresql.org/docs/16/pgupgrade.html>
- PG17 release notes (pg_stat_checkpointer split, pg_stat_progress_vacuum renames): <https://www.postgresql.org/docs/release/17.0/>
- PG18 release notes (pg_stat_io.op_bytes removal, planner-stats survive pg_upgrade, BUFFERS auto in EXPLAIN): <https://www.postgresql.org/docs/release/18.0/>
- pg_partman: <https://github.com/pgpartman/pg_partman>
- pg_cron: <https://github.com/citusdata/pg_cron>
- EXPLAIN interpretation and execution: <https://www.postgresql.org/docs/16/using-explain.html>
- ALTER TABLE locking and validation: <https://www.postgresql.org/docs/16/sql-altertable.html>
- REASSIGN OWNED: <https://www.postgresql.org/docs/16/sql-reassign-owned.html>
- PG18 post-upgrade maintenance: <https://www.postgresql.org/docs/18/pgupgrade.html>

[^blocking-pids]: PostgreSQL 16, `pg_blocking_pids` semantics. <https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-SESSION>

[^using-explain]: PostgreSQL 16, EXPLAIN execution, per-loop estimates, buffer counts, and early termination. <https://www.postgresql.org/docs/16/using-explain.html>

[^statistics]: PostgreSQL 16, Cumulative Statistics System: persistence, waits, and reset caveats. <https://www.postgresql.org/docs/16/monitoring-stats.html>

[^reassign-owned]: PostgreSQL 16, REASSIGN OWNED and shared-object ownership. <https://www.postgresql.org/docs/16/sql-reassign-owned.html>

[^pgbouncer-config]: PgBouncer configuration, authentication, TLS, and per-user/database pool limits. <https://www.pgbouncer.org/config.html>

[^pgcron]: pg_cron upstream documentation, configuration, job tables, and standby behavior. <https://github.com/citusdata/pg_cron>

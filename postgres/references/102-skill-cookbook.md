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
    - [Recipe 11 — Online DDL Without Locking](#recipe-11--online-ddl-without-locking)
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
| Adding/changing schema online | Recipe 11 (Online DDL) | [`26-index-maintenance.md`](./26-index-maintenance.md) + [`37-constraints.md`](./37-constraints.md) |
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
| `WHERE jsonb_col @> '{...}'` / `?` / `?&` / `?\|` | GIN with `jsonb_path_ops` (containment-only, smaller) or default `jsonb_ops` | Cross-ref [`17-json-jsonb.md`](./17-json-jsonb.md) |
| `WHERE array_col @> ARRAY[...]` / `&&` / `<@` | GIN with `array_ops` | Cross-ref [`16-arrays.md`](./16-arrays.md) |
| Full-text `tsvector @@ tsquery` | GIN with `tsvector_ops` | GiST also possible, slower reads, smaller |
| `range_col @> point` / `&&` / `<<` | GiST or SP-GiST with `range_ops` | Cross-ref [`15-data-types-custom.md`](./15-data-types-custom.md) |
| `ORDER BY point <-> ref_point LIMIT N` (KNN nearest-neighbor) | GiST or SP-GiST | Cross-ref [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) |
| `WHERE vec <=> '[...]'` (vector similarity) | HNSW or IVFFLAT (pgvector) | Cross-ref [`94-pgvector.md`](./94-pgvector.md) |
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
  blocker.pid           AS blocker_pid,
  blocker.usename       AS blocker_user,
  blocker.state         AS blocker_state,
  age(now(), blocker.xact_start)  AS blocker_xact_age,
  left(blocked.query, 120) AS blocked_query,
  left(blocker.query, 120) AS blocker_query
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker_pid ON true
JOIN pg_stat_activity blocker ON blocker.pid = blocker_pid
WHERE blocked.wait_event_type = 'Lock'
ORDER BY blocked_xact_age DESC;
```

`pg_blocking_pids(pid)` may return PID `0` — that means a prepared transaction holds the blocking lock (cross-ref [`41-transactions.md`](./41-transactions.md)). PIDs can repeat when multiple held locks are blocking.

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
| `Lock/relation` chain across `ACCESS SHARE` ↔ `SHARE UPDATE EXCLUSIVE` | `CREATE INDEX CONCURRENTLY` + `ANALYZE` self-block | Cross-ref [`26-index-maintenance.md`](./26-index-maintenance.md) gotcha #7 |
| Deadlock detected (40P01) | Inconsistent lock-acquisition order across sessions | Order locks deterministically; cross-ref [`43-locking.md`](./43-locking.md) Recipe 7 |

**Step 4 — Kill safely:**

```sql
-- Try graceful cancel first (interrupts current statement, transaction stays open)
SELECT pg_cancel_backend(12345);

-- If that fails, terminate (closes the connection — DON'T run on walsenders / logical-replication apply workers)
SELECT pg_terminate_backend(12345);
```

Never terminate walsenders or logical-replication apply workers — you'll break replication. Verify with `SELECT backend_type FROM pg_stat_activity WHERE pid=12345` first.

### Recipe 3 — VACUUM Bloat Triage

Six-step decision tree when a table looks bloated. Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md), [`27-mvcc-internals.md`](./27-mvcc-internals.md), [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md).

**Step 1 — Confirm the bloat:**

```sql
SELECT
  n.nspname AS schema, c.relname AS table,
  c.reltuples::bigint AS live_estimate,
  s.n_dead_tup        AS dead_tuples,
  round(100.0 * s.n_dead_tup / NULLIF(c.reltuples, 0), 1) AS dead_pct,
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

`dead_pct > 20%` is the threshold for investigation. `dead_pct > 50%` is severe.

**Step 2 — Is the xmin horizon held back?** (the single biggest cause of "VACUUM ran but bloat didn't go down")

```sql
SELECT
  'long_txn' AS source, pid, usename,
  age(now(), xact_start) AS age,
  age(backend_xmin)      AS xmin_age,
  state, left(query, 120) AS query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC LIMIT 5
UNION ALL
SELECT 'slot' AS source, NULL::int, slot_name, NULL,
  age(xmin), 'active=' || active, slot_name
FROM pg_replication_slots WHERE xmin IS NOT NULL
ORDER BY 5 DESC LIMIT 5;
UNION ALL
SELECT 'prepared_txn' AS source, NULL::int, owner, age(prepared),
  age(transaction), gid, gid
FROM pg_prepared_xacts LIMIT 5;
```

If any row shows `xmin_age > 1_000_000`, VACUUM cannot reclaim those dead tuples regardless of how aggressively you tune it. Fix the horizon-holder first (kill long-running transaction, drop abandoned slot, commit/rollback prepared transaction).

**Step 3 — Is autovacuum running but slow?**

```sql
SELECT
  pid, datname, relid::regclass AS table, phase,
  pg_size_pretty(heap_blks_total::bigint * 8192)   AS heap_total,
  pg_size_pretty(heap_blks_scanned::bigint * 8192) AS heap_scanned,
  index_vacuum_count,
  num_dead_item_ids   -- PG17+ (renamed from num_dead_tuples)
FROM pg_stat_progress_vacuum
JOIN pg_stat_activity USING (pid);
```

`index_vacuum_count > 1` means `maintenance_work_mem` is undersized — VACUUM is making multiple passes over indexes. Raise per-table or session-level (PG17+ removed the 1GB cap, cross-ref [`54-memory-tuning.md`](./54-memory-tuning.md)).

**Step 4 — Is autovacuum being canceled?** Check `log_autovacuum_min_duration = 0` and grep for `canceling autovacuum task`. Lock conflicts (DDL during autovacuum) cancel it; anti-wraparound autovacuum cannot be canceled.

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
  write_lag, flush_lag, replay_lag                   AS time_lags
FROM pg_stat_replication
ORDER BY total_lag DESC;
```

Four stages — `pending` (primary hasn't sent yet) → `write_lag` (standby received but not written to OS) → `flush_lag` (written but not fsync'd) → `replay_lag` (fsync'd but not applied).

| Stage with the lag | Likely cause |
|---|---|
| `pending_bytes` large | Primary network bandwidth bottleneck, or `wal_sender_timeout` issue |
| `write_lag` large | Standby disk write bottleneck |
| `flush_lag` large | Standby fsync bottleneck (slow storage) |
| `replay_lag` large | Standby single-threaded replay can't keep up with primary write rate, often blocked by long-running query on standby (`max_standby_streaming_delay`) |

**Step 2 — Replication slots:**

```sql
SELECT
  slot_name, slot_type, database, active, wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
  inactive_since,            -- PG17+
  invalidation_reason        -- PG17+
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
```

`wal_status = 'lost'` is unrecoverable — slot exceeded `max_slot_wal_keep_size` and standby must be rebuilt. `wal_status = 'unreserved'` means slot WAL is no longer in `pg_wal` but may still be in archive. `wal_status = 'extended'` means WAL is being retained beyond `max_wal_size`.

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
SELECT pg_current_wal_lsn();        -- primary only
```

A "standby" that returns `f` from `pg_is_in_recovery()` is a promoted primary (split-brain). Cross-ref [`90-disaster-recovery.md`](./90-disaster-recovery.md).

### Recipe 5 — PITR Recovery Walkthrough

Eight-step recovery to a specific point in time. Cross-ref [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md), [`85-backup-tools.md`](./85-backup-tools.md), [`90-disaster-recovery.md`](./90-disaster-recovery.md).

**Pre-flight (must be true before disaster):**

1. `wal_level = replica` (or `logical`) on the source cluster, NOT `minimal`.
2. `archive_mode = on` and `archive_command` (or `archive_library`, PG15+) configured.
3. Recent base backup via `pg_basebackup` (or pgBackRest / Barman / WAL-G).
4. Continuous WAL archive in object storage.

**The eight-step recovery:**

```bash
# 1. Stop application traffic. Note the recovery target time (epoch or '2026-05-14 03:42:17+00')
RECOVERY_TARGET='2026-05-14 03:42:17+00'

# 2. Provision a fresh host (do NOT recover in place — preserve evidence)
# 3. Install matching PG major version
PG_VERSION=18

# 4. Restore base backup
pgbackrest --stanza=main --type=time --target="$RECOVERY_TARGET" restore
# (or pg_basebackup output extracted to /var/lib/postgresql/18/data)

# 5. Configure recovery
cat >> /var/lib/postgresql/18/data/postgresql.auto.conf <<EOF
restore_command = 'pgbackrest --stanza=main archive-get %f "%p"'
recovery_target_time = '$RECOVERY_TARGET'
recovery_target_action = 'pause'   # don't promote until verified
recovery_target_inclusive = on
EOF

touch /var/lib/postgresql/18/data/recovery.signal

# 6. Start server (will replay WAL up to target, then pause)
pg_ctl -D /var/lib/postgresql/18/data start

# 7. Verify before promoting
psql -c "SELECT pg_last_wal_replay_lsn(), now(), pg_is_in_recovery();"
psql -c "SELECT count(*) FROM critical_table WHERE created_at < '$RECOVERY_TARGET';"
# Inspect critical data; if wrong target, stop server and adjust recovery_target_time

# 8. Promote when satisfied
psql -c "SELECT pg_wal_replay_resume();"
# After replay catches up to target, server auto-promotes (if recovery_target_action = 'promote')
# OR explicitly:
pg_ctl -D /var/lib/postgresql/18/data promote
```

**Critical rules:**

- `recovery_target_inclusive = on` (default) stops **after** the target transaction. Set to `off` to stop **before**.
- `recovery_target_action = 'pause'` (default since PG13) lets you verify. `promote` auto-promotes (risky — you can't go back). `shutdown` lets you inspect offline.
- Only **one** `recovery_target_*` GUC may be set. Multiple = error.
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
| PG17→PG18, downtime budget < 1 min | `pg_createsubscriber` (PG17+) converts physical standby to subscriber |

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

**pg_upgrade --link workflow:**

```bash
# 1. Run --check on a clone to validate
/usr/lib/postgresql/18/bin/pg_upgrade \
  --old-datadir=/var/lib/postgresql/16/main \
  --new-datadir=/var/lib/postgresql/18/main \
  --old-bindir=/usr/lib/postgresql/16/bin \
  --new-bindir=/usr/lib/postgresql/18/bin \
  --check

# 2. Stop both clusters
pg_ctlcluster 16 main stop
pg_ctlcluster 18 main stop

# 3. Actual upgrade
/usr/lib/postgresql/18/bin/pg_upgrade ...same args... --link

# 4. Start new cluster
pg_ctlcluster 18 main start

# 5. PG17 and earlier need ANALYZE; PG18+ pg_upgrade preserves planner stats
# PG≤17:
vacuumdb --all --analyze-in-stages --jobs=$(nproc)
# PG18+: skipped, but verify a sample plan
psql -c "EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM critical_table WHERE indexed_col = ?;"
```

**Post-upgrade checks (cross-ref [`100-pg-versions-features.md`](./100-pg-versions-features.md) for per-version GUC changes):**

```sql
-- Connection params + auth still working?
SELECT version(), current_setting('server_version_num');

-- Replication slots intact? (preserved by pg_upgrade since PG17)
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

For mutating statements, wrap in `BEGIN; ... ; ROLLBACK;` to avoid actually running. PG18+ adds `BUFFERS` by default.

**Step 3 — Read bottom-up. Find the misestimate.**

For each plan node, look at `(actual rows=N loops=L) (rows=E)` — total actual = `N * L`. If `actual ≠ estimate × 10` at any node, that's a misestimate. Climb the tree from the leaf where misestimate first appears.

| Symptom | Likely cause | Fix |
|---|---|---|
| Misestimate on a single column | Stale statistics | `ANALYZE table` |
| Misestimate on `WHERE a AND b` | Correlated columns, planner assumes independence | `CREATE STATISTICS (mcv, dependencies) ON a, b FROM table` |
| Misestimate on `WHERE lower(email)` | No stats on expression | Functional index on `lower(email)` or extended-stats on expression PG14+ |
| `actual rows = 1` everywhere from a `LIMIT 1` | Planner expected uniform distribution | Cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md) gotcha "LIMIT 1 collapse" |
| Generic-vs-custom plan flip (prepared statement) | Parameter skew | `SET plan_cache_mode = force_custom_plan;` cross-ref [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) |

**Step 4 — Buffer reads:**

`Buffers: shared read=N` (cold-cache disk reads) vs `shared hit=N` (warm-cache). High read = working set exceeds `shared_buffers`. High `temp read/written` = `work_mem` too small, query is spilling sorts/hashes to disk.

**Step 5 — Identify wrong access method:**

`Seq Scan` on a table with a usable index = missing-index or stale-stats issue. `Index Scan` followed by `Rows Removed by Filter > 0` = predicate not fully index-supported, consider covering with INCLUDE or partial index.

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
  autovacuum_vacuum_cost_limit = 2000,      -- raise from default 200
  autovacuum_naptime = 30                    -- if launcher needs to revisit fast
);
```

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
SELECT pg_stat_reset();  -- baseline
-- wait 5 minutes under workload
SELECT relname, autovacuum_count, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'events';
```

If `autovacuum_count = 0` after 5 minutes despite high dead_tup, autovacuum is being canceled (check `log_autovacuum_min_duration = 0` and grep logs for "canceling autovacuum task"). Cross-ref [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) gotchas.

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
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1
pool_mode = transaction      # most apps work fine here
max_client_conn = 5000        # what apps connect to
default_pool_size = 30        # backends per (user, db)
server_idle_timeout = 600
```

Apps connect to pgBouncer (port 6432) instead of PG (5432). `5000 client conns × 30 backend pool` collapses to ~30 actual PG backends. Cross-ref [`81-pgbouncer.md`](./81-pgbouncer.md) for transaction-mode caveats (session state, prepared statements, LISTEN).

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
SELECT * FROM cron.job_run_details WHERE jobname='partman-events' ORDER BY start_time DESC LIMIT 5;
```

**Note on HA failover:** pg_cron jobs run on the **primary only**. After failover, the new primary auto-resumes them (verified by the worker started at promote time). Cross-ref [`77-standby-failover.md`](./77-standby-failover.md) + [`98-pg-cron.md`](./98-pg-cron.md) HA section.

### Recipe 11 — Online DDL Without Locking

Three canonical online patterns. Cross-ref [`26-index-maintenance.md`](./26-index-maintenance.md), [`37-constraints.md`](./37-constraints.md), [`43-locking.md`](./43-locking.md).

**Pattern A — Add a NOT NULL constraint without rewriting:**

```sql
-- 1. Add CHECK as NOT VALID (instant, no scan)
ALTER TABLE users ADD CONSTRAINT users_email_not_null CHECK (email IS NOT NULL) NOT VALID;

-- 2. Backfill if needed
UPDATE users SET email = 'unknown@example.com' WHERE email IS NULL;

-- 3. Validate (SHARE UPDATE EXCLUSIVE, doesn't block reads/writes)
ALTER TABLE users VALIDATE CONSTRAINT users_email_not_null;

-- 4. PG18+: convert to real NOT NULL via NOT VALID
ALTER TABLE users ALTER COLUMN email SET NOT NULL;   -- now fast because CHECK guarantees it
```

**Pattern B — Add a foreign key without long lock:**

```sql
-- 1. NOT VALID FK takes brief ACCESS EXCLUSIVE, no scan
ALTER TABLE orders ADD CONSTRAINT orders_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;

-- 2. Backfill / fix orphan rows
DELETE FROM orders WHERE user_id NOT IN (SELECT id FROM users);

-- 3. Validate (SHARE UPDATE EXCLUSIVE on both tables, allows DML)
ALTER TABLE orders VALIDATE CONSTRAINT orders_user_fk;
```

**Pattern C — Add an index online:**

```sql
-- CREATE INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, allows reads + writes
CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);

-- Verify it's valid (not INVALID from a failed build)
SELECT indexrelid::regclass, indisvalid, indisready
FROM pg_index WHERE indrelid='orders'::regclass AND NOT indisvalid;

-- If invalid, drop and retry
DROP INDEX CONCURRENTLY orders_user_id_idx;
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

```bash
# Per-database, reassign ownership then drop privileges
for db in $(psql -tAc "SELECT datname FROM pg_database WHERE NOT datistemplate"); do
  psql -d "$db" -c "REASSIGN OWNED BY soon_to_be_dropped TO new_owner;"
  psql -d "$db" -c "DROP OWNED BY soon_to_be_dropped;"
done

# Cluster-wide
psql -c "DROP ROLE soon_to_be_dropped;"
```

`REASSIGN OWNED` moves ownership; `DROP OWNED` removes privileges. Tablespace ownership is **not** handled by `REASSIGN OWNED` — `ALTER TABLESPACE ... OWNER TO new_owner` manually.

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

Read `wait` first. `Lock/*` = blocked on lock (run Recipe 2). `IO/*` = reading/writing storage. `LWLock/*` = shared-memory contention. `Activity/*` = idle (paradoxically — backend is between queries). `state = 'active' AND wait IS NOT NULL` is normal — backend is on-CPU but waiting on a resource.

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

`pg_relation_size` is heap or index only. `pg_total_relation_size` adds TOAST + all indexes. Partitioned-parent tables return 0 from `pg_relation_size` (the partitions hold the data) — use `pg_total_relation_size` for the aggregate.

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

Tables without PK can't be replicated logically (no `REPLICA IDENTITY`), can't use `pg_repack`, and are friction-prone for ORMs.

### §4 — Foreign keys missing a covering index

```sql
SELECT
  conrelid::regclass AS child_table,
  conname AS fk_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND (i.indkey::int[])[0:cardinality(c.conkey)-1] = c.conkey::int[]
  );
```

Leading-prefix match: index `(other, fk_col)` does NOT satisfy. The index must lead with the FK column(s) in the FK's declared order. Without a covering index, every parent `DELETE`/`UPDATE` triggers a sequential scan of the child.

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
  AND NOT ix.indisunique AND NOT ix.indisprimary
  AND pg_relation_size(i.oid) > 1024*1024
ORDER BY pg_relation_size(i.oid) DESC;
```

Three caveats: (a) counters are per-instance — indexes used only on a standby show 0 on primary; (b) recently-created indexes appear with `idx_scan = 0` until first scan; (c) `last_idx_scan` (PG16+) is a better signal than `idx_scan = 0`.

### §6 — Blocking chains

```sql
SELECT
  blocked.pid AS blocked_pid, blocker.pid AS blocker_pid,
  age(now(), blocked.xact_start) AS blocked_age,
  blocked.wait_event,
  left(blocked.query, 100) AS blocked_query,
  left(blocker.query, 100) AS blocker_query
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bp ON true
JOIN pg_stat_activity blocker ON blocker.pid = bp
WHERE blocked.wait_event_type = 'Lock';
```

PID `0` means a prepared transaction (cross-ref [`41-transactions.md`](./41-transactions.md)). PIDs may repeat (one row per held lock).

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
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
  inactive_since        -- PG17+
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
  backend_xmin, age(backend_xmin) AS xmin_age,
  left(query, 200) AS query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC LIMIT 10;
```

A row with `xmin_age > 1_000_000` and `state = 'idle in transaction'` is the canonical bloat-builder — its snapshot is preventing VACUUM from reclaiming dead tuples cluster-wide.

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

2. **Killing a walsender or logical-replication apply worker via `pg_terminate_backend`.** Breaks replication. Check `backend_type` first.

3. **Running diagnostic queries against `pg_statistic` directly.** Restricted (PG masks by per-table SELECT privilege). Use `pg_stats` view instead.

4. **Joining catalog tables by name.** `relname` not unique across schemas. Always join by `oid`.

5. **Filtering `pg_class` without `relkind`.** You'll mix tables, indexes, sequences, TOAST tables, partitioned tables. Always specify the kinds you want.

6. **`pg_blocking_pids` deduplication assumed but not provided.** Same PID can appear multiple times in the array (one per held lock). De-duplicate downstream if needed.

7. **Carrying forward `random_page_cost = 4.0` from spinning-rust era onto NVMe.** Costs index scans 4x more than they should. Lower to `1.1` on SSD-class storage. Cross-ref [`59-planner-tuning.md`](./59-planner-tuning.md).

8. **Running `ANALYZE` on a single table when planner stats look wrong.** If multi-column correlation is the issue, plain `ANALYZE` won't help — create extended statistics via `CREATE STATISTICS`. Cross-ref [`55-statistics-planner.md`](./55-statistics-planner.md).

9. **Trusting `idx_scan = 0` as proof of unused.** Counters reset on cluster restart; replica-side scans don't count; recently-created indexes appear unused. Use PG16+ `last_idx_scan` instead.

10. **Using `\d` interactively when a recurring catalog query would be faster.** `\set ECHO_HIDDEN on` reveals the catalog query psql is running — copy, paste, automate.

11. **Asking "is autovacuum running"** when the real question is "is autovacuum being canceled". Enable `log_autovacuum_min_duration = 0` and grep for `canceling autovacuum task`.

12. **Treating `pg_stat_*` cumulative counters as instantaneous.** They're since-last-reset (per-collector). For time-series, snapshot and diff.

13. **Forgetting that `pg_cron` jobs run on the primary only.** After failover, the new primary picks them up — but a job's history (`cron.job_run_details`) does not transfer. Cross-ref [`98-pg-cron.md`](./98-pg-cron.md).

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

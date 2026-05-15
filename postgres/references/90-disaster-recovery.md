# Disaster Recovery — Postgres

DR planning, restore runbooks, PITR walkthroughs, cross-region failover, post-failover bookkeeping, drills.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [RPO and RTO — Definitions and Targets](#rpo-and-rto--definitions-and-targets)
- [Decision Matrix](#decision-matrix)
- [Smell Signals](#smell-signals)
- [DR Strategies](#dr-strategies)
    - [Strategy A — Restore from Backup (Cold Start)](#strategy-a--restore-from-backup-cold-start)
    - [Strategy B — PITR (Cross-Reference 84)](#strategy-b--pitr-cross-reference-84)
    - [Strategy C — Cross-Region Physical Standby Failover](#strategy-c--cross-region-physical-standby-failover)
    - [Strategy D — Logical Replica Failover (PG17+ Slot Sync)](#strategy-d--logical-replica-failover-pg17-slot-sync)
- [Failover Mechanics](#failover-mechanics)
    - [pg_promote vs pg_ctl promote vs Signal File](#pg_promote-vs-pg_ctl-promote-vs-signal-file)
    - [Recovery Target Enforcement](#recovery-target-enforcement)
    - [Timeline Divergence After Failover](#timeline-divergence-after-failover)
- [Post-Failover Bookkeeping](#post-failover-bookkeeping)
- [DR Drills](#dr-drills)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use This Reference

Read when: writing DR runbook / authoring restore procedure / planning quarterly drills / responding to outage / defining SLAs around RPO+RTO / sizing backup-retention + replica topology / post-mortem on failed failover.

This file is **synthesis** — pulls together streaming replication (73), logical replication (74), slots (75), failover (77), HA architectures (78), Patroni (79), physical PITR (84), backup tools (85), pg_upgrade (86), major-version upgrade (87), corruption recovery (88), pg_rewind (89). Read those for mechanics. Read this for **scenario sequencing**.

---

## Mental Model

Five rules to internalize.

1. **RPO = data-loss budget. RTO = downtime budget. Pick targets BEFORE picking technology.** RPO=0 → synchronous-replication-or-bust. RPO=15min → async streaming + WAL archive. RPO=24h → nightly backup suffices. RTO=30s → automated failover (Patroni/CNPG). RTO=4h → manual restore from backup. Tech follows targets, not reverse.

2. **DR ≠ HA.** HA handles single-node failure inside one cluster (one AZ, one DC). DR handles cluster-wide failure — region outage, datacenter fire, corruption that replicated to every standby, ransomware that encrypted every replica simultaneously. Need both. Replicas alone don't survive corruption + ransomware + region outages.

3. **"Untested backup is not a backup."** Backup that has never been restored is hypothesis. Quarterly minimum drill — restore to disposable host + start server + verify data. Capture RTO. Compare to budget.

4. **Multiple independent failure domains.** Backup-tool repo + physical replica + cross-region replica + offline (S3 Object Lock / write-once-read-many) archive. Each domain protects against different failure class — host (replica), region (cross-region replica), corruption-replicated-via-replication (offline archive), accidental DROP DATABASE (PITR from backup).

5. **Skipping post-failover bookkeeping breaks the cluster silently.** Promotion succeeds, app reconnects, then 6 hours later disk fills because an abandoned slot on the old primary retained 800GB WAL. Or app silently writes to the old-primary readonly endpoint because the Route 53 entry was not updated. Bookkeeping checklist mandatory — Slot Cleanup / Connection String / Monitoring Re-wire / Old-Primary Fencing.

> [!WARNING] Two operational watersheds for 2026
>
> 1. **Untested backups silently fail.** PG18 default-on `data_checksums` will detect on-disk corruption during restore — but only if you restore. Without quarterly drill, corruption + retention-window roll-over silently destroys recoverable history. Triple-anchor: budget, drill, alert.
> 2. **PG13 EOL was November 2025 — running PG13 in production today (2026-05-14) means no security patches, no DR-tooling fixes.** PG14 EOL November 2026 (~6 months out). Cross-reference [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

---

## RPO and RTO — Definitions and Targets

| Metric | Definition | Drives |
| --- | --- | --- |
| **RPO** (Recovery Point Objective) | Maximum acceptable data loss measured in time | Replication mode + backup frequency + WAL archive cadence |
| **RTO** (Recovery Time Objective) | Maximum acceptable downtime measured in time | Failover automation + restore parallelism + replica preheat |
| **MTTR** (Mean Time To Recover) | Observed actual recovery time, average | Drill output — compare to RTO |
| **MTTD** (Mean Time To Detect) | Observed time from failure to alert | Monitoring quality — does NOT count against RTO budget but adds to total outage |

### Target Examples (Reference Points, Not Recommendations)

| Workload class | Typical RPO | Typical RTO | Topology implied |
| --- | --- | --- | --- |
| Marketing site, blog, internal tool | 24h | 4h | Nightly pg_dump → S3, restore manually |
| Standard SaaS app | 5min | 30min | Streaming replica + WAL archive every 60s + automated failover |
| Financial transactions | 0 (commit durability) | 30s | Synchronous replication + Patroni/CNPG + cross-AZ |
| Regulated multi-region | 0 + auditable | 5min | Synchronous in-region + async cross-region + offline immutable archive |

**Operational rule of thumb:** RPO and RTO **independent dials**. Cheap synchronous replication does NOT reduce RTO. Fast restore does NOT reduce RPO. Address each separately.

---

## Decision Matrix

| Need | Strategy | Cross-reference |
| --- | --- | --- |
| Whole region went down, no replicas there | Restore from offline backup in different region | [`85-backup-tools.md`](./85-backup-tools.md) |
| Primary failed, replica healthy in same region | Promote replica → re-point app | [`77-standby-failover.md`](./77-standby-failover.md) |
| Primary failed, only async replica available | Promote replica + accept replication-lag-window data loss | [`73-streaming-replication.md`](./73-streaming-replication.md) |
| Accidental `DROP TABLE` or `TRUNCATE` 3h ago | PITR to right-before-the-event | [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) |
| Logical corruption (bad app deploy) replicated to all replicas | PITR from backup — replicas are useless | [`88-corruption-recovery.md`](./88-corruption-recovery.md) |
| Ransomware encrypted backup repo + primary | Restore from offline immutable archive (S3 Object Lock / WORM) | [`85-backup-tools.md`](./85-backup-tools.md) |
| Cross-region failover desired | Promote remote-region async replica → live with replication-lag RPO | Below — Strategy C |
| Logical replica subscriber needs to become primary | Logical-slot failover (PG17+) | [`75-replication-slots.md`](./75-replication-slots.md) |
| Old primary diverged, want to re-attach as standby | pg_rewind to new primary | [`89-pg-rewind.md`](./89-pg-rewind.md) |
| Verify restorability without affecting prod | Restore to disposable host, run integrity checks | Below — DR Drills |
| Want zero data loss during planned failover | Controlled switchover with `pg_switch_wal` + sync replication | [`77-standby-failover.md`](./77-standby-failover.md) Recipe 5 |
| Estimate restore time before disaster | Run quarterly drill, capture wall-clock | Below — DR Drills |

---

## Smell Signals

- **Last successful restore drill: more than 90 days ago, or "never."** Backup pipeline is hypothesis. Schedule + capture timing this quarter.
- **DR plan is one-line: "We have backups."** No runbook, no escalation, no role assignment. Promote one engineer to write a restore-from-backup walkthrough that another engineer can follow without help.
- **Replicas are the only DR plan.** No backup → no protection against logical corruption (bad migration, app bug, malicious DROP), retention-window mistakes, cluster-wide config errors. Always pair with backup-and-archive strategy.

---

## DR Strategies

### Strategy A — Restore from Backup (Cold Start)

**Use when:** primary destroyed AND no warm standby AND can tolerate restore-time RTO (hours for TB-scale clusters).

**Canonical 8-step procedure:**

```bash
# 1. Provision fresh host with same PG major version + matching architecture
#    (cross-version impossible — same-major or one-major-newer-via-pg_upgrade-only)
sudo apt-get install postgresql-16

# 2. Stop any started Postgres on target host
sudo systemctl stop postgresql

# 3. Wipe data directory (or use fresh empty directory)
sudo rm -rf /var/lib/postgresql/16/main/*

# 4. Restore base backup using your backup tool
#    pgBackRest example:
sudo -u postgres pgbackrest --stanza=main --type=default restore

#    Or pg_basebackup-archive + manual extraction:
sudo -u postgres tar -xzf /backup/base.tar.gz -C /var/lib/postgresql/16/main/

# 5. Apply WAL archive up to LATEST (no recovery_target_* — full recovery)
sudo -u postgres tee /var/lib/postgresql/16/main/postgresql.auto.conf <<EOF
restore_command = '/usr/local/bin/wal-fetch %f %p'
recovery_target_action = 'promote'
EOF

# 6. Create recovery.signal to enter recovery mode
sudo -u postgres touch /var/lib/postgresql/16/main/recovery.signal

# 7. Start Postgres + monitor recovery
sudo systemctl start postgresql
sudo -u postgres tail -f /var/log/postgresql/postgresql-16-main.log
# Look for: "redo done at <LSN>" and "database system is ready to accept connections"

# 8. Verify
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"  # false after promote
sudo -u postgres psql -c "SELECT pg_last_wal_replay_lsn();"  # confirm LSN advanced
sudo -u postgres psql -c "SELECT count(*) FROM critical_table;"  # data sanity
```

> [!WARNING] Restore time scales with WAL volume since base backup
>
> 1TB cluster + 100GB WAL since last base backup typical 30-90min restore. Drive `max_wal_size` + base-backup cadence to fit RTO budget.

### Strategy B — PITR (Cross-Reference 84)

See [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) Recipe 2 for the canonical 8-step PITR walkthrough.

**DR-specific addition:** When PITR is the **chosen DR strategy** (not just emergency restore), pre-stage:

- Disposable host or container image ready to receive restore (saves 5-15min provisioning)
- Connection string + secrets pre-loaded into config-management
- Documented recovery-target candidates for common scenarios: `recovery_target_time = '<10min ago>'`, `recovery_target_xid = '<last_known_good>'`, `recovery_target_name = 'pre-migration-snapshot'`
- Automation to promote application traffic to recovered cluster (DNS update, load-balancer config)

### Strategy C — Cross-Region Physical Standby Failover

**Use when:** entire primary region unavailable (cloud outage, datacenter fire, network partition).

**Pre-requisites (must be in place BEFORE failure):**

```bash
# On primary, in postgresql.conf:
wal_level = replica  # or 'logical' if you need logical decoding
max_wal_senders = 10
synchronous_commit = on  # or 'remote_apply' for stronger guarantees
synchronous_standby_names = 'ANY 1 (local_replica_1, local_replica_2)'  # local-region sync
# Cross-region replica intentionally NOT in synchronous_standby_names — async

# On cross-region replica, in postgresql.auto.conf:
primary_conninfo = 'host=primary.us-east-1.example.com port=5432 user=replicator sslmode=verify-full application_name=dr_replica'
primary_slot_name = 'dr_replica_slot'
hot_standby = on
hot_standby_feedback = off  # do NOT pin xmin horizon on primary from cross-region replica
```

**6-step failover procedure:**

```bash
# 1. Confirm primary region is down + recovery is impractical within RTO budget
#    (NOT just slow network — verify true outage)

# 2. On cross-region replica, check current replay LSN + lag
psql -c "SELECT pg_last_wal_replay_lsn(), now() - pg_last_xact_replay_timestamp() AS lag;"

# 3. Decide: accept lag-window data loss vs wait + risk extended outage
#    Cross-region async replica = RPO of replication lag (typically 1-60s)

# 4. Promote
psql -c "SELECT pg_promote(wait => true, wait_seconds => 60);"
# Or via signal file:
# pg_ctl promote -D $PGDATA
# Cross-reference 77-standby-failover.md gotcha #1 — promote_trigger_file REMOVED in PG16+

# 5. Verify promotion
psql -c "SELECT pg_is_in_recovery();"  # MUST return false
psql -c "SELECT pg_current_wal_lsn();"  # confirm writes possible

# 6. Re-point application — DNS update, load-balancer reconfig, app-config reload
#    Cross-reference Post-Failover Bookkeeping below
```

> [!WARNING] Replication lag IS the RPO
>
> Async cross-region replica's RPO equals replication lag at moment of failure. If lag was 8 seconds when primary died, lose ~8 seconds of committed transactions. Monitor `pg_stat_replication.replay_lag` continuously — alert if exceeds RPO budget.

### Strategy D — Logical Replica Failover (PG17+ Slot Sync)

**Use when:** logical replica must become primary (cross-version migration target, isolated CDC consumer).

PG17 introduced logical-slot failover via `sync_replication_slots = on` + `failover = true` on `pg_create_logical_replication_slot()`. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md) for full mechanics.

```sql
-- On primary, create failover-enabled logical slot
SELECT pg_create_logical_replication_slot(
    'app_subscriber',
    'pgoutput',
    failover => true  -- PG17+ only
);

-- On standby that will receive failover, enable slot sync
ALTER SYSTEM SET sync_replication_slots = on;
SELECT pg_reload_conf();

-- After standby promotion, logical slot survives — subscribers reconnect to new primary
```

**Pre-PG17 limitation:** logical slots do NOT survive failover. Subscriber re-bootstraps from new primary (lose CDC continuity, may need full re-sync).

---

## Failover Mechanics

### pg_promote vs pg_ctl promote vs Signal File

| Method | How | Notes |
| --- | --- | --- |
| `pg_promote()` SQL function | `SELECT pg_promote(wait => true, wait_seconds => 60);` | SQL-callable, returns boolean. PG12+. Preferred in automation. |
| `pg_ctl promote` CLI | `pg_ctl promote -D $PGDATA` | Shell-callable. Useful from cron / orchestration. |
| `promote` signal file | `touch $PGDATA/promote.signal` | Filesystem-only. Postmaster picks up next loop. |
| ~~`promote_trigger_file` GUC~~ | **REMOVED in PG16** | Cross-reference [`77-standby-failover.md`](./77-standby-failover.md) gotcha #1. Carry-forward configs silently fail. |

> [!NOTE] PostgreSQL 14
> `in_hot_standby` read-only server parameter (Haribabu Kommi, Greg Nancarrow, Tom Lane): *"Add new read-only server parameter `in_hot_standby` ... allows clients to easily detect whether they are connected to a hot standby server."*[^pg14-relnotes] Use in app code: `SHOW in_hot_standby;` returns `on` on standby, `off` after promotion.

> [!NOTE] PostgreSQL 14
> `pg_get_wal_replay_pause_state()` (Dilip Kumar): *"Add function `pg_get_wal_replay_pause_state()` to report the recovery state."*[^pg14-relnotes] Returns one of `not paused`, `pause requested`, `paused`. Useful in DR drills to verify recovery is paused before applying additional WAL.

### Recovery Target Enforcement

After promotion, recovery target controls what server does at end-of-recovery:

```ini
# postgresql.auto.conf during recovery
recovery_target_time = '2026-05-14 03:45:00 UTC'
recovery_target_action = 'promote'  # OR 'pause' OR 'shutdown'
```

| Action | Behavior | When to use |
| --- | --- | --- |
| `promote` | Server completes recovery + starts accepting writes | Final restore, ready for production |
| `pause` | Server stops at target, accepts read-only queries | Verify data before committing to promotion. Resume with `pg_wal_replay_resume()`. |
| `shutdown` | Server stops cleanly at target, no promotion | Inspect data offline, decide later |

> [!NOTE] PostgreSQL 14
> `restore_command` reloadable on `SIGHUP` (Sergei Kornilov): *"Allow the `restore_command` setting to be changed during a server reload ... You can also set `restore_command` to an empty string and reload to force recovery to only read from the `pg_wal` directory."*[^pg14-relnotes] Critical DR feature: can change WAL source mid-recovery without restart.

### Timeline Divergence After Failover

Promotion creates new **timeline ID**. Cross-reference [`77-standby-failover.md`](./77-standby-failover.md) + [`89-pg-rewind.md`](./89-pg-rewind.md).

```sql
-- Inspect current timeline
SELECT pg_control_checkpoint();
SELECT pg_walfile_name(pg_current_wal_lsn());
-- File name like 000000020000003C000000A8 — first 8 hex digits = timeline ID
```

Old primary diverges at promotion LSN. If old primary is recoverable, use `pg_rewind` to re-attach as standby. Otherwise wipe + rebuild from base backup.

---

## Post-Failover Bookkeeping

**Skipping these steps breaks the cluster silently.** Promotion succeeds → app reconnects → hours later, something silently broken.

### Bookkeeping Checklist

```sql
-- 1. SLOT CLEANUP — orphaned slots on new primary
SELECT slot_name, slot_type, active, restart_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots
ORDER BY retained_bytes DESC NULLS LAST;
-- Drop slots pointing at the dead old-primary's replicas
SELECT pg_drop_replication_slot('orphaned_slot_name');

-- 2. INACTIVE-SLOT AUTO-INVALIDATION (PG18+)
-- Cross-reference 75-replication-slots.md for idle_replication_slot_timeout mechanics
ALTER SYSTEM SET idle_replication_slot_timeout = '1h';
SELECT pg_reload_conf();
-- Slots inactive >1h are invalidated automatically

-- 3. ABANDONED LOGICAL SUBSCRIBERS — if old primary had logical publication
SELECT subname, subconninfo, subenabled
FROM pg_subscription
WHERE subconninfo LIKE '%old-primary-hostname%';
-- Update conninfo to point at new primary

-- 4. CONNECTION STRING UPDATES (app side)
-- DNS / Route53 / load balancer / k8s Service / consul KV / etc.
-- Verify ALL of: app-config, cron jobs, backup tool, monitoring, BI tools
```

### Old-Primary Fencing

If old primary may come back online (network partition + recovery), MUST fence to prevent split-brain:

| Method | How |
| --- | --- |
| STONITH (Shoot The Other Node In The Head) | Power-cycle / terminate the host |
| Firewall block | Block replication port from old-primary's IP at network level |
| Storage detach | Detach disk / EBS volume |
| Manual `pg_ctl stop` | Coordinator must SSH + stop before re-attaching |

After fencing, decide: rebuild via `pg_rewind` (cheap if divergence small) or fresh `pg_basebackup` (safe if divergence large or `wal_log_hints`/`data_checksums` not enabled before divergence).

### Monitoring Re-wire

```sql
-- Re-point Prometheus / Datadog / pganalyze targets at new primary
-- Verify primary's monitoring is collecting:
SELECT pg_is_in_recovery();  -- false on new primary
SELECT count(*) FROM pg_stat_replication;  -- standbys reconnected
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';  -- traffic flowing
SELECT pg_stat_archiver;  -- archiving resumed (cross-ref 84)
```

---

## DR Drills

### Quarterly Minimum

| Drill type | Cadence | What to capture |
| --- | --- | --- |
| Restore-from-backup to disposable host | Quarterly | Wall-clock RTO, size of data, WAL volume replayed |
| Cross-region replica promotion | Semi-annually | Wall-clock RTO, lag at moment of drill, app reconnect time |
| Full cluster rebuild (no replica, only backup) | Annually | Worst-case RTO + RPO |
| Tabletop exercise (no actual restore) | Monthly | Validate runbook, identify staleness, role-assignment gaps |

### Disposable-Host Pattern

```bash
# 1. Spin up disposable VM / container — matched OS + PG major
# 2. Restore latest backup
# 3. Apply WAL up to "now - 5min" (recent enough to test recent data)
# 4. Start server, run integrity checks:
psql -c "SELECT count(*), sum(amount) FROM transactions WHERE created_at > now() - interval '1 day';"
# Cross-check counts against monitoring snapshot from primary
# 5. Run pg_amcheck on critical tables — cross-reference 88
pg_amcheck --jobs=4 --heapallindexed --rootdescend --parent-check
# 6. Drop the disposable host
```

### Measure Against Budget

| Drill output | Action |
| --- | --- |
| Drill RTO < SLA RTO | OK. Re-test in 90 days. |
| Drill RTO ≈ SLA RTO | Add headroom — drill output is best-case, real DR adds confusion overhead. Tune backup tool parallelism + add replicas. |
| Drill RTO > SLA RTO | **Cannot meet SLA.** Either lower SLA expectation OR rearchitect (faster backup tool, hot standby, smaller cluster via sharding). |
| Drill RPO > SLA RPO | Tighten WAL archive cadence OR add synchronous replication OR add cross-region replica. |
| Integrity check fails | Backup pipeline broken. Investigate corruption source — checksums, replication, app bug. Cross-reference [`88-corruption-recovery.md`](./88-corruption-recovery.md). |

---

## Per-Version Timeline

Every PG14-18 contributed substantive DR-relevant items.

> [!NOTE] PostgreSQL 14
> Six DR items: `restore_command` reloadable on SIGHUP (Sergei Kornilov)[^pg14-relnotes]; `log_recovery_conflict_waits` GUC (Bertrand Drouvot, Masahiko Sawada)[^pg14-relnotes]; standby-parameter-change-pause replaces shutdown (Peter Eisentraut)[^pg14-relnotes]; `pg_get_wal_replay_pause_state()` (Dilip Kumar)[^pg14-relnotes]; `in_hot_standby` read-only GUC (Haribabu Kommi, Greg Nancarrow, Tom Lane)[^pg14-relnotes]; `recovery_init_sync_method = syncfs` on Linux (Thomas Munro)[^pg14-relnotes].

> [!NOTE] PostgreSQL 15
> Four DR items: `recovery_prefetch` for faster WAL replay (Thomas Munro)[^pg15-relnotes]; checkpointer + bgwriter run during crash recovery (Thomas Munro)[^pg15-relnotes]; `archive_library` for modular archiving (Nathan Bossart)[^pg15-relnotes]; `pg_receivewal` restart-point fix (Ronan Dunklau)[^pg15-relnotes].

> [!NOTE] PostgreSQL 16
> Three DR items: `pg_verifybackup` progress reporting (Masahiko Sawada)[^pg16-relnotes]; logical decoding on standbys (Bertrand Drouvot, Andres Freund, Amit Khandekar)[^pg16-relnotes]; **`promote_trigger_file` REMOVED — silent failure if carried forward** (Simon Riggs)[^pg16-relnotes]: *"Remove server variable promote_trigger_file ... now more easily accomplished with pg_ctl promote or pg_promote()."*

> [!NOTE] PostgreSQL 17
> Six DR items: WAL summarization + `summarize_wal` GUC + `pg_walsummary` (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski)[^pg17-relnotes]; system identifier added to backup manifest (Amul Sul)[^pg17-relnotes]; logical-slot failover via `failover => true` (Hou Zhijie, Shveta Malik, Ajin Cherian)[^pg17-relnotes]; `sync_replication_slots` GUC (Shveta Malik, Hou Zhijie, Peter Smith)[^pg17-relnotes]; `pg_replication_slots.inactive_since` column (Bharath Rupireddy)[^pg17-relnotes]; `pg_replication_slots.invalidation_reason` column (Shveta Malik, Bharath Rupireddy)[^pg17-relnotes].

> [!NOTE] PostgreSQL 18
> Two DR items: `pg_verifybackup` tar-format support (Amul Sul)[^pg18-relnotes]; `idle_replication_slot_timeout` for automatic slot invalidation (Nisha Moond, Bharath Rupireddy)[^pg18-relnotes]: *"Allow inactive replication slots to be automatically invalidated using server variable idle_replication_slot_timeout."* Directly mitigates post-failover-orphaned-slot disk-fill scenario.

---

## Recipes

### Recipe 1 — Write a Minimum-Viable DR Runbook

```markdown
## Primary Failure DR Runbook

**RPO target:** 5 minutes (committed)
**RTO target:** 30 minutes

### Step 1 — Detect
- Monitoring page Slack #ops-pager alerts on `pg_isready` failure for >2min
- Confirm with: `pg_isready -h primary.example.com -p 5432`

### Step 2 — Decide
- If primary recoverable (postmaster died, OS reboot needed): restart and re-evaluate
- If primary not recoverable in <15min: proceed to failover

### Step 3 — Failover
- Connect to replica: `psql -h replica.example.com -p 5432`
- Verify replica lag: `SELECT pg_last_xact_replay_timestamp();`
- Promote: `SELECT pg_promote(wait => true, wait_seconds => 60);`
- Verify: `SELECT pg_is_in_recovery();` (must be `f`)

### Step 4 — Re-point app
- Update Route53 ALIAS record (terraform apply in repo `infra-dns`)
- Verify: `dig +short db.example.com` returns replica IP
- Roll application pods: `kubectl rollout restart deployment/app`

### Step 5 — Fence old primary
- AWS console → EC2 → primary → Stop instance
- Verify: instance state = `stopped`

### Step 6 — Post-failover bookkeeping
- Drop orphaned slots (see runbook section "Slot Cleanup")
- Verify archiver running on new primary: `SELECT * FROM pg_stat_archiver;`
- Update PagerDuty escalation policy

### Step 7 — Post-mortem
- Schedule retro within 24h
- File issues in tracker for any unexpected behavior

### Roles
- **Incident commander:** on-call SRE
- **DBA contact:** @dba-oncall in PagerDuty
- **Comms:** post in #status-page within 15min of detection
```

### Recipe 2 — Quarterly Restore Drill (Automated)

```bash
#!/bin/bash
# Run via cron quarterly. Spin up disposable instance, restore, verify, tear down.

set -euo pipefail
DRILL_ID="dr-drill-$(date +%Y%m%d)"
LOG=/var/log/dr-drills/${DRILL_ID}.log

exec > >(tee -a "$LOG") 2>&1

echo "=== DR drill $DRILL_ID started at $(date -u) ==="
START_TS=$(date +%s)

# 1. Spin up disposable host (terraform / packer / cloud-init)
terraform -chdir=infra/dr-drill apply -auto-approve -var "instance_name=$DRILL_ID"
DRILL_HOST=$(terraform -chdir=infra/dr-drill output -raw host)
echo "Disposable host: $DRILL_HOST"

# 2. Restore from backup tool (pgBackRest example)
ssh "ubuntu@$DRILL_HOST" sudo -u postgres pgbackrest --stanza=main restore

# 3. Start Postgres
ssh "ubuntu@$DRILL_HOST" sudo systemctl start postgresql

# 4. Wait for end-of-recovery
sleep 30
until ssh "ubuntu@$DRILL_HOST" sudo -u postgres psql -tc "SELECT NOT pg_is_in_recovery();" | grep -q t; do
    sleep 10
done

END_TS=$(date +%s)
RTO_SECONDS=$((END_TS - START_TS))
echo "RTO: ${RTO_SECONDS}s"

# 5. Integrity checks
ssh "ubuntu@$DRILL_HOST" sudo -u postgres pg_amcheck --jobs=4 --heapallindexed
ssh "ubuntu@$DRILL_HOST" sudo -u postgres psql -c "SELECT count(*) FROM critical_table;"

# 6. Compare against budget
BUDGET=1800  # 30 minutes
if [ "$RTO_SECONDS" -gt "$BUDGET" ]; then
    echo "ALERT: drill RTO ${RTO_SECONDS}s exceeds budget ${BUDGET}s"
    # Notify ops channel
    exit 1
fi

# 7. Tear down
terraform -chdir=infra/dr-drill destroy -auto-approve -var "instance_name=$DRILL_ID"

echo "=== DR drill complete RTO=${RTO_SECONDS}s ==="
```

### Recipe 3 — Cross-Region Failover with Lag Check

```bash
#!/bin/bash
# Promote cross-region async replica. Capture lag at promotion time.

REPLICA="psql -h replica.us-west-2.example.com -p 5432 -U dba"

# 1. Capture state pre-promotion
LAG=$($REPLICA -tAc "SELECT extract(epoch from now() - pg_last_xact_replay_timestamp())::int;")
LAG_BYTES=$($REPLICA -tAc "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn());")
REPLAY_LSN=$($REPLICA -tAc "SELECT pg_last_wal_replay_lsn();")

echo "Pre-promotion: lag=${LAG}s, unreplayed_bytes=${LAG_BYTES}, replay_lsn=${REPLAY_LSN}"

if [ "$LAG" -gt 60 ]; then
    echo "WARNING: replica lag ${LAG}s exceeds RPO budget — proceed only if primary is truly unrecoverable"
    read -p "Continue? [y/N] " confirm
    [ "$confirm" = "y" ] || exit 1
fi

# 2. Promote
$REPLICA -c "SELECT pg_promote(wait => true, wait_seconds => 120);"

# 3. Verify
$REPLICA -tAc "SELECT pg_is_in_recovery();"  # must be f
$REPLICA -tAc "SELECT pg_current_wal_lsn();"

# 4. Capture new timeline ID
NEW_TIMELINE=$($REPLICA -tAc "SELECT substring(pg_walfile_name(pg_current_wal_lsn()), 1, 8);")
echo "New timeline: $NEW_TIMELINE"

# 5. Audit: how much was lost
echo "Data loss window: $LAG seconds, $LAG_BYTES bytes"
```

### Recipe 4 — Detect Orphaned Slots Post-Failover

```sql
-- Run on new primary after promotion
SELECT
    slot_name,
    slot_type,
    active,
    active_pid,
    restart_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
    ) AS retained_wal,
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes,
    -- PG17+ columns:
    inactive_since,
    invalidation_reason
FROM pg_replication_slots
WHERE active = false  -- or filter on retained_bytes threshold
ORDER BY retained_bytes DESC NULLS LAST;

-- Drop slots that pointed at dead old-primary's replicas:
SELECT pg_drop_replication_slot('orphaned_slot_name');
```

### Recipe 5 — Verify Backup Integrity Without Full Restore

```bash
# pg_verifybackup — verifies manifest checksums + WAL chain
# Works on directory-format pg_basebackup output

pg_verifybackup /path/to/base/backup/
# PG16+ shows progress
# PG18+ supports tar-format
pg_verifybackup --progress /path/to/base/backup/
```

### Recipe 6 — Inspect WAL Coverage (PG17+)

```sql
-- PG17+ WAL summary functions
SELECT * FROM pg_available_wal_summaries() ORDER BY end_lsn DESC LIMIT 10;
SELECT * FROM pg_get_wal_summarizer_state();

-- Confirms wal-summarization is collecting + which LSN range is covered
-- Required for pg_basebackup --incremental (PG17+) — cross-ref 84
```

### Recipe 7 — Pre-Stage DR Connection String Update

```sql
-- App config side — multiple connection strings, switch atomically
-- Example using pgBouncer database alias:

-- pgbouncer.ini:
-- [databases]
-- app_primary = host=primary.example.com port=5432 dbname=app
-- app_failover = host=replica.example.com port=5432 dbname=app

-- During DR, swap symlink or update one line + RELOAD
-- Cross-reference 81-pgbouncer.md Recipe 8 — RELOAD does NOT change listen ports

-- Verify post-failover:
SHOW server_version;  -- confirm correct cluster
SELECT inet_server_addr();  -- confirm host
SELECT pg_is_in_recovery();  -- confirm primary (false)
```

### Recipe 8 — Test Recovery_target_time Without Promotion

```ini
# Restore to right-before-incident, but PAUSE not promote
# postgresql.auto.conf
restore_command = '/usr/local/bin/wal-fetch %f %p'
recovery_target_time = '2026-05-14 03:42:00 UTC'
recovery_target_action = 'pause'  # NOT promote
```

```bash
# Start server, wait for pause
sudo systemctl start postgresql
sleep 30

# Verify paused at target
psql -c "SELECT pg_is_in_recovery(), pg_get_wal_replay_pause_state();"
# Should return: t | paused

# Inspect data
psql -c "SELECT * FROM critical_table WHERE id = 42;"

# If satisfied, resume + promote
psql -c "SELECT pg_wal_replay_resume();"
psql -c "SELECT pg_promote();"

# If not satisfied, shut down + adjust recovery_target_time
sudo systemctl stop postgresql
```

### Recipe 9 — Detect Replication-Lag-Driven RPO Violation

```sql
-- Run as continuous monitoring query
-- Alert if replay_lag exceeds RPO budget at any moment

SELECT
    application_name,
    state,
    sync_state,
    write_lag,
    flush_lag,
    replay_lag,
    extract(epoch from replay_lag) AS replay_lag_seconds,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS unreplayed_bytes
FROM pg_stat_replication
WHERE extract(epoch from replay_lag) > 60;  -- 60s RPO budget threshold
-- Cross-reference 82-monitoring.md Recipe 4
```

### Recipe 10 — Document Per-Replica RPO Posture

```sql
-- Post-deployment audit: every replica's lag posture
SELECT
    application_name,
    sync_state,
    coalesce(extract(epoch from replay_lag), 0) AS lag_seconds,
    -- This replica's effective RPO if primary fails RIGHT NOW
    CASE sync_state
        WHEN 'sync' THEN 'RPO=0 (committed-and-synced)'
        WHEN 'quorum' THEN 'RPO=0 (quorum-confirmed)'
        ELSE 'RPO=' || coalesce(extract(epoch from replay_lag)::text || 's', 'unknown')
    END AS effective_rpo
FROM pg_stat_replication
ORDER BY sync_state DESC, lag_seconds ASC;
```

### Recipe 11 — Schedule Quarterly Drill via pg_cron

```sql
-- On disposable monitoring host with pg_cron installed
-- Cross-reference 98-pg-cron.md

SELECT cron.schedule(
    'dr-drill-quarterly',
    '0 4 1 1,4,7,10 *',  -- 4am UTC on 1st of Jan/Apr/Jul/Oct
    $$SELECT trigger_dr_drill();$$  -- custom function that fires cloud automation
);
```

### Recipe 12 — Pre-Failover Sanity Check Script

```bash
#!/bin/bash
# Run BEFORE promoting a replica — sanity checks first

REPLICA="${1:-replica.example.com}"
PSQL="psql -h $REPLICA -tAc"

echo "Replica: $REPLICA"
echo "Recovery state: $($PSQL "SELECT pg_is_in_recovery();")"
echo "Last replay: $($PSQL "SELECT pg_last_xact_replay_timestamp();")"
echo "Replay LSN: $($PSQL "SELECT pg_last_wal_replay_lsn();")"
echo "Lag bytes: $($PSQL "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn());")"
echo "Hot standby state: $($PSQL "SHOW in_hot_standby;")"
echo "Replication conflicts: $($PSQL "SELECT conflicts FROM pg_stat_database WHERE datname = current_database();")"

# Confirm sufficient WAL retention
RECEIVE_LSN=$($PSQL "SELECT pg_last_wal_receive_lsn();")
echo "Last received LSN: $RECEIVE_LSN"

# Confirm data integrity sample
$PSQL "SELECT count(*), max(id), max(updated_at) FROM critical_table;"
```

### Recipe 13 — Verify Cross-Region Replica Can Become Standalone

```sql
-- Pre-DR test: confirm cross-region replica has all required configuration
SHOW wal_level;  -- must be 'replica' or 'logical'
SHOW max_wal_senders;  -- must be >0 (this replica may serve own replicas after promotion)
SHOW archive_mode;  -- must be 'always' if cross-region replica should archive WAL post-promotion
SHOW archive_command;  -- or archive_library — must be set
SHOW restore_command;  -- needed if recovery from archive

-- Verify replica's archived WAL is independent of old primary's
SELECT pg_stat_archiver;
```

---

## Gotchas

1. **Untested backup is not a backup.** Backup pipeline can silently break (auth rotated, S3 bucket retention shortened, encryption key lost). Without drill, find out during real DR. **Mitigation:** quarterly drill, automated, alerts on RTO violation.

2. **Replicas don't protect against logical corruption.** Bad migration deletes data → replicates to every standby in seconds. Replicas are zero help. Cross-reference [`88-corruption-recovery.md`](./88-corruption-recovery.md). **Mitigation:** offline backup + PITR + WORM archive.

3. **`promote_trigger_file` GUC removed in PG16.** Carry-forward configs silently do nothing. Cross-reference [`77-standby-failover.md`](./77-standby-failover.md) gotcha #1. **Mitigation:** use `pg_promote()` or `pg_ctl promote` or `promote.signal` file.

4. **Cross-region async replica RPO equals replication lag at failure moment.** If lag was 30s, lose 30s. Cross-region sync replication crippling for write latency. **Mitigation:** monitor `replay_lag` + alert above RPO budget; tier — sync local + async cross-region.

5. **Backup retention shorter than your worst-case discovery window.** Logical corruption discovered 2 weeks later → 7-day retention means you cannot PITR before the bug. **Mitigation:** retention = `MAX(SLA_RPO + investigation_time, 30 days)`.

6. **Orphaned replication slots post-failover fill disk.** New primary inherits slot definitions of old primary's replicas — those replicas may never reconnect. Slot retains WAL forever. **Mitigation:** Recipe 4 + PG18+ `idle_replication_slot_timeout`.

7. **Connection string updates miss something.** App config updated, but cron jobs / BI tools / backup tool / monitoring still point at dead old-primary. **Mitigation:** maintain single source of truth (DNS / consul / k8s Service) — every consumer reads from it.

8. **DNS TTL longer than RTO.** Update Route53 record → clients cached old IP for 5min → RTO ≥ 5min just from DNS. **Mitigation:** TTL ≤ 60s on DB DNS records.

9. **No fencing → split brain.** Network partition recovers → old primary thinks it's still primary → both accept writes. **Mitigation:** STONITH / firewall block / storage detach BEFORE promoting.

10. **`pg_rewind` requires `wal_log_hints=on` OR `data_checksums=on` at divergence time.** Cross-reference [`89-pg-rewind.md`](./89-pg-rewind.md) gotcha #1. PG18 default-on data_checksums helps but doesn't help upgrades from pre-PG18 clusters.

11. **Synchronous replication CAN block writes if sync standby fails.** `synchronous_standby_names = 'FIRST 1 (replica_1)'` + replica_1 dies = writes hang. **Mitigation:** use `ANY 1` quorum form OR `FIRST 1 (replica_1, replica_2)` for fallback.

12. **`recovery_target_inclusive = on` (default) stops AFTER target.** Want to stop right BEFORE bad transaction? Set `inclusive = off`. **Mitigation:** test target with `recovery_target_action = pause`.

13. **Multiple `recovery_target_*` GUCs set simultaneously = error.** Cross-reference [`77-standby-failover.md`](./77-standby-failover.md). Only one of `recovery_target`, `recovery_target_name`, `recovery_target_time`, `recovery_target_xid`, `recovery_target_lsn`. **Mitigation:** comment out unused.

14. **WAL archive is "soft limit." Archive failures don't stop primary.** Old WAL keeps accumulating in pg_wal until disk fills. Cross-reference [`33-wal.md`](./33-wal.md). **Mitigation:** monitor `pg_stat_archiver.last_failed_time`, alert on rising failed_count.

15. **`max_slot_wal_keep_size` default is -1 (unlimited) — abandoned slot can fill disk.** Cross-reference [`75-replication-slots.md`](./75-replication-slots.md). **Mitigation:** set to bounded value (e.g., 64GB), monitor `pg_replication_slots.wal_status`.

16. **PG18 `idle_replication_slot_timeout` operates at checkpoint time.** Not real-time. Slot invalidated at next checkpoint after timeout expires. **Mitigation:** combine with reasonable `checkpoint_timeout` (default 5min OK).

17. **`pg_verifybackup` only verifies manifest checksums — not WAL replay.** Manifest checksum match doesn't mean restore will succeed. **Mitigation:** pair with actual test restore.

18. **Logical-slot failover (PG17+) requires `failover => true` AT SLOT CREATION.** Existing slots created before PG17 — or without flag — do NOT failover. **Mitigation:** drop + recreate logical slots with flag after upgrade.

19. **Cross-version restore impossible.** Cannot restore PG16 backup into PG14 server (and vice versa). Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md). **Mitigation:** match PG major version exactly on restore host. For cross-version, use logical backup ([`83-backup-pg-dump.md`](./83-backup-pg-dump.md)).

20. **Cross-architecture restore impossible.** Cannot restore x86_64 backup on aarch64. **Mitigation:** match architecture. For cross-arch DR, logical replication or pg_dump.

21. **PG13 EOL November 2025.** Running PG13 today (2026-05-14) = no security patches, no DR-tooling fixes. **Mitigation:** upgrade. PG14 EOL Nov 2026.

22. **Disposable host's monitoring may poll prod's metrics.** Restore drill spins up host with same hostname → Prometheus targets it → graphs show prod metrics from disposable host. **Mitigation:** drill hosts use unique hostname + isolated monitoring.

23. **DR runbook lives in same system that just failed.** Runbook in Confluence which is in same region → region outage → no runbook access. **Mitigation:** offline PDF + printed copy + cross-region mirror.

---

## See Also

- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — xmin horizon implications during recovery
- [`33-wal.md`](./33-wal.md) — WAL fundamentals
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint mechanics during recovery
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pg_promote` role + replication role grants
- [`73-streaming-replication.md`](./73-streaming-replication.md) — sync/async replication mechanics
- [`74-logical-replication.md`](./74-logical-replication.md) — logical replication topology
- [`75-replication-slots.md`](./75-replication-slots.md) — slot management + invalidation
- [`77-standby-failover.md`](./77-standby-failover.md) — failover procedure + timeline
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA pattern catalog
- [`79-patroni.md`](./79-patroni.md) — Patroni automated failover
- [`82-monitoring.md`](./82-monitoring.md) — replication lag + archiver monitoring
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — logical backup
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — physical backup + PITR mechanics (canonical procedure)
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest, Barman, WAL-G
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — major-version upgrade
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — EOL timeline + version-strategy decision
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — corruption detection + pg_amcheck + pg_resetwal
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged old primary
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — operator-managed DR (CloudNativePG, etc.)
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-environment DR constraints

---

## Sources

[^pg14-relnotes]: PostgreSQL 14 release notes — https://www.postgresql.org/docs/14/release-14.html

[^pg15-relnotes]: PostgreSQL 15 release notes — https://www.postgresql.org/docs/15/release-15.html

[^pg16-relnotes]: PostgreSQL 16 release notes — https://www.postgresql.org/docs/16/release-16.html. Includes the headline DR gotcha: `promote_trigger_file` removed (Simon Riggs).

[^pg17-relnotes]: PostgreSQL 17 release notes — https://www.postgresql.org/docs/17/release-17.html. Includes WAL summarization framework, logical-slot failover, slot-state monitoring columns.

[^pg18-relnotes]: PostgreSQL 18 release notes — https://www.postgresql.org/docs/18/release-18.html. Includes `pg_verifybackup` tar-format support and `idle_replication_slot_timeout`.

[^backup]: PostgreSQL 16 — Chapter 26: Backup and Restore — https://www.postgresql.org/docs/16/backup.html

[^cont-arch]: PostgreSQL 16 — Continuous Archiving and Point-in-Time Recovery (PITR) — https://www.postgresql.org/docs/16/continuous-archiving.html

[^warm-standby]: PostgreSQL 16 — Log-Shipping Standby Servers — https://www.postgresql.org/docs/16/warm-standby.html

[^high-availability]: PostgreSQL 16 — Chapter 27: High Availability, Load Balancing, and Replication — https://www.postgresql.org/docs/16/high-availability.html

[^monitoring]: PostgreSQL 16 — The Cumulative Statistics System — https://www.postgresql.org/docs/16/monitoring-stats.html

[^app-pgbasebackup]: PostgreSQL 16 — pg_basebackup — https://www.postgresql.org/docs/16/app-pgbasebackup.html

[^app-pgrewind]: PostgreSQL 16 — pg_rewind — https://www.postgresql.org/docs/16/app-pgrewind.html

[^runtime-config-wal]: PostgreSQL 16 — Server Configuration: WAL, archiving, recovery, recovery-target — https://www.postgresql.org/docs/16/runtime-config-wal.html

[^recovery-config]: PostgreSQL 16 — Appendix O.1: recovery.conf compatibility note — https://www.postgresql.org/docs/16/recovery-config.html

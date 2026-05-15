# Transaction ID Wraparound

PostgreSQL transaction IDs (XIDs) are 32-bit integers. After ~4 billion transactions the counter wraps around to zero, and without preventive maintenance every existing row becomes "in the future" to every reader and the cluster shuts down to protect data. **Autovacuum prevents this automatically; you only see wraparound trouble when autovacuum has been failing for a long time.**

This file is the dedicated wraparound deep dive. The data-structure side (xmin, xmax, FrozenTransactionId, snapshot construction) lives in [`27-mvcc-internals.md`](./27-mvcc-internals.md); the VACUUM command surface lives in [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — five rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The 32-bit XID space](#the-32-bit-xid-space)
    - [Freezing — FrozenTransactionId sentinel](#freezing--frozentransactionid-sentinel)
    - [Per-relation and per-database bookkeeping](#per-relation-and-per-database-bookkeeping)
    - [The three freeze thresholds](#the-three-freeze-thresholds)
    - [Anti-wraparound autovacuum](#anti-wraparound-autovacuum)
    - [The vacuum failsafe (PG14+)](#the-vacuum-failsafe-pg14)
    - [Warning and hard-stop thresholds](#warning-and-hard-stop-thresholds)
    - [MultiXact wraparound (independent counter)](#multixact-wraparound-independent-counter)
    - [The four sources that hold xmin horizon back](#the-four-sources-that-hold-xmin-horizon-back)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Reach for this file when:

- A monitoring alert fires on `age(datfrozenxid)` or `age(relfrozenxid)`.
- The server log contains `WARNING: database "X" must be vacuumed within N transactions` or the hard-stop `ERROR: database is not accepting commands to avoid wraparound data loss`.
- You are tuning `autovacuum_freeze_max_age`, `vacuum_freeze_min_age`, `vacuum_freeze_table_age`, or the PG14+ `vacuum_failsafe_age`.
- You inherited a cluster and want to audit whether autovacuum is keeping up with freeze obligations.
- You need to understand why disabling autovacuum on a busy table is operationally catastrophic, or why a long-running transaction / abandoned replication slot can drag a cluster toward wraparound.
- You are asked about "single-user-mode wraparound recovery" — the docs themselves disagree with the in-server `HINT` that tells you to do it. The right runbook is in this file's Recipes section.

Skip this file if you only need the VACUUM command grammar ([`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)), the tuple-header bit layout ([`27-mvcc-internals.md`](./27-mvcc-internals.md)), or general bloat triage (also `28`).


## Mental Model — five rules


1. **XIDs are 32-bit. The safety margin is ~2 billion transactions, not 4 billion.** Half the XID space is "the past" and half is "the future" of any given reference XID — wraparound becomes catastrophic at 2^31, not 2^32. The docs state it precisely: *"it is necessary to vacuum every table in every database at least once every two billion transactions."*[^routine]

2. **Freezing replaces a tuple's `xmin` with a sentinel.** The sentinel is `FrozenTransactionId` (numeric value 2 — defined in `src/include/access/transam.h`). The docs: *"PostgreSQL reserves a special XID, FrozenTransactionId, which does not follow the normal XID comparison rules and is always considered older than every normal XID."*[^routine] Once a tuple's xmin is frozen, no XID comparison can ever make it "in the future."

3. **Autovacuum runs anti-wraparound vacuums even when autovacuum is disabled.** The docs are emphatic: *"autovacuum is invoked on any table that might contain unfrozen rows with XIDs older than the age specified by ... `autovacuum_freeze_max_age`. (This will happen even if autovacuum is disabled.)"*[^routine] Setting `autovacuum = off` on a table or cluster-wide does not exempt you.

4. **Long-running transactions, abandoned replication slots, stale prepared transactions, and `hot_standby_feedback` from standbys all pin the xmin horizon.** When the horizon cannot advance, VACUUM cannot freeze — even running constantly. No autovacuum-tuning change helps; the operator must find and clear the blocker. Cross-reference [`27-mvcc-internals.md`](./27-mvcc-internals.md) for the five-source enumeration.

5. **Single-user mode is rarely the right answer.** The in-server hint that fires at the hard-stop threshold says *"Stop the postmaster and vacuum that database in single-user mode."* The docs contradict this same hint two paragraphs later: *"Contrary to what the hint states, it is not necessary or desirable to stop the postmaster or enter single user-mode in order to restore normal operation."*[^routine] The right runbook is "VACUUM in normal multi-user mode after killing whatever is holding the horizon back."

> [!WARNING] PG18 did NOT introduce 64-bit XIDs.
> A common misconception in the lead-up to PG18 was that wraparound concerns would become historical. **PostgreSQL 18 is still 32-bit XIDs.** PG18 did improve normal vacuum's ability to opportunistically freeze pages (the new `vacuum_max_eager_freeze_failure_rate` GUC and `pg_class.relallfrozen` column),[^pg18-eager] but the fundamental 2-billion-transaction obligation is unchanged. Plan capacity accordingly.


## Decision Matrix


| Situation | Action | Cross-reference |
|---|---|---|
| Cluster is healthy, age is well below 200M | Rely on autovacuum, monitor weekly | Recipe 1 |
| `age(datfrozenxid)` climbing despite autovacuum running | Find the xmin-horizon blocker | Recipe 2, [`27 §xmin-horizon`](./27-mvcc-internals.md#xmin-horizon--the-five-sources) |
| Hot table has age > 200M and autovacuum can't keep up | Per-table tune `autovacuum_freeze_max_age` lower; raise `autovacuum_vacuum_cost_limit` | Recipe 4 |
| Approaching 400M (anti-wraparound about to launch) | Schedule a maintenance window to let it complete; do not cancel it | Recipe 6 |
| Past 1B age, failsafe (1.6B) imminent | Stop conflicting DDL, drop cost throttling, let VACUUM run | Recipe 7 |
| Warning fires (~40M XIDs left) | Identify largest table by age, manual `VACUUM FREEZE` | Recipe 8 |
| Hard stop fires (3M XIDs left) | **Do not enter single-user mode** — clear the horizon blocker, then run VACUUM in normal mode | Recipe 9 |
| Cluster won't start (e.g., wraparound + crash) | Last resort: `pg_resetwal`, then immediately dump/initdb/restore | Recipe 10 |
| MultiXact age > 400M | Same procedure as XID, with MultiXact-specific GUCs | Recipe 11 |
| Pre-emptively freeze a write-once partition | `VACUUM FREEZE` on the leaf during off-hours | Recipe 5, [`28 §VACUUM FREEZE`](./28-vacuum-autovacuum.md#vacuum-freeze-deep-dive) |

Three smell signals for real wraparound risk:

- `last_autovacuum` advances but `age(relfrozenxid)` stays high → xmin horizon held back; autovacuum is running but cannot freeze.
- Autovacuum log lines show `(to prevent wraparound)` in the activity prefix → anti-wraparound autovacuum is already running and **cannot be cancelled by `lock_timeout` or session statement timeout**.[^routine]
- Cluster has been up >1 year with default `autovacuum_freeze_max_age = 200M` and you've never seen an anti-wraparound vacuum — almost certainly the horizon is held back.


## Syntax / Mechanics


### The 32-bit XID space


Every transaction that writes (or that explicitly assigns an XID via `pg_current_xact_id()`) consumes exactly one 32-bit XID. The counter starts at 3 (values 0, 1, 2 are reserved sentinels) and advances monotonically.

XID comparisons use modular-2^32 arithmetic with the *current XID* as the reference point: half the space is treated as "past" and half as "future." This means the practical safety margin is **2^31 transactions ≈ 2.1 billion**, not 2^32.[^routine]

| Reserved XID | Symbolic name | Meaning |
|---|---|---|
| 0 | `InvalidTransactionId` | Used as "no transaction" / NULL in some contexts |
| 1 | `BootstrapTransactionId` | Set during `initdb` bootstrap |
| 2 | `FrozenTransactionId` | Always-older-than-everything sentinel — what freezing writes into `t_xmin` |
| 3..2^32-1 | Normal XIDs | Allocated to writing transactions |

The docs again: *"transaction IDs have limited size (32 bits) a cluster that runs for a long time (more than 4 billion transactions) would suffer transaction ID wraparound: the XID counter wraps around to zero, and all of a sudden transactions that were in the past appear to be in the future ... In short, catastrophic data loss."*[^routine]


### Freezing — FrozenTransactionId sentinel


Freezing is the act of writing the `HEAP_XMIN_FROZEN` bit (or setting `t_xmin = 2` in pre-9.4 layouts) on a tuple whose `xmin` is older than `vacuum_freeze_min_age` (default 50M).[^vacuum-freeze-min-age] Once frozen, a tuple is visible to every future transaction forever — the XID is no longer compared.

Two ways a tuple becomes frozen:

1. **Lazy freezing** during plain VACUUM. The page is scanned because of dead-tuple work; VACUUM opportunistically freezes eligible tuples while it's there.
2. **Aggressive freezing** during VACUUM FREEZE or during the aggressive pass that VACUUM triggers when `age(relfrozenxid) > vacuum_freeze_table_age` (default 150M).[^vacuum-freeze-table-age]

> [!NOTE] PostgreSQL 16
> Verbatim: *"Improve vacuum freeze performance"* and the new opportunistic-freezing behavior — *"Reduce the overhead of freezing tuples ... vacuum will now opportunistically freeze additional pages."*[^pg16-freeze] This made non-aggressive VACUUM more capable of freezing on its own, reducing the gap between routine VACUUM and the eventual anti-wraparound vacuum.

> [!NOTE] PostgreSQL 18
> Verbatim: *"Allow normal vacuums to freeze some pages, even though they are all-visible (Melanie Plageman) ... The aggressiveness of this can be controlled by ... `vacuum_max_eager_freeze_failure_rate`. Previously vacuum never processed all-visible pages until freezing was required."*[^pg18-eager] Plus a new `pg_class.relallfrozen` column to track how many pages are fully frozen.[^pg18-relallfrozen]


### Per-relation and per-database bookkeeping


Three fields drive the wraparound bookkeeping:

| Catalog field | Meaning | Advanced by |
|---|---|---|
| `pg_class.relfrozenxid` | The oldest XID that might still appear unfrozen in this relation | VACUUM after a successful pass |
| `pg_database.datfrozenxid` | `MIN(relfrozenxid)` across all tables in this database | VACUUM that touches the last-blocking table |
| Cluster-wide horizon | `MIN(datfrozenxid)` across **every database**, including templates | Set as a side effect of per-database advances |

The cluster-wide minimum is what gates everything. **One database with stuck freeze advancement holds the whole cluster back** — this is why `template0` / `template1` / unused databases must still be vacuumed (and are, automatically, by the autovacuum launcher visiting every database).

`pg_database.datminmxid` and `pg_class.relminmxid` are the analogous fields for MultiXact aging.

The canonical monitoring query:

    SELECT datname,
           age(datfrozenxid)                                AS xid_age,
           2147483647 - age(datfrozenxid)                   AS xids_left_before_wraparound,
           current_setting('autovacuum_freeze_max_age')::int AS auto_freeze_threshold,
           mxid_age(datminmxid)                             AS mxid_age
    FROM pg_database
    ORDER BY age(datfrozenxid) DESC;

The relation-level variant for finding the table holding a database back:

    SELECT c.relnamespace::regnamespace AS schema,
           c.relname,
           age(c.relfrozenxid) AS xid_age,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
           c.relkind
    FROM pg_class c
    WHERE c.relkind IN ('r', 'm', 't')      -- regular tables, matviews, TOAST
    ORDER BY age(c.relfrozenxid) DESC
    LIMIT 20;

Recipes 1 and 2 are the production-quality versions of these queries.


### The three freeze thresholds


PostgreSQL has *three* freeze-age thresholds. They escalate in aggression as the relation ages:

| GUC | Default | Effect | Verbatim docs |
|---|---|---|---|
| `vacuum_freeze_min_age` | 50,000,000 | Minimum XID age before a tuple becomes *eligible* for freezing during a routine vacuum | *"Specifies the cutoff age (in transactions) that VACUUM should use to decide whether to freeze row versions while scanning a table"*[^vacuum-freeze-min-age] |
| `vacuum_freeze_table_age` | 150,000,000 | When `age(relfrozenxid) > this`, the next VACUUM is *aggressive* (scans every page, including all-visible) | *"VACUUM performs an aggressive scan if the table's pg_class.relfrozenxid field has reached the age specified by this setting"*[^vacuum-freeze-table-age] |
| `autovacuum_freeze_max_age` | 200,000,000 | When `age(relfrozenxid) > this`, autovacuum forces an anti-wraparound vacuum **even if autovacuum is disabled** | *"Specifies the maximum age (in transactions) that a table's pg_class.relfrozenxid field can attain before a VACUUM operation is forced to prevent transaction ID wraparound within the table"*[^autovacuum-freeze-max-age] |

Important silent-capping rules from the docs:

- `vacuum_freeze_min_age` is *silently limited to half the value of `autovacuum_freeze_max_age`*.[^vacuum-freeze-min-age] So if you raise `autovacuum_freeze_max_age` to 1B but leave `vacuum_freeze_min_age` at 50M, that's fine; if you set `vacuum_freeze_min_age` to 500M without raising `autovacuum_freeze_max_age`, it caps at 100M effectively.
- `vacuum_freeze_table_age` is *silently limited to 95% of `autovacuum_freeze_max_age`*.[^vacuum-freeze-table-age] Set them together, not independently.
- The "can only set smaller" per-table override rule applies to all three (storage parameters override GUCs only when they make freezing *more* eager).[^routine]


### Anti-wraparound autovacuum


When `age(relfrozenxid) > autovacuum_freeze_max_age`, the autovacuum launcher schedules an anti-wraparound vacuum for the table. Three operational properties distinguish it from ordinary autovacuum:

1. **Runs even when `autovacuum = off`** (cluster-wide or per-table).[^routine] The `ALTER TABLE ... SET (autovacuum_enabled = false)` docs are explicit: *"If false, this table will not be autovacuumed, except to prevent transaction ID wraparound."*[^per-table-autovac]
2. **Cannot be auto-cancelled by lock conflicts**. Routine autovacuum yields when it finds a session waiting for a conflicting lock; anti-wraparound vacuum **does not**. It will hold its `SHARE UPDATE EXCLUSIVE` lock indefinitely against blocked DDL.
3. **Tagged in `pg_stat_activity`**. The `query` column shows `autovacuum: VACUUM public.events (to prevent wraparound)`. The `(to prevent wraparound)` suffix is the canonical "this is anti-wraparound, don't kill it" signal.

The diagnostic query to find anti-wraparound autovacuums in progress:

    SELECT pid, datname, usename,
           now() - xact_start AS running_for,
           wait_event_type, wait_event,
           query
    FROM pg_stat_activity
    WHERE backend_type = 'autovacuum worker'
      AND query LIKE '%(to prevent wraparound)%';


### The vacuum failsafe (PG14+)


When `age(relfrozenxid) > vacuum_failsafe_age` (default 1.6 billion[^vacuum-failsafe-age]), VACUUM enters a "strategy of last resort" mode:

- **Cost-based delays are disabled** (`vacuum_cost_delay` is ignored).
- **Index vacuuming is skipped** (line-pointer cleanup deferred). Index entries pointing at dead tuples remain, but the index won't bloat catastrophically because dead tuples cannot be reused until they're cleaned, which only happens after the failsafe is no longer needed.
- The goal is to push `relfrozenxid` forward as fast as possible, sacrificing other vacuum work.

Verbatim docs: *"VACUUM takes extraordinary measures to avoid system-wide transaction ID wraparound failure if the table's `pg_class.relfrozenxid` field has reached the age specified by this setting."*[^vacuum-failsafe-age] And: *"The setting is silently limited to no less than 105% of `autovacuum_freeze_max_age`."*[^vacuum-failsafe-age]

> [!NOTE] PostgreSQL 14
> Verbatim: *"Cause vacuum operations to be more aggressive if the table is near xid or multixact wraparound (Masahiko Sawada, Peter Geoghegan) ... This is controlled by `vacuum_failsafe_age` and `vacuum_multixact_failsafe_age`."*[^pg14-failsafe] Also: *"Increase warning time and hard limit before transaction id and multi-transaction wraparound (Noah Misch) ... This should reduce the possibility of failures that occur without having issued warnings about wraparound."*[^pg14-warnings] Pre-PG14 clusters had a smaller warning runway.


### Warning and hard-stop thresholds


PostgreSQL emits two server-log messages on every transaction allocation when the database is approaching wraparound:

| Trigger | Message |
|---|---|
| `age(datfrozenxid) > 2^31 − 40,000,000` (≈40M XIDs left until catastrophe) | `WARNING: database "mydb" must be vacuumed within N transactions / HINT: To avoid a database shutdown, execute a database-wide VACUUM in that database.`[^routine] |
| `age(datfrozenxid) > 2^31 − 3,000,000` (3M XIDs left) | `ERROR: database is not accepting commands to avoid wraparound data loss in database "mydb" / HINT: Stop the postmaster and vacuum that database in single-user mode.`[^routine] |

At the hard-stop threshold the database refuses new transactions (XID allocation is blocked). Existing transactions complete, but no new work can start until VACUUM advances `datfrozenxid`.

**The hint message is misleading.** Docs: *"Contrary to what the hint states, it is not necessary or desirable to stop the postmaster or enter single user-mode in order to restore normal operation."*[^routine] Keep the postmaster running, identify the xmin horizon blocker, clear it, let VACUUM run normally. See Recipe 9 for the runbook.


### MultiXact wraparound (independent counter)


MultiXacts are an entirely separate 32-bit counter, used when multiple transactions hold non-conflicting locks on the same row (typically `FOR KEY SHARE` from foreign-key checks). Their wraparound is **independent of XID wraparound** — you can hit MultiXact wraparound with healthy XID age, or vice versa.

| GUC | Default | Effect |
|---|---|---|
| `vacuum_multixact_freeze_min_age` | 5,000,000 | Minimum MXID age before freeze-eligible[^multi-freeze-min] |
| `vacuum_multixact_freeze_table_age` | 150,000,000 | Aggressive multixact scan threshold[^multi-freeze-table] |
| `autovacuum_multixact_freeze_max_age` | 400,000,000 | Anti-wraparound MXID threshold[^autovac-multi-max] |
| `vacuum_multixact_failsafe_age` | 1,600,000,000 | Multixact failsafe (PG14+)[^multi-failsafe] |

Note `vacuum_multixact_freeze_min_age` defaults to **5M** (not 50M like the XID equivalent) and `autovacuum_multixact_freeze_max_age` defaults to **400M** (not 200M).

Additional MultiXact members-storage trigger: *"if the storage occupied by multixacts members exceeds about 10GB, aggressive vacuum scans will occur more often ... The members storage area can grow up to about 20GB before reaching wraparound."*[^routine] This means a workload with heavy `FOR KEY SHARE` row-locking (e.g., many concurrent FK checks) can trigger MultiXact-driven autovacuums even at low MXID age.

Monitoring:

    SELECT datname,
           mxid_age(datminmxid)                                    AS mxid_age,
           400000000 - mxid_age(datminmxid)                        AS mxids_below_auto_threshold,
           pg_size_pretty(pg_database_size(datname))               AS db_size
    FROM pg_database
    ORDER BY mxid_age(datminmxid) DESC;

Hard-stop for MultiXacts: *"the system will refuse to generate new MXIDs once there are fewer than three million left until wraparound."*[^routine]


### The four sources that hold xmin horizon back


VACUUM cannot freeze a tuple whose `xmin` is newer than the cluster-wide xmin horizon — the horizon is the oldest XID still potentially needed by any reader. When the horizon stalls, freeze advancement stalls.

| Source | Symptom | Diagnostic | Fix |
|---|---|---|---|
| Idle-in-transaction session | Long `xact_start`, `state = 'idle in transaction'` | `pg_stat_activity` | `pg_terminate_backend(pid)`; set `idle_in_transaction_session_timeout` |
| Long-running query | Same session running a single statement for hours | `pg_stat_activity` `state = 'active'` with old `xact_start` | Kill it; set `statement_timeout` |
| Abandoned replication slot | `pg_replication_slots.xmin` ≪ current XID and slot is `inactive` | `pg_replication_slots` | `pg_drop_replication_slot(slot_name)` if confirmed orphan; set `max_slot_wal_keep_size` |
| Stale prepared transaction | `pg_prepared_xacts` row that's been there for hours/days | `pg_prepared_xacts` | `ROLLBACK PREPARED 'gid'`; set `max_prepared_transactions = 0` if you don't use 2PC |

Plus `hot_standby_feedback` from a standby — see [`27 §xmin-horizon`](./27-mvcc-internals.md#xmin-horizon--the-five-sources) for the full enumeration.

The canonical "find the backend holding the horizon back" query (see [`27-mvcc-internals.md`](./27-mvcc-internals.md) Recipe 2):

    SELECT pid, datname, usename, application_name,
           state, backend_xmin,
           age(backend_xmin) AS xmin_age,
           now() - xact_start AS running_for,
           query
    FROM pg_stat_activity
    WHERE backend_xmin IS NOT NULL
    ORDER BY age(backend_xmin) DESC
    LIMIT 10;


### Per-version timeline


| Version | Wraparound-relevant change | Citation |
|---|---|---|
| PG13 | Insert-triggered autovacuum (`autovacuum_vacuum_insert_threshold` / `_scale_factor`) — relevant because insert-heavy tables previously needed anti-wraparound vacuum to ever scan their pages | [^pg13-insert] |
| PG14 | `vacuum_failsafe_age` + `vacuum_multixact_failsafe_age` GUCs (default 1.6B / 1.6B); earlier wraparound warnings; per-index autovacuum logging | [^pg14-failsafe] [^pg14-warnings] |
| PG15 | More aggressive freeze of oldest XIDs / MXIDs during normal vacuum | [^pg15-freeze] |
| PG16 | Opportunistic page freezing during non-freeze VACUUM (reduces lag between routine and anti-wraparound vacuum) | [^pg16-freeze] |
| PG17 | VACUUM no longer silently capped at 1GB of `maintenance_work_mem` (single-pass vacuum on huge tables); more efficient freeze WAL records; `old_snapshot_threshold` removed | [^pg17-mem] [^pg17-freeze-wal] [^pg17-ost] |
| PG18 | Eager freezing during normal vacuum + `vacuum_max_eager_freeze_failure_rate` GUC; new `pg_class.relallfrozen` column; **NO 64-bit XIDs** | [^pg18-eager] [^pg18-relallfrozen] |


## Examples / Recipes


### Recipe 1 — Baseline wraparound monitoring


Run weekly (or hourly on high-TPS clusters). Returns the percentage of the safety budget consumed for both XID and MXID.

    SELECT datname,
           age(datfrozenxid)                                              AS xid_age,
           round(100.0 * age(datfrozenxid) / 2147483647, 2)               AS xid_pct_to_wraparound,
           round(100.0 * age(datfrozenxid)
                  / current_setting('autovacuum_freeze_max_age')::int, 2) AS xid_pct_to_autovac,
           mxid_age(datminmxid)                                           AS mxid_age,
           round(100.0 * mxid_age(datminmxid) / 2147483647, 2)            AS mxid_pct_to_wraparound
    FROM pg_database
    ORDER BY age(datfrozenxid) DESC;

Alert thresholds (defaults):

- `xid_pct_to_autovac > 50` → autovacuum will fire soon, but no emergency
- `xid_pct_to_autovac > 90` → anti-wraparound likely already running
- `xid_pct_to_wraparound > 50` → investigate immediately (over 1 billion age)
- `xid_pct_to_wraparound > 75` → P1 incident
- `xid_pct_to_wraparound > 95` → hard-stop imminent; warning messages should already be in the log


### Recipe 2 — Find the table holding a database back


    SELECT c.relnamespace::regnamespace AS schema,
           c.relname,
           c.relkind,
           age(c.relfrozenxid)                AS xid_age,
           mxid_age(c.relminmxid)             AS mxid_age,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
           s.last_autovacuum,
           s.last_vacuum,
           s.n_dead_tup,
           s.autovacuum_count
    FROM pg_class c
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind IN ('r', 'm', 't')
    ORDER BY age(c.relfrozenxid) DESC
    LIMIT 20;

Two diagnostic branches from this query:

- `last_autovacuum` recent but `xid_age` still high → xmin horizon is held back (see Recipe 3).
- `last_autovacuum` is NULL or very old → autovacuum isn't visiting this table at all. Check `pg_class.reloptions` for `autovacuum_enabled = false`, check `track_counts` GUC, check if statistics-collector is healthy.


### Recipe 3 — Identify what is blocking xmin horizon


Already in [`27 Recipe 2`](./27-mvcc-internals.md), reproduced here for standalone readability:

    SELECT pid, datname, usename, application_name,
           state, backend_xmin,
           age(backend_xmin) AS xmin_age,
           now() - xact_start AS xact_duration,
           wait_event_type, wait_event,
           left(query, 200) AS query
    FROM pg_stat_activity
    WHERE backend_xmin IS NOT NULL
    ORDER BY age(backend_xmin) DESC
    LIMIT 10;

Then in parallel:

    SELECT slot_name, slot_type, database, active,
           xmin, catalog_xmin,
           age(coalesce(xmin, catalog_xmin)) AS slot_xmin_age,
           pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_retained
    FROM pg_replication_slots
    ORDER BY age(coalesce(xmin, catalog_xmin)) DESC NULLS LAST;

    SELECT gid, prepared, age(transaction) AS xact_age, owner, database
    FROM pg_prepared_xacts
    ORDER BY age(transaction) DESC;


### Recipe 4 — Per-table autovacuum tuning for a hot append-only table


For a high-insert-rate table (e.g., 100M+ rows/day), lower `autovacuum_freeze_max_age` so anti-wraparound vacuum happens more often but each pass is cheaper:

    ALTER TABLE public.events SET (
        autovacuum_freeze_max_age           = 100000000,   -- half default (200M)
        autovacuum_multixact_freeze_max_age = 200000000,   -- half default (400M)
        autovacuum_vacuum_cost_limit        = 2000,        -- 10x default (200)
        autovacuum_vacuum_cost_delay        = 2            -- ms
    );

Per-table values **must be smaller** than the cluster-wide GUC equivalents (the "can only set smaller" rule). Raising per-table requires raising the cluster GUC first.

Verify:

    SELECT relname, reloptions
    FROM pg_class
    WHERE oid = 'public.events'::regclass;


### Recipe 5 — Pre-emptively freeze a write-once partition


Append-only / write-once data (e.g., monthly events partitions) should be aggressively frozen as soon as new writes stop. Schedule this for each rolled-out partition:

    VACUUM (FREEZE, ANALYZE, PARALLEL 4) public.events_2026_04;

This collapses three obligations (free dead tuples, freeze tuples, refresh stats) into one heap scan. Cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the `PARALLEL` semantics — it parallelizes index work, not the heap scan.

For a `pg_cron`-scheduled rotation, see [`98-pg-cron.md`](./98-pg-cron.md) and [`35-partitioning.md`](./35-partitioning.md).


### Recipe 6 — Monitor a running anti-wraparound vacuum


    SELECT a.pid,
           a.datname,
           p.relid::regclass    AS table,
           p.phase,
           pg_size_pretty(p.heap_blks_total * 8192)    AS heap_size,
           round(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 1) AS pct_done,
           a.wait_event_type,
           a.wait_event,
           now() - a.xact_start AS running_for
    FROM pg_stat_progress_vacuum p
    JOIN pg_stat_activity a ON a.pid = p.pid
    WHERE a.query LIKE '%(to prevent wraparound)%';

The `phase` column shows the seven phases (initializing / scanning heap / vacuuming indexes / vacuuming heap / cleaning up indexes / truncating heap / performing final cleanup).

> [!NOTE] PostgreSQL 17
> The `pg_stat_progress_vacuum` view columns `max_dead_tuples` and `num_dead_tuples` were renamed to `max_dead_tuple_bytes` and `num_dead_item_ids`, and a new `dead_tuple_bytes` column was added.[^pg17-progress-rename] If your monitoring queries reference the old names, update them before upgrading to PG17.


### Recipe 7 — Failsafe is active: drop the throttle


When `age(relfrozenxid) > 1.6B` (or the PG14+ `vacuum_failsafe_age` you've configured), VACUUM already disables cost-based throttling. But manual VACUUM defaults to `vacuum_cost_delay = 0` (no throttling) anyway, so a manual rescue VACUUM is the fastest path:

    -- on the offending database, as superuser or table owner
    SET vacuum_cost_delay = 0;                  -- defensive: should already be 0 for manual
    SET maintenance_work_mem = '4GB';           -- much bigger than default 64MB
    VACUUM (FREEZE, PARALLEL 4, VERBOSE) public.huge_table;

> [!NOTE] PostgreSQL 17+
> Pre-PG17 VACUUM was silently capped at 1GB of `maintenance_work_mem` regardless of how high you set it.[^pg17-mem] On PG17+ the cap is removed; setting `4GB` for a single-pass vacuum on a 500GB table now actually uses 4GB. Pre-PG17 clusters should not bother setting it above 1GB.


### Recipe 8 — Warning level: manual VACUUM FREEZE


When `WARNING: database "X" must be vacuumed within N transactions` fires (~40M XIDs left):

1. Verify horizon is moving (Recipe 3). **Do not skip this.** A VACUUM cannot freeze if the horizon is pinned, regardless of how aggressively you run it.
2. Identify the offending database (the warning message names it).
3. Connect to that database and freeze the largest-age table first:

        VACUUM (FREEZE, VERBOSE, PARALLEL 4) ONLY public.events;

4. Continue in age-descending order until `age(datfrozenxid) < autovacuum_freeze_max_age`.

`vacuumdb` from the command line is the parallel alternative:

    vacuumdb --all --freeze --jobs=8 --analyze --verbose

Use `--analyze-in-stages` if you have a tight maintenance window — it does three coarse-to-fine `ANALYZE` passes so the planner has *some* stats early.


### Recipe 9 — Hard stop level: cluster refusing commands


When `ERROR: database is not accepting commands to avoid wraparound data loss` fires:

1. **Do NOT stop the postmaster.** The in-server hint is wrong; the docs themselves contradict it.[^routine]
2. Connect as superuser (the connection limit is still allowed for superusers up to a small reserve).
3. Run Recipe 3 to find the xmin-horizon blocker. The hard stop is almost always caused by a stuck blocker, not by autovacuum being too slow.
4. Clear the blocker:
   - `SELECT pg_terminate_backend(pid)` for idle-in-transaction sessions
   - `ROLLBACK PREPARED 'gid'` for stale prepared transactions
   - `SELECT pg_drop_replication_slot('name')` for abandoned slots (verify orphan first)
5. Connect to the offending database and run `VACUUM (FREEZE, VERBOSE) ONLY <largest-age-table>;` in age-descending order.
6. Monitor `age(datfrozenxid)` until it drops below `autovacuum_freeze_max_age`.
7. Commands accept again automatically as soon as the database's `datfrozenxid` advances past the hard-stop threshold.

**Why not single-user mode?** Three reasons: (a) it requires postmaster shutdown, multiplying downtime; (b) it serializes the whole cluster instead of letting you parallelize across databases; (c) the underlying cause (a stuck horizon-blocker) is the same in both modes and must be cleared either way.

The only scenario where single-user mode is appropriate is *if the postmaster won't start at all* due to other corruption — that's Recipe 10's territory.


### Recipe 10 — Last resort: pg_resetwal


`pg_resetwal` is the nuclear option, used **only when the server refuses to start** due to control-file corruption, missing WAL, or a wraparound situation so severe that the cluster cannot even open a connection.

Docs: *"It should be used only as a last resort, when the server will not start due to such corruption."* And: *"After running this command, it should be possible to start the server, but bear in mind that the database might contain inconsistent data due to partially-committed transactions. You should immediately dump your data, run initdb, and restore."*[^pg-resetwal]

Procedure:

    # ensure server is stopped
    pg_ctl -D /var/lib/postgresql/16/main stop -m immediate

    # back up everything first
    cp -a /var/lib/postgresql/16/main /backup/main.pre-resetwal

    # examine current control values (do not modify yet)
    pg_resetwal --dry-run -D /var/lib/postgresql/16/main

    # actually reset (use -f only if dry-run looked reasonable)
    pg_resetwal -f -D /var/lib/postgresql/16/main

    # start the server
    pg_ctl -D /var/lib/postgresql/16/main start

    # IMMEDIATELY dump everything
    pg_dumpall -f /backup/post-resetwal-dump.sql

    # then: rm -rf data dir, initdb, restore the dump

To manually advance the XID counter:

    # the safe value is largest pg_xact filename + 1, multiplied by 1048576 (0x100000)
    ls /var/lib/postgresql/16/main/pg_xact | tail -1
    # e.g., if file is 02FB, next safe XID = (0x02FC * 0x100000) = 50069504
    pg_resetwal -x 50069504 -D /var/lib/postgresql/16/main

**Cross-reference [`88-corruption-recovery.md`](./88-corruption-recovery.md)** for the full corruption-recovery surface — `pg_resetwal` is one tool among several.


### Recipe 11 — MultiXact wraparound runbook


Same as XID wraparound (Recipes 8 and 9), but using the MultiXact GUCs:

    -- find which DB is closest to MXID wraparound
    SELECT datname, mxid_age(datminmxid) AS mxid_age
    FROM pg_database
    ORDER BY mxid_age(datminmxid) DESC LIMIT 5;

    -- find which table within that DB
    SELECT c.relnamespace::regnamespace AS schema,
           c.relname,
           mxid_age(c.relminmxid) AS mxid_age,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    WHERE c.relkind IN ('r', 'm', 't')
      AND c.relminmxid IS NOT NULL
    ORDER BY mxid_age(c.relminmxid) DESC LIMIT 20;

    -- vacuum with multixact freeze
    VACUUM (FREEZE, VERBOSE) ONLY public.high_lock_table;

Cross-reference [`27 §MultiXact`](./27-mvcc-internals.md#multixact-and-tuple-locking) for what creates MultiXacts. Heavy FK enforcement / heavy `FOR KEY SHARE` workloads are the usual sources.


### Recipe 12 — Audit tables with autovacuum disabled


Tables with `autovacuum_enabled = false` will *still* receive anti-wraparound autovacuum (mandatory), but they accumulate dead tuples and bloat in the meantime. Audit:

    SELECT n.nspname AS schema,
           c.relname,
           c.relkind,
           c.reloptions,
           age(c.relfrozenxid) AS xid_age,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND array_to_string(c.reloptions, ',') ILIKE '%autovacuum_enabled=false%'
    ORDER BY age(c.relfrozenxid) DESC;

If a table appears here, either (a) re-enable autovacuum and accept the routine vacuum cost, or (b) keep it disabled but schedule explicit `VACUUM FREEZE` via `pg_cron` before age approaches `autovacuum_freeze_max_age`.


### Recipe 13 — Capacity planning for a high-TPS cluster


On a cluster doing 10,000 write TPS, you consume 10,000 XIDs/second = **864 million XIDs/day**. At default `autovacuum_freeze_max_age = 200M`, anti-wraparound autovacuum fires roughly every 5.5 hours per high-traffic table. Per-table tuning:

    -- pick the per-table threshold so anti-wraparound runs on YOUR schedule, not Postgres's
    ALTER TABLE public.events SET (
        autovacuum_freeze_max_age = 1500000000,            -- 1.5B: fire roughly daily
        autovacuum_multixact_freeze_max_age = 1500000000
    );

    -- raise the cluster GUC to allow it
    ALTER SYSTEM SET autovacuum_freeze_max_age = 1500000000;
    ALTER SYSTEM SET autovacuum_multixact_freeze_max_age = 1500000000;
    SELECT pg_reload_conf();
    -- requires restart for autovacuum_freeze_max_age

**Tradeoff to be aware of**: raising `autovacuum_freeze_max_age` means more pages stay un-frozen for longer, which means each anti-wraparound vacuum has more work. Pair with PG16+ opportunistic freezing or PG18+ eager freezing for the lazy-freeze-during-routine-vacuum recapture.


## Gotchas / Anti-patterns


1. **PG18 did not introduce 64-bit XIDs.** See the PG18 WARNING admonition in §Mental Model above. Wraparound is still 32-bit; PG18 only reduces freeze cost.

2. **The in-server hint at hard-stop is misleading.** *"Stop the postmaster and vacuum that database in single-user mode"* — the docs themselves correct this. Do NOT stop the postmaster. Clear the xmin-horizon blocker and VACUUM in normal mode.[^routine]

3. **`autovacuum = off` does not exempt you from anti-wraparound autovacuum.** *"This will happen even if autovacuum is disabled."*[^routine] Per-table `autovacuum_enabled = false` has the same exception per the per-table docs.[^per-table-autovac] Disabling autovacuum is at best a delay, never an exemption.

4. **Anti-wraparound autovacuum cannot be cancelled by `lock_timeout` or session statement_timeout.** It will hold its `SHARE UPDATE EXCLUSIVE` lock against blocked DDL indefinitely. If you have DDL planned during a maintenance window, run `SELECT pid FROM pg_stat_activity WHERE query LIKE '%(to prevent wraparound)%'` first and wait for it to finish.

5. **Long-running transactions defeat freeze advancement no matter how aggressively you tune autovacuum.** Without xmin-horizon advancement, no freezing happens. Tuning `autovacuum_freeze_max_age` lower in this state only makes anti-wraparound vacuum run more often *without making progress*. Fix the horizon first.

6. **Replication slots can pin xmin horizon cluster-wide for weeks.** An abandoned slot whose subscriber dropped offline silently holds the horizon back. The cluster's `relfrozenxid` cannot advance past the slot's `xmin`. Monitor `pg_replication_slots.xmin` (or `catalog_xmin` for logical slots).

7. **`hot_standby_feedback = on` from a busy standby can pin xmin horizon on the primary**. A read replica running long analytics queries propagates its xmin to the primary; long enough queries can delay primary-side freezing. Either disable `hot_standby_feedback` (accepting query cancellations on the standby) or set tight `statement_timeout` on the standby.

8. **`vacuum_freeze_min_age` is silently capped at half of `autovacuum_freeze_max_age`.** Setting it to 500M without also raising `autovacuum_freeze_max_age` does nothing past 100M. Set them together.[^vacuum-freeze-min-age]

9. **`vacuum_freeze_table_age` is silently capped at 95% of `autovacuum_freeze_max_age`.** Same rule, similar trap.[^vacuum-freeze-table-age]

10. **`vacuum_failsafe_age` is silently capped at no less than 105% of `autovacuum_freeze_max_age`.** Setting failsafe lower than auto-vacuum threshold is silently ignored.[^vacuum-failsafe-age]

11. **MultiXact wraparound is a separate counter and a separate emergency.** XID age looking healthy does not mean MXID age is healthy. Heavy FK-enforcement workloads can trigger MultiXact pressure invisibly. Monitor `mxid_age(datminmxid)` separately.

12. **MultiXact members storage can hit ~20GB and trigger wraparound at low MXID age.** *"if the storage occupied by multixacts members exceeds about 10GB, aggressive vacuum scans will occur more often."*[^routine] A cluster with `pg_multixact/members/` directory > 10GB has a problem regardless of `mxid_age()`.

13. **Disabling autovacuum cluster-wide is operationally fatal.** Some shops do this thinking they will "run vacuum manually on a schedule." This is wrong. Without autovacuum, you lose anti-wraparound, freeze advancement, statistics updates, dead-tuple reclamation, and visibility-map maintenance. The right answer is to leave autovacuum on and tune it.

14. **VACUUM FULL during wraparound is doubly wrong.** Verbatim docs: *"Do not use VACUUM FULL in this scenario, because it requires an XID."*[^routine] VACUUM FULL allocates new XIDs as part of rewriting tuples, which moves you closer to wraparound, not further. The same docs note: *"Do not use VACUUM FREEZE either."* The right command in normal operation is plain `VACUUM (FREEZE)` not `VACUUM FREEZE`.

15. **`pg_resetwal` discards data integrity.** It clears WAL and resets control file values. Use only when the server won't start; *immediately* `pg_dumpall`, `initdb`, and restore. Do not run DML between `pg_resetwal` and the dump.

16. **Anti-wraparound autovacuum on a 500GB table can take many hours**. Don't trigger a maintenance window assuming you can pause it. The right strategy is to lower per-table `autovacuum_freeze_max_age` enough that anti-wraparound runs more often (each pass touches fewer pages), or pre-emptively `VACUUM FREEZE` during off-hours.

17. **`pg_xact` filenames are CLOG segments, each covering 32,768 XIDs.** When sized to manually compute a `-x` argument for `pg_resetwal`, the formula in the docs: *"A safe value can be determined by looking for the numerically largest file name in the directory pg_xact ... adding one, and then multiplying by 1048576 (0x100000)."*[^pg-resetwal] The 0x100000 multiplier (not 0x8000) accounts for the segment-and-page layout.

18. **Idle replicas continue receiving WAL but do not advance the primary's xmin horizon.** Only `hot_standby_feedback = on` connections do that. So a quiescent replica is safe; an analytics replica with feedback enabled is the concern.

19. **`VACUUM FREEZE` against a small subset of tables in a low-age database is fine, but cluster-wide `VACUUMDB --all --freeze` rewrites every page everywhere.** That's a lot of IO. Use Recipe 8 to target only high-age tables, not a blanket `--all --freeze`.

20. **Templates count.** `pg_database.datfrozenxid` for `template0` and `template1` count toward the cluster-wide minimum. If you have an idle `template0` that's never vacuumed, the cluster horizon won't advance past its frozen-xid. Autovacuum *does* visit `template0` but only when it's enabled (typically yes); verify with `SELECT datname, datallowconn, age(datfrozenxid) FROM pg_database;`. Sometimes operators set `datallowconn = false` on `template0` thinking it locks the template safely — that's correct but autovacuum still needs to visit, which it does as the autovacuum launcher (not as a backend).

21. **Warning thresholds changed in PG14.** Verbatim: *"Increase warning time and hard limit before transaction id and multi-transaction wraparound."*[^pg14-warnings] Pre-PG14 clusters had less runway between first warning and hard-stop. If you maintain monitoring built for PG12/PG13, retest alerts on PG14+ — they may fire earlier (more runway = more warning time).

22. **PG17 removed `old_snapshot_threshold`.** Verbatim: *"Remove server variable old_snapshot_threshold ... This variable allowed vacuum to remove rows that potentially could be still visible to running transactions, causing 'snapshot too old' errors later."*[^pg17-ost] If you carried over a `postgresql.conf` from PG16 with `old_snapshot_threshold` set, the server will fail to start on PG17. Old runbooks recommending it for wraparound mitigation are obsolete — the modern answer is `idle_in_transaction_session_timeout` and slot hygiene.


## See Also


- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — tuple header, FrozenTransactionId sentinel, xmin horizon sources, MultiXact concept
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM command grammar, autovacuum architecture, cost-based throttling, parallel vacuum, `pg_stat_progress_vacuum`
- [`30-hot-updates.md`](./30-hot-updates.md) — Heap-Only Tuples reduce write amplification but do not affect freeze obligations
- [`41-transactions.md`](./41-transactions.md) — `idle_in_transaction_session_timeout`, prepared transactions
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC contexts (which freeze GUCs require restart vs reload)
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_progress_vacuum`, monitoring patterns
- [`73-streaming-replication.md`](./73-streaming-replication.md) — `hot_standby_feedback` xmin propagation
- [`75-replication-slots.md`](./75-replication-slots.md) — slot xmin retention and `max_slot_wal_keep_size`
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `pg_resetwal`, `pg_checksums`, single-user mode for genuine corruption
- [`81-pgbouncer.md`](./81-pgbouncer.md) — connection pooling to prevent idle-in-transaction sessions that pin the xmin horizon.
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling pre-emptive freeze of write-once partitions
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version index of freeze-related changes


## Sources


[^routine]: PostgreSQL 16 Documentation, "Routine Vacuuming" — verbatim quotes including "transaction IDs have limited size (32 bits) a cluster that runs for a long time (more than 4 billion transactions) would suffer transaction ID wraparound", "it is necessary to vacuum every table in every database at least once every two billion transactions", "PostgreSQL reserves a special XID, FrozenTransactionId, which does not follow the normal XID comparison rules and is always considered older than every normal XID", "autovacuum is invoked on any table that might contain unfrozen rows with XIDs older than the age specified by ... autovacuum_freeze_max_age. (This will happen even if autovacuum is disabled.)", the verbatim WARNING and ERROR messages at 40M and 3M XIDs left respectively, "Contrary to what the hint states, it is not necessary or desirable to stop the postmaster or enter single user-mode in order to restore normal operation", "Do not use VACUUM FULL in this scenario, because it requires an XID", "Do not use VACUUM FREEZE either", "if the storage occupied by multixacts members exceeds about 10GB, aggressive vacuum scans will occur more often ... The members storage area can grow up to about 20GB before reaching wraparound", "the system will refuse to generate new MXIDs once there are fewer than three million left until wraparound". https://www.postgresql.org/docs/16/routine-vacuuming.html
[^per-table-autovac]: PostgreSQL 16 Documentation, "CREATE TABLE" — verbatim quote: "If false, this table will not be autovacuumed, except to prevent transaction ID wraparound." (autovacuum_enabled storage parameter). https://www.postgresql.org/docs/16/sql-createtable.html
[^vacuum-freeze-min-age]: PostgreSQL 16 Documentation, "Client Connection Defaults" — `vacuum_freeze_min_age` default 50,000,000, verbatim: "Specifies the cutoff age (in transactions) that VACUUM should use to decide whether to freeze row versions while scanning a table." Plus: "the system silently limits the effective value to half the value of autovacuum_freeze_max_age." https://www.postgresql.org/docs/16/runtime-config-client.html
[^vacuum-freeze-table-age]: PostgreSQL 16 Documentation, "Client Connection Defaults" — `vacuum_freeze_table_age` default 150,000,000, verbatim: "VACUUM performs an aggressive scan if the table's pg_class.relfrozenxid field has reached the age specified by this setting." Plus: "the system silently limits the effective value to 95% of autovacuum_freeze_max_age." https://www.postgresql.org/docs/16/runtime-config-client.html
[^autovacuum-freeze-max-age]: PostgreSQL 16 Documentation, "Automatic Vacuuming" — `autovacuum_freeze_max_age` default 200,000,000, verbatim: "Specifies the maximum age (in transactions) that a table's pg_class.relfrozenxid field can attain before a VACUUM operation is forced to prevent transaction ID wraparound within the table." Plus: "Note that the system will launch autovacuum processes to prevent wraparound even when autovacuum is otherwise disabled." https://www.postgresql.org/docs/16/runtime-config-autovacuum.html
[^vacuum-failsafe-age]: PostgreSQL 16 Documentation, "Client Connection Defaults" — `vacuum_failsafe_age` default 1,600,000,000, verbatim: "VACUUM takes extraordinary measures to avoid system-wide transaction ID wraparound failure if the table's pg_class.relfrozenxid field has reached the age specified by this setting. This is VACUUM's strategy of last resort." Plus: "The setting is silently limited to no less than 105% of autovacuum_freeze_max_age." https://www.postgresql.org/docs/16/runtime-config-client.html
[^multi-freeze-min]: PostgreSQL 16 Documentation, "Client Connection Defaults" — `vacuum_multixact_freeze_min_age` default 5,000,000. https://www.postgresql.org/docs/16/runtime-config-client.html
[^multi-freeze-table]: PostgreSQL 16 Documentation, "Client Connection Defaults" — `vacuum_multixact_freeze_table_age` default 150,000,000. https://www.postgresql.org/docs/16/runtime-config-client.html
[^autovac-multi-max]: PostgreSQL 16 Documentation, "Automatic Vacuuming" — `autovacuum_multixact_freeze_max_age` default 400,000,000, verbatim: "Specifies the maximum age (in multixacts) that a table's pg_class.relminmxid field can attain before a VACUUM operation is forced to prevent multixact ID wraparound within the table." https://www.postgresql.org/docs/16/runtime-config-autovacuum.html
[^multi-failsafe]: PostgreSQL 16 Documentation, "Client Connection Defaults" — `vacuum_multixact_failsafe_age` default 1,600,000,000. Same "strategy of last resort" wording as `vacuum_failsafe_age`. https://www.postgresql.org/docs/16/runtime-config-client.html
[^pg13-insert]: PostgreSQL 13 Release Notes — verbatim: "Trigger autovacuum based on inserted-tuple counts (Laurenz Albe, Darafei Praliaskouski). Previously, INSERTs were not counted toward triggering autovacuum, which is a problem for never-updated tables, because they would never get autovacuumed. Now insert activity triggers autovacuum on tables, allowing the pages to be marked all-visible, which speeds up index-only scans, and the freeze maps spread the freeze overhead over time." https://www.postgresql.org/docs/release/13.0/
[^pg14-failsafe]: PostgreSQL 14 Release Notes — verbatim: "Cause vacuum operations to be more aggressive if the table is near xid or multixact wraparound (Masahiko Sawada, Peter Geoghegan). This is controlled by vacuum_failsafe_age and vacuum_multixact_failsafe_age." https://www.postgresql.org/docs/release/14.0/
[^pg14-warnings]: PostgreSQL 14 Release Notes — verbatim: "Increase warning time and hard limit before transaction id and multi-transaction wraparound (Noah Misch). This should reduce the possibility of failures that occur without having issued warnings about wraparound." https://www.postgresql.org/docs/release/14.0/
[^pg15-freeze]: PostgreSQL 15 Release Notes — verbatim: "Allow vacuum to be more aggressive in setting the oldest frozen and multi transaction id (Peter Geoghegan)." https://www.postgresql.org/docs/release/15.0/
[^pg16-freeze]: PostgreSQL 16 Release Notes — verbatim: "Reduce the overhead of freezing tuples (Andres Freund, Peter Geoghegan)." Plus the opportunistic-freezing change in non-aggressive vacuum. https://www.postgresql.org/docs/release/16.0/
[^pg17-mem]: PostgreSQL 17 Release Notes — verbatim: "Allow vacuum to more efficiently store tuple references (Masahiko Sawada, John Naylor) ... vacuum is no longer silently limited to one gigabyte of memory when maintenance_work_mem or autovacuum_work_mem are higher." https://www.postgresql.org/docs/release/17.0/
[^pg17-freeze-wal]: PostgreSQL 17 Release Notes — verbatim: "Allow vacuum to more efficiently remove and freeze tuples (Melanie Plageman, Heikki Linnakangas, Peter Geoghegan) ... WAL traffic caused by vacuum is also more compact." https://www.postgresql.org/docs/release/17.0/
[^pg17-ost]: PostgreSQL 17 Release Notes — verbatim: "Remove server variable old_snapshot_threshold (Thomas Munro). This variable allowed vacuum to remove rows that potentially could be still visible to running transactions, causing 'snapshot too old' errors later." https://www.postgresql.org/docs/release/17.0/
[^pg17-progress-rename]: PostgreSQL 17 Release Notes — verbatim: "Rename pg_stat_progress_vacuum columns max_dead_tuples to max_dead_tuple_bytes and num_dead_tuples to num_dead_item_ids, and add column dead_tuple_bytes (Peter Geoghegan, Masahiko Sawada)." https://www.postgresql.org/docs/release/17.0/
[^pg18-eager]: PostgreSQL 18 Release Notes — verbatim: "Allow normal vacuums to freeze some pages, even though they are all-visible (Melanie Plageman). This reduces the work needed by anti-wraparound vacuums. The aggressiveness of this can be controlled by per-table parameter vacuum_max_eager_freeze_failure_rate. Previously vacuum never processed all-visible pages until freezing was required." https://www.postgresql.org/docs/release/18.0/
[^pg18-relallfrozen]: PostgreSQL 18 Release Notes — verbatim: "Add column pg_class.relallfrozen (Melanie Plageman)." https://www.postgresql.org/docs/release/18.0/
[^pg-resetwal]: PostgreSQL 16 Documentation, "pg_resetwal" — verbatim: "pg_resetwal clears the write-ahead log (WAL) and optionally resets some other control information stored in the pg_control file." Plus: "It should be used only as a last resort, when the server will not start due to such corruption." Plus: "After running this command, it should be possible to start the server, but bear in mind that the database might contain inconsistent data due to partially-committed transactions. You should immediately dump your data, run initdb, and restore. Do not execute any data-modifying operations in the database before you dump." Plus the `-x` verbatim: "Manually set the next transaction ID. A safe value can be determined by looking for the numerically largest file name in the directory pg_xact ... adding one, and then multiplying by 1048576 (0x100000)." https://www.postgresql.org/docs/16/app-pgresetwal.html
[^single-user]: PostgreSQL 16 Documentation, "postgres" — verbatim: "To start a single-user mode server, use a command like `postgres --single -D /usr/local/pgsql/data other-options my_database`" and "Selects the single-user mode. This must be the first argument on the command line." Note: the docs do NOT recommend single-user mode for wraparound recovery; routine-vacuuming.html explicitly contradicts the in-server HINT that suggests it. https://www.postgresql.org/docs/16/app-postgres.html

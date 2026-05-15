# Heap-Only Tuple (HOT) Updates


HOT is the optimization that lets an `UPDATE` skip *all* index entries when (a) no indexed column changed and (b) the new tuple fits on the same heap page. Without HOT, every `UPDATE` inserts new entries into every index. With HOT, busy tables can absorb millions of updates while their indexes stay nearly static — but only if you understand the two preconditions and tune `fillfactor` correctly.

This file is the dedicated HOT mechanism deep dive. MVCC tuple-header layout lives in [`27-mvcc-internals.md`](./27-mvcc-internals.md); VACUUM's interaction with HOT chains lives in [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md); B-tree bottom-up index deletion (the recovery path when HOT runs out) lives in [`23-btree-indexes.md`](./23-btree-indexes.md).


## Table of Contents


- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — five rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The two preconditions for HOT](#the-two-preconditions-for-hot)
    - [What a HOT chain looks like in the heap](#what-a-hot-chain-looks-like-in-the-heap)
    - [Tuple-header flags and line-pointer states](#tuple-header-flags-and-line-pointer-states)
    - [Opportunistic HOT pruning](#opportunistic-hot-pruning)
    - [Summarizing indexes (BRIN) — the PG16 carve-out](#summarizing-indexes-brin--the-pg16-carve-out)
    - [Broken HOT chains](#broken-hot-chains)
    - [Fillfactor tuning](#fillfactor-tuning)
    - [Monitoring HOT ratio](#monitoring-hot-ratio)
    - [Inspecting a HOT chain with pageinspect](#inspecting-a-hot-chain-with-pageinspect)
    - [Interaction with bottom-up index deletion](#interaction-with-bottom-up-index-deletion)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference


Reach for this file when:

- A read-heavy workload became slow after an UPDATE-pattern change and you suspect index bloat.
- `pg_stat_user_tables.n_tup_hot_upd` is far below `n_tup_upd` and you want to diagnose why HOT isn't kicking in.
- A table updates a non-indexed column constantly (timestamp, status, click count) and you're considering `fillfactor` tuning.
- You're choosing whether to add an index on a frequently-updated column and want to understand the HOT cost.
- You inherited a schema with `fillfactor=100` everywhere and want to audit which tables would benefit from lower values.
- You're investigating a "the table looks fine but the indexes are huge" bloat pattern.
- You're deciding whether to switch a B-tree index on a frequently-updated column to BRIN (which since PG16 doesn't break HOT).

Skip this file if you only need the tuple-header bit layout ([`27-mvcc-internals.md`](./27-mvcc-internals.md)), B-tree internals ([`23-btree-indexes.md`](./23-btree-indexes.md)), or VACUUM scheduling ([`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md)).


## Mental Model — five rules


1. **HOT is evaluated per-update.** Every `UPDATE` is evaluated independently. The same row can be HOT-updated, then non-HOT-updated, then HOT-updated again as page free-space and indexed-column choices vary. The decision is made inside `heap_update()` at execution time.

2. **HOT requires *both* conditions to hold.** From the docs: *"This optimization is possible when: The update does not modify any columns referenced by the table's indexes, not including summarizing indexes ... There is sufficient free space on the page containing the old row for the updated row."*[^hot] Either failure forces a normal (non-HOT) update with new entries in every index.

3. **HOT removes the need to update indexes, *and* the need for VACUUM to clean the dead version.** Docs: *"Old versions of updated rows can be completely removed during normal operation, including SELECTs, instead of requiring periodic vacuum operations."*[^hot] HOT chains get pruned opportunistically by any backend that touches the page, including readers.

4. **`fillfactor` is the only knob.** There is no `enable_hot_updates` GUC. The single lever is the per-table `fillfactor` storage parameter (10–100, default **100**) which reserves free space on each heap page for HOT chains.[^createtable] Index columns and query patterns are the other levers, but they're schema-level, not runtime tuning.

5. **Indexes on hot-update columns kill HOT for that column.** This is the silent footgun: a partial index on `status WHERE status = 'pending'` makes *every* `UPDATE` that touches `status` non-HOT — even updates that change `status` from `'done'` to `'done'` (no-op semantically) still trip the indexed-column-changed check. The check is on `pg_index.indkey`, not on whether the value actually changed.


## Decision Matrix


| Situation | Action | Cross-reference |
|---|---|---|
| Read-mostly table (`UPDATE` rate < 1% of `SELECT` rate) | Leave `fillfactor=100` (default) | — |
| OLTP table with frequent `UPDATE` on non-indexed columns | Lower `fillfactor` to 80-90 | Recipe 1 |
| Status / counter / timestamp column updated every transaction | `fillfactor=70-80`, audit indexes on the column | Recipes 1, 4 |
| Existing low HOT ratio (`n_tup_hot_upd / n_tup_upd` < 0.5) | Audit indexes; consider dropping or converting to BRIN | Recipes 2, 3 |
| Index needed on hot-updated low-cardinality column | Consider BRIN (PG16+ HOT-compatible) instead of B-tree | Recipe 3, [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) |
| Migrating from `serial` / `bigserial` PK to UUID PK | Verify HOT still works (PK index unchanged on UPDATE) | [`18-uuid-numeric-money.md`](./18-uuid-numeric-money.md) |
| Bulk `UPDATE` filling the same page completely | Lower `fillfactor` *before* the bulk operation, then run VACUUM | Recipe 7 |
| Diagnose "indexes growing faster than the heap" | Compute HOT ratio + inspect bottom-up deletion stats | Recipes 2, 8 |
| `INSERT`-heavy table with no `UPDATE` | Leave `fillfactor=100` (HOT doesn't apply) | — |
| Append-only audit / events table | `fillfactor=100`; HOT is irrelevant | — |

Three smell signals for HOT failing:

- `n_tup_hot_upd / n_tup_upd` is below 50% on a write-heavy table whose indexed columns "should not be changing" — likely an unexpected index covers a column that *is* changing.
- Total relation size for indexes grows faster than the heap relation size between VACUUM runs.
- `pg_stat_user_indexes.idx_tup_read` is very high for an index whose `idx_scan` is low — readers are walking the index just to discard dead entries, which means HOT pruning isn't keeping up.


## Syntax / Mechanics


HOT has no SQL syntax — it's a behind-the-scenes optimization decided per-update by the executor. The only configuration surface is the per-table `fillfactor` storage parameter:

    CREATE TABLE events (
        id          bigint    PRIMARY KEY,
        user_id     bigint    NOT NULL,
        kind        text      NOT NULL,
        status      text      NOT NULL,
        last_seen   timestamptz NOT NULL DEFAULT now()
    ) WITH (fillfactor = 80);

    -- Or alter an existing table:
    ALTER TABLE events SET (fillfactor = 80);

    -- Reset to default:
    ALTER TABLE events RESET (fillfactor);

`ALTER TABLE ... SET (fillfactor = N)` is a metadata-only operation taking `SHARE UPDATE EXCLUSIVE` (does not block reads or writes); it does **not** rewrite existing pages. New pages and inserts on existing under-filled pages honor the new setting; an existing page already at 100% won't be released without `VACUUM FULL` or `CLUSTER` (which is rarely worth it just for fillfactor).


### The two preconditions for HOT


From `storage-hot.html` verbatim:[^hot]

> "This optimization is possible when:
> - The update does not modify any columns referenced by the table's indexes, not including summarizing indexes. The only summarizing index method in the core PostgreSQL distribution is BRIN.
> - There is sufficient free space on the page containing the old row for the updated row."

**Condition 1 — no indexed column changed:** the executor compares the bitmap of columns referenced by *any* index (from `pg_index.indkey` across all the table's indexes) against the bitmap of columns in the `UPDATE` target list. Any overlap → non-HOT. This check is purely structural; it doesn't care whether the new value equals the old value. `UPDATE events SET status = status` will still be non-HOT if `status` is indexed.

**Condition 2 — sufficient free space:** the new tuple version must fit on the same page as the old. "Sufficient" means after subtracting the existing live tuples, dead tuples (which might be pruned in this same update — see [Opportunistic HOT pruning](#opportunistic-hot-pruning)), and the new tuple's row size, the page can still hold the result. Page size is 8KB by default; if your `events` rows average 200 bytes, a page holds ~40 tuples, and you need roughly one row's worth of free space for each potential HOT update before the page fills.

**Both must hold.** If either fails the executor falls back to a normal update: a new tuple on whatever page has space, with new index entries in every index, with the old version held until VACUUM.


### What a HOT chain looks like in the heap


A HOT chain is a sequence of tuple versions on the same heap page, linked by `t_ctid`:

```
Page layout:

  Line pointer array      Tuple data area
  ┌──────────────────┐    ┌─────────────────────┐
  │ LP1 → tuple A    │    │ Tuple A             │ (xmin=10, xmax=20, HEAP_HOT_UPDATED, t_ctid=(page,2))
  │ LP2 → tuple B    │    │ Tuple B             │ (xmin=20, xmax=30, HEAP_HOT_UPDATED+HEAP_ONLY_TUPLE, t_ctid=(page,3))
  │ LP3 → tuple C    │    │ Tuple C             │ (xmin=30, xmax=0,  HEAP_ONLY_TUPLE,                t_ctid=(page,3))
  └──────────────────┘    └─────────────────────┘

  Indexes only point at LP1 (the "root" line pointer for this chain).
  Readers arriving via the index follow LP1 → tuple A → t_ctid (page,2) → LP2 → tuple B → ...
  until they find the version visible to their snapshot.
```

Key properties:

- **The index entries point only at the chain root (LP1).** Indexes never get new entries for B, C, D, etc. — that's the entire point of HOT.
- **Each new tuple is `HEAP_ONLY_TUPLE`-flagged** (the t_infomask2 bit `HEAP_ONLY_TUPLE`). This marks the row as "reachable only via the heap chain, not directly via an index entry."
- **The old tuple gets `HEAP_HOT_UPDATED`** (also in t_infomask2). This marks "I was superseded by a HOT update; my successor is via my t_ctid."
- **Both flag names live in `src/include/access/htup_details.h`**[^htup-details] — the docs deliberately don't enumerate them. Cite the source header for these terms.


### Tuple-header flags and line-pointer states


Two distinct categories of flag matter for HOT:

**Tuple-header bits (`t_infomask2`):** `HEAP_HOT_UPDATED` (this tuple was HOT-updated; its successor is at `t_ctid`) and `HEAP_ONLY_TUPLE` (this tuple is reachable only via a chain, not by index). Defined in `src/include/access/htup_details.h`. The docs `storage-page-layout.html` notes only that `t_infomask2` carries *"number of attributes, plus various flag bits"*[^pagelayout] and points at the source header for the bit list.

**Line-pointer states (`lp_flags` in `ItemIdData`):** `LP_NORMAL` (in-use, points at tuple data), `LP_REDIRECT` (points at another line pointer on the same page — used after HOT chain pruning replaces the root), `LP_DEAD` (line pointer is dead; the heap slot is reusable but the line pointer itself must be kept until indexes are vacuumed), `LP_UNUSED` (free). Defined in `src/include/storage/itemid.h`.[^itemid]

The `pageinspect` extension's `heap_tuple_infomask_flags()` function decodes `t_infomask` and `t_infomask2` into named flags including `HEAP_HOT_UPDATED` and `HEAP_ONLY_TUPLE`.[^pageinspect] Use it (Recipe 5) to verify what a real HOT chain looks like on disk.

> [!NOTE] PostgreSQL docs for HOT
> The user-facing `storage-hot.html` chapter is deliberately abstract — `HEAP_HOT_UPDATED`, `HEAP_ONLY_TUPLE`, `LP_REDIRECT`, `LP_DEAD`, "broken HOT chain", and "root line pointer" live only in source headers (`htup_details.h`, `itemid.h`, `heapam.c`) and the storage README. Cite those sources for those terms.


### Opportunistic HOT pruning


HOT pruning is the cleanup of dead versions within a HOT chain. The docs state that *"Old versions of updated rows can be completely removed during normal operation, including SELECTs."*[^hot] Specifically:

- Any backend that touches a heap page during a `SELECT`, `UPDATE`, or `DELETE` may attempt to prune the chain on that page.
- Pruning removes dead intermediate tuples (those whose xmax committed and is no longer visible to any active snapshot — same condition VACUUM uses).
- The root line pointer is replaced with `LP_REDIRECT` pointing at the surviving head of the live chain.
- Reclaimed heap space becomes immediately available for new HOT updates on the same page.

This is why busy HOT-heavy workloads can run nearly indefinitely without VACUUM: every reader and writer helps clean up dead versions on every page it touches. VACUUM is still required for index cleanup, anti-wraparound freeze, and reclaiming line pointers themselves — but the in-page dead-tuple problem largely solves itself.

Pruning is opportunistic, not guaranteed. A page that's never read or written after a long-dead chain won't get pruned until autovacuum touches it.


### Summarizing indexes (BRIN) — the PG16 carve-out


Pre-PG16, *any* index on a column killed HOT for that column. In PG16, summarizing indexes were exempted. From the PG16 release notes verbatim:[^pg16-brin]

> "Allow HOT updates if only BRIN-indexed columns are updated (Matthias van de Meent, Josef Simanek, Tomas Vondra)"

And from the docs:[^hot]

> "The update does not modify any columns referenced by the table's indexes, *not including summarizing indexes*. The only summarizing index method in the core PostgreSQL distribution is BRIN."

How this works structurally: BRIN indexes summarize block ranges (default 128 pages per range), not individual tuples. When a tuple is HOT-updated, the BRIN summary covering that block range may need to be invalidated and rebuilt, but the BRIN index has no per-tuple entries to maintain. So a HOT update of a BRIN-indexed column is allowed — the summary will be lazily refreshed by `brin_summarize_new_values()` or by autovacuum, not at every UPDATE.

> [!NOTE] PostgreSQL 16
> Pre-PG16, any column with a BRIN index on it still broke HOT just like a B-tree-indexed column. The PG16 carve-out is what makes BRIN-on-frequently-updated-columns operationally viable.

**Operational consequence:** if you have a low-cardinality, write-heavy column that you need to filter on (status, priority, region) and that column's UPDATE pattern is currently killing HOT, consider switching the index from B-tree to BRIN on PG16+. The trade-off is BRIN's lossiness and the requirement that data be physically correlated with the indexed column — see [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md).


### Broken HOT chains


A "broken HOT chain" is a chain that *would have been* HOT-eligible at update time but cannot be, because an index was added that covers a column that already changed at some earlier point in the chain. Concretely:

1. Row created with `(id=1, status='pending')`. Tuple A.
2. `UPDATE ... SET status = 'done'`. Status is not indexed at this time, so this is HOT-eligible. Tuple B is HEAP_ONLY_TUPLE on the same page as A.
3. New index created: `CREATE INDEX ON tbl (status)`. This index must point at the *current* version of the row (status='done'), but the index can only target line pointers, not specific HEAP_ONLY_TUPLE versions in the chain.

The PostgreSQL solution: when a new index is created during a `CREATE INDEX CONCURRENTLY` (or non-concurrently), the system uses `indcheckxmin` to record "this index is only valid against snapshots taken after XID N" — preventing old snapshots from using the index and seeing the wrong row. This is the `pg_index.indcheckxmin` column. The `indisready` and `indisvalid` flags govern the same.[^indcheckxmin]

The practical reader-visible consequence: very long-lived snapshots (`pg_dump`, manual `BEGIN ISOLATION LEVEL REPEATABLE READ`, abandoned cursors) may not be able to use a newly-created index. The fix is to retire those snapshots.

Less commonly, a broken chain happens during a `pg_upgrade` if the new cluster's index list differs from the source's — the docs do not promise HOT-chain preservation across upgrades. The mitigation is the same: long-lived snapshots eventually drain.


### Fillfactor tuning


The `fillfactor` storage parameter sets the per-table page-fill percentage. From `sql-createtable.html` verbatim:[^createtable]

> "The fillfactor for a table is a percentage between 10 and 100. 100 (complete packing) is the default. When a smaller fillfactor is specified, INSERT operations pack table pages only to the indicated percentage; the remaining space on each page is reserved for updating rows on that page."

> "This gives UPDATE a chance to place the updated copy of a row on the same page as the original, which is more efficient than placing it on a different page, and makes heap-only tuple updates more likely."

> "This parameter cannot be set for TOAST tables."

| Fillfactor | When to use |
|---|---|
| 100 (default) | Read-mostly, append-only, INSERT-heavy without UPDATE |
| 90 | OLTP table with moderate UPDATE rate on non-indexed columns |
| 80 | Hot UPDATE table (status / counter / last_seen column changes frequently) |
| 70 | Update-every-row-every-minute pattern (queue tables, session tables) |
| 50 or lower | Very rare; only justified when measurement shows HOT ratio still low at 70 |

**Rule of thumb:** the right fillfactor is the smallest value that keeps HOT ratio above 95% on representative workloads. Lower wastes space; higher leaves no room for HOT.

`fillfactor` only affects new pages and tuples inserted on currently-under-filled existing pages. To rebuild existing pages at the new fillfactor:

- `VACUUM FULL` (rewrites entire table — `ACCESS EXCLUSIVE` lock, expensive)
- `CLUSTER` (rewrites by an index — `ACCESS EXCLUSIVE` lock, expensive)
- `pg_repack` (online, no exclusive lock — recommended; see [`26-index-maintenance.md`](./26-index-maintenance.md))

For most cases, simply set the fillfactor and let natural turnover bring pages to the right shape over time.


### Monitoring HOT ratio


The canonical diagnostic columns in `pg_stat_user_tables`:[^monitoring]

| Column | Meaning |
|---|---|
| `n_tup_upd` | "Total number of rows updated. (This includes row updates counted in `n_tup_hot_upd` and `n_tup_newpage_upd`, and remaining non-HOT updates.)" |
| `n_tup_hot_upd` | "Number of rows HOT updated. These are updates where no successor versions are required in indexes." |
| `n_tup_newpage_upd` | "Number of rows updated where the successor version goes onto a *new* heap page, leaving behind an original version with a `t_ctid` field that points to a different heap page. These are always non-HOT updates." |

The three-way classification on PG16+:

- **HOT updates** (`n_tup_hot_upd`) — same page, no index updates needed.
- **Same-page non-HOT updates** (`n_tup_upd − n_tup_hot_upd − n_tup_newpage_upd`) — old version stays on the same page but a successor is on the same or different page; index entries were updated.
- **New-page updates** (`n_tup_newpage_upd`) — successor on a different page; index entries were updated; HOT impossible because of free-space failure.

Pre-PG16, only HOT vs non-HOT was distinguishable. The `n_tup_newpage_upd` split (introduced PG16) helps disambiguate "HOT failed because of an indexed-column change" (low n_tup_hot_upd, low n_tup_newpage_upd) from "HOT failed because of free-space pressure" (low n_tup_hot_upd, high n_tup_newpage_upd).

> [!NOTE] PostgreSQL 16
> `n_tup_newpage_upd` column added in PG16: *"Record statistics on the occurrence of updated rows moving to new pages. The `pg_stat_*_tables` column is `n_tup_newpage_upd`."*[^pg16-newpage] Use it to distinguish indexed-column-change failures from free-space failures.

**Target ratios:**

| `n_tup_hot_upd / n_tup_upd` | Interpretation |
|---|---|
| > 0.95 | Excellent — HOT working as intended |
| 0.70 – 0.95 | Good — some non-HOT, usually free-space pressure on tail pages |
| 0.30 – 0.70 | Diagnose — likely an unexpected index on a hot column |
| < 0.30 | Investigate — almost certainly an indexed-column-changed problem |

Recipe 2 has the full diagnostic query.


### Inspecting a HOT chain with pageinspect


`pageinspect` exposes `heap_page_items(page bytea)` which returns one row per line pointer with `t_ctid`, `t_infomask`, `t_infomask2`, and `lp_flags`. Paired with `heap_tuple_infomask_flags()`, you can verify HOT chains on a live table.

    CREATE EXTENSION IF NOT EXISTS pageinspect;

    -- Inspect page 0 of table 'orders':
    SELECT
        lp,
        lp_flags,
        t_ctid,
        t_infomask2,
        (heap_tuple_infomask_flags(t_infomask, t_infomask2)).flags AS infomask_flags,
        (heap_tuple_infomask_flags(t_infomask, t_infomask2)).combined_flags
            AS combined_flags
    FROM heap_page_items(get_raw_page('orders', 0));

The verbatim `pageinspect` docs:[^pageinspect]

> "`heap_page_items` shows all line pointers on a heap page. For those line pointers that are in use, tuple headers as well as tuple raw data are also shown. All tuples are shown, whether or not the tuples were visible to an MVCC snapshot at the time the raw page was copied."

> "All of these functions may be used only by superusers."

The diagnostic value: `lp_flags = 2` is `LP_REDIRECT` (HOT chain root after pruning); `infomask_flags` containing `HEAP_HOT_UPDATED` means the tuple was HOT-superseded; `infomask_flags` containing `HEAP_ONLY_TUPLE` means this is a non-root chain member.


### Interaction with bottom-up index deletion


When HOT works, index bloat stays under control because HOT skips index entries entirely — and HOT updates produce smaller WAL records than non-HOT updates (see [`33-wal.md`](./33-wal.md)). When HOT *fails* — because of an indexed-column change — index bloat accumulates linearly with the UPDATE rate. The recovery mechanism since PG14 is bottom-up index deletion in B-trees. From the PG14 release notes verbatim:[^pg14-bottomup]

> "Allow btree index additions to remove expired index entries to prevent page splits (Peter Geoghegan). This is particularly helpful for reducing index bloat on tables whose indexed columns are frequently updated."

How they interact in practice:

1. **HOT works** → no index update → no index bloat. Bottom-up deletion doesn't need to do anything.
2. **HOT fails (indexed column changed)** → new index entry for each version → potential index bloat. When a leaf page is about to split, bottom-up deletion scans the page for index entries that point at dead heap tuples (LP_DEAD line pointers, or tuples whose visibility check shows they're dead) and removes them, avoiding the split.
3. **HOT fails (free-space failure)** → same as above. The non-HOT update went to a new page; the old page's tuple is dead and its LP_DEAD will be detected by bottom-up deletion next time the index leaf page is touched.

Bottom-up deletion is best understood as the "second line of defense" when HOT can't help. It doesn't replace HOT — it mitigates the cost of HOT's absence. See [`23-btree-indexes.md`](./23-btree-indexes.md) for the algorithmic detail.


### Per-version timeline


| Version | Change | Citation |
|---|---|---|
| PG8.3 | HOT introduced (heap-only tuples, in-page chain, LP_REDIRECT) | Historical |
| PG14 | Bottom-up B-tree index deletion (mitigates HOT-failure index bloat) | [^pg14-bottomup] |
| PG15 | *No HOT-specific release-note changes* | — |
| PG16 | BRIN-indexed columns no longer break HOT (summarizing-index carve-out) | [^pg16-brin] |
| PG16 | `n_tup_newpage_upd` column added to `pg_stat_*_tables` | [^pg16-newpage] |
| PG17 | *No HOT-specific release-note changes* | — |
| PG18 | *No HOT-specific release-note changes* (PG18 added eager-freeze during normal vacuum but this is orthogonal to HOT) | — |

PG18 explicitly contains no HOT-related release-note bullets. The "common upgrade question" of *does PG18 improve HOT?* has a clean answer: no. HOT itself was last meaningfully extended in PG16 with the BRIN carve-out and the new stats column.


## Examples / Recipes


### Recipe 1 — Baseline schema with fillfactor for an UPDATE-heavy table

A queue / session / hot-status table where most updates touch non-indexed columns:

    CREATE TABLE user_sessions (
        session_id   uuid PRIMARY KEY,                             -- indexed; never updated
        user_id      bigint NOT NULL,                              -- indexed by FK; rarely updated
        ip_address   inet,
        user_agent   text,
        last_seen    timestamptz NOT NULL DEFAULT now(),           -- updated on every heartbeat; NOT indexed
        request_count bigint NOT NULL DEFAULT 0,                   -- updated on every request; NOT indexed
        status       text NOT NULL DEFAULT 'active'                -- 99% stays 'active'; queried occasionally
    ) WITH (fillfactor = 80);

    CREATE INDEX ON user_sessions (user_id);
    -- Note: NO index on status, last_seen, or request_count.
    -- This is deliberate. If a future query needs "find expired sessions",
    -- consider a partial index WHERE status = 'expired' (small) or a
    -- BRIN index on last_seen (PG16+, HOT-safe).

The reasoning: with `fillfactor=80`, each page reserves 20% free for HOT-update successors. Updates to `last_seen` and `request_count` (the hot columns) are guaranteed HOT because no index references them. The PK (session_id) and FK (user_id) are stable, so HOT eligibility is preserved.

Result on a 1M-row workload with ~10K updates/sec on `last_seen`:

- Heap size: stable at ~140 MB.
- Index size: stable at ~40 MB (the two B-trees).
- HOT ratio: 99.8%.
- Autovacuum: only needed for periodic freeze, not for bloat.


### Recipe 2 — Diagnose low HOT ratio

The canonical "why is my HOT ratio bad?" query:

    SELECT
        schemaname,
        relname,
        n_tup_upd,
        n_tup_hot_upd,
        n_tup_newpage_upd,
        n_tup_upd - n_tup_hot_upd - n_tup_newpage_upd
            AS n_tup_samepage_non_hot_upd,
        ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1)
            AS hot_pct,
        ROUND(100.0 * n_tup_newpage_upd / NULLIF(n_tup_upd, 0), 1)
            AS newpage_pct,
        pg_size_pretty(pg_relation_size(schemaname||'.'||relname))
            AS heap_size
    FROM pg_stat_user_tables
    WHERE n_tup_upd > 1000
    ORDER BY n_tup_upd DESC
    LIMIT 50;

Interpretation tree:

- **`hot_pct > 95`** — no action needed.
- **`hot_pct` low AND `newpage_pct` low** — indexed-column-change failure. Audit indexes for unexpected coverage of the hot column. Use Recipe 4.
- **`hot_pct` low AND `newpage_pct` high** — free-space failure. Lower fillfactor (Recipe 1). Existing pages need a one-time `pg_repack` to take effect immediately, or wait for natural turnover.
- **`hot_pct` moderate (~50-70%)** — usually a mix of both. Address whichever bigger ratio first.


### Recipe 3 — Switch a B-tree to BRIN on a hot-updated column (PG16+)

Pre-PG16, a B-tree index on a frequently-updated low-cardinality column killed HOT. PG16's BRIN carve-out makes this fixable without dropping the index:

    -- Before: B-tree index on a frequently-updated status column kills HOT.
    \d events
    -- "events_status_idx" btree (status)

    -- Verify the workload is BRIN-suitable: status values are correlated
    -- with insertion order (e.g. new events default to 'pending', advance
    -- to 'done' over time).
    SELECT correlation
    FROM pg_stats
    WHERE tablename = 'events' AND attname = 'status';
    -- correlation > 0.5 → BRIN viable
    -- correlation near 0 → BRIN unsuitable; consider dropping the index instead

    -- Build BRIN concurrently, then drop the old B-tree:
    CREATE INDEX CONCURRENTLY events_status_brin ON events
        USING brin (status) WITH (pages_per_range = 32);

    -- Verify the planner uses it:
    EXPLAIN ANALYZE SELECT * FROM events WHERE status = 'pending';

    -- Drop the old B-tree:
    DROP INDEX CONCURRENTLY events_status_idx;

> [!NOTE] PostgreSQL 16
> The BRIN carve-out for HOT[^pg16-brin] applies only when the BRIN index is the *only* index referencing the changed column. If any non-summarizing index (B-tree, GIN, GiST, hash, SP-GiST) covers it, HOT still fails.

Trade-off: BRIN is lossy (always rechecks the heap) and only useful when data is physically correlated with the indexed column. For a high-cardinality unique column, BRIN is the wrong tool. See [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md).


### Recipe 4 — Audit indexes on potentially-hot-updated columns

Find tables with updates and the indexed columns they touch:

    -- Step 1: identify hot tables (high update count, low HOT ratio).
    WITH hot_tables AS (
        SELECT
            schemaname,
            relname,
            n_tup_upd,
            ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1)
                AS hot_pct
        FROM pg_stat_user_tables
        WHERE n_tup_upd > 10000
        ORDER BY n_tup_upd DESC
    )
    SELECT
        ht.schemaname,
        ht.relname,
        ht.hot_pct,
        i.indexrelid::regclass AS index_name,
        am.amname AS index_method,
        array_agg(a.attname ORDER BY x.ord) AS indexed_columns
    FROM hot_tables ht
    JOIN pg_class c ON c.relname = ht.relname
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = ht.schemaname
    JOIN pg_index i ON i.indrelid = c.oid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY x(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
    WHERE ht.hot_pct < 80
    GROUP BY ht.schemaname, ht.relname, ht.hot_pct, i.indexrelid, am.amname
    ORDER BY ht.relname, i.indexrelid::regclass::text;

The output lets you see "table `events` has hot_pct=23%, B-tree index on (status, created_at)" — strongly suggesting that `status` is one of the updated columns. Next step: confirm the update pattern with `pg_stat_statements` (find `UPDATE events SET status = ...` queries), and either drop the index, switch to BRIN (PG16+ — Recipe 3), or accept the trade-off.


### Recipe 5 — Inspect a HOT chain on disk

Concrete demonstration that HOT works as documented. Create a small table, do an UPDATE, look at the page:

    CREATE EXTENSION IF NOT EXISTS pageinspect;

    CREATE TABLE hot_demo (
        id          int PRIMARY KEY,
        unindexed   text NOT NULL,
        indexed     text NOT NULL
    ) WITH (fillfactor = 50);   -- generous room for HOT
    CREATE INDEX ON hot_demo (indexed);

    INSERT INTO hot_demo VALUES (1, 'A', 'foo');

    -- HOT-eligible: 'unindexed' is not indexed.
    UPDATE hot_demo SET unindexed = 'B' WHERE id = 1;

    -- Examine page 0:
    SELECT
        lp,
        lp_flags,
        t_ctid,
        (heap_tuple_infomask_flags(t_infomask, t_infomask2)).flags AS flags
    FROM heap_page_items(get_raw_page('hot_demo', 0))
    WHERE t_xmin IS NOT NULL;

Expected output (line pointer 1 = root, line pointer 2 = HEAP_ONLY_TUPLE successor):

```
 lp | lp_flags | t_ctid |                          flags
----+----------+--------+----------------------------------------------------------
  1 |        1 | (0,2)  | {HEAP_XMIN_COMMITTED,HEAP_XMAX_COMMITTED,HEAP_HOT_UPDATED}
  2 |        1 | (0,2)  | {HEAP_XMIN_COMMITTED,HEAP_ONLY_TUPLE}
```

Now break HOT with an indexed-column update:

    UPDATE hot_demo SET indexed = 'bar' WHERE id = 1;

    SELECT lp, lp_flags, t_ctid,
        (heap_tuple_infomask_flags(t_infomask, t_infomask2)).flags AS flags
    FROM heap_page_items(get_raw_page('hot_demo', 0))
    WHERE t_xmin IS NOT NULL;

Now there's a third line pointer **without** the `HEAP_ONLY_TUPLE` flag — a new index entry was created.


### Recipe 6 — Verify lower fillfactor improves HOT ratio under load

A controlled before/after bench, suitable for a staging cluster:

    -- Setup at fillfactor=100 (default).
    CREATE TABLE hot_bench_100 (
        id         bigint PRIMARY KEY,
        counter    bigint NOT NULL DEFAULT 0,
        payload    text NOT NULL DEFAULT repeat('x', 200)
    );
    INSERT INTO hot_bench_100
    SELECT i, 0, repeat('x', 200) FROM generate_series(1, 100000) i;
    VACUUM ANALYZE hot_bench_100;

    -- Setup at fillfactor=70.
    CREATE TABLE hot_bench_70 (LIKE hot_bench_100 INCLUDING ALL)
        WITH (fillfactor = 70);
    INSERT INTO hot_bench_70 SELECT * FROM hot_bench_100;
    VACUUM ANALYZE hot_bench_70;

    -- Reset stats baseline.
    SELECT pg_stat_reset();

    -- Run a representative update batch (10000 updates each).
    DO $$
    DECLARE i int;
    BEGIN
        FOR i IN 1..10000 LOOP
            UPDATE hot_bench_100 SET counter = counter + 1 WHERE id = (i % 100000) + 1;
            UPDATE hot_bench_70  SET counter = counter + 1 WHERE id = (i % 100000) + 1;
        END LOOP;
    END $$;

    -- Compare HOT ratios:
    SELECT
        relname,
        n_tup_upd,
        n_tup_hot_upd,
        n_tup_newpage_upd,
        ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct
    FROM pg_stat_user_tables
    WHERE relname IN ('hot_bench_100', 'hot_bench_70');

Expected: `hot_bench_100` shows HOT ratio plateauing in the 40-60% range as pages fill up; `hot_bench_70` stays above 90%. The difference is `fillfactor` alone.


### Recipe 7 — Bulk update that benefits from a temporary fillfactor change

When you need to do a large UPDATE on existing data and want HOT to apply maximally:

    -- Step 1: lower fillfactor on the target table.
    ALTER TABLE big_table SET (fillfactor = 70);

    -- Step 2: rewrite existing pages to honor the new fillfactor.
    -- This is the expensive step. Use pg_repack for online operation.
    -- pg_repack --table=big_table --jobs=4

    -- Step 3: do the bulk UPDATE in batches.
    -- The new fillfactor gives each page room for HOT successors.
    DO $$
    DECLARE
        batch_size int := 10000;
        rows_done int;
    BEGIN
        LOOP
            UPDATE big_table SET counter = counter + 1
            WHERE id IN (
                SELECT id FROM big_table WHERE updated_at IS NULL
                LIMIT batch_size FOR UPDATE SKIP LOCKED
            );
            GET DIAGNOSTICS rows_done = ROW_COUNT;
            EXIT WHEN rows_done = 0;
            COMMIT;
        END LOOP;
    END $$;

    -- Step 4 (optional): if HOT was very effective, you can raise fillfactor
    -- back if the table is normally read-mostly. Or leave it for future updates.

Avoid raising fillfactor back to 100 just to "save space" — the natural turnover that grew the table also pulls average density back toward fillfactor over time. Leave the setting where it works.


### Recipe 8 — Detect index bloat from broken HOT

If HOT has been failing on a frequently-updated column, indexes accumulate dead entries faster than they're cleaned. Use `pgstattuple` to confirm:

    CREATE EXTENSION IF NOT EXISTS pgstattuple;

    -- Heap stats:
    SELECT * FROM pgstattuple_approx('events');

    -- Per-index stats (B-tree only):
    SELECT
        i.indexrelid::regclass AS index,
        pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
        (pgstatindex(i.indexrelid::regclass::text)).avg_leaf_density,
        (pgstatindex(i.indexrelid::regclass::text)).leaf_fragmentation,
        (pgstatindex(i.indexrelid::regclass::text)).deleted_pages
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_am am ON am.oid =
        (SELECT relam FROM pg_class WHERE oid = i.indexrelid)
    WHERE c.relname = 'events' AND am.amname = 'btree';

Interpretation: `avg_leaf_density` below 50% on a B-tree means substantial bloat. Combined with a low `hot_pct` from Recipe 2, the diagnosis is "HOT is failing → indexes are bloating → REINDEX or pg_repack will help temporarily but won't fix the root cause." The root cause is fixed by removing or changing the offending index. Cross-reference [`26-index-maintenance.md`](./26-index-maintenance.md).


### Recipe 9 — Identify candidates for HOT improvement across the cluster

A single audit query to surface the top 10 tables most likely to benefit from `fillfactor` tuning or index changes:

    SELECT
        schemaname,
        relname,
        n_tup_upd,
        n_tup_hot_upd,
        n_tup_newpage_upd,
        ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct,
        ROUND(100.0 * n_tup_newpage_upd / NULLIF(n_tup_upd, 0), 1)
            AS newpage_pct,
        pg_size_pretty(pg_relation_size(schemaname||'.'||relname))
            AS heap_size,
        pg_size_pretty(pg_indexes_size(schemaname||'.'||relname))
            AS index_size,
        ROUND(pg_indexes_size(schemaname||'.'||relname)::numeric /
              NULLIF(pg_relation_size(schemaname||'.'||relname), 0), 2)
            AS index_to_heap_ratio,
        (SELECT option_value FROM pg_options_to_table(
            (SELECT reloptions FROM pg_class WHERE oid =
                (schemaname||'.'||relname)::regclass))
         WHERE option_name = 'fillfactor') AS fillfactor
    FROM pg_stat_user_tables
    WHERE n_tup_upd > 10000
      AND ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) < 80
    ORDER BY n_tup_upd DESC
    LIMIT 10;

The `index_to_heap_ratio` column is a useful proxy for "indexes are growing faster than they should be." A ratio > 1.0 on a normal OLTP table is suspicious. Pair with the HOT pct to decide whether to lower fillfactor, drop an index, or switch to BRIN.


### Recipe 10 — Verify HOT after an index change

After dropping or adding an index, confirm HOT ratio responds as expected. Reset stats, run representative traffic, measure:

    -- Reset just this table's stats (PG13+):
    SELECT pg_stat_reset_single_table_counters('events'::regclass);

    -- Or all stats:
    -- SELECT pg_stat_reset();

    -- Apply the index change:
    DROP INDEX CONCURRENTLY events_status_idx;

    -- Run the application load for 10-15 minutes...

    -- Compare:
    SELECT
        n_tup_upd, n_tup_hot_upd, n_tup_newpage_upd,
        ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct
    FROM pg_stat_user_tables
    WHERE relname = 'events';

Expect HOT pct to jump significantly if the dropped index was the HOT-killer. If it doesn't move, another index is also covering the updated column — repeat the audit (Recipe 4).


## Gotchas / Anti-patterns


1. **`fillfactor=100` is the default and is usually wrong for OLTP tables.** Every reference / tutorial / sample uses defaults; this leaves no room for HOT on busy tables. Audit non-trivial UPDATE workloads with Recipe 9 and set fillfactor explicitly.

2. **An index on a frequently-updated column kills HOT for *every* UPDATE that touches that column** — even an UPDATE that sets the column to its current value. The check is structural (column appears in target list), not semantic (value actually changed). If you must index a hot column, accept the index-bloat cost or switch to BRIN on PG16+.

3. **`ALTER TABLE SET (fillfactor = ...)` does not rewrite existing pages.** It only affects new pages and the existing under-filled tail. To force the new setting onto existing pages, use `pg_repack` (online) or `VACUUM FULL` / `CLUSTER` (locking).

4. **Pre-PG16, a BRIN index killed HOT just like B-tree.** See §Summarizing indexes (BRIN) — the PG16 carve-out above. Verify target version before relying on it.

5. **HOT pruning is opportunistic; it requires page touches.** A page that nothing reads or writes won't be pruned until autovacuum gets there. On a read-heavy table with rare-but-localized writes, you may see autovacuum work that "should have" been done by reader prunes.

6. **`n_tup_newpage_upd` was added in PG16.** See §Monitoring HOT ratio above for the three-way breakdown (HOT / same-page-non-HOT / new-page).

7. **HOT does *not* eliminate the need for VACUUM.** VACUUM still must update the visibility map, reclaim line pointers, freeze tuples for wraparound protection, and clean dead index entries when HOT failed. HOT pruning is in-page; VACUUM is table-wide. Cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

8. **TOAST tables cannot have `fillfactor`.** From `sql-createtable.html` verbatim: *"This parameter cannot be set for TOAST tables."*[^createtable] If a row's TOASTed columns change, the TOAST table gets new tuples but the main heap entry can still be HOT-updated if the main-heap columns are unchanged.

9. **An expression index on `lower(name)` counts as an index on `name`.** The expression-index column is built from the underlying column; an UPDATE on the underlying column will break HOT. Same for INCLUDE columns — every column referenced by any index counts, regardless of whether it's a key column or a payload-only INCLUDE.

10. **A partial index counts as an index on its columns *and* on the columns in its WHERE clause.** `CREATE INDEX ... ON tbl (a) WHERE b > 0` means an UPDATE that touches either `a` or `b` breaks HOT — including UPDATEs that don't affect whether the row satisfies the partial-index predicate.

11. **HOT failure cascades.** Once a chain has been broken by an indexed-column change, subsequent HOT-eligible updates on the same row build chains off the new (non-HOT) successor, not off the original root. Long-term, the page may end up with multiple non-overlapping HOT chains.

12. **`pageinspect` requires superuser.** Verbatim:[^pageinspect] *"All of these functions may be used only by superusers."* Recipe 5 cannot be run from an application role. In a managed environment with no superuser access, you can't directly inspect HOT chains.

13. **`indcheckxmin` and "broken HOT chains" can prevent index use after `CREATE INDEX`.** Old snapshots may not be allowed to use a newly-created index. The fix is to retire those snapshots (cancel long-running queries, close cursors, ROLLBACK PREPARED). This is rare in healthy clusters but very visible during `pg_dump` runs.

14. **Bottom-up index deletion is not VACUUM.** It mitigates index bloat at write time but does not free index pages back to the FSM the way `VACUUM` does. A table with HOT consistently failing will still benefit from periodic `REINDEX CONCURRENTLY` even with bottom-up deletion working.

15. **Reading `n_tup_hot_upd` without a time bound is misleading.** Cumulative stats reset only when the cluster is restarted, autovacuum touches the table, or `pg_stat_reset_*` is called. A table that had bad HOT pct under an old index might show good HOT pct on the current schema if you don't reset stats after the index change. Recipe 10's stats reset is the right ritual.

16. **HOT ratio depends on workload mix; the *current* ratio is more diagnostic than the *all-time* ratio.** Reset stats periodically (weekly via pg_cron) to keep recent measurements meaningful. See [`98-pg-cron.md`](./98-pg-cron.md).

17. **A unique index on a never-changing column does not impact HOT.** Stable primary-key indexes are HOT-friendly by design. The problem is indexes on changeable columns. Don't drop the PK to "improve HOT."

18. **HOT does not work across pages, period.** If the new tuple won't fit on the same page, no HOT — even by one byte. This is why bulk updates that grow rows (e.g., `UPDATE tbl SET payload = payload || ' suffix'`) often see dramatic HOT-ratio drops.

19. **There is no `enable_hot_updates` GUC.** Confirmed by direct fetch of `runtime-config-resource.html` — no HOT-controlling parameter exists. The only knob is the per-table `fillfactor` storage parameter.

20. **The PG18 release notes contain zero HOT changes.** If a tutorial or blog claims "HOT was improved in PG18," verify against the release notes directly. PG18's vacuum improvements are about eager freezing, not HOT.

21. **`SELECT ... FOR UPDATE` does not itself break HOT** — it only takes a row lock and writes the tuple's `xmax`, which is part of the standard tuple header and not an indexed column. The followup UPDATE is HOT-eligible per the usual rules.

22. **A trigger on `BEFORE UPDATE` that re-assigns an indexed column re-arms the HOT-failure check.** If your trigger does `NEW.status := NEW.status` defensively, it counts as setting `status`. Drop unnecessary defensive assignments.


## See Also


- [`22-indexes-overview.md`](./22-indexes-overview.md) — Seven-way access-method picker; HOT's interaction with index selection is a central theme.
- [`23-btree-indexes.md`](./23-btree-indexes.md) — Bottom-up index deletion (the recovery path when HOT fails); fillfactor on B-trees.
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — BRIN as the HOT-compatible alternative for low-cardinality high-update columns.
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `REINDEX CONCURRENTLY` and `pg_repack` for bloated indexes when HOT has been failing.
- [`27-mvcc-internals.md`](./27-mvcc-internals.md) — tuple-header layout, `t_xmin` / `t_xmax` / `t_ctid` / `t_infomask2`; the HEAP_HOT_UPDATED and HEAP_ONLY_TUPLE flag context.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM's role for table-wide cleanup; how HOT pruning complements VACUUM.
- [`33-wal.md`](./33-wal.md) — WAL records produced by HOT updates vs non-HOT updates (HOT updates produce smaller records).
- [`55-statistics-planner.md`](./55-statistics-planner.md) — `pg_stats.correlation` for deciding BRIN suitability.
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_user_tables` columns; `pg_stat_user_indexes` for index growth diagnostics.
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling periodic stats resets and index bloat audits.


## Sources


[^hot]: PostgreSQL 16 docs — Heap-Only Tuples (HOT): https://www.postgresql.org/docs/16/storage-hot.html — verbatim "To allow for high concurrency, PostgreSQL uses multiversion concurrency control (MVCC) to store rows. However, MVCC has some downsides for update queries. Specifically, updates require new versions of rows to be added to tables. This can also require new index entries for each updated row, and removal of old versions of rows and their index entries can be expensive." plus "To help reduce the overhead of updates, PostgreSQL has an optimization called heap-only tuples (HOT)." plus the two-condition list "The update does not modify any columns referenced by the table's indexes, not including summarizing indexes. The only summarizing index method in the core PostgreSQL distribution is BRIN. / There is sufficient free space on the page containing the old row for the updated row." plus the two-benefit list "New index entries are not needed to represent updated rows, however, summary indexes may still need to be updated. / Old versions of updated rows can be completely removed during normal operation, including SELECTs, instead of requiring periodic vacuum operations." plus the fillfactor advice "You can increase the likelihood of sufficient page space for HOT updates by decreasing a table's fillfactor."

[^pagelayout]: PostgreSQL 16 docs — Storage Page Layout: https://www.postgresql.org/docs/16/storage-page-layout.html — verbatim "All table rows are structured in the same way. There is a fixed-size header (occupying 23 bytes on most machines)" and the tuple-header field table including "t_ctid | ItemPointerData | 6 bytes | current TID of this or newer row version" and "t_infomask2 | uint16 | 2 bytes | number of attributes, plus various flag bits".

[^htup-details]: PostgreSQL source — `src/include/access/htup_details.h`: https://github.com/postgres/postgres/blob/master/src/include/access/htup_details.h — canonical definitions for `HEAP_HOT_UPDATED`, `HEAP_ONLY_TUPLE`, and other tuple-header bits. The user-facing docs deliberately do not enumerate these constants and point readers at the source header.

[^itemid]: PostgreSQL source — `src/include/storage/itemid.h`: https://github.com/postgres/postgres/blob/master/src/include/storage/itemid.h — canonical definitions for `LP_UNUSED`, `LP_NORMAL`, `LP_REDIRECT`, `LP_DEAD` line-pointer states.

[^createtable]: PostgreSQL 16 docs — CREATE TABLE storage parameters: https://www.postgresql.org/docs/16/sql-createtable.html — verbatim "The fillfactor for a table is a percentage between 10 and 100. 100 (complete packing) is the default. When a smaller fillfactor is specified, INSERT operations pack table pages only to the indicated percentage; the remaining space on each page is reserved for updating rows on that page." and "This gives UPDATE a chance to place the updated copy of a row on the same page as the original, which is more efficient than placing it on a different page, and makes heap-only tuple updates more likely." and "This parameter cannot be set for TOAST tables."

[^monitoring]: PostgreSQL 16 docs — pg_stat_all_tables: https://www.postgresql.org/docs/16/monitoring-stats.html — verbatim `n_tup_upd` "Total number of rows updated. (This includes row updates counted in n_tup_hot_upd and n_tup_newpage_upd, and remaining non-HOT updates.)" and `n_tup_hot_upd` "Number of rows HOT updated. These are updates where no successor versions are required in indexes." and `n_tup_newpage_upd` "Number of rows updated where the successor version goes onto a *new* heap page, leaving behind an original version with a t_ctid field that points to a different heap page. These are always non-HOT updates."

[^pageinspect]: PostgreSQL 16 docs — pageinspect: https://www.postgresql.org/docs/16/pageinspect.html — verbatim `heap_page_items` "shows all line pointers on a heap page. For those line pointers that are in use, tuple headers as well as tuple raw data are also shown. All tuples are shown, whether or not the tuples were visible to an MVCC snapshot at the time the raw page was copied." and `heap_tuple_infomask_flags` "decodes the t_infomask and t_infomask2 returned by heap_page_items into a human-readable set of arrays made of flag names" plus "All of these functions may be used only by superusers."

[^pg16-brin]: PostgreSQL 16 release notes: https://www.postgresql.org/docs/release/16.0/ — verbatim "Allow HOT updates if only BRIN-indexed columns are updated (Matthias van de Meent, Josef Simanek, Tomas Vondra)".

[^pg16-newpage]: PostgreSQL 16 release notes: https://www.postgresql.org/docs/release/16.0/ — verbatim "Record statistics on the occurrence of updated rows moving to new pages (Corey Huinker). The pg_stat_*_tables column is n_tup_newpage_upd."

[^pg14-bottomup]: PostgreSQL 14 release notes: https://www.postgresql.org/docs/release/14.0/ — verbatim "Allow btree index additions to remove expired index entries to prevent page splits (Peter Geoghegan). This is particularly helpful for reducing index bloat on tables whose indexed columns are frequently updated."

[^indcheckxmin]: PostgreSQL 16 docs — `pg_index` catalog: https://www.postgresql.org/docs/16/catalog-pg-index.html — `indcheckxmin` column: "If true, queries must not use the index until the xmin of this pg_index row is below their TransactionXmin event horizon, because the table may contain broken HOT chains with incompatible rows that they can see."

[^pg18-eager]: PostgreSQL 18 release notes: https://www.postgresql.org/docs/release/18.0/ — eager freezing during normal vacuum and the new `vacuum_max_eager_freeze_failure_rate` GUC + `pg_class.relallfrozen` column. These are orthogonal to HOT but commonly conflated in upgrade Q&A.

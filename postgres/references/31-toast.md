# TOAST — The Oversized-Attribute Storage Technique

PostgreSQL's TOAST mechanism transparently compresses and/or moves wide column values out of the main heap into a sidecar relation. The mechanism is invisible at the SQL level — a `text` column with 10 KB of content reads back exactly as written — but it controls a large part of the disk-layout, write-amplification, and read-cost behavior of any table with wide columns. This file is the canonical reference for what TOAST does, when it is invoked, how to tune it, and which operational surprises it produces.

## When to Use This Reference

- A `text`, `bytea`, `jsonb`, `xml`, or array column has values larger than ~2 KB and you want to know what happens on disk.
- An UPDATE on a wide row is unexpectedly slow or produces lots of WAL.
- You are deciding between `pglz` and `lz4` compression for a new TOAST-able column.
- You see `pg_toast.pg_toast_<oid>` relations appear in `pg_class` and want to know how to inspect them.
- A query that returns `length(big_column)` is fast, but `SELECT big_column` is slow — TOAST de-TOAST cost is the explanation.
- Your monitoring shows a TOAST table is bloated separately from its main table.
- You are deciding between `bytea` and the Large Object (`lo`) API for big blobs.

## Table of Contents

- [Five-rule Mental Model](#five-rule-mental-model)
- [Decision Matrix: Storage Strategy](#decision-matrix-storage-strategy)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The 2 KB Threshold](#the-2-kb-threshold)
    - [The Four Storage Strategies](#the-four-storage-strategies)
    - [Compression: pglz vs lz4](#compression-pglz-vs-lz4)
    - [The TOAST Table](#the-toast-table)
    - [Chunking](#chunking)
    - [TOAST Pointers](#toast-pointers)
    - [UPDATE Preserves Out-of-Line Values](#update-preserves-out-of-line-values)
    - [`toast_tuple_target` Storage Parameter](#toast_tuple_target-storage-parameter)
    - [Inspecting TOAST](#inspecting-toast)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## Five-rule Mental Model

1. **TOAST kicks in only when the whole tuple exceeds ~2 KB.** A column with a 500-byte value never goes out-of-line — the cost is paid at the *row* level, not the *column* level. The threshold is `TOAST_TUPLE_THRESHOLD` (normally 2 KB) [^toast-threshold].
2. **There are four storage strategies; `EXTENDED` is the default for almost every variable-length type.** PLAIN forbids both compression and out-of-line storage (fixed-length types). EXTENDED tries compression first, then out-of-line. EXTERNAL skips compression and goes straight out-of-line. MAIN tries compression and keeps in-line as long as possible [^four-strategies].
3. **Compression default is `pglz`; `lz4` is faster and almost always better but only present if PostgreSQL was built `--with-lz4`.** Set per-column with `ALTER TABLE ... ALTER COLUMN ... SET COMPRESSION lz4` (PG14+) or cluster-wide via `default_toast_compression` GUC [^pg14-lz4] [^default-toast].
4. **Every TOAST-eligible table has a sidecar `pg_toast.pg_toast_<oid>` relation.** It is autovacuumed independently, has its own index, and can become bloated independently of the main table. Read it through `pg_class` (relkind `t`) [^toast-naming].
5. **Reading a TOASTed column requires joining the TOAST table on every access.** `SELECT *` on a wide-row table pays this cost on every row. `SELECT key, length(blob)` does not de-TOAST. UPDATE of an *unchanged* out-of-line value is free [^update-preserve].

> [!WARNING] TOAST is invisible at the SQL level — and almost invisible in `EXPLAIN`
> The TOAST machinery does not appear as a separate plan node. The cost shows up as buffer reads on the TOAST relation. Use `EXPLAIN (ANALYZE, BUFFERS)` and watch for buffer reads against `pg_toast.pg_toast_<oid>` — that is the de-TOAST traffic.

## Decision Matrix: Storage Strategy

| You need… | Use storage strategy | Avoid | Why |
|---|---|---|---|
| Default behavior for `text` / `bytea` / `jsonb` / `xml` / array | `EXTENDED` | No need to change | Compression-first, out-of-line if still too big — best general default |
| Pre-compressed payload (JPEG, MP3, gzipped blob) | `EXTERNAL` | `EXTENDED` (wastes CPU on doomed compression) | Compression won't help; skip it and avoid the cost |
| Fast substring access on large `text` / `bytea` | `EXTERNAL` | `EXTENDED` (substring needs full decompress) | Substring operations are optimized for uncompressed external values [^four-strategies] |
| Keep wide value in the heap if at all possible | `MAIN` | `EXTERNAL` | MAIN tries hard to stay in-line, only goes out-of-line as a last resort |
| Fixed-length column (`integer`, `timestamp`) | `PLAIN` (only choice) | — | Not TOAST-able; cannot use the other strategies |
| Reduce disk usage on a `text` column you rarely query | `EXTENDED` + `lz4` (PG14+) | `pglz` | `lz4` compresses faster and decompresses much faster than `pglz` |
| You suspect substring access is the hot path | `EXTERNAL` (set explicitly) | Keep `EXTENDED` | Test with `pg_column_size()` before/after and EXPLAIN BUFFERS |
| The column is hashed or compared by equality only | `EXTENDED` | `EXTERNAL` | Equality reads the whole value; compression helps the disk footprint |

Three smell signals you picked wrong:

- TOAST table size > 2× the main heap size on a workload that rarely needs the wide column → consider whether the wide column should be a child table or LO.
- Reads of the wide column dominate buffer traffic on the TOAST relation → consider `EXTERNAL` (skip decompress) or pull the column out into its own row keyed by the parent's PK.
- High UPDATE write amplification on a row where the wide column never changes → confirm you aren't sending the whole value back on every UPDATE; partial-update semantics rely on the value being literally unchanged (rule 5).

## Syntax / Mechanics

### The 2 KB Threshold

The TOAST machinery is triggered when an entire row exceeds `TOAST_TUPLE_THRESHOLD`. Per the docs:

> The TOAST management code is triggered only when a row value to be stored in a table is wider than `TOAST_TUPLE_THRESHOLD` bytes (normally 2 kB). The TOAST code will compress and/or move field values out-of-line until the row value is shorter than `TOAST_TUPLE_TARGET` bytes (also normally 2 kB, adjustable) [^toast-threshold].

Both thresholds are *per row*, not per column. A row with one 4 KB column and four 50-byte columns triggers TOAST; a row with twenty 100-byte columns does not, even though the wide values are similar in size.

> [!NOTE]
> `TOAST_TUPLE_THRESHOLD` is a build-time constant. `TOAST_TUPLE_TARGET` is also normally 2 KB but can be lowered per-table via the `toast_tuple_target` storage parameter (see below).

The order of operations when a row exceeds the threshold:

1. Walk the columns in descending size order, picking those with `EXTENDED` or `MAIN` storage.
2. Attempt compression on each. If the compressed value is still over ~2 KB worth of the row's budget, move it out-of-line.
3. For `EXTERNAL` columns, skip compression and go straight to out-of-line.
4. For `MAIN` columns, push to out-of-line only as a last resort.
5. Stop as soon as the row fits under `TOAST_TUPLE_TARGET`.

### The Four Storage Strategies

| Strategy | Compression | Out-of-line | Default for |
|---|---|---|---|
| `PLAIN` | No | No | Fixed-length types (`integer`, `boolean`, `timestamp`, ...) — the only allowed strategy |
| `EXTENDED` | Yes (tried first) | Yes (if still too big) | Most variable-length types (`text`, `bytea`, `jsonb`, `xml`, `varchar`, arrays) |
| `EXTERNAL` | No | Yes | Never the default — opt in |
| `MAIN` | Yes | Last resort | Some numeric types — confirm with `\d+ tablename` |

The verbatim definitions [^four-strategies]:

> `PLAIN` prevents either compression or out-of-line storage. This is the only possible strategy for columns of non-TOAST-able data types.

> `EXTENDED` allows both compression and out-of-line storage. This is the default for most TOAST-able data types. Compression will be attempted first, then out-of-line storage if the row is still too big.

> `EXTERNAL` allows out-of-line storage but not compression. Use of `EXTERNAL` will make substring operations on wide `text` and `bytea` columns faster (at the penalty of increased storage space) because these operations are optimized to fetch only the required parts of the out-of-line value when it is not compressed.

> `MAIN` allows compression but not out-of-line storage. (Actually, out-of-line storage will still be performed for such columns, but only as a last resort when there is no other way to make the row small enough to fit on a page.)

Setting the strategy is via `ALTER TABLE`:

    ALTER TABLE my_table ALTER COLUMN big_blob SET STORAGE EXTERNAL;

> [!WARNING] `SET STORAGE` does not rewrite existing rows
> Per the docs: *"Note that `ALTER TABLE ... SET STORAGE` doesn't itself change anything in the table; it just sets the strategy to be pursued during future table updates."* [^alter-storage] Existing rows keep their current storage. To force the rewrite, run a no-op update like `UPDATE my_table SET big_blob = big_blob WHERE big_blob IS NOT NULL` — but this is a full-table rewrite and produces full WAL traffic. For a clean rewrite, use `VACUUM FULL` or `pg_repack` (see [26-index-maintenance.md](./26-index-maintenance.md)).

### Compression: pglz vs lz4

PostgreSQL supports two TOAST compression algorithms:

- **`pglz`** — built-in since PostgreSQL began; the default. Slower compression and slower decompression than `lz4`. Roughly 2-3× slower to decompress than `lz4` on typical text payloads.
- **`lz4`** — added in PG14 [^pg14-lz4]. Faster to compress AND decompress, similar or slightly better compression ratio on most workloads. Requires the server to have been compiled with `--with-lz4`.

> [!NOTE] PostgreSQL 14 — LZ4 TOAST compression
> Verbatim: *"Add ability to use LZ4 compression on TOAST data (Dilip Kumar). This can be set at the column level, or set as a default via server parameter `default_toast_compression`. The server must be compiled with `--with-lz4` to support this feature. The default setting is still `pglz`."* [^pg14-lz4]

Set the compression algorithm per-column:

    ALTER TABLE events ALTER COLUMN payload SET COMPRESSION lz4;

Or cluster-wide:

    ALTER SYSTEM SET default_toast_compression = 'lz4';
    SELECT pg_reload_conf();

The verbatim docs description [^alter-storage]:

> This form sets the compression method for a column, determining how values inserted in future will be compressed (if the storage mode permits compression at all). … The supported compression methods are `pglz` and `lz4`. … In addition, *compression_method* can be `default`, which selects the default behavior of consulting the `default_toast_compression` setting at the time of data insertion to determine the method to use.

The GUC itself [^default-toast]:

> `default_toast_compression` (enum) — This variable sets the default TOAST compression method for values of compressible columns. (This can be overridden for individual columns by setting the `COMPRESSION` column option in `CREATE TABLE` or `ALTER TABLE`.) The supported compression methods are `pglz` and (if PostgreSQL was compiled with `--with-lz4`) `lz4`. The default is `pglz`.

> [!WARNING] `SET COMPRESSION` does not recompress existing rows
> Like `SET STORAGE`, this only affects *future* INSERTs and UPDATEs. Already-stored values keep their original compression. Confirm with `pg_column_compression(col)` (PG14+) — it returns the algorithm of the value as stored.

A single TOAST table can contain values compressed with different algorithms intermixed; the algorithm is recorded in the TOAST pointer, not on the table.

### The TOAST Table

Every table that has at least one TOAST-eligible column gets a sidecar relation in the `pg_toast` schema. The verbatim mechanics [^toast-naming]:

> Every TOAST table has the columns `chunk_id` (an OID identifying the particular TOASTed value), `chunk_seq` (a sequence number for the chunk within its value), and `chunk_data` (the actual data of the chunk). A unique index on `chunk_id` and `chunk_seq` provides fast retrieval of the values.

Naming convention: `pg_toast.pg_toast_<reloid>` where `reloid` is the `pg_class.oid` of the owning table. The TOAST table's own row in `pg_class` has `relkind = 't'`.

Find a table's TOAST relation:

    SELECT
        c.relname                    AS main_table,
        t.relname                    AS toast_table,
        pg_size_pretty(pg_relation_size(t.oid))       AS toast_size,
        pg_size_pretty(pg_relation_size(c.oid))       AS main_size,
        pg_size_pretty(pg_indexes_size(t.oid))        AS toast_index_size
    FROM pg_class c
    JOIN pg_class t ON t.oid = c.reltoastrelid
    WHERE c.relname = 'events';

The TOAST table:

- Has its own primary key (`chunk_id`, `chunk_seq`) backed by a btree index named `pg_toast_<oid>_index`.
- Is autovacuumed independently from the main table. Its own `pg_stat_*_tables` row tracks dead tuples, last-vacuum time, n_tup_upd, etc.
- Cannot have `fillfactor` set (TOAST tables are always 100% filled — see [30-hot-updates.md](./30-hot-updates.md) gotcha #8).
- Cannot have a user-set `STORAGE` strategy on its columns; the TOAST table's own data is always stored as PLAIN within the TOAST table (no recursive TOASTing).

> [!NOTE] PostgreSQL 14 — `VACUUM ... PROCESS_TOAST`
> Verbatim: *"VACUUM now has a `PROCESS_TOAST` option which can be set to false to disable TOAST processing, and vacuumdb has a `--no-process-toast` option."* [^pg14-process-toast] Lets you vacuum the main heap without touching the (potentially much larger) TOAST table.

> [!NOTE] PostgreSQL 16 — `VACUUM ... PROCESS_MAIN false`
> Verbatim: *"Allow `VACUUM` and vacuumdb to only process `TOAST` tables (Nathan Bossart). This is accomplished by having `VACUUM` turn off `PROCESS_MAIN` or by `vacuumdb` using the `--no-process-main` option."* [^pg16-process-main] The inverse of `PROCESS_TOAST` — lets you vacuum only the TOAST table.

> [!NOTE] PostgreSQL 18 — TOAST on `pg_index`
> Verbatim: *"Add TOAST table to `pg_index` to allow for very large expression indexes (Nathan Bossart)."* [^pg18-toast-pg-index] Before PG18, expression indexes whose `pg_index.indexprs`/`indpred` exceeded ~2 KB failed to create. PG18 adds TOAST to the catalog so very large expression bodies are accepted.

### Chunking

Verbatim mechanics [^toast-chunking]:

> Out-of-line values are divided (after compression if used) into chunks of at most `TOAST_MAX_CHUNK_SIZE` bytes (by default this value is chosen so that four chunk rows will fit on a page, making it about 2000 bytes). Each chunk is stored as a separate row in the TOAST table belonging to the owning table.

So a 10 KB compressed value becomes roughly 5 rows in the TOAST table, each ~2000 bytes, all sharing the same `chunk_id` and indexed by `(chunk_id, chunk_seq)`. To reconstruct the value, the executor:

1. Reads the TOAST pointer from the main heap tuple (18 bytes).
2. Looks up `chunk_id` in the TOAST table's unique index.
3. Sequentially fetches chunks `chunk_seq = 0, 1, 2, …` until exhausted.
4. Concatenates the chunk bodies.
5. If the value was compressed, decompresses.

Each chunk fetch is a B-tree probe + heap fetch on the TOAST relation. For a wide value, this can be 5-10 buffer reads on the TOAST relation — invisible in EXPLAIN unless you include `BUFFERS`.

### TOAST Pointers

The in-heap pointer is fixed-size — the docs are precise [^toast-pointer]:

> A pointer datum representing an out-of-line on-disk TOASTed value therefore needs to store the OID of the TOAST table in which to look and the OID of the specific value (its `chunk_id`). … the total size of an on-disk TOAST pointer datum is therefore 18 bytes regardless of the actual size of the represented value.

Three categories of TOAST pointers exist (the in-memory variants are operational detail not relevant to most users):

| Pointer kind | Lives on disk? | Notes |
|---|---|---|
| On-disk TOAST pointer | Yes | 18 bytes; references `chunk_id` in the TOAST table |
| In-memory indirect pointer | No | Used internally by some operators; auto-expanded before write |
| In-memory expanded pointer | No | Used for arrays/composites being modified element-wise |

The docs note explicitly [^in-mem-pointer]:

> In-memory TOAST pointers are automatically expanded to normal in-line varlena values before storage — and then possibly converted to on-disk TOAST pointers, if the containing tuple would otherwise be too big.

This means user code never has to worry about the in-memory variants — they cannot accidentally end up persisted.

### UPDATE Preserves Out-of-Line Values

The single most operationally important behavior of TOAST [^update-preserve]:

> During an UPDATE operation, values of unchanged fields are normally preserved as-is; so an UPDATE of a row with out-of-line values incurs no TOAST costs if none of the out-of-line values change.

An `UPDATE my_table SET status = 'done' WHERE id = 42` on a row with a 10 KB JSONB payload does *not* rewrite the JSONB — the new heap tuple inherits the existing TOAST pointer. No TOAST table writes, no chunk rewrites, no WAL traffic for the wide value.

But if you `UPDATE my_table SET payload = payload || '{...}'` — even appending one key — the entire new value is rewritten as new TOAST chunks. The old chunks become dead and require autovacuum cleanup on the TOAST table.

Operational consequence: applications doing partial updates to JSONB ("change one key in a 50 KB document") write the full document every time. Either store the hot keys in their own columns (see [17-json-jsonb.md](./17-json-jsonb.md) Recipe 7) or accept the write amplification.

### `toast_tuple_target` Storage Parameter

The `TOAST_TUPLE_TARGET` value is adjustable per-table:

    CREATE TABLE events (
        id     bigserial PRIMARY KEY,
        kind   text,
        payload jsonb
    ) WITH (toast_tuple_target = 1024);

The verbatim docs [^toast-target]:

> The `toast_tuple_target` specifies the minimum tuple length required before we try to compress and/or move long column values into TOAST tables, and is also the target length we try to reduce the length below once toasting begins. … Valid values are between 128 bytes and the (block size - header), by default 8160 bytes. … By default this parameter is set to allow at least 4 tuples per block, which with the default block size will be 2040 bytes.

Lower the value to push TOAST to engage sooner (smaller rows in the main heap, more aggressive offloading). Raise it to keep more in-line.

For TOAST-table-specific storage parameters, prefix with `toast.` [^toast-prefix]:

> For many of these parameters, as shown, there is an additional parameter with the same name prefixed with `toast.`, which controls the behavior of the table's secondary TOAST table, if any. If a table parameter value is set and the equivalent `toast.` parameter is not, the TOAST table will use the table's parameter value.

So:

    -- Override autovacuum on the TOAST sidecar
    ALTER TABLE events SET (toast.autovacuum_vacuum_scale_factor = 0.01);

### Inspecting TOAST

Per-value diagnostics (the function catalog):

| Function | Returns | Notes |
|---|---|---|
| `pg_column_size(col)` | Disk size in bytes (after compression) | Includes TOAST pointer overhead for out-of-line |
| `pg_column_compression(col)` | `'pglz'` or `'lz4'` or NULL | NULL if value is not compressed (PG14+) |
| `pg_column_toast_chunk_id(col)` | OID of the TOAST `chunk_id` or NULL | NULL if value is not out-of-line (PG17+) |
| `pg_relation_size(t.oid)` | Heap size of TOAST table | Use the `reltoastrelid` from `pg_class` |
| `pg_total_relation_size(c.oid)` | Main heap + indexes + TOAST | Includes the TOAST table and its index |
| `pgstattuple(t.oid)` | Full-scan tuple-level stats | Run against the TOAST relation OID |
| `pgstattuple_approx(t.oid)` | Sampled tuple stats | Cheaper for very large TOAST tables |

> [!NOTE] PostgreSQL 17 — `pg_column_toast_chunk_id()`
> Verbatim: *"Add function `pg_column_toast_chunk_id()` to return a value's TOAST identifier (Yugo Nagata). This returns `NULL` if the value is not stored in TOAST."* [^pg17-chunk-id] Lets you walk the chunks of a specific value by its OID:
>
>     SELECT chunk_seq, octet_length(chunk_data)
>     FROM pg_toast.pg_toast_<oid>
>     WHERE chunk_id = (SELECT pg_column_toast_chunk_id(payload) FROM events WHERE id = 42)
>     ORDER BY chunk_seq;

Direct inspection (requires superuser):

    -- Count chunks per TOASTed value (run against a TOAST relation)
    SELECT chunk_id, count(*) AS chunks, sum(octet_length(chunk_data)) AS bytes
    FROM pg_toast.pg_toast_16401
    GROUP BY chunk_id
    ORDER BY chunks DESC
    LIMIT 10;

## Per-Version Timeline

| Version | TOAST-relevant change | Source |
|---|---|---|
| PG14 | LZ4 compression added (per-column or via `default_toast_compression` GUC); requires `--with-lz4` build | [^pg14-lz4] |
| PG14 | `VACUUM ... PROCESS_TOAST` option + `vacuumdb --no-process-toast` | [^pg14-process-toast] |
| PG14 | Composite types for sequences and TOAST tables removed from the catalog (internal cleanup) | [^pg14-composite] |
| PG15 | B-tree deduplication enabled on system and TOAST table indexes | [^pg15-dedup] |
| PG15 | `amcheck` sanity checks improved for TOAST tables | [^pg15-amcheck] |
| PG16 | `VACUUM ... PROCESS_MAIN false` (or `vacuumdb --no-process-main`) — vacuum only the TOAST table | [^pg16-process-main] |
| PG17 | `pg_column_toast_chunk_id(col)` — return a value's TOAST identifier; NULL if not TOASTed | [^pg17-chunk-id] |
| PG18 | TOAST table added to `pg_index` to allow very large expression indexes | [^pg18-toast-pg-index] |

## Examples / Recipes

### 1. Baseline: pick storage and compression for a new wide column

For a JSONB event payload with mixed structured content:

    CREATE TABLE events (
        id           bigserial PRIMARY KEY,
        occurred_at  timestamptz NOT NULL DEFAULT now(),
        kind         text NOT NULL,
        payload      jsonb NOT NULL
    );

    -- Pick lz4 for the payload (faster decompress on every read)
    ALTER TABLE events
        ALTER COLUMN payload SET COMPRESSION lz4;

    -- For low-frequency wide reads, lower the toast_tuple_target
    -- to keep heap tuples narrow (cheap seqscan + index scan)
    ALTER TABLE events SET (toast_tuple_target = 1024);

For a `bytea` column storing JPEG images (already compressed):

    ALTER TABLE photos
        ALTER COLUMN image SET STORAGE EXTERNAL;
    -- No compression attempt; substring/octet operations also faster

### 2. Audit: TOAST tables larger than their main relation

Tables whose TOAST sidecar is larger than the main heap usually indicate a wide-column dominant workload:

    SELECT
        n.nspname                                      AS schema,
        c.relname                                      AS table,
        pg_size_pretty(pg_relation_size(c.oid))        AS main_size,
        pg_size_pretty(pg_relation_size(t.oid))        AS toast_size,
        round(pg_relation_size(t.oid)::numeric
              / NULLIF(pg_relation_size(c.oid), 0), 2) AS toast_to_main_ratio
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t    ON t.oid = c.reltoastrelid
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND pg_relation_size(t.oid) > 0
    ORDER BY pg_relation_size(t.oid) DESC
    LIMIT 20;

Interpret the ratio:

- `< 0.5` — typical, narrow rows dominate; TOAST is incidental.
- `0.5 – 2.0` — wide columns are a meaningful fraction of storage.
- `> 2.0` — TOAST dominates; verify the wide column is actually queried (if not, consider moving it to a child table or LO).

### 3. Migrate an existing column from `pglz` to `lz4`

`SET COMPRESSION` only affects future writes. To recompress existing data:

    -- Step 1: change the per-column default for future writes
    ALTER TABLE events ALTER COLUMN payload SET COMPRESSION lz4;

    -- Step 2: rewrite existing rows. Two options:
    --   A. Full rewrite via VACUUM FULL (offline, ACCESS EXCLUSIVE)
    VACUUM FULL events;
    --   B. Online rewrite via pg_repack (community tool)
    --   See 26-index-maintenance.md for the pg_repack walkthrough

    -- Step 3: verify the new algorithm
    SELECT id, pg_column_compression(payload)
    FROM events
    LIMIT 10;
    -- Expect: 'lz4' for every row

### 4. Recompute size impact of `lz4` vs `pglz`

Before deciding cluster-wide, measure on representative data:

    -- Create two staging copies with different compression
    CREATE TABLE t_pglz (LIKE events INCLUDING ALL);
    ALTER TABLE t_pglz ALTER COLUMN payload SET COMPRESSION pglz;

    CREATE TABLE t_lz4 (LIKE events INCLUDING ALL);
    ALTER TABLE t_lz4 ALTER COLUMN payload SET COMPRESSION lz4;

    INSERT INTO t_pglz SELECT * FROM events LIMIT 100000;
    INSERT INTO t_lz4  SELECT * FROM events LIMIT 100000;

    -- Compare sizes and decompress timing
    SELECT
        'pglz' AS algo,
        pg_size_pretty(pg_total_relation_size('t_pglz')) AS total_size
    UNION ALL
    SELECT 'lz4', pg_size_pretty(pg_total_relation_size('t_lz4'));

`lz4` produces 0-5% larger disk footprint but decompresses ~2-3× faster on typical JSONB workloads.

### 5. Find rows whose wide column is out-of-line

Per-value out-of-line check (PG17+):

    SELECT id, pg_column_toast_chunk_id(payload) AS chunk_id, pg_column_size(payload) AS bytes
    FROM events
    WHERE pg_column_toast_chunk_id(payload) IS NOT NULL
    ORDER BY pg_column_size(payload) DESC
    LIMIT 10;

Pre-PG17 (use `pg_column_size` and a threshold; not exact but practical):

    SELECT id, pg_column_size(payload) AS bytes
    FROM events
    WHERE pg_column_size(payload) > 2048
    ORDER BY bytes DESC
    LIMIT 10;

### 6. Inspect chunks of one specific value (PG17+)

After `pg_column_toast_chunk_id`, you can walk the chunks directly:

    -- Find the TOAST relation OID once
    SELECT c.reltoastrelid::regclass
    FROM pg_class c
    WHERE c.relname = 'events';

    -- Suppose pg_toast.pg_toast_16401, and chunk_id 98765:
    SELECT chunk_seq, octet_length(chunk_data) AS bytes
    FROM pg_toast.pg_toast_16401
    WHERE chunk_id = 98765
    ORDER BY chunk_seq;

The number of rows equals the chunk count; each row's `octet_length` should be ≤ 2000 except possibly the last.

### 7. Disable TOAST processing during a fast VACUUM (PG14+)

When the main heap has bloat but the TOAST table does not, skip the TOAST work:

    VACUUM (PROCESS_TOAST false, VERBOSE) events;

The inverse — vacuum *only* the TOAST table (PG16+):

    VACUUM (PROCESS_MAIN false, VERBOSE) events;

### 8. Tune autovacuum on the TOAST sidecar independently

If a TOAST table has hot writes (e.g., many updates to wide values producing dead chunks) but the main table does not, tune them separately:

    ALTER TABLE events SET (
        autovacuum_vacuum_scale_factor = 0.1,
        toast.autovacuum_vacuum_scale_factor = 0.02,
        toast.autovacuum_vacuum_cost_delay = 2
    );

The `toast.*`-prefixed parameters apply to the sidecar. Without an explicit `toast.*` override, the sidecar inherits the table's parameter [^toast-prefix].

### 9. Avoid the write-amplification trap on partial JSONB updates

If your workload is "update one key in a 50 KB JSONB", the full document is rewritten as new TOAST chunks on every update. Hoist the hot key:

    -- BAD: every update rewrites 50 KB of TOAST
    UPDATE events
       SET payload = jsonb_set(payload, '{status}', '"done"')
     WHERE id = 42;

    -- GOOD: separate hot scalar; payload not rewritten
    ALTER TABLE events ADD COLUMN status text;
    UPDATE events SET status = payload->>'status';
    UPDATE events SET payload = payload - 'status';
    -- Future updates touch only the narrow status column
    UPDATE events SET status = 'done' WHERE id = 42;

Cross-reference: [17-json-jsonb.md](./17-json-jsonb.md) Recipe 7 (hot scalar field hoisted alongside whole-jsonb GIN index).

### 10. Cluster-wide migration to `lz4`

For a cluster originally configured before PG14, migrating to `lz4` cluster-wide:

    -- Step 1: Set the cluster default for new writes
    ALTER SYSTEM SET default_toast_compression = 'lz4';
    SELECT pg_reload_conf();

    -- Step 2: Find tables with the most TOAST data
    SELECT n.nspname, c.relname, pg_size_pretty(pg_relation_size(t.oid)) AS toast_size
    FROM pg_class c
    JOIN pg_class t      ON t.oid = c.reltoastrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p')
      AND pg_relation_size(t.oid) > 100 * 1024 * 1024  -- > 100 MB
    ORDER BY pg_relation_size(t.oid) DESC;

    -- Step 3: For each large table, set per-column lz4 and rewrite
    -- (use pg_repack for online; VACUUM FULL for small-and-offline)

### 11. Distinguish in-line, compressed-in-line, and out-of-line for diagnosis

    SELECT
        id,
        pg_column_size(payload)               AS disk_bytes,
        octet_length(payload::text)           AS uncompressed_text_bytes,
        pg_column_compression(payload)        AS algo,           -- PG14+
        pg_column_toast_chunk_id(payload)     AS chunk_id        -- PG17+
    FROM events
    LIMIT 10;

- `algo IS NULL` AND `chunk_id IS NULL` → value stored uncompressed in-line (small, or `EXTERNAL` strategy fit).
- `algo IS NOT NULL` AND `chunk_id IS NULL` → value compressed but kept in-line (`EXTENDED` or `MAIN` succeeded with compression alone).
- `algo IS NOT NULL` AND `chunk_id IS NOT NULL` → value compressed AND moved out-of-line.
- `algo IS NULL` AND `chunk_id IS NOT NULL` → value out-of-line uncompressed (`EXTERNAL` strategy).

### 12. Watch TOAST traffic in EXPLAIN BUFFERS

The TOAST table buffer reads do not appear as a separate node, but they do count in the `Buffers` line under the parent scan:

    EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT payload FROM events WHERE id = 42;
    --                       ^^^^^^^ shows reads on both the main heap AND its TOAST relation

Compare to the no-de-TOAST variant:

    EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT id, length(payload) FROM events WHERE id = 42;

The `length()` of a TOASTed varlena is a header read, not a full de-TOAST — `length(payload)` does NOT fetch the chunks. The difference in `Buffers: shared hit/read` between the two plans is the de-TOAST traffic.

> [!NOTE]
> `octet_length(payload)` is also header-only for TOASTed values; the chunk fetch is skipped because the size lives in the header. Same for `pg_column_size(payload)`.

### 13. Migration: large `bytea` blob → Large Object

`bytea` works well up to ~10 MB per value. Beyond that, consider the LO API (see [71-large-objects.md](./71-large-objects.md)):

    -- Before: 50 MB bytea per row
    CREATE TABLE documents (id bigserial PRIMARY KEY, content bytea);

    -- After: oid pointer to pg_largeobject
    CREATE TABLE documents (id bigserial PRIMARY KEY, content_oid oid);
    -- Use lo_import / lo_export / lo_creat instead of INSERT/SELECT on content

Trade-offs:

- `bytea` is transactional in the usual way; full content rewritten on every UPDATE.
- LO supports streaming read/write (lo_open / lo_read / lo_write) and partial updates.
- LO is referenced by oid, so cleanup needs `vacuumlo` or `lo_unlink` — no automatic GC when the parent row is deleted.

## Gotchas / Anti-patterns

1. **`SET STORAGE` does not rewrite existing rows.** New strategy applies only to future writes. Use `VACUUM FULL` or `pg_repack` to rewrite. Same for `SET COMPRESSION`.

2. **`SET COMPRESSION lz4` requires server built with `--with-lz4`.** Without it, the GUC accepts `lz4` but actual compression silently falls back. Confirm with `SHOW default_toast_compression` and `pg_column_compression()` on test data.

3. **The 2 KB threshold is per-row, not per-column.** A row with one 1.5 KB column and several 100-byte columns may not trigger TOAST; a row with three 800-byte columns will.

4. **`SELECT *` on a wide-row table de-TOASTs every selected row.** Even if your application uses only the narrow columns, the wide column is fetched. Use explicit column lists.

5. **`length()` and `octet_length()` are free; substring is not.** Header bytes give the size; substring of a compressed value requires full decompression. For `EXTERNAL` (uncompressed out-of-line), substring is partial-fetch optimized.

6. **Partial JSONB updates rewrite the whole TOAST value.** `jsonb_set` produces a new value; the entire new value goes through TOAST again. Hot scalar fields belong in their own columns (Recipe 9).

7. **Compressing already-compressed data wastes CPU and may slightly grow storage.** JPEG, MP3, gzipped blobs → use `EXTERNAL` to skip compression attempts.

8. **TOAST tables can have severe bloat that's invisible from the main table's `pg_stat_*` rows.** A table with stable main heap and constant updates to a wide column accumulates dead chunks in the sidecar. Monitor `pg_stat_*_tables` for the TOAST relation by its name (`pg_toast.pg_toast_<oid>`).

9. **TOAST tables cannot set `fillfactor`.** Cross-reference [30-hot-updates.md](./30-hot-updates.md) gotcha #8. They are always packed 100%, and HOT does not apply across the TOAST table's own rows.

10. **`pg_column_size(col)` is not raw size — it is the on-disk size including TOAST pointer header.** For a 10 KB out-of-line value, `pg_column_size` returns ~18 (the pointer), not 10240. Use `octet_length(col::text)` or unwrap the varlena to get the logical content length.

11. **`pg_column_compression` returns NULL for uncompressed values, *including* for non-TOAST-able types.** Don't write code that assumes NULL means "value missing." Use `IS NOT NULL` to check actual compression; `IS NULL` does not discriminate between "small in-line" and "EXTERNAL out-of-line".

12. **Per-row UPDATE cost: unchanged out-of-line values are preserved.** This is a feature, but it means an UPDATE that does *touch* the wide value writes both new and dead TOAST chunks. The dead chunks need autovacuum on the TOAST table.

13. **`toast_tuple_target` cannot exceed `(block_size - header) = 8160`.** The docs are explicit on the range [128, 8160]. Don't try to set it higher to "force in-line storage" — the value is silently capped.

14. **No `toast_compression` per-table-storage parameter exists.** Compression is per-column (`SET COMPRESSION`) or cluster-wide (`default_toast_compression`). There is no table-level override of compression.

15. **TOAST pointers are 18 bytes regardless of value size.** Doesn't matter if the value is 3 KB or 1 GB — the pointer is the same width. This means narrow heap tuples and uniform row sizes even when wide columns vary wildly.

16. **`pg_total_relation_size` includes the TOAST table; `pg_relation_size` does not.** Confusion between these two is the #1 "why is my table reporting wrong size" question.

17. **`VACUUM FULL` rewrites both the main heap and the TOAST table.** No way to vacuum-full only one. For the TOAST sidecar specifically, use `VACUUM (PROCESS_MAIN false)` (PG16+).

18. **`pg_repack` rewrites the main heap and the TOAST table.** Same as VACUUM FULL but online. Cross-reference [26-index-maintenance.md](./26-index-maintenance.md).

19. **The TOAST table's index is `pg_toast_<oid>_index` — visible in pg_indexes**, and counts toward the cluster's index inventory. Bloat detection queries that filter `pg_namespace NOT IN ('pg_catalog', 'pg_toast')` exclude TOAST indexes by design.

20. **Logical replication decodes TOASTed values lazily but transmits them in full.** For very wide values, the logical replication stream can be much larger than the equivalent physical WAL. The `REPLICA IDENTITY FULL` setting forces the old row including TOASTed columns into the WAL — be careful on tables with wide unmodified columns.

21. **TOAST relations are not copied during ATTACH PARTITION CONCURRENTLY.** When attaching a partition, its existing TOAST relation comes with it; cross-partition TOAST tables do not exist. Each partition has its own.

22. **No "TOAST de-TOAST" operator appears in EXPLAIN.** The cost is hidden in `Buffers: shared hit/read` under the parent scan. Always use `EXPLAIN (ANALYZE, BUFFERS)` when investigating wide-column queries.

23. **TOAST does not apply to indexes (with one PG18 exception).** Index tuples must fit on one page (the ~1/3-page rule from [23-btree-indexes.md](./23-btree-indexes.md)); they are never TOASTed. The one exception is `pg_index`'s own `indexprs`/`indpred` columns, which got TOAST support in PG18 [^pg18-toast-pg-index] — this enables very large expression indexes that previously failed at CREATE time.

## See Also

- [14-data-types-builtin.md](./14-data-types-builtin.md) — bytea and the ~10 MB rule before LO migration.
- [17-json-jsonb.md](./17-json-jsonb.md) — hot-scalar-hoist pattern for avoiding TOAST rewrites on partial updates.
- [26-index-maintenance.md](./26-index-maintenance.md) — pg_repack for online TOAST-table rewrites.
- [28-vacuum-autovacuum.md](./28-vacuum-autovacuum.md) — PROCESS_TOAST and PROCESS_MAIN options; per-TOAST-table autovacuum tuning.
- [30-hot-updates.md](./30-hot-updates.md) — fillfactor not allowed on TOAST tables; HOT does not apply to TOAST.
- [27-mvcc-internals.md](./27-mvcc-internals.md) — MVCC visibility rules that apply to TOAST rows; REPLICA IDENTITY FULL and TOASTed columns.
- [33-wal.md](./33-wal.md) — WAL impact of TOAST writes vs the in-line case.
- [56-explain.md](./56-explain.md) — `EXPLAIN (ANALYZE, BUFFERS)` for detecting de-TOAST traffic.
- [71-large-objects.md](./71-large-objects.md) — when bytea is too small and the LO API is right.
- [74-logical-replication.md](./74-logical-replication.md) — TOAST and REPLICA IDENTITY FULL interactions.

## Sources

[^toast-threshold]: PostgreSQL 16 docs, "TOAST". Verbatim: *"The TOAST management code is triggered only when a row value to be stored in a table is wider than `TOAST_TUPLE_THRESHOLD` bytes (normally 2 kB). The TOAST code will compress and/or move field values out-of-line until the row value is shorter than `TOAST_TUPLE_TARGET` bytes (also normally 2 kB, adjustable)."* https://www.postgresql.org/docs/16/storage-toast.html

[^four-strategies]: PostgreSQL 16 docs, "TOAST" — strategy descriptions. Verbatim: *"`PLAIN` prevents either compression or out-of-line storage. … `EXTENDED` allows both compression and out-of-line storage. This is the default for most TOAST-able data types. Compression will be attempted first, then out-of-line storage if the row is still too big. … `EXTERNAL` allows out-of-line storage but not compression. Use of `EXTERNAL` will make substring operations on wide `text` and `bytea` columns faster (at the penalty of increased storage space) … `MAIN` allows compression but not out-of-line storage. (Actually, out-of-line storage will still be performed for such columns, but only as a last resort when there is no other way to make the row small enough to fit on a page.)"* https://www.postgresql.org/docs/16/storage-toast.html

[^toast-chunking]: PostgreSQL 16 docs, "TOAST" — chunking. Verbatim: *"Out-of-line values are divided (after compression if used) into chunks of at most `TOAST_MAX_CHUNK_SIZE` bytes (by default this value is chosen so that four chunk rows will fit on a page, making it about 2000 bytes). Each chunk is stored as a separate row in the TOAST table belonging to the owning table."* https://www.postgresql.org/docs/16/storage-toast.html

[^toast-naming]: PostgreSQL 16 docs, "TOAST" — pg_toast schema. Verbatim: *"Every TOAST table has the columns `chunk_id` (an OID identifying the particular TOASTed value), `chunk_seq` (a sequence number for the chunk within its value), and `chunk_data` (the actual data of the chunk). A unique index on `chunk_id` and `chunk_seq` provides fast retrieval of the values."* https://www.postgresql.org/docs/16/storage-toast.html

[^toast-pointer]: PostgreSQL 16 docs, "TOAST" — pointer format. Verbatim: *"A pointer datum representing an out-of-line on-disk TOASTed value therefore needs to store the OID of the TOAST table in which to look and the OID of the specific value (its `chunk_id`). … the total size of an on-disk TOAST pointer datum is therefore 18 bytes regardless of the actual size of the represented value."* https://www.postgresql.org/docs/16/storage-toast.html

[^in-mem-pointer]: PostgreSQL 16 docs, "TOAST" — in-memory pointers. Verbatim: *"In-memory TOAST pointers are automatically expanded to normal in-line varlena values before storage — and then possibly converted to on-disk TOAST pointers, if the containing tuple would otherwise be too big."* https://www.postgresql.org/docs/16/storage-toast.html

[^update-preserve]: PostgreSQL 16 docs, "TOAST" — UPDATE behavior. Verbatim: *"During an UPDATE operation, values of unchanged fields are normally preserved as-is; so an UPDATE of a row with out-of-line values incurs no TOAST costs if none of the out-of-line values change."* https://www.postgresql.org/docs/16/storage-toast.html

[^alter-storage]: PostgreSQL 16 docs, ALTER TABLE — SET STORAGE / SET COMPRESSION. Verbatim: *"This form sets the storage mode for a column. This controls whether this column is held inline or in a secondary TOAST table, and whether the data should be compressed or not. … Note that `ALTER TABLE ... SET STORAGE` doesn't itself change anything in the table; it just sets the strategy to be pursued during future table updates. … This form sets the compression method for a column, determining how values inserted in future will be compressed (if the storage mode permits compression at all). The supported compression methods are `pglz` and `lz4`. In addition, _compression_method_ can be `default`, which selects the default behavior of consulting the `default_toast_compression` setting at the time of data insertion to determine the method to use."* https://www.postgresql.org/docs/16/sql-altertable.html

[^toast-target]: PostgreSQL 16 docs, CREATE TABLE — toast_tuple_target. Verbatim: *"The `toast_tuple_target` specifies the minimum tuple length required before we try to compress and/or move long column values into TOAST tables, and is also the target length we try to reduce the length below once toasting begins. … Valid values are between 128 bytes and the (block size - header), by default 8160 bytes. … By default this parameter is set to allow at least 4 tuples per block, which with the default block size will be 2040 bytes."* https://www.postgresql.org/docs/16/sql-createtable.html

[^toast-prefix]: PostgreSQL 16 docs, CREATE TABLE — toast.* storage parameters. Verbatim: *"For many of these parameters, as shown, there is an additional parameter with the same name prefixed with `toast.`, which controls the behavior of the table's secondary TOAST table, if any. If a table parameter value is set and the equivalent `toast.` parameter is not, the TOAST table will use the table's parameter value."* https://www.postgresql.org/docs/16/sql-createtable.html

[^default-toast]: PostgreSQL 16 docs, runtime config — default_toast_compression. Verbatim: *"`default_toast_compression` (enum) — This variable sets the default TOAST compression method for values of compressible columns. (This can be overridden for individual columns by setting the `COMPRESSION` column option in `CREATE TABLE` or `ALTER TABLE`.) The supported compression methods are `pglz` and (if PostgreSQL was compiled with `--with-lz4`) `lz4`. The default is `pglz`."* https://www.postgresql.org/docs/16/runtime-config-client.html

[^pg14-lz4]: PostgreSQL 14 release notes. Verbatim: *"Add ability to use LZ4 compression on TOAST data (Dilip Kumar). This can be set at the column level, or set as a default via server parameter `default_toast_compression`. The server must be compiled with `--with-lz4` to support this feature. The default setting is still `pglz`."* https://www.postgresql.org/docs/release/14.0/

[^pg14-process-toast]: PostgreSQL 14 release notes. Verbatim: *"Add ability to skip vacuuming of TOAST tables (Nathan Bossart). VACUUM now has a `PROCESS_TOAST` option which can be set to false to disable TOAST processing, and vacuumdb has a `--no-process-toast` option."* https://www.postgresql.org/docs/release/14.0/

[^pg14-composite]: PostgreSQL 14 release notes. Verbatim: *"Remove the composite types that were formerly created for sequences and toast tables (Tom Lane)."* https://www.postgresql.org/docs/release/14.0/

[^pg15-dedup]: PostgreSQL 15 release notes. Verbatim: *"Allow btree indexes on system and TOAST tables to efficiently store duplicates (Peter Geoghegan). Previously de-duplication was disabled for these types of indexes."* https://www.postgresql.org/docs/release/15.0/

[^pg15-amcheck]: PostgreSQL 15 release notes. Verbatim: *"Improve amcheck sanity checks for TOAST tables (Mark Dilger)."* https://www.postgresql.org/docs/release/15.0/

[^pg16-process-main]: PostgreSQL 16 release notes. Verbatim: *"Allow `VACUUM` and vacuumdb to only process `TOAST` tables (Nathan Bossart). This is accomplished by having `VACUUM` turn off `PROCESS_MAIN` or by `vacuumdb` using the `--no-process-main` option."* https://www.postgresql.org/docs/release/16.0/

[^pg17-chunk-id]: PostgreSQL 17 release notes. Verbatim: *"Add function `pg_column_toast_chunk_id()` to return a value's TOAST identifier (Yugo Nagata). This returns `NULL` if the value is not stored in TOAST."* https://www.postgresql.org/docs/release/17.0/

[^pg18-toast-pg-index]: PostgreSQL 18 release notes. Verbatim: *"Add TOAST table to `pg_index` to allow for very large expression indexes (Nathan Bossart)."* https://www.postgresql.org/docs/release/18.0/

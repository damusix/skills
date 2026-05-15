# Large Objects (LO)

The legacy blob-storage facility predating `bytea`. Two-table model, function-based API, streaming-read semantics, manual cleanup. Use `bytea` for new code unless specific operational requirements apply.

> [!WARNING] Large Objects are PG's legacy blob storage. For most new code, use `bytea`.
> `bytea` is the SQL-typed default for binary data ≤ ~10 MB per value, supports indexing and replication cleanly, has no orphan-cleanup story. Reach for Large Objects only when (a) values exceed ~10 MB and streaming I/O matters, (b) server-side `lo_import` / `lo_export` for filesystem-resident files (superuser-only) is required, or (c) maintaining an existing LO-based schema. See [`14-data-types-builtin.md`](./14-data-types-builtin.md) and [`31-toast.md`](./31-toast.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Storage Model](#storage-model)
    - [`pg_largeobject_metadata` Catalog](#pg_largeobject_metadata-catalog)
    - [`pg_largeobject` Catalog](#pg_largeobject-catalog)
    - [Server-side LO Functions](#server-side-lo-functions)
    - [libpq Client-side LO API](#libpq-client-side-lo-api)
    - [`lo_compat_privileges` GUC](#lo_compat_privileges-guc)
    - [The `lo` Extension](#the-lo-extension)
    - [`vacuumlo` CLI Tool](#vacuumlo-cli-tool)
    - [Per-version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- Inheriting a schema that stores blobs as `oid` or `lo`-domain references
- Choosing between `bytea` and LO for new blob-storage requirements
- Investigating orphan LOs eating disk space
- Auditing LO privileges, especially after PG18 upgrade
- Setting up `lo_manage` triggers to auto-cleanup on row delete
- Running `vacuumlo` to reclaim orphan space
- Diagnosing transaction-scope errors from a libpq LO client

Not in scope here: `bytea` mechanics ([`14-data-types-builtin.md`](./14-data-types-builtin.md)), TOAST internals ([`31-toast.md`](./31-toast.md)), `pg_dump` LO handling ([`83-backup-pg-dump.md`](./83-backup-pg-dump.md)).

## Mental Model

Five rules drive every LO decision:

1. **Two-table model.** `pg_largeobject_metadata` (one row per LO, owner + ACL) plus `pg_largeobject` (one row per ~2 KB page, sparse-allowed). The `oid` is the LO identifier.
2. **Function-based API, not SQL type.** Create, open, read, write, seek, close, unlink — all functions. The LO `oid` lives in user-table columns of type `oid` (or `lo`-domain over `oid`).
3. **Descriptors are transaction-scoped.** Verbatim docs: *"All large object manipulation using these functions must take place within an SQL transaction block, since large object file descriptors are only valid for the duration of a transaction."* `lo_open` returns a descriptor that becomes invalid at `COMMIT` or `ROLLBACK`.
4. **No automatic cleanup on row delete.** Removing the `oid` reference from a user table does NOT unlink the LO. Either install the `lo` extension's `lo_manage` trigger to auto-unlink, or schedule `vacuumlo` periodically.
5. **`bytea` is the modern default.** LO predates `bytea`. Reach for LO only when (a) values exceed ~10 MB and the application needs streaming I/O without full-row TOAST de-TOAST cost, or (b) `lo_import` / `lo_export` for server-side file I/O is required (superuser-only).

> [!WARNING] PG has no in-core blob streaming for `bytea`.
> `bytea` always materializes to the client as one chunk. For multi-hundred-MB values where streaming chunk-by-chunk matters, LO is the in-core option. Out-of-DB stores (S3, GCS) usually beat both for very large values.

## Decision Matrix

| You need | Use | Why |
|---|---|---|
| Binary blob ≤ ~10 MB, sometimes-read | `bytea` column | Single-type-system, replicates cleanly, no orphan-cleanup, TOAST handles compression |
| Binary blob > 10 MB, sometimes-streamed | LO | Page-level access, `lo_lseek64` + `lo_read` streaming, no per-statement materialization |
| Binary blob > 1 GB | External store (S3/GCS/MinIO) | `bytea` capped at 1 GB; LO capped at 4 TB but operationally painful at TB scale |
| Server-side import from filesystem | `lo_import('/path/file')` | Built-in; superuser-only or `pg_read_server_files` role |
| Server-side export to filesystem | `lo_export(loid, '/path/file')` | Built-in; superuser-only or `pg_write_server_files` role |
| Application stores file uploads | External store + `bytea` for metadata | Avoids replication amplification, easier backup |
| Schema already uses LO, can't migrate | Add `lo_manage` trigger | Auto-unlinks LO on row delete/update |
| Suspect orphan LO eating disk | Run `vacuumlo` | Removes LOs not referenced by any `oid` or `lo`-domain column |
| Need to dump/restore LO | `pg_dump -F directory` | PG17+ restores LOs in batches/parallel; LO dump always full-data, no `--data-only` skip |
| Audit LO privileges (PG18+) | `has_largeobject_privilege()` | New per-LO privilege check function |
| Pre-PG18 audit LO privileges | Query `pg_largeobject_metadata.lomacl` directly | Decode `aclitem[]` manually |
| Need per-LO RLS | None — not supported | LO ACLs are per-LO grant-based, no row-policy mechanism |
| Need cross-cluster LO replication | Logical replication of `oid` columns + parallel LO sync | Logical replication does NOT replicate `pg_largeobject` contents automatically |

Three smell signals you're using LO wrong:

1. **Storing thousands of small (<1 MB) LOs** — orphan-cleanup overhead dominates, `bytea` would have been simpler.
2. **LO column without `lo_manage` trigger or scheduled `vacuumlo`** — orphans accumulate indefinitely, disk grows silently.
3. **Application opens LO, reads or writes, then connection dies before COMMIT** — descriptor is gone, partial writes are lost, and the LO is orphaned.

## Syntax / Mechanics

### Storage Model

Every LO is identified by an `oid`. The metadata row in `pg_largeobject_metadata` records ownership and ACL. The data lives in `pg_largeobject`, one row per ~2 KB page. Page numbers count from zero. Missing pages read as zeros — LOs can be **sparse**.

```
pg_largeobject_metadata          pg_largeobject
+-----+----------+--------+      +-------+--------+--------+
| oid | lomowner | lomacl |      | loid  | pageno | data   |
+-----+----------+--------+      +-------+--------+--------+
| 24528| 16384   | {...}  |      | 24528 | 0      | \x...  |
+-----+----------+--------+      | 24528 | 1      | \x...  |
                                 | 24528 | 2      | \x...  |
                                 +-------+--------+--------+
```

`LOBLKSIZE` = `BLCKSZ / 4` ≈ 2 KB on default builds. Each `pg_largeobject` row holds up to `LOBLKSIZE` bytes; the last page can be shorter.

User tables reference LOs by storing the `oid` in a column. Two conventions:

```sql
-- Plain oid column (no integrity link, vacuumlo will not auto-detect domains)
CREATE TABLE document (
    id bigserial PRIMARY KEY,
    filename text NOT NULL,
    raster oid
);

-- lo domain (recommended; clearer intent, vacuumlo will detect)
CREATE EXTENSION lo;

CREATE TABLE document (
    id bigserial PRIMARY KEY,
    filename text NOT NULL,
    raster lo
);
```

> [!NOTE] PostgreSQL 9.0
> Pre-9.0, LOs had no privileges and were readable/writable by all users. PG 9.0 introduced per-LO ACLs. The `lo_compat_privileges` GUC restores pre-9.0 behavior for legacy code.

### `pg_largeobject_metadata` Catalog

One row per LO. Defined in [`catalog-pg-largeobject-metadata.html`](https://www.postgresql.org/docs/16/catalog-pg-largeobject-metadata.html).

| Column | Type | Description |
|---|---|---|
| `oid` | `oid` | Row identifier; this is the LO `oid` referenced from user tables |
| `lomowner` | `oid` (FK to `pg_authid.oid`) | Owner of the LO |
| `lomacl` | `aclitem[]` | Access privileges (SELECT, UPDATE) — see [`46-roles-privileges.md`](./46-roles-privileges.md) for ACL decoding |

This catalog is accessible to non-superusers (read-only). To audit LO ownership cluster-wide:

```sql
SELECT lomowner::regrole AS owner, count(*) AS lo_count
FROM pg_largeobject_metadata
GROUP BY lomowner
ORDER BY lo_count DESC;
```

### `pg_largeobject` Catalog

One row per LO page. Defined in [`catalog-pg-largeobject.html`](https://www.postgresql.org/docs/16/catalog-pg-largeobject.html).

| Column | Type | Description |
|---|---|---|
| `loid` | `oid` | LO that owns this page (references `pg_largeobject_metadata.oid`) |
| `pageno` | `int4` | Page number within the LO, starting at 0 |
| `data` | `bytea` | Page contents. Up to `LOBLKSIZE` bytes; can be shorter for the final page |

> [!WARNING] `pg_largeobject` is superuser-only by default.
> Non-superusers cannot SELECT from `pg_largeobject` directly. Use the LO API functions (`lo_get`, `lo_open` + `loread`) which apply per-LO privilege checks.

To compute the size of a single LO:

```sql
SELECT sum(octet_length(data))::bigint AS bytes
FROM pg_largeobject
WHERE loid = 24528;
```

### Server-side LO Functions

Documented in [`lo-funcs.html`](https://www.postgresql.org/docs/16/lo-funcs.html). All callable directly from SQL.

| Function | Returns | Description |
|---|---|---|
| `lo_from_bytea(loid oid, data bytea)` | `oid` | Create a new LO from a `bytea` value. Pass `0` as `loid` to auto-assign |
| `lo_put(loid oid, offset bigint, data bytea)` | `void` | Write `data` at `offset` within `loid` |
| `lo_get(loid oid)` | `bytea` | Get entire LO contents as `bytea` |
| `lo_get(loid oid, offset bigint, length integer)` | `bytea` | Get substring |
| `lo_creat(mode int)` | `oid` | Legacy create; pass `INV_READ | INV_WRITE` (= -1) |
| `lo_create(loid oid)` | `oid` | Create with specified OID, or 0 for auto-assign |
| `lo_unlink(loid oid)` | `void` | Delete LO and all its pages |
| `lo_import(path text)` | `oid` | Import server-side file; **superuser-only or `pg_read_server_files` role** |
| `lo_import(path text, loid oid)` | `oid` | Import with specified OID |
| `lo_export(loid oid, path text)` | `void` | Export to server-side file; **superuser-only or `pg_write_server_files` role** |
| `loread(fd int, len int)` | `bytea` | Server-side variant of libpq `lo_read`; note **no underscore** |
| `lowrite(fd int, data bytea)` | `int` | Server-side variant of libpq `lo_write`; note **no underscore** |

> [!WARNING] `lo_import` / `lo_export` read or write the **server's** filesystem.
> The path is relative to the postgres backend process. In most managed environments, `pg_read_server_files` / `pg_write_server_files` roles are unavailable and the directory `lo_import` would read is empty. Use client-side LO API or `bytea` upload paths instead.

### libpq Client-side LO API

Documented in [`lo-interfaces.html`](https://www.postgresql.org/docs/16/lo-interfaces.html). These are C functions; equivalents exist in most language drivers (psycopg, JDBC, Go pgx).

| C function | Purpose | Notes |
|---|---|---|
| `lo_create(conn, loid)` | Create new LO | `loid` = 0 for auto-assign |
| `lo_creat(conn, mode)` | Legacy create | Deprecated on PG 8.1+ |
| `lo_import(conn, filename)` | Client-side file → LO | Reads from client filesystem |
| `lo_import_with_oid(conn, filename, loid)` | Import with specified OID | PG 8.4+ |
| `lo_export(conn, loid, filename)` | LO → client-side file | Writes to client filesystem |
| `lo_open(conn, loid, mode)` | Open LO, return file descriptor | `mode` = `INV_READ` (`0x40000`) and/or `INV_WRITE` (`0x20000`) |
| `lo_close(conn, fd)` | Close descriptor | Required cleanup |
| `lo_read(conn, fd, buf, len)` | Read up to `len` bytes | `len ≤ INT_MAX` |
| `lo_write(conn, fd, buf, len)` | Write up to `len` bytes | `len ≤ INT_MAX` |
| `lo_lseek(conn, fd, offset, whence)` | Seek within LO | 32-bit offset; use `lo_lseek64` for > 2 GB |
| `lo_lseek64(conn, fd, offset, whence)` | 64-bit seek | PG 9.3+ |
| `lo_tell(conn, fd)` | Current offset | 32-bit |
| `lo_tell64(conn, fd)` | 64-bit current offset | PG 9.3+ |
| `lo_truncate(conn, fd, len)` | Truncate to `len` | 32-bit |
| `lo_truncate64(conn, fd, len)` | 64-bit truncate | PG 9.3+ |
| `lo_unlink(conn, loid)` | Delete LO | Same effect as server-side `lo_unlink(oid)` |

Three operational constraints:

- **Transaction-scoped descriptors.** From the docs: *"All large object manipulation using these functions must take place within an SQL transaction block, since large object file descriptors are only valid for the duration of a transaction."* If the application calls `lo_open`, then runs `COMMIT`, the returned `fd` becomes invalid. Subsequent `lo_read`/`lo_write` on that `fd` fails.
- **Read-only transactions reject write opens.** From the docs: *"Write operations, including `lo_open` with the `INV_WRITE` mode, are not allowed in a read-only transaction."*
- **Pipeline mode incompatibility.** From the docs: *"Client applications cannot use these functions while a libpq connection is in pipeline mode."*

Privilege model: `lo_open` with `INV_READ` requires `SELECT` on the LO; with `INV_WRITE` requires `UPDATE`. Granted via `GRANT SELECT|UPDATE ON LARGE OBJECT <loid> TO <role>` per [`46-roles-privileges.md`](./46-roles-privileges.md).

### `lo_compat_privileges` GUC

Lives on [`runtime-config-compatible.html`](https://www.postgresql.org/docs/16/runtime-config-compatible.html), not on the resource-config page (a common URL trap).

> [!NOTE]
> Verbatim docs: *"In PostgreSQL releases prior to 9.0, large objects did not have access privileges and were, therefore, always readable and writable by all users. Setting this variable to `on` disables the new privilege checks, for compatibility with prior releases. The default is `off`. Only superusers and users with the appropriate `SET` privilege can change this setting."*

When `on`, all per-LO privilege checks are bypassed: any role with database access can read or write any LO. Set this only when porting from PG 8.x and only with eyes open.

```sql
-- Check current setting
SHOW lo_compat_privileges;

-- Disable per-session (preferred if needed at all)
SET lo_compat_privileges = on;
```

### The `lo` Extension

Documented in [`lo.html`](https://www.postgresql.org/docs/16/lo.html). Trusted extension (PG13+) — non-superusers with `CREATE` on the database can install.

The extension provides exactly two things:

1. **The `lo` domain type** — a domain over `oid` for differentiating LO references from other OID-typed columns. Verbatim: *"This is useful for differentiating database columns that hold large object references from those that are OIDs of other things."*
2. **The `lo_manage` trigger function** — attaches to a user table; on UPDATE or DELETE, calls `lo_unlink` on the old LO reference, preventing orphan accumulation.

Canonical install:

```sql
CREATE EXTENSION lo;

CREATE TABLE image (
    id   bigserial PRIMARY KEY,
    title text NOT NULL,
    raster lo  -- domain over oid; vacuumlo will recognize this column
);

CREATE TRIGGER t_raster
    BEFORE UPDATE OR DELETE ON image
    FOR EACH ROW EXECUTE FUNCTION lo_manage(raster);
```

After this, deleting a row from `image` automatically unlinks the LO. Updating `raster` to a new OID automatically unlinks the old one.

> [!WARNING] `lo_manage` trigger fires only on the table it's attached to.
> If two user tables reference the same LO (shared reference), unlinking via one table's trigger leaves dangling references in the other. The `lo` extension does not implement reference counting.

### `vacuumlo` CLI Tool

Documented in [`vacuumlo.html`](https://www.postgresql.org/docs/16/vacuumlo.html). Companion tool that walks every user table and reclaims orphan LOs.

Verbatim algorithm: *"vacuumlo works by the following method: First, vacuumlo builds a temporary table which contains all of the OIDs of the large objects in the selected database. It then scans through all columns in the database that are of type `oid` or `lo`, and removes matching entries from the temporary table. (Note: Only types with these names are considered; in particular, domains over them are not considered.) The remaining entries in the temporary table identify orphaned LOs. These are removed."*

Key flags:

| Flag | Default | Description |
|---|---|---|
| `-l limit` / `--limit=limit` | 1000 | Number of LOs to remove per transaction |
| `-n` / `--dry-run` | off | Don't actually unlink; report what would be removed |
| `-v` / `--verbose` | off | Show per-LO removal |
| `-h host` / `-p port` / `-U user` | env | Connection options |

Run periodically (typically nightly via cron or `pg_cron`):

```bash
vacuumlo --verbose mydb
```

> [!WARNING] `vacuumlo` only considers columns of type `oid` or `lo`.
> Domains over `oid` (other than the `lo` domain itself) are not considered. A user-defined domain `CREATE DOMAIN raster_id AS oid` will cause every LO referenced through that domain to look orphaned and get unlinked. Use the `lo` domain or a plain `oid` column to be safe.

### Per-version Timeline

| Version | Changes |
|---|---|
| **PG 14** | No LO release-note items |
| **PG 15** | psql `\lo_list+` / `\dl+` show LO privileges (Pavel Luzanov) |
| **PG 16** | No LO release-note items |
| **PG 17** | `pg_dump` restores LOs in batches, can parallelize (Tom Lane). Verbatim: *"This allows the restoration of many large objects to avoid transaction limits and to be restored in parallel."* |
| **PG 18** | `has_largeobject_privilege()` function (Yugo Nagata); `ALTER DEFAULT PRIVILEGES` supports `LARGE OBJECTS` (Takatsuka Haruka, Yugo Nagata, Laurenz Albe) |

Six PG majors of near-stability — the LO surface has been frozen since the privilege model landed in PG 9.0. The PG 17 dump improvement matters operationally for large LO populations; the PG 18 additions modernize the privilege story.

## Examples / Recipes

### 1. Baseline LO column with `lo_manage` cleanup

```sql
CREATE EXTENSION IF NOT EXISTS lo;

CREATE TABLE document (
    id       bigserial PRIMARY KEY,
    filename text NOT NULL,
    content  lo NOT NULL,           -- lo domain over oid
    uploaded_at timestamptz DEFAULT now()
);

CREATE TRIGGER t_document_lo
    BEFORE UPDATE OR DELETE ON document
    FOR EACH ROW EXECUTE FUNCTION lo_manage(content);

-- Insert a document from a bytea blob
INSERT INTO document (filename, content)
VALUES ('report.pdf', lo_from_bytea(0, decode('255044462d312e34...', 'hex')));

-- Read it back
SELECT lo_get(content) FROM document WHERE id = 1;

-- Delete the row — trigger auto-unlinks the LO
DELETE FROM document WHERE id = 1;
```

### 2. Streaming LO upload from a libpq client (Python via psycopg)

```python
import psycopg

with psycopg.connect("dbname=mydb") as conn:
    with conn.transaction():
        lo = conn.execute("SELECT lo_create(0)").fetchone()[0]
        # Open for write, returns fd
        fd = conn.execute("SELECT lo_open(%s, %s)", (lo, 0x20000)).fetchone()[0]
        with open('large_file.bin', 'rb') as f:
            while chunk := f.read(8192):
                conn.execute("SELECT lowrite(%s, %s)", (fd, chunk))
        # No need to close fd explicitly — transaction commit releases it
    # After commit, store the lo oid in a user table
    conn.execute("INSERT INTO document(filename, content) VALUES (%s, %s)",
                 ('large_file.bin', lo))
```

> [!WARNING] If the transaction rolls back, the LO is still created.
> `lo_create` writes to `pg_largeobject_metadata`, which is transactional — so an aborted transaction will roll back the LO. Good. But: any LO created and committed without being inserted into a referencing user table is immediately orphaned.

### 3. Detect orphan LOs without running `vacuumlo`

```sql
-- All LOs that no oid or lo column references
SELECT m.oid
FROM pg_largeobject_metadata m
WHERE NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND (t.typname IN ('oid', 'lo'))
      -- This is approximate: doesn't actually check column values.
      -- vacuumlo --dry-run does the real check.
)
LIMIT 100;
```

For an exact orphan list, use `vacuumlo --dry-run --verbose mydb` which scans actual column values.

### 4. Audit LO ownership and ACLs cluster-wide

```sql
SELECT
    m.oid                AS lo_oid,
    m.lomowner::regrole  AS owner,
    m.lomacl             AS acl,
    pg_size_pretty(
        (SELECT sum(octet_length(data))::bigint
         FROM pg_largeobject l
         WHERE l.loid = m.oid)
    ) AS size
FROM pg_largeobject_metadata m
ORDER BY m.oid;
```

For thousands of LOs this is slow because each `sum(octet_length(...))` scans `pg_largeobject`. Restrict the outer query first.

### 5. Compute total LO storage

```sql
SELECT
    count(*)                                AS lo_count,
    pg_size_pretty(pg_relation_size('pg_largeobject')) AS pg_largeobject_size,
    pg_size_pretty(pg_relation_size('pg_largeobject_metadata')) AS metadata_size
FROM pg_largeobject_metadata;
```

`pg_largeobject` size is the true on-disk footprint; the metadata table is tiny.

### 6. PG 18+ audit LO privileges with `has_largeobject_privilege()`

```sql
-- Find LOs that role 'reader' has SELECT on
SELECT m.oid
FROM pg_largeobject_metadata m
WHERE has_largeobject_privilege('reader', m.oid, 'SELECT');

-- Find LOs that no non-owner role has UPDATE on
SELECT m.oid, m.lomowner::regrole AS owner
FROM pg_largeobject_metadata m
WHERE NOT EXISTS (
    SELECT 1
    FROM pg_roles r
    WHERE r.oid != m.lomowner
      AND has_largeobject_privilege(r.oid, m.oid, 'UPDATE')
);
```

> [!NOTE] PostgreSQL 18
> `has_largeobject_privilege()` is new. Pre-PG18: decode `pg_largeobject_metadata.lomacl::text[]` manually using `aclexplode()`.

### 7. PG 18+ default privileges for LOs

```sql
-- Grant SELECT on every future LO created by 'uploader' to 'reader'
ALTER DEFAULT PRIVILEGES FOR ROLE uploader
    GRANT SELECT ON LARGE OBJECTS TO reader;

-- Verify
SELECT defaclrole::regrole, defaclobjtype, defaclacl
FROM pg_default_acl
WHERE defaclobjtype = 'L';  -- L = large object
```

> [!NOTE] PostgreSQL 18
> Pre-PG18: `ALTER DEFAULT PRIVILEGES ... ON LARGE OBJECTS` was a syntax error. Manual `GRANT ... ON LARGE OBJECT <loid>` was the only path.

### 8. Migrate from `oid` column to `bytea` column

When the size profile fits and you want to drop LO complexity:

```sql
-- Add bytea column alongside the existing oid column
ALTER TABLE document ADD COLUMN content_new bytea;

-- Backfill: read each LO into bytea
UPDATE document SET content_new = lo_get(content);

-- Drop the old oid column (this leaves the LOs themselves orphaned)
ALTER TABLE document DROP COLUMN content;

-- Now clean up the orphan LOs
-- Option A: vacuumlo (will find every LO not referenced anywhere)
-- vacuumlo --verbose mydb

-- Option B: explicit unlink per row
-- (Cannot do this post-DROP COLUMN; only viable if oids saved separately)

-- Rename the new column
ALTER TABLE document RENAME COLUMN content_new TO content;
```

> [!WARNING] Drop the LO references **before** running `vacuumlo`.
> If you `ALTER TABLE document DROP COLUMN content`, the LOs become orphaned. `vacuumlo` finds them. If you run `vacuumlo` first and then drop the column, the LOs are still referenced and won't be unlinked — you'd have to run `vacuumlo` again after the drop.

### 9. Migrate from `bytea` column to LO

When values grow past ~10 MB and streaming matters:

```sql
CREATE EXTENSION IF NOT EXISTS lo;

ALTER TABLE document ADD COLUMN content_lo lo;

UPDATE document
SET content_lo = lo_from_bytea(0, content)
WHERE content IS NOT NULL;

-- Add the lo_manage trigger BEFORE dropping the bytea column
CREATE TRIGGER t_document_lo
    BEFORE UPDATE OR DELETE ON document
    FOR EACH ROW EXECUTE FUNCTION lo_manage(content_lo);

ALTER TABLE document DROP COLUMN content;
ALTER TABLE document RENAME COLUMN content_lo TO content;
```

### 10. Schedule `vacuumlo` via `pg_cron`

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Nightly at 03:00 cluster time
SELECT cron.schedule(
    'vacuumlo-mydb',
    '0 3 * * *',
    $$SELECT lo_unlink(oid)
      FROM pg_largeobject_metadata m
      WHERE NOT EXISTS (
          -- This is approximate; vacuumlo binary is more thorough.
          -- See vacuumlo CLI for the real algorithm.
          SELECT 1 FROM document WHERE content = m.oid
      )$$
);
```

For accuracy, schedule the actual `vacuumlo` binary via system cron instead:

```cron
0 3 * * * /usr/bin/vacuumlo --verbose mydb >> /var/log/vacuumlo.log 2>&1
```

### 11. Diagnose "invalid large object descriptor" error

```sql
-- This will fail mid-transaction
BEGIN;
SELECT lo_open(24528, 0x40000);  -- fd = 0
COMMIT;
-- fd is now invalid

BEGIN;
SELECT loread(0, 1024);  -- ERROR: invalid large object descriptor: 0
ROLLBACK;
```

Fix: keep `lo_open`/`loread`/`lo_close` inside one transaction, or use `lo_get(oid)` which doesn't require a descriptor:

```sql
BEGIN;
SELECT lo_get(24528);  -- works at any point in any transaction
COMMIT;
```

### 12. Reset LO ownership after a role drop

`DROP OWNED BY ... CASCADE` does not always drop LOs. To reassign:

```sql
-- Reassign all LOs owned by old_owner to new_owner
DO $$
DECLARE
    lo_oid oid;
BEGIN
    FOR lo_oid IN
        SELECT oid FROM pg_largeobject_metadata
        WHERE lomowner = (SELECT oid FROM pg_authid WHERE rolname = 'old_owner')
    LOOP
        EXECUTE format('ALTER LARGE OBJECT %s OWNER TO new_owner', lo_oid);
    END LOOP;
END $$;
```

### 13. Find LOs referenced by zero rows but not orphaned by `vacuumlo` algorithm

If you have a domain other than `lo` over `oid`, `vacuumlo` will skip those columns. To find LOs reachable only through such columns:

```sql
SELECT n.nspname, c.relname, a.attname, t.typname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
JOIN pg_type bt ON bt.oid = t.typbasetype
WHERE c.relkind = 'r'
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND t.typtype = 'd'           -- domain
  AND bt.typname = 'oid'         -- over oid
  AND t.typname NOT IN ('lo', 'regclass', 'regproc', 'regtype');
```

Migrate any user-defined domains to the `lo` domain or to a plain `oid` column.

## Gotchas / Anti-patterns

1. **`oid` column without `lo_manage` trigger → silent orphan growth.** Deleting a row that references an LO does NOT unlink the LO. Either install `lo_manage` (see Recipe 1) or schedule `vacuumlo` (Recipe 10).
2. **`vacuumlo` skips columns of user-defined domains over `oid`.** Verbatim: *"Only types with these names are considered; in particular, domains over them are not considered."* Use `lo` domain or plain `oid`.
3. **LO descriptors expire at transaction end.** `lo_open` returns an `fd` valid only until `COMMIT` or `ROLLBACK`. Long-running batch jobs that open many LOs across multiple transactions must re-open each one.
4. **`lo_open INV_WRITE` fails in read-only transactions.** Including transactions on hot standbys. LO writes are primary-only.
5. **LO API incompatible with libpq pipeline mode.** Verbatim: *"Client applications cannot use these functions while a libpq connection is in pipeline mode."*
6. **`pg_largeobject` is superuser-only.** Non-superusers cannot `SELECT` from it directly. Use `lo_get` / `lo_open`+`loread` which apply per-LO privilege checks.
7. **`lo_import` / `lo_export` are superuser-only by default.** They read/write the **server's** filesystem. Granted to `pg_read_server_files` / `pg_write_server_files` predefined roles since PG11.
8. **LO size limit per single call is `INT_MAX` (~2 GB).** `lo_read`, `lo_write`, `lo_truncate` reject `len > INT_MAX`. Use chunked I/O.
9. **`lo_lseek` / `lo_tell` cap at 2 GB offset.** Use the 64-bit variants `lo_lseek64` / `lo_tell64` (PG 9.3+) for LOs > 2 GB.
10. **LOs are pages, not files.** Missing page numbers read as zeros. An LO can be sparse — written at offset 1 GB, the intermediate pages don't exist on disk. `octet_length(lo_get(oid))` returns the full size including sparse zeros, which may differ from the storage footprint.
11. **`bytea` capped at 1 GB; LO capped at 4 TB.** For values 1 GB – 4 TB, LO is the only in-database option.
12. **No automatic deduplication.** Storing the same blob in two LO rows costs 2× disk. The `oid` is per-LO-instance, not content-addressed.
13. **`pg_dump` always dumps LO contents in full.** No `--data-only` shortcut to skip LO data. PG17+ restores in batches/parallel; pre-PG17 restore can hit transaction-size limits on dumps with many LOs.
14. **`pg_dump --schema-only` does not skip LO metadata if `-b` (--blobs) is on.** Use `-B` / `--no-blobs` explicitly to omit LOs.
15. **Logical replication does NOT replicate `pg_largeobject` contents.** Subscriber sees the `oid` reference in user-table columns but the LO data is missing. Workaround: parallel sync of LO pages via separate logic, or migrate to `bytea`.
16. **`lo_manage` trigger only fires on its attached table.** If two tables reference the same LO, dropping one row leaves the LO orphan-from-the-other-table's-perspective. The extension has no reference counting.
17. **`vacuumlo --limit` defaults to 1000.** Removes up to 1000 LOs per transaction. For very large orphan populations, run multiple times.
18. **`vacuumlo` requires connect privilege on every database it scans.** When run against `--all`, must have access everywhere.
19. **`lo_compat_privileges = on` disables ALL per-LO access checks.** Setting it globally is a security regression. Use sparingly and only with eyes open.
20. **Server-side function names lack the underscore.** `loread` / `lowrite` server-side vs. `lo_read` / `lo_write` libpq. Easy to confuse when reading SQL.
21. **LO `oid` collisions are real.** OIDs are 32-bit. A cluster with billions of LOs over years can theoretically hit collisions; new LOs get assigned available unused OIDs. `lo_create(specific_oid)` fails if the OID is in use.
22. **`pg_dump` of a database with millions of LOs is slow.** PG17 batched restore helps, but the dump phase still touches every page. Plan accordingly for backup windows.
23. **`DROP TABLE` does NOT unlink LOs referenced from the dropped table.** Even with `lo_manage` trigger, the trigger fires on DML, not DDL. After `DROP TABLE`, run `vacuumlo` to clean up.

## See Also

- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — `bytea` mechanics, hex/escape formats, the bytea-vs-LO decision boundary
- [`72-extension-development.md`](./72-extension-development.md) — `lo_manage` is a bundled extension; extension installation mechanics and trusted-extension model
- [`31-toast.md`](./31-toast.md) — how `bytea` is stored when ≤ ~10 MB (TOAST), why LO matters past that threshold
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `GRANT ... ON LARGE OBJECT`, predefined roles `pg_read_server_files` / `pg_write_server_files`, `ALTER DEFAULT PRIVILEGES` semantics
- [`64-system-catalogs.md`](./64-system-catalogs.md) — catalog joins for `pg_largeobject` / `pg_largeobject_metadata` / `pg_default_acl`
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — `COPY` vs streaming LO I/O for bulk ingest
- [`74-logical-replication.md`](./74-logical-replication.md) — why logical replication does not transport `pg_largeobject` contents
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — `pg_dump` `-b` / `-B` flags, PG17+ batched LO restore
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling periodic `vacuumlo` runs
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed environments commonly disable `lo_import` / `lo_export` and the `pg_read_server_files` role

## Sources

[^chapter]: PostgreSQL 16 — *Large Objects* (Chapter 35). https://www.postgresql.org/docs/16/largeobjects.html

[^funcs]: PostgreSQL 16 — *Server-Side Functions*. https://www.postgresql.org/docs/16/lo-funcs.html

[^libpq]: PostgreSQL 16 — *Client Interfaces*. https://www.postgresql.org/docs/16/lo-interfaces.html — *"All large object manipulation using these functions must take place within an SQL transaction block, since large object file descriptors are only valid for the duration of a transaction."* Plus pipeline-mode incompatibility note.

[^meta]: PostgreSQL 16 — *pg_largeobject_metadata catalog*. https://www.postgresql.org/docs/16/catalog-pg-largeobject-metadata.html

[^pglo]: PostgreSQL 16 — *pg_largeobject catalog*. https://www.postgresql.org/docs/16/catalog-pg-largeobject.html

[^ext]: PostgreSQL 16 — *lo Extension* (Appendix F.22). https://www.postgresql.org/docs/16/lo.html — *"The module also provides a data type `lo`, which is really just a domain over the `oid` type."* Plus `lo_manage` trigger.

[^vacuumlo]: PostgreSQL 16 — *vacuumlo*. https://www.postgresql.org/docs/16/vacuumlo.html — *"Note: Only types with these names are considered; in particular, domains over them are not considered."*

[^compat]: PostgreSQL 16 — `lo_compat_privileges` GUC. https://www.postgresql.org/docs/16/runtime-config-compatible.html — *"In PostgreSQL releases prior to 9.0, large objects did not have access privileges and were, therefore, always readable and writable by all users."*

[^oid]: PostgreSQL 16 — *Object Identifier Types*. https://www.postgresql.org/docs/16/datatype-oid.html

[^pg15]: PostgreSQL 15.0 Release Notes — *"Add `+` option to the `\lo_list` and `\dl` commands to show large-object privileges (Pavel Luzanov)."* https://www.postgresql.org/docs/release/15.0/

[^pg17]: PostgreSQL 17.0 Release Notes — *"Allow pg_dump's large objects to be restorable in batches (Tom Lane). This allows the restoration of many large objects to avoid transaction limits and to be restored in parallel."* https://www.postgresql.org/docs/release/17.0/

[^pg18-priv]: PostgreSQL 18.0 Release Notes — *"Add function `has_largeobject_privilege()` to check large object privileges (Yugo Nagata)."* https://www.postgresql.org/docs/release/18.0/

[^pg18-defaclacl]: PostgreSQL 18.0 Release Notes — *"Allow ALTER DEFAULT PRIVILEGES to define large object default privileges (Takatsuka Haruka, Yugo Nagata, Laurenz Albe)."* https://www.postgresql.org/docs/release/18.0/

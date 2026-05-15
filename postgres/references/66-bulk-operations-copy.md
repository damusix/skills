# 66 — Bulk Operations: COPY

`COPY` is PostgreSQL's bulk-load primitive. Single SQL command moves rows between table and file/program/STDIN/STDOUT at ~10-100× the throughput of equivalent `INSERT` statements. Surface stable across many PG majors, but PG17 added error-tolerant ingest (`ON_ERROR`, `LOG_VERBOSITY`) and PG18 added `REJECT_LIMIT` plus one significant incompatibility (`\.` no longer treated as EOF marker server-side).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Full Grammar](#full-grammar)
    - [Server-side `COPY` vs Client-side `\copy`](#server-side-copy-vs-client-side-copy)
    - [Format Options](#format-options)
    - [FREEZE](#freeze)
    - [ON_ERROR / LOG_VERBOSITY / REJECT_LIMIT (PG17+/PG18+)](#on_error--log_verbosity--reject_limit-pg17pg18)
    - [HEADER MATCH (PG15+)](#header-match-pg15)
    - [Permissions](#permissions)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
    - [Recipe 1 — Baseline bulk load (CSV from file)](#recipe-1--baseline-bulk-load-csv-from-file)
    - [Recipe 2 — Client-side `\copy` from a remote machine](#recipe-2--client-side-copy-from-a-remote-machine)
    - [Recipe 3 — COPY FREEZE on new table](#recipe-3--copy-freeze-on-new-table)
    - [Recipe 4 — Drop indexes + FKs before load, recreate after](#recipe-4--drop-indexes--fks-before-load-recreate-after)
    - [Recipe 5 — Parallel multi-process COPY](#recipe-5--parallel-multi-process-copy)
    - [Recipe 6 — Error-tolerant ingest (PG17+)](#recipe-6--error-tolerant-ingest-pg17)
    - [Recipe 7 — Limit accepted error count (PG18+)](#recipe-7--limit-accepted-error-count-pg18)
    - [Recipe 8 — Stream COPY through pipe / PROGRAM](#recipe-8--stream-copy-through-pipe--program)
    - [Recipe 9 — COPY (query) TO — export filtered subset](#recipe-9--copy-query-to--export-filtered-subset)
    - [Recipe 10 — Binary format for PG-to-PG transfers](#recipe-10--binary-format-for-pg-to-pg-transfers)
    - [Recipe 11 — Use DEFAULT in input data (PG16+)](#recipe-11--use-default-in-input-data-pg16)
    - [Recipe 12 — Monitor running COPY via pg_stat_progress_copy](#recipe-12--monitor-running-copy-via-pg_stat_progress_copy)
    - [Recipe 13 — Tune cluster for bulk ingest window](#recipe-13--tune-cluster-for-bulk-ingest-window)
    - [Recipe 14 — Staging-table + INSERT...SELECT for transform](#recipe-14--staging-table--insertselect-for-transform)
    - [Recipe 15 — Audit who can COPY from server files](#recipe-15--audit-who-can-copy-from-server-files)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Loading > 10k rows. Initial database population. Migrating from another RDBMS. Periodic ETL. Exporting to CSV. Building staging table for transform. Diagnosing slow `INSERT`-loop application.

Do NOT use for: regular OLTP traffic (use prepared `INSERT`), single-row writes (use `INSERT ... RETURNING`), streaming change data capture (use logical replication — see [`74-logical-replication.md`](./74-logical-replication.md)), backups (use `pg_dump` — see [`83-backup-pg-dump.md`](./83-backup-pg-dump.md)).

> [!WARNING] PG18 incompatibility — `\.` no longer EOF in CSV server-side
> Verbatim release note: *"Prevent `COPY FROM` from treating `\.` as an end-of-file marker when reading CSV files (Daniel Vérité, Tom Lane). psql will still treat `\.` as an end-of-file marker when reading CSV files from STDIN. Older psql clients connecting to PostgreSQL 18 servers might experience `\copy` problems. This release also enforces that `\.` must appear alone on a line."* Audit any CSV files containing literal `\.` data values + upgrade psql client to 18+ if hitting server-side `\copy` issues post-upgrade.[^pg18-eof]

## Mental Model

Five rules:

1. **Server-side `COPY` reads/writes files on the server filesystem; client-side `\copy` reads/writes on the client.** Server-side requires superuser OR `pg_read_server_files` / `pg_write_server_files` / `pg_execute_server_program` role membership. Client-side runs through normal psql connection, no special privilege. Verbatim docs[^psql-copy]: *"`\copy` performs a frontend (client) copy. This is an operation that runs an SQL `COPY` command, but instead of the server reading or writing the specified file, psql reads or writes the file and routes the data between the server and the local file system."*

2. **Three formats: `text` (default), `csv`, `binary`.** `text` and `csv` are human-readable + portable. `binary` is fastest + smallest but PG-version-specific + endian-specific. Default delimiter for `text` is tab; for `csv` is comma.

3. **`FREEZE` bypasses later autovacuum-freeze pass but has hard restrictions.** Verbatim docs[^copy-freeze]: *"Rows will be frozen only if the table being loaded has been created or truncated in the current subtransaction, there are no cursors open and there are no older snapshots held by this transaction."* Plus: not on partitioned tables (PG16), not on foreign tables (PG18+).

4. **`COPY` is single-threaded per process.** Parallelism via multiple concurrent `COPY` commands against same table (one per chunk), not via `PARALLEL N` option. Single `COPY FROM` is the slowest part of large bulk loads.

5. **Indexes + foreign keys + triggers fire row-by-row during `COPY`.** Drop them before load, recreate after, when input large enough that index/FK maintenance dominates. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for the autovacuum-tuning side of bulk-load windows.

## Decision Matrix

| Situation | Pattern | Avoid |
|---|---|---|
| Initial table load > 10M rows | `COPY` + drop indexes + drop FKs + raise `maintenance_work_mem` + `FREEZE` if newly-created table | `INSERT` loop, single-threaded ORM batch |
| CSV file on production server, load via DBA SSH | `psql -c "\copy table FROM 'file.csv' CSV HEADER"` | `COPY ... FROM '/server/path'` (requires server-side role) |
| CSV file on app server, load to remote DB | `psql -h db.host -c "\copy ..."` from app side, OR `COPY ... FROM STDIN` piped from app | mounting NFS to give server-side `COPY` access |
| Compressed `.gz`/`.zst` source | `COPY ... FROM PROGRAM 'zstd -dc /path/file.zst'` (needs `pg_execute_server_program`) OR `zcat file.gz \| psql -c "\copy ..."` | uncompress to temp file first (wastes I/O) |
| Recurring nightly ETL | server-side `COPY` from generated file in known location + scheduled via `pg_cron` ([`98-pg-cron.md`](./98-pg-cron.md)) | client-side `\copy` from random dev machine |
| Input has malformed rows | PG17+: `COPY ... WITH (ON_ERROR ignore, LOG_VERBOSITY verbose)`. Pre-PG17: staging table + cleanup SQL | wrap each row in transaction (slow) |
| Cap acceptable error count | PG18+: `WITH (ON_ERROR ignore, REJECT_LIMIT 100)` | application-side counter that aborts mid-load |
| Export filtered subset | `COPY (SELECT ... WHERE ...) TO ...` | dump entire table + grep |
| PG-to-PG migration | `COPY ... FORMAT binary` (with pg_dump-style `--data-only --format=custom` an alternative — see [`83-backup-pg-dump.md`](./83-backup-pg-dump.md)) | text-format CSV roundtrip (loses precision on numeric / float) |
| Need to map default value when input cell empty | PG16+: `WITH (FORMAT csv, DEFAULT '\D')` and use `\D` literal in CSV for cells needing column DEFAULT | application-side default fill |
| Audit progress on long-running COPY | Query `pg_stat_progress_copy` (PG14+) | `EXPLAIN` (doesn't work for COPY) |

Three smell signals — when COPY is the wrong tool:

1. **Many small files arriving continuously** — building application-side queue + COPY each file = streaming. Use logical replication or CDC instead.
2. **Need per-row validation with side effects** — COPY runs triggers per row but exception in one trigger aborts entire COPY. Use staging table + INSERT...SELECT with WHERE-filter.
3. **Need ON CONFLICT DO UPDATE** — COPY has no upsert mode. Staging table + INSERT...SELECT ... ON CONFLICT (see [`03-syntax-dml.md`](./03-syntax-dml.md)).

## Syntax / Mechanics

### Full Grammar

PG16 verbatim synopsis[^copy-docs]:

    COPY table_name [ ( column_name [, ...] ) ]
        FROM { 'filename' | PROGRAM 'command' | STDIN }
        [ [ WITH ] ( option [, ...] ) ]
        [ WHERE condition ]

    COPY { table_name [ ( column_name [, ...] ) ] | ( query ) }
        TO { 'filename' | PROGRAM 'command' | STDOUT }
        [ [ WITH ] ( option [, ...] ) ]

    where option can be one of:

        FORMAT format_name
        FREEZE [ boolean ]
        DELIMITER 'delimiter_character'
        NULL 'null_string'
        DEFAULT 'default_string'
        HEADER [ boolean | MATCH ]
        QUOTE 'quote_character'
        ESCAPE 'escape_character'
        FORCE_QUOTE { ( column_name [, ...] ) | * }
        FORCE_NOT_NULL ( column_name [, ...] )
        FORCE_NULL ( column_name [, ...] )
        ENCODING 'encoding_name'

PG17 adds:

    ON_ERROR error_action          -- stop (default) | ignore
    LOG_VERBOSITY verbosity        -- default | verbose

PG18 adds:

    REJECT_LIMIT maxerror          -- bigint, requires ON_ERROR=ignore
    LOG_VERBOSITY silent           -- third level (default | verbose | silent)
    FORCE_NOT_NULL { ( cols ) | * }
    FORCE_NULL     { ( cols ) | * }

### Server-side `COPY` vs Client-side `\copy`

Server-side `COPY` reads/writes file paths from the server's filesystem perspective. Requires elevated privilege.

Verbatim permission rule[^copy-docs]: *"`COPY` naming a file or command is only allowed to database superusers or users who are granted one of the roles `pg_read_server_files`, `pg_write_server_files`, or `pg_execute_server_program`, since it allows reading or writing any file or running a program that the server has privileges to access."*

Client-side `\copy` (psql meta-command) translates to `COPY ... FROM STDIN` / `COPY ... TO STDOUT` and routes data through the client connection. No server-side filesystem access. Verbatim psql docs[^psql-copy]: *"file accessibility and privileges are those of the local user, not the server, and no SQL superuser privileges are required."*

Performance caveat for `\copy`[^psql-copy]: *"These operations are not as efficient as the SQL `COPY` command with a file or program data source or destination, because all data must pass through the client/server connection. For large amounts of data the SQL command might be preferable."*

| Property | Server-side `COPY 'file'` | Client-side `\copy` |
|---|---|---|
| Privilege | Superuser or `pg_read_server_files` / `pg_write_server_files` | None special |
| File location | Server filesystem | Client filesystem |
| Performance | Fastest (no client-server pipe) | ~10-30% slower (data through connection) |
| Available in managed Postgres | Usually NO (providers strip server-side file role) | YES |
| Command | `psql -c "COPY t FROM '/srv/file.csv' CSV"` | `psql -c "\copy t FROM 'file.csv' CSV"` |
| Parser rule | Normal SQL | Entire line is args; no `$VAR` expansion, no backticks |

> [!NOTE] `\copy` parser rule
> Verbatim[^psql-copy]: *"Unlike most other meta-commands, the entire remainder of the line is always taken to be the arguments of `\copy`, and neither variable interpolation nor backquote expansion are performed in the arguments."* Cannot inline `psql` variables. Use shell `psql -c` and shell substitution instead.

### Format Options

| Option | Default | text | csv | binary |
|---|---|---|---|---|
| `FORMAT` | `text` | OK | OK | OK |
| `DELIMITER` | TAB (text) or `,` (csv) | OK | OK | not applicable |
| `NULL` | `\N` (text), empty (csv) | OK | OK | not applicable |
| `HEADER` | off | PG15+ only | OK | not applicable |
| `QUOTE` | `"` (csv) | not applicable | OK | not applicable |
| `ESCAPE` | same as QUOTE (csv) | not applicable | OK | not applicable |
| `ENCODING` | server encoding | OK | OK | not applicable |

`text` format escapes embedded delimiters/newlines with backslash sequences (`\t`, `\n`, `\\`, `\N` for NULL).

`csv` format quotes per RFC 4180 (with `QUOTE` character escaping itself by doubling).

`binary` format is PG-internal binary representation — fastest, smallest, but:
- Not portable across PG major versions (composite/array internal layout changes)
- Not portable across machine endianness for some types
- No human-readable inspection

### FREEZE

Verbatim docs[^copy-freeze]: *"Requests copying the data with rows already frozen, just as they would be after running the `VACUUM FREEZE` command. This is intended as a performance option for initial data loading. Rows will be frozen only if the table being loaded has been created or truncated in the current subtransaction, there are no cursors open and there are no older snapshots held by this transaction. It is currently not possible to perform a `COPY FREEZE` on a partitioned table."*

Restrictions summary:

| Restriction | Version |
|---|---|
| Table must be CREATEd or TRUNCATEd in same (sub)transaction | always |
| No cursors open in transaction | always |
| No older snapshots in transaction | always |
| Not allowed on partitioned tables | always |
| Not allowed on foreign tables | PG18+ (previously silently no-op) |

Effect: saves the `vacuum_freeze_min_age` work that would otherwise happen later. For 100M-row initial loads this is significant — avoids a future anti-wraparound vacuum.

> [!NOTE] PostgreSQL 14
> Verbatim[^pg14-rel]: *"Have `COPY FREEZE` appropriately update page visibility bits (Anastasia Lubennikova, Pavan Deolasee, Jeff Janes)."* Pre-PG14 a `COPY FREEZE` left visibility-map bits unset, so the next sequential scan or index-only scan still had to consult heap pages.

### ON_ERROR / LOG_VERBOSITY / REJECT_LIMIT (PG17+/PG18+)

> [!NOTE] PostgreSQL 17 — error-tolerant ingest
> Verbatim[^pg17-rel]: *"Add new COPY option `ON_ERROR ignore` to discard error rows (Damir Belyalov, Atsushi Torikoshi, Alex Shulgin, Jian He, Yugo Nagata). The default behavior is `ON_ERROR stop`."* Plus: *"Add new COPY option `LOG_VERBOSITY` which reports COPY FROM ignored error rows (Bharath Rupiredry)."* Plus: *"Allow COPY FROM to report the number of skipped rows during processing (Atsushi Torikoshi). This appears in system view column `pg_stat_progress_copy.tuples_skipped`."*

Verbatim ON_ERROR docs[^copy17]: *"Specifies how to behave when encountering an error converting a column's input value into its data type. An error_action value of `stop` means fail the command, while `ignore` means discard the input row and continue with the next one. The default is `stop`. The `ignore` option is applicable only for COPY FROM when the FORMAT is text or csv."*

Scope of "error" for `ON_ERROR ignore`: **type-conversion errors only**. Constraint violations (CHECK, UNIQUE, FK) still abort the entire COPY. See gotcha #4.

> [!NOTE] PostgreSQL 18 — bounded error tolerance
> Verbatim[^pg18-rel]: *"Add `REJECT_LIMIT` to control the number of invalid rows COPY FROM can ignore (Atsushi Torikoshi). This is available when `ON_ERROR = 'ignore'`."* And: *"Add COPY LOG_VERBOSITY level `silent` to suppress log output of ignored rows (Atsushi Torikoshi). This new level suppresses output for discarded input rows when on_error = 'ignore'."*

Verbatim REJECT_LIMIT docs[^copy18]: *"Specifies the maximum number of errors tolerated while converting a column's input value to its data type, when `ON_ERROR` is set to `ignore`. If the input causes more errors than the specified value, the COPY command fails, even with `ON_ERROR` set to `ignore`. This clause must be used with `ON_ERROR=ignore` and maxerror must be positive bigint. If not specified, `ON_ERROR=ignore` allows an unlimited number of errors, meaning COPY will skip all erroneous data."*

### HEADER MATCH (PG15+)

> [!NOTE] PostgreSQL 15
> Verbatim[^pg15-rel]: *"Add support for HEADER option in COPY text format (Rémi Lapeyre). The new option causes the column names to be output, and optionally verified on input."*

Three header modes:

| Form | Behavior |
|---|---|
| `HEADER` or `HEADER true` | Output column names on COPY TO; skip first line on COPY FROM |
| `HEADER false` | No header (default) |
| `HEADER MATCH` (PG15+, FROM only) | Skip first line AND verify column names match table columns in order |

`HEADER MATCH` catches "I added a column in the middle of the table" mistakes early. Strongly recommended for production ETL.

### Permissions

Three role memberships govern server-side `COPY`:

| Role | Grants |
|---|---|
| `pg_read_server_files` | `COPY FROM 'filename'` |
| `pg_write_server_files` | `COPY TO 'filename'` |
| `pg_execute_server_program` | `COPY FROM PROGRAM 'cmd'` and `COPY TO PROGRAM 'cmd'` |

Plus the requesting role needs INSERT/SELECT/UPDATE on the target table per normal grant rules. See [`46-roles-privileges.md`](./46-roles-privileges.md).

Managed-environment caveat: most managed Postgres services strip these role-memberships from app roles AND prevent granting them. Server-side `COPY ... FROM 'file'` rarely available. Use client-side `\copy` or `COPY FROM STDIN` piped from application. See [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md).

### Per-Version Timeline

| Version | COPY changes |
|---|---|
| **PG14** | `COPY FREEZE` properly updates visibility map bits[^pg14-rel]; `pg_stat_progress_copy` view added[^pg14-rel]; `COPY FROM` binary-mode performance improvement[^pg14-rel] |
| **PG15** | `HEADER` option works on text format (not just CSV)[^pg15-rel]; `HEADER MATCH` for column-name verification[^pg15-rel]; psql `\copy` chunk-size optimization[^pg15-rel] |
| **PG16** | `COPY FROM` value can map to column DEFAULT via `DEFAULT 'string'` option[^pg16-rel]; COPY into foreign tables batches inserts[^pg16-rel] |
| **PG17** | `ON_ERROR ignore`/`stop`[^pg17-rel]; `LOG_VERBOSITY default`/`verbose`[^pg17-rel]; `pg_stat_progress_copy.tuples_skipped`[^pg17-rel] |
| **PG18** | `REJECT_LIMIT`[^pg18-rel]; `LOG_VERBOSITY silent`[^pg18-rel]; `FORCE_NOT_NULL *` / `FORCE_NULL *`[^pg18-rel]; `COPY TO` from populated matview[^pg18-rel]; `COPY FREEZE` on foreign tables now errors instead of silently no-op[^pg18-rel]; **incompatibility**: `\.` no longer EOF for CSV server-side[^pg18-eof] |

## Examples / Recipes

### Recipe 1 — Baseline bulk load (CSV from file)

Most common pattern. Client-side `\copy` is the safe default.

    -- on the machine that has the file
    psql -h db.example.com -d appdb -c "\copy events FROM 'events.csv' (FORMAT csv, HEADER MATCH)"

Server-side equivalent (faster, needs role):

    GRANT pg_read_server_files TO loader_role;

    -- run as loader_role
    COPY events FROM '/srv/data/events.csv' (FORMAT csv, HEADER MATCH);

`HEADER MATCH` is the upgrade from `HEADER` — verifies column-name order, catches schema-drift bugs at load time.

### Recipe 2 — Client-side `\copy` from a remote machine

App server has the file, DB is remote, app machine has no special server-side privilege.

    # on app server
    psql "postgresql://loader@db.example.com/appdb?sslmode=verify-full" \
      -c "\copy events FROM 'events.csv' (FORMAT csv, HEADER MATCH)"

Data streams over the wire on the open psql connection. Slower than server-side by ~10-30% (network is the bottleneck), but no server-side filesystem coupling.

### Recipe 3 — COPY FREEZE on new table

`FREEZE` requires same-(sub)transaction CREATE or TRUNCATE. Wrap in `BEGIN`.

    BEGIN;
    CREATE TABLE events_2026_05 (
        id          bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        payload     jsonb NOT NULL
    );
    COPY events_2026_05 (occurred_at, payload)
        FROM '/srv/data/events_202605.csv'
        (FORMAT csv, HEADER MATCH, FREEZE);
    COMMIT;

Verify tuples actually got frozen:

    SELECT relname,
           n_live_tup,
           (pg_stat_get_xact_tuples_inserted(oid)) AS this_xact_inserts
    FROM pg_stat_user_tables
    JOIN pg_class ON pg_class.oid = relid
    WHERE relname = 'events_2026_05';

For partitioned target, FREEZE not allowed. Load into a leaf partition created/truncated in same transaction, then ATTACH to parent. See [`35-partitioning.md`](./35-partitioning.md).

### Recipe 4 — Drop indexes + FKs before load, recreate after

Index/FK maintenance dominates load time at scale. Standard pattern:

    BEGIN;

    -- 1. drop non-PK indexes
    DROP INDEX idx_events_occurred_at;
    DROP INDEX idx_events_user_id;

    -- 2. drop FKs (or DEFER them if SET CONSTRAINTS is feasible)
    ALTER TABLE events DROP CONSTRAINT events_user_id_fkey;

    -- 3. raise maintenance_work_mem for the rebuild
    SET LOCAL maintenance_work_mem = '2GB';

    -- 4. load
    COPY events FROM '/srv/data/events.csv' (FORMAT csv, HEADER MATCH);

    -- 5. recreate
    CREATE INDEX CONCURRENTLY idx_events_occurred_at ON events (occurred_at);
    CREATE INDEX CONCURRENTLY idx_events_user_id     ON events (user_id);
    ALTER TABLE events ADD CONSTRAINT events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
    ALTER TABLE events VALIDATE CONSTRAINT events_user_id_fkey;

    COMMIT;

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction — break into separate transactions if using CONCURRENTLY. See [`26-index-maintenance.md`](./26-index-maintenance.md). Use `NOT VALID` + `VALIDATE CONSTRAINT` to defer the FK scan and keep the second-phase outside the load window. See [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md).

### Recipe 5 — Parallel multi-process COPY

Single `COPY` is single-threaded. Throughput-bound? Split input into N chunks, run N concurrent `COPY` sessions:

    # split CSV into 8 chunks
    split -n l/8 events.csv events_part_

    # run 8 concurrent psql sessions, each loading one chunk
    for f in events_part_*; do
        psql -d appdb -c "\copy events FROM '$f' (FORMAT csv)" &
    done
    wait

Constraints:
- All processes write to same heap, so commit-latency contention is real but usually negligible
- If table has indexes, index B-tree page-split contention can hurt — drop indexes first per Recipe 4
- If chunks share PK values, you'll hit unique-violation conflicts. Pre-dedup or use staging-table + INSERT ON CONFLICT pattern (Recipe 14)

### Recipe 6 — Error-tolerant ingest (PG17+)

Some rows in input have malformed values (NULL where NOT NULL, bad date string, etc.). Skip those rows + log them, instead of aborting whole load.

    COPY events FROM '/srv/data/dirty.csv'
        (FORMAT csv, HEADER MATCH, ON_ERROR ignore, LOG_VERBOSITY verbose);

Server log will emit one line per skipped row showing the offending input. `pg_stat_progress_copy.tuples_skipped` shows running count.

> [!WARNING] `ON_ERROR ignore` is type-conversion only
> Verbatim docs[^copy17]: *"applicable only for COPY FROM when the FORMAT is text or csv."* AND: scope is *"errors converting a column's input value into its data type."* Constraint violations (CHECK, UNIQUE, FK, NOT NULL) still abort the entire COPY. To skip constraint violations, use staging-table + INSERT...SELECT (Recipe 14).

### Recipe 7 — Limit accepted error count (PG18+)

Tolerate up to N errors, fail if more — sanity check for "input is mostly fine but might have a few duds":

    COPY events FROM '/srv/data/possibly_dirty.csv'
        (FORMAT csv, HEADER MATCH,
         ON_ERROR ignore,
         REJECT_LIMIT 100,
         LOG_VERBOSITY verbose);

If 101st row fails type conversion, entire COPY aborts. Useful when "a few bad rows" is acceptable but "thousands of bad rows" means the file is wrong.

Use `LOG_VERBOSITY silent` if errors expected and log noise is unwanted (e.g., a CSV deliberately containing some malformed sentinel rows you want skipped).

### Recipe 8 — Stream COPY through pipe / PROGRAM

Compressed input — never write the decompressed file to disk.

Client-side from shell pipe:

    zcat events.csv.gz | psql -c "\copy events FROM STDIN (FORMAT csv, HEADER MATCH)"

Server-side via PROGRAM (needs `pg_execute_server_program`):

    GRANT pg_execute_server_program TO loader_role;

    -- as loader_role
    COPY events FROM PROGRAM 'zstd -dc /srv/archive/events.zst'
        (FORMAT csv, HEADER MATCH);

`PROGRAM` invokes a subprocess with the server's privileges. WARNING: any program the server's OS user can run, the COPY can run — review the role grant accordingly. See [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #15.

### Recipe 9 — COPY (query) TO — export filtered subset

Export not a whole table but a query result.

    COPY (
        SELECT id, occurred_at, payload->>'event_type' AS evt
        FROM events
        WHERE occurred_at >= '2026-05-01'
          AND occurred_at <  '2026-06-01'
    ) TO '/srv/export/events_202605.csv'
    WITH (FORMAT csv, HEADER, FORCE_QUOTE *);

`FORCE_QUOTE *` quotes every CSV field — safer for downstream parsers that mishandle unquoted numerics with thousand-separators or that get confused by embedded commas.

### Recipe 10 — Binary format for PG-to-PG transfers

Source cluster → destination cluster, same PG major version, same arch:

    -- on source
    COPY events TO '/tmp/events.bin' (FORMAT binary);

    -- on destination, same PG major
    COPY events FROM '/tmp/events.bin' (FORMAT binary);

Faster than CSV by ~2-5× for wide tables. NULL handling is unambiguous. NUMERIC precision exact. Composite/array types serialize losslessly.

> [!WARNING] binary format is version-fragile
> Internal type representations occasionally change across PG majors (composite tuple headers, multirange encoding). Test before bulk binary-roundtrip between PG14 → PG18. For cross-version PG-to-PG migration, prefer `pg_dump --format=custom` (see [`83-backup-pg-dump.md`](./83-backup-pg-dump.md)) or logical replication ([`74-logical-replication.md`](./74-logical-replication.md)).

### Recipe 11 — Use DEFAULT in input data (PG16+)

> [!NOTE] PostgreSQL 16
> Verbatim[^pg16-rel]: *"Allow a COPY FROM value to map to a column's DEFAULT (Israel Barth Rubio)."*

Designate a sentinel string that means "use column DEFAULT":

    CREATE TABLE orders (
        id          bigserial PRIMARY KEY,
        created_at  timestamptz NOT NULL DEFAULT now(),
        status      text NOT NULL DEFAULT 'pending',
        total       numeric(12, 2) NOT NULL
    );

    -- input file rows where status column is `\D` get the DEFAULT 'pending'
    -- input rows where created_at is `\D` get now() at load time

    COPY orders (created_at, status, total)
        FROM '/srv/import/orders.csv'
        (FORMAT csv, HEADER MATCH, DEFAULT '\D');

Cleaner than two-pass loads where you first load NULLs then UPDATE with defaults.

### Recipe 12 — Monitor running COPY via pg_stat_progress_copy

`pg_stat_progress_copy` (PG14+) gives live progress.

    SELECT
        c.pid,
        a.usename,
        c.datname,
        c.command,
        c.type,
        pg_size_pretty(c.bytes_processed)    AS processed,
        pg_size_pretty(c.bytes_total)        AS total,
        c.tuples_processed,
        c.tuples_excluded,
        c.tuples_skipped                     -- PG17+ when ON_ERROR=ignore
    FROM pg_stat_progress_copy c
    JOIN pg_stat_activity a USING (pid);

Columns:
- `command` — `COPY FROM` / `COPY TO`
- `type` — `FILE` / `PROGRAM` / `PIPE` / `CALLBACK`
- `bytes_processed` — running byte count
- `bytes_total` — file size if known (0 for STDIN/PROGRAM)
- `tuples_processed` — running row count
- `tuples_excluded` — rows excluded by `WHERE` clause
- `tuples_skipped` — PG17+, rows skipped due to `ON_ERROR ignore`

See [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) for the full `pg_stat_progress_*` view family.

### Recipe 13 — Tune cluster for bulk ingest window

For multi-hour bulk-load events on a quiet cluster, temporarily relax durability and raise maintenance memory:

    -- session-level for one load
    SET LOCAL synchronous_commit = off;
    SET LOCAL maintenance_work_mem = '4GB';
    SET LOCAL work_mem = '256MB';
    SET LOCAL max_parallel_maintenance_workers = 8;

    -- now run the load
    COPY ...

Cluster-level for a planned ingest window:

    ALTER SYSTEM SET checkpoint_timeout    = '30min';   -- was 5min default
    ALTER SYSTEM SET max_wal_size          = '64GB';    -- was 1GB default
    ALTER SYSTEM SET maintenance_work_mem  = '4GB';
    SELECT pg_reload_conf();

Reset after the window. See [`33-wal.md`](./33-wal.md), [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md), and [`54-memory-tuning.md`](./54-memory-tuning.md).

> [!WARNING] `synchronous_commit = off` is data loss tolerance
> Trades up to `wal_writer_delay × 3` (default ~600ms) of committed-but-unflushed transactions for ~20-40% write throughput. Acceptable for re-runnable bulk loads. NOT acceptable for OLTP traffic. See [`33-wal.md`](./33-wal.md) gotcha #8.

### Recipe 14 — Staging-table + INSERT...SELECT for transform

When source data needs cleanup, deduplication, type coercion, conflict handling, or UPSERT semantics that COPY itself cannot do:

    -- 1. unlogged staging table for speed
    CREATE UNLOGGED TABLE events_staging (
        raw_data text  -- or whatever shape matches input
    );

    -- 2. fast bulk-load into staging
    COPY events_staging FROM '/srv/import/raw.csv' (FORMAT csv);

    -- 3. transform + insert with conflict resolution
    INSERT INTO events (occurred_at, user_id, event_type, payload)
    SELECT
        (raw_data::jsonb ->> 'ts')::timestamptz,
        (raw_data::jsonb ->> 'uid')::bigint,
        raw_data::jsonb ->> 'evt',
        raw_data::jsonb -> 'payload'
    FROM events_staging
    WHERE raw_data::jsonb ? 'ts'   -- skip rows missing required field
    ON CONFLICT (occurred_at, user_id) DO UPDATE
        SET payload = EXCLUDED.payload;

    -- 4. cleanup
    DROP TABLE events_staging;

`UNLOGGED` skips WAL writes for the staging table — see [`14-data-types-builtin.md`](./14-data-types-builtin.md) and [`33-wal.md`](./33-wal.md). Crash-unsafe BUT staging is throwaway anyway.

### Recipe 15 — Audit who can COPY from server files

Catalog query — which roles have membership in the three server-file roles, and which extension owners can elevate?

    -- direct grants of the server-side COPY roles
    SELECT
        m.rolname                 AS member,
        r.rolname                 AS granted_role,
        am.rolname                AS admin_option_granted_by
    FROM pg_auth_members  am_rel
    JOIN pg_authid        m  ON m.oid  = am_rel.member
    JOIN pg_authid        r  ON r.oid  = am_rel.roleid
    LEFT JOIN pg_authid   am ON am.oid = am_rel.grantor
    WHERE r.rolname IN ('pg_read_server_files',
                        'pg_write_server_files',
                        'pg_execute_server_program')
    ORDER BY r.rolname, m.rolname;

Cross-reference with role attributes (superusers bypass these checks):

    SELECT rolname, rolsuper, rolcreaterole
    FROM pg_roles
    WHERE rolsuper OR rolname IN (
        SELECT m.rolname
        FROM pg_auth_members am
        JOIN pg_authid m ON m.oid = am.member
        JOIN pg_authid r ON r.oid = am.roleid
        WHERE r.rolname IN ('pg_read_server_files',
                            'pg_write_server_files',
                            'pg_execute_server_program')
    )
    ORDER BY rolsuper DESC, rolname;

Run this before any security-review milestone. Membership in `pg_execute_server_program` is the most security-sensitive — it grants the ability to run any program the server's OS user can run. See [`46-roles-privileges.md`](./46-roles-privileges.md) and [`51-pgaudit.md`](./51-pgaudit.md) for audit-trail integration.

## Gotchas / Anti-patterns

1. **Server-side `COPY 'filename'` requires `pg_read_server_files` or superuser.** Most managed services strip this. Default fallback is client-side `\copy`. Documented permission rule verbatim[^copy-docs].
2. **`COPY ... PROGRAM` requires `pg_execute_server_program` — separate role.** Not granted by `pg_read_server_files`. Audit grants carefully — gives any-command execution as server OS user.
3. **`COPY FREEZE` silently no-ops if restrictions violated pre-PG18.** PG18 disallows on foreign tables outright with explicit error — verbatim[^pg18-rel]. Pre-PG18: if table existed before the transaction OR a cursor is open, FREEZE silently does nothing.
4. **`ON_ERROR ignore` skips type-conversion errors only.** UNIQUE / FK / CHECK / NOT NULL violations still abort. Use staging table for those.
5. **`COPY FROM` runs triggers per row.** A BEFORE INSERT trigger that does a single SELECT per row = N round trips. Drop or DISABLE triggers during bulk load if possible. See [`39-triggers.md`](./39-triggers.md).
6. **`HEADER` without `MATCH` does not validate column names.** Just skips the first line. Mismatch silently maps by column position. Always use `HEADER MATCH` for production ETL (PG15+).
7. **`FORCE_NOT_NULL` and `FORCE_NULL` are CSV-only.** Have no effect on text/binary format.
8. **Pre-PG15 `HEADER` was CSV-only.** PG15 added `HEADER` for text format too[^pg15-rel].
9. **`COPY (query) TO` runs the query in a single transaction snapshot.** Long-running export holds an xmin horizon — blocks vacuum-cleanup of dead tuples. See [`27-mvcc-internals.md`](./27-mvcc-internals.md) and [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).
10. **`COPY` into a partitioned table routes per row.** Before PG12 was problematic; PG12+ handles natively but per-partition trigger overhead applies. Drop indexes on leaf partitions for speed.
11. **`binary` format is PG-version-specific.** Test before binary roundtrip between major versions. Composite/multirange/array internal encoding can change.
12. **`binary` format is endian-specific for some types.** Cross-arch (x86 → arm64) binary transfer requires extra care. Stick to CSV for portable transfers.
13. **`COPY` does not honor `BEFORE STATEMENT` triggers running before each row.** Triggers fire `BEFORE ROW` per row — slow on million-row loads.
14. **`COPY FROM STDIN` blocks if the application sends data slowly.** A trickling input holds a transaction open. Combine with `idle_in_transaction_session_timeout` to bound the risk — see [`41-transactions.md`](./41-transactions.md).
15. **`UNLOGGED` tables are truncated on crash.** Great for staging tables but never for tables holding important data. Verbatim docs warning in CREATE TABLE.
16. **`maintenance_work_mem` matters for index rebuild after load, not for COPY itself.** COPY's own memory is `work_mem`-bounded for sort/hash side operations only. See [`54-memory-tuning.md`](./54-memory-tuning.md).
17. **PG18 `\.` no longer EOF in CSV server-side `COPY FROM`.** Verbatim incompatibility[^pg18-eof]. Older psql clients connecting to PG18 servers may experience `\copy` problems — upgrade client to 18+. Audit any CSV data files containing literal `\.` rows that could now be loaded instead of treated as EOF.
18. **`COPY` does not return `RETURNING`.** If you need IDs of inserted rows, use staging table + INSERT...SELECT...RETURNING. See [`03-syntax-dml.md`](./03-syntax-dml.md).
19. **`pg_stat_progress_copy.tuples_skipped` is PG17+.** Pre-PG17 there's no way to know how many rows `ON_ERROR ignore` skipped because `ON_ERROR` itself is PG17+.
20. **`COPY FROM PROGRAM` cannot stream from another database.** Use `pg_dump | psql` shell pipe, or postgres_fdw + INSERT...SELECT. See [`70-fdw.md`](./70-fdw.md).
21. **Each row in `COPY ... ON CONFLICT` is not supported — there is no `ON CONFLICT` clause on COPY.** Staging table + INSERT...SELECT ... ON CONFLICT is the only path (Recipe 14).
22. **`COPY ... WITH (FREEZE)` does not interact correctly with logical replication subscribers.** Frozen rows still replicate, but the subscriber doesn't get them frozen on its side. See [`74-logical-replication.md`](./74-logical-replication.md).
23. **`COPY FROM` cannot populate generated columns.** Generated stored columns are computed by the server on insert; the input file must omit them (or include and you'll get error `cannot insert a non-DEFAULT value into column "x"`).
24. **`COPY ... FROM '/dev/stdin'` is not the same as `COPY ... FROM STDIN`.** `'/dev/stdin'` is a server-side filename (and the server has no useful stdin). `STDIN` is the protocol-level streaming form invoked by `\copy`.
25. **`REJECT_LIMIT` must be `bigint` and positive.** Verbatim docs[^copy18]: *"This clause must be used with `ON_ERROR=ignore` and maxerror must be positive bigint."* `REJECT_LIMIT 0` is not a no-op — it's an error. Use `ON_ERROR stop` (the default) if you want zero errors tolerated.

## See Also

- [`03-syntax-dml.md`](./03-syntax-dml.md) — INSERT, ON CONFLICT, RETURNING (the row-level alternative)
- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — type-conversion rules relevant to COPY input processing (Recipe 14)
- [`26-index-maintenance.md`](./26-index-maintenance.md) — CREATE INDEX CONCURRENTLY for post-load index rebuild
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM and autovacuum tuning around bulk load windows
- [`33-wal.md`](./33-wal.md) — `wal_level=minimal`, `synchronous_commit=off`, `max_wal_size`
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint tuning for write-heavy loads
- [`38-foreign-keys-deep.md`](./38-foreign-keys-deep.md) — NOT VALID + VALIDATE pattern for post-load FK creation
- [`39-triggers.md`](./39-triggers.md) — DISABLE TRIGGER USER for bulk loads
- [`46-roles-privileges.md`](./46-roles-privileges.md) — pg_read_server_files, pg_write_server_files, pg_execute_server_program
- [`54-memory-tuning.md`](./54-memory-tuning.md) — maintenance_work_mem for index rebuild
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — pg_stat_progress_copy live monitoring
- [`67-cli-tools.md`](./67-cli-tools.md) — psql `\copy` meta-command details
- [`68-pgbench.md`](./68-pgbench.md) — initial load uses COPY internally
- [`70-fdw.md`](./70-fdw.md) — PG-to-PG transfer alternative via postgres_fdw
- [`74-logical-replication.md`](./74-logical-replication.md) — initial-sync uses COPY internally
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — pg_dump custom format uses COPY internally
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling recurring COPY-based ETL
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — server-side `COPY` rarely allowed on managed services

## Sources

[^copy-docs]: PostgreSQL 16 docs, `COPY` command reference. https://www.postgresql.org/docs/16/sql-copy.html — verbatim grammar synopsis + permissions rule: *"COPY naming a file or command is only allowed to database superusers or users who are granted one of the roles pg_read_server_files, pg_write_server_files, or pg_execute_server_program, since it allows reading or writing any file or running a program that the server has privileges to access."*

[^copy-freeze]: PostgreSQL 16 docs, `COPY` FREEZE option. https://www.postgresql.org/docs/16/sql-copy.html — verbatim: *"Requests copying the data with rows already frozen, just as they would be after running the VACUUM FREEZE command. This is intended as a performance option for initial data loading. Rows will be frozen only if the table being loaded has been created or truncated in the current subtransaction, there are no cursors open and there are no older snapshots held by this transaction. It is currently not possible to perform a COPY FREEZE on a partitioned table."*

[^copy17]: PostgreSQL 17 docs, `COPY` ON_ERROR and LOG_VERBOSITY options. https://www.postgresql.org/docs/17/sql-copy.html — verbatim ON_ERROR: *"Specifies how to behave when encountering an error converting a column's input value into its data type. An error_action value of stop means fail the command, while ignore means discard the input row and continue with the next one. The default is stop. The ignore option is applicable only for COPY FROM when the FORMAT is text or csv."*

[^copy18]: PostgreSQL 18 docs, `COPY` REJECT_LIMIT and LOG_VERBOSITY silent. https://www.postgresql.org/docs/18/sql-copy.html — verbatim REJECT_LIMIT: *"Specifies the maximum number of errors tolerated while converting a column's input value to its data type, when ON_ERROR is set to ignore. If the input causes more errors than the specified value, the COPY command fails, even with ON_ERROR set to ignore. This clause must be used with ON_ERROR=ignore and maxerror must be positive bigint. If not specified, ON_ERROR=ignore allows an unlimited number of errors, meaning COPY will skip all erroneous data."*

[^psql-copy]: PostgreSQL 16 docs, psql `\copy` meta-command. https://www.postgresql.org/docs/16/app-psql.html — verbatim: *"Performs a frontend (client) copy. This is an operation that runs an SQL COPY command, but instead of the server reading or writing the specified file, psql reads or writes the file and routes the data between the server and the local file system. This means that file accessibility and privileges are those of the local user, not the server, and no SQL superuser privileges are required."* Plus performance caveat: *"These operations are not as efficient as the SQL COPY command with a file or program data source or destination, because all data must pass through the client/server connection."* Plus parser rule: *"Unlike most other meta-commands, the entire remainder of the line is always taken to be the arguments of \\copy, and neither variable interpolation nor backquote expansion are performed in the arguments."*

[^pg14-rel]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/14/release-14.html — verbatim COPY-related items: *"Have COPY FREEZE appropriately update page visibility bits (Anastasia Lubennikova, Pavan Deolasee, Jeff Janes)."* AND: *"Add system view pg_stat_progress_copy to report COPY progress (Josef Šimánek, Matthias van de Meent)."* AND: *"Improve the performance of COPY FROM in binary mode (Bharath Rupireddy, Amit Langote)."*

[^pg15-rel]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/15/release-15.html — verbatim HEADER addition: *"Add support for HEADER option in COPY text format (Rémi Lapeyre). The new option causes the column names to be output, and optionally verified on input."* Plus psql speedup: *"Improve performance of psql's \\copy command, by sending data in larger chunks (Heikki Linnakangas)."*

[^pg16-rel]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/16/release-16.html — verbatim DEFAULT support: *"Allow a COPY FROM value to map to a column's DEFAULT (Israel Barth Rubio)."* Plus: *"Allow COPY into foreign tables to add rows in batches (Andrey Lepikhov, Etsuro Fujita)."*

[^pg17-rel]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/17/release-17.html — verbatim ON_ERROR addition: *"Add new COPY option ON_ERROR ignore to discard error rows (Damir Belyalov, Atsushi Torikoshi, Alex Shulgin, Jian He, Yugo Nagata). The default behavior is ON_ERROR stop."* Plus LOG_VERBOSITY: *"Add new COPY option LOG_VERBOSITY which reports COPY FROM ignored error rows (Bharath Rupiredry)."* Plus tuples_skipped column: *"Allow COPY FROM to report the number of skipped rows during processing (Atsushi Torikoshi). This appears in system view column pg_stat_progress_copy.tuples_skipped."* Plus FORCE_NOT_NULL/FORCE_NULL broaden: *"In COPY FROM, allow easy specification that all columns should be forced null or not null (Zhang Mingli)."*

[^pg18-rel]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/18/release-18.html — verbatim REJECT_LIMIT: *"Add REJECT_LIMIT to control the number of invalid rows COPY FROM can ignore (Atsushi Torikoshi). This is available when ON_ERROR = 'ignore'."* Plus silent verbosity: *"Add COPY LOG_VERBOSITY level silent to suppress log output of ignored rows (Atsushi Torikoshi). This new level suppresses output for discarded input rows when on_error = 'ignore'."* Plus COPY TO matview: *"Allow COPY TO to copy rows from populated materialized views (Jian He)."* Plus FREEZE foreign table: *"Disallow COPY FREEZE on foreign tables (Nathan Bossart). Previously, the COPY worked but the FREEZE was ignored, so disallow this command."*

[^pg18-eof]: PostgreSQL 18 release notes, incompatibility. https://www.postgresql.org/docs/18/release-18.html — verbatim: *"Prevent COPY FROM from treating \\. as an end-of-file marker when reading CSV files (Daniel Vérité, Tom Lane). psql will still treat \\. as an end-of-file marker when reading CSV files from STDIN. Older psql clients connecting to PostgreSQL 18 servers might experience \\copy problems. This release also enforces that \\. must appear alone on a line."*

[^populate]: PostgreSQL 16 docs, populating a database. https://www.postgresql.org/docs/16/populate.html — section 14.4 covers bulk-load recommendations: use COPY (verbatim *"Use COPY to load all the rows in one command, instead of using a series of INSERT commands. The COPY command is optimized for loading large numbers of rows; it is less flexible than INSERT, but incurs significantly less overhead for large data loads."*), remove indexes, remove foreign keys, increase maintenance_work_mem and max_wal_size, disable WAL archival/streaming for non-critical loads, run ANALYZE afterwards.

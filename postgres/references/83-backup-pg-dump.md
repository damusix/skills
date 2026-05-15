# pg_dump / pg_dumpall / pg_restore — Logical Backup

> [!WARNING] **`pg_dump` is per-database. `pg_dumpall` is cluster-wide globals + data.**
> `pg_dump mydb` dumps **one database** (no roles, no tablespaces, no ALTER ROLE SET). Cluster restore needs `pg_dumpall --globals-only` for roles/tablespaces/grants + per-database `pg_dump` for data. **Materialized view data is NOT dumped** — only the schema. Restored matviews are empty + `relispopulated = false`. Must `REFRESH MATERIALIZED VIEW` after restore.[^pgdump]

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Format Options](#format-options)
    - [Section Splits](#section-splits)
    - [Selective Dump and Restore](#selective-dump-and-restore)
    - [Parallel Dump and Restore](#parallel-dump-and-restore)
    - [Compression](#compression)
    - [Permissions](#permissions)
    - [Locking](#locking)
    - [pg_dumpall](#pg_dumpall)
    - [pg_restore](#pg_restore)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use when:

- Designing logical backup procedure (cross-version, cross-architecture, cross-cluster portability)
- Migrating single database between PG majors
- Restoring subset of objects (one schema / one table / one extension)
- Need backup that survives `pg_upgrade` failure
- Generating SQL-text representation of schema for diff / audit / version-control
- PITR not in scope (use `84-backup-physical-pitr.md` + WAL archiving for byte-level + point-in-time)

**Not** for: PITR, cross-byte-identical replication, very large clusters where dump duration exceeds RTO budget. Use physical base backup (`pg_basebackup`) + WAL archiving instead — see `84-backup-physical-pitr.md` and `85-backup-tools.md`.

## Mental Model

Five rules:

1. **`pg_dump` is logical — recreates objects via SQL, not bytes.** Cross-version portable (dump from PG14, restore to PG17). Cross-architecture portable (x86 → ARM). Slower restore than physical. **Schema-only or data-only modes available** via `--schema-only` / `--data-only`. Schema-only dumps describe object DDL; data-only dumps `COPY` statements.[^pgdump]
2. **Custom (`-Fc`) and directory (`-Fd`) formats are the production defaults.** Plain (`-Fp`) = single SQL stream, can't `pg_restore` selectively. Tar (`-Ft`) = no compression. **Directory is the ONLY format that supports parallel dump (`-j N`).** Both custom and directory support parallel restore via `pg_restore -j`.[^pgdump]
3. **Section split: `pre-data` → `data` → `post-data`.** Pre-data = table DDL + types + functions (no indexes, no FKs, no triggers). Data = `COPY` statements + sequence values + large-object contents. Post-data = indexes + FKs + triggers + constraints + rules. **Enables schema-first / data-second / index-last restore pattern** — pre-data first, then parallel data load, then post-data builds indexes faster than incremental insert.[^pgdump]
4. **PG17+ `--filter` accepts an include/exclude file** (one rule per line: `include table public.users`, `exclude table_data public.audit`). PG17+ also adds `--exclude-extension`, `pg_restore --transaction-size`, and `--sync-method` for fsync control. **PG17+ batches large-object restore in parallel** — restoring millions of large objects no longer requires a single huge transaction.[^pg17]
5. **PG18+ `--statistics` preserves optimizer statistics in dumps.** Default behavior remains "don't dump stats." Add `--statistics` to include them. **`--no-policies` (PG18+) disables RLS-policy emission** — useful when restoring into a cluster with different policy schema. Plus `--no-data`, `--no-schema`, `--statistics-only`, `--sequence-data` for fine-grained control.[^pg18]

## Decision Matrix

| Need | Use | Avoid | Why |
| --- | --- | --- | --- |
| Production single-database backup | `pg_dump -Fd -j 4 dbname` | `-Fp` (plain) | Directory format → parallel + selective restore |
| Migrate database across PG major versions | `pg_dump -Fc \| pg_restore` | Physical base backup | Logical = cross-version portable |
| Restore one table from full backup | `pg_restore -t users dump.custom` | Dumping every table separately | Custom/directory archives index objects internally |
| Restore one schema only | `pg_restore -n analytics dump.custom` | `-Fp` | Plain format not selective-restore-able |
| Schema diff / version control | `pg_dump --schema-only --no-owner` | `pg_dump --data-only` | Schema-only is text + diffable |
| Cluster-wide backup (roles + tablespaces + all DBs) | `pg_dumpall` | `pg_dump` per database loop alone | `pg_dump` doesn't capture globals |
| Roles + tablespaces ONLY (no DB data) | `pg_dumpall --globals-only` | `pg_dumpall` (whole cluster) | `--globals-only` skips databases |
| Skip RLS policies during migration | `pg_dump --no-policies` (PG18+) | Hand-editing dump file | PG18 adds policy-emission control |
| Preserve planner statistics across dump | `pg_dump --statistics` (PG18+) | Run `vacuumdb --analyze-in-stages` post-restore | PG18 stats survive dump-restore |
| Limit dump rows by extension | `--extension ext_name` (PG14+) | Hand-curating object list | Extension scoping built-in |
| Include/exclude objects via file | `--filter spec.txt` (PG17+) | Repeating `-t`/`-T` flags | `--filter` scales to many rules |

**Smell signals:**

- Plain-text dump on production database → cannot restore selectively, no parallel restore
- `pg_dump` runs for hours on TB-scale DB → switch to physical base backup + WAL archiving
- Restore says "ERROR: relation already exists" → forgot `--clean` or restoring on top of existing schema

## Syntax / Mechanics

### Format Options

`pg_dump -F {p|c|d|t}` chooses output format. Default: `p` (plain text SQL).

| Format | Flag | File layout | Parallel dump? | Parallel restore? | Selective restore? | Compression? |
| --- | --- | --- | --- | --- | --- | --- |
| Plain | `-Fp` (default) | Single SQL text file | No | No (must `psql`-pipe) | No | External (e.g., `\| gzip`) |
| Custom | `-Fc` | Single binary archive | No | Yes (`-j N`) | Yes | Built-in (gzip/lz4/zstd) |
| Directory | `-Fd` | Directory with per-table files | Yes (`-j N`) | Yes (`-j N`) | Yes | Built-in (gzip/lz4/zstd) |
| Tar | `-Ft` | TAR archive | No | Yes (`-j N`) | Yes | None |

**Production default: `-Fd` for big DBs (parallel dump + parallel restore), `-Fc` for medium DBs (single file is operationally simpler).**[^pgdump]

### Section Splits

`--section={pre-data|data|post-data}` filters output. Combine to split workload across machines or time windows.

Verbatim from PG16 docs[^pgdump]:

- **pre-data** — "all data definition items except those that should be restored after the data is restored"
- **data** — "actual table data, large-object contents, and sequence values"
- **post-data** — "definitions of indexes, triggers, rules and constraints other than validated check constraints"

Canonical restore pattern:

    pg_restore --section=pre-data -d target dump.custom
    pg_restore --section=data --jobs=8 -d target dump.custom
    pg_restore --section=post-data --jobs=8 -d target dump.custom

Data loads faster because no indexes / FKs / triggers fire. Post-data builds indexes once from final data — faster than per-row insert into existing index.

### Selective Dump and Restore

Object scope flags (compose; OR-combined within same type, AND-combined across types):

| Flag | Effect | Example |
| --- | --- | --- |
| `-t pattern`, `--table=pattern` | Include table(s) matching pattern | `-t 'public.users'`, `-t 'sales.*'` |
| `-T pattern`, `--exclude-table=pattern` | Exclude table(s) matching pattern | `-T 'temp.*'` |
| `-n pattern`, `--schema=pattern` | Include schema(s) | `-n 'analytics'` |
| `-N pattern`, `--exclude-schema=pattern` | Exclude schema(s) | `-N 'pg_temp_*'` |
| `--exclude-table-data=pattern` | Schema YES, data NO | Big audit logs |
| `--table-and-children=pattern` (PG16+) | Include parent + all partitions/children | `--table-and-children='sales.events'`[^pg16] |
| `--exclude-table-and-children` (PG16+) | Exclude parent + all partitions/children | Skip whole partitioned hierarchy[^pg16] |
| `--extension=pattern` (PG14+) | Limit to objects in named extension | `--extension=postgis`[^pg14] |
| `--exclude-extension=pattern` (PG17+) | Skip extension contents | `--exclude-extension=timescaledb`[^pg17] |
| `--filter=spec_file` (PG17+) | Read include/exclude rules from file | One rule per line[^pg17] |

`--filter` spec file format (PG17+):

    include table public.users
    include table public.orders
    exclude table_data public.audit_log
    include schema analytics
    exclude extension postgis

Same selection works for `pg_restore`. **`pg_dump` runs the query against the live database; `pg_restore` filters from the dump archive.** Selective restore is faster than re-dumping.

### Parallel Dump and Restore

**Directory format only** supports parallel dump:

    pg_dump -Fd -j 8 -f /backup/dir dbname

`-j N` = N concurrent workers, one per table. Bottleneck on slow tables (largest single table). Use SSD scratch space.

**Custom + directory** support parallel restore:

    pg_restore -d target -j 8 dump.custom

Parallel restore handles data load + post-data (index build, FK validate) in parallel. **Single-transaction restore (`--single-transaction`) blocks parallelism — pick one.** Cannot combine.

### Compression

PG16+ adds LZ4 + Zstandard. Default is still `gzip`-equivalent (`pglz`).[^pg16]

    pg_dump -Fc --compress=lz4 -f dump.lz4 dbname
    pg_dump -Fc --compress=zstd -f dump.zst dbname
    pg_dump -Fc --compress=zstd:level=9,long -f dump.zst dbname   # PG16+ long mode

Custom and directory formats compress per-block by default. Tar format = no compression.

| Algorithm | Speed | Ratio | PG version | Notes |
| --- | --- | --- | --- | --- |
| `gzip` (`pglz`-equivalent default) | Medium | Medium | All | Default for `-Fc` / `-Fd` |
| `lz4` | Fast | Lower | PG16+ | Best for time-bound dumps + restores[^pg16] |
| `zstd` | Medium-fast | Best | PG16+ | Best ratio; `zstd:level=N` 1-22 + `long` mode for big windows[^pg16] |
| (none) | Fastest | 1.0× | All | `--compress=0` or `-Fp` raw |

Operational pattern: `lz4` for nightly + restore-speed-critical backups; `zstd:level=3` for retention-archive snapshots; raw + external `gzip --rsyncable` for incremental block sync.

Compression overhead is per-worker. `pg_dump -Fd -j 8 --compress=zstd:level=9` uses 8 zstd compressors. CPU saturates first.

### Permissions

Verbatim from PG16 docs[^pgdump]: needs `SELECT` on all dumped objects. Plus:

- **Dump objects owned by other users** → superuser (or `-O / --no-owner` skips ownership)
- **`--disable-triggers`** → superuser
- **Bypass RLS** → unless `--enable-row-security`, RLS-enabled tables fail or are silently filtered

`pg_dump` checks `SELECT` privilege per table. Tables hidden by RLS policy are dumped as empty unless `--enable-row-security` (which makes RLS engage against the dumping role's policies).

### Locking

Verbatim from PG16 docs[^pgdump]: pg_dump acquires `ACCESS SHARE` lock on every table being dumped. `ACCESS SHARE` conflicts ONLY with `ACCESS EXCLUSIVE` (used by `DROP TABLE`, `TRUNCATE`, `VACUUM FULL`, most `ALTER TABLE` variants without `CONCURRENTLY`). So pg_dump runs alongside normal DML but blocks `ALTER TABLE` and is blocked by it.

`--no-synchronized-snapshots` (or running on PG ≤ 9.1 sources) disables the synchronized snapshot — parallel pg_dump becomes inconsistent across worker connections. Don't disable unless you understand the tradeoff.

### pg_dumpall

Cluster-wide companion. Verbatim docs[^pgdumpall]: "extracting all PostgreSQL databases in a cluster into a single script file."

| Mode | Flag | Output |
| --- | --- | --- |
| Whole cluster | (default) | Globals + every database |
| Globals only | `--globals-only` (`-g`) | Roles + tablespaces + ALTER ROLE SET + grants. **No data, no schema.** |
| Roles only | `--roles-only` (`-r`) | Just roles |
| Tablespaces only | `--tablespaces-only` (`-t`) | Just tablespace definitions |
| Databases only | `--databases-only` (PG18+) | Skip globals |

Production pattern: `pg_dumpall --globals-only > globals.sql` once + `pg_dump -Fd -j N` per database. Combined gives full cluster.

`pg_dumpall` output is **plain text only** — there's no `pg_dumpall -Fc`. Wrap with `gzip` for compression.

### Connection Options

`pg_dump` accepts standard `libpq` connection options:

| Flag | Effect |
| --- | --- |
| `-h host` | Hostname or socket directory |
| `-p port` | Server port |
| `-U user` | Connection user |
| `-W` | Force password prompt |
| `--no-password` | Never prompt for password (fail if needed) |
| `-d dbname` | Source database (last positional arg also works) |
| `--role=name` | `SET ROLE` after connecting (useful with `pg_read_all_data`) |

Environment: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSERVICE`, `~/.pgpass`. Cross-reference `48-authentication-pg-hba.md` for connection-string variants + service-file pattern.

**No native `--sslmode` flag** — set via `PGSSLMODE=verify-full` environment variable or use `-d "postgresql://..."` connection URL form for explicit SSL parameters.

### Snapshot Semantics

`pg_dump` opens a single transaction at `REPEATABLE READ` isolation (or `SERIALIZABLE READ ONLY DEFERRABLE` with `--serializable-deferrable`). Snapshot frozen at first query. All tables dumped at the same logical instant.

Parallel `pg_dump -Fd -j N` uses **synchronized snapshots** — leader exports snapshot via `pg_export_snapshot()`, workers `SET TRANSACTION SNAPSHOT` to inherit. All workers see identical view of data. `--no-synchronized-snapshots` disables this on pre-PG9.2 sources (rare now).

Implication: **pg_dump duration = age of `xmin` horizon on source.** Long dumps prevent VACUUM from cleaning dead tuples on heavily-updated tables for the entire dump window. Cross-reference `27-mvcc-internals.md` for horizon mechanics + `28-vacuum-autovacuum.md` for bloat consequences.

### pg_restore

Reads custom / directory / tar archives produced by `pg_dump`. Cannot read plain (`-Fp`) — use `psql -f dump.sql` instead.

Core flags:

| Flag | Effect |
| --- | --- |
| `-d dbname` | Target database (must exist; create with `createdb` first or use `-C`) |
| `-C` | Create target database before restoring |
| `--clean` | Drop objects before recreating |
| `--if-exists` | Use `DROP ... IF EXISTS` (requires `--clean`) |
| `-j N` | Parallel workers (custom/directory only) |
| `--single-transaction` | Wrap whole restore in BEGIN/COMMIT (no parallelism) |
| `--transaction-size=N` (PG17+) | Batch transactions of N objects[^pg17] |
| `--no-owner` (`-O`) | Skip ownership commands |
| `--no-privileges` (`-x`) | Skip GRANT / REVOKE |
| `--list` (`-l`) | Print archive table-of-contents — restore-ready item list |
| `--use-list=file` (`-L file`) | Restore only the items listed in file (edit the `-l` output) |
| `--section={pre-data\|data\|post-data}` | Restore one section only |
| `-t name`, `-n name` | Select by table / schema (same patterns as pg_dump) |
| `--sync-method=method` (PG17+) | `fsync` or `syncfs` for post-restore durability[^pg17] |

**`pg_restore --list` + `--use-list` is the canonical "I want exactly these objects" pattern:**

    pg_restore --list dump.custom > all_objects.txt
    # edit all_objects.txt — comment out (;) the objects you don't want
    pg_restore --use-list=all_objects.txt -d target dump.custom

## Per-Version Timeline

| Version | Changes |
| --- | --- |
| **PG14** | `--extension=pattern` to dump objects belonging to a named extension. Multiple `-v` verbose flags supported.[^pg14] |
| **PG15** | `--no-table-access-method` forces default AM on restore. Public-schema ownership + security labels now dumped. Parallel pg_dump faster on big-TOAST tables. **Minimum source server: PG9.2+.**[^pg15] |
| **PG16** | LZ4 + Zstandard compression. `--compress=zstd:level=9,long`. `--table-and-children=pattern` / `--exclude-table-and-children` / `--exclude-table-data-and-children` for partitioned hierarchies.[^pg16] |
| **PG17** | `--filter=file` for batched include/exclude rules. `--exclude-extension`. Large objects restorable in batches (avoids transaction limits + enables parallel LO restore). `pg_restore --transaction-size=N` for batched transactions. `--sync-method={fsync\|syncfs}` controls post-restore durability.[^pg17] |
| **PG18** | `--statistics` preserves optimizer stats in dump. `--no-statistics` opt-out. `--no-policies` skips RLS policies. `--no-data`, `--no-schema`, `--statistics-only` for fine-grained control. `--sequence-data` dumps sequence values that would otherwise be excluded.[^pg18] |

**PG13 and earlier:** no major pg_dump headline items in PG13. PG12 removed `recovery.conf` model (cross-reference `73-streaming-replication.md`).

## Examples / Recipes

### Recipe 1 — Production single-database baseline

    # Backup
    pg_dump -Fd -j 4 -Z 6 -f /backup/mydb.dir mydb

    # Verify
    pg_restore --list /backup/mydb.dir | head -50

    # Restore on new cluster
    createdb -O myowner mydb
    pg_restore -d mydb -j 4 /backup/mydb.dir

Directory format + 4 parallel workers + zstd level 6 = production sweet spot on multi-core boxes.

### Recipe 2 — Cluster-wide backup with globals + per-DB data

    #!/bin/bash
    BACKUP=/backup/$(date +%Y-%m-%d)
    mkdir -p $BACKUP

    # Globals once
    pg_dumpall --globals-only -f $BACKUP/globals.sql

    # Each database
    for db in $(psql -At -c "SELECT datname FROM pg_database WHERE datistemplate=false AND datname != 'postgres'"); do
      pg_dump -Fd -j 4 -f $BACKUP/$db.dir $db
    done

Restore order: create cluster → restore globals → `createdb` per DB → `pg_restore` per DB.

### Recipe 3 — Restore one table from full dump

    pg_restore -d mydb -t users -t orders /backup/mydb.dir

Custom + directory formats only. Plain dumps require manually grepping the SQL.

### Recipe 4 — Schema-only diff via version control

    pg_dump --schema-only --no-owner --no-privileges -f schema-$(date +%Y%m%d).sql mydb

Plain text, sorted by section. Diff-friendly. Strip ownership + grants so the diff is structural-only.

### Recipe 5 — Schema-then-data-then-indexes restore (faster on large tables)

    # Pre-data first (tables + types, no indexes)
    pg_restore --section=pre-data --no-owner -d target /backup/mydb.dir

    # Parallel data load (no indexes/FKs fire)
    pg_restore --section=data --jobs=8 -d target /backup/mydb.dir

    # Post-data: indexes + FKs + triggers built once from final data
    pg_restore --section=post-data --jobs=8 -d target /backup/mydb.dir

5-10× faster on TB-scale restores than monolithic `pg_restore`.

### Recipe 6 — Selective restore via `--list` + `--use-list`

    # Generate TOC
    pg_restore --list /backup/mydb.dir > toc.txt

    # Comment out unwanted items (prepend ;)
    # Then restore
    pg_restore --use-list=toc.txt -d target /backup/mydb.dir

Useful when migrating partial schemas, skipping one bad object, or filtering by object type.

### Recipe 7 — Force restore on existing cluster

    pg_restore --clean --if-exists -d existing_db /backup/mydb.dir

Drops every object first using `DROP ... IF EXISTS`. Without `--if-exists`, missing objects produce errors. Without `--clean`, `CREATE` collides with existing objects.

### Recipe 8 — PG14+ extension scoping

    pg_dump --extension=postgis -f postgis-only.sql mydb

Only objects defined by `postgis` extension. Useful when migrating extension data between clusters with different extension versions.

### Recipe 9 — PG17+ filter file for complex include/exclude

    cat > filter.txt <<EOF
    include schema public
    include schema analytics
    exclude table_data public.audit_log
    exclude table_data public.session_events
    exclude extension pg_cron
    EOF

    pg_dump -Fd -j 4 --filter=filter.txt -f /backup/mydb.dir mydb

`--filter` scales beyond `-t` / `-T` repetition. One rule per line.

### Recipe 10 — PG18+ preserve planner stats across restore

    pg_dump -Fc --statistics -f mydb.custom mydb
    pg_restore -d target mydb.custom

PG18 dumps `pg_statistic` + `pg_statistic_ext_data`. **Skips extended stats objects (`CREATE STATISTICS`)** — those still need rebuilding. Skip `vacuumdb --analyze-in-stages` on PG18+ for the per-column stats; still run for extended stats.[^pg18]

### Recipe 11 — Skip RLS policies during migration

    pg_dump -Fc --no-policies -f mydb.custom mydb       # PG18+
    pg_restore -d target --no-policies mydb.custom      # PG18+

Useful when target cluster has different RLS schema or you want to inspect data without policies.

### Recipe 12 — Audit existing dump archive

    pg_restore --list /backup/mydb.dir | head -30
    pg_restore --list /backup/mydb.dir | grep -c '^[0-9]'        # Total object count
    pg_restore --list /backup/mydb.dir | awk -F';' '{print $5}' | sort -u   # Object types

`--list` (`-l`) outputs the archive's table of contents without restoring. Reader can confirm what's in a backup before relying on it.

### Recipe 13 — Pipe dump → restore between clusters (no intermediate file)

    pg_dump -Fc mydb | pg_restore -d target_db -

Or with parallel directory format via fifo:

    mkfifo /tmp/dump_fifo
    pg_dump -Fd -j 4 -f /tmp/dump_fifo mydb &
    pg_restore -j 4 -d target_db /tmp/dump_fifo

Useful for migrations that can't land bytes on disk. **Lose `pg_restore --list` introspection** — archive only exists in-flight.

### Recipe 14 — Lock-aware monitoring during pg_dump

    SELECT pid, mode, granted, relation::regclass, query_start, state
    FROM pg_locks l
    JOIN pg_stat_activity s USING (pid)
    WHERE l.relation IS NOT NULL
      AND s.application_name LIKE 'pg_dump%'
    ORDER BY query_start;

pg_dump shows up as `application_name = 'pg_dump'` (parallel workers append worker ID). Catches stalls — pg_dump waiting on `ACCESS EXCLUSIVE` from concurrent ALTER TABLE.

### Recipe 15 — Encrypt dump with GPG (no plaintext on disk)

    # Symmetric (passphrase)
    pg_dump -Fc mydb | gpg --symmetric --cipher-algo AES256 -o /backup/mydb.dump.gpg

    # Asymmetric (recipient key)
    pg_dump -Fc mydb | gpg --encrypt --recipient backup@example.com -o /backup/mydb.dump.gpg

    # Restore
    gpg --decrypt /backup/mydb.dump.gpg | pg_restore -d target_db

Pipe avoids leaving plaintext dump on disk. Combine with directory format via per-file tar:

    pg_dump -Fd -j 4 -f /tmp/mydb.dir mydb
    tar -cf - -C /tmp mydb.dir | gpg --symmetric -o /backup/mydb.dir.tar.gpg
    rm -rf /tmp/mydb.dir

Cross-reference `50-encryption-pgcrypto.md` — pgcrypto is in-database encryption; this is dump-file encryption (orthogonal concern).

### Recipe 16 — Cross-version migration via pg_dump

    # Source: PG14 cluster
    # Target: PG18 cluster
    # ALWAYS run pg_dump from the TARGET version
    /usr/pgsql-18/bin/pg_dump -Fd -j 4 -h pg14-host -f /backup/mydb.dir mydb

    # Restore on PG18
    pg_restore -d mydb -j 4 /backup/mydb.dir

Newer pg_dump reads older servers cleanly. **Reverse direction fails**: PG14 pg_dump cannot read PG18 server because catalog schema changed.

For zero-downtime cross-version: use logical replication (cross-reference `74-logical-replication.md` Recipe 5) or `pg_createsubscriber` PG17+ (`77-standby-failover.md`).

### Recipe 17 — Schema-and-data separation for selective table reload

    # Capture schema separately
    pg_dump --schema-only -Fc -f /backup/mydb_schema.custom mydb

    # Capture each big table's data separately
    pg_dump --data-only -Fc -t public.events -f /backup/events.data mydb
    pg_dump --data-only -Fc -t public.orders -f /backup/orders.data mydb

    # Restore schema on fresh cluster
    createdb mydb
    pg_restore -d mydb /backup/mydb_schema.custom

    # Reload one table only
    pg_restore -d mydb /backup/events.data

Useful when one table is recoverable independently or when partial restore is the desired pattern. Beware of FK ordering — load referenced tables first.

### Recipe 18 — Verify dump integrity (catch silent corruption)

    # Restore TOC validates archive header
    pg_restore --list /backup/mydb.dir > /dev/null

    # Full test restore on disposable target
    createdb test_restore_$$
    pg_restore -d test_restore_$$ /backup/mydb.dir 2> /tmp/restore_errors.log
    grep -i 'error\|warning' /tmp/restore_errors.log
    dropdb test_restore_$$

`pg_restore --list` parses the header but not the data. Only a full restore confirms data integrity. Schedule weekly verification restore against a separate test cluster.

### Recipe 19 — Limit dump impact on long-running source

    # Run during low-traffic window
    # Throttle network if dump destination is remote
    pg_dump -Fc -h source-host mydb | \
        pv -L 50m | \
        ssh backup-host "cat > /backup/mydb.custom"

    # Or limit parallel workers to free up source CPU
    pg_dump -Fd -j 2 -f /backup/mydb.dir mydb

**Cannot directly throttle pg_dump's read rate.** `pv` (Pipe Viewer) controls output throughput. Reducing `-j` reduces parallel-table read pressure.

### Recipe 20a — Verify restored row counts match source

    -- On source, capture per-table row counts before dump
    SELECT schemaname, relname,
           pg_total_relation_size(relid) AS bytes,
           (SELECT reltuples::bigint FROM pg_class WHERE oid = relid) AS estimated_rows
    FROM pg_stat_user_tables
    ORDER BY bytes DESC;

    -- After restore on target, compare
    -- For exact counts on suspect tables:
    SELECT COUNT(*) FROM public.events;   -- source
    SELECT COUNT(*) FROM public.events;   -- target

`reltuples` is the planner's estimate, refreshed by `ANALYZE`. For audit-grade verification run `SELECT COUNT(*)` on each table source vs. target. Cross-reference `64-system-catalogs.md` for the `pg_class.relkind` filter.

Combine with `pg_dump --section=data` size measurement to confirm the dump captured what you expected.

### Recipe 21 — Use pg_read_all_data role for unprivileged backup user

    -- On source cluster, create backup role
    CREATE ROLE backup_user LOGIN PASSWORD '...';
    GRANT pg_read_all_data TO backup_user;

    -- Now backup_user can pg_dump without table-by-table SELECT grants
    PGPASSWORD=... pg_dump -U backup_user -Fd -j 4 -f /backup/mydb.dir mydb

`pg_read_all_data` is a predefined role (PG14+). Avoids superuser exposure for backup jobs. Cross-reference `46-roles-privileges.md`.

### Recipe 22 — Reduce dump duration on heavily-updated source

Long pg_dump = long `xmin` horizon = autovacuum cannot clean dead tuples on source. On heavily-updated tables this compounds: dump runs slow → horizon pinned → bloat → dump runs slower.

Mitigations:

1. **Schedule dumps on a streaming replica**, not the primary. Replica's `xmin` doesn't affect primary's vacuum horizon unless `hot_standby_feedback=on` (cross-reference `73-streaming-replication.md`).
2. **Use directory format `-Fd -j N`** for parallel — shortens wall-clock duration even at constant total CPU.
3. **`pg_dump --exclude-table-data` on hot append-only tables** (audit logs, event sinks) and back them up separately via partitioning / WAL archive.
4. **Run smaller `pg_dump` invocations per schema** — separate transactions, separate horizons. Operationally awkward but reduces single-snapshot lifetime.

For TB-scale clusters with this problem, **stop using `pg_dump`** and adopt `pg_basebackup` + WAL archiving (`84-backup-physical-pitr.md`) or a parallel block-level tool like pgBackRest / WAL-G (`85-backup-tools.md`).

## Gotchas / Anti-patterns

1. **`pg_dump` does NOT capture roles, tablespaces, or cluster-wide `ALTER ROLE SET` settings.** Use `pg_dumpall --globals-only` separately. Single-database `pg_dump` restore on a fresh cluster fails grants because target roles don't exist yet.[^pgdumpall]
2. **`pg_dumpall` only produces plain SQL.** No `-Fc`, no `-Fd`. Use per-database `pg_dump -Fd` + global-only `pg_dumpall` for parallel + selective restore.
3. **Materialized view data is NOT dumped.** Only the schema. After restore, matviews are `relispopulated = false` and unscannable until `REFRESH MATERIALIZED VIEW`. Schedule the refresh.[^pgdump]
4. **Plain format (`-Fp`) cannot be parallel-restored or selectively restored.** Production should default to `-Fc` or `-Fd`. Switch to plain only for human-readable diffs.
5. **Tar format does NOT support compression.** Use custom or directory.
6. **Only directory format supports parallel dump (`-j`).** `-Fc -j 4` is silently ignored — pg_dump still single-threads.
7. **`pg_restore --single-transaction` disables `--jobs`.** Either get atomicity OR parallelism. Production usually picks parallelism + manual cleanup on failure.
8. **`pg_restore -t users` does NOT restore the FKs pointing at `users` from other tables.** Selective restore is per-object; cross-object dependencies break silently. Use `--list` + `--use-list` to control fully.
9. **`pg_dump` acquires `ACCESS SHARE` on every table.** Blocks `ALTER TABLE` for the duration — even on tables you're not actively dumping right now. Long dumps stall DDL deployments.[^pgdump]
10. **PG18 `--statistics` does NOT include extended statistics objects** (`CREATE STATISTICS`). Run `ANALYZE` post-restore to rebuild those. Cross-reference `55-statistics-planner.md`.[^pg18]
11. **Cross-version dump compatibility is one-way: newer pg_dump can read older servers, older pg_dump cannot read newer servers.** Always run pg_dump from the **target** (newer) version when migrating to a newer cluster.
12. **`pg_dump` runs as a single transaction on the source.** Long dumps hold `xmin` horizon for the duration. Cross-reference `27-mvcc-internals.md` for the bloat consequence — heavily-updated source tables accumulate dead tuples that VACUUM cannot reclaim until pg_dump finishes.
13. **PG15+ pg_dump cannot dump from PG ≤ 9.1.** Source compatibility cut at PG9.2.[^pg15]
14. **PG18 `--no-statistics` reverts to pre-PG18 behavior.** If you have post-restore scripts that run `vacuumdb --analyze-in-stages`, decide deliberately whether to keep them after upgrading to PG18.
15. **`pg_dump -Fc` archive is NOT a tar file.** Don't try `tar tvf dump.custom`. Use `pg_restore --list`.
16. **`pg_restore -l` (lowercase L) and `pg_restore --list` are the same flag.** Both output the TOC. Don't confuse with `pg_restore -1` (one dash + digit one) which means `--single-transaction`.
17. **Selective restore via `-t pattern` is per-table only.** Doesn't include sequences, indexes from other schemas, etc. Use `--list` + `--use-list` for complete control.
18. **`pg_dump --jobs` uses one connection per worker.** With `-j 8` you consume 9 connections (8 workers + leader). Plan `max_connections` headroom.
19. **`pg_restore --jobs` similarly uses N connections.** Restore-time `max_connections` must accommodate.
20. **`pg_dump` of partitioned table dumps ALL partitions unless `--exclude-table-data-and-children` is used.** Pre-PG16 you needed `-T` per partition. PG16+ `--exclude-table-and-children` simplifies.[^pg16]
21. **Restoring on the SAME cluster as the dump source creates name collisions.** Either use `--clean --if-exists` or restore into a different DB / schema first.
22. **`pg_dump` follows symlinked extensions** but **does NOT dump the extension's binary `.so` files** — those must be installed via package manager on the target before restore. PG14+ `--extension` controls scope; cross-reference `69-extensions.md`.[^pg14]
23. **`pg_dump --no-owner` makes all objects owned by the connecting user on restore.** Useful for cross-account migrations; dangerous if you assumed ownership came across.
24. **`pg_dump` does NOT dump replication slots.** Slots are physical state on the source cluster. Cross-reference `75-replication-slots.md` — slots must be recreated on the new cluster post-restore.
25. **`pg_dump` does NOT dump WAL or any data-on-disk byte stream.** Logical format only. PITR requires `pg_basebackup` + WAL archive — see `84-backup-physical-pitr.md`.
26. **`pg_dumpall` runs `pg_dump` for each database serially.** No `--jobs` flag on `pg_dumpall`. For large clusters, script per-database `pg_dump -Fd -j N` invocations in parallel — see Recipe 2.
27. **PG18 `--no-statistics` is now meaningful** — pre-PG18, statistics were never dumped, so the flag had no effect. Post-PG18 it reverts to "exclude statistics." Default behavior in PG18 still excludes stats unless you pass `--statistics`.
28. **`pg_restore --transaction-size=N` (PG17+) is NOT `--single-transaction`.** Single-transaction wraps the whole restore in one BEGIN/COMMIT (no parallelism, atomic). `--transaction-size=N` batches N objects per transaction (parallelism-compatible, partial failures possible).
29. **`pg_dump --column-inserts` produces individual INSERT statements per row** instead of COPY. 10-100× slower restore. Used only when target database doesn't support COPY (rare — most non-PG databases) or for cherry-picking restorability.

### Recipe 23 — Inspect dump archive metadata without restoring

    # Header summary
    pg_restore --list dump.custom | head -20

    # Object counts by type
    pg_restore --list dump.custom \
      | awk -F';' 'NR>10 {gsub(/^ /,"",$3); print $3}' \
      | sort | uniq -c | sort -rn

    # Find specific object
    pg_restore --list dump.custom | grep -i 'orders'

    # Estimate dump file age via filesystem mtime
    stat -c '%y' /backup/mydb.dir

Useful for confirming what's actually in an old backup before relying on it for restore.

### Recipe 24 — Strip ownership + grants for portable dumps

    pg_dump -Fc --no-owner --no-privileges -f portable.custom mydb

Useful when:

- Source + target clusters have different role schemas
- Sharing dump for testing where production roles don't exist
- Cross-account migrations where role names differ

`--no-owner` skips `ALTER OWNER` commands; `--no-privileges` skips `GRANT` / `REVOKE`. Restored objects belong to the user running `pg_restore`.

## See Also

- `46-roles-privileges.md` — `pg_dumpall --globals-only` captures roles + grants; restore order matters; `pg_read_all_data` predefined role for backup users
- `47-row-level-security.md` — PG18 `--no-policies` cross-reference
- `55-statistics-planner.md` — PG18 `--statistics` preservation + extended statistics gap
- `66-bulk-operations-copy.md` — `COPY` is the underlying data-transfer primitive used by `pg_dump` data sections
- `67-cli-tools.md` — `psql -f` for plain-format restore
- `73-streaming-replication.md` — physical replication contrast
- `84-backup-physical-pitr.md` — `pg_basebackup` + WAL archiving for PITR + byte-level backup
- `85-backup-tools.md` — `pgBackRest` / `Barman` / `WAL-G` for parallel + incremental + retention management
- `86-pg-upgrade.md` — `pg_upgrade` mechanics; pg_dump/restore as fallback path
- `87-major-version-upgrade.md` — pg_dump in zero-downtime upgrade strategies
- `99-pg-partman.md` — partition hierarchy dumping with PG16+ `--table-and-children`
- `88-corruption-recovery.md` — verify restored cluster integrity with `pg_amcheck` + `amcheck` after restore
- `101-managed-vs-baremetal.md` — managed environments may restrict `pg_read_server_files`; pg_dump runs as client so usually works

## Sources

[^pgdump]: PostgreSQL 16 documentation, `pg_dump`. https://www.postgresql.org/docs/16/app-pgdump.html
[^pgdumpall]: PostgreSQL 16 documentation, `pg_dumpall`. https://www.postgresql.org/docs/16/app-pg-dumpall.html
[^pgrestore]: PostgreSQL 16 documentation, `pg_restore`. https://www.postgresql.org/docs/16/app-pgrestore.html
[^backup-dump]: PostgreSQL 16 documentation, "Backup and Restore — SQL Dump". https://www.postgresql.org/docs/16/backup-dump.html
[^pg14]: PostgreSQL 14 Release Notes — verbatim: "Allow pg_dump to dump only certain extensions. This is controlled by option `--extension`." (Guillaume Lelarge) + "Allow multiple verbose option specifications (`-v`) to increase the logging verbosity. This behavior is supported by pg_dump, pg_dumpall, and pg_restore." (Tom Lane). https://www.postgresql.org/docs/release/14.0/
[^pg15]: PostgreSQL 15 Release Notes — verbatim: "Add dump/restore option `--no-table-access-method` to force restore to only use the default table access method." (Justin Pryzby) + "Make pg_dump dump public schema ownership changes and security labels." (Noah Misch) + "Improve parallel pg_dump's performance for tables with large TOAST tables." (Tom Lane) + "Limit support of pg_dump and pg_dumpall to servers running PostgreSQL 9.2 or later." (Tom Lane). https://www.postgresql.org/docs/release/15.0/
[^pg16]: PostgreSQL 16 Release Notes — verbatim: "Add pg_dump control of dumping child tables and partitions." (Gilles Darold) + "Add LZ4 and Zstandard compression to pg_dump." (Georgios Kokolatos, Justin Pryzby) + "Allow pg_dump and pg_basebackup to use long mode for compression." (Justin Pryzby). https://www.postgresql.org/docs/release/16.0/
[^pg17]: PostgreSQL 17 Release Notes — verbatim: "Allow pg_dump, pg_dumpall, and pg_restore to specify include/exclude objects in a file." (Pavel Stehule, Daniel Gustafsson) + "Add pg_dump option --exclude-extension." (Ayush Vatsa) + "Allow pg_dump's large objects to be restorable in batches. This allows the restoration of many large objects to avoid transaction limits and to be restored in parallel." (Tom Lane) + "Add pg_restore option --transaction-size to allow object restores in transaction batches." (Tom Lane) + "Add the --sync-method parameter to several client applications." (Justin Pryzby, Nathan Bossart). https://www.postgresql.org/docs/release/17.0/
[^pg18]: PostgreSQL 18 Release Notes — verbatim: "Add pg_dump, pg_dumpall, and pg_restore options `--statistics-only`, `--no-statistics`, `--no-data`, and `--no-schema`." (Corey Huinker, Jeff Davis) + "Add option `--no-policies` to disable row level security policy processing in pg_dump, pg_dumpall, pg_restore. This is useful for migrating to systems with different policies." (Nikolay Samokhvalov) + "Add pg_dump and pg_dumpall option `--sequence-data` to dump sequence data that would normally be excluded." (Nathan Bossart) + "Add pg_dump option `--statistics`." (Jeff Davis). https://www.postgresql.org/docs/release/18.0/
[^pg17-pgdump]: PostgreSQL 17 documentation, `pg_dump`. https://www.postgresql.org/docs/17/app-pgdump.html
[^pg18-pgdump]: PostgreSQL 18 documentation, `pg_dump`. https://www.postgresql.org/docs/18/app-pgdump.html

# pg_dump / pg_dumpall / pg_restore — Logical Backup

> [!WARNING] **`pg_dump` is per-database. `pg_dumpall` is cluster-wide globals + data.**
> `pg_dump mydb` dumps one database, not cluster-wide roles or tablespaces. A cluster restore also needs globals, typically from `pg_dumpall --globals-only`. Materialized-view rows are not copied as table data: a normal full dump includes refresh entries for populated materialized views. Schema-only or selective restores that omit those entries can leave them unpopulated.[^pgdump]

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
| Tar | `-Ft` | TAR archive | No | No | Yes | None |

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

Selection rules differ by option. In particular, `pg_dump -n` and `-N` have no effect when `-t` is used; the selected tables are dumped regardless of schema filters.[^pgdump]

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

`pg_restore` has separate selection semantics: its `-t` accepts exact table names, not patterns or schema-qualified names; combine `-n` to select a schema. It does not automatically include subsidiary indexes or dependencies. See <https://www.postgresql.org/docs/16/app-pgrestore.html>.

### Parallel Dump and Restore

**Directory format only** supports parallel dump:

    pg_dump -Fd -j 8 -f /backup/dir dbname

`-j N` = N concurrent workers, one per table. Bottleneck on slow tables (largest single table). Use SSD scratch space.

**Custom + directory** support parallel restore:

    pg_restore -d target -j 8 dump.custom

Parallel restore handles data load + post-data (index build, FK validate) in parallel. **Single-transaction restore (`--single-transaction`) blocks parallelism — pick one.** Cannot combine.

### Compression

PG16+ adds LZ4 + Zstandard. Custom and directory archives default to gzip.[^pgdump]

    pg_dump -Fc --compress=lz4 -f dump.lz4 dbname
    pg_dump -Fc --compress=zstd -f dump.zst dbname
    pg_dump -Fc --compress=zstd:level=9,long -f dump.zst dbname   # PG16+ long mode

Custom and directory formats compress per-block by default. Tar format = no compression.

| Algorithm | Speed | Ratio | PG version | Notes |
| --- | --- | --- | --- | --- |
| `gzip` (default) | Medium | Medium | All | Default for `-Fc` / `-Fd` |
| `lz4` | Fast | Lower | PG16+ | Best for time-bound dumps + restores[^pg16] |
| `zstd` | Medium-fast | Best | PG16+ | Best ratio; `zstd:level=N` 1-22 + `long` mode for big windows[^pg16] |
| (none) | Fastest | 1.0× | All | `--compress=0` or `-Fp` raw |

Operational pattern: `lz4` for nightly + restore-speed-critical backups; `zstd:level=3` for retention-archive snapshots; raw + external `gzip --rsyncable` for incremental block sync.

Compression overhead is per-worker. `pg_dump -Fd -j 8 --compress=zstd:level=9` uses 8 zstd compressors. CPU saturates first.

### Permissions

The dumping role needs access to the dumped objects. It need not own every object or be a superuser; `--no-owner` controls ownership commands in the restore, not permissions to read the source. Restoring with `--disable-triggers` requires superuser privileges.

By default `pg_dump` sets `row_security = off` and fails if the role cannot bypass RLS; it does not silently dump filtered rows. `--enable-row-security` explicitly permits a policy-filtered dump, which is not a complete backup. If restoring with RLS enabled, use INSERT format because `COPY FROM` does not support row security.[^pgdump]

### Locking

Verbatim from PG16 docs[^pgdump]: pg_dump acquires `ACCESS SHARE` lock on every table being dumped. `ACCESS SHARE` conflicts ONLY with `ACCESS EXCLUSIVE` (used by `DROP TABLE`, `TRUNCATE`, `VACUUM FULL`, most `ALTER TABLE` variants without `CONCURRENTLY`). So pg_dump runs alongside normal DML but blocks `ALTER TABLE` and is blocked by it.

Parallel dumps require synchronized snapshots; workers abort if a queued exclusive lock prevents them from acquiring a shared lock.[^pgdump]

### pg_dumpall

Cluster-wide companion. Verbatim docs[^pgdumpall]: "extracting all PostgreSQL databases in a cluster into a single script file."

| Mode | Flag | Output |
| --- | --- | --- |
| Whole cluster | (default) | Globals + every database |
| Globals only | `--globals-only` (`-g`) | Roles + tablespaces + ALTER ROLE SET + grants. **No data, no schema.** |
| Roles only | `--roles-only` (`-r`) | Just roles |
| Tablespaces only | `--tablespaces-only` (`-t`) | Just tablespace definitions |

Production pattern: `pg_dumpall --globals-only > globals.sql` once + `pg_dump -Fd -j N` per database. Restore reviewed globals before database archives, using the role preparation in Recipe 2. Globals-only output does not include database ACLs or per-database settings; `pg_restore --create` restores that metadata from an archive, after planning for any existing target database. Its `-d` names the initial connection database, while the restored database name comes from the archive.[^pgrestore] These are logical backups with separate database snapshots, not a physical or cluster-wide point-in-time backup.

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

Parallel `pg_dump -Fd -j N` uses synchronized snapshots so all workers see the same data.[^pgdump]

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
| `-t name`, `-n name` | Select exact table / schema names, not patterns |

**`pg_restore --list` + `--use-list` is the canonical "I want exactly these objects" pattern:**

    pg_restore --list dump.custom > all_objects.txt
    # edit all_objects.txt — comment out (;) the objects you don't want
    pg_restore --use-list=all_objects.txt -d target dump.custom

> [!WARNING] Minor releases 2026-08-13 / 2026-11-12
> Several `pg_dump` and `pg_restore` CVEs were fixed in these rounds: CVE-2026-19385 (`pg_dump` overflow, 2026-08-13)[^minor-aug-announce]; CVE-2026-116314 (`pg_restore`, CVSS 8.8, exploitable without privileges), CVE-2026-116318 (SQL injection through a not-null constraint name in `pg_dump` output), and CVE-2026-116330 (psql injection through the `restore.sql` of a `pg_dump` tar archive) (2026-11-12).[^minor-nov-announce] Restore only trusted archives, and run `pg_dump` and `pg_restore` from the current minors. Full CVE list: <https://www.postgresql.org/support/security/>.

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

Directory format + 4 parallel workers + gzip level 6. Use `--compress=zstd:6` to select zstd explicitly.

### Recipe 2 — Cluster-wide backup with globals + per-DB data

    # All databases, roles and tablespaces in a plain SQL script:
    pg_dumpall --file=/backup/cluster.sql

`pg_dumpall` includes the `postgres` database, but takes a separate snapshot for each database; it is not a cluster-wide point-in-time snapshot. For per-database parallel dumps, inventory every connectable database, including `postgres`, handle database names safely, and retain a mapping from database names to archive paths. See <https://www.postgresql.org/docs/16/app-pg-dumpall.html>.

Prepare an isolated target before running `psql -X -v ON_ERROR_STOP=1 -f /backup/cluster-reviewed.sql postgres`. A normal dump contains `CREATE ROLE` for the source bootstrap superuser, commonly `postgres`; `initdb` has already created that role on a target initialized with the same name. An unmodified restore would stop at that expected conflict before restoring the databases.

Create `/backup/cluster-reviewed.sql` as a copy of the dump and keep the original backup unchanged. Review that copy's global-role section against the target's role inventory. For a bootstrap role verified to represent the same intended identity, omit only its duplicate `CREATE ROLE` statement from the reviewed copy; retain its following `ALTER ROLE`, settings, grants and membership statements. Reconcile other existing roles and objects deliberately, and prepare tablespace paths and permissions. Do not remove matching text elsewhere in the dump or disable `ON_ERROR_STOP` globally to ignore errors. Restore only trusted SQL and retain fail-fast handling for unexpected failures. See <https://www.postgresql.org/docs/18/app-pg-dumpall.html>.

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

PG18 includes most optimizer statistics, but not extended statistics data created with `CREATE STATISTICS`, extension-specific statistics, or cumulative statistics. Run `ANALYZE` as needed after restore. See <https://www.postgresql.org/docs/18/app-pgdump.html>.

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

    pg_dump -Fc mydb | pg_restore --exit-on-error -d target_db

This is a serial restore: parallel restore requires a regular custom-format file or directory archive, not a pipe. Directory-format dumps require a directory, not a FIFO. See <https://www.postgresql.org/docs/16/app-pgrestore.html>.

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

    set -e
    # Point PGHOST and PGPORT at a disposable, isolated test cluster.
    pg_restore --list /backup/mydb.dir > /dev/null
    createdb test_restore_$$
    pg_restore --exit-on-error -d test_restore_$$ /backup/mydb.dir
    # Check application-level invariants before removing the test database.

`pg_restore --list` reads the archive's table of contents, not all archived data. A full test restore checks restorability in that target environment; it does not prove data completeness or business consistency. Validate constraints and application invariants as part of scheduled restore tests.

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
3. **Materialized-view population is restored through refresh entries.** A full dump normally refreshes views that were populated on the source. Unpopulated source views, schema-only dumps, or selective restores omitting refresh entries can leave views unscannable until an explicit refresh.[^pgdump]
4. **Plain format (`-Fp`) cannot be parallel-restored or selectively restored.** Production should default to `-Fc` or `-Fd`. Switch to plain only for human-readable diffs.
5. **Tar format does NOT support compression.** Use custom or directory.
6. **Only directory format supports parallel dump (`-j`).** A parallel dump using custom format is rejected; use `-Fd`.
7. **`pg_restore --single-transaction` disables `--jobs`.** Either get atomicity OR parallelism. Production usually picks parallelism + manual cleanup on failure.
8. **`pg_restore -t users` does NOT restore the FKs pointing at `users` from other tables.** Selective restore is per-object; cross-object dependencies break silently. Use `--list` + `--use-list` to control fully.
9. **`pg_dump` acquires `ACCESS SHARE` on every table.** Blocks `ALTER TABLE` for the duration — even on tables you're not actively dumping right now. Long dumps stall DDL deployments.[^pgdump]
10. **PG18 `--statistics` does not include collected extended statistics.** Run `ANALYZE` after restore to regenerate missing statistics.
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
23. **Ownership suppression for archives belongs on `pg_restore`.** `pg_dump --no-owner` is ignored for archive output; use `pg_restore --no-owner` when desired.
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

    pg_dump -Fc -f portable.custom mydb
    pg_restore --no-owner --no-privileges -d target portable.custom

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

[^minor-aug-announce]: PostgreSQL 18.6, 17.11, 16.15, 15.19, 14.24, and 19 Beta 3 released (2026-08-13). <https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/>
[^minor-nov-announce]: PostgreSQL 18.7, 17.12, 16.16, 15.20, 14.25, and 19 RC 2 released (2026-11-12). <https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442/>

# Tablespaces

PostgreSQL tablespaces are named directory pointers that tell the cluster *where on disk* to put the files for a database object. They are not filegroups (in the SQL Server sense), they are not partitions, and they are not backup units. This file is the canonical reference for what tablespaces are, when to reach for them, the operational consequences of using them, and the common misconceptions.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Built-in tablespaces](#built-in-tablespaces)
    - [CREATE TABLESPACE](#create-tablespace)
    - [ALTER TABLESPACE](#alter-tablespace)
    - [DROP TABLESPACE](#drop-tablespace)
    - [Placing objects in a tablespace](#placing-objects-in-a-tablespace)
    - [Moving existing objects](#moving-existing-objects)
    - [Per-tablespace planner options](#per-tablespace-planner-options)
    - [Configuration GUCs](#configuration-gucs)
    - [pg_tablespace catalog](#pg_tablespace-catalog)
- [Per-version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when you are deciding **where on disk** a database object's files should live, separately from the cluster's primary data directory `$PGDATA/base`. Reach for tablespaces when:

- You have **physically separate storage devices** (a dedicated NVMe for hot tables; archival HDDs for cold partitions) and want planner cost constants to reflect that;
- You need to **separate temporary file I/O** from main heap I/O (`temp_tablespaces`);
- You need to **distribute large indexes** across multiple devices to spread I/O.

Do **not** reach for tablespaces when you want:

- Logical grouping of related objects for administration (use a **schema**);
- Backup-unit separation (use **per-database backups** or **per-schema dumps**);
- "Move cold data off the hot disk" without considering the backup-replication-WAL chain implications;
- "A partition lives on a different disk" — that is the canonical legitimate use, but the partition itself must still be a normal PG declarative partition (see [35-partitioning.md](./35-partitioning.md)). Tablespaces are not partitions.

> [!WARNING] Tablespaces are not filegroups
> Operators arriving from SQL Server frequently expect tablespaces to be the PG equivalent of filegroups. They are not. A tablespace is just a named directory pointer with an owner and per-tablespace planner cost overrides. It does not group objects by purpose, it does not have its own page-level allocator independent of the rest of the cluster, and it cannot be backed up or restored independently.

## Mental Model

Five rules cover almost every tablespace question:

1. **A tablespace is a directory pointer with a name and owner — not a filegroup, not a partition, not a backup unit.** PostgreSQL stores objects as files in `<location>/PG_<major>_<catalog_version>/<dboid>/<filenode>`. A tablespace is just a named symlink in `$PGDATA/pg_tblspc/` that points at this location.[^manage-ag]

2. **Every cluster has two built-in tablespaces created automatically by `initdb`.** `pg_default` (where the `template1` and `template0` databases live, and the default for every new database) maps to `$PGDATA/base`. `pg_global` holds shared system catalogs (`pg_database`, `pg_authid`, ...) and lives in `$PGDATA/global`. You cannot drop either.[^manage-ag]

3. **Tablespaces are cluster-wide, not per-database.** A tablespace name is unique across the cluster. You cannot "create a tablespace per database." The same tablespace can host objects from multiple databases, and the object's `<dboid>` subdirectory is what separates them.[^manage-ag]

4. **`default_tablespace` and `temp_tablespaces` are per-session/per-role GUCs that decide where *new* objects go.** Existing objects do not move on their own. The empty string for `default_tablespace` means "use the database's default tablespace" (`pg_default` unless `CREATE DATABASE ... TABLESPACE` overrode it).[^runtime-config-client]

5. **Tablespaces complicate backups significantly.** They are *not* an autonomous collection of data files. The cluster's main data directory holds the metadata that points at them; the tablespace contents alone are useless without it. Backup tools (pgBackRest, Barman, WAL-G) require explicit per-tablespace configuration. **`pg_basebackup` handles tablespaces correctly only when configured to do so explicitly** — the `--tablespace-mapping` option remaps tablespace paths during the backup.[^manage-ag-backup]

> [!WARNING] Tablespace location is critical and irreversible state
> Verbatim from the docs: *"Even though located outside the main PostgreSQL data directory, tablespaces are an integral part of the database cluster and **cannot** be treated as an autonomous collection of data files. They are dependent on metadata contained in the main data directory, and therefore cannot be attached to a different database cluster or backed up individually. Similarly, if you lose a tablespace (file deletion, disk failure, etc.), the database cluster might become unreadable or unable to start."*[^manage-ag-backup]

## Decision Matrix

| You want to ... | Use ... | Avoid ... | Why |
|---|---|---|---|
| Group related objects logically for admin | `CREATE SCHEMA` | tablespace | tablespaces are filesystem locations, not logical groups |
| Put hot tables on faster storage | `CREATE TABLESPACE` on the NVMe mount | symlinks inside `$PGDATA` | symlinks bypass PG's tracking; tablespaces are the supported mechanism |
| Put cold partitions on cheaper storage | `CREATE TABLESPACE` per-partition via `CREATE TABLE ... TABLESPACE` | one cluster-wide setting | per-object granularity is the only sane approach |
| Spill `ORDER BY` / hash spills to dedicated device | `temp_tablespaces` per role | `default_tablespace` | only `temp_tablespaces` covers temp files; default doesn't |
| Survive a disk failure on the secondary device | accept that the cluster is unreadable | `CREATE TABLESPACE` on flaky storage | losing a tablespace can make the whole cluster fail to start[^manage-ag-backup] |
| Move a 500 GB table to new storage | `ALTER TABLE ... SET TABLESPACE` during a maintenance window | online migration via tablespace alone | this takes `ACCESS EXCLUSIVE` for the duration; use `pg_repack` if you need online[^alter-tablespace-lock] |
| Reduce index-build memory pressure on main disk | `REINDEX ... TABLESPACE` (PG14+) | manual workarounds | PG14 added the direct `TABLESPACE` clause for `REINDEX`[^pg14-reindex-tbl] |
| Per-device planner cost tuning | per-tablespace `seq_page_cost` / `random_page_cost` / `effective_io_concurrency` / `maintenance_io_concurrency` | cluster-wide values | the four options exist for exactly this[^create-tablespace] |
| Make backups simpler | **don't use additional tablespaces** | unnecessary tablespaces | every tablespace is a separate backup-tool configuration concern |

Three smell signals that you reached for tablespaces when something else was correct:

- **You created a tablespace per database.** Tablespaces are cluster-wide; per-database isolation is what `CREATE DATABASE` is for.
- **You created a tablespace to "organize" objects.** Schemas do that.
- **You created a tablespace on a single underlying volume (no actual second device).** Then you bought zero performance and added backup-tool config burden.

## Syntax / Mechanics

### Built-in tablespaces

Every cluster starts with two:

| Tablespace | Location | Purpose | Can drop? |
|---|---|---|---|
| `pg_default` | `$PGDATA/base` | Default for new objects in every database unless overridden | No |
| `pg_global` | `$PGDATA/global` | Shared system catalogs (`pg_authid`, `pg_database`, `pg_tablespace`, etc.) | No |

Verbatim from the docs: *"`pg_global`, used for shared system catalogs. `pg_default`, the default tablespace of the `template1` and `template0` databases (and therefore the default for other databases as well, unless overridden)."*[^manage-ag]

### CREATE TABLESPACE

Full grammar:

    CREATE TABLESPACE tablespace_name
        [ OWNER { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER } ]
        LOCATION 'directory'
        [ WITH ( tablespace_option = value [, ... ] ) ]

Operational rules (all verbatim from the docs):

- *"Only superusers can create tablespaces."*[^create-tablespace]
- *"Superusers can assign ownership to non-superusers."*
- *"The directory must exist (`CREATE TABLESPACE` will not create it)."*
- *"The directory should be empty."*
- *"The directory must be owned by the PostgreSQL system user."*
- *"The directory must be specified by an absolute path name."*
- *"`CREATE TABLESPACE` cannot be executed inside a transaction block."*

The location should be **on permanent storage**. The docs warn: *"The location must not be on removable or transient storage, as the cluster might fail to function if the tablespace is missing or lost."*[^create-tablespace]

> [!NOTE] PostgreSQL 16
> PG16 fixed a long-standing bug where `pg_basebackup` mishandled tablespaces whose location was nested inside `$PGDATA` itself. Verbatim from the PG16 release notes: *"Fix `pg_basebackup` to handle tablespaces stored in the `PGDATA` directory (Robert Haas)."*[^pg16-basebackup] You should not put tablespace locations inside `$PGDATA` regardless — it confuses backup tools, replication, and pg_upgrade — but the PG16 fix at least makes one common misconfiguration recoverable.

### ALTER TABLESPACE

Two grammars:

    ALTER TABLESPACE name RENAME TO new_name
    ALTER TABLESPACE name OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
    ALTER TABLESPACE name SET ( tablespace_option = value [, ... ] )
    ALTER TABLESPACE name RESET ( tablespace_option [, ... ] )

`ALTER TABLESPACE` does *not* let you change the filesystem location of an existing tablespace. To move a tablespace, you must:

1. Stop the cluster (or evacuate all its contents).
2. Move the directory on disk.
3. Recreate the symlink in `$PGDATA/pg_tblspc/<oid>` to point at the new location.
4. Restart.

The catalog records the location in `pg_tablespace.spcoptions` and the on-disk symlink, but there is no `ALTER TABLESPACE ... LOCATION` clause. Practical operators evacuate via `ALTER TABLE ... SET TABLESPACE pg_default` and drop the tablespace rather than try to relocate.

### DROP TABLESPACE

Preconditions (verbatim):

- *"Tablespace must be empty of all database objects before it can be dropped."*[^drop-tablespace]
- *"Only the tablespace owner or a superuser can drop a tablespace."*
- *"`DROP TABLESPACE` cannot be executed inside a transaction block."*

To find what is still in a tablespace, see Recipe 5 below.

### Placing objects in a tablespace

Three mechanisms, each with different scope:

1. **Cluster-wide default** — set `default_tablespace` in `postgresql.conf` (rarely correct).

2. **Per-database default** — `CREATE DATABASE app TABLESPACE = fast_nvme;` sets the default for objects created in that database when no explicit tablespace is given.

3. **Per-object** — `CREATE TABLE ... TABLESPACE fast_nvme`, `CREATE INDEX ... TABLESPACE indexes_ssd`, `CREATE TABLE ... PARTITION OF parent TABLESPACE archive_hdd` (the canonical use case for cold-partition placement).

### Moving existing objects

    ALTER TABLE my_table SET TABLESPACE fast_nvme;
    ALTER INDEX my_index SET TABLESPACE indexes_ssd;
    ALTER DATABASE app SET TABLESPACE archive_hdd;

These operations *physically copy* the files to the new location. They:

- Take `ACCESS EXCLUSIVE` on the table (for `ALTER TABLE SET TABLESPACE`) for the entire copy duration.
- Block all reads and writes against the object.
- Generate WAL proportional to the object size.
- Cannot be combined with `CONCURRENTLY` — there is no `ALTER TABLE SET TABLESPACE CONCURRENTLY` clause.

> [!NOTE] PostgreSQL 14
> PG14 added the `TABLESPACE` clause to `REINDEX`, allowing the rebuilt index to land on a different tablespace from the original. Verbatim from PG14 release notes: *"Allow `REINDEX` to change the tablespace of the new index (Alexey Kondratov, Michael Paquier, Justin Pryzby). This is done by specifying a `TABLESPACE` clause. A `--tablespace` option was also added to `reindexdb` to control this."*[^pg14-reindex-tbl] This makes online index rebuilds onto faster storage possible via `REINDEX CONCURRENTLY ... TABLESPACE`.

> [!NOTE] PostgreSQL 15
> PG15 made `pg_upgrade` preserve tablespace and database OIDs, simplifying upgrade workflows that rely on stable filesystem layouts. Verbatim: *"Make `pg_upgrade` preserve tablespace and database OIDs, as well as relation relfilenode numbers (Shruthi Gowda, Antonin Houska)."*[^pg15-pg_upgrade]

> [!NOTE] PostgreSQL 18
> PG18 added a `file_copy_method` GUC that controls whether `CREATE DATABASE ... STRATEGY=FILE_COPY` and `ALTER DATABASE ... SET TABLESPACE` uses traditional file copy or filesystem clone (CoW snapshot on supported filesystems). Verbatim from the PG18 release notes: *"This controls whether `CREATE DATABASE ... STRATEGY=FILE_COPY` and `ALTER DATABASE ... SET TABLESPACE` uses file copy or clone."*[^pg18-file_copy_method] On filesystems that support reflink/clone (XFS with `reflink=1`, Btrfs, ZFS), this dramatically reduces the cost of database-level tablespace moves.

### Per-tablespace planner options

Each tablespace can override four planner cost / I/O concurrency GUCs that would otherwise inherit from cluster-wide values:[^create-tablespace]

| Option | Default | What it overrides |
|---|---|---|
| `seq_page_cost` | `1.0` | Cost of a sequential page fetch (cluster-wide `seq_page_cost`) |
| `random_page_cost` | `4.0` | Cost of a random page fetch (cluster-wide `random_page_cost`) |
| `effective_io_concurrency` | (cluster value) | Number of concurrent disk I/O operations PostgreSQL expects to be able to execute |
| `maintenance_io_concurrency` | (cluster value) | Same, but for maintenance ops (autovacuum, ANALYZE prefetch) |

The point of per-tablespace overrides is that if you have NVMe + spinning rust in the same cluster, you want the planner to know `random_page_cost` should be ~1.1 for the NVMe and ~4.0 (default) for the spinning rust. Without per-tablespace overrides, you would have to pick a global value that is wrong for one of the two.

Set them with:

    ALTER TABLESPACE fast_nvme SET (random_page_cost = 1.1, effective_io_concurrency = 200);
    ALTER TABLESPACE archive_hdd SET (random_page_cost = 6.0, effective_io_concurrency = 1);

See [59-planner-tuning.md](./59-planner-tuning.md) for the cluster-wide cost-GUC discussion.

### Configuration GUCs

Two session/role-scoped GUCs control default placement:

| GUC | Context | What it does |
|---|---|---|
| `default_tablespace` | user | The tablespace that `CREATE TABLE`/`CREATE INDEX` uses when no explicit `TABLESPACE` clause is given. Empty string means "use the database's default tablespace." |
| `temp_tablespaces` | user | Comma-separated list of tablespaces where temp tables, sorts, hashes, and other on-disk spillage will land. Round-robin allocation between the listed tablespaces. |

Verbatim on `default_tablespace`: *"The value is either the name of a tablespace, or an empty string to specify using the default tablespace of the current database."*[^runtime-config-client]

Verbatim on `temp_tablespaces` round-robin behavior: *"When there is more than one name in the list, PostgreSQL chooses a random member of the list each time a temporary object is to be created; except that within a transaction, successively created temporary objects are placed in successive tablespaces from the list."*[^runtime-config-client]

The per-transaction successive-tablespace rule lets you spread a single complex query's many temp files across multiple devices predictably.

### On-disk directory structure

A tablespace location is a directory that, after first use, contains a subdirectory named `PG_<major>_<catalog_version>` (for example `PG_16_202307071`). Inside that, each database that has any object in this tablespace gets a subdirectory named after the database's OID, and inside that one file per relation forknumber:

    /mnt/nvme/pgdata/                            <-- tablespace LOCATION
    +-- PG_16_202307071/                         <-- major + catalog version (cluster-wide)
        +-- 16384/                               <-- database OID
        |   +-- 24576                            <-- relfilenode (heap)
        |   +-- 24576_fsm                        <-- free space map
        |   +-- 24576_vm                         <-- visibility map
        |   +-- 24576_init                       <-- init fork (unlogged tables)
        +-- 16385/                               <-- different database OID
            +-- ...

The version-numbered subdirectory is the reason a single tablespace location can be reused across major version upgrades using `pg_upgrade` with `--link` (the new cluster writes a new `PG_<newmajor>_*` directory alongside the old one).[^manage-ag] In `$PGDATA/pg_tblspc/<spcoid>` you will find a symlink to the tablespace's external location; this is the only on-disk record of the tablespace's path.

### Tablespace permissions

The `spcacl` column of `pg_tablespace` controls who can put objects in the tablespace:

    GRANT  CREATE ON TABLESPACE fast_nvme TO appdev_team;
    REVOKE CREATE ON TABLESPACE fast_nvme FROM PUBLIC;

Without `CREATE` privilege on a tablespace, a non-superuser cannot create objects there even if they have `CREATE` on the schema. The tablespace owner always has implicit `CREATE`. Privileges are inspectable via `\dp+` in psql or directly:

    SELECT spcname,
           pg_catalog.array_to_string(spcacl, E'\n') AS access_privileges
    FROM   pg_tablespace
    ORDER  BY spcname;

Verbatim from the CREATE TABLESPACE docs: *"Superusers can assign ownership to non-superusers"*[^create-tablespace] — meaning the typical pattern is a superuser creates the tablespace, then `ALTER TABLESPACE ... OWNER TO appdev_team_owner` to delegate, without needing to keep superuser involvement in routine grants.

### pg_tablespace_location() and pg_tablespace_size()

Two introspection functions worth knowing:

| Function | Returns | Notes |
|---|---|---|
| `pg_tablespace_location(oid)` | text | The actual filesystem path. Returns `''` for `pg_default` and `pg_global` (their locations are implicit in `$PGDATA`). |
| `pg_tablespace_size(name_or_oid)` | bigint | Total disk space used by the tablespace in bytes. Wraps `pg_total_relation_size` across every object placed there. |

These are the canonical "what is this tablespace doing?" diagnostics. Example:

    SELECT t.spcname,
           pg_tablespace_location(t.oid)                    AS location,
           pg_size_pretty(pg_tablespace_size(t.oid))        AS size
    FROM   pg_tablespace t
    ORDER  BY pg_tablespace_size(t.oid) DESC;

### pg_tablespace catalog

Four columns, all useful:[^pg-tablespace]

| Column | Type | Description |
|---|---|---|
| `oid` | `oid` | Row identifier (used in pg_tblspc symlinks and pg_class.reltablespace) |
| `spcname` | `name` | Tablespace name |
| `spcowner` | `oid` | Owner of the tablespace |
| `spcacl` | `aclitem[]` | Access privileges (`CREATE` privilege per role) |
| `spcoptions` | `text[]` | Tablespace-level options as `keyword=value` strings |

To inspect what's in a tablespace, join `pg_class.reltablespace` to `pg_tablespace.oid` — but **note that `pg_class.reltablespace = 0` means "use the database's default tablespace,"** not "no tablespace." See Recipe 5.

## Per-version Timeline

| Version | Tablespace-relevant changes |
|---|---|
| PG14 | `REINDEX ... TABLESPACE` clause added; `reindexdb --tablespace` added.[^pg14-reindex-tbl] |
| PG15 | `pg_upgrade` preserves tablespace and database OIDs across upgrade.[^pg15-pg_upgrade] Windows fix for concurrent `DROP DATABASE` / `DROP TABLESPACE` / `ALTER DATABASE SET TABLESPACE`.[^pg15-windows-fix] |
| PG16 | `pg_basebackup` now correctly handles tablespaces nested under `$PGDATA`.[^pg16-basebackup] |
| PG17 | **No tablespace-related release-note items.** |
| PG18 | `file_copy_method` GUC added controlling `CREATE DATABASE ... STRATEGY=FILE_COPY` and `ALTER DATABASE ... SET TABLESPACE` clone-vs-copy behavior.[^pg18-file_copy_method] |

## Examples / Recipes

### Recipe 1: Create a tablespace on a dedicated NVMe and place a hot table there

As a Unix shell user (typically `postgres`):

    sudo mkdir -p /mnt/nvme/pgdata
    sudo chown postgres:postgres /mnt/nvme/pgdata
    sudo chmod 0700 /mnt/nvme/pgdata

Then in psql as a superuser:

    CREATE TABLESPACE fast_nvme LOCATION '/mnt/nvme/pgdata';
    ALTER TABLESPACE fast_nvme SET (random_page_cost = 1.1, effective_io_concurrency = 200);

    CREATE TABLE hot_events (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        payload     jsonb NOT NULL
    ) TABLESPACE fast_nvme;

The `ALTER TABLESPACE ... SET` calls tell the planner "this tablespace is SSD-class" — without it, the cluster-wide cost constants apply.

### Recipe 2: Place cold time-range partitions on cheaper storage

    CREATE TABLESPACE archive_hdd LOCATION '/mnt/hdd-archive/pgdata';
    ALTER TABLESPACE archive_hdd SET (random_page_cost = 6.0, effective_io_concurrency = 1);

    CREATE TABLE events_2024_q4
        PARTITION OF events
        FOR VALUES FROM ('2024-10-01') TO ('2025-01-01')
        TABLESPACE archive_hdd;

This is the canonical legitimate use of tablespaces: tiered storage by partition. The hot quarter stays on the SSD-class default; old quarters move to slower bulk storage. See [35-partitioning.md](./35-partitioning.md) for partition mechanics.

### Recipe 3: Direct sort/hash spills to a dedicated device

Cluster-wide:

    -- postgresql.conf
    temp_tablespaces = 'temp_ssd_1, temp_ssd_2'

Or per-role:

    ALTER ROLE reporter SET temp_tablespaces = 'temp_ssd_1, temp_ssd_2';

This is the pattern when a single device is being slammed by `work_mem` overflows during analytic queries. Two devices in the list spread the I/O. See [54-memory-tuning.md](./54-memory-tuning.md) for `work_mem` discussion.

### Recipe 4: Move an existing table to a new tablespace during maintenance

    -- Plan a maintenance window; this takes ACCESS EXCLUSIVE.
    SET lock_timeout = '5s';
    BEGIN;
        ALTER TABLE big_table SET TABLESPACE fast_nvme;
    COMMIT;

Or do it online with `pg_repack` (see [26-index-maintenance.md](./26-index-maintenance.md)) if blocking the table for the copy duration isn't tolerable.

### Recipe 5: Audit what's in each tablespace

    SELECT
        t.spcname                                         AS tablespace,
        n.nspname                                         AS schema,
        c.relname                                         AS object,
        c.relkind,
        pg_size_pretty(pg_relation_size(c.oid))           AS size
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_tablespace t
              ON t.oid = CASE WHEN c.reltablespace = 0
                              THEN (SELECT dattablespace
                                    FROM   pg_database
                                    WHERE  datname = current_database())
                              ELSE c.reltablespace
                         END
    WHERE  c.relkind IN ('r', 'i', 'm', 't', 'p', 'I')
       AND t.spcname <> 'pg_default'        -- exclude the boring rows
    ORDER  BY t.spcname, pg_relation_size(c.oid) DESC;

The `CASE` handles the `reltablespace = 0` "use the database's default tablespace" semantics correctly.

### Recipe 6: Find what is still preventing `DROP TABLESPACE`

    SELECT
        n.nspname || '.' || c.relname  AS object,
        c.relkind,
        pg_size_pretty(pg_relation_size(c.oid)) AS size
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.reltablespace = (SELECT oid FROM pg_tablespace WHERE spcname = 'old_archive_hdd');

You must move every listed object out before the `DROP TABLESPACE` will succeed:

    ALTER TABLE foo SET TABLESPACE pg_default;
    ALTER INDEX bar SET TABLESPACE pg_default;
    ...
    DROP TABLESPACE old_archive_hdd;

### Recipe 7: PG14+ online index rebuild onto a different tablespace

    REINDEX (CONCURRENTLY) INDEX idx_orders_user_id TABLESPACE fast_nvme;

Pre-PG14 this required `CREATE INDEX CONCURRENTLY ... ON ... TABLESPACE`, then `DROP INDEX CONCURRENTLY` on the old, then rename. PG14 collapsed this into one operation.

### Recipe 8: Per-tablespace planner cost audit

    SELECT
        t.spcname,
        opt.keyword,
        opt.value
    FROM   pg_tablespace t
    LEFT   JOIN LATERAL (
        SELECT split_part(o, '=', 1) AS keyword,
               split_part(o, '=', 2) AS value
        FROM   unnest(t.spcoptions) AS o
    ) opt ON true
    ORDER  BY t.spcname, opt.keyword;

If a tablespace has no rows in `spcoptions` (NULL), it inherits the cluster-wide `seq_page_cost` / `random_page_cost` / `effective_io_concurrency` / `maintenance_io_concurrency` — which is almost always wrong if the tablespace is on different-class storage.

### Recipe 9: Move a database's default tablespace

    -- All non-shared, non-pg_global objects in this DB move physically.
    ALTER DATABASE app SET TABLESPACE fast_nvme;

This operation takes `ACCESS EXCLUSIVE` on the database — no sessions can be connected. The cluster must be able to write into the target tablespace. On PG18+ with `file_copy_method = clone` and a CoW filesystem, this can be near-instant; otherwise it physically rewrites every file in every relation in the database.

### Recipe 10: Detect tablespace location inside `$PGDATA`

    SELECT spcname,
           pg_tablespace_location(oid) AS location
    FROM   pg_tablespace
    WHERE  pg_tablespace_location(oid) LIKE '/var/lib/postgresql/%/main/%'  -- or your PGDATA pattern
        OR pg_tablespace_location(oid) = '';

Locations inside `$PGDATA` should be cleared up — they confuse pg_basebackup (fixed but not advisable), pg_upgrade, and tablespace-aware backup tools.

### Recipe 11: PG14+ reindexdb with tablespace migration

    reindexdb --concurrently --tablespace=fast_nvme --table=large_table app

Useful during storage migrations or after a tablespace was added.

### Recipe 12: Grant a non-superuser CREATE on a tablespace

A common managed-environment-style pattern: a superuser creates the tablespace, then delegates day-to-day creation rights to the application's owner role without giving them superuser:

    -- one-time setup by a superuser
    CREATE TABLESPACE app_fast LOCATION '/mnt/nvme/pgdata';
    ALTER  TABLESPACE app_fast OWNER TO app_owner;
    GRANT  CREATE ON TABLESPACE app_fast TO app_owner;

    -- app_owner can now do this without needing superuser
    SET ROLE app_owner;
    CREATE TABLE app.hot (id bigint PRIMARY KEY) TABLESPACE app_fast;

If you want application code to create temp objects in a tablespace, give the application role `CREATE` plus set `temp_tablespaces` on that role:

    GRANT CREATE ON TABLESPACE app_fast TO app_user;
    ALTER ROLE   app_user SET temp_tablespaces = 'app_fast';

### Recipe 13: pg_basebackup with tablespace remapping

When taking a base backup of a cluster that uses non-default tablespaces, the base backup will fail (or restore to the same path as the source) unless you remap:

    pg_basebackup \
        --pgdata=/var/lib/pgsql/16/restore \
        --tablespace-mapping=/mnt/nvme/pgdata=/var/lib/pgsql/16/tblspc_fast_nvme \
        --tablespace-mapping=/mnt/hdd-archive/pgdata=/var/lib/pgsql/16/tblspc_archive_hdd \
        --wal-method=stream \
        --checkpoint=fast \
        --progress

Each tablespace's source-side path must be remapped to a target-side path that already exists and is writable by the postgres user. See [84-backup-physical-pitr.md](./84-backup-physical-pitr.md) for the full base-backup walkthrough; this recipe is just the per-tablespace concern.

### Recipe 14: Find tablespaces with no objects (can be dropped)

    SELECT t.spcname,
           pg_tablespace_location(t.oid)             AS location,
           pg_size_pretty(pg_tablespace_size(t.oid)) AS size
    FROM   pg_tablespace t
    WHERE  t.spcname NOT IN ('pg_default', 'pg_global')
       AND NOT EXISTS (
           SELECT 1 FROM pg_class c WHERE c.reltablespace = t.oid
       )
       AND NOT EXISTS (
           SELECT 1 FROM pg_database d WHERE d.dattablespace = t.oid
       );

Catches both standalone leftover tablespaces (no `pg_class.reltablespace` rows) AND tablespaces that are still set as a database default (which would prevent `DROP TABLESPACE`).

## Gotchas / Anti-patterns

1. **Tablespaces are not filegroups.** Repeated because this is the single most common misconception (especially from SQL Server). A tablespace is just a directory pointer. It does not group objects logically; that is what schemas are for.

2. **You cannot create a tablespace per database.** Tablespace names are cluster-wide. The same tablespace can hold objects from many databases. Per-database isolation is achieved via separate databases (or separate clusters).

3. **The location must exist before `CREATE TABLESPACE`.** PG will not create the directory. Verbatim: *"The directory must exist (`CREATE TABLESPACE` will not create it)."*[^create-tablespace]

4. **The location must be owned by the PostgreSQL OS user.** If you create the directory as root and forget to `chown postgres:postgres`, `CREATE TABLESPACE` fails.

5. **The location must be on permanent storage.** Verbatim: *"The location must not be on removable or transient storage, as the cluster might fail to function if the tablespace is missing or lost."*[^create-tablespace] If the storage disappears, the cluster may refuse to start.

6. **`pg_default` and `pg_global` cannot be dropped.** They are required by initdb.

7. **`pg_class.reltablespace = 0` does not mean "no tablespace."** It means "use the database's default tablespace." Always join through `pg_database.dattablespace` to find the actual location, or use the `CASE` pattern in Recipe 5.

8. **`ALTER TABLE ... SET TABLESPACE` is not concurrent.** It takes `ACCESS EXCLUSIVE` for the full copy duration. There is no `CONCURRENTLY` variant. For large tables, this is a maintenance-window operation or a `pg_repack`-style online migration.

9. **`CREATE TABLESPACE` and `DROP TABLESPACE` cannot run in transaction blocks.** Verbatim from the docs.[^create-tablespace] This means migration frameworks must be configured to disable wrapping these in a transaction (Rails' `disable_ddl_transaction!`, Alembic's `transactional_ddl: False`).

10. **You cannot change a tablespace's location with `ALTER TABLESPACE`.** There is no `ALTER TABLESPACE name LOCATION` clause. To relocate, you must evacuate (ALTER ... SET TABLESPACE), drop, and recreate — or stop the cluster and move on disk.

11. **Backup tools require explicit per-tablespace configuration.** `pg_basebackup`'s `--tablespace-mapping` rewrites paths; pgBackRest's `tablespace-map` does the same in `pgbackrest.conf`; Barman handles it via `tablespace_bandwidth_limit` and per-tablespace knobs. If you forget, restored clusters may fail to start or land tablespaces in unexpected locations. See [84-backup-physical-pitr.md](./84-backup-physical-pitr.md).

12. **Tablespace symlinks live in `$PGDATA/pg_tblspc/<oid>`.** If you copy `$PGDATA` to a new host without also copying the tablespace directories *and* recreating the symlinks, the new cluster will not start.

13. **Tablespaces complicate pg_upgrade.** Both the old and new clusters must have matching tablespace OIDs (PG15+ preserves these automatically). On PG14 and earlier, you may need to manually map tablespaces during upgrade.

14. **Per-tablespace `random_page_cost` only matters if you actually set it.** A fresh tablespace inherits the cluster-wide default. The whole point of having a separate tablespace on NVMe is to set `random_page_cost = 1.1` on it.

15. **`temp_tablespaces` round-robin is per-transaction.** Within one transaction, successive temp objects go to successive tablespaces in the list — not random. Between transactions, the choice is random. Sustained read-heavy analytic workloads should set multiple tablespaces here for I/O parallelism.

16. **`default_tablespace = ''` is not the same as `default_tablespace = 'pg_default'`.** The empty string means "use the database's default" (which may differ from `pg_default` if the database was created with `CREATE DATABASE ... TABLESPACE`); the literal `'pg_default'` always means `pg_default`. Use the empty-string form in postgresql.conf to preserve per-database defaults.

17. **Logical replication does not replicate tablespace placement.** A subscriber receives row contents only; the subscriber's tables live wherever the subscriber side chose to put them. See [74-logical-replication.md](./74-logical-replication.md).

18. **Physical streaming replication does replicate tablespace placement** — by replicating the file paths. If primary has `/mnt/nvme/pgdata`, the standby must have the same path available (or use `--tablespace-mapping` at `pg_basebackup` time).

19. **`spcacl` controls who can `CREATE` in the tablespace.** Granting `CREATE` on a tablespace lets non-superusers create objects there. Without it, only superusers and the tablespace owner can.

20. **The four per-tablespace options are the only spcoptions defined.** Verbatim from the docs: only `seq_page_cost`, `random_page_cost`, `effective_io_concurrency`, `maintenance_io_concurrency`.[^create-tablespace] Don't try `work_mem` or `wal_compression` here.

21. **PG17 had zero tablespace-relevant release-note items.** If a tutorial claims PG17 improved tablespaces, verify against the release notes directly.

22. **PG18 `file_copy_method` defaults to `copy`, not `clone`.** You must explicitly set `file_copy_method = clone` to get the CoW snapshot behavior, and the underlying filesystem must support it.

23. **A tablespace on a slower device with no per-tablespace planner overrides is worse than no tablespace at all.** The planner still costs queries with cluster-wide constants but executes against slower storage, so estimates and reality diverge sharply. Always set the four per-tablespace options when the storage class differs.

24. **`pg_default` location is `''` (empty string) from `pg_tablespace_location`, not `$PGDATA/base`.** The same is true for `pg_global`. The empty string means "implicit in $PGDATA." Tools that audit "are any tablespaces on this volume" must handle this case — see Recipe 5's `CASE` pattern.

25. **Dropping a tablespace that's still set as a database's default fails silently in the audit query.** A tablespace can be empty of `pg_class` references but still be the `dattablespace` of some database (perhaps an empty one), in which case `DROP TABLESPACE` raises an error pointing at the database — not at any individual object. Recipe 14 catches this case explicitly.

26. **CHECK before creating a tablespace: does the underlying storage have working `fsync` semantics?** PostgreSQL relies on `fsync` to deliver durability promises. Network filesystems (NFS, SMB) and certain virtualized storage stacks have historically lied about flush completion. If you put a tablespace on such storage and the cluster crashes, recovery can fail. See [33-wal.md](./33-wal.md) gotcha on `fsync` and the verbatim docs warning.

27. **Filesystems with thin provisioning or compression interact with tablespace sizing oddly.** `pg_tablespace_size()` reports what PostgreSQL believes the files occupy, not what the filesystem stores. ZFS-compressed, Btrfs-deduplicated, or thin-provisioned volumes may show 4× the reported size as "available" or 0.5× as "used" — diagnose at the filesystem layer, not via SQL alone.

28. **Most managed Postgres providers disable user-created tablespaces entirely.** AWS RDS, Cloud SQL, Azure Database for PostgreSQL, and others typically expose a single managed storage volume and do not permit `CREATE TABLESPACE`. The decision-matrix rows in this file assume self-hosted or cluster-operator-managed Postgres; see [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md).

## Operational Checklist

Before creating a tablespace in a self-hosted cluster, work through this list:

1. **Is the underlying storage permanent and `fsync`-honest?** Reject removable media, network filesystems with weak flush semantics, and thin-provisioned volumes where the storage can disappear underneath the cluster.[^create-tablespace]
2. **Does the directory exist, owned by the postgres OS user, with `0700` permissions, and empty?** Verify with `ls -ld` before running `CREATE TABLESPACE`.
3. **Is the location outside `$PGDATA`?** Even though PG16+ no longer breaks `pg_basebackup` when the location is inside `$PGDATA`,[^pg16-basebackup] there is no operational benefit to placing it there and several historical bugs that locations-inside-PGDATA used to trip.
4. **Will the path be the same on every standby and every potential restore target?** Physical streaming replication replicates the tablespace path; if the standby cannot create a directory at `/mnt/nvme/pgdata`, replication will fail. Plan paths cluster-wide.
5. **Does your backup tooling know about the new tablespace?** pgBackRest, Barman, WAL-G all require explicit configuration to pick up additional tablespaces. Add the tablespace to backup configs *before* you place any data in it.
6. **Will you set per-tablespace planner overrides?** If the tablespace is on different-class storage from the cluster default, set `seq_page_cost`, `random_page_cost`, `effective_io_concurrency`, and `maintenance_io_concurrency` immediately after creation.
7. **Who owns it, who can `CREATE` in it?** Don't leave it owned by `postgres` superuser if application roles will be placing objects there; `ALTER TABLESPACE ... OWNER TO app_owner` and `GRANT CREATE ON TABLESPACE` per role.
8. **Did you document it?** A tablespace is invisible from the docs side; teams that inherit clusters often discover them only by inspecting `pg_tablespace`. Add it to your runbook with the location, the purpose, and the recovery plan if the underlying storage is lost.

When removing a tablespace:

1. **Find every object referencing it** via Recipe 6.
2. **Move every object out** to `pg_default` or another tablespace.
3. **Check `pg_database.dattablespace`** — if any database has this tablespace as its default, `ALTER DATABASE ... SET TABLESPACE pg_default` first.
4. **Run Recipe 14** — verify zero remaining references.
5. **Outside a transaction block, `DROP TABLESPACE`.**
6. **Remove the symlink in `$PGDATA/pg_tblspc/`** if it doesn't get cleaned up automatically (it should).
7. **Update backup configs** to remove the tablespace's per-instance settings.
8. **Optionally remove the on-disk directory** — `DROP TABLESPACE` does not delete the directory itself, only the catalog entry and symlink.

## Managed Environments

Self-hosted PostgreSQL and operator-managed Kubernetes Postgres (CloudNativePG, Patroni-on-VMs, etc.) give you full tablespace control. **Most managed PostgreSQL services do not.**

- **Hosted database-as-a-service providers** typically expose a single managed volume and either silently reject `CREATE TABLESPACE` or allow only a `pg_default`-equivalent. Even when `CREATE TABLESPACE` is technically allowed, the underlying storage is opaque to you — there is no "second device" to direct I/O at.
- **Containerized Postgres** (Docker, plain Kubernetes pods, ECS) does allow tablespaces if you mount additional PersistentVolumes, but the volume lifecycle becomes a separate concern from the cluster: lose the PVC for a tablespace mount and the cluster will fail to start. See [91-docker-postgres.md](./91-docker-postgres.md) and [92-kubernetes-operators.md](./92-kubernetes-operators.md).
- **Patroni + CloudNativePG-style operators** typically support tablespaces only when each member of the cluster can mount the same paths; some operators expose first-class `tablespaces:` configuration to manage this declaratively.

If your deployment target is uncertain or may move between self-hosted and managed in the future, design your schema *without* tablespaces. The performance benefit of tablespace placement on a single-volume host is zero, and the portability cost of `CREATE TABLESPACE` is non-trivial.

## See Also

- [01-syntax-ddl.md](./01-syntax-ddl.md) — CREATE TABLE TABLESPACE clause
- [26-index-maintenance.md](./26-index-maintenance.md) — pg_repack online table relocation; REINDEX CONCURRENTLY TABLESPACE
- [33-wal.md](./33-wal.md) — moving tablespaces generates WAL
- [35-partitioning.md](./35-partitioning.md) — canonical use case: cold partitions on cheap storage
- [43-locking.md](./43-locking.md) — ALTER TABLE SET TABLESPACE takes ACCESS EXCLUSIVE
- [46-roles-privileges.md](./46-roles-privileges.md) — CREATE on tablespace grants
- [54-memory-tuning.md](./54-memory-tuning.md) — work_mem and temp_tablespaces spillage
- [59-planner-tuning.md](./59-planner-tuning.md) — per-tablespace cost-GUC overrides
- [64-system-catalogs.md](./64-system-catalogs.md) — pg_tablespace, pg_class.reltablespace, pg_database.dattablespace joins
- [73-streaming-replication.md](./73-streaming-replication.md) — physical replication requires matching tablespace paths or remap
- [74-logical-replication.md](./74-logical-replication.md) — logical replication does not preserve tablespace placement
- [84-backup-physical-pitr.md](./84-backup-physical-pitr.md) — pg_basebackup --tablespace-mapping
- [85-backup-tools.md](./85-backup-tools.md) — pgBackRest, Barman, WAL-G tablespace configuration
- [86-pg-upgrade.md](./86-pg-upgrade.md) — pg_upgrade and tablespace OID preservation (PG15+)
- [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md) — most managed Postgres providers disable user-created tablespaces
- [91-docker-postgres.md](./91-docker-postgres.md) — tablespace PVC lifecycle in containerized Postgres
- [92-kubernetes-operators.md](./92-kubernetes-operators.md) — operator-managed tablespace configuration

## Sources

[^manage-ag]: PostgreSQL 16 documentation, "Tablespaces". https://www.postgresql.org/docs/16/manage-ag-tablespaces.html — verbatim: *"Tablespaces allow database administrators to define locations in the file system where the files representing database objects can be stored."* Also: *"`pg_global`, used for shared system catalogs. `pg_default`, the default tablespace of the `template1` and `template0` databases (and therefore the default for other databases as well, unless overridden)."*

[^manage-ag-backup]: PostgreSQL 16 documentation, "Tablespaces". https://www.postgresql.org/docs/16/manage-ag-tablespaces.html — verbatim: *"Even though located outside the main PostgreSQL data directory, tablespaces are an integral part of the database cluster and cannot be treated as an autonomous collection of data files. They are dependent on metadata contained in the main data directory, and therefore cannot be attached to a different database cluster or backed up individually."*

[^create-tablespace]: PostgreSQL 16 documentation, "CREATE TABLESPACE". https://www.postgresql.org/docs/16/sql-createtablespace.html — covers the four per-tablespace options (seq_page_cost, random_page_cost, effective_io_concurrency, maintenance_io_concurrency), the must-exist-must-be-empty-must-be-owned-by-postgres rules for the location, the absolute-path requirement, the not-in-transaction-block rule, and the *"The location must not be on removable or transient storage"* warning.

[^drop-tablespace]: PostgreSQL 16 documentation, "DROP TABLESPACE". https://www.postgresql.org/docs/16/sql-droptablespace.html — verbatim: *"A tablespace can only be dropped by its owner or a superuser. The tablespace must be empty of all database objects before it can be dropped."*

[^alter-tablespace-lock]: PostgreSQL 16 documentation, "ALTER TABLE". https://www.postgresql.org/docs/16/sql-altertable.html — the `SET TABLESPACE` form requires `ACCESS EXCLUSIVE` on the target table.

[^runtime-config-client]: PostgreSQL 16 documentation, "Client Connection Defaults". https://www.postgresql.org/docs/16/runtime-config-client.html — verbatim on `default_tablespace`: *"The value is either the name of a tablespace, or an empty string to specify using the default tablespace of the current database."* Verbatim on `temp_tablespaces` round-robin: *"When there is more than one name in the list, PostgreSQL chooses a random member of the list each time a temporary object is to be created; except that within a transaction, successively created temporary objects are placed in successive tablespaces from the list."*

[^pg-tablespace]: PostgreSQL 16 documentation, "pg_tablespace". https://www.postgresql.org/docs/16/catalog-pg-tablespace.html — catalog columns: `oid`, `spcname`, `spcowner`, `spcacl`, `spcoptions`.

[^pg14-reindex-tbl]: PostgreSQL 14.0 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: *"Allow REINDEX to change the tablespace of the new index (Alexey Kondratov, Michael Paquier, Justin Pryzby). This is done by specifying a TABLESPACE clause. A --tablespace option was also added to reindexdb to control this."*

[^pg15-pg_upgrade]: PostgreSQL 15.0 release notes. https://www.postgresql.org/docs/release/15.0/ — verbatim: *"Make pg_upgrade preserve tablespace and database OIDs, as well as relation relfilenode numbers (Shruthi Gowda, Antonin Houska)."*

[^pg15-windows-fix]: PostgreSQL 15.0 release notes. https://www.postgresql.org/docs/release/15.0/ — verbatim: *"Prevent DROP DATABASE, DROP TABLESPACE, and ALTER DATABASE SET TABLESPACE from occasionally failing during concurrent use on Windows (Thomas Munro)."*

[^pg16-basebackup]: PostgreSQL 16.0 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: *"Fix pg_basebackup to handle tablespaces stored in the PGDATA directory (Robert Haas)."*

[^pg18-file_copy_method]: PostgreSQL 18.0 release notes. https://www.postgresql.org/docs/release/18.0/ — added `file_copy_method` GUC. Verbatim: *"This controls whether CREATE DATABASE ... STRATEGY=FILE_COPY and ALTER DATABASE ... SET TABLESPACE uses file copy or clone."*

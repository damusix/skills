# Extensions

> [!WARNING] Extensions are versioned bundles, not loose scripts
> `CREATE EXTENSION` is NOT `\i some-file.sql`. It tracks owned objects in `pg_extension`, runs version-update scripts on `ALTER EXTENSION ... UPDATE`, and `pg_dump` re-emits a single `CREATE EXTENSION` line instead of every object. **Manually-created functions/types claimed to be "part of" an extension are silently omitted from `pg_dump` output and lost at upgrade/restore time.** Always package as a real extension (`.control` + versioned `.sql`) if you want lifecycle management — even for internal-only code.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [`CREATE EXTENSION`](#create-extension)
    - [`ALTER EXTENSION`](#alter-extension)
    - [`DROP EXTENSION`](#drop-extension)
    - [`.control` file format](#control-file-format)
    - [Trusted extensions (PG13+)](#trusted-extensions-pg13)
    - [Schema placement + relocation](#schema-placement--relocation)
    - [Version updates](#version-updates)
    - [Introspection catalog + views](#introspection-catalog--views)
    - [PG18 `extension_control_path`](#pg18-extension_control_path)
- [Contrib Extension Inventory](#contrib-extension-inventory)
- [Common Third-Party Extensions](#common-third-party-extensions)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file for:

- Installing/upgrading/removing extensions (`CREATE`/`ALTER`/`DROP EXTENSION`)
- Choosing schema for extension installation
- Understanding trusted-extension model (who can install)
- Auditing installed-vs-available extensions
- Writing your own extension `.control` file
- Inventory of in-core (contrib) and widely-deployed third-party extensions
- Diagnosing "why won't `pg_dump` restore my custom objects" (the answer is usually "they weren't packaged as an extension")

Do NOT use this file for per-extension deep dives — those live in dedicated files:

- pgcrypto → [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md)
- pgaudit → [`51-pgaudit.md`](./51-pgaudit.md)
- pg_stat_statements → [`57-pg-stat-statements.md`](./57-pg-stat-statements.md)
- pg_trgm → [`93-pg-trgm.md`](./93-pg-trgm.md)
- pgvector → [`94-pgvector.md`](./94-pgvector.md)
- PostGIS → [`95-postgis.md`](./95-postgis.md)
- TimescaleDB → [`96-timescaledb.md`](./96-timescaledb.md)
- Citus → [`97-citus.md`](./97-citus.md)
- pg_cron → [`98-pg-cron.md`](./98-pg-cron.md)
- pg_partman → [`99-pg-partman.md`](./99-pg-partman.md)
- Writing C extensions → [`72-extension-development.md`](./72-extension-development.md)

## Mental Model

Five rules drive every extension decision.

**Rule 1 — Extensions are SQL + C bundles installed via `CREATE EXTENSION`.** Each extension has a `<name>.control` file plus one or more versioned SQL scripts (`<name>--<version>.sql`) and optionally a shared library (`<name>.so` / `.dll` / `.dylib`). PostgreSQL discovers control files in `$(pg_config --sharedir)/extension/` (PG≤17) or any path on `extension_control_path` (PG18+). Library files live in `$(pg_config --pkglibdir)/`.

**Rule 2 — `pg_extension` catalog tracks installed extensions and versions.** `pg_extension` rows hold name, owner, schema, version, configuration-table list. `pg_dump` emits a single `CREATE EXTENSION` line per row; it does NOT dump objects owned by the extension. **The implication: any object you create manually inside an extension's schema is NOT part of the extension and WILL be dumped separately.** To make an object part of the extension, use `ALTER EXTENSION ... ADD object` (or declare it in the install script).

**Rule 3 — `pg_available_extensions` lists what could be installed; `pg_available_extension_versions` lists every version.** These views read the on-disk control files; they show what `CREATE EXTENSION` would find, not what's installed. Cross-reference [Introspection catalog + views](#introspection-catalog--views).

**Rule 4 — Trusted extensions (PG13+) can be installed by non-superusers.** When `trusted = true` in the control file, any role with `CREATE` privilege on the target database can run `CREATE EXTENSION`. The install script runs as the bootstrap superuser, not the calling role — so trusted extensions can still create operators, types, etc. Untrusted extensions require superuser. **Most managed environments restrict installable extensions to a provider-curated allowlist regardless of the trusted flag** ([`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md)).

**Rule 5 — Each extension lives in one schema by default but most can be relocated via `ALTER EXTENSION ... SET SCHEMA`.** Schema fixed at `CREATE EXTENSION` time via `SCHEMA <name>` clause or control-file `schema = ...` (the latter is non-overridable). Relocatable extensions (`relocatable = true`) can be moved later; non-relocatable cannot. PG16 added `no_relocate` clause to require referenced extensions stay put.

## Decision Matrix

| Need | Use | Avoid |
|---|---|---|
| Install an extension | `CREATE EXTENSION foo` | `\i path/to/foo.sql` (loses lifecycle tracking) |
| Install with dependencies | `CREATE EXTENSION foo CASCADE` | Installing each prereq manually (gets ordering wrong) |
| Install into specific schema | `CREATE EXTENSION foo WITH SCHEMA myschema` | Installing then renaming the schema later (may fail if non-relocatable) |
| Install specific version | `CREATE EXTENSION foo VERSION '1.2'` | Installing default then manually downgrading |
| Idempotent install (migrations) | `CREATE EXTENSION IF NOT EXISTS foo` | `CREATE EXTENSION foo` in scripts that re-run |
| Upgrade extension version | `ALTER EXTENSION foo UPDATE` | Drop+recreate (loses configuration data) |
| Move extension schema | `ALTER EXTENSION foo SET SCHEMA newschema` | Manually moving objects one-by-one |
| Remove extension | `DROP EXTENSION foo` | Dropping individual objects (leaves pg_extension row) |
| Remove extension + dependents | `DROP EXTENSION foo CASCADE` | Trying RESTRICT first then panicking |
| Audit installed vs available | `pg_available_extensions` view | Reading filesystem directly |
| Find extension owning an object | `\dx+ <ext>` or `pg_depend` join | Guessing from schema name |
| Install as non-superuser | `trusted = true` extensions only (PG13+) | Trying to install untrusted as regular role |
| Bundle internal code as extension | `.control` + versioned `.sql` + `ALTER EXTENSION ADD` | Plain `\i` scripts in deployment |

**Three smell signals you're using extensions wrong:**

1. **Custom helper functions disappear after `pg_dump | pg_restore`** — they weren't tracked by `pg_extension`. Either add via `ALTER EXTENSION ... ADD FUNCTION` or skip the extension wrapper entirely.
2. **`CREATE EXTENSION` fails with "permission denied"** on a hosted/managed cluster — provider's allowlist excludes it. Verify with `SELECT * FROM pg_available_extensions WHERE name='foo'` first.
3. **Multiple databases need the same extension but you ran `CREATE EXTENSION` only in `postgres`** — extension installation is per-database, not cluster-wide. Install into each database.

## Syntax / Mechanics

### `CREATE EXTENSION`

```sql
CREATE EXTENSION [ IF NOT EXISTS ] extension_name
    [ WITH ] [ SCHEMA schema_name ]
             [ VERSION version ]
             [ CASCADE ]
```

Behavior:

- Reads `<extension_name>.control` from share directory (or `extension_control_path` PG18+)
- Creates a `pg_extension` row with extension OID
- Runs install script `<extension_name>--<version>.sql` as the bootstrap superuser (regardless of caller)
- Records every object created during script run as owned by the extension (via `pg_depend` rows with `deptype = 'e'`)
- `CASCADE` automatically installs prerequisite extensions listed in `requires = ...`
- `IF NOT EXISTS` makes it a no-op when already installed (compare versions manually)

**Privilege rule:** Superuser OR (PG13+) `trusted = true` AND caller has `CREATE` on the target database. The script runs as the bootstrap superuser either way.

> [!WARNING] `CREATE EXTENSION` is per-database, not cluster-wide
> Installing into the `postgres` database does NOT make the extension available in `app_db`. Install into each database that needs the extension. Globally-loaded shared libraries (via `shared_preload_libraries`) are loaded once cluster-wide, but the SQL surface (functions, types, views) requires `CREATE EXTENSION` per database.

### `ALTER EXTENSION`

Three subcommands matter:

```sql
ALTER EXTENSION name UPDATE [ TO new_version ];
ALTER EXTENSION name SET SCHEMA new_schema;
ALTER EXTENSION name ADD object_specifier;
ALTER EXTENSION name DROP object_specifier;
```

`UPDATE` semantics:

- If `TO new_version` omitted, updates to the `default_version` named in the control file
- Runs a chain of update scripts (`name--from_version--to_version.sql`) — the system finds a path from current to target
- If no path exists, errors. Add the missing intermediate scripts to the share directory.

`SET SCHEMA` semantics:

- Only legal if `relocatable = true` in the control file
- Moves every object owned by the extension into `new_schema`
- Requires `CREATE` on the destination schema

`ADD` / `DROP` semantics:

- `ADD` claims an existing object as part of the extension (`pg_depend` row inserted with `deptype = 'e'`)
- `DROP` removes the ownership relationship (object survives; extension no longer dumps/drops it)

> [!NOTE] PostgreSQL 16
> *"Allow the schemas of required extensions to be referenced in extension scripts using the new syntax `@extschema:referenced_extension_name@` (Regina Obe)"*[^pg16-extschema] — install script can reference a prereq extension's schema by name. Lets a child extension refer to its parent's schema without hardcoding.

> [!NOTE] PostgreSQL 16
> *"Allow required extensions to be marked as non-relocatable using `no_relocate` (Regina Obe). This allows `@extschema:referenced_extension_name@` to be treated as a constant for the lifetime of the extension."*[^pg16-norelocate]

### `DROP EXTENSION`

```sql
DROP EXTENSION [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]
```

- `RESTRICT` (default): fails if anything outside the extension depends on its objects
- `CASCADE`: drops dependents (tables, functions, views built on extension types)

> [!WARNING] `CASCADE` drops user data
> If you have a table with a `vector(384)` column from `pgvector`, `DROP EXTENSION pgvector CASCADE` will drop the table. Always `DROP EXTENSION ... RESTRICT` first; resolve dependencies explicitly; then drop without CASCADE.

### `.control` file format

The `<name>.control` file lives in the share directory. Plain text, key=value:

| Parameter | Required | Default | Meaning |
|---|---|---|---|
| `default_version` | yes | — | Version installed if `VERSION` omitted in `CREATE EXTENSION` |
| `comment` | no | none | Description (applied only at creation, not at update) |
| `encoding` | no | UTF-8 | Encoding of the SQL script files |
| `module_pathname` | no | none | Path substituted for `MODULE_PATHNAME` in scripts (typically `$libdir/<name>`) |
| `requires` | no | none | Comma-separated prereq extensions (e.g., `requires = 'cube, earthdistance'`) |
| `superuser` | no | `true` | If true, only superusers can install/update |
| `trusted` | no | `false` | PG13+ — if true, `CREATE` on database is sufficient |
| `relocatable` | no | `false` | If true, schema can change after creation |
| `schema` | no | none | Force install into this specific schema (non-overridable) |
| `directory` | no | (share dir) | Directory containing SQL scripts |
| `no_relocate` | no | none | PG16+ — list of required extensions that cannot change schema |

> [!WARNING] `superuser = false` + `trusted = false` is meaningless
> Either makes installation work for the caller. `trusted = true` lets non-superusers install; `superuser = false` only matters if `trusted` is also `false` (and is unusual outside legacy contexts). For modern extensions: `trusted = true` is the right choice when safe.

### Trusted extensions (PG13+)

> [!NOTE] PostgreSQL 13
> *"Allow extensions to be specified as trusted (Tom Lane). Such extensions can be installed in a database by users with database-level `CREATE` privileges, even if they are not superusers. This change also removes the `pg_pltemplate` system catalog."*[^pg13-trusted]

Mechanism:

- Control file has `trusted = true`
- Role with `CREATE` on the target database can run `CREATE EXTENSION`
- Install script runs as the bootstrap superuser — so it can create operators, types, language handlers
- Calling role becomes the extension's owner (`pg_extension.extowner`)

In-core extensions marked trusted in PG16:

- `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`, `lo`, `ltree`, `pg_trgm`, `pgcrypto`, `plperl`, `plpgsql` (always trusted), `pltcl`, `seg`, `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent`, `uuid-ossp`

In-core extensions NOT trusted (require superuser):

- `adminpack` (removed in PG17), `amcheck`, `auth_delay`, `auto_explain`, `basic_archive`, `bloom`, `dblink`, `file_fdw`, `pageinspect`, `passwordcheck`, `pg_buffercache`, `pg_freespacemap`, `pg_prewarm`, `pgrowlocks`, `pg_stat_statements`, `pgstattuple`, `pg_surgery`, `pg_visibility`, `pg_walinspect`, `plperlu`, `plpython3u`, `pltclu`, `postgres_fdw`, `sepgsql`, `sslinfo`, `test_decoding`, `xml2`

> [!WARNING] Trusted flag is a security-policy declaration, not safety guarantee
> The extension author asserts the extension is safe for non-superusers. If the extension has a privilege-escalation bug, every database with `CREATE` privilege granted to PUBLIC becomes vulnerable. **Audit trusted extensions in your cluster** before granting `CREATE` on databases:
>
> ```sql
> SELECT name, default_version, installed_version, trusted, superuser
>   FROM pg_available_extension_versions
>  WHERE installed_version IS NOT NULL;
> ```

### Schema placement + relocation

Three states:

| Control-file `schema = ...` | Control-file `relocatable` | Behavior |
|---|---|---|
| Set | (ignored) | Forced into named schema; `CREATE EXTENSION ... WITH SCHEMA other` fails unless `other` matches |
| Unset | `true` | Installs into `search_path[0]` (or `WITH SCHEMA ...`); `ALTER EXTENSION ... SET SCHEMA newsch` works |
| Unset | `false` | Installs into `search_path[0]` (or `WITH SCHEMA ...`); cannot be relocated later |

Examples of fixed-schema extensions: `pgcrypto` (no fixed schema; relocatable), `postgis` (fixed: `public` by convention but configurable), `timescaledb` (fixed in some versions).

Most contrib extensions are relocatable. Inspect with:

```sql
SELECT name, relocatable, schema FROM pg_available_extensions
 WHERE installed_version IS NOT NULL;
```

### Version updates

```sql
ALTER EXTENSION foo UPDATE;            -- to control file's default_version
ALTER EXTENSION foo UPDATE TO '1.3';   -- specific version
```

The update mechanism finds a path through chained scripts:

- Install script: `foo--1.0.sql` (initial install at version 1.0)
- Update scripts: `foo--1.0--1.1.sql`, `foo--1.1--1.2.sql`, `foo--1.2--1.3.sql`
- `ALTER EXTENSION foo UPDATE TO '1.3'` runs `1.0→1.1`, `1.1→1.2`, `1.2→1.3` in order

Direct-jump scripts allowed: `foo--1.0--1.3.sql` takes priority if present. The system picks the cheapest path.

> [!NOTE] PostgreSQL 14
> *"Allow pg_dump to dump the contents of extension-owned tables when the extension is dumped"* — `extconfig` configuration tables get dumped along with the extension. Use `pg_extension_config_dump(table_name, 'WHERE clause')` inside the install script to mark tables as configuration data.

### Introspection catalog + views

| Surface | Purpose |
|---|---|
| `pg_extension` catalog | One row per installed extension. Columns: `oid`, `extname`, `extowner`, `extnamespace`, `extrelocatable`, `extversion`, `extconfig` (oid[] of configuration tables), `extcondition` (text[] of WHERE filters for those tables) |
| `pg_available_extensions` view | One row per extension found on disk. Columns: `name`, `default_version`, `installed_version` (NULL if not installed), `comment` |
| `pg_available_extension_versions` view | One row per (name, version) found on disk. Columns: `name`, `version`, `installed` (bool), `superuser` (bool), `trusted` (bool), `relocatable` (bool), `schema` (name; NULL if relocatable), `requires` (name[]), `comment` |
| `pg_depend` table | Tracks which objects belong to which extension. Rows with `deptype = 'e'` link `classid+objid` to `refclassid=pg_extension.oid+refobjid=extension.oid` |
| `psql \dx` | Lists installed extensions (one line each: name, version, schema, description) |
| `psql \dx+` | `\dx` plus list of every object owned by each extension |

> [!NOTE] PostgreSQL 18
> *"Add `default_version` to the psql `\dx` extension output (Magnus Hagander)"*[^pg18-dx]. PG≤17 `\dx` shows only installed version; PG18+ shows both installed and default-on-disk side-by-side, surfacing pending upgrades.

Inspect objects owned by an extension:

```sql
SELECT d.classid::regclass    AS catalog,
       d.objid,
       CASE d.classid
         WHEN 'pg_proc'::regclass THEN (SELECT proname FROM pg_proc WHERE oid = d.objid)
         WHEN 'pg_class'::regclass THEN (SELECT relname FROM pg_class WHERE oid = d.objid)
         WHEN 'pg_type'::regclass THEN (SELECT typname FROM pg_type WHERE oid = d.objid)
         WHEN 'pg_operator'::regclass THEN (SELECT oprname FROM pg_operator WHERE oid = d.objid)
       END AS object_name
  FROM pg_depend d
 WHERE d.refclassid = 'pg_extension'::regclass
   AND d.refobjid = (SELECT oid FROM pg_extension WHERE extname = 'pgcrypto')
   AND d.deptype = 'e'
 ORDER BY d.classid::regclass::text, object_name;
```

### PG18 `extension_control_path`

> [!NOTE] PostgreSQL 18
> *"Add server variable `extension_control_path` to specify the location of extension control files (Peter Eisentraut, Matheus Alcantara)"*[^pg18-extpath].

Pre-PG18: control files only loaded from `$(pg_config --sharedir)/extension/`. To install an extension from a custom location, you had to copy the `.control` and `.sql` files into that directory.

PG18+: `extension_control_path` GUC (default `$system`) accepts a colon-separated list of directories. PostgreSQL searches in order:

```ini
# postgresql.conf
extension_control_path = '$system:/opt/myextensions/share:/home/postgres/dev-extensions'
```

`$system` resolves to the default share directory. Useful for:

- Development workflows (install dev versions without `sudo`)
- Multi-tenant clusters with per-tenant extensions
- Distroless / read-only base-image deployments (mount extensions into a writable path)

> [!NOTE] PostgreSQL 18
> *"Add macro `PG_MODULE_MAGIC_EXT` to allow extensions to report their name and version (Andrei Lepikhov). This information can be accessed via the new function `pg_get_loaded_modules()`."*[^pg18-modulemagic]. Diagnostic for "which extension shared libraries are loaded in this backend right now"; complements `pg_extension` (catalog state) with runtime-loaded-library state.

## Contrib Extension Inventory

PG16 ships 50 contrib extensions. The `--contrib` package on most distributions includes all of them. Each is installable via `CREATE EXTENSION <name>`.

| Extension | Category | Trusted | Purpose |
|---|---|---|---|
| `adminpack` | Admin | No | (Removed in PG17) Server-file management |
| `amcheck` | Diagnostic | No | B-tree + heap index sanity checks ([`26-index-maintenance.md`](./26-index-maintenance.md)) |
| `auth_delay` | Security | No | Delay failed authentication responses |
| `auto_explain` | Diagnostic | No | Auto-log EXPLAIN plans for slow queries ([`56-explain.md`](./56-explain.md)) |
| `basebackup_to_shell` | Backup | No | pg_basebackup shell-target module |
| `basic_archive` | WAL | No | Example archive_library implementation ([`33-wal.md`](./33-wal.md)) |
| `bloom` | Index | No | Bloom filter index access method ([`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md)) |
| `btree_gin` | Index | Yes | B-tree-equivalent operators in GIN indexes ([`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)) |
| `btree_gist` | Index | Yes | B-tree-equivalent operators in GiST indexes ([`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)) |
| `citext` | Type | Yes | Case-insensitive text type ([`14-data-types-builtin.md`](./14-data-types-builtin.md)) |
| `cube` | Type | Yes | Multidimensional cube type with GiST support |
| `dblink` | FDW | No | Cross-database query connections (legacy; prefer postgres_fdw) ([`70-fdw.md`](./70-fdw.md)) |
| `dict_int` | FTS | Yes | Integer dictionary for full-text search |
| `dict_xsyn` | FTS | Yes | Extended-synonym dictionary |
| `earthdistance` | Geo | Yes | Great-circle distance on Earth (cube-based) |
| `file_fdw` | FDW | No | Foreign data wrapper for flat files ([`70-fdw.md`](./70-fdw.md)) |
| `fuzzystrmatch` | Text | Yes | Soundex / Levenshtein / Metaphone |
| `hstore` | Type | Yes | Legacy key-value store ([`21-hstore.md`](./21-hstore.md) — prefer JSONB) |
| `intagg` | Aggregate | Yes | Integer aggregator (legacy) |
| `intarray` | Type | Yes | Integer array operators + GiST index support |
| `isn` | Type | Yes | ISBN/ISSN/EAN13/UPC types |
| `lo` | Type | Yes | Large object cleanup trigger ([`71-large-objects.md`](./71-large-objects.md)) |
| `ltree` | Type | Yes | Tree/path types with GiST support |
| `old_snapshot` | Diagnostic | No | Old-snapshot diagnostics (PG≤16 only; PG17 removed `old_snapshot_threshold`) |
| `pageinspect` | Diagnostic | No | Inspect raw page contents (B-tree, GIN, heap, etc.) |
| `passwordcheck` | Security | No | Password-strength check hook |
| `pg_buffercache` | Diagnostic | No | Inspect shared buffer pool ([`32-buffer-manager.md`](./32-buffer-manager.md)) |
| `pgcrypto` | Crypto | Yes | Symmetric/PGP encryption, hashing, random ([`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md)) |
| `pg_freespacemap` | Diagnostic | No | Inspect free-space map |
| `pg_prewarm` | Performance | No | Warm shared_buffers from previous state |
| `pgrowlocks` | Diagnostic | No | Per-row lock inspection ([`43-locking.md`](./43-locking.md)) |
| `pg_stat_statements` | Monitoring | No | Aggregate query statistics ([`57-pg-stat-statements.md`](./57-pg-stat-statements.md)) |
| `pgstattuple` | Diagnostic | No | Tuple-level bloat statistics ([`26-index-maintenance.md`](./26-index-maintenance.md)) |
| `pg_surgery` | Recovery | No | Emergency tuple-visibility surgery ([`88-corruption-recovery.md`](./88-corruption-recovery.md)) |
| `pg_trgm` | Index | Yes | Trigram similarity + index support ([`93-pg-trgm.md`](./93-pg-trgm.md)) |
| `pg_visibility` | Diagnostic | No | Visibility map inspection |
| `pg_walinspect` | Diagnostic | No | PG15+ — inspect WAL records in SQL ([`33-wal.md`](./33-wal.md)) |
| `postgres_fdw` | FDW | No | Foreign data wrapper for other PostgreSQL servers ([`70-fdw.md`](./70-fdw.md)) |
| `seg` | Type | Yes | Number-range type with GiST support |
| `sepgsql` | Security | No | SELinux label-based mandatory access control |
| `spi` | Examples | No | Sample SPI module triggers |
| `sslinfo` | Security | No | Information about current SSL connection |
| `tablefunc` | Function | Yes | crosstab / connectby / normal_rand |
| `tcn` | Trigger | Yes | Triggered change notifications ([`45-listen-notify.md`](./45-listen-notify.md)) |
| `test_decoding` | Replication | No | Output plugin for logical decoding testing ([`76-logical-decoding.md`](./76-logical-decoding.md)) |
| `tsm_system_rows` | Sampling | Yes | TABLESAMPLE method counting rows |
| `tsm_system_time` | Sampling | Yes | TABLESAMPLE method bounded by time |
| `unaccent` | FTS | Yes | Strip accents from text (FTS dictionary) ([`20-text-search.md`](./20-text-search.md)) |
| `uuid-ossp` | Type | Yes | Legacy UUID-generation functions ([`18-uuid-numeric-money.md`](./18-uuid-numeric-money.md) — prefer core `gen_random_uuid()`) |
| `xml2` | XML | No | Deprecated XML functions (xpath_table); use built-in XML support |

## Common Third-Party Extensions

Not in core. Each maintained independently. Verify version-to-PG-major compatibility before installing — most lag by 1-2 majors.

| Extension | Home | Use case |
|---|---|---|
| pgvector | <https://github.com/pgvector/pgvector> | Vector embeddings, similarity search (HNSW + IVFFLAT). See [`94-pgvector.md`](./94-pgvector.md) |
| PostGIS | <https://postgis.net/> | Geospatial types, GiST/SP-GiST indexes, raster, geocoding. See [`95-postgis.md`](./95-postgis.md) |
| TimescaleDB | <https://www.tigerdata.com/docs/> | Time-series hypertables, continuous aggregates, compression (TSL/Apache2 split). See [`96-timescaledb.md`](./96-timescaledb.md) |
| Citus | <https://www.citusdata.com/> | Distributed PostgreSQL (sharding, columnar). See [`97-citus.md`](./97-citus.md) |
| pg_cron | <https://github.com/citusdata/pg_cron> | In-database cron scheduler. See [`98-pg-cron.md`](./98-pg-cron.md) |
| pg_partman | <https://github.com/pgpartman/pg_partman> | Automated partition lifecycle. See [`99-pg-partman.md`](./99-pg-partman.md) |
| pg_repack | <https://github.com/reorg/pg_repack> | Online table+index bloat removal. See [`26-index-maintenance.md`](./26-index-maintenance.md) |
| pg_squeeze | <https://github.com/cybertec-postgresql/pg_squeeze> | Logical-decoding-based online table compaction |
| pgaudit | <https://github.com/pgaudit/pgaudit> | Detailed session/object audit logging. See [`51-pgaudit.md`](./51-pgaudit.md) |
| pg_hint_plan | <https://github.com/ossc-db/pg_hint_plan> | Optimizer hints via SQL comments |
| pgrouting | <https://pgrouting.org/> | Geospatial routing built on PostGIS |
| TimescaleDB Toolkit | <https://github.com/timescale/timescaledb-toolkit> | Advanced analytics functions (percentile_agg, asap, etc.) |
| pg_jsonschema | <https://github.com/supabase/pg_jsonschema> | JSON Schema validation for JSONB columns |
| plv8 | <https://github.com/plv8/plv8> | JavaScript stored procedures via V8 |

> [!WARNING] Third-party extension version pinning
> Each third-party extension supports a specific range of PostgreSQL majors. Pinning policy:
> - Always check the extension's `META.json`, `Cargo.toml`, or `Makefile` for supported PG versions
> - `pg_upgrade` does NOT upgrade third-party extensions — you must rebuild/reinstall the extension for the new major
> - Pre-upgrade audit: `SELECT extname, extversion FROM pg_extension WHERE extname NOT IN ('plpgsql');` then verify each is available for the target PG major

## Per-Version Timeline

| PG | Extension-mechanism changes |
|---|---|
| 13 | **Trusted extensions** introduced (verbatim release-note quote in mental model rule 4). `pg_pltemplate` system catalog removed. |
| 14 | `pg_dump` extension filtering improvements. `compute_query_id` moved from `pg_stat_statements` to core (changes `pg_stat_statements` behavior). |
| 15 | Custom WAL resource managers can be defined by extensions. Custom backup-target modules (like `basebackup_to_shell`). `custom_scan_methods` extended for projection support. Disallow setting custom GUCs whose name matches an extension's name. |
| 16 | **Symbol visibility:** *"Prevent extension libraries from exporting their symbols by default (Andres Freund, Tom Lane). Functions that need to be called from the core backend or other extensions must now be explicitly marked `PGDLLEXPORT`."*[^pg16-symbol] **`@extschema:name@` syntax** in install scripts to reference dependency schema. **`no_relocate`** clause. |
| 17 | `adminpack` removed (verbatim "Remove the long-deprecated `adminpack` contrib module"). `ALTER OPERATOR` accepts more optimization attributes for extensions. Extensions can define custom wait events. `pg_dump --exclude-extension`. |
| 18 | **`extension_control_path` GUC** (verbatim quote in [PG18 `extension_control_path`](#pg18-extension_control_path)). **`default_version` in `\dx` output**. **`PG_MODULE_MAGIC_EXT`** macro and `pg_get_loaded_modules()` function. |

## Examples / Recipes

### Recipe 1 — Install extension cluster-wide

A single `CREATE EXTENSION` runs in one database. To install across every existing database in the cluster:

```bash
# Shell loop — adapt for your role/connection
for db in $(psql -At -c "SELECT datname FROM pg_database WHERE datistemplate = false"); do
    psql -d "$db" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
done
```

For new databases, install into `template1` so future `CREATE DATABASE` inherits:

```sql
\c template1
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\c postgres
CREATE DATABASE newapp;  -- inherits pgcrypto
```

### Recipe 2 — Inventory installed extensions across cluster

```sql
-- Per-database extension audit
SELECT current_database() AS database,
       extname,
       extversion,
       (SELECT default_version FROM pg_available_extensions WHERE name = extname) AS latest_available
  FROM pg_extension
 WHERE extname != 'plpgsql'  -- always present, not interesting
 ORDER BY extname;
```

Cluster-wide via shell:

```bash
for db in $(psql -At -c "SELECT datname FROM pg_database WHERE datistemplate = false"); do
    psql -d "$db" -At -c "
        SELECT '$db' || ':' || extname || ':' || extversion
          FROM pg_extension
         WHERE extname != 'plpgsql'"
done | sort
```

### Recipe 3 — Find extensions with pending upgrades

```sql
SELECT e.extname,
       e.extversion       AS installed,
       a.default_version  AS available
  FROM pg_extension e
  JOIN pg_available_extensions a ON a.name = e.extname
 WHERE e.extversion <> a.default_version
 ORDER BY e.extname;
```

On PG18+ `\dx` shows this side-by-side; pre-PG18 use the query above.

### Recipe 4 — Upgrade with explicit version pin (production)

```sql
BEGIN;
-- Verify current state
SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
-- Upgrade to specific version
ALTER EXTENSION pg_stat_statements UPDATE TO '1.11';
-- Verify
SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
COMMIT;
```

Pinning the target version prevents accidental jumps when multiple intermediate versions are available.

### Recipe 5 — Move extension to non-default schema

```sql
-- Pre-flight: confirm it's relocatable
SELECT relocatable FROM pg_available_extensions WHERE name = 'pgcrypto';

-- Create destination
CREATE SCHEMA crypto AUTHORIZATION app_owner;

-- Move
ALTER EXTENSION pgcrypto SET SCHEMA crypto;

-- Adjust search_path for callers
ALTER ROLE app_user SET search_path = app_schema, crypto, public;
```

> [!WARNING] Don't drop `public` schema usage halfway through migration
> If applications hardcode `SELECT digest(...)` without schema qualification AND their `search_path` doesn't include the new schema, the call fails after `SET SCHEMA`. Migrate `search_path` (per-role or per-application) BEFORE moving the extension.

### Recipe 6 — Install with prerequisite dependencies

```sql
-- earthdistance requires cube; CASCADE installs cube first
CREATE EXTENSION earthdistance CASCADE;
-- Equivalent to:
--   CREATE EXTENSION cube;
--   CREATE EXTENSION earthdistance;
```

`pg_available_extension_versions.requires` lists prereqs. Without `CASCADE`, missing prereqs cause an error naming the missing extension.

### Recipe 7 — Convert manual SQL bundle into a real extension

Goal: take a directory of helper functions deployed via `\i bundle.sql` and turn them into a real extension `mycorp_utils` so `pg_dump` round-trips them as a single `CREATE EXTENSION mycorp_utils;` line.

Step 1: Create `mycorp_utils.control` in the share dir (`$(pg_config --sharedir)/extension/`):

```ini
default_version = '1.0'
comment = 'Internal helper functions for MyCorp'
relocatable = true
trusted = true
```

Step 2: Move existing SQL into `mycorp_utils--1.0.sql` in the same dir:

```sql
-- mycorp_utils--1.0.sql
CREATE OR REPLACE FUNCTION mycorp_normalize_email(input text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
AS $$ SELECT lower(trim(input)) $$;

-- ... more functions ...
```

Step 3: In each target database, drop the manually-created versions and install the extension:

```sql
DROP FUNCTION IF EXISTS mycorp_normalize_email(text);
CREATE EXTENSION mycorp_utils;
```

Step 4: Verify with `pg_dump --schema-only` and confirm `CREATE EXTENSION mycorp_utils;` appears (and the individual function CREATEs do not).

Future updates ship as `mycorp_utils--1.0--1.1.sql` and roll out via `ALTER EXTENSION mycorp_utils UPDATE`.

### Recipe 8 — Use `pg_extension_config_dump` for configuration tables

Some extensions ship reference tables that need user-row preservation across `pg_dump | pg_restore`:

```sql
-- Inside the install script
CREATE TABLE mycorp_config (
    key   text PRIMARY KEY,
    value text NOT NULL
);
SELECT pg_extension_config_dump('mycorp_config', '');  -- '' = dump all rows
-- Or with a filter:
-- SELECT pg_extension_config_dump('mycorp_config', 'WHERE key NOT LIKE ''ephemeral_%''');
```

After this, `pg_dump` emits the table's data inline; without it, the table is recreated empty (since it belongs to the extension).

### Recipe 9 — Audit which objects belong to which extension

```sql
-- All objects owned by pg_stat_statements
SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS object
  FROM pg_depend d
 WHERE d.refclassid = 'pg_extension'::regclass
   AND d.refobjid = (SELECT oid FROM pg_extension WHERE extname = 'pg_stat_statements')
   AND d.deptype = 'e'
 ORDER BY 1;
```

Same as `\dx+ pg_stat_statements`.

### Recipe 10 — Detect orphaned extension shared libraries

```sql
-- PG18+: which .so libraries are loaded in this backend?
SELECT * FROM pg_get_loaded_modules();
```

Pre-PG18 there is no SQL surface; check the OS:

```bash
# What's actually loaded into a running backend
pmap $(pgrep -f "postgres: postgres") | grep '\.so'
```

Useful for diagnosing `shared_preload_libraries` mismatches (library loaded but extension not installed in the current database).

### Recipe 11 — Pre-`pg_upgrade` extension audit

Before running `pg_upgrade`, ensure every third-party extension is available for the target major:

```sql
-- Run in each database against the OLD cluster
SELECT current_database() AS db, extname, extversion
  FROM pg_extension
 WHERE extname NOT IN (
   -- Core extensions; available on every supported PG major
   'plpgsql'
 )
 ORDER BY 1, 2;
```

Then, on the NEW cluster (before running `pg_upgrade`):

```bash
# Verify each extension's binary + control file is installed
for ext in pgcrypto pgaudit pg_stat_statements pgvector; do
    ls -l $(pg_config --sharedir)/extension/$ext.control 2>/dev/null \
        && echo "OK: $ext" \
        || echo "MISSING: $ext"
done
```

> [!WARNING] `pg_upgrade` will fail on a missing extension
> If the old cluster has `extname = 'pgvector' extversion = '0.5.1'` and the new cluster lacks `pgvector.control` entirely, `pg_upgrade --check` flags it. **Install matching-or-newer extension binaries on the new cluster BEFORE upgrade.** See [`86-pg-upgrade.md`](./86-pg-upgrade.md).

### Recipe 12 — Use PG18 `extension_control_path` for development

```ini
# postgresql.conf (PG18+)
extension_control_path = '$system:/home/dev/my-extension/share'
```

```sql
-- Now dev iterations work without sudo
CREATE EXTENSION mycorp_utils;  -- finds /home/dev/my-extension/share/mycorp_utils.control
```

Reload (not restart) picks up the GUC change. Useful for CI pipelines that build extensions in a workspace dir.

### Recipe 13 — Find objects shadowing extension-owned functions

If you've manually created a function with the same signature as an extension function in a different schema, `search_path` resolution may surprise you:

```sql
SELECT n.nspname AS schema,
       p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       d.refobjid IS NOT NULL AS owned_by_extension,
       (SELECT extname FROM pg_extension WHERE oid = d.refobjid) AS extension
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.classid = 'pg_proc'::regclass
                       AND d.objid = p.oid
                       AND d.deptype = 'e'
 WHERE p.proname IN (
     -- Functions you suspect are shadowed; e.g.:
     'digest', 'crypt', 'gen_random_uuid'
 )
 ORDER BY p.proname, n.nspname;
```

## Gotchas / Anti-patterns

1. **Manually-created functions are NOT part of the extension** — they get dumped/restored separately. To claim ownership: `ALTER EXTENSION foo ADD FUNCTION bar(int)`.
2. **`CREATE EXTENSION` is per-database, not cluster-wide** — install into every database that needs the surface, including `template1` for future databases.
3. **`DROP EXTENSION ... CASCADE` drops user tables** that use extension types (e.g., a `vector(384)` column drops the column or table). Always `RESTRICT` first.
4. **`shared_preload_libraries` change requires a restart, not a reload** — adding `pg_stat_statements` to `shared_preload_libraries` then running `pg_reload_conf()` does NOT load the library until the next full restart.
5. **`CREATE EXTENSION pgcrypto` succeeds even without `shared_preload_libraries`** because pgcrypto's functions are dynamically loaded on first call. Other extensions (pg_stat_statements, pgaudit, pg_cron) **require** `shared_preload_libraries` to function correctly even after `CREATE EXTENSION`.
6. **Trusted ≠ safe-for-everyone** — `trusted = true` lets non-superusers install. The extension itself could still expose privilege escalation. Audit which trusted extensions you allow.
7. **Extensions don't automatically upgrade with `pg_upgrade`** — the catalog row carries over, but the binary library must already exist on the new cluster. Verify with `pg_upgrade --check` first.
8. **Third-party extensions lag major-version compatibility** — a fresh PG18 cluster may not have a pgvector build for several weeks/months after PG18 GA. Test extensions on PG-N+1 in staging before upgrading prod.
9. **`requires = 'cube, earthdistance'` is order-independent but ordering matters** for `CASCADE` — the system topologically sorts but a circular `requires` errors out.
10. **`ALTER EXTENSION ... UPDATE` runs in a transaction** — if the update script fails mid-way, the whole update rolls back. But side effects on shared catalogs (rare in extensions) may not roll back cleanly.
11. **Schema-fixed extensions cannot be relocated even with `ALTER EXTENSION ... SET SCHEMA`** — the command errors. To "move" them: drop, recreate with `WITH SCHEMA newsch` (rare and dangerous; data loss if dependent tables exist).
12. **`pg_dump --extension=ext1` only matches by name, not pattern** — multiple extensions need multiple `--extension` flags. Compare with `--exclude-extension` (PG17+).
13. **`old_snapshot` contrib extension is operational on PG≤16 only** — PG17 removed `old_snapshot_threshold` GUC entirely; the extension still ships but its functions return NULL/error.
14. **`adminpack` is removed in PG17** — pgAdmin and other tools that relied on its server-file functions need updating.
15. **Extension owner is set at `CREATE EXTENSION` time** — `ALTER EXTENSION ... OWNER TO newowner` changes the owner but does NOT change ownership of individual objects within the extension. Use `REASSIGN OWNED` separately.
16. **Trusted-extension install runs as bootstrap superuser, not caller** — a function created in the install script with `SECURITY DEFINER` runs as the superuser, NOT the calling role. This is a frequent source of unexpected privilege escalation if you don't review extension install scripts.
17. **`pg_available_extensions` shows files on disk, not what your role can install** — a managed environment may strip the install ability for security even when the file is present. Try `CREATE EXTENSION ... IF NOT EXISTS` and handle the error.
18. **`CREATE EXTENSION foo WITH SCHEMA myschema` is ignored if control file pins `schema = foo`** — actually, it errors with "extension `foo` must be installed in schema `foo`". Read the control file first.
19. **PG18 `extension_control_path` does NOT affect the library search path** — only `.control` files. The shared library (`.so`) must still be in `$libdir` (or `module_pathname` referenced explicitly). For dev workflows you may need to also configure `dynamic_library_path`.
20. **Multiple databases sharing one binary can drift in version** — extension binary is cluster-wide (single `.so`); SQL version is per-database. Across many databases, run `ALTER EXTENSION ... UPDATE` in every one or they accumulate version drift.
21. **`pg_extension.extconfig` is an array of OIDs, not names** — joining requires casting through `pg_class`: `JOIN pg_class c ON c.oid = ANY(extconfig)`.
22. **Cluster-wide allowlists (managed services) supersede `trusted = true`** — providers maintain their own allowlist. `pg_available_extensions` reflects the allowlist on these clusters, not the on-disk reality.
23. **`pg_extension_config_dump('table', '')` must be called inside the install script** — adding it later via SQL does NOT change what `pg_dump` does for that extension's table. Re-create the extension to re-register configuration tables.

## See Also

- [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md) — pgcrypto deep dive
- [`51-pgaudit.md`](./51-pgaudit.md) — pgaudit deep dive
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — pg_stat_statements deep dive
- [`70-fdw.md`](./70-fdw.md) — file_fdw, postgres_fdw, dblink
- [`71-large-objects.md`](./71-large-objects.md) — lo extension + LO API
- [`72-extension-development.md`](./72-extension-development.md) — writing your own C extension
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — pre-upgrade extension audit
- [`93-pg-trgm.md`](./93-pg-trgm.md) — pg_trgm deep dive
- [`94-pgvector.md`](./94-pgvector.md) — pgvector deep dive
- [`95-postgis.md`](./95-postgis.md) — PostGIS deep dive
- [`96-timescaledb.md`](./96-timescaledb.md) — TimescaleDB deep dive
- [`97-citus.md`](./97-citus.md) — Citus deep dive
- [`98-pg-cron.md`](./98-pg-cron.md) — pg_cron deep dive
- [`99-pg-partman.md`](./99-pg-partman.md) — pg_partman deep dive
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries` GUC required by many extensions
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_extension` catalog table and `pg_available_extensions` view
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — extension allowlist constraints in managed environments

## Sources

[^pg13-trusted]: PostgreSQL 13 release notes, "Allow extensions to be specified as trusted (Tom Lane). Such extensions can be installed in a database by users with database-level CREATE privileges, even if they are not superusers. This change also removes the pg_pltemplate system catalog." <https://www.postgresql.org/docs/release/13.0/>

[^pg16-extschema]: PostgreSQL 16 release notes, "Allow the schemas of required extensions to be referenced in extension scripts using the new syntax `@extschema:referenced_extension_name@` (Regina Obe)." <https://www.postgresql.org/docs/release/16.0/>

[^pg16-norelocate]: PostgreSQL 16 release notes, "Allow required extensions to be marked as non-relocatable using `no_relocate` (Regina Obe). This allows `@extschema:referenced_extension_name@` to be treated as a constant for the lifetime of the extension." <https://www.postgresql.org/docs/release/16.0/>

[^pg16-symbol]: PostgreSQL 16 release notes, "Prevent extension libraries from exporting their symbols by default (Andres Freund, Tom Lane). Functions that need to be called from the core backend or other extensions must now be explicitly marked PGDLLEXPORT." <https://www.postgresql.org/docs/release/16.0/>

[^pg18-extpath]: PostgreSQL 18 release notes, "Add server variable extension_control_path to specify the location of extension control files (Peter Eisentraut, Matheus Alcantara)." <https://www.postgresql.org/docs/release/18.0/>

[^pg18-dx]: PostgreSQL 18 release notes, "Add default_version to the psql \dx extension output (Magnus Hagander)." <https://www.postgresql.org/docs/release/18.0/>

[^pg18-modulemagic]: PostgreSQL 18 release notes, "Add macro PG_MODULE_MAGIC_EXT to allow extensions to report their name and version (Andrei Lepikhov). This information can be accessed via the new function pg_get_loaded_modules()." <https://www.postgresql.org/docs/release/18.0/>

- PG16 `CREATE EXTENSION`: <https://www.postgresql.org/docs/16/sql-createextension.html>
- PG16 `ALTER EXTENSION`: <https://www.postgresql.org/docs/16/sql-alterextension.html>
- PG16 `DROP EXTENSION`: <https://www.postgresql.org/docs/16/sql-dropextension.html>
- PG16 Packaging Extensions chapter: <https://www.postgresql.org/docs/16/extend-extensions.html>
- PG16 contrib catalog: <https://www.postgresql.org/docs/16/contrib.html>
- PG16 external projects: <https://www.postgresql.org/docs/16/external-projects.html>
- `pg_extension` catalog: <https://www.postgresql.org/docs/16/catalog-pg-extension.html>
- `pg_available_extensions` view: <https://www.postgresql.org/docs/16/view-pg-available-extensions.html>
- `pg_available_extension_versions` view: <https://www.postgresql.org/docs/16/view-pg-available-extension-versions.html>
- PG17 release notes (adminpack removal, pg_dump --exclude-extension): <https://www.postgresql.org/docs/release/17.0/>
- PG14 release notes: <https://www.postgresql.org/docs/release/14.0/>
- PG15 release notes (custom WAL resource managers): <https://www.postgresql.org/docs/release/15.0/>
- pgvector: <https://github.com/pgvector/pgvector>
- TimescaleDB docs: <https://www.tigerdata.com/docs/>
- Citus: <https://www.citusdata.com/>
- pg_cron: <https://github.com/citusdata/pg_cron>
- pg_partman: <https://github.com/pgpartman/pg_partman>
- pg_repack: <https://github.com/reorg/pg_repack>
- pg_squeeze: <https://github.com/cybertec-postgresql/pg_squeeze>
- pgaudit: <https://github.com/pgaudit/pgaudit>
- PostGIS: <https://postgis.net/>

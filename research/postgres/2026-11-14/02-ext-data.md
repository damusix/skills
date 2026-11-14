# Data extensions: changes since 2026-05-14

Research date: 2026-11-14. All line numbers refer to files under `postgres/references/` in the `postgres-update` worktree. Sources are the projects' own repos (read through `gh api`), their release notes, and postgresql.org docs. PostgreSQL 19 is still at RC2 as of this date (postgresql.org announced "18.7, 17.12, 16.16, 15.20, 14.25, and 19 RC 2" on 2026-11-12; `postgres/postgres` has tags up to `REL_19_RC2` and no `REL_19_0`). "PG19 supported" below therefore means "release or release notes claim it", not "GA".

## Summary table

| Extension | Our version | Upstream latest + date | Changed since 2026-05-14 | PG19 supported |
|---|---|---|---|---|
| pgvector | 0.8.2 (2026-02-25) | 0.8.7 (2026-10-01); 0.9.0 unreleased on master | yes (bug-fix releases 0.8.3-0.8.7; 0.9.0 pending) | unknown: not in any release note. master CI builds against PG 19 and 20 |
| PostGIS | 3.6.3 (2026-04-14) | 3.7.0 (2026-10-29); 3.6.4 (2026-06-08); 3.5.7 tagged | yes (major release, breaking changes) | yes in 3.7.0 ("PostgreSQL 14-19beta3"); 3.6.x is PG 12-18 only |
| TimescaleDB | 2.27.0 (2026-05-12) | 2.32.0 (changelog 2026-11-11, GitHub release 2026-11-12) | yes (5 minor releases) | no: not in any release note. master CI runs PG19 rc1 tests (commit 2026-10-30) |
| Citus | 14.0 (our file says 2026-02-17; CHANGELOG says Feb 9) | 14.3.0 (2026-10-23) | yes (14.0.1, 14.1, 14.2, 14.3) | no in released 14.3.0 (PG 16-18). PG19 support merged on master (#8753, 2026-08-27) |
| pg_cron | 1.6.7 (2025-09-04) | 1.6.8 (2026-09-08) | yes | yes (v1.6.8 "Add PostgreSQL 19 support") |
| pg_partman | 5.4.3 (2026-03-05) | 5.5.0 (2026-07-22) | yes (security release with breaking changes) | unknown: README says "PostgreSQL >= 14"; CI matrix is PG 14-18, no 19 |
| pg_trgm | no version claimed; collation note for PG18 | contrib `default_version = '1.6'` (unchanged); PG19 RC2 release notes; PG 18.7 etc. (2026-11-12) | yes (PG19 notes + a corruption fix in minor releases) | n/a (contrib; ships with PG19 RC2) |

Highest-priority findings:

1. pg_trgm: PG 14.25 / 15.20 / 16.16 / 17.12 / 18.7 (2026-11-12) fix **GiST `gist_trgm_ops` index corruption**; existing indexes need `REINDEX`. Not in our file.
2. pg_partman 5.5.0: security release. Default of `pg_partman_bgw.role` changed to `partman_maintainer`, and retention-schema ownership is now enforced. Not in our file.
3. TimescaleDB: PG15 support was **removed in 2.29.0**, not "June 2026 release". Our file says PG15 is still supported and treats the drop as upcoming.
4. PostGIS 3.7.0 removes `tiger_geocoder` and `address_standardizer` from core, drops PG 12/13 and GEOS < 3.10, removes `ST_MemCollect`.
5. pg_cron: our GUC table has several wrong contexts and misses `cron.match_dom_and_dow` and `cron.enable_superuser_jobs`.

---

## pgvector

Our file: `94-pgvector.md`, "Latest version 0.8.2 (2026-02-25)", footnotes at 742 and 744.

### Findings

**What**: Released after 0.8.2. All five are bug-fix releases with no new SQL objects, GUCs or defaults:

| Version | Date | Changes |
|---|---|---|
| 0.8.3 | 2026-06-17 | Fixed possible index corruption with HNSW vacuuming. Fixed performance regression with Hamming and Jaccard distance on Postgres 18. |
| 0.8.4 | 2026-06-30 | Fixed `hnsw graph not repaired` error during HNSW vacuuming. Fixed possible error with inserts during HNSW vacuuming. Fixed memory exceeding `maintenance_work_mem` in IVFFlat index builds. |
| 0.8.5 | 2026-07-08 | Reduced memory use for small tables in IVFFlat index builds. |
| 0.8.6 | 2026-07-29 | Fixed buffer overflow in IVFFlat index build on 32-bit systems. Fixed array-to-`sparsevec` cast not limiting non-zero elements. Fixed memory usage for IVFFlat index scans with nested-loop joins. |
| 0.8.7 | 2026-10-01 | Fixed buffer overflow with IVFFlat index build (issue #1036). Fixed error with `avg` aggregate when no rows match. |

**Where found**: <https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md> (sections `## 0.8.3 (2026-06-17)` through `## 0.8.7 (2026-10-01)`). Tags `v0.8.3`..`v0.8.7` exist in `gh api repos/pgvector/pgvector/tags`. The repo has no GitHub Releases objects, only tags. README Docker tag list shows `0.8.7-pg18-trixie` etc.
**Affects**: `94-pgvector.md:3` (latest 0.8.2), `:358` (table row "latest at planning time"), `:365`, `:711`, `:742`, `:744`.
**Action**: update. Add rows 0.8.3-0.8.7. Item 0.8.3 (HNSW vacuum corruption) and 0.8.7 / 0.8.6 (IVFFlat buffer overflows) belong in a "run 0.8.7+" note.

**What**: `0.9.0 (unreleased)` on master. Features: asynchronous I/O for indexes (HNSW and IVFFlat; commits say IVFFlat async I/O is "for Postgres 17" and IVFFlat uses pause/resume scans "for Postgres 19"), vacuuming progress reporting for indexes, `vector_dims` for `sparsevec`, faster HNSW inserts with `sparsevec`, better `amvalidate`, basic hypothetical-index support (commit 2026-10-25). Fix: possible error with iterative index scans during HNSW vacuuming. **"Dropped support for Postgres 13 and 14"**.
**Where found**: <https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md> (top section `## 0.9.0 (unreleased)`); commit list at <https://github.com/pgvector/pgvector/commits/master>; `.github/workflows/build.yml` matrix lists Postgres 20, 19, 18, 17, 16, 15 (no 14).
**Affects**: `94-pgvector.md:711` ("0.8.2 supports PG14-PG18"). Our skill covers PG14-18.
**Action**: new short note: 0.9.0 will drop PG14, so PG14 users stay on 0.8.x. Do not document 0.9.0 features as released.

**What**: README still says "supports Postgres 13+" for 0.8.7. README states no PG19 support. Not verified for the released tarball.
**Where found**: <https://github.com/pgvector/pgvector/blob/master/README.md> (installation section).
**Action**: no change beyond the note above.

**What**: Date drift in our timeline: 0.8.1 is dated 2025-09-04 in the CHANGELOG, our table says 2025-08-12. 0.8.1 description "Bug fixes; PG18 compatibility" is accurate ("Added support for Postgres 18 rc1; improved performance of `binary_quantize`"). 0.8.2 also "Improved `install` target on Windows; fixed `Index Searches` in `EXPLAIN` output for Postgres 18".
**Where found**: CHANGELOG sections `## 0.8.1 (2025-09-04)`, `## 0.8.2 (2026-02-25)`.
**Affects**: `94-pgvector.md:357`.
**Action**: update.

---

## PostGIS

Our file: `95-postgis.md`. Claims 3.6.3 latest, "Supports PG 12-18" (line 33, 348, 635).

### Findings

**What**: **PostGIS 3.7.0 released 2026-10-29** (NEWS `PostGIS 3.7.0 / 2026/10/29`; tag `3.7.0` exists). Requirements line: "GEOS 3.10+, PostgreSQL 14-19beta3, Proj 6.1+, and libgmp. To take advantage of all postgis extension features, GEOS 3.15+ is needed. ... SFCGAL 2.3+." Python 3 now needed to build docs.
**Where found**: <https://github.com/postgis/postgis/blob/3.7.0/NEWS> (top section). Our `postgis.net` news page could not be fetched (host unreachable from the research sandbox); NEWS in the project repo is the primary source used.
**Affects**: `95-postgis.md:33`, `:344`, `:348`, `:635`, `:637`.
**Action**: update (new 3.7 row and support matrix).

**What**: 3.7.0 breaking changes:

- Support for **PostgreSQL 12 and 13 removed** (#6024) and **GEOS < 3.10 removed** (#6079). Supported: PG 14-19.
- `tiger_geocoder` extension removed from the tree, moved to <https://git.osgeo.org/postgis/postgis_tiger_geocoder> (#6052). `address_standardizer` removed, moved to <https://github.com/postgis/address_standardizer> (#6053).
- `ST_MemCollect` aggregate removed (#1793).
- Topology building functions: tolerance `0` now really means 0; new default `-1` means "use topology precision" (#5688).
- `ST_GeoHash` round-trips through `ST_GeomFromGeoHash` (#6040).
- `CG_AlphaShape` now returns a MultiPolygon (GH-848).

**Where found**: 3.7.0 NEWS, "Breaking Changes".
**Affects**: `95-postgis.md` (no mention of tiger/address_standardizer today; matrix at 348 says PG 12-18).
**Action**: update. Add a 3.7 breaking-changes note. Cross-check `69-extensions.md` and `87-major-version-upgrade.md` for tiger geocoder references (none found by grep for "tiger" in `69-extensions.md` other than the TimescaleDB vendor name).

**What**: 3.7.0 new functions and features (selection): `ST_IsSimpleDetail`, `ST_CoverageEdges` (MultiLineString of shared coverage edges), `ST_MinimumSpanningTree` (window function), `ST_MMin`/`ST_MMax`, `ST_CatmullSmoothing`, `ST_3DInterpolatePoint`, `ST_XSize`/`ST_YSize`/`ST_ZSize`/`ST_MSize`, single-geometry variants of `ST_MaxDistance` and `ST_LongestLine`, `ST_MakeLine` accepts MultiLineString, `ST_MakePolygon` accepts curved rings, `ST_Multi` for TIN and surfaces, NURBSCurve geometry (`ST_AsX3D` emits `NurbsCurve`), `CG_PolygonRepair`, SFCGAL roof generation algorithms, raster `GDT_Float16` pixel type, `ST_Value` nearest-neighbour boundary options, `ST_DWithin` uses `GEOSPreparedDistance` with caching, `ST_OrderingEquals` can use hash and merge joins, `shp2pgsql` gained `UNLOGGED` tables / long options / `--if-not-exists`, `--with-visual-examples` configure switch for docs. Security fixes include `postgis.enable_outdb_rasters=off` enforcement after upgrade.
**Where found**: 3.7.0 NEWS, "New Features", "Enhancements", "Bug Fixes".
**Affects**: our file has a function catalogue; none of these are listed.
**Action**: new section "PostGIS 3.7 additions" (short list). Optional.

**What**: 3.6.4 (2026-06-08): `ST_Length(geography)` consistency for GeometryCollection (#6076), Flatgeobuf schema-mismatch vulnerability fix, `pg_upgrade` issue for non-standard geography SRID (#5899), `ST_Split` hang on very large ordinates (#5916). 3.6.3 (2026-04-14) was security-relevant: "#6055 Remove rare extension priv escalation case". 3.5.7 tag exists (date not verified).
**Where found**: <https://github.com/postgis/postgis/blob/3.6.4/NEWS>. Tags list `gh api repos/postgis/postgis/git/matching-refs/tags/3.`.
**Affects**: `95-postgis.md:343` ("latest in 3.5 series: 3.5.6 (Apr 2026)"), `:344`.
**Action**: update. 3.5 latest tag is 3.5.7; 3.6 latest is 3.6.4 (3.7.0 is newest).

**What**: Release-date and attribution drift found while reading NEWS (these predate 2026-05-14):

- 3.6.0 released **2025/09/01** (we say 2025-Q4).
- 3.4.0 is 2023/08/15 (we say 2023-09).
- 3.2.0 is 2021/12/17 (we say 2022-02).
- `ST_Letters` appears in the 3.3.0 section of NEWS (we attribute it to 3.2).
- "RelateNG / GEOS 3.13" support appears in the 3.5.0 section (line 502 of master NEWS, inside the 3.5.0 block that starts at line 459). We attribute it to 3.6. 3.6.0 notes say "To take advantage of all features, GEOS 3.14+ is needed."

**Where found**: <https://github.com/postgis/postgis/blob/master/NEWS>.
**Affects**: `95-postgis.md:340`, `:342`, `:344`.
**Action**: update.

**What**: Master is now `PostGIS 3.8.0dev` (2026/xx/xx), no released content yet.
**Action**: no change.

---

## TimescaleDB

Our file: `96-timescaledb.md`, "v2.27.0 at planning time, released 2026-05-12. Supports PG 15-18".

### Findings

**What**: Releases since 2.27.0 (CHANGELOG dates): 2.27.1 (2026-05-19), 2.27.2 (2026-06-02), 2.28.0 (2026-06-16), 2.28.1 (06-23), 2.28.2 (06-30), 2.28.3 (07-16), 2.29.0 (2026-07-28), 2.29.1 (08-04), 2.29.2 (08-18), 2.30.0 (2026-09-08), 2.30.1 (09-17), 2.30.2 (09-29), 2.31.0 (2026-10-20), **2.32.0 (2026-11-11; GitHub release object dated 2026-11-12)**.
**Where found**: <https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md>; `gh release list -R timescale/timescaledb`.
**Affects**: `96-timescaledb.md:32`, `:486-488`, `:785`, `:853`.
**Action**: update.

**What**: **PostgreSQL 15 support removed in 2.29.0** ("TimescaleDB 2.29.0 removes support for PostgreSQL 15. This release supports PostgreSQL 16, 17, and 18"; backward-incompatible change #10041). 2.28.0 was the last minor with PG15 ("Starting with our next release, version 2.29.0, we will officially drop support for Postgres 15 ... all future patch releases within the 2.28 cycle will continue to support it"). Our file says the next release in "June 2026" is the last with PG15 and still lists PG15-18.
**Where found**: CHANGELOG `## 2.29.0 (2026-07-28)` ("Important: PostgreSQL 15 Support Removed") and `## 2.28.0 (2026-06-16)` ("Deprecation Notice: PostgreSQL 15 Support").
**Affects**: `96-timescaledb.md:32`, `:488`, `:492-493` (warning block), `:785` (pitfall 6).
**Action**: update. Rewrite as: PG14 dropped earlier; PG15 dropped in 2.29.0; supported PG16-18.

**What**: PG19 support: not claimed in any release note through 2.32.0. The project's commit log shows "Switch PG19 tests to 19rc1" (2026-10-30) and `src/compat/compat.h` carries PG19 conditionals, so work is in progress.
**Where found**: <https://github.com/timescale/timescaledb/commits/main> (commit 2026-10-30); CHANGELOG (no mention).
**Action**: no change to claims, but do not say PG19 is supported. Add "PG19 support not yet announced as of 2.32.0".

**What**: Backward-incompatible or behaviour-changing items since 2.27.0:

- **2.28.0**: `Remove adaptive chunking` (#9934). `_timescaledb_catalog.chunk_constraint` table dropped and replaced by a compatibility view that will be removed later; use informational views. Superseded APIs: first/last sparse indexes added to compression (#9580).
- **2.31.0**: `timescaledb.enable_columnarscan` renamed `timescaledb.debug_enable_columnarscan` (#10666). Direct-compress batch sorting GUCs only in debug builds (#10772). Loader change: pgaudit must come after timescaledb in `shared_preload_libraries` (restart required).
- **2.32.0**: Adaptive Integer Compression (AIC) **enabled by default** (#10878; was experimental and off in 2.31.0 via `timescaledb.enable_aic_compression`). Background worker scheduler now runs as the database owner instead of superuser (#10983); database owners can start/stop/restart background workers (#10953); telemetry job runs as database owner (#10960). Larger than usual set of security fixes ("we recommend that you upgrade as soon as possible"). Loader changes need a PostgreSQL restart.
- **2.29.1** carried fixes for security vulnerabilities (#10360, #10379, #10386; advisory GHSA-hcfx-29v5-2rcw).

**Where found**: CHANGELOG sections for 2.28.0, 2.29.1, 2.31.0, 2.32.0.
**Affects**: our file does not mention any of these.
**Action**: new short "Recent changes (2.28-2.32)" section, plus a "run 2.32.0+ for security fixes" note.

**What**: New features and signatures (selected, all from CHANGELOG):

- 2.28.0: incremental `refresh_continuous_aggregate()` (params `buckets_per_batch`, `max_batches_per_execution`, `refresh_newest_first` per the release highlights); `ALTER MATERIALIZED VIEW <cagg> ADD COLUMN <name> <type> GENERATED ALWAYS AS (<aggregate>) STORED` (#9825); `ANALYZE`/`VACUUM` on continuous aggregates (#4054); vectorized `CASE`; `first`/`last` sparse indexes; `rebuild_sparse_index()` (#9938). New settings `skip_cagg_invalidation`, `stats_max_chunks` (default 1024).
- 2.29.0: `compact_chunk()` (#9957, `max_batches` added in #10266); compaction policy for unordered chunks (#10163); `recompress_unordered` columnstore policy option (#10226); `config_merge` parameter on `alter_job()` (#10225); `tsdb.direct_compress` storage parameter (#10240); `_timescaledb_functions.decompress_batch()` (#9684); chunk exclusion for DML under new GUC `timescaledb.enable_hypertable_expansion_for_dml` (default on); `ALTER EXTENSION timescaledb UPDATE` allowed inside a transaction block (#10313).
- 2.30.0: `DeferredChunkAppend` custom scan (GUC `enable_deferred_chunk_append`, default true); custom TOAST writer for compressed inserts (`use_custom_toaster`, default false).
- 2.31.0: `move_to_columnstore()` compresses chunk rows without blocking concurrent DML (#10632); granular refresh APIs and informational views; cagg refresh statistics via `timescaledb.cagg_refresh_stats_level` (`off` default, `summary`, `verbose_log`); `timescaledb.enable_columnarscan_metadata_only` (on by default) answers eligible `LIMIT 1` queries on compressed chunks from batch metadata; `timescaledb.move_to_columnstore_tuple_sort_limit` (default 0 = no limit).
- 2.32.0: new GUCs `compression_orderby_default_function` and `compression_segmentby_default_function`. `bloom1_contains` removed (#10075).
- 2.27.0 (the version we document) already included `enable_cagg_rewrites` (off by default), `enable_columnar_scan_filter_pushdown` (on by default) and a bloom-filter metadata naming change that needs a migration script when upgrading from 2.26 composite bloom filters.

**Where found**: <https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md>.
**Affects**: `96-timescaledb.md` Hypercore section (lines around 184-226) and GUC coverage.
**Action**: new section on 2.28-2.32 additions. Keep it to API names and defaults above.

**What**: Our version timeline has older date errors that the CHANGELOG corrects:

| Our row | Our date | CHANGELOG date |
|---|---|---|
| 2.14 | 2024-01 | 2024-02-08 |
| 2.17 | 2024-09 | 2024-10-08 |
| 2.18 | 2024-11 | 2025-01-23 |
| 2.19 | 2025-01 | 2025-03-18 |
| 2.20 | 2025-02 | 2025-05-15 |
| 2.23 | 2025-07 | 2025-10-29 |
| 2.26 | 2026-03 "PG18 support added" | 2026-03-24; PG18 support landed in **2.23.0** ("full PostgreSQL 18 support ... TimescaleDB v2.23 is available for PostgreSQL 15, 16, 17, and 18") |

**Where found**: CHANGELOG section headers; 2.23.0 notes.
**Affects**: `96-timescaledb.md:480-486` (table rows), `:36`.
**Action**: update. Also `:224-226` mention "v2.23.0+ — automatic timestamp partitioning": consistent with 2.23 date, fine.

---

## Citus

Our file: `97-citus.md`, "Latest stable Citus 14.0 released 2026-02-17, supports through PG 18.1".

### Findings

**What**: Releases after 14.0: v14.0.1 (2026-04-21), v14.1.0 (changelog "May 14, 2026"; the GitHub release object is dated 2026-07-01 and titled "v14.1 (Released on May 15th 2026)"), v14.2.0 (2026-08-06), **v14.3.0 (2026-10-23)**. The legacy line also had v13.5.0 (2026-10-23) and v12.1.14. Note the v14.0.0 CHANGELOG header says **February 9, 2026**, not 2026-02-17.
**Where found**: <https://github.com/citusdata/citus/blob/v14.3.0/CHANGELOG.md> (the `main` CHANGELOG still stops at 14.0.0, so read it at the tag); `gh release list -R citusdata/citus`.
**Affects**: `97-citus.md:35`, `:326`, `:569`, `:648`.
**Action**: update.

**What**: 14.0.0 supports **PG 16-18**: "Drops PG15 support (#8372)", "Adds support for PostgreSQL 18 (#8065)". PG14 was dropped in v13.0.1 (February 4th, 2025: "Drops support for PostgreSQL 14 (#7753)"). Our matrix says "PG18.1 support" but never says 14.x no longer supports PG15, and the 13.0 row says "PG17 support" without the PG14 drop. v14.3.0 text states "PostgreSQL 16-18".
**Where found**: CHANGELOG `### citus v14.0.0 (February 9, 2026)` and `### citus v13.0.1`; v14.3.0 entry "Quotes `EXTRACT` fields in rewritten queries for PostgreSQL 16-18 (#8809)".
**Affects**: `97-citus.md:326`, `:569`, `:46`.
**Action**: update. Citus 14.x requires PG16-18.

**What**: 14.0.0 also brought: virtual generated columns on distributed tables (PG18, #8346), `publish_generated_columns` propagation (#8360), `VACUUM`/`ANALYZE ONLY` semantics (#8365), `sslkeylogfile` in `citus.node_conn_info` (#8437), `ENFORCED`/`NOT ENFORCED` CHECK propagation (#8349), `citus_create_restore_point` made MX-safe (#8352), `citus.enable_statistics_collection` GUC **deprecated** and on-demand stats collection stopped (#8460), colocation now refuses tables whose distribution-key collations differ (#8257).
**Where found**: CHANGELOG `### citus v14.0.0`.
**Affects**: our file mentions none of these.
**Action**: new short "Citus 14.x changes" section.

**What**: 14.0.1 (2026-04-21): extension SQL hardened against `search_path` attacks (`SET search_path = pg_catalog, pg_temp` on UDFs and procedures); `CREATE STATISTICS` on expressions supported and on by default (#8501, #8512); version-skew tolerance between coordinator and workers (#8550). 14.1.0 (May 2026): schema-based sharding DDL (`CREATE SCHEMA`, `DROP SCHEMA`, `ALTER SCHEMA RENAME`, table DDL on distributed schemas) can run from any node (#8541); new UDFs `citus_cluster_changes_block()`, `citus_cluster_changes_unblock()`, `citus_cluster_changes_block_status()` to pause 2PC commit decisions and schema/topology changes for consistent disk-snapshot backups (#8543, #8571). 14.2.0 (2026-08-06): `citus_internal.distribute_object()` (superuser repair UDF, #8621); new GUC `citus.allow_unsafe_insert_select_pushdown` (#8625); procedure 2PC avoided for single-statement single-shard calls via PL/pgSQL static analysis (#8566). 14.3.0 (2026-10-23): sorted-merge execution for multi-shard `ORDER BY` (#8529, #8584); small-batch row fetching in the adaptive executor (#5195); new GUC `citus.enable_or_clause_arm_pruning` (#8642); internal metadata cleanup restricted to superusers (#8942); internal SPI queries use an empty `search_path` (#8944).
**Where found**: <https://github.com/citusdata/citus/blob/v14.3.0/CHANGELOG.md> entries for 14.0.1, 14.1.0, 14.2.0, 14.3.0.
**Affects**: our schema-based sharding section (`97-citus.md:180-207`) and backup/HA sections.
**Action**: update schema-based sharding section (any-node DDL); new bullets for backup UDFs and the new GUCs.

**What**: PG19: released 14.3.0 does not support it. master commits: "Pg19 support (#8753)" 2026-08-27, "Fix PostgreSQL 19 beta4 compatibility (#8870)" 2026-09-25, "Update PostgreSQL 19 CI to RC1 (#8929)" 2026-10-16, "PG19: propagate EXPLAIN IO to worker nodes (#8807)" and "PG19: use ShareUpdateExclusiveLock for REPACK CONCURRENTLY (#8805)" 2026-10-23.
**Where found**: <https://github.com/citusdata/citus/commits/main>.
**Action**: no change to claims; mention PG19 is on master only.

---

## pg_cron

Our file: `98-pg-cron.md`, "Latest stable v1.6.7 released 2025-09-04".

### Findings

**What**: **v1.6.8 (2026-09-08)**. Changes: **PostgreSQL 19 support** (#430), native Windows build support (#431), new GUC `cron.match_dom_and_dow` (see below, PR #421), shutdown hang with synchronous replication fixed (#414), shared-memory queue handle leak in the launcher fixed (#420), job-cache invalidation when the relation ID is invalid, uninitialized-variable fix (#413), compatibility with the v1.3 `cron.schedule` named-job signature preserved (#411), role-ownership checks kept case-sensitive (#425), `getrlimit` return handling (#436).
**Where found**: <https://github.com/citusdata/pg_cron/blob/main/CHANGELOG.md> (`### pg_cron v1.6.8 (September 8, 2026)`); `gh release list -R citusdata/pg_cron` (v1.6.8, 2026-09-08). `main` is 0 commits ahead of the `v1.6.8` tag. `pg_cron.control` `default_version = '1.6'` (no SQL upgrade needed).
**Affects**: `98-pg-cron.md:35`, `:106`, `:335`, `:712`.
**Action**: update. Add row for v1.6.8 (PG19 support).

**What**: **New GUC `cron.match_dom_and_dow`** (bool, default `false`, context `sighup`, superuser-only). Description in source: "Requires a day to match both the day-of-month and day-of-week fields." Default keeps the Vixie-cron OR behaviour. When on, `'0 5 1-7 * 0'` runs only on days that are both in 1-7 and a Sunday (first Sunday of the month). **Naming discrepancy**: the CHANGELOG and PR #421 text say `cron.dom_dow_and_logic`; the shipped source at tag v1.6.8 defines `cron.match_dom_and_dow` (`src/pg_cron.c`, line 356; the C variable is `CronDomDowAndLogic`). Use the source name. The setting is not listed in the README settings table.
**Where found**: <https://github.com/citusdata/pg_cron/blob/v1.6.8/src/pg_cron.c> (`DefineCustomBoolVariable("cron.match_dom_and_dow", ...)`, `PGC_SIGHUP`); CHANGELOG line for v1.6.8; PR <https://github.com/citusdata/pg_cron/pull/421>.
**Affects**: our file's cron syntax and GUC table (`98-pg-cron.md:41`, `:314-325`).
**Action**: new GUC row and a recipe note ("first Sunday of the month").

**What**: Existing GUC table errors, checked against `src/pg_cron.c` at v1.6.8 (same on main):

| GUC | Our context | Source context |
|---|---|---|
| `cron.timezone` | sighup | `PGC_POSTMASTER` |
| `cron.log_run` | sighup | `PGC_POSTMASTER` |
| `cron.log_statement` | sighup | `PGC_POSTMASTER` |
| `cron.host` | sighup | `PGC_POSTMASTER` |

README also states: "`cron.log_min_messages` and `cron.launch_active_jobs` have a setting context of sighup ... All the other settings have a postmaster context". Our table also omits `cron.enable_superuser_jobs` (default `on`, postmaster). Also, `98-pg-cron.md:269` says `cron.log_run = off` needs "restart" which is right, while the table above contradicts it.
**Where found**: <https://github.com/citusdata/pg_cron/blob/v1.6.8/src/pg_cron.c>; <https://github.com/citusdata/pg_cron/blob/main/README.md> ("Extension settings").
**Affects**: `98-pg-cron.md:317` (`cron.timezone`), `:320-321`, `:323`, plus missing row.
**Action**: update.

---

## pg_partman

Our file: `99-pg-partman.md`, latest 5.4.3 (2026-03-05), footnote at 779.

### Findings

**What**: **v5.5.0 (2026-07-22)**, a security release (`pg_partman.control` `default_version = '5.5.0'`). Breaking changes:

- Default of `pg_partman_bgw.role` is now `partman_maintainer`. If it had not been set explicitly, the background worker stops running and errors until that role exists with proper privileges. Anyone who had set it to a superuser role is "HIGHLY" advised to switch to a non-superuser role.
- With a target retention schema, the schema must now be owned by the same role that owns the child table (CVE-2026-61821).

New features: `detach_before_drop` flag in `part_config` for retention on partition sets referenced by foreign keys (detach first, then drop); new `maintenance_role` column on `part_config` and `part_config_sub` to support RLS on config tables; child tables inherit per-column statistics targets from the parent; upper bound of child tables looked up from the system catalogs where possible; an error in one partition set's maintenance run no longer aborts maintenance for others (warning logged, `last_run` set to NULL; CVE-2026-61822). Bug fixes: SQL injection / privilege escalation via time encoder/decoder functions (CVE-2026-61781, -61817, -61818), via `pg_jobmon` (CVE-2026-61819), via template-table property inheritance (CVE-2026-61820). The README gained instructions for running pg_partman with no superuser at all and for RLS on configuration tables.
**Where found**: <https://github.com/pgpartman/pg_partman/blob/master/CHANGELOG.md> (top section `5.5.0`); release <https://github.com/pgpartman/pg_partman/releases/tag/v5.5.0> (2026-07-22). CVE identifiers are quoted from the CHANGELOG text and were not checked against a CVE database.
**Affects**: `99-pg-partman.md:405` (5.4.3 "latest stable at planning time"), `:779`, retention material at `:55`, `:224`, `:255`, `:273`, `:553`, `:718`; our file has no mention of `pg_partman_bgw.role`.
**Action**: update (new row 5.5.0, new section "5.5.0 security changes", add `detach_before_drop`, `maintenance_role` to `part_config` docs).

**What**: Releases between 5.4.0 and 5.5.0 that our table skips: 5.4.1 (2026-02-09 GitHub release; secure `search_path` on all functions, procedures schema-qualify object calls, `partition_data_time()` timestamp-without-tz fix), 5.4.2 (2026-02-17: `partition_data_*` fix when not installed in schema `partman`), 5.4.3 (2026-03-05). Also, after 5.5.0, development commits on 2026-08-21 (fix RANGE->LIST subpartitioning in `create_partition_time()`, #857) and 2026-10-23 (typo in `partition_data_time` format call, #878) are on the default branch but not released.
**Where found**: CHANGELOG sections `5.4.1`, `5.4.2`, `5.4.3`; commit list <https://github.com/pgpartman/pg_partman/commits/development>.
**Action**: optional table rows.

**What**: PG support: README "Requirement: PostgreSQL >= 14"; the CI workflow `ci.yml` matrix is `pg: [18, 17, 16, 15, 14]`. No PG19 mention in the 5.5.0 notes or README. A CI "add pg18 to workflow ci" commit is dated 2026-07-22.
**Where found**: <https://github.com/pgpartman/pg_partman/blob/master/README.md> (INSTALLATION), `.github/workflows/ci.yml`.
**Affects**: `99-pg-partman.md:42-43` is still correct ("PostgreSQL >= 14").
**Action**: no change.

---

## pg_trgm

Our file: `93-pg-trgm.md`, per-version table at 290-300 (PG14 equality lookups, PG18 parallel GIN builds, PG18 collation-provider change).

### Findings

**What**: **PG19 release notes (RC2) contain a pg_trgm item**: "Change full text search and pg_trgm to use the database's locale provider for character classification when parsing text (Jeff Davis)" under E.1.2 Migration to Version 19. Previously characters were classified using libc regardless of locale provider. In databases with a non-libc locale provider (ICU, builtin) whose locale behaves differently from the database `LC_CTYPE` (particularly `C`), the output of some full text search and pg_trgm functions could change. Recommendation: after `pg_upgrade`, reindex every index that uses full text search or pg_trgm and recompute stored `tsvector` values.
Related PG19 item under E.1.3.5 Functions (Tom Lane): new Polish and Esperanto stemmers; the Dutch stemmer algorithm changed (old one kept as `dutch_porter`); English, French, German, Lithuanian, Norwegian, Spanish, Swedish and Turkish stemmers updated. This affects `tsvector` values, not pg_trgm directly.
**Where found**: <https://www.postgresql.org/docs/19/release-19.html> (page is "19rc2", "Release date: 2026-??-??, AS OF 2026-10-09"; final wording may change before GA).
**Affects**: `93-pg-trgm.md:45` (rule 5), `:264-277` (collation section), `:290-300` (per-version table has no PG19 row). `:699-703` footnotes.
**Action**: new row "PG19 (RC2 notes)" and extend the collation-provider section: this is the second step of the same change (PG18 was FTS configuration files and dictionaries; PG19 is character classification). Mark as pre-GA.

**What**: **Index corruption fix for `gist_trgm_ops`**, in PostgreSQL **18.7, 17.12, 16.16, 15.20, 14.25 (released 2026-11-12)**: "Fix possible index corruption in `contrib/pg_trgm` GiST indexes (Nate Clark). Combination of index entries could lose the flag identifying their format, so that subsequent index searches could miss matching rows. This fix does not repair existing indexes. Users should `REINDEX` existing `gist_trgm_ops` indexes after updating." The bug came from the commit that added configurable signature lengths (`911e7020770`), backpatched through PG14.
Also in the same minor release (relevant to GIN-based trigram indexes): VACUUM could miss removing some GIN index entries when one VACUUM needed multiple index scans, and a GIN posting-tree page deletion bug after an incomplete page split could cause missed rows (Peter Geoghegan). `REINDEX` is recommended if affected.
Earlier fixes on master and backpatched to 14: `pg_trgm` `gist_trgm_ops` picksplit with all-true datums read beyond the end of a buffer (CVE-2026-14678, 2026-08-10); `calc_word_similarity()` bounds expansion fix (2026-02-20).
**Where found**: <https://www.postgresql.org/docs/release/18.7/> (items quoted above); commit "Fix possible index corruption in pg_trgm GiST indexes" 2026-11-04 in `postgres/postgres`, path `contrib/pg_trgm`.
**Affects**: `93-pg-trgm.md` (no mention of GiST corruption; the GiST KNN recipe at ~320 uses `gist_trgm_ops`).
**Action**: new warning block: after updating to 14.25 / 15.20 / 16.16 / 17.12 / 18.7, `REINDEX` all `gist_trgm_ops` indexes. Do this regardless of the PG19 notes.

**What**: Extension version: `contrib/pg_trgm/pg_trgm.control` on master still has `default_version = '1.6'` (new SQL objects: none seen in `pg_trgm--*.sql` after `1.5--1.6`). No new functions, operators or GUCs were found for PG19. A trigram sort/dedup optimization (commit 2026-04-07, "Optimize sorting and deduplicating trigrams") is internal.
**Where found**: <https://github.com/postgres/postgres/tree/master/contrib/pg_trgm> (`pg_trgm.control`, directory listing).
**Action**: no change.

---

## Stale claims in our skill

| file:line | Current text (abridged) | Corrected fact | Source |
|---|---|---|---|
| `94-pgvector.md:3` | "Latest version **0.8.2** (2026-02-25)" | 0.8.7 (2026-10-01) | <https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md> |
| `94-pgvector.md:357` | "0.8.1 \| 2025-08-12" | 0.8.1 is dated 2025-09-04 | same CHANGELOG, `## 0.8.1 (2025-09-04)` |
| `94-pgvector.md:358` | "0.8.2 ... (latest at planning time)" | Add 0.8.3-0.8.7 (see table above) | same CHANGELOG |
| `94-pgvector.md:365`, `:711` | "pgvector 0.8.2 supports PG14-PG18" | 0.8.x supports PG13+ per README; unreleased 0.9.0 drops PG13 and PG14; master CI tests PG15-20 | CHANGELOG `## 0.9.0 (unreleased)`; `.github/workflows/build.yml` |
| `94-pgvector.md:742`, `:744` | "0.8.2 latest ... (2026-02-25)" | 0.8.7 | CHANGELOG |
| `95-postgis.md:33` | "latest stable **3.6.3** ... Supports PG 12-18" | 3.7.0 (2026-10-29) supports PG 14-19; 3.6.4 (2026-06-08) is latest 3.6 | <https://github.com/postgis/postgis/blob/3.7.0/NEWS> |
| `95-postgis.md:340` | "3.2 \| 2022-02" | 3.2.0 is 2021/12/17; `ST_Letters` is in 3.3.0 | <https://github.com/postgis/postgis/blob/master/NEWS> |
| `95-postgis.md:342` | "3.4 \| 2023-09" | 3.4.0 is 2023/08/15 | same NEWS |
| `95-postgis.md:343` | "Latest in 3.5 series: 3.5.6 (Apr 2026)" | 3.5.7 tag exists (date not verified) | `gh api repos/postgis/postgis/git/matching-refs/tags/3.` |
| `95-postgis.md:344` | "3.6 \| 2025-Q4 ... RelateNG support, GEOS 3.13 features" | 3.6.0 is 2025/09/01; RelateNG / GEOS 3.13 support is listed under 3.5.0; 3.6 asks for GEOS 3.14+ for all features; latest 3.6 is 3.6.4; add 3.7 row | NEWS sections 3.6.0, 3.5.0 |
| `95-postgis.md:348`, `:635` | "PostgreSQL 12 through 18, GEOS 3.8+" (for 3.6) | Correct for 3.6; 3.7 requires PG 14-19 and GEOS 3.10+ | 3.7.0 NEWS |
| `96-timescaledb.md:32` | "latest stable v2.27.0 ... released 2026-05-12. Supports PG 15-18 ... PG15 last-supported in June 2026 release" | 2.32.0 (2026-11-11); PG15 dropped in 2.29.0 (2026-07-28); supports PG 16-18 | <https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md> |
| `96-timescaledb.md:480-486` | 2.14 "2024-01"; 2.17 "2024-09"; 2.18 "2024-11"; 2.19 "2025-01"; 2.20 "2025-02"; 2.23 "2025-07"; "2.26 \| PG18 support added" | 2.14 2024-02-08; 2.17 2024-10-08; 2.18 2025-01-23; 2.19 2025-03-18; 2.20 2025-05-15; 2.23 2025-10-29; PG18 support arrived in 2.23.0 | CHANGELOG section headers; 2.23.0 notes |
| `96-timescaledb.md:487-488` | "2.27.0 latest stable ... Next (June 2026): last version with support for PG15" | The June release was 2.28.0 (last minor with PG15); 2.29.0 removed PG15 | CHANGELOG 2.28.0, 2.29.0 |
| `96-timescaledb.md:492-493` | Warning: PG15 support ends with June 2026 release | PG15 support is already gone (2.29.0+). Only 2.28.x patch releases still support PG15 | CHANGELOG 2.28.0 |
| `96-timescaledb.md:785` | "TimescaleDB v2.27.0 supports PG15-18; PG15 support ends with June 2026 release" | Supports PG16-18 from 2.29.0 | CHANGELOG 2.29.0 |
| `97-citus.md:35`, `:326`, `:648` | "Citus 14.0 released 2026-02-17" "latest at planning time" | 14.3.0 (2026-10-23); v14.0.0 CHANGELOG header says February 9, 2026 | <https://github.com/citusdata/citus/blob/v14.3.0/CHANGELOG.md> |
| `97-citus.md:326`, `:569` | "PG18.1 support" / "Citus 14.0 supports PG18.1" | 14.x supports PG 16-18; PG15 dropped in 14.0.0 (#8372) | CHANGELOG `### citus v14.0.0` |
| `97-citus.md:325` | "13.0 \| 2025-Q1 \| PG17 support" | Also dropped PG14 (#7753), listed in the v13.0.1 entry (February 4th, 2025) | CHANGELOG (`### citus v13.0.1`, "Drops support for PostgreSQL 14 (#7753)") |
| `98-pg-cron.md:35`, `:106`, `:335`, `:712` | "Latest stable v1.6.7 (2025-09-04)"; "v1.6.7 (current)" | v1.6.8 (2026-09-08) adds PG19 | <https://github.com/citusdata/pg_cron/blob/main/CHANGELOG.md> |
| `98-pg-cron.md:317` | `cron.timezone` context "sighup" | `PGC_POSTMASTER` | <https://github.com/citusdata/pg_cron/blob/v1.6.8/src/pg_cron.c> |
| `98-pg-cron.md:320`, `:321` | `cron.log_run`, `cron.log_statement` context "sighup" | `PGC_POSTMASTER` | same source; README "Changing settings" |
| `98-pg-cron.md:323` | `cron.host` context "sighup" | `PGC_POSTMASTER` | same source |
| `98-pg-cron.md:314-325` | GUC table lists 9 settings | Missing `cron.enable_superuser_jobs` (default `on`, postmaster) and `cron.match_dom_and_dow` (default `false`, sighup, new in 1.6.8) | same source; README settings table |
| `99-pg-partman.md:405`, `:779` | "5.4.3 ... Latest stable at planning time" | 5.5.0 (2026-07-22) is current; breaking default for `pg_partman_bgw.role` and retention-schema ownership | <https://github.com/pgpartman/pg_partman/blob/master/CHANGELOG.md> |
| `93-pg-trgm.md:290-300` | Per-version table ends at PG18 | Add PG19 (RC2 notes): FTS and pg_trgm use the locale provider for character classification, reindex after `pg_upgrade` | <https://www.postgresql.org/docs/19/release-19.html> |
| `93-pg-trgm.md` (no line) | No mention of GiST index corruption | PG 14.25/15.20/16.16/17.12/18.7 (2026-11-12): REINDEX all `gist_trgm_ops` indexes | <https://www.postgresql.org/docs/release/18.7/> |

## Not verified

- **postgis.net news and docs**: the host was unreachable from the sandbox (`getaddrinfo ENOTFOUND postgis.net`). Release facts for PostGIS come from `NEWS` in the project's own GitHub repo at tags `3.7.0` and `3.6.4`. I did not read the 3.7 manual, so install-requirement wording (GDAL minimum, etc.) is not confirmed. The 3.5.7 release date and 3.5.x PG range are not confirmed (master NEWS does not carry patch-release sections).
- **PostGIS**: the `ST_HilbertCode` attribution to 3.1 in our file (line 339) was not found in NEWS and was not checked further.
- **TimescaleDB docs site** (`docs.tigerdata.com`, `tigerdata.com/docs`): not fetched. Everything comes from `CHANGELOG.md` in `timescale/timescaledb`. The README Docker image is `timescale/timescaledb-ha:pg18`. Whether 2.32.0 binaries exist for PG19 is not stated in any release note I read.
- **TimescaleDB 2.32.0 date**: CHANGELOG says 2026-11-11; the GitHub release object says 2026-11-12T11:20:48Z. I did not determine which is the publication date.
- **Citus release dates**: GitHub release objects for v14.1.0, v14.2.0, v13.x were re-created in bulk (for example v14.1.0 shows createdAt 2026-07-01 but the CHANGELOG says May 14, 2026, and its title says "Released on May 15th 2026"). I used CHANGELOG dates. The 2026-02-17 date in our file is not confirmed by any source I read; the CHANGELOG says February 9.
- **Citus PG19**: no release or tag includes it; the merged master commits do not prove which future version will carry it. The Citus docs site (docs.citusdata.com) was not read.
- **pgvector PG19 compatibility**: unreleased CI on master includes `postgres: 19` and `20`; no released changelog line claims PG19 support. 0.9.0 has no release date.
- **pg_partman PG19**: no evidence either way.
- **pg_partman CVE identifiers** (CVE-2026-61781, -61817, -61818, -61819, -61820, -61821, -61822): copied verbatim from the CHANGELOG, not checked against a CVE database.
- **PG19 GA date and final wording**: the release-notes page is for 19rc2 with an unset release date. The pg_trgm and stemmer items may be edited before GA. `postgres/postgres` has no `REL_19_0` tag as of 2026-11-14.
- **PG 18.7 release-note item scope**: I read only the items mentioning REINDEX, pg_trgm, GIN and `gist_trgm_ops`; the page lists other bug fixes that I did not review for these extensions.
- **pg_cron `cron.match_dom_and_dow` vs `cron.dom_dow_and_logic`**: I confirmed the source at v1.6.8 defines `cron.match_dom_and_dow`. I did not check git history to learn when the rename happened, so the CHANGELOG line is likely stale rather than the source.

# Physical backup + Point-In-Time Recovery (PITR)

<!-- TOC -->

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
  - [Decision matrix](#decision-matrix)
  - [`pg_basebackup` mechanics](#pg_basebackup-mechanics)
  - [Continuous archiving — `archive_command` vs `archive_library`](#continuous-archiving--archive_command-vs-archive_library)
  - [Restore + recovery targets](#restore--recovery-targets)
  - [End-of-recovery actions](#end-of-recovery-actions)
  - [Incremental backups (PG17+)](#incremental-backups-pg17)
  - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

<!-- /TOC -->

## When to Use This Reference

> [!WARNING] URL traps
> Planning-note URLs `wal-archive.html`, `backup-archiving-wal.html`, `standby-server.html` all **404**. Use `continuous-archiving.html` (chapter 26.3) for archive setup and `warm-standby.html` / `hot-standby.html` for standby docs. `recovery-config.html` exists but is **Appendix O.1** documenting `recovery.conf` removal in PG12 — NOT the GUC reference. Cite `runtime-config-wal.html` for `archive_command`, `archive_library`, `restore_command`, `recovery_target_*` definitions.

Use this file for:

- Physical backup mechanics — byte-level base backup via streaming replication protocol
- `pg_basebackup` invocation patterns
- Continuous WAL archiving setup
- Point-In-Time Recovery walkthroughs
- PG17+ incremental backup chains via `--incremental` + `pg_combinebackup` + `pg_walsummary`
- Cross-references to [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) (logical backup contrast), [`85-backup-tools.md`](./85-backup-tools.md) (pgBackRest/Barman/WAL-G production wrappers), [`73-streaming-replication.md`](./73-streaming-replication.md) (BASE_BACKUP protocol + standby setup), [`89-pg-rewind.md`](./89-pg-rewind.md) (re-attach diverged primary), [`90-disaster-recovery.md`](./90-disaster-recovery.md) (DR runbooks).

## Mental Model

Five rules drive every physical-backup + PITR decision.

1. **Physical backup = byte-level copy via streaming replication protocol.** `pg_basebackup` issues `BASE_BACKUP` over libpq replication connection. Cross-version impossible (PG16 backup not restorable to PG17). Cross-architecture impossible (x86 backup not restorable to ARM). Restore = bytes back, no SQL replay. Faster restore than logical backup (no parse + replan + indexes), portable only within same PG major + same architecture.

2. **`pg_basebackup` canonical client.** Three flags matter: `-D <dir>` destination, `-X stream` for WAL streaming (parallel; recommended over `fetch`), `-R` writes `standby.signal` + `primary_conninfo` for direct standby use. PG15+ adds `--target=server` for server-side write (requires `pg_write_server_files` role) + server-side LZ4/Zstd compression.

3. **PITR requires three components, all of which must be in place BEFORE the failure event.** (a) Base backup taken at known LSN; (b) continuous WAL archive covering every segment from base-backup-start LSN onward; (c) `recovery.signal` + `restore_command` + `recovery_target_*` configured during restore. Missing any one → recovery to specific point-in-time impossible.

4. **`archive_library` (PG15+) is the modern modular replacement for `archive_command` shell.** Cannot set both — PG16+ explicitly errors. `archive_library = 'basic_archive'` is the example bundled module. Custom C modules can be async, batched, use any compression. `archive_command` remains supported but shell-overhead-per-segment cap rate at ~100 segments/sec.

5. **PG17+ incremental backups via WAL summarization.** Three components: `summarize_wal = on` GUC enables walsummarizer process; `pg_basebackup --incremental=manifest` ships only changed blocks; `pg_combinebackup full incr1 incr2 -o synthetic` reconstructs synthetic full backup from chain. `pg_walsummary` inspects `.summary` files in `pg_wal/summaries`.

> [!WARNING] PG12 watershed — `recovery.conf` removed
> Pre-PG12 PITR used `recovery.conf` with `restore_command` and `recovery_target_*` in that file. **PG12+ merged everything into `postgresql.conf`** + signal files `standby.signal` (for streaming replica) / `recovery.signal` (for archive recovery). See verbatim quote in Appendix O.1: any pre-PG12 documentation citing `recovery.conf` is obsolete.

## Syntax / Mechanics

### Decision matrix

| Need | Use | Default | Production value | Why |
|---|---|---|---|---|
| One-time full physical backup, no PITR | `pg_basebackup -D /backup -Ft -X stream` | stream | `-Fp -X stream` directory format for parallel restore | tar format = single archive, harder to parse |
| Full backup + WAL archive for PITR | `pg_basebackup -D /backup -X stream -Fp` + `archive_library` set | stream | -Fp directory with checksums verified | -X stream guarantees WAL-needed-for-consistency captured |
| Set up standby from base backup | `pg_basebackup -D /var/lib/pgsql/data -X stream -R` | — | `-R` writes `standby.signal` + `primary_conninfo` | -R = zero post-config |
| Server-side compression (PG15+) | `pg_basebackup --target=server:/backup --compress=server-zstd:5` | client-side | server-side for fewer client-server bytes | client-side compression wastes CPU on backup server |
| Modern archiving (PG15+) | `archive_library = 'basic_archive'` + `basic_archive.archive_directory` | empty | Custom C archive module via pgBackRest/Barman | `archive_command` shell overhead caps throughput |
| Cluster never archived → enable | Set `archive_mode = on`, `wal_level >= replica`, `archive_command` OR `archive_library`, restart | off | both `archive_mode=on` AND archive target | restart required for archive_mode change |
| PITR to specific timestamp | `recovery_target_time = '2026-05-13 14:00:00 UTC'` | — | Always pair with `recovery_target_action = pause` | pause lets you verify before promotion |
| PITR to LSN | `recovery_target_lsn = '0/1500000'` | — | Useful when you know exact transaction position | timestamp granularity is COMMIT-record-resolution |
| PITR to named restore point | `recovery_target_name = 'before_disaster'` | — | First call `SELECT pg_create_restore_point('before_disaster')` on primary | Best for planned change rollback |
| End-of-archive recovery | Omit `recovery_target_*` | — | Recovers to latest WAL in archive | "as far as possible" recovery |
| Incremental backup (PG17+) | `pg_basebackup -D /backup_incr1 --incremental=/backup_full/backup_manifest -X stream` | — | Daily incremental + weekly full | Smaller, faster, depends on chain |
| Production-grade backup mgmt | pgBackRest / Barman / WAL-G | — | One of those | Built-in retention + parallel + encryption |

Three smell signals:

- **`archive_command` returning success without durable storage** — `archive_command = 'cp %p /archive/'` is broken; `cp` returns 0 before `fsync` of target. Use `test ! -f /archive/%f && cp %p /archive/%f` AND a tool that fsync's.
- **Base backup taken but no WAL archive** — base backup alone restores to its end-LSN only, not arbitrary point-in-time. WAL archive mandatory for PITR.
- **`pg_basebackup` to standby without `-R`** — every restore + signal-file-write cycle wastes time; `-R` writes the config automatically.

### `pg_basebackup` mechanics

`pg_basebackup` opens replication connection (`replication=yes` connection-string), sends `BASE_BACKUP` protocol command, streams base-backup contents into local directory. See [`73-streaming-replication.md`](./73-streaming-replication.md) for replication-protocol mechanics.

Canonical invocation:

    pg_basebackup \
      --pgdata=/var/lib/pgsql/16/data \
      --format=plain \
      --wal-method=stream \
      --write-recovery-conf \
      --checkpoint=fast \
      --progress \
      --verbose \
      --max-rate=100M

Flag inventory:

| Flag | Long form | Purpose |
|---|---|---|
| `-D` | `--pgdata` | Destination directory (required) |
| `-F` | `--format` | `plain` (default, like data dir) or `tar` |
| `-X` | `--wal-method` | `stream` (parallel, default), `fetch` (at end), `none` |
| `-R` | `--write-recovery-conf` | Writes `standby.signal` + `primary_conninfo` in postgresql.auto.conf |
| `-S` | `--slot` | Use named replication slot (recommended for standbys to bound WAL retention) |
| `-c` | `--checkpoint` | `fast` (immediate) or `spread` (slower, lighter I/O) |
| `-Z` | `--compress` | PG15+ `[server-]<method>[:level]` form: `server-zstd:5`, `client-lz4:1`, `gzip:9` |
| `--target` | (PG15+) | `client` (default), `server[:/path]`, `blackhole` (test) |
| `-r` | `--max-rate` | Throttle bytes/sec (e.g., `100M`) |
| `-l` | `--label` | Backup label (default `pg_basebackup base backup`) |
| `--manifest-checksums` | | `CRC32C` (default), `SHA224`, `SHA256`, `SHA384`, `SHA512`, `NONE` |
| `-n` | `--no-clean` | Leave partial backup on error (debug) |
| `--no-manifest` | | Skip manifest creation (not recommended) |
| `--incremental` | (PG17+) | Path to base-backup-manifest of reference backup |
| `-d` | `--dbname` | Replication connection string |

> [!NOTE] PostgreSQL 15
> `--target` flag added. `client` = default streaming over libpq. `server[:/path]` writes directly on server side — requires `pg_write_server_files` role membership. `blackhole` = throw away (for benchmarking). Server-side LZ4 + Zstandard compression also added. Verbatim: *"Allow pg_basebackup to do server-side gzip, LZ4, and Zstandard compression and client-side LZ4 and Zstandard compression of base backup files (Dipesh Pandit, Jeevan Ladhe)"*[^pg15-compression].

> [!NOTE] PostgreSQL 16
> Numeric compression option syntax added: `--compress=server-5` accepted (level only, default method). Verbatim: *"Improve pg_basebackup to accept numeric compression options (Georgios Kokolatos, Michael Paquier)"*[^pg16-numeric]. Also long-mode compression: *"Allow pg_dump and pg_basebackup to use `long` mode for compression (Justin Pryzby)"*[^pg16-long]. Plus tablespace-in-PGDATA fix: *"Fix pg_basebackup to handle tablespaces stored in the PGDATA directory (Robert Haas)"*[^pg16-tspc].

#### Backup manifest

Every `pg_basebackup` (since PG13) creates `backup_manifest` JSON in destination:

    {
      "PostgreSQL-Backup-Manifest-Version": 1,
      "Files": [
        {
          "Path": "PG_VERSION",
          "Size": 3,
          "Last-Modified": "2026-05-13 06:30:01 GMT",
          "Checksum-Algorithm": "CRC32C",
          "Checksum": "1ab2c3d4"
        },
        ...
      ],
      "WAL-Ranges": [...],
      "Manifest-Checksum": "..."
    }

Use `pg_verifybackup /backup` to validate manifest against backup contents.

> [!NOTE] PostgreSQL 18
> `pg_verifybackup` now verifies tar-format backups. Verbatim: *"Allow pg_verifybackup to verify tar-format backups (Amul Sul)"*[^pg18-verify].

#### `-X stream` vs `-X fetch`

| Mode | Behavior | Use case |
|---|---|---|
| `stream` (default) | Opens second replication connection in parallel, streams WAL generated during backup | Production. Bounds WAL retention to backup duration. |
| `fetch` | Fetches WAL at end of backup (single connection) | Pre-PG10 compatibility. Requires `wal_keep_size` large enough to cover entire backup duration. Rarely correct on modern PG. |
| `none` | No WAL captured | Backup unusable for restore — only for archive-mode setups where WAL archive captures WAL independently |

Stream mode is the only safe default. Without `-X stream`, base backup may end before all required WAL is archived, leaving a gap that makes the backup unusable.

#### Replication slot (`-S`)

Use a replication slot to prevent WAL from being recycled between backup completion and the moment the standby (or PITR target) starts consuming archived WAL:

    psql -c "SELECT pg_create_physical_replication_slot('backup_slot');"
    pg_basebackup -D /backup -X stream -S backup_slot -R

The `-R` flag writes `primary_slot_name = 'backup_slot'` into `postgresql.auto.conf`. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md) for slot management.

> [!WARNING] Slot retention is unbounded by default
> If the standby never connects, the slot retains WAL indefinitely → primary's `pg_wal` fills disk. Set `max_slot_wal_keep_size` to bound retention. See `75-replication-slots.md`.

### Continuous archiving — `archive_command` vs `archive_library`

WAL segments (default 16 MB each) are recycled after checkpoint. To enable PITR, archive each WAL segment to durable external storage before recycling.

Two server settings drive this:

| Setting | Default | Purpose |
|---|---|---|
| `wal_level` | `replica` | Must be `replica` or `logical` for archiving (not `minimal`) |
| `archive_mode` | `off` | `on` = archive on primary; `always` = archive on primary AND on standbys |

Archive target chosen via ONE of (cannot both be set on PG16+):

- `archive_command` (shell command per segment) — PG7.x+
- `archive_library` (loadable module) — PG15+

Verbatim definition of `archive_command`[^archive-command]:

> "The local shell command to execute to archive a completed WAL file segment. Any `%p` in the string is replaced by the path name of the file to archive, and any `%f` is replaced by only the file name. ... It is important for the command to return a zero exit status only if it succeeds."

Verbatim definition of `archive_library`[^archive-library]:

> "The library to use for archiving completed WAL file segments. If set to an empty string (the default), archiving via shell is enabled, and archive_command is used. If both `archive_command` and `archive_library` are set, an error will be raised."

> [!NOTE] PostgreSQL 15
> `archive_library` introduced. Verbatim: *"Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."*[^pg15-archive-lib]. Bundled `basic_archive` module is a reference implementation that simply copies WAL to a directory.

> [!NOTE] PostgreSQL 16
> Three relevant changes. (1) `archive_library` and `archive_command` mutually exclusive: *"Prevent `archive_library` and `archive_command` from being set at the same time (Nathan Bossart). Previously `archive_library` would override `archive_command`."*[^pg16-mutex]. (2) Archive modules redesigned: *"Redesign archive modules to be more flexible (Nathan Bossart). Initialization changes will require modules written for older versions of Postgres to be updated."*[^pg16-redesign]. (3) Durable-rename restriction relaxed: *"Remove restrictions that archive files be durably renamed (Nathan Bossart). The `archive_command` command is now more likely to be called with already-archived files after a crash."*[^pg16-durable].

#### `archive_command` example (NOT durable)

    archive_command = 'cp %p /var/lib/pgsql/archive/%f'

**Wrong.** `cp` returns 0 before `fsync`. After a crash, the WAL may not be on disk. Also overwrites silently if `%f` exists.

#### `archive_command` example (durable)

    archive_command = 'test ! -f /var/lib/pgsql/archive/%f && cp %p /var/lib/pgsql/archive/%f && fsync /var/lib/pgsql/archive/%f'

Refuses to overwrite. `fsync` ensures durability. Production teams use **pgBackRest** / **Barman** / **WAL-G** instead — see [`85-backup-tools.md`](./85-backup-tools.md).

#### `archive_library` example

    shared_preload_libraries = 'basic_archive'  # If using basic_archive
    archive_library = 'basic_archive'
    basic_archive.archive_directory = '/var/lib/pgsql/archive'

Restart required for `archive_library` change. `basic_archive` is reference module; production uses pgBackRest custom module or similar.

#### Monitoring archiving

Check `pg_stat_archiver`:

    SELECT archived_count, last_archived_wal, last_archived_time,
           failed_count, last_failed_wal, last_failed_time
    FROM pg_stat_archiver;

`failed_count > 0` means recent failures — investigate `last_failed_wal`. If `archive_command` fails, PostgreSQL retries forever, accumulates WAL in `pg_wal/` → disk fill.

### Restore + recovery targets

To restore from base backup + WAL archive:

1. Stop PostgreSQL on target server.
2. Wipe / move existing data directory.
3. Restore base backup contents into data directory.
4. Configure `postgresql.conf` with `restore_command`.
5. Configure `recovery_target_*` if PITR (omit for end-of-archive recovery).
6. Create `recovery.signal` empty file in data directory.
7. Start PostgreSQL.

Verbatim definition of `restore_command`[^restore-command]:

> "The local shell command to execute to retrieve an archived segment of the WAL file series. This parameter is required for archive recovery, but optional for streaming replication. Any `%f` in the string is replaced by the name of the file to retrieve from the archive, and any `%p` is replaced by the copy destination path name on the server."

Example:

    restore_command = 'cp /var/lib/pgsql/archive/%f %p'

> [!NOTE] PostgreSQL 14
> `restore_command` reloadable. Verbatim: *"Allow the `restore_command` setting to be changed during a server reload (Sergei Kornilov). You can also set `restore_command` to an empty string and reload to force recovery to only read from the `pg_wal` directory."*[^pg14-restore]. Before PG14 changing `restore_command` required server restart.

#### Recovery targets

Five `recovery_target_*` settings select stopping point. **At most one may be set** — PG12+ errors if multiple are set in same configuration.

| Setting | Type | Meaning |
|---|---|---|
| `recovery_target_time` | timestamptz | Stop at commit immediately after this timestamp |
| `recovery_target_xid` | integer | Stop after specified transaction ID commits (or aborts) |
| `recovery_target_name` | text | Stop at named restore point created by `pg_create_restore_point()` |
| `recovery_target_lsn` | pg_lsn | Stop at first transaction after this LSN |
| `recovery_target = 'immediate'` | special | Stop as soon as consistent state reached (right at end of base-backup `pg_stop_backup`) |

Plus `recovery_target_inclusive` (default `on` = stop AFTER target; `off` = stop BEFORE) and `recovery_target_timeline` (default `latest`).

> [!WARNING] `recovery_target_inclusive` default
> Default is `true` (stop AFTER target). If you want to stop right BEFORE a problematic transaction at XID 5000, set `recovery_target_xid = 5000` AND `recovery_target_inclusive = off`.

### End-of-recovery actions

Verbatim definition of `recovery_target_action`[^recovery-action]:

> "Specifies what action the server should take once the recovery target is reached. The default is `pause`, which means recovery will be paused. `promote` means the recovery process will finish and the server will start to accept connections. Finally `shutdown` will stop the server after reaching the recovery target."

| Action | Behavior | Use case |
|---|---|---|
| `pause` (default) | Recovery stops at target; server stays in recovery mode; query via read-only connection | Verify the recovery state before commit |
| `promote` | Recovery completes; server promotes to primary; accepts writes; timeline incremented | Production rollback decisions |
| `shutdown` | Recovery stops; server shuts down | Inspect data dir offline before deciding |

Workflow: set `recovery_target_action = pause` initially; connect via `psql`; verify data state via `SELECT * FROM critical_table WHERE ...`; if good, run `SELECT pg_wal_replay_resume();` and the server promotes; if wrong, shut down and restart with different `recovery_target_time`.

### Incremental backups (PG17+)

PG17 added incremental file system backup. Three components: WAL summarization (background process), `pg_basebackup --incremental`, `pg_combinebackup`.

> [!NOTE] PostgreSQL 17 — incremental backup
> Verbatim: *"Add support for incremental file system backup (Robert Haas, Jakub Wartak, Tomas Vondra). Incremental backups can be created using pg_basebackup's new `--incremental` option. The new application pg_combinebackup allows manipulation of base and incremental file system backups."*[^pg17-incremental]. Plus *"Add application pg_walsummary to dump WAL summary files (Robert Haas)"*[^pg17-walsummary]. Plus *"Allow the creation of WAL summarization files (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski). These files record the block numbers that have changed within an LSN range and are useful for incremental file system backups. This is controlled by the server variables `summarize_wal` and `wal_summary_keep_time`, and introspected with `pg_available_wal_summaries()`, `pg_wal_summary_contents()`, and `pg_get_wal_summarizer_state()`."*[^pg17-summarize-wal].

#### Required setup

    -- On the source server:
    ALTER SYSTEM SET summarize_wal = on;
    ALTER SYSTEM SET wal_summary_keep_time = '14 days';  -- default 10 days
    SELECT pg_reload_conf();

Restart not required. `walsummarizer` background process starts producing `.summary` files in `$PGDATA/pg_wal/summaries/`.

#### Taking incremental backups

    # Day 1: full base backup
    pg_basebackup -D /backups/full -X stream -c fast

    # Day 2: incremental against the full backup's manifest
    pg_basebackup -D /backups/incr1 \
      --incremental=/backups/full/backup_manifest \
      -X stream -c fast

    # Day 3: incremental against the previous incremental's manifest
    pg_basebackup -D /backups/incr2 \
      --incremental=/backups/incr1/backup_manifest \
      -X stream -c fast

Each incremental's manifest references the prior backup's manifest. Chain of `full → incr1 → incr2 → ...` must be unbroken.

#### Combining backups

`pg_combinebackup` synthesizes a full backup from a chain:

    pg_combinebackup /backups/full /backups/incr1 /backups/incr2 \
      -o /backups/synthetic_full

Verbatim definition[^pg-combinebackup]:

> "pg_combinebackup is used to reconstruct a synthetic full backup from an incremental backup and the earlier backups upon which it depends."

The synthetic full backup is a standalone PGDATA directory — restore from it like any other base backup.

> [!NOTE] PostgreSQL 18
> `pg_combinebackup --link` for hard-linking unchanged files. Verbatim: *"Add pg_combinebackup option `-k`/`--link` to enable hard linking (Israel Barth Rubio, Robert Haas). Only some files can be hard linked. This should not be used if the backups will be used independently."*[^pg18-combinebackup-link]. Saves disk space + reconstruct-time but synthetic backup shares inodes with sources; modifying one corrupts the others.

#### Inspecting WAL summaries

`pg_walsummary` dumps `.summary` files for debugging:

    pg_walsummary /var/lib/pgsql/16/data/pg_wal/summaries/0000000100000001000000A0.summary

Verbatim purpose[^pg-walsummary]:

> "pg_walsummary is used to print the contents of WAL summary files. These binary files are found with the `pg_wal/summaries` subdirectory of the data directory, and can be converted to text using this tool. This is not ordinarily necessary, since WAL summary files primarily exist to support incremental backup, but it may be useful for debugging purposes."

### Per-version timeline

| Version | Items |
|---|---|
| **PG14** | (1) `restore_command` reloadable on SIGHUP (Sergei Kornilov)[^pg14-restore]. |
| **PG15** | (1) `archive_library` introduced (Nathan Bossart)[^pg15-archive-lib]. (2) `pg_basebackup --target=server` for server-side write (Robert Haas)[^pg15-target]. (3) Server-side LZ4 + Zstandard + client-side LZ4 + Zstandard compression (Dipesh Pandit, Jeevan Ladhe)[^pg15-compression]. (4) `pg_basebackup --compress` redesigned for compression location + method + options (Michael Paquier, Robert Haas)[^pg15-compress-redesign]. (5) `recovery_prefetch` for WAL prefetching (Thomas Munro)[^pg15-recovery-prefetch]. (6) Checkpointer + bgwriter run during crash recovery (Thomas Munro)[^pg15-checkpointer-recovery]. |
| **PG16** | (1) `archive_library` + `archive_command` mutually exclusive (Nathan Bossart)[^pg16-mutex]. (2) Archive modules redesigned (Nathan Bossart)[^pg16-redesign]. (3) Durable-rename restriction relaxed (Nathan Bossart)[^pg16-durable]. (4) `pg_basebackup` tablespaces-in-PGDATA fix (Robert Haas)[^pg16-tspc]. (5) Numeric compression option syntax (Georgios Kokolatos, Michael Paquier)[^pg16-numeric]. (6) Long-mode compression for pg_basebackup + pg_dump (Justin Pryzby)[^pg16-long]. |
| **PG17** | (1) Incremental backup via `pg_basebackup --incremental` (Robert Haas, Jakub Wartak, Tomas Vondra)[^pg17-incremental]. (2) `pg_combinebackup` (same). (3) `pg_walsummary` (Robert Haas)[^pg17-walsummary]. (4) WAL summarization via `summarize_wal` + `wal_summary_keep_time` (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski)[^pg17-summarize-wal]. |
| **PG18** | (1) `pg_combinebackup -k`/`--link` hard-link mode (Israel Barth Rubio, Robert Haas)[^pg18-combinebackup-link]. (2) `pg_verifybackup` tar-format support (Amul Sul)[^pg18-verify]. **No direct `pg_basebackup` core changes. No `archive_command` / `archive_library` / `restore_command` / `recovery_target_*` changes.** |

> [!NOTE] PG14 / PG15 / PG16 / PG17 / PG18
> Every PG14-18 version contributed substantive items. Eleventh file in the skill where every PG14-18 contributed (after iter 65 perf-diagnostics, iter 66 planner-tuning, iter 75 catalogs, iter 78 cli-tools, iter 81 fdw, iter 83 ext-dev, iter 84 streaming-rep, iter 85 logical-rep, iter 86 slots, iter 87 logical-decoding, iter 92 pgBouncer, iter 93 monitoring, iter 94 pg_dump).

## Examples / Recipes

### Recipe 1: Production baseline — base backup + continuous archiving

Single primary, baseline configuration. Cross-reference [`33-wal.md`](./33-wal.md) for WAL volume tuning.

`postgresql.conf` snippet:

    # WAL level required for archiving
    wal_level = replica
    max_wal_senders = 10
    max_replication_slots = 10

    # Archiving
    archive_mode = on
    archive_command = '/usr/local/bin/pgbackrest --stanza=main archive-push %p'
    # OR (PG15+):
    # archive_library = 'basic_archive'
    # basic_archive.archive_directory = '/var/lib/pgsql/archive'

    # Bound WAL retention if using replication slots
    max_slot_wal_keep_size = 64GB

    # PITR-friendly checkpoint cadence (longer = more WAL replay on restore but
    # less I/O overhead in steady state)
    checkpoint_timeout = 15min
    max_wal_size = 16GB

Restart required for `wal_level` and `archive_mode` changes.

Take initial base backup:

    pg_basebackup \
      --pgdata=/backups/full_$(date +%Y%m%d) \
      --format=plain \
      --wal-method=stream \
      --checkpoint=fast \
      --compress=server-zstd:3 \
      --progress \
      --verbose \
      --manifest-checksums=CRC32C \
      --label="initial full $(date +%Y%m%d_%H%M%S)"

Verify:

    pg_verifybackup /backups/full_$(date +%Y%m%d)

Monitor archive state:

    SELECT archived_count, last_archived_wal, last_archived_time,
           failed_count, last_failed_wal, last_failed_time,
           now() - last_archived_time AS lag
    FROM pg_stat_archiver;

### Recipe 2: PITR walkthrough — restore to specific time

Scenario: production cluster on PG16; at 14:32 UTC someone ran `DELETE FROM orders WHERE created < '2026-05-01'` against the wrong database. WAL archive has been running for weeks; nightly base backups available.

Goal: restore cluster state to 14:31 UTC (one minute before the disaster).

Procedure:

    # 1. On a fresh server (NOT the primary), stop PG if running
    sudo systemctl stop postgresql-16

    # 2. Wipe the target data directory (verify path FIRST)
    sudo rm -rf /var/lib/pgsql/16/data
    sudo -u postgres mkdir -p /var/lib/pgsql/16/data
    sudo -u postgres chmod 0700 /var/lib/pgsql/16/data

    # 3. Restore the most recent base backup taken BEFORE 14:32 UTC
    sudo -u postgres tar -xf /backups/full_20260513.tar \
      -C /var/lib/pgsql/16/data

    # 4. Write recovery configuration into postgresql.auto.conf
    sudo -u postgres tee -a /var/lib/pgsql/16/data/postgresql.auto.conf <<'EOF'
    restore_command = 'cp /backups/archive/%f %p'
    recovery_target_time = '2026-05-13 14:31:00+00'
    recovery_target_inclusive = on
    recovery_target_action = pause
    EOF

    # 5. Create recovery.signal to enter archive recovery
    sudo -u postgres touch /var/lib/pgsql/16/data/recovery.signal

    # 6. Start the server
    sudo systemctl start postgresql-16

    # 7. Watch the log; server should report "consistent recovery state reached"
    # then "recovery stopping after target".
    sudo tail -f /var/lib/pgsql/16/log/postgresql-*.log

    # 8. Connect and verify
    psql -c "SELECT count(*) FROM orders WHERE created < '2026-05-01';"

If correct, promote:

    psql -c "SELECT pg_wal_replay_resume();"

After `pg_wal_replay_resume()`, server completes recovery, timeline increments, accepts writes. Cluster is now ON A NEW TIMELINE — the old primary should NOT be re-attached without `pg_rewind` (see [`89-pg-rewind.md`](./89-pg-rewind.md)).

If recovery state is wrong, shut down and restart with different `recovery_target_time`:

    sudo systemctl stop postgresql-16
    # Edit postgresql.auto.conf, change recovery_target_time
    sudo systemctl start postgresql-16

### Recipe 3: Named restore point before risky DDL

Before destructive DDL, create a restore point on the primary:

    -- Before risky operation
    SELECT pg_create_restore_point('before_user_table_rebuild');

    -- ... do risky DDL ...
    DROP TABLE legacy_users;
    -- ... realize that was wrong ...

The restore point name written into WAL. Recover to it via PITR:

    # In recovery configuration:
    recovery_target_name = 'before_user_table_rebuild'
    recovery_target_inclusive = on
    recovery_target_action = pause

Recovery stops at the WAL record containing that name, then pauses for verification.

### Recipe 4: Setting up a streaming standby via `pg_basebackup`

Streaming standby is the most common use of `pg_basebackup`:

    # On standby server, as postgres user, with empty data dir
    pg_basebackup \
      --pgdata=/var/lib/pgsql/16/data \
      --wal-method=stream \
      --write-recovery-conf \
      --slot=standby01 \
      --host=primary.example.com \
      --port=5432 \
      --username=replicator \
      --progress

The `-R` flag (`--write-recovery-conf`) writes the following into `postgresql.auto.conf`:

    primary_conninfo = 'user=replicator host=primary.example.com port=5432 ...'
    primary_slot_name = 'standby01'

And creates `standby.signal` (empty file) in data directory.

Pre-create the slot on the primary before backup:

    -- On primary
    SELECT pg_create_physical_replication_slot('standby01');

Start the standby; it begins streaming replication immediately. Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) for full standby setup.

### Recipe 5: Server-side compression for offsite backup (PG15+)

Saves client-server bandwidth on the backup network path:

    pg_basebackup \
      --pgdata=/backups/full_$(date +%Y%m%d).tar.zst \
      --format=tar \
      --target=client \
      --wal-method=stream \
      --compress=server-zstd:6 \
      --label="weekly full"

Server reads + compresses + streams compressed bytes. Client just writes them. Saves CPU on backup-orchestrator host and bytes on network.

Server-side compression to server-local path (requires `pg_write_server_files`):

    pg_basebackup \
      --target=server:/var/lib/pgsql/backups/full \
      --compress=server-zstd:6 \
      --wal-method=stream \
      --format=tar

### Recipe 6: PG17+ incremental backup chain

Setup:

    -- One-time: enable WAL summarization
    ALTER SYSTEM SET summarize_wal = on;
    ALTER SYSTEM SET wal_summary_keep_time = '14 days';
    SELECT pg_reload_conf();

    -- Verify summarizer process is running
    SELECT * FROM pg_get_wal_summarizer_state();

Weekly full + daily incremental:

    # Sunday — full backup
    pg_basebackup -D /backups/full -X stream -c fast --label="full $(date)"

    # Monday — incremental against the full
    pg_basebackup -D /backups/incr_mon \
      --incremental=/backups/full/backup_manifest \
      -X stream -c fast --label="incremental Mon"

    # Tuesday — incremental against Monday's incremental
    pg_basebackup -D /backups/incr_tue \
      --incremental=/backups/incr_mon/backup_manifest \
      -X stream -c fast --label="incremental Tue"

    # ... etc through Saturday

Restore via `pg_combinebackup`:

    pg_combinebackup \
      /backups/full \
      /backups/incr_mon \
      /backups/incr_tue \
      -o /var/lib/pgsql/16/data \
      --tablespace-mapping=/old/path=/new/path  # if tablespaces

Then run normal PITR procedure (Recipe 2) using `/var/lib/pgsql/16/data` as the base.

PG18+ hard-link to save disk:

    pg_combinebackup \
      /backups/full \
      /backups/incr_mon \
      /backups/incr_tue \
      --link \
      -o /var/lib/pgsql/16/data

> [!WARNING] `--link` shares inodes
> Hard-linking is only safe if the synthetic backup is consumed once and discarded. Any write to a hard-linked file corrupts ALL backups sharing that inode.

### Recipe 7: Stop-the-line PITR — recover to LSN

When you know exactly which transaction caused damage:

    # Find the LSN of the bad transaction (from primary logs or pg_stat_activity audit)
    # Example: bad transaction at LSN 1/A8000000

    # In recovery configuration:
    recovery_target_lsn = '1/A8000000'
    recovery_target_inclusive = off  # stop BEFORE this LSN
    recovery_target_action = pause

`recovery_target_lsn` is finest-grained PITR target (per-byte resolution in WAL); timestamp resolution is COMMIT-record-granularity.

### Recipe 8: Diagnose archive lag

If `pg_stat_archiver.last_archived_time` is far behind:

    SELECT now() - last_archived_time AS archive_lag,
           pg_walfile_name(pg_current_wal_lsn()) AS current_wal,
           last_archived_wal,
           failed_count,
           last_failed_wal,
           last_failed_time,
           now() - last_failed_time AS time_since_failure
    FROM pg_stat_archiver;

If `failed_count > 0` and `last_failed_time` is recent, examine the server log for the actual error from `archive_command` / `archive_library`. PostgreSQL retries archiving forever — failures accumulate WAL in `pg_wal/` and eventually exhaust disk.

Common archive failures:

| Symptom | Cause | Fix |
|---|---|---|
| `cp: cannot create` | Target directory missing or read-only | Check permissions; create directory |
| `archive_command failed with exit code 1` | Wrong command syntax (e.g., `cp %p /archive` without `/%f`) | Test command with sample WAL segment |
| `file already exists` | Idempotency missing | Use `test ! -f /archive/%f && cp ...` |
| `No space left on device` | Archive target full | Provision more storage; consider retention policy |
| `connection refused` (network archive) | Network problem | Validate connectivity; use retries |

### Recipe 9: Cancel + restart in-progress base backup

To cancel running `pg_basebackup` cleanly:

    # On the client (running pg_basebackup):
    kill -INT <pid>

    # On the server, terminate the replication walsender:
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_replication
    WHERE application_name = 'pg_basebackup';

    # If using a replication slot, drop and recreate:
    SELECT pg_drop_replication_slot('backup_slot');
    SELECT pg_create_physical_replication_slot('backup_slot');

Cancellation is safe; no on-server state to clean up other than the slot.

### Recipe 10: Test base backup is restorable (verify weekly)

Discipline: every base backup gets a test restore. Schedule weekly:

    #!/bin/bash
    # Test restore on a disposable host
    set -e
    BACKUP=$(ls -td /backups/full_* | head -1)
    TARGET=/tmp/restore_test/$(basename $BACKUP)
    rm -rf $TARGET
    mkdir -p $TARGET
    cp -r $BACKUP/* $TARGET/
    pg_verifybackup $TARGET

    # Try to start it (different port to avoid conflict)
    pg_ctl -D $TARGET -o "-p 6543" start
    sleep 5
    psql -p 6543 -c "SELECT now();"
    pg_ctl -D $TARGET stop

    rm -rf $TARGET

Schedule via cron weekly. Catch corruption / misconfiguration before disaster.

### Recipe 11: Audit WAL retention slots blocking archive cleanup

Replication slots + `archive_mode = on` work together: WAL recycled only after BOTH being archived AND no replication slot needs it. Audit:

    SELECT slot_name, slot_type, active,
           pg_size_pretty(
             pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
           ) AS retained_wal,
           wal_status
    FROM pg_replication_slots
    ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;

Slots with `retained_wal > 10GB` are the most common cause of disk-fill emergencies. Cross-reference [`75-replication-slots.md`](./75-replication-slots.md).

### Recipe 12: Build a standalone "hot backup" snapshot using `pg_backup_start`/`pg_backup_stop`

For external snapshot tools (LVM, filesystem snapshots, cloud volume snapshots):

    -- Mark beginning of backup; obtains low-level backup label
    SELECT pg_backup_start('snapshot_2026_05_13', false);  -- false = spread checkpoint

    -- ... take volume snapshot via your provisioner (LVM, EBS, etc.) ...

    -- Mark end of backup; returns LSN and label file content
    SELECT * FROM pg_backup_stop(true);  -- true = wait for archive

    -- Store the returned 'labelfile' content as backup_label inside the snapshot
    -- This file is REQUIRED for the snapshot to be restorable.

`pg_backup_start`/`pg_backup_stop` replaced `pg_start_backup`/`pg_stop_backup` in PG15. Pre-PG15 used old names. Cross-reference [`33-wal.md`](./33-wal.md) for `backup_label` mechanics.

### Recipe 13: Recovery target = `immediate` for cleanest base-backup restore

If you just want to restore base backup with NO WAL replay beyond what's required for consistency:

    restore_command = 'cp /backups/archive/%f %p'
    recovery_target = 'immediate'
    recovery_target_action = promote

Verbatim definition[^recovery-target-immediate]:

> "This parameter specifies that recovery should end as soon as a consistent state is reached, i.e., as early as possible. When restoring from an online backup, this means the point where taking the backup ended."

Useful for "restore last full backup with no point-in-time twist" — server promotes the moment WAL replay reaches `pg_backup_stop` end-LSN.

## Gotchas / Anti-patterns

1. **`recovery.conf` is gone — PG12+ uses `postgresql.conf` + signal files.** Pre-PG12 tutorials are obsolete. `recovery.signal` triggers archive recovery; `standby.signal` triggers streaming-standby mode. Cross-reference [`77-standby-failover.md`](./77-standby-failover.md).

2. **`archive_library` and `archive_command` are mutually exclusive in PG16+.** Earlier versions: `archive_library` silently overrode `archive_command`. Now setting both is hard error. Pick one.

3. **`archive_command` returning 0 without `fsync` = silent corruption.** `cp %p /archive/%f` looks correct but `cp` returns before the file is durable. Use durable wrappers: `test ! -f /archive/%f && cp %p /archive/%f && fsync /archive/%f`. Production teams use pgBackRest / Barman / WAL-G which handle durability.

4. **Base backup without WAL archive = restore to backup-end-LSN only.** No PITR possible. To enable PITR, set up continuous archiving BEFORE taking the base backup.

5. **`-X fetch` is brittle.** Single-connection WAL retrieval at end of backup; if backup takes longer than `wal_keep_size` worth of WAL is retained, backup is unusable. Always use `-X stream`.

6. **PG17 incremental backup requires `summarize_wal = on` BEFORE the base backup.** WAL summaries are written only after `summarize_wal` is enabled. An incremental against a base backup taken before summarization started will fail.

7. **`pg_combinebackup` requires complete chain.** If any incremental in the chain is missing, the synthetic restore fails. Retain at least one full + complete chain.

8. **`pg_combinebackup --link` (PG18+) shares inodes.** Modifying or reorganizing one of the linked files corrupts the others. Only use for one-shot consumption.

9. **`recovery_target_inclusive` default is `on` — stops AFTER target.** Want to stop BEFORE a specific bad transaction at XID 5000? Set `recovery_target_xid = 5000` AND `recovery_target_inclusive = off`.

10. **At most one `recovery_target_*` setting may be active.** Setting two raises an error on PG12+ (verbatim from `runtime-config-wal.html`). Comment out unused settings explicitly.

11. **`recovery_target_action = pause` (default) leaves server in recovery mode.** Connections are read-only. Run `SELECT pg_wal_replay_resume();` to promote; `pg_ctl stop` to shut down without promotion; restart with different target to retry.

12. **`pg_basebackup` to local disk uses local disk.** No magic — if the backup destination is the same disk as `$PGDATA`, you've doubled disk usage and an `fsync` storm. Mount backup-destination disk separately.

13. **`pg_basebackup` from a standby works** — but the standby must be running with `hot_standby = on` and the backup will include only WAL that was applied at the standby up to the backup-start time. Verify the standby is not lagging.

14. **`max_slot_wal_keep_size` default is `-1` (unlimited).** Set to a finite size in production to prevent abandoned replication slots from filling `pg_wal/`. See [`75-replication-slots.md`](./75-replication-slots.md).

15. **`archive_mode = always` (not `on`) archives on standbys too.** Useful if primary's archive target is unreachable but standby's is reachable. Without `always`, only primary archives, so a primary's outage breaks archiving.

16. **Tablespaces require `--tablespace-mapping`.** `pg_basebackup` of a cluster with tablespaces must remap them to new paths on the destination: `pg_basebackup --tablespace-mapping=/old/ts1=/new/ts1 ...` for each. Otherwise restore fails. Same for `pg_combinebackup`.

17. **Cross-version restore is impossible.** PG16 base backup cannot restore on PG17. Use logical backup ([`83-backup-pg-dump.md`](./83-backup-pg-dump.md)) or logical replication ([`74-logical-replication.md`](./74-logical-replication.md)) for cross-version migration.

18. **Cross-architecture restore is impossible.** x86 base backup cannot restore on ARM. Endianness + pointer size differ.

19. **`pg_basebackup` runs at primary's I/O cost.** During backup, primary reads entire cluster + ships WAL. Spread checkpoint (`-c spread`, default) mitigates checkpoint storm; `--max-rate` throttles network. Don't run during peak hours without throttling.

20. **`pg_verifybackup` validates manifest only.** Doesn't catch WAL corruption between backup-start LSN and backup-end LSN. Pair with periodic test-restores (Recipe 10).

21. **PG15 server-side compression to `--target=server` requires `pg_write_server_files` role membership.** Otherwise: `permission denied`. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #14.

22. **PG14 `restore_command` reload doesn't affect already-recovering server's already-loaded value if recovery has actively started.** Reload affects subsequent attempts at restore_command-invocation; in-flight calls continue with old value.

23. **PG18 has ZERO direct `pg_basebackup` / `archive_command` / `archive_library` / `restore_command` / `recovery_target_*` changes.** The only PG18 backup-related items are `pg_combinebackup --link` and `pg_verifybackup` tar support. If a tutorial claims PG18 changed pg_basebackup core or PITR mechanics, verify against the release notes directly.

24. **Archive recovery requires `wal_level = replica` minimum.** If primary was configured with `wal_level = minimal`, the WAL archive is unusable for PITR (does not contain enough information). Switch to `replica` or `logical` BEFORE relying on PITR.

## See Also

- [`33-wal.md`](./33-wal.md) — WAL volume tuning, `wal_level`, checkpoint frequency
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint mechanics
- [`73-streaming-replication.md`](./73-streaming-replication.md) — BASE_BACKUP protocol, standby setup, `recovery.conf` removal
- [`75-replication-slots.md`](./75-replication-slots.md) — slot mechanics, `max_slot_wal_keep_size`
- [`77-standby-failover.md`](./77-standby-failover.md) — `standby.signal` / `recovery.signal`, `recovery_target_action`, pg_promote
- [`78-ha-architectures.md`](./78-ha-architectures.md) — HA patterns
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — logical backup contrast
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest / Barman / WAL-G production wrappers
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — in-place upgrade contrast
- [`89-pg-rewind.md`](./89-pg-rewind.md) — re-attach diverged primary after PITR-promotion
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — DR runbook
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pg_write_server_files` for `pg_basebackup --target=server`

## Sources

[^archive-command]: PostgreSQL 16 documentation, "20.5 Write Ahead Log — archive_command", https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-ARCHIVE-COMMAND
[^archive-library]: PostgreSQL 16 documentation, "20.5 Write Ahead Log — archive_library", https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-ARCHIVE-LIBRARY
[^restore-command]: PostgreSQL 16 documentation, "20.5 Write Ahead Log — restore_command", https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-RESTORE-COMMAND
[^recovery-action]: PostgreSQL 16 documentation, "20.5 Write Ahead Log — recovery_target_action", https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-RECOVERY-TARGET-ACTION
[^recovery-target-immediate]: PostgreSQL 16 documentation, "20.5 Write Ahead Log — recovery_target = immediate", https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-RECOVERY-TARGET
[^pg-combinebackup]: PostgreSQL 17 documentation, "pg_combinebackup", https://www.postgresql.org/docs/17/app-pgcombinebackup.html — verbatim: "pg_combinebackup is used to reconstruct a synthetic full backup from an incremental backup and the earlier backups upon which it depends."
[^pg-walsummary]: PostgreSQL 17 documentation, "pg_walsummary", https://www.postgresql.org/docs/17/app-pgwalsummary.html — verbatim: "pg_walsummary is used to print the contents of WAL summary files. ... it may be useful for debugging purposes."
[^pg14-restore]: PostgreSQL 14 release notes, https://www.postgresql.org/docs/release/14.0/ — verbatim: "Allow the `restore_command` setting to be changed during a server reload (Sergei Kornilov). You can also set `restore_command` to an empty string and reload to force recovery to only read from the `pg_wal` directory."
[^pg15-archive-lib]: PostgreSQL 15 release notes, https://www.postgresql.org/docs/release/15.0/ — verbatim: "Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."
[^pg15-target]: PostgreSQL 15 release notes, https://www.postgresql.org/docs/release/15.0/ — verbatim: "Add new pg_basebackup option `--target` to control the base backup location (Robert Haas). The new options are `server` to write the backup locally and `blackhole` to discard the backup (for testing)."
[^pg15-compression]: PostgreSQL 15 release notes, https://www.postgresql.org/docs/release/15.0/ — verbatim: "Allow pg_basebackup to do server-side gzip, LZ4, and Zstandard compression and client-side LZ4 and Zstandard compression of base backup files (Dipesh Pandit, Jeevan Ladhe)"
[^pg15-compress-redesign]: PostgreSQL 15 release notes, https://www.postgresql.org/docs/release/15.0/ — verbatim: "Allow pg_basebackup's `--compress` option to control the compression location (server or client), compression method, and compression options (Michael Paquier, Robert Haas)"
[^pg15-recovery-prefetch]: PostgreSQL 15 release notes, https://www.postgresql.org/docs/release/15.0/ — verbatim: "Allow WAL processing to pre-fetch needed file contents (Thomas Munro). This is controlled by the server variable `recovery_prefetch`."
[^pg15-checkpointer-recovery]: PostgreSQL 15 release notes, https://www.postgresql.org/docs/release/15.0/ — verbatim: "Run the checkpointer and bgwriter processes during crash recovery (Thomas Munro). This helps to speed up long crash recoveries."
[^pg16-mutex]: PostgreSQL 16 release notes, https://www.postgresql.org/docs/release/16.0/ — verbatim: "Prevent `archive_library` and `archive_command` from being set at the same time (Nathan Bossart). Previously `archive_library` would override `archive_command`."
[^pg16-redesign]: PostgreSQL 16 release notes, https://www.postgresql.org/docs/release/16.0/ — verbatim: "Redesign archive modules to be more flexible (Nathan Bossart). Initialization changes will require modules written for older versions of Postgres to be updated."
[^pg16-durable]: PostgreSQL 16 release notes, https://www.postgresql.org/docs/release/16.0/ — verbatim: "Remove restrictions that archive files be durably renamed (Nathan Bossart). The `archive_command` command is now more likely to be called with already-archived files after a crash."
[^pg16-tspc]: PostgreSQL 16 release notes, https://www.postgresql.org/docs/release/16.0/ — verbatim: "Fix pg_basebackup to handle tablespaces stored in the PGDATA directory (Robert Haas)"
[^pg16-numeric]: PostgreSQL 16 release notes, https://www.postgresql.org/docs/release/16.0/ — verbatim: "Improve pg_basebackup to accept numeric compression options (Georgios Kokolatos, Michael Paquier). Options like `--compress=server-5` are now supported."
[^pg16-long]: PostgreSQL 16 release notes, https://www.postgresql.org/docs/release/16.0/ — verbatim: "Allow pg_dump and pg_basebackup to use `long` mode for compression (Justin Pryzby)"
[^pg17-incremental]: PostgreSQL 17 release notes, https://www.postgresql.org/docs/release/17.0/ — verbatim: "Add support for incremental file system backup (Robert Haas, Jakub Wartak, Tomas Vondra). Incremental backups can be created using pg_basebackup's new `--incremental` option. The new application pg_combinebackup allows manipulation of base and incremental file system backups."
[^pg17-walsummary]: PostgreSQL 17 release notes, https://www.postgresql.org/docs/release/17.0/ — verbatim: "Add application pg_walsummary to dump WAL summary files (Robert Haas)"
[^pg17-summarize-wal]: PostgreSQL 17 release notes, https://www.postgresql.org/docs/release/17.0/ — verbatim: "Allow the creation of WAL summarization files (Robert Haas, Nathan Bossart, Hubert Depesz Lubaczewski). These files record the block numbers that have changed within an LSN range and are useful for incremental file system backups. This is controlled by the server variables `summarize_wal` and `wal_summary_keep_time`, and introspected with `pg_available_wal_summaries()`, `pg_wal_summary_contents()`, and `pg_get_wal_summarizer_state()`."
[^pg18-combinebackup-link]: PostgreSQL 18 release notes, https://www.postgresql.org/docs/release/18.0/ — verbatim: "Add pg_combinebackup option `-k`/`--link` to enable hard linking (Israel Barth Rubio, Robert Haas). Only some files can be hard linked. This should not be used if the backups will be used independently."
[^pg18-verify]: PostgreSQL 18 release notes, https://www.postgresql.org/docs/release/18.0/ — verbatim: "Allow pg_verifybackup to verify tar-format backups (Amul Sul)"

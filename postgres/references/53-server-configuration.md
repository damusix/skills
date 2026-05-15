# Server Configuration: GUCs, postgresql.conf, ALTER SYSTEM, and SET

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The five-rule mental model](#the-five-rule-mental-model)
    - [Decision matrix](#decision-matrix)
    - [Parameter contexts (the seven contexts)](#parameter-contexts-the-seven-contexts)
    - [Precedence order](#precedence-order)
    - [postgresql.conf and postgresql.auto.conf](#postgresqlconf-and-postgresqlautoconf)
    - [Include directives](#include-directives)
    - [ALTER SYSTEM](#alter-system)
    - [SET, SET LOCAL, RESET](#set-set-local-reset)
    - [ALTER DATABASE SET and ALTER ROLE SET](#alter-database-set-and-alter-role-set)
    - [Reloading vs restarting](#reloading-vs-restarting)
    - [pg_settings and pg_file_settings](#pg_settings-and-pg_file_settings)
    - [Custom GUCs](#custom-gucs)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Open this file when working with `postgresql.conf`, `ALTER SYSTEM`, `SET` / `SET LOCAL`, the `pg_settings` view, per-role or per-database defaults, the seven parameter contexts (which decide who can change what and when it takes effect), reload-vs-restart semantics, or include directives. Each tunable parameter is a **GUC** ("Grand Unified Configuration") — the mechanism is uniform across memory tuning, WAL, autovacuum, replication, logging, planner knobs, and extension settings.

This file documents the **mechanism**. For the specific parameters operators tune most often, see `54-memory-tuning.md` (shared_buffers, work_mem, maintenance_work_mem), `28-vacuum-autovacuum.md` (autovacuum_*), `33-wal.md` (wal_*), `34-checkpoints-bgwriter.md` (checkpoint_*), `41-transactions.md` (statement_timeout and friends), `42-isolation-levels.md` (default_transaction_isolation), `46-roles-privileges.md` (per-role `ALTER ROLE SET` baselines), `49-tls-ssl.md` (ssl_*).

> [!WARNING] PG17 added `allow_alter_system`
>
> `ALTER SYSTEM` has historically been the only in-database way to persist a configuration change. PG17 added the `allow_alter_system` cluster GUC (default `on`) that, when set to `off` in `postgresql.conf`, makes the cluster reject `ALTER SYSTEM` commands.[^pg17-aas] This is intended for managed environments and Kubernetes operators that want to enforce configuration via `postgresql.conf` (or files inside it via `include_dir`) and prevent operators from drifting cluster state via `ALTER SYSTEM`. Recipe 7 walks through enabling it.

## Mental Model

### The five-rule mental model

1. **Every tunable is a GUC and every GUC has a context.** The seven contexts (`internal`, `postmaster`, `sighup`, `superuser-backend`, `backend`, `superuser`, `user`) decide *who* can change the value and *when* the change takes effect. `pg_settings.context` is the source of truth — if you don't know whether a parameter requires restart, look up its row.
2. **`ALTER SYSTEM` writes `postgresql.auto.conf`, not `postgresql.conf`.** They are separate files. Both are read at startup and at reload; `postgresql.auto.conf` overrides `postgresql.conf`.[^alter-system] If your `postgresql.conf` edit isn't taking effect, check whether `postgresql.auto.conf` is overriding it.
3. **Precedence is layered from most-narrow to most-broad.** `SET LOCAL` (transaction) → `SET` (session) → `ALTER ROLE ... IN DATABASE` (per-role-per-DB) → `ALTER ROLE SET` (per-role) → `ALTER DATABASE SET` (per-DB) → `postgresql.auto.conf` (ALTER SYSTEM) → `postgresql.conf` → command-line / compiled-in default (`boot_val`).
4. **SIGHUP reload only re-reads files; it does not re-bind existing sessions for non-`sighup`-context parameters.** A `superuser-backend` or `backend` parameter changed in `postgresql.conf` requires a *new session* to be observed; a `postmaster` parameter requires a *restart*; only `sighup` / `superuser` / `user` parameters apply live to existing sessions on reload. The `pg_settings.pending_restart` column flags settings waiting on a restart.
5. **`pg_settings` is truth; `pg_file_settings` is the file contents pre-apply.** Use `pg_settings` to find the *effective* value, its source, and whether it's pending a restart. Use `pg_file_settings` to validate a config edit *before* reloading (it shows every `name = value` entry across all `postgresql.conf` / `postgresql.auto.conf` / included files with a `applied` flag).

### Decision matrix

| You want to | Mechanism | Where it lands | Lifetime |
|---|---|---|---|
| Set a cluster-wide default | `postgresql.conf` (edit + reload) | `postgresql.conf` | Persistent across restarts |
| Set a cluster-wide default from SQL | `ALTER SYSTEM SET` | `postgresql.auto.conf` | Persistent across restarts |
| Override per-database | `ALTER DATABASE x SET y = ...` | `pg_db_role_setting` | Per-database, applies at session start |
| Override per-role (all databases) | `ALTER ROLE u SET y = ...` | `pg_db_role_setting` | Per-role, applies at login |
| Override per-role in one database | `ALTER ROLE u IN DATABASE d SET y = ...` | `pg_db_role_setting` | Per-role-per-DB, applies at session start |
| Override for current session | `SET y = ...` | Backend memory | Until disconnect or `RESET` |
| Override for current transaction | `SET LOCAL y = ...` | Backend memory | Until `COMMIT` / `ROLLBACK` |
| Read current effective value | `SHOW y` or `SELECT current_setting('y')` | — | — |
| Read where the value came from | `SELECT name, setting, source, sourcefile FROM pg_settings WHERE name = 'y'` | — | — |
| Validate config file before reloading | `SELECT * FROM pg_file_settings WHERE error IS NOT NULL OR NOT applied` | — | — |
| Reload after editing files | `pg_reload_conf()` or `pg_ctl reload` or `SELECT pg_reload_conf()` | — | Applies eligible changes; flags rest as `pending_restart` |
| Block `ALTER SYSTEM` cluster-wide (PG17+) | `allow_alter_system = off` in `postgresql.conf` | — | — |
| Grant non-superuser the ability to change one parameter (PG15+) | `GRANT SET ON PARAMETER y TO u` | `pg_parameter_acl` | Per-role grant |

Three smell signals:

- **"I set X in `postgresql.conf` but `SHOW X` still returns the old value":** check `pg_settings.source` — it will read `database`, `user`, or `session` if a narrower override is winning. Or it will be `pending_restart` if the parameter requires a server restart.
- **"My `ALTER SYSTEM SET` was rejected with `permission denied`":** the role lacks `pg_write_server_files` or hasn't been GRANT-ed `ALTER SYSTEM ON PARAMETER x` (PG15+). On PG17+, also check `allow_alter_system`.
- **"My `SET LOCAL` issued a `WARNING` and did nothing":** `SET LOCAL` outside a transaction is silently a no-op with a warning. Either wrap in `BEGIN; ... COMMIT;` or use `SET` for session scope.

### Parameter contexts (the seven contexts)

`pg_settings.context` documents how a parameter can be changed. There are exactly seven values, in order of restrictiveness:[^contexts]

| Context | Change requires | Who can change | New value visible to |
|---|---|---|---|
| `internal` | Rebuild server / re-`initdb` | — | All sessions |
| `postmaster` | Full server restart | superuser editing `postgresql.conf` or `ALTER SYSTEM` | All sessions after restart |
| `sighup` | SIGHUP reload (`pg_reload_conf()`) | superuser editing `postgresql.conf` or `ALTER SYSTEM` | All sessions after reload |
| `superuser-backend` | New session OR SIGHUP reload | superuser at SIGHUP; superuser via `PGOPTIONS` at session start | Subsequently-launched sessions |
| `backend` | New session OR SIGHUP reload | any user via `PGOPTIONS` at session start | Subsequently-launched sessions |
| `superuser` | `SET` in session or SIGHUP reload | superuser via `SET` (PG15+: GRANT-ed users too) | The session that issued `SET`; others on reload |
| `user` | `SET` in session or SIGHUP reload | any user via `SET` | The session that issued `SET`; others on reload |

Verbatim from the docs for the two most-easily-confused contexts:

- **`sighup`:** *"Changes to these settings can be made in `postgresql.conf` without restarting the server. Send a SIGHUP signal to the postmaster to cause it to re-read `postgresql.conf` and apply the changes. The postmaster will also forward the SIGHUP signal to its child processes so that they all pick up the new value."*[^contexts]
- **`superuser-backend`:** *"Changes to these settings can be made in `postgresql.conf` without restarting the server. ... However, these settings never change in a session after it is started. If you change them in `postgresql.conf`, send a SIGHUP signal to the postmaster to cause it to re-read `postgresql.conf`. The new values will only affect subsequently-launched sessions."*[^contexts]

The distinction matters: an `sighup` parameter (`log_min_messages`, `autovacuum_naptime`) applies to existing sessions after reload; a `superuser-backend` or `backend` parameter (`session_preload_libraries`, `temp_buffers`) does not — it requires the affected session to reconnect.

Find a parameter's context with `SELECT context FROM pg_settings WHERE name = 'work_mem'`.

### Precedence order

A GUC's effective value is determined by walking from most-narrow to most-broad scope. The narrowest layer that has set the value wins:[^alter-database] [^alter-role]

1. **`SET LOCAL` in the current transaction** — outranks everything for the duration of that transaction
2. **`SET` in the current session** — outranks per-role/per-DB for the rest of the session
3. **`ALTER ROLE u IN DATABASE d SET y = v`** — applies when `u` connects to `d`
4. **`ALTER ROLE u SET y = v`** — applies when `u` connects to any database
5. **`ALTER DATABASE d SET y = v`** — applies when any role connects to `d`
6. **`postgresql.auto.conf`** (set via `ALTER SYSTEM`) — applied at startup and SIGHUP
7. **`postgresql.conf`** — applied at startup and SIGHUP
8. **Command-line flags** to `postgres` / `pg_ctl start` — applied at startup
9. **Compiled-in default** (`pg_settings.boot_val`) — fallback

Verbatim docs precedence rule: *"Settings set for all databases are overridden by database-specific settings attached to a role. Settings for specific databases or specific roles override settings for all roles. ... database-role-specific settings override role-specific ones, which in turn override database-specific ones."*[^alter-role]

The `pg_settings.source` column tells you which layer won for the *current* value: `default`, `override`, `command line`, `configuration file`, `database`, `user`, `database user`, `session`, `client`. Use `pg_settings.sourcefile` and `pg_settings.sourceline` to find exactly which file and line.

### postgresql.conf and postgresql.auto.conf

Two files are read at every server start and SIGHUP reload:

- **`postgresql.conf`** — the canonical hand-edited configuration. Lives in `$PGDATA` by default; can be moved with the `config_file` command-line option.
- **`postgresql.auto.conf`** — written *automatically* by `ALTER SYSTEM`. Verbatim: *"Has the same format as `postgresql.conf` but is intended to be edited automatically, not manually. This file holds settings provided through the `ALTER SYSTEM` command. ... Settings in `postgresql.auto.conf` override those in `postgresql.conf`."*[^alter-system]

> [!WARNING] Do not hand-edit `postgresql.auto.conf`
>
> Although `postgresql.auto.conf` is a plain text file, `ALTER SYSTEM` rewrites it atomically. Manual edits race with `ALTER SYSTEM` calls and may be lost. Use `ALTER SYSTEM` to add lines and `ALTER SYSTEM RESET` to remove them; hand-edit only `postgresql.conf` (or its includes).

The startup sequence reads `postgresql.conf` first, then `postgresql.auto.conf`. Within each file, last-wins for duplicate parameter names. Across files, `postgresql.auto.conf` overrides `postgresql.conf`.

### Include directives

Both `postgresql.conf` and `pg_hba.conf`/`pg_ident.conf` (PG16+ for the latter two[^pg16-hba-include]) support three include directives:

```
include 'filename'
include_if_exists 'filename'
include_dir 'directory'
```

Verbatim from the docs:[^config-setting]

- **`include 'filename'`:** *"Reads and processes another file as if inserted at that point. Relative paths are relative to the referencing configuration file. Inclusions can be nested."*
- **`include_if_exists`:** *"acts the same as the `include` directive, except when the referenced file does not exist or cannot be read. A regular `include` will consider this an error condition, but `include_if_exists` merely logs a message and continues processing the referencing configuration file."*
- **`include_dir 'directory'`:** *"specify an entire directory of configuration files to include. Within the specified directory, only non-directory files whose names end with the suffix `.conf` will be included."* Files starting with `.` are ignored. Sorted by C-locale rules.

> [!NOTE] PostgreSQL 16: 10-level include recursion limit
>
> Configuration-file include recursion is capped at 10 levels.[^pg16-recursion] Beyond that, the load fails. In practice nobody nests this deep, but management tools that recursively glob can hit it.

The C-locale sort order is the operational lever: name files `10-replication.conf`, `20-app-users.conf`, `30-monitoring.conf` to make precedence explicit. Numbers sort before letters, so `90-overrides.conf` reliably wins over `50-baseline.conf`.

### ALTER SYSTEM

Grammar:[^alter-system]

```
ALTER SYSTEM SET configuration_parameter { TO | = } { value [, ...] | DEFAULT }
ALTER SYSTEM RESET configuration_parameter
ALTER SYSTEM RESET ALL
```

Behavior:

- Writes to `postgresql.auto.conf`, not `postgresql.conf`.
- `ALTER SYSTEM RESET` (or `SET ... TO DEFAULT`) removes the line from `postgresql.auto.conf`.
- Values are applied *after the next reload*, or *after the next restart* for `postmaster`-context parameters. For these latter, the GUC change is staged but inactive; `pg_settings.pending_restart` is `true`.
- Cannot run inside a transaction block or function (verbatim: *"this command acts directly on the file system and cannot be rolled back, it is not allowed inside a transaction block or function"*[^alter-system]).
- Cannot set `data_directory` or any preset (internal-context) parameter.
- Superuser-only by default; PG15+ allows `GRANT ALTER SYSTEM ON PARAMETER y TO u` to delegate per-parameter.[^pg15-grant]

> [!WARNING] `ALTER SYSTEM SET` for `postmaster`-context parameters is staged, not live
>
> `ALTER SYSTEM SET shared_buffers = '8GB'` succeeds silently. The new value is written to `postgresql.auto.conf` and stored in `pg_settings.reset_val`, but `pg_settings.setting` (the current value) is unchanged until the next restart. `pg_settings.pending_restart` becomes `true`. Audit pending changes with Recipe 4.

### SET, SET LOCAL, RESET

`SET` changes a parameter's value within the current session (or transaction with `LOCAL`). It corresponds to the `user`-context and `superuser`-context parameters from `pg_settings.context`. Verbatim grammar:[^set]

```
SET [ SESSION | LOCAL ] configuration_parameter { TO | = } { value | 'value' | DEFAULT }
SET [ SESSION | LOCAL ] TIME ZONE { value | 'value' | LOCAL | DEFAULT }
```

Semantics:

- **`SET` (or `SET SESSION`)** — applies for the remainder of the session unless overridden by another `SET` or rolled back.
- **`SET LOCAL`** — applies only until the end of the current transaction. Verbatim: *"Issuing this outside of a transaction block emits a warning and otherwise has no effect."*[^set]
- **`SET LOCAL` inside a function with a `SET` option:** the function's `SET` clause restores the caller's value on exit, so `SET LOCAL` inside is bounded by the function's own scope.[^set]
- **`SET` inside a `BEGIN; ... ROLLBACK;`** is rolled back along with the transaction — the parameter reverts to what it was before the transaction.
- **`RESET y`** is equivalent to `SET y TO DEFAULT`. The "default" is `reset_val` from `pg_settings` — which respects per-role/per-database settings *if* they were in effect at session start, not the compiled-in default. To reach the compiled-in default, edit `postgresql.conf` or use `ALTER ROLE u RESET y`.[^reset]
- **`RESET ALL`** restores all session-local settings to their `reset_val`. Verbatim from PG16 release notes: *"Tighten restrictions on which server variables can be reset (Masahiko Sawada). Previously, while certain variables, like `transaction_isolation`, were not affected by `RESET ALL`, they could be individually reset in inappropriate situations."*[^pg16-reset]

`set_config(name, value, is_local)` is the SQL-function equivalent of `SET` / `SET LOCAL`:

```sql
SELECT set_config('work_mem', '128MB', true);   -- equivalent to SET LOCAL
SELECT set_config('work_mem', '128MB', false);  -- equivalent to SET
```

This is the only way to dynamically change a GUC where the *name* is not known at parse time — useful inside PL/pgSQL or for application-driver code that builds GUC names dynamically.

### ALTER DATABASE SET and ALTER ROLE SET

These persist per-database, per-role, or per-role-per-database defaults. Verbatim: *"Whenever a new session is subsequently started in that database, the specified value becomes the session default value."*[^alter-database]

```sql
-- Per-database
ALTER DATABASE analytics SET default_transaction_read_only = on;
ALTER DATABASE analytics SET work_mem = '256MB';

-- Per-role (applies to every database the role connects to)
ALTER ROLE batchjobs SET statement_timeout = '30min';

-- Per-role in one specific database
ALTER ROLE webapp IN DATABASE prod SET statement_timeout = '5s';

-- Reset
ALTER ROLE webapp IN DATABASE prod RESET statement_timeout;
ALTER DATABASE analytics RESET ALL;
```

Inspect with `pg_db_role_setting` (joined to `pg_database` and `pg_roles` for readable names):

```sql
SELECT
    coalesce(d.datname, '<all>') AS database,
    coalesce(r.rolname, '<all>') AS role,
    s.setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles    r ON r.oid = s.setrole
ORDER BY database NULLS FIRST, role NULLS FIRST;
```

> [!WARNING] Per-role GUCs do NOT propagate across pgBouncer transaction-mode pools
>
> A connection pool that recycles backend connections across logical sessions does not re-evaluate `ALTER ROLE SET` defaults on each "session" because the underlying backend was logged in once. If `webapp` has `ALTER ROLE webapp SET statement_timeout = '5s'` and pgBouncer is in `pool_mode = transaction`, the timeout applies to the *first* application session served by each backend and persists; later sessions see whatever the previous one left behind. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6 and [`81-pgbouncer.md`](./81-pgbouncer.md) for the canonical operational story.

### Reloading vs restarting

| Action | Picks up changes to | Existing sessions see new value? |
|---|---|---|
| `pg_reload_conf()` / `pg_ctl reload` / SIGHUP to postmaster | `sighup`, `superuser`, `user` context | Yes for `sighup`; for `superuser`/`user` only if no session-local `SET` won |
| `pg_reload_conf()` for `superuser-backend` / `backend` | Reload is accepted but applies to *new* sessions only | No |
| `pg_reload_conf()` for `postmaster` context | Setting is staged in `pg_settings.reset_val`; `pending_restart` becomes `true` | No |
| `pg_ctl restart` | All contexts | All sessions reconnect — the restart kills them |

`pg_reload_conf()` verbatim: *"Causes all processes of the PostgreSQL server to reload their configuration files. (This is initiated by sending a SIGHUP signal to the postmaster process, which in turn sends SIGHUP to each of its children.) You can use the `pg_file_settings`, `pg_hba_file_rules` and `pg_ident_file_mappings` views to check the configuration files for possible errors, before reloading."*[^functions-admin]

A clean SIGHUP reload is silent on success and logs an error to `stderr` / `log_destination` on failure. **Invalid settings are logged but not applied** — the cluster keeps running with the prior value. Recipe 8 shows the validate-before-reload pattern.

### pg_settings and pg_file_settings

`pg_settings` is the canonical introspection view. Columns:[^pg-settings]

| Column | Type | What it tells you |
|---|---|---|
| `name` | text | Parameter name |
| `setting` | text | Current effective value (always text — cast as needed) |
| `unit` | text | Implicit unit (`MB`, `kB`, `s`, `ms`) — applies when `vartype` is numeric |
| `category` | text | Grouping label visible in `\dconfig` |
| `short_desc` | text | One-line description |
| `extra_desc` | text | Longer description |
| `context` | text | One of the seven contexts above |
| `vartype` | text | `bool`, `enum`, `integer`, `real`, `string` |
| `source` | text | Where the current value came from: `default`, `override`, `command line`, `configuration file`, `database`, `user`, `database user`, `session`, `client` |
| `min_val` | text | Numeric min (null for non-numeric) |
| `max_val` | text | Numeric max |
| `enumvals` | text[] | Allowed values for `enum` type |
| `boot_val` | text | Compiled-in default |
| `reset_val` | text | Value `RESET` would restore in the current session |
| `sourcefile` | text | Config file the value was set in (null if not from a file; null for non-superusers without `pg_read_all_settings`) |
| `sourceline` | int4 | Line number in `sourcefile` |
| `pending_restart` | bool | `true` if config file change is staged but requires restart |

Five canonical queries:

```sql
-- Show effective value + where it came from
SELECT name, setting, unit, source, sourcefile, sourceline
FROM pg_settings WHERE name = 'work_mem';

-- Find every parameter overridden from the compiled-in default
SELECT name, setting, boot_val, source
FROM pg_settings WHERE setting IS DISTINCT FROM boot_val
ORDER BY name;

-- Find parameters needing a restart
SELECT name, setting, reset_val, sourcefile
FROM pg_settings WHERE pending_restart;

-- Parameters by context (audit what can be changed live)
SELECT context, count(*) FROM pg_settings GROUP BY context ORDER BY context;

-- All parameters by category
SELECT category, count(*) FROM pg_settings GROUP BY category ORDER BY count(*) DESC;
```

`pg_file_settings` shows the file contents *as parsed*, before they are applied. One row per `name = value` entry across all `postgresql.conf` / `postgresql.auto.conf` / included files.[^pg-file-settings]

```sql
SELECT sourcefile, sourceline, seqno, name, setting, applied, error
FROM pg_file_settings
WHERE NOT applied OR error IS NOT NULL
ORDER BY sourcefile, sourceline;
```

Verbatim from the docs: *"Another way that an entry might have `applied` = false is that it is overridden by a later entry for the same parameter name; this case is not considered an error so nothing appears in the `error` field."*[^pg-file-settings]

This is the right way to *validate* a config edit before reloading — see Recipe 8.

### Custom GUCs

A custom GUC has a dotted name (`myapp.tenant_id`). Postgres accepts arbitrary string values for any parameter matching `prefix.name` where `prefix` is not a known parameter group. Custom GUCs are the canonical way to pass session-scoped context to triggers / RLS policies / functions:

```sql
SET myapp.tenant_id = '42';
SELECT current_setting('myapp.tenant_id');                -- raises if missing
SELECT current_setting('myapp.tenant_id', true);          -- returns NULL if missing (PG9.6+)
```

The two-argument form of `current_setting()` is the safe form for use inside RLS policies and triggers — cross-reference [`47-row-level-security.md`](./47-row-level-security.md) Recipe 1.

> [!NOTE] PostgreSQL 17: `ALTER SYSTEM` accepts unrecognized custom variables
>
> Pre-PG17, `ALTER SYSTEM SET myapp.feature_flag = 'on'` failed with *"unrecognized configuration parameter"* if no extension had pre-registered `myapp.*`. PG17 allows it.[^pg17-custom] This is useful for application-level config: deploy a flag, change it cluster-wide via `ALTER SYSTEM`, no extension needed.

To pre-register a custom variable (e.g., from an extension's `shared_preload_libraries` hook), use `DefineCustomXXXVariable` in C. From SQL there is no pre-registration — just use the dotted name.

### Per-version timeline

| Version | What changed |
|---|---|
| PG14 | `password_encryption` default changed `md5` → `scram-sha-256`.[^pg14-scram] `vacuum_cleanup_index_scale_factor` (ignored since PG13.3) and `operator_precedence_warning` removed.[^pg14-removed] |
| PG15 | `GRANT SET ON PARAMETER y` and `GRANT ALTER SYSTEM ON PARAMETER y` — delegate per-parameter to non-superusers. `has_parameter_privilege()` SQL function for auditing.[^pg15-grant] |
| PG16 | Config-file include recursion capped at 10 levels.[^pg16-recursion] `pg_hba.conf` / `pg_ident.conf` gain `include` / `include_if_exists` / `include_dir`.[^pg16-hba-include] `RESET ALL` no longer can reset certain isolation-related parameters in inappropriate situations.[^pg16-reset] `postgresql.conf` parameter categories reorganized (affects `pg_settings.category`).[^pg16-categories] `initdb -c name=value` for setting parameters at cluster initialization.[^pg16-initdb-c] `archive_library` and `archive_command` mutually exclusive (cross-reference [`33-wal.md`](./33-wal.md)).[^pg16-archive] |
| PG17 | `allow_alter_system` GUC (default `on`) — set to `off` to forbid `ALTER SYSTEM` cluster-wide.[^pg17-aas] `ALTER SYSTEM` accepts unrecognized custom variables.[^pg17-custom] `transaction_timeout`, `event_triggers`, `io_combine_limit`, `huge_pages_status`, `summarize_wal`, `wal_summary_keep_time`, `sync_replication_slots`, `synchronized_standby_slots`, and the SLRU `*_buffers` family added as new GUCs (cross-references: [`41-transactions.md`](./41-transactions.md), [`40-event-triggers.md`](./40-event-triggers.md), [`33-wal.md`](./33-wal.md), [`32-buffer-manager.md`](./32-buffer-manager.md)). |
| PG18 | No changes to GUC machinery itself (no new contexts, no new `pg_settings` columns, no `ALTER SYSTEM` semantic changes). Many new individual GUCs added: `io_method`, `io_combine_limit`, `io_max_combine_limit`, `vacuum_max_eager_freeze_failure_rate`, `vacuum_truncate`, `enable_self_join_elimination`, `enable_distinct_reordering`, `oauth_validator_libraries`, `ssl_tls13_ciphers`, `autovacuum_worker_slots`, `autovacuum_vacuum_max_threshold`, `md5_password_warnings`, `pgaudit.log_*`. |

## Examples / Recipes

### Recipe 1: Baseline `postgresql.conf` for a small-to-medium production OLTP cluster

```conf
# postgresql.conf — production baseline for ~32 GB RAM, ~500 GB SSD, OLTP

# --- Memory ---
shared_buffers = 8GB                # ~25% of RAM; restart required
effective_cache_size = 24GB         # ~75% of RAM; planner hint, no allocation
work_mem = 32MB                     # per-node, not per-query
maintenance_work_mem = 1GB          # for VACUUM, CREATE INDEX
huge_pages = try                    # restart required

# --- WAL ---
wal_level = replica                 # or 'logical' if you need logical replication
wal_compression = lz4               # PG14+
max_wal_size = 16GB
min_wal_size = 2GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9  # default since PG14
max_slot_wal_keep_size = 64GB       # bound stuck-replica disk usage

# --- Replication ---
max_wal_senders = 10
max_replication_slots = 10
hot_standby = on
hot_standby_feedback = off          # set 'on' only if standby runs reporting queries

# --- Autovacuum ---
autovacuum_vacuum_cost_delay = 2ms
autovacuum_naptime = 30s
log_autovacuum_min_duration = 10min # default since PG15

# --- Connections ---
max_connections = 200               # restart required; use a pooler for >200
listen_addresses = '*'
password_encryption = scram-sha-256 # default since PG14

# --- Logging ---
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'
log_rotation_age = 1d
log_rotation_size = 100MB
log_line_prefix = '%m [%p] %q%u@%d/%a '
log_connections = on                # default since PG15 emits for trust too
log_disconnections = on
log_lock_waits = on
log_temp_files = 0                  # log every temp file (rarely innocuous)
log_min_duration_statement = 1s     # log slow queries

# --- Statistics ---
shared_preload_libraries = 'pg_stat_statements, pgaudit'
pg_stat_statements.max = 10000
pg_stat_statements.track = all

# --- Includes ---
include_dir = 'conf.d'              # per-management-tool overrides
```

The combination matches the iteration-33 (WAL), iteration-34 (checkpoints), iteration-46/41 (per-role baseline), and iteration-49 (TLS) recipes. Application-side per-role overrides via `ALTER ROLE` (Recipe 3 below) layer on top.

### Recipe 2: `ALTER SYSTEM` workflow with verification

```sql
-- 1. Look up the current value
SELECT name, setting, unit, source, sourcefile
FROM pg_settings WHERE name = 'log_min_duration_statement';

-- 2. Stage the change
ALTER SYSTEM SET log_min_duration_statement = '500ms';

-- 3. Verify it was written to postgresql.auto.conf and is queued
SELECT sourcefile, sourceline, name, setting, applied, error
FROM pg_file_settings WHERE name = 'log_min_duration_statement';

-- 4. Reload
SELECT pg_reload_conf();

-- 5. Verify the new value is now effective
SELECT name, setting, source FROM pg_settings WHERE name = 'log_min_duration_statement';

-- 6. To undo
ALTER SYSTEM RESET log_min_duration_statement;
SELECT pg_reload_conf();
```

The verification step (5) is the critical one — `pg_reload_conf()` does not error out if a value is invalid, it merely logs and ignores. `pg_settings.setting` is the source of truth for what is actually live.

### Recipe 3: Per-role + per-database + per-role-in-database baseline

Continues the iteration-41/42/46 per-role-baseline convention by layering scopes:

```sql
-- Cluster-wide defaults (postgresql.conf or ALTER SYSTEM)
ALTER SYSTEM SET statement_timeout = 0;             -- no global cap
ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min';
SELECT pg_reload_conf();

-- Per-role baselines
ALTER ROLE webapp   SET statement_timeout = '5s';
ALTER ROLE webapp   SET lock_timeout = '500ms';
ALTER ROLE webapp   SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE webapp   SET default_transaction_isolation = 'read committed';

ALTER ROLE reporter SET statement_timeout = '30min';
ALTER ROLE reporter SET default_transaction_read_only = on;
ALTER ROLE reporter SET default_transaction_deferrable = on;
ALTER ROLE reporter SET default_transaction_isolation = 'serializable';

ALTER ROLE batchjobs SET statement_timeout = '4h';
ALTER ROLE batchjobs SET lock_timeout = '30s';
ALTER ROLE batchjobs SET idle_in_transaction_session_timeout = '1h';

-- Per-database
ALTER DATABASE prod      SET work_mem = '32MB';
ALTER DATABASE analytics SET work_mem = '256MB';

-- Per-role-in-database
ALTER ROLE webapp IN DATABASE analytics SET statement_timeout = '2min';
-- (webapp reading from analytics gets a longer timeout than from prod)

-- Verify the chain that will apply to webapp@prod
SELECT
    coalesce(d.datname, '<all>') AS db,
    coalesce(r.rolname, '<all>') AS role,
    unnest(s.setconfig) AS setting
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles    r ON r.oid = s.setrole
WHERE (r.rolname = 'webapp' OR r.rolname IS NULL)
  AND (d.datname = 'prod' OR d.datname IS NULL)
ORDER BY db NULLS FIRST, role NULLS FIRST;
```

Settings apply at session start, in precedence order: per-role-in-database wins over per-role wins over per-database wins over cluster defaults. The pgBouncer caveat from gotcha #6 in [`46-roles-privileges.md`](./46-roles-privileges.md) applies — in `pool_mode = transaction` these per-role settings can leak across "sessions" sharing the same backend.

### Recipe 4: Find parameters needing a restart

```sql
-- Audit pending changes
SELECT name, setting AS current_value, reset_val AS pending_value,
       sourcefile, sourceline
FROM pg_settings
WHERE pending_restart
ORDER BY name;
```

If this returns rows, a restart is required for those settings to apply. The current `setting` is what's active *now*; `reset_val` reflects what the loaded config files say. Settings drift between them is exactly what `pending_restart` flags.

### Recipe 5: `include_dir` for management-tool-generated rules

Same shape as `48-authentication-pg-hba.md` Recipe 11. In `postgresql.conf`:

```conf
# Hand-maintained baseline lives in postgresql.conf
shared_buffers = 8GB
work_mem = 32MB

# Management tools drop files into this directory
include_dir = 'conf.d'
```

In `$PGDATA/conf.d/`:

```
10-tuning.conf
20-replication.conf
30-monitoring.conf
90-emergency-override.conf   <- highest precedence due to alphabetical sort
```

The C-locale sort order means numbers sort before letters and digit prefixes give explicit precedence control. A management tool that writes `99-`-prefixed files is guaranteed to win over hand-edited baselines without modifying them.

### Recipe 6: Diagnose "why is this setting value not what I expect?"

```sql
-- Step 1: what is the effective value, and where did it come from?
SELECT name, setting, source, sourcefile, sourceline
FROM pg_settings WHERE name = 'work_mem';

-- If source = 'database': there's an ALTER DATABASE SET
-- If source = 'user':     there's an ALTER ROLE SET
-- If source = 'session':  someone issued SET in this session
-- If source = 'database user': there's an ALTER ROLE ... IN DATABASE SET
-- If source = 'configuration file': it's in postgresql.conf or .auto.conf or an include

-- Step 2: find the layering
SELECT
    coalesce(d.datname, '<all>') AS db,
    coalesce(r.rolname, '<all>') AS role,
    unnest(s.setconfig) AS setting
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles    r ON r.oid = s.setrole
WHERE unnest(s.setconfig) LIKE 'work_mem=%';

-- Step 3: check the raw file
SELECT sourcefile, sourceline, name, setting, applied, error
FROM pg_file_settings
WHERE name = 'work_mem'
ORDER BY sourcefile, sourceline;

-- Step 4: any session override?
SHOW work_mem;  -- includes session SET
SELECT current_setting('work_mem');  -- same as SHOW
```

### Recipe 7: PG17+ block `ALTER SYSTEM` cluster-wide

```conf
# In postgresql.conf
allow_alter_system = off
```

After reload:

```sql
ALTER SYSTEM SET work_mem = '64MB';
-- ERROR:  ALTER SYSTEM is not allowed in this environment
```

The setting itself is `sighup`-context, so it can be changed via SIGHUP. Once `off`, only direct edits to `postgresql.conf` (or its includes) can persist configuration changes. Managed environments and Kubernetes operators (e.g., CloudNativePG) typically set this to `off` and reconcile `postgresql.conf` from a declarative spec.

This blocks `ALTER SYSTEM` but does NOT block a superuser with shell access from editing `postgresql.conf` directly. The control is collaborative (operator-friendly), not adversarial (a privileged attacker can still bypass it by writing to the filesystem).

### Recipe 8: Validate config files BEFORE reloading

```sql
-- Find any entries that would fail to apply on reload
SELECT sourcefile, sourceline, seqno, name, setting, error
FROM pg_file_settings
WHERE NOT applied
   OR error IS NOT NULL;

-- If empty: safe to reload
-- If not empty: fix the errors and re-check
SELECT pg_reload_conf();
```

`pg_file_settings` reads the files as they currently exist on disk; it shows what *would* be applied if you reloaded right now, including errors. This catches typos like `work_meme = 32MB` before they hit `pg_reload_conf()` (which would log the error and silently keep the old value).

### Recipe 9: Audit every parameter overridden from compiled-in default

```sql
SELECT
    name,
    setting,
    boot_val,
    source,
    sourcefile,
    sourceline
FROM pg_settings
WHERE setting IS DISTINCT FROM boot_val
  AND source NOT IN ('default', 'override')
ORDER BY source, name;
```

Returns the difference between "what this cluster looks like" and "what an `initdb`-fresh cluster looks like." Critical for two situations: (a) reproducing a behavior in dev/staging — apply these settings; (b) auditing managed-environment overrides — what did the provider change behind the scenes?

The `override` source value means the override is provider-managed (rare; mostly internal). Filter it out unless you want to see those too.

### Recipe 10: GRANT one GUC to a non-superuser (PG15+)

```sql
-- Grant a role permission to SET (but not ALTER SYSTEM) one parameter
GRANT SET ON PARAMETER log_min_duration_statement TO monitoring;

-- Or both SET and ALTER SYSTEM
GRANT SET, ALTER SYSTEM ON PARAMETER log_min_duration_statement TO monitoring;

-- Audit who has parameter privileges
SELECT
    a.rolname,
    p.parname,
    has_parameter_privilege(a.rolname, p.parname, 'SET') AS can_set,
    has_parameter_privilege(a.rolname, p.parname, 'ALTER SYSTEM') AS can_alter_system
FROM pg_parameter_acl p
CROSS JOIN pg_roles a
WHERE has_parameter_privilege(a.rolname, p.parname, 'SET, ALTER SYSTEM')
ORDER BY p.parname, a.rolname;

-- Revoke
REVOKE SET, ALTER SYSTEM ON PARAMETER log_min_duration_statement FROM monitoring;
```

`pg_parameter_acl` lists parameters that have at least one explicit grant. The default for `user`-context and `superuser`-context parameters depends on the parameter; superusers always retain full access.

### Recipe 11: `SET LOCAL` inside a `DO` block for one-statement override

Same shape as the iteration-41 `SET LOCAL` pattern for `lock_timeout` during `ALTER TABLE`:

```sql
BEGIN;
    SET LOCAL maintenance_work_mem = '4GB';
    SET LOCAL max_parallel_maintenance_workers = 4;
    REINDEX INDEX CONCURRENTLY large_idx;
COMMIT;
-- maintenance_work_mem and max_parallel_maintenance_workers revert to session values here
```

`SET LOCAL` is the right tool when you want a parameter change scoped to one operation and reverted automatically — no risk of leaking the elevated `maintenance_work_mem` to the next statement in the session. The `WARNING` it would otherwise issue (gotcha #3) is suppressed because we're inside an explicit `BEGIN ... COMMIT`.

### Recipe 12: Categorize every parameter that diverges from default by category

```sql
SELECT
    category,
    count(*) AS overridden_count,
    array_agg(name ORDER BY name) AS parameters
FROM pg_settings
WHERE setting IS DISTINCT FROM boot_val
  AND source NOT IN ('default', 'override')
GROUP BY category
ORDER BY overridden_count DESC;
```

Gives a high-level view of which subsystems have been tuned. A heavy override list under `Resource Usage / Memory` says the cluster has been memory-tuned; under `Replication / Standby Servers` says replication is configured; etc. The PG16 category reorganization[^pg16-categories] means cross-version comparisons of `category` values may show surprising differences.

### Recipe 13: Reset a misconfigured GUC quickly

```sql
-- If a parameter is mis-set in postgresql.auto.conf
ALTER SYSTEM RESET work_mem;       -- removes the line from postgresql.auto.conf
SELECT pg_reload_conf();           -- now postgresql.conf or boot_val wins

-- Or reset everything
ALTER SYSTEM RESET ALL;
SELECT pg_reload_conf();

-- If a parameter is mis-set in postgresql.conf
-- (must edit the file directly — ALTER SYSTEM RESET only touches .auto.conf)
SELECT current_setting('config_file');  -- find the path
-- ... edit the file ...
SELECT pg_reload_conf();

-- Verify
SELECT name, setting, source, sourcefile FROM pg_settings WHERE name = 'work_mem';
```

`ALTER SYSTEM RESET` only removes lines from `postgresql.auto.conf`. To undo a `postgresql.conf` edit you have to edit `postgresql.conf` directly. Recipe 9 above (audit overridden-from-default) helps find what changed.

## Gotchas / Anti-patterns

1. **`ALTER SYSTEM` writes `postgresql.auto.conf`, not `postgresql.conf`.** Two separate files. If you hand-edit `postgresql.conf` but `postgresql.auto.conf` has the same parameter set, the auto file wins.[^alter-system]
2. **`ALTER SYSTEM` cannot run in a transaction block or function.** It manipulates the filesystem and cannot be rolled back, so it errors with `25001`.[^alter-system]
3. **`SET LOCAL` outside a transaction silently warns and no-ops.** *"Issuing this outside of a transaction block emits a warning and otherwise has no effect."*[^set] Wrap in `BEGIN ... COMMIT` or use `SET` instead.
4. **`ALTER SYSTEM SET` for `postmaster`-context parameters is staged, not live.** `pg_settings.pending_restart` becomes `true`; the parameter still has its old value. Recipe 4 audits pending changes.
5. **SIGHUP reload silently ignores invalid values.** A typo in `postgresql.conf` is logged but the cluster keeps the old value. Validate with `pg_file_settings` (Recipe 8) before reloading.
6. **SIGHUP reload doesn't affect existing sessions for `superuser-backend` or `backend` context.** Sessions launched before the reload keep the old value forever; new sessions get the new value.
7. **`ALTER ROLE` / `ALTER DATABASE SET` doesn't apply to existing sessions.** The new value takes effect only on the next *connection*. Existing sessions must reconnect or use explicit `SET` to pick it up.
8. **Per-role GUCs do NOT propagate across pgBouncer transaction-mode pools.** The role's `ALTER ROLE SET` baseline runs once per backend, not per logical session. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6.
9. **`pg_settings.source = 'session'` hides the underlying file source.** A session `SET` masks where the *default* came from. Issue `RESET y` (or close the session) to expose the underlying value.
10. **`pending_restart = true` is silent.** No error, no warning, no log entry on reload — just a flag in `pg_settings`. Monitor for it actively or you'll wonder why your `ALTER SYSTEM SET shared_buffers` didn't take effect.
11. **`RESET y` doesn't restore the compiled-in default.** It restores `reset_val`, which respects `ALTER ROLE SET` / `ALTER DATABASE SET` defaults that were in effect at session start. To force the compiled-in default (`boot_val`), use `ALTER ROLE u RESET y` to remove the per-role override.
12. **`RESET ALL` doesn't reset every parameter.** Certain settings (`transaction_isolation`, transaction-state parameters) are excluded. PG16 tightened the rules to forbid individually resetting these in inappropriate situations.[^pg16-reset]
13. **`data_directory` cannot be `ALTER SYSTEM`-set.** Some parameters are reserved for server-start configuration only and cannot live in `postgresql.auto.conf`.[^alter-system]
14. **Preset / internal-context parameters cannot be set at all.** `server_version_num`, `data_checksums`, `wal_block_size`, etc. — read-only outputs of build/initdb.
15. **`SET` inside a function with a `SET` clause:** the function's `SET` overrides surrounding session `SET`. A regular `SET` in the function body persists after function return; a `SET LOCAL` does not.[^set]
16. **Custom GUC names without a dot are rejected** as invalid configuration parameters. Pre-PG17, `ALTER SYSTEM SET myapp.x` failed if no extension had pre-registered `myapp.*`; PG17+ accepts it.[^pg17-custom]
17. **Include recursion limit is 10 levels (PG16+).**[^pg16-recursion] In practice almost nobody hits this, but management tools that recursively glob include directories should not chain deeper.
18. **`include_dir` only picks up `.conf`-suffixed files.** Files without `.conf` or starting with `.` are silently ignored. Hidden files and editor backup files (`.swp`, `~`) are skipped — which is usually what you want.
19. **`include_dir` sorts files using C-locale rules.** Uppercase `A` sorts before lowercase `a`; digits sort before letters. `90-` files win over `10-` files (later loaded = higher precedence).
20. **Manual edits to `postgresql.auto.conf` race with `ALTER SYSTEM`.** The next `ALTER SYSTEM` may rewrite the file atomically and lose your edit. Treat `postgresql.auto.conf` as machine-managed.
21. **PG14 changed `password_encryption` default to `scram-sha-256`.**[^pg14-scram] An upgraded cluster keeps its old value (`md5`) until you explicitly change it; new clusters use `scram-sha-256`. New users created on an `md5`-defaulted upgraded cluster get MD5 hashes — see [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) for the canonical migration recipe.
22. **PG17+ `allow_alter_system = off` does not prevent direct file edits.** A superuser with shell access can still write to `postgresql.conf`. The control is operator-collaboration, not adversarial defense.[^pg17-aas]
23. **PG16 reorganized `pg_settings.category` values.**[^pg16-categories] Monitoring queries that filter or group by `category` may show unexpected results after upgrading from PG15 or earlier.

## See Also

- [`46-roles-privileges.md`](./46-roles-privileges.md) — `ALTER ROLE SET` baselines, GRANT machinery for PG15+ per-parameter privileges, pgBouncer transaction-mode interaction
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — `pg_hba.conf` shares include directives with `postgresql.conf` (PG16+)
- [`41-transactions.md`](./41-transactions.md) — `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `transaction_timeout` (PG17+) as per-role baseline GUCs
- [`42-isolation-levels.md`](./42-isolation-levels.md) — `default_transaction_isolation` / `default_transaction_read_only` / `default_transaction_deferrable` as per-role/per-DB baselines
- [`54-memory-tuning.md`](./54-memory-tuning.md) — shared_buffers, work_mem, maintenance_work_mem deep dive
- [`32-buffer-manager.md`](./32-buffer-manager.md) — bgwriter and buffer-pool GUCs
- [`33-wal.md`](./33-wal.md) — WAL GUCs (`wal_level`, `wal_compression`, `max_wal_size`, archive_command / archive_library mutual exclusion)
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint and bgwriter GUCs
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum GUCs (cluster vs per-table)
- [`47-row-level-security.md`](./47-row-level-security.md) — custom GUCs as RLS-policy session context via `current_setting('app.tenant_id', true)`
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_settings`, `pg_file_settings`, `pg_db_role_setting`, `pg_parameter_acl`
- [`51-pgaudit.md`](./51-pgaudit.md) — `pgaudit.log_*` GUCs as canonical examples of extension-provided GUCs; `log_min_messages` and `log_line_prefix` are central to audit configuration
- [`59-planner-tuning.md`](./59-planner-tuning.md) — cost GUCs (`random_page_cost`, `seq_page_cost`, `cpu_tuple_cost`) configured via the same GUC mechanism
- [`81-pgbouncer.md`](./81-pgbouncer.md) — pool-mode interaction with per-role GUCs

## Sources

[^contexts]: `pg_settings` view — context column definitions (`internal`, `postmaster`, `sighup`, `superuser-backend`, `backend`, `superuser`, `user`). Verbatim per-context definitions quoted from the docs. https://www.postgresql.org/docs/16/view-pg-settings.html
[^pg-settings]: `pg_settings` view — full column reference (`name`, `setting`, `unit`, `category`, `short_desc`, `extra_desc`, `context`, `vartype`, `source`, `min_val`, `max_val`, `enumvals`, `boot_val`, `reset_val`, `sourcefile`, `sourceline`, `pending_restart`). https://www.postgresql.org/docs/16/view-pg-settings.html
[^pg-file-settings]: `pg_file_settings` view — *"The view `pg_file_settings` provides a summary of the contents of the server's configuration file(s). A row appears in this view for each "name = value" entry appearing in the files, with annotations indicating whether the value could be applied successfully."* https://www.postgresql.org/docs/16/view-pg-file-settings.html
[^alter-system]: ALTER SYSTEM — *"`ALTER SYSTEM` writes the given parameter setting to the `postgresql.auto.conf` file, which is read in addition to `postgresql.conf`."* and *"this command acts directly on the file system and cannot be rolled back, it is not allowed inside a transaction block or function."* https://www.postgresql.org/docs/16/sql-altersystem.html
[^set]: SET — *"`LOCAL`: Specifies that the command takes effect for only the current transaction. After `COMMIT` or `ROLLBACK`, the session-level setting takes effect again. Issuing this outside of a transaction block emits a warning and otherwise has no effect."* https://www.postgresql.org/docs/16/sql-set.html
[^reset]: RESET — *"`RESET` restores run-time parameters to their default values. ... The default value is defined as the value that the parameter would have had, if no `SET` had ever been issued for it in the current session. The actual source of this value might be a compiled-in default, the configuration file, command-line options, or per-database or per-user default settings."* https://www.postgresql.org/docs/16/sql-reset.html
[^functions-admin]: `pg_reload_conf()` — *"Causes all processes of the PostgreSQL server to reload their configuration files. (This is initiated by sending a SIGHUP signal to the postmaster process, which in turn sends SIGHUP to each of its children.) You can use the `pg_file_settings`, `pg_hba_file_rules` and `pg_ident_file_mappings` views to check the configuration files for possible errors, before reloading."* https://www.postgresql.org/docs/16/functions-admin.html
[^alter-database]: ALTER DATABASE SET — *"The remaining forms change the session default for a run-time configuration variable for a PostgreSQL database. Whenever a new session is subsequently started in that database, the specified value becomes the session default value. The database-specific default overrides whatever setting is present in `postgresql.conf` or has been received from the `postgres` command line."* https://www.postgresql.org/docs/16/sql-alterdatabase.html
[^alter-role]: ALTER ROLE SET — *"Whenever the role subsequently starts a new session, the specified value becomes the session default, overriding whatever setting is present in `postgresql.conf` or has been received from the `postgres` command line. This only happens at login time; executing `SET ROLE` or `SET SESSION AUTHORIZATION` does not cause new configuration values to be set. ... database-role-specific settings override role-specific ones, which in turn override database-specific ones."* https://www.postgresql.org/docs/16/sql-alterrole.html
[^config-setting]: Configuration setting via files — include directives and the precedence/order rules. https://www.postgresql.org/docs/16/config-setting.html
[^pg14-scram]: PG14 release notes — *"Change the default of the `password_encryption` server parameter to `scram-sha-256` (Peter Eisentraut)... Previously it was `md5`."* https://www.postgresql.org/docs/release/14.0/
[^pg14-removed]: PG14 release notes — *"Remove server parameter `vacuum_cleanup_index_scale_factor` (Peter Geoghegan)... This setting was ignored starting in PostgreSQL version 13.3."* and *"Remove server parameter `operator_precedence_warning` (Tom Lane)."* https://www.postgresql.org/docs/release/14.0/
[^pg15-grant]: PG15 release notes — *"Allow `GRANT` to grant permissions to change individual server variables via `SET` and `ALTER SYSTEM` (Mark Dilger). The new function `has_parameter_privilege()` reports on this privilege."* https://www.postgresql.org/docs/release/15.0/
[^pg16-recursion]: PG16 release notes — *"Prevent configuration file recursion beyond 10 levels (Julien Rouhaud)."* https://www.postgresql.org/docs/release/16.0/
[^pg16-hba-include]: PG16 release notes — *"Allow include files in `pg_hba.conf` and `pg_ident.conf` (Julien Rouhaud). These are controlled by `include`, `include_if_exists`, and `include_dir`."* https://www.postgresql.org/docs/release/16.0/
[^pg16-reset]: PG16 release notes — *"Tighten restrictions on which server variables can be reset (Masahiko Sawada). Previously, while certain variables, like `transaction_isolation`, were not affected by `RESET ALL`, they could be individually reset in inappropriate situations."* https://www.postgresql.org/docs/release/16.0/
[^pg16-categories]: PG16 release notes — *"Move various `postgresql.conf` items into new categories (Shinya Kato). This also affects the categories displayed in the `pg_settings` view."* https://www.postgresql.org/docs/release/16.0/
[^pg16-initdb-c]: PG16 release notes — *"Add initdb option to set server variables for the duration of initdb and all future server starts (Tom Lane). The option is `-c name=value`."* https://www.postgresql.org/docs/release/16.0/
[^pg16-archive]: PG16 release notes — *"Prevent `archive_library` and `archive_command` from being set at the same time (Nathan Bossart). Previously `archive_library` would override `archive_command`."* https://www.postgresql.org/docs/release/16.0/
[^pg17-aas]: PG17 release notes — *"Add system variable `allow_alter_system` to disallow `ALTER SYSTEM` (Jelte Fennema-Nio, Gabriele Bartolini)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-custom]: PG17 release notes — *"Allow `ALTER SYSTEM` to set unrecognized custom server variables (Tom Lane). This is also possible with `GRANT ON PARAMETER`."* https://www.postgresql.org/docs/release/17.0/

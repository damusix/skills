# PostgreSQL CLI Tools

> [!WARNING] **`psql` backslash commands are not SQL — they are client-side macros that compile down to catalog queries**
> Run `\set ECHO_HIDDEN on` once per session and every backslash command (`\d`, `\df`, `\di`, `\dx`, ...) prints the underlying `SELECT ... FROM pg_catalog ...` query before executing. Lets you (a) understand what catalog joins each command performs, (b) copy-paste them into scripts, (c) audit them for permission issues. Copy, paste, customize the resulting SQL into scripts or monitoring dashboards.

Reference for psql + the per-database command-line wrappers (`createdb`, `dropdb`, `createuser`, `dropuser`, `vacuumdb`, `reindexdb`, `clusterdb`) + the cluster utilities (`pg_isready`, `pg_controldata`, `pg_resetwal`). Companion to [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) (`COPY` vs `\copy`) and [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) (psql prepared-statement meta-commands).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [psql — The Client](#psql--the-client)
    - [Connection + invocation](#connection--invocation)
    - [Backslash-command catalog](#backslash-command-catalog)
    - [Output formatting (`\pset`, `\x`, `\a`, `\H`, `\t`, `\T`, `\f`)](#output-formatting-pset-x-a-h-t-t-f)
    - [`\watch` — repeat a query on an interval](#watch--repeat-a-query-on-an-interval)
    - [`\copy` — client-side ingest/export](#copy--client-side-ingestexport)
    - [`\gexec` — generate-then-run](#gexec--generate-then-run)
    - [Variables, `\set`, `\if`/`\elif`/`\else`/`\endif`](#variables-set-ifelifelseendif)
    - [Prepared statements PG16+ + pipeline mode PG18+](#prepared-statements-pg16--pipeline-mode-pg18)
- [Per-database wrappers](#per-database-wrappers)
    - [`createdb` / `dropdb`](#createdb--dropdb)
    - [`createuser` / `dropuser`](#createuser--dropuser)
    - [`vacuumdb`](#vacuumdb)
    - [`reindexdb`](#reindexdb)
    - [`clusterdb`](#clusterdb)
- [Cluster utilities](#cluster-utilities)
    - [`pg_isready`](#pg_isready)
    - [`pg_controldata`](#pg_controldata)
    - [`pg_resetwal`](#pg_resetwal)
- [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- Connecting to a cluster via psql + need to script multi-statement runs
- Picking between SQL-form (`VACUUM ...`) vs CLI-wrapper (`vacuumdb`)
- Need parallelism for cluster-wide maintenance (only the wrappers offer `--jobs`)
- Writing health-check scripts (`pg_isready`)
- Inspecting a cluster offline (`pg_controldata` against a stopped data directory)
- Last-resort recovery (`pg_resetwal`) — see [`88-corruption-recovery.md`](./88-corruption-recovery.md)
- Looking up which `\d*` variant lists the catalog object you want
- Setting `psql` defaults (`~/.psqlrc`)
- Building maintenance jobs that run via `cron` / `systemd timers` / pg_cron

## Mental Model

1. **psql is the canonical client; backslash commands compile to catalog queries.** Use `\set ECHO_HIDDEN on` to inspect every catalog join. The same query you see runs from a script — backslash commands do not gain Postgres any privileges they did not already have. **All `\d*` commands honor `search_path`** for unqualified names.

2. **`\copy` is client-side; `COPY` is server-side.** `\copy` is a thin psql wrapper that issues `COPY ... FROM STDIN` (or `TO STDOUT`) and streams data over the connection. `COPY ... FROM '/path/file'` reads/writes the **server's** filesystem and requires `pg_read_server_files` / `pg_write_server_files` membership (or superuser). Cross-reference [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) Rule 1.

3. **`\watch N` re-runs the previous query every N seconds — the canonical "tail -f the catalog" pattern.** Build dashboards in psql by writing a single query and `\watch 5`. PG16 added options (count limit, named args, `0` for no-delay), PG17 added `min_rows` early-stop, PG18 added `WATCH_INTERVAL` variable for default.

4. **Maintenance wrappers can manage multiple connections.** `vacuumdb --jobs N` and `reindexdb --jobs N` parallelize independent commands. SQL `VACUUM (PARALLEL n)` separately parallelizes eligible index work within a table. `createdb`, `dropdb`, and PG16 `clusterdb` do not provide `--jobs`.[^vacuumdb-docs][^reindexdb-docs][^clusterdb-docs]

5. **psql variables + `\gexec` enable scripting without a procedural language.** `\gexec` takes the result of the previous query (which must be SQL text) and executes each cell as its own statement — the canonical pattern for "generate DDL statements with `format()` then run them." Combine with `\if`/`\else` (PG10+) for conditional branches. No PL/pgSQL needed.

## Decision Matrix

| Need | Use | Avoid |
|---|---|---|
| Interactive query / DBA shell | `psql` | `pgcli` (third-party, missing some `\d*` forms) |
| Connection check from script | `pg_isready -h host -p port -U user -d db -t 5` (no auth needed) | `psql -c 'SELECT 1'` (requires auth + opens full session) |
| Cluster-wide nightly VACUUM ANALYZE | `vacuumdb --all --analyze --jobs $(nproc)` | per-DB loop calling `psql -c 'VACUUM ANALYZE'` |
| One-index online REINDEX | `REINDEX INDEX CONCURRENTLY ...` or `reindexdb --concurrently --index ...` | blocking REINDEX without a maintenance window |
| Post-pg_upgrade ANALYZE on PG≤17 | `vacuumdb --all --analyze-in-stages --jobs $(nproc)` | one-shot `ANALYZE` across all DBs |
| Post-pg_upgrade statistics on PG18+ | Run both commands in Recipe 7: missing statistics in stages, then a full analyze | assuming transferred statistics eliminate post-upgrade ANALYZE |
| Stream a large query as CSV | `\copy (SELECT ...) TO ... WITH (FORMAT csv)` | treating comma-separated unaligned output as escaped CSV |
| Bulk import CSV | `psql -c "\copy tbl FROM '/local/file.csv' WITH CSV HEADER"` | server-side `COPY` if file is on client machine |
| Tail running queries every 5 s | Open interactive `psql`, execute the query, then run `\watch 5` | a shell loop that reconnects for each sample |
| Generate-then-execute DDL | `\gexec` after a SELECT producing valid SQL strings | per-row `psql -c` invocation from bash loop |
| Inspect a stopped cluster's WAL state | `pg_controldata $PGDATA` | starting the cluster (changes the very state you're inspecting) |
| Fetch all rows of a huge SELECT in psql without OOM | `\set FETCH_COUNT 1000` | default behavior (psql buffers entire result set) |
| Run a script with strict error handling | `psql -v ON_ERROR_STOP=1 -f script.sql` | default (script continues past errors) |

**Three smell signals**

1. **Shell loops that split database names on whitespace can target the wrong database.** Use `vacuumdb --all` for cluster-wide maintenance.
2. **Choose the probe by what it must establish.** `pg_isready` checks server connection status; an authenticated application query checks credentials and query execution.
3. **Bash loop over `psql -c` for many similar queries** — re-implementing `\gexec`. The loop pays per-invocation connection setup cost (typically 5–50 ms each).

## psql — The Client

### Connection + invocation

Connection strings supplied as the database argument override conflicting `-h`, `-p`, and `-U` flags. Explicit connection parameters override service-file values; service-file values override corresponding environment defaults. Without a host, Unix clients normally use a local Unix-domain socket; Windows normally uses localhost.[^psql18-docs]

Common invocation forms:

    # Interactive
    psql -h db.example.com -p 5432 -U app -d mydb

    # URI form (preferred for scripts — single quotable string)
    psql 'postgresql://app@db.example.com:5432/mydb?sslmode=verify-full&channel_binding=require'

    # Service file (best for shared scripts; password lives in ~/.pgpass not the URI)
    psql service=production_app

    # One-shot SQL
    psql -c 'SELECT version();'

    # Run a script with strict error handling, suppress stdin echo
    psql -v ON_ERROR_STOP=1 -X -q -f migration.sql

    # Escaped CSV output with no header:
    psql -X --csv -t -P pager=off -c 'SELECT col1, col2 FROM t'

Useful flags:

| Flag | Purpose |
|---|---|
| `-c 'SQL'` | Execute a SQL command string, which may contain multiple statements, or one backslash command |
| `-f file.sql` | Execute file and exit |
| `-X` | Skip `~/.psqlrc` (clean shell, useful in scripts) |
| `-q` | Quiet — suppress chatty output |
| `-A` | Unaligned separator-delimited output, without CSV escaping |
| `-t` | Tuples-only (no header, no row count) |
| `-At` | Combine — pure data, one row per line |
| `-F SEP` | Field separator for unaligned output |
| `-R REC` | Record separator for unaligned output |
| `-P pager=off` | Disable pager (essential in pipelines) |
| `-v NAME=VALUE` | Set a psql variable |
| `-1` | Wrap entire script in a single transaction |
| `-e` | Echo SQL as it executes |
| `-E` | Echo hidden catalog queries (interactive form: `\set ECHO_HIDDEN on`) |

### Backslash-command catalog

Compact reference. The full PG18 catalog has ~80 commands; this table covers the operationally important set.

| Command | Purpose |
|---|---|
| `\?` | Help on backslash commands |
| `\h [SQL_KEYWORD]` | Help on SQL syntax (e.g., `\h CREATE INDEX`) |
| `\q` | Quit |
| `\c [DB] [USER] [HOST] [PORT]` | Connect to a different database / user / host |
| `\conninfo` | Show current connection info (PG18+: tabular, more fields) |
| `\encoding [ENC]` | Show or set client encoding |
| `\password [USER]` | Change password (hashes client-side; never sends plaintext) |
| `\timing [on\|off]` | Show execution time per statement |
| `\d [PATTERN]` | Describe object (works on tables, views, sequences, indexes) |
| `\dt [PATTERN]` | List tables |
| `\dt+ [PATTERN]` | List tables with size and description (PG14+: includes access method) |
| `\dti [PATTERN]` | List tables and indexes (PG14+: TOAST tables and their indexes) |
| `\di [PATTERN]` | List indexes |
| `\dm [PATTERN]` | List materialized views |
| `\dv [PATTERN]` | List views |
| `\ds [PATTERN]` | List sequences |
| `\df [PATTERN]` | List functions |
| `\df+ [PATTERN]` | List functions with details (PG16+: no longer shows source — use `\sf`) |
| `\dn [PATTERN]` | List schemas |
| `\dx [PATTERN]` | List installed extensions (PG18+: includes `default_version`) |
| `\dX [PATTERN]` | List extended statistics (PG14+) |
| `\du` / `\dg` | List roles (PG16+: `Member of` column moved to `\drg`) |
| `\drg` | List role memberships (PG16+) |
| `\dRp` | List replication publications |
| `\dRs` | List replication subscriptions |
| `\dconfig [PATTERN]` | Show server variables (PG15+) |
| `\dp` / `\z` | Show table privileges |
| `\ddp` | Show default privileges |
| `\dt+ schema.*` | List all tables in a schema with details |
| `\sf FUNC` | Show function source |
| `\sv VIEW` | Show view definition |
| `\ef [FUNC]` | Open function definition in `$EDITOR` |
| `\ev [VIEW]` | Open view definition in `$EDITOR` |
| `\e [FILE]` | Open editor with current query buffer (or file) |
| `\i FILE` | Include + execute file |
| `\ir FILE` | Include relative to current script |
| `\copy ...` | Client-side COPY |
| `\watch N` | Re-run last query every N seconds |
| `\gexec` | Execute the result set (each cell = a SQL statement) |
| `\gset [PREFIX]` | Store the result row in psql variables |
| `\g [FILE]` | Execute current buffer (alternative to `;`); optionally write output to FILE |
| `\gx` | Execute and force expanded output |
| `\set NAME [VAL]` / `\unset NAME` | psql variable assignment |
| `\getenv VAR ENVVAR` | Assign env var to psql variable (PG15+) |
| `\if EXPR` / `\elif` / `\else` / `\endif` | Conditional blocks (PG10+) |
| `\bind 'val1' 'val2'` | Bind parameters for next query (PG16+, extended-query protocol) |
| `\parse stmt_name` | Parse query as named prepared statement (PG18+) |
| `\bind_named stmt_name 'val'` | Bind to named prepared statement (PG18+) |
| `\close_prepared stmt_name` | Close prepared statement (PG18+) |
| `\startpipeline` / `\sendpipeline` / `\syncpipeline` / `\endpipeline` | Pipeline mode (PG18+) |

> [!NOTE] PostgreSQL 16 — `\df+` no longer shows function source
> Verbatim release-note: *"Prevent `\df+` from showing function source code (Isaac Morland). Function bodies are more easily viewed with `\sf`."* If you upgraded a script that grep'd `\df+` output for function bodies, switch to `\sf FUNC`.

> [!NOTE] PostgreSQL 16 — `Member of` column removed from `\du` / `\dg`
> Verbatim release-note: *"Add psql command `\drg` to show role membership details (Pavel Luzanov). The `Member of` output column has been removed from `\du` and `\dg` because this new command displays this information in more detail."*

> [!NOTE] PostgreSQL 18 — `\conninfo` reformatted
> Verbatim release-note: *"Change psql's `\conninfo` to use tabular format and include more information (Álvaro Herrera, Maiquel Grassi, Hunaid Sohail)."* Adds backend PID, application_name, GSSAPI/SSL info, system identifier. If a script greps `\conninfo` output, audit it before upgrading.

### Output formatting (`\pset`, `\x`, `\a`, `\H`, `\t`, `\T`, `\f`)

| Command | Effect |
|---|---|
| `\pset format aligned` | Default — column-aligned text |
| `\pset format unaligned` | One row per line, separator-delimited |
| `\pset format csv` | CSV format (PG12+) |
| `\pset format html` | HTML table |
| `\pset format latex` | LaTeX tabular |
| `\pset format wrapped` | Auto-wrap wide columns |
| `\x [on\|off\|auto]` | Expanded display (one column per line) |
| `\a` | Toggle aligned ↔ unaligned |
| `\H` | Toggle HTML output |
| `\t` | Toggle tuples-only (suppress headers + row count) |
| `\T 'class="..."'` | Set HTML table tag attributes |
| `\f SEP` | Field separator for unaligned format |
| `\pset null '(NULL)'` | Display string for SQL NULL (default: empty) |
| `\pset border N` | Border style: 0 (none), 1 (lines between cols), 2 (full grid) |
| `\pset pager on\|off\|always` | Pager control |

### `\watch` — repeat a query on an interval

Re-runs the previous query every N seconds. The canonical "tail -f the catalog" pattern.

    -- Watch active queries every 2 seconds
    SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS xact_age, query
    FROM pg_stat_activity
    WHERE state != 'idle'
    ORDER BY xact_age DESC NULLS LAST;
    \watch 2

PG16+ named options:

    -- Every 5 seconds, stop after 10 runs.
    \watch interval=5 count=10

PG17+ early-stop on minimum row count:

    -- Stop when fewer than one row is returned.
    \watch interval=5 min_rows=1

PG18+ default interval via variable:

    \set WATCH_INTERVAL 10
    SELECT count(*) FROM pg_stat_activity WHERE state='active';
    \watch

> [!NOTE] PostgreSQL 16 — `\watch 0` for no-delay
> Verbatim release-note: *"Detect invalid values for psql `\watch`, and allow zero to specify no delay (Andrey Borodin)."* Useful for tight monitoring loops, but watch out for client-side CPU burn.

### `\copy` — client-side ingest/export

`\copy` is a psql meta-command that issues `COPY ... FROM STDIN` (or `TO STDOUT`) under the hood and streams data over the connection. The file is **on the psql client's machine**, not the server. No special server-side privilege required beyond INSERT/SELECT on the target table.

    -- Import: file lives on machine running psql
    \copy events FROM '/local/path/events.csv' WITH (FORMAT csv, HEADER true)

    -- Export: SELECT result to a local CSV
    \copy (SELECT * FROM events WHERE created_at > now() - interval '1 day') TO '/local/out.csv' WITH (FORMAT csv, HEADER true)

    -- Pipe to/from another command
    \copy events TO PROGRAM 'gzip > /local/events.csv.gz' WITH (FORMAT csv, HEADER true)

> [!WARNING] **`\copy` is single-line only — no continuation, no variable interpolation**
> Variables (`:var`) are not expanded inside `\copy`. Use SQL `COPY (...) TO STDOUT` terminated by `\g filename` or `\g |command` when psql interpolation or multiline SQL is needed. Shell `printf %q` quotes for a shell, not for SQL, and is not an SQL-injection defense.[^psql18-docs]

### `\gexec` — generate-then-run

Take the result of the previous query (a result set of SQL strings) and execute each cell as its own statement. The canonical pattern for "generate DDL with `format()`, then run it."

    -- Reindex every B-tree index larger than 100 MB
    SELECT format('REINDEX INDEX CONCURRENTLY %I.%I;', n.nspname, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am a       ON a.oid = c.relam
    WHERE c.relkind = 'i'
      AND a.amname = 'btree'
      AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
      AND pg_relation_size(c.oid) > 100 * 1024 * 1024
    ORDER BY pg_relation_size(c.oid) DESC
    \gexec

Each cell becomes a separate statement (each in its own implicit transaction unless wrapped in `BEGIN`).

### Variables, `\set`, `\if`/`\elif`/`\else`/`\endif`

    \set min_age '7 days'
    SELECT count(*) FROM events WHERE created_at < now() - interval :'min_age';

    \set tbl events
    SELECT count(*) FROM :"tbl";              -- :"name" = double-quoted identifier
    SELECT count(*) FROM :tbl;                -- :name = raw substitution

    -- :'val' = single-quoted literal
    SELECT * FROM events WHERE category = :'min_age';   -- becomes '7 days' literal

    -- Conditional execution
    \set major_version '16'
    \if :{?major_version}
        \echo Variable major_version is set
    \else
        \echo Variable major_version is unset
    \endif

> [!NOTE] PostgreSQL 15 — `\getenv`
> Verbatim release-note: *"Add `\getenv` command to assign the value of an environment variable to a psql variable (Tom Lane)."* Cleaner than reading env vars via shell `printf` substitution:
>
>     \getenv my_db PGDATABASE
>     \echo Connected to: :my_db

### Prepared statements PG16+ + pipeline mode PG18+

PG16 added `\bind` for one-shot bound queries; PG18 added the full lifecycle (`\parse`, `\bind_named`, `\close_prepared`) plus pipeline-mode meta-commands.

    -- PG16+ one-shot bound query (extended-query protocol)
    SELECT id, email FROM users WHERE id = $1 \bind 42 \g

    -- PG18+ named prepared statements
    SELECT id, email FROM users WHERE id = $1 \parse stmt_user
    \bind_named stmt_user 42 \g
    \bind_named stmt_user 99 \g
    \close_prepared stmt_user

    -- PG18+ pipeline mode (group commands without waiting for results)
    \startpipeline
    INSERT INTO events VALUES (...) \sendpipeline
    INSERT INTO events VALUES (...) \sendpipeline
    INSERT INTO events VALUES (...) \sendpipeline
    \syncpipeline
    \getresults
    \endpipeline

Cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) for the full prepared-statement model + plan-cache mechanics.

## Per-database wrappers

These utilities wrap SQL commands, but their options differ. `vacuumdb` and `reindexdb` support `--jobs`; PG16 `clusterdb` does not. `createdb`, `dropdb`, `createuser`, and `dropuser` operate on named objects rather than sharing every maintenance option.

### `createdb` / `dropdb`

    # Create a database with explicit owner + template + locale
    createdb -h db.example.com -U postgres -O app -T template0 -E UTF8 \
        --locale-provider=icu --icu-locale=en-US -e mydb

    # Drop with --force (PG13+) — kicks connected users
    dropdb --force --if-exists mydb

`-T template0` is recommended over the default `template1` when you want a clean slate (no template1-installed extensions or seed data). `--force` (PG13+) terminates active connections via `pg_terminate_backend` first.

### `createuser` / `dropuser`

    # Create a login role with explicit attributes (interactive password prompt)
    createuser -h db.example.com -U postgres --pwprompt --no-superuser \
        --no-createdb --no-createrole --connection-limit=50 app_user

    # PG16+ extended options
    createuser --valid-until '2026-12-31' --no-bypassrls \
        --member-of=app_readers app_user

> [!NOTE] PostgreSQL 16 — `--member-of` replaces `--role`
> Verbatim release-note: *"Deprecate createuser option `--role` (Nathan Bossart). This option could be easily confused with new createuser role membership options, so option `--member-of` has been added with the same functionality. The `--role` option can still be used."* Use `--member-of` going forward.

### `vacuumdb`

Shell wrapper for `VACUUM` and `ANALYZE` across databases and tables. Cross-reference [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) Recipe 12.

| Flag | Purpose |
|---|---|
| `-a` / `--all` | All databases (cluster-wide) |
| `-d DBNAME` | Specific database |
| `-t TABLE` | Specific table (repeatable) |
| `--schema NAME` | Limit to schema (PG16+) |
| `--exclude-schema NAME` | Exclude schema (PG16+) |
| `-z` / `--analyze` | Run ANALYZE after VACUUM |
| `-Z` / `--analyze-only` | Only ANALYZE (no VACUUM) |
| `--analyze-in-stages` | 3-pass ANALYZE: small target → larger → full (good post-pg_upgrade on PG≤17) |
| `-j N` / `--jobs=N` | Parallel connections (one VACUUM per connection) |
| `--full` | VACUUM FULL (acquires ACCESS EXCLUSIVE — usually wrong choice) |
| `--freeze` | VACUUM FREEZE — pre-emptive freeze, useful before major upgrades |
| `--disable-page-skipping` | Skip the visibility-map shortcut |
| `--no-process-toast` | Skip TOAST tables (PG14+) |
| `--no-process-main` | Skip main relation, only TOAST (PG16+) |
| `--buffer-usage-limit SIZE` | Cap shared buffer ring used by VACUUM (PG16+, e.g. `--buffer-usage-limit=256MB`) |
| `--missing-stats-only` | Only ANALYZE relations missing stats (PG18+, requires `--analyze-only` or `--analyze-in-stages`, superuser) |
| `--skip-locked` | Skip relations whose lock cannot be acquired immediately |

Common patterns:

    # Cluster-wide nightly maintenance
    vacuumdb --all --analyze --jobs $(nproc) --skip-locked

    # Post-pg_upgrade ANALYZE for PG≤17 targets:
    vacuumdb --all --analyze-in-stages --jobs $(nproc)

    # PG18+: only fill in stats that are missing (e.g., for newly-restored objects)
    vacuumdb --all --analyze-only --missing-stats-only --jobs $(nproc)

    # Cap memory pressure on a busy cluster
    vacuumdb --all --analyze --jobs 4 --buffer-usage-limit=64MB

    # Pre-upgrade defensive freeze on a hot table
    vacuumdb -d mydb -t events --freeze

> [!NOTE] Database selection
> `vacuumdb --all` means all databases, not a database-name pattern. Do not append a pattern as its argument. Use the installed utility's documented selection options.[^vacuumdb17-docs]

> [!NOTE] PostgreSQL 18 — `vacuumdb --missing-stats-only`
> Verbatim release-note: *"Add vacuumdb option `--missing-stats-only` to compute only missing optimizer statistics (Corey Huinker, Nathan Bossart). This option can only be run by superusers and can only be used with options `--analyze-only` and `--analyze-in-stages`."* Useful when restoring a logical dump (which doesn't carry stats) or when extended statistics objects were added but never ANALYZEd.

### `reindexdb`

| Flag | Purpose |
|---|---|
| `-a` / `--all` | Cluster-wide |
| `-d DBNAME` | Specific database |
| `-t TABLE` | Specific table (repeatable) |
| `-i INDEX` | Specific index (repeatable) |
| `-s` / `--system` | Reindex system catalogs |
| `-S SCHEMA` | Specific schema |
| `--concurrently` | Use REINDEX CONCURRENTLY (PG12+) |
| `-j N` / `--jobs=N` | Parallel connections (one REINDEX per connection) |
| `--tablespace TS` | Place new index files in a tablespace (PG14+) |

    # Concurrent cluster-wide reindex with parallelism
    reindexdb --all --concurrently --jobs 4

    # Reindex the indexes of events concurrently:
    reindexdb -d mydb --concurrently -t events

> [!WARNING] **`reindexdb --concurrently` is per-table, not per-index parallel**
> `--jobs N` opens N connections, each running `REINDEX TABLE CONCURRENTLY`. Within a single REINDEX TABLE, indexes are still rebuilt sequentially. For finer-grained parallelism, use `\gexec` to generate per-index `REINDEX INDEX CONCURRENTLY` statements and run them via separate psql sessions or pg_cron jobs.

### `clusterdb`

`clusterdb` runs the SQL `CLUSTER` command which physically reorders a table by index. Rare in modern workflows — `pg_repack` (an extension) is preferred because `CLUSTER` takes ACCESS EXCLUSIVE for the duration. See [`26-index-maintenance.md`](./26-index-maintenance.md) for `pg_repack`.

    psql -d mydb -c 'CLUSTER events USING events_pkey;'  # first clustering; blocks access
    clusterdb -d mydb -t events                        # later reuses its recorded index

## Cluster utilities

### `pg_isready`

The right tool for healthchecks. No authentication, no full session — only sends a TCP probe + minimal startup packet. Returns:

| Exit code | Meaning |
|---|---|
| `0` | Server is accepting connections |
| `1` | Server is rejecting (e.g., still recovering, in maintenance mode) |
| `2` | No response (network unreachable, server not listening) |
| `3` | No attempt was made (bad arguments) |

    # Liveness probe in a Kubernetes container
    pg_isready -h db -p 5432 -U app -d mydb -t 5
    echo "exit code: $?"

    # In a script, fail fast
    pg_isready -h db -t 3 || { echo "DB down"; exit 1; }

> [!WARNING] **`pg_isready` does not verify auth, RLS, or query execution**
> A `pg_isready 0` only means the postmaster is accepting TCP. It does not prove a specific role can authenticate or that the application can run queries. For deeper liveness checks, use `psql -c 'SELECT 1'` (with cached credentials) or an application-level `/health` endpoint that issues a real query.

### `pg_controldata`

Inspect `$PGDATA/global/pg_control` for cluster and checkpoint metadata. The utility can read a running cluster's control file, but this is not an atomic live-state snapshot; use a stopped cluster for offline recovery decisions.[^pg-controldata-docs]

    pg_controldata $PGDATA

    # Sample output (truncated):
    # pg_control version number:            1300
    # Catalog version number:               202307071
    # Database system identifier:           7345...
    # Database cluster state:               in production
    # pg_control last modified:             ...
    # Latest checkpoint location:           1/2A000028
    # Latest checkpoint's REDO location:    1/2A000028
    # Latest checkpoint's REDO WAL file:    00000001000000010000002A
    # ...

Used in: pre-restore validation, pg_rewind preflight, disaster-recovery diagnosis. The system identifier matters for pg_basebackup compatibility checks.

### `pg_resetwal`

> [!WARNING] **Last-resort recovery only — destroys data integrity guarantees**
> Use only for expert-directed salvage when WAL or control-file corruption prevents startup and no usable backup recovery path exists. It does not repair data files or prove consistency. Use same-major binaries against a stopped, isolated salvage copy after preserving the complete cluster, including external WAL and tablespaces. Follow [`88-corruption-recovery.md`](./88-corruption-recovery.md#recipe-8--pg_resetwal-last-resort), then dump and restore into a separate new cluster.[^pg-resetwal-docs]

    # Inspect proposed values only; do not copy an example XID into a real cluster.
    pg_resetwal --dry-run -D "$SALVAGE_PGDATA"

> [!WARNING] Minor releases 2026-08-13 / 2026-11-12
> psql: CVE-2026-6464 (CVSS 8.1, 2026-08-13 minors, 18.6 and the matching older branches). When a `COPY ... FROM STDIN` fails early, psql now skips its inline data, so test scripts that intentionally fail need a `\.` terminator. 18.7 fixed a regression so that multiple `COPY ... FROM STDIN` in one command string work again.[^minor-18-6][^minor-18-7] CVE-2026-18408 (CVSS 8.8, 2026-08-13) concerns psql `\unrestrict`.[^minor-aug-announce] `reindexdb`: CVE-2026-116325 (quoting, CVSS 8.0, 2026-11-12).[^minor-nov-announce] Full CVE list: <https://www.postgresql.org/support/security/>.

## Per-version timeline

| Version | psql / wrapper changes |
|---|---|
| **PG14** | `\dt+`/`\di+`/`\dm+` add access-method column;[^pg14-am-col] `\dt`/`\di` show TOAST tables and indexes;[^pg14-toast] new `\dX` for extended-stats objects;[^pg14-dx] `vacuumdb` `--no-process-toast`.[^pg14-vacuumdb] |
| **PG15** | New `\dconfig` for server vars;[^pg15-dconfig] new `\getenv`;[^pg15-getenv] `\watch` gets a pager option;[^pg15-watch-pager] all results from multi-statement queries displayed.[^pg15-multi-results] |
| **PG16** | `\bind` for extended-query protocol;[^pg16-bind] `\watch` `count` + `interval` options + `0` allowed;[^pg16-watch-count][^pg16-watch-zero] `SHELL_ERROR`/`SHELL_EXIT_CODE` variables;[^pg16-shell-vars] `\drg` for role memberships;[^pg16-drg] `\dpS`/`\zS` show system objects;[^pg16-dps] `\df+` no longer shows source;[^pg16-df-source] `xheader_width` `\pset` option;[^pg16-xheader] vacuumdb `--schema`/`--exclude-schema`;[^pg16-vacuumdb-schema] vacuumdb `--no-process-main`;[^pg16-vacuumdb-main] vacuumdb `--buffer-usage-limit`;[^pg16-vacuumdb-bul] createuser `--valid-until`/`--bypassrls`/`--member-of` (deprecates `--role`).[^pg16-createuser-options][^pg16-createuser-deprecate] |
| **PG17** | `\dp` shows `(none)` for empty privileges;[^pg17-dp-none] backslash commands honor `\pset null`;[^pg17-pset-null] `\watch` adds `min_rows`;[^pg17-watch-minrows] connection attempts cancelable with Ctrl-C;[^pg17-cancel-connect] broader `FETCH_COUNT` support for result-returning commands.[^pg17-fetch-count] |
| **PG18** | New `\parse`/`\bind_named`/`\close_prepared`;[^pg18-prep] full pipeline-mode meta-commands `\startpipeline`/`\sendpipeline`/`\syncpipeline`/`\endpipeline`/`\flushrequest`/`\flush`/`\getresults`;[^pg18-pipeline] `%P` prompt char + `PIPELINE_*` variables;[^pg18-pipeline-vars] connection service name in prompt;[^pg18-svc-prompt] `\conninfo` reformatted to tabular with more info;[^pg18-conninfo] `x` suffix for expanded mode on list commands;[^pg18-x-suffix] `WATCH_INTERVAL` variable;[^pg18-watch-interval] leakproof in `\df+`/`\do+`/`\dAo+`/`\dC+`;[^pg18-leakproof] `default_version` in `\dx`;[^pg18-dx-default] vacuumdb `--missing-stats-only`.[^pg18-missing-stats] |

## Examples / Recipes

### Recipe 1 — Production-baseline `~/.psqlrc`

The single configuration file that improves DBA experience the most:

    -- ~/.psqlrc
    \set QUIET 1
    \pset null '(NULL)'
    \pset linestyle unicode
    \pset border 2

    \set HISTSIZE 10000
    \set HISTFILE ~/.psql_history-:DBNAME

    \set COMP_KEYWORD_CASE upper
    \set ECHO_HIDDEN on
    \set VERBOSITY verbose
    \set ON_ERROR_ROLLBACK interactive

    \timing on
    \x auto

    -- Helpful prompt: [user@db:port]
    \set PROMPT1 '%[%033[33;1m%]%n%[%033[0m%]@%[%033[33;1m%]%/%[%033[0m%]:%>%R%# '
    \set PROMPT2 '%[%033[33;1m%]%/%[%033[0m%]:%>%R%# '

    \unset QUIET

Skip with `psql -X` when scripting (no sourcing of `~/.psqlrc`).

### Recipe 2 — Connection Readiness Probe

    #!/bin/bash
    set -euo pipefail
    pg_isready -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" \
               -U "${PGUSER:-postgres}" -d "${PGDATABASE:-postgres}" -t 5

Use this for connection readiness, not as the sole restart-triggering liveness check: an otherwise healthy server may reject connections during crash recovery. Allow adequate startup time and use an operator's PostgreSQL-specific probes when available. A real authenticated query is needed to test application readiness.

### Recipe 3 — Cluster-wide Maintenance from an OS Scheduler

Use an operating-system scheduler to invoke the maintenance wrapper. Choose concurrency from the server's capacity, not automatically from its CPU count:

    vacuumdb --all --analyze --jobs=4 --skip-locked --buffer-usage-limit=64MB

This skips relations it cannot lock immediately, so monitor later maintenance and do not use it as a wraparound-emergency runbook. A pg_cron job is database-local SQL; use `cron.schedule_in_database()` for explicitly selected databases rather than constructing libpq connection strings with SQL identifier quoting.[^vacuumdb-docs]

### Recipe 4 — Bulk-reindex every B-tree index >100 MB via `\gexec`

    \timing on

    SELECT format('REINDEX INDEX CONCURRENTLY %I.%I;', n.nspname, c.relname) AS sql
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am a       ON a.oid = c.relam
    WHERE c.relkind = 'i'
      AND a.amname = 'btree'
      AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
      AND pg_relation_size(c.oid) > 100 * 1024 * 1024
    ORDER BY pg_relation_size(c.oid) DESC
    \gexec

`\gexec` executes each generated statement; it does not first print them as a separate result set. Inspect the SELECT separately before destructive maintenance. Set `ON_ERROR_STOP` to stop after an error, or leave it off only if continuing is intentional.[^psql18-docs]

### Recipe 5 — Tail active queries with `\watch`

    SELECT pid,
           state,
           wait_event_type || '/' || wait_event AS wait,
           now() - xact_start AS xact_age,
           substring(query, 1, 80) AS q
    FROM pg_stat_activity
    WHERE state != 'idle' AND pid != pg_backend_pid()
    ORDER BY xact_age DESC NULLS LAST;
    \watch interval=2 count=30

PG17+ early-stop:

    SELECT pid, state, query
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND pid != pg_backend_pid();
    -- Stop once no lock-wait rows remain.
    \watch interval=1 min_rows=1

### Recipe 6 — Stream a huge SELECT to compressed CSV without OOM

Default psql buffers the entire result set client-side. For multi-GB exports:

    set -o pipefail
    psql -X -v ON_ERROR_STOP=1 \
         -c "\copy (SELECT * FROM events WHERE created_at > now() - interval '30 days') TO STDOUT WITH (FORMAT csv, HEADER true)" \
         | gzip -9 > events_30d.csv.gz

Or interactively, use `FETCH_COUNT`:

    \set FETCH_COUNT 1000
    SELECT * FROM events WHERE created_at > now() - interval '30 days';

`FETCH_COUNT` opens an implicit cursor and fetches in batches, keeping psql memory bounded.

### Recipe 7 — Post-pg_upgrade ANALYZE strategy

For PG≤17 (planner stats lost on upgrade):

    vacuumdb --all --analyze-in-stages --jobs $(nproc)

`--analyze-in-stages` runs three passes: `default_statistics_target=1`, then `=10`, then full default. The cluster becomes minimally usable after the first pass and gets progressively better stats. Cross-reference [`55-statistics-planner.md`](./55-statistics-planner.md) Recipe 11.

For PG18+ (pg_upgrade preserves per-column stats; extended stats still lost):

    vacuumdb --all --analyze-only --missing-stats-only --jobs $(nproc)

PG18's post-upgrade instructions require both missing planner statistics and refreshed cumulative statistics. Follow the missing-stats pass with `vacuumdb --all --analyze-only --jobs=4`; do not assume missing extended statistics are covered by a missing-per-column-statistics filter.[^pg18-upgrade]

### Recipe 8 — Capture EXPLAIN output to a file (with full plan + buffers)

    psql -X -P pager=off -c "
        EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)
        SELECT u.name, count(o.id)
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
        WHERE u.created_at > now() - interval '30 days'
        GROUP BY u.id, u.name
        ORDER BY count(o.id) DESC
        LIMIT 10
    " > plan.json

Keep SQL echoing disabled so the file contains only the JSON plan. `EXPLAIN ANALYZE` executes the query, including any side effects. Cross-reference [`56-explain.md`](./56-explain.md).

### Recipe 9 — Generate-then-restore role grants script

This extracts only visible table grants other than PUBLIC and postgres. It omits ownership, default privileges, role memberships, grant options, and other object types; use `pg_dump` and `pg_dumpall --globals-only` for a complete migration rather than this partial report.

    psql -X -At -c "
        SELECT format(
            'GRANT %s ON TABLE %I.%I TO %I;',
            string_agg(privilege_type, ', '),
            table_schema, table_name, grantee
        )
        FROM information_schema.role_table_grants
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND grantee NOT IN ('postgres', 'PUBLIC')
        GROUP BY table_schema, table_name, grantee
        ORDER BY table_schema, table_name, grantee
    " > grants.sql

    # Restore into target cluster
    psql -h target -d mydb -f grants.sql

### Recipe 10 — Audit psql variables in a script

    \echo Configured psql variables:
    \echo   ON_ERROR_STOP    = :{?ON_ERROR_STOP}
    \echo   AUTOCOMMIT       = :AUTOCOMMIT
    \echo   ECHO             = :ECHO
    \echo   VERBOSITY        = :VERBOSITY
    \echo   FETCH_COUNT      = :{?FETCH_COUNT}

The `:{?VAR}` form yields `TRUE` or `FALSE` based on whether the variable is set; `:VAR` substitutes its value.

### Recipe 11 — Connection service file for shared scripts

`~/.pg_service.conf` (per-user) or `/etc/postgresql-common/pg_service.conf` (system-wide):

    [production]
    host=db.prod.example.com
    port=5432
    user=app
    dbname=mydb
    sslmode=verify-full
    sslrootcert=/etc/ssl/certs/postgres-ca.crt
    channel_binding=require

    [staging]
    host=db.staging.example.com
    port=5432
    user=app
    dbname=mydb
    sslmode=verify-full

Then in scripts:

    psql service=production -f migration.sql

Passwords go in `~/.pgpass` (mode `0600`):

    db.prod.example.com:5432:mydb:app:secret_password
    *:*:mydb:app:secret_password

### Recipe 12 — PG18+ pipeline mode for high-throughput ingest

    -- Group N inserts into a single round-trip
    \startpipeline
    INSERT INTO events (ts, payload) VALUES (now(), '{"a":1}'::jsonb) \sendpipeline
    INSERT INTO events (ts, payload) VALUES (now(), '{"a":2}'::jsonb) \sendpipeline
    INSERT INTO events (ts, payload) VALUES (now(), '{"a":3}'::jsonb) \sendpipeline
    \syncpipeline
    \getresults
    \endpipeline

Pipeline mode reduces round-trip latency for batch operations. Cross-reference libpq pipeline mode docs.

### Recipe 13 — Inspect a stopped cluster's WAL position

Useful for pre-`pg_rewind` validation or post-crash forensics:

    sudo -u postgres pg_controldata /var/lib/postgresql/16/data | \
        grep -E 'Database cluster state|Latest checkpoint location|REDO location|System identifier|TimeLineID'

Cross-reference [`89-pg-rewind.md`](./89-pg-rewind.md).

### Recipe 14 — Inventory of psql backslash commands at this site

Run this to discover what's available in your psql:

    \?

Or grep the binary for documented options:

    psql --help | less

## Gotchas / Anti-patterns

1. **`\copy` is single-line — no continuation, no variables.** Multi-line `\copy` statements fail to parse. `:var` substitution is not performed inside `\copy`. Workaround: use server-side `COPY` with appropriate role membership, or assemble the `\copy` line in shell first.

2. **`pg_isready` is not an authenticated health check.** It has four exit codes (0–3) and checks connection status, not whether the application can authenticate and run queries.[^pg-isready-docs]

3. **Unqualified relation patterns honor visibility in `search_path`.** If both schemas contain `users`, `\d users` shows the first visible one. Use `\d app.users` to select the schema explicitly.[^psql18-docs]

4. **Client output changes across versions.** PG16 removed function source from `\df+`; PG14 added access-method output to `\d[i|m|t]+`. Use SQL catalogs or a documented machine-readable format for automation.[^pg16-df-source][^pg14-am-col]

5. **`\watch min_rows=N` stops when the result has fewer than N rows.** It does not stop when N matching rows first appear. Use it to wait for existing work to disappear, or write a query whose output becomes empty when the desired condition holds.[^psql18-docs]

6. **`vacuumdb --jobs N` opens N connections to the SAME database.** Each connection counts against `max_connections`; if N > available connections, vacuumdb fails. Cap `--jobs` at `max_connections - reserved_connections - actual_app_connections`.

7. **`reindexdb --concurrently --jobs N` parallelizes per-table, not per-index.** A single REINDEX TABLE rebuilds indexes serially; only multiple tables run in parallel. For finer parallelism, use `\gexec` to generate per-index `REINDEX INDEX CONCURRENTLY` and run via separate sessions.

8. **`vacuumdb --full` is almost always wrong.** It runs `VACUUM FULL` which acquires `ACCESS EXCLUSIVE` and rewrites the entire table. Use `pg_repack` for online table rewrite. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) gotcha #2.

9. **`createdb -T template1` inherits everything in template1.** If template1 has extensions or seed data, they end up in your new database. Use `-T template0` for a clean slate.

10. **`dropdb --force` (PG13+) terminates connections via `pg_terminate_backend`.** Same caveats as direct `pg_terminate_backend`: do not use against walsenders or logical-replication apply workers without understanding consequences. Cross-reference [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) Recipe 13.

11. **`pg_isready` code 1 means rejecting connections; code 2 means no response.** Single-user mode has no client listener and should not be classified as a normal accepting postmaster.[^pg-isready-docs]

12. **`pg_resetwal` is data-destructive.** It throws away WAL state to allow startup. Always immediately `pg_dumpall` and restore into a fresh `initdb` cluster after using it.

13. **`pg_controldata` reports stored control metadata.** It does not establish current transaction, replication, or filesystem consistency on a running server. Use it with the server stopped for recovery decisions.[^pg-controldata-docs]

14. **`psql -1` wraps the entire script in one transaction — including any `CREATE INDEX CONCURRENTLY`.** CIC cannot run inside a transaction block; `psql -1 -f migration.sql` will fail at the CIC statement. For migrations with CIC, omit `-1` or split the script. See [`26-index-maintenance.md`](./26-index-maintenance.md) gotcha #1.

15. **`ON_ERROR_STOP=0` (default) silently continues past errors.** A migration script that creates 100 objects and fails on object 50 leaves the database in an inconsistent state. **Always `psql -v ON_ERROR_STOP=1`** in scripts.

16. **Use COPY for bounded-memory exports.** `FETCH_COUNT` can batch supported result-returning commands, but is not a universal promise that every SQL result streams. `\copy` uses the COPY protocol and does not buffer the whole table in psql.[^psql18-docs]

17. **`\set ECHO_HIDDEN on` shows the catalog query but does NOT show the catalog query result format.** The output of the backslash command itself is post-formatted. To see the raw query result, copy the `********* QUERY **********` output and run it manually.

18. **`createuser --pwprompt` sets the new role's password.** `PGPASSWORD` and `.pgpass` authenticate the administrative connection; they do not supply that new password. Use a controlled secret-provisioning path or `\password` for the new role.[^createuser-docs]

19. **`psql -e` echoes SQL but `\set ECHO all` echoes ALSO from `\i`-included files.** Both useful in different cases. Use `\set ECHO queries` for SQL-only echo.

20. **`\timing` measures total elapsed time including network round-trip.** For server-side execution time only, use `EXPLAIN ANALYZE` or `pg_stat_statements`.

21. **`\dx` shows installed extensions, not available extensions.** Use `SELECT * FROM pg_available_extensions` for the full catalog.

22. **Utility concurrency and database selection are separate options.** `--all` selects databases and `--jobs` limits concurrent maintenance commands where supported; do not assume that it refetches the database list for each worker.[^vacuumdb-docs]

23. **PG18 `\conninfo` reformatted to tabular** — scripts that parse the old key-value format break. Audit before upgrading. Verbatim release-note: *"Change psql's `\conninfo` to use tabular format and include more information."*

## See Also

- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — full prepared-statement model + plan_cache_mode
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `pg_repack`, REINDEX CONCURRENTLY, framework escape hatches
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM mechanics + autovacuum tuning
- [`46-roles-privileges.md`](./46-roles-privileges.md) — role attributes for `createuser`
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — auth methods for connection-string `sslmode`/`channel_binding`
- [`55-statistics-planner.md`](./55-statistics-planner.md) — `--analyze-in-stages` post-pg_upgrade
- [`56-explain.md`](./56-explain.md) — capturing EXPLAIN output via psql
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_activity` queries to `\watch`
- [`64-system-catalogs.md`](./64-system-catalogs.md) — what `\d*` commands compile down to
- [`66-bulk-operations-copy.md`](./66-bulk-operations-copy.md) — `\copy` vs `COPY` mechanics
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — `pg_dump` / `pg_dumpall` patterns
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `pg_resetwal` last-resort recovery
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling `vacuumdb`-equivalent jobs
- [`89-pg-rewind.md`](./89-pg-rewind.md) — `pg_rewind` for standby resynchronization (Recipe 13)
- [`29-transaction-id-wraparound.md`](./29-transaction-id-wraparound.md) — `pg_resetwal` use-case context
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC discussion for `ON_ERROR_ROLLBACK`, `FETCH_COUNT`, `WATCH_INTERVAL`

## Sources

[^pg14-am-col]: PostgreSQL 14 release notes. <https://www.postgresql.org/docs/release/14.0/>. Quoted: *"Add an access method column to psql's `\d[i|m|t]+` output (Georgios Kokolatos)."*

[^pg14-toast]: PostgreSQL 14 release notes. <https://www.postgresql.org/docs/release/14.0/>. Quoted: *"Allow psql's `\dt` and `\di` to show TOAST tables and their indexes (Justin Pryzby)."*

[^pg14-dx]: PostgreSQL 14 release notes. <https://www.postgresql.org/docs/release/14.0/>. Quoted: *"Add psql command `\dX` to list extended statistics objects (Tatsuro Yamada)."*

[^pg14-vacuumdb]: PostgreSQL 14 release notes. <https://www.postgresql.org/docs/release/14.0/>. Quoted: *"Allow vacuumdb to skip index cleanup and truncation (Nathan Bossart)."*

[^pg15-dconfig]: PostgreSQL 15 release notes. <https://www.postgresql.org/docs/release/15.0/>. Quoted: *"Add `\dconfig` command to report server variables (Mark Dilger, Tom Lane)."*

[^pg15-getenv]: PostgreSQL 15 release notes. <https://www.postgresql.org/docs/release/15.0/>. Quoted: *"Add `\getenv` command to assign the value of an environment variable to a psql variable (Tom Lane)."*

[^pg15-watch-pager]: PostgreSQL 15 release notes. <https://www.postgresql.org/docs/release/15.0/>. Quoted: *"Add a pager option for the `\watch` command (Pavel Stehule, Thomas Munro)."*

[^pg15-multi-results]: PostgreSQL 15 release notes. <https://www.postgresql.org/docs/release/15.0/>. Quoted: *"Make psql output all results when multiple queries are passed to the server at once (Fabien Coelho)."*

[^pg16-bind]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow psql to submit queries using the extended query protocol (Peter Eisentraut). Passing arguments to such queries is done using the new psql `\bind` command."*

[^pg16-watch-count]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow psql `\watch` to limit the number of executions (Andrey Borodin). The `\watch` options can now be named when specified."*

[^pg16-watch-zero]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Detect invalid values for psql `\watch`, and allow zero to specify no delay (Andrey Borodin)."*

[^pg16-shell-vars]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow psql scripts to obtain the exit status of shell commands and queries (Corey Huinker, Tom Lane). The new psql control variables are `SHELL_ERROR` and `SHELL_EXIT_CODE`."*

[^pg16-drg]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Add psql command `\drg` to show role membership details (Pavel Luzanov). The `Member of` output column has been removed from `\du` and `\dg` because this new command displays this information in more detail."*

[^pg16-dps]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow psql's access privilege commands to show system objects (Nathan Bossart). The options are `\dpS` and `\zS`."*

[^pg16-df-source]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Prevent `\df+` from showing function source code (Isaac Morland). Function bodies are more easily viewed with `\sf`."*

[^pg16-xheader]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow psql to control the maximum width of header lines in expanded format (Platon Pronko). This is controlled by `xheader_width`."*

[^pg16-vacuumdb-schema]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow control of vacuumdb schema processing (Gilles Darold). These are controlled by options `--schema` and `--exclude-schema`."*

[^pg16-vacuumdb-main]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow VACUUM and vacuumdb to only process TOAST tables (Nathan Bossart). This is accomplished by having VACUUM turn off `PROCESS_MAIN` or by vacuumdb using the `--no-process-main` option."*

[^pg16-vacuumdb-bul]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Allow control of the shared buffer usage by vacuum and analyze (Melanie Plageman). The VACUUM/ANALYZE option is `BUFFER_USAGE_LIMIT`, and the vacuumdb option is `--buffer-usage-limit`. The default value is set by server variable `vacuum_buffer_usage_limit`, which also controls autovacuum."*

[^pg16-createuser-options]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Add options to createuser to control more user options (Shinya Kato). Specifically, the new options control the valid-until date, bypassing of row-level security, and role membership."*

[^pg16-createuser-deprecate]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/release/16.0/>. Quoted: *"Deprecate createuser option `--role` (Nathan Bossart). This option could be easily confused with new createuser role membership options, so option `--member-of` has been added with the same functionality. The `--role` option can still be used."*

[^pg17-dp-none]: PostgreSQL 17 release notes. <https://www.postgresql.org/docs/release/17.0/>. Quoted: *"Improve psql display of default and empty privileges (Erik Wienhold, Laurenz Albe). Command `\dp` now displays `(none)` for empty privileges; default still displays as empty."*

[^pg17-pset-null]: PostgreSQL 17 release notes. <https://www.postgresql.org/docs/release/17.0/>. Quoted: *"Have backslash commands honor `\pset null` (Erik Wienhold, Laurenz Albe). Previously `\pset null` was ignored."*

[^pg17-watch-minrows]: PostgreSQL 17 adds `min_rows`; `\watch` stops when fewer than the specified number of rows are returned. <https://www.postgresql.org/docs/18/app-psql.html#APP-PSQL-META-COMMAND-WATCH>

[^pg17-cancel-connect]: PostgreSQL 17 release notes. <https://www.postgresql.org/docs/release/17.0/>. Quoted: *"Allow psql connection attempts to be canceled with control-C (Tristan Partin)."*

[^pg17-fetch-count]: PostgreSQL 17 release notes. <https://www.postgresql.org/docs/release/17.0/>. Quoted: *"Allow psql to honor `FETCH_COUNT` for non-`SELECT` queries (Daniel Vérité)."*

[^pg17-all-pattern]: PostgreSQL 17 vacuumdb: `--all` selects all databases and does not take a database pattern. <https://www.postgresql.org/docs/17/app-vacuumdb.html>

[^pg18-prep]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Allow psql to parse, bind, and close named prepared statements (Anthonin Bonnefoy, Michael Paquier). This is accomplished with new commands `\parse`, `\bind_named`, and `\close_prepared`."*

[^pg18-pipeline]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Add psql backslash commands to allowing issuance of pipeline queries (Anthonin Bonnefoy). The new commands are `\startpipeline`, `\syncpipeline`, `\sendpipeline`, `\endpipeline`, `\flushrequest`, `\flush`, and `\getresults`."*

[^pg18-pipeline-vars]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Allow adding pipeline status to the psql prompt and add related state variables (Anthonin Bonnefoy). The new prompt character is `%P` and the new psql variables are `PIPELINE_SYNC_COUNT`, `PIPELINE_COMMAND_COUNT`, and `PIPELINE_RESULT_COUNT`."*

[^pg18-svc-prompt]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Allow adding the connection service name to the psql prompt or access it via psql variable (Michael Banck)."*

[^pg18-conninfo]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Change psql's `\conninfo` to use tabular format and include more information (Álvaro Herrera, Maiquel Grassi, Hunaid Sohail)."*

[^pg18-x-suffix]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Add psql option to use expanded mode on all list commands (Dean Rasheed). Adding backslash suffix `x` enables this."*

[^pg18-watch-interval]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Add psql variable `WATCH_INTERVAL` to set the default `\watch` wait time (Daniel Gustafsson)."*

[^pg18-leakproof]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Add function's leakproof indicator to psql's `\df+`, `\do+`, `\dAo+`, and `\dC+` outputs (Yugo Nagata)."*

[^pg18-dx-default]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Add `default_version` to the psql `\dx` extension output (Magnus Hagander)."*

[^pg18-missing-stats]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/release/18.0/>. Quoted: *"Add vacuumdb option `--missing-stats-only` to compute only missing optimizer statistics (Corey Huinker, Nathan Bossart). This option can only be run by superusers and can only be used with options `--analyze-only` and `--analyze-in-stages`."*

[^psql-docs]: PostgreSQL 16 — psql reference. <https://www.postgresql.org/docs/16/app-psql.html>. Full reference for psql command-line options, backslash commands, output formatting, variables, prompt customization.

[^pg-isready-docs]: PostgreSQL 16 — pg_isready. <https://www.postgresql.org/docs/16/app-pg-isready.html>. Verbatim purpose: *"`pg_isready` is a utility for checking the connection status of a PostgreSQL database server. The exit status specifies the result of the connection check."*

[^createdb-docs]: PostgreSQL 16 — createdb. <https://www.postgresql.org/docs/16/app-createdb.html>.

[^dropdb-docs]: PostgreSQL 16 — dropdb. <https://www.postgresql.org/docs/16/app-dropdb.html>.

[^createuser-docs]: PostgreSQL 16 — createuser. <https://www.postgresql.org/docs/16/app-createuser.html>.

[^dropuser-docs]: PostgreSQL 16 — dropuser. <https://www.postgresql.org/docs/16/app-dropuser.html>.

[^vacuumdb-docs]: PostgreSQL 16 — vacuumdb. <https://www.postgresql.org/docs/16/app-vacuumdb.html>.

[^reindexdb-docs]: PostgreSQL 16 — reindexdb. <https://www.postgresql.org/docs/16/app-reindexdb.html>.

[^clusterdb-docs]: PostgreSQL 16 — clusterdb. <https://www.postgresql.org/docs/16/app-clusterdb.html>.

[^pg-controldata-docs]: PostgreSQL 16 — pg_controldata. <https://www.postgresql.org/docs/16/app-pgcontroldata.html>. Note URL spelling: `app-pgcontroldata.html` (no dash between `pg` and `controldata`).

[^pg-resetwal-docs]: PostgreSQL 16 — pg_resetwal. <https://www.postgresql.org/docs/16/app-pgresetwal.html>. Note URL spelling: `app-pgresetwal.html` (no dash between `pg` and `resetwal`).

[^reference-client]: PostgreSQL 16 — Client Applications reference index. <https://www.postgresql.org/docs/16/reference-client.html>. Lists all client utilities packaged with PostgreSQL.

[^pgservicefile]: PostgreSQL 16 — Connection Service File. <https://www.postgresql.org/docs/16/libpq-pgservice.html>. `~/.pg_service.conf` and `pg_service.conf` system-wide.

[^pgpass]: PostgreSQL 16 — Password File. <https://www.postgresql.org/docs/16/libpq-pgpass.html>. `~/.pgpass` mode `0600` for credential storage.


[^minor-18-6]: PostgreSQL 18.6 release notes (2026-08-13), psql `COPY ... FROM STDIN` and CVE-2026-6464. <https://www.postgresql.org/docs/release/18.6/>

[^minor-18-7]: PostgreSQL 18.7 release notes (2026-11-12), `COPY ... FROM STDIN` regression fix. <https://www.postgresql.org/docs/release/18.7/>

[^minor-aug-announce]: PostgreSQL 18.6, 17.11, 16.15, 15.19, 14.24, and 19 Beta 3 released (2026-08-13). <https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/>

[^minor-nov-announce]: PostgreSQL 18.7, 17.12, 16.16, 15.20, 14.25, and 19 RC 2 released (2026-11-12). <https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442/>

[^psql18-docs]: PostgreSQL 18 psql reference: connection precedence, output formats, COPY streaming, variable interpolation, watch termination, and query execution. <https://www.postgresql.org/docs/18/app-psql.html>

[^vacuumdb17-docs]: PostgreSQL 17 vacuumdb reference: database selection and concurrency. <https://www.postgresql.org/docs/17/app-vacuumdb.html>

[^pg18-upgrade]: PostgreSQL 18 pg_upgrade: post-upgrade statistics instructions. <https://www.postgresql.org/docs/18/pgupgrade.html>

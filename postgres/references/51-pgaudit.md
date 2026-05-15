# Auditing — pgaudit Extension

The `pgaudit` contrib-style extension provides detailed session-level and object-level audit logging that the standard PostgreSQL logging facility cannot match. **It is an external extension, not in core PostgreSQL** — every release is shipped from its own GitHub repository on a per-PG-major cadence, never bundled with the server. PostgreSQL itself has no dedicated auditing chapter in the docs; pgaudit is the canonical answer for compliance-grade who-did-what-when audit trails on Postgres.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — Five Rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Installing pgaudit](#installing-pgaudit)
- [Session Auditing: pgaudit.log](#session-auditing-pgauditlog)
- [Object Auditing: pgaudit.role and GRANTs](#object-auditing-pgauditrole-and-grants)
- [Configuration GUC Catalog](#configuration-guc-catalog)
- [Audit Log Format and Fields](#audit-log-format-and-fields)
- [Integration with Standard Logging GUCs](#integration-with-standard-logging-gucs)
- [PG-Version Compatibility Matrix](#pg-version-compatibility-matrix)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when you need an audit trail of what users did inside the database — for compliance (SOX, HIPAA, PCI-DSS, GDPR, FedRAMP), forensics, or DBA-accountability tracking. Use the standard PostgreSQL log (`log_statement = 'all'`) only when the requirement is *informational logging*, not *audit logging*; pgaudit exists because the standard log shows what was *requested*, not what the server *did* in response.

> [!WARNING] pgaudit is not in core PostgreSQL
> The PostgreSQL project ships zero in-core auditing functionality. The `https://www.postgresql.org/docs/current/auditing.html` URL does not exist (returns 404). pgaudit is an external extension at [github.com/pgaudit/pgaudit](https://github.com/pgaudit/pgaudit) released independently on a per-PG-major cadence. PG14, PG15, PG16, PG17, and PG18 release notes contain **zero pgaudit-related items** — the extension lives entirely out-of-tree. If a tutorial claims pgaudit is "built into" PostgreSQL N, it is wrong.[^pgaudit-readme]

## Mental Model — Five Rules

1. **pgaudit logs through the standard PostgreSQL log facility.** It does not write to its own file, its own table, or its own syslog channel. Every pgaudit entry goes through `ereport(LOG, ...)` and flows through `log_destination`, `log_directory`, `log_filename`, `log_line_prefix`, and `log_rotation_*` exactly like any other server log line. **Where your server log goes, your audit trail goes.** For compliance-grade audit you must ship those log files to an immutable store outside the database server. Cross-reference [`82-monitoring.md`](./82-monitoring.md) for log-shipping patterns.

2. **There are exactly two auditing modes: session and object.** Session auditing (`pgaudit.log = 'read,write,ddl,...'`) logs every statement matching the named classes for every backend in the cluster (or, with `ALTER ROLE ... SET pgaudit.log`, for every backend of one role). Object auditing (`pgaudit.role = 'auditor'`) logs only statements that touch tables/columns/sequences on which the named role holds the matching privilege — much narrower, much lower volume, and the canonical pattern for "audit table X but not Y." **There is no logical-decoding mode, no in-database audit table, and no per-row-change capture** — pgaudit is statement-level only. For row-level capture use triggers or logical replication.

3. **`shared_preload_libraries = 'pgaudit'` is mandatory and requires server restart.** Verbatim: *"The pgAudit extension must be loaded in `shared_preload_libraries`... Otherwise, an error will be raised at load time and no audit logging will occur."*[^pgaudit-readme] You cannot `LOAD 'pgaudit'` per session and get useful audit behavior — the extension hooks the executor at startup. A managed Postgres environment that does not preinstall pgaudit may not let you add it.

4. **Audit log volume is unbounded.** Verbatim: *"Depending on settings, it is possible for pgAudit to generate an enormous volume of logging. Be careful to determine exactly what needs to be audit logged in your environment to avoid logging too much."*[^pgaudit-readme] `pgaudit.log = 'all'` on a busy OLTP cluster can multiply your log volume by 100x or more. **Plan log storage and rotation before flipping the switch in production**; use object auditing rather than session auditing whenever the requirement permits it.

5. **`pgaudit.log_client = off` (the default) keeps audit lines server-side only.** Verbatim: *"Specifies whether log messages will be visible to a client process such as psql. This setting should generally be left disabled but may be useful for debugging or other purposes. Note that `pgaudit.log_level` is only enabled when `pgaudit.log_client` is on."*[^pgaudit-readme] The two GUCs `log_client` and `log_level` are coupled — setting `pgaudit.log_level = 'warning'` without `log_client = on` is silently a no-op. The default behavior is correct: audit lines go to the server log, not to clients.

## Decision Matrix

| You want to audit | Use | Avoid | Why |
|---|---|---|---|
| Every statement, every role, all classes | `pgaudit.log = 'all'` | `log_statement = 'all'` | pgaudit shows *what the server did*; `log_statement` shows *what client sent* |
| Only DDL across the whole cluster | `pgaudit.log = 'ddl'` cluster-wide | `log_statement = 'ddl'` | pgaudit logs to the audit category, distinguishable in log parsing |
| Only role/permission changes (GRANT/REVOKE/CREATE ROLE) | `pgaudit.log = 'role'` | event trigger | pgaudit covers the common compliance ask out of the box; event triggers see only DDL events |
| Reads/writes touching a specific sensitive table | Object auditing: `pgaudit.role = 'pii_auditor'` + grants on that table to `pii_auditor` | Session auditing across the whole cluster | Object auditing scopes by privilege grants, dramatically lowering volume |
| One specific role's activity only | `ALTER ROLE webapp SET pgaudit.log = 'read,write'` | Cluster-wide session auditing | Per-role override keeps audit volume proportional to risk |
| Authentication events (LOGIN / FAILED LOGIN) | Core `log_connections` + `log_disconnections` | pgaudit | pgaudit does **not** audit authentication — that lives in the core logging facility |
| Row-level changes (the actual old/new values) | Trigger + audit table, or logical replication | pgaudit | pgaudit is statement-level; it logs the SQL, not the row deltas |
| Stream audit to SIEM | `log_destination = 'jsonlog'` (PG15+) + filebeat / fluent-bit | csvlog text parsing | Structured JSON parses reliably in any SIEM; CSV is fragile across PG versions |
| Forensics on a single past query | pgaudit `WRITE` class with `pgaudit.log_parameter = on` | reconstruct from `pg_stat_statements` | pgaudit captures the parameter values; `pg_stat_statements` normalizes them away |
| Audit-but-do-not-log-pg_catalog noise | `pgaudit.log_catalog = off` | Default `on` + grep filters | Default is `on` for completeness; turn off for cleaner logs from `psql`/`pgAdmin` sessions |
| Audit only the parameters that fit | `pgaudit.log_parameter = on, pgaudit.log_parameter_max_size = 1024` | Unbounded parameter capture | Long parameters (large JSON blobs) bloat audit log volume |

**Three smell signals** that you have reached for the wrong tool:

- **You are running pgaudit + a row-level trigger + logical replication for the same audit requirement.** Pick one: pgaudit for statement audit, trigger-into-audit-table for row deltas, logical replication for CDC. Running all three triples the write amplification and produces three sources of truth that drift.
- **Your audit log is the same file as your error log and there is no log shipping.** That violates every compliance framework's tamper-evident-log requirement. Audit logs must ship to an immutable store outside the database server. Configure `log_destination = jsonlog` + filebeat/fluent-bit to an S3-with-object-lock or equivalent.
- **You enabled `pgaudit.log = 'all'` in production "to be safe."** Expect log volume to multiply 50–500× depending on workload, disk to fill, and the audit log itself to become the bottleneck. Scope down to `pgaudit.log = 'ddl,role,write'` or use object auditing.

## Installing pgaudit

```bash
# Package install (Debian/Ubuntu — version must match your PG major)
sudo apt install postgresql-18-pgaudit  # for PG18
sudo apt install postgresql-16-pgaudit  # for PG16
```

```ini
# postgresql.conf — REQUIRES server restart
shared_preload_libraries = 'pgaudit'    # if combining: 'pg_stat_statements, pgaudit'
```

```sql
-- Restart, then per-database:
CREATE EXTENSION pgaudit;

-- Verify
SELECT extname, extversion FROM pg_extension WHERE extname = 'pgaudit';
SHOW shared_preload_libraries;          -- must include 'pgaudit'
```

**Without `shared_preload_libraries`**, the extension errors at load time and **no audit logging occurs** — verbatim from the README.[^pgaudit-readme] This is a hard requirement; there is no graceful per-session fallback.

> [!NOTE] Build from source
> If your package source does not ship pgaudit (some managed environments restrict the extension allowlist; some self-built Postgres deployments do not include contribs by default), you can build from source. Clone [github.com/pgaudit/pgaudit](https://github.com/pgaudit/pgaudit), check out the tag matching your PG major (`REL_18_STABLE`, `REL_17_STABLE`, etc.), and `make USE_PGXS=1 install`. The build requires `pg_config` from a matching server install.

## Session Auditing: `pgaudit.log`

Session auditing logs every statement matching one or more **statement classes**. The eight class values (each can appear in a comma-separated list):

| Class | Verbatim definition[^pgaudit-readme] |
|---|---|
| `READ` | "SELECT and COPY when the source is a relation or a query." |
| `WRITE` | "INSERT, UPDATE, DELETE, TRUNCATE, and COPY when the destination is a relation." |
| `FUNCTION` | "Function calls and DO blocks." |
| `ROLE` | "Statements related to roles and privileges: GRANT, REVOKE, CREATE/ALTER/DROP ROLE." |
| `DDL` | "All DDL that is not included in the ROLE class." |
| `MISC` | "Miscellaneous commands, e.g. DISCARD, FETCH, CHECKPOINT, VACUUM, SET." |
| `MISC_SET` | "Miscellaneous SET commands, e.g. SET ROLE." |
| `ALL` | "Include all of the above." |

A class can be subtracted by prefixing it with `-`:

```sql
-- Cluster-wide: audit everything except FUNCTION calls
ALTER SYSTEM SET pgaudit.log = 'all, -function';
SELECT pg_reload_conf();
```

```sql
-- One role only: audit reads and writes for the webapp user
ALTER ROLE webapp SET pgaudit.log = 'read, write';

-- Database-level: audit DDL/ROLE changes in the production DB
ALTER DATABASE prod SET pgaudit.log = 'ddl, role';
```

**Scope precedence** (highest wins): session `SET pgaudit.log = ...` → role-level `ALTER ROLE ... SET` → database-level `ALTER DATABASE ... SET` → cluster `ALTER SYSTEM SET` / `postgresql.conf`. **Per-role and per-database overrides are how production deployments scope volume** — a cluster-wide `'all'` is rarely the right choice.

> [!WARNING] log_client + log_level coupling
> Setting `pgaudit.log_level = 'warning'` without also setting `pgaudit.log_client = on` is silently a no-op. The level setting only takes effect when audit messages are visible to the client. The default (`log_client = off`, `log_level = log`) sends audit to the server log at `LOG` level, which is correct for compliance use.[^pgaudit-readme]

## Object Auditing: `pgaudit.role` and GRANTs

Object auditing is the canonical pattern for "audit only when someone reads/writes table X." Instead of enumerating tables in pgaudit configuration, you create a role named in `pgaudit.role` and grant it the privilege you want to audit on the target tables. Any statement that requires that privilege on that table emits an audit entry.

```sql
-- One-time setup
CREATE ROLE pii_auditor;                                         -- the pgaudit.role
GRANT SELECT, INSERT, UPDATE, DELETE ON customers     TO pii_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_cards  TO pii_auditor;
-- Only privileges granted to pii_auditor produce audit log entries;
-- statements against other tables are silent.

-- Cluster-wide configuration
ALTER SYSTEM SET pgaudit.role = 'pii_auditor';
SELECT pg_reload_conf();
```

Now `SELECT * FROM customers` by any role anywhere in the cluster generates an audit entry; `SELECT * FROM products` (no grant to `pii_auditor`) does not.

Verbatim from the README: *"Object audit logging logs statements that affect a particular relation... Only SELECT, INSERT, UPDATE and DELETE commands are supported."*[^pgaudit-readme] Object auditing does **not** capture DDL, TRUNCATE, function calls, or `COPY`. For those, combine with session auditing:

```sql
-- Object audit for SELECT/INSERT/UPDATE/DELETE on sensitive tables
ALTER SYSTEM SET pgaudit.role = 'pii_auditor';
-- Session audit for DDL and ROLE changes across the whole cluster
ALTER SYSTEM SET pgaudit.log  = 'ddl, role';
SELECT pg_reload_conf();
```

**Multiple audit roles**: grant `pii_auditor` membership to a master role and set `pgaudit.role` to the master. Verbatim: *"Multiple audit roles can be defined by granting them to the master role. This allows multiple groups to be in charge of different aspects of audit logging."*[^pgaudit-readme]

## Configuration GUC Catalog

| GUC | Default | Effect (verbatim from README[^pgaudit-readme]) |
|---|---|---|
| `pgaudit.log` | `none` | Comma-separated list of statement classes to audit (`READ, WRITE, FUNCTION, ROLE, DDL, MISC, MISC_SET, ALL`); prefix with `-` to subtract. |
| `pgaudit.log_catalog` | `on` | *"Specifies that session logging should be enabled in the case where all relations in a statement are in `pg_catalog`. Disabling this setting will reduce noise in the log from tools like `psql` and PgAdmin that query the catalog heavily."* |
| `pgaudit.log_client` | `off` | *"Specifies whether log messages will be visible to a client process such as `psql`. This setting should generally be left disabled but may be useful for debugging or other purposes."* |
| `pgaudit.log_level` | `log` | *"Specifies the log level that will be used for log entries... but note that `ERROR`, `FATAL`, and `PANIC` are not allowed."* Only effective when `log_client = on`. |
| `pgaudit.log_parameter` | `off` | *"Specifies that audit logging should include the parameters that were passed with the statement. When parameters are present they will be included in CSV format after the statement text."* |
| `pgaudit.log_parameter_max_size` | `0` | *"Specifies that parameter values longer than this setting (in bytes) should not be logged, but replaced with `<long param suppressed>`... If this setting is 0 (the default), all parameters are logged regardless of length."* |
| `pgaudit.log_relation` | `off` | *"Specifies whether session audit logging should create a separate log entry for each relation (TABLE, VIEW, etc.) referenced in a SELECT or DML statement. This is a useful shortcut for exhaustive logging without using object audit logging."* |
| `pgaudit.log_rows` | `off` | *"Specifies that audit logging should include the number of rows retrieved or affected by a statement. When enabled the rows field will be included after the parameter field."* |
| `pgaudit.log_statement` | `on` | *"Specifies whether logging will include the statement text and parameters (if enabled). Depending on requirements, an audit log might not require this and it makes the logs less verbose."* |
| `pgaudit.log_statement_once` | `off` | *"Specifies whether logging will include the statement text and parameters with the first log entry for a statement/substatement combination or with every entry. Enabling this setting will result in less verbose logging but may make it more difficult to determine the statement that generated a log entry."* |
| `pgaudit.role` | `''` | *"Specifies the master role to use for object audit logging. Multiple audit roles can be defined by granting them to the master role."* |

**The two-GUC trap**: `log_level` is effective *only* when `log_client = on`. Setting one without the other is a silent no-op. The default coupling (`log_client = off`, `log_level = log`) is correct for compliance — audit entries arrive at the server log at `LOG` severity. Override the level only when you have explicitly enabled `log_client` for debugging.

## Audit Log Format and Fields

pgaudit emits one log line per audited statement in this format (after the `log_line_prefix`):

```
AUDIT: SESSION,1,1,READ,SELECT,,,SELECT * FROM customers WHERE id = 42,<not logged>
       ^       ^ ^ ^    ^      ^ ^ ^                                  ^
       1       2 3 4    5      6 7 8                                  9
```

| Field | Name | Description |
|---|---|---|
| 1 | `AUDIT_TYPE` | `SESSION` (session auditing) or `OBJECT` (object auditing) |
| 2 | `STATEMENT_ID` | Per-session sequential ID, increments per top-level statement |
| 3 | `SUBSTATEMENT_ID` | Per-statement sequential ID, increments per substatement (e.g., function calls within one query) |
| 4 | `CLASS` | One of `READ`, `WRITE`, `FUNCTION`, `ROLE`, `DDL`, `MISC`, `MISC_SET` |
| 5 | `COMMAND` | SQL command tag (`SELECT`, `INSERT`, `CREATE TABLE`, etc.) |
| 6 | `OBJECT_TYPE` | For object auditing — `TABLE`, `VIEW`, `SEQUENCE`, `FUNCTION`, etc. |
| 7 | `OBJECT_NAME` | Fully-qualified object name (for object auditing or when `log_relation = on`) |
| 8 | `STATEMENT` | The SQL text (suppressed by `log_statement = off`) |
| 9 | `PARAMETER` | Parameter values, CSV-encoded (when `log_parameter = on`) |

When `pgaudit.log_rows = on`, a 10th field with the row count follows the parameter field.

To make the audit lines machine-parseable, set `log_line_prefix` to include consistent leading fields:

```ini
# postgresql.conf — recommended audit-friendly prefix
log_line_prefix = '%m [%p] %q%u@%d/%a '
#                  ^      ^^  ^  ^ ^
#                  |      ||  |  | application_name
#                  |      ||  |  database
#                  |      ||  user
#                  |      |only inside session context
#                  |      backend PID
#                  millisecond timestamp
```

> [!NOTE] PostgreSQL 18 — log_line_prefix `%L`
> PG18 added the `%L` escape for the client IP address, verbatim: *"Add log_line_prefix escape `%L` to output the client IP address (Greg Sabino Mullane)."*[^pg18-logging] Pre-PG18 audit deployments derive client IP from `%h` (host name) or `%r` (host + port).

## Integration with Standard Logging GUCs

Because pgaudit emits via `ereport()`, every audit line is governed by your standard logging configuration. The relevant GUCs:

| GUC | Default | Audit-relevant behavior |
|---|---|---|
| `log_destination` | `stderr` | Set to `csvlog` for parseable CSV, `jsonlog` (PG15+) for structured JSON. Both can coexist with `stderr`. |
| `logging_collector` | `off` | Must be `on` to use `log_directory` / `log_filename`. Restart required to change. |
| `log_directory` | `log` | Directory under `$PGDATA` (or absolute path) where log files are written. |
| `log_filename` | `postgresql-%Y-%m-%d_%H%M%S.log` | strftime-style filename template. |
| `log_rotation_age` | `1d` | Rotate the log file every N minutes. |
| `log_rotation_size` | `10MB` | Rotate when the current file reaches N kilobytes. |
| `log_truncate_on_rotation` | `off` | If `on`, an existing same-named file is truncated rather than appended — useful for round-robin daily logs. |
| `log_line_prefix` | `'%m [%p] '` | Prefix prepended to every log line. Set to include `%u`, `%d`, `%a`, `%h` for audit correlation. |
| `log_min_messages` | `WARNING` | Minimum severity to record. Must be `LOG` or lower to capture pgaudit's default `pgaudit.log_level = log`. |
| `log_connections` | `off` | Logs every new connection — pgaudit does **not** cover this; enable separately. |
| `log_disconnections` | `off` | Logs session-end. Audit-relevant for session-duration correlation. |

> [!NOTE] PostgreSQL 15 — jsonlog
> PG15 added `log_destination = 'jsonlog'`, producing structured JSON log lines. pgaudit emits its CSV-formatted body as a single string inside the JSON `message` field — the audit fields are not separately parsed into JSON keys. Downstream SIEM parsers must split the message field on commas to extract pgaudit columns. Combine with `csvlog` simultaneously (`log_destination = 'stderr,csvlog,jsonlog'`) if you need both formats during a transition.

## PG-Version Compatibility Matrix

Verbatim from the pgaudit README: *"pgAudit supports PostgreSQL 14 or greater."*[^pgaudit-readme] Each pgaudit major matches one PG major exactly:

| pgaudit version | PostgreSQL major | Notes |
|---|---|---|
| `18.X` | PG 18 | Latest (18.0 released 2025-09-24) |
| `17.X` | PG 17 | |
| `16.X` | PG 16 | |
| `1.7.X` | PG 15 | Pre-rename versioning scheme |
| `1.6.X` | PG 14 | Pre-rename versioning scheme |
| `1.5.X` | PG 13 | PG 13 is out of support; pgaudit 1.5 is unmaintained |

**Versioning-scheme break at PG 16**: pre-PG16 releases use `v1.NN.X`; from PG16 onwards the major matches the PG major (`vNN.X`). A common stale-tutorial trap is searching for "pgaudit 16" expecting `1.16` and finding nothing — the correct binary is `pgaudit 16.X`.

**Upgrading pgaudit alongside a PG major upgrade** requires matching versions. After `pg_upgrade`, install the new pgaudit package matching the new PG major before starting the upgraded cluster — otherwise `shared_preload_libraries = 'pgaudit'` will fail to load.

## Per-Version Timeline

Because pgaudit is out-of-tree, PostgreSQL release notes for PG14, PG15, PG16, PG17, and PG18 all contain **zero pgaudit-specific items**. The per-version timeline below documents only the *logging-infrastructure* changes in core that affect how pgaudit log lines render and ship:

| PG version | Logging-infrastructure changes affecting pgaudit |
|---|---|
| PG 14 | Zero direct pgaudit-relevant changes. |
| PG 15 | `log_destination = 'jsonlog'` added — pgaudit's CSV body renders inside the JSON `message` field as a single string.[^pg15-logging] `log_min_duration_sample` added for sample-based slow-query logging (unrelated to pgaudit but commonly combined). `pg_log_backend_memory_contexts()` added. |
| PG 16 | Zero direct pgaudit-relevant changes. |
| PG 17 | `log_connections` emits a line even for `trust` connections — verbatim *"Add log_connections log line for trust connections (Jacob Champion)."*[^pg17-logging] |
| PG 18 | `%L` escape in `log_line_prefix` for client IP — verbatim *"Add log_line_prefix escape `%L` to output the client IP address (Greg Sabino Mullane)."*[^pg18-logging] `log_connections` becomes more granular — verbatim *"Increase the logging granularity of server variable log_connections (Melanie Plageman)... This server variable was previously only boolean, which is still supported."*[^pg18-logging] `log_lock_failures` GUC added — verbatim *"Add server variable log_lock_failures to log lock acquisition failures (Yuki Seino, Fujii Masao). Specifically it reports SELECT ... NOWAIT lock failures."*[^pg18-logging] None of these are pgaudit features per se, but pgaudit deployments benefit from `%L` for audit attribution. |

**If a tutorial claims pgaudit gained a new feature in PG release N, verify it against the [pgaudit GitHub release notes](https://github.com/pgaudit/pgaudit/releases) — not against PostgreSQL release notes.** The two release cadences are entirely separate.

## Examples / Recipes

### Recipe 1 — Baseline compliance configuration

A starting point for SOX/HIPAA/PCI-DSS-style compliance: audit DDL, ROLE changes, and writes cluster-wide; audit reads on PII tables via object auditing; ship logs as JSON to a SIEM.

```ini
# postgresql.conf (restart required for shared_preload_libraries)
shared_preload_libraries = 'pg_stat_statements, pgaudit'

# Logging-collector setup
logging_collector       = on
log_destination         = 'stderr,jsonlog'    # JSON for SIEM, stderr for tail-on-the-box
log_directory           = 'log'
log_filename            = 'postgresql-%Y-%m-%d_%H%M%S.log'
log_rotation_age        = 1d
log_rotation_size       = 100MB
log_truncate_on_rotation = off

# Audit-friendly prefix
log_line_prefix         = '%m [%p] %q%u@%d/%a '

# Capture authentication (pgaudit does NOT do this)
log_connections         = on
log_disconnections      = on
log_min_messages        = LOG                  # required so pgaudit's default LOG-level entries appear

# pgaudit: session-level for DDL/ROLE/WRITE; object-level for PII reads
pgaudit.log             = 'ddl, role, write'
pgaudit.role            = 'pii_auditor'
pgaudit.log_parameter   = on
pgaudit.log_parameter_max_size = 4096          # truncate huge JSON params
pgaudit.log_catalog     = off                  # silence psql/pgAdmin catalog noise
pgaudit.log_statement_once = on                # one statement-text per stmt, not per substmt
```

```sql
-- One-time PII auditor role setup
CREATE ROLE pii_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON customers     TO pii_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_cards  TO pii_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON medical_recs  TO pii_auditor;
-- Reads of these three tables produce OBJECT,READ,SELECT audit lines.
-- Writes anywhere produce SESSION,WRITE audit lines.
```

### Recipe 2 — Per-role audit override

Audit volume scales with rows touched. For a busy `webapp` role, audit only writes; for the rare `dba` role, audit everything:

```sql
ALTER ROLE webapp SET pgaudit.log = 'write, ddl, role';
ALTER ROLE dba    SET pgaudit.log = 'all';
ALTER ROLE batch  SET pgaudit.log = 'ddl, role';      -- batch reads are routine; writes/DDL aren't
ALTER ROLE readonly_reporting SET pgaudit.log = 'none';  -- explicit opt-out for high-volume read-only
```

```sql
-- Verify per-role overrides
SELECT rolname, rolconfig
FROM pg_roles
WHERE rolconfig::text ~ 'pgaudit'
ORDER BY rolname;
```

> [!NOTE] Per-role GUCs and pgBouncer transaction-mode
> Per-role `ALTER ROLE ... SET pgaudit.log` is applied at connection setup time. Behind pgBouncer in transaction-pooling mode, a backend connection serves multiple end-users with different role identities via `SET ROLE`, and **`SET ROLE` does not re-apply per-role GUCs** (cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6). Per-role audit overrides do not work as expected behind a transaction-mode pooler — use cluster-wide or per-database settings instead.

### Recipe 3 — Object auditing without granting application access

You want pgaudit to log reads of `customers`, but you do **not** want `pii_auditor` to be an actual login role anyone uses. Make it a NOLOGIN role:

```sql
CREATE ROLE pii_auditor NOLOGIN;
GRANT SELECT ON customers TO pii_auditor;
ALTER SYSTEM SET pgaudit.role = 'pii_auditor';
SELECT pg_reload_conf();
```

The role exists only as the grant target that defines what pgaudit watches. No human or service ever connects as `pii_auditor`.

### Recipe 4 — Audit only failed authentications

pgaudit does **not** cover authentication. Use core logging:

```ini
# postgresql.conf
log_connections    = on    # logs every connection attempt (success + fail)
log_disconnections = on
```

```bash
# Grep audit-trail for failed connections
grep -E 'FATAL.*authentication failed|FATAL.*password authentication failed' \
     /var/lib/postgresql/18/data/log/postgresql-*.log
```

For deeper auth-event auditing combine with PG18's enhanced `log_connections` granularity[^pg18-logging] or push pg_hba.conf failures through an external IDS.

### Recipe 5 — Test pgaudit is actually capturing what you expect

After enabling, generate one statement of each class and tail the log:

```sql
-- READ
SELECT 1;
-- WRITE
CREATE TEMP TABLE t(x int); INSERT INTO t VALUES (1); DROP TABLE t;
-- DDL
CREATE TABLE _audit_test(x int); DROP TABLE _audit_test;
-- ROLE
GRANT SELECT ON pg_class TO public; REVOKE SELECT ON pg_class FROM public;
-- FUNCTION
DO $$ BEGIN PERFORM 1; END $$;
-- MISC_SET
SET log_statement = 'none';  -- intentional no-op
```

```bash
tail -100 /var/lib/postgresql/18/data/log/postgresql-*.log | grep AUDIT
# Expect: SESSION,1,1,READ,SELECT,...   SESSION,2,1,WRITE,INSERT,...   etc.
```

If you see no `AUDIT:` lines:
1. `SHOW shared_preload_libraries` — must contain `pgaudit`.
2. `SHOW pgaudit.log` — must be non-empty.
3. `SHOW log_min_messages` — must be `LOG` or lower (default `WARNING` filters out pgaudit's `LOG`-level entries).
4. `SHOW logging_collector` — must be `on` if you expect `log_directory`/`log_filename` files.

### Recipe 6 — Object audit with multiple departments

Different teams own different audit scopes. Grant per-team roles to a master:

```sql
CREATE ROLE finance_auditor NOLOGIN;
CREATE ROLE hr_auditor      NOLOGIN;
CREATE ROLE engineering_auditor NOLOGIN;
CREATE ROLE master_auditor  NOLOGIN;

GRANT finance_auditor, hr_auditor, engineering_auditor TO master_auditor;

GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_*  TO finance_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON employee  TO hr_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON code_repo TO engineering_auditor;

ALTER SYSTEM SET pgaudit.role = 'master_auditor';
SELECT pg_reload_conf();
```

Now each team manages its own audit-scope by managing grants to its own role. The master role inherits all three sets and pgaudit honors the union.

### Recipe 7 — Capture parameter values for forensic replay

Default `pgaudit.log_parameter = off` logs SQL text only — parameters are `<not logged>`. For forensic-grade audit (the actual values touched), enable parameters with a size cap:

```sql
ALTER SYSTEM SET pgaudit.log = 'write';
ALTER SYSTEM SET pgaudit.log_parameter = on;
ALTER SYSTEM SET pgaudit.log_parameter_max_size = 8192;  -- 8 KB cap per parameter
SELECT pg_reload_conf();
```

Now `UPDATE customers SET ssn = $1 WHERE id = $2` is audited with the actual SSN value and ID. **The audit log now contains sensitive data — secure log files as carefully as the database itself.**

### Recipe 8 — Log shipping to immutable storage

Audit logs must reside on tamper-evident storage outside the cluster. Filebeat to S3 with object-lock is one canonical pattern:

```yaml
# /etc/filebeat/filebeat.yml
filebeat.inputs:
  - type: log
    enabled: true
    paths:
      - /var/lib/postgresql/18/data/log/postgresql-*.log.json
    json.keys_under_root: true
    json.add_error_key: true
    fields:
      log_type: pgaudit
output.s3:
  bucket: pgaudit-immutable-2026
  region: us-east-1
  encryption: AES256
  storage_class: GLACIER
  # Bucket configured with Object Lock + Compliance retention 7 years
```

For high-volume clusters, route to OpenSearch / Splunk / Datadog with a daily roll-up to S3.

### Recipe 9 — Catalog audit which roles have pgaudit overrides

```sql
SELECT
    rolname,
    rolconfig
FROM pg_roles
WHERE rolconfig::text ~ 'pgaudit'
ORDER BY rolname;
```

```sql
-- pg_db_role_setting view shows per-(role, database) overrides
SELECT
    r.rolname,
    d.datname,
    s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r    ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase
WHERE s.setconfig::text ~ 'pgaudit'
ORDER BY r.rolname, d.datname;
```

This audit query is the single most useful "is pgaudit actually set the way I think it is" diagnostic. Per-role and per-database overrides are easy to forget about.

### Recipe 10 — Inspect cluster-wide pgaudit GUC state

```sql
SELECT name, setting, source, sourcefile, sourceline
FROM pg_settings
WHERE name LIKE 'pgaudit.%'
ORDER BY name;
```

The `source` column tells you where the value came from — `default`, `configuration file`, `command line`, `session`, `database`, `user`, `database user`, `client`, or `override`. If `pgaudit.log = 'all'` shows `source = configuration file`, an emergency override won't take effect until you also override it at a higher precedence level.

### Recipe 11 — Audit-by-schema using object auditing

Audit every table in one schema without enumerating tables:

```sql
CREATE ROLE pii_auditor NOLOGIN;
GRANT USAGE ON SCHEMA pii_data TO pii_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pii_data TO pii_auditor;
-- For future tables created in the schema:
ALTER DEFAULT PRIVILEGES IN SCHEMA pii_data
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pii_auditor;

ALTER SYSTEM SET pgaudit.role = 'pii_auditor';
SELECT pg_reload_conf();
```

Combine with [`46-roles-privileges.md`](./46-roles-privileges.md) Recipe 1 (`ALTER DEFAULT PRIVILEGES`) so new tables added later automatically get the audit grant.

### Recipe 12 — Estimate audit log volume before enabling

Audit `pg_stat_statements` for an hour, then estimate:

```sql
-- Total statements per second
SELECT round(sum(calls) / EXTRACT(EPOCH FROM now() - stats_reset)) AS qps
FROM pg_stat_statements ss, pg_stat_database d
WHERE d.datname = current_database();

-- Estimate audit log volume (rough)
-- Average audit line: ~200 bytes for short statements, ~500–2000 bytes with parameters
-- volume_per_day_GB ≈ qps * 86400 * 500 bytes / 1e9
```

For a 1000 QPS workload, `pgaudit.log = 'all'` with `log_parameter = on` can produce 40+ GB/day. Plan storage, rotation, and shipping accordingly.

### Recipe 13 — Disable audit during planned bulk operation

Before a large ETL or partition rotation, scope down pgaudit per session to avoid drowning the audit log:

```sql
BEGIN;
SET LOCAL pgaudit.log = 'none';       -- this transaction only — does not affect other sessions
-- huge ETL goes here
COMMIT;
```

`SET LOCAL` reverts at COMMIT/ROLLBACK; `SET` (without LOCAL) reverts at session end. **Do not use this to evade audit requirements** — most compliance frameworks forbid audit gaps. Use only for documented maintenance windows where the audit-event-class isn't required.

## Gotchas / Anti-patterns

1. **pgaudit is not in core.** PostgreSQL ships no auditing functionality. `https://www.postgresql.org/docs/current/auditing.html` returns 404. If your team or vendor claims "PostgreSQL audit is built in," they are wrong; either pgaudit or a comparable third-party tool must be installed.

2. **Missing `shared_preload_libraries = 'pgaudit'` → silent no-op.** Without preloading, `CREATE EXTENSION pgaudit` succeeds and `SHOW pgaudit.log` returns the configured value, but **no audit entries are emitted**. Always verify with `SHOW shared_preload_libraries`.

3. **`pgaudit.log_client = off` (default) + `pgaudit.log_level = warning` is silently a no-op.** The level setting only applies when audit messages flow to clients. Leave both at defaults for production.

4. **`log_min_messages = WARNING` (default) hides pgaudit's `LOG`-level entries.** pgaudit defaults to logging at `LOG` severity, which is *below* `WARNING`. Without lowering `log_min_messages` to `LOG`, the server filters audit lines out before they reach `log_destination`.

5. **Object auditing covers only SELECT/INSERT/UPDATE/DELETE.** Verbatim: *"Only SELECT, INSERT, UPDATE and DELETE commands are supported."*[^pgaudit-readme] Object auditing does not capture TRUNCATE, COPY, DDL, or function calls. For those, combine with session auditing (`pgaudit.log = 'ddl, role, function'`).

6. **pgaudit does not audit authentication.** Logins, login failures, and disconnections are core PostgreSQL events logged via `log_connections` and `log_disconnections`. pgaudit is silent on authentication.

7. **pgaudit does not capture row-level deltas.** Statement-level only. A `DELETE FROM customers` audited with `pgaudit.log = 'write'` produces one log line per statement; it does **not** log the rows deleted. For row-level capture use triggers writing to an audit table, or logical replication.

8. **`pgaudit.log = 'all'` on a busy OLTP cluster fills disk.** Expect 50–500× log-volume amplification depending on QPS. Use object auditing or per-role scoping in production.

9. **Per-role `ALTER ROLE ... SET pgaudit.log` does not propagate across pgBouncer transaction-mode pools.** Backend connections reuse across user identities; `SET ROLE` does not re-apply per-role GUCs (cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) gotcha #6). Behind transaction-mode poolers, configure pgaudit at the cluster or per-database level instead.

10. **`pgaudit.log_catalog = on` (default) generates noise from psql.** `psql` and `pgAdmin` query `pg_catalog` heavily for tab completion and metadata. The default `pgaudit.log_catalog = on` includes those reads in your audit trail. Set to `off` if your audit policy permits.

11. **`pgaudit.log_parameter = on` puts sensitive values in the log.** Passwords, SSNs, credit card numbers — anything bound as a query parameter is captured verbatim. Secure log files at the same level as the underlying data. Use `pgaudit.log_parameter_max_size` to cap individual parameter length.

12. **Audit log lines appear in *both* `stderr` and `csvlog`/`jsonlog`** when `log_destination = 'stderr,csvlog,jsonlog'`. This is correct for transition periods but doubles log-disk usage. Pick one final-form destination.

13. **`jsonlog` (PG15+) embeds pgaudit's CSV body in the `message` field as a single string.** SIEM parsers must split the message field on commas — pgaudit fields are not separately parsed into JSON keys. If your SIEM cannot parse nested CSV-in-JSON cleanly, use `csvlog` instead.

14. **`%L` (client IP) in `log_line_prefix` is PG18-only.** Pre-PG18, use `%h` (host name) or `%r` (host + port). The `%L` escape was added in PG18 per the verbatim release-note quote.[^pg18-logging]

15. **`pgaudit.log_relation = on` produces one log line per relation referenced.** A SELECT joining 10 tables produces 10 audit lines. Useful for exhaustive logging without configuring `pgaudit.role`, but inflates log volume substantially. Prefer object auditing for production.

16. **Combining session and object auditing produces *both* sets of log lines for matching statements.** A SELECT against an audited table with `pgaudit.log = 'read'` AND `pgaudit.role = 'pii_auditor'` produces one `SESSION,READ` line and one `OBJECT,READ` line. Not a bug; intentional. De-dupe at log-parsing time.

17. **pgaudit major version must match PG major version.** Mixing pgaudit 17 with PG 18 (or vice versa) fails to load at server startup. After `pg_upgrade`, install the new pgaudit package before starting the upgraded cluster.

18. **`shared_preload_libraries = 'pgaudit'` requires a server restart, not just a reload.** Adding pgaudit to an existing cluster is not a hot operation. Plan for a brief maintenance window.

19. **`pgaudit.log_statement_once = on` makes statement-text + parameters appear only on the *first* sub-statement.** Subsequent audit lines for the same statement reference the same statement ID. Easier to read at low volume but harder to correlate at high volume; pick based on your downstream parser's capabilities.

20. **Audit log itself is a target for tampering.** Standard server log files are owned by the `postgres` Unix user and writable by the database process. Without log shipping to an immutable store, a compromised DBA can delete or alter the audit trail. Compliance frameworks require tamper-evident logging — ship logs to a separate immutable system.

21. **Versioning-scheme break at PG 16.** pgaudit `v1.NN.X` for PG13/14/15, then `vNN.X` matching the PG major from PG 16 onwards. Searching for "pgaudit 16" expecting `1.16` finds nothing — the package is `pgaudit 16.X`.

22. **No PostgreSQL release notes mention pgaudit.** PG 14 through PG 18 release notes contain zero pgaudit items. The extension lives entirely out-of-tree on its own release cadence; if a tutorial claims pgaudit gained a feature "in PG release N," verify against the [pgaudit GitHub release notes](https://github.com/pgaudit/pgaudit/releases) instead.

23. **`pgaudit.log_level` forbids `ERROR`, `FATAL`, and `PANIC`.** Verbatim: *"but note that `ERROR`, `FATAL`, and `PANIC` are not allowed."*[^pgaudit-readme] Audit entries are observations, not error conditions; attempts to set the level to `error`/higher are rejected at GUC validation.

## See Also

- [`46-roles-privileges.md`](./46-roles-privileges.md) — `pgaudit.role` is a role; GRANT mechanics for object auditing
- [`47-row-level-security.md`](./47-row-level-security.md) — RLS + pgaudit gives row-aware access control + audit
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — authentication audit lives in `log_connections`, not pgaudit
- [`49-tls-ssl.md`](./49-tls-ssl.md) — `pg_stat_ssl` for current-session encryption state; pair with pgaudit for end-to-end audit
- [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md) — audit access to encrypted columns; pgaudit logs the SQL, not the decrypted values
- [`39-triggers.md`](./39-triggers.md) — row-level audit via triggers and transition tables; pgaudit alternative for row deltas
- [`40-event-triggers.md`](./40-event-triggers.md) — DDL auditing via event triggers; pgaudit covers the same with `pgaudit.log = 'ddl'`
- [`53-server-configuration.md`](./53-server-configuration.md) — `log_*` GUCs that govern where pgaudit lines go
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — query observability complement; pgaudit captures verbatim text, pg_stat_statements normalizes
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_roles.rolconfig` and `pg_db_role_setting` for per-role/db pgaudit overrides
- [`69-extensions.md`](./69-extensions.md) — extension management lifecycle for pgaudit
- [`82-monitoring.md`](./82-monitoring.md) — log shipping to SIEM / immutable storage
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-provider availability of pgaudit varies

## Sources

[^pgaudit-readme]: pgaudit GitHub repository README, accessed 2026-05-12. Latest release pgaudit 18.0 dated 2025-09-24. Verbatim quotes throughout this file are from the README's *Introduction*, *Why pgAudit?*, *Usage Considerations*, *PostgreSQL Version Compatibility*, *Compile and Install*, *Settings*, *Session Audit Logging*, *Object Audit Logging*, *Format*, and *Caveats* sections, including: *"The pgAudit extension must be loaded in `shared_preload_libraries`... Otherwise, an error will be raised at load time and no audit logging will occur."*, *"Depending on settings, it is possible for pgAudit to generate an enormous volume of logging. Be careful to determine exactly what needs to be audit logged in your environment to avoid logging too much."*, *"Object audit logging logs statements that affect a particular relation... Only SELECT, INSERT, UPDATE and DELETE commands are supported."*, *"Session audit logging provides detailed logs of all statements executed by a user in the backend."*, *"Basic statement logging can be provided by the standard logging facility with log_statement = all. This is acceptable for monitoring and other usages but does not provide the level of detail generally required for an audit... The standard logging facility shows what the user requested, while pgAudit focuses on the details of what happened while the database was satisfying the request."*, *"pgAudit supports PostgreSQL 14 or greater."*, and the eight-class catalog (READ/WRITE/FUNCTION/ROLE/DDL/MISC/MISC_SET/ALL) with their verbatim definitions. https://github.com/pgaudit/pgaudit
[^pg15-logging]: PostgreSQL 15.0 release notes, Server-side languages and logging section. Verbatim: *"Add support for jsonlog log output (Sehrope Sarkuni). This logs in a parsable JSON format."* https://www.postgresql.org/docs/release/15.0/
[^pg17-logging]: PostgreSQL 17.0 release notes, Server section. Verbatim: *"Add log_connections log line for trust connections (Jacob Champion)."* https://www.postgresql.org/docs/release/17.0/
[^pg18-logging]: PostgreSQL 18.0 release notes, Server section. Verbatim quotes: *"Add log_line_prefix escape `%L` to output the client IP address (Greg Sabino Mullane)."* *"Increase the logging granularity of server variable log_connections (Melanie Plageman)... This server variable was previously only boolean, which is still supported."* *"Add log_connections option to report the duration of connection stages (Melanie Plageman)."* *"Add server variable log_lock_failures to log lock acquisition failures (Yuki Seino, Fujii Masao). Specifically it reports SELECT ... NOWAIT lock failures."* https://www.postgresql.org/docs/release/18.0/
[^pg-logging-runtime]: PostgreSQL 16 documentation, runtime configuration logging chapter. Verbatim default values and behavior for `log_destination` (*"PostgreSQL supports several methods for logging server messages, including stderr, csvlog, jsonlog, and syslog. On Windows, eventlog is also supported... The default is to log to stderr only."*), `log_statement` (*"Valid values are none (off), ddl, mod, and all (all statements)... The default is none."*), `log_min_messages` (*"Valid values are DEBUG5, DEBUG4, DEBUG3, DEBUG2, DEBUG1, INFO, NOTICE, WARNING, ERROR, LOG, FATAL, and PANIC... The default is WARNING."*), `log_min_error_statement`, `log_line_prefix` (*"The default is '%m [%p] ' which logs a time stamp and the process ID."*), `log_rotation_age` (24 hours default) and `log_rotation_size` (10 megabytes default). https://www.postgresql.org/docs/16/runtime-config-logging.html
[^pgaudit-releases]: pgaudit GitHub releases page lists 18.0 (2025-09-24) as the latest stable release, with prior majors `17.X`, `16.X`, `1.7.X` (PG15), `1.6.X` (PG14), and `1.5.X` (PG13, unsupported). The versioning-scheme break at PG 16 is documented in the compatibility matrix in the README. https://github.com/pgaudit/pgaudit/releases

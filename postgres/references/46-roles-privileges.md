# Roles and Privileges



## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Mental Model — Five Rules](#mental-model--five-rules)
    - [Decision Matrix](#decision-matrix)
    - [CREATE ROLE Grammar](#create-role-grammar)
    - [Role Attributes](#role-attributes)
    - [INHERIT vs NOINHERIT](#inherit-vs-noinherit)
    - [GRANT and REVOKE](#grant-and-revoke)
    - [ALTER DEFAULT PRIVILEGES](#alter-default-privileges)
    - [SET ROLE vs SET SESSION AUTHORIZATION](#set-role-vs-set-session-authorization)
    - [REASSIGN OWNED and DROP OWNED](#reassign-owned-and-drop-owned)
    - [Predefined Roles](#predefined-roles)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)



## When to Use This Reference

Reach for this file when you are:

- Creating login and group roles, granting/revoking object privileges, or auditing who has access to what.
- Choosing between `INHERIT` and `NOINHERIT` for a role membership.
- Setting up automatic privileges on future objects via `ALTER DEFAULT PRIVILEGES`.
- Dropping a role that owns objects (`REASSIGN OWNED` / `DROP OWNED`).
- Using `SET ROLE` to test permissions or `SET SESSION AUTHORIZATION` for impersonation.
- Picking the right predefined role (`pg_read_all_data`, `pg_monitor`, `pg_maintain` PG17+, etc.) instead of granting superuser.
- Migrating to PG16+ where `CREATEROLE` lost most of its historic powers and now requires `ADMIN OPTION` on the target role.

> [!WARNING] PG14 / PG15 / PG16 each made breaking privilege changes
> PG14 added `pg_read_all_data` / `pg_write_all_data` / `pg_database_owner`. PG15 **revoked PUBLIC's CREATE on the `public` schema** and removed the default `ADMIN OPTION` on a login role's own role-membership. PG16 dramatically narrowed `CREATEROLE` — it can no longer change another role's attributes or add members to it without explicit `ADMIN OPTION`. PG17 added the `MAINTAIN` table privilege and the `pg_maintain` role. **Carry-forward scripts written for PG13 routinely fail silently on PG15/PG16.**

This file is the SQL surface for roles and privileges. Authentication (which roles can connect, with what method) lives in [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md). Row-level filtering lives in [`47-row-level-security.md`](./47-row-level-security.md). TLS is [`49-tls-ssl.md`](./49-tls-ssl.md). Auditing is [`51-pgaudit.md`](./51-pgaudit.md).



## Syntax / Mechanics

### Mental Model — Five Rules

1. **A role is a unified login + group identity.** PostgreSQL has one `pg_authid` catalog. `CREATE USER` is `CREATE ROLE … LOGIN`; `CREATE GROUP` is a deprecated synonym for `CREATE ROLE … NOLOGIN`. There is no separate user/group namespace.[^user-manag]

2. **Default is `INHERIT`** — a member role automatically uses the privileges of every role it belongs to, transitively. Setting `NOINHERIT` forces explicit `SET ROLE` before privileges become usable. The default flipped to be policy-significant in PG16: `CREATEROLE` no longer creates inheriting roles automatically.[^role-membership]

3. **`SUPERUSER` bypasses all privilege checks. `BYPASSRLS` bypasses row-level security only.** Either attribute makes the role exempt from the checks that follow — use sparingly, and never grant `SUPERUSER` to an application role. Use predefined roles (`pg_read_all_data`, `pg_monitor`, `pg_maintain` PG17+) for broad read/monitor/maintain access instead of `SUPERUSER`.[^createrole]

4. **`ALTER DEFAULT PRIVILEGES` is the only way to grant on *future* objects.** A `GRANT SELECT ON ALL TABLES IN SCHEMA app TO reader` grants on currently-existing tables only. Tables created after run as if no grant had happened.[^alter-default-privs]

5. **`DROP ROLE` fails if the role still owns any object.** You must `REASSIGN OWNED BY old TO new;` then `DROP OWNED BY old;` (the second handles privilege grants), then `DROP ROLE old;`. `REASSIGN OWNED` operates per-database — run it in each database where the role owns objects.[^drop-role]


### Decision Matrix

| You need to | Use | Avoid | Why |
|---|---|---|---|
| Connect to the database from an application | `CREATE ROLE app LOGIN PASSWORD '…'` | `CREATE ROLE app` (defaults to NOLOGIN) | Without `LOGIN` the role cannot connect; only useful as a group |
| Bundle privileges under one identity | `CREATE ROLE group_readers NOLOGIN; GRANT … TO group_readers; GRANT group_readers TO alice, bob` | `GRANT` to each user separately | Group roles let you re-target privileges by adding/removing membership |
| Give a service read access to one schema | `GRANT USAGE ON SCHEMA app TO reader; GRANT SELECT ON ALL TABLES IN SCHEMA app TO reader; ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO reader;` | `GRANT pg_read_all_data` (too broad) | Per-schema grant is principle of least privilege |
| Give one role read access to **every** table in the cluster | `GRANT pg_read_all_data TO reporter` (PG14+) | Manual loop over `pg_namespace` | Predefined role is maintained by the server and covers future schemas |
| Give one role permission to run VACUUM / ANALYZE on a table | `GRANT MAINTAIN ON TABLE t TO maintainer` (PG17+) | `GRANT pg_maintain` (too broad) | PG17 `MAINTAIN` is the per-table grant; `pg_maintain` is the role-scope version |
| Give DBAs read access to all stats and settings | `GRANT pg_monitor TO dba_team` | `GRANT SUPERUSER` | `pg_monitor` is a member of `pg_read_all_settings`, `pg_read_all_stats`, `pg_stat_scan_tables` |
| Let a worker create subscriptions for logical replication | `GRANT pg_create_subscription TO worker` (PG16+) | `GRANT SUPERUSER` | PG16 added this so subscriptions don't require superuser |
| Make group privileges flow automatically | Default `INHERIT` (no special flag) | `NOINHERIT` (forces `SET ROLE`) | `INHERIT` is the more common ergonomic default |
| Force role-switch ritual (compliance / audit) | `CREATE ROLE app NOINHERIT IN ROLE group_app` | Just `INHERIT` | With `NOINHERIT`, the role must `SET ROLE group_app` before group privileges activate, leaving an audit trail |
| Run code as a different user inside a session (privileged caller) | `SET ROLE another_member` | `SET SESSION AUTHORIZATION` | `SET ROLE` only switches authorization, not the session user identity |
| Impersonate at the session level (admin only) | `SET SESSION AUTHORIZATION target` | Reconnecting as that user | Requires the *authenticated* user to have been a superuser |
| Drop a role that owns objects | `REASSIGN OWNED BY old TO new; DROP OWNED BY old; DROP ROLE old;` | `DROP ROLE old; DROP OWNED BY old;` (wrong order — fails) | `DROP ROLE` will refuse if anything is owned by or granted to the role |
| Make new objects in a schema readable by a group automatically | `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO group_readers` | Catch-up grant after every deployment | Default privileges apply only to objects created *after* the ALTER, by the same creator-role |

Three smell signals:

- You are running `GRANT SELECT ON ALL TABLES IN SCHEMA … TO …` in a post-deploy script. Pair it with `ALTER DEFAULT PRIVILEGES` so new tables don't bypass the grant.
- Your application connects as a role with `SUPERUSER` or `BYPASSRLS`. Almost always wrong — split into a connection role plus per-feature `GRANT`s and use `SET ROLE` for elevation.
- You ran `DROP ROLE x` and got `role x cannot be dropped because some objects depend on it`. You skipped `REASSIGN OWNED` / `DROP OWNED`.


### CREATE ROLE Grammar

The full grammar (condensed):[^createrole]

    CREATE ROLE name [ [ WITH ] option [ ... ] ]

    where option can be:

          SUPERUSER | NOSUPERUSER
        | CREATEDB | NOCREATEDB
        | CREATEROLE | NOCREATEROLE
        | INHERIT | NOINHERIT
        | LOGIN | NOLOGIN
        | REPLICATION | NOREPLICATION
        | BYPASSRLS | NOBYPASSRLS
        | CONNECTION LIMIT connlimit
        | [ ENCRYPTED ] PASSWORD 'password' | PASSWORD NULL
        | VALID UNTIL 'timestamp'
        | IN ROLE role_name [, ...]
        | ROLE role_name [, ...]
        | ADMIN role_name [, ...]
        | SYSID uid                  -- ignored, historical

`CREATE USER` is identical except `LOGIN` is the default. Recommendation: always write `CREATE ROLE … LOGIN` (or `NOLOGIN`) explicitly — the `LOGIN`/`NOLOGIN` distinction is what makes a role usable as a connection identity.

> [!NOTE] PostgreSQL 16
> When `CREATE ROLE` adds a role to an existing role via `IN ROLE`, the new membership has the `SET` option enabled and the `ADMIN` option disabled by default. To grant the new member the ability to add others to the parent role, write `GRANT parent TO new WITH ADMIN OPTION;` after creation. The `ROLE` clause works the other direction — it adds the named roles as members of the new role, again with `SET` enabled and `ADMIN` disabled.[^createrole]


### Role Attributes

| Attribute | Default | What it enables | Where to set |
|---|---|---|---|
| `LOGIN` | `NOLOGIN` (`CREATE ROLE`); `LOGIN` (`CREATE USER`) | Role can connect | `CREATE ROLE`, `ALTER ROLE` |
| `SUPERUSER` | `NOSUPERUSER` | Bypass all permission checks; only a superuser can grant this | `CREATE ROLE`, `ALTER ROLE` |
| `CREATEDB` | `NOCREATEDB` | Role can `CREATE DATABASE` | same |
| `CREATEROLE` | `NOCREATEROLE` | Role can create/alter/drop other roles — **scope narrowed in PG16** | same |
| `INHERIT` | `INHERIT` | Privileges from group memberships are automatically active | same |
| `REPLICATION` | `NOREPLICATION` | Role can initiate replication (physical or logical) and connect for `replication`-database authentication | same |
| `BYPASSRLS` | `NOBYPASSRLS` | Skip row-level security; only a superuser can grant this | same |
| `CONNECTION LIMIT n` | `-1` (unlimited) | Max concurrent connections for this role | same |
| `PASSWORD 'p'` | none (no password) | SCRAM/MD5 password text. `PASSWORD NULL` removes the password. | `CREATE ROLE`, `ALTER ROLE … PASSWORD`, `\password` in psql |
| `VALID UNTIL ts` | `infinity` | Password expiration timestamp (NULL means no expiration) | same |

> [!NOTE] PostgreSQL 16
> `CREATEROLE` was dramatically narrowed: verbatim release-note quote *"Restrict the privileges of CREATEROLE and its ability to modify other roles … Previously roles with CREATEROLE privileges could change many aspects of any non-superuser role. Such changes, including adding members, now require the role requesting the change to have ADMIN OPTION permission."*[^pg16-createrole] On PG16+, a role with `CREATEROLE` can still create new roles, but to alter or grant membership in an existing role it needs `ADMIN OPTION` on that role.

Per-role GUC overrides via `ALTER ROLE … SET param = value` are documented in [`53-server-configuration.md`](./53-server-configuration.md). The pattern is canonical for per-role timeouts (see [`41-transactions.md`](./41-transactions.md) Recipe 1) and per-role default isolation (see [`42-isolation-levels.md`](./42-isolation-levels.md) Recipe 7).


### INHERIT vs NOINHERIT

When role `alice` is a member of `group_app`:

- **`INHERIT` (default):** Any privilege held by `group_app` is automatically usable by `alice` while connected as `alice`. No `SET ROLE` required. Object ownership does *not* transfer — `alice` cannot own `group_app`'s objects without `SET ROLE` first.[^role-membership]
- **`NOINHERIT`:** `alice` does not get `group_app`'s privileges until she runs `SET ROLE group_app;`. This forces an explicit role-switch ritual (useful for audit trails and elevation-only patterns).

The verbatim docs rule: *"The privilege chain stops at memberships with `INHERIT FALSE`."*[^role-membership] Mixed inheritance is legal: `alice → group_app (INHERIT) → group_root (NOINHERIT)` means `alice` inherits `group_app`'s direct privileges but NOT `group_root`'s.

> [!NOTE] PostgreSQL 16
> `GRANT … WITH INHERIT TRUE` / `WITH INHERIT FALSE` makes the inheritance flag per-grant rather than per-role. Verbatim release-note quote: *"The role's default inheritance behavior can be overridden with the new `GRANT ... WITH INHERIT` clause. This allows inheritance of some roles and not others because the members' inheritance status is set at GRANT time."*[^pg16-inherit] You can set the per-grant default with `GRANT group_app TO alice WITH INHERIT FALSE;` regardless of `alice`'s `INHERIT`/`NOINHERIT` attribute.

Three operational rules:

1. The role attribute `INHERIT` / `NOINHERIT` (set in `CREATE ROLE`) is the *default*; per-grant `WITH INHERIT` (PG16+) overrides per-membership.
2. `SET ROLE` works on a granted role regardless of `INHERIT` — that's the whole point of `NOINHERIT`.
3. `NOINHERIT` does NOT prevent ownership — owned objects belong to the role even if its membership doesn't inherit privileges. `REASSIGN OWNED` still applies.


### GRANT and REVOKE

The privilege catalog by object type:[^ddl-priv]

| Object type | Privileges |
|---|---|
| `TABLE` | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN` (PG17+) |
| `SEQUENCE` | `USAGE`, `SELECT`, `UPDATE` |
| `DATABASE` | `CREATE`, `CONNECT`, `TEMPORARY` (alias `TEMP`) |
| `DOMAIN` | `USAGE` |
| `FOREIGN DATA WRAPPER` | `USAGE` |
| `FOREIGN SERVER` | `USAGE` |
| `FUNCTION` / `PROCEDURE` | `EXECUTE` |
| `LANGUAGE` | `USAGE` |
| `LARGE OBJECT` | `SELECT`, `UPDATE` |
| `PARAMETER` (PG15+) | `SET`, `ALTER SYSTEM` |
| `SCHEMA` | `CREATE`, `USAGE` |
| `TABLESPACE` | `CREATE` |
| `TYPE` | `USAGE` |
| Role membership | `WITH ADMIN OPTION`, `WITH SET OPTION` (PG16+), `WITH INHERIT OPTION` (PG16+) |

GRANT grammar (condensed):[^sql-grant]

    GRANT { privilege [, ...] | ALL [ PRIVILEGES ] }
        ON { TABLE table_name [, ...] | ALL TABLES IN SCHEMA schema [, ...] | ... }
        TO role_specification [, ...]
        [ WITH GRANT OPTION ]
        [ GRANTED BY role_specification ]

    GRANT role_name [, ...]
        TO role_specification [, ...]
        [ WITH { ADMIN | INHERIT | SET } { OPTION | TRUE | FALSE } ]
        [ GRANTED BY role_specification ]

REVOKE mirrors GRANT but takes `CASCADE` or `RESTRICT`:

    REVOKE [ GRANT OPTION FOR ]
        { privilege [, ...] | ALL [ PRIVILEGES ] }
        ON { table_specification }
        FROM role_specification [, ...]
        [ GRANTED BY role_specification ]
        [ CASCADE | RESTRICT ]

`RESTRICT` is the default and refuses to revoke if dependent grants exist; `CASCADE` recursively revokes downstream grants.

> [!NOTE] PostgreSQL 17
> Added `MAINTAIN` table privilege and `pg_maintain` predefined role. Verbatim: *"The permission can be granted on a per-table basis using the MAINTAIN privilege and on a per-role basis via the pg_maintain predefined role. Permitted operations are VACUUM, ANALYZE, REINDEX, REFRESH MATERIALIZED VIEW, CLUSTER, and LOCK TABLE."*[^pg17-maintain] This is the right grant for autovacuum-bypass roles and dedicated maintenance workers — previously you had to either be the table owner or be `SUPERUSER`.

> [!NOTE] PostgreSQL 15
> Removed PUBLIC's default `CREATE` privilege on the `public` schema. Verbatim: *"Remove PUBLIC creation permission on the public schema."*[^pg15-public] Existing tables in `public` are unaffected; **new** tables in `public` now require explicit `GRANT CREATE ON SCHEMA public TO user_or_role` (or table creation by the schema owner). `public` is now owned by `pg_database_owner` instead of the bootstrap superuser.[^pg15-owner] Audit any application that assumed it could `CREATE TABLE` in `public` without an explicit grant.

`GRANT OPTION` lets the grantee further re-grant the privilege. `ADMIN OPTION` is the equivalent for role membership: a role granted `WITH ADMIN OPTION` can add other members to the parent role.

> [!NOTE] PostgreSQL 15
> Removed the default `ADMIN OPTION` a login role had on its own role membership. Verbatim: *"Remove the default ADMIN OPTION privilege a login role has on its own role membership … Previously, a login role could add/remove members of its own role, even without ADMIN OPTION privilege."*[^pg15-admin] Operationally: pre-PG15 a role could `GRANT itself TO new_user` to grow its membership; on PG15+ that requires `WITH ADMIN OPTION` set explicitly via the parent grant.

#### ACL strings

Every grantable object has an `aclitem[]` column in its catalog (e.g., `pg_class.relacl`, `pg_namespace.nspacl`). The string format is `grantee=privs/grantor`:

    alice=arwd/postgres
        ^      ^   ^
        |      |   `-- grantor (postgres granted this)
        |      `------ privileges encoded as letters (a=INSERT, r=SELECT, w=UPDATE, d=DELETE, …)
        `------------- grantee role name (empty = PUBLIC)

Privilege letters (from `ddl-priv.html`):[^ddl-priv]

| Letter | Privilege | Letter | Privilege |
|---|---|---|---|
| `r` | SELECT (read) | `a` | INSERT (append) |
| `w` | UPDATE (write) | `d` | DELETE |
| `D` | TRUNCATE | `x` | REFERENCES |
| `t` | TRIGGER | `m` | MAINTAIN (PG17+) |
| `X` | EXECUTE | `U` | USAGE |
| `C` | CREATE | `c` | CONNECT |
| `T` | TEMPORARY | `s` | SET (parameter, PG15+) |
| `A` | ALTER SYSTEM (PG15+) |   |   |

`*` after a letter means `WITH GRANT OPTION` (e.g., `alice=r*w/postgres` means SELECT *with grant option* + UPDATE).


### ALTER DEFAULT PRIVILEGES

Future objects created by a specific role do not automatically receive privileges granted to other roles. `ALTER DEFAULT PRIVILEGES` is the mechanism to fix this.[^alter-default-privs]

    ALTER DEFAULT PRIVILEGES
        [ FOR { ROLE | USER } target_role [, ...] ]
        [ IN SCHEMA schema_name [, ...] ]
        abbreviated_grant_or_revoke

    abbreviated_grant_or_revoke:

        GRANT { privilege [, ...] | ALL [ PRIVILEGES ] }
            ON { TABLES | SEQUENCES | FUNCTIONS | ROUTINES | TYPES | SCHEMAS | LARGE OBJECTS }  -- LARGE OBJECTS added PG18+
            TO role_specification [, ...]
            [ WITH GRANT OPTION ]

Three critical rules:

1. **Default privileges are *per creator-role*.** The `FOR ROLE target_role` clause names *who creates the object*, not who receives privileges. If `admin` creates a table, only the defaults set `FOR ROLE admin` apply. If `app_deployer` creates the same shape of table, you need a separate `ALTER DEFAULT PRIVILEGES FOR ROLE app_deployer`.
2. **Defaults are *additive*.** Per-schema defaults add to global defaults. You cannot revoke globally-granted privileges at the schema level.[^alter-default-privs]
3. **Defaults apply only to objects created *after* the ALTER DEFAULT PRIVILEGES.** They never retroactively grant on existing objects.

> [!NOTE] PostgreSQL 18
> `LARGE OBJECTS` added as a target. Verbatim release-note quote: *"Allow ALTER DEFAULT PRIVILEGES to define large object default privileges."*[^pg18-ldp] Previously you had to attach a trigger or use `has_largeobject_privilege()` checks per-LO.


### SET ROLE vs SET SESSION AUTHORIZATION

Two superficially similar commands with very different semantics.[^sql-set-role][^sql-set-sa]

| | `SET ROLE` | `SET SESSION AUTHORIZATION` |
|---|---|---|
| Who can run | Any role that is a member of the target (with `SET` option) — superusers can switch to anything | Only if the **authenticated user** (initial session user) was a superuser |
| What changes | Current `current_user` (used for permissions) | Both `current_user` and `session_user` |
| Reversible | `RESET ROLE` returns to the prior context | `RESET SESSION AUTHORIZATION` returns to the authenticated user |
| Superuser side-effects | If switching from a superuser to a non-superuser role, **lose superuser privileges** for the duration | Same — switching from superuser to non-superuser loses powers |
| Use inside `SECURITY DEFINER` functions | **Not allowed** — `SET ROLE` is forbidden inside SECURITY DEFINER bodies | Not allowed for non-superusers; superusers may use it |
| Honors `ALTER ROLE … SET …` GUCs | **No** — per-role GUCs do not re-apply when you `SET ROLE` | No |
| Typical use | Testing what a user sees; running batch as a less-privileged role | Admin acting as a specific user for one transaction |

The verbatim per-grant SET-option rule (PG16+): `SET ROLE` requires the `SET` option on the membership grant. Most grants default `SET = TRUE`, but `GRANT … WITH SET FALSE` explicitly forbids the `SET ROLE` action.[^pg16-setopt]


### REASSIGN OWNED and DROP OWNED

Dropping a role with owned objects fails:[^drop-role]

    DROP ROLE alice;
    -- ERROR: role "alice" cannot be dropped because some objects depend on it

The canonical sequence to remove a role cleanly:

    -- Step 1: hand ownership to a successor role (must run in EACH database the role owns objects in)
    REASSIGN OWNED BY alice TO bob;

    -- Step 2: drop privileges granted to alice and other dependent ACL entries
    --         (also runs per-database)
    DROP OWNED BY alice;

    -- Step 3: drop the role itself (cluster-wide command — run once)
    DROP ROLE alice;

Three operational rules:

1. **`REASSIGN OWNED` is per-database.** Loop over `pg_database` and run it inside each database where the role might own anything. The role catalog itself is cluster-wide; ownership is per-database.
2. **`DROP OWNED` removes the role from any ACL it appears in**, even as a grantee — this is why step 2 is required even after step 1 already moved ownership.
3. **`REASSIGN OWNED` does not transfer non-database-scope resources** like tablespaces or shared catalog ownership. Use `ALTER TABLESPACE … OWNER TO bob` separately if applicable.

A typical batch:

    DO $$
    DECLARE d text;
    BEGIN
        FOR d IN SELECT datname FROM pg_database WHERE datallowconn LOOP
            EXECUTE format('ALTER DATABASE %I CONNECTION LIMIT 0', d);
            -- then in a per-db script: REASSIGN OWNED BY alice TO bob; DROP OWNED BY alice;
        END LOOP;
    END$$;


### Predefined Roles

Predefined roles ship with the cluster and live under the `pg_` prefix.[^predefined-roles] They cannot be dropped or renamed.

| Role | Since | What it grants |
|---|---|---|
| `pg_signal_backend` | PG9.6 | `pg_cancel_backend` / `pg_terminate_backend` on any non-superuser backend |
| `pg_read_server_files` | PG11 | Read files via `COPY FROM 'path'`, `pg_ls_dir`, etc. (server-side filesystem) |
| `pg_write_server_files` | PG11 | Write files via `COPY TO 'path'`, `pg_read_file`, etc. |
| `pg_execute_server_program` | PG11 | `COPY FROM PROGRAM 'cmd'` and `COPY TO PROGRAM 'cmd'` |
| `pg_monitor` | PG10 | Aggregate of `pg_read_all_settings` + `pg_read_all_stats` + `pg_stat_scan_tables` |
| `pg_read_all_settings` | PG10 | Read all GUC settings including ones normally hidden |
| `pg_read_all_stats` | PG10 | Read all `pg_stat_*` views |
| `pg_stat_scan_tables` | PG10 | Run statistics functions that take locks |
| `pg_read_all_data` | PG14 | `SELECT` on every table/view/sequence; `USAGE` on every schema |
| `pg_write_all_data` | PG14 | `INSERT`/`UPDATE`/`DELETE` on every table |
| `pg_database_owner` | PG14 | Implicit membership of the current database's owner; owns `public` since PG15 |
| `pg_checkpoint` | PG15 | Run `CHECKPOINT` |
| `pg_use_reserved_connections` | PG16 | Use connections reserved by `reserved_connections` (PG16+ GUC) |
| `pg_create_subscription` | PG16 | Create subscriptions (with appropriate `CONNECT` on origin database) |
| `pg_maintain` | PG17 | `MAINTAIN` privilege on every table — VACUUM/ANALYZE/REINDEX/REFRESH MATVIEW/CLUSTER/LOCK |
| `pg_signal_autovacuum_worker` | PG18 | Send signals to autovacuum worker backends |

> [!NOTE] PostgreSQL 14
> `pg_read_all_data` / `pg_write_all_data` / `pg_database_owner` added. Verbatim release-note quotes: *"Add predefined roles pg_read_all_data and pg_write_all_data … These non-login roles can be used to give read or write permission to all tables, views, and sequences."*[^pg14-readall] And: *"Add predefined role pg_database_owner that contains only the current database's owner … This is especially useful in template databases."*[^pg14-dbowner]

> [!NOTE] PostgreSQL 18
> `pg_signal_autovacuum_worker` added. Verbatim: *"Add predefined role pg_signal_autovacuum_worker … This allows sending signals to autovacuum workers."*[^pg18-sigav] Lets a non-superuser DBA cancel a stuck autovacuum without escalating to superuser. See [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) for autovacuum operational context.

Use predefined roles whenever possible instead of granting `SUPERUSER`. A monitoring agent needs `pg_monitor`, not superuser. A backup tool that runs `pg_basebackup` needs the `REPLICATION` role attribute and `pg_read_all_data` (or its own table grants), not superuser. An autovacuum-tuning DBA needs `pg_maintain` on PG17+, not superuser.


### Per-Version Timeline

| Version | Change | Source |
|---|---|---|
| PG13 | Added trusted-extensions flag (relevant: trusted extensions can be installed by non-superuser, see [`09-procedural-languages.md`](./09-procedural-languages.md) and [`69-extensions.md`](./69-extensions.md)) | — |
| PG14 | `pg_read_all_data`, `pg_write_all_data`, `pg_database_owner` predefined roles | [^pg14-readall][^pg14-dbowner] |
| PG15 | **PUBLIC's `CREATE` on `public` schema revoked**; `public` owned by `pg_database_owner`; default `ADMIN OPTION` on own role removed; `pg_checkpoint` role added; `SET`/`ALTER SYSTEM` privileges on configuration parameters | [^pg15-public][^pg15-owner][^pg15-admin] |
| PG16 | `CREATEROLE` narrowed — needs `ADMIN OPTION` to modify existing roles; `GRANT … WITH SET / WITH INHERIT` per-grant options; `pg_create_subscription` role; `pg_use_reserved_connections` role; bootstrap superuser cannot be demoted | [^pg16-createrole][^pg16-inherit][^pg16-setopt] |
| PG17 | `MAINTAIN` table privilege and `pg_maintain` role; safe `search_path` during maintenance operations | [^pg17-maintain][^pg17-safesp] |
| PG18 | `pg_signal_autovacuum_worker` role; `ALTER DEFAULT PRIVILEGES` for large objects; `pg_get_acl()` function; `has_largeobject_privilege()` function | [^pg18-sigav][^pg18-ldp][^pg18-getacl] |



## Examples / Recipes

### Recipe 1 — Baseline three-role pattern for a new application

Most applications should have at least three roles. The owner creates the schema and tables, the application connects with read/write but cannot DDL, the reporter is read-only.

    -- Owner of all DDL: not for connection
    CREATE ROLE app_owner NOLOGIN;

    -- Application connects as this role
    CREATE ROLE app_user LOGIN PASSWORD '…';

    -- Reporting / analytics
    CREATE ROLE app_reader LOGIN PASSWORD '…';

    -- Schema owned by app_owner
    CREATE SCHEMA app AUTHORIZATION app_owner;

    -- Read+write for app, read-only for reader
    GRANT USAGE ON SCHEMA app TO app_user, app_reader;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user;
    GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_reader;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO app_user;

    -- And critically — for future objects too
    ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
        GRANT SELECT ON TABLES TO app_reader;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
        GRANT USAGE ON SEQUENCES TO app_user;

The `FOR ROLE app_owner` is critical — without it the defaults apply to objects created by *the role running ALTER DEFAULT PRIVILEGES*, not future objects created by `app_owner`.


### Recipe 2 — Per-role timeouts and isolation as a production baseline

Continues the iteration-41/42 per-role-baseline pattern. Set timeouts and isolation on the connection role, not cluster-wide.

    ALTER ROLE app_user SET statement_timeout = '30s';
    ALTER ROLE app_user SET lock_timeout = '5s';
    ALTER ROLE app_user SET idle_in_transaction_session_timeout = '60s';
    ALTER ROLE app_user SET idle_session_timeout = '15min';        -- PG14+
    ALTER ROLE app_user SET default_transaction_isolation = 'read committed';

    ALTER ROLE app_reader SET statement_timeout = '5min';
    ALTER ROLE app_reader SET default_transaction_read_only = on;
    ALTER ROLE app_reader SET default_transaction_isolation = 'repeatable read';

See [`41-transactions.md`](./41-transactions.md) Recipe 1 for timeouts, [`42-isolation-levels.md`](./42-isolation-levels.md) Recipe 7 for isolation.


### Recipe 3 — Soft revocation via REVOKE CONNECT

To temporarily lock out a role without deleting it:

    REVOKE CONNECT ON DATABASE app FROM app_user;

    -- and to kick existing sessions:
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE usename = 'app_user' AND pid <> pg_backend_pid();

Reversing it: `GRANT CONNECT ON DATABASE app TO app_user;`.


### Recipe 4 — Audit who can SELECT from a sensitive table

The right query uses `has_table_privilege()` per role, because effective privileges depend on group membership transitively.

    WITH roles AS (
        SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\_%'
    )
    SELECT r.rolname,
           has_table_privilege(r.rolname, 'app.payments', 'SELECT')   AS can_select,
           has_table_privilege(r.rolname, 'app.payments', 'INSERT')   AS can_insert,
           has_table_privilege(r.rolname, 'app.payments', 'UPDATE')   AS can_update,
           has_table_privilege(r.rolname, 'app.payments', 'DELETE')   AS can_delete
    FROM roles r
    ORDER BY r.rolname;

This is far more reliable than scanning `pg_class.relacl` directly — `has_table_privilege` handles inheritance chains, `SUPERUSER`, and `pg_read_all_data` automatically.


### Recipe 5 — Audit roles with SUPERUSER, BYPASSRLS, or CREATEROLE

    SELECT rolname,
           rolsuper      AS is_superuser,
           rolbypassrls  AS bypasses_rls,
           rolcreaterole AS can_create_role,
           rolcreatedb   AS can_create_db,
           rolreplication AS can_replicate,
           rolinherit    AS inherits_privs
    FROM pg_roles
    WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
    ORDER BY rolsuper DESC, rolname;

The audit's first action is usually shrinking the `is_superuser` set. Application service roles should never be superusers; if they are, that's the first incident to fix.


### Recipe 6 — Audit role membership graph

    SELECT r.rolname AS member,
           m.rolname AS parent_role,
           am.admin_option,
           am.inherit_option,                                   -- PG16+
           am.set_option                                        -- PG16+
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.member
    JOIN pg_roles m ON m.oid = am.roleid
    ORDER BY m.rolname, r.rolname;

PG14 and earlier do not have `inherit_option` / `set_option` — fall back to `am.admin_option` only.


### Recipe 7 — Discover the public schema PG15 trap

On a cluster upgraded from PG14 or earlier, the `public` schema may *still* have PUBLIC's `CREATE` privilege from before the upgrade. PG15 only revokes it for *new* clusters. Audit:

    SELECT n.nspname, n.nspacl
    FROM pg_namespace n
    WHERE n.nspname IN ('public');

If the `nspacl` shows `=UC/postgres` for the empty-grantee (PUBLIC), CREATE is still granted. To remediate:

    REVOKE CREATE ON SCHEMA public FROM PUBLIC;

After this, only the schema owner (`pg_database_owner` from PG15+ defaults, or whoever inherited `public` ownership) can create objects in `public`.


### Recipe 8 — Predefined-role-based monitoring agent

Avoid superuser for monitoring:

    CREATE ROLE prometheus_exporter LOGIN PASSWORD '…';
    GRANT pg_monitor TO prometheus_exporter;
    -- pg_monitor = pg_read_all_settings + pg_read_all_stats + pg_stat_scan_tables
    -- This is enough for postgres_exporter / pgwatch / DataDog probes.

    -- Plus per-database CONNECT:
    GRANT CONNECT ON DATABASE app TO prometheus_exporter;
    GRANT CONNECT ON DATABASE template1 TO prometheus_exporter;

See [`82-monitoring.md`](./82-monitoring.md) for the broader monitoring catalog.


### Recipe 9 — Maintenance role without superuser (PG17+)

    CREATE ROLE dba_maintainer LOGIN PASSWORD '…';
    GRANT pg_maintain TO dba_maintainer;

    -- Now dba_maintainer can run:
    --   VACUUM, ANALYZE, REINDEX (CONCURRENTLY), REFRESH MATERIALIZED VIEW,
    --   CLUSTER, and LOCK TABLE on any table.
    -- No SUPERUSER required.

Pre-PG17 alternative: grant `MAINTAIN` per-table (also PG17+), or accept that only the owner / superuser can run these operations. See [`26-index-maintenance.md`](./26-index-maintenance.md) Recipe 2 for how this enables `REINDEX CONCURRENTLY` from a non-owner role.


### Recipe 10 — Drop a role that owns objects, cluster-wide

Cluster-scope cleanup script (pseudocode for a shell loop):

    # In each database the role might own anything:
    for db in $(psql -At -c "SELECT datname FROM pg_database WHERE datallowconn"); do
        psql -d "$db" -c "REASSIGN OWNED BY old_dev TO new_dev;"
        psql -d "$db" -c "DROP OWNED BY old_dev;"
    done

    # Then cluster-wide:
    psql -c "DROP ROLE old_dev;"

If `old_dev` owned any tablespace, run `ALTER TABLESPACE x OWNER TO new_dev;` first — tablespace ownership is cluster-wide and not handled by per-database `REASSIGN OWNED`.


### Recipe 11 — Test what a user sees via SET ROLE

A privileged session can simulate a less-privileged user without disconnecting:

    BEGIN;
    SET LOCAL ROLE app_reader;
    SELECT * FROM app.payments LIMIT 5;
    -- Permission errors here reflect what app_reader actually sees.
    ROLLBACK;                            -- Discards the simulation transaction

`SET LOCAL ROLE` reverts at COMMIT/ROLLBACK. `SET ROLE` (without `LOCAL`) persists until `RESET ROLE` or end of session. Note that `SET ROLE` does not re-apply per-role GUCs from `ALTER ROLE … SET …` — the surrounding session's GUCs stay in effect.


### Recipe 12 — Per-database password policy via VALID UNTIL

    -- Force rotation in 90 days
    ALTER ROLE app_user VALID UNTIL CURRENT_DATE + INTERVAL '90 days';

    -- Audit roles whose password expires soon:
    SELECT rolname, rolvaliduntil
    FROM pg_roles
    WHERE rolvaliduntil IS NOT NULL
      AND rolvaliduntil < CURRENT_DATE + INTERVAL '14 days'
    ORDER BY rolvaliduntil;

After expiration the role cannot authenticate via password — but already-connected sessions stay alive. Pair with a session-aging GUC like `idle_session_timeout` to actually kick stale sessions.


### Recipe 13 — Per-grant audit with pg_get_acl (PG18+)

Pre-PG18, decoding `pg_class.relacl` strings was a manual exercise (see the ACL letter table above). PG18 adds `pg_get_acl()`:[^pg18-getacl]

    -- PG18+
    SELECT pg_get_acl('table', 'app.payments'::regclass::oid);
    -- Returns a setof aclitem rows: (grantee, granted_privs, grantor, …)



## Gotchas / Anti-patterns

1. **Default privileges don't apply to existing objects.** `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES TO reader` only affects tables created *after* the ALTER. Run a `GRANT SELECT ON ALL TABLES IN SCHEMA … TO reader` once for the existing set.

2. **`FOR ROLE` in `ALTER DEFAULT PRIVILEGES` names the *creator*, not the *grantee*.** If `admin` creates a table but you wrote `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner …`, the default doesn't apply. Determine who actually runs `CREATE TABLE` in your environment and `FOR ROLE` that.

3. **PG15+ revokes PUBLIC's CREATE on `public` schema for *new* clusters only.** Upgraded clusters retain the old grant. Recipe 7 shows the audit.

4. **`DROP ROLE` does not drop owned objects.** You must `REASSIGN OWNED` (per-database) then `DROP OWNED` (per-database) first. Skipping either step leaves orphaned ACL entries or fails outright.

5. **`SET ROLE` inside a `SECURITY DEFINER` function is forbidden.** Calls to `SET ROLE` inside such a function raise `cannot set role within security-definer function`.[^sql-set-role] If you need to switch authorization context inside a SECURITY DEFINER body, restructure the function or call out to a wrapper.

6. **`SET ROLE` does not re-apply per-role GUCs.** Verbatim: *"Does not process role session variables from `ALTER ROLE` settings."* If you `SET ROLE app_reader`, the timeouts and isolation level you set on `app_reader` via `ALTER ROLE` are NOT activated — the surrounding session's GUCs stay. To get them, reconnect as `app_reader`.

7. **`SET SESSION AUTHORIZATION` requires the *authenticated* user to be a superuser.** Even if the current session has `SET ROLE`'d to a superuser, you cannot then `SET SESSION AUTHORIZATION` — the check is on the role that originally connected.

8. **PG16 narrowed `CREATEROLE`.** A pre-PG16 script that creates a role and then grants it membership in another role will fail on PG16 unless the running role has `ADMIN OPTION` on the target role. Audit `CREATEROLE` roles after upgrade.

9. **PG15 removed the default `ADMIN OPTION` on a role's own membership.** Pre-PG15, `alice` could add new members to `alice` (the role identity) without `ADMIN OPTION`. PG15+ requires explicit `WITH ADMIN OPTION` on the original grant of `alice → alice`. Self-referential grants are unusual but appear in some legacy patterns.

10. **`INHERIT` is the *default* attribute** — explicit `NOINHERIT` is required to disable inheritance. Operators expecting principle-of-least-privilege defaults are sometimes surprised.

11. **Group ownership is not transferred by INHERIT.** Even if `alice` inherits `group_app`'s privileges, objects owned by `group_app` belong to `group_app`, not `alice`. To create or own objects on behalf of `group_app`, run `SET ROLE group_app` first.

12. **Predefined roles cannot be granted role attributes.** You cannot `ALTER ROLE pg_monitor LOGIN` — predefined roles are server-managed. They can only be granted *to* other roles.

13. **`pg_read_all_data` includes USAGE on schemas, but NOT EXECUTE on functions.** A role with `pg_read_all_data` can read every table but cannot run a function unless granted `EXECUTE` separately. Be careful with `SECURITY DEFINER` functions.

14. **`pg_write_all_data` does NOT grant `pg_read_all_data`.** Writers without reader membership can `INSERT`/`UPDATE`/`DELETE` blindly but cannot `SELECT` the rows they're modifying — `UPDATE … WHERE id = 1` requires `SELECT` on the WHERE-clause columns.

15. **PG17 `pg_maintain` does not include `ANALYZE`-by-itself power on materialized views**. The `MAINTAIN` privilege covers `REFRESH MATERIALIZED VIEW` but the matview must already exist; `pg_maintain` doesn't grant creation rights.

16. **Granting `CONNECT` on a database does not let you read its tables.** Database `CONNECT` is just network-level admission. Tables still need `SELECT`. Common error: granting only `CONNECT` and being confused that `\d` shows nothing.

17. **`REVOKE … FROM PUBLIC` only removes the PUBLIC grant.** Individual roles that hold the privilege directly are unaffected. Audit per-role grants separately.

18. **`pg_dump --clean` does not drop roles.** Logical dumps cover database-scope objects only. Cluster-scope objects (roles, tablespaces, ACLs on databases) come from `pg_dumpall --globals-only`. After restoring into a fresh cluster, you must restore globals separately, or the dump's object owners won't exist as roles.

19. **`security_barrier` views and `SECURITY DEFINER` functions** interact subtly with roles — see [`05-views.md`](./05-views.md) and [`06-functions.md`](./06-functions.md). Briefly: a `security_invoker` view (PG15+) checks permissions as the *caller*; a default view checks as the *owner*. Auditing what a role can see through views requires picking the right view type.

20. **`BYPASSRLS` only bypasses row-level security, not regular grants.** A role with `BYPASSRLS` still cannot `SELECT` a table it has not been granted `SELECT` on. The two privilege axes are orthogonal — see [`47-row-level-security.md`](./47-row-level-security.md).

21. **The `bootstrap superuser` (whoever ran `initdb`) cannot be demoted on PG16+.** Verbatim: *"Superuser privileges cannot be removed from the bootstrap user to prevent restoration errors."* Treat the `initdb` role as a permanent break-glass account; do not use it for routine work.

22. **Per-role GUCs do not propagate across pgBouncer transaction-mode pools.** `ALTER ROLE app SET statement_timeout = '30s'` applies on connection; if pgBouncer reuses backend connections across clients with different roles in transaction mode, the GUC may persist incorrectly. See [`81-pgbouncer.md`](./81-pgbouncer.md). Use `SET LOCAL` inside transactions instead.

23. **`pg_signal_backend` cannot signal superuser backends.** A non-superuser DBA granted `pg_signal_backend` cannot kill a query run by a superuser. This is intentional — to terminate a superuser query you need to be a superuser yourself (or `pg_signal_autovacuum_worker` for autovacuum-specific cases on PG18+).



## See Also

- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — schema/table DDL
- [`05-views.md`](./05-views.md) — `security_invoker` and `security_barrier` view options
- [`06-functions.md`](./06-functions.md) — `SECURITY DEFINER` functions and how their owner-vs-caller authorization interacts with roles
- [`08-plpgsql.md`](./08-plpgsql.md) — PL/pgSQL and `SECURITY DEFINER` interaction
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `MAINTAIN` privilege enables non-owner `REINDEX CONCURRENTLY`
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — `pg_maintain` and `pg_signal_autovacuum_worker` operational context
- [`41-transactions.md`](./41-transactions.md) — per-role timeouts via `ALTER ROLE … SET`
- [`42-isolation-levels.md`](./42-isolation-levels.md) — per-role isolation defaults
- [`47-row-level-security.md`](./47-row-level-security.md) — `BYPASSRLS` and RLS policy mechanics
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — which roles can connect and with which auth method
- [`51-pgaudit.md`](./51-pgaudit.md) — auditing role and privilege actions
- [`53-server-configuration.md`](./53-server-configuration.md) — GUCs that can be set per-role via `ALTER ROLE`
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_authid`, `pg_auth_members`, `pg_roles`, `pg_namespace.nspacl`, `pg_class.relacl`
- [`81-pgbouncer.md`](./81-pgbouncer.md) — per-role GUCs and connection pooling
- [`49-tls-ssl.md`](./49-tls-ssl.md) — SCRAM password hashes in `pg_authid`; TLS configuration for role connections
- [`82-monitoring.md`](./82-monitoring.md) — monitoring-agent role patterns; granting `pg_monitor` to the monitoring user



## Sources

[^user-manag]: PostgreSQL 16 Documentation — Database Roles. https://www.postgresql.org/docs/16/user-manag.html
[^createrole]: PostgreSQL 16 Documentation — CREATE ROLE. https://www.postgresql.org/docs/16/sql-createrole.html
[^role-membership]: PostgreSQL 16 Documentation — Role Membership. https://www.postgresql.org/docs/16/role-membership.html
[^alter-default-privs]: PostgreSQL 16 Documentation — ALTER DEFAULT PRIVILEGES. https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html
[^drop-role]: PostgreSQL 16 Documentation — DROP ROLE. https://www.postgresql.org/docs/16/sql-droprole.html
[^sql-grant]: PostgreSQL 16 Documentation — GRANT. https://www.postgresql.org/docs/16/sql-grant.html
[^ddl-priv]: PostgreSQL 16 Documentation — Privileges. https://www.postgresql.org/docs/16/ddl-priv.html
[^sql-set-role]: PostgreSQL 16 Documentation — SET ROLE. https://www.postgresql.org/docs/16/sql-set-role.html
[^sql-set-sa]: PostgreSQL 16 Documentation — SET SESSION AUTHORIZATION. https://www.postgresql.org/docs/16/sql-set-session-authorization.html
[^predefined-roles]: PostgreSQL 16 Documentation — Predefined Roles. https://www.postgresql.org/docs/16/predefined-roles.html
[^pg14-readall]: "Add predefined roles pg_read_all_data and pg_write_all_data (Stephen Frost) — These non-login roles can be used to give read or write permission to all tables, views, and sequences." PostgreSQL 14 Release Notes. https://www.postgresql.org/docs/release/14.0/
[^pg14-dbowner]: "Add predefined role pg_database_owner that contains only the current database's owner (Noah Misch) — This is especially useful in template databases." PostgreSQL 14 Release Notes. https://www.postgresql.org/docs/release/14.0/
[^pg15-public]: "Remove PUBLIC creation permission on the public schema (Noah Misch)." PostgreSQL 15 Release Notes. https://www.postgresql.org/docs/release/15.0/
[^pg15-owner]: "Change the owner of the public schema to be the new pg_database_owner role (Noah Misch)." PostgreSQL 15 Release Notes. https://www.postgresql.org/docs/release/15.0/
[^pg15-admin]: "Remove the default ADMIN OPTION privilege a login role has on its own role membership (Robert Haas) — Previously, a login role could add/remove members of its own role, even without ADMIN OPTION privilege." PostgreSQL 15 Release Notes. https://www.postgresql.org/docs/release/15.0/
[^pg16-createrole]: "Restrict the privileges of CREATEROLE and its ability to modify other roles (Robert Haas) — Previously roles with CREATEROLE privileges could change many aspects of any non-superuser role. Such changes, including adding members, now require the role requesting the change to have ADMIN OPTION permission." PostgreSQL 16 Release Notes. https://www.postgresql.org/docs/release/16.0/
[^pg16-inherit]: "The role's default inheritance behavior can be overridden with the new GRANT ... WITH INHERIT clause. This allows inheritance of some roles and not others because the members' inheritance status is set at GRANT time." PostgreSQL 16 Release Notes. https://www.postgresql.org/docs/release/16.0/
[^pg16-setopt]: PG16 added `WITH SET { OPTION | TRUE | FALSE }` to GRANT for role membership, controlling whether the member can `SET ROLE` to the parent. https://www.postgresql.org/docs/16/sql-grant.html
[^pg17-maintain]: "The permission can be granted on a per-table basis using the MAINTAIN privilege and on a per-role basis via the pg_maintain predefined role. Permitted operations are VACUUM, ANALYZE, REINDEX, REFRESH MATERIALIZED VIEW, CLUSTER, and LOCK TABLE." PostgreSQL 17 Release Notes. https://www.postgresql.org/docs/release/17.0/
[^pg17-safesp]: "Change functions to use a safe search_path during maintenance operations (Jeff Davis) — This prevents maintenance operations (ANALYZE, CLUSTER, CREATE INDEX, CREATE MATERIALIZED VIEW, REFRESH MATERIALIZED VIEW, REINDEX, or VACUUM) from performing unsafe access." PostgreSQL 17 Release Notes. https://www.postgresql.org/docs/release/17.0/
[^pg18-sigav]: "Add predefined role pg_signal_autovacuum_worker (Kirill Reshke) — This allows sending signals to autovacuum workers." PostgreSQL 18 Release Notes. https://www.postgresql.org/docs/release/18.0/
[^pg18-ldp]: "Allow ALTER DEFAULT PRIVILEGES to define large object default privileges (Takatsuka Haruka, Yugo Nagata, Laurenz Albe)." PostgreSQL 18 Release Notes. https://www.postgresql.org/docs/release/18.0/
[^pg18-getacl]: "Add function pg_get_acl() to retrieve database access control details (Joel Jacobson)." PostgreSQL 18 Release Notes. https://www.postgresql.org/docs/release/18.0/

# 48 — Authentication and `pg_hba.conf`

`pg_hba.conf` (Host-Based Authentication) is the file the server consults to decide *who can connect, from where, and how they prove identity* before any role attributes, RLS policies, or table grants are evaluated. This file covers the surface from first principles through every auth method.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Decision matrix](#decision-matrix)
    - [`pg_hba.conf` record grammar](#pg_hbaconf-record-grammar)
    - [The `type` column](#the-type-column)
    - [The `database` column](#the-database-column)
    - [The `user` column](#the-user-column)
    - [The `address` column](#the-address-column)
    - [Auth methods](#auth-methods)
    - [Include directives (PG16+)](#include-directives-pg16)
    - [Reloading `pg_hba.conf`](#reloading-pg_hbaconf)
    - [`pg_ident.conf` user name maps](#pg_identconf-user-name-maps)
    - [Inspection views](#inspection-views)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when the question is "can this client connect, and what proof do we require?" — anything before the role-attribute / grant / RLS layer described in [`46-roles-privileges.md`](./46-roles-privileges.md) and [`47-row-level-security.md`](./47-row-level-security.md). Specifically:

- Setting up authentication for a new cluster or new role.
- Diagnosing a failed connection ("password authentication failed", "no pg_hba.conf entry for host", "Ident authentication failed").
- Hardening a cluster: replacing `trust` with `scram-sha-256`, replacing `md5` with `scram-sha-256`, adding certificate-based auth.
- Setting up LDAP / Kerberos / RADIUS / PAM integration.
- Upgrading across PG14 → PG16 → PG18 where `pg_hba.conf` semantics or available methods changed.
- Migrating a managed-cluster workload to bare metal (most managed providers expose `pg_hba.conf` through an abstraction; bare metal exposes the file directly).

> [!WARNING] Three-version breaking-change streak for authentication
> **PG14, PG16, and PG18 all introduced material changes** to the `pg_hba.conf` surface or to default password handling:
> - **PG14:** `password_encryption` default changed from `md5` to `scram-sha-256`[^pg14-password-encryption]; `clientcert` accepts only `verify-ca` / `verify-full` (the old `1`/`0`/`no-verify` values were removed)[^pg14-clientcert]; multi-line records via trailing backslash[^pg14-multiline]; `clientname=DN` for matching the full certificate distinguished name[^pg14-clientname].
> - **PG15:** `pg_ident_file_mappings` system view added[^pg15-ident-view]. No other `pg_hba.conf` changes.
> - **PG16:** `include` / `include_if_exists` / `include_dir` directives added[^pg16-include]; regular-expression matching in `database` and `user` columns via leading `/`[^pg16-regex]; `pg_ident.conf` user column gained `all` / `+role` / regex parity with `pg_hba.conf`[^pg16-ident-parity]; libpq `require_auth` parameter[^pg16-require-auth].
> - **PG17:** `db_user_namespace` removed[^pg17-db-user-ns]; `sslnegotiation=direct` for one-roundtrip TLS[^pg17-sslneg]; `log_connections` now emits a line for `trust` connections[^pg17-trust-log].
> - **PG18:** **`oauth` auth method added**[^pg18-oauth] (the first new method since `scram-sha-256` in PG10); **MD5 passwords formally deprecated** with `CREATE ROLE` / `ALTER ROLE` warnings[^pg18-md5-deprecation]; SCRAM passthrough for `postgres_fdw` and `dblink`[^pg18-scram-passthrough].
>
> Configurations carried forward from a PG13 (or earlier) cluster routinely **silently work but are no longer best practice**: an inherited `password_encryption = md5` keeps issuing MD5 hashes on every `ALTER ROLE ... PASSWORD`, an inherited `clientcert=1` will fail outright on PG14+, and inherited `include` lines from third-party scripts won't parse on PG≤15.

## Mental Model

Five rules — name each misconception they defeat:

1. **`pg_hba.conf` is consulted top-to-bottom; the first matching record wins.** Verbatim: *"The first record with a matching connection type, client address, requested database, and user name is used to perform authentication. There is no 'fall-through' or 'backup': if one record is chosen and the authentication fails, subsequent records are not considered."*[^first-match] **Defeats:** "The most specific rule wins." It does not. The most-specific rule must appear *before* the more-general rule, or the general rule absorbs the match.

2. **Authentication happens before any SQL-level access check.** Roles, role attributes (`LOGIN`, `BYPASSRLS`, etc. — see [`46-roles-privileges.md`](./46-roles-privileges.md)), database `CONNECT` privileges, table grants, and RLS policies are all evaluated *after* `pg_hba.conf` has accepted the connection. **Defeats:** "I'll fix this with a grant." A `pg_hba.conf` rejection cannot be overridden by SQL.

3. **`scram-sha-256` is the modern default; `md5` is deprecated but still works.** PG14 changed `password_encryption` default to `scram-sha-256`[^pg14-password-encryption]; PG18 emits deprecation warnings on `CREATE ROLE`/`ALTER ROLE` when an MD5 password is set[^pg18-md5-deprecation]. The MD5 method itself has not been removed but the PG18 release notes explicitly state: *"Support for MD5 passwords will be removed in a future major version release."* **Defeats:** "MD5 is fine, the docs still mention it." The docs mention it for compatibility, not for new deployments.

4. **`trust` means *no* authentication — every connecting client is accepted as whatever role they claim.** Verbatim: *"PostgreSQL assumes that anyone who can connect to the server is authorized to access the database with whatever database user name they specify (even superuser names)."*[^trust] **Defeats:** "`trust` trusts the network — they still need a password." They do not. `trust` is "the network is the boundary." Use it only on Unix sockets controlled by file-system permissions, never on TCP/IP in a multi-tenant environment.

5. **`pg_hba.conf` changes apply on SIGHUP, but existing connections keep whatever authorization they were granted at connection time.** Verbatim: *"The pg_hba.conf file is read on start-up and when the main server process receives a SIGHUP signal. If you edit the file on an active system, you will need to signal the postmaster (using `pg_ctl reload`, calling the SQL function `pg_reload_conf()`, or using `kill -HUP`) to make it re-read the file."*[^reload] **Defeats:** "I tightened pg_hba.conf and the bad clients still seem to be connecting." Their *next* connection will be denied; their current one stays open until they disconnect or `pg_terminate_backend()` kills them — same pattern as [`46-roles-privileges.md`](./46-roles-privileges.md) Recipe 3 (soft revocation).

## Syntax / Mechanics

### Decision matrix

| You want to … | Auth method | Type column | Notes |
|---|---|---|---|
| Allow local Unix-socket connection without a password | `peer` | `local` | OS-user-to-DB-user mapping; the modern default for Unix sockets |
| Allow local Unix-socket connection requiring password | `scram-sha-256` | `local` | When the OS user is shared (e.g., apps running as `www-data`) |
| Allow remote TCP/IP connection with password | `scram-sha-256` | `host`, `hostssl`, or `hostnossl` | `scram-sha-256` over TLS is the modern default for remote |
| Force TLS for remote connections | `scram-sha-256` (or any method) | `hostssl` | Add a final `host ... reject` to disallow non-TLS |
| Allow remote connection only with client TLS certificate | `cert` | `hostssl` | DN/CN of cert mapped to DB user (with optional `pg_ident.conf`) |
| Bypass auth on local sockets (laptop dev) | `trust` | `local` | **Never** on `host`/`hostssl`; never in production |
| Integrate with corporate LDAP | `ldap` | `host`/`hostssl` | Pick **search+bind** for variable user DNs; **simple-bind** for fixed-DN-pattern |
| Integrate with Kerberos/Active Directory | `gss` (Unix) / `sspi` (Windows) | `host`/`hostssl`/`hostgssenc` | Service principal `postgres/host@REALM` |
| Allow physical replication user | `scram-sha-256` | `host`/`hostssl` | Use the `replication` pseudo-database |
| Allow logical replication subscription | any method | regular `host`/`hostssl` | Logical replication uses *named databases*, not `replication` |
| Restrict by source subnet | CIDR address | `host`/`hostssl` | `10.0.0.0/8`, `192.168.1.0/24`, IPv6 `2001:db8::/64` |
| Restrict by source hostname | hostname address | `host`/`hostssl` | Forward + reverse DNS resolution required at connect time |
| Restrict by regex on role name | regex `user` | `host`/`hostssl` | PG16+ only; `^app_.*$` etc. |
| Disallow a method from the client side | `require_auth` libpq parameter | n/a (client-side) | PG16+ |
| Federated SSO via OAuth | `oauth` | `host`/`hostssl` | PG18+ only; requires validator library |

**Three smell signals** that a `pg_hba.conf` configuration is wrong:

1. **`trust` lines on `host` or `hostssl` types.** `trust` on TCP/IP means anyone reaching the port is a superuser-capable connection. The only place `trust` is safe is `local` on a Unix socket whose filesystem permissions are correctly restricted.
2. **`md5` lines on a new deployment.** `scram-sha-256` is the PG10+ default; PG14+ stores SCRAM hashes by default; PG18+ warns on `ALTER ROLE ... PASSWORD` when MD5 is used. A new `md5` line indicates a copy-paste from a pre-PG10 example.
3. **More-specific rules below more-general rules.** `pg_hba.conf` is first-match-wins. A `host all all 0.0.0.0/0 reject` line as the last entry will never reject anything if a `host all all 0.0.0.0/0 scram-sha-256` line comes first. Always place specific rules before general rules.

### `pg_hba.conf` record grammar

Each non-comment, non-blank line is one of:

- A record: `type database user address auth-method [auth-options]`
- An include directive (PG16+): `include`, `include_if_exists`, or `include_dir`

A record has 5 mandatory fields (plus `auth-options`). The `address` field is absent for `local` records. Fields are separated by whitespace.

> [!NOTE] PostgreSQL 14
> Records may span multiple lines using a trailing backslash for continuation[^pg14-multiline]. Useful when a record has many `auth-options`.

### The `type` column

Six values, each describing a class of client connection:

| Type | Verbatim docs description |
|---|---|
| `local` | *"matches connection attempts using Unix-domain sockets. Without a record of this type, Unix-domain socket connections are disallowed."*[^type-local] |
| `host` | *"matches connection attempts made using TCP/IP. host records match SSL or non-SSL connection attempts as well as GSSAPI encrypted or non-GSSAPI encrypted connection attempts."*[^type-host] |
| `hostssl` | *"only when the connection is made with SSL encryption."*[^type-hostssl] |
| `hostnossl` | *"opposite behavior of hostssl."*[^type-hostnossl] |
| `hostgssenc` | *"only when the connection is made with GSSAPI encryption."*[^type-hostgssenc] |
| `hostnogssenc` | *"opposite behavior of hostgssenc."*[^type-hostnogssenc] |

**Operational rules:**

- A `host` record matches both SSL and non-SSL. If you want to *require* TLS, use `hostssl` for the allow rules AND add a `host ... reject` as a final catch-all.
- `hostgssenc` matches the GSSAPI wire-protocol encryption layer, **independent** of SSL/TLS.
- The absence of any `local` record means Unix-domain sockets are disallowed entirely.

### The `database` column

Either a comma-separated list of database names, a special keyword, or a regex.

| Form | Meaning |
|---|---|
| `db1,db2,db3` | Exact match against any listed database |
| `all` | All databases |
| `replication` | Matches **physical** replication connections only; does **not** match logical replication[^replication-pseudo] |
| `sameuser` | The requested database name matches the user name[^sameuser] |
| `samerole` (alias: `samegroup`) | The requested user must be a member of the role with the same name as the database[^sameuser] |
| `/regex` | PG16+: regex match. Names beginning with `/` must be double-quoted[^pg16-regex] |

> [!NOTE] PostgreSQL 16
> Regular-expression matching on database names was introduced in PG16[^pg16-regex]. Prefix the pattern with `/`. Patterns are anchored at end (use `^` and `$` to anchor explicitly if needed). To reference a literal database name starting with `/`, wrap it in double quotes.

### The `user` column

Either a comma-separated list of role names, a group reference, a regex, or `all`.

| Form | Meaning |
|---|---|
| `alice,bob` | Exact role-name match |
| `all` | All roles |
| `+groupname` | Any role that is a *member* of the named group (transitive) |
| `/regex` | PG16+: regex match[^pg16-regex] |

> [!NOTE] PostgreSQL 16
> The `pg_ident.conf` user-column behavior was improved to *match* `pg_hba.conf`: `pg_ident.conf` now supports `all`, `+groupname` for role membership, and regex with leading slash[^pg16-ident-parity]. Pre-PG16 `pg_ident.conf` was syntactically more restricted.

### The `address` column

Used only for `host`, `hostssl`, `hostnossl`, `hostgssenc`, `hostnogssenc` (not `local`).

| Form | Meaning |
|---|---|
| `192.168.1.5/32` | IPv4 single host (CIDR notation) |
| `10.0.0.0/8` | IPv4 subnet (CIDR notation) |
| `2001:db8::/64` | IPv6 subnet |
| `192.168.1.5  255.255.255.255` | IP + netmask (legacy form; CIDR preferred) |
| `host.example.com` | Hostname — requires successful **forward AND reverse DNS** lookup at connect time |
| `.example.com` | Domain suffix (leading dot) |
| `samehost` | Any of the server's own IP addresses |
| `samenet` | Any address in any subnet the server is directly connected to |

Verbatim CIDR description: *"standard numeric notation for the range's starting address, then a slash (/) and a CIDR mask length."*[^cidr]

Verbatim `samehost`/`samenet`: *"samehost to match any of the server's own IP addresses, or samenet to match any address in any subnet that the server is directly connected to."*[^samehost]

**Operational rule:** Hostname matching does both forward (configured name → IP) and reverse (incoming IP → name) DNS lookups; mismatches reject the connection. Use CIDR when you can, hostnames only when subnet shape is fluid (e.g., dynamic DNS in containers).

### Auth methods

Eleven methods. Pick from this catalog:

| Method | Verbatim purpose / notable detail |
|---|---|
| `trust` | *"PostgreSQL assumes that anyone who can connect to the server is authorized to access the database with whatever database user name they specify (even superuser names)."*[^trust] |
| `reject` | Reject the connection unconditionally. Use as a catch-all to block. |
| `scram-sha-256` | *"This is the most secure of the currently provided methods, but it is not supported by older client libraries."*[^scram] Modern default. |
| `md5` | *"The method md5 uses a custom less secure challenge-response mechanism."*[^md5] Deprecated as of PG18. |
| `password` | Cleartext password over the wire. Only safe over TLS. |
| `peer` | OS-user-to-DB-user mapping for **local Unix-socket** connections only. Uses `getpeereid()`/SO_PEERCRED. |
| `ident` | OS-user-to-DB-user mapping via the **ident protocol** (RFC 1413) on **TCP/IP** only. Rarely used today.[^ident] |
| `cert` | Client TLS certificate; CN (or DN with `clientname=DN`) mapped to DB user.[^cert] |
| `gss` | Kerberos / GSSAPI. Unix-side. Service principal `postgres/hostname@REALM`. |
| `sspi` | Windows native GSS-compatible. *"On Windows, use SSPI instead of Kerberos."* |
| `ldap` | LDAP. Two modes: simple-bind or search+bind.[^ldap] |
| `radius` | RADIUS server delegated auth.[^radius] |
| `pam` | OS-level PAM stack.[^pam] |
| `bsd` | OpenBSD-only `auth-postgresql` login class.[^bsd] |
| `oauth` | **PG18+:** OAuth 2.0 bearer tokens (RFC 6750).[^pg18-oauth] |

**Method-by-method operational notes:**

#### `trust`

Two-line summary: **only safe on `local` records guarded by Unix filesystem permissions on the socket directory.** On `host`/`hostssl`/`hostnossl` it means anyone reaching the port is automatically superuser-capable. Verbatim warning: *"trust authentication is only suitable for TCP/IP connections if you trust every user on every machine that is allowed to connect to the server by the pg_hba.conf lines that specify trust."*[^trust-warning]

#### `scram-sha-256`

The modern default. The server stores a salted SCRAM verifier in `pg_authid.rolpassword`. The client sends its credential through the four-message SCRAM handshake; the password itself never crosses the network. Combine with TLS for channel binding (`tls-server-end-point`).

Verbatim recommendation: *"This is the most secure of the currently provided methods, but it is not supported by older client libraries."*[^scram] Client libraries that predate libpq 10 (October 2017) do not speak SCRAM and will need an upgrade.

#### `md5`

Verbatim status: *"the MD5 hash algorithm is nowadays no longer considered secure against determined attacks."*[^md5] PG18 emits deprecation warnings on `CREATE ROLE` / `ALTER ROLE` with MD5 passwords[^pg18-md5-deprecation]; the release notes state *"Support for MD5 passwords will be removed in a future major version release."*

**Migration recipe** (Recipe 11): change `password_encryption = scram-sha-256`, then have every role run `ALTER ROLE me PASSWORD 'newpw';` against itself (or have admins do `ALTER ROLE x PASSWORD 'newpw';`). The SCRAM verifier replaces the MD5 hash in `pg_authid`. Existing `md5` lines in `pg_hba.conf` continue to *accept* SCRAM verifiers, so you can switch the storage independent of the rule.

#### `peer`

Local Unix-socket only. Reads the client's effective OS user via `getpeereid()` and matches it to the requested DB user, optionally through `pg_ident.conf`. The PG-standard pattern for application servers: the OS user `webapp` connects as the DB role `webapp` with no password and no network exposure.

When `ident` is specified on a `local` record, the server silently falls back to `peer`: *"When ident is specified for a local (non-TCP/IP) connection, peer authentication will be used instead."*[^ident-local]

#### `cert`

Client TLS certificate-based. The certificate's CN (or DN with `clientname=DN`, PG14+) is compared to the requested DB user. With `clientcert=verify-full`, the cert is fully validated against the configured CA. Verbatim: *"It is redundant to use the clientcert option with cert authentication because cert authentication is effectively trust authentication with clientcert=verify-full."*[^cert-redundant]

> [!NOTE] PostgreSQL 14
> The `clientcert` option's accepted values changed: only `verify-ca` and `verify-full` are valid; the old `1`/`0`/`no-verify` were removed[^pg14-clientcert]. Configurations carried forward from PG13 with `clientcert=1` will fail at startup.

#### `ldap`

Two modes:

- **Simple-bind:** server binds directly as `ldapprefix + username + ldapsuffix`. Verbatim: *"the server will bind to the distinguished name constructed as prefix username suffix."*[^ldap-simple]
- **Search+bind:** server first binds with `ldapbinddn` + `ldapbindpasswd`, *searches* for the user's DN matching `ldapsearchattribute` / `ldapsearchfilter`, then re-binds as the discovered DN with the user-supplied password. Verbatim: *"the server first binds to the LDAP directory with a fixed user name and password ... and performs a search for the user trying to log in."*[^ldap-search]

**Pick search+bind** when user DNs vary across organizational units (most enterprise deployments). **Pick simple-bind** only when the DN-from-username pattern is uniform (rare).

Connection encryption: `ldapscheme=ldaps` or `ldaptls=1` encrypts only the PG-server-to-LDAP-server link, not the PG client-to-server link[^ldap-tls].

#### `gss` / `sspi`

Kerberos / Active Directory. Service principal is `servicename/hostname@REALM` where `servicename` defaults to `postgres` (override via `krb_srvname` in `postgresql.conf`). The key principal is loaded from the file named in `krb_server_keyfile` (`postgresql.conf`).

Use `gss` on Unix-side servers; `sspi` on Windows-side servers. Verbatim: *"SSPI works in negotiate mode, which uses Kerberos when possible and automatically falls back to NTLM in other cases."*

> [!NOTE] PostgreSQL 16
> Kerberos credential delegation: new `gss_accept_delegation` server variable and libpq `gssdelegation` parameter let an authenticated GSS user re-use their credentials for outbound connections (e.g., to a foreign data wrapper)[^pg16-gssdelegation].

#### `radius`

Delegates password verification to a RADIUS server. The role must still exist in `pg_authid`. No accounting. Options: `radiusservers`, `radiussecrets` (≥16 chars recommended), `radiusports` (default 1812), `radiusidentifiers` (default `"postgresql"`).

#### `pam`

Delegates to the OS PAM stack. The role must still exist in `pg_authid`. Critical limitation: *"If PAM is set up to read /etc/shadow, authentication will fail because the PostgreSQL server is started by a non-root user."*[^pam-shadow]

#### `bsd`

OpenBSD-only. Uses the `auth-postgresql` login type defined in `/etc/login.conf`. The role must still exist in `pg_authid`. The PG OS user must be a member of the `auth` group.

#### `oauth` (PG18+)

OAuth 2.0 bearer tokens (RFC 6750). New in PG18 — the first new auth method in eight years.

Verbatim PG18 release-note quote: *"Add support for the OAuth authentication method (Jacob Champion, Daniel Gustafsson, Thomas Munro). This adds an oauth authentication method to pg_hba.conf, libpq OAuth options, a server variable `oauth_validator_libraries` to load token validation libraries, and a configure flag --with-libcurl to add the required compile-time libraries."*[^pg18-oauth]

**Operational caveats:**

- Requires `oauth_validator_libraries` GUC pointing at a validation library (provided by an extension, not built into core).
- Build must include `--with-libcurl`.
- Tokens are bearer tokens — opaque strings honored by the validator. The server does not implement the OAuth flow itself; that lives in the client.

### Include directives (PG16+)

> [!NOTE] PostgreSQL 16
> Verbatim release-note quote: *"Allow include files in pg_hba.conf and pg_ident.conf (Julien Rouhaud) ... These are controlled by include, include_if_exists, and include_dir. System views pg_hba_file_rules and pg_ident_file_mappings now display the file name."*[^pg16-include]

Three directive forms:

| Directive | Behavior |
|---|---|
| `include filename` | Insert the file contents at this point. Fails to load `pg_hba.conf` if the file is missing. |
| `include_if_exists filename` | Same, but silently skip if the file is missing. |
| `include_dir dirname` | Insert every `*.conf` file in the directory, sorted by C-locale name. |

Verbatim mechanics: *"The records will be inserted in place of the include directives."*[^pg16-include-docs] **First-match-wins still applies** across the assembled file — an included file's first record can absorb a match that a later top-level record would have caught.

**Operational pattern:** Use `include_dir /etc/postgresql/16/main/pg_hba.d/` for management-tool–generated rule sets (Patroni, Ansible, Terraform). Each tool drops a numerically-prefixed file (`10-app-users.conf`, `20-replication.conf`, `90-deny-all.conf`) and the C-locale sort puts them in the intended order.

### Reloading `pg_hba.conf`

Verbatim: *"The pg_hba.conf file is read on start-up and when the main server process receives a SIGHUP signal. If you edit the file on an active system, you will need to signal the postmaster (using `pg_ctl reload`, calling the SQL function `pg_reload_conf()`, or using `kill -HUP`) to make it re-read the file."*[^reload]

Three ways to reload:

```sh
pg_ctl reload -D /var/lib/postgresql/16/main
```

```sql
SELECT pg_reload_conf();
```

```sh
kill -HUP <postmaster-pid>
```

**Operational rules:**

- Reload does **not** affect existing connections. They keep the authorization they were granted at connect time. Use `pg_terminate_backend()` to force a re-authentication.
- A syntactically invalid `pg_hba.conf` causes the reload to **fail** and the *old* configuration to remain in effect. Always validate with `pg_hba_file_rules` (Recipe 5) before relying on the reload.
- If you make the file unreadable by the postmaster (mode `000`, wrong owner), startup will fail. Always `chown postgres:postgres /etc/postgresql/.../pg_hba.conf` and `chmod 640` (or 600).

### `pg_ident.conf` user name maps

Separate file. Maps OS-user (or Kerberos principal, or LDAP attribute, or cert CN) to database role name. Referenced from `pg_hba.conf` via the `map=mapname` auth-option.

Verbatim purpose: *"When using an external authentication system such as Ident or GSSAPI, the name of the operating system user that initiated the connection might not be the same as the database user (role) that is to be used. In this case, a user name map can be applied."*[^ident-map]

Format: one record per line, three columns:

```
# mapname  system-username  database-username
op        alice            postgres
op        bob              postgres
```

> [!NOTE] PostgreSQL 16
> The `database-username` (third) column now accepts `all`, `+groupname`, and `/regex` — same as `pg_hba.conf`[^pg16-ident-parity]. Pre-PG16 it was an exact name only.

**Regex form:** Verbatim: *"If the system-username field starts with a slash (/), the remainder of the field is treated as a regular expression."*[^ident-regex] Capture groups via `\1` in the database-username:

```
op  /^(.*)@example\.com$  \1
```

This maps `alice@example.com` → `alice`. Useful for Kerberos principals (`alice@EXAMPLE.COM`) and email-formatted LDAP usernames.

**Two-way map:** A single `mapname` can have many lines — the first matching system-username wins for that map.

### Inspection views

Three SQL-visible views document the current state:

| View | Since | What it shows |
|---|---|---|
| `pg_hba_file_rules` | PG10 | Parsed `pg_hba.conf` rules with line numbers and errors |
| `pg_ident_file_mappings` | PG15[^pg15-ident-view] | Parsed `pg_ident.conf` mappings |
| `pg_settings` | always | Configuration values incl. `hba_file`, `ident_file` |

Use `pg_hba_file_rules` to validate a reload before applying — same shape as Recipe 5 below.

### Per-version timeline

| Version | Changes |
|---|---|
| PG14 | `password_encryption` default → `scram-sha-256`[^pg14-password-encryption]; `clientcert` accepts only `verify-ca`/`verify-full`[^pg14-clientcert]; multi-line records via trailing `\`[^pg14-multiline]; `clientname=DN` for certificate full-DN matching[^pg14-clientname]; passwords of arbitrary length |
| PG15 | `pg_ident_file_mappings` system view[^pg15-ident-view]. No other `pg_hba.conf` changes. |
| PG16 | `include` / `include_if_exists` / `include_dir` directives[^pg16-include]; regex on `database` / `user`[^pg16-regex]; `pg_ident.conf` user-column parity (`all`, `+role`, regex)[^pg16-ident-parity]; libpq `require_auth`[^pg16-require-auth]; Kerberos credential delegation[^pg16-gssdelegation]; `sslcertmode` libpq parameter |
| PG17 | `db_user_namespace` GUC removed[^pg17-db-user-ns]; `sslnegotiation=direct`[^pg17-sslneg]; `log_connections` line emitted for `trust` connections[^pg17-trust-log]; libpq `PQchangePassword()` |
| PG18 | **`oauth` auth method added**[^pg18-oauth]; **MD5 deprecation warnings**[^pg18-md5-deprecation]; `ssl_groups` GUC (renamed from `ssl_ecdh_curve`); `ssl_tls13_ciphers` GUC; SCRAM passthrough for `postgres_fdw` / `dblink` (`scram_client_key` / `scram_server_key`)[^pg18-scram-passthrough]; 256-bit cancel keys (protocol 3.2); `sslkeylogfile` debugging |

## Examples / Recipes

### Recipe 1: Production baseline `pg_hba.conf`

The single-most-important file in this section: the canonical multi-row example covering local + host + hostssl + at least three auth methods, ordered correctly (specific before general):

```
# TYPE   DATABASE        USER                     ADDRESS                AUTH-METHOD     [AUTH-OPTIONS]

# Local Unix-socket admin access via peer (no password needed)
local    all             postgres                                        peer

# Local Unix-socket app access via peer with name map
local    app_db          all                                             peer            map=appmap

# Local Unix-socket fallback for service accounts
local    all             all                                             scram-sha-256

# Replication: physical replication from listed standby hosts only, over TLS
hostssl  replication     replicator               10.20.0.10/32          scram-sha-256
hostssl  replication     replicator               10.20.0.11/32          scram-sha-256

# Application connections: SCRAM over TLS, from internal subnet only
hostssl  app_db          app_user                 10.0.0.0/8             scram-sha-256

# Admin (DBA) connections: SCRAM over TLS, from admin bastion only
hostssl  all             dba                      10.30.0.5/32           scram-sha-256

# Cert auth for monitoring agent (no password; cert CN = "monitoring")
hostssl  monitoring      monitoring               10.40.0.0/24           cert            clientcert=verify-full

# Reject any other TCP connection (including non-TLS attempts)
host     all             all                      0.0.0.0/0              reject
host     all             all                      ::/0                   reject
```

Pair this with a minimal `pg_ident.conf`:

```
# MAPNAME    SYSTEM-USERNAME    DATABASE-USERNAME
appmap       www-data           app_user
appmap       /^worker_[0-9]+$   app_user
```

Then in `postgresql.conf`:

```
listen_addresses = '*'
ssl = on
ssl_cert_file = '/etc/postgresql/16/server.crt'
ssl_key_file  = '/etc/postgresql/16/server.key'
password_encryption = 'scram-sha-256'
```

**The final two `reject` lines are mandatory.** Without them, any client matching no `host*` rule reaches an *implicit* reject — but you don't see it in the logs as a rule match. The explicit reject gives a log entry on every blocked attempt. Cross-reference [`82-monitoring.md`](./82-monitoring.md) for alerting on `connection rejected` log volume spikes.

### Recipe 2: Force TLS for every remote connection

The two-step pattern:

```
# Allow over TLS:
hostssl  all   all   0.0.0.0/0   scram-sha-256
hostssl  all   all   ::/0        scram-sha-256

# Reject everything else (including any unencrypted attempt):
host     all   all   0.0.0.0/0   reject
host     all   all   ::/0        reject
```

Because `hostssl` matches **only** TLS connections and `host` matches *both* TLS and non-TLS, ordering matters: the `hostssl` rules absorb the TLS traffic; the final `host` rules catch the non-TLS attempts and reject them. Without the final reject lines, an unencrypted client would silently fall off the bottom of the file and be rejected — but without a clear log signature.

### Recipe 3: Replication user

Physical replication uses the special `replication` pseudo-database in the database column:

```
hostssl  replication  replicator  10.20.0.0/16  scram-sha-256
```

The role itself must have `REPLICATION` attribute:

```sql
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '...';
```

**Critical gotcha (#11):** `replication` does NOT match logical replication. Verbatim docs quote: *"The value replication specifies that the record matches if a physical replication connection is requested, however, it doesn't match with logical replication connections."*[^replication-pseudo] Logical replication subscriptions connect to a *named* database; you authenticate them via the regular database-name rules.

```
# Physical replication
hostssl  replication  replicator      10.20.0.0/16  scram-sha-256

# Logical replication subscribers connect to named DB
hostssl  app_db       repl_subscriber 10.50.0.0/16  scram-sha-256
```

Cross-reference [`73-streaming-replication.md`](./73-streaming-replication.md) and [`74-logical-replication.md`](./74-logical-replication.md) for the full replication picture.

### Recipe 4: Certificate-based auth for unattended services

Eliminate password rotation for service accounts by using TLS client certificates:

```
# In pg_hba.conf:
hostssl  monitoring  monitoring  10.40.0.0/24  cert  clientcert=verify-full
```

```sql
-- The role still must exist with LOGIN:
CREATE ROLE monitoring LOGIN;
GRANT pg_monitor TO monitoring;  -- cross-reference 46-roles-privileges.md predefined roles
```

The client (`prometheus_exporter`, `pgbackrest`, etc.) connects with:

```
postgresql://monitoring@db.internal/monitoring?sslmode=verify-full&sslcert=/etc/ssl/monitoring.crt&sslkey=/etc/ssl/monitoring.key&sslrootcert=/etc/ssl/ca.crt
```

The certificate's CN field must equal `monitoring`. Use `map=mapname` in `pg_hba.conf` plus a `pg_ident.conf` entry to allow CN values that differ from the DB role name.

> [!NOTE] PostgreSQL 14
> Add `clientname=DN` to match against the full distinguished name rather than just the CN[^pg14-clientname]. Useful when your PKI naming convention puts the role name in `OU=...` rather than `CN=...`.

### Recipe 5: Validate a `pg_hba.conf` reload before applying

The `pg_hba_file_rules` view shows the parsed state of `pg_hba.conf` along with any parse errors:

```sql
SELECT line_number, type, database, user_name, address, netmask, auth_method, error
  FROM pg_hba_file_rules
 ORDER BY rule_number;
```

If `error` is non-NULL on any row, `pg_reload_conf()` will refuse to apply the file. The old configuration stays active.

**The safe reload workflow:**

```sh
# 1. Edit pg_hba.conf
sudo nano /etc/postgresql/16/main/pg_hba.conf

# 2. Parse-check (does not apply):
sudo -u postgres psql -c 'SELECT line_number, error FROM pg_hba_file_rules WHERE error IS NOT NULL;'

# 3. If empty result, reload:
sudo -u postgres psql -c 'SELECT pg_reload_conf();'

# 4. Verify the new rules are active:
sudo -u postgres psql -c "SELECT line_number, type, database, user_name, address, auth_method FROM pg_hba_file_rules WHERE auth_method NOT IN ('reject');"
```

### Recipe 6: Validate `pg_ident.conf` reload

> [!NOTE] PostgreSQL 15
> `pg_ident_file_mappings` was added in PG15[^pg15-ident-view]. Pre-PG15 there is no SQL-visible parse-check; you must rely on log output from `pg_reload_conf()`.

```sql
SELECT line_number, map_name, sys_name, pg_username, error
  FROM pg_ident_file_mappings
 ORDER BY line_number;
```

Same pattern as Recipe 5: parse-check first, reload only if clean.

### Recipe 7: Migrate MD5 → SCRAM cluster-wide

1. **Cluster-wide config change:**
   ```sql
   ALTER SYSTEM SET password_encryption = 'scram-sha-256';
   SELECT pg_reload_conf();
   ```

2. **Re-set every role password.** This is the step that converts the stored hash:
   ```sql
   -- As superuser, for every role with a stored md5 hash:
   SELECT 'ALTER ROLE ' || quote_ident(rolname) || ' PASSWORD ''<reset value>'';'
     FROM pg_authid
    WHERE rolpassword LIKE 'md5%';
   ```
   Setting a password under `password_encryption = scram-sha-256` produces a SCRAM verifier in `pg_authid.rolpassword`. The existing MD5 hash is *replaced*, not augmented.

3. **Change `pg_hba.conf` lines from `md5` to `scram-sha-256`:**
   ```sh
   sudo sed -i 's/\bmd5\b/scram-sha-256/g' /etc/postgresql/16/main/pg_hba.conf
   sudo -u postgres psql -c 'SELECT line_number, error FROM pg_hba_file_rules WHERE error IS NOT NULL;'
   sudo -u postgres psql -c 'SELECT pg_reload_conf();'
   ```

4. **Audit:** confirm no role still has an MD5 hash:
   ```sql
   SELECT rolname FROM pg_authid WHERE rolpassword LIKE 'md5%';
   -- Expect zero rows.
   ```

> [!NOTE] PostgreSQL 18
> PG18 emits a warning on `CREATE ROLE` / `ALTER ROLE` when an MD5 password is set, controlled by `md5_password_warnings` (default `on`)[^pg18-md5-deprecation]. Plan a complete MD5 removal before the future PG major that removes support.

### Recipe 8: Audit roles by auth strength

```sql
SELECT rolname,
       CASE
         WHEN rolpassword IS NULL              THEN 'no password set'
         WHEN rolpassword LIKE 'md5%'          THEN 'MD5 (deprecated)'
         WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'SCRAM-SHA-256'
         ELSE 'unknown'
       END AS hash_type,
       rolvaliduntil
  FROM pg_authid
 WHERE rolcanlogin
 ORDER BY hash_type, rolname;
```

Pair with the `pg_hba.conf` audit:

```sql
SELECT auth_method, COUNT(*) AS rule_count
  FROM pg_hba_file_rules
 WHERE error IS NULL
 GROUP BY auth_method
 ORDER BY rule_count DESC;
```

If `trust` appears in the result on a production system, treat as a P0.

### Recipe 9: LDAP search+bind

```
hostssl  app_db  all  10.0.0.0/8  ldap  ldapserver=ldap.corp.example.com ldapscheme=ldaps ldapbinddn="cn=pg_lookup,ou=Service Accounts,dc=corp,dc=example,dc=com" ldapbindpasswd="<service-account-pw>" ldapbasedn="dc=corp,dc=example,dc=com" ldapsearchattribute=uid
```

The PG server binds as `cn=pg_lookup,...`, searches for `uid=<requested-user>` under `dc=corp,dc=example,dc=com`, finds the user's DN, then re-binds as that DN with the user-supplied password.

**The role must still exist in PostgreSQL** — LDAP authenticates but doesn't grant. Pre-create roles or use a `BEFORE LOGIN` event trigger (PG17+, see [`40-event-triggers.md`](./40-event-triggers.md)) to create-on-first-login if your organization permits.

Encryption: `ldapscheme=ldaps` (port 636 by default) protects the *server-to-LDAP* hop. The *client-to-PG* hop is protected by `hostssl`. Verbatim warning: *"using ldapscheme or ldaptls only encrypts the traffic between the PostgreSQL server and the LDAP server."*[^ldap-tls]

### Recipe 10: Kerberos / Active Directory (`gss`)

```
hostssl  all  all  10.0.0.0/8  gss  include_realm=0  krb_realm=CORP.EXAMPLE.COM  map=krbmap
```

In `postgresql.conf`:

```
krb_server_keyfile = '/etc/postgresql/16/krb5.keytab'
```

In `pg_ident.conf`:

```
krbmap  /^([^@]+)@CORP\.EXAMPLE\.COM$  \1
```

This maps `alice@CORP.EXAMPLE.COM` → DB role `alice`. The `include_realm=0` option strips the realm before mapping; some shops prefer to keep `include_realm=1` and write a regex that handles it.

> [!NOTE] PostgreSQL 16
> Kerberos credential delegation: the server-side `gss_accept_delegation` GUC + the libpq `gssdelegation` parameter let an authenticated GSS connection forward its credentials to outbound FDW or replication connections[^pg16-gssdelegation]. This eliminates a class of "service account per FDW link" tickets.

### Recipe 11: Use `include_dir` for management-tool generated rules

> [!NOTE] PostgreSQL 16
> `include` / `include_if_exists` / `include_dir` directives were introduced in PG16[^pg16-include]. Pre-PG16 you must concatenate files into a single `pg_hba.conf` manually.

```
# /etc/postgresql/16/main/pg_hba.conf — manually-maintained skeleton

# Always-present admin access
local    all   postgres   peer

# Drop in tool-generated rules here:
include_dir /etc/postgresql/16/main/pg_hba.d

# Final catch-all
host     all   all   0.0.0.0/0   reject
host     all   all   ::/0        reject
```

Then in `/etc/postgresql/16/main/pg_hba.d/`:

```
10-replication.conf    # Patroni's replication rules
20-app-users.conf      # Ansible's per-app role rules
30-monitoring.conf     # cert-based monitoring agent
```

Files are sorted by C-locale name and inserted in place of the `include_dir` directive. **First-match-wins still applies across the assembled file** — keep the numeric prefixes consistent with your intended precedence.

### Recipe 12: Diagnose "no pg_hba.conf entry for host …"

When a client gets `FATAL:  no pg_hba.conf entry for host "1.2.3.4", user "alice", database "app", no encryption`:

1. **Identify what was tried.** The error already tells you the four match keys: `host = "1.2.3.4"`, `user = "alice"`, `database = "app"`, encryption status (`no encryption` or `SSL` or `GSS`).

2. **Query `pg_hba_file_rules` to see which rules could have matched:**
   ```sql
   SELECT line_number, type, database, user_name, address, auth_method
     FROM pg_hba_file_rules
    WHERE error IS NULL
      AND ('app' = ANY(database) OR 'all' = ANY(database))
      AND ('alice' = ANY(user_name) OR 'all' = ANY(user_name));
   ```

3. **Check address shape.** A `host` rule with address `10.0.0.0/8` won't match client `1.2.3.4`. Check for typos in CIDR masks (a `/24` where you meant `/8` is a 256-host-wide window instead of 16-million-hosts-wide).

4. **Check encryption requirements.** If your only matching rule is `hostssl`, and the client connected without `sslmode=require`, the rule doesn't match. The error message will say `no encryption` for non-TLS attempts.

5. **Check first-match order.** A `host all all 0.0.0.0/0 reject` line *above* your intended allow rule absorbs the match. Move the reject to the end.

### Recipe 13: Restrict by libpq `require_auth` (PG16+ client-side hardening)

> [!NOTE] PostgreSQL 16
> Verbatim release-note quote: *"Add libpq connection option require_auth to specify a list of acceptable authentication methods (Jacob Champion). This can also be used to disallow certain authentication methods."*[^pg16-require-auth]

Client-side defense against a server that has been compromised or misconfigured to request a weaker method. Connection string:

```
postgresql://app@db.internal/app?sslmode=verify-full&require_auth=scram-sha-256
```

If the server requests `md5`, `password`, `trust`, or any non-SCRAM method, libpq aborts the handshake. Combine with `sslmode=verify-full` to prevent a malicious DNS or routing change from sending the client to a different server.

**Operational pattern:** Pin every application's `require_auth=scram-sha-256` in the connection URL. Operators see immediately when a `pg_hba.conf` change drops a connection to a weaker method.

## Gotchas / Anti-patterns

1. **First-match-wins, not most-specific-wins.** The most common configuration bug. Place specific rules **before** general rules; a `host all all 0.0.0.0/0 scram-sha-256` line absorbs every TCP connection regardless of the `hostssl all dba 10.30.0.5/32 cert` line below it.

2. **`trust` on `host` or `hostssl` is a superuser-handout.** Only safe on `local` records guarded by Unix filesystem permissions. Any `trust` line in a production `pg_hba.conf` must be removed or restricted to localhost-only.

3. **`replication` pseudo-database only matches *physical* replication.** Logical replication subscriptions connect to a named database and authenticate via the regular rules[^replication-pseudo]. Forgetting this produces "no pg_hba.conf entry for logical replication."

4. **`hostnossl` and `hostssl` are *not* a partition** — `host` matches both. To force TLS, use `hostssl` for the allow rules AND a final `host` reject.

5. **Hostname matching requires forward AND reverse DNS resolution.** Verbatim: *"The host name is first looked up to verify that the connecting IP address matches one of the host name's resolved addresses, and then a reverse lookup is performed on the host name to verify that the resolved name matches the client's IP address."* DNS misconfiguration silently denies access. Prefer CIDR.

6. **PG14 removed `clientcert=1` / `clientcert=no-verify`.** Only `verify-ca` and `verify-full` are accepted on PG14+[^pg14-clientcert]. Configurations carried forward from PG13 will fail at startup with a clear error message; check release notes before upgrades.

7. **`pg_hba.conf` is read-on-SIGHUP but existing connections keep their authorization.** Use `pg_terminate_backend()` after a tightening reload if you need to force re-auth of currently-connected clients. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) Recipe 3 (soft revocation).

8. **A syntactically invalid `pg_hba.conf` causes the reload to fail silently** (the postmaster keeps the old config). Always validate via `pg_hba_file_rules` before relying on a reload (Recipe 5). On startup, a broken file prevents startup entirely.

9. **`peer` does not work over TCP/IP.** Verbatim: *"When peer is specified in pg_hba.conf, the operating system user name of the connecting client is obtained from the kernel, which is only available for local Unix-domain sockets."* Use `ident` (TCP/IP) with the same conceptual model, but ident requires an external ident server (RFC 1413) and is largely deprecated.

10. **`ident` on a `local` record silently uses `peer`.** Verbatim: *"When ident is specified for a local (non-TCP/IP) connection, peer authentication will be used instead."*[^ident-local] No error, just substitution. If you wrote `local app_db all ident` expecting an ident-server lookup, you got `peer` instead.

11. **MD5 stored hashes are server-side, independent of `pg_hba.conf` method.** A role with an MD5 hash can authenticate via a `scram-sha-256` rule? **No.** The hash and the rule must match: an `md5` rule with an MD5-stored hash works; an `md5` rule with a SCRAM-stored hash *also* works (PG falls back to SCRAM); but a `scram-sha-256` rule with an MD5-stored hash **fails**. Migrate hashes first (Recipe 7) then update rules.

12. **`scram-sha-256` over a non-TLS connection is still vulnerable to MITM** — channel-binding requires both ends to support `tls-server-end-point`. PG16+ libpq supports `channel_binding=require` to enforce it; pair with `hostssl` server-side.

13. **PG18 deprecation warnings on MD5 are `WARNING` not `ERROR`.** They are easy to miss in CI logs. Set `client_min_messages=warning` and grep for `md5_password_warnings` output. Cross-reference [^pg18-md5-deprecation].

14. **`include_dir` files are sorted in C-locale**, not in the order they're listed. Prefix every file with a numeric `NN-` to control order: `10-foo.conf` < `20-bar.conf` < `90-deny.conf`.

15. **An `include` of a missing file causes the *entire* `pg_hba.conf` reload to fail.** Use `include_if_exists` when the included file may legitimately be absent.

16. **Regex on `database`/`user` columns is anchored at *both* ends implicitly.** Verbatim: *"Regular expression patterns are prefixed with a slash."*[^pg16-regex] If you write `/^app_` you'll match `app_users` but also `app_` followed by anything; the pattern is `\Aapp_.*\z` semantically. Explicitly use `^` and `$` to be precise.

17. **`pg_ident.conf` system-username regex with a capture group + database-username regex *cannot* both be regex.** Verbatim: *"When the database-username field is a regular expression, it is not possible to use \1."*[^ident-regex] You can capture from the system side OR regex-match on the DB side, not both.

18. **PG18 OAuth requires a separately-loaded validator library.** The `oauth` method itself is in core but does *no* token validation — `oauth_validator_libraries` GUC must point to an extension that does the validation. Without it, every OAuth attempt fails.

19. **PG17 removed `db_user_namespace`.** The "per-database virtual users" feature was rarely used and is gone[^pg17-db-user-ns]. Configurations relying on `username@dbname` parsing now fail.

20. **`map=mapname` references a map that must exist in `pg_ident.conf`.** A typo silently rejects the connection. Validate with `pg_ident_file_mappings` (Recipe 6, PG15+).

21. **`samenet` matches subnets the *server* is connected to**, not the client's view. On a multi-homed server, the set can be larger than you intend. Prefer explicit CIDR when the subnet shape matters.

22. **LDAP authentication still requires the role to exist in `pg_authid`.** LDAP only proves the password; it does not auto-provision the role. Cross-reference [`46-roles-privileges.md`](./46-roles-privileges.md) for `CREATE ROLE` syntax.

23. **`hostssl` matches the *negotiated* encryption state, not the client's stated preference.** A client with `sslmode=prefer` that successfully negotiates TLS *will* match a `hostssl` rule; the same client with `sslmode=disable` matches only `host` or `hostnossl`. Use `sslmode=verify-full` client-side and `hostssl` server-side as a paired requirement.

## See Also

- [`46-roles-privileges.md`](./46-roles-privileges.md) — CREATE ROLE syntax, role attributes, predefined roles, BYPASSRLS attribute. Authentication grants connection; this file's content controls what the connection can do.
- [`47-row-level-security.md`](./47-row-level-security.md) — RLS policies. Evaluated AFTER `pg_hba.conf` accepts the connection.
- [`49-tls-ssl.md`](./49-tls-ssl.md) — TLS transport configuration. `hostssl` + cert-based auth require this configured correctly.
- [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md) — Column-level encryption (orthogonal to transport encryption).
- [`51-pgaudit.md`](./51-pgaudit.md) — Audit logging including authentication events.
- [`53-server-configuration.md`](./53-server-configuration.md) — `password_encryption`, `ssl`, `krb_server_keyfile`, etc.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_authid`, `pg_hba_file_rules`, `pg_ident_file_mappings`.
- [`73-streaming-replication.md`](./73-streaming-replication.md) — `replication` pseudo-database rules.
- [`74-logical-replication.md`](./74-logical-replication.md) — Logical replication uses regular database name, not `replication`.
- [`80-connection-pooling.md`](./80-connection-pooling.md), [`81-pgbouncer.md`](./81-pgbouncer.md) — Pool client-server authentication.
- [`82-monitoring.md`](./82-monitoring.md) — Alerting on rejected-connection log volume.
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — Managed providers expose `pg_hba.conf` through an abstraction; bare metal exposes the file directly.
- [`40-event-triggers.md`](./40-event-triggers.md) — `BEFORE LOGIN` event trigger (PG16+) for dynamic connection control and LDAP auto-provisioning patterns.

## Sources

[^first-match]: *"The first record with a matching connection type, client address, requested database, and user name is used to perform authentication. There is no 'fall-through' or 'backup': if one record is chosen and the authentication fails, subsequent records are not considered."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^reload]: *"The pg_hba.conf file is read on start-up and when the main server process receives a SIGHUP signal. If you edit the file on an active system, you will need to signal the postmaster (using pg_ctl reload, calling the SQL function pg_reload_conf(), or using kill -HUP) to make it re-read the file."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^type-local]: *"matches connection attempts using Unix-domain sockets. Without a record of this type, Unix-domain socket connections are disallowed."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^type-host]: *"matches connection attempts made using TCP/IP. host records match SSL or non-SSL connection attempts as well as GSSAPI encrypted or non-GSSAPI encrypted connection attempts."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^type-hostssl]: *"only when the connection is made with SSL encryption."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^type-hostnossl]: *"opposite behavior of hostssl."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^type-hostgssenc]: *"only when the connection is made with GSSAPI encryption."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^type-hostnogssenc]: *"opposite behavior of hostgssenc."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^replication-pseudo]: *"The value replication specifies that the record matches if a physical replication connection is requested, however, it doesn't match with logical replication connections."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^sameuser]: *"The value sameuser specifies that the record matches if the requested database has the same name as the requested user. The value samerole specifies that the requested user must be a member of the role with the same name as the requested database. (samegroup is an obsolete but still accepted spelling of samerole.)"* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^cidr]: *"standard numeric notation for the range's starting address, then a slash (/) and a CIDR mask length."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^samehost]: *"samehost to match any of the server's own IP addresses, or samenet to match any address in any subnet that the server is directly connected to."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^scram]: *"This is the most secure of the currently provided methods, but it is not supported by older client libraries."* https://www.postgresql.org/docs/16/auth-password.html
[^md5]: *"The method md5 uses a custom less secure challenge-response mechanism. ... the MD5 hash algorithm is nowadays no longer considered secure against determined attacks."* https://www.postgresql.org/docs/16/auth-password.html
[^trust]: *"When trust authentication is specified, PostgreSQL assumes that anyone who can connect to the server is authorized to access the database with whatever database user name they specify (even superuser names)."* https://www.postgresql.org/docs/16/auth-trust.html
[^trust-warning]: *"trust authentication is only suitable for TCP/IP connections if you trust every user on every machine that is allowed to connect to the server by the pg_hba.conf lines that specify trust."* https://www.postgresql.org/docs/16/auth-trust.html
[^cert-redundant]: *"It is redundant to use the clientcert option with cert authentication because cert authentication is effectively trust authentication with clientcert=verify-full."* https://www.postgresql.org/docs/16/auth-cert.html
[^ident]: *"The Identification Protocol is not intended as an authorization or access control protocol."* https://www.postgresql.org/docs/16/auth-ident.html
[^ident-local]: *"When ident is specified for a local (non-TCP/IP) connection, peer authentication will be used instead."* https://www.postgresql.org/docs/16/auth-ident.html
[^ldap]: https://www.postgresql.org/docs/16/auth-ldap.html
[^ldap-simple]: *"the server will bind to the distinguished name constructed as prefix username suffix."* https://www.postgresql.org/docs/16/auth-ldap.html
[^ldap-search]: *"the server first binds to the LDAP directory with a fixed user name and password, specified with ldapbinddn and ldapbindpasswd, and performs a search for the user trying to log in to the database."* https://www.postgresql.org/docs/16/auth-ldap.html
[^ldap-tls]: *"using ldapscheme or ldaptls only encrypts the traffic between the PostgreSQL server and the LDAP server."* https://www.postgresql.org/docs/16/auth-ldap.html
[^radius]: https://www.postgresql.org/docs/16/auth-radius.html
[^pam]: https://www.postgresql.org/docs/16/auth-pam.html
[^pam-shadow]: *"If PAM is set up to read /etc/shadow, authentication will fail because the PostgreSQL server is started by a non-root user."* https://www.postgresql.org/docs/16/auth-pam.html
[^bsd]: *"BSD Authentication is currently only available on OpenBSD."* https://www.postgresql.org/docs/16/auth-bsd.html
[^ident-map]: *"When using an external authentication system such as Ident or GSSAPI, the name of the operating system user that initiated the connection might not be the same as the database user (role) that is to be used. In this case, a user name map can be applied."* https://www.postgresql.org/docs/16/auth-username-maps.html
[^ident-regex]: *"If the system-username field starts with a slash (/), the remainder of the field is treated as a regular expression. ... If the database-username field starts with a slash (/), the remainder of the field is treated as a regular expression. When the database-username field is a regular expression, it is not possible to use \1."* https://www.postgresql.org/docs/16/auth-username-maps.html
[^pg14-password-encryption]: *"Change the default of the password_encryption server parameter to scram-sha-256 (Peter Eisentraut). Previously it was md5."* https://www.postgresql.org/docs/14/release-14.html
[^pg14-clientcert]: *"The clientcert option of pg_hba.conf only supports the values verify-ca and verify-full. The previous values 1/0/no-verify are no longer supported."* https://www.postgresql.org/docs/14/release-14.html
[^pg14-multiline]: *"Allow pg_hba.conf and pg_ident.conf records to span multiple lines (Fabien Coelho). A backslash at the end of a line allows record contents to be continued on the next line."* https://www.postgresql.org/docs/14/release-14.html
[^pg14-clientname]: *"Allow an SSL certificate's distinguished name (DN) to be matched for client certificate authentication (Andrew Dunstan, Daniel Gustafsson, Jacob Champion). The new pg_hba.conf option clientname=DN matches against the certificate DN rather than the CN."* https://www.postgresql.org/docs/14/release-14.html
[^pg15-ident-view]: *"Add system view pg_ident_file_mappings to report pg_ident.conf information (Julien Rouhaud)."* https://www.postgresql.org/docs/15/release-15.html
[^pg16-include]: *"Allow include files in pg_hba.conf and pg_ident.conf (Julien Rouhaud). These are controlled by include, include_if_exists, and include_dir. System views pg_hba_file_rules and pg_ident_file_mappings now display the file name."* https://www.postgresql.org/docs/16/release-16.html
[^pg16-include-docs]: *"The records will be inserted in place of the include directives."* https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^pg16-regex]: *"Add support for regular expression matching on database and role entries in pg_hba.conf (Bertrand Drouvot). Regular expression patterns are prefixed with a slash. Database and role names that begin with slashes need to be double-quoted if referenced in pg_hba.conf."* https://www.postgresql.org/docs/16/release-16.html
[^pg16-ident-parity]: *"Improve user-column handling of pg_ident.conf to match pg_hba.conf (Jelte Fennema). This adds support for all, role membership with +, and regular expressions with a leading slash."* https://www.postgresql.org/docs/16/release-16.html
[^pg16-require-auth]: *"Add libpq connection option require_auth to specify a list of acceptable authentication methods (Jacob Champion). This can also be used to disallow certain authentication methods."* https://www.postgresql.org/docs/16/release-16.html
[^pg16-gssdelegation]: *"Add support for Kerberos credential delegation (Stephen Frost). The server-side gss_accept_delegation server variable and the libpq gssdelegation parameter control its use."* https://www.postgresql.org/docs/16/release-16.html
[^pg17-db-user-ns]: *"Remove the feature which simulated per-database users (Nathan Bossart). Specifically, the server variable db_user_namespace was rarely used and has been removed."* https://www.postgresql.org/docs/17/release-17.html
[^pg17-sslneg]: *"New client-side connection option, sslnegotiation=direct, that performs a direct TLS handshake to avoid a round-trip negotiation (Heikki Linnakangas, Greg Stark, Matthias van de Meent)."* https://www.postgresql.org/docs/17/release-17.html
[^pg17-trust-log]: *"Add log_connections log line for trust connections (Jacob Champion)."* https://www.postgresql.org/docs/17/release-17.html
[^pg18-oauth]: *"Add support for the OAuth authentication method (Jacob Champion, Daniel Gustafsson, Thomas Munro). This adds an oauth authentication method to pg_hba.conf, libpq OAuth options, a server variable oauth_validator_libraries to load token validation libraries, and a configure flag --with-libcurl to add the required compile-time libraries."* https://www.postgresql.org/docs/18/release-18.html
[^pg18-md5-deprecation]: *"Deprecate MD5 password authentication (Nathan Bossart). Support for MD5 passwords will be removed in a future major version release. CREATE ROLE and ALTER ROLE now emit deprecation warnings when setting MD5 passwords. These warnings can be disabled by setting the md5_password_warnings parameter to off."* https://www.postgresql.org/docs/18/release-18.html
[^pg18-scram-passthrough]: *"Allow SCRAM passwords to be passed through from postgres_fdw and dblink (Matheus Alcantara, Peter Eisentraut). The scram_client_key and scram_server_key options of postgres_fdw and dblink store the SCRAM secret values."* https://www.postgresql.org/docs/18/release-18.html
